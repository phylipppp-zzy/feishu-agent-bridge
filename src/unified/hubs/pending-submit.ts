import { createHash } from 'node:crypto';
import type { UnifiedService } from '../adapter.js';
import {
  validateResolution,
  type Answer,
  type Operation,
  type WriteContext,
} from '../contracts.js';
import { decodeQuestionForm } from '../feishu-question-forms.js';
import { StoreError } from '../store.js';
import type { DecisionSyncStore } from './decision-store.js';
import {
  fail,
  type PendingEnvelope,
  type PendingHubRoot,
  type PendingRefRow,
  type PendingSubmitPayload,
  type PendingSubmitResult,
} from './pending-types.js';

export async function describePendingWithdrawalReason(
  ref: PendingRefRow,
  service: UnifiedService,
  decisionStore: DecisionSyncStore | undefined,
): Promise<string> {
  if (ref.interaction_id) {
    try {
      const interaction = await service.getInteraction(ref.interaction_id);
      if (interaction.status === 'resolved') return '已由权威端处理并撤下';
      if (interaction.status === 'answer_pending_delivery') return '已提交答复，等待确认回执';
      if (interaction.status === 'expired') return '该请求已过期或连接已重建';
      if (interaction.status === 'cancelled') return '该请求已取消';
      return '原会话控制状态已变化，卡片已失效';
    } catch {
      return '该请求已不可用';
    }
  }
  if (ref.decision_id && decisionStore) {
    try {
      const decision = decisionStore.getDecision(ref.decision_id);
      if (decision.status === 'answered') return '决定已登记，卡片已失效';
      if (decision.status === 'expired') return '决定已过期';
      if (decision.status === 'cancelled') return '决定已取消';
    } catch {
      return '决定已不可用';
    }
  }
  return '待处理项已失效';
}

export interface PendingSubmitContext {
  destination: string;
  rootKey: string;
  autoDispatch: boolean;
  service: UnifiedService & { dispatch?: (operationId: string) => Promise<Operation> };
  decisionStore: DecisionSyncStore | undefined;
  now: () => number;
  getRoot: () => PendingHubRoot | null;
  getRef: (refId: string) => PendingRefRow | null;
  getSourceDestination: (sessionId: string) => string | null;
  checkEnvelopeAuth: (
    entryPoint: 'hub' | 'source',
    envelope: PendingEnvelope,
    targetId: string,
    expectedSourceDestination: string | null,
  ) => Promise<void>;
  describeWithdrawalReason: (ref: PendingRefRow) => Promise<string>;
  withdrawRefCards: (
    ref: PendingRefRow,
    reason: string,
    hubDest: string,
  ) => Promise<{ sourceUpdated: boolean; hubUpdated: boolean }>;
  refreshSummaryCard: (hubDest: string) => Promise<void>;
}

/**
 * Single-authority submission from either Source Topic or Pending Hub.
 * Atomically invokes UnifiedService.resolveInteraction or DecisionSyncStore.answerDecision,
 * and withdraws both source and Hub cards upon completion or conflict.
 */
