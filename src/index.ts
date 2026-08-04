import { BridgeDatabase } from "./db.js";
import { CodexRunner } from "./codex.js";
import { loadConfig } from "./config.js";
import { FeishuClient } from "./feishu.js";
import { SyncService } from "./sync.js";
import { configureCardUi } from "./cards.js";

async function main(): Promise<void> {
  const config = loadConfig();
  configureCardUi(config.cardUiVersion ?? 1);
  const db = new BridgeDatabase(config.stateDir);
  const feishu = new FeishuClient(config.appId, config.appSecret);
  const codex = new CodexRunner(config.codexBin, config.codexHome);
  const sync = new SyncService(config, db, feishu, codex);
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
