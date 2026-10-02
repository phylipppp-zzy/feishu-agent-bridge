import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isRetryableTransportError } from "../inbound-events.js";
import type { CardActionOutcome, CardDefinition, FeishuPort, IncomingBotMenuAction, IncomingCardAction, IncomingFeishuMessage } from "../types.js";
import { CARD_TEXT_LIMIT, claudeCommandMenuCard, claudeHelpCard, claudeHomeCard, claudeNoticeCard, claudeRecentCard, claudeRootCard, claudeTurnCard,
  promptLine, sessionTitle, sourceLabel, transcriptMarkdown, turnMarkdown, turnText } from "./cards.js";
import type { ClaudeBridgeConfig } from "./config.js";
import { reduceTranscript, type TurnView } from "./conversation.js";
import type { ClaudeBridgeDatabase, ClaudeSession } from "./db.js";
import { isTranscriptPath, readTranscriptEvents, TranscriptImporter, transcriptSessionId } from "./importer.js";
import { PresenceWatcher, processAlive, type PresenceRecord } from "./presence.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Minimum time between two updates of one running turn card; Feishu limits message edits. */
const CARD_UPDATE_INTERVAL_MS = 1_500;
/** A session started this long before the bridge (re)started is still shown from its first turn. */
const NEW_SESSION_GRACE_MS = 10 * 60_000;
/** Waiting notices older than this are history by the time the bridge reads them. */
const WAITING_NOTICE_MAX_AGE_MS = 10 * 60_000;
const READONLY_NOTICE_INTERVAL_MS = 10 * 60_000;
/** A running turn with no new records for this long, in a session not running locally, is shown as unfinished. */
const STALE_TURN_MS = 30 * 60_000;
const PAGE_SIZE = 8;

function textHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }

/**
 * Read-only mirror of local Claude Code sessions into one private Feishu topic group:
 * one topic per session, one card per turn, live state from Claude Code hooks.
 */
export class ClaudeRuntime {
  private readonly projectsDir: string;
  private readonly importer: TranscriptImporter;
  private readonly presence: PresenceWatcher;
  private readonly renderQueues = new Map<string, Promise<void>>();
  private readonly renderTimers = new Map<string, NodeJS.Timeout>();
  private scanTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private bootstrapping: Promise<void> | null = null;
  /** Sessions that started before this moment and are seen for the first time count as history. */
  private newSessionCutoffMs = Date.now() - NEW_SESSION_GRACE_MS;

  constructor(
    private readonly config: ClaudeBridgeConfig,
    private readonly db: ClaudeBridgeDatabase,
    private readonly feishu: FeishuPort,
  ) {
    this.projectsDir = join(config.claudeHome, "projects");
    this.importer = new TranscriptImporter({
      projectsDir: this.projectsDir,
      isEnabled: () => Boolean(this.boundChatId()) && !this.paused(),
      needsRead: (path, size, mtimeMs, inode) => {
        const cursor = this.db.getCursor(path);
        return !cursor || cursor.inode !== inode || cursor.size !== size || cursor.mtimeMs < mtimeMs || cursor.offset > size;
      },
      processFile: (path) => this.processFile(path),
      onError: (operation, path, error) => this.fail(operation, { path }, error),
    });
    this.presence = new PresenceWatcher(join(config.stateDir, "presence"), (record) => this.applyPresence(record));
  }

  async start(): Promise<void> {
    await mkdir(this.projectsDir, { recursive: true });
    await this.presence.start();
    await this.importer.startWatching();
    this.db.pruneRetainedData();
    this.scanTimer = setInterval(() => { void this.periodicSync(); }, this.config.scanIntervalMs);
    this.scanTimer.unref();
    this.livenessTimer = setInterval(() => { void this.checkLiveness(); }, this.config.livenessIntervalMs);
    this.livenessTimer.unref();
    if (this.boundChatId()) void this.bootstrap();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    for (const timer of this.renderTimers.values()) clearTimeout(timer);
    this.renderTimers.clear();
    await this.importer.stopWatching();
    await this.presence.stop();
    await Promise.allSettled(this.renderQueues.values());
  }

  syncAll(): Promise<void> { return this.importer.syncChangedFiles(); }

