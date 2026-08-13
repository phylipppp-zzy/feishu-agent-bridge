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
const containerArgument = process.argv.includes("--container");
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
    try {
      const scopes = await client.request({ url: "/open-apis/application/v6/scopes?page_size=100", method: "GET" });
      const rows = scopes?.data?.scopes ?? scopes?.data?.items ?? [];
      const granted = new Map(rows.filter((row) => row && typeof row === "object")
        .map((row) => [row.scope_name ?? row.name, row.grant_status]));
      for (const required of ["im:message", "im:message:send_as_bot", "im:message.group_msg", "im:resource", "cardkit:card:write"]) {
        result(granted.get(required) === 1 || granted.get(required) === "1", `Feishu scope ${required} is granted`);
      }
      if (granted.get("application:application:self_manage") !== 1 && granted.get("application:application:self_manage") !== "1") {
        console.log("WARN  application:application:self_manage is not granted; online event/callback configuration cannot be audited by doctor");
      }
    } catch (error) {
      console.log(`WARN  Feishu scope audit unavailable: ${error instanceof Error ? error.message : error}`);
    }
  } catch (error) { result(false, `Feishu bot API unavailable (the app may await administrator approval): ${error instanceof Error ? error.message : error}`); }
}

const codexBin = values.CODEX_BIN || "codex";
const rootMode = values.CODEX_EXECUTION_MODE === "root-danger-full-access";
const rootAck = values.ROOT_FULL_ACCESS_ACK === "I_UNDERSTAND_CODEX_CAN_MODIFY_THE_ENTIRE_CONTAINER";
if (rootMode) {
  result(rootAck, "Root danger-full-access acknowledgement is configured");
  result(values.ALLOW_GROUP_SECRET_INPUT === "1", "Group secret-input acknowledgement is configured");
}
try {
  const { stdout } = await execFileAsync(codexBin, ["--version"]);
  result(true, `Codex available: ${stdout.trim()}`);
  await execFileAsync(codexBin, ["login", "status"]);
  result(true, "Codex login is available");
} catch (error) { result(false, `Codex unavailable: ${error}`); }

try {
  await execFileAsync(codexBin, ["sandbox", "--", "/usr/bin/true"]);
  result(true, "Codex sandbox smoke test passed; command/file approvals can be enabled");
} catch (error) {
  if (rootMode && rootAck) console.log("WARN  Codex sandbox smoke test failed; explicit Root danger-full-access mode is active and can modify the entire container");
  else result(false, "Codex sandbox smoke test failed; remote command/file/permission approvals are fail-closed in this container");
  console.log(`INFO  sandbox diagnostic: ${error instanceof Error ? error.message : error}`);
}

try {
  const { stdout } = await execFileAsync(codexBin, ["app-server", "generate-json-schema", "--experimental", "--out", "/tmp/feishu-codex-bridge-doctor-schema"], { maxBuffer: 1_000_000 });
  void stdout;
  result(true, "Codex app-server experimental schema is available");
} catch (error) { result(false, `Codex app-server schema generation failed: ${error instanceof Error ? error.message : error}`); }

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

if (containerArgument || values.FEISHU_RUNTIME === "container") {
  console.log("INFO  container runtime selected; start the bridge with npm run start:container");
} else {
  try {
    await execFileAsync("systemctl", ["--user", "is-active", "--quiet", "feishu-codex-bridge.service"]);
    result(true, "feishu-codex-bridge user service is active");
  } catch { result(false, "feishu-codex-bridge user service is not active; run systemctl --user restart feishu-codex-bridge.service"); }
}

process.exitCode = failures ? 1 : 0;
