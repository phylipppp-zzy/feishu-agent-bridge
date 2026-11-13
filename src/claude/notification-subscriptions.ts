import type { FeishuPort } from "../types.js";

/** Explicit opt-in destination for Claude reminders. Omit this option to preserve legacy routing. */
export interface NotificationSubscription {
  enabled: boolean;
  /** Root message id of the dedicated subscription topic; created/persisted by the integration layer. */
  rootMessageId: string;
}

export interface SessionReminder {
  /** Stable reminder identity (for example session id + event kind + event timestamp). */
  reminderId: string;
  sourceSessionId: string;
  sourceTitle: string;
  sourceAppLink: string | null;
  text: string;
}

export type ReminderDelivery =
  | { status: "not-handled" }
  | { status: "sent"; messageId: string; attempt: number }
  | { status: "duplicate"; messageId: string }
  | { status: "failed"; attempt: number; retryable: boolean; error: string; fallback: "caller-source-session" };

export interface NotificationSubscriptionOptions {
  /** Number of explicit calls permitted for one reminder. Retries are never scheduled automatically. */
  maxAttempts?: number;
}

type Entry =
  | { status: "sending"; attempt: number; pending: Promise<ReminderDelivery> }
  | { status: "sent"; messageId: string; attempt: number }
  | { status: "failed"; attempt: number; error: string };

/**
 * Routes only reminder events to the separately configured subscription topic. Ordinary inbound
 * messages never enter this component. The ledger prevents concurrent and repeated sends in this
 * process; a future DB adapter can persist the same reminder key/status across restarts.
 */
export class NotificationSubscriptions {
  private readonly ledger = new Map<string, Entry>();
  private readonly maxAttempts: number;

  constructor(
    private readonly feishu: Pick<FeishuPort, "replyText">,
    private readonly subscription: NotificationSubscription,
    options: NotificationSubscriptionOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 2;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
  }

  async deliver(reminder: SessionReminder): Promise<ReminderDelivery> {
    if (!this.subscription.enabled) return { status: "not-handled" };
    if (!this.subscription.rootMessageId.trim()) throw new Error("enabled notification subscription requires rootMessageId");
    if (!reminder.reminderId.trim() || !reminder.sourceSessionId.trim()) {
      throw new Error("reminderId and sourceSessionId are required");
    }

    const key = JSON.stringify([reminder.sourceSessionId, reminder.reminderId]);
    const previous = this.ledger.get(key);
    if (previous?.status === "sent") return { status: "duplicate", messageId: previous.messageId };
    if (previous?.status === "sending") return previous.pending;
    const attempt = (previous?.attempt ?? 0) + 1;
    if (attempt > this.maxAttempts) {
      return { status: "failed", attempt: previous!.attempt, retryable: false, error: previous!.error, fallback: "caller-source-session" };
    }

    const text = renderReminder(reminder);
    const pending = this.feishu.replyText(this.subscription.rootMessageId, text).then<ReminderDelivery, ReminderDelivery>((messageId) => {
      this.ledger.set(key, { status: "sent", messageId, attempt });
      return { status: "sent", messageId, attempt };
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.ledger.set(key, { status: "failed", attempt, error: message });
      return { status: "failed", attempt, retryable: attempt < this.maxAttempts, error: message, fallback: "caller-source-session" };
    });
    this.ledger.set(key, { status: "sending", attempt, pending });
    return pending;
  }
}

/** Plain text keeps the source link visible and clickable in the dedicated Feishu topic. */
export function renderReminder(reminder: SessionReminder): string {
  const source = reminder.sourceAppLink?.trim();
  return [
    `【会话提醒】${reminder.sourceTitle.trim() || reminder.sourceSessionId}`,
    reminder.text.trim(),
    `源会话：${source || `session:${reminder.sourceSessionId}`}`,
  ].join("\n\n");
}
