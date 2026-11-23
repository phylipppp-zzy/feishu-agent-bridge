import { randomUUID } from "node:crypto";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { actionRow, button, card, codeBlock, markdown, note, safeMarkdown } from "../card-kit.js";
import type { CardActionOutcome, FeishuPort, IncomingCardAction } from "../types.js";
import { classifyRemoteApprovalRisk, type RemoteApprovalRisk } from "./remote-approval-risk.js";

export const REMOTE_PERMISSION_TIMEOUT_MS = 10 * 60_000;
export const MAX_APPROVAL_INPUT_DISPLAY_BYTES = 8_000;

export interface RemotePermissionRequest {
  sessionId: string;
  rootMessageId: string;
  toolName: string;
  input: unknown;
  openId: string;
  chatId: string;
  title?: string | null;
  reason?: string | null;
}

export interface RemoteApprovalClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RemotePermissionApprovalsOptions {
  clock?: RemoteApprovalClock;
  timeoutMs?: number;
}

export interface RemotePermissionActionResult {
  handled: boolean;
  outcome: CardActionOutcome;
}

type Phase = "single" | "review" | "updating-confirmation" | "confirmation" | "done";

interface PendingApproval {
  requestId: string;
  request: RemotePermissionRequest;
  originalRequest: RemotePermissionRequest;
  input: unknown;
  risk: RemoteApprovalRisk;
  resolve(result: PermissionResult): void;
  signal: AbortSignal;
  abortHandler: () => void;
  timeout: unknown;
  expiresAt: number;
  cardMessageId: string | null;
  phase: Phase;
  nonce: string;
  busy: boolean;
  done: boolean;
}

const DEFAULT_CLOCK: RemoteApprovalClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const NONE: CardActionOutcome = { delivery: "none" };

/** Two-stage, request-scoped Feishu approval; this component never executes a tool. */
export class RemotePermissionApprovals {
  private readonly pending = new Map<string, PendingApproval>();
  /** Old phase nonces map to the live request so replay fails closed. */
  private readonly retiredNonces = new Map<string, PendingApproval>();
  private readonly clock: RemoteApprovalClock;
  private readonly timeoutMs: number;
  private stopped = false;

