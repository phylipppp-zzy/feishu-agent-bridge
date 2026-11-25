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
  ResponseEvidence,
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
  DEFAULT_PROMPT_IDLE_TIMEOUT_MS,
  DEFAULT_PROMPT_MAX_TIMEOUT_MS,
  DEFAULT_WAKEUP_IDLE_MS,
  extractServerCurrentSettings,
  findEffortConfigId,
  isGenericAgyTitle,
  isRecord,
  isString,
  liveCaps,
  MAX_TURN_RESIDUAL_SNAPSHOTS,
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
  type SessionLockState,
  type TurnResidualSnapshot,
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
  resolveSessionTitle,
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
  private readonly controlChanges = new Set<string>();
  private readonly controlEpoch = new Map<string, number>();
  private readonly knownSessions = new Map<string, LiveSessionMeta>();
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly lockedSessions = new Map<string, SessionLockState>();
  private readonly turnResiduals = new Map<string, TurnResidualSnapshot>();
  private readonly sessionTurns = new Map<string, Map<string, Turn>>();
  private readonly liveMessages = new Map<string, Message[]>();
  private readonly preLiveTranscriptIds = new Map<string, Set<string>>();
  private readonly requests = new Map<string, PendingAgyRequest>();
  private readonly listeners = new Set<(event: PlatformObservation) => void>();
  private readonly sessionSettings = new Map<string, { model: string | null; effort?: AgyEffortLevel }>();
  private readonly listSnapshots = new Map<string, ListSnapshot>();
  private readonly recentDiscovery = new Map<string, RecentDiscoveryState>();
  private readonly existingSnapshots = new Map<string, ExistingSnapshotState>();
  private readonly acpTitles = new Map<string, string>();
  private readonly promptMaxTimeoutMs: number;
  private readonly promptIdleTimeoutMs: number;
  private readonly wakeupIdleMs: number;

  private sequence = 0;
  private closed = false;
  private readonly ctx: AdapterContext;

  constructor(
    readonly transport: AgyAcpTransport,
    readonly catalog: AgyCatalog,
    readonly hostId: string,
    readonly serviceId: string,
    readonly quotaClient?: AgyQuotaClient,
    options: {
      approvalPolicy?: AdapterContext['approvalPolicy'];
      promptMaxTimeoutMs?: number;
      promptIdleTimeoutMs?: number;
      wakeupIdleMs?: number;
    } = {},
  ) {
    if (!isString(hostId) || !isString(serviceId)) {
      throw contractError('invalid_request', 'hostId and serviceId are required');
    }
    this.promptMaxTimeoutMs = options.promptMaxTimeoutMs ?? DEFAULT_PROMPT_MAX_TIMEOUT_MS;
    this.promptIdleTimeoutMs = options.promptIdleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS;
    this.wakeupIdleMs = options.wakeupIdleMs ?? DEFAULT_WAKEUP_IDLE_MS;

    this.ctx = {
      transport: this.transport,
      catalog: this.catalog,
      hostId: this.hostId,
      serviceId: this.serviceId,
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      wakeupIdleMs: this.wakeupIdleMs,
      active: this.active,
      controlEpoch: this.controlEpoch,
      knownSessions: this.knownSessions,
      activeTurns: this.activeTurns,
      lockedSessions: this.lockedSessions,
      turnResiduals: this.turnResiduals,
      sessionTurns: this.sessionTurns,
      liveMessages: this.liveMessages,
      preLiveTranscriptIds: this.preLiveTranscriptIds,
      requests: this.requests,
      listSnapshots: this.listSnapshots,
      recentDiscovery: this.recentDiscovery,
      existingSnapshots: this.existingSnapshots,
      acpTitles: this.acpTitles,
      isClosed: () => this.closed,
      nextSequence: () => ++this.sequence,
      ref: id => this.ref(id),
      check: ref => this.check(ref),
      emit: obs => this.emit(obs),
      emitInteraction: (interaction, evidence) => this.emitInteraction(interaction, evidence),
      buildSession: (id, summary, liveMeta, createdAtOverride) =>
        this.buildSession(id, summary, liveMeta, createdAtOverride),
      upsertLiveMessage: (sessionId, message) => this.upsertLiveMessage(sessionId, message),
      putSessionTurn: (sessionId, turn) => this.putSessionTurn(sessionId, turn),
      getSessionModel: sessionId => this.sessionSettings.get(sessionId)?.model ?? null,
      recordTurnResidual: (sessionId, turnState) => this.recordTurnResidual(sessionId, turnState),
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
      void handleAcpServerRequest(this.ctx, req).catch(() => {
        try {
          if (!this.closed && this.transport.connected && req.generation === this.transport.connectionGeneration) {
            this.transport.respondServerError(req.generation, req.rpcId, -32603, 'Internal error handling server request');
          }
        } catch {}
      });
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
      this.controlChanges.has(id) ||
      this.pendingRequests(id).length > 0
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
    for (const turn of this.activeTurns.values()) {
      if (turn.wakeupTimer) {
        clearTimeout(turn.wakeupTimer);
        delete turn.wakeupTimer;
      }
    }
    expireAllPendingRequests(this.ctx, this.transport.connectionGeneration || null);
    this.activeTurns.clear();
    this.lockedSessions.clear();
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

  hasActiveNativeSession(ref: NativeSessionRef): boolean {
    return !this.closed && this.transport.connected &&
      ref.provider === this.provider && ref.hostId === this.hostId && ref.serviceId === this.serviceId &&
      this.active.has(ref.nativeSessionId) && this.knownSessions.has(ref.nativeSessionId);
  }

  private emit(observation: PlatformObservation): void {
    if (this.closed) return;
    for (const listener of this.listeners) {
      listener(observation);
    }
  }

  private emitInteraction(interaction: Interaction, responseEvidence?: ResponseEvidence): void {
    this.emit({
      type: 'interaction',
      ref: this.ref(interaction.sessionId),
      interaction,
      ...(responseEvidence ? { responseEvidence } : {}),
    });
  }

  private pendingRequests(id: string): PendingAgyRequest[] {
    return [...this.requests.values()].filter(({ interaction }) =>
      interaction.sessionId === id &&
      (interaction.status === 'awaiting_answer' || interaction.status === 'answer_pending_delivery'),
    );
  }

  private buildSession(
    id: string,
    summary: AgyDiscoveredSession | null,
    liveMeta?: LiveSessionMeta,
    createdAtOverride?: string,
  ): Session & { subagentCount?: number } {
    const isActive = this.active.has(id) && this.transport.connected;
    const pending = this.pendingRequests(id);
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
    const title = resolveSessionTitle(id, summary, liveMeta ?? this.knownSessions.get(id), this.acpTitles.get(id));
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
      capabilities: isActive ? liveCaps : this.canReacquire(id) ? { ...readCaps, handoff: liveCaps.handoff } : readCaps,
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

  private canReacquire(id: string): boolean {
    return this.transport.connected && this.knownSessions.has(id) && this.controlEpoch.has(id);
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

  private recordTurnResidual(sessionId: string, turnState: ActiveTurnState): void {
    const key = `${sessionId}:${turnState.turnId}`;
    this.turnResiduals.delete(key);
    this.turnResiduals.set(key, {
      turnId: turnState.turnId,
      generation: turnState.generation,
      inProgressToolCalls: turnState.inProgressToolCalls.size,
      observedAt: new Date().toISOString(),
    });
    while (this.turnResiduals.size > MAX_TURN_RESIDUAL_SNAPSHOTS) {
      const oldest = this.turnResiduals.keys().next().value;
      if (oldest === undefined) break;
      this.turnResiduals.delete(oldest);
    }
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

    const extracted = extractServerCurrentSettings(res);
    if (extracted) {
      const prev = this.sessionSettings.get(id);
      const nextEffort = extracted.effort ?? prev?.effort;
      this.sessionSettings.set(id, {
        model: extracted.model ?? prev?.model ?? null,
        ...(nextEffort !== undefined ? { effort: nextEffort } : {}),
      });
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

    // Register the created session immediately so a subsequent model/config error preserves sessionId.
    this.preLiveTranscriptIds.set(sessionId, new Set());
    this.active.add(sessionId);
    this.controlEpoch.set(sessionId, 0);
    this.lockedSessions.delete(sessionId);
    const generation = this.transport.connectionGeneration;

    let settingsApplied: true | undefined;
    if (model !== null && model.trim() !== '') {
      const { baseModel, extractedEffort } = stripAgyModelEffortSuffix(model);
      let modelSet = false;
      try {
        await this.transport.request('session/set_model', {
          sessionId,
          modelId: baseModel,
        });
        modelSet = true;
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
        settingsApplied = true;
      } catch {
        if (modelSet) {
          this.sessionSettings.set(sessionId, { model: baseModel });
        }
      }
    }

    return {
      status: 'submitted',
      nativeReference: sessionId,
      createdSession: this.buildSession(sessionId, null, this.knownSessions.get(sessionId), now),
      connectionGeneration: generation,
      ...(settingsApplied ? { settingsApplied } : {}),
    };
  }

  resume(ref: NativeSessionRef): Promise<PlatformAcknowledgement> {
    return this.resumeSession(ref);
  }

  private async resumeSession(ref: NativeSessionRef, guard?: DispatchGuard): Promise<PlatformAcknowledgement> {
    const id = this.check(ref);
    if (this.controlChanges.has(id) || this.activeTurns.has(id) || this.pendingRequests(id).length > 0) {
      throw contractError('busy', 'session has an active turn, pending interaction, or control change');
    }
    this.controlChanges.add(id);
    try {
      return await this.loadSession(ref, id, guard);
    } finally {
      this.controlChanges.delete(id);
    }
  }

  private async loadSession(ref: NativeSessionRef, id: string, guard?: DispatchGuard): Promise<PlatformAcknowledgement> {
    if (!this.transport.connected) {
      throw contractError('temporarily_unavailable', 'ACP transport not connected');
    }
    const generation = this.transport.connectionGeneration;

    if (!this.knownSessions.has(id)) await this.catalog.refreshAsync();
    const summary = this.catalog.get(id);
    const liveMeta = this.knownSessions.get(id);
    const cwd = summary?.project || liveMeta?.cwd || '';
    if (!cwd) {
      throw contractError('invalid_request', 'session working directory unavailable');
    }
    if (guard && cwd !== liveMeta?.cwd) {
      throw contractError('control_conflict', 'session working directory changed');
    }

    if (!this.preLiveTranscriptIds.has(id) && !this.liveMessages.has(id)) {
      try {
        const transcript = await this.catalog.readTranscript(id);
        this.preLiveTranscriptIds.set(id, new Set(transcript.messages.map(message => message.messageId)));
      } catch {
        // With no baseline, keep the native transcript visible.
      }
    }

    this.assertConnection(generation);
    guard?.assertCurrent();
    const res = (await this.transport.request('session/load', {
      sessionId: id,
      cwd,
      mcpServers: [],
    })) as Obj;
    if (isRecord(res) && isString(res.sessionId) && res.sessionId !== id) {
      throw contractError('outcome_unknown', 'ACP session/load returned mismatched sessionId');
    }

    this.assertConnection(generation);
    this.captureServerSessionMeta(id, cwd, res);
    this.lockedSessions.delete(id);
    this.active.add(id);
    this.controlEpoch.set(id, (this.controlEpoch.get(id) ?? 0) + 1);
    this.emit({ type: 'connection', ref, connectionGeneration: generation });

    return {
      ...ack(id),
      connectionGeneration: generation,
    };
  }

  private assertConnection(generation: number): void {
    if (this.closed || !this.transport.connected || generation !== this.transport.connectionGeneration) {
      throw contractError('control_conflict', 'connection generation changed');
    }
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
    if (!this.active.has(id) || this.controlChanges.has(id) || !this.transport.connected) {
      throw contractError('control_conflict', 'session is not subscribed');
    }
    if (!blocks.length) {
      throw contractError('invalid_request', 'input blocks required');
    }
    if (this.activeTurns.has(id)) {
      throw contractError('busy', 'turn already running');
    }
    const lock = this.lockedSessions.get(id);
    if (lock && lock.generation === this.transport.connectionGeneration) {
      throw contractError(
        'control_conflict',
        `session locked after unknown prompt outcome (${lock.reason}); release and reacquire or reconnect before sending a new turn`,
      );
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
      cancelRequested: false,
      inProgressToolCalls: new Set(),
      toolCalls: new Map(),
      fullToolCalls: new Set(),
      approvalRequestIds: new Map(),
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
      {
        timeoutMs: this.promptMaxTimeoutMs,
        idleTimeoutMs: this.promptIdleTimeoutMs,
        sessionId: id,
        isWaitingForUser: () =>
          this.pendingRequests(id).some(
            p => p.interaction.status === 'awaiting_answer' || p.submission === 'writing',
          ),
      },
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

    this.transport.notify('session/cancel', { sessionId: id });
    activeTurn.cancelRequested = true;
    activeTurn.cancelRequestedAt = new Date().toISOString();
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

    const snap = this.turnResiduals.get(`${id}:${turnId}`);
    if (
      snap &&
      snap.generation === this.transport.connectionGeneration &&
      this.transport.connected
    ) {
      if (snap.inProgressToolCalls > 0) {
        return {
          status: 'running',
          count: snap.inProgressToolCalls,
          observedAt: snap.observedAt,
          complete: false,
          reason: '轮次终结时存在未完成工具调用；Antigravity ACP 未提供完整后台子进程清单',
        };
      }
      return {
        status: 'none',
        count: 0,
        observedAt: snap.observedAt,
        complete: false,
        reason: '轮次终结时未发现已登记活跃工具调用；Antigravity ACP 未提供完整后台子进程清单',
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
    if (!this.active.has(id) || this.controlChanges.has(id) || !this.transport.connected) {
      throw contractError('control_conflict', 'session is not connected');
    }
    if (Object.keys(settings.preferences).some(k => k !== 'reasoningEffort')) {
      throw contractError('unsupported', 'unsupported preference');
    }

    const controlGeneration = this.controlEpoch.get(id);
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

    if (this.controlChanges.has(id) || !this.active.has(id) || controlGeneration !== this.controlEpoch.get(id)) {
      throw contractError('control_conflict', 'session control changed');
    }
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
        if (!this.active.has(id) || this.controlChanges.has(id) || !this.transport.connected || controlGeneration !== this.controlEpoch.get(id)) {
          throw contractError('control_conflict', 'session control changed during settings update');
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
      if (!this.canReacquire(id)) throw contractError('unsupported', 'session has no previous interactive attachment');
      const receipt = await this.resumeSession(ref, guard);
      this.emitSession(ref, id);
      return receipt;
    }

    if (!this.active.has(id) || !this.transport.connected) {
      throw contractError('control_conflict', 'not subscribed');
    }
    if (this.controlChanges.has(id) || this.activeTurns.has(id) || this.pendingRequests(id).length > 0) {
      throw contractError('busy', 'session has an active turn, pending interaction, or control change');
    }
    guard.assertCurrent();

    this.controlChanges.add(id);
    try {
      // Some ACP versions omit session/close. Local release still fences bridge writes.
      await this.transport.request('session/close', { sessionId: id }).catch(() => {});
      if (this.active.delete(id)) {
        this.controlEpoch.set(id, (this.controlEpoch.get(id) ?? 0) + 1);
        this.emitSession(ref, id);
      }
    } finally {
      this.controlChanges.delete(id);
    }
    return ack('unsubscribed');
  }

  private emitSession(ref: NativeSessionRef, id: string): void {
    const summary = this.catalog.get(id);
    const meta = this.knownSessions.get(id);
    if (summary || meta) {
      this.emit({
        type: 'session',
        ref,
        session: this.buildSession(id, summary, meta),
      });
    }

  }
}
