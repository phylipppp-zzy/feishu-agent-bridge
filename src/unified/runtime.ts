import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname, basename, join, relative, isAbsolute, sep } from 'node:path';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { HistoryArchive } from './history-archive.js';
import type { MigrationManifest } from './migration.js';
import { UnifiedStore } from './store.js';
import { UnifiedCore } from './service.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CodexTransport } from './codex-transport.js';
import { FeishuChannel, type ChannelAction, type FeishuPort, type TrustedEnvelope } from './feishu-channel.js';
import type { PlatformPort, PlatformObservation } from './adapter.js';
import { contractError } from './errors.js';
import { FeishuSdkPort } from './feishu-sdk-port.js';
import { LocalCatalog, type CatalogRoot } from './local-catalog.js';
import { ArtifactRegistry } from './artifact-registry.js';
import { EnrichedPort, nativeRefKey } from './port-enrichment.js';
import { localFileLinks } from '../claude/deliver.js';
import { payloadDigest, type Session, type Provider } from './contracts.js';

export interface RuntimeConfig { coreDb:string; channelDb:string; ownerOpenId:string; allowedDestinations:string[]; hostId:string; claudeServiceId:string; codexServiceId:string; claudeStateDir:string; codexEndpoint:string; intervalMs:number; catalogSources?:CatalogRoot[]; allowedProjectRoots?:string[]; outputRoots?:string[]; artifactStatePath?:string; historyArchive?:{root:string;manifestPath:string;manifestSha256:string}; autoMirror?:{enabled:boolean;destination?:string} }
/** Pure validation: never reads environment, opens a database, connects or sends. */
export function validateRuntimeConfig(c:RuntimeConfig):void {
  if (!c || ![c.coreDb,c.channelDb,c.ownerOpenId,c.hostId,c.claudeServiceId,c.codexServiceId,c.claudeStateDir,c.codexEndpoint].every(x=>typeof x==='string' && !!x.trim()) || !Array.isArray(c.allowedDestinations) || !c.allowedDestinations.length || !c.allowedDestinations.every(x=>typeof x==='string' && !!x.trim()) || c.coreDb===c.channelDb || c.channelDb===':memory:' || !Number.isSafeInteger(c.intervalMs) || c.intervalMs<100) throw new Error('invalid runtime configuration');
  for (const list of [c.allowedProjectRoots,c.outputRoots]) if (list !== undefined && (!Array.isArray(list) || !list.every(x=>typeof x==='string' && isAbsolute(x)))) throw new Error('invalid trusted roots');
  if (c.catalogSources !== undefined && (!Array.isArray(c.catalogSources) || !c.catalogSources.every(x=>x && (x.provider==='claude'||x.provider==='codex') && typeof x.directory==='string' && isAbsolute(x.directory) && typeof x.hostId==='string' && !!x.hostId.trim() && typeof x.serviceId==='string' && !!x.serviceId.trim()))) throw new Error('invalid catalog sources');
  if (c.catalogSources?.some(x=>x.hostId!==c.hostId || x.serviceId!==(x.provider==='claude' ? c.claudeServiceId : c.codexServiceId))) throw new Error('catalog source namespace does not match runtime configuration');
  if (c.artifactStatePath !== undefined && !isAbsolute(c.artifactStatePath)) throw new Error('invalid artifact state path');
  if(c.historyArchive && (!isAbsolute(c.historyArchive.root) || !isAbsolute(c.historyArchive.manifestPath) || !/^[0-9a-f]{64}$/.test(c.historyArchive.manifestSha256))) throw new Error('invalid archive configuration');
  if (c.autoMirror && (typeof c.autoMirror.enabled!=='boolean' || (c.autoMirror.enabled && (!c.autoMirror.destination || !c.allowedDestinations.includes(c.autoMirror.destination))))) throw new Error('invalid auto mirror configuration');
  const url = new URL(c.codexEndpoint); if ((!['ws:','wss:'].includes(url.protocol) && c.codexEndpoint !== 'codex-proxy://default') || url.username || url.password) throw new Error('invalid Codex endpoint');
}
/** The caller must ensure inbound envelopes originate from authenticated transport. */
export class UnifiedRuntime {
  readonly store:UnifiedStore; readonly core:UnifiedCore; readonly channel:FeishuChannel;
  private baselinePreparing=false; private readonly recoveryFailedSessions=new Set<string>(); private readonly unavailableProviders=new Set<Provider>(); private readonly restartPending:string[]; private recoveryFailure:string|null=null; private recoveryStarted:Promise<void>|undefined; private timer:ReturnType<typeof setInterval>|undefined; private running:Promise<void>|undefined; private lastError:string|null=null; private closed=false; private closing=false; private closePromise:Promise<void>|undefined; private readonly intakes=new Set<Promise<unknown>>(); private readonly lock:DatabaseSync; private readonly providers:PlatformPort[]; private readonly port:FeishuPort & {authorizedDestination?:(destination:string)=>boolean;drainInbound?:(handle:(e:TrustedEnvelope,a:ChannelAction,scope?:string)=>Promise<unknown>)=>Promise<void>;resourceIssues?:()=>Array<{eventId:string;state:string;attempts:number;reason:string}>};
  constructor(readonly config:RuntimeConfig, port:FeishuPort, providers:PlatformPort[], private readonly options:{canDiscover?:(s:Session)=>boolean;allowDiscovered?:(id:string)=>boolean;requireReadonlyHydration?:boolean;refresh?:(runtime:UnifiedRuntime)=>Promise<void>;cleanup?:()=>void}={}) {
    this.providers=providers; this.port=port; validateRuntimeConfig(config);
    const channelPath=resolve(config.channelDb); const canonical=existsSync(channelPath) ? realpathSync(channelPath) : join(realpathSync(dirname(channelPath)),basename(channelPath));
    this.lock=new DatabaseSync(`${canonical}.runtime-lock`);
    try { this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); } catch { this.lock.close(); throw new Error('channel runtime already active'); }
    let archive:HistoryArchive|undefined;
    try { if(config.historyArchive) { const data=readFileSync(config.historyArchive.manifestPath); if(createHash('sha256').update(data).digest('hex')!==config.historyArchive.manifestSha256) throw new Error('archive manifest hash mismatch'); archive=new HistoryArchive(config.historyArchive.root,JSON.parse(data.toString()) as MigrationManifest); } } catch(e) {this.lock.exec('ROLLBACK');this.lock.close();throw e;}
    const destinations = new Set(config.allowedDestinations);
    const owner = (identity:{source:string;subject:string}) => identity.source==='feishu' && identity.subject===config.ownerOpenId;
    try {
      this.store = new UnifiedStore(config.coreDb);
      this.restartPending=this.store.pendingOutbox();
      try { this.core = new UnifiedCore(this.store,providers,(identity,session)=>owner(identity) && (!options.canDiscover || options.canDiscover(session)),(identity)=>owner(identity),()=>false,options.canDiscover,archive);
        const measuredPort=new Proxy(port,{get:(target,key)=>{const value=Reflect.get(target,key); if(typeof value!=='function') return value; if(['send','update','sendFile'].includes(String(key))) return async (...args:unknown[])=>{let guardFailed=false;const last=args.length-1; if(typeof args[last]==='function') {const guard=args[last] as ()=>Promise<void>;args[last]=async()=>{try {await guard();} catch(error) {guardFailed=true;throw error;}};} try {const result=await Reflect.apply(value,target,args); try {this.channel.recordHealth('feishu_delivery',(key==='send' && !result)?'unverified':'healthy',(key==='send' && !result)?'消息回执未确认':null);} catch {} return result;} catch(error) {const e=error && typeof error==='object' ? error as {deliveryKind?:unknown;platformCode?:unknown} : {}; const rejected=e.deliveryKind==='api_rejected' && typeof e.platformCode==='number' && Number.isSafeInteger(e.platformCode); const reason=guardFailed?'发送前权限或绑定变化':rejected?`平台拒绝（代码 ${e.platformCode}）`:'投递结果未知'; const deliveryId=args[key==='send'?2:3];try {if(typeof deliveryId==='string') this.channel.recordDeliveryDiagnostic(deliveryId,guardFailed?'guard_rejected':rejected?'api_rejected':'unknown',rejected?e.platformCode as number:null);} catch {} try {this.channel.recordHealth('feishu_delivery','degraded',reason);} catch {} throw error;}}; return value.bind(target);}}); try { this.channel = new FeishuChannel(this.core,measuredPort,async (identity,destination,sessionId)=>{ if(!owner(identity) || !(this.port.authorizedDestination?.(destination) ?? destinations.has(destination))) return false; if(!sessionId || !options.canDiscover) return true; try {return options.canDiscover(this.store.getSession(sessionId));} catch {return options.allowDiscovered?.(sessionId) ?? false;} },config.channelDb,undefined,options.requireReadonlyHydration === true); } catch(error) { this.core.close(); throw error; }
      } catch(error) { this.store.close(); throw error; }
    } catch(error) { this.lock.exec('ROLLBACK'); this.lock.close(); throw error; }
    for(const component of ['core','feishu_delivery','feishu_callback','feishu_resources','codex_connection','codex_run','claude_connection','claude_run','claude_quota','interaction_return']) try {this.channel.invalidateHealth(component,'进程重启后尚未重新观测');} catch {}
    if('onResourceHealth' in port) (port as FeishuPort & {onResourceHealth:(status:'healthy'|'degraded',reason:string|null)=>void}).onResourceHealth=(status,reason)=>{try {this.channel.recordHealth('feishu_resources',status,reason);} catch {}};
    this.core.onAcceptedObservation=o=>{const record=(component:string,status:'healthy'|'degraded'|'unverified',reason:string|null=null)=>{try {this.channel.recordHealth(component,status,reason);} catch {}}; const provider=o.ref.provider; if(provider==='claude' && o.type==='message' && o.message.role==='assistant') record('claude_connection','healthy'); if(o.type==='turn' && ['completed','failed','interrupted'].includes(o.turn.status)) record(`${provider}_run`,o.turn.status==='completed'?'healthy':o.turn.status==='failed'?'degraded':'unverified',o.turn.status==='completed'?null:o.turn.status==='failed'?'运行失败':'本轮中断，结果未确认'); if(o.type==='event' && provider==='claude') {if(o.event.type==='adapter.stream_failed'){record('claude_run','degraded','SDK流中断');record('claude_connection','degraded','SDK流中断');} if(o.event.type==='provider.usage_limit')record('claude_quota','degraded','服务报告额度限制'); if(o.event.type==='provider.usage_available')record('claude_quota','healthy');} if(o.type==='interaction') {const i=o.interaction;if(i.status==='answer_pending_delivery') record('interaction_return','unverified','答复已提交，原生结果待确认');else if(i.status==='resolved') record('interaction_return',i.nativeResult?.status==='accepted'?'healthy':'unverified',i.nativeResult?.status==='accepted'?null:'原生结果未确认');}};
    const coreHealth=this.core.health.bind(this.core);
    this.core.health=async()=>{ const base=(await coreHealth())[0]!;const h=this.health(); const interactions=this.store.interactionHealthCounts(); const deliveryUnknown=this.channel.unconfirmedDeliveryCount(); const names=['core','feishu_delivery','feishu_callback','feishu_resources','codex_connection','codex_run','claude_connection','claude_run','claude_quota','interaction_return']; return [...names.map(component=>{const f=this.channel.healthFact(component); const issues=component==='feishu_resources'?h.resourceIssues.length:component==='feishu_delivery'?deliveryUnknown:component==='feishu_callback'?h.unknownInbox:component==='interaction_return'?interactions.unknown:0; const status=component==='core' && base.status==='degraded'?'degraded' as const:issues?'degraded' as const:f.status; return {...f,component,status,reason:component==='core' && base.status==='degraded'?base.reason:issues?'存在未确认或失败记录':f.reason,backlog:component==='core'?base.backlog:component==='feishu_callback'?this.channel.pendingInbox().length:component==='feishu_resources'?h.resourceIssues.length:component==='interaction_return'?interactions.pending:null,unknown:component==='feishu_delivery'?deliveryUnknown:component==='feishu_callback'?h.unknownInbox:component==='feishu_resources'?h.resourceIssues.filter(x=>x.state!=='rejected').length:component==='interaction_return'?interactions.unknown:null,lastDeliveryAt:component==='feishu_delivery'?f.lastSuccessAt:null,updatedAt:f.lastObservedAt};}),{component:'runtime',status:h.status,reason:h.reason ?? (h.resourceIssues.length ? '资源待核对' : h.unknownInbox || h.unknownDeliveries ? '存在未知回执' : null),backlog:h.resourceIssues.length,lastDeliveryAt:null,updatedAt:null,lastObservedAt:null,lastSuccessAt:null,lastFailureAt:null,lastFailureReason:null,unknown:h.unknownInbox+h.unknownDeliveries}]; };

  }
  /** Offline preparation: read and baseline only existing readonly bindings, without Feishu delivery. */
  async prepareReadonlyHistoryBaselines(limit=2):Promise<{attempted:number;completed:number;failed:number;remaining:number}> {
    if(this.closed || this.closing || this.running || this.timer || this.baselinePreparing) throw new Error('runtime unavailable');if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('invalid baseline limit'); this.baselinePreparing=true;
    try {const pending=()=>this.channel.bindingsForRestore().filter(b=>b.accessMode==='read_only' && !this.channel.readonlyHydrated(b.destination,b.sessionId));
    const groups=new Map<string,ReturnType<FeishuChannel['bindingsForRestore']>>();for(const binding of pending()) {const items=groups.get(binding.sessionId) ?? [];items.push(binding);groups.set(binding.sessionId,items);}let attempted=0,completed=0,failed=0;
    for(const [id,bindings] of [...groups].slice(0,limit)) {attempted++;try {const session=this.store.getSession(id);if(this.store.isDetached(id) || session.status!=='read_only' || session.control.input==='available' || (this.options.canDiscover && !this.options.canDiscover(session))) throw new Error('session unavailable');for(const binding of bindings) if(!await this.channel.isReadonlyBaselineAuthorized(binding.destination,id)) throw new Error('binding unauthorized');await this.core.refreshReadOnlySession(id);for(const binding of bindings) await this.channel.baselineReadonlyHistory(binding.destination,id);completed++;}catch{failed++;}}
    return {attempted,completed,failed,remaining:new Set(pending().map(b=>b.sessionId)).size};} finally {this.baselinePreparing=false;}
  }
  async captureResourceScope(envelope:TrustedEnvelope):Promise<string> { if(this.closed || this.closing) throw new Error('closed'); const capture=this.channel.captureBindingScope(envelope); this.intakes.add(capture); try { return await capture; } finally { this.intakes.delete(capture); } }
  async handleTrusted(envelope:TrustedEnvelope,action:ChannelAction):Promise<unknown> { if(this.closed || this.closing) throw new Error('closed'); const intake=this.channel.intake(envelope,action); this.intakes.add(intake); try { return await intake; } finally { this.intakes.delete(intake); } }
  async tick():Promise<void> {
    if (this.closed || this.closing || this.baselinePreparing) throw new Error('closed or baseline preparation active'); if (this.running) return this.running;
    this.running = (async()=>{ let failed=false; try { await this.port.drainInbound?.((e,a,scope)=>this.channel.intake(e,a,scope)); for (const id of this.channel.pendingInbox()) { try { await this.channel.drain(id); } catch { failed=true; } } await this.core.dispatchPending(); await this.channel.advanceCompleted(); try {await this.options.refresh?.(this);} catch {failed=true;} for(const destination of this.channel.boundDestinations()) { try { const binding=this.channel.bindingsForRestore().find(b=>b.destination===destination); if(this.options.requireReadonlyHydration && binding?.accessMode==='read_only' && !this.channel.readonlyHydrated(destination,binding.sessionId)) continue; await this.channel.sync(destination); } catch(e) { if (!(e instanceof Error && e.message==='destination is not bound')) failed=true; } } if (failed) throw new Error('isolated work failed'); this.lastError=null; try {this.channel.recordHealth('core','healthy');} catch {} } catch { try {this.channel.recordHealth('core','degraded','调度或同步失败');} catch {} this.lastError='dispatch or synchronization failed; inspect persisted state before retry'; throw new Error(this.lastError); } })();
    try { await this.running; } finally { this.running=undefined; }
  }
  recordProviderConnection(provider:Provider,ready:boolean):void {try {this.channel.recordHealth(`${provider}_connection`,ready?'healthy':'degraded',ready?null:'连接不可用');} catch {}}
  setProviderReady(provider:Provider,ready:boolean):void {if(ready)this.unavailableProviders.delete(provider);else this.unavailableProviders.add(provider);this.core.setProviderAvailable(provider,ready);}
  /** Explicit startup only; no input or new model turn is started by restoration. */
  restoreBindings():Promise<void> {
    if(this.baselinePreparing) return Promise.reject(new Error('baseline preparation active')); if(this.recoveryStarted) return this.recoveryStarted;
    this.recoveryStarted=(async()=>{
      this.store.failUnreboundPending(this.restartPending);
      const restored=new Set<string>();
      for(const binding of this.channel.bindingsForRestore()) {
        if(this.closed || this.closing) return;
        if(binding.accessMode!=='interactive' || restored.has(binding.sessionId) || !this.store.hasInteractiveIntent(binding.sessionId)) continue;
        if(this.unavailableProviders.has(this.store.getSession(binding.sessionId).native.provider)) {this.recoveryFailedSessions.add(binding.sessionId);continue;}
        if(!await this.channel.isRestoreBindingAuthorized(binding) || this.closed || this.closing) continue;
        restored.add(binding.sessionId);
        try { await this.core.restoreInteractive(binding.sessionId,binding.owner,async()=>{if(this.closed || this.closing)return false;for(const current of this.channel.bindingsForRestore()) if(current.sessionId===binding.sessionId && current.owner.source===binding.owner.source && current.owner.subject===binding.owner.subject && await this.channel.isRestoreBindingAuthorized(current)) return true; return false;}); }
        catch { this.recoveryFailedSessions.add(binding.sessionId); this.recoveryFailure='one or more sessions could not be restored; inspect before retry'; }
      }
    })().catch(()=>{this.recoveryFailure='binding recovery failed; inspect before retry';});
    return this.recoveryStarted;
  }
  /** Retry only persisted interactive intent for the provider that just reconnected. */
  async restoreProviderAfterReconnect(provider:Provider):Promise<void> { if(this.closed || this.closing) return; let failed=false;const seen=new Set<string>();for(const binding of this.channel.bindingsForRestore()) {if(this.closed || this.closing) return;if(binding.accessMode!=='interactive' || seen.has(binding.sessionId) || !this.recoveryFailedSessions.has(binding.sessionId) || !this.store.hasInteractiveIntent(binding.sessionId)) continue;const session=this.store.getSession(binding.sessionId);if(session.native.provider!==provider || !await this.channel.isRestoreBindingAuthorized(binding)) continue;seen.add(binding.sessionId);try {await this.core.restoreInteractive(binding.sessionId,binding.owner,async()=>{if(this.closed || this.closing)return false;for(const current of this.channel.bindingsForRestore()) if(current.sessionId===binding.sessionId && current.owner.source===binding.owner.source && current.owner.subject===binding.owner.subject && await this.channel.isRestoreBindingAuthorized(current)) return true;return false;});this.recoveryFailedSessions.delete(binding.sessionId);} catch {failed=true;}} if(failed) this.recoveryFailure='one or more sessions could not be restored; inspect before retry';else if(this.recoveryFailedSessions.size===0 && this.recoveryFailure==='one or more sessions could not be restored; inspect before retry') this.recoveryFailure=null; }
  startPolling():void { if(this.closed || this.closing || this.timer || this.baselinePreparing) throw new Error('runtime unavailable'); const poll=()=>{void this.restoreBindings().catch(()=>{});void this.tick().catch(()=>{});};this.timer=setInterval(poll,this.config.intervalMs);poll(); }
  health():{status:'healthy'|'degraded';reason:string|null;unknownDeliveries:number;unknownInbox:number;resourceIssues:Array<{eventId:string;state:string;attempts:number;reason:string}>} { const unknownDeliveries=this.channel.pendingDeliveries().length; const unknownInbox=this.channel.unknownInbox().length; const resourceIssues=this.port.resourceIssues?.() ?? []; return {status:this.lastError || this.recoveryFailure || this.store.recoveryQuarantineCount() || unknownDeliveries || unknownInbox || resourceIssues.length ? 'degraded':'healthy',reason:this.lastError ?? this.recoveryFailure ?? (this.store.recoveryQuarantineCount() ? 'reconnect and explicitly attach quarantined sessions' : null),unknownDeliveries,unknownInbox,resourceIssues}; }
  close():Promise<void> {
    if(this.closePromise) return this.closePromise;
    this.closing=true; if(this.timer) clearInterval(this.timer);
    const running=this.running; const intakes=[...this.intakes];
    this.closePromise=(async()=>{ await Promise.allSettled(intakes); await running?.catch(()=>{}); try { await Promise.all(this.providers.map(p=>p.close?.())); } finally { try { this.core.close(); this.channel.close(); this.store.close(); } finally { this.lock.exec('ROLLBACK'); this.lock.close(); this.options.cleanup?.(); this.closed=true; } } })();
    return this.closePromise;
  }
}
const canonicalPath=(path:string):string => { const p=resolve(path); return existsSync(p) ? realpathSync(p) : join(realpathSync(dirname(p)),basename(p)); };
const inside=(child:string,root:string):boolean => {const rel=relative(root,child);return rel==='' || (!isAbsolute(rel) && rel!=='..' && !rel.startsWith(`..${sep}`));};
/** Construct enrichment under a separate state lock; no network connections are opened. */
export async function createIntegratedRuntime(config:RuntimeConfig, port:FeishuPort, bases:PlatformPort[]):Promise<UnifiedRuntime> {
  validateRuntimeConfig(config);
  if (!config.artifactStatePath || !config.catalogSources || !config.allowedProjectRoots || !config.outputRoots) throw new Error('explicit catalog, root and artifact state configuration required');
  const persistent=[config.coreDb,config.channelDb,config.artifactStatePath].map(canonicalPath); if (new Set(persistent).size !== persistent.length) throw new Error('runtime state paths must be distinct');
  const projects=config.allowedProjectRoots.map(x=>realpathSync(x)), outputs=config.outputRoots.map(x=>realpathSync(x));
  const sources=config.catalogSources.map(s=>({...s,directory:realpathSync(s.directory)}));
  const sourceAllowed=(s:Session)=>s.native.hostId===config.hostId && s.native.serviceId===(s.native.provider==='claude'?config.claudeServiceId:config.codexServiceId) && sources.some(x=>x.provider===s.native.provider && x.hostId===s.native.hostId && x.serviceId===s.native.serviceId);
  const trusted=(s:Session):boolean=>{try {return sourceAllowed(s) && isAbsolute(s.project) && projects.some(root=>inside(realpathSync(s.project),root));}catch{return false;}};
  const registry=new ArtifactRegistry({},20*1024*1024,config.artifactStatePath); const catalog=new LocalCatalog(sources); const discovered=new Set<string>(); let enrichmentError=false;
  const configure=(s:Session)=>{if(!trusted(s)) throw new Error('session outside trusted configuration'); const project=realpathSync(s.project); registry.setRoots(s.native,outputs.filter(root=>inside(root,project))); registry.setProjectRoot(s.native,project);};
  // Pin each verified native ref to its canonical project; provider events alone cannot establish authority.
  const pinned=new Map<string,Session>();
  const buffered:Array<{observation:PlatformObservation; listener:(o:PlatformObservation)=>void; bytes:number; expires:number}> = [];
  let bufferedBytes=0; let activeRuntime:UnifiedRuntime|undefined;
  const discard=(index:number):void=>{bufferedBytes-=buffered[index]!.bytes;buffered.splice(index,1);};
  const queueObservation=(observation:PlatformObservation,listener:(o:PlatformObservation)=>void):void=>{
    let copy:PlatformObservation, bytes:number; try {copy=structuredClone(observation);bytes=Buffer.byteLength(JSON.stringify(copy));} catch {enrichmentError=true;return;}
    if(bytes>65536 || buffered.length>=128 || bufferedBytes+bytes>1024*1024) {enrichmentError=true;return;}
    buffered.push({observation:copy,listener,bytes,expires:Date.now()+60000});bufferedBytes+=bytes;
  };
  const discardRef=(ref:Session['native']):void=>{for(let i=buffered.length-1;i>=0;i--) if(nativeRefKey(buffered[i]!.observation.ref)===nativeRefKey(ref)) {discard(i);enrichmentError=true;}};
  const pin=(session:Session):boolean=>{
    if (!trusted(session) || !session.native.nativeSessionId || session.control.serviceId!==session.native.serviceId) return false;
    const key=nativeRefKey(session.native), previous=pinned.get(key);
    try { if(previous && realpathSync(previous.project)!==realpathSync(session.project)) return false; } catch { return false; }
    pinned.set(key,structuredClone(session)); return true;
  };
  const namespace=(ref:Session['native'],provider:PlatformPort['provider']):boolean=>ref.provider===provider && ref.hostId===config.hostId && ref.serviceId===(provider==='claude'?config.claudeServiceId:config.codexServiceId) && !!ref.nativeSessionId;
  const secured=(base:PlatformPort):PlatformPort=>new Proxy(base, {get(target,key) {
    if(key==='list') return async (cursor:string|null,limit:number)=>{ const page=await target.list(cursor,limit); return {...page,items:page.items.filter(s=>{if(!namespace(s.native,target.provider)) {enrichmentError=true;return false;} if(!trusted(s)) return false; const ok=pin(s); if(!ok) enrichmentError=true; return ok;})}; };
    if(key==='read') return async (ref:Session['native'])=>{ if(!namespace(ref,target.provider)) throw contractError('invalid_request','provider namespace mismatch'); const snapshot=await target.read(ref); if(payloadDigest(snapshot.session.native)!==payloadDigest(ref) || !pin(snapshot.session)) throw contractError('invalid_request','provider session metadata mismatch'); return snapshot; };
    if(key==='onObservation') return (listener:(o:PlatformObservation)=>void)=>target.onObservation(o=>{
      if(!namespace(o.ref,target.provider)) {enrichmentError=true;return;}
      const existing=pinned.get(nativeRefKey(o.ref));
      if(!existing || !activeRuntime?.store.findSession(o.ref)) {queueObservation(o,listener);return;}
      if(!trusted(existing) || (o.type==='session' && (payloadDigest(o.session.native)!==payloadDigest(o.ref) || !pin(o.session)))) {enrichmentError=true; return;}
      listener(o);
    });
    const value=Reflect.get(target,key,target); return typeof value==='function' ? value.bind(target) : value;
  }});
  class ScopedPort extends EnrichedPort {
    override seedConnectionGeneration(minimum:number):void { super.seedConnectionGeneration(minimum); }
    override seedControlGeneration(ref:Session['native'],minimum:number):void { if(!namespace(ref,this.provider)) throw contractError('invalid_request','provider namespace mismatch'); super.seedControlGeneration(ref,minimum); }
    override async list(cursor:string|null,limit:number) { const page=await super.list(cursor,limit); const items=page.items.filter(s=>{if(!namespace(s.native,this.provider)) {enrichmentError=true;return false;} if(!trusted(s)) return false; if(!pin(s)) {enrichmentError=true;return false;} configure(s); discovered.add(`session_${payloadDigest(s.native)}`); return true;}); return {...page,items}; }
    override async discoverNewer(watermark:number,cursor:string|null,limit:number) {const page=await super.discoverNewer(watermark,cursor,limit);const items=page.items.filter(s=>{if(!namespace(s.native,this.provider)) {enrichmentError=true;return false;}if(!trusted(s))return false;if(!pin(s)){enrichmentError=true;return false;}configure(s);discovered.add(`session_${payloadDigest(s.native)}`);return true;});return {...page,items};}
    override async discoverRunning(cursor:string|null,limit:number) { const page=await super.discoverRunning(cursor,limit); const items=page.items.filter(s=>{if(!namespace(s.native,this.provider)) {enrichmentError=true;return false;} if(!trusted(s)) return false; if(!pin(s)) {enrichmentError=true;return false;} configure(s); discovered.add(`session_${payloadDigest(s.native)}`); return true;}); return {...page,items}; }
    override async read(ref:Session['native']) { const result=await super.read(ref); if(payloadDigest(result.session.native)!==payloadDigest(ref) || !pin(result.session)) throw contractError('invalid_request','provider session metadata mismatch'); configure(result.session); return result; }
    override async inspectTurnResidual(ref:Session['native'],turnId:string) {const pinnedSession=pinned.get(nativeRefKey(ref));if(!namespace(ref,this.provider) || !pinnedSession || !trusted(pinnedSession)) throw contractError('unauthorized','provider session scope unavailable');return super.inspectTurnResidual(ref,turnId);}
    override async create(cwd:string,model:string|null) {
      let project:string; try { project=realpathSync(cwd); } catch {throw contractError('invalid_request','untrusted project');}
      if(!sources.some(x=>x.provider===this.provider && x.hostId===config.hostId && x.serviceId===(this.provider==='claude'?config.claudeServiceId:config.codexServiceId)) || !projects.some(root=>inside(project,root))) throw contractError('invalid_request','untrusted project');
      const ack=await super.create(cwd,model); const s=ack.createdSession;
      // A native call has occurred: any inconsistent or unverifiable result has unknown outcome.
      if(ack.status!=='submitted' || !ack.nativeReference || !s || !namespace(s.native,this.provider) || s.native.nativeSessionId!==ack.nativeReference || !trusted(s)) {if(s?.native) discardRef(s.native);throw contractError('outcome_unknown','provider create metadata mismatch');}
      let returnedProject:string; try {returnedProject=realpathSync(s.project);} catch {throw contractError('outcome_unknown','provider project unavailable');}
      if(returnedProject!==project || !pin(s)) {discardRef(s.native);throw contractError('outcome_unknown','provider create project mismatch');}
      configure(s); return ack;
    }
    override async resume(ref:Session['native']) {
      await this.read(ref); const ack=await super.resume(ref);
      if(ack.nativeReference!==ref.nativeSessionId || (ack.createdSession && (payloadDigest(ack.createdSession.native)!==payloadDigest(ref) || !pin(ack.createdSession)))) throw contractError('outcome_unknown','provider resume metadata mismatch');
      return ack;
    }
  }
  const ports=bases.map(base=>new ScopedPort(secured(base),catalog,registry,()=>{enrichmentError=true;}));
  const stateLock=new DatabaseSync(`${canonicalPath(config.artifactStatePath)}.runtime-lock`); try {stateLock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');} catch {stateLock.close(); await Promise.all(ports.map(p=>p.close())); throw new Error('artifact state already active');}
  let runtime:UnifiedRuntime; let refreshOffset=0; let autoCursor:string|null=null; let recentCursor:string|null=null; let autoWatermark:number|null=null; let autoScopes:Array<{root:string;watermark:number}>=[]; const localCodexClock=config.codexEndpoint==='codex-proxy://default' || ['localhost','127.0.0.1','[::1]','::1'].includes(new URL(config.codexEndpoint).hostname);
  try { runtime=new UnifiedRuntime(config,port,ports,{canDiscover:trusted,allowDiscovered:id=>discovered.has(id),requireReadonlyHydration:true,cleanup:()=>{stateLock.exec('ROLLBACK');stateLock.close();},refresh:async r=>{
      let autoFailed=false;
      try {await r.channel.applyPendingAutoBaselines();} catch {autoFailed=true;}
      if(config.autoMirror?.enabled) {
        try {
        const target=config.autoMirror.destination!, source=ports.find(p=>p.provider==='codex'), authorized=(port as FeishuPort & {authorizedDestination?:(destination:string)=>boolean}).authorizedDestination?.bind(port);
        if (!source || !(authorized?.(target) ?? config.allowedDestinations.includes(target))) throw new Error('auto mirror destination unavailable');
        const watermarkFor=(item:Session):number|null=>{try {const project=realpathSync(item.project);const matching=autoScopes.filter(x=>inside(project,x.root)).map(x=>x.watermark);return matching.length ? Math.min(...matching) : null;}catch{return null;}};
        const candidates:Session[]=[]; if(localCodexClock && autoWatermark!==null && bases.find(p=>p.provider==='codex')?.discoverNewer) {try {const recent=await source.discoverNewer(autoWatermark,recentCursor,1);recentCursor=recent.nextCursor;if(recent.partialFailure)autoFailed=true;for(const item of recent.items) {const created=item.createdAt ? Date.parse(item.createdAt)/1000 : NaN;const observed=item.discoveryObservedAt ? Date.parse(item.discoveryObservedAt)/1000 : Math.floor(Date.now()/1000);if(Number.isSafeInteger(created) && Number.isSafeInteger(observed) && created>observed) r.channel.markAutoUncertain(target,item.native);else if(Number.isSafeInteger(created) && (watermarkFor(item)!==null && created>watermarkFor(item)!) && created<=observed && !r.channel.isAutoUncertain(target,item.native)) candidates.push(item);}} catch {recentCursor=null;autoFailed=true;}} try {const active=await source.discoverRunning(autoCursor,1);autoCursor=active.nextCursor;if(active.partialFailure)autoFailed=true;for(const item of active.items) if(!candidates.some(x=>payloadDigest(x.native)===payloadDigest(item.native))) candidates.push(item);} catch {autoCursor=null;autoFailed=true;}
        for(const item of candidates) {
          try {
          if (!(authorized?.(target) ?? config.allowedDestinations.includes(target)) || !trusted(item)) continue;
          const created=item.createdAt ? Date.parse(item.createdAt)/1000 : NaN;const observed=item.discoveryObservedAt ? Date.parse(item.discoveryObservedAt)/1000 : Math.floor(Date.now()/1000);if(Number.isSafeInteger(created) && Number.isSafeInteger(observed) && created>observed) r.channel.markAutoUncertain(target,item.native);
          let session=r.store.findSession(item.native);
          if(!session) {
            const capabilities=Object.fromEntries(Object.entries(item.capabilities).map(([name,value])=>[name,name==='view'?value:{status:'unsupported',reason:'discovered session is read-only until attached'}])) as Session['capabilities'];
            const candidate:Session={...item,sessionId:`session_${payloadDigest(item.native)}`,status:'read_only',capabilities,control:{...item.control,owner:null,input:'unavailable',reason:'discovered session is not attached'}};
            try {r.store.insertSession(candidate);session=candidate;} catch(error) {session=r.store.findSession(item.native);if(!session)throw error;}
          }
          if(r.store.isDetached(session.sessionId) || !trusted(session)) continue;
          const eventId=`auto-mirror:${payloadDigest([target,item.native])}`;
          await r.channel.applyAutoBaseline(eventId);
          if(r.channel.bindingsForRestore().some(b=>b.sessionId===session!.sessionId)) continue;
          await r.core.refreshReadOnlySession(session.sessionId);
          const now=Math.floor(Date.now()/1000);const provenNew=localCodexClock && autoWatermark!==null && Number.isSafeInteger(created) && (watermarkFor(item)!==null && created>watermarkFor(item)!) && created<=now && !r.channel.isAutoUncertain(target,item.native); await r.channel.prepareAutoBaseline(eventId,session.sessionId,provenNew);
          await r.channel.handle({eventId,destination:target,identity:{source:'feishu',subject:config.ownerOpenId}},{action:'bind',sessionId:session.sessionId,mode:'read_only'});await r.channel.applyAutoBaseline(eventId);
          } catch {autoFailed=true;}
        }
        } catch {autoFailed=true;}
      }
      for(let i=0;i<buffered.length;) {const entry=buffered[i]!,o=entry.observation,existing=pinned.get(nativeRefKey(o.ref)); if(entry.expires<=Date.now()) {discard(i);enrichmentError=true;continue;} if(!existing || !r.store.findSession(o.ref)) {i++;continue;} discard(i); if(!trusted(existing) || (o.type==='session' && (payloadDigest(o.session.native)!==payloadDigest(o.ref) || !pin(o.session)))) {enrichmentError=true;continue;} entry.listener(o);}
      // Native history reads may be expensive. Keep each polling cycle bounded so
      // an imported backlog cannot postpone new inbox work until all sessions refresh.
      const boundIds=new Set(r.channel.bindingsForRestore().map(binding=>binding.sessionId));
      const candidates=r.store.listSessions().filter(s=>!r.store.isDetached(s.sessionId) && trusted(s) && (boundIds.has(s.sessionId) || s.control.input==='available'));
      const count=Math.min(2,candidates.length), start=candidates.length ? refreshOffset%candidates.length : 0; let refreshFailed=false;
      refreshOffset=candidates.length ? (start+count)%candidates.length : 0;
      for(let index=0;index<count;index++) {
        const session=candidates[(start+index)%candidates.length]!;
        try {
        configure(session);
        const baselines=r.channel.bindingsForRestore().filter(binding=>binding.sessionId===session.sessionId && binding.accessMode==='read_only' && !r.channel.readonlyHydrated(binding.destination,session.sessionId));
        if(session.status==='read_only' && session.control.input!=='available') await r.core.refreshReadOnlySession(session.sessionId);
        else if(baselines.length) await r.core.hydrateSessionHistory(session.sessionId);
        for(const binding of baselines) if(!r.channel.hasPendingAutoBaseline(binding.destination,session.sessionId)) await r.channel.baselineReadonlyHistory(binding.destination,session.sessionId);
        { const snapshot=await r.core.getSnapshot(session.sessionId);
          for(const m of snapshot.value.messages) if(m.role==='assistant') for(const block of m.blocks) if(block.type==='text') for(const root of registry.getRoots(session.native)) for(const link of await localFileLinks(block.text.replace(/\]\(localfile:\/\/\//g,'](file:///'),session.project,root)) await registry.register(nativeRefKey(session.native),link.path);
        }
        } catch {refreshFailed=true;}
      }
      if(enrichmentError || refreshFailed || autoFailed) throw new Error('session refresh or artifact observation failed');
    }});
  } catch(error) {stateLock.exec('ROLLBACK');stateLock.close();await Promise.all(ports.map(p=>p.close()));throw error;}
  activeRuntime=runtime;
  try {const sourceKey=payloadDigest([config.hostId,config.codexServiceId,config.codexEndpoint,sources.filter(s=>s.provider==='codex').map(s=>s.directory).sort()]);autoScopes=runtime.channel.configureAutoScopeWatermarks(config.autoMirror?.enabled ? config.autoMirror.destination! : null,sourceKey,[...new Set(projects)].sort(),Math.floor(Date.now()/1000));autoWatermark=autoScopes.length ? Math.min(...autoScopes.map(s=>s.watermark)) : null; await registry.load(); for(const s of runtime.store.listSessions()) if(pin(s)) configure(s); return runtime; } catch(error) {await runtime.close();throw error;}
}
/** Explicit opt-in factory. Construction opens isolated local state, never connects. */
export async function createLiveRuntime(config:RuntimeConfig, credentials:{appId:string;appSecret:string}, sdkDb:string) {
  validateRuntimeConfig(config); if (!sdkDb || !isAbsolute(sdkDb) || [config.coreDb,config.channelDb,config.artifactStatePath].filter((x):x is string=>!!x).some(x=>canonicalPath(x)===canonicalPath(sdkDb))) throw new Error('distinct SDK database required');
  const transport=new CodexTransport(config.codexEndpoint); const claude=new ClaudeAdapter(config.hostId,config.claudeServiceId,config.claudeStateDir); const codex=new CodexAdapter(transport,config.hostId,config.codexServiceId);
  const port=new FeishuSdkPort(credentials,sdkDb,new Set(config.allowedDestinations),config.ownerOpenId); let runtime:UnifiedRuntime;
  try {runtime=await createIntegratedRuntime(config,port,[claude,codex]);} catch(error) {port.close();transport.close();throw error;}
  transport.onHealth=(status,reason)=>{try {runtime.channel.recordHealth('codex_connection',status,reason);} catch {}}; const priorHealth=runtime.core.health.bind(runtime.core); runtime.core.health=async()=>{const h=transport.health(); return (await priorHealth()).map(row=>row.component==='codex_connection'?{...row,status:row.reason==='健康诊断记录失败'?'degraded' as const:h.status==='healthy'?'healthy' as const:h.status==='unverified'?'unverified' as const:'degraded' as const,reason:row.reason==='健康诊断记录失败'?row.reason:h.status==='unverified'?'当前进程尚无连接观测':h.reason,backlog:h.backlog,updatedAt:row.lastObservedAt ?? null}:row);};
  return liveRuntimeLifecycle(runtime,transport,port);
}
/** Shutdown can race either network startup await; no continuation may start polling after close. */
export function liveRuntimeLifecycle(runtime:Pick<UnifiedRuntime,'handleTrusted'|'captureResourceScope'|'startPolling'|'close'> & Partial<Pick<UnifiedRuntime,'restoreBindings'|'restoreProviderAfterReconnect'|'setProviderReady'|'recordProviderConnection'>>, transport:Pick<CodexTransport,'connect'|'close'> & Partial<Pick<CodexTransport,'onDisconnect'|'connected'>>, port:Pick<FeishuSdkPort,'start'|'stopReceiving'|'close'>) {
  let closing=false, started=false, closePromise:Promise<void>|undefined, timer:ReturnType<typeof setTimeout>|undefined, connecting=false, attempt=0; const previousDisconnect=transport.onDisconnect;
  const schedule=()=>{if(closing || timer || connecting) return;const delay=Math.min(30000,1000*2**Math.min(attempt,5));timer=setTimeout(()=>{timer=undefined;void connect();},delay);timer.unref?.();};
  const connect=async()=>{if(closing || connecting) return;connecting=true;try {await transport.connect();if(closing){transport.close();return;}if(transport.connected===false) throw new Error('connection closed');attempt=0;runtime.setProviderReady?.('codex',true);runtime.recordProviderConnection?.('codex',true);try {await runtime.restoreProviderAfterReconnect?.('codex');} catch {}} catch {if(!closing) {runtime.recordProviderConnection?.('codex',false);attempt=Math.min(attempt+1,5);}} finally {connecting=false;if(!closing && attempt>0) schedule();}};
  if('onDisconnect' in transport) transport.onDisconnect=(generation:number)=>{try {previousDisconnect?.(generation);} catch {} if(!closing){runtime.setProviderReady?.('codex',false);attempt=Math.max(attempt,1);schedule();}};
  return {runtime,async start(){if(closing || started) throw new Error('runtime closing or started');started=true;runtime.setProviderReady?.('codex',false);try {await port.start((e,a)=>runtime.handleTrusted(e,a),e=>runtime.captureResourceScope(e));if(closing){port.stopReceiving();throw new Error('runtime closing');}runtime.startPolling();void connect();} catch(error) {transport.close();throw error;}},close(){if(closePromise)return closePromise;closing=true;if(timer)clearTimeout(timer);closePromise=Promise.resolve().then(async()=>{try {try {port.stopReceiving();} finally {transport.close();}} finally {try {await runtime.close();} finally {try {transport.close();} finally {port.close();}}}});return closePromise;}};
}
