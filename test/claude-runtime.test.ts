import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureCardUi } from "../src/card-kit.js";
import type { ClaudeBridgeConfig } from "../src/claude/config.js";
import { ClaudeBridgeDatabase } from "../src/claude/db.js";
import { ClaudeRuntime } from "../src/claude/runtime.js";
import type { CardDefinition, FeishuPort, IncomingFeishuMessage } from "../src/types.js";

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
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const jsonl = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

const atCwd = (records: Array<Record<string, unknown>>, cwd: string) => records.map((record) => "cwd" in record ? { ...record, cwd } : record);

async function setup(prefix: string, syncDirs: string[] = []) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const projects = join(home, ".claude", "projects", "-home-tester-project");
  await mkdir(projects, { recursive: true });
  const config: ClaudeBridgeConfig = { appId: "app", appSecret: "secret", bindToken: "token", claudeHome: join(home, ".claude"), stateDir: join(home, "state"),
    allowedRoot: home, historyDays: 3, syncDirs, scanIntervalMs: 60_000, livenessIntervalMs: 60_000 };
  const db = new ClaudeBridgeDatabase(config.stateDir);
  const feishu = new FakeFeishu();
  const runtime = new ClaudeRuntime(config, db, feishu);
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
  return { home, config, db, feishu, runtime, path, internals, message, bind, restart, cleanup: async () => { db.close(); await rm(home, { recursive: true, force: true }); } };
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

test("topic messages are read-only, /export uploads the transcript, and plain words are commands only at the root", async () => {
  const env = await setup("claude-messages-");
  try {
    const now = Date.now();
    await writeFile(env.path(RECENT), jsonl([prompt(RECENT, "r-p1", now - 2 * HOUR, "第一个问题"), reply(RECENT, "r-a1", now - 2 * HOUR + MINUTE, "第一个回答"),
      prompt(RECENT, "r-p2", now - HOUR, "第二个问题"), reply(RECENT, "r-a2", now - HOUR + MINUTE, "第二个回答")]));
    await env.bind();
    const root = env.db.getSession(RECENT)!.rootMessageId!;
    const before = env.feishu.repliesTo(root).length;
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "继续" }));
    await env.runtime.onFeishuMessage(env.message({ rootId: root, mentionedBot: false, text: "状态" }));
    const added = env.feishu.repliesTo(root).slice(before);
    assert.equal(added.length, 1);
    assert.match(added[0]?.text ?? "", /只读镜像/);
    assert.match(added[0]?.text ?? "", new RegExp(`claude --resume ${RECENT}`));
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
    await env.runtime.onFeishuMessage(env.message({ rootId: other.rootMessageId!, mentionedBot: false, text: "继续" }));
    const otherMessages = [other.rootMessageId!, ...env.feishu.repliesTo(other.rootMessageId!).map((item) => item.id)];
    // The third topic's root is too old to withdraw.
    env.feishu.undeletable.set(third.rootMessageId!, "Feishu API 230027: the message is beyond the recall time limit");

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
    assert.match(result, /230027/);
    assert.equal(env.feishu.deleted.includes(env.db.getSession(RECENT)!.rootMessageId!), false);
  } finally { await env.cleanup(); }
});
