import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { assistantMarkdownCard, choiceAcceptedCard, choiceCancelledCard, choiceCard, commandMenuCard, errorCard, helpCard, homeCard, modelCard, projectsCard, reasoningEffortCard, recentSessionsCard, remoteRequestCard, remoteRequestResolvedCard, reviewCard, rootGrantCard, runStatusCard, serviceCard, sessionCard, wizardReadyCard } from "./cards.js";
import { CodexAppServer, type JsonRpcMessage } from "./app-server.js";
import { CodexCliProbe } from "./codex.js";
import { BridgeDatabase } from "./db.js";
import { messageAppLink } from "./feishu.js";
import { resolveAllowedPath } from "./path-policy.js";
import { remoteApprovalAllowed, remoteApprovalSummary, rootExecutionPreflight } from "./execution-policy.js";
import { isRetryableTransportError } from "./inbound-events.js";
import { parseJsonlChunk } from "./session-parser.js";
import type { FeishuRouterPort } from "./bridge-contracts.js";
import { jsonlFiles, SessionImporter } from "./session-importer.js";
import type { BridgeConfig, CardActionOutcome, CardDefinition, ChoiceRequest, FeishuPort, IncomingBotMenuAction, IncomingCardAction, IncomingFeishuMessage, ModelCapability, PendingServerRequest, QueuedTask, RemoteRequestType, SessionMetadata, TurnState } from "./types.js";

const MAX_ERROR_CHARS = 3_000;
const MAX_INLINE_MESSAGE_BYTES = 45_000;
const MAX_LIVE_TEXT_BYTES = 200_000;
const PENDING_PROMPT_TTL_MS = 10 * 60_000;
const MODEL_CATALOG_KEY = "codex.model_catalog.v1";
const MODEL_BACKFILL_MIGRATION_KEY = "migration.session_model_backfill.v1";
const LOG_SYNC_ATTEMPTS = 10;
const LOG_SYNC_RETRY_MS = 500;
const STREAM_INTERVAL_MS = 500;
const MAX_IMAGES_PER_TASK = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

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
  const combined = current + delta;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  const head = combined.slice(0, Math.floor(maxBytes * 0.75));
  const tail = combined.slice(-Math.floor(maxBytes * 0.2));
  return head + "\n\n[…正文过长，已截断；完整内容见同步日志…]\n\n" + tail;
}

function inlinePreview(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_INLINE_MESSAGE_BYTES) return text;
  const head = text.slice(0, 30_000); const tail = text.slice(-10_000);
  return head + "\n\n[…正文超过飞书卡片上限，完整内容见 Markdown 附件…]\n\n" + tail;
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

export class SyncService implements FeishuRouterPort {
  private readonly sessionsDir: string;
  private readonly sessionImporter: SessionImporter;
  private readonly activeTurns = new Map<string, TurnState>();
  private readonly requestResolvers = new Map<string, (value: unknown) => void>();
  private readonly notificationQueues = new Map<string, Promise<void>>();
  private readonly taskWorkers = new Set<string>();
  private scanTimer: NodeJS.Timeout | null = null;
  private messageLinkPermissionDenied = false;
  private models: ModelCapability[] = [];
  private titleIndex: Map<string, string> | null = null;
  private rootExecutionReady = false;
  private appServerRestartAttempts = 0;
  private appServerRestartTimer: NodeJS.Timeout | null = null;

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
      this.appServer.onNotification((event) => this.enqueueAppServerNotification(event));
      this.appServer.onLifecycle((event) => { if (event.kind === "started") this.appServerRestartAttempts = 0; });
      this.appServer.onExit((event) => { void this.handleAppServerExit(event.epoch, event.error); });
      this.appServer.onServerRequest((request) => this.onAppServerRequest(request));
      await this.appServer.start();
      await this.expireRemoteState();
      await this.refreshThreadsFromAppServer();
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
    await this.cleanupStaleTempFiles();
    await mkdir(this.sessionsDir, { recursive: true });
    await this.sessionImporter.startWatching();
    this.scanTimer = setInterval(() => {
      if (!this.boundChatId() || this.paused()) return;
      void this.syncAll();
      void this.drainPendingTasks();
      void this.reconcileAwaitingSyncTasks();
      void this.expireRootGrants();
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
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.appServerRestartTimer) clearTimeout(this.appServerRestartTimer);
    await Promise.all([...this.activeTurns.keys()].map((sessionId) => this.cancelSessionWork(sessionId, null, "service stopping")));
    await this.cancelAllWork("service stopping");
    await this.sessionImporter.stopWatching();
    await this.appServer?.close();
  }