export async function executePendingSubmit(
  ctx: PendingSubmitContext,
  entryPoint: 'hub' | 'source',
  envelope: PendingEnvelope,
  payload: PendingSubmitPayload,
): Promise<PendingSubmitResult> {
  const hubDest = ctx.getRoot()?.topicDestination ?? ctx.destination;

  if (payload.kind === 'decision') {
    if (!ctx.decisionStore) fail('unsupported', 'decision store is not configured');
    const decision = ctx.decisionStore.getDecision(payload.decisionId);
    const refId = `decision:${decision.decisionId}`;
    const ref = ctx.getRef(refId);
    const expectedSourceDest = ref?.source_destination ?? decision.source.destination ?? null;

    await ctx.checkEnvelopeAuth(entryPoint, envelope, decision.decisionId, expectedSourceDest);
    if (payload.cardMessageId) {
      const expectedCardId = entryPoint === 'hub' ? ref?.hub_card_message_id : ref?.source_card_message_id;
      if (!expectedCardId || payload.cardMessageId !== expectedCardId) {
        fail('invalid_request', 'cardMessageId does not match tracked pending card');
      }
    }

    try {
      const decisionResult = ctx.decisionStore.answerDecision({
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

      const currentRef = ctx.getRef(refId);
      const withdrawnCards = currentRef
        ? await ctx.withdrawRefCards(currentRef, '决定已登记，卡片已撤下', hubDest)
        : { sourceUpdated: false, hubUpdated: false };
      await ctx.refreshSummaryCard(hubDest);

      return {
        status: 'submitted',
        entryPoint,
        refId,
        decisionResult,
        withdrawnCards,
      };
    } catch (error) {
      const currentRef = ctx.getRef(refId);
      if (currentRef && currentRef.card_active === 1) {
        const latest = ctx.decisionStore.getDecision(payload.decisionId);
        if (latest.status !== 'pending') {
          await ctx.withdrawRefCards(currentRef, '决定已由其他入口处理，卡片已撤下', hubDest);
          await ctx.refreshSummaryCard(hubDest);
        }
      }
      throw error;
    }
  }

  // Interaction path ('interaction' or 'question_form') — strictly delegates to UnifiedService single authority
  const sourceSessionId = payload.sourceSessionId;
  const interactionId = payload.interactionId;
  const refId = `interaction:${interactionId}`;
  const ref = ctx.getRef(refId);
  const expectedSourceDest = ref?.source_destination ?? ctx.getSourceDestination(sourceSessionId);

  await ctx.checkEnvelopeAuth(entryPoint, envelope, sourceSessionId, expectedSourceDest);

  if (payload.cardMessageId) {
    const expectedCardId = entryPoint === 'hub' ? ref?.hub_card_message_id : ref?.source_card_message_id;
    if (!expectedCardId || payload.cardMessageId !== expectedCardId) {
      fail('invalid_request', 'cardMessageId does not match tracked pending card');
    }
  }

  if (payload.kind === 'interaction' && payload.targetScope && payload.targetScope !== sourceSessionId) {
    fail('unauthorized', 'targetScope mismatch');
  }

  const session = await ctx.service.getSession(sourceSessionId);
  const interaction = await ctx.service.getInteraction(interactionId);
  const snapshot = await ctx.service.getSnapshot(sourceSessionId);

  if (interaction.sessionId !== sourceSessionId) {
    fail('invalid_request', 'interaction target session mismatch');
  }
  if (session.status === 'read_only' || session.control.input !== 'available') {
    fail('control_conflict', 'session is read-only or input control unavailable');
  }
  if (
    snapshot.value.connectionGeneration !== undefined &&
    interaction.connectionGeneration !== snapshot.value.connectionGeneration
  ) {
    if (ref && ref.card_active === 1) {
      await ctx.withdrawRefCards(ref, '连接代数已变化，旧请求卡片已撤下', hubDest);
      await ctx.refreshSummaryCard(hubDest);
    }
    fail('interaction_expired', 'interaction connection generation is stale');
  }

  let resolvedAnswer: Answer;
  let toolInputDigest: string | null;
  if (payload.kind === 'question_form') {
    const expectedBindingId = createHash('sha256').update(ctx.rootKey).digest('hex').slice(0, 16);
    if (entryPoint === 'hub' && payload.bindingId !== expectedBindingId) {
      fail('invalid_request', 'question form bindingId mismatch');
    }
    try {
      const decoded = decodeQuestionForm(
        {
          action: 'answer_form',
          bindingId: payload.bindingId,
          interactionId: payload.interactionId,
          revision: payload.revision,
          connectionGeneration: payload.connectionGeneration,
        },
        payload.fields,
        interaction,
        payload.bindingId,
        false,
        ctx.now(),
      );
      resolvedAnswer = decoded.answer;
      toolInputDigest = null;
    } catch (error) {
      fail(
        interaction.status !== 'awaiting_answer' ? 'interaction_expired' : 'invalid_request',
        error instanceof Error ? error.message : 'invalid question form',
      );
    }
  } else {
    resolvedAnswer = payload.answer;
    toolInputDigest = payload.toolInputDigest;
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

  const resolveReq = {
    context,
    interactionId,
    expectedConnectionGeneration: payload.connectionGeneration,
    answer: resolvedAnswer,
    toolInputDigest,
  };

  const preValid = validateResolution(resolveReq, interaction, ctx.now());
  if (!preValid.ok) {
    if (preValid.error.code === 'interaction_expired' && ref && ref.card_active === 1) {
      await ctx.withdrawRefCards(ref, '请求已失效，卡片已撤下', hubDest);
      await ctx.refreshSummaryCard(hubDest);
    }
    throw new StoreError(preValid.error);
  }

  let operation: Operation;
  try {
    operation = await ctx.service.resolveInteraction(resolveReq);
    if (ctx.autoDispatch && ctx.service.dispatch && operation.status === 'received') {
      operation = await ctx.service.dispatch(operation.operationId);
    }
  } catch (error) {
    const latest = await ctx.service.getInteraction(interactionId).catch(() => null);
    if (latest && latest.status !== 'awaiting_answer' && ref && ref.card_active === 1) {
      await ctx.withdrawRefCards(ref, await ctx.describeWithdrawalReason(ref), hubDest);
      await ctx.refreshSummaryCard(hubDest);
    }
    throw error;
  }

  const currentRef = ctx.getRef(refId);
  const withdrawnCards = currentRef
    ? await ctx.withdrawRefCards(
        currentRef,
        `已通过${entryPoint === 'hub' ? '待处理汇总' : '源话题'}提交答复，两处卡片已撤下`,
        hubDest,
      )
    : { sourceUpdated: false, hubUpdated: false };
  await ctx.refreshSummaryCard(hubDest);

  return {
    status: 'submitted',
    entryPoint,
    refId,
    operation,
    withdrawnCards,
  };
}
