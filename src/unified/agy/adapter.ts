import {deriveTitleFromInputBlocks} from '../session-title.js';
import { randomUUID } from 'node:crypto';
import type {
  DispatchGuard,
  PlatformAcknowledgement,
  PlatformInputBlock,
  PlatformObservation,
  PlatformPort,
} from '../adapter.js';
import type { AgyCatalog, AgyDiscoveredSession } from '../agy-catalog.js';
import type { AgyQuotaClient } from '../agy-quota.js';
import type { AgyAcpTransport, AgyEffortLevel } from '../agy-transport.js';
import type {
  Answer,
  Artifact,
  Interaction,
  Message,
  ModelOption,
  NativeSessionRef,
  Page,
  Session,
  SessionSnapshot,
  Turn,
  TurnResidual,
} from '../contracts.js';
import { contractError } from '../errors.js';
import {
  ack,
  AGY_REASONING_EFFORTS,
  buildPromptBlocks,
  DEFAULT_AGY_MODELS,
  DEFAULT_PROMPT_TIMEOUT_MS,
  findEffortConfigId,
  formatSessionTitle,
  isGenericAgyTitle,
  isRecord,
  isString,
  liveCaps,
  normalizeServerModels,
  readCaps,
  stripAgyModelEffortSuffix,
  type ActiveTurnState,
  type AdapterContext,
  type ExistingSnapshotState,
  type ListSnapshot,
  type LiveSessionMeta,
  type Obj,
  type PendingAgyRequest,
  type RecentDiscoveryState,
} from './adapter-types.js';
import {
  discoverExistingSessions,
  discoverNewerSessions,
  discoverRunningSessions,
  listSessionArtifacts,
  listSessions,
  readAutoActivityForSession,
  readSessionArtifact,
  readSessionSnapshot,
} from './adapter-discovery.js';
import {
  expireAllPendingRequests,
  handleAcpNotification,
  handleAcpServerRequest,
  handlePromptCompleted,
  handlePromptFailed,
  handleTransportDisconnect,
  respondToInteraction,
} from './adapter-turns.js';

export class AgyAdapter implements PlatformPort {
  readonly provider = 'agy' as const;

  private readonly active = new Set<string>();
  private readonly controlEpoch = new Map<string, number>();
  private readonly knownSessions = new Map<string, LiveSessionMeta>();
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly sessionTurns = new Map<string, Map<string, Turn>>();
  private readonly liveMessages = new Map<string, Message[]>();
  private readonly requests = new Map<string, PendingAgyRequest>();
  private readonly listeners = new Set<(event: PlatformObservation) => void>();
  private readonly sessionSettings = new Map<string, { model: string | null; effort?: AgyEffortLevel }>();
  private readonly listSnapshots = new Map<string, ListSnapshot>();
  private readonly recentDiscovery = new Map<string, RecentDiscoveryState>();
  private readonly existingSnapshots = new Map<string, ExistingSnapshotState>();

  private sequence = 0;
  private closed = false;
  private readonly ctx: AdapterContext;

