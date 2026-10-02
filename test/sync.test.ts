import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexAppServer, JsonRpcMessage } from "../src/app-server.js";
import { CodexCliProbe } from "../src/codex.js";
import { BridgeDatabase } from "../src/db.js";
import { parseJsonlChunk } from "../src/session-parser.js";
import { forbiddenRemoteQuestion, SyncService } from "../src/sync.js";
import type { BridgeConfig, FeishuPort, IncomingFeishuMessage, ModelCapability } from "../src/types.js";

const catalog: ModelCapability[] = [
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "coding", defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", description: "fast", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
];

class FakeFeishu implements FeishuPort {
  roots: string[] = [];
  texts: string[] = [];
  files: Array<{ name: string; data: Buffer }> = [];
  async start(_handler: (message: IncomingFeishuMessage) => Promise<void>): Promise<void> {}
  cards: Record<string, unknown>[] = [];
  updated: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  deleted: string[] = [];
  async createSessionRoot(chatId: string, title: string, detail: string, card?: Record<string, unknown>) {
    this.roots.push(`${title}\n${detail}`); if (card) this.cards.push(card);
    return { messageId: "root-1", appLink: "https://example.test/root-1", chatId, threadId: "thread-1" };
  }
  async replyText(_root: string, text: string): Promise<string> { this.texts.push(text); return `text-${this.texts.length}`; }
  async replyFile(_root: string, name: string, data: Buffer): Promise<string> {
    this.files.push({ name, data }); return `file-${this.files.length}`;
  }
  async downloadImage(): Promise<Buffer> { return Buffer.alloc(0); }
  async sendText(_chat: string, text: string): Promise<string> { this.texts.push(text); return `text-${this.texts.length}`; }
  async sendCard(_chat: string, card: Record<string, unknown>): Promise<string> { this.cards.push(card); return `card-${this.cards.length}`; }
  async replyCard(_root: string, card: Record<string, unknown>): Promise<string> { this.cards.push(card); return `card-${this.cards.length}`; }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> { this.updated.push({ messageId, card }); }
  async deleteMessage(messageId: string): Promise<void> { this.deleted.push(messageId); }
  async getMessageMetadata(_messageId: string) { return { chatId: "chat-1", threadId: "thread-1", appLink: "https://example.test/root-1" }; }
}

function cardAction(action: string, value: Record<string, unknown> = {}, formValues: Record<string, unknown> = {}) {
  return { openId: "user-1", chatId: "chat-1", openMessageId: "card-1", action, value, formValues };
}

function inbound(overrides: Partial<IncomingFeishuMessage> = {}): IncomingFeishuMessage {
  return {
    messageId: "message-1", chatId: "chat-1", chatType: "group", senderOpenId: "user-1", mentionedBot: true,
    text: "帮助", imageKeys: [], ...overrides,
  };
}

function choice(question: string) {
  return {
    id: "request-1", sessionId: "session-1", timestamp: "2026-08-04T00:00:00Z", expiresAt: Date.now() + 1_000,
    questions: [{ id: "confirm", header: "确认", question, options: [{ label: "允许", description: "继续" }, { label: "不允许", description: "停止" }] }],
  };
}

test("allows bounded public-information confirmations as cards", () => {
  assert.equal(forbiddenRemoteQuestion(choice("是否允许联网查看候选项目最近提交，以判断是否仍在维护？")), false);
  assert.equal(forbiddenRemoteQuestion(choice("是否修改已授权工作目录中的配置文件？")), false);
});

test("rejects remote privilege and authentication confirmations", () => {
  assert.equal(forbiddenRemoteQuestion(choice("是否允许使用 sudo 安装系统软件？")), true);
  assert.equal(forbiddenRemoteQuestion(choice("请提供登录验证码以继续。")), true);
  assert.equal(forbiddenRemoteQuestion(choice("是否绕过 sandbox 限制？")), true);
  assert.equal(forbiddenRemoteQuestion(choice("是否上传私密本地数据到外部服务？")), true);
});

