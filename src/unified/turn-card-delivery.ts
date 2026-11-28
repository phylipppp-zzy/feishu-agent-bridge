import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from './adapter.js';
import { payloadDigest, type Artifact, type Event, type Message, type SessionSnapshot, type Turn } from './contracts.js';
import type { FeishuPort } from './feishu-channel.js';
import type { ChannelCard } from './feishu-cards.js';
import { isTerminalTurn, readToolProgress, type ToolProgress } from './tool-progress.js';
import { aggregateTurnAssistantMessage } from './turn-reply.js';
import type { CompactTurnInfo, ContextUsageInfo } from './context-usage.js';
import { formatCompactModelBadge, replyText, turnFinalReplyCard, turnProcessCard, type SessionSubagentActivity } from './turn-progress-card.js';
import { timestampMs, type TurnTiming, type TurnToolCounts } from './turn-progress-store.js';

function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const LONG_TURN_NOTICE_MS = 120_000;
export const PROCESS_CARD_TEXT_DELAY_MS = positiveEnvMs('FEISHU_PROCESS_CARD_DELAY_MS', 5_000);
const PATCH_INTERVAL_MS = positiveEnvMs('FEISHU_PATCH_INTERVAL_MS', 2_500);
const HEARTBEAT_MS = 60_000;
const REJECTION_RETRY_MS = positiveEnvMs('FEISHU_REJECTION_RETRY_MS', 3_000);

type BindingKey = [destination: string, sessionId: string, scope: string];
type SlotKey = [...BindingKey, turnId: string];
type Slot = { card_id: string | null; final: number; updated_at: number; current_message: string; latest_sequence: number };
type ProcessDelivery = 'ready' | 'retry_later' | 'abandoned';
type ReplyDelivery = 'sent' | 'retry_later' | 'rejected';
type ReplySlot = { card_id: string | null; delivery_id: string; signature: string; updated_at: number };
type SlotMessage = Pick<Message, 'messageId' | 'sequence' | 'revision' | 'final'>;
type ReplySignature = {
  digest: string;
  message?: SlotMessage | undefined;
  startedAtMs: number | null;
  endedAtMs: number | null;
  completedAtMs: number;
  status: Turn['status'];
  compactInfo?: CompactTurnInfo | undefined;
  contextUsage?: ContextUsageInfo | undefined;
  modelBadge?: string | undefined;
  toolCounts?: TurnToolCounts;
};
type CardAttempt = {
  view: View; message?: SlotMessage | undefined; plain: boolean; retryAfter: number;
  attempts?: number; unknownPatchAttempts?: number; replaced?: boolean; supersededDeliveries?: string[];
};
type View = { schema: '1.0' | '2.0'; status: Turn['status'] | null; title: string; signature: string; content_signature?: string; delivery: string; dirty: number };
type PendingFinalization = Partial<Omit<TurnView, 'key' | 'provider' | 'sessionConnected' | 'interrupt'>> & {
  turn: Turn;
  tools: ToolProgress[];
  replyRetryAfter?: number;
  replyPlain?: boolean;
  replyRateLimitAttempts?: number;
};

interface Dependencies {
  guard(key: BindingKey): Promise<void>;
  stamp(destination: string, card: ChannelCard): ChannelCard;
  wake(destination: string): void;
  readActiveSubagents?(session: SessionSnapshot['session']): Promise<readonly SessionSubagentActivity[] | undefined> | readonly SessionSubagentActivity[] | undefined;
}

interface TurnView {
  key: SlotKey;
  turn?: Turn | undefined;
  message?: Message | undefined;
  timing?: TurnTiming | undefined;
  tools: ToolProgress[];
  toolCounts?: TurnToolCounts | undefined;
  provider: SessionSnapshot['session']['native']['provider'];
  sessionConnected?: boolean;
  isCliReadonly?: boolean;
  interrupt?: { revision: number; controlGeneration: number };
  processCardId?: string;
  contextUsage?: ContextUsageInfo | null;
  activeSubagents?: readonly SessionSubagentActivity[] | undefined;
}

export function eventSequence(sessionId: string, cursor: string | undefined): number {
  try {
    const [id, sequence]: unknown[] = JSON.parse(Buffer.from(cursor ?? '', 'base64url').toString());
    if (id === sessionId && Number.isSafeInteger(sequence) && Number(sequence) >= 0) return Number(sequence);
  } catch { /* Service substitutes may use opaque cursors. */ }
  return 0;
}

const streamId = (key: SlotKey): string => `stream:${payloadDigest([key[2], key[0], key[1], key[3]])}`;
const deliveryId = (prefix: string, key: SlotKey): string => `${prefix}:${payloadDigest(key)}`;
const readReplySignature = (slot: ReplySlot | undefined): ReplySignature | undefined =>
  slot?.signature.startsWith('{') ? JSON.parse(slot.signature) as ReplySignature : undefined;
const slotMessage = (message: Message | undefined): SlotMessage | undefined => message && {
  messageId: message.messageId, sequence: message.sequence, revision: message.revision, final: message.final,
};

function apiRejection(error: unknown): { platformCode?: number } | undefined {
  const failure = error as { deliveryKind?: string; platformCode?: number } | null;
  if (failure && (failure.deliveryKind === 'api_rejected' ||
    Number.isInteger(failure.platformCode) && failure.platformCode !== 0)) return failure;
}

