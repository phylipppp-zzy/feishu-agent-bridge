#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access, chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configureFeishuApp, generateBindToken, parseEnvironment, registerFeishuApp, renderEnvironment, renderSystemdUnit } from "../dist/src/installer.js";

const args = process.argv.slice(2);
const usage = `Usage: ./install.sh [--container] [--existing-app <cli_xxx> | --from-env]

  no option                 Create a new self-built Feishu app by QR code.
  --existing-app <cli_xxx>  QR-authorize and configure an existing self-built app.
  --from-env                Use a manually configured ~/.config/feishu-codex-bridge/env.
  --container               Allow root and skip user-systemd installation.`;
if (args.includes("--help") || args.includes("-h")) { console.log(usage); process.exit(0); }
const existingIndex = args.indexOf("--existing-app");
const existingAppId = existingIndex >= 0 ? args[existingIndex + 1] : null;
const fromEnv = args.includes("--from-env");
const containerMode = args.includes("--container");
if ((existingIndex >= 0 && (!existingAppId || !/^cli_[A-Za-z0-9]+$/.test(existingAppId))) ||
  args.filter((arg) => arg === "--existing-app").length > 1 ||
  args.filter((arg) => arg === "--from-env").length > 1 ||
  args.filter((arg) => arg === "--container").length > 1 ||
  (fromEnv && existingIndex >= 0) || args.some((arg, index) => !["--existing-app", "--from-env", "--container"].includes(arg) && index !== existingIndex + 1)) {
  throw new Error(usage);
}

const projectDir = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const userHome = homedir();
const configDir = join(userHome, ".config", "feishu-codex-bridge");
const envFile = join(configDir, "env");
const pendingEnvFile = join(configDir, "env.pending");
const unitDir = join(userHome, ".config", "systemd", "user");
const unitFile = join(unitDir, "feishu-codex-bridge.service");
const defaultStateDir = join(userHome, ".local", "state", "feishu-codex-bridge");
const defaultCodexHome = join(userHome, ".codex");
const feishuSetupVersion = "2";

function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  return null;
}

async function readConfig(path) {
  try {
    return parseEnvironment(await readFile(path, "utf8"));
  } catch { return null; }
}

const nodeRepair = `\nRun these commands, then rerun ./install.sh:\n\ncurl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n. "$HOME/.nvm/nvm.sh"\nnvm install 22\nnvm use 22\n`;
const codexRepair = `\nRun these commands, then rerun ./install.sh:\n\nnpm install -g @openai/codex\ncodex login\n`;

if (process.platform !== "linux") throw new Error("This installer currently supports Linux only.");
if (!containerMode && typeof process.getuid === "function" && process.getuid() === 0) throw new Error("Run the installer as the target user, not as root or through sudo.");
if (Number(process.versions.node.split(".")[0]) < 22) throw new Error(`Node.js 22 or newer is required; current version is ${process.version}.${nodeRepair}`);
for (const command of containerMode ? [] : ["systemctl"]) {
  if (!findExecutable(command)) throw new Error(`${command} is required. This installer targets Linux distributions with systemd.`);
}
const codexBin = findExecutable("codex");
if (!codexBin) throw new Error(`Codex CLI was not found in PATH.${codexRepair}`);
await access(codexBin, constants.X_OK);
execFileSync(codexBin, ["--version"], { stdio: "inherit" });
try { execFileSync(codexBin, ["login", "status"], { stdio: "ignore" }); }
catch { throw new Error("Codex CLI is installed but not logged in. Run `codex login` and retry."); }

await mkdir(configDir, { recursive: true, mode: 0o700 });
const previous = await readConfig(envFile);
const pending = previous ? null : await readConfig(pendingEnvFile);
if (fromEnv && !previous) throw new Error(`--from-env requires ${envFile}. Copy deploy/env.example there, set permissions to 600, fill in real values, then retry.`);
const requiredKeys = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BIND_TOKEN"];
for (const [name, values] of [[envFile, previous], [pendingEnvFile, pending]]) {
  if (values && requiredKeys.some((key) => !values[key])) {
    throw new Error(`${name} is incomplete. Restore all required Feishu values or remove this file before creating a new app.`);
  }
}
let appId = previous?.FEISHU_APP_ID;
let appSecret = previous?.FEISHU_APP_SECRET;
let bindToken = previous?.FEISHU_BIND_TOKEN;
let ownerOpenId = previous?.FEISHU_OWNER_OPEN_ID;
let needsFeishuConfiguration = !fromEnv && previous?.FEISHU_SETUP_VERSION !== feishuSetupVersion;
if (existingAppId) {
  if (previous?.FEISHU_APP_ID && previous.FEISHU_APP_ID !== existingAppId) throw new Error(`Existing environment belongs to ${previous.FEISHU_APP_ID}; refusing to replace it with ${existingAppId}.`);
  console.log(`正在授权并配置已有飞书应用 ${existingAppId}。请使用该应用的所有者或管理员账号完成验证。`);
  const app = await registerFeishuApp((url, expireIn) => console.log(`飞书验证链接（${expireIn} 秒内有效）：\n${url}\n`), existingAppId);
  if (app.appId !== existingAppId) throw new Error(`Feishu returned unexpected app ID ${app.appId}.`);
  if (!app.ownerOpenId) throw new Error("Feishu did not return the installing user's open_id. Retry --existing-app with the app owner account.");
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
  console.log(`Resuming Feishu application configuration for ${appId}.`);
} else if (!appId || !appSecret || !bindToken) {
  console.log("\n即将创建属于你自己的飞书企业自建应用。请使用有权创建应用的飞书账号打开验证链接。\n");
  const app = await registerFeishuApp((url, expireIn) => {
    console.log(`飞书验证链接（${expireIn} 秒内有效）：\n${url}\n`);
  });
  appId = app.appId;
  appSecret = app.appSecret;
  bindToken = generateBindToken();
  ownerOpenId = app.ownerOpenId;
  needsFeishuConfiguration = true;
} else {
  console.log(`Reusing existing Feishu application ${appId}; local binding and state will be preserved.`);
}

