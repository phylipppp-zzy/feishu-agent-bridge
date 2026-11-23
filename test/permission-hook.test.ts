import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { PermissionRequestHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  createPermissionHookFrame, createPermissionHookServer, permissionHookOutput, requestPermissionHook,
  permissionHookSocketPath, recoverStalePermissionHookSocket, type PermissionApprovalHandler, type PermissionHookClock, type PermissionHookReply,
} from "../src/claude/permission-hook.js";

const input = (command = "printf harmless"): PermissionRequestHookInput => ({
  hook_event_name: "PermissionRequest", session_id: "session-test", transcript_path: "/tmp/fake-transcript.jsonl",
  cwd: "/tmp/fake-project", tool_name: "Bash", tool_input: { command }, permission_suggestions: [],
});

async function withServer(
  onRequest: PermissionApprovalHandler,
  work: (stateDir: string, socketPath: string, service: ReturnType<typeof createPermissionHookServer>) => Promise<void>,
  options: { timeoutMs?: number; clock?: PermissionHookClock } = {},
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "permission-hook-"));
  const service = createPermissionHookServer({ stateDir, onRequest, ...options });
  try { await service.start(); await work(stateDir, service.socketPath, service); }
  finally { await service.stop(); await rm(stateDir, { recursive: true, force: true }); }
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
}

async function bindUnixFixture(socketPath: string): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  await chmod(socketPath, 0o600);
  return server;
}

async function closeUnixFixture(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
}

async function createCrashedUnixSocket(socketPath: string): Promise<void> {
  const fixture = spawn(process.execPath, ["-e", "const net=require('node:net');const fs=require('node:fs');const s=net.createServer();s.listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600);process.stdout.write('ready\\n')});setInterval(()=>{},1000)", socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    let output = "";
    const timer = setTimeout(() => rejectReady(new Error("socket fixture did not start")), 2_000);
    fixture.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("ready")) { clearTimeout(timer); resolveReady(); }
    });
    fixture.once("error", rejectReady);
    fixture.stderr.resume();
  });
  fixture.kill("SIGKILL");
  await new Promise<void>((resolveExit) => fixture.once("close", () => resolveExit()));
  assert.equal((await lstat(socketPath)).isSocket(), true);
}

test("server secures directory/socket to current uid and mode 0700/0600", async () => {
  await withServer(async (request) => ({ ...request, decision: { behavior: "deny", message: "no" } }), async (stateDir, socketPath) => {
    const directory = await lstat(stateDir);
    const socket = await lstat(socketPath);
    assert.equal(directory.uid, process.getuid?.());
    assert.equal(directory.mode & 0o777, 0o700);
    assert.equal(socket.uid, process.getuid?.());
    assert.equal(socket.mode & 0o777, 0o600);
    assert.equal(socket.isSocket(), true);
  });
});

