import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from './adapter.js';
import { payloadDigest, type Artifact, type Event, type Message, type SessionSnapshot, type Turn } from './contracts.js';
import type { FeishuPort } from './feishu-channel.js';
import type { ChannelCard } from './feishu-cards.js';
import { isTerminalTurn, readToolProgress, type ToolProgress } from './tool-progress.js';
import { aggregateTurnAssistantMessage } from './turn-reply.js';
import { completionText, formatCompactModelBadge, replyText, turnProgressCard } from './turn-progress-card.js';
import { timestampMs, type TurnTiming, type TurnToolCounts } from './turn-progress-store.js';

function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const LONG_TURN_NOTICE_MS = 120_000;
const PATCH_INTERVAL_MS = positiveEnvMs('FEISHU_PATCH_INTERVAL_MS', 1500);
const HEARTBEAT_MS = 15_000;
const REJECTION_RETRY_MS = positiveEnvMs('FEISHU_REJECTION_RETRY_MS', 3_000);

type BindingKey = [destination: string, sessionId: string, scope: string];
type SlotKey = [...BindingKey, turnId: string];
type Slot = { card_id: string | null; updated_at: number; current_message: string; latest_sequence: number };
type SlotMessage = Pick<Message, 'messageId' | 'sequence' | 'revision' | 'final'>;
type CardAttempt = {
  view: View; message?: SlotMessage | undefined; plain: boolean; retryAfter: number;
  attempts?: number; replaced?: boolean;
};
type View = { schema: '1.0' | '2.0'; status: Turn['status'] | null; title: string; signature: string; delivery: string; dirty: number };
type PendingFinalization = { turn: Turn; timing?: TurnTiming | undefined };

