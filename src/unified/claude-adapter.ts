import { randomUUID } from 'node:crypto';
import { query, listSessions, getSessionMessages, type Query, type Options, type SDKUserMessage, type CanUseTool, type SDKSessionInfo, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { InputQueue } from '../claude/runner.js';
import { imageMediaType } from '../image-media.js';
import type { DispatchGuard, PlatformAcknowledgement, PlatformObservation, PlatformPort, PlatformInputBlock } from './adapter.js';
import { payloadDigest, type Answer, type Artifact, type Capabilities, type Interaction, type Message, type NativeSessionRef, type Session, type SessionSnapshot, type Turn } from './contracts.js';
import { contractError } from './errors.js';
import { ClaudeState } from './claude-state.js';
import { ClaudeResidualObservation } from './claude-residual.js';

type SDK = { query: typeof query; listSessions: typeof listSessions; getSessionMessages: typeof getSessionMessages };
type Pending = { interaction: Interaction; input: Record<string, unknown>; toolId: string; settle: (result: Awaited<ReturnType<CanUseTool>>) => void };
type Live = { completion?: Promise<void>; id: string; cwd: string; model: string | null; turnModel: string | null; effortOverride: boolean; generation: number; queue: InputQueue<SDKUserMessage>; query: Query; turn: string | null; interrupted: boolean; messages: Message[]; pending: Map<string, Pending>; stream: {id:string; blocks:Map<number,string>; sequence:number; revision:number; current:number|null; stopped:boolean} | null; residual:ClaudeResidualObservation };
const retryErrors = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'rate_limit', 'overloaded', 'invalid_request', 'model_not_found', 'server_error', 'unknown', 'max_output_tokens', 'cloud_credential_error']);
const limitTypes = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage']);
const safeNumber = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const ack = (nativeReference: string | null = null): PlatformAcknowledgement => ({ status: 'submitted', nativeReference });
const available = { status: 'available' as const };
const unsupported = { status: 'unsupported' as const, reason: 'Claude SDK port does not support this capability' };
const liveCaps: Capabilities = { view: available, send: available, queue: unsupported, steer: unsupported, answer: available, approve: available, interrupt: available, handoff: unsupported, files: unsupported, config: available };
const readCaps: Capabilities = { ...liveCaps, send: unsupported, answer: unsupported, approve: unsupported, interrupt: unsupported, handoff: unsupported, config: unsupported };

