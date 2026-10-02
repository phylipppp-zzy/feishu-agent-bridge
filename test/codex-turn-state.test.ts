import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cardAction, fakeAppServer, importedSession, inbound, SESSION_ID, shutdown, startTurn, title, waitFor, whileWaiting } from "./codex-harness.js";

const exists = (path: string) => access(path).then(() => true, () => false);
const turnStart = (method: string) => method === "turn/start" ? { turn: { id: "turn-1" } } : {};

async function withHome(prefix: string, work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  try { await work(home); } finally { await rm(home, { recursive: true, force: true }); }
}

// F04 ------------------------------------------------------------------------------------------

test("F04: a message Codex accepted into the running turn is not queued again when the Feishu confirmation fails", () => withHome("codex-steer-ack-", async (home) => {
  const app = fakeAppServer(turnStart);
  const env = await importedSession(home, app.server);
  await startTurn(env);
  env.feishu.failReplyText = (text) => text.startsWith("已发送给当前 Codex 回合") ? new Error("Feishu API 500") : null;
  await env.service.onFeishuMessage(inbound({ messageId: "steer-1", text: "顺便改文档", imageKeys: ["img-1"] }));
  assert.equal(app.count("turn/steer"), 1);
  assert.equal(env.db.taskStateCounts().pending, undefined);
  // The image stays with the turn until it ends, since Codex may still read it.
  const images = JSON.parse(env.db.getSetting("turn.turn-1.images") ?? "[]") as string[];
  assert.equal(images.length, 1);
  assert.equal(await exists(images[0]!), true);

  // The same Feishu event delivered again (retry, or after a restart) runs nothing.
  env.feishu.failReplyText = null;
  env.db.db.prepare("DELETE FROM inbound_events WHERE event_id='message:steer-1'").run();
  await env.service.onFeishuMessage(inbound({ messageId: "steer-1", text: "顺便改文档" }));
  assert.equal(app.count("turn/steer"), 1);
  assert.equal(env.db.taskStateCounts().pending, undefined);
  assert.ok(env.feishu.texts.some((item) => item.text === "已发送给当前 Codex 回合。"));

  await env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: "turn-1", status: "completed" } } });
  assert.equal(await exists(images[0]!), false);
  await shutdown(env);
}));

test("F04: a refused message runs once in the next turn, and an unanswered one is not resubmitted", () => withHome("codex-steer-refused-", async (home) => {
  let steer: () => unknown = () => new Error("turn already completed: expectedTurnId does not match");
  const app = fakeAppServer((method) => method === "turn/steer" ? steer() : turnStart(method));
  const env = await importedSession(home, app.server);
  await startTurn(env);
  await env.service.onFeishuMessage(inbound({ messageId: "steer-refused", text: "下一步", imageKeys: ["img-1"] }));
  assert.equal(app.count("turn/steer"), 1);
  assert.equal(env.db.taskStateCounts().pending, 1);
  assert.deepEqual(JSON.parse(env.db.getSetting("turn.turn-1.images") ?? "[]"), []);

  steer = () => new Error("Codex app-server request turn/steer timed out after 15000ms");
  await env.service.onFeishuMessage(inbound({ messageId: "steer-unknown", text: "再补充一点" }));
  assert.equal(app.count("turn/steer"), 2);
  assert.equal(env.db.taskStateCounts().pending, 1);
  assert.ok(env.feishu.texts.some((item) => item.text.startsWith("没能确认这条消息是否已交给当前 Codex 回合")));
  env.db.db.prepare("DELETE FROM inbound_events WHERE event_id='message:steer-unknown'").run();
  await env.service.onFeishuMessage(inbound({ messageId: "steer-unknown", text: "再补充一点" }));
  assert.equal(app.count("turn/steer"), 2);
  assert.equal(env.db.taskStateCounts().pending, 1);
  await shutdown(env);
}));

// F05 ------------------------------------------------------------------------------------------

test("F05: a refused interrupt leaves the turn running, with its images, and says the cancellation failed", () => withHome("codex-cancel-refused-", async (home) => {
  const app = fakeAppServer((method) => method === "turn/interrupt" ? new Error("interrupt rejected by Codex") : turnStart(method));
  const env = await importedSession(home, app.server);
  await startTurn(env);
  await env.service.onFeishuMessage(inbound({ messageId: "steer-img", text: "看图", imageKeys: ["img-1"] }));
  const images = JSON.parse(env.db.getSetting("turn.turn-1.images") ?? "[]") as string[];
  await env.service.onFeishuMessage(inbound({ messageId: "cancel-1", text: "/cancel" }));
  assert.equal(app.count("turn/interrupt"), 1);
  const turn = env.internals.turnCoordinator.mutableTurn(SESSION_ID);
  assert.equal(turn?.state, "running");
  assert.equal(env.db.taskForTurn("turn-1")?.status, "running");
  assert.equal(await exists(images[0]!), true);
  assert.ok(env.feishu.texts.some((item) => item.text.startsWith("取消失败")));
  // The turn still delivers its output.
  await env.internals.onAppServerNotification({ method: "item/agentMessage/delta", params: { threadId: SESSION_ID, turnId: "turn-1", delta: "继续工作" } });
  await env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: "turn-1", status: "completed" } } });
  assert.equal(env.db.taskForTurn("turn-1")?.status, "completed");
  await shutdown(env);
}));

