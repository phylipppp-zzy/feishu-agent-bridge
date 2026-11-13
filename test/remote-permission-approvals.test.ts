import assert from "node:assert/strict";
import test from "node:test";
import { RemotePermissionApprovals, REMOTE_PERMISSION_TIMEOUT_MS, type RemoteApprovalClock } from "../src/claude/remote-permission-approvals.js";
import type { CardDefinition, IncomingCardAction } from "../src/types.js";

type Button = { action: string; value: Record<string, unknown> };

class FakeFeishu {
  readonly cards = new Map<string, CardDefinition>();
  readonly updates: Array<{ messageId: string; card: CardDefinition }> = [];
  private nextId = 0;
  async replyCard(_rootMessageId: string, card: CardDefinition): Promise<string> {
    const id = `approval-card-${++this.nextId}`;
    this.cards.set(id, card);
    return id;
  }
  async updateCard(messageId: string, card: CardDefinition): Promise<void> {
    this.updates.push({ messageId, card });
    this.cards.set(messageId, card);
  }
}

function buttons(card: CardDefinition): Button[] {
  const result: Button[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.tag === "button") {
      const v1 = record.value;
      if (v1 && typeof v1 === "object") {
        const action = (v1 as Record<string, unknown>).action;
        if (typeof action === "string") result.push({ action, value: v1 as Record<string, unknown> });
      }
      const behaviors = record.behaviors;
      if (Array.isArray(behaviors)) for (const behavior of behaviors) {
        const candidate = (behavior as { value?: unknown }).value;
        if (candidate && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).action === "string") {
          result.push({ action: (candidate as Record<string, unknown>).action as string, value: candidate as Record<string, unknown> });
        }
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(card);
  return result;
}

function action(messageId: string, button: Button, overrides: Partial<IncomingCardAction> = {}): IncomingCardAction {
  return {
    eventId: `event-${Math.random()}`, openId: "open-user", chatId: "chat-bound", openMessageId: messageId,
    action: button.action, value: { ...button.value }, formValues: {}, ...overrides,
  };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-a", rootMessageId: "root-a", toolName: "Bash", input: { command: "git push origin main" },
    openId: "open-user", chatId: "chat-bound", ...overrides,
  } as Parameters<RemotePermissionApprovals["request"]>[0];
}

class FakeClock implements RemoteApprovalClock {
  current = 1_000;
  readonly timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  now(): number { return this.current; }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const timer = { callback, delayMs, cleared: false };
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(handle: unknown): void { if (handle && typeof handle === "object") (handle as { cleared: boolean }).cleared = true; }
  advance(ms: number): void {
    this.current += ms;
    for (const timer of this.timers) if (!timer.cleared && ms >= timer.delayMs) { timer.cleared = true; timer.callback(); }
  }
}

test("high-risk first card cannot allow; second card has a new nonce and explicit confirmation", async () => {
  const feishu = new FakeFeishu();
  const approvals = new RemotePermissionApprovals(feishu);
  let result: unknown;
  const promise = approvals.request(baseRequest(), new AbortController().signal).then((value) => { result = value; return value; });
  await waitFor(() => feishu.cards.size === 1);
  const [messageId] = [...feishu.cards.keys()];
  const firstButtons = buttons(feishu.cards.get(messageId!)!);
  assert.deepEqual(firstButtons.map((item) => item.action).sort(), ["remote_permission_deny", "remote_permission_review"]);
  assert.equal(firstButtons.some((item) => item.action.includes("allow_session")), false);

  const firstReview = firstButtons.find((item) => item.action === "remote_permission_review")!;
  const transition = await approvals.handleAction(action(messageId!, firstReview));
  assert.equal(transition.handled, true);
  assert.equal(result, undefined);
  const secondButtons = buttons(feishu.cards.get(messageId!)!);
  const confirm = secondButtons.find((item) => item.action === "remote_permission_confirm")!;
  assert.notEqual(confirm.value.nonce, firstReview.value.nonce);
  assert.equal(confirm.value.inputDigest, firstReview.value.inputDigest);
  const approved = await approvals.handleAction(action(messageId!, confirm));
  assert.equal(approved.handled, true);
  assert.deepEqual(await promise, { behavior: "allow", updatedInput: { command: "git push origin main" } });
});

test("replaying the old first-stage nonce during final confirmation denies instead of approving", async () => {
  const feishu = new FakeFeishu();
  const approvals = new RemotePermissionApprovals(feishu);
  const promise = approvals.request(baseRequest(), new AbortController().signal);
  await waitFor(() => feishu.cards.size === 1);
  const [messageId] = [...feishu.cards.keys()];
  const firstReview = buttons(feishu.cards.get(messageId!)!).find((item) => item.action === "remote_permission_review")!;
  await approvals.handleAction(action(messageId!, firstReview));
  const replay = await approvals.handleAction(action(messageId!, firstReview));
  assert.equal(replay.handled, true);
  assert.equal((await promise).behavior, "deny");
});

