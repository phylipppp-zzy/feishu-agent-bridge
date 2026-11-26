import { createHash } from 'node:crypto';
import type { UnifiedService, ListQuery, WriteRequest } from './adapter.js';
import { payloadDigest, SCHEMA_VERSION, type Capabilities, type Event, type Interaction, type Operation, type Provider, type Session, type SubmitInput } from './contracts.js';
import { contractError } from './errors.js';

/** Synthetic formats used solely to exercise the boundary, not real provider protocols. */
export type MockNativeEvent = { provider: 'claude'; uuid: string; text: string; extra?: unknown } | { provider: 'codex'; id: string; content: string; extra?: unknown };
export function normalizeMockEvent(input: MockNativeEvent): Event {
  const id = input.provider === 'claude' ? input.uuid : input.id;
  const text = input.provider === 'claude' ? input.text : input.content;
  return { schemaVersion: SCHEMA_VERSION, eventId: id, sessionId: 's', objectId: 'm', objectRevision: 1, sequence: 1, type: 'message.final', occurredAt: '2029-01-01T00:00:00Z', receivedAt: '2029-01-01T00:00:00Z', operationId: null, cursor: '1', data: { text } };
}
const capabilities = Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k => [k, ['view', 'send'].includes(k) ? { status: 'available' } : { status: 'unsupported', reason: 'mock method not implemented' }])) as Capabilities;
/** In-memory test double. Unimplemented capabilities fail explicitly with a stable error. */
export function createMockAdapter(provider: Provider): UnifiedService & { provider: Provider } {
  const session: Session = { sessionId: 's', native: { provider, hostId: 'mock', serviceId: 'mock', nativeSessionId: 'native' }, project: 'demo', title: 'demo', status: 'idle', revision: 1, capabilities, control: { serviceId: 'mock', owner: null, input: 'available', generation: 1, operationId: null, reason: null } };
  const interaction: Interaction = { kind: 'question', interactionId: 'i', sessionId: 's', turnId: 't', nativeRequestId: 'opaque', connectionGeneration: 1, revision: 1, status: 'awaiting_answer', expiresAt: null, toolInputDigest: null, nativeResult: null, prompt: 'choose', choices: ['yes'], multiple: false, allowFreeText: false };
  const receipts = new Map<string, Operation>();
  const events: Event[] = [];
  const files = new Map<string, Uint8Array>();
  function receipt(context: SubmitInput['context'], action: string, data: unknown): Operation {
    const digest = payloadDigest(data);
    const prior = receipts.get(context.idempotencyKey);
    if (prior) { if (prior.payloadDigest !== digest || prior.action !== action) throw contractError('idempotency_conflict'); return prior; }
    const op: Operation = { operationId: context.operationId, idempotencyKey: context.idempotencyKey, targetId: context.targetId, action, payloadDigest: digest, status: 'completed', revision: 1, error: null };
    receipts.set(context.idempotencyKey, op); return op;
  }
  const methods = {
    registerInputScopeValidator: undefined,
    provider,
    hasProvider(p: Provider) { return p === provider; },
    async listSessions(_query: ListQuery) { return { items: [session], nextCursor: null }; },
    async attachSession(request: WriteRequest<{ provider: Provider; hostId: string; serviceId: string; nativeSessionId: string; mode: 'read_only' | 'interactive' }>) { return receipt(request.context, 'attachSession', request.payload); },
    async createSession(request: WriteRequest<{ provider: Provider; project: string; model: string | null }>) { return receipt(request.context, 'createSession', request.payload); },
    async readHistory() { return { items: [], nextCursor: null }; },
    async listInteractions() { return { items: [interaction], nextCursor: null }; },
    async getInteraction() { return interaction; },
    async getResponseOperation() { return null; },
    async resolveInteraction(request: import('./contracts.js').ResolveInteraction) { return receipt(request.context, 'resolveInteraction', { interactionId: request.interactionId, answer: request.answer }); },
    async getControlState() { return session.control; },
    async requestControl(request: WriteRequest<{ owner: string; strategy: 'wait' | 'interrupt' }>) { return receipt(request.context, 'requestControl', request.payload); },
    async releaseControl(request: WriteRequest<{ owner: string }>) { return receipt(request.context, 'releaseControl', request.payload); },
    async interruptTurn(request: WriteRequest<{ turnId: string }>) { return receipt(request.context, 'interruptTurn', request.payload); },
    async stopOrCancelQueued() { return {status:'rejected',reason:'no_running_turn'}; },
    async cancelQueuedInput(request: WriteRequest<{ inputId: string }>) { return receipt(request.context, 'cancelQueuedInput', request.payload); },
    async getSession(_id: string) { return session; },
    async capabilities(_id: string) { return capabilities; },
    eventWatermark() { return events.length; },
    async getMessage() { return null; },
    async findRegisteredReplyFiles() { return []; },
    async getSnapshot(_id: string) { return { value: { session, messages: [], interactions: [] }, cursor: String(events.length) }; },
    async subscribeEvents(_id: string, cursor: string, _limit: number) { const offset = Number(cursor); if (!Number.isSafeInteger(offset) || offset < 0 || offset > events.length) return { status: 'snapshot_required' as const, error: contractError('snapshot_required') }; return { status: 'events' as const, events: events.slice(offset), cursor: String(events.length) }; },
    async submitInput(request: SubmitInput) { return receipt(request.context, 'submitInput', { mode: request.mode, blocks: request.blocks }); },
    async stageInputArtifact(request: WriteRequest<{ name: string; mediaType: string; size: number; contentDigest: string; content: Uint8Array }>) {
      const { content, size, contentDigest, name, mediaType } = request.payload;
      if (!(content instanceof Uint8Array) || content.length !== size || createHash('sha256').update(content).digest('hex') !== contentDigest) throw contractError('invalid_request');
      const op = receipt(request.context, 'stageInputArtifact', { name, mediaType, size, contentDigest });
      files.set(op.operationId, Uint8Array.from(content));
      return op;
    },
    async readArtifact(_sessionId: string, artifactId: string, _version: string) { const data = files.get(artifactId); if (!data) throw contractError('invalid_request'); return Uint8Array.from(data); },
    async getOperation(id: string) { const op = [...receipts.values()].find(item => item.operationId === id); if (!op) throw contractError('invalid_request'); return op; },
  };
  return new Proxy(methods, { get(target, property, receiver) { if (Reflect.has(target, property)) return Reflect.get(target, property, receiver); return async () => { throw contractError('unsupported'); }; } }) as unknown as UnifiedService & { provider: Provider };
}
