import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureCardUi } from "../src/card-kit.js";
import type { ClaudeBridgeConfig } from "../src/claude/config.js";
import { ClaudeBridgeDatabase } from "../src/claude/db.js";
import { projectFolderName } from "../src/claude/importer.js";
import { ClaudeRuntime } from "../src/claude/runtime.js";
import type { CardDefinition, FeishuPort, IncomingFeishuMessage } from "../src/types.js";
import { fakeQueries } from "./claude-fake-query.js";

configureCardUi(2);

const RECENT = "aaaaaaaa-0000-4000-8000-000000000001";
const FRESH = "bbbbbbbb-0000-4000-8000-000000000002";
const OLD = "cccccccc-0000-4000-8000-000000000003";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Reply { root: string; kind: "text" | "card" | "file"; id: string; text?: string; card?: CardDefinition; name?: string; data?: Buffer }

class FakeFeishu implements FeishuPort {
  roots: Array<{ id: string; card: CardDefinition | undefined }> = [];
  replies: Reply[] = [];
  sent: Array<{ kind: "text" | "card"; text?: string; card?: CardDefinition }> = [];
  updated: Array<{ id: string; card: CardDefinition }> = [];
  rejectCard: ((card: CardDefinition) => boolean) | null = null;
  private sequence = 0;
  private next(prefix: string): string { return `${prefix}-${++this.sequence}`; }
  async start(): Promise<void> {}
  async createSessionRoot(chatId: string, _title: string, _detail: string, card?: CardDefinition) {
    const id = this.next("root");
    this.roots.push({ id, card });
    return { messageId: id, appLink: `https://example.test/${id}`, chatId, threadId: `thread-${id}` };
  }
  async replyText(root: string, text: string): Promise<string> { const id = this.next("text"); this.replies.push({ root, kind: "text", id, text }); return id; }
  async replyFile(root: string, name: string, data: Buffer): Promise<string> { const id = this.next("file"); this.replies.push({ root, kind: "file", id, name, data }); return id; }
  async replyCard(root: string, card: CardDefinition): Promise<string> {
    if (this.rejectCard?.(card)) throw new Error("Feishu API 230099: card content is invalid");
    const id = this.next("card");
    this.replies.push({ root, kind: "card", id, card });
    return id;
  }
  async downloadImage(): Promise<Buffer> { return Buffer.alloc(0); }
  async sendText(_chat: string, text: string): Promise<string> { this.sent.push({ kind: "text", text }); return this.next("text"); }
  async sendCard(_chat: string, card: CardDefinition): Promise<string> { this.sent.push({ kind: "card", card }); return this.next("card"); }
  async updateCard(id: string, card: CardDefinition): Promise<void> { this.updated.push({ id, card }); }
  deleted: string[] = [];
  /** Message ids whose withdrawal fails, with the error Feishu would return. */
  undeletable = new Map<string, string>();
  async deleteMessage(id: string): Promise<void> {
    const failure = this.undeletable.get(id);
    if (failure) throw new Error(failure);
    this.deleted.push(id);
  }
  async getMessageMetadata() { return null; }
  repliesTo(root: string): Reply[] { return this.replies.filter((reply) => reply.root === root); }
}

function title(card: CardDefinition | undefined): string {
  return (card?.header as { title?: { content?: string } } | undefined)?.title?.content ?? "";
}

