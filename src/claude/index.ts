import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { configureCardUi } from "../card-kit.js";
import { FeishuClient } from "../feishu.js";
import { installSafeLogging } from "../safe-log.js";
import { loadClaudeConfig } from "./config.js";
import { ClaudeBridgeDatabase } from "./db.js";
import { ClaudeRuntime } from "./runtime.js";

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
  console.log(`Claude transcripts: ${config.claudeHome}/projects; state: ${config.stateDir}`);
  if (!db.getSetting("feishu.chat_id")) console.log("Binding is required. Send /bind <FEISHU_BIND_TOKEN> in the new private group.");
  await runtime.start();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping on ${signal}`);
    await runtime.stop();
    feishu.close();
    db.close();
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