  constructor(
    readonly transport: AgyAcpTransport,
    readonly catalog: AgyCatalog,
    readonly hostId: string,
    readonly serviceId: string,
    readonly quotaClient?: AgyQuotaClient,
  ) {
    if (!isString(hostId) || !isString(serviceId)) {
      throw contractError('invalid_request', 'hostId and serviceId are required');
    }

    this.ctx = {
      transport: this.transport,
      catalog: this.catalog,
      hostId: this.hostId,
      serviceId: this.serviceId,
      active: this.active,
      controlEpoch: this.controlEpoch,
      knownSessions: this.knownSessions,
      activeTurns: this.activeTurns,
      sessionTurns: this.sessionTurns,
      liveMessages: this.liveMessages,
      requests: this.requests,
      listSnapshots: this.listSnapshots,
      recentDiscovery: this.recentDiscovery,
      existingSnapshots: this.existingSnapshots,
      isClosed: () => this.closed,
      nextSequence: () => ++this.sequence,
      ref: id => this.ref(id),
      check: ref => this.check(ref),
      emit: obs => this.emit(obs),
      emitInteraction: interaction => this.emitInteraction(interaction),
      buildSession: (id, summary, liveMeta, createdAtOverride) =>
        this.buildSession(id, summary, liveMeta, createdAtOverride),
      upsertLiveMessage: (sessionId, message) => this.upsertLiveMessage(sessionId, message),
      putSessionTurn: (sessionId, turn) => this.putSessionTurn(sessionId, turn),
      pruneSnapshots: () => this.pruneSnapshots(),
    };

    const prevNotification = transport.onNotification;
    const prevServerRequest = transport.onServerRequest;
    const prevDisconnect = transport.onDisconnect;

    transport.onNotification = notification => {
      try {
        prevNotification(notification);
      } catch {}
      handleAcpNotification(this.ctx, notification);
    };

    transport.onServerRequest = req => {
      try {
        prevServerRequest(req);
      } catch {}
      handleAcpServerRequest(this.ctx, req);
    };

    transport.onDisconnect = (generation, reason) => {
      try {
        prevDisconnect(generation, reason);
      } catch {}
      handleTransportDisconnect(this.ctx, generation, reason);
    };
  }

  seedConnectionGeneration(minimum: number): void {
    if (!Number.isSafeInteger(minimum) || minimum < 0) {
      throw contractError('invalid_request', 'minimum generation must be a non-negative integer');
    }
    if (this.active.size || this.requests.size) {
      throw contractError('busy', 'adapter has active native state');
    }
    if (this.transport.connected && this.transport.connectionGeneration > minimum) {
      return;
    }
    this.transport.seedGeneration(minimum);
  }

  seedControlGeneration(ref: NativeSessionRef, minimum: number): void {
    const id = this.check(ref);
    if (
      !Number.isSafeInteger(minimum) ||
      minimum < 0 ||
      this.active.has(id) ||
      [...this.requests.values()].some(
        r =>
          r.interaction.sessionId === id &&
          (r.interaction.status === 'awaiting_answer' ||
            r.interaction.status === 'answer_pending_delivery'),
      )
    ) {
      throw contractError('busy', 'session has active native state');
    }
    this.controlEpoch.set(id, Math.max(minimum, this.controlEpoch.get(id) ?? 0));
  }

