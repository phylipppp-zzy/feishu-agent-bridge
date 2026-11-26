import { eventSequence, TurnCardDelivery } from './turn-card-delivery.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { relative, isAbsolute, sep } from 'node:path';
import type { UnifiedService } from './adapter.js';
import type { Answer, Identity, Operation, Provider, WriteContext, Session, SessionSnapshot, Message } from './contracts.js';
import { payloadDigest } from './contracts.js';
import { contractError } from './errors.js';
import { decodeQuestionForm } from './feishu-question-forms.js';
import { historyTextCard, listAllArtifacts, sessionModelPage, showSessionList } from './feishu-channel-lists.js';
import { formatInterruptedTurn } from './card-formatters.js';
import { buildSessionPanel, noticePanel } from './feishu-session-panel.js';
import { NewSessionDrafts } from './new-session-drafts.js';
import { NewSessionFlow, type NewSessionAction } from './new-session-flow.js';
import { operationCard, type ChannelCard } from './feishu-cards.js';
import { readTurnReply } from './turn-reply.js';
import { escapeCardMarkdown } from './feishu-card-wire.js';
import { FeishuInteractionCards, isResolvedApproval } from './feishu-interaction-cards.js';
import { FeishuInbox } from './feishu-inbox.js';
import { FeishuSessionBinding } from './feishu-session-binding.js';
import { deliverProjectFiles, exportSessionHistory, FileCommandError } from './feishu-project-delivery.js';
import { buildHealthCard, buildQuotaCard } from './health-card.js';
import { queryAgyQuota, type AgyQuotaSnapshot } from './agy-quota.js';
import { buildArtifactTreeCard, buildProjectFilesCard } from './artifact-tree-card.js';
import { inputConfirmationCard, needsOperationNotice, operationFromReceipt, patchOperationCard, pendingSessionAuthorization, publishOperationFeedback, suppressInputFailure, SUPPRESSED_COMPLETED_ACTIONS } from './feishu-operation-notices.js';
import { BindingExpired, ReadAuthorizationRevoked, TOPIC_TITLE_SCHEMA, setCustomTopicTitle, syncTopicRootTitle } from './topic-title-sync.js';
import {
  buildAdminHelpCard,
  buildMainChatTopicOnlyGuidanceCard,
  buildMainHelpCard,
  buildSessionHelpCard,
  buildSwarmReadOnlyAgyCard,
  buildSwarmUnsupportedCard,
  pendingHubDisabledCard,
} from './help-cards.js';

/** Identity and destination must come from an authenticated, verified transport envelope. */
export interface TrustedEnvelope { eventId: string; destination: string; identity: Identity; cardMessageId?: string }
export interface FeishuPort {
  isTopicDestination?(destination:string): boolean;
  rootMessageId?(destination: string): Promise<string | null> | string | null;
  chatDestination?(destination:string): string | null;
  createTopic?(destination:string, sessionId:string, card:ChannelCard, deliveryId:string, guard?:()=>Promise<void>): Promise<string>;
  reassignTopic?(destination:string,sessionId:string):void;
  send(destination: string, card: ChannelCard, deliveryId: string, guard?:()=>Promise<void>): Promise<string | void>;
  sendText?(destination: string, text: string, deliveryId: string, guard?: () => Promise<void>): Promise<string | void>;
  update(destination: string, messageId: string, card: ChannelCard, deliveryId: string, guard?:()=>Promise<void>): Promise<void>;
  sendFile(destination: string, name: string, content: Uint8Array, deliveryId: string, guard?: () => Promise<void>): Promise<void>;
  /** Query by transport idempotency key; unknown is never retried automatically. */
  lookupDelivery?(deliveryId: string): Promise<'sent' | 'not_sent' | 'unknown'>;
  lookupMessageId?(deliveryId: string): Promise<string | null>;
  fileMessageLink?(destination:string,sessionId:string,deliveryId:string): Promise<string | null>;
  topicLinkForSession?(destination:string,sessionId:string):Promise<string | null>;
  topicLinkForTask?(destination:string,taskId:string):Promise<string | null>;
}
class BindingManagementDenied extends Error {}
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
 | { action: 'answer_form'; interactionId:string; revision:number; connectionGeneration:number; fields:Record<string,unknown>; decline?: boolean }
 | { action: 'answer'; interactionId: string; revision: number; connectionGeneration: number; answer: Answer; toolInputDigest: string | null }
 | { action: 'stop'; turnId: string; revision: number; controlGeneration: number }
 | { action: 'legacy_stop' }
 | { action: 'control'; owner: string; strategy: 'wait' | 'interrupt'; revision: number; controlGeneration: number; release?: boolean }
 | { action: 'artifacts'; sessionId?: string; cursor?: string }
 | { action: 'full_reply'; messageId: string }
 | { action: 'file'; artifactId: string; contentVersion: string }
 | { action: 'resource_rejected'; reason:'unsupported'|'size'|'encoding' }
 | { action: 'attachment'; name: string; mediaType: string; content: Uint8Array; mode: 'new' | 'queue' | 'steer'; localPath?: string; size?: number }
 | { action: 'models'; cursor?: string }
 | { action: 'legacy_model'; model?: string; effort?: string; invalid?: boolean }
 | { action: 'help'; scope?: 'admin' }
 | { action: 'command_error'; command: string; rawText: string }
 | { action: 'swarm'; prompt: string; rawText: string }
 | NewSessionAction
 | { action: 'settings'; model: string | null; preferences: Record<string, string>; revision: number; controlGeneration: number }
 | { action: 'notifications'; enabled: boolean; eventTypes: string[]; revision: number; controlGeneration: number }
 | { action:'notice_settings'; field:'paused'|'completed'|'waiting'|'failed'|'legacy'; value:boolean; settingsRevision:number; revision:number; controlGeneration:number }
 | { action: 'cancel'; inputId: string; revision: number; controlGeneration: number }
 | { action: 'archive'; archived: boolean; revision: number; controlGeneration: number }
 | { action: 'unbind' }
 | { action: 'reconcile'; operationId: string }
 | { action: 'finish'; operationId: string }
 | { action: 'pending' }
 | { action: 'pending_open' }
 | { action: 'inspect_unknown'; operationId:string; cursor?:string; nativeId?:string }
 | { action: 'task_create'; title: string }
 | { action: 'task_mount'; sessionId: string; mode?: 'read_only' | 'interactive' }
 | { action: 'task_panel' }
 | { action: 'handoff_preview'; targetId: string }
 | { action: 'quota' }
 | { action: 'rename'; title: string }
 | { action: 'health' }) & { bindingId?: string };