/** SDK sessions created by this instance are interactive; discovered external sessions are read-only. */
export class ClaudeAdapter implements PlatformPort {
  readonly provider = 'claude' as const;
  private readonly lives = new Map<string, Live>();
  private readonly known = new Map<string, SDKSessionInfo>();
  private readonly owned: ClaudeState;
  private readonly listeners = new Set<(o: PlatformObservation) => void>();
  private readonly recent = new Map<string,{offset:number;buffer:Session[];done:boolean;watermark:number;expires:number}>();
  private readonly metadataPending=new Map<string,Promise<unknown>>();
  private sequence = 0;
  private closed = false;
  constructor(readonly hostId: string, readonly serviceId: string, stateDir: string, private readonly sdk: SDK = { query, listSessions, getSessionMessages }, private readonly claudeBin: string = process.env.CLAUDE_BIN?.trim() || 'claude') {
    if (!hostId || !serviceId) throw contractError('invalid_request'); this.owned = new ClaudeState(stateDir, hostId, serviceId);
  }
  private async boundedMetadata<T>(kind:string,call:()=>Promise<T>):Promise<T> {
    if(this.metadataPending.has(kind) || this.metadataPending.size>=32) throw contractError('temporarily_unavailable','previous metadata read still pending');
    const operation=Promise.resolve().then(call);this.metadataPending.set(kind,operation);void operation.finally(()=>{if(this.metadataPending.get(kind)===operation)this.metadataPending.delete(kind);}).catch(()=>{});
    let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(contractError('temporarily_unavailable','metadata read timed out')),2000);})]);}finally{if(timer)clearTimeout(timer);}
  }
  private ref(id: string): NativeSessionRef { return { provider: 'claude', hostId: this.hostId, serviceId: this.serviceId, nativeSessionId: id }; }
  private check(ref: NativeSessionRef): string { if (ref.provider !== 'claude' || ref.hostId !== this.hostId || ref.serviceId !== this.serviceId || !ref.nativeSessionId) throw contractError('invalid_request'); return ref.nativeSessionId; }
  private emit(o: PlatformObservation): void { for (const f of this.listeners) f(o); }
  onObservation(f: (o: PlatformObservation) => void): () => void { this.listeners.add(f); return () => this.listeners.delete(f); }
  private session(info: SDKSessionInfo): Session {
    const live = this.lives.get(info.sessionId); const pending = live && [...live.pending.values()].some(p => p.interaction.status === 'awaiting_answer');
    const timestamp = info.lastModified; const updatedAt = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8.64e15 ? new Date(timestamp).toISOString() : undefined;
    const createdAt=Number.isSafeInteger(info.createdAt) && info.createdAt!>0 && info.createdAt!<=8.64e15 ? new Date(info.createdAt!).toISOString() : undefined;
    return { ...(createdAt ? {createdAt} : {}), ...(updatedAt ? {updatedAt} : {}), sessionId: info.sessionId, native: this.ref(info.sessionId), project: info.cwd ?? '', title: info.customTitle?.trim() || info.summary?.trim() || '', status: live ? pending ? 'waiting_approval' : live.turn ? 'running' : 'idle' : 'read_only', revision: 0, capabilities: live ? liveCaps : readCaps, control: { serviceId: this.serviceId, owner: null, input: live ? 'available' : 'unavailable', generation: 0, operationId: null, reason: live ? null : 'external native session is read-only' } };
  }
  async list(cursor: string | null, limit: number): Promise<{ items: Session[]; nextCursor: string | null }> {
    const offset = cursor === null ? 0 : Number(cursor); if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw contractError('invalid_request');
    const infos = await this.boundedMetadata('list',()=>this.sdk.listSessions({ offset, limit })); for (const i of infos) this.known.set(i.sessionId, i);
    // Newly created SDK sessions may not yet have a transcript.
    const synthetic = offset === 0 ? [...this.lives.values()].filter(l => !this.known.has(l.id)).map(l => ({ sessionId: l.id, cwd: l.cwd, summary: '', lastModified: 0 })) : [];
    return { items: [...synthetic, ...infos].map(i => this.session(i)), nextCursor: infos.length === limit ? String(offset + limit) : null };
  }
  async discoverNewer(watermark:number,cursor:string|null,limit:number):Promise<{items:Session[];nextCursor:string|null;partialFailure?:boolean}> {
    if(!Number.isSafeInteger(watermark)||watermark<0||!Number.isSafeInteger(limit)||limit<1||limit>100) throw contractError('invalid_request');
    for(const [id,state] of this.recent) if(state.expires<Date.now())this.recent.delete(id);
    const id=cursor ?? randomUUID();let state=this.recent.get(id);
    if(!cursor){state={offset:0,buffer:[],done:false,watermark,expires:Date.now()+600000};if(this.recent.size>=4)this.recent.delete(this.recent.keys().next().value!);this.recent.set(id,state);}
    if(!state||state.watermark!==watermark||this.closed)throw contractError('snapshot_required');
    let partialFailure=false;try{state.expires=Date.now()+600000;if(!state.buffer.length&&!state.done){const rows=await this.boundedMetadata('list',()=>this.sdk.listSessions({offset:state!.offset,limit:100,includeProgrammatic:true}));if(!Array.isArray(rows))throw contractError('temporarily_unavailable');state.offset+=rows.length;state.done=rows.length<100;const observed=new Date().toISOString();for(const info of rows){if(!info||typeof info.sessionId!=='string'||!Number.isSafeInteger(info.createdAt)||info.createdAt!<=0||info.createdAt!>8.64e15){partialFailure=true;continue;}if(info.createdAt!<=watermark)continue;try{this.known.set(info.sessionId,info);state.buffer.push({...this.session(info),discoveryObservedAt:observed});}catch{partialFailure=true;}}}const items=state.buffer.splice(0,limit);const nextCursor=state.done&&!state.buffer.length?null:id;if(nextCursor===null)this.recent.delete(id);return {items,nextCursor,...(partialFailure?{partialFailure:true}:{})};}catch(error){this.recent.delete(id);throw error;}
  }
  private async find(id: string): Promise<SDKSessionInfo> { const known = this.known.get(id); if (known) return known; const live = this.lives.get(id); if (live) return { sessionId: id, cwd: live.cwd, summary: '', lastModified: 0 }; const all = await this.boundedMetadata('list',()=>this.sdk.listSessions()); const info = all.find(x => x.sessionId === id); if (!info) throw contractError('temporarily_unavailable', 'session not found'); this.known.set(id, info); return info; }
  private normalize(id: string, m: SessionMessage, seq: number): Message | null {
    if (m.parent_tool_use_id || m.parent_agent_id || (m.type !== 'user' && m.type !== 'assistant')) return null;
    const content = (m.message as { content?: unknown })?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((x: any) => x?.type === 'text' && typeof x.text === 'string').map((x: any) => x.text).join('\n') : '';
    if (!text) return null; return { messageId: m.uuid, sessionId: id, turnId: m.uuid, role: m.type, blocks: [{ type: 'text', text }], sequence: seq, revision: 1, final: true, source: 'claude' };
  }
  async read(ref: NativeSessionRef): Promise<SessionSnapshot> { const id = this.check(ref), info = await this.find(id), live = this.lives.get(id); const history = await this.boundedMetadata(`read:${id}`,()=>this.sdk.getSessionMessages(id, info.cwd ? { dir: info.cwd } : undefined)); const messages:Message[]=[]; for(const [i,raw] of history.entries()) {const m=this.normalize(id,raw,i+1); if(!m) continue; const alias=this.owned.messageAlias(id,raw.uuid); if(alias) m.messageId=alias; const old=messages.find(x=>x.messageId===m.messageId); if(old && alias) {const first=old.blocks[0],next=m.blocks[0];if(first?.type==='text' && next?.type==='text') first.text += '\n'+next.text;} else messages.push(m); } const liveIds=new Set(live?.messages.map(m=>m.messageId) ?? []); const visible=messages.filter(m=>!liveIds.has(m.messageId)); return { session: this.session(info), messages: [...visible, ...(live?.messages ?? [])], interactions: live ? [...live.pending.values()].map(p => p.interaction) : [], ...(live ? {connectionGeneration:live.generation} : {}) }; }
  async create(cwd: string, model: string | null): Promise<PlatformAcknowledgement> { if (!cwd) throw contractError('invalid_request'); const id = randomUUID(); this.start(id, cwd, model, false); try { this.owned.put(id, { origin: 'bridge_sdk' }); } catch (e) { const live = this.lives.get(id); live?.queue.close(); live?.query.close(); throw e; } const live = this.lives.get(id)!; return {status:'submitted',nativeReference:id,createdSession:this.session({sessionId:id,cwd,summary:'',lastModified:0}),connectionGeneration:live.generation}; }
  async resume(ref: NativeSessionRef): Promise<PlatformAcknowledgement> { const id = this.check(ref); if (this.lives.has(id)) { const generation = this.lives.get(id)!.generation; this.emit({type:'connection',ref,connectionGeneration:generation}); return {...ack(id),connectionGeneration:generation}; } const owned = this.owned.get(id); if (!owned) throw contractError('unsupported', 'external native sessions are read-only'); const info = await this.find(id); if (!info.cwd) throw contractError('temporarily_unavailable', 'session working directory unavailable'); this.start(id, info.cwd, null, true); const generation = this.lives.get(id)!.generation; this.emit({type:'connection',ref,connectionGeneration:generation}); return {...ack(id),connectionGeneration:generation}; }
  private start(id: string, cwd: string, model: string | null, resume: boolean): void {
    if (this.closed) throw contractError('temporarily_unavailable', 'adapter closed');
    const queue = new InputQueue<SDKUserMessage>(); const generation = this.owned.nextGeneration();
    const canUseTool: CanUseTool = (tool, input, opts) => new Promise(resolve => {
      const live = this.lives.get(id); if (!live || opts.signal.aborted) { resolve({ behavior: 'deny', message: 'session closed' }); return; }
      const interactionId = randomUUID(), base = { interactionId, sessionId: id, turnId: live.turn ?? '', nativeRequestId: opts.toolUseID, connectionGeneration: generation, revision: 1, status: 'awaiting_answer' as const, expiresAt: null, nativeResult: null };
      let interaction: Interaction;
      if (tool === 'AskUserQuestion' && Array.isArray(input.questions) && input.questions.length) {
        const prompts = input.questions.map((q: any) => q?.question);
        if (prompts.some((q: unknown) => typeof q !== 'string' || !q.trim()) || new Set(prompts).size !== prompts.length) {
          const now = new Date().toISOString(), sequence = ++this.sequence;
          this.emit({ type: 'event', ref: this.ref(id), event: { schemaVersion: 1, eventId: randomUUID(), sessionId: id, objectId: opts.toolUseID, objectRevision: 0, sequence, type: 'interaction.unsupported', occurredAt: now, receivedAt: now, operationId: null, cursor: String(sequence), data: { reason: 'duplicate or invalid question text cannot be represented by Claude answers' } } });
          resolve({ behavior: 'deny', message: 'Unsupported question group: question text must be unique and non-empty' }); return;
        }
        const questions = input.questions.map((q: any, n: number) => ({ id: String(n), prompt: String(q.question ?? ''), choices: Array.isArray(q.options) ? q.options.map((o: any) => String(o.label ?? '')).filter(Boolean) : [], multiple: !!q.multiSelect, allowFreeText: true }));
        interaction = { ...base, kind: 'question_group', toolInputDigest: null, questions };
      } else interaction = { ...base, kind: 'approval', tool, action: JSON.stringify(input), scope: 'this_request', toolInputDigest: payloadDigest(input) };
      const pending: Pending = { interaction, input, toolId: opts.toolUseID, settle: resolve }; live.pending.set(interactionId, pending);
      opts.signal.addEventListener('abort', () => { if (pending.interaction.status === 'resolved' || pending.interaction.status === 'expired') return; pending.interaction = { ...pending.interaction, status: 'expired', revision: pending.interaction.revision + 1 }; this.emit({ type: 'interaction', ref: this.ref(id), interaction: pending.interaction }); resolve({ behavior: 'deny', message: 'request expired' }); }, { once: true });
      this.emit({ type: 'interaction', ref: this.ref(id), interaction });
    });
    const options: Options = { cwd, pathToClaudeCodeExecutable: this.claudeBin, env:{...process.env,FEISHU_CLAUDE_BRIDGE:'1',CLAUDE_CODE_ENTRYPOINT:'sdk-ts'}, ...(resume ? { resume: id } : { sessionId: id as `${string}-${string}-${string}-${string}-${string}` }), settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code' }, permissionMode: 'default', includePartialMessages:true, ...(model ? { model } : {}), canUseTool };
    const q = this.sdk.query({ prompt: queue, options }); const live: Live = { id, cwd, model, turnModel: null, effortOverride: false, generation, queue, query: q, turn: null, interrupted: false, messages: [], pending: new Map(), stream:null, residual:new ClaudeResidualObservation(id) }; this.lives.set(id, live); live.completion = this.consume(live);
  }
  private async consume(live: Live): Promise<void> {
    const ref = this.ref(live.id);
    let streamFailure: {kind:string; exitCode:number|null} | null = null;
    try { for await (const raw of live.query) {
      const m = raw as any;
      if(!this.closed && this.lives.get(live.id)===live)live.residual.observe(m);
      let providerEvent: { type: string; data: Record<string, unknown> } | null = null;
      if (m.type === 'system' && m.subtype === 'api_retry') {
        const status = safeNumber(m.error_status);
        providerEvent = { type: 'provider.api_retry', data: { attempt: safeNumber(m.attempt), maxRetries: safeNumber(m.max_retries), retryDelayMs: safeNumber(m.retry_delay_ms), httpStatus: status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, errorType: retryErrors.has(m.error) ? m.error : 'unknown' } };
      } else if (m.type === 'rate_limit_event' && m.rate_limit_info && typeof m.rate_limit_info === 'object') {
        const info = m.rate_limit_info;
        if (info.status === 'rejected' || info.status === 'allowed_warning' || info.status === 'allowed') {
          providerEvent = { type: info.status === 'allowed' ? 'provider.usage_available' : 'provider.usage_limit', data: { status: info.status, resetsAt: safeNumber(info.resetsAt), rateLimitType: limitTypes.has(info.rateLimitType) ? info.rateLimitType : null, errorCode: info.errorCode === 'credits_required' ? 'credits_required' : null } };
        }
      }
      if (providerEvent && !this.closed && this.lives.get(live.id)===live) { const now = new Date().toISOString(), sequence = ++this.sequence; this.emit({ type: 'event', ref, connectionGeneration:live.generation, event: { schemaVersion: 1, eventId: randomUUID(), sessionId: live.id, objectId: live.turn ?? live.id, objectRevision: 0, sequence, type: providerEvent.type, occurredAt: now, receivedAt: now, operationId: null, cursor: String(sequence), data: providerEvent.data } }); }
      if(m.type==='stream_event' && !m.parent_tool_use_id && !m.parent_agent_id && this.lives.get(live.id)===live) { const event=m.event; if(event?.type==='message_start' && typeof event.message?.id==='string') live.stream={id:event.message.id,blocks:new Map(),sequence:++this.sequence,revision:0,current:null,stopped:false}; const stream=live.stream; if(stream && event?.type==='content_block_start' && event.content_block?.type==='text' && typeof event.index==='number') {stream.blocks.set(event.index,typeof event.content_block.text==='string'?event.content_block.text:'');stream.current=event.index;} if(stream && !stream.stopped && event?.type==='content_block_delta' && event.delta?.type==='text_delta' && typeof event.delta.text==='string' && stream.blocks.has(event.index)) { stream.blocks.set(event.index,stream.blocks.get(event.index)!+event.delta.text); const text=[...stream.blocks.entries()].sort((a,b)=>a[0]-b[0]).map(([,v])=>v).join('\n'); const value:Message={messageId:stream.id,sessionId:live.id,turnId:live.turn ?? stream.id,role:'assistant',blocks:[{type:'text',text}],sequence:stream.sequence,revision:++stream.revision,final:false,source:'claude'}; live.messages=live.messages.filter(x=>x.messageId!==value.messageId); live.messages.push(value); this.emit({type:'message',ref,message:value,connectionGeneration:live.generation}); } if(stream && event?.type==='message_stop' && !stream.stopped) {stream.stopped=true; const text=[...stream.blocks.entries()].sort((a,b)=>a[0]-b[0]).map(([,v])=>v).join('\n'); if(text) {const value:Message={messageId:stream.id,sessionId:live.id,turnId:live.turn ?? stream.id,role:'assistant',blocks:[{type:'text',text}],sequence:stream.sequence,revision:++stream.revision,final:true,source:'claude'};live.messages=live.messages.filter(x=>x.messageId!==value.messageId);live.messages.push(value);this.emit({type:'message',ref,message:value,connectionGeneration:live.generation});} } }
      if (m.type === 'assistant' && !m.parent_tool_use_id && !m.parent_agent_id && this.lives.get(live.id)===live) { const normalized = this.normalize(live.id, { ...m, session_id: live.id, parent_tool_use_id: null, parent_agent_id: null }, ++this.sequence); if (normalized) { const stream=live.stream; if(stream && m.message?.id===stream.id) {if(typeof m.uuid==='string') this.owned.linkMessage(live.id,m.uuid,stream.id,live.generation); const complete=Array.isArray(m.message?.content) ? m.message.content.filter((b:any)=>b?.type==='text' && typeof b.text==='string').map((b:any)=>b.text) as string[] : []; if(stream.stopped && stream.blocks.size>1) { if(complete.length!==stream.blocks.size) continue; [...stream.blocks.keys()].sort((a,b)=>a-b).forEach((key,index)=>stream.blocks.set(key,complete[index]!)); } else if(stream.current!==null) stream.blocks.set(stream.current,(normalized.blocks[0] as {type:'text';text:string}).text);normalized.messageId=stream.id;normalized.sequence=stream.sequence;normalized.revision=++stream.revision;normalized.final=stream.stopped; normalized.blocks=[{type:'text',text:[...stream.blocks.entries()].sort((a,b)=>a[0]-b[0]).map(([,v])=>v).join('\n')}];} normalized.turnId = live.turn ?? normalized.turnId; live.messages=live.messages.filter(x=>x.messageId!==normalized.messageId); live.messages.push(normalized); this.emit({ type: 'message', ref, message: normalized,connectionGeneration:live.generation }); } }
      if (m.type === 'user' && Array.isArray(m.message?.content)) for (const b of m.message.content) if (b.type === 'tool_result') for (const p of live.pending.values()) if (p.toolId === b.tool_use_id && p.interaction.status === 'answer_pending_delivery') { p.interaction = { ...p.interaction, status: 'resolved', revision: p.interaction.revision + 1, nativeResult: { status: 'unknown', source: b.is_error ? 'claude_tool_result_error' : 'claude_tool_result' } }; this.emit({ type: 'interaction', ref, interaction: p.interaction }); }
      if (m.type === 'result' && live.turn && !this.closed && this.lives.get(live.id)===live) { const turn: Turn = { turnId: live.turn, sessionId: live.id, status: live.interrupted ? 'interrupted' : m.subtype === 'success' && !m.is_error ? 'completed' : 'failed', inputId: null, startedAt: null, endedAt: new Date().toISOString(), model: live.turnModel, outputIds: [] }; live.turn = null; live.interrupted = false; this.emit({ type: 'turn', ref, turn,connectionGeneration:live.generation }); }
    } } catch (error) { const exitCode = error && typeof error === 'object' && 'exitCode' in error && Number.isSafeInteger((error as {exitCode:unknown}).exitCode) ? (error as {exitCode:number}).exitCode : null; streamFailure = {kind:'sdk_stream_error',exitCode}; } finally { const current=!this.closed && this.lives.get(live.id)===live;if (this.lives.get(live.id) === live) this.lives.delete(live.id); if (live.turn && current) { const failure = streamFailure ?? {kind:'sdk_stream_closed_without_result',exitCode:null}; const now = new Date().toISOString(); this.emit({type:'event',ref,connectionGeneration:live.generation,event:{schemaVersion:1,eventId:randomUUID(),sessionId:live.id,objectId:live.turn,objectRevision:0,sequence:++this.sequence,type:'adapter.stream_failed',occurredAt:now,receivedAt:now,operationId:null,cursor:String(this.sequence),data:failure}}); this.emit({type:'turn',ref,connectionGeneration:live.generation,turn:{turnId:live.turn,sessionId:live.id,status:'failed',inputId:null,startedAt:null,endedAt:now,model:live.turnModel,outputIds:[]}}); live.turn=null; }  for (const p of live.pending.values()) if (p.interaction.status === 'awaiting_answer' || p.interaction.status === 'answer_pending_delivery') { p.interaction = { ...p.interaction, status: 'expired', revision: p.interaction.revision + 1, nativeResult: p.interaction.status === 'answer_pending_delivery' ? { status: 'unknown', source: 'connection_closed' } : null }; p.settle({ behavior: 'deny', message: 'connection closed' }); this.emit({ type: 'interaction', ref, interaction: p.interaction }); } }
  }
  /** Stop owned SDK queries and settle outstanding requests before detaching observers. */
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    const lives = [...this.lives.values()];
    for (const live of lives) {
      for (const p of live.pending.values()) if (p.interaction.status === 'awaiting_answer' || p.interaction.status === 'answer_pending_delivery') {
        p.interaction = {...p.interaction, status:'expired', revision:p.interaction.revision + 1, nativeResult:p.interaction.status === 'answer_pending_delivery' ? {status:'unknown',source:'connection_closed'} : null};
        p.settle({behavior:'deny', message:'connection closed'}); this.emit({type:'interaction',ref:this.ref(live.id),interaction:p.interaction});
      }
      live.queue.close(); live.query.close();
    }
    await Promise.all(lives.map(live => live.completion)); this.listeners.clear();
  }
  private active(ref: NativeSessionRef, guard: DispatchGuard): Live { const id = this.check(ref), live = this.lives.get(id); if (!live) throw contractError('temporarily_unavailable', 'interactive SDK session is not connected'); if (guard.expectedConnectionGeneration !== null && guard.expectedConnectionGeneration !== live.generation) throw contractError('control_conflict'); return live; }
  async input(ref: NativeSessionRef, mode: 'new' | 'steer', blocks: PlatformInputBlock[], guard: DispatchGuard): Promise<PlatformAcknowledgement> {
    const live = this.active(ref, guard); if (mode !== 'new' || !blocks.length) throw contractError('unsupported'); if (live.turn) throw contractError('busy');
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }> = [];
    for (const block of blocks) { if (block.type === 'text') content.push({ type: 'text', text: block.text }); else { const data = Buffer.from(block.content); const media = imageMediaType(data); if (!media || media !== block.mediaType) throw contractError('unsupported', 'only verified PNG, JPEG, GIF and WebP images are supported'); content.push({ type: 'image', source: { type: 'base64', media_type: media, data: data.toString('base64') } }); } }
    const id = randomUUID(); guard.assertCurrent(); live.residual.beginTurn(id);live.turn = id; live.turnModel = live.model; live.queue.push({ type: 'user', uuid: id, parent_tool_use_id: null, message: { role: 'user', content: content.length === 1 && content[0]!.type === 'text' ? content[0]!.text : content } });
    const message: Message = { messageId: id, sessionId: live.id, turnId: id, role: 'user', blocks: blocks.map(b => b.type === 'text' ? b : { type: 'artifact', artifactId: b.artifactId, contentVersion: b.contentVersion }), sequence: ++this.sequence, revision: 1, final: true, source: 'claude' }; live.messages.push(message); this.emit({ type: 'message', ref, message,connectionGeneration:live.generation }); this.emit({ type: 'turn', ref, connectionGeneration:live.generation, turn: { turnId: id, sessionId: live.id, status: 'running', inputId: id, startedAt: new Date().toISOString(), endedAt: null, model: live.model, outputIds: [] } }); return ack(id);
  }
  async inspectTurnResidual(ref:NativeSessionRef,turnId:string) {const id=this.check(ref);const live=this.lives.get(id);if(this.closed||!live||!this.owned.get(id))return {status:'unknown' as const,count:null,observedAt:null,complete:false,reason:'外部或已断开会话没有当前可信任务观察'};return live.residual.inspect(turnId);}
  async interrupt(ref: NativeSessionRef, turnId: string, guard: DispatchGuard): Promise<PlatformAcknowledgement> { const live = this.active(ref, guard); if (live.turn !== turnId) throw contractError('stale_revision'); guard.assertCurrent(); live.interrupted = true; await live.query.interrupt(); return ack(turnId); }
  async respond(ref: NativeSessionRef, interaction: Interaction, answer: Answer, guard: DispatchGuard): Promise<PlatformAcknowledgement> { const live = this.active(ref, guard), p = live.pending.get(interaction.interactionId), i = p?.interaction; if (!p || !i || i.status !== 'awaiting_answer' || i.connectionGeneration !== interaction.connectionGeneration || i.connectionGeneration !== guard.expectedConnectionGeneration) throw contractError('interaction_expired'); if (i.revision !== interaction.revision || i.toolInputDigest !== interaction.toolInputDigest || i.nativeRequestId !== interaction.nativeRequestId) throw contractError('stale_revision'); let result: Awaited<ReturnType<CanUseTool>>;
    if (i.kind === 'approval' && answer.kind === 'approval' && answer.scope === i.scope) result = answer.decision === 'allow' ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: 'Denied by user' };
    else if (i.kind === 'question_group' && answer.kind === 'question_group' && Object.keys(answer.answers).length === i.questions.length && i.questions.every(q => Array.isArray(answer.answers[q.id]) && answer.answers[q.id]!.length && (q.multiple || answer.answers[q.id]!.length === 1) && answer.answers[q.id]!.every(x => typeof x === 'string' && x.trim()))) { const questions = p.input.questions as Array<{ question: string }>; result = { behavior: 'allow', updatedInput: { ...p.input, answers: Object.fromEntries(i.questions.map((q, n) => [questions[n]!.question, answer.answers[q.id]!.join(', ')])) } }; } else throw contractError('invalid_request');
    guard.assertCurrent(); p.interaction = { ...i, status: 'answer_pending_delivery', revision: i.revision + 1 }; p.settle(result); this.emit({ type: 'interaction', ref, interaction: p.interaction }); return ack(); }
  async listArtifacts(ref: NativeSessionRef): Promise<Artifact[]> { this.check(ref); throw contractError('unsupported'); }
  async readArtifact(ref: NativeSessionRef, _id: string, _version: string): Promise<Uint8Array> { this.check(ref); throw contractError('unsupported'); }
  async listModels(ref: NativeSessionRef): Promise<Array<{ id: string; label: string; reasoningEfforts?: string[] }>> {
    const live = this.lives.get(this.check(ref)); if (!live) throw contractError('unsupported');
    return (await live.query.supportedModels()).map(m => ({ id: m.value, label: m.displayName, ...(m.supportsEffort && m.supportedEffortLevels?.length ? { reasoningEfforts: [...m.supportedEffortLevels] } : {}) }));
  }
  async updateSettings(ref: NativeSessionRef, settings: { model: string | null; preferences: Record<string, string> }, guard: DispatchGuard): Promise<PlatformAcknowledgement> {
    const live = this.active(ref, guard);
    if (Object.keys(settings.preferences).some(k => k !== 'reasoningEffort')) throw contractError('unsupported');
    const effort = settings.preferences.reasoningEffort;
    const models = settings.model !== null ? await live.query.supportedModels() : [];
    const model = models.find(m => m.value === settings.model);
    if (settings.model !== null && !model) throw contractError('invalid_request', 'unknown model');
    if (effort !== undefined && (!model?.supportsEffort || !model.supportedEffortLevels?.includes(effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max'))) throw contractError('invalid_request', 'reasoning effort not in selected model catalog');
    // Empty preferences clear an existing session effort override to the model default.
    // A null model selects the SDK default and cannot validate an explicit effort.
    guard.assertCurrent();
    try {
      await live.query.setModel(settings.model ?? undefined);
      // Do not issue a second native write after control or connection has changed.
      this.active(ref, guard); guard.assertCurrent();
      if (effort !== undefined || live.effortOverride) {
        await live.query.applyFlagSettings({ effortLevel: (effort ?? null) as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null });
        this.active(ref, guard); guard.assertCurrent();
      }
      live.model = settings.model; live.effortOverride = effort !== undefined;
      // The SDK accepts the requested flag; managed policy may limit actual effort.
      return {...ack(), settingsApplied:true};
    } catch {
      // Either native call may have applied before its receipt was lost. Do not confirm.
      throw contractError('outcome_unknown', 'Claude session settings may have partially changed');
    }
  }
  async control(ref: NativeSessionRef, _action: 'acquire' | 'release', _guard: DispatchGuard): Promise<PlatformAcknowledgement> { this.check(ref); throw contractError('unsupported', 'Claude SDK does not provide observable native control handoff'); }
}