  constructor(
    private readonly feishu: Pick<FeishuPort, "replyCard" | "updateCard">,
    options: RemotePermissionApprovalsOptions = {},
  ) {
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.timeoutMs = options.timeoutMs ?? REMOTE_PERMISSION_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > REMOTE_PERMISSION_TIMEOUT_MS) {
      throw new Error("timeoutMs must be between 1 and 600000");
    }
  }

  request(request: RemotePermissionRequest, signal: AbortSignal): Promise<PermissionResult> {
    if (this.stopped) return Promise.resolve(denied("审批服务已停止，已拒绝。"));
    if (signal.aborted) return Promise.resolve(denied("请求已取消，已拒绝。"));
    if (!request.sessionId || !request.rootMessageId || !request.toolName || !request.openId || !request.chatId) {
      return Promise.resolve(denied("审批请求信息不完整，已拒绝。"));
    }
    if (!isRecord(request.input)) return Promise.resolve(denied("工具参数不是可验证对象，已拒绝。"));

    let input: unknown;
    let risk: RemoteApprovalRisk;
    let display: string;
    try {
      input = structuredClone(request.input);
      risk = classifyRemoteApprovalRisk(request.toolName, input);
      display = renderInput(input);
    } catch {
      return Promise.resolve(denied("工具参数无法安全核验，请回到电脑处理。"));
    }
    if (Buffer.byteLength(display, "utf8") > MAX_APPROVAL_INPUT_DISPLAY_BYTES) {
      return Promise.resolve(denied("工具参数过长，手机无法完整核对；本次已拒绝，请回到电脑处理。"));
    }
    if (display.includes("[redacted]")) {
      return Promise.resolve(denied("工具参数包含隐藏的敏感字段，手机无法完整核对；本次已拒绝，请回到电脑处理。"));
    }
    const requestId = randomUUID();
    const nonce = randomUUID();
    const expiresAt = this.clock.now() + this.timeoutMs;
    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingApproval = {
        requestId, request: { ...request }, originalRequest: request, input, risk, resolve, signal, abortHandler: () => undefined,
        timeout: undefined, expiresAt, cardMessageId: null, phase: risk.needsSecondConfirmation ? "review" : "single",
        nonce, busy: false, done: false,
      };
      pending.abortHandler = () => this.finish(pending, denied("请求已取消，已拒绝。"));
      this.pending.set(requestId, pending);
      signal.addEventListener("abort", pending.abortHandler, { once: true });
      pending.timeout = this.clock.setTimeout(() => this.finish(pending, denied("审批等待超过10分钟，已拒绝。")), this.timeoutMs);
      void this.postInitialCard(pending);
    });
  }

  async handleAction(event: IncomingCardAction): Promise<RemotePermissionActionResult> {
    const rawNonce = event.value.nonce;
    const nonce = typeof rawNonce === "string" ? rawNonce : "";
    const current = [...this.pending.values()].find((item) => item.nonce === nonce);
    const pending = current ?? this.retiredNonces.get(nonce) ?? [...this.pending.values()].find((item) => item.cardMessageId === event.openMessageId);
    if (!pending) return { handled: false, outcome: NONE };
    if (pending.done) return { handled: true, outcome: { delivery: "toast", text: "这个审批请求已结束。", level: "info" } };

    if (this.clock.now() >= pending.expiresAt) {
      this.finish(pending, denied("审批已超时，已拒绝。"));
      return { handled: true, outcome: expiredOutcome() };
    }
    if (event.openId !== pending.request.openId || event.chatId !== pending.request.chatId || event.value.requestId !== pending.requestId
      || event.value.sessionId !== pending.request.sessionId
      || !pending.cardMessageId || event.openMessageId !== pending.cardMessageId) {
      this.finish(pending, denied("审批人、群聊或审批卡片不匹配，已拒绝。"));
      return { handled: true, outcome: expiredOutcome() };
    }
    if (pending.busy) {
      this.finish(pending, denied("重复或并发审批操作，已拒绝。"));
      return { handled: true, outcome: expiredOutcome() };
    }
    let inputStillMatches = false;
    try {
      inputStillMatches = classifyRemoteApprovalRisk(pending.request.toolName, pending.input).inputDigest === pending.risk.inputDigest
        && classifyRemoteApprovalRisk(pending.originalRequest.toolName, pending.originalRequest.input).inputDigest === pending.risk.inputDigest;
    } catch { /* mutated or non-serializable input fails closed */ }
    if (nonce !== pending.nonce || typeof event.value.inputDigest !== "string" || event.value.inputDigest !== pending.risk.inputDigest || !inputStillMatches) {
      this.finish(pending, denied("审批内容已变化或旧卡片已失效，已拒绝。"));
      return { handled: true, outcome: expiredOutcome() };
    }

    const action = event.action;
    if (action === "remote_permission_deny") {
      this.finish(pending, denied("已拒绝这个工具请求。"));
      return { handled: true, outcome: toastOutcome("已拒绝。") };
    }

    if (pending.phase === "single" && action === "remote_permission_allow") {
      pending.busy = true;
      this.finish(pending, allowed(pending.input));
      return { handled: true, outcome: toastOutcome("已允许这次工具请求。") };
    }
    if (pending.phase === "review" && action === "remote_permission_review") {
      pending.busy = true;
      const oldNonce = pending.nonce;
      this.retiredNonces.set(oldNonce, pending);
      pending.nonce = randomUUID();
      pending.phase = "updating-confirmation";
      try {
        await this.feishu.updateCard(pending.cardMessageId, approvalCard(pending, "confirmation"));
        if (pending.done) return { handled: true, outcome: expiredOutcome() };
        pending.phase = "confirmation";
        pending.busy = false;
        return { handled: true, outcome: toastOutcome("已进入第二步。核对完整内容后再明确允许；第一步没有批准执行。") };
      } catch {
        this.finish(pending, denied("无法更新第二步审批卡，已拒绝。"));
        return { handled: true, outcome: expiredOutcome() };
      }
    }
    if (pending.phase === "confirmation" && action === "remote_permission_confirm") {
      pending.busy = true;
      this.finish(pending, allowed(pending.input));
      return { handled: true, outcome: toastOutcome("已明确允许这次工具请求。") };
    }

    // Includes allow_session and actions that do not belong to this phase.
    this.finish(pending, denied("审批操作不符合当前阶段，已拒绝。"));
    return { handled: true, outcome: expiredOutcome() };
  }

  async cancelSession(sessionId: string, message = "会话已结束，审批请求已拒绝。"): Promise<void> {
    for (const pending of [...this.pending.values()]) if (pending.request.sessionId === sessionId) this.finish(pending, denied(message));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of [...this.pending.values()]) this.finish(pending, denied("审批服务已停止，已拒绝。"));
  }

  get pendingCount(): number { return this.pending.size; }
  hasSession(sessionId: string): boolean { return [...this.pending.values()].some((pending) => pending.request.sessionId === sessionId); }

  private async postInitialCard(pending: PendingApproval): Promise<void> {
    try {
      const messageId = await this.feishu.replyCard(pending.request.rootMessageId, approvalCard(pending, "initial"));
      pending.cardMessageId = messageId;
      if (pending.done) void this.updateTerminalCard(pending, "审批已拒绝", "请求已结束或服务停止。", "grey");
    } catch {
      this.finish(pending, denied("无法在飞书中显示审批卡，已拒绝。"));
    }
  }

  private finish(pending: PendingApproval, result: PermissionResult): void {
    if (pending.done) return;
    pending.done = true;
    pending.phase = "done";
    this.clock.clearTimeout(pending.timeout);
    pending.signal.removeEventListener("abort", pending.abortHandler);
    this.pending.delete(pending.requestId);
    this.retiredNonces.delete(pending.nonce);
    for (const [nonce, owner] of this.retiredNonces) if (owner === pending) this.retiredNonces.delete(nonce);
    pending.resolve(result);
    if (pending.cardMessageId) {
      const isAllowed = result.behavior === "allow";
      void this.updateTerminalCard(pending, isAllowed ? "已允许" : "已拒绝", isAllowed ? "仅允许本次请求；没有创建会话级许可。" : result.behavior === "deny" ? result.message ?? "请求已拒绝。" : "请求已结束。", isAllowed ? "green" : "grey");
    }
  }

  private async updateTerminalCard(pending: PendingApproval, title: string, detail: string, template: "green" | "grey"): Promise<void> {
    if (!pending.cardMessageId) return;
    await this.feishu.updateCard(pending.cardMessageId, card(title, template, [note(safeMarkdown(detail))])).catch(() => undefined);
  }
}

