import assert from "node:assert/strict";
import test from "node:test";
import { NotificationSubscriptions, type SessionReminder } from "../src/claude/notification-subscriptions.js";

const reminder = (sourceSessionId: string, reminderId = "idle-1"): SessionReminder => ({
  reminderId,
  sourceSessionId,
  sourceTitle: `会话 ${sourceSessionId}`,
  sourceAppLink: `https://feishu.example/session/${sourceSessionId}`,
  text: "等待输入",
});

test("disabled by default: reminder is not handled and makes no Feishu call", async () => {
  const calls: unknown[][] = [];
  const router = new NotificationSubscriptions({ async replyText(...args: [string, string]) { calls.push(args); return "om1"; } }, { enabled: false, rootMessageId: "om-subscription-root" });
  assert.deepEqual(await router.deliver(reminder("s1")), { status: "not-handled" });
  assert.deepEqual(calls, []);
});

test("enabled subscription replies in its dedicated topic with source session links", async () => {
  const calls: Array<{ rootMessageId: string; text: string }> = [];
  const router = new NotificationSubscriptions({
    async replyText(rootMessageId, text) { calls.push({ rootMessageId, text }); return `om${calls.length}`; },
  }, { enabled: true, rootMessageId: "om-reminder-root" });

  assert.deepEqual(await router.deliver(reminder("session-A")), { status: "sent", messageId: "om1", attempt: 1 });
  assert.deepEqual(await router.deliver(reminder("session-B")), { status: "sent", messageId: "om2", attempt: 1 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.rootMessageId === "om-reminder-root"));
  assert.match(calls[0]!.text, /源会话：https:\/\/feishu\.example\/session\/session-A/);
  assert.match(calls[1]!.text, /源会话：https:\/\/feishu\.example\/session\/session-B/);
  assert.ok(calls.every((call) => !call.rootMessageId.startsWith("source-")));
});

test("same reminder is deduplicated, but the same reminder id from another source session is distinct", async () => {
  let sends = 0;
  const router = new NotificationSubscriptions({ async replyText() { sends += 1; return `om${sends}`; } }, { enabled: true, rootMessageId: "om-reminder-root" });

  await router.deliver(reminder("session-A", "same-id"));
  assert.deepEqual(await router.deliver(reminder("session-A", "same-id")), { status: "duplicate", messageId: "om1" });
  assert.deepEqual(await router.deliver(reminder("session-B", "same-id")), { status: "sent", messageId: "om2", attempt: 1 });
  assert.equal(sends, 2);
});

test("a failure permits an explicit bounded retry; success then deduplicates", async () => {
  let sends = 0;
  const router = new NotificationSubscriptions({
    async replyText() { sends += 1; if (sends === 1) throw new Error("temporary failure"); return "om-recovered"; },
  }, { enabled: true, rootMessageId: "om-reminder-root" }, { maxAttempts: 2 });

  assert.deepEqual(await router.deliver(reminder("session-A")), { status: "failed", attempt: 1, retryable: true, error: "temporary failure", fallback: "caller-source-session" });
  assert.deepEqual(await router.deliver(reminder("session-A")), { status: "sent", messageId: "om-recovered", attempt: 2 });
  assert.deepEqual(await router.deliver(reminder("session-A")), { status: "duplicate", messageId: "om-recovered" });
  assert.equal(sends, 2);
});

test("a permanently failing reminder stops at the configured attempt limit", async () => {
  let sends = 0;
  const router = new NotificationSubscriptions({ async replyText() { sends += 1; throw new Error("offline"); } }, { enabled: true, rootMessageId: "om-reminder-root" }, { maxAttempts: 2 });

  assert.deepEqual(await router.deliver(reminder("session-A")), { status: "failed", attempt: 1, retryable: true, error: "offline", fallback: "caller-source-session" });
  assert.deepEqual(await router.deliver(reminder("session-A")), { status: "failed", attempt: 2, retryable: false, error: "offline", fallback: "caller-source-session" });
  assert.deepEqual(await router.deliver(reminder("session-A")), { status: "failed", attempt: 2, retryable: false, error: "offline", fallback: "caller-source-session" });
  assert.equal(sends, 2);
});

test("concurrent duplicate calls share one in-flight send", async () => {
  let sends = 0;
  let resolveSend!: (value: string) => void;
  const router = new NotificationSubscriptions({
    replyText() { sends += 1; return new Promise<string>((resolve) => { resolveSend = resolve; }); },
  }, { enabled: true, rootMessageId: "om-reminder-root" });

  const first = router.deliver(reminder("session-A"));
  const second = router.deliver(reminder("session-A"));
  assert.equal(sends, 1);
  resolveSend("om-one");
  assert.deepEqual(await Promise.all([first, second]), [
    { status: "sent", messageId: "om-one", attempt: 1 },
    { status: "sent", messageId: "om-one", attempt: 1 },
  ]);
});
