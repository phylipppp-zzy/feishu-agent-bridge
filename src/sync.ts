import type { FeishuRouterPort } from "./bridge-contracts.js";
import { FeishuRouter } from "./feishu-router.js";
import { CodexAppServer } from "./app-server.js";
import { CodexCliProbe } from "./codex.js";
import { BridgeDatabase } from "./db.js";
import type { BridgeConfig, CardActionOutcome, IncomingBotMenuAction, IncomingCardAction, IncomingFeishuMessage } from "./types.js";
import { SyncRuntime } from "./sync-runtime.js";
export { forbiddenRemoteQuestion } from "./sync-runtime.js";

/** Composition facade retained for index.ts and existing integrations. */
export class SyncService extends SyncRuntime implements FeishuRouterPort {
  private readonly router: FeishuRouter;

  constructor(
    config: BridgeConfig,
    db: BridgeDatabase,
    feishu: import("./types.js").FeishuPort,
    codex: CodexCliProbe,
    appServer?: CodexAppServer,
  ) {
    super(config, db, feishu, codex, appServer);
    this.router = new FeishuRouter({
      // Call the runtime's event-boundary methods directly.  Calling the
      // compatibility aliases would dispatch back through this facade and
      // recurse because the facade owns the same public method names.
      handleMessage: (message) => SyncRuntime.prototype.onFeishuMessage.call(this, message),
      handleCardAction: (action) => SyncRuntime.prototype.onCardAction.call(this, action),
      handleMenuAction: (action) => SyncRuntime.prototype.onBotMenuAction.call(this, action),
    });
  }

  override start(): Promise<void> { return super.start(); }
  override stop(): Promise<void> { return super.stop(); }
  override syncAll(): Promise<void> { return super.syncAll(); }
  onFeishuMessage(message: IncomingFeishuMessage): Promise<void> { return this.router.handleMessage(message); }
  onCardAction(action: IncomingCardAction): Promise<CardActionOutcome> { return this.router.handleCardAction(action); }
  onBotMenuAction(action: IncomingBotMenuAction): Promise<void> { return this.router.handleMenuAction(action); }
  handleMessage(message: IncomingFeishuMessage): Promise<void> { return this.router.handleMessage(message); }
  handleCardAction(action: IncomingCardAction): Promise<CardActionOutcome> { return this.router.handleCardAction(action); }
  handleMenuAction(action: IncomingBotMenuAction): Promise<void> { return this.router.handleMenuAction(action); }
}