  private boundChatId(): string | null { return this.db.getSetting("feishu.chat_id"); }
  private boundOpenId(): string | null { return this.db.getSetting("feishu.open_id"); }
  private paused(): boolean { return this.stopping || this.db.getSetting("sync.paused") === "1"; }

  private fail(operation: string, detail: Record<string, unknown>, error: unknown): void {
    this.db.recordFailure(operation, detail, error);
    console.error(`Claude bridge ${operation} failed`, detail, error);
  }

  /** First full pass after start or binding: index sessions, then apply hook states that arrived meanwhile. */
  private bootstrap(): Promise<void> {
    this.bootstrapping ??= (async () => {
      await this.syncAll();
      await this.presence.scan();
      await this.checkLiveness();
    })().catch((error) => this.fail("bootstrap", {}, error)).finally(() => { this.bootstrapping = null; });
    return this.bootstrapping;
  }

  private async periodicSync(): Promise<void> {
    if (!this.boundChatId() || this.paused()) return;
    await this.syncAll();
    for (const sessionId of this.db.sessionsNeedingRender(Date.now() - STALE_TURN_MS)) void this.renderSession(sessionId);
  }

  private async processFile(path: string): Promise<void> {
    if (!this.boundChatId() || this.paused()) return;
    const sessionId = transcriptSessionId(path);
    if (!sessionId) return;
    let info;
    try { info = await stat(path); } catch { return; }
    if (!info.isFile()) return;
    const inode = String(info.ino);
    const cursor = this.db.getCursor(path);
    // A replaced or truncated file is read again from the start; turn keys keep that idempotent.
    const fromStart = !cursor || cursor.inode !== inode || info.size < cursor.offset;
    const start = fromStart ? 0 : cursor.offset;
    const { events, next } = start < info.size ? await readTranscriptEvents(path, start, info.size) : { events: [], next: start };
    const session = this.db.getSession(sessionId);
    const stored = !fromStart && session?.currentTurnId ? this.db.getTurn(session.currentTurnId) : null;
    const result = reduceTranscript(sessionId, stored?.view ?? null, events);
    const lastActivityMs = result.lastAt ? Date.parse(result.lastAt) : null;
    const startedAtMs = result.firstAt ? Date.parse(result.firstAt) : null;

    // Which touched turns become cards. A whole-file read is history: show only the last
    // turn of recently active sessions, everything of sessions that just started.
    const visible = new Set<string>();
    const saved = new Map<string, TurnView>();
    if (!fromStart) {
      for (const turn of result.touched) { visible.add(turn.turnId); saved.set(turn.turnId, turn); }
    } else {
      const recent = (lastActivityMs ?? info.mtimeMs) >= Date.now() - this.config.historyDays * DAY_MS;
      const justStarted = startedAtMs !== null && startedAtMs >= this.newSessionCutoffMs;
      if (justStarted) for (const turn of result.touched) { visible.add(turn.turnId); saved.set(turn.turnId, turn); }
      else if (result.current) {
        // Keep the latest turn so later records continue it; it stays hidden unless the session is recent.
        saved.set(result.current.turnId, result.current);
        if (recent || session?.rootMessageId) visible.add(result.current.turnId);
      }
    }
    this.db.transaction(() => {
      this.db.updateSession({ sessionId, path, meta: result.meta, firstPrompt: result.firstHumanPrompt,
        startedAtMs: fromStart ? startedAtMs : null, lastActivityMs });
      for (const turn of saved.values()) this.db.saveTurn(sessionId, turn, visible.has(turn.turnId) ? "pending" : "hidden");
      if (result.current) this.db.setCurrentTurn(sessionId, result.current.turnId);
      this.db.saveCursor({ path, sessionId, inode, offset: next, size: info.size, mtimeMs: info.mtimeMs });
      // No hook reports that a permission prompt was answered: a transcript record newer than
      // the waiting report means the person answered locally and the turn goes on.
      if (session?.presenceState === "waiting" && lastActivityMs !== null && lastActivityMs > session.presenceAtMs) {
        this.db.updatePresence({ sessionId, path: null, cwd: null, state: "running", atMs: lastActivityMs,
          pid: session.presencePid, pidStart: session.presencePidStart, message: null });
      }
    });
    if (visible.size || session?.rootMessageId) await this.renderSession(sessionId);
  }

