import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { assistantMarkdownCard, choiceAcceptedCard, choiceCancelledCard, choiceCard, commandMenuCard, errorCard, helpCard, homeCard, modelCard, projectsCard, reasoningEffortCard, recentSessionsCard, runStatusCard, serviceCard, sessionCard, wizardReadyCard } from "./cards.js";
import { CodexRunner } from "./codex.js";
import { BridgeDatabase } from "./db.js";
import { messageAppLink } from "./feishu.js";
import { resolveAllowedPath } from "./path-policy.js";
import { parseJsonlChunk } from "./session-parser.js";
import type { BridgeConfig, CardActionOutcome, CardDefinition, ChoiceRequest, FeishuPort, IncomingBotMenuAction, IncomingCardAction, IncomingFeishuMessage, ModelCapability, QueuedTask, SessionMetadata } from "./types.js";

const MAX_ERROR_CHARS = 3_000;
const MAX_INLINE_MESSAGE_BYTES = 45_000;
const PENDING_PROMPT_TTL_MS = 10 * 60_000;
const MODEL_CATALOG_KEY = "codex.model_catalog.v1";
const LOG_SYNC_ATTEMPTS = 10;
const LOG_SYNC_RETRY_MS = 500;

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

function imageExtension(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (data[0] === 0xff && data[1] === 0xd8) return ".jpg";
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return ".gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return ".image";
}

async function jsonlFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}

