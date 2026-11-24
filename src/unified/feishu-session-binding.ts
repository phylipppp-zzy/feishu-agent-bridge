import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from './adapter.js';
import type { Operation, Session, WriteContext } from './contracts.js';
import { operationCard, sessionCard, type ChannelCard } from './feishu-cards.js';
import type { Authorize, AuthorizeBindingAdmin, ChannelAction, FeishuPort, TrustedEnvelope } from './feishu-channel.js';
import { needsOperationNotice, operationFromReceipt, pendingSessionAuthorization } from './feishu-operation-notices.js';
import { BindingExpired, ReadAuthorizationRevoked, recordNewTopicRootTitle, topicRootCard } from './topic-title-sync.js';

type AccessMode = 'read_only' | 'interactive';
type Guard = () => Promise<void>;
type Reply = (card: ChannelCard, suffix?: string) => Promise<string | void>;
type BindingRow = { session_id: string; owner_source: string; owner_subject: string; access_mode: AccessMode };
type PendingRow = {
  operation_id: string;
  destination: string;
  session_id: string | null;
  kind: 'session' | 'artifact';
  mode: AccessMode | 'new' | 'queue' | 'steer' | null;
  state: string;
  envelope: string;
  scope: string;
};
type Delivery = {
  delivery_id: string;
  operation_id: string;
  destination: string;
  session_id: string;
  scope: string;
  envelope: string;
  card: string;
  state: string;
};
type ChannelAccess = {
  scope(destination: string): string;
  binding(destination: string): string | null;
  accessMode(destination: string): AccessMode;
  context(envelope: TrustedEnvelope, targetId: string, revision: number, generation: number): WriteContext;
  checkBinding(destination: string, sessionId: string, scope: string): Promise<void>;
  deliver(destination: string, card: ChannelCard, id: string, guard?: Guard): Promise<string | void>;
  stamp(destination: string, card: ChannelCard): ChannelCard;
  handle(envelope: TrustedEnvelope, action: ChannelAction): Promise<unknown>;
};

const pendingQuery = `
  SELECT p.*,a.envelope,s.scope FROM channel_pending p
  JOIN channel_pending_actors a USING(operation_id)
  JOIN channel_pending_scope s USING(operation_id)
`;

function isExpiredCard(error: unknown): boolean {
  const failure = error as { platformCode?: unknown; code?: unknown; message?: unknown; response?: { data?: { code?: unknown; msg?: unknown } } } | null;
  const code = String(failure?.platformCode ?? failure?.response?.data?.code ?? failure?.code);
  return code === '230031' || code === '230011'
    || [error, failure?.message, failure?.response?.data?.msg].some(value => typeof value === 'string'
      && /\b(message (?:recalled|deleted|expired)|invalid message_id)\b/i.test(value));
}

