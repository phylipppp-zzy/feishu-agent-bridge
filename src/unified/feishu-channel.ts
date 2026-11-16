import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { UnifiedService } from './adapter.js';
import type { Answer, Identity, Provider, WriteContext } from './contracts.js';
import { payloadDigest } from './contracts.js';
import { questionForm, decodeQuestionForm } from './feishu-question-forms.js';
import { interactionCard, operationCard, sessionCard, type ChannelCard } from './feishu-cards.js';

/** Identity and destination must come from an authenticated, verified transport envelope. */
export interface TrustedEnvelope { eventId: string; destination: string; identity: Identity }
export interface FeishuPort {
  isTopicDestination?(destination:string): boolean;
  createTopic?(destination:string, sessionId:string, card:ChannelCard, deliveryId:string): Promise<string>;
  reassignTopic?(destination:string,sessionId:string):void;
  send(destination: string, card: ChannelCard, deliveryId: string, guard?:()=>Promise<void>): Promise<string | void>;
  update(destination: string, messageId: string, card: ChannelCard, deliveryId: string, guard?:()=>Promise<void>): Promise<void>;
  sendFile(destination: string, name: string, content: Uint8Array, deliveryId: string, guard?: () => Promise<void>): Promise<void>;
  /** Query by transport idempotency key; unknown is never retried automatically. */
  lookupDelivery?(deliveryId: string): Promise<'sent' | 'not_sent' | 'unknown'>;
  lookupMessageId?(deliveryId: string): Promise<string | null>;
  fileMessageLink?(destination:string,sessionId:string,deliveryId:string): Promise<string | null>;
}
class BindingManagementDenied extends Error {}
class BindingExpired extends Error {}
class ReadAuthorizationRevoked extends Error {}
class FileCommandError extends Error {}
export type AuthorizeBindingAdmin = (identity: Identity, destination: string, sessionId: string) => Promise<boolean>;
export type Authorize = (identity: Identity, destination: string, sessionId: string | null) => Promise<boolean>;
export type ChannelAction = (
 | { action: 'list'; search?: string; cursor?: string }
 | { action: 'history'; cursor?: string }
 | { action: 'export' }
 | { action: 'project_files'; directory:string; showHidden:boolean }
 | { action: 'deliver_files'; args:string }
 | { action: 'panel'; sessionId?: string; turnId?: string; inputId?: string }
 | { action: 'bind'; sessionId: string; mode?: 'read_only' | 'interactive' }
 | { action: 'create'; provider: Provider; project: string; model: string | null }
 | { action: 'attach'; provider: Provider; hostId: string; serviceId: string; nativeSessionId: string; mode: 'read_only' | 'interactive' }
 | { action: 'upgrade' }
 | { action: 'input'; text: string; mode: 'new' | 'queue' | 'steer' }
 | { action: 'answer_form'; interactionId:string; revision:number; connectionGeneration:number; fields:Record<string,unknown> }
 | { action: 'answer'; interactionId: string; revision: number; connectionGeneration: number; answer: Answer; toolInputDigest: string | null }
 | { action: 'stop'; turnId: string; revision: number; controlGeneration: number }
 | { action: 'legacy_stop' }
 | { action: 'control'; owner: string; strategy: 'wait' | 'interrupt'; revision: number; controlGeneration: number; release?: boolean }
 | { action: 'artifacts'; sessionId?: string }
 | { action: 'file'; artifactId: string; contentVersion: string }
 | { action: 'attachment'; name: string; mediaType: string; content: Uint8Array; mode: 'new' | 'queue' | 'steer' }
 | { action: 'models'; cursor?: string }
 | { action: 'legacy_model'; model?: string; effort?: string; invalid?: boolean }
 | { action: 'help' }
 | { action: 'new_help' }
 | { action: 'settings'; model: string | null; preferences: Record<string, string>; revision: number; controlGeneration: number }
 | { action: 'notifications'; enabled: boolean; eventTypes: string[]; revision: number; controlGeneration: number }
 | { action: 'cancel'; inputId: string; revision: number; controlGeneration: number }
 | { action: 'archive'; archived: boolean; revision: number; controlGeneration: number }
 | { action: 'unbind' }
 | { action: 'reconcile'; operationId: string }
 | { action: 'finish'; operationId: string }
 | { action: 'pending' }
 | { action: 'health' }) & { bindingId?: string };

