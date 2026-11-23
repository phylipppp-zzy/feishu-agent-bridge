import type { HistoryReader } from './history-port.js';
import { randomUUID } from 'node:crypto';
import type { PlatformInputBlock, UnifiedService, DispatchGuard, ListQuery, PlatformObservation, PlatformPort } from './adapter.js';
import { payloadDigest, validateSubmitInput, type Interaction, type Message, type Operation, type Provider, type ResolveInteraction, type Session, type SessionSnapshot, type SubmitInput, type WriteContext } from './contracts.js';
import { contractError } from './errors.js';
import { StoreError, UnifiedStore } from './store.js';

/** Authentication is supplied by the channel; an identity string alone is never trusted. */
export type Authorize = (identity: WriteContext['identity'], session: Session, action: string) => boolean;
const sessionIdFor = (native: Session['native']): string => `session_${payloadDigest(native)}`;
const GENERIC_SESSION_TITLE_RE = /(?:Claude|Codex|Antigravity) 会话 · [0-9a-f]{8}$/;
const isGenericFallbackTitle = (title: string): boolean => GENERIC_SESSION_TITLE_RE.test(title.trim());
const isMissingNativeSessionError = (error: unknown): boolean => {
  const obj = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown; detail?: { code?: unknown; message?: unknown } }) : null;
  const code = obj?.code ?? obj?.detail?.code;
  if (code === 'ENOENT') return true;
  const msg = typeof obj?.message === 'string' ? obj.message : typeof obj?.detail?.message === 'string' ? obj.detail.message : String(error ?? '');
  return /^(?:agy )?session not found$/i.test(msg.trim()) || /thread not found|no rollout found/i.test(msg);
};
function mergeDiscoveredReadonlyMetadata(current: Session, discovered: Session): Session {
  if (current.status !== 'read_only' || current.control.input === 'available') return current;
  const candTitle = discovered.title?.trim() ?? '';
  const currTitle = current.title?.trim() ?? '';
  const candTime = discovered.updatedAt ? Date.parse(discovered.updatedAt) : NaN;
  const currTime = current.updatedAt ? Date.parse(current.updatedAt) : NaN;
  const isNewer = Number.isFinite(candTime) && (!Number.isFinite(currTime) || candTime > currTime);
  const shouldUpdateTitle =
    !!candTitle &&
    candTitle !== currTitle &&
    !isGenericFallbackTitle(candTitle) &&
    (isGenericFallbackTitle(currTitle) || !currTitle || isNewer);
  const nextTitle = shouldUpdateTitle ? candTitle : current.title;
  const nextUpdatedAt = isNewer ? discovered.updatedAt : current.updatedAt;
  if (nextTitle === current.title && nextUpdatedAt === current.updatedAt) return current;
  return {
    ...current,
    title: nextTitle,
    ...(nextUpdatedAt ? { updatedAt: nextUpdatedAt } : {}),
  };
}
const fail = (code: Parameters<typeof contractError>[0], message?: string): never => { throw new StoreError(contractError(code, message)); };
function page<T>(items: T[], q: ListQuery) {
  const start = q.cursor === undefined ? 0 : Number(q.cursor);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > 1000) return fail('invalid_request');
  return { items: items.slice(start, start + q.limit), nextCursor: start + q.limit < items.length ? String(start + q.limit) : null };
}
const pendingProviderLists=new WeakMap<PlatformPort,{cursor:string|null;work:ReturnType<PlatformPort['list']>}>();
async function boundedProviderList(port:PlatformPort,cursor:string|null):ReturnType<PlatformPort['list']> {const prior=pendingProviderLists.get(port);if(prior && prior.cursor!==cursor) throw contractError('temporarily_unavailable','provider list already pending'); let timer:ReturnType<typeof setTimeout>|undefined;const work=prior?.work ?? Promise.resolve().then(()=>port.list(cursor,100));if(!prior){pendingProviderLists.set(port,{cursor,work});void work.finally(()=>{if(pendingProviderLists.get(port)?.work===work)pendingProviderLists.delete(port);}).catch(()=>{});}try {return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(contractError('temporarily_unavailable','provider list timed out')),2000);})]);} finally {if(timer)clearTimeout(timer);}}
/** Normalized core. Native transports and credentials are injected through PlatformPort. */
export class UnifiedCore implements UnifiedService {
  private readonly quarantinedHere = new Set<string>();
  private readonly unavailableProviders=new Set<Provider>();
  setProviderAvailable(provider:Provider,available:boolean):void {if(available){if(this.unavailableProviders.has(provider)){const port=this.providers.get(provider);if(port)pendingProviderLists.delete(port);}this.unavailableProviders.delete(provider);}else this.unavailableProviders.add(provider);}
  private readonly providers = new Map<Provider, PlatformPort>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly messageObservations=new Map<string,number>();
  private observationFailure: string | null = null;
  private closed=false;
  validateSteerScope?: (scope:NonNullable<SubmitInput['channelScope']>,sessionId:string)=>boolean;
  onAcceptedObservation?: (observation:PlatformObservation)=>void;
  private readonly unsubscribe: Array<() => void> = [];
  hasProvider(provider: Provider): boolean { return this.providers.has(provider); }
  constructor(readonly store: UnifiedStore, providers: PlatformPort[], private readonly authorize: Authorize, private readonly authorizeBootstrap: (identity: WriteContext['identity'], provider: Provider) => boolean = () => false, private readonly mayDetach: (session: Session) => boolean = () => false, private readonly canDiscover?: (session: Session) => boolean, private readonly historyReader?: HistoryReader,private readonly canInspectCandidate?:(native:Session['native'],project:string)=>boolean) {
    for (const port of providers) {
      if (this.providers.has(port.provider)) throw new Error('duplicate provider');
      port.seedConnectionGeneration?.(store.maxConnectionGeneration());
      // Persisted control is not proof that this fresh provider connection holds a subscription.
      if ((port.provider === 'codex' || port.provider === 'agy') && port.seedConnectionGeneration) for (const current of store.listSessions()) {
        if (current.native.provider !== port.provider || current.control.input !== 'available') continue;
        const capabilities=Object.fromEntries(Object.entries(current.capabilities).map(([key,value])=>[key,key==='view' ? value : {status:'temporarily_unavailable',reason:'explicit resume required after provider restart'}])) as Session['capabilities'];
        store.updateSession({...current,status:'read_only',revision:current.revision+1,capabilities,control:{...current.control,owner:null,input:'unavailable',generation:current.control.generation+1,reason:'explicit resume required after provider restart'}},current.revision,current.control.generation);
      }
      this.providers.set(port.provider, port);
      this.unsubscribe.push(port.onObservation(o => { void this.observe(o).catch(() => { this.observationFailure = 'normalized observation could not be persisted; replay required'; }); }));
    }
    store.recoverAbandonedInFlight();
  }
  close(): void { this.closed=true;for (const off of this.unsubscribe) off(); }
  private port(session: Session): PlatformPort { return this.providers.get(session.native.provider) ?? fail('temporarily_unavailable', 'provider unavailable'); }
  private check(context: WriteContext, action: string): Session {
    const session = this.store.getSession(context.targetId);
    if (!this.authorize(context.identity, session, action)) return fail('unauthorized');
    if(this.unavailableProviders.has(session.native.provider) && ['attachSession','submitInput','resolveInteraction','interruptTurn','requestControl','releaseControl','updateSessionSettings','archiveSession'].includes(action)) return fail('temporarily_unavailable','provider unavailable');
    if (this.store.recoveryQuarantined(session.sessionId)) return fail('control_conflict','reconnect and explicitly attach to reconcile recovery quarantine');
    return session;
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(fn);
    this.tails.set(id, next); void next.finally(() => { if (this.tails.get(id) === next) this.tails.delete(id); }).catch(() => undefined);
    return next;
  }
  presentSession:(session:Session)=>Session=session=>session;
  private present(session: Session): Session { session=this.presentSession(session); if(this.unavailableProviders.has(session.native.provider)) {const capabilities=Object.fromEntries(Object.entries(session.capabilities).map(([key,value])=>[key,key==='view'?value:{status:'temporarily_unavailable',reason:'provider unavailable'}])) as Session['capabilities'];return {...session,status:'unreachable',capabilities,control:{...session.control,input:'unavailable',reason:'provider unavailable'}};} const queue = session.status === 'read_only' ? {status:'unsupported' as const,reason:'read-only session'} : session.capabilities.send.status === 'available' && session.control.input === 'available' ? {status:'available' as const} : {status:'temporarily_unavailable' as const,reason:'input control unavailable'}; return {...session,capabilities:{...session.capabilities,queue}}; }
  clearTransientRefreshFailure(): void {
    if (this.observationFailure === 'read-only refresh failed') this.observationFailure = null;
  }
  async listSessions(q: ListQuery) {
    const stored=this.store.listSessions(); const known=new Set(stored.map(s=>payloadDigest(s.native)));
    const rawByKey=new Map<string,Session>(); const rawAll:Session[]=[];
    for(const s of stored) {
      if(!this.store.isDetached(s.sessionId) && (!this.canDiscover || this.canDiscover(s))) {
        rawByKey.set(payloadDigest(s.native),s);
        rawAll.push(s);
      }
    }
    const discoveredByKey=new Map<string,Session>();
    const unavailableProviders:Provider[]=[];
    const requestedProvider=q.provider && q.provider!=='all' ? q.provider : undefined;
    if(this.canDiscover) {
      const targetPorts=[...this.providers.values()].filter(port=>!requestedProvider || port.provider===requestedProvider);
      const results=await Promise.all(targetPorts.map(async port=>{
        const discovered:Session[]=[];
        try {
          let cursor:string|null=null;const seen=new Set<string>();
          do {
            const found=await boundedProviderList(port,cursor);
            for(const item of found.items) {
              if(item.native.provider!==port.provider) return fail('invalid_request','provider discovery mismatch');
              if(this.canDiscover!(item)) discovered.push(item);
            }
            cursor=found.nextCursor;
            if(cursor!==null){if(seen.has(cursor)||seen.size>=1000)return fail('temporarily_unavailable','invalid provider pagination');seen.add(cursor);}
          } while(cursor!==null);
          this.setProviderAvailable(port.provider,true);
          return {provider:port.provider,discovered,unavailable:false};
        } catch {
          this.setProviderAvailable(port.provider,false);
          return {provider:port.provider,discovered,unavailable:true};
        }
      }));
      for(const res of results) {
        if(res.unavailable) unavailableProviders.push(res.provider);
        for(const item of res.discovered) {
          const key=payloadDigest(item.native);
          discoveredByKey.set(key,item);
          if(!known.has(key)) {
            known.add(key);
            const capabilities=Object.fromEntries(Object.entries(item.capabilities).map(([name,value])=>[name,name==='view' ? value : {status:'unsupported',reason:'discovered session is read-only until attached'}])) as Session['capabilities'];
            rawAll.push({...item,sessionId:sessionIdFor(item.native),status:'read_only',capabilities,control:{...item.control,owner:null,input:'unavailable',reason:'discovered session is not attached'}});
          } else {
            const existing=rawByKey.get(key);
            if(existing) {
              const merged=mergeDiscoveredReadonlyMetadata(existing,item);
              if(merged!==existing) {
                const idx=rawAll.indexOf(existing);
                if(idx>=0) rawAll[idx]=merged;
                rawByKey.set(key,merged);
              }
            }
          }
        }
      }
    }
    const all=rawAll.map(s=>this.present(s));
    const timeOf = (s: Session): number => (s.updatedAt ? Date.parse(s.updatedAt) : NaN);
    all.sort((a, b) => {
      const ta = timeOf(a), tb = timeOf(b);
      const fa = Number.isFinite(ta), fb = Number.isFinite(tb);
      if (fa !== fb) return fa ? -1 : 1;
      if (fa && fb && tb !== ta) return tb - ta;
      return payloadDigest(a.native).localeCompare(payloadDigest(b.native));
    });
    const search=q.search?.toLowerCase();const selected=page(all.filter(s=>(!requestedProvider||s.native.provider===requestedProvider)&&(!search||`${s.native.provider} ${s.native.provider==='agy'?'antigravity ':''}${s.title} ${s.project}`.toLowerCase().includes(search))),q);const items:Session[]=[];
    for(const candidate of selected.items) {
      let current=this.store.findSession(candidate.native);
      if(!current) {
        try {this.store.insertSession(candidate);current=candidate;} catch(error) {current=this.store.findSession(candidate.native);if(!current)throw error;}
      } else if(current.status==='read_only' && current.control.input!=='available') {
        const discovered=discoveredByKey.get(payloadDigest(candidate.native));
        if(discovered) {
          const merged=mergeDiscoveredReadonlyMetadata(current,discovered);
          if(merged!==current) {
            try {
              const updated={...merged,revision:current.revision+1};
              this.store.updateSession(updated,current.revision,current.control.generation);
              current=updated;
            } catch(error) {
              const code=error instanceof StoreError ? error.detail.code : undefined;
              if(code!=='stale_revision' && code!=='control_conflict') throw error;
              current=this.store.findSession(candidate.native) ?? current;
            }
          }
        }
      }
      if(this.store.isDetached(current.sessionId) || (this.canDiscover && !this.canDiscover(current))) continue;
      items.push(this.present(current));
    }
    return {items,nextCursor:selected.nextCursor,...(unavailableProviders.length?{unavailableProviders}:{})};
  }
  async getSession(id: string) { return this.present(this.store.getSession(id)); }
  async hasStopRequest(sessionId:string,turnId:string) {this.store.getSession(sessionId);return this.store.hasStopRequest(sessionId,turnId);}
  async getTurn(sessionId:string,turnId:string) {this.store.getSession(sessionId);return this.store.listTurns(sessionId).find(t=>t.turnId===turnId) ?? null;}
  async getWorkState(id:string) { const session=this.store.getSession(id); return {runningTurns:this.store.listTurns(id).filter(t=>t.status==='running'),queuedInputs:this.store.queuedInputs(id),canArchive:typeof this.port(session).archive === 'function'}; }
  async capabilities(id: string) { return this.present(this.store.getSession(id)).capabilities; }
  async readHistory(id: string, q: ListQuery) { const snapshot=this.store.snapshot(id).value; const archived=await this.historyReader?.read(snapshot.session) ?? []; const current=snapshot.messages; const ids=new Set(current.map(m=>m.messageId)); const items=[...archived.filter(m=>!ids.has(m.messageId)),...current]; if(!q.stable) return page(items,q); const fingerprint=payloadDigest(items); let offset=0; if(q.cursor) {let c:any; try {c=JSON.parse(Buffer.from(q.cursor,'base64url').toString());} catch {return fail('invalid_request');} if(c.id!==id || c.fingerprint!==fingerprint || !Number.isSafeInteger(c.offset) || c.offset<0 || c.offset>items.length) return fail('snapshot_required'); offset=c.offset;} if(!Number.isSafeInteger(q.limit)||q.limit<1||q.limit>1000) return fail('invalid_request'); const end=Math.min(offset+q.limit,items.length); return {items:items.slice(offset,end),nextCursor:end<items.length ? Buffer.from(JSON.stringify({id,fingerprint,offset:end})).toString('base64url') : null}; }
  async listInteractions(id: string, q: ListQuery) { return page(this.store.snapshot(id).value.interactions, q); }
  async getInteraction(id: string) { return this.store.getInteraction(id); }
  /** Trusted runtime polling for a read-only attachment; never resumes or acquires control. */
  async refreshReadOnlySession(id: string, observed?:SessionSnapshot): Promise<void> { return this.refreshHistory(id,false,observed); }
  /** Initial history baseline is read-only even when another binding has interactive control. */
  async hydrateSessionHistory(id:string):Promise<void> { return this.refreshHistory(id,true); }
  private async refreshHistory(id:string, allowInteractive:boolean, supplied?:SessionSnapshot):Promise<void> {
    let current:Session|undefined;
    try {
      current=this.store.getSession(id); if (!allowInteractive && (current.control.input === 'available' || current.status !== 'read_only')) return fail('busy','only read-only sessions can be refreshed');
      const observed=supplied ?? await this.port(current).read(current.native); if (payloadDigest(observed.session.native)!==payloadDigest(current.native) || observed.session.project!==current.project) return fail('invalid_request','provider returned wrong native session or project');
      if (observed.connectionGeneration !== undefined && observed.connectionGeneration < this.store.connectionGeneration(id)) return fail('control_conflict','stale connection generation');
      if ((observed.turns ?? []).some(t=>t.sessionId!==current!.native.nativeSessionId)) return fail('invalid_request','snapshot turn namespace mismatch');
      // Only refresh presentation metadata on the still-readonly, same native session.
      const latest=this.store.getSession(id); if(latest.status==='read_only' && latest.control.input!=='available' && payloadDigest(latest.native)===payloadDigest(current.native) && latest.project===current.project) {const title=observed.session.title?.trim() || latest.title; const candidateTime=observed.session.updatedAt; const updatedAt=candidateTime && Number.isFinite(Date.parse(candidateTime)) && (!latest.updatedAt || !Number.isFinite(Date.parse(latest.updatedAt)) || Date.parse(candidateTime)>Date.parse(latest.updatedAt)) ? candidateTime : latest.updatedAt; if(title!==latest.title || updatedAt!==latest.updatedAt) {try {this.store.updateSession({...latest,title,...(updatedAt ? {updatedAt}:{}),revision:latest.revision+1},latest.revision,latest.control.generation);} catch(error) {const code=error instanceof StoreError ? error.detail.code : undefined;if(code!=='stale_revision' && code!=='control_conflict')throw error;}}}

      for (const native of observed.turns ?? []) this.store.putTurn({...native,sessionId:id});
      for (const native of observed.messages) { const snapshot=this.store.snapshot(id); const old=snapshot.value.messages.find(m=>m.messageId===native.messageId); const value={...native,sessionId:id,sequence:old?.sequence ?? Math.max(0,...snapshot.value.messages.map(m=>m.sequence))+1,revision:old?.revision ?? native.revision}; if(old && payloadDigest(value)===payloadDigest(old)) continue; if(old?.final && !value.final) continue; this.store.putMessage(old ? {...value,revision:old.revision+1} : value,old?.revision ?? null); }
      if(this.observationFailure==='read-only refresh failed') this.observationFailure=null;
    } catch (error) {
      const suppress=!!current && current.status==='read_only' && current.control.input!=='available' && (isMissingNativeSessionError(error) || this.unavailableProviders.has(current.native.provider));
      if(!suppress) this.observationFailure='read-only refresh failed';
      throw error;
    }
  }
  async initialCursor(id:string) {return this.store.initialCursor(id);}
  async getSnapshot(id: string) { const snapshot=this.store.snapshot(id); return {...snapshot,value:{...snapshot.value,session:this.present(snapshot.value.session)}}; }
  async subscribeEvents(id: string, cursor: string, limit: number) { return this.store.subscribeEvents(id, cursor, limit); }
  async getControlState(id: string) { return this.store.getSession(id).control; }
  async getOperation(id: string) { return this.store.getOperation(id); }
  /** Authentication of a new-session request has no session object yet. */
  async createSession(request: {context:WriteContext; payload:{provider:Provider; project:string; model:string|null}}): Promise<Operation> {
    // A channel must explicitly authorize this operation through the dedicated bootstrap hook.
    if (!this.authorizeBootstrap(request.context.identity, request.payload.provider)) return fail('unauthorized');
    const existing=this.store.findIdempotent(request.context,'createSession',request.payload); if(existing) return existing;
    if(this.unavailableProviders.has(request.payload.provider)) return fail('temporarily_unavailable','provider unavailable');
    return this.store.registerCreate(request.context,request.payload);
  }
  async unknownCreateProvider(identity:{source:string;subject:string},destination:string,operationId:string):Promise<Provider|null>{try{const op=this.store.getOperation(operationId),out=this.store.getOutbox(operationId),provider=(out.payload as {provider?:unknown})?.provider;if(this.closed||(provider!=='codex'&&provider!=='claude'&&provider!=='agy')||!this.authorizeBootstrap(identity,provider)||out.context.identity.source!==identity.source||out.context.identity.subject!==identity.subject||out.context.targetId!==`new:${destination}`||out.kind!=='createSession'||op.action!=='createSession'||op.status!=='unknown')return null;return provider;}catch{return null;}}
  private readonly candidateReads=new Map<string,Promise<import('./contracts.js').CandidateMetadata>>();
  private candidateFlight:Promise<{items:import('./contracts.js').CandidateMetadata[];nextCursor:string|null;partial:boolean}>|undefined;
  async inspectUnknownCreateCandidates(identity:{source:string;subject:string},destination:string,operationId:string,query:{cursor?:string;nativeId?:string}):Promise<{items:import('./contracts.js').CandidateMetadata[];nextCursor:string|null;partial:boolean}>{
    const authorize=()=>{const op=this.store.getOperation(operationId),out=this.store.getOutbox(operationId),payload=out.payload as {provider?:unknown};if(!this.authorizeBootstrap(identity,'codex')||out.context.identity.source!==identity.source||out.context.identity.subject!==identity.subject||out.context.targetId!==`new:${destination}`||out.kind!=='createSession'||op.action!=='createSession'||op.status!=='unknown'||payload.provider!=='codex'||!this.canInspectCandidate||this.closed)throw contractError('unauthorized');};authorize();if(query.cursor&&query.nativeId)throw contractError('invalid_request');if(this.candidateFlight)throw contractError('busy');const port=this.providers.get('codex');if(!port?.readCandidateMetadata||!port.candidateGeneration||(!query.nativeId&&!port.listCandidateIds))throw contractError('unsupported');const generation=port.candidateGeneration();if(!Number.isSafeInteger(generation)||generation!<1)throw contractError('temporarily_unavailable');
    const work=(async()=>{const page=query.nativeId?{items:[query.nativeId],nextCursor:null}:await port.listCandidateIds!(query.cursor??null,5);const items:import('./contracts.js').CandidateMetadata[]=[];let partial='partial' in page&&page.partial===true;for(const id of page.items){if(port.candidateGeneration!()!==generation)throw contractError('snapshot_required');try{const key=`${generation}:${id}`;let call=this.candidateReads.get(key);if(!call){if(this.candidateReads.size>=16)throw contractError('busy');call=port.readCandidateMetadata!(id);this.candidateReads.set(key,call);const pending=call;void call.finally(()=>{if(this.candidateReads.get(key)===pending)this.candidateReads.delete(key)}).catch(()=>{});}let readTimer:ReturnType<typeof setTimeout>|undefined;let item:import('./contracts.js').CandidateMetadata;try{item=await Promise.race([call,new Promise<never>((_,reject)=>{readTimer=setTimeout(()=>reject(contractError('temporarily_unavailable')),1000)})]);}finally{if(readTimer)clearTimeout(readTimer);}if(port.candidateGeneration!()!==generation||item.connectionGeneration!==generation)throw contractError('snapshot_required');if(item.native.provider!=='codex'||item.native.nativeSessionId!==id||item.historyVerified!==false||!this.canInspectCandidate!(item.native,item.project)){partial=true;continue;}items.push(item);}catch(error){if(port.candidateGeneration!()!==generation)throw error;partial=true;}}if(port.candidateGeneration!()!==generation)throw contractError('snapshot_required');authorize();return {items,nextCursor:page.nextCursor,partial};})();this.candidateFlight=work;void work.finally(()=>{if(this.candidateFlight===work)this.candidateFlight=undefined;}).catch(()=>{});let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(contractError('temporarily_unavailable','metadata query timed out')),5000);})]);}finally{if(timer)clearTimeout(timer);}
  }
  async attachSession(request: { context: WriteContext; payload: { provider: Provider; hostId: string; serviceId: string; nativeSessionId: string; mode: 'read_only' | 'interactive' } }): Promise<Operation> {
    const {provider,hostId,serviceId,nativeSessionId}=request.payload;
    if(this.unavailableProviders.has(provider)) return fail('temporarily_unavailable','provider unavailable');
    return this.serial(sessionIdFor({provider,hostId,serviceId,nativeSessionId}), async () => {
    const prior=this.store.findIdempotent(request.context,'attachSession',request.payload); if (prior) { if(prior.result?.kind !== 'session') return fail('outcome_unknown'); this.check({...request.context,targetId:prior.result.sessionId},'attachSession'); return prior; }
    const ref = {provider,hostId,serviceId,nativeSessionId};
    const port = this.providers.get(provider) ?? fail('temporarily_unavailable');
    const existingAttachment=this.store.findSession(ref);
    const quarantined=existingAttachment && this.store.recoveryQuarantined(existingAttachment.sessionId);
    if (quarantined && (request.payload.mode!=='interactive' || this.quarantinedHere.has(existingAttachment!.sessionId))) return fail('control_conflict','reconnect and explicitly attach to reconcile recovery quarantine');
    if(!quarantined && existingAttachment && !this.store.isDetached(existingAttachment.sessionId) && ((request.payload.mode==='read_only' && existingAttachment.control.reason!=='discovered session is not attached') || (request.payload.mode==='interactive' && existingAttachment.control.input==='available' && existingAttachment.status!=='read_only'))) {
      if ((this.canDiscover && !this.canDiscover(existingAttachment)) || !this.authorize(request.context.identity,existingAttachment,'attachSession')) return fail('unauthorized');
      return this.store.reuseAttachedSession(request.context,existingAttachment,request.payload);
    }
    let observed = await port.read(ref); if(quarantined && (!Number.isSafeInteger(observed.connectionGeneration) || observed.connectionGeneration! <= this.store.recoveryQuarantineGeneration(existingAttachment!.sessionId)!)) return fail('control_conflict','new connection required to reconcile recovery quarantine'); if (payloadDigest(observed.session.native) !== payloadDigest(ref)) return fail('invalid_request','provider returned wrong native session');
    const existing = this.store.findSession(ref); if (existing && existing.project !== observed.session.project) return fail('unauthorized','session project changed'); const candidate: Session = {...observed.session, sessionId:existing?.sessionId ?? sessionIdFor(ref), native:ref};
    if ((this.canDiscover && !this.canDiscover(candidate)) || !this.authorize(request.context.identity,candidate,'attachSession')) return fail('unauthorized');
    let resumed = false; let attached = false;
    try {
    if (request.payload.mode === 'interactive' && (provider === 'codex' || provider === 'agy')) {
      if (existing) port.seedControlGeneration?.(ref,existing.control.generation);
      const receipt = await port.resume(ref);
      resumed = true;
      if (receipt.nativeReference !== nativeSessionId || !Number.isSafeInteger(receipt.connectionGeneration) || receipt.connectionGeneration! < 0) return fail('outcome_unknown','resume acknowledgement missing identity or generation');
      observed = await port.read(ref);
      if (payloadDigest(observed.session.native) !== payloadDigest(ref) || observed.session.project !== candidate.project || (this.canDiscover && !this.canDiscover(observed.session)) || !this.authorize(request.context.identity,{...observed.session,sessionId:candidate.sessionId},'attachSession')) return fail('unauthorized','session metadata changed during resume');
      if (observed.connectionGeneration !== receipt.connectionGeneration || observed.session.control.input !== 'available') return fail('control_conflict','resume did not establish an interactive subscription');
    }
    let session: Session = {...observed.session, sessionId:candidate.sessionId, native:ref};
    if (request.payload.mode === 'read_only') session = {...session,status:'read_only',control:{...session.control,input:'unavailable',owner:null},capabilities:Object.fromEntries(Object.entries(session.capabilities).map(([k,v]) => [k,k === 'view' ? v : {status:'unsupported',reason:'read-only attachment'}])) as Session['capabilities']};
    if (request.payload.mode === 'interactive' && observed.session.control.input !== 'available') return fail('control_conflict');
    if (request.payload.mode === 'interactive' && (!Number.isSafeInteger(observed.connectionGeneration) || observed.connectionGeneration! < 0)) return fail('temporarily_unavailable','connection generation unavailable');
    if ((observed.turns ?? []).some(t=>t.sessionId!==ref.nativeSessionId)) return fail('invalid_request','snapshot turn namespace mismatch');
    const result=this.store.attachSession(request.context,session,request.payload,request.payload.mode === 'read_only' ? null : observed.connectionGeneration ?? null,request.payload.mode === 'read_only' ? {...observed,interactions:[]} : observed); attached=true; if(quarantined) this.store.clearRecoveryQuarantine(candidate.sessionId); return result;
    } finally {
      if (resumed && !attached) { try { await port.control(ref,'release',{expectedControlGeneration:0,expectedConnectionGeneration:observed.connectionGeneration ?? null,assertCurrent() {}}); } catch { return fail('outcome_unknown','attach failed and subscription release could not be confirmed'); } }
    }
    });
  }
  /** Called only after the runtime has revalidated the persisted channel binding. */
  async restoreInteractive(id:string, identity:WriteContext['identity'], stillAuthorized:()=>Promise<boolean>):Promise<void> {
    let attempted=false;
    try {
      if (!this.store.hasInteractiveIntent(id) || this.store.isDetached(id) || this.store.recoveryQuarantined(id) || !await stillAuthorized()) return;
      const current=this.store.getSession(id);
      if (!this.authorize(identity,current,'attachSession') || (this.canDiscover && !this.canDiscover(current))) return;
      const before=await this.port(current).read(current.native);
      if (payloadDigest(before.session.native)!==payloadDigest(current.native) || before.session.project!==current.project || !await stillAuthorized()) return fail('unauthorized','restore authorization changed');
      const token=randomUUID();
      attempted=true; await this.attachSession({context:{operationId:`restore:${token}`,idempotencyKey:`restore:${token}`,targetId:id,expectedRevision:current.revision,controlGeneration:current.control.generation,identity},payload:{...current.native,mode:'interactive'}});
      if (!await stillAuthorized()) return fail('unauthorized','restore authorization changed');
      // Re-read trusted provider output after the new generation is established.
      const restored=this.store.getSession(id); const snapshot=await this.port(restored).read(restored.native);
      if (payloadDigest(snapshot.session.native)!==payloadDigest(restored.native) || snapshot.session.project!==current.project || snapshot.connectionGeneration!==this.store.connectionGeneration(id) || !await stillAuthorized()) return fail('unauthorized','restore metadata changed');
      if ((snapshot.turns ?? []).some(t=>t.sessionId!==restored.native.nativeSessionId)) return fail('invalid_request','snapshot turn namespace mismatch');
      for (const native of snapshot.turns ?? []) this.store.putTurn({...native,sessionId:id});
      for (const native of snapshot.messages) {
        const messages=this.store.snapshot(id).value.messages; const old=messages.find(m=>m.messageId===native.messageId);
        const value={...native,sessionId:id,sequence:old?.sequence ?? Math.max(0,...messages.map(m=>m.sequence))+1,revision:old?.revision ?? native.revision};
        if (old && (payloadDigest(value)===payloadDigest(old) || (old.final && !value.final))) continue;
        this.store.putMessage(old ? {...value,revision:old.revision+1} : value,old?.revision ?? null);
      }
    } catch(error) {
      if(attempted) {
        // Fence observations before awaiting the release: native events have no trusted generation tag.
        this.quarantinedHere.add(id); this.store.quarantineRecovery(id,'recovery verification failed; release pending');
        const current=this.store.getSession(id), connection=this.store.connectionGeneration(id);
        let releaseConfirmed=false;
        try {
          const receipt=await this.port(current).control(current.native,'release',{expectedControlGeneration:current.control.generation,expectedConnectionGeneration:connection,assertCurrent:()=>{const now=this.store.getSession(id); if(!this.store.recoveryQuarantined(id) || now.control.generation!==current.control.generation || this.store.connectionGeneration(id)!==connection) return fail('control_conflict','recovery release generation changed');}});
          releaseConfirmed=receipt.status==='submitted' && ['unsubscribed','notSubscribed','notLoaded'].includes(receipt.nativeReference ?? '');
        } catch { /* The release might have reached the provider: preserve unknown. */ }
        this.store.quarantineRecovery(id,releaseConfirmed ? 'recovery verification failed; subscription released; reconciliation required' : 'recovery verification failed; subscription release outcome unknown');
        const now=this.store.getSession(id);
        if(now.control.input==='available') { const capabilities=Object.fromEntries(Object.entries(now.capabilities).map(([key,value])=>[key,key==='view' ? value : {status:'temporarily_unavailable',reason:'recovery verification failed'}])) as Session['capabilities']; this.store.updateSession({...now,status:'read_only',revision:now.revision+1,capabilities,control:{...now.control,owner:null,input:'unavailable',generation:now.control.generation+1,reason:releaseConfirmed ? 'recovery verification failed; subscription released' : 'recovery verification failed; subscription release outcome unknown'}},now.revision,now.control.generation); }
        this.observationFailure=releaseConfirmed ? 'restart recovery failed; subscription released; reconciliation required' : 'restart recovery failed; subscription release outcome unknown';
      } else this.observationFailure='restart recovery failed; inspect session before retry';
      throw error;
    }
  }
  async cancelQueuedInput(request: {context: WriteContext; payload:{inputId:string}}) { this.check(request.context,'cancelQueuedInput'); return this.store.cancelQueuedInput(request.context,request.payload.inputId); }
  async requestControl(request: {context:WriteContext; payload:{owner:string; strategy:'wait'|'interrupt'}}) { const s = this.check(request.context,'requestControl'); if (request.payload.strategy !== 'wait' || s.capabilities.handoff.status !== 'available') return fail('unsupported'); return this.store.registerOperation(request.context,'requestControl',request.payload); }
  async releaseControl(request: {context:WriteContext; payload:{owner:string}}) { const s = this.check(request.context,'releaseControl'); if (s.control.owner !== request.payload.owner) return fail('control_conflict'); if (s.capabilities.handoff.status !== 'available') return fail('unsupported'); return this.store.registerOperation(request.context,'releaseControl',request.payload); }
  async submitInput(request: SubmitInput): Promise<Operation> {
    const valid = validateSubmitInput(request); if (!valid.ok) throw new StoreError(valid.error);
    const s = this.check(request.context, 'submitInput');
    if(request.mode==='steer' && s.native.provider!=='codex')return fail('unsupported','steer is available only for Codex');
    if(request.mode==='steer' && request.channelScope && !this.validateSteerScope?.(request.channelScope,s.sessionId)) return fail('control_conflict','binding changed');
    const prior = this.store.findIdempotent(request.context, 'submitInput', request); if (prior) return prior;
    const capability = request.mode === 'new' ? 'send' : request.mode;
    if (this.present(s).capabilities[capability].status !== 'available') return fail('unsupported', `${capability} unavailable`);
    if (s.control.input !== 'available') return fail('control_conflict');
    for (const block of request.blocks) if (block.type === 'artifact' && !this.store.stagedArtifact(s.sessionId,block.artifactId,block.contentVersion)) return fail('invalid_request','artifact is not staged for this session');
    if(request.mode==='steer') return this.store.registerSteer(request);
    return this.store.registerOperation(request.context, 'submitInput', request);
  }
  async captureSteer(identity:{source:string;subject:string},sessionId:string) {
    const session=this.store.getSession(sessionId);
    if(this.closed || !this.authorize(identity,session,'submitInput') || this.unavailableProviders.has(session.native.provider) || this.store.isDetached(sessionId) || this.store.recoveryQuarantined(sessionId))return fail('unauthorized');
    if(session.native.provider!=='codex' || session.control.input!=='available' || this.present(session).capabilities.steer.status!=='available')return fail('unsupported','steer unavailable');
    const turns=this.store.listTurns(sessionId).filter(t=>t.status==='running');
    if(turns.length!==1)return fail('busy','one running turn is required');
    return {turnId:turns[0]!.turnId,connectionGeneration:this.store.connectionGeneration(sessionId),controlGeneration:session.control.generation};
  }
  async resolveInteraction(request: ResolveInteraction) { this.check(request.context, 'resolveInteraction'); return this.store.resolveInteraction(request); }
  async inspectTurnResidual(sessionId:string,turnId:string) {const s=this.store.getSession(sessionId);const turn=this.store.listTurns(sessionId).find(t=>t.turnId===turnId);if(!turn || turn.status!=='interrupted') return {status:'unknown' as const,count:null,observedAt:null,complete:false,reason:'轮次尚未确认中断'};const port=this.port(s);if(!port.inspectTurnResidual) return {status:'unknown' as const,count:null,observedAt:null,complete:false,reason:'此provider未提供可信残留查询'};try {const result=await port.inspectTurnResidual(s.native,turnId); if(!['running','none','unknown'].includes(result.status) || typeof result.complete!=='boolean' || (result.count!==null && (!Number.isSafeInteger(result.count) || result.count<0)) || (result.observedAt!==null && !Number.isFinite(Date.parse(result.observedAt)))) throw Error('invalid residual result'); if(result.status==='unknown' || result.count===null || !result.observedAt) return {status:'unknown' as const,count:null,observedAt:null,complete:false,reason:'查询失败或连接归属不完整'}; if(!result.complete) return result.status==='running' && result.count>0 ? {...result,reason:'至少有已登记任务仍在运行；查询不完整，其他外部作业或后代未确认'} : {status:'unknown' as const,count:null,observedAt:null,complete:false,reason:'查询失败或连接归属不完整'}; if((result.status==='none' && result.count!==0) || (result.status==='running' && result.count===0)) throw Error('invalid residual count');return {...result,reason:result.status==='running'?'目标轮次已登记任务仍在运行；未知外部作业或后代未确认':'未发现目标轮次已登记残留；未知外部作业或后代未确认'};} catch {return {status:'unknown' as const,count:null,observedAt:null,complete:false,reason:'残留查询不可用'};} }
  async interruptTurn(request: { context: WriteContext; payload: { turnId: string } }) { const s = this.check(request.context, 'interruptTurn'); if (s.capabilities.interrupt.status !== 'available') return fail('unsupported'); return this.store.registerOperation(request.context, 'interruptTurn', request.payload); }
  async setNotificationSubscription(request: { context: WriteContext; payload: { enabled: boolean; eventTypes: string[] } }) { this.check(request.context, 'setNotificationSubscription'); if (typeof request.payload.enabled !== 'boolean' || !Array.isArray(request.payload.eventTypes) || !request.payload.eventTypes.every(x => typeof x === 'string' && !!x)) return fail('invalid_request'); return this.store.setNotificationPreference(request.context, request.payload); }
  async detachSession(request: {context:WriteContext; payload:Record<string,never>}): Promise<Operation> { const s = this.check(request.context,'detachSession'); if (!this.mayDetach(s)) return fail('busy','other bindings not confirmed absent'); return this.store.detachTracking(request.context); }
  async stageInputArtifact(request: {context:WriteContext; payload:{name:string; mediaType:string; size:number; contentDigest:string; content:Uint8Array}}): Promise<Operation> { this.check(request.context,'stageInputArtifact'); return this.store.stageArtifact(request.context,request.payload); }
  async updateSessionSettings(request: {context:WriteContext; payload:{model:string|null; preferences:Record<string,string>}}): Promise<Operation> { const s = this.check(request.context,'updateSessionSettings'); if (s.capabilities.config.status !== 'available') return fail('unsupported'); return this.store.registerOperation(request.context,'updateSessionSettings',request.payload); }
  async archiveSession(request: {context:WriteContext; payload:{archived:boolean}}): Promise<Operation> { const s = this.check(request.context,'archiveSession'); if (!this.port(s).archive) return fail('unsupported'); return this.store.registerOperation(request.context,'archiveSession',request.payload); }
  async listProjectFiles(sessionId:string,directory:string,showHidden:boolean) { const s=this.store.getSession(sessionId), p=this.port(s); if(!p.listProjectFiles) return fail('unsupported'); return p.listProjectFiles(s.native,directory,showHidden); }
  async selectProjectFiles(sessionId:string,args:string) { const s=this.store.getSession(sessionId), p=this.port(s); if(!p.selectProjectFiles) return fail('unsupported'); return (await p.selectProjectFiles(s.native,args)).map(a=>({...a,sessionId})); }
  async listArtifacts(sessionId: string, query: ListQuery) { const s = this.store.getSession(sessionId); return page([...this.store.stagedArtifacts(sessionId),...(await this.port(s).listArtifacts(s.native)).map(a=>({...a,sessionId}))],query); }
  async readArtifact(sessionId: string, artifactId: string, contentVersion: string) { const s = this.store.getSession(sessionId); return this.store.stagedArtifact(sessionId,artifactId,contentVersion) ?? await this.port(s).readArtifact(s.native,artifactId,contentVersion); }
  async getConfirmedSettings(sessionId: string) { return this.store.confirmedSettings(sessionId); }
  async listModels(sessionId: string, query: ListQuery) { const s = this.store.getSession(sessionId); return page(await this.port(s).listModels(s.native),query); }
  async health():ReturnType<UnifiedService['health']> { return [{component:'core',status:this.observationFailure || this.store.recoveryQuarantineCount() ? 'degraded' as const : 'healthy' as const,reason:this.observationFailure ?? (this.store.recoveryQuarantineCount() ? 'reconnect and explicitly attach quarantined sessions' : null),backlog:this.store.pendingOutbox().length,lastDeliveryAt:null,updatedAt:new Date().toISOString()}]; }
  /** Dispatch one persisted item; unknown/in-flight work is never automatically resent. */
  async dispatch(id: string): Promise<Operation> {
    const pending = this.store.getOutbox(id);
    return this.serial(pending.context.targetId, async () => {
      const owner = randomUUID(); const generation = this.store.acquireDispatchLease(pending.context.targetId, owner, Date.now(), 30000); if (generation === null) return fail('busy', 'another dispatcher owns this session');
      try {
      if (pending.kind === 'createSession') {
        const data = pending.payload as {provider: Provider; project: string; model: string | null}; if(this.unavailableProviders.has(data.provider)) return fail('temporarily_unavailable','provider unavailable');
        if (!this.store.claimCreate(id)) return this.store.getOperation(id);
        try {
          const port = this.providers.get(data.provider); if (!port) throw contractError('temporarily_unavailable');
          const ack = await port.create(data.project,data.model);
          if (ack.nativeReference) {
            if (ack.createdSession) { const created = ack.createdSession; if (created.native.provider !== data.provider || created.native.nativeSessionId !== ack.nativeReference || !created.native.hostId || !created.native.serviceId || !Number.isSafeInteger(ack.connectionGeneration) || ack.connectionGeneration! < 0) throw contractError('outcome_unknown'); return this.store.completeCreate(id,{...created,sessionId:sessionIdFor(created.native)},ack.connectionGeneration); }
            let cursor: string | null = null; const seen = new Set<string>(); const matches: Session[] = [];
            do { const result = await port.list(cursor,100); matches.push(...result.items.filter(s => s.native.provider === data.provider && s.native.nativeSessionId === ack.nativeReference)); cursor = result.nextCursor; if (cursor !== null) { if (seen.has(cursor) || seen.size >= 1000) throw contractError('outcome_unknown'); seen.add(cursor); } } while (cursor !== null);
            if (matches.length === 1 && (matches[0]!.control.input !== 'available' || (Number.isSafeInteger(ack.connectionGeneration) && ack.connectionGeneration! >= 0))) return this.store.completeCreate(id,{...matches[0]!,sessionId:sessionIdFor(matches[0]!.native)},ack.connectionGeneration ?? 0);
          }
        } catch { /* Result cannot safely be distinguished from a lost receipt. */ }
        return this.store.markDeliveryUnknown(id);
      }
      const out = this.store.getOutbox(id);
      if (out.state !== 'pending') return this.store.getOperation(id);
      const session = this.check(out.context, out.kind);
      if(out.kind==='submitInput' && (out.payload as SubmitInput).mode==='steer') {const scope=(out.payload as SubmitInput).channelScope;if(scope && !this.validateSteerScope?.(scope,session.sessionId))return this.store.reconcileOperation(id,'failed',contractError('control_conflict','binding changed'));}
      const earlier = out.kind === 'submitInput' ? this.store.pendingOutbox().find(other => { const candidate = this.store.getOutbox(other); return candidate.context.targetId === session.sessionId && candidate.kind === 'submitInput'; }) : id;
      if (earlier !== id) return fail('busy', 'earlier input awaits dispatch');
      if (out.kind === 'submitInput') { const barrier=this.store.settingsBarrier(session.sessionId); if(barrier) return fail(barrier === 'unknown' ? 'outcome_unknown' : 'busy','settings must be reconciled before input'); }
      if (out.kind === 'submitInput' && (out.payload as SubmitInput).mode === 'queue' && (!['idle','failed','interrupted'].includes(session.status) || this.store.listTurns(session.sessionId).some(t=>t.status==='running'||t.status==='queued') || this.store.snapshot(session.sessionId).value.interactions.some(i=>i.status==='awaiting_answer'||i.status==='answer_pending_delivery') || this.store.hasUnsettledInput(session.sessionId,id))) return this.store.getOperation(id);
      if(out.kind==='submitInput' && (out.payload as SubmitInput).mode==='steer') {const input=out.payload as SubmitInput,turns=this.store.listTurns(session.sessionId).filter(t=>t.status==='running');if(turns.length!==1 || turns[0]?.turnId!==input.requiredTurnId || this.store.connectionGeneration(session.sessionId)!==input.expectedConnectionGeneration)return this.store.reconcileOperation(id,'failed',contractError('interaction_expired','captured turn changed'));}
      if (out.kind === 'interruptTurn' && !this.store.listTurns(session.sessionId).some(t=>t.turnId === (out.payload as {turnId:string}).turnId && t.status === 'running')) return this.store.reconcileOperation(id,'failed',contractError('busy','turn is no longer running'));
      if (!this.store.claimOutbox(id)) return this.store.getOperation(id);
      const originalInteraction = out.kind === 'resolveInteraction' ? this.store.getInteraction((out.payload as ResolveInteraction).interactionId) : null;
      let guarded = false;
      const guard: DispatchGuard = {
        expectedControlGeneration: out.context.controlGeneration, expectedConnectionGeneration: out.connectionGeneration,
        assertCurrent: () => {
          if(this.closed) return fail('control_conflict','core closed');
          this.store.assertDispatchLease(session.sessionId, owner, generation);
          const current = this.store.getSession(session.sessionId);
          if (!this.authorize(out.context.identity,current,out.kind) || this.store.isDetached(session.sessionId) || this.store.recoveryQuarantined(session.sessionId)) return fail('unauthorized');
          if (current.control.generation !== out.context.controlGeneration || (out.kind !== 'requestControl' && current.control.input !== 'available')) return fail('control_conflict');
          if (this.store.connectionGeneration(session.sessionId) !== out.connectionGeneration) return fail('interaction_expired');
          if(out.kind==='submitInput' && (out.payload as SubmitInput).mode==='steer') {const scope=(out.payload as SubmitInput).channelScope;if(scope && !this.validateSteerScope?.(scope,session.sessionId))return fail('control_conflict','binding changed');}
          if(out.kind==='submitInput' && (out.payload as SubmitInput).mode==='steer') {const input=out.payload as SubmitInput,turns=this.store.listTurns(session.sessionId).filter(t=>t.status==='running');if(turns.length!==1 || turns[0]?.turnId!==input.requiredTurnId || input.expectedConnectionGeneration!==out.connectionGeneration)return fail('interaction_expired','captured turn changed');}
          if (out.kind === 'submitInput' && (out.payload as SubmitInput).mode === 'queue' && (!['idle','failed','interrupted'].includes(current.status) || this.store.listTurns(session.sessionId).some(t=>t.status==='running'||t.status==='queued') || this.store.snapshot(session.sessionId).value.interactions.some(i=>i.status==='awaiting_answer'||i.status==='answer_pending_delivery') || this.store.hasUnsettledInput(session.sessionId,id))) return fail('busy','session no longer ready for queued input');
          if (out.kind === 'interruptTurn' && !this.store.listTurns(session.sessionId).some(t=>t.turnId === (out.payload as {turnId:string}).turnId && t.status === 'running')) return fail('busy','turn is no longer running');
          if (originalInteraction) {
            const now = this.store.getInteraction(originalInteraction.interactionId);
            if (now.revision !== originalInteraction.revision || now.status !== 'answer_pending_delivery' || now.nativeRequestId !== originalInteraction.nativeRequestId || now.nativeResult !== null || (now.expiresAt !== null && Date.parse(now.expiresAt) <= Date.now())) return fail('interaction_expired');
          }
          guarded = true;
        },
      };
      try {
        const port = this.port(session); let nativeReference: string | null = null;
        if (out.kind === 'submitInput') { const input = out.payload as SubmitInput; const setting = input.mode==='steer'?null:this.store.confirmedSettings(session.sessionId); if(setting){const restored=await port.updateSettings(session.native,{model:setting.model,preferences:setting.preferences},guard);if(restored.settingsApplied!==true) return this.store.markDeliveryUnknown(id);} const blocks: PlatformInputBlock[] = input.blocks.map(block => { if (block.type === 'text') return block; const artifact = this.store.stagedArtifacts(session.sessionId).find(a => a.artifactId === block.artifactId && a.contentVersion === block.contentVersion); const content = this.store.stagedArtifact(session.sessionId,block.artifactId,block.contentVersion); if (!artifact || !content) return fail('invalid_request','staged artifact missing'); return {...block,name:artifact.name,mediaType:artifact.mediaType,content}; }); nativeReference = (await port.input(session.native, input.mode === 'queue' ? 'new' : input.mode, blocks, guard,input.requiredTurnId)).nativeReference; }
        else if (out.kind === 'resolveInteraction') { const req = out.payload as ResolveInteraction; await port.respond(session.native, this.store.getNativeInteraction(req.interactionId), req.answer, guard); }
        else if (out.kind === 'archiveSession') { if (!port.archive) return this.store.reconcileOperation(id,'failed',contractError('unsupported')); await port.archive(session.native,(out.payload as {archived:boolean}).archived,guard); }
        else if (out.kind === 'updateSessionSettings') { const settings=out.payload as {model:string|null;preferences:Record<string,string>}; const receipt=await port.updateSettings(session.native,settings,guard); if (guarded && receipt.settingsApplied === true && this.store.getOutbox(id).state === 'in_flight') return this.store.confirmSettings(id,settings); }
        else if (out.kind === 'requestControl' || out.kind === 'releaseControl') { await port.control(session.native, out.kind === 'requestControl' ? 'acquire' : 'release', guard); }
        else if (out.kind === 'interruptTurn') { await port.interrupt(session.native, (out.payload as { turnId: string }).turnId, guard); }
        else return this.store.reconcileOperation(id, 'failed', contractError('unsupported'));
        // A provider that omits its mandatory fence cannot establish a reliable acknowledgement.
        if (!guarded && this.store.getOutbox(id).state === 'in_flight') return this.store.markDeliveryUnknown(id);
        // An observation or control change can invalidate an in-flight submission.
        if (this.store.getOutbox(id).state !== 'in_flight') return this.store.getOperation(id);
        if(out.kind==='submitInput' && (out.payload as SubmitInput).mode==='steer') {if(nativeReference!==(out.payload as SubmitInput).requiredTurnId)return this.store.markDeliveryUnknown(id);return this.store.completeSteer(id);}
        return this.store.acceptSubmission(id,nativeReference);
      } catch (error) {
        if(!guarded && error instanceof StoreError && out.kind==='submitInput' && (out.payload as SubmitInput).mode==='steer' && ['busy','control_conflict','interaction_expired','unauthorized'].includes(error.detail.code))return this.store.reconcileOperation(id,'failed',error.detail);
        if (!guarded && error && typeof error === 'object' && 'code' in error) { const code=(error as {code:unknown}).code; if (code === 'unsupported' || code === 'invalid_request' || (out.kind==='submitInput' && (out.payload as SubmitInput).mode==='steer' && (code==='busy'||code==='control_conflict'||code==='interaction_expired'||code==='unauthorized'))) return this.store.reconcileOperation(id,'failed',contractError(code)); }
        // The transport may have written before losing its acknowledgement.
        return this.store.markDeliveryUnknown(id);
      }
      } finally { this.store.releaseDispatchLease(pending.context.targetId,owner,generation); }
    });
  }
  async dispatchPending(): Promise<void> { for (const id of this.store.pendingOutbox()) try {await this.dispatch(id);} catch(error) {if(error instanceof StoreError && error.detail.code==='temporarily_unavailable') {this.store.failUnreboundPending([id]);continue;}throw error;} }
  /** Native acknowledgement alone does not establish completion; callers must supply observed evidence. */
  reconcileObserved(id: string, status: 'accepted' | 'completed' | 'failed', error: ReturnType<typeof contractError> | null = null): Operation { return this.store.reconcileOperation(id, status, error); }
  async reconcile(id: string): Promise<Operation> {
    const op=this.store.getOperation(id), link=this.store.operationTurn(id);
    if (op.action !== 'submitInput' || !link || !['accepted','unknown'].includes(op.status)) return op;
    if (typeof this.port(this.store.getSession(link.sessionId)).read !== 'function') return op;
    return this.serial(link.sessionId,async () => {
      const current=this.store.getSession(link.sessionId), context=this.store.getOutbox(id).context;
      if (this.store.isDetached(link.sessionId) || this.store.recoveryQuarantined(link.sessionId) || !this.authorize(context.identity,current,'reconcile') || (this.canDiscover && !this.canDiscover(current))) return fail('unauthorized');
      const generation=this.store.connectionGeneration(link.sessionId), observed=await this.port(current).read(current.native), now=this.store.getSession(link.sessionId);
      if (payloadDigest(observed.session.native)!==payloadDigest(current.native) || observed.session.project!==current.project || payloadDigest(now.native)!==payloadDigest(current.native) || now.project!==current.project || now.revision!==current.revision || this.store.connectionGeneration(link.sessionId)!==generation || this.store.isDetached(link.sessionId) || this.store.recoveryQuarantined(link.sessionId) || !this.authorize(context.identity,now,'reconcile') || (this.canDiscover && !this.canDiscover(now))) return fail('unauthorized','reconcile metadata or authorization changed');
      if (observed.connectionGeneration !== undefined && (observed.connectionGeneration < generation || (current.control.input === 'available' && observed.connectionGeneration !== generation))) return fail('control_conflict','reconcile connection changed');
      if ((observed.turns ?? []).some(t=>t.sessionId!==current.native.nativeSessionId)) return fail('invalid_request','snapshot turn namespace mismatch');
      for (const turn of observed.turns ?? []) if (turn.turnId===link.turnId) this.store.putTurn({...turn,sessionId:link.sessionId});
      return this.store.getOperation(id);
    });
  }
  /** Apply only normalized observations. Existing native/session mappings must already be established. */
  async observe(observation: PlatformObservation): Promise<void> {
    if(this.closed)return;
    const mapped = this.store.findSession(observation.ref); if (!mapped || this.store.isDetached(mapped.sessionId)) return fail('invalid_request', 'observation native session is not attached');
    if(this.store.recoveryQuarantined(mapped.sessionId)) return;
    if (observation.type !== 'connection') {
      const object = observation.type === 'session' ? observation.session : observation.type === 'turn' ? observation.turn : observation.type === 'message' ? observation.message : observation.type === 'interaction' ? observation.interaction : observation.event;
      if (object.sessionId !== observation.ref.nativeSessionId && object.sessionId !== mapped.sessionId) return fail('invalid_request','observation session mismatch');
      if (observation.type === 'session' && (payloadDigest(observation.session.native)!==payloadDigest(observation.ref) || observation.session.project!==mapped.project)) return fail('invalid_request','observation native reference mismatch');
    }
    if (observation.type === 'connection') { const previous = this.store.connectionGeneration(mapped.sessionId); if (!Number.isSafeInteger(observation.connectionGeneration) || observation.connectionGeneration < previous) return fail('control_conflict'); if (observation.connectionGeneration > previous) this.store.setConnectionGeneration(mapped.sessionId,previous,observation.connectionGeneration); return; }
    if (observation.type === 'message') {
      const m: Message = {...observation.message, sessionId:mapped.sessionId}; const generation=observation.connectionGeneration; if(generation!==undefined && generation!==this.store.connectionGeneration(mapped.sessionId)) return; const snapshot = this.store.snapshot(m.sessionId); const prior = snapshot.value.messages.find(x => x.messageId === m.messageId);
      const key=JSON.stringify([mapped.sessionId,generation,m.messageId]); const seen=this.messageObservations.get(key); if((seen!==undefined && m.revision<=seen) || (generation===undefined && prior && m.revision<=prior.revision) || (prior?.final && !m.final)) return; this.messageObservations.set(key,m.revision); if(prior && payloadDigest({...m,sequence:prior.sequence,revision:prior.revision})===payloadDigest(prior)) return;
      this.store.putMessage(prior ? {...m,sequence:prior.sequence,revision:prior.revision+1} : {...m,sequence:Math.max(0,...snapshot.value.messages.map(x=>x.sequence))+1}, prior?.revision ?? null); this.onAcceptedObservation?.(observation); return;
    }
    if (observation.type === 'interaction') {
      {
        if (this.store.isDetached(mapped.sessionId) || this.store.recoveryQuarantined(mapped.sessionId)) return;
        const i: Interaction = {...observation.interaction, sessionId:mapped.sessionId}; const connection = this.store.connectionGeneration(mapped.sessionId); if (i.connectionGeneration > connection) this.store.setConnectionGeneration(mapped.sessionId,connection,i.connectionGeneration); if (i.connectionGeneration < connection) return fail('interaction_expired'); const snapshot = this.store.snapshot(i.sessionId); const prior = snapshot.value.interactions.find(x => x.interactionId === i.interactionId);
        if (!prior) this.store.insertInteraction(i,observation.interaction);
        else if (i.status === 'expired' || i.status === 'cancelled') this.store.expireNativeInteraction(i.interactionId,i.connectionGeneration,i.nativeRequestId,i.status,i.nativeResult);
        else if (i.nativeResult) this.store.recordNativeResult(i.interactionId, i.connectionGeneration, i.nativeRequestId, i.nativeResult, i.status === 'resolved');
        this.store.observeInteractionStatus(i.sessionId,i.turnId); const persisted=this.store.getInteraction(i.interactionId); if(persisted.status===i.status && (!prior || payloadDigest(prior)!==payloadDigest(persisted))) this.onAcceptedObservation?.({...observation,interaction:persisted});
      } return;
    }
    if (observation.type === 'event') {
      if(observation.connectionGeneration!==undefined && observation.connectionGeneration!==this.store.connectionGeneration(mapped.sessionId))return;
      const { schemaVersion: _v, sequence: _s, cursor: _c, ...event } = observation.event; const data = event.type === 'artifact.available' && event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? {...event.data,sessionId:mapped.sessionId} : event.data; const before=this.store.snapshot(mapped.sessionId).cursor; this.store.appendEvent({...event,sessionId:mapped.sessionId,data}); if(this.store.snapshot(mapped.sessionId).cursor!==before) this.onAcceptedObservation?.(observation); return;
    }
    if (observation.type === 'session') {
      const next = {...observation.session, sessionId:mapped.sessionId, native:mapped.native};
      await this.serial(next.sessionId, async () => { const owner = randomUUID(); const generation = this.store.acquireDispatchLease(next.sessionId,owner,Date.now(),30000); if (generation === null) return fail('busy','control observation needs replay'); try { if(this.store.recoveryQuarantined(next.sessionId)) return; const current = this.store.getSession(next.sessionId); if (next.control.generation < current.control.generation) return fail('control_conflict'); const normalized = {...next, revision:current.revision}; if (JSON.stringify(normalized) !== JSON.stringify(current)) this.store.updateSession({...normalized,revision:current.revision+1},current.revision,current.control.generation); } finally { this.store.releaseDispatchLease(next.sessionId,owner,generation); } });
    }
    if (observation.type === 'turn') await this.serial(mapped.sessionId,async () => { if (this.closed || this.store.isDetached(mapped.sessionId) || this.store.recoveryQuarantined(mapped.sessionId) || (observation.connectionGeneration!==undefined && observation.connectionGeneration!==this.store.connectionGeneration(mapped.sessionId))) return; const before=this.store.listTurns(mapped.sessionId).find(t=>t.turnId===observation.turn.turnId); this.store.observeTurn({...observation.turn,sessionId:mapped.sessionId}); const persisted=this.store.listTurns(mapped.sessionId).find(t=>t.turnId===observation.turn.turnId); if(persisted?.status===observation.turn.status && (!before || payloadDigest(before)!==payloadDigest(persisted))) this.onAcceptedObservation?.(observation); });
  }
}
