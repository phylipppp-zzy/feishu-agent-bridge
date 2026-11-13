#!/usr/bin/env node
// Explicit, reversible settings helper. It never guesses ~/.claude/settings.json.
import { access, constants } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register();
const [{ installRemotePermissionHook, removeRemotePermissionHook }, { readClaudeSettings, writeClaudeSettings }] = await Promise.all([
  import("../src/claude/remote-hooks-plan.ts"),
  import("../src/claude/settings-file.ts"),
]);

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const defaultPermissionScript = join(repoRoot, "scripts", "claude-permission-hook.mjs");
const args = process.argv.slice(2);
const help = `Usage:
  node scripts/prepare-claude-remote-hooks.mjs --settings <absolute-path> --socket <absolute-socket-path> [--hook-script <absolute-path>]
  node scripts/prepare-claude-remote-hooks.mjs --settings <absolute-path> --socket <absolute-socket-path> [--hook-script <absolute-path>] --apply
  node scripts/prepare-claude-remote-hooks.mjs --settings <absolute-path> --remove [--apply]

Without --apply, prints a plan only. --settings is always required; no default user settings path is read.
The default hook script is scripts/claude-permission-hook.mjs from this checkout. --hook-script is for
an explicit alternate checkout or isolated temp testing. --apply backs up and atomically replaces settings.json.
The B Stop/asyncRewake experiment is not installed by this helper.`;

function parseArgs(values) {
  const options = { settings: null, socket: null, hookScript: defaultPermissionScript, apply: false, remove: false };
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === "--settings" && !options.settings && values[i + 1]) options.settings = values[++i];
    else if (value === "--socket" && !options.socket && values[i + 1]) options.socket = values[++i];
    else if (value === "--hook-script" && options.hookScript === defaultPermissionScript && values[i + 1]) options.hookScript = values[++i];
    else if (value === "--apply" && !options.apply) options.apply = true;
    else if (value === "--remove" && !options.remove) options.remove = true;
    else throw new Error(help);
  }
  if (!options.settings || !isAbsolute(options.settings)) throw new Error("--settings must be an explicit absolute path.\n" + help);
  if (options.remove && options.socket) throw new Error("--socket is not used with --remove.");
  if (!options.remove && (!options.socket || !isAbsolute(options.socket))) throw new Error("--socket must be an explicit absolute Unix socket path.\n" + help);
  if (options.hookScript !== defaultPermissionScript && !isAbsolute(options.hookScript)) throw new Error("--hook-script must be absolute.");
  return options;
}

if (args.includes("--help") || args.includes("-h")) { console.log(help); process.exit(0); }
const options = parseArgs(args);
const current = await readClaudeSettings(options.settings);
const result = options.remove
  ? removeRemotePermissionHook(current.settings, options.hookScript)
  : installRemotePermissionHook(current.settings, {
    nodeBin: process.execPath,
    hookScript: options.hookScript,
    socketPath: options.socket,
  });

console.log(`Settings target: ${options.settings}`);
console.log(result.changed ? result.diff : "(settings already match; no changes)");
if (!result.changed) process.exit(0);
if (!options.apply) {
  console.log("Preview only; no file was written. Add --apply to back up and atomically apply this plan.");
  process.exit(0);
}
if (!options.remove) {
  try { await access(options.hookScript, constants.R_OK); }
  catch { throw new Error(`Permission hook script is not readable: ${options.hookScript}; install/merge the E hook client first.`); }
}
const { backupPath } = await writeClaudeSettings(options.settings, result.settings);
console.log(`Applied. Backup: ${backupPath ?? "none (settings file did not exist)"}`);
console.log(options.remove ? "Only this bridge PermissionRequest handler was removed." : "The PermissionRequest hook is installed. The bridge service must be running for approvals; no service was started or restarted.");
