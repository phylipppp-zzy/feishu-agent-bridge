import type { Answer, Identity, NativeSessionRef, Provider } from '../contracts.js';
import type { ErrorCode } from '../errors.js';

export type TaskAccessMode = 'read_only' | 'interactive';
export type TaskState = 'active' | 'closed';
export type TaskTargetState = 'active' | 'revoked';

export interface TaskBindingRecord {
  taskId: string;
  destination: string;
  rootGeneration: number;
  owner: Identity;
  taskRevision: number;
  activeTargetId: string | null;
  activeRevision: number;
  state: TaskState;
}

export interface TaskTargetRecord {
  taskId: string;
  targetId: string;
  native: NativeSessionRef;
  sessionId: string;
  targetGeneration: number;
  accessMode: TaskAccessMode;
  state: TaskTargetState;
}

export interface TaskInboxRecord {
  eventId: string;
  taskId: string;
  destination: string;
  rootGeneration: number;
  taskRevision: number;
  targetId: string;
  targetGeneration: number;
  sessionId: string;
  activeRevision: number;
  owner: Identity;
  actionDigest: string;
  state: string;
  result: unknown;
}

export interface TaskCursorRecord {
  taskId: string;
  targetId: string;
  targetGeneration: number;
  sessionId: string;
  cursor: string;
  bindingScope: string;
}

export type TaskAuthorize = (
  identity: Identity,
  destination: string,
  sessionId: string | null,
) => Promise<boolean> | boolean;

export type TaskChannelAction = (
  | {
      action: 'input';
      text: string;
      mode: 'new' | 'queue' | 'steer';
    }
  | {
      action: 'switch_target';
      targetId: string;
    }
  | {
      action: 'answer';
      targetId: string;
      targetGeneration: number;
      sessionId: string;
      interactionId: string;
      revision: number;
      connectionGeneration: number;
      controlGeneration?: number;
      answer: Answer;
      toolInputDigest: string | null;
    }
  | {
      action: 'answer_form';
      targetId: string;
      targetGeneration: number;
      sessionId: string;
      interactionId: string;
      revision: number;
      connectionGeneration: number;
      controlGeneration?: number;
      fields: Record<string, unknown>;
    }
  | {
      action: 'stop';
      targetId?: string;
      targetGeneration?: number;
      sessionId?: string;
      turnId: string;
      revision: number;
      controlGeneration: number;
    }
  | {
      action: 'settings';
      targetId?: string;
      targetGeneration?: number;
      sessionId?: string;
      model: string | null;
      preferences: Record<string, string>;
      revision: number;
      controlGeneration: number;
    }
  | {
      action: 'cancel';
      targetId?: string;
      targetGeneration?: number;
      sessionId?: string;
      inputId: string;
      revision: number;
      controlGeneration: number;
    }
  | {
      action: 'attachment';
      name: string;
      mediaType: string;
      content: Uint8Array;
      mode: 'new' | 'queue' | 'steer';
    }
  | {
      action: 'resource_rejected';
      reason: 'size' | 'encoding' | 'unsupported';
    }
  | {
      action: 'panel';
    }
  | {
      action: 'help';
      scope?: 'admin';
    }
  | {
      action: 'swarm';
      prompt: string;
      rawText: string;
    }
  | {
      action: 'history';
      targetId?: string;
      targetGeneration?: number;
      sessionId?: string;
      cursor?: string;
    }
  | {
      action: 'artifacts';
      targetId?: string;
      targetGeneration?: number;
      sessionId?: string;
    }
  | {
      action: 'full_reply';
      targetId?: string;
      targetGeneration?: number;
      sessionId?: string;
      messageId: string;
    }
  | {
      action: 'file';
      targetId?: string;
      targetGeneration?: number;
      sessionId?: string;
      artifactId: string;
      contentVersion: string;
    }
  | {
      action: 'models';
      targetId?: string;
      targetGeneration?: number;
      sessionId?: string;
      cursor?: string;
    }
) & {
  taskId?: string;
  rootGeneration?: number;
  activeRevision?: number;
};

export interface TaskTopicChannelOptions {
  streamThrottleMs?: number;
  onInteractionChanged?: (sessionId: string, interactionId: string) => void;
}

export class TaskChannelError extends Error {
  constructor(
    readonly code:
      | ErrorCode
      | 'task_not_found'
      | 'task_closed'
      | 'target_not_found'
      | 'target_revoked'
      | 'stale_active_revision'
      | 'read_only_target'
      | 'no_active_target',
    message: string,
  ) {
    super(message);
  }
}

export interface BindingRow {
  task_id: string;
  destination: string;
  root_generation: number;
  owner_source: string;
  owner_subject: string;
  task_revision: number;
  active_target_id: string | null;
  active_revision: number;
  state: TaskState;
}

export interface TargetRow {
  task_id: string;
  target_id: string;
  provider: Provider;
  host_id: string;
  service_id: string;
  native_session_id: string;
  session_id: string;
  target_generation: number;
  access_mode: TaskAccessMode;
  state: TaskTargetState;
}

export interface InboxRow {
  event_id: string;
  task_id: string;
  destination: string;
  root_generation: number;
  task_revision: number;
  target_id: string;
  target_generation: number;
  session_id: string;
  active_revision: number;
  owner_source: string;
  owner_subject: string;
  action_digest: string;
  state: string;
  result: string | null;
}

export const VALID_PROVIDERS: ReadonlySet<Provider> = new Set(['claude', 'codex', 'agy']);
export const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export const counter = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function toBinding(row: BindingRow): TaskBindingRecord {
  return {
    taskId: row.task_id,
    destination: row.destination,
    rootGeneration: row.root_generation,
    owner: { source: row.owner_source, subject: row.owner_subject },
    taskRevision: row.task_revision,
    activeTargetId: row.active_target_id,
    activeRevision: row.active_revision,
    state: row.state,
  };
}

export function toTarget(row: TargetRow): TaskTargetRecord {
  return {
    taskId: row.task_id,
    targetId: row.target_id,
    native: {
      provider: row.provider,
      hostId: row.host_id,
      serviceId: row.service_id,
      nativeSessionId: row.native_session_id,
    },
    sessionId: row.session_id,
    targetGeneration: row.target_generation,
    accessMode: row.access_mode,
    state: row.state,
  };
}

export function targetBindingScope(binding: BindingRow, target: TargetRow): string {
  return JSON.stringify({
    taskId: binding.task_id,
    rootGeneration: binding.root_generation,
    targetId: target.target_id,
    targetGeneration: target.target_generation,
    sessionId: target.session_id,
    accessMode: target.access_mode,
  });
}

export function interactionFormBindingId(taskId: string, targetId: string, targetGeneration: number): string {
  return `task:${taskId}:${targetId}:${targetGeneration}`;
}
