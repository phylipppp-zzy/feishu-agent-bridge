import { notificationTurnId, type AppServerLifecycleEvent, type JsonRpcMessage } from "./app-server.js";
import type { TurnCoordinatorPort } from "./bridge-contracts.js";
import type { QueuedTask, TurnState } from "./types.js";

export interface TurnCoordinatorOptions {
  readonly executeTask: (task: QueuedTask) => Promise<void>;
  readonly interruptTurn: (sessionId: string, turnId: string) => Promise<void>;
  readonly onNotification: (event: JsonRpcMessage) => Promise<void>;
  readonly onLifecycle: (event: AppServerLifecycleEvent) => Promise<void>;
}

/** Owns active turns and serializes app-server notifications per turn. */
export class TurnCoordinator implements TurnCoordinatorPort {
  private readonly activeTurns = new Map<string, TurnState>();
  private readonly notificationQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: TurnCoordinatorOptions) {}

  execute(task: QueuedTask): Promise<void> {
    return this.options.executeTask(task);
  }

  interrupt(sessionId: string, turnId: string): Promise<void> {
    return this.options.interruptTurn(sessionId, turnId);
  }

  async handleLifecycle(event: AppServerLifecycleEvent): Promise<void> {
    await this.options.onLifecycle(event);
  }

  handleNotification(event: JsonRpcMessage): Promise<void> {
    const params = event.params && typeof event.params === "object" ? event.params : {};
    const sessionId = this.stringAt(params, "threadId", "thread_id") ?? "unscoped";
    const turnId = notificationTurnId(params) ?? "none";
    const key = `${sessionId}:${turnId}`;
    const previous = this.notificationQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.options.onNotification(event));
    this.notificationQueues.set(key, next);
    const cleanup = () => {
      if (this.notificationQueues.get(key) === next) this.notificationQueues.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  activeTurn(sessionId: string): Readonly<TurnState> | null {
    return this.activeTurns.get(sessionId) ?? null;
  }

  mutableTurn(sessionId: string): TurnState | null { return this.activeTurns.get(sessionId) ?? null; }

  hasActiveTurn(sessionId: string): boolean { return this.activeTurns.has(sessionId); }
  activeCount(): number { return this.activeTurns.size; }
  sessionIds(): string[] { return [...this.activeTurns.keys()]; }
  states(): TurnState[] { return [...this.activeTurns.values()]; }
  setTurn(state: TurnState): void { this.activeTurns.set(state.sessionId, state); }
  deleteTurn(sessionId: string): void { this.activeTurns.delete(sessionId); }
  clearTurns(): void { this.activeTurns.clear(); }

  private stringAt(value: Record<string, unknown>, ...keys: string[]): string | null {
    for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
    return null;
  }
}