const iso = (ms: number) => new Date(ms).toISOString();
const common = (sessionId: string) => ({ sessionId, cwd: "/home/tester/project", version: "2.1.286", gitBranch: "main", entrypoint: "claude-vscode", isSidechain: false, userType: "external" });
const prompt = (sessionId: string, uuid: string, at: number, text: string) => ({ ...common(sessionId), type: "user", uuid, timestamp: iso(at), origin: { kind: "human" }, promptSource: "sdk", message: { role: "user", content: [{ type: "text", text }] } });
const reply = (sessionId: string, uuid: string, at: number, text: string, stop = "end_turn") => ({ ...common(sessionId), type: "assistant", uuid, timestamp: iso(at), message: { id: `msg-${uuid}`, model: "claude-opus-5-5", role: "assistant", stop_reason: stop, content: [{ type: "text", text }] } });
const toolUse = (sessionId: string, uuid: string, at: number, id: string, command: string) => ({ ...common(sessionId), type: "assistant", uuid, timestamp: iso(at), message: { id: `msg-${uuid}`, model: "claude-opus-5-5", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const toolResult = (sessionId: string, uuid: string, at: number, id: string) => ({ ...common(sessionId), type: "user", uuid, timestamp: iso(at), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition was not met in time: ${condition.toString().slice(0, 160)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const jsonl = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

const atCwd = (records: Array<Record<string, unknown>>, cwd: string) => records.map((record) => "cwd" in record ? { ...record, cwd } : record);

async function setup(prefix: string, syncDirs: string[] = [], overrides: Partial<ClaudeBridgeConfig> = {}) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const projects = join(home, ".claude", "projects", "-home-tester-project");
  await mkdir(projects, { recursive: true });
  // A real working directory, for sessions the bridge continues or starts.
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  const config: ClaudeBridgeConfig = { appId: "app", appSecret: "secret", bindToken: "token", claudeHome: join(home, ".claude"), stateDir: join(home, "state"),
    allowedRoot: home, claudeBin: "claude", runnerIdleMs: 60_000, historyDays: 3, syncDirs, scanIntervalMs: 60_000, livenessIntervalMs: 60_000, ...overrides };
  const db = new ClaudeBridgeDatabase(config.stateDir);
  const feishu = new FakeFeishu();
  const { factory, queries } = fakeQueries();
  const runtime = new ClaudeRuntime(config, db, feishu, factory);
  const path = (sessionId: string) => join(projects, `${sessionId}.jsonl`);
  type Internals = { presence: { scan(): Promise<void> }; checkLiveness(): Promise<void>; bootstrap(): Promise<void>; bootstrapping: Promise<void> | null };
  const internals = runtime as unknown as Internals;
  const message = (overrides: Partial<IncomingFeishuMessage>): IncomingFeishuMessage => ({
    messageId: `m-${Math.random()}`, chatId: "chat-1", chatType: "group", senderOpenId: "user-1", mentionedBot: true, text: "", imageKeys: [], ...overrides,
  });
  const bind = async () => { await runtime.onFeishuMessage(message({ text: "/bind token" })); await internals.bootstrapping; };
  /** A restarted service over the same state, for example with a different SYNC_DIRS. */
  type Restarted = Pick<ClaudeRuntime, "syncAll" | "renderSession" | "onCardAction" | "onFeishuMessage"> & { bootstrap(): Promise<void> };
  const restart = (overrides: Partial<ClaudeBridgeConfig>) => new ClaudeRuntime({ ...config, ...overrides }, db, feishu) as unknown as Restarted;
  const action = (name: string, value: Record<string, unknown> = {}, formValues: Record<string, unknown> = {}, openMessageId = "card-x") =>
    runtime.onCardAction({ openId: "user-1", chatId: "chat-1", openMessageId, action: name, value, formValues });
  return { home, project, projects, config, db, feishu, runtime, queries, path, internals, message, bind, restart, action,
    cleanup: async () => { await runtime.stop(); db.close(); await rm(home, { recursive: true, force: true }); } };
}

test("binding shows the latest turn of recent sessions, every turn of new ones, and only indexes old ones", async () => {
  const env = await setup("claude-bootstrap-");
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl([
      { type: "custom-title", customTitle: "登录页修复", sessionId: RECENT },
      prompt(RECENT, "r-p1", now - 2 * HOUR, "第一个问题"), reply(RECENT, "r-a1", now - 2 * HOUR + MINUTE, "第一个回答"),
      prompt(RECENT, "r-p2", now - HOUR, "第二个问题"), reply(RECENT, "r-a2", now - HOUR + MINUTE, "第二个回答"),
    ]));
    await writeFile(env.path(FRESH), jsonl([
      prompt(FRESH, "f-p1", now - 60_000, "新会话问题一"), reply(FRESH, "f-a1", now - 50_000, "回答一"),
      prompt(FRESH, "f-p2", now - 30_000, "新会话问题二"), toolUse(FRESH, "f-t1", now - 20_000, "toolu_1", "npm test"),
    ]));
    await writeFile(env.path(OLD), jsonl([prompt(OLD, "o-p1", now - 10 * DAY, "很久以前的问题"), reply(OLD, "o-a1", now - 10 * DAY + MINUTE, "很久以前的回答")]));
    await env.bind();

    assert.equal(title(env.feishu.sent.find((item) => item.kind === "card")?.card), "Claude 控制台");
    assert.equal(env.feishu.roots.length, 2);
    const recent = env.db.getSession(RECENT)!;
    const fresh = env.db.getSession(FRESH)!;
    assert.equal(title(env.feishu.roots.find((root) => root.id === recent.rootMessageId)?.card), "登录页修复");
    assert.deepEqual(env.feishu.repliesTo(recent.rootMessageId!).map((item) => item.kind === "text" ? item.text : title(item.card)),
      ["VS Code：第二个问题", "Claude · 已完成 · 用时 1分"]);
    assert.deepEqual(env.feishu.repliesTo(fresh.rootMessageId!).map((item) => item.kind === "text" ? item.text : title(item.card)),
      ["VS Code：新会话问题一", "Claude · 已完成 · 用时 10秒", "VS Code：新会话问题二", "Claude · 进行中"]);
    assert.equal(env.db.getSession(OLD)?.rootMessageId, null);
    assert.deepEqual(env.db.listRecentSessions(10).map((session) => session.sessionId), [FRESH, RECENT, OLD]);

    // New activity is mirrored incrementally: a finished turn updates its card, a new prompt adds a turn.
    await appendFile(env.path(FRESH), jsonl([toolResult(FRESH, "f-r1", now - 10_000, "toolu_1"), reply(FRESH, "f-a2", now - 5_000, "测试通过")]));
    await appendFile(env.path(RECENT), jsonl([prompt(RECENT, "r-p3", now, "第三个问题")]));
    await env.runtime.syncAll();
    const freshCards = env.feishu.repliesTo(fresh.rootMessageId!).filter((item) => item.kind === "card");
    const finished = env.feishu.updated.filter((update) => update.id === freshCards[1]?.id).at(-1)?.card;
    assert.equal(title(finished), "Claude · 已完成 · 用时 25秒");
    assert.match(JSON.stringify(finished), /测试通过/);
    assert.match(JSON.stringify(finished), /执行记录（1 项）/);
    assert.deepEqual(env.feishu.repliesTo(recent.rootMessageId!).slice(2).map((item) => item.kind === "text" ? item.text : title(item.card)),
      ["VS Code：第三个问题", "Claude · 进行中"]);
  } finally { await env.cleanup(); }
});

test("hook states update the root card, notify once while waiting, and close sessions whose process is gone", async () => {
  const env = await setup("claude-presence-");
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl([prompt(RECENT, "r-p1", now - HOUR, "问题"), reply(RECENT, "r-a1", now - HOUR + MINUTE, "回答")]));
    await env.bind();
    const root = env.db.getSession(RECENT)!.rootMessageId!;
    const presenceDir = join(env.config.stateDir, "presence");
    await mkdir(presenceDir, { recursive: true });
    const writePresence = (state: string, at: number, pid: number | null, message: string | null = null) => writeFile(join(presenceDir, `${RECENT}.json`), JSON.stringify({
      version: 1, sessionId: RECENT, event: state === "waiting" ? "Notification" : "UserPromptSubmit", state, notificationType: state === "waiting" ? "permission_prompt" : null,
      message, transcriptPath: env.path(RECENT), cwd: "/home/tester/project", source: null, reason: null, pid, pidStartTime: null, at }));

    await writePresence("waiting", Date.now(), process.pid, "Claude needs your permission to use Bash");
    await env.internals.presence.scan();
    await env.internals.presence.scan();
    const notices = env.feishu.repliesTo(root).filter((item) => item.kind === "text" && item.text?.startsWith("⏳"));
    assert.deepEqual(notices.map((item) => item.text), ["⏳ 这个会话在VS Code中等待你处理：Claude needs your permission to use Bash"]);
    assert.match(JSON.stringify(env.feishu.updated.filter((update) => update.id === root).at(-1)?.card), /VS Code 中等待你处理/);

    // Approving locally fires no hook; newer transcript records show the turn is running again.
    await appendFile(env.path(RECENT), jsonl([prompt(RECENT, "r-p2", Date.now() + 1_000, "继续")]));
    await env.runtime.syncAll();
    assert.equal(env.db.getSession(RECENT)?.presenceState, "running");
    assert.match(JSON.stringify(env.feishu.updated.filter((update) => update.id === root).at(-1)?.card), /VS Code 中运行中/);

    await writePresence("running", Date.now() + 2_000, 2_147_483_000);
    await env.internals.presence.scan();
    assert.equal(env.db.getSession(RECENT)?.presenceState, "running");
    await env.internals.checkLiveness();
    await env.runtime.renderSession(RECENT);
    assert.equal(env.db.getSession(RECENT)?.presenceState, "closed");
    assert.match(JSON.stringify(env.feishu.updated.filter((update) => update.id === root).at(-1)?.card), /未在本机打开/);
  } finally { await env.cleanup(); }
});

test("/export uploads the transcript, and plain words are commands only at the root", async () => {
  const env = await setup("claude-messages-");
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl([prompt(RECENT, "r-p1", now - 2 * HOUR, "第一个问题"), reply(RECENT, "r-a1", now - 2 * HOUR + MINUTE, "第一个回答"),
      prompt(RECENT, "r-p2", now - HOUR, "第二个问题"), reply(RECENT, "r-a2", now - HOUR + MINUTE, "第二个回答")]));
    await env.bind();
    const root = env.db.getSession(RECENT)!.rootMessageId!;
    assert.equal(env.feishu.sent.filter((item) => title(item.card) === "Claude 控制台").length, 1);

    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "/export" }));
    const file = env.feishu.repliesTo(root).find((item) => item.kind === "file");
    assert.ok(file?.name?.endsWith(`-${RECENT.slice(0, 8)}.md`));
    const markdownText = file?.data?.toString("utf8") ?? "";
    for (const text of ["第一个问题", "第一个回答", "第二个问题", "第二个回答"]) assert.ok(markdownText.includes(text));

    await env.runtime.onFeishuMessage(env.message({ text: "状态" }));
    assert.equal(env.feishu.sent.filter((item) => title(item.card) === "Claude 控制台").length, 2);
    await env.runtime.onFeishuMessage(env.message({ text: "随便说一句", mentionedBot: false }));
    assert.equal(env.feishu.sent.length, 3);
  } finally { await env.cleanup(); }
});

