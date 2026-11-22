import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { UnifiedService } from './adapter.js';
import {
  payloadDigest,
  type Answer,
  type Identity,
  type Interaction,
  type Message,
  type NativeSessionRef,
  type Operation,
  type Provider,
  type Session,
  type WriteContext,
} from './contracts.js';
import { contractError, type ErrorCode } from './errors.js';
import {
  interactionCard,
  operationCard,
  providerDisplayLabel,
  providerTitlePrefix,
  type ChannelCard,
} from './feishu-cards.js';
import { decodeQuestionForm, questionForm } from './feishu-question-forms.js';
import type { FeishuPort, TrustedEnvelope } from './feishu-channel.js';
import type { TaskTopicToken } from './task-topic-store.js';

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
      action: 'panel';
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

interface BindingRow {
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

interface TargetRow {
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

interface InboxRow {
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

const VALID_PROVIDERS: ReadonlySet<Provider> = new Set(['claude', 'codex', 'agy']);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const counter = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function toBinding(row: BindingRow): TaskBindingRecord {
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

function toTarget(row: TargetRow): TaskTargetRecord {
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

function targetBindingScope(binding: BindingRow, target: TargetRow): string {
  return JSON.stringify({
    taskId: binding.task_id,
    rootGeneration: binding.root_generation,
    targetId: target.target_id,
    targetGeneration: target.target_generation,
    sessionId: target.session_id,
    accessMode: target.access_mode,
  });
}

function interactionFormBindingId(taskId: string, targetId: string, targetGeneration: number): string {
  return `task:${taskId}:${targetId}:${targetGeneration}`;
}

export function taskPanelCard(
  binding: TaskBindingRecord,
  targets: readonly TaskTargetRecord[],
): ChannelCard {
  const active = targets.find((t) => t.targetId === binding.activeTargetId && t.state === 'active');
  const lines = targets
    .filter((t) => t.state === 'active')
    .map((t) => {
      const marker = t.targetId === binding.activeTargetId ? '【当前输入】' : '【已挂载】';
      const mode = t.accessMode === 'interactive' ? '可交互' : '只读';
      return `${marker} ${providerTitlePrefix(t.native.provider)} (${t.targetId}) · ${mode} · gen=${t.targetGeneration}`;
    });
  const text = [
    `任务: ${binding.taskId} (rev=${binding.taskRevision}, activeRev=${binding.activeRevision})`,
    `当前输入目标: ${active ? `${providerTitlePrefix(active.native.provider)} (${active.targetId})` : '未指定'}`,
    ...(lines.length ? lines : ['暂无已挂载目标']),
  ].join('\n');
  const actions: ChannelCard['actions'] = targets
    .filter((t) => t.state === 'active' && t.accessMode === 'interactive' && t.targetId !== binding.activeTargetId)
    .map((t) => ({
      label: `切换到 ${providerTitlePrefix(t.native.provider)}`,
      value: {
        action: 'switch_target',
        taskId: binding.taskId,
        rootGeneration: binding.rootGeneration,
        activeRevision: binding.activeRevision,
        targetId: t.targetId,
      },
    }));
  return { title: '任务目标面板', text, actions };
}

export function taskInteractionCard(
  binding: TaskBindingRecord,
  target: TaskTargetRecord,
  interaction: Interaction,
  controlGeneration = 0,
): ChannelCard {
  const readOnly = target.accessMode === 'read_only';
  const baseCard = interactionCard(interaction, readOnly);
  const label = providerTitlePrefix(target.native.provider);
  const stamp = {
    taskId: binding.taskId,
    rootGeneration: binding.rootGeneration,
    activeRevision: binding.activeRevision,
    targetId: target.targetId,
    targetGeneration: target.targetGeneration,
    sessionId: target.sessionId,
    controlGeneration,
  };
  const card: ChannelCard = {
    title: `${label} · ${baseCard.title}`,
    text: `来源: ${providerDisplayLabel(target.native.provider)} (${target.targetId})\n${baseCard.text}`,
    actions: baseCard.actions.map((a) => ({
      ...a,
      value: { ...a.value, ...stamp },
    })),
  };
  if (interaction.kind !== 'approval') {
    card.form = questionForm(
      interaction,
      interactionFormBindingId(target.taskId, target.targetId, target.targetGeneration),
      readOnly,
    );
  }
  return card;
}

/**
 * T1: Multi-backend (claude / codex / agy) task topic channel with explicit activeTarget CAS,
 * ingress target capture, per-target cursors, non-colliding stream cards, and cross-target
 * interaction routing. Only creates additive `task_*` tables; safe to co-locate in channel.sqlite.
 */
export class TaskTopicChannel {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly taskLocks = new Map<string, Promise<void>>();
  private readonly streamThrottleMs: number;
  private closed = false;

  constructor(
    private readonly service: UnifiedService,
    private readonly port: FeishuPort,
    private readonly authorize: TaskAuthorize,
    dbOrPath: string | DatabaseSync,
    options: TaskTopicChannelOptions = {},
  ) {
    this.streamThrottleMs = options.streamThrottleMs ?? 1000;
    if (typeof dbOrPath === 'string') {
      this.db = new DatabaseSync(dbOrPath);
      this.ownsDb = true;
      if (dbOrPath !== ':memory:') {
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      } else {
        this.db.exec('PRAGMA busy_timeout=5000;');
      }
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_bindings_v1 (
        task_id TEXT PRIMARY KEY,
        destination TEXT UNIQUE NOT NULL,
        root_generation INTEGER NOT NULL,
        owner_source TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        task_revision INTEGER NOT NULL,
        active_target_id TEXT,
        active_revision INTEGER NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_targets_v1 (
        task_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        host_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL,
        access_mode TEXT NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY(task_id, target_id),
        UNIQUE(task_id, provider, host_id, service_id, native_session_id)
      );
      CREATE TABLE IF NOT EXISTS task_inbox_scope_v1 (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        root_generation INTEGER NOT NULL,
        task_revision INTEGER NOT NULL,
        target_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        active_revision INTEGER NOT NULL,
        owner_source TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT
      );
      CREATE TABLE IF NOT EXISTS task_inbox_payloads_v1 (
        event_id TEXT PRIMARY KEY,
        envelope TEXT NOT NULL,
        action TEXT NOT NULL,
        steer_turn_id TEXT,
        steer_connection_generation INTEGER,
        steer_control_generation INTEGER
      );
      CREATE TABLE IF NOT EXISTS task_cursors_v1 (
        task_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        cursor TEXT NOT NULL,
        binding_scope TEXT NOT NULL,
        PRIMARY KEY(task_id, target_id, target_generation)
      );
      CREATE TABLE IF NOT EXISTS task_deliveries_v1 (
        delivery_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        target_id TEXT,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_stream_cards_v1 (
        task_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        card_id TEXT,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        final INTEGER NOT NULL,
        latest_sequence INTEGER NOT NULL,
        PRIMARY KEY(task_id, target_id, target_generation, session_id, turn_key)
      );
      CREATE TABLE IF NOT EXISTS task_known_messages_v1 (
        task_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY(task_id, target_id, target_generation, session_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS task_interaction_cards_v1 (
        task_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        active_revision INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        signature TEXT NOT NULL,
        PRIMARY KEY(task_id, target_id, target_generation, session_id, interaction_id)
      );
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDb) this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure if already aborted
      }
      throw error;
    }
  }

  private async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => lock);
    this.taskLocks.set(taskId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.taskLocks.get(taskId) === tail) {
        this.taskLocks.delete(taskId);
      }
    }
  }

  private getBindingRow(taskId: string): BindingRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_bindings_v1 WHERE task_id = ?')
      .get(taskId) as BindingRow | undefined;
  }

  private getBindingRowByDestination(destination: string): BindingRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_bindings_v1 WHERE destination = ?')
      .get(destination) as BindingRow | undefined;
  }

  private getTargetRow(taskId: string, targetId: string): TargetRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_targets_v1 WHERE task_id = ? AND target_id = ?')
      .get(taskId, targetId) as TargetRow | undefined;
  }

  getBinding(taskId: string): TaskBindingRecord | null {
    const row = this.getBindingRow(taskId);
    return row ? toBinding(row) : null;
  }

  getBindingByDestination(destination: string): TaskBindingRecord | null {
    const row = this.getBindingRowByDestination(destination);
    return row ? toBinding(row) : null;
  }

  getTarget(taskId: string, targetId: string): TaskTargetRecord | null {
    const row = this.getTargetRow(taskId, targetId);
    return row ? toTarget(row) : null;
  }

  listTargets(taskId: string, includeRevoked = false): TaskTargetRecord[] {
    const sql = includeRevoked
      ? 'SELECT * FROM task_targets_v1 WHERE task_id = ? ORDER BY rowid'
      : "SELECT * FROM task_targets_v1 WHERE task_id = ? AND state = 'active' ORDER BY rowid";
    return (this.db.prepare(sql).all(taskId) as unknown as TargetRow[]).map(toTarget);
  }

