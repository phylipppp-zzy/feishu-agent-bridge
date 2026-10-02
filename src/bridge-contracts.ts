import type { AppServerHealth, AppServerLifecycleEvent, JsonRpcMessage } from "./app-server.js";
import type {
  BridgeConfig,
  CardActionOutcome,
  FeishuPort,
  IncomingBotMenuAction,
  IncomingCardAction,
  IncomingFeishuMessage,
  PendingServerRequest,
  QueuedTask,
  SessionMetadata,
  TaskRootGrant,
  TurnState,
} from "./types.js";
import type { BridgeDatabase } from "./db.js";
import type { CodexCliProbe } from "./codex.js";

export type CancellationScope =
  | { kind: "task"; taskId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "all" };

export interface ImportedSessionEvent {
  readonly session: Readonly<SessionMetadata>;
  readonly source: "jsonl" | "app-server";
}

export interface ImportedMessageEvent {
  readonly sessionId: string;
  readonly messageId: string;
  readonly role: "user" | "assistant" | "progress";
  readonly text: string;
  readonly sourcePath?: string;
  readonly feishuMessageId?: string | null;
}

export interface TaskExecutor {
  execute(task: QueuedTask): Promise<void>;
}

export interface SessionImporterPort {
  startWatching(): Promise<void>;
  stopWatching(): Promise<void>;
  syncChangedFiles(): Promise<void>;
  reconcileHistory(): Promise<void>;
}

export interface TaskSchedulerPort {
  enqueueNew(task: QueuedTask): Promise<boolean>;
  enqueueResume(task: QueuedTask): Promise<boolean>;
  drain(sessionId?: string | null): Promise<void>;
  cancel(scope: CancellationScope, reason: string): Promise<readonly string[]>;
  markInterruptedForEpoch(epoch: number, reason: string): Promise<readonly string[]>;
}

export interface TurnCoordinatorPort {
  execute(task: QueuedTask): Promise<void>;
  interrupt(sessionId: string, turnId: string): Promise<void>;
  handleLifecycle(event: AppServerLifecycleEvent): Promise<void>;
  handleNotification(event: JsonRpcMessage): Promise<void>;
  activeTurn(sessionId: string): Readonly<TurnState> | null;
}

export interface ApprovalServicePort {
  requestRootConsent(task: QueuedTask): Promise<TaskRootGrant | null>;
  consumeRootGrant(task: QueuedTask): Promise<boolean>;
  handleServerRequest(request: JsonRpcMessage): Promise<unknown>;
  resolveAction(nonce: string, decision: string, answers?: readonly string[]): Promise<void>;
  cancelForSession(sessionId: string): Promise<void>;
  expire(): Promise<void>;
}

export interface FeishuRouterPort {
  handleMessage(message: IncomingFeishuMessage): Promise<void>;
  handleCardAction(action: IncomingCardAction): Promise<CardActionOutcome>;
  handleMenuAction(action: IncomingBotMenuAction): Promise<void>;
}

export interface BridgeModuleDependencies {
  readonly config: BridgeConfig;
  readonly db: BridgeDatabase;
  readonly feishu: FeishuPort;
  readonly codex: CodexCliProbe;
}

export interface BridgeHealthSnapshot {
  readonly appServer: AppServerHealth | null;
  readonly activeSessions: number;
  readonly queuedTasks: number;
  readonly waitingTasks: number;
  readonly failedTasks: number;
}

export type ServerRequestHandler = (request: JsonRpcMessage) => Promise<unknown>;
export type NotificationHandler = (event: JsonRpcMessage) => Promise<void>;
export type LifecycleHandler = (event: AppServerLifecycleEvent) => Promise<void>;
export type TaskEventHandler = (task: QueuedTask) => Promise<void>;
export type SessionEventHandler = (event: ImportedSessionEvent) => Promise<void>;
export type MessageEventHandler = (event: ImportedMessageEvent) => Promise<void>;
export type PendingRequest = Readonly<PendingServerRequest>;
