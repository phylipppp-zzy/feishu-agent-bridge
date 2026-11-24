import type { UnifiedCore } from './service.js';
import type { UnifiedStore } from './store.js';
import type { FeishuChannel } from './feishu-channel.js';
import type { TaskTopicChannel } from './task-topic-channel.js';
import type { PendingHub } from './pending-hub.js';
import type { ResolveInteraction } from './contracts.js';

export type InboxTarget =
  | { kind: 'channel'; destination: string }
  | { kind: 'task'; taskId: string };

interface Work {
  done: Promise<void>;
  dirty: boolean;
}

/** The inbox commit is the ACK boundary. This scheduler only consumes durable work. */
export class RuntimeInteractive {
  private readonly active = new Map<string, Work>();
  private readonly syncs = new Map<string, Promise<void>>();
  private closed = false;
  private failed = false;

  constructor(
    private readonly core: UnifiedCore,
    private readonly store: UnifiedStore,
    private readonly channel: FeishuChannel,
    private readonly taskChannel?: TaskTopicChannel,
    private readonly pendingHub?: PendingHub,
    private readonly onError?: () => void,
    private readonly requireReadonlyHydration = false,
  ) {}

  notifyInbox(target: InboxTarget): void {
    const channel = target.kind === 'channel' ? this.channel : this.taskChannel;
    if (!channel) return;
    const id = target.kind === 'channel' ? target.destination : target.taskId;
    this.start(`inbox:${target.kind}:${id}`, async () => {
      for (const eventId of channel.pendingInbox(id)) {
        try {
          await channel.drain(eventId);
          // drain has released its destination lock. Finish may acquire it again.
          const op = channel.operationForEvent(eventId);
          if (op) this.notifyOperation(op.operationId);
        } catch {
          this.reportFailure();
        }
      }
    });
  }

  recoverInbox(): void {
    for (const destination of this.channel.pendingInboxDestinations()) {
      this.notifyInbox({ kind: 'channel', destination });
    }
    for (const taskId of this.taskChannel?.pendingInboxTasks() ?? []) {
      this.notifyInbox({ kind: 'task', taskId });
    }
  }

  hasOperation(id: string): boolean {
    return this.active.has(`operation:${id}`);
  }

  notifyOperation(operationId: string): void {
    this.start(`operation:${operationId}`, async () => {
      const out = this.store.hasPendingOutbox(operationId) ? this.store.getOutbox(operationId) : null;
      const answer = out?.kind === 'resolveInteraction' ? out.payload as ResolveInteraction : null;
      if (out) {
        try {
          await this.core.dispatch(operationId);
        } catch (error) {
          const code = (error as { detail?: { code?: string } } | null)?.detail?.code;
          if (code === 'busy' || code === 'outcome_unknown') return;
          if (code === 'temporarily_unavailable') this.store.failUnreboundPending([operationId]);
          else throw error;
        } finally {
          if (answer) this.notifyInteraction(answer.context.targetId, answer.interactionId);
        }
      }
      const child = await this.channel.advanceOperation(operationId);
      if (child && child.operationId !== operationId) this.notifyOperation(child.operationId);
    });
  }

  notifyInteraction(sessionId: string, interactionId: string): void {
    this.start(`interaction:${interactionId}`, async () => {
      const deliveries: Promise<void>[] = [];
      for (const destination of this.channel.destinationsForSession(sessionId)) {
        if (this.requireReadonlyHydration && this.channel.accessMode(destination) === 'read_only'
          && !this.channel.readonlyHydrated(destination, sessionId)) continue;
        deliveries.push(this.channel.refreshInteraction(destination, sessionId, interactionId));
      }
      const results = await Promise.allSettled([
        ...deliveries,
        this.taskChannel?.refreshInteraction(sessionId, interactionId),
        this.pendingHub?.refreshInteractionRef(interactionId),
      ]);
      if (results.some(result => result.status === 'rejected')) this.reportFailure();
    });
  }

  notifyDecision(decisionId: string): void {
    this.start(`decision:${decisionId}`, async () => { await this.pendingHub?.refreshDecisionRef(decisionId); });
  }

  notifySession(sessionId: string, retryPending: boolean): void {
    if (retryPending) {
      for (const id of this.store.pendingOutbox(sessionId)) this.notifyOperation(id);
    }
    for (const destination of this.channel.destinationsForSession(sessionId)) {
      this.start(`target:channel:${destination}`, async () => {
        const current = this.syncs.get(`channel:${destination}`);
        if (current) await current;
        if (this.requireReadonlyHydration && this.channel.accessMode(destination) === 'read_only'
          && !this.channel.readonlyHydrated(destination, sessionId)) return;
        await this.syncChannel(destination);
      });
    }
    for (const taskId of this.taskChannel?.tasksForSession(sessionId) ?? []) {
      this.start(`target:task:${taskId}`, async () => {
        await this.syncs.get(`task:${taskId}`);
        await this.syncTask(taskId);
      });
    }
  }

  syncChannel(destination: string): Promise<void> {
    return this.sync(`channel:${destination}`, async () => {
      try {
        await this.channel.sync(destination);
      } catch (error) {
        if (!(error instanceof Error && error.message === 'destination is not bound')) throw error;
      }
    });
  }

  syncTask(taskId: string): Promise<void> {
    return this.sync(`task:${taskId}`, async () => {
      const result = await this.taskChannel?.syncTask(taskId);
      if (result?.failedTargets.length) throw new Error('task target sync failed');
    });
  }

  private sync(key: string, run: () => Promise<void>): Promise<void> {
    const previous = this.syncs.get(key);
    if (previous) return previous;
    const next = run().finally(() => this.syncs.delete(key));
    this.syncs.set(key, next);
    return next;
  }

  private reportFailure(): void {
    this.failed = true;
    this.onError?.();
  }

  private start(key: string, run: () => Promise<void>): void {
    if (this.closed) return;
    const existing = this.active.get(key);
    if (existing) {
      existing.dirty = true;
      return;
    }
    // Yield beyond the callback's persisted ACK before consuming the event.
    const work: Work = { dirty: true, done: Promise.resolve() };
    work.done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      try {
        while (work.dirty) {
          work.dirty = false;
          await run();
        }
      } catch {
        this.reportFailure();
      } finally {
        this.active.delete(key);
      }
    });
    this.active.set(key, work);
  }

  async flushInteractive(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()].map(work => work.done));
    if (this.failed) {
      this.failed = false;
      throw new Error('interactive work failed');
    }
  }

  async close(): Promise<void> {
    try {
      await this.flushInteractive();
    } finally {
      this.closed = true;
    }
  }
}
