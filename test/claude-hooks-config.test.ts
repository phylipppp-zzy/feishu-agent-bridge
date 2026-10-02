import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BRIDGE_HOOK_EVENTS, BRIDGE_HOOK_TIMEOUT_SECONDS, bridgeHookCommand, bridgeHooksStatus, isBridgeHookCommand,
  mergeBridgeHooks, parseBridgeHookCommand, removeBridgeHooks, shellQuote,
} from "../src/claude/hooks-config.js";
import { backupTimestamp, readClaudeSettings, writeClaudeSettings } from "../src/claude/settings-file.js";

const command = bridgeHookCommand("/usr/bin/node", "/home/alice/feishu-codex-bridge/scripts/claude-hook.mjs", "/home/alice/.local/state/feishu-claude-bridge");
const oldCommand = bridgeHookCommand("/usr/bin/node", "/home/alice/old-checkout/scripts/claude-hook.mjs", "/home/alice/.local/state/feishu-claude-bridge");
const bridgeGroup = (hookCommand: string) => ({ hooks: [{ type: "command", command: hookCommand, timeout: BRIDGE_HOOK_TIMEOUT_SECONDS }] });
const userStop = { hooks: [{ type: "command", command: "notify-send done" }] };
const userBash = { matcher: "Bash", hooks: [{ type: "command", command: "/home/alice/bin/check-bash.sh", timeout: 5 }] };

test("bridge hook commands quote every path for sh -c and round-trip", () => {
  assert.equal(command, "'/usr/bin/node' '/home/alice/feishu-codex-bridge/scripts/claude-hook.mjs' --state-dir '/home/alice/.local/state/feishu-claude-bridge'");
  const tricky = ["/opt/my node/bin/node", "/home/o'brien/$(rm -rf ~)/`x`/scripts/claude-hook.mjs", "/state dir/'quoted' \"double\" $HOME;|&*"];
  const words = execFileSync("sh", ["-c", `printf '%s\\0' ${tricky.map(shellQuote).join(" ")}`]).toString().split("\0").slice(0, -1);
  assert.deepEqual(words, tricky);
  const trickyCommand = bridgeHookCommand(tricky[0]!, tricky[1]!, tricky[2]!);
  assert.deepEqual(parseBridgeHookCommand(trickyCommand), { nodeBin: tricky[0], hookScript: tricky[1], stateDir: tricky[2] });
  assert.ok(isBridgeHookCommand(trickyCommand));
  assert.equal(parseBridgeHookCommand("node /x/claude-hook.mjs --state-dir /y"), null);
  assert.throws(() => bridgeHookCommand("node", "/x/scripts/claude-hook.mjs", "/state"), /绝对路径/);
  assert.throws(() => bridgeHookCommand("/usr/bin/node", "/x/scripts/claude-hook.mjs", "state"), /绝对路径/);
  assert.equal(isBridgeHookCommand("/home/alice/bin/check-bash.sh"), false);
  assert.equal(isBridgeHookCommand("node claude-hook.mjs"), false);
  assert.equal(isBridgeHookCommand(undefined), false);
  assert.throws(() => mergeBridgeHooks({}, "notify-send done"), /不是本桥接的 hook 命令/);
});

test("merging registers every bridge event once, without matcher, and is idempotent", () => {
  const input = { model: "opus" };
  const first = mergeBridgeHooks(input, command);
  assert.equal(first.changed, true);
  assert.deepEqual(input, { model: "opus" }, "the input object is not modified");
  assert.deepEqual(Object.keys(first.settings), ["model", "hooks"]);
  const hooks = first.settings.hooks as Record<string, unknown>;
  assert.deepEqual(Object.keys(hooks), [...BRIDGE_HOOK_EVENTS]);
  for (const event of BRIDGE_HOOK_EVENTS) assert.deepEqual(hooks[event], [bridgeGroup(command)]);
  const second = mergeBridgeHooks(first.settings, command);
  assert.equal(second.changed, false);
  assert.deepEqual(second.settings, first.settings);
  assert.notEqual(second.settings, first.settings, "a new object is returned even when unchanged");
});

