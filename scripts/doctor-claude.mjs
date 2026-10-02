#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as Lark from "@larksuiteoapi/node-sdk";
import { parseEnvironment } from "../dist/src/installer.js";
import { bridgeHookCommand, bridgeHooksStatus, parseBridgeHookCommand } from "../dist/src/claude/hooks-config.js";
import { readClaudeSettings } from "../dist/src/claude/settings-file.js";
import { installSafeLogging } from "../dist/src/safe-log.js";

const execFileAsync = promisify(execFile);
const projectDir = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const configDir = join(homedir(), ".config", "feishu-claude-bridge");
const envPath = join(configDir, "env");
const serviceName = "feishu-claude-bridge.service";
const skipHooks = process.argv.includes("--no-hooks");
const repair = "在仓库目录重新运行 ./install-claude.sh（会复用已有配置）";
let failures = 0;
function result(ok, text) { console.log(`${ok ? "OK" : "FAIL"}  ${text}`); if (!ok) failures += 1; }
function message(error) { return error instanceof Error ? error.message : String(error); }
async function executable(path) { try { await access(path, constants.X_OK); return true; } catch { return false; } }

let values = {};
try {
  const info = await stat(envPath);
  result((info.mode & 0o077) === 0, `${envPath} 权限为 ${(info.mode & 0o777).toString(8)}（应为 600）`);
  values = parseEnvironment(await readFile(envPath, "utf8"));
  installSafeLogging([values.FEISHU_APP_SECRET, values.FEISHU_BIND_TOKEN].filter(Boolean));
  for (const key of ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BIND_TOKEN", "CLAUDE_HOME", "CLAUDE_BIN", "STATE_DIR"]) {
    result(Boolean(values[key]), `${key} 已配置`);
  }
  if (values.HISTORY_DAYS !== undefined) result(/^[1-9][0-9]*$/.test(values.HISTORY_DAYS), `HISTORY_DAYS=${values.HISTORY_DAYS} 是正整数`);
  if (values.FEISHU_SETUP_VERSION === "manual") console.log("INFO  飞书应用为手工配置；请在开发者后台确认可见范围、权限和长连接设置");
  else result(Boolean(values.FEISHU_OWNER_OPEN_ID), "飞书应用的可见范围已限制为安装者本人");
  console.log("INFO  卡片回调走飞书长连接，不需要公网回调地址");
} catch (error) { result(false, `无法读取 ${envPath}：${message(error)}`); }

const pendingPath = join(configDir, "env.pending");
try { await stat(pendingPath); result(false, `${pendingPath} 表示飞书应用配置尚未完成；请重新运行 ./install-claude.sh`); } catch { /* no recovery file */ }

if (values.FEISHU_APP_ID && values.FEISHU_APP_SECRET) {
  try {
    const client = new Lark.Client({
      appId: values.FEISHU_APP_ID,
      appSecret: values.FEISHU_APP_SECRET,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });
    const response = await client.request({ url: "/open-apis/bot/v3/info", method: "GET" });
    result(Boolean(response?.bot?.open_id), "飞书凭据有效，机器人能力可用");
    try {
      const scopes = await client.request({ url: "/open-apis/application/v6/scopes?page_size=100", method: "GET" });
      const rows = scopes?.data?.scopes ?? scopes?.data?.items ?? [];
      const granted = new Map(rows.filter((row) => row && typeof row === "object")
        .map((row) => [row.scope_name ?? row.name, row.grant_status]));
      for (const required of ["im:message", "im:message:send_as_bot", "im:message.group_msg", "im:resource", "cardkit:card:write"]) {
        result(granted.get(required) === 1 || granted.get(required) === "1", `飞书权限 ${required} 已开通`);
      }
    } catch (error) {
      console.log(`WARN  无法核对飞书权限：${message(error)}`);
    }
  } catch (error) { result(false, `飞书机器人接口不可用（应用版本可能正在等待管理员审核）：${message(error)}`); }
}

const claudeBin = values.CLAUDE_BIN || "claude";
try {
  const { stdout } = await execFileAsync(claudeBin, ["--version"], { timeout: 30_000 });
  result(true, `Claude Code 可用：${stdout.trim()}（${claudeBin}）`);
} catch (error) { result(false, `CLAUDE_BIN 无法运行（${claudeBin}）：${message(error)}`); }

