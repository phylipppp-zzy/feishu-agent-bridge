import { codexToolProgress, nativeTimestamp, ToolProgressTracker } from './tool-progress.js';
import {deriveTitleFromInputBlocks} from './session-title.js';
import {textAttachmentBlock} from './text-attachment.js';
import { randomUUID } from 'node:crypto';
import type { DispatchGuard, PlatformAcknowledgement, PlatformObservation, PlatformPort, PlatformInputBlock } from './adapter.js';
import { payloadDigest, type ModelOption, type Answer, type Artifact, type Capabilities, type Interaction, type Message, type NativeSessionRef, type Session, type SessionSnapshot, type Turn, type TurnResidual } from './contracts.js';
import { contractError } from './errors.js';
import { CodexTransport } from './codex-transport.js';
import type { ApprovalScope, GateDecision } from './approval-policy.js';
import { codexApprovalChoices, evaluateCodexApproval } from './codex-approval.js';

type Obj = Record<string, any>;
type ApprovalChoices = ReturnType<typeof codexApprovalChoices>;
type NativeRequest = { id: string | number; generation: number; interaction: Interaction; operationId?: string; approvalChoices?: ApprovalChoices };
type ChangePaths = { paths: string[]; complete: boolean };
type ApprovalTurn = { id: string; generation: number; changes: Map<string, ChangePaths> };
type CodexAdapterOptions = { approvalPolicy?: ApprovalScope; proveSharedFilesystem?: (path: unknown) => Promise<boolean> };
const unavailable = { status: 'temporarily_unavailable' as const, reason: 'control and native arbitration are not verified' };
const unsupported = { status: 'unsupported' as const, reason: 'not implemented by this port' };
const caps: Capabilities = { view: { status: 'available' }, send: unavailable, queue: unsupported, steer: unavailable, answer: unavailable, approve: unavailable, interrupt: unavailable, handoff: unsupported, files: unsupported, config: unsupported };
const ack = (nativeReference: string | null = null): PlatformAcknowledgement => ({ status: 'submitted', nativeReference });
const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const invalidNative = (): never => { throw contractError('temporarily_unavailable', 'invalid app-server response'); };
function changePaths(changes: unknown): ChangePaths {
  if (!Array.isArray(changes) || !changes.length) return { paths: [], complete: false };
  let complete = changes.length <= 256;
  const paths: string[] = [];
  for (const change of changes.slice(0, 256)) {
    if (!change || typeof change !== 'object') { complete = false; continue; }
    if (!isString(change.path) || Object.keys(change).some(field => !['path', 'kind', 'diff', 'movePath', 'move_path'].includes(field))) complete = false;
    const kind = change.kind;
    if (kind != null && (typeof kind !== 'object' || !['add', 'delete', 'update'].includes(kind.type)
      || Object.keys(kind).some(field => !['type', 'movePath', 'move_path'].includes(field)))) complete = false;
    if (isString(change.path)) paths.push(change.path);
    for (const moved of [change.movePath, change.move_path, kind?.movePath, kind?.move_path]) {
      if (moved == null) continue;
      if (isString(moved)) paths.push(moved);
      else complete = false;
    }
  }
  return { paths, complete };
}
/** Native identifiers in normalized objects are provider-local; core maps and persists them. */
export class CodexAdapter implements PlatformPort {
  readonly provider = 'codex' as const;
  private readonly existingCursors=new Map<string,number>();
  private discovery = new Map<string,{generation:number; loaded:Set<string>; phase:'loaded'|'list'; cursor:string|null; seen:Set<string>; buffer:Session[]; done:boolean; expires:number}>();
  private readonly recentDiscovery=new Map<string,{generation:number;watermark:number;cursor:string|null;seenCursors:Set<string>;seenIds:Set<string>;buffer:Session[];done:boolean;expires:number}>();
  private readonly owned = new Set<string>();
  private readonly active = new Set<string>();
  private readonly controlEpoch = new Map<string, number>();
  private readonly awaitingFirstInput = new WeakSet<Obj>();
  private readonly knownSessions = new Map<string, Obj>();
  private requests = new Map<string, NativeRequest>();
  private nativeIndex = new Map<string, string>();
  private readonly approvalTurns = new Map<string, ApprovalTurn>();
  private readonly evaluatingApprovals = new Map<string, { thread: string }>();
  private readonly answeredRequests = new Set<string>();
  private listeners = new Set<(event: PlatformObservation) => void>();
  private messages = new Map<string, Message>();
  private readonly residualTurns=new Map<string,{generation:number;items:Set<string>;version:number;overflow:boolean}>();
  private readonly residualQueries=new Map<string,Promise<TurnResidual>>();
  private sequence = 0;
  private readonly toolProgress = new ToolProgressTracker();
  private settings = new Map<string, {model:string|null; effort?:string}>();
  constructor(readonly transport: CodexTransport, readonly hostId: string, readonly serviceId: string,
    private readonly options: CodexAdapterOptions = {}) {
    if (!isString(hostId) || !isString(serviceId)) throw contractError('invalid_request');
    transport.onMessage = (message, generation) => this.receive(message as Obj, generation);
    transport.onDisconnect = generation => {
      this.approvalTurns.clear();
      this.toolProgress.clear();
      this.evaluatingApprovals.clear();
      this.answeredRequests.clear();
      this.nativeIndex.clear();
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
  hasActiveNativeSession(ref: NativeSessionRef): boolean {
    return ref.provider === this.provider && ref.hostId === this.hostId && ref.serviceId === this.serviceId
      && this.transport.connected && this.active.has(ref.nativeSessionId);
  }
  onObservation(listener: (event: PlatformObservation) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: PlatformObservation): void { for (const fn of this.listeners) fn(event); }
  private emitInteraction(interaction: Interaction): void { this.emit({ type: 'interaction', interaction, ref: this.ref(interaction.sessionId) } as PlatformObservation); }
  private key(generation: number, id: string | number): string { return `${generation}:${typeof id}:${id}`; }
  private session(t: Obj): Session {
    if (!t || typeof t !== 'object' || !isString(t.id) || typeof t.cwd !== 'string' || !t.status || typeof t.status.type !== 'string') return invalidNative();
    const threadStates: Record<string, Session['status']> = {idle: 'idle', active: 'running', systemError: 'failed', interrupted: 'interrupted'};
    const status = threadStates[t.status.type] ?? 'unreachable';
    const active = this.active.has(t.id) && this.transport.connected; const available = {status:'available' as const}; const liveCaps: Capabilities = {...caps,send:available,queue:available,answer:available,approve:available,interrupt:available,handoff:available,config:available};
    const timestamp = t.updatedAt; const updatedAt = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8.64e12 ? new Date(timestamp * 1000).toISOString() : undefined; const ct=t.createdAt; const createdAt=Number.isSafeInteger(ct) && ct>0 && ct<=8.64e12 && ['cli','vscode','appServer'].includes(t.source) && t.parentThreadId==null ? new Date(ct*1000).toISOString() : undefined;
    const title = (isString(t.name) && t.name.trim()) || this.knownSessions.get(t.id)?.name || t.preview;
    return { ...(createdAt ? {createdAt} : {}), ...(updatedAt ? {updatedAt} : {}), sessionId: t.id, native: this.ref(t.id), project: t.cwd, title: typeof title === 'string' ? title : '', status: active ? status : 'read_only', revision: 0, capabilities: active ? liveCaps : this.owned.has(t.id) && this.transport.connected ? {...caps,handoff:available} : caps, control: { serviceId: this.serviceId, owner: active ? this.serviceId : null, input: active ? 'available' : 'unavailable', generation: this.controlEpoch.get(t.id) ?? 0, operationId: null, reason: active ? null : 'session not held by this adapter connection' } };
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
    return {turnId:native.id,sessionId:thread,status:native.status === 'inProgress' ? 'running' : native.status,inputId:null,startedAt:nativeTimestamp(native.startedAtMs,'ms') ?? nativeTimestamp(native.startedAt ?? native.started_at),endedAt:nativeTimestamp(native.endedAtMs ?? native.completedAtMs,'ms') ?? nativeTimestamp(native.endedAt ?? native.completedAt ?? native.ended_at),model:null,outputIds:[]};
  }
  private trackApprovalTurn(thread: string, id: string, generation: number): void {
    const turn = this.approvalTurns.get(thread);
    if (turn?.id === id && turn.generation === generation) return;
    this.approvalTurns.set(thread, { id, generation, changes: new Map() });
  }
  private async evaluateNativeApproval(thread: string, rpcId: string | number, method: string, p: Obj, generation: number): Promise<void> {
    const turn = this.approvalTurns.get(thread);
    const key = this.key(generation, rpcId);
    if (!turn || turn.id !== p.turnId || turn.generation !== generation || !this.active.has(thread)
      || this.evaluatingApprovals.has(key) || this.nativeIndex.has(key) || this.answeredRequests.has(key)) return;
    const work = { thread };
    this.evaluatingApprovals.set(key, work);
    const command = method === 'item/commandExecution/requestApproval';
    const nativeInfo = this.knownSessions.get(thread);
    const nativeProject: unknown = nativeInfo?.cwd;
    const nativePath: unknown = nativeInfo?.path;
    const project = isString(nativeProject) ? nativeProject : undefined;
    const cwd = typeof p.cwd === 'string' ? p.cwd : project;
    const requestedPaths = p.changes === undefined ? undefined : changePaths(p.changes);
    const observedPaths = isString(p.itemId) ? turn.changes.get(p.itemId) : undefined;
    const paths = [...new Set([...(requestedPaths?.paths ?? []), ...(observedPaths?.paths ?? [])])];
    const completePaths = requestedPaths?.complete !== false && observedPaths?.complete !== false && paths.length <= 256;
    try {
      const bridgeApprovalEnabled = this.options.approvalPolicy?.enabled !== false;
      let decision: GateDecision;
      if (!bridgeApprovalEnabled) {
        decision = { kind: 'ask', reason: typeof p.reason === 'string' ? p.reason.trim() : '' };
      } else {
        decision = await evaluateCodexApproval(command, p, paths.slice(0,256), {
          ...this.options.approvalPolicy, ...(project ? { project } : {}), ...(cwd !== undefined ? { cwd } : {}),
        }, completePaths);
        if (decision.kind === 'allow_once' && this.options.proveSharedFilesystem
          && (!await this.options.proveSharedFilesystem(nativePath) || this.knownSessions.get(thread)?.path !== nativePath)) {
          decision = { kind: 'ask', reason: '无法确认 Codex 线程与服务共享本机文件系统，需人工审批' };
        }
      }
      if (!this.transport.connected || this.transport.generation !== generation || !this.active.has(thread)
        || this.approvalTurns.get(thread) !== turn || this.evaluatingApprovals.get(key) !== work) return;
      const choices = codexApprovalChoices(p.availableDecisions);
      const automatic = decision.kind === 'allow_once' ? choices.allow : decision.kind === 'deny' ? choices.deny : undefined;
      if (automatic) {
        this.answeredRequests.add(key);
        this.transport.respond(rpcId, { decision: automatic });
      } else if (decision.kind === 'ask' || decision.kind === 'deny') {
        const id = randomUUID();
        const approvalChoices = { ...choices, allow: decision.kind === 'deny' ? undefined : choices.allow };
        const allowedDecisions = (['allow', 'deny'] as const).filter(choice => approvalChoices[choice]);
        const details = paths.length ? { ...p, paths } : p;
        const blocked = decision.kind === 'deny' ? '\n原端未提供可用的拒绝选项，请在原端处理。' : '';
        const reasonHeader = `${decision.reason}${blocked}`;
        const interaction: Interaction = {
          interactionId: id, sessionId: thread, turnId: turn.id, nativeRequestId: id, connectionGeneration: generation,
          revision: 1, status: 'awaiting_answer', expiresAt: null, nativeResult: null, kind: 'approval',
          tool: command ? 'command' : 'file_change',
          action: reasonHeader ? `${reasonHeader}\n${JSON.stringify(details)}` : JSON.stringify(details),
          scope: 'this_request', toolInputDigest: payloadDigest(details),
          ...(allowedDecisions.length < 2 ? { allowedDecisions } : {}),
        };
        this.requests.set(id, { id: rpcId, generation, interaction, approvalChoices });
        this.nativeIndex.set(key, id);
        this.emitInteraction(interaction);
      }
    } finally {
      if (this.evaluatingApprovals.get(key) === work) this.evaluatingApprovals.delete(key);
    }
  }
  private receive(m: Obj, generation: number): void {
    const p = m.params as Obj | undefined; if (!p || typeof p !== 'object') return;
    const thread = typeof p.threadId === 'string' ? p.threadId : undefined;
    if (!thread || generation !== this.transport.generation) return;
    if (m.method === 'serverRequest/resolved' && (typeof p.requestId === 'number' || typeof p.requestId === 'string')) {
      const key = this.key(generation, p.requestId);
      if (this.evaluatingApprovals.get(key)?.thread === thread) {
        this.evaluatingApprovals.delete(key);
        this.answeredRequests.add(key);
      }
      const id = this.nativeIndex.get(key); const req = id && this.requests.get(id);
      if (req && req.interaction.sessionId === thread && req.interaction.status !== 'expired') {
        req.interaction = { ...req.interaction, status: 'resolved', revision: req.interaction.revision + 1, nativeResult: { status: 'accepted', source: 'unknown', answer: null } };
        this.nativeIndex.delete(key); this.answeredRequests.add(key); this.emitInteraction(req.interaction);
      } return;
    }
    if (typeof m.id === 'string' || typeof m.id === 'number') {
      if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
        void this.evaluateNativeApproval(thread, m.id, m.method, p, generation).catch(() => {
          // A closed socket or ambiguous write must never replay a native response.
        });
        return;
      }
      const key = this.key(generation, m.id);
      if (this.nativeIndex.has(key) || this.answeredRequests.has(key)) return;
      const id = randomUUID(), base = { interactionId: id, sessionId: thread, turnId: String(p.turnId ?? ''), nativeRequestId: id, connectionGeneration: generation, revision: 1, status: 'awaiting_answer' as const, expiresAt: null, nativeResult: null };
      let interaction: Interaction;
      if (m.method === 'item/tool/requestUserInput' && Array.isArray(p.questions) && p.questions.length > 0 && p.questions.every((q: Obj) => q && !q.isSecret && isString(q.id) && typeof q.question === 'string') && new Set(p.questions.map((q: Obj) => q.id)).size === p.questions.length) {
        if (!this.active.has(thread)) return;
        interaction = { ...base, kind: 'question_group', toolInputDigest: null, questions: p.questions.map((q: Obj) => ({ id: q.id, prompt: q.question, choices: Array.isArray(q.options) ? q.options.map((o: Obj) => o.label).filter((v: unknown) => typeof v === 'string') : [], multiple: null, allowFreeText: true })) };
      } else {
        const now = new Date().toISOString(), sequence = ++this.sequence;
        this.emit({ type: 'event', ref: this.ref(thread), event: { schemaVersion: 1, eventId: randomUUID(), sessionId: thread, objectId: thread, objectRevision: 0, sequence, type: 'interaction.unsupported', occurredAt: now, receivedAt: now, operationId: null, cursor: String(sequence), data: { reason: 'unsupported native request' } } });
        return;
      }
      const req: NativeRequest = { id: m.id, generation, interaction }; this.requests.set(id, req); this.nativeIndex.set(key, id); this.emitInteraction(interaction); return;
    }
    const info = this.knownSessions.get(thread);
    if (m.method === 'thread/name/updated' && info) {
      const name = p.threadName ?? p.thread_name ?? p.name;
      if (typeof name === 'string' && name.trim() && name !== info.name) {
        info.name = name.trim();
        this.emit({type: 'session', ref: this.ref(thread), session: this.session(info)});
      }
      return;
    }
    if (m.method==='item/agentMessage/delta' && isString(p.turnId) && isString(p.itemId) && typeof p.delta==='string' && this.active.has(thread)) { const prior=this.messages.get(`${thread}\0${p.itemId}`); if(prior?.final) return; const text=(prior?.blocks[0]?.type==='text' ? prior.blocks[0].text : '')+p.delta; const message=this.message(thread,p.turnId,{type:'agentMessage',id:p.itemId,text},false); if(message) this.emit({type:'message',ref:this.ref(thread),message,connectionGeneration:generation}); return; }
    if(m.method==='turn/started' && isString(p.turn?.id) && this.active.has(thread)) {this.trackApprovalTurn(thread,p.turn.id,generation);const key=`${thread}\0${p.turn.id}`;if(this.residualTurns.get(key)?.generation!==generation){if(this.residualTurns.size>=1024) this.residualTurns.delete(this.residualTurns.keys().next().value!);this.residualTurns.set(key,{generation,items:new Set(),version:0,overflow:false});}}
    if ((m.method === 'item/started' || m.method === 'item/completed') && this.active.has(thread) && isString(p.turnId) && p.item) {
      const tool = codexToolProgress(p.item, m.method === 'item/completed', info?.cwd);
      if (tool) {
        const update = this.toolProgress.observe(this.ref(thread), generation, p.turnId, tool.callId, tool.phase, tool.detail);
        if (update) this.emit(update);
      }
    }
    if (m.method === 'item/started' && p.item?.type === 'fileChange' && isString(p.item.id)) {
      const turn = this.approvalTurns.get(thread);
      if (turn && turn.id === p.turnId && turn.generation === generation && turn.changes.size < 1_024) {
        turn.changes.set(p.item.id, changePaths(p.item.changes));
      }
    }
    if((m.method==='item/started' || m.method==='item/completed') && isString(p.turnId) && p.item?.type==='commandExecution' && isString(p.item?.id)) {const tracked=this.residualTurns.get(`${thread}\0${p.turnId}`);if(tracked?.generation===generation && !tracked.items.has(p.item.id)) {if(tracked.items.size>=10000) tracked.overflow=true;else tracked.items.add(p.item.id);tracked.version++;}}
    if ((m.method === 'turn/started' || m.method === 'turn/completed') && isString(p.turn?.id)) {
      const turn = this.turn(thread,p.turn);
      if (m.method === 'turn/completed' && this.approvalTurns.get(thread)?.id === turn.turnId) this.approvalTurns.delete(thread);
      if (info) {
        const threadStates = {running: 'active', failed: 'systemError', interrupted: 'interrupted', completed: 'idle', queued: 'idle'};
        info.status = {type: threadStates[turn.status]};
      }
      this.emit({ type: 'turn', turn, ref: this.ref(thread), connectionGeneration: generation }); return;
    }
    if (m.method === 'item/completed' && isString(p.turnId)) { const message = this.message(thread, p.turnId, p.item, true); if (message) this.emit({ type: 'message', message, ref: this.ref(thread), connectionGeneration:generation } as PlatformObservation); }
  }
  async list(cursor: string | null, limit: number): Promise<{ items: Session[]; nextCursor: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw contractError('invalid_request'); const r = await this.transport.request('thread/list', { cursor, limit }) as Obj;
    if (!Array.isArray(r?.data) || !(r.nextCursor == null || typeof r.nextCursor === 'string')) return invalidNative(); return { items: r.data.map((t: Obj) => this.session(t)), nextCursor: r.nextCursor ?? null };
  }
  candidateGeneration():number|null{return this.transport.connected?this.transport.generation:null;}
  private readonly candidateCursors=new Map<string,{generation:number;seen:Set<string>}>();
  async listCandidateIds(cursor:string|null,limit:number):Promise<{items:string[];nextCursor:string|null;partial?:boolean}>{if(!Number.isSafeInteger(limit)||limit<1||limit>5)throw contractError('invalid_request');const generation=this.transport.generation,state=cursor===null?{generation,seen:new Set<string>()}:this.candidateCursors.get(cursor);if(!state||state.generation!==generation)throw contractError('snapshot_required');const r=await this.transport.request('thread/loaded/list',{cursor,limit}) as Obj;if(!this.transport.connected||this.transport.generation!==generation||!Array.isArray(r?.data)||r.data.length>limit||!(r.nextCursor==null||isString(r.nextCursor)))return invalidNative();if(cursor!==null){this.candidateCursors.delete(cursor);state.seen.add(cursor);}const ids=r.data.filter((x:unknown):x is string=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(x));if(typeof r.nextCursor==='string'){if(!r.nextCursor||state.seen.has(r.nextCursor)||state.seen.size>=1000)throw contractError('snapshot_required');if(this.candidateCursors.size>=128)this.candidateCursors.delete(this.candidateCursors.keys().next().value!);this.candidateCursors.set(r.nextCursor,state);}return {items:ids,nextCursor:r.nextCursor??null,...(ids.length!==r.data.length?{partial:true}:{})};}
  async readCandidateMetadata(id:string):Promise<import('./contracts.js').CandidateMetadata>{if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw contractError('invalid_request');const generation=this.transport.generation,r=await this.transport.request('thread/read',{threadId:id,includeTurns:false}) as Obj;if(!this.transport.connected||this.transport.generation!==generation)throw contractError('snapshot_required');const t=r?.thread;if(!t||t.id!==id||!isString(t.cwd)||!['cli','vscode','appServer'].includes(t.source)||t.parentThreadId!=null)throw contractError('invalid_request');const status=t.status?.type==='active'?'active':t.status?.type==='idle'?'idle':'unknown';return {native:this.ref(id),project:t.cwd,status,historyVerified:false,observedAt:new Date().toISOString(),connectionGeneration:generation};}
  /** Existing thread listing is only a candidate index; it proves no turn activity. */
  async discoverExisting(cursor:string|null,limit:number):Promise<{items:Session[];nextCursor:string|null;partialFailure?:boolean}> {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw contractError('invalid_request');const generation=this.transport.generation;if(cursor!==null && this.existingCursors.get(cursor)!==generation)throw contractError('snapshot_required');
    const r=await this.transport.request('thread/list',{cursor,limit}) as Obj;if(!this.transport.connected||this.transport.generation!==generation || !Array.isArray(r?.data) || !(r.nextCursor==null || typeof r.nextCursor==='string'))return invalidNative();
    if(cursor!==null)this.existingCursors.delete(cursor);if(typeof r.nextCursor==='string'){if(!r.nextCursor || r.nextCursor===cursor)throw contractError('snapshot_required');if(this.existingCursors.size>=1024)this.existingCursors.delete(this.existingCursors.keys().next().value!);this.existingCursors.set(r.nextCursor,generation);}const items:Session[]=[];let partialFailure=false;for(const raw of r.data)try{if(!raw || !isString(raw.id) || !Number.isSafeInteger(raw.createdAt) || raw.createdAt<=0 || raw.createdAt>8.64e12)throw Error('invalid');if(!['cli','vscode','appServer'].includes(raw.source) || raw.parentThreadId!=null)continue;items.push(this.session(raw));}catch{partialFailure=true;}return {items,nextCursor:r.nextCursor??null,...(partialFailure?{partialFailure:true}:{})};
  }
  /** One native snapshot provides both evidence and message-to-turn boundary. */
  async readAutoActivity(ref:NativeSessionRef,watermark:number,observed:number):Promise<{status:'proven'|'unknown'|'future';snapshot?:SessionSnapshot;oldMessageIds?:string[];newMessageIds?:string[];oldTurns?:Turn[]}> {
    const id=this.check(ref),generation=this.transport.generation;if(!Number.isSafeInteger(watermark)||!Number.isSafeInteger(observed)||watermark>=observed)return {status:'unknown'};
    const r=await this.transport.request('thread/read',{threadId:id,includeTurns:true}) as Obj;if(!this.transport.connected||this.transport.generation!==generation)throw contractError('snapshot_required');const thread=r?.thread;
    if(!thread || thread.id!==id || !['cli','vscode','appServer'].includes(thread.source) || thread.parentThreadId!=null || !Number.isSafeInteger(thread.createdAt) || thread.createdAt>watermark || !Array.isArray(thread.turns) || thread.turns.length>10000)return {status:'unknown'};
    if(thread.turns.some((turn:Obj)=>Number.isSafeInteger(turn?.startedAt)&&turn.startedAt>observed))return {status:'future'};
    const seenTurns=new Set<string>(),seenItems=new Set<string>(),oldTurns=new Set<string>(),newTurns=new Set<string>();let last=0,foundNew=false,total=0;
    for(const turn of thread.turns){if(!turn || !isString(turn.id) || seenTurns.has(turn.id) || !Array.isArray(turn.items) || (turn.itemsView!==undefined && turn.itemsView!=='full') || !Number.isSafeInteger(turn.startedAt) || turn.startedAt<=0)return {status:'unknown'};seenTurns.add(turn.id);if(turn.startedAt>observed)return {status:'future'};if(turn.startedAt===watermark || turn.startedAt<last)return {status:'unknown'};last=turn.startedAt;if(turn.startedAt>watermark){if(turn.status!=='completed')return {status:'unknown'};foundNew=true;newTurns.add(turn.id);}else{if(foundNew || !['completed','failed','interrupted'].includes(turn.status))return {status:'unknown'};oldTurns.add(turn.id);}for(const item of turn.items){if(++total>50000 || !item || !isString(item.id) || seenItems.has(item.id))return {status:'unknown'};seenItems.add(item.id);}}
    if(!foundNew)return {status:'unknown'};const session=this.session(thread),messages:Message[]=[];
    for(const turn of thread.turns)for(const item of turn.items){const message=this.message(id,turn.id,item,true);if(message)messages.push(message);}
    const oldMessageIds=messages.filter(m=>oldTurns.has(m.turnId)).map(m=>m.messageId),newMessageIds=messages.filter(m=>newTurns.has(m.turnId)).map(m=>m.messageId);
    if(!messages.some(m=>newTurns.has(m.turnId)&&m.role==='assistant'&&m.final&&m.blocks.some(b=>b.type==='text'&&b.text.trim())))return {status:'unknown'};
    return {status:'proven',snapshot:{session,messages,turns:thread.turns.filter((turn:Obj)=>newTurns.has(turn.id)).map((turn:Obj)=>this.turn(id,turn)),interactions:[],connectionGeneration:generation},oldMessageIds,newMessageIds,oldTurns:thread.turns.filter((turn:Obj)=>oldTurns.has(turn.id)).map((turn:Obj)=>this.turn(id,turn))};
  }
  /** Incremental bounded scan: loaded IDs are intersected with raw active list entries. */
  async discoverRunning(cursor:string|null, limit:number):Promise<{items:Session[];nextCursor:string|null;partialFailure?:boolean}> {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw contractError('invalid_request');
    for (const [key,value] of this.discovery) if(value.expires<Date.now()) this.discovery.delete(key);
    let key=cursor, state=key ? this.discovery.get(key) : undefined;
    if (!key) { key=randomUUID(); state={generation:this.transport.generation,loaded:new Set(),phase:'loaded',cursor:null,seen:new Set(),buffer:[],done:false,expires:Date.now()+600000}; if(this.discovery.size>=4) this.discovery.delete(this.discovery.keys().next().value!); this.discovery.set(key,state); }
    if (!state || !this.transport.connected || state.generation!==this.transport.generation) { if(key) this.discovery.delete(key); throw contractError('snapshot_required'); }
    let partialFailure=false; try {state.expires=Date.now()+600000;
      if (!state.buffer.length && !state.done) {
        const method=state.phase==='loaded' ? 'thread/loaded/list' : 'thread/list';
        const r=await this.transport.request(method,{cursor:state.cursor,limit:100}) as Obj;
        if (!this.transport.connected || state.generation!==this.transport.generation || !Array.isArray(r?.data) || !(r.nextCursor==null || (typeof r.nextCursor==='string' && r.nextCursor.length>0))) return invalidNative();
        if (state.phase==='loaded') {
          for(const id of r.data) { if(!isString(id)) return invalidNative(); state.loaded.add(id); }
          if(state.loaded.size>10000) throw contractError('snapshot_required');
        } else {
          for(const t of r.data) if(t?.status?.type==='active') {if(!isString(t.id)){partialFailure=true;continue;}if(state.loaded.has(t.id)) try {state.buffer.push(this.session(t));} catch {partialFailure=true;}}
        }
        const next=r.nextCursor ?? null;
        if(next!==null) {if(state.seen.has(next) || state.seen.size>=1000) throw contractError('snapshot_required'); state.seen.add(next); state.cursor=next;}
        else if(state.phase==='loaded') {state.phase='list';state.cursor=null;state.seen.clear();}
        else state.done=true;
      }
      const items=state.buffer.splice(0,limit), nextCursor=state.done && !state.buffer.length ? null : key;
      if(nextCursor===null) this.discovery.delete(key);
      return {items,nextCursor,...(partialFailure?{partialFailure:true}:{})};
    } catch(e) { this.discovery.delete(key); throw e; }
  }
  /** Scan default interactive sources by native created_at; second-precision boundary is excluded. */
  async discoverNewer(watermark:number,cursor:string|null,limit:number):Promise<{items:Session[];nextCursor:string|null;partialFailure?:boolean}> {if(!Number.isSafeInteger(watermark) || watermark<0 || !Number.isSafeInteger(limit) || limit<1 || limit>100) throw contractError('invalid_request'); for(const [key,value] of this.recentDiscovery) if(value.expires<Date.now()) this.recentDiscovery.delete(key); let key=cursor,state=key?this.recentDiscovery.get(key):undefined;if(!key){key=randomUUID();state={generation:this.transport.generation,watermark,cursor:null,seenCursors:new Set(),seenIds:new Set(),buffer:[],done:false,expires:Date.now()+600000};if(this.recentDiscovery.size>=4)this.recentDiscovery.delete(this.recentDiscovery.keys().next().value!);this.recentDiscovery.set(key,state);}if(!state || state.watermark!==watermark || !this.transport.connected || state.generation!==this.transport.generation){if(key)this.recentDiscovery.delete(key);throw contractError('snapshot_required');}let partialFailure=false;try {state.expires=Date.now()+600000;if(!state.buffer.length && !state.done){const r=await this.transport.request('thread/list',{cursor:state.cursor,limit:100,sortKey:'created_at',sortDirection:'desc'}) as Obj;if(!this.transport.connected || state.generation!==this.transport.generation || !Array.isArray(r?.data) || !(r.nextCursor==null || isString(r.nextCursor))) return invalidNative();const now=Math.floor(Date.now()/1000);for(const t of r.data){if(!isString(t?.id) || !Number.isSafeInteger(t?.createdAt)){partialFailure=true;continue;}if(state.seenIds.has(t.id))continue;if(state.seenIds.size>=1024)state.seenIds.delete(state.seenIds.values().next().value!);state.seenIds.add(t.id);if(Number.isSafeInteger(t.createdAt) && t.createdAt>watermark && ['cli','vscode','appServer'].includes(t.source) && t.parentThreadId==null) try {state.buffer.push({...this.session(t),discoveryObservedAt:new Date(now*1000).toISOString()});} catch {partialFailure=true;}}const orderedOld=r.data.length>0 && r.data.every((t:Obj,i:number)=>Number.isSafeInteger(t?.createdAt) && t.createdAt<=watermark && (i===0 || r.data[i-1].createdAt>=t.createdAt));const next=orderedOld?null:r.nextCursor??null;if(next!==null){if(state.seenCursors.has(next))throw contractError('snapshot_required');if(state.seenCursors.size>=10000)state.seenCursors.delete(state.seenCursors.values().next().value!);state.seenCursors.add(next);state.cursor=next;}else state.done=true;}const items=state.buffer.splice(0,limit),nextCursor=state.done && !state.buffer.length?null:key;if(nextCursor===null)this.recentDiscovery.delete(key);return {items,nextCursor,...(partialFailure?{partialFailure:true}:{})};}catch(e){this.recentDiscovery.delete(key);throw e;}}
  async read(ref: NativeSessionRef): Promise<SessionSnapshot> {
    const id = this.check(ref), generation = this.transport.generation;
    const r = await this.transport.request('thread/read', { threadId: id, includeTurns: true }) as Obj; const session = this.session(r?.thread);
    if (session.native.nativeSessionId !== id || !Array.isArray(r.thread.turns)) return invalidNative();
    const info = this.knownSessions.get(id);
    if (info && generation === this.transport.generation && Object.hasOwn(r.thread, 'path')) info.path = r.thread.path;
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
    const currentTurn = Array.isArray(r.thread.turns) ? r.thread.turns.findLast((turn: Obj) => turn?.status === 'inProgress') : undefined;
    if (isString(currentTurn?.id)) this.trackApprovalTurn(id, currentTurn.id, this.transport.generation);
    return {...ack(id),connectionGeneration:this.transport.generation};
  }
  async create(cwd: string, model: string | null): Promise<PlatformAcknowledgement> { const r = await this.transport.request('thread/start', { cwd, model }) as Obj; if (!isString(r?.thread?.id)) return invalidNative(); this.knownSessions.set(r.thread.id,r.thread); this.awaitingFirstInput.add(r.thread); this.owned.add(r.thread.id); this.active.add(r.thread.id); this.controlEpoch.set(r.thread.id,0); return {status:'submitted',nativeReference:r.thread.id,createdSession:this.session(r.thread),connectionGeneration:this.transport.generation}; }
  async input(ref: NativeSessionRef, mode: 'new' | 'steer', blocks: PlatformInputBlock[], guard: DispatchGuard, turnId?: string): Promise<PlatformAcknowledgement> {
    const id = this.check(ref); if (!this.active.has(id) || !this.transport.connected) throw contractError('control_conflict', 'session is not subscribed'); if (!blocks.length) throw contractError('invalid_request');
    const input = blocks.map(b => {
      if (b.type === 'text') { if (!b.text.trim()) throw contractError('invalid_request'); return { type: 'text', text: b.text, text_elements: [] }; }
      if (!(b.content instanceof Uint8Array) || b.content.length === 0 || b.content.length > 10 * 1024 * 1024) throw contractError('invalid_request', 'invalid attachment size');
      const bytes = Buffer.from(b.content);
      if (b.mediaType === 'text/plain') {
        let text:string;try{text=textAttachmentBlock(b.name,bytes,10*1024*1024)}catch{throw contractError('invalid_request','invalid text attachment')}
        return { type:'text',text,text_elements:[] };
      }
      const signature = b.mediaType === 'image/png' ? bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : b.mediaType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : b.mediaType === 'image/gif' ? bytes.length >= 6 && ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()) : b.mediaType === 'image/webp' ? bytes.length >= 12 && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' : null;
      if (signature === null) throw contractError('unsupported', 'unsupported attachment type');
      if (!signature) throw contractError('invalid_request', 'image signature does not match MIME');
      return { type: 'image', url: `data:${b.mediaType};base64,${bytes.toString('base64')}` };
    });
    if (mode === 'steer' && !turnId) throw contractError('invalid_request');
    if (guard.expectedConnectionGeneration !== null && guard.expectedConnectionGeneration !== this.transport.generation) throw contractError('control_conflict');
    const info = this.knownSessions.get(id);
    const previousStatus = info?.status;
    const generation = this.transport.generation;
    guard.assertCurrent(); const response = await this.transport.request(mode === 'new' ? 'turn/start' : 'turn/steer', mode === 'new' ? { threadId: id, input, ...(this.settings.get(id) ?? {}) } : { threadId: id, expectedTurnId: turnId, input });
    const r = response as Obj; const returned=typeof r?.turn?.id === 'string' ? r.turn.id : typeof r?.turnId === 'string' ? r.turnId : null; if(mode==='steer' && returned!==turnId) throw contractError('outcome_unknown','steer acknowledgement did not identify the captured turn');
    if (mode === 'new' && info && returned && r.turn?.status === 'inProgress' && info.status === previousStatus
      && this.active.has(id) && this.transport.generation === generation && this.knownSessions.get(id) === info) {
      this.trackApprovalTurn(id, returned, generation);
      info.status = {type: 'active'};
      this.emit({type:'turn',ref,turn:this.turn(id,r.turn),connectionGeneration:generation});
    }
    if (mode === 'new' && info && this.awaitingFirstInput.delete(info) && this.active.has(id) && this.knownSessions.get(id) === info) {
      const title = this.session(info).title.trim() ? null : deriveTitleFromInputBlocks(blocks);
      if (title) {
        info.name = title;
        // A turn notification can arrive before the start acknowledgement.
        if (info.status === previousStatus) info.status = {type: 'active'};
        this.emit({type: 'session', ref, session: this.session(info)});
      }
    }
    return ack(returned);
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
    else if (i.kind === 'approval' && answer.kind === 'approval' && answer.scope === i.scope && ['allow', 'deny'].includes(answer.decision)) {
      const decision = req.approvalChoices?.[answer.decision];
      if (!decision) throw contractError('invalid_request', 'native request does not offer this decision');
      result = { decision };
    }
    else throw contractError('invalid_request');
    guard.assertCurrent(); req.interaction = { ...i, status: 'answer_pending_delivery', revision: i.revision + 1 };
    this.transport.respond(req.id, result);
    if (guard.operationId) req.operationId = guard.operationId;
    if (req.interaction.status === 'answer_pending_delivery') this.emitInteraction(req.interaction);
    return ack();
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
    this.approvalTurns.delete(id);
    this.active.delete(id); for (const entry of this.requests.values()) if (entry.interaction.sessionId === id && entry.interaction.status !== 'resolved' && entry.interaction.status !== 'expired') { entry.interaction = {...entry.interaction,status:'expired',revision:entry.interaction.revision+1}; this.nativeIndex.delete(this.key(entry.generation,entry.id)); this.emitInteraction(entry.interaction); } this.controlEpoch.set(id,(this.controlEpoch.get(id) ?? 0)+1); const info=this.knownSessions.get(id); if (info) this.emit({type:'session',ref,session:this.session(info)}); return ack(r.status);
  }
  async archive(ref: NativeSessionRef, archived: boolean, guard: DispatchGuard): Promise<PlatformAcknowledgement> {
    const id=this.check(ref); if (!this.active.has(id) || !this.transport.connected) throw contractError('control_conflict');
    if (guard.expectedConnectionGeneration !== null && guard.expectedConnectionGeneration !== this.transport.generation) throw contractError('control_conflict'); guard.assertCurrent();
    await this.transport.request(archived ? 'thread/archive' : 'thread/unarchive', {threadId:id}); return ack(id);
  }
}