  /** Renders one session at a time so its cards keep their order and are never edited concurrently. */
  renderSession(sessionId: string): Promise<void> {
    const previous = this.renderQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.renderNow(sessionId))
      .catch((error) => this.fail("render_session", { sessionId }, error));
    this.renderQueues.set(sessionId, next);
    void next.finally(() => { if (this.renderQueues.get(sessionId) === next) this.renderQueues.delete(sessionId); });
    return next;
  }

  private scheduleRender(sessionId: string, delayMs: number): void {
    if (this.stopping || this.renderTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.renderTimers.delete(sessionId);
      void this.renderSession(sessionId);
    }, Math.max(50, delayMs));
    timer.unref();
    this.renderTimers.set(sessionId, timer);
  }

  private simpleCards(): boolean { return this.db.getSetting("cards.simple_tools") === "1"; }

  private staleTurn(turn: TurnView, session: ClaudeSession): boolean {
    if (turn.status !== "running" || session.presenceState === "running" || session.presenceState === "waiting") return false;
    const updated = Date.parse(turn.updatedAt);
    return Number.isFinite(updated) && Date.now() - updated > STALE_TURN_MS;
  }

  /** Sends a turn card; if Feishu rejects the folded tool panel, falls back to plain lines for good. */
  private async sendTurnCard(rootId: string, turn: TurnView, stale: boolean): Promise<{ messageId: string; hash: string }> {
    const simple = this.simpleCards();
    try { return { messageId: await this.feishu.replyCard(rootId, claudeTurnCard(turn, { simpleTools: simple, stale })), hash: this.cardHash(turn, simple, stale) }; }
    catch (error) {
      if (simple || isRetryableTransportError(error)) throw error;
      // Switch for good only when the same card without the folded panel is accepted.
      const messageId = await this.feishu.replyCard(rootId, claudeTurnCard(turn, { simpleTools: true, stale }));
      this.db.setSetting("cards.simple_tools", "1");
      this.fail("collapsible_panel", {}, error);
      return { messageId, hash: this.cardHash(turn, true, stale) };
    }
  }

  private cardHash(turn: TurnView, simple: boolean, stale: boolean): string {
    // Element ids change per build, so the hash covers the content rather than the card JSON.
    return textHash(JSON.stringify({ simple, stale, status: turn.status, durationMs: turn.durationMs, blocks: turn.blocks, omitted: turn.omittedTools }));
  }

  private async renderNow(sessionId: string): Promise<void> {
    const chatId = this.boundChatId();
    if (!chatId || this.stopping) return;
    let session = this.db.getSession(sessionId);
    if (!session) return;
    const turns = this.db.turnsToRender(sessionId);
    if (!session.rootMessageId) {
      if (!turns.length) return;
      const root = await this.feishu.createSessionRoot(chatId, sessionTitle(session), "", claudeRootCard(session));
      this.db.setSessionRoot(sessionId, root.messageId, root.appLink, root.chatId);
      session = this.db.getSession(sessionId)!;
    }
    const rootId = session.rootMessageId!;
    const simple = this.simpleCards();
    let deferMs = 0;
    for (const turn of turns) {
      const view = turn.view;
      const stale = this.staleTurn(view, session);
      if (!turn.cardMessageId) {
        if (!turn.promptMessageId) {
          const line = promptLine(view);
          if (line) this.db.setTurnPromptMessage(turn.turnId, await this.feishu.replyText(rootId, line));
        }
        const sent = await this.sendTurnCard(rootId, view, stale);
        this.db.setTurnCard(turn.turnId, sent.messageId, sent.hash);
      } else {
        const hash = this.cardHash(view, simple, stale);
        if (hash !== turn.renderedHash) {
          const wait = turn.renderedAtMs + CARD_UPDATE_INTERVAL_MS - Date.now();
          if (wait > 0 && view.status === "running" && !stale) { deferMs = Math.max(deferMs, wait); continue; }
          await this.feishu.updateCard(turn.cardMessageId, claudeTurnCard(view, { simpleTools: simple, stale }));
          this.db.setTurnCard(turn.turnId, turn.cardMessageId, hash);
        }
      }
      if (view.status !== "running" && !turn.attachmentMessageId && turnText(view).length > CARD_TEXT_LIMIT) {
        const name = `${sessionTitle(session).slice(0, 20).replace(/[\\/:*?"<>|\s]+/g, "_")}-${turn.turnId.slice(0, 8)}.md`;
        this.db.setTurnAttachment(turn.turnId, await this.feishu.replyFile(rootId, name, Buffer.from(turnMarkdown(session, view))));
      }
    }
    if (this.db.getSession(sessionId)?.rootDirty) {
      await this.feishu.updateCard(rootId, claudeRootCard(this.db.getSession(sessionId)!));
      this.db.clearRootDirty(sessionId);
    }
    if (deferMs) this.scheduleRender(sessionId, deferMs);
  }

  private async applyPresence(record: PresenceRecord): Promise<void> {
    if (!this.boundChatId()) return;
    const path = record.transcriptPath && isTranscriptPath(record.transcriptPath, this.projectsDir) ? record.transcriptPath : null;
    const before = this.db.getSession(record.sessionId);
    if (!before && !path) return;
    const session = this.db.updatePresence({ sessionId: record.sessionId, path, cwd: record.cwd, state: record.state, atMs: record.at,
      pid: record.pid, pidStart: record.pidStartTime, message: record.message });
    if (!session?.rootMessageId) return;
    if (record.state === "waiting" && session.presenceAtMs === record.at && session.waitingNotifiedAtMs < record.at && record.at >= Date.now() - WAITING_NOTICE_MAX_AGE_MS) {
      this.db.setWaitingNotified(session.sessionId, record.at);
      await this.feishu.replyText(session.rootMessageId, `⏳ 这个会话在${sourceLabel(session.entrypoint)}中等待你处理${record.message ? `：${record.message}` : "。"}`)
        .catch((error) => this.fail("waiting_notice", { sessionId: session.sessionId }, error));
    }
    await this.renderSession(session.sessionId);
  }

  /** Marks sessions closed when the Claude Code process a hook reported has exited without a SessionEnd. */
  private async checkLiveness(): Promise<void> {
    for (const session of this.db.livePresenceSessions()) {
      if (session.presencePid === null || processAlive(session.presencePid, session.presencePidStart)) continue;
      this.db.updatePresence({ sessionId: session.sessionId, path: null, cwd: null, state: "closed", atMs: Math.max(Date.now(), session.presenceAtMs),
        pid: null, pidStart: null, message: null });
      if (session.rootMessageId) void this.renderSession(session.sessionId);
    }
  }

  private homeCard(notice = ""): CardDefinition {
    return claudeHomeCard({ paused: this.paused(), ...this.db.sessionCounts(), failures: this.db.failureCount() }, notice);
  }

  private recentCard(search = "", page = 0): CardDefinition {
    const rows = this.db.listRecentSessions(PAGE_SIZE + 1, page * PAGE_SIZE, search);
    return claudeRecentCard(rows.slice(0, PAGE_SIZE), search, page, rows.length > PAGE_SIZE);
  }

  private async ensureControlCard(): Promise<void> {
    const chatId = this.boundChatId();
    if (!chatId || this.db.getSetting("feishu.control_card_id")) return;
    this.db.setSetting("feishu.control_card_id", await this.feishu.sendCard(chatId, this.homeCard("Claude 桥接已绑定")));
  }

  /** Creates the topic of an indexed session on demand and shows its latest turn. */
  private async openSession(sessionId: string): Promise<ClaudeSession | null> {
    const session = this.db.getSession(sessionId);
    if (!session) return null;
    if (!session.rootMessageId) {
      const current = session.currentTurnId ? this.db.getTurn(session.currentTurnId) : null;
      if (current) this.db.saveTurn(sessionId, current.view, "pending");
      else {
        // Nothing stored yet: read the transcript once so its latest turn can be shown.
        const { events } = await readTranscriptEvents(session.path, 0, (await stat(session.path)).size);
        const latest = reduceTranscript(sessionId, null, events).current;
        if (latest) { this.db.saveTurn(sessionId, latest, "pending"); this.db.setCurrentTurn(sessionId, latest.turnId); }
      }
      await this.renderSession(sessionId);
    }
    return this.db.getSession(sessionId);
  }

  private async exportSession(sessionId: string): Promise<void> {
    const session = await this.openSession(sessionId);
    if (!session?.rootMessageId) return;
    const { events } = await readTranscriptEvents(session.path, 0, (await stat(session.path)).size);
    const turns = reduceTranscript(sessionId, null, events).touched;
    const name = `${sessionTitle(session).slice(0, 30).replace(/[\\/:*?"<>|\s]+/g, "_")}-${sessionId.slice(0, 8)}.md`;
    await this.feishu.replyFile(session.rootMessageId, name, Buffer.from(transcriptMarkdown(session, turns)));
  }

  async onFeishuMessage(message: IncomingFeishuMessage): Promise<void> {
    const eventId = `message:${message.messageId}`;
    if (!this.db.claimInboundEvent(eventId)) return;
    try {
      await this.handleFeishuMessage(message);
      this.db.completeInboundEvent(eventId);
    } catch (error) {
      this.db.failInboundEvent(eventId, error, isRetryableTransportError(error));
      throw error;
    }
  }

  private respond(message: IncomingFeishuMessage, text: string): Promise<string> {
    return message.rootId ? this.feishu.replyText(message.rootId, text) : this.feishu.sendText(message.chatId, text);
  }

  private respondCard(message: IncomingFeishuMessage, card: CardDefinition): Promise<string> {
    return message.rootId ? this.feishu.replyCard(message.rootId, card) : this.feishu.sendCard(message.chatId, card);
  }

  private async handleFeishuMessage(message: IncomingFeishuMessage): Promise<void> {
    const chatId = this.boundChatId();
    if (!chatId) {
      if (message.chatType === "group" && !message.mentionedBot) return;
      if (message.text.trim() !== `/bind ${this.config.bindToken}`) return;
      this.db.setSetting("feishu.chat_id", message.chatId);
      this.db.setSetting("feishu.open_id", message.senderOpenId);
      this.db.setSetting("feishu.bound_at", new Date().toISOString());
      this.newSessionCutoffMs = Date.now() - NEW_SESSION_GRACE_MS;
      await this.feishu.sendText(message.chatId, `绑定成功。正在同步最近 ${this.config.historyDays} 天有活动的 Claude 会话；绑定码已失效。`);
      await this.ensureControlCard();
      void this.bootstrap();
      return;
    }
    if (message.chatId !== chatId || message.senderOpenId !== this.boundOpenId()) return;
    const command = message.text.trim();
    const normalized = command.toLowerCase();
    const session = message.rootId ? this.db.getSessionByRoot(message.rootId) : null;
    if (message.chatType === "group" && !message.mentionedBot && !session && !command.startsWith("/")) return;
    // As in the Codex bridge, plain-word shortcuts only count in the group's main timeline.
    const isCommand = (slash: readonly string[], words: readonly string[] = []) => slash.includes(normalized) || (!session && words.includes(normalized));
    if (normalized === "/") { await this.respondCard(message, claudeCommandMenuCard()); return; }
    if (isCommand(["/help"], ["help", "帮助", "?", "？"])) { await this.respondCard(message, claudeHelpCard()); return; }
    if (isCommand(["/home", "/status"], ["控制台", "状态"])) { await this.respondCard(message, this.homeCard()); return; }
    if (isCommand(["/sessions"], ["会话", "最近"])) { await this.respondCard(message, this.recentCard()); return; }
    if (normalized === "/search" || normalized.startsWith("/search ")) {
      await this.respondCard(message, this.recentCard([...command.slice(7).trim()].slice(0, 120).join("")));
      return;
    }
    if (isCommand(["/sync"], ["同步"])) { await this.respondCard(message, this.homeCard("已开始同步")); void this.syncAll(); return; }
    if (isCommand(["/pause"], ["暂停"])) { this.db.setSetting("sync.paused", "1"); await this.respondCard(message, this.homeCard("同步已暂停")); return; }
    if (isCommand(["/resume-sync"], ["恢复"])) {
      this.db.setSetting("sync.paused", "0");
      await this.respondCard(message, this.homeCard("同步已恢复"));
      void this.syncAll();
      return;
    }
    if (session && normalized === "/export") {
      await this.respond(message, "正在导出完整记录…");
      await this.exportSession(session.sessionId);
      return;
    }
    if (session) {
      if (Date.now() - session.readonlyNoticeAtMs < READONLY_NOTICE_INTERVAL_MS) return;
      this.db.setReadonlyNotice(session.sessionId, Date.now());
      await this.respond(message, `目前是只读镜像，飞书里的消息不会发给 Claude。要继续这个会话：在电脑上用 VS Code 打开它，或运行 claude --resume ${session.sessionId}；手机上可以先在 VS Code 中输入 /rc，再用 Claude App 接续。发送 /export 可以导出完整记录。`);
      return;
    }
    await this.respondCard(message, claudeCommandMenuCard(command.startsWith("/") ? `未知命令：${command.slice(0, 40)}` : "目前是只读镜像：可以查看本机 Claude 会话，暂不支持从飞书新建或继续对话。"));
  }

  async onCardAction(event: IncomingCardAction): Promise<CardActionOutcome> {
    const eventId = `card:${event.eventId ?? textHash(JSON.stringify({ action: event.action, value: event.value, formValues: event.formValues, chat: event.chatId, message: event.openMessageId, operator: event.openId }))}`;
    if (!this.db.claimInboundEvent(eventId)) return { delivery: "replace", card: claudeNoticeCard("操作已处理", "该操作已处理、过期或正在处理中。") };
    try {
      const outcome = await this.handleCardAction(event);
      this.db.completeInboundEvent(eventId);
      return outcome;
    } catch (error) {
      this.db.failInboundEvent(eventId, error, isRetryableTransportError(error));
      throw error;
    }
  }

  private async handleCardAction(event: IncomingCardAction): Promise<CardActionOutcome> {
    if (event.openId !== this.boundOpenId() || event.chatId !== this.boundChatId()) return { delivery: "none" };
    const sessionId = typeof event.value.sessionId === "string" ? event.value.sessionId : "";
    const replace = (card: CardDefinition): CardActionOutcome => ({ delivery: "replace", card });
    switch (event.action) {
      case "home": return replace(this.homeCard());
      case "help": return replace(claudeHelpCard());
      case "command_menu": return replace(claudeCommandMenuCard());
      case "recent": return replace(this.recentCard());
      case "recent_page": return replace(this.recentCard(typeof event.value.search === "string" ? event.value.search : "", Math.max(0, Number(event.value.page) || 0)));
      case "search_sessions": {
        const value = event.formValues.session_search;
        return replace(this.recentCard(typeof value === "string" ? value.trim().slice(0, 120) : ""));
      }
      case "sync": void this.syncAll(); return replace(this.homeCard("已开始同步"));
      case "pause": this.db.setSetting("sync.paused", "1"); return replace(this.homeCard("同步已暂停"));
      case "resume": this.db.setSetting("sync.paused", "0"); void this.syncAll(); return replace(this.homeCard("同步已恢复"));
      case "open_session": {
        const session = await this.openSession(sessionId);
        if (!session) return replace(claudeNoticeCard("无法打开", "没有找到这个会话。", "red"));
        return replace(this.recentCard());
      }
      case "export_session": {
        const session = this.db.getSession(sessionId);
        if (!session) return replace(claudeNoticeCard("无法导出", "没有找到这个会话。", "red"));
        void this.exportSession(sessionId).catch((error) => this.fail("export_session", { sessionId }, error));
        return replace(claudeRootCard(session));
      }
      case "refresh_session": {
        const session = this.db.getSession(sessionId);
        if (!session) return replace(claudeNoticeCard("无法刷新", "没有找到这个会话。", "red"));
        this.db.clearRootDirty(sessionId);
        return replace(claudeRootCard(session));
      }
      default: return replace(claudeNoticeCard("未知操作", `这个按钮在当前版本中不可用：${event.action}`, "red"));
    }
  }

  async onBotMenuAction(action: IncomingBotMenuAction): Promise<void> {
    const eventId = `menu:${action.eventId}`;
    if (!this.db.claimInboundEvent(eventId)) return;
    try {
      const chatId = this.boundChatId();
      if (chatId && action.openId === this.boundOpenId()) {
        const cards: Record<string, () => CardDefinition> = {
          "claude.home": () => this.homeCard(), "claude.service": () => this.homeCard(),
          "claude.sessions": () => this.recentCard(), "claude.search": () => this.recentCard(),
        };
        const build = cards[action.eventKey];
        if (build) await this.feishu.sendCard(chatId, build());
      }
      this.db.completeInboundEvent(eventId);
    } catch (error) {
      this.db.failInboundEvent(eventId, error, isRetryableTransportError(error));
      throw error;
    }
  }
}
