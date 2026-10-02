import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { boundedPreview, cardContentBytes, headByBytes, serializedBytes, tailByBytes } from "../src/text-limits.js";
import { assistantRecord, cardAction, eventRecord, fakeAppServer, importedSession, jsonl, SESSION_ID, shutdown, startTurn, title, userRecord, waitFor } from "./codex-harness.js";

const turnStart = (method: string) => method === "turn/start" ? { turn: { id: "turn-1" } } : {};
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

async function withHome(prefix: string, work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  try { await work(home); } finally { await rm(home, { recursive: true, force: true }); }
}

type Env = Awaited<ReturnType<typeof importedSession>>;
const finishTurn = async (env: Env, text: string, status = "completed") => {
  await env.internals.onAppServerNotification({ method: "item/completed", params: { threadId: SESSION_ID, turnId: "turn-1", item: { id: "msg-1", type: "agentMessage", text } } });
  await env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: "turn-1", status } } });
};
const runCard = (env: Env) => env.feishu.latest(env.db.getRunStatus(SESSION_ID)?.messageId ?? "");

// F08 ------------------------------------------------------------------------------------------

test("F08: previews are cut by serialized UTF-8 bytes, between characters, and never repeat text", () => {
  for (const text of ["中".repeat(16_000), "😀".repeat(9_000), "a\"b\\\n".repeat(12_000), `${"x".repeat(30_000)}😀${"中".repeat(5_000)}`]) {
    const preview = boundedPreview(text, 25_000, "[省略]");
    assert.ok(serializedBytes(preview) <= 25_000, `${serializedBytes(preview)} bytes`);
    assert.equal(lone.test(preview), false);
    const [head, tail] = preview.split("\n\n[省略]\n\n");
    assert.ok(text.startsWith(head!) && text.endsWith(tail!));
    assert.ok(head!.length + tail!.length < text.length);
  }
  assert.equal(boundedPreview("短文本", 25_000, "[省略]"), "短文本");
  // Card text is escaped twice on its way to Feishu; quotes and line breaks count double.
  const quoted = "{\"key\": \"C:\\\\path\"}\n".repeat(3_000);
  const cardPreview = boundedPreview(quoted, 25_000, "[省略]", cardContentBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify({ text: cardPreview })), "utf8") <= 25_100);
  assert.equal(headByBytes("😀😀", 5), "😀");
  assert.equal(tailByBytes("😀😀", 5), "😀");
  assert.equal(headByBytes("ab", 0), "");
});

test("F08: a long reply keeps its full text in the attachment even when the card fails", () => withHome("codex-long-reply-", async (home) => {
  const app = fakeAppServer(turnStart);
  const env = await importedSession(home, app.server);
  await startTurn(env);
  env.feishu.failReplyCard = (card) => title(card) === "Codex" ? new Error("Feishu API 230099: card content is invalid") : null;
  const text = "中".repeat(16_000);
  await finishTurn(env, text);
  assert.equal(env.feishu.files.length, 1);
  assert.equal(env.feishu.files[0]!.data.toString("utf8"), text);
  assert.equal(env.db.taskForTurn("turn-1")?.status, "completed");
  assert.equal(title(runCard(env)), "Codex 运行状态");
  assert.match(JSON.stringify(runCard(env)), /结果发送失败/);
  assert.match(JSON.stringify(runCard(env)), /"action":"resend_result"/);
  await shutdown(env);
}));

// F07 ------------------------------------------------------------------------------------------

test("F07: a result that failed to send is sent again on request, without running anything, and the log does not post it", () => withHome("codex-resend-", async (home) => {
  const app = fakeAppServer(turnStart);
  const env = await importedSession(home, app.server);
  await startTurn(env);
  env.feishu.failReplyCard = (card) => title(card) === "Codex" ? new Error("ECONNRESET") : null;
  await finishTurn(env, "修改完成，测试通过。");
  const failed = env.db.getTurnOutput("turn-1")!;
  assert.equal(failed.cardStatus, "uncertain");
  assert.equal(failed.content, "修改完成，测试通过。");
  assert.match(JSON.stringify(runCard(env)), /可能已经发出/);

  // The same reply read back from the session log is left to the resend.
  await appendFile(env.path, jsonl([eventRecord(10, "task_started"), userRecord(11, "开始任务"), assistantRecord(12, "修改完成，测试通过。"), eventRecord(13, "task_complete")]));
  await env.service.syncAll();
  assert.equal(env.feishu.cards.filter((card) => JSON.stringify(card.card).includes("修改完成，测试通过。")).length, 0);

  env.feishu.failReplyCard = null;
  const calls = app.calls.length;
  const resent = await env.service.onCardAction(cardAction("resend_result", { turnId: "turn-1" }, "notice-card"));
  assert.match(JSON.stringify(resent), /正在重新发送/);
  await waitFor(() => JSON.stringify(env.feishu.latest("notice-card") ?? {}).includes("本轮结果已重新发送"));
  assert.equal(app.calls.length, calls);
  assert.equal(env.feishu.cards.filter((card) => JSON.stringify(card.card).includes("修改完成，测试通过。")).length, 1);
  const sent = env.db.getTurnOutput("turn-1")!;
  assert.deepEqual([sent.cardStatus, sent.content], ["sent", ""]);
  const again = await env.service.onCardAction(cardAction("resend_result", { turnId: "turn-1" }, "card-y"));
  assert.match(JSON.stringify(again), /本轮结果已在话题中/);
  assert.equal(env.feishu.cards.filter((card) => JSON.stringify(card.card).includes("修改完成，测试通过。")).length, 1);
  await shutdown(env);
}));