test("opening an indexed session creates its topic with the latest turn", async () => {
  const env = await setup("claude-open-");
  try {
    const now = Date.now();
    await writeFile(env.path(OLD), jsonl([prompt(OLD, "o-p1", now - 10 * DAY, "旧问题一"), reply(OLD, "o-a1", now - 10 * DAY + MINUTE, "旧回答一"),
      prompt(OLD, "o-p2", now - 9 * DAY, "旧问题二"), reply(OLD, "o-a2", now - 9 * DAY + MINUTE, "旧回答二")]));
    await env.bind();
    assert.equal(env.feishu.roots.length, 0);
    const recent = await env.runtime.onCardAction({ openId: "user-1", chatId: "chat-1", openMessageId: "card-x", action: "recent", value: {}, formValues: {} });
    assert.match(JSON.stringify(recent.card), /"action":"open_session"/);
    await env.runtime.onCardAction({ openId: "user-1", chatId: "chat-1", openMessageId: "card-x", action: "open_session", value: { sessionId: OLD }, formValues: {} });
    const root = env.db.getSession(OLD)!.rootMessageId!;
    assert.deepEqual(env.feishu.repliesTo(root).map((item) => item.kind === "text" ? item.text : title(item.card)), ["VS Code：旧问题二", "Claude · 已完成 · 用时 1分"]);
  } finally { await env.cleanup(); }
});

test("a stalled turn is shown as unfinished, and a rejected tool panel falls back to plain lines", async (t) => {
  // The simulated rejection is logged as a failure; keep it out of the test output.
  t.mock.method(console, "error", () => undefined);
  const env = await setup("claude-stale-");
  try {
    const now = Date.now();
    env.feishu.rejectCard = (card) => JSON.stringify(card).includes("collapsible_panel");
    await writeFile(env.path(RECENT), jsonl([prompt(RECENT, "r-p1", now - 2 * HOUR, "跑训练"), toolUse(RECENT, "r-t1", now - 2 * HOUR + MINUTE, "toolu_9", "python train.py")]));
    await env.bind();
    const cards = env.feishu.repliesTo(env.db.getSession(RECENT)!.rootMessageId!).filter((item) => item.kind === "card");
    assert.equal(cards.length, 1);
    assert.equal(title(cards[0]?.card), "Claude · 未完成");
    assert.match(JSON.stringify(cards[0]?.card), /执行记录（1 项）/);
    assert.doesNotMatch(JSON.stringify(cards[0]?.card), /collapsible_panel/);
    assert.equal(env.db.getSetting("cards.simple_tools"), "1");
  } finally { await env.cleanup(); }
});

test("SYNC_DIRS limits topics, lists and notices to sessions working in those directories", async () => {
  const env = await setup("claude-scope-", ["/home/tester/project"]);
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl(atCwd([prompt(RECENT, "r-p1", now - HOUR, "项目内的问题"), reply(RECENT, "r-a1", now - HOUR + MINUTE, "项目内的回答")], "/home/tester/project/app")));
    await writeFile(env.path(OLD), jsonl(atCwd([prompt(OLD, "o-p1", now - 2 * HOUR, "别处的问题"), reply(OLD, "o-a1", now - 2 * HOUR + MINUTE, "别处的回答")], "/home/tester/project-other")));
    await env.bind();
    assert.deepEqual(env.feishu.roots.map((root) => title(root.card)), ["项目内的问题"]);
    assert.equal(env.db.getSession(OLD)?.rootMessageId, null);
    const recent = await env.runtime.onCardAction({ openId: "user-1", chatId: "chat-1", openMessageId: "card-x", action: "recent", value: {}, formValues: {} });
    assert.match(JSON.stringify(recent.card), /项目内的问题/);
    assert.doesNotMatch(JSON.stringify(recent.card), /别处的问题/);
    const home = await env.runtime.onCardAction({ openId: "user-1", chatId: "chat-1", openMessageId: "card-x", action: "home", value: {}, formValues: {} });
    assert.match(JSON.stringify(home.card), /同步范围：\/home\/tester\/project/);
    assert.match(JSON.stringify(home.card), /已索引会话：\*\*1\*\*/);

    // Activity outside the scope stays local.
    await appendFile(env.path(OLD), jsonl(atCwd([prompt(OLD, "o-p2", now, "别处的新问题")], "/home/tester/project-other")));
    await env.runtime.syncAll();
    assert.equal(env.feishu.roots.length, 1);

    // Widening the scope creates no topic for past activity: Feishu can only append, and a topic
    // must appear in the order sessions were really used. The session's next turn opens it.
    const widened = env.restart({ syncDirs: [] });
    await widened.bootstrap();
    assert.equal(env.feishu.roots.length, 1);
    assert.equal(env.db.getSession(OLD)?.rootMessageId, null);
    await appendFile(env.path(OLD), jsonl(atCwd([prompt(OLD, "o-p3", now + MINUTE, "范围扩大后的问题")], "/home/tester/project-other")));
    await widened.syncAll();
    const other = env.db.getSession(OLD)!;
    assert.equal(env.feishu.roots.at(-1)?.id, other.rootMessageId);
    assert.deepEqual(env.feishu.repliesTo(other.rootMessageId!).map((item) => item.kind === "text" ? item.text : title(item.card)),
      ["VS Code：范围扩大后的问题", "Claude · 进行中"]);
  } finally { await env.cleanup(); }
});

