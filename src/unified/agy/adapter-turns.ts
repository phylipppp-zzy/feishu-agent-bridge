import { agyToolProgress, ToolProgressTracker } from '../tool-progress.js';
import { randomUUID } from 'node:crypto';
import type { DispatchGuard, PlatformAcknowledgement } from '../adapter.js';
import type { AgyAcpNotification, AgyServerRequest } from '../agy-transport.js';
import {
  answerDigest,
  payloadDigest,
  type Answer,
  type Interaction,
  type Message,
  type NativeSessionRef,
  type Turn,
} from '../contracts.js';
import { contractError } from '../errors.js';
import type { GateDecision } from '../approval-policy.js';
import { agyApprovalFingerprint, agyOnceOption, agyPermissionOutcome, classifyAgyPermission, hasAgyToolCallConflicts, mergeAgyToolCall } from './adapter-permission.js';
import {
  ack,
  convertSchemaValue,
  extractSchemaChoices,
  extractTextFromUpdateContent,
  findEffortConfigId,
  isGenericAgyTitle,
  isRecord,
  isString,
  type ActiveTurnState,
  type AdapterContext,
  type Obj,
  type PendingAgyRequest,
} from './adapter-types.js';

export function handlePromptCompleted(
  ctx: AdapterContext,
  id: string,
  turnState: ActiveTurnState,
  rawResult: unknown,
): void {
  if (ctx.isClosed() || ctx.activeTurns.get(id) !== turnState) return;
  if (ctx.transport.connectionGeneration !== turnState.generation) return;

  ctx.activeTurns.delete(id);
  const ref = ctx.ref(id);
  const res = isRecord(rawResult) ? rawResult : {};
  const stopReason = typeof res.stopReason === 'string' ? res.stopReason : 'end_turn';

  if (!turnState.assistantFinalized) {
    if (turnState.assistantMessageId && turnState.assistantText) {
      turnState.assistantFinalized = true;
      const finalMsg: Message = {
        messageId: turnState.assistantMessageId,
        sessionId: id,
        turnId: turnState.turnId,
        role: 'assistant',
        blocks: [{ type: 'text', text: turnState.assistantText }],
        sequence: turnState.assistantSequence ?? ctx.nextSequence(),
        revision: ++turnState.assistantRevision,
        final: true,
        source: 'agy',
      };
      ctx.upsertLiveMessage(id, finalMsg);
      ctx.emit({
        type: 'message',
        ref,
        message: finalMsg,
        connectionGeneration: turnState.generation,
      });
    } else if (typeof res.response === 'string' && res.response.trim()) {
      const messageId = turnState.assistantMessageId ?? randomUUID();
      const seq = turnState.assistantSequence ?? ctx.nextSequence();
      turnState.assistantMessageId = messageId;
      turnState.assistantSequence = seq;
      turnState.assistantText = res.response;
      turnState.assistantFinalized = true;
      const finalMsg: Message = {
        messageId,
        sessionId: id,
        turnId: turnState.turnId,
        role: 'assistant',
        blocks: [{ type: 'text', text: res.response }],
        sequence: seq,
        revision: ++turnState.assistantRevision,
        final: true,
        source: 'agy',
      };
      ctx.upsertLiveMessage(id, finalMsg);
      ctx.emit({
        type: 'message',
        ref,
        message: finalMsg,
        connectionGeneration: turnState.generation,
      });
    }
  }

  expireAllPendingRequests(ctx, turnState.generation, id, turnState.turnId);

  const status: Turn['status'] =
    turnState.interrupted || stopReason === 'cancelled'
      ? 'interrupted'
      : stopReason === 'error'
        ? 'failed'
        : 'completed';
  const endedAt = new Date().toISOString();
  const turn: Turn = {
    turnId: turnState.turnId,
    sessionId: id,
    status,
    inputId: turnState.turnId,
    startedAt: turnState.startedAt,
    endedAt,
    model: turnState.model,
    outputIds: turnState.assistantMessageId ? [turnState.assistantMessageId] : [],
  };
  ctx.putSessionTurn(id, turn);
  ctx.emit({ type: 'turn', ref, turn, connectionGeneration: turnState.generation });
}

