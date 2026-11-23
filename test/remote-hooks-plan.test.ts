import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  installRemotePermissionHook, PERMISSION_HOOK_TIMEOUT_SECONDS, removeRemotePermissionHook,
  stopAsyncRewakeSchemaFixture, stopHookSchemaFixture,
} from "../src/claude/remote-hooks-plan.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "scripts", "prepare-claude-remote-hooks.mjs");
const permissionGroup = (command: string, hookScript: string, socketPath: string) => ({
  hooks: [{ type: "command", command, args: [hookScript, "--socket", socketPath], timeout: PERMISSION_HOOK_TIMEOUT_SECONDS }],
});

test("plans a shell-free PermissionRequest hook and preserves unrelated settings", () => {
  const settings = { model: "sonnet", hooks: { Stop: [{ hooks: [{ type: "command", command: "notify done" }] }] } };
  const result = installRemotePermissionHook(settings, {
    nodeBin: "/usr/bin/node",
    hookScript: "/repo path/scripts/claude-permission-hook.mjs",
    socketPath: "/state path/permission.sock;$(not-shell)",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(settings, { model: "sonnet", hooks: { Stop: [{ hooks: [{ type: "command", command: "notify done" }] }] } });
  const merged = result.settings.hooks as Record<string, unknown[]>;
  assert.deepEqual(merged.Stop, [{ hooks: [{ type: "command", command: "notify done" }] }]);
  assert.deepEqual(merged.PermissionRequest, [permissionGroup("/usr/bin/node", "/repo path/scripts/claude-permission-hook.mjs", "/state path/permission.sock;$(not-shell)")]);
  assert.match(result.diff, /PermissionRequest/);
  assert.equal(installRemotePermissionHook(result.settings, {
    nodeBin: "/usr/bin/node", hookScript: "/repo path/scripts/claude-permission-hook.mjs", socketPath: "/state path/permission.sock;$(not-shell)",
  }).changed, false);
});

test("refuses malformed hooks and nonabsolute executable paths", () => {
  assert.throws(() => installRemotePermissionHook({ hooks: [] }, { nodeBin: "/node", hookScript: "/x/claude-permission-hook.mjs", socketPath: "/x.sock" }), /hooks must be an object/);
  assert.throws(() => installRemotePermissionHook({ hooks: { PermissionRequest: {} } }, { nodeBin: "/node", hookScript: "/x/claude-permission-hook.mjs", socketPath: "/x.sock" }), /must be an array/);
  assert.throws(() => installRemotePermissionHook({ hooks: { PermissionRequest: [null] } }, { nodeBin: "/node", hookScript: "/x/claude-permission-hook.mjs", socketPath: "/x.sock" }), /invalid hook group/);
  assert.throws(() => installRemotePermissionHook({}, { nodeBin: "node", hookScript: "/x/claude-permission-hook.mjs", socketPath: "/x.sock" }), /absolute path/);
});

test("removes only the permission bridge handler from a mixed group", () => {
  const userHandler = { type: "command", command: "notify-send user hook" };
  const settings = { hooks: { PermissionRequest: [
    { matcher: "Bash", hooks: [userHandler, { type: "command", command: "/usr/bin/node", args: ["/old/claude-permission-hook.mjs", "--socket", "/old.sock"], timeout: 600 }] },
  ] } };
  const removed = removeRemotePermissionHook(settings, "/old/claude-permission-hook.mjs");
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.settings, { hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [userHandler] }] } });
  assert.equal(removeRemotePermissionHook(removed.settings, "/old/claude-permission-hook.mjs").changed, false);
  const otherPath = { hooks: { PermissionRequest: [
    { hooks: [{ type: "command", command: "/usr/bin/node", args: ["/other/claude-permission-hook.mjs", "--socket", "/other.sock"], timeout: 610 }] },
  ] } };
  assert.equal(removeRemotePermissionHook(otherPath, "/old/claude-permission-hook.mjs").changed, false, "same basename at a different path is not owned by this install");
  assert.equal(otherPath.hooks.PermissionRequest.length, 1);
});

test("Stop fixture follows the local SDK shape but remains an experiment candidate", () => {
  const input = stopHookSchemaFixture();
  assert.deepEqual(Object.keys(input), ["hook_event_name", "session_id", "transcript_path", "cwd", "stop_hook_active", "last_assistant_message", "background_tasks", "session_crons"]);
  assert.equal(input.hook_event_name, "Stop");
  const candidate = stopAsyncRewakeSchemaFixture();
  assert.equal(candidate.async, true);
  assert.equal(candidate.asyncRewake, true);
  // The fixture does not make any claim that the installed CLI accepts or wakes from this payload.
});

test("manual helper previews without writes, applies with backup, and removes reversibly using only temp paths", async () => {
  const temp = await mkdtemp(join(tmpdir(), "remote-hooks-plan-"));
  try {
    const target = join(temp, "settings.json");
    const socket = join(temp, "permissions.sock");
    const hook = join(temp, "claude-permission-hook.mjs");
    const original = JSON.stringify({ model: "sonnet", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }] } }, null, 2) + "\n";
    await writeFile(target, original);
    await writeFile(hook, "// fixture only\n");

    const preview = execFileSync(process.execPath, [cli, "--settings", target, "--socket", socket, "--hook-script", hook], { encoding: "utf8" });
    assert.match(preview, /Preview only/);
    assert.equal(await readFile(target, "utf8"), original);
    assert.deepEqual((await readdir(temp)).sort(), ["claude-permission-hook.mjs", "settings.json"]);

    const applied = execFileSync(process.execPath, [cli, "--settings", target, "--socket", socket, "--hook-script", hook, "--apply"], { encoding: "utf8" });
    assert.match(applied, /Applied\. Backup:/);
    const installed = JSON.parse(await readFile(target, "utf8")) as { hooks: Record<string, unknown[]> };
    assert.equal(installed.hooks.PermissionRequest?.length, 1);
    assert.equal(installed.hooks.Stop?.length, 1);
    assert.ok((await readdir(temp)).some((name) => name.startsWith("settings.json.bak-")));

    execFileSync(process.execPath, [cli, "--settings", target, "--hook-script", hook, "--remove", "--apply"], { encoding: "utf8" });
    const restored = JSON.parse(await readFile(target, "utf8"));
    assert.deepEqual(restored, JSON.parse(original));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
