import { randomUUID } from 'node:crypto';
import type { DispatchGuard, PlatformAcknowledgement, PlatformObservation, PlatformPort, PlatformInputBlock } from './adapter.js';
import { payloadDigest, type ModelOption, type Answer, type Artifact, type Capabilities, type Interaction, type Message, type NativeSessionRef, type Session, type SessionSnapshot, type Turn, type TurnResidual } from './contracts.js';
import { contractError } from './errors.js';
import { CodexTransport } from './codex-transport.js';

type Obj = Record<string, any>;
type NativeRequest = { id: string | number; generation: number; interaction: Interaction };
const unavailable = { status: 'temporarily_unavailable' as const, reason: 'control and native arbitration are not verified' };
const unsupported = { status: 'unsupported' as const, reason: 'not implemented by this port' };
const caps: Capabilities = { view: { status: 'available' }, send: unavailable, queue: unsupported, steer: unavailable, answer: unavailable, approve: unavailable, interrupt: unavailable, handoff: unsupported, files: unsupported, config: unsupported };
const ack = (nativeReference: string | null = null): PlatformAcknowledgement => ({ status: 'submitted', nativeReference });
const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const invalidNative = (): never => { throw contractError('temporarily_unavailable', 'invalid app-server response'); };
/** Native identifiers in normalized objects are provider-local; core maps and persists them. */
export class CodexAdapter implements PlatformPort {
  readonly provider = 'codex' as const;
  private discovery = new Map<string,{generation:number; loaded:Set<string>; phase:'loaded'|'list'; cursor:string|null; seen:Set<string>; buffer:Session[]; done:boolean; expires:number}>();
  private readonly owned = new Set<string>();
  private readonly active = new Set<string>();
  private readonly controlEpoch = new Map<string, number>();
  private readonly knownSessions = new Map<string, Obj>();
  private requests = new Map<string, NativeRequest>();
  private nativeIndex = new Map<string, string>();
  private listeners = new Set<(event: PlatformObservation) => void>();
  private messages = new Map<string, Message>();
  private readonly residualTurns=new Map<string,{generation:number;items:Set<string>;version:number;overflow:boolean}>();
  private readonly residualQueries=new Map<string,Promise<TurnResidual>>();
  private sequence = 0;
  private settings = new Map<string, {model:string|null; effort?:string}>();
  constructor(readonly transport: CodexTransport, readonly hostId: string, readonly serviceId: string) {
    if (!isString(hostId) || !isString(serviceId)) throw contractError('invalid_request');
    transport.onMessage = (message, generation) => this.receive(message as Obj, generation);
    transport.onDisconnect = generation => {
      for (const id of this.active) { this.active.delete(id); this.controlEpoch.set(id,(this.controlEpoch.get(id) ?? 0)+1); const info=this.knownSessions.get(id); if(info) this.emit({type:'session',ref:this.ref(id),session:this.session(info)}); }
      for (const entry of this.requests.values()) if (entry.generation === generation && entry.interaction.status !== 'resolved' && entry.interaction.status !== 'expired') {
        entry.interaction = { ...entry.interaction, status: 'expired', revision: entry.interaction.revision + 1 }; this.emitInteraction(entry.interaction);
      }
    };
  }
  seedConnectionGeneration(minimum:number): void { if (this.active.size || this.requests.size) throw contractError('busy','adapter has active native state'); this.transport.seedGeneration(minimum); }
  seedControlGeneration(ref:NativeSessionRef, minimum:number): void { const id=this.check(ref); if (!Number.isSafeInteger(minimum) || minimum < 0 || this.active.has(id) || [...this.requests.values()].some(r=>r.interaction.sessionId===id && r.interaction.status!=='resolved' && r.interaction.status!=='expired')) throw contractError('busy','session has active native state'); this.controlEpoch.set(id,Math.max(minimum,this.controlEpoch.get(id) ?? 0)); }
  private ref(id: string): NativeSessionRef { return { provider: 'codex', hostId: this.hostId, serviceId: this.serviceId, nativeSessionId: id }; }
  private check(ref: NativeSessionRef): string { if (ref.provider !== 'codex' || ref.hostId !== this.hostId || ref.serviceId !== this.serviceId || !isString(ref.nativeSessionId)) throw contractError('invalid_request', 'native session reference mismatch'); return ref.nativeSessionId; }
  onObservation(listener: (event: PlatformObservation) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: PlatformObservation): void { for (const fn of this.listeners) fn(event); }
  private emitInteraction(interaction: Interaction): void { this.emit({ type: 'interaction', interaction, ref: this.ref(interaction.sessionId) } as PlatformObservation); }
  private key(generation: number, id: string | number): string { return `${generation}:${typeof id}:${id}`; }
  private session(t: Obj): Session {
    if (!t || typeof t !== 'object' || !isString(t.id) || typeof t.cwd !== 'string' || !t.status || typeof t.status.type !== 'string') return invalidNative();
    const status = t.status.type === 'idle' ? 'idle' : t.status.type === 'active' ? 'running' : t.status.type === 'systemError' ? 'failed' : 'unreachable';
    const active = this.active.has(t.id) && this.transport.connected; const available = {status:'available' as const}; const liveCaps: Capabilities = {...caps,send:available,queue:available,answer:available,approve:available,interrupt:available,handoff:available,config:available};
    const timestamp = t.updatedAt; const updatedAt = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8.64e12 ? new Date(timestamp * 1000).toISOString() : undefined;
    return { ...(updatedAt ? {updatedAt} : {}), sessionId: t.id, native: this.ref(t.id), project: t.cwd, title: typeof t.name === 'string' && t.name ? t.name : typeof t.preview === 'string' ? t.preview : '', status: active ? status : 'read_only', revision: 0, capabilities: active ? liveCaps : this.owned.has(t.id) && this.transport.connected ? {...caps,handoff:available} : caps, control: { serviceId: this.serviceId, owner: active ? this.serviceId : null, input: active ? 'available' : 'unavailable', generation: this.controlEpoch.get(t.id) ?? 0, operationId: null, reason: active ? null : 'session not held by this adapter connection' } };
  }
  private message(thread: string, turn: string, item: Obj, final: boolean): Message | undefined {
    if (!item || typeof item !== 'object' || !isString(item.id)) return;
    let role: Message['role']; let text: string;
    if (item.type === 'agentMessage' && typeof item.text === 'string') { role = 'assistant'; text = item.text; }
    else if (item.type === 'userMessage' && Array.isArray(item.content) && item.content.every((c: Obj) => c?.type === 'text' && typeof c.text === 'string')) { role = 'user'; text = item.content.map((c: Obj) => c.text).join(''); }
    else return;
    const key = `${thread}\0${item.id}`, old = this.messages.get(key);
    if (old && old.turnId === turn && old.role === role && old.final === final && old.blocks.length === 1 && old.blocks[0]?.type === 'text' && old.blocks[0].text === text) return old;
    const value: Message = { messageId: item.id, sessionId: thread, turnId: turn, role, blocks: [{ type: 'text', text }], sequence: old?.sequence ?? ++this.sequence, revision: (old?.revision ?? 0) + 1, final, source: 'codex' }; this.messages.set(key, value); return value;
  }
  private turn(thread: string, native: Obj): Turn {
    if (!native || !isString(native.id) || !['inProgress','completed','failed','interrupted'].includes(native.status)) return invalidNative();
    return {turnId:native.id,sessionId:thread,status:native.status === 'inProgress' ? 'running' : native.status,inputId:null,startedAt:null,endedAt:null,model:null,outputIds:[]};
  }
  private receive(m: Obj, generation: number): void {
    const p = m.params as Obj | undefined; if (!p || typeof p !== 'object') return;
    const thread = typeof p.threadId === 'string' ? p.threadId : undefined;
    if (m.method === 'serverRequest/resolved' && thread && (typeof p.requestId === 'number' || typeof p.requestId === 'string')) {
      const id = this.nativeIndex.get(this.key(generation, p.requestId)); const req = id && this.requests.get(id);
      if (req && req.interaction.sessionId === thread && req.interaction.status !== 'expired') {
        req.interaction = { ...req.interaction, status: 'resolved', revision: req.interaction.revision + 1, nativeResult: { status: 'accepted', source: 'unknown', answer: null } };
        this.nativeIndex.delete(this.key(generation, p.requestId)); this.emitInteraction(req.interaction);
      } return;
    }
    if (thread && (typeof m.id === 'string' || typeof m.id === 'number')) {
      const id = randomUUID(), base = { interactionId: id, sessionId: thread, turnId: String(p.turnId ?? ''), nativeRequestId: id, connectionGeneration: generation, revision: 1, status: 'awaiting_answer' as const, expiresAt: null, nativeResult: null };
      let interaction: Interaction;
      if (m.method === 'item/tool/requestUserInput' && Array.isArray(p.questions) && p.questions.length > 0 && p.questions.every((q: Obj) => q && !q.isSecret && isString(q.id) && typeof q.question === 'string') && new Set(p.questions.map((q: Obj) => q.id)).size === p.questions.length) {
        interaction = { ...base, kind: 'question_group', toolInputDigest: null, questions: p.questions.map((q: Obj) => ({ id: q.id, prompt: q.question, choices: Array.isArray(q.options) ? q.options.map((o: Obj) => o.label).filter((v: unknown) => typeof v === 'string') : [], multiple: null, allowFreeText: true })) };
      } else if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
        interaction = { ...base, kind: 'approval', tool: m.method === 'item/commandExecution/requestApproval' ? 'command' : 'file_change', action: JSON.stringify(p), scope: 'this_request', toolInputDigest: payloadDigest(p) };
      } else {
        const now = new Date().toISOString(), sequence = ++this.sequence;
        this.emit({ type: 'event', ref: this.ref(thread), event: { schemaVersion: 1, eventId: randomUUID(), sessionId: thread, objectId: thread, objectRevision: 0, sequence, type: 'interaction.unsupported', occurredAt: now, receivedAt: now, operationId: null, cursor: String(sequence), data: { reason: 'unsupported native request' } } });
        return;
      }
      const req: NativeRequest = { id: m.id, generation, interaction }; this.requests.set(id, req); this.nativeIndex.set(this.key(generation, m.id), id); this.emitInteraction(interaction); return;
    }
    if (!thread || generation!==this.transport.generation) return;
    if (m.method==='item/agentMessage/delta' && isString(p.turnId) && isString(p.itemId) && typeof p.delta==='string' && this.active.has(thread)) { const prior=this.messages.get(`${thread}\0${p.itemId}`); if(prior?.final) return; const text=(prior?.blocks[0]?.type==='text' ? prior.blocks[0].text : '')+p.delta; const message=this.message(thread,p.turnId,{type:'agentMessage',id:p.itemId,text},false); if(message) this.emit({type:'message',ref:this.ref(thread),message,connectionGeneration:generation}); return; }
    if(m.method==='turn/started' && isString(p.turn?.id) && this.active.has(thread)) {const key=`${thread}\0${p.turn.id}`;if(this.residualTurns.get(key)?.generation!==generation){if(this.residualTurns.size>=1024) this.residualTurns.delete(this.residualTurns.keys().next().value!);this.residualTurns.set(key,{generation,items:new Set(),version:0,overflow:false});}}
    if((m.method==='item/started' || m.method==='item/completed') && isString(p.turnId) && p.item?.type==='commandExecution' && isString(p.item?.id)) {const tracked=this.residualTurns.get(`${thread}\0${p.turnId}`);if(tracked?.generation===generation && !tracked.items.has(p.item.id)) {if(tracked.items.size>=10000) tracked.overflow=true;else tracked.items.add(p.item.id);tracked.version++;}}
    if ((m.method === 'turn/started' || m.method === 'turn/completed') && isString(p.turn?.id)) {
      const turn = this.turn(thread,p.turn);
      this.emit({ type: 'turn', turn, ref: this.ref(thread) } as PlatformObservation); return;
    }
    if (m.method === 'item/completed' && isString(p.turnId)) { const message = this.message(thread, p.turnId, p.item, true); if (message) this.emit({ type: 'message', message, ref: this.ref(thread), connectionGeneration:generation } as PlatformObservation); }
  }
  async list(cursor: string | null, limit: number): Promise<{ items: Session[]; nextCursor: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw contractError('invalid_request'); const r = await this.transport.request('thread/list', { cursor, limit }) as Obj;
    if (!Array.isArray(r?.data) || !(r.nextCursor == null || typeof r.nextCursor === 'string')) return invalidNative(); return { items: r.data.map((t: Obj) => this.session(t)), nextCursor: r.nextCursor ?? null };
  }
  /** Incremental bounded scan: loaded IDs are intersected with raw active list entries. */
  async discoverRunning(cursor:string|null, limit:number):Promise<{items:Session[];nextCursor:string|null}> {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw contractError('invalid_request');
    for (const [key,value] of this.discovery) if(value.expires<Date.now()) this.discovery.delete(key);
    let key=cursor, state=key ? this.discovery.get(key) : undefined;
    if (!key) { key=randomUUID(); state={generation:this.transport.generation,loaded:new Set(),phase:'loaded',cursor:null,seen:new Set(),buffer:[],done:false,expires:Date.now()+600000}; if(this.discovery.size>=4) this.discovery.delete(this.discovery.keys().next().value!); this.discovery.set(key,state); }
    if (!state || !this.transport.connected || state.generation!==this.transport.generation) { if(key) this.discovery.delete(key); throw contractError('snapshot_required'); }
    try {
      if (!state.buffer.length && !state.done) {
        const method=state.phase==='loaded' ? 'thread/loaded/list' : 'thread/list';
        const r=await this.transport.request(method,{cursor:state.cursor,limit:100}) as Obj;
        if (!this.transport.connected || state.generation!==this.transport.generation || !Array.isArray(r?.data) || !(r.nextCursor==null || (typeof r.nextCursor==='string' && r.nextCursor.length>0))) return invalidNative();
        if (state.phase==='loaded') {
          for(const id of r.data) { if(!isString(id)) return invalidNative(); state.loaded.add(id); }
          if(state.loaded.size>10000) throw contractError('snapshot_required');
        } else {
          for(const t of r.data) if(t?.status?.type==='active' && isString(t.id) && state.loaded.has(t.id)) state.buffer.push(this.session(t));
        }
        const next=r.nextCursor ?? null;
        if(next!==null) {if(state.seen.has(next) || state.seen.size>=1000) throw contractError('snapshot_required'); state.seen.add(next); state.cursor=next;}
        else if(state.phase==='loaded') {state.phase='list';state.cursor=null;state.seen.clear();}
        else state.done=true;
      }
      const items=state.buffer.splice(0,limit), nextCursor=state.done && !state.buffer.length ? null : key;
      if(nextCursor===null) this.discovery.delete(key);
      return {items,nextCursor};
    } catch(e) { this.discovery.delete(key); throw e; }
  }
  async read(ref: NativeSessionRef): Promise<SessionSnapshot> {
    const id = this.check(ref), r = await this.transport.request('thread/read', { threadId: id, includeTurns: true }) as Obj; const session = this.session(r?.thread);
    if (session.native.nativeSessionId !== id || !Array.isArray(r.thread.turns)) return invalidNative();
    const messages: Message[] = []; for (const turn of r.thread.turns) if (isString(turn.id) && Array.isArray(turn.items)) for (const item of turn.items) { const prior=this.messages.get(`${id}\0${item.id}`); const final=item.type!=='agentMessage' || turn.status!=='inProgress' || !!prior?.final; const message = this.message(id, turn.id, item, final); if (message) messages.push(message); }
    const turns = r.thread.turns.map((turn: Obj) => this.turn(id,turn));
    return { session, messages, turns, interactions: [...this.requests.values()].map(x => x.interaction).filter(x => x.sessionId === id), connectionGeneration: this.transport.generation };
  }
  async resume(ref: NativeSessionRef): Promise<PlatformAcknowledgement> {
    const id = this.check(ref);
    if (this.active.has(id)) throw contractError('busy','already subscribed');
    const r = await this.transport.request('thread/resume', { threadId: id }) as Obj;
    if (!r?.thread || r.thread.id !== id) return invalidNative();
    this.knownSessions.set(id,r.thread); this.owned.add(id); this.active.add(id); this.controlEpoch.set(id,(this.controlEpoch.get(id) ?? 0)+1);
    return {...ack(id),connectionGeneration:this.transport.generation};
  }
  async create(cwd: string, model: string | null): Promise<PlatformAcknowledgement> { const r = await this.transport.request('thread/start', { cwd, model }) as Obj; if (!isString(r?.thread?.id)) return invalidNative(); this.knownSessions.set(r.thread.id,r.thread); this.owned.add(r.thread.id); this.active.add(r.thread.id); this.controlEpoch.set(r.thread.id,0); return {status:'submitted',nativeReference:r.thread.id,createdSession:this.session(r.thread),connectionGeneration:this.transport.generation}; }
  async input(ref: NativeSessionRef, mode: 'new' | 'steer', blocks: PlatformInputBlock[], guard: DispatchGuard, turnId?: string): Promise<PlatformAcknowledgement> {
    const id = this.check(ref); if (!this.active.has(id) || !this.transport.connected) throw contractError('control_conflict', 'session is not subscribed'); if (!blocks.length) throw contractError('invalid_request');
    const input = blocks.map(b => {
      if (b.type === 'text') { if (!b.text.trim()) throw contractError('invalid_request'); return { type: 'text', text: b.text, text_elements: [] }; }
      if (!(b.content instanceof Uint8Array) || b.content.length === 0 || b.content.length > 10 * 1024 * 1024) throw contractError('invalid_request', 'invalid attachment size');
      const bytes = Buffer.from(b.content);
      if (b.mediaType === 'text/plain') {
        let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw contractError('invalid_request', 'invalid UTF-8 attachment'); }
        return { type: 'text', text: `File content (${JSON.stringify(b.name)}):\n${text}`, text_elements: [] };
      }
      const signature = b.mediaType === 'image/png' ? bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : b.mediaType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : b.mediaType === 'image/gif' ? bytes.length >= 6 && ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()) : b.mediaType === 'image/webp' ? bytes.length >= 12 && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' : null;
      if (signature === null) throw contractError('unsupported', 'unsupported attachment type');
      if (!signature) throw contractError('invalid_request', 'image signature does not match MIME');
      return { type: 'image', url: `data:${b.mediaType};base64,${bytes.toString('base64')}` };
    });
    if (mode === 'steer' && !turnId) throw contractError('invalid_request');
    if (guard.expectedConnectionGeneration !== null && guard.expectedConnectionGeneration !== this.transport.generation) throw contractError('control_conflict');
    guard.assertCurrent(); const response = await this.transport.request(mode === 'new' ? 'turn/start' : 'turn/steer', mode === 'new' ? { threadId: id, input, ...(this.settings.get(id) ?? {}) } : { threadId: id, expectedTurnId: turnId, input });
    const r = response as Obj; return ack(typeof r?.turn?.id === 'string' ? r.turn.id : typeof r?.turnId === 'string' ? r.turnId : null);
  }
  async inspectTurnResidual(ref:NativeSessionRef,turnId:string):Promise<TurnResidual> {const key=JSON.stringify([ref.provider,ref.hostId,ref.serviceId,ref.nativeSessionId,turnId,this.transport.generation]);let work=this.residualQueries.get(key);if(!work){work=this.inspectTurnResidualOnce(ref,turnId,Date.now()+5000);this.residualQueries.set(key,work);void work.finally(()=>{if(this.residualQueries.get(key)===work)this.residualQueries.delete(key);}).catch(()=>{});}let timer:ReturnType<typeof setTimeout>|undefined;try {return await Promise.race([work,new Promise<TurnResidual>(resolve=>{timer=setTimeout(()=>resolve({status:'unknown',count:null,observedAt:null,complete:false,reason:'残留查询超时'}),5000);})]);}finally{if(timer)clearTimeout(timer);}}
  private async inspectTurnResidualOnce(ref:NativeSessionRef,turnId:string,deadline:number):Promise<TurnResidual> {const id=this.check(ref),tracked=this.residualTurns.get(`${id}\0${turnId}`),generation=this.transport.generation; let observedAt:string|null=null; const matched=new Set<string>();const unknown=(reason:string):TurnResidual=>matched.size && observedAt ? {status:'running',count:matched.size,observedAt,complete:false,reason} : {status:'unknown',count:null,observedAt:null,complete:false,reason}; if(!isString(turnId) || !tracked || tracked.overflow || tracked.generation!==generation || !this.transport.connected) return unknown('缺少当前连接代次的完整轮次归属'); const version=tracked.version; let cursor:string|null=null;const seen=new Set<string>();try {for(let page=0;page<100;page++){if(Date.now()>=deadline)return unknown('残留查询超时');const result=await this.transport.request('thread/backgroundTerminals/list',{threadId:id,cursor,limit:100}) as Obj;if(Date.now()>=deadline)return unknown('残留查询超时');if(this.transport.generation!==generation || !this.transport.connected || this.residualTurns.get(`${id}\0${turnId}`)!==tracked || tracked.version!==version) return unknown('查询期间连接或归属发生变化');if(!Array.isArray(result?.data) || !(result.nextCursor==null || isString(result.nextCursor))) return unknown('残留查询返回格式无效');observedAt=new Date().toISOString();for(const item of result.data){if(!isString(item?.itemId)) return unknown('残留任务缺少身份');if(tracked.items.has(item.itemId))matched.add(item.itemId);}cursor=result.nextCursor??null;if(cursor===null){const count=matched.size;return {status:count?'running':'none',count,observedAt,complete:true,reason:count?'目标轮次已登记任务仍在运行，其他外部作业或后代未确认':'未发现目标轮次已登记残留；未知外部作业或后代未确认'};}if(seen.has(cursor)) return unknown('残留查询分页重复');seen.add(cursor);}return unknown('残留查询超过分页预算');}catch{return unknown('残留查询失败或不可用');} }
  async interrupt(ref: NativeSessionRef, turnId: string, guard: DispatchGuard): Promise<PlatformAcknowledgement> { const id = this.check(ref); if (!this.active.has(id) || !this.transport.connected) throw contractError('control_conflict'); if (!isString(turnId)) throw contractError('invalid_request'); if (guard.expectedConnectionGeneration !== null && guard.expectedConnectionGeneration !== this.transport.generation) throw contractError('control_conflict'); guard.assertCurrent(); await this.transport.request('turn/interrupt', { threadId: id, turnId }); return ack(turnId); }
  async respond(ref: NativeSessionRef, interaction: Interaction, answer: Answer, guard: DispatchGuard): Promise<PlatformAcknowledgement> {
    const id = this.check(ref), req = this.requests.get(interaction.interactionId), i = req?.interaction;
    if (!req || !i || i.sessionId !== id || req.generation !== this.transport.generation || req.generation !== guard.expectedConnectionGeneration || i.status !== 'awaiting_answer') throw contractError('interaction_expired');
    if (!this.active.has(id) || !this.transport.connected) throw contractError('control_conflict');
    if (interaction.nativeRequestId !== i.nativeRequestId || interaction.connectionGeneration !== i.connectionGeneration || interaction.kind !== i.kind || interaction.toolInputDigest !== i.toolInputDigest || interaction.status !== 'awaiting_answer') throw contractError('stale_revision');
    let result: unknown;
    if (i.kind === 'question_group' && answer.kind === 'question_group' && Object.keys(answer.answers).length === i.questions.length && i.questions.every(q => Array.isArray(answer.answers[q.id]) && answer.answers[q.id]!.length > 0 && answer.answers[q.id]!.every(v => typeof v === 'string' && v.trim()) && new Set(answer.answers[q.id]).size === answer.answers[q.id]!.length)) result = { answers: Object.fromEntries(i.questions.map(q => [q.id, { answers: answer.answers[q.id] }])) };
    else if (i.kind === 'approval' && answer.kind === 'approval' && answer.scope === i.scope && ['allow', 'deny'].includes(answer.decision)) result = { decision: answer.decision === 'allow' ? 'accept' : 'decline' };
    else throw contractError('invalid_request');
    guard.assertCurrent(); req.interaction = { ...i, status: 'answer_pending_delivery', revision: i.revision + 1 };
    this.transport.respond(req.id, result); if (req.interaction.status === 'answer_pending_delivery') this.emitInteraction(req.interaction); return ack();
  }
  async listArtifacts(_ref: NativeSessionRef): Promise<Artifact[]> { throw contractError('unsupported'); }
  async readArtifact(_ref: NativeSessionRef, _id: string, _version: string): Promise<Uint8Array> { throw contractError('unsupported'); }
  async listModels(ref: NativeSessionRef): Promise<ModelOption[]> {
    this.check(ref); const result: ModelOption[] = []; let cursor: string | null = null; const seen = new Set<string>();
    do { const r = await this.transport.request('model/list', { cursor, limit: 100 }) as Obj;
      if (!Array.isArray(r?.data) || !(r.nextCursor == null || typeof r.nextCursor === 'string') || !r.data.every((m:Obj) => isString(m.model) && typeof m.displayName === 'string' && (m.supportedReasoningEfforts === undefined || (Array.isArray(m.supportedReasoningEfforts) && m.supportedReasoningEfforts.every((e:Obj) => isString(e?.reasoningEffort)))))) return invalidNative();
      result.push(...r.data.map((m:Obj) => ({id:m.model,label:m.displayName,...(m.supportedReasoningEfforts === undefined ? {} : {reasoningEfforts:m.supportedReasoningEfforts.map((e:Obj) => e.reasoningEffort)})}))); cursor = r.nextCursor ?? null;
      if (cursor !== null && (seen.has(cursor) || seen.size >= 100)) return invalidNative(); if (cursor !== null) seen.add(cursor);
    } while (cursor !== null); return result;
  }
  async updateSettings(ref: NativeSessionRef, settings: { model: string | null; preferences: Record<string, string> }, guard: DispatchGuard): Promise<PlatformAcknowledgement> {
    const id = this.check(ref); if (!this.active.has(id) || !this.transport.connected) throw contractError('control_conflict');
    if (Object.keys(settings.preferences).some(k => k !== 'reasoningEffort') || settings.model === null) throw contractError('unsupported', 'unsupported preference or missing model');
    const model = (await this.listModels(ref)).find(m => m.id === settings.model);
    if (!model) throw contractError('invalid_request', 'model not in catalog');
    const effort = settings.preferences.reasoningEffort;
    if (effort !== undefined && !model.reasoningEfforts?.includes(effort)) throw contractError('invalid_request', 'reasoning effort not in catalog');
    if (guard.expectedConnectionGeneration !== null && guard.expectedConnectionGeneration !== this.transport.generation) throw contractError('control_conflict'); guard.assertCurrent();
    this.settings.set(id, { model: settings.model, ...(effort === undefined ? {} : {effort}) }); return {...ack(id), settingsApplied: true};
  }
  async control(ref: NativeSessionRef, action: 'acquire' | 'release', guard: DispatchGuard): Promise<PlatformAcknowledgement> {
    const id = this.check(ref); if (!this.owned.has(id)) throw contractError('unsupported', 'external ownership not verified');
    if (guard.expectedConnectionGeneration !== null && guard.expectedConnectionGeneration !== this.transport.generation) throw contractError('control_conflict');
    if (action === 'acquire') { if (this.active.has(id)) throw contractError('busy', 'already subscribed'); guard.assertCurrent(); const receipt=await this.resume(ref); const info=this.knownSessions.get(id)!; this.emit({type:'connection',ref,connectionGeneration:this.transport.generation}); this.emit({type:'session',ref,session:this.session(info)}); return receipt; }
    if (!this.active.has(id)) throw contractError('control_conflict', 'not subscribed'); guard.assertCurrent();
    const r = await this.transport.request('thread/unsubscribe', {threadId:id}) as Obj;
    if (!['unsubscribed','notSubscribed','notLoaded'].includes(r?.status)) return invalidNative();
    this.active.delete(id); for (const entry of this.requests.values()) if (entry.interaction.sessionId === id && entry.interaction.status !== 'resolved' && entry.interaction.status !== 'expired') { entry.interaction = {...entry.interaction,status:'expired',revision:entry.interaction.revision+1}; this.nativeIndex.delete(this.key(entry.generation,entry.id)); this.emitInteraction(entry.interaction); } this.controlEpoch.set(id,(this.controlEpoch.get(id) ?? 0)+1); const info=this.knownSessions.get(id); if (info) this.emit({type:'session',ref,session:this.session(info)}); return ack(r.status);
  }
  async archive(ref: NativeSessionRef, archived: boolean, guard: DispatchGuard): Promise<PlatformAcknowledgement> {
    const id=this.check(ref); if (!this.active.has(id) || !this.transport.connected) throw contractError('control_conflict');
    if (guard.expectedConnectionGeneration !== null && guard.expectedConnectionGeneration !== this.transport.generation) throw contractError('control_conflict'); guard.assertCurrent();
    await this.transport.request(archived ? 'thread/archive' : 'thread/unarchive', {threadId:id}); return ack(id);
  }
}
