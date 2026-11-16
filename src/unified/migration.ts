import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync, openSync, closeSync, linkSync, unlinkSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { Provider, Session, Identity, CapabilityName, Capabilities } from './contracts.js';

/** Explicit mappings are supplied by a reviewer; neither host nor owner is inferred. */
export interface MigrationSource { provider: Provider; path: string; hostId: string; serviceId: string; snapshot: { id: string; method: 'sqlite-backup'|'stopped-copy'|'fixture'; evidence: string; sha256?: string; schemaSha256?: string } }
export interface BindingMapping { provider: Provider; nativeSessionId: string; destination: string; owner: { source: string; subject: string }; chatId?:string; rootId?:string; threadId?:string; appId?:string; scopeEvidence?:string }
export interface MigrationInput { copyRoot: string; sources: MigrationSource[]; bindings: BindingMapping[]; transcripts?:Array<{provider:Provider; nativeSessionId:string; sourcePath:string; copyPath:string; sha256:string}> }
export interface ImportSession { sessionId: string; native: { provider: Provider; hostId: string; serviceId: string; nativeSessionId: string }; project: string; title: string; sourcePath:string }
export interface ImportBinding { sessionId: string; destination: string; owner: { source: string; subject: string }; chatId:string; rootId:string; threadId?:string; appId:string; scopeEvidence:string }
export interface Review { kind: string; provider: Provider; reason: string; count: number }
export interface Reference { sessionId: string; provider: Provider; snapshotId: string; sourcePath: string; table: string; fields: Record<string,string|number|null> }
export interface MigrationManifest { version: 1; snapshots: Array<{provider:Provider;path:string;id:string;method:string;evidence:string;sha256:string;schemaSha256:string}>; sessions: ImportSession[]; bindings: ImportBinding[]; references: Reference[]; review: Review[]; notes: string[] }
const hash = (x: unknown): string => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function inRoot(root: string, path: string): string {
  const r = realpathSync(root); const p = realpathSync(path); const rel = relative(r, p);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !statSync(p).isFile()) throw new Error('source must be a regular file inside copyRoot');
  // A detached WAL may contain uncheckpointed changes: never silently inspect an inconsistent main file.
  if (existsSync(`${p}-wal`) || existsSync(`${p}-journal`)) throw new Error('source has WAL or journal; provide a closed consistent copy');
  return p;
}
function cols(db: DatabaseSync, name: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{name: string}>).map(r => r.name));
}
export function snapshotDigest(path:string):string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function schemaDigest(db:DatabaseSync):string { const tables=['sessions','messages','archive_parts','file_cursors','cursors','turns','turn_outputs','file_deliveries','app_server_deliveries','server_requests','choice_queue','task_queue','feishu_prompts','sent_messages','backlog_batches','backlog_members']; return hash(tables.map(t=>[t,[...cols(db,t)].sort()])); }
function count(db: DatabaseSync, name: string): number { return Number((db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as {n: number}).n); }
/** Only explicitly selected index columns and table counts are read; no settings, payloads or message bodies. */
export function planMigration(input: MigrationInput): MigrationManifest {
  if (!input.sources.length || !existsSync(`${realpathSync(input.copyRoot)}/.migration-copy-root`)) throw new Error('copyRoot requires an explicit .migration-copy-root marker');
  const sessions: ImportSession[] = []; const review: Review[] = []; const bindings: ImportBinding[] = []; const references: Reference[] = []; const snapshots: MigrationManifest['snapshots'] = [];
  const sourceKeys = new Set<string>();
  const routeEvidence = new Map<string,{chatId:string|null;rootId:string|null;threadId:string|null}>();
  for (const s of input.sources) {
    if (!['codex','claude'].includes(s.provider) || !nonempty(s.hostId) || !nonempty(s.serviceId)) throw new Error('explicit provider, hostId and serviceId required');
    if (!nonempty(s.snapshot?.id) || !nonempty(s.snapshot?.evidence) || !['sqlite-backup','stopped-copy','fixture'].includes(s.snapshot?.method)) throw new Error('snapshot metadata required');
    const path = inRoot(input.copyRoot, s.path); if (sourceKeys.has(path)) throw new Error('duplicate source'); sourceKeys.add(path);
    const db = new DatabaseSync(path, {readOnly: true});
    try {
      const sha256=snapshotDigest(path), schemaSha256=schemaDigest(db);
      if(s.snapshot.method!=='fixture' && (!s.snapshot.sha256 || !s.snapshot.schemaSha256)) throw new Error('verified snapshot hash and schema required');
      if((s.snapshot.sha256 && s.snapshot.sha256!==sha256) || (s.snapshot.schemaSha256 && s.snapshot.schemaSha256!==schemaSha256)) throw new Error('snapshot hash or schema mismatch');
      snapshots.push({provider:s.provider,path,...s.snapshot,sha256,schemaSha256});
      const c = cols(db, 'sessions'); if (!['session_id','cwd'].every(k => c.has(k))) throw new Error('unsupported sessions schema');
      if(s.snapshot.method!=='fixture') {
        const required=['session_id','cwd','path','root_message_id','chat_id',s.provider==='claude'?'custom_title':'title'];
        if(!required.every(k=>c.has(k))) throw new Error('unsupported legacy sessions schema');
        const profiles:Array<[string,string[]]>=[['turns',['session_id','turn_id','seq','view_json']],['turn_outputs',['session_id','turn_id','content']],['file_deliveries',['session_id','turn_id','path','version','source_refs_json']],['archive_parts',['session_id','start_offset','end_offset','sha256']],['server_requests',['session_id','nonce','status']]];
        for(const [table,fields] of profiles) {const present=cols(db,table); if(present.size && !fields.every(k=>present.has(k))) throw new Error(`unsupported legacy ${table} schema`);}
      }

      const title = s.provider === 'codex' && c.has('title') ? 'title' : s.provider === 'claude' && c.has('custom_title') ? 'custom_title' : "''";
      const root = c.has('root_message_id') ? 'root_message_id' : 'NULL';
      const chat = c.has('chat_id') ? 'chat_id' : 'NULL';
      const transcript = c.has('path') ? 'path' : 'NULL';
      const thread = c.has('thread_id') ? 'thread_id' : 'NULL';
      const rows = db.prepare(`SELECT session_id, cwd, ${title} AS title, ${root} AS root_id, ${chat} AS chat_id, ${transcript} AS transcript, ${thread} AS thread_id FROM sessions`).all() as Array<{session_id: string; cwd: string | null; title: string | null;root_id:string|null;chat_id:string|null;transcript:string|null;thread_id:string|null}>;
      for (const row of rows) {
        if (!nonempty(row.session_id) || !nonempty(row.cwd)) { review.push({kind:'session',provider:s.provider,reason:'missing native id or project',count:1}); continue; }
        const native = {provider:s.provider,hostId:s.hostId,serviceId:s.serviceId,nativeSessionId:row.session_id};
        routeEvidence.set(`migration:${hash(native)}`,{chatId:row.chat_id,rootId:row.root_id,threadId:row.thread_id});
        sessions.push({sessionId:`migration:${hash(native)}`,native,project:row.cwd,title:row.title ?? '',sourcePath:path});
        if (row.transcript) references.push({sessionId:`migration:${hash(native)}`,provider:s.provider,snapshotId:s.snapshot.id,sourcePath:path,table:'sessions',fields:{session_id:row.session_id,path:row.transcript}});
        else review.push({kind:'history',provider:s.provider,reason:'native transcript path missing',count:1});
        if (row.root_id || row.chat_id) review.push({kind:'binding',provider:s.provider,reason:'legacy topic requires explicit verified owner and destination mapping',count:1});
      }
      // Whitelisted identifiers only: no message bodies, payloads, credentials or arbitrary JSON.
      const specs: Array<[string,string[]]> = [
        ['messages',['message_id','session_id','feishu_message_id','direction','source_path','source_kind']],
        ['archive_parts',['session_id','start_offset','end_offset','sha256','feishu_message_id']],
        ['file_cursors',['session_id','path','parsed_offset','archived_offset','size','mtime_ms']],
        ['cursors',['session_id','path','offset','size','mtime_ms']],
        ['turns',['session_id','turn_id','seq','prompt_message_id','card_message_id','rendered_hash','attachment_message_id']],
        ['file_deliveries',['session_id','turn_id','path','version','content_hash','chat_id','root_message_id','status','file_message_id','request_uuid']],
        ['app_server_deliveries',['session_id','turn_id','role','content_hash','content_bytes','feishu_message_id','source_message_id','source_path']],
        ['server_requests',['session_id','nonce','turn_id','item_id','epoch','type','status','expires_at_ms','card_message_id']],
        ['choice_queue',['session_id','request_id','created_at_ms']],
        ['task_queue',['session_id','id','turn_id','source_message_id','status','sync_status']],
        ['feishu_prompts',['session_id','uuid','message_id']], ['sent_messages',['session_id','message_id']],
        ['backlog_batches',['session_id','batch_id','root_message_id','card_message_id','markdown_message_id','status']],
        ['backlog_members',['session_id','turn_id','batch_id']],
      ];
      for (const [table,wanted] of specs) {
        const available=cols(db,table); if (!available.size || !available.has('session_id')) continue;
        const selected=wanted.filter(k=>available.has(k));
        const records=db.prepare(`SELECT ${selected.map(k=>`"${k}"`).join(',')} FROM "${table}"`).all() as Array<Record<string,unknown>>;
        for (const record of records) {
          const matching=sessions.filter(x=>x.native.provider===s.provider && x.native.hostId===s.hostId && x.native.serviceId===s.serviceId && x.native.nativeSessionId===record.session_id);
          if (matching.length!==1) { review.push({kind:'reference',provider:s.provider,reason:`${table}: missing or ambiguous session`,count:1}); continue; }
          const fields: Record<string,string|number|null>={};
          for(const key of selected) { const value=record[key]; if (value===null || typeof value==='string' || typeof value==='number') fields[key]=value; else throw new Error('unsupported reference value'); }
          references.push({sessionId:matching[0]!.sessionId,provider:s.provider,snapshotId:s.snapshot.id,sourcePath:path,table,fields});
          if ((table==='file_deliveries' && (!record.version || !record.path)) || (table==='archive_parts' && (!record.sha256 || record.start_offset == null || record.end_offset == null))) review.push({kind:'reference',provider:s.provider,reason:`${table}: incomplete file or range reference`,count:1});
          if (table==='file_deliveries') review.push({kind:'reference',provider:s.provider,reason:'file source_refs_json requires controlled review; not read by planner',count:1});
        }
      }
      for (const [table,kind] of [['messages','history'],['archive_parts','history'],['turns','history'],['file_deliveries','file_versions'],['app_server_deliveries','history'],['server_requests','pending'],['choice_queue','pending'],['task_queue','pending'],['inbound_events','delivery'],['backlog_batches','delivery']] as const) {
        if (cols(db,table).size) { const n = count(db,table); if (n) review.push({kind,provider:s.provider,reason:`${table}: retained in source copy; no safe importer`,count:n}); }
      }
    } finally { db.close(); }
  }
  const counts = new Map<string,number>(); for (const s of sessions) counts.set(s.sessionId,(counts.get(s.sessionId) ?? 0)+1);
  const valid = sessions.filter(s => { if (counts.get(s.sessionId)! > 1) { review.push({kind:'session',provider:s.native.provider,reason:'duplicate native identity',count:1}); return false; } return true; });
  const destinationCounts = new Map<string,number>(); for (const b of input.bindings) destinationCounts.set(b.destination,(destinationCounts.get(b.destination) ?? 0)+1);
  for (const b of input.bindings) {
    const matches = valid.filter(s => s.native.provider === b.provider && s.native.nativeSessionId === b.nativeSessionId);
    if (!nonempty(b.destination) || !nonempty(b.owner?.source) || !nonempty(b.owner?.subject) || matches.length !== 1 || destinationCounts.get(b.destination)! !== 1) { review.push({kind:'binding',provider:b.provider,reason:'missing owner, ambiguous session or duplicate destination',count:1}); continue; }
    const sid=matches[0]!.sessionId, proof=routeEvidence.get(sid);
    if (!proof || !nonempty(b.chatId) || !nonempty(b.rootId) || !nonempty(b.appId) || !nonempty(b.scopeEvidence) || b.owner.source!=='feishu' || proof.chatId!==b.chatId || proof.rootId!==b.rootId || (b.threadId && proof.threadId!==b.threadId)) { review.push({kind:'binding',provider:b.provider,reason:'missing or mismatched chat/root/app/owner scope evidence',count:1}); continue; }
    bindings.push({sessionId:sid,destination:b.destination,owner:b.owner,chatId:b.chatId,rootId:b.rootId,...(b.threadId ? {threadId:b.threadId}:{}),appId:b.appId,scopeEvidence:b.scopeEvidence});
  }
  for(const t of input.transcripts ?? []) {
    const matches=valid.filter(s=>s.native.provider===t.provider && s.native.nativeSessionId===t.nativeSessionId);
    if(matches.length!==1) {review.push({kind:'history',provider:t.provider,reason:'transcript identity ambiguous',count:1});continue;}
    const session=matches[0]!, ref=references.find(r=>r.sessionId===session.sessionId && r.table==='sessions' && r.fields.path===t.sourcePath);
    if(!ref) {review.push({kind:'history',provider:t.provider,reason:'transcript source path mismatch',count:1});continue;}
    try {const path=inRoot(input.copyRoot,t.copyPath); if(!/^[0-9a-f]{64}$/.test(t.sha256) || snapshotDigest(path)!==t.sha256) throw new Error('transcript hash mismatch'); references.push({sessionId:session.sessionId,provider:t.provider,snapshotId:ref.snapshotId,sourcePath:session.sourcePath,table:'transcript_copy',fields:{path,sha256:t.sha256}});}
    catch {review.push({kind:'history',provider:t.provider,reason:'transcript copy invalid or hash mismatch',count:1});}
  }
  return {version:1,snapshots,sessions:valid,bindings,references:references.filter(r=>valid.some(s=>s.sessionId===r.sessionId)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),review,notes:['Import records only; no core or channel state changed.','All legacy pending work is non-executable; resolve against native source before any action.','References, file versions and history require a reviewed importer.']};
}
/** Stages a manifest in a separate database. It never opens or overwrites core/channel data. */
export function applyManifest(manifest: MigrationManifest, ledgerPath: string, apply = false): { digest: string; state: 'dry-run' | 'staged' | 'already-staged' } {
  const digest = hash(manifest); if (!apply) return {digest,state:'dry-run'};
  // Exclusive creation avoids applying to existing core/channel or arbitrary pre-existing SQLite databases.
  if (existsSync(ledgerPath)) {
    const db = new DatabaseSync(ledgerPath,{readOnly:true}); try {
      const app = Number((db.prepare('PRAGMA application_id').get() as {application_id:number}).application_id);
      if (app !== 0x4d494752) throw new Error('not a migration ledger');
      const row = db.prepare('SELECT digest FROM migration_manifest WHERE digest=?').get(digest);
      if (row) return {digest,state:'already-staged'};
      throw new Error('ledger already contains a different manifest');
    } finally { db.close(); }
  }
  // Build and commit in a private file, then publish with an exclusive hard link.
  // An interruption before publication leaves no ambiguous empty target ledger.
  const temp = `${ledgerPath}.${randomUUID()}.tmp`; const fd = openSync(temp,'wx',0o600); closeSync(fd);
  try { const db = new DatabaseSync(temp); try {
    db.exec('BEGIN IMMEDIATE; PRAGMA application_id=1296648018; PRAGMA user_version=1; CREATE TABLE migration_manifest(digest TEXT PRIMARY KEY, manifest TEXT NOT NULL); CREATE TABLE migration_steps(id TEXT PRIMARY KEY, state TEXT NOT NULL);');
    db.prepare('INSERT INTO migration_manifest VALUES (?,?)').run(digest,JSON.stringify(manifest)); db.exec('COMMIT');
  } catch(e) { try { db.exec('ROLLBACK'); } catch {} throw e; } finally { db.close(); }
    linkSync(temp,ledgerPath);
  } finally { unlinkSync(temp); }

  return {digest,state:'staged'};
}


