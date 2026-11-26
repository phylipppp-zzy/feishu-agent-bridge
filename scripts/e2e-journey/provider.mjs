import assert from 'node:assert/strict';
import { DEFAULT_AGY_MODELS } from '../../src/unified/agy/adapter-types.ts';
import { payloadDigest } from '../../src/unified/contracts.ts';
import { deriveTitleFromInputBlocks } from '../../src/unified/session-title.ts';
import { isTerminalTurn } from '../../src/unified/tool-progress.ts';

const capabilities = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config']
    .map(name => [name, { status: 'available' }]),
);
const readOnly = { status: 'unsupported', reason: 'read-only session' };
function capabilitiesFor(provider, active, released = false) {
  const native = { ...capabilities };
  if (provider !== 'codex') {
    native.steer = { status: 'unsupported', reason: 'steer is available only for Codex' };
    native.queue = { status: 'unsupported', reason: 'queue is coordinated by unified core' };
    if (provider === 'claude') native.files = { status: 'unsupported', reason: 'Claude SDK port does not support this capability' };
  }
  if (provider === 'codex') native.files = { status: 'unsupported', reason: 'not implemented by this port' };
  if (!active) {
    if (!released) native.handoff = readOnly;
    for (const name of ['send','queue','steer','answer','approve','interrupt','config']) native[name] = readOnly;
  }
  return native;
}
const now = () => new Date().toISOString();
const nativeAck = nativeReference => ({ status: 'submitted', nativeReference });

/** Only the native provider boundary is deterministic. Core owns operation results. */
export class JourneyProvider {
  sessions = new Map();
  listeners = new Set();
  inputs = [];
  interrupts = [];
  responses = [];
  settings = [];
  archives = [];
  resumes = [];
  controls = [];
  sequence = 0;
  generation = 1;

  constructor(provider, hostId, serviceId) {
    Object.assign(this, { provider, hostId, serviceId });
  }

  nextId(prefix) {
    return `${this.provider}-${prefix}-${++this.sequence}`;
  }

  seed({ id = this.nextId('session'), project, title = '', messages = [], active = false }) {
    const session = {
      native: { provider: this.provider, hostId: this.hostId, serviceId: this.serviceId, nativeSessionId: id },
      sessionId: id, project, title, createdAt: now(), updatedAt: now(), revision: 0,
      status: active ? 'idle' : 'read_only',
      capabilities: capabilitiesFor(this.provider, active),
      control: { serviceId: this.serviceId, owner: active ? this.serviceId : null, input: active ? 'available' : 'unavailable',
        generation: 1, operationId: null, reason: null },
    };
    this.sessions.set(id, { session, messages: new Map(messages.map(m => [m.messageId, m])),
      turns: new Map(), interactions: new Map() });
    return structuredClone(session);
  }

  seedConnectionGeneration(minimum) {
    this.generation = Math.max(this.generation, minimum);
  }

  async list(cursor, limit) {
    const offset = Number(cursor ?? 0);
    const all = [...this.sessions.values()].map(item => item.session);
    const items = all.slice(offset, offset + limit);
    return { items: structuredClone(items), nextCursor: offset + limit < all.length ? String(offset + limit) : null };
  }

  state(ref) {
    const item = this.sessions.get(ref.nativeSessionId);
    assert.ok(item, `未知测试原生会话 ${ref.nativeSessionId}`);
    return item;
  }

  async read(ref) {
    const { session, messages, interactions, turns } = this.state(ref);
    return structuredClone({ session, messages: [...messages.values()],
      interactions: [...interactions.values()], turns: [...turns.values()], connectionGeneration: this.generation });
  }

  async create(project) {
    const createdSession = this.seed({ project, active: true });
    return { ...nativeAck(createdSession.native.nativeSessionId), createdSession, connectionGeneration: this.generation };
  }