export function handlePromptFailed(
  ctx: AdapterContext,
  id: string,
  turnState: ActiveTurnState,
  error: unknown,
): void {
  if (ctx.isClosed() || ctx.activeTurns.get(id) !== turnState) return;
  ctx.activeTurns.delete(id);
  if (ctx.transport.connectionGeneration !== turnState.generation) return;
  expireAllPendingRequests(ctx, turnState.generation, id, turnState.turnId);

  const ref = ctx.ref(id);
  const now = new Date().toISOString();
  const seq = ctx.nextSequence();
  const message =
    isRecord(error) && typeof error.message === 'string' ? error.message : 'ACP prompt failed';

  ctx.emit({
    type: 'event',
    ref,
    connectionGeneration: turnState.generation,
    event: {
      schemaVersion: 1,
      eventId: randomUUID(),
      sessionId: id,
      objectId: turnState.turnId,
      objectRevision: 0,
      sequence: seq,
      type: 'adapter.stream_failed',
      occurredAt: now,
      receivedAt: now,
      operationId: null,
      cursor: String(seq),
      data: { reason: message },
    },
  });

  const turn: Turn = {
    turnId: turnState.turnId,
    sessionId: id,
    status: turnState.interrupted ? 'interrupted' : 'failed',
    inputId: turnState.turnId,
    startedAt: turnState.startedAt,
    endedAt: now,
    model: turnState.model,
    outputIds: turnState.assistantMessageId ? [turnState.assistantMessageId] : [],
  };
  ctx.putSessionTurn(id, turn);
  ctx.emit({ type: 'turn', ref, turn, connectionGeneration: turnState.generation });
}

function observeToolExecution(
  ctx: AdapterContext,
  sessionId: string,
  turn: ActiveTurnState,
  toolCallId: string,
): void {
  const interactionId = turn.approvalRequestIds.get(toolCallId);
  const req = interactionId ? ctx.requests.get(interactionId) : undefined;
  if (!req || req.interaction.sessionId !== sessionId || req.turnId !== turn.turnId ||
      req.generation !== turn.generation || req.toolCallId !== toolCallId ||
      req.interaction.status !== 'answer_pending_delivery' || req.closedSource ||
      req.answer?.kind !== 'approval' || req.answer.decision !== 'allow') return;
  req.executed = true;
  if (req.submission === 'submitted') publishToolExecution(ctx, req);
}

function publishToolExecution(ctx: AdapterContext, req: PendingAgyRequest): void {
  req.interaction = {
    ...req.interaction,
    status: 'resolved',
    revision: req.interaction.revision + 1,
    nativeResult: { status: 'accepted', source: 'agy_tool_execution', answer: req.answer },
  };
  const { interactionId, nativeRequestId } = req.interaction;
  ctx.emitInteraction(req.interaction, req.operationId && req.answerDigest ? {
    operationId: req.operationId,
    interactionId,
    nativeRequestId,
    connectionGeneration: req.generation,
    answerDigest: req.answerDigest,
  } : undefined);
}

function publishRequestClosure(ctx: AdapterContext, req: PendingAgyRequest): void {
  if (req.interaction.status !== 'awaiting_answer' && req.interaction.status !== 'answer_pending_delivery') return;
  req.interaction = {
    ...req.interaction,
    status: 'expired',
    revision: req.interaction.revision + 1,
    nativeResult: req.answer ? { status: 'unknown', source: req.closedSource ?? 'agy_request_closed' } : null,
  };
  releaseRequestToolCall(ctx, req);
  ctx.emitInteraction(req.interaction);
}

const maxFullToolCalls = 128;
const toolSummaryFields = ['toolCallId', 'title', 'kind', 'name', 'toolName', 'status'];
const terminalToolStatuses = new Set(['completed', 'failed', 'cancelled']);
type ToolCallCheck = { latest: Obj; count: number };
// Full inputs otherwise disappear when a terminal update arrives during classification.
const inFlightToolChecks = new WeakMap<ActiveTurnState, Map<string, ToolCallCheck>>();

function compactToolCall(turn: ActiveTurnState, toolCallId: string, call: Obj): void {
  const summary: Obj = {};
  for (const field of toolSummaryFields) {
    if (typeof call[field] === 'string') summary[field] = call[field];
  }
  turn.toolCalls.set(toolCallId, summary);
  turn.fullToolCalls.delete(toolCallId);
}

