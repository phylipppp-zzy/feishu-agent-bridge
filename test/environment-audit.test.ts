import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeDiagnostic, isExpiredFeishuMessage } from "../src/safe-log.js";
import { BridgeDatabase } from "../src/db.js";
import { CodexCliProbe } from "../src/codex.js";
import { SyncService } from "../src/sync.js";
import type { BridgeConfig, FeishuPort, ModelCapability, IncomingFeishuMessage, TurnState } from "../src/types.js";
import { TurnCoordinator } from "../src/turn-coordinator.js";
import { threadSandboxMode } from "../src/execution-policy.js";

test("thread sandbox mode matches the app-server schema and fails closed for unknown policies", () => {
  assert.equal(threadSandboxMode({ type: "readOnly", networkAccess: false }), "read-only");
  assert.equal(threadSandboxMode({ type: "workspaceWrite", writableRoots: ["/workspace"] }), "workspace-write");
  assert.equal(threadSandboxMode({ type: "dangerFullAccess" }), "danger-full-access");
  assert.throws(() => threadSandboxMode({ type: "externalSandbox" }), /Unsupported/);
});

test("nested turn completion remains behind preceding delta processing", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new TurnCoordinator({ executeTask: async () => {}, interruptTurn: async () => {}, onLifecycle: async () => {},
    onNotification: async (event) => { if (event.method === "item/agentMessage/delta") await gate; order.push(event.method!); } });
  const delta = coordinator.handleNotification({ method: "item/agentMessage/delta", params: { threadId: "s", turnId: "t", delta: "a" } });
  const end = coordinator.handleNotification({ method: "turn/completed", params: { threadId: "s", turn: { id: "t", status: "completed" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  release(); await Promise.all([delta, end]);
  assert.deepEqual(order, ["item/agentMessage/delta", "turn/completed"]);
});

test("completion commits the full stream, prevents JSONL duplicates, and releases queued follow-up", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bridge-live-completion-"));
  const sid = "11111111-1111-4111-8111-111111111111";
  const path = join(stateDir, `rollout-2026-09-22T00-00-00-${sid}.jsonl`);
  await writeFile(path, "not parsed while the live stream owns delivery\n");
  const config: BridgeConfig = { appId: "app", appSecret: "secret", bindToken: "token", allowedRoot: stateDir, codexHome: stateDir, codexBin: "/bin/false", stateDir, scanIntervalMs: 1000, activeSessionQuietMs: 1 };
  const db = new BridgeDatabase(stateDir);
  const rendered: string[] = [];
  let drained = 0, finished = 0;
  try {
    db.setSetting("feishu.chat_id", "chat");
    db.upsertSession({ sessionId: sid, path, cwd: stateDir, startedAt: new Date().toISOString(), source: "appServer", firstUserText: "test" });
    db.setSessionRoot(sid, "root");
    db.enqueueTask({ id: "task", kind: "new", sessionId: sid, cwd: stateDir, prompt: "test", imageKeys: [], sourceMessageId: "source", chatId: "chat", rootMessageId: "root", model: "gpt-6-astra", reasoningEffort: "high", status: "running", runCardMessageId: null, expectedSessionId: sid, syncStatus: "none", lastSyncOffset: null, turnId: "turn" });
    const feishu = {
      createStreamingReply: async () => ({ cardId: "card", messageId: "stream-message", elementId: "md", sequence: 0 }),
      updateStreamingReply: async (stream: { sequence: number }, text: string) => { rendered.push(text); return stream.sequence + 1; },
      finishStreamingReply: async () => { finished++; assert.equal(runtime.turnCoordinator.hasActiveTurn(sid), true); await runtime.processFile(path); },
    } as unknown as FeishuPort;
    const service = new SyncService(config, db, feishu, new CodexCliProbe("/bin/false", stateDir));
    const runtime = service as unknown as { turnCoordinator: TurnCoordinator; processFile: (p: string) => Promise<void>; onAppServerNotification: (e: object) => Promise<void>; updateRunCard: () => Promise<void>; drainTaskQueue: () => Promise<void> };
    runtime.updateRunCard = async () => {};
    runtime.drainTaskQueue = async () => { drained++; };
    const state: TurnState = { sessionId: sid, turnId: "turn", epoch: 1, mode: "default", state: "running", text: "", plan: "", rootMessageId: "root" };
    runtime.turnCoordinator.setTurn(state); db.saveTurn(state);
    await runtime.processFile(path);
    assert.equal(db.getCursor(path).parsedOffset, 0);
    await runtime.onAppServerNotification({ method: "item/agentMessage/delta", params: { threadId: sid, turnId: "turn", delta: "fe" } });
    await runtime.onAppServerNotification({ method: "item/completed", params: { threadId: sid, turnId: "turn", item: { id: "a", type: "agentMessage", text: "FEISHU_GPT6_OK" } } });
    await runtime.onAppServerNotification({ method: "item/completed", params: { threadId: sid, turnId: "turn", item: { id: "b", type: "agentMessage", text: "second message" } } });
    await runtime.onAppServerNotification({ method: "turn/completed", params: { threadId: sid, turn: { id: "turn", status: "completed" } } });
    assert.equal(rendered.at(-1), "FEISHU_GPT6_OK\n\nsecond message");
    assert.equal(finished, 1); assert.equal(drained, 1);
    assert.equal(db.getTask("task")?.status, "completed");
    assert.equal(runtime.turnCoordinator.hasActiveTurn(sid), false);
    for (const text of ["FEISHU_GPT6_OK", "second message"]) {
      assert.equal(db.findAppServerDelivery(sid, "assistant", createHash("sha256").update(text).digest("hex"))?.feishuMessageId, "stream-message");
    }
  } finally { db.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test("slow queued-card response cannot rewind a claimed new task or break session persistence", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bridge-card-race-"));
  const config: BridgeConfig = { appId: "app", appSecret: "secret", bindToken: "token", allowedRoot: stateDir, codexHome: stateDir, codexBin: "/bin/false", stateDir, scanIntervalMs: 1000, activeSessionQuietMs: 1 };
  const db = new BridgeDatabase(stateDir);
  try {
    const service = new SyncService(config, db, {} as FeishuPort, new CodexCliProbe("/bin/false", stateDir));
    let claimedId = "";
    const runtime = service as unknown as {
      respondCard: () => Promise<string>; drainTaskQueue: () => Promise<void>;
      runNewSession: (m: IncomingFeishuMessage, cwd: string, prompt: string, model: string, effort: string) => Promise<void>;
    };
    runtime.respondCard = async () => {
      const claimed = db.claimNextTask(null)!; claimedId = claimed.id;
      db.updateTask(claimed.id, "creating_thread", { phase: "creating_thread", creationAttemptId: "attempt" });
      await Promise.resolve();
      return "delayed-card";
    };
    runtime.drainTaskQueue = async () => {};
    await runtime.runNewSession({ messageId: "source", chatId: "chat", chatType: "group", senderOpenId: "owner", mentionedBot: true, text: "test", imageKeys: [] }, stateDir, "test", "gpt-6-astra", "high");
    assert.equal(db.getTask(claimedId)?.status, "creating_thread");
    assert.equal(db.getTask(claimedId)?.runCardMessageId, "delayed-card");
    assert.equal(db.persistCreatedSession(claimedId, { sessionId: "created", path: "test.jsonl", cwd: stateDir, startedAt: new Date().toISOString(), source: "appServer", firstUserText: "test" }), true);
    assert.equal(db.getTask(claimedId)?.sessionId, "created");
    db.updateTask(claimedId, "completed");
    db.attachTaskRunCard(claimedId, "even-later-card");
    assert.equal(db.getTask(claimedId)?.status, "completed");
  } finally { db.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test("service shutdown preserves unstarted follow-ups while interrupting active work", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bridge-stop-queue-"));
  const config: BridgeConfig = { appId: "app", appSecret: "secret", bindToken: "token", allowedRoot: stateDir, codexHome: stateDir, codexBin: "/bin/false", stateDir, scanIntervalMs: 1000, activeSessionQuietMs: 1 };
  let db = new BridgeDatabase(stateDir);
  try {
    for (const status of ["running", "pending", "thread_created"] as const) {
      db.enqueueTask({ id: status, kind: "resume", sessionId: "s", cwd: stateDir, prompt: "test", imageKeys: [], sourceMessageId: status, chatId: "chat", rootMessageId: "root", model: "gpt-6-astra", reasoningEffort: "high", status, runCardMessageId: null, expectedSessionId: "s", syncStatus: "none", lastSyncOffset: null, turnId: status === "running" ? "turn" : null });
    }
    const service = new SyncService(config, db, {} as FeishuPort, new CodexCliProbe("/bin/false", stateDir));
    await service.stop();
    db.close(); db = new BridgeDatabase(stateDir);
    assert.equal(db.getTask("running")?.status, "interrupted");
    assert.equal(db.getTask("pending")?.status, "pending");
    assert.equal(db.getTask("thread_created")?.status, "thread_created");
    assert.notEqual(db.getSetting("sync.paused"), "1");
  } finally { db.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test("SDK diagnostic output omits request bodies and redacts credentials in strings", () => {
  const error = Object.assign(new Error("failed credential-value Bearer opaque-token"), {
    config: { data: '{"app_secret":"never-print-this"}', headers: { Authorization: "also-private" } },
    response: { status: 400, data: { code: 230031, msg: "expired", access_token: "private-token" } },
  });
  const result = safeDiagnostic(["app_secret=literal-secret", error], ["credential-value"]);
  for (const secret of ["literal-secret", "credential-value", "opaque-token", "never-print-this", "also-private", "private-token"]) assert.ok(!result.includes(secret));
  assert.ok(result.includes("230031"));
  assert.ok(result.includes("400"));
});

test("expired message detection never suppresses unrelated HTTP 400 or transient failures", () => {
  assert.equal(isExpiredFeishuMessage({ response: { data: { code: 230031 } } }), true);
  assert.equal(isExpiredFeishuMessage(new Error("Feishu API 230031: expired")), true);
  assert.equal(isExpiredFeishuMessage({ response: { status: 400, data: { code: 230001 } } }), false);
  assert.equal(isExpiredFeishuMessage(new Error("timeout")), false);
});

test("expired root suppression persists across restart and a replacement root is retried", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bridge-expired-"));
  const config: BridgeConfig = { appId: "app", appSecret: "secret", bindToken: "token", allowedRoot: stateDir, codexHome: stateDir, codexBin: "/bin/false", stateDir, scanIntervalMs: 1000, activeSessionQuietMs: 1 };
  let calls = 0;
  const feishu = { updateCard: async () => { calls++; throw { response: { data: { code: 230031 } } }; } } as unknown as FeishuPort;
  let db = new BridgeDatabase(stateDir);
  try {
    db.upsertSession({ sessionId: "session", path: "log", cwd: stateDir, startedAt: "2026-01-01", source: "cli", firstUserText: "hello" });
    db.setSessionRoot("session", "old-root");
    const restore = async () => {
      const service = new SyncService(config, db, feishu, new CodexCliProbe("/bin/false", stateDir));
      await (service as unknown as { restoreRootCards(): Promise<void> }).restoreRootCards();
    };
    await restore(); assert.equal(calls, 1);
    db.close(); db = new BridgeDatabase(stateDir);
    await restore(); assert.equal(calls, 1);
    db.setSessionRoot("session", "new-root");
    await restore(); assert.equal(calls, 2);
  } finally { db.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test("new-session preference uses live capabilities and leaves catalog defaults intact", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bridge-model-default-"));
  const config: BridgeConfig = { appId: "app", appSecret: "secret", bindToken: "token", allowedRoot: stateDir, codexHome: stateDir, codexBin: "/bin/false", stateDir, scanIntervalMs: 1000, activeSessionQuietMs: 1,
    defaultNewModel: "gpt-6-astra", defaultNewReasoningEffort: "high" };
  const db = new BridgeDatabase(stateDir);
  try {
    const service = new SyncService(config, db, {} as FeishuPort, new CodexCliProbe("/bin/false", stateDir));
    const runtime = service as unknown as { models: ModelCapability[]; newModelDefaults(): object };
    runtime.models = [{ slug: "gpt-6-astra", displayName: "GPT-6 Astra", description: "", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "max", "ultra"] }];
    assert.deepEqual(runtime.newModelDefaults(), { model: "gpt-6-astra", reasoningEffort: "high" });
    assert.equal(runtime.models[0]!.defaultReasoningEffort, "medium");
    config.defaultNewReasoningEffort = "none";
    assert.deepEqual(runtime.newModelDefaults(), {});
    config.defaultNewModel = "unavailable";
    assert.deepEqual(runtime.newModelDefaults(), {});
  } finally { db.close(); await rm(stateDir, { recursive: true, force: true }); }
});
