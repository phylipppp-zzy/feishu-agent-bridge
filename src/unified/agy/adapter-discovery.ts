import { randomUUID } from 'node:crypto';
import type { AgyDiscoveredSession } from '../agy-catalog.js';
import type {
  Artifact,
  Message,
  NativeSessionRef,
  Page,
  Session,
  SessionSnapshot,
  Turn,
} from '../contracts.js';
import { contractError } from '../errors.js';
import {
  isRecord,
  isString,
  LIST_SNAPSHOT_TTL_MS,
  MAX_LIST_SNAPSHOTS,
  normalizeTranscriptMessage,
  readCaps,
  type AdapterContext,
} from './adapter-types.js';
import { agyPromptText, reconcileAgyReply } from './transcript-reconciliation.js';

async function mergeAllSessions(ctx: AdapterContext): Promise<Array<Session & { subagentCount?: number }>> {
  const catalogSessions = await ctx.catalog.refreshAsync();
  const merged = new Map<string, Session & { subagentCount?: number }>();

  for (const s of catalogSessions) {
    merged.set(s.conversationId, ctx.buildSession(s.conversationId, s, ctx.knownSessions.get(s.conversationId)));
  }
  for (const [id, meta] of ctx.knownSessions) {
    if (!merged.has(id)) {
      merged.set(id, ctx.buildSession(id, null, meta));
    }
  }

  return [...merged.values()];
}

