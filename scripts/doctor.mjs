#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as Lark from "@larksuiteoapi/node-sdk";
import { parseEnvironment } from "../dist/src/installer.js";

const execFileAsync = promisify(execFile);
const envPath = join(homedir(), ".config/feishu-codex-bridge/env");
let failures = 0;
function result(ok, text) { console.log(`${ok ? "OK" : "FAIL"}  ${text}`); if (!ok) failures += 1; }

let values = {};
try {
  const info = await stat(envPath);
  result((info.mode & 0o077) === 0, `${envPath} permissions are ${ (info.mode & 0o777).toString(8) } (expected 600)`);
  const raw = await readFile(envPath, "utf8");
  values = parseEnvironment(raw);
  result(Boolean(values.FEISHU_APP_ID), "FEISHU_APP_ID is configured");
  result(Boolean(values.FEISHU_APP_SECRET), "FEISHU_APP_SECRET is configured");
  result(Boolean(values.FEISHU_BIND_TOKEN), "FEISHU_BIND_TOKEN is configured");
  if (values.FEISHU_SETUP_VERSION === "manual") console.log("INFO  Feishu application was configured manually; verify its visibility, permissions and WebSocket settings in the developer console");
  else if (values.FEISHU_SETUP_VERSION === "2") result(Boolean(values.FEISHU_OWNER_OPEN_ID), "Feishu app visibility is restricted to the installing user");
  else console.log(`INFO  Legacy Feishu setup has not been visibility-audited; run ./install.sh --existing-app ${values.FEISHU_APP_ID} to migrate it explicitly`);
  result((values.UPLOAD_RAW_ARCHIVES || "false").toLowerCase() !== "true",
    "UPLOAD_RAW_ARCHIVES is disabled; raw JSONL is local only");
  if (values.UPLOAD_RAW_ARCHIVES) console.log("INFO  UPLOAD_RAW_ARCHIVES is a retired setting and is ignored by the service");
  console.log("INFO  card actions use the Feishu WebSocket callback; no public callback URL is required");
} catch (error) { result(false, `cannot read ${envPath}: ${error}`); }

const pendingPath = join(homedir(), ".config/feishu-codex-bridge/env.pending");
try { await stat(pendingPath); result(false, `unfinished Feishu provisioning exists at ${pendingPath}; rerun ./install.sh`); } catch { /* no recovery file */ }

if (values.FEISHU_APP_ID && values.FEISHU_APP_SECRET) {
  try {
    const client = new Lark.Client({
      appId: values.FEISHU_APP_ID,
      appSecret: values.FEISHU_APP_SECRET,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });
    const response = await client.request({ url: "/open-apis/bot/v3/info", method: "GET" });
    result(Boolean(response?.bot?.open_id), "Feishu credentials and bot capability are available");
  } catch (error) { result(false, `Feishu bot API unavailable (the app may await administrator approval): ${error instanceof Error ? error.message : error}`); }
}

const codexBin = values.CODEX_BIN || "codex";
try {
  const { stdout } = await execFileAsync(codexBin, ["--version"]);
  result(true, `Codex available: ${stdout.trim()}`);
  await execFileAsync(codexBin, ["login", "status"]);
  result(true, "Codex login is available");
} catch (error) { result(false, `Codex unavailable: ${error}`); }

try {
  const sessions = values.CODEX_HOME ? join(values.CODEX_HOME, "sessions") : join(homedir(), ".codex/sessions");
  let count = 0;
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else if (entry.name.endsWith(".jsonl")) count += 1;
    }
  }
  await walk(sessions);
  result(true, `Found ${count} Codex JSONL session files`);
} catch (error) { result(false, `cannot scan Codex sessions: ${error}`); }

try {
  const { stdout } = await execFileAsync("loginctl", ["show-user", process.env.USER || userInfo().username, "-p", "Linger", "--value"]);
  console.log(`INFO  systemd linger: ${stdout.trim() || "unknown"}; service is login-session-only when disabled`);
} catch { console.log("INFO  unable to query systemd linger"); }

try {
  await execFileAsync("systemctl", ["--user", "is-active", "--quiet", "feishu-codex-bridge.service"]);
  result(true, "feishu-codex-bridge user service is active");
} catch { result(false, "feishu-codex-bridge user service is not active; run systemctl --user restart feishu-codex-bridge.service"); }

process.exitCode = failures ? 1 : 0;
