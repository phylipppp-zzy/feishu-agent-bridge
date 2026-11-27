import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Identity } from '../contracts.js';
import { contractError } from '../errors.js';
import type { FeishuPort, TrustedEnvelope } from '../feishu-channel.js';
import {
  DEFAULT_USAGE_WEB_URL,
  renderUsageDashboardCard,
  type UsageDashboardPayload,
  type UsageRange,
} from './usage-cards.js';

export const DEFAULT_USAGE_SNAPSHOT_PATH = '/home/zhangzy/.cache/usage-dashboard/usage-data.json';
export const DEFAULT_USAGE_EXPORT_SCRIPT_PATH = '/home/zhangzy/scripts/usage-dashboard/export_usage.py';
export const DEFAULT_USAGE_TOOLS_BIN_PATH = '/home/zhangzy/.local/bin/tools';
export const DEFAULT_USAGE_PYTHON_BIN_PATH = '/usr/bin/python3';

export const SCHEDULED_OFFSET_MS = 60_000; // XX:01:00 to avoid racing usage-dashboard.timer at :00:00
export const SCHEDULED_FRESH_THRESHOLD_MS = 15 * 60_000;
export const CARD_RANGE_FRESH_THRESHOLD_MS = 10 * 60_000;
export const DEFAULT_REFRESH_COOLDOWN_MS = 45_000;
export const DEFAULT_COLLECT_TIMEOUT_MS = 25_000;

export type UsageHubPort = Pick<FeishuPort, 'send' | 'update'> &
  Partial<Pick<FeishuPort, 'lookupDelivery' | 'lookupMessageId'>>;

export interface UsageReportAction {
  action: 'usage_report';
  trigger: 'message' | 'card';
  range?: UsageRange;
  rawText?: string;
}

export interface UsageHubOptions {
  dbPath: string;
  owner: Identity;
  destination: string;
  port: UsageHubPort;
  intervalMinutes?: number;
  snapshotPath?: string;
  exportScriptPath?: string;
  toolsBinPath?: string;
  pythonBinPath?: string;
  webUrl?: string;
  refreshCooldownMs?: number;
  collectTimeoutMs?: number;
  now?: () => number;
  collectSnapshot?: () => Promise<UsageDashboardPayload | void>;
}

export interface UsageScheduledFlushResult {
  status: 'sent' | 'already_sent' | 'reconciled_sent' | 'unknown_unconfirmed' | 'closed';
  slot: number;
  deliveryId: string;
  messageId: string | null;
}

export interface UsageTriggerResult {
  status: 'sent' | 'updated' | 'duplicate' | 'unknown_prior';
  messageId: string | null;
}

interface DiskSnapshotRead {
  data: UsageDashboardPayload;
  generatedAtMs: number | null;
}

interface RefreshResult {
  data: UsageDashboardPayload | null;
  sourceNote: string;
}

export function parseUsageRangeFromText(rawText?: string): UsageRange | undefined {
  if (!rawText) return undefined;
  const text = rawText.trim();
  if (!text) return undefined;
  if (/(?:^|\D)30\s*(?:天|日|d)(?:\b|$)/iu.test(text)) return 'd30';
  if (/(?:^|\D)7\s*(?:天|日|d)(?:\b|$)/iu.test(text)) return 'd7';
  if (/(?:今日|今天|\btoday\b)/iu.test(text)) return 'today';
  return undefined;
}

let exportRunSeq = 0;