test("low-risk request is single-step and returns a cloned one-call input", async () => {
  const feishu = new FakeFeishu();
  const approvals = new RemotePermissionApprovals(feishu);
  const input = { file_path: "README.md" };
  const promise = approvals.request(baseRequest({ toolName: "Read", input }), new AbortController().signal);
  await waitFor(() => feishu.cards.size === 1);
  const [messageId] = [...feishu.cards.keys()];
  const available = buttons(feishu.cards.get(messageId!)!);
  assert.deepEqual(available.map((item) => item.action).sort(), ["remote_permission_allow", "remote_permission_deny"]);
  const allow = available.find((item) => item.action === "remote_permission_allow")!;
  await approvals.handleAction(action(messageId!, allow));
  assert.deepEqual(await promise, { behavior: "allow", updatedInput: { file_path: "README.md" } });
});

test("caller parameter mutation after card creation denies the original request", async () => {
  const feishu = new FakeFeishu();
  const approvals = new RemotePermissionApprovals(feishu);
  const input = { file_path: "README.md" };
  const request = baseRequest({ toolName: "Read", input });
  const promise = approvals.request(request, new AbortController().signal);
  await waitFor(() => feishu.cards.size === 1);
  const [messageId] = [...feishu.cards.keys()];
  const allow = buttons(feishu.cards.get(messageId!)!).find((item) => item.action === "remote_permission_allow")!;
  input.file_path = "../../.ssh/id_rsa";
  await approvals.handleAction(action(messageId!, allow));
  assert.deepEqual(await promise, { behavior: "deny", message: "审批内容已变化或旧卡片已失效，已拒绝。" });
});

test("input too large to display in full is denied with a return-to-computer instruction", async () => {
  const feishu = new FakeFeishu();
  const approvals = new RemotePermissionApprovals(feishu);
  const result = await approvals.request(baseRequest({ input: { command: `git push origin ${"x".repeat(12_000)}` } }), new AbortController().signal);
  assert.deepEqual(result, { behavior: "deny", message: "工具参数过长，手机无法完整核对；本次已拒绝，请回到电脑处理。" });
  assert.equal(feishu.cards.size, 0);
  assert.equal(approvals.pendingCount, 0);
});

test("sensitive values hidden from the card are not eligible for mobile approval", async () => {
  const feishu = new FakeFeishu();
  const approvals = new RemotePermissionApprovals(feishu);
  const result = await approvals.request(baseRequest({ input: { command: "node deploy.js", api_token: "secret-value" } }), new AbortController().signal);
  assert.deepEqual(result, { behavior: "deny", message: "工具参数包含隐藏的敏感字段，手机无法完整核对；本次已拒绝，请回到电脑处理。" });
  assert.equal(feishu.cards.size, 0);
});

test("mutated confirmation digest and forged allow_session both deny", async () => {
  const feishu = new FakeFeishu();
  const approvals = new RemotePermissionApprovals(feishu);
  const promise = approvals.request(baseRequest(), new AbortController().signal);
  await waitFor(() => feishu.cards.size === 1);
  const [messageId] = [...feishu.cards.keys()];
  const review = buttons(feishu.cards.get(messageId!)!).find((item) => item.action === "remote_permission_review")!;
  await approvals.handleAction(action(messageId!, review));
  const confirm = buttons(feishu.cards.get(messageId!)!).find((item) => item.action === "remote_permission_confirm")!;
  const changed = action(messageId!, confirm);
  changed.value.inputDigest = "0".repeat(64);
  await approvals.handleAction(changed);
  assert.equal((await promise).behavior, "deny");

  const second = new FakeFeishu();
  const secondApprovals = new RemotePermissionApprovals(second);
  const secondPromise = secondApprovals.request(baseRequest(), new AbortController().signal);
  await waitFor(() => second.cards.size === 1);
  const [secondMessage] = [...second.cards.keys()];
  const secondReview = buttons(second.cards.get(secondMessage!)!).find((item) => item.action === "remote_permission_review")!;
  const forged = action(secondMessage!, secondReview, { action: "perm_always" });
  await secondApprovals.handleAction(forged);
  assert.equal((await secondPromise).behavior, "deny");
});