const claudeHome = resolve(values.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
const projectsDir = join(claudeHome, "projects");
try {
  let count = 0;
  for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    count += (await readdir(join(projectsDir, entry.name))).filter((name) => name.endsWith(".jsonl")).length;
  }
  result(true, `${projectsDir} 存在，共 ${count} 个 Claude Code 会话记录`);
} catch (error) { result(false, `无法读取 ${projectsDir}（从未在本机运行过 Claude Code 会话时该目录不存在）：${message(error)}`); }

const stateDir = resolve(values.STATE_DIR || join(homedir(), ".local", "state", "feishu-claude-bridge"));
const hookScript = join(projectDir, "scripts", "claude-hook.mjs");
const settingsFile = join(claudeHome, "settings.json");
if (skipHooks) console.log("INFO  已按 --no-hooks 跳过 hook 检查；桥接收不到会话的实时状态");
else {
  try {
    const { settings } = await readClaudeSettings(settingsFile);
    const status = bridgeHooksStatus(settings, bridgeHookCommand(process.execPath, hookScript, stateDir));
    for (const problem of status.problems) result(false, `${settingsFile}：${problem}`);
    if (status.disableAllHooks) result(false, `${settingsFile} 设置了 "disableAllHooks": true，所有 hook（包括本桥接的）都不会运行`);
    for (const { event, commands, installed, matchesExpected } of status.events) {
      if (!installed) { result(false, `${event} hook 未安装；修复：${repair}`); continue; }
      if (matchesExpected) { result(true, `${event} hook 已安装，指向当前仓库`); continue; }
      // Another node binary is fine as long as it still exists and the script and STATE_DIR are current.
      const parts = commands.length === 1 ? parseBridgeHookCommand(commands[0]) : null;
      const problem = commands.length > 1 ? `有 ${commands.length} 条本桥接条目`
        : !parts ? `命令格式无法识别：${commands[0]}`
        : parts.hookScript !== hookScript ? `指向其他位置的脚本：${parts.hookScript}`
        : parts.stateDir !== stateDir ? `的 STATE_DIR 为 ${parts.stateDir}，应为 ${stateDir}`
        : !await executable(parts.nodeBin) ? `使用的 node 不存在或不可执行：${parts.nodeBin}`
        : null;
      if (problem) result(false, `${event} hook ${problem}；修复：${repair}`);
      else result(true, `${event} hook 已安装，指向当前仓库（node：${parts.nodeBin}）`);
    }
  } catch (error) { result(false, `无法检查 ${settingsFile} 中的 hook：${message(error)}`); }
}

const presenceDir = join(stateDir, "presence");
try {
  const info = await stat(presenceDir);
  if (!info.isDirectory()) throw new Error("不是目录");
  await access(presenceDir, constants.W_OK | constants.X_OK);
  result(true, `${presenceDir} 可写`);
  if (info.mode & 0o077) console.log(`WARN  ${presenceDir} 权限为 ${(info.mode & 0o777).toString(8)}，建议改为 700`);
  let newest = 0;
  const names = (await readdir(presenceDir)).filter((name) => name.endsWith(".json"));
  for (const name of names) {
    try { newest = Math.max(newest, (await stat(join(presenceDir, name))).mtimeMs); } catch { /* removed meanwhile */ }
  }
  if (names.length) console.log(`INFO  共 ${names.length} 个会话状态文件，最近一次由 hook 写入于 ${new Date(newest).toLocaleString()}`);
  else if (!skipHooks) console.log("INFO  尚未收到 hook 写入；新开一个 Claude Code 会话后再运行 npm run doctor:claude 确认");
} catch (error) { result(false, `${presenceDir} 不可写：${message(error)}；修复：${repair}`); }

try {
  const { stdout } = await execFileAsync("loginctl", ["show-user", process.env.USER || userInfo().username, "-p", "Linger", "--value"]);
  console.log(`INFO  systemd linger：${stdout.trim() || "unknown"}；未启用时，服务只在当前用户有登录会话期间运行`);
} catch { console.log("INFO  无法查询 systemd linger 状态"); }

try {
  await execFileAsync("systemctl", ["--user", "is-active", "--quiet", serviceName]);
  result(true, `${serviceName} 用户服务正在运行`);
} catch {
  result(false, `${serviceName} 用户服务未运行；查看日志：journalctl --user -u ${serviceName} -n 50；重启：systemctl --user restart ${serviceName}`);
}

process.exitCode = failures ? 1 : 0;
