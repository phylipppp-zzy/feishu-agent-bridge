import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureCardUi, helpCard, permissionDetailsCard, serviceCard, sessionCard } from "../src/cards.js";
import { parseJsonlChunk, stripHostContext } from "../src/session-parser.js";
import { at, cardAction, fakeAppServer, importedSession, inbound, jsonl, SESSION_ID, shutdown, startTurn, title, userRecord, waitFor } from "./codex-harness.js";

async function withHome(prefix: string, work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  try { await work(home); } finally { await rm(home, { recursive: true, force: true }); }
}

const userItems = (seconds: number, ...texts: string[]) => ({ timestamp: at(seconds), type: "response_item",
  payload: { type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) } });
const visible = (records: unknown[]) => parseJsonlChunk(jsonl([{ timestamp: at(0), type: "session_meta", payload: { session_id: SESSION_ID, cwd: "/w", timestamp: at(0) } }, ...records]))
  .messages.filter((message) => message.role === "user").map((message) => message.text);

const plugins = "<recommended_plugins>github, figma</recommended_plugins>";
const agents = "# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nhost rules\n</INSTRUCTIONS>";
const environment = "<environment_context>\n  <cwd>/work</cwd>\n</environment_context>";

// F01 ------------------------------------------------------------------------------------------

test("F01: host context is not shown as the person's message, while real requests and quoted tags stay", () => {
  assert.deepEqual(visible([userRecord(1, plugins)]), []);
  assert.deepEqual(visible([userRecord(1, `${plugins}\n${environment}`)]), []);
  assert.deepEqual(visible([userRecord(1, `${plugins}\n${agents}\n${environment}`)]), []);
  assert.deepEqual(visible([userItems(1, agents, environment, "修复登录页")]), ["修复登录页"]);
  assert.deepEqual(visible([userRecord(1, `${plugins}\n${environment}\n帮我看看日志`)]), ["帮我看看日志"]);
  const quoted = "这段配置里的 <recommended_plugins>a</recommended_plugins> 是什么？";
  assert.deepEqual(visible([userRecord(1, quoted)]), [quoted]);
  const code = "```xml\n<recommended_plugins>a</recommended_plugins>\n```";
  assert.equal(stripHostContext(code), code);
  // Text the person wrote is never cut, even with host-like blocks after it.
  const pasted = "这个块是什么意思？\n<environment_context>x</environment_context>";
  assert.equal(stripHostContext(pasted), pasted);
  const several = "我的问题\n<recommended_plugins>x</recommended_plugins>\n中间\n<recommended_plugins>y</recommended_plugins>";
  assert.equal(stripHostContext(several), several);
  // Context around the person's words is removed when the text starts with context.
  assert.equal(stripHostContext(`${plugins}\n帮我修复\n${environment}`), "帮我修复");
  assert.equal(stripHostContext(`${plugins}\n问题\n<recommended_plugins>x</recommended_plugins>\n中间\n${environment}`), "问题\n<recommended_plugins>x</recommended_plugins>\n中间");
  // Message ids still come from the recorded text, so messages imported earlier are not imported again.
  const raw = `${plugins}\n帮我看看`;
  const parsed = parseJsonlChunk(jsonl([{ timestamp: at(0), type: "session_meta", payload: { session_id: SESSION_ID, cwd: "/w", timestamp: at(0) } }, userRecord(5, raw)]));
  assert.equal(parsed.messages[0]?.id, createHash("sha256").update(`${SESSION_ID}\0${at(5)}\0user\0${raw}`).digest("hex"));
});

