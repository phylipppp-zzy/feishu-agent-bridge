import assert from "node:assert/strict";
import test from "node:test";
import { idleDelayFor, decideRunnerIdle, RUNNER_IDLE_MS, RUNNER_UNKNOWN_IDLE_MS } from "../src/claude/runner-idle-policy.js";
import { SessionRunner, type RunnerHandlers, type RunnerOptions } from "../src/claude/runner.js";
import { fakeQueries } from "./claude-fake-query.js";

const options: RunnerOptions = {
  sessionId: "session-idle-test", mode: "resume", cwd: "/tmp/project", claudeBin: "/unused/claude",
  permissionMode: "default", model: null, effort: null,
};

function handlers(onActivityChange: () => void = () => undefined): RunnerHandlers {
  return {
    onPrompt: () => undefined,
    onLiveText: () => undefined,
    onTurnEnd: () => undefined,
    canUseTool: async () => ({ behavior: "deny", message: "test" }),
    onClosed: () => undefined,
    onActivityChange,
  };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("runner state did not settle");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("fake clock closes known idle at 10 minutes and unknown state only at 2 hours", () => {
  const idleSinceMs = 50_000;
  assert.equal(idleDelayFor("idle", false), RUNNER_IDLE_MS);
  assert.equal(idleDelayFor("unknown", false), RUNNER_UNKNOWN_IDLE_MS);
  assert.equal(idleDelayFor("busy", false), null);
  assert.equal(idleDelayFor("idle", true), null);
  assert.deepEqual(decideRunnerIdle({ turnBusy: false, backgroundWork: "idle", idleSinceMs }, idleSinceMs + RUNNER_IDLE_MS - 1), {
    action: "wait", reason: "known-idle", deadlineMs: idleSinceMs + RUNNER_IDLE_MS, delayMs: 1,
  });
  assert.deepEqual(decideRunnerIdle({ turnBusy: false, backgroundWork: "idle", idleSinceMs }, idleSinceMs + RUNNER_IDLE_MS), {
    action: "close", reason: "known-idle", deadlineMs: idleSinceMs + RUNNER_IDLE_MS, delayMs: 0,
  });
  assert.deepEqual(decideRunnerIdle({ turnBusy: false, backgroundWork: "unknown", idleSinceMs }, idleSinceMs + RUNNER_UNKNOWN_IDLE_MS - 1), {
    action: "wait", reason: "unknown", deadlineMs: idleSinceMs + RUNNER_UNKNOWN_IDLE_MS, delayMs: 1,
  });
  assert.equal(decideRunnerIdle({ turnBusy: false, backgroundWork: "unknown", idleSinceMs }, idleSinceMs + RUNNER_UNKNOWN_IDLE_MS).action, "close");
  assert.deepEqual(decideRunnerIdle({ turnBusy: false, backgroundWork: "busy", idleSinceMs }, idleSinceMs + RUNNER_UNKNOWN_IDLE_MS), {
    action: "keep-open", reason: "background-busy", deadlineMs: null,
  });
});

test("runner exposes background activity separately and still accepts another user message", async () => {
  const { factory, queries } = fakeQueries();
  let activityChanges = 0;
  const runner = new SessionRunner(options, handlers(() => { activityChanges += 1; }), factory);
  runner.start();
  const query = queries[0]!;
  assert.equal(runner.busy, false);
  assert.equal(runner.backgroundWork, "unknown");
  assert.equal(runner.idleDelayMs, RUNNER_UNKNOWN_IDLE_MS);

  const first = runner.send("启动任务", [], "next", "prompt-1");
  await query.nextMessage(1);
  query.result([first]);
  await until(() => !runner.busy);

  query.emit({ type: "system", subtype: "background_tasks_changed", uuid: "event-1", session_id: runner.sessionId,
    tasks: [{ task_id: "task-A", task_type: "local_agent", description: "working" }, { task_id: "watcher", task_type: "watch", description: "ambient", ambient: true }] });
  await until(() => runner.backgroundWork === "busy");
  assert.equal(runner.backgroundWork, "busy");
  assert.equal(runner.busy, false, "busy retains its main-turn meaning for the runtime's message/interrupt gates");
  assert.equal(runner.idleDelayMs, null);
  const second = runner.send("继续问 Claude", [], "next", "prompt-2");
  assert.equal((await query.nextMessage(2)).uuid, second);
  assert.equal(runner.busy, true);
  query.result([second]);
  await until(() => !runner.busy);
  assert.equal(runner.backgroundWork, "busy");

  // The level signal uses REPLACE semantics. The ambient-only snapshot means no active user work.
  query.emit({ type: "system", subtype: "background_tasks_changed", uuid: "event-2", session_id: runner.sessionId,
    tasks: [{ task_id: "watcher", task_type: "watch", description: "ambient", ambient: true }] });
  await until(() => runner.backgroundWork === "idle");
  assert.equal(runner.backgroundWork, "idle");
  assert.equal(runner.idleDelayMs, RUNNER_IDLE_MS);
  query.emit({ type: "system", subtype: "task_updated", task_id: "watcher", patch: { status: "running", is_backgrounded: true },
    uuid: "event-3", session_id: runner.sessionId });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runner.backgroundWork, "idle", "known ambient task must not become activity from an update patch");
  query.emit({ type: "system", subtype: "task_started", task_id: "terminal-check", is_backgrounded: true, ambient: false,
    uuid: "event-4", session_id: runner.sessionId });
  await until(() => runner.backgroundWork === "busy");
  query.emit({ type: "system", subtype: "task_updated", task_id: "terminal-check", patch: { status: "completed", is_backgrounded: true },
    uuid: "event-5", session_id: runner.sessionId });
  await until(() => runner.backgroundWork === "idle");
  assert.equal(activityChanges, 5);
  runner.close();
  await runner.closed(1_000);
});

test("task_started can conservatively hold the runner; without a full snapshot completion stays unknown", async () => {
  const { factory, queries } = fakeQueries();
  const runner = new SessionRunner(options, handlers(), factory);
  runner.start();
  const query = queries[0]!;
  query.emit({ type: "system", subtype: "task_started", task_id: "background-agent", is_backgrounded: true, ambient: false,
    uuid: "event-1", session_id: runner.sessionId });
  await until(() => runner.backgroundWork === "busy");
  assert.equal(runner.backgroundWork, "busy");
  assert.equal(runner.idleDelayMs, null);
  query.emit({ type: "system", subtype: "task_notification", task_id: "background-agent", status: "completed", output_file: "", summary: "done",
    uuid: "event-2", session_id: runner.sessionId });
  await until(() => runner.backgroundWork === "unknown");
  assert.equal(runner.backgroundWork, "unknown", "edge events cannot prove the full task set is empty without the level snapshot");
  assert.equal(runner.idleDelayMs, RUNNER_UNKNOWN_IDLE_MS);
  runner.close();
});