const toolProgress = new WeakMap<ActiveTurnState, ToolProgressTracker>();

function releaseToolCall(ctx: AdapterContext, sessionId: string, turn: ActiveTurnState, toolCallId: string): void {
  if (!turn.fullToolCalls.has(toolCallId)) return;
  for (const req of ctx.requests.values()) {
    if (req.toolCallId === toolCallId && req.interaction.sessionId === sessionId && req.turnId === turn.turnId &&
        req.generation === turn.generation && (req.interaction.status === 'awaiting_answer' ||
          req.interaction.status === 'answer_pending_delivery' && req.submission === 'writing')) return;
  }
  compactToolCall(turn, toolCallId, turn.toolCalls.get(toolCallId)!);
}

function releaseRequestToolCall(ctx: AdapterContext, req: PendingAgyRequest): void {
  const { sessionId } = req.interaction;
  const turn = ctx.activeTurns.get(sessionId);
  if (req.toolCallId && turn?.turnId === req.turnId && turn.generation === req.generation) {
    releaseToolCall(ctx, sessionId, turn, req.toolCallId);
  }
}

export function handleAcpNotification(
  ctx: AdapterContext,
  notification: AgyAcpNotification,
): void {
  if (ctx.isClosed() || notification.generation !== ctx.transport.connectionGeneration) return;
  if (notification.method !== 'session/update' || !isRecord(notification.params)) return;

  const params = notification.params;
  const sessionId = isString(params.sessionId) ? params.sessionId : null;
  if (!sessionId || !ctx.active.has(sessionId)) return;

  const update = isRecord(params.update) ? params.update : null;
  if (!update) return;

  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  const ref = ctx.ref(sessionId);

  if (kind === 'config_option_update' && Array.isArray(update.configOptions)) {
    const thoughtOpt = findEffortConfigId(update.configOptions);
    const meta = ctx.knownSessions.get(sessionId);
    if (meta && thoughtOpt) meta.effortConfigId = thoughtOpt;
    return;
  }

  if (kind === 'session_info_update' && isString(update.title)) {
    const meta = ctx.knownSessions.get(sessionId);
    if (!meta) return;
    const summary = ctx.catalog.get(sessionId);
    const generic = isGenericAgyTitle(update.title, sessionId);
    if (generic && (!isGenericAgyTitle(meta.title, sessionId) || !isGenericAgyTitle(summary?.title, sessionId))) return;
    meta.title = update.title;
    meta.nativeTitle = !generic;
    ctx.emit({type: 'session', ref, session: ctx.buildSession(sessionId, summary ?? null, meta)});
    return;
  }

  const turnState = ctx.activeTurns.get(sessionId);
  if (!turnState || turnState.generation !== notification.generation) return;

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const toolCallId = isString(update.toolCallId) ? update.toolCallId : null;
    if (toolCallId) {
      const previous = turnState.toolCalls.get(toolCallId);
      const checking = inFlightToolChecks.get(turnState)?.get(toolCallId);
      const call = mergeAgyToolCall(checking?.latest ?? previous, update);
      if (checking) checking.latest = call;
      if (previous && !turnState.fullToolCalls.has(toolCallId)) compactToolCall(turnState, toolCallId, call);
      else {
        turnState.toolCalls.set(toolCallId, call);
        turnState.fullToolCalls.add(toolCallId);
      }
      const terminal = isString(call.status) && terminalToolStatuses.has(call.status);
      if (terminal) {
        turnState.inProgressToolCalls.delete(toolCallId);
      } else {
        turnState.inProgressToolCalls.add(toolCallId);
      }
      if ((update.status === 'in_progress' || update.status === 'completed') &&
          previous?.status !== 'in_progress' && previous?.status !== 'completed') {
        observeToolExecution(ctx, sessionId, turnState, toolCallId);
      }
      const progress = agyToolProgress(call, ctx.knownSessions.get(sessionId)?.cwd, kind === 'tool_call');
      if (progress) {
        let tracker = toolProgress.get(turnState);
        if (!tracker) { tracker = new ToolProgressTracker(); toolProgress.set(turnState, tracker); }
        const observation = tracker.observe(ref, turnState.generation, turnState.turnId, toolCallId, progress.phase, progress.detail);
        if (observation) ctx.emit(observation);
      }
      if (terminal) releaseToolCall(ctx, sessionId, turnState, toolCallId);
      if (turnState.fullToolCalls.size > maxFullToolCalls) {
        for (const id of turnState.fullToolCalls) {
          releaseToolCall(ctx, sessionId, turnState, id);
          if (turnState.fullToolCalls.size <= maxFullToolCalls) break;
        }
        // An existing interaction already has the request details if every full entry is in use.
        if (turnState.fullToolCalls.size > maxFullToolCalls) compactToolCall(turnState, toolCallId, call);
      }
    }
    return;
  }

  if (kind === 'agent_message_chunk') {
    const chunkText = extractTextFromUpdateContent(update.content);
    if (!chunkText) return;

    if (turnState.assistantFinalized) return;
    if (!turnState.assistantMessageId) {
      turnState.assistantMessageId = isString(update.messageId) ? update.messageId : randomUUID();
      turnState.assistantSequence = ctx.nextSequence();
    }
    turnState.assistantText += chunkText;
    const msg: Message = {
      messageId: turnState.assistantMessageId,
      sessionId,
      turnId: turnState.turnId,
      role: 'assistant',
      blocks: [{ type: 'text', text: turnState.assistantText }],
      sequence: turnState.assistantSequence!,
      revision: ++turnState.assistantRevision,
      final: false,
      source: 'agy',
    };
    ctx.upsertLiveMessage(sessionId, msg);
    ctx.emit({
      type: 'message',
      ref,
      message: msg,
      connectionGeneration: notification.generation,
    });
  }
}