function runSubprocessExport(
  pythonBinPath: string,
  exportScriptPath: string,
  snapshotPath: string,
  toolsBinPath: string,
  timeoutMs: number,
  registerKiller?: (killFn: () => void) => () => void,
): Promise<void> {
  // Isolate output path per invocation so export_usage.py's internal `.tmp` never races usage-dashboard.timer.
  const privateOut = `${snapshotPath}.hub-${process.pid}-${++exportRunSeq}.json`;
  const privateTmp = `${snapshotPath}.hub-${process.pid}-${exportRunSeq}.tmp`;
  // Strictly local export only: NEVER pass --publish or --create-gist.
  const args = [exportScriptPath, '--out', privateOut, '--tools-bin', toolsBinPath];
  if (args.some((arg) => arg === '--publish' || arg === '--create-gist')) {
    return Promise.reject(new Error('forbidden publish flag in UsageHub local collector'));
  }
  mkdirSync(dirname(snapshotPath), { recursive: true });
  const basePath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `/home/zhangzy/.local/bin:/home/zhangzy/bin:/home/zhangzy/.gemini/bin:${basePath}`,
  };
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(pythonBinPath, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          try { child.kill('SIGTERM'); } catch {}
        }
      }
    };
    const unregister = registerKiller ? registerKiller(killGroup) : () => {};
    const timer = setTimeout(() => {
      killGroup();
      if (!settled) {
        settled = true;
        unregister();
        rmSync(privateOut, { force: true });
        rmSync(privateTmp, { force: true });
        reject(new Error('usage collector timed out'));
      }
    }, timeoutMs);
    timer.unref?.();

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregister();
      try {
        if (err) {
          reject(err);
          return;
        }
        if (!existsSync(privateOut)) {
          reject(new Error('collector did not write output file'));
          return;
        }
        JSON.parse(readFileSync(privateOut, 'utf8'));
        renameSync(privateOut, snapshotPath);
        resolve();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        rmSync(privateOut, { force: true });
        rmSync(privateTmp, { force: true });
      }
    };

    child.on('error', (err) => finish(err));
    child.on('close', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`collector exited code=${code ?? 'null'} signal=${signal ?? 'none'} ${stderr.trim()}`));
    });
  });
}

export class UsageHub {
  private readonly db: DatabaseSync;
  private readonly owner: Identity;
  private readonly destination: string;
  private readonly port: UsageHubPort;
  private readonly intervalMs: number;
  private readonly snapshotPath: string;
  private readonly exportScriptPath: string;
  private readonly toolsBinPath: string;
  private readonly pythonBinPath: string;
  private readonly webUrl: string;
  private readonly refreshCooldownMs: number;
  private readonly collectTimeoutMs: number;
  private readonly now: () => number;
  private readonly collectSnapshotFn: (() => Promise<UsageDashboardPayload | void>) | undefined;

  private closed = false;
  private inFlightRefresh: Promise<RefreshResult> | undefined;
  private inFlightFlush: Promise<UsageScheduledFlushResult> | undefined;
  private lastLiveCollectAtMs: number | null = null;
  private lastCollectedData: UsageDashboardPayload | null = null;
  private readonly reconciledUnknownSlots = new Set<number>();
  private readonly activeKillers = new Set<() => void>();
  private readonly cardUpdateSeq = new Map<string, number>();

  constructor(options: UsageHubOptions) {
    if (!options?.dbPath?.trim()) throw contractError('invalid_request', 'usage hub dbPath is required');
    if (!options.owner?.source?.trim() || !options.owner?.subject?.trim()) {
      throw contractError('invalid_request', 'usage hub owner identity is required');
    }
    if (!options.destination?.trim()) {
      throw contractError('invalid_request', 'usage hub destination is required');
    }
    const intervalMinutes = options.intervalMinutes ?? 60;
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
      throw contractError('invalid_request', 'usage hub intervalMinutes must be an integer between 5 and 1440');
    }

    this.owner = { source: options.owner.source.trim(), subject: options.owner.subject.trim() };
    this.destination = options.destination.trim();
    this.port = options.port;
    this.intervalMs = intervalMinutes * 60_000;
    this.snapshotPath = options.snapshotPath ?? DEFAULT_USAGE_SNAPSHOT_PATH;
    this.exportScriptPath = options.exportScriptPath ?? DEFAULT_USAGE_EXPORT_SCRIPT_PATH;
    this.toolsBinPath = options.toolsBinPath ?? DEFAULT_USAGE_TOOLS_BIN_PATH;
    this.pythonBinPath = options.pythonBinPath ?? DEFAULT_USAGE_PYTHON_BIN_PATH;
    this.webUrl = options.webUrl?.trim() || DEFAULT_USAGE_WEB_URL;
    this.refreshCooldownMs = options.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
    this.collectTimeoutMs = options.collectTimeoutMs ?? DEFAULT_COLLECT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.collectSnapshotFn = options.collectSnapshot;

