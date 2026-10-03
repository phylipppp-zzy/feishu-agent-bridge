import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { displayTime } from "../src/card-kit.js";
import { approvalReasonText, permissionEntries, remoteApprovalAllowed, unwrapShellCommand } from "../src/execution-policy.js";
import { stripHostContext } from "../src/session-parser.js";
import type { FeishuPort } from "../src/types.js";
import { fakeAppServer, importedSession, inbound, SESSION_ID, shutdown, startTurn, title, waitFor } from "./codex-harness.js";

async function withHome(prefix: string, work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  try { await work(home); } finally { await rm(home, { recursive: true, force: true }); }
}

/** Each turn/start opens the next turn: turn-1, turn-2, … */
function numberedTurns() {
  let next = 0;
  return (method: string) => method === "turn/start" ? { turn: { id: `turn-${++next}` } } : {};
}

type Env = Awaited<ReturnType<typeof importedSession>>;
const finishTurn = async (env: Env, turnId: string, text: string) => {
  await env.internals.onAppServerNotification({ method: "item/completed", params: { threadId: SESSION_ID, turnId, item: { id: `msg-${turnId}`, type: "agentMessage", text } } });
  await env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: turnId, status: "completed" } } });
};

// Command approvals ------------------------------------------------------------------------------

const context = { taskId: "t1", sessionId: "s1", collaborationMode: "default" as const, executionMode: "workspace-write" as const, canonicalCwd: "/work/project", allowedMcpServers: new Set<string>() };
const allowed = (command: unknown) => remoteApprovalAllowed("command_approval", { command }, [], context).allowed;

test("the shell Codex wraps every command in is removed before the command is checked", () => {
  assert.equal(unwrapShellCommand("/bin/bash -lc 'touch /home/u/f06.txt'"), "touch /home/u/f06.txt");
  assert.equal(unwrapShellCommand(`/bin/bash -lc "printf \\"%s\\" ok"`), `printf "%s" ok`);
  assert.equal(unwrapShellCommand(`/bin/bash -lc 'it'\\''s'`), "it's");
  // Anything but exactly one quoted word after the wrapper is left as it is.
  for (const command of ["/bin/bash -lc 'a' 'b'", "/bin/bash -lc 'a'; curl x", `/bin/bash -lc "$(curl x)"`, "/bin/bash -lc 'a'\\\n'b'", "printf ok"]) {
    assert.equal(unwrapShellCommand(command), command);
  }
  assert.equal(allowed("/bin/bash -lc 'touch /home/u/f06.txt'"), true);
  assert.equal(allowed(["/bin/bash", "-lc", "printf ok"]), true);
  assert.equal(remoteApprovalAllowed("command_approval", { command: "/bin/bash -lc 'touch f'" }, [], context).summary?.commandSummary, "touch f");
});

test("network tools, nested shells and words split by quotes are still declined", () => {
  for (const script of ["curl -L https://example.com", "bash -c \"rm -rf x\"", "c''url x", "c\"u\"rl x", "cu\\\nrl x", "x=curl; $x y",
    "s''udo ls", "eval ls", "cat ~/.s''sh/id_rsa", "echo $'\\x63url'", "ls > out"]) {
    assert.equal(allowed(`/bin/bash -lc '${script.replace(/'/g, "'\\''")}'`), false, script);
  }
  assert.equal(allowed(`/bin/bash -lc "$(curl x)"`), false);
  assert.match(approvalReasonText("command cannot be safely reviewed or may upload data"), /curl/);
  assert.equal(approvalReasonText("unknown reason"), "unknown reason");
});

const commandRequest = (id: number, command: string) => ({ jsonrpc: "2.0" as const, id, method: "item/commandExecution/requestApproval",
  params: { threadId: SESSION_ID, turnId: "turn-1", itemId: `call-${id}`, command, reason: "需要在项目外写文件" } });

test("an approvable command is shown as a code block on its card", { timeout: 10_000 }, () => withHome("codex-approval-card-", async (home) => {
  const app = fakeAppServer(numberedTurns());
  const env = await importedSession(home, app.server);
  await startTurn(env);
  void env.internals.onAppServerRequest(commandRequest(7, "/bin/bash -lc 'touch /home/u/f06.txt'")).catch(() => undefined);
  await waitFor(() => env.feishu.cards.some((card) => title(card.card) === "Codex 请求执行命令"));
  const card = JSON.stringify(env.feishu.cards.find((item) => title(item.card) === "Codex 请求执行命令")!.card);
  assert.match(card, /```\\ntouch \/home\/u\/f06.txt\\n```/);
  assert.doesNotMatch(card, /bin\/bash/);
  await shutdown(env);
}));