interface Dependencies {
  guard(key: BindingKey): Promise<void>;
  stamp(destination: string, card: ChannelCard): ChannelCard;
  wake(destination: string): void;
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

function apiRejection(error: unknown): { platformCode?: number } | undefined {
  const failure = error as { deliveryKind?: string; platformCode?: number } | null;
  if (failure && (failure.deliveryKind === 'api_rejected' ||
    Number.isInteger(failure.platformCode) && failure.platformCode !== 0)) return failure;
}

export class TurnCardDelivery {
  private readonly timers = new Map<string, { key: SlotKey; at: number; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
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
    `);
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
  private view(key: SlotKey): View | undefined {
    return this.db.prepare('SELECT * FROM channel_turn_card_views WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?')
      .get(...key) as View | undefined;
  }
  private saveView(key: SlotKey, view: View): void {
    this.db.prepare('INSERT OR REPLACE INTO channel_turn_card_views VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(...key, view.schema, view.status, view.title, view.signature, view.delivery, view.dirty);
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
    guard: () => Promise<void>, prepareSlot?: () => void): Promise<boolean> {
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
    if (!claimed) return false;
    try {
      const payload = this.deps.stamp(destination, plain ? { ...card, format: 'plain' } : card);
      if (cardId) await this.port.update(destination, cardId, payload, id, guard);
      else cardId = await this.port.send(destination, payload, id, guard) ?? null;
    } catch (error) {
      const failure = apiRejection(error);
      if (!failure) throw error;
      const terminal = isTerminalTurn(view.status ?? undefined);
      const attempts = (attempt.attempts ?? 0) + Number(failure.platformCode === 230429);
      let retry: CardAttempt | undefined;
      if (failure.platformCode === 230099 && !plain) {
        retry = { ...attempt, plain: true, view: { ...view, delivery: `${id}:plain` }, retryAfter: 0 };
      } else if (failure.platformCode === 230429 && attempts <= 6) {
        const delay = Math.min(30_000, REJECTION_RETRY_MS * 2 ** (attempts - 1));
        retry = { ...attempt, attempts, retryAfter: Date.now() + delay };
      } else if (cardId !== null && terminal && !attempt.replaced) {
        retry = { ...attempt, attempts, plain: true, replaced: true,
          view: { ...view, delivery: `${id}:replace` }, retryAfter: 0 };
      }
      await guard();
      this.journal(() => {
        if (retry?.view.delivery === id) this.clearUnknown(id);
        else {
          this.db.prepare("UPDATE channel_deliveries SET state='rejected' WHERE delivery_id=?").run(id);
          this.db.prepare("INSERT OR IGNORE INTO channel_delivery_diagnostics VALUES (?, 'api_rejected', ?)")
            .run(id, failure.platformCode ?? null);
        }
        if (retry) this.saveAttempt(key, retry);
        else {
          this.saveView(key, { ...view, dirty: 0 });
          this.db.prepare(`DELETE FROM channel_turn_card_attempts
            WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).run(...key);
        }
      });
      if (!retry) {
        this.cancel(key);
        return terminal;
      }
      if (!retry.retryAfter) return this.writeCard(key, card, retry.replaced ? null : cardId, retry, guard);
      this.schedule(key, retry.retryAfter);
      return false;
    }
    await guard();
    this.confirmCard(key, attempt, cardId);
    return true;
  }
  private async putCard(input: TurnView): Promise<boolean> {
    const { key, message, tools, toolCounts, provider, timing, sessionConnected } = input;
    const [destination, sessionId] = key;
    const binding: BindingKey = [key[0], key[1], key[2]];
    const guard = () => this.deps.guard(binding);
    let current = this.slot(key);
    let old = this.view(key);
    let cardId = current?.card_id ?? null;
    const firstId = streamId(key);
    const finalId = deliveryId('turn-final', key);
    let pending = this.attempt(key);
    let rejected = false;
    if (pending) {
      const receipt = await this.deliveryState(pending.view.delivery);
      await guard();
      if (receipt === 'unknown') {
        const canRetryIdempotentPatch =
          cardId !== null &&
          !pending.replaced &&
          isTerminalTurn(pending.view.status ?? undefined) &&
          (pending.attempts ?? 0) < 3;
        if (!canRetryIdempotentPatch) return false;
        if (pending.retryAfter > Date.now()) {
          this.schedule(key, pending.retryAfter);
          return false;
        }
        const nextAttempt = (pending.attempts ?? 0) + 1;
        const retryDelivery = `${finalId}:patch-retry-${nextAttempt}`;
        const nextPending: CardAttempt = {
          ...pending,
          attempts: nextAttempt,
          retryAfter: Date.now() + Math.min(20_000, 5_000 * 2 ** (nextAttempt - 1)),
          view: { ...pending.view, delivery: retryDelivery },
        };
        this.saveAttempt(key, nextPending);
        pending = nextPending;
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
        return false;
      } else if (receipt === 'not_sent') {
        this.clearUnknown(pending.view.delivery);
      }
    } else if (old) {
      // Older versions recorded the target view before the Feishu request settled.
      const receipt = await this.deliveryState(old.delivery);
      await guard();
      if (receipt === 'unknown') return false;
      rejected = receipt === 'rejected';
      if (receipt === 'not_sent') {
        this.clearUnknown(old.delivery);
        old = { ...old, status: null, title: '', signature: '', dirty: 1 };
        this.saveView(key, old);
      } else if (receipt === 'sent' && !cardId) {
        cardId = await this.port.lookupMessageId?.(old.delivery) ?? null;
        await guard();
        if (cardId) this.db.prepare(`UPDATE channel_stream_cards SET card_id=?
          WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?`).run(cardId, ...key);
      }
    }
    const status = isTerminalTurn(old?.status ?? undefined) ? old!.status! : input.turn?.status ??
      (old?.status === 'running' || message && !message.final ? 'running' : undefined);
    const terminal = isTerminalTurn(status);
    if (rejected && isTerminalTurn(old?.status ?? undefined)) return true;
    if (rejected && !terminal) return false;
    const ticking = status === 'running' && sessionConnected &&
      (input.turn?.status === 'running' || message?.final === false);
    if (!ticking) this.cancel(key);
    const now = Date.now();
    const schema = old?.schema ?? (current ? '1.0' : '2.0');
    const start = timing?.startedMs ?? timestampMs(input.turn?.startedAt);
    const end = timing?.endedMs ?? timestampMs(input.turn?.endedAt);
    const elapsed = start !== null && (terminal ? end !== null && end >= start : ticking && now >= start)
      ? (terminal ? end! - start : Math.floor((now - start) / HEARTBEAT_MS) * HEARTBEAT_MS) : null;
    let files: Artifact[] = [];
    if (message && (terminal || !input.turn && message.final)) {
      try { files = await this.service.findRegisteredReplyFiles?.(sessionId, message.blocks) ?? []; }
      catch { /* File actions are optional; the persisted reply can still be delivered. */ }
    }
    let modelBadge = '';
    try {
      const settings = await this.service.getConfirmedSettings?.(sessionId);
      modelBadge = formatCompactModelBadge(
        input.turn?.model ?? settings?.model,
        settings?.preferences?.reasoningEffort ?? settings?.preferences?.effort,
      );
    } catch {
      modelBadge = formatCompactModelBadge(input.turn?.model);
    }
    await guard();
    const card = turnProgressCard({ provider, status, schema, message, tools, toolCounts, duration: elapsed, files, turnId: key[3], ...(modelBadge ? { modelBadge } : {}) });
    const learnedDuration = status === 'completed' && elapsed !== null && !old?.title.includes(' · 用时 ');
    if (old?.title && isTerminalTurn(old.status ?? undefined) && !learnedDuration) card.title = old.title;
    const signature = payloadDigest(card);
    const heartbeat = () => {
      if (ticking && start !== null) this.schedule(key, Math.max(now + 1, start + (Math.floor((now - start) / HEARTBEAT_MS) + 1) * HEARTBEAT_MS));
    };
    if (!pending && old?.signature === signature) {
      if (old.dirty) this.saveView(key, { ...old, dirty: 0 });
      heartbeat();
      return true;
    }
    if (!pending && current && current.updated_at + PATCH_INTERVAL_MS > now) {
      this.saveView(key, { schema, status: old?.status ?? null, title: old?.title ?? '', signature: old?.signature ?? '', delivery: old?.delivery ?? firstId, dirty: 1 });
      this.schedule(key, current.updated_at + PATCH_INTERVAL_MS);
      return false;
    }
    // A confirmed create can be patched only when its message ID is known.
    if (!cardId && old?.signature && !rejected && !pending?.replaced) return false;
    const id = terminal && !isTerminalTurn(old?.status ?? undefined) ? finalId
      : cardId ? `turn-update:${payloadDigest([key, old?.delivery ?? firstId, signature])}` : firstId;
    const attempt: CardAttempt = {
      ...pending,
      view: { schema, status: status ?? null, title: card.title, signature, delivery: pending?.view.delivery ?? id, dirty: 1 },
      message: message && { messageId: message.messageId, sequence: message.sequence, revision: message.revision, final: message.final },
      plain: pending?.plain ?? false, retryAfter: 0,
    };
    const ready = await this.writeCard(key, card, attempt.replaced ? null : cardId, attempt, guard, () => {
      if (!current) this.db.prepare("INSERT INTO channel_stream_cards VALUES (?,?,?,?,NULL,0,0,0,'',0)").run(...key);
      this.saveView(key, old ? { ...old, dirty: 1 }
        : { schema, status: null, title: '', signature: '', delivery: '', dirty: 1 });
    });
    if (ready) heartbeat();
    return ready;
  }
  private recordSlot(key: SlotKey, cardId: string | null, message?: SlotMessage): void {
    this.db.prepare(`UPDATE channel_stream_cards SET card_id=?,updated_at=?,current_message=?,latest_sequence=?,revision=?,final=?
      WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?`)
      .run(cardId, Date.now(), message?.messageId ?? '', message?.sequence ?? 0, message?.revision ?? 0, Number(!!message?.final), ...key);
  }

  renderStreamMessage(input: TurnView): Promise<boolean> { return this.putCard(input); }

  finalizeTurnCard(input: TurnView): Promise<boolean> {
    return this.putCard(input);
  }

  private async maybeSendCompletionNotice(input: TurnView, allowed: () => boolean): Promise<boolean> {
    const { key, timing, tools, toolCounts, message } = input;
    const id = deliveryId('turn-push', key);
    const receipt = await this.deliveryState(id);
    if (receipt === 'sent' || receipt === 'suppressed') return true;
    if (receipt === 'unknown') return false;
    const guard = () => this.deps.guard([key[0], key[1], key[2]]);
    await guard();
    const baseline = this.db.prepare('SELECT sequence FROM channel_turn_baseline WHERE destination=? AND session_id=? AND binding_scope=?')
      .get(key[0], key[1], key[2]) as { sequence: number } | undefined;
    const report = timing && timing.startedMs !== null && timing.endedMs !== null && timing.liveStartSequence !== null &&
      timing.liveEndSequence !== null && timing.liveStartSequence > (baseline?.sequence ?? 0) ? timing : null;
    const duration = report ? report.endedMs! - report.startedMs! : 0;
    const policy = report && this.db.prepare(`SELECT allowed FROM channel_turn_notice_policy
      WHERE destination=? AND session_id=? AND binding_scope=? AND sequence<? ORDER BY sequence DESC LIMIT 1`)
      .get(key[0], key[1], key[2], report.liveEndSequence!) as { allowed: number } | undefined;
    const eligible = allowed() && policy?.allowed !== 0 && this.port.isTopicDestination?.(key[0]) !== false;
    // The snapshot can finish a live turn before the matching end observation arrives.
    if (eligible && timing?.liveEndSequence === null && (timing.liveStartSequence ?? 0) > (baseline?.sequence ?? 0)) return false;
    const suppress = !eligible || duration < LONG_TURN_NOTICE_MS;
    let claimed = false;
    if (receipt === 'not_sent') {
      this.journal(() => {
        this.clearUnknown(id);
        claimed = this.claim(id, suppress ? 'suppressed' : 'unknown');
      });
    } else {
      claimed = this.claim(id, suppress ? 'suppressed' : 'unknown');
    }
    if (suppress || !claimed) return suppress && claimed;
    const text = completionText(duration, message, toolCounts?.totalTools ?? tools.length);
    if (this.port.sendText) await this.port.sendText(key[0], text, id, guard);
    else await this.port.send(key[0], { title: text, text: '', format: 'plain', actions: [] }, id, guard);
    await guard();
    this.delivered(id);
    return true;
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
    messages: readonly Message[], allowed: () => boolean, expiredFrom?: number): Promise<void> {
    const [destination, sessionId, scope] = key;
    await this.backfillReadonlyBaseline(key);
    const turns = new Map(snapshot.turns?.map(turn => [turn.turnId, turn]));
    const snapshotTurns = new Set(turns.keys());
    const { session } = snapshot;
    const sessionConnected = session.control?.input === 'available' && session.status !== 'read_only' && session.status !== 'unreachable';
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
      } else if (event.type === 'artifact.available' && data?.turnId && this.slot([...key, data.turnId])) {
        ids.add(data.turnId);
      }
    }
    for (const turn of turns.values()) if (turn.status === 'running' && tools.has(turn.turnId) ||
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
    for (const { turn_id, terminal_input } of pending) {
      const saved = JSON.parse(terminal_input) as PendingFinalization;
      ids.add(turn_id);
      if (!snapshotTurns.has(turn_id) && !isTerminalTurn(turns.get(turn_id)?.status)) turns.set(turn_id, saved.turn);
      if (saved.timing && (!timing.has(turn_id) ||
        saved.timing.liveEndSequence !== null && timing.get(turn_id)?.liveEndSequence === null)) timing.set(turn_id, saved.timing);
    }
    if (expiredFrom !== undefined) {
      const recent = this.db.prepare(`SELECT message_id FROM channel_stream_cards
        WHERE destination=? AND session_id=? AND binding_scope=? ORDER BY updated_at DESC LIMIT 32`)
        .all(...key) as { message_id: string }[];
      for (const slot of recent) ids.add(slot.message_id);
    }
    const replies = new Map<string, Message[]>();
    const baselineMessage = this.db.prepare(`SELECT revision FROM channel_turn_baseline_messages
      WHERE destination=? AND session_id=? AND binding_scope=? AND message_id=?`);
    for (const message of snapshot.messages) {
      const id = message.turnId || message.messageId;
      if (message.role !== 'assistant' || message.sessionId !== sessionId || !ids.has(id)) continue;
      // Automatic read-only mirrors exclude the history captured when they were attached.
      const atBaseline = baselineMessage.get(...key, message.messageId);
      if (atBaseline && Number(atBaseline.revision) >= message.revision) continue;
      const items = replies.get(id) ?? [];
      items.push(message);
      replies.set(id, items);
    }
    for (const id of ids) {
      const slot: SlotKey = [...key, id];
      const previous = this.slot(slot);
      const message = aggregateTurnAssistantMessage(replies.get(id) ?? [], id);
      const turn = turns.get(id);
      const calls = tools.get(id) ?? [];
      if (message && previous && message.sequence < previous.latest_sequence) continue;
      if (!message && !previous && turn?.status !== 'completed' && (!calls.length || !turn || turn.status === 'queued')) continue;
      const input = { key: slot, turn, message, timing: timing.get(id), tools: calls, toolCounts: toolCounts.get(id),
        provider: session.native.provider, sessionConnected };
      if (turn && isTerminalTurn(turn.status)) {
        // The cursor can advance ahead of a throttled PATCH. Keep the terminal
        // decision recoverable independently of the card's dirty flag.
        await this.deps.guard(key);
        this.db.prepare(`INSERT INTO channel_turn_pending_finalization VALUES (?,?,?,?,?)
          ON CONFLICT(destination,session_id,binding_scope,turn_id) DO UPDATE SET terminal_input=excluded.terminal_input
          WHERE terminal_input<>excluded.terminal_input`).run(...slot, JSON.stringify({ turn, timing: input.timing }));
        const ready = await this.finalizeTurnCard(input);
        // Record disabled notices even while a final PATCH is throttled.
        const settled = turn.status !== 'completed' || (!allowed() || ready) && await this.maybeSendCompletionNotice(input, allowed);
        if (ready && settled) {
          this.db.prepare(`DELETE FROM channel_turn_pending_finalization
            WHERE destination=? AND session_id=? AND binding_scope=? AND turn_id=?`).run(...slot);
        }
      } else {
        await this.renderStreamMessage(input);
      }
    }
  }
}
