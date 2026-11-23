import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { relative, isAbsolute, sep } from 'node:path';
import type { UnifiedService } from './adapter.js';
import type { Answer, Identity, Provider, WriteContext, Session } from './contracts.js';
import { payloadDigest } from './contracts.js';
import { contractError } from './errors.js';
import { questionForm, decodeQuestionForm } from './feishu-question-forms.js';
import { sessionListCard } from './session-list-card.js';
import { interactionCard, operationCard, providerDisplayLabel, sessionCard, type ChannelCard } from './feishu-cards.js';

/** Identity and destination must come from an authenticated, verified transport envelope. */
export interface TrustedEnvelope { eventId: string; destination: string; identity: Identity; cardMessageId?: string }
export interface FeishuPort {
  isTopicDestination?(destination:string): boolean;
  chatDestination?(destination:string): string | null;
  createTopic?(destination:string, sessionId:string, card:ChannelCard, deliveryId:string, guard?:()=>Promise<void>): Promise<string>;
  reassignTopic?(destination:string,sessionId:string):void;
  send(destination: string, card: ChannelCard, deliveryId: string, guard?:()=>Promise<void>): Promise<string | void>;
  update(destination: string, messageId: string, card: ChannelCard, deliveryId: string, guard?:()=>Promise<void>): Promise<void>;
  sendFile(destination: string, name: string, content: Uint8Array, deliveryId: string, guard?: () => Promise<void>): Promise<void>;
  /** Query by transport idempotency key; unknown is never retried automatically. */
  lookupDelivery?(deliveryId: string): Promise<'sent' | 'not_sent' | 'unknown'>;
  lookupMessageId?(deliveryId: string): Promise<string | null>;
  fileMessageLink?(destination:string,sessionId:string,deliveryId:string): Promise<string | null>;
  topicLinkForSession?(destination:string,sessionId:string):Promise<string | null>;
}
class BindingManagementDenied extends Error {}
class BindingExpired extends Error {}
class ReadAuthorizationRevoked extends Error {}
class FileCommandError extends Error {}
function formatHumanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export type AuthorizeBindingAdmin = (identity: Identity, destination: string, sessionId: string) => Promise<boolean>;
export type Authorize = (identity: Identity, destination: string, sessionId: string | null) => Promise<boolean>;
export type ChannelAction = (
 | { action: 'list'; search?: string; cursor?: string; provider?: Provider | 'all' }
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
 | { action: 'artifacts'; sessionId?: string; cursor?: string }
 | { action: 'file'; artifactId: string; contentVersion: string }
 | { action: 'resource_rejected'; reason:'unsupported'|'size'|'encoding' }
 | { action: 'attachment'; name: string; mediaType: string; content: Uint8Array; mode: 'new' | 'queue' | 'steer' }
 | { action: 'models'; cursor?: string }
 | { action: 'legacy_model'; model?: string; effort?: string; invalid?: boolean }
 | { action: 'help' }
 | { action: 'new_help' }
 | { action: 'settings'; model: string | null; preferences: Record<string, string>; revision: number; controlGeneration: number }
 | { action: 'notifications'; enabled: boolean; eventTypes: string[]; revision: number; controlGeneration: number }
 | { action:'notice_settings'; field:'paused'|'completed'|'waiting'|'failed'|'legacy'; value:boolean; settingsRevision:number; revision:number; controlGeneration:number }
 | { action: 'cancel'; inputId: string; revision: number; controlGeneration: number }
 | { action: 'archive'; archived: boolean; revision: number; controlGeneration: number }
 | { action: 'unbind' }
 | { action: 'reconcile'; operationId: string }
 | { action: 'finish'; operationId: string }
 | { action: 'pending' }
 | { action: 'inspect_unknown'; operationId:string; cursor?:string; nativeId?:string }
 | { action: 'health' }) & { bindingId?: string };