  getCursor(taskId: string, targetId: string, targetGeneration: number): TaskCursorRecord | null {
    const row = this.db
      .prepare(
        'SELECT task_id, target_id, target_generation, session_id, cursor, binding_scope FROM task_cursors_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ?',
      )
      .get(taskId, targetId, targetGeneration) as
      | {
          task_id: string;
          target_id: string;
          target_generation: number;
          session_id: string;
          cursor: string;
          binding_scope: string;
        }
      | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id,
      targetId: row.target_id,
      targetGeneration: row.target_generation,
      sessionId: row.session_id,
      cursor: row.cursor,
      bindingScope: row.binding_scope,
    };
  }

  getInboxScope(eventId: string): TaskInboxRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_inbox_scope_v1 WHERE event_id = ?')
      .get(eventId) as InboxRow | undefined;
    if (!row) return null;
    return {
      eventId: row.event_id,
      taskId: row.task_id,
      destination: row.destination,
      rootGeneration: row.root_generation,
      taskRevision: row.task_revision,
      targetId: row.target_id,
      targetGeneration: row.target_generation,
      sessionId: row.session_id,
      activeRevision: row.active_revision,
      owner: { source: row.owner_source, subject: row.owner_subject },
      actionDigest: row.action_digest,
      state: row.state,
      result: row.result ? JSON.parse(row.result) : null,
    };
  }

  pendingInbox(taskId?: string): string[] {
    if (taskId !== undefined) {
      return (
        this.db
          .prepare("SELECT event_id FROM task_inbox_scope_v1 WHERE task_id = ? AND state = 'received' ORDER BY rowid")
          .all(taskId) as Array<{ event_id: string }>
      ).map((r) => r.event_id);
    }
    return (
      this.db
        .prepare("SELECT event_id FROM task_inbox_scope_v1 WHERE state = 'received' ORDER BY rowid")
        .all() as Array<{ event_id: string }>
    ).map((r) => r.event_id);
  }

  unknownInbox(taskId?: string): string[] {
    if (taskId !== undefined) {
      return (
        this.db
          .prepare("SELECT event_id FROM task_inbox_scope_v1 WHERE task_id = ? AND state = 'unknown' ORDER BY rowid")
          .all(taskId) as Array<{ event_id: string }>
      ).map((r) => r.event_id);
    }
    return (
      this.db
        .prepare("SELECT event_id FROM task_inbox_scope_v1 WHERE state = 'unknown' ORDER BY rowid")
        .all() as Array<{ event_id: string }>
    ).map((r) => r.event_id);
  }

  /** Register an active task topic binding from a T0 TaskTopicToken or explicit root descriptor. */
  registerTask(input: {
    taskId: string;
    destination: string;
    rootGeneration: number;
    owner: Identity;
  }): TaskBindingRecord {
    if (
      !nonempty(input.taskId) ||
      !nonempty(input.destination) ||
      !Number.isSafeInteger(input.rootGeneration) ||
      input.rootGeneration < 1 ||
      !nonempty(input.owner?.source) ||
      !nonempty(input.owner?.subject)
    ) {
      throw new TaskChannelError('invalid_request', 'invalid task binding registration');
    }
    return this.tx(() => {
      const prior = this.getBindingRow(input.taskId);
      if (prior) {
        if (
          prior.destination !== input.destination ||
          prior.root_generation !== input.rootGeneration ||
          prior.owner_source !== input.owner.source ||
          prior.owner_subject !== input.owner.subject ||
          prior.state !== 'active'
        ) {
          throw new TaskChannelError('idempotency_conflict', 'task binding conflict');
        }
        return toBinding(prior);
      }
      if (this.getBindingRowByDestination(input.destination)) {
        throw new TaskChannelError('idempotency_conflict', 'destination already registered to another task');
      }
      this.db
        .prepare(
          "INSERT INTO task_bindings_v1(task_id, destination, root_generation, owner_source, owner_subject, task_revision, active_target_id, active_revision, state) VALUES (?, ?, ?, ?, ?, 1, NULL, 1, 'active')",
        )
        .run(
          input.taskId,
          input.destination,
          input.rootGeneration,
          input.owner.source,
          input.owner.subject,
        );
      return toBinding(this.getBindingRow(input.taskId)!);
    });
  }

  registerFromToken(token: TaskTopicToken, ownerSource = 'feishu'): TaskBindingRecord {
    return this.registerTask({
      taskId: token.taskId,
      destination: token.destination,
      rootGeneration: token.generation,
      owner: { source: ownerSource, subject: token.owner },
    });
  }

  closeTask(taskId: string, owner: Identity): TaskBindingRecord {
    return this.tx(() => {
      const row = this.getBindingRow(taskId);
      if (!row) throw new TaskChannelError('task_not_found', 'task not found');
      if (row.owner_source !== owner.source || row.owner_subject !== owner.subject) {
        throw new TaskChannelError('unauthorized', 'task owner mismatch');
      }
      if (row.state === 'closed') return toBinding(row);
      this.db
        .prepare(
          "UPDATE task_bindings_v1 SET state = 'closed', root_generation = root_generation + 1, task_revision = task_revision + 1, active_revision = active_revision + 1 WHERE task_id = ? AND root_generation = ? AND state = 'active'",
        )
        .run(taskId, row.root_generation);
      return toBinding(this.getBindingRow(taskId)!);
    });
  }

  /**
   * Mount a provider target (`claude` | `codex` | `agy`) onto a task topic.
   * Multiple backends coexist in `task_targets_v1` simultaneously.
   */
  async mountTarget(input: {
    taskId: string;
    targetId: string;
    sessionId: string;
    native: NativeSessionRef;
    accessMode: TaskAccessMode;
    owner: Identity;
    makeActive?: boolean;
  }): Promise<TaskTargetRecord> {
    if (
      !nonempty(input.taskId) ||
      !nonempty(input.targetId) ||
      !nonempty(input.sessionId) ||
      !VALID_PROVIDERS.has(input.native?.provider) ||
      !nonempty(input.native?.hostId) ||
      !nonempty(input.native?.serviceId) ||
      !nonempty(input.native?.nativeSessionId) ||
      !['read_only', 'interactive'].includes(input.accessMode) ||
      !nonempty(input.owner?.source) ||
      !nonempty(input.owner?.subject)
    ) {
      throw new TaskChannelError('invalid_request', 'invalid task target parameters');
    }

    const pre = this.getBindingRow(input.taskId);
    if (!pre) throw new TaskChannelError('task_not_found', 'task not found');
    if (pre.state !== 'active') throw new TaskChannelError('task_closed', 'task is not active');
    if (pre.owner_source !== input.owner.source || pre.owner_subject !== input.owner.subject) {
      throw new TaskChannelError('unauthorized', 'task owner mismatch');
    }
    if (!await this.authorize(input.owner, pre.destination, input.sessionId)) {
      throw new TaskChannelError('unauthorized', 'session authorization denied');
    }
    const session = await this.service.getSession(input.sessionId);
    if (
      session.native.provider !== input.native.provider ||
      session.native.hostId !== input.native.hostId ||
      session.native.serviceId !== input.native.serviceId ||
      session.native.nativeSessionId !== input.native.nativeSessionId
    ) {
      throw new TaskChannelError('invalid_request', 'session native identity mismatch');
    }

    return this.tx(() => {
      const binding = this.getBindingRow(input.taskId);
      if (!binding || binding.state !== 'active' || binding.root_generation !== pre.root_generation) {
        throw new TaskChannelError('task_closed', 'task binding changed');
      }
      if (binding.owner_source !== input.owner.source || binding.owner_subject !== input.owner.subject) {
        throw new TaskChannelError('unauthorized', 'task owner changed');
      }
      const existing = this.getTargetRow(input.taskId, input.targetId);
      const nativeOwner = this.db
        .prepare(
          'SELECT target_id FROM task_targets_v1 WHERE task_id = ? AND provider = ? AND host_id = ? AND service_id = ? AND native_session_id = ?',
        )
        .get(
          input.taskId,
          input.native.provider,
          input.native.hostId,
          input.native.serviceId,
          input.native.nativeSessionId,
        ) as { target_id: string } | undefined;
      if (nativeOwner && nativeOwner.target_id !== input.targetId) {
        throw new TaskChannelError('idempotency_conflict', 'native session already mounted under another target');
      }

      if (existing) {
        const sameNative =
          existing.provider === input.native.provider &&
          existing.host_id === input.native.hostId &&
          existing.service_id === input.native.serviceId &&
          existing.native_session_id === input.native.nativeSessionId;
        if (!sameNative) {
          throw new TaskChannelError('idempotency_conflict', 'targetId already bound to different native session');
        }
        const unchanged =
          existing.state === 'active' &&
          existing.session_id === input.sessionId &&
          existing.access_mode === input.accessMode;
        if (!unchanged) {
          this.db
            .prepare(
              "UPDATE task_targets_v1 SET session_id = ?, access_mode = ?, state = 'active', target_generation = target_generation + 1 WHERE task_id = ? AND target_id = ?",
            )
            .run(input.sessionId, input.accessMode, input.taskId, input.targetId);
          this.db
            .prepare(
              'UPDATE task_bindings_v1 SET task_revision = task_revision + 1 WHERE task_id = ?',
            )
            .run(input.taskId);
        }
      } else {
        this.db
          .prepare(
            "INSERT INTO task_targets_v1(task_id, target_id, provider, host_id, service_id, native_session_id, session_id, target_generation, access_mode, state) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'active')",
          )
          .run(
            input.taskId,
            input.targetId,
            input.native.provider,
            input.native.hostId,
            input.native.serviceId,
            input.native.nativeSessionId,
            input.sessionId,
            input.accessMode,
          );
        this.db
          .prepare('UPDATE task_bindings_v1 SET task_revision = task_revision + 1 WHERE task_id = ?')
          .run(input.taskId);
      }

      if (input.makeActive) {
        if (input.accessMode !== 'interactive') {
          throw new TaskChannelError('read_only_target', 'read-only target cannot become active input target');
        }
        this.db
          .prepare(
            'UPDATE task_bindings_v1 SET active_target_id = ?, active_revision = active_revision + 1 WHERE task_id = ? AND state = ?',
          )
          .run(input.targetId, input.taskId, 'active');
      }

      return toTarget(this.getTargetRow(input.taskId, input.targetId)!);
    });
  }

  /** Revoke/unbind a mounted target and bump its target_generation so captured old-gen work never falls back. */
  revokeTarget(taskId: string, targetId: string, owner: Identity): TaskTargetRecord {
    return this.tx(() => {
      const binding = this.getBindingRow(taskId);
      if (!binding) throw new TaskChannelError('task_not_found', 'task not found');
      if (binding.owner_source !== owner.source || binding.owner_subject !== owner.subject) {
        throw new TaskChannelError('unauthorized', 'task owner mismatch');
      }
      const target = this.getTargetRow(taskId, targetId);
      if (!target) throw new TaskChannelError('target_not_found', 'target not found');

      this.db
        .prepare(
          "UPDATE task_targets_v1 SET state = 'revoked', target_generation = target_generation + 1 WHERE task_id = ? AND target_id = ?",
        )
        .run(taskId, targetId);

      if (binding.active_target_id === targetId) {
        this.db
          .prepare(
            'UPDATE task_bindings_v1 SET active_target_id = NULL, active_revision = active_revision + 1, task_revision = task_revision + 1 WHERE task_id = ?',
          )
          .run(taskId);
      } else {
        this.db
          .prepare('UPDATE task_bindings_v1 SET task_revision = task_revision + 1 WHERE task_id = ?')
          .run(taskId);
      }
      return toTarget(this.getTargetRow(taskId, targetId)!);
    });
  }

  /** Explicitly increment target_generation (e.g., native reconnect/rebind or access mode change). */
  updateTarget(
    taskId: string,
    targetId: string,
    owner: Identity,
    patch: { accessMode?: TaskAccessMode; bumpGeneration?: boolean },
  ): TaskTargetRecord {
    return this.tx(() => {
      const binding = this.getBindingRow(taskId);
      if (!binding || binding.state !== 'active') throw new TaskChannelError('task_not_found', 'task unavailable');
      if (binding.owner_source !== owner.source || binding.owner_subject !== owner.subject) {
        throw new TaskChannelError('unauthorized', 'task owner mismatch');
      }
      const target = this.getTargetRow(taskId, targetId);
      if (!target || target.state !== 'active') throw new TaskChannelError('target_not_found', 'target unavailable');
      const nextMode = patch.accessMode ?? target.access_mode;
      const shouldBump = patch.bumpGeneration === true || nextMode !== target.access_mode;
      if (shouldBump) {
        this.db
          .prepare(
            'UPDATE task_targets_v1 SET access_mode = ?, target_generation = target_generation + 1 WHERE task_id = ? AND target_id = ?',
          )
          .run(nextMode, taskId, targetId);
        if (binding.active_target_id === targetId && nextMode === 'read_only') {
          this.db
            .prepare(
              'UPDATE task_bindings_v1 SET active_target_id = NULL, active_revision = active_revision + 1, task_revision = task_revision + 1 WHERE task_id = ?',
            )
            .run(taskId);
        } else {
          this.db
            .prepare('UPDATE task_bindings_v1 SET task_revision = task_revision + 1 WHERE task_id = ?')
            .run(taskId);
        }
      }
      return toTarget(this.getTargetRow(taskId, targetId)!);
    });
  }

  /**
   * Single-transaction CAS switch of active_target_id.
   * Verifies task_id, root_generation, expectedActiveRevision, owner, state='active',
   * target existence/availability/capability, and increments active_revision.
   */
  async switchActiveTarget(input: {
    taskId: string;
    targetId: string;
    expectedActiveRevision: number;
    expectedRootGeneration: number;
    owner: Identity;
  }): Promise<TaskBindingRecord> {
    if (
      !nonempty(input.taskId) ||
      !nonempty(input.targetId) ||
      !counter(input.expectedActiveRevision) ||
      !Number.isSafeInteger(input.expectedRootGeneration) ||
      input.expectedRootGeneration < 1 ||
      !nonempty(input.owner?.source) ||
      !nonempty(input.owner?.subject)
    ) {
      throw new TaskChannelError('invalid_request', 'invalid switchActiveTarget request');
    }

    const preBinding = this.getBindingRow(input.taskId);
    if (!preBinding) throw new TaskChannelError('task_not_found', 'task not found');
    if (preBinding.state !== 'active') throw new TaskChannelError('task_closed', 'task is closed');
    if (
      preBinding.owner_source !== input.owner.source ||
      preBinding.owner_subject !== input.owner.subject
    ) {
      throw new TaskChannelError('unauthorized', 'task owner mismatch');
    }
    if (preBinding.root_generation !== input.expectedRootGeneration) {
      throw new TaskChannelError('stale_revision', 'root generation mismatch');
    }
    if (preBinding.active_revision !== input.expectedActiveRevision) {
      throw new TaskChannelError('stale_active_revision', 'active_revision mismatch');
    }

    const preTarget = this.getTargetRow(input.taskId, input.targetId);
    if (!preTarget) throw new TaskChannelError('target_not_found', 'target not found');
    if (preTarget.state !== 'active') throw new TaskChannelError('target_revoked', 'target is not active');
    if (preTarget.access_mode !== 'interactive') {
      throw new TaskChannelError('read_only_target', 'read-only target cannot be active input target');
    }
    if (!await this.authorize(input.owner, preBinding.destination, preTarget.session_id)) {
      throw new TaskChannelError('unauthorized', 'target authorization denied');
    }
    const session = await this.service.getSession(preTarget.session_id);
    if (session.status === 'unreachable') {
      throw new TaskChannelError('temporarily_unavailable', 'target session is unreachable');
    }
    if (session.status === 'read_only' || session.capabilities.send.status !== 'available') {
      throw new TaskChannelError('unsupported', 'target session does not support interactive input');
    }

    return this.tx(() => {
      const target = this.getTargetRow(input.taskId, input.targetId);
      if (
        !target ||
        target.state !== 'active' ||
        target.target_generation !== preTarget.target_generation ||
        target.session_id !== preTarget.session_id ||
        target.access_mode !== 'interactive'
      ) {
        throw new TaskChannelError('target_revoked', 'target unavailable during switch');
      }
      const updated = this.db
        .prepare(
          "UPDATE task_bindings_v1 SET active_target_id = ?, active_revision = active_revision + 1 WHERE task_id = ? AND root_generation = ? AND active_revision = ? AND owner_source = ? AND owner_subject = ? AND state = 'active'",
        )
        .run(
          input.targetId,
          input.taskId,
          input.expectedRootGeneration,
          input.expectedActiveRevision,
          input.owner.source,
          input.owner.subject,
        );
      if (updated.changes !== 1) {
        throw new TaskChannelError('stale_active_revision', 'active target CAS conflict');
      }
      return toBinding(this.getBindingRow(input.taskId)!);
    });
  }

  /** Capture a task target scope before downloading deferred inbound resources. */
  async captureResourceScope(e: TrustedEnvelope): Promise<string> {
    if (!nonempty(e?.destination) || !nonempty(e?.identity?.source) || !nonempty(e?.identity?.subject)) {
      throw new TaskChannelError('invalid_request', 'invalid envelope');
    }
    const binding = this.getBindingRowByDestination(e.destination);
    if (!binding || binding.state !== 'active') {
      throw new TaskChannelError('task_not_found', 'active task binding not found');
    }
    if (binding.owner_source !== e.identity.source || binding.owner_subject !== e.identity.subject) {
      throw new TaskChannelError('unauthorized', 'unauthorized task owner');
    }
    if (!binding.active_target_id) {
      throw new TaskChannelError('no_active_target', 'no active target for task');
    }
    const target = this.getTargetRow(binding.task_id, binding.active_target_id);
    if (!target || target.state !== 'active') {
      throw new TaskChannelError('target_revoked', 'active target unavailable');
    }
    if (target.access_mode !== 'interactive') {
      throw new TaskChannelError('read_only_target', 'read-only target cannot accept attachments');
    }
    if (!await this.authorize(e.identity, e.destination, target.session_id)) {
      throw new TaskChannelError('unauthorized', 'target authorization denied');
    }
    const latestBinding = this.getBindingRow(binding.task_id);
    const latestTarget = this.getTargetRow(binding.task_id, target.target_id);
    if (
      !latestBinding ||
      latestBinding.state !== 'active' ||
      latestBinding.root_generation !== binding.root_generation ||
      latestBinding.active_revision !== binding.active_revision ||
      !latestTarget ||
      latestTarget.state !== 'active' ||
      latestTarget.target_generation !== target.target_generation
    ) {
      throw new TaskChannelError('stale_active_revision', 'task binding changed during capture');
    }
    return JSON.stringify({
      taskId: latestBinding.task_id,
      rootGeneration: latestBinding.root_generation,
      targetId: latestTarget.target_id,
      targetGeneration: latestTarget.target_generation,
      sessionId: latestTarget.session_id,
      activeRevision: latestBinding.active_revision,
    });
  }

  private resolveTargetForIntake(
    binding: BindingRow,
    a: TaskChannelAction,
    isCard: boolean,
  ): TargetRow {
    if (a.taskId !== undefined && a.taskId !== binding.task_id) {
      throw new TaskChannelError('stale_revision', 'card taskId mismatch');
    }
    if (a.rootGeneration !== undefined && a.rootGeneration !== binding.root_generation) {
      throw new TaskChannelError('stale_revision', 'card rootGeneration mismatch');
    }
    if (isCard && (a.taskId === undefined || a.rootGeneration === undefined || a.activeRevision === undefined)) {
      throw new TaskChannelError('stale_active_revision', 'card action missing task scope or activeRevision');
    }
    if (a.activeRevision !== undefined && a.activeRevision !== binding.active_revision) {
      throw new TaskChannelError('stale_active_revision', 'stale active_revision card rejected');
    }

    if (a.action === 'answer' || a.action === 'answer_form') {
      const target = this.getTargetRow(binding.task_id, a.targetId);
      if (!target) throw new TaskChannelError('target_not_found', 'interaction target not found');
      if (target.state !== 'active') throw new TaskChannelError('target_revoked', 'interaction target revoked');
      if (target.target_generation !== a.targetGeneration || target.session_id !== a.sessionId) {
        throw new TaskChannelError('stale_revision', 'interaction target generation or session mismatch');
      }
      return target;
    }

    if (a.action === 'switch_target') {
      const target = this.getTargetRow(binding.task_id, a.targetId);
      if (!target) throw new TaskChannelError('target_not_found', 'switch target not found');
      if (target.state !== 'active') throw new TaskChannelError('target_revoked', 'switch target revoked');
      if (target.access_mode !== 'interactive') {
        throw new TaskChannelError('read_only_target', 'read-only target cannot become active');
      }
      return target;
    }

    const explicitTargetId =
      'targetId' in a && typeof a.targetId === 'string' ? a.targetId : undefined;
    if (explicitTargetId !== undefined) {
      const target = this.getTargetRow(binding.task_id, explicitTargetId);
      if (!target || target.state !== 'active') {
        throw new TaskChannelError('target_revoked', 'specified target unavailable');
      }
      if ('targetGeneration' in a && a.targetGeneration !== undefined && target.target_generation !== a.targetGeneration) {
        throw new TaskChannelError('stale_revision', 'target generation mismatch');
      }
      if ('sessionId' in a && a.sessionId !== undefined && target.session_id !== a.sessionId) {
        throw new TaskChannelError('stale_revision', 'target session mismatch');
      }
      return target;
    }

    if (!binding.active_target_id) {
      if (a.action === 'panel') {
        return {
          task_id: binding.task_id,
          target_id: '',
          provider: 'codex',
          host_id: '',
          service_id: '',
          native_session_id: '',
          session_id: '',
          target_generation: 0,
          access_mode: 'read_only',
          state: 'active',
        };
      }
      throw new TaskChannelError('no_active_target', 'task has no active target');
    }

    const active = this.getTargetRow(binding.task_id, binding.active_target_id);
    if (!active || active.state !== 'active') {
      throw new TaskChannelError('target_revoked', 'active target is unavailable');
    }
    return active;
  }

  /**
   * Authenticate, authorize, verify activeRevision/target scope, and atomically capture
   * the immutable target scope in `task_inbox_scope_v1`.
   */
  async intake(
    e: TrustedEnvelope,
    a: TaskChannelAction,
    expectedResourceScope?: string,
  ): Promise<{ eventId: string; state: string; capturedTargetId: string; sessionId: string }> {
    if (!nonempty(e?.eventId) || !nonempty(e?.destination) || !nonempty(e?.identity?.source) || !nonempty(e?.identity?.subject)) {
      throw new TaskChannelError('invalid_request', 'invalid trusted envelope');
    }
    const isCard = e.eventId.startsWith('card:');
    const preBinding = this.getBindingRowByDestination(e.destination);
    if (!preBinding) throw new TaskChannelError('task_not_found', 'destination is not a registered task topic');
    if (preBinding.state !== 'active') throw new TaskChannelError('task_closed', 'task topic is closed');
    if (preBinding.owner_source !== e.identity.source || preBinding.owner_subject !== e.identity.subject) {
      throw new TaskChannelError('unauthorized', 'task owner mismatch');
    }

    const preTarget = this.resolveTargetForIntake(preBinding, a, isCard);

    if (expectedResourceScope !== undefined) {
      if (a.action !== 'attachment') {
        throw new TaskChannelError('invalid_request', 'resource scope only valid for attachment');
      }
      const currentResourceScope = JSON.stringify({
        taskId: preBinding.task_id,
        rootGeneration: preBinding.root_generation,
        targetId: preTarget.target_id,
        targetGeneration: preTarget.target_generation,
        sessionId: preTarget.session_id,
        activeRevision: preBinding.active_revision,
      });
      if (currentResourceScope !== expectedResourceScope) {
        throw new TaskChannelError('stale_active_revision', 'captured resource scope changed');
      }
    }

    if (!await this.authorize(e.identity, e.destination, preTarget.session_id || null)) {
      throw new TaskChannelError('unauthorized', 'target authorization denied');
    }

    let steerTurnId: string | null = null;
    let steerConnGen: number | null = null;
    let steerCtrlGen: number | null = null;
    if (a.action === 'input' && a.mode === 'steer' && preTarget.access_mode === 'interactive' && this.service.captureSteer) {
      try {
        const cap = await this.service.captureSteer(e.identity, preTarget.session_id);
        steerTurnId = cap.turnId;
        steerConnGen = cap.connectionGeneration;
        steerCtrlGen = cap.controlGeneration;
      } catch {
        // Leave null so drain records explicit rejection without leaking unhandled error at intake.
      }
    }

    const serializedAction = JSON.stringify(
      a.action === 'attachment' ? { ...a, content: Array.from(a.content) } : a,
    );
    const serializedEnvelope = JSON.stringify(e);
    const actionDigest = payloadDigest({
      destination: e.destination,
      identity: e.identity,
      action: JSON.parse(serializedAction),
    });

    return this.tx(() => {
      const existing = this.db
        .prepare('SELECT action_digest, state, target_id, session_id FROM task_inbox_scope_v1 WHERE event_id = ?')
        .get(e.eventId) as
        | { action_digest: string; state: string; target_id: string; session_id: string }
        | undefined;
      if (existing) {
        if (existing.action_digest !== actionDigest) {
          throw new TaskChannelError('idempotency_conflict', 'event idempotency conflict');
        }
        return {
          eventId: e.eventId,
          state: existing.state,
          capturedTargetId: existing.target_id,
          sessionId: existing.session_id,
        };
      }

      const binding = this.getBindingRowByDestination(e.destination);
      if (!binding || binding.state !== 'active' || binding.root_generation !== preBinding.root_generation) {
        throw new TaskChannelError('task_closed', 'task binding changed during intake');
      }
      if (binding.owner_source !== e.identity.source || binding.owner_subject !== e.identity.subject) {
        throw new TaskChannelError('unauthorized', 'task owner changed during intake');
      }
      const target = this.resolveTargetForIntake(binding, a, isCard);
      if (
        target.target_id !== preTarget.target_id ||
        target.target_generation !== preTarget.target_generation ||
        target.session_id !== preTarget.session_id ||
        binding.active_revision !== preBinding.active_revision
      ) {
        throw new TaskChannelError('stale_active_revision', 'task target changed during intake');
      }

      this.db
        .prepare(
          "INSERT INTO task_inbox_scope_v1(event_id, task_id, destination, root_generation, task_revision, target_id, target_generation, session_id, active_revision, owner_source, owner_subject, action_digest, state, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', NULL)",
        )
        .run(
          e.eventId,
          binding.task_id,
          binding.destination,
          binding.root_generation,
          binding.task_revision,
          target.target_id,
          target.target_generation,
          target.session_id,
          binding.active_revision,
          binding.owner_source,
          binding.owner_subject,
          actionDigest,
        );
      this.db
        .prepare(
          'INSERT INTO task_inbox_payloads_v1(event_id, envelope, action, steer_turn_id, steer_connection_generation, steer_control_generation) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(e.eventId, serializedEnvelope, serializedAction, steerTurnId, steerConnGen, steerCtrlGen);

      return {
        eventId: e.eventId,
        state: 'received',
        capturedTargetId: target.target_id,
        sessionId: target.session_id,
      };
    });
  }

  /**
   * Drain a previously captured inbox item strictly using its persisted captured target
   * (`task_inbox_scope_v1`), NEVER re-reading `task_bindings_v1.active_target_id`.
   */
  async drain(eventId: string): Promise<unknown> {
    const scope = this.db
      .prepare('SELECT task_id FROM task_inbox_scope_v1 WHERE event_id = ?')
      .get(eventId) as { task_id: string } | undefined;
    if (!scope) throw new TaskChannelError('invalid_request', 'task inbox event not found');
    return this.withTaskLock(scope.task_id, () => this.drainLocked(eventId));
  }

  private async drainLocked(eventId: string): Promise<unknown> {
    const row = this.db
      .prepare('SELECT * FROM task_inbox_scope_v1 WHERE event_id = ?')
      .get(eventId) as InboxRow | undefined;
    if (!row) throw new TaskChannelError('invalid_request', 'task inbox event not found');
    if (row.state !== 'received') {
      return row.result ? JSON.parse(row.result) : { status: 'unknown' };
    }

    const payload = this.db
      .prepare('SELECT * FROM task_inbox_payloads_v1 WHERE event_id = ?')
      .get(eventId) as
      | {
          envelope: string;
          action: string;
          steer_turn_id: string | null;
          steer_connection_generation: number | null;
          steer_control_generation: number | null;
        }
      | undefined;
    if (!payload) throw new TaskChannelError('invalid_request', 'task inbox payload missing');

    const e = JSON.parse(payload.envelope) as TrustedEnvelope;
    const rawAction = JSON.parse(payload.action) as TaskChannelAction;
    const a: TaskChannelAction =
      rawAction.action === 'attachment'
        ? { ...rawAction, content: Uint8Array.from(rawAction.content as unknown as number[]) }
        : rawAction;

    const finalize = (state: 'completed' | 'rejected' | 'expired', result: unknown): unknown => {
      this.db
        .prepare('UPDATE task_inbox_scope_v1 SET state = ?, result = ? WHERE event_id = ?')
        .run(state, JSON.stringify(result ?? null), eventId);
      return result;
    };

    const verifyCapturedTarget = async (): Promise<
      { ok: true; binding: BindingRow; target: TargetRow | null } | { ok: false; status: 'expired' | 'rejected'; reason: string }
    > => {
      const binding = this.getBindingRow(row.task_id);
      if (
        !binding ||
        binding.state !== 'active' ||
        binding.destination !== row.destination ||
        binding.root_generation !== row.root_generation ||
        binding.owner_source !== row.owner_source ||
        binding.owner_subject !== row.owner_subject
      ) {
        return { ok: false, status: 'expired', reason: 'task_binding_changed' };
      }

      if (a.action === 'panel' && row.target_id === '') {
        const allowed = await this.authorize(e.identity, e.destination, null);
        if (!allowed) return { ok: false, status: 'rejected', reason: 'unauthorized' };
        return { ok: true, binding, target: null };
      }

      // Strictly look up the CAPTURED target_id — NEVER read binding.active_target_id!
      const target = this.getTargetRow(row.task_id, row.target_id);
      if (
        !target ||
        target.state !== 'active' ||
        target.target_generation !== row.target_generation ||
        target.session_id !== row.session_id
      ) {
        return { ok: false, status: 'expired', reason: 'captured_target_changed_or_revoked' };
      }
      const allowed = await this.authorize(e.identity, e.destination, row.session_id);
      if (!allowed) return { ok: false, status: 'rejected', reason: 'unauthorized' };

      const recheckBinding = this.getBindingRow(row.task_id);
      const recheckTarget = this.getTargetRow(row.task_id, row.target_id);
      if (
        !recheckBinding ||
        recheckBinding.state !== 'active' ||
        recheckBinding.root_generation !== row.root_generation ||
        !recheckTarget ||
        recheckTarget.state !== 'active' ||
        recheckTarget.target_generation !== row.target_generation ||
        recheckTarget.session_id !== row.session_id
      ) {
        return { ok: false, status: 'expired', reason: 'captured_target_changed' };
      }
      return { ok: true, binding: recheckBinding, target: recheckTarget };
    };

    const check = await verifyCapturedTarget();
    if (!check.ok) {
      return finalize(check.status, { status: check.status, reason: check.reason });
    }

    const writeActions = new Set([
      'input',
      'answer',
      'answer_form',
      'attachment',
      'stop',
      'settings',
      'cancel',
    ]);
    if (check.target && check.target.access_mode !== 'interactive' && writeActions.has(a.action)) {
      const res = { status: 'rejected', reason: 'read_only_target', targetId: check.target.target_id };
      finalize('rejected', res);
      await this.deliverCard(
        e.destination,
        row.task_id,
        row.target_id,
        {
          title: `${providerTitlePrefix(check.target.provider)} · 操作未执行`,
          text: '此目标当前为只读模式，不能提交输入、答复或更改控制设置。',
          actions: [],
        },
        `${eventId}:readonly-rejected`,
      );
      return res;
    }

    if (a.action === 'switch_target') {
      const claim = this.db
        .prepare("UPDATE task_inbox_scope_v1 SET state = 'unknown' WHERE event_id = ? AND state = 'received'")
        .run(eventId);
      if (!claim.changes) return { status: 'unknown' };
      try {
        const nextBinding = await this.switchActiveTarget({
          taskId: row.task_id,
          targetId: row.target_id,
          expectedActiveRevision: row.active_revision,
          expectedRootGeneration: row.root_generation,
          owner: e.identity,
        });
        const targets = this.listTargets(row.task_id);
        await this.deliverCard(
          e.destination,
          row.task_id,
          row.target_id,
          taskPanelCard(nextBinding, targets),
          `${eventId}:switched`,
        );
        return finalize('completed', nextBinding);
      } catch (error) {
        const reason = error instanceof TaskChannelError ? error.code : 'switch_failed';
        return finalize('rejected', { status: 'rejected', reason });
      }
    }

    if (a.action === 'panel') {
      const claim = this.db
        .prepare("UPDATE task_inbox_scope_v1 SET state = 'unknown' WHERE event_id = ? AND state = 'received'")
        .run(eventId);
      if (!claim.changes) return { status: 'unknown' };
      const targets = this.listTargets(row.task_id);
      const card = taskPanelCard(toBinding(check.binding), targets);
      await this.deliverCard(e.destination, row.task_id, null, card, `${eventId}:panel`);
      return finalize('completed', {
        status: 'completed',
        activeTargetId: check.binding.active_target_id,
        activeRevision: check.binding.active_revision,
        targets,
      });
    }

    const target = check.target!;
    const session = await this.service.getSession(row.session_id);
    const afterSession = await verifyCapturedTarget();
    if (!afterSession.ok) {
      return finalize(afterSession.status, { status: afterSession.status, reason: afterSession.reason });
    }
    if (afterSession.target && afterSession.target.access_mode !== 'interactive' && writeActions.has(a.action)) {
      return finalize('rejected', { status: 'rejected', reason: 'read_only_target', targetId: row.target_id });
    }

    // Validate steer / answer_form before setting state='unknown' so definite stale/invalid errors don't stick as unknown.
    let resolvedFormAnswer: ReturnType<typeof decodeQuestionForm> | undefined;
    if (a.action === 'answer_form') {
      const interaction = await this.service.getInteraction(a.interactionId);
      if (interaction.sessionId !== row.session_id) {
        return finalize('rejected', { status: 'rejected', reason: 'interaction_target_mismatch' });
      }
      try {
        resolvedFormAnswer = decodeQuestionForm(
          a,
          a.fields,
          interaction,
          interactionFormBindingId(row.task_id, row.target_id, row.target_generation),
          false,
        );
      } catch {
        return finalize('rejected', { status: 'rejected', reason: 'invalid_or_expired_form' });
      }
    } else if (a.action === 'answer') {
      const interaction = await this.service.getInteraction(a.interactionId);
      if (interaction.sessionId !== row.session_id) {
        return finalize('rejected', { status: 'rejected', reason: 'interaction_target_mismatch' });
      }
    }

    if (a.action === 'input' && a.mode === 'steer' && (!payload.steer_turn_id || payload.steer_connection_generation === null || payload.steer_control_generation === null || session.control.generation !== payload.steer_control_generation)) {
      return finalize('rejected', { status: 'rejected', reason: 'steer_unavailable' });
    }

    const claim = this.db
      .prepare("UPDATE task_inbox_scope_v1 SET state = 'unknown' WHERE event_id = ? AND state = 'received'")
      .run(eventId);
    if (!claim.changes) return { status: 'unknown' };

    const makeContext = (rev: number, ctrlGen: number): WriteContext => {
      const digest = createHash('sha256')
        .update(
          JSON.stringify([
            row.destination,
            row.event_id,
            row.task_id,
            row.target_id,
            row.target_generation,
            row.session_id,
          ]),
        )
        .digest('hex');
      return {
        operationId: `task:${digest}`,
        idempotencyKey: `task:${digest}`,
        targetId: row.session_id,
        expectedRevision: rev,
        controlGeneration: ctrlGen,
        identity: e.identity,
      };
    };

    try {
      let result: unknown;
      if (a.action === 'input') {
        const op = await this.service.submitInput({
          context: makeContext(
            session.revision,
            a.mode === 'steer' ? payload.steer_control_generation! : session.control.generation,
          ),
          mode: a.mode,
          blocks: [{ type: 'text', text: a.text }],
          ...(a.mode === 'steer'
            ? {
                requiredTurnId: payload.steer_turn_id!,
                expectedConnectionGeneration: payload.steer_connection_generation!,
              }
            : {}),
        });
        result = op;
      } else if (a.action === 'answer') {
        const op = await this.service.resolveInteraction({
          context: makeContext(a.revision, a.controlGeneration ?? session.control.generation),
          interactionId: a.interactionId,
          expectedConnectionGeneration: a.connectionGeneration,
          answer: a.answer,
          toolInputDigest: a.toolInputDigest,
        });
        result = op;
      } else if (a.action === 'answer_form') {
        const op = await this.service.resolveInteraction({
          context: makeContext(
            resolvedFormAnswer!.revision,
            a.controlGeneration ?? session.control.generation,
          ),
          interactionId: resolvedFormAnswer!.interactionId,
          expectedConnectionGeneration: resolvedFormAnswer!.connectionGeneration,
          answer: resolvedFormAnswer!.answer,
          toolInputDigest: null,
        });
        result = op;
      } else if (a.action === 'stop') {
        const op = await this.service.interruptTurn({
          context: makeContext(a.revision, a.controlGeneration),
          payload: { turnId: a.turnId },
        });
        result = op;
      } else if (a.action === 'settings') {
        const op = await this.service.updateSessionSettings({
          context: makeContext(a.revision, a.controlGeneration),
          payload: { model: a.model, preferences: a.preferences },
        });
        result = op;
      } else if (a.action === 'cancel') {
        const op = await this.service.cancelQueuedInput({
          context: makeContext(a.revision, a.controlGeneration),
          payload: { inputId: a.inputId },
        });
        result = op;
      } else if (a.action === 'attachment') {
        const digest = createHash('sha256').update(a.content).digest('hex');
        const stageOp = await this.service.stageInputArtifact({
          context: makeContext(session.revision, session.control.generation),
          payload: {
            name: a.name,
            mediaType: a.mediaType,
            size: a.content.byteLength,
            contentDigest: digest,
            content: a.content,
          },
        });
        if (stageOp.result?.kind === 'artifact') {
          const refreshed = await this.service.getSession(row.session_id);
          const submitId = `task-attach:${eventId}`;
          result = await this.service.submitInput({
            context: {
              operationId: submitId,
              idempotencyKey: submitId,
              targetId: row.session_id,
              expectedRevision: refreshed.revision,
              controlGeneration: refreshed.control.generation,
              identity: e.identity,
            },
            mode: a.mode,
            blocks: [
              {
                type: 'artifact',
                artifactId: stageOp.result.artifactId,
                contentVersion: stageOp.result.contentVersion,
              },
            ],
          });
        } else {
          result = stageOp;
        }
      } else if (a.action === 'history') {
        const page = await this.service.readHistory(row.session_id, {
          limit: 20,
          ...(a.cursor ? { cursor: a.cursor } : {}),
        });
        const label = providerTitlePrefix(target.provider);
        await this.deliverCard(
          e.destination,
          row.task_id,
          row.target_id,
          {
            title: `${label} · 历史`,
            text: page.items
              .map((m) => `${m.role}: ${m.blocks.map((b) => (b.type === 'text' ? b.text : `[文件 ${b.artifactId}]`)).join(' ')}`)
              .join('\n') || '暂无历史记录。',
            actions: page.nextCursor
              ? [
                  {
                    label: '下一页',
                    value: {
                      action: 'history',
                      taskId: row.task_id,
                      rootGeneration: row.root_generation,
                      activeRevision: check.binding.active_revision,
                      targetId: row.target_id,
                      targetGeneration: row.target_generation,
                      sessionId: row.session_id,
                      cursor: page.nextCursor,
                    },
                  },
                ]
              : [],
          },
          `${eventId}:history`,
        );
        result = page;
      } else if (a.action === 'artifacts') {
        const page = await this.service.listArtifacts(row.session_id, { limit: 100 });
        const label = providerTitlePrefix(target.provider);
        await this.deliverCard(
          e.destination,
          row.task_id,
          row.target_id,
          {
            title: `${label} · 文件`,
            text: page.items.map((f) => `${f.name} (${f.contentVersion})`).join('\n') || '暂无文件。',
            actions: page.items.map((f) => ({
              label: f.name,
              value: {
                action: 'file',
                taskId: row.task_id,
                rootGeneration: row.root_generation,
                activeRevision: check.binding.active_revision,
                targetId: row.target_id,
                targetGeneration: row.target_generation,
                sessionId: row.session_id,
                artifactId: f.artifactId,
                contentVersion: f.contentVersion,
              },
            })),
          },
          `${eventId}:artifacts`,
        );
        result = page;
      } else if (a.action === 'file') {
        const page = await this.service.listArtifacts(row.session_id, { limit: 100 });
        const file = page.items.find(
          (f) => f.artifactId === a.artifactId && f.contentVersion === a.contentVersion,
        );
        if (!file) return finalize('rejected', { status: 'rejected', reason: 'artifact_not_found' });
        const bytes = await this.service.readArtifact(row.session_id, file.artifactId, file.contentVersion);
        const deliveryId = `task-file:${payloadDigest([row.task_id, row.target_id, row.target_generation, file.artifactId, file.contentVersion])}`;
        if (
          this.db
            .prepare("INSERT OR IGNORE INTO task_deliveries_v1(delivery_id, task_id, target_id, state) VALUES (?, ?, ?, 'unknown')")
            .run(deliveryId, row.task_id, row.target_id).changes
        ) {
          await this.port.sendFile(e.destination, file.name, bytes, deliveryId);
          this.db.prepare("UPDATE task_deliveries_v1 SET state = 'sent' WHERE delivery_id = ?").run(deliveryId);
        }
        result = { deliveryId, status: 'sent' };
      } else if (a.action === 'models') {
        const page = await this.service.listModels(row.session_id, {
          limit: 100,
          ...(a.cursor ? { cursor: a.cursor } : {}),
        });
        const label = providerTitlePrefix(target.provider);
        await this.deliverCard(
          e.destination,
          row.task_id,
          row.target_id,
          {
            title: `${label} · 模型`,
            text: page.items.map((m) => m.label).join('\n') || '暂无可选模型。',
            actions: [],
          },
          `${eventId}:models`,
        );
        result = page;
      }

      if ((a.action === 'answer' || a.action === 'answer_form') && result && (result as Operation).status !== 'failed' && (result as Operation).status !== 'unknown') {
        try {
          const updatedInteraction = await this.service.getInteraction(a.interactionId);
          const currentBinding = this.getBindingRow(row.task_id);
          const currentTarget = this.getTargetRow(row.task_id, row.target_id);
          if (currentBinding && currentTarget && currentTarget.state === 'active') {
            await this.renderInteraction(
              currentBinding,
              currentTarget,
              updatedInteraction,
              session.control.generation,
            );
          }
        } catch {
          // Best-effort card refresh after interaction resolution; core result is already durable.
        }
      }

      return finalize('completed', result);
    } catch (error) {
      const detail =
        error && typeof error === 'object' && 'detail' in error
          ? (error as { detail?: { code?: string } }).detail
          : undefined;
      if (
        detail?.code &&
        [
          'busy',
          'stale_revision',
          'control_conflict',
          'unsupported',
          'interaction_expired',
          'unauthorized',
          'invalid_request',
        ].includes(detail.code)
      ) {
        const rejected = { status: 'rejected', reason: detail.code };
        await this.deliverCard(
          e.destination,
          row.task_id,
          row.target_id,
          operationCard({
            operationId: eventId,
            idempotencyKey: eventId,
            targetId: row.session_id,
            action: a.action,
            payloadDigest: row.action_digest,
            status: 'failed',
            revision: 0,
            error: contractError(detail.code as ErrorCode),
          }),
          `${eventId}:rejected`,
        );
        return finalize('rejected', rejected);
      }
      throw error;
    }
  }

  async handle(
    e: TrustedEnvelope,
    a: TaskChannelAction,
    expectedResourceScope?: string,
  ): Promise<unknown> {
    await this.intake(e, a, expectedResourceScope);
    return this.drain(e.eventId);
  }

  private async deliverCard(
    destination: string,
    taskId: string,
    targetId: string | null,
    card: ChannelCard,
    deliveryId: string,
    guard?: () => Promise<void>,
  ): Promise<string | void> {
    await guard?.();
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO task_deliveries_v1(delivery_id, task_id, target_id, state) VALUES (?, ?, ?, 'unknown')",
      )
      .run(deliveryId, taskId, targetId);
    if (!inserted.changes) return undefined;
    const messageId = await this.port.send(destination, card, deliveryId, guard);
    await guard?.();
    this.db.prepare("UPDATE task_deliveries_v1 SET state = 'sent' WHERE delivery_id = ?").run(deliveryId);
    return messageId;
  }

  private async verifySyncTarget(binding: BindingRow, target: TargetRow): Promise<void> {
    const currentBinding = this.getBindingRow(binding.task_id);
    const currentTarget = this.getTargetRow(binding.task_id, target.target_id);
    if (
      !currentBinding ||
      currentBinding.state !== 'active' ||
      currentBinding.root_generation !== binding.root_generation ||
      currentBinding.owner_source !== binding.owner_source ||
      currentBinding.owner_subject !== binding.owner_subject ||
      !currentTarget ||
      currentTarget.state !== 'active' ||
      currentTarget.target_generation !== target.target_generation ||
      currentTarget.session_id !== target.session_id ||
      currentTarget.access_mode !== target.access_mode
    ) {
      throw new TaskChannelError('stale_revision', 'task target changed during sync');
    }
    const allowed = await this.authorize(
      { source: currentBinding.owner_source, subject: currentBinding.owner_subject },
      currentBinding.destination,
      currentTarget.session_id,
    );
    if (!allowed) {
      throw new TaskChannelError('unauthorized', 'task target authorization revoked');
    }
  }

  protected async renderStreamMessage(
    binding: BindingRow,
    target: TargetRow,
    scope: string,
    message: Message,
    turnCompleted = false,
  ): Promise<void> {
    const sequence = Number.isSafeInteger(message.sequence) ? message.sequence : 0;
    const turnKey = message.turnId || message.messageId;
    const guard = () => this.verifySyncTarget(binding, target);
    await guard();

    const row = this.db
      .prepare(
        'SELECT card_id, revision, updated_at, final, message_id, latest_sequence FROM task_stream_cards_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND turn_key = ?',
      )
      .get(binding.task_id, target.target_id, target.target_generation, target.session_id, turnKey) as
      | {
          card_id: string | null;
          revision: number;
          updated_at: number;
          final: number;
          message_id: string;
          latest_sequence: number;
        }
      | undefined;

    if (row && (sequence < row.latest_sequence || (row.message_id !== message.messageId && sequence === row.latest_sequence))) {
      return;
    }
    if (
      row &&
      row.message_id === message.messageId &&
      ((row.final && !message.final) || (row.revision >= message.revision && !turnCompleted))
    ) {
      return;
    }
    if (row && !message.final && Date.now() - row.updated_at < this.streamThrottleMs) {
      if (row.message_id !== message.messageId) {
        this.db
          .prepare(
            'UPDATE task_stream_cards_v1 SET message_id = ?, latest_sequence = ?, revision = 0, final = 0 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND turn_key = ?',
          )
          .run(
            message.messageId,
            sequence,
            binding.task_id,
            target.target_id,
            target.target_generation,
            target.session_id,
            turnKey,
          );
      }
      return;
    }

    const label = providerTitlePrefix(target.provider);
    const body = message.blocks
      .map((b) => (b.type === 'text' ? b.text : `[文件 ${b.artifactId}]`))
      .join('\n');
    const title = message.final
      ? turnCompleted
        ? `${label} · 回复 · 本轮已完成`
        : `${label} · 回复`
      : `${label} · 回复中`;
    const text = `来源: ${label} (${target.target_id})\n${[...body].slice(0, 3000).join('')}`;
    const card: ChannelCard = { title, text, actions: [] };

    await guard();
    if (!row) {
      const deliveryId = `task-stream:${payloadDigest([
        scope,
        binding.destination,
        target.target_id,
        target.target_generation,
        target.session_id,
        turnKey,
      ])}`;
      this.db
        .prepare(
          'INSERT INTO task_stream_cards_v1(task_id, destination, target_id, target_generation, session_id, turn_key, message_id, card_id, revision, updated_at, final, latest_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, ?)',
        )
        .run(
          binding.task_id,
          binding.destination,
          target.target_id,
          target.target_generation,
          target.session_id,
          turnKey,
          message.messageId,
          sequence,
        );
      const cardId = await this.deliverCard(
        binding.destination,
        binding.task_id,
        target.target_id,
        card,
        deliveryId,
        guard,
      );
      await guard();
      if (cardId) {
        this.db
          .prepare(
            'UPDATE task_stream_cards_v1 SET card_id = ?, revision = ?, updated_at = ?, final = ?, message_id = ?, latest_sequence = ? WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND turn_key = ?',
          )
          .run(
            cardId,
            message.revision,
            Date.now(),
            Number(message.final),
            message.messageId,
            sequence,
            binding.task_id,
            target.target_id,
            target.target_generation,
            target.session_id,
            turnKey,
          );
      }
      return;
    }

    if (!row.card_id) return;
    const updateId = `task-stream-update:${payloadDigest([
      scope,
      binding.destination,
      target.target_id,
      target.target_generation,
      target.session_id,
      message.messageId,
      message.revision,
      turnCompleted,
    ])}`;
    if (
      !this.db
        .prepare(
          "INSERT OR IGNORE INTO task_deliveries_v1(delivery_id, task_id, target_id, state) VALUES (?, ?, ?, 'unknown')",
        )
        .run(updateId, binding.task_id, target.target_id).changes
    ) {
      return;
    }
    await guard();
    await this.port.update(binding.destination, row.card_id, card, updateId, guard);
    await guard();
    this.db.prepare("UPDATE task_deliveries_v1 SET state = 'sent' WHERE delivery_id = ?").run(updateId);
    this.db
      .prepare(
        'UPDATE task_stream_cards_v1 SET revision = ?, updated_at = ?, final = ?, message_id = ?, latest_sequence = ? WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND turn_key = ?',
      )
      .run(
        message.revision,
        Date.now(),
        Number(message.final),
        message.messageId,
        sequence,
        binding.task_id,
        target.target_id,
        target.target_generation,
        target.session_id,
        turnKey,
      );
  }

  private async renderInteraction(
    binding: BindingRow,
    target: TargetRow,
    interaction: Interaction,
    controlGeneration: number,
  ): Promise<void> {
    const guard = () => this.verifySyncTarget(binding, target);
    await guard();

    const row = this.db
      .prepare(
        'SELECT revision, active_revision, message_id, signature FROM task_interaction_cards_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND interaction_id = ?',
      )
      .get(
        binding.task_id,
        target.target_id,
        target.target_generation,
        target.session_id,
        interaction.interactionId,
      ) as
      | {
          revision: number;
          active_revision: number;
          message_id: string;
          signature: string;
        }
      | undefined;

    if (!row && interaction.status !== 'awaiting_answer' && interaction.status !== 'answer_pending_delivery') {
      return;
    }

    const latestBinding = this.getBindingRow(binding.task_id) ?? binding;
    const card = taskInteractionCard(
      toBinding(latestBinding),
      toTarget(target),
      interaction,
      controlGeneration,
    );
    const signature = payloadDigest(card);
    if (row && row.revision > interaction.revision) return;
    if (
      row &&
      row.revision === interaction.revision &&
      row.active_revision === latestBinding.active_revision &&
      row.signature === signature
    ) {
      return;
    }

    const deliveryId = `task-interaction:${payloadDigest([
      binding.task_id,
      binding.root_generation,
      target.target_id,
      target.target_generation,
      target.session_id,
      interaction.interactionId,
      interaction.revision,
      latestBinding.active_revision,
      signature,
    ])}`;

    if (row) {
      if (
        !this.db
          .prepare(
            "INSERT OR IGNORE INTO task_deliveries_v1(delivery_id, task_id, target_id, state) VALUES (?, ?, ?, 'unknown')",
          )
          .run(deliveryId, binding.task_id, target.target_id).changes
      ) {
        if ((await this.port.lookupDelivery?.(deliveryId)) === 'sent') {
          await guard();
          this.db.prepare("UPDATE task_deliveries_v1 SET state = 'sent' WHERE delivery_id = ?").run(deliveryId);
          this.db
            .prepare(
              'UPDATE task_interaction_cards_v1 SET revision = ?, active_revision = ?, signature = ? WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND interaction_id = ?',
            )
            .run(
              interaction.revision,
              latestBinding.active_revision,
              signature,
              binding.task_id,
              target.target_id,
              target.target_generation,
              target.session_id,
              interaction.interactionId,
            );
        }
        return;
      }
      await guard();
      await this.port.update(binding.destination, row.message_id, card, deliveryId, guard);
      await guard();
      this.db.prepare("UPDATE task_deliveries_v1 SET state = 'sent' WHERE delivery_id = ?").run(deliveryId);
      this.db
        .prepare(
          'UPDATE task_interaction_cards_v1 SET revision = ?, active_revision = ?, signature = ? WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND interaction_id = ?',
        )
        .run(
          interaction.revision,
          latestBinding.active_revision,
          signature,
          binding.task_id,
          target.target_id,
          target.target_generation,
          target.session_id,
          interaction.interactionId,
        );
    } else {
      let messageId = await this.deliverCard(
        binding.destination,
        binding.task_id,
        target.target_id,
        card,
        deliveryId,
        guard,
      );
      await guard();
      if (!messageId) messageId = (await this.port.lookupMessageId?.(deliveryId)) ?? undefined;
      await guard();
      if (messageId) {
        this.db
          .prepare(
            'INSERT OR REPLACE INTO task_interaction_cards_v1(task_id, destination, target_id, target_generation, session_id, interaction_id, revision, active_revision, message_id, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            binding.task_id,
            binding.destination,
            target.target_id,
            target.target_generation,
            target.session_id,
            interaction.interactionId,
            interaction.revision,
            latestBinding.active_revision,
            messageId,
            signature,
          );
      }
    }
  }

  /**
   * Synchronize all active targets mounted on `taskId` with isolated per-target cursors
   * and stream/interaction cards. A failure in one provider target never blocks other targets.
   */
  async syncTask(taskId: string): Promise<{
    syncedTargets: string[];
    failedTargets: Array<{ targetId: string; provider: Provider; reason: string }>;
  }> {
    const binding = this.getBindingRow(taskId);
    if (!binding || binding.state !== 'active') {
      throw new TaskChannelError('task_not_found', 'active task binding not found');
    }
    const targets = this.db
      .prepare("SELECT * FROM task_targets_v1 WHERE task_id = ? AND state = 'active' ORDER BY rowid")
      .all(taskId) as unknown as TargetRow[];

    const syncedTargets: string[] = [];
    const failedTargets: Array<{ targetId: string; provider: Provider; reason: string }> = [];

    for (const target of targets) {
      try {
        await this.syncSingleTarget(binding, target);
        syncedTargets.push(target.target_id);
      } catch (error) {
        failedTargets.push({
          targetId: target.target_id,
          provider: target.provider,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { syncedTargets, failedTargets };
  }

  async syncDestination(destination: string): Promise<{
    syncedTargets: string[];
    failedTargets: Array<{ targetId: string; provider: Provider; reason: string }>;
  }> {
    const binding = this.getBindingRowByDestination(destination);
    if (!binding || binding.state !== 'active') {
      throw new TaskChannelError('task_not_found', 'active task binding not found for destination');
    }
    return this.syncTask(binding.task_id);
  }

  private async syncSingleTarget(binding: BindingRow, target: TargetRow): Promise<void> {
    const scope = targetBindingScope(binding, target);
    const guard = () => this.verifySyncTarget(binding, target);
    await guard();

    // Reconcile existing interaction cards (also catches terminal resolutions or active_revision bumps).
    const existingCards = this.db
      .prepare(
        'SELECT interaction_id FROM task_interaction_cards_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ?',
      )
      .all(binding.task_id, target.target_id, target.target_generation, target.session_id) as Array<{
      interaction_id: string;
    }>;
    const sessionForCards = await this.service.getSession(target.session_id);
    await guard();
    for (const row of existingCards) {
      const interaction = await this.service.getInteraction(row.interaction_id);
      await guard();
      if (interaction.sessionId !== target.session_id) continue;
      await this.renderInteraction(binding, target, interaction, sessionForCards.control.generation);
    }

    const cursorRow = this.db
      .prepare(
        'SELECT cursor FROM task_cursors_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND binding_scope = ?',
      )
      .get(binding.task_id, target.target_id, target.target_generation, target.session_id, scope) as
      | { cursor: string }
      | undefined;

    let cursor = cursorRow?.cursor;
    let expired = false;

    if (cursor) {
      const events = await this.service.subscribeEvents(target.session_id, cursor, 100);
      await guard();
      if (events.status === 'events') {
        const snapshot = await this.service.getSnapshot(target.session_id);
        await guard();
        for (const interaction of snapshot.value.interactions) {
          await this.renderInteraction(
            binding,
            target,
            interaction,
            snapshot.value.session.control.generation,
          );
        }
        for (const event of events.events) {
          await guard();
          if (event.type === 'message.updated') {
            const msg = snapshot.value.messages.find(
              (m) => m.messageId === event.objectId && m.role === 'assistant',
            );
            if (!msg) continue;
            const known = this.db
              .prepare(
                'SELECT revision FROM task_known_messages_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND message_id = ?',
              )
              .get(binding.task_id, target.target_id, target.target_generation, target.session_id, msg.messageId) as
              | { revision: number }
              | undefined;
            if (known && known.revision >= msg.revision) continue;
            await this.renderStreamMessage(binding, target, scope, msg);
            if (msg.final) {
              this.db
                .prepare(
                  'INSERT OR REPLACE INTO task_known_messages_v1(task_id, target_id, target_generation, session_id, message_id, revision) VALUES (?, ?, ?, ?, ?, ?)',
                )
                .run(
                  binding.task_id,
                  target.target_id,
                  target.target_generation,
                  target.session_id,
                  msg.messageId,
                  msg.revision,
                );
            }
          } else if (event.type === 'turn.updated') {
            const data = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {};
            if (data.status === 'completed') {
              const turnId = typeof data.turnId === 'string' ? data.turnId : event.objectId;
              const finalMsg = snapshot.value.messages
                .filter((m) => m.turnId === turnId && m.role === 'assistant' && m.final)
                .sort((a, b) => b.sequence - a.sequence)[0];
              if (finalMsg) {
                await this.renderStreamMessage(binding, target, scope, finalMsg, true);
              }
            }
          }
        }
        cursor = events.cursor;
      } else {
        cursor = undefined;
        expired = true;
      }
    }

    if (!cursor) {
      const snapshot = await this.service.getSnapshot(target.session_id);
      await guard();
      for (const msg of snapshot.value.messages) {
        const known = this.db
          .prepare(
            'SELECT revision FROM task_known_messages_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND message_id = ?',
          )
          .get(binding.task_id, target.target_id, target.target_generation, target.session_id, msg.messageId) as
          | { revision: number }
          | undefined;
        if (expired && msg.role === 'assistant' && (!known || known.revision < msg.revision)) {
          await this.renderStreamMessage(binding, target, scope, msg);
        }
        if (!expired || msg.final) {
          this.db
            .prepare(
              'INSERT OR REPLACE INTO task_known_messages_v1(task_id, target_id, target_generation, session_id, message_id, revision) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(
              binding.task_id,
              target.target_id,
              target.target_generation,
              target.session_id,
              msg.messageId,
              msg.revision,
            );
        }
      }
      for (const interaction of snapshot.value.interactions) {
        await this.renderInteraction(
          binding,
          target,
          interaction,
          snapshot.value.session.control.generation,
        );
      }
      cursor = snapshot.cursor;
    }

    await guard();
    this.db
      .prepare(
        'INSERT OR REPLACE INTO task_cursors_v1(task_id, target_id, target_generation, session_id, cursor, binding_scope) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        binding.task_id,
        target.target_id,
        target.target_generation,
        target.session_id,
        cursor,
        scope,
      );
  }
}
