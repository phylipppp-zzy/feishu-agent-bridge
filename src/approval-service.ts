import type { AppServerLifecycleEvent, JsonRpcMessage } from "./app-server.js";
import type { ApprovalServicePort } from "./bridge-contracts.js";
import type { BridgeDatabase } from "./db.js";
import type { PendingServerRequest, QueuedTask, TaskRootGrant } from "./types.js";

type Resolver = (value: unknown) => void;

export interface ApprovalServiceOptions {
  readonly db: BridgeDatabase;
  readonly onServerRequest: (request: JsonRpcMessage) => Promise<unknown>;
  readonly onResolveAction: (request: PendingServerRequest, decision: string, answers?: readonly string[]) => Promise<void>;
  readonly onRootConsent: (task: QueuedTask) => Promise<TaskRootGrant | null>;
  readonly onConsumeRootGrant: (task: QueuedTask) => Promise<boolean>;
  readonly onExpire: () => Promise<void>;
}

/** Owns transient resolvers; durable approval state remains in BridgeDatabase. */
export class ApprovalService implements ApprovalServicePort {
  private readonly requestResolvers = new Map<string, Resolver>();
  private readonly requestTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: ApprovalServiceOptions) {}

  requestRootConsent(task: QueuedTask): Promise<TaskRootGrant | null> {
    return this.options.onRootConsent(task);
  }

  consumeRootGrant(task: QueuedTask): Promise<boolean> {
    return this.options.onConsumeRootGrant(task);
  }

  handleServerRequest(request: JsonRpcMessage): Promise<unknown> {
    return this.options.onServerRequest(request);
  }

  async resolveAction(nonce: string, decision: string, answers?: readonly string[]): Promise<void> {
    const request = this.options.db.getServerRequest(nonce);
    if (!request) return;
    await this.options.onResolveAction(request, decision, answers);
  }

  /** Registers the waiter before the request can be answered; each request is settled exactly once, through `take`. */
  waitFor(nonce: string): Promise<unknown> {
    return new Promise((resolve) => this.requestResolvers.set(nonce, resolve));
  }

  /** The timeout of a waiting request; cleared when the request is settled any other way. */
  setTimer(nonce: string, timer: NodeJS.Timeout): void {
    if (!this.requestResolvers.has(nonce)) { clearTimeout(timer); return; }
    this.requestTimers.set(nonce, timer);
  }

  take(nonce: string): Resolver | undefined {
    const resolver = this.requestResolvers.get(nonce);
    this.requestResolvers.delete(nonce);
    const timer = this.requestTimers.get(nonce);
    if (timer) clearTimeout(timer);
    this.requestTimers.delete(nonce);
    return resolver;
  }

  pendingCount(): number { return this.requestResolvers.size; }

  async cancelForSession(sessionId: string): Promise<void> {
    for (const request of this.options.db.cancelServerRequestsForSession(sessionId)) {
      this.take(request.nonce)?.({ action: "cancel", decision: "cancel" });
    }
  }

  clear(): void {
    for (const resolver of this.requestResolvers.values()) resolver({ action: "cancel", decision: "cancel" });
    this.requestResolvers.clear();
    for (const timer of this.requestTimers.values()) clearTimeout(timer);
    this.requestTimers.clear();
  }

  expire(): Promise<void> {
    return this.options.onExpire();
  }

  handleLifecycle(_event: AppServerLifecycleEvent): void {
    this.clear();
  }
}