test("F07: a resend only sends the missing part, and output cut off by a stop is sent after the next start", () => withHome("codex-partial-", async (home) => {
  let turns = 0;
  const app = fakeAppServer((method) => method === "turn/start" ? { turn: { id: `turn-${++turns}` } } : {});
  const env = await importedSession(home, app.server);
  await startTurn(env);
  env.feishu.failReplyFile = () => new Error("Feishu API 234001: file upload failed");
  await finishTurn(env, "长".repeat(16_000));
  assert.deepEqual([env.db.getTurnOutput("turn-1")!.cardStatus, env.db.getTurnOutput("turn-1")!.fileStatus], ["sent", "failed"]);
  const cards = env.feishu.cards.filter((card) => title(card.card) === "Codex").length;
  env.feishu.failReplyFile = null;
  await env.service.onCardAction(cardAction("resend_result", { turnId: "turn-1" }));
  await waitFor(() => env.feishu.files.length === 1);
  assert.equal(env.feishu.cards.filter((card) => title(card.card) === "Codex").length, cards);
  assert.equal(env.feishu.files.length, 1);

  // A second turn is cut off by the service stopping; its text is kept and sent later.
  await env.service.onFeishuMessage({ messageId: "start-2", chatId: "chat-1", chatType: "group", senderOpenId: "user-1", mentionedBot: false, text: "继续", imageKeys: [], rootId: "root-1" });
  const internals = env.internals as unknown as { deliverPendingOutputs(): Promise<void> };
  await waitFor(() => env.internals.turnCoordinator.mutableTurn(SESSION_ID)?.turnId === "turn-2");
  await env.internals.onAppServerNotification({ method: "item/completed", params: { threadId: SESSION_ID, turnId: "turn-2", item: { id: "msg-2", type: "agentMessage", text: "写到一半" } } });
  await env.service.stop();
  const pending = env.db.pendingTurnOutputs();
  assert.equal(pending.length, 1);
  assert.match(pending[0]!.content, /写到一半/);
  await internals.deliverPendingOutputs();
  assert.equal(env.db.pendingTurnOutputs().length, 0);
  assert.ok(env.feishu.cards.some((card) => JSON.stringify(card.card).includes("写到一半")));
  env.db.close();
}));

test("F07: the resend button survives later turns in a notice of its own, and failed results are retried by /retry", () => withHome("codex-notice-", async (home) => {
  let turns = 0;
  const app = fakeAppServer((method) => method === "turn/start" ? { turn: { id: `turn-${++turns}` } } : {});
  const env = await importedSession(home, app.server);
  await startTurn(env);
  env.feishu.failReplyCard = (card) => title(card) === "Codex" ? new Error("Feishu API 230099: card content is invalid") : null;
  await finishTurn(env, "第一轮的结论");
  await waitFor(() => env.feishu.cards.some((card) => card.root === "root-1" && JSON.stringify(card.card).includes("resend_result") && card.id !== env.db.getRunStatus(SESSION_ID)?.messageId));
  const notice = env.feishu.cards.find((card) => JSON.stringify(card.card).includes("resend_result") && card.id !== env.db.getRunStatus(SESSION_ID)?.messageId)!;
  // A next turn takes over the shared run card; the notice keeps its button.
  await env.service.onFeishuMessage({ messageId: "next-1", chatId: "chat-1", chatType: "group", senderOpenId: "user-1", mentionedBot: false, text: "下一步", imageKeys: [], rootId: "root-1" });
  await waitFor(() => env.internals.turnCoordinator.mutableTurn(SESSION_ID)?.turnId === "turn-2");
  assert.match(JSON.stringify(env.feishu.latest(notice.id)), /"action":"resend_result"/);
  // Once Feishu accepts cards again, /retry (or the periodic scan) sends the missing result.
  env.feishu.failReplyCard = null;
  env.db.db.prepare("UPDATE turn_outputs SET updated_at_ms=0 WHERE turn_id='turn-1'").run();
  const retry = { messageId: "retry-1", chatId: "chat-1", chatType: "group" as const, senderOpenId: "user-1", mentionedBot: true, text: "/retry", imageKeys: [] };
  await env.service.onFeishuMessage(retry);
  await waitFor(() => env.db.getTurnOutput("turn-1")?.cardStatus === "sent");
  assert.ok(env.feishu.cards.some((card) => title(card.card) === "Codex" && JSON.stringify(card.card).includes("第一轮的结论")));
  await waitFor(() => JSON.stringify(env.feishu.latest(notice.id)).includes("本轮结果已发到话题中"));
  await shutdown(env);
}));