export async function listSessions(
  ctx: AdapterContext,
  cursor: string | null,
  limit: number,
): Promise<Page<Session>> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw contractError('invalid_request', 'invalid limit');
  }
  ctx.pruneSnapshots();

  let items: Session[];
  let snapshotKey: string;
  let offset = 0;

  if (cursor === null) {
    items = await mergeAllSessions(ctx);
    snapshotKey = randomUUID();
    if (items.length > limit) {
      while (ctx.listSnapshots.size >= MAX_LIST_SNAPSHOTS) {
        ctx.listSnapshots.delete(ctx.listSnapshots.keys().next().value!);
      }
      ctx.listSnapshots.set(snapshotKey, { items, expires: Date.now() + LIST_SNAPSHOT_TTL_MS });
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
    const snap = ctx.listSnapshots.get(decoded.snapshotKey);
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

export async function resolveCreatedAtIso(
  ctx: AdapterContext,
  summary: AgyDiscoveredSession,
): Promise<string | undefined> {
  try {
    const transcript = await ctx.catalog.readTranscript(summary.conversationId);
    for (const step of transcript.steps) {
      if (step.createdAt) return step.createdAt;
    }
  } catch {
    // Fallback to DB timestamps when transcript is unavailable.
  }
  return summary.lastUserInputAt ?? summary.lastModifiedAt ?? undefined;
}

export async function discoverExistingSessions(
  ctx: AdapterContext,
  cursor: string | null,
  limit: number,
): Promise<Page<Session>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw contractError('invalid_request', 'invalid limit');
  }
  ctx.pruneSnapshots();

  let snapshotKey: string;
  let ids: string[];
  let offset = 0;

  if (cursor === null) {
    const all = (await ctx.catalog.refreshAsync())
      .filter(s => s.isTopLevel && s.projectAllowed && s.project !== '' && (s.stepCount > 0 || s.lastModifiedAt !== null));
    ids = all.map(s => s.conversationId);
    snapshotKey = randomUUID();
    if (ids.length > limit) {
      while (ctx.existingSnapshots.size >= MAX_LIST_SNAPSHOTS) {
        ctx.existingSnapshots.delete(ctx.existingSnapshots.keys().next().value!);
      }
      ctx.existingSnapshots.set(snapshotKey, { ids, expires: Date.now() + LIST_SNAPSHOT_TTL_MS });
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
    const snap = ctx.existingSnapshots.get(decoded.snapshotKey);
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
    const summary = ctx.catalog.get(id);
    if (!summary) {
      partialFailure = true;
      continue;
    }
    const createdAt = await resolveCreatedAtIso(ctx, summary);
    if (!createdAt) continue;
    items.push({
      ...ctx.buildSession(id, summary, undefined, createdAt),
      status: 'read_only',
      capabilities: readCaps,
      control: {
        serviceId: ctx.serviceId,
        owner: null,
        input: 'unavailable',
        generation: ctx.controlEpoch.get(id) ?? 0,
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

export async function discoverNewerSessions(
  ctx: AdapterContext,
  watermark: number,
  cursor: string | null,
  limit: number,
): Promise<Page<Session>> {
  if (
    !Number.isSafeInteger(watermark) ||
    watermark < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw contractError('invalid_request', 'invalid discoverNewer query');
  }
  ctx.pruneSnapshots();

  const key = cursor ?? randomUUID();
  let state = ctx.recentDiscovery.get(key);

  if (cursor === null) {
    const buffer: Session[] = [];
    const observedAt = new Date().toISOString();
    const summaries = await ctx.catalog.refreshAsync();

    for (const summary of summaries) {
      if (!summary.isTopLevel || !summary.projectAllowed || !summary.project) continue;
      const modMs = summary.lastModifiedAt ? Date.parse(summary.lastModifiedAt) : NaN;
      const inputMs = summary.lastUserInputAt ? Date.parse(summary.lastUserInputAt) : NaN;
      const latestMs = Number.isFinite(modMs) ? modMs : inputMs;
      if (!Number.isFinite(latestMs) || latestMs <= watermark) continue;

      const createdAt = await resolveCreatedAtIso(ctx, summary);
      if (!createdAt) continue;
      const createdMs = Date.parse(createdAt);
      if (!Number.isFinite(createdMs) || createdMs <= watermark) continue;

      buffer.push({
        ...ctx.buildSession(summary.conversationId, summary, undefined, createdAt),
        discoveryObservedAt: observedAt,
        status: 'read_only',
        capabilities: readCaps,
        control: {
          serviceId: ctx.serviceId,
          owner: null,
          input: 'unavailable',
          generation: ctx.controlEpoch.get(summary.conversationId) ?? 0,
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
    if (ctx.recentDiscovery.size >= 4) {
      ctx.recentDiscovery.delete(ctx.recentDiscovery.keys().next().value!);
    }
    ctx.recentDiscovery.set(key, state);
  }

  if (!state || state.watermark !== watermark) {
    if (cursor) ctx.recentDiscovery.delete(key);
    throw contractError('snapshot_required', 'stale or invalid discoverNewer cursor');
  }

  state.expires = Date.now() + LIST_SNAPSHOT_TTL_MS;
  const items = state.buffer.splice(0, limit);
  const nextCursor = state.done && state.buffer.length === 0 ? null : key;
  if (nextCursor === null) {
    ctx.recentDiscovery.delete(key);
  }

  return { items, nextCursor };
}

export async function discoverRunningSessions(
  ctx: AdapterContext,
  cursor: string | null,
  limit: number,
): Promise<Page<Session>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw contractError('invalid_request', 'invalid limit');
  }
  ctx.pruneSnapshots();
  if (cursor !== null) {
    throw contractError('snapshot_required', 'invalid cursor');
  }

  const summaries = await ctx.catalog.refreshAsync();
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
      ctx.activeTurns.has(s.conversationId);
    if (!isRunning) continue;
    items.push({
      ...ctx.buildSession(s.conversationId, s),
      status: 'read_only',
      capabilities: readCaps,
      control: {
        serviceId: ctx.serviceId,
        owner: null,
        input: 'unavailable',
        generation: ctx.controlEpoch.get(s.conversationId) ?? 0,
        operationId: null,
        reason: 'discovered agy session is read-only until attached',
      },
    });
  }

  return { items: items.slice(0, limit), nextCursor: null };
}

export async function readAutoActivityForSession(
  ctx: AdapterContext,
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
  const id = ctx.check(ref);
  if (!Number.isSafeInteger(watermark) || !Number.isSafeInteger(observed) || watermark >= observed) {
    return { status: 'unknown' };
  }

  await ctx.catalog.refreshAsync();
  const summary = ctx.catalog.get(id);
  if (!summary || !summary.isTopLevel || !summary.projectAllowed || !summary.project) {
    return { status: 'unknown' };
  }

  let transcript;
  try {
    transcript = await ctx.catalog.readTranscript(id);
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

  const createdAt = await resolveCreatedAtIso(ctx, summary);
  const session = {
    ...ctx.buildSession(id, summary, undefined, createdAt),
    status: 'read_only' as const,
    capabilities: readCaps,
  };
  const messages = transcript.messages.map((m, idx) => normalizeTranscriptMessage(id, m, idx + 1));

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

function visibleTranscript(
  ctx: AdapterContext,
  id: string,
  transcript: readonly Message[],
  live: readonly Message[],
): Message[] {
  const baseline = ctx.preLiveTranscriptIds.get(id);
  const liveIds = new Set(live.map(message => message.messageId));
  const prompts = live.filter(message => message.role === 'user');
  const assistants = new Map(live.filter(message => message.role === 'assistant').map(message => [message.turnId, message]));
  const visible: Message[] = [];
  let nextPrompt = 0;
  let counterpart: Message | undefined;
  let pendingCounterpart = false;
  let nativeReply: Message[] = [];

  const settleReply = () => {
    if (counterpart) {
      const reply = reconcileAgyReply(counterpart, nativeReply, true);
      if (reply !== counterpart) ctx.upsertLiveMessage(id, reply);
    }
    nativeReply = [];
    counterpart = undefined;
    pendingCounterpart = false;
  };

  for (const message of transcript) {
    if (message.role === 'user' || baseline?.has(message.messageId)) settleReply();
    if (baseline && !baseline.has(message.messageId)) {
      if (message.role === 'user') {
        const text = agyPromptText(message);
        // Match only rows written after the baseline. Keep unmatched native turns visible.
        const index = prompts.findIndex((prompt, i) => i >= nextPrompt &&
          (agyPromptText(prompt) === text || !message.final && agyPromptText(prompt).startsWith(text)));
        if (index >= 0) {
          nextPrompt = index + 1;
          const turnId = prompts[index]!.turnId;
          counterpart = assistants.get(turnId);
          pendingCounterpart = ctx.activeTurns.get(id)?.turnId === turnId;
          continue;
        }
      } else if (message.role === 'assistant' && (counterpart || pendingCounterpart)) {
        nativeReply.push(message);
        continue;
      }
    }
    if (!liveIds.has(message.messageId)) visible.push(message);
  }
  settleReply();
  return visible;
}

export async function readSessionSnapshot(
  ctx: AdapterContext,
  ref: NativeSessionRef,
): Promise<SessionSnapshot> {
  const id = ctx.check(ref);
  if (!ctx.knownSessions.has(id)) await ctx.catalog.refreshAsync();
  const summary = ctx.catalog.get(id);
  const liveMeta = ctx.knownSessions.get(id);
  if (!summary && !liveMeta) {
    throw contractError('invalid_request', 'agy session not found');
  }

  let transcriptMessages: Message[] = [];
  let createdAt: string | undefined;
  try {
    const transcript = await ctx.catalog.readTranscript(id);
    transcriptMessages = transcript.messages.map((m, i) =>
      normalizeTranscriptMessage(id, m, i + 1),
    );
    createdAt = transcript.steps.find(s => s.createdAt)?.createdAt ?? undefined;
  } catch {
    // Fresh ACP session may not yet have a transcript directory on disk.
  }

  const live = ctx.liveMessages.get(id) ?? [];
  const historyVisible = visibleTranscript(ctx, id, transcriptMessages, live);
  const baseSeq = historyVisible.length;
  const mergedLive = live.map((m, idx) => ({
    ...m,
    sequence: Math.max(m.sequence, baseSeq + idx + 1),
  }));

  const isActive = ctx.active.has(id) && ctx.transport.connected;
  const session = ctx.buildSession(id, summary, liveMeta, createdAt);
  const turns = [...(ctx.sessionTurns.get(id)?.values() ?? [])].map(t => ({ ...t }));
  const interactions = [...ctx.requests.values()]
    .map(r => r.interaction)
    .filter(i => i.sessionId === id);

  return {
    session,
    messages: [...historyVisible, ...mergedLive],
    turns,
    interactions,
    ...(isActive ? { connectionGeneration: ctx.transport.connectionGeneration } : {}),
  };
}

export async function listSessionArtifacts(
  ctx: AdapterContext,
  ref: NativeSessionRef,
): Promise<Artifact[]> {
  const id = ctx.check(ref);
  try {
    const entries = await ctx.catalog.listArtifacts(id);
    return entries.map(entry => ({
      artifactId: entry.artifactId,
      sessionId: id,
      name: entry.name,
      mediaType: entry.mediaType,
      size: entry.size,
      contentVersion: entry.contentVersion,
      relativePath: `会话产物/${entry.relativePath}`,
    }));
  } catch (error) {
    throw contractError(
      'invalid_request',
      error instanceof Error ? error.message : 'failed to list agy artifacts',
    );
  }
}

export async function readSessionArtifact(
  ctx: AdapterContext,
  ref: NativeSessionRef,
  artifactId: string,
  expectedVersion: string,
): Promise<Uint8Array> {
  const id = ctx.check(ref);
  if (!isString(artifactId) || !isString(expectedVersion)) {
    throw contractError('invalid_request', 'artifactId and expectedVersion required');
  }

  let entries;
  try {
    entries = await ctx.catalog.listArtifacts(id);
  } catch (error) {
    throw contractError(
      'invalid_request',
      error instanceof Error ? error.message : 'failed to access agy artifacts',
    );
  }

  const match = entries.find(entry => entry.artifactId === artifactId);
  if (match) {
    try {
      const res = await ctx.catalog.readArtifact(id, match.relativePath, expectedVersion);
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
    const res = await ctx.catalog.readArtifact(id, artifactId, expectedVersion);
    return res.content;
  } catch (error) {
    throw contractError(
      'invalid_request',
      error instanceof Error ? error.message : 'agy artifact rejected by security policy',
    );
  }
}
