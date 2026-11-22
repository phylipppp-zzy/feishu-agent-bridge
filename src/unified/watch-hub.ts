import { DatabaseSync } from 'node:sqlite';
import { payloadDigest, type Identity } from './contracts.js';
import { contractError } from './errors.js';
import type { ChannelCard } from './feishu-cards.js';
import type { FeishuPort } from './feishu-channel.js';
import { StoreError } from './store.js';

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

const DEFAULT_ROOT_KEY = 'watch-hub:singleton';
const DEFAULT_TOPIC_TITLE = '看守与运行提醒';
const DEFAULT_COALESCE_WINDOW_MS = 60_000;

const SOURCE_LABELS: Record<WatchSource, string> = {
  watch: '看守 (watch)',
  stopwatch: '停训看守 (stopwatch)',
  claude_waiting: 'Claude 等待 (claude_waiting)',
  claude_stop_failure: 'Claude 异常停止 (claude_stop_failure)',
  codex_status: 'Codex 状态 (codex_status)',
  agy_status: 'Antigravity 状态 (agy_status)',
};

const STATE_LABELS: Record<WatchState, string> = {
  alert: '告警',
  waiting: '等待处理',
  failed: '异常失败',
  recovered: '已恢复',
  info: '运行提示',
};

const SEVERITY_LABELS: Record<WatchSeverity, string> = {
  low: '低',
  normal: '普通',
  high: '高',
};

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function fail(code: Parameters<typeof contractError>[0], message: string): never {
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

function isSafeAppLink(url: string | null | undefined): url is string {
  if (!url || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' && ['applink.feishu.cn', 'applink.larksuite.com'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

interface RootRow {
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

interface OutboxRow {
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

/**
 * N1: Fixed single-owner, single-root Watch & Runtime Alert Hub.
 * Isolated from ordinary weekly reports and legacy watch execution privileges.
 */
export class WatchHub {
  private readonly db: DatabaseSync;
  private readonly owner: Identity;
  private readonly destination: string;
  private readonly allowedDestinations: ReadonlySet<string> | null;
  private readonly allowedSources: ReadonlySet<WatchSource>;
  private readonly allowedSourceDestinations: ReadonlySet<string> | null;
  private readonly port: WatchHubPort;
  private readonly rootKey: string;
  private readonly topicTitle: string;
  private readonly coalesceWindowMs: number;
  private readonly resolveTopicLink:
    | ((ref: WatchSourceRef, targetDestination: string) => Promise<string | null> | string | null)
    | undefined;
  private readonly authorizeTarget:
    | ((owner: Identity, destination: string, source: WatchSource) => Promise<boolean> | boolean)
    | undefined;
  private readonly now: () => number;

  constructor(options: WatchHubOptions) {
    if (!options || !nonempty(options.dbPath)) fail('invalid_request', 'dbPath is required');
    if (!options.owner || !nonempty(options.owner.source) || !nonempty(options.owner.subject)) {
      fail('invalid_request', 'single fixed owner identity is required');
    }
    if (!nonempty(options.destination)) fail('invalid_request', 'destination is required');
    this.owner = { source: options.owner.source, subject: options.owner.subject };
    this.destination = options.destination;
    this.allowedDestinations = options.allowedDestinations ?? null;
    this.allowedSources = options.allowedSources ?? new Set(WATCH_SOURCES);
    this.allowedSourceDestinations = options.allowedSourceDestinations ?? null;
    this.port = options.port;
    this.rootKey = options.rootKey?.trim() || DEFAULT_ROOT_KEY;
    this.topicTitle = options.topicTitle?.trim() || DEFAULT_TOPIC_TITLE;
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    if (!Number.isFinite(this.coalesceWindowMs) || this.coalesceWindowMs < 0) {
      fail('invalid_request', 'coalesceWindowMs must be a non-negative finite number');
    }
    this.resolveTopicLink = options.resolveTopicLink;
    this.authorizeTarget = options.authorizeTarget;
    this.now = options.now ?? (() => Date.now());

    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS watch_hub_roots_v1 (
        hub_key TEXT PRIMARY KEY,
        owner_source TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        chat_destination TEXT NOT NULL,
        topic_destination TEXT,
        root_message_id TEXT,
        creation_delivery_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        had_unknown_history INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS watch_hub_events_v1 (
        event_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        object_id TEXT NOT NULL,
        state TEXT NOT NULL,
        severity TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        occurred_ms INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_ref TEXT,
        payload_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        outbox_id TEXT,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watch_hub_outbox_v1 (
        outbox_id TEXT PRIMARY KEY,
        object_id TEXT NOT NULL,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        delivery_id TEXT NOT NULL UNIQUE,
        target_message_id TEXT,
        latest_event_id TEXT NOT NULL,
        latest_occurred_ms INTEGER NOT NULL,
        current_state TEXT NOT NULL,
        severity TEXT NOT NULL,
        card_json TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 1,
        coalesced_count INTEGER NOT NULL DEFAULT 0,
        had_unknown INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private mapRootRow(row: RootRow): WatchRootRecord {
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

  private mapOutboxRow(row: OutboxRow): WatchOutboxRecord {
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

  private checkCallerAuth(auth?: WatchCallAuth): void {
    if (auth?.owner) {
      if (auth.owner.source !== this.owner.source || auth.owner.subject !== this.owner.subject) {
        fail('unauthorized', 'watch hub owner mismatch');
      }
    }
    const targetDest = auth?.destination ?? this.destination;
    if (targetDest !== this.destination) {
      fail('unauthorized', `unauthorized watch hub destination: ${targetDest}`);
    }
    if (this.allowedDestinations && !this.allowedDestinations.has(targetDest)) {
      fail('unauthorized', `destination not in watch hub allowlist: ${targetDest}`);
    }
  }

  private async checkEventAuth(
    event: WatchEvent,
    normalizedRef: WatchSourceRef | null,
    auth?: WatchCallAuth,
  ): Promise<void> {
    this.checkCallerAuth(auth);
    if (normalizedRef?.destination && this.allowedSourceDestinations) {
      if (!this.allowedSourceDestinations.has(normalizedRef.destination)) {
        fail('unauthorized', `unauthorized sourceRef destination: ${normalizedRef.destination}`);
      }
    }
    if (this.authorizeTarget) {
      const ok = await this.authorizeTarget(this.owner, this.destination, event.source);
      if (!ok) fail('unauthorized', 'watch target authorization denied');
    }
  }

  getRoot(): WatchRootRecord | null {
    const row = this.db
      .prepare('SELECT * FROM watch_hub_roots_v1 WHERE hub_key=?')
      .get(this.rootKey) as RootRow | undefined;
    return row ? this.mapRootRow(row) : null;
  }

  listOutbox(objectId?: string): WatchOutboxRecord[] {
    const rows = (
      objectId
        ? this.db.prepare('SELECT * FROM watch_hub_outbox_v1 WHERE object_id=? ORDER BY rowid').all(objectId)
        : this.db.prepare('SELECT * FROM watch_hub_outbox_v1 ORDER BY rowid').all()
    ) as unknown as OutboxRow[];
    return rows.map((r) => this.mapOutboxRow(r));
  }

  /**
   * Ensures the single fixed Watch Hub root exists and is active.
   * If a prior creation ended in `unknown`, never creates a second root topic.
   */
  async ensureRoot(auth?: WatchCallAuth): Promise<WatchRootRecord> {
    this.checkCallerAuth(auth);
    const now = this.now();
    const deliveryId = `watch-root:${payloadDigest([
      this.rootKey,
      this.owner.source,
      this.owner.subject,
      this.destination,
    ])}`;

    let existingState: 'new' | 'active' | 'unknown' | 'rejected' = 'new';
    let existingRow: RootRow | undefined;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      existingRow = this.db
        .prepare('SELECT * FROM watch_hub_roots_v1 WHERE hub_key=?')
        .get(this.rootKey) as RootRow | undefined;
      if (existingRow) {
        if (
          existingRow.owner_source !== this.owner.source ||
          existingRow.owner_subject !== this.owner.subject ||
          existingRow.chat_destination !== this.destination
        ) {
          fail('unauthorized', 'watch hub root identity mismatch');
        }
        existingState = existingRow.state;
      } else {
        const otherRoot = this.db.prepare('SELECT hub_key FROM watch_hub_roots_v1 LIMIT 1').get() as
          | { hub_key: string }
          | undefined;
        if (otherRoot) {
          fail('control_conflict', 'singleton watch hub root already exists');
        }
        this.db
          .prepare(
            `INSERT INTO watch_hub_roots_v1(
              hub_key, owner_source, owner_subject, chat_destination,
              topic_destination, root_message_id, creation_delivery_id,
              state, had_unknown_history, created_at, updated_at, last_error
            ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'unknown', 0, ?, ?, NULL)`,
          )
          .run(this.rootKey, this.owner.source, this.owner.subject, this.destination, deliveryId, now, now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    if (existingState === 'active' && existingRow) {
      return this.mapRootRow(existingRow);
    }
    if (existingState === 'unknown') {
      fail('outcome_unknown', 'watch hub root creation outcome unknown; refusing to create duplicate root');
    }
    if (existingState === 'rejected') {
      fail('temporarily_unavailable', 'watch hub root creation was previously rejected');
    }

    const rootCard: ChannelCard = {
      title: this.topicTitle,
      text: '看守与运行提醒统一话题（仅限受控看守与状态事件，普通周报独立通知）。',
      actions: [],
    };
    const guard = async () => {
      this.checkCallerAuth(auth);
      const current = this.getRoot();
      if (!current || current.creationDeliveryId !== deliveryId || current.state !== 'unknown') {
        fail('control_conflict', 'watch hub root state changed during creation');
      }
    };

    try {
      if (this.port.createTopic) {
        const topicDestination = await this.port.createTopic(
          this.destination,
          this.rootKey,
          rootCard,
          deliveryId,
          guard,
        );
        if (!nonempty(topicDestination)) {
          throw new Error('empty topic destination returned');
        }
        const msgId = (await this.port.lookupMessageId?.(deliveryId)) ?? null;
        this.db
          .prepare(
            `UPDATE watch_hub_roots_v1
             SET state='active', topic_destination=?, root_message_id=COALESCE(?, root_message_id), updated_at=?, last_error=NULL
             WHERE hub_key=? AND state='unknown'`,
          )
          .run(topicDestination, msgId, this.now(), this.rootKey);
      } else {
        let messageId = (await this.port.send(this.destination, rootCard, deliveryId, guard)) || null;
        if (!messageId) {
          messageId = (await this.port.lookupMessageId?.(deliveryId)) ?? null;
        }
        if (!messageId) {
          throw new Error('empty root message id returned');
        }
        this.db
          .prepare(
            `UPDATE watch_hub_roots_v1
             SET state='active', topic_destination=?, root_message_id=?, updated_at=?, last_error=NULL
             WHERE hub_key=? AND state='unknown'`,
          )
          .run(this.destination, messageId, this.now(), this.rootKey);
      }
      return this.getRoot()!;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.db
        .prepare(
          `UPDATE watch_hub_roots_v1
           SET had_unknown_history=1, last_error=?, updated_at=?
           WHERE hub_key=? AND state='unknown'`,
        )
        .run(msg, this.now(), this.rootKey);
      if (error instanceof StoreError) throw error;
      fail('outcome_unknown', `watch hub root creation outcome unknown: ${msg}`);
    }
  }

  /**
   * Reconciles an unknown root via lookupDelivery/lookupMessageId without ever creating a second root.
   */
  async reconcileRoot(auth?: WatchCallAuth): Promise<WatchRootRecord | null> {
    this.checkCallerAuth(auth);
    const root = this.getRoot();
    if (!root) return null;
    if (root.state !== 'unknown') return root;
    const deliveryState = (await this.port.lookupDelivery?.(root.creationDeliveryId)) ?? 'unknown';
    if (deliveryState !== 'sent') return this.getRoot();
    const msgId = (await this.port.lookupMessageId?.(root.creationDeliveryId)) ?? root.rootMessageId;
    const topicDest = (await this.port.lookupTopicDestination?.(root.creationDeliveryId)) ?? null;
    if (topicDest) {
      this.db
        .prepare(
          `UPDATE watch_hub_roots_v1
           SET state='active', topic_destination=?, root_message_id=COALESCE(?, root_message_id), had_unknown_history=1, updated_at=?, last_error=NULL
           WHERE hub_key=? AND state='unknown'`,
        )
        .run(topicDest, msgId, this.now(), this.rootKey);
    } else if (!this.port.createTopic && msgId) {
      this.db
        .prepare(
          `UPDATE watch_hub_roots_v1
           SET state='active', topic_destination=?, root_message_id=?, had_unknown_history=1, updated_at=?, last_error=NULL
           WHERE hub_key=? AND state='unknown'`,
        )
        .run(this.destination, msgId, this.now(), this.rootKey);
    }
    return this.getRoot();
  }

  private renderCard(params: {
    event: WatchEvent;
    normalizedRef: WatchSourceRef | null;
    previousState: WatchState | null;
    eventCount: number;
    coalescedCount: number;
    hadUnknown: boolean;
    topicUrl: string | null;
  }): ChannelCard {
    const { event, normalizedRef, previousState, eventCount, coalescedCount, hadUnknown, topicUrl } = params;
    const lines: string[] = [
      `来源: ${SOURCE_LABELS[event.source]}`,
      `对象: ${event.objectId}`,
      `状态: ${STATE_LABELS[event.state]} (${event.state})${previousState && previousState !== event.state ? ` <- 原状态: ${STATE_LABELS[previousState]} (${previousState})` : ''}`,
      `级别: ${SEVERITY_LABELS[event.severity]} (${event.severity})`,
      `时间: ${event.occurredAt}`,
      `摘要: ${event.summary}`,
    ];
    if (normalizedRef) {
      const refParts: string[] = [];
      if (normalizedRef.sessionId) refParts.push(`session=${normalizedRef.sessionId}`);
      if (normalizedRef.taskId) refParts.push(`task=${normalizedRef.taskId}`);
      if (normalizedRef.destination) refParts.push(`dest=${normalizedRef.destination}`);
      if (refParts.length > 0) lines.push(`引用: ${refParts.join(' · ')}`);
    }
    if (coalescedCount > 0 || eventCount > 1) {
      lines.push(`合并计数: 共 ${eventCount} 条事件（低优先级重复合并 ${coalescedCount} 次）`);
    }
    if (hadUnknown) {
      lines.push('历史未知记录: 存在未确认投递/创建结果 (unknown) 历史，当前状态更新不隐瞒该历史记录，请核对。');
    }
    const actions: ChannelCard['actions'] = [];
    if (isSafeAppLink(topicUrl)) {
      actions.push({ label: '返回任务话题', value: {}, url: topicUrl });
    }
    const prefix = event.state === 'recovered' ? '【已恢复】' : event.severity === 'high' ? '【高优提醒】' : '【运行提醒】';
    return {
      title: `${prefix}${event.title}`,
      text: lines.join('\n'),
      actions,
    };
  }

  /**
   * Ingests a controlled WatchEvent into SQLite with idempotency, object correlation,
   * out-of-order protection, and low-severity repeat coalescing.
   */
  async ingest(event: WatchEvent, auth?: WatchCallAuth): Promise<WatchIngestResult> {
    const { occurredMs, normalizedRef } = validateWatchEvent(event, this.allowedSources);
    await this.checkEventAuth(event, normalizedRef, auth);

    let topicUrl: string | null = null;
    if (normalizedRef) {
      if (this.resolveTopicLink) {
        topicUrl = await this.resolveTopicLink(normalizedRef, this.destination);
      } else if (this.port.topicLinkForSession && normalizedRef.sessionId) {
        topicUrl = await this.port.topicLinkForSession(this.destination, normalizedRef.sessionId);
      }
    }

    const digest = payloadDigest({
      eventId: event.eventId,
      source: event.source,
      objectId: event.objectId,
      state: event.state,
      occurredAt: event.occurredAt,
      severity: event.severity,
      title: event.title,
      summary: event.summary,
      sourceRef: normalizedRef,
    });
    const receivedAt = this.now();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare('SELECT payload_digest, status, outbox_id, source, state FROM watch_hub_events_v1 WHERE event_id=?')
        .get(event.eventId) as
        | { payload_digest: string; status: string; outbox_id: string | null; source: WatchSource; state: WatchState }
        | undefined;
      if (existing) {
        if (existing.payload_digest !== digest) {
          fail('idempotency_conflict', `watch eventId ${event.eventId} already exists with different payload`);
        }
        this.db.exec('COMMIT');
        return {
          status: 'duplicate',
          eventId: event.eventId,
          outboxId: existing.outbox_id ?? '',
          objectId: event.objectId,
          source: existing.source,
          state: existing.state,
        };
      }

      const rootRow = this.db
        .prepare('SELECT had_unknown_history, state FROM watch_hub_roots_v1 WHERE hub_key=?')
        .get(this.rootKey) as { had_unknown_history: number; state: string } | undefined;
      const objectRows = this.db
        .prepare('SELECT * FROM watch_hub_outbox_v1 WHERE object_id=? ORDER BY rowid DESC')
        .all(event.objectId) as unknown as OutboxRow[];

      const latestRow = objectRows[0];
      const knownMessageRow = objectRows.find((r) => nonempty(r.target_message_id));
      const hadUnknown =
        Boolean(rootRow?.had_unknown_history) ||
        rootRow?.state === 'unknown' ||
        objectRows.some((r) => r.state === 'unknown' || r.had_unknown === 1);

      if (latestRow && occurredMs < latestRow.latest_occurred_ms) {
        this.db
          .prepare(
            `INSERT INTO watch_hub_events_v1(
              event_id, source, object_id, state, severity, occurred_at, occurred_ms,
              title, summary, source_ref, payload_digest, status, outbox_id, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stale_ignored', ?, ?)`,
          )
          .run(
            event.eventId,
            event.source,
            event.objectId,
            event.state,
            event.severity,
            event.occurredAt,
            occurredMs,
            event.title,
            event.summary,
            normalizedRef ? JSON.stringify(normalizedRef) : null,
            digest,
            latestRow.outbox_id,
            receivedAt,
          );
        this.db.exec('COMMIT');
        return {
          status: 'stale_ignored',
          eventId: event.eventId,
          outboxId: latestRow.outbox_id,
          objectId: event.objectId,
          source: event.source,
          state: event.state,
        };
      }

      const shouldCoalesce =
        event.severity === 'low' &&
        event.state !== 'recovered' &&
        latestRow !== undefined &&
        latestRow.source === event.source &&
        latestRow.current_state === event.state &&
        (latestRow.state === 'pending' ||
          (latestRow.severity === 'low' && occurredMs - latestRow.latest_occurred_ms <= this.coalesceWindowMs));

      if (shouldCoalesce && latestRow) {
        const nextEventCount = latestRow.event_count + 1;
        const nextCoalescedCount = latestRow.coalesced_count + 1;
        if (latestRow.state === 'pending') {
          const card = this.renderCard({
            event,
            normalizedRef,
            previousState: latestRow.current_state,
            eventCount: nextEventCount,
            coalescedCount: nextCoalescedCount,
            hadUnknown: hadUnknown || latestRow.had_unknown === 1,
            topicUrl,
          });
          this.db
            .prepare(
              `UPDATE watch_hub_outbox_v1
               SET latest_event_id=?, latest_occurred_ms=?, card_json=?, event_count=?, coalesced_count=?,
                   had_unknown=?, updated_at=?
               WHERE outbox_id=?`,
            )
            .run(
              event.eventId,
              occurredMs,
              JSON.stringify(card),
              nextEventCount,
              nextCoalescedCount,
              hadUnknown || latestRow.had_unknown === 1 ? 1 : 0,
              receivedAt,
              latestRow.outbox_id,
            );
        } else {
          this.db
            .prepare(
              `UPDATE watch_hub_outbox_v1
               SET latest_event_id=?, latest_occurred_ms=?, event_count=?, coalesced_count=?, updated_at=?
               WHERE outbox_id=?`,
            )
            .run(event.eventId, occurredMs, nextEventCount, nextCoalescedCount, receivedAt, latestRow.outbox_id);
        }
        this.db
          .prepare(
            `INSERT INTO watch_hub_events_v1(
              event_id, source, object_id, state, severity, occurred_at, occurred_ms,
              title, summary, source_ref, payload_digest, status, outbox_id, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'coalesced', ?, ?)`,
          )
          .run(
            event.eventId,
            event.source,
            event.objectId,
            event.state,
            event.severity,
            event.occurredAt,
            occurredMs,
            event.title,
            event.summary,
            normalizedRef ? JSON.stringify(normalizedRef) : null,
            digest,
            latestRow.outbox_id,
            receivedAt,
          );
        this.db.exec('COMMIT');
        return {
          status: 'coalesced',
          eventId: event.eventId,
          outboxId: latestRow.outbox_id,
          objectId: event.objectId,
          source: event.source,
          state: event.state,
        };
      }

      if (latestRow && latestRow.state === 'pending') {
        const nextEventCount = latestRow.event_count + 1;
        const card = this.renderCard({
          event,
          normalizedRef,
          previousState: latestRow.current_state,
          eventCount: nextEventCount,
          coalescedCount: latestRow.coalesced_count,
          hadUnknown: hadUnknown || latestRow.had_unknown === 1,
          topicUrl,
        });
        this.db
          .prepare(
            `UPDATE watch_hub_outbox_v1
             SET source=?, latest_event_id=?, latest_occurred_ms=?, current_state=?, severity=?,
                 card_json=?, event_count=?, had_unknown=?, updated_at=?
             WHERE outbox_id=?`,
          )
          .run(
            event.source,
            event.eventId,
            occurredMs,
            event.state,
            event.severity,
            JSON.stringify(card),
            nextEventCount,
            hadUnknown || latestRow.had_unknown === 1 ? 1 : 0,
            receivedAt,
            latestRow.outbox_id,
          );
        this.db
          .prepare(
            `INSERT INTO watch_hub_events_v1(
              event_id, source, object_id, state, severity, occurred_at, occurred_ms,
              title, summary, source_ref, payload_digest, status, outbox_id, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
          )
          .run(
            event.eventId,
            event.source,
            event.objectId,
            event.state,
            event.severity,
            event.occurredAt,
            occurredMs,
            event.title,
            event.summary,
            normalizedRef ? JSON.stringify(normalizedRef) : null,
            digest,
            latestRow.outbox_id,
            receivedAt,
          );
        this.db.exec('COMMIT');
        return {
          status: 'accepted',
          eventId: event.eventId,
          outboxId: latestRow.outbox_id,
          objectId: event.objectId,
          source: event.source,
          state: event.state,
        };
      }

      const outboxId = `watch-outbox:${payloadDigest([event.objectId, event.eventId])}`;
      const deliveryId = `watch-delivery:${payloadDigest([this.rootKey, event.objectId, event.eventId])}`;
      const action: 'send' | 'update' = knownMessageRow?.target_message_id ? 'update' : 'send';
      const targetMessageId = knownMessageRow?.target_message_id ?? null;
      const prevCount = latestRow?.event_count ?? 0;
      const prevCoalesced = latestRow?.coalesced_count ?? 0;
      const card = this.renderCard({
        event,
        normalizedRef,
        previousState: latestRow?.current_state ?? null,
        eventCount: prevCount + 1,
        coalescedCount: prevCoalesced,
        hadUnknown,
        topicUrl,
      });

      this.db
        .prepare(
          `INSERT INTO watch_hub_outbox_v1(
            outbox_id, object_id, source, action, delivery_id, target_message_id,
            latest_event_id, latest_occurred_ms, current_state, severity, card_json,
            event_count, coalesced_count, had_unknown, state, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        )
        .run(
          outboxId,
          event.objectId,
          event.source,
          action,
          deliveryId,
          targetMessageId,
          event.eventId,
          occurredMs,
          event.state,
          event.severity,
          JSON.stringify(card),
          prevCount + 1,
          prevCoalesced,
          hadUnknown ? 1 : 0,
          receivedAt,
          receivedAt,
        );

      this.db
        .prepare(
          `INSERT INTO watch_hub_events_v1(
            event_id, source, object_id, state, severity, occurred_at, occurred_ms,
            title, summary, source_ref, payload_digest, status, outbox_id, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
        )
        .run(
          event.eventId,
          event.source,
          event.objectId,
          event.state,
          event.severity,
          event.occurredAt,
          occurredMs,
          event.title,
          event.summary,
          normalizedRef ? JSON.stringify(normalizedRef) : null,
          digest,
          outboxId,
          receivedAt,
        );

      this.db.exec('COMMIT');
      return {
        status: 'accepted',
        eventId: event.eventId,
        outboxId,
        objectId: event.objectId,
        source: event.source,
        state: event.state,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Flushes pending outbox items into the single fixed Watch Hub root topic.
   */
  async flush(auth?: WatchCallAuth): Promise<WatchDeliveryResult[]> {
    const root = await this.ensureRoot(auth);
    const targetDestination = root.topicDestination ?? root.chatDestination;
    const pendingRows = this.db
      .prepare("SELECT * FROM watch_hub_outbox_v1 WHERE state='pending' ORDER BY rowid")
      .all() as unknown as OutboxRow[];

    const results: WatchDeliveryResult[] = [];
    const guard = async () => {
      this.checkCallerAuth(auth);
      const current = this.getRoot();
      if (!current || current.state !== 'active' || (current.topicDestination ?? current.chatDestination) !== targetDestination) {
        fail('control_conflict', 'watch hub root is unavailable');
      }
    };

    for (const row of pendingRows) {
      let action = row.action;
      let targetMessageId = row.target_message_id;
      let card = JSON.parse(row.card_json) as ChannelCard;
      let hadUnknown = row.had_unknown === 1 || root.hadUnknownHistory;

      if (action === 'send' && !targetMessageId) {
        const priorUnknown = this.db
          .prepare(
            "SELECT delivery_id FROM watch_hub_outbox_v1 WHERE object_id=? AND state='unknown' ORDER BY rowid DESC LIMIT 1",
          )
          .get(row.object_id) as { delivery_id: string } | undefined;
        if (priorUnknown) {
          hadUnknown = true;
          const recoveredMsgId = (await this.port.lookupMessageId?.(priorUnknown.delivery_id)) ?? null;
          if (recoveredMsgId) {
            action = 'update';
            targetMessageId = recoveredMsgId;
          }
        }
      }

      if (hadUnknown && !card.text.includes('unknown')) {
        card = {
          ...card,
          text: `${card.text}\n历史未知记录: 存在未确认投递/创建结果 (unknown) 历史，当前状态更新不隐瞒该历史记录，请核对。`,
        };
      }

      this.db.exec('BEGIN IMMEDIATE');
      try {
        const claimed = this.db
          .prepare(
            "UPDATE watch_hub_outbox_v1 SET state='unknown', action=?, target_message_id=?, card_json=?, had_unknown=?, updated_at=? WHERE outbox_id=? AND state='pending'",
          )
          .run(action, targetMessageId, JSON.stringify(card), hadUnknown ? 1 : 0, this.now(), row.outbox_id);
        this.db.exec('COMMIT');
        if (!claimed.changes) continue;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }

      try {
        await guard();
        if (action === 'update' && targetMessageId) {
          await this.port.update(targetDestination, targetMessageId, card, row.delivery_id, guard);
          this.db
            .prepare("UPDATE watch_hub_outbox_v1 SET state='sent', updated_at=?, last_error=NULL WHERE outbox_id=?")
            .run(this.now(), row.outbox_id);
          results.push({
            outboxId: row.outbox_id,
            objectId: row.object_id,
            action: 'update',
            status: 'sent',
            messageId: targetMessageId,
            hadUnknown,
          });
        } else {
          let messageId = (await this.port.send(targetDestination, card, row.delivery_id, guard)) || null;
          if (!messageId) {
            messageId = (await this.port.lookupMessageId?.(row.delivery_id)) ?? null;
          }
          if (!messageId) {
            throw new Error('send returned no messageId');
          }
          this.db
            .prepare(
              "UPDATE watch_hub_outbox_v1 SET state='sent', target_message_id=?, updated_at=?, last_error=NULL WHERE outbox_id=?",
            )
            .run(messageId, this.now(), row.outbox_id);
          results.push({
            outboxId: row.outbox_id,
            objectId: row.object_id,
            action: 'send',
            status: 'sent',
            messageId,
            hadUnknown,
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.db
          .prepare("UPDATE watch_hub_outbox_v1 SET state='unknown', had_unknown=1, last_error=?, updated_at=? WHERE outbox_id=?")
          .run(msg, this.now(), row.outbox_id);
        results.push({
          outboxId: row.outbox_id,
          objectId: row.object_id,
          action,
          status: 'unknown',
          messageId: targetMessageId,
          hadUnknown: true,
        });
      }
    }

    return results;
  }

  /** Convenience helper: ingests and flushes in one call. */
  async publish(
    event: WatchEvent,
    auth?: WatchCallAuth,
  ): Promise<{ ingest: WatchIngestResult; deliveries: WatchDeliveryResult[] }> {
    const ingest = await this.ingest(event, auth);
    const deliveries = await this.flush(auth);
    return { ingest, deliveries };
  }

  /** Reconciles previously-unknown deliveries via lookupDelivery/lookupMessageId without resending. */
  async reconcileUnknownOutbox(auth?: WatchCallAuth): Promise<WatchDeliveryResult[]> {
    this.checkCallerAuth(auth);
    const rows = this.db
      .prepare("SELECT * FROM watch_hub_outbox_v1 WHERE state='unknown' ORDER BY rowid")
      .all() as unknown as OutboxRow[];
    const reconciled: WatchDeliveryResult[] = [];
    for (const row of rows) {
      const state = (await this.port.lookupDelivery?.(row.delivery_id)) ?? 'unknown';
      if (state !== 'sent') continue;
      const msgId = row.target_message_id ?? (await this.port.lookupMessageId?.(row.delivery_id)) ?? null;
      if (row.action === 'send' && !msgId) continue;
      this.db
        .prepare(
          "UPDATE watch_hub_outbox_v1 SET state='sent', target_message_id=COALESCE(?, target_message_id), had_unknown=1, updated_at=?, last_error=NULL WHERE outbox_id=? AND state='unknown'",
        )
        .run(msgId, this.now(), row.outbox_id);
      reconciled.push({
        outboxId: row.outbox_id,
        objectId: row.object_id,
        action: row.action,
        status: 'sent',
        messageId: msgId,
        hadUnknown: true,
      });
    }
    return reconciled;
  }
}
