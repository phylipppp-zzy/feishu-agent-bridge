import { randomUUID } from 'node:crypto';
import type {
  DispatchGuard,
  PlatformAcknowledgement,
  PlatformInputBlock,
  PlatformObservation,
  PlatformPort,
} from './adapter.js';
import {
  AgyCatalog,
  type AgyDiscoveredSession,
  type AgyTranscriptMessage,
} from './agy-catalog.js';
import type { AgyQuotaClient } from './agy-quota.js';
import {
  AgyAcpTransport,
  type AgyAcpNotification,
  type AgyEffortLevel,
  type AgyServerRequest,
} from './agy-transport.js';
import {
  payloadDigest,
  type Answer,
  type Artifact,
  type Capabilities,
  type Interaction,
  type Message,
  type ModelOption,
  type NativeSessionRef,
  type Page,
  type Session,
  type SessionSnapshot,
  type Turn,
  type TurnResidual,
} from './contracts.js';
import { contractError } from './errors.js';
import { textAttachmentBlock } from './text-attachment.js';
import { imageMediaType } from '../image-media.js';

export const AGY_REASONING_EFFORTS: readonly AgyEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const DEFAULT_AGY_MODELS: readonly ModelOption[] = [
  { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'gemini-4-neon', label: 'Gemini 4 Neon', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
];

const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60_000;
const LIST_SNAPSHOT_TTL_MS = 120_000;
const MAX_LIST_SNAPSHOTS = 8;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EFFORT_SUFFIX_RE = /^(.*?)(?:-tiered)?-(low|medium|high|xhigh|max)$/i;

const available = { status: 'available' as const };
const unsupported = (reason: string) => ({ status: 'unsupported' as const, reason });
const readCaps: Capabilities = {
  view: available,
  send: unsupported('discovered agy session is read-only until attached'),
  queue: unsupported('discovered agy session is read-only until attached'),
  steer: unsupported('steer is available only for Codex'),
  answer: unsupported('discovered agy session is read-only until attached'),
  approve: unsupported('discovered agy session is read-only until attached'),
  interrupt: unsupported('discovered agy session is read-only until attached'),
  handoff: unsupported('agy ACP does not support live terminal handoff'),
  files: available,
  config: unsupported('discovered agy session is read-only until attached'),
};
const liveCaps: Capabilities = {
  view: available,
  send: available,
  queue: unsupported('queue is coordinated by unified core'),
  steer: unsupported('steer is available only for Codex'),
  answer: available,
  approve: available,
  interrupt: available,
  handoff: unsupported('agy ACP does not support live terminal handoff'),
  files: available,
  config: available,
};

type Obj = Record<string, unknown>;

type LiveSessionMeta = {
  cwd: string;
  title: string;
  updatedAt?: string;
  createdAt?: string;
  models?: ModelOption[];
  effortConfigId?: string;
};

type ActiveTurnState = {
  turnId: string;
  generation: number;
  model: string | null;
  startedAt: string;
  assistantMessageId: string | null;
  assistantSequence: number | null;
  assistantRevision: number;
  assistantText: string;
  assistantFinalized: boolean;
  interrupted: boolean;
  inProgressToolCalls: Set<string>;
};

type PendingAgyRequest = {
  rpcId: string | number;
  generation: number;
  toolCallId: string | null;
  interaction: Interaction;
  allowOptionId: string;
  denyOptionId: string;
  propertyTypes: Record<string, string>;
  answer: Answer | null;
};

type ListSnapshot = {
  items: Session[];
  expires: number;
};

const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isRecord = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

const ack = (nativeReference: string | null = null): PlatformAcknowledgement => ({
  status: 'submitted',
  nativeReference,
});

/** Strip trailing effort suffix (e.g. `-xhigh`, `-tiered-xhigh`) before passing model ID to CLI/ACP. */
export function stripAgyModelEffortSuffix(model: string): {
  baseModel: string;
  extractedEffort: AgyEffortLevel | null;
} {
  const trimmed = model.trim();
  const match = EFFORT_SUFFIX_RE.exec(trimmed);
  if (!match || !match[1]) {
    return { baseModel: trimmed, extractedEffort: null };
  }
  return {
    baseModel: match[1],
    extractedEffort: match[2]!.toLowerCase() as AgyEffortLevel,
  };
}

function formatSessionTitle(baseTitle: string, subagentCount: number): string {
  if (subagentCount > 0) {
    return `${baseTitle} (${subagentCount} 子代理)`;
  }
  return baseTitle;
}

function extractTextFromUpdateContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isRecord(content)) {
    if (content.type === 'text' && typeof content.text === 'string') return content.text;
    if (typeof content.text === 'string' && !content.type) return content.text;
    return '';
  }
  if (Array.isArray(content)) {
    return content
      .map(item =>
        isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '',
      )
      .join('');
  }
  return '';
}

function extractSchemaChoices(prop: Obj): string[] {
  if (Array.isArray(prop.enum)) {
    return prop.enum.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  }
  if (Array.isArray(prop.oneOf)) {
    return prop.oneOf
      .map(item =>
        isRecord(item)
          ? typeof item.const === 'string'
            ? item.const
            : typeof item.title === 'string'
              ? item.title
              : ''
          : '',
      )
      .filter(s => s.trim().length > 0);
  }
  if (isRecord(prop.items)) {
    return extractSchemaChoices(prop.items);
  }
  return [];
}

