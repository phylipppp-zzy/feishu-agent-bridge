import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { BridgeDatabase } from "./db.js";
import { CodexCliProbe } from "./codex.js";
import { loadConfig } from "./config.js";
import { FeishuClient } from "./feishu.js";
import { SyncService } from "./sync.js";
import { CodexAppServer } from "./app-server.js";
import { configureCardUi } from "./cards.js";
import { installSafeLogging } from "./safe-log.js";

async function main(): Promise<void> {
  const config = loadConfig();
  installSafeLogging([config.appSecret, config.bindToken]);
  const disableFile = process.env.FEISHU_BRIDGE_DISABLE_FILE ?? join(config.stateDir, "disabled");
  try {
    await access(disableFile, constants.F_OK);
    console.log(`feishu-codex-bridge is disabled by marker: ${disableFile}`);
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => undefined, 60 * 60 * 1_000);
      const stop = () => {
        clearInterval(keepAlive);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  configureCardUi(config.cardUiVersion ?? 1);
  const db = new BridgeDatabase(config.stateDir);
  const feishu = new FeishuClient(config.appId, config.appSecret);
  const codex = new CodexCliProbe(config.codexBin, config.codexHome);
  const appServer = new CodexAppServer(config.codexBin, config.codexHome, config.stateDir);
  const sync = new SyncService(config, db, feishu, codex, appServer);
  console.log(`Starting feishu-codex-bridge with ${await codex.version()}`);
  console.log(`Session source: ${config.codexHome}/sessions; allowed root: ${config.allowedRoot}`);
  if (!db.getSetting("feishu.chat_id")) console.log("Binding is required. Send /bind <FEISHU_BIND_TOKEN> in the new private group.");
  await sync.start();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping on ${signal}`);
    await sync.stop();
    feishu.close();
    db.close();
  };
  process.on("SIGINT", () => void stop("SIGINT").finally(() => process.exit(0)));
  process.on("SIGTERM", () => void stop("SIGTERM").finally(() => process.exit(0)));
  process.on("unhandledRejection", (error) => console.error("Unhandled rejection", error));

  await feishu.start(
    (message) => sync.onFeishuMessage(message),
    (action) => sync.onCardAction(action),
    (action) => sync.onBotMenuAction(action),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
