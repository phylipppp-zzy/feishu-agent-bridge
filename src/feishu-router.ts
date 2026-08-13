import type { FeishuRouterPort } from "./bridge-contracts.js";
import type { CardActionOutcome, IncomingBotMenuAction, IncomingCardAction, IncomingFeishuMessage } from "./types.js";

/** Stable Feishu-facing routing port. Business modules are hidden behind this seam. */
export class FeishuRouter implements FeishuRouterPort {
  constructor(private readonly target: FeishuRouterPort) {}

  handleMessage(message: IncomingFeishuMessage): Promise<void> {
    return this.target.handleMessage(message);
  }

  handleCardAction(action: IncomingCardAction): Promise<CardActionOutcome> {
    return this.target.handleCardAction(action);
  }

  handleMenuAction(action: IncomingBotMenuAction): Promise<void> {
    return this.target.handleMenuAction(action);
  }
}