test("narrowing the scope marks topics instead of deleting them, and widening it again continues them in place", async () => {
  const env = await setup("claude-scope-mark-");
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl(atCwd([prompt(RECENT, "r-p1", now - HOUR, "项目内"), reply(RECENT, "r-a1", now - HOUR + MINUTE, "好")], "/home/tester/project")));
    await writeFile(env.path(OLD), jsonl(atCwd([prompt(OLD, "o-p1", now - 2 * HOUR, "别处"), reply(OLD, "o-a1", now - 2 * HOUR + MINUTE, "好")], "/home/tester/elsewhere")));
    await env.bind();
    const other = env.db.getSession(OLD)!.rootMessageId!;
    const repliesBefore = env.feishu.replies.length;

    const narrowed = env.restart({ syncDirs: ["/home/tester/project"] });
    await narrowed.bootstrap();
    assert.match(title(env.feishu.updated.filter((update) => update.id === other).at(-1)?.card), /已移出同步范围/);
    assert.equal(env.feishu.updated.filter((update) => update.id === other).length, 1);
    await appendFile(env.path(OLD), jsonl(atCwd([prompt(OLD, "o-p2", now, "别处的新问题")], "/home/tester/elsewhere")));
    await narrowed.syncAll();
    await narrowed.renderSession(OLD);
    assert.equal(env.feishu.replies.length, repliesBefore);
    assert.equal(env.feishu.updated.filter((update) => update.id === other).length, 1);

    const widened = env.restart({ syncDirs: [] });
    await widened.bootstrap();
    assert.doesNotMatch(title(env.feishu.updated.filter((update) => update.id === other).at(-1)?.card), /已移出同步范围/);
    await appendFile(env.path(OLD), jsonl(atCwd([prompt(OLD, "o-p3", now + MINUTE, "回到范围内")], "/home/tester/elsewhere")));
    await widened.syncAll();
    assert.equal(env.feishu.roots.length, 2);
    assert.deepEqual(env.feishu.repliesTo(other).filter((item) => item.kind === "text").map((item) => item.text), ["VS Code：别处", "VS Code：回到范围内"]);
  } finally { await env.cleanup(); }
});

test("cleanup withdraws the bridge's messages in out-of-scope topics after confirmation and reports what stays", async () => {
  const env = await setup("claude-cleanup-");
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl(atCwd([prompt(RECENT, "r-p1", now - HOUR, "项目内"), reply(RECENT, "r-a1", now - HOUR + MINUTE, "好")], "/home/tester/project")));
    await writeFile(env.path(OLD), jsonl(atCwd([prompt(OLD, "o-p1", now - 2 * HOUR, "别处"), reply(OLD, "o-a1", now - 2 * HOUR + MINUTE, "好")], "/home/tester/elsewhere")));
    await writeFile(env.path(FRESH), jsonl(atCwd([prompt(FRESH, "f-p1", now - 3 * HOUR, "另一处"), reply(FRESH, "f-a1", now - 3 * HOUR + MINUTE, "好")], "/home/tester/third")));
    await env.bind();
    const other = env.db.getSession(OLD)!;
    const third = env.db.getSession(FRESH)!;
    await env.runtime.onFeishuMessage(env.message({ rootId: other.rootMessageId!, mentionedBot: false, text: "/stop" }));
    const otherMessages = [other.rootMessageId!, ...env.feishu.repliesTo(other.rootMessageId!).map((item) => item.id)];
    // The third topic's root is too old to withdraw.
    env.feishu.undeletable.set(third.rootMessageId!, "Feishu API 230009: Message has expired when recall message.");
    // A reply someone already withdrew in Feishu counts as done.
    const thirdReply = env.feishu.repliesTo(third.rootMessageId!)[0]!.id;
    env.feishu.undeletable.set(thirdReply, "Feishu API 230110: Action unavailable as the message has been deleted.");

    const narrowed = env.restart({ syncDirs: ["/home/tester/project"] });
    await narrowed.bootstrap();
    const action = (name: string, value: Record<string, unknown> = {}) => narrowed.onCardAction({ openId: "user-1", chatId: "chat-1", openMessageId: "card-x", action: name, value, formValues: {} });
    assert.match(JSON.stringify((await action("home")).card), /清理范围外话题（2）/);
    const preview = (await action("cleanup_preview")).card;
    assert.equal(title(preview), "清理 2 个范围外话题");
    assert.equal(env.feishu.deleted.length, 0);
    const nonce = JSON.parse(env.db.getSetting("cleanup.pending")!).nonce as string;
    assert.equal(title((await action("cleanup_confirm", { nonce: "stale" })).card), "清理已过期");
    assert.equal(title((await action("cleanup_confirm", { nonce })).card), "正在清理");
    await waitUntil(() => env.feishu.sent.some((item) => title(item.card) === "范围外话题清理完成"));

    // Replies go first and the root last; the whole topic of the reachable session is gone.
    assert.deepEqual(env.feishu.deleted.filter((id) => otherMessages.includes(id)).sort(), [...otherMessages].sort());
    assert.equal(env.feishu.deleted.filter((id) => otherMessages.includes(id)).at(-1), other.rootMessageId);
    assert.equal(env.db.getSession(OLD)?.rootMessageId, null);
    // The third root stays, so that topic keeps its link and is reported.
    assert.equal(env.db.getSession(FRESH)?.rootMessageId, third.rootMessageId);
    const result = JSON.stringify(env.feishu.sent.find((item) => title(item.card) === "范围外话题清理完成")?.card);
    assert.match(result, /处理话题：\*\*2\*\*/);
    assert.match(result, /未能撤回：\*\*1\*\*/);
    assert.match(result, /超过撤回时限/);
    assert.doesNotMatch(result, /230110/);
    assert.equal(env.feishu.deleted.includes(env.db.getSession(RECENT)!.rootMessageId!), false);
  } finally { await env.cleanup(); }
});