  private boundChatId(): string | null { return this.db.getSetting("feishu.chat_id"); }
  private boundOpenId(): string | null { return this.db.getSetting("feishu.open_id"); }
  private paused(): boolean { return this.db.getSetting("sync.paused") === "1"; }

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
          await this.feishu.updateCard(refreshed.rootMessageId, sessionCard(this.sessionView(refreshed), this.activeTurns.has(session.sessionId) ? "运行中" : "可继续"));
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
      if (this.activeTurns.has(sessionId)) continue;
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
      try {
        await this.feishu.updateCard(session.rootMessageId, sessionCard(this.sessionView(session), this.activeTurns.has(session.sessionId) ? "运行中" : "可继续"));
        this.db.setSessionCardMessage(session.sessionId, session.rootMessageId);
      } catch (error) {
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
      if (message.role === "progress" && !this.activeTurns.has(session.sessionId)) continue;
      const label = message.role === "user" ? "用户" : message.role === "assistant" ? "Codex" : "进度";
      const mapped = message.role === "assistant" ? this.db.findAppServerDelivery(session.sessionId, "assistant", textHash(message.text)) : null;
      if (mapped?.feishuMessageId) {
        this.db.saveMessage(message.id, session.sessionId, "app_server_delivery", mapped.feishuMessageId, { path, kind: "primary" });
        continue;
      }
      let feishuId: string;
      if (Buffer.byteLength(message.text, "utf8") > MAX_INLINE_MESSAGE_BYTES) {
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
    for (const request of batch?.choiceRequests ?? []) {
      if (this.db.hasMessage(request.id)) continue;
      let feishuId: string;
      if (forbiddenRemoteQuestion(request)) {
        feishuId = await this.feishu.replyText(rootId, "Codex 请求了不允许远程确认的安全信息或权限。请在本机处理；飞书不会提供批准按钮。");
      } else {
        this.savePendingChoice({ request, rootId, questionIndex: 0, answers: [] });
        this.db.setSetting(`session.${session.sessionId}.active`, "0");
        feishuId = await this.feishu.replyCard(rootId, choiceCard(request, 0));
      }
      this.db.saveMessage(request.id, session.sessionId, "outbound_choice", feishuId, { path, kind: "primary" });
    }
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

  private async cancelSessionWork(sessionId: string | null, rootMessageId: string | null, reason: string): Promise<number> {
    const cancelled = sessionId ? this.db.cancelTasksBySession(sessionId, reason) : rootMessageId ? this.db.cancelTasksByRoot(rootMessageId, reason) : [];
    const targetIds = new Set<string>(cancelled.flatMap((task) => task.sessionId ? [task.sessionId] : []));
    if (sessionId) targetIds.add(sessionId);
    for (const targetSessionId of targetIds) {
      const active = this.activeTurns.get(targetSessionId);
      if (active) {
        this.activeTurns.delete(targetSessionId);
        active.state = "interrupted"; this.db.saveTurn(active);
        await this.cleanupTurnImages(active.turnId);
        if (this.appServer) void this.appServer.request("turn/interrupt", { threadId: targetSessionId, turnId: active.turnId }).catch((error) => this.db.recordFailure("turn_interrupt", { sessionId: targetSessionId }, error));
      }
      for (const request of this.db.cancelServerRequestsForSession(targetSessionId)) {
        this.requestResolvers.get(request.nonce)?.({ action: "cancel", decision: "cancel" });
        this.requestResolvers.delete(request.nonce);
      }
    }
    return cancelled.length;
  }

  private async cancelAllWork(reason: string): Promise<number> {
    const cancelled = this.db.cancelAllTasks(reason);
    const ids = new Set<string>(cancelled.flatMap((task) => task.sessionId ? [task.sessionId] : []));
    for (const sessionId of this.activeTurns.keys()) ids.add(sessionId);
    for (const sessionId of ids) await this.cancelSessionWork(sessionId, null, reason);
    return cancelled.length;
  }
  private async handleAppServerExit(epoch: number, error?: Error): Promise<void> {
    const interrupted = this.db.markRunningTasksInterrupted();
    for (const turn of this.activeTurns.values()) { turn.state = "interrupted"; this.db.saveTurn(turn); await this.cleanupTurnImages(turn.turnId); }
    this.activeTurns.clear();
    for (const resolver of this.requestResolvers.values()) resolver({ action: "cancel", decision: "cancel" });
    this.requestResolvers.clear();
    for (const task of interrupted) {
      if (task.runCardMessageId) void this.feishu.updateCard(task.runCardMessageId, runStatusCard("已中断", "Codex app-server 已退出；该任务不会自动重放。")).catch(() => undefined);
      if (task.rootMessageId && task.sessionId) void this.updateRunCard(task.sessionId, task.rootMessageId, "已中断", "Codex app-server 已退出；该任务不会自动重放。", false).catch(() => undefined);
    }
    if (error) this.db.recordFailure("app_server_exit", { epoch }, error);
    this.scheduleAppServerRestart();
  }

  private scheduleAppServerRestart(): void {
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
      await this.cancelSessionWork(grant.sessionId, null, "Root authorization expired");
      const session = this.db.getSession(grant.sessionId);
      if (session?.rootMessageId) void this.updateRunCard(grant.sessionId, session.rootMessageId, "已取消", "Root 授权已过期，任务未执行。", false).catch(() => undefined);
    }
  }

  private async refreshThreadsFromAppServer(): Promise<void> {
    if (!this.appServer) return;
    let cursor: string | null = null;
    do {
      const result = this.asRecord(await this.appServer.request("thread/list", {
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"], ...(cursor ? { cursor } : {}),
      }));
      const threads = Array.isArray(result.threads) ? result.threads : Array.isArray(result.data) ? result.data : [];
      for (const item of threads) {
        const thread = this.asRecord(item);
        const sessionId = this.stringAt(thread, "id");
        if (!sessionId) continue;
        const existing = this.db.getSession(sessionId);
        if (!existing) continue;
        const title = this.stringAt(thread, "name") ?? this.stringAt(thread, "preview") ?? existing.title;
        if (title) this.db.setSessionTitle(sessionId, title);
      }
      cursor = this.stringAt(result, "nextCursor", "next_cursor");
    } while (cursor);
  }

  private sessionView<T extends { sessionId: string; cwd: string }>(session: T): T & { executionMode: BridgeConfig["executionMode"]; rootExecutionReady: boolean; rootPreflightReasons: string[]; hasActiveWork: boolean } {
    let reasons: string[] = [];
    try { reasons = JSON.parse(this.db.getSetting("codex.root_preflight") ?? "{}").reasons ?? []; } catch { /* invalid diagnostics are ignored */ }
    return { ...session, executionMode: this.config.executionMode, rootExecutionReady: this.rootExecutionReady, rootPreflightReasons: reasons, hasActiveWork: this.activeTurns.has(session.sessionId) };
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
    const state = this.activeTurns.get(scopedSessionId);
    if (state) {
      state.state = type === "user_input" ? "awaiting_input" : "awaiting_approval"; this.db.saveTurn(state);
      const task = turnId ? this.db.taskForTurn(turnId) : null;
      if (task) this.db.transitionTask(task.id, state.state);
    }
    const detail = this.remoteRequestDetail(type, pending.payload);
    const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions.flatMap((item) => typeof item === "string" ? [item] : []) : undefined;
    const secret = type === "user_input" && this.requestContainsSecret(params);
    if (secret) throw new Error("Secret input is never accepted through Feishu");
    const card = remoteRequestCard({ nonce, type, title: this.remoteRequestTitle(type), detail, ...(decisions ? { decisions } : {}), secret });
    const cardMessageId = await this.feishu.replyCard(rootMessageId, card);
    pending.cardMessageId = cardMessageId; this.db.saveServerRequest(pending);
    await this.updateRunCard(scopedSessionId, rootMessageId, type === "user_input" ? "等待输入" : "等待批准", "Codex 正在等待你的选择。", true);
    const timeout = setTimeout(() => {
      const live = this.db.claimServerRequest(nonce, openId, pending.chatId, this.appServer?.appServerEpoch ?? -1);
      if (!live) return;
      void this.resolveRemoteRequest(live, "decline").catch((error) => this.db.recordFailure("remote_request_timeout", { nonce }, error));
    }, Math.max(1, expiry - Date.now()));
    timeout.unref();
    return new Promise((resolve) => this.requestResolvers.set(nonce, resolve));
  }

  private async resolveRemoteRequest(request: PendingServerRequest, decision: string, answer?: string): Promise<void> {
    const resolver = this.requestResolvers.get(request.nonce);
    if (!resolver) { this.db.setServerRequestStatus(request.nonce, "expired"); return; }
    const params = request.payload;
    let result: unknown;
    if (request.type === "user_input") {
      const questions = Array.isArray(params.questions) ? params.questions.map((item) => this.asRecord(item)) : [];
      const first = questions[0];
      if (decision === "accept" && first) result = { answers: { [this.stringAt(first, "id") ?? "answer"]: { answers: [answer ?? "已确认"] } } };
      else result = { answers: {} };
    } else if (request.type === "permissions") {
      result = decision === "accept" || decision === "acceptForSession"
        ? { permissions: Array.isArray(params.permissions) ? params.permissions : [], scope: decision === "acceptForSession" ? "session" : "turn" }
        : { permissions: [], scope: "turn" };
    } else if (request.type === "mcp_elicitation") {
      result = { action: decision === "accept" ? "accept" : decision === "cancel" ? "cancel" : "decline", content: null, _meta: null };
    } else {
      result = { decision: decision === "accept" || decision === "acceptForSession" || decision === "cancel" ? decision : "decline" };
    }
    this.requestResolvers.delete(request.nonce);
    this.db.setServerRequestStatus(request.nonce, decision === "decline" ? "declined" : "resolved");
    if (request.turnId) { const task = this.db.taskForTurn(request.turnId); if (task) this.db.transitionTask(task.id, "running"); }
    resolver(result);
    if (request.cardMessageId) await this.feishu.updateCard(request.cardMessageId, remoteRequestResolvedCard("Codex 请求已提交", decision === "accept" || decision === "acceptForSession" ? "已批准。" : "已拒绝或取消。", decision === "accept" || decision === "acceptForSession"));
  }

  private enqueueAppServerNotification(message: JsonRpcMessage): Promise<void> {
    const params = this.asRecord(message.params);
    const sessionId = this.stringAt(params, "threadId", "thread_id") ?? "unscoped";
    const turnId = this.stringAt(params, "turnId", "turn_id") ?? "none";
    const key = sessionId + ":" + turnId;
    const previous = this.notificationQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.onAppServerNotification(message));
    this.notificationQueues.set(key, next);
    void next.finally(() => { if (this.notificationQueues.get(key) === next) this.notificationQueues.delete(key); });
    return next;
  }

