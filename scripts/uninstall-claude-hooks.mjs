#!/usr/bin/env node
// Removes only the hooks that install-claude.mjs registered in Claude Code settings.json. The
// Feishu application, environment file, service and state directory are left as they are.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvironment } from "../dist/src/installer.js";
import { removeBridgeHooks } from "../dist/src/claude/hooks-config.js";
import { readClaudeSettings, writeClaudeSettings } from "../dist/src/claude/settings-file.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npm run uninstall:claude-hooks\n\n  Remove the feishu-claude-bridge hooks from Claude Code settings.json (a backup is kept).");
  process.exit(0);
}

const envPath = join(homedir(), ".config", "feishu-claude-bridge", "env");
let claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
try {
  const values = parseEnvironment(await readFile(envPath, "utf8"));
  if (values.CLAUDE_HOME) claudeHome = values.CLAUDE_HOME;
} catch { /* not installed or unreadable: use Claude Code's own default */ }
const settingsFile = join(resolve(claudeHome), "settings.json");

const { settings, exists } = await readClaudeSettings(settingsFile);
const removed = removeBridgeHooks(settings);
if (!exists || !removed.changed) {
  console.log(`${settingsFile} 中没有本桥接的 hook，无需修改。`);
} else {
  const { backupPath } = await writeClaudeSettings(settingsFile, removed.settings);
  console.log(`已从 ${settingsFile} 移除本桥接的 hook。原文件已备份为 ${backupPath}。`);
  console.log("飞书桥接服务（如已安装）不受影响，但将收不到会话的实时状态；如需停用服务：systemctl --user disable --now feishu-claude-bridge.service");
}
