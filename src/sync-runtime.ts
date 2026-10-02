import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { archivedSessionActionCard, assistantMarkdownCard, choiceAcceptedCard, choiceCancelledCard, choiceCard, choiceResolvedElsewhereCard, commandMenuCard, errorCard, helpCard, homeCard, modelCard, projectsCard, reasoningEffortCard, recentSessionsCard, remoteQuestionCard, remoteRequestCard, remoteRequestResolvedCard, reviewCard, rootGrantCard, runStatusCard, serviceCard, sessionCard, wizardReadyCard } from "./cards.js";
import { isExpiredFeishuMessage } from "./safe-log.js";
import { AppServerRpcError, CodexAppServer, notificationTurnId, type JsonRpcMessage } from "./app-server.js";
import { CodexCliProbe } from "./codex.js";
import { BridgeDatabase } from "./db.js";
import { messageAppLink } from "./feishu.js";
import { resolveAllowedPath } from "./path-policy.js";
import { remoteApprovalAllowed, remoteApprovalSummary, rootExecutionPreflight, threadSandboxMode } from "./execution-policy.js";
import { isRetryableTransportError } from "./inbound-events.js";
import { boundedPreview, cardContentBytes, serializedBytes } from "./text-limits.js";
import { parseJsonlChunk } from "./session-parser.js";
import type { FeishuRouterPort } from "./bridge-contracts.js";
import { jsonlFiles, SessionImporter } from "./session-importer.js";
import { TaskScheduler } from "./task-scheduler.js";
import { ApprovalService } from "./approval-service.js";
import { TurnCoordinator } from "./turn-coordinator.js";
import type { BridgeConfig, CardActionOutcome, CardDefinition, ChoiceQuestion, ChoiceRequest, FeishuPort, IncomingBotMenuAction, IncomingCardAction, IncomingFeishuMessage, ModelCapability, PendingServerRequest, QueuedTask, RemoteRequestType, SessionMetadata, TurnOutput, TurnState } from "./types.js";

const MAX_ERROR_CHARS = 3_000;
/** Feishu rejects card messages above 30 KB; this leaves room for the rest of the card. */
const MAX_INLINE_MESSAGE_BYTES = 25_000;
const MAX_LIVE_TEXT_BYTES = 200_000;
const PENDING_PROMPT_TTL_MS = 10 * 60_000;
// A Feishu message reaches the JSONL only when its turn is imported, which can be
// long after it was sent; keep the echo marker for the lifetime of a long turn.
const INBOUND_MIRROR_TTL_MS = 24 * 60 * 60_000;
const MODEL_CATALOG_KEY = "codex.model_catalog.v1";
const MODEL_BACKFILL_MIGRATION_KEY = "migration.session_model_backfill.v1";
const LOG_SYNC_ATTEMPTS = 10;
const LOG_SYNC_RETRY_MS = 500;
const STREAM_INTERVAL_MS = 500;
/** How long a message sent into a running turn is remembered, so a retried delivery is not run again. */
const STEER_RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** How long an accepted interrupt may take before the run card says the end is not yet confirmed. */
const CANCEL_CONFIRM_WAIT_MS = 60_000;
type CancelOutcome = { tasks: number; starting: number; turn: "none" | "requested" | "uncertain" | "failed" | "ended"; error: string | null };
const TERMINAL_TURN_STATES: ReadonlySet<string> = new Set(["completed", "failed", "interrupted"]);
const STEER_UNCERTAIN_TEXT = "没能确认这条消息是否已交给当前 Codex 回合。为避免重复执行，它不会被自动重新提交；如果稍后的回复里没有处理它，请重新发送。";
const MAX_IMAGES_PER_TASK = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const THREAD_STATE_REFRESH_MS = 60_000;

interface PendingChoiceState {
  request: ChoiceRequest;
  rootId: string;
  questionIndex: number;
  answers: string[];
}

interface WizardState {
  id: string;
  mode: "new" | "session";
  chatId: string;
  rootId?: string;
  cwd?: string;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  prompt?: string;
  imageKeys?: string[];
  sourceMessageId?: string;
  awaitingChatTask?: boolean;
  consumedAt?: number;
  expiresAt: number;
}

function feishuPrompt(prompt: string): string {
  return `<feishu_bridge>\nWhen user input is required, do not call interactive tools and do not guess. End the turn with exactly one block in this form:\n<feishu_input>{"questions":[{"id":"choice","header":"short header","question":"question","options":[{"label":"option","description":"description"}]}]}</feishu_input>\nUse an empty options array for free-text input. You may ask through this block for bounded business decisions, including public web or repository research, dependency or implementation choices, and whether to modify files inside the already-authorized workspace. Never ask for system-level approval or authentication: sudo or privilege escalation, bypassing the sandbox, passwords, secrets, API keys, tokens, verification codes, CAPTCHA, login/browser authentication, writing outside the authorized workspace, or uploading private local data to an external service. State that those actions are unavailable instead. A Feishu answer is only user intent; it does not bypass approval=never, workspace-write, path validation, or network sandbox restrictions.\n</feishu_bridge>\n<user_message>\n${prompt}\n</user_message>`;
}

function collaborationPrompt(prompt: string, mode: "default" | "plan" = "default"): string {
  if (mode !== "plan") return feishuPrompt(prompt);
  return `${feishuPrompt(prompt)}\n\n<feishu_plan_mode>Plan mode is active. Inspect and reason only: do not edit files, run mutating commands, install dependencies, or change external state. Return a concrete implementation plan and wait for an explicit user request to execute it.</feishu_plan_mode>`;
}

function textHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function taskFingerprint(cwd: string, prompt: string, model: string | null, effort: string | null, imageKeys: string[]): string {
  return textHash(JSON.stringify({ cwd, prompt, model, effort, imageKeys: [...imageKeys].sort() }));
}

export function forbiddenRemoteQuestion(request: ChoiceRequest): boolean {
  const text = request.questions.flatMap((question) => [question.header, question.question,
    ...question.options.flatMap((option) => [option.label, option.description])]).join(" ");
  return /(sudo|提权|privilege escalation|密码|password|验证码|captcha|\botp\b|登录确认|login confirmation|browser authentication|登录认证|sandbox|沙箱|danger-full-access|越界写入|写入.{0,20}(?:目录外|允许目录外|authorized workspace.{0,20}outside)|(?:上传|upload).{0,40}(?:私密|private|本地数据|local data)|secret|密钥|api key|访问令牌|access token)/i.test(text);
}

function shortText(text: string, max = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return [...compact].slice(0, max).join("");
}

function appendBoundedText(current: string, delta: string, maxBytes: number): string {
  return boundedPreview(current + delta, maxBytes, "[…正文过长，已截断；完整内容见同步日志…]");
}

/** Text for a card: whole if it fits Feishu's card size once serialized, else its start and end. */
function inlinePreview(text: string): string {
  return boundedPreview(text, MAX_INLINE_MESSAGE_BYTES, "[…正文超过飞书卡片上限，完整内容见 Markdown 附件…]", cardContentBytes);
}

/** Feishu drops a repeated message with the same uuid (at most 50 characters) within an hour. */
function deliveryUuid(turnId: string, part: "card" | "file"): string {
  return createHash("sha256").update(`${turnId}:${part}`).digest("hex").slice(0, 32);
}

function imageExtension(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (data[0] === 0xff && data[1] === 0xd8) return ".jpg";
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return ".gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return ".image";
}

