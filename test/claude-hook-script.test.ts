import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { bridgeHookCommand } from "../src/claude/hooks-config.js";

const hookScript = resolve("scripts/claude-hook.mjs");
const sessionId = "0f9e8d7c-6b5a-4433-8211-00aa11bb22cc";
const KEYS = ["version", "sessionId", "event", "state", "notificationType", "message", "transcriptPath", "cwd", "source", "reason", "pid", "pidStartTime", "at"];

/** The test may itself run inside a bridge-started session; the hook must not see that marker. */
function hookEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (!("FEISHU_CLAUDE_BRIDGE" in extra)) delete env.FEISHU_CLAUDE_BRIDGE;
  return env;
}

function runHook(stateDir: string, input: string, options: { env?: Record<string, string>; args?: string[] } = {}): void {
  const run = spawnSync(process.execPath, [hookScript, ...(options.args ?? ["--state-dir", stateDir])], {
    input, env: hookEnv(options.env), encoding: "utf8", timeout: 10_000,
  });
  assert.equal(run.status, 0, `hook exit status for ${input.slice(0, 80)}`);
  assert.equal(run.stdout, "", "the hook never writes stdout (it would become Claude context)");
  assert.equal(run.stderr, "", "the hook never writes stderr");
}

function event(fields: Record<string, unknown>): string {
  return JSON.stringify({ session_id: sessionId, transcript_path: `/home/alice/.claude/projects/-home-alice-app/${sessionId}.jsonl`, cwd: "/home/alice/app", ...fields });
}

