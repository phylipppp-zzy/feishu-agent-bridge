import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { canTransitionOperation, payloadDigest, SCHEMA_VERSION, validateResolution, validateWriteContext, type Event, type EventSubscription, type Artifact, type Turn, type Interaction, type Message, type NativeResult, type Operation, type OperationStatus, type ResolveInteraction, type Session, type Snapshot, type WriteContext } from './contracts.js';
import { contractError, type ContractError, type ErrorCode } from './errors.js';

export class StoreError extends Error {
  constructor(readonly detail: ContractError) { super(detail.message ?? detail.code); }
}
const fail = (code: ErrorCode, message?: string): never => { throw new StoreError(contractError(code, message)); };
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const cursor = (sessionId: string, sequence: number): string => Buffer.from(JSON.stringify([sessionId, sequence])).toString('base64url');
function readCursor(value: string, sessionId: string): number {
  try { const c: unknown = JSON.parse(Buffer.from(value, 'base64url').toString()); if (Array.isArray(c) && c.length === 2 && c[0] === sessionId && Number.isSafeInteger(c[1]) && c[1] >= 0 && cursor(sessionId, c[1]) === value) return c[1]; } catch { /* invalid cursor */ }
  return fail('invalid_request', 'invalid cursor');
}

/** Isolated store; callers authenticate identities and mediate all native effects. */
export class UnifiedStore {
  private db: DatabaseSync;
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
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_interactions(id TEXT PRIMARY KEY REFERENCES interactions(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, idem TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(operation_id TEXT PRIMARY KEY REFERENCES operations(id), kind TEXT NOT NULL, payload TEXT NOT NULL, context TEXT NOT NULL, connection_generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','in_flight','unknown','done','cancelled')));
      CREATE TABLE IF NOT EXISTS notification_preferences(session_id TEXT PRIMARY KEY REFERENCES sessions(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_keys(event_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL, value TEXT NOT NULL, UNIQUE(session_id, seq));
      PRAGMA application_id=1431193926; PRAGMA user_version=2; COMMIT;`);
  }
  close(): void { this.db.close(); }
  private transaction<T>(f: () => T): T { const nested=this.migrationLocked; this.db.exec(nested?'SAVEPOINT migration_op':'BEGIN IMMEDIATE'); try { const v=f(); this.db.exec(nested?'RELEASE migration_op':'COMMIT'); return v; } catch(e) { this.db.exec(nested?'ROLLBACK TO migration_op; RELEASE migration_op':'ROLLBACK'); throw e; } }
  beginMigrationRollback():void { if(this.migrationLocked) throw new Error('migration lock already held'); this.db.exec('BEGIN IMMEDIATE'); this.migrationLocked=true; }
  endMigrationRollback(commit:boolean):void { if(!this.migrationLocked) throw new Error('migration lock not held'); try {this.db.exec(commit?'COMMIT':'ROLLBACK');} catch(e) {if(commit) {try {this.db.exec('ROLLBACK');} catch {}} throw e;} finally {this.migrationLocked=false;} }
  inspectMigrationSession(id:string,sessionId:string):'removable'|'retained'|'absent' { if(!this.migrationLocked) throw new Error('migration lock required'); this.db.exec('SAVEPOINT migration_inspect'); try {const result=this.rollbackMigrationSession(id); if(result==='retained' && !this.row('SELECT 1 AS present FROM sessions WHERE id=?',sessionId)) throw new Error('migration session missing despite receipt; manual review'); this.db.exec('ROLLBACK TO migration_inspect; RELEASE migration_inspect'); return result==='removed'?'removable':result==='absent' && this.row('SELECT 1 AS present FROM sessions WHERE id=?',sessionId)?'retained':result;} catch(e) {this.db.exec('ROLLBACK TO migration_inspect; RELEASE migration_inspect');throw e;} }

  private row(sql: string, ...args: (string | number)[]): Record<string, unknown> | undefined { return this.db.prepare(sql).get(...args) as Record<string, unknown> | undefined; }
  private run(sql: string, ...args: (string | number)[]): void { this.db.prepare(sql).run(...args); }
  private session(id: string): Session { const r = this.row('SELECT value FROM sessions WHERE id=?', id); if (!r) return fail('invalid_request', 'unknown session'); return parse<Session>(r.value); }
  getSession(id: string): Session { return this.session(id); }
  getInteraction(id: string): Interaction { const r = this.row('SELECT value FROM interactions WHERE id=?', id); if (!r) return fail('invalid_request', 'unknown interaction'); return parse<Interaction>(r.value); }
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
    if (this.row('SELECT 1 AS present FROM dispatch_leases WHERE session_id=? LIMIT 1',id) || this.row("SELECT 1 AS present FROM operations WHERE json_extract(value,'$.targetId')=? OR json_extract(value,'$.result.sessionId')=? LIMIT 1",id,id) || this.row("SELECT 1 AS present FROM event_keys WHERE json_extract(value,'$.sessionId')=? LIMIT 1",id)) return 'retained';
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
  quarantineRecovery(id:string, reason:string):void { this.run('INSERT INTO recovery_quarantine(session_id,reason,connection_generation) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET reason=excluded.reason',id,reason,this.connectionGeneration(id)); }
  recoveryQuarantineGeneration(id:string):number|null { const row=this.row('SELECT connection_generation FROM recovery_quarantine WHERE session_id=?',id); return row ? Number(row.connection_generation) : null; }
  clearRecoveryQuarantine(id:string):void { this.run('DELETE FROM recovery_quarantine WHERE session_id=?',id); }
  recoveryQuarantineCount():number { return Number(this.row('SELECT COUNT(*) AS count FROM recovery_quarantine')?.count ?? 0); }
  recoveryQuarantined(id:string):boolean { return !!this.row('SELECT session_id FROM recovery_quarantine WHERE session_id=?',id); }
  hasInteractiveIntent(id:string):boolean { return !!this.row('SELECT session_id FROM interactive_intent WHERE session_id=?',id); }
  maxConnectionGeneration(): number { const row=this.row('SELECT MAX(connection_generation) AS value FROM sessions'); return Number(row?.value ?? 0); }
  /** Attach a native mapping and an idempotent bootstrap receipt in one transaction. */
  attachSession(context: WriteContext, session: Session, payload: unknown, connectionGeneration: number | null = null, observed?: {messages:Message[];interactions:Interaction[];turns?:Turn[]}): Operation { return this.transaction(() => {
    const old = this.existing(context, 'attachSession', payload); if (old.operation) return old.operation;
    if (connectionGeneration !== null && (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0)) return fail('invalid_request','invalid connection generation');
    const existing = this.findSession(session.native); const mapped = existing ?? session;
    if (!existing) this.run('INSERT INTO sessions(id,value,revision,control_generation,connection_generation) VALUES(?,?,?,?,?)',mapped.sessionId,JSON.stringify(mapped),mapped.revision,mapped.control.generation,connectionGeneration ?? 0);
    else if (connectionGeneration !== null) { const previous=this.connectionGeneration(mapped.sessionId); if(connectionGeneration < previous) return fail('interaction_expired','stale connection generation'); if(connectionGeneration > previous) {this.invalidateDeliveries(mapped.sessionId,true);this.run('UPDATE sessions SET connection_generation=? WHERE id=?',connectionGeneration,mapped.sessionId);} }
    if (existing && (payload as {mode?:string}).mode === 'interactive') {
      const current=this.getSession(existing.sessionId);
      if (session.control.generation <= current.control.generation) return fail('control_conflict','control generation must advance');
      const updated={...session,sessionId:existing.sessionId,revision:current.revision+1};
      this.invalidateDeliveries(existing.sessionId,false);
      this.run('UPDATE sessions SET value=?,revision=?,control_generation=? WHERE id=?',JSON.stringify(updated),updated.revision,updated.control.generation,existing.sessionId);
      this.eventFor(existing.sessionId,existing.sessionId,updated.revision,'session.updated',null,updated);
    }
    if (observed) {
      for (const native of observed.turns ?? []) this.putTurnInTransaction({...native,sessionId:mapped.sessionId});
      for (const native of observed.messages) { const value={...native,sessionId:mapped.sessionId}; const prior=this.row('SELECT session_id FROM messages WHERE id=?',value.messageId); if(prior && prior.session_id !== mapped.sessionId) return fail('idempotency_conflict','message id belongs to another session'); if(!prior) { this.run('INSERT INTO messages(id,session_id,value) VALUES(?,?,?)',value.messageId,mapped.sessionId,JSON.stringify(value)); this.eventFor(mapped.sessionId,value.messageId,value.revision,'message.updated',null,value); } }
      for (const native of observed.interactions) { const value={...native,sessionId:mapped.sessionId}; const prior=this.row('SELECT session_id FROM interactions WHERE id=?',value.interactionId); if(prior && prior.session_id !== mapped.sessionId) return fail('idempotency_conflict','interaction id belongs to another session'); if(!prior) { if(value.connectionGeneration !== this.connectionGeneration(mapped.sessionId)) return fail('interaction_expired'); this.run('INSERT INTO interactions(id,session_id,value) VALUES(?,?,?)',value.interactionId,mapped.sessionId,JSON.stringify(value)); if(native.status === 'awaiting_answer') this.run('INSERT INTO native_interactions(id,value) VALUES(?,?)',value.interactionId,JSON.stringify(native)); this.eventFor(mapped.sessionId,value.interactionId,value.revision,'interaction.created',null,value); } }
    }
    if ((payload as {mode?:string}).mode === 'interactive') this.run('INSERT OR IGNORE INTO interactive_intent(session_id) VALUES(?)',mapped.sessionId);
    const op: Operation = {operationId:context.operationId,idempotencyKey:context.idempotencyKey,targetId:context.targetId,action:'attachSession',payloadDigest:old.digest,status:'completed',revision:1,error:null,result:{kind:'session',sessionId:mapped.sessionId}};
    this.run('INSERT INTO operations(id,idem,digest,value) VALUES(?,?,?,?)',op.operationId,op.idempotencyKey,old.digest,JSON.stringify(op));
    this.run('INSERT INTO outbox(operation_id,kind,payload,context,connection_generation,state) VALUES(?,?,?,?,?,?)',op.operationId,'attachSession',JSON.stringify(payload),JSON.stringify(context),connectionGeneration ?? 0,'done');
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
    if (!['completed','failed','interrupted'].includes(turn.status)) return;
    const row = this.row('SELECT operation_id FROM operation_turns WHERE session_id=? AND turn_id=?',turn.sessionId,turn.turnId); if (!row) return;
    const id=String(row.operation_id), op=this.getOperation(id); if (op.status !== 'accepted' && op.status !== 'unknown') return;
    const status = turn.status === 'completed' ? 'completed' : 'failed'; const next: Operation = {...op,status,revision:op.revision+1,error:null,result:{kind:'turn',turnId:turn.turnId,status:turn.status as 'completed'|'failed'|'interrupted'}};
    this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(next),id); this.run("UPDATE outbox SET state='done' WHERE operation_id=?",id); this.eventFor(turn.sessionId,id,next.revision,`operation.${status}`,id,next);
  }
  confirmedSettings(id: string): {model:string|null; preferences:Record<string,string>; revision:number} | null { this.session(id); const row=this.row('SELECT value,revision FROM session_settings WHERE session_id=?',id); return row ? {...parse<{model:string|null;preferences:Record<string,string>}>(row.value),revision:Number(row.revision)} : null; }
  settingsBarrier(id: string): 'pending' | 'unknown' | null { const rows=this.db.prepare("SELECT context,state FROM outbox WHERE kind='updateSessionSettings' AND state IN ('pending','in_flight','unknown')").all() as Record<string,unknown>[]; const states=rows.filter(row=>parse<WriteContext>(row.context).targetId===id).map(row=>row.state); return states.includes('unknown') ? 'unknown' : states.length ? 'pending' : null; }
  confirmSettings(id: string, value: {model:string|null;preferences:Record<string,string>}): Operation { return this.transaction(()=>{
    const op=this.getOperation(id), out=this.getOutbox(id); if(op.action!=='updateSessionSettings'||out.state!=='in_flight'||op.status!=='received'||payloadDigest(out.payload)!==payloadDigest(value)) return fail('invalid_request');
    this.run('INSERT INTO session_settings(session_id,value,revision,operation_id) VALUES(?,?,1,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value,revision=session_settings.revision+1,operation_id=excluded.operation_id',op.targetId,JSON.stringify(value),id);
    const accepted:Operation={...op,status:'accepted',revision:op.revision+1};this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(accepted),id);this.eventFor(op.targetId,id,accepted.revision,'operation.accepted',id,accepted);
    const done:Operation={...accepted,status:'completed',revision:accepted.revision+1};this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(done),id);this.run("UPDATE outbox SET state='done' WHERE operation_id=?",id);this.eventFor(op.targetId,id,done.revision,'operation.completed',id,done);return done;
  }); }
  /** Persist the actual native turn reference and handle observations that arrived before the acknowledgement. */
  acceptSubmission(id: string, nativeReference: string | null): Operation { return this.transaction(() => {
    const op=this.getOperation(id); const out=this.getOutbox(id); if (out.state !== 'in_flight' || !canTransitionOperation(op.status,'accepted')) return fail('invalid_request');
    if (op.action === 'submitInput' && nativeReference) this.run('INSERT INTO operation_turns(operation_id,session_id,turn_id) VALUES(?,?,?)',id,op.targetId,nativeReference);
    const next: Operation = {...op,status:'accepted',revision:op.revision+1,error:null}; this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(next),id); this.eventFor(op.targetId,id,next.revision,'operation.accepted',id,next);
    if (op.action === 'submitInput' && nativeReference) {const row=this.row('SELECT value FROM turns WHERE id=? AND session_id=?',nativeReference,op.targetId); if(row) this.settleTurn(parse<Turn>(row.value));}
    return this.getOperation(id);
  }); }
  private putTurnInTransaction(turn: Turn): void { this.session(turn.sessionId); const old = this.row('SELECT value FROM turns WHERE id=?',turn.turnId); if (old) {const prior=parse<Turn>(old.value); if(prior.sessionId !== turn.sessionId) return fail('invalid_request'); if(JSON.stringify(prior) === JSON.stringify(turn)) { this.settleTurn(prior); return; } if (['completed','failed','interrupted'].includes(prior.status)) { this.settleTurn(prior); return; } } this.run('INSERT INTO turns(id,session_id,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',turn.turnId,turn.sessionId,JSON.stringify(turn)); this.eventFor(turn.sessionId,turn.turnId,0,'turn.updated',null,turn); this.settleTurn(turn); }
  putTurn(turn: Turn): void { this.transaction(() => this.putTurnInTransaction(turn)); }
  operationTurn(id:string): {sessionId:string;turnId:string} | null { const row=this.row('SELECT session_id,turn_id FROM operation_turns WHERE operation_id=?',id); return row ? {sessionId:String(row.session_id),turnId:String(row.turn_id)} : null; }
  /** Apply live turn evidence and its session status atomically; stale terminals never clear newer work. */
  observeTurn(turn: Turn): void { this.transaction(() => {
    const current=this.session(turn.sessionId), previous=this.listTurns(turn.sessionId).find(t=>t.turnId===turn.turnId);
    this.putTurnInTransaction(turn);
    if (this.isDetached(turn.sessionId) || this.recoveryQuarantined(turn.sessionId) || current.control.input!=='available' || !['idle','running','waiting_question','waiting_approval'].includes(current.status)) return;
    const interactions=this.snapshotInteractions(turn.sessionId).filter(i=>i.status==='awaiting_answer'||i.status==='answer_pending_delivery');
    const active=this.listTurns(turn.sessionId).some(t=>t.status==='running'||t.status==='queued');
    let status=current.status;
    if (interactions.length) status=interactions.some(i=>i.kind==='approval') ? 'waiting_approval' : 'waiting_question';
    else if (turn.status==='running' && (!previous || previous.status==='queued' || previous.status==='running')) status='running';
    else if (previous?.status==='running' && ['completed','failed','interrupted'].includes(turn.status) && !active) status=turn.status==='completed' ? 'idle' : turn.status as 'failed'|'interrupted';
    if(status!==current.status) { const next={...current,status,revision:current.revision+1}; this.run('UPDATE sessions SET value=?,revision=? WHERE id=?',JSON.stringify(next),next.revision,turn.sessionId); this.eventFor(turn.sessionId,turn.sessionId,next.revision,'session.updated',null,next); }
  }); }
  observeInteractionStatus(sessionId:string, turnId:string): void { this.transaction(() => {
    const current=this.session(sessionId); if(this.isDetached(sessionId) || this.recoveryQuarantined(sessionId) || current.control.input!=='available' || !['idle','running','waiting_question','waiting_approval'].includes(current.status)) return;
    const interactions=this.snapshotInteractions(sessionId).filter(i=>i.status==='awaiting_answer'||i.status==='answer_pending_delivery'); const turns=this.listTurns(sessionId), turn=turns.find(t=>t.turnId===turnId); let status=current.status;
    if(interactions.length) status=interactions.some(i=>i.kind==='approval') ? 'waiting_approval' : 'waiting_question';
    else if(turn?.status==='running') status='running';
    else if(turn && ['completed','failed','interrupted'].includes(turn.status) && !turns.some(t=>t.status==='running'||t.status==='queued')) status=turn.status==='completed' ? 'idle' : turn.status as 'failed'|'interrupted';
    if(status!==current.status) {const next={...current,status,revision:current.revision+1};this.run('UPDATE sessions SET value=?,revision=? WHERE id=?',JSON.stringify(next),next.revision,sessionId);this.eventFor(sessionId,sessionId,next.revision,'session.updated',null,next);}
  }); }
  listTurns(sessionId: string): Turn[] { this.session(sessionId); return (this.db.prepare('SELECT value FROM turns WHERE session_id=? ORDER BY rowid').all(sessionId) as Record<string,unknown>[]).map(r => parse<Turn>(r.value)); }
  queuedInputs(sessionId:string): Array<{inputId:string}> { this.session(sessionId); return this.pendingOutbox().filter(id=>{const o=this.getOutbox(id);return o.context.targetId===sessionId && o.kind==='submitInput' && (o.payload as {mode?:string}).mode==='queue';}).map(inputId=>({inputId})); }
  cancelQueuedInput(context: WriteContext, inputId: string): Operation { return this.transaction(() => {
    const payload = {inputId}; const existing = this.existing(context,'cancelQueuedInput',payload); if (existing.operation) return existing.operation;
    const session = this.session(context.targetId); if (session.revision !== context.expectedRevision) return fail('stale_revision'); if (session.control.generation !== context.controlGeneration) return fail('control_conflict');
    const out = this.getOutbox(inputId); if (out.context.targetId !== context.targetId || out.kind !== 'submitInput' || (out.payload as {mode?: string}).mode !== 'queue' || out.state !== 'pending') return fail('busy','input is no longer queued');
    this.cancelPending(inputId); const op = this.receipt(context,'cancelQueuedInput',existing.digest,payload); const done: Operation = {...op,status:'completed',revision:1}; this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(done),op.operationId); this.run("UPDATE outbox SET state='done' WHERE operation_id=?",op.operationId); this.eventFor(context.targetId,op.operationId,1,'operation.completed',op.operationId,done); return done;
  }); }
  /** Stable insertion ordering supports restart-safe pagination. */
  listSessions(): Session[] { return (this.db.prepare('SELECT value FROM sessions ORDER BY rowid').all() as Record<string, unknown>[]).map(r => parse<Session>(r.value)); }
  findSession(native: Session['native']): Session | undefined { const row = this.row("SELECT value FROM sessions WHERE json_extract(value,'$.native.provider')=? AND json_extract(value,'$.native.hostId')=? AND json_extract(value,'$.native.serviceId')=? AND json_extract(value,'$.native.nativeSessionId')=?",native.provider,native.hostId,native.serviceId,native.nativeSessionId); return row ? parse<Session>(row.value) : undefined; }
  connectionGeneration(id: string): number { const row = this.row('SELECT connection_generation FROM sessions WHERE id=?', id); if (!row) return fail('invalid_request', 'unknown session'); return Number(row.connection_generation); }
  hasUnsettledInput(sessionId: string, exceptId: string): boolean { const rows = this.db.prepare("SELECT operation_id,context FROM outbox WHERE kind='submitInput' AND state IN ('in_flight','unknown')").all() as Record<string,unknown>[]; return rows.some(row => row.operation_id !== exceptId && parse<WriteContext>(row.context).targetId === sessionId); }
  interactionHealthCounts():{pending:number;unknown:number} {const row=this.db.prepare("SELECT COALESCE(SUM(CASE WHEN json_extract(value,'$.status')='answer_pending_delivery' THEN 1 ELSE 0 END),0) AS pending, COALESCE(SUM(CASE WHEN json_extract(value,'$.status')='answer_pending_delivery' OR (json_extract(value,'$.status')='resolved' AND json_extract(value,'$.nativeResult.status')='unknown') THEN 1 ELSE 0 END),0) AS unknown FROM interactions").get() as {pending:number;unknown:number};return {pending:Number(row.pending),unknown:Number(row.unknown)};}
  hasStopRequest(sessionId:string,turnId:string):boolean {return !!this.db.prepare("SELECT 1 FROM outbox WHERE kind='interruptTurn' AND state IN ('in_flight','unknown','done') AND json_extract(context,'$.targetId')=? AND json_extract(payload,'$.turnId')=? LIMIT 1").get(sessionId,turnId);}
  pendingOutbox(): string[] { return (this.db.prepare("SELECT operation_id FROM outbox WHERE state='pending' ORDER BY rowid").all() as Record<string, unknown>[]).map(r => String(r.operation_id)); }
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
    if (session.control.generation !== old.control.generation) this.invalidateDeliveries(session.sessionId, false);
    this.run('UPDATE sessions SET value=?,revision=?,control_generation=? WHERE id=?', JSON.stringify(session), session.revision, session.control.generation, session.sessionId);
    this.eventFor(session.sessionId, session.sessionId, session.revision, 'session.updated', null, session);
  }); }
  putMessage(value: Message, expectedRevision: number | null): void { this.transaction(() => {
    this.session(value.sessionId); const row = this.row('SELECT value FROM messages WHERE id=?', value.messageId);
    if (row) { const old = parse<Message>(row.value); if (old.sessionId !== value.sessionId || old.revision !== expectedRevision || value.revision !== old.revision + 1) return fail('stale_revision');
      this.run('UPDATE messages SET value=? WHERE id=?', JSON.stringify(value), value.messageId);
    } else { if (expectedRevision !== null) return fail('stale_revision'); this.run('INSERT INTO messages(id,session_id,value) VALUES(?,?,?)', value.messageId, value.sessionId, JSON.stringify(value)); }
    this.eventFor(value.sessionId, value.messageId, value.revision, 'message.updated', null, value);
  }); }
  setConnectionGeneration(sessionId: string, expected: number, next: number): void { this.transaction(() => {
    const row = this.row('SELECT connection_generation FROM sessions WHERE id=?', sessionId);
    if (!row || Number(row.connection_generation) !== expected) return fail('stale_revision', 'connection generation changed');
    if (!Number.isSafeInteger(next) || next <= expected) return fail('invalid_request', 'connection generation must increase');
    this.invalidateDeliveries(sessionId, true);
    this.run('UPDATE sessions SET connection_generation=? WHERE id=?', next, sessionId);
  }); }
  insertInteraction(value: Interaction, native: Interaction = value): void { this.transaction(() => {
    if (native.interactionId !== value.interactionId || native.nativeRequestId !== value.nativeRequestId || native.connectionGeneration !== value.connectionGeneration || native.status !== 'awaiting_answer' || value.status !== 'awaiting_answer') return fail('invalid_request','invalid native interaction snapshot');
    const row = this.row('SELECT connection_generation FROM sessions WHERE id=?', value.sessionId);
    if (!row || Number(row.connection_generation) !== value.connectionGeneration) return fail('interaction_expired');
    this.run('INSERT INTO interactions(id,session_id,value) VALUES(?,?,?)', value.interactionId, value.sessionId, JSON.stringify(value));
    this.run('INSERT INTO native_interactions(id,value) VALUES(?,?)', value.interactionId, JSON.stringify(native));
    this.eventFor(value.sessionId, value.interactionId, value.revision, 'interaction.created', null, value);
  }); }
  getNativeInteraction(id: string): Interaction { const row = this.row('SELECT value FROM native_interactions WHERE id=?',id); if (!row) return fail('temporarily_unavailable','original native interaction snapshot unavailable'); return parse<Interaction>(row.value); }
  expireNativeInteraction(id: string, generation: number, requestId: string, status: 'expired' | 'cancelled', nativeResult: NativeResult | null = null): Interaction { return this.transaction(() => {
    const current = this.getInteraction(id); const connection = this.connectionGeneration(current.sessionId);
    if (connection !== generation || current.connectionGeneration !== generation || current.nativeRequestId !== requestId) return fail('interaction_expired');
    if (current.status === status || current.status === 'resolved' || current.status === 'expired' || current.status === 'cancelled') return current;
    const updated: Interaction = {...current,status,nativeResult:nativeResult ?? current.nativeResult,revision:current.revision+1}; this.run('UPDATE interactions SET value=? WHERE id=?',JSON.stringify(updated),id); this.eventFor(current.sessionId,id,updated.revision,`interaction.${status}`,null,updated);
    const rows = this.db.prepare("SELECT operation_id,payload,state FROM outbox WHERE kind='resolveInteraction' AND state IN ('pending','in_flight')").all() as Record<string,unknown>[];
    for (const row of rows) if (parse<ResolveInteraction>(row.payload).interactionId === id) { if (row.state === 'pending') this.cancelPending(String(row.operation_id)); else this.markUnknownInTransaction(String(row.operation_id)); }
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
    if (session.revision !== context.expectedRevision) return fail('stale_revision');
    if (session.control.generation !== context.controlGeneration) return fail('control_conflict');
    if (action === 'interruptTurn' && !this.listTurns(context.targetId).some(t=>t.turnId === (payload as {turnId:string}).turnId && t.status === 'running')) return fail('busy','turn is no longer running');
    return this.receipt(context, action, existing.digest, payload);
  }); }
  /** The bridge CAS registers an intent, not a claim that the native request accepted it. */
  resolveInteraction(request: ResolveInteraction, now = Date.now()): Operation { return this.transaction(() => {
    const { context } = request; const existing = this.existing(context, 'resolveInteraction', request); if (existing.operation) return existing.operation;
    const session = this.session(context.targetId);
    if (session.control.generation !== context.controlGeneration) return fail('control_conflict');
    const interaction = this.getInteraction(request.interactionId);
    const connection = this.row('SELECT connection_generation FROM sessions WHERE id=?', context.targetId);
    if (!connection || Number(connection.connection_generation) !== request.expectedConnectionGeneration) return fail('interaction_expired');
    const valid = validateResolution(request, interaction, now); if (!valid.ok) throw new StoreError(valid.error);
    const updated: Interaction = { ...interaction, status: 'answer_pending_delivery', revision: interaction.revision + 1 };
    this.run('UPDATE interactions SET value=? WHERE id=?', JSON.stringify(updated), updated.interactionId);
    this.eventFor(updated.sessionId, updated.interactionId, updated.revision, 'interaction.answer_pending_delivery', context.operationId, updated);
    return this.receipt(context, 'resolveInteraction', existing.digest, request);
  }); }
  /** Apply an observed native result only to the same native connection and request. */
  recordNativeResult(id: string, connectionGeneration: number, nativeRequestId: string, result: NativeResult, terminal = false): Interaction { return this.transaction(() => {
    const current = this.getInteraction(id);
    const connection = this.row('SELECT connection_generation FROM sessions WHERE id=?', current.sessionId);
    if (!connection || Number(connection.connection_generation) !== connectionGeneration || current.connectionGeneration !== connectionGeneration || current.nativeRequestId !== nativeRequestId) return fail('interaction_expired');
    if (current.status === 'resolved') {
      if (payloadDigest(current.nativeResult) !== payloadDigest(result)) return fail('stale_revision', 'conflicting native result');
      return current;
    }
    if (current.status === 'expired' || current.status === 'cancelled') return fail('interaction_expired');
    const updated: Interaction = { ...current, nativeResult: result, status: result.status === 'accepted' || terminal ? 'resolved' : current.status, revision: current.revision + 1 };
    this.run('UPDATE interactions SET value=? WHERE id=?', JSON.stringify(updated), id);
    this.eventFor(updated.sessionId, id, updated.revision, 'interaction.native_result', null, updated);
    if (result.status === 'accepted' || terminal) {
      // Cancel only work not yet handed out; in-flight delivery must be reconciled by the adapter.
      const rows = this.db.prepare("SELECT operation_id,payload,state FROM outbox WHERE kind='resolveInteraction' AND state IN ('pending','in_flight','unknown')").all() as Record<string, unknown>[];
      for (const row of rows) { const req = parse<ResolveInteraction>(row.payload); if (req.interactionId === id) {
        const opId = String(row.operation_id); this.run('UPDATE outbox SET state=? WHERE operation_id=?', row.state === 'pending' ? 'cancelled' : 'unknown', opId);
        const op = this.getOperation(opId);
        if (row.state === 'pending' && canTransitionOperation(op.status, 'failed')) {
          const next: Operation = { ...op, status: 'failed', revision: op.revision + 1, error: contractError('interaction_expired', 'native request already answered') };
          this.run('UPDATE operations SET value=? WHERE id=?', JSON.stringify(next), opId); this.eventFor(op.targetId, opId, next.revision, 'operation.failed', opId, next);
        } else if (row.state !== 'pending' && op.status !== 'unknown' && canTransitionOperation(op.status, 'unknown')) {
          const next: Operation = { ...op, status: 'unknown', revision: op.revision + 1, error: contractError('outcome_unknown') };
          this.run('UPDATE operations SET value=? WHERE id=?', JSON.stringify(next), opId); this.eventFor(op.targetId, opId, next.revision, 'operation.unknown', opId, next);
        }
      } }
    }
    return updated;
  }); }
  getOutbox(id: string): { kind: string; payload: unknown; context: WriteContext; connectionGeneration: number; state: string } { const r = this.row('SELECT kind,payload,context,connection_generation,state FROM outbox WHERE operation_id=?', id); if (!r) return fail('invalid_request', 'unknown outbox'); return { kind: String(r.kind), payload: parse(r.payload), context: parse<WriteContext>(r.context), connectionGeneration: Number(r.connection_generation), state: String(r.state) }; }
  /** SQLite serializes claim and generation changes; native submission still requires an adapter-side final fence. */
  claimOutbox(id: string, now = Date.now()): boolean { return this.transaction(() => {
    const row = this.row('SELECT kind,payload,context,connection_generation,state FROM outbox WHERE operation_id=?', id);
    if (!row || row.state !== 'pending') return false;
    const context = parse<WriteContext>(row.context);
    const session = this.row('SELECT control_generation,connection_generation FROM sessions WHERE id=?', context.targetId);
    let valid = !!session && Number(session.control_generation) === context.controlGeneration && Number(session.connection_generation) === Number(row.connection_generation);
    if (valid && row.kind === 'resolveInteraction') {
      const req = parse<ResolveInteraction>(row.payload); const interaction = this.getInteraction(req.interactionId);
      valid = interaction.sessionId === context.targetId && interaction.connectionGeneration === req.expectedConnectionGeneration && interaction.status === 'answer_pending_delivery' && interaction.nativeResult === null && Number.isFinite(now) && (interaction.expiresAt === null || (Number.isFinite(Date.parse(interaction.expiresAt)) && Date.parse(interaction.expiresAt) > now));
    }
    if (!valid) { this.cancelPending(id); return false; }
    this.run("UPDATE outbox SET state='in_flight' WHERE operation_id=?", id); return true;
  }); }
  /** Pending at restart is not proof of a currently authorized delivery context. */
  failUnreboundPending(ids:string[]):void { this.transaction(()=>{ for(const id of ids) { const out=this.getOutbox(id); if(out.state!=='pending') continue; if(this.row('SELECT id FROM sessions WHERE id=?',out.context.targetId)) {this.cancelPending(id);continue;} const op=this.getOperation(id); if(canTransitionOperation(op.status,'failed')) {const next:Operation={...op,status:'failed',revision:op.revision+1,error:contractError('control_conflict','restart requires a new authorized request')};this.run('UPDATE operations SET value=? WHERE id=?',JSON.stringify(next),id);this.run("UPDATE outbox SET state='cancelled' WHERE operation_id=?",id);} } }); }
  private cancelPending(id: string): void {
    this.run("UPDATE outbox SET state='cancelled' WHERE operation_id=? AND state='pending'", id);
    const op = this.getOperation(id);
    if (canTransitionOperation(op.status, 'failed')) { const next: Operation = { ...op, status: 'failed', revision: op.revision + 1, error: op.action === 'resolveInteraction' ? contractError('interaction_expired', 'delivery context no longer valid') : contractError('control_conflict', 'request was not executed; submit again after control is restored') }; this.run('UPDATE operations SET value=? WHERE id=?', JSON.stringify(next), id); this.eventFor(op.targetId, id, next.revision, 'operation.failed', id, next); }
  }
  private invalidateDeliveries(sessionId: string, expireInteractions: boolean): void {
    const rows = this.db.prepare("SELECT operation_id,state,context FROM outbox WHERE state IN ('pending','in_flight')").all() as Record<string, unknown>[];
    for (const row of rows) if (parse<WriteContext>(row.context).targetId === sessionId) {
      if (row.state === 'pending') this.cancelPending(String(row.operation_id)); else this.markUnknownInTransaction(String(row.operation_id));
    }
    {
      const interactions = this.db.prepare('SELECT value FROM interactions WHERE session_id=?').all(sessionId) as Record<string, unknown>[];
      for (const row of interactions) { const current = parse<Interaction>(row.value);
        if ((expireInteractions && current.status === 'awaiting_answer') || current.status === 'answer_pending_delivery') {
          const next: Interaction = { ...current, status: 'expired', revision: current.revision + 1 };
          this.run('UPDATE interactions SET value=? WHERE id=?', JSON.stringify(next), next.interactionId); this.eventFor(sessionId, next.interactionId, next.revision, 'interaction.expired', null, next);
        }
      }
    }
  }
  /** Only recover work whose dispatch lease has expired; active workers remain untouched. */
  recoverAbandonedInFlight(now = Date.now()): Operation[] { return this.transaction(() => {
    const rows = this.db.prepare("SELECT operation_id,context FROM outbox WHERE state='in_flight'").all() as Record<string,unknown>[]; const recovered: Operation[] = [];
    for (const row of rows) { const op = this.getOperation(String(row.operation_id)); if (op.status === 'accepted') continue; const context = parse<WriteContext>(row.context); const lease = this.row('SELECT expires FROM dispatch_leases WHERE session_id=?',context.targetId); if (!lease || Number(lease.expires) <= now) recovered.push(this.markUnknownInTransaction(String(row.operation_id))); } return recovered;
  }); }
  recoverInFlight(): Operation[] { return this.transaction(() => {
    const rows = this.db.prepare("SELECT operation_id FROM outbox WHERE state='in_flight'").all() as Record<string, unknown>[];
    return rows.map(row => this.markUnknownInTransaction(String(row.operation_id)));
  }); }
  markDeliveryUnknown(id: string): Operation { return this.transaction(() => this.markUnknownInTransaction(id)); }
  private markUnknownInTransaction(id: string): Operation {
    const out = this.getOutbox(id); if (out.state !== 'in_flight' && out.state !== 'unknown') return fail('invalid_request', 'delivery was not in flight');
    const op = this.getOperation(id); if (op.status !== 'unknown' && !canTransitionOperation(op.status, 'unknown')) return fail('invalid_request', 'invalid operation transition');
    const next: Operation = op.status === 'unknown' ? op : { ...op, status: 'unknown', revision: op.revision + 1, error: contractError('outcome_unknown') };
    this.run("UPDATE outbox SET state='unknown' WHERE operation_id=?", id); this.run('UPDATE operations SET value=? WHERE id=?', JSON.stringify(next), id); if (next !== op && this.row('SELECT id FROM sessions WHERE id=?',op.targetId)) this.eventFor(op.targetId, id, next.revision, 'operation.unknown', id, next); return next;
  }
  reconcileOperation(id: string, status: Extract<OperationStatus, 'accepted' | 'completed' | 'failed'>, error: ContractError | null = null): Operation { return this.transaction(() => {
    const op = this.getOperation(id); if (!canTransitionOperation(op.status, status)) return fail('invalid_request', 'invalid operation transition');
    const next: Operation = { ...op, status, revision: op.revision + 1, error }; this.run('UPDATE operations SET value=? WHERE id=?', JSON.stringify(next), id);
    this.run('UPDATE outbox SET state=? WHERE operation_id=?', status === 'accepted' ? 'in_flight' : 'done', id); this.eventFor(op.targetId, id, next.revision, `operation.${status}`, id, next); return next;
  }); }
  private eventFor(sessionId: string, objectId: string, revision: number, type: string, operationId: string | null, data: unknown): void {
    const now = new Date().toISOString();
    this.appendEventInTransaction({ eventId: randomUUID(), sessionId, objectId, objectRevision: revision, type, occurredAt: now, receivedAt: now, operationId, data });
  }
  appendEvent(input: Omit<Event, 'schemaVersion' | 'sequence' | 'cursor'>): Event { return this.transaction(() => this.appendEventInTransaction(input)); }
  private appendEventInTransaction(input: Omit<Event, 'schemaVersion' | 'sequence' | 'cursor'>): Event {
    const prior = this.row('SELECT value FROM event_keys WHERE event_id=?', input.eventId);
    if (prior) { const event = parse<Event>(prior.value); const { schemaVersion: _v, sequence: _s, cursor: _c, ...original } = event; if (payloadDigest(original) !== payloadDigest(input)) return fail('idempotency_conflict'); return event; }
    const row = this.row('SELECT event_seq FROM sessions WHERE id=?', input.sessionId); if (!row) return fail('invalid_request', 'unknown session');
    const sequence = Number(row.event_seq) + 1; const event: Event = { ...input, schemaVersion: SCHEMA_VERSION, sequence, cursor: cursor(input.sessionId, sequence) };
    this.run('INSERT INTO event_keys(event_id,value) VALUES(?,?)', input.eventId, JSON.stringify(event));
    this.run('INSERT INTO events(event_id,session_id,seq,value) VALUES(?,?,?,?)', input.eventId, input.sessionId, sequence, JSON.stringify(event)); this.run('UPDATE sessions SET event_seq=? WHERE id=?', sequence, input.sessionId); return event;
  }
  initialCursor(sessionId:string):string {this.session(sessionId);return cursor(sessionId,0);}
  snapshot(sessionId: string): Snapshot<{ session: Session; messages: Message[]; interactions: Interaction[] }> { return this.transaction(() => {
    const session = this.session(sessionId);
    const messages = (this.db.prepare('SELECT value FROM messages WHERE session_id=? ORDER BY rowid').all(sessionId) as Record<string, unknown>[]).map(r => parse<Message>(r.value));
    const interactions = (this.db.prepare('SELECT value FROM interactions WHERE session_id=? ORDER BY rowid').all(sessionId) as Record<string, unknown>[]).map(r => parse<Interaction>(r.value));
    const row = this.row('SELECT event_seq FROM sessions WHERE id=?', sessionId)!;
    return { value: { session, messages, interactions }, cursor: cursor(sessionId, Number(row.event_seq)) };
  }); }
  subscribeEvents(sessionId: string, from: string, limit: number): EventSubscription {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) return fail('invalid_request', 'invalid limit');
    return this.transaction(() => { const sequence = readCursor(from, sessionId); const row = this.row('SELECT event_floor,event_seq FROM sessions WHERE id=?', sessionId); if (!row) return fail('invalid_request', 'unknown session');
      if (sequence < Number(row.event_floor)) return { status: 'snapshot_required', error: contractError('snapshot_required') };
      if (sequence > Number(row.event_seq)) return fail('invalid_request', 'future cursor');
      const rows = this.db.prepare('SELECT value FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?').all(sessionId, sequence, limit) as Record<string, unknown>[]; const events = rows.map(r => parse<Event>(r.value));
      return { status: 'events', events, cursor: events.at(-1)?.cursor ?? from };
    });
  }
  /** Retain a watermark even when old events are removed. */
  compactEvents(sessionId: string, throughCursor: string): void { this.transaction(() => { const sequence = readCursor(throughCursor, sessionId); const row = this.row('SELECT event_floor,event_seq FROM sessions WHERE id=?', sessionId); if (!row || sequence < Number(row.event_floor) || sequence > Number(row.event_seq)) return fail('invalid_request', 'invalid compaction watermark'); this.run('DELETE FROM events WHERE session_id=? AND seq<=?', sessionId, sequence); this.run('UPDATE sessions SET event_floor=? WHERE id=?', sequence, sessionId); }); }
}