/** Standalone channel database. Never opens core's tables. */
export class FeishuChannel {
  private readonly db: DatabaseSync;
  private migrationLocked=false;
  private readonly destinationLocks = new Map<string, Promise<void>>();
  constructor(private readonly service: UnifiedService, private readonly port: FeishuPort, private readonly authorize: Authorize, dbPath: string, private readonly authorizeBindingAdmin?: AuthorizeBindingAdmin) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS channel_bindings (destination TEXT PRIMARY KEY, session_id TEXT NOT NULL, binding_id TEXT NOT NULL, owner_source TEXT NOT NULL, owner_subject TEXT NOT NULL, revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS channel_inbox_scope (event_id TEXT PRIMARY KEY, scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_pending_scope (operation_id TEXT PRIMARY KEY, scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_inbox (event_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_receipts (event_id TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT); CREATE TABLE IF NOT EXISTS channel_cursors (destination TEXT PRIMARY KEY, session_id TEXT NOT NULL, cursor TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_interaction_cards (destination TEXT NOT NULL, session_id TEXT NOT NULL, interaction_id TEXT NOT NULL, revision INTEGER NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(destination,session_id,interaction_id)); CREATE TABLE IF NOT EXISTS channel_known_messages (destination TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(destination,session_id,message_id)); CREATE TABLE IF NOT EXISTS channel_preferences (destination TEXT PRIMARY KEY, session_id TEXT NOT NULL, enabled INTEGER NOT NULL, event_types TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_pending (operation_id TEXT PRIMARY KEY, destination TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL, mode TEXT, state TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_interaction_view (destination TEXT NOT NULL,session_id TEXT NOT NULL,interaction_id TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(destination,session_id,interaction_id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_pending_actors (operation_id TEXT PRIMARY KEY, envelope TEXT NOT NULL)');
    const columns = this.db.prepare('PRAGMA table_info(channel_bindings)').all() as Array<{name:string}>;
    if (!columns.some(c => c.name === 'access_mode')) this.db.exec("ALTER TABLE channel_bindings ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'read_only'");
    for(const table of ['channel_interaction_cards','channel_cursors']) {const fields=this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>;if(!fields.some(c=>c.name==='binding_scope')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN binding_scope TEXT NOT NULL DEFAULT ''`);}
  }
  close(): void { this.db.close(); }
  beginMigrationRollback():void { if(this.migrationLocked) throw new Error('migration lock already held'); this.db.exec('BEGIN IMMEDIATE'); this.migrationLocked=true; }
  endMigrationRollback(commit:boolean):void { if(!this.migrationLocked) throw new Error('migration lock not held'); try {this.db.exec(commit?'COMMIT':'ROLLBACK');} catch(e) {if(commit) {try {this.db.exec('ROLLBACK');} catch {}} throw e;} finally {this.migrationLocked=false;} }
  inspectMigrationBinding(id:string,destination:string):'removable'|'retained'|'absent' { if(!this.migrationLocked) throw new Error('migration lock required'); this.db.exec('SAVEPOINT migration_inspect'); try {const result=this.rollbackMigrationBinding(id); if(result==='retained' && !this.db.prepare('SELECT 1 FROM channel_bindings WHERE destination=?').get(destination)) throw new Error('migration binding missing despite receipt; manual review'); this.db.exec('ROLLBACK TO migration_inspect; RELEASE migration_inspect'); return result==='removed'?'removable':result==='absent' && this.db.prepare('SELECT 1 FROM channel_bindings WHERE destination=?').get(destination)?'retained':result;} catch(e) {this.db.exec('ROLLBACK TO migration_inspect; RELEASE migration_inspect'); throw e;} }
  private migrationBegin():void {this.db.exec(this.migrationLocked?'SAVEPOINT migration_op':'BEGIN IMMEDIATE');}
  private migrationCommit():void {this.db.exec(this.migrationLocked?'RELEASE migration_op':'COMMIT');}
  private migrationAbort():void {this.db.exec(this.migrationLocked?'ROLLBACK TO migration_op; RELEASE migration_op':'ROLLBACK');}
  /** Migration is local metadata only: no delivery, callback or provider effect. */
  importMigrationBinding(migrationId: string, record: {destination:string;sessionId:string;bindingId:string;owner:Identity}): 'inserted'|'already-imported' {
    if (![migrationId,record.destination,record.sessionId,record.bindingId,record.owner?.source,record.owner?.subject].every(v=>typeof v === 'string' && v.trim())) throw new Error('invalid migration binding');
    const digest = payloadDigest(record);
    this.migrationBegin();
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS channel_migration_receipts (migration_id TEXT PRIMARY KEY, digest TEXT NOT NULL, destination TEXT NOT NULL)');
      const old = this.db.prepare('SELECT digest FROM channel_migration_receipts WHERE migration_id=?').get(migrationId) as {digest:string}|undefined;
      if (old) {
        if (old.digest !== digest) throw new Error('migration receipt conflict');
        const current = this.db.prepare('SELECT session_id,binding_id,owner_source,owner_subject,revision FROM channel_bindings WHERE destination=?').get(record.destination) as {session_id:string;binding_id:string;owner_source:string;owner_subject:string;revision:number}|undefined;
        if (!current || current.session_id !== record.sessionId || current.binding_id !== record.bindingId || current.owner_source !== record.owner.source || current.owner_subject !== record.owner.subject || current.revision !== 0) throw new Error('migration binding changed');
        this.migrationCommit(); return 'already-imported';
      }
      if (this.db.prepare('SELECT 1 FROM channel_bindings WHERE destination=? OR binding_id=?').get(record.destination,record.bindingId)) throw new Error('migration binding conflict');
      this.db.prepare('INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision) VALUES(?,?,?,?,?,0)').run(record.destination,record.sessionId,record.bindingId,record.owner.source,record.owner.subject);
      this.db.prepare('INSERT INTO channel_migration_receipts VALUES(?,?,?)').run(migrationId,digest,record.destination);
      this.migrationCommit(); return 'inserted';
    } catch (e) { this.migrationAbort(); throw e; }
  }
  /** Conservatively retain bindings if any channel activity exists, or the binding changed. */
  rollbackMigrationBinding(migrationId: string): 'removed'|'retained'|'absent' {
    this.migrationBegin();
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS channel_migration_receipts (migration_id TEXT PRIMARY KEY, digest TEXT NOT NULL, destination TEXT NOT NULL)');
      const receipt = this.db.prepare('SELECT digest,destination FROM channel_migration_receipts WHERE migration_id=?').get(migrationId) as {digest:string;destination:string}|undefined;
      if (!receipt) { this.migrationCommit(); return 'absent'; }
      const row = this.db.prepare('SELECT destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode FROM channel_bindings WHERE destination=?').get(receipt.destination) as {destination:string;session_id:string;binding_id:string;owner_source:string;owner_subject:string;revision:number;access_mode:string}|undefined;
      const record = row && {destination:row.destination,sessionId:row.session_id,bindingId:row.binding_id,owner:{source:row.owner_source,subject:row.owner_subject}};
      const tables = ['channel_inbox_scope','channel_pending_scope','channel_inbox','channel_receipts','channel_cursors','channel_deliveries','channel_interaction_cards','channel_interaction_view','channel_known_messages','channel_preferences','channel_pending'];
      const activity = tables.some(t => !!this.db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get());
      if (!row || row.revision !== 0 || row.access_mode !== 'read_only' || !record || payloadDigest(record) !== receipt.digest || activity) { this.migrationCommit(); return 'retained'; }
      this.db.prepare('DELETE FROM channel_bindings WHERE destination=?').run(receipt.destination);
      this.db.prepare('DELETE FROM channel_migration_receipts WHERE migration_id=?').run(migrationId);
      this.migrationCommit(); return 'removed';
    } catch (e) { this.migrationAbort(); throw e; }
  }
  /** A copy of current binding metadata for the trusted runtime restart workflow. */
  bindingsForRestore(): Array<{destination:string;sessionId:string;accessMode:'read_only'|'interactive';owner:Identity;bindingId:string;revision:number}> {
    const rows=this.db.prepare('SELECT destination,session_id,access_mode,owner_source,owner_subject,binding_id,revision FROM channel_bindings ORDER BY destination').all() as Array<{destination:string;session_id:string;access_mode:'read_only'|'interactive';owner_source:string;owner_subject:string;binding_id:string;revision:number}>;
    return rows.map(r=>({destination:r.destination,sessionId:r.session_id,accessMode:r.access_mode,owner:{source:r.owner_source,subject:r.owner_subject},bindingId:r.binding_id,revision:r.revision}));
  }
  async isRestoreBindingAuthorized(binding:ReturnType<FeishuChannel['bindingsForRestore']>[number]):Promise<boolean> {
    const current=this.bindingsForRestore().find(b=>b.destination===binding.destination);
    return !!current && current.accessMode==='interactive' && payloadDigest(current)===payloadDigest(binding) && await this.authorize(current.owner,current.destination,current.sessionId);
  }
  boundDestinations(): string[] { return (this.db.prepare('SELECT destination FROM channel_bindings ORDER BY destination').all() as Array<{destination:string}>).map(x=>x.destination); }
  private recordPendingActor(operationId:string,e:TrustedEnvelope):void {
    const value=JSON.stringify(e);this.db.prepare('INSERT OR IGNORE INTO channel_pending_actors VALUES (?,?)').run(operationId,value);
    const row=this.db.prepare('SELECT envelope FROM channel_pending_actors WHERE operation_id=?').get(operationId) as {envelope:string};if(row.envelope!==value) throw new Error('pending actor conflict');
  }
  /** Complete only operations whose durable receipt proves success, under the original authenticated actor and captured binding scope. */
  async advanceCompleted():Promise<void> {
    const rows=this.db.prepare("SELECT p.operation_id,p.destination,p.kind,p.session_id,a.envelope,s.scope FROM channel_pending p JOIN channel_pending_actors a ON a.operation_id=p.operation_id JOIN channel_pending_scope s ON s.operation_id=p.operation_id WHERE p.state='pending' ORDER BY p.rowid").all() as Array<{operation_id:string;destination:string;kind:string;session_id:string|null;envelope:string;scope:string}>;
    for(const row of rows) {
      const original=JSON.parse(row.envelope) as TrustedEnvelope;
      if(original.destination!==row.destination || row.scope!==this.bindingScope(row.destination) || !await this.authorize(original.identity,row.destination,this.binding(row.destination))) continue;
      let op:import('./contracts.js').Operation;
      try {op=await this.service.getOperation(row.operation_id);} catch(error) {if(error && typeof error==='object' && 'detail' in error && (error as {detail?:{code?:string}}).detail?.code==='invalid_request') continue; throw error;}
      if(op.status!=='completed' || !op.result) continue;
      const proven = row.kind==='session' ? op.result.kind==='session' && ['createSession','attachSession'].includes(op.action) && op.targetId===`new:${row.destination}` : row.kind==='artifact' && op.result.kind==='artifact' && op.action==='stageInputArtifact' && !!row.session_id && op.targetId===row.session_id && this.binding(row.destination)===row.session_id;
      if(!proven) continue;
      const e={...original,eventId:`auto-finish:${row.operation_id}`};
      await this.handle(e,{action:'finish',operationId:row.operation_id});
    }
  }
  pendingOperations(destination: string): Array<{operationId:string;kind:string;state:string}> { return this.db.prepare("SELECT operation_id AS operationId,kind,state FROM channel_pending WHERE destination=? AND state='pending'").all(destination) as Array<{operationId:string;kind:string;state:string}>; }
  pendingDeliveries(): Array<{deliveryId: string; state: string}> {
    return this.db.prepare("SELECT delivery_id AS deliveryId,state FROM channel_deliveries WHERE state='unknown'").all() as Array<{deliveryId:string;state:string}>;
  }
  async reconcileDelivery(deliveryId: string): Promise<'sent' | 'not_sent' | 'unknown'> {
    const row = this.db.prepare('SELECT state FROM channel_deliveries WHERE delivery_id=?').get(deliveryId) as {state:string} | undefined;
    if (!row) throw new Error('unknown delivery');
    if (row.state === 'sent') return 'sent';
    const state = await this.port.lookupDelivery?.(deliveryId) ?? 'unknown';
    if (state === 'sent') this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(deliveryId);
    return state;
  }
  private async checkBinding(destination: string, sessionId: string, scope?:string): Promise<void> {
    if(scope!==undefined && scope!==this.bindingScope(destination)) throw new Error('binding changed');
    const b = this.db.prepare('SELECT session_id,owner_source,owner_subject FROM channel_bindings WHERE destination=?').get(destination) as {session_id:string;owner_source:string;owner_subject:string} | undefined;
    if (!b || b.session_id !== sessionId || !await this.authorize({source:b.owner_source,subject:b.owner_subject},destination,sessionId)) throw new Error('binding unauthorized or changed');
    if (this.binding(destination) !== sessionId || (scope!==undefined && scope!==this.bindingScope(destination))) throw new Error('binding changed');
  }
  private bindingScope(destination: string): string { const row = this.db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings WHERE destination=?').get(destination); return JSON.stringify(row ?? null); }
  private actionScope(action: ChannelAction, destination: string): string { return ['list','health','pending','create','attach'].includes(action.action) ? 'global' : this.bindingScope(destination); }
  private binding(destination: string): string | null { return (this.db.prepare('SELECT session_id FROM channel_bindings WHERE destination=?').get(destination) as {session_id: string} | undefined)?.session_id ?? null; }
  private accessMode(destination:string): 'read_only'|'interactive' { const row=this.db.prepare('SELECT access_mode FROM channel_bindings WHERE destination=?').get(destination) as {access_mode:string}|undefined; return row?.access_mode === 'interactive' ? 'interactive' : 'read_only'; }
  private context(e: TrustedEnvelope, targetId: string, expectedRevision: number, controlGeneration: number): WriteContext {
    const id = createHash('sha256').update(JSON.stringify([e.destination, e.eventId])).digest('hex');
    return { operationId: `feishu:${id}`, idempotencyKey: `feishu:${id}`, targetId, expectedRevision, controlGeneration, identity: e.identity };
  }
  private stampCard(destination:string, card:ChannelCard): ChannelCard {
    const row=this.db.prepare('SELECT binding_id FROM channel_bindings WHERE destination=?').get(destination) as {binding_id:string} | undefined;
    if (!row) return card;
    return {...card,actions:card.actions.map(action => ['list'].includes(String(action.value.action)) ? action : {...action,value:{...action.value,bindingId:row.binding_id}})};
  }
  private async deliver(destination: string, card: ChannelCard, id: string, guard?:()=>Promise<void>): Promise<string | void> {
    await guard?.();
    // A failed or interrupted delivery has unknown outcome; do not silently resend.
    const inserted = this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id);
    if (!inserted.changes) return;
    const messageId = await this.port.send(destination, this.stampCard(destination,card), id,guard);
    await guard?.();
    this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id);
    return messageId;
  }
  private async checkManager(e: TrustedEnvelope, action: ChannelAction): Promise<void> {
    if (!['bind','unbind','archive','control','settings','notifications','create','attach','upgrade','finish'].includes(action.action)) return;
    if (action.action === 'finish') { const pending = this.db.prepare('SELECT kind FROM channel_pending WHERE operation_id=? AND destination=?').get(action.operationId,e.destination) as {kind:string} | undefined; if (pending?.kind === 'artifact') return; }
    const row = this.db.prepare('SELECT session_id,owner_source,owner_subject FROM channel_bindings WHERE destination=?').get(e.destination) as {session_id:string;owner_source:string;owner_subject:string} | undefined;
    if (!row || (row.owner_source === e.identity.source && row.owner_subject === e.identity.subject)) return;
    if (!await this.authorizeBindingAdmin?.(e.identity,e.destination,row.session_id)) throw new BindingManagementDenied('binding management unauthorized');
  }
  /** Capture a binding on the authenticated transport before deferred resource download. */
  async captureBindingScope(e:TrustedEnvelope):Promise<string> {
    const scope=this.bindingScope(e.destination); const session=this.binding(e.destination);
    if (!session || !await this.authorize(e.identity,e.destination,session)) throw new Error('unauthorized or unbound');
    if (this.accessMode(e.destination) !== 'interactive') throw new Error('read-only binding');
    if (scope!==this.bindingScope(e.destination)) throw new Error('binding changed');
    return scope;
  }
  /** Persist verified input before returning; no core operation or outbound send occurs here. */
  async intake(e: TrustedEnvelope, a: ChannelAction, expectedScope?:string): Promise<{eventId:string;state:string}> {
    if (!e.eventId || !e.destination || !e.identity?.subject || !e.identity.source) throw new Error('invalid trusted envelope');
    const capturedScope = this.actionScope(a,e.destination);
    if (expectedScope !== undefined && (a.action !== 'attachment' || capturedScope !== expectedScope)) throw new Error('binding changed');
    if (a.bindingId) { const row = this.db.prepare('SELECT binding_id FROM channel_bindings WHERE destination=?').get(e.destination) as {binding_id:string} | undefined; if (!row || row.binding_id !== a.bindingId) throw new Error('binding changed'); }
    const bound = this.binding(e.destination);
    if (e.eventId.startsWith('card:') && a.action === 'bind' && bound && !a.bindingId) throw new Error('binding changed');
    const target = a.action === 'bind' ? a.sessionId : bound;
    if (!await this.authorize(e.identity,e.destination,target)) throw new Error('unauthorized');
    await this.checkManager(e,a);
    const serializedAction = JSON.stringify(a.action === 'attachment' ? {...a,content:Array.from(a.content)} : a);
    const digest = payloadDigest({destination:e.destination,identity:e.identity,action:JSON.parse(serializedAction)});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT digest,state FROM channel_receipts WHERE event_id=?').get(e.eventId) as {digest:string;state:string} | undefined;
      if (old) { if (old.digest !== digest) throw new Error('idempotency conflict'); this.db.exec('COMMIT'); return {eventId:e.eventId,state:old.state}; }
      this.db.prepare("INSERT INTO channel_receipts VALUES (?,?,'received',NULL)").run(e.eventId,digest);
      if (this.actionScope(a,e.destination) !== capturedScope) throw new Error('binding changed during intake');
      this.db.prepare("INSERT INTO channel_inbox VALUES (?,?,?,'received')").run(e.eventId,JSON.stringify(e),serializedAction);
      this.db.prepare('INSERT INTO channel_inbox_scope VALUES (?,?)').run(e.eventId,capturedScope);
      this.db.exec('COMMIT'); return {eventId:e.eventId,state:'received'};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  unknownInbox(): string[] { return (this.db.prepare("SELECT event_id FROM channel_inbox WHERE state='unknown' ORDER BY rowid").all() as Array<{event_id:string}>).map(x=>x.event_id); }
  pendingInbox(): string[] { return (this.db.prepare("SELECT event_id FROM channel_inbox WHERE state='received' ORDER BY rowid").all() as Array<{event_id:string}>).map(x=>x.event_id); }
  /** A crash after execution begins remains unknown and requires reconciliation. */
  async drain(eventId: string): Promise<unknown> {
    const pre = this.db.prepare('SELECT envelope FROM channel_inbox WHERE event_id=?').get(eventId) as {envelope:string} | undefined;
    if (!pre) throw new Error('event not found');
    const destination = (JSON.parse(pre.envelope) as TrustedEnvelope).destination;
    const previous = this.destinationLocks.get(destination) ?? Promise.resolve();
    let release!: () => void; const lock = new Promise<void>(r => { release = r; });
    const tail = previous.then(() => lock); this.destinationLocks.set(destination,tail);
    await previous;
    try { return await this.drainLocked(eventId); } finally { release(); if (this.destinationLocks.get(destination) === tail) this.destinationLocks.delete(destination); }
  }
  private async drainLocked(eventId: string): Promise<unknown> {
    const row = this.db.prepare('SELECT envelope,action,state FROM channel_inbox WHERE event_id=?').get(eventId) as {envelope:string;action:string;state:string} | undefined;
    if (!row) throw new Error('event not found');
    if (row.state !== 'received') { const receipt=this.db.prepare('SELECT result FROM channel_receipts WHERE event_id=?').get(eventId) as {result:string|null}; return receipt.result ? JSON.parse(receipt.result) : {status:'unknown'}; }
    const e = JSON.parse(row.envelope) as TrustedEnvelope;
    const raw = JSON.parse(row.action) as ChannelAction;
    const a = raw.action === 'attachment' ? {...raw,content:Uint8Array.from(raw.content as unknown as number[])} : raw;
    const scope = this.db.prepare('SELECT scope FROM channel_inbox_scope WHERE event_id=?').get(eventId) as {scope:string} | undefined;
    const bindingRow=this.db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings WHERE destination=?').get(e.destination) as {session_id:string;binding_id:string;revision:number;access_mode:string} | undefined;
    const bound = bindingRow?.session_id ?? null;
    const executionScope = JSON.stringify(bindingRow ?? null);
    if (!scope || (scope.scope !== 'global' && scope.scope !== executionScope)) { const result={status:'expired',reason:'binding_changed'}; this.db.prepare("UPDATE channel_inbox SET state='expired' WHERE event_id=?").run(eventId); this.db.prepare("UPDATE channel_receipts SET state='expired',result=? WHERE event_id=?").run(JSON.stringify(result),eventId); return result; }
    const rejectUnauthorized=() => { const result={status:'rejected',reason:'unauthorized'}; this.db.exec('BEGIN IMMEDIATE'); try { this.db.prepare("UPDATE channel_inbox SET state='rejected' WHERE event_id=? AND state='received'").run(eventId); this.db.prepare("UPDATE channel_receipts SET state='rejected',result=? WHERE event_id=?").run(JSON.stringify(result),eventId); this.db.exec('COMMIT'); } catch(error) {this.db.exec('ROLLBACK');throw error;} return result; };
    if (!await this.authorize(e.identity,e.destination,a.action === 'bind' ? a.sessionId : bound)) return rejectUnauthorized();
    try { await this.checkManager(e,a); } catch(error) { if (error instanceof BindingManagementDenied) return rejectUnauthorized(); throw error; }
    if (scope.scope !== 'global' && scope.scope !== this.bindingScope(e.destination)) { const result={status:'expired',reason:'binding_changed'}; this.db.prepare("UPDATE channel_inbox SET state='expired' WHERE event_id=?").run(eventId); this.db.prepare("UPDATE channel_receipts SET state='expired',result=? WHERE event_id=?").run(JSON.stringify(result),eventId); return result; }
    if (bound && this.accessMode(e.destination) === 'read_only' && (['input','answer','answer_form','attachment','stop','legacy_stop','control','settings','cancel','archive','reconcile'].includes(a.action) || (a.action === 'legacy_model' && !!a.model))) {
      const result={status:'rejected',reason:'read_only_binding'};
      this.db.exec('BEGIN IMMEDIATE');
      try { this.db.prepare("UPDATE channel_inbox SET state='rejected' WHERE event_id=? AND state='received'").run(eventId); this.db.prepare("UPDATE channel_receipts SET state='rejected',result=? WHERE event_id=?").run(JSON.stringify(result),eventId); this.db.exec('COMMIT'); } catch(error) { this.db.exec('ROLLBACK'); throw error; }
      await this.deliver(e.destination,{title:'操作未执行',text:'此话题为只读，不能执行此操作。可在本话题打开会话控制并选择转为可交互。',actions:[{label:'会话控制',value:{action:'panel',sessionId:bound}}]},`${eventId}:readonly-rejected`);
      return result;
    }
    if (bound && a.action === 'attach') throw new Error('use upgrade for a bound destination');
    const claim=this.db.prepare("UPDATE channel_inbox SET state='unknown' WHERE event_id=? AND state='received'").run(eventId);
    if (!claim.changes) return {status:'unknown'};
    this.db.prepare("UPDATE channel_receipts SET state='unknown' WHERE event_id=?").run(eventId);
    let result:unknown; const effects={started:false};
    try { result=await this.execute(e,a,bound,executionScope,effects); }
    catch (error) {
      const readOnly=['help','new_help','pending','list','health','panel','history','artifacts','project_files','deliver_files','export','file','models'].includes(a.action) || (a.action==='legacy_model' && !a.model);
      if (readOnly && !effects.started && (error instanceof BindingExpired || error instanceof ReadAuthorizationRevoked)) { const result={status:error instanceof BindingExpired ? 'expired' : 'rejected',reason:error instanceof BindingExpired ? 'binding_changed' : 'unauthorized'}; this.db.exec('BEGIN IMMEDIATE'); try {this.db.prepare('UPDATE channel_inbox SET state=? WHERE event_id=?').run(result.status,eventId);this.db.prepare('UPDATE channel_receipts SET state=?,result=? WHERE event_id=?').run(result.status,JSON.stringify(result),eventId);this.db.exec('COMMIT');} catch(e) {this.db.exec('ROLLBACK');throw e;} return result; }
      if(error instanceof FileCommandError) { const allowed=executionScope===this.bindingScope(e.destination) && await this.authorize(e.identity,e.destination,bound); const stale=executionScope!==this.bindingScope(e.destination); if(stale || !allowed) {if(effects.started) throw error; const result={status:stale?'expired':'rejected',reason:stale?'binding_changed':'unauthorized'}; this.db.exec('BEGIN IMMEDIATE'); try {this.db.prepare('UPDATE channel_inbox SET state=? WHERE event_id=?').run(result.status,eventId); this.db.prepare('UPDATE channel_receipts SET state=?,result=? WHERE event_id=?').run(result.status,JSON.stringify(result),eventId); this.db.exec('COMMIT');} catch(e) {this.db.exec('ROLLBACK');throw e;} return result;} result={status:'rejected',reason:error.message}; await this.deliver(e.destination,{title:'文件操作未完成',text:error.message,actions:[]},`${eventId}:file-rejected`); this.db.prepare("UPDATE channel_receipts SET state='completed',result=? WHERE event_id=?").run(JSON.stringify(result),eventId); this.db.prepare("UPDATE channel_inbox SET state='completed' WHERE event_id=?").run(eventId); return result; }
      const detail=error && typeof error==='object' && 'detail' in error ? (error as {detail?:{code?:string}}).detail : undefined;
      const messages:Record<string,string>={busy:'目标已变化或正在处理，请刷新面板查看。',stale_revision:'会话状态已变化，请刷新面板。',control_conflict:'控制状态已变化，请刷新面板。',unsupported:'当前不支持此操作。',interaction_expired:'问题或审批已失效，请刷新。',unauthorized:'没有操作权限。',invalid_request:'请求无效，请刷新面板。'};
      if (!detail?.code || !messages[detail.code]) throw error;
      result={status:'rejected',reason:detail.code};
      if(executionScope!==this.bindingScope(e.destination) || !await this.authorize(e.identity,e.destination,bound) || executionScope!==this.bindingScope(e.destination)) throw error;
      await this.deliver(e.destination,{title:'操作未执行',text:messages[detail.code]!,actions:[]},`${eventId}:rejected`);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare("UPDATE channel_receipts SET state='completed',result=? WHERE event_id=?").run(JSON.stringify(result ?? null),eventId); this.db.prepare("UPDATE channel_inbox SET state='completed' WHERE event_id=?").run(eventId); this.db.exec('COMMIT'); }
    catch (error) {this.db.exec('ROLLBACK');throw error;}
    return result;
  }
  async handle(e: TrustedEnvelope, a: ChannelAction): Promise<unknown> { await this.intake(e,a); return this.drain(e.eventId); }
  private async execute(e: TrustedEnvelope, a: ChannelAction, bound: string | null, executionScope:string, effects:{started:boolean}): Promise<unknown> {
    const guard = async () => { if(executionScope!==this.bindingScope(e.destination)) throw new BindingExpired('binding changed'); const allowed=await this.authorize(e.identity,e.destination,bound); if(executionScope!==this.bindingScope(e.destination)) throw new BindingExpired('binding changed'); if(!allowed) throw new ReadAuthorizationRevoked('unauthorized'); };
    const reply = async (card: ChannelCard, suffix = 'reply') => { await guard(); effects.started=true; return this.deliver(e.destination, card, `${e.eventId}:${suffix}`,guard); };
    if (a.action === 'help' || a.action === 'new_help') { const text = a.action === 'help' ? '会话列表：/sessions；选择模型：在会话话题发送 /model；新建：/new；会话控制：/panel；历史：/history；中断当前回复：/stop；后台任务是否终止尚未确认。' : '请先选择 provider 和可信项目目录，再发送 /create <codex|claude> <项目目录>。创建完成后在新话题发送任务；目录须符合服务端允许范围。'; await reply({title:a.action === 'help' ? '帮助' : '新建会话',text,actions:[]}); return {status:'guidance'}; }
    if (a.action === 'pending') { const pending = this.pendingOperations(e.destination); await reply({title:'待完成操作',text:pending.length ? '查询完成结果后继续' : '没有待完成操作',actions:pending.map(p=>({label:`继续 ${p.kind}`,value:{action:'finish',operationId:p.operationId}}))}); return pending; }
    if (a.action === 'list') {
      const page=await this.service.listSessions({limit:5,...(a.search === undefined ? {} : {search:a.search}),...(a.cursor === undefined ? {} : {cursor:a.cursor})});
      const sessions=[]; for(const s of page.items) if(await this.authorize(e.identity,e.destination,s.sessionId)) sessions.push(s);
      const actions:ChannelCard['actions']=sessions.flatMap((s,index)=>[{label:`${index+1} 查看`,value:{action:'bind',sessionId:s.sessionId,mode:'read_only'}},{label:`${index+1} 接入`,value:{action:'bind',sessionId:s.sessionId,mode:'interactive'}}]);
      if(page.nextCursor) actions.push({label:'下一页',value:{action:'list',cursor:page.nextCursor,...(a.search ? {search:a.search}:{})}});
      const text=sessions.length ? sessions.map((s,index)=>`${index+1}. ${s.native.provider} · ${s.title.slice(0,100)} · ${s.project.slice(0,200)}`).join('\n') : '此页没有可查看的会话。';
      await reply({title:'会话列表',text,actions});return {nextCursor:page.nextCursor};
    }
    if (a.action === 'health') { const health = await this.service.health(); await reply({ title: '健康状态', text: JSON.stringify(health), actions: [] }); return health; }
    if (a.action === 'bind' && a.mode === 'interactive') {
      if (bound && bound !== a.sessionId) {await reply({title:'无法接入',text:'此话题已绑定其他会话，请先在目标话题操作。',actions:[]});return {status:'rejected',reason:'session_mismatch'};}
      if (bound && this.accessMode(e.destination) === 'interactive') {await reply({title:'已接入',text:'此话题已绑定为可交互，可查看会话控制确认当前状态。',actions:[]});return {status:'completed',sessionId:bound,accessMode:'interactive'};}
      const session=await this.service.getSession(a.sessionId); await guard(); if(!await this.authorize(e.identity,e.destination,a.sessionId)) throw new Error('unauthorized'); await guard(); const n=session.native;
      if (bound && bound !== session.sessionId) throw new Error('unbind before interactive attach');
      const ctx=this.context(e,`new:${e.destination}`,0,0);
      this.db.prepare("INSERT OR IGNORE INTO channel_pending VALUES (?,?,NULL,'session','interactive','pending')").run(ctx.operationId,e.destination);
      this.db.prepare('INSERT OR IGNORE INTO channel_pending_scope VALUES (?,?)').run(ctx.operationId,this.bindingScope(e.destination)); this.recordPendingActor(ctx.operationId,e);
      const op=await this.service.attachSession({context:ctx,payload:{provider:n.provider,hostId:n.hostId,serviceId:n.serviceId,nativeSessionId:n.nativeSessionId,mode:'interactive'}});
      await reply({...operationCard(op),text:operationCard(op).text+(op.status === 'unknown' ? '' : '；完成后将自动继续'),actions:[{label:'查看处理进度',value:{action:'finish',operationId:op.operationId}}]}); return op;
    }
    if (a.action === 'bind') { const s = await this.service.getSession(a.sessionId); const destination = this.port.createTopic && !this.port.isTopicDestination?.(e.destination) ? await this.port.createTopic(e.destination,s.sessionId,{title:s.title,text:`${s.native.provider} · ${s.project} · ${s.status}`,actions:[]},`${e.eventId}:topic`) : e.destination; if (!await this.authorize(e.identity,destination,s.sessionId)) throw new Error('unauthorized'); const existing=this.db.prepare('SELECT session_id,owner_source,owner_subject FROM channel_bindings WHERE destination=?').get(destination) as {session_id:string;owner_source:string;owner_subject:string}|undefined; if(existing && (existing.owner_source!==e.identity.source || existing.owner_subject!==e.identity.subject) && !await this.authorizeBindingAdmin?.(e.identity,destination,existing.session_id)) throw new Error('binding management unauthorized'); if (!existing || existing.session_id!==s.sessionId) { if(this.port.isTopicDestination?.(destination)) this.port.reassignTopic?.(destination,s.sessionId); this.db.prepare("INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode) VALUES (?,?,?,?,?,1,'read_only') ON CONFLICT(destination) DO UPDATE SET session_id=excluded.session_id,binding_id=excluded.binding_id,owner_source=excluded.owner_source,owner_subject=excluded.owner_subject,revision=channel_bindings.revision+1,access_mode='read_only'").run(destination,s.sessionId,randomUUID(),e.identity.source,e.identity.subject); this.db.prepare('DELETE FROM channel_cursors WHERE destination=?').run(destination); } await this.deliver(destination,{...sessionCard(s),text:sessionCard(s).text + `\n绑定模式: ${this.accessMode(destination)}`},`${e.eventId}:reply`); return { sessionId: s.sessionId, accessMode:this.accessMode(destination), destination }; }
    if (a.action === 'create' || a.action === 'attach') { const ctx = this.context(e, `new:${e.destination}`, 0, 0); this.db.prepare("INSERT OR IGNORE INTO channel_pending VALUES (?,?,NULL,'session',?,'pending')").run(ctx.operationId,e.destination,a.action === 'attach' ? a.mode : 'interactive'); this.db.prepare('INSERT OR IGNORE INTO channel_pending_scope VALUES (?,?)').run(ctx.operationId,this.bindingScope(e.destination)); this.recordPendingActor(ctx.operationId,e); const op = a.action === 'create' ? await this.service.createSession({ context: ctx, payload: { provider: a.provider, project: a.project, model: a.model } }) : await this.service.attachSession({ context: ctx, payload: { provider: a.provider, hostId: a.hostId, serviceId: a.serviceId, nativeSessionId: a.nativeSessionId, mode: a.mode } }); this.db.prepare("INSERT OR IGNORE INTO channel_pending VALUES (?,?,NULL,'session',?,'pending')").run(op.operationId,e.destination,a.action === 'attach' ? a.mode : 'interactive'); await reply({...operationCard(op),text:operationCard(op).text+(op.status === 'unknown' ? '' : '；完成后将自动继续'),actions:[{label:'查看处理进度',value:{action:'finish',operationId:op.operationId}}]}); return op; }
    if (a.action === 'upgrade') {
      if (!bound || this.accessMode(e.destination) !== 'read_only') throw new Error('no read-only binding');
      const session=await this.service.getSession(bound); const n=session.native;
      const ctx=this.context(e,`new:${e.destination}`,0,0);
      this.db.prepare("INSERT OR IGNORE INTO channel_pending VALUES (?,?,NULL,'session','interactive','pending')").run(ctx.operationId,e.destination);
      this.db.prepare('INSERT OR IGNORE INTO channel_pending_scope VALUES (?,?)').run(ctx.operationId,this.bindingScope(e.destination)); this.recordPendingActor(ctx.operationId,e);
      const op=await this.service.attachSession({context:ctx,payload:{provider:n.provider,hostId:n.hostId,serviceId:n.serviceId,nativeSessionId:n.nativeSessionId,mode:'interactive'}});
      await reply({...operationCard(op),text:operationCard(op).text+(op.status === 'unknown' ? '' : '；完成后将自动继续'),actions:[{label:'查看处理进度',value:{action:'finish',operationId:op.operationId}}]}); return op;
    }
    if (a.action === 'finish') {
      const pending = this.db.prepare('SELECT * FROM channel_pending WHERE operation_id=? AND destination=?').get(a.operationId,e.destination) as {session_id:string | null;kind:string;mode:'new'|'queue'|'steer'|'read_only'|'interactive' | null;state:string} | undefined;
      if (!pending) throw new Error('pending operation not found');
      if (pending.state === 'completed') return {status:'completed'};
      const pendingScope = this.db.prepare('SELECT scope FROM channel_pending_scope WHERE operation_id=?').get(a.operationId) as {scope:string} | undefined;
      if (!pendingScope || pendingScope.scope !== this.bindingScope(e.destination)) return {status:'expired',reason:'binding_changed'};
      const op = await this.service.getOperation(a.operationId); await guard();
      if (op.status !== 'completed' || !op.result) return op;
      if (pending.kind === 'session' && op.result.kind === 'session') {
        if (!await this.authorize(e.identity,e.destination,op.result.sessionId)) throw new Error('unauthorized');
        const session = await this.service.getSession(op.result.sessionId); await guard();
        if (pending.mode === 'interactive' && bound && op.result.sessionId !== bound) throw new Error('upgrade session mismatch');
        const destination = this.port.createTopic && !this.port.isTopicDestination?.(e.destination) ? await this.port.createTopic(e.destination,session.sessionId,{title:session.title,text:`${session.native.provider} · ${session.project} · ${session.status}`,actions:[]},`${a.operationId}:topic`) : e.destination;
        if (!await this.authorize(e.identity,destination,session.sessionId)) throw new Error('unauthorized'); await guard();
        const existing=this.db.prepare('SELECT session_id,owner_source,owner_subject FROM channel_bindings WHERE destination=?').get(destination) as {session_id:string;owner_source:string;owner_subject:string}|undefined; if(existing && (existing.owner_source!==e.identity.source || existing.owner_subject!==e.identity.subject) && !await this.authorizeBindingAdmin?.(e.identity,destination,existing.session_id)) throw new Error('binding management unauthorized'); await guard();
        if (existing?.session_id === session.sessionId && destination !== e.destination && pending.mode === 'interactive' && this.accessMode(destination) === 'read_only') {
          this.db.prepare("UPDATE channel_pending SET state='completed' WHERE operation_id=?").run(a.operationId);
          await this.deliver(destination,{title:'只读话题已存在',text:'此话题仍为只读。请在本话题打开会话控制，选择转为可交互。',actions:[{label:'会话控制',value:{action:'panel',sessionId:session.sessionId}}]},`${a.operationId}:existing-readonly`);
          return {sessionId:session.sessionId,accessMode:'read_only',destination,reason:'upgrade_in_existing_topic'};
        }
        if (!existing || existing.session_id!==session.sessionId) { if(this.port.isTopicDestination?.(destination)) this.port.reassignTopic?.(destination,session.sessionId); this.db.prepare("INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode) VALUES (?,?,?,?,?,1,'read_only') ON CONFLICT(destination) DO UPDATE SET session_id=excluded.session_id,binding_id=excluded.binding_id,owner_source=excluded.owner_source,owner_subject=excluded.owner_subject,revision=channel_bindings.revision+1,access_mode='read_only'").run(destination,session.sessionId,randomUUID(),e.identity.source,e.identity.subject); this.db.prepare('DELETE FROM channel_cursors WHERE destination=?').run(destination); } const mode = pending.mode === 'interactive' ? 'interactive' : 'read_only'; if (mode === 'interactive' && (session.control.input !== 'available' || session.status === 'read_only')) throw new Error('interactive attach unavailable'); if (this.accessMode(destination) !== mode) this.db.prepare('UPDATE channel_bindings SET access_mode=?,binding_id=?,revision=revision+1 WHERE destination=?').run(mode,randomUUID(),destination); this.db.prepare("UPDATE channel_pending SET state='completed' WHERE operation_id=?").run(a.operationId); await this.deliver(destination,{...sessionCard(session),text:sessionCard(session).text + `\n绑定模式: ${mode}`},`${a.operationId}:topic-reply`); return {sessionId:session.sessionId,accessMode:mode,destination};
      }
      if (pending.kind === 'artifact' && this.accessMode(e.destination) !== 'interactive') throw new Error('read-only binding');
      if (pending.kind === 'artifact' && op.result.kind === 'artifact' && pending.session_id && pending.mode) {
        if (pending.session_id !== bound) throw new Error('binding changed');
        const session = await this.service.getSession(bound);
        const id = `attachment-submit:${a.operationId}`;
        const context = {...this.context(e,bound,session.revision,session.control.generation),operationId:id,idempotencyKey:id};
        const result = await this.service.submitInput({context,mode:pending.mode as 'new'|'queue'|'steer',blocks:[{type:'artifact',artifactId:op.result.artifactId,contentVersion:op.result.contentVersion}]});
        this.db.prepare("UPDATE channel_pending SET state='completed' WHERE operation_id=?").run(a.operationId); await reply(operationCard(result)); return result;
      }
      throw new Error('operation result mismatch');
    }
    if (!bound && (a.action === 'models' || a.action === 'legacy_model')) { await reply({title:'模型',text:'请进入已绑定的会话话题后发送 /model。',actions:[]}); return {status:'guidance'}; }
    if (!bound) throw new Error('destination is not bound');
    const session = await this.service.getSession(bound);
    const current = () => this.context(e, bound, session.revision, session.control.generation);
    if (a.action === 'unbind') { this.db.prepare('DELETE FROM channel_bindings WHERE destination=?').run(e.destination); this.db.prepare('DELETE FROM channel_cursors WHERE destination=?').run(e.destination); return { unbound: true }; }
    if (a.action === 'panel' && this.accessMode(e.destination) === 'read_only') { await reply({title:'只读会话',text:'此话题只读，可查看历史与文件。外部终端启动的 Claude 若仅同步等待状态、未接入响应通道，请回原终端处理。',actions:[{label:'转为可交互',value:{action:'upgrade'}},{label:'暂停通知',value:{action:'notifications',enabled:false,eventTypes:[],revision:session.revision,controlGeneration:session.control.generation}},{label:'恢复通知',value:{action:'notifications',enabled:true,eventTypes:[],revision:session.revision,controlGeneration:session.control.generation}}]}); return {accessMode:'read_only'}; }
    if (a.action === 'panel') {
      if (a.sessionId && a.sessionId !== bound) throw new Error('session mismatch');
      const base={revision:session.revision,controlGeneration:session.control.generation};
      const work=await this.service.getWorkState(bound);
      const interruptAvailable=session.capabilities?.interrupt?.status === 'available' && session.control.input === 'available';
      const queueAvailable=session.capabilities?.queue?.status === 'available' && session.control.input === 'available';
      const actions:ChannelCard['actions']=[
        {label:'暂停通知',value:{action:'notifications',enabled:false,eventTypes:[],...base}}, {label:'恢复通知',value:{action:'notifications',enabled:true,eventTypes:[],...base}},
        ...(work.canArchive ? [{label:'归档',value:{action:'archive',archived:true,...base}},{label:'恢复归档',value:{action:'archive',archived:false,...base}}] : []),
        ...(session.capabilities?.handoff?.status === 'available' ? [{label:'切换到飞书',value:{action:'control',owner:'feishu',strategy:'wait',...base}}, {label:'释放控制',value:{action:'control',owner:'feishu',strategy:'wait',release:true,...base}}] : []),
        ...(interruptAvailable ? work.runningTurns.map((turn,index)=>({label:work.runningTurns.length===1 ? '中断当前回复' : `中断本轮回复 ${index+1}`,value:{action:'stop',turnId:turn.turnId,...base}})) : []),
        ...(queueAvailable ? work.queuedInputs.map((item,index)=>({label:`取消排队输入 ${index+1}`,value:{action:'cancel',inputId:item.inputId,...base}})) : [])];
      const text=[interruptAvailable ? (work.runningTurns.length ? '可中断当前回复；已启动的后台任务是否终止尚未确认。' : '当前没有可中断的回复。') : '当前不支持中断回复。',queueAvailable ? (work.queuedInputs.length ? `排队中：${work.queuedInputs.length} 条。` : '当前没有排队输入。') : '当前不支持取消排队输入。',work.canArchive ? '' : '当前不支持归档。',session.capabilities?.handoff?.status === 'available' ? '' : '当前不支持切换控制。'].filter(Boolean).join('\n');
      await reply({title:'会话控制',text,actions}); return {running:work.runningTurns.length,queued:work.queuedInputs.length};
    }
    if (a.action === 'legacy_stop') { const work=await this.service.getWorkState(bound); await guard(); if(work.runningTurns.length!==1) {await reply({title:'中断回复',text:work.runningTurns.length===0 ? '当前没有可中断的回复。' : '当前有多个进行中的回复，请打开会话控制选择本轮。',actions:[{label:'会话控制',value:{action:'panel'}}]});return {status:'rejected',reason:work.runningTurns.length===0?'no_running_turn':'ambiguous_running_turn'};} const op=await this.service.interruptTurn({context:current(),payload:{turnId:work.runningTurns[0]!.turnId}});await reply(operationCard(op));return op; }
    if (a.action === 'project_files') { if(!this.service.listProjectFiles) throw new Error('project browsing unavailable'); const listing=await this.service.listProjectFiles(bound,a.directory,a.showHidden); await reply({title:'项目目录',text:listing.kind==='error' ? listing.message : listing.kind==='file' ? `${listing.entry.name} (${listing.entry.size} B)` : `${listing.path}\n${listing.entries.map(x=>`${x.kind==='dir' ? '[目录]' : '[文件]'} ${x.name}${x.kind==='file' ? ` (${x.size} B)` : ''}`).join('\n')}\n显示 ${listing.entries.length}/${listing.total} 项，隐藏 ${listing.hidden} 项`,actions:[]}); return listing; }
    if (a.action === 'deliver_files') { if(!this.service.selectProjectFiles) throw new Error('file selection unavailable'); const scope=executionScope; await guard(); let files:Awaited<ReturnType<NonNullable<UnifiedService['selectProjectFiles']>>>; try {files=await this.service.selectProjectFiles(bound,a.args);} catch {throw new FileCommandError('文件选择失败：仅支持项目内路径和 *、?、[]、** 模式；凭据、符号链接、超限或不可读文件不会发送。');} if(files.length>20 || files.reduce((n,f)=>n+f.size,0)>20*1024*1024) throw new FileCommandError('文件数量超过 20 个或总大小超过 20 MiB，未发送。'); const contents:Uint8Array[]=[]; for(const f of files) {await guard();contents.push(await this.service.readArtifact(bound,f.artifactId,f.contentVersion));} await guard(); const results=[]; for(let i=0;i<files.length;i++) {const f=files[i]!; const id=`file:v2:${payloadDigest([scope,e.destination,bound,f.artifactId,f.contentVersion])}`; await guard(); if(this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id).changes) {effects.started=true;await this.port.sendFile(e.destination,f.name,contents[i]!,id,guard);this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id);results.push({name:f.name,status:'sent'});} else {const url=await this.port.fileMessageLink?.(e.destination,bound,id) ?? null;await guard();results.push({name:f.name,status:url?'located':'unknown',url});}} await reply({title:'文件发送结果',text:results.map(r=>`${r.name}: ${r.status}`).join('\n'),actions:results.filter(r=>r.url).map(r=>({label:`定位 ${r.name}`,value:{},url:r.url!}))}); return results; }
    if (a.action === 'export') {
      const scope=executionScope;
      const collect=async()=>{ const items:Awaited<ReturnType<UnifiedService['readHistory']>>['items']=[]; let cursor:string|undefined; const seen=new Set<string>(); let bytes=0;
        do { await guard(); let p:Awaited<ReturnType<UnifiedService['readHistory']>>; try {p=await this.service.readHistory(bound,{limit:100,stable:true,...(cursor ? {cursor}:{})});} catch {throw new FileCommandError('历史读取失败或分页期间发生变化，未生成完整导出。');} for(const m of p.items) {bytes+=Buffer.byteLength(JSON.stringify(m)); if(bytes>16*1024*1024 || items.length>=10000) throw new FileCommandError('历史超过导出资源限制，未生成完整导出。'); items.push(m);} cursor=p.nextCursor ?? undefined; if(cursor) {if(seen.has(cursor)||seen.size>=1000) throw new FileCommandError('历史分页无效，未生成完整导出。');seen.add(cursor);} } while(cursor); return items; };
      const first=await collect(), second=await collect(); if(payloadDigest(first)!==payloadDigest(second)) throw new FileCommandError('历史在导出期间发生变化，请重试。');
      const text=first.map(m=>`## ${m.role} (${m.messageId})\n\n${m.blocks.map(b=>b.type==='text' ? b.text : `[文件 ${b.artifactId}]`).join('\n')}\n`).join('\n');
      const content=Buffer.from(text || '# 会话历史\n','utf8'); if(content.length>20*1024*1024) throw new FileCommandError('历史超过导出资源限制，未生成完整导出。');
      const id=`export:v1:${payloadDigest([scope,e.destination,bound,createHash('sha256').update(content).digest('hex')])}`; await guard();
      if(this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id).changes) { effects.started=true; await this.port.sendFile(e.destination,'会话历史.md',content,id,guard); this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id); return {deliveryId:id}; }
      const url=await this.port.fileMessageLink?.(e.destination,bound,id) ?? null; await guard(); await reply(url ? {title:'历史已导出',text:'可打开原消息查看文件。',actions:[{label:'定位原文件消息',value:{},url}]} : {title:'导出状态未知',text:'尚无法定位原消息；不会重复上传。',actions:[]}); return {deliveryId:id,status:url ? 'located' : 'unknown'};
    }
    if (a.action === 'history') { const page = await this.service.readHistory(bound,{limit:20,...(a.cursor ? {cursor:a.cursor}:{})}); await reply(await this.longTextCard(e.destination,bound,'会话历史',page.items.map(m => `${m.role}: ${m.blocks.map(b => b.type === 'text' ? b.text : `[文件 ${b.artifactId}]`).join(' ')}`).join('\n'),page.nextCursor ? [{label:'下一页',value:{action:'history',cursor:page.nextCursor}}] : [],guard,()=>{effects.started=true;})); return page; }
    if (a.action === 'artifacts') { if (a.sessionId && a.sessionId !== bound) throw new Error('session mismatch'); const page = await this.service.listArtifacts(bound, {limit: 100}); await reply({ title: '文件', text: page.items.map(f => `${f.name} (${f.contentVersion})`).join('\n'), actions: page.items.map(f => ({label: f.name, value: {action:'file', artifactId:f.artifactId, contentVersion:f.contentVersion}})) }); return page; }
    if (a.action === 'file') {
      const scope=executionScope;
      const files = await this.service.listArtifacts(bound, {limit: 100});
      const file = files.items.find(f => f.artifactId === a.artifactId && f.contentVersion === a.contentVersion);
      if (!file) throw new Error('artifact not found');
      const id = `file:v2:${payloadDigest([scope,e.destination,bound,file.artifactId,file.contentVersion])}`;
      const current=guard;
      await current();
      if (this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id).changes) {
        const content = await this.service.readArtifact(bound, file.artifactId, file.contentVersion); await current();
        effects.started=true; await this.port.sendFile(e.destination, file.name, content, id, current);
        this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id);
        return {deliveryId:id};
      }
      const url=await this.port.fileMessageLink?.(e.destination,bound,id) ?? null; await current();
      await reply(url ? {title:'文件已发送',text:'可打开原消息查看文件。',actions:[{label:'定位原文件消息',value:{},url}]} : {title:'文件发送状态未知',text:'尚无法定位原消息，请稍后查看；不会重复上传。',actions:[]});
      return {deliveryId:id,status:url ? 'located' : 'unknown',...(url ? {url} : {})};
    }
    if (a.action === 'notifications') { if (session.revision !== a.revision || session.control.generation !== a.controlGeneration) throw new Error('stale revision'); this.db.prepare('INSERT OR REPLACE INTO channel_preferences VALUES (?,?,?,?)').run(e.destination,bound,a.enabled ? 1 : 0,JSON.stringify(a.eventTypes)); const result={status:'completed',enabled:a.enabled,eventTypes:a.eventTypes}; await reply({title:'通知设置',text:a.enabled ? '通知已开启' : '通知已暂停',actions:[]}); return result; }
    if (a.action === 'models' || a.action === 'legacy_model') {
      if (a.action === 'legacy_model' && a.invalid) { await reply({title:'模型',text:'格式：/model <模型> <思考强度>；发送 /model 查看选项。',actions:[]}); return {status:'guidance'}; }
      if (a.action === 'legacy_model' && a.model && a.effort) { const op=await this.service.updateSessionSettings({context:current(),payload:{model:a.model,preferences:{reasoningEffort:a.effort}}}); await reply(operationCard(op)); return op; }
      const page = await this.service.listModels(bound, {limit:100,...(a.action === 'models' && a.cursor ? {cursor:a.cursor}:{})}); const confirmed=await this.service.getConfirmedSettings?.(bound) ?? null;
      const status=confirmed ? `已提交的下一轮设置（请求值）：${confirmed.model ?? '默认'}${confirmed.preferences.reasoningEffort ? ' / '+confirmed.preferences.reasoningEffort : ''}；实际模型与强度以原生运行结果及策略为准。` : '尚无已提交的下一轮设置；实际模型与强度以原生运行结果及策略为准。';
      const actions=page.items.flatMap(m => m.reasoningEfforts?.length ? m.reasoningEfforts.map(effort=>({label:`${m.label} / ${effort}`,value:{action:'settings',model:m.id,preferences:{reasoningEffort:effort},revision:session.revision,controlGeneration:session.control.generation}})) : [{label:m.label,value:{action:'settings',model:m.id,preferences:{},revision:session.revision,controlGeneration:session.control.generation}}]);
      if (page.nextCursor) actions.push({label:'下一页',value:{action:'models',cursor:page.nextCursor} as any});
      await reply({title:'模型',text:status+'\n'+page.items.map(m => `${m.label}${m.reasoningEfforts?.length ? '：'+m.reasoningEfforts.join('、') : ''}`).join('\n'),actions}); return page;
    }
    if (a.action === 'reconcile') { const op = await this.service.getOperation(a.operationId); if (op.targetId !== bound) throw new Error('operation target mismatch'); const result = await this.service.reconcile(a.operationId); await reply(operationCard(result)); return result; }
    let op;
    if (a.action === 'input') op = await this.service.submitInput({context:current(),mode:a.mode,blocks:[{type:'text',text:a.text}]});
    else if (a.action === 'answer_form') { const i = await this.service.getInteraction(a.interactionId); if (i.sessionId !== bound) return {status:'rejected',reason:'invalid_or_expired_form'}; const binding = this.db.prepare('SELECT binding_id FROM channel_bindings WHERE destination=?').get(e.destination) as {binding_id:string}; let decoded; try { decoded=decodeQuestionForm(a,a.fields,i,binding.binding_id,this.accessMode(e.destination) === 'read_only'); } catch { await reply({title:'答复未提交',text:'问题已变化、已处理或答复无效，请刷新后重试。',actions:[]}); return {status:'rejected',reason:'invalid_or_expired_form'}; } op=await this.service.resolveInteraction({context:this.context(e,bound,decoded.revision,session.control.generation),interactionId:decoded.interactionId,expectedConnectionGeneration:decoded.connectionGeneration,answer:decoded.answer,toolInputDigest:null}); }
    else if (a.action === 'answer') { const i = await this.service.getInteraction(a.interactionId); if (i.sessionId !== bound) throw new Error('interaction target mismatch'); op = await this.service.resolveInteraction({context:this.context(e,bound,a.revision,session.control.generation),interactionId:a.interactionId,expectedConnectionGeneration:a.connectionGeneration,answer:a.answer,toolInputDigest:a.toolInputDigest}); }
    else if (a.action === 'attachment') { const stageContext = current(); this.db.prepare("INSERT OR IGNORE INTO channel_pending VALUES (?,?,?,'artifact',?,'pending')").run(stageContext.operationId,e.destination,bound,a.mode); this.db.prepare('INSERT OR IGNORE INTO channel_pending_scope VALUES (?,?)').run(stageContext.operationId,this.bindingScope(e.destination)); this.recordPendingActor(stageContext.operationId,e); const digest = createHash('sha256').update(a.content).digest('hex'); op = await this.service.stageInputArtifact({context:stageContext,payload:{name:a.name,mediaType:a.mediaType,size:a.content.byteLength,contentDigest:digest,content:a.content}}); this.db.prepare("INSERT OR IGNORE INTO channel_pending VALUES (?,?,?,'artifact',?,'pending')").run(op.operationId,e.destination,bound,a.mode); }
    else { const ctx = this.context(e,bound,a.revision,a.controlGeneration); switch (a.action) {
      case 'stop': op = await this.service.interruptTurn({context:ctx,payload:{turnId:a.turnId}}); break;
      case 'control': op = a.release ? await this.service.releaseControl({context:ctx,payload:{owner:a.owner}}) : await this.service.requestControl({context:ctx,payload:{owner:a.owner,strategy:a.strategy}}); break;
      case 'settings': op = await this.service.updateSessionSettings({context:ctx,payload:{model:a.model,preferences:a.preferences}}); break;
      case 'cancel': op = await this.service.cancelQueuedInput({context:ctx,payload:{inputId:a.inputId}}); break;
      case 'archive': op = await this.service.archiveSession({context:ctx,payload:{archived:a.archived}}); break;
    } }
    if ((a.action === 'answer' || a.action === 'answer_form') && op.status !== 'failed' && op.status !== 'unknown') { await guard(); const interaction=await this.service.getInteraction(a.interactionId); await guard(); if(interaction.sessionId!==bound) throw new Error('interaction target mismatch'); await this.renderInteraction(e.destination,bound,interaction,executionScope); return op; }
    if (a.action === 'input' && a.mode !== 'queue' && op.status !== 'queued' && op.status !== 'failed' && op.status !== 'unknown') return op;
    const card = operationCard(op); if (a.action === 'input' && (a.mode === 'queue' || op.status === 'queued')) card.actions.push({label:'查看排队',value:{action:'panel'}}); if (a.action === 'attachment') card.actions.push({label:'查看处理进度',value:{action:'finish',operationId:op.operationId}});
    await reply(card); return op;
  }
  private async longTextCard(destination:string, sessionId:string, title:string, text:string, actions:ChannelCard['actions'] = [], initialGuard?:()=>Promise<void>, onSend?:()=>void): Promise<ChannelCard> {
    await initialGuard?.();
    if ([...text].length <= 3000) return {title,text,actions};
    const scope=this.bindingScope(destination); await this.checkBinding(destination,sessionId);
    const digest=createHash('sha256').update(text,'utf8').digest('hex');
    const id=`long:${createHash('sha256').update(JSON.stringify([destination,sessionId,scope,digest])).digest('hex')}`;
    const guard=async()=>{ await initialGuard?.(); await this.checkBinding(destination,sessionId); if (scope!==this.bindingScope(destination)) throw new Error('binding changed'); };
    const inserted=this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id);
    if (inserted.changes) {
      await this.checkBinding(destination,sessionId); if (scope!==this.bindingScope(destination)) throw new Error('binding changed');
      try { onSend?.(); await this.port.sendFile(destination,`完整内容-${digest.slice(0,12)}.txt`,Buffer.from(text,'utf8'),id,guard); this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id); } catch { /* Delivery may have succeeded; leave unknown and never resend blindly. */ }
    }
    await this.checkBinding(destination,sessionId); if (scope!==this.bindingScope(destination)) throw new Error('binding changed');
    const row=this.db.prepare('SELECT state FROM channel_deliveries WHERE delivery_id=?').get(id) as {state:string};
    const url=row.state === 'sent' ? await this.port.fileMessageLink?.(destination,sessionId,id) ?? null : null;
    await this.checkBinding(destination,sessionId); if (scope!==this.bindingScope(destination)) throw new Error('binding changed');
    return {title,text:`${[...text].slice(0,1000).join('')}\n\n${row.state === 'sent' ? '全文已作为文件发送。' : '全文文件投递结果未知，请核对后再操作。'}`,actions:[...actions,...(url ? [{label:'打开全文',url,value:{action:'open_file'}}] : [])]};
  }
  private async renderInteraction(destination: string, sessionId: string, interaction: import('./contracts.js').Interaction, scope:string): Promise<void> {
    const guard=()=>this.checkBinding(destination,sessionId,scope); await guard();
    const row = this.db.prepare('SELECT revision,message_id,binding_scope FROM channel_interaction_cards WHERE destination=? AND session_id=? AND interaction_id=?').get(destination,sessionId,interaction.interactionId) as {revision:number;message_id:string;binding_scope:string} | undefined;
    if (!row && interaction.status !== 'awaiting_answer' && interaction.status !== 'answer_pending_delivery') return;
    const view=interactionCard(interaction,this.accessMode(destination) === 'read_only');
    if (interaction.kind !== 'approval') { const binding=this.db.prepare('SELECT binding_id FROM channel_bindings WHERE destination=?').get(destination) as {binding_id:string}; view.form=questionForm(interaction,binding.binding_id,this.accessMode(destination) === 'read_only'); }
    const signature=createHash('sha256').update(JSON.stringify(view)).digest('hex');
    const prior=this.db.prepare('SELECT signature FROM channel_interaction_view WHERE destination=? AND session_id=? AND interaction_id=?').get(destination,sessionId,interaction.interactionId) as {signature:string}|undefined;
    if (row && row.revision > interaction.revision) return;
    if (row && row.binding_scope===scope && row.revision === interaction.revision && prior?.signature === signature) return;
    const remember=()=>this.db.prepare('INSERT OR REPLACE INTO channel_interaction_view VALUES (?,?,?,?)').run(destination,sessionId,interaction.interactionId,signature);
    const id = `interaction:${payloadDigest([scope,destination,sessionId,interaction.interactionId,interaction.revision,signature])}`;
    if (row) {
      if (!this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id).changes) { if (await this.port.lookupDelivery?.(id) === 'sent') { await guard(); this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id); this.db.prepare('UPDATE channel_interaction_cards SET revision=?,binding_scope=? WHERE destination=? AND session_id=? AND interaction_id=?').run(interaction.revision,scope,destination,sessionId,interaction.interactionId); remember(); } return; }
      await guard();
      await this.port.update(destination,row.message_id,this.stampCard(destination,view),id,guard); await guard();
      this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id);
      this.db.prepare('UPDATE channel_interaction_cards SET revision=?,binding_scope=? WHERE destination=? AND session_id=? AND interaction_id=?').run(interaction.revision,scope,destination,sessionId,interaction.interactionId); remember();
    } else {
      let messageId = await this.deliver(destination,view,id,guard); await guard();
      if (!messageId) messageId = await this.port.lookupMessageId?.(id) ?? undefined; await guard();
      if (messageId) { this.db.prepare('INSERT OR REPLACE INTO channel_interaction_cards(destination,session_id,interaction_id,revision,message_id,binding_scope) VALUES (?,?,?,?,?,?)').run(destination,sessionId,interaction.interactionId,interaction.revision,messageId,scope); remember(); }
    }
  }
  private async reconcileCards(destination:string, sessionId:string, scope:string): Promise<void> {
    const rows = this.db.prepare('SELECT interaction_id FROM channel_interaction_cards WHERE destination=? AND session_id=?').all(destination,sessionId) as Array<{interaction_id:string}>;
    for (const row of rows) { await this.checkBinding(destination,sessionId,scope); const interaction = await this.service.getInteraction(row.interaction_id); await this.checkBinding(destination,sessionId,scope); if (interaction.sessionId !== sessionId) throw new Error('interaction target mismatch'); await this.renderInteraction(destination,sessionId,interaction,scope); }
  }
  /** Poll using the bound owner's current authorization, never callback-provided identity. */
  async sync(destination: string): Promise<void> {
    const row=this.db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings WHERE destination=?').get(destination) as {session_id:string}|undefined; if(!row) throw new Error('destination is not bound'); const sessionId=row.session_id, scope=JSON.stringify(row);
    const syncGuard=()=>this.checkBinding(destination,sessionId,scope);
    const sendSync=async(d:string,card:ChannelCard,id:string)=>{await syncGuard();const result=await this.deliver(d,card,`sync:${payloadDigest([scope,id])}`,syncGuard);await syncGuard();return result;};
    await syncGuard();
    const preference = this.db.prepare('SELECT enabled,event_types FROM channel_preferences WHERE destination=? AND session_id=?').get(destination,sessionId) as {enabled:number;event_types:string} | undefined;
    await this.reconcileCards(destination,sessionId,scope); await syncGuard();
    if (preference && !preference.enabled) return; // Keep cursor for replay after resume.
    const eventTypes = preference ? JSON.parse(preference.event_types) as string[] : [];
    let expired = false;
    let cursor = (this.db.prepare('SELECT cursor FROM channel_cursors WHERE destination=? AND session_id=? AND binding_scope=?').get(destination,sessionId,scope) as {cursor:string} | undefined)?.cursor;
    if (cursor) {
      const events = await this.service.subscribeEvents(sessionId,cursor,100); await syncGuard();
      if (events.status === 'events') {
        const snapshot=await this.service.getSnapshot(sessionId); await syncGuard();
        for (const i of snapshot.value.interactions) await this.renderInteraction(destination,sessionId,i,scope);
        let retryCount=0; let firstRetry='';
        const visible=events.events.filter(event=>!eventTypes.length || eventTypes.includes(event.type));
        const failedTurnIds=new Set(visible.filter(event=>event.type==='operation.failed' && event.data && typeof event.data==='object').map(event=>(event.data as {result?:{kind?:string;turnId?:string}}).result).filter((result):result is {kind:string;turnId:string}=>result?.kind==='turn' && typeof result.turnId==='string').map(result=>result.turnId));
        const hasTurnFailure=visible.some(event=>event.type==='turn.updated' && (event.data as {status?:string}|null)?.status==='failed');
        for (const event of events.events) {
          await syncGuard();
          if (eventTypes.length && !eventTypes.includes(event.type)) continue;
          const message=snapshot.value.messages.find(m=>m.messageId===event.objectId && m.final && m.role==='assistant');
          if (message) {
            await sendSync(destination,await this.longTextCard(destination,sessionId,'回复',message.blocks.map(b=>b.type==='text' ? b.text : `[文件 ${b.artifactId}]`).join('\n'),[],syncGuard),`message:${destination}:${sessionId}:${message.messageId}:${message.revision}`);
            this.db.prepare('INSERT OR REPLACE INTO channel_known_messages VALUES (?,?,?,?)').run(destination,sessionId,message.messageId,message.revision); continue;
          }
          const data=event.data && typeof event.data==='object' ? event.data as Record<string,unknown> : {};
          if (event.type === 'provider.api_retry') { retryCount++; firstRetry ||= event.eventId; continue; }
          if (event.type === 'provider.usage_limit' && (data.status === 'rejected' || data.status === 'allowed_warning')) { await sendSync(destination,{title:'额度提示',text:data.status === 'rejected' ? '模型服务报告额度不足或受到限额，请稍后恢复后再使用。' : '模型服务提示额度接近限制，当前仍可继续。',actions:[]},`event:${destination}:${sessionId}:${event.eventId}`); continue; }
          if (event.type === 'provider.usage_available' && data.status === 'allowed') { await sendSync(destination,{title:'额度提示',text:'模型服务报告本次额度检查结果：可用。',actions:[]},`event:${destination}:${sessionId}:${event.eventId}`); continue; }
          const status=typeof data.status==='string' ? data.status : '';
          // Pending interaction cards above already present the question or approval.
          if (event.type==='interaction.created') continue;
          if (event.type==='operation.completed' && (data.action==='submitInput' || data.action==='resolveInteraction')) continue;
          if (event.type==='turn.updated' && status==='completed') { const turnId=typeof data.turnId==='string' ? data.turnId : event.objectId; if(snapshot.value.messages.some(m=>m.turnId===turnId && m.role==='assistant' && m.final)) continue; }
          if (event.type==='turn.updated' && status==='failed' && failedTurnIds.has(typeof data.turnId==='string' ? data.turnId : event.objectId)) continue;
          if (event.type==='session.updated' && status==='failed' && (hasTurnFailure || failedTurnIds.size>0)) continue;
          const waitingSession=event.type==='session.updated' && ['waiting_question','waiting_approval'].includes(status);
          if (waitingSession && (snapshot.value.session.status!==status || snapshot.value.interactions.some(i=>['awaiting_answer','answer_pending_delivery'].includes(i.status) && (status==='waiting_approval' ? i.kind==='approval' : i.kind!=='approval')))) continue;
          const critical=event.type==='operation.failed' || event.type==='operation.unknown' || event.type==='operation.completed' || (event.type==='turn.updated' && ['failed','completed','interrupted'].includes(status)) || (event.type==='session.updated' && ['failed','waiting_question','waiting_approval'].includes(status));
          if (critical) {
            const statusText:Record<string,string>={failed:'运行失败',completed:'运行已完成',interrupted:'本轮回复已中断；后台任务是否终止尚未确认',waiting_question:'等待回答',waiting_approval:'等待审批'};
            const waitingHint=this.accessMode(destination)==='read_only' && snapshot.value.session.native.provider==='claude' && ['waiting_question','waiting_approval'].includes(status) ? '；外部终端会话若仅同步等待状态，请回原终端处理。' : '';
            const card=event.type.startsWith('operation.') && typeof data.action==='string' && typeof data.status==='string' ? operationCard(data as unknown as import('./contracts.js').Operation) : {title:'会话更新',text:(statusText[status] ?? '会话状态已更新')+waitingHint,actions:[]};
            await sendSync(destination,card,`event:${destination}:${sessionId}:${event.eventId}`);
          }
        }
        if (retryCount) { await syncGuard(); await sendSync(destination,{title:'连接重试',text:`模型服务正在重试（本次收到 ${retryCount} 次重试通知）。`,actions:[]},`retry:${destination}:${sessionId}:${firstRetry}:${events.cursor}`); }
        cursor = events.cursor;
      } else { cursor = undefined; expired = true; }
    }
    if (!cursor) {
      const snapshot = await this.service.getSnapshot(sessionId); await syncGuard();
      // A fresh binding records existing history without sending it. An expired
      // cursor compares a consistent snapshot with that baseline and emits unseen finals.
      for (const m of snapshot.value.messages) {
        const known = this.db.prepare('SELECT revision FROM channel_known_messages WHERE destination=? AND session_id=? AND message_id=?').get(destination,sessionId,m.messageId) as {revision:number} | undefined;
        if (expired && m.role === 'assistant' && m.final && (!known || known.revision < m.revision)) {
          await syncGuard();
          await sendSync(destination,await this.longTextCard(destination,sessionId,'回复',m.blocks.map(b=>b.type === 'text' ? b.text : `[文件 ${b.artifactId}]`).join('\n'),[],syncGuard),`message:${destination}:${sessionId}:${m.messageId}:${m.revision}`);
        }
        this.db.prepare('INSERT OR REPLACE INTO channel_known_messages VALUES (?,?,?,?)').run(destination,sessionId,m.messageId,m.revision);
      }
      for (const i of snapshot.value.interactions) await this.renderInteraction(destination,sessionId,i,scope);
      cursor = snapshot.cursor;
    }
    await syncGuard();
    this.db.prepare('INSERT OR REPLACE INTO channel_cursors(destination,session_id,cursor,binding_scope) VALUES (?,?,?,?)').run(destination,sessionId,cursor,scope);
  }
}
