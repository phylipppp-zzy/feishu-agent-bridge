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
  DEFAULT_PROMPT_IDLE_TIMEOUT_MS,
  DEFAULT_WAKEUP_IDLE_MS,
  ELICITATION_SKIP_SENTINEL,
  extractSchemaChoices,
  extractTextFromUpdateContent,
  findEffortConfigId,
  isGenericAgyTitle,
  isRecord,
  isString,
  schemaAllowsFreeText,
  type ActiveTurnState,
  type AdapterContext,
  type AgyElicitationAction,
  type Obj,
  type PendingAgyRequest,
} from './adapter-types.js';

const classifyPermissionCompat = classifyAgyPermission as (
  toolCall: Parameters<typeof classifyAgyPermission>[0],
  project: string,
  approvalPolicy?: AdapterContext['approvalPolicy'],
  sessionId?: string,
) => ReturnType<typeof classifyAgyPermission>;

function appendParagraph(text: string, paragraph: string): string {
  const separator = !text || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return text + separator + paragraph;
}

function clearWakeupTimer(turnState: ActiveTurnState): void {
  if (turnState.wakeupTimer) {
    clearTimeout(turnState.wakeupTimer);
    delete turnState.wakeupTimer;
  }
}

function isSessionLocked(ctx: AdapterContext, sessionId: string, generation: number): boolean {
  const lock = ctx.lockedSessions?.get(sessionId);
  return Boolean(lock && lock.generation === generation);
}

function matchResidualToolCall(
  ctx: AdapterContext,
  sessionId: string,
  generation: number,
  toolCallId: string,
  isTerminal: boolean,
): boolean {
  if (!ctx.turnResiduals) return false;
  const prefix = `${sessionId}:`;
  let matched = false;
  for (const [key, snap] of ctx.turnResiduals) {
    if (!key.startsWith(prefix) || snap.generation !== generation) continue;
    if (snap.inProgressToolCallIds.has(toolCallId)) {
      matched = true;
      if (isTerminal) {
        snap.inProgressToolCallIds.delete(toolCallId);
        snap.observedAt = new Date().toISOString();
      }
    }
  }
  return matched;
}

function hasPendingTurnInteraction(ctx: AdapterContext, sessionId: string, turnId: string): boolean {
  for (const entry of ctx.requests.values()) {
    if (
      entry.interaction.sessionId === sessionId &&
      entry.turnId === turnId &&
      (entry.interaction.status === 'awaiting_answer' ||
        (entry.interaction.status === 'answer_pending_delivery' && entry.submission === 'writing'))
    ) {
      return true;
    }
  }
  return false;
}

function finalizeWakeupTurn(
  ctx: AdapterContext,
  id: string,
  turnState: ActiveTurnState,
  status: 'completed' | 'failed' = 'completed',
  failureReason?: string,
): void {
  if (ctx.isClosed() || ctx.activeTurns.get(id) !== turnState) return;
  if (ctx.transport.connectionGeneration !== turnState.generation) return;
  clearWakeupTimer(turnState);
  ctx.recordTurnResidual?.(id, turnState);
  ctx.activeTurns.delete(id);

  const ref = ctx.ref(id);
  if (!turnState.assistantFinalized && turnState.assistantText) {
    turnState.assistantMessageId ??= randomUUID();
    turnState.assistantSequence ??= ctx.nextSequence();
    turnState.assistantFinalized = true;
    const finalMsg: Message = {
      messageId: turnState.assistantMessageId,
      sessionId: id,
      turnId: turnState.turnId,
      role: 'assistant',
      blocks: [{ type: 'text', text: turnState.assistantText }],
      sequence: turnState.assistantSequence,
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

  expireAllPendingRequests(ctx, turnState.generation, id, turnState.turnId);

  const endedAt = new Date().toISOString();
  if (status === 'failed' && failureReason) {
    const seq = ctx.nextSequence();
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
        occurredAt: endedAt,
        receivedAt: endedAt,
        operationId: null,
        cursor: String(seq),
        data: { reason: failureReason, wakeup: true },
      },
    });
  }

  const turn: Turn = {
    turnId: turnState.turnId,
    sessionId: id,
    status,
    inputId: null,
    startedAt: turnState.startedAt,
    endedAt,
    model: turnState.model,
    outputIds: turnState.assistantMessageId ? [turnState.assistantMessageId] : [],
  };
  ctx.putSessionTurn(id, turn);
  ctx.emit({ type: 'turn', ref, turn, connectionGeneration: turnState.generation });
}