test("merging keeps the user's hooks and settings and replaces an outdated bridge entry in place", () => {
  const settings = {
    env: { FOO: "1" },
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      PreToolUse: [userBash],
      Stop: [userStop],
      SessionStart: [userStop, bridgeGroup(oldCommand), { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
      // A user handler placed into the bridge group by hand, and a duplicate bridge group.
      SessionEnd: [{ matcher: "other", hooks: [{ type: "command", command: "logger bye" }, { type: "command", command: oldCommand, timeout: 10 }] }, bridgeGroup(oldCommand)],
      Notification: [bridgeGroup(command)],
    },
    theme: "dark",
  };
  const snapshot = structuredClone(settings);
  const { settings: merged, changed } = mergeBridgeHooks(settings, command);
  assert.equal(changed, true);
  assert.deepEqual(settings, snapshot, "the input object is not modified");
  assert.deepEqual(Object.keys(merged), ["env", "permissions", "hooks", "theme"]);
  assert.deepEqual(merged.env, { FOO: "1" });
  assert.deepEqual(merged.permissions, { allow: ["Bash(npm test)"] });
  const hooks = merged.hooks as Record<string, unknown[]>;
  assert.deepEqual(hooks.PreToolUse, [userBash]);
  assert.deepEqual(hooks.Stop, [userStop, bridgeGroup(command)]);
  assert.deepEqual(hooks.SessionStart, [userStop, bridgeGroup(command), { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }]);
  assert.deepEqual(hooks.SessionEnd, [{ matcher: "other", hooks: [{ type: "command", command: "logger bye" }] }, bridgeGroup(command)]);
  assert.deepEqual(hooks.Notification, [bridgeGroup(command)]);
  for (const event of BRIDGE_HOOK_EVENTS) {
    const bridgeCommands = hooks[event]!.flatMap((group) => (group as { hooks: Array<{ command?: unknown }> }).hooks)
      .filter((handler) => isBridgeHookCommand(handler.command));
    assert.deepEqual(bridgeCommands.map((handler) => handler.command), [command], event);
  }
  assert.equal(mergeBridgeHooks(merged, command).changed, false);
  // A hand-edited bridge entry (extra field) is reset to the canonical form.
  const edited = structuredClone(merged);
  (edited.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>).Stop![1]!.hooks[0]!.timeout = 99;
  const repaired = mergeBridgeHooks(edited, command);
  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.settings, merged);
});

test("unexpected hook structures abort instead of being overwritten", () => {
  for (const hooks of [[], "hooks", null, 3]) {
    const settings = { model: "opus", hooks };
    assert.throws(() => mergeBridgeHooks(settings, command), /hooks 不是 JSON 对象.*未做任何修改/);
    assert.deepEqual(settings, { model: "opus", hooks });
    assert.deepEqual(bridgeHooksStatus(settings, command).problems, ["Claude Code 设置中的 hooks 不是 JSON 对象"]);
  }
  const settings = { hooks: { Stop: { type: "command", command: "x" }, PreToolUse: [userBash] } };
  assert.throws(() => mergeBridgeHooks(settings, command), /hooks\.Stop 不是数组.*未做任何修改/);
  assert.deepEqual(settings.hooks.Stop, { type: "command", command: "x" });
  assert.deepEqual(bridgeHooksStatus(settings).problems, ["Claude Code 设置中的 hooks.Stop 不是数组"]);
});

test("removal deletes only bridge entries and the event arrays it empties", () => {
  const installed = mergeBridgeHooks({ env: { A: "1" }, hooks: { Stop: [userStop], PreToolUse: [userBash], SubagentStop: [] } }, command).settings;
  const withMixedGroup = structuredClone(installed);
  (withMixedGroup.hooks as Record<string, unknown[]>).SessionEnd = [{ matcher: "other", hooks: [{ type: "command", command: "logger bye" }, { type: "command", command: oldCommand }] }];
  const input = structuredClone(withMixedGroup);
  const { settings, changed } = removeBridgeHooks(withMixedGroup);
  assert.equal(changed, true);
  assert.deepEqual(withMixedGroup, input, "the input object is not modified");
  assert.deepEqual(settings, {
    env: { A: "1" },
    hooks: { Stop: [userStop], PreToolUse: [userBash], SubagentStop: [], SessionEnd: [{ matcher: "other", hooks: [{ type: "command", command: "logger bye" }] }] },
  });
  assert.equal(removeBridgeHooks(settings).changed, false);
  assert.deepEqual(removeBridgeHooks({ model: "opus" }), { settings: { model: "opus" }, changed: false });
  assert.deepEqual(removeBridgeHooks({ hooks: "broken" }), { settings: { hooks: "broken" }, changed: false });
  assert.deepEqual(removeBridgeHooks(mergeBridgeHooks({}, command).settings).settings, { hooks: {} });
});

