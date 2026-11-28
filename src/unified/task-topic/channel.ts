import { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from '../adapter.js';
import type { ChannelInputScope, Identity, Message, NativeSessionRef, Operation, Provider } from '../contracts.js';
import type { FeishuPort, TrustedEnvelope } from '../feishu-channel.js';
import type { TaskTopicToken } from '../task-topic-store.js';
import { eventSequence } from '../turn-card-delivery.js';
import { drainTaskEventLocked } from './drain.js';
import { captureTaskResourceScope, intakeTaskEvent } from './intake.js';
import {
  ensureTaskTopicSchema,
  getBindingRow,
  getBindingRowByDestination,
  getTargetRow,
  taskInputScope,
  runTransaction,
} from './schema.js';
import {
  renderTaskInteraction,
  renderTaskStreamMessage,
  syncAllTaskTargets,
  type TaskSyncDeps,
} from './sync.js';
import {
  counter,
  nonempty,
  TaskChannelError,
  toBinding,
  toTarget,
  VALID_PROVIDERS,
  type BindingRow,
  type InboxRow,
  type TargetRow,
  type TaskAccessMode,
  type TaskAuthorize,
  type TaskBindingRecord,
  type TaskChannelAction,
  type TaskCursorRecord,
  type TaskInboxRecord,
  type TaskTargetRecord,
  type TaskTopicChannelOptions,
} from './types.js';

/**
 * T1: Multi-backend (claude / codex / agy) task topic channel with explicit activeTarget CAS,
 * ingress target capture, per-target cursors, non-colliding stream cards, and cross-target
 * interaction routing. Only creates additive `task_*` tables; safe to co-locate in channel.sqlite.
 */
export class TaskTopicChannel {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly taskLocks = new Map<string, Promise<void>>();
  private readonly interactionLocks = new Map<string, Promise<void>>();
  private readonly streamThrottleMs: number;
  private closed = false;
  private readonly unregisterInputScope: (() => void) | undefined;

  constructor(
    private readonly service: UnifiedService,
    private readonly port: FeishuPort,
    private readonly authorize: TaskAuthorize,
    dbOrPath: string | DatabaseSync,
    private readonly options: TaskTopicChannelOptions = {},
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
    ensureTaskTopicSchema(this.db);
    const unregister = service.registerInputScopeValidator?.((scope,id) => this.isCurrentInputScope(scope,id));
    if (typeof unregister === 'function') this.unregisterInputScope = unregister;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unregisterInputScope?.();
    if (this.ownsDb) this.db.close();
  }

  private tx<T>(fn: () => T): T {
    return runTransaction(this.db, fn);
  }

  private async withLock<T>(locks: Map<string, Promise<void>>, key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => lock);
    locks.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === tail) {
        locks.delete(key);
      }
    }
  }

  private syncDeps(): TaskSyncDeps {
    return {
      db: this.db,
      service: this.service,
      port: this.port,
      authorize: this.authorize,
      streamThrottleMs: this.streamThrottleMs,
      withInteractionLock: (key, run) => this.withLock(this.interactionLocks, key, run),
      renderStreamMessage: (binding, target, scope, message, turnCompleted) =>
        this.renderStreamMessage(binding, target, scope, message, turnCompleted),
    };
  }

  getBinding(taskId: string): TaskBindingRecord | null {
    const row = getBindingRow(this.db, taskId);
    return row ? toBinding(row) : null;
  }

  getBindingByDestination(destination: string): TaskBindingRecord | null {
    const row = getBindingRowByDestination(this.db, destination);
    return row ? toBinding(row) : null;
  }

  isCurrentInputScope(scope: ChannelInputScope, sessionId: string): boolean {
    const binding = getBindingRowByDestination(this.db,scope.destination);
    if (!binding || binding.state !== 'active' || binding.owner_source !== scope.ownerSource ||
        binding.owner_subject !== scope.ownerSubject) return false;
    const targets = this.db.prepare("SELECT * FROM task_targets_v1 WHERE task_id=? AND session_id=? AND state='active' AND access_mode='interactive'")
      .all(binding.task_id,sessionId) as unknown as TargetRow[];
    return targets.some(target => taskInputScope(binding,target).bindingScope === scope.bindingScope);
  }

  getTarget(taskId: string, targetId: string): TaskTargetRecord | null {
    const row = getTargetRow(this.db, taskId, targetId);
    return row ? toTarget(row) : null;
  }

  listTargets(taskId: string, includeRevoked = false): TaskTargetRecord[] {
    const sql = includeRevoked
      ? 'SELECT * FROM task_targets_v1 WHERE task_id = ? ORDER BY rowid'
      : "SELECT * FROM task_targets_v1 WHERE task_id = ? AND state = 'active' ORDER BY rowid";
    return (this.db.prepare(sql).all(taskId) as unknown as TargetRow[]).map(toTarget);
  }

  listActiveBindings(): TaskBindingRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM task_bindings_v1 WHERE state = 'active' ORDER BY rowid")
        .all() as unknown as BindingRow[]
    ).map(toBinding);
  }

  minBoundEventCursorBySession(): Map<string, number> {
    const rows = this.db.prepare(`SELECT t.session_id,c.cursor FROM task_targets_v1 t
      JOIN task_bindings_v1 b ON b.task_id=t.task_id AND b.state='active'
      LEFT JOIN task_cursors_v1 c
        ON c.task_id=t.task_id AND c.target_id=t.target_id AND c.target_generation=t.target_generation
        AND c.session_id=t.session_id AND c.binding_scope=json_object(
          'taskId',b.task_id,'rootGeneration',b.root_generation,'targetId',t.target_id,
          'targetGeneration',t.target_generation,'sessionId',t.session_id,'accessMode',t.access_mode)
      WHERE t.state='active'`).all() as Array<{session_id:string;cursor:string|null}>;
    const minimum = new Map<string, number>();
    for (const row of rows) {
      const sequence = eventSequence(row.session_id, row.cursor ?? undefined);
      minimum.set(row.session_id, Math.min(minimum.get(row.session_id) ?? sequence, sequence));
    }
    return minimum;
  }

  listInteractionCards(): Array<{
    taskId: string;
    destination: string;
    targetId: string;
    sessionId: string;
    interactionId: string;
    revision: number;
    messageId: string;
  }> {
    return this.db
      .prepare(
        'SELECT task_id AS taskId, destination, target_id AS targetId, session_id AS sessionId, interaction_id AS interactionId, revision, message_id AS messageId FROM task_interaction_cards_v1',
      )
      .all() as Array<{
      taskId: string;
      destination: string;
      targetId: string;
      sessionId: string;
      interactionId: string;
      revision: number;
      messageId: string;
    }>;
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

  pendingInboxTasks(): string[] {
    return (this.db.prepare("SELECT DISTINCT task_id FROM task_inbox_scope_v1 WHERE state='received'")
      .all() as Array<{ task_id: string }>).map(row => row.task_id);
  }

  operationForEvent(eventId: string): Operation | null {
    const result = this.getInboxScope(eventId)?.result;
    return result && typeof result === 'object' && 'operationId' in result ? result as Operation : null;
  }

  private sessionTargets(sessionId: string): TargetRow[] {
    return this.db.prepare(`SELECT t.* FROM task_targets_v1 t JOIN task_bindings_v1 b ON b.task_id=t.task_id
      WHERE t.session_id=? AND t.state='active' AND b.state='active'`).all(sessionId) as unknown as TargetRow[];
  }

  tasksForSession(sessionId: string): string[] {
    return [...new Set(this.sessionTargets(sessionId).map(target => target.task_id))];
  }

  ownsInteractionCard(destination: string, sessionId: string, interactionId: string, messageId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM task_interaction_cards_v1 c
      JOIN task_bindings_v1 b ON b.task_id=c.task_id AND b.destination=c.destination AND b.state='active'
      JOIN task_targets_v1 t ON t.task_id=c.task_id AND t.target_id=c.target_id AND t.state='active'
        AND t.target_generation=c.target_generation AND t.session_id=c.session_id
      WHERE c.destination=? AND c.session_id=? AND c.interaction_id=? AND c.message_id=?`)
      .get(destination, sessionId, interactionId, messageId);
  }

  async refreshInteraction(sessionId: string, interactionId: string): Promise<void> {
    const targets = this.sessionTargets(sessionId);
    if (!targets.length) return;
    const interaction = await this.service.getInteraction(interactionId);
    if (interaction.sessionId !== sessionId) return;
    const session = await this.service.getSession(sessionId);
    await Promise.all(targets.map(async target => {
      const binding = getBindingRow(this.db, target.task_id);
      if (binding) await renderTaskInteraction(this.syncDeps(), binding, target, interaction, session.control.generation);
    }));
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
      const prior = getBindingRow(this.db, input.taskId);
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
      if (getBindingRowByDestination(this.db, input.destination)) {
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
      return toBinding(getBindingRow(this.db, input.taskId)!);
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
      const row = getBindingRow(this.db, taskId);
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
      return toBinding(getBindingRow(this.db, taskId)!);
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

    const pre = getBindingRow(this.db, input.taskId);
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
      const binding = getBindingRow(this.db, input.taskId);
      if (!binding || binding.state !== 'active' || binding.root_generation !== pre.root_generation) {
        throw new TaskChannelError('task_closed', 'task binding changed');
      }
      if (binding.owner_source !== input.owner.source || binding.owner_subject !== input.owner.subject) {
        throw new TaskChannelError('unauthorized', 'task owner changed');
      }
      const existing = getTargetRow(this.db, input.taskId, input.targetId);
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

      return toTarget(getTargetRow(this.db, input.taskId, input.targetId)!);
    });
  }

  /** Revoke/unbind a mounted target and bump its target_generation so captured old-gen work never falls back. */
  revokeTarget(taskId: string, targetId: string, owner: Identity): TaskTargetRecord {
    return this.tx(() => {
      const binding = getBindingRow(this.db, taskId);
      if (!binding) throw new TaskChannelError('task_not_found', 'task not found');
      if (binding.owner_source !== owner.source || binding.owner_subject !== owner.subject) {
        throw new TaskChannelError('unauthorized', 'task owner mismatch');
      }
      const target = getTargetRow(this.db, taskId, targetId);
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
      return toTarget(getTargetRow(this.db, taskId, targetId)!);
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
      const binding = getBindingRow(this.db, taskId);
      if (!binding || binding.state !== 'active') throw new TaskChannelError('task_not_found', 'task unavailable');
      if (binding.owner_source !== owner.source || binding.owner_subject !== owner.subject) {
        throw new TaskChannelError('unauthorized', 'task owner mismatch');
      }
      const target = getTargetRow(this.db, taskId, targetId);
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
      return toTarget(getTargetRow(this.db, taskId, targetId)!);
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

    const preBinding = getBindingRow(this.db, input.taskId);
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

    const preTarget = getTargetRow(this.db, input.taskId, input.targetId);
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
      const target = getTargetRow(this.db, input.taskId, input.targetId);
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
      return toBinding(getBindingRow(this.db, input.taskId)!);
    });
  }

  /** Capture a task target scope before downloading deferred inbound resources. */
  async captureResourceScope(e: TrustedEnvelope): Promise<string> {
    return captureTaskResourceScope(
      { db: this.db, service: this.service, authorize: this.authorize },
      e,
    );
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
    return intakeTaskEvent(
      { db: this.db, service: this.service, authorize: this.authorize },
      e,
      a,
      expectedResourceScope,
    );
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
    return this.withLock(this.taskLocks, scope.task_id, () =>
      drainTaskEventLocked(
        {
          db: this.db,
          port: this.port,
          service: this.service,
          authorize: this.authorize,
          listTargets: (taskId, includeRevoked) => this.listTargets(taskId, includeRevoked),
          switchActiveTarget: (input) => this.switchActiveTarget(input),
          ...(this.options.onInteractionChanged ? { onInteractionChanged: this.options.onInteractionChanged } : {}),
          renderInteraction: (binding, target, interaction, controlGeneration) =>
            renderTaskInteraction(this.syncDeps(), binding, target, interaction, controlGeneration),
        },
        eventId,
      ),
    );
  }

  async handle(
    e: TrustedEnvelope,
    a: TaskChannelAction,
    expectedResourceScope?: string,
  ): Promise<unknown> {
    await this.intake(e, a, expectedResourceScope);
    return this.drain(e.eventId);
  }

  protected async renderStreamMessage(
    binding: BindingRow,
    target: TargetRow,
    scope: string,
    message: Message,
    turnCompleted = false,
  ): Promise<boolean> {
    return renderTaskStreamMessage(this.syncDeps(), binding, target, scope, message, turnCompleted);
  }

  /**
   * Synchronize all active targets mounted on `taskId` with isolated per-target cursors
   * and stream/interaction cards. A failure in one provider target never blocks other targets.
   */
  async syncTask(taskId: string): Promise<{
    syncedTargets: string[];
    failedTargets: Array<{ targetId: string; provider: Provider; reason: string }>;
  }> {
    return syncAllTaskTargets(this.syncDeps(), taskId);
  }

  async syncDestination(destination: string): Promise<{
    syncedTargets: string[];
    failedTargets: Array<{ targetId: string; provider: Provider; reason: string }>;
  }> {
    const binding = getBindingRowByDestination(this.db, destination);
    if (!binding || binding.state !== 'active') {
      throw new TaskChannelError('task_not_found', 'active task binding not found for destination');
    }
    return this.syncTask(binding.task_id);
  }
}
