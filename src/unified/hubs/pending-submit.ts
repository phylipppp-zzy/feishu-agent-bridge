import { createHash } from 'node:crypto';
import type { UnifiedService } from '../adapter.js';
import { validateResolution, type Answer, type Operation, type WriteContext } from '../contracts.js';
import { decodeQuestionForm } from '../feishu-question-forms.js';
import { StoreError } from '../store.js';
import type { DecisionSyncStore } from './decision-store.js';
import {
  fail,
  type PendingEnvelope,
  type PendingRefRow,
  type PendingSubmitPayload,
  type PendingSubmitResult,
} from './pending-types.js';

interface PendingSubmitContext {
  rootKey: string;
  autoDispatch: boolean;
  service: UnifiedService & { dispatch?: (operationId: string) => Promise<Operation> };
  decisionStore: DecisionSyncStore | undefined;
  now: () => number;
  getRef: (refId: string) => PendingRefRow | null;
  getSourceDestination: (sessionId: string) => string | null;
  checkEnvelopeAuth: (
    entryPoint: 'hub' | 'source',
    envelope: PendingEnvelope,
    targetId: string,
    expectedSourceDestination: string | null,
  ) => Promise<void>;
  refresh: (refId: string, operation?: Operation, sessionId?: string) => Promise<PendingSubmitResult['withdrawnCards']>;
}

function checkTrackedCard(
  entryPoint: 'hub' | 'source',
  ref: PendingRefRow | null,
  cardMessageId: string | undefined,
): void {
  const expected = entryPoint === 'hub' ? ref?.hub_card_message_id : ref?.source_card_message_id;
  if (cardMessageId !== undefined && (!expected || cardMessageId !== expected)) {
    fail('invalid_request', 'cardMessageId does not match tracked pending card');
  }
}

/** The only writes here are the core and DecisionStore CAS calls. The caller schedules presentation. */
export async function executePendingSubmit(
  ctx: PendingSubmitContext,
  entryPoint: 'hub' | 'source',
  envelope: PendingEnvelope,
  payload: PendingSubmitPayload,
): Promise<PendingSubmitResult> {
  if (payload.kind === 'decision') {
    if (!ctx.decisionStore) fail('unsupported', 'decision store is not configured');
    const decision = ctx.decisionStore.getDecision(payload.decisionId);
    const refId = `decision:${decision.decisionId}`;
    const ref = ctx.getRef(refId);
    const expectedSourceDest = ref?.source_destination ?? decision.source.destination ?? null;
    await ctx.checkEnvelopeAuth(entryPoint, envelope, decision.decisionId, expectedSourceDest);
    checkTrackedCard(entryPoint, ctx.getRef(refId), payload.cardMessageId);

    let decisionResult;
    try {
      decisionResult = ctx.decisionStore.answerDecision({
        decisionId: payload.decisionId,
        expectedVersion: payload.expectedVersion,
        expectedDigest: payload.expectedDigest,
        entryPoint: entryPoint === 'hub' ? 'feishu_hub' : 'feishu_source',
        idempotencyKey: `pending:${entryPoint}:${envelope.destination}:${envelope.eventId}`,
        actor: envelope.identity,
        selectedOptionId: payload.selectedOptionId ?? null,
        freeText: payload.freeText ?? null,
        ...(payload.rawUtterance !== undefined ? { rawUtterance: payload.rawUtterance } : {}),
        sourceDestination: envelope.destination,
      });
    } catch (error) {
      await ctx.refresh(refId).catch(() => {});
      throw error;
    }
    const withdrawnCards = await ctx.refresh(refId);
    return { status: 'submitted', entryPoint, refId, decisionResult, withdrawnCards };
  }

  const { sourceSessionId, interactionId } = payload;
  const refId = `interaction:${interactionId}`;
  const ref = ctx.getRef(refId);
  const expectedSourceDest = ref?.source_destination ?? ctx.getSourceDestination(sourceSessionId);
  await ctx.checkEnvelopeAuth(entryPoint, envelope, sourceSessionId, expectedSourceDest);
  checkTrackedCard(entryPoint, ctx.getRef(refId), payload.cardMessageId);

  if (payload.kind === 'interaction' && payload.targetScope && payload.targetScope !== sourceSessionId) {
    fail('unauthorized', 'targetScope mismatch');
  }

  const session = await ctx.service.getSession(sourceSessionId);
  const interaction = await ctx.service.getInteraction(interactionId);
  if (interaction.sessionId !== sourceSessionId) fail('invalid_request', 'interaction target session mismatch');
  if (session.status === 'read_only' || session.control.input !== 'available') {
    fail('control_conflict', 'session is read-only or input control unavailable');
  }

  const opHash = createHash('sha256')
    .update(JSON.stringify([entryPoint, envelope.destination, envelope.eventId]))
    .digest('hex');
  const context: WriteContext = {
    operationId: `pending:${opHash}`,
    idempotencyKey: `pending:${opHash}`,
    targetId: sourceSessionId,
    expectedRevision: payload.revision,
    controlGeneration: session.control.generation,
    identity: envelope.identity,
  };

  let operation: Operation;
  try {
    const prior = interaction.status === 'awaiting_answer'
      ? null
      : await ctx.service.getOperation(context.operationId).catch(() => null);
    const replay = prior?.action === 'resolveInteraction' && prior.targetId === sourceSessionId;
    let answer: Answer;
    let toolInputDigest: string | null;
    if (payload.kind === 'question_form') {
      const expectedBindingId = createHash('sha256').update(ctx.rootKey).digest('hex').slice(0, 16);
      if (entryPoint === 'hub' && payload.bindingId !== expectedBindingId) {
        fail('invalid_request', 'question form bindingId mismatch');
      }
      try {
        // A repeated event may decode the same form after the CAS consumed it.
        // The core still compares the entire request digest before returning the prior receipt.
        const formInteraction = replay
          ? { ...interaction, status: 'awaiting_answer' as const, revision: payload.revision, expiresAt: null }
          : interaction;
        answer = decodeQuestionForm(
          {
            action: 'answer_form',
            bindingId: payload.bindingId,
            interactionId,
            revision: payload.revision,
            connectionGeneration: payload.connectionGeneration,
          },
          payload.fields,
          formInteraction,
          payload.bindingId,
          false,
          ctx.now(),
        ).answer;
        toolInputDigest = null;
      } catch (error) {
        fail(
          interaction.status !== 'awaiting_answer' && !replay ? 'interaction_expired' : 'invalid_request',
          error instanceof Error ? error.message : 'invalid question form',
        );
      }
    } else {
      answer = payload.answer;
      toolInputDigest = payload.toolInputDigest;
    }

    const request = {
      context,
      interactionId,
      expectedConnectionGeneration: payload.connectionGeneration,
      answer,
      toolInputDigest,
    };
    if (!replay) {
      const valid = validateResolution(request, interaction, ctx.now());
      if (!valid.ok) throw new StoreError(valid.error);
    }
    operation = await ctx.service.resolveInteraction(request);
    if (ctx.autoDispatch && ctx.service.dispatch && operation.status === 'received') {
      operation = await ctx.service.dispatch(operation.operationId);
    }
  } catch (error) {
    await ctx.refresh(refId, undefined, sourceSessionId).catch(() => {});
    throw error;
  }

  const withdrawnCards = await ctx.refresh(refId, operation, sourceSessionId);
  return { status: 'submitted', entryPoint, refId, operation, withdrawnCards };
}
