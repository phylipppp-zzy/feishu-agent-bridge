import { randomUUID } from 'node:crypto';
import type { DispatchGuard, PlatformAcknowledgement } from '../adapter.js';
import type { AgyAcpNotification, AgyServerRequest } from '../agy-transport.js';
import {
  payloadDigest,
  type Answer,
  type Interaction,
  type Message,
  type NativeSessionRef,
  type Turn,
} from '../contracts.js';
import { contractError } from '../errors.js';
import {
  ack,
  convertSchemaValue,
  extractSchemaChoices,
  extractTextFromUpdateContent,
  findEffortConfigId,
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

  resolvePendingDeliveredRequests(ctx, id, turnState.generation);

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

export function resolvePendingDeliveredRequests(
  ctx: AdapterContext,
  sessionId: string,
  generation: number,
): void {
  for (const req of ctx.requests.values()) {
    if (
      req.interaction.sessionId === sessionId &&
      req.generation === generation &&
      req.interaction.status === 'answer_pending_delivery'
    ) {
      req.interaction = {
        ...req.interaction,
        status: 'resolved',
        revision: req.interaction.revision + 1,
        nativeResult: {
          status: 'accepted',
          source: 'agy_acp',
          answer: req.answer,
        },
      };
      ctx.emitInteraction(req.interaction);
    }
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
    if (meta) meta.title = update.title;
    return;
  }

  const turnState = ctx.activeTurns.get(sessionId);
  if (!turnState || turnState.generation !== notification.generation) return;

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const toolCallId = isString(update.toolCallId) ? update.toolCallId : null;
    const status = typeof update.status === 'string' ? update.status : '';
    if (toolCallId) {
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        turnState.inProgressToolCalls.delete(toolCallId);
      } else {
        turnState.inProgressToolCalls.add(toolCallId);
      }
    }
    resolvePendingDeliveredRequests(ctx, sessionId, notification.generation);
    return;
  }

  if (kind === 'agent_message_chunk') {
    const chunkText = extractTextFromUpdateContent(update.content);
    if (!chunkText) return;

    resolvePendingDeliveredRequests(ctx, sessionId, notification.generation);

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

export function handleAcpServerRequest(
  ctx: AdapterContext,
  req: AgyServerRequest,
): void {
  if (ctx.isClosed() || req.generation !== ctx.transport.connectionGeneration) return;
  if (!isRecord(req.params)) return;

  const p = req.params;
  const sessionId = isString(p.sessionId) ? p.sessionId : null;
  if (!sessionId || !ctx.active.has(sessionId)) return;

  const turnId = ctx.activeTurns.get(sessionId)?.turnId ?? '';
  const interactionId = randomUUID();
  const base = {
    interactionId,
    sessionId,
    turnId,
    nativeRequestId: interactionId,
    connectionGeneration: req.generation,
    revision: 1,
    status: 'awaiting_answer' as const,
    expiresAt: null,
    nativeResult: null,
  };

  if (req.method === 'session/request_permission') {
    const toolCall = isRecord(p.toolCall) ? p.toolCall : {};
    const rawOptions = Array.isArray(p.options) ? p.options.filter(isRecord) : [];
    const allowOpt =
      rawOptions.find(o => o.kind === 'allow_once' || o.kind === 'allow_always') ??
      rawOptions.find(o => isString(o.optionId) && /allow/i.test(o.optionId)) ??
      rawOptions[0];
    const denyOpt =
      rawOptions.find(o => o.kind === 'reject_once' || o.kind === 'reject_always') ??
      rawOptions.find(o => isString(o.optionId) && /reject|deny/i.test(o.optionId));

    const allowOptionId = isString(allowOpt?.optionId) ? allowOpt.optionId : 'allow_once';
    const denyOptionId = isString(denyOpt?.optionId) ? denyOpt.optionId : 'reject_once';

    const toolLabel =
      (isString(toolCall.title) && toolCall.title) ||
      (isString(toolCall.kind) && toolCall.kind) ||
      (isString(toolCall.toolCallId) && toolCall.toolCallId) ||
      'agy_tool';

    const interaction: Interaction = {
      ...base,
      kind: 'approval',
      tool: toolLabel,
      action: JSON.stringify(toolCall),
      scope: 'this_request',
      toolInputDigest: payloadDigest(p),
    };

    const entry: PendingAgyRequest = {
      rpcId: req.rpcId,
      generation: req.generation,
      toolCallId: isString(toolCall.toolCallId) ? toolCall.toolCallId : null,
      interaction,
      allowOptionId,
      denyOptionId,
      propertyTypes: {},
      answer: null,
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
      rpcId: req.rpcId,
      generation: req.generation,
      toolCallId: isString(p.toolCallId) ? p.toolCallId : null,
      interaction,
      allowOptionId: 'allow_once',
      denyOptionId: 'reject_once',
      propertyTypes,
      answer: null,
    };
    ctx.requests.set(interactionId, entry);
    ctx.emitInteraction(interaction);
  }
}

export function expireAllPendingRequests(
  ctx: AdapterContext,
  generation: number | null,
): void {
  for (const entry of ctx.requests.values()) {
    if (generation !== null && entry.generation !== generation) continue;
    if (
      entry.interaction.status === 'awaiting_answer' ||
      entry.interaction.status === 'answer_pending_delivery'
    ) {
      entry.interaction = {
        ...entry.interaction,
        status: 'expired',
        revision: entry.interaction.revision + 1,
        nativeResult:
          entry.interaction.status === 'answer_pending_delivery'
            ? { status: 'unknown', source: 'connection_closed' }
            : null,
      };
      ctx.emitInteraction(entry.interaction);
    }
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

  expireAllPendingRequests(ctx, generation);
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
    result = {
      outcome: {
        optionId: answer.decision === 'allow' ? req.allowOptionId : req.denyOptionId,
      },
    };
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

  guard.assertCurrent();

  req.answer = answer;
  req.interaction = {
    ...current,
    status: 'answer_pending_delivery',
    revision: current.revision + 1,
  };
  ctx.transport.respondServerRequest(req.generation, req.rpcId, result);
  ctx.emitInteraction(req.interaction);
  return ack();
}