  onObservation(listener: (event: PlatformObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    expireAllPendingRequests(this.ctx, this.transport.connectionGeneration || null);
    this.activeTurns.clear();
    this.active.clear();
    this.listSnapshots.clear();
    this.recentDiscovery.clear();
    this.existingSnapshots.clear();
    this.listeners.clear();
    await this.transport.close();
  }

  private ref(id: string): NativeSessionRef {
    return {
      provider: 'agy',
      hostId: this.hostId,
      serviceId: this.serviceId,
      nativeSessionId: id,
    };
  }

  private check(ref: NativeSessionRef): string {
    if (
      ref.provider !== 'agy' ||
      ref.hostId !== this.hostId ||
      ref.serviceId !== this.serviceId ||
      !isString(ref.nativeSessionId)
    ) {
      throw contractError('invalid_request', 'native session reference mismatch');
    }
    return ref.nativeSessionId;
  }

  private emit(observation: PlatformObservation): void {
    if (this.closed) return;
    for (const listener of this.listeners) {
      listener(observation);
    }
  }

  private emitInteraction(interaction: Interaction): void {
    this.emit({
      type: 'interaction',
      ref: this.ref(interaction.sessionId),
      interaction,
    });
  }

  private buildSession(
    id: string,
    summary: AgyDiscoveredSession | null,
    liveMeta?: LiveSessionMeta,
    createdAtOverride?: string,
  ): Session & { subagentCount?: number } {
    const isActive = this.active.has(id) && this.transport.connected;
    const pending = [...this.requests.values()].filter(
      r =>
        r.interaction.sessionId === id &&
        (r.interaction.status === 'awaiting_answer' ||
          r.interaction.status === 'answer_pending_delivery'),
    );
    const activeTurn = this.activeTurns.get(id);

    let status: Session['status'] = 'read_only';
    if (isActive) {
      if (pending.some(p => p.interaction.kind === 'approval')) {
        status = 'waiting_approval';
      } else if (pending.length > 0) {
        status = 'waiting_question';
      } else if (activeTurn) {
        status = 'running';
      } else {
        status = 'idle';
      }
    }

    const project = summary?.project || liveMeta?.cwd || '';
    const subagentCount = summary?.subagentCount ?? 0;
    const summaryTitle = summary?.title && !isGenericAgyTitle(summary.title, id) ? summary.title : '';
    const baseTitle = (liveMeta?.nativeTitle && liveMeta.title) || summaryTitle || liveMeta?.title || summary?.title || `Antigravity 会话 · ${id.slice(0, 8)}`;
    const title = formatSessionTitle(baseTitle, subagentCount);
    const updatedAt = summary?.lastModifiedAt ?? liveMeta?.updatedAt ?? undefined;
    const createdAt = createdAtOverride ?? liveMeta?.createdAt ?? undefined;

    return {
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(summary ? { subagentCount } : {}),
      sessionId: id,
      native: this.ref(id),
      project,
      title,
      status,
      revision: 0,
      capabilities: isActive ? liveCaps : readCaps,
      control: {
        serviceId: this.serviceId,
        owner: isActive ? this.serviceId : null,
        input: isActive ? 'available' : 'unavailable',
        generation: this.controlEpoch.get(id) ?? 0,
        operationId: null,
        reason: isActive ? null : 'discovered agy session is read-only until attached',
      },
    };
  }

  private pruneSnapshots(): void {
    const now = Date.now();
    for (const [key, snap] of this.listSnapshots) {
      if (snap.expires <= now) this.listSnapshots.delete(key);
    }
    for (const [key, state] of this.recentDiscovery) {
      if (state.expires <= now) this.recentDiscovery.delete(key);
    }
    for (const [key, state] of this.existingSnapshots) {
      if (state.expires <= now) this.existingSnapshots.delete(key);
    }
  }

  private upsertLiveMessage(sessionId: string, message: Message): void {
    const list = this.liveMessages.get(sessionId) ?? [];
    const idx = list.findIndex(m => m.messageId === message.messageId);
    if (idx >= 0) {
      list[idx] = message;
    } else {
      list.push(message);
    }
    this.liveMessages.set(sessionId, list);
  }

  private putSessionTurn(sessionId: string, turn: Turn): void {
    let map = this.sessionTurns.get(sessionId);
    if (!map) {
      map = new Map();
      this.sessionTurns.set(sessionId, map);
    }
    map.set(turn.turnId, turn);
  }

  async list(cursor: string | null, limit: number): Promise<Page<Session>> {
    return listSessions(this.ctx, cursor, limit);
  }

  async discoverExisting(cursor: string | null, limit: number): Promise<Page<Session>> {
    return discoverExistingSessions(this.ctx, cursor, limit);
  }

  async discoverNewer(watermark: number, cursor: string | null, limit: number): Promise<Page<Session>> {
    return discoverNewerSessions(this.ctx, watermark, cursor, limit);
  }

  async discoverRunning(cursor: string | null, limit: number): Promise<Page<Session>> {
    return discoverRunningSessions(this.ctx, cursor, limit);
  }

  async readAutoActivity(
    ref: NativeSessionRef,
    watermark: number,
    observed: number,
  ): Promise<{
    status: 'proven' | 'unknown' | 'future';
    snapshot?: SessionSnapshot;
    oldMessageIds?: string[];
    newMessageIds?: string[];
    oldTurns?: Turn[];
  }> {
    return readAutoActivityForSession(this.ctx, ref, watermark, observed);
  }

  async read(ref: NativeSessionRef): Promise<SessionSnapshot> {
    return readSessionSnapshot(this.ctx, ref);
  }

  private captureServerSessionMeta(id: string, cwd: string, res: unknown): void {
    const existing = this.knownSessions.get(id);
    const catalogTitle = this.catalog.get(id)?.title;
    const fallbackTitle =
      catalogTitle && !isGenericAgyTitle(catalogTitle, id)
        ? catalogTitle
        : `Antigravity 会话 · ${id.slice(0, 8)}`;
    const meta: LiveSessionMeta = {
      cwd,
      title: existing?.title ?? fallbackTitle,
      ...(existing?.nativeTitle && {nativeTitle: true}),
      updatedAt: new Date().toISOString(),
      ...(existing?.createdAt ? { createdAt: existing.createdAt } : {}),
      ...(existing?.models ? { models: existing.models } : {}),
      ...(existing?.effortConfigId ? { effortConfigId: existing.effortConfigId } : {}),
    };

    if (isRecord(res)) {
      if (isRecord(res.models) && Array.isArray(res.models.availableModels)) {
        const parsedModels = normalizeServerModels(res.models.availableModels);
        if (parsedModels.length > 0) meta.models = parsedModels;
      }
      if (Array.isArray(res.configOptions)) {
        const thoughtOpt = findEffortConfigId(res.configOptions);
        if (thoughtOpt) meta.effortConfigId = thoughtOpt;
      }
    }

    this.knownSessions.set(id, meta);
  }

  private effortConfigId(id: string): string {
    return this.knownSessions.get(id)?.effortConfigId ?? 'thought_level';
  }

  async create(cwd: string, model: string | null): Promise<PlatformAcknowledgement> {
    if (!isString(cwd)) {
      throw contractError('invalid_request', 'cwd must be a non-empty string');
    }
    if (!this.transport.connected) {
      throw contractError('temporarily_unavailable', 'ACP transport not connected');
    }

    const res = (await this.transport.request('session/new', { cwd, mcpServers: [] })) as Obj;
    const sessionId = isString(res?.sessionId) ? res.sessionId : null;
    if (!sessionId) {
      throw contractError('temporarily_unavailable', 'invalid ACP session/new response');
    }

    const now = new Date().toISOString();
    this.knownSessions.set(sessionId, {
      cwd,
      title: `Antigravity 会话 · ${sessionId.slice(0, 8)}`,
      createdAt: now,
      updatedAt: now,
    });
    this.captureServerSessionMeta(sessionId, cwd, res);

    if (model !== null && model.trim() !== '') {
      const { baseModel, extractedEffort } = stripAgyModelEffortSuffix(model);
      await this.transport.request('session/set_model', {
        sessionId,
        modelId: baseModel,
      });
      if (extractedEffort) {
        await this.transport.request('session/set_config_option', {
          sessionId,
          configId: this.effortConfigId(sessionId),
          value: extractedEffort,
        });
      }
      this.sessionSettings.set(sessionId, {
        model: baseModel,
        ...(extractedEffort ? { effort: extractedEffort } : {}),
      });
    }

    this.active.add(sessionId);
    this.controlEpoch.set(sessionId, 0);
    const generation = this.transport.connectionGeneration;

    return {
      status: 'submitted',
      nativeReference: sessionId,
      createdSession: this.buildSession(sessionId, null, this.knownSessions.get(sessionId), now),
      connectionGeneration: generation,
    };
  }

  async resume(ref: NativeSessionRef): Promise<PlatformAcknowledgement> {
    const id = this.check(ref);
    if (!this.transport.connected) {
      throw contractError('temporarily_unavailable', 'ACP transport not connected');
    }

    this.catalog.refresh();
    const summary = this.catalog.get(id);
    const liveMeta = this.knownSessions.get(id);
    const cwd = summary?.project || liveMeta?.cwd || '';
    if (!cwd) {
      throw contractError('invalid_request', 'session working directory unavailable');
    }

    const res = (await this.transport.request('session/load', {
      sessionId: id,
      cwd,
      mcpServers: [],
    })) as Obj;
    if (isRecord(res) && isString(res.sessionId) && res.sessionId !== id) {
      throw contractError('outcome_unknown', 'ACP session/load returned mismatched sessionId');
    }

    this.captureServerSessionMeta(id, cwd, res);
    this.active.add(id);
    this.controlEpoch.set(id, (this.controlEpoch.get(id) ?? 0) + 1);
    const generation = this.transport.connectionGeneration;
    this.emit({ type: 'connection', ref, connectionGeneration: generation });

    return {
      ...ack(id),
      connectionGeneration: generation,
    };
  }

  async input(
    ref: NativeSessionRef,
    mode: 'new' | 'steer',
    blocks: PlatformInputBlock[],
    guard: DispatchGuard,
  ): Promise<PlatformAcknowledgement> {
    const id = this.check(ref);
    if (mode !== 'new') {
      throw contractError('unsupported', 'steer is available only for Codex');
    }
    if (!this.active.has(id) || !this.transport.connected) {
      throw contractError('control_conflict', 'session is not subscribed');
    }
    if (!blocks.length) {
      throw contractError('invalid_request', 'input blocks required');
    }
    if (this.activeTurns.has(id)) {
      throw contractError('busy', 'turn already running');
    }

    const promptBlocks = buildPromptBlocks(blocks);

    const generation = this.transport.connectionGeneration;
    if (
      guard.expectedConnectionGeneration !== null &&
      guard.expectedConnectionGeneration !== generation
    ) {
      throw contractError('control_conflict', 'connection generation mismatch');
    }
    guard.assertCurrent();

    const turnId = randomUUID();
    const now = new Date().toISOString();
    const model = this.sessionSettings.get(id)?.model ?? null;
    const turnState: ActiveTurnState = {
      turnId,
      generation,
      model,
      startedAt: now,
      assistantMessageId: null,
      assistantSequence: null,
      assistantRevision: 0,
      assistantText: '',
      assistantFinalized: false,
      interrupted: false,
      inProgressToolCalls: new Set(),
    };
    this.activeTurns.set(id, turnState);

    const userMsg: Message = {
      messageId: turnId,
      sessionId: id,
      turnId,
      role: 'user',
      blocks: blocks.map(b =>
        b.type === 'text'
          ? b
          : { type: 'artifact', artifactId: b.artifactId, contentVersion: b.contentVersion },
      ),
      sequence: ++this.sequence,
      revision: 1,
      final: true,
      source: 'agy',
    };
    this.upsertLiveMessage(id, userMsg);

    const runningTurn: Turn = {
      turnId,
      sessionId: id,
      status: 'running',
      inputId: turnId,
      startedAt: now,
      endedAt: null,
      model,
      outputIds: [],
    };
    this.putSessionTurn(id, runningTurn);

    const liveMeta = this.knownSessions.get(id);
    if (liveMeta) {
      liveMeta.updatedAt = now;
      const summary = this.catalog.get(id);
      const hasRealCatalogTitle = Boolean(summary?.title && !isGenericAgyTitle(summary.title, id));
      if (!hasRealCatalogTitle && isGenericAgyTitle(liveMeta.title, id)) {
        const promptTitle = deriveTitleFromInputBlocks(blocks);
        if (promptTitle) {
          liveMeta.title = promptTitle;
          this.emit({
            type: 'session',
            ref,
            session: this.buildSession(id, summary ?? null, liveMeta),
          });
        }
      }
    }

    this.emit({ type: 'message', ref, message: userMsg, connectionGeneration: generation });
    this.emit({ type: 'turn', ref, turn: runningTurn, connectionGeneration: generation });

    const promptPromise = this.transport.request(
      'session/prompt',
      { sessionId: id, prompt: promptBlocks },
      DEFAULT_PROMPT_TIMEOUT_MS,
    );

    void promptPromise.then(
      rawResult => handlePromptCompleted(this.ctx, id, turnState, rawResult),
      error => handlePromptFailed(this.ctx, id, turnState, error),
    );

    return ack(turnId);
  }

  async interrupt(
    ref: NativeSessionRef,
    turnId: string,
    guard: DispatchGuard,
  ): Promise<PlatformAcknowledgement> {
    const id = this.check(ref);
    if (!this.active.has(id) || !this.transport.connected) {
      throw contractError('control_conflict', 'session is not connected');
    }
    if (!isString(turnId)) {
      throw contractError('invalid_request', 'turnId required');
    }
    const activeTurn = this.activeTurns.get(id);
    if (!activeTurn || activeTurn.turnId !== turnId) {
      throw contractError('stale_revision', 'turn is no longer running');
    }
    if (
      guard.expectedConnectionGeneration !== null &&
      guard.expectedConnectionGeneration !== this.transport.connectionGeneration
    ) {
      throw contractError('control_conflict', 'connection generation mismatch');
    }
    guard.assertCurrent();

    activeTurn.interrupted = true;
    await this.transport.request('session/cancel', { sessionId: id });
    return ack(turnId);
  }

  async inspectTurnResidual(ref: NativeSessionRef, turnId: string): Promise<TurnResidual> {
    const id = this.check(ref);
    const activeTurn = this.activeTurns.get(id);
    if (
      activeTurn &&
      activeTurn.turnId === turnId &&
      activeTurn.generation === this.transport.connectionGeneration &&
      this.transport.connected &&
      activeTurn.inProgressToolCalls.size > 0
    ) {
      return {
        status: 'running',
        count: activeTurn.inProgressToolCalls.size,
        observedAt: new Date().toISOString(),
        complete: false,
        reason: '目标轮次存在未完成工具调用；Antigravity ACP 未提供完整后台子进程清单',
      };
    }

    return {
      status: 'unknown',
      count: null,
      observedAt: null,
      complete: false,
      reason: 'Antigravity ACP 未提供后台子进程清单，已发出 session/cancel，后台残留未确认',
    };
  }

  async respond(
    ref: NativeSessionRef,
    interaction: Interaction,
    answer: Answer,
    guard: DispatchGuard,
  ): Promise<PlatformAcknowledgement> {
    return respondToInteraction(this.ctx, ref, interaction, answer, guard);
  }

  async listArtifacts(ref: NativeSessionRef): Promise<Artifact[]> {
    return listSessionArtifacts(this.ctx, ref);
  }

  async readArtifact(
    ref: NativeSessionRef,
    artifactId: string,
    expectedVersion: string,
  ): Promise<Uint8Array> {
    return readSessionArtifact(this.ctx, ref, artifactId, expectedVersion);
  }

  async listModels(ref: NativeSessionRef): Promise<ModelOption[]> {
    const id = this.check(ref);
    const serverModels = this.knownSessions.get(id)?.models;
    const base = serverModels?.length ? serverModels : DEFAULT_AGY_MODELS;
    return base.map(m => ({
      id: m.id,
      label: m.label,
      reasoningEfforts: [...(m.reasoningEfforts ?? AGY_REASONING_EFFORTS)],
    }));
  }

  async updateSettings(
    ref: NativeSessionRef,
    settings: { model: string | null; preferences: Record<string, string> },
    guard: DispatchGuard,
  ): Promise<PlatformAcknowledgement> {
    const id = this.check(ref);
    if (!this.active.has(id) || !this.transport.connected) {
      throw contractError('control_conflict', 'session is not connected');
    }
    if (Object.keys(settings.preferences).some(k => k !== 'reasoningEffort')) {
      throw contractError('unsupported', 'unsupported preference');
    }

    let baseModel: string | null = null;
    let extractedEffort: AgyEffortLevel | null = null;

    if (settings.model !== null) {
      if (!settings.model.trim()) {
        throw contractError('invalid_request', 'model must be non-empty');
      }
      const stripped = stripAgyModelEffortSuffix(settings.model);
      baseModel = stripped.baseModel;
      extractedEffort = stripped.extractedEffort;

      const models = await this.listModels(ref);
      const found = models.find(m => m.id === baseModel);
      if (!found) {
        throw contractError('invalid_request', 'model not in agy catalog');
      }
    }

    const rawEffort = settings.preferences.reasoningEffort ?? extractedEffort ?? undefined;
    if (
      rawEffort !== undefined &&
      !AGY_REASONING_EFFORTS.includes(rawEffort as AgyEffortLevel)
    ) {
      throw contractError('invalid_request', 'reasoning effort not in agy catalog');
    }
    const effort = rawEffort as AgyEffortLevel | undefined;

    if (
      guard.expectedConnectionGeneration !== null &&
      guard.expectedConnectionGeneration !== this.transport.connectionGeneration
    ) {
      throw contractError('control_conflict', 'connection generation mismatch');
    }
    guard.assertCurrent();

    let modelApplied = false;
    try {
      if (baseModel !== null) {
        await this.transport.request('session/set_model', {
          sessionId: id,
          modelId: baseModel,
        });
        modelApplied = true;
      }

      if (effort !== undefined) {
        if (!this.active.has(id) || !this.transport.connected) {
          throw contractError('control_conflict', 'session disconnected during settings update');
        }
        if (
          guard.expectedConnectionGeneration !== null &&
          guard.expectedConnectionGeneration !== this.transport.connectionGeneration
        ) {
          throw contractError('control_conflict', 'connection generation changed');
        }
        guard.assertCurrent();
        await this.transport.request('session/set_config_option', {
          sessionId: id,
          configId: this.effortConfigId(id),
          value: effort,
        });
      }

      this.sessionSettings.set(id, {
        model: baseModel,
        ...(effort !== undefined ? { effort } : {}),
      });
      return { ...ack(id), settingsApplied: true };
    } catch (error) {
      if (modelApplied) {
        throw contractError('outcome_unknown', 'agy session settings may have partially changed');
      }
      throw error;
    }
  }

  async control(
    ref: NativeSessionRef,
    action: 'acquire' | 'release',
    guard: DispatchGuard,
  ): Promise<PlatformAcknowledgement> {
    const id = this.check(ref);
    if (
      guard.expectedConnectionGeneration !== null &&
      guard.expectedConnectionGeneration !== this.transport.connectionGeneration
    ) {
      throw contractError('control_conflict', 'connection generation mismatch');
    }

    if (action === 'acquire') {
      if (this.active.has(id)) {
        throw contractError('busy', 'already subscribed');
      }
      guard.assertCurrent();
      return await this.resume(ref);
    }

    if (!this.active.has(id)) {
      throw contractError('control_conflict', 'not subscribed');
    }
    guard.assertCurrent();

    if (this.transport.connected) {
      try {
        await this.transport.request('session/close', { sessionId: id });
      } catch (error) {
        if (!(isRecord(error) && error.code === 'unsupported')) {
          // Best-effort local teardown if server already closed or unsupported.
        }
      }
    }

    this.active.delete(id);
    this.activeTurns.delete(id);
    for (const entry of this.requests.values()) {
      if (
        entry.interaction.sessionId === id &&
        entry.interaction.status !== 'resolved' &&
        entry.interaction.status !== 'expired'
      ) {
        entry.interaction = {
          ...entry.interaction,
          status: 'expired',
          revision: entry.interaction.revision + 1,
        };
        this.emitInteraction(entry.interaction);
      }
    }
    this.controlEpoch.set(id, (this.controlEpoch.get(id) ?? 0) + 1);
    const summary = this.catalog.get(id);
    const meta = this.knownSessions.get(id);
    if (summary || meta) {
      this.emit({
        type: 'session',
        ref,
        session: this.buildSession(id, summary, meta),
      });
    }

    return ack('unsubscribed');
  }
}