  private async onAppServerNotification(message: JsonRpcMessage): Promise<void> {
    const params = this.asRecord(message.params); const method = message.method ?? "";
    const sessionId = this.stringAt(params, "threadId", "thread_id"); const turnId = this.stringAt(params, "turnId", "turn_id");
    if (method === "thread/name/updated" && sessionId) {
      const title = this.stringAt(params, "threadName", "thread_name", "name");
      if (title) { this.db.setSessionTitle(sessionId, title); const session = this.db.getSession(sessionId); if (session?.rootMessageId) await this.feishu.updateCard(session.rootMessageId, sessionCard(this.sessionView(session), this.activeTurns.has(sessionId) ? "运行中" : "可继续")); }
      return;
    }
    if (method === "turn/started" && sessionId && turnId) {
      const session = this.db.getSession(sessionId); if (!session?.rootMessageId) return;
      const current = this.activeTurns.get(sessionId) ?? { sessionId, turnId, epoch: this.appServer?.appServerEpoch ?? 0, mode: session.collaborationMode === "plan" ? "plan" : "default", state: "running" as const, text: "", plan: "", rootMessageId: session.rootMessageId };
      current.turnId = turnId; this.activeTurns.set(sessionId, current); this.db.saveTurn(current); await this.updateRunCard(sessionId, session.rootMessageId, "运行中", "Codex 正在处理。", true); return;
    }
    if ((method === "item/agentMessage/delta" || method === "item/plan/delta") && sessionId && turnId) {
      const state = this.activeTurns.get(sessionId); if (!state || state.turnId !== turnId) return;
      const delta = this.stringAt(params, "delta", "text") ?? ""; if (!delta) return;
      if (method.includes("plan")) state.plan = appendBoundedText(state.plan, delta, MAX_LIVE_TEXT_BYTES); else state.text = appendBoundedText(state.text, delta, MAX_LIVE_TEXT_BYTES);
      await this.flushTurnStream(state, method.includes("plan") ? "Plan" : "Codex"); return;
    }
    if ((method === "item/started" || method === "item/completed") && sessionId && turnId) {
      const item = this.asRecord(params.item); const itemId = this.stringAt(item, "id") ?? this.stringAt(params, "itemId") ?? turnId + ":" + method; const kind = this.stringAt(item, "type") ?? "unknown"; const status = this.stringAt(item, "status") ?? (method === "item/completed" ? "completed" : "inProgress"); this.db.saveTurnItem(turnId, itemId, kind, status, item); return;
    }
    if (method === "serverRequest/resolved") {
      const requestId = this.stringAt(params, "requestId", "request_id"); if (!requestId) return;
      for (const request of this.db.resolveServerRequestsByRpcId(requestId, this.appServer?.appServerEpoch ?? -1)) if (request.cardMessageId) await this.feishu.updateCard(request.cardMessageId, remoteRequestResolvedCard("Codex 请求已处理", "该请求已完成或已由 Codex 清理。"));
      return;
    }
    if (method === "turn/completed" && sessionId && turnId) {
      const state = this.activeTurns.get(sessionId); if (!state || state.turnId !== turnId) return; const turn = this.asRecord(params.turn); const status = this.stringAt(turn, "status") ?? this.stringAt(params, "status") ?? "completed";
      state.state = status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed"; state.endedAtMs = Date.now(); state.finalOutputHash = textHash(state.plan || state.text); this.db.saveTurn(state); this.activeTurns.delete(sessionId);
      const task = this.db.taskForTurn(turnId); if (task) this.db.transitionTask(task.id, state.state === "completed" ? "completed" : state.state === "interrupted" ? "interrupted" : "failed", { terminalReason: "turn " + state.state }); await this.cleanupTurnImages(turnId);
      try { const feishuMessageId = await this.finishTurnStream(state, state.state === "completed" ? "Codex 已完成" : "Codex " + state.state); const content = state.plan || state.text; if (content && feishuMessageId) this.db.upsertAppServerDelivery({ sessionId, turnId, role: "assistant", startedAtMs: state.startedAtMs ?? null, endedAtMs: state.endedAtMs ?? null, contentHash: textHash(content), contentBytes: Buffer.byteLength(content, "utf8"), feishuMessageId }); } catch (error) { this.db.recordFailure("finish_turn_stream", { turnId }, error); }
      void this.updateRunCard(sessionId, state.rootMessageId, state.state === "completed" ? "完成" : state.state === "interrupted" ? "已取消" : "失败", state.state === "completed" ? "本轮已完成。" : "本轮未完成。", false).catch((error) => this.db.recordFailure("turn_completion_card", { turnId }, error)); void this.drainTaskQueue(sessionId);
    }
  }

