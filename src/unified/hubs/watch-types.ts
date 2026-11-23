import type { Identity } from '../contracts.js';
import { contractError } from '../errors.js';
import type { ChannelCard } from '../feishu-cards.js';
import type { FeishuPort } from '../feishu-channel.js';
import { StoreError } from '../store.js';

export const WATCH_SOURCES = [
  'watch',
  'stopwatch',
  'claude_waiting',
  'claude_stop_failure',
  'codex_status',
  'agy_status',
] as const;

export type WatchSource = (typeof WATCH_SOURCES)[number];

export const WATCH_STATES = ['alert', 'waiting', 'failed', 'recovered', 'info'] as const;
export type WatchState = (typeof WATCH_STATES)[number];

export const WATCH_SEVERITIES = ['low', 'normal', 'high'] as const;
export type WatchSeverity = (typeof WATCH_SEVERITIES)[number];

export interface WatchSourceRef {
  sessionId?: string;
  taskId?: string;
  destination?: string;
}

export interface WatchEvent {
  eventId: string;
  source: WatchSource;
  objectId: string;
  state: WatchState;
  occurredAt: string;
  severity: WatchSeverity;
  title: string;
  summary: string;
  sourceRef?: WatchSourceRef;
}

export type WatchHubPort = Pick<FeishuPort, 'send' | 'update'> &
  Partial<Pick<FeishuPort, 'createTopic' | 'lookupDelivery' | 'lookupMessageId' | 'topicLinkForSession'>> & {
    lookupTopicDestination?: (deliveryId: string) => Promise<string | null>;
  };

export interface WatchCallAuth {
  owner?: Identity;
  destination?: string;
}

export interface WatchHubOptions {
  dbPath: string;
  owner: Identity;
  destination: string;
  allowedDestinations?: ReadonlySet<string>;
  allowedSources?: ReadonlySet<WatchSource>;
  allowedSourceDestinations?: ReadonlySet<string>;
  port: WatchHubPort;
  rootKey?: string;
  topicTitle?: string;
  coalesceWindowMs?: number;
  resolveTopicLink?: (ref: WatchSourceRef, targetDestination: string) => Promise<string | null> | string | null;
  authorizeTarget?: (owner: Identity, destination: string, source: WatchSource) => Promise<boolean> | boolean;
  now?: () => number;
}