  async resume(ref) {
    const state = this.state(ref);
    const { session } = state;
    this.resumes.push(ref);
    state.session = { ...session, status: 'idle', revision: session.revision + 1,
      capabilities: capabilitiesFor(this.provider, true),
      control: { ...session.control, owner: this.serviceId, input: 'available',
        generation: session.control.generation + 1, reason: null } };
    return { ...nativeAck(ref.nativeSessionId), createdSession: structuredClone(state.session),
      connectionGeneration: this.generation };
  }

  async input(ref, mode, blocks, guard, turnId) {
    guard.assertCurrent();
    assert.ok(this.provider === 'codex' || mode !== 'steer', `${this.provider} does not support steer`);
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const id = mode === 'steer' ? turnId : this.nextId('turn');
    this.inputs.push({ ref, mode, text, blocks: structuredClone(blocks), turnId: id });
    if (mode === 'new') {
      const { session } = this.state(ref);
      const title = session.title ? null : deriveTitleFromInputBlocks(blocks);
      if (title) {
        this.emit({ type: 'session', ref, session: { ...session, title, revision: session.revision + 1 } });
      }
      this.emit({ type: 'turn', ref, turn: { turnId: id, sessionId: ref.nativeSessionId,
        startedAt: now(), endedAt: null, inputId: null, model: null, outputIds: [], status: 'running' } });
    }
    if (text) this.message(ref, id, text, { role: 'user', final: true });
    return nativeAck(id);
  }

