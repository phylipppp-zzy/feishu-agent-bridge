import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BridgeDatabase } from "../src/db.js";

test("database migrates root link and model columns on an existing sessions table", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-db-"));
  try {
    const old = new DatabaseSync(join(dir, "bridge.sqlite"));
    old.exec(`CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL, started_at TEXT NOT NULL,
      source TEXT NOT NULL, first_user_text TEXT NOT NULL DEFAULT '', root_message_id TEXT, updated_at TEXT NOT NULL
    )`);
    old.close();
    const db = new BridgeDatabase(dir);
    const columns = db.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "root_app_link"));
    assert.ok(columns.some((column) => column.name === "model"));
    assert.ok(columns.some((column) => column.name === "reasoning_effort"));
    assert.ok(columns.some((column) => column.name === "chat_id"));
    assert.ok(columns.some((column) => column.name === "thread_id"));
    assert.ok(columns.some((column) => column.name === "session_card_message_id"));
    assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_status'").get());
    const taskColumns = db.db.prepare("PRAGMA table_info(task_queue)").all() as Array<{ name: string }>;
    assert.ok(taskColumns.some((column) => column.name === "expected_session_id"));
    assert.ok(taskColumns.some((column) => column.name === "sync_status"));
    db.recordFailure("message_link", { sessionId: "s1" }, new Error("unavailable"));
    db.recordFailure("message_link", { sessionId: "s1" }, new Error("unavailable"));
    assert.equal(db.failureCount(), 1);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("persistent task queue claims FIFO work and preserves Codex failures for manual retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-queue-"));
  try {
    const db = new BridgeDatabase(dir);
    const base = { kind: "resume" as const, sessionId: "s1", cwd: "/home/tester", prompt: "p", imageKeys: [], chatId: "c1", rootMessageId: "r1", model: null, reasoningEffort: null, status: "pending" as const, runCardMessageId: null, expectedSessionId: "s1", syncStatus: "none" as const, lastSyncOffset: null };
    assert.equal(db.enqueueTask({ ...base, id: "a", sourceMessageId: "m1" }), true);
    assert.equal(db.enqueueTask({ ...base, id: "b", sourceMessageId: "m2" }), true);
    assert.equal(db.claimNextTask("s1")?.id, "a");
    db.updateTask("a", "completed");
    assert.equal(db.claimNextTask("s1")?.id, "b");
    db.recordFailure("codex_resume", { sessionId: "s1" }, new Error("failed"));
    db.recordFailure("sync_all", {}, new Error("temporary"));
    db.resolveInfrastructureFailures();
    assert.equal(db.failureCount(), 1);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("remote request and root grant state is scoped, atomic, and expires", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-remote-db-"));
  try {
    const db = new BridgeDatabase(dir);
    db.enqueueTask({ id: "root-task", kind: "resume", sessionId: "s1", cwd: "/work", prompt: "p", imageKeys: [], sourceMessageId: "root-message", chatId: "c1", rootMessageId: "r1", model: null, reasoningEffort: null, status: "awaiting_root_consent", runCardMessageId: null, expectedSessionId: "s1", syncStatus: "none", lastSyncOffset: null });
    db.createTaskRootGrant({ nonce: "root-nonce", taskId: "root-task", sessionId: "s1", canonicalCwd: "/work", openId: "u1", chatId: "c1", epoch: 7, expiresAt: Date.now() + 60_000 });
    assert.equal(db.approveTaskRootGrant("root-nonce", "u2", "c1", 7), null);
    assert.equal(db.approveTaskRootGrant("root-nonce", "u1", "c1", 7)?.status, "approved");
    assert.equal(db.consumeTaskRootGrant("root-task", "s1", "/work", 7), true);
    assert.equal(db.consumeTaskRootGrant("root-task", "s1", "/work", 7), false);
    db.saveServerRequest({ nonce: "n1", rpcId: 42, epoch: 7, type: "command_approval", sessionId: "s1", turnId: "t1", itemId: "i1", openId: "u1", chatId: "c1", rootMessageId: "r1", cardMessageId: null, payload: { command: "pwd" }, status: "pending", expiresAt: Date.now() + 60_000 });
    assert.equal(db.claimServerRequest("n1", "u2", "c1", 7), null);
    assert.equal(db.claimServerRequest("n1", "u1", "c1", 7)?.status, "submitting");
    assert.equal(db.claimServerRequest("n1", "u1", "c1", 7), null);
    db.saveTurn({ sessionId: "s1", turnId: "t1", epoch: 7, mode: "plan", state: "running", text: "", plan: "plan", rootMessageId: "r1" });
    assert.equal(db.activeTurn("s1")?.plan, "plan");
    db.expireTaskRootGrants(8);
    assert.equal(db.getTaskRootGrant("root-nonce")?.status, "consumed");
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("task transitions are terminal and session cancellation is atomic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-machine-"));
  try {
    const db = new BridgeDatabase(dir);
    const base = { kind: "resume" as const, sessionId: "s1", cwd: "/work", prompt: "p", imageKeys: [], chatId: "c1", rootMessageId: "r1", model: null, reasoningEffort: null, runCardMessageId: null, expectedSessionId: "s1", syncStatus: "none" as const, lastSyncOffset: null };
    db.enqueueTask({ ...base, id: "one", sourceMessageId: "one-message", status: "pending" });
    db.enqueueTask({ ...base, id: "two", sourceMessageId: "two-message", status: "pending" });
    assert.equal(db.transitionTask("one", "running"), true);
    assert.equal(db.transitionTask("one", "completed"), true);
    assert.equal(db.transitionTask("one", "running"), false);
    assert.equal(db.getTask("one")?.status, "completed");
    const cancelled = db.cancelTasks("r1", "s1", "test cancellation");
    assert.equal(cancelled.length, 1);
    assert.equal(db.getTask("two")?.status, "cancelled");
    assert.equal(db.taskStateCounts().completed, 1);
    assert.equal(db.taskStateCounts().cancelled, 1);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("turn persistence records hashes and stores a bounded review payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-turn-audit-"));
  try {
    const db = new BridgeDatabase(dir);
    db.saveTurn({ sessionId: "s1", turnId: "t1", epoch: 1, mode: "default", state: "completed", text: "answer", plan: "", rootMessageId: "r1", startedAtMs: 10, endedAtMs: 20, inputHash: "input", finalOutputHash: "output" });
    assert.equal(db.getTurn("t1")?.finalOutputHash, "output");
    db.saveTurnItem("t1", "i1", "commandExecution", "completed", { command: "pwd", aggregatedOutput: "x".repeat(3_000), password: "do-not-store" });
    const payload = db.listTurnItems("t1")[0]?.payload ?? {};
    assert.equal(typeof payload.command, "string");
    assert.equal(typeof payload.password, "undefined");
    assert.equal((payload.aggregatedOutput as string).length, 2_000);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("inbound events deduplicate completed work and allow retryable failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-inbound-"));
  try {
    const db = new BridgeDatabase(dir);
    assert.equal(db.claimInboundEvent("event-1"), true);
    assert.equal(db.claimInboundEvent("event-1"), false);
    db.failInboundEvent("event-1", new Error("temporary timeout"), true);
    assert.equal(db.claimInboundEvent("event-1"), true);
    db.completeInboundEvent("event-1");
    assert.equal(db.claimInboundEvent("event-1"), false);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