test("wrong operator, chat, card, or request id fails closed", async () => {
  for (const overrides of [
    { openId: "other-user" },
    { chatId: "other-chat" },
    { openMessageId: "other-card" },
  ]) {
    const feishu = new FakeFeishu();
    const approvals = new RemotePermissionApprovals(feishu);
    const promise = approvals.request(baseRequest({ toolName: "Read", input: { file_path: "README.md" } }), new AbortController().signal);
    await waitFor(() => feishu.cards.size === 1);
    const [messageId] = [...feishu.cards.keys()];
    const allow = buttons(feishu.cards.get(messageId!)!).find((item) => item.action === "remote_permission_allow")!;
    await approvals.handleAction(action(messageId!, allow, overrides));
    assert.equal((await promise).behavior, "deny");
  }

  const feishu = new FakeFeishu();
  const approvals = new RemotePermissionApprovals(feishu);
  const promise = approvals.request(baseRequest({ toolName: "Read", input: { file_path: "README.md" } }), new AbortController().signal);
  await waitFor(() => feishu.cards.size === 1);
  const [messageId] = [...feishu.cards.keys()];
  const allow = buttons(feishu.cards.get(messageId!)!).find((item) => item.action === "remote_permission_allow")!;
  const wrongId = action(messageId!, allow);
  wrongId.value.requestId = "different-request";
  await approvals.handleAction(wrongId);
  assert.equal((await promise).behavior, "deny");
});

test("two request scopes cannot approve one another", async () => {
  const feishu = new FakeFeishu();
  const approvals = new RemotePermissionApprovals(feishu);
  const firstPromise = approvals.request(baseRequest({ sessionId: "session-a", rootMessageId: "root-a", toolName: "Read", input: { file_path: "A.md" } }), new AbortController().signal);
  const secondPromise = approvals.request(baseRequest({ sessionId: "session-b", rootMessageId: "root-b", toolName: "Read", input: { file_path: "B.md" } }), new AbortController().signal);
  assert.equal(approvals.hasSession("session-a"), true);
  assert.equal(approvals.hasSession("session-b"), true);
  assert.equal(approvals.hasSession("session-c"), false);
  await waitFor(() => feishu.cards.size === 2);
  const [firstId, secondId] = [...feishu.cards.keys()];
  const firstAllow = buttons(feishu.cards.get(firstId!)!).find((item) => item.action === "remote_permission_allow")!;
  const secondAllow = buttons(feishu.cards.get(secondId!)!).find((item) => item.action === "remote_permission_allow")!;
  await approvals.handleAction(action(firstId!, secondAllow));
  assert.equal((await secondPromise).behavior, "deny");
  assert.equal(approvals.hasSession("session-b"), false);
  assert.equal(approvals.pendingCount, 1);
  await approvals.handleAction(action(firstId!, firstAllow));
  assert.deepEqual(await firstPromise, { behavior: "allow", updatedInput: { file_path: "A.md" } });
});

test("fake clock timeout at ten minutes denies at the exact boundary", async () => {
  const feishu = new FakeFeishu();
  const clock = new FakeClock();
  const approvals = new RemotePermissionApprovals(feishu, { clock });
  const promise = approvals.request(baseRequest(), new AbortController().signal);
  await waitFor(() => feishu.cards.size === 1);
  assert.equal(clock.timers[0]!.delayMs, REMOTE_PERMISSION_TIMEOUT_MS);
  clock.advance(REMOTE_PERMISSION_TIMEOUT_MS);
  assert.deepEqual(await promise, { behavior: "deny", message: "审批等待超过10分钟，已拒绝。" });
  assert.equal(approvals.pendingCount, 0);
});

test("abort, cancelSession, and stop deny only their matching pending approvals", async () => {
  const feishu = new FakeFeishu();
  const approvals = new RemotePermissionApprovals(feishu);
  const controller = new AbortController();
  const first = approvals.request(baseRequest({ sessionId: "session-abort", toolName: "Read", input: { file_path: "A.md" } }), controller.signal);
  const second = approvals.request(baseRequest({ sessionId: "session-cancel", toolName: "Read", input: { file_path: "B.md" } }), new AbortController().signal);
  await waitFor(() => feishu.cards.size === 2);
  controller.abort();
  assert.equal((await first).behavior, "deny");
  await approvals.cancelSession("session-cancel", "cancelled");
  assert.deepEqual(await second, { behavior: "deny", message: "cancelled" });

  const third = approvals.request(baseRequest({ toolName: "Read", input: { file_path: "C.md" } }), new AbortController().signal);
  await waitFor(() => feishu.cards.size === 3);
  await approvals.stop();
  assert.equal((await third).behavior, "deny");
  assert.equal((await approvals.request(baseRequest(), new AbortController().signal)).behavior, "deny");
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
