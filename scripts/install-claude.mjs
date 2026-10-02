#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_APP_PROFILE, configureFeishuApp, generateBindToken, parseEnvironment, registerFeishuApp, renderEnvironment, renderSystemdUnit } from "../dist/src/installer.js";
import { BRIDGE_HOOK_EVENTS, bridgeHookCommand, mergeBridgeHooks } from "../dist/src/claude/hooks-config.js";
import { readClaudeSettings, writeClaudeSettings } from "../dist/src/claude/settings-file.js";
import { readBinding } from "../dist/src/claude/binding-status.js";

const args = process.argv.slice(2);
const usage = `Usage: ./install-claude.sh [--existing-app <cli_xxx> | --from-env] [--no-hooks] [--sync-dir <dir>... | --sync-all]

  no option                 Create a new self-built Feishu app by QR code.
  --existing-app <cli_xxx>  QR-authorize and configure an existing self-built app.
  --from-env                Use a manually configured ~/.config/feishu-claude-bridge/env.
  --no-hooks                Do not register the session-state hooks in Claude Code settings.json.
  --sync-dir <dir>          Mirror only sessions working in <dir> or below it (absolute or ~/ path; repeatable).
  --sync-all                Mirror sessions of every directory again (the default).
  Without --sync-dir or --sync-all, the SYNC_DIRS already saved in the environment file is kept.`;
if (args.includes("--help") || args.includes("-h")) { console.log(usage); process.exit(0); }
if (args.includes("--container")) throw new Error("Claude Code 桥接的安装器暂不支持 --container。");
let existingAppId = null;
let fromEnv = false;
let installHooks = true;
let syncAll = false;
const syncDirArgs = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const value = args[index + 1];
  if (arg === "--existing-app" && existingAppId === null && /^cli_[A-Za-z0-9]+$/.test(value ?? "")) { existingAppId = value; index += 1; }
  else if (arg === "--from-env" && !fromEnv) fromEnv = true;
  else if (arg === "--no-hooks" && installHooks) installHooks = false;
  else if (arg === "--sync-dir" && value && !value.startsWith("--")) { syncDirArgs.push(value); index += 1; }
  else if (arg === "--sync-all" && !syncAll) syncAll = true;
  else throw new Error(usage);
}
if ((fromEnv && existingAppId) || (syncAll && syncDirArgs.length)) throw new Error(usage);

const projectDir = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const userHome = homedir();
const configDir = join(userHome, ".config", "feishu-claude-bridge");
const envFile = join(configDir, "env");
const pendingEnvFile = join(configDir, "env.pending");
const codexEnvFile = join(userHome, ".config", "feishu-codex-bridge", "env");
const serviceName = "feishu-claude-bridge.service";
const unitDir = join(userHome, ".config", "systemd", "user");
const unitFile = join(unitDir, serviceName);
const defaultStateDir = join(userHome, ".local", "state", "feishu-claude-bridge");
// Claude Code keeps its settings and transcripts in CLAUDE_CONFIG_DIR instead of ~/.claude when set.
const defaultClaudeHome = process.env.CLAUDE_CONFIG_DIR || join(userHome, ".claude");
const hookScript = join(projectDir, "scripts", "claude-hook.mjs");
const feishuSetupVersion = "1";

function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  return null;
}

function succeeds(command, commandArgs) {
  try { execFileSync(command, commandArgs, { stdio: "ignore", timeout: 30_000 }); return true; } catch { return false; }
}

/** Missing file is null; an unreadable or malformed file stops the installer instead of being replaced. */
async function readConfig(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try { return parseEnvironment(raw); } catch (error) {
    throw new Error(`${path} 无法解析（${error instanceof Error ? error.message : error}）。请修正或移走该文件后重试；安装器不会覆盖它。`);
  }
}

function displayPath(path) {
  return path === userHome || path.startsWith(`${userHome}/`) ? `~${path.slice(userHome.length)}` : path;
}

function runningInWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")); } catch { return false; }
}

const nodeRepair = `\nRun these commands, then rerun ./install-claude.sh:\n\ncurl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n. "$HOME/.nvm/nvm.sh"\nnvm install 22\nnvm use 22\n`;
const claudeRepair = `\n请执行以下命令安装 Claude Code，然后重新运行 ./install-claude.sh：\n\ncurl -fsSL https://claude.ai/install.sh | bash\n`;

