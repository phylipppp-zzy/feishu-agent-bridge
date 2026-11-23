import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configureCardUi } from "../card-kit.js";
import { FeishuClient } from "../feishu.js";
import { installSafeLogging } from "../safe-log.js";
import { loadClaudeConfig, type ClaudeBridgeConfig } from "./config.js";
import { ClaudeBridgeDatabase } from "./db.js";
import { ClaudeRuntime } from "./runtime.js";
import { createPermissionHookServer, type PermissionApprovalHandler, type PermissionHookServer } from "./permission-hook.js";

export type PermissionHookServerFactory = (options: Parameters<typeof createPermissionHookServer>[0]) => PermissionHookServer;

/** Starts the private IPC hook only when explicitly enabled; its permissions affect only this child directory. */
export async function startPermissionHookServerIfEnabled(
  config: Pick<ClaudeBridgeConfig, "permissionHookEnabled" | "stateDir">,
  onRequest: PermissionApprovalHandler,
  factory: PermissionHookServerFactory = createPermissionHookServer,
): Promise<PermissionHookServer | null> {
  if (!config.permissionHookEnabled) return null;
  const service = factory({ stateDir: join(config.stateDir, "permission-hook"), onRequest });
  try { await service.start(); }
  catch (error) {
    await service.stop().catch(() => undefined);
    throw error;
  }
  return service;
}

async function main(): Promise<void> {
  const config = loadClaudeConfig();
  installSafeLogging([config.appSecret, config.bindToken]);
  const disableFile = process.env.FEISHU_BRIDGE_DISABLE_FILE ?? join(config.stateDir, "disabled");
  try {
    await access(disableFile, constants.F_OK);
    console.log(`feishu-claude-bridge is disabled by marker: ${disableFile}`);
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => undefined, 60 * 60 * 1_000);
      const stop = () => { clearInterval(keepAlive); resolve(); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  configureCardUi(2);
  const db = new ClaudeBridgeDatabase(config.stateDir);
  const feishu = new FeishuClient(config.appId, config.appSecret);
  const runtime = new ClaudeRuntime(config, db, feishu);
  let permissionHook: PermissionHookServer | null = null;
  try {
    permissionHook = await startPermissionHookServerIfEnabled(config, (request, signal) => runtime.handlePermissionHookRequest(request, signal));
    console.log(`Claude transcripts: ${config.claudeHome}/projects; state: ${config.stateDir}`);
    if (!db.getSetting("feishu.chat_id")) console.log("Binding is required. Send /bind <FEISHU_BIND_TOKEN> in the new private group.");
    await runtime.start();
  } catch (error) {
    await permissionHook?.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    try { feishu.close(); }
    finally { db.close(); }
    throw error;
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping on ${signal}`);
    try { await permissionHook?.stop(); }
    catch (error) { console.error("Permission hook service failed to stop", error); }
    try { await runtime.stop(); }
    finally {
      try { feishu.close(); }
      finally { db.close(); }
    }
  };
  process.on("SIGINT", () => void stop("SIGINT").finally(() => process.exit(0)));
  process.on("SIGTERM", () => void stop("SIGTERM").finally(() => process.exit(0)));
  process.on("unhandledRejection", (error) => console.error("Unhandled rejection", error));

  await feishu.start(
    (message) => runtime.onFeishuMessage(message),
    (action) => runtime.onCardAction(action),
    (action) => runtime.onBotMenuAction(action),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