test("a request declined by the safety rules is reported in the topic instead of disappearing", { timeout: 10_000 }, () => withHome("codex-approval-declined-", async (home) => {
  const app = fakeAppServer(numberedTurns());
  const env = await importedSession(home, app.server);
  await startTurn(env);
  await assert.rejects(env.internals.onAppServerRequest(commandRequest(8, "/bin/bash -lc 'curl -L https://example.com'")), /may upload data/);
  await waitFor(() => env.feishu.cards.some((card) => title(card.card) === "已自动拒绝：Codex 请求执行命令"));
  const card = JSON.stringify(env.feishu.cards.find((item) => title(item.card) === "已自动拒绝：Codex 请求执行命令")!.card);
  assert.match(card, /curl -L https:\/\/example.com/);
  assert.match(card, /网络传输工具/);
  assert.equal(env.feishu.cards.some((item) => title(item.card) === "Codex 请求执行命令"), false);
  await shutdown(env);
}));

// Permission requests (Codex 0.154 RequestPermissionProfile) -------------------------------------

const profile = (write: string) => ({ fileSystem: { entries: [{ access: "write", path: { type: "path", path: write } }] }, network: null });
const permissionRequest = (id: number, permissions: unknown) => ({ jsonrpc: "2.0" as const, id, method: "item/permissions/requestApproval",
  params: { threadId: SESSION_ID, turnId: "turn-1", itemId: `call-${id}`, cwd: "/work/project", permissions, reason: "需要写这个文件", startedAtMs: 0 } });

test("a permission profile is read in its entries, legacy and network forms", () => {
  assert.deepEqual(permissionEntries({ permissions: profile("/work/project/.git/x") }), [{ type: "fs_write", path: "/work/project/.git/x" }]);
  assert.deepEqual(permissionEntries({ permissions: { fileSystem: { read: ["/work/project/a"], write: ["/work/project/b"] } } }),
    [{ type: "fs_read", path: "/work/project/a" }, { type: "fs_write", path: "/work/project/b" }]);
  assert.deepEqual(permissionEntries({ permissions: { fileSystem: { entries: [{ access: "write", path: { type: "glob_pattern", pattern: "**" } }] } } }), [{ type: "fs_glob" }]);
  assert.deepEqual(permissionEntries({ permissions: { network: { enabled: true } } }), [{ type: "network" }]);
  assert.equal(remoteApprovalAllowed("permissions", { permissions: profile("/work/project/.git/x") }, [], context).allowed, true);
  assert.equal(remoteApprovalAllowed("permissions", { permissions: profile("/home/u/f06.txt") }, [], context).reason, "filesystem access is outside the authorized workspace or sensitive");
  assert.equal(remoteApprovalAllowed("permissions", { permissions: { fileSystem: { entries: [{ access: "write", path: { type: "glob_pattern", pattern: "**" } }] } } }, [], context).allowed, false);
});

test("a permission request inside the project gets a card, and approving it grants the profile Codex asked for", { timeout: 10_000 }, () => withHome("codex-permission-card-", async (home) => {
  const app = fakeAppServer(numberedTurns());
  const env = await importedSession(home, app.server);
  await startTurn(env);
  const asked = profile(join(home, ".git", "f06-perm.txt"));
  const result = env.internals.onAppServerRequest(permissionRequest(9, asked));
  await waitFor(() => env.feishu.cards.some((card) => title(card.card) === "Codex 请求额外权限"));
  const card = JSON.stringify(env.feishu.cards.find((item) => title(item.card) === "Codex 请求额外权限")!.card);
  assert.match(card, /写入：\.git\/f06\-perm\.txt/);
  const nonce = env.db.nextServerRequest(SESSION_ID, "permissions")!.nonce;
  await env.service.onCardAction({ openId: "user-1", chatId: "chat-1", openMessageId: "card-x", action: "remote_approve", value: { nonce, decision: "accept" }, formValues: {} });
  assert.deepEqual(await result, { permissions: asked, scope: "turn" });
  await shutdown(env);
}));