test("F01: old host-context messages are listed first and withdrawn only after confirmation; failures can be retried", () => withHome("codex-host-context-", async (home) => {
  const env = await importedSession(home);
  const idFor = (seconds: number, text: string) => createHash("sha256").update(`${SESSION_ID}\0${at(seconds)}\0user\0${text}`).digest("hex");
  const pure = `${plugins}\n${agents}`;
  const mixed = `${plugins}\n真正的问题`;
  await appendFile(env.path, jsonl([userRecord(20, pure), userRecord(21, mixed), userRecord(22, `${plugins}\n${environment}`)]));
  // As an older bridge version posted them.
  env.db.saveMessage(idFor(20, pure), SESSION_ID, "outbound", "om-pure", { kind: "primary" });
  env.db.saveMessage(idFor(21, mixed), SESSION_ID, "outbound", "om-mixed", { kind: "primary" });
  env.db.saveMessage(idFor(22, `${plugins}\n${environment}`), SESSION_ID, "outbound", "om-env", { kind: "primary" });
  assert.match(JSON.stringify(serviceCard({ paused: false, sessions: 1, active: 0, failures: 0 })), /"action":"context_cleanup_preview"/);

  await env.service.onCardAction(cardAction("context_cleanup_preview"));
  await waitFor(() => env.feishu.cards.some((card) => title(card.card).startsWith("可撤回")));
  const preview = env.feishu.cards.find((card) => title(card.card).startsWith("可撤回"))!.card;
  assert.equal(title(preview), "可撤回 2 条宿主上下文消息");
  assert.match(JSON.stringify(preview), /另有 1 条消息里同时有你真正的提问，不会撤回/);
  assert.deepEqual(env.feishu.deleted, []);

  env.feishu.failDelete = (id) => id === "om-env" ? new Error("Feishu API 230009: Message has expired when recall message.") : null;
  const nonce = /"nonce":"([^"]+)"/.exec(JSON.stringify(preview))![1]!;
  await env.service.onCardAction(cardAction("context_cleanup_confirm", { nonce }, "preview-card"));
  await waitFor(() => env.feishu.cards.some((card) => title(card.card) === "宿主上下文消息清理完成"));
  assert.deepEqual(env.feishu.deleted, ["om-pure"]);
  const result = JSON.stringify(env.feishu.cards.find((card) => title(card.card) === "宿主上下文消息清理完成")!.card);
  assert.match(result, /已撤回：\*\*1\*\*/);
  assert.match(result, /超过飞书撤回时限/);
  assert.equal(env.db.getMessage(idFor(21, mixed))?.recallState, null);

  // Checking again lists only what is left, and a stale confirmation does nothing.
  env.feishu.failDelete = null;
  assert.match(JSON.stringify(await env.service.onCardAction(cardAction("context_cleanup_confirm", { nonce }, "old-card"))), /清理已过期/);
  await env.service.onCardAction(cardAction("context_cleanup_preview", {}, "result-card"));
  await waitFor(() => env.feishu.cards.filter((card) => title(card.card).startsWith("可撤回")).length === 2);
  assert.equal(title(env.feishu.cards.filter((card) => title(card.card).startsWith("可撤回")).at(-1)!.card), "可撤回 1 条宿主上下文消息");
  await shutdown(env);
}));

// F03 / F11 ------------------------------------------------------------------------------------

