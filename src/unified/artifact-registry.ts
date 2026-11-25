import { matchRegisteredReplyFiles } from './reply-artifacts.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Artifact, NativeSessionRef, Page } from './contracts.js';

const digest = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
export interface RegisteredArtifact extends Artifact {
  contentChanged?: boolean;
  previousContentVersion?: string;
}
export interface ArtifactContentChangeStatus {
  changed: boolean;
  currentVersion: string | null;
  previousVersion: string | null;
  notice: string | null;
}
interface Entry { artifact: Artifact; path: string; root: string; previousContentVersion?: string; contentChanged?: boolean }
/** Roots are set by trusted session/project configuration, never by channel requests. */
export class ArtifactRegistry {
  private readonly entries = new Map<string, Entry>();
  private tail: Promise<void> = Promise.resolve();
  private readonly roots: Record<string, readonly string[]>;
  private readonly projectRoots: Record<string, string> = {};
  private readonly eventTimes = new Map<string,string>();
  constructor(roots: Readonly<Record<string, readonly string[]>>, private readonly maxBytes = 20 * 1024 * 1024, private readonly statePath?: string) { this.roots = {...roots}; }
  /** Trusted process configuration only; never pass roots supplied by messages or channel requests. */
  setRoots(ref: NativeSessionRef, roots: readonly string[]): void {
    if (!roots.every(r => typeof r === 'string' && isAbsolute(r))) throw new Error('absolute roots required');
    this.roots[JSON.stringify([ref.provider,ref.hostId,ref.serviceId,ref.nativeSessionId])] = roots.map(r=>resolve(r));
  }
  getRoots(ref: NativeSessionRef): readonly string[] { return [...(this.roots[JSON.stringify([ref.provider,ref.hostId,ref.serviceId,ref.nativeSessionId])] ?? [])]; }
  setProjectRoot(ref:NativeSessionRef, root:string):void { if(!isAbsolute(root)) throw new Error('absolute project root required'); this.projectRoots[JSON.stringify([ref.provider,ref.hostId,ref.serviceId,ref.nativeSessionId])]=resolve(root); }
  getProjectRoot(ref:NativeSessionRef):string | undefined { return this.projectRoots[JSON.stringify([ref.provider,ref.hostId,ref.serviceId,ref.nativeSessionId])]; }
  private relativePathFor(sessionId: string, fullPath: string, entryRoot: string): string {
    const toPosix = (p: string) => p.split(sep).join('/');
    const projectRoot = this.projectRoots[sessionId];
    if (projectRoot) {
      const rel = relative(resolve(projectRoot), resolve(fullPath));
      if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        return toPosix(rel);
      }
    }
    const rootResolved = resolve(entryRoot);
    const rootRel = relative(rootResolved, resolve(fullPath));
    if (rootRel && rootRel !== '..' && !rootRel.startsWith(`..${sep}`) && !isAbsolute(rootRel)) {
      const rootName = basename(rootResolved);
      const relPosix = toPosix(rootRel);
      return rootName ? `${rootName}/${relPosix}` : relPosix;
    }
    return basename(fullPath);
  }
  private authorized(e: Entry): boolean { return [...(this.roots[e.artifact.sessionId] ?? []),...(this.projectRoots[e.artifact.sessionId] ? [this.projectRoots[e.artifact.sessionId]!] : [])].some(r=>resolve(r)===e.root); }
  async eventTime(eventId: string, observedAt: string): Promise<string> {
    const task = this.tail.catch(()=>undefined).then(async () => {
      const old = this.eventTimes.get(eventId); if (old) return old;
      this.eventTimes.set(eventId, observedAt); try { await this.persist(); } catch(e) { this.eventTimes.delete(eventId); throw e; } return observedAt;
    });
    this.tail = task.then(()=>undefined); return task;
  }
  /** Load only trusted, locally protected state; roots are always re-authorized from current configuration. */
  async load(): Promise<void> {
    if (!this.statePath) return;
    let raw: string; try { raw = await readFile(this.statePath, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    const state: unknown = JSON.parse(raw);
    if (!state || typeof state !== 'object' || (state as any).schemaVersion !== 1 || !Array.isArray((state as any).entries)) throw new Error('invalid artifact registry schema');
    const loaded = new Map<string, Entry>();
    for (const x of (state as any).entries) {
      const a = x?.artifact;
      if (!a || typeof a.sessionId !== 'string' || typeof x.path !== 'string' || !isAbsolute(x.path) || typeof x.root !== 'string'  || a.artifactId !== digest(JSON.stringify([a.sessionId,x.path])) || typeof a.name !== 'string' || a.name !== basename(x.path) || (a.relativePath !== undefined && typeof a.relativePath !== 'string') || typeof a.mediaType !== 'string' || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > this.maxBytes || !/^[a-f0-9]{64}$/.test(a.contentVersion)) throw new Error('invalid artifact registry entry');
      if (loaded.has(a.artifactId)) throw new Error('duplicate artifact registry entry');
      const prevVer = typeof x.previousContentVersion === 'string' && /^[a-f0-9]{64}$/.test(x.previousContentVersion) ? x.previousContentVersion : undefined;
      const changed = x.contentChanged === true;
      loaded.set(a.artifactId,{artifact:a,path:x.path,root:x.root,...(prevVer ? {previousContentVersion:prevVer} : {}),...(changed ? {contentChanged:true} : {})});
    }
    const times = (state as any).eventTimes ?? {}; if (!times || typeof times !== 'object' || Array.isArray(times) || Object.entries(times).some(([k,v])=>!/^[a-f0-9]{64}$/.test(k) || typeof v !== 'string' || !Number.isFinite(Date.parse(v)))) throw new Error('invalid event times');
    this.entries.clear(); for (const [k,v] of loaded) this.entries.set(k,v); this.eventTimes.clear(); for (const [k,v] of Object.entries(times)) this.eventTimes.set(k,v as string);
  }
  private async persist(): Promise<void> {
    if (!this.statePath) return;
    const path = this.statePath, tmp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(tmp,JSON.stringify({schemaVersion:1,entries:[...this.entries.values()],eventTimes:Object.fromEntries(this.eventTimes)}),{mode:0o600,flag:'wx'}); await rename(tmp,path); }
    finally { await unlink(tmp).catch(()=>undefined); }
  }
  private async readSafe(path: string, root: string): Promise<Uint8Array> {
    const canonicalRoot = await realpath(root), canonicalPath = await realpath(path), rel = relative(canonicalRoot,canonicalPath);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('artifact outside allowed root');
    const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat(); if (!st.isFile() || st.size > this.maxBytes) throw new Error('invalid artifact size or type');
      // Verify the opened inode still resolves within the authorized root after opening.
      const fdPath = await realpath(`/proc/self/fd/${handle.fd}`), fdRel = relative(canonicalRoot,fdPath);
      if (!fdRel || fdRel === '..' || fdRel.startsWith(`..${sep}`) || isAbsolute(fdRel) || fdPath !== canonicalPath) throw new Error('artifact path changed');
      const buffer = Buffer.alloc(this.maxBytes + 1); let count = 0; while (count < buffer.length) { const {bytesRead} = await handle.read(buffer,count,buffer.length-count,count); if (!bytesRead) break; count += bytesRead; } if (count > this.maxBytes) throw new Error('artifact too large'); return buffer.subarray(0,count);
    } finally { await handle.close(); }
  }
  /** Called only for a path observed as an output or an explicitly trusted safe file reference. */
  async register(sessionId: string, observedPath: string, mediaType = 'application/octet-stream', explicit = false): Promise<RegisteredArtifact> {
    if (!isAbsolute(observedPath)) throw new Error('absolute observed path required');
    const roots = explicit && this.projectRoots[sessionId] ? [...(this.roots[sessionId] ?? []),this.projectRoots[sessionId]!] : (this.roots[sessionId] ?? []); let data: Uint8Array | undefined; let root = '';
    for (const candidate of roots) { try { data = await this.readSafe(observedPath,candidate); root = resolve(candidate); break; } catch { /* try another authorized root */ } }
    if (!data) throw new Error('artifact unavailable or outside allowed roots');
    const path = resolve(observedPath), artifactId = digest(JSON.stringify([sessionId,path]));
    const artifact: Artifact = {artifactId,sessionId,name:basename(path),mediaType,size:data.length,contentVersion:digest(data),relativePath:this.relativePathFor(sessionId,path,root)};
    let contentChanged = false;
    let previousContentVersion: string | undefined;
    const commit = this.tail.catch(()=>undefined).then(async () => {
      const previous = this.entries.get(artifactId);
      if (previous && previous.artifact.contentVersion !== artifact.contentVersion) {
        contentChanged = true;
        previousContentVersion = previous.artifact.contentVersion;
      } else if (previous?.contentChanged) {
        contentChanged = true;
        previousContentVersion = previous.previousContentVersion;
      }
      this.entries.set(artifactId,{
        artifact,
        path,
        root,
        ...(contentChanged ? { contentChanged: true } : {}),
        ...(previousContentVersion ? { previousContentVersion } : {}),
      });
      try { await this.persist(); } catch (e) { if (previous) this.entries.set(artifactId,previous); else this.entries.delete(artifactId); throw e; }
    });
    this.tail = commit; await commit;
    return {
      ...artifact,
      ...(contentChanged ? { contentChanged: true } : {}),
      ...(previousContentVersion ? { previousContentVersion } : {}),
    };
  }
  getContentChangeStatus(sessionId: string, artifactId: string, expectedVersion?: string): ArtifactContentChangeStatus {
    const e = this.entries.get(artifactId);
    if (!e || !this.authorized(e) || e.artifact.sessionId !== sessionId) {
      return { changed: false, currentVersion: null, previousVersion: null, notice: null };
    }
    if (expectedVersion && e.artifact.contentVersion !== expectedVersion) {
      return {
        changed: true,
        currentVersion: e.artifact.contentVersion,
        previousVersion: expectedVersion,
        notice: '内容已变更：同路径文件已被新版本覆盖，旧版本字节不可再取回。',
      };
    }
    if (e.contentChanged) {
      return {
        changed: true,
        currentVersion: e.artifact.contentVersion,
        previousVersion: e.previousContentVersion ?? null,
        notice: '内容已变更：同路径文件已被新版本覆盖。',
      };
    }
    return { changed: false, currentVersion: e.artifact.contentVersion, previousVersion: null, notice: null };
  }
  has(artifactId: string): boolean { return this.entries.has(artifactId); }
  findRegisteredReplyFiles(ref: NativeSessionRef, blocks: readonly import('./contracts.js').ContentBlock[]): Artifact[] {
    const project = this.getProjectRoot(ref);
    if (!project) return [];
    const sessionId = JSON.stringify([ref.provider, ref.hostId, ref.serviceId, ref.nativeSessionId]);
    const files: Artifact[] = [];
    for (const entry of this.entries.values()) {
      if (entry.artifact.sessionId !== sessionId || !this.authorized(entry)) continue;
      const path = relative(project, entry.path);
      if (path && !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)) {
        files.push({ ...entry.artifact, relativePath: path });
      }
    }
    return matchRegisteredReplyFiles(project, blocks, files);
  }
  list(sessionId: string, limit: number, cursor?: string): Page<Artifact> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid limit');
    const items = [...this.entries.values()]
      .filter(e => e.artifact.sessionId === sessionId && this.authorized(e))
      .map(e => ({...e.artifact, relativePath: this.relativePathFor(e.artifact.sessionId, e.path, e.root)}))
      .sort((a,b)=>a.artifactId.localeCompare(b.artifactId));
    const fingerprint = digest(JSON.stringify(items)); let offset = 0;
    if (cursor) { let c: any; try { c = JSON.parse(Buffer.from(cursor,'base64url').toString()); } catch { throw new Error('invalid cursor'); } if (c.sessionId !== sessionId || c.fingerprint !== fingerprint || !Number.isSafeInteger(c.offset) || c.offset < 0 || c.offset > items.length) throw new Error('stale or invalid cursor'); offset = c.offset; }
    const end = Math.min(offset+limit,items.length); return {items:items.slice(offset,end).map(x=>({...x})),nextCursor:end < items.length ? Buffer.from(JSON.stringify({sessionId,fingerprint,offset:end})).toString('base64url') : null};
  }
  async read(sessionId: string, artifactId: string, version: string): Promise<Uint8Array> {
    const e = this.entries.get(artifactId);
    if (!e || !this.authorized(e) || e.artifact.sessionId !== sessionId) {
      throw new Error('artifact not found or stale version');
    }
    if (e.artifact.contentVersion !== version) {
      throw new Error('内容已变更：同路径文件已被新版本覆盖，请重新获取最新文件列表（artifact content changed）');
    }
    const bytes = await this.readSafe(e.path,e.root);
    if (digest(bytes) !== version) {
      throw new Error('内容已变更：文件自登记后已被修改，请重新获取最新文件列表（artifact changed）');
    }
    return bytes;
  }
}
