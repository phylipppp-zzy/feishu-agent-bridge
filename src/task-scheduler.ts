import type { BridgeDatabase } from "./db.js";
import type { CancellationScope, TaskExecutor, TaskSchedulerPort } from "./bridge-contracts.js";
import type { QueuedTask } from "./types.js";

export interface TaskSchedulerOptions {
  readonly db: BridgeDatabase;
  readonly executor: TaskExecutor;
  readonly isPaused: () => boolean;
  readonly hasActiveTurn: (sessionId: string) => boolean;
  readonly hasLocalActiveSession: (sessionId: string) => Promise<boolean>;
  readonly onError: (operation: string, task: QueuedTask | null, error: unknown) => void;
  readonly onCancelled?: (tasks: readonly QueuedTask[], reason: string) => Promise<void>;
}

/** Owns durable FIFO claims and the in-memory worker-key set. */
export class TaskScheduler implements TaskSchedulerPort {
  private readonly taskWorkers = new Set<string>();

  constructor(private readonly options: TaskSchedulerOptions) {}

  async enqueueNew(task: QueuedTask): Promise<boolean> {
    return this.enqueue(task, null);
  }

  async enqueueResume(task: QueuedTask): Promise<boolean> {
    return this.enqueue(task, task.sessionId);
  }

  async drain(sessionId: string | null = null): Promise<void> {
    const workerKey = sessionId ?? "__new__";
    if (this.taskWorkers.has(workerKey) || this.options.isPaused()) return;
    this.taskWorkers.add(workerKey);
    try {
      while (!this.options.isPaused()) {
        const session = sessionId ? this.options.db.getSession(sessionId) : null;
        if (session && this.options.hasActiveTurn(session.sessionId)) return;
        if (session && await this.options.hasLocalActiveSession(session.sessionId)) return;
        const task = this.options.db.claimNextTask(sessionId);
        if (!task) return;
        try { await this.options.executor.execute(task); }
        catch (error) {
          this.options.onError("task_execute", task, error);
        }
      }
    } finally {
      this.taskWorkers.delete(workerKey);
    }
  }

  async cancel(scope: CancellationScope, reason: string): Promise<readonly string[]> {
    const tasks = scope.kind === "session"
      ? this.options.db.cancelTasksBySession(scope.sessionId, reason)
      : scope.kind === "task"
        ? this.cancelTask(scope.taskId, reason)
        : this.options.db.cancelAllTasks(reason);
    await this.options.onCancelled?.(tasks, reason);
    return tasks.map((task) => task.id);
  }

  async markInterruptedForEpoch(_epoch: number, _reason: string): Promise<readonly string[]> {
    const tasks = this.options.db.markRunningTasksInterrupted();
    return tasks.map((task) => task.id);
  }

  private async enqueue(task: QueuedTask, sessionId: string | null): Promise<boolean> {
    if (!this.options.db.enqueueTask(task)) return false;
    void this.drain(sessionId).catch((error) => this.options.onError("task_drain", task, error));
    return true;
  }

  private cancelTask(taskId: string, reason: string): QueuedTask[] {
    const task = this.options.db.getTask(taskId);
    if (!task || ["completed", "failed", "cancelled", "interrupted"].includes(task.status)) return [];
    this.options.db.updateTask(taskId, "cancelled", { terminalReason: reason });
    return [task];
  }
}