const rootCardOf = (env: { feishu: FakeFeishu }, root: string) => JSON.stringify(env.feishu.updated.filter((update) => update.id === root).at(-1)?.card ?? env.feishu.roots.find((item) => item.id === root)?.card);
const nonceOf = (card: CardDefinition | undefined) => /"nonce":"([^"]+)"/.exec(JSON.stringify(card))?.[1] ?? "";
const labels = (items: Reply[]) => items.map((item) => item.kind === "text" ? item.text : item.kind === "file" ? item.name : title(item.card));
/** Records Claude Code writes for a turn the bridge runs: the same as for any prompt, with the SDK as entrypoint. */
const sdkRecord = (record: Record<string, unknown>, cwd: string) => ({ ...record, cwd, entrypoint: "sdk-ts" });

test("a reply in a topic resumes the session, streams the reply and asks for permission in the topic", async () => {
  const env = await setup("claude-continue-");
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl(atCwd([prompt(RECENT, "r-p1", now - HOUR, "第一个问题"), reply(RECENT, "r-a1", now - HOUR + MINUTE, "第一个回答")], env.project)));
    await env.bind();
    const root = env.db.getSession(RECENT)!.rootMessageId!;
    const before = env.feishu.repliesTo(root).length;

    await env.runtime.onFeishuMessage(env.message({ messageId: "m-run", rootId: root, mentionedBot: false, text: "帮我跑测试" }));
    const query = env.queries[0]!;
    assert.equal(query.options.resume, RECENT);
    assert.equal(query.options.cwd, env.project);
    assert.equal(query.options.permissionMode, "default");
    assert.equal(query.options.pathToClaudeCodeExecutable, "claude");
    assert.deepEqual(query.options.settingSources, ["user", "project", "local"]);
    assert.equal((query.options.env as Record<string, string>).FEISHU_CLAUDE_BRIDGE, "1");
    const sent = await query.nextMessage(1);
    assert.equal(sent.message.content, "帮我跑测试");
    assert.equal(sent.priority, "next");
    await waitUntil(() => rootCardOf(env, root).includes("飞书中运行中"));

    // Claude Code records the prompt like any other; the person's message already shows it.
    query.replay(sent);
    await appendFile(env.path(RECENT), jsonl([sdkRecord(prompt(RECENT, sent.uuid!, Date.now(), "帮我跑测试"), env.project)]));
    await env.runtime.syncAll();
    const turnCard = env.feishu.repliesTo(root).slice(before);
    assert.deepEqual(labels(turnCard), ["Claude · 进行中"]);
    assert.equal(env.db.getSession(RECENT)?.entrypoint, "claude-vscode");
    assert.equal(env.db.getTurn(RECENT, sent.uuid!)?.view.entrypoint, "feishu");

    // The reply shows while Claude is still writing it.
    query.stream("我先运行测试");
    await waitUntil(() => env.feishu.updated.some((update) => update.id === turnCard[0]!.id && JSON.stringify(update.card).includes("我先运行测试")), 4_000);

    // A tool call no rule allows waits for the person, after the card that shows the call.
    await appendFile(env.path(RECENT), jsonl([sdkRecord(toolUse(RECENT, "t-1", Date.now(), "toolu_1", "npm test"), env.project)]));
    const rule = { type: "addRules" as const, rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow" as const, destination: "localSettings" as const };
    const asked = query.ask("Bash", { command: "npm test" }, [rule]);
    await waitUntil(() => env.feishu.repliesTo(root).some((item) => title(item.card) === "Claude 请求使用 Bash"));
    const permission = env.feishu.repliesTo(root).find((item) => title(item.card) === "Claude 请求使用 Bash")!;
    assert.match(JSON.stringify(permission.card), /npm test/);
    assert.match(JSON.stringify(permission.card), /本会话都允许/);
    await waitUntil(() => rootCardOf(env, root).includes("飞书中等待你处理"));
    const allowed = await env.action("perm_always", { nonce: nonceOf(permission.card) }, {}, permission.id);
    assert.equal(title(allowed.card), "使用 Bash · 本会话都允许");
    assert.deepEqual(await asked.result, { behavior: "allow", updatedInput: { command: "npm test" }, updatedPermissions: [{ ...rule, destination: "session" }] });
    assert.equal(title((await env.action("perm_deny", { nonce: nonceOf(permission.card) }, {}, "other-card")).card), "请求已失效");

    // The turn ends; the session stays connected until it has been idle for a while.
    await appendFile(env.path(RECENT), jsonl([sdkRecord(toolResult(RECENT, "t-r1", Date.now(), "toolu_1"), env.project),
      sdkRecord(reply(RECENT, "a-2", Date.now(), "测试全部通过"), env.project)]));
    query.result([sent.uuid!]);
    await waitUntil(() => title(env.feishu.updated.filter((update) => update.id === turnCard[0]!.id).at(-1)?.card).startsWith("Claude · 已完成"), 4_000);
    await waitUntil(() => rootCardOf(env, root).includes("飞书中已连接（空闲）"));
    assert.match(JSON.stringify(env.feishu.updated.filter((update) => update.id === turnCard[0]!.id).at(-1)?.card), /测试全部通过/);

    // The next reply goes to the same process.
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "再看看覆盖率" }));
    assert.equal(env.queries.length, 1);
    assert.equal((await query.nextMessage(2)).message.content, "再看看覆盖率");
  } finally { await env.cleanup(); }
});