  private async flushTurnStream(state: TurnState, title: string): Promise<void> {
    const content = state.plan || state.text;
    if (!content || Date.now() - (state.stream?.lastSentAt ?? 0) < STREAM_INTERVAL_MS) return;
    const preview = inlinePreview(content);
    if (!state.stream && this.feishu.createStreamingReply) { try { const created = await this.feishu.createStreamingReply(state.rootMessageId, title); state.stream = { ...created, lastSentAt: 0 }; } catch (error) { this.db.recordFailure("cardkit_stream", { sessionId: state.sessionId }, error); return; } }
    if (state.stream && this.feishu.updateStreamingReply) { state.stream.sequence = await this.feishu.updateStreamingReply(state.stream, preview); state.stream.lastSentAt = Date.now(); this.db.saveTurn(state); }
  }

  private async finishTurnStream(state: TurnState, summary: string): Promise<string | null> {
    const content = state.plan || state.text; const preview = inlinePreview(content); let messageId: string | null = null;
    if (state.stream && this.feishu.updateStreamingReply && this.feishu.finishStreamingReply) { if (preview) state.stream.sequence = await this.feishu.updateStreamingReply(state.stream, preview); await this.feishu.finishStreamingReply(state.stream, summary); messageId = state.stream.messageId; } else if (preview) messageId = await this.feishu.replyCard(state.rootMessageId, assistantMarkdownCard(preview));
    if (content && Buffer.byteLength(content, "utf8") > MAX_INLINE_MESSAGE_BYTES) await this.feishu.replyFile(state.rootMessageId, state.sessionId.slice(0, 8) + "-" + state.turnId.slice(0, 12) + ".md", Buffer.from(content));
    return messageId;
  }