    this.db = new DatabaseSync(options.dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage_hub_slots_v1 (
        slot INTEGER PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('unknown', 'sent')),
        message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_hub_events_v1 (
        event_id TEXT PRIMARY KEY,
        trigger_kind TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('unknown', 'sent')),
        message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const kill of [...this.activeKillers]) {
      try { kill(); } catch {}
    }
    this.activeKillers.clear();
    this.db.close();
  }

  currentSlot(nowMs = this.now()): number {
    return Math.floor((nowMs - SCHEDULED_OFFSET_MS) / this.intervalMs);
  }

  shouldFlushScheduled(nowMs = this.now()): boolean {
    if (this.closed) return false;
    const slot = this.currentSlot(nowMs);
    const row = this.db
      .prepare('SELECT state FROM usage_hub_slots_v1 WHERE slot = ?')
      .get(slot) as { state: 'unknown' | 'sent' } | undefined;
    if (!row) return true;
    if (row.state === 'sent') return false;
    return !this.reconciledUnknownSlots.has(slot);
  }

  nextWakeDelayMs(nowMs = this.now()): number {
    if (this.shouldFlushScheduled(nowMs)) return 50;
    const slot = this.currentSlot(nowMs);
    const nextBoundaryMs = (slot + 1) * this.intervalMs + SCHEDULED_OFFSET_MS;
    return Math.max(50, nextBoundaryMs - nowMs);
  }

  private readDiskSnapshot(): DiskSnapshotRead | null {
    if (!this.snapshotPath || !existsSync(this.snapshotPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const payload = parsed as UsageDashboardPayload;
      const genMs = typeof payload.generated_at === 'string' ? Date.parse(payload.generated_at) : Number.NaN;
      return {
        data: payload,
        generatedAtMs: Number.isFinite(genMs) ? genMs : null,
      };
    } catch {
      return null;
    }
  }

  private async refreshSnapshot(respectCooldown = true): Promise<RefreshResult> {
    if (this.inFlightRefresh) {
      return this.inFlightRefresh;
    }
    const startedAt = this.now();
    if (
      respectCooldown &&
      this.lastLiveCollectAtMs !== null &&
      startedAt - this.lastLiveCollectAtMs >= 0 &&
      startedAt - this.lastLiveCollectAtMs < this.refreshCooldownMs
    ) {
      const disk = this.readDiskSnapshot();
      const cached = disk?.data ?? this.lastCollectedData;
      if (cached) {
        return { data: cached, sourceNote: '实时采集' };
      }
    }

    const job = (async (): Promise<RefreshResult> => {
      try {
        if (this.collectSnapshotFn) {
          const direct = await this.collectSnapshotFn();
          const payload = direct ?? this.readDiskSnapshot()?.data ?? null;
          if (!payload) throw new Error('collector produced no usage payload');
          this.lastLiveCollectAtMs = this.now();
          this.lastCollectedData = payload;
          return { data: payload, sourceNote: '实时采集' };
        }
        await runSubprocessExport(
          this.pythonBinPath,
          this.exportScriptPath,
          this.snapshotPath,
          this.toolsBinPath,
          this.collectTimeoutMs,
          (killFn) => {
            if (this.closed) {
              killFn();
              return () => {};
            }
            this.activeKillers.add(killFn);
            return () => this.activeKillers.delete(killFn);
          },
        );
        const disk = this.readDiskSnapshot();
        if (!disk) throw new Error('snapshot file unavailable after export');
        this.lastLiveCollectAtMs = this.now();
        this.lastCollectedData = disk.data;
        return { data: disk.data, sourceNote: '实时采集' };
      } catch {
        const fallback = this.readDiskSnapshot()?.data ?? this.lastCollectedData ?? null;
        return {
          data: fallback,
          sourceNote: fallback ? '缓存快照' : '采集失败',
        };
      }
    })();

    this.inFlightRefresh = job;
    try {
      return await job;
    } finally {
      if (this.inFlightRefresh === job) {
        this.inFlightRefresh = undefined;
      }
    }
  }

  async flushScheduled(): Promise<UsageScheduledFlushResult> {
    if (this.inFlightFlush) return this.inFlightFlush;
    const task = this.flushScheduledInner();
    this.inFlightFlush = task;
    try {
      return await task;
    } finally {
      if (this.inFlightFlush === task) {
        this.inFlightFlush = undefined;
      }
    }
  }

  private async flushScheduledInner(): Promise<UsageScheduledFlushResult> {
    const nowMs = this.now();
    const slot = this.currentSlot(nowMs);
    const deliveryId = `usage-auto:${this.destination}:${slot}`;
    if (this.closed) {
      return { status: 'closed', slot, deliveryId, messageId: null };
    }

    const existing = this.db
      .prepare('SELECT delivery_id, state, message_id FROM usage_hub_slots_v1 WHERE slot = ?')
      .get(slot) as { delivery_id: string; state: 'unknown' | 'sent'; message_id: string | null } | undefined;

    if (existing) {
      if (existing.state === 'sent') {
        return {
          status: 'already_sent',
          slot,
          deliveryId: existing.delivery_id,
          messageId: existing.message_id,
        };
      }
      this.reconciledUnknownSlots.add(slot);
      const receipt = await this.port.lookupDelivery?.(existing.delivery_id);
      if (receipt === 'sent') {
        const msgId = (await this.port.lookupMessageId?.(existing.delivery_id)) ?? existing.message_id ?? null;
        if (!this.closed) {
          this.db
            .prepare("UPDATE usage_hub_slots_v1 SET state = 'sent', message_id = ?, updated_at = ?, last_error = NULL WHERE slot = ?")
            .run(msgId, this.now(), slot);
        }
        return {
          status: 'reconciled_sent',
          slot,
          deliveryId: existing.delivery_id,
          messageId: msgId,
        };
      }
      // Never blindly re-send an uncertain deliveryId on restart/retry.
      return {
        status: 'unknown_unconfirmed',
        slot,
        deliveryId: existing.delivery_id,
        messageId: null,
      };
    }

    const disk = this.readDiskSnapshot();
    let payload: UsageDashboardPayload | null;
    let sourceNote: string;
    if (
      disk &&
      disk.generatedAtMs !== null &&
      this.now() - disk.generatedAtMs <= SCHEDULED_FRESH_THRESHOLD_MS
    ) {
      payload = disk.data;
      sourceNote = '定时快照';
    } else {
      const refreshed = await this.refreshSnapshot(true);
      payload = refreshed.data;
      sourceNote = refreshed.sourceNote;
    }

    if (this.closed) {
      return { status: 'closed', slot, deliveryId, messageId: null };
    }

    const card = renderUsageDashboardCard(payload, {
      range: 'today',
      nowMs: this.now(),
      sourceNote,
      webUrl: this.webUrl,
    });

    const ts = this.now();
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO usage_hub_slots_v1(slot, delivery_id, state, message_id, created_at, updated_at, last_error) VALUES (?, ?, 'unknown', NULL, ?, ?, NULL)",
      )
      .run(slot, deliveryId, ts, ts);
    if (!inserted.changes) {
      const raced = this.db
        .prepare('SELECT delivery_id, state, message_id FROM usage_hub_slots_v1 WHERE slot = ?')
        .get(slot) as { delivery_id: string; state: 'unknown' | 'sent'; message_id: string | null } | undefined;
      return {
        status: raced?.state === 'sent' ? 'already_sent' : 'unknown_unconfirmed',
        slot,
        deliveryId: raced?.delivery_id ?? deliveryId,
        messageId: raced?.message_id ?? null,
      };
    }

    try {
      const sentId = await this.port.send(this.destination, card, deliveryId);
      const messageId = typeof sentId === 'string' && sentId.trim() ? sentId : null;
      if (!this.closed) {
        this.db
          .prepare("UPDATE usage_hub_slots_v1 SET state = 'sent', message_id = ?, updated_at = ?, last_error = NULL WHERE slot = ?")
          .run(messageId, this.now(), slot);
      }
      return { status: 'sent', slot, deliveryId, messageId };
    } catch (error) {
      this.reconciledUnknownSlots.add(slot);
      if (!this.closed) {
        const msg = error instanceof Error ? error.message : String(error);
        this.db
          .prepare('UPDATE usage_hub_slots_v1 SET updated_at = ?, last_error = ? WHERE slot = ?')
          .run(this.now(), msg.slice(0, 300), slot);
      }
      throw error;
    }
  }

  private checkEnvelopeAuth(envelope: TrustedEnvelope): void {
    if (this.closed) throw contractError('temporarily_unavailable', 'usage hub closed');
    if (
      !envelope?.eventId?.trim() ||
      envelope.destination !== this.destination ||
      envelope.identity.source !== this.owner.source ||
      envelope.identity.subject !== this.owner.subject
    ) {
      throw contractError('unauthorized', 'usage hub unauthorized');
    }
  }

  async handleTrigger(envelope: TrustedEnvelope, action: UsageReportAction): Promise<UsageTriggerResult> {
    this.checkEnvelopeAuth(envelope);

    const prior = this.db
      .prepare('SELECT delivery_id, state, message_id FROM usage_hub_events_v1 WHERE event_id = ?')
      .get(envelope.eventId) as { delivery_id: string; state: 'unknown' | 'sent'; message_id: string | null } | undefined;

    if (prior) {
      if (prior.state === 'sent') {
        return { status: 'duplicate', messageId: prior.message_id };
      }
      const receipt = await this.port.lookupDelivery?.(prior.delivery_id);
      if (receipt === 'sent') {
        const msgId = (await this.port.lookupMessageId?.(prior.delivery_id)) ?? prior.message_id ?? null;
        if (!this.closed) {
          this.db
            .prepare("UPDATE usage_hub_events_v1 SET state = 'sent', message_id = ?, updated_at = ? WHERE event_id = ?")
            .run(msgId, this.now(), envelope.eventId);
        }
        return { status: 'duplicate', messageId: msgId };
      }
      return { status: 'unknown_prior', messageId: null };
    }

    if (action.trigger === 'message') {
      const range: UsageRange = action.range ?? parseUsageRangeFromText(action.rawText) ?? 'today';
      const { data, sourceNote } = await this.refreshSnapshot(true);
      if (this.closed) throw contractError('temporarily_unavailable', 'usage hub closed');

      const card = renderUsageDashboardCard(data, {
        range,
        nowMs: this.now(),
        sourceNote,
        webUrl: this.webUrl,
      });
      const deliveryId = `usage-msg:${envelope.eventId}`;
      const ts = this.now();
      const claim = this.db
        .prepare(
          "INSERT OR IGNORE INTO usage_hub_events_v1(event_id, trigger_kind, delivery_id, state, message_id, created_at, updated_at) VALUES (?, 'message', ?, 'unknown', NULL, ?, ?)",
        )
        .run(envelope.eventId, deliveryId, ts, ts);
      if (!claim.changes) {
        const raced = this.db
          .prepare('SELECT state, message_id FROM usage_hub_events_v1 WHERE event_id = ?')
          .get(envelope.eventId) as { state: 'unknown' | 'sent'; message_id: string | null } | undefined;
        return {
          status: raced?.state === 'sent' ? 'duplicate' : 'unknown_prior',
          messageId: raced?.message_id ?? null,
        };
      }
      const sentId = await this.port.send(this.destination, card, deliveryId);
      const messageId = typeof sentId === 'string' && sentId.trim() ? sentId : null;
      if (!this.closed) {
        this.db
          .prepare("UPDATE usage_hub_events_v1 SET state = 'sent', message_id = ?, updated_at = ? WHERE event_id = ?")
          .run(messageId, this.now(), envelope.eventId);
      }
      return { status: 'sent', messageId };
    }

    // action.trigger === 'card'
    const cardMsgId = envelope.cardMessageId;
    const myCardSeq = cardMsgId ? (this.cardUpdateSeq.get(cardMsgId) ?? 0) + 1 : 0;
    if (cardMsgId) {
      if (this.cardUpdateSeq.size >= 512 && !this.cardUpdateSeq.has(cardMsgId)) {
        const oldest = this.cardUpdateSeq.keys().next().value;
        if (oldest !== undefined) this.cardUpdateSeq.delete(oldest);
      }
      this.cardUpdateSeq.set(cardMsgId, myCardSeq);
    }

    let range: UsageRange;
    let payload: UsageDashboardPayload | null;
    let sourceNote: string;

    if (action.range === undefined) {
      // [🔄 立即刷新]: 45s debounced live refresh and display 'today'
      range = 'today';
      const refreshed = await this.refreshSnapshot(true);
      payload = refreshed.data;
      sourceNote = refreshed.sourceNote;
    } else {
      range = action.range;
      const disk = this.readDiskSnapshot();
      const effectiveDisk =
        disk && disk.generatedAtMs !== null && this.now() - disk.generatedAtMs <= CARD_RANGE_FRESH_THRESHOLD_MS
          ? disk.data
          : null;
      if (effectiveDisk) {
        payload = effectiveDisk;
        sourceNote = '缓存快照';
      } else {
        const refreshed = await this.refreshSnapshot(true);
        payload = refreshed.data;
        sourceNote = refreshed.sourceNote;
      }
    }

    if (this.closed) throw contractError('temporarily_unavailable', 'usage hub closed');

    const card = renderUsageDashboardCard(payload, {
      range,
      nowMs: this.now(),
      sourceNote,
      webUrl: this.webUrl,
    });
    const deliveryId = `usage-card:${envelope.eventId}`;
    const ts = this.now();
    const claim = this.db
      .prepare(
        "INSERT OR IGNORE INTO usage_hub_events_v1(event_id, trigger_kind, delivery_id, state, message_id, created_at, updated_at) VALUES (?, 'card', ?, 'unknown', NULL, ?, ?)",
      )
      .run(envelope.eventId, deliveryId, ts, ts);
    if (!claim.changes) {
      const raced = this.db
        .prepare('SELECT state, message_id FROM usage_hub_events_v1 WHERE event_id = ?')
        .get(envelope.eventId) as { state: 'unknown' | 'sent'; message_id: string | null } | undefined;
      return {
        status: raced?.state === 'sent' ? 'duplicate' : 'unknown_prior',
        messageId: raced?.message_id ?? null,
      };
    }

    if (envelope.cardMessageId) {
      if (this.cardUpdateSeq.get(envelope.cardMessageId) === myCardSeq) {
        await this.port.update(this.destination, envelope.cardMessageId, card, deliveryId);
      }
      if (!this.closed) {
        this.db
          .prepare("UPDATE usage_hub_events_v1 SET state = 'sent', message_id = ?, updated_at = ? WHERE event_id = ?")
          .run(envelope.cardMessageId, this.now(), envelope.eventId);
      }
      return { status: 'updated', messageId: envelope.cardMessageId };
    }

    const sentId = await this.port.send(this.destination, card, deliveryId);
    const messageId = typeof sentId === 'string' && sentId.trim() ? sentId : null;
    if (!this.closed) {
      this.db
        .prepare("UPDATE usage_hub_events_v1 SET state = 'sent', message_id = ?, updated_at = ? WHERE event_id = ?")
        .run(messageId, this.now(), envelope.eventId);
    }
    return { status: 'sent', messageId };
  }
}