  onObservation(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  updateRunStatus(state, settledTurn, clearWaiting = false) {
    const { session, interactions, turns } = state;
    if (session.control.input !== 'available') return;
    const pending = [...interactions.values()].filter(interaction =>
      interaction.status === 'awaiting_answer' || interaction.status === 'answer_pending_delivery');
    let status = session.status;
    if (pending.length) status = pending.some(interaction => interaction.kind === 'approval') ? 'waiting_approval' : 'waiting_question';
    else if ([...turns.values()].some(item => item.status === 'running' || item.status === 'queued')) status = 'running';
    else if (settledTurn && isTerminalTurn(settledTurn.status)) {
      status = settledTurn.status === 'completed' ? 'idle' : settledTurn.status;
    } else if (clearWaiting) status = 'idle';
    if (status !== session.status) state.session = { ...session, status, revision: session.revision + 1 };
  }

  emit(observation) {
    const copy = structuredClone(observation);
    const state = this.state(copy.ref);
    if (copy.type === 'session') state.session = copy.session;
    if (copy.type === 'message') state.messages.set(copy.message.messageId, copy.message);
    if (copy.type === 'turn' && !isTerminalTurn(state.turns.get(copy.turn.turnId)?.status)) {
      state.turns.set(copy.turn.turnId, copy.turn);
      this.updateRunStatus(state, copy.turn);
    }
    if (copy.type === 'interaction' && copy.interaction.revision > (state.interactions.get(copy.interaction.interactionId)?.revision ?? -1)) {
      state.interactions.set(copy.interaction.interactionId, copy.interaction);
      const wasWaiting = state.session.status === 'waiting_approval' || state.session.status === 'waiting_question';
      const latest = wasWaiting && state.turns.has(copy.interaction.turnId) ? [...state.turns.values()].at(-1) : undefined;
      this.updateRunStatus(state, latest, wasWaiting);
    }
    for (const listener of this.listeners) listener(copy);
    return copy;
  }

  turn(ref, turnId) {
    const turns = this.state(ref).turns;
    if (turnId) return turns.get(turnId);
    const latest = [...turns.values()].reverse();
    return latest.find(turn => turn.status === 'running') ?? latest[0];
  }

  message(ref, turnId, text, { final = false, messageId = this.nextId('message'), role = 'assistant' } = {}) {
    const previous = this.state(ref).messages.get(messageId);
    return this.emit({ type: 'message', ref, message: { messageId, sessionId: ref.nativeSessionId,
      turnId, role, blocks: [{ type: 'text', text }], sequence: previous?.sequence ?? ++this.sequence,
      revision: (previous?.revision ?? 0) + 1, final, source: this.provider } }).message;
  }

  event(ref, type, data, { objectId, objectRevision = 1 } = {}) {
    const eventId = this.nextId('event');
    return this.emit({ type: 'event', ref, event: { schemaVersion: 1, eventId, sessionId: ref.nativeSessionId,
      objectId: objectId ?? eventId, objectRevision, sequence: this.sequence, type, occurredAt: now(),
      receivedAt: now(), operationId: null, cursor: eventId, data } }).event;
  }

  finish(ref, turnId, { status = 'completed', durationMs } = {}) {
    const prior = this.turn(ref, turnId);
    assert.ok(prior, '缺少要结束的原生轮次');
    // Keep the first native start fixed. Production timing pins that evidence
    // when the running turn is observed and derives elapsed time from this end.
    const endedAt = durationMs === undefined ? Date.now() : Date.parse(prior.startedAt) + durationMs;
    const outputIds = [...this.state(ref).messages.values()].filter(m => m.turnId === prior.turnId
      && m.role === 'assistant' && m.final).map(m => m.messageId);
    const turn = { ...prior, status, endedAt: new Date(endedAt).toISOString(), outputIds };
    this.emit({ type: 'turn', ref, turn });
    return turn;
  }

  async interrupt(ref, turnId, guard) {
    guard.assertCurrent();
    this.interrupts.push({ ref, turnId });
    this.finish(ref, turnId, { status: 'interrupted' });
    return nativeAck(turnId);
  }

  async inspectTurnResidual() {
    return { status: 'none', count: 0, observedAt: now(), complete: true, reason: null };
  }

  async respond(ref, interaction, answer, guard) {
    guard.assertCurrent();
    this.responses.push({ ref, interactionId: interaction.interactionId, answer });
    const { interactionId, nativeRequestId, connectionGeneration } = interaction;
    this.emit({ type: 'interaction', ref, interaction: { ...interaction, status: 'resolved',
      revision: interaction.revision + 1, nativeResult: { status: 'accepted', source: this.provider, answer } },
    responseEvidence: { operationId: guard.operationId, interactionId, nativeRequestId, connectionGeneration,
      answerDigest: payloadDigest(answer) } });
    return nativeAck(nativeRequestId);
  }

  async listModels() {
    if (this.provider === 'agy') return structuredClone(DEFAULT_AGY_MODELS);
    if (this.provider === 'codex') return [
      { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', reasoningEfforts: ['medium', 'high', 'xhigh'] },
    ];
    return [{ id: 'sonnet', label: 'Sonnet' }];
  }

  async updateSettings(ref, settings, guard) {
    guard.assertCurrent();
    this.settings.push({ ref, ...structuredClone(settings) });
    return { ...nativeAck(null), settingsApplied: true };
  }

  async control(ref, action, guard) {
    guard.assertCurrent();
    this.controls.push({ ref, action });
    if (action === 'acquire') {
      const receipt = await this.resume(ref);
      this.emit({ type: 'session', ref, session: receipt.createdSession });
      return receipt;
    }
    const { session } = this.state(ref);
    this.emit({ type: 'session', ref, session: { ...session, status: 'read_only', revision: session.revision + 1,
      capabilities: capabilitiesFor(this.provider, false, true),
      control: { ...session.control, owner: null, input: 'unavailable',
        generation: session.control.generation + 1, reason: 'subscription released' } } });
    return nativeAck('unsubscribed');
  }

  async archive(ref, archived, guard) {
    guard.assertCurrent();
    this.archives.push({ ref, archived });
    return nativeAck(null);
  }

  async listArtifacts() {
    return [];
  }

  async readArtifact() {
    throw new Error('预期由真实 ArtifactRegistry 提供文件');
  }
}