if (process.platform !== "linux") throw new Error("本安装器目前只支持 Linux（包括 WSL）。");
if (typeof process.getuid === "function" && process.getuid() === 0) throw new Error("请以实际使用 Claude Code 的普通用户运行安装器，不要使用 root 或 sudo。");
if (Number(process.versions.node.split(".")[0]) < 22) throw new Error(`需要 Node.js 22 或更新版本；当前为 ${process.version}。${nodeRepair}`);
if (!findExecutable("systemctl")) throw new Error("需要 systemctl。本安装器面向使用 systemd 的 Linux 发行版。");
if (!succeeds("systemctl", ["--user", "show-environment"])) {
  throw new Error("无法连接 systemd 用户服务（systemctl --user）。WSL 中请在 /etc/wsl.conf 的 [boot] 段设置 systemd=true，在 Windows 中执行 wsl --shutdown 后重新打开 WSL，再运行本安装器。");
}
const claudeBin = findExecutable("claude");
if (!claudeBin) throw new Error(`未在 PATH 中找到 Claude Code CLI（claude）。${claudeRepair}`);
execFileSync(claudeBin, ["--version"], { stdio: "inherit", timeout: 30_000 });
if (!succeeds(claudeBin, ["auth", "status"])) {
  console.warn("WARN  claude auth status 显示 Claude Code 尚未登录。只读镜像不调用模型，安装继续；在本机使用 Claude Code 前请先运行 claude 完成登录。");
}

await mkdir(configDir, { recursive: true, mode: 0o700 });
const previous = await readConfig(envFile);
const pending = previous ? null : await readConfig(pendingEnvFile);
if (fromEnv && !previous) throw new Error(`--from-env 需要 ${envFile}。请把 deploy/env.claude.example 复制到该位置，权限设为 600，填入真实值后重试。`);
const requiredKeys = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BIND_TOKEN"];
for (const [name, values] of [[envFile, previous], [pendingEnvFile, pending]]) {
  if (values && requiredKeys.some((key) => !values[key])) {
    throw new Error(`${name} 不完整。请恢复全部飞书必需值，或删除该文件后再创建新应用。`);
  }
}
// Feishu delivers each long-connection event to only one connected client, so two bridges cannot share an app.
const codexAppId = await readConfig(codexEnvFile).then((values) => values?.FEISHU_APP_ID, () => undefined);
const claimedAppId = existingAppId ?? previous?.FEISHU_APP_ID ?? pending?.FEISHU_APP_ID;
if (codexAppId && claimedAppId === codexAppId) {
  throw new Error(`飞书应用 ${codexAppId} 已被 Codex 桥接使用（${codexEnvFile}）。两个桥接同时连接同一应用时，飞书只会把每个事件推送给其中一个进程；请不带参数运行 ./install-claude.sh 创建新的应用。`);
}

const saved = previous ?? pending ?? {};
// --sync-dir replaces the saved scope and --sync-all clears it; otherwise the saved SYNC_DIRS is kept.
let syncDirs = saved.SYNC_DIRS ?? "";
if (syncAll) syncDirs = "";
else if (syncDirArgs.length) {
  const resolved = [];
  for (const dir of syncDirArgs) {
    // install-claude.sh runs from the repository, so a relative path would not mean what the user typed.
    const expanded = dir === "~" ? userHome : dir.startsWith("~/") ? join(userHome, dir.slice(2)) : dir;
    if (!expanded.startsWith("/")) throw new Error(`--sync-dir 需要绝对路径或以 ~/ 开头的路径：${dir}`);
    let real;
    try { real = await realpath(expanded); } catch { throw new Error(`--sync-dir 指定的目录不存在：${dir}`); }
    if (real.includes(",")) throw new Error(`同步目录的路径不能包含英文逗号：${real}`);
    resolved.push(real);
  }
  syncDirs = [...new Set(resolved)].join(",");
}
const claudeHome = resolve(saved.CLAUDE_HOME ?? defaultClaudeHome);
const stateDir = resolve(saved.STATE_DIR ?? defaultStateDir);
const settingsFile = join(claudeHome, "settings.json");
const hookCommand = bridgeHookCommand(process.execPath, hookScript, stateDir);
// Check settings.json before touching Feishu, so a file we refuse to edit stops the installer early.
if (installHooks) mergeBridgeHooks((await readClaudeSettings(settingsFile)).settings, hookCommand);

