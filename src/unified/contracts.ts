import { createHash } from 'node:crypto';
import { contractError, type ContractError } from './errors.js';

export const SCHEMA_VERSION = 1 as const;
export type Provider = 'claude' | 'codex';
export type Revision = number;
export type CapabilityName = 'view' | 'send' | 'queue' | 'steer' | 'answer' | 'approve' | 'interrupt' | 'handoff' | 'files' | 'config';
export type Capability = { status: 'available' } | { status: 'unsupported' | 'temporarily_unavailable'; reason: string };
export type Capabilities = Record<CapabilityName, Capability>;
export interface Identity { subject: string; source: string }
/** Identity must be authenticated by the transport, not trusted from client input. */
export interface WriteContext { operationId: string; idempotencyKey: string; targetId: string; expectedRevision: Revision; controlGeneration: number; identity: Identity }
export interface NativeSessionRef { provider: Provider; hostId: string; serviceId: string; nativeSessionId: string }
export type RunStatus = 'idle' | 'running' | 'waiting_question' | 'waiting_approval' | 'interrupted' | 'failed' | 'unreachable' | 'read_only';
export interface ControlState { serviceId: string; owner: string | null; input: 'available' | 'unavailable' | 'unknown'; generation: number; operationId: string | null; reason: string | null }
export interface Session { createdAt?: string; discoveryObservedAt?:string; updatedAt?: string; sessionId: string; native: NativeSessionRef; project: string; title: string; status: RunStatus; revision: Revision; capabilities: Capabilities; control: ControlState }
export interface Turn { turnId: string; sessionId: string; status: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed'; inputId: string | null; startedAt: string | null; endedAt: string | null; model: string | null; outputIds: string[] }
export type ContentBlock = { type: 'text'; text: string } | { type: 'artifact'; artifactId: string; contentVersion: string };
export interface Message { messageId: string; sessionId: string; turnId: string; role: 'user' | 'assistant' | 'tool'; blocks: ContentBlock[]; sequence: number; revision: Revision; final: boolean; source: string }
export interface CandidateMetadata { native:NativeSessionRef; project:string; status:string; historyVerified:false; observedAt:string; connectionGeneration:number }
export interface Artifact { artifactId: string; sessionId: string; name: string; mediaType: string; size: number; contentVersion: string }
export type OperationStatus = 'received' | 'queued' | 'accepted' | 'completed' | 'failed' | 'unknown';
export type OperationResult = {kind:'session'; sessionId:string} | {kind:'artifact'; artifactId:string; contentVersion:string} | {kind:'turn'; turnId:string; status:'completed'|'failed'|'interrupted'};
export interface Operation { operationId: string; idempotencyKey: string; targetId: string; action: string; payloadDigest: string; status: OperationStatus; revision: Revision; error: ContractError | null; result?: OperationResult }
export type InteractionStatus = 'awaiting_answer' | 'answer_pending_delivery' | 'resolved' | 'expired' | 'cancelled';
export interface InteractionBase { interactionId: string; sessionId: string; turnId: string; nativeRequestId: string; connectionGeneration: number; revision: Revision; status: InteractionStatus; expiresAt: string | null; toolInputDigest: string | null; nativeResult: NativeResult | null }
export type Interaction = InteractionBase & ({ kind: 'question'; prompt: string; choices: string[]; multiple: boolean; allowFreeText: boolean } | { kind: 'approval'; tool: string; action: string; scope: string; toolInputDigest: string } | { kind: 'question_group'; questions: Array<{ id: string; prompt: string; choices: string[]; multiple: boolean | null; allowFreeText: boolean }> });
export type NativeResult = { status: 'accepted'; source: string; answer: Answer | null } | { status: 'unknown'; source: string } | { status: 'rejected'; reason: string };
export type Answer = { kind: 'question'; values: string[] } | { kind: 'approval'; decision: 'allow' | 'deny'; scope: string } | { kind: 'question_group'; answers: Record<string, string[]> };
export interface ResolveInteraction { context: WriteContext; interactionId: string; expectedConnectionGeneration: number; answer: Answer; toolInputDigest: string | null }
export interface SubmitInput { context: WriteContext; mode: 'new' | 'queue' | 'steer'; blocks: ContentBlock[] }
export interface Event { schemaVersion: typeof SCHEMA_VERSION; eventId: string; sessionId: string; objectId: string; objectRevision: Revision; sequence: number; type: string; occurredAt: string; receivedAt: string; operationId: string | null; cursor: string; data: unknown }
export interface TurnResidual { status:'running'|'none'|'unknown'; count:number|null; observedAt:string|null; complete:boolean; reason:string }
export interface Page<T> { items: T[]; nextCursor: string | null; unavailableProviders?:Provider[]; partialFailure?:boolean }
/** All collections and the cursor are read at one consistent event watermark. Interaction status includes delivery state. */
export interface SessionSnapshot { session: Session; messages: Message[]; interactions: Interaction[]; turns?: Turn[]; connectionGeneration?: number }
export interface Snapshot<T> { value: T; cursor: string }
export type EventSubscription = { status: 'events'; events: Event[]; cursor: string } | { status: 'snapshot_required'; error: ContractError };

export type Validation<T> = { ok: true; value: T } | { ok: false; error: ContractError };
const fail = (message: string): Validation<never> => ({ ok: false, error: contractError('invalid_request', message) });
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const counter = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
export function validateWriteContext(x: WriteContext): Validation<WriteContext> {
  if (!x || !nonempty(x.operationId) || !nonempty(x.idempotencyKey) || !nonempty(x.targetId) || !counter(x.expectedRevision) || !counter(x.controlGeneration) || !x.identity || !nonempty(x.identity.subject) || !nonempty(x.identity.source)) return fail('invalid write context');
  return { ok: true, value: x };
}
export function validateSubmitInput(x: SubmitInput): Validation<SubmitInput> {
  const context = validateWriteContext(x?.context); if (!context.ok) return context;
  if (!['new', 'queue', 'steer'].includes(x.mode) || !Array.isArray(x.blocks) || x.blocks.length === 0 || !x.blocks.every(b => b && (b.type === 'text' ? nonempty(b.text) : b.type === 'artifact' && nonempty(b.artifactId) && nonempty(b.contentVersion)))) return fail('invalid input blocks or mode');
  return { ok: true, value: x };
}
/** Compare against the authoritative interaction before atomic registration. The caller must separately authenticate identity and compare controlGeneration against the current session control in the same transaction. */
export function validateResolution(x: ResolveInteraction, current: Interaction, now: number): Validation<ResolveInteraction> {
  const context = validateWriteContext(x?.context); if (!context.ok) return context;
  if (!current || typeof current !== 'object') return fail('authoritative interaction required');
  if (!nonempty(x.interactionId) || x.context.targetId !== current.sessionId || x.interactionId !== current.interactionId || !counter(x.expectedConnectionGeneration)) return fail('interaction target mismatch');
  if (x.context.expectedRevision !== current.revision) return { ok: false, error: contractError('stale_revision') };
  if (x.expectedConnectionGeneration !== current.connectionGeneration) return { ok: false, error: contractError('interaction_expired') };
  if (!Number.isFinite(now) || (current.expiresAt !== null && !Number.isFinite(Date.parse(current.expiresAt)))) return fail('invalid expiry');
  if (current.status !== 'awaiting_answer' || (current.expiresAt !== null && Date.parse(current.expiresAt) <= now)) return { ok: false, error: contractError('interaction_expired') };
  if (!x.answer || x.answer.kind !== current.kind) return fail('answer kind mismatch');
  if (current.kind === 'approval') {
    if (x.answer.kind !== 'approval' || !['allow', 'deny'].includes(x.answer.decision) || x.answer.scope !== current.scope || x.toolInputDigest !== current.toolInputDigest) return fail('approval scope or tool input mismatch');
  } else if (current.kind === 'question_group') {
    if (x.answer.kind !== 'question_group' || !x.answer.answers || Object.keys(x.answer.answers).length !== current.questions.length || new Set(current.questions.map(q => q.id)).size !== current.questions.length || !current.questions.every(q => { const values = x.answer.kind === 'question_group' ? x.answer.answers[q.id] : undefined; return Array.isArray(values) && values.length > 0 && values.every(nonempty) && (q.multiple !== false || values.length === 1) && (q.allowFreeText || values.every(v => q.choices.includes(v))) && new Set(values).size === values.length; })) return fail('invalid grouped question answer');
  } else if (x.answer.kind !== 'question' || !Array.isArray(x.answer.values) || !x.answer.values.length || !x.answer.values.every(nonempty) || (!current.multiple && x.answer.values.length !== 1) || (!current.allowFreeText && !x.answer.values.every(v => current.choices.includes(v))) || new Set(x.answer.values).size !== x.answer.values.length) return fail('invalid question answer');
  return { ok: true, value: x };
}
const transitions: Record<OperationStatus, readonly OperationStatus[]> = { received: ['queued', 'accepted', 'failed', 'unknown'], queued: ['accepted', 'failed', 'unknown'], accepted: ['completed', 'failed', 'unknown'], unknown: ['accepted', 'completed', 'failed'], completed: [], failed: [] };
export function canTransitionOperation(from: OperationStatus, to: OperationStatus): boolean { return transitions[from]?.includes(to) ?? false; }
/** Canonical JSON payload digest; rejects values JSON would silently drop or alter. */
export function payloadDigest(value: unknown): string {
  const visiting = new Set<object>();
  function canonical(v: unknown): string {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) { if (visiting.has(v)) throw new TypeError('cyclic payload'); visiting.add(v); const result = `[${Array.from({length: v.length}, (_, i) => { if (!(i in v)) throw new TypeError('sparse array'); return canonical(v[i]); }).join(',')}]`; visiting.delete(v); return result; }
    if (typeof v === 'object' && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) { if (visiting.has(v)) throw new TypeError('cyclic payload'); visiting.add(v); const obj = v as Record<string, unknown>; if (Reflect.ownKeys(obj).some(k => typeof k !== 'string' || !Object.getOwnPropertyDescriptor(obj, k)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(obj, k)!))) throw new TypeError('payload must contain enumerable JSON data properties'); const result = `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`; visiting.delete(v); return result; }
    throw new TypeError('payload must be JSON data');
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function checkIdempotency(existing: Pick<Operation, 'idempotencyKey' | 'payloadDigest'>, key: string, digest: string): 'same' | 'conflict' | 'different_key' { return existing.idempotencyKey !== key ? 'different_key' : existing.payloadDigest === digest ? 'same' : 'conflict'; }
const interactionTransitions: Record<InteractionStatus, readonly InteractionStatus[]> = {
  awaiting_answer: ['answer_pending_delivery', 'resolved', 'expired', 'cancelled'],
  answer_pending_delivery: ['resolved', 'expired', 'cancelled'], resolved: [], expired: [], cancelled: [],
};
export function canTransitionInteraction(from: InteractionStatus, to: InteractionStatus): boolean { return interactionTransitions[from]?.includes(to) ?? false; }
export function validateEvent(event: Event): Validation<Event> {
  if (!event || !Object.prototype.hasOwnProperty.call(event, 'data') || event.data === undefined || event.schemaVersion !== SCHEMA_VERSION || !nonempty(event.eventId) || !nonempty(event.sessionId) || !nonempty(event.objectId) || !nonempty(event.type) || !nonempty(event.cursor) || !counter(event.objectRevision) || !counter(event.sequence) || !Number.isFinite(Date.parse(event.occurredAt)) || !Number.isFinite(Date.parse(event.receivedAt)) || (event.operationId !== null && !nonempty(event.operationId))) return fail('invalid event envelope');
  return { ok: true, value: event };
}

/** Provider-neutral model options; absent preferences mean no selectable values advertised. */
export interface ModelOption { id: string; label: string; reasoningEfforts?: string[] }
export interface ConfirmedSettings { model: string | null; preferences: Record<string,string>; revision: number }