function convertSchemaValue(rawValue: string, propType: string | undefined): unknown {
  if (propType === 'boolean') {
    if (rawValue === 'true') return true;
    if (rawValue === 'false') return false;
  }
  if (propType === 'number' || propType === 'integer') {
    const n = Number(rawValue);
    if (Number.isFinite(n)) return propType === 'integer' ? Math.trunc(n) : n;
  }
  return rawValue;
}

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
  private readonly recentDiscovery = new Map<
    string,
    { watermark: number; buffer: Session[]; done: boolean; expires: number }
  >();
  private readonly existingSnapshots = new Map<string, { ids: string[]; expires: number }>();

  private sequence = 0;
  private closed = false;

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

    const prevNotification = transport.onNotification;
    const prevServerRequest = transport.onServerRequest;
    const prevDisconnect = transport.onDisconnect;

    transport.onNotification = notification => {
      try {
        prevNotification(notification);
      } catch {}
      this.handleNotification(notification);
    };

    transport.onServerRequest = req => {
      try {
        prevServerRequest(req);
      } catch {}
      this.handleServerRequest(req);
    };

    transport.onDisconnect = (generation, reason) => {
      try {
        prevDisconnect(generation, reason);
      } catch {}
      this.handleDisconnect(generation, reason);
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
    this.expireAllPending(this.transport.connectionGeneration || null);
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
    const baseTitle = summary?.title || liveMeta?.title || `Antigravity 会话 · ${id.slice(0, 8)}`;
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

  private mergeAllSessions(): Array<Session & { subagentCount?: number }> {
    const catalogSessions = this.catalog.refresh();
    const merged = new Map<string, Session & { subagentCount?: number }>();

    for (const s of catalogSessions) {
      merged.set(s.conversationId, this.buildSession(s.conversationId, s, this.knownSessions.get(s.conversationId)));
    }
    for (const [id, meta] of this.knownSessions) {
      if (!merged.has(id)) {
        merged.set(id, this.buildSession(id, null, meta));
      }
    }

    return [...merged.values()];
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

  async list(cursor: string | null, limit: number): Promise<Page<Session>> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw contractError('invalid_request', 'invalid limit');
    }
    this.pruneSnapshots();

    let items: Session[];
    let snapshotKey: string;
    let offset = 0;

    if (cursor === null) {
      items = this.mergeAllSessions();
      snapshotKey = randomUUID();
      if (items.length > limit) {
        while (this.listSnapshots.size >= MAX_LIST_SNAPSHOTS) {
          this.listSnapshots.delete(this.listSnapshots.keys().next().value!);
        }
        this.listSnapshots.set(snapshotKey, { items, expires: Date.now() + LIST_SNAPSHOT_TTL_MS });
      }
    } else {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        throw contractError('snapshot_required', 'invalid cursor');
      }
      if (
        !isRecord(decoded) ||
        !isString(decoded.snapshotKey) ||
        typeof decoded.offset !== 'number' ||
        !Number.isSafeInteger(decoded.offset) ||
        decoded.offset < 0
      ) {
        throw contractError('snapshot_required', 'invalid cursor');
      }
      const snap = this.listSnapshots.get(decoded.snapshotKey);
      if (!snap || decoded.offset > snap.items.length) {
        throw contractError('snapshot_required', 'expired or invalid cursor');
      }
      snapshotKey = decoded.snapshotKey;
      items = snap.items;
      offset = decoded.offset;
    }

    const end = Math.min(offset + limit, items.length);
    const nextCursor =
      end < items.length
        ? Buffer.from(JSON.stringify({ snapshotKey, offset: end }), 'utf8').toString('base64url')
        : null;

    return {
      items: items.slice(offset, end).map(item => structuredClone(item)),
      nextCursor,
    };
  }

  private async resolveCreatedAtIso(summary: AgyDiscoveredSession): Promise<string | undefined> {
    try {
      const transcript = await this.catalog.readTranscript(summary.conversationId);
      for (const step of transcript.steps) {
        if (step.createdAt) return step.createdAt;
      }
    } catch {
      // Fallback to DB timestamps when transcript is unavailable.
    }
    return summary.lastUserInputAt ?? summary.lastModifiedAt ?? undefined;
  }

  async discoverExisting(cursor: string | null, limit: number): Promise<Page<Session>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw contractError('invalid_request', 'invalid limit');
    }
    this.pruneSnapshots();

    let snapshotKey: string;
    let ids: string[];
    let offset = 0;

    if (cursor === null) {
      const all = this.catalog
        .refresh()
        .filter(s => s.isTopLevel && s.projectAllowed && s.project !== '' && (s.stepCount > 0 || s.lastModifiedAt !== null));
      ids = all.map(s => s.conversationId);
      snapshotKey = randomUUID();
      if (ids.length > limit) {
        while (this.existingSnapshots.size >= MAX_LIST_SNAPSHOTS) {
          this.existingSnapshots.delete(this.existingSnapshots.keys().next().value!);
        }
        this.existingSnapshots.set(snapshotKey, { ids, expires: Date.now() + LIST_SNAPSHOT_TTL_MS });
      }
    } else {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        throw contractError('snapshot_required', 'invalid cursor');
      }
      if (
        !isRecord(decoded) ||
        !isString(decoded.snapshotKey) ||
        typeof decoded.offset !== 'number' ||
        !Number.isSafeInteger(decoded.offset) ||
        decoded.offset < 0
      ) {
        throw contractError('snapshot_required', 'invalid cursor');
      }
      const snap = this.existingSnapshots.get(decoded.snapshotKey);
      if (!snap || decoded.offset > snap.ids.length) {
        throw contractError('snapshot_required', 'expired cursor');
      }
      snapshotKey = decoded.snapshotKey;
      ids = snap.ids;
      offset = decoded.offset;
    }

    const end = Math.min(offset + limit, ids.length);
    const items: Session[] = [];
    let partialFailure = false;

    for (const id of ids.slice(offset, end)) {
      const summary = this.catalog.get(id);
      if (!summary) {
        partialFailure = true;
        continue;
      }
      const createdAt = await this.resolveCreatedAtIso(summary);
      if (!createdAt) continue;
      items.push({
        ...this.buildSession(id, summary, undefined, createdAt),
        status: 'read_only',
        capabilities: readCaps,
        control: {
          serviceId: this.serviceId,
          owner: null,
          input: 'unavailable',
          generation: this.controlEpoch.get(id) ?? 0,
          operationId: null,
          reason: 'discovered agy session is read-only until attached',
        },
      });
    }

    const nextCursor =
      end < ids.length
        ? Buffer.from(JSON.stringify({ snapshotKey, offset: end }), 'utf8').toString('base64url')
        : null;

    return {
      items,
      nextCursor,
      ...(partialFailure ? { partialFailure: true } : {}),
    };
  }

  async discoverNewer(watermark: number, cursor: string | null, limit: number): Promise<Page<Session>> {
    if (
      !Number.isSafeInteger(watermark) ||
      watermark < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw contractError('invalid_request', 'invalid discoverNewer query');
    }
    this.pruneSnapshots();

    const key = cursor ?? randomUUID();
    let state = this.recentDiscovery.get(key);

    if (cursor === null) {
      const buffer: Session[] = [];
      const observedAt = new Date().toISOString();
      const summaries = this.catalog.refresh();

      for (const summary of summaries) {
        if (!summary.isTopLevel || !summary.projectAllowed || !summary.project) continue;
        const modMs = summary.lastModifiedAt ? Date.parse(summary.lastModifiedAt) : NaN;
        const inputMs = summary.lastUserInputAt ? Date.parse(summary.lastUserInputAt) : NaN;
        const latestMs = Number.isFinite(modMs) ? modMs : inputMs;
        if (!Number.isFinite(latestMs) || latestMs <= watermark) continue;

        const createdAt = await this.resolveCreatedAtIso(summary);
        if (!createdAt) continue;
        const createdMs = Date.parse(createdAt);
        if (!Number.isFinite(createdMs) || createdMs <= watermark) continue;

        buffer.push({
          ...this.buildSession(summary.conversationId, summary, undefined, createdAt),
          discoveryObservedAt: observedAt,
          status: 'read_only',
          capabilities: readCaps,
          control: {
            serviceId: this.serviceId,
            owner: null,
            input: 'unavailable',
            generation: this.controlEpoch.get(summary.conversationId) ?? 0,
            operationId: null,
            reason: 'discovered agy session is read-only until attached',
          },
        });
      }

      state = {
        watermark,
        buffer,
        done: true,
        expires: Date.now() + LIST_SNAPSHOT_TTL_MS,
      };
      if (this.recentDiscovery.size >= 4) {
        this.recentDiscovery.delete(this.recentDiscovery.keys().next().value!);
      }
      this.recentDiscovery.set(key, state);
    }

    if (!state || state.watermark !== watermark) {
      if (cursor) this.recentDiscovery.delete(key);
      throw contractError('snapshot_required', 'stale or invalid discoverNewer cursor');
    }

    state.expires = Date.now() + LIST_SNAPSHOT_TTL_MS;
    const items = state.buffer.splice(0, limit);
    const nextCursor = state.done && state.buffer.length === 0 ? null : key;
    if (nextCursor === null) {
      this.recentDiscovery.delete(key);
    }

    return { items, nextCursor };
  }

  async discoverRunning(cursor: string | null, limit: number): Promise<Page<Session>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw contractError('invalid_request', 'invalid limit');
    }
    this.pruneSnapshots();
    if (cursor !== null) {
      throw contractError('snapshot_required', 'invalid cursor');
    }

    const summaries = this.catalog.refresh();
    const items: Session[] = [];
    for (const s of summaries) {
      if (!s.isTopLevel || !s.projectAllowed || !s.project) continue;
      const isRunning =
        (!s.killed &&
          (s.status === 'running' ||
            s.status === 'busy' ||
            s.status === 'canceling' ||
            s.notFullyIdle ||
            s.activeSubagentCount > 0)) ||
        this.activeTurns.has(s.conversationId);
      if (!isRunning) continue;
      items.push({
        ...this.buildSession(s.conversationId, s),
        status: 'read_only',
        capabilities: readCaps,
        control: {
          serviceId: this.serviceId,
          owner: null,
          input: 'unavailable',
          generation: this.controlEpoch.get(s.conversationId) ?? 0,
          operationId: null,
          reason: 'discovered agy session is read-only until attached',
        },
      });
    }

    return { items: items.slice(0, limit), nextCursor: null };
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
    const id = this.check(ref);
    if (!Number.isSafeInteger(watermark) || !Number.isSafeInteger(observed) || watermark >= observed) {
      return { status: 'unknown' };
    }

    this.catalog.refresh();
    const summary = this.catalog.get(id);
    if (!summary || !summary.isTopLevel || !summary.projectAllowed || !summary.project) {
      return { status: 'unknown' };
    }

    let transcript;
    try {
      transcript = await this.catalog.readTranscript(id);
    } catch {
      return { status: 'unknown' };
    }

    if (transcript.parseErrors > 0 || transcript.truncatedTrailingLine) {
      return { status: 'unknown' };
    }

    for (const step of transcript.steps) {
      const ts = step.createdAt ? Date.parse(step.createdAt) : NaN;
      if (Number.isFinite(ts) && ts > observed) {
        return { status: 'future' };
      }
    }

    const oldMessageIds: string[] = [];
    const newMessageIds: string[] = [];
    const oldTurns: Turn[] = [];
    const newTurns: Turn[] = [];
    let lastTs = 0;
    let seenNew = false;

    for (const msg of transcript.messages) {
      const ts = msg.createdAt ? Date.parse(msg.createdAt) : NaN;
      if (!Number.isFinite(ts) || ts <= 0 || ts === watermark || ts < lastTs) {
        return { status: 'unknown' };
      }
      if (ts > observed) {
        return { status: 'future' };
      }
      lastTs = ts;
      const turnId = msg.stepIndex !== null ? `step-${msg.stepIndex}` : `line-${msg.lineNumber}`;
      const turn: Turn = {
        turnId,
        sessionId: id,
        status: msg.final ? 'completed' : 'running',
        inputId: msg.role === 'user' ? msg.messageId : null,
        startedAt: msg.createdAt,
        endedAt: msg.final ? msg.createdAt : null,
        model: msg.model,
        outputIds: msg.role === 'assistant' ? [msg.messageId] : [],
      };
      if (ts > watermark) {
        if (!msg.final) return { status: 'unknown' };
        seenNew = true;
        newMessageIds.push(msg.messageId);
        newTurns.push(turn);
      } else {
        if (seenNew || !msg.final) return { status: 'unknown' };
        oldMessageIds.push(msg.messageId);
        oldTurns.push(turn);
      }
    }

    const newSet = new Set(newMessageIds);
    const hasNewFinalAssistant = transcript.messages.some(
      m => newSet.has(m.messageId) && m.role === 'assistant' && m.final && m.text.trim().length > 0,
    );
    if (!seenNew || !hasNewFinalAssistant) {
      return { status: 'unknown' };
    }

    const createdAt = await this.resolveCreatedAtIso(summary);
    const session = {
      ...this.buildSession(id, summary, undefined, createdAt),
      status: 'read_only' as const,
      capabilities: readCaps,
    };
    const messages = transcript.messages.map((m, idx) => this.normalizeTranscriptMessage(id, m, idx + 1));

    return {
      status: 'proven',
      snapshot: {
        session,
        messages,
        turns: newTurns,
        interactions: [],
      },
      oldMessageIds,
      newMessageIds,
      oldTurns,
    };
  }

  private normalizeTranscriptMessage(
    id: string,
    m: AgyTranscriptMessage,
    sequence: number,
  ): Message {
    return {
      messageId: m.messageId,
      sessionId: id,
      turnId: m.stepIndex !== null ? `step-${m.stepIndex}` : `line-${m.lineNumber}`,
      role: m.role,
      blocks: [{ type: 'text', text: m.text }],
      sequence,
      revision: 1,
      final: m.final,
      source: 'agy',
    };
  }

  async read(ref: NativeSessionRef): Promise<SessionSnapshot> {
    const id = this.check(ref);
    this.catalog.refresh();
    const summary = this.catalog.get(id);
    const liveMeta = this.knownSessions.get(id);
    if (!summary && !liveMeta) {
      throw contractError('invalid_request', 'agy session not found');
    }

    let transcriptMessages: Message[] = [];
    let createdAt: string | undefined;
    try {
      const transcript = await this.catalog.readTranscript(id);
      transcriptMessages = transcript.messages.map((m, i) =>
        this.normalizeTranscriptMessage(id, m, i + 1),
      );
      createdAt = transcript.steps.find(s => s.createdAt)?.createdAt ?? undefined;
    } catch {
      // Fresh ACP session may not yet have a transcript directory on disk.
    }

    const live = this.liveMessages.get(id) ?? [];
    const liveIds = new Set(live.map(m => m.messageId));
    const historyVisible = transcriptMessages.filter(m => !liveIds.has(m.messageId));
    const baseSeq = historyVisible.length;
    const mergedLive = live.map((m, idx) => ({
      ...m,
      sequence: Math.max(m.sequence, baseSeq + idx + 1),
    }));

    const isActive = this.active.has(id) && this.transport.connected;
    const session = this.buildSession(id, summary, liveMeta, createdAt);
    const turns = [...(this.sessionTurns.get(id)?.values() ?? [])].map(t => ({ ...t }));
    const interactions = [...this.requests.values()]
      .map(r => r.interaction)
      .filter(i => i.sessionId === id);

    return {
      session,
      messages: [...historyVisible, ...mergedLive],
      turns,
      interactions,
      ...(isActive ? { connectionGeneration: this.transport.connectionGeneration } : {}),
    };
  }

  private captureServerSessionMeta(id: string, cwd: string, res: unknown): void {
    const existing = this.knownSessions.get(id);
    const meta: LiveSessionMeta = {
      cwd,
      title: existing?.title ?? `Antigravity 会话 · ${id.slice(0, 8)}`,
      updatedAt: new Date().toISOString(),
      ...(existing?.createdAt ? { createdAt: existing.createdAt } : {}),
      ...(existing?.models ? { models: existing.models } : {}),
      ...(existing?.effortConfigId ? { effortConfigId: existing.effortConfigId } : {}),
    };

    if (isRecord(res)) {
      if (isRecord(res.models) && Array.isArray(res.models.availableModels)) {
        const parsedModels = this.normalizeServerModels(res.models.availableModels);
        if (parsedModels.length > 0) meta.models = parsedModels;
      }
      if (Array.isArray(res.configOptions)) {
        const thoughtOpt = this.findEffortConfigId(res.configOptions);
        if (thoughtOpt) meta.effortConfigId = thoughtOpt;
      }
    }

    this.knownSessions.set(id, meta);
  }

  private findEffortConfigId(configOptions: unknown[]): string | undefined {
    for (const opt of configOptions) {
      if (!isRecord(opt) || !isString(opt.id)) continue;
      if (
        opt.category === 'thought_level' ||
        opt.id === 'thought_level' ||
        opt.id === 'reasoning_effort' ||
        opt.id === 'effort'
      ) {
        return opt.id;
      }
    }
    return undefined;
  }

  private normalizeServerModels(rawModels: unknown[]): ModelOption[] {
    const byId = new Map<string, ModelOption>();
    for (const raw of rawModels) {
      if (!isRecord(raw) || !isString(raw.modelId)) continue;
      const { baseModel } = stripAgyModelEffortSuffix(raw.modelId);
      if (!baseModel || byId.has(baseModel)) continue;
      const label = isString(raw.name) ? raw.name : baseModel;
      byId.set(baseModel, {
        id: baseModel,
        label,
        reasoningEfforts: [...AGY_REASONING_EFFORTS],
      });
    }
    return [...byId.values()];
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

    const promptBlocks: Array<
      { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
    > = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        if (!block.text.trim()) {
          throw contractError('invalid_request', 'empty text block');
        }
        promptBlocks.push({ type: 'text', text: block.text });
        continue;
      }

      if (
        !(block.content instanceof Uint8Array) ||
        block.content.length === 0 ||
        block.content.length > MAX_ATTACHMENT_BYTES
      ) {
        throw contractError('invalid_request', 'invalid attachment size');
      }
      const bytes = Buffer.from(block.content);
      if (block.mediaType === 'text/plain') {
        let text: string;
        try {
          text = textAttachmentBlock(block.name, bytes, MAX_ATTACHMENT_BYTES);
        } catch {
          throw contractError('invalid_request', 'invalid text attachment');
        }
        promptBlocks.push({ type: 'text', text });
        continue;
      }

      const detected = imageMediaType(bytes);
      if (!detected) {
        if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mediaType)) {
          throw contractError('invalid_request', 'image signature does not match MIME');
        }
        throw contractError('unsupported', 'unsupported attachment type');
      }
      if (detected !== block.mediaType) {
        throw contractError('invalid_request', 'image signature does not match MIME');
      }
      promptBlocks.push({
        type: 'image',
        mimeType: detected,
        data: bytes.toString('base64'),
      });
    }

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

    this.emit({ type: 'message', ref, message: userMsg, connectionGeneration: generation });
    this.emit({ type: 'turn', ref, turn: runningTurn, connectionGeneration: generation });

    const promptPromise = this.transport.request(
      'session/prompt',
      { sessionId: id, prompt: promptBlocks },
      DEFAULT_PROMPT_TIMEOUT_MS,
    );

    void promptPromise.then(
      rawResult => this.handlePromptCompleted(id, turnState, rawResult),
      error => this.handlePromptFailed(id, turnState, error),
    );

    return ack(turnId);
  }

  private handlePromptCompleted(id: string, turnState: ActiveTurnState, rawResult: unknown): void {
    if (this.closed || this.activeTurns.get(id) !== turnState) return;
    if (this.transport.connectionGeneration !== turnState.generation) return;

    this.activeTurns.delete(id);
    const ref = this.ref(id);
    const res = isRecord(rawResult) ? rawResult : {};
    const stopReason = typeof res.stopReason === 'string' ? res.stopReason : 'end_turn';

    if (!turnState.assistantFinalized) {
      if (turnState.assistantMessageId && turnState.assistantText) {
        turnState.assistantFinalized = true;
        const finalMsg: Message = {
          messageId: turnState.assistantMessageId,
          sessionId: id,
          turnId: turnState.turnId,
          role: 'assistant',
          blocks: [{ type: 'text', text: turnState.assistantText }],
          sequence: turnState.assistantSequence ?? ++this.sequence,
          revision: ++turnState.assistantRevision,
          final: true,
          source: 'agy',
        };
        this.upsertLiveMessage(id, finalMsg);
        this.emit({
          type: 'message',
          ref,
          message: finalMsg,
          connectionGeneration: turnState.generation,
        });
      } else if (typeof res.response === 'string' && res.response.trim()) {
        const messageId = turnState.assistantMessageId ?? randomUUID();
        const seq = turnState.assistantSequence ?? ++this.sequence;
        turnState.assistantMessageId = messageId;
        turnState.assistantSequence = seq;
        turnState.assistantText = res.response;
        turnState.assistantFinalized = true;
        const finalMsg: Message = {
          messageId,
          sessionId: id,
          turnId: turnState.turnId,
          role: 'assistant',
          blocks: [{ type: 'text', text: res.response }],
          sequence: seq,
          revision: ++turnState.assistantRevision,
          final: true,
          source: 'agy',
        };
        this.upsertLiveMessage(id, finalMsg);
        this.emit({
          type: 'message',
          ref,
          message: finalMsg,
          connectionGeneration: turnState.generation,
        });
      }
    }

    this.resolvePendingDeliveredRequests(id, turnState.generation);

    const status: Turn['status'] =
      turnState.interrupted || stopReason === 'cancelled'
        ? 'interrupted'
        : stopReason === 'error'
          ? 'failed'
          : 'completed';
    const endedAt = new Date().toISOString();
    const turn: Turn = {
      turnId: turnState.turnId,
      sessionId: id,
      status,
      inputId: turnState.turnId,
      startedAt: turnState.startedAt,
      endedAt,
      model: turnState.model,
      outputIds: turnState.assistantMessageId ? [turnState.assistantMessageId] : [],
    };
    this.putSessionTurn(id, turn);
    this.emit({ type: 'turn', ref, turn, connectionGeneration: turnState.generation });
  }

  private handlePromptFailed(id: string, turnState: ActiveTurnState, error: unknown): void {
    if (this.closed || this.activeTurns.get(id) !== turnState) return;
    this.activeTurns.delete(id);
    if (this.transport.connectionGeneration !== turnState.generation) return;

    const ref = this.ref(id);
    const now = new Date().toISOString();
    const seq = ++this.sequence;
    const message =
      isRecord(error) && typeof error.message === 'string' ? error.message : 'ACP prompt failed';

    this.emit({
      type: 'event',
      ref,
      connectionGeneration: turnState.generation,
      event: {
        schemaVersion: 1,
        eventId: randomUUID(),
        sessionId: id,
        objectId: turnState.turnId,
        objectRevision: 0,
        sequence: seq,
        type: 'adapter.stream_failed',
        occurredAt: now,
        receivedAt: now,
        operationId: null,
        cursor: String(seq),
        data: { reason: message },
      },
    });

    const turn: Turn = {
      turnId: turnState.turnId,
      sessionId: id,
      status: turnState.interrupted ? 'interrupted' : 'failed',
      inputId: turnState.turnId,
      startedAt: turnState.startedAt,
      endedAt: now,
      model: turnState.model,
      outputIds: turnState.assistantMessageId ? [turnState.assistantMessageId] : [],
    };
    this.putSessionTurn(id, turn);
    this.emit({ type: 'turn', ref, turn, connectionGeneration: turnState.generation });
  }

  private resolvePendingDeliveredRequests(sessionId: string, generation: number): void {
    for (const req of this.requests.values()) {
      if (
        req.interaction.sessionId === sessionId &&
        req.generation === generation &&
        req.interaction.status === 'answer_pending_delivery'
      ) {
        req.interaction = {
          ...req.interaction,
          status: 'resolved',
          revision: req.interaction.revision + 1,
          nativeResult: {
            status: 'accepted',
            source: 'agy_acp',
            answer: req.answer,
          },
        };
        this.emitInteraction(req.interaction);
      }
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

  private handleNotification(notification: AgyAcpNotification): void {
    if (this.closed || notification.generation !== this.transport.connectionGeneration) return;
    if (notification.method !== 'session/update' || !isRecord(notification.params)) return;

    const params = notification.params;
    const sessionId = isString(params.sessionId) ? params.sessionId : null;
    if (!sessionId || !this.active.has(sessionId)) return;

    const update = isRecord(params.update) ? params.update : null;
    if (!update) return;

    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
    const ref = this.ref(sessionId);

    if (kind === 'config_option_update' && Array.isArray(update.configOptions)) {
      const thoughtOpt = this.findEffortConfigId(update.configOptions);
      const meta = this.knownSessions.get(sessionId);
      if (meta && thoughtOpt) meta.effortConfigId = thoughtOpt;
      return;
    }

    if (kind === 'session_info_update' && isString(update.title)) {
      const meta = this.knownSessions.get(sessionId);
      if (meta) meta.title = update.title;
      return;
    }

    const turnState = this.activeTurns.get(sessionId);
    if (!turnState || turnState.generation !== notification.generation) return;

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const toolCallId = isString(update.toolCallId) ? update.toolCallId : null;
      const status = typeof update.status === 'string' ? update.status : '';
      if (toolCallId) {
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          turnState.inProgressToolCalls.delete(toolCallId);
        } else {
          turnState.inProgressToolCalls.add(toolCallId);
        }
      }
      this.resolvePendingDeliveredRequests(sessionId, notification.generation);
      return;
    }

    if (kind === 'agent_message_chunk') {
      const chunkText = extractTextFromUpdateContent(update.content);
      if (!chunkText) return;

      this.resolvePendingDeliveredRequests(sessionId, notification.generation);

      if (turnState.assistantFinalized) return;
      if (!turnState.assistantMessageId) {
        turnState.assistantMessageId = isString(update.messageId) ? update.messageId : randomUUID();
        turnState.assistantSequence = ++this.sequence;
      }
      turnState.assistantText += chunkText;
      const msg: Message = {
        messageId: turnState.assistantMessageId,
        sessionId,
        turnId: turnState.turnId,
        role: 'assistant',
        blocks: [{ type: 'text', text: turnState.assistantText }],
        sequence: turnState.assistantSequence!,
        revision: ++turnState.assistantRevision,
        final: false,
        source: 'agy',
      };
      this.upsertLiveMessage(sessionId, msg);
      this.emit({
        type: 'message',
        ref,
        message: msg,
        connectionGeneration: notification.generation,
      });
    }
  }

  private handleServerRequest(req: AgyServerRequest): void {
    if (this.closed || req.generation !== this.transport.connectionGeneration) return;
    if (!isRecord(req.params)) return;

    const p = req.params;
    const sessionId = isString(p.sessionId) ? p.sessionId : null;
    if (!sessionId || !this.active.has(sessionId)) return;

    const turnId = this.activeTurns.get(sessionId)?.turnId ?? '';
    const interactionId = randomUUID();
    const base = {
      interactionId,
      sessionId,
      turnId,
      nativeRequestId: interactionId,
      connectionGeneration: req.generation,
      revision: 1,
      status: 'awaiting_answer' as const,
      expiresAt: null,
      nativeResult: null,
    };

    if (req.method === 'session/request_permission') {
      const toolCall = isRecord(p.toolCall) ? p.toolCall : {};
      const rawOptions = Array.isArray(p.options) ? p.options.filter(isRecord) : [];
      const allowOpt =
        rawOptions.find(o => o.kind === 'allow_once' || o.kind === 'allow_always') ??
        rawOptions.find(o => isString(o.optionId) && /allow/i.test(o.optionId)) ??
        rawOptions[0];
      const denyOpt =
        rawOptions.find(o => o.kind === 'reject_once' || o.kind === 'reject_always') ??
        rawOptions.find(o => isString(o.optionId) && /reject|deny/i.test(o.optionId));

      const allowOptionId = isString(allowOpt?.optionId) ? allowOpt.optionId : 'allow_once';
      const denyOptionId = isString(denyOpt?.optionId) ? denyOpt.optionId : 'reject_once';

      const toolLabel =
        (isString(toolCall.title) && toolCall.title) ||
        (isString(toolCall.kind) && toolCall.kind) ||
        (isString(toolCall.toolCallId) && toolCall.toolCallId) ||
        'agy_tool';

      const interaction: Interaction = {
        ...base,
        kind: 'approval',
        tool: toolLabel,
        action: JSON.stringify(toolCall),
        scope: 'this_request',
        toolInputDigest: payloadDigest(p),
      };

      const entry: PendingAgyRequest = {
        rpcId: req.rpcId,
        generation: req.generation,
        toolCallId: isString(toolCall.toolCallId) ? toolCall.toolCallId : null,
        interaction,
        allowOptionId,
        denyOptionId,
        propertyTypes: {},
        answer: null,
      };
      this.requests.set(interactionId, entry);
      this.emitInteraction(interaction);
      return;
    }

    if (req.method === 'elicitation/create') {
      const promptMessage = isString(p.message) ? p.message : '请提供输入';
      const schema = isRecord(p.requestedSchema) ? p.requestedSchema : {};
      const props = isRecord(schema.properties) ? schema.properties : {};
      const propEntries = Object.entries(props).filter(([, val]) => isRecord(val)) as Array<[string, Obj]>;

      const hasSecretField =
        p.mode === 'url' ||
        propEntries.some(([, prop]) => prop.format === 'password' || prop.writeOnly === true);
      if (hasSecretField) {
        const now = new Date().toISOString();
        const sequence = ++this.sequence;
        this.emit({
          type: 'event',
          ref: this.ref(sessionId),
          connectionGeneration: req.generation,
          event: {
            schemaVersion: 1,
            eventId: randomUUID(),
            sessionId,
            objectId: isString(p.toolCallId) ? p.toolCallId : interactionId,
            objectRevision: 0,
            sequence,
            type: 'interaction.unsupported',
            occurredAt: now,
            receivedAt: now,
            operationId: null,
            cursor: String(sequence),
            data: { reason: 'URL or secret elicitation is unsupported' },
          },
        });
        return;
      }

      const propertyTypes: Record<string, string> = {};
      let interaction: Interaction;

      if (propEntries.length > 0) {
        const questions = propEntries.map(([id, prop]) => {
          if (typeof prop.type === 'string') propertyTypes[id] = prop.type;
          const choices = extractSchemaChoices(prop);
          const prompt =
            (isString(prop.description) && prop.description) ||
            (isString(prop.title) && prop.title) ||
            (propEntries.length === 1 ? `${promptMessage} (${id})` : id);
          return {
            id,
            prompt,
            choices,
            multiple: prop.type === 'array' ? true : false,
            allowFreeText: choices.length === 0 || prop.type === 'string' || !prop.type,
          };
        });
        interaction = {
          ...base,
          kind: 'question_group',
          toolInputDigest: null,
          questions,
        };
      } else {
        interaction = {
          ...base,
          kind: 'question',
          toolInputDigest: null,
          prompt: promptMessage,
          choices: [],
          multiple: false,
          allowFreeText: true,
        };
      }

      const entry: PendingAgyRequest = {
        rpcId: req.rpcId,
        generation: req.generation,
        toolCallId: isString(p.toolCallId) ? p.toolCallId : null,
        interaction,
        allowOptionId: 'allow_once',
        denyOptionId: 'reject_once',
        propertyTypes,
        answer: null,
      };
      this.requests.set(interactionId, entry);
      this.emitInteraction(interaction);
    }
  }

  private expireAllPending(generation: number | null): void {
    for (const entry of this.requests.values()) {
      if (generation !== null && entry.generation !== generation) continue;
      if (
        entry.interaction.status === 'awaiting_answer' ||
        entry.interaction.status === 'answer_pending_delivery'
      ) {
        entry.interaction = {
          ...entry.interaction,
          status: 'expired',
          revision: entry.interaction.revision + 1,
          nativeResult:
            entry.interaction.status === 'answer_pending_delivery'
              ? { status: 'unknown', source: 'connection_closed' }
              : null,
        };
        this.emitInteraction(entry.interaction);
      }
    }
  }

  private handleDisconnect(generation: number, reason: string): void {
    if (this.closed) return;

    const previouslyActive = [...this.active];
    this.active.clear();
    for (const id of previouslyActive) {
      this.controlEpoch.set(id, (this.controlEpoch.get(id) ?? 0) + 1);
      const summary = this.catalog.get(id);
      const meta = this.knownSessions.get(id);
      if (summary || meta) {
        this.emit({
          type: 'session',
          ref: this.ref(id),
          session: this.buildSession(id, summary, meta),
        });
      }
    }

    for (const [id, turnState] of this.activeTurns) {
      if (turnState.generation !== generation) continue;
      this.activeTurns.delete(id);
      const now = new Date().toISOString();
      const seq = ++this.sequence;
      const ref = this.ref(id);
      this.emit({
        type: 'event',
        ref,
        connectionGeneration: generation,
        event: {
          schemaVersion: 1,
          eventId: randomUUID(),
          sessionId: id,
          objectId: turnState.turnId,
          objectRevision: 0,
          sequence: seq,
          type: 'adapter.stream_failed',
          occurredAt: now,
          receivedAt: now,
          operationId: null,
          cursor: String(seq),
          data: { reason },
        },
      });
      const turn: Turn = {
        turnId: turnState.turnId,
        sessionId: id,
        status: turnState.interrupted ? 'interrupted' : 'failed',
        inputId: turnState.turnId,
        startedAt: turnState.startedAt,
        endedAt: now,
        model: turnState.model,
        outputIds: turnState.assistantMessageId ? [turnState.assistantMessageId] : [],
      };
      this.putSessionTurn(id, turn);
      this.emit({ type: 'turn', ref, turn, connectionGeneration: generation });
    }

    this.expireAllPending(generation);
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
    const id = this.check(ref);
    const req = this.requests.get(interaction.interactionId);
    const current = req?.interaction;

    if (
      !req ||
      !current ||
      current.sessionId !== id ||
      req.generation !== this.transport.connectionGeneration ||
      req.generation !== guard.expectedConnectionGeneration ||
      current.status !== 'awaiting_answer'
    ) {
      throw contractError('interaction_expired');
    }
    if (!this.active.has(id) || !this.transport.connected) {
      throw contractError('control_conflict', 'session is not connected');
    }
    if (
      interaction.nativeRequestId !== current.nativeRequestId ||
      interaction.connectionGeneration !== current.connectionGeneration ||
      interaction.kind !== current.kind ||
      interaction.toolInputDigest !== current.toolInputDigest ||
      interaction.status !== 'awaiting_answer'
    ) {
      throw contractError('stale_revision');
    }

    let result: unknown;
    if (
      current.kind === 'approval' &&
      answer.kind === 'approval' &&
      answer.scope === current.scope &&
      (answer.decision === 'allow' || answer.decision === 'deny')
    ) {
      result = {
        outcome: {
          optionId: answer.decision === 'allow' ? req.allowOptionId : req.denyOptionId,
        },
      };
    } else if (
      current.kind === 'question' &&
      answer.kind === 'question' &&
      Array.isArray(answer.values) &&
      answer.values.length > 0 &&
      answer.values.every(v => typeof v === 'string' && v.trim().length > 0)
    ) {
      result = {
        action: 'accept',
        content: {
          answer: answer.values.join(', '),
        },
      };
    } else if (
      current.kind === 'question_group' &&
      answer.kind === 'question_group' &&
      Object.keys(answer.answers).length === current.questions.length &&
      current.questions.every(q => {
        const vals = answer.answers[q.id];
        return (
          Array.isArray(vals) &&
          vals.length > 0 &&
          vals.every(v => typeof v === 'string' && v.trim().length > 0) &&
          new Set(vals).size === vals.length
        );
      })
    ) {
      const content: Record<string, unknown> = {};
      for (const q of current.questions) {
        const vals = answer.answers[q.id]!;
        const propType = req.propertyTypes[q.id];
        content[q.id] =
          propType === 'array' ? vals : convertSchemaValue(vals.join(', '), propType);
      }
      result = {
        action: 'accept',
        content,
      };
    } else {
      throw contractError('invalid_request', 'answer does not match interaction schema');
    }

    guard.assertCurrent();

    req.answer = answer;
    req.interaction = {
      ...current,
      status: 'answer_pending_delivery',
      revision: current.revision + 1,
    };
    this.transport.respondServerRequest(req.generation, req.rpcId, result);
    this.emitInteraction(req.interaction);
    return ack();
  }

  async listArtifacts(ref: NativeSessionRef): Promise<Artifact[]> {
    const id = this.check(ref);
    try {
      const entries = await this.catalog.listArtifacts(id);
      return entries.map(entry => ({
        artifactId: entry.artifactId,
        sessionId: id,
        name: entry.name,
        mediaType: entry.mediaType,
        size: entry.size,
        contentVersion: entry.contentVersion,
      }));
    } catch (error) {
      throw contractError(
        'invalid_request',
        error instanceof Error ? error.message : 'failed to list agy artifacts',
      );
    }
  }

  async readArtifact(
    ref: NativeSessionRef,
    artifactId: string,
    expectedVersion: string,
  ): Promise<Uint8Array> {
    const id = this.check(ref);
    if (!isString(artifactId) || !isString(expectedVersion)) {
      throw contractError('invalid_request', 'artifactId and expectedVersion required');
    }

    let entries;
    try {
      entries = await this.catalog.listArtifacts(id);
    } catch (error) {
      throw contractError(
        'invalid_request',
        error instanceof Error ? error.message : 'failed to access agy artifacts',
      );
    }

    const match = entries.find(entry => entry.artifactId === artifactId);
    if (match) {
      try {
        const res = await this.catalog.readArtifact(id, match.relativePath, expectedVersion);
        return res.content;
      } catch (error) {
        throw contractError(
          'invalid_request',
          error instanceof Error ? error.message : 'failed to read agy artifact',
        );
      }
    }

    // Never bypass allowlist for opaque artifact hashes; if caller supplied a relative path,
    // let AgyCatalog validate allowlist and security exclusions (e.g. .system_generated/, symlinks).
    if (/^[a-f0-9]{64}$/i.test(artifactId)) {
      throw contractError('invalid_request', 'agy artifact not found');
    }

    try {
      const res = await this.catalog.readArtifact(id, artifactId, expectedVersion);
      return res.content;
    } catch (error) {
      throw contractError(
        'invalid_request',
        error instanceof Error ? error.message : 'agy artifact rejected by security policy',
      );
    }
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