if (needsFeishuConfiguration && !ownerOpenId) {
  throw new Error(`Feishu application visibility cannot be safely restricted because no owner open_id is stored. Run ./install.sh --existing-app ${appId} and scan with the app owner account.`);
}

if (!containerMode) await mkdir(unitDir, { recursive: true, mode: 0o700 });
const saved = previous ?? pending ?? {};
const allowedRoot = await realpath(resolve(saved.ALLOWED_ROOT ?? userHome));
const codexHome = resolve(saved.CODEX_HOME ?? defaultCodexHome);
const stateDir = resolve(saved.STATE_DIR ?? defaultStateDir);
await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
const setupVersion = fromEnv ? (saved.FEISHU_SETUP_VERSION ?? "manual") : feishuSetupVersion;
const environmentValues = {
  ...saved,
  FEISHU_APP_ID: appId,
  FEISHU_APP_SECRET: appSecret,
  FEISHU_BIND_TOKEN: bindToken,
  ...(ownerOpenId ? { FEISHU_OWNER_OPEN_ID: ownerOpenId } : {}),
  FEISHU_CARD_UI_VERSION: "2",
  FEISHU_SETUP_VERSION: setupVersion,
  FEISHU_RUNTIME: containerMode ? "container" : "systemd",
  ALLOWED_ROOT: allowedRoot,
  CODEX_HOME: codexHome,
  CODEX_BIN: codexBin,
  STATE_DIR: stateDir,
  CODEX_EXECUTION_MODE: saved.CODEX_EXECUTION_MODE ?? "workspace-write",
  ROOT_GRANT_TTL_SECONDS: saved.ROOT_GRANT_TTL_SECONDS ?? "28800",
};
delete environmentValues.UPLOAD_RAW_ARCHIVES;
if (needsFeishuConfiguration) {
  await writeFile(pendingEnvFile, renderEnvironment({ ...environmentValues, FEISHU_SETUP_VERSION: "0" }), { mode: 0o600 });
  await chmod(pendingEnvFile, 0o600);
  const configured = await configureFeishuApp(appId, appSecret, ownerOpenId);
  if (configured.publishVersion) console.log(`飞书应用版本 ${configured.publishVersion} 已提交发布。`);
  await writeFile(pendingEnvFile, renderEnvironment(environmentValues), { mode: 0o600 });
  await rename(pendingEnvFile, envFile);
} else {
  await writeFile(envFile, renderEnvironment(environmentValues), { mode: 0o600 });
  await rm(pendingEnvFile, { force: true });
}
await chmod(envFile, 0o600);
if (!containerMode) {
  await writeFile(unitFile, renderSystemdUnit({ projectDir, nodeBin: process.execPath, environmentFile: envFile }), { mode: 0o644 });
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["--user", "enable", "--now", "feishu-codex-bridge.service"], { stdio: "inherit" });
}
try {
  execFileSync(process.execPath, [join(projectDir, "scripts", "doctor.mjs"), ...(containerMode ? ["--container"] : [])], { stdio: "inherit" });
}
catch {
  console.error(`\n飞书机器人尚未验证可用。若应用版本等待管理员审核，请先批准；然后运行 ${containerMode ? "npm run doctor:container" : "npm run doctor"}。doctor 全部通过前不要创建群或发送 /bind。\n`);
  process.exitCode = 2;
}

if (!process.exitCode) {
  const startStep = containerMode ? "1. 运行 npm run start:container 启动前台容器进程。\n2." : "1.";
  console.log(`\n安装完成。下一步：\n${startStep} 在飞书中创建一个私密话题群并加入新机器人。\n${containerMode ? "3" : "2"}. 在群中发送：@机器人 /bind ${bindToken}\n${containerMode ? "4" : "3"}. 发送 /help 打开控制台。`);
}
