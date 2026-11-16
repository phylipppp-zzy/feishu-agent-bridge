import { createHash } from 'node:crypto';
import { localFileLinks } from '../claude/deliver.js';
import type { PlatformObservation, PlatformPort } from './adapter.js';
import type { Artifact, NativeSessionRef, Session } from './contracts.js';
import { contractError } from './errors.js';
import { LocalCatalog } from './local-catalog.js';
import { ArtifactRegistry } from './artifact-registry.js';

export const nativeRefKey = (r: NativeSessionRef): string => JSON.stringify([r.provider,r.hostId,r.serviceId,r.nativeSessionId]);
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
const unsupported = (e: unknown) => !!e && typeof e === 'object' && (e as {code?:string}).code === 'unsupported';
/** Wrap one provider. Caller configures registry roots by nativeRefKey and calls registry.load() before use. */
export class EnrichedPort implements PlatformPort {
  readonly provider: PlatformPort['provider'];
  readonly archive?: NonNullable<PlatformPort['archive']>;
  private readonly listeners = new Set<(o:PlatformObservation)=>void>();
  private readonly unsubscribe: () => void;
  private work: Promise<void> = Promise.resolve();
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
      if (o.type === 'message' && o.message.role === 'assistant') {
        this.work = this.work.then(()=>this.observeFiles(o)).catch(e=>{ this.onError(e); });
      }
    });
  }
  async drain(): Promise<void> { await this.work; }
  async close(): Promise<void> { this.unsubscribe(); await this.drain(); await this.base.close?.(); }
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
        const eventId = hash(JSON.stringify([nativeRefKey(o.ref),o.message.messageId,artifact.artifactId,artifact.contentVersion]));
        const time = await this.registry.eventTime(eventId, observedAt);
        const observation: PlatformObservation = {type:'event',ref:o.ref,event:{schemaVersion:1,eventId,sessionId:o.message.sessionId,objectId:artifact.artifactId,objectRevision:1,sequence:o.message.sequence,type:'artifact.available',occurredAt:time,receivedAt:time,operationId:null,cursor:eventId,data:{artifactId:artifact.artifactId,contentVersion:artifact.contentVersion,name:artifact.name,mediaType:artifact.mediaType,size:artifact.size}}};
        for (const f of this.listeners) f(observation);
      }
    }
  }

  private async allBase(): Promise<Session[]> {
    const result: Session[] = []; let cursor:string|null = null; const seen = new Set<string>();
    do { const page = await this.base.list(cursor,100); result.push(...page.items); cursor=page.nextCursor; if (cursor !== null) { if (seen.has(cursor) || seen.size >= 1000) throw contractError('snapshot_required'); seen.add(cursor); } } while(cursor !== null);
    return result;
  }
  async list(cursor:string|null, limit:number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw contractError('invalid_request');
    await this.catalog.refresh(); const base = await this.allBase(); const merged = new Map<string,Session>();
    let c: string | undefined; do { const p = this.catalog.list(100,c); for (const s of p.items) if (s.native.provider === this.provider) merged.set(nativeRefKey(s.native),s); c=p.nextCursor ?? undefined; } while(c);
    for (const s of base) { if (s.native.provider !== this.provider) throw contractError('invalid_request','base provider mismatch'); merged.set(nativeRefKey(s.native),s); }
    const items = [...merged.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,s])=>s), fingerprint = hash(JSON.stringify(items));
    let offset = 0; if (cursor) { let x:any; try { x=JSON.parse(Buffer.from(cursor,'base64url').toString()); } catch { throw contractError('invalid_request'); } if (x.fingerprint!==fingerprint || !Number.isSafeInteger(x.offset) || x.offset<0 || x.offset>items.length) throw contractError('snapshot_required'); offset=x.offset; }
    const end=Math.min(offset+limit,items.length); return {items:items.slice(offset,end),nextCursor:end<items.length?Buffer.from(JSON.stringify({fingerprint,offset:end})).toString('base64url'):null};
  }
  async read(ref:NativeSessionRef) {
    if (ref.provider !== this.provider) throw contractError('invalid_request');
    const base = await this.allBase(); if (base.some(s=>nativeRefKey(s.native)===nativeRefKey(ref))) return this.base.read(ref);
    await this.catalog.refresh(); try { return this.catalog.read(ref); } catch { throw contractError('invalid_request','session not found'); }
  }
  private async isExternal(ref:NativeSessionRef):Promise<boolean> { const base=await this.allBase(); if (base.some(s=>nativeRefKey(s.native)===nativeRefKey(ref))) return false; await this.catalog.refresh(); try { this.catalog.read(ref); return true; } catch { throw contractError('invalid_request','session not found'); } }
  private async writable(ref:NativeSessionRef):Promise<void> { if (await this.isExternal(ref)) throw contractError('unsupported','external session is read-only'); }
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
  async resume(ref:NativeSessionRef) { await this.writable(ref); return this.base.resume(ref); }
  create(...args:Parameters<PlatformPort['create']>) { return this.base.create(...args); }
  async input(...args:Parameters<PlatformPort['input']>) { await this.writable(args[0]); return this.base.input(...args); }
  async interrupt(...args:Parameters<PlatformPort['interrupt']>) { await this.writable(args[0]); return this.base.interrupt(...args); }
  async respond(...args:Parameters<PlatformPort['respond']>) { await this.writable(args[0]); return this.base.respond(...args); }
  async control(...args:Parameters<PlatformPort['control']>) { await this.writable(args[0]); return this.base.control(...args); }
  async updateSettings(...args:Parameters<PlatformPort['updateSettings']>) { await this.writable(args[0]); return this.base.updateSettings(...args); }
  async listModels(ref:NativeSessionRef) { if (await this.isExternal(ref)) throw contractError('unsupported'); return this.base.listModels(ref); }

}