test("startup reclaims only an owned stale socket, then stop removes only its own socket", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "permission-hook-stale-"));
  const hookDir = join(stateDir, "permission-hook");
  await mkdir(hookDir, { mode: 0o700 });
  const socketPath = permissionHookSocketPath(hookDir);
  await createCrashedUnixSocket(socketPath);
  const service = createPermissionHookServer({ stateDir: hookDir, onRequest: async (request) => ({ ...request, decision: { behavior: "deny" } }) });
  try {
    await service.start();
    assert.equal((await lstat(socketPath)).isSocket(), true);
    await service.stop();
    await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  } finally { await service.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test("active owned socket is refused and is never unlinked by failed service cleanup", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "permission-hook-active-"));
  const hookDir = join(stateDir, "permission-hook");
  await mkdir(hookDir, { mode: 0o700 });
  const socketPath = permissionHookSocketPath(hookDir);
  const activeServer = await bindUnixFixture(socketPath);
  const service = createPermissionHookServer({ stateDir: hookDir, onRequest: async (request) => ({ ...request, decision: { behavior: "deny" } }) });
  try {
    await assert.rejects(service.start(), /already active/);
    await service.stop();
    assert.equal((await lstat(socketPath)).isSocket(), true);
  } finally {
    await service.stop();
    await closeUnixFixture(activeServer);
    await unlink(socketPath).catch(() => undefined);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("non-socket, symlink, and permissive socket paths are refused without deletion", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "permission-hook-untrusted-"));
  const filePath = join(stateDir, "file");
  const linkPath = join(stateDir, "link");
  const permissivePath = join(stateDir, "permissive.sock");
  const { writeFile, symlink } = await import("node:fs/promises");
  try {
    await writeFile(filePath, "keep");
    await assert.rejects(recoverStalePermissionHookSocket(filePath), /untrusted/);
    assert.equal((await lstat(filePath)).isFile(), true);
    await symlink(filePath, linkPath);
    await assert.rejects(recoverStalePermissionHookSocket(linkPath), /untrusted/);
    assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
    await createCrashedUnixSocket(permissivePath);
    await chmod(permissivePath, 0o660);
    await assert.rejects(recoverStalePermissionHookSocket(permissivePath), /permissions are unsafe/);
    assert.equal((await lstat(permissivePath)).isSocket(), true);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("socket path identity is rechecked before unlink and a replaced inode is preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "permission-hook-replaced-"));
  const target = join(dir, "target.sock");
  const replacement = join(dir, "replacement.sock");
  await createCrashedUnixSocket(target);
  const newServer = await bindUnixFixture(replacement);
  try {
    await assert.rejects(recoverStalePermissionHookSocket(target, async () => {
      await unlink(target);
      await rename(replacement, target);
      return "stale";
    }), /changed during stale-path check/);
    assert.equal((await lstat(target)).isSocket(), true);
  } finally {
    await closeUnixFixture(newServer);
    await unlink(target).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("request identity binds exact SDK input and handler approval returns a standard allow decision", async () => {
  await withServer(async (request) => ({
    ...request,
    decision: { behavior: "allow", updatedInput: { command: "approved exact input" } },
  }), async (_stateDir, socketPath) => {
    const result = await requestPermissionHook(socketPath, input());
    assert.equal(result.decision.behavior, "allow");
    assert.deepEqual(result.decision, { behavior: "allow", updatedInput: { command: "approved exact input" } });
    assert.equal(result.input.tool_input && (result.input.tool_input as { command: string }).command, "printf harmless");
  });
});

test("deny is returned as a permission decision", async () => {
  await withServer(async (request) => ({ ...request, decision: { behavior: "deny", message: "user denied" } }), async (_stateDir, socketPath) => {
    const result = await requestPermissionHook(socketPath, input());
    assert.deepEqual(result.decision, { behavior: "deny", message: "user denied" });
  });
});

test("SDK hook output wrapper uses the documented PermissionRequest shape and preserves interrupt", () => {
  assert.deepEqual(permissionHookOutput({ behavior: "deny", message: "no", interrupt: true }), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no", interrupt: true } },
  });
});

test("server timeout uses a fake clock at the ten-minute boundary and denies", async () => {
  const callbacks: Array<{ callback: () => void; delayMs: number }> = [];
  const clock: PermissionHookClock = {
    setTimeout(callback, delayMs) { callbacks.push({ callback, delayMs }); return callback; },
    clearTimeout() {},
  };
  await withServer(() => new Promise<PermissionHookReply>(() => undefined), async (_stateDir, socketPath) => {
    const resultPromise = requestPermissionHook(socketPath, input(), { timeoutMs: 600_000 });
    await until(() => callbacks.length > 0);
    assert.equal(callbacks[0]!.delayMs, 600_000);
    callbacks[0]!.callback();
    const result = await resultPromise;
    assert.equal(result.decision.behavior, "deny");
    assert.match(result.decision.behavior === "deny" ? result.decision.message ?? "" : "", /超时/);
  }, { timeoutMs: 600_000, clock });
});

test("wrong request id or input digest from handler is rejected", async () => {
  await withServer(async (request) => ({ ...request, requestId: "00000000-0000-4000-8000-000000000001", inputDigest: "0".repeat(64), decision: { behavior: "allow" } }),
    async (_stateDir, socketPath) => {
      const result = await requestPermissionHook(socketPath, input());
      assert.equal(result.decision.behavior, "deny");
      assert.match(result.decision.behavior === "deny" ? result.decision.message ?? "" : "", /不匹配/);
    });
});

test("duplicate request id is rejected as replay", async () => {
  await withServer(async (request) => ({ ...request, decision: { behavior: "allow" } }), async (_stateDir, socketPath) => {
    const requestId = "00000000-0000-4000-8000-000000000001";
    assert.equal((await requestPermissionHook(socketPath, input(), { requestId })).decision.behavior, "allow");
    const replay = await requestPermissionHook(socketPath, input(), { requestId });
    assert.equal(replay.decision.behavior, "deny");
    assert.match(replay.decision.behavior === "deny" ? replay.decision.message ?? "" : "", /重复/);
  });
});

test("stopping a service while a request is pending fails closed", async () => {
  let received = false;
  const stateDir = await mkdtemp(join(tmpdir(), "permission-hook-stop-"));
  const service = createPermissionHookServer({ stateDir, onRequest: async () => { received = true; return new Promise<PermissionHookReply>(() => undefined); } });
  try {
    await service.start();
    const resultPromise = requestPermissionHook(service.socketPath, input());
    await until(() => received);
    await service.stop();
    const result = await resultPromise;
    assert.equal(result.decision.behavior, "deny");
  } finally { await service.stop(); await rm(stateDir, { recursive: true, force: true }); }
});

test("the hook CLI emits standard deny when the service is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "permission-hook-cli-"));
  try {
    const output = await runCli(join(dir, "missing.sock"), input());
    assert.deepEqual(output, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "审批服务不可用，已拒绝。" } } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("hook CLI sends command-shaped input as data and never evaluates it", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "permission-hook-no-eval-"));
  const marker = join(markerDir, "executed");
  const command = `touch ${marker}`;
  try {
    await withServer(async (request) => {
      assert.equal((request.input.tool_input as { command: string }).command, command);
      return { ...request, decision: { behavior: "allow" } };
    }, async (_stateDir, socketPath) => {
      const output = await runCli(socketPath, input(command));
      assert.deepEqual(output, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    });
    await assert.rejects(lstat(marker), { code: "ENOENT" });
  } finally { await rm(markerDir, { recursive: true, force: true }); }
});

test("hook CLI preserves interrupt on a deny response", async () => {
  await withServer(async (request) => ({ ...request, decision: { behavior: "deny", message: "stop this turn", interrupt: true } }), async (_stateDir, socketPath) => {
    assert.deepEqual(await runCli(socketPath, input()), {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "stop this turn", interrupt: true } },
    });
  });
});