test("F03/F11: the session card says plainly what a turn may do, with real line breaks", () => {
  configureCardUi(2);
  try {
    const base = { cwd: "/home/tester/my_project`x", firstUserText: "任务", sessionId: "session-12345678" };
    const normal = JSON.stringify(sessionCard(base));
    assert.match(normal, /权限：可修改当前项目文件，不可联网/);
    assert.doesNotMatch(normal, /canonical|\\\\x60|\\\\\\\\n/);
    assert.match(normal, /项目：\/home\/tester\/my\\\\_project\\\\`x\\n模型：/);
    assert.match(JSON.stringify(sessionCard({ ...base, collaborationMode: "plan" })), /只读规划，不修改文件，不可联网/);
    const root = { executionMode: "root-danger-full-access" as const, rootExecutionReady: true };
    assert.match(JSON.stringify(sessionCard({ ...base, ...root })), /每个任务需单独授权 Root/);
    assert.match(JSON.stringify(sessionCard({ ...base, executionMode: "root-danger-full-access", rootExecutionReady: false, rootPreflightReasons: ["容器不可用"] })), /Root 容器预检失败，执行已禁用：容器不可用/);
    const running = JSON.stringify(sessionCard({ ...base, ...root, hasActiveWork: true, currentTurn: { mode: "default", rootMode: true } }, "运行中"));
    assert.match(running, /本轮权限：专用 Root 容器：可读写容器、联网、启动进程（本任务已授权）/);
    assert.match(running, /下一轮：每个任务需单独授权 Root/);
    // Switching to Plan while a turn runs: this turn keeps its permissions, the next one is read-only.
    const switched = JSON.stringify(sessionCard({ ...base, collaborationMode: "plan", hasActiveWork: true, currentTurn: { mode: "default", rootMode: false } }, "运行中"));
    assert.match(switched, /本轮权限：可修改当前项目文件，不可联网/);
    assert.match(switched, /下一轮：只读规划/);
    assert.match(normal, /"action":"permission_details"/);
    const details = JSON.stringify(permissionDetailsCard("/work", false, root));
    assert.match(details, /真实路径/);
    assert.match(details, /Root 模式/);
    assert.match(details, /桥接服务与飞书、与模型服务之间的连接不受影响/);
  } finally { configureCardUi(1); }
});

// F10 ------------------------------------------------------------------------------------------

test("F10: the wizard takes the task from the next main-timeline message without an @, only from the bound user in that chat", () => withHome("codex-wizard-", async (home) => {
  const app = fakeAppServer();
  const env = await importedSession(home, app.server);
  const started: string[] = [];
  (env.service as unknown as { runNewSession: (message: unknown, cwd: string, prompt: string) => Promise<void> }).runNewSession = async (_message, _cwd, prompt) => { started.push(prompt); };
  const wizard = { id: "w1", mode: "new", chatId: "chat-1", cwd: home, model: "gpt-test", reasoningEffort: "medium", awaitingChatTask: true, expiresAt: Date.now() + 60_000 };
  env.db.setSetting("wizard.new.user-1", JSON.stringify(wizard));
  await env.service.onFeishuMessage(inbound({ messageId: "w-other-chat", chatId: "chat-2", rootId: undefined as unknown as string, text: "别的群" }));
  await env.service.onFeishuMessage(inbound({ messageId: "w-other-user", senderOpenId: "user-2", rootId: undefined as unknown as string, text: "别人" }));
  assert.deepEqual(started, []);
  // A reply inside a session topic still belongs to that session.
  const continued: string[] = [];
  (env.service as unknown as { continueSession: (message: { text: string }) => Promise<void> }).continueSession = async (message) => { continued.push(message.text); };
  await env.service.onFeishuMessage(inbound({ messageId: "w-topic", text: "话题里的回复" }));
  assert.deepEqual(continued, ["话题里的回复"]);
  // Nor is a reply in a topic that is not a session (for example under another bot card).
  await env.service.onFeishuMessage(inbound({ messageId: "w-other-topic", rootId: "card-root-9", text: "卡片话题里的回复" }));
  assert.deepEqual(started, []);
  const message = inbound({ messageId: "w-task", text: "整理 README" });
  delete (message as { rootId?: string }).rootId;
  await env.service.onFeishuMessage(message);
  assert.deepEqual(started, ["整理 README"]);
  assert.equal(env.db.getSetting("wizard.new.user-1"), null);
  // Without a waiting wizard, an unmentioned main-timeline message is ignored as before.
  const plain = inbound({ messageId: "w-plain", text: "随便说说" });
  delete (plain as { rootId?: string }).rootId;
  await env.service.onFeishuMessage(plain);
  assert.deepEqual(started, ["整理 README"]);
  await shutdown(env);
}));

// F12 / F14 ------------------------------------------------------------------------------------

test("F12: a topic whose root card can no longer be edited still gets working controls from a lone /", () => withHome("codex-expired-root-", async (home) => {
  const app = fakeAppServer((method) => method === "turn/start" ? { turn: { id: "turn-1" } } : {});
  const env = await importedSession(home, app.server);
  env.feishu.failUpdate = (id) => id === "root-1" ? new Error("Feishu API 230031: The message has expired and cannot be updated") : null;
  await env.service.onFeishuMessage(inbound({ messageId: "menu-1", text: "/" }));
  const copy = env.feishu.cards.at(-1)!;
  assert.match(JSON.stringify(copy.card), /"action":"session_model"/);
  const toggled = await env.service.onCardAction(cardAction("session_toggle_mode", { sessionId: SESSION_ID }, copy.id));
  assert.doesNotMatch(JSON.stringify(toggled), /请在对应会话话题内/);
  assert.equal(env.db.getSession(SESSION_ID)?.collaborationMode, "plan");
  await startTurn(env, "继续");
  assert.equal(app.count("turn/start"), 1);
  await shutdown(env);
}));

test("F14: pause and retry say what they do and do not do", () => withHome("codex-pause-retry-", async (home) => {
  const app = fakeAppServer();
  const env = await importedSession(home, app.server);
  const root = (text: string) => { const message = inbound({ messageId: `cmd-${text}`, text }); delete (message as { rootId?: string }).rootId; return message; };
  await env.service.onFeishuMessage(root("/pause"));
  assert.match(JSON.stringify(env.feishu.cards.at(-1)!.card), /正在运行的任务不会因此停止/);
  await env.service.onFeishuMessage(root("/resume-sync"));
  await env.service.onFeishuMessage(root("/retry"));
  assert.match(JSON.stringify(env.feishu.cards.at(-1)!.card), /不会重新执行任何任务|仍不可用/);
  assert.equal(app.count("turn/start") + app.count("turn/steer"), 0);
  assert.match(JSON.stringify(helpCard()), /不会停止正在运行的任务/);
  await shutdown(env);
}));