export async function handleAcpServerRequest(
  ctx: AdapterContext,
  req: AgyServerRequest,
): Promise<void> {
  if (ctx.isClosed() || req.generation !== ctx.transport.connectionGeneration) return;
  if (!isRecord(req.params)) return;

  const p = req.params;
  const sessionId = isString(p.sessionId) ? p.sessionId : null;
  if (!sessionId || !ctx.active.has(sessionId)) return;

  const turn = ctx.activeTurns.get(sessionId);
  if (!turn || turn.generation !== req.generation) return;
  const { turnId } = turn;
  const interactionId = randomUUID();
  const base = {
    interactionId,
    sessionId,
    turnId,
    nativeRequestId: JSON.stringify(req.rpcId),
    connectionGeneration: req.generation,
    revision: 1,
    status: 'awaiting_answer' as const,
    expiresAt: null,
    nativeResult: null,
  };
  const pending = {
    rpcId: req.rpcId,
    generation: req.generation,
    turnId,
    answer: null,
    operationId: null,
    answerDigest: null,
    submission: null,
    executed: false,
    closedSource: null,
  };

  if (req.method === 'session/request_permission') {
    const requestedCall = isRecord(p.toolCall) ? p.toolCall : {};
    const callIds = new Set([requestedCall.toolCallId, p.toolCallId].filter(isString));
    const toolCallId = callIds.size === 1 ? [...callIds][0]! : null;
    let checks = inFlightToolChecks.get(turn);
    const previous = toolCallId ? checks?.get(toolCallId)?.latest ?? turn.toolCalls.get(toolCallId) : undefined;
    let toolCall = mergeAgyToolCall(previous, requestedCall);
    const compacted = toolCallId && previous && !turn.fullToolCalls.has(toolCallId);
    if (toolCallId) turn.approvalRequestIds.set(toolCallId, turn.approvalRequestIds.has(toolCallId) ? null : interactionId);
    const allowOptionId = agyOnceOption(p.options, 'allow_once');
    const denyOptionId = agyOnceOption(p.options, 'reject_once');
    const cwd = ctx.knownSessions.get(sessionId)?.cwd;
    const stillCurrent = () => !ctx.isClosed() && ctx.transport.connected &&
      req.generation === ctx.transport.connectionGeneration && ctx.active.has(sessionId) && ctx.activeTurns.get(sessionId) === turn;
    let decision: GateDecision;
    let checking: ToolCallCheck | undefined;
    if (callIds.size > 1) {
      decision = { kind: 'ask', reason: '原端请求中的工具调用标识不一致。' };
    } else if (!cwd) {
      decision = { kind: 'ask', reason: '缺少已验证的工作目录。' };
    } else {
      if (toolCallId) {
        if (!checks) {
          checks = new Map();
          inFlightToolChecks.set(turn, checks);
        }
        checking = checks.get(toolCallId) ?? { latest: toolCall, count: 0 };
        checking.latest = toolCall;
        checking.count++;
        checks.set(toolCallId, checking);
      }
      try {
        const fingerprint = agyApprovalFingerprint(toolCall);
        const hadConflicts = hasAgyToolCallConflicts(toolCall);
        decision = await classifyAgyPermission(toolCall, cwd, ctx.approvalPolicy);
        if (!stillCurrent()) return;
        const latest = checking?.latest ?? toolCall;
        const latestFingerprint = agyApprovalFingerprint(latest);
        const latestConflicts = hasAgyToolCallConflicts(latest);
        if (latestFingerprint !== fingerprint || latestConflicts !== hadConflicts) {
          const rechecked = await classifyAgyPermission(latest, cwd, ctx.approvalPolicy);
          toolCall = checking?.latest ?? latest;
          if (decision.kind !== 'deny') {
            decision = rechecked;
            if (decision.kind !== 'deny' && (hasAgyToolCallConflicts(toolCall) ||
                agyApprovalFingerprint(toolCall) !== latestFingerprint)) {
              decision = { kind: 'ask', reason: '工具调用参数在审批检查期间发生变化，请确认最新参数。' };
            }
          }
        } else {
          toolCall = latest;
        }
      } finally {
        if (toolCallId && checking && checks && --checking.count === 0) {
          checks.delete(toolCallId);
          if (!checks.size) inFlightToolChecks.delete(turn);
        }
      }
    }
    if (!stillCurrent()) return;
    if (decision.kind === 'allow_once' && compacted) {
      decision = { kind: 'ask', reason: '缺少工具调用的完整参数记录。' };
    }
    if (decision.kind === 'deny' || (decision.kind === 'allow_once' && allowOptionId)) {
      try {
        await ctx.transport.respondServerRequest(
          req.generation, req.rpcId, agyPermissionOutcome(decision.kind === 'deny' ? denyOptionId : allowOptionId),
        );
      } finally {
        if (toolCallId) releaseToolCall(ctx, sessionId, turn, toolCallId);
      }
      return;
    }
    if (!allowOptionId) {
      ctx.transport.respondServerError(req.generation, req.rpcId, -32000, '原端未提供仅允许本次的权限选项');
      if (toolCallId) releaseToolCall(ctx, sessionId, turn, toolCallId);
      return;
    }

    const toolLabel =
      (isString(toolCall.title) && toolCall.title) ||
      (isString(toolCall.kind) && toolCall.kind) ||
      (isString(toolCall.toolCallId) && toolCall.toolCallId) ||
      'agy_tool';

    const displayedCall = Object.fromEntries(Object.entries(toolCall));
    const interaction: Interaction = {
      ...base,
      kind: 'approval',
      tool: toolLabel,
      action: `${decision.kind === 'ask' ? `${decision.reason}\n` : ''}${JSON.stringify(displayedCall)}`,
      scope: 'this_request',
      toolInputDigest: payloadDigest({ ...p, toolCall: displayedCall }),
    };

    const entry: PendingAgyRequest = {
      ...pending,
      toolCallId,
      interaction,
      allowOptionId,
      denyOptionId,
      propertyTypes: {},
    };
    ctx.requests.set(interactionId, entry);
    ctx.emitInteraction(interaction);
    return;
  }

  if (req.method === 'elicitation/create') {
    const promptMessage = isString(p.message) ? p.message : '请提供输入';
    const schema = isRecord(p.requestedSchema) ? p.requestedSchema : {};
    const props = isRecord(schema.properties) ? schema.properties : {};
    const propEntries = Object.entries(props).filter(([, val]) => isRecord(val)) as Array<[string, Obj]>;

    const hasSecretField =
      p.mode === 'url' ||
      propEntries.some(([, prop]) => prop.format === 'password' || prop.writeOnly === true);
    if (hasSecretField) {
      const now = new Date().toISOString();
      const sequence = ctx.nextSequence();
      ctx.emit({
        type: 'event',
        ref: ctx.ref(sessionId),
        connectionGeneration: req.generation,
        event: {
          schemaVersion: 1,
          eventId: randomUUID(),
          sessionId,
          objectId: isString(p.toolCallId) ? p.toolCallId : interactionId,
          objectRevision: 0,
          sequence,
          type: 'interaction.unsupported',
          occurredAt: now,
          receivedAt: now,
          operationId: null,
          cursor: String(sequence),
          data: { reason: 'URL or secret elicitation is unsupported' },
        },
      });
      return;
    }

    const propertyTypes: Record<string, string> = {};
    let interaction: Interaction;

    if (propEntries.length > 0) {
      const questions = propEntries.map(([id, prop]) => {
        if (typeof prop.type === 'string') propertyTypes[id] = prop.type;
        const choices = extractSchemaChoices(prop);
        const prompt =
          (isString(prop.description) && prop.description) ||
          (isString(prop.title) && prop.title) ||
          (propEntries.length === 1 ? `${promptMessage} (${id})` : id);
        return {
          id,
          prompt,
          choices,
          multiple: prop.type === 'array' ? true : false,
          allowFreeText: choices.length === 0 || prop.type === 'string' || !prop.type,
        };
      });
      interaction = {
        ...base,
        kind: 'question_group',
        toolInputDigest: null,
        questions,
      };
    } else {
      interaction = {
        ...base,
        kind: 'question',
        toolInputDigest: null,
        prompt: promptMessage,
        choices: [],
        multiple: false,
        allowFreeText: true,
      };
    }

    const entry: PendingAgyRequest = {
      ...pending,
      toolCallId: isString(p.toolCallId) ? p.toolCallId : null,
      interaction,
      allowOptionId: null,
      denyOptionId: null,
      propertyTypes,
    };
    ctx.requests.set(interactionId, entry);
    ctx.emitInteraction(interaction);
  }
}