async function presence(stateDir: string, id = sessionId): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(join(stateDir, "presence", `${id}.json`), "utf8")) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-claude-hook-"));
  try { await run(join(dir, "state")); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("hook maps Claude Code events to presence states with the documented record fields", async () => {
  await withStateDir(async (stateDir) => {
    const cases: Array<[Record<string, unknown>, string | null, Record<string, unknown>]> = [
      [{ hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5" }, "idle", { source: "startup" }],
      [{ hook_event_name: "UserPromptSubmit", prompt: "hello" }, "running", {}],
      [{ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done" }, "idle", {}],
      [{ hook_event_name: "StopFailure", error: "rate_limit" }, "idle", {}],
      [{ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" }, "waiting",
        { notificationType: "permission_prompt", message: "Claude needs your permission" }],
      [{ hook_event_name: "Notification", notification_type: "elicitation_dialog", message: "MCP form" }, "waiting", { notificationType: "elicitation_dialog", message: "MCP form" }],
      [{ hook_event_name: "Notification", notification_type: "elicitation_url_dialog", message: "open URL" }, "waiting", { notificationType: "elicitation_url_dialog", message: "open URL" }],
      [{ hook_event_name: "Notification", notification_type: "agent_needs_input", message: "agent" }, "waiting", { notificationType: "agent_needs_input", message: "agent" }],
      [{ hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting for input" }, "idle", { notificationType: "idle_prompt", message: "waiting for input" }],
      [{ hook_event_name: "Notification", notification_type: "elicitation_complete", message: "done" }, "running", { notificationType: "elicitation_complete", message: "done" }],
      [{ hook_event_name: "Notification", notification_type: "elicitation_response", message: "answered" }, "running", { notificationType: "elicitation_response", message: "answered" }],
      [{ hook_event_name: "SessionEnd", reason: "prompt_input_exit" }, "closed", { reason: "prompt_input_exit" }],
    ];
    for (const [fields, state, expected] of cases) {
      const before = Date.now();
      runHook(stateDir, event(fields));
      const record = await presence(stateDir);
      assert.ok(record, `${JSON.stringify(fields)} writes a record`);
      assert.deepEqual(Object.keys(record), KEYS);
      assert.deepEqual({ ...record, pid: null, pidStartTime: null, at: null }, {
        version: 1, sessionId, event: fields.hook_event_name, state, notificationType: null, message: null,
        transcriptPath: `/home/alice/.claude/projects/-home-alice-app/${sessionId}.jsonl`, cwd: "/home/alice/app",
        source: null, reason: null, ...expected, pid: null, pidStartTime: null, at: null,
      });
      assert.ok(typeof record.at === "number" && record.at >= before && record.at <= Date.now());
      assert.ok(record.pid === null || Number.isSafeInteger(record.pid));
      assert.ok(record.pidStartTime === null || /^\d+$/.test(String(record.pidStartTime)));
    }
    const info = await stat(join(stateDir, "presence", `${sessionId}.json`));
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal((await stat(join(stateDir, "presence"))).mode & 0o777, 0o700);
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(stateDir, "presence")), [`${sessionId}.json`], "no temporary files are left behind");
  });
});

test("hook truncates notification messages and ignores fields of other events", async () => {
  await withStateDir(async (stateDir) => {
    runHook(stateDir, event({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "权限😀".repeat(200) }));
    const message = (await presence(stateDir))?.message;
    assert.equal(typeof message, "string");
    assert.equal(Array.from(message as string).length, 300);
    assert.ok((message as string).startsWith("权限😀"));
    assert.doesNotMatch(message as string, /[\uD800-\uDBFF]$/, "no broken surrogate pair at the end");
    runHook(stateDir, event({ hook_event_name: "Stop", message: "not a notification", notification_type: "permission_prompt" }));
    assert.deepEqual([(await presence(stateDir))?.message, (await presence(stateDir))?.notificationType], [null, null]);
  });
});

test("hook writes nothing for unknown events, unknown notifications, bridge sessions and bad input", async () => {
  await withStateDir(async (stateDir) => {
    const ignored = [
      event({ hook_event_name: "Notification", notification_type: "auth_success", message: "ok" }),
      event({ hook_event_name: "Notification", message: "no type" }),
      event({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
      event({ hook_event_name: "SubagentStop" }),
      JSON.stringify({ session_id: "../../../etc/passwd", hook_event_name: "Stop" }),
      JSON.stringify({ session_id: "short", hook_event_name: "Stop" }),
      JSON.stringify({ session_id: "a".repeat(81), hook_event_name: "Stop" }),
      JSON.stringify({ session_id: "abcdefgh/ijkl", hook_event_name: "Stop" }),
      JSON.stringify({ session_id: 1234567890, hook_event_name: "Stop" }),
      JSON.stringify({ hook_event_name: "Stop" }),
      JSON.stringify([{ session_id: sessionId, hook_event_name: "Stop" }]),
      "{not json",
      "",
    ];
    for (const input of ignored) runHook(stateDir, input);
    runHook(stateDir, event({ hook_event_name: "UserPromptSubmit" }), { env: { FEISHU_CLAUDE_BRIDGE: "1" } });
    runHook(stateDir, event({ hook_event_name: "UserPromptSubmit" }), { args: ["--state-dir", "relative/state"] });
    runHook(stateDir, event({ hook_event_name: "UserPromptSubmit" }), { args: [] });
    await assert.rejects(stat(stateDir), { code: "ENOENT" }, "nothing was created");
    await assert.rejects(stat(resolve("relative")), { code: "ENOENT" });
    runHook(stateDir, event({ hook_event_name: "UserPromptSubmit" }), { env: { FEISHU_CLAUDE_BRIDGE: "0" } });
    assert.equal((await presence(stateDir))?.state, "running", "only the exact value 1 marks a bridge session");
  });
});

test("hook exits quietly when stdin is never closed", async () => {
  await withStateDir(async (stateDir) => {
    const started = Date.now();
    const child = spawn(process.execPath, [hookScript, "--state-dir", stateDir], { env: hookEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.stdin.write(event({ hook_event_name: "UserPromptSubmit" }));
    const code = await new Promise<number | null>((done) => child.on("close", done));
    assert.equal(code, 0);
    assert.equal(output, "");
    assert.ok(Date.now() - started < 8_000);
    assert.equal(await presence(stateDir), null);
  });
});

test("hook identifies the Claude Code ancestor through sh -c and a parent whose name has spaces and parentheses", { skip: process.platform !== "linux" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-claude-hook-proc-"));
  try {
    // A process started through a link named "claude" has that name as argv[0]. Its comm is "claude"
    // on Node 22 but the main thread's name ("MainThread") on Node 24, so the hook must not need it.
    const fakeClaude = join(dir, "claude");
    const oddParent = join(dir, "we ird) (x");
    await symlink(process.execPath, fakeClaude);
    await symlink(process.execPath, oddParent);
    const stateDir = join(dir, "state");
    const command = bridgeHookCommand(process.execPath, hookScript, stateDir);
    const runHookViaShell = `const { spawnSync } = require("node:child_process");
      const run = spawnSync("/bin/sh", ["-c", process.env.HOOK_COMMAND], { input: process.env.HOOK_INPUT, encoding: "utf8" });
      process.stdout.write(JSON.stringify({ status: run.status, output: run.stdout + run.stderr }));`;
    const claudeProcess = `const { spawnSync } = require("node:child_process");
      const { readFileSync } = require("node:fs");
      const stat = readFileSync("/proc/self/stat", "utf8");
      const startTime = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\\s+/)[19];
      const parent = spawnSync(process.env.ODD_PARENT, ["-e", process.env.PARENT_SCRIPT], { encoding: "utf8" });
      const argv0 = readFileSync("/proc/self/cmdline", "utf8").split("\\0", 1)[0];
      process.stdout.write(JSON.stringify({ pid: process.pid, startTime, argv0, hook: JSON.parse(parent.stdout) }));`;
    const run = spawnSync(fakeClaude, ["-e", claudeProcess], {
      encoding: "utf8",
      timeout: 15_000,
      env: hookEnv({ HOOK_COMMAND: command, HOOK_INPUT: event({ hook_event_name: "UserPromptSubmit" }), ODD_PARENT: oddParent, PARENT_SCRIPT: runHookViaShell }),
    });
    assert.equal(run.status, 0, run.stderr);
    const observed = JSON.parse(run.stdout) as { pid: number; startTime: string; argv0: string; hook: { status: number; output: string } };
    assert.equal(observed.argv0, fakeClaude);
    assert.deepEqual(observed.hook, { status: 0, output: "" });
    const record = await presence(stateDir);
    assert.equal(record?.state, "running");
    assert.equal(record?.pid, observed.pid);
    assert.equal(record?.pidStartTime, observed.startTime);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("compaction does not reset a running session to idle", async () => {
  await withStateDir(async (stateDir) => {
    runHook(stateDir, event({ hook_event_name: "UserPromptSubmit", prompt: "long task" }));
    runHook(stateDir, event({ hook_event_name: "SessionStart", source: "compact" }));
    assert.equal((await presence(stateDir))?.state, "running");
    runHook(stateDir, event({ hook_event_name: "SessionStart", source: "resume" }));
    assert.equal((await presence(stateDir))?.state, "idle");
  });
});