function sessionIdFromPath(path: string): string | null {
  return basename(path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null;
}

function isSubagentSource(source: string): boolean {
  return /(?:^|[._:-])subagent(?:$|[._:-])|delegated?_agent/i.test(source);
}

export class SyncService {
  private readonly sessionsDir: string;
  private watcher: FSWatcher | null = null;
  private readonly fileQueues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly taskWorkers = new Set<string>();
  private syncing: Promise<void> | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private messageLinkPermissionDenied = false;
  private models: ModelCapability[] = [];

  constructor(
    private readonly config: BridgeConfig,
    private readonly db: BridgeDatabase,
    private readonly feishu: FeishuPort,
    private readonly codex: CodexRunner,
  ) {
    this.sessionsDir = join(config.codexHome, "sessions");
  }

  async start(): Promise<void> {
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
    await mkdir(this.sessionsDir, { recursive: true });
    this.watcher = watch(this.sessionsDir, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } });
    this.watcher.on("add", (path) => this.queueFile(path));
    this.watcher.on("change", (path) => this.queueFile(path));
    this.watcher.on("error", (error) => console.error("Session watcher error", error));
    this.scanTimer = setInterval(() => {
      if (!this.boundChatId() || this.paused()) return;
      void this.syncAll();
      void this.drainPendingTasks();
      void this.reconcileAwaitingSyncTasks();
    }, this.config.scanIntervalMs);
    this.scanTimer.unref();
    if (this.boundChatId()) {
      void this.reconcileExistingState().then(() => this.syncAll()).catch((error) => {
        this.db.recordFailure("reconcile_existing_state", {}, error);
      });
      void this.reconcileAwaitingSyncTasks();
      void this.ensureControlCard();
      void this.backfillSessionLinks();
    }
  }

  async stop(): Promise<void> {
    for (const controller of this.activeRuns.values()) controller.abort();
    if (this.scanTimer) clearInterval(this.scanTimer);
    await this.watcher?.close();
    await Promise.allSettled([...(this.syncing ? [this.syncing] : []), ...this.fileQueues.values()]);
    const deadline = Date.now() + 10_000;
    while (this.activeRuns.size && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
  }

  private queueFile(path: string): void {
    void this.enqueueFile(path);
  }

  private enqueueFile(path: string): Promise<void> {
    if (!path.endsWith(".jsonl") || !this.boundChatId() || this.paused()) return Promise.resolve();
    const previous = this.fileQueues.get(path) ?? Promise.resolve();
    const next = previous.then(() => this.processFile(path)).catch((error) => {
      this.db.recordFailure("process_file", { path }, error);
      console.error(`Failed to process ${path}`, error);
    }).finally(() => {
      if (this.fileQueues.get(path) === next) this.fileQueues.delete(path);
    });
    this.fileQueues.set(path, next);
    return next;
  }

  async syncAll(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      if (!this.boundChatId() || this.paused()) return;
      for (const path of await jsonlFiles(this.sessionsDir)) await this.enqueueFile(path);
    })().catch((error) => {
      this.db.recordFailure("sync_all", {}, error);
      throw error;
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async reconcileExistingState(): Promise<void> {
    await this.reconcileSessionFiles();
    await this.clearStaleActiveSessions();
    await this.purgeSubagentMessages();
    await this.restoreRootCards();
  }

  private async reconcileSessionFiles(): Promise<void> {
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
  }

  private async clearStaleActiveSessions(): Promise<void> {
    const cutoff = Date.now() - this.config.activeSessionQuietMs;
    for (const sessionId of this.db.listActiveSessionIds()) {
      if (this.activeRuns.has(sessionId)) continue;
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
  }

  private async restoreRootCards(): Promise<void> {
    for (const session of this.db.listSessions()) {
      if (!session.rootMessageId) continue;
      try {
        await this.feishu.updateCard(session.rootMessageId, sessionCard(session, this.activeRuns.has(session.sessionId) ? "运行中" : "可继续"));
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
      const metadata: SessionMetadata = { ...batch.metadata, path, firstUserText: firstUser };
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
      if (message.role === "progress" && !this.activeRuns.has(session.sessionId)) continue;
      const label = message.role === "user" ? "用户" : message.role === "assistant" ? "Codex" : "进度";
      let feishuId: string;
      if (Buffer.byteLength(message.text, "utf8") > MAX_INLINE_MESSAGE_BYTES) {
        const preview = shortText(message.text, 1_000);
        await this.feishu.replyText(rootId, `${label}（正文过长，完整内容见附件）\n${preview}`);
        feishuId = await this.feishu.replyFile(rootId, `${session.sessionId.slice(0, 8)}-${message.id.slice(0, 12)}.md`, Buffer.from(message.text));
      } else if (message.role === "assistant") {
        feishuId = await this.feishu.replyCard(rootId, assistantMarkdownCard(message.text));
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
      const timer = setTimeout(() => this.queueFile(path), 300);
      timer.unref();
    }
  }

  private async ensureRoot(chatId: string, session: SessionMetadata & { rootMessageId: string | null; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }): Promise<string> {
    if (session.rootMessageId) return session.rootMessageId;
    const title = `[${basename(session.cwd) || "home"}] ${shortText(session.firstUserText || "Codex 会话")} · ${session.sessionId.slice(0, 8)}`;
    const detail = `开始：${session.startedAt}\n目录：${session.cwd}\n来源：${session.source}\n原始日志仅保存在本机。`;
    const root = await this.feishu.createSessionRoot(chatId, title, detail, sessionCard(session));
    this.db.setSessionRoot(session.sessionId, root.messageId, root.appLink, root.chatId, root.threadId);
    this.db.setSessionCardMessage(session.sessionId, root.messageId);
    return root.messageId;
  }

  private cardStatus(): { paused: boolean; sessions: number; active: number; failures: number } {
    return { paused: this.paused(), sessions: this.db.listSessions().length, active: this.activeRuns.size, failures: this.db.failureCount() };
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
    if (event.openId !== this.boundOpenId() || event.chatId !== this.boundChatId()) return { delivery: "none" };
    try {
      const rootCardSession = this.db.getSessionByRoot(event.openMessageId);
      if (rootCardSession && !["session_model", "session_status", "cancel_run"].includes(event.action)) {
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
            return sessionCard({ ...this.db.getSession(current.sessionId)! }, "可继续");
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
          const card = sessionCard(session, this.activeRuns.has(session.sessionId) ? "运行中" : "可继续");
          return event.openMessageId === session.rootMessageId ? { delivery: "replace", card } : { delivery: "reply", rootMessageId: session.rootMessageId, card };
        }
        case "cancel_run": {
          const sessionId = typeof event.value.sessionId === "string" ? event.value.sessionId : "";
          const session = this.db.getSession(sessionId) ?? this.db.getSessionByRoot(event.openMessageId) ?? this.db.getSessionByCardMessage(event.openMessageId);
          if (!session) return errorCard("当前会话没有可取消的桥接任务。");
          const cancelled = this.db.cancelPendingTasks(session.rootMessageId, session.sessionId);
          if (!this.activeRuns.has(session.sessionId) && !cancelled) return errorCard("当前会话没有可取消的桥接任务。");
          this.activeRuns.get(session.sessionId)?.abort();
          if (session.rootMessageId) void this.updateRunCard(session.sessionId, session.rootMessageId, "正在取消", "已向 Codex 发送取消信号。", false);
          const card = rootCardSession ? sessionCard(rootCardSession, "运行中") : runStatusCard("正在取消", "已向 Codex 发送取消信号。");
          return rootCardSession && event.openMessageId === rootCardSession.rootMessageId
            ? { delivery: "replace", card }
            : session.rootMessageId ? { delivery: "reply", rootMessageId: session.rootMessageId, card } : { delivery: "send", card };
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
        case "retry":
          this.db.resolveInfrastructureFailures();
          this.messageLinkPermissionDenied = false;
          await this.refreshModels();
          void this.syncAll();
          void this.backfillSessionLinks();
          return homeCard(this.cardStatus(), this.models.length ? "正在重试未完成任务，模型目录已刷新" : "模型目录仍不可用；请稍后再次 /retry");
        default: return errorCard(`未知卡片操作：${event.action}`);
      }
    } catch (error) {
      this.db.recordFailure("card_action", { action: event.action, openMessageId: event.openMessageId }, error);
      return errorCard(error instanceof Error ? error.message : String(error));
    }
  }

  async onFeishuMessage(message: IncomingFeishuMessage): Promise<void> {
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
    if (this.db.hasMessage(message.messageId)) return;
    this.db.saveMessage(message.messageId, "_control", "inbound", message.messageId);

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
      this.db.resolveInfrastructureFailures();
      this.messageLinkPermissionDenied = false;
      await this.refreshModels();
      await this.respondCard(message, homeCard(this.cardStatus(), this.models.length ? "正在重试未完成任务，模型目录已刷新" : "模型目录仍不可用；请稍后再次 /retry"));
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
    const chatId = this.boundChatId();
    if (!chatId || action.openId !== this.boundOpenId()) return;
    const dedupeId = `bot-menu:${action.eventId}`;
    if (this.db.hasMessage(dedupeId)) return;
    this.db.saveMessage(dedupeId, "_control", "inbound_menu", null);
    const cards: Record<string, () => CardDefinition> = {
      "codex.home": () => homeCard(this.cardStatus()),
      "codex.new": () => this.models.length ? this.projectCard(this.beginNewWizard(action.openId, chatId)) : errorCard("模型目录暂不可用。请使用 /retry 刷新。"),
      "codex.sessions": () => this.recentCard(),
      "codex.search": () => this.recentCard(),
      "codex.service": () => serviceCard(this.cardStatus()),
    };
    const build = cards[action.eventKey];
    if (build) await this.feishu.sendCard(chatId, build());
    else console.warn(`Ignored unknown Feishu bot menu event key: ${action.eventKey}`);
  }

  private statusText(): string {
    return [
      `状态：${this.paused() ? "已暂停" : "运行中"}`,
      `已索引会话：${this.db.listSessions().length}`,
      `活动 Codex 任务：${this.activeRuns.size}`,
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
    const tempDir = join(this.config.stateDir, "tmp");
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    for (const imageKey of imageKeys) {
      const data = await this.feishu.downloadImage(message.messageId, imageKey);
      const path = join(tempDir, `${randomUUID()}${imageExtension(data)}`);
      await writeFile(path, data, { mode: 0o600 });
      imagePaths.push(path);
    }
    return imagePaths;
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

  private async findSessionLog(sessionId: string): Promise<string | null> {
    const suffix = `${sessionId}.jsonl`;
    return (await jsonlFiles(this.sessionsDir)).find((path) => path.endsWith(suffix)) ?? null;
  }

  private async syncTaskLog(task: QueuedTask, sessionId: string): Promise<boolean> {
    const path = (this.db.getSession(sessionId)?.path) ?? await this.findSessionLog(sessionId);
    if (!path) {
      this.db.updateTask(task.id, "awaiting_sync", { expectedSessionId: sessionId, syncStatus: "awaiting" });
      console.info(`Codex log not available yet task=${task.id.slice(0, 8)} session=${sessionId.slice(0, 8)}`);
      return false;
    }
    await this.enqueueFile(path);
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
    const session = task.sessionId ? this.db.getSession(task.sessionId) : null;
    if (!session || !session.rootMessageId) { this.db.updateTask(task.id, "failed", { error: "session unavailable" }); return; }
    const controller = new AbortController();
    this.activeRuns.set(session.sessionId, controller);
    const imagePaths: string[] = [];
    try {
      const cwd = await resolveAllowedPath(task.cwd, this.config.allowedRoot);
      imagePaths.push(...await this.downloadImages(this.taskMessage(task), task.imageKeys));
      await this.updateRunCard(session.sessionId, session.rootMessageId, "运行中", "已提交 Codex，正在处理。", true);
      this.queuePendingPrompt(session.sessionId, feishuPrompt(task.prompt), task.sourceMessageId);
      const result = await this.codex.run({ cwd, sessionId: session.sessionId, prompt: feishuPrompt(task.prompt), imagePaths, signal: controller.signal,
        ...(task.model ? { model: task.model } : {}), ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}) });
      if (result.exitCode !== 0) throw new Error(result.stderr || `Codex exited ${result.exitCode}`);
      await this.updateRunCard(session.sessionId, session.rootMessageId, "正在同步回复", "Codex 已完成，正在确认日志和话题回复。", false);
      if (await this.waitForTaskLog(task, session.sessionId)) {
        await this.updateRunCard(session.sessionId, session.rootMessageId, "完成", "本轮已完成，回复已同步到话题。", false);
      } else {
        await this.updateRunCard(session.sessionId, session.rootMessageId, "已执行，等待日志同步", "Codex 已完成；服务会继续同步回复，不会重复执行任务。", false);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.db.updateTask(task.id, "cancelled");
        await this.updateRunCard(session.sessionId, session.rootMessageId, "已取消", "本轮已取消。", false);
      } else {
        this.db.updateTask(task.id, "failed", { error: shortText(String(error), MAX_ERROR_CHARS) });
        this.db.recordFailure("codex_resume", { sessionId: session.sessionId, messageId: task.sourceMessageId }, error);
        await this.updateRunCard(session.sessionId, session.rootMessageId, "失败", shortText(String(error), MAX_ERROR_CHARS), false);
      }
    } finally {
      this.activeRuns.delete(session.sessionId);
      await Promise.all(imagePaths.map((path) => rm(path, { force: true })));
    }
  }

  private async executeNewTask(task: QueuedTask): Promise<void> {
    const controller = new AbortController();
    this.activeRuns.set(task.id, controller);
    const imagePaths: string[] = [];
    const message = this.taskMessage(task);
    try {
      imagePaths.push(...await this.downloadImages(message, task.imageKeys));
      const result = await this.codex.run({ cwd: task.cwd, prompt: task.prompt, imagePaths, signal: controller.signal,
        ...(task.model ? { model: task.model } : {}),
        ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}) });
      if (result.exitCode !== 0) throw new Error(result.stderr || `Codex exited ${result.exitCode}`);
      this.db.setSetting(this.pendingModelKey(result.sessionId), JSON.stringify({ model: task.model, reasoningEffort: task.reasoningEffort }));
      this.db.updateTask(task.id, "awaiting_sync", { expectedSessionId: result.sessionId, syncStatus: "awaiting" });
      if (task.runCardMessageId) await this.feishu.updateCard(task.runCardMessageId, runStatusCard("正在同步回复", "Codex 已完成，正在创建话题并同步回复。"));
      else await this.respond(message, `会话已创建：${result.sessionId}\n正在同步新话题和回复。`);
      if (await this.waitForTaskLog(task, result.sessionId)) {
        if (task.runCardMessageId) await this.feishu.updateCard(task.runCardMessageId, runStatusCard("完成", "会话已创建，回复已同步到新话题。"));
      } else if (task.runCardMessageId) {
        await this.feishu.updateCard(task.runCardMessageId, runStatusCard("已执行，等待日志同步", "Codex 已完成；服务会继续同步回复，不会重复执行任务。"));
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.db.updateTask(task.id, "cancelled");
        if (task.runCardMessageId) await this.feishu.updateCard(task.runCardMessageId, runStatusCard("已取消", "本轮已取消。"));
      } else {
        this.db.updateTask(task.id, "failed", { error: shortText(String(error), MAX_ERROR_CHARS) });
        this.db.recordFailure("codex_new", { cwd: task.cwd, messageId: task.sourceMessageId }, error);
        if (task.runCardMessageId) await this.feishu.updateCard(task.runCardMessageId, runStatusCard("失败", shortText(String(error), MAX_ERROR_CHARS)));
        else await this.respond(message, `Codex 创建失败：${shortText(String(error), MAX_ERROR_CHARS)}`);
      }
    } finally {
      this.activeRuns.delete(task.id);
      await Promise.all(imagePaths.map((path) => rm(path, { force: true })));
    }
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
    const cancelled = this.db.cancelPendingTasks(message.rootId ?? null, key ?? null);
    if (!key || (!this.activeRuns.has(key) && !cancelled)) {
      await this.respond(message, "当前话题没有由桥接服务启动的活动任务。");
      return;
    }
    this.activeRuns.get(key)?.abort();
    await this.respond(message, cancelled ? "已取消排队任务；正在运行的任务也会停止。" : "已发送取消信号。");
  }
}
