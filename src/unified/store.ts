import { timestampMs, TurnProgressStore, turnProgressSchema } from './turn-progress-store.js';
import { isTerminalTurn, readToolProgress } from './tool-progress.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { answerDigest, questionDeclineAction, canTransitionOperation, payloadDigest, SCHEMA_VERSION, validateResolution, validateWriteContext, type Event, type EventSubscription, type Artifact, type Turn, type Interaction, type Message, type NativeResult, type Operation, type OperationStatus, type ResolveInteraction, type ResponseEvidence, type Session, type SessionSnapshot, type Snapshot, type WriteContext } from './contracts.js';
import { contractError, type ContractError, type ErrorCode } from './errors.js';
import type { PendingInteractionCandidate, StopResult } from './adapter.js';
import { reconcilePersistedAgyHistory } from './agy/transcript-reconciliation.js';

export class StoreError extends Error {
  constructor(readonly detail: ContractError) { super(detail.message ?? detail.code); }
}
const fail = (code: ErrorCode, message?: string): never => { throw new StoreError(contractError(code, message)); };
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
export const recoveryReleaseConfirmed = 'recovery verification failed; subscription released; reconciliation required';
const STOPPED_QUEUE = 'queued input cancelled by stop';
/** Responses have their own lease so the native input waiting for an answer cannot block it. */
export const responseLeaseKey = (interactionId: string): string => `interaction:${interactionId}`;
export const encodeCursor = (sessionId: string, sequence: number): string => Buffer.from(JSON.stringify([sessionId, sequence])).toString('base64url');
export function decodeCursor(value: string, sessionId: string): number {
  try { const c: unknown = JSON.parse(Buffer.from(value, 'base64url').toString()); if (Array.isArray(c) && c.length === 2 && c[0] === sessionId && Number.isSafeInteger(c[1]) && c[1] >= 0 && encodeCursor(sessionId, c[1]) === value) return c[1]; } catch { /* invalid cursor */ }
  return fail('invalid_request', 'invalid cursor');
}

type EventInput = Omit<Event, 'schemaVersion' | 'sequence' | 'cursor'>;
type EventKey = { _k: 1; s: string; q: number; v?: Event['schemaVersion']; d: string } &
  ({ i?: 1 } | { t: 'adapter.stream_failed'; o: string; u: 0 | 1 });

function compactEventKey(input: EventInput, sequence: number, version: Event['schemaVersion'], internal: boolean): EventKey {
  const key = { _k: 1 as const, s: input.sessionId, q: sequence, v: version, d: payloadDigest(input) };
  if (input.type === 'adapter.stream_failed') {
    const data = input.data as { definiteFailure?: boolean } | null;
    return { ...key, t: input.type, o: input.objectId, u: data?.definiteFailure === true ? 0 : 1 };
  }
  return internal ? { ...key, i: 1 } : key;
}

function isCompactEventKey(value: Event | EventKey): value is EventKey {
  return '_k' in value && value._k === 1;
}


