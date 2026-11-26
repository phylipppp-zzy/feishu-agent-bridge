import { createHash } from 'node:crypto';
import { payloadDigest } from './contracts.js';
import { contractError } from './errors.js';
import type { FeishuPort, TrustedEnvelope } from './feishu-channel.js';
import { verifiedMessageAppLink } from './feishu-message-link.js';
import { pendingHubDisabledCard } from './help-cards.js';
import { isCliNoticeRefId } from './hubs/pending-types.js';
import type { PendingHub, PendingSubmitPayload } from './pending-hub.js';
import type { RuntimeInteractive } from './runtime-interactive.js';
import type { RuntimeTrustedAction } from './runtime.js';
import type { UnifiedCore } from './service.js';

type PendingRoutes = {
  hub: PendingHub | undefined;
  mainDestination: string | undefined;
  core: Pick<UnifiedCore,'getInteraction'>;
  port: FeishuPort;
  sendPort: Pick<FeishuPort,'send'>;
  interactive: Pick<RuntimeInteractive,'notifyOperation'|'notifyInteraction'|'notifyDecision'>;
  wake: () => void;
  authorize: (envelope: TrustedEnvelope) => boolean;
};

async function openPending(routes: PendingRoutes, envelope: TrustedEnvelope): Promise<unknown> {
  const {hub,port,sendPort,authorize} = routes;
  const guard = async () => { if (!authorize(envelope)) throw contractError('unauthorized','pending navigation unauthorized'); };
  await guard();
  const deliveryId = `pending-open:${payloadDigest([envelope.eventId,envelope.destination])}`;
  if (!hub) {
    await sendPort.send(envelope.destination,pendingHubDisabledCard(),deliveryId,guard);
    return {status:'guidance'};
  }

  const current = hub.getRoot();
  if (envelope.destination === routes.mainDestination || (current?.state === 'active' && envelope.destination === current.topicDestination)) {
    return hub.renderPage(envelope);
  }

  // The originating topic stays the reply destination. Resolve the link from the verified Hub route.
  let root = current?.state === 'active' ? current : null;
  if (!root) {
    try { root = await hub.ensureRoot(); }
    catch (error) {
      const code = (error as {detail?:{code?:string}} | null)?.detail?.code;
      if (code !== 'outcome_unknown' && code !== 'temporarily_unavailable') throw error;
    }
  }
  const {total} = await hub.listPending();
  let url: string | null = null;
  if (root?.topicDestination && root.topicDestination !== root.chatDestination && port.topicLinkForSession) {
    const link = await port.topicLinkForSession(root.chatDestination,root.hubKey);
    const current = hub.getRoot();
    if (current?.topicDestination === root.topicDestination && current.rootMessageId === root.rootMessageId) {
      url = verifiedMessageAppLink({message_app_link:link});
    }
  }
  const text = `当前有 ${total} 项待处理。${url ? '' : '可在主群发送 /pending 查看汇总。'}`;
  await sendPort.send(envelope.destination,{title:'待处理汇总',text,actions:url ? [{label:'打开待处理汇总话题',url,value:{}}] : []},deliveryId,guard);
  return {total};
}

const hubBindingId = createHash('sha256').update('pending-hub:singleton').digest('hex').slice(0,16);

export function handlePendingAction(routes: PendingRoutes, envelope: TrustedEnvelope, action: RuntimeTrustedAction): Promise<unknown> | null {
  if (action.action === 'pending_open') return openPending(routes,envelope);
  const {hub,interactive} = routes;
  if (!hub) return null;
  const root = hub.getRoot();
  const inHubTopic = !!root?.topicDestination && root.topicDestination !== root.chatDestination && envelope.destination === root.topicDestination;
  const meta = action as {entry?:unknown;bindingId?:unknown;sourceSessionId?:unknown};
  const entry = meta.entry === 'source' ? 'source' : (meta.entry === 'hub' || meta.entry === 'pending_hub') ? 'hub' : undefined;
  const message = envelope.cardMessageId ? {cardMessageId:envelope.cardMessageId} : {};
  const submit = (payload: PendingSubmitPayload) => hub.submitAnswer(entry ?? 'hub',envelope,{...payload,...message},{
    notifyOperation: id => interactive.notifyOperation(id),
    notifyInteraction: (sessionId,id) => interactive.notifyInteraction(sessionId,id),
    notifyDecision: id => interactive.notifyDecision(id),
    notifySummary: routes.wake,
  });
  if (action.action === 'decision_answer') return submit({
    kind:'decision',decisionId:action.decisionId,expectedVersion:action.expectedVersion,expectedDigest:action.expectedDigest,
    ...(action.selectedOptionId !== undefined ? {selectedOptionId:action.selectedOptionId} : {}),
    ...(action.freeText !== undefined ? {freeText:action.freeText} : {}),
    ...(action.rawUtterance !== undefined ? {rawUtterance:action.rawUtterance} : {}),
  });
  if ((action.action === 'answer' || action.action === 'answer_form') && isCliNoticeRefId(action.interactionId)) {
    return hub.submitAnswer(entry ?? 'hub', envelope, { kind: 'cli_notice', refId: action.interactionId });
  }
  if ((action.action === 'answer' || action.action === 'answer_form') && (entry || meta.bindingId === hubBindingId || inHubTopic)) {
    return (async () => {
      const sourceSessionId = typeof meta.sourceSessionId === 'string' && meta.sourceSessionId.trim()
        ? meta.sourceSessionId
        : (await routes.core.getInteraction(action.interactionId)).sessionId;
      const base = {sourceSessionId,interactionId:action.interactionId,revision:action.revision,connectionGeneration:action.connectionGeneration};
      return submit(action.action === 'answer_form'
        ? {kind:'question_form',...base,bindingId:typeof meta.bindingId === 'string' ? meta.bindingId : '',fields:action.fields}
        : {kind:'interaction',...base,answer:action.answer,toolInputDigest:action.toolInputDigest});
    })();
  }
  if (action.action === 'pending_page' && (inHubTopic || envelope.destination === routes.mainDestination)) {
    return hub.renderPage(envelope,{
      ...(action.cursor !== undefined ? {cursor:action.cursor} : {}),
      ...(action.category !== undefined ? {category:action.category} : {}),
      ...(action.provider !== undefined ? {provider:action.provider} : {}),
    });
  }
  if (inHubTopic && action.action === 'input') return hub.handleHubText(envelope,action.text);
  return null;
}