export interface WatchRootRecord {
  hubKey: string;
  owner: Identity;
  chatDestination: string;
  topicDestination: string | null;
  rootMessageId: string | null;
  creationDeliveryId: string;
  state: 'unknown' | 'active' | 'rejected';
  hadUnknownHistory: boolean;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

export interface WatchIngestResult {
  status: 'accepted' | 'duplicate' | 'coalesced' | 'stale_ignored';
  eventId: string;
  outboxId: string;
  objectId: string;
  source: WatchSource;
  state: WatchState;
}

export interface WatchDeliveryResult {
  outboxId: string;
  objectId: string;
  action: 'send' | 'update';
  status: 'sent' | 'unknown';
  messageId: string | null;
  hadUnknown: boolean;
}

export interface WatchOutboxRecord {
  outboxId: string;
  objectId: string;
  source: WatchSource;
  action: 'send' | 'update';
  deliveryId: string;
  targetMessageId: string | null;
  latestEventId: string;
  latestOccurredMs: number;
  currentState: WatchState;
  severity: WatchSeverity;
  card: ChannelCard;
  eventCount: number;
  coalescedCount: number;
  hadUnknown: boolean;
  state: 'pending' | 'sending' | 'sent' | 'unknown' | 'superseded';
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WatchRootRow {
  hub_key: string;
  owner_source: string;
  owner_subject: string;
  chat_destination: string;
  topic_destination: string | null;
  root_message_id: string | null;
  creation_delivery_id: string;
  state: 'unknown' | 'active' | 'rejected';
  had_unknown_history: number;
  created_at: number;
  updated_at: number;
  last_error: string | null;
}

export interface WatchOutboxRow {
  outbox_id: string;
  object_id: string;
  source: WatchSource;
  action: 'send' | 'update';
  delivery_id: string;
  target_message_id: string | null;
  latest_event_id: string;
  latest_occurred_ms: number;
  current_state: WatchState;
  severity: WatchSeverity;
  card_json: string;
  event_count: number;
  coalesced_count: number;
  had_unknown: number;
  state: 'pending' | 'sending' | 'sent' | 'unknown' | 'superseded';
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export const DEFAULT_WATCH_ROOT_KEY = 'watch-hub:singleton';
export const DEFAULT_WATCH_TOPIC_TITLE = '看守与运行提醒';
export const DEFAULT_COALESCE_WINDOW_MS = 60_000;

export const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function fail(code: Parameters<typeof contractError>[0], message: string): never {
  throw new StoreError(contractError(code, message));
}

export function isAuthorizedWatchSource(
  source: unknown,
  allowedSources: ReadonlySet<WatchSource> = new Set(WATCH_SOURCES),
): source is WatchSource {
  return (
    typeof source === 'string' &&
    (WATCH_SOURCES as readonly string[]).includes(source) &&
    allowedSources.has(source as WatchSource)
  );
}

export function validateWatchEvent(
  event: WatchEvent,
  allowedSources: ReadonlySet<WatchSource> = new Set(WATCH_SOURCES),
): { occurredMs: number; normalizedRef: WatchSourceRef | null } {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    fail('invalid_request', 'watch event must be an object');
  }
  if (!nonempty(event.eventId)) fail('invalid_request', 'eventId is required');
  if (!nonempty(event.objectId)) fail('invalid_request', 'objectId is required');
  if (!nonempty(event.title)) fail('invalid_request', 'title is required');
  if (!nonempty(event.summary)) fail('invalid_request', 'summary is required');
  if (!nonempty(event.source)) fail('invalid_request', 'source is required');
  if (!isAuthorizedWatchSource(event.source, allowedSources)) {
    fail('unauthorized', `unauthorized watch source: ${event.source}`);
  }
  if (!(WATCH_STATES as readonly string[]).includes(event.state)) {
    fail('invalid_request', `invalid watch state: ${String(event.state)}`);
  }
  if (!(WATCH_SEVERITIES as readonly string[]).includes(event.severity)) {
    fail('invalid_request', `invalid watch severity: ${String(event.severity)}`);
  }
  const occurredMs = Date.parse(event.occurredAt);
  if (!nonempty(event.occurredAt) || !Number.isFinite(occurredMs)) {
    fail('invalid_request', 'occurredAt must be a valid timestamp');
  }
  let normalizedRef: WatchSourceRef | null = null;
  if (event.sourceRef !== undefined) {
    if (!event.sourceRef || typeof event.sourceRef !== 'object' || Array.isArray(event.sourceRef)) {
      fail('invalid_request', 'sourceRef must be an object');
    }
    const ref: WatchSourceRef = {};
    if (event.sourceRef.sessionId !== undefined) {
      if (!nonempty(event.sourceRef.sessionId)) fail('invalid_request', 'sourceRef.sessionId must be non-empty');
      ref.sessionId = event.sourceRef.sessionId;
    }
    if (event.sourceRef.taskId !== undefined) {
      if (!nonempty(event.sourceRef.taskId)) fail('invalid_request', 'sourceRef.taskId must be non-empty');
      ref.taskId = event.sourceRef.taskId;
    }
    if (event.sourceRef.destination !== undefined) {
      if (!nonempty(event.sourceRef.destination)) fail('invalid_request', 'sourceRef.destination must be non-empty');
      ref.destination = event.sourceRef.destination;
    }
    if (Object.keys(ref).length > 0) normalizedRef = ref;
  }
  return { occurredMs, normalizedRef };
}

export function mapWatchRootRow(row: WatchRootRow): WatchRootRecord {
  return {
    hubKey: row.hub_key,
    owner: { source: row.owner_source, subject: row.owner_subject },
    chatDestination: row.chat_destination,
    topicDestination: row.topic_destination,
    rootMessageId: row.root_message_id,
    creationDeliveryId: row.creation_delivery_id,
    state: row.state,
    hadUnknownHistory: row.had_unknown_history === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}

export function mapWatchOutboxRow(row: WatchOutboxRow): WatchOutboxRecord {
  return {
    outboxId: row.outbox_id,
    objectId: row.object_id,
    source: row.source,
    action: row.action,
    deliveryId: row.delivery_id,
    targetMessageId: row.target_message_id,
    latestEventId: row.latest_event_id,
    latestOccurredMs: row.latest_occurred_ms,
    currentState: row.current_state,
    severity: row.severity,
    card: JSON.parse(row.card_json) as ChannelCard,
    eventCount: row.event_count,
    coalescedCount: row.coalesced_count,
    hadUnknown: row.had_unknown === 1,
    state: row.state,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