test("hook CLI rejects malformed allow response fields", async () => {
  await withServer(async (request) => ({ ...request, decision: { behavior: "allow", updatedInput: "not-an-object" } as unknown as PermissionHookReply["decision"] }), async (_stateDir, socketPath) => {
    const output = await runCli(socketPath, input()) as { hookSpecificOutput: { decision: { behavior: string; message?: string } } };
    assert.equal(output.hookSpecificOutput.decision.behavior, "deny");
    assert.match(output.hookSpecificOutput.decision.message ?? "", /不匹配|格式无效/);
  });
});

test("frame digest changes when the exact permission input changes", () => {
  const first = createPermissionHookFrame(input("one"), "00000000-0000-4000-8000-000000000001");
  const second = createPermissionHookFrame(input("two"), "00000000-0000-4000-8000-000000000002");
  assert.notEqual(first.inputDigest, second.inputDigest);
});

async function runCli(socketPath: string, payload: PermissionRequestHookInput): Promise<unknown> {
  const script = resolve("scripts/claude-permission-hook.mjs");
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(process.execPath, [script, "--socket", socketPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectOutput);
    child.once("close", (code) => {
      if (code !== 0) { rejectOutput(new Error(`hook exited ${code}: ${stderr}`)); return; }
      try { resolveOutput(JSON.parse(stdout)); } catch { rejectOutput(new Error(`invalid hook stdout: ${stdout} ${stderr}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