function sessionIdFromPath(path: string): string | null {
  return basename(path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null;
}

function isSubagentSource(source: string): boolean {
  return /(?:^|[._:-])subagent(?:$|[._:-])|delegated?_agent/i.test(source);
}

export class SyncRuntime implements FeishuRouterPort {
  private readonly sessionsDir: string;
  private readonly sessionImporter: SessionImporter;
  private readonly turnCoordinator: TurnCoordinator;
  private readonly approvalService: ApprovalService;
  private readonly taskScheduler: TaskScheduler;
  private scanTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private messageLinkPermissionDenied = false;
  private models: ModelCapability[] = [];
  private titleIndex: Map<string, string> | null = null;
  private rootExecutionReady = false;
  private appServerRestartAttempts = 0;
  private appServerRestartTimer: NodeJS.Timeout | null = null;
  private readonly cancelTimers = new Map<string, NodeJS.Timeout>();
  private outputDelivery: Promise<void> | null = null;
  /** When an interrupt was last sent for a turn, so a repeated cancel only resends one that went unconfirmed. */
  private readonly cancelRequestedAt = new Map<string, number>();
  private threadStateTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly db: BridgeDatabase,
    private readonly feishu: FeishuPort,
    private readonly codex: CodexCliProbe,
    private readonly appServer?: CodexAppServer,
  ) {
    this.sessionsDir = join(config.codexHome, "sessions");
    this.sessionImporter = new SessionImporter({
      sessionsDir: this.sessionsDir,
      db,
      isEnabled: () => Boolean(this.boundChatId()) && !this.paused(),
      processFile: (path) => this.processFile(path),
      reconcileHistory: () => this.reconcileExistingState(),
      onError: (operation, path, error) => {
        this.db.recordFailure(operation, { path }, error);
        console.error(`Session importer ${operation} failed for ${path}`, error);
      },
    });
    this.turnCoordinator = new TurnCoordinator({
      executeTask: async (task) => task.kind === "resume" ? this.executeResumeTask(task) : this.executeNewTask(task),
      interruptTurn: async (sessionId, turnId) => {
        if (this.appServer) await this.appServer.interrupt(sessionId, turnId);
      },
      onNotification: (event) => this.onAppServerNotification(event),
      onLifecycle: async (event) => { if (event.kind === "exited") await this.handleAppServerExit(event.epoch, event.error); },
    });
    this.taskScheduler = new TaskScheduler({
      db,
      executor: this.turnCoordinator,
      isPaused: () => this.paused(),
      hasActiveTurn: (sessionId) => this.turnCoordinator.hasActiveTurn(sessionId),
      hasLocalActiveSession: async (sessionId) => {
        const session = this.db.getSession(sessionId);
        return session ? this.hasLocalActiveSession(session) : false;
      },
      onError: (operation, task, error) => this.db.recordFailure(operation, task ? { taskId: task.id } : {}, error),
    });
    this.approvalService = new ApprovalService({
      db,
      onServerRequest: (request) => this.onAppServerRequest(request),
      onResolveAction: (request, decision, answers) => this.resolveRemoteRequest(request, decision, answers),
      onRootConsent: (task) => this.createRootGrant(task),
      onConsumeRootGrant: (task) => this.consumeRootGrant(task),
      onExpire: () => this.expireRemoteState(),
    });
  }

  async start(): Promise<void> {
    if (this.config.executionMode === "root-danger-full-access") {
      const preflight = await rootExecutionPreflight(this.config);
      this.rootExecutionReady = preflight.ok;
      this.db.setSetting("codex.root_preflight", JSON.stringify(preflight));
      if (!preflight.ok) this.db.recordFailure("root_preflight", { reasons: preflight.reasons }, new Error("Root execution disabled: " + preflight.reasons.join("; ")));
      else this.db.resolveFailure("root_preflight");
    }
    if (this.appServer) {
      this.appServer.onNotification((event) => this.turnCoordinator.handleNotification(event));
      this.appServer.onLifecycle((event) => { if (event.kind === "started") this.appServerRestartAttempts = 0; });
      this.appServer.onExit((event) => { void this.handleAppServerExit(event.epoch, event.error); });
      this.appServer.onServerRequest((request) => this.approvalService.handleServerRequest(request));
      await this.appServer.start();
      await this.expireRemoteState();
      this.db.recoverCreatingThreadsAsUncertain();
      await this.refreshThreadsFromAppServer();
      await this.repairHistoricalDuplicateCreation();
      this.threadStateTimer = setInterval(() => { void this.refreshThreadsFromAppServer().catch((error) => this.db.recordFailure("thread_state_refresh", {}, error)); }, THREAD_STATE_REFRESH_MS);
      this.threadStateTimer.unref();
    }
    const sandboxAvailable = await this.codex.sandboxSmokeTest();
    this.db.setSetting("codex.sandbox_available", sandboxAvailable ? "1" : "0");
    if (!sandboxAvailable && this.config.executionMode !== "root-danger-full-access") {
      this.db.recordFailure("codex_sandbox", {}, new Error("Codex bwrap sandbox unavailable; remote command/file/permission approvals disabled"));
      console.warn("Codex sandbox unavailable: remote command, file-change, and permission approvals are fail-closed.");
    } else if (!sandboxAvailable) {
      console.warn("Codex bwrap sandbox unavailable; explicit Root danger-full-access mode is active.");
      this.db.resolveFailure("codex_sandbox", {});
    } else this.db.resolveFailure("codex_sandbox", {});
    await this.refreshModels();
    await this.backfillHistoricalModels();
    for (const task of this.db.markRunningTasksInterrupted()) {
      if (task.runCardMessageId) {
        void this.feishu.updateCard(task.runCardMessageId, runStatusCard("已中断", "服务重启时任务尚未完成；请重新提交该任务。")).catch((error) => {
          this.db.recordFailure("status_card_restart", { taskId: task.id }, error);
        });
      }
      if (task.rootMessageId && task.sessionId) {
        void this.updateRunCard(task.sessionId, task.rootMessageId, "已中断", "服务重启时任务尚未完成；请重新发送该消息。", false);
      }
    }
    this.db.recoverStaleInboundEvents();
    this.db.pruneRetainedData();
    this.pruneSteerRecords();
    if (this.boundChatId()) void this.deliverPendingOutputs();
    await this.cleanupStaleTempFiles();
    await mkdir(this.sessionsDir, { recursive: true });
    await this.sessionImporter.startWatching();
    this.scanTimer = setInterval(() => {
      if (!this.boundChatId() || this.paused()) return;
      void this.syncAll();
      void this.drainPendingTasks();
      void this.reconcileAwaitingSyncTasks();
      void this.expireRootGrants();
      void this.retryDueWriterTasks();
      void this.deliverPendingOutputs(true);
    }, this.config.scanIntervalMs);
    this.scanTimer.unref();
    if (this.boundChatId()) {
      void this.sessionImporter.reconcileHistory().then(() => this.syncAll()).catch((error) => {
        this.db.recordFailure("reconcile_existing_state", {}, error);
      });
      void this.reconcileAwaitingSyncTasks();
      void this.ensureControlCard();
      void this.backfillSessionLinks();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.appServerRestartTimer) clearTimeout(this.appServerRestartTimer);
    if (this.threadStateTimer) clearInterval(this.threadStateTimer);
    for (const timer of this.cancelTimers.values()) clearTimeout(timer);
    this.cancelTimers.clear();
    await this.sessionImporter.stopWatching();
    await this.appServer?.close();
    this.db.markRunningTasksInterrupted();
    for (const turn of this.turnCoordinator.states()) {
      // What the turn wrote so far is sent after the next start.
      try { this.storeTurnOutput(turn, "Codex 已中断（桥接服务停止）"); } catch (error) { this.db.recordFailure("turn_output_store", { turnId: turn.turnId }, error); }
      turn.state = "interrupted";
      this.db.saveTurn(turn);
      await this.cleanupTurnImages(turn.turnId);
    }
    this.turnCoordinator.clearTurns();
    this.approvalService.clear();
  }

  private boundChatId(): string | null { return this.db.getSetting("feishu.chat_id"); }
  private boundOpenId(): string | null { return this.db.getSetting("feishu.open_id"); }
  private paused(): boolean { return this.stopping || this.db.getSetting("sync.paused") === "1"; }

  private cachedModels(): ModelCapability[] {
    const raw = this.db.getSetting(MODEL_CATALOG_KEY);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      if (!Array.isArray(value)) return [];
      return value.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const model = item as Record<string, unknown>;
        if (typeof model.slug !== "string" || typeof model.displayName !== "string" ||
          typeof model.description !== "string" || typeof model.defaultReasoningEffort !== "string" ||
          !Array.isArray(model.supportedReasoningEfforts)) return [];
        const efforts = model.supportedReasoningEfforts.filter((effort): effort is string => typeof effort === "string");
        return efforts.includes(model.defaultReasoningEffort)
          ? [{ slug: model.slug, displayName: model.displayName, description: model.description,
            defaultReasoningEffort: model.defaultReasoningEffort, supportedReasoningEfforts: efforts }]
          : [];
      });
    } catch { return []; }
  }

  private async refreshModels(): Promise<boolean> {
    try {
      const models = await this.codex.listModels();
      if (!models.length) throw new Error("Codex model catalog contains no visible models");
      this.models = models;
      this.db.setSetting(MODEL_CATALOG_KEY, JSON.stringify(models));
      return true;
    } catch (error) {
      this.models = this.cachedModels();
      this.db.recordFailure("model_catalog", {}, error);
      console.warn(`Unable to refresh Codex model catalog; using ${this.models.length ? "cached catalog" : "no catalog"}.`, error);
      return false;
    }
  }

  private modelBySlug(slug: string | undefined): ModelCapability | null {
    return slug ? this.models.find((model) => model.slug === slug) ?? null : null;
  }

  private async backfillHistoricalModels(): Promise<void> {
    if (this.db.getSetting(MODEL_BACKFILL_MIGRATION_KEY) === "1") return;
    for (const session of this.db.listSessions()) {
      if (session.model && session.reasoningEffort) continue;
      try {
        const batch = parseJsonlChunk((await readFile(session.path, "utf8")), "", session.sessionId, sessionIdFromPath(session.path) ?? "");
        if (!batch.model && !batch.reasoningEffort) continue;
        this.db.setSessionModel(session.sessionId, batch.model ?? session.model ?? null,
          batch.reasoningEffort ?? session.reasoningEffort ?? null);
      } catch (error) {
        this.db.recordFailure("backfill_session_model", { sessionId: session.sessionId, path: session.path }, error);
      }
    }
    this.db.setSetting(MODEL_BACKFILL_MIGRATION_KEY, "1");
  }

  async syncAll(): Promise<void> {
    return this.sessionImporter.syncChangedFiles();
  }

  private async reconcileExistingState(): Promise<void> {
    await this.reconcileSessionFiles();
    await this.migrateTitlesAndSyntheticMessages();
    await this.clearStaleActiveSessions();
    await this.purgeSubagentMessages();
    await this.restoreRootCards();
  }

  private async loadTitleIndex(): Promise<Map<string, string>> {
    if (this.titleIndex) return this.titleIndex;
    const index = new Map<string, string>();
    try {
      const content = await readFile(join(this.config.codexHome, "session_index.jsonl"), "utf8");
      for (const line of content.split("\n")) {
        try {
          const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
          if (typeof row.id === "string" && typeof row.thread_name === "string" && row.thread_name.trim()) index.set(row.id, row.thread_name.trim());
        } catch { /* ignore an incomplete index line */ }
      }
    } catch { /* index is optional; app-server provides the same metadata for new runs */ }
    this.titleIndex = index;
    return index;
  }

  private syntheticMessageId(sessionId: string, timestamp: string, text: string): string {
    return createHash("sha256").update(`${sessionId}\0${timestamp}\0user\0${text}`).digest("hex");
  }

  private async migrateTitlesAndSyntheticMessages(): Promise<void> {
    if (this.db.getSetting("migration.history_cleanup_v1") === "1") return;
    const titles = await this.loadTitleIndex();
    for (const session of this.db.listSessions()) {
      try {
        const raw = await readFile(session.path, "utf8");
        const batch = parseJsonlChunk(raw, "", session.sessionId, session.sessionId);
        const preview = batch.messages.find((message) => message.role === "user")?.text ?? session.firstUserText;
        const title = titles.get(session.sessionId) ?? session.title ?? preview;
        this.db.setSessionTitle(session.sessionId, title, preview);
        for (const line of raw.split("\n")) {
          let record: Record<string, unknown>;
          try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (record.type !== "response_item") continue;
          const payload = record.payload as Record<string, unknown> | undefined;
          if (payload?.type !== "message" || payload.role !== "user") continue;
          const content = payload.content;
          if (!Array.isArray(content)) continue;
          const text = content.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
            .filter((item) => item.type === "input_text" && typeof item.text === "string")
            .map((item) => String(item.text)).join("\n");
          const trimmed = text.trim();
          const remaining = trimmed.replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, "")
            .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "").trim();
          const synthetic = Boolean(trimmed) && remaining === "";
          if (!synthetic) continue;
          const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date(0).toISOString();
          const id = this.syntheticMessageId(session.sessionId, timestamp, text);
          const message = this.db.getMessage(id);
          if (!message?.feishuMessageId || message.recallState === "recalled") continue;
          try {
            await this.feishu.deleteMessage(message.feishuMessageId);
            this.db.markMessageRecalled(id);
          } catch (error) {
            this.db.recordFailure("recall_synthetic_message", { sessionId: session.sessionId, id }, error);
          }
        }
        const refreshed = this.db.getSession(session.sessionId);
        if (refreshed?.rootMessageId) {
          await this.feishu.updateCard(refreshed.rootMessageId, sessionCard(this.sessionView(refreshed), this.turnCoordinator.hasActiveTurn(session.sessionId) ? "运行中" : "可继续"));
        }
      } catch (error) {
        this.db.recordFailure("migrate_session_title", { sessionId: session.sessionId }, error);
      }
    }
    this.db.setSetting("migration.history_cleanup_v1", "1");
  }

  private async reconcileSessionFiles(): Promise<void> {
    if (this.db.getSetting("migration.session_path_index_v1") === "1") return;
    for (const path of await jsonlFiles(this.sessionsDir)) {
      const ownerSessionId = sessionIdFromPath(path);
      if (!ownerSessionId) continue;
      try {
        const firstChunk = await this.readRange(path, 0, Math.min((await stat(path)).size, 1_000_000));
        const batch = parseJsonlChunk(firstChunk.toString("utf8"), "", ownerSessionId, ownerSessionId);
        if (!batch.metadata) continue;
        const session = this.db.getSession(ownerSessionId);
        if (session) this.db.setSessionPath(ownerSessionId, path);
      } catch (error) {
        this.db.recordFailure("reconcile_session_path", { path }, error);
      }
    }
    this.db.setSetting("migration.session_path_index_v1", "1");
  }

  private async clearStaleActiveSessions(): Promise<void> {
    const cutoff = Date.now() - this.config.activeSessionQuietMs;
    for (const sessionId of this.db.listActiveSessionIds()) {
      if (this.turnCoordinator.hasActiveTurn(sessionId)) continue;
      const session = this.db.getSession(sessionId);
      if (!session) { this.db.setSetting(`session.${sessionId}.active`, "0"); continue; }
      try {
        if ((await stat(session.path)).mtimeMs < cutoff && !await this.hasWritableFileDescriptor(session.path)) {
          this.db.setSetting(`session.${sessionId}.active`, "0");
        }
      } catch {
        this.db.setSetting(`session.${sessionId}.active`, "0");
      }
    }
  }

  private async hasWritableFileDescriptor(path: string): Promise<boolean> {
    let processes;
    try { processes = await readdir("/proc", { withFileTypes: true }); } catch { return false; }
    for (const process of processes) {
      if (!process.isDirectory() || !/^\d+$/.test(process.name)) continue;
      const fdDir = `/proc/${process.name}/fd`;
      let fds;
      try { fds = await readdir(fdDir); } catch { continue; }
      for (const fd of fds) {
        try {
          if (await readlink(`${fdDir}/${fd}`) !== path) continue;
          const info = await readFile(`/proc/${process.name}/fdinfo/${fd}`, "utf8");
          const flags = info.match(/^flags:\s*(\S+)$/m)?.[1];
          if (flags && (Number.parseInt(flags, 8) & 3) !== 0) return true;
        } catch { /* a process can exit while its descriptor is inspected */ }
      }
    }
    return false;
  }

  private async purgeSubagentMessages(): Promise<void> {
    if (this.db.getSetting("migration.subagent_cleanup_v1") === "1") return;
    for (const path of await jsonlFiles(this.sessionsDir)) {
      const ownerSessionId = sessionIdFromPath(path);
      if (!ownerSessionId) continue;
      try {
        const content = await readFile(path, "utf8");
        let currentSessionId: string | null = null;
        let currentLines: string[] = [];
        const foreignSegments: string[] = [];
        const flush = () => {
          if (currentSessionId && currentSessionId !== ownerSessionId && currentLines.length) {
            foreignSegments.push(`${currentLines.join("\n")}\n`);
          }
          currentLines = [];
        };
        for (const line of content.split("\n")) {
          try {
            const record = JSON.parse(line) as { type?: unknown; payload?: { session_id?: unknown } };
            if (record.type === "session_meta" && typeof record.payload?.session_id === "string") {
              flush();
              currentSessionId = record.payload.session_id;
            }
          } catch { /* ignored: parser records malformed JSON separately */ }
          if (currentSessionId) currentLines.push(line);
        }
        flush();
        const messageIds = new Set<string>();
        for (const segment of foreignSegments) {
          const batch = parseJsonlChunk(segment);
          for (const message of batch.messages) messageIds.add(message.id);
          for (const request of batch.choiceRequests) messageIds.add(request.id);
        }
        for (const messageId of messageIds) {
          const record = this.db.getMessage(messageId);
          if (!record || !record.feishuMessageId || !["outbound", "outbound_choice"].includes(record.direction)) continue;
          try {
            await this.feishu.deleteMessage(record.feishuMessageId);
            this.db.markMessageRecalled(messageId);
          } catch (error) {
            this.db.recordFailure("recall_subagent_message", { messageId, path, feishuMessageId: record.feishuMessageId }, error);
          }
        }
      } catch (error) {
        this.db.recordFailure("purge_subagent_message", { path }, error);
      }
    }
    this.db.setSetting("migration.subagent_cleanup_v1", "1");
  }

  private async restoreRootCards(): Promise<void> {
    for (const session of this.db.listSessions()) {
      if (!session.rootMessageId) continue;
      const marker = `feishu.expired_card.${session.rootMessageId}`;
      if (this.db.getSetting(marker)) {
        this.db.resolveFailure("restore_root_card", { sessionId: session.sessionId });
        continue;
      }
      try {
        await this.feishu.updateCard(session.rootMessageId, sessionCard(this.sessionView(session), this.turnCoordinator.hasActiveTurn(session.sessionId) ? "运行中" : "可继续"));
        this.db.setSessionCardMessage(session.sessionId, session.rootMessageId);
        this.db.resolveFailure("restore_root_card", { sessionId: session.sessionId });
      } catch (error) {
        if (isExpiredFeishuMessage(error)) {
          this.db.setSetting(marker, "230031");
          this.db.resolveFailure("restore_root_card", { sessionId: session.sessionId });
          continue;
        }
        this.db.recordFailure("restore_root_card", { sessionId: session.sessionId }, error);
      }
    }
  }

  private async readRange(path: string, start: number, end: number): Promise<Buffer> {
    const handle = await open(path, "r");
    try {
      const data = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(data, 0, data.length, start);
      return data.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }

  private async processFile(path: string): Promise<void> {
    const chatId = this.boundChatId();
    if (!chatId || this.paused()) return;
    const fileStat = await stat(path);
    if (!fileStat.isFile()) return;
    const ownerSessionId = sessionIdFromPath(path);
    // The live stream owns delivery until its final card and deduplication
    // records are committed. Leave the cursor untouched so import retries later.
    if (ownerSessionId && this.turnCoordinator.hasActiveTurn(ownerSessionId)) return;
    let cursor = this.db.getCursor(path);
    if (ownerSessionId && cursor.sessionId !== ownerSessionId) {
      cursor = { ...cursor, sessionId: null, parsedOffset: 0, carry: "" };
    }
    if (fileStat.size < cursor.parsedOffset) {
      cursor = { path, sessionId: null, parsedOffset: 0, archivedOffset: cursor.archivedOffset, carry: "", size: 0, mtimeMs: 0 };
    }

    let batch: ReturnType<typeof parseJsonlChunk> | null = null;
    let parsedEnd = cursor.parsedOffset;
    if (fileStat.size > cursor.parsedOffset) {
      const data = await this.readRange(path, cursor.parsedOffset, fileStat.size);
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        const complete = data.subarray(0, lastNewline + 1);
        parsedEnd = cursor.parsedOffset + complete.length;
        batch = parseJsonlChunk(complete.toString("utf8"), "", cursor.sessionId ?? "", ownerSessionId ?? "");
        if (batch.unknownTypes.length) {
          console.warn(`Ignored unknown JSONL event types in ${path}: ${batch.unknownTypes.join(", ")}`);
        }
      }
    }

    if (batch?.metadata) {
      const firstUser = batch.messages.find((message) => message.role === "user")?.text ?? "";
      const title = (await this.loadTitleIndex()).get(batch.metadata.sessionId) ?? firstUser;
      const metadata: SessionMetadata = { ...batch.metadata, path, firstUserText: firstUser, title, collaborationMode: "default" };
      if (isSubagentSource(metadata.source)) {
        cursor.sessionId = null;
        cursor.parsedOffset = parsedEnd;
        cursor.size = fileStat.size;
        cursor.mtimeMs = fileStat.mtimeMs;
        this.db.saveCursor(cursor);
        return;
      }
      this.db.upsertSession(metadata);
      cursor.sessionId = metadata.sessionId;
      const pending = this.db.getSetting(this.pendingModelKey(metadata.sessionId));
      if (pending) {
        try {
          const value = JSON.parse(pending) as { model?: unknown; reasoningEffort?: unknown };
          if (typeof value.model === "string" && typeof value.reasoningEffort === "string") {
            this.db.setSessionModel(metadata.sessionId, value.model, value.reasoningEffort);
          }
        } finally { this.db.deleteSetting(this.pendingModelKey(metadata.sessionId)); }
      }
    }
    if (!cursor.sessionId) {
      cursor.size = fileStat.size;
      cursor.mtimeMs = fileStat.mtimeMs;
      this.db.saveCursor(cursor);
      return;
    }

    let session = this.db.getSession(cursor.sessionId);
    if (!session) return;
    if (batch?.model || batch?.reasoningEffort) {
      this.db.setSessionModel(session.sessionId, batch.model ?? session.model ?? null,
        batch.reasoningEffort ?? session.reasoningEffort ?? null);
      session = this.db.getSession(cursor.sessionId)!;
    }
    if (!session.firstUserText && batch) {
      const firstUser = batch.messages.find((message) => message.role === "user")?.text;
      if (firstUser) {
        this.db.upsertSession({ ...session, firstUserText: firstUser });
        session = this.db.getSession(cursor.sessionId)!;
      }
    }
    const rootId = await this.ensureRoot(chatId, session);

    for (const message of batch?.messages ?? []) {
      if (this.db.hasMessage(message.id)) continue;
      if (message.role === "user") {
        const originalFeishuId = this.consumePendingPrompt(session.sessionId, message.text);
        if (originalFeishuId) {
          this.db.saveMessage(message.id, session.sessionId, "inbound_mirror", originalFeishuId, { path, kind: "primary" });
          continue;
        }
      }
      if (message.role === "progress" && !this.turnCoordinator.hasActiveTurn(session.sessionId)) continue;
      const label = message.role === "user" ? "用户" : message.role === "assistant" ? "Codex" : "进度";
      // A bridge turn whose result could not be sent yet is delivered through its resend, not again from the log.
      if (message.role === "assistant" && this.db.hasUndeliveredTurnOutput(session.sessionId, textHash(message.text))) {
        this.db.saveMessage(message.id, session.sessionId, "app_server_delivery", null, { path, kind: "pending_output" });
        continue;
      }
      const mapped = message.role === "assistant" ? this.db.findAppServerDelivery(session.sessionId, "assistant", textHash(message.text)) : null;
      if (mapped?.feishuMessageId) {
        this.db.saveMessage(message.id, session.sessionId, "app_server_delivery", mapped.feishuMessageId, { path, kind: "primary" });
        continue;
      }
      let feishuId: string;
      if (serializedBytes(message.text) > MAX_INLINE_MESSAGE_BYTES) {
        const preview = shortText(message.text, 1_000);
        await this.feishu.replyText(rootId, `${label}（正文过长，完整内容见附件）\n${preview}`);
        feishuId = await this.feishu.replyFile(rootId, `${session.sessionId.slice(0, 8)}-${message.id.slice(0, 12)}.md`, Buffer.from(message.text));
      } else if (message.role === "assistant") {
        feishuId = await this.replyAssistant(rootId, session, message.text);
      } else {
        feishuId = await this.feishu.replyText(rootId, `${label}\n${message.text}`);
      }
      this.db.saveMessage(message.id, session.sessionId, "outbound", feishuId, { path, kind: "primary" });
    }
    // A question is settled once its tool call has an output or a newer user
    // message moved the conversation on; either happened in some frontend.
    const answeredCallIds = new Set(batch?.answeredCallIds ?? []);
    let latestUserAtMs = 0;
    let latestLocalUserAtMs = 0;
    for (const message of batch?.messages ?? []) {
      const at = message.role === "user" ? Date.parse(message.timestamp) : Number.NaN;
      if (!Number.isFinite(at)) continue;
      latestUserAtMs = Math.max(latestUserAtMs, at);
      if (this.db.getMessage(message.id)?.direction !== "inbound_mirror") latestLocalUserAtMs = Math.max(latestLocalUserAtMs, at);
    }
    for (const request of batch?.choiceRequests ?? []) {
      if (this.db.hasMessage(request.id)) continue;
      // Questions of bridge-started turns were asked through the app-server request
      // card; app-server item ids are expected to equal the logged call ids.
      if (answeredCallIds.has(request.id) || latestUserAtMs > Date.parse(request.timestamp) || this.db.hasServerRequestForItem(session.sessionId, request.id)) {
        this.db.saveMessage(request.id, session.sessionId, "outbound_choice", null, { path, kind: "settled" });
        continue;
      }
      let feishuId: string;
      if (forbiddenRemoteQuestion(request)) {
        feishuId = await this.feishu.replyText(rootId, "Codex 请求了不允许远程确认的安全信息或权限。请在本机处理；飞书不会提供批准按钮。");
      } else {
        // The asking turn is still running locally, so the session stays active
        // and a Feishu answer waits until the terminal releases it.
        this.savePendingChoice({ request, rootId, questionIndex: 0, answers: [] });
        feishuId = await this.feishu.replyCard(rootId, choiceCard(request, 0));
      }
      this.db.saveMessage(request.id, session.sessionId, "outbound_choice", feishuId, { path, kind: "primary" });
    }
    if (answeredCallIds.size || latestUserAtMs) await this.settleChoices(session.sessionId, rootId, answeredCallIds, latestUserAtMs, latestLocalUserAtMs);
    if (batch?.turnActive !== undefined) this.db.setSetting(`session.${session.sessionId}.active`, batch.turnActive ? "1" : "0");
    cursor.parsedOffset = parsedEnd;

    const latestStat = await stat(path);
    cursor.size = latestStat.size;
    cursor.mtimeMs = latestStat.mtimeMs;
    this.db.saveCursor(cursor);
    if (latestStat.size > fileStat.size || latestStat.mtimeMs > fileStat.mtimeMs) {
      console.info(`Session log changed during scan; scheduling another pass path=${basename(path)} offset=${cursor.parsedOffset}`);
      const timer = setTimeout(() => this.sessionImporter.enqueue(path), 300);
      timer.unref();
    }
  }

  private async replyAssistant(rootId: string, session: SessionMetadata, text: string): Promise<string> {
    const streaming = this.feishu.createStreamingReply && process.env.FEISHU_CARDKIT_STREAMING !== "0";
    if (streaming) {
      try {
        const stream = await this.feishu.createStreamingReply!(rootId, session.title || "Codex");
        stream.sequence = await this.feishu.updateStreamingReply!(stream, text);
        await this.feishu.finishStreamingReply!(stream, "Codex 已完成");
        return stream.messageId;
      } catch (error) {
        this.db.recordFailure("cardkit_stream", { sessionId: session.sessionId }, error);
        console.warn("CardKit streaming failed; falling back to inline card", error);
      }
    }
    return this.feishu.replyCard(rootId, assistantMarkdownCard(text));
  }

  private async ensureRoot(chatId: string, session: SessionMetadata & { rootMessageId: string | null; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }): Promise<string> {
    if (session.rootMessageId) return session.rootMessageId;
    const title = session.title || shortText(session.firstUserText || "Codex 会话");
    const detail = `开始：${session.startedAt}\n目录：${session.cwd}\n来源：${session.source}\n原始日志仅保存在本机。`;
    const root = await this.feishu.createSessionRoot(chatId, title, detail, sessionCard(this.sessionView(session)));
    this.db.setSessionRoot(session.sessionId, root.messageId, root.appLink, root.chatId, root.threadId);
    this.db.setSessionCardMessage(session.sessionId, root.messageId);
    return root.messageId;
  }

  private asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  private stringAt(value: Record<string, unknown>, ...keys: string[]): string | null {
    for (const key of keys) if (typeof value[key] === "string" && String(value[key]).trim()) return String(value[key]);
    return null;
  }

  private async cleanupTurnImages(turnId: string): Promise<void> {
    const raw = this.db.getSetting(`turn.${turnId}.images`);
    if (!raw) return;
    try {
      const paths = JSON.parse(raw) as string[];
      await Promise.all([...new Set(paths.map((path) => dirname(path)))].map((path) => rm(path, { recursive: true, force: true })));
    } catch { /* malformed or already removed temporary files are harmless */ }
    this.db.deleteSetting(`turn.${turnId}.images`);
  }

  /**
   * Cancels a session's queued tasks at once and asks Codex to interrupt its running turn. The
   * turn counts as cancelled only when Codex reports its end: until then it stays active (and
   * keeps its images and output), and a refused interrupt leaves it running.
   */
  private async cancelSessionWork(sessionId: string | null, rootMessageId: string | null, reason: string): Promise<CancelOutcome> {
    const activeTurnIds = this.turnCoordinator.states().map((turn) => turn.turnId);
    const cancelled = sessionId ? this.db.cancelTasksBySession(sessionId, reason, activeTurnIds) : rootMessageId ? this.db.cancelTasksByRoot(rootMessageId, reason, activeTurnIds) : [];
    const targetIds = new Set<string>(cancelled.flatMap((task) => task.sessionId ? [task.sessionId] : []));
    if (sessionId) targetIds.add(sessionId);
    if (rootMessageId) { const rooted = this.db.getSessionByRoot(rootMessageId); if (rooted) targetIds.add(rooted.sessionId); }
    // Tasks taken from the queue but not yet started in Codex: their start checks for this and stops.
    const starting = cancelled.filter((task) => task.status !== "pending").length;
    const outcome: CancelOutcome = { tasks: cancelled.length, starting, turn: "none", error: null };
    for (const targetSessionId of targetIds) {
      const active = this.turnCoordinator.mutableTurn(targetSessionId);
      if (!active) { await this.approvalService.cancelForSession(targetSessionId); continue; }
      // The turn already ended and its result is being sent: there is nothing left to stop.
      if (TERMINAL_TURN_STATES.has(active.state)) { outcome.turn = "ended"; continue; }
      // A repeated cancel is answered from the first one; only an interrupt that has gone unconfirmed for a while is sent again.
      if (active.state === "cancelling" && Date.now() - (this.cancelRequestedAt.get(active.turnId) ?? 0) < CANCEL_CONFIRM_WAIT_MS) { outcome.turn = "requested"; continue; }
      if (!this.appServer) { outcome.turn = "failed"; outcome.error = "Codex app-server 不可用"; continue; }
      const previous = active.state === "cancelling" ? "running" : active.state;
      active.state = "cancelling"; this.db.saveTurn(active);
      this.cancelRequestedAt.set(active.turnId, Date.now());
      try {
        await this.appServer.request("turn/interrupt", { threadId: targetSessionId, turnId: active.turnId }, 15_000);
      } catch (error) {
        this.db.recordFailure("turn_interrupt", { sessionId: targetSessionId }, error);
        const still = this.turnCoordinator.mutableTurn(targetSessionId) === active && active.state === "cancelling";
        if (!still) { outcome.turn = "ended"; continue; }
        if (this.appServerOutcomeUncertain(error)) {
          // No answer is not a refusal: the turn may be stopping, so it stays in cancelling until Codex says how it ended.
          outcome.turn = "uncertain";
          this.watchCancellation(active);
          continue;
        }
        // Refused: the turn goes on and is still shown, and its requests stay answerable.
        active.state = previous; this.db.saveTurn(active); this.cancelRequestedAt.delete(active.turnId);
        outcome.turn = "failed"; outcome.error = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        continue;
      }
      // The turn may have ended while the interrupt was on its way; its completion already updated the card.
      if (this.turnCoordinator.mutableTurn(targetSessionId) !== active) { outcome.turn = "ended"; continue; }
      outcome.turn = "requested";
      await this.approvalService.cancelForSession(targetSessionId);
      this.watchCancellation(active);
    }
    return outcome;
  }

  /** Says so on the run card when Codex accepted an interrupt but has not ended the turn after a while. */
  private watchCancellation(turn: TurnState): void {
    const existing = this.cancelTimers.get(turn.turnId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.cancelTimers.delete(turn.turnId);
      const current = this.turnCoordinator.mutableTurn(turn.sessionId);
      if (current?.turnId !== turn.turnId || current.state !== "cancelling") return;
      void this.updateRunCard(turn.sessionId, turn.rootMessageId, "取消待确认", "已请求停止，但 Codex 尚未确认本轮结束；结束后这里会更新。", false)
        .catch((error) => this.db.recordFailure("cancel_watch_card", { turnId: turn.turnId }, error));
    }, CANCEL_CONFIRM_WAIT_MS);
    timer.unref();
    this.cancelTimers.set(turn.turnId, timer);
  }

  /** The run card and reply text for a cancellation. */
  /** The run card and reply text for a cancellation; `update: false` when the card already shows how the turn ended. */
  private cancelReport(outcome: CancelOutcome): { state: string; detail: string; update: boolean } | null {
    if (outcome.turn === "failed") return { state: "取消失败", detail: `Codex 没有接受停止请求，本轮仍在运行${outcome.error ? `（${outcome.error}）` : ""}。可以稍后再试。`, update: true };
    if (outcome.turn === "uncertain") return { state: "取消待确认", detail: "停止请求没有得到 Codex 答复，本轮可能仍在运行；结束后这里会更新，也可以稍后再次取消。", update: true };
    if (outcome.turn === "requested") return { state: "正在取消", detail: "已请求 Codex 停止本轮，等待 Codex 确认。", update: true };
    if (outcome.turn === "ended") return { state: "本轮已结束", detail: "本轮在取消前已经结束，状态卡显示的是实际结果。", update: false };
    if (outcome.starting) return { state: "已取消", detail: "任务已取消。正在启动的任务如果已交给 Codex，会立即被停止。", update: true };
    if (outcome.tasks) return { state: "已取消", detail: "排队中的任务已取消，未执行。", update: true };
    return null;
  }
  private async handleAppServerExit(epoch: number, error?: Error): Promise<void> {
    if (this.stopping) return;
    const interrupted = this.db.markRunningTasksInterrupted();
    const cutOff: string[] = [];
    for (const turn of this.turnCoordinator.states()) {
      // A turn that already ended is being reported by its completion; it is left to that.
      if (TERMINAL_TURN_STATES.has(turn.state)) continue;
      if (turn.stream && this.feishu.finishStreamingReply) void this.feishu.finishStreamingReply(turn.stream, "Codex 已中断").catch(() => undefined);
      try { this.storeTurnOutput(turn, "Codex 已中断（app-server 退出）"); cutOff.push(turn.turnId); } catch (error) { this.db.recordFailure("turn_output_store", { turnId: turn.turnId }, error); }
      turn.state = "interrupted"; this.db.saveTurn(turn); await this.cleanupTurnImages(turn.turnId);
    }
    if (cutOff.length) void this.deliverPendingOutputs();
    this.turnCoordinator.clearTurns();
    this.approvalService.clear();
    for (const timer of this.cancelTimers.values()) clearTimeout(timer);
    this.cancelTimers.clear();
    // Requests of the exited process can no longer be answered.
    for (const request of this.db.expireServerRequests(epoch)) {
      if (request.cardMessageId) void this.feishu.updateCard(request.cardMessageId, remoteRequestResolvedCard("请求已失效", "Codex app-server 已退出；请在话题中重新提交。", false)).catch(() => undefined);
    }
    for (const task of interrupted) {
      if (task.runCardMessageId) void this.feishu.updateCard(task.runCardMessageId, runStatusCard("已中断", "Codex app-server 已退出；该任务不会自动重放。")).catch(() => undefined);
      if (task.rootMessageId && task.sessionId) void this.updateRunCard(task.sessionId, task.rootMessageId, "已中断", "Codex app-server 已退出；该任务不会自动重放。", false).catch(() => undefined);
    }
    if (error) this.db.recordFailure("app_server_exit", { epoch }, error);
    this.scheduleAppServerRestart();
  }

  private scheduleAppServerRestart(): void {
    if (this.stopping) return;
    if (!this.appServer || this.appServerRestartTimer || this.appServerRestartAttempts >= 5) return;
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000];
    const delay = delays[this.appServerRestartAttempts++] ?? 30_000;
    this.appServerRestartTimer = setTimeout(() => {
      this.appServerRestartTimer = null;
      void this.appServer!.restart("recover after unexpected app-server exit").then(() => this.drainPendingTasks()).catch((error) => {
        this.db.recordFailure("app_server_restart", { attempt: this.appServerRestartAttempts }, error);
        this.scheduleAppServerRestart();
      });
    }, delay);
    this.appServerRestartTimer.unref();
  }

  private async expireRemoteState(): Promise<void> {
    for (const request of this.db.expireServerRequests()) {
      if (request.cardMessageId) void this.feishu.updateCard(request.cardMessageId, remoteRequestResolvedCard("请求已失效", "Codex 服务已重启；请在话题中重新提交。", false)).catch(() => undefined);
    }
    this.db.revokeLegacyRootGrants();
    this.db.expireTaskRootGrants(this.appServer?.appServerEpoch);
  }

  private async expireRootGrants(): Promise<void> {
    const expired = this.db.expireTaskRootGrants(this.appServer?.appServerEpoch);
    for (const grant of expired) {
      if (grant.sessionId) {
        const outcome = await this.cancelSessionWork(grant.sessionId, null, "Root authorization expired");
        const session = this.db.getSession(grant.sessionId);
        const report = this.cancelReport(outcome) ?? { state: "已取消", detail: "Root 授权已过期，任务未执行。", update: true };
        if (session?.rootMessageId && report.update) void this.updateRunCard(grant.sessionId, session.rootMessageId, report.state, outcome.turn === "none" ? "Root 授权已过期，任务未执行。" : report.detail, outcome.turn === "failed").catch(() => undefined);
      } else {
        const task = this.db.getTask(grant.taskId);
        if (task?.runCardMessageId) void this.feishu.updateCard(task.runCardMessageId, runStatusCard("已取消", "Root 授权已过期；未创建 Codex 会话。", false)).catch(() => undefined);
      }
    }
  }

  private async repairHistoricalDuplicateCreation(): Promise<void> {
    if (this.db.getSetting("migration.duplicate_new_task_repair.v1") === "1") return;
    const sessions = this.db.repairHistoricalDuplicateNewTask();
    for (const session of sessions) {
      if (this.appServer) {
        try { await this.appServer.request("thread/archive", { threadId: session.sessionId }, 15_000); }
        catch (error) { if (!/not found|does not exist|unknown thread|no rollout found/i.test(String(error))) this.db.recordFailure("historical_thread_archive", { sessionId: session.sessionId }, error); }
      }
      const current = this.db.getSession(session.sessionId);
      if (current?.rootMessageId) {
        try { await this.feishu.updateCard(current.rootMessageId, sessionCard(this.sessionView(current), "创建失败，未执行；请重新新建会话")); }
        catch (error) { this.db.recordFailure("historical_duplicate_card", { sessionId: session.sessionId }, error); }
      }
    }
    this.db.setSetting("migration.duplicate_new_task_repair.v1", "1");
  }

  private async refreshThreadsFromAppServer(): Promise<void> {
    if (!this.appServer) return;
    const unmapped: Record<string, unknown>[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const result = this.asRecord(await this.appServer.request("thread/list", {
          archived, sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"], ...(cursor ? { cursor } : {}),
        }));
        const threads = Array.isArray(result.threads) ? result.threads : Array.isArray(result.data) ? result.data : [];
        for (const item of threads) {
          const thread = this.asRecord(item); const sessionId = this.stringAt(thread, "id");
          if (!sessionId) continue;
          const existing = this.db.getSession(sessionId); if (!existing) { unmapped.push(thread); continue; }
          if (existing.lifecycle === "abandoned") continue;
          const title = this.stringAt(thread, "name") ?? this.stringAt(thread, "preview") ?? existing.title;
          const lifecycle = archived ? "archived" : "active"; const changed = existing.lifecycle !== lifecycle || Boolean(title && title !== existing.title);
          if (title) this.db.setSessionTitle(sessionId, title);
          this.db.setSessionLifecycle(sessionId, lifecycle);
          if (changed && existing.rootMessageId) { const current = this.db.getSession(sessionId); if (current) await this.feishu.updateCard(existing.rootMessageId, sessionCard(this.sessionView(current), lifecycle === "archived" ? "已归档" : this.turnCoordinator.hasActiveTurn(sessionId) ? "运行中" : "可继续")); }
        }
        cursor = this.stringAt(result, "nextCursor", "next_cursor");
      } while (cursor);
    }
    for (const task of this.db.creationUncertainTasks()) {
      const started = task.creationStartedAtMs ?? 0;
      let canonicalCwd: string;
      try { canonicalCwd = await resolveAllowedPath(task.cwd, this.config.allowedRoot); } catch { continue; }
      const candidates = unmapped.filter((thread) => {
        const source = this.stringAt(thread, "source");
        const cwd = this.stringAt(thread, "cwd");
        const created = Number(thread.createdAt ?? 0) * 1000;
        const parent = this.stringAt(thread, "parentThreadId");
        return source === "appServer" && !parent && cwd === canonicalCwd && created >= started - 5_000 && created <= started + 120_000;
      });
      if (candidates.length !== 1) continue;
      const thread = candidates[0]!; const sessionId = this.stringAt(thread, "id"); if (!sessionId) continue;
      const metadata: SessionMetadata = { sessionId, path: this.stringAt(thread, "path") ?? join(this.sessionsDir, "app-server", `.jsonl`), cwd: canonicalCwd,
        startedAt: new Date(Number(thread.createdAt ?? 0) * 1000).toISOString(), source: "appServer", firstUserText: task.prompt,
        title: this.stringAt(thread, "name") ?? this.stringAt(thread, "preview") ?? shortText(task.prompt), collaborationMode: "default", model: task.model, reasoningEffort: task.reasoningEffort };
      if (this.db.claimUncertainCreatedSession(task.id, metadata)) {
        if (task.runCardMessageId) await this.feishu.updateCard(task.runCardMessageId, runStatusCard("已恢复创建", "已唯一认领 app-server 返回前后创建的线程；不会再次调用 thread/start。"));
        void this.taskScheduler.drain(sessionId);
      }
    }
  }

  private sessionView<T extends { sessionId: string; cwd: string }>(session: T): T & { executionMode: BridgeConfig["executionMode"]; rootExecutionReady: boolean; rootPreflightReasons: string[]; hasActiveWork: boolean } {
    let reasons: string[] = [];
    try { reasons = JSON.parse(this.db.getSetting("codex.root_preflight") ?? "{}").reasons ?? []; } catch { /* invalid diagnostics are ignored */ }
    return { ...session, executionMode: this.config.executionMode, rootExecutionReady: this.rootExecutionReady, rootPreflightReasons: reasons, hasActiveWork: this.turnCoordinator.hasActiveTurn(session.sessionId) };
  }

  private requestKind(method: string): RemoteRequestType | null {
    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") return "user_input";
    if (method === "item/commandExecution/requestApproval") return "command_approval";
    if (method === "item/fileChange/requestApproval") return "file_approval";
    if (method === "item/permissions/requestApproval") return "permissions";
    if (method === "mcpServer/elicitation/request") return "mcp_elicitation";
    return null;
  }

  private safeRequestPayload(type: RemoteRequestType, value: Record<string, unknown>, canonicalCwd?: string): Record<string, unknown> {
    const summary = remoteApprovalSummary(type, value, canonicalCwd ? { taskId: "", sessionId: "", collaborationMode: "default", executionMode: this.config.executionMode ?? "workspace-write", canonicalCwd, allowedMcpServers: new Set(this.config.allowedMcpServers ?? []) } : undefined);
    if (type === "permissions") {
      const permissions = Array.isArray(value.permissions) ? value.permissions.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const permission = item as Record<string, unknown>;
        if (permission.type !== "fs_read" && permission.type !== "fs_write") return [];
        const path = typeof permission.path === "string" && canonicalCwd ? relative(canonicalCwd, resolve(canonicalCwd, permission.path)) : undefined;
        return [{ type: permission.type, ...(path ? { path: path.slice(0, 240) } : {}) }];
      }).slice(0, 20) : [];
      return { ...summary, permissions };
    }
    if (type !== "user_input") return summary as unknown as Record<string, unknown>;
    const questions = Array.isArray(value.questions) ? value.questions.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const q = item as Record<string, unknown>;
      if (q.isSecret === true) return [];
      const options = Array.isArray(q.options) ? q.options.flatMap((option) => {
        if (!option || typeof option !== "object") return []; const o = option as Record<string, unknown>;
        return typeof o.label === "string" ? [{ label: o.label.slice(0, 200), description: typeof o.description === "string" ? o.description.slice(0, 300) : "" }] : [];
      }).slice(0, 20) : [];
      return [{ id: typeof q.id === "string" ? q.id.slice(0, 100) : "question", header: typeof q.header === "string" ? q.header.slice(0, 200) : "问题", question: typeof q.question === "string" ? q.question.slice(0, 500) : "", options }];
    }).slice(0, 10) : [];
    return { type, questions };
  }

  private async onAppServerRequest(request: JsonRpcMessage): Promise<unknown> {
    const type = this.requestKind(request.method ?? "");
    const params = this.asRecord(request.params);
    const sessionId = this.stringAt(params, "threadId", "thread_id");
    const turnId = this.stringAt(params, "turnId", "turn_id");
    const itemId = this.stringAt(params, "itemId", "item_id");
    const session = sessionId ? this.db.getSession(sessionId) : null;
    const openId = this.boundOpenId();
    if (!type || !session?.rootMessageId || !openId || !this.appServer || request.id === undefined) {
      throw new Error(`Unsupported or unscoped Codex server request ${request.method ?? "unknown"}`);
    }
    const task = turnId ? this.db.taskForTurn(turnId) : null;
    if (!task) throw new Error("Codex request is not attached to an active task");
    const canonicalCwd = await resolveAllowedPath(session.cwd, this.config.allowedRoot);
    if (type === "file_approval") {
      const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : typeof params.grant_root === "string" ? params.grant_root : canonicalCwd;
      await resolveAllowedPath(grantRoot, canonicalCwd);
      const paths = Array.isArray(params.changes) ? params.changes : Array.isArray(params.paths) ? params.paths : [];
      for (const path of paths) if (typeof path === "string") await resolveAllowedPath(path, canonicalCwd);
    }
    if (type === "permissions" && Array.isArray(params.permissions)) {
      for (const item of params.permissions) {
        if (!item || typeof item !== "object") continue;
        const path = (item as Record<string, unknown>).path;
        if (typeof path === "string") await resolveAllowedPath(path, canonicalCwd);
      }
    }
    const mode = session.collaborationMode === "plan" ? "plan" : "default";
    const policy = remoteApprovalAllowed(type, params, this.config.allowedMcpServers ?? [], { taskId: task.id, sessionId: session.sessionId, collaborationMode: mode, executionMode: this.config.executionMode ?? "workspace-write", canonicalCwd, allowedMcpServers: new Set(this.config.allowedMcpServers ?? []) });
    if (!policy.allowed) throw new Error(policy.reason);
    const scopedSessionId = session.sessionId;
    const rootMessageId = session.rootMessageId;
    const nonce = randomUUID();
    const expiry = Number.isFinite(Number(params.autoResolutionMs)) ? Date.now() + Number(params.autoResolutionMs) : Date.now() + 30 * 60_000;
    const pending: PendingServerRequest = {
      nonce, rpcId: request.id, epoch: this.appServer.appServerEpoch, type, sessionId: scopedSessionId, turnId, itemId,
      openId, chatId: session.chatId ?? this.boundChatId() ?? "", rootMessageId,
      cardMessageId: null, payload: this.safeRequestPayload(type, params, canonicalCwd), status: "pending", expiresAt: expiry,
    };
    const state = this.turnCoordinator.mutableTurn(scopedSessionId);
    if (state && state.state !== "cancelling") {
      state.state = type === "user_input" ? "awaiting_input" : "awaiting_approval"; this.db.saveTurn(state);
      const task = turnId ? this.db.taskForTurn(turnId) : null;
      if (task) this.db.transitionTask(task.id, state.state);
    }
    const detail = this.remoteRequestDetail(type, pending.payload);
    const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions.flatMap((item) => typeof item === "string" ? [item] : []) : undefined;
    const secret = type === "user_input" && this.requestContainsSecret(params);
    if (secret) throw new Error("Secret input is never accepted through Feishu");
    const card = type === "user_input"
      ? remoteQuestionCard(nonce, this.userInputQuestions(pending), 0)
      : remoteRequestCard({ nonce, type, title: this.remoteRequestTitle(type), detail, ...(decisions ? { decisions } : {}), secret });
    // Stored and awaited before the card exists: an answer may arrive as soon as it is shown.
    this.db.saveServerRequest(pending);
    const answered = this.approvalService.waitFor(nonce);
    const timeout = setTimeout(() => {
      const live = this.db.timeOutServerRequest(nonce);
      if (!live) return;
      void this.resolveRemoteRequest(live, "decline").catch((error) => this.db.recordFailure("remote_request_timeout", { nonce }, error));
    }, Math.max(1, expiry - Date.now()));
    timeout.unref();
    this.approvalService.setTimer(nonce, timeout);
    try {
      pending.cardMessageId = await this.feishu.replyCard(rootMessageId, card);
    } catch (error) {
      // Nobody can answer a request that is not shown; Codex is told so instead of waiting.
      this.approvalService.take(nonce);
      this.db.setServerRequestStatus(nonce, "expired");
      if (state?.state === "awaiting_input" || state?.state === "awaiting_approval") { state.state = "running"; this.db.saveTurn(state); }
      if (task) this.db.transitionTask(task.id, "running");
      throw error;
    }
    this.db.setServerRequestCard(nonce, pending.cardMessageId);
    await this.updateRunCard(scopedSessionId, rootMessageId, type === "user_input" ? "等待输入" : "等待批准", "Codex 正在等待你的选择。", true)
      .catch((error) => this.db.recordFailure("status_card_request", { sessionId: scopedSessionId }, error));
    return answered;
  }

  private async resolveRemoteRequest(request: PendingServerRequest, decision: string, answers: readonly string[] = []): Promise<void> {
    const resolver = this.approvalService.take(request.nonce);
    this.db.deleteSetting(this.userInputAnswersKey(request.nonce));
    if (!resolver) { this.db.setServerRequestStatus(request.nonce, "expired"); return; }
    const params = request.payload;
    let result: unknown;
    if (request.type === "user_input") {
      // One answer list per question id; declining sends no answers at all.
      const answered: Record<string, { answers: string[] }> = {};
      if (decision === "accept") {
        this.userInputQuestions(request).forEach((question, index) => {
          const answer = answers[index];
          if (answer) answered[question.id] = { answers: [answer] };
        });
      }
      result = { answers: answered };
    } else if (request.type === "permissions") {
      result = decision === "accept" || decision === "acceptForSession"
        ? { permissions: Array.isArray(params.permissions) ? params.permissions : [], scope: decision === "acceptForSession" ? "session" : "turn" }
        : { permissions: [], scope: "turn" };
    } else if (request.type === "mcp_elicitation") {
      result = { action: decision === "accept" ? "accept" : decision === "cancel" ? "cancel" : "decline", content: null, _meta: null };
    } else {
      result = { decision: decision === "accept" || decision === "acceptForSession" || decision === "cancel" ? decision : "decline" };
    }
    this.db.setServerRequestStatus(request.nonce, decision === "decline" ? "declined" : "resolved");
    if (request.turnId) { const task = this.db.taskForTurn(request.turnId); if (task) this.db.transitionTask(task.id, "running"); }
    resolver(result);
    const accepted = decision === "accept" || decision === "acceptForSession";
    const detail = request.type === "user_input"
      ? accepted ? "回答已提交，Codex 在本轮内继续。" : "未回答，Codex 在本轮内继续。"
      : accepted ? "已批准。" : "已拒绝或取消。";
    const cardMessageId = this.db.getServerRequest(request.nonce)?.cardMessageId ?? request.cardMessageId;
    if (cardMessageId) await this.feishu.updateCard(cardMessageId, remoteRequestResolvedCard("Codex 请求已提交", detail, accepted));
  }

  private userInputAnswersKey(nonce: string): string { return `remote_input.${nonce}.answers`; }

  /** Questions of a native Codex input request, as sanitized into the stored payload. */
  private userInputQuestions(request: PendingServerRequest): ChoiceQuestion[] {
    const questions = Array.isArray(request.payload.questions) ? request.payload.questions : [];
    return questions.map((item, index) => {
      const question = this.asRecord(item);
      const options = Array.isArray(question.options) ? question.options.flatMap((option) => {
        const value = this.asRecord(option);
        return typeof value.label === "string" ? [{ label: value.label, description: typeof value.description === "string" ? value.description : "" }] : [];
      }) : [];
      return { id: this.stringAt(question, "id") ?? `question_${index + 1}`, header: this.stringAt(question, "header") ?? "问题", question: this.stringAt(question, "question") ?? "", options };
    });
  }

  /** Answers already given to the earlier questions of a multi-question request. */
  private userInputAnswers(nonce: string): string[] {
    try {
      const value = JSON.parse(this.db.getSetting(this.userInputAnswersKey(nonce)) ?? "[]") as unknown;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  }

  private liveUserInputRequest(nonce: string, openId: string, chatId: string): PendingServerRequest | null {
    const request = this.db.getServerRequest(nonce);
    return request?.type === "user_input" && request.status === "pending" && request.openId === openId && request.chatId === chatId
      && request.epoch === this.appServer?.appServerEpoch && request.expiresAt > Date.now() ? request : null;
  }

  /** Records one more answer; the last one submits every answer to Codex within the same turn. */
  private answerUserInput(request: PendingServerRequest, answers: string[], openId: string, chatId: string): CardDefinition {
    const questions = this.userInputQuestions(request);
    if (answers.length < questions.length) {
      this.db.setSetting(this.userInputAnswersKey(request.nonce), JSON.stringify(answers));
      return remoteQuestionCard(request.nonce, questions, answers.length);
    }
    const claimed = this.db.claimServerRequest(request.nonce, openId, chatId, this.appServer?.appServerEpoch ?? -1);
    if (!claimed) return errorCard("该 Codex 问题已过期或已被处理。");
    void this.resolveRemoteRequest(claimed, "accept", answers).catch((error) => this.db.recordFailure("remote_input", { nonce: claimed.nonce }, error));
    return remoteRequestResolvedCard("回答已提交", "Codex 正在本轮内继续处理。");
  }

  private async onAppServerNotification(message: JsonRpcMessage): Promise<void> {
    if (this.stopping) return;
    const params = this.asRecord(message.params); const method = message.method ?? "";
    const sessionId = this.stringAt(params, "threadId", "thread_id"); const turnId = notificationTurnId(params);
    if (method === "thread/name/updated" && sessionId) {
      const title = this.stringAt(params, "threadName", "thread_name", "name");
      if (title) { this.db.setSessionTitle(sessionId, title); const session = this.db.getSession(sessionId); if (session?.rootMessageId) await this.feishu.updateCard(session.rootMessageId, sessionCard(this.sessionView(session), this.turnCoordinator.hasActiveTurn(sessionId) ? "运行中" : "可继续")); }
      return;
    }
    if ((method === "thread/archived" || method === "thread/unarchived" || method === "thread/deleted") && sessionId) {
      const lifecycle = method === "thread/archived" ? "archived" : method === "thread/deleted" ? "deleted" : "active";
      if (this.db.getSession(sessionId)?.lifecycle !== "abandoned") this.db.setSessionLifecycle(sessionId, lifecycle); const session = this.db.getSession(sessionId);
      if (session?.rootMessageId) await this.feishu.updateCard(session.rootMessageId, sessionCard(this.sessionView(session), lifecycle === "active" ? "可继续" : lifecycle === "archived" ? "已归档" : "已删除"));
      return;
    }
    if (method === "turn/started" && sessionId && turnId) {
      const session = this.db.getSession(sessionId); if (!session?.rootMessageId) return;
      const current = this.turnCoordinator.mutableTurn(sessionId) ?? { sessionId, turnId, epoch: this.appServer?.appServerEpoch ?? 0, mode: session.collaborationMode === "plan" ? "plan" : "default", state: "running" as const, text: "", plan: "", rootMessageId: session.rootMessageId };
      current.turnId = turnId; this.turnCoordinator.setTurn(current); this.db.saveTurn(current); await this.updateRunCard(sessionId, session.rootMessageId, "运行中", "Codex 正在处理。", true); return;
    }
    if ((method === "item/agentMessage/delta" || method === "item/plan/delta") && sessionId && turnId) {
      const state = this.turnCoordinator.mutableTurn(sessionId); if (!state || state.turnId !== turnId) return;
      const delta = this.stringAt(params, "delta", "text") ?? ""; if (!delta) return;
      if (method.includes("plan")) state.plan = appendBoundedText(state.plan, delta, MAX_LIVE_TEXT_BYTES); else state.text = appendBoundedText(state.text, delta, MAX_LIVE_TEXT_BYTES);
      await this.flushTurnStream(state, method.includes("plan") ? "Plan" : "Codex"); return;
    }
    if ((method === "item/started" || method === "item/completed") && sessionId && turnId) {
      const item = this.asRecord(params.item); const itemId = this.stringAt(item, "id") ?? this.stringAt(params, "itemId") ?? turnId + ":" + method; const kind = this.stringAt(item, "type") ?? "unknown"; const status = this.stringAt(item, "status") ?? (method === "item/completed" ? "completed" : "inProgress");
      const text = kind === "agentMessage" && method === "item/completed" ? this.stringAt(item, "text") : null;
      this.db.saveTurnItem(turnId, itemId, kind, status, text ? { ...item, assistantTextHash: textHash(text) } : item);
      if (text) {
        const state = this.turnCoordinator.mutableTurn(sessionId);
        if (state?.turnId === turnId) {
          state.agentMessages ??= {};
          state.agentMessages[itemId] = text;
          state.text = appendBoundedText("", Object.values(state.agentMessages).join("\n\n"), MAX_LIVE_TEXT_BYTES);
          this.db.saveTurn(state);
        }
      }
      return;
    }
    if (method === "serverRequest/resolved") {
      // JSON-RPC ids may be numbers or strings.
      const rawId = params.requestId ?? params.request_id;
      const requestId = typeof rawId === "string" || typeof rawId === "number" ? rawId : null; if (requestId === null) return;
      for (const request of this.db.resolveServerRequestsByRpcId(requestId, this.appServer?.appServerEpoch ?? -1)) {
        // Codex no longer waits for this request; its pending answer is settled so nothing is left waiting.
        this.approvalService.take(request.nonce)?.({ action: "cancel", decision: "cancel" });
        if (request.cardMessageId) await this.feishu.updateCard(request.cardMessageId, remoteRequestResolvedCard("Codex 请求已处理", "该请求已完成或已由 Codex 清理。"));
      }
      return;
    }
    if (method === "turn/completed" && sessionId && turnId) {
      const state = this.turnCoordinator.mutableTurn(sessionId); if (!state || state.turnId !== turnId) return; const turn = this.asRecord(params.turn); const status = this.stringAt(turn, "status") ?? this.stringAt(params, "status") ?? "completed";
      state.state = status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed"; state.endedAtMs = Date.now(); state.finalOutputHash = textHash(state.plan || state.text); this.db.saveTurn(state);
      const cancelTimer = this.cancelTimers.get(turnId); if (cancelTimer) { clearTimeout(cancelTimer); this.cancelTimers.delete(turnId); }
      this.cancelRequestedAt.delete(turnId);
      // How the turn ended, fixed before anything is awaited: a cancel arriving meanwhile must not change it.
      const ended = state.state;
      const task = this.db.taskForTurn(turnId); if (task) this.db.transitionTask(task.id, state.state === "completed" ? "completed" : state.state === "interrupted" ? "interrupted" : "failed", { terminalReason: "turn " + state.state }); await this.cleanupTurnImages(turnId);
      // The output is stored before it is sent, so a failed or interrupted send can be repeated without running anything.
      let output: TurnOutput | null = null;
      try {
        this.storeTurnOutput(state, ended === "completed" ? "Codex 已完成" : "Codex " + ended);
        output = await this.deliverTurnOutput(turnId, state.stream);
      } catch (error) { this.db.recordFailure("finish_turn_stream", { turnId }, error); }
      finally { this.turnCoordinator.deleteTurn(sessionId); }
      const executed = ended === "completed" ? "完成" : ended === "interrupted" ? "已取消" : "失败";
      const report = this.deliveryReport(output, executed, ended === "completed" ? "本轮已完成。" : "本轮未完成。");
      void this.updateRunCard(sessionId, state.rootMessageId, report.state, report.detail, false, report.resendTurnId).catch((error) => this.db.recordFailure("turn_completion_card", { turnId }, error));
      // The run card is shared with later turns; the resend button also stays in a notice of its own.
      void this.noteDeliveryOutcome(output, report).catch((error) => this.db.recordFailure("output_notice", { turnId }, error));
      await this.releaseThreadSubscription(sessionId, "turn_completed"); void this.drainTaskQueue(sessionId);
    }
  }

  private async flushTurnStream(state: TurnState, title: string): Promise<void> {
    const content = state.plan || state.text;
    if (!content || Date.now() - (state.stream?.lastSentAt ?? 0) < STREAM_INTERVAL_MS) return;
    const preview = inlinePreview(content);
    if (!state.stream && this.feishu.createStreamingReply) { try { const created = await this.feishu.createStreamingReply(state.rootMessageId, title); state.stream = { ...created, lastSentAt: 0 }; } catch (error) { this.db.recordFailure("cardkit_stream", { sessionId: state.sessionId }, error); return; } }
    if (state.stream && this.feishu.updateStreamingReply) { state.stream.sequence = await this.feishu.updateStreamingReply(state.stream, preview); state.stream.lastSentAt = Date.now(); this.db.saveTurn(state); }
  }

  /** The whole output of a turn: the plan, else every finished message (the live text may have been shortened). */
  private fullOutput(state: TurnState): string {
    if (state.plan) return state.plan;
    const messages = Object.values(state.agentMessages ?? {});
    return messages.length ? messages.join("\n\n") : state.text;
  }

  /** Keeps a finished (or abandoned) turn's output until Feishu has it. */
  private storeTurnOutput(state: TurnState, summary: string): void {
    const content = this.fullOutput(state);
    if (!content) return;
    this.db.saveTurnOutput({ turnId: state.turnId, sessionId: state.sessionId, rootMessageId: state.rootMessageId, title: "Codex", summary, content,
      needsFile: inlinePreview(content) !== content });
    this.db.upsertAppServerDelivery({ sessionId: state.sessionId, turnId: state.turnId, role: "assistant", startedAtMs: state.startedAtMs ?? null,
      endedAtMs: state.endedAtMs ?? null, contentHash: textHash(content), contentBytes: Buffer.byteLength(content, "utf8") });
  }

  /**
   * Sends what of a stored output has not reached Feishu yet: the card and, for long text, the
   * full Markdown file, each tried on its own. Nothing is run again. Repeats within an hour are
   * dropped by Feishu (same uuid); a lost response beyond that may still show the card twice.
   */
  private async deliverTurnOutput(turnId: string, stream?: TurnState["stream"]): Promise<TurnOutput | null> {
    const output = this.db.getTurnOutput(turnId);
    if (!output) {
      // Nothing to say, but a streaming card that was opened still has to be closed.
      if (stream && this.feishu.finishStreamingReply) await this.feishu.finishStreamingReply(stream, "Codex 已结束");
      return null;
    }
    const preview = inlinePreview(output.content);
    let cardStatus = output.cardStatus; let cardMessageId: string | null = null;
    let fileStatus = output.fileStatus; let fileMessageId: string | null = null;
    const errors: string[] = [];
    const outcome = (error: unknown) => isRetryableTransportError(error) ? "uncertain" as const : "failed" as const;
    if (cardStatus !== "sent") {
      try {
        if (stream && cardStatus === "pending" && this.feishu.updateStreamingReply && this.feishu.finishStreamingReply) {
          if (preview) stream.sequence = await this.feishu.updateStreamingReply(stream, preview);
          await this.feishu.finishStreamingReply(stream, output.summary);
          cardMessageId = stream.messageId;
        } else {
          cardMessageId = await this.feishu.replyCard(output.rootMessageId, assistantMarkdownCard(preview), { uuid: deliveryUuid(turnId, "card") });
        }
        cardStatus = "sent";
      } catch (error) { cardStatus = outcome(error); errors.push(`卡片：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (fileStatus !== "sent" && fileStatus !== "none") {
      try {
        fileMessageId = await this.feishu.replyFile(output.rootMessageId, `${output.sessionId.slice(0, 8)}-${turnId.slice(0, 12)}.md`, Buffer.from(output.content), { uuid: deliveryUuid(turnId, "file") });
        fileStatus = "sent";
      } catch (error) { fileStatus = outcome(error); errors.push(`附件：${error instanceof Error ? error.message : String(error)}`); }
    }
    this.db.updateTurnOutput(turnId, { cardStatus, cardMessageId, fileStatus, fileMessageId, error: errors.length ? errors.join("；").slice(0, 500) : null });
    const delivered = cardMessageId ?? output.cardMessageId;
    if (cardStatus === "sent" && delivered) {
      // The same text read back from the session log is recognised as already shown.
      this.db.upsertAppServerDelivery({ sessionId: output.sessionId, turnId, role: "assistant", contentHash: textHash(output.content), contentBytes: Buffer.byteLength(output.content, "utf8"), feishuMessageId: delivered });
      this.db.setTurnAssistantDelivery(turnId, delivered);
    }
    if (errors.length) this.db.recordFailure("turn_output_delivery", { turnId }, new Error(errors.join("; ")));
    else this.db.resolveFailure("turn_output_delivery", { turnId });
    return this.db.getTurnOutput(turnId);
  }

  /** The run card for a finished turn: how it ran, and whether its result reached Feishu. */
  private deliveryReport(output: TurnOutput | null, executed: string, detail: string): { state: string; detail: string; resendTurnId?: string } {
    if (!output) return { state: executed, detail };
    const missing = [output.cardStatus !== "sent" ? "回复卡片" : "", output.fileStatus !== "sent" && output.fileStatus !== "none" ? "完整内容附件" : ""].filter(Boolean);
    if (!missing.length) return { state: executed, detail };
    const uncertain = output.cardStatus === "uncertain" || output.fileStatus === "uncertain";
    return {
      state: "结果发送失败",
      detail: `Codex 本轮${executed === "完成" ? "已执行完成" : `结束（${executed}）`}，但${missing.join("和")}没有发到飞书${uncertain ? "（网络中断，可能已经发出）" : ""}。点“重发结果”只重新发送，不会再次执行任务。`,
      resendTurnId: output.turnId,
    };
  }

  /** How a stored turn ran, for reports about its output sent later. */
  private executedLabel(turnId: string): string {
    const state = this.db.getTurn(turnId)?.state;
    return state === "completed" ? "完成" : state === "failed" ? "失败" : "已中断";
  }

  /**
   * Sends outputs that have not reached Feishu: never tried (cut off by a restart) or, with `failed`,
   * also earlier failures, retried a few times at growing intervals. Each turn still missing its
   * result gets its own notice in the topic with a resend button, which no later status replaces.
   */
  private deliverPendingOutputs(includeFailed = false): Promise<void> {
    // One pass at a time, so a slow upload is not started twice by the periodic scan.
    this.outputDelivery ??= this.deliverOutputsOnce(includeFailed).finally(() => { this.outputDelivery = null; });
    return this.outputDelivery;
  }

  private async deliverOutputsOnce(includeFailed: boolean): Promise<void> {
    for (const pending of includeFailed ? this.db.undeliveredTurnOutputs(Date.now()) : this.db.pendingTurnOutputs()) {
      try {
        const output = await this.deliverTurnOutput(pending.turnId);
        const report = this.deliveryReport(output, this.executedLabel(pending.turnId), "本轮结果已补发。");
        await this.noteDeliveryOutcome(output, report);
      } catch (error) { this.db.recordFailure("turn_output_delivery", { turnId: pending.turnId }, error); }
    }
  }

  /** Posts (once) or settles the topic notice for a turn whose result did not reach Feishu. */
  private async noteDeliveryOutcome(output: TurnOutput | null, report: { state: string; detail: string; resendTurnId?: string }): Promise<void> {
    if (!output) return;
    const key = `output_notice.${output.turnId}`;
    const notice = this.db.getSetting(key);
    if (report.resendTurnId) {
      if (notice) return;
      try { this.db.setSetting(key, await this.feishu.replyCard(output.rootMessageId, runStatusCard(report.state, report.detail, false, output.sessionId, report.resendTurnId))); }
      catch (error) { this.db.recordFailure("output_notice", { turnId: output.turnId }, error); }
      return;
    }
    if (!notice) return;
    this.db.deleteSetting(key);
    await this.feishu.updateCard(notice, runStatusCard(report.state, "本轮结果已发到话题中。")).catch((error) => this.db.recordFailure("output_notice", { turnId: output.turnId }, error));
  }

  private cardStatus(): { paused: boolean; sessions: number; active: number; failures: number; queued: number; waiting: number; failedTasks: number; appServer?: string } {
    const counts = this.db.taskStateCounts();
    const health = this.appServer?.getHealth();
    return { paused: this.paused(), sessions: this.db.listSessions().length, active: counts.running ?? this.turnCoordinator.activeCount(),
      queued: (counts.pending ?? 0) + (counts.authorized ?? 0) + (counts.thread_created ?? 0), waiting: (counts.awaiting_root_consent ?? 0) + (counts.awaiting_input ?? 0) + (counts.awaiting_approval ?? 0) + (counts.awaiting_writer ?? 0) + (counts.awaiting_unarchive ?? 0) + (counts.creation_uncertain ?? 0) + (counts.creating_thread ?? 0),
      failedTasks: counts.failed ?? 0, failures: this.db.failureCount(), appServer: health ? `${health.state} / epoch ${health.epoch}` : "未启用" };
  }

  private async ensureControlCard(): Promise<void> {
    const chatId = this.boundChatId();
    const version = String(this.config.cardUiVersion ?? 1);
    if (!chatId) return;
    if (this.db.getSetting("feishu.control_card_id") && this.db.getSetting("feishu.control_card_ui_version") === version) {
      this.db.resolveFailure("control_card", {});
      return;
    }
    try {
      const id = await this.feishu.sendCard(chatId, homeCard(this.cardStatus(), "按钮控制台已启用"));
      this.db.setSetting("feishu.control_card_id", id);
      this.db.setSetting("feishu.control_card_ui_version", version);
      this.db.resolveFailure("control_card", {});
    } catch (error) { this.db.recordFailure("control_card", {}, error); }
  }

  private formValue(event: IncomingCardAction, name: string): string {
    const value = event.formValues[name];
    return typeof value === "string" ? value.trim() : "";
  }

  private async updateRunCard(sessionId: string, rootId: string, state: string, detail: string, cancellable = false, resendTurnId?: string): Promise<void> {
    const previous = this.db.getRunStatus(sessionId);
    const card = runStatusCard(state, detail, cancellable, sessionId, resendTurnId);
    if (previous?.messageId && (["完成", "失败", "已取消", "结果发送失败", "取消失败"].includes(state) || Date.now() - previous.updatedAtMs >= 1_000)) {
      try { await this.feishu.updateCard(previous.messageId, card); this.db.setRunStatus(sessionId, state, detail); return; }
      catch (error) {
        this.db.recordFailure("status_card_patch", { sessionId }, error);
        const replacementId = await this.feishu.replyCard(rootId, card);
        this.db.setRunStatus(sessionId, state, detail, replacementId);
        return;
      }
    }
    if (!previous?.messageId) {
      const messageId = await this.feishu.replyCard(rootId, card);
      this.db.setRunStatus(sessionId, state, detail, messageId);
      return;
    }
    this.db.setRunStatus(sessionId, state, detail);
  }

  private async backfillSessionLinks(): Promise<void> {
    if (this.messageLinkPermissionDenied) return;
    for (const session of this.db.listSessions()) {
      if (!session.rootMessageId || session.rootAppLink) continue;
      try {
        const metadata = await this.feishu.getMessageMetadata(session.rootMessageId);
        const chatId = metadata?.chatId ?? session.chatId;
        const link = metadata?.appLink ?? (chatId ? messageAppLink(chatId, session.rootMessageId) : null);
        if (link) {
          this.db.setSessionRoot(session.sessionId, session.rootMessageId, link, chatId, metadata?.threadId ?? null);
          this.db.resolveFailure("message_link", { sessionId: session.sessionId });
        }
      } catch (error) {
        if (this.isMessageLinkPermissionError(error)) {
          this.messageLinkPermissionDenied = true;
          this.db.recordFailure("message_link_permission", {}, error);
          console.warn("Feishu message-read permission is missing; recent-session links will use short session IDs until it is granted.");
          return;
        }
        this.db.recordFailure("message_link", { sessionId: session.sessionId }, error);
      }
    }
  }

  private isMessageLinkPermissionError(error: unknown): boolean {
    return /(im:message:readonly|im:message\.group_msg|im:message|99991672|230027|access denied)/i.test(String(error));
  }

  private wizardKey(openId: string, mode: "new" | "session" = "new"): string { return `wizard.${mode}.${openId}`; }

  private pendingModelKey(sessionId: string): string { return `session.${sessionId}.pending_model`; }

  private choiceKey(sessionId: string): string { return `choice.${sessionId}`; }

  private promptKey(sessionId: string, prompt: string): string { return `prompt.${sessionId}.${textHash(prompt.trim())}`; }

  /** Marks text that is already visible in the topic so its JSONL copy is not posted again. */
  private queuePendingPrompt(sessionId: string, prompt: string, feishuMessageId: string): void {
    const key = this.promptKey(sessionId, prompt);
    const raw = this.db.getSetting(key);
    let pending: Array<{ messageId: string; expiresAt: number }> = [];
    try { if (raw) pending = JSON.parse(raw) as typeof pending; } catch { /* replace malformed state */ }
    pending = pending.filter((item) => item.expiresAt > Date.now());
    pending.push({ messageId: feishuMessageId, expiresAt: Date.now() + INBOUND_MIRROR_TTL_MS });
    this.db.setSetting(key, JSON.stringify(pending));
  }

  /** Withdraws a marker when Codex rejected the input, so a later identical message is still shown. */
  private dropPendingPrompt(sessionId: string, prompt: string, feishuMessageId: string): void {
    const key = this.promptKey(sessionId, prompt);
    const raw = this.db.getSetting(key);
    if (!raw) return;
    try {
      const pending = (JSON.parse(raw) as Array<{ messageId: string; expiresAt: number }>)
        .filter((item) => item.expiresAt > Date.now() && item.messageId !== feishuMessageId);
      if (pending.length) this.db.setSetting(key, JSON.stringify(pending)); else this.db.deleteSetting(key);
    } catch { this.db.deleteSetting(key); }
  }

  private consumePendingPrompt(sessionId: string, prompt: string): string | null {
    const key = this.promptKey(sessionId, prompt);
    const raw = this.db.getSetting(key);
    if (!raw) return null;
    try {
      const pending = (JSON.parse(raw) as Array<{ messageId: string; expiresAt: number }>).filter((item) => item.expiresAt > Date.now());
      const first = pending.shift();
      if (pending.length) this.db.setSetting(key, JSON.stringify(pending)); else this.db.deleteSetting(key);
      return first?.messageId ?? null;
    } catch { this.db.deleteSetting(key); return null; }
  }

  private savePendingChoice(state: PendingChoiceState): void {
    this.db.enqueueChoice(state.request.id, state.request.sessionId, JSON.stringify(state));
    this.db.setSetting(this.choiceKey(state.request.sessionId), JSON.stringify(state));
  }

  private getPendingChoice(sessionId: string): PendingChoiceState | null {
    const queued = this.db.nextChoice(sessionId);
    if (queued) {
      try {
        const state = JSON.parse(queued.payload) as PendingChoiceState;
        if (state.request.expiresAt > Date.now() && state.request.questions[state.questionIndex]) return state;
      } catch { /* stale/corrupt queue item is removed below */ }
      this.db.deleteChoice(queued.requestId);
    }
    const key = this.choiceKey(sessionId);
    const raw = this.db.getSetting(key);
    if (!raw) return null;
    try {
      const state = JSON.parse(raw) as PendingChoiceState;
      if (state.request.expiresAt > Date.now() && state.request.questions[state.questionIndex]) return state;
    } catch { /* clear malformed state below */ }
    this.db.deleteSetting(key);
    return null;
  }

  private answerPendingChoice(state: PendingChoiceState, answer: string): { complete: boolean; prompt?: string } {
    const question = state.request.questions[state.questionIndex]!;
    state.answers.push(answer);
    state.questionIndex += 1;
    if (state.questionIndex < state.request.questions.length) {
      this.savePendingChoice(state);
      return { complete: false };
    }
    this.db.deleteChoice(state.request.id);
    this.db.deleteSetting(this.choiceKey(state.request.sessionId));
    return { complete: true, prompt: state.request.questions.map((item, index) =>
      `问题：${item.question}\n我的回答：${state.answers[index] ?? ""}`).join("\n\n") };
  }

  private pendingChoices(sessionId: string): PendingChoiceState[] {
    const states = new Map<string, PendingChoiceState>();
    for (const raw of [...this.db.listChoices(sessionId).map((row) => row.payload), this.db.getSetting(this.choiceKey(sessionId))]) {
      if (!raw) continue;
      try {
        const state = JSON.parse(raw) as PendingChoiceState;
        if (typeof state.request?.id === "string") states.set(state.request.id, state);
      } catch { /* getPendingChoice removes malformed entries */ }
    }
    return [...states.values()];
  }

  private closePendingChoice(sessionId: string, requestId: string): void {
    this.db.deleteChoice(requestId);
    const raw = this.db.getSetting(this.choiceKey(sessionId));
    let current: string | undefined;
    try { current = raw ? (JSON.parse(raw) as PendingChoiceState).request?.id : undefined; } catch { current = requestId; }
    if (current === requestId) this.db.deleteSetting(this.choiceKey(sessionId));
  }

  private choiceTaskPrefix(sessionId: string): string { return `choice_task.${sessionId}.`; }

  /**
   * Closes question cards that another frontend already handled, and withdraws a
   * queued Feishu answer when the terminal answered first or moved on locally.
   */
  private async settleChoices(sessionId: string, rootId: string, answeredCallIds: ReadonlySet<string>, latestUserAtMs: number, latestLocalUserAtMs: number): Promise<void> {
    for (const state of this.pendingChoices(sessionId)) {
      if (!answeredCallIds.has(state.request.id) && !(latestUserAtMs > Date.parse(state.request.timestamp))) continue;
      this.closePendingChoice(sessionId, state.request.id);
      const cardMessageId = this.db.getMessage(state.request.id)?.feishuMessageId;
      if (cardMessageId) await this.feishu.updateCard(cardMessageId, choiceResolvedElsewhereCard()).catch((error) => this.db.recordFailure("choice_settled_card", { sessionId }, error));
    }
    for (const { key, value } of this.db.listSettings(this.choiceTaskPrefix(sessionId))) {
      let link: { taskId?: unknown; requestId?: unknown; timestamp?: unknown } = {};
      try { link = JSON.parse(value) as typeof link; } catch { /* malformed links are dropped below */ }
      const task = typeof link.taskId === "string" ? this.db.getTask(link.taskId) : null;
      // Only an answer that has not started yet can be withdrawn; other links are stale.
      if (!task || (task.status !== "pending" && task.status !== "awaiting_writer") || typeof link.requestId !== "string" || typeof link.timestamp !== "string") {
        this.db.deleteSetting(key);
        continue;
      }
      if (!answeredCallIds.has(link.requestId) && !(latestLocalUserAtMs > Date.parse(link.timestamp))) continue;
      this.db.deleteSetting(key);
      await this.taskScheduler.cancel({ kind: "task", taskId: task.id }, "question was handled in another Codex frontend");
      await this.updateRunCard(sessionId, rootId, "已取消", "这个问题已在终端处理，你在飞书里的回答没有发送。", false);
    }
  }

  private optionAnswer(state: PendingChoiceState, value: unknown): string | null {
    const question = state.request.questions[state.questionIndex];
    const index = typeof value === "number" ? value : Number(value);
    return question && Number.isInteger(index) && index >= 0 && index < question.options.length
      ? question.options[index]!.label : null;
  }

  private requestContainsSecret(params: Record<string, unknown>): boolean {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    return questions.some((question) => this.asRecord(question).isSecret === true);
  }

  private remoteRequestTitle(type: RemoteRequestType): string {
    return ({ user_input: "Codex 等待你的输入", command_approval: "Codex 请求执行命令", file_approval: "Codex 请求修改文件", permissions: "Codex 请求额外权限", mcp_elicitation: "MCP 请求你的确认" } as const)[type];
  }

  private remoteRequestDetail(type: RemoteRequestType, params: Record<string, unknown>): string {
    if (type === "command_approval") return "命令：" + (this.stringAt(params, "commandSummary") ?? "未提供") + "\n原因：" + (this.stringAt(params, "reason") ?? "未提供");
    if (type === "file_approval") return "原因：" + (this.stringAt(params, "reason") ?? "未提供") + "\n影响路径：" + (Array.isArray(params.relativePaths) ? params.relativePaths.join(", ") : "未提供");
    if (type === "permissions") return "权限类型：" + (Array.isArray(params.permissionKinds) ? params.permissionKinds.join(", ") : "未提供") + "\n原因：" + (this.stringAt(params, "reason") ?? "未提供");
    if (type === "mcp_elicitation") return (this.stringAt(params, "mcpServer") ?? "MCP") + "\n需要确认";
    const questions = Array.isArray(params.questions) ? params.questions.map((q) => this.asRecord(q)).map((q) => (this.stringAt(q, "header") ?? "问题") + "：" + (this.stringAt(q, "question") ?? "")).join("\n") : "需要输入";
    return questions;
  }


  private getWizard(openId: string, mode: "new" | "session" = "new"): WizardState | null {
    const raw = this.db.getSetting(this.wizardKey(openId, mode));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<WizardState>;
      if ((value.mode === "new" || value.mode === "session") && typeof value.id === "string" &&
        typeof value.chatId === "string" && typeof value.expiresAt === "number" && value.expiresAt > Date.now()) {
        return value as WizardState;
      }
    } catch { /* clear malformed state below */ }
    this.db.deleteSetting(this.wizardKey(openId, mode));
    return null;
  }

  private saveWizard(openId: string, wizard: WizardState): WizardState {
    const next = { ...wizard, expiresAt: Date.now() + PENDING_PROMPT_TTL_MS };
    this.db.setSetting(this.wizardKey(openId, wizard.mode), JSON.stringify(next));
    return next;
  }

  private beginNewWizard(openId: string, chatId: string, partial: Partial<WizardState> = {}): WizardState {
    return this.saveWizard(openId, {
      id: randomUUID(), mode: "new", chatId, expiresAt: 0, ...this.newModelDefaults(), ...partial,
    });
  }

  private newModelDefaults(): Partial<WizardState> {
    const model = this.modelBySlug(this.config.defaultNewModel);
    const effort = this.config.defaultNewReasoningEffort;
    if (!model || !effort || !model.supportedReasoningEfforts.includes(effort)) return {};
    return { model: model.slug, reasoningEffort: effort };
  }

  private validWizard(openId: string, event: IncomingCardAction, expected?: "new" | "session"): WizardState | null {
    const requested = event.value.wizardMode === "session" || event.value.wizardMode === "new" ? event.value.wizardMode : undefined;
    const mode = expected ?? requested ?? (this.db.getSessionByRoot(event.openMessageId) ? "session" : "new");
    const wizard = this.getWizard(openId, mode);
    const wizardId = typeof event.value.wizardId === "string" ? event.value.wizardId : "";
    if (!wizard || wizard.id !== wizardId || wizard.chatId !== event.chatId || wizard.mode !== mode) return null;
    return wizard;
  }

  private projectCard(wizard: WizardState, search = ""): CardDefinition {
    const directories = this.db.listRecentDirectories(50).filter((item) => !search || item.cwd.toLowerCase().includes(search.toLowerCase()));
    return projectsCard(directories, this.config.allowedRoot, wizard.id, search);
  }

  private recentCard(search = "", page = 0): CardDefinition {
    const sessions = this.db.listRecentSessions(8, search, page * 8);
    return recentSessionsCard(sessions, search, page, this.db.hasMoreRecentSessions(search, page * 8, sessions.length));
  }

  async onCardAction(event: IncomingCardAction): Promise<CardActionOutcome> {
    const eventId = "card:" + (event.eventId ?? createHash("sha256").update(JSON.stringify({ action: event.action, value: event.value, formValues: event.formValues, chat: event.chatId, message: event.openMessageId, operator: event.openId })).digest("hex"));
    if (!this.db.claimInboundEvent(eventId)) return { delivery: "replace", card: errorCard("该操作已处理、过期或正在处理中。") };
    const claimToken = this.db.inboundClaimToken(eventId);
    // Call the implementation explicitly so a compatibility facade that
    // owns `handleCardAction` cannot route this wrapper back into itself.
    try { const outcome = await SyncRuntime.prototype.handleCardAction.call(this, event); this.db.completeInboundEvent(eventId, claimToken); return outcome; }
    catch (error) { this.db.failInboundEvent(eventId, error, isRetryableTransportError(error), claimToken); throw error; }
  }

  /** The session a button names; copies of a root card further down its topic carry it. */
  private sessionFromCard(event: IncomingCardAction): ReturnType<BridgeDatabase["getSessionByRoot"]> {
    const sessionId = typeof event.value.sessionId === "string" ? event.value.sessionId : "";
    const session = sessionId ? this.db.getSession(sessionId) : null;
    return session?.rootMessageId ? this.db.getSessionByRoot(session.rootMessageId) : null;
  }

  async handleCardAction(event: IncomingCardAction): Promise<CardActionOutcome> {
    if (event.openId !== this.boundOpenId() || event.chatId !== this.boundChatId()) return { delivery: "none" };
    try {
      const rootCardSession = this.db.getSessionByRoot(event.openMessageId);
      if (rootCardSession && !["session_model", "session_status", "session_toggle_mode", "cancel_run", "root_grant", "root_grant_confirm", "root_grant_cancel", "root_revoke", "turn_review", "remote_approve", "remote_answer", "remote_guidance", "unarchive_confirm", "unarchive_cancel"].includes(event.action)) {
        return { delivery: "reply", rootMessageId: rootCardSession.rootMessageId,
          card: errorCard("此会话话题默认用于继续对话；新建、搜索和服务管理请在群主消息或控制台中操作。") };
      }
      switch (event.action) {
        case "choice_cancel": {
          const sessionId = typeof event.value.sessionId === "string" ? event.value.sessionId : "";
          const requestId = typeof event.value.requestId === "string" ? event.value.requestId : "";
          const state = this.getPendingChoice(sessionId);
          if (!state || state.request.id !== requestId) return errorCard("该选择已过期或已关闭。");
          this.db.deleteChoice(requestId);
          this.db.deleteSetting(this.choiceKey(sessionId));
          return { delivery: "replace", card: choiceCancelledCard() };
        }
        case "choice_answer": {
          if (this.paused()) return errorCard("同步当前已暂停；恢复同步后再提交选择。");
          const sessionId = typeof event.value.sessionId === "string" ? event.value.sessionId : "";
          const requestId = typeof event.value.requestId === "string" ? event.value.requestId : "";
          const state = this.getPendingChoice(sessionId);
          if (!state || state.request.id !== requestId) return errorCard("该选择已过期，请在话题内重新询问 Codex。");
          if (Number(event.value.questionIndex) !== state.questionIndex) return errorCard("该问题已经回答，请使用最新选择卡片。");
          const answer = this.optionAnswer(state, event.value.optionIndex ?? event.option);
          if (!answer) return errorCard("选项无效，请使用最新选择卡片。");
          const result = this.answerPendingChoice(state, answer);
          if (!result.complete) return { delivery: "replace", card: choiceCard(state.request, state.questionIndex) };
          void this.resumeFromChoice(state, result.prompt!, event.openMessageId);
          return { delivery: "replace", card: choiceAcceptedCard(answer, true) };
        }
        case "home": return { delivery: "replace", card: homeCard(this.cardStatus()) };
        case "service": return { delivery: "replace", card: serviceCard(this.cardStatus()) };
        case "help": return { delivery: "replace", card: helpCard() };
        case "command_menu": return { delivery: "replace", card: commandMenuCard() };
        case "search_open": return { delivery: "replace", card: this.recentCard() };
        case "new":
          if (this.paused()) return errorCard("同步当前已暂停；恢复同步后再新建会话。");
          if (!this.models.length) return errorCard("模型目录暂不可用。请使用 /retry 刷新后再新建会话。");
          return { delivery: "replace", card: this.projectCard(this.beginNewWizard(event.openId, event.chatId)) };
        case "projects": {
          if (this.paused()) return errorCard("同步当前已暂停；恢复同步后再新建会话。");
          const wizard = this.getWizard(event.openId) ?? this.beginNewWizard(event.openId, event.chatId);
          return { delivery: "replace", card: this.projectCard(wizard) };
        }
        case "recent": return { delivery: "replace", card: this.recentCard() };
        case "search_sessions": return { delivery: "replace", card: this.recentCard(this.formValue(event, "session_search"), 0) };
        case "recent_page": return { delivery: "replace", card: this.recentCard(typeof event.value.search === "string" ? event.value.search : "", Math.max(0, Number(event.value.page) || 0)) };
        case "search_projects": {
          const wizard = this.validWizard(event.openId, event, "new");
          if (!wizard) return errorCard("项目选择已过期，请重新开始新建会话。");
          return { delivery: "replace", card: this.projectCard(this.saveWizard(event.openId, wizard), this.formValue(event, "project_path")) };
        }
        case "submit_project_path": {
          const wizard = this.validWizard(event.openId, event, "new");
          if (!wizard) return errorCard("项目选择已过期，请重新开始新建会话。");
          const entered = this.formValue(event, "project_path");
          if (!entered) return errorCard("请输入项目目录，或选择一个历史项目。");
          const cwd = await resolveAllowedPath(entered, this.config.allowedRoot);
          wizard.cwd = cwd; delete wizard.model; delete wizard.reasoningEffort;
          Object.assign(wizard, this.newModelDefaults());
          return { delivery: "replace", card: modelCard(this.models, this.saveWizard(event.openId, wizard).id, wizard.model, cwd, "new") };
        }
        case "select_project": {
          const wizard = this.validWizard(event.openId, event, "new");
          if (!wizard) return errorCard("该项目选择卡片已过期，请重新开始新建会话。");
          const cwd = typeof event.value.cwd === "string" ? event.value.cwd : "";
          wizard.cwd = await resolveAllowedPath(cwd, this.config.allowedRoot);
          delete wizard.model;
          delete wizard.reasoningEffort;
          Object.assign(wizard, this.newModelDefaults());
          const current = this.saveWizard(event.openId, wizard);
          if (!this.models.length) return errorCard("模型目录暂不可用。请使用 /retry 刷新后重新开始。 ");
          return { delivery: "replace", card: modelCard(this.models, current.id, current.model, current.cwd, "new") };
        }
        case "show_models": {
          const wizard = this.validWizard(event.openId, event);
          if (!wizard) return errorCard("该模型设置卡片已过期，请重新开始。 ");
          if (!this.models.length) return errorCard("模型目录暂不可用。请使用 /retry 刷新后重试。");
          return { delivery: "replace", card: modelCard(this.models, this.saveWizard(event.openId, wizard).id, wizard.model, wizard.cwd, wizard.mode) };
        }
        case "select_model": {
          const wizard = this.validWizard(event.openId, event);
          if (!wizard) return errorCard("该模型选择卡片已过期，请重新开始。 ");
          const model = this.modelBySlug(typeof event.value.model === "string" ? event.value.model : "");
          if (!model) return errorCard("该模型已不可用，请使用最新模型卡片重新选择。");
          wizard.model = model.slug;
          delete wizard.reasoningEffort;
          const defaults = wizard.mode === "new" ? this.newModelDefaults() : {};
          const displayModel = defaults.model === model.slug && defaults.reasoningEffort
            ? { ...model, defaultReasoningEffort: defaults.reasoningEffort } : model;
          return { delivery: "replace", card: reasoningEffortCard(displayModel, this.saveWizard(event.openId, wizard).id, wizard.cwd, wizard.mode) };
        }
        case "select_reasoning_effort": {
          const wizard = this.validWizard(event.openId, event);
          if (!wizard) return errorCard("该思考强度卡片已过期，请重新开始。 ");
          const model = this.modelBySlug(wizard.model);
          const effort = typeof event.value.effort === "string" ? event.value.effort : "";
          if (!model || !model.supportedReasoningEfforts.includes(effort)) return errorCard("模型或思考强度已不可用，请重新选择模型。");
          wizard.reasoningEffort = effort;
          const current = this.saveWizard(event.openId, wizard);
          if (current.mode === "session") {
            if (!current.sessionId) return errorCard("会话模型设置已失效。");
            this.db.setSessionModel(current.sessionId, model.slug, effort);
            this.db.deleteSetting(this.wizardKey(event.openId, current.mode));
            return sessionCard(this.sessionView({ ...this.db.getSession(current.sessionId)! }), "可继续");
          }
          if (!current.cwd) return errorCard("项目目录尚未选择，请重新开始。 ");
          if (current.prompt) {
            this.db.deleteSetting(this.wizardKey(event.openId, current.mode));
            void this.runNewSessionFromWizard(current);
            return homeCard(this.cardStatus(), `已提交新会话：${model.displayName} / ${effort}`);
          }
          return { delivery: "replace", card: wizardReadyCard(current.cwd, model, effort, current.id) };
        }
        case "await_chat_task": {
          const wizard = this.validWizard(event.openId, event, "new");
          if (!wizard || !wizard.cwd || !wizard.model || !wizard.reasoningEffort) return errorCard("任务向导已过期，请重新开始。");
          wizard.awaitingChatTask = true;
          this.saveWizard(event.openId, wizard);
          return { delivery: "send", card: homeCard(this.cardStatus(), "请在群主消息直接发送任务；当前向导将使用已选项目、模型和强度。") };
        }
        case "submit_task": {
          if (this.paused()) return errorCard("同步当前已暂停；恢复同步后再创建会话。");
          const wizard = this.validWizard(event.openId, event, "new");
          if (!wizard || !wizard.cwd || !wizard.model || !wizard.reasoningEffort) return errorCard("任务向导已过期，请重新开始。");
          const prompt = this.formValue(event, "task_prompt");
          if (!prompt) return errorCard("任务不能为空。请填写任务，或使用“在聊天中输入”。");
          this.db.deleteSetting(this.wizardKey(event.openId, wizard.mode));
          void this.runNewSessionFromWizard({ ...wizard, prompt, sourceMessageId: `card-${event.openMessageId}` });
          return { delivery: "replace", card: runStatusCard("已提交", "正在创建 Codex 会话。") };
        }
        case "session_model": {
          const root = this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId) ?? this.sessionFromCard(event);
          if (!root) return errorCard("请在对应会话话题内使用“修改模型”。");
          if (!this.models.length) return errorCard("模型目录暂不可用。请使用 /retry 刷新后重试。");
          const wizard = this.saveWizard(event.openId, { id: randomUUID(), mode: "session", chatId: event.chatId, rootId: root.rootMessageId, sessionId: root.sessionId, expiresAt: 0 });
          const card = modelCard(this.models, wizard.id, root.model ?? undefined, root.cwd, "session");
          if (root.rootMessageId === event.openMessageId) {
            return { delivery: "reply", rootMessageId: root.rootMessageId, card };
          }
          return { delivery: "replace", card };
        }
        case "session_status": {
          const session = this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId) ?? this.sessionFromCard(event);
          if (!session) return errorCard("请在对应会话话题内刷新状态。");
          const card = sessionCard(this.sessionView(session), this.turnCoordinator.hasActiveTurn(session.sessionId) ? "运行中" : "可继续");
          return event.openMessageId === session.rootMessageId ? { delivery: "replace", card } : { delivery: "reply", rootMessageId: session.rootMessageId, card };
        }
        case "session_toggle_mode": {
          const session = this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId) ?? this.sessionFromCard(event);
          if (!session) return errorCard("请在对应会话话题内切换模式。");
          if (this.turnCoordinator.hasActiveTurn(session.sessionId) || (session.rootMessageId && this.db.runningTaskForRoot(session.rootMessageId))) return errorCard("当前回合正在运行；请完成或取消后再切换模式。");
          const mode = session.collaborationMode === "plan" ? "default" : "plan";
          this.db.setCollaborationMode(session.sessionId, mode);
          const updated = this.db.getSession(session.sessionId)!;
          const card = sessionCard(this.sessionView(updated), this.turnCoordinator.hasActiveTurn(updated.sessionId) ? "运行中" : "可继续");
          return event.openMessageId === updated.rootMessageId ? { delivery: "replace", card } : { delivery: "reply", rootMessageId: updated.rootMessageId!, card };
        }
        case "resend_result": {
          const turnId = typeof event.value.turnId === "string" ? event.value.turnId : "";
          const stored = this.db.getTurnOutput(turnId);
          if (!stored) return errorCard("没有找到这一轮的结果，可能已超过保留期限（30 天）。");
          const executed = this.executedLabel(turnId);
          if (stored.cardStatus === "sent" && (stored.fileStatus === "sent" || stored.fileStatus === "none")) return { delivery: "replace", card: runStatusCard(executed, "本轮结果已在话题中。") };
          // Uploads can take longer than a card callback may; the card is updated when they are done.
          const clicked = event.openMessageId;
          void this.deliverTurnOutput(turnId).then(async (output) => {
            const report = this.deliveryReport(output, executed, "本轮结果已重新发送。");
            await this.feishu.updateCard(clicked, runStatusCard(report.state, report.detail, false, stored.sessionId, report.resendTurnId));
            await this.noteDeliveryOutcome(output, report);
          }).catch((error) => this.db.recordFailure("turn_output_resend", { turnId }, error));
          return { delivery: "replace", card: runStatusCard("正在重新发送", "正在把本轮结果重新发到话题中，不会再次执行任务。") };
        }
        case "cancel_run": {
          const sessionId = typeof event.value.sessionId === "string" ? event.value.sessionId : "";
          const session = this.db.getSession(sessionId) ?? this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId) ?? this.sessionFromCard(event);
          if (!session) return errorCard("当前会话没有可取消的桥接任务。");
          const outcome = await this.cancelSessionWork(session.sessionId, session.rootMessageId, "cancelled from card");
          const report = this.cancelReport(outcome);
          if (!report) return errorCard("当前会话没有可取消的桥接任务。");
          if (session.rootMessageId && report.update) void this.updateRunCard(session.sessionId, session.rootMessageId, report.state, report.detail, outcome.turn === "failed");
          // The clicked card is replaced with what is true now, which may already be the turn's end.
          const actual = report.update ? report : this.db.getRunStatus(session.sessionId) ?? report;
          const card = rootCardSession ? sessionCard(this.sessionView(rootCardSession), this.turnCoordinator.hasActiveTurn(rootCardSession.sessionId) ? "运行中" : "可继续") : runStatusCard(actual.state, actual.detail, outcome.turn === "failed" || outcome.turn === "uncertain", session.sessionId);
          return rootCardSession && event.openMessageId === rootCardSession.rootMessageId
            ? { delivery: "replace", card }
            : session.rootMessageId ? { delivery: "reply", rootMessageId: session.rootMessageId, card } : { delivery: "send", card };
        }
        case "unarchive_confirm": {
          const nonce = typeof event.value.nonce === "string" ? event.value.nonce : "";
          const task = this.db.getTaskByActionNonce(nonce);
          const epoch = Number(this.db.getSetting(`unarchive.${nonce}.epoch`) ?? -1);
          if (!task || !task.sessionId || task.chatId !== event.chatId || task.rootMessageId === null || this.db.getSetting(`unarchive.${nonce}.message`) !== event.openMessageId || task.status !== "awaiting_unarchive" || task.unarchiveApproved || epoch !== this.appServer?.appServerEpoch) return errorCard("该取消归档请求已过期、已处理或不属于当前会话。");
          const approved = this.db.approveUnarchive(nonce);
          if (!approved) return errorCard("该取消归档请求已被处理。");
          const completed = await this.finishApprovedUnarchive(approved);
          if (completed) { this.db.deleteSetting(`unarchive.${nonce}.epoch`); this.db.deleteSetting(`unarchive.${nonce}.message`); }
          return { delivery: "replace", card: remoteRequestResolvedCard(completed ? "已取消归档" : "已确认，等待重试", completed ? "原消息已重新排队。" : "app-server 暂时不可用；服务会继续恢复该请求。", completed) };
        }
        case "unarchive_cancel": {
          const nonce = typeof event.value.nonce === "string" ? event.value.nonce : "";
          const task = this.db.getTaskByActionNonce(nonce);
          const epoch = Number(this.db.getSetting(`unarchive.${nonce}.epoch`) ?? -1);
          if (!task || task.chatId !== event.chatId || task.rootMessageId === null || this.db.getSetting(`unarchive.${nonce}.message`) !== event.openMessageId || epoch !== this.appServer?.appServerEpoch || !this.db.cancelUnarchive(nonce)) return errorCard("该取消归档请求已过期或已处理。");
          this.db.deleteSetting(`unarchive.${nonce}.epoch`); this.db.deleteSetting(`unarchive.${nonce}.message`);
          return { delivery: "replace", card: remoteRequestResolvedCard("保持归档", "原消息已取消，不会执行。", false) };
        }
        case "root_grant": return errorCard("普通 workspace-write 回合不需要 Root 授权；Root 任务会单独显示一次性授权卡。");
        case "root_grant_confirm": {
          const nonce = typeof event.value.nonce === "string" ? event.value.nonce : "";
          const grant = this.appServer ? this.db.approveTaskRootGrant(nonce, event.openId, event.chatId, this.appServer.appServerEpoch) : null;
          if (!grant) return errorCard("该 Root 授权已过期、已处理或不属于当前用户/会话。");
          void this.drainTaskQueue(grant.sessionId);
          return { delivery: "replace", card: remoteRequestResolvedCard("已批准本任务", "授权已消费为下一次启动准备；不会保留为会话权限。") };
        }
        case "root_grant_cancel": {
          const nonce = typeof event.value.nonce === "string" ? event.value.nonce : "";
          const grant = this.appServer ? this.db.denyTaskRootGrant(nonce, event.openId, event.chatId, this.appServer.appServerEpoch) : null;
          if (!grant) return errorCard("该 Root 授权已过期、已处理或不属于当前用户/会话。");
          if (grant.sessionId) await this.cancelSessionWork(grant.sessionId, null, "Root authorization was declined");
          else await this.taskScheduler.cancel({ kind: "task", taskId: grant.taskId }, "Root authorization was declined");
          return { delivery: "replace", card: remoteRequestResolvedCard("Root 授权已拒绝", "该任务已取消；不会影响其他任务。", false) };
        }
        case "root_revoke": return errorCard("Root 授权是一次性任务授权，无会话级权限可撤销。");

        case "turn_review": {
          const session = this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId) ?? this.sessionFromCard(event);
          if (!session) return errorCard("当前会话不可用。");
          const turn = this.db.activeTurn(session.sessionId);
          const latest = turn ?? this.db.latestTurn(session.sessionId) ?? (this.turnCoordinator.mutableTurn(session.sessionId) ?? null);
          return { delivery: "reply", rootMessageId: session.rootMessageId, card: reviewCard(latest ? this.db.listTurnItems(latest.turnId) : []) };
        }
        case "remote_approve": {
          const nonce = typeof event.value.nonce === "string" ? event.value.nonce : "";
          const decision = typeof event.value.decision === "string" ? event.value.decision : "decline";
          const request = this.db.claimServerRequest(nonce, event.openId, event.chatId, this.appServer?.appServerEpoch ?? -1);
          if (!request) return errorCard("该 Codex 请求已过期、已处理或不属于当前用户。 ");
          void this.resolveRemoteRequest(request, decision).catch((error) => this.db.recordFailure("remote_request_response", { nonce }, error));
          return { delivery: "replace", card: remoteRequestResolvedCard("正在提交", "已向 Codex 提交你的决定。") };
        }
        case "remote_answer": {
          const nonce = typeof event.value.nonce === "string" ? event.value.nonce : "";
          const request = this.liveUserInputRequest(nonce, event.openId, event.chatId);
          if (!request) return errorCard("该 Codex 问题已过期、已回答或不属于当前用户。");
          const answers = this.userInputAnswers(nonce);
          if (Number(event.value.questionIndex) !== answers.length) return errorCard("该问题已经回答，请使用最新的问题卡片。");
          const option = this.userInputQuestions(request)[answers.length]?.options[Number(event.value.optionIndex ?? event.option)];
          if (!option) return errorCard("选项无效，请使用最新的问题卡片。");
          return { delivery: "replace", card: this.answerUserInput(request, [...answers, option.label], event.openId, event.chatId) };
        }
        case "remote_guidance": {
          const nonce = typeof event.value.nonce === "string" ? event.value.nonce : "";
          const request = this.db.getServerRequest(nonce);
          if (!request || request.status !== "pending" || request.openId !== event.openId || request.chatId !== event.chatId || request.epoch !== this.appServer?.appServerEpoch) return errorCard("该命令请求已过期。 ");
          this.db.setSetting(`guidance.${nonce}`, JSON.stringify({ sessionId: request.sessionId, expiresAt: request.expiresAt }));
          return { delivery: "replace", card: remoteRequestResolvedCard("告诉 Codex 怎么做", "请直接在当前话题回复替代做法；桥接器会先拒绝原命令，再将你的说明注入当前回合。") };
        }
        case "cancel_wizard":
          const wizard = this.validWizard(event.openId, event);
          if (!wizard) return errorCard("该向导已过期或已被替换。");
          this.db.deleteSetting(this.wizardKey(event.openId, wizard.mode));
          return homeCard(this.cardStatus(), "已取消新建向导");
        case "sync":
          void this.syncAll();
          return homeCard(this.cardStatus(), "已启动全量扫描");
        case "pause":
          this.db.setSetting("sync.paused", "1");
          return homeCard(this.cardStatus(), "同步已暂停");
        case "resume":
          this.db.setSetting("sync.paused", "0");
          void this.syncAll();
          return homeCard(this.cardStatus(), "同步已恢复");
        case "retry": {
          this.messageLinkPermissionDenied = false;
          const modelsReady = await this.refreshModels();
          let appServerReady = true;
          if (this.appServer && this.appServer.getHealth().state === "unhealthy") {
            try { await this.appServer.restart("manual retry"); } catch (error) { appServerReady = false; this.db.recordFailure("app_server_retry", {}, error); }
          }
          if (modelsReady && appServerReady) this.db.resolveInfrastructureFailures();
          void this.syncAll();
          void this.backfillSessionLinks();
          void this.deliverPendingOutputs(true);
          return homeCard(this.cardStatus(), modelsReady && appServerReady ? "正在重试未完成任务，模型目录和 app-server 已恢复" : "基础设施仍不可用；请稍后再次 /retry");
        }
        default: return errorCard(`未知卡片操作：${event.action}`);
      }
    } catch (error) {
      this.db.recordFailure("card_action", { action: event.action, openMessageId: event.openMessageId }, error);
      return errorCard(error instanceof Error ? error.message : String(error));
    }
  }

  async onFeishuMessage(message: IncomingFeishuMessage): Promise<void> {
    const eventId = "message:" + message.messageId;
    if (!this.db.claimInboundEvent(eventId)) return;
    const claimToken = this.db.inboundClaimToken(eventId);
    try {
      await this.handleFeishuMessage(message);
      this.db.saveMessage(message.messageId, "_control", "inbound", message.messageId);
      this.db.completeInboundEvent(eventId, claimToken);
    } catch (error) {
      this.db.failInboundEvent(eventId, error, isRetryableTransportError(error), claimToken);
      throw error;
    }
  }

  async handleMessage(message: IncomingFeishuMessage): Promise<void> { return this.onFeishuMessage(message); }

  private async handleFeishuMessage(message: IncomingFeishuMessage): Promise<void> {
    const chatId = this.boundChatId();
    const openId = this.boundOpenId();
    if (!chatId) {
      if (message.chatType === "group" && !message.mentionedBot) return;
      if (message.text === `/bind ${this.config.bindToken}`) {
        this.db.setSetting("feishu.chat_id", message.chatId);
        this.db.setSetting("feishu.open_id", message.senderOpenId);
        this.db.setSetting("feishu.bound_at", new Date().toISOString());
        await this.feishu.sendText(message.chatId, "绑定成功。历史会话开始后台同步；绑定码已失效。");
        await this.ensureControlCard();
        void this.syncAll();
      }
      return;
    }
    if (message.chatId !== chatId || message.senderOpenId !== openId) return;
    const command = message.text.trim();
    const normalized = command.toLowerCase();
    const sessionInTopic = message.rootId ? this.db.getSessionByRoot(message.rootId) : null;
    const slashCommand = !sessionInTopic && command.startsWith("/");
    if (message.chatType === "group" && !message.mentionedBot && !sessionInTopic && !slashCommand) return;
    // Plain-word shortcuts are bridge commands only in the group's main timeline.
    // Inside a mapped session topic every non-slash message belongs to Codex, as
    // it would in the terminal; only explicit slash commands reach the bridge.
    const isCommand = (slash: readonly string[], words: readonly string[] = []) =>
      slash.includes(normalized) || (!sessionInTopic && words.includes(normalized));
    if (normalized === "/" && sessionInTopic) {
      // The session's root card again at the bottom of the topic, so a long topic need not be scrolled back up.
      await this.respondCard(message, sessionCard(this.sessionView(sessionInTopic), this.turnCoordinator.hasActiveTurn(sessionInTopic.sessionId) ? "运行中" : "可继续"));
      return;
    }
    if (normalized === "/") { await this.respondCard(message, commandMenuCard()); return; }
    if (isCommand(["/help"], ["help", "帮助", "?", "？"])) { await this.respondCard(message, helpCard()); return; }
    if (isCommand(["/home"], ["控制台"])) { await this.respondCard(message, homeCard(this.cardStatus())); return; }
    if (!sessionInTopic && ["新建", "/new"].includes(normalized)) {
      await this.respondCard(message, this.projectCard(this.beginNewWizard(message.senderOpenId, message.chatId)));
      return;
    }
    if (!sessionInTopic && ["项目", "/projects"].includes(normalized)) {
      await this.respondCard(message, this.projectCard(this.beginNewWizard(message.senderOpenId, message.chatId)));
      return;
    }
    if (isCommand(["/sessions"], ["会话", "最近"])) { await this.respondCard(message, this.recentCard()); return; }
    if (normalized === "/search" || normalized.startsWith("/search ")) {
      const query = [...command.slice(7).trim()].slice(0, 120).join("");
      await this.respondCard(message, this.recentCard(query));
      return;
    }
    if (isCommand(["/status"], ["状态"])) { await this.respondCard(message, homeCard(this.cardStatus())); return; }
    if (isCommand(["/sync"], ["同步"])) {
      await this.respondCard(message, homeCard(this.cardStatus(), "已启动全量扫描"));
      void this.syncAll();
      return;
    }
    if (isCommand(["/pause"], ["暂停"])) {
      this.db.setSetting("sync.paused", "1");
      await this.respondCard(message, homeCard(this.cardStatus(), "同步已暂停"));
      return;
    }
    if (isCommand(["/resume-sync"], ["恢复"])) {
      this.db.setSetting("sync.paused", "0");
      await this.respondCard(message, homeCard(this.cardStatus(), "同步已恢复"));
      void this.syncAll();
      return;
    }
    if (isCommand(["/retry"], ["重试"])) {
      this.messageLinkPermissionDenied = false;
      const modelsReady = await this.refreshModels();
      let appServerReady = true;
      if (this.appServer && this.appServer.getHealth().state === "unhealthy") {
        try { await this.appServer.restart("manual retry"); } catch (error) { appServerReady = false; this.db.recordFailure("app_server_retry", {}, error); }
      }
      if (modelsReady && appServerReady) this.db.resolveInfrastructureFailures();
      await this.respondCard(message, homeCard(this.cardStatus(), modelsReady && appServerReady ? "正在重试未完成任务，模型目录和 app-server 已恢复" : "基础设施仍不可用；请稍后再次 /retry"));
      void this.syncAll();
      void this.backfillSessionLinks();
      void this.deliverPendingOutputs(true);
      return;
    }
    if (isCommand(["/cancel"], ["取消"])) {
      if (!sessionInTopic && this.getWizard(message.senderOpenId)) {
        this.db.deleteSetting(this.wizardKey(message.senderOpenId, "new"));
        await this.respondCard(message, homeCard(this.cardStatus(), "已取消新建向导"));
        return;
      }
      if (message.rootId) {
        const session = this.db.getSessionByRoot(message.rootId);
        if (session && this.getPendingChoice(session.sessionId)) {
          const pending = this.getPendingChoice(session.sessionId);
          if (pending) this.db.deleteChoice(pending.request.id);
          this.db.deleteSetting(this.choiceKey(session.sessionId));
          await this.respondCard(message, choiceCancelledCard());
          return;
        }
      }
      return this.cancel(message);
    }
    if (command === "/model" || (!sessionInTopic && command === "模型")) {
      await this.startSessionModelWizard(message);
      return;
    }
    if (command.startsWith("/model ")) {
      await this.setSessionModelFromText(message, command);
      return;
    }
    if (command.startsWith("/new ")) {
      if (sessionInTopic) {
        await this.respond(message, "当前话题默认继续该 Codex 会话。请在群主消息使用 /new <目录> <提示> 新建会话。");
        return;
      }
      return this.newSession(message, command);
    }
    if (command.startsWith("/")) {
      await this.respondCard(message, commandMenuCard(`未知命令：${shortText(command, 40)}`));
      return;
    }
    const wizard = this.getWizard(message.senderOpenId, "new");
    if (!sessionInTopic && wizard?.awaitingChatTask && command) {
      if (wizard.mode !== "new" || !wizard.cwd || !wizard.model || !wizard.reasoningEffort) {
        await this.respond(message, "请先完成项目、模型和思考强度选择，或发送 /cancel 取消当前向导。");
        return;
      }
      this.db.deleteSetting(this.wizardKey(message.senderOpenId, "new"));
      return this.runNewSession(message, wizard.cwd, command, wizard.model, wizard.reasoningEffort, message.imageKeys);
    }
    if (message.rootId) {
      const session = this.db.getSessionByRoot(message.rootId);
      const guidanceRequest = session ? this.db.nextServerRequest(session.sessionId, "command_approval") : null;
      if (guidanceRequest && command && this.db.getSetting(`guidance.${guidanceRequest.nonce}`)) {
        const claimed = this.db.claimServerRequest(guidanceRequest.nonce, message.senderOpenId, message.chatId, this.appServer?.appServerEpoch ?? -1);
        if (claimed) {
          this.db.deleteSetting(`guidance.${claimed.nonce}`);
          await this.respondCard(message, remoteRequestResolvedCard("指导已提交", "已拒绝原命令，并尝试将你的说明发送给当前 Codex 回合。"));
          void (async () => {
            await this.resolveRemoteRequest(claimed, "decline");
            if (!claimed.turnId || !this.appServer) return;
            this.queuePendingPrompt(claimed.sessionId, command, message.messageId);
            try { await this.appServer.request("turn/steer", { threadId: claimed.sessionId, expectedTurnId: claimed.turnId, input: [{ type: "text", text: command }] }); }
            catch (error) { this.dropPendingPrompt(claimed.sessionId, command, message.messageId); throw error; }
          })().catch((error) => this.db.recordFailure("remote_guidance", { nonce: claimed.nonce }, error));
          return;
        }
      }
      const remoteInput = session ? this.db.nextServerRequest(session.sessionId, "user_input") : null;
      const liveInput = remoteInput ? this.liveUserInputRequest(remoteInput.nonce, message.senderOpenId, message.chatId) : null;
      if (liveInput && command) {
        // A topic reply answers the current question; "2" picks the second option.
        const answers = this.userInputAnswers(liveInput.nonce);
        const options = this.userInputQuestions(liveInput)[answers.length]?.options ?? [];
        const numeric = command.match(/^([1-9]\d*)$/);
        const picked = numeric ? options[Number(numeric[1]) - 1] : undefined;
        await this.respondCard(message, this.answerUserInput(liveInput, [...answers, picked?.label ?? command], message.senderOpenId, message.chatId));
        return;
      }
      const pending = session ? this.getPendingChoice(session.sessionId) : null;
      if (pending && command) {
        const numeric = command.match(/^([1-9]\d*)$/);
        const answer = numeric ? this.optionAnswer(pending, Number(numeric[1]) - 1) : command;
        if (!answer) {
          await this.respondCard(message, choiceCard(pending.request, pending.questionIndex));
          return;
        }
        const result = this.answerPendingChoice(pending, answer);
        if (!result.complete) {
          await this.respondCard(message, choiceCard(pending.request, pending.questionIndex));
          return;
        }
        await this.respondCard(message, choiceAcceptedCard(answer, true));
        void this.resumeFromChoice(pending, result.prompt!, message.messageId);
        return;
      }
    }
    if (this.paused()) { await this.respond(message, "同步当前已暂停。发送 /resume-sync 后再继续会话。"); return; }
    return this.continueSession(message);
  }

  async onBotMenuAction(action: IncomingBotMenuAction): Promise<void> {
    const eventId = "menu:" + action.eventId; if (!this.db.claimInboundEvent(eventId)) return;
    const claimToken = this.db.inboundClaimToken(eventId);
    try {
      const chatId = this.boundChatId(); if (!chatId || action.openId !== this.boundOpenId()) { this.db.completeInboundEvent(eventId, claimToken); return; }
      const cards: Record<string, () => CardDefinition> = {
        "codex.home": () => homeCard(this.cardStatus()),
        "codex.new": () => this.models.length ? this.projectCard(this.beginNewWizard(action.openId, chatId)) : errorCard("模型目录暂不可用。请使用 /retry 刷新。"),
        "codex.sessions": () => this.recentCard(), "codex.search": () => this.recentCard(), "codex.service": () => serviceCard(this.cardStatus()),
      };
      const build = cards[action.eventKey]; if (build) await this.feishu.sendCard(chatId, build()); else console.warn("Ignored unknown Feishu bot menu event key: " + action.eventKey);
      this.db.completeInboundEvent(eventId, claimToken);
    } catch (error) { this.db.failInboundEvent(eventId, error, isRetryableTransportError(error), claimToken); throw error; }
  }

  async handleMenuAction(action: IncomingBotMenuAction): Promise<void> { return this.onBotMenuAction(action); }
  private statusText(): string {
    return [
      `状态：${this.paused() ? "已暂停" : "运行中"}`,
      `已索引会话：${this.db.listSessions().length}`,
      `活动 Codex 任务：${this.turnCoordinator.activeCount()}`,
      `未解决失败：${this.db.failureCount()}`,
      `允许目录：${this.config.allowedRoot}`,
    ].join("\n");
  }

  private respond(message: IncomingFeishuMessage, text: string): Promise<string> {
    return message.rootId ? this.feishu.replyText(message.rootId, text) : this.feishu.sendText(message.chatId, text);
  }

  private respondCard(message: IncomingFeishuMessage, card: CardDefinition): Promise<string> {
    return message.rootId ? this.feishu.replyCard(message.rootId, card) : this.feishu.sendCard(message.chatId, card);
  }

  private async newSession(message: IncomingFeishuMessage, command: string): Promise<void> {
    if (this.paused()) { await this.respond(message, "同步当前已暂停；发送 /resume-sync 后再新建会话。"); return; }
    const match = command.match(/^\/new\s+(\S+)\s+([\s\S]+)$/);
    if (!match?.[1] || !match[2]) {
      await this.respond(message, "格式：/new <目录> <提示>");
      return;
    }
    let cwd: string;
    try { cwd = await resolveAllowedPath(match[1], this.config.allowedRoot); }
    catch (error) { await this.respond(message, `目录被拒绝：${String(error)}`); return; }
    if (!this.models.length) {
      await this.respond(message, "模型目录暂不可用。请发送 /retry 刷新后重试。");
      return;
    }
    const wizard = this.beginNewWizard(message.senderOpenId, message.chatId, {
      cwd, prompt: match[2], imageKeys: message.imageKeys, sourceMessageId: message.messageId,
      ...(message.rootId ? { rootId: message.rootId } : {}),
    });
    await this.respondCard(message, modelCard(this.models, wizard.id, undefined, cwd, "new"));
  }

  private async runNewSessionFromWizard(wizard: WizardState): Promise<void> {
    if (!wizard.cwd || !wizard.prompt || !wizard.model || !wizard.reasoningEffort) return;
    await this.runNewSession({
      messageId: wizard.sourceMessageId ?? `wizard-${wizard.id}`, chatId: wizard.chatId, chatType: "group",
      ...(wizard.rootId ? { rootId: wizard.rootId } : {}), senderOpenId: this.boundOpenId() ?? "", mentionedBot: true, text: wizard.prompt,
      imageKeys: wizard.imageKeys ?? [],
    }, wizard.cwd, wizard.prompt, wizard.model, wizard.reasoningEffort, wizard.imageKeys ?? []);
  }

  private async downloadImages(message: IncomingFeishuMessage, imageKeys: string[]): Promise<string[]> {
    const imagePaths: string[] = [];
    const uniqueKeys = [...new Set(imageKeys)];
    if (uniqueKeys.length > MAX_IMAGES_PER_TASK) throw new Error(`At most ${MAX_IMAGES_PER_TASK} images are allowed per task`);
    const tempDir = join(this.config.stateDir, "tmp", randomUUID());
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    let total = 0;
    try {
      for (const imageKey of uniqueKeys) {
        const data = await this.feishu.downloadImage(message.messageId, imageKey, MAX_IMAGE_BYTES);
        if (data.length > MAX_IMAGE_BYTES) throw new Error("An image exceeds the 10 MiB limit");
        total += data.length;
        if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error("Images exceed the 25 MiB total limit");
        const path = join(tempDir, randomUUID() + imageExtension(data));
        await writeFile(path, data, { mode: 0o600 });
        imagePaths.push(path);
      }
      return imagePaths;
    } catch (error) { await rm(tempDir, { recursive: true, force: true }); throw error; }
  }

  private async cleanupStaleTempFiles(): Promise<void> {
    const tempRoot = join(this.config.stateDir, "tmp");
    let entries: Array<{ name: string }>;
    try { entries = await readdir(tempRoot, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const path = join(tempRoot, entry.name);
      try { if (Date.now() - (await stat(path)).mtimeMs > TEMP_FILE_MAX_AGE_MS) await rm(path, { recursive: true, force: true }); }
      catch { /* best-effort startup hygiene */ }
    }));
  }

  private async runNewSession(
    message: IncomingFeishuMessage, cwd: string, prompt: string, model: string, reasoningEffort: string, imageKeys: string[] = [],
  ): Promise<void> {
    if (this.paused()) { await this.respond(message, "同步当前已暂停；发送 /resume-sync 后再创建会话。"); return; }
    const task: QueuedTask = {
      id: randomUUID(), kind: "new", sessionId: null, cwd, prompt, imageKeys, sourceMessageId: message.messageId,
      chatId: message.chatId, rootMessageId: message.rootId ?? null, model, reasoningEffort, status: "pending", runCardMessageId: null,
      expectedSessionId: null, syncStatus: "none", lastSyncOffset: null, phase: "queued",
      taskFingerprint: taskFingerprint(cwd, prompt, model, reasoningEffort, imageKeys),
    };
    if (!this.db.enqueueTask(task)) return;
    const cardId = await this.respondCard(message, runStatusCard("已排队", `正在创建 Codex 会话：${relative(this.config.allowedRoot, cwd) || "."}`));
    this.db.attachTaskRunCard(task.id, cardId);
    void this.drainTaskQueue(null);
  }

  private async startSessionModelWizard(message: IncomingFeishuMessage): Promise<void> {
    if (!message.rootId) {
      await this.respond(message, "请进入某个 Codex 会话话题后使用 /model；群主消息只能用于新建会话。");
      return;
    }
    const session = this.db.getSessionByRoot(message.rootId);
    if (!session) { await this.respond(message, "当前话题未映射到 Codex 会话。"); return; }
    if (!this.models.length) { await this.respond(message, "模型目录暂不可用。请发送 /retry 刷新后重试。"); return; }
    const wizard = this.saveWizard(message.senderOpenId, {
      id: randomUUID(), mode: "session", chatId: message.chatId, rootId: message.rootId, sessionId: session.sessionId, expiresAt: 0,
    });
    await this.respondCard(message, modelCard(this.models, wizard.id, session.model ?? undefined, session.cwd, "session"));
  }

  private async setSessionModelFromText(message: IncomingFeishuMessage, command: string): Promise<void> {
    if (!message.rootId) { await this.respond(message, "请进入某个 Codex 会话话题后使用 /model <模型> <强度>。"); return; }
    const session = this.db.getSessionByRoot(message.rootId);
    if (!session) { await this.respond(message, "当前话题未映射到 Codex 会话。"); return; }
    const match = command.match(/^\/model\s+(\S+)\s+(\S+)\s*$/);
    if (!match?.[1] || !match[2]) {
      await this.respond(message, "格式：/model <模型> <思考强度>；也可直接发送 /model 使用按钮选择。");
      return;
    }
    const model = this.modelBySlug(match[1]);
    if (!model || !model.supportedReasoningEfforts.includes(match[2])) {
      await this.respond(message, "模型或思考强度不可用。发送 /model 查看当前可选项。");
      return;
    }
    this.db.setSessionModel(session.sessionId, model.slug, match[2]);
    await this.respond(message, `已更新后续续聊模型：${model.displayName} / ${match[2]}。`);
  }

  private async finishApprovedUnarchive(task: QueuedTask): Promise<boolean> {
    if (!this.appServer || !task.sessionId) return false;
    const session = this.db.getSession(task.sessionId);
    if (!session?.rootMessageId) return false;
    try {
      await this.appServer.unarchiveThread(task.sessionId);
      this.db.setSessionLifecycle(task.sessionId, "active");
      if (!this.db.requeueUnarchivedTask(task.id)) return false;
      await this.updateRunCard(task.sessionId, session.rootMessageId, "已取消归档", "原消息已重新排队，将恰好执行一次。", true);
      void this.taskScheduler.drain(task.sessionId);
      return true;
    } catch (error) {
      this.db.recordFailure("thread_unarchive", { taskId: task.id, sessionId: task.sessionId }, error);
      return false;
    }
  }

  private async retryDueWriterTasks(): Promise<void> {
    for (const sessionId of this.db.releaseDueWriterTasks()) void this.taskScheduler.drain(sessionId);
    for (const task of this.db.approvedUnarchiveTasks()) void this.finishApprovedUnarchive(task);
  }

  private async drainPendingTasks(): Promise<void> {
    for (const sessionId of this.db.pendingTaskSessionIds()) void this.taskScheduler.drain(sessionId);
  }

  private async drainTaskQueue(sessionId: string | null): Promise<void> {
    return this.taskScheduler.drain(sessionId);
  }

  private async syncTaskLog(task: QueuedTask, sessionId: string): Promise<boolean> {
    const path = this.db.getSession(sessionId)?.path ?? null;
    if (!path) {
      this.db.updateTask(task.id, "awaiting_sync", { expectedSessionId: sessionId, syncStatus: "awaiting" });
      console.info(`Codex log path is not indexed yet task=${task.id.slice(0, 8)} session=${sessionId.slice(0, 8)}`);
      return false;
    }
    try { await stat(path); } catch {
      this.db.updateTask(task.id, "awaiting_sync", { expectedSessionId: sessionId, syncStatus: "awaiting" });
      console.info(`Codex log is not available yet task=${task.id.slice(0, 8)} session=${sessionId.slice(0, 8)}`);
      return false;
    }
    await this.sessionImporter.enqueueAndWait(path);
    const cursor = this.db.getCursor(path);
    const fileStat = await stat(path);
    const active = this.db.getSetting(`session.${sessionId}.active`) === "1";
    const synchronized = cursor.parsedOffset >= fileStat.size && !active;
    this.db.updateTask(task.id, synchronized ? "completed" : "awaiting_sync", {
      expectedSessionId: sessionId,
      syncStatus: synchronized ? "synced" : "awaiting",
      lastSyncOffset: cursor.parsedOffset,
    });
    console.info(`Codex log sync task=${task.id.slice(0, 8)} session=${sessionId.slice(0, 8)} offset=${cursor.parsedOffset}/${fileStat.size} active=${active} state=${synchronized ? "synced" : "waiting"}`);
    return synchronized;
  }

  private async waitForTaskLog(task: QueuedTask, sessionId: string): Promise<boolean> {
    for (let attempt = 0; attempt < LOG_SYNC_ATTEMPTS; attempt += 1) {
      if (await this.syncTaskLog(task, sessionId)) return true;
      await new Promise((resolve) => setTimeout(resolve, LOG_SYNC_RETRY_MS));
    }
    return false;
  }

  private async reconcileAwaitingSyncTasks(): Promise<void> {
    for (const task of this.db.awaitingSyncTasks()) {
      const sessionId = task.expectedSessionId ?? task.sessionId;
      if (!sessionId) continue;
      if (await this.syncTaskLog(task, sessionId)) {
        const session = this.db.getSession(sessionId);
        if (task.kind === "resume" && session?.rootMessageId) {
          await this.updateRunCard(sessionId, session.rootMessageId, "完成", "本轮已完成，回复已同步到话题。", false);
        } else if (task.runCardMessageId) {
          await this.feishu.updateCard(task.runCardMessageId, runStatusCard("完成", "会话已创建，回复已同步到新话题。"));
        }
      }
    }
  }

  private taskMessage(task: QueuedTask): IncomingFeishuMessage {
    return {
      messageId: task.sourceMessageId, chatId: task.chatId, chatType: "group", senderOpenId: this.boundOpenId() ?? "",
      mentionedBot: true, text: task.prompt, imageKeys: task.imageKeys,
      ...(task.rootMessageId ? { rootId: task.rootMessageId } : {}),
    };
  }

  /** Returns the queued task id, or null when nothing will run. */
  private async enqueueResumeTask(session: NonNullable<ReturnType<BridgeDatabase["getSession"]>>, message: IncomingFeishuMessage, prompt: string): Promise<string | null> {
    const selectedModel = session.model ?? null;
    const selectedEffort = session.reasoningEffort ?? null;
    const configured = selectedModel !== null && selectedEffort !== null;
    const task: QueuedTask = {
      id: randomUUID(), kind: "resume", sessionId: session.sessionId, cwd: session.cwd, prompt, imageKeys: message.imageKeys,
      sourceMessageId: message.messageId, chatId: message.chatId, rootMessageId: session.rootMessageId,
      model: configured ? selectedModel : null, reasoningEffort: configured ? selectedEffort : null, status: "pending", runCardMessageId: null,
      expectedSessionId: session.sessionId, syncStatus: "none", lastSyncOffset: null, phase: "queued",
      taskFingerprint: taskFingerprint(session.cwd, prompt, configured ? selectedModel : null, configured ? selectedEffort : null, message.imageKeys),
    };
    if (!this.db.enqueueTask(task)) return null;
    if (!session.rootMessageId) { this.db.updateTask(task.id, "failed", { error: "session root unavailable" }); return null; }
    await this.updateRunCard(session.sessionId, session.rootMessageId, "已排队", "消息已进入会话队列。", true);
    const status = this.db.getRunStatus(session.sessionId);
    this.db.attachTaskRunCard(task.id, status?.messageId ?? null);
    if (session.lifecycle === "archived") { await this.placeTaskAwaitingUnarchive(this.db.getTask(task.id) ?? task, session.rootMessageId); return task.id; }
    if (session.lifecycle === "deleted" || session.lifecycle === "abandoned") { this.db.updateTask(task.id, "failed", { error: `session is ${session.lifecycle}` }); return null; }
    void this.drainTaskQueue(session.sessionId);
    return task.id;
  }

  private async executeResumeTask(task: QueuedTask): Promise<void> {
    if (!this.appServer) {
      this.db.updateTask(task.id, "failed", { error: "Codex app-server is unavailable; legacy exec fallback is disabled" });
      return;
    }
    await this.executeAppServerResumeTask(task);
  }

  private async executeNewTask(task: QueuedTask): Promise<void> {
    if (!this.appServer) {
      this.db.updateTask(task.id, "failed", { error: "Codex app-server is unavailable; legacy exec fallback is disabled" });
      return;
    }
    await this.executeAppServerNewTask(task);
  }

  private async releaseThreadSubscription(sessionId: string, reason: string): Promise<void> {
    if (!this.appServer) return;
    try { await this.appServer.unsubscribeThread(sessionId); this.db.resolveFailure("thread_unsubscribe", { sessionId }); }
    catch (error) {
      this.db.recordFailure("thread_unsubscribe", { sessionId, reason }, error);
      if (this.turnCoordinator.activeCount() === 0) void this.appServer.restart("release an uncertain thread subscription").catch((restartError) => this.db.recordFailure("app_server_restart", { reason: "unsubscribe" }, restartError));
    }
  }

  private appServerOutcomeUncertain(error: unknown): boolean { const text = error instanceof Error ? error.message : String(error); return /timed out|exited|not running|closed|stdin|write/i.test(text); }

  private resolveTurnExecutionPolicy(mode: "plan" | "default", canonicalCwd: string, rootAuthorized = false): { mode: "plan" | "default"; rootMode: boolean; approvalPolicy: "never" | "on-request"; sandboxPolicy: Record<string, unknown> } {
    if (mode === "plan") return { mode, rootMode: false, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    const rootMode = this.config.executionMode === "root-danger-full-access" && rootAuthorized;
    return rootMode
      ? { mode, rootMode, approvalPolicy: "on-request", sandboxPolicy: { type: "dangerFullAccess" } }
      : { mode, rootMode, approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [canonicalCwd], networkAccess: false } };
  }

  private async createRootGrant(task: QueuedTask): Promise<import("./types.js").TaskRootGrant | null> {
    if (!this.appServer || !this.rootExecutionReady || !task.taskFingerprint) return null;
    const session = task.sessionId ? this.db.getSession(task.sessionId) : null;
    if (task.kind === "resume" && !session) return null;
    const canonicalCwd = await resolveAllowedPath(session?.cwd ?? task.cwd, this.config.allowedRoot);
    const existing = this.db.getTaskRootGrantForTask(task.id);
    if (existing) return existing.taskFingerprint === task.taskFingerprint && existing.canonicalCwd === canonicalCwd ? existing : null;
    return this.db.createTaskRootGrant({
      nonce: randomUUID(), taskId: task.id, sessionId: task.kind === "new" ? null : session!.sessionId, taskFingerprint: task.taskFingerprint, canonicalCwd,
      openId: this.boundOpenId() ?? "", chatId: task.chatId, epoch: this.appServer.appServerEpoch,
      expiresAt: Date.now() + (this.config.rootGrantTtlMs ?? 600_000),
    });
  }

  private async consumeRootGrant(task: QueuedTask): Promise<boolean> {
    if (!task.sessionId || !this.appServer || !task.taskFingerprint) return false;
    const session = this.db.getSession(task.sessionId); if (!session) return false;
    const canonicalCwd = await resolveAllowedPath(session.cwd, this.config.allowedRoot);
    const grant = this.db.getTaskRootGrantForTask(task.id);
    if (!grant || grant.sessionId !== session.sessionId || grant.canonicalCwd !== canonicalCwd || grant.epoch !== this.appServer.appServerEpoch || grant.taskFingerprint !== task.taskFingerprint) return false;
    if (grant.status === "consumed") return true;
    return grant.status === "approved" && this.db.consumeTaskRootGrant(task.id, session.sessionId, canonicalCwd, this.appServer.appServerEpoch, task.taskFingerprint);
  }

  private isWriterConflict(error: unknown): boolean {
    return error instanceof AppServerRpcError && /already has an active writer/i.test(error.message);
  }

  private isArchivedThreadError(error: unknown): boolean {
    return error instanceof AppServerRpcError && /(?:session|thread) is archived/i.test(error.message);
  }

  private async placeTaskAwaitingUnarchive(task: QueuedTask, rootMessageId: string): Promise<void> {
    const nonce = task.actionNonce ?? randomUUID();
    const waiting = this.db.awaitUnarchive(task.id, nonce);
    if (this.appServer) this.db.setSetting(`unarchive.${nonce}.epoch`, String(this.appServer.appServerEpoch));
    if (!waiting) throw new Error("Unable to persist unarchive confirmation");
    if (task.sessionId) this.db.setSessionLifecycle(task.sessionId, "archived");
    if (task.sessionId) await this.updateRunCard(task.sessionId, rootMessageId, "等待取消归档", "该 Codex 会话已归档，需要你的明确确认后才能继续。", true);
    if (!task.actionNonce) {
      const actionCardId = await this.feishu.replyCard(rootMessageId, archivedSessionActionCard(nonce, this.db.getSession(task.sessionId ?? "")?.title ?? "Codex 会话"));
      this.db.setSetting(`unarchive.${nonce}.message`, actionCardId);
    }
  }

  private newTaskRootAuthorized(task: QueuedTask, canonicalCwd: string): boolean {
    if (!this.appServer || !task.taskFingerprint) return false;
    const grant = this.db.getTaskRootGrantForTask(task.id);
    return grant?.status === "consumed" && grant.sessionId === null && grant.taskFingerprint === task.taskFingerprint
      && grant.canonicalCwd === canonicalCwd && grant.epoch === this.appServer.appServerEpoch;
  }

  private async executeAppServerNewTask(task: QueuedTask): Promise<void> {
    if (!this.appServer) return;
    let subscribedSessionId: string | null = null;
    let createdThisAttempt = false;
    try {
      const canonicalCwd = await resolveAllowedPath(task.cwd, this.config.allowedRoot);
      let current = this.db.getTask(task.id) ?? task;
      const rootModeRequested = this.config.executionMode === "root-danger-full-access";

      if (!current.sessionId && rootModeRequested && current.status !== "authorized" && current.status !== "creating_thread") {
        if (!this.rootExecutionReady) throw new Error("Root execution is disabled because container preflight failed");
        const existing = this.db.getTaskRootGrantForTask(current.id);
        const grant = existing?.status === "pending" ? existing : await this.createRootGrant(current);
        if (!grant) throw new Error("Unable to create Root authorization for task");
        this.db.updateTask(current.id, "awaiting_root_consent", { phase: "awaiting_root_consent" });
        if (current.runCardMessageId) await this.feishu.updateCard(current.runCardMessageId, runStatusCard("等待 Root 授权", "批准前不会创建 Codex thread 或飞书话题。"));
        if (!existing) await this.feishu.replyCard(current.sourceMessageId, rootGrantCard(grant.nonce, canonicalCwd, shortText(current.prompt, 500), grant.expiresAt));
        return;
      }

      current = this.db.getTask(current.id) ?? current;
      if (!current.sessionId) {
        const attemptId = current.creationAttemptId ?? randomUUID();
        if (rootModeRequested) {
          if (!current.taskFingerprint || current.status !== "authorized" || !this.db.beginNewTaskCreation(current.id, current.taskFingerprint, canonicalCwd, this.appServer.appServerEpoch, attemptId))
            throw new Error("Root grant did not match the authorized new task");
        } else {
          this.db.updateTask(current.id, "creating_thread", { phase: "creating_thread", creationAttemptId: attemptId, creationStartedAtMs: Date.now() });
        }
        current = this.db.getTask(current.id) ?? current;
        const execution = this.resolveTurnExecutionPolicy("default", canonicalCwd, rootModeRequested);
        const response = this.asRecord(await this.appServer.request("thread/start", { cwd: canonicalCwd,
          approvalPolicy: execution.approvalPolicy, sandbox: threadSandboxMode(execution.sandboxPolicy),
          ...(current.model ? { model: current.model } : {}) }));
        const thread = this.asRecord(response.thread);
        const sessionId = this.stringAt(thread, "id") ?? this.stringAt(response, "threadId", "thread_id");
        if (!sessionId) throw new Error("Codex app-server thread/start returned no thread id");
        subscribedSessionId = sessionId;
        createdThisAttempt = true;
        const metadata: SessionMetadata = { sessionId, path: join(this.sessionsDir, "app-server", `${sessionId}.jsonl`), cwd: canonicalCwd,
          startedAt: new Date().toISOString(), source: "appServer", firstUserText: current.prompt,
          title: this.stringAt(thread, "name") ?? shortText(current.prompt), collaborationMode: "default", model: current.model, reasoningEffort: current.reasoningEffort,
          lifecycle: "active", lifecycleUpdatedAtMs: Date.now(), createdByTaskId: current.id };
        if (!this.db.persistCreatedSession(current.id, metadata)) throw new Error("thread/start succeeded but the task-to-session mapping could not be committed");
        current = this.db.getTask(current.id)!;
      }

      const session = this.db.getSession(current.sessionId!);
      if (!session) throw new Error("Created Codex session is unavailable");
      if (!createdThisAttempt) {
        const execution = this.resolveTurnExecutionPolicy("default", canonicalCwd, !rootModeRequested || this.newTaskRootAuthorized(current, canonicalCwd));
        await this.appServer.request("thread/resume", { threadId: session.sessionId, cwd: canonicalCwd, approvalPolicy: execution.approvalPolicy, sandbox: threadSandboxMode(execution.sandboxPolicy) });
      }
      subscribedSessionId = session.sessionId;
      const rootId = session.rootMessageId ?? await this.ensureRoot(current.chatId, session);
      this.db.updateTask(current.id, "starting_turn", { phase: "starting_turn", sessionId: session.sessionId, expectedSessionId: session.sessionId });
      await this.updateRunCard(session.sessionId, rootId, "已创建", "Codex 会话已创建，正在启动首个回合。", true);
      await this.executeAppServerTurn({ ...current, sessionId: session.sessionId, rootMessageId: rootId, expectedSessionId: session.sessionId }, !rootModeRequested || this.newTaskRootAuthorized(current, canonicalCwd));
      subscribedSessionId = null;
    } catch (error) {
      const latest = this.db.getTask(task.id);
      if (latest?.status === "creating_thread") {
        const uncertain = this.appServerOutcomeUncertain(error) || /mapping could not be committed/i.test(String(error));
        this.db.updateTask(task.id, uncertain ? "creation_uncertain" : "failed", { phase: uncertain ? "creation_uncertain" : "failed", error: shortText(String(error), MAX_ERROR_CHARS) });
      } else if (latest?.sessionId && !["running", "completed"].includes(latest.status)) {
        this.db.updateTask(task.id, "thread_created", { phase: "thread_created", error: shortText(String(error), MAX_ERROR_CHARS), nextAttemptAtMs: Date.now() + 30_000 });
      } else if (latest && !["running", "completed"].includes(latest.status)) {
        this.db.updateTask(task.id, "failed", { phase: "failed", error: shortText(String(error), MAX_ERROR_CHARS) });
      }
      this.db.recordFailure("app_server_new", { taskId: task.id, sessionId: latest?.sessionId ?? null, creationAttemptId: latest?.creationAttemptId ?? null }, error);
      if (subscribedSessionId) await this.releaseThreadSubscription(subscribedSessionId, "new_task_failed_before_turn");
      if (task.runCardMessageId) await this.feishu.updateCard(task.runCardMessageId, runStatusCard(latest?.status === "creating_thread" ? "创建结果不确定" : "创建暂未完成", shortText(String(error), MAX_ERROR_CHARS)));
    }
  }

  private async executeAppServerResumeTask(task: QueuedTask): Promise<void> {
    const session = task.sessionId ? this.db.getSession(task.sessionId) : null;
    if (!session?.rootMessageId) { this.db.updateTask(task.id, "failed", { error: "session unavailable" }); return; }
    if (session.lifecycle === "deleted" || session.lifecycle === "abandoned") {
      this.db.updateTask(task.id, "failed", { error: `session is ${session.lifecycle}` });
      await this.updateRunCard(session.sessionId, session.rootMessageId, "无法继续", `该会话状态为 ${session.lifecycle}。`, false);
      return;
    }
    if (session.lifecycle === "archived" && !task.unarchiveApproved) { await this.placeTaskAwaitingUnarchive(task, session.rootMessageId); return; }
    let subscribed = false;
    try {
      const canonicalCwd = await resolveAllowedPath(session.cwd, this.config.allowedRoot);
      const mode = session.collaborationMode === "plan" ? "plan" : "default";
      const rootModeRequested = mode === "default" && this.config.executionMode === "root-danger-full-access";
      let rootAuthorized = false;
      if (rootModeRequested) {
        if (!this.rootExecutionReady) throw new Error("Root execution is disabled because container preflight failed");
        rootAuthorized = await this.consumeRootGrant(task);
        if (!rootAuthorized) {
          const existing = this.db.getTaskRootGrantForTask(task.id);
          const grant = existing?.status === "pending" ? existing : await this.createRootGrant(task);
          if (!grant) throw new Error("Unable to create Root authorization for task");
          this.db.updateTask(task.id, "awaiting_root_consent", { phase: "awaiting_root_consent" });
          await this.updateRunCard(session.sessionId, session.rootMessageId, "等待 Root 授权", "批准前不会 resume Codex thread。", false);
          if (!existing) await this.feishu.replyCard(session.rootMessageId, rootGrantCard(grant.nonce, canonicalCwd, shortText(task.prompt, 500), grant.expiresAt));
          return;
        }
      }
      const execution = this.resolveTurnExecutionPolicy(mode, canonicalCwd, rootAuthorized);
      await this.appServer!.request("thread/resume", { threadId: session.sessionId, cwd: canonicalCwd, approvalPolicy: execution.approvalPolicy, sandbox: threadSandboxMode(execution.sandboxPolicy) });
      subscribed = true;
      if (task.unarchiveApproved) this.db.setSessionLifecycle(session.sessionId, "active");
      await this.executeAppServerTurn(task, rootAuthorized);
      subscribed = false;
    } catch (error) {
      if (subscribed) await this.releaseThreadSubscription(session.sessionId, "resume_or_turn_start_failed");
      if (this.isWriterConflict(error)) {
        const waiting = this.db.deferTaskForWriter(task.id);
        await this.updateRunCard(session.sessionId, session.rootMessageId, waiting?.status === "expired" ? "等待写锁超时" : "等待本地 Codex", waiting?.status === "expired" ? "30 分钟内写锁未释放；请手动重试。" : "该会话正被 VS Code Codex 使用，释放后会自动继续。", true);
        return;
      }
      if (this.isArchivedThreadError(error)) { await this.placeTaskAwaitingUnarchive(task, session.rootMessageId); return; }
      const uncertain = this.appServerOutcomeUncertain(error);
      this.db.updateTask(task.id, uncertain ? "interrupted" : "failed", { error: shortText(String(error), MAX_ERROR_CHARS) });
      this.db.recordFailure("app_server_resume", { sessionId: session.sessionId, taskId: task.id }, error);
      await this.updateRunCard(session.sessionId, session.rootMessageId, uncertain ? "已中断" : "失败", uncertain ? "app-server 结果不确定，任务不会自动重放。" : shortText(String(error), MAX_ERROR_CHARS), false);
    }
  }

  private steerKey(messageId: string): string { return `steer.${messageId}`; }

  /** What happened to a Feishu message sent into a running turn: being sent, or accepted by Codex. */
  private steerRecord(messageId: string): { turnId: string; state: "sending" | "accepted"; atMs: number } | null {
    try {
      const value = JSON.parse(this.db.getSetting(this.steerKey(messageId)) ?? "null") as { turnId?: unknown; state?: unknown; atMs?: unknown } | null;
      if (!value || typeof value.turnId !== "string" || (value.state !== "sending" && value.state !== "accepted")) return null;
      return { turnId: value.turnId, state: value.state, atMs: Number(value.atMs) || 0 };
    } catch { return null; }
  }

  private saveSteerRecord(messageId: string, turnId: string, state: "sending" | "accepted"): void {
    this.db.setSetting(this.steerKey(messageId), JSON.stringify({ turnId, state, atMs: Date.now() }));
  }

  private deleteSteerRecord(messageId: string): void { this.db.deleteSetting(this.steerKey(messageId)); }

  /** Steer records outlive their turn so that a retried or replayed message is recognised; old ones are dropped. */
  private pruneSteerRecords(now = Date.now()): void {
    for (const { key } of this.db.listSettings("steer.")) {
      const record = this.steerRecord(key.slice("steer.".length));
      if (!record || now - record.atMs > STEER_RECORD_RETENTION_MS) this.db.deleteSetting(key);
    }
  }

  /** A confirmation in the topic; if Feishu fails, the work it confirms has already happened, so only the failure is recorded. */
  private async respondSafely(message: IncomingFeishuMessage, text: string): Promise<void> {
    try { await this.respond(message, text); }
    catch (error) { this.db.recordFailure("topic_confirmation", { messageId: message.messageId }, error); }
  }

  private forgetTurnImages(turnId: string, paths: readonly string[]): void {
    if (!paths.length) return;
    let existing: string[] = [];
    try { existing = JSON.parse(this.db.getSetting(`turn.${turnId}.images`) ?? "[]") as string[]; } catch { return; }
    const remaining = existing.filter((path) => !paths.includes(path));
    if (remaining.length) this.db.setSetting(`turn.${turnId}.images`, JSON.stringify(remaining));
    else this.db.deleteSetting(`turn.${turnId}.images`);
  }

  private rememberTurnImages(turnId: string, paths: string[]): void {
    if (!paths.length) return;
    let existing: string[] = [];
    try { existing = JSON.parse(this.db.getSetting(`turn.${turnId}.images`) ?? "[]") as string[]; } catch { /* replace malformed state */ }
    this.db.setSetting(`turn.${turnId}.images`, JSON.stringify([...existing, ...paths]));
  }

  private async executeAppServerTurn(task: QueuedTask, rootAuthorized = false): Promise<void> {
    if (!this.appServer || !task.sessionId) return;
    const session = this.db.getSession(task.sessionId);
    if (!session?.rootMessageId) throw new Error("session root unavailable");
    const mode = session.collaborationMode === "plan" ? "plan" : "default";
    const canonicalCwd = await resolveAllowedPath(session.cwd, this.config.allowedRoot);
    const rootModeRequested = mode === "default" && this.config.executionMode === "root-danger-full-access";
    if (rootModeRequested && !rootAuthorized) throw new Error("Root authorization must be completed before subscribing to the thread");
    const imagePaths = await this.downloadImages(this.taskMessage(task), task.imageKeys);
    const input: Array<Record<string, unknown>> = [{ type: "text", text: task.prompt }, ...imagePaths.map((path) => ({ type: "localImage", path }))];
    const execution = this.resolveTurnExecutionPolicy(mode, canonicalCwd, rootAuthorized);
    const params: Record<string, unknown> = {
      threadId: session.sessionId, input, cwd: canonicalCwd,
      approvalPolicy: execution.approvalPolicy, approvalsReviewer: "user",
      sandboxPolicy: execution.sandboxPolicy,
      ...(task.model ? { model: task.model } : {}), ...(task.reasoningEffort ? { effort: task.reasoningEffort } : {}),
      collaborationMode: { mode, settings: { model: task.model ?? null, reasoning_effort: task.reasoningEffort ?? null, developer_instructions: null } },
    };
    // The task may have been cancelled while the thread was resumed or images downloaded.
    if (this.db.getTask(task.id)?.status === "cancelled") { await Promise.all(imagePaths.map((path) => rm(path, { force: true }))); return; }
    this.db.updateTask(task.id, "starting_turn", { phase: "starting_turn" });
    // A topic reply is already visible in Feishu, so its JSONL copy must not be
    // posted again. A new-session prompt was typed outside the topic and stays.
    const mirrored = task.kind === "resume";
    if (mirrored) this.queuePendingPrompt(session.sessionId, task.prompt, task.sourceMessageId);
    let response: Record<string, unknown>;
    try { response = this.asRecord(await this.appServer.request("turn/start", params)); }
    catch (error) {
      if (mirrored && !this.appServerOutcomeUncertain(error)) this.dropPendingPrompt(session.sessionId, task.prompt, task.sourceMessageId);
      await Promise.all(imagePaths.map((path) => rm(path, { force: true })));
      throw error;
    }
    const turn = this.asRecord(response.turn);
    const turnId = this.stringAt(turn, "id") ?? this.stringAt(response, "turnId", "turn_id");
    if (!turnId) { await Promise.all(imagePaths.map((path) => rm(path, { force: true }))); throw new Error("Codex app-server turn/start returned no turn id"); }
    const state: TurnState = { sessionId: session.sessionId, turnId, epoch: this.appServer.appServerEpoch, mode, state: "running", text: "", plan: "", rootMessageId: session.rootMessageId, startedAtMs: Date.now(), inputHash: textHash(task.prompt) };
    this.turnCoordinator.setTurn(state); this.db.saveTurn(state);
    if (this.db.getTask(task.id)?.status === "cancelled") {
      // Cancelled while turn/start was on its way: the turn exists now, so it is stopped like a running one.
      this.db.setSetting(`turn.${turnId}.images`, JSON.stringify(imagePaths));
      void this.cancelSessionWork(session.sessionId, null, "cancelled while starting").then((outcome) => {
        const report = this.cancelReport(outcome);
        if (report?.update) return this.updateRunCard(session.sessionId, session.rootMessageId!, report.state, report.detail, outcome.turn === "failed");
      }).catch((error) => this.db.recordFailure("cancel_started_turn", { turnId }, error));
      return;
    }
    this.db.upsertAppServerDelivery({ sessionId: session.sessionId, turnId, role: "user", startedAtMs: state.startedAtMs ?? null, contentHash: textHash(task.prompt), contentBytes: Buffer.byteLength(task.prompt, "utf8"), sourceMessageId: task.sourceMessageId });
    this.db.updateTask(task.id, "running", { sessionId: session.sessionId, turnId, phase: "running" });
    this.db.setSetting(`turn.${turnId}.images`, JSON.stringify(imagePaths));
    await this.updateRunCard(session.sessionId, session.rootMessageId, "运行中", mode === "plan" ? "Codex 正在只读规划。" : execution.rootMode ? "Codex 正在专用 Root 容器中执行。" : "Codex 正在受限工作区中执行。", true);
  }

  private async hasLocalActiveSession(session: SessionMetadata & { path: string }): Promise<boolean> {
    if (this.db.getSetting(`session.${session.sessionId}.active`) !== "1") return false;
    try {
      if (Date.now() - (await stat(session.path)).mtimeMs <= this.config.activeSessionQuietMs) return true;
      if (await this.hasWritableFileDescriptor(session.path)) return true;
    } catch { /* an unreadable historical log cannot safely block the session forever */ }
    this.db.setSetting(`session.${session.sessionId}.active`, "0");
    return false;
  }

  private async continueSession(message: IncomingFeishuMessage): Promise<void> {
    if (!message.rootId) {
      await this.respond(message, "请在某个 Codex 会话话题内回复，或使用 /new <目录> <提示>。");
      return;
    }
    const session = this.db.getSessionByRoot(message.rootId);
    if (!session) { await this.respond(message, "当前话题未映射到 Codex 会话。"); return; }
    if (session.model && session.reasoningEffort && !this.modelBySlug(session.model)) {
      await this.respond(message, "此会话保存的模型已不在当前 Codex 模型目录中。请发送 /model 重新选择；不会自动切换模型。");
      return;
    }
    if (session.model && session.reasoningEffort && !this.modelBySlug(session.model)!.supportedReasoningEfforts.includes(session.reasoningEffort)) {
      await this.respond(message, "此会话保存的思考强度已不被该模型支持。请发送 /model 重新选择。");
      return;
    }
    const userPrompt = message.text || (message.imageKeys.length ? "请分析这张图片。" : "");
    if (!userPrompt) { await this.respond(message, "消息中没有可提交的文本或图片。"); return; }
    try { await resolveAllowedPath(session.cwd, this.config.allowedRoot); }
    catch (error) { await this.respond(message, `会话目录被拒绝：${String(error)}`); return; }
    // A message that already reached a running turn (this delivery may be a retry, or the
    // service restarted after sending it) must never run a second time.
    const steered = this.steerRecord(message.messageId);
    if (steered) {
      await this.respondSafely(message, steered.state === "accepted" ? "已发送给当前 Codex 回合。" : STEER_UNCERTAIN_TEXT);
      return;
    }
    const active = this.turnCoordinator.mutableTurn(session.sessionId);
    // A turn being cancelled takes no more input; the message waits for the next turn.
    if (active && active.state !== "cancelling" && this.appServer) {
      const paths = await this.downloadImages(message, message.imageKeys);
      this.queuePendingPrompt(session.sessionId, userPrompt, message.messageId);
      this.saveSteerRecord(message.messageId, active.turnId, "sending");
      // Codex may read the images as soon as it has the request, so they belong to the turn from now on.
      this.rememberTurnImages(active.turnId, paths);
      let accepted = false;
      try {
        await this.appServer.request("turn/steer", { threadId: session.sessionId, expectedTurnId: active.turnId,
          input: [{ type: "text", text: userPrompt }, ...paths.map((path) => ({ type: "localImage", path }))] });
        accepted = true;
      } catch (error) {
        if (this.appServerOutcomeUncertain(error)) {
          // No answer is not a refusal: the turn may have taken the message, so it is not queued again.
          this.db.recordFailure("turn_steer_uncertain", { sessionId: session.sessionId }, error);
          await this.respondSafely(message, STEER_UNCERTAIN_TEXT);
          return;
        }
        // Codex refused the input (for example the turn just ended): it runs in the next turn instead.
        this.deleteSteerRecord(message.messageId);
        this.dropPendingPrompt(session.sessionId, userPrompt, message.messageId);
        this.forgetTurnImages(active.turnId, paths);
        await Promise.all(paths.map((path) => rm(path, { force: true })));
        console.warn("turn/steer refused; queueing next turn", error);
      }
      if (accepted) {
        this.saveSteerRecord(message.messageId, active.turnId, "accepted");
        // Codex has the message; failing to say so in Feishu must not send it again.
        await this.respondSafely(message, "已发送给当前 Codex 回合。");
        return;
      }
    }
    await this.enqueueResumeTask(session, message, userPrompt);
  }

  private async resumeFromChoice(state: PendingChoiceState, answerPrompt: string, sourceMessageId: string): Promise<void> {
    const session = this.db.getSession(state.request.sessionId);
    if (!session) return;
    if (session.model && session.reasoningEffort && !this.modelBySlug(session.model)) {
      await this.feishu.replyText(state.rootId, "此会话保存的模型已不可用。请发送 /model 重新选择后再回答。");
      return;
    }
    if (session.model && session.reasoningEffort && !this.modelBySlug(session.model)!.supportedReasoningEfforts.includes(session.reasoningEffort)) {
      await this.feishu.replyText(state.rootId, "此会话保存的思考强度已不可用。请发送 /model 重新选择。");
      return;
    }
    if (this.paused()) {
      await this.feishu.replyText(state.rootId, "同步当前已暂停；选择已记录，但不会执行。恢复同步后请重新提交选择。");
      return;
    }
    try { await resolveAllowedPath(session.cwd, this.config.allowedRoot); }
    catch (error) { await this.feishu.replyText(state.rootId, `会话目录被拒绝：${String(error)}`); return; }
    // The terminal cannot receive this answer inside its waiting turn, so it is
    // sent as a new message once the terminal releases the session.
    const terminalWaiting = await this.hasLocalActiveSession(session);
    const taskId = await this.enqueueResumeTask(session, {
      messageId: sourceMessageId, chatId: this.boundChatId() ?? "", chatType: "group", rootId: state.rootId,
      senderOpenId: this.boundOpenId() ?? "", mentionedBot: true, text: answerPrompt, imageKeys: [],
    }, answerPrompt);
    if (!taskId) return;
    this.db.setSetting(this.choiceTaskPrefix(session.sessionId) + state.request.id,
      JSON.stringify({ taskId, requestId: state.request.id, timestamp: state.request.timestamp }));
    if (terminalWaiting) {
      await this.feishu.replyText(state.rootId, "本机终端仍在运行这个会话。你的回答已排队，等终端结束这一轮或关闭后发送；如果你先在终端回答了这个问题，这条回答会自动取消。");
    }
  }

  private async cancel(message: IncomingFeishuMessage): Promise<void> {
    const session = message.rootId ? this.db.getSessionByRoot(message.rootId) : null;
    const key = session?.sessionId;
    const outcome = await this.cancelSessionWork(key ?? null, message.rootId ?? null, "cancelled by user");
    const report = key ? this.cancelReport(outcome) : null;
    if (!key || !report) {
      await this.respond(message, "当前话题没有由桥接服务启动的活动任务。");
      return;
    }
    if (session?.rootMessageId && report.update) void this.updateRunCard(key, session.rootMessageId, report.state, report.detail, outcome.turn === "failed" || outcome.turn === "uncertain").catch((error) => this.db.recordFailure("cancel_card", { sessionId: key }, error));
    await this.respond(message, `${report.state}：${report.detail}`);
  }
}