/** Standalone channel database. Never opens core's tables. */
export class FeishuChannel {
  private readonly db: DatabaseSync;
  private migrationLocked=false;
  private readonly observedHealth=new Set<string>();
  private readonly healthFaults=new Set<string>(); private readonly diagnosticFaults=new Set<string>();
  private readonly destinationLocks = new Map<string, Promise<void>>();
  constructor(private readonly service: UnifiedService, private readonly port: FeishuPort, private readonly authorize: Authorize, dbPath: string, private readonly authorizeBindingAdmin?: AuthorizeBindingAdmin, private readonly requireReadonlyHydration=false, private readonly channelOptions: { defaultCreateProject?: string } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS channel_bindings (destination TEXT PRIMARY KEY, session_id TEXT NOT NULL, binding_id TEXT NOT NULL, owner_source TEXT NOT NULL, owner_subject TEXT NOT NULL, revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS channel_inbox_scope (event_id TEXT PRIMARY KEY, scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_pending_scope (operation_id TEXT PRIMARY KEY, scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_inbox (event_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_receipts (event_id TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT); CREATE TABLE IF NOT EXISTS channel_cursors (destination TEXT PRIMARY KEY, session_id TEXT NOT NULL, cursor TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_interaction_cards (destination TEXT NOT NULL, session_id TEXT NOT NULL, interaction_id TEXT NOT NULL, revision INTEGER NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(destination,session_id,interaction_id)); CREATE TABLE IF NOT EXISTS channel_known_messages (destination TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(destination,session_id,message_id)); CREATE TABLE IF NOT EXISTS channel_preferences (destination TEXT PRIMARY KEY, session_id TEXT NOT NULL, enabled INTEGER NOT NULL, event_types TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_pending (operation_id TEXT PRIMARY KEY, destination TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL, mode TEXT, state TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_delivery_diagnostics (delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL, platform_code INTEGER)');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_health_facts (component TEXT PRIMARY KEY, observed_at TEXT NOT NULL, success_at TEXT, failure_at TEXT, failure_reason TEXT, status TEXT NOT NULL, reason TEXT)');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_interaction_view (destination TEXT NOT NULL,session_id TEXT NOT NULL,interaction_id TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(destination,session_id,interaction_id))');
    this.db.exec("CREATE TABLE IF NOT EXISTS channel_candidate_inbox_v1 (event_id TEXT PRIMARY KEY,envelope TEXT NOT NULL,action TEXT NOT NULL,scope TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT)");
    this.db.exec("CREATE TABLE IF NOT EXISTS channel_steer_inbox_v1 (event_id TEXT PRIMARY KEY,envelope TEXT NOT NULL,action TEXT NOT NULL,scope TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,connection_generation INTEGER NOT NULL,control_generation INTEGER NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT)");
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_pending_actors (operation_id TEXT PRIMARY KEY, envelope TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_notice_operation_cards (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, operation_id TEXT NOT NULL, message_id TEXT, PRIMARY KEY(destination,session_id,binding_scope,operation_id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_notice_operation_states (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(destination,session_id,binding_scope,operation_id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_completion_pending (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(destination,session_id,binding_scope,turn_id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_notice_markers (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, category TEXT NOT NULL, object_key TEXT NOT NULL, PRIMARY KEY(destination,session_id,binding_scope,category,object_key))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_notice_settings (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, paused INTEGER NOT NULL, completed INTEGER NOT NULL, waiting INTEGER NOT NULL, failed INTEGER NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(destination,session_id,binding_scope))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_stream_cards (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, message_id TEXT NOT NULL, card_id TEXT, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, final INTEGER NOT NULL, current_message TEXT NOT NULL, latest_sequence INTEGER NOT NULL, PRIMARY KEY(destination,session_id,binding_scope,message_id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_private_titles (native_key TEXT PRIMARY KEY)');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_uncertain (destination TEXT NOT NULL, native_key TEXT NOT NULL, PRIMARY KEY(destination,native_key))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_watermarks (destination TEXT PRIMARY KEY, enabled INTEGER NOT NULL, watermark INTEGER NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_scope_watermarks (destination TEXT NOT NULL, source TEXT NOT NULL, root TEXT NOT NULL, watermark INTEGER NOT NULL, PRIMARY KEY(destination,source,root))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_claude_scope_watermarks (destination TEXT NOT NULL, source TEXT NOT NULL, root TEXT NOT NULL, watermark INTEGER NOT NULL, PRIMARY KEY(destination,source,root))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_agy_scope_watermarks (destination TEXT NOT NULL, source TEXT NOT NULL, root TEXT NOT NULL, watermark INTEGER NOT NULL, PRIMARY KEY(destination,source,root))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_baselines (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot TEXT NOT NULL, destination TEXT, binding_scope TEXT)');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_history_baselines (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, PRIMARY KEY(destination,session_id,binding_scope))');
    const columns = this.db.prepare('PRAGMA table_info(channel_bindings)').all() as Array<{name:string}>;
    if (!columns.some(c => c.name === 'access_mode')) this.db.exec("ALTER TABLE channel_bindings ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'read_only'");
    for(const table of ['channel_interaction_cards','channel_cursors']) {const fields=this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>;if(!fields.some(c=>c.name==='binding_scope')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN binding_scope TEXT NOT NULL DEFAULT ''`);}
  }
  recordDeliveryDiagnostic(id:string,kind:'api_rejected'|'guard_rejected'|'unknown',code:number|null):void {try {this.db.prepare('INSERT OR REPLACE INTO channel_delivery_diagnostics VALUES (?,?,?)').run(id,kind,code);this.diagnosticFaults.delete('feishu_delivery');} catch(error) {this.diagnosticFaults.add('feishu_delivery');throw error;}}
  unconfirmedDeliveryCount():number {const row=this.db.prepare("SELECT COUNT(*) AS count FROM channel_deliveries d LEFT JOIN channel_delivery_diagnostics x ON x.delivery_id=d.delivery_id WHERE d.state='unknown' AND (x.kind IS NULL OR x.kind='unknown')").get() as {count:number};return Number(row.count);}
  invalidateHealth(component:string,reason:string):void {try {this.db.prepare("UPDATE channel_health_facts SET status='unverified',reason=? WHERE component=?").run(reason,component);} catch(error) {this.healthFaults.add(component);throw error;}}
  recordHealth(component:string,status:'healthy'|'degraded'|'unverified',reason:string|null=null):void {const now=new Date().toISOString();try {this.db.prepare("INSERT INTO channel_health_facts(component,observed_at,success_at,failure_at,failure_reason,status,reason) VALUES (?,?,?,?,?,?,?) ON CONFLICT(component) DO UPDATE SET observed_at=excluded.observed_at,success_at=COALESCE(excluded.success_at,success_at),failure_at=COALESCE(excluded.failure_at,failure_at),failure_reason=COALESCE(excluded.failure_reason,failure_reason),status=excluded.status,reason=excluded.reason").run(component,now,status==='healthy'?now:null,status==='degraded'?now:null,status==='degraded'?reason:null,status,reason);this.observedHealth.add(component);this.healthFaults.delete(component);} catch(error) {this.healthFaults.add(component);throw error;}}
  /** Persist a sanitized retry at its observed time without reverting newer current health. */
  recordRetryHealth(reason:string,observedAt:string):void {
    const value=Date.parse(observedAt);if(!Number.isFinite(value)||value<0||value>Date.now()+5000)throw new Error('invalid retry observation time');const when=new Date(value).toISOString(),component='claude_run';
    try {const prior=this.db.prepare('SELECT observed_at FROM channel_health_facts WHERE component=?').get(component) as {observed_at:string}|undefined;
      if(prior && prior.observed_at>when){this.db.prepare('UPDATE channel_health_facts SET failure_at=?,failure_reason=? WHERE component=? AND (failure_at IS NULL OR failure_at<?)').run(when,reason,component,when);return;}
      this.db.prepare("INSERT INTO channel_health_facts(component,observed_at,success_at,failure_at,failure_reason,status,reason) VALUES (?,?,NULL,?,?,'degraded',?) ON CONFLICT(component) DO UPDATE SET observed_at=excluded.observed_at,failure_at=excluded.failure_at,failure_reason=excluded.failure_reason,status='degraded',reason=excluded.reason").run(component,when,when,reason,reason);this.observedHealth.add(component);this.healthFaults.delete(component);
    } catch(error){this.healthFaults.add(component);throw error;}
  }
  healthFact(component:string):{status:'healthy'|'degraded'|'unverified';reason:string|null;lastObservedAt:string|null;lastSuccessAt:string|null;lastFailureAt:string|null;lastFailureReason:string|null} {const r=this.db.prepare('SELECT status,reason,observed_at,success_at,failure_at,failure_reason FROM channel_health_facts WHERE component=?').get(component) as {status:'healthy'|'degraded'|'unverified';reason:string|null;observed_at:string;success_at:string|null;failure_at:string|null;failure_reason:string|null}|undefined;const fault=this.healthFaults.has(component)||this.diagnosticFaults.has(component);return r?{status:fault?'degraded':this.observedHealth.has(component)?r.status:'unverified',reason:fault?'健康诊断记录失败':this.observedHealth.has(component)?r.reason:'当前进程尚未重新观测',lastObservedAt:r.observed_at,lastSuccessAt:r.success_at,lastFailureAt:r.failure_at,lastFailureReason:r.failure_reason}:{status:fault?'degraded':'unverified',reason:fault?'健康诊断记录失败':'尚无可验证观测',lastObservedAt:null,lastSuccessAt:null,lastFailureAt:null,lastFailureReason:null};}
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
      const tables = ['channel_inbox_scope','channel_pending_scope','channel_inbox','channel_receipts','channel_cursors','channel_deliveries','channel_interaction_cards','channel_interaction_view','channel_known_messages','channel_history_baselines','channel_preferences','channel_pending'];
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
  listInteractionCards(): Array<{destination:string;sessionId:string;interactionId:string;revision:number;messageId:string}> {
    return this.db.prepare('SELECT destination,session_id AS sessionId,interaction_id AS interactionId,revision,message_id AS messageId FROM channel_interaction_cards').all() as Array<{destination:string;sessionId:string;interactionId:string;revision:number;messageId:string}>;
  }
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
  /** A successful initial history read is baselined once per binding epoch. */
  async isReadonlyBaselineAuthorized(destination:string,sessionId:string):Promise<boolean> {const scope=this.bindingScope(destination);try {await this.checkBinding(destination,sessionId,scope);return this.accessMode(destination)==='read_only' && scope===this.bindingScope(destination);} catch {return false;}}
  readonlyHydrated(destination:string, sessionId:string):boolean { const scope=this.bindingScope(destination);return !!this.db.prepare('SELECT 1 FROM channel_history_baselines WHERE destination=? AND session_id=? AND binding_scope=?').get(destination,sessionId,scope); }
  markAutoPrivateTitle(native:Session['native']):void {this.db.prepare('INSERT OR IGNORE INTO channel_auto_private_titles VALUES (?)').run(payloadDigest(native));}
  isAutoPrivateTitle(native:Session['native']):boolean {return !!this.db.prepare('SELECT 1 FROM channel_auto_private_titles WHERE native_key=?').get(payloadDigest(native));}
  markAutoUncertain(destination:string,native:Session['native']):void {this.db.prepare('INSERT OR IGNORE INTO channel_auto_uncertain VALUES (?,?)').run(destination,payloadDigest(native));}
  isAutoUncertain(destination:string,native:Session['native']):boolean {return !!this.db.prepare('SELECT 1 FROM channel_auto_uncertain WHERE destination=? AND native_key=?').get(destination,payloadDigest(native));}
  configureAutoScopeWatermarks(destination:string|null,source:string,roots:string[],nowSeconds:number,provider:Provider='codex'):Array<{root:string;watermark:number}> {
    if(!Number.isSafeInteger(nowSeconds) || nowSeconds<0 || !source || roots.some(root=>!isAbsolute(root))) throw new Error('invalid auto scope');
    const inside=(child:string,root:string)=>{const rel=relative(root,child);return rel==='' || (!isAbsolute(rel) && rel!=='..' && !rel.startsWith(`..${sep}`));};
    const table=provider==='codex'?'channel_auto_scope_watermarks':provider==='agy'?'channel_auto_agy_scope_watermarks':'channel_auto_claude_scope_watermarks';
    this.db.exec('BEGIN IMMEDIATE');try {
      if(!destination){this.db.prepare(`DELETE FROM ${table}`).run();this.db.exec('COMMIT');return [];}
      const previous=this.db.prepare(`SELECT root,watermark FROM ${table} WHERE destination=? AND source=?`).all(destination,source) as Array<{root:string;watermark:number}>;
      const retained=new Map<string,number>();
      const put=(root:string,watermark:number)=>retained.set(root,Math.min(retained.get(root) ?? watermark,watermark));
      for(const old of previous) for(const root of roots) {if(inside(old.root,root)) put(old.root,old.watermark);else if(inside(root,old.root)) put(root,old.watermark);}
      for(const root of roots) put(root,nowSeconds);
      this.db.prepare(`DELETE FROM ${table}`).run();
      const insert=this.db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?)`);
      for(const [root,watermark] of retained) insert.run(destination,source,root,watermark);
      this.db.exec('COMMIT');return [...retained].map(([root,watermark])=>({root,watermark}));
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  configureAutoWatermark(destination:string|null,nowSeconds:number):number|null {if(!Number.isSafeInteger(nowSeconds) || nowSeconds<0) throw new Error('invalid watermark');this.db.exec('BEGIN IMMEDIATE');try {if(!destination){this.db.prepare('UPDATE channel_auto_watermarks SET enabled=0').run();this.db.exec('COMMIT');return null;}this.db.prepare('UPDATE channel_auto_watermarks SET enabled=0 WHERE destination<>?').run(destination);const row=this.db.prepare('SELECT enabled,watermark FROM channel_auto_watermarks WHERE destination=?').get(destination) as {enabled:number;watermark:number}|undefined;const watermark=row?.enabled ? row.watermark : nowSeconds;this.db.prepare('INSERT INTO channel_auto_watermarks VALUES (?,1,?) ON CONFLICT(destination) DO UPDATE SET enabled=1,watermark=excluded.watermark').run(destination,watermark);this.db.exec('COMMIT');return watermark;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  async prepareAutoBaseline(eventId:string,sessionId:string,provenNew=false,oldMessageIds?:string[],startingCursor?:string):Promise<void> {
    if(this.db.prepare('SELECT 1 FROM channel_auto_baselines WHERE event_id=?').get(eventId)) return;
    const snapshot=await this.service.getSnapshot(sessionId);
    const initial=startingCursor ?? (provenNew || oldMessageIds ? await this.service.initialCursor?.(sessionId) : undefined); if((provenNew || oldMessageIds) && !initial) throw new Error('initial cursor unavailable'); const old=oldMessageIds ? new Set(oldMessageIds) : null; const baseline=provenNew || old ? {cursor:initial!,messages:old ? snapshot.value.messages.filter(m=>old.has(m.messageId)).map(m=>({messageId:m.messageId,revision:m.revision})) : []} : {cursor:snapshot.cursor,messages:snapshot.value.messages.map(m=>({messageId:m.messageId,revision:m.revision}))};
    this.db.prepare('INSERT OR IGNORE INTO channel_auto_baselines(event_id,session_id,snapshot) VALUES (?,?,?)').run(eventId,sessionId,JSON.stringify(baseline));
  }
  private autoBaselineOffset=0;
  hasPendingAutoBaseline(destination:string,sessionId:string):boolean {return !!this.db.prepare('SELECT 1 FROM channel_auto_baselines WHERE destination=? AND session_id=? AND binding_scope=?').get(destination,sessionId,this.bindingScope(destination));}
  async applyPendingAutoBaselines():Promise<void> {
    let rows=this.db.prepare('SELECT rowid AS row_id,event_id FROM channel_auto_baselines WHERE destination IS NOT NULL AND rowid>? ORDER BY rowid LIMIT 32').all(this.autoBaselineOffset) as Array<{row_id:number;event_id:string}>;
    if(!rows.length && this.autoBaselineOffset) {this.autoBaselineOffset=0;rows=this.db.prepare('SELECT rowid AS row_id,event_id FROM channel_auto_baselines WHERE destination IS NOT NULL AND rowid>? ORDER BY rowid LIMIT 32').all(0) as Array<{row_id:number;event_id:string}>;}
    if(rows.length) this.autoBaselineOffset=rows[rows.length-1]!.row_id; let failed=false;
    for(const row of rows) try {await this.applyAutoBaseline(row.event_id);} catch {failed=true;}
    if(failed) throw new Error('auto baseline unavailable');
  }
  async applyAutoBaseline(eventId:string):Promise<void> {
    const row=this.db.prepare('SELECT session_id,snapshot,destination,binding_scope FROM channel_auto_baselines WHERE event_id=?').get(eventId) as {session_id:string;snapshot:string;destination:string|null;binding_scope:string|null}|undefined;
    if(!row?.destination || !row.binding_scope) return;
    if(row.binding_scope!==this.bindingScope(row.destination)) {this.db.prepare('DELETE FROM channel_auto_baselines WHERE event_id=?').run(eventId);return;}
    await this.baselineReadonlyHistory(row.destination,row.session_id,JSON.parse(row.snapshot));
    this.db.prepare('DELETE FROM channel_auto_baselines WHERE event_id=?').run(eventId);
  }
  async baselineReadonlyHistory(destination:string,sessionId:string,prepared?:{cursor:string;messages:Array<{messageId:string;revision:number}>}):Promise<void> {
    const scope=this.bindingScope(destination); await this.checkBinding(destination,sessionId,scope); if(this.accessMode(destination)!=='read_only') throw new Error('binding changed'); if(this.readonlyHydrated(destination,sessionId)) return;
    const snapshot=prepared ?? await this.service.getSnapshot(sessionId).then(s=>({cursor:s.cursor,messages:s.value.messages})); await this.checkBinding(destination,sessionId,scope); if(!snapshot || this.accessMode(destination)!=='read_only') throw new Error('binding changed');
    this.db.exec('BEGIN IMMEDIATE'); try {if(scope!==this.bindingScope(destination)) throw new Error('binding changed'); const put=this.db.prepare('INSERT INTO channel_known_messages(destination,session_id,message_id,revision) VALUES (?,?,?,?) ON CONFLICT(destination,session_id,message_id) DO UPDATE SET revision=MAX(revision,excluded.revision)'); for(const m of snapshot.messages) put.run(destination,sessionId,m.messageId,m.revision); this.db.prepare('INSERT INTO channel_cursors(destination,session_id,cursor,binding_scope) VALUES (?,?,?,?) ON CONFLICT(destination) DO UPDATE SET session_id=excluded.session_id,cursor=excluded.cursor,binding_scope=excluded.binding_scope WHERE channel_cursors.session_id<>excluded.session_id OR channel_cursors.binding_scope<>excluded.binding_scope').run(destination,sessionId,snapshot.cursor,scope); this.db.prepare('INSERT OR IGNORE INTO channel_history_baselines VALUES (?,?,?)').run(destination,sessionId,scope);this.db.exec('COMMIT');} catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  private binding(destination: string): string | null { return (this.db.prepare('SELECT session_id FROM channel_bindings WHERE destination=?').get(destination) as {session_id: string} | undefined)?.session_id ?? null; }
  private isCurrentOwnedScope(scope:{destination:string;bindingScope:string;ownerSource:string;ownerSubject:string},sessionId:string):boolean {const owner=this.db.prepare('SELECT owner_source,owner_subject FROM channel_bindings WHERE destination=?').get(scope.destination) as {owner_source:string;owner_subject:string}|undefined;return owner?.owner_source===scope.ownerSource && owner.owner_subject===scope.ownerSubject && this.binding(scope.destination)===sessionId && this.bindingScope(scope.destination)===scope.bindingScope;}
  isCurrentSteerScope(scope:{destination:string;bindingScope:string;ownerSource:string;ownerSubject:string},sessionId:string):boolean {return this.isCurrentOwnedScope(scope,sessionId) && this.accessMode(scope.destination)==='interactive';}
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
    if (!['bind','unbind','archive','control','settings','notifications','notice_settings','create','attach','upgrade','finish'].includes(action.action)) return;
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
    if (expectedScope !== undefined && (!['attachment','resource_rejected'].includes(a.action) || capturedScope !== expectedScope)) throw new Error('binding changed');
    if (a.bindingId) { const row = this.db.prepare('SELECT binding_id FROM channel_bindings WHERE destination=?').get(e.destination) as {binding_id:string} | undefined; if (!row || row.binding_id !== a.bindingId) throw new Error('binding changed'); }
    const bound = this.binding(e.destination);
    // Capture at ingress, before any asynchronous authorization or queue wait can
    // allow the current turn to change. The core performs its own authorization.
    const steerCapture=a.action==='input' && a.mode==='steer' && bound && this.service.captureSteer ? this.service.captureSteer(e.identity,bound).then(value=>({value}),error=>({error})) : null;
    if (e.eventId.startsWith('card:') && a.action === 'bind' && bound && !a.bindingId) throw new Error('binding changed');
    const target = a.action === 'bind' ? a.sessionId : bound;
    if (!await this.authorize(e.identity,e.destination,target)) throw new Error('unauthorized');
    await this.checkManager(e,a);
    if(a.action==='input' && a.mode==='steer') {
      const action=JSON.stringify(a),envelope=JSON.stringify(e),digest=payloadDigest({destination:e.destination,identity:e.identity,action:JSON.parse(action)});
      const prior=this.db.prepare('SELECT digest,state FROM channel_steer_inbox_v1 WHERE event_id=?').get(e.eventId) as {digest:string;state:string}|undefined;
      if(prior){if(prior.digest!==digest)throw Error('idempotency conflict');return {eventId:e.eventId,state:prior.state};}
      if(!bound)throw Error('steer unavailable');
      let capture:{turnId:string;connectionGeneration:number;controlGeneration:number}|undefined, rejection:string|null=null;
      if(this.accessMode(e.destination)!=='interactive' || !steerCapture)rejection='unsupported';else {const captured=await steerCapture; if('error' in captured) {const error=captured.error,detail=error && typeof error==='object' && 'detail' in error ? (error as {detail?:{code?:string}}).detail:undefined;if(!detail?.code || !['busy','unsupported','control_conflict','temporarily_unavailable','unauthorized'].includes(detail.code))throw error;rejection=detail.code;} else capture=captured.value;}
      this.db.exec('BEGIN IMMEDIATE');try {
        if(this.db.prepare('SELECT 1 FROM channel_inbox WHERE event_id=? UNION ALL SELECT 1 FROM channel_candidate_inbox_v1 WHERE event_id=?').get(e.eventId,e.eventId))throw Error('idempotency conflict');
        const old=this.db.prepare('SELECT digest,state FROM channel_steer_inbox_v1 WHERE event_id=?').get(e.eventId) as {digest:string;state:string}|undefined;
        if(old){if(old.digest!==digest)throw Error('idempotency conflict');this.db.exec('COMMIT');return {eventId:e.eventId,state:old.state};}
        if(!this.isCurrentOwnedScope({destination:e.destination,bindingScope:capturedScope,ownerSource:e.identity.source,ownerSubject:e.identity.subject},bound))throw Error('binding changed');
        this.db.prepare("INSERT INTO channel_steer_inbox_v1 VALUES(?,?,?,?,?,?,?,?,?,'received',?)").run(e.eventId,envelope,action,capturedScope,bound,capture?.turnId ?? '',capture?.connectionGeneration ?? 0,capture?.controlGeneration ?? 0,digest,rejection?JSON.stringify({status:'rejected',reason:rejection}):null);
        this.db.exec('COMMIT');return {eventId:e.eventId,state:'received'};
      } catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    if(a.action==='inspect_unknown'){const action=JSON.stringify(a),envelope=JSON.stringify(e),digest=payloadDigest({destination:e.destination,identity:e.identity,action:JSON.parse(action)});this.db.exec('BEGIN IMMEDIATE');try{if(this.db.prepare('SELECT 1 FROM channel_inbox WHERE event_id=? UNION ALL SELECT 1 FROM channel_steer_inbox_v1 WHERE event_id=?').get(e.eventId,e.eventId))throw Error('idempotency conflict');const old=this.db.prepare('SELECT digest,state FROM channel_candidate_inbox_v1 WHERE event_id=?').get(e.eventId) as {digest:string;state:string}|undefined;if(old){if(old.digest!==digest)throw Error('idempotency conflict');this.db.exec('COMMIT');return {eventId:e.eventId,state:old.state};}if(this.actionScope(a,e.destination)!==capturedScope)throw Error('binding changed');this.db.prepare("INSERT INTO channel_candidate_inbox_v1 VALUES (?,?,?,?,?,'received',NULL)").run(e.eventId,envelope,action,capturedScope,digest);this.db.exec('COMMIT');return {eventId:e.eventId,state:'received'};}catch(error){this.db.exec('ROLLBACK');throw error;}}
    const serializedAction = JSON.stringify(a.action === 'attachment' ? {...a,content:Array.from(a.content)} : a);
    const digest = payloadDigest({destination:e.destination,identity:e.identity,action:JSON.parse(serializedAction)});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT digest,state FROM channel_receipts WHERE event_id=?').get(e.eventId) as {digest:string;state:string} | undefined;
      if(this.db.prepare('SELECT 1 FROM channel_candidate_inbox_v1 WHERE event_id=? UNION ALL SELECT 1 FROM channel_steer_inbox_v1 WHERE event_id=?').get(e.eventId,e.eventId))throw Error('idempotency conflict');
      if (old) { if (old.digest !== digest) throw new Error('idempotency conflict'); this.db.exec('COMMIT'); return {eventId:e.eventId,state:old.state}; }
      this.db.prepare("INSERT INTO channel_receipts VALUES (?,?,'received',NULL)").run(e.eventId,digest);
      if (this.actionScope(a,e.destination) !== capturedScope) throw new Error('binding changed during intake');
      this.db.prepare("INSERT INTO channel_inbox VALUES (?,?,?,'received')").run(e.eventId,JSON.stringify(e),serializedAction);
      this.db.prepare('INSERT INTO channel_inbox_scope VALUES (?,?)').run(e.eventId,capturedScope);
      this.db.exec('COMMIT'); if(e.eventId.startsWith('card:')) {try {this.recordHealth('feishu_callback','healthy');} catch {}} return {eventId:e.eventId,state:'received'};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  unknownInbox(): string[] { return [...(this.db.prepare("SELECT event_id FROM channel_inbox WHERE state='unknown' ORDER BY rowid").all() as Array<{event_id:string}>),...(this.db.prepare("SELECT event_id FROM channel_candidate_inbox_v1 WHERE state='unknown' ORDER BY rowid").all() as Array<{event_id:string}>),...(this.db.prepare("SELECT event_id FROM channel_steer_inbox_v1 WHERE state='unknown' ORDER BY rowid").all() as Array<{event_id:string}>)].map(x=>x.event_id); }
  pendingInbox(): string[] { return [...(this.db.prepare("SELECT event_id FROM channel_inbox WHERE state='received' ORDER BY rowid").all() as Array<{event_id:string}>),...(this.db.prepare("SELECT event_id FROM channel_candidate_inbox_v1 WHERE state='received' ORDER BY rowid").all() as Array<{event_id:string}>),...(this.db.prepare("SELECT event_id FROM channel_steer_inbox_v1 WHERE state='received' ORDER BY rowid").all() as Array<{event_id:string}>)].map(x=>x.event_id); }
  /** A crash after execution begins remains unknown and requires reconciliation. */
  async drain(eventId: string): Promise<unknown> {
    const pre = (this.db.prepare('SELECT envelope FROM channel_inbox WHERE event_id=?').get(eventId) ?? this.db.prepare('SELECT envelope FROM channel_candidate_inbox_v1 WHERE event_id=?').get(eventId) ?? this.db.prepare('SELECT envelope FROM channel_steer_inbox_v1 WHERE event_id=?').get(eventId)) as {envelope:string} | undefined;
    if (!pre) throw new Error('event not found');
    const destination = (JSON.parse(pre.envelope) as TrustedEnvelope).destination;
    const previous = this.destinationLocks.get(destination) ?? Promise.resolve();
    let release!: () => void; const lock = new Promise<void>(r => { release = r; });
    const tail = previous.then(() => lock); this.destinationLocks.set(destination,tail);
    await previous;
    try { return this.db.prepare('SELECT 1 FROM channel_steer_inbox_v1 WHERE event_id=?').get(eventId) ? await this.drainSteer(eventId) : this.db.prepare('SELECT 1 FROM channel_candidate_inbox_v1 WHERE event_id=?').get(eventId) ? await this.drainCandidate(eventId) : await this.drainLocked(eventId); } finally { release(); if (this.destinationLocks.get(destination) === tail) this.destinationLocks.delete(destination); }
  }
  private async drainSteer(eventId:string):Promise<unknown> {
    const row=this.db.prepare('SELECT * FROM channel_steer_inbox_v1 WHERE event_id=?').get(eventId) as {envelope:string;action:string;scope:string;session_id:string;turn_id:string;connection_generation:number;control_generation:number;state:string;result:string|null}|undefined;
    if(!row)throw Error('event not found');if(row.state!=='received')return row.result?JSON.parse(row.result):{status:'unknown'};
    const e=JSON.parse(row.envelope) as TrustedEnvelope,a=JSON.parse(row.action) as Extract<ChannelAction,{action:'input'}>,scope={destination:e.destination,bindingScope:row.scope,ownerSource:e.identity.source,ownerSubject:e.identity.subject};
    if(!this.isCurrentOwnedScope(scope,row.session_id) || !await this.authorize(e.identity,e.destination,row.session_id) || !this.isCurrentOwnedScope(scope,row.session_id)) {this.db.prepare("UPDATE channel_steer_inbox_v1 SET state='expired' WHERE event_id=? AND state='received'").run(eventId);return {status:'expired'};}
    if(row.result){const result=JSON.parse(row.result);if(!this.db.prepare("UPDATE channel_steer_inbox_v1 SET state='unknown' WHERE event_id=? AND state='received'").run(eventId).changes)return {status:'unknown'};const guard=async()=>{if(!this.isCurrentOwnedScope(scope,row.session_id)||!await this.authorize(e.identity,e.destination,row.session_id)||!this.isCurrentOwnedScope(scope,row.session_id))throw Error('binding changed or unauthorized')};await this.deliver(e.destination,{title:'追加输入未提交',text:'当前没有可追加的唯一运行轮，或当前会话不支持此操作。请刷新会话状态。',actions:[]},`${eventId}:steer-rejected`,guard);this.db.prepare("UPDATE channel_steer_inbox_v1 SET state='rejected' WHERE event_id=? AND state='unknown'").run(eventId);return result;}
    if(!this.isCurrentSteerScope(scope,row.session_id)){this.db.prepare("UPDATE channel_steer_inbox_v1 SET state='expired' WHERE event_id=? AND state='received'").run(eventId);return {status:'expired'};}
    const session=await this.service.getSession(row.session_id);
    if(!this.isCurrentSteerScope(scope,row.session_id) || session.control.generation!==row.control_generation){this.db.prepare("UPDATE channel_steer_inbox_v1 SET state='expired' WHERE event_id=? AND state='received'").run(eventId);return {status:'expired'};}
    if(!this.db.prepare("UPDATE channel_steer_inbox_v1 SET state='unknown' WHERE event_id=? AND state='received'").run(eventId).changes)return {status:'unknown'};
    try {const op=await this.service.submitInput({context:this.context(e,row.session_id,session.revision,row.control_generation),mode:'steer',blocks:[{type:'text',text:a.text}],requiredTurnId:row.turn_id,expectedConnectionGeneration:row.connection_generation,channelScope:scope});this.db.prepare("UPDATE channel_steer_inbox_v1 SET state='completed',result=? WHERE event_id=? AND state='unknown'").run(JSON.stringify(op),eventId);return op;}
    catch(error){const detail=error && typeof error==='object' && 'detail' in error ? (error as {detail?:{code?:string}}).detail:undefined;if(detail?.code && ['busy','stale_revision','control_conflict','unsupported','interaction_expired','unauthorized','invalid_request'].includes(detail.code)){const result={status:'rejected',reason:detail.code};this.db.prepare("UPDATE channel_steer_inbox_v1 SET state='rejected',result=? WHERE event_id=? AND state='unknown'").run(JSON.stringify(result),eventId);return result;}throw error;}
  }
  private async drainCandidate(eventId:string):Promise<unknown> {const row=this.db.prepare('SELECT * FROM channel_candidate_inbox_v1 WHERE event_id=?').get(eventId) as {envelope:string;action:string;scope:string;state:string;result:string|null}|undefined;if(!row)throw Error('event not found');if(row.state!=='received')return row.result?JSON.parse(row.result):{status:'unknown'};const e=JSON.parse(row.envelope) as TrustedEnvelope,a=JSON.parse(row.action) as ChannelAction,bound=this.binding(e.destination);if(row.scope!==this.bindingScope(e.destination)||!await this.authorize(e.identity,e.destination,bound)){this.db.prepare("UPDATE channel_candidate_inbox_v1 SET state='expired' WHERE event_id=? AND state='received'").run(eventId);return {status:'expired'};}if(!this.db.prepare("UPDATE channel_candidate_inbox_v1 SET state='unknown' WHERE event_id=? AND state='received'").run(eventId).changes)return {status:'unknown'};const effects={started:false};let result:unknown;try{result=await this.execute(e,a,bound,row.scope,effects);}catch(error){if(effects.started||row.scope!==this.bindingScope(e.destination)||!await this.authorize(e.identity,e.destination,bound)||row.scope!==this.bindingScope(e.destination))throw error;const guard=async()=>{if(row.scope!==this.bindingScope(e.destination)||!await this.authorize(e.identity,e.destination,bound)||row.scope!==this.bindingScope(e.destination))throw Error('binding changed or unauthorized');};await guard();effects.started=true;await this.deliver(e.destination,{title:'候选暂不可用',text:'无法读取候选元数据；请核对操作状态后重试。',actions:[]},`${eventId}:candidate-error`,guard);result={status:'unavailable'};}this.db.prepare("UPDATE channel_candidate_inbox_v1 SET state='completed',result=? WHERE event_id=? AND state='unknown'").run(JSON.stringify(result??null),eventId);return result;}
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
      if(a.action==='list' && !effects.started && executionScope===this.bindingScope(e.destination) && await this.authorize(e.identity,e.destination,bound) && executionScope===this.bindingScope(e.destination)) {const result={status:'rejected',reason:'temporarily_unavailable'}; const current=async()=>{if(executionScope!==this.bindingScope(e.destination) || !await this.authorize(e.identity,e.destination,bound) || executionScope!==this.bindingScope(e.destination)) throw new Error('binding changed or unauthorized');}; await this.deliver(e.destination,{title:'会话列表暂不可用',text:'读取会话列表失败，请稍后重试。',actions:[]},`${eventId}:list-unavailable`,current);this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("UPDATE channel_receipts SET state='completed',result=? WHERE event_id=?").run(JSON.stringify(result),eventId);this.db.prepare("UPDATE channel_inbox SET state='completed' WHERE event_id=?").run(eventId);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}return result;}
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
  private async listAllArtifacts(sessionId: string): Promise<import('./contracts.js').Artifact[]> {
    const items: import('./contracts.js').Artifact[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.service.listArtifacts(sessionId, { limit: 1000, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      if (cursor) {
        if (seen.has(cursor) || seen.size >= 1000) throw new Error('invalid artifact pagination');
        seen.add(cursor);
      }
    } while (cursor);
    return items;
  }
  async handle(e: TrustedEnvelope, a: ChannelAction): Promise<unknown> { await this.intake(e,a); return this.drain(e.eventId); }
  private async execute(e: TrustedEnvelope, a: ChannelAction, bound: string | null, executionScope:string, effects:{started:boolean}): Promise<unknown> {
    const guard = async () => { if(executionScope!==this.bindingScope(e.destination)) throw new BindingExpired('binding changed'); const allowed=await this.authorize(e.identity,e.destination,bound); if(executionScope!==this.bindingScope(e.destination)) throw new BindingExpired('binding changed'); if(!allowed) throw new ReadAuthorizationRevoked('unauthorized'); };
    const reply = async (card: ChannelCard, suffix = 'reply', extraGuard?:()=>Promise<void>) => { const current=extraGuard ? async()=>{await guard();await extraGuard();await guard();} : guard; await current(); effects.started=true; return this.deliver(e.destination, card, `${e.eventId}:${suffix}`,current); };
    const replyOrUpdate = async (card: ChannelCard, suffix = 'reply', extraGuard?:()=>Promise<void>) => {
      const current=extraGuard ? async()=>{await guard();await extraGuard();await guard();} : guard;
      await current();
      effects.started=true;
      if (e.cardMessageId) {
        const updateId=`${e.eventId}:${suffix}:update`;
        const inserted=this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(updateId);
        if(!inserted.changes) return;
        try {
          await this.port.update(e.destination,e.cardMessageId,this.stampCard(e.destination,card),updateId,current);
          await current();
          this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(updateId);
          return;
        } catch (error) {
          if (error instanceof BindingExpired || error instanceof ReadAuthorizationRevoked) throw error;
          this.db.prepare('DELETE FROM channel_deliveries WHERE delivery_id=?').run(updateId);
        }
      }
      return this.deliver(e.destination, card, `${e.eventId}:${suffix}`, current);
    };
    if(a.action==='resource_rejected'){const text={unsupported:'仅支持图片和 UTF-8 文本附件。',size:'文本附件为空或超过 1 MiB，未提交。',encoding:'文本附件不是有效 UTF-8 或包含 NUL，未提交。'}[a.reason];await reply({title:'附件未提交',text,actions:[]});return {status:'rejected',reason:a.reason};}
    if (a.action === 'help') { await reply({title:'帮助',text:'会话列表：/sessions；选择模型：在会话话题发送 /model；新建：/new；会话控制：/panel；历史：/history；Codex 当前唯一运行轮追加输入：/steer 内容；中断当前回复：/stop；后台任务是否终止尚未确认。',actions:[]}); return {status:'guidance'}; }
    if (a.action === 'new_help') {
      const defaultProject = this.channelOptions.defaultCreateProject?.trim() || undefined;
      const text = defaultProject
        ? `点击下方按钮可在默认目录（${defaultProject}）新建会话（支持 codex / claude / agy · Antigravity）；如需指定其他目录或模型，请发送 /create <codex|claude|agy> <项目目录> [模型]。创建完成后在新话题发送任务；目录须符合服务端允许范围。`
        : '请先选择后端（codex / claude / agy · Antigravity）和可信项目目录，再发送 /create <codex|claude|agy> <项目目录> [模型]。创建完成后在新话题发送任务；目录须符合服务端允许范围。';
      const actions: ChannelCard['actions'] = defaultProject
        ? [
            {label:'新建 Antigravity',value:{action:'create',provider:'agy',project:defaultProject,model:null}},
            {label:'新建 Codex',value:{action:'create',provider:'codex',project:defaultProject,model:null}},
            {label:'新建 Claude',value:{action:'create',provider:'claude',project:defaultProject,model:null}},
          ]
        : [];
      await reply({title:'新建会话',text,actions});
      return {status:'guidance'};
    }
    if (a.action === 'pending') { const pending=this.pendingOperations(e.destination),actions:ChannelCard['actions']=[];for(const p of pending){actions.push({label:`继续 ${p.kind}`,value:{action:'finish',operationId:p.operationId}});if(p.kind==='session'&&this.service.inspectUnknownCreateCandidates&&this.service.unknownCreateProvider){try{if(await this.service.unknownCreateProvider(e.identity,e.destination,p.operationId)==='codex')actions.push({label:'查看 Codex 候选',value:{action:'inspect_unknown',operationId:p.operationId}})}catch{}}}await reply({title:'待完成操作',text:pending.length ? `查询完成结果后继续。操作 ID：${pending.map(p=>p.operationId).join('、')}` : '没有待完成操作',actions});return pending; }
    if(a.action==='inspect_unknown'){const row=this.db.prepare("SELECT p.destination,p.kind,p.state,s.scope,a.envelope FROM channel_pending p JOIN channel_pending_scope s ON s.operation_id=p.operation_id JOIN channel_pending_actors a ON a.operation_id=p.operation_id WHERE p.operation_id=?").get(a.operationId) as {destination:string;kind:string;state:string;scope:string;envelope:string}|undefined;const actor=row?JSON.parse(row.envelope) as TrustedEnvelope:null;if(!row||row.destination!==e.destination||row.kind!=='session'||row.state!=='pending'||row.scope!==executionScope||!actor||actor.identity.source!==e.identity.source||actor.identity.subject!==e.identity.subject||!this.service.inspectUnknownCreateCandidates)throw new Error('candidate inspection unavailable');await guard();const result=await this.service.inspectUnknownCreateCandidates(e.identity,e.destination,a.operationId,{...(a.cursor?{cursor:a.cursor}:{}),...(a.nativeId?{nativeId:a.nativeId}:{})});await guard();const lines=result.items.map(x=>`Codex ${JSON.stringify(x.native.hostId)}/${JSON.stringify(x.native.serviceId)} · ${x.native.nativeSessionId} · ${JSON.stringify(x.project)} · 观测状态 ${x.status}`);await reply({title:'Codex 候选元数据',text:`原创建结果仍未知；以下候选不代表该次创建成功，历史未验证。${result.partial?' 部分候选未能读取。':''}\n${lines.length?lines.join('\n'):'当前页没有可展示的候选。'}`,actions:result.nextCursor?[{label:'下一页',value:{action:'inspect_unknown',operationId:a.operationId,cursor:result.nextCursor}}]:[]});return result;}
    if (a.action === 'list') {
      const search = a.search ?? (a.provider && a.provider !== 'all' ? a.provider : undefined);
      const page=await this.service.listSessions({limit:5,...(search === undefined ? {} : {search}),...(a.provider && a.provider !== 'all' ? {provider:a.provider} : {}),...(a.cursor === undefined ? {} : {cursor:a.cursor})});
      const sessions=[]; for(const s of page.items) if(await this.authorize(e.identity,e.destination,s.sessionId)) sessions.push(s);
      const topicUrls=new Map<string,string>();const links=await Promise.all(sessions.map(async session=>{await guard();const url=await this.port.topicLinkForSession?.(e.destination,session.sessionId);await guard();return {sessionId:session.sessionId,url};}));for(const link of links) if(link.url) topicUrls.set(link.sessionId,link.url);
      const visible:Array<(typeof page.items)[number]>=[];for(const session of sessions) {await guard();if(await this.authorize(e.identity,e.destination,session.sessionId)) visible.push(session);await guard();}
      const listGuard=async()=>{for(const session of visible) {await guard();if(!await this.authorize(e.identity,e.destination,session.sessionId)) throw new ReadAuthorizationRevoked('unauthorized');}await guard();};
      let hasAgyProvider = false;
      if (typeof this.service.hasProvider === 'function') {
        const has = this.service.hasProvider('agy') as unknown;
        if (typeof has === 'boolean') hasAgyProvider = has;
        else if (has && typeof (has as Promise<unknown>).catch === 'function') void (has as Promise<unknown>).catch(() => {});
      }
      const providerFilters=a.provider !== undefined || page.items.some(s => s.native.provider === 'agy') || hasAgyProvider;
      const card=sessionListCard(visible,{topicUrls,nextCursor:page.nextCursor,...(providerFilters ? {providerFilters:true} : {}),...(a.search ? {search:a.search} : {}),...(a.provider !== undefined ? {provider:a.provider} : {})}); if(page.unavailableProviders?.length) card.text+=`\n暂不可用：${page.unavailableProviders.join('、')}；列表可能不完整。`;
      await replyOrUpdate(card,'reply',listGuard);return {nextCursor:page.nextCursor};
    }
    if (a.action === 'health') {
      const health = await this.service.health();
      const labels:Record<string,string>={core:'核心',runtime:'本机调度概况',feishu_delivery:'飞书投递',feishu_callback:'飞书回调与入站',feishu_resources:'飞书资源',codex_connection:'Codex连接',codex_run:'Codex运行',claude_connection:'Claude SDK事件流',claude_run:'Claude运行',claude_quota:'Claude额度',agy_connection:'Antigravity连接',agy_run:'Antigravity运行',agy_quota:'Antigravity额度',interaction_return:'问题回传'};
      const states:Record<string,string>={healthy:'正常',degraded:'异常或待核对',unreachable:'不可连接',unverified:'尚未触发'};
      const reasonMap:Record<string,string>={
        'dispatch or synchronization failed; inspect persisted state before retry':'存在同步或调度异常，请检查本机状态',
        'connection closed':'连接曾断开',
        'not connected':'尚未连接',
        'transport error':'连接传输异常',
        'response timed out':'响应超时',
        'send failed':'消息发送失败',
        'app-server rejected request':'服务端拒绝请求',
        'invalid app-server message':'服务端消息格式无效',
        'reconnect and explicitly attach quarantined sessions':'存在隔离会话，请重新连接并手动恢复',
        'one or more sessions could not be restored; inspect before retry':'部分会话恢复失败，请检查后再试',
        'binding recovery failed; inspect before retry':'绑定恢复失败，请检查后再试',
        'normalized observation could not be persisted; replay required':'观测记录落盘失败，需要重放',
        'read-only refresh failed':'只读会话刷新失败',
        'restart recovery failed; inspect session before retry':'重启恢复失败，请检查会话后再试',
        'restart recovery failed; subscription released; reconciliation required':'重启恢复失败，订阅已释放，需人工核对',
        'restart recovery failed; subscription release outcome unknown':'重启恢复失败，订阅释放结果未知',
      };
      const formatTime = (iso: string | null | undefined): string | null => {
        if (!iso) return null;
        const ms = Date.parse(iso);
        if (!Number.isFinite(ms)) return null;
        const bj = new Date(ms + 8 * 3600 * 1000);
        if (!Number.isFinite(bj.getTime())) return null;
        return bj.toISOString().slice(5, 16).replace('T', ' ');
      };
      const translateReason = (reason: string | null | undefined): string | null => reason ? (reasonMap[reason] ?? reason) : null;
      const labelOf = (component: string): string => labels[component] ?? component;
      const attention: string[] = [];
      const normal: string[] = [];
      const unverified: string[] = [];
      const attentionRows: string[][] = [];
      const normalRows: string[][] = [];
      for (const h of health) {
        const label = labelOf(h.component);
        if (h.status === 'healthy') {
          const success = formatTime(h.lastSuccessAt);
          const observed = formatTime(h.lastObservedAt);
          const timeText = success ? `（最近成功 ${success}）` : observed ? `（最近观测 ${observed}）` : '';
          normal.push(`- ${label}：正常${timeText}`);
          const detailText = success ? `最近成功 ${success}` : observed ? `最近观测 ${observed}` : '—';
          normalRows.push([label, `✅ ${states.healthy}`, detailText]);
        } else if (h.status === 'unverified') {
          unverified.push(label);
        } else {
          const state = states[h.status] ?? h.status;
          const icon = h.status === 'unreachable' ? '❌' : '⚠️';
          const reason = translateReason(h.reason ?? h.lastFailureReason);
          const details: string[] = [];
          const success = formatTime(h.lastSuccessAt);
          const failure = formatTime(h.lastFailureAt);
          if (success) details.push(`最近成功 ${success}`);
          if (failure) details.push(`最近失败 ${failure}`);
          if (typeof h.unknown === 'number' && h.unknown > 0) details.push(`待核对 ${h.unknown}`);
          if (typeof h.backlog === 'number' && h.backlog > 0) details.push(`积压 ${h.backlog}`);
          attention.push(`- ${label}：${state}${reason ? `（${reason}）` : ''}${details.length ? `；${details.join('；')}` : ''}`);
          const rowDetails = [...(reason ? [reason] : []), ...details];
          attentionRows.push([label, `${icon} ${state}`, rowDetails.length ? rowDetails.join('；') : '—']);
        }
      }
      const sections: string[] = [];
      if (attention.length) sections.push(`【需关注】\n${attention.join('\n')}`);
      if (normal.length) sections.push(`【正常】\n${normal.join('\n')}`);
      if (unverified.length) sections.push(`【尚未触发】\n${unverified.join('、')}`);
      const rows = [...attentionRows, ...normalRows];
      const table = rows.length || unverified.length
        ? {
            columns: [
              { header: '组件', weight: 2 },
              { header: '状态', weight: 1 },
              { header: '最近动态 / 说明', weight: 3 },
            ],
            rows,
            ...(unverified.length ? { footer: `⚪ 尚未触发：${unverified.join('、')}` } : {}),
          }
        : undefined;
      await reply({
        title:'健康状态',
        text:sections.length ? sections.join('\n\n') : '暂无健康状态记录。',
        ...(table ? { table } : {}),
        actions:[],
      });
      return health;
    }
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
    if (a.action === 'bind') { const s = await this.service.getSession(a.sessionId); const bindGuard=async()=>{if(executionScope!==this.bindingScope(e.destination) || !await this.authorize(e.identity,e.destination,s.sessionId) || executionScope!==this.bindingScope(e.destination)) throw new Error('binding changed or unauthorized');}; await bindGuard(); const destination = this.port.createTopic && !this.port.isTopicDestination?.(e.destination) ? await this.port.createTopic(e.destination,s.sessionId,{title:s.title,text:`${providerDisplayLabel(s.native.provider)} · ${s.project} · ${s.status}`,actions:[]},`${e.eventId}:topic`,bindGuard) : e.destination; if (!await this.authorize(e.identity,destination,s.sessionId)) throw new Error('unauthorized'); const existing=this.db.prepare('SELECT session_id,owner_source,owner_subject FROM channel_bindings WHERE destination=?').get(destination) as {session_id:string;owner_source:string;owner_subject:string}|undefined; if(existing && (existing.owner_source!==e.identity.source || existing.owner_subject!==e.identity.subject) && !await this.authorizeBindingAdmin?.(e.identity,destination,existing.session_id)) throw new Error('binding management unauthorized'); let autoExistingInteractive=false; this.db.exec('BEGIN IMMEDIATE'); try { const auto=this.db.prepare('SELECT 1 FROM channel_auto_baselines WHERE event_id=? AND session_id=? AND destination IS NULL').get(e.eventId,s.sessionId); const current=this.db.prepare('SELECT session_id,access_mode FROM channel_bindings WHERE destination=?').get(destination) as {session_id:string;access_mode:string}|undefined; if(auto && current && current.session_id!==s.sessionId) throw new Error('automatic binding superseded'); if (auto ? !current : (!existing || existing.session_id!==s.sessionId)) { if(this.port.isTopicDestination?.(destination)) this.port.reassignTopic?.(destination,s.sessionId); this.db.prepare("INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode) VALUES (?,?,?,?,?,1,'read_only') ON CONFLICT(destination) DO UPDATE SET session_id=excluded.session_id,binding_id=excluded.binding_id,owner_source=excluded.owner_source,owner_subject=excluded.owner_subject,revision=channel_bindings.revision+1,access_mode='read_only'").run(destination,s.sessionId,randomUUID(),e.identity.source,e.identity.subject); this.db.prepare('DELETE FROM channel_cursors WHERE destination=?').run(destination); } autoExistingInteractive=!!auto && current?.access_mode==='interactive'; if(autoExistingInteractive) this.db.prepare('DELETE FROM channel_auto_baselines WHERE event_id=?').run(e.eventId); else this.db.prepare('UPDATE channel_auto_baselines SET destination=?,binding_scope=? WHERE event_id=? AND session_id=? AND destination IS NULL').run(destination,this.bindingScope(destination),e.eventId,s.sessionId); this.db.exec('COMMIT'); } catch(error) {this.db.exec('ROLLBACK');throw error;} if(autoExistingInteractive) return {sessionId:s.sessionId,accessMode:'interactive',destination}; await this.deliver(destination,{...sessionCard(s),text:sessionCard(s).text + `\n绑定模式: ${this.accessMode(destination)}`},`${e.eventId}:reply`); if(destination!==e.destination && a.mode!=='interactive') {const url=await this.port.topicLinkForSession?.(e.destination,s.sessionId) ?? null; if(url) await reply({title:'会话已打开',text:'在话题中查看和继续操作。',actions:[{label:'打开话题',value:{},url}]},'open-topic'); else await reply({title:'话题链接暂不可用',text:'会话话题已建立，请稍后重试打开。',actions:[]},'open-topic');} return { sessionId: s.sessionId, accessMode:this.accessMode(destination), destination }; }
    if (a.action === 'create' || a.action === 'attach') {
      let createTarget = e.destination;
      if (a.action === 'create' && bound && this.port.isTopicDestination?.(e.destination)) {
        const parentChat = this.port.chatDestination?.(e.destination) ?? null;
        if (!parentChat) {
          await replyOrUpdate({ title: '请在主群新建会话', text: '当前话题已绑定会话，请前往主群发送 /new 或 /create 新建会话。', actions: [] });
          return { status: 'guidance' };
        }
        await guard();
        if (!await this.authorize(e.identity, parentChat, null)) throw new Error('unauthorized');
        await guard();
        createTarget = parentChat;
      }
      const pendingEnvelope = createTarget === e.destination ? e : { ...e, destination: createTarget };
      const ctx = this.context(e, `new:${createTarget}`, 0, 0);
      this.db.prepare("INSERT OR IGNORE INTO channel_pending VALUES (?,?,NULL,'session',?,'pending')").run(ctx.operationId, createTarget, a.action === 'attach' ? a.mode : 'interactive');
      this.db.prepare('INSERT OR IGNORE INTO channel_pending_scope VALUES (?,?)').run(ctx.operationId, this.bindingScope(createTarget));
      this.recordPendingActor(ctx.operationId, pendingEnvelope);
      const op = a.action === 'create' ? await this.service.createSession({ context: ctx, payload: { provider: a.provider, project: a.project, model: a.model } }) : await this.service.attachSession({ context: ctx, payload: { provider: a.provider, hostId: a.hostId, serviceId: a.serviceId, nativeSessionId: a.nativeSessionId, mode: a.mode } });
      this.db.prepare("INSERT OR IGNORE INTO channel_pending VALUES (?,?,NULL,'session',?,'pending')").run(op.operationId, createTarget, a.action === 'attach' ? a.mode : 'interactive');
      await (a.action === 'create' ? replyOrUpdate : reply)({...operationCard(op),text:operationCard(op).text+(op.status === 'unknown' ? '' : '；完成后将自动继续'),actions:[{label:'查看处理进度',value:{action:'finish',operationId:op.operationId}}]});
      return op;
    }
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
      type PendingRow = {session_id:string | null;kind:string;mode:'new'|'queue'|'steer'|'read_only'|'interactive' | null;state:string};
      let finishDest = e.destination;
      let pending = this.db.prepare('SELECT * FROM channel_pending WHERE operation_id=? AND destination=?').get(a.operationId,finishDest) as PendingRow | undefined;
      if (!pending && this.port.isTopicDestination?.(e.destination)) {
        const parentChat = this.port.chatDestination?.(e.destination);
        if (parentChat) {
          const parentPending = this.db.prepare('SELECT * FROM channel_pending WHERE operation_id=? AND destination=?').get(a.operationId, parentChat) as PendingRow | undefined;
          if (parentPending?.kind === 'session') {
            finishDest = parentChat;
            pending = parentPending;
          }
        }
      }
      if (!pending) throw new Error('pending operation not found');
      if (pending.state === 'completed') return {status:'completed'};
      const pendingScope = this.db.prepare('SELECT scope FROM channel_pending_scope WHERE operation_id=?').get(a.operationId) as {scope:string} | undefined;
      if (!pendingScope || pendingScope.scope !== this.bindingScope(finishDest)) return {status:'expired',reason:'binding_changed'};
      const op = await this.service.getOperation(a.operationId); await guard();
      if (op.status !== 'completed' || !op.result) return op;
      if (pending.kind === 'session' && op.result.kind === 'session') {
        if (!await this.authorize(e.identity,finishDest,op.result.sessionId)) throw new Error('unauthorized');
        const session = await this.service.getSession(op.result.sessionId); await guard();
        const finishBound = finishDest === e.destination ? bound : this.binding(finishDest);
        if (pending.mode === 'interactive' && finishBound && op.result.sessionId !== finishBound && !(op.action === 'createSession' && this.port.createTopic && !this.port.isTopicDestination?.(finishDest))) throw new Error('upgrade session mismatch');
        const destination = this.port.createTopic && !this.port.isTopicDestination?.(finishDest) ? await this.port.createTopic(finishDest,session.sessionId,{title:session.title,text:`${providerDisplayLabel(session.native.provider)} · ${session.project} · ${session.status}`,actions:[]},`${a.operationId}:topic`) : finishDest;
        if (!await this.authorize(e.identity,destination,session.sessionId)) throw new Error('unauthorized'); await guard();
        const existing=this.db.prepare('SELECT session_id,owner_source,owner_subject FROM channel_bindings WHERE destination=?').get(destination) as {session_id:string;owner_source:string;owner_subject:string}|undefined; if(existing && (existing.owner_source!==e.identity.source || existing.owner_subject!==e.identity.subject) && !await this.authorizeBindingAdmin?.(e.identity,destination,existing.session_id)) throw new Error('binding management unauthorized'); await guard();
        if (existing?.session_id === session.sessionId && destination !== finishDest && pending.mode === 'interactive' && this.accessMode(destination) === 'read_only') {
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
    if (a.action === 'panel' && this.accessMode(e.destination) === 'read_only') { if(a.sessionId && a.sessionId!==bound) throw new Error('session mismatch'); const notice=this.noticePanel(e.destination,bound,executionScope,session); await reply({title:'只读会话',text:'此话题只读，可查看历史与文件。外部终端启动的 Claude 若仅同步等待状态、未接入响应通道，请回原终端处理。\n'+notice.text,actions:[{label:'转为可交互',value:{action:'upgrade'}},...notice.actions]}); return {accessMode:'read_only'}; }
    if (a.action === 'panel') {
      if (a.sessionId && a.sessionId !== bound) throw new Error('session mismatch');
      const base={revision:session.revision,controlGeneration:session.control.generation};
      const work=await this.service.getWorkState(bound);
      const interruptAvailable=session.capabilities?.interrupt?.status === 'available' && session.control.input === 'available';
      const queueAvailable=session.capabilities?.queue?.status === 'available' && session.control.input === 'available';
      const actions:ChannelCard['actions']=[
        ...this.noticePanel(e.destination,bound,executionScope,session).actions,
        ...(work.canArchive ? [{label:'归档',value:{action:'archive',archived:true,...base}},{label:'恢复归档',value:{action:'archive',archived:false,...base}}] : []),
        ...(session.capabilities?.handoff?.status === 'available' ? [{label:'切换到飞书',value:{action:'control',owner:'feishu',strategy:'wait',...base}}, {label:'释放控制',value:{action:'control',owner:'feishu',strategy:'wait',release:true,...base}}] : []),
        ...(interruptAvailable ? work.runningTurns.map((turn,index)=>({label:work.runningTurns.length===1 ? '中断当前回复' : `中断本轮回复 ${index+1}`,value:{action:'stop',turnId:turn.turnId,...base}})) : []),
        ...(queueAvailable ? work.queuedInputs.map((item,index)=>({label:`取消排队输入 ${index+1}`,value:{action:'cancel',inputId:item.inputId,...base}})) : [])];
      const text=[this.noticePanel(e.destination,bound,executionScope,session).text,interruptAvailable ? (work.runningTurns.length ? '可中断当前回复；已启动的后台任务是否终止尚未确认。' : '当前没有可中断的回复。') : '当前不支持中断回复。',queueAvailable ? (work.queuedInputs.length ? `排队中：${work.queuedInputs.length} 条。` : '当前没有排队输入。') : '当前不支持取消排队输入。',work.canArchive ? '' : '当前不支持归档。',session.capabilities?.handoff?.status === 'available' ? '' : '当前不支持切换控制。'].filter(Boolean).join('\n');
      await reply({title:'会话控制',text,actions}); return {running:work.runningTurns.length,queued:work.queuedInputs.length};
    }
    if (a.action === 'legacy_stop') { const work=await this.service.getWorkState(bound); await guard(); if(work.runningTurns.length!==1) {await reply({title:'中断回复',text:work.runningTurns.length===0 ? '当前没有可中断的回复。' : '当前有多个进行中的回复，请打开会话控制选择本轮。',actions:[{label:'会话控制',value:{action:'panel'}}]});return {status:'rejected',reason:work.runningTurns.length===0?'no_running_turn':'ambiguous_running_turn'};} const op=await this.service.interruptTurn({context:current(),payload:{turnId:work.runningTurns[0]!.turnId}});await reply(operationCard(op));return op; }
    if (a.action === 'project_files') {
      if (!this.service.listProjectFiles) throw new Error('project browsing unavailable');
      const listing = await this.service.listProjectFiles(bound, a.directory, a.showHidden);
      let text: string;
      if (listing.kind === 'error') {
        text = listing.message;
      } else if (listing.kind === 'file') {
        text = `${listing.entry.name} (${formatHumanSize(listing.entry.size)})`;
      } else {
        const sorted = [...listing.entries].sort((x, y) =>
          x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === 'dir' ? -1 : 1,
        );
        const treeLines = sorted.map((x, idx) => {
          const branch = idx === sorted.length - 1 ? '└──' : '├──';
          return x.kind === 'dir'
            ? `${branch} ${x.name}/`
            : `${branch} ${x.name} (${formatHumanSize(x.size)})`;
        });
        const body = treeLines.length ? treeLines.join('\n') : '(空目录)';
        text = `📁 ${listing.path}\n${body}\n显示 ${listing.entries.length}/${listing.total} 项，隐藏 ${listing.hidden} 项`;
      }
      await reply({ title: '项目目录', text, actions: [] });
      return listing;
    }
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
    if (a.action === 'history') { const hydrate=(this.service as UnifiedService & {hydrateSessionHistory?:(id:string)=>Promise<void>}).hydrateSessionHistory; if(this.requireReadonlyHydration && this.accessMode(e.destination)==='read_only' && !this.readonlyHydrated(e.destination,bound) && hydrate) {await guard();await hydrate.call(this.service,bound);await guard();await this.baselineReadonlyHistory(e.destination,bound);await guard();} const page = await this.service.readHistory(bound,{limit:20,...(a.cursor ? {cursor:a.cursor}:{})}); await reply(await this.longTextCard(e.destination,bound,'会话历史',page.items.map(m => `${m.role}: ${m.blocks.map(b => b.type === 'text' ? b.text : `[文件 ${b.artifactId}]`).join(' ')}`).join('\n'),page.nextCursor ? [{label:'下一页',value:{action:'history',cursor:page.nextCursor}}] : [],guard,()=>{effects.started=true;})); return page; }
    if (a.action === 'artifacts') {
      if (a.sessionId && a.sessionId !== bound) throw new Error('session mismatch');
      const rawItems = await this.listAllArtifacts(bound);
      const deduped: import('./contracts.js').Artifact[] = [];
      const seenVersions = new Set<string>();
      for (const item of rawItems) {
        const pathKey = item.relativePath || item.name;
        const dedupKey = `${pathKey}\0${item.contentVersion}`;
        if (seenVersions.has(dedupKey)) continue;
        seenVersions.add(dedupKey);
        deduped.push(item);
      }
      const normalizeRel = (item: import('./contracts.js').Artifact): string =>
        (item.relativePath || item.name).replace(/\\/g, '/').replace(/^\.\//, '');
      const splitRel = (item: import('./contracts.js').Artifact): { dir: string; filename: string; pathKey: string } => {
        const rel = normalizeRel(item);
        const slash = rel.lastIndexOf('/');
        return {
          dir: slash >= 0 ? rel.slice(0, slash) || '.' : '.',
          filename: slash >= 0 ? rel.slice(slash + 1) || item.name : rel,
          pathKey: item.relativePath || item.name,
        };
      };
      const pathCounts = new Map<string, number>();
      const byDir = new Map<string, import('./contracts.js').Artifact[]>();
      for (const item of deduped) {
        const { dir, pathKey } = splitRel(item);
        pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
        const list = byDir.get(dir) ?? [];
        list.push(item);
        byDir.set(dir, list);
      }
      const sortedDirs = [...byDir.keys()].sort((x, y) => (x === '.' ? -1 : y === '.' ? 1 : x.localeCompare(y)));
      const ordered = sortedDirs.flatMap((dir) => byDir.get(dir)!);

      const PAGE_SIZE = 8;
      const total = ordered.length;
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const parsedCursor = a.cursor !== undefined ? Number(a.cursor) : 0;
      const rawOffset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
      const maxOffset = total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
      const offset = Math.min(rawOffset, maxOffset);
      const pageItems = ordered.slice(offset, offset + PAGE_SIZE);
      const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
      const prevCursor = offset > 0 ? String(Math.max(0, offset - PAGE_SIZE)) : null;
      const nextCursor = offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null;

      const truncateLabel = (name: string, max: number): string => {
        const chars = [...name];
        return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : name;
      };

      const projectDir = session.project || '未知';
      const headerLines = [`默认目录：${projectDir}`];
      const actions: ChannelCard['actions'] = [];
      let text: string;
      if (total === 0) {
        text = `默认目录：${projectDir}\n\n暂无可下载文件。\n提示：如需浏览项目目录，可发送 /ls 或 /ls <子目录>。`;
      } else {
        if (totalPages > 1) headerLines.push(`共 ${total} 个文件（第 ${currentPage}/${totalPages} 页）`);
        const pageGroups: Array<{ dir: string; entries: Array<{ item: import('./contracts.js').Artifact; num: number; filename: string; pathKey: string }> }> = [];
        for (const [idx, item] of pageItems.entries()) {
          const { dir, filename, pathKey } = splitRel(item);
          const num = idx + 1;
          let group = pageGroups.find((g) => g.dir === dir);
          if (!group) {
            group = { dir, entries: [] };
            pageGroups.push(group);
          }
          group.entries.push({ item, num, filename, pathKey });
          const needsHash = (pathCounts.get(pathKey) ?? 0) > 1;
          const label = needsHash
            ? `${num}. ${truncateLabel(filename, 14)} (${item.contentVersion.slice(0, 6)})`
            : `${num}. ${truncateLabel(filename, 20)}`;
          actions.push({ label, value: { action: 'file', artifactId: item.artifactId, contentVersion: item.contentVersion } });
        }
        if (prevCursor !== null) {
          actions.push({ label: '上一页', value: { action: 'artifacts', ...(a.sessionId ? { sessionId: a.sessionId } : {}), cursor: prevCursor } });
        }
        if (nextCursor !== null) {
          actions.push({ label: '下一页', value: { action: 'artifacts', ...(a.sessionId ? { sessionId: a.sessionId } : {}), cursor: nextCursor } });
        }
        const treeLines: string[] = [];
        for (const group of pageGroups) {
          treeLines.push(`📁 ${group.dir === '.' ? './' : `${group.dir}/`}`);
          for (const [entryIdx, entry] of group.entries.entries()) {
            const branch = entryIdx === group.entries.length - 1 ? '└──' : '├──';
            const hashSuffix = (pathCounts.get(entry.pathKey) ?? 0) > 1 ? ` · ${entry.item.contentVersion.slice(0, 6)}` : '';
            treeLines.push(`${branch} ${entry.num}. ${entry.filename} (${formatHumanSize(entry.item.size)})${hashSuffix}`);
          }
        }
        text = `${headerLines.join('\n')}\n\n${treeLines.join('\n')}`;
      }
      await replyOrUpdate({ title: '文件', text, actions });
      return { items: pageItems, nextCursor };
    }
    if (a.action === 'file') {
      const scope=executionScope;
      const files = await this.listAllArtifacts(bound);
      const file = files.find(f => f.artifactId === a.artifactId && f.contentVersion === a.contentVersion);
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
    if(a.action==='notice_settings') {await guard(); const old=this.noticeSettings(e.destination,bound,executionScope); if(old.revision!==a.settingsRevision) throw {detail:contractError('stale_revision','stale notification settings')}; const next={...old,...(a.field==='legacy'?{}:{[a.field]:a.value}),revision:old.revision+1}; this.db.exec('BEGIN IMMEDIATE'); try {if(a.field==='legacy') this.db.prepare("UPDATE channel_preferences SET event_types='[]' WHERE destination=? AND session_id=?").run(e.destination,bound); if(a.field==='paused' && !a.value) {this.db.prepare('UPDATE channel_preferences SET enabled=1 WHERE destination=? AND session_id=?').run(e.destination,bound);this.db.prepare("DELETE FROM channel_notice_markers WHERE destination=? AND session_id=? AND binding_scope=? AND category='waiting'").run(e.destination,bound,executionScope);} this.db.prepare('INSERT OR REPLACE INTO channel_notice_settings VALUES (?,?,?,?,?,?,?,?)').run(e.destination,bound,executionScope,Number(next.paused),Number(next.completed),Number(next.waiting),Number(next.failed),next.revision);this.db.exec('COMMIT');} catch(error) {this.db.exec('ROLLBACK');throw error;} const panel=this.noticePanel(e.destination,bound,executionScope,session);await reply({title:'通知设置',...panel});return next; }
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
    if(a.action==='stop' && this.service.getTurn) {await guard();const turn=await this.service.getTurn(bound,a.turnId);await guard();if(turn && ['completed','failed','interrupted'].includes(turn.status)) {const label:Record<string,string>={completed:'已完成',failed:'已失败',interrupted:'已中断'};let text=`目标轮次${label[turn.status]}，未再次发出中断。`;if(turn.status==='interrupted'){const result=await this.service.inspectTurnResidual?.(bound,a.turnId);await guard();text+=`\n残留核对：${result?.reason ?? '此provider未提供可信残留查询'}${result?.count==null?'':`（${result.count}项）`}${result?.observedAt?`；核对时间 ${result.observedAt}`:''}`;}await reply({title:'中断回复',text,actions:[]});return {status:'already_finished',turnStatus:turn.status};}}
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
  private noticeSettings(destination:string,sessionId:string,scope:string):{paused:boolean;completed:boolean;waiting:boolean;failed:boolean;revision:number} { const row=this.db.prepare('SELECT paused,completed,waiting,failed,revision FROM channel_notice_settings WHERE destination=? AND session_id=? AND binding_scope=?').get(destination,sessionId,scope) as {paused:number;completed:number;waiting:number;failed:number;revision:number}|undefined;const legacy=this.db.prepare('SELECT enabled FROM channel_preferences WHERE destination=? AND session_id=?').get(destination,sessionId) as {enabled:number}|undefined;return row ? {paused:!!row.paused || legacy?.enabled===0,completed:!!row.completed,waiting:!!row.waiting,failed:!!row.failed,revision:row.revision} : {paused:legacy?.enabled===0,completed:true,waiting:true,failed:true,revision:0}; }
  private noticePanel(destination:string,sessionId:string,scope:string,session:Session):{text:string;actions:ChannelCard['actions']} {const n=this.noticeSettings(destination,sessionId,scope); const legacy=this.db.prepare('SELECT event_types,enabled FROM channel_preferences WHERE destination=? AND session_id=?').get(destination,sessionId) as {event_types:string;enabled:number}|undefined; const legacyFilter=!!legacy && JSON.parse(legacy.event_types).length>0; const base={action:'notice_settings',revision:session.revision,controlGeneration:session.control.generation,settingsRevision:n.revision};const names={completed:'完成',waiting:'等待',failed:'失败'} as const;return {text:`通知：${n.paused?'已暂停':'开启'}；完成 ${n.completed?'开':'关'}（回复卡标注或无回复时提醒），等待 ${n.waiting?'开':'关'}，失败 ${n.failed?'开':'关'}。${legacy?.enabled===0?'旧版暂停同时停止回复同步，恢复通知后继续。':'暂停期间不补发提醒；回复和已有互动卡状态仍同步。'}${legacyFilter?'已有旧版筛选仍同时生效。':''}`,actions:[{label:n.paused?'恢复通知':'暂停通知',value:{...base,field:'paused',value:!n.paused}},...(['completed','waiting','failed'] as const).map(field=>({label:`${n[field]?'关闭':'开启'}${names[field]}提醒`,value:{...base,field,value:!n[field]}})),...(legacyFilter?[{label:'清除旧版筛选',value:{...base,field:'legacy',value:false}}]:[])]};}
  private async renderInteraction(destination: string, sessionId: string, interaction: import('./contracts.js').Interaction, scope:string, allowCreate=true): Promise<void> {
    const guard=()=>this.checkBinding(destination,sessionId,scope); await guard();
    const row = this.db.prepare('SELECT revision,message_id,binding_scope FROM channel_interaction_cards WHERE destination=? AND session_id=? AND interaction_id=?').get(destination,sessionId,interaction.interactionId) as {revision:number;message_id:string;binding_scope:string} | undefined;
    if (!row && !allowCreate) return;
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
  protected async renderStreamMessage(destination:string, sessionId:string, scope:string, message:import('./contracts.js').Message):Promise<void> {
    const sequence=Number.isSafeInteger(message.sequence) ? message.sequence : 0; const guard=()=>this.checkBinding(destination,sessionId,scope); await guard();
    const row=this.db.prepare('SELECT card_id,revision,updated_at,final,current_message,latest_sequence FROM channel_stream_cards WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?').get(destination,sessionId,scope,message.turnId || message.messageId) as {card_id:string|null;revision:number;updated_at:number;final:number;current_message:string;latest_sequence:number}|undefined;
    if(row && (sequence<row.latest_sequence || (row.current_message!==message.messageId && sequence===row.latest_sequence))) return;
    if(row && ((row.current_message===message.messageId && ((row.final && !message.final) || row.revision>=message.revision)))) return;
    if(row && !message.final && Date.now()-row.updated_at<1000) {if(row.current_message!==message.messageId) this.db.prepare('UPDATE channel_stream_cards SET current_message=?,latest_sequence=?,revision=0,final=0 WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?').run(message.messageId,sequence,destination,sessionId,scope,message.turnId || message.messageId); return;}
    const text=message.blocks.map(b=>b.type==='text'?b.text:`[文件 ${b.artifactId}]`).join('\n');
    const turnDone=this.db.prepare("SELECT 1 FROM channel_notice_markers WHERE destination=? AND session_id=? AND binding_scope=? AND category='completed' AND object_key=?").get(destination,sessionId,scope,message.turnId || message.messageId); const card=message.final ? await this.longTextCard(destination,sessionId,turnDone?'回复 · 本轮已完成':'回复',text,[],guard) : {title:'回复中',text:[...text].slice(0,1000).join(''),actions:[]};
    await guard();
    if(!row) { const id=`stream:${payloadDigest([scope,destination,sessionId,message.turnId || message.messageId])}`; this.db.prepare('INSERT INTO channel_stream_cards VALUES (?,?,?,?,NULL,0,0,0,?,?)').run(destination,sessionId,scope,message.turnId || message.messageId,message.messageId,sequence); const cardId=await this.deliver(destination,card,id,guard); await guard(); if(cardId) this.db.prepare('UPDATE channel_stream_cards SET card_id=?,revision=?,updated_at=?,final=?,current_message=?,latest_sequence=? WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?').run(cardId,message.revision,Date.now(),Number(message.final),message.messageId,sequence,destination,sessionId,scope,message.turnId || message.messageId); return; }
    if(!row.card_id) return;
    const id=`stream-update:${payloadDigest([scope,destination,sessionId,message.messageId,message.revision])}`;
    if(!this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id).changes) return;
    await guard(); await this.port.update(destination,row.card_id,this.stampCard(destination,card),id,guard); await guard();
    this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id); this.db.prepare('UPDATE channel_stream_cards SET revision=?,updated_at=?,final=?,current_message=?,latest_sequence=? WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?').run(message.revision,Date.now(),Number(message.final),message.messageId,sequence,destination,sessionId,scope,message.turnId || message.messageId);
  }
  private async markTurnCompleted(destination:string,sessionId:string,scope:string,turnId:string,messages:import('./contracts.js').Message[]):Promise<void> { const guard=()=>this.checkBinding(destination,sessionId,scope); await guard(); if(this.db.prepare("SELECT 1 FROM channel_notice_markers WHERE destination=? AND session_id=? AND binding_scope=? AND category='completed' AND object_key=?").get(destination,sessionId,scope,turnId)) return; const row=this.db.prepare('SELECT card_id,current_message FROM channel_stream_cards WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?').get(destination,sessionId,scope,turnId) as {card_id:string|null;current_message:string}|undefined; const message=messages.find(m=>m.messageId===row?.current_message && m.final); if(!row?.card_id || !message) return; const text=message.blocks.map(b=>b.type==='text'?b.text:`[文件 ${b.artifactId}]`).join('\n'); const card=await this.longTextCard(destination,sessionId,'回复 · 本轮已完成',text,[],guard); const id=`turn-completed:${payloadDigest([scope,destination,sessionId,turnId])}`; if(!this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id).changes) return; await guard(); await this.port.update(destination,row.card_id,this.stampCard(destination,card),id,guard); await guard(); this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id); this.db.prepare('INSERT OR IGNORE INTO channel_notice_markers VALUES (?,?,?,?,?)').run(destination,sessionId,scope,'completed',turnId); }
  /** Poll using the bound owner's current authorization, never callback-provided identity. */
  async sync(destination: string): Promise<void> {
    const row=this.db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings WHERE destination=?').get(destination) as {session_id:string}|undefined; if(!row) throw new Error('destination is not bound'); const sessionId=row.session_id, scope=JSON.stringify(row);
    const syncGuard=()=>this.checkBinding(destination,sessionId,scope);
    const sendSync=async(d:string,card:ChannelCard,id:string)=>{await syncGuard();const result=await this.deliver(d,card,`sync:${payloadDigest([scope,id])}`,syncGuard);await syncGuard();return result;};
    await syncGuard();
    const preference = this.db.prepare('SELECT enabled,event_types FROM channel_preferences WHERE destination=? AND session_id=?').get(destination,sessionId) as {enabled:number;event_types:string} | undefined;
    await this.reconcileCards(destination,sessionId,scope); await syncGuard();
    const notice=this.noticeSettings(destination,sessionId,scope); const allowWaiting=!notice.paused && notice.waiting;
    if (preference && !preference.enabled) return; // Keep cursor for replay after resume.
    const eventTypes = preference ? JSON.parse(preference.event_types) as string[] : [];
    let expired = false;
    let cursor = (this.db.prepare('SELECT cursor FROM channel_cursors WHERE destination=? AND session_id=? AND binding_scope=?').get(destination,sessionId,scope) as {cursor:string} | undefined)?.cursor;
    if (cursor) {
      const events = await this.service.subscribeEvents(sessionId,cursor,100); await syncGuard();
      if (events.status === 'events') {
        const snapshot=await this.service.getSnapshot(sessionId); await syncGuard();
        for (const i of snapshot.value.interactions) await this.renderInteraction(destination,sessionId,i,scope,allowWaiting);
        const pending=this.db.prepare('SELECT current_message AS message_id FROM channel_stream_cards WHERE destination=? AND session_id=? AND binding_scope=? AND final=0').all(destination,sessionId,scope) as Array<{message_id:string}>; for(const p of pending) { const m=snapshot.value.messages.find(x=>x.messageId===p.message_id && x.role==='assistant'); if(m) await this.renderStreamMessage(destination,sessionId,scope,m); }
        let retryCount=0; let firstRetry='';
        const visible=events.events.filter(event=>!eventTypes.length || eventTypes.includes(event.type));
        const failedTurnIds=new Set(visible.filter(event=>event.type==='operation.failed' && event.data && typeof event.data==='object').map(event=>(event.data as {result?:{kind?:string;turnId?:string}}).result).filter((result):result is {kind:string;turnId:string}=>result?.kind==='turn' && typeof result.turnId==='string').map(result=>result.turnId));
        const hasTurnFailure=visible.some(event=>event.type==='turn.updated' && (event.data as {status?:string}|null)?.status==='failed');
        for (const event of events.events) {
          await syncGuard();
          const message=event.type==='message.updated' ? snapshot.value.messages.find(m=>m.messageId===event.objectId && m.role==='assistant') : undefined;
          if (message) {
            const known=this.db.prepare('SELECT revision FROM channel_known_messages WHERE destination=? AND session_id=? AND message_id=?').get(destination,sessionId,message.messageId) as {revision:number}|undefined;
            if(known && known.revision>=message.revision) continue;
            await this.renderStreamMessage(destination,sessionId,scope,message);
            if(message.final) { if(message.turnId && this.db.prepare('SELECT 1 FROM channel_completion_pending WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?').get(destination,sessionId,scope,message.turnId)) {if(!notice.paused && notice.completed) await this.markTurnCompleted(destination,sessionId,scope,message.turnId,snapshot.value.messages); this.db.prepare('DELETE FROM channel_completion_pending WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?').run(destination,sessionId,scope,message.turnId);} this.db.prepare('INSERT OR REPLACE INTO channel_known_messages VALUES (?,?,?,?)').run(destination,sessionId,message.messageId,message.revision); } continue;
          }
          const data=event.data && typeof event.data==='object' ? event.data as Record<string,unknown> : {};
          const statusValue=typeof data.status==='string' ? data.status : ''; const stopTurn=typeof data.turnId==='string'?data.turnId:event.objectId; const explicitStop=event.type==='turn.updated' && statusValue==='interrupted' && !!await this.service.hasStopRequest?.(sessionId,stopTurn); await syncGuard(); if((notice.paused || (eventTypes.length && !eventTypes.includes(event.type))) && !explicitStop) continue; const opId=typeof data.operationId==='string'?data.operationId:event.objectId; const previousOp=event.type.startsWith('operation.') ? this.db.prepare('SELECT state FROM channel_notice_operation_states WHERE destination=? AND session_id=? AND binding_scope=? AND operation_id=?').get(destination,sessionId,scope,opId) as {state:string}|undefined : undefined; if((event.type==='operation.unknown' && previousOp && previousOp.state!=='unknown') || (event.type==='operation.completed' && previousOp?.state==='completed')) continue; const resolvingUnknown=previousOp?.state==='unknown' && ['operation.failed','operation.completed'].includes(event.type); const resolving=event.type==='operation.completed' && resolvingUnknown; const category = event.type.startsWith('interaction.') || (event.type==='session.updated' && ['waiting_question','waiting_approval'].includes(statusValue)) ? 'waiting' : (resolving || event.type==='provider.api_retry' || event.type==='provider.usage_limit' || event.type==='adapter.stream_failed' || event.type==='operation.unknown' || event.type==='operation.failed' || (event.type==='turn.updated' && ['failed','interrupted'].includes(statusValue)) || (event.type==='session.updated' && statusValue==='failed')) ? 'failed' : (event.type==='turn.updated' && statusValue==='completed') ? 'completed' : null; if(category && !explicitStop && (notice.paused || !notice[category])) continue;
          if (event.type === 'provider.api_retry') { retryCount++; firstRetry ||= event.eventId; continue; }
          if (event.type === 'provider.usage_limit' && (data.status === 'rejected' || data.status === 'allowed_warning')) { await sendSync(destination,{title:'额度提示',text:data.status === 'rejected' ? '模型服务报告额度不足或受到限额，请稍后恢复后再使用。' : '模型服务提示额度接近限制，当前仍可继续。',actions:[]},`event:${destination}:${sessionId}:${event.eventId}`); continue; }
          if (event.type === 'provider.usage_available' && data.status === 'allowed') { await sendSync(destination,{title:'额度提示',text:'模型服务报告本次额度检查结果：可用。',actions:[]},`event:${destination}:${sessionId}:${event.eventId}`); continue; }
          const status=typeof data.status==='string' ? data.status : '';
          if(event.type==='session.updated' && !['waiting_question','waiting_approval'].includes(status)) this.db.prepare("DELETE FROM channel_notice_markers WHERE destination=? AND session_id=? AND binding_scope=? AND category='waiting'").run(destination,sessionId,scope);
          // Pending interaction cards above already present the question or approval.
          if (event.type==='interaction.created') continue;
          if (event.type==='operation.completed' && !resolving && (data.action==='submitInput' || data.action==='resolveInteraction')) continue;
          if (event.type==='turn.updated' && status==='completed') { const turnId=typeof data.turnId==='string' ? data.turnId : event.objectId; const final=snapshot.value.messages.filter(m=>m.turnId===turnId && m.role==='assistant' && m.final).sort((a,b)=>b.sequence-a.sequence)[0]; if(final) {await this.renderStreamMessage(destination,sessionId,scope,final);await this.markTurnCompleted(destination,sessionId,scope,turnId,snapshot.value.messages);continue;} const slot=this.db.prepare('SELECT 1 FROM channel_stream_cards WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?').get(destination,sessionId,scope,turnId); if(slot) {this.db.prepare('INSERT OR IGNORE INTO channel_completion_pending VALUES (?,?,?,?)').run(destination,sessionId,scope,turnId);continue;} }
          if (event.type==='turn.updated' && status==='failed' && failedTurnIds.has(typeof data.turnId==='string' ? data.turnId : event.objectId)) continue;
          if (event.type==='session.updated' && status==='failed' && (hasTurnFailure || failedTurnIds.size>0)) continue;
          const waitingSession=event.type==='session.updated' && ['waiting_question','waiting_approval'].includes(status);
          if (waitingSession && (snapshot.value.session.status!==status || snapshot.value.interactions.some(i=>['awaiting_answer','answer_pending_delivery'].includes(i.status) && (status==='waiting_approval' ? i.kind==='approval' : i.kind!=='approval')))) continue;
          const critical=event.type==='operation.failed' || event.type==='operation.unknown' || event.type==='operation.completed' || (event.type==='turn.updated' && ['failed','completed','interrupted'].includes(status)) || (event.type==='session.updated' && ['failed','waiting_question','waiting_approval'].includes(status));
          if (critical) {
            const statusText:Record<string,string>={failed:'运行失败，未形成完整回复',completed:'运行已完成',interrupted:'本轮回复已中断，未形成完整回复；后台任务是否终止尚未确认',waiting_question:'等待回答',waiting_approval:'等待审批'};
            const waitingHint=this.accessMode(destination)==='read_only' && (snapshot.value.session.native.provider==='claude' || snapshot.value.session.native.provider==='agy') && ['waiting_question','waiting_approval'].includes(status) ? '；外部终端会话若仅同步等待状态，请回原终端处理。' : '';
            let card=event.type.startsWith('operation.') && typeof data.action==='string' && typeof data.status==='string' ? operationCard(data as unknown as import('./contracts.js').Operation) : {title:'会话更新',text:(statusText[status] ?? '会话状态已更新')+waitingHint,actions:[]}; if(event.type==='turn.updated' && status==='interrupted') {const turnId=typeof data.turnId==='string'?data.turnId:event.objectId; await syncGuard(); const residual=await this.service.inspectTurnResidual?.(sessionId,turnId) ?? {status:'unknown' as const,count:null,observedAt:null,complete:false,reason:'此provider未提供可信残留查询'};await syncGuard();card={...card,text:`本轮已确认中断。\n残留核对：${residual.reason}${residual.count===null?'':`（${residual.count}项）`}${residual.observedAt?`；核对时间 ${residual.observedAt}`:''}`};}
            const linked=data.result && typeof data.result==='object' ? data.result as {kind?:string;turnId?:string} : undefined; const objectKey=category==='waiting' ? `${event.objectId}:${status}` : linked?.kind==='turn' && linked.turnId ? linked.turnId : event.type==='turn.updated' ? (typeof data.turnId==='string'?data.turnId:event.objectId) : event.objectId; const noticeKey=category==='failed' ? `${objectKey}:${status || event.type}` : objectKey; const exists=category && this.db.prepare('SELECT 1 FROM channel_notice_markers WHERE destination=? AND session_id=? AND binding_scope=? AND category=? AND object_key=?').get(destination,sessionId,scope,category,noticeKey); if(exists && !resolvingUnknown) continue;
            if(resolvingUnknown) {const old=this.db.prepare('SELECT message_id FROM channel_notice_operation_cards WHERE destination=? AND session_id=? AND binding_scope=? AND operation_id=?').get(destination,sessionId,scope,opId) as {message_id:string|null}|undefined; if(!old?.message_id) continue; const delivery=`operation-resolution:${payloadDigest([scope,destination,sessionId,opId,event.type])}`; if(!this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(delivery).changes) continue; await syncGuard();await this.port.update(destination,old.message_id,this.stampCard(destination,card),delivery,syncGuard);await syncGuard();this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(delivery);} else {const messageId=await sendSync(destination,card,`event:${destination}:${sessionId}:${event.eventId}`); if(event.type==='operation.unknown') this.db.prepare('INSERT OR REPLACE INTO channel_notice_operation_cards VALUES (?,?,?,?,?)').run(destination,sessionId,scope,opId,messageId ?? null);}  if(category) this.db.prepare('INSERT OR IGNORE INTO channel_notice_markers VALUES (?,?,?,?,?)').run(destination,sessionId,scope,category,noticeKey); if(event.type==='operation.unknown' || event.type==='operation.failed' || resolving) this.db.prepare('INSERT OR REPLACE INTO channel_notice_operation_states VALUES (?,?,?,?,?)').run(destination,sessionId,scope,opId,event.type.slice('operation.'.length));
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
        if (expired && m.role === 'assistant' && (!known || known.revision < m.revision)) {
          await syncGuard(); await this.renderStreamMessage(destination,sessionId,scope,m);
        }
        if(!expired || m.final) this.db.prepare('INSERT OR REPLACE INTO channel_known_messages VALUES (?,?,?,?)').run(destination,sessionId,m.messageId,m.revision);
      }
      for (const i of snapshot.value.interactions) await this.renderInteraction(destination,sessionId,i,scope,allowWaiting);
      cursor = snapshot.cursor;
    }
    await syncGuard();
    this.db.prepare('INSERT OR REPLACE INTO channel_cursors(destination,session_id,cursor,binding_scope) VALUES (?,?,?,?)').run(destination,sessionId,cursor,scope);
  }
}
