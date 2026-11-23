import { DatabaseSync } from 'node:sqlite';
import { realpathSync, existsSync, statSync, readFileSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parseTranscriptChunk } from '../claude/transcript.js';
import { parseJsonlChunk } from '../session-parser.js';
import type { Message, Session } from './contracts.js';
import type { HistoryReader } from './history-port.js';
import { schemaDigest, snapshotDigest, type MigrationManifest } from './migration.js';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** All reads are restricted to an explicit, hash-verified copy and one native session. */
export class HistoryArchive implements HistoryReader {
  private readonly root:string;
  constructor(root:string, private readonly manifest:MigrationManifest) {
    this.root=realpathSync(root);
    if (!existsSync(`${this.root}/.migration-copy-root`) || manifest.version!==1) throw new Error('invalid archive root or manifest');
    for (const s of manifest.snapshots) this.verify(s.path,s.sha256,s.schemaSha256);
  }
  private verify(path:string,sha:string,schema:string):void {
    const p=realpathSync(path), rel=relative(this.root,p);
    if(!rel || rel==='..' || rel.startsWith('../') || isAbsolute(rel) || !statSync(p).isFile() || existsSync(`${p}-wal`) || existsSync(`${p}-journal`) || snapshotDigest(p)!==sha) throw new Error('archive source path or hash mismatch');
    const db=new DatabaseSync(p,{readOnly:true}); try {if(schemaDigest(db)!==schema) throw new Error('archive schema mismatch');} finally {db.close();}
  }
  private open(session:Session):{db:DatabaseSync; nativeId:string}|null {
    const matching=this.manifest.sessions.filter(s=>s.sessionId===session.sessionId && digest(s.native)===digest(session.native));
    if(!matching.length) return null; if(matching.length!==1) throw new Error('ambiguous archived session');
    const entry=matching[0]!, snap=this.manifest.snapshots.find(s=>s.path===entry.sourcePath && s.provider===session.native.provider);
    if(!snap || session.sessionId!==`migration:${digest(session.native)}`) throw new Error('archive identity mismatch');
    this.verify(snap.path,snap.sha256,snap.schemaSha256);
    const db=new DatabaseSync(snap.path,{readOnly:true});
    const rows=db.prepare('SELECT session_id,cwd FROM sessions WHERE session_id=?').all(session.native.nativeSessionId) as Array<{session_id:string;cwd:string}>;
    if(rows.length!==1 || rows[0]!.cwd!==session.project || entry.project!==session.project) {db.close();throw new Error('archive session mismatch');}
    return {db,nativeId:session.native.nativeSessionId};
  }
  /** Scoped association metadata. External files and messages remain independently verifiable references. */
  references(session:Session): Array<{table:string;fields:Record<string,string|number|null>}> {
    const opened=this.open(session); if(!opened) return []; const {db,nativeId}=opened;
    try {
      const out:Array<{table:string;fields:Record<string,string|number|null>}>=[];
      const specs:Array<[string,string[]]>=[['file_deliveries',['turn_id','path','version','content_hash','chat_id','root_message_id','status','file_message_id','request_uuid','source_refs_json']],['archive_parts',['start_offset','end_offset','sha256','feishu_message_id']],['messages',['message_id','feishu_message_id','direction']],['server_requests',['nonce','turn_id','item_id','status','card_message_id']],['turn_outputs',['turn_id','root_message_id','card_message_id','file_message_id']]];
      for(const [table,wanted] of specs) { const cols=new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{name:string}>).map(x=>x.name)); if(!cols.has('session_id')) continue; const selected=wanted.filter(x=>cols.has(x)); if(!selected.length) continue; const rows=db.prepare(`SELECT ${selected.map(x=>`"${x}"`).join(',')} FROM "${table}" WHERE session_id=?`).all(nativeId) as Array<Record<string,unknown>>;
        for(const row of rows) { const fields:Record<string,string|number|null>={}; for(const key of selected) { const v=row[key]; if(v===null || typeof v==='string' || typeof v==='number') fields[key]=v; else throw new Error('invalid archive reference'); } if(typeof fields.source_refs_json==='string') { let refs:unknown; try {refs=JSON.parse(fields.source_refs_json);} catch {throw new Error('invalid attachment references');} if(!Array.isArray(refs) || !refs.every(x=>x && typeof x==='object' && typeof x.label==='string' && typeof x.href==='string' && Object.keys(x).every(k=>k==='label'||k==='href'))) throw new Error('invalid attachment references'); fields.source_refs_json=JSON.stringify(refs); } out.push({table,fields}); }
      }
      return out;
    } finally {db.close();}
  }
  async read(session:Session):Promise<Message[]> {
    const opened=this.open(session); if(!opened) return []; const {db,nativeId}=opened; const items:Message[]=[];
    const columns=(t:string)=>new Set((db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{name:string}>).map(x=>x.name));
    const add=(id:string,turn:string,role:Message['role'],text:string)=>items.push({messageId:`legacy:${id}`,sessionId:session.sessionId,turnId:turn,role,blocks:[{type:'text',text}],sequence:items.length+1,revision:0,final:true,source:'legacy-snapshot'});
    try {
      const transcript=this.manifest.references.filter(r=>r.sessionId===session.sessionId && r.table==='transcript_copy');
      if(transcript.length>1) throw new Error('ambiguous transcript copy');
      if(transcript.length===1) {
        const ref=transcript[0]!, path=ref.fields.path, sha=ref.fields.sha256;
        if(typeof path!=='string' || typeof sha!=='string') throw new Error('invalid transcript reference');
        const canonical=realpathSync(path), rel=relative(this.root,canonical);
        if(!rel || rel==='..' || rel.startsWith('../') || isAbsolute(rel) || !statSync(canonical).isFile() || snapshotDigest(canonical)!==sha) throw new Error('transcript path or hash mismatch');
        const content=readFileSync(canonical,'utf8'); if(content && !content.endsWith('\n')) throw new Error('incomplete transcript');
        const records=content.split('\n').filter(Boolean).map(line=>{try {const value:unknown=JSON.parse(line); if(!value || typeof value!=='object') throw new Error(); return value as Record<string,unknown>;} catch {throw new Error('invalid transcript record');}});
        if(session.native.provider==='claude') {
          if(records.some(row=>row.sessionId!==nativeId)) throw new Error('transcript session identity mismatch');
          let turn=''; for(const event of parseTranscriptChunk(content)) { if(event.kind==='prompt') {turn=event.uuid;add(`transcript:${event.uuid}`,turn,'user',event.text);} else if(event.kind==='text') add(`transcript:${event.key}`,turn,'assistant',event.text); }
        } else {
          const metas=records.filter(r=>r.type==='session_meta');
          if(!metas.length || records[0]?.type!=='session_meta' || metas.some(m=>{const p=m.payload as {id?:unknown;session_id?:unknown}|undefined;return (p?.session_id ?? p?.id)!==nativeId;})) throw new Error('transcript session identity mismatch');
          const parsed=parseJsonlChunk(content,'','',nativeId); if(parsed.carry || parsed.metadata?.sessionId!==nativeId) throw new Error('invalid transcript');
          for(const m of parsed.messages) add(`transcript:${m.id}`,'',m.role==='user'?'user':m.role==='assistant'?'assistant':'tool',m.text);
          if(parsed.unknownTypes.length) add('transcript:unknown','','tool',`旧 transcript 含未知记录类型，原副本保留，需人工核查：${parsed.unknownTypes.join(', ')}`);
        }
      }
      const tc=columns('turns');
      if(!transcript.length && session.native.provider==='claude' && ['session_id','turn_id','seq','view_json'].every(x=>tc.has(x))) {
        const rows=db.prepare('SELECT turn_id,view_json FROM turns WHERE session_id=? ORDER BY seq,turn_id').all(nativeId) as Array<{turn_id:string;view_json:string}>;
        for(const row of rows) { let v:unknown; try {v=JSON.parse(row.view_json);} catch {throw new Error('invalid archived turn');} if(!v || typeof v!=='object') throw new Error('invalid archived turn'); const t=v as {turnId?:unknown;prompt?:unknown;blocks?:unknown}; if(t.turnId!==row.turn_id || typeof t.prompt!=='string' || !Array.isArray(t.blocks)) throw new Error('invalid archived turn'); if(t.prompt) add(`${row.turn_id}:prompt`,row.turn_id,'user',t.prompt); for(const [i,b] of t.blocks.entries()) {if(b && typeof b==='object' && (b as {kind?:unknown}).kind==='text' && typeof (b as {text?:unknown}).text==='string') add(`${row.turn_id}:reply:${i}`,row.turn_id,'assistant',(b as {text:string}).text);} }
      }
      const oc=columns('turn_outputs');
      if(!transcript.length && session.native.provider==='codex' && ['session_id','turn_id','content'].every(x=>oc.has(x))) for(const r of db.prepare('SELECT turn_id,content FROM turn_outputs WHERE session_id=? ORDER BY rowid').all(nativeId) as Array<{turn_id:string;content:string}>) if(typeof r.content==='string') add(`${r.turn_id}:output`,r.turn_id,'assistant',r.content);
      for(const [i,ref] of this.references(session).entries()) add(`reference:${i}`,String(ref.fields.turn_id ?? ''),'tool',`旧记录引用（外部内容可用性未验证） ${ref.table}: ${JSON.stringify(ref.fields)}`);
      return items;
    } finally {db.close();}
  }
}