test("while Claude works, replies reach it, >> waits for the turn, a reply refuses a tool with a reason, and /stop interrupts", async () => {
  const env = await setup("claude-busy-");
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl(atCwd([prompt(RECENT, "r-p1", now - HOUR, "问题"), reply(RECENT, "r-a1", now - HOUR + MINUTE, "回答")], env.project)));
    await env.bind();
    const root = env.db.getSession(RECENT)!.rootMessageId!;
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "开始重构" }));
    const query = env.queries[0]!;
    const first = await query.nextMessage(1);
    query.replay(first);

    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "顺便看下日志" }));
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: ">> 然后提交" }));
    const steer = await query.nextMessage(2);
    const queued = await query.nextMessage(3);
    assert.deepEqual([steer.message.content, steer.priority], ["顺便看下日志", "next"]);
    assert.deepEqual([queued.message.content, queued.priority], ["然后提交", "later"]);
    assert.ok(env.feishu.repliesTo(root).some((item) => item.text === "已排队：这一轮结束后发给 Claude。"));

    const asked = query.ask("Bash", { command: "rm -rf build" });
    await waitUntil(() => env.feishu.repliesTo(root).some((item) => title(item.card) === "Claude 请求使用 Bash"));
    const permission = env.feishu.repliesTo(root).find((item) => title(item.card) === "Claude 请求使用 Bash")!;
    assert.doesNotMatch(JSON.stringify(permission.card), /本会话都允许/);
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "不要删，先看 README" }));
    const refused = await asked.result;
    assert.equal(refused?.behavior, "deny");
    assert.match(refused?.behavior === "deny" ? refused.message : "", /不要删，先看 README/);
    assert.equal(title(env.feishu.updated.filter((update) => update.id === permission.id).at(-1)?.card), "使用 Bash · 已拒绝");
    assert.equal(query.received.length, 3);

    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "/stop" }));
    assert.deepEqual(query.calls.filter((call) => call === "interrupt"), ["interrupt"]);
    assert.ok(env.feishu.repliesTo(root).some((item) => item.text === "已停止这一轮。"));
    query.result([first.uuid!, steer.uuid!], { subtype: "error_during_execution", errors: ["aborted"] });
    // The queued message still runs, then the session is idle.
    await waitUntil(() => rootCardOf(env, root).includes("飞书中运行中"));
    query.result([queued.uuid!]);
    await waitUntil(() => rootCardOf(env, root).includes("飞书中已连接（空闲）"));
    assert.equal(env.feishu.repliesTo(root).filter((item) => item.text?.startsWith("⚠️")).length, 0);
  } finally { await env.cleanup(); }
});

test("messages from the phone take control; a turn still running on the computer is waited for, or forked away from", async () => {
  const env = await setup("claude-fork-");
  try {
    const now = Date.now();
    // A session started minutes ago: its copied history must still stay out of the fork's topic.
    const history = atCwd([prompt(RECENT, "r-p1", now - 2 * MINUTE, "原来的问题"), reply(RECENT, "r-a1", now - MINUTE, "原来的回答")], env.project);
    await writeFile(env.path(RECENT), jsonl(history));
    await env.bind();
    const root = env.db.getSession(RECENT)!.rootMessageId!;
    const presenceDir = join(env.config.stateDir, "presence");
    await mkdir(presenceDir, { recursive: true });
    let clock = Date.now();
    const local = async (state: string, event: string) => {
      clock = Math.max(clock + 1, Date.now());
      await writeFile(join(presenceDir, `${RECENT}.json`), JSON.stringify({ version: 1, sessionId: RECENT, event, state, notificationType: null,
        message: null, transcriptPath: env.path(RECENT), cwd: env.project, source: null, reason: null, pid: process.pid, pidStartTime: null, at: clock }));
      await env.internals.presence.scan();
    };
    const busyCards = () => env.feishu.repliesTo(root).filter((item) => title(item.card) === "电脑上这一轮还在运行");

    // A turn runs in VS Code: messages wait for it, in order, on one card.
    await local("running", "UserPromptSubmit");
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "换个思路试试" }));
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "再补充一点" }));
    assert.equal(env.queries.length, 0);
    assert.equal(busyCards().length, 1);
    const waiting = busyCards()[0]!;
    assert.match(JSON.stringify(env.feishu.updated.filter((update) => update.id === waiting.id).at(-1)?.card), /你的 2 条消息会在电脑上这一轮结束后自动发送/);

    // Forking leaves the computer's session alone and continues both messages in a new topic.
    assert.equal(title((await env.action("conflict_fork", { nonce: nonceOf(waiting.card) }, {}, waiting.id)).card), "正在分叉");
    await waitUntil(() => env.queries.length === 1);
    const query = env.queries[0]!;
    const forkId = String(query.options.sessionId);
    assert.deepEqual([query.options.resume, query.options.forkSession], [RECENT, true]);
    const sent = await query.nextMessage(1);
    assert.equal(sent.message.content, "换个思路试试");
    assert.equal((await query.nextMessage(2)).message.content, "再补充一点");
    const fork = env.db.getSession(forkId)!;
    assert.deepEqual([fork.forkedFrom, fork.entrypoint], [RECENT, "feishu"]);
    assert.match(title(env.feishu.roots.find((item) => item.id === fork.rootMessageId)?.card), /（分叉）$/);
    await waitUntil(() => env.feishu.repliesTo(root).some((item) => item.text?.startsWith("已分叉到新话题继续：https://example.test/")));

    // The fork's transcript repeats the history with the same record ids.
    await writeFile(join(env.projects, `${forkId}.jsonl`), jsonl([...history.map((record) => ({ ...record, sessionId: forkId, entrypoint: "sdk-ts" })),
      sdkRecord({ ...prompt(forkId, sent.uuid!, Date.now(), "换个思路试试"), sessionId: forkId }, env.project)]));
    const originalCards = env.feishu.repliesTo(root).filter((item) => item.kind === "card").map((item) => item.id);
    const updatesBefore = env.feishu.updated.filter((update) => originalCards.includes(update.id)).length;
    await env.runtime.syncAll();
    assert.deepEqual(labels(env.feishu.repliesTo(fork.rootMessageId!)), ["飞书：换个思路试试", "Claude · 进行中"]);
    assert.equal(env.feishu.updated.filter((update) => originalCards.includes(update.id)).length, updatesBefore);
    assert.equal(env.db.getTurn(RECENT, "r-p1")?.view.status, "done");
    assert.match(rootCardOf(env, fork.rootMessageId!), /分叉自/);

    // Another message waits again; when the turn on the computer ends, it goes out and the phone has control.
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "就在这里继续" }));
    const second = busyCards().at(-1)!;
    assert.notEqual(second.id, waiting.id);
    assert.equal(env.queries.length, 1);
    await local("idle", "Stop");
    await waitUntil(() => env.queries.length === 2);
    const resumed = env.queries[1]!;
    assert.deepEqual([resumed.options.resume, resumed.options.forkSession], [RECENT, undefined]);
    assert.equal((await resumed.nextMessage(1)).message.content, "就在这里继续");
    assert.equal(title(env.feishu.updated.filter((update) => update.id === second.id).at(-1)?.card), "已切换到手机侧控制");
    assert.ok(env.feishu.repliesTo(root).some((item) => item.text?.startsWith("已切换到手机侧控制")));
    assert.equal(title((await env.action("conflict_cancel", { nonce: nonceOf(second.card) }, {}, "again")).card), "已处理");

    // While the phone has control, further messages go straight to Claude.
    resumed.result([resumed.received[0]!.uuid!]);
    await waitUntil(() => rootCardOf(env, root).includes("飞书中已连接（空闲）"));
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "再来一轮" }));
    assert.equal((await resumed.nextMessage(2)).message.content, "再来一轮");
    resumed.result([resumed.received[1]!.uuid!]);
    await waitUntil(() => rootCardOf(env, root).includes("飞书中已连接（空闲）"));

    // A new prompt on the computer hands control back: the bridge's process exits.
    await local("running", "UserPromptSubmit");
    await waitUntil(() => env.feishu.repliesTo(root).some((item) => item.text?.startsWith("电脑上继续了这个会话，已切回电脑侧控制")));
    await waitUntil(() => !rootCardOf(env, root).includes("飞书中"));
  } finally { await env.cleanup(); }
});