let appId = previous?.FEISHU_APP_ID;
let appSecret = previous?.FEISHU_APP_SECRET;
let bindToken = previous?.FEISHU_BIND_TOKEN;
let ownerOpenId = previous?.FEISHU_OWNER_OPEN_ID;
let needsFeishuConfiguration = !fromEnv && previous?.FEISHU_SETUP_VERSION !== feishuSetupVersion;
const showVerificationUrl = (url, expireIn) => console.log(`飞书验证链接（${expireIn} 秒内有效）：\n${url}\n`);
if (existingAppId) {
  if (previous?.FEISHU_APP_ID && previous.FEISHU_APP_ID !== existingAppId) throw new Error(`现有环境文件属于 ${previous.FEISHU_APP_ID}，拒绝替换为 ${existingAppId}。`);
  console.log(`正在授权并配置已有飞书应用 ${existingAppId}。请使用该应用的所有者或管理员账号完成验证。`);
  const app = await registerFeishuApp(showVerificationUrl, existingAppId, CLAUDE_APP_PROFILE);
  if (app.appId !== existingAppId) throw new Error(`飞书返回了意外的应用 ID ${app.appId}。`);
  if (!app.ownerOpenId) throw new Error("飞书没有返回安装者的 open_id。请使用应用所有者账号重新运行 --existing-app。");
  appId = app.appId;
  appSecret = app.appSecret;
  bindToken ??= generateBindToken();
  ownerOpenId = app.ownerOpenId;
  needsFeishuConfiguration = true;
} else if ((!appId || !appSecret || !bindToken) && pending?.FEISHU_APP_ID && pending.FEISHU_APP_SECRET && pending.FEISHU_BIND_TOKEN) {
  appId = pending.FEISHU_APP_ID;
  appSecret = pending.FEISHU_APP_SECRET;
  bindToken = pending.FEISHU_BIND_TOKEN;
  ownerOpenId = pending.FEISHU_OWNER_OPEN_ID;
  needsFeishuConfiguration = true;
  console.log(`继续完成飞书应用 ${appId} 的配置。`);
} else if (!appId || !appSecret || !bindToken) {
  console.log("\n即将创建属于你自己的飞书企业自建应用（Claude Bridge）。请使用有权创建应用的飞书账号打开验证链接。\n");
  const app = await registerFeishuApp(showVerificationUrl, undefined, CLAUDE_APP_PROFILE);
  appId = app.appId;
  appSecret = app.appSecret;
  bindToken = generateBindToken();
  ownerOpenId = app.ownerOpenId;
  needsFeishuConfiguration = true;
} else {
  console.log(`复用已有飞书应用 ${appId}；本地绑定和状态将保留。`);
}

if (needsFeishuConfiguration && !ownerOpenId) {
  throw new Error(`没有保存安装者的 open_id，无法安全地限制飞书应用的可见范围。请运行 ./install-claude.sh --existing-app ${appId}，并使用应用所有者账号扫码。`);
}

await mkdir(unitDir, { recursive: true, mode: 0o700 });
const allowedRoot = await realpath(resolve(saved.ALLOWED_ROOT ?? userHome));
await mkdir(join(stateDir, "presence"), { recursive: true, mode: 0o700 });
const setupVersion = fromEnv ? (saved.FEISHU_SETUP_VERSION ?? "manual") : feishuSetupVersion;
const environmentValues = {
  ...saved,
  FEISHU_APP_ID: appId,
  FEISHU_APP_SECRET: appSecret,
  FEISHU_BIND_TOKEN: bindToken,
  ...(ownerOpenId ? { FEISHU_OWNER_OPEN_ID: ownerOpenId } : {}),
  FEISHU_SETUP_VERSION: setupVersion,
  FEISHU_RUNTIME: "systemd",
  CLAUDE_HOME: claudeHome,
  CLAUDE_BIN: claudeBin,
  STATE_DIR: stateDir,
  ALLOWED_ROOT: allowedRoot,
  HISTORY_DAYS: saved.HISTORY_DAYS ?? "3",
  SYNC_DIRS: syncDirs,
};
if (needsFeishuConfiguration) {
  await writeFile(pendingEnvFile, renderEnvironment({ ...environmentValues, FEISHU_SETUP_VERSION: "0" }), { mode: 0o600 });
  await chmod(pendingEnvFile, 0o600);
  const configured = await configureFeishuApp(appId, appSecret, ownerOpenId, CLAUDE_APP_PROFILE);
  if (configured.publishVersion) console.log(`飞书应用版本 ${configured.publishVersion} 已提交发布。`);
  await writeFile(pendingEnvFile, renderEnvironment(environmentValues), { mode: 0o600 });
  await rename(pendingEnvFile, envFile);
} else {
  await writeFile(envFile, renderEnvironment(environmentValues), { mode: 0o600 });
  await rm(pendingEnvFile, { force: true });
}
await chmod(envFile, 0o600);
console.log(`同步范围：${syncDirs ? syncDirs.split(",").map(displayPath).join("、") : "全部目录"}`);