test("a permission request outside the project is declined with that reason", { timeout: 10_000 }, () => withHome("codex-permission-outside-", async (home) => {
  const app = fakeAppServer(numberedTurns());
  const env = await importedSession(home, app.server);
  await startTurn(env);
  await assert.rejects(env.internals.onAppServerRequest(permissionRequest(10, profile("/outside/f06.txt"))), /outside the authorized workspace/);
  await waitFor(() => env.feishu.cards.some((card) => title(card.card) === "已自动拒绝：Codex 请求额外权限"));
  assert.match(JSON.stringify(env.feishu.cards.at(-1)!.card), /项目目录之外/);
  await shutdown(env);
}));

test("the note Codex writes after an interrupted turn is not shown as the person's message", () => {
  assert.equal(stripHostContext("<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"), "");
  assert.equal(stripHostContext("<turn_aborted>\nx\n</turn_aborted>\n继续刚才的任务"), "继续刚才的任务");
});

// Run status cards ------------------------------------------------------------------------------

test("each new turn gets its own status card at the end of the topic", { timeout: 10_000 }, () => withHome("codex-fresh-run-card-", async (home) => {
  const app = fakeAppServer(numberedTurns());
  const env = await importedSession(home, app.server);
  await startTurn(env);
  const first = env.db.getRunStatus(SESSION_ID)!.messageId!;
  await finishTurn(env, "turn-1", "第一轮");
  await env.service.onFeishuMessage(inbound({ messageId: "start-2", text: "第二轮" }));
  await waitFor(() => env.internals.turnCoordinator.hasActiveTurn(SESSION_ID));
  const second = env.db.getRunStatus(SESSION_ID)!.messageId!;
  assert.notEqual(second, first);
  assert.match(JSON.stringify(env.feishu.latest(second)), /"action":"cancel_run"/);
  // The first turn's card keeps its own result.
  assert.match(JSON.stringify(env.feishu.latest(first)), /完成/);
  await shutdown(env);
}));

// Delivery --------------------------------------------------------------------------------------

test("a reply being closed in its streaming card is not posted again by the periodic delivery pass", { timeout: 10_000 }, () => withHome("codex-stream-race-", async (home) => {
  const app = fakeAppServer(numberedTurns());
  const env = await importedSession(home, app.server);
  const port = env.feishu as FeishuPort;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let finished = 0;
  port.createStreamingReply = async () => ({ cardId: "card-stream", messageId: "stream-1", elementId: "stream_md", sequence: 0 });
  port.updateStreamingReply = async (stream) => { await gate; return stream.sequence + 1; };
  port.finishStreamingReply = async () => { finished += 1; };
  await startTurn(env);
  const replies = env.feishu.cards.filter((card) => title(card.card) === "Codex").length;
  env.internals.turnCoordinator.mutableTurn(SESSION_ID)!.stream = { cardId: "card-stream", messageId: "stream-1", elementId: "stream_md", sequence: 0, lastSentAt: Date.now() };
  await env.internals.onAppServerNotification({ method: "item/completed", params: { threadId: SESSION_ID, turnId: "turn-1", item: { id: "msg-1", type: "agentMessage", text: "第1行\n第2行" } } });
  const completed = env.internals.onAppServerNotification({ method: "turn/completed", params: { threadId: SESSION_ID, turn: { id: "turn-1", status: "completed" } } });
  await waitFor(() => env.db.getTurnOutput("turn-1") !== null);
  const scan = (env.service as unknown as { deliverPendingOutputs(includeFailed: boolean): Promise<void> }).deliverPendingOutputs(true);
  release();
  await Promise.all([completed, scan]);
  // The only other "Codex" card is the reply imported from the session log before the turn.
  assert.equal(env.feishu.cards.filter((card) => title(card.card) === "Codex").length, replies);
  assert.equal(env.db.getTurnOutput("turn-1")?.attempts, 1);
  assert.equal(finished, 1);
  assert.equal(env.db.getTurnOutput("turn-1")?.cardMessageId, "stream-1");
  await shutdown(env);
}));

test("card times are shown in Beijing time whatever the server's time zone", () => {
  assert.equal(displayTime(Date.UTC(2026, 9, 3, 14, 12, 29)), "2026/10/3 22:12:29（北京时间）");
});
