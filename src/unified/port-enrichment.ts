import { listSafeProjectDirectory, selectSafeProjectFiles } from './project-files.js';
import { createHash, randomBytes } from 'node:crypto';
import { localFileLinks } from '../claude/deliver.js';
import type { PlatformObservation, PlatformPort } from './adapter.js';
import type { Artifact, NativeSessionRef, Session } from './contracts.js';
import { contractError } from './errors.js';
import { LocalCatalog } from './local-catalog.js';
import { ArtifactRegistry } from './artifact-registry.js';

export const nativeRefKey = (r: NativeSessionRef): string => JSON.stringify([r.provider,r.hostId,r.serviceId,r.nativeSessionId]);
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
const unsupported = (e: unknown) => !!e && typeof e === 'object' && (e as {code?:string}).code === 'unsupported';
const LIST_TTL_MS = 120_000, LIST_MAX_SNAPSHOTS = 8, LIST_MAX_ITEMS = 10_000, LIST_MAX_BYTES = 32 * 1024 * 1024;
type ListSnapshot = {items:Session[]; limit:number; expires:number; tokens:Map<number,string>};
/** Wrap one provider. Caller configures registry roots by nativeRefKey and calls registry.load() before use. */
export class EnrichedPort implements PlatformPort {
  readonly provider: PlatformPort['provider'];
  readonly archive?: NonNullable<PlatformPort['archive']>;
  private readonly listeners = new Set<(o:PlatformObservation)=>void>();
  private readonly unsubscribe: () => void;
  private work: Promise<void> = Promise.resolve();
  private readonly listSnapshots = new Set<ListSnapshot>();
  private readonly listCursors = new Map<string,{snapshot:ListSnapshot;offset:number}>();
  private closed = false;
  constructor(private readonly base: PlatformPort, private readonly catalog: LocalCatalog, private readonly registry: ArtifactRegistry, private readonly onError: (error:unknown)=>void) {
    this.provider = base.provider;
    if (typeof base.archive === 'function') this.archive = async (...args) => {
      await this.writable(args[0]);
      const archive=this.base.archive;
      if (typeof archive !== 'function') throw contractError('unsupported');
      return archive.apply(this.base,args);
    };
    this.unsubscribe = base.onObservation(o => {
      for (const f of this.listeners) f(o);
      if (o.type === 'message' && o.message.role === 'assistant' && o.message.final) {
        this.work = this.work.then(()=>this.observeFiles(o)).catch(e=>{ this.onError(e); });
      }
    });
  }
  candidateGeneration(){return this.base.candidateGeneration?.()??null;}
  async listCandidateIds(cursor:string|null,limit:number){if(!this.base.listCandidateIds)throw contractError('unsupported');return this.base.listCandidateIds(cursor,limit);}
  async readCandidateMetadata(id:string){if(!this.base.readCandidateMetadata)throw contractError('unsupported');return this.base.readCandidateMetadata(id);}
  async drain(): Promise<void> { await this.work; }
  async close(): Promise<void> { this.closed = true; this.listSnapshots.clear(); this.listCursors.clear(); this.unsubscribe(); await this.drain(); await this.base.close?.(); }
  onObservation(f:(o:PlatformObservation)=>void):()=>void { this.listeners.add(f); return ()=>this.listeners.delete(f); }
  private async observeFiles(o: Extract<PlatformObservation,{type:'message'}>): Promise<void> {
    const observedAt = new Date().toISOString();
    const roots = this.registry.getRoots(o.ref); if (!roots.length) return;
    const project = (await this.read(o.ref)).session.project || null;
    for (const block of o.message.blocks) if (block.type === 'text') {
      // localFileLinks applies credential exclusions as well as root and file checks.
      const normalized = block.text.replace(/\]\(localfile:\/\/\//g, '](file:///');
      const paths = new Set<string>();
      for (const root of roots) for (const link of await localFileLinks(normalized, project, root)) paths.add(link.path);
      for (const path of paths) {
        let artifact: Artifact; try { artifact = await this.registry.register(nativeRefKey(o.ref),path); } catch (e) { this.onError(e); continue; }
        const eventId = hash(JSON.stringify([nativeRefKey(o.ref),o.message.turnId,o.message.messageId,artifact.artifactId,artifact.contentVersion]));
        const time = await this.registry.eventTime(eventId, observedAt);
        const observation: PlatformObservation = {type:'event',ref:o.ref,event:{schemaVersion:1,eventId,sessionId:o.message.sessionId,objectId:artifact.artifactId,objectRevision:1,sequence:o.message.sequence,type:'artifact.available',occurredAt:time,receivedAt:time,operationId:null,cursor:eventId,data:{turnId:o.message.turnId,messageId:o.message.messageId,artifactId:artifact.artifactId,contentVersion:artifact.contentVersion,name:artifact.name,mediaType:artifact.mediaType,size:artifact.size}}};
        for (const f of this.listeners) f(observation);
      }
    }
  }

  private async allBase(maxItems?:number): Promise<Session[]> {
    const result: Session[] = []; let cursor:string|null = null; const seen = new Set<string>();
    do { const page = await this.base.list(cursor,100); result.push(...page.items); if(maxItems!==undefined && result.length>maxItems) throw contractError('snapshot_required','session listing exceeds snapshot limit'); cursor=page.nextCursor; if (cursor !== null) { if (seen.has(cursor) || seen.size >= 1000) throw contractError('snapshot_required'); seen.add(cursor); } } while(cursor !== null);
    return result;
  }
  private dropListSnapshot(snapshot:ListSnapshot):void { this.listSnapshots.delete(snapshot); for(const token of snapshot.tokens.values()) this.listCursors.delete(token); }
  private pruneListSnapshots(now:number):void { for(const snapshot of this.listSnapshots) if(snapshot.expires<=now) this.dropListSnapshot(snapshot); }
  private listPage(snapshot:ListSnapshot,offset:number) {
    const end=Math.min(offset+snapshot.limit,snapshot.items.length); let nextCursor:string|null=null;
    if(end<snapshot.items.length) { nextCursor=snapshot.tokens.get(end) ?? randomBytes(24).toString('base64url'); snapshot.tokens.set(end,nextCursor); this.listCursors.set(nextCursor,{snapshot,offset:end}); }
    return {items:structuredClone(snapshot.items.slice(offset,end)),nextCursor};
  }
  async list(cursor:string|null, limit:number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw contractError('invalid_request');
    if(this.closed) throw contractError('temporarily_unavailable');
    this.pruneListSnapshots(Date.now());
    if(cursor!==null) { const entry=this.listCursors.get(cursor); if(!entry || entry.snapshot.limit!==limit) throw contractError('snapshot_required'); return this.listPage(entry.snapshot,entry.offset); }
    await this.catalog.refresh(); const base = await this.allBase(LIST_MAX_ITEMS); const merged = new Map<string,Session>();
    let c: string | undefined; do { const p = this.catalog.list(100,c); for (const s of p.items) if (s.native.provider === this.provider) merged.set(nativeRefKey(s.native),s); c=p.nextCursor ?? undefined; } while(c);
    for (const s of base) { if (s.native.provider !== this.provider) throw contractError('invalid_request','base provider mismatch'); merged.set(nativeRefKey(s.native),s); }
    const items = [...merged.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,s])=>s);
    if(this.closed) throw contractError('temporarily_unavailable');
    if(items.length>LIST_MAX_ITEMS || Buffer.byteLength(JSON.stringify(items))>LIST_MAX_BYTES) throw contractError('snapshot_required','session listing exceeds snapshot limit');
    const snapshot:ListSnapshot={items:structuredClone(items),limit,expires:Date.now()+LIST_TTL_MS,tokens:new Map()};
    if(items.length>limit) { this.pruneListSnapshots(Date.now()); while(this.listSnapshots.size>=LIST_MAX_SNAPSHOTS) this.dropListSnapshot(this.listSnapshots.values().next().value!); this.listSnapshots.add(snapshot); }
    return this.listPage(snapshot,0);
  }
  async discoverNewer(watermark:number,cursor:string|null,limit:number) {if(!this.base.discoverNewer) throw contractError('unsupported');return this.base.discoverNewer(watermark,cursor,limit);}
  async discoverRunning(cursor:string|null, limit:number) {
    if (!this.base.discoverRunning) throw contractError('unsupported');
    return this.base.discoverRunning(cursor,limit);
  }
  async read(ref:NativeSessionRef) {
    if (ref.provider !== this.provider) throw contractError('invalid_request');
    if (await this.isProviderSession(ref)) return this.base.read(ref);
    await this.catalog.refresh(); try { return this.catalog.read(ref); } catch { throw contractError('invalid_request','session not found'); }
  }
  private async isProviderSession(ref: NativeSessionRef): Promise<boolean> {
    if (this.base.hasActiveNativeSession?.(ref)) return true;
    const key = nativeRefKey(ref);
    return (await this.allBase()).some(session => nativeRefKey(session.native) === key);
  }
  private async isExternal(ref:NativeSessionRef):Promise<boolean> { if (await this.isProviderSession(ref)) return false; await this.catalog.refresh(); try { this.catalog.read(ref); return true; } catch { throw contractError('invalid_request','session not found'); } }
  private async writable(ref:NativeSessionRef):Promise<void> { if (await this.isExternal(ref)) throw contractError('unsupported','external session is read-only'); }
  async listProjectFiles(ref:NativeSessionRef,directory:string,showHidden:boolean) { await this.read(ref); const root=this.registry.getProjectRoot(ref); if(!root) throw contractError('unsupported'); return listSafeProjectDirectory(directory,root,showHidden,[root,...this.registry.getRoots(ref)]); }
  async selectProjectFiles(ref:NativeSessionRef,args:string):Promise<Artifact[]> { await this.read(ref); const root=this.registry.getProjectRoot(ref); if(!root) throw contractError('unsupported'); const selection=await selectSafeProjectFiles(root,args,[root,...this.registry.getRoots(ref)]); const result:Artifact[]=[]; for(const file of selection) {const artifact=await this.registry.register(nativeRefKey(ref),file.path,'application/octet-stream',true); if(artifact.contentVersion!==file.digest) throw contractError('invalid_request','selected file changed'); result.push(artifact);} return result; }

  findRegisteredReplyFiles(ref: NativeSessionRef, blocks: readonly import('./contracts.js').ContentBlock[]): Artifact[] {
    return this.registry.findRegisteredReplyFiles(ref, blocks);
  }
  async listArtifacts(ref:NativeSessionRef):Promise<Artifact[]> {
    const local = this.registry.list(nativeRefKey(ref),1000); let cursor=local.nextCursor; const result=[...local.items]; while(cursor) { const p=this.registry.list(nativeRefKey(ref),1000,cursor); result.push(...p.items); cursor=p.nextCursor; }
    if (await this.isExternal(ref)) return result;
    try { return [...await this.base.listArtifacts(ref),...result]; } catch(e) { if (unsupported(e)) return result; throw e; }
  }
  async readArtifact(ref:NativeSessionRef,id:string,version:string):Promise<Uint8Array> {
    // Presence in the local registry must never fall through to the base on a stale or cross-session request.
    const own = this.registry.list(nativeRefKey(ref),1000); let cursor=own.nextCursor; const all=[...own.items]; while(cursor) {const p=this.registry.list(nativeRefKey(ref),1000,cursor);all.push(...p.items);cursor=p.nextCursor;}
    if (this.registry.has(id)) return this.registry.read(nativeRefKey(ref),id,version);
    if (await this.isExternal(ref)) throw contractError('invalid_request'); return this.base.readArtifact(ref,id,version);
  }
  seedConnectionGeneration(minimum:number) { this.base.seedConnectionGeneration?.(minimum); }
  seedControlGeneration(ref:NativeSessionRef, minimum:number) { this.base.seedControlGeneration?.(ref,minimum); }
  requiresControlRecovery(ref:NativeSessionRef): boolean { return this.base.requiresControlRecovery?.(ref) === true; }
  async resume(ref:NativeSessionRef) { await this.writable(ref); return this.base.resume(ref); }
  create(...args:Parameters<PlatformPort['create']>) { return this.base.create(...args); }
  async input(...args:Parameters<PlatformPort['input']>) { await this.writable(args[0]); return this.base.input(...args); }
  async inspectTurnResidual(ref:NativeSessionRef,turnId:string) {if(!this.base.inspectTurnResidual) return {status:'unknown' as const,count:null,observedAt:null,complete:false,reason:'此provider未提供可信残留查询'};return this.base.inspectTurnResidual(ref,turnId);}
  async interrupt(...args:Parameters<PlatformPort['interrupt']>) { await this.writable(args[0]); return this.base.interrupt(...args); }
  async respond(...args:Parameters<PlatformPort['respond']>) { await this.writable(args[0]); return this.base.respond(...args); }
  async control(...args:Parameters<PlatformPort['control']>) { await this.writable(args[0]); return this.base.control(...args); }
  async updateSettings(...args:Parameters<PlatformPort['updateSettings']>) { await this.writable(args[0]); return this.base.updateSettings(...args); }
  async getContextUsage(ref: NativeSessionRef) {
    if (ref.provider !== this.provider) throw contractError('invalid_request');
    return this.base.getContextUsage ? await this.base.getContextUsage(ref) : null;
  }
  async listModels(ref:NativeSessionRef) { if (await this.isExternal(ref)) throw contractError('unsupported'); return this.base.listModels(ref); }

}