export class TurnCardDelivery {
  private readonly timers = new Map<string, { key: SlotKey; at: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly compactBaselines = new Map<string, {
    sessionId: string;
    operationId: string;
    beforeTokens: number | null;
    maxTokens: number | null;
    recordedAt: number;
    queued: boolean;
    turnId?: string;
  }>();
  private closed = false;
  private readonly finalizing = new Set<string>();
  private viewSchemaReady = false;
  constructor(private readonly db: DatabaseSync, private readonly service: UnifiedService,
    private readonly port: FeishuPort, private readonly deps: Dependencies) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_stream_cards (destination TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_scope TEXT NOT NULL, message_id TEXT NOT NULL, card_id TEXT, revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, final INTEGER NOT NULL, current_message TEXT NOT NULL, latest_sequence INTEGER NOT NULL,
        PRIMARY KEY(destination,session_id,binding_scope,message_id));
      CREATE TABLE IF NOT EXISTS channel_turn_card_views (destination TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_scope TEXT NOT NULL, turn_id TEXT NOT NULL, schema TEXT NOT NULL, status TEXT, title TEXT NOT NULL, signature TEXT NOT NULL,
        delivery TEXT NOT NULL, dirty INTEGER NOT NULL, PRIMARY KEY(destination,session_id,binding_scope,turn_id));
      CREATE TABLE IF NOT EXISTS channel_turn_card_attempts (destination TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_scope TEXT NOT NULL, turn_id TEXT NOT NULL, attempt TEXT NOT NULL,
        PRIMARY KEY(destination,session_id,binding_scope,turn_id));
      CREATE TABLE IF NOT EXISTS channel_turn_baseline (destination TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_scope TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(destination,session_id,binding_scope));
      CREATE TABLE IF NOT EXISTS channel_turn_baseline_messages (destination TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_scope TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(destination,session_id,binding_scope,message_id));
      CREATE TABLE IF NOT EXISTS channel_turn_notice_policy (destination TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_scope TEXT NOT NULL, sequence INTEGER NOT NULL, allowed INTEGER NOT NULL,
        PRIMARY KEY(destination,session_id,binding_scope,sequence));
      CREATE TABLE IF NOT EXISTS channel_turn_pending_finalization (destination TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_scope TEXT NOT NULL, turn_id TEXT NOT NULL, terminal_input TEXT NOT NULL,
        PRIMARY KEY(destination,session_id,binding_scope,turn_id));
      CREATE TABLE IF NOT EXISTS channel_turn_reply_cards (destination TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_scope TEXT NOT NULL, turn_id TEXT NOT NULL, card_id TEXT, delivery_id TEXT NOT NULL,
        signature TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(destination,session_id,binding_scope,turn_id));
    `);
  }
  /** Record that the user triggered /compact so its turn card renders before/after context without hijacking other turns. */
  recordCompactBaseline(sessionId: string, operationId: string, beforeUsage: ContextUsageInfo | null, queued = false): void {
    const now = Date.now();
    for (const [opId, entry] of this.compactBaselines) {
      if (now - entry.recordedAt > 10 * 60_000) this.compactBaselines.delete(opId);
    }
    if (this.compactBaselines.size >= 64) {
      const oldest = this.compactBaselines.keys().next().value;
      if (oldest) this.compactBaselines.delete(oldest);
    }
    this.compactBaselines.set(operationId, {
      sessionId,
      operationId,
      beforeTokens: beforeUsage?.usedTokens ?? null,
      maxTokens: beforeUsage?.maxTokens ?? null,
      recordedAt: now,
      queued,
    });
  }
  clearCompactBaseline(operationId: string): void {
    this.compactBaselines.delete(operationId);
  }
  private resolveCompactInfo(
    sessionId: string,
    turn: Turn | undefined,
    turnId: string,
    turnStartedMs: number | null,
    currentUsage: ContextUsageInfo | null,
  ): CompactTurnInfo | undefined {
    const now = Date.now();
    let matched: {
      sessionId: string;
      operationId: string;
      beforeTokens: number | null;
      maxTokens: number | null;
      recordedAt: number;
      queued: boolean;
      turnId?: string;
    } | undefined;
    for (const [opId, entry] of this.compactBaselines) {
      if (now - entry.recordedAt > 10 * 60_000) {
        this.compactBaselines.delete(opId);
        continue;
      }
      if (entry.sessionId !== sessionId) continue;
      if (entry.turnId === turnId) {
        matched = entry;
        break;
      }
      if (turn?.inputId && entry.operationId === turn.inputId) {
        entry.turnId = turnId;
        matched = entry;
        break;
      }
    }
    if (!matched && !turn?.inputId) {
      for (const entry of this.compactBaselines.values()) {
        if (entry.sessionId !== sessionId || entry.turnId || entry.queued) continue;
        if (turnStartedMs !== null && turnStartedMs < entry.recordedAt - 5_000) continue;
        entry.turnId = turnId;
        matched = entry;
        break;
      }
    }
    if (!matched) return undefined;
    return {
      isCompact: true,
      beforeTokens: matched.beforeTokens,
      afterTokens: currentUsage?.usedTokens ?? null,
      maxTokens: currentUsage?.maxTokens ?? matched.maxTokens,
    };
  }
  hasPendingWork(key: BindingKey): boolean {
    const [destination, sessionId, scope] = key;
    const active = this.db.prepare(`SELECT 1 FROM channel_stream_cards s
      LEFT JOIN channel_turn_card_views v ON v.destination=s.destination AND v.session_id=s.session_id
        AND v.binding_scope=s.binding_scope AND v.turn_id=s.message_id
      WHERE s.destination=? AND s.session_id=? AND s.binding_scope=? AND
        (v.dirty=1 OR (v.status='running' OR v.status IS NULL AND s.final=0) AND NOT EXISTS (
          SELECT 1 FROM channel_deliveries WHERE delivery_id=v.delivery AND state='rejected'
        ) OR EXISTS (
          SELECT 1 FROM channel_deliveries d JOIN channel_delivery_diagnostics x USING(delivery_id)
          WHERE d.delivery_id=v.delivery AND d.state='unknown' AND x.kind='api_rejected' AND x.platform_code<>0
        )) LIMIT 1`).get(destination, sessionId, scope);
    if (active) return true;
    const pending = this.db.prepare(`SELECT 1 FROM channel_turn_pending_finalization
      WHERE destination=? AND session_id=? AND binding_scope=? LIMIT 1`).get(...key);
    return Boolean(pending);
  }

  isBaselinedMessage(key: BindingKey, messageId: string, revision: number): boolean {
    const row = this.db.prepare(`SELECT revision FROM channel_turn_baseline_messages
      WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?`)
      .get(...key, messageId) as { revision: number } | undefined;
    return Boolean(row && Number(row.revision) >= revision);
  }

  close(): void {
    this.closed = true;
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  discardOtherScopes(destination: string, scope: string): void {
    for (const [id, { key, timer }] of this.timers) {
      if (key[0] === destination && key[2] !== scope) { clearTimeout(timer); this.timers.delete(id); }
    }
    this.db.prepare('DELETE FROM channel_turn_pending_finalization WHERE destination=? AND binding_scope<>?').run(destination, scope);
    this.db.prepare('DELETE FROM channel_turn_card_attempts WHERE destination=? AND binding_scope<>?').run(destination, scope);
    this.db.prepare('DELETE FROM channel_turn_baseline_messages WHERE destination=? AND binding_scope<>?').run(destination, scope);
  }
  private cancel(key: SlotKey): void {
    const id = streamId(key);
    clearTimeout(this.timers.get(id)?.timer);
    this.timers.delete(id);
  }
  private schedule(key: SlotKey, at: number): void {
    if (this.closed) return;
    const id = streamId(key);
    if (this.timers.get(id)?.at === at) return;
    this.cancel(key);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (!this.closed) this.deps.wake(key[0]);
    }, Math.max(0, at - Date.now()));
    timer.unref();
    this.timers.set(id, { key, at, timer });
  }
  baseline(key: BindingKey, cursor: string, history?: readonly Pick<Message, 'messageId' | 'revision'>[]): void {
    this.db.prepare('INSERT OR IGNORE INTO channel_turn_baseline VALUES (?,?,?,?)').run(...key, eventSequence(key[1], cursor));
    if (history) {
      const insert = this.db.prepare('INSERT OR IGNORE INTO channel_turn_baseline_messages VALUES (?,?,?,?,?)');
      // An empty history is still a captured baseline.
      insert.run(...key, '', -1);
      for (const message of history) insert.run(...key, message.messageId, message.revision);
    }
  }
  private async backfillReadonlyBaseline(key: BindingKey): Promise<void> {
    const missing = this.db.prepare(`SELECT 1 FROM channel_history_baselines h
      WHERE h.destination=? AND h.session_id=? AND h.binding_scope=? AND NOT EXISTS (
        SELECT 1 FROM channel_turn_baseline_messages b
        WHERE b.destination=h.destination AND b.session_id=h.session_id AND b.binding_scope=h.binding_scope
      )`);
    if (!missing.get(...key)) return;
    await this.deps.guard(key);
    this.journal(() => {
      if (!missing.get(...key)) return;
      this.db.prepare(`INSERT OR IGNORE INTO channel_turn_baseline_messages
        SELECT destination,session_id,?,message_id,revision FROM channel_known_messages
        WHERE destination=? AND session_id=?`).run(key[2], key[0], key[1]);
      this.db.prepare('INSERT OR IGNORE INTO channel_turn_baseline_messages VALUES (?,?,?,?,?)').run(...key, '', -1);
    });
  }
  noticePolicy(key: BindingKey, sequence: number, prior: boolean, allowed: boolean): void {
    if (prior === allowed) return;
    this.db.prepare('INSERT OR IGNORE INTO channel_turn_notice_policy VALUES (?,?,?,?,?)').run(...key, -1, Number(prior));
    this.db.prepare('INSERT OR REPLACE INTO channel_turn_notice_policy VALUES (?,?,?,?,?)')
      .run(...key, sequence, Number(allowed));
  }
  private slot(key: SlotKey): Slot | undefined {
    return this.db.prepare('SELECT * FROM channel_stream_cards WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?')
      .get(...key) as Slot | undefined;
  }
  private replySlot(key: SlotKey): ReplySlot | undefined {
    return this.db.prepare(`SELECT card_id,delivery_id,signature,updated_at FROM channel_turn_reply_cards
      WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).get(...key) as ReplySlot | undefined;
  }
  private pendingFinalization(key: SlotKey): PendingFinalization | undefined {
    const row = this.db.prepare(`SELECT terminal_input FROM channel_turn_pending_finalization
      WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).get(...key) as { terminal_input: string } | undefined;
    return row && JSON.parse(row.terminal_input) as PendingFinalization;
  }
  hasPendingFinalization(key: SlotKey): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM channel_turn_pending_finalization
      WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).get(...key));
  }
  private clearFinalization(key: SlotKey): void {
    this.db.prepare(`DELETE FROM channel_turn_pending_finalization
      WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).run(...key);
  }
  private saveFinalization(key: SlotKey, input: PendingFinalization): void {
    this.db.prepare(`INSERT INTO channel_turn_pending_finalization VALUES (?,?,?,?,?)
      ON CONFLICT(destination,session_id,binding_scope,turn_id) DO UPDATE SET terminal_input=excluded.terminal_input
      WHERE terminal_input<>excluded.terminal_input`).run(...key, JSON.stringify(input));
  }
  private view(key: SlotKey): View | undefined {
    if (!this.viewSchemaReady) {
      const columns = this.db.prepare('PRAGMA table_info(channel_turn_card_views)').all();
      if (!columns.some(column => column.name === 'content_signature')) {
        this.db.exec("ALTER TABLE channel_turn_card_views ADD COLUMN content_signature TEXT NOT NULL DEFAULT ''");
      }
      this.viewSchemaReady = true;
    }
    return this.db.prepare('SELECT * FROM channel_turn_card_views WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?')
      .get(...key) as View | undefined;
  }
  private saveView(key: SlotKey, view: View): void {
    this.db.prepare(`INSERT OR REPLACE INTO channel_turn_card_views
      (destination,session_id,binding_scope,turn_id,schema,status,title,signature,delivery,dirty,content_signature)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(...key, view.schema, view.status, view.title, view.signature, view.delivery, view.dirty, view.content_signature ?? '');
  }
  private async deliveryState(id: string): Promise<'sent' | 'suppressed' | 'rejected' | 'not_sent' | 'unknown' | undefined> {
    const row = this.db.prepare('SELECT state FROM channel_deliveries WHERE delivery_id=?').get(id) as {state: string} | undefined;
    if (row?.state === 'sent' || row?.state === 'suppressed' || row?.state === 'rejected') return row.state;
    if (row?.state !== 'unknown') return undefined;
    const receipt = await this.port.lookupDelivery?.(id) ?? 'unknown';
    if (receipt === 'sent') {
      this.delivered(id);
    } else if (receipt === 'unknown' && this.db.prepare(`SELECT 1 FROM channel_delivery_diagnostics
      WHERE delivery_id=? AND kind='api_rejected' AND platform_code<>0`).get(id)) {
      return 'not_sent';
    }
    return receipt;
  }
  private claim(id: string, state: 'unknown' | 'suppressed' = 'unknown'): boolean {
    const claimed = !!this.db.prepare('INSERT OR IGNORE INTO channel_deliveries VALUES (?,?)').run(id, state).changes;
    if (claimed) this.db.prepare('DELETE FROM channel_delivery_diagnostics WHERE delivery_id=?').run(id);
    return claimed;
  }
  private delivered(id: string): void {
    this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id);
  }
  private journal(write: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { write(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private attempt(key: SlotKey): CardAttempt | undefined {
    const row = this.db.prepare(`SELECT attempt FROM channel_turn_card_attempts
      WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).get(...key) as { attempt: string } | undefined;
    return row && JSON.parse(row.attempt) as CardAttempt;
  }
  private saveAttempt(key: SlotKey, attempt: CardAttempt): void {
    this.db.prepare('INSERT OR REPLACE INTO channel_turn_card_attempts VALUES (?,?,?,?,?)').run(...key, JSON.stringify(attempt));
  }
  private confirmCard(key: SlotKey, attempt: CardAttempt, cardId: string | null): void {
    this.journal(() => {
      this.delivered(attempt.view.delivery);
      if (cardId !== null && attempt.supersededDeliveries?.length) {
        const stmt = this.db.prepare("UPDATE channel_deliveries SET state='suppressed' WHERE delivery_id=? AND state='unknown'");
        for (const staleId of attempt.supersededDeliveries) {
          if (staleId && staleId !== attempt.view.delivery) stmt.run(staleId);
        }
      }
      this.saveView(key, { ...attempt.view, dirty: 0 });
      this.recordSlot(key, cardId, attempt.message);
      this.db.prepare(`DELETE FROM channel_turn_card_attempts
        WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).run(...key);
    });
  }
  private clearUnknown(id: string): void {
    this.db.prepare("DELETE FROM channel_deliveries WHERE delivery_id=? AND state='unknown'").run(id);
  }
  private async writeCard(key: SlotKey, card: ChannelCard, cardId: string | null, attempt: CardAttempt,
    guard: () => Promise<void>, prepareSlot?: () => void): Promise<ProcessDelivery> {
    const [destination] = key;
    const { view, plain } = attempt;
    const id = view.delivery;
    let claimed = false;
    this.journal(() => {
      claimed = this.claim(id);
      if (claimed) {
        prepareSlot?.();
        this.saveAttempt(key, attempt);
      }
    });
    if (!claimed) return 'retry_later';
    try {
      const payload = this.deps.stamp(destination, plain ? { ...card, format: 'plain' } : card);
      if (cardId) await this.port.update(destination, cardId, payload, id, guard);
      else cardId = await this.port.send(destination, payload, id, guard) ?? null;
    } catch (error) {
      const failure = apiRejection(error);
      if (!failure) {
        await guard();
        if (isTerminalTurn(view.status ?? undefined)) this.schedule(key, Date.now());
        throw error;
      }
      const attempts = (attempt.attempts ?? 0) + Number(failure.platformCode === 230429);
      let retry: CardAttempt | undefined;
      if (failure.platformCode === 230099 && !plain) {
        retry = { ...attempt, plain: true, view: { ...view, delivery: `${id}:plain` }, retryAfter: 0 };
      } else if (failure.platformCode === 230429 && attempts <= 6) {
        const delay = Math.min(30_000, REJECTION_RETRY_MS * 2 ** (attempts - 1));
        retry = { ...attempt, attempts, retryAfter: Date.now() + delay };
      }
      await guard();
      this.journal(() => {
        if (retry?.view.delivery === id) this.clearUnknown(id);
        else this.db.prepare("UPDATE channel_deliveries SET state='rejected' WHERE delivery_id=?").run(id);
        this.db.prepare("INSERT OR REPLACE INTO channel_delivery_diagnostics VALUES (?, 'api_rejected', ?)")
          .run(id, failure.platformCode ?? null);
        if (retry) this.saveAttempt(key, retry);
        else {
          this.saveView(key, { ...view, dirty: 0 });
          this.db.prepare(`DELETE FROM channel_turn_card_attempts
            WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).run(...key);
        }
      });
      if (!retry) {
        this.cancel(key);
        return 'abandoned';
      }
      if (!retry.retryAfter) return this.writeCard(key, card, retry.replaced ? null : cardId, retry, guard);
      this.schedule(key, retry.retryAfter);
      return 'retry_later';
    }
    await guard();
    this.confirmCard(key, attempt, cardId);
    return 'ready';
  }
  private async cardState(input: TurnView, status: Turn['status'], schema: '1.0' | '2.0', prior?: ReplySignature) {
    const { key, message, tools, toolCounts, provider, timing, sessionConnected, interrupt } = input;
    const [, sessionId, scope] = key;
    const terminal = isTerminalTurn(status);
    const start = timing?.startedMs ?? timestampMs(input.turn?.startedAt) ?? prior?.startedAtMs ?? null;
    const end = timing?.endedMs ?? timestampMs(input.turn?.endedAt) ?? prior?.endedAtMs ?? null;
    const duration = terminal && start !== null && end !== null && end >= start ? end - start : null;
    let files: Artifact[] = [];
    if (message && terminal) {
      try { files = await this.service.findRegisteredReplyFiles?.(sessionId, message.blocks) ?? []; }
      catch { /* File actions are optional; the persisted reply can still be delivered. */ }
    }
    let contextUsage = input.contextUsage ?? prior?.contextUsage ?? null;
    if (!prior?.contextUsage && input.contextUsage === undefined) {
      try { contextUsage = await this.service.getContextUsage?.(sessionId) ?? null; }
      catch { /* Context data is optional. */ }
    }
    let modelBadge = '';
    try {
      const settings = await this.service.getConfirmedSettings?.(sessionId);
      modelBadge = formatCompactModelBadge(
        input.turn?.model ?? settings?.model ?? contextUsage?.model,
        settings?.preferences?.reasoningEffort ?? settings?.preferences?.effort,
      );
    } catch {
      modelBadge = formatCompactModelBadge(input.turn?.model ?? contextUsage?.model);
    }
    const compactInfo = prior?.compactInfo ?? this.resolveCompactInfo(sessionId, input.turn, key[3], start, contextUsage);
    if (!input.turn?.model) modelBadge = prior?.modelBadge ?? modelBadge;
    const isCliReadonly = input.isCliReadonly ?? scope.includes('"access_mode":"read_only"');
    return {
      provider, status, schema, message, tools, toolCounts: toolCounts ?? (tools.length === 0 ? prior?.toolCounts : undefined),
      duration, files, turnId: key[3], sessionId,
      sessionConnected: Boolean(sessionConnected), isCliReadonly,
      startedAtMs: start, endedAtMs: end, completedAtMs: end ?? prior?.completedAtMs ?? Date.now(),
      ...(input.activeSubagents?.length ? { activeSubagents: input.activeSubagents } : {}),
      ...(modelBadge ? { modelBadge } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      ...(compactInfo ? { compactInfo } : {}),
      ...(status === 'running' && !isCliReadonly && sessionConnected && interrupt ? {
        stopAction: { label: '⏹ 中断当前回复',
          value: { action: 'stop', turnId: key[3], ...interrupt, lockTurn: true } },
      } : {}),
    };
  }

  private async putCard(input: TurnView): Promise<ProcessDelivery> {
    const { key, message, tools, sessionConnected } = input;
    const status = input.turn?.status ?? 'running';
    const terminal = isTerminalTurn(status);
    const binding: BindingKey = [key[0], key[1], key[2]];
    const guard = () => this.deps.guard(binding);
    let current = this.slot(key);
    let old = this.view(key);
    let cardId = current?.card_id ?? null;
    const firstId = streamId(key);
    const finalId = deliveryId('turn-process-final', key);
    let pending = this.attempt(key);
    let rejected = false;
    const staleDeliveries: string[] = [];
    const abandonUnknown = (view: View): ProcessDelivery => {
      this.journal(() => {
        // Keep the ambiguous write visible for reconciliation while settling the process view locally.
        this.db.prepare("INSERT OR IGNORE INTO channel_delivery_diagnostics VALUES (?, 'unknown', NULL)").run(view.delivery);
        this.saveView(key, {
          ...view, status, dirty: 0, delivery: view.delivery.startsWith(finalId) ? view.delivery : finalId,
        });
        this.db.prepare(`DELETE FROM channel_turn_card_attempts
          WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).run(...key);
      });
      return 'abandoned';
    };
    if (pending) {
      const receipt = await this.deliveryState(pending.view.delivery);
      await guard();
      const pendingTerminal = isTerminalTurn(pending.view.status ?? undefined);
      if (terminal && (pending.replaced || !pending.view.delivery.startsWith(finalId)) && receipt !== 'unknown' && receipt !== 'sent') {
        // A queued retry under a live or legacy delivery key cannot serve as the archive write.
        this.journal(() => {
          if (receipt === 'not_sent') this.clearUnknown(pending!.view.delivery);
          this.db.prepare(`DELETE FROM channel_turn_card_attempts
            WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).run(...key);
          if (!cardId) this.db.prepare(`DELETE FROM channel_stream_cards
            WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?`).run(...key);
        });
        if (!cardId) return 'ready';
        pending = undefined;
      } else if (receipt === 'unknown') {
        // An interrupted non-terminal PATCH on an existing cardId is fully superseded by any newer/terminal
        // view because im.message.patch is an idempotent full-card replacement. Discard the stale attempt so
        // completed/failed/interrupted turns never deadlock behind an orphaned running heartbeat PATCH.
        if (cardId !== null && !pending.replaced && !pendingTerminal) {
          // Keep the stale receipt linked until a replacement PATCH can run.
          const patchAt = current!.updated_at + PATCH_INTERVAL_MS;
          if (patchAt > Date.now()) {
            this.schedule(key, patchAt);
            return 'retry_later';
          }
          if (pending.supersededDeliveries?.length) staleDeliveries.push(...pending.supersededDeliveries);
          staleDeliveries.push(pending.view.delivery);
          this.journal(() => {
            this.db.prepare(`DELETE FROM channel_turn_card_attempts
              WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).run(...key);
          });
          if (old) old = { ...old, signature: '', dirty: 1 };
          pending = undefined;
        } else {
          if (!terminal) return 'abandoned';
          if (cardId === null || pending.replaced || !pendingTerminal) return abandonUnknown(pending.view);
          const previousRetry = /:patch-retry-(\d+)(?::plain)?$/.exec(pending.view.delivery);
          const unknownAttempts = pending.unknownPatchAttempts ?? (previousRetry ? Number(previousRetry[1]) : 0);
          if (unknownAttempts >= 3) return abandonUnknown(pending.view);
          const nextAttempt = unknownAttempts + 1;
          const retryDelivery = `${finalId}:patch-retry-${nextAttempt}`;
          const nextSuperseded = [...new Set([...(pending.supersededDeliveries ?? []), pending.view.delivery])];
          const nextPending: CardAttempt = {
            ...pending,
            unknownPatchAttempts: nextAttempt,
            retryAfter: Date.now() + Math.min(20_000, 5_000 * 2 ** (nextAttempt - 1)),
            supersededDeliveries: nextSuperseded,
            view: { ...pending.view, delivery: retryDelivery },
          };
          this.saveAttempt(key, nextPending);
          this.schedule(key, nextPending.retryAfter);
          return 'retry_later';
        }
      } else if (receipt === 'sent') {
        if (!cardId || pending.replaced) {
          cardId = await this.port.lookupMessageId?.(pending.view.delivery) ?? null;
          await guard();
        }
        this.confirmCard(key, pending, cardId);
        old = this.view(key);
        current = this.slot(key);
        pending = undefined;
      } else if (pending.retryAfter > Date.now()) {
        this.schedule(key, pending.retryAfter);
        return 'retry_later';
      } else if (receipt === 'not_sent') {
        this.clearUnknown(pending.view.delivery);
      }
    } else if (old) {
      // Older versions recorded the target view before the Feishu request settled.
      const receipt = await this.deliveryState(old.delivery);
      await guard();
      if (terminal && old.delivery.startsWith(finalId) && old.dirty === 0) {
        return receipt === 'sent' ? 'ready' : 'abandoned';
      }
      if (receipt === 'unknown') {
        if (!cardId || isTerminalTurn(old.status ?? undefined)) {
          return terminal ? abandonUnknown(old) : 'abandoned';
        }
        staleDeliveries.push(old.delivery);
        old = { ...old, signature: '', dirty: 1 };
      } else {
        rejected = receipt === 'rejected';
        if (receipt === 'not_sent') {
          this.clearUnknown(old.delivery);
          old = { ...old, status: null, title: '', signature: '', dirty: 1 };
          this.saveView(key, old);
          if (!cardId && isTerminalTurn(input.turn?.status)) {
            this.db.prepare(`DELETE FROM channel_stream_cards
              WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?`).run(...key);
            return 'ready';
          }
        } else if (receipt === 'sent' && !cardId) {
          cardId = await this.port.lookupMessageId?.(old.delivery) ?? null;
          await guard();
          if (cardId) this.db.prepare(`UPDATE channel_stream_cards SET card_id=?
            WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?`).run(cardId, ...key);
        }
      }
    }
    if (rejected && (old?.delivery.startsWith(finalId) || !terminal)) return 'abandoned';
    const now = Date.now();
    const schema = old?.schema ?? (cardId && !input.processCardId ? '1.0' : '2.0');
    const state = await this.cardState(input, status, schema);
    await guard();
    if (!terminal && (this.replySlot(key) || this.hasPendingFinalization(key))) return 'abandoned';
    if (status === 'queued') return 'abandoned';
    if (!terminal && !cardId && !pending && !old?.delivery) {
      const immediate = tools.some(tool => tool.tool !== 'thinking' || tool.phase === 'running') ||
        (input.toolCounts?.totalTools ?? 0) > tools.filter(tool => tool.tool === 'thinking').length ||
        Boolean(input.activeSubagents?.length || state.compactInfo?.isCompact || key[3].startsWith('wakeup:'));
      if (!immediate) {
        if (!message?.blocks.some(block => block.type === 'text' && block.text.trim())) return 'abandoned';
        const started = current?.updated_at || now;
        if (!current) {
          this.db.prepare("INSERT OR IGNORE INTO channel_stream_cards VALUES (?,?,?,?,NULL,0,?,0,'',0)").run(...key, started);
          current = this.slot(key);
        }
        if (started + PROCESS_CARD_TEXT_DELAY_MS > now) {
          this.schedule(key, started + PROCESS_CARD_TEXT_DELAY_MS);
          return 'retry_later';
        }
      }
    }
    this.cancel(key);
    // For terminal processing an existing Feishu message ID is required, even when creation just reconciled.
    if (terminal && !cardId) return 'abandoned';
    if (terminal && !pending && old?.delivery.startsWith(finalId) &&
      await this.deliveryState(old.delivery) === 'sent') return 'ready';
    const card = turnProcessCard(state);
    const signature = payloadDigest(card);
    const contentSignature = payloadDigest([status, card]);
    const heartbeat = () => {
      const start = state.startedAtMs;
      if (!terminal && sessionConnected && start !== null) {
        this.schedule(key, Math.max(now + 1, start + (Math.floor((now - start) / HEARTBEAT_MS) + 1) * HEARTBEAT_MS));
      }
    };
    if (!terminal && !pending && old?.status === status && staleDeliveries.length === 0 &&
      (old.signature === signature || (!terminal && old.status === 'running' && old.content_signature === contentSignature))) {
      if (old.dirty || !old.content_signature) this.saveView(key, { ...old, dirty: 0, content_signature: contentSignature });
      heartbeat();
      return 'ready';
    }
    if (!pending && cardId && current && current.updated_at + PATCH_INTERVAL_MS > now) {
      this.saveView(key, { schema, status: old?.status ?? null, title: old?.title ?? '', signature: old?.signature ?? '',
        content_signature: staleDeliveries.length ? '' : old?.content_signature ?? '', delivery: old?.delivery ?? firstId, dirty: 1 });
      this.schedule(key, current.updated_at + PATCH_INTERVAL_MS);
      return 'retry_later';
    }
    // A confirmed create can be patched only when its message ID is known.
    if (!cardId && old?.signature && !rejected && !pending?.replaced) return 'abandoned';
    const uniqueStale = [...new Set([...(pending?.supersededDeliveries ?? []), ...staleDeliveries])];
    const id = terminal ? finalId
      : cardId
        ? `turn-update:${payloadDigest(uniqueStale.length ? [key, old?.delivery ?? firstId, signature, uniqueStale] : [key, old?.delivery ?? firstId, signature])}`
        : firstId;
    const attempt: CardAttempt = {
      ...pending,
      ...(uniqueStale.length ? { supersededDeliveries: uniqueStale } : {}),
      view: { schema, status: status ?? null, title: card.title, signature, content_signature: contentSignature,
        delivery: pending?.view.delivery ?? id, dirty: 1 },
      message: slotMessage(message),
      plain: pending?.plain ?? false, retryAfter: pending?.retryAfter ?? 0,
    };
    const ready = await this.writeCard(key, card, attempt.replaced ? null : cardId, attempt, guard, () => {
      if (!current) this.db.prepare("INSERT INTO channel_stream_cards VALUES (?,?,?,?,NULL,0,0,0,'',0)").run(...key);
      this.saveView(key, old ? { ...old, dirty: 1 }
        : { schema, status: null, title: '', signature: '', delivery: '', dirty: 1 });
    });
    if (ready === 'ready') heartbeat();
    return ready;
  }
  private recordSlot(key: SlotKey, cardId: string | null, message?: SlotMessage): void {
    this.db.prepare(`UPDATE channel_stream_cards SET card_id=?,updated_at=?,current_message=?,latest_sequence=?,revision=?,final=?
      WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?`)
      .run(cardId, Date.now(), message?.messageId ?? '', message?.sequence ?? 0, message?.revision ?? 0, Number(!!message?.final), ...key);
  }

  async renderStreamMessage(input: TurnView): Promise<boolean> {
    if (this.replySlot(input.key) || this.hasPendingFinalization(input.key)) return false;
    return await this.putCard(input) === 'ready';
  }

  async finalizeTurnCard(input: TurnView): Promise<boolean> {
    const { key, processCardId } = input;
    const id = streamId(key);
    if (this.finalizing.has(id)) return false;
    this.finalizing.add(id);
    try {
      const guard = () => this.deps.guard([key[0], key[1], key[2]]);
      await guard();
      const old = this.view(key);
      if (!this.replySlot(key) && !processCardId) {
        const slot = this.slot(key);
        const settledView = old && isTerminalTurn(old.status ?? undefined) && !old.delivery.startsWith('turn-process-final:') &&
          (old.dirty === 0 || await this.deliveryState(old.delivery) !== 'not_sent');
        const settledSlot = !old && slot?.card_id != null && Number(slot.final) === 1;
        if (settledView || settledSlot) {
          await guard();
          this.clearFinalization(key);
          this.cancel(key);
          return true;
        }
      }
      await guard();
      const prior = this.pendingFinalization(key);
      const turn = input.turn ?? prior?.turn ?? {
        turnId: key[3], sessionId: key[1], status: readReplySignature(this.replySlot(key))?.status ?? 'completed', startedAt: null, endedAt: null,
        model: null, inputId: null, outputIds: [],
      };
      if (!isTerminalTurn(turn.status)) throw new Error('Expected a terminal turn for reply card finalization');
      const previousMessage = prior?.message;
      const message = !input.message || previousMessage?.messageId === input.message.messageId &&
        previousMessage.revision > input.message.revision ? previousMessage : input.message;
      const saved: PendingFinalization = {
        ...prior,
        turn: { ...turn, startedAt: turn.startedAt ?? prior?.turn.startedAt ?? null, endedAt: turn.endedAt ?? prior?.turn.endedAt ?? null },
        message,
        timing: input.timing && prior?.timing ? {
          ...input.timing,
          startedMs: input.timing.startedMs ?? prior.timing.startedMs,
          endedMs: input.timing.endedMs ?? prior.timing.endedMs,
        } : input.timing ?? prior?.timing,
        tools: input.tools.length ? input.tools : prior?.tools ?? [],
        toolCounts: input.toolCounts ?? prior?.toolCounts,
        ...(processCardId ? { processCardId } : {}),
        ...(input.isCliReadonly !== undefined ? { isCliReadonly: input.isCliReadonly } : {}),
        ...(input.contextUsage !== undefined ? { contextUsage: input.contextUsage } : {}),
        ...(input.activeSubagents?.length ? { activeSubagents: input.activeSubagents } : {}),
      };
      this.journal(() => {
        this.saveFinalization(key, saved);
        if (saved.processCardId) {
          this.db.prepare(`INSERT INTO channel_stream_cards VALUES (?,?,?,?,?,0,0,0,'',0)
            ON CONFLICT(destination,session_id,binding_scope,message_id)
            DO UPDATE SET card_id=COALESCE(channel_stream_cards.card_id,excluded.card_id)`).run(...key, saved.processCardId);
        }
      });
      this.cancel(key);
      const fullInput = { ...input, ...saved };
      const process = this.slot(key);
      // A deferred text-only slot is only a timer bookmark. Discard it when the turn finishes first.
      const attemptedProcess = this.attempt(key) || old?.delivery && await this.deliveryState(old.delivery) !== 'rejected';
      await guard();
      if (process?.card_id || attemptedProcess) {
        if (await this.putCard(fullInput) === 'retry_later') return false;
      } else if (process) {
        this.db.prepare(`DELETE FROM channel_stream_cards
          WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?`).run(...key);
      }
      await guard();
      if (await this.putReplyCard(fullInput, saved, guard) === 'retry_later') return false;
      this.clearFinalization(key);
      return true;
    } finally {
      this.finalizing.delete(id);
    }
  }

  private async putReplyCard(input: TurnView, pending: PendingFinalization, guard: () => Promise<void>): Promise<ReplyDelivery> {
    const { key } = input;
    if ((pending.replyRetryAfter ?? 0) > Date.now()) {
      this.schedule(key, pending.replyRetryAfter!);
      return 'retry_later';
    }
    const createId = deliveryId('turn-reply', key);
    let previous = this.replySlot(key);
    const previousDelivery = previous?.delivery_id ?? createId;
    const receipt = await this.deliveryState(previousDelivery);
    let cardId = previous?.card_id ?? null;
    if (receipt === 'sent' && !cardId) cardId = await this.port.lookupMessageId?.(previousDelivery) ?? null;
    await guard();
    if (receipt === 'rejected' || receipt === 'suppressed') return 'rejected';
    if (receipt === 'unknown' && (!cardId || previousDelivery === createId)) return 'retry_later';
    if (receipt === 'sent' && !cardId) return 'sent';
    if (cardId && previous && !previous.card_id) {
      const backfilled = this.db.prepare(`UPDATE channel_turn_reply_cards SET card_id=?
        WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=? AND delivery_id=? AND card_id IS NULL`)
        .run(cardId, ...key, previousDelivery);
      if (!backfilled.changes) return 'retry_later';
      previous = { ...previous, card_id: cardId };
    }
    const prior = readReplySignature(previous);
    const message = slotMessage(input.message);
    const staleMessage = prior?.message && (!message || message.sequence < prior.message.sequence ||
      message.messageId === prior.message.messageId && (message.revision < prior.message.revision || prior.message.final && !message.final));
    if (staleMessage) return receipt === 'sent' ? 'sent' : 'retry_later';
    const state = await this.cardState(input, pending.turn.status, '2.0', prior);
    const card = turnFinalReplyCard(state);
    const digest = payloadDigest(card);
    // This signature stores the displayed count. cardState only reuses it when no tool rows need filtering.
    const toolCounts = {
      turnId: key[3],
      totalTools: Math.max(0, (state.toolCounts?.totalTools ?? state.tools.length) -
        state.tools.filter(tool => tool.tool === 'thinking').length),
      failedTools: state.toolCounts?.failedTools ?? state.tools.filter(tool => tool.tool !== 'thinking' && tool.phase === 'failed').length,
    };
    // Keep the evidence used for a later reply refresh with the digest. The Core remains the source of the body.
    const signature = JSON.stringify({
      digest, message, startedAtMs: state.startedAtMs, endedAtMs: state.endedAtMs,
      completedAtMs: state.completedAtMs, status: state.status, compactInfo: state.compactInfo,
      contextUsage: state.contextUsage, modelBadge: state.modelBadge, toolCounts,
    } satisfies ReplySignature);
    await guard();
    const matches = (current: ReplySlot | undefined) => current?.delivery_id === previous?.delivery_id &&
      current?.signature === previous?.signature && current?.card_id === previous?.card_id && current?.updated_at === previous?.updated_at;
    if (receipt === 'sent' && (prior?.digest ?? previous?.signature) === digest) {
      if (previous && previous.signature !== signature && matches(this.replySlot(key))) {
        this.db.prepare(`UPDATE channel_turn_reply_cards SET signature=?
          WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=? AND delivery_id=? AND updated_at=?`)
          .run(signature, ...key, previousDelivery, previous.updated_at);
      }
      return 'sent';
    }

    const id = cardId ? receipt === 'sent'
      ? `turn-reply-update:${payloadDigest([key, previousDelivery, digest])}` : previousDelivery : createId;
    const updatedAt = Math.max(Date.now(), (previous?.updated_at ?? 0) + 1);
    if (receipt === 'unknown' && cardId && previous && previous.updated_at + REJECTION_RETRY_MS > Date.now()) {
      // PATCH is safe to reapply to the same message. Give an in-flight write time to record its receipt first.
      this.schedule(key, previous.updated_at + REJECTION_RETRY_MS);
      return 'retry_later';
    }
    const saveReply = () => this.db.prepare('INSERT OR REPLACE INTO channel_turn_reply_cards VALUES (?,?,?,?,?,?,?,?)')
      .run(...key, cardId, id, signature, updatedAt);
    let claimed = false;
    this.journal(() => {
      if (!matches(this.replySlot(key))) return;
      const inLedger = this.db.prepare('SELECT state FROM channel_deliveries WHERE delivery_id=?').get(id) as { state: string } | undefined;
      if ((receipt === 'not_sent' || receipt === 'unknown' && cardId) && inLedger?.state === 'unknown') this.clearUnknown(id);
      claimed = this.claim(id);
      if (claimed) saveReply();
    });
    if (!claimed) return 'retry_later';
    try {
      const payload = this.deps.stamp(key[0], pending.replyPlain ? { ...card, format: 'plain' } : card);
      if (cardId) await this.port.update(key[0], cardId, payload, id, guard);
      else cardId = await this.port.send(key[0], payload, id, guard) ?? null;
    } catch (error) {
      const failure = apiRejection(error);
      if (!failure) {
        await guard();
        if (cardId) this.schedule(key, updatedAt + REJECTION_RETRY_MS);
        throw error;
      }
      const plain = failure.platformCode === 230099 && !pending.replyPlain;
      const attempts = (pending.replyRateLimitAttempts ?? 0) + 1;
      const rateLimited = failure.platformCode === 230429 && attempts <= 6;
      await guard();
      let recorded = false;
      this.journal(() => {
        if (this.replySlot(key)?.updated_at !== updatedAt) return;
        recorded = true;
        if (plain || rateLimited) {
          this.clearUnknown(id);
          if (plain) pending.replyPlain = true;
          if (rateLimited) {
            pending.replyRateLimitAttempts = attempts;
            pending.replyRetryAfter = Date.now() + Math.min(30_000, REJECTION_RETRY_MS * 2 ** (attempts - 1));
          }
          this.saveFinalization(key, pending);
        } else {
          this.db.prepare("UPDATE channel_deliveries SET state='rejected' WHERE delivery_id=?").run(id);
          this.db.prepare("INSERT OR IGNORE INTO channel_delivery_diagnostics VALUES (?, 'api_rejected', ?)")
            .run(id, failure.platformCode ?? null);
        }
      });
      if (!recorded) return 'retry_later';
      if (plain) return this.putReplyCard(input, pending, guard);
      if (rateLimited) this.schedule(key, pending.replyRetryAfter!);
      return rateLimited ? 'retry_later' : 'rejected';
    }
    await guard();
    let confirmed = false;
    this.journal(() => {
      if (this.replySlot(key)?.updated_at === updatedAt) {
        this.delivered(id);
        saveReply();
        confirmed = true;
      }
    });
    return confirmed ? 'sent' : 'retry_later';
  }

  async sendFullReply(key: BindingKey, message: Message, guard: () => Promise<void>,
    reply: (card: ChannelCard) => Promise<string | void>, onSend: () => void) {
    const text = replyText(message);
    const digest = payloadDigest(text);
    const id = `full-reply:${payloadDigest([key, message.messageId, digest])}`;
    await guard();
    if (this.claim(id)) {
      onSend();
      await this.port.sendFile(key[0], `完整正文-${digest.slice(0, 12)}.txt`, Buffer.from(text, 'utf8'), id, guard);
      this.delivered(id);
      return { deliveryId: id };
    }
    const url = await this.port.fileMessageLink?.(key[0], key[1], id) ?? null;
    await reply(url ? { title: '全文已发送', text: '可打开原消息查看文件。', actions: [{ label: '定位原文件消息', value: {}, url }] }
      : { title: '全文发送状态未知', text: '尚无法定位原消息，请稍后查看。', actions: [] });
    return { deliveryId: id, status: url ? 'located' : 'unknown' };
  }

  async sync(key: BindingKey, snapshot: SessionSnapshot, events: readonly Event[],
    messages: readonly Message[], _allowed: () => boolean, expiredFrom?: number,
    options?: { isCliReadonly?: boolean; skipTurnIds?: ReadonlySet<string> }): Promise<void> {
    const [destination, sessionId, scope] = key;
    await this.backfillReadonlyBaseline(key);
    const turns = new Map(snapshot.turns?.map(turn => [turn.turnId, turn]));
    const snapshotTurns = new Set(turns.keys());
    const { session } = snapshot;
    const isCliReadonly = options?.isCliReadonly ?? scope.includes('"access_mode":"read_only"');
    const sessionConnected = session.control?.input === 'available' && session.status !== 'read_only' && session.status !== 'unreachable';
    const interrupt = !isCliReadonly && sessionConnected && session.capabilities?.interrupt?.status === 'available'
      ? { revision: session.revision, controlGeneration: session.control.generation } : undefined;
    const timing = new Map(snapshot.turnProgress?.timing.map(turn => [turn.turnId, turn]));
    const toolCounts = new Map(snapshot.turnProgress?.toolCounts?.map(counts => [counts.turnId, counts]));
    const tools = new Map<string, ToolProgress[]>();
    for (const tool of snapshot.turnProgress?.tools ?? []) {
      const entries = tools.get(tool.turnId) ?? [];
      entries.push(tool);
      tools.set(tool.turnId, entries);
    }
    const ids = new Set(messages.map(message => message.turnId || message.messageId));
    for (const event of events) {
      const data = event.data as Partial<Turn & { messageId: string }> | undefined;
      if (event.type === 'turn.updated') {
        ids.add(event.objectId);
        if (!snapshotTurns.has(event.objectId) && data?.status &&
          (isTerminalTurn(data.status) || !isTerminalTurn(turns.get(event.objectId)?.status))) {
          turns.set(event.objectId, { ...data, turnId: event.objectId } as Turn);
        }
      } else if (event.type === 'tool.updated') {
        const update = readToolProgress(event.data);
        if (update) ids.add(update.turnId);
      } else if (event.type === 'artifact.available' && data?.turnId && this.replySlot([...key, data.turnId])) {
        ids.add(data.turnId);
      }
    }
    for (const turn of turns.values()) if (turn.status === 'running' && (tools.has(turn.turnId) ||
      turn.turnId.startsWith('wakeup:') || this.compactBaselines.size > 0) ||
      expiredFrom !== undefined && (timing.get(turn.turnId)?.liveEndSequence ?? 0) > expiredFrom) ids.add(turn.turnId);
    const active = this.db.prepare(`SELECT s.message_id AS turn_id FROM channel_stream_cards s
      LEFT JOIN channel_turn_card_views v ON v.destination=s.destination AND v.session_id=s.session_id
        AND v.binding_scope=s.binding_scope AND v.turn_id=s.message_id
      WHERE s.destination=? AND s.session_id=? AND s.binding_scope=? AND
        (v.dirty=1 OR (v.status='running' OR v.status IS NULL AND s.final=0) AND NOT EXISTS (
          SELECT 1 FROM channel_deliveries WHERE delivery_id=v.delivery AND state='rejected'
        ) OR EXISTS (
          SELECT 1 FROM channel_deliveries d JOIN channel_delivery_diagnostics x USING(delivery_id)
          WHERE d.delivery_id=v.delivery AND d.state='unknown' AND x.kind='api_rejected' AND x.platform_code<>0
        ))`).all(destination, sessionId, scope) as { turn_id: string }[];
    for (const { turn_id } of active) ids.add(turn_id);
    const pending = this.db.prepare(`SELECT turn_id,terminal_input FROM channel_turn_pending_finalization
      WHERE destination=? AND session_id=? AND binding_scope=?`).all(...key) as { turn_id: string; terminal_input: string }[];
    const savedFinalizations = new Map<string, PendingFinalization>();
    for (const { turn_id, terminal_input } of pending) {
      const saved = JSON.parse(terminal_input) as PendingFinalization;
      savedFinalizations.set(turn_id, saved);
      ids.add(turn_id);
      if (!isTerminalTurn(turns.get(turn_id)?.status)) turns.set(turn_id, saved.turn);
      if (saved.timing && (!timing.has(turn_id) ||
        saved.timing.liveEndSequence !== null && timing.get(turn_id)?.liveEndSequence === null)) timing.set(turn_id, saved.timing);
    }
    if (expiredFrom !== undefined) {
      const recent = this.db.prepare(`SELECT turn_id FROM channel_turn_reply_cards
        WHERE destination=? AND session_id=? AND binding_scope=? ORDER BY updated_at DESC LIMIT 32`)
        .all(...key) as { turn_id: string }[];
      for (const slot of recent) ids.add(slot.turn_id);
    }
    for (const id of options?.skipTurnIds ?? []) ids.delete(id);
    const replies = new Map<string, Message[]>();
    const baselinedTurns = new Set<string>();
    const baselineMessage = this.db.prepare(`SELECT revision FROM channel_turn_baseline_messages
      WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?`);
    for (const message of snapshot.messages) {
      const id = message.turnId || message.messageId;
      if (message.role !== 'assistant' || message.sessionId !== sessionId || !ids.has(id)) continue;
      // Automatic read-only mirrors exclude the history captured when they were attached.
      const atBaseline = baselineMessage.get(...key, message.messageId);
      if (atBaseline && Number(atBaseline.revision) >= message.revision) {
        baselinedTurns.add(id);
        continue;
      }
      const items = replies.get(id) ?? [];
      items.push(message);
      replies.set(id, items);
    }
    let activeSubagents: readonly SessionSubagentActivity[] | undefined;
    const serviceGetSubagents = (this.service as {
      getActiveSubagents?: (id: string) => Promise<readonly SessionSubagentActivity[] | undefined> | readonly SessionSubagentActivity[] | undefined;
    }).getActiveSubagents;
    const subagentReader = this.deps.readActiveSubagents
      ? () => this.deps.readActiveSubagents!(session)
      : typeof serviceGetSubagents === 'function'
      ? () => serviceGetSubagents.call(this.service, sessionId)
      : undefined;
    if (subagentReader && (session.status === 'running' || [...ids].some(id => !isTerminalTurn(turns.get(id)?.status)))) {
      try { activeSubagents = await subagentReader(); } catch { /* Optional subagent snapshot */ }
    }
    if (activeSubagents?.length) {
      for (const turn of turns.values()) if (turn.status === 'running' && !options?.skipTurnIds?.has(turn.turnId)) ids.add(turn.turnId);
    }
    for (const id of ids) {
      const slot: SlotKey = [...key, id];
      const previous = this.slot(slot);
      const saved = savedFinalizations.get(id);
      const message = aggregateTurnAssistantMessage(replies.get(id) ?? [], id) ?? saved?.message;
      const turn = turns.get(id);
      const calls = tools.get(id) ?? saved?.tools ?? [];
      if (!message && !previous && !saved && baselinedTurns.has(id) && !this.replySlot(slot)) continue;
      if (message && previous && message.sequence < previous.latest_sequence && !isTerminalTurn(turn?.status)) continue;
      if (!message && !previous && !isTerminalTurn(turn?.status) && turn?.status !== 'running') continue;
      const input = { key: slot, turn, message, timing: timing.get(id), tools: calls, toolCounts: toolCounts.get(id),
        provider: session.native.provider, sessionConnected, isCliReadonly: saved?.isCliReadonly ?? isCliReadonly,
        ...(interrupt ? { interrupt } : {}), ...(activeSubagents?.length ? { activeSubagents } : {}) };
      if (isTerminalTurn(turn?.status) || !turn && (message?.final || input.timing?.endedMs != null)) {
        await this.finalizeTurnCard(input);
      } else {
        await this.renderStreamMessage(input);
      }
    }
  }
}
