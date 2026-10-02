import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { shorten } from "../card-kit.js";
import { isRetryableTransportError } from "../inbound-events.js";
import { isExpiredFeishuMessage } from "../safe-log.js";
import type { CardActionOutcome, CardDefinition, FeishuPort, IncomingBotMenuAction, IncomingCardAction, IncomingFeishuMessage } from "../types.js";
import { CARD_TEXT_LIMIT, claudeCleanupCard, claudeCleanupResultCard, claudeCommandMenuCard, claudeConflictCard, claudeHelpCard, claudeHomeCard,
  claudeInteractionDoneCard, claudeModeCard, claudeModelCard, claudeNewSessionCard, claudeNewTaskCard, claudeNoticeCard, claudePermissionCard, claudePlanCard,
  claudeQuestionCard, claudeRecentCard, claudeRootCard, claudeStartedCard, claudeTurnCard, displayPath, promptLine, scopeLabel, sessionTitle, sourceLabel, transcriptMarkdown,
  turnMarkdown, turnText, type LiveState } from "./cards.js";
import { inSyncScope, type ClaudeBridgeConfig } from "./config.js";
import { reduceTranscript, type TurnView } from "./conversation.js";
import type { ClaudeBridgeDatabase, ClaudeSession } from "./db.js";
import { isTranscriptPath, projectFolderName, readTranscriptEvents, sessionProjectDir, TranscriptImporter, transcriptSessionId } from "./importer.js";
import { askedQuestions, InteractionRegistry, planResult, questionResult, typedAnswer, type Interaction } from "./interactions.js";
import { PresenceWatcher, processAlive, type PresenceRecord } from "./presence.js";
import { EFFORT_LEVELS, FEISHU_PERMISSION_MODES, imageMediaType, SessionRunner, type EffortLevel, type FeishuPermissionMode, type ImageInput,
  type QueryFactory } from "./runner.js";
import { toolSummary } from "./transcript.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Minimum time between two updates of one running turn card; Feishu limits message edits. */
const CARD_UPDATE_INTERVAL_MS = 1_500;
/** A session started this long before the bridge (re)started is still shown from its first turn. */
const NEW_SESSION_GRACE_MS = 10 * 60_000;
/** Waiting notices older than this are history by the time the bridge reads them. */
const WAITING_NOTICE_MAX_AGE_MS = 10 * 60_000;
/** A running turn with no new records for this long, in a session not running locally, is shown as unfinished. */
const STALE_TURN_MS = 30 * 60_000;
const PAGE_SIZE = 8;
const CLEANUP_CONFIRM_MS = 10 * 60_000;
/** How long the choice between forking and continuing a session open on this computer stays valid. */
const CONFLICT_CONFIRM_MS = 10 * 60_000;
/** How long a task sent in the main timeline waits for its directory to be picked. */
const DRAFT_MS = 30 * 60_000;
/** Images per message and bytes per image Claude accepts. */
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const RUNNER_CLOSE_WAIT_MS = 5_000;
/** Live reply text is pushed to the card at most this often; the card itself is updated at most every CARD_UPDATE_INTERVAL_MS. */
const LIVE_TEXT_RENDER_MS = 300;
const FALLBACK_MODELS = [{ value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }, { value: "haiku", label: "Haiku" }];
/** Withdrawing a message that is already deleted (230110) or recalled (230011) counts as done. */
const ALREADY_GONE = /\b(?:230110|230011)\b/;
/** Why Feishu refused to withdraw a message, for the cleanup report (codes from the recall API). */
function recallFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/\b230009\b/.test(text)) return "超过撤回时限（默认为发出后 24 小时，可由企业管理员在管理后台调整）";
  if (/\b230026\b/.test(text)) return "机器人无权撤回这条消息";
  if (/\b230002\b/.test(text)) return "机器人已不在群里";
  if (/\b232009\b/.test(text)) return "群已解散";
  return text.slice(0, 120);
}

function textHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
/** Element ids are new in every build of a card; the content is what matters. */
function cardContentHash(card: CardDefinition): string { return textHash(JSON.stringify(card).replace(/"element_id":"[^"]*"/g, "")); }
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function effortLevel(value: string | null): EffortLevel | null {
  return EFFORT_LEVELS.includes(value as EffortLevel) ? value as EffortLevel : null;
}

/** What the person sent from Feishu for Claude. */
interface FeishuInput {
  text: string;
  imageKeys: string[];
  /** The Feishu message the text and images came from. */
  sourceMessageId: string;
  /** Set when that message is in the session's topic, so the bridge does not post the prompt again. */
  shownMessageId: string | null;
}

/** A Claude Code process the bridge runs for a session continued from Feishu. */
interface RunnerEntry {
  runner: SessionRunner;
  /** The person chose to continue in the session although it is open on this computer. */
  takeover: boolean;
  /** The process was asked to exit; new messages start a fresh one. */
  closing: boolean;
  idleTimer: NodeJS.Timeout | null;
  /** The prompt Claude is answering, and the reply text not yet in the transcript. */
  livePrompt: string | null;
  liveText: string;
}

/**
 * Mirrors local Claude Code sessions into one private Feishu topic group (one topic per
 * session, one card per turn, live state from Claude Code hooks) and continues them from
 * Feishu: a reply in a topic resumes the session in a Claude Code process on this computer.
 * Every turn, wherever it runs, reaches Feishu through the session's transcript.
 */
export class ClaudeRuntime {
  private readonly projectsDir: string;
  private readonly importer: TranscriptImporter;
  private readonly presence: PresenceWatcher;
  private readonly renderQueues = new Map<string, Promise<void>>();
  private readonly renderTimers = new Map<string, NodeJS.Timeout>();
  /** What each root card shows now, so an unchanged card is not sent to Feishu again. */
  private readonly rootHashes = new Map<string, string>();
  private readonly runners = new Map<string, RunnerEntry>();
  private readonly interactions = new InteractionRegistry();
  private readonly conflicts = new Map<string, { sessionId: string; input: FeishuInput; expiresAt: number }>();
  private readonly drafts = new Map<string, { input: FeishuInput; expiresAt: number }>();
  private scanTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private bootstrapping: Promise<void> | null = null;
  private modelsCached = false;
  /** Sessions that started before this moment and are seen for the first time count as history. */
  private newSessionCutoffMs = Date.now() - NEW_SESSION_GRACE_MS;

  constructor(
    private readonly config: ClaudeBridgeConfig,
    private readonly db: ClaudeBridgeDatabase,
    private readonly feishu: FeishuPort,
    private readonly queryFactory?: QueryFactory,
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
    await this.stopRunners();
    await this.importer.stopWatching();
    await this.presence.stop();
    await Promise.allSettled(this.renderQueues.values());
  }

  syncAll(): Promise<void> { return this.importer.syncChangedFiles(); }

  private boundChatId(): string | null { return this.db.getSetting("feishu.chat_id"); }
  private boundOpenId(): string | null { return this.db.getSetting("feishu.open_id"); }
  private paused(): boolean { return this.stopping || this.db.getSetting("sync.paused") === "1"; }
  /** Sessions outside SYNC_DIRS are read for their working directory only and never shown in Feishu. */
  private inScope(cwd: string | null): boolean { return inSyncScope(cwd, this.config.syncDirs); }

  private fail(operation: string, detail: Record<string, unknown>, error: unknown): void {
    this.db.recordFailure(operation, detail, error);
    console.error(`Claude bridge ${operation} failed`, detail, error);
  }

  /** First full pass after start or binding: index sessions, then apply hook states that arrived meanwhile. */
  private bootstrap(): Promise<void> {
    this.bootstrapping ??= (async () => {
      await this.syncAll();
      await this.reconcileTopics();
      await this.presence.scan();
      await this.checkLiveness();
    })().catch((error) => this.fail("bootstrap", {}, error)).finally(() => { this.bootstrapping = null; });
    return this.bootstrapping;
  }

  /**
   * At every start, each existing topic's root card is brought in line with SYNC_DIRS: topics
   * out of scope are marked once, topics back in scope are restored. No topic is created for
   * past activity, because Feishu can only append: a topic appears when its session is active,
   * so the group keeps the order in which sessions were actually used.
   */
  private async reconcileTopics(): Promise<void> {
    this.db.setSetting("sync.scope", JSON.stringify(this.config.syncDirs));
    // Sessions indexed before the bridge resolved starting directories may record a subdirectory.
    for (const session of this.db.sessionDirectories()) {
      const projectDir = sessionProjectDir(session.path, session.cwd);
      if (projectDir && projectDir !== session.cwd) this.db.setSessionCwd(session.sessionId, projectDir);
    }
    for (const session of this.db.topicSessions()) await this.renderSession(session.sessionId);
  }

  /** Topics whose session lies outside SYNC_DIRS. */
  private outOfScopeTopics(): ClaudeSession[] {
    return this.db.topicSessions().filter((session) => !this.inScope(session.cwd));
  }

  // Everything posted in a session's topic is recorded, so a cleanup can withdraw it again.
  private async topicText(sessionId: string, rootId: string, text: string): Promise<string> {
    const id = await this.feishu.replyText(rootId, text);
    this.db.recordSentMessage(sessionId, id);
    return id;
  }
  private async topicCard(sessionId: string, rootId: string, card: CardDefinition): Promise<string> {
    const id = await this.feishu.replyCard(rootId, card);
    this.db.recordSentMessage(sessionId, id);
    return id;
  }
  private async topicFile(sessionId: string, rootId: string, name: string, data: Buffer): Promise<string> {
    const id = await this.feishu.replyFile(rootId, name, data);
    this.db.recordSentMessage(sessionId, id);
    return id;
  }

  /** A short message in the session's topic, or in the main timeline while it has none; failures are only logged. */
  private async topicNotice(sessionId: string, text: string): Promise<void> {
    try {
      const session = this.db.getSession(sessionId);
      if (session?.rootMessageId) await this.topicText(sessionId, session.rootMessageId, text);
      else {
        const chatId = this.boundChatId();
        if (chatId) await this.feishu.sendText(chatId, text);
      }
    } catch (error) { this.fail("topic_notice", { sessionId }, error); }
  }

  /** Updates a root card; one too old for Feishu to edit is left as it is instead of failing every render. */
  private async updateRootCard(session: ClaudeSession, card: CardDefinition): Promise<void> {
    try { await this.feishu.updateCard(session.rootMessageId!, card); }
    catch (error) { if (!isExpiredFeishuMessage(error)) throw error; }
  }

  private rootCard(session: ClaudeSession): CardDefinition {
    const source = session.forkedFrom ? this.db.getSession(session.forkedFrom) : null;
    return claudeRootCard(session, {
      live: this.liveState(session.sessionId), feishuMode: this.feishuMode(session), feishuModel: session.prefModel, feishuEffort: session.prefEffort,
      ...(source ? { forkedFrom: { title: sessionTitle(source), link: source.rootAppLink } } : {}),
    });
  }

  /**
   * Withdraws every message the bridge posted in the given out-of-scope topics. A topic whose
   * root could be withdrawn is forgotten; one whose root stays (for example past Feishu's recall
   * window) keeps its link, so it can still be marked and continued.
   */
  private async cleanupTopics(sessionIds: readonly string[]): Promise<void> {
    const kept: Array<{ title: string; reason: string }> = [];
    let withdrawn = 0;
    let topics = 0;
    for (const sessionId of sessionIds) {
      const session = this.db.getSession(sessionId);
      if (!session?.rootMessageId || this.inScope(session.cwd)) continue;
      topics += 1;
      let rootGone = false;
      for (const messageId of this.db.topicMessages(sessionId)) {
        try {
          await this.feishu.deleteMessage(messageId);
          withdrawn += 1;
          if (messageId === session.rootMessageId) rootGone = true;
        } catch (error) {
          if (ALREADY_GONE.test(error instanceof Error ? error.message : String(error))) { if (messageId === session.rootMessageId) rootGone = true; continue; }
          kept.push({ title: messageId === session.rootMessageId ? `${sessionTitle(session)}（根卡片）` : sessionTitle(session), reason: recallFailure(error) });
        }
      }
      if (rootGone) this.db.detachTopic(sessionId);
    }
    const chatId = this.boundChatId();
    if (chatId) await this.feishu.sendCard(chatId, claudeCleanupResultCard({ topics, withdrawn, kept }));
  }

  private async periodicSync(): Promise<void> {
    const now = Date.now();
    for (const [nonce, pending] of this.conflicts) if (pending.expiresAt < now) this.conflicts.delete(nonce);
    for (const [nonce, draft] of this.drafts) if (draft.expiresAt < now) this.drafts.delete(nonce);
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
    const stored = !fromStart && session?.currentTurnId ? this.db.getTurn(sessionId, session.currentTurnId) : null;
    const result = reduceTranscript(sessionId, stored?.view ?? null, events);
    // The session belongs to the directory it was started in, wherever its shell has moved since.
    const projectDir = sessionProjectDir(path, result.meta.cwd ?? session?.cwd ?? null);
    const meta = projectDir ? { ...result.meta, cwd: projectDir } : result.meta;
    const lastActivityMs = result.lastAt ? Date.parse(result.lastAt) : null;
    const startedAtMs = result.firstAt ? Date.parse(result.firstAt) : null;

    // Which touched turns become cards. A whole-file read is history: show only the last
    // turn of recently active sessions, everything of sessions that just started.
    const visible = new Set<string>();
    const saved = new Map<string, TurnView>();
    const scoped = this.inScope(projectDir);
    if (!scoped) {
      // Out of scope: keep only the latest turn, so the session can still be shown if SYNC_DIRS changes.
      if (result.current) saved.set(result.current.turnId, result.current);
    } else if (!fromStart) {
      for (const turn of result.touched) {
        saved.set(turn.turnId, turn);
        // A turn that began while it was not shown (history, or outside SYNC_DIRS) stays hidden even
        // when it ends now; only turns that start from here on are appended to the topic.
        if (turn.turnId !== stored?.turnId || stored.renderState !== "hidden") visible.add(turn.turnId);
      }
    } else if (session?.forkedFrom) {
      // A fork's transcript starts with a copy of the original's history, which its topic already
      // shows; the fork's topic starts with the first prompt sent to the fork from Feishu.
      const first = result.touched.findIndex((turn) => this.db.feishuPrompt(sessionId, turn.turnId));
      result.touched.forEach((turn, index) => { if (first >= 0 && index >= first) { saved.set(turn.turnId, turn); visible.add(turn.turnId); } });
      if (result.current && !saved.has(result.current.turnId)) saved.set(result.current.turnId, result.current);
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
      this.db.updateSession({ sessionId, path, meta, firstPrompt: result.firstHumanPrompt,
        startedAtMs: fromStart ? startedAtMs : null, lastActivityMs });
      for (const turn of saved.values()) {
        // Prompts sent from Feishu are recorded by Claude Code as SDK input; show where they came from.
        const feishu = this.db.feishuPrompt(sessionId, turn.turnId);
        if (feishu) turn.entrypoint = "feishu";
        this.db.saveTurn(sessionId, turn, visible.has(turn.turnId) ? "pending" : "hidden", feishu?.messageId ? `feishu:${feishu.messageId}` : null);
      }
      if (result.current) this.db.setCurrentTurn(sessionId, result.current.turnId);
      this.db.saveCursor({ path, sessionId, inode, offset: next, size: info.size, mtimeMs: info.mtimeMs });
      // No hook reports that a permission prompt was answered: a transcript record newer than
      // the waiting report means the person answered locally and the turn goes on.
      if (session?.presenceState === "waiting" && lastActivityMs !== null && lastActivityMs > session.presenceAtMs) {
        this.db.updatePresence({ sessionId, path: null, cwd: null, state: "running", atMs: lastActivityMs,
          pid: session.presencePid, pidStart: session.presencePidStart, message: null });
      }
    });
    if (scoped && (visible.size || session?.rootMessageId)) await this.renderSession(sessionId);
  }

  /** Reads what Claude Code has written to a session's transcript so far, and renders it. */
  private async flushTranscript(sessionId: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (session) await this.importer.enqueue(session.path);
  }

  /** Runs work for one session at a time, so its cards keep their order and are never edited concurrently. */
  private serialized<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.renderQueues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(work);
    const settled = result.then(() => undefined, () => undefined);
    this.renderQueues.set(sessionId, settled);
    void settled.finally(() => { if (this.renderQueues.get(sessionId) === settled) this.renderQueues.delete(sessionId); });
    return result;
  }

  renderSession(sessionId: string): Promise<void> {
    return this.serialized(sessionId, () => this.renderNow(sessionId)).catch((error) => this.fail("render_session", { sessionId }, error));
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
    // A turn run from Feishu may wait for an answer as long as the person needs.
    if (this.runners.get(session.sessionId)?.runner.busy) return false;
    const updated = Date.parse(turn.updatedAt);
    return Number.isFinite(updated) && Date.now() - updated > STALE_TURN_MS;
  }

  /** The turn with the reply Claude is still writing, which the transcript only gets once a block is complete. */
  private withLiveText(view: TurnView, entry: RunnerEntry | undefined): TurnView {
    const text = entry?.liveText.trim();
    if (!text || entry?.livePrompt !== view.turnId || view.status !== "running") return view;
    if (view.blocks.some((block) => block.kind === "text" && block.text === text)) return view;
    return { ...view, blocks: [...view.blocks, { key: "live", kind: "text", text: `${text} ▍` }] };
  }

  /** Sends a turn card; if Feishu rejects the folded tool panel, falls back to plain lines for good. */
  private async sendTurnCard(sessionId: string, rootId: string, turn: TurnView, stale: boolean): Promise<{ messageId: string; hash: string }> {
    const simple = this.simpleCards();
    try { return { messageId: await this.topicCard(sessionId, rootId, claudeTurnCard(turn, { simpleTools: simple, stale })), hash: this.cardHash(turn, simple, stale) }; }
    catch (error) {
      if (simple || isRetryableTransportError(error)) throw error;
      // Switch for good only when the same card without the folded panel is accepted.
      const messageId = await this.topicCard(sessionId, rootId, claudeTurnCard(turn, { simpleTools: true, stale }));
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
    if (!this.inScope(session.cwd)) {
      // Out of scope: the topic is left as it is, apart from saying so on its root card once.
      if (session.rootMessageId && !session.rootOutOfScope) {
        await this.updateRootCard(session, claudeRootCard(session, { outOfScope: scopeLabel(this.config.syncDirs) }));
        this.db.setRootOutOfScope(sessionId, true);
        this.rootHashes.delete(sessionId);
      }
      return;
    }
    const turns = this.db.turnsToRender(sessionId);
    if (!session.rootMessageId) {
      if (!turns.length) return;
      const card = this.rootCard(session);
      const root = await this.feishu.createSessionRoot(chatId, sessionTitle(session), "", card);
      this.db.setSessionRoot(sessionId, root.messageId, root.appLink, root.chatId);
      this.db.recordSentMessage(sessionId, root.messageId);
      this.rootHashes.set(sessionId, cardContentHash(card));
      session = this.db.getSession(sessionId)!;
    }
    const rootId = session.rootMessageId!;
    const simple = this.simpleCards();
    const live = this.runners.get(sessionId);
    let deferMs = 0;
    for (const turn of turns) {
      const view = this.withLiveText(turn.view, live);
      const stale = this.staleTurn(view, session);
      if (!turn.cardMessageId) {
        if (!turn.promptMessageId) {
          const line = promptLine(view);
          if (line) this.db.setTurnPromptMessage(sessionId, turn.turnId, await this.topicText(sessionId, rootId, line));
        }
        const sent = await this.sendTurnCard(sessionId, rootId, view, stale);
        this.db.setTurnCard(sessionId, turn.turnId, sent.messageId, sent.hash);
      } else {
        const hash = this.cardHash(view, simple, stale);
        if (hash !== turn.renderedHash) {
          const wait = turn.renderedAtMs + CARD_UPDATE_INTERVAL_MS - Date.now();
          if (wait > 0 && view.status === "running" && !stale) { deferMs = Math.max(deferMs, wait); continue; }
          await this.feishu.updateCard(turn.cardMessageId, claudeTurnCard(view, { simpleTools: simple, stale }));
          this.db.setTurnCard(sessionId, turn.turnId, turn.cardMessageId, hash);
        }
      }
      if (view.status !== "running" && !turn.attachmentMessageId && turnText(view).length > CARD_TEXT_LIMIT) {
        const name = `${sessionTitle(session).slice(0, 20).replace(/[\\/:*?"<>|\s]+/g, "_")}-${turn.turnId.slice(0, 8)}.md`;
        this.db.setTurnAttachment(sessionId, turn.turnId, await this.topicFile(sessionId, rootId, name, Buffer.from(turnMarkdown(session, view))));
      }
    }
    const latest = this.db.getSession(sessionId)!;
    if (latest.rootDirty || latest.rootOutOfScope) {
      // Cleared before the update: a change that arrives while it is in flight marks the card again.
      this.db.setRootOutOfScope(sessionId, false);
      const card = this.rootCard(latest);
      const hash = cardContentHash(card);
      if (latest.rootOutOfScope || this.rootHashes.get(sessionId) !== hash) {
        try { await this.updateRootCard(latest, card); }
        catch (error) { this.db.markRootDirty(sessionId); throw error; }
        this.rootHashes.set(sessionId, hash);
      }
    }
    if (deferMs) this.scheduleRender(sessionId, deferMs);
  }

  /** Creates the topic of a session started or forked from Feishu, before Claude writes anything. */
  private createTopic(sessionId: string): Promise<ClaudeSession> {
    return this.serialized(sessionId, async () => {
      const chatId = this.boundChatId();
      const session = this.db.getSession(sessionId);
      if (!chatId || !session) throw new Error("the bridge is not bound or the session is unknown");
      if (!session.rootMessageId) {
        const card = this.rootCard(session);
        const root = await this.feishu.createSessionRoot(chatId, sessionTitle(session), "", card);
        this.db.setSessionRoot(sessionId, root.messageId, root.appLink, root.chatId);
        this.db.recordSentMessage(sessionId, root.messageId);
        this.rootHashes.set(sessionId, cardContentHash(card));
      }
      return this.db.getSession(sessionId)!;
    });
  }

  /** Shows a changed live state or preference on the session's root card. */
  private refreshRoot(sessionId: string): void {
    if (this.stopping) return;
    this.db.markRootDirty(sessionId);
    void this.renderSession(sessionId);
  }

  private async applyPresence(record: PresenceRecord): Promise<void> {
    if (!this.boundChatId()) return;
    const path = record.transcriptPath && isTranscriptPath(record.transcriptPath, this.projectsDir) ? record.transcriptPath : null;
    const before = this.db.getSession(record.sessionId);
    if (!before && !path) return;
    const session = this.db.updatePresence({ sessionId: record.sessionId, path, cwd: record.cwd, state: record.state, atMs: record.at,
      pid: record.pid, pidStart: record.pidStartTime, message: record.message });
    if (!session?.rootMessageId || !this.inScope(session.cwd)) return;
    if (record.state === "waiting" && session.presenceAtMs === record.at && session.waitingNotifiedAtMs < record.at && record.at >= Date.now() - WAITING_NOTICE_MAX_AGE_MS) {
      this.db.setWaitingNotified(session.sessionId, record.at);
      await this.topicText(session.sessionId, session.rootMessageId, `⏳ 这个会话在${sourceLabel(session.entrypoint)}中等待你处理${record.message ? `：${record.message}` : "。"}`)
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

  // ---- Running sessions for Feishu ----

  /** The live state of the bridge's own Claude Code process for a session, for its root card. */
  private liveState(sessionId: string): LiveState | null {
    const entry = this.runners.get(sessionId);
    if (!entry || entry.closing) return null;
    if (this.interactions.has(sessionId)) return "waiting";
    return entry.runner.busy ? "running" : "idle";
  }

  /** The permission mode Feishu turns use: the one chosen in Feishu, else the session's own, never one that skips permission checks. */
  private feishuMode(session: ClaudeSession): FeishuPermissionMode {
    const valid = (mode: string | null): mode is FeishuPermissionMode => FEISHU_PERMISSION_MODES.includes(mode as FeishuPermissionMode);
    return valid(session.prefMode) ? session.prefMode : valid(session.permissionMode) ? session.permissionMode : "default";
  }

  /** Whether VS Code or a terminal has the session open, as the Claude Code hooks report it. */
  private openElsewhere(session: ClaudeSession): boolean {
    if (session.presenceState !== "idle" && session.presenceState !== "running" && session.presenceState !== "waiting") return false;
    return session.presencePid === null || processAlive(session.presencePid, session.presencePidStart);
  }

  private transcriptPathFor(cwd: string, sessionId: string): string {
    return join(this.projectsDir, projectFolderName(cwd), `${sessionId}.jsonl`);
  }

  /** The session's process if it can take messages; one that is exiting is waited for, so a new one can start. */
  private async activeRunner(sessionId: string): Promise<RunnerEntry | undefined> {
    const entry = this.runners.get(sessionId);
    if (!entry?.closing) return entry;
    await entry.runner.closed(RUNNER_CLOSE_WAIT_MS);
    if (this.runners.get(sessionId) === entry) { entry.runner.terminate(); this.runners.delete(sessionId); }
    return undefined;
  }

  private startRunner(sessionId: string, options: { mode: "new" | "resume" | "fork"; cwd: string; forkFrom?: string }, takeover = false): RunnerEntry {
    const session = this.db.getSession(sessionId)!;
    const entry = { takeover, closing: false, idleTimer: null, livePrompt: null, liveText: "" } as Omit<RunnerEntry, "runner"> as RunnerEntry;
    entry.runner = new SessionRunner({
      sessionId, mode: options.mode, ...(options.forkFrom ? { forkFrom: options.forkFrom } : {}), cwd: options.cwd, claudeBin: this.config.claudeBin,
      permissionMode: this.feishuMode(session), model: session.prefModel, effort: effortLevel(session.prefEffort),
    }, {
      onPrompt: (uuid) => { entry.livePrompt = uuid; entry.liveText = ""; },
      onLiveText: (text, uuid) => {
        entry.liveText = text;
        entry.livePrompt = uuid;
        this.scheduleRender(sessionId, LIVE_TEXT_RENDER_MS);
      },
      onTurnEnd: (result) => this.onTurnEnd(sessionId, entry, result),
      canUseTool: (toolName, input, request) => this.requestPermission(sessionId, toolName, input, request),
      onClosed: (error) => this.onRunnerClosed(sessionId, entry, error),
    }, this.queryFactory);
    this.runners.set(sessionId, entry);
    entry.runner.start();
    void this.cacheModels(entry.runner);
    return entry;
  }

  private armIdle(sessionId: string, entry: RunnerEntry): void {
    this.clearIdle(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.runner.busy || this.interactions.has(sessionId)) return;
      entry.closing = true;
      entry.runner.close();
      // A process that does not exit when its input ends is stopped.
      setTimeout(() => { if (this.runners.get(sessionId) === entry) entry.runner.terminate(); }, 30_000).unref();
      this.refreshRoot(sessionId);
    }, this.config.runnerIdleMs);
    entry.idleTimer.unref();
  }

  private clearIdle(entry: RunnerEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private onTurnEnd(sessionId: string, entry: RunnerEntry, result: { interrupted: boolean; error: string | null }): void {
    entry.liveText = "";
    if (result.error) void this.topicNotice(sessionId, `⚠️ 这一轮没有正常完成：${result.error.slice(0, 500)}`);
    if (!entry.runner.busy) this.armIdle(sessionId, entry);
    // The turn's last records are in the transcript now; read them at once rather than waiting for the watcher.
    void this.flushTranscript(sessionId);
    this.refreshRoot(sessionId);
  }

  private onRunnerClosed(sessionId: string, entry: RunnerEntry, error: unknown): void {
    if (this.runners.get(sessionId) === entry) this.runners.delete(sessionId);
    this.clearIdle(entry);
    for (const interaction of this.interactions.cancelSession(sessionId, "Claude Code 进程已结束")) {
      void this.resolveInteractionCard(interaction, "已取消", "grey", "Claude Code 进程已结束。");
    }
    if (this.stopping) return;
    if (error) {
      this.fail("claude_runner", { sessionId }, error);
      void this.topicNotice(sessionId, `⚠️ Claude Code 进程异常退出：${errorText(error)}。再发一条消息会重新启动它。`);
    }
    void this.flushTranscript(sessionId);
    this.refreshRoot(sessionId);
  }

  private async stopRunners(): Promise<void> {
    const entries = [...this.runners.entries()];
    for (const [sessionId, entry] of entries) {
      this.clearIdle(entry);
      this.interactions.cancelSession(sessionId, "桥接服务正在停止");
      // An interrupted turn is recorded as such, instead of ending without any record.
      if (entry.runner.busy) await withTimeout(entry.runner.interrupt(), 3_000).catch(() => undefined);
      entry.closing = true;
      entry.runner.close();
    }
    await Promise.all(entries.map(([, entry]) => entry.runner.closed(RUNNER_CLOSE_WAIT_MS)));
    for (const [, entry] of entries) entry.runner.terminate();
  }

  private async cacheModels(runner: SessionRunner): Promise<void> {
    if (this.modelsCached) return;
    this.modelsCached = true;
    try {
      const models = await withTimeout(runner.supportedModels(), 60_000);
      const list = models.filter((model) => model.value && model.value !== "default")
        .map((model) => ({ value: model.value, label: shorten(model.displayName || model.value, 20) }));
      if (list.length) this.db.setSetting("claude.models", JSON.stringify(list));
    } catch { this.modelsCached = false; }
  }

  private models(): Array<{ value: string; label: string }> {
    try {
      const parsed = JSON.parse(this.db.getSetting("claude.models") ?? "null") as unknown;
      if (Array.isArray(parsed)) {
        const models = parsed.filter((item): item is { value: string; label: string } => typeof item?.value === "string" && typeof item?.label === "string");
        if (models.length) return models.slice(0, 6);
      }
    } catch { /* fall back to the aliases every Claude Code version knows */ }
    return FALLBACK_MODELS;
  }

  private async downloadImages(input: FeishuInput): Promise<{ images: ImageInput[]; failed: number }> {
    const images: ImageInput[] = [];
    let failed = Math.max(0, input.imageKeys.length - MAX_IMAGES);
    for (const key of input.imageKeys.slice(0, MAX_IMAGES)) {
      try {
        const data = await this.feishu.downloadImage(input.sourceMessageId, key, MAX_IMAGE_BYTES);
        const mediaType = imageMediaType(data);
        if (mediaType) images.push({ mediaType, base64: data.toString("base64") });
        else failed += 1;
      } catch (error) {
        failed += 1;
        this.fail("download_image", { messageId: input.sourceMessageId }, error);
      }
    }
    return { images, failed };
  }

  private async sendToRunner(entry: RunnerEntry, sessionId: string, input: FeishuInput, priority: "next" | "later"): Promise<void> {
    const { images, failed } = await this.downloadImages(input);
    if (failed) await this.topicNotice(sessionId, `有 ${failed} 张图片没有发给 Claude（每条消息最多 ${MAX_IMAGES} 张，支持 PNG、JPEG、GIF、WebP，单张不超过 5 MB）。`);
    if (!input.text && !images.length) return;
    const uuid = randomUUID();
    this.db.recordFeishuPrompt(sessionId, uuid, input.shownMessageId);
    this.clearIdle(entry);
    entry.runner.send(input.text, images, priority, uuid);
    this.refreshRoot(sessionId);
  }

  /** Continues a session in its own process; `takeover` means the person accepted that it is also open on this computer. */
  private async continueSession(session: ClaudeSession, input: FeishuInput, takeover: boolean): Promise<void> {
    if (!session.cwd || !(await isDirectory(session.cwd))) {
      await this.topicNotice(session.sessionId, `找不到这个会话的工作目录（${displayPath(session.cwd)}），无法继续。`);
      return;
    }
    let entry = await this.activeRunner(session.sessionId);
    if (!entry) entry = this.runners.get(session.sessionId) ?? this.startRunner(session.sessionId, { mode: "resume", cwd: session.cwd }, takeover);
    if (takeover) entry.takeover = true;
    await this.sendToRunner(entry, session.sessionId, input, "next");
  }

  /** Copies the session so far into a new session with its own topic and continues there; the original stays untouched. */
  private async forkSession(source: ClaudeSession, input: FeishuInput): Promise<void> {
    if (!source.cwd || !(await isDirectory(source.cwd))) {
      await this.topicNotice(source.sessionId, `找不到这个会话的工作目录（${displayPath(source.cwd)}），无法分叉。`);
      return;
    }
    const forkId = randomUUID();
    const now = Date.now();
    this.db.updateSession({ sessionId: forkId, path: this.transcriptPathFor(source.cwd, forkId), meta: { cwd: source.cwd, entrypoint: "feishu" },
      firstPrompt: input.text || "（图片）", startedAtMs: now, lastActivityMs: now });
    this.db.setForkedFrom(forkId, source.sessionId);
    this.db.setSessionPrefs(forkId, { mode: this.feishuMode(source), model: source.prefModel ?? "", effort: source.prefEffort ?? "" });
    const fork = await this.createTopic(forkId);
    if (source.rootMessageId) {
      await this.topicText(source.sessionId, source.rootMessageId, `已分叉到新话题继续：${fork.rootAppLink ?? sessionTitle(fork)}。本机的原会话不受影响。`)
        .catch((error) => this.fail("fork_notice", { sessionId: source.sessionId }, error));
    }
    const entry = this.startRunner(forkId, { mode: "fork", forkFrom: source.sessionId, cwd: source.cwd });
    // The message is in the original topic, so the fork's topic shows it as the first prompt.
    await this.sendToRunner(entry, forkId, { ...input, shownMessageId: null }, "next");
  }

  /** Starts a new session in `cwd` with its own topic. */
  private async startNewSession(cwd: string, input: FeishuInput): Promise<ClaudeSession> {
    const sessionId = randomUUID();
    const now = Date.now();
    this.db.updateSession({ sessionId, path: this.transcriptPathFor(cwd, sessionId), meta: { cwd, entrypoint: "feishu" },
      firstPrompt: input.text || "（图片）", startedAtMs: now, lastActivityMs: now });
    const session = await this.createTopic(sessionId);
    const entry = this.startRunner(sessionId, { mode: "new", cwd });
    void this.sendToRunner(entry, sessionId, { ...input, shownMessageId: null }, "next")
      .catch((error) => this.fail("new_session_send", { sessionId }, error));
    return session;
  }

  /** A directory a new session may use: existing, under ALLOWED_ROOT and within SYNC_DIRS. */
  private async resolveDirectory(raw: string): Promise<{ cwd: string } | { error: string }> {
    const home = homedir();
    const trimmed = raw.trim();
    const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
    if (!expanded.startsWith("/")) return { error: "请填写绝对路径（可以用 ~ 表示主目录）。" };
    let cwd: string;
    try { cwd = await realpath(expanded); } catch { return { error: `目录不存在：${shorten(trimmed, 120)}` }; }
    if (!(await isDirectory(cwd))) return { error: `这不是一个目录：${shorten(trimmed, 120)}` };
    const root = await realpath(this.config.allowedRoot).catch(() => this.config.allowedRoot);
    if (cwd !== root && !cwd.startsWith(root.endsWith("/") ? root : `${root}/`)) return { error: `只能在 ${displayPath(root)} 及其子目录中新建会话。` };
    if (!this.inScope(cwd)) return { error: `这个目录不在同步范围（${scopeLabel(this.config.syncDirs)}）内，新会话无法同步到飞书。` };
    return { cwd };
  }

  private newSessionCard(draft?: { nonce: string; preview: string }, notice = ""): CardDefinition {
    return claudeNewSessionCard(this.db.recentDirectories(8, this.config.syncDirs), scopeLabel(this.config.syncDirs), draft, notice);
  }

  /** Called by Claude Code before a tool runs that no permission rule allows; the person decides in the topic. */
  private requestPermission(sessionId: string, toolName: string, input: Record<string, unknown>, request: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const kind = toolName === "AskUserQuestion" ? "question" : toolName === "ExitPlanMode" ? "plan" : "permission";
      const interaction = this.interactions.add({
        sessionId, kind, toolName, input, suggestions: request.suggestions ?? [],
        allowAlways: Boolean(request.suggestions?.length) && !request.suppressAlwaysAllowRule,
        title: request.title ?? null, reason: request.decisionReason ?? null, questions: kind === "question" ? askedQuestions(input) : [], resolve,
      });
      if (kind === "question" && !interaction.questions.length) {
        this.interactions.settle(interaction.nonce, { behavior: "deny", message: "无法在飞书中显示这个提问。" });
        return;
      }
      request.signal.addEventListener("abort", () => {
        const settled = this.interactions.settle(interaction.nonce, { behavior: "deny", message: "请求已取消" });
        if (settled) {
          void this.resolveInteractionCard(settled, "已取消", "grey", "Claude 不再等待这个请求。");
          this.refreshRoot(sessionId);
        }
      }, { once: true });
      void this.postInteraction(interaction);
    });
  }

  private async postInteraction(interaction: Interaction): Promise<void> {
    const { sessionId } = interaction;
    try {
      // The turn card with the tool call goes first, so the request follows it in the topic.
      await this.flushTranscript(sessionId);
      const session = this.db.getSession(sessionId);
      if (!session?.rootMessageId) throw new Error("the session has no topic");
      if (!this.interactions.get(interaction.nonce)) return;
      const card = interaction.kind === "permission" ? claudePermissionCard(interaction)
        : interaction.kind === "question" ? claudeQuestionCard(interaction, 0) : claudePlanCard(interaction);
      interaction.cardMessageId = await this.topicCard(sessionId, session.rootMessageId, card);
      this.refreshRoot(sessionId);
    } catch (error) {
      this.fail("interaction_card", { sessionId }, error);
      // Nobody can answer a request that is not shown; refuse it rather than leave Claude waiting.
      this.interactions.settle(interaction.nonce, { behavior: "deny", message: "无法在飞书中显示这个请求，已自动拒绝。" });
    }
  }

  private async resolveInteractionCard(interaction: Interaction, outcome: string, template: string, detail = ""): Promise<void> {
    if (!interaction.cardMessageId) return;
    await this.feishu.updateCard(interaction.cardMessageId, claudeInteractionDoneCard(interaction, outcome, template, detail))
      .catch((error) => this.fail("interaction_card_update", { sessionId: interaction.sessionId }, error));
  }

  private interactionDetail(interaction: Interaction): string {
    if (interaction.kind === "question") {
      return interaction.questions.map((question, index) => `${question.question}\n→ ${interaction.answers[index] ?? "（未回答）"}`).join("\n");
    }
    if (interaction.kind === "plan") return "";
    const session = this.db.getSession(interaction.sessionId);
    return toolSummary(interaction.toolName, interaction.input, session?.cwd ?? null);
  }

  /** A reply in the topic while Claude waits: refuses a tool with that reason, answers a question, or asks for plan changes. */
  private async answerByText(interaction: Interaction, text: string): Promise<void> {
    if (interaction.kind === "question") {
      const index = interaction.questions.findIndex((_question, position) => !interaction.answers[position]);
      const question = interaction.questions[index];
      if (!question) return;
      interaction.answers[index] = typedAnswer(question, text);
      const next = interaction.questions.findIndex((_question, position) => !interaction.answers[position]);
      if (next >= 0) {
        if (interaction.cardMessageId) await this.feishu.updateCard(interaction.cardMessageId, claudeQuestionCard(interaction, next))
          .catch((error) => this.fail("interaction_card_update", { sessionId: interaction.sessionId }, error));
        return;
      }
      this.interactions.settle(interaction.nonce, questionResult(interaction));
      await this.resolveInteractionCard(interaction, "已回答", "green", this.interactionDetail(interaction));
    } else if (interaction.kind === "plan") {
      this.interactions.settle(interaction.nonce, { behavior: "deny", message: `用户希望修改计划：${text}` });
      await this.resolveInteractionCard(interaction, "已退回修改", "grey", text);
    } else {
      this.interactions.settle(interaction.nonce, { behavior: "deny", message: `用户拒绝了这次操作，并说明：${text}` });
      await this.resolveInteractionCard(interaction, "已拒绝", "red", `${this.interactionDetail(interaction)}\n说明：${text}`);
    }
    this.refreshRoot(interaction.sessionId);
  }

  private async stopTurn(session: ClaudeSession): Promise<string> {
    const entry = this.runners.get(session.sessionId);
    if (entry?.runner.busy) {
      // Interrupt first: refusing a waiting request before that would let Claude go on to its next step.
      await withTimeout(entry.runner.interrupt(), 10_000).catch((error) => this.fail("interrupt", { sessionId: session.sessionId }, error));
      for (const interaction of this.interactions.cancelSession(session.sessionId, "用户停止了这一轮")) {
        void this.resolveInteractionCard(interaction, "已取消", "grey", "这一轮已停止。");
      }
      return "已停止这一轮。";
    }
    if (session.presenceState === "running" || session.presenceState === "waiting") return `这一轮在${sourceLabel(session.entrypoint)}中运行，请在那里停止。`;
    return "现在没有正在运行的回合。";
  }

  // ---- Feishu events ----

  private homeCard(notice = ""): CardDefinition {
    return claudeHomeCard({ paused: this.paused(), ...this.db.sessionCounts(this.config.syncDirs), failures: this.db.failureCount(),
      scope: scopeLabel(this.config.syncDirs), outOfScopeTopics: this.outOfScopeTopics().length }, notice);
  }

  private recentCard(search = "", page = 0): CardDefinition {
    const rows = this.db.listRecentSessions(PAGE_SIZE + 1, page * PAGE_SIZE, search, this.config.syncDirs);
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
    if (!session || !this.inScope(session.cwd)) return null;
    if (!session.rootMessageId) {
      const current = session.currentTurnId ? this.db.getTurn(sessionId, session.currentTurnId) : null;
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
    await this.topicFile(sessionId, session.rootMessageId, name, Buffer.from(transcriptMarkdown(session, turns)));
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
      await this.feishu.sendText(message.chatId, `绑定成功。正在同步最近 ${this.config.historyDays} 天有活动的 Claude 会话（同步范围：${scopeLabel(this.config.syncDirs)}）；绑定码已失效。`);
      await this.ensureControlCard();
      void this.bootstrap();
      return;
    }
    if (message.chatId !== chatId || message.senderOpenId !== this.boundOpenId()) return;
    const command = message.text.trim();
    const session = message.rootId ? this.db.getSessionByRoot(message.rootId) : null;
    if (session?.rootMessageId) { await this.handleTopicMessage(message, session, command); return; }
    if (message.chatType === "group" && !message.mentionedBot && !command.startsWith("/")) return;
    const normalized = command.toLowerCase();
    const replyCard = (card: CardDefinition) => this.respondCard(message, card);
    // As in the Codex bridge, plain-word shortcuts only count in the group's main timeline.
    const isCommand = (slash: readonly string[], words: readonly string[] = []) => slash.includes(normalized) || words.includes(normalized);
    if (normalized === "/") { await replyCard(claudeCommandMenuCard()); return; }
    if (isCommand(["/help"], ["help", "帮助", "?", "？"])) { await replyCard(claudeHelpCard()); return; }
    if (isCommand(["/home", "/status"], ["控制台", "状态"])) { await replyCard(this.homeCard()); return; }
    if (isCommand(["/sessions"], ["会话", "最近"])) { await replyCard(this.recentCard()); return; }
    if (normalized === "/search" || normalized.startsWith("/search ")) {
      await replyCard(this.recentCard([...command.slice(7).trim()].slice(0, 120).join("")));
      return;
    }
    if (isCommand(["/sync"], ["同步"])) { await replyCard(this.homeCard("已开始同步")); void this.syncAll(); return; }
    if (isCommand(["/pause"], ["暂停"])) { this.db.setSetting("sync.paused", "1"); await replyCard(this.homeCard("同步已暂停")); return; }
    if (isCommand(["/resume-sync"], ["恢复"])) {
      this.db.setSetting("sync.paused", "0");
      await replyCard(this.homeCard("同步已恢复"));
      void this.syncAll();
      return;
    }
    if (normalized === "/new" || normalized.startsWith("/new ")) { await this.newCommand(message, command.slice(4).trim()); return; }
    if (command.startsWith("/")) { await replyCard(claudeCommandMenuCard(`未知命令：${command.slice(0, 40)}`)); return; }
    // Anything else in the main timeline is a task for a new session; the person picks where it runs.
    if (!command && !message.imageKeys.length) return;
    const nonce = randomUUID();
    this.drafts.set(nonce, { input: { text: command, imageKeys: message.imageKeys, sourceMessageId: message.messageId, shownMessageId: null }, expiresAt: Date.now() + DRAFT_MS });
    await replyCard(this.newSessionCard({ nonce, preview: command }));
  }

  /** `/new`, `/new <directory>` or `/new <directory> <task>` in the main timeline. */
  private async newCommand(message: IncomingFeishuMessage, args: string): Promise<void> {
    if (!args) { await this.respondCard(message, this.newSessionCard()); return; }
    if (this.paused()) { await this.respondCard(message, this.homeCard("同步已暂停，恢复同步后才能新建会话")); return; }
    const dir = args.split(/\s+/)[0] ?? "";
    const task = args.slice(dir.length).trim();
    const resolved = await this.resolveDirectory(dir);
    if ("error" in resolved) { await this.respondCard(message, this.newSessionCard(undefined, resolved.error)); return; }
    if (!task && !message.imageKeys.length) { await this.respondCard(message, claudeNewTaskCard(resolved.cwd)); return; }
    const session = await this.startNewSession(resolved.cwd, { text: task, imageKeys: message.imageKeys, sourceMessageId: message.messageId, shownMessageId: null });
    await this.respond(message, `已在 ${displayPath(resolved.cwd)} 新建会话：${session.rootAppLink ?? sessionTitle(session)}`);
  }

  private async handleTopicMessage(message: IncomingFeishuMessage, session: ClaudeSession, command: string): Promise<void> {
    const rootId = session.rootMessageId!;
    const reply = (text: string) => this.topicText(session.sessionId, rootId, text);
    const normalized = command.toLowerCase();
    // Only these two are the bridge's; every other message, slash commands included, goes to Claude.
    if (normalized === "/export") {
      await reply("正在导出完整记录…");
      await this.exportSession(session.sessionId);
      return;
    }
    if (normalized === "/stop") { await reply(await this.stopTurn(session)); return; }
    if (!this.inScope(session.cwd)) { await reply(`这个会话的目录不在同步范围（${scopeLabel(this.config.syncDirs)}）内，不能从飞书继续。`); return; }
    if (this.paused()) { await reply("同步已暂停，恢复同步后才能从飞书继续对话（控制台“恢复同步”，或在群主消息中发送 /resume-sync）。"); return; }
    const interaction = this.interactions.forSession(session.sessionId);
    if (interaction && command) { await this.answerByText(interaction, command); return; }
    const later = command.startsWith(">>");
    const text = later ? command.slice(2).trim() : command;
    if (!text && !message.imageKeys.length) return;
    const input: FeishuInput = { text, imageKeys: message.imageKeys, sourceMessageId: message.messageId, shownMessageId: message.messageId };
    const entry = await this.activeRunner(session.sessionId);
    if (entry?.runner.busy) {
      // Like typing while Claude works in the terminal: the message reaches Claude after the current step.
      await this.sendToRunner(entry, session.sessionId, input, later ? "later" : "next");
      if (later) await reply("已排队：这一轮结束后发给 Claude。");
      return;
    }
    if (!entry?.takeover && this.openElsewhere(session)) {
      const nonce = randomUUID();
      this.conflicts.set(nonce, { sessionId: session.sessionId, input, expiresAt: Date.now() + CONFLICT_CONFIRM_MS });
      await this.topicCard(session.sessionId, rootId, claudeConflictCard(session, nonce));
      return;
    }
    await this.continueSession(session, input, entry?.takeover ?? false);
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
    const value = (key: string) => typeof event.value[key] === "string" ? event.value[key] as string : "";
    const form = (key: string) => typeof event.formValues[key] === "string" ? (event.formValues[key] as string).trim() : "";
    const sessionId = value("sessionId");
    const nonce = value("nonce");
    const replace = (card: CardDefinition): CardActionOutcome => ({ delivery: "replace", card });
    // Buttons on a root card answer with the root card itself; remember what it shows now.
    const replaceRoot = (session: ClaudeSession): CardActionOutcome => {
      const card = this.rootCard(session);
      this.rootHashes.set(session.sessionId, cardContentHash(card));
      return replace(card);
    };
    const expired = () => replace(claudeNoticeCard("请求已失效", "这个请求已经处理或取消，或者桥接服务重启过。"));
    switch (event.action) {
      case "home": return replace(this.homeCard());
      case "help": return replace(claudeHelpCard());
      case "command_menu": return replace(claudeCommandMenuCard());
      case "recent": return replace(this.recentCard());
      case "recent_page": return replace(this.recentCard(value("search"), Math.max(0, Number(event.value.page) || 0)));
      case "search_sessions": return replace(this.recentCard(form("session_search").slice(0, 120)));
      case "sync": void this.syncAll(); return replace(this.homeCard("已开始同步"));
      case "pause": this.db.setSetting("sync.paused", "1"); return replace(this.homeCard("同步已暂停"));
      case "resume": this.db.setSetting("sync.paused", "0"); void this.syncAll(); return replace(this.homeCard("同步已恢复"));
      case "cleanup_preview": {
        const sessions = this.outOfScopeTopics();
        if (!sessions.length) return replace(this.homeCard("没有范围外的话题"));
        const cleanupNonce = randomUUID();
        this.db.setSetting("cleanup.pending", JSON.stringify({ nonce: cleanupNonce, sessionIds: sessions.map((session) => session.sessionId), expiresAt: Date.now() + CLEANUP_CONFIRM_MS }));
        return replace(claudeCleanupCard(sessions, cleanupNonce, scopeLabel(this.config.syncDirs)));
      }
      case "cleanup_confirm": {
        let pending: { nonce?: unknown; sessionIds?: unknown; expiresAt?: unknown } = {};
        try { pending = JSON.parse(this.db.getSetting("cleanup.pending") ?? "{}") as typeof pending; } catch { /* treated as expired */ }
        if (pending.nonce !== event.value.nonce || typeof pending.expiresAt !== "number" || pending.expiresAt < Date.now() || !Array.isArray(pending.sessionIds)) {
          return replace(claudeNoticeCard("清理已过期", "请回到控制台，重新点击“清理范围外话题”。", "red"));
        }
        this.db.deleteSetting("cleanup.pending");
        const ids = pending.sessionIds.filter((id): id is string => typeof id === "string");
        void this.cleanupTopics(ids).catch((error) => this.fail("cleanup_topics", {}, error));
        return replace(claudeNoticeCard("正在清理", `正在撤回 ${ids.length} 个话题中的消息，完成后会在群里发送结果。`, "orange"));
      }
      case "open_session": {
        const session = await this.openSession(sessionId);
        if (!session) return replace(claudeNoticeCard("无法打开", "没有找到这个会话。", "red"));
        return replace(this.recentCard());
      }
      case "export_session": {
        const session = this.db.getSession(sessionId);
        if (!session) return replace(claudeNoticeCard("无法导出", "没有找到这个会话。", "red"));
        void this.exportSession(sessionId).catch((error) => this.fail("export_session", { sessionId }, error));
        return replaceRoot(session);
      }
      case "refresh_session": {
        const session = this.db.getSession(sessionId);
        if (!session) return replace(claudeNoticeCard("无法刷新", "没有找到这个会话。", "red"));
        this.db.clearRootDirty(sessionId);
        return replaceRoot(session);
      }

      case "stop_turn": {
        const session = this.db.getSession(sessionId);
        if (!session) return replace(claudeNoticeCard("无法停止", "没有找到这个会话。", "red"));
        void this.stopTurn(session).then((text) => this.topicNotice(sessionId, text));
        return replaceRoot(session);
      }
      case "mode_card":
      case "model_card": {
        const session = this.db.getSession(sessionId);
        if (!session?.rootMessageId) return replace(claudeNoticeCard("无法设置", "没有找到这个会话。", "red"));
        const card = event.action === "mode_card" ? claudeModeCard(session, this.feishuMode(session), FEISHU_PERMISSION_MODES)
          : claudeModelCard(session, this.models(), EFFORT_LEVELS, { model: session.prefModel, effort: session.prefEffort });
        void this.topicCard(sessionId, session.rootMessageId, card).catch((error) => this.fail("settings_card", { sessionId }, error));
        return replaceRoot(session);
      }
      case "set_mode": {
        const mode = value("mode") as FeishuPermissionMode;
        const session = this.db.getSession(sessionId);
        if (!session || !FEISHU_PERMISSION_MODES.includes(mode)) return replace(claudeNoticeCard("无法设置", "没有找到这个会话或权限模式。", "red"));
        this.db.setSessionPrefs(sessionId, { mode });
        const entry = this.runners.get(sessionId);
        if (entry) void entry.runner.setPermissionMode(mode).catch((error) => this.fail("set_mode", { sessionId }, error));
        this.refreshRoot(sessionId);
        return replace(claudeModeCard(this.db.getSession(sessionId)!, mode, FEISHU_PERMISSION_MODES));
      }
      case "set_model":
      case "set_effort": {
        const session = this.db.getSession(sessionId);
        if (!session) return replace(claudeNoticeCard("无法设置", "没有找到这个会话。", "red"));
        const entry = this.runners.get(sessionId);
        if (event.action === "set_model") {
          const model = value("model");
          if (model && !this.models().some((item) => item.value === model)) return replace(claudeNoticeCard("无法设置", "没有这个模型。", "red"));
          this.db.setSessionPrefs(sessionId, { model });
          if (entry) void entry.runner.setModel(model || null).catch((error) => this.fail("set_model", { sessionId }, error));
        } else {
          const effort = value("effort");
          if (effort && !effortLevel(effort)) return replace(claudeNoticeCard("无法设置", "没有这个推理强度。", "red"));
          this.db.setSessionPrefs(sessionId, { effort });
          if (entry) void entry.runner.setEffort(effortLevel(effort)).catch((error) => this.fail("set_effort", { sessionId }, error));
        }
        this.refreshRoot(sessionId);
        const updated = this.db.getSession(sessionId)!;
        return replace(claudeModelCard(updated, this.models(), EFFORT_LEVELS, { model: updated.prefModel, effort: updated.prefEffort }));
      }

      case "perm_allow":
      case "perm_always":
      case "perm_deny": {
        const interaction = this.interactions.get(nonce);
        if (!interaction || interaction.kind !== "permission") return expired();
        const always = event.action === "perm_always";
        // "This session" rules stay in memory, as when choosing that option in the terminal.
        const rules = interaction.suggestions.map((update) => ({ ...update, destination: "session" }) as PermissionUpdate);
        const result: PermissionResult = event.action === "perm_deny" ? { behavior: "deny", message: "用户在飞书中拒绝了这次操作。" }
          : { behavior: "allow", updatedInput: interaction.input, ...(always ? { updatedPermissions: rules } : {}) };
        this.interactions.settle(nonce, result);
        this.refreshRoot(interaction.sessionId);
        const detail = this.interactionDetail(interaction);
        return replace(event.action === "perm_deny" ? claudeInteractionDoneCard(interaction, "已拒绝", "red", detail)
          : claudeInteractionDoneCard(interaction, always ? "本会话都允许" : "已允许", "green", detail));
      }
      case "ask_answer": {
        const interaction = this.interactions.get(nonce);
        if (!interaction || interaction.kind !== "question") return expired();
        const index = Number(event.value.question);
        const label = interaction.questions[index]?.options[Number(event.value.option)]?.label;
        if (label && !interaction.answers[index]) interaction.answers[index] = label;
        const next = interaction.questions.findIndex((_question, position) => !interaction.answers[position]);
        if (next >= 0) return replace(claudeQuestionCard(interaction, next));
        this.interactions.settle(nonce, questionResult(interaction));
        this.refreshRoot(interaction.sessionId);
        return replace(claudeInteractionDoneCard(interaction, "已回答", "green", this.interactionDetail(interaction)));
      }
      case "ask_skip": {
        const interaction = this.interactions.get(nonce);
        if (!interaction || interaction.kind !== "question") return expired();
        this.interactions.settle(nonce, { behavior: "deny", message: "用户没有回答这些问题，请按你的判断继续，或换一种方式询问。" });
        this.refreshRoot(interaction.sessionId);
        return replace(claudeInteractionDoneCard(interaction, "未回答", "grey"));
      }
      case "plan_edits":
      case "plan_default":
      case "plan_revise": {
        const interaction = this.interactions.get(nonce);
        if (!interaction || interaction.kind !== "plan") return expired();
        if (event.action === "plan_revise") {
          this.interactions.settle(nonce, { behavior: "deny", message: "用户希望继续完善计划。请先不要执行，等待用户在下一条消息中给出修改意见。" });
          this.refreshRoot(interaction.sessionId);
          return replace(claudeInteractionDoneCard(interaction, "继续修改", "grey", "在本话题回复修改意见即可。"));
        }
        const mode = event.action === "plan_edits" ? "acceptEdits" : "default";
        this.interactions.settle(nonce, planResult(interaction, mode));
        this.db.setSessionPrefs(interaction.sessionId, { mode });
        this.refreshRoot(interaction.sessionId);
        return replace(claudeInteractionDoneCard(interaction, mode === "acceptEdits" ? "开始执行（自动接受编辑）" : "开始执行（逐项确认）", "green"));
      }

      case "conflict_fork":
      case "conflict_takeover":
      case "conflict_cancel": {
        const pending = this.conflicts.get(nonce);
        this.conflicts.delete(nonce);
        if (!pending || pending.expiresAt < Date.now()) return replace(claudeNoticeCard("已过期", "请重新发送这条消息。"));
        if (event.action === "conflict_cancel") return replace(claudeNoticeCard("已取消", "这条消息没有发给 Claude。"));
        const session = this.db.getSession(pending.sessionId);
        if (!session) return replace(claudeNoticeCard("无法继续", "没有找到这个会话。", "red"));
        if (event.action === "conflict_fork") {
          void this.forkSession(session, pending.input).catch((error) => {
            this.fail("fork_session", { sessionId: session.sessionId }, error);
            void this.topicNotice(session.sessionId, `分叉失败：${errorText(error)}`);
          });
          return replace(claudeNoticeCard("正在分叉", "会新建一个话题，在那里继续这段对话。", "blue"));
        }
        void this.continueSession(session, pending.input, true).catch((error) => {
          this.fail("continue_session", { sessionId: session.sessionId }, error);
          void this.topicNotice(session.sessionId, `无法继续：${errorText(error)}`);
        });
        return replace(claudeNoticeCard("在原会话继续", "回到电脑后，在 VS Code 中重新打开这个会话，才能看到飞书里的这几轮。", "blue"));
      }

      case "new_session": return replace(this.newSessionCard());
      case "new_pick":
      case "new_pick_path": {
        const draftNonce = value("draft");
        const resolved = await this.resolveDirectory(event.action === "new_pick" ? value("cwd") : form("new_dir"));
        if ("error" in resolved) {
          const draft = this.drafts.get(draftNonce);
          return replace(this.newSessionCard(draft ? { nonce: draftNonce, preview: draft.input.text } : undefined, resolved.error));
        }
        if (!draftNonce) return replace(claudeNewTaskCard(resolved.cwd));
        const draft = this.drafts.get(draftNonce);
        this.drafts.delete(draftNonce);
        if (!draft || draft.expiresAt < Date.now()) return replace(claudeNewTaskCard(resolved.cwd, "原来的消息已过期，请重新输入任务"));
        return this.startFromCard(resolved.cwd, draft.input);
      }
      case "new_submit": {
        const resolved = await this.resolveDirectory(value("cwd"));
        if ("error" in resolved) return replace(this.newSessionCard(undefined, resolved.error));
        const task = form("new_task");
        if (!task) return replace(claudeNewTaskCard(resolved.cwd, "请填写要 Claude 做什么"));
        return this.startFromCard(resolved.cwd, { text: task, imageKeys: [], sourceMessageId: event.openMessageId, shownMessageId: null });
      }
      default: return replace(claudeNoticeCard("未知操作", `这个按钮在当前版本中不可用：${event.action}`, "red"));
    }
  }

  private async startFromCard(cwd: string, input: FeishuInput): Promise<CardActionOutcome> {
    if (this.paused()) return { delivery: "replace", card: this.homeCard("同步已暂停，恢复同步后才能新建会话") };
    const session = await this.startNewSession(cwd, input);
    return { delivery: "replace", card: claudeStartedCard(cwd, session.rootAppLink) };
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
          "claude.new": () => this.newSessionCard(),
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