/** Standalone channel database. Never opens core's tables. */
export class FeishuChannel {
  private readonly db: DatabaseSync;
  private readonly inbox: FeishuInbox;
  private readonly sessionBinding: FeishuSessionBinding;
  private readonly newSession: NewSessionFlow;
  private readonly interactionCards: FeishuInteractionCards;
  protected readonly turnCards: TurnCardDelivery;
  private readonly topicSyncs = new Map<string, Promise<void>>();
  private migrationLocked=false;
  private closed = false;
  private readonly observedHealth=new Set<string>();
  private readonly healthFaults=new Set<string>(); private readonly diagnosticFaults=new Set<string>();
  private readonly destinationLocks = new Map<string, Promise<void>>();
  constructor(private readonly service: UnifiedService, private readonly port: FeishuPort, private readonly authorize: Authorize, dbPath: string, private readonly authorizeBindingAdmin?: AuthorizeBindingAdmin, private readonly requireReadonlyHydration=false, private readonly channelOptions: { defaultCreateProject?: string; allowedProjectRoots?: readonly string[]; enabledProviders?: readonly Provider[]; autoTakeControlOnInput?: boolean; onInteractionChanged?: (sessionId:string,interactionId:string) => void; onProgressWake?: (destination: string) => void; readQuota?: () => Promise<AgyQuotaSnapshot | null> | AgyQuotaSnapshot | null } = {}) {
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
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_notice_markers (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, category TEXT NOT NULL, object_key TEXT NOT NULL, PRIMARY KEY(destination,session_id,binding_scope,category,object_key))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_notice_settings (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, paused INTEGER NOT NULL, completed INTEGER NOT NULL, waiting INTEGER NOT NULL, failed INTEGER NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(destination,session_id,binding_scope))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_private_titles (native_key TEXT PRIMARY KEY)');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_uncertain (destination TEXT NOT NULL, native_key TEXT NOT NULL, PRIMARY KEY(destination,native_key))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_watermarks (destination TEXT PRIMARY KEY, enabled INTEGER NOT NULL, watermark INTEGER NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_scope_watermarks (destination TEXT NOT NULL, source TEXT NOT NULL, root TEXT NOT NULL, watermark INTEGER NOT NULL, PRIMARY KEY(destination,source,root))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_claude_scope_watermarks (destination TEXT NOT NULL, source TEXT NOT NULL, root TEXT NOT NULL, watermark INTEGER NOT NULL, PRIMARY KEY(destination,source,root))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_agy_scope_watermarks (destination TEXT NOT NULL, source TEXT NOT NULL, root TEXT NOT NULL, watermark INTEGER NOT NULL, PRIMARY KEY(destination,source,root))');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_auto_baselines (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot TEXT NOT NULL, destination TEXT, binding_scope TEXT)');
    this.db.exec('CREATE TABLE IF NOT EXISTS channel_history_baselines (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, PRIMARY KEY(destination,session_id,binding_scope))');
    this.db.exec(TOPIC_TITLE_SCHEMA);
    const columns = this.db.prepare('PRAGMA table_info(channel_bindings)').all() as Array<{name:string}>;
    if (!columns.some(c => c.name === 'access_mode')) this.db.exec("ALTER TABLE channel_bindings ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'read_only'");
    for(const table of ['channel_interaction_cards','channel_cursors']) {const fields=this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>;if(!fields.some(c=>c.name==='binding_scope')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN binding_scope TEXT NOT NULL DEFAULT ''`);}
    this.db.exec('CREATE INDEX IF NOT EXISTS channel_bindings_session ON channel_bindings(session_id,destination)');
    this.turnCards = new TurnCardDelivery(this.db, service, port, {
      guard: key => this.checkBinding(...key),
      stamp: (destination, card) => this.stampCard(destination, card),
      wake: destination => {
        if (channelOptions.onProgressWake) channelOptions.onProgressWake(destination);
        else void Promise.resolve(this.topicSyncs.get(destination)).catch(() => {}).then(() => {
          if (!this.closed) return this.sync(destination);
        }).catch(() => {});
      },
    });
    this.inbox = new FeishuInbox(this.db);
    const drafts = new NewSessionDrafts(this.db);
    this.sessionBinding = new FeishuSessionBinding(this.db,service,port,authorize,authorizeBindingAdmin,{
      scope: destination => this.bindingScope(destination),
      binding: destination => this.binding(destination),
      accessMode: destination => this.accessMode(destination),
      context: (...args) => this.context(...args),
      checkBinding: (...args) => this.checkBinding(...args),
      deliver: (...args) => this.deliver(...args),
      stamp: (...args) => this.stampCard(...args),
      handle: (...args) => this.handle(...args),
      bindingChanged: destination => this.turnCards.discardOtherScopes(destination, this.bindingScope(destination)),
    },drafts);
    this.newSession = new NewSessionFlow(drafts,service,port,authorize,this.sessionBinding,channelOptions);
    this.interactionCards = new FeishuInteractionCards(this.db,service,port,{
      checkBinding: (...args) => this.checkBinding(...args),
      accessMode: destination => this.accessMode(destination),
      stamp: (...args) => this.stampCard(...args),
      deliver: (...args) => this.deliver(...args),
    });
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
  close(): void { this.closed = true; this.turnCards.close(); this.db.close(); }
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
  destinationsForSession(sessionId: string): string[] {
    return (this.db.prepare('SELECT destination FROM channel_bindings WHERE session_id=? ORDER BY destination')
      .all(sessionId) as Array<{destination:string}>).map(row=>row.destination);
  }
  advanceOperation(operationId: string): Promise<Operation | null> {
    return this.sessionBinding.advanceOperation(operationId);
  }
  advanceCompleted(onDerived?: (operation: Operation) => void, skip?: (operationId: string) => boolean): Promise<void> {
    return this.sessionBinding.advanceCompleted(onDerived,skip);
  }
  pendingOperations(destination: string): Array<{operationId:string;kind:string;state:string}> { return this.db.prepare("SELECT operation_id AS operationId,kind,state FROM channel_pending WHERE destination=? AND state='pending'").all(destination) as Array<{operationId:string;kind:string;state:string}>; }
  pendingDeliveries(): Array<{deliveryId: string; state: string}> {
    return this.db.prepare("SELECT delivery_id AS deliveryId,state FROM channel_deliveries WHERE state='unknown'").all() as Array<{deliveryId:string;state:string}>;
  }
  async reconcileDelivery(deliveryId: string): Promise<'sent' | 'not_sent' | 'unknown'> {
    const row = this.db.prepare('SELECT state FROM channel_deliveries WHERE delivery_id=?').get(deliveryId) as {state:string} | undefined;
    if (!row) throw new Error('unknown delivery');
    if (row.state === 'sent') return 'sent';
    if (row.state === 'expired' || row.state === 'rejected') return 'not_sent';
    const state = await this.port.lookupDelivery?.(deliveryId) ?? 'unknown';
    if (state === 'sent') this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(deliveryId);
    return state;
  }
  private async checkBinding(destination: string, sessionId: string, scope?:string): Promise<void> {
    if (this.closed) throw new BindingExpired('channel closed');
    if(scope!==undefined && scope!==this.bindingScope(destination)) throw new BindingExpired('binding changed');
    const b = this.db.prepare('SELECT session_id,owner_source,owner_subject FROM channel_bindings WHERE destination=?').get(destination) as {session_id:string;owner_source:string;owner_subject:string} | undefined;
    if (!b || b.session_id !== sessionId || !await this.authorize({source:b.owner_source,subject:b.owner_subject},destination,sessionId)) throw new ReadAuthorizationRevoked('binding unauthorized or changed');
    if (this.closed || this.binding(destination) !== sessionId || (scope!==undefined && scope!==this.bindingScope(destination))) throw new BindingExpired('binding changed');
  }
  private bindingScope(destination: string): string { const row = this.db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings WHERE destination=?').get(destination); return JSON.stringify(row ?? null); }
  private actionScope(action: ChannelAction, destination: string): string { return ['list','health','quota','pending','pending_open','create','attach'].includes(action.action) ? 'global' : this.bindingScope(destination); }
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
    this.db.exec('BEGIN IMMEDIATE'); try {if(scope!==this.bindingScope(destination)) throw new Error('binding changed'); const put=this.db.prepare('INSERT INTO channel_known_messages(destination,session_id,message_id,revision) VALUES (?,?,?,?) ON CONFLICT(destination,session_id,message_id) DO UPDATE SET revision=MAX(revision,excluded.revision)'); for(const m of snapshot.messages) put.run(destination,sessionId,m.messageId,m.revision); this.turnCards.baseline([destination,sessionId,scope],snapshot.cursor,snapshot.messages); this.db.prepare('INSERT INTO channel_cursors(destination,session_id,cursor,binding_scope) VALUES (?,?,?,?) ON CONFLICT(destination) DO UPDATE SET session_id=excluded.session_id,cursor=excluded.cursor,binding_scope=excluded.binding_scope WHERE channel_cursors.session_id<>excluded.session_id OR channel_cursors.binding_scope<>excluded.binding_scope').run(destination,sessionId,snapshot.cursor,scope); this.db.prepare('INSERT OR IGNORE INTO channel_history_baselines VALUES (?,?,?)').run(destination,sessionId,scope);this.db.exec('COMMIT');} catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  private binding(destination: string): string | null { return (this.db.prepare('SELECT session_id FROM channel_bindings WHERE destination=?').get(destination) as {session_id: string} | undefined)?.session_id ?? null; }
  private isCurrentOwnedScope(scope:{destination:string;bindingScope:string;ownerSource:string;ownerSubject:string},sessionId:string):boolean {const owner=this.db.prepare('SELECT owner_source,owner_subject FROM channel_bindings WHERE destination=?').get(scope.destination) as {owner_source:string;owner_subject:string}|undefined;return owner?.owner_source===scope.ownerSource && owner.owner_subject===scope.ownerSubject && this.binding(scope.destination)===sessionId && this.bindingScope(scope.destination)===scope.bindingScope;}
  isCurrentSteerScope(scope:{destination:string;bindingScope:string;ownerSource:string;ownerSubject:string},sessionId:string):boolean {return this.isCurrentOwnedScope(scope,sessionId) && this.accessMode(scope.destination)==='interactive';}
  public accessMode(destination:string): 'read_only'|'interactive' { const row=this.db.prepare('SELECT access_mode FROM channel_bindings WHERE destination=?').get(destination) as {access_mode:string}|undefined; return row?.access_mode === 'interactive' ? 'interactive' : 'read_only'; }
  private context(e: TrustedEnvelope, targetId: string, expectedRevision: number, controlGeneration: number): WriteContext {
    const id = createHash('sha256').update(JSON.stringify([e.destination, e.eventId])).digest('hex');
    return { operationId: `feishu:${id}`, idempotencyKey: `feishu:${id}`, targetId, expectedRevision, controlGeneration, identity: e.identity };
  }
  private stampCard(destination:string, card:ChannelCard): ChannelCard {
    const row=this.db.prepare('SELECT binding_id FROM channel_bindings WHERE destination=?').get(destination) as {binding_id:string} | undefined;
    if (!row) return card;
    return {...card,actions:card.actions.map(action => ['list','new_help'].includes(String(action.value.action)) ? action : {...action,value:{...action.value,bindingId:row.binding_id}})};
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
  private async deliverOrUpdate(e:TrustedEnvelope, card:ChannelCard, suffix:string, guard:()=>Promise<void>, fallback = true) {
    const id=`${e.eventId}:${suffix}`;
    if (e.cardMessageId) {
      const updated = await patchOperationCard(this.db,this.port,e,e.cardMessageId,this.stampCard(e.destination,card),`${id}:update`,guard);
      if (updated || !fallback) return;
    }
    return this.deliver(e.destination,card,id,guard);
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
    if (expectedScope !== undefined && (!['attachment','resource_rejected'].includes(a.action) || capturedScope !== expectedScope)) throw new BindingExpired('binding changed');
    if (a.bindingId) { const row = this.db.prepare('SELECT binding_id FROM channel_bindings WHERE destination=?').get(e.destination) as {binding_id:string} | undefined; if (row?.binding_id !== a.bindingId && !this.sessionBinding.permitsCompletedUpgrade(e,a,{bindingId:a.bindingId})) throw new Error('binding changed'); }
    const bound = this.binding(e.destination);
    // Capture at ingress, before any asynchronous authorization or queue wait can
    // allow the current turn to change. The core performs its own authorization.
    const steerCapture=a.action==='input' && a.mode==='steer' && bound && this.service.captureSteer ? this.service.captureSteer(e.identity,bound).then(value=>({value}),error=>({error})) : null;
    if (e.eventId.startsWith('card:') && a.action === 'bind' && bound && !a.bindingId) throw new Error('binding changed');
    const target = a.action === 'bind' ? a.sessionId : bound;
    if (!await this.authorize(e.identity,e.destination,target)) throw new Error('unauthorized');
    await this.checkManager(e,a);
    if (bound && e.cardMessageId && a.action === 'answer' && a.answer.kind === 'approval' &&
        await isResolvedApproval(this.service,bound,a.interactionId) && this.actionScope(a,e.destination) === capturedScope) {
      throw contractError('interaction_expired','approval already resolved');
    }
    const steer = a.action === 'input' && a.mode === 'steer';
    const steerReplay = steer ? this.db.prepare('SELECT digest,state FROM channel_steer_inbox_v1 WHERE event_id=?')
      .get(e.eventId) as {digest:string;state:string}|undefined : undefined;
    if (steer && (steerReplay || (bound && !this.db.prepare('SELECT 1 FROM channel_inbox WHERE event_id=?').get(e.eventId)))) {
      const action=JSON.stringify(a),envelope=JSON.stringify(e),digest=payloadDigest({destination:e.destination,identity:e.identity,action:JSON.parse(action)});
      if(steerReplay){if(steerReplay.digest!==digest)throw Error('idempotency conflict');return {eventId:e.eventId,state:steerReplay.state};}
      if (!bound) throw new BindingExpired('steer binding changed');
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
    const serializedAction = JSON.stringify(
      a.action === 'attachment'
        ? a.mediaType === 'application/pdf' && a.localPath
          ? { ...a, content: [], size: a.size ?? a.content.byteLength }
          : { ...a, content: Array.from(a.content) }
        : a,
    );
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
  pendingInbox(destination?: string): string[] { return this.inbox.pending(destination); }
  pendingInboxDestinations(): string[] { return this.inbox.destinations(); }
  operationForEvent(eventId: string): Operation | null { return this.inbox.operationForEvent(eventId); }
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
    const validScope = () => scope && (scope.scope === 'global' || scope.scope === this.bindingScope(e.destination) ||
      this.sessionBinding.permitsCompletedUpgrade(e,a,{scope:scope.scope}));
    const expired = () => {
      const result = {status:'expired',reason:'binding_changed'};
      this.db.prepare("UPDATE channel_inbox SET state='expired' WHERE event_id=?").run(eventId);
      this.db.prepare("UPDATE channel_receipts SET state='expired',result=? WHERE event_id=?").run(JSON.stringify(result),eventId);
      return result;
    };
    if (!validScope()) return expired();
    const rejectUnauthorized=() => { const result={status:'rejected',reason:'unauthorized'}; this.db.exec('BEGIN IMMEDIATE'); try { this.db.prepare("UPDATE channel_inbox SET state='rejected' WHERE event_id=? AND state='received'").run(eventId); this.db.prepare("UPDATE channel_receipts SET state='rejected',result=? WHERE event_id=?").run(JSON.stringify(result),eventId); this.db.exec('COMMIT'); } catch(error) {this.db.exec('ROLLBACK');throw error;} return result; };
    if (!await this.authorize(e.identity,e.destination,a.action === 'bind' ? a.sessionId : bound)) return rejectUnauthorized();
    try { await this.checkManager(e,a); } catch(error) { if (error instanceof BindingManagementDenied) return rejectUnauthorized(); throw error; }
    if (!validScope() || executionScope !== this.bindingScope(e.destination)) return expired();
    const autoUpgradeInput = Boolean(
      this.channelOptions.autoTakeControlOnInput &&
      (a.action === 'input' || a.action === 'swarm'),
    );
    if (bound && this.accessMode(e.destination) === 'read_only' && !autoUpgradeInput && (['input','answer','answer_form','attachment','stop','legacy_stop','control','settings','cancel','archive'].includes(a.action) || (a.action === 'reconcile' && !pendingSessionAuthorization(this.db,this.port,this.authorize,e,a.operationId)) || (a.action === 'legacy_model' && !!a.model))) {
      const result={status:'rejected',reason:'read_only_binding'};
      this.db.exec('BEGIN IMMEDIATE');
      try { this.db.prepare("UPDATE channel_inbox SET state='rejected' WHERE event_id=? AND state='received'").run(eventId); this.db.prepare("UPDATE channel_receipts SET state='rejected',result=? WHERE event_id=?").run(JSON.stringify(result),eventId); this.db.exec('COMMIT'); } catch(error) { this.db.exec('ROLLBACK'); throw error; }
      await this.deliver(e.destination,{title:'操作未执行',template:'grey',text:'此话题为只读。点击「一键接入并续聊」后可在飞书继续操作。',actions:[{label:'一键接入并续聊',value:{action:'upgrade'}},{label:'会话控制',value:{action:'panel',sessionId:bound}}]},`${eventId}:readonly-rejected`);
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
      const readOnly=['help','command_error','new_help','pending','pending_open','list','health','quota','panel','history','artifacts','project_files','deliver_files','export','file','full_reply','models'].includes(a.action) || (a.action==='legacy_model' && !a.model);
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
    const reply = async (card: ChannelCard, suffix = 'reply', extraGuard?:()=>Promise<void>) => { const current=extraGuard ? async()=>{await guard();await extraGuard();await guard();} : guard; await current(); effects.started=true; return this.deliver(e.destination, card, `${e.eventId}:${suffix}`,current); };
    const replyOrUpdate = async (card: ChannelCard, suffix = 'reply', extraGuard?:()=>Promise<void>, fallback = true) => {
      const current=extraGuard ? async()=>{await guard();await extraGuard();await guard();} : guard;
      await current(); effects.started=true;
      return this.deliverOrUpdate(e,card,suffix,current,fallback);
    };
    const updateReply = (card:ChannelCard) => replyOrUpdate(card,'reply',undefined,false);
    if(a.action==='resource_rejected'){const text={unsupported:'仅支持图片（PNG/JPG/GIF/WebP）、PDF 文档，以及常见 UTF-8 文本/代码文件（.txt/.md/.json/.yaml/.log/.py/.ts 等）。',size:'文本附件为空或超过 1 MiB（图片/PDF 上限 20 MiB），未提交。',encoding:'文本/代码附件不是有效 UTF-8 或包含 NUL 字节，未提交。'}[a.reason];await reply({title:'附件未提交',text,actions:[]});return {status:'rejected',reason:a.reason};}
    if (a.action === 'command_error') {
      await reply({
        title: '命令参数有误',
        template: 'orange',
        text: `命令 \`${escapeCardMarkdown(a.command)}\` 参数格式不正确，请检查后重试，或发送 /help 查看用法。`,
        actions: [],
      });
      return { status: 'rejected', reason: 'invalid_command' };
    }
    if (a.action === 'task_create' || a.action === 'task_mount' || a.action === 'task_panel' || a.action === 'handoff_preview') { throw contractError('unsupported', 'action is unavailable for this destination'); }
    if (a.action === 'help') {
      if (a.scope === 'admin') { await reply(buildAdminHelpCard()); return {status:'guidance'}; }
      if (bound && typeof this.service.getSession === 'function') {
        const boundSession = await this.service.getSession(bound);
        await reply(buildSessionHelpCard(boundSession.native.provider, this.accessMode(e.destination)));
        return {status:'guidance'};
      }
      await reply(buildMainHelpCard());
      return {status:'guidance'};
    }
    if (a.action === 'new_help' || a.action === 'new_provider' || a.action === 'new_pick') {
      return this.newSession.handle(e,a,{scope:executionScope,guard,reply,context:this.context(e,`new:${e.destination}`,0,0),bound});
    }
    if (a.action === 'pending_open') { await reply(pendingHubDisabledCard()); return {status:'guidance'}; }
    if (a.action === 'pending') { const pending=this.pendingOperations(e.destination),actions:ChannelCard['actions']=[];for(const p of pending){actions.push({label:`继续 ${p.kind}`,value:{action:'finish',operationId:p.operationId}});if(p.kind==='session'&&this.service.inspectUnknownCreateCandidates&&this.service.unknownCreateProvider){try{if(await this.service.unknownCreateProvider(e.identity,e.destination,p.operationId)==='codex')actions.push({label:'查看 Codex 候选',value:{action:'inspect_unknown',operationId:p.operationId}})}catch{}}}await reply({title:'待完成操作',format:'plain',text:pending.length ? `查询完成结果后继续。操作 ID：${pending.map(p=>p.operationId).join('、')}` : '没有待完成操作',actions});return pending; }
    if(a.action==='inspect_unknown'){const row=this.db.prepare("SELECT p.destination,p.kind,p.state,s.scope,a.envelope FROM channel_pending p JOIN channel_pending_scope s ON s.operation_id=p.operation_id JOIN channel_pending_actors a ON a.operation_id=p.operation_id WHERE p.operation_id=?").get(a.operationId) as {destination:string;kind:string;state:string;scope:string;envelope:string}|undefined;const actor=row?JSON.parse(row.envelope) as TrustedEnvelope:null;if(!row||row.destination!==e.destination||row.kind!=='session'||row.state!=='pending'||row.scope!==executionScope||!actor||actor.identity.source!==e.identity.source||actor.identity.subject!==e.identity.subject||!this.service.inspectUnknownCreateCandidates)throw new Error('candidate inspection unavailable');await guard();const result=await this.service.inspectUnknownCreateCandidates(e.identity,e.destination,a.operationId,{...(a.cursor?{cursor:a.cursor}:{}),...(a.nativeId?{nativeId:a.nativeId}:{})});await guard();const lines=result.items.map(x=>`Codex ${JSON.stringify(x.native.hostId)}/${JSON.stringify(x.native.serviceId)} · ${x.native.nativeSessionId} · ${JSON.stringify(x.project)} · 观测状态 ${x.status}`);await reply({title:'Codex 候选元数据',format:'plain',text:`原创建结果仍未知；以下候选不代表该次创建成功，历史未验证。${result.partial?' 部分候选未能读取。':''}\n${lines.length?lines.join('\n'):'当前页没有可展示的候选。'}`,actions:result.nextCursor?[{label:'下一页',value:{action:'inspect_unknown',operationId:a.operationId,cursor:result.nextCursor}}]:[]});return result;}
    if (a.action === 'list') return showSessionList(this.service,this.port,this.authorize,e,a,guard,replyOrUpdate);
    if (a.action === 'quota') {
      const quota = await this.readQuotaSnapshot(true);
      const health = typeof this.service.health === 'function' ? await this.service.health().catch(() => []) : [];
      await reply(buildQuotaCard(quota, health));
      return quota ?? { state: 'offline_empty' };
    }
    if (a.action === 'health') {
      const health = await this.service.health();
      const hasAgyQuotaEntry = health.some(h => h.component === 'agy_quota');
      const quota = this.channelOptions.readQuota || hasAgyQuotaEntry
        ? await this.readQuotaSnapshot(false)
        : undefined;
      await reply(buildHealthCard(health, quota));
      return health;
    }
    if (a.action === 'bind') {
      return a.mode === 'interactive'
        ? this.sessionBinding.beginInteractiveAttach(e,a.sessionId,executionScope,guard,reply)
        : this.sessionBinding.bindReadOnly(e,a.sessionId,executionScope,reply);
    }
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
      this.sessionBinding.recordPending(ctx.operationId,pendingEnvelope,null,'session',a.action === 'attach' ? a.mode : 'interactive');
      const op = a.action === 'create' ? await this.service.createSession({ context: ctx, payload: { provider: a.provider, project: a.project, model: a.model } }) : await this.service.attachSession({ context: ctx, payload: { provider: a.provider, hostId: a.hostId, serviceId: a.serviceId, nativeSessionId: a.nativeSessionId, mode: a.mode } });
      if (needsOperationNotice(op)) await (a.action === 'create' ? replyOrUpdate : reply)(operationCard(op));
      else if (a.action === 'create' && e.cardMessageId) await replyOrUpdate({title:'正在创建会话',text:'已提交创建，完成后将自动打开新话题。',actions:[{label:'查看处理进度',value:{action:'finish',operationId:op.operationId}}]});
      return op;
    }
    if (!bound && this.port.isTopicDestination?.(e.destination) === true && a.action !== 'finish' && a.action !== 'reconcile') {
      await reply({title:'当前话题未绑定会话',template:'grey',text:'此话题当前未绑定任何会话。请回主群发送 /sessions 重新选择会话，或发送 /new 新建会话。',actions:[]});
      return {status:'guidance'};
    }
    if (a.action === 'unbind') {
      if (!bound) throw new Error('destination is not bound');
      await guard(); effects.started=true;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM channel_bindings WHERE destination=?').run(e.destination);
        this.db.prepare('DELETE FROM channel_cursors WHERE destination=?').run(e.destination);
        this.db.exec('COMMIT');
      } catch(error) { this.db.exec('ROLLBACK'); throw error; }
      this.turnCards.discardOtherScopes(e.destination, this.bindingScope(e.destination));
      const unboundGuard = async () => {
        if (this.binding(e.destination) || !await this.authorize(e.identity,e.destination,bound) || this.binding(e.destination)) throw new BindingExpired('binding or authorization changed');
      };
      await this.deliver(e.destination,{title:'已解除绑定',template:'grey',text:'当前话题已与原会话解除绑定。如需继续，请回主群发送 /sessions 打开会话，或发送 /new 新建会话。',actions:[]},`${e.eventId}:reply`,unboundGuard);
      return {unbound:true};
    }
    if (bound && this.accessMode(e.destination) === 'read_only' && this.channelOptions.autoTakeControlOnInput && (a.action === 'input' || a.action === 'swarm')) {
      const text = a.action === 'swarm' ? (a.prompt ? `/swarm ${a.prompt}` : '/swarm') : a.text;
      return this.sessionBinding.beginInteractiveAttach(e, bound, executionScope, guard, reply, { text, mode: 'new' });
    }
    if (a.action === 'upgrade') {
      if (!bound) throw new Error('no bound session');
      return this.sessionBinding.beginInteractiveAttach(e,bound,executionScope,guard,reply);
    }
    if (a.action === 'finish') return this.sessionBinding.finish(e,a.operationId,bound,guard,reply);
    if (!bound && (['models','legacy_model','legacy_stop','stop','project_files','artifacts','file','full_reply','history','export','swarm'].includes(a.action) ||
      (a.action === 'input' && this.port.isTopicDestination?.(e.destination) === false))) {
      await reply(buildMainChatTopicOnlyGuidanceCard(a.action === 'swarm' || a.action === 'input' ? a.action : undefined));
      return {status:'guidance'};
    }
    if (a.action === 'reconcile') {
      const pending=pendingSessionAuthorization(this.db,this.port,this.authorize,e,a.operationId); if (!bound && !pending) throw new Error('destination is not bound');
      const op=await this.service.getOperation(a.operationId), pendingGuard=pending && op.targetId===`new:${pending.destination}` && ['createSession','attachSession'].includes(op.action) ? pending.guard : undefined;
      await guard(); await pendingGuard?.();
      if (op.targetId!==bound && !pendingGuard) throw new Error('operation target mismatch');
      const result=await this.service.reconcile(a.operationId); await reply(operationCard(result),'reply',pendingGuard); return result;
    }
    if (!bound) throw new Error('destination is not bound');
    const session = await this.service.getSession(bound);
    const current = () => this.context(e, bound, session.revision, session.control.generation);
    if (a.action === 'panel') {
      if (a.sessionId && a.sessionId !== bound) throw new Error('session mismatch');
      const mode=this.accessMode(e.destination);
      const work=mode === 'interactive' ? await this.service.getWorkState(bound) : null;
      const quotaOption = session.native.provider === 'agy' && this.channelOptions.readQuota
        ? { quota: await this.readQuotaSnapshot(false) }
        : undefined;
      await reply(buildSessionPanel(session,this.noticePanel(e.destination,bound,executionScope,session),work,quotaOption));
      return work ? {running:work.runningTurns.length,queued:work.queuedInputs.length} : {accessMode:mode};
    }
    if (a.action === 'legacy_stop') { const work=await this.service.getWorkState(bound); await guard(); if(work.runningTurns.length!==1) {await reply({title:'中断回复',text:work.runningTurns.length===0 ? '当前没有可中断的回复。' : '当前有多个进行中的回复，请打开会话控制选择本轮。',actions:[{label:'会话控制',value:{action:'panel'}}]});return {status:'rejected',reason:work.runningTurns.length===0?'no_running_turn':'ambiguous_running_turn'};} const op=await this.service.interruptTurn({context:current(),payload:{turnId:work.runningTurns[0]!.turnId}});if (needsOperationNotice(op)) await reply(operationCard(op));return op; }
    if (a.action === 'project_files') {
      if (!this.service.listProjectFiles) throw new Error('project browsing unavailable');
      const listing = await this.service.listProjectFiles(bound, a.directory, a.showHidden);
      await reply(buildProjectFilesCard(listing));
      return listing;
    }
    if (a.action === 'deliver_files') return deliverProjectFiles(this.db,this.service,this.port,[e.destination,bound,executionScope],a.args,guard,reply,()=>{effects.started=true;});
    if (a.action === 'export') return exportSessionHistory(this.db,this.service,this.port,[e.destination,bound,executionScope],guard,reply,()=>{effects.started=true;});
    if (a.action === 'history') { const hydrate=(this.service as UnifiedService & {hydrateSessionHistory?:(id:string)=>Promise<boolean>}).hydrateSessionHistory; if(this.requireReadonlyHydration && this.accessMode(e.destination)==='read_only' && !this.readonlyHydrated(e.destination,bound) && hydrate) {await guard(); if(await hydrate.call(this.service,bound)) {await guard();await this.baselineReadonlyHistory(e.destination,bound);} await guard();} const page = await this.service.readHistory(bound,{limit:20,...(a.cursor ? {cursor:a.cursor}:{})}); await (a.cursor ? updateReply : reply)(await historyTextCard(this.db,this.port,[e.destination,bound,executionScope],page.items.map(m => `${m.role}: ${m.blocks.map(b => b.type === 'text' ? b.text : `[文件 ${escapeCardMarkdown(b.artifactId)}]`).join(' ')}`).join('\n'),page.nextCursor ? [{label:'下一页',value:{action:'history',cursor:page.nextCursor}}] : [],guard,()=>{effects.started=true;})); return page; }
    if (a.action === 'artifacts') {
      if (a.sessionId && a.sessionId !== bound) throw new Error('session mismatch');
      const rawItems = await listAllArtifacts(this.service,bound);
      const { card, items: pageItems, nextCursor } = buildArtifactTreeCard(rawItems, {
        projectDir: session.project,
        ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
        ...(a.sessionId !== undefined ? { sessionId: a.sessionId } : {}),
      });
      await replyOrUpdate(card);
      return { items: pageItems, nextCursor };
    }
    if (a.action === 'full_reply') {
      const message = await readTurnReply(this.service, bound, a.messageId);
      if (!message) throw new FileCommandError('此会话中没有该回复。');
      return this.turnCards.sendFullReply([e.destination,bound,executionScope], message, guard, reply, () => { effects.started = true; });
    }
    if (a.action === 'file') {
      const scope=executionScope;
      const files = await listAllArtifacts(this.service,bound);
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
    if(a.action==='notice_settings') {await guard(); const old=this.noticeSettings(e.destination,bound,executionScope); const priorPush=this.allowTurnPush(e.destination,bound,executionScope); if(old.revision!==a.settingsRevision) throw {detail:contractError('stale_revision','stale notification settings')}; const next={...old,...(a.field==='legacy'?{}:{[a.field]:a.value}),revision:old.revision+1}; const policyCursor = await this.noticePolicyCursor(bound, a.field !== 'waiting' && a.field !== 'failed', guard); this.db.exec('BEGIN IMMEDIATE'); try {if(a.field==='legacy') this.db.prepare("UPDATE channel_preferences SET event_types='[]' WHERE destination=? AND session_id=?").run(e.destination,bound); if(a.field==='paused' && !a.value) {this.db.prepare('UPDATE channel_preferences SET enabled=1 WHERE destination=? AND session_id=?').run(e.destination,bound);this.db.prepare("DELETE FROM channel_notice_markers WHERE destination=? AND session_id=? AND binding_scope=? AND category='waiting'").run(e.destination,bound,executionScope);} this.db.prepare('INSERT OR REPLACE INTO channel_notice_settings VALUES (?,?,?,?,?,?,?,?)').run(e.destination,bound,executionScope,Number(next.paused),Number(next.completed),Number(next.waiting),Number(next.failed),next.revision);if (policyCursor !== undefined) this.turnCards.noticePolicy([e.destination,bound,executionScope],this.noticePolicySequence(bound,policyCursor),priorPush,this.allowTurnPush(e.destination,bound,executionScope));this.db.exec('COMMIT');} catch(error) {this.db.exec('ROLLBACK');throw error;} const panel=this.noticePanel(e.destination,bound,executionScope,session);if(e.cardMessageId) await updateReply(buildSessionPanel(session,panel,this.accessMode(e.destination)==='interactive' ? await this.service.getWorkState(bound) : null));else await reply({title:'通知设置',...panel});return next; }
    if (a.action === 'notifications') {
      if (session.revision !== a.revision || session.control.generation !== a.controlGeneration) throw new Error('stale revision');
      const prior = this.allowTurnPush(e.destination,bound,executionScope);
      const cursor = await this.noticePolicyCursor(bound, true, guard);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT OR REPLACE INTO channel_preferences VALUES (?,?,?,?)').run(e.destination,bound,a.enabled ? 1 : 0,JSON.stringify(a.eventTypes));
        this.turnCards.noticePolicy([e.destination,bound,executionScope],this.noticePolicySequence(bound,cursor),prior,this.allowTurnPush(e.destination,bound,executionScope));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      await reply({title:'通知设置',text:a.enabled ? '通知已开启' : '通知已暂停',actions:[]});
      return {status:'completed',enabled:a.enabled,eventTypes:a.eventTypes};
    }
    if (a.action === 'models' || a.action === 'legacy_model') {
      if (a.action === 'legacy_model' && a.invalid) { await reply({title:'模型',text:'格式：/model <模型> [思考强度]；发送 /model 查看选项。',actions:[]}); return {status:'guidance'}; }
      if (a.action === 'legacy_model' && a.model) {
        const preferences: Record<string, string> = a.effort ? { reasoningEffort: a.effort } : {};
        const op=await this.service.updateSessionSettings({context:current(),payload:{model:a.model,preferences}});
        if (needsOperationNotice(op)) await reply(operationCard(op));
        return op;
      }
      const cursor = a.action === 'models' ? a.cursor : undefined;
      const {card,page} = await sessionModelPage(this.service,session,cursor,this.accessMode(e.destination)==='read_only');
      await (cursor ? replyOrUpdate : reply)(card); return page;
    }
    if (a.action === 'rename') {
      const cleaned = setCustomTopicTitle(this.db, e.destination, bound, a.title);
      await syncTopicRootTitle(this.db, this.port, e.destination, executionScope, session, card => this.stampCard(e.destination, card), guard);
      await reply({ title: '话题标题已更新', text: `已将当前话题标题设为：**${escapeCardMarkdown(cleaned)}**`, actions: [] });
      return { status: 'completed', title: cleaned };
    }
    if (a.action === 'swarm') {
      if (session.native.provider !== 'agy') { await reply(buildSwarmUnsupportedCard()); return {status:'rejected',reason:'unsupported'}; }
      if (this.accessMode(e.destination) === 'read_only') { await reply(buildSwarmReadOnlyAgyCard()); return {status:'rejected',reason:'read_only_binding'}; }
      const swarmOp = await this.service.submitInput({context:current(),mode:'new',blocks:[{type:'text',text:a.rawText}]});
      if (swarmOp.status !== 'queued' && swarmOp.status !== 'failed' && swarmOp.status !== 'unknown') return swarmOp;
      const card = operationCard(swarmOp); if (swarmOp.status === 'queued') card.actions.push({label:'查看排队',value:{action:'panel'}});
      await reply(card); return swarmOp;
    }
    if(a.action==='stop' && this.service.getTurn) {await guard();const turn=await this.service.getTurn(bound,a.turnId);await guard();if(turn && ['completed','failed','interrupted'].includes(turn.status)) {const label:Record<string,string>={completed:'已完成',failed:'已失败',interrupted:'已中断'};let text=`目标轮次${label[turn.status]}，未再次发出中断。`;if(turn.status==='interrupted'){const result=await this.service.inspectTurnResidual?.(bound,a.turnId);await guard();text=`${formatInterruptedTurn(result)}\n未再次发出中断。`;}await reply({title:'中断回复',text,actions:[]});return {status:'already_finished',turnStatus:turn.status};}}
    let op;
    let effectiveInputMode: 'new' | 'queue' | 'steer' | undefined;
    let queuedPreviewText: string | undefined;
    if (a.action === 'input') {
      effectiveInputMode =
        a.mode === 'new' &&
        session.status === 'running' &&
        session.capabilities?.steer?.status !== 'available' &&
        session.capabilities?.queue?.status === 'available'
          ? 'queue'
          : a.mode;
      queuedPreviewText = a.text;
      op = await this.service.submitInput({context:current(),mode:effectiveInputMode,blocks:[{type:'text',text:a.text}]});
    }
    else if (a.action === 'answer_form') {
      const i = await this.service.getInteraction(a.interactionId);
      if (i.sessionId !== bound) return {status:'rejected',reason:'invalid_or_expired_form'};
      const binding = this.db.prepare('SELECT binding_id FROM channel_bindings WHERE destination=?').get(e.destination) as {binding_id:string};
      let decoded;
      try { decoded=decodeQuestionForm(a,a.fields,i,binding.binding_id,this.accessMode(e.destination) === 'read_only'); }
      catch { await reply({title:'答复未提交',text:'问题已变化、已处理或答复无效，请刷新后重试。',actions:[]}); return {status:'rejected',reason:'invalid_or_expired_form'}; }
      op=await this.service.resolveInteraction({context:this.context(e,bound,decoded.revision,session.control.generation),interactionId:decoded.interactionId,expectedConnectionGeneration:decoded.connectionGeneration,answer:decoded.answer,toolInputDigest:null});
    }
    else if (a.action === 'answer') { const i = await this.service.getInteraction(a.interactionId); if (i.sessionId !== bound) throw new Error('interaction target mismatch'); op = await this.service.resolveInteraction({context:this.context(e,bound,a.revision,session.control.generation),interactionId:a.interactionId,expectedConnectionGeneration:a.connectionGeneration,answer:a.answer,toolInputDigest:a.toolInputDigest}); }
    else if (a.action === 'attachment') {
      if (a.mediaType === 'application/pdf' && a.localPath) {
        effectiveInputMode =
          a.mode === 'new' &&
          session.status === 'running' &&
          session.capabilities?.steer?.status !== 'available' &&
          session.capabilities?.queue?.status === 'available'
            ? 'queue'
            : a.mode;
        const byteSize = a.size ?? a.content.byteLength;
        const promptText = `用户上传了 PDF 附件：${a.name}（${byteSize} 字节）\n本地路径：${a.localPath}\n请使用 read_file 读取该文件。`;
        queuedPreviewText = promptText;
        op = await this.service.submitInput({context:current(),mode:effectiveInputMode,blocks:[{type:'text',text:promptText}]});
      } else {
        const stageContext = current();
        this.sessionBinding.recordPending(stageContext.operationId,e,bound,'artifact',a.mode);
        const digest = createHash('sha256').update(a.content).digest('hex');
        op = await this.service.stageInputArtifact({context:stageContext,payload:{name:a.name,mediaType:a.mediaType,size:a.content.byteLength,contentDigest:digest,content:a.content}});
      }
    }
    else { const ctx = this.context(e,bound,a.revision,a.controlGeneration); switch (a.action) {
      case 'stop': op = await this.service.interruptTurn({context:ctx,payload:{turnId:a.turnId}}); break;
      case 'control': op = a.release ? await this.service.releaseControl({context:ctx,payload:{owner:a.owner}}) : await this.service.requestControl({context:ctx,payload:{owner:a.owner,strategy:a.strategy}}); break;
      case 'settings': op = await this.service.updateSessionSettings({context:ctx,payload:{model:a.model,preferences:a.preferences}}); break;
      case 'cancel': op = await this.service.cancelQueuedInput({context:ctx,payload:{inputId:a.inputId}}); break;
      case 'archive': op = await this.service.archiveSession({context:ctx,payload:{archived:a.archived}}); break;
    } }
    if (a.action === 'answer' || a.action === 'answer_form') {
      if (this.channelOptions.onInteractionChanged) this.channelOptions.onInteractionChanged(bound,a.interactionId);
      else await this.refreshInteraction(e.destination,bound,a.interactionId);
      return op;
    }
    if ((a.action === 'cancel' || a.action === 'control') && e.cardMessageId && op.status === 'completed') {
      const currentSession = await this.service.getSession(bound);
      await updateReply(buildSessionPanel(currentSession,this.noticePanel(e.destination,bound,executionScope,currentSession),await this.service.getWorkState(bound)));
    } else if ((a.action === 'input' || (a.action === 'attachment' && a.mediaType === 'application/pdf' && a.localPath)) && (op.status === 'queued' || (effectiveInputMode === 'queue' && op.status === 'received'))) {
      const card = inputConfirmationCard('queue', queuedPreviewText ?? '');
      if (op.operationId) {
        card.actions.unshift({
          label: '撤回排队',
          value: { action: 'cancel', inputId: op.operationId, revision: session.revision, controlGeneration: session.control.generation },
        });
      }
      await reply(card);
    } else if (needsOperationNotice(op) && !await suppressInputFailure(this.service,op)) await reply(operationCard(op));
    return op;
  }
  private async readQuotaSnapshot(allowOfflineFallback: boolean): Promise<AgyQuotaSnapshot | null> {
    if (this.channelOptions.readQuota) {
      try { return await this.channelOptions.readQuota(); } catch { return null; }
    }
    if (!allowOfflineFallback) return null;
    try { return await queryAgyQuota({ offline: true }); } catch { return null; }
  }
  private noticeSettings(destination:string,sessionId:string,scope:string):{paused:boolean;completed:boolean;waiting:boolean;failed:boolean;revision:number} { const row=this.db.prepare('SELECT paused,completed,waiting,failed,revision FROM channel_notice_settings WHERE destination=? AND session_id=? AND binding_scope=?').get(destination,sessionId,scope) as {paused:number;completed:number;waiting:number;failed:number;revision:number}|undefined;const legacy=this.db.prepare('SELECT enabled FROM channel_preferences WHERE destination=? AND session_id=?').get(destination,sessionId) as {enabled:number}|undefined;return row ? {paused:!!row.paused || legacy?.enabled===0,completed:!!row.completed,waiting:!!row.waiting,failed:!!row.failed,revision:row.revision} : {paused:legacy?.enabled===0,completed:true,waiting:true,failed:true,revision:0}; }
  private noticePanel(destination:string,sessionId:string,scope:string,session:Session) {
    const legacy=this.db.prepare('SELECT event_types,enabled FROM channel_preferences WHERE destination=? AND session_id=?').get(destination,sessionId) as {event_types:string;enabled:number}|undefined;
    return noticePanel(session,this.noticeSettings(destination,sessionId,scope),legacy);
  }
  ownsInteractionCard(destination: string, sessionId: string, interactionId: string, messageId: string): boolean {
    return this.binding(destination) === sessionId &&
      this.interactionCards.owns(destination,sessionId,interactionId,messageId,this.bindingScope(destination));
  }
  async refreshInteraction(destination: string, sessionId: string, interactionId: string): Promise<void> {
    const scope = this.bindingScope(destination);
    if (this.binding(destination) !== sessionId) return;
    const notice = this.noticeSettings(destination,sessionId,scope);
    try {
      await this.interactionCards.render(destination,sessionId,interactionId,scope,!notice.paused && notice.waiting);
    } catch (error) {
      if (!(error instanceof BindingExpired || error instanceof ReadAuthorizationRevoked)) throw error;
    }
  }
  private async reconcileCards(destination:string, sessionId:string, scope:string): Promise<void> {
    const rows = this.db.prepare('SELECT interaction_id FROM channel_interaction_cards WHERE destination=? AND session_id=?').all(destination,sessionId) as Array<{interaction_id:string}>;
    for (const row of rows) await this.interactionCards.render(destination,sessionId,row.interaction_id,scope);
  }
  private allowTurnPush(destination: string, sessionId: string, scope: string): boolean {
    const notice = this.noticeSettings(destination,sessionId,scope);
    const preference = this.db.prepare('SELECT event_types FROM channel_preferences WHERE destination=? AND session_id=?')
      .get(destination,sessionId) as {event_types:string} | undefined;
    const types = preference ? JSON.parse(preference.event_types) as string[] : [];
    return !notice.paused && notice.completed && (!types.length || types.includes('turn.updated'));
  }

  private async noticePolicyCursor(sessionId: string, changed: boolean, guard: () => Promise<void>): Promise<string | undefined> {
    if (!changed) return;
    const cursor = this.service.eventWatermark ? '' : (await this.service.getSnapshot(sessionId)).cursor;
    await guard();
    return cursor;
  }
  private noticePolicySequence(sessionId: string, fallback?: string): number {
    return this.service.eventWatermark?.(sessionId) ?? eventSequence(sessionId, fallback);
  }

  /** Poll using the bound owner's current authorization. Timer wakes share this flight. */
  sync(destination: string): Promise<void> {
    const active = this.topicSyncs.get(destination);
    if (active) return active;
    const work = (async () => { while (await this.syncTopic(destination)) { /* advance the topic cursor */ } })()
      .finally(() => this.topicSyncs.delete(destination));
    this.topicSyncs.set(destination, work);
    return work;
  }

  private async syncTopic(destination: string): Promise<boolean> {
    const row=this.db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings WHERE destination=?').get(destination) as {session_id:string}|undefined; if(!row) throw new Error('destination is not bound'); const sessionId=row.session_id, scope=JSON.stringify(row);
    const syncGuard=()=>this.checkBinding(destination,sessionId,scope);
    const isExternallyWorking = (snap: SessionSnapshot): boolean => {
      if (snap.session.status !== 'read_only') return false;
      if (snap.turns?.some(t => t.status === 'running')) return true;
      const latest = snap.messages.at(-1);
      if (latest?.role === 'user' && snap.session.updatedAt) {
        const ageMs = Date.now() - Date.parse(snap.session.updatedAt);
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 120_000) return true;
      }
      return false;
    };
    const syncTitle=(snap:SessionSnapshot)=>syncTopicRootTitle(this.db,this.port,destination,scope,snap.session,card=>this.stampCard(destination,card),syncGuard,{externallyWorking:isExternallyWorking(snap)});
    const reconcileReleasedReadonly = (session: Session): boolean => {
      if (this.channelOptions.autoTakeControlOnInput && this.accessMode(destination) === 'interactive' && session.status === 'read_only' && session.control.owner === null) {
        this.db.prepare("UPDATE channel_bindings SET access_mode='read_only',binding_id=?,revision=revision+1 WHERE destination=? AND session_id=?")
          .run(randomUUID(), destination, sessionId);
        this.turnCards.discardOtherScopes(destination, this.bindingScope(destination));
        return true;
      }
      return false;
    };
    const sendSync=async(d:string,card:ChannelCard,id:string)=>{await syncGuard();const result=await this.deliver(d,card,`sync:${payloadDigest([scope,id])}`,syncGuard);await syncGuard();return result;};
    await syncGuard();
    const preference = this.db.prepare('SELECT enabled,event_types FROM channel_preferences WHERE destination=? AND session_id=?').get(destination,sessionId) as {enabled:number;event_types:string} | undefined;
    await this.reconcileCards(destination,sessionId,scope); await syncGuard();
    const notice=this.noticeSettings(destination,sessionId,scope); const allowWaiting=!notice.paused && notice.waiting;
    const eventTypes = preference ? JSON.parse(preference.event_types) as string[] : [];
    let expiredFrom: number | undefined;
    let more = false;
    let cursor = (this.db.prepare('SELECT cursor FROM channel_cursors WHERE destination=? AND session_id=? AND binding_scope=?').get(destination,sessionId,scope) as {cursor:string} | undefined)?.cursor;
    const allowedPush = () => this.allowTurnPush(destination,sessionId,scope);
    const scopeKey: [string, string, string] = [destination, sessionId, scope];
    const remember = this.db.prepare('INSERT OR REPLACE INTO channel_known_messages VALUES (?,?,?,?)');
    const known = this.db.prepare('SELECT revision FROM channel_known_messages WHERE destination=? AND session_id=? AND message_id=?');
    const unseen = (m: Message) => Number((known.get(destination,sessionId,m.messageId) as {revision:number}|undefined)?.revision ?? -1) < m.revision;
    const isCliReadonly = (session: Session) => this.accessMode(destination) === 'read_only' || session.status === 'read_only';
    const deliverCliPrompts = async (session: Session, candidates: readonly Message[]) => {
      if (!isCliReadonly(session) || !candidates.length) return;
      const ordered = [...candidates].sort((a, b) => a.sequence - b.sequence || a.messageId.localeCompare(b.messageId));
      for (const message of ordered) {
        if (message.role !== 'user' || !message.final || !unseen(message)) continue;
        if (this.turnCards.isBaselinedMessage(scopeKey, message.messageId, message.revision)) {
          remember.run(destination, sessionId, message.messageId, message.revision);
          continue;
        }
        const rawText = message.blocks
          .map(block => (block.type === 'text' ? block.text : `[附件 ${block.artifactId}]`))
          .join('\n')
          .trim();
        if (!rawText) {
          remember.run(destination, sessionId, message.messageId, message.revision);
          continue;
        }
        const chars = [...rawText];
        const body = chars.length > 1500 ? `${chars.slice(0, 1480).join('').trimEnd()}…（完整内容见 /history）` : rawText;
        const deliveryId = `cli-prompt:${payloadDigest([scope, destination, sessionId, message.messageId])}`;
        await syncGuard();
        if (this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(deliveryId).changes) {
          if (this.port.sendText) {
            await this.port.sendText(destination, `💻 CLI 指令：\n${body}`, deliveryId, syncGuard);
          } else {
            await this.port.send(destination, this.stampCard(destination, { title: '💻 CLI 指令', text: body, format: 'plain', actions: [] }), deliveryId, syncGuard);
          }
          await syncGuard();
          this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(deliveryId);
        }
        remember.run(destination, sessionId, message.messageId, message.revision);
      }
    };
    if (cursor) {
      const events = await this.service.subscribeEvents(sessionId,cursor,100); await syncGuard();
      if (events.status === 'events') {
        if (events.events.length === 0 && events.cursor === cursor) {
          const hasPendingCards = this.turnCards.hasPendingWork(scopeKey);
          const hasInteractionCards = Boolean(
            this.db.prepare('SELECT 1 FROM channel_interaction_cards WHERE destination=? AND session_id=? AND binding_scope=? LIMIT 1')
              .get(destination, sessionId, scope),
          );
          if (!hasPendingCards && !hasInteractionCards) {
            const session = await this.service.getSession(sessionId); await syncGuard();
            await syncTopicRootTitle(this.db, this.port, destination, scope, session, card => this.stampCard(destination, card), syncGuard);
            if (reconcileReleasedReadonly(session)) return true;
            return false;
          }
        }
        const snapshot=await this.service.getSnapshot(sessionId); await syncGuard();
        for (const i of snapshot.value.interactions) await this.interactionCards.render(destination,sessionId,i.interactionId,scope,allowWaiting);
        const messageIds = new Set(events.events.filter(event => event.type === 'message.updated').map(event => event.objectId));
        const userMessages = snapshot.value.messages.filter(message => message.role === 'user' && messageIds.has(message.messageId) && unseen(message));
        await deliverCliPrompts(snapshot.value.session, userMessages);
        const messages = snapshot.value.messages.filter(message => message.role === 'assistant' && messageIds.has(message.messageId) && unseen(message));
        await this.turnCards.sync(scopeKey, snapshot.value, events.events, messages, allowedPush);
        await syncGuard();
        await syncTitle(snapshot.value);
        if (reconcileReleasedReadonly(snapshot.value.session)) return true;
        for (const message of messages) if (message.final) remember.run(destination,sessionId,message.messageId,message.revision);
        let retryCount=0; let firstRetry='';
        const visible=events.events.filter(event=>!eventTypes.length || eventTypes.includes(event.type));
        const hasTurnFailure=visible.some(event=>event.type==='turn.updated' && (event.data as {status?:string}|null)?.status==='failed');
        for (const event of events.events) {
          await syncGuard();
          if (event.type === 'message.updated' || event.type === 'tool.updated' || event.type === 'artifact.available' ||
            event.type === 'turn.updated' && (event.data as {status?:string} | undefined)?.status === 'completed') continue;
          const data=event.data && typeof event.data==='object' ? event.data as Record<string,unknown> : {};
          const op=event.type.startsWith('operation.') ? operationFromReceipt(data) : null;
          if (op && await suppressInputFailure(this.service,op)) continue;
          if (op) await publishOperationFeedback(this.db,this.service,this.authorize,scopeKey,op,syncGuard,
            async session => buildSessionPanel(session,this.noticePanel(destination,sessionId,scope,session),await this.service.getWorkState(sessionId)),
            (envelope,card,suffix,guard) => this.deliverOrUpdate(envelope,card,suffix,guard,false));
          const statusValue=typeof data.status==='string' ? data.status : ''; const stopTurn=typeof data.turnId==='string'?data.turnId:event.objectId; const explicitStop=event.type==='turn.updated' && statusValue==='interrupted' && !!await this.service.hasStopRequest?.(sessionId,stopTurn); await syncGuard(); if((notice.paused || (eventTypes.length && !eventTypes.includes(event.type))) && !explicitStop) continue; const opId=typeof data.operationId==='string'?data.operationId:event.objectId; const previousOp=event.type.startsWith('operation.') ? this.db.prepare('SELECT state FROM channel_notice_operation_states WHERE destination=? AND session_id=? AND binding_scope=? AND operation_id=?').get(destination,sessionId,scope,opId) as {state:string}|undefined : undefined; if((event.type==='operation.unknown' && previousOp && previousOp.state!=='unknown') || (event.type==='operation.completed' && previousOp?.state==='completed')) continue; const resolvingUnknown=previousOp?.state==='unknown' && ['operation.failed','operation.completed'].includes(event.type); const resolving=event.type==='operation.completed' && resolvingUnknown; const category = event.type.startsWith('interaction.') || (event.type==='session.updated' && ['waiting_question','waiting_approval'].includes(statusValue)) ? 'waiting' : (resolving || event.type==='provider.api_retry' || event.type==='provider.usage_limit' || event.type==='adapter.stream_failed' || event.type==='operation.unknown' || event.type==='operation.failed' || (event.type==='turn.updated' && ['failed','interrupted'].includes(statusValue)) || (event.type==='session.updated' && statusValue==='failed')) ? 'failed' : (event.type==='turn.updated' && statusValue==='completed') ? 'completed' : null; if(category && !explicitStop && (notice.paused || !notice[category])) continue;
          if (event.type === 'provider.api_retry') { retryCount++; firstRetry ||= event.eventId; continue; }
          if (event.type === 'provider.usage_limit' && (data.status === 'rejected' || data.status === 'allowed_warning')) { await sendSync(destination,{title:'额度提示',text:data.status === 'rejected' ? '模型服务报告额度不足或受到限额，请稍后恢复后再使用。' : '模型服务提示额度接近限制，当前仍可继续。',actions:[]},`event:${destination}:${sessionId}:${event.eventId}`); continue; }
          if (event.type === 'provider.usage_available' && data.status === 'allowed') { await sendSync(destination,{title:'额度提示',text:'模型服务报告本次额度检查结果：可用。',actions:[]},`event:${destination}:${sessionId}:${event.eventId}`); continue; }
          const status=typeof data.status==='string' ? data.status : '';
          if(event.type==='session.updated' && !['waiting_question','waiting_approval'].includes(status)) this.db.prepare("DELETE FROM channel_notice_markers WHERE destination=? AND session_id=? AND binding_scope=? AND category='waiting'").run(destination,sessionId,scope);
          // Pending interaction cards above already present the question or approval.
          if (event.type==='interaction.created') continue;
          if (event.type==='operation.completed' && !resolving && typeof data.action==='string' && SUPPRESSED_COMPLETED_ACTIONS.has(data.action)) continue;
          if (event.type==='session.updated' && status==='failed' && hasTurnFailure) continue;
          const waitingSession=event.type==='session.updated' && ['waiting_question','waiting_approval'].includes(status);
          if (waitingSession && (snapshot.value.session.status!==status || snapshot.value.interactions.some(i=>['awaiting_answer','answer_pending_delivery'].includes(i.status) && (status==='waiting_approval' ? i.kind==='approval' : i.kind!=='approval')))) continue;
          const critical=event.type==='operation.failed' || event.type==='operation.unknown' || event.type==='operation.completed' || (event.type==='turn.updated' && ['failed','interrupted'].includes(status)) || (event.type==='session.updated' && ['failed','waiting_question','waiting_approval'].includes(status));
          if (critical) {
            const statusText:Record<string,string>={failed:'运行失败，未形成完整回复',interrupted:'本轮回复已中断，未形成完整回复；后台任务是否终止尚未确认',waiting_question:'等待回答',waiting_approval:'等待审批'};
            const waitingHint=this.accessMode(destination)==='read_only' && (snapshot.value.session.native.provider==='claude' || snapshot.value.session.native.provider==='agy') && ['waiting_question','waiting_approval'].includes(status) ? '；外部终端会话若仅同步等待状态，请回原终端处理。' : '';
            let card=event.type.startsWith('operation.') && typeof data.action==='string' && typeof data.status==='string' ? operationCard(data as unknown as import('./contracts.js').Operation) : {title:'会话更新',text:(statusText[status] ?? '会话状态已更新')+waitingHint,actions:[]}; if(event.type==='turn.updated' && status==='interrupted') {const turnId=typeof data.turnId==='string'?data.turnId:event.objectId; await syncGuard(); const residual=await this.service.inspectTurnResidual?.(sessionId,turnId);await syncGuard();card={...card,text:formatInterruptedTurn(residual)};}
            const linked=data.result && typeof data.result==='object' ? data.result as {kind?:string;turnId?:string} : undefined; const objectKey=category==='waiting' ? `${event.objectId}:${status}` : linked?.kind==='turn' && linked.turnId ? linked.turnId : event.type==='turn.updated' ? (typeof data.turnId==='string'?data.turnId:event.objectId) : event.objectId; const noticeKey=category==='failed' ? `${objectKey}:${status || event.type}` : objectKey; const exists=category && this.db.prepare('SELECT 1 FROM channel_notice_markers WHERE destination=? AND session_id=? AND binding_scope=? AND category=? AND object_key=?').get(destination,sessionId,scope,category,noticeKey); if(exists && !resolvingUnknown) continue;
            if(resolvingUnknown) {const old=this.db.prepare('SELECT message_id FROM channel_notice_operation_cards WHERE destination=? AND session_id=? AND binding_scope=? AND operation_id=?').get(destination,sessionId,scope,opId) as {message_id:string|null}|undefined; if(!old?.message_id) continue; const delivery=`operation-resolution:${payloadDigest([scope,destination,sessionId,opId,event.type])}`; if(!this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(delivery).changes) continue; await syncGuard();await this.port.update(destination,old.message_id,this.stampCard(destination,card),delivery,syncGuard);await syncGuard();this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(delivery);} else {const messageId=await sendSync(destination,card,`event:${destination}:${sessionId}:${event.eventId}`); if(event.type==='operation.unknown') this.db.prepare('INSERT OR REPLACE INTO channel_notice_operation_cards VALUES (?,?,?,?,?)').run(destination,sessionId,scope,opId,messageId ?? null);}  if(category) this.db.prepare('INSERT OR IGNORE INTO channel_notice_markers VALUES (?,?,?,?,?)').run(destination,sessionId,scope,category,noticeKey); if(event.type==='operation.unknown' || event.type==='operation.failed' || resolving) this.db.prepare('INSERT OR REPLACE INTO channel_notice_operation_states VALUES (?,?,?,?,?)').run(destination,sessionId,scope,opId,event.type.slice('operation.'.length));
          }
        }
        if (retryCount) { await syncGuard(); await sendSync(destination,{title:'连接重试',text:`模型服务正在重试（本次收到 ${retryCount} 次重试通知）。`,actions:[]},`retry:${destination}:${sessionId}:${firstRetry}:${events.cursor}`); }
        more = events.events.length === 100 && cursor !== events.cursor;
        cursor = events.cursor;
      } else { expiredFrom = eventSequence(sessionId,cursor); cursor = undefined; }
    }
    if (!cursor) {
      const snapshot = await this.service.getSnapshot(sessionId); await syncGuard();
      await syncTitle(snapshot.value);
      if (reconcileReleasedReadonly(snapshot.value.session)) return true;
      if (expiredFrom === undefined) this.turnCards.baseline(scopeKey,snapshot.cursor);
      if (expiredFrom !== undefined) {
        await deliverCliPrompts(snapshot.value.session, snapshot.value.messages.filter(m => m.role === 'user' && unseen(m)));
      }
      await this.turnCards.sync(scopeKey, snapshot.value, [], snapshot.value.messages.filter(m =>
        m.role === 'assistant' && (expiredFrom !== undefined ? unseen(m) : !m.final &&
          snapshot.value.turnProgress?.timing.some(t => t.turnId === m.turnId && t.liveStartSequence !== null && t.liveEndSequence === null))),
        allowedPush, expiredFrom);
      await syncGuard();
      for (const m of snapshot.value.messages) {
        if (expiredFrom === undefined || m.final) remember.run(destination,sessionId,m.messageId,m.revision);
      }
      for (const i of snapshot.value.interactions) await this.interactionCards.render(destination,sessionId,i.interactionId,scope,allowWaiting);
      cursor = snapshot.cursor;
    }
    await syncGuard();
    this.db.prepare('INSERT OR REPLACE INTO channel_cursors(destination,session_id,cursor,binding_scope) VALUES (?,?,?,?)').run(destination,sessionId,cursor,scope);
    return more && !this.closed;
  }
}