function scheduleWakeupFinalize(ctx: AdapterContext, sessionId: string, turnState: ActiveTurnState): void {
  if (!turnState.isWakeup) return;
  clearWakeupTimer(turnState);
  const idleMs = ctx.wakeupIdleMs ?? DEFAULT_WAKEUP_IDLE_MS;
  turnState.wakeupTimer = setTimeout(() => {
    delete turnState.wakeupTimer;
    if (ctx.isClosed() || ctx.activeTurns.get(sessionId) !== turnState) return;
    if (ctx.transport.connectionGeneration !== turnState.generation) return;
    if (
      (turnState.inFlightServerRequests ?? 0) > 0 ||
      hasPendingTurnInteraction(ctx, sessionId, turnState.turnId)
    ) {
      scheduleWakeupFinalize(ctx, sessionId, turnState);
      return;
    }
    if (turnState.inProgressToolCalls.size > 0) {
      const maxIdleMs = ctx.promptIdleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS;
      const lastActivity = turnState.lastActivityAt ?? Date.now();
      if (Date.now() - lastActivity >= maxIdleMs) {
        finalizeWakeupTurn(
          ctx,
          sessionId,
          turnState,
          'failed',
          'wakeup tool call timed out without further updates',
        );
        return;
      }
      scheduleWakeupFinalize(ctx, sessionId, turnState);
      return;
    }
    finalizeWakeupTurn(ctx, sessionId, turnState, 'completed');
  }, idleMs);
}

function ensureWakeupTurn(
  ctx: AdapterContext,
  sessionId: string,
  generation: number,
): ActiveTurnState | null {
  const existing = ctx.activeTurns.get(sessionId);
  if (existing) {
    return existing.generation === generation ? existing : null;
  }
  if (isSessionLocked(ctx, sessionId, generation) || ctx.controlChanges?.has(sessionId)) {
    return null;
  }

  const now = new Date().toISOString();
  const turnId = `wakeup:${randomUUID()}`;
  const model = ctx.getSessionModel?.(sessionId) ?? null;
  const turnState: ActiveTurnState = {
    turnId,
    generation,
    model,
    startedAt: now,
    assistantMessageId: null,
    assistantSequence: null,
    assistantRevision: 0,
    assistantText: '',
    assistantFinalized: false,
    interrupted: false,
    cancelRequested: false,
    isWakeup: true,
    lastActivityAt: Date.now(),
    inFlightServerRequests: 0,
    inProgressToolCalls: new Set(),
    toolCalls: new Map(),
    fullToolCalls: new Set(),
    approvalRequestIds: new Map(),
  };
  ctx.activeTurns.set(sessionId, turnState);

  const runningTurn: Turn = {
    turnId,
    sessionId,
    status: 'running',
    inputId: null,
    startedAt: now,
    endedAt: null,
    model,
    outputIds: [],
  };
  ctx.putSessionTurn(sessionId, runningTurn);
  ctx.emit({ type: 'turn', ref: ctx.ref(sessionId), turn: runningTurn, connectionGeneration: generation });
  scheduleWakeupFinalize(ctx, sessionId, turnState);
  return turnState;
}

function safeRespondServerRejection(
  ctx: AdapterContext,
  req: AgyServerRequest,
  reason: string,
  rpcCode = -32000,
  elicitationAction: 'decline' | 'cancel' = 'decline',
): void {
  if (ctx.isClosed() || !ctx.transport.connected || req.generation !== ctx.transport.connectionGeneration) return;
  try {
    if (req.method === 'elicitation/create' && rpcCode === -32000) {
      void ctx.transport.respondServerRequest(req.generation, req.rpcId, { action: elicitationAction }).catch(() => {});
      return;
    }
    if (req.method === 'session/request_permission' && rpcCode === -32000) {
      void ctx.transport.respondServerRequest(req.generation, req.rpcId, agyPermissionOutcome(null)).catch(() => {});
      return;
    }
    ctx.transport.respondServerError(req.generation, req.rpcId, rpcCode, reason);
  } catch {}
}

