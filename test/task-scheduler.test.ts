import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeDatabase } from "../src/db.js";
import { TaskScheduler } from "../src/task-scheduler.js";
import type { QueuedTask } from "../src/types.js";

test("TaskScheduler claims FIFO tasks and owns worker serialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-scheduler-"));
  try {
    const db = new BridgeDatabase(dir);
    const base: Omit<QueuedTask, "id" | "sourceMessageId"> = {
      kind: "resume", sessionId: "s1", cwd: "/work", prompt: "p", imageKeys: [], chatId: "c1",
      rootMessageId: "r1", model: null, reasoningEffort: null, status: "pending", runCardMessageId: null,
      expectedSessionId: "s1", syncStatus: "none", lastSyncOffset: null,
    };
    const order: string[] = [];
    const scheduler = new TaskScheduler({
      db,
      executor: { execute: async (task) => { order.push(task.id); } },
      isPaused: () => false,
      hasActiveTurn: () => false,
      hasLocalActiveSession: async () => false,
      onError: (_operation, _task, error) => { throw error; },
    });
    assert.equal(db.enqueueTask({ ...base, id: "a", sourceMessageId: "ma" }), true);
    assert.equal(db.enqueueTask({ ...base, id: "b", sourceMessageId: "mb" }), true);
    await scheduler.drain("s1");
    assert.deepEqual(order, ["a", "b"]);
    assert.equal(db.getTask("a")?.status, "running");
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