/** Isolated store; callers authenticate identities and mediate all native effects. */
export class UnifiedStore {
  private db: DatabaseSync;
  private readonly turnProgress: TurnProgressStore;
  private readonly streamingEventIds = new Map<string, string>();
  private migrationLocked=false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // Per-connection timeout permits concurrent open without changing database contents.
    this.db.exec('PRAGMA busy_timeout=5000');
    // Refuse other databases before changing persistent pragmas or schema.
    const appId = Number((this.db.prepare('PRAGMA application_id').get() as Record<string, unknown>).application_id);
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Record<string, unknown>).user_version);
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (!((appId === 0 && version === 0 && tables.length === 0) || (appId === 0x554e4946 && version === 2))) { this.db.close(); throw new Error('refusing non-unified or unsupported database'); }
    try {
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS interactive_intent(session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS recovery_quarantine(session_id TEXT PRIMARY KEY, reason TEXT NOT NULL, connection_generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL, control_generation INTEGER NOT NULL, event_seq INTEGER NOT NULL DEFAULT 0, event_floor INTEGER NOT NULL DEFAULT 0, connection_generation INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_native_unique ON sessions(json_extract(value,'$.native.provider'),json_extract(value,'$.native.hostId'),json_extract(value,'$.native.serviceId'),json_extract(value,'$.native.nativeSessionId'));
      CREATE TABLE IF NOT EXISTS session_settings(session_id TEXT PRIMARY KEY REFERENCES sessions(id), value TEXT NOT NULL, revision INTEGER NOT NULL, operation_id TEXT NOT NULL REFERENCES operations(id));
      CREATE TABLE IF NOT EXISTS migration_receipts(migration_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_turns(operation_id TEXT PRIMARY KEY REFERENCES operations(id), session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL, UNIQUE(session_id,turn_id));
      CREATE TABLE IF NOT EXISTS tracking_state(session_id TEXT PRIMARY KEY REFERENCES sessions(id), detached INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS staged_artifacts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), value TEXT NOT NULL, content BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_leases(session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns(id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), value TEXT NOT NULL, PRIMARY KEY(session_id, id));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session_id);
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS interactions_by_session ON interactions(session_id);
      CREATE TABLE IF NOT EXISTS native_interactions(id TEXT PRIMARY KEY REFERENCES interactions(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, idem TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(operation_id TEXT PRIMARY KEY REFERENCES operations(id), kind TEXT NOT NULL, payload TEXT NOT NULL, context TEXT NOT NULL, connection_generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','in_flight','unknown','done','cancelled')));
      CREATE TABLE IF NOT EXISTS first_prompt_suspensions(operation_id TEXT PRIMARY KEY REFERENCES outbox(operation_id));
      CREATE TABLE IF NOT EXISTS steer_outbox_v1(operation_id TEXT PRIMARY KEY REFERENCES operations(id), kind TEXT NOT NULL, payload TEXT NOT NULL, context TEXT NOT NULL, connection_generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','in_flight','unknown','done','cancelled')));
      CREATE INDEX IF NOT EXISTS outbox_by_target ON outbox(json_extract(context,'$.targetId'),state,kind);
      CREATE INDEX IF NOT EXISTS steer_outbox_by_target ON steer_outbox_v1(json_extract(context,'$.targetId'),state,kind);
      CREATE INDEX IF NOT EXISTS outbox_by_interaction ON outbox(json_extract(payload,'$.interactionId')) WHERE kind='resolveInteraction';
      CREATE TABLE IF NOT EXISTS notification_preferences(session_id TEXT PRIMARY KEY REFERENCES sessions(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_keys(event_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL, value TEXT NOT NULL, UNIQUE(session_id, seq));
      ${turnProgressSchema}`);
    const columns = this.db.prepare('PRAGMA table_info(turns)').all();
    if (columns.some(column => column.name === 'session_id' && column.pk === 0)) {
      this.db.exec(`CREATE TABLE turns_v2(id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), value TEXT NOT NULL, PRIMARY KEY(session_id, id));
        INSERT INTO turns_v2(id,session_id,value) SELECT id,session_id,value FROM turns ORDER BY rowid;
        DROP TABLE turns;
        ALTER TABLE turns_v2 RENAME TO turns;`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id);
      PRAGMA application_id=1431193926; PRAGMA user_version=2; COMMIT;`);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.turnProgress = new TurnProgressStore(this.db);
  }
  close(): void { this.db.close(); }
  private transaction<T>(f: () => T): T { const nested=this.migrationLocked; this.db.exec(nested?'SAVEPOINT migration_op':'BEGIN IMMEDIATE'); try { const v=f(); this.db.exec(nested?'RELEASE migration_op':'COMMIT'); return v; } catch(e) { this.db.exec(nested?'ROLLBACK TO migration_op; RELEASE migration_op':'ROLLBACK'); throw e; } }
  private readTransaction<T>(f: () => T): T {
    const nested = this.migrationLocked;
    this.db.exec(nested ? 'SAVEPOINT migration_read' : 'BEGIN DEFERRED');
    try {
      const value = f();
      this.db.exec(nested ? 'RELEASE migration_read' : 'COMMIT');
      return value;
    } catch (error) {
      this.db.exec(nested ? 'ROLLBACK TO migration_read; RELEASE migration_read' : 'ROLLBACK');
      throw error;
    }
  }
  beginMigrationRollback():void { if(this.migrationLocked) throw new Error('migration lock already held'); this.db.exec('BEGIN IMMEDIATE'); this.migrationLocked=true; }
  endMigrationRollback(commit:boolean):void { if(!this.migrationLocked) throw new Error('migration lock not held'); try {this.db.exec(commit?'COMMIT':'ROLLBACK');} catch(e) {if(commit) {try {this.db.exec('ROLLBACK');} catch {}} throw e;} finally {this.migrationLocked=false;} }
  inspectMigrationSession(id:string,sessionId:string):'removable'|'retained'|'absent' { if(!this.migrationLocked) throw new Error('migration lock required'); this.db.exec('SAVEPOINT migration_inspect'); try {const result=this.rollbackMigrationSession(id); if(result==='retained' && !this.row('SELECT 1 AS present FROM sessions WHERE id=?',sessionId)) throw new Error('migration session missing despite receipt; manual review'); this.db.exec('ROLLBACK TO migration_inspect; RELEASE migration_inspect'); return result==='removed'?'removable':result==='absent' && this.row('SELECT 1 AS present FROM sessions WHERE id=?',sessionId)?'retained':result;} catch(e) {this.db.exec('ROLLBACK TO migration_inspect; RELEASE migration_inspect');throw e;} }

  private row(sql: string, ...args: (string | number)[]): Record<string, unknown> | undefined { return this.db.prepare(sql).get(...args) as Record<string, unknown> | undefined; }
  private run(sql: string, ...args: (string | number)[]): void { this.db.prepare(sql).run(...args); }
  private session(id: string): Session { const r = this.row('SELECT value FROM sessions WHERE id=?', id); if (!r) return fail('invalid_request', 'unknown session'); return parse<Session>(r.value); }
  getSession(id: string): Session { return this.session(id); }
  findInteraction(id: string): Interaction | null { const row = this.row('SELECT value FROM interactions WHERE id=?', id); return row ? parse<Interaction>(row.value) : null; }
  getInteraction(id: string): Interaction { return this.findInteraction(id) ?? fail('invalid_request', 'unknown interaction'); }
  getOperation(id: string): Operation { const r = this.row('SELECT value FROM operations WHERE id=?', id); if (!r) return fail('invalid_request', 'unknown operation'); return parse<Operation>(r.value); }
  /** Bootstrap a new normalized session. Existing IDs cannot be overwritten. */
  insertSession(session: Session): void { this.transaction(() => { if (this.findSession(session.native)) return fail('idempotency_conflict', 'native session already mapped'); this.run('INSERT INTO sessions(id,value,revision,control_generation) VALUES(?,?,?,?)', session.sessionId, JSON.stringify(session), session.revision, session.control.generation); }); }
  /** Each migration receipt is an immutable digest, checked against the live row on retry. */
  importMigrationSession(migrationId: string, session: Session): 'inserted' | 'already-imported' { return this.transaction(() => {
    if (!migrationId.trim() || !session.sessionId?.trim() || !session.native?.provider || !session.native.hostId?.trim() || !session.native.serviceId?.trim() || !session.native.nativeSessionId?.trim()) return fail('invalid_request','invalid migration session or id'); const digest = payloadDigest(session); const prior = this.row('SELECT session_id,digest,state FROM migration_receipts WHERE migration_id=?',migrationId);
    if (prior && (prior.digest !== digest || prior.session_id !== session.sessionId)) return fail('idempotency_conflict','migration receipt differs');
    const row = this.row('SELECT value FROM sessions WHERE id=?',session.sessionId);
    if (prior && prior.state !== 'removed') { if (!row || payloadDigest(parse<Session>(row.value)) !== digest) return fail('idempotency_conflict','imported session changed or missing'); return 'already-imported'; }
    if (row || this.findSession(session.native)) return fail('idempotency_conflict','session or native reference already exists');
    this.run('INSERT INTO sessions(id,value,revision,control_generation) VALUES(?,?,?,?)',session.sessionId,JSON.stringify(session),session.revision,session.control.generation);
    this.run("INSERT INTO migration_receipts(migration_id,session_id,digest,state) VALUES(?,?,?,'inserted') ON CONFLICT(migration_id) DO UPDATE SET state='inserted'",migrationId,session.sessionId,digest); return 'inserted';
  }); }
  rollbackMigrationSession(migrationId: string): 'removed' | 'retained' | 'absent' { return this.transaction(() => {
    const receipt = this.row('SELECT session_id,digest,state FROM migration_receipts WHERE migration_id=?',migrationId); if (!receipt || receipt.state === 'removed') return 'absent';
    const id=String(receipt.session_id); const row=this.row('SELECT value,event_seq,connection_generation FROM sessions WHERE id=?',id);
    if (!row || payloadDigest(parse<Session>(row.value)) !== receipt.digest || Number(row.event_seq) !== 0 || Number(row.connection_generation) !== 0) return 'retained';
    for (const table of ['turns','messages','interactions','staged_artifacts','tracking_state','notification_preferences','session_settings']) if (this.row(`SELECT 1 AS present FROM ${table} WHERE session_id=? LIMIT 1`,id)) return 'retained';
    if (this.row('SELECT 1 AS present FROM dispatch_leases WHERE session_id=? LIMIT 1',id) || this.row("SELECT 1 AS present FROM operations WHERE json_extract(value,'$.targetId')=? OR json_extract(value,'$.result.sessionId')=? LIMIT 1",id,id) || this.row("SELECT 1 AS present FROM event_keys WHERE json_extract(value,'$.sessionId')=? OR json_extract(value,'$.s')=? LIMIT 1",id,id)) return 'retained';
    this.run('DELETE FROM sessions WHERE id=?',id); this.run("UPDATE migration_receipts SET state='removed' WHERE migration_id=?",migrationId); return 'removed';
  }); }
  /** A lease is a write fence, not proof that any external client has released control. */
  acquireDispatchLease(sessionId: string, owner: string, now: number, ttl: number): number | null { return this.transaction(() => {
    const row = this.row('SELECT owner,expires,generation FROM dispatch_leases WHERE session_id=?',sessionId);
    if (row && Number(row.expires) > now) return null;
    const generation = row ? Number(row.generation) + 1 : 1;
    this.run('INSERT INTO dispatch_leases(session_id,owner,expires,generation) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires,generation=excluded.generation',sessionId,owner,now+ttl,generation); return generation;
  }); }
  assertDispatchLease(sessionId: string, owner: string, generation: number, now = Date.now()): void { const row = this.row('SELECT owner,expires,generation FROM dispatch_leases WHERE session_id=?',sessionId); if (!row || row.owner !== owner || Number(row.generation) !== generation || Number(row.expires) <= now) return fail('control_conflict','dispatch lease expired'); }
  releaseDispatchLease(sessionId: string, owner: string, generation: number): void { this.run('UPDATE dispatch_leases SET expires=0 WHERE session_id=? AND owner=? AND generation=?',sessionId,owner,generation); }
  isDetached(id: string): boolean { return Number(this.row('SELECT detached FROM tracking_state WHERE session_id=?',id)?.detached ?? 0) === 1; }
  detachTracking(context: WriteContext): Operation { return this.transaction(() => {
    const prior = this.existing(context,'detachSession',{}); if (prior.operation) return prior.operation;
    const session = this.session(context.targetId); if (session.revision !== context.expectedRevision) return fail('stale_revision'); if (session.control.generation !== context.controlGeneration) return fail('control_conflict');
    if (session.status !== 'idle' && session.status !== 'read_only') return fail('busy');
    if (this.listTurns(session.sessionId).some(t => t.status === 'running' || t.status === 'queued') || this.snapshotInteractions(session.sessionId).some(i => i.status === 'awaiting_answer' || i.status === 'answer_pending_delivery') || this.pendingOutbox().some(id=>this.getOutbox(id).context.targetId === session.sessionId)) return fail('busy');
    const op = this.receipt(context,'detachSession',prior.digest,{}); this.run('INSERT INTO tracking_state(session_id,detached) VALUES(?,1) ON CONFLICT(session_id) DO UPDATE SET detached=1',session.sessionId);
    const done: Operation = {...op,status:'completed',revision:1}; this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(done),op.operationId); this.run("UPDATE outbox SET state='done' WHERE operation_id=?",op.operationId); this.eventFor(session.sessionId,op.operationId,1,'session.detached',op.operationId,done); return done;
  }); }
  private snapshotInteractions(id: string): Interaction[] { return (this.db.prepare('SELECT value FROM interactions WHERE session_id=?').all(id) as Record<string,unknown>[]).map(r=>parse<Interaction>(r.value)); }
  stageArtifact(context: WriteContext, payload: {name:string;mediaType:string;size:number;contentDigest:string;content:Uint8Array}): Operation { return this.transaction(() => {
    if (!(payload.content instanceof Uint8Array) || payload.content.length !== payload.size || payload.size < 0 || payload.size > 20 * 1024 * 1024 || !payload.name || !payload.mediaType || createHash('sha256').update(payload.content).digest('hex') !== payload.contentDigest) return fail('invalid_request','invalid artifact size or digest');
    const data = {name:payload.name,mediaType:payload.mediaType,size:payload.size,contentDigest:payload.contentDigest}; const old = this.existing(context,'stageInputArtifact',data); if (old.operation) return old.operation;
    const session = this.session(context.targetId); if (session.revision !== context.expectedRevision) return fail('stale_revision'); if (session.control.generation !== context.controlGeneration) return fail('control_conflict');
    const op = this.receipt(context,'stageInputArtifact',old.digest,data); const artifact: Artifact = {artifactId:op.operationId,sessionId:session.sessionId,name:payload.name,mediaType:payload.mediaType,size:payload.size,contentVersion:payload.contentDigest};
    this.db.prepare('INSERT INTO staged_artifacts(id,session_id,value,content) VALUES(?,?,?,?)').run(artifact.artifactId,session.sessionId,JSON.stringify(artifact),payload.content);
    const done: Operation = {...op,status:'completed',revision:1,result:{kind:'artifact',artifactId:artifact.artifactId,contentVersion:artifact.contentVersion}}; this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(done),op.operationId); this.run("UPDATE outbox SET state='done' WHERE operation_id=?",op.operationId); this.eventFor(context.targetId,op.operationId,1,'artifact.staged',op.operationId,artifact); return done;
  }); }
  stagedArtifacts(sessionId: string): Artifact[] { this.session(sessionId); return (this.db.prepare('SELECT value FROM staged_artifacts WHERE session_id=? ORDER BY rowid').all(sessionId) as Record<string,unknown>[]).map(r=>parse<Artifact>(r.value)); }
  stagedArtifact(sessionId: string, id: string, version: string): Uint8Array | null { const row = this.row('SELECT session_id,value,content FROM staged_artifacts WHERE id=?',id); if (!row) return null; const item = parse<Artifact>(row.value); if (row.session_id !== sessionId || item.contentVersion !== version) return fail('invalid_request','artifact mismatch'); return Uint8Array.from(row.content as Uint8Array); }
  /** Creation is recorded before the external effect, without inventing a session. */
  registerCreate(context: WriteContext, payload: unknown): Operation { return this.transaction(() => {
    const prior = this.existing(context,'createSession',payload); if (prior.operation) return prior.operation;
    const op: Operation = {operationId:context.operationId,idempotencyKey:context.idempotencyKey,targetId:context.targetId,action:'createSession',payloadDigest:prior.digest,status:'received',revision:0,error:null};
    this.run('INSERT INTO operations(id,idem,digest,value) VALUES(?,?,?,?)',op.operationId,op.idempotencyKey,prior.digest,JSON.stringify(op));
    this.run('INSERT INTO outbox(operation_id,kind,payload,context,connection_generation,state) VALUES(?,?,?,?,?,?)',op.operationId,'createSession',JSON.stringify(payload),JSON.stringify(context),0,'pending'); return op;
  }); }
  claimCreate(id: string): boolean { return this.transaction(() => { const out = this.getOutbox(id); if (out.kind !== 'createSession' || out.state !== 'pending') return false; this.run("UPDATE outbox SET state='in_flight' WHERE operation_id=?",id); return true; }); }
  completeCreate(id: string, session: Session, connectionGeneration = 0): Operation { return this.transaction(() => {
    const out = this.getOutbox(id); const op = this.getOperation(id); if (out.kind !== 'createSession' || out.state !== 'in_flight' || op.status !== 'received' ) return fail('invalid_request');
    if (this.findSession(session.native)) return fail('idempotency_conflict','native session already mapped');
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0) return fail('invalid_request','invalid connection generation');
    this.run('INSERT INTO sessions(id,value,revision,control_generation,connection_generation) VALUES(?,?,?,?,?)',session.sessionId,JSON.stringify(session),session.revision,session.control.generation,connectionGeneration);
    this.run('INSERT OR IGNORE INTO interactive_intent(session_id) VALUES(?)',session.sessionId);
    // Creation completion is based on a uniquely verified provider listing, not the submit acknowledgement alone.
    const done: Operation = {...op,status:'completed',revision:1,result:{kind:'session',sessionId:session.sessionId}}; this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(done),id); this.run("UPDATE outbox SET state='done' WHERE operation_id=?",id); this.eventFor(session.sessionId,id,1,'operation.completed',id,done); return done;
  }); }
  quarantineRecovery(id:string, reason:string, generation=this.connectionGeneration(id)):void {
    this.run(`INSERT INTO recovery_quarantine(session_id,reason,connection_generation) VALUES(?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET reason=excluded.reason,connection_generation=MAX(connection_generation,excluded.connection_generation)`,id,reason,generation);
  }
  getRecoveryQuarantine(id:string):{generation:number;releaseConfirmed:boolean}|null {
    const row=this.row('SELECT reason,connection_generation FROM recovery_quarantine WHERE session_id=?',id);
    return row ? {generation:Number(row.connection_generation),releaseConfirmed:row.reason===recoveryReleaseConfirmed} : null;
  }
  recoveryQuarantineCount():number { return Number(this.row('SELECT COUNT(*) AS count FROM recovery_quarantine')?.count ?? 0); }
  recoveryQuarantined(id:string):boolean { return !!this.row('SELECT session_id FROM recovery_quarantine WHERE session_id=?',id); }
  hasInteractiveIntent(id:string):boolean { return !!this.row('SELECT session_id FROM interactive_intent WHERE session_id=?',id); }
  maxConnectionGeneration(): number {
    const row = this.row(`SELECT MAX(value) AS value FROM (
      SELECT MAX(connection_generation) AS value FROM sessions
      UNION ALL SELECT MAX(connection_generation) FROM recovery_quarantine
    )`);
    return Number(row?.value ?? 0);
  }
  /** Attach a native mapping and an idempotent bootstrap receipt in one transaction. */
  attachSession(context: WriteContext, session: Session, payload: unknown, connectionGeneration: number | null = null, observed?: {messages:Message[];interactions:Interaction[];turns?:Turn[]}, recoverQuarantine = false): Operation { return this.transaction(() => {
    const old = this.existing(context, 'attachSession', payload); if (old.operation) return old.operation;
    if (connectionGeneration !== null && (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0)) return fail('invalid_request','invalid connection generation');
    const existing = this.findSession(session.native); const mapped = existing ?? session;
    const previousGeneration = existing ? this.connectionGeneration(mapped.sessionId) : null;
    if (!existing) this.run('INSERT INTO sessions(id,value,revision,control_generation,connection_generation) VALUES(?,?,?,?,?)',mapped.sessionId,JSON.stringify(mapped),mapped.revision,mapped.control.generation,connectionGeneration ?? 0);
    else if (previousGeneration !== null && connectionGeneration !== null && connectionGeneration !== previousGeneration) {
      if (connectionGeneration < previousGeneration) return fail('interaction_expired', 'stale connection generation');
      this.setConnectionGenerationInTransaction(mapped.sessionId, previousGeneration, connectionGeneration);
    }
    if (existing && (payload as {mode?:string}).mode === 'interactive') {
      const current=this.getSession(existing.sessionId);
      if (session.control.generation <= current.control.generation) return fail('control_conflict','control generation must advance');
      const updated={...session,sessionId:existing.sessionId,revision:current.revision+1};
      const reconciled = recoverQuarantine && connectionGeneration !== null && connectionGeneration === previousGeneration;
      if (reconciled) {
        if (!observed) return fail('invalid_request', 'recovery requires a native snapshot');
        this.reconcileRecoveryInteractions(mapped.sessionId, connectionGeneration, observed.interactions);
      }
      this.updateSessionInTransaction(updated,current,reconciled);
    }
    if (observed) {
      if (existing?.native.provider === 'agy') {
        observed = this.reconcileAgyHistoryInTransaction(observed, this.messageMap(mapped.sessionId));
      }
      for (const native of observed.turns ?? []) this.putTurnInTransaction({...native,sessionId:mapped.sessionId});
      for (const native of observed.messages) { const value={...native,sessionId:mapped.sessionId}; const prior=this.row('SELECT session_id FROM messages WHERE id=?',value.messageId); if(prior && prior.session_id !== mapped.sessionId) return fail('idempotency_conflict','message id belongs to another session'); if(!prior) { this.run('INSERT INTO messages(id,session_id,value) VALUES(?,?,?)',value.messageId,mapped.sessionId,JSON.stringify(value)); this.eventFor(mapped.sessionId,value.messageId,value.revision,'message.updated',null,value); } }
      for (const native of observed.interactions) { const value={...native,sessionId:mapped.sessionId}; const prior=this.row('SELECT session_id FROM interactions WHERE id=?',value.interactionId); if(prior && prior.session_id !== mapped.sessionId) return fail('idempotency_conflict','interaction id belongs to another session'); if(!prior) { if(value.connectionGeneration !== this.connectionGeneration(mapped.sessionId)) return fail('interaction_expired'); this.run('INSERT INTO interactions(id,session_id,value) VALUES(?,?,?)',value.interactionId,mapped.sessionId,JSON.stringify(value)); if(native.status === 'awaiting_answer') this.run('INSERT INTO native_interactions(id,value) VALUES(?,?)',value.interactionId,JSON.stringify(native)); this.eventFor(mapped.sessionId,value.interactionId,value.revision,'interaction.created',null,value); } }
    }
    if ((payload as {mode?:string}).mode === 'interactive') this.run('INSERT OR IGNORE INTO interactive_intent(session_id) VALUES(?)',mapped.sessionId);
    const op: Operation = {operationId:context.operationId,idempotencyKey:context.idempotencyKey,targetId:context.targetId,action:'attachSession',payloadDigest:old.digest,status:'completed',revision:1,error:null,result:{kind:'session',sessionId:mapped.sessionId}};
    this.run('INSERT INTO operations(id,idem,digest,value) VALUES(?,?,?,?)',op.operationId,op.idempotencyKey,old.digest,JSON.stringify(op));
    this.run('INSERT INTO outbox(operation_id,kind,payload,context,connection_generation,state) VALUES(?,?,?,?,?,?)',op.operationId,'attachSession',JSON.stringify(payload),JSON.stringify(context),connectionGeneration ?? 0,'done');
    if (recoverQuarantine) this.run('DELETE FROM recovery_quarantine WHERE session_id=?',mapped.sessionId);
    this.eventFor(mapped.sessionId,op.operationId,1,'operation.completed',op.operationId,op);return op;
  }); }
  /** Record a new attach receipt for an already-authorized unchanged session. */
  reuseAttachedSession(context:WriteContext, session:Session, payload:unknown):Operation { return this.transaction(()=>{
    const old=this.existing(context,'attachSession',payload); if(old.operation) return old.operation;
    const current=this.findSession(session.native); if(!current || payloadDigest(current)!==payloadDigest(session) || this.isDetached(current.sessionId)) return fail('control_conflict','attached session changed');
    if ((payload as {mode?:string}).mode === 'interactive') this.run('INSERT OR IGNORE INTO interactive_intent(session_id) VALUES(?)',current.sessionId);
    const op:Operation={operationId:context.operationId,idempotencyKey:context.idempotencyKey,targetId:context.targetId,action:'attachSession',payloadDigest:old.digest,status:'completed',revision:1,error:null,result:{kind:'session',sessionId:current.sessionId}};
    this.run('INSERT INTO operations(id,idem,digest,value) VALUES(?,?,?,?)',op.operationId,op.idempotencyKey,old.digest,JSON.stringify(op));
    this.run('INSERT INTO outbox(operation_id,kind,payload,context,connection_generation,state) VALUES(?,?,?,?,?,?)',op.operationId,'attachSession',JSON.stringify(payload),JSON.stringify(context),this.connectionGeneration(current.sessionId),'done');
    this.eventFor(current.sessionId,op.operationId,1,'operation.completed',op.operationId,op); return op;
  }); }
  private settleTurn(turn: Turn): void {
    if (!isTerminalTurn(turn.status)) return;
    this.settleInterruptsInTransaction(turn);
    const row = this.row('SELECT operation_id FROM operation_turns WHERE session_id=? AND turn_id=?',turn.sessionId,turn.turnId); if (!row) return;
    const id=String(row.operation_id), op=this.getOperation(id); if (op.status !== 'accepted' && op.status !== 'unknown') return;
    const status = turn.status === 'completed' ? 'completed' : 'failed'; const next: Operation = {...op,status,revision:op.revision+1,error:null,result:{kind:'turn',turnId:turn.turnId,status:turn.status as 'completed'|'failed'|'interrupted'}};
    this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(next),id); this.run("UPDATE outbox SET state='done' WHERE operation_id=?",id); this.eventFor(turn.sessionId,id,next.revision,`operation.${status}`,id,next);
  }
  private settleInterruptsInTransaction(turn: Turn): void {
    const rows = this.db.prepare(`SELECT operation_id,state FROM outbox
      WHERE kind='interruptTurn' AND state IN ('pending','in_flight','unknown')
        AND json_extract(context,'$.targetId')=? AND json_extract(payload,'$.turnId')=?`).all(turn.sessionId,turn.turnId);
    if (!rows.length) return;
    const uncertain = turn.status === 'failed' && this.hasUncertainTurnOutcome(turn.sessionId,turn.turnId);
    for (const row of rows) {
      const id = String(row.operation_id);
      const op = this.getOperation(id);
      if (uncertain) {
        if (row.state === 'in_flight') this.markUnknownInTransaction(id);
        if (row.state === 'pending') {
          this.updateOperationInTransaction(op,'unknown',contractError('outcome_unknown'));
          this.run("UPDATE outbox SET state='unknown' WHERE operation_id=?",id);
        }
        continue;
      }
      if (row.state !== 'pending' && turn.status === 'interrupted') {
        const accepted = op.status === 'received' ? this.updateOperationInTransaction(op,'accepted') : op;
        this.updateOperationInTransaction(accepted,'completed');
      } else {
        this.updateOperationInTransaction(op,'failed',contractError('busy','turn is no longer running'));
      }
      this.run("UPDATE outbox SET state='done' WHERE operation_id=?",id);
    }
  }
  private hasUncertainTurnOutcome(sessionId: string, turnId: string): boolean {
    const predicate = `json_extract(value,'$.objectId')=?
      AND json_extract(value,'$.type')='adapter.stream_failed'
      AND json_extract(value,'$.data.definiteFailure') IS NOT 1`;
    return !!this.row(`SELECT 1 FROM events WHERE session_id=? AND ${predicate} LIMIT 1`,sessionId,turnId) ||
      (this.eventFloor(sessionId) > 0 && !!this.row(`SELECT 1 FROM event_keys
        WHERE (json_extract(value,'$._k')=1 AND json_extract(value,'$.s')=?
          AND json_extract(value,'$.o')=? AND json_extract(value,'$.t')='adapter.stream_failed'
          AND json_extract(value,'$.u')=1)
        OR (json_extract(value,'$._k') IS NULL AND json_extract(value,'$.sessionId')=? AND ${predicate})
        LIMIT 1`,sessionId,turnId,sessionId,turnId));
  }
  confirmedSettings(id: string): {model:string|null; preferences:Record<string,string>; revision:number} | null { this.session(id); const row=this.row('SELECT value,revision FROM session_settings WHERE session_id=?',id); return row ? {...parse<{model:string|null;preferences:Record<string,string>}>(row.value),revision:Number(row.revision)} : null; }
  settingsBarrier(id: string): 'pending' | 'unknown' | null {
    const rows = this.db.prepare("SELECT state FROM outbox WHERE json_extract(context,'$.targetId')=? AND kind='updateSessionSettings' AND state IN ('pending','in_flight','unknown')").all(id);
    return rows.some(row => row.state === 'unknown') ? 'unknown' : rows.length ? 'pending' : null;
  }
  confirmSettings(id: string, value: {model:string|null;preferences:Record<string,string>}): Operation { return this.transaction(()=>{
    const op=this.getOperation(id), out=this.getOutbox(id); if(op.action!=='updateSessionSettings'||out.state!=='in_flight'||op.status!=='received'||payloadDigest(out.payload)!==payloadDigest(value)) return fail('invalid_request');
    this.run('INSERT INTO session_settings(session_id,value,revision,operation_id) VALUES(?,?,1,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value,revision=session_settings.revision+1,operation_id=excluded.operation_id',op.targetId,JSON.stringify(value),id);
    const accepted:Operation={...op,status:'accepted',revision:op.revision+1};this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(accepted),id);this.eventFor(op.targetId,id,accepted.revision,'operation.accepted',id,accepted);
    const done:Operation={...accepted,status:'completed',revision:accepted.revision+1};this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(done),id);this.run("UPDATE outbox SET state='done' WHERE operation_id=?",id);this.eventFor(op.targetId,id,done.revision,'operation.completed',id,done);return done;
  }); }
  /** Persist the actual native turn reference and handle observations that arrived before the acknowledgement. */
  acceptSubmission(id: string, nativeReference: string | null, mergedIds: readonly string[] = []): Operation { return this.transaction(() => {
    const op=this.getOperation(id); const out=this.getOutbox(id); if (out.kind === 'resolveInteraction' || out.state !== 'in_flight' || !canTransitionOperation(op.status,'accepted')) return fail('invalid_request');
    if (op.action === 'submitInput' && nativeReference) this.run('INSERT INTO operation_turns(operation_id,session_id,turn_id) VALUES(?,?,?)',id,op.targetId,nativeReference);
    const next: Operation = {...op,status:'accepted',revision:op.revision+1,error:null}; this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(next),id); this.eventFor(op.targetId,id,next.revision,'operation.accepted',id,next);
    for (const mergedId of mergedIds) {
      const mergedOp = this.getOperation(mergedId);
      const mergedOut = this.getOutbox(mergedId);
      if (mergedOut.state !== 'in_flight') continue;
      const acceptedMerged = canTransitionOperation(mergedOp.status, 'accepted')
        ? this.updateOperationInTransaction(mergedOp, 'accepted')
        : mergedOp;
      if (canTransitionOperation(acceptedMerged.status, 'completed')) {
        this.updateOperationInTransaction(acceptedMerged, 'completed');
      }
      this.run("UPDATE outbox SET state='done' WHERE operation_id=?", mergedId);
    }
    if (op.action === 'submitInput' && nativeReference) {const row=this.row('SELECT value FROM turns WHERE id=? AND session_id=?',nativeReference,op.targetId); if(row) this.settleTurn(parse<Turn>(row.value));}
    if (out.kind === 'archiveSession') {
      const current = this.session(op.targetId), { archived } = out.payload as { archived: boolean };
      if (current.archived !== archived) this.updateSessionInTransaction({...current, archived, revision:current.revision+1},current);
      this.run("UPDATE outbox SET state='done' WHERE operation_id=?",id);
    }
    return this.getOperation(id);
  }); }
  /** A locally written reply has no remaining send work. Keep its payload for native evidence. */
  acceptResponseSubmission(id: string): Operation { return this.transaction(() => {
    const op = this.getOperation(id), out = this.getOutbox(id);
    if (out.kind !== 'resolveInteraction' || op.action !== out.kind || out.state === 'pending') return fail('invalid_request');
    if (out.state !== 'in_flight') return op;
    if (op.status !== 'accepted' && !canTransitionOperation(op.status, 'accepted')) return fail('invalid_request');
    const accepted = op.status === 'accepted' ? op : this.updateOperationInTransaction(op, 'accepted');
    this.run("UPDATE outbox SET state='done' WHERE operation_id=?", id);
    return accepted;
  }); }
  private updateOperationInTransaction(op: Operation, status: OperationStatus, error: ContractError | null = null): Operation {
    const next: Operation = { ...op, status, revision: op.revision + 1, error };
    this.run('UPDATE operations SET value=? WHERE id=?', JSON.stringify(next), op.operationId);
    this.eventFor(op.targetId, op.operationId, next.revision, `operation.${status}`, op.operationId, next);
    return next;
  }
  completeControl(id: string, observed: Session, connectionGeneration?: number): Operation { return this.transaction(() => {
    const op = this.getOperation(id), out = this.getOutbox(id), current = this.session(op.targetId);
    if (out.state !== 'in_flight' || !['requestControl','releaseControl'].includes(out.kind) ||
        current.control.generation !== out.context.controlGeneration || this.connectionGeneration(current.sessionId) !== out.connectionGeneration) return fail('control_conflict');
    const done = this.updateOperationInTransaction(this.updateOperationInTransaction(op,'accepted'),'completed');
    this.run("UPDATE outbox SET state='done' WHERE operation_id=?",id);
    if (out.kind === 'releaseControl') this.run('DELETE FROM interactive_intent WHERE session_id=?',current.sessionId);
    else this.run('INSERT OR IGNORE INTO interactive_intent(session_id) VALUES(?)',current.sessionId);
    if (connectionGeneration !== undefined && connectionGeneration !== out.connectionGeneration) {
      this.setConnectionGenerationInTransaction(current.sessionId,out.connectionGeneration,connectionGeneration);
    }
    this.updateSessionInTransaction({...observed,revision:current.revision+1},current);
    return done;
  }); }
  private putTurnInTransaction(turn: Turn, observedAt?: number): boolean {
    this.session(turn.sessionId);
    const old = this.row('SELECT value FROM turns WHERE session_id=? AND id=?',turn.sessionId,turn.turnId);
    const prior = old ? parse<Turn>(old.value) : undefined;
    if (prior && prior.sessionId !== turn.sessionId) return fail('invalid_request');
    const next = { ...turn, startedAt: timestampMs(turn.startedAt) !== null ? turn.startedAt : prior?.startedAt ?? null };
    const generation = this.connectionGeneration(turn.sessionId);
    if (prior && (isTerminalTurn(prior.status) || payloadDigest(prior) === payloadDigest(next))) {
      // A history write can win the race with the matching live observation.
      // Give new live evidence its own cursor even when the turn JSON is unchanged.
      const recorded = observedAt !== undefined && turn.status === prior.status &&
        this.turnProgress.recordTurn(turn, generation, this.eventWatermark(turn.sessionId) + 1, observedAt, true);
      if (recorded) this.eventFor(prior.sessionId,prior.turnId,0,'turn.updated',null,prior);
      this.settleTurn(prior);
      return recorded;
    }
    this.run('INSERT INTO turns(id,session_id,value) VALUES(?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET value=excluded.value',
      next.turnId,next.sessionId,JSON.stringify(next));
    const event = this.eventFor(next.sessionId,next.turnId,0,'turn.updated',null,next);
    this.turnProgress.recordTurn(turn,generation,event.sequence,observedAt);
    this.settleTurn(next);
    return true;
  }
  putTurn(turn: Turn): void { this.transaction(() => this.putTurnInTransaction(turn)); }
  /** Record already-proven old terminal turns as baseline without emitting historical events. */
  baselineReadonlyTurns(sessionId:string,turns:Turn[]):void { this.transaction(()=>{
    const current=this.session(sessionId);
    if(current.status!=='read_only'||current.control.input==='available')return fail('busy');
    for(const turn of turns) {
      if(turn.sessionId!==sessionId||!isTerminalTurn(turn.status))return fail('invalid_request');
      const row=this.row('SELECT value FROM turns WHERE session_id=? AND id=?',sessionId,turn.turnId);
      if(row) {
        const prior=parse<Turn>(row.value);
        if(prior.sessionId!==sessionId)return fail('invalid_request');
        if(isTerminalTurn(prior.status))continue;
        this.turnProgress.recordTurn(turn,this.connectionGeneration(sessionId),this.eventWatermark(sessionId));
      }
      this.run('INSERT INTO turns(id,session_id,value) VALUES(?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET value=excluded.value',
        turn.turnId,sessionId,JSON.stringify(turn));
    }
  }); }

  operationTurn(id:string): {sessionId:string;turnId:string} | null { const row=this.row('SELECT session_id,turn_id FROM operation_turns WHERE operation_id=?',id); return row ? {sessionId:String(row.session_id),turnId:String(row.turn_id)} : null; }
  hasActiveBridgeTurn(sessionId: string): boolean {
    return !!this.row(
      "SELECT 1 FROM operation_turns ot JOIN turns t ON t.id = ot.turn_id AND t.session_id = ot.session_id WHERE ot.session_id=? AND json_extract(t.value,'$.status') IN ('running','queued') LIMIT 1",
      sessionId,
    );
  }
  unknownOperationIds(): string[] {
    const rows = this.db.prepare("SELECT id FROM operations WHERE json_extract(value,'$.status')='unknown' ORDER BY rowid").all() as Array<{ id: string }>;
    return rows.map(r => String(r.id));
  }
  /** Apply live turn evidence and its session status atomically; stale terminals never clear newer work. */
  observeTurn(turn: Turn, observedAt = Date.now()): boolean {
    return this.transaction(() => this.applyCurrentTurnInTransaction(turn, observedAt));
  }
  reconcileTurn(turn: Turn): void {
    this.transaction(() => this.applyCurrentTurnInTransaction(turn));
  }
  private applyCurrentTurnInTransaction(turn: Turn, observedAt?: number): boolean {
    const current=this.session(turn.sessionId), previous=this.listTurns(turn.sessionId).find(t=>t.turnId===turn.turnId);
    const changed = this.putTurnInTransaction(turn, observedAt);
    if (!this.canObserveRunStatus(current)) return changed;
    const interactions=this.snapshotInteractions(turn.sessionId).filter(i=>i.status==='awaiting_answer'||i.status==='answer_pending_delivery');
    const active=this.listTurns(turn.sessionId).some(t=>t.status==='running'||t.status==='queued');
    let status=current.status;
    if (interactions.length) status=interactions.some(i=>i.kind==='approval') ? 'waiting_approval' : 'waiting_question';
    else if (active) status='running';
    else if (isTerminalTurn(turn.status) && (previous?.status==='running' || previous?.status==='queued' ||
        changed && previous?.status===turn.status && current.status==='running' ||
        !previous && this.row('SELECT turn_id FROM operation_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 1',turn.sessionId)?.turn_id===turn.turnId)) {
      status=turn.status==='completed' ? 'idle' : turn.status as 'failed'|'interrupted';
    }
    if (status!==current.status) this.updateSessionInTransaction({...current,status,revision:current.revision+1},current);
    return changed;
  }
  observeInteractionStatus(sessionId:string, turnId:string): void { this.transaction(() => {
    const current=this.session(sessionId); if (!this.canObserveRunStatus(current)) return;
    const interactions=this.snapshotInteractions(sessionId).filter(i=>i.status==='awaiting_answer'||i.status==='answer_pending_delivery');
    const turns=this.listTurns(sessionId); let status=current.status;
    if(interactions.length) status=interactions.some(i=>i.kind==='approval') ? 'waiting_approval' : 'waiting_question';
    else if (turns.some(t=>t.status==='running'||t.status==='queued')) status='running';
    else if (['waiting_question','waiting_approval'].includes(current.status)) {
      const latest = turns.some(turn=>turn.turnId===turnId) ? turns.at(-1) : undefined;
      status = latest?.status === 'failed' || latest?.status === 'interrupted' ? latest.status : 'idle';
    }
    if (status!==current.status) this.updateSessionInTransaction({...current,status,revision:current.revision+1},current);
  }); }
  private canObserveRunStatus(session: Session): boolean {
    return session.control.input === 'available' &&
      ['idle','running','waiting_question','waiting_approval','failed','interrupted'].includes(session.status) &&
      !this.isDetached(session.sessionId) && !this.recoveryQuarantined(session.sessionId);
  }
  listTurns(sessionId: string): Turn[] { this.session(sessionId); return (this.db.prepare('SELECT value FROM turns WHERE session_id=? ORDER BY rowid').all(sessionId) as Record<string,unknown>[]).map(r => parse<Turn>(r.value)); }
  queuedInputs(sessionId:string): Array<{inputId:string}> { this.session(sessionId); return this.pendingOutbox(sessionId,'submitInput').filter(id=>(this.getOutbox(id).payload as {mode?:string}).mode==='queue').map(inputId=>({inputId})); }
  cancelQueuedInput(context: WriteContext, inputId: string): Operation { return this.transaction(() => {
    const payload = {inputId}; const existing = this.existing(context,'cancelQueuedInput',payload); if (existing.operation) return existing.operation;
    const out = this.getOutbox(inputId); if (out.context.targetId !== context.targetId || out.kind !== 'submitInput' || (out.payload as {mode?: string}).mode !== 'queue' || out.state !== 'pending') return fail('busy','input is no longer queued');
    if (out.context.identity.source !== context.identity.source || out.context.identity.subject !== context.identity.subject) return fail('unauthorized');
    this.cancelPending(inputId); const op = this.receipt(context,'cancelQueuedInput',existing.digest,payload); const done: Operation = {...op,status:'completed',revision:1}; this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(done),op.operationId); this.run("UPDATE outbox SET state='done' WHERE operation_id=?",op.operationId); this.eventFor(context.targetId,op.operationId,1,'operation.completed',op.operationId,done); return done;
  }); }
  /** Stable insertion ordering supports restart-safe pagination. */
  listSessions(): Session[] { return (this.db.prepare('SELECT value FROM sessions ORDER BY rowid').all() as Record<string, unknown>[]).map(r => parse<Session>(r.value)); }
  listPendingInteractionCandidates(): PendingInteractionCandidate[] {
    return this.readTransaction(() => {
      const pending = this.db.prepare(`
        SELECT session_id, value FROM interactions
        WHERE json_extract(value,'$.status') IN ('awaiting_answer','answer_pending_delivery') ORDER BY rowid
      `).all();
      const bySession = new Map<string, Interaction[]>();
      for (const row of pending) {
        const id = String(row.session_id);
        let interactions = bySession.get(id);
        if (!interactions) bySession.set(id, interactions = []);
        interactions.push(parse<Interaction>(row.value));
      }
      const sessions = this.db.prepare(`
        SELECT id, value, connection_generation FROM sessions
        WHERE (json_extract(value,'$.status')='waiting_approval' OR id IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS (SELECT 1 FROM tracking_state WHERE session_id=sessions.id AND detached=1)
        ORDER BY rowid
      `).all(JSON.stringify([...bySession.keys()]));
      return sessions.map(row => ({
        session: parse<Session>(row.value),
        connectionGeneration: Number(row.connection_generation),
        interactions: bySession.get(String(row.id)) ?? [],
      }));
    });
  }
  findSession(native: Session['native']): Session | undefined { const row = this.row("SELECT value FROM sessions WHERE json_extract(value,'$.native.provider')=? AND json_extract(value,'$.native.hostId')=? AND json_extract(value,'$.native.serviceId')=? AND json_extract(value,'$.native.nativeSessionId')=?",native.provider,native.hostId,native.serviceId,native.nativeSessionId); return row ? parse<Session>(row.value) : undefined; }
  connectionGeneration(id: string): number { const row = this.row('SELECT connection_generation FROM sessions WHERE id=?', id); if (!row) return fail('invalid_request', 'unknown session'); return Number(row.connection_generation); }
  hasUnsettledInput(sessionId: string, exceptIds: string | readonly string[]): boolean {
    const ids = Array.isArray(exceptIds) ? exceptIds : [exceptIds];
    const placeholders = ids.map(() => '?').join(',');
    return !!this.row(`SELECT 1 FROM outbox WHERE json_extract(context,'$.targetId')=? AND kind='submitInput' AND state IN ('in_flight','unknown') AND operation_id NOT IN (${placeholders}) LIMIT 1`,sessionId,...ids);
  }
  hasOpenInteraction(sessionId: string): boolean { return !!this.row("SELECT 1 FROM interactions WHERE session_id=? AND json_extract(value,'$.status') IN ('awaiting_answer','answer_pending_delivery') LIMIT 1",sessionId); }
  interactionHealthCounts(): {pending:number; unknown:number} {
    const row = this.db.prepare(`
      WITH responses AS (
        SELECT json_extract(i.value,'$.status') AS interaction_status,
          json_extract(i.value,'$.nativeResult.status') AS native_status,
          json_extract(o.value,'$.status') AS response_status
        FROM interactions i
        LEFT JOIN outbox x ON x.kind='resolveInteraction' AND json_extract(x.payload,'$.interactionId')=i.id
        LEFT JOIN operations o ON o.id=x.operation_id
      )
      SELECT
        COUNT(*) FILTER (WHERE interaction_status='answer_pending_delivery') AS pending,
        COUNT(*) FILTER (WHERE response_status='unknown' OR (
          response_status IS NULL AND (interaction_status='answer_pending_delivery' OR
            (interaction_status='resolved' AND native_status='unknown'))
        )) AS unknown
      FROM responses
    `).get()!;
    return {pending:Number(row.pending),unknown:Number(row.unknown)};
  }
  hasStopRequest(sessionId:string,turnId:string):boolean {return !!this.db.prepare(`SELECT 1 FROM outbox
    JOIN operations ON operations.id=outbox.operation_id WHERE kind='interruptTurn'
    AND (state IN ('in_flight','unknown') OR (state='done' AND json_extract(value,'$.status')='completed'))
    AND json_extract(context,'$.targetId')=? AND json_extract(payload,'$.turnId')=? LIMIT 1`).get(sessionId,turnId);}
  wasQueuedInputCancelled(sessionId:string,inputId:string):boolean {
    return !!this.row(`SELECT 1 FROM outbox JOIN operations ON operations.id=outbox.operation_id
      WHERE json_extract(context,'$.targetId')=? AND (
        (kind='cancelQueuedInput' AND state='done' AND json_extract(value,'$.status')='completed'
          AND json_extract(payload,'$.inputId')=?)
        OR (kind='submitInput' AND state='cancelled' AND operation_id=? AND json_extract(value,'$.error.message')=?)
      ) LIMIT 1`,sessionId,inputId,inputId,STOPPED_QUEUE);
  }
  hasPendingOutbox(id: string): boolean {
    return !!this.row("SELECT 1 FROM outbox WHERE operation_id=? AND state='pending' AND operation_id NOT IN (SELECT operation_id FROM first_prompt_suspensions) UNION ALL SELECT 1 FROM steer_outbox_v1 WHERE operation_id=? AND state='pending' LIMIT 1",id,id);
  }
  /** Preserve only undispatched draft first prompts while the runtime restores control. */
  suspendFirstPromptDispatches(): void {
    this.run(`
      INSERT OR IGNORE INTO first_prompt_suspensions(operation_id)
      SELECT operation_id FROM outbox
      WHERE state='pending' AND kind='submitInput' AND operation_id LIKE 'new-session-first:%'
        AND json_extract(payload,'$.mode')='new' AND json_type(context,'$.channelScope')='object'
    `);
  }

  rebindFirstPrompt(id: string, session: Session): boolean {
    return this.transaction(() => {
      const out = this.getOutbox(id);
      if (out.state !== 'suspended' || out.context.targetId !== session.sessionId || this.getOperation(id).status !== 'received') return false;
      const current = this.session(session.sessionId);
      if (current.revision !== session.revision || current.control.generation !== session.control.generation ||
          current.control.input !== 'available' || this.isDetached(session.sessionId)) return false;
      const context = {...out.context,expectedRevision:session.revision,controlGeneration:session.control.generation};
      this.run("UPDATE outbox SET context=?,connection_generation=? WHERE operation_id=? AND state='pending'",
        JSON.stringify(context),this.connectionGeneration(session.sessionId),id);
      this.run('DELETE FROM first_prompt_suspensions WHERE operation_id=?',id);
      return true;
    });
  }
  pendingOutbox(targetId?: string, kind?: string): string[] {
    const where = "state='pending'" + (targetId === undefined ? '' : " AND json_extract(context,'$.targetId')=?") + (kind === undefined ? '' : ' AND kind=?');
    const params = [targetId,kind].filter((value): value is string => value !== undefined);
    const rows = this.db.prepare(`SELECT o.id FROM (SELECT operation_id FROM outbox WHERE ${where} AND operation_id NOT IN (SELECT operation_id FROM first_prompt_suspensions) UNION ALL SELECT operation_id FROM steer_outbox_v1 WHERE ${where}) pending JOIN operations o ON o.id=pending.operation_id ORDER BY o.rowid`).all(...params,...params) as Record<string,unknown>[];
    return rows.map(row=>String(row.id));
  }
  notificationPreference(id: string): { enabled: boolean; eventTypes: string[] } | null { this.session(id); const row = this.row('SELECT value FROM notification_preferences WHERE session_id=?', id); return row ? parse(row.value) : null; }
  /** Preference and operation receipt are committed together; no provider RPC is involved. */
  setNotificationPreference(context: WriteContext, value: { enabled: boolean; eventTypes: string[] }): Operation { return this.transaction(() => {
    const previous = this.existing(context, 'setNotificationSubscription', value); if (previous.operation) return previous.operation;
    const session = this.session(context.targetId); if (session.revision !== context.expectedRevision) return fail('stale_revision'); if (session.control.generation !== context.controlGeneration) return fail('control_conflict');
    const op = this.receipt(context, 'setNotificationSubscription', previous.digest, value);
    this.run('INSERT INTO notification_preferences(session_id,value) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value', context.targetId, JSON.stringify(value));
    const completed: Operation = { ...op, status: 'completed', revision: 1 }; this.run('UPDATE operations SET value=? WHERE id=?', JSON.stringify(completed), op.operationId); this.run("UPDATE outbox SET state='done' WHERE operation_id=?", op.operationId); this.eventFor(context.targetId, op.operationId, 1, 'operation.completed', op.operationId, completed); return completed;
  }); }
  /** Compare-and-swap a session, including its control generation. */
  updateSession(session: Session, expectedRevision: number, expectedControlGeneration: number): void { this.transaction(() => {
    const old = this.session(session.sessionId);
    if (old.revision !== expectedRevision) return fail('stale_revision');
    if (old.control.generation !== expectedControlGeneration) return fail('control_conflict');
    if (session.revision !== old.revision + 1 || session.control.generation < old.control.generation) return fail('invalid_request', 'invalid new session revision or generation');
    this.updateSessionInTransaction(session,old);
  }); }
  private updateSessionInTransaction(session: Session, old: Session, interactionsReconciled = false): void {
    if (session.archived === undefined && old.archived !== undefined) session = {...session, archived:old.archived};
    if (session.control.generation !== old.control.generation) this.invalidateDeliveries(session.sessionId, false, interactionsReconciled);
    this.run('UPDATE sessions SET value=?,revision=?,control_generation=? WHERE id=?', JSON.stringify(session), session.revision, session.control.generation, session.sessionId);
    this.eventFor(session.sessionId, session.sessionId, session.revision, 'session.updated', null, session);
  }
  findMessage(sessionId: string, messageId: string): Message | null {
    const row = this.row('SELECT value FROM messages WHERE id=? AND session_id=?', messageId, sessionId);
    return row ? parse<Message>(row.value) : null;
  }
  nextMessageSequence(sessionId: string): number {
    const row = this.row("SELECT MAX(json_extract(value,'$.sequence')) AS sequence FROM messages WHERE session_id=?", sessionId);
    return Math.max(0, Number(row?.sequence ?? 0)) + 1;
  }
  putMessage(value: Message, expectedRevision: number | null): void { this.transaction(() => this.putMessageInTransaction(value,expectedRevision)); }
  private putMessageInTransaction(value: Message, expectedRevision: number | null): void {
    this.session(value.sessionId); const row = this.row('SELECT value FROM messages WHERE id=?', value.messageId);
    if (row) { const old = parse<Message>(row.value); if (old.sessionId !== value.sessionId || old.revision !== expectedRevision || value.revision !== old.revision + 1) return fail('stale_revision');
      this.run('UPDATE messages SET value=? WHERE id=?', JSON.stringify(value), value.messageId);
    } else { if (expectedRevision !== null) return fail('stale_revision'); this.run('INSERT INTO messages(id,session_id,value) VALUES(?,?,?)', value.messageId, value.sessionId, JSON.stringify(value)); }
    const streamKey = `${value.sessionId}:${value.messageId}`;
    const prevEventId = this.streamingEventIds.get(streamKey);
    if (prevEventId) {
      this.run('DELETE FROM events WHERE event_id=?', prevEventId);
      this.run('DELETE FROM event_keys WHERE event_id=?', prevEventId);
      this.streamingEventIds.delete(streamKey);
    }
    const event = this.eventFor(value.sessionId, value.messageId, value.revision, 'message.updated', null, value);
    if (!value.final) {
      this.streamingEventIds.set(streamKey, event.eventId);
    }
  }
  private messageMap(sessionId: string): Map<string,Message> {
    return new Map(this.db.prepare('SELECT value FROM messages WHERE session_id=? ORDER BY rowid').all(sessionId).map(row => {
      const message = parse<Message>(row.value);
      return [message.messageId,message];
    }));
  }
  private reconcileAgyHistoryInTransaction<T extends Pick<SessionSnapshot, 'messages' | 'turns'>>(
    observed: T, messages: Map<string, Message>,
  ): T {
    const { snapshot, updated } = reconcilePersistedAgyHistory(observed, messages);
    for (const message of updated) {
      this.putMessageInTransaction(message, message.revision - 1);
      messages.set(message.messageId, message);
    }
    return snapshot;
  }
  /** Commit the snapshot only while the read's native identity and control scope still hold. */
  applyHistoryRefresh(expected: Session, generation: number, observed: SessionSnapshot): boolean { return this.transaction(() => {
    const id = expected.sessionId, current = this.session(id);
    const readonly = current.status === 'read_only' && current.control.input !== 'available';
    const quarantine = this.getRecoveryQuarantine(id);
    if (this.isDetached(id) || (quarantine && (!readonly || (current.native.provider === 'agy' && !quarantine.releaseConfirmed))) || this.connectionGeneration(id) !== generation ||
        current.control.generation !== expected.control.generation || current.control.input !== expected.control.input ||
        (current.status === 'read_only') !== (expected.status === 'read_only') ||
        current.project !== expected.project || payloadDigest(current.native) !== payloadDigest(expected.native)) return false;
    if (readonly) {
      const title = observed.session.title?.trim() || current.title;
      const candidateTime = Date.parse(observed.session.updatedAt ?? ''), currentTime = Date.parse(current.updatedAt ?? '');
      const updatedAt = Number.isFinite(candidateTime) && (!Number.isFinite(currentTime) || candidateTime > currentTime) ? observed.session.updatedAt : current.updatedAt;
      if (title !== current.title || updatedAt !== current.updatedAt) {
        const next = {...current,title,...(updatedAt ? {updatedAt} : {}),revision:current.revision+1};
        this.run('UPDATE sessions SET value=?,revision=? WHERE id=?',JSON.stringify(next),next.revision,id);
        this.eventFor(id,id,next.revision,'session.updated',null,next);
      }
    }
    const messages = this.messageMap(id);
    if (current.native.provider === 'agy') observed = this.reconcileAgyHistoryInTransaction(observed, messages);
    for (const native of observed.turns ?? []) this.putTurnInTransaction({...native,sessionId:id});
    let sequence = 0;
    for (const message of messages.values()) sequence = Math.max(sequence,message.sequence);
    for (const native of observed.messages) {
      const old = messages.get(native.messageId);
      const value = {...native,sessionId:id,sequence:old?.sequence ?? ++sequence,revision:old?.revision ?? native.revision};
      if (old && (payloadDigest(value) === payloadDigest(old) || old.final && !value.final)) continue;
      const next = old ? {...value,revision:old.revision+1} : value;
      this.putMessageInTransaction(next,old?.revision ?? null);
      messages.set(next.messageId,next);
    }
    return true;
  }); }
  setConnectionGeneration(sessionId: string, expected: number, next: number): void {
    this.transaction(() => this.setConnectionGenerationInTransaction(sessionId,expected,next));
  }
  private setConnectionGenerationInTransaction(sessionId: string, expected: number, next: number): void {
    const row = this.row('SELECT connection_generation FROM sessions WHERE id=?', sessionId);
    if (!row || Number(row.connection_generation) !== expected) return fail('stale_revision', 'connection generation changed');
    if (!Number.isSafeInteger(next) || next <= expected) return fail('invalid_request', 'connection generation must increase');
    this.invalidateDeliveries(sessionId, true);
    this.run('UPDATE sessions SET connection_generation=? WHERE id=?', next, sessionId);
  }
  insertInteraction(value: Interaction, native: Interaction = value): void { this.transaction(() => {
    if (native.interactionId !== value.interactionId || native.nativeRequestId !== value.nativeRequestId || native.connectionGeneration !== value.connectionGeneration || native.status !== 'awaiting_answer' || value.status !== 'awaiting_answer') return fail('invalid_request','invalid native interaction snapshot');
    const row = this.row('SELECT connection_generation FROM sessions WHERE id=?', value.sessionId);
    if (!row || Number(row.connection_generation) !== value.connectionGeneration) return fail('interaction_expired');
    this.run('INSERT INTO interactions(id,session_id,value) VALUES(?,?,?)', value.interactionId, value.sessionId, JSON.stringify(value));
    this.run('INSERT INTO native_interactions(id,value) VALUES(?,?)', value.interactionId, JSON.stringify(native));
    this.eventFor(value.sessionId, value.interactionId, value.revision, 'interaction.created', null, value);
  }); }
  getNativeInteraction(id: string): Interaction { const row = this.row('SELECT value FROM native_interactions WHERE id=?',id); if (!row) return fail('temporarily_unavailable','original native interaction snapshot unavailable'); return parse<Interaction>(row.value); }
  private responseDelivery(id: string): { operationId: string; state: string } | null {
    const row = this.row("SELECT operation_id,state FROM outbox WHERE kind='resolveInteraction' AND json_extract(payload,'$.interactionId')=? ORDER BY rowid DESC LIMIT 1", id);
    return row ? {operationId: String(row.operation_id), state: String(row.state)} : null;
  }
  getResponseOperation(id: string): Operation | null {
    const delivery = this.responseDelivery(id);
    return delivery ? this.getOperation(delivery.operationId) : null;
  }
  private updateInteractionInTransaction(current: Interaction, status: Interaction['status'], nativeResult: NativeResult | null, eventType: string, operationId: string | null = null): Interaction {
    if (current.status === status && payloadDigest(current.nativeResult) === payloadDigest(nativeResult)) return current;
    const updated: Interaction = { ...current, status, nativeResult, revision: current.revision + 1 };
    this.run('UPDATE interactions SET value=? WHERE id=?', JSON.stringify(updated), updated.interactionId);
    this.eventFor(updated.sessionId, updated.interactionId, updated.revision, eventType, operationId, updated);
    return updated;
  }
  private closeResponseDelivery(delivery: ReturnType<UnifiedStore['responseDelivery']>): void {
    if (delivery?.state === 'pending') this.cancelPending(delivery.operationId);
    if (delivery?.state === 'in_flight') this.markUnknownInTransaction(delivery.operationId);
  }
  private weakNativeResult(result: NativeResult | null, delivery: ReturnType<UnifiedStore['responseDelivery']>): NativeResult | null {
    if (delivery && ['done','unknown','in_flight'].includes(delivery.state)) {
      if (result?.status === 'unknown') return result;
      if (result?.status === 'accepted') return {status: 'unknown', source: result.source};
      return {status: 'unknown', source: 'native_request_closed'};
    }
    return result;
  }
  private reconcileRecoveryInteractions(sessionId: string, generation: number, observed: Interaction[]): void {
    const awaiting = new Map(observed.filter(value => value.status === 'awaiting_answer' &&
      value.connectionGeneration === generation).map(value => [value.interactionId, value]));
    for (const current of this.snapshotInteractions(sessionId)) {
      if (current.status !== 'awaiting_answer' && current.status !== 'answer_pending_delivery') continue;
      const delivery = this.responseDelivery(current.interactionId);
      const native = awaiting.get(current.interactionId);
      if (current.connectionGeneration !== generation || native?.nativeRequestId !== current.nativeRequestId) {
        this.updateInteractionInTransaction(current, 'expired', this.weakNativeResult(current.nativeResult, delivery), 'interaction.expired');
        this.closeResponseDelivery(delivery);
      } else if (current.status === 'answer_pending_delivery' && delivery?.state === 'pending') {
        // The native request still awaits a response. Fence the unsent intent before accepting a new answer.
        this.updateInteractionInTransaction(current, 'awaiting_answer', native.nativeResult, 'interaction.updated');
        this.closeResponseDelivery(delivery);
      }
    }
  }
  expireNativeInteraction(id: string, generation: number, requestId: string, status: 'expired' | 'cancelled', nativeResult: NativeResult | null = null): Interaction { return this.transaction(() => {
    const current = this.getInteraction(id); const connection = this.connectionGeneration(current.sessionId);
    if (connection !== generation || current.connectionGeneration !== generation || current.nativeRequestId !== requestId) return fail('interaction_expired');
    if (current.status !== 'awaiting_answer' && current.status !== 'answer_pending_delivery') return current;
    const delivery = this.responseDelivery(id);
    const updated = this.updateInteractionInTransaction(current, status, this.weakNativeResult(nativeResult ?? current.nativeResult, delivery), `interaction.${status}`);
    this.closeResponseDelivery(delivery);
    return updated;
  }); }
  private existing(context: WriteContext, action: string, payload: unknown): { digest: string; operation?: Operation } {
    const valid = validateWriteContext(context); if (!valid.ok) throw new StoreError(valid.error);
    const digest = payloadDigest({ action, context, payload });
    const row = this.row('SELECT digest,value FROM operations WHERE idem=?', context.idempotencyKey);
    if (row) { if (row.digest !== digest) return fail('idempotency_conflict'); return { digest, operation: parse<Operation>(row.value) }; }
    if (this.row('SELECT id FROM operations WHERE id=?', context.operationId)) return fail('idempotency_conflict', 'operation ID already used');
    return { digest };
  }
  findIdempotent(context: WriteContext, action: string, payload: unknown): Operation | undefined { return this.existing(context, action, payload).operation; }
  private receipt(context: WriteContext, action: string, digest: string, payload: unknown): Operation {
    const operation: Operation = { operationId: context.operationId, idempotencyKey: context.idempotencyKey, targetId: context.targetId, action, payloadDigest: digest, status: 'received', revision: 0, error: null };
    this.run('INSERT INTO operations(id,idem,digest,value) VALUES(?,?,?,?)', operation.operationId, operation.idempotencyKey, digest, JSON.stringify(operation));
    const connection = this.row('SELECT connection_generation FROM sessions WHERE id=?', context.targetId)!;
    this.run('INSERT INTO outbox(operation_id,kind,payload,context,connection_generation,state) VALUES(?,?,?,?,?,?)', operation.operationId, action, JSON.stringify(payload), JSON.stringify(context), Number(connection.connection_generation), 'pending');
    this.eventFor(context.targetId, operation.operationId, operation.revision, 'operation.received', operation.operationId, operation);
    return operation;
  }
  /** Register a generic intent and its delivery record atomically. */
  registerOperation(context: WriteContext, action: string, payload: unknown): Operation { return this.transaction(() => {
    const existing = this.existing(context, action, payload); if (existing.operation) return existing.operation;
    const session = this.session(context.targetId);
    if (action !== 'releaseControl' && session.revision !== context.expectedRevision) return fail('stale_revision');
    if (session.control.generation !== context.controlGeneration) return fail('control_conflict');
    if (action === 'interruptTurn') {
      if (session.control.input !== 'available') return fail('control_conflict');
      if (!this.listTurns(context.targetId).some(t=>t.turnId === (payload as {turnId:string}).turnId && t.status === 'running')) return fail('busy','turn is no longer running');
      this.cancelPendingInputsInTransaction(session.sessionId);
    }
    return this.receipt(context, action, existing.digest, payload);
  }); }
  private stopResult(operation: Operation, authorize: (action: 'interruptTurn' | 'cancelQueuedInput') => void): StopResult {
    if (operation.result?.kind === 'queueCancellation') {
      authorize('cancelQueuedInput');
      return {status:'completed',cancelled:operation.result.cancelled};
    }
    if (operation.result?.kind === 'stopRejected') {
      return {status:'rejected',reason:operation.result.reason};
    }
    authorize('interruptTurn');
    return operation;
  }
  findStopOrCancelQueued(context: WriteContext, authorize: (action: 'interruptTurn' | 'cancelQueuedInput') => void): StopResult | undefined {
    const operation = this.findIdempotent(context,'stopOrCancelQueued',{});
    if (operation) return this.stopResult(operation,authorize);
  }
  stopOrCancelQueued(context: WriteContext, authorize: (action: 'interruptTurn' | 'cancelQueuedInput') => void): StopResult {
    return this.transaction(() => {
      const existing = this.existing(context,'stopOrCancelQueued',{});
      if (existing.operation) return this.stopResult(existing.operation,authorize);
      const session = this.session(context.targetId);
      if (session.control.generation !== context.controlGeneration || session.control.input !== 'available') return fail('control_conflict');
      const running = this.listTurns(session.sessionId).filter(turn => turn.status === 'running');
      if (running.length > 1 || (!running.length && !this.queuedInputs(session.sessionId).length)) {
        const reason = running.length > 1 ? 'ambiguous_running_turn' : 'no_running_turn';
        const op = this.receipt(context,'stopOrCancelQueued',existing.digest,{});
        const accepted = this.updateOperationInTransaction(op,'accepted');
        this.updateOperationInTransaction({...accepted,result:{kind:'stopRejected',reason}},'completed');
        this.run("UPDATE outbox SET state='done' WHERE operation_id=?",op.operationId);
        return {status:'rejected',reason};
      }
      if (!running.length) {
        authorize('cancelQueuedInput');
        const cancelled = this.cancelPendingInputsInTransaction(session.sessionId);
        const op = this.receipt(context,'cancelQueuedInputs',existing.digest,{});
        const accepted = this.updateOperationInTransaction(op,'accepted');
        this.updateOperationInTransaction({...accepted,result:{kind:'queueCancellation',cancelled}},'completed');
        this.run("UPDATE outbox SET state='done' WHERE operation_id=?",op.operationId);
        return {status:'completed',cancelled};
      }
      authorize('interruptTurn');
      const payload = {turnId:running[0]!.turnId};
      this.cancelPendingInputsInTransaction(session.sessionId);
      return this.receipt(context,'interruptTurn',existing.digest,payload);
    });
  }
  private cancelPendingInputsInTransaction(sessionId: string): number {
    const inputs = this.queuedInputs(sessionId);
    for (const {inputId} of inputs) this.cancelPending(inputId,contractError('busy',STOPPED_QUEUE));
    return inputs.length;
  }
  /** Keep steer intents outside the legacy dispatcher; registration fences the captured turn. */
  registerSteer(request: import('./contracts.js').SubmitInput): Operation { return this.transaction(() => {
    const {context,requiredTurnId,expectedConnectionGeneration}=request;
    const existing=this.existing(context,'submitInput',request); if(existing.operation)return existing.operation;
    const session=this.session(context.targetId), turns=this.listTurns(context.targetId).filter(t=>t.status==='running');
    if(session.revision!==context.expectedRevision)return fail('stale_revision');
    if(session.control.generation!==context.controlGeneration || session.control.input!=='available')return fail('control_conflict');
    if(this.connectionGeneration(context.targetId)!==expectedConnectionGeneration || turns.length!==1 || turns[0]?.turnId!==requiredTurnId)return fail('interaction_expired','captured turn or connection changed');
    const operation:Operation={operationId:context.operationId,idempotencyKey:context.idempotencyKey,targetId:context.targetId,action:'submitInput',payloadDigest:existing.digest,status:'received',revision:0,error:null};
    this.run('INSERT INTO operations(id,idem,digest,value) VALUES(?,?,?,?)',operation.operationId,operation.idempotencyKey,existing.digest,JSON.stringify(operation));
    this.run("INSERT INTO steer_outbox_v1 VALUES(?,?,?,?,?,'pending')",operation.operationId,'submitInput',JSON.stringify(request),JSON.stringify(context),expectedConnectionGeneration!);
    this.eventFor(context.targetId,operation.operationId,0,'operation.received',operation.operationId,operation);return operation;
  }); }
  completeSteer(id:string):Operation {return this.transaction(()=>{const out=this.getOutbox(id),op=this.getOperation(id);if(this.outboxTable(id)!=='steer_outbox_v1'||out.state!=='in_flight'||op.status!=='received')return fail('invalid_request');const accepted:Operation={...op,status:'accepted',revision:op.revision+1,error:null};this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(accepted),id);this.eventFor(op.targetId,id,accepted.revision,'operation.accepted',id,accepted);const done:Operation={...accepted,status:'completed',revision:accepted.revision+1};this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(done),id);this.run("UPDATE steer_outbox_v1 SET state='done' WHERE operation_id=?",id);this.eventFor(op.targetId,id,done.revision,'operation.completed',id,done);return done;});}
  /** The bridge CAS registers an intent, not a claim that the native request accepted it. */
  resolveInteraction(request: ResolveInteraction, now = Date.now()): Operation { return this.transaction(() => {
    const { context } = request; const existing = this.existing(context, 'resolveInteraction', request); if (existing.operation) return existing.operation;
    const session = this.session(context.targetId);
    if (session.control.generation !== context.controlGeneration || session.control.input !== 'available' || this.isDetached(session.sessionId) || this.recoveryQuarantined(session.sessionId)) return fail('control_conflict');
    const interaction = this.getInteraction(request.interactionId);
    const connection = this.row('SELECT connection_generation FROM sessions WHERE id=?', context.targetId);
    if (!connection || Number(connection.connection_generation) !== request.expectedConnectionGeneration) return fail('interaction_expired');
    const interactionWithMeta = interaction as Interaction & { allowAlways?: boolean; allowedScopes?: readonly string[] };
    const sessionScopePermitted =
      interaction.kind === 'approval' &&
      request.answer.kind === 'approval' &&
      request.answer.decision === 'allow' &&
      (request.answer.scope === 'session' || request.answer.scope === 'allow_always') &&
      (interactionWithMeta.allowAlways === true || interactionWithMeta.allowedScopes?.includes(request.answer.scope) === true);
    const validationTarget: ResolveInteraction = sessionScopePermitted && request.answer.kind === 'approval'
      ? { ...request, answer: { ...request.answer, scope: interaction.scope } }
      : request;
    const valid = validateResolution(validationTarget, interaction, now); if (!valid.ok) throw new StoreError(valid.error);
    const updated: Interaction = { ...interaction, status: 'answer_pending_delivery', revision: interaction.revision + 1 };
    this.run('UPDATE interactions SET value=? WHERE id=?', JSON.stringify(updated), updated.interactionId);
    this.eventFor(updated.sessionId, updated.interactionId, updated.revision, 'interaction.answer_pending_delivery', context.operationId, updated);
    return this.receipt(context, 'resolveInteraction', existing.digest, request);
  }); }
  /** A request closure settles delivery only when the adapter can attribute the native result. */
  recordNativeResult(id: string, connectionGeneration: number, nativeRequestId: string, result: NativeResult, terminal = false, evidence?: ResponseEvidence): Interaction { return this.transaction(() => {
    const current = this.getInteraction(id);
    if (current.connectionGeneration !== connectionGeneration || current.nativeRequestId !== nativeRequestId) return fail('interaction_expired');
    if (evidence) return this.confirmResponseInTransaction(current, result, evidence);
    if (this.connectionGeneration(current.sessionId) !== connectionGeneration) return fail('interaction_expired');
    if (current.status === 'resolved' || current.status === 'expired' || current.status === 'cancelled') return current;
    if (!terminal && result.status !== 'accepted') return this.updateInteractionInTransaction(current, current.status, result, 'interaction.native_result');
    const delivery = this.responseDelivery(id);
    const closed = this.updateInteractionInTransaction(current, 'resolved', this.weakNativeResult(result, delivery), 'interaction.native_result');
    // A closure without attribution cancels unsent intent, but claimed work may already have been written.
    this.closeResponseDelivery(delivery);
    return closed;
  }); }
  private confirmResponseInTransaction(current: Interaction, result: NativeResult, evidence: ResponseEvidence): Interaction {
    const op = this.getOperation(evidence.operationId), out = this.getOutbox(evidence.operationId);
    const request = out.payload as ResolveInteraction;
    if (op.action !== 'resolveInteraction' || out.kind !== op.action ||
        op.targetId !== current.sessionId || out.context.targetId !== current.sessionId ||
        out.context.operationId !== evidence.operationId || request.interactionId !== current.interactionId ||
        evidence.interactionId !== current.interactionId || evidence.nativeRequestId !== current.nativeRequestId ||
        evidence.connectionGeneration !== current.connectionGeneration || out.connectionGeneration !== current.connectionGeneration ||
        request.expectedConnectionGeneration !== current.connectionGeneration ||
        result.status !== 'accepted' || evidence.answerDigest !== answerDigest(request.answer) ||
        (result.disposition === 'skipped'
          ? result.answer !== null || current.kind === 'approval' || !questionDeclineAction(request.answer)
          : !result.answer || evidence.answerDigest !== answerDigest(result.answer))) {
      return fail('invalid_request', 'response evidence does not match the persisted request');
    }
    if (op.status === 'completed' && out.state === 'done') return current;
    if (!(op.status === 'received' && out.state === 'in_flight' ||
        op.status === 'accepted' && (out.state === 'in_flight' || out.state === 'done') ||
        op.status === 'unknown' && out.state === 'unknown')) return fail('invalid_request', 'response was not dispatched');
    const accepted = op.status === 'received' ? this.updateOperationInTransaction(op, 'accepted') : op;
    const resolved = this.updateInteractionInTransaction(current, 'resolved', result, 'interaction.native_result', op.operationId);
    this.updateOperationInTransaction(accepted, 'completed');
    this.run("UPDATE outbox SET state='done' WHERE operation_id=?", op.operationId);
    return resolved;
  }
  private outboxTable(id:string):'outbox'|'steer_outbox_v1' { return this.row('SELECT operation_id FROM steer_outbox_v1 WHERE operation_id=?',id)?'steer_outbox_v1':'outbox'; }
  getOutbox(id: string): { kind: string; payload: unknown; context: WriteContext; connectionGeneration: number; state: string } {
    const r = this.row(`SELECT kind,payload,context,connection_generation,state FROM ${this.outboxTable(id)} WHERE operation_id=?`, id);
    if (!r) return fail('invalid_request', 'unknown outbox');
    const state = r.state === 'pending' && this.row('SELECT 1 FROM first_prompt_suspensions WHERE operation_id=?',id) ? 'suspended' : String(r.state);
    return {kind:String(r.kind),payload:parse(r.payload),context:parse<WriteContext>(r.context),connectionGeneration:Number(r.connection_generation),state};
  }
  /** SQLite serializes claim and generation changes; native submission still requires an adapter-side final fence. */
  claimOutbox(id: string, now = Date.now()): boolean { return this.transaction(() => {
    const table=this.outboxTable(id); const row = this.row(`SELECT kind,payload,context,connection_generation,state FROM ${table} WHERE operation_id=?`, id);
    if (!row || row.state !== 'pending' || this.row('SELECT 1 FROM first_prompt_suspensions WHERE operation_id=?',id)) return false;
    const context = parse<WriteContext>(row.context);
    const session = this.row('SELECT control_generation,connection_generation FROM sessions WHERE id=?', context.targetId);
    let valid = !!session && Number(session.control_generation) === context.controlGeneration && Number(session.connection_generation) === Number(row.connection_generation);
    if (valid && row.kind === 'resolveInteraction') {
      const req = parse<ResolveInteraction>(row.payload); const interaction = this.getInteraction(req.interactionId);
      valid = interaction.sessionId === context.targetId && interaction.connectionGeneration === req.expectedConnectionGeneration && interaction.status === 'answer_pending_delivery' && interaction.nativeResult === null && Number.isFinite(now) && (interaction.expiresAt === null || (Number.isFinite(Date.parse(interaction.expiresAt)) && Date.parse(interaction.expiresAt) > now));
    }
    if(valid && table==='steer_outbox_v1') {const req=parse<import('./contracts.js').SubmitInput>(row.payload),turns=this.listTurns(context.targetId).filter(t=>t.status==='running');valid=req.mode==='steer' && turns.length===1 && turns[0]?.turnId===req.requiredTurnId && Number(row.connection_generation)===req.expectedConnectionGeneration;}
    if (!valid) { this.cancelPending(id); return false; }
    this.run(`UPDATE ${table} SET state='in_flight' WHERE operation_id=?`, id); return true;
  }); }
  /** Atomically claim a queued text input together with immediately following compatible queued text inputs. */
  claimQueuedTextBatch(id: string): { claimed: boolean; mergedIds: string[]; mergedText?: string } { return this.transaction(() => {
    const row = this.row('SELECT kind,payload,context,connection_generation,state FROM outbox WHERE operation_id=?', id);
    if (!row || row.state !== 'pending' || row.kind !== 'submitInput' || this.row('SELECT 1 FROM first_prompt_suspensions WHERE operation_id=?', id)) {
      return { claimed: false, mergedIds: [] };
    }
    const context = parse<WriteContext>(row.context);
    const payload = parse<import('./contracts.js').SubmitInput>(row.payload);
    const session = this.row('SELECT control_generation,connection_generation FROM sessions WHERE id=?', context.targetId);
    const valid = !!session && Number(session.control_generation) === context.controlGeneration && Number(session.connection_generation) === Number(row.connection_generation);
    if (!valid) { this.cancelPending(id); return { claimed: false, mergedIds: [] }; }
    this.run("UPDATE outbox SET state='in_flight' WHERE operation_id=?", id);
    if (payload.mode !== 'queue' || !payload.blocks.length || !payload.blocks.every(b => b.type === 'text')) {
      return { claimed: true, mergedIds: [] };
    }
    const texts: string[] = [payload.blocks.map(b => (b.type === 'text' ? b.text : '')).join('\n')];
    const mergedIds: string[] = [];
    const following = this.pendingOutbox(context.targetId, 'submitInput');
    for (const nextId of following) {
      if (nextId === id) continue;
      const nextOut = this.getOutbox(nextId);
      if (nextOut.state !== 'pending' || nextOut.kind !== 'submitInput') break;
      const nextPayload = nextOut.payload as import('./contracts.js').SubmitInput;
      const compatible =
        nextPayload.mode === 'queue' &&
        nextOut.connectionGeneration === Number(row.connection_generation) &&
        nextOut.context.controlGeneration === context.controlGeneration &&
        nextOut.context.identity.source === context.identity.source &&
        nextOut.context.identity.subject === context.identity.subject &&
        nextPayload.channelScope === payload.channelScope &&
        nextPayload.blocks.length > 0 &&
        nextPayload.blocks.every(b => b.type === 'text');
      if (!compatible) break;
      this.run("UPDATE outbox SET state='in_flight' WHERE operation_id=?", nextId);
      mergedIds.push(nextId);
      texts.push(nextPayload.blocks.map(b => (b.type === 'text' ? b.text : '')).join('\n'));
    }
    return mergedIds.length
      ? { claimed: true, mergedIds, mergedText: texts.join('\n\n') }
      : { claimed: true, mergedIds: [] };
  }); }
  /** Pending at restart is not proof of a currently authorized delivery context. */
  failUnreboundPending(ids:string[]):void { this.transaction(()=>{ for(const id of ids) { const out=this.getOutbox(id); if(out.state!=='pending') continue; if(this.row('SELECT id FROM sessions WHERE id=?',out.context.targetId)) {this.cancelPending(id);continue;} const op=this.getOperation(id); if(canTransitionOperation(op.status,'failed')) {const next:Operation={...op,status:'failed',revision:op.revision+1,error:contractError('control_conflict','restart requires a new authorized request')};this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(next),id);this.run("UPDATE outbox SET state='cancelled' WHERE operation_id=?",id);} } }); }
  private cancelPending(id: string, error = contractError('control_conflict', 'request was not executed; submit again after control is restored')): void {
    const op = this.getOperation(id);
    if (op.action === 'resolveInteraction') {
      this.failResponseInTransaction(op, contractError('interaction_expired', 'delivery context no longer valid'));
      return;
    }
    this.run(`UPDATE ${this.outboxTable(id)} SET state='cancelled' WHERE operation_id=? AND state='pending'`, id);
    if (canTransitionOperation(op.status, 'failed')) this.updateOperationInTransaction(op, 'failed', error);
  }
  failResponseSubmission(id: string, error: ContractError): Operation { return this.transaction(() => {
    const op = this.getOperation(id);
    if (op.action !== 'resolveInteraction') return fail('invalid_request');
    return this.failResponseInTransaction(op, error);
  }); }
  private failResponseInTransaction(op: Operation, error: ContractError): Operation {
    const out = this.getOutbox(op.operationId);
    if (!['pending','in_flight','unknown'].includes(out.state) || op.status === 'accepted' || !canTransitionOperation(op.status, 'failed')) return op;
    const interaction = this.getInteraction((out.payload as ResolveInteraction).interactionId);
    if (interaction.status === 'answer_pending_delivery') this.updateInteractionInTransaction(interaction, 'expired', interaction.nativeResult, 'interaction.expired', op.operationId);
    this.run("UPDATE outbox SET state='cancelled' WHERE operation_id=?", op.operationId);
    return this.updateOperationInTransaction(op, 'failed', error);
  }
  private invalidateDeliveries(sessionId: string, expireInteractions: boolean, interactionsReconciled = false): void {
    const rows = this.db.prepare("SELECT operation_id,state FROM outbox WHERE json_extract(context,'$.targetId')=? AND state IN ('pending','in_flight') AND operation_id NOT IN (SELECT operation_id FROM first_prompt_suspensions) UNION ALL SELECT operation_id,state FROM steer_outbox_v1 WHERE json_extract(context,'$.targetId')=? AND state IN ('pending','in_flight')").all(sessionId,sessionId) as Record<string, unknown>[];
    for (const row of rows) {
      if (row.state === 'pending') this.cancelPending(String(row.operation_id)); else this.markUnknownInTransaction(String(row.operation_id));
    }
    if (interactionsReconciled) return;
    for (const current of this.snapshotInteractions(sessionId)) {
      if ((expireInteractions && current.status === 'awaiting_answer') || current.status === 'answer_pending_delivery') {
        const delivery = this.responseDelivery(current.interactionId);
        const result = delivery?.state === 'done' ? {status:'unknown' as const,source:'delivery_context_changed'} : current.nativeResult;
        this.updateInteractionInTransaction(current, 'expired', result, 'interaction.expired');
      }
    }
  }
  /** Settle recorded stop outcomes, then recover uncertain work whose dispatch lease has expired. */
  recoverAbandonedInFlight(now = Date.now()): Operation[] { return this.transaction(() => {
    const stoppedTurns = this.db.prepare(`SELECT DISTINCT turns.value FROM outbox
      JOIN turns ON turns.session_id=json_extract(outbox.context,'$.targetId')
        AND turns.id=json_extract(outbox.payload,'$.turnId')
      WHERE kind='interruptTurn' AND state IN ('pending','in_flight','unknown')
        AND json_extract(turns.value,'$.status') IN ('completed','failed','interrupted')`).all();
    for (const row of stoppedTurns) this.settleInterruptsInTransaction(parse<Turn>(row.value));
    const rows = this.db.prepare("SELECT operation_id,context FROM outbox WHERE state='in_flight' UNION ALL SELECT operation_id,context FROM steer_outbox_v1 WHERE state='in_flight'").all() as Record<string,unknown>[]; const recovered: Operation[] = [];
    for (const row of rows) {
      const op = this.getOperation(String(row.operation_id));
      if (op.status === 'accepted') continue;
      const context = parse<WriteContext>(row.context), out = this.getOutbox(op.operationId);
      const responseLease = out.kind === 'resolveInteraction' ? this.row('SELECT expires FROM dispatch_leases WHERE session_id=?',responseLeaseKey((out.payload as ResolveInteraction).interactionId)) : undefined;
      const lease = responseLease ?? this.row('SELECT expires FROM dispatch_leases WHERE session_id=?',context.targetId);
      if (!lease || Number(lease.expires) <= now) recovered.push(this.markUnknownInTransaction(op.operationId));
    }
    return recovered;
  }); }
  recoverInFlight(): Operation[] { return this.transaction(() => {
    const rows = this.db.prepare("SELECT operation_id FROM outbox WHERE state='in_flight' UNION ALL SELECT operation_id FROM steer_outbox_v1 WHERE state='in_flight'").all() as Record<string, unknown>[];
    return rows.map(row => this.markUnknownInTransaction(String(row.operation_id)));
  }); }
  markDeliveryUnknown(id: string): Operation { return this.transaction(() => this.markUnknownInTransaction(id)); }
  markResponseDeliveryUnknown(id: string): Operation { return this.transaction(() => {
    const out = this.getOutbox(id);
    if (out.kind !== 'resolveInteraction') return fail('invalid_request');
    return out.state === 'in_flight' ? this.markUnknownInTransaction(id) : this.getOperation(id);
  }); }
  private markUnknownInTransaction(id: string): Operation {
    const out = this.getOutbox(id); if (out.state !== 'in_flight' && out.state !== 'unknown') return fail('invalid_request', 'delivery was not in flight');
    const op = this.getOperation(id); if (op.status !== 'unknown' && !canTransitionOperation(op.status, 'unknown')) return fail('invalid_request', 'invalid operation transition');
    const next: Operation = op.status === 'unknown' ? op : { ...op, status: 'unknown', revision: op.revision + 1, error: contractError('outcome_unknown') };
    this.run(`UPDATE ${this.outboxTable(id)} SET state='unknown' WHERE operation_id=?`, id); this.run('UPDATE operations SET value=? WHERE id=?', JSON.stringify(next), id); if (next !== op && this.row('SELECT id FROM sessions WHERE id=?',op.targetId)) this.eventFor(op.targetId, id, next.revision, 'operation.unknown', id, next); return next;
  }
  reconcileOperation(id: string, status: Extract<OperationStatus, 'accepted' | 'completed' | 'failed'>, error: ContractError | null = null): Operation { return this.transaction(() => {
    const op = this.getOperation(id); if (!canTransitionOperation(op.status, status)) return fail('invalid_request', 'invalid operation transition');
    if (op.action === 'resolveInteraction') {
      if (status !== 'failed') return fail('invalid_request', 'response reconciliation needs native evidence');
      return this.failResponseInTransaction(op, error ?? contractError('interaction_expired'));
    }
    const next: Operation = { ...op, status, revision: op.revision + 1, error }; this.run('UPDATE operations SET value=? WHERE id=?', JSON.stringify(next), id);
    this.run(`UPDATE ${this.outboxTable(id)} SET state=? WHERE operation_id=?`, status === 'accepted' ? 'in_flight' : 'done', id); this.run('DELETE FROM first_prompt_suspensions WHERE operation_id=?',id); this.eventFor(op.targetId, id, next.revision, `operation.${status}`, id, next); return next;
  }); }
  private eventFor(sessionId: string, objectId: string, revision: number, type: string, operationId: string | null, data: unknown): Event {
    const now = new Date().toISOString();
    return this.appendEventInTransaction({ eventId: randomUUID(), sessionId, objectId, objectRevision: revision, type, occurredAt: now, receivedAt: now, operationId, data }, true);
  }
  appendEvent(input: EventInput): Event { return this.transaction(() => this.appendEventInTransaction(input, false)); }
  appendObservedEvent(input: EventInput, generation?: number): boolean {
    return this.transaction(() => {
      const prior = this.row('SELECT 1 FROM event_keys WHERE event_id=?', input.eventId);
      if (input.type !== 'tool.updated' || prior) {
        this.appendEventInTransaction(input, false);
        return !prior;
      }
      const data = readToolProgress(input.data);
      if (!data || generation === undefined || generation !== this.connectionGeneration(input.sessionId) ||
        !this.turnProgress.acceptsTool(input.sessionId, generation, data)) return false;
      const event = this.appendEventInTransaction({ ...input, data }, false);
      this.turnProgress.recordTool(event, generation);
      return true;
    });
  }
  private appendEventInTransaction(input: EventInput, internal: boolean): Event {
    const prior = this.row('SELECT value FROM event_keys WHERE event_id=?', input.eventId);
    if (prior) {
      const stored = parse<Event | EventKey>(prior.value);
      if (isCompactEventKey(stored)) {
        if (stored.d !== payloadDigest(input)) return fail('idempotency_conflict');
        return { ...input, schemaVersion: stored.v ?? SCHEMA_VERSION, sequence: stored.q, cursor: encodeCursor(input.sessionId, stored.q) };
      }
      const { schemaVersion: _v, sequence: _s, cursor: _c, ...original } = stored;
      if (payloadDigest(original) !== payloadDigest(input)) return fail('idempotency_conflict');
      return stored;
    }
    const row = this.row('SELECT event_seq FROM sessions WHERE id=?', input.sessionId); if (!row) return fail('invalid_request', 'unknown session');
    const sequence = Number(row.event_seq) + 1; const event: Event = { ...input, schemaVersion: SCHEMA_VERSION, sequence, cursor: encodeCursor(input.sessionId, sequence) };
    this.run('INSERT INTO event_keys(event_id,value) VALUES(?,?)', input.eventId, JSON.stringify(compactEventKey(input, sequence, SCHEMA_VERSION, internal)));
    this.run('INSERT INTO events(event_id,session_id,seq,value) VALUES(?,?,?,?)', input.eventId, input.sessionId, sequence, JSON.stringify(event)); this.run('UPDATE sessions SET event_seq=? WHERE id=?', sequence, input.sessionId); return event;
  }
  slimLegacyEventKeys(batchLimit = 5000): number {
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1) return fail('invalid_request', 'invalid legacy event key batch limit');
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT event_id,value FROM event_keys WHERE json_extract(value,'$._k') IS NULL ORDER BY rowid LIMIT ?").all(batchLimit);
      const update = this.db.prepare('UPDATE event_keys SET value=? WHERE event_id=?');
      for (const row of rows) {
        const eventId = String(row.event_id);
        const { schemaVersion, sequence, cursor: _cursor, ...input } = parse<Event>(row.value);
        // Legacy event keys carry no provenance, even when their IDs are UUIDs.
        update.run(JSON.stringify(compactEventKey(input, sequence, schemaVersion, false)), eventId);
      }
      return rows.length;
    });
  }
  eventWatermark(sessionId: string): number {
    const row = this.row('SELECT event_seq FROM sessions WHERE id=?', sessionId);
    if (!row) return fail('invalid_request', 'unknown session');
    return Number(row.event_seq);
  }
  initialCursor(sessionId:string):string {this.session(sessionId);return encodeCursor(sessionId,0);}
  snapshot(sessionId: string): Snapshot<SessionSnapshot & { turns: Turn[] }> { return this.readTransaction(() => {
    const session = this.session(sessionId);
    const messages = (this.db.prepare('SELECT value FROM messages WHERE session_id=? ORDER BY rowid').all(sessionId) as Record<string, unknown>[]).map(r => parse<Message>(r.value));
    const interactions = (this.db.prepare('SELECT value FROM interactions WHERE session_id=? ORDER BY rowid').all(sessionId) as Record<string, unknown>[]).map(r => parse<Interaction>(r.value));
    const row = this.row('SELECT event_seq FROM sessions WHERE id=?', sessionId)!;
    return { value: { session, messages, interactions, turns: this.listTurns(sessionId), turnProgress: this.turnProgress.snapshot(sessionId) }, cursor: encodeCursor(sessionId, Number(row.event_seq)) };
  }); }
  subscribeEvents(sessionId: string, from: string, limit: number): EventSubscription {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) return fail('invalid_request', 'invalid limit');
    return this.readTransaction(() => { const sequence = decodeCursor(from, sessionId); const row = this.row('SELECT event_floor,event_seq FROM sessions WHERE id=?', sessionId); if (!row) return fail('invalid_request', 'unknown session');
      if (sequence < Number(row.event_floor)) return { status: 'snapshot_required', error: contractError('snapshot_required') };
      if (sequence > Number(row.event_seq)) return fail('invalid_request', 'future cursor');
      const rows = this.db.prepare('SELECT value FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?').all(sessionId, sequence, limit) as Record<string, unknown>[]; const events = rows.map(r => parse<Event>(r.value));
      return { status: 'events', events, cursor: events.at(-1)?.cursor ?? from };
    });
  }
  /** Retain a watermark even when old events are removed. */
  compactEvents(sessionId: string, throughCursor: string): void {
    this.transaction(() => {
      const sequence = decodeCursor(throughCursor, sessionId);
      const row = this.row('SELECT event_floor,event_seq FROM sessions WHERE id=?', sessionId);
      if (!row || sequence < Number(row.event_floor) || sequence > Number(row.event_seq)) return fail('invalid_request', 'invalid compaction watermark');
      this.run('DELETE FROM events WHERE session_id=? AND seq<=?', sessionId, sequence);
      this.run(`DELETE FROM event_keys WHERE json_extract(value,'$._k')=1 AND json_extract(value,'$.i')=1
        AND json_extract(value,'$.s')=? AND json_extract(value,'$.q')<=?`, sessionId, sequence);
      this.run('UPDATE sessions SET event_floor=? WHERE id=?', sequence, sessionId);
    });
  }
  eventFloor(sessionId: string): number {
    const row = this.row('SELECT event_floor FROM sessions WHERE id=?', sessionId);
    if (!row) return fail('invalid_request', 'unknown session');
    return Number(row.event_floor);
  }
}
