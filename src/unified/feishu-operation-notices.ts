import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from './adapter.js';
import { compactCardField } from './card-formatters.js';
import type { Operation, Session } from './contracts.js';
import type { Authorize, FeishuPort, TrustedEnvelope } from './feishu-channel.js';
import type { ChannelCard } from './feishu-cards.js';
import { stripCardMentions } from './feishu-card-wire.js';
import { sessionModelPage } from './feishu-channel-lists.js';
import { BindingExpired, ReadAuthorizationRevoked } from './topic-title-sync.js';

export const SUPPRESSED_COMPLETED_ACTIONS = new Set([
  'submitInput', 'resolveInteraction', 'attachSession', 'createSession', 'cancelQueuedInput',
  'requestControl', 'releaseControl', 'archiveSession', 'updateSessionSettings',
]);

export function needsOperationNotice(operation: Operation): boolean {
  return operation.status === 'unknown' || (operation.status === 'failed' && !hasTerminalInputTurn(operation));
}

export function hasTerminalInputTurn(operation: Operation): boolean {
  return operation.action === 'submitInput' && operation.status === 'failed' &&
    operation.result?.kind === 'turn' && ['failed','interrupted'].includes(operation.result.status);
}

type FeedbackOrigin = {envelope: TrustedEnvelope} &
  ({action: 'archive'; archived: boolean} | {action: 'settings'} | {action: 'control'} | {action: 'steer'; text: string});

function operationFeedbackOrigin(db: DatabaseSync, operation: Operation, destination: string, scope: string): FeedbackOrigin | undefined {
  const action = operation.action === 'archiveSession' && ['accepted','completed'].includes(operation.status) ? 'archive'
    : operation.action === 'updateSessionSettings' && operation.status === 'completed' ? 'settings'
    : ['requestControl','releaseControl'].includes(operation.action) && operation.status === 'completed' ? 'control'
    : operation.action === 'submitInput' && operation.status === 'completed' && !operation.result ? 'steer' : null;
  if (!action) return;
  if (action === 'steer') {
    const row = db.prepare(`
      SELECT envelope,json_extract(action,'$.text') AS text FROM channel_steer_inbox_v1
      WHERE state='completed' AND scope=? AND json_extract(result,'$.operationId')=? AND json_extract(envelope,'$.destination')=?
    `).get(scope,operation.operationId,destination) as {envelope:string; text:string} | undefined;
    return row && {envelope:JSON.parse(row.envelope) as TrustedEnvelope, action, text:row.text};
  }
  const row = db.prepare(`
    SELECT i.envelope,json_extract(i.action,'$.archived') AS archived
    FROM channel_receipts r JOIN channel_inbox i USING (event_id) JOIN channel_inbox_scope s USING (event_id)
    WHERE r.state='completed' AND json_extract(i.action,'$.action')=?
      AND s.scope=? AND json_extract(r.result,'$.operationId')=? AND json_extract(i.envelope,'$.destination')=?
  `).get(action,scope,operation.operationId,destination) as {envelope:string; archived:number | null} | undefined;
  if (!row) return;
  const envelope = JSON.parse(row.envelope) as TrustedEnvelope;
  if (action === 'settings' || action === 'control') return envelope.cardMessageId ? {envelope,action} : undefined;
  return {envelope,action,archived:!!row.archived};
}

type FeedbackDelivery = (envelope: TrustedEnvelope, card: ChannelCard, suffix: string, guard: () => Promise<void>) => Promise<unknown>;

export async function publishOperationFeedback(
  db: DatabaseSync, service: UnifiedService, authorize: Authorize,
  [destination, sessionId, scope]: [string, string, string], operation: Operation, syncGuard: () => Promise<void>,
  panel: (session: Session) => Promise<ChannelCard>,
  reply: FeedbackDelivery,
): Promise<void> {
  const origin = operationFeedbackOrigin(db,operation,destination,scope);
  if (!origin || !await authorize(origin.envelope.identity,destination,sessionId)) return;
  const {envelope,action} = origin;
  const guard = async () => {
    await syncGuard();
    if (!await authorize(envelope.identity,destination,sessionId)) throw new ReadAuthorizationRevoked('operation feedback unauthorized');
    await syncGuard();
  };
  if (action === 'steer') {
    await reply(envelope,inputConfirmationCard('steer',origin.text),'steer-confirmed',guard);
  } else if (action === 'settings') {
    const {card} = await sessionModelPage(service,await service.getSession(sessionId));
    await reply(envelope,card,'model-confirmed',guard);
  } else if (action === 'control') {
    await reply(envelope,await panel(await service.getSession(sessionId)),'reply',guard);
  } else {
    const title = origin.archived ? '会话已归档' : '会话已恢复归档';
    const card = envelope.cardMessageId ? await panel(await service.getSession(sessionId)) : undefined;
    await reply(envelope,card ? {...card,text:`${title}。\n${card.text}`} : {title,template:'grey',text:`${title}。`,actions:[]},'archive-confirmed',guard);
  }
}