export function expireAllPendingRequests(
  ctx: AdapterContext,
  generation: number | null,
  sessionId?: string,
  turnId?: string,
  source = 'agy_request_closed',
): void {
  for (const entry of ctx.requests.values()) {
    if (generation !== null && entry.generation !== generation) continue;
    if (sessionId !== undefined && entry.interaction.sessionId !== sessionId) continue;
    if (turnId !== undefined && entry.turnId !== turnId) continue;
    entry.closedSource ??= source;
    if (entry.submission !== 'writing') publishRequestClosure(ctx, entry);
  }
}

export function handleTransportDisconnect(
  ctx: AdapterContext,
  generation: number,
  reason: string,
): void {
  if (ctx.isClosed()) return;

  const previouslyActive = [...ctx.active];
  ctx.active.clear();
  for (const id of previouslyActive) {
    ctx.controlEpoch.set(id, (ctx.controlEpoch.get(id) ?? 0) + 1);
    const summary = ctx.catalog.get(id);
    const meta = ctx.knownSessions.get(id);
    if (summary || meta) {
      ctx.emit({
        type: 'session',
        ref: ctx.ref(id),
        session: ctx.buildSession(id, summary, meta),
      });
    }
  }

  for (const [id, turnState] of ctx.activeTurns) {
    if (turnState.generation !== generation) continue;
    ctx.activeTurns.delete(id);
    const now = new Date().toISOString();
    const seq = ctx.nextSequence();
    const ref = ctx.ref(id);
    ctx.emit({
      type: 'event',
      ref,
      connectionGeneration: generation,
      event: {
        schemaVersion: 1,
        eventId: randomUUID(),
        sessionId: id,
        objectId: turnState.turnId,
        objectRevision: 0,
        sequence: seq,
        type: 'adapter.stream_failed',
        occurredAt: now,
        receivedAt: now,
        operationId: null,
        cursor: String(seq),
        data: { reason },
      },
    });
    const turn: Turn = {
      turnId: turnState.turnId,
      sessionId: id,
      status: turnState.interrupted ? 'interrupted' : 'failed',
      inputId: turnState.turnId,
      startedAt: turnState.startedAt,
      endedAt: now,
      model: turnState.model,
      outputIds: turnState.assistantMessageId ? [turnState.assistantMessageId] : [],
    };
    ctx.putSessionTurn(id, turn);
    ctx.emit({ type: 'turn', ref, turn, connectionGeneration: generation });
  }

  expireAllPendingRequests(ctx, generation, undefined, undefined, 'connection_closed');
}