export class FeishuSessionBinding {
  private readonly advancing = new Map<string, Promise<Operation | null>>();
  private readonly writing = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly service: UnifiedService,
    private readonly port: FeishuPort,
    private readonly authorize: Authorize,
    private readonly authorizeBindingAdmin: AuthorizeBindingAdmin | undefined,
    private readonly channel: ChannelAccess,
  ) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS channel_pending_destination ON channel_pending(destination,state);
      CREATE TABLE IF NOT EXISTS channel_binding_deliveries (
        delivery_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, destination TEXT NOT NULL,
        session_id TEXT NOT NULL, scope TEXT NOT NULL, envelope TEXT NOT NULL, card TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS channel_binding_delivery_operation ON channel_binding_deliveries(operation_id,state);
      CREATE TABLE IF NOT EXISTS channel_binding_attach_cards (
        operation_id TEXT NOT NULL, message_id TEXT NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY(operation_id,message_id)
      );
    `);
  }

  permitsCompletedUpgrade(e: TrustedEnvelope, action: ChannelAction, old: { bindingId?: string; scope?: string }): boolean {
    if (!e.cardMessageId || (action.action !== 'upgrade' && !(action.action === 'bind' && action.mode === 'interactive'))) return false;
    const binding = this.ownerRow(e.destination);
    if (binding?.access_mode !== 'interactive' || (action.action === 'bind' && binding.session_id !== action.sessionId)) return false;
    return !!this.db.prepare(`${pendingQuery}
      JOIN channel_binding_deliveries d USING(operation_id)
      WHERE p.destination=? AND p.session_id=? AND p.kind='session' AND p.mode='interactive'
        AND p.state='completed' AND d.destination=p.destination AND d.scope=?
        AND json_extract(a.envelope,'$.identity.source')=? AND json_extract(a.envelope,'$.identity.subject')=?
        AND (s.scope=? OR json_extract(s.scope,'$.binding_id')=?)
    `).get(e.destination,binding.session_id,this.channel.scope(e.destination),e.identity.source,e.identity.subject,old.scope ?? null,old.bindingId ?? null);
  }

  private ownerRow(destination: string): BindingRow | undefined {
    return this.db.prepare('SELECT session_id,owner_source,owner_subject,access_mode FROM channel_bindings WHERE destination=?')
      .get(destination) as BindingRow | undefined;
  }

  private async checkOwner(e: TrustedEnvelope, destination: string, current?: BindingRow): Promise<void> {
    if (!current || (current.owner_source === e.identity.source && current.owner_subject === e.identity.subject)) return;
    if (!await this.authorizeBindingAdmin?.(e.identity, destination, current.session_id)) throw new ReadAuthorizationRevoked('binding management unauthorized');
  }

  recordPending(operationId: string, e: TrustedEnvelope, sessionId: string | null, kind: PendingRow['kind'], mode: PendingRow['mode']): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT OR IGNORE INTO channel_pending VALUES (?,?,?,?,?,'pending')").run(operationId,e.destination,sessionId,kind,mode);
      this.db.prepare('INSERT OR IGNORE INTO channel_pending_scope VALUES (?,?)').run(operationId,this.channel.scope(e.destination));
      const envelope = JSON.stringify(e);
      this.db.prepare('INSERT OR IGNORE INTO channel_pending_actors VALUES (?,?)').run(operationId,envelope);
      const row = this.db.prepare('SELECT envelope FROM channel_pending_actors WHERE operation_id=?').get(operationId);
      if (row?.envelope !== envelope) throw new Error('pending actor conflict');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private pending(operationId: string): PendingRow | undefined {
    return this.db.prepare(`${pendingQuery} WHERE p.operation_id=?`).get(operationId) as PendingRow | undefined;
  }

  private setBinding(destination: string, sessionId: string, e: TrustedEnvelope, mode: AccessMode): void {
    this.db.prepare(`
      INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode)
      VALUES (?,?,?,?,?,1,?)
      ON CONFLICT(destination) DO UPDATE SET session_id=excluded.session_id,binding_id=excluded.binding_id,
        owner_source=excluded.owner_source,owner_subject=excluded.owner_subject,revision=channel_bindings.revision+1,
        access_mode=excluded.access_mode
    `).run(destination,sessionId,randomUUID(),e.identity.source,e.identity.subject,mode);
    this.db.prepare('DELETE FROM channel_cursors WHERE destination=?').run(destination);
  }

  async bindReadOnly(e: TrustedEnvelope, sessionId: string, scope: string, reply: Reply): Promise<unknown> {
    const session = await this.service.getSession(sessionId);
    if (session.sessionId !== sessionId) throw new Error('binding session mismatch');
    const guard = async () => {
      if (scope !== this.channel.scope(e.destination) ||
          !await this.authorize(e.identity,e.destination,sessionId) ||
          scope !== this.channel.scope(e.destination)) throw new ReadAuthorizationRevoked('binding changed or unauthorized');
    };
    await guard();
    const destination = await this.topic(e.destination,session,`${e.eventId}:topic`,guard);
    if (!await this.authorize(e.identity,destination,sessionId)) throw new ReadAuthorizationRevoked('unauthorized');
    const existing = this.ownerRow(destination);
    const targetScope = this.channel.scope(destination);
    await this.checkOwner(e,destination,existing);
    await guard();

    let autoExistingInteractive = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (targetScope !== this.channel.scope(destination)) throw new BindingExpired('binding changed');
      const auto = this.db.prepare('SELECT 1 FROM channel_auto_baselines WHERE event_id=? AND session_id=? AND destination IS NULL').get(e.eventId,sessionId);
      if (auto && existing && existing.session_id !== sessionId) throw new BindingExpired('automatic binding superseded');
      if (!existing || (!auto && existing.session_id !== sessionId)) {
        if (this.port.isTopicDestination?.(destination)) this.port.reassignTopic?.(destination,sessionId);
        this.setBinding(destination,sessionId,e,'read_only');
      }
      autoExistingInteractive = !!auto && existing?.access_mode === 'interactive';
      if (autoExistingInteractive) this.db.prepare('DELETE FROM channel_auto_baselines WHERE event_id=?').run(e.eventId);
      else this.db.prepare('UPDATE channel_auto_baselines SET destination=?,binding_scope=? WHERE event_id=? AND session_id=? AND destination IS NULL')
        .run(destination,this.channel.scope(destination),e.eventId,sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const boundScope = this.channel.scope(destination);
    const boundGuard = () => this.channel.checkBinding(destination,sessionId,boundScope);
    if (destination !== e.destination && !existing) {
      await recordNewTopicRootTitle(this.db,this.port,destination,boundScope,session,`${e.eventId}:topic`);
      await boundGuard();
    }
    const accessMode = this.channel.accessMode(destination);
    if (!autoExistingInteractive) {
      await this.channel.deliver(destination,sessionCard(session,accessMode),`${e.eventId}:reply`,boundGuard);
      if (destination !== e.destination) {
        const url = await this.port.topicLinkForSession?.(e.destination,sessionId);
        await reply(url
          ? { title:'会话已打开', text:'在话题中查看和继续操作。', actions:[{label:'打开话题',value:{},url}] }
          : { title:'话题链接暂不可用', text:'会话话题已建立，请稍后重试打开。', actions:[] }, 'open-topic');
      }
    }
    return { sessionId, accessMode, destination };
  }

  private topic(destination: string, session: Session, deliveryId: string, guard: Guard): string | Promise<string> {
    return this.port.createTopic && !this.port.isTopicDestination?.(destination)
      ? this.port.createTopic(destination,session.sessionId,topicRootCard(session),deliveryId,guard) : destination;
  }

  async beginInteractiveAttach(e: TrustedEnvelope, sessionId: string, scope: string, guard: Guard, reply: Reply): Promise<unknown> {
    const { destination } = e;
    const existing = this.ownerRow(destination);
    if (existing && existing.session_id !== sessionId) {
      await this.showOutcome(e,{title:'无法接入',text:'此话题已绑定其他会话，请在目标话题操作。',actions:[]},'attach-mismatch',guard,reply);
      return { status:'rejected', reason:'session_mismatch' };
    }
    const session = await this.service.getSession(sessionId);
    if (session.sessionId !== sessionId) throw new Error('binding session mismatch');
    await guard();
    if (!await this.authorize(e.identity,destination,sessionId)) throw new ReadAuthorizationRevoked('unauthorized');
    await this.checkOwner(e,destination,existing);
    await guard();

    if (existing?.access_mode === 'interactive' && session.control.input === 'available' && session.status !== 'read_only') {
      if (e.cardMessageId) {
        const opId = this.channel.context(e,`new:${destination}`,0,0).operationId;
        this.rememberDelivery(opId,destination,session,scope,e,sessionCard(session,'interactive'));
        await this.flushDeliveries(opId);
      }
      return { status:'completed', sessionId, accessMode:'interactive', destination };
    }

    const matching = this.db.prepare(`${pendingQuery} WHERE p.destination=? AND p.session_id=? AND p.state='pending'
      AND p.kind='session' AND p.mode='interactive' AND s.scope=?
      AND json_extract(a.envelope,'$.identity.source')=? AND json_extract(a.envelope,'$.identity.subject')=? ORDER BY p.rowid
    `).all(destination,sessionId,scope,e.identity.source,e.identity.subject) as PendingRow[];
    for (const prior of matching) {
      const op = await this.readOperation(prior.operation_id);
      await guard();
      if (op && op.status !== 'failed') {
        if (e.cardMessageId && e.cardMessageId !== (JSON.parse(prior.envelope) as TrustedEnvelope).cardMessageId) {
          this.db.prepare('INSERT OR IGNORE INTO channel_binding_attach_cards VALUES (?,?,?)')
            .run(prior.operation_id,e.cardMessageId,JSON.stringify(e));
        }
        return op;
      }
    }

    const context = this.channel.context(e,`new:${destination}`,0,0);
    this.recordPending(context.operationId,e,sessionId,'session','interactive');
    const n = session.native;
    let op: Operation;
    try {
      op = await this.service.attachSession({
        context,
        payload:{provider:n.provider,hostId:n.hostId,serviceId:n.serviceId,nativeSessionId:n.nativeSessionId,mode:'interactive'},
      });
    } catch (error) {
      const fault = error as {detail?: Operation['error']; code?: string} | null;
      const code = fault?.detail?.code ?? fault?.code ?? 'temporarily_unavailable';
      const reason = code === 'unauthorized' ? '当前账号没有接入权限。'
        : code === 'outcome_unknown' ? '原端接入结果未确认，请先核对会话状态。'
        : '原端暂时无法完成接入，请刷新会话状态。';
      await this.showOutcome(e,{title:'接入未完成',text:reason,actions:[]},'attach-error',guard,reply);
      this.completePending(context.operationId);
      return {status:'rejected',reason:code};
    }
    if (needsOperationNotice(op)) await this.showOutcome(e,operationCard(op),'reply',guard,reply);
    return op;
  }

  private async showOutcome(e: TrustedEnvelope, card: ChannelCard, suffix: string, guard: Guard, reply: Reply): Promise<void> {
    if (e.cardMessageId && (!this.port.createTopic || this.port.isTopicDestination?.(e.destination))) {
      await this.patch(e.destination,e.cardMessageId,card,`${e.eventId}:${suffix}:update`,guard);
    } else {
      await reply(card,suffix);
    }
  }

  private async confirmDelivery(deliveryId: string, guard: Guard): Promise<boolean> {
    const state = this.db.prepare('SELECT state FROM channel_deliveries WHERE delivery_id=?').get(deliveryId);
    if (state?.state === 'sent') return true;
    if (state?.state !== 'unknown' || await this.port.lookupDelivery?.(deliveryId) !== 'sent') return false;
    await guard();
    this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(deliveryId);
    return true;
  }

  private async patch(destination: string, messageId: string, card: ChannelCard, deliveryId: string, guard: Guard): Promise<boolean> {
    await guard();
    const state = this.db.prepare('SELECT state FROM channel_deliveries WHERE delivery_id=?').get(deliveryId)?.state;
    if (state === 'sent') return true;
    if (state === 'expired') return false;
    if (state === 'unknown') {
      const lookup = await this.port.lookupDelivery?.(deliveryId);
      if (lookup === 'sent') {
        await guard();
        this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(deliveryId);
        return true;
      }
      if (lookup === 'unknown') return false;
    }
    this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?,'unknown')").run(deliveryId);
    await guard();
    await this.port.update(destination,messageId,this.channel.stamp(destination,card),deliveryId,guard);
    await guard();
    this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(deliveryId);
    return true;
  }

  private async readOperation(id: string): Promise<Operation | undefined> {
    try {
      return await this.service.getOperation(id);
    } catch (error) {
      if (error && typeof error === 'object' && 'detail' in error && (error as {detail?:{code?:string}}).detail?.code === 'invalid_request') return;
      throw error;
    }
  }

  async finish(e: TrustedEnvelope, operationId: string, bound: string | null, guard: Guard, reply: Reply): Promise<unknown> {
    const pending = this.pending(operationId);
    if (!pending || (pending.destination !== e.destination &&
        !(pending.kind === 'session' && this.port.chatDestination?.(e.destination) === pending.destination))) throw new Error('pending operation not found');
    const original = JSON.parse(pending.envelope) as TrustedEnvelope;
    if (pending.kind === 'session' && (original.identity.source !== e.identity.source || original.identity.subject !== e.identity.subject)) {
      throw new ReadAuthorizationRevoked('pending operation unauthorized');
    }
    const automatic = e.eventId === `auto-finish:${operationId}`;
    if (pending.state === 'completed') {
      if (!automatic) await this.flushDeliveries(operationId);
      return {status:'completed'};
    }
    if (pending.scope !== this.channel.scope(pending.destination)) return {status:'expired',reason:'binding_changed'};
    const op = await this.service.getOperation(operationId);
    await guard();
    if (op.status !== 'completed' || !op.result) return op;
    if (pending.kind === 'session' && op.result.kind === 'session') return this.finishSession(original,pending,op,op.result.sessionId,guard,!automatic);
    if (pending.kind !== 'artifact' || op.result.kind !== 'artifact' || !pending.session_id || !pending.mode) throw new Error('operation result mismatch');
    if (this.channel.accessMode(e.destination) !== 'interactive') throw new Error('read-only binding');
    if (pending.session_id !== bound || op.targetId !== bound || op.action !== 'stageInputArtifact') throw new Error('binding changed');
    const session = await this.service.getSession(bound);
    await guard();
    const id = `attachment-submit:${operationId}`;
    const context = {...this.channel.context(e,bound,session.revision,session.control.generation),operationId:id,idempotencyKey:id};
    const result = await this.service.submitInput({context,mode:pending.mode as 'new'|'queue'|'steer',blocks:[{type:'artifact',artifactId:op.result.artifactId,contentVersion:op.result.contentVersion}]});
    this.completePending(operationId);
    if (needsOperationNotice(result) || result.status === 'queued') {
      const card = operationCard(result);
      if (result.status === 'queued') card.actions.push({label:'查看排队',value:{action:'panel'}});
      await reply(card);
    }
    return result;
  }

  private completePending(operationId: string): void {
    this.db.prepare("UPDATE channel_pending SET state='completed' WHERE operation_id=?").run(operationId);
  }

  private async finishSession(original: TrustedEnvelope, pending: PendingRow, op: Operation, sessionId: string, finishGuard: Guard, deliverNow: boolean): Promise<unknown> {
    const source = pending.destination;
    if (!['createSession','attachSession'].includes(op.action) || op.targetId !== `new:${source}` ||
        (pending.session_id && pending.session_id !== sessionId)) throw new Error('operation result mismatch');
    const guard = async () => {
      await finishGuard();
      if (pending.scope !== this.channel.scope(source) || !await this.authorize(original.identity,source,sessionId) ||
          pending.scope !== this.channel.scope(source)) throw new ReadAuthorizationRevoked('pending operation unauthorized or changed');
    };
    await guard();
    const session = await this.service.getSession(sessionId);
    if (session.sessionId !== sessionId) throw new Error('binding session mismatch');
    await guard();
    const sourceSession = this.channel.binding(source);
    const mode = pending.mode === 'interactive' ? 'interactive' : 'read_only';
    if (mode === 'interactive' && sourceSession && sessionId !== sourceSession &&
        !(op.action === 'createSession' && this.port.createTopic && !this.port.isTopicDestination?.(source))) {
      throw new Error('upgrade session mismatch');
    }

    if (mode === 'interactive' && (session.control.input !== 'available' || session.status === 'read_only')) {
      const reason = {title:'接入未完成',text:'原端尚未确认可交互权限。请刷新会话状态后重试。',actions:[]};
      await this.showOutcome(original,reason,'attach-unavailable',guard,(card,suffix) => this.channel.deliver(source,card,`${op.operationId}:${suffix}`,guard));
      this.completePending(op.operationId);
      return {status:'rejected',reason:'interactive_attach_unavailable'};
    }

    const destination = await this.topic(source,session,`${op.operationId}:topic`,guard);
    if (!await this.authorize(original.identity,destination,sessionId)) throw new ReadAuthorizationRevoked('unauthorized');
    const targetScope = this.channel.scope(destination);
    const existing = this.ownerRow(destination);
    await this.checkOwner(original,destination,existing);
    await guard();
    if (existing?.session_id === sessionId && destination !== source && mode === 'interactive' && existing.access_mode === 'read_only') {
      if (targetScope !== this.channel.scope(destination)) throw new BindingExpired('binding changed');
      this.completePending(op.operationId);
      await this.channel.deliver(destination,{title:'只读话题已存在',text:'此话题仍为只读。请在这个话题打开会话控制并选择接入并续聊。',actions:[{label:'会话控制',value:{action:'panel',sessionId}}]},`${op.operationId}:existing-readonly`,() => this.channel.checkBinding(destination,sessionId,targetScope));
      return {sessionId,accessMode:'read_only',destination,reason:'upgrade_in_existing_topic'};
    }

    const replace = !existing || existing.session_id !== sessionId;
    let finalScope: string;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (targetScope !== this.channel.scope(destination) || pending.scope !== this.channel.scope(source)) throw new BindingExpired('binding changed');
      if (replace) {
        if (this.port.isTopicDestination?.(destination)) this.port.reassignTopic?.(destination,sessionId);
        this.setBinding(destination,sessionId,original,mode);
      }
      else if (existing.access_mode !== mode) this.db.prepare('UPDATE channel_bindings SET access_mode=?,binding_id=?,revision=revision+1 WHERE destination=?')
        .run(mode,randomUUID(),destination);
      finalScope = this.channel.scope(destination);
      this.completePending(op.operationId);
      const card = sessionCard(session,this.channel.accessMode(destination));
      this.rememberDelivery(op.operationId,destination,session,finalScope,original,card);
      if (destination === source) {
        const callbacks = this.db.prepare('SELECT message_id,envelope FROM channel_binding_attach_cards WHERE operation_id=?')
          .all(op.operationId) as Array<{message_id:string;envelope:string}>;
        for (const callback of callbacks) {
          this.rememberDelivery(op.operationId,destination,session,finalScope,JSON.parse(callback.envelope),card,`:${callback.message_id}`);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    if (!existing && destination !== source) {
      await recordNewTopicRootTitle(this.db,this.port,destination,finalScope,session,`${op.operationId}:topic`);
    }
    if (deliverNow) await this.flushDeliveries(op.operationId);
    return {sessionId,accessMode:mode,destination};
  }

  private rememberDelivery(operationId: string, destination: string, session: Session, scope: string, original: TrustedEnvelope, card: ChannelCard, suffix = ''): void {
    this.db.prepare("INSERT OR IGNORE INTO channel_binding_deliveries VALUES (?,?,?,?,?,?,?,'pending')")
      .run(`${operationId}:topic-reply${suffix}`,operationId,destination,session.sessionId,scope,JSON.stringify(original),JSON.stringify(card));
  }

  private flushDeliveries(operationId: string): Promise<void> {
    const writing = this.writing.get(operationId);
    if (writing) return writing;
    const next = this.writeDeliveries(operationId).finally(() => this.writing.delete(operationId));
    this.writing.set(operationId,next);
    return next;
  }

  private async writeDeliveries(operationId: string): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM channel_binding_deliveries WHERE operation_id=? AND state='pending' ORDER BY rowid")
      .all(operationId) as Delivery[];
    for (const row of rows) {
      const original = JSON.parse(row.envelope) as TrustedEnvelope;
      const guard = async () => {
        await this.channel.checkBinding(row.destination,row.session_id,row.scope);
        if (!await this.authorize(original.identity,row.destination,row.session_id) || row.scope !== this.channel.scope(row.destination)) {
          throw new ReadAuthorizationRevoked('binding delivery unauthorized or changed');
        }
      };
      const card = JSON.parse(row.card) as ChannelCard;
      try {
        if (original.destination === row.destination && original.cardMessageId) {
          if (!await this.patch(row.destination,original.cardMessageId,card,row.delivery_id,guard)) continue;
        } else {
          await this.channel.deliver(row.destination,card,row.delivery_id,guard);
          if (!await this.confirmDelivery(row.delivery_id,guard)) continue;
        }
        this.db.prepare("UPDATE channel_binding_deliveries SET state='completed' WHERE delivery_id=?").run(row.delivery_id);
      } catch (error) {
        if (original.destination === row.destination && original.cardMessageId && isExpiredCard(error)) {
          this.expireCardDelivery(row.delivery_id);
          continue;
        } else if (!(error instanceof BindingExpired || error instanceof ReadAuthorizationRevoked)) throw error;
        this.db.prepare("UPDATE channel_binding_deliveries SET state='expired' WHERE delivery_id=?").run(row.delivery_id);
      }
    }
  }

  private expireCardDelivery(deliveryId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE channel_deliveries SET state='expired' WHERE delivery_id=?").run(deliveryId);
      this.db.prepare("UPDATE channel_binding_deliveries SET state='expired' WHERE delivery_id=?").run(deliveryId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async advanceCompleted(onDerived?: (operation: Operation) => void, skip?: (operationId: string) => boolean): Promise<void> {
    const rows = (table: string) => (this.db.prepare(`SELECT operation_id FROM ${table} WHERE state='pending' ORDER BY rowid`)
      .all() as Array<{operation_id:string}>).map(row=>row.operation_id);
    const recovery = new Set([...rows('channel_pending'), ...rows('channel_binding_deliveries')]);
    const errors: unknown[] = [];
    for (const operationId of recovery) {
      if (skip?.(operationId)) continue;
      try {
        const derived = await this.advanceOperation(operationId);
        if (derived) onDerived?.(derived);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors,'channel completion recovery failed');
  }

  async advanceOperation(operationId: string): Promise<Operation | null> {
    const advancing = this.advancing.get(operationId);
    if (advancing) return advancing;
    const work = this.advance(operationId).finally(() => this.advancing.delete(operationId));
    this.advancing.set(operationId,work);
    return work;
  }

  private async advance(operationId: string): Promise<Operation | null> {
    await this.flushDeliveries(operationId);
    const pending = this.pending(operationId);
    if (!pending || pending.state !== 'pending') return null;
    const { destination, kind } = pending;
    const original = JSON.parse(pending.envelope) as TrustedEnvelope;
    if (original.destination !== destination || pending.scope !== this.channel.scope(destination) ||
        !await this.authorize(original.identity,destination,this.channel.binding(destination))) return null;
    const op = await this.readOperation(operationId);
    if (!op) return null;
    const sessionOperation = kind === 'session' && ['createSession','attachSession'].includes(op.action) && op.targetId === `new:${destination}`;
    if (sessionOperation && needsOperationNotice(op)) {
      const receipt = this.db.prepare("SELECT json_extract(result,'$.status') AS status FROM channel_receipts WHERE event_id=?").get(original.eventId);
      if (receipt?.status !== op.status) {
        const auth = pendingSessionAuthorization(this.db,this.port,this.authorize,original,op.operationId);
        if (auth?.destination === destination) {
          const suffix = `outcome:${op.status}`;
          try {
            await this.showOutcome(original,operationCard(op),suffix,auth.guard,
              (card,id) => this.channel.deliver(destination,card,`${original.eventId}:${id}`,auth.guard));
          } catch (error) {
            if (!(error instanceof ReadAuthorizationRevoked)) throw error;
          }
        }
      }
      return null;
    }
    if (op.status !== 'completed' || !op.result) return null;
    const proven = sessionOperation ? op.result.kind === 'session' :
      kind === 'artifact' && op.result.kind === 'artifact' && op.action === 'stageInputArtifact' &&
        !!pending.session_id && op.targetId === pending.session_id && this.channel.binding(destination) === pending.session_id;
    if (!proven) return null;
    const result = await this.channel.handle(
      {...original,eventId:`auto-finish:${operationId}`},
      {action:'finish',operationId},
    );
    await this.flushDeliveries(operationId);
    return operationFromReceipt(result);
  }
}