test("F05: an accepted interrupt ends the turn only when Codex says so; repeats and new messages wait", () => withHome("codex-cancel-accepted-", async (home) => {
  const app = fakeAppServer(turnStart);
  const env = await importedSession(home, app.server);
  await startTurn(env);
  await env.service.onFeishuMessage(inbound({ messageId: "cancel-a", text: "/cancel" }));
  await env.service.onFeishuMessage(inbound({ messageId: "cancel-b", text: "/cancel" }));
  assert.equal(app.count("turn/interrupt"), 1);
  assert.equal(env.internals.turnCoordinator.mutableTurn(SESSION_ID)?.state, "cancelling");
  assert.equal(env.db.taskForTurn("turn-1")?.status, "running");
  assert.ok(env.feishu.texts.some((item) => item.text.startsWith("正在取消")));
  // A message during the cancellation is not steered into the dying turn; it waits for the next one.
  await env.service.onFeishuMessage(inbound({ messageId: "after-cancel", text: "换个方向" }));
  assert.equal(app.count("turn/steer"), 0);
  assert.equal(env.db.taskStateCounts().pending, 1);
  await env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: "turn-1", status: "interrupted" } } });
  assert.equal(env.db.taskForTurn("turn-1")?.status, "interrupted");
  await waitFor(() => app.count("turn/start") === 2);
  await shutdown(env);
}));

test("F05: a turn that finishes on its own while being cancelled keeps its real result", () => withHome("codex-cancel-race-", async (home) => {
  const app = fakeAppServer(turnStart);
  const env = await importedSession(home, app.server);
  await startTurn(env);
  const status = await env.service.onCardAction(cardAction("cancel_run", { sessionId: SESSION_ID }));
  assert.match(JSON.stringify(status), /正在取消/);
  await env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: "turn-1", status: "completed" } } });
  assert.equal(env.db.taskForTurn("turn-1")?.status, "completed");
  assert.equal(env.internals.turnCoordinator.hasActiveTurn(SESSION_ID), false);
  await shutdown(env);
}));

test("F05: a cancel that arrives while a finished turn's result is being sent changes nothing", () => withHome("codex-cancel-after-end-", async (home) => {
  const app = fakeAppServer(turnStart);
  const env = await importedSession(home, app.server);
  await startTurn(env);
  await env.internals.onAppServerNotification({ method: "item/completed", params: { threadId: SESSION_ID, turnId: "turn-1", item: { id: "m1", type: "agentMessage", text: "完成了" } } });
  let release!: () => void;
  env.feishu.replyCardGate = new Promise((resolve) => { release = resolve; });
  const completing = env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: "turn-1", status: "completed" } } });
  await waitFor(() => env.feishu.calls.includes("replyCard"));
  await env.service.onFeishuMessage(inbound({ messageId: "late-cancel", text: "/cancel" }));
  assert.equal(app.count("turn/interrupt"), 0);
  assert.ok(env.feishu.texts.some((item) => item.text.startsWith("本轮已结束")));
  release(); env.feishu.replyCardGate = null;
  await completing;
  assert.equal(env.db.taskForTurn("turn-1")?.status, "completed");
  await waitFor(() => env.db.getRunStatus(SESSION_ID)?.state === "完成");
  await shutdown(env);
}));

test("F05: a task cancelled while turn/start is on its way is stopped as soon as the turn exists", () => withHome("codex-cancel-starting-", async (home) => {
  let release!: () => void;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const app = fakeAppServer((method) => method === "turn/start" ? started.then(() => ({ turn: { id: "turn-1" } })) : {});
  const env = await importedSession(home, app.server);
  await env.service.onFeishuMessage(inbound({ messageId: "start-slow", text: "开始" }));
  await waitFor(() => app.count("turn/start") === 1);
  await env.service.onFeishuMessage(inbound({ messageId: "cancel-early", text: "/cancel" }));
  assert.ok(env.feishu.texts.some((item) => item.text.includes("正在启动的任务如果已交给 Codex，会立即被停止")));
  release();
  await waitFor(() => app.count("turn/interrupt") === 1);
  assert.equal(env.internals.turnCoordinator.mutableTurn(SESSION_ID)?.state, "cancelling");
  await env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: "turn-1", status: "interrupted" } } });
  assert.equal(env.internals.turnCoordinator.hasActiveTurn(SESSION_ID), false);
  await shutdown(env);
}));