export function cancelPendingTurnServerRequests(
  ctx: AdapterContext,
  sessionId: string,
  turnId: string,
  generation: number,
  source: string,
): void {
  for (const entry of ctx.requests.values()) {
    if (
      entry.interaction.sessionId !== sessionId ||
      entry.turnId !== turnId ||
      entry.generation !== generation ||
      entry.interaction.status !== 'awaiting_answer' ||
      entry.submission !== null
    ) {
      continue;
    }
    if (!ctx.isClosed() && ctx.transport.connected && generation === ctx.transport.connectionGeneration) {
      const cancelPayload =
        entry.interaction.kind === 'approval' ? agyPermissionOutcome(null) : { action: 'cancel' };
      try {
        void ctx.transport
          .respondServerRequest(entry.generation, entry.rpcId, cancelPayload)
          .catch(() => {});
      } catch {}
    }
  }
  expireAllPendingRequests(ctx, generation, sessionId, turnId, source);
}

const RESERVED_PERMISSION_OPTION_IDS = new Set(['allow_always', 'reject_always', 'allow_once', 'reject_once']);

function findUniquePermissionOption(options: unknown, kind: 'allow_always' | 'allow'): string | null {
  const raw = Array.isArray(options) ? options.filter(isRecord) : [];
  const option =
    raw.find(
      row =>
        row.kind === kind &&
        isString(row.optionId) &&
        (!RESERVED_PERMISSION_OPTION_IDS.has(row.optionId) || row.optionId === kind),
    ) ?? raw.find(row => row.kind === undefined && row.optionId === kind);
  const id = option?.optionId;
  return isString(id) && raw.filter(row => row.optionId === id).length === 1 ? id : null;
}