test("status reports installation, command drift and disableAllHooks for doctor", () => {
  const installed = mergeBridgeHooks({}, command).settings;
  const status = bridgeHooksStatus(installed, command);
  assert.deepEqual(status.problems, []);
  assert.equal(status.disableAllHooks, false);
  assert.deepEqual(status.events.map((event) => event.event), [...BRIDGE_HOOK_EVENTS]);
  assert.ok(status.events.every((event) => event.installed && event.matchesExpected === true && event.commands.length === 1));
  assert.ok(bridgeHooksStatus(installed, oldCommand).events.every((event) => event.installed && event.matchesExpected === false));
  assert.ok(bridgeHooksStatus(installed).events.every((event) => event.matchesExpected === null));
  const partial = bridgeHooksStatus({ disableAllHooks: true, hooks: { Stop: [bridgeGroup(command), bridgeGroup(oldCommand)] } }, command);
  assert.equal(partial.disableAllHooks, true);
  const stop = partial.events.find((event) => event.event === "Stop");
  assert.deepEqual(stop, { event: "Stop", commands: [command, oldCommand], installed: true, matchesExpected: false });
  assert.ok(partial.events.filter((event) => event.event !== "Stop").every((event) => !event.installed && event.matchesExpected === false));
});

test("settings files are read strictly and rewritten with a backup, original mode and symlink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-claude-settings-"));
  try {
    assert.equal(backupTimestamp(new Date(2026, 0, 2, 3, 4, 5)), "20260102030405");
    const missing = join(dir, "missing", "settings.json");
    assert.deepEqual(await readClaudeSettings(missing), { settings: {}, exists: false });
    const blank = join(dir, "blank.json");
    await writeFile(blank, " \n");
    assert.deepEqual(await readClaudeSettings(blank), { settings: {}, exists: true });
    for (const content of ["{ \"hooks\": {}, }", "[]", "\"text\""]) {
      const broken = join(dir, "broken.json");
      await writeFile(broken, content);
      await assert.rejects(readClaudeSettings(broken), /未做任何修改/);
      assert.equal(await readFile(broken, "utf8"), content);
    }

    const created = await writeClaudeSettings(missing, { model: "opus" });
    assert.equal(created.backupPath, null);
    assert.equal((await stat(missing)).mode & 0o777, 0o600);
    assert.equal(await readFile(missing, "utf8"), "{\n  \"model\": \"opus\"\n}\n");

    const realDir = join(dir, "dotfiles");
    const claudeHome = join(dir, "claude");
    await mkdir(realDir);
    await mkdir(claudeHome);
    const real = join(realDir, "settings.json");
    const original = "{\"model\":\"opus\"}";
    await writeFile(real, original);
    await chmod(real, 0o664);
    const linked = join(claudeHome, "settings.json");
    await symlink(real, linked);
    const now = new Date(2026, 9, 2, 23, 1, 2);
    const first = await writeClaudeSettings(linked, { model: "sonnet" }, now);
    const second = await writeClaudeSettings(linked, { model: "haiku" }, now);
    assert.equal(first.backupPath, `${linked}.bak-20261002230102`);
    assert.equal(second.backupPath, `${linked}.bak-20261002230102-2`);
    assert.equal(await readFile(first.backupPath!, "utf8"), original);
    assert.equal((await stat(first.backupPath!)).mode & 0o777, 0o664);
    assert.ok((await lstat(linked)).isSymbolicLink(), "a symlinked settings.json stays a symlink");
    assert.equal((await stat(real)).mode & 0o777, 0o664);
    assert.deepEqual((await readClaudeSettings(linked)).settings, { model: "haiku" });
    assert.deepEqual((await readdir(realDir)).sort(), ["settings.json"], "no temporary files are left behind");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