test("a lone / in a topic posts the session's controls at the bottom of the topic", async () => {
  const env = await setup("claude-menu-");
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl(atCwd([prompt(RECENT, "r-p1", now - HOUR, "问题"), reply(RECENT, "r-a1", now - HOUR + MINUTE, "回答")], env.project)));
    await env.bind();
    const root = env.db.getSession(RECENT)!.rootMessageId!;
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "/" }));
    const copy = env.feishu.repliesTo(root).at(-1)!;
    assert.match(JSON.stringify(copy.card), /"action":"model_card"/);
    assert.match(JSON.stringify(copy.card), /"action":"mode_card"/);
    assert.equal(env.queries.length, 0);
    // Its buttons work like the root card's.
    await env.action("model_card", { sessionId: RECENT }, {}, copy.id);
    await waitUntil(() => env.feishu.repliesTo(root).some((item) => title(item.card) === "飞书续聊的模型"));
  } finally { await env.cleanup(); }
});

test("questions and plans are answered on cards or by replying, and settings apply to the running session", async () => {
  const env = await setup("claude-questions-");
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl(atCwd([prompt(RECENT, "r-p1", now - HOUR, "问题"), reply(RECENT, "r-a1", now - HOUR + MINUTE, "回答")], env.project)));
    await env.bind();
    const root = env.db.getSession(RECENT)!.rootMessageId!;
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "设计一下" }));
    const query = env.queries[0]!;
    query.replay(await query.nextMessage(1));

    const questions = [
      { question: "用哪个方案？", header: "方案", multiSelect: false, options: [{ label: "甲", description: "简单" }, { label: "乙", description: "灵活" }] },
      { question: "要哪些测试？", header: "测试", multiSelect: true, options: [{ label: "单元", description: "" }, { label: "集成", description: "" }] },
    ];
    const asked = query.ask("AskUserQuestion", { questions });
    await waitUntil(() => env.feishu.repliesTo(root).some((item) => title(item.card) === "Claude 提问 1/2 · 方案"));
    const card = env.feishu.repliesTo(root).find((item) => title(item.card) === "Claude 提问 1/2 · 方案")!;
    const next = await env.action("ask_answer", { nonce: nonceOf(card.card), question: 0, option: 1 }, {}, card.id);
    assert.equal(title(next.card), "Claude 提问 2/2 · 测试");
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "1，2" }));
    assert.deepEqual(await asked.result, { behavior: "allow", updatedInput: { questions, answers: { "用哪个方案？": "乙", "要哪些测试？": "单元, 集成" } } });
    assert.equal(title(env.feishu.updated.filter((update) => update.id === card.id).at(-1)?.card), "Claude 提问 · 已回答");

    const plan = query.ask("ExitPlanMode", { plan: "1. 拆分模块\n2. 补测试" });
    await waitUntil(() => env.feishu.repliesTo(root).some((item) => title(item.card) === "Claude 提交了计划，等你确认"));
    const planCard = env.feishu.repliesTo(root).find((item) => title(item.card) === "Claude 提交了计划，等你确认")!;
    assert.match(JSON.stringify(planCard.card), /拆分模块/);
    await env.action("plan_edits", { nonce: nonceOf(planCard.card) }, {}, planCard.id);
    assert.deepEqual(await plan.result, { behavior: "allow", updatedInput: { plan: "1. 拆分模块\n2. 补测试" },
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
    assert.equal(env.db.getSession(RECENT)?.prefMode, "acceptEdits");

    // Mode, model and effort chosen in Feishu reach the running process and later runs.
    await env.action("mode_card", { sessionId: RECENT }, {}, root);
    await waitUntil(() => env.feishu.repliesTo(root).some((item) => title(item.card) === "飞书续聊的权限模式"));
    const modeCard = JSON.stringify(env.feishu.repliesTo(root).find((item) => title(item.card) === "飞书续聊的权限模式")?.card);
    assert.doesNotMatch(modeCard, /bypassPermissions|跳过权限检查"/);
    assert.equal(title((await env.action("set_mode", { sessionId: RECENT, mode: "bypassPermissions" })).card), "无法设置");
    await env.action("set_mode", { sessionId: RECENT, mode: "plan" });
    await env.action("set_model", { sessionId: RECENT, model: "sonnet" });
    await env.action("set_effort", { sessionId: RECENT, effort: "high" });
    assert.deepEqual(query.calls.filter((call) => !call.startsWith("interrupt")), ["mode:plan", "model:sonnet", 'flags:{"effortLevel":"high"}']);
    const session = env.db.getSession(RECENT)!;
    assert.deepEqual([session.prefMode, session.prefModel, session.prefEffort], ["plan", "sonnet", "high"]);
    await waitUntil(() => rootCardOf(env, root).includes("计划模式（只读）"));
  } finally { await env.cleanup(); }
});