export function handlePromptCompleted(
  ctx: AdapterContext,
  id: string,
  turnState: ActiveTurnState,
  rawResult: unknown,
): void {
  if (ctx.isClosed() || ctx.activeTurns.get(id) !== turnState) return;
  if (ctx.transport.connectionGeneration !== turnState.generation) return;

  clearWakeupTimer(turnState);
  ctx.recordTurnResidual?.(id, turnState);
  ctx.activeTurns.delete(id);
  const ref = ctx.ref(id);
  const res = isRecord(rawResult) ? rawResult : {};
  const rawStopReason =
    typeof res.stopReason === 'string' && res.stopReason.trim().length > 0
      ? res.stopReason.trim()
      : null;

  if (!turnState.assistantFinalized) {
    const response = typeof res.response === 'string' ? res.response : '';
    const text = turnState.assistantText;
    if (response.trim()) {
      if (!text || response.startsWith(text)) turnState.assistantText = response;
      else if (turnState.needsParagraphBreak && !text.trimEnd().endsWith(response.trim())) {
        turnState.assistantText = appendParagraph(text, response);
      }
    }
    if (turnState.assistantText) {
      turnState.assistantMessageId ??= randomUUID();
      turnState.assistantSequence ??= ctx.nextSequence();
      turnState.assistantFinalized = true;
      const finalMsg: Message = {
        messageId: turnState.assistantMessageId,
        sessionId: id,
        turnId: turnState.turnId,
        role: 'assistant',
        blocks: [{ type: 'text', text: turnState.assistantText }],
        sequence: turnState.assistantSequence,
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
    rawStopReason === 'cancelled'
      ? 'interrupted'
      : rawStopReason === 'end_turn'
        ? 'completed'
        : 'failed';

  const endedAt = new Date().toISOString();
  if (rawStopReason !== 'end_turn' || turnState.cancelRequested) {
    const seq = ctx.nextSequence();
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
        type: 'turn.stop_reason',
        occurredAt: endedAt,
        receivedAt: endedAt,
        operationId: null,
        cursor: String(seq),
        data: {
          turnId: turnState.turnId,
          stopReason: rawStopReason ?? 'missing',
          cancelRequested: turnState.cancelRequested,
          terminalStatus: status,
        },
      },
    });
  }

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
  clearWakeupTimer(turnState);
  ctx.recordTurnResidual?.(id, turnState);
  ctx.activeTurns.delete(id);
  if (ctx.transport.connectionGeneration !== turnState.generation) return;
  cancelPendingTurnServerRequests(ctx, id, turnState.turnId, turnState.generation, 'prompt_failed');

  const ref = ctx.ref(id);
  const now = new Date().toISOString();
  const seq = ctx.nextSequence();
  const message =
    isRecord(error) && typeof error.message === 'string' ? error.message : 'ACP prompt failed';
  const isOutcomeUnknown = isRecord(error) && error.code === 'outcome_unknown';
  let sessionLocked = false;

  if (isOutcomeUnknown && ctx.transport.connected) {
    try {
      ctx.transport.notify('session/cancel', { sessionId: id });
    } catch {}
    if (ctx.lockedSessions) {
      ctx.lockedSessions.set(id, {
        generation: turnState.generation,
        turnId: turnState.turnId,
        reason: message,
        lockedAt: now,
      });
      sessionLocked = true;
    }
    ctx.emitSession?.(ref, id);
  }

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
      data: {
        reason: message,
        ...(isOutcomeUnknown ? { outcomeUnknown: true, sessionLocked } : {}),
        ...(turnState.cancelRequested ? { cancelRequested: true } : {}),
      },
    },
  });

  const turn: Turn = {
    turnId: turnState.turnId,
    sessionId: id,
    status: 'failed',
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
const thinkingPhaseActive = new WeakSet<ActiveTurnState>();
const ASYNC_WAKEUP_TOOLS = new Set([
  'swarm_wait',
  'swarm',
  'invoke_subagent',
  'run_workflow',
  'schedule',
  'call_mcp_tool',
]);

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

  if (kind !== 'tool_call' && kind !== 'tool_call_update' && kind !== 'agent_message_chunk') {
    const existingTurn = ctx.activeTurns.get(sessionId);
    if (existingTurn && existingTurn.generation === notification.generation) {
      existingTurn.lastActivityAt = Date.now();
      if (existingTurn.isWakeup) {
        scheduleWakeupFinalize(ctx, sessionId, existingTurn);
      }
      if (kind === 'agent_thought_chunk' && existingTurn.inProgressToolCalls.size === 0 && !existingTurn.assistantText) {
        let tracker = toolProgress.get(existingTurn);
        if (!tracker) { tracker = new ToolProgressTracker(); toolProgress.set(existingTurn, tracker); }
        const obs = tracker.observe(ref, existingTurn.generation, existingTurn.turnId, 'phase:thinking', 'running', {
          tool: 'thinking',
          summary: '🧠 正在深度思考…',
        });
        if (obs) {
          thinkingPhaseActive.add(existingTurn);
          ctx.emit(obs);
        }
      }
    }
    return;
  }

  if (
    kind === 'tool_call_update' &&
    isString(update.toolCallId)
  ) {
    const isTerminal = isString(update.status) && terminalToolStatuses.has(update.status);
    const currentTurn = ctx.activeTurns.get(sessionId);
    const canConsumeResidual =
      !currentTurn || (!currentTurn.toolCalls.has(update.toolCallId) && (isTerminal || update.status !== 'pending'));
    if (
      canConsumeResidual &&
      matchResidualToolCall(ctx, sessionId, notification.generation, update.toolCallId, isTerminal)
    ) {
      return;
    }
  }

  if (isSessionLocked(ctx, sessionId, notification.generation)) {
    return;
  }

  const turnState =
    ctx.activeTurns.get(sessionId) ?? ensureWakeupTurn(ctx, sessionId, notification.generation);
  if (!turnState || turnState.generation !== notification.generation) return;
  turnState.lastActivityAt = Date.now();
  if (turnState.isWakeup) {
    scheduleWakeupFinalize(ctx, sessionId, turnState);
  }

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    if (turnState.assistantText) turnState.needsParagraphBreak = true;
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
        if (ASYNC_WAKEUP_TOOLS.has(progress.detail.tool)) {
          turnState.awaitingAsyncWakeup = true;
        }
        let tracker = toolProgress.get(turnState);
        if (!tracker) { tracker = new ToolProgressTracker(); toolProgress.set(turnState, tracker); }
        if (thinkingPhaseActive.delete(turnState)) {
          const doneThinking = tracker.observe(ref, turnState.generation, turnState.turnId, 'phase:thinking', 'succeeded');
          if (doneThinking) ctx.emit(doneThinking);
        }
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
    if (thinkingPhaseActive.delete(turnState)) {
      const tracker = toolProgress.get(turnState);
      if (tracker) {
        const doneThinking = tracker.observe(ref, turnState.generation, turnState.turnId, 'phase:thinking', 'succeeded');
        if (doneThinking) ctx.emit(doneThinking);
      }
    }
    if (!turnState.assistantMessageId) {
      const rawMsgId = isString(update.messageId) ? update.messageId : null;
      turnState.assistantMessageId = turnState.isWakeup
        ? rawMsgId
          ? `${turnState.turnId}:${rawMsgId}`
          : randomUUID()
        : rawMsgId ?? randomUUID();
      turnState.assistantSequence = ctx.nextSequence();
    }
    const chunkId = isString(update.messageId) ? update.messageId : null;
    const newMessage = chunkId && turnState.lastChunkMessageId && chunkId !== turnState.lastChunkMessageId;
    turnState.assistantText = turnState.needsParagraphBreak || newMessage
      ? appendParagraph(turnState.assistantText, chunkText) : turnState.assistantText + chunkText;
    turnState.needsParagraphBreak = false;
    if (chunkId) turnState.lastChunkMessageId = chunkId;
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
  if (!isRecord(req.params)) {
    safeRespondServerRejection(ctx, req, 'Invalid params: expected object', -32602);
    return;
  }

  const p = req.params;
  const sessionId = isString(p.sessionId) ? p.sessionId : null;
  if (!sessionId) {
    safeRespondServerRejection(ctx, req, 'Invalid params: missing sessionId', -32602);
    return;
  }
  if (
    !ctx.active.has(sessionId) ||
    isSessionLocked(ctx, sessionId, req.generation) ||
    (ctx.controlChanges?.has(sessionId) && !ctx.activeTurns.has(sessionId))
  ) {
    safeRespondServerRejection(ctx, req, 'Session is not active, locked, or releasing', -32000);
    return;
  }

  const turn = ctx.activeTurns.get(sessionId) ?? ensureWakeupTurn(ctx, sessionId, req.generation);
  if (!turn || turn.generation !== req.generation) {
    safeRespondServerRejection(ctx, req, 'Session turn is unavailable for server request', -32000);
    return;
  }
  if (turn.cancelRequested) {
    safeRespondServerRejection(ctx, req, 'Session turn cancellation requested', -32000, 'cancel');
    return;
  }
  turn.lastActivityAt = Date.now();
  if (turn.isWakeup) {
    scheduleWakeupFinalize(ctx, sessionId, turn);
  }
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
    const allowOptionId =
      agyOnceOption(p.options, 'allow_once') ?? findUniquePermissionOption(p.options, 'allow');
    const allowAlwaysOptionId = findUniquePermissionOption(p.options, 'allow_always');
    const denyOptionId = agyOnceOption(p.options, 'reject_once');
    const cwd = ctx.knownSessions.get(sessionId)?.cwd;
    const stillCurrent = () =>
      !ctx.isClosed() &&
      ctx.transport.connected &&
      req.generation === ctx.transport.connectionGeneration &&
      ctx.active.has(sessionId) &&
      ctx.activeTurns.get(sessionId) === turn &&
      !turn.cancelRequested;
    const bridgeApprovalEnabled = ctx.approvalPolicy?.enabled !== false;
    let decision: GateDecision;
    let checking: ToolCallCheck | undefined;
    if (!bridgeApprovalEnabled) {
      const nativeReason = isString(p.reason) ? p.reason.trim() : isString(toolCall.reason) ? toolCall.reason.trim() : '';
      decision = { kind: 'ask', reason: nativeReason };
    } else if (callIds.size > 1) {
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
      turn.inFlightServerRequests = (turn.inFlightServerRequests ?? 0) + 1;
      try {
        const fingerprint = agyApprovalFingerprint(toolCall);
        const hadConflicts = hasAgyToolCallConflicts(toolCall);
        decision = await classifyPermissionCompat(toolCall, cwd, ctx.approvalPolicy, sessionId);
        if (!stillCurrent()) {
          safeRespondServerRejection(ctx, req, 'Session turn ended during permission classification', -32000);
          return;
        }
        const latest = checking?.latest ?? toolCall;
        const latestFingerprint = agyApprovalFingerprint(latest);
        const latestConflicts = hasAgyToolCallConflicts(latest);
        if (latestFingerprint !== fingerprint || latestConflicts !== hadConflicts) {
          const rechecked = await classifyPermissionCompat(latest, cwd, ctx.approvalPolicy, sessionId);
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
        turn.inFlightServerRequests = Math.max(0, (turn.inFlightServerRequests ?? 1) - 1);
        if (turn.isWakeup && ctx.activeTurns.get(sessionId) === turn) {
          scheduleWakeupFinalize(ctx, sessionId, turn);
        }
        if (toolCallId && checking && checks && --checking.count === 0) {
          checks.delete(toolCallId);
          if (!checks.size) inFlightToolChecks.delete(turn);
        }
      }
    }
    if (!stillCurrent()) {
      safeRespondServerRejection(ctx, req, 'Session turn ended during permission classification', -32000);
      return;
    }
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
    const reasonPrefix = decision.kind === 'ask' && decision.reason ? `${decision.reason}\n` : '';
    const interaction: Interaction = {
      ...base,
      kind: 'approval',
      tool: toolLabel,
      action: `${reasonPrefix}${JSON.stringify(displayedCall)}`,
      scope: 'this_request',
      toolInputDigest: payloadDigest({ ...p, toolCall: displayedCall }),
      ...(allowAlwaysOptionId
        ? {
            allowAlways: true,
            allowedScopes: ['this_request', 'session', 'allow_always'] as const,
          }
        : {}),
    } as Interaction;

    const entry: PendingAgyRequest = {
      ...pending,
      toolCallId,
      interaction,
      allowOptionId,
      allowAlwaysOptionId,
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
      await ctx.transport.respondServerRequest(req.generation, req.rpcId, { action: 'decline' }).catch(() => {});
      return;
    }

    const propertyTypes: Record<string, string> = {};
    const requiredFields: Record<string, boolean> = {};
    const explicitRequired = Array.isArray(schema.required)
      ? new Set(schema.required.filter(isString))
      : null;
    let interaction: Interaction;

    if (propEntries.length > 0) {
      const questions = propEntries.map(([id, prop]) => {
        if (typeof prop.type === 'string') propertyTypes[id] = prop.type;
        const isRequired = explicitRequired === null ? true : explicitRequired.has(id);
        requiredFields[id] = isRequired;
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
          allowFreeText: schemaAllowsFreeText(prop, choices),
          ...(isRequired ? {} : { required: false }),
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
      requiredFields,
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

  if (ctx.lockedSessions) {
    for (const [id, lock] of ctx.lockedSessions) {
      if (lock.generation === generation) {
        ctx.lockedSessions.delete(id);
      }
    }
  }

  for (const [id, turnState] of ctx.activeTurns) {
    if (turnState.generation !== generation) continue;
    clearWakeupTimer(turnState);
    ctx.recordTurnResidual?.(id, turnState);
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
      status: 'failed',
      inputId: turnState.isWakeup ? null : turnState.turnId,
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
  const elicitAction = (answer as Answer & { action?: AgyElicitationAction }).action;
  const rejectInvalidAnswer = (message: string): never => {
    if (
      guard.operationId &&
      (current.kind === 'question' || current.kind === 'question_group')
    ) {
      const declineWrite = ctx.transport.respondServerRequest(
        req.generation,
        req.rpcId,
        { action: 'decline' },
        () => guard.assertCurrent(),
      );
      void declineWrite.catch(() => {});
      req.closedSource ??= 'invalid_answer_declined';
      publishRequestClosure(ctx, req);
    }
    throw contractError('invalid_request', message);
  };

  if (
    current.kind === 'approval' &&
    answer.kind === 'approval' &&
    (answer.decision === 'allow' || answer.decision === 'deny') &&
    (answer.scope === current.scope ||
      (answer.decision === 'allow' &&
        (answer.scope === 'session' || answer.scope === 'allow_always') &&
        Boolean(req.allowAlwaysOptionId)))
  ) {
    if (answer.decision === 'allow') {
      const chosenOptionId =
        answer.scope === 'session' || answer.scope === 'allow_always'
          ? req.allowAlwaysOptionId ?? null
          : req.allowOptionId;
      if (!chosenOptionId) {
        throw contractError('unsupported', '原端未提供对应的权限选项');
      }
      result = agyPermissionOutcome(chosenOptionId);
    } else {
      result = agyPermissionOutcome(req.denyOptionId);
    }
  } else if (
    (current.kind === 'question' && answer.kind === 'question') ||
    (current.kind === 'question_group' && answer.kind === 'question_group')
  ) {
    const isQuestionSkipSentinel =
      answer.kind === 'question' &&
      Array.isArray(answer.values) &&
      answer.values.length === 1 &&
      answer.values[0] === ELICITATION_SKIP_SENTINEL;
    const isGroupSkipSentinel =
      answer.kind === 'question_group' &&
      isRecord(answer.answers) &&
      Object.values(answer.answers).length > 0 &&
      Object.values(answer.answers).every(
        vals => Array.isArray(vals) && vals.length === 1 && vals[0] === ELICITATION_SKIP_SENTINEL,
      );

    if (elicitAction === 'decline' || elicitAction === 'cancel') {
      result = { action: elicitAction };
    } else if (isQuestionSkipSentinel || isGroupSkipSentinel) {
      result = { action: 'decline' };
    } else if (
      current.kind === 'question' &&
      answer.kind === 'question' &&
      Array.isArray(answer.values) &&
      answer.values.length > 0 &&
      answer.values.every(v => typeof v === 'string' && v.trim().length > 0) &&
      (current.multiple || answer.values.length === 1) &&
      (current.allowFreeText || answer.values.every(v => current.choices.includes(v))) &&
      new Set(answer.values).size === answer.values.length
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
      isRecord(answer.answers) &&
      Object.keys(answer.answers).every(k => current.questions.some(q => q.id === k)) &&
      current.questions.every(q => {
        const vals = answer.answers[q.id];
        const isOptional = req.requiredFields?.[q.id] === false;
        if (vals === undefined || (Array.isArray(vals) && vals.length === 0)) {
          return isOptional;
        }
        return (
          Array.isArray(vals) &&
          vals.length > 0 &&
          vals.every(v => typeof v === 'string' && v.trim().length > 0) &&
          (q.multiple !== false || vals.length === 1) &&
          (q.allowFreeText || vals.every(v => q.choices.includes(v))) &&
          new Set(vals).size === vals.length
        );
      })
    ) {
      const content: Record<string, unknown> = {};
      try {
        for (const q of current.questions) {
          const vals = answer.answers[q.id];
          if (!vals || vals.length === 0) continue;
          const propType = req.propertyTypes[q.id];
          content[q.id] =
            propType === 'array' ? vals : convertSchemaValue(vals.join(', '), propType);
        }
      } catch (err) {
        const msg =
          isRecord(err) && typeof err.message === 'string'
            ? err.message
            : 'answer does not match interaction schema';
        rejectInvalidAnswer(msg);
      }
      result = {
        action: 'accept',
        content,
      };
    } else {
      rejectInvalidAnswer('answer does not match interaction schema');
    }
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
  const activeTurn = ctx.activeTurns.get(id);
  if (activeTurn && activeTurn.turnId === req.turnId) {
    activeTurn.lastActivityAt = Date.now();
    if (activeTurn.isWakeup) {
      scheduleWakeupFinalize(ctx, id, activeTurn);
    }
  }
  if (req.executed) publishToolExecution(ctx, req);
  else if (req.closedSource) {
    // Let the dispatch persist its local receipt before applying the weak close.
    setImmediate(() => publishRequestClosure(ctx, req));
  } else ctx.emitInteraction(req.interaction);
  return ack();
}