export async function respondToInteraction(
  ctx: AdapterContext,
  ref: NativeSessionRef,
  interaction: Interaction,
  answer: Answer,
  guard: DispatchGuard,
): Promise<PlatformAcknowledgement> {
  const id = ctx.check(ref);
  const req = ctx.requests.get(interaction.interactionId);
  const current = req?.interaction;

  if (
    !req ||
    !current ||
    current.sessionId !== id ||
    ctx.activeTurns.get(id)?.turnId !== req.turnId ||
    req.generation !== ctx.transport.connectionGeneration ||
    req.generation !== guard.expectedConnectionGeneration ||
    current.status !== 'awaiting_answer'
  ) {
    throw contractError('interaction_expired');
  }
  if (!ctx.active.has(id) || !ctx.transport.connected) {
    throw contractError('control_conflict', 'session is not connected');
  }
  if (
    interaction.nativeRequestId !== current.nativeRequestId ||
    interaction.connectionGeneration !== current.connectionGeneration ||
    interaction.kind !== current.kind ||
    interaction.toolInputDigest !== current.toolInputDigest ||
    interaction.status !== 'awaiting_answer'
  ) {
    throw contractError('stale_revision');
  }

  let result: unknown;
  if (
    current.kind === 'approval' &&
    answer.kind === 'approval' &&
    answer.scope === current.scope &&
    (answer.decision === 'allow' || answer.decision === 'deny')
  ) {
    if (answer.decision === 'allow' && !req.allowOptionId) {
      throw contractError('unsupported', '原端未提供仅允许本次的权限选项');
    }
    result = agyPermissionOutcome(answer.decision === 'allow' ? req.allowOptionId : req.denyOptionId);
  } else if (
    current.kind === 'question' &&
    answer.kind === 'question' &&
    Array.isArray(answer.values) &&
    answer.values.length > 0 &&
    answer.values.every(v => typeof v === 'string' && v.trim().length > 0)
  ) {
    result = {
      action: 'accept',
      content: {
        answer: answer.values.join(', '),
      },
    };
  } else if (
    current.kind === 'question_group' &&
    answer.kind === 'question_group' &&
    Object.keys(answer.answers).length === current.questions.length &&
    current.questions.every(q => {
      const vals = answer.answers[q.id];
      return (
        Array.isArray(vals) &&
        vals.length > 0 &&
        vals.every(v => typeof v === 'string' && v.trim().length > 0) &&
        new Set(vals).size === vals.length
      );
    })
  ) {
    const content: Record<string, unknown> = {};
    for (const q of current.questions) {
      const vals = answer.answers[q.id]!;
      const propType = req.propertyTypes[q.id];
      content[q.id] =
        propType === 'array' ? vals : convertSchemaValue(vals.join(', '), propType);
    }
    result = {
      action: 'accept',
      content,
    };
  } else {
    throw contractError('invalid_request', 'answer does not match interaction schema');
  }

  const digest = answerDigest(answer);
  const submission = ctx.transport.respondServerRequest(req.generation, req.rpcId, result, () => guard.assertCurrent());
  req.submission = 'writing';
  req.answer = answer;
  req.operationId = guard.operationId ?? null;
  req.answerDigest = digest;
  req.interaction = {
    ...current,
    status: 'answer_pending_delivery',
    revision: current.revision + 1,
  };
  try {
    await submission;
  } catch (error) {
    req.closedSource ??= 'agy_response_write_failed';
    publishRequestClosure(ctx, req);
    throw error;
  }
  req.submission = 'submitted';
  releaseRequestToolCall(ctx, req);
  if (req.executed) publishToolExecution(ctx, req);
  else if (req.closedSource) {
    // Let the dispatch persist its local receipt before applying the weak close.
    setImmediate(() => publishRequestClosure(ctx, req));
  } else ctx.emitInteraction(req.interaction);
  return ack();
}