  private cardStatus(): { paused: boolean; sessions: number; active: number; failures: number; queued: number; waiting: number; failedTasks: number; appServer?: string } {
    const counts = this.db.taskStateCounts();
    const health = this.appServer?.getHealth();
    return { paused: this.paused(), sessions: this.db.listSessions().length, active: counts.running ?? this.activeTurns.size,
      queued: counts.pending ?? 0, waiting: (counts.awaiting_root_consent ?? 0) + (counts.awaiting_input ?? 0) + (counts.awaiting_approval ?? 0),
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

  private async updateRunCard(sessionId: string, rootId: string, state: string, detail: string, cancellable = false): Promise<void> {
    const previous = this.db.getRunStatus(sessionId);
    const card = runStatusCard(state, detail, cancellable, sessionId);
    if (previous?.messageId && (state === "完成" || state === "失败" || state === "已取消" || Date.now() - previous.updatedAtMs >= 1_000)) {
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

  private promptKey(sessionId: string, prompt: string): string { return `prompt.${sessionId}.${textHash(prompt)}`; }

  private queuePendingPrompt(sessionId: string, prompt: string, feishuMessageId: string): void {
    const key = this.promptKey(sessionId, prompt);
    const raw = this.db.getSetting(key);
    let pending: Array<{ messageId: string; expiresAt: number }> = [];
    try { if (raw) pending = JSON.parse(raw) as typeof pending; } catch { /* replace malformed state */ }
    pending = pending.filter((item) => item.expiresAt > Date.now());
    pending.push({ messageId: feishuMessageId, expiresAt: Date.now() + PENDING_PROMPT_TTL_MS });
    this.db.setSetting(key, JSON.stringify(pending));
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
      id: randomUUID(), mode: "new", chatId, expiresAt: 0, ...partial,
    });
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
    try { const outcome = await this.handleCardAction(event); this.db.completeInboundEvent(eventId, claimToken); return outcome; }
    catch (error) { this.db.failInboundEvent(eventId, error, isRetryableTransportError(error), claimToken); throw error; }
  }

  async handleCardAction(event: IncomingCardAction): Promise<CardActionOutcome> {
    if (event.openId !== this.boundOpenId() || event.chatId !== this.boundChatId()) return { delivery: "none" };
    try {
      const rootCardSession = this.db.getSessionByRoot(event.openMessageId);
      if (rootCardSession && !["session_model", "session_status", "session_toggle_mode", "cancel_run", "root_grant", "root_grant_confirm", "root_grant_cancel", "root_revoke", "turn_review", "remote_approve", "remote_guidance"].includes(event.action)) {
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
          return { delivery: "replace", card: modelCard(this.models, this.saveWizard(event.openId, wizard).id, undefined, cwd, "new") };
        }
        case "select_project": {
          const wizard = this.validWizard(event.openId, event, "new");
          if (!wizard) return errorCard("该项目选择卡片已过期，请重新开始新建会话。");
          const cwd = typeof event.value.cwd === "string" ? event.value.cwd : "";
          wizard.cwd = await resolveAllowedPath(cwd, this.config.allowedRoot);
          delete wizard.model;
          delete wizard.reasoningEffort;
          const current = this.saveWizard(event.openId, wizard);
          if (!this.models.length) return errorCard("模型目录暂不可用。请使用 /retry 刷新后重新开始。 ");
          return { delivery: "replace", card: modelCard(this.models, current.id, undefined, current.cwd, "new") };
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
          return { delivery: "replace", card: reasoningEffortCard(model, this.saveWizard(event.openId, wizard).id, wizard.cwd, wizard.mode) };
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
          const root = this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId);
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
          const session = this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId);
          if (!session) return errorCard("请在对应会话话题内刷新状态。");
          const card = sessionCard(this.sessionView(session), this.activeTurns.has(session.sessionId) ? "运行中" : "可继续");
          return event.openMessageId === session.rootMessageId ? { delivery: "replace", card } : { delivery: "reply", rootMessageId: session.rootMessageId, card };
        }
        case "session_toggle_mode": {
          const session = this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId);
          if (!session) return errorCard("请在对应会话话题内切换模式。");
          if (this.activeTurns.has(session.sessionId) || (session.rootMessageId && this.db.runningTaskForRoot(session.rootMessageId))) return errorCard("当前回合正在运行；请完成或取消后再切换模式。");
          const mode = session.collaborationMode === "plan" ? "default" : "plan";
          this.db.setCollaborationMode(session.sessionId, mode);
          const updated = this.db.getSession(session.sessionId)!;
          const card = sessionCard(this.sessionView(updated), this.activeTurns.has(updated.sessionId) ? "运行中" : "可继续");
          return event.openMessageId === updated.rootMessageId ? { delivery: "replace", card } : { delivery: "reply", rootMessageId: updated.rootMessageId!, card };
        }
        case "cancel_run": {
          const sessionId = typeof event.value.sessionId === "string" ? event.value.sessionId : "";
          const session = this.db.getSession(sessionId) ?? this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId);
          if (!session) return errorCard("当前会话没有可取消的桥接任务。");
          const cancelled = await this.cancelSessionWork(session.sessionId, session.rootMessageId, "cancelled from card");
          if (!this.activeTurns.has(session.sessionId) && !cancelled) return errorCard("当前会话没有可取消的桥接任务。");
          if (session.rootMessageId) void this.updateRunCard(session.sessionId, session.rootMessageId, "正在取消", "已向 Codex 发送取消信号。", false);
          const card = rootCardSession ? sessionCard(this.sessionView(rootCardSession), "可继续") : runStatusCard("正在取消", "已向 Codex 发送取消信号。");
          return rootCardSession && event.openMessageId === rootCardSession.rootMessageId
            ? { delivery: "replace", card }
            : session.rootMessageId ? { delivery: "reply", rootMessageId: session.rootMessageId, card } : { delivery: "send", card };
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
          await this.cancelSessionWork(grant.sessionId, null, "Root authorization was declined");
          return { delivery: "replace", card: remoteRequestResolvedCard("Root 授权已拒绝", "该任务已取消；不会影响其他任务。", false) };
        }
        case "root_revoke": return errorCard("Root 授权是一次性任务授权，无会话级权限可撤销。");