test("full sync creates one topic, visible messages, and exact archive without duplicates", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-sync-"));
  try {
    const codexHome = join(home, ".codex");
    const sessions = join(codexHome, "sessions", "2026", "08", "03");
    const stateDir = join(home, "state");
    await mkdir(sessions, { recursive: true });
    const path = join(sessions, "session.jsonl");
    const records = [
      { timestamp: "2026-08-03T00:00:00Z", type: "session_meta", payload: { session_id: "session-1", cwd: home, timestamp: "2026-08-03T00:00:00Z", source: "cli" } },
      { timestamp: "2026-08-03T00:00:01Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "secret" }] } },
      { timestamp: "2026-08-03T00:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] } },
      { timestamp: "2026-08-03T00:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] } },
      { timestamp: "2026-08-03T00:00:04Z", type: "event_msg", payload: { type: "task_complete" } },
    ];
    const raw = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await writeFile(path, raw);
    const config: BridgeConfig = {
      appId: "app", appSecret: "secret", allowedRoot: home, codexHome, codexBin: "/bin/false",
      stateDir, bindToken: "token", scanIntervalMs: 1000, activeSessionQuietMs: 1,
    };
    const db = new BridgeDatabase(stateDir);
    db.setSetting("feishu.chat_id", "chat-1"); db.setSetting("feishu.open_id", "user-1");
    const feishu = new FakeFeishu();
    const service = new SyncService(config, db, feishu, new CodexCliProbe("/bin/false", codexHome));
    (service as unknown as { models: ModelCapability[] }).models = catalog;
    await service.syncAll();
    assert.equal(feishu.roots.length, 1);
    assert.equal(db.getSession("session-1")?.rootAppLink, "https://example.test/root-1");
    assert.deepEqual(feishu.texts.filter((text) => text.startsWith("用户") || text.startsWith("Codex")), ["用户\nquestion"]);
    assert.equal(feishu.cards.some((card) => (card.header as { title: { content: string } }).title.content === "Codex"), true);
    assert.equal(feishu.files.length, 0);
    assert.match(feishu.roots[0]!, /原始日志仅保存在本机/);
    const counts = { roots: feishu.roots.length, texts: feishu.texts.length, files: feishu.files.length };
    await service.syncAll();
    assert.deepEqual({ roots: feishu.roots.length, texts: feishu.texts.length, files: feishu.files.length }, counts);
    const projects = await service.onCardAction(cardAction("projects"));
    assert.equal(((projects.card ?? projects).header as { title: { content: string } }).title.content, "1/4 选择项目");
    const wizard = JSON.parse(db.getSetting("wizard.new.user-1") ?? "{}") as { id: string };
    const selected = await service.onCardAction(cardAction("select_project", { cwd: home, wizardId: wizard.id }));
    assert.equal(((selected.card ?? selected).header as { title: { content: string } }).title.content, "2/4 选择模型");
    assert.match(db.getSetting("wizard.new.user-1") ?? "", new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const modelCard = await service.onCardAction(cardAction("select_model", { model: "gpt-5.6-sol", wizardId: wizard.id }));
    assert.equal(((modelCard.card ?? modelCard).header as { title: { content: string } }).title.content, "3/4 选择思考强度");
    const ready = await service.onCardAction(cardAction("select_reasoning_effort", { effort: "high", wizardId: wizard.id }));
    assert.equal(((ready.card ?? ready).header as { title: { content: string } }).title.content, "4/4 输入任务");
    assert.match(db.getSetting("wizard.new.user-1") ?? "", /"reasoningEffort":"high"/);
    const emptyTask = await service.onCardAction(cardAction("submit_task", { wizardId: wizard.id }));
    assert.equal(((emptyTask.card ?? emptyTask).header as { title: { content: string } }).title.content, "操作失败");
    assert.ok(db.getSetting("wizard.new.user-1"));
    let submissions = 0;
    (service as unknown as { runNewSessionFromWizard: (_wizard: unknown) => Promise<void> }).runNewSessionFromWizard = async () => { submissions += 1; };
    const submitted = await service.onCardAction(cardAction("submit_task", { wizardId: wizard.id }, { task_prompt: "card task" }));
    assert.equal(((submitted.card ?? submitted).header as { title: { content: string } }).title.content, "Codex 运行状态");
    assert.equal(db.getSetting("wizard.new.user-1"), null);
    assert.equal(submissions, 1);
    const duplicate = await service.onCardAction(cardAction("submit_task", { wizardId: wizard.id }, { task_prompt: "card task" }));
    assert.equal(((duplicate.card ?? duplicate).header as { title: { content: string } }).title.content, "操作失败");
    assert.equal(submissions, 1);
    const stale = await service.onCardAction(cardAction("select_model", { model: "gpt-5.6-luna", wizardId: "old" }));
    assert.equal(((stale.card ?? stale).header as { title: { content: string } }).title.content, "操作失败");
    await service.onFeishuMessage(inbound({ messageId: "help-1" }));
    assert.equal((feishu.cards.at(-1)?.header as { title: { content: string } }).title.content, "Codex 使用帮助");
    const cardCount = feishu.cards.length;
    await service.onFeishuMessage(inbound({ messageId: "not-mentioned", mentionedBot: false }));
    assert.equal(feishu.cards.length, cardCount);
    await service.onFeishuMessage(inbound({ messageId: "slash-menu", mentionedBot: false, text: "/" }));
    assert.equal((feishu.cards.at(-1)?.header as { title: { content: string } }).title.content, "Codex 命令菜单");
    await service.onFeishuMessage(inbound({ messageId: "slash-search", mentionedBot: false, text: "/search question" }));
    assert.match(JSON.stringify(feishu.cards.at(-1)), /question/);
    const menuCards = feishu.cards.length;
    await service.onBotMenuAction({ eventId: "menu-1", openId: "user-1", eventKey: "codex.search" });
    await service.onBotMenuAction({ eventId: "menu-1", openId: "user-1", eventKey: "codex.search" });
    assert.equal(feishu.cards.length, menuCards + 1);
    assert.ok(db.getSessionByRoot("root-1"));
    await service.onFeishuMessage(inbound({ messageId: "model-text", rootId: "root-1", mentionedBot: false, text: "/model gpt-5.6-luna max" }));
    assert.equal(db.getSession("session-1")?.model, "gpt-5.6-luna");
    assert.equal(db.getSession("session-1")?.reasoningEffort, "max");
    await service.onFeishuMessage(inbound({ messageId: "model-card", rootId: "root-1", mentionedBot: false, text: "/model" }));
    assert.equal((feishu.cards.at(-1)?.header as { title: { content: string } }).title.content, "设置会话模型");
    const modelBeforeMenu = db.getSession("session-1")?.model;
    await service.onBotMenuAction({ eventId: "menu-home", openId: "user-1", eventKey: "codex.home" });
    assert.equal(db.getSession("session-1")?.model, modelBeforeMenu);
    const cardsBeforeUnknown = feishu.cards.length;
    await service.onFeishuMessage(inbound({ messageId: "unknown-command", mentionedBot: false, text: "/unknown" }));
    assert.equal(feishu.cards.length, cardsBeforeUnknown + 1);
    assert.equal((feishu.cards.at(-1)?.header as { title: { content: string } }).title.content, "Codex 命令菜单");
    await service.onCardAction(cardAction("new"));
    assert.ok(db.getSetting("wizard.new.user-1"));
    let continued = 0;
    (service as unknown as { continueSession: (_message: IncomingFeishuMessage) => Promise<void> }).continueSession = async () => { continued += 1; };
    await service.onFeishuMessage(inbound({ messageId: "topic-free-text", rootId: "root-1", mentionedBot: false, text: "直接展示文件内容" }));
    assert.equal(continued, 1);
    const rootAction = await service.onCardAction({ ...cardAction("new"), openMessageId: "root-1" });
    assert.equal(((rootAction.card ?? rootAction).header as { title: { content: string } }).title.content, "操作失败");
    assert.equal(rootAction.delivery, "reply");
    const foreignCard = await service.onCardAction({ ...cardAction("new"), chatId: "other-chat" });
    assert.equal(foreignCard.delivery, "none");
    db.deleteSetting("wizard.new.user-1");
    assert.equal(db.hasMessage("topic-not-mentioned"), false);
    const textCount = feishu.texts.length;
    await service.onFeishuMessage(inbound({
      messageId: "topic-not-mentioned", rootId: "root-1", mentionedBot: false, text: "/cancel",
    }));
    assert.ok(feishu.texts.length > textCount);
    assert.equal(db.hasMessage("topic-not-mentioned"), true);
    assert.match(feishu.texts.at(-1) ?? "", /当前话题没有由桥接服务启动的活动任务/);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an appended assistant reply is delivered once after the initial user-only scan", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-append-"));
  try {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    const codexHome = join(home, ".codex");
    const sessions = join(codexHome, "sessions", "2026", "08", "04");
    const path = join(sessions, `rollout-2026-08-04T00-00-00-${sessionId}.jsonl`);
    const config: BridgeConfig = { appId: "app", appSecret: "secret", allowedRoot: home, codexHome, codexBin: "/bin/false", stateDir: join(home, "state"), bindToken: "token", scanIntervalMs: 1_000, activeSessionQuietMs: 1 };
    await mkdir(sessions, { recursive: true });
    const initial = [
      { timestamp: "2026-08-04T00:00:00Z", type: "session_meta", payload: { session_id: sessionId, cwd: home, timestamp: "2026-08-04T00:00:00Z", source: "cli" } },
      { timestamp: "2026-08-04T00:00:01Z", type: "event_msg", payload: { type: "task_started" } },
      { timestamp: "2026-08-04T00:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
    ];
    await writeFile(path, `${initial.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const db = new BridgeDatabase(config.stateDir);
    db.setSetting("feishu.chat_id", "chat-1"); db.setSetting("feishu.open_id", "user-1");
    const feishu = new FakeFeishu();
    const service = new SyncService(config, db, feishu, new CodexCliProbe("/bin/false", codexHome));
    await service.syncAll();
    const appended = [
      { timestamp: "2026-08-04T00:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "world" }] } },
      { timestamp: "2026-08-04T00:00:04Z", type: "event_msg", payload: { type: "task_complete" } },
    ];
    await writeFile(path, `${initial.concat(appended).map((record) => JSON.stringify(record)).join("\n")}\n`);
    await service.syncAll();
    await service.syncAll();
    assert.equal(feishu.cards.filter((card) => (card.header as { title: { content: string } }).title.content === "Codex").length, 1);
    assert.equal(db.getCursor(path).parsedOffset, (await stat(path)).size);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("removes previously mirrored subagent messages and clears stale local activity", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-subagent-"));
  try {
    const codexHome = join(home, ".codex");
    const sessions = join(codexHome, "sessions", "2026", "08", "04");
    const stateDir = join(home, "state");
    await mkdir(sessions, { recursive: true });
    const parentId = "11111111-1111-1111-1111-111111111111";
    const childId = "22222222-2222-2222-2222-222222222222";
    const subagentPath = join(sessions, `rollout-2026-08-04T00-00-00-${childId}.jsonl`);
    const content = `${JSON.stringify({ timestamp: "2026-08-04T00:00:00Z", type: "session_meta", payload: { session_id: parentId, cwd: home, timestamp: "2026-08-04T00:00:00Z", source: "cli" } })}\n${JSON.stringify({ timestamp: "2026-08-04T00:00:01Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "subagent output" }] } })}\n`;
    await writeFile(subagentPath, content);
    const config: BridgeConfig = { appId: "app", appSecret: "secret", allowedRoot: home, codexHome, codexBin: "/bin/false", stateDir, bindToken: "token", scanIntervalMs: 1_000, activeSessionQuietMs: 1 };
    const db = new BridgeDatabase(stateDir);
    const feishu = new FakeFeishu();
    const service = new SyncService(config, db, feishu, new CodexCliProbe("/bin/false", codexHome));
    const childMessage = parseJsonlChunk(content, "", parentId).messages[0]!;
    db.saveMessage(childMessage.id, parentId, "outbound", "feishu-subagent-message");
    const mixedPath = join(sessions, `rollout-2026-08-04T00-00-02-${parentId}.jsonl`);
    const mixedContent = `${JSON.stringify({ timestamp: "2026-08-04T00:00:00Z", type: "session_meta", payload: { session_id: parentId, cwd: home, timestamp: "2026-08-04T00:00:00Z", source: "cli" } })}\n${JSON.stringify({ timestamp: "2026-08-04T00:00:01Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "parent output" }] } })}\n${JSON.stringify({ timestamp: "2026-08-04T00:00:02Z", type: "session_meta", payload: { session_id: childId, cwd: home, timestamp: "2026-08-04T00:00:02Z", source: "cli" } })}\n${JSON.stringify({ timestamp: "2026-08-04T00:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "nested subagent output" }] } })}\n`;
    await writeFile(mixedPath, mixedContent);
    const nestedMessage = parseJsonlChunk(mixedContent.split("\n").slice(2).join("\n")).messages[0]!;
    db.saveMessage(nestedMessage.id, childId, "outbound", "feishu-nested-subagent-message");
    await (service as unknown as { purgeSubagentMessages: () => Promise<void> }).purgeSubagentMessages();
    assert.deepEqual(feishu.deleted.sort(), ["feishu-nested-subagent-message", "feishu-subagent-message"]);
    assert.equal(db.getMessage(childMessage.id)?.recallState, "recalled");
    assert.equal(db.getMessage(nestedMessage.id)?.recallState, "recalled");
    const parentPath = join(sessions, `rollout-2026-08-04T00-00-01-${parentId}.jsonl`);
    await writeFile(parentPath, content.replace(childId, parentId));
    db.upsertSession({ sessionId: parentId, path: parentPath, cwd: home, startedAt: "2026-08-04T00:00:00Z", source: "cli", firstUserText: "" });
    db.setSetting(`session.${parentId}.active`, "1");
    await utimes(parentPath, new Date(0), new Date(0));
    await (service as unknown as { clearStaleActiveSessions: () => Promise<void> }).clearStaleActiveSessions();
    assert.equal(db.getSetting(`session.${parentId}.active`), "0");
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("uses the most recent cached model catalog when the CLI refresh fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-model-cache-"));
  try {
    const config: BridgeConfig = {
      appId: "app", appSecret: "secret", allowedRoot: home, codexHome: join(home, ".codex"), codexBin: "/bin/false",
      stateDir: join(home, "state"), bindToken: "token", scanIntervalMs: 1_000, activeSessionQuietMs: 1,
    };
    const db = new BridgeDatabase(config.stateDir);
    db.setSetting("codex.model_catalog.v1", JSON.stringify(catalog));
    const unavailableCodex = { listModels: async () => { throw new Error("offline"); } } as unknown as CodexCliProbe;
    const service = new SyncService(config, db, new FakeFeishu(), unavailableCodex);
    await (service as unknown as { refreshModels: () => Promise<boolean> }).refreshModels();
    assert.deepEqual((service as unknown as { models: ModelCapability[] }).models, catalog);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("binding sends one control card immediately", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-bind-"));
  try {
    const config: BridgeConfig = {
      appId: "app", appSecret: "secret", allowedRoot: home, codexHome: join(home, ".codex"), codexBin: "/bin/false",
      stateDir: join(home, "state"), bindToken: "token", scanIntervalMs: 1_000, activeSessionQuietMs: 1,
    };
    const db = new BridgeDatabase(config.stateDir);
    const feishu = new FakeFeishu();
    const service = new SyncService(config, db, feishu, new CodexCliProbe("/bin/false", config.codexHome));
    await service.onFeishuMessage(inbound({ text: "/bind token" }));
    assert.equal(db.getSetting("feishu.chat_id"), "chat-1");
    assert.equal(feishu.cards.length, 1);
    assert.equal((feishu.cards[0]?.header as { title: { content: string } }).title.content, "Codex 控制台");
    await service.onFeishuMessage(inbound({ messageId: "bind-duplicate", text: "/bind token" }));
    assert.equal(feishu.cards.filter((card) => (card.header as { title?: { content?: string } } | undefined)?.title?.content === "Codex 控制台").length, 1);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

// --- Topic replies, echo suppression and questions answered in other frontends ---

const baseMs = Date.now() - 60_000;
const at = (seconds: number) => new Date(baseMs + seconds * 1_000).toISOString();
const jsonl = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const userRecord = (seconds: number, text: string) => ({ timestamp: at(seconds), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const assistantRecord = (seconds: number, text: string) => ({ timestamp: at(seconds), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const eventRecord = (seconds: number, type: string) => ({ timestamp: at(seconds), type: "event_msg", payload: { type } });
const questionRecord = (seconds: number, callId: string) => ({ timestamp: at(seconds), type: "response_item", payload: {
  type: "function_call", name: "request_user_input", call_id: callId,
  arguments: JSON.stringify({ questions: [{ id: "scope", header: "范围", question: "处理哪些内容？", options: [{ label: "完整", description: "全部" }, { label: "精简", description: "重点" }] }] }),
} });
const answerRecord = (seconds: number, callId: string) => ({ timestamp: at(seconds), type: "response_item", payload: { type: "function_call_output", call_id: callId, output: "完整" } });

type Internals = {
  turnCoordinator: { hasActiveTurn(sessionId: string): boolean };
  onAppServerNotification(message: JsonRpcMessage): Promise<void>;
  onAppServerRequest(message: JsonRpcMessage): Promise<unknown>;
  continueSession(message: IncomingFeishuMessage): Promise<void>;
};

function title(card: Record<string, unknown> | undefined): string {
  return (card?.header as { title?: { content?: string } } | undefined)?.title?.content ?? "";
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeAppServer(reply: (method: string) => unknown = () => ({})) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = {
    appServerEpoch: 1,
    getHealth: () => ({ state: "healthy", epoch: 1, sinceMs: 0 }),
    request: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return reply(method); },
    unsubscribeThread: async () => undefined,
    interrupt: async () => undefined,
  } as unknown as CodexAppServer;
  return { server, calls };
}

/** Imports one local Codex session so that its Feishu topic root is `root-1`. */
async function importedSession(home: string, records: unknown[], options: { appServer?: CodexAppServer; activeSessionQuietMs?: number } = {}) {
  const sessionId = "44444444-4444-4444-4444-444444444444";
  const codexHome = join(home, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "05");
  const path = join(sessions, `rollout-2026-08-05T00-00-00-${sessionId}.jsonl`);
  await mkdir(sessions, { recursive: true });
  const meta = { timestamp: at(0), type: "session_meta", payload: { session_id: sessionId, cwd: home, timestamp: at(0), source: "cli" } };
  await writeFile(path, jsonl([meta, ...records]));
  const config: BridgeConfig = {
    appId: "app", appSecret: "secret", allowedRoot: home, codexHome, codexBin: "/bin/false", stateDir: join(home, "state"),
    bindToken: "token", scanIntervalMs: 1_000, activeSessionQuietMs: options.activeSessionQuietMs ?? 1,
  };
  const db = new BridgeDatabase(config.stateDir);
  db.setSetting("feishu.chat_id", "chat-1"); db.setSetting("feishu.open_id", "user-1");
  const feishu = new FakeFeishu();
  const service = new SyncService(config, db, feishu, new CodexCliProbe("/bin/false", codexHome), options.appServer);
  await service.syncAll();
  return { service, db, feishu, path, sessionId, internals: service as unknown as Internals };
}

test("plain words in a session topic go to Codex while slash commands still reach the bridge", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-topic-words-"));
  try {
    const { service, db, feishu, internals } = await importedSession(home, [userRecord(1, "hello"), assistantRecord(2, "world"), eventRecord(3, "task_complete")]);
    const continued: string[] = [];
    internals.continueSession = async (message) => { continued.push(message.text); };
    const words = ["重试", "暂停", "状态", "?", "取消", "模型", "恢复", "同步", "帮助"];
    for (const [index, text] of words.entries()) {
      await service.onFeishuMessage(inbound({ messageId: `topic-word-${index}`, rootId: "root-1", mentionedBot: false, text }));
    }
    assert.deepEqual(continued, words);
    assert.notEqual(db.getSetting("sync.paused"), "1");
    await service.onFeishuMessage(inbound({ messageId: "topic-slash-pause", rootId: "root-1", mentionedBot: false, text: "/pause" }));
    assert.equal(db.getSetting("sync.paused"), "1");
    await service.onFeishuMessage(inbound({ messageId: "root-status", text: "状态" }));
    assert.equal(title(feishu.cards.at(-1)), "Codex 控制台");
    assert.equal(continued.length, words.length);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("topic replies and messages added to a running turn are not posted again after import", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-echo-"));
  try {
    const appServer = fakeAppServer((method) => method === "turn/start" ? { turn: { id: "turn-1" } } : {});
    const { service, db, feishu, path, sessionId, internals } = await importedSession(home,
      [userRecord(1, "hello"), assistantRecord(2, "world"), eventRecord(3, "task_complete")], { appServer: appServer.server });
    const echoes = () => feishu.texts.filter((text) => text.startsWith("用户\n"));
    assert.deepEqual(echoes(), ["用户\nhello"]);
    await service.onFeishuMessage(inbound({ messageId: "topic-1", rootId: "root-1", mentionedBot: false, text: "继续优化" }));
    await waitFor(() => internals.turnCoordinator.hasActiveTurn(sessionId));
    await service.onFeishuMessage(inbound({ messageId: "topic-2", rootId: "root-1", mentionedBot: false, text: "顺便更新文档" }));
    assert.deepEqual(appServer.calls.map((call) => call.method), ["thread/resume", "turn/start", "turn/steer"]);
    await internals.onAppServerNotification({ method: "turn/completed", params: { threadId: sessionId, turn: { id: "turn-1", status: "completed" } } });
    await appendFile(path, jsonl([eventRecord(10, "task_started"), userRecord(11, "继续优化"), assistantRecord(12, "已优化"),
      userRecord(13, "顺便更新文档"), assistantRecord(14, "文档已更新"), eventRecord(15, "task_complete")]));
    await service.syncAll();
    assert.deepEqual(echoes(), ["用户\nhello"]);
    // The marker is used once: the same words typed later in the terminal are shown.
    await appendFile(path, jsonl([userRecord(20, "继续优化")]));
    await service.syncAll();
    assert.deepEqual(echoes(), ["用户\nhello", "用户\n继续优化"]);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a question answered in the same log batch never becomes a pending Feishu question", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-answered-question-"));
  try {
    const { service, db, feishu, internals } = await importedSession(home, [eventRecord(1, "task_started"), userRecord(2, "开始"),
      questionRecord(3, "call-done"), answerRecord(4, "call-done"), assistantRecord(5, "好的"), eventRecord(6, "task_complete")]);
    assert.equal(feishu.cards.some((card) => title(card).startsWith("Codex 等待你的选择")), false);
    const continued: string[] = [];
    internals.continueSession = async (message) => { continued.push(message.text); };
    await service.onFeishuMessage(inbound({ messageId: "topic-next", rootId: "root-1", mentionedBot: false, text: "下一步" }));
    assert.deepEqual(continued, ["下一步"]);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a question answered later in the terminal closes its card and stops capturing topic replies", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-terminal-answer-"));
  try {
    const { service, db, feishu, path, sessionId, internals } = await importedSession(home,
      [eventRecord(1, "task_started"), userRecord(2, "开始"), questionRecord(3, "call-q1")]);
    const questionCard = feishu.cards.findIndex((card) => title(card) === "Codex 等待你的选择 1/1");
    assert.ok(questionCard >= 0);
    const cardMessageId = db.getMessage("call-q1")?.feishuMessageId;
    assert.equal(cardMessageId, `card-${questionCard + 1}`);
    await appendFile(path, jsonl([answerRecord(4, "call-q1"), assistantRecord(5, "收到"), eventRecord(6, "task_complete")]));
    await service.syncAll();
    assert.ok(feishu.updated.some((update) => update.messageId === cardMessageId && title(update.card) === "问题已在其它地方处理"));
    assert.equal(db.listChoices(sessionId).length, 0);
    const continued: string[] = [];
    internals.continueSession = async (message) => { continued.push(message.text); };
    await service.onFeishuMessage(inbound({ messageId: "topic-after-answer", rootId: "root-1", mentionedBot: false, text: "1" }));
    assert.deepEqual(continued, ["1"]);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a Feishu answer queued behind a waiting terminal is withdrawn when the terminal answers first", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-queued-answer-"));
  try {
    const { service, db, feishu, path, sessionId } = await importedSession(home,
      [eventRecord(1, "task_started"), userRecord(2, "开始"), questionRecord(3, "call-q2")], { activeSessionQuietMs: 60_000 });
    assert.equal(db.getSetting(`session.${sessionId}.active`), "1");
    await service.onFeishuMessage(inbound({ messageId: "topic-answer", rootId: "root-1", mentionedBot: false, text: "1" }));
    await waitFor(() => feishu.texts.some((text) => text.includes("你的回答已排队")));
    assert.equal(db.taskStateCounts().pending, 1);
    assert.equal(db.listSettings(`choice_task.${sessionId}.`).length, 1);
    await appendFile(path, jsonl([answerRecord(4, "call-q2"), assistantRecord(5, "按完整处理"), eventRecord(6, "task_complete")]));
    await service.syncAll();
    assert.equal(db.taskStateCounts().pending, undefined);
    assert.equal(db.taskStateCounts().cancelled, 1);
    assert.equal(db.listSettings(`choice_task.${sessionId}.`).length, 0);
    assert.ok(feishu.updated.some((update) => JSON.stringify(update.card).includes("你在飞书里的回答没有发送")));
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("native Codex questions show their options and collect every answer within the turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-native-question-"));
  try {
    const appServer = fakeAppServer();
    const { service, db, feishu, path, sessionId, internals } = await importedSession(home,
      [userRecord(1, "hello"), assistantRecord(2, "world"), eventRecord(3, "task_complete")], { appServer: appServer.server });
    db.enqueueTask({ id: "task-q", kind: "resume", sessionId, cwd: home, prompt: "整理", imageKeys: [], sourceMessageId: "source-q", chatId: "chat-1",
      rootMessageId: "root-1", model: null, reasoningEffort: null, status: "running", runCardMessageId: null, expectedSessionId: sessionId,
      syncStatus: "none", lastSyncOffset: null });
    db.updateTask("task-q", "running", { turnId: "turn-q" });
    const answered = internals.onAppServerRequest({ jsonrpc: "2.0", id: 7, method: "item/tool/requestUserInput", params: {
      threadId: sessionId, turnId: "turn-q", itemId: "call-native", questions: [
        { id: "scope", header: "范围", question: "处理哪些内容？", options: [{ label: "完整", description: "全部" }, { label: "精简", description: "重点" }] },
        { id: "note", header: "备注", question: "还有什么要求？", options: [] },
      ],
    } });
    await waitFor(() => db.nextServerRequest(sessionId, "user_input") !== null);
    const nonce = db.nextServerRequest(sessionId, "user_input")!.nonce;
    const card = feishu.cards.find((item) => title(item) === "Codex 等待你的回答 1/2");
    assert.ok(card);
    assert.match(JSON.stringify(card), /精简/);
    assert.doesNotMatch(JSON.stringify(card), /批准一次/);
    const next = await service.onCardAction(cardAction("remote_answer", { nonce, questionIndex: 0, optionIndex: 1 }));
    assert.equal(next.delivery, "replace");
    assert.equal(title(next.card), "Codex 等待你的回答 2/2");
    await service.onFeishuMessage(inbound({ messageId: "topic-note", rootId: "root-1", mentionedBot: false, text: "只看 src 目录" }));
    assert.equal(title(feishu.cards.at(-1)), "回答已提交");
    assert.deepEqual(await answered, { answers: { scope: { answers: ["精简"] }, note: { answers: ["只看 src 目录"] } } });
    assert.equal(db.getServerRequest(nonce)?.status, "resolved");
    // The logged tool call of this bridge-asked question must not produce a second card.
    await appendFile(path, jsonl([eventRecord(10, "task_started"), questionRecord(11, "call-native")]));
    await service.syncAll();
    assert.equal(feishu.cards.some((item) => title(item).startsWith("Codex 等待你的选择")), false);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});
