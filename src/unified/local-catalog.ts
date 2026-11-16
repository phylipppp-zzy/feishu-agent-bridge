import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { readdir, readFile, lstat, open, realpath } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseJsonlChunk } from '../session-parser.js';
import { parseTranscriptChunk } from '../claude/transcript.js';
import type { Capabilities, Message, NativeSessionRef, Page, Provider, SessionSnapshot } from './contracts.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const refKey = (r: NativeSessionRef) => JSON.stringify([r.provider, r.hostId, r.serviceId, r.nativeSessionId]);
const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
function decode(cursor: string): any { try { return JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new Error('invalid cursor'); } }
const capability = (): Capabilities => Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k => [k, k === 'view' ? {status:'available'} : {status:'unsupported',reason:'external session is read-only'}])) as Capabilities;
export interface CatalogRoot { provider: Provider; directory: string; hostId: string; serviceId: string }
interface Entry { ref: NativeSessionRef; path: string; snapshot: SessionSnapshot }
/** Inject only explicitly authorized log directories. No native process is started or controlled. */
export class LocalCatalog {
  private entries = new Map<string, Entry>();
  constructor(private readonly roots: readonly CatalogRoot[], private readonly maxLogBytes = 32 * 1024 * 1024) {}
  /** Bounded source proof: no transcript content leaves this method. */
  async isClaudeCliMain(ref:NativeSessionRef,project:string):Promise<boolean> {
    if(ref.provider!=='claude' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.nativeSessionId)) return false;
    let count=0,valid=false,entries=0;const wanted=await realpath(project);
    const walk=async(dir:string,depth=0):Promise<void>=>{if(depth>32)throw new Error('source proof directory depth exceeded');for(const ent of await readdir(dir,{withFileTypes:true})) {if(++entries>100000)throw new Error('source proof scan budget exceeded');const path=join(dir,ent.name);if(ent.isDirectory()){if(ent.name!=='subagents')await walk(path,depth+1);continue;}if(!ent.isFile() || ent.name!==`${ref.nativeSessionId}.jsonl`)continue;count++;if(count>1)continue;const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const buf=Buffer.alloc(65536),r=await f.read(buf,0,buf.length,0);const lines=buf.subarray(0,r.bytesRead).toString('utf8').split('\n');for(const line of lines.slice(0,-1)){let x:any;try{x=JSON.parse(line);}catch{continue;}if(x?.type!=='user'&&x?.type!=='assistant')continue;valid=x.sessionId===ref.nativeSessionId&&['cli','claude-vscode','sdk-cli'].includes(x.entrypoint)&&x.isSidechain===false&&!x.agentId&&x.sessionKind!=='daemon'&&x.sessionKind!=='daemon-worker'&&typeof x.cwd==='string'&&await realpath(x.cwd)===wanted;break;}}finally{await f.close();}}};
    for(const root of this.roots) if(root.provider==='claude'&&root.hostId===ref.hostId&&root.serviceId===ref.serviceId) await walk(root.directory);
    return count===1&&valid;
  }
  async refresh(): Promise<void> {
    const next = new Map<string, Entry>();
    const walk = async (root: CatalogRoot, dir: string): Promise<void> => {
      for (const ent of (await readdir(dir, {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
        const path = join(dir, ent.name);
        if (ent.isDirectory()) { await walk(root,path); continue; }
        if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
        const st = await lstat(path); if (!st.isFile() || st.size > this.maxLogBytes) continue;
        const text = await readFile(path, 'utf8');
        let nativeId = ''; let project = ''; let title = ''; const items: Array<{id:string;role:'user'|'assistant';text:string}> = [];
        if (root.provider === 'codex') {
          const parsed = parseJsonlChunk(text);
          nativeId = parsed.metadata?.sessionId ?? ''; project = parsed.metadata?.cwd ?? '';
          for (const m of parsed.messages) if (m.role === 'user' || m.role === 'assistant') items.push({id:m.id,role:m.role,text:m.text});
        } else {
          // Claude's main transcript is named with its native session ID; subagent directories are excluded.
          if (dir.split('/').includes('subagents')) continue;
          nativeId = basename(path, '.jsonl');
          for (const e of parseTranscriptChunk(text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1))) {
            if (e.kind === 'meta') { project = e.meta.cwd ?? project; title = e.meta.customTitle ?? e.meta.aiTitle ?? title; }
            if (e.kind === 'prompt') items.push({id:e.uuid,role:'user',text:e.text});
            if (e.kind === 'text') items.push({id:e.key,role:'assistant',text:e.text});
          }
        }
        if (!nativeId || nativeId === 'null') continue;
        const ref: NativeSessionRef = {provider:root.provider,hostId:root.hostId,serviceId:root.serviceId,nativeSessionId:nativeId};
        const key = refKey(ref), sessionId = hash(key);
        const messages: Message[] = []; const seen = new Set<string>();
        for (const m of items) { if (seen.has(m.id)) continue; seen.add(m.id); messages.push({messageId:hash(`${key}:${m.id}`),sessionId,turnId:'',role:m.role,blocks:[{type:'text',text:m.text}],sequence:messages.length + 1,revision:1,final:true,source:'local-log'}); }
        const snapshot: SessionSnapshot = {session:{sessionId,native:ref,project,title:title || items.find(x => x.role === 'user')?.text.slice(0,120) || nativeId,status:'read_only',revision:1,capabilities:capability(),control:{serviceId:root.serviceId,owner:null,input:'unavailable',generation:0,operationId:null,reason:'external session is read-only'}},messages,interactions:[]};
        // Duplicate native IDs must never be silently merged across different files.
        if (next.has(key)) throw new Error(`duplicate native session ref: ${key}`);
        next.set(key,{ref,path,snapshot});
      }
    };
    for (const root of this.roots) await walk(root,root.directory);
    this.entries = next;
  }
  list(limit: number, cursor?: string, search = ''): Page<SessionSnapshot['session']> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid limit');
    const entries = [...this.entries.entries()].filter(([,e]) => `${e.snapshot.session.title}\n${e.snapshot.session.project}`.toLowerCase().includes(search.toLowerCase())).sort(([a],[b]) => a.localeCompare(b));
    const fingerprint = hash(JSON.stringify([search,entries.map(([k])=>k)]));
    const c = cursor ? decode(cursor) : {fingerprint,offset:0};
    if (c.fingerprint !== fingerprint || !Number.isSafeInteger(c.offset) || c.offset < 0 || c.offset > entries.length) throw new Error('stale or invalid cursor');
    const end = Math.min(c.offset + limit,entries.length);
    return {items:entries.slice(c.offset,end).map(([,e])=>structuredClone(e.snapshot.session)),nextCursor:end < entries.length ? encode({fingerprint,offset:end}) : null};
  }
  read(ref: NativeSessionRef): SessionSnapshot { const e = this.entries.get(refKey(ref)); if (!e) throw new Error('session not found'); return structuredClone(e.snapshot); }
  history(ref: NativeSessionRef, limit: number, cursor?: string): Page<Message> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid limit');
    const messages = this.read(ref).messages, c = cursor ? decode(cursor) : {ref:refKey(ref),offset:0,prefix:hash('[]')};
    if (c.ref !== refKey(ref) || !Number.isSafeInteger(c.offset) || c.offset < 0 || c.offset > messages.length || c.prefix !== hash(JSON.stringify(messages.slice(0,c.offset)))) throw new Error('stale or invalid cursor');
    const end = Math.min(c.offset + limit,messages.length);
    // A cursor is returned even at the end, allowing append-only incremental reads after refresh/restart.
    return {items:messages.slice(c.offset,end),nextCursor:encode({ref:refKey(ref),offset:end,prefix:hash(JSON.stringify(messages.slice(0,end)))})};
  }
}