        case "turn_review": {
          const session = this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId);
          if (!session) return errorCard("当前会话不可用。");
          const turn = this.db.activeTurn(session.sessionId);
          const latest = turn ?? this.db.latestTurn(session.sessionId) ?? (this.activeTurns.get(session.sessionId) ?? null);
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
    if (normalized === "/") { await this.respondCard(message, commandMenuCard()); return; }
    if (["/help", "help", "帮助", "?", "？", "/home", "控制台"].includes(normalized)) {
      await this.respondCard(message, normalized === "/help" || normalized === "help" || normalized === "帮助" || normalized === "?" || normalized === "？" ? helpCard() : homeCard(this.cardStatus()));
      return;
    }
    if (!sessionInTopic && ["新建", "/new"].includes(normalized)) {
      await this.respondCard(message, this.projectCard(this.beginNewWizard(message.senderOpenId, message.chatId)));
      return;
    }
    if (!sessionInTopic && ["项目", "/projects"].includes(normalized)) {
      await this.respondCard(message, this.projectCard(this.beginNewWizard(message.senderOpenId, message.chatId)));
      return;
    }
    if (["会话", "最近", "/sessions"].includes(normalized)) { await this.respondCard(message, this.recentCard()); return; }
    if (normalized === "/search" || normalized.startsWith("/search ")) {
      const query = [...command.slice(7).trim()].slice(0, 120).join("");
      await this.respondCard(message, this.recentCard(query));
      return;
    }
    if (["状态", "/status"].includes(normalized)) { await this.respondCard(message, homeCard(this.cardStatus())); return; }
    if (["同步", "/sync"].includes(normalized)) {
      await this.respondCard(message, homeCard(this.cardStatus(), "已启动全量扫描"));
      void this.syncAll();
      return;
    }
    if (["暂停", "/pause"].includes(normalized)) {
      this.db.setSetting("sync.paused", "1");
      await this.respondCard(message, homeCard(this.cardStatus(), "同步已暂停"));
      return;
    }
    if (["恢复", "/resume-sync"].includes(normalized)) {
      this.db.setSetting("sync.paused", "0");
      await this.respondCard(message, homeCard(this.cardStatus(), "同步已恢复"));
      void this.syncAll();
      return;
    }
    if (["重试", "/retry"].includes(normalized)) {
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
      return;
    }
    if (["取消", "/cancel"].includes(normalized)) {
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
    if (command === "/model" || command === "模型") {
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
            if (claimed.turnId && this.appServer) await this.appServer.request("turn/steer", { threadId: claimed.sessionId, expectedTurnId: claimed.turnId, input: [{ type: "text", text: command }] });
          })().catch((error) => this.db.recordFailure("remote_guidance", { nonce: claimed.nonce }, error));
          return;
        }
      }
      const remoteInput = session ? this.db.nextServerRequest(session.sessionId, "user_input") : null;
      if (remoteInput && command) {
        const claimed = this.db.claimServerRequest(remoteInput.nonce, message.senderOpenId, message.chatId, this.appServer?.appServerEpoch ?? -1);
        if (claimed) {
          await this.respondCard(message, remoteRequestResolvedCard("输入已提交", "Codex 正在继续处理。"));
          void this.resolveRemoteRequest(claimed, "accept", command).catch((error) => this.db.recordFailure("remote_input", { nonce: claimed.nonce }, error));
          return;
        }
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
      `活动 Codex 任务：${this.activeTurns.size}`,
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
      expectedSessionId: null, syncStatus: "none", lastSyncOffset: null,
    };
    if (!this.db.enqueueTask(task)) return;
    const cardId = await this.respondCard(message, runStatusCard("已排队", `正在创建 Codex 会话：${relative(this.config.allowedRoot, cwd) || "."}`));
    this.db.updateTask(task.id, "pending", { runCardMessageId: cardId });
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

  private async drainPendingTasks(): Promise<void> {
    for (const sessionId of this.db.pendingTaskSessionIds()) void this.drainTaskQueue(sessionId);
  }

  private async drainTaskQueue(sessionId: string | null): Promise<void> {
    const workerKey = sessionId ?? "__new__";
    if (this.taskWorkers.has(workerKey) || this.paused()) return;
    this.taskWorkers.add(workerKey);
    try {
      while (!this.paused()) {
        const session = sessionId ? this.db.getSession(sessionId) : null;
        if (session && this.activeTurns.has(session.sessionId)) return;
        if (session && await this.hasLocalActiveSession(session)) return;
        const task = this.db.claimNextTask(sessionId);
        if (!task) return;
        if (task.kind === "resume") await this.executeResumeTask(task);
        else await this.executeNewTask(task);
      }
    } finally {
      this.taskWorkers.delete(workerKey);
    }
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

  private async enqueueResumeTask(session: NonNullable<ReturnType<BridgeDatabase["getSession"]>>, message: IncomingFeishuMessage, prompt: string): Promise<void> {
    const selectedModel = session.model ?? null;
    const selectedEffort = session.reasoningEffort ?? null;
    const configured = selectedModel !== null && selectedEffort !== null;
    const task: QueuedTask = {
      id: randomUUID(), kind: "resume", sessionId: session.sessionId, cwd: session.cwd, prompt, imageKeys: message.imageKeys,
      sourceMessageId: message.messageId, chatId: message.chatId, rootMessageId: session.rootMessageId,
      model: configured ? selectedModel : null, reasoningEffort: configured ? selectedEffort : null, status: "pending", runCardMessageId: null,
      expectedSessionId: session.sessionId, syncStatus: "none", lastSyncOffset: null,
    };
    if (!this.db.enqueueTask(task)) return;
    if (!session.rootMessageId) { this.db.updateTask(task.id, "failed", { error: "session root unavailable" }); return; }
    await this.updateRunCard(session.sessionId, session.rootMessageId, "已排队", "消息已进入会话队列。", true);
    const status = this.db.getRunStatus(session.sessionId);
    this.db.updateTask(task.id, "pending", { runCardMessageId: status?.messageId ?? null });
    void this.drainTaskQueue(session.sessionId);
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

  private appServerOutcomeUncertain(error: unknown): boolean { const text = error instanceof Error ? error.message : String(error); return /timed out|exited|not running|closed|stdin|write/i.test(text); }

  private resolveTurnExecutionPolicy(mode: "plan" | "default", canonicalCwd: string, rootAuthorized = false): { mode: "plan" | "default"; rootMode: boolean; approvalPolicy: "never" | "on-request"; sandboxPolicy: Record<string, unknown> } {
    if (mode === "plan") return { mode, rootMode: false, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    const rootMode = this.config.executionMode === "root-danger-full-access" && rootAuthorized;
    return rootMode
      ? { mode, rootMode, approvalPolicy: "on-request", sandboxPolicy: { type: "dangerFullAccess" } }
      : { mode, rootMode, approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [canonicalCwd], networkAccess: false } };
  }

  private async executeAppServerNewTask(task: QueuedTask): Promise<void> {
    if (!this.appServer) return;
    try {
      const canonicalCwd = await resolveAllowedPath(task.cwd, this.config.allowedRoot);
      const execution = this.resolveTurnExecutionPolicy("default", canonicalCwd, false);
      const response = this.asRecord(await this.appServer.request("thread/start", { cwd: canonicalCwd,
        approvalPolicy: execution.approvalPolicy, sandboxPolicy: execution.sandboxPolicy,
        ...(task.model ? { model: task.model } : {}), ...(task.reasoningEffort ? { effort: task.reasoningEffort } : {}) }));
      const thread = this.asRecord(response.thread);
      const sessionId = this.stringAt(thread, "id") ?? this.stringAt(response, "threadId", "thread_id");
      if (!sessionId) throw new Error("Codex app-server thread/start returned no thread id");
      const metadata: SessionMetadata = { sessionId, path: join(this.sessionsDir, "app-server", `${sessionId}.jsonl`), cwd: canonicalCwd,
        startedAt: new Date().toISOString(), source: "appServer", firstUserText: task.prompt,
        title: this.stringAt(thread, "name") ?? shortText(task.prompt), collaborationMode: "default", model: task.model, reasoningEffort: task.reasoningEffort };
      this.db.upsertSession(metadata);
      const session = this.db.getSession(sessionId)!;
      const rootId = await this.ensureRoot(task.chatId, session);
      this.db.updateTask(task.id, "running", { sessionId, expectedSessionId: sessionId });
      await this.updateRunCard(sessionId, rootId, "已创建", "Codex 会话已创建，正在准备执行。", true);
      await this.executeAppServerTurn({ ...task, sessionId, rootMessageId: rootId, expectedSessionId: sessionId });
    } catch (error) {
      const uncertain = this.appServerOutcomeUncertain(error);
      this.db.updateTask(task.id, uncertain ? "interrupted" : "failed", { error: shortText(String(error), MAX_ERROR_CHARS) });
      this.db.recordFailure("app_server_new", { taskId: task.id }, error);
      if (task.runCardMessageId) await this.feishu.updateCard(task.runCardMessageId, runStatusCard(uncertain ? "已中断" : "失败", uncertain ? "app-server 结果不确定，任务不会自动重放。" : shortText(String(error), MAX_ERROR_CHARS)));
    }
  }

  private async executeAppServerResumeTask(task: QueuedTask): Promise<void> {
    const session = task.sessionId ? this.db.getSession(task.sessionId) : null;
    if (!session?.rootMessageId) { this.db.updateTask(task.id, "failed", { error: "session unavailable" }); return; }
    try {
      const canonicalCwd = await resolveAllowedPath(session.cwd, this.config.allowedRoot);
      const execution = this.resolveTurnExecutionPolicy(session.collaborationMode === "plan" ? "plan" : "default", canonicalCwd, false);
      await this.appServer!.request("thread/resume", { threadId: session.sessionId, cwd: canonicalCwd, approvalPolicy: execution.approvalPolicy, sandboxPolicy: execution.sandboxPolicy });
      await this.executeAppServerTurn(task);
    } catch (error) {
      const uncertain = this.appServerOutcomeUncertain(error);
      this.db.updateTask(task.id, uncertain ? "interrupted" : "failed", { error: shortText(String(error), MAX_ERROR_CHARS) });
      this.db.recordFailure("app_server_resume", { sessionId: session.sessionId, taskId: task.id }, error);
      await this.updateRunCard(session.sessionId, session.rootMessageId, uncertain ? "已中断" : "失败", uncertain ? "app-server 结果不确定，任务不会自动重放。" : shortText(String(error), MAX_ERROR_CHARS), false);
    }
  }

  private rememberTurnImages(turnId: string, paths: string[]): void {
    if (!paths.length) return;
    let existing: string[] = [];
    try { existing = JSON.parse(this.db.getSetting(`turn.${turnId}.images`) ?? "[]") as string[]; } catch { /* replace malformed state */ }
    this.db.setSetting(`turn.${turnId}.images`, JSON.stringify([...existing, ...paths]));
  }

  private async executeAppServerTurn(task: QueuedTask): Promise<void> {
    if (!this.appServer || !task.sessionId) return;
    const session = this.db.getSession(task.sessionId);
    if (!session?.rootMessageId) throw new Error("session root unavailable");
    const mode = session.collaborationMode === "plan" ? "plan" : "default";
    const canonicalCwd = await resolveAllowedPath(session.cwd, this.config.allowedRoot);
    let rootAuthorized = false;
    const rootModeRequested = mode === "default" && this.config.executionMode === "root-danger-full-access";
    if (rootModeRequested) {
      if (!this.rootExecutionReady) throw new Error("Root execution is disabled because container preflight failed");
      const existing = this.db.getTaskRootGrantForTask(task.id);
      const canRun = existing?.status === "approved" && this.db.consumeTaskRootGrant(task.id, session.sessionId, canonicalCwd, this.appServer.appServerEpoch);
      rootAuthorized = canRun;
      if (!canRun) {
        const grant = existing?.status === "pending" ? existing : this.db.createTaskRootGrant({
          nonce: randomUUID(), taskId: task.id, sessionId: session.sessionId, canonicalCwd,
          openId: this.boundOpenId() ?? "", chatId: task.chatId, epoch: this.appServer.appServerEpoch,
          expiresAt: Date.now() + (this.config.rootGrantTtlMs ?? 600_000),
        });
        this.db.updateTask(task.id, "awaiting_root_consent", { sessionId: session.sessionId });
        await this.updateRunCard(session.sessionId, session.rootMessageId, "等待 Root 授权", "Root 模式需要本任务的一次性授权。", false);
        await this.feishu.replyCard(session.rootMessageId, rootGrantCard(grant.nonce, canonicalCwd, shortText(task.prompt, 500), grant.expiresAt));
        return;
      }
    }
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
    const response = this.asRecord(await this.appServer.request("turn/start", params));
    const turn = this.asRecord(response.turn);
    const turnId = this.stringAt(turn, "id") ?? this.stringAt(response, "turnId", "turn_id");
    if (!turnId) { await Promise.all(imagePaths.map((path) => rm(path, { force: true }))); throw new Error("Codex app-server turn/start returned no turn id"); }
    const state: TurnState = { sessionId: session.sessionId, turnId, epoch: this.appServer.appServerEpoch, mode, state: "running", text: "", plan: "", rootMessageId: session.rootMessageId, startedAtMs: Date.now(), inputHash: textHash(task.prompt) };
    this.activeTurns.set(session.sessionId, state); this.db.saveTurn(state);
    this.db.upsertAppServerDelivery({ sessionId: session.sessionId, turnId, role: "user", startedAtMs: state.startedAtMs ?? null, contentHash: textHash(task.prompt), contentBytes: Buffer.byteLength(task.prompt, "utf8"), sourceMessageId: task.sourceMessageId });
    this.db.updateTask(task.id, "running", { sessionId: session.sessionId, turnId });
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
    const active = this.activeTurns.get(session.sessionId);
    if (active && this.appServer) {
      const paths = await this.downloadImages(message, message.imageKeys);
      try {
        await this.appServer.request("turn/steer", { threadId: session.sessionId, expectedTurnId: active.turnId,
          input: [{ type: "text", text: userPrompt }, ...paths.map((path) => ({ type: "localImage", path }))] });
        this.rememberTurnImages(active.turnId, paths);
        await this.respond(message, "已发送给当前 Codex 回合。");
        return;
      } catch (error) {
        await Promise.all(paths.map((path) => rm(path, { force: true })));
        console.warn("turn/steer unavailable; queueing next turn", error);
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
    await this.enqueueResumeTask(session, {
      messageId: sourceMessageId, chatId: this.boundChatId() ?? "", chatType: "group", rootId: state.rootId,
      senderOpenId: this.boundOpenId() ?? "", mentionedBot: true, text: answerPrompt, imageKeys: [],
    }, answerPrompt);
  }

  private async cancel(message: IncomingFeishuMessage): Promise<void> {
    const session = message.rootId ? this.db.getSessionByRoot(message.rootId) : null;
    const key = session?.sessionId;
    const cancelled = await this.cancelSessionWork(key ?? null, message.rootId ?? null, "cancelled by user");
    if (!key || (!this.activeTurns.has(key) && !cancelled)) {
      await this.respond(message, "当前话题没有由桥接服务启动的活动任务。");
      return;
    }
    await this.respond(message, cancelled ? "已取消排队任务；正在运行的任务也会停止。" : "已发送取消信号。");
  }
}