test("new sessions start from /new, from a message in the main timeline, or from the card, only in allowed directories", async () => {
  const env = await setup("claude-new-");
  try {
    await env.bind();
    await env.runtime.onFeishuMessage(env.message({ text: `/new ${env.project} 写一个脚本` }));
    const query = env.queries[0]!;
    const sessionId = String(query.options.sessionId);
    assert.equal(query.options.resume, undefined);
    assert.equal(query.options.cwd, env.project);
    assert.equal((await query.nextMessage(1)).message.content, "写一个脚本");
    const session = env.db.getSession(sessionId)!;
    assert.equal(session.entrypoint, "feishu");
    assert.ok(session.rootMessageId);
    assert.ok(env.feishu.sent.some((item) => item.text?.startsWith("已在 ") && item.text.includes(`https://example.test/${session.rootMessageId}`)));

    // The first prompt was typed on a card or in the main timeline, so the topic shows it.
    const sent = query.received[0]!;
    query.replay(sent);
    await writeFile(join(env.projects, `${sessionId}.jsonl`), jsonl([sdkRecord({ ...prompt(sessionId, sent.uuid!, Date.now(), "写一个脚本"), sessionId }, env.project)]));
    await env.runtime.syncAll();
    assert.deepEqual(labels(env.feishu.repliesTo(session.rootMessageId!)), ["飞书：写一个脚本", "Claude · 进行中"]);
    assert.equal(env.db.getSession(sessionId)?.entrypoint, "feishu");

    // Directories must exist, lie under ALLOWED_ROOT and be synced.
    await env.runtime.onFeishuMessage(env.message({ text: `/new ${join(env.home, "missing")} 任务` }));
    assert.match(JSON.stringify(env.feishu.sent.at(-1)?.card), /目录不存在/);
    await env.runtime.onFeishuMessage(env.message({ text: "/new /tmp 任务" }));
    assert.match(JSON.stringify(env.feishu.sent.at(-1)?.card), /只能在 .* 及其子目录中新建会话/);
    assert.equal(env.queries.length, 1);

    // A plain message in the main timeline becomes the task once a directory is picked.
    await env.runtime.onFeishuMessage(env.message({ messageId: "m-draft", text: "整理一下 README" }));
    const picker = env.feishu.sent.at(-1)!.card;
    assert.equal(title(picker), "新建 Claude 会话");
    assert.match(JSON.stringify(picker), /任务：整理一下 README/);
    const draft = /"draft":"([^"]+)"/.exec(JSON.stringify(picker))?.[1];
    assert.ok(draft);
    assert.match(JSON.stringify(picker), new RegExp(`"cwd":"${env.project}"`));
    const started = await env.action("new_pick", { cwd: env.project, draft });
    assert.equal(title(started.card), "已新建会话");
    await waitUntil(() => env.queries.length === 2);
    assert.equal((await env.queries[1]!.nextMessage(1)).message.content, "整理一下 README");

    // The card form: pick a directory, then type the task.
    const taskCard = await env.action("new_pick_path", {}, { new_dir: env.project });
    assert.equal(title(taskCard.card), "新建 Claude 会话");
    assert.match(JSON.stringify(taskCard.card), /"action":"new_submit"/);
    assert.match(JSON.stringify((await env.action("new_submit", { cwd: env.project }, { new_task: "" })).card), /请填写要 Claude 做什么/);
    await env.action("new_submit", { cwd: env.project }, { new_task: "加个单元测试" });
    await waitUntil(() => env.queries.length === 3);
    assert.equal((await env.queries[2]!.nextMessage(1)).message.content, "加个单元测试");
  } finally { await env.cleanup(); }
});

test("an idle process exits and the next reply resumes the session; a crash is reported in the topic", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const env = await setup("claude-idle-", [], { runnerIdleMs: 50 });
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl(atCwd([prompt(RECENT, "r-p1", now - HOUR, "问题"), reply(RECENT, "r-a1", now - HOUR + MINUTE, "回答")], env.project)));
    await env.bind();
    const root = env.db.getSession(RECENT)!.rootMessageId!;
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "第一轮" }));
    const first = env.queries[0]!;
    first.result([(await first.nextMessage(1)).uuid!]);
    // After RUNNER_IDLE_MS the input ends and the process exits; the root card no longer shows it.
    await waitUntil(() => rootCardOf(env, root).includes("飞书中已连接（空闲）") || !rootCardOf(env, root).includes("飞书中"));
    await waitUntil(() => !rootCardOf(env, root).includes("飞书中"));

    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "第二轮" }));
    assert.equal(env.queries.length, 2);
    const second = env.queries[1]!;
    assert.equal(second.options.resume, RECENT);
    await second.nextMessage(1);
    second.crash(new Error("claude exited with code 1"));
    await waitUntil(() => env.feishu.repliesTo(root).some((item) => item.text?.startsWith("⚠️ Claude Code 进程异常退出：claude exited with code 1")));
    await waitUntil(() => !rootCardOf(env, root).includes("飞书中"));
  } finally { await env.cleanup(); }
});

test("a session continues in the directory it was started in, not where its shell moved to", async () => {
  const env = await setup("claude-project-dir-");
  try {
    const folder = join(env.config.claudeHome, "projects", projectFolderName(env.project));
    await mkdir(folder, { recursive: true });
    await mkdir(join(env.project, "src"), { recursive: true });
    const now = Date.now();
    await writeFile(join(folder, `${RECENT}.jsonl`), jsonl(atCwd([prompt(RECENT, "r-p1", now - HOUR, "问题"), reply(RECENT, "r-a1", now - HOUR + MINUTE, "回答")], join(env.project, "src"))));
    await env.bind();
    const session = env.db.getSession(RECENT)!;
    assert.equal(session.cwd, env.project);
    await env.runtime.onFeishuMessage(env.message({ rootId: session.rootMessageId!, mentionedBot: false, text: "继续" }));
    assert.equal(env.queries[0]!.options.cwd, env.project);
  } finally { await env.cleanup(); }
});