test("F05: an unanswered interrupt leaves the turn cancelling and says so; a turn that ends during the interrupt keeps its card", () => withHome("codex-cancel-unanswered-", async (home) => {
  let interrupt: () => unknown = () => new Error("Codex app-server request turn/interrupt timed out after 15000ms");
  let env!: Awaited<ReturnType<typeof importedSession>>;
  const app = fakeAppServer((method) => method === "turn/interrupt" ? interrupt() : turnStart(method));
  env = await importedSession(home, app.server);
  await startTurn(env);
  await env.service.onFeishuMessage(inbound({ messageId: "cancel-t1", text: "/cancel" }));
  assert.equal(env.internals.turnCoordinator.mutableTurn(SESSION_ID)?.state, "cancelling");
  assert.ok(env.feishu.texts.some((item) => item.text.startsWith("取消待确认")));
  await env.service.onFeishuMessage(inbound({ messageId: "cancel-t2", text: "/cancel" }));
  assert.equal(app.count("turn/interrupt"), 1);
  await env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: "turn-1", status: "interrupted" } } });
  await waitFor(() => env.db.getRunStatus(SESSION_ID)?.state === "已取消");

  // Next turn: Codex ends it while answering the interrupt; the "cancelling" card must not come back.
  await env.service.onFeishuMessage(inbound({ messageId: "start-2", text: "再来" }));
  await waitFor(() => env.internals.turnCoordinator.hasActiveTurn(SESSION_ID));
  interrupt = () => env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: "turn-1", status: "interrupted" } } }).then(() => ({}));
  await env.service.onFeishuMessage(inbound({ messageId: "cancel-t3", text: "/cancel" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(env.db.getRunStatus(SESSION_ID)?.state, "已取消");
  await shutdown(env);
}));

// F06 ------------------------------------------------------------------------------------------

const question = { id: "scope", header: "范围", question: "处理哪些内容？", options: [{ label: "完整", description: "全部" }, { label: "精简", description: "重点" }] };
const userInput = (id: number, extra: Record<string, unknown> = {}) => ({ jsonrpc: "2.0" as const, id, method: "item/tool/requestUserInput",
  params: { threadId: SESSION_ID, turnId: "turn-1", itemId: `call-${id}`, questions: [question], ...extra } });

test("F06: an answer given while the run card is still updating reaches Codex", () => withHome("codex-request-early-", async (home) => {
  const app = fakeAppServer(turnStart);
  const env = await importedSession(home, app.server);
  await startTurn(env);
  let release!: () => void;
  env.feishu.updateGate = new Promise((resolve) => { release = resolve; });
  const result = env.internals.onAppServerRequest(userInput(7));
  await waitFor(() => env.feishu.cards.some((card) => title(card.card) === "Codex 等待你的回答 1/1"));
  const nonce = env.db.nextServerRequest(SESSION_ID, "user_input")!.nonce;
  const answered = env.service.onCardAction(cardAction("remote_answer", { nonce, questionIndex: 0, optionIndex: 1 }));
  release();
  env.feishu.updateGate = null;
  await answered;
  assert.deepEqual(await result, { answers: { scope: { answers: ["精简"] } } });
  assert.equal(env.db.getServerRequest(nonce)?.status, "resolved");
  assert.equal(env.internals.approvalService.pendingCount(), 0);
  await shutdown(env);
}));

test("F06: an unanswered request is declined when its time is up, and a request whose card cannot be shown fails at once", () => withHome("codex-request-timeout-", async (home) => {
  const app = fakeAppServer(turnStart);
  const env = await importedSession(home, app.server);
  await startTurn(env);
  const timedOut = await whileWaiting(env.internals.onAppServerRequest(userInput(8, { autoResolutionMs: 30 })));
  assert.deepEqual(timedOut, { answers: {} });
  assert.equal(env.db.getServerRequest(env.db.db.prepare("SELECT nonce FROM server_requests WHERE item_id='call-8'").get()!.nonce as string)?.status, "declined");

  env.feishu.failReplyCard = (card) => title(card).startsWith("Codex 等待你的回答") ? new Error("Feishu API 500") : null;
  await assert.rejects(env.internals.onAppServerRequest(userInput(9)), /Feishu API 500/);
  const failed = env.db.db.prepare("SELECT status FROM server_requests WHERE item_id='call-9'").get() as { status: string };
  assert.equal(failed.status, "expired");
  assert.equal(env.internals.approvalService.pendingCount(), 0);
  assert.equal(env.internals.turnCoordinator.mutableTurn(SESSION_ID)?.state, "running");
  await shutdown(env);
}));

test("F06: a request Codex withdraws stops waiting, and a late answer finds nothing", () => withHome("codex-request-withdrawn-", async (home) => {
  const app = fakeAppServer(turnStart);
  const env = await importedSession(home, app.server);
  await startTurn(env);
  const result = env.internals.onAppServerRequest(userInput(10));
  await waitFor(() => env.db.nextServerRequest(SESSION_ID, "user_input") !== null);
  const nonce = env.db.nextServerRequest(SESSION_ID, "user_input")!.nonce;
  await env.internals.onAppServerNotification({ method: "serverRequest/resolved", params: { threadId: SESSION_ID, requestId: 10 } });
  assert.deepEqual(await whileWaiting(result), { action: "cancel", decision: "cancel" });
  assert.equal(env.internals.approvalService.pendingCount(), 0);
  const late = await env.service.onCardAction(cardAction("remote_answer", { nonce, questionIndex: 0, optionIndex: 0 }));
  assert.match(JSON.stringify(late), /已过期、已回答/);
  await shutdown(env);
}));