if (installHooks) {
  // Re-read: Claude Code may have changed settings.json while the Feishu steps ran.
  const merged = mergeBridgeHooks((await readClaudeSettings(settingsFile)).settings, hookCommand);
  if (merged.changed) {
    const { backupPath } = await writeClaudeSettings(settingsFile, merged.settings);
    if (backupPath) console.log(`原设置已备份为 ${displayPath(backupPath)}。`);
    console.log(`已在 ${displayPath(settingsFile)} 中加入以下 hook 事件：${BRIDGE_HOOK_EVENTS.join("、")}，命令：${hookCommand}`);
  } else {
    console.log(`${displayPath(settingsFile)} 中已有本桥接的 hook，无需修改。`);
  }
  console.log("如需移除：运行 npm run uninstall:claude-hooks");
} else {
  console.log("已按 --no-hooks 跳过 hook 注册；未注册时，桥接收不到会话的实时状态（运行中、等待确认、已关闭）。");
}

const wasActive = succeeds("systemctl", ["--user", "is-active", "--quiet", serviceName]);
await writeFile(unitFile, renderSystemdUnit({
  projectDir,
  nodeBin: process.execPath,
  environmentFile: envFile,
  description: "Feishu to Claude Code session bridge",
  entry: "dist/src/claude/index.js",
}), { mode: 0o644 });
execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "enable", "--now", serviceName], { stdio: "inherit" });
// enable --now leaves a running service alone; a rerun must load the new build and environment.
if (wasActive) execFileSync("systemctl", ["--user", "restart", serviceName], { stdio: "inherit" });

const doctorArgs = installHooks ? [] : ["--no-hooks"];
try {
  execFileSync(process.execPath, [join(projectDir, "scripts", "doctor-claude.mjs"), ...doctorArgs], { stdio: "inherit" });
} catch {
  console.error(`\n自检未全部通过（见上方 FAIL 项）。若飞书应用版本等待管理员审核，请先批准；处理后运行 npm run doctor:claude${installHooks ? "" : " -- --no-hooks"} 重新检查。doctor 全部通过前不要创建群或发送 /bind。\n`);
  process.exitCode = 2;
}

if (!process.exitCode) {
  // A rerun (for example to change SYNC_DIRS) keeps the binding; the bind code is already spent then.
  const binding = await readBinding(stateDir);
  const boundAt = binding?.boundAt ? `（绑定于 ${new Date(binding.boundAt).toLocaleString("zh-CN", { hour12: false })}）` : "";
  console.log(binding ? `\n安装完成，服务已按新的配置重启。机器人已经绑定到飞书群${boundAt}，无需再次绑定。

提示：` : `\n安装完成。下一步：
1. 在飞书中创建一个私密话题群，并把新机器人加入群。
2. 在群中发送：@机器人 /bind ${bindToken}
3. 绑定后，本机的 Claude Code 会话会以只读方式同步到群内话题。

提示：
${runningInWsl() ? "- 当前运行在 WSL 中：WSL 停止后服务也随之停止，请保持 WSL 运行（例如保留一个 WSL 终端窗口）。\n" : ""}- systemd 用户服务在当前用户没有登录会话时会停止；如需常驻，可执行：sudo loginctl enable-linger $USER
- 已打开的 Claude Code 会话通常会自动加载新 hook；若飞书中的状态不更新，重启该会话即可。`);
}