export interface MigrationCoreSink {
  importMigrationSession(id: string, session: Session): 'inserted'|'already-imported';
  rollbackMigrationSession(id: string): 'removed'|'retained'|'absent';
}
export interface MigrationRouteSink {
  importMigrationRoute(id:string, record:{destination:string;chatId:string;rootId:string;threadId?:string;sessionId:string;owner:string;appId:string}):'inserted'|'already-imported';
  rollbackMigrationRoute(id:string):'removed'|'retained'|'absent';
}
export interface MigrationChannelSink {
  importMigrationBinding(id: string, record: {destination:string;sessionId:string;bindingId:string;owner:Identity}): 'inserted'|'already-imported';
  rollbackMigrationBinding(id: string): 'removed'|'retained'|'absent';
}
function normalizedSession(s: ImportSession): Session {
  const names: CapabilityName[] = ['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'];
  const capabilities = Object.fromEntries(names.map(n => [n,n === 'view' ? {status:'available'} : {status:'temporarily_unavailable',reason:'migration requires native verification'}])) as Capabilities;
  return {...s,status:'read_only',revision:0,capabilities,control:{serviceId:s.native.serviceId,owner:null,input:'unavailable',generation:0,operationId:null,reason:'migration requires native verification'}};
}
/** Resumable per-sink saga. The sink receipt, not the advisory ledger, is authoritative. */
export function applyToSinks(manifest: MigrationManifest, ledgerPath: string, core: MigrationCoreSink, channel: MigrationChannelSink, route?: MigrationRouteSink): void {
  for (const snap of manifest.snapshots) { if(existsSync(`${snap.path}-wal`) || existsSync(`${snap.path}-journal`) || snapshotDigest(snap.path)!==snap.sha256) throw new Error('snapshot changed since planning'); const source=new DatabaseSync(snap.path,{readOnly:true}); try {if(schemaDigest(source)!==snap.schemaSha256) throw new Error('snapshot schema changed');} finally {source.close();} }
  const {digest} = applyManifest(manifest,ledgerPath,true); const db = new DatabaseSync(ledgerPath);
  try {
    const mark = (id:string) => db.prepare("INSERT INTO migration_steps VALUES(?,'applied') ON CONFLICT(id) DO UPDATE SET state='applied'").run(id);
    for (const s of manifest.sessions) { const id = `core:${digest}:${s.sessionId}`; core.importMigrationSession(id,normalizedSession(s)); mark(id); }
    for (const b of manifest.bindings) {
      if (!manifest.sessions.some(s=>s.sessionId===b.sessionId)) throw new Error('binding references unknown migration session');
      if (!route) throw new Error('migration route sink required');
      const routeId=`route:${digest}:${hash(b)}`; route.importMigrationRoute(routeId,{destination:b.destination,chatId:b.chatId,rootId:b.rootId,...(b.threadId ? {threadId:b.threadId}:{}),sessionId:b.sessionId,owner:b.owner.subject,appId:b.appId}); mark(routeId);
    }
    for (const b of manifest.bindings) {
      const id = `channel:${digest}:${hash(b)}`; channel.importMigrationBinding(id,{destination:b.destination,sessionId:b.sessionId,owner:b.owner,bindingId:`migration:${hash([digest,b])}`}); mark(id);
    }
  } finally { db.close(); }
}
/** Roll back only records whose own sink proves removal safe; preserve all other data. */
export function rollbackFromSinks(manifest: MigrationManifest, ledgerPath: string, core: MigrationCoreSink, channel: MigrationChannelSink, route?: MigrationRouteSink): {retained: string[]} {
  const {digest} = applyManifest(manifest,ledgerPath,true); const db = new DatabaseSync(ledgerPath); const retained:string[]=[];
  try {
    const mark=(id:string,state:string)=>db.prepare('INSERT INTO migration_steps VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(id,state);
    for (const b of [...manifest.bindings].reverse()) { const id=`channel:${digest}:${hash(b)}`; const state=channel.rollbackMigrationBinding(id); mark(id,state); if(state==='retained') retained.push(id); }
    for (const b of [...manifest.bindings].reverse()) { const id=`route:${digest}:${hash(b)}`; if(!route) throw new Error('migration route sink required'); const state=retained.length ? 'retained' : route.rollbackMigrationRoute(id); mark(id,state); if(state==='retained') retained.push(id); }
    // A retained binding may reference any imported session; retain all core records conservatively.
    for (const s of [...manifest.sessions].reverse()) { const id=`core:${digest}:${s.sessionId}`; const state=retained.length ? 'retained' : core.rollbackMigrationSession(id); mark(id,state); if(state==='retained') retained.push(id); }
    return {retained};
  } finally { db.close(); }
}