export async function suppressInputFailure(service: UnifiedService, operation: Operation): Promise<boolean> {
  if (operation.action !== 'submitInput' || operation.status !== 'failed') return false;
  if (hasTerminalInputTurn(operation) || await service.wasQueuedInputCancelled?.(operation.targetId,operation.operationId)) return true;
  if (operation.result?.kind !== 'turn') return false;
  const {turnId} = operation.result;
  const turn = await service.getTurn?.(operation.targetId,turnId);
  return turn?.status === 'failed' || turn?.status === 'interrupted' || !!await service.hasStopRequest?.(operation.targetId,turnId);
}

export function inputConfirmationCard(mode: 'queue' | 'steer', text: string): ChannelCard {
  const preview = compactCardField(stripCardMentions(text),120);
  return mode === 'steer'
    ? {title:'已发送引导',template:'blue',format:'plain',text:`已向当前运行中的轮次追加引导：${preview}`,actions:[]}
    : {title:'已加入排队',template:'blue',format:'plain',text:preview,actions:[{label:'查看排队',value:{action:'panel'}}]};
}

export async function patchOperationCard(db: DatabaseSync, port: FeishuPort, envelope: TrustedEnvelope,
  messageId: string, card: ChannelCard, deliveryId: string, guard: () => Promise<void>): Promise<boolean> {
  await guard();
  if (!db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(deliveryId).changes) return true;
  try {
    await port.update(envelope.destination,messageId,card,deliveryId,guard);
    await guard();
    db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(deliveryId);
    return true;
  } catch (error) {
    if (error instanceof BindingExpired || error instanceof ReadAuthorizationRevoked) throw error;
    db.prepare('DELETE FROM channel_deliveries WHERE delivery_id=?').run(deliveryId);
    return false;
  }
}

export function operationFromReceipt(receipt: unknown): Operation | null {
  if (!receipt || typeof receipt !== 'object') return null;
  const op = receipt as Partial<Operation>;
  return typeof op.operationId === 'string' && typeof op.action === 'string' && typeof op.targetId === 'string' ? op as Operation : null;
}

export function pendingSessionAuthorization(
  db: DatabaseSync,
  port: FeishuPort,
  authorize: Authorize,
  envelope: TrustedEnvelope,
  operationId: string,
): { destination: string; guard: () => Promise<void> } | undefined {
  const pending = db.prepare(`
    SELECT p.destination,s.scope,a.envelope FROM channel_pending p
    JOIN channel_pending_scope s USING(operation_id)
    JOIN channel_pending_actors a USING(operation_id)
    WHERE p.operation_id=? AND p.kind='session'
  `).get(operationId) as {destination:string; scope:string; envelope:string} | undefined;
  if (!pending) return;
  const { destination } = pending;
  if (destination !== envelope.destination && destination !== port.chatDestination?.(envelope.destination)) return;
  const original = JSON.parse(pending.envelope) as TrustedEnvelope;
  if (original.destination !== destination || original.identity.source !== envelope.identity.source ||
      original.identity.subject !== envelope.identity.subject) return;

  const binding = db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings WHERE destination=?');
  const current = binding.get(destination) as {session_id:string} | undefined;
  const isCurrent = (row: unknown) => pending.scope === JSON.stringify(row ?? null);
  if (!isCurrent(current)) return;
  const guard = async () => {
    if (!isCurrent(binding.get(destination)) ||
        !await authorize(envelope.identity,destination,current?.session_id ?? null) ||
        !isCurrent(binding.get(destination))) {
      throw new ReadAuthorizationRevoked('pending operation unauthorized or changed');
    }
  };
  return { destination, guard };
}