function approvalCard(pending: PendingApproval, stage: "initial" | "confirmation") {
  const { request, risk } = pending;
  const high = risk.needsSecondConfirmation;
  const data = { nonce: pending.nonce, inputDigest: risk.inputDigest, requestId: pending.requestId, sessionId: request.sessionId };
  const detail = renderInput(pending.input);
  return card(
    high ? `工具审批 · ${stage === "initial" ? "先核对" : "最终确认"}` : "工具审批",
    high ? "orange" : "blue",
    [
      markdown(`**${safeMarkdown(request.toolName)}**${request.title ? `\n${safeMarkdown(request.title)}` : ""}`),
      note(`风险级别：${risk.riskLevel}。${safeMarkdown(risk.reasons.join("；"))}`),
      ...(request.reason ? [note(`请求原因：${safeMarkdown(request.reason)}`)] : []),
      markdown(codeBlock(detail, MAX_APPROVAL_INPUT_DISPLAY_BYTES)),
      actionRow(stage === "confirmation"
        ? [button("明确允许本次", "remote_permission_confirm", "danger", data), button("拒绝", "remote_permission_deny", "default", data)]
        : high
          ? [button("继续核对", "remote_permission_review", "primary", data), button("拒绝", "remote_permission_deny", "danger", data)]
          : [button("允许本次", "remote_permission_allow", "primary", data), button("拒绝", "remote_permission_deny", "danger", data)]),
      note(stage === "confirmation" ? "第二步确认绑定当前参数；任何参数变化都要重新审批。" : high ? "第一步不会执行工具；继续后会显示新的最终确认卡。" : "仅批准当前这一次调用，不会创建会话级许可。"),
    ],
  );
}

function renderInput(input: unknown): string {
  let text: string;
  try { text = JSON.stringify(input, (key, value: unknown) => /(?:secret|token|password|credential|authorization|api[_-]?key)/i.test(key) ? "[redacted]" : value, 2); }
  catch { text = "[输入无法安全显示]"; }
  return text.replace(/(authorization|cookie|token|password|secret|api[_-]?key|credential)(\s*[:=]\s*)([^\s,"'}]+)/gi, "$1$2[redacted]");
}

function allowed(input: unknown): PermissionResult {
  return { behavior: "allow", updatedInput: structuredClone(input) as Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function denied(message: string): PermissionResult { return { behavior: "deny", message }; }
function toastOutcome(text: string): CardActionOutcome { return { delivery: "toast", text, level: "info" }; }
function expiredOutcome(): CardActionOutcome { return { delivery: "toast", text: "审批请求已结束或拒绝。", level: "warning" }; }
