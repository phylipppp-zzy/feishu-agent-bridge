import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from '../adapter.js';
import { payloadDigest } from '../contracts.js';
import type { TrustedEnvelope } from '../feishu-channel.js';
import {
  getBindingRow,
  getBindingRowByDestination,
  getTargetRow,
  runTransaction,
} from './schema.js';
import {
  nonempty,
  TaskChannelError,
  type BindingRow,
  type TargetRow,
  type TaskAuthorize,
  type TaskChannelAction,
} from './types.js';

export interface TaskIntakeDeps {
  db: DatabaseSync;
  service: UnifiedService;
  authorize: TaskAuthorize;
}

export async function captureTaskResourceScope(
  deps: TaskIntakeDeps,
  e: TrustedEnvelope,
): Promise<string> {
  if (!nonempty(e?.destination) || !nonempty(e?.identity?.source) || !nonempty(e?.identity?.subject)) {
    throw new TaskChannelError('invalid_request', 'invalid envelope');
  }
  const binding = getBindingRowByDestination(deps.db, e.destination);
  if (!binding || binding.state !== 'active') {
    throw new TaskChannelError('task_not_found', 'active task binding not found');
  }
  if (binding.owner_source !== e.identity.source || binding.owner_subject !== e.identity.subject) {
    throw new TaskChannelError('unauthorized', 'unauthorized task owner');
  }
  if (!binding.active_target_id) {
    throw new TaskChannelError('no_active_target', 'no active target for task');
  }
  const target = getTargetRow(deps.db, binding.task_id, binding.active_target_id);
  if (!target || target.state !== 'active') {
    throw new TaskChannelError('target_revoked', 'active target unavailable');
  }
  if (target.access_mode !== 'interactive') {
    throw new TaskChannelError('read_only_target', 'read-only target cannot accept attachments');
  }
  if (!await deps.authorize(e.identity, e.destination, target.session_id)) {
    throw new TaskChannelError('unauthorized', 'target authorization denied');
  }
  const latestBinding = getBindingRow(deps.db, binding.task_id);
  const latestTarget = getTargetRow(deps.db, binding.task_id, target.target_id);
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

export function resolveTargetForIntake(
  db: DatabaseSync,
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
    const target = getTargetRow(db, binding.task_id, a.targetId);
    if (!target) throw new TaskChannelError('target_not_found', 'interaction target not found');
    if (target.state !== 'active') throw new TaskChannelError('target_revoked', 'interaction target revoked');
    if (target.target_generation !== a.targetGeneration || target.session_id !== a.sessionId) {
      throw new TaskChannelError('stale_revision', 'interaction target generation or session mismatch');
    }
    return target;
  }

  if (a.action === 'switch_target') {
    const target = getTargetRow(db, binding.task_id, a.targetId);
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
    const target = getTargetRow(db, binding.task_id, explicitTargetId);
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

  const active = getTargetRow(db, binding.task_id, binding.active_target_id);
  if (!active || active.state !== 'active') {
    throw new TaskChannelError('target_revoked', 'active target is unavailable');
  }
  return active;
}

export async function intakeTaskEvent(
  deps: TaskIntakeDeps,
  e: TrustedEnvelope,
  a: TaskChannelAction,
  expectedResourceScope?: string,
): Promise<{ eventId: string; state: string; capturedTargetId: string; sessionId: string }> {
  if (!nonempty(e?.eventId) || !nonempty(e?.destination) || !nonempty(e?.identity?.source) || !nonempty(e?.identity?.subject)) {
    throw new TaskChannelError('invalid_request', 'invalid trusted envelope');
  }
  const isCard = e.eventId.startsWith('card:');
  const preBinding = getBindingRowByDestination(deps.db, e.destination);
  if (!preBinding) throw new TaskChannelError('task_not_found', 'destination is not a registered task topic');
  if (preBinding.state !== 'active') throw new TaskChannelError('task_closed', 'task topic is closed');
  if (preBinding.owner_source !== e.identity.source || preBinding.owner_subject !== e.identity.subject) {
    throw new TaskChannelError('unauthorized', 'task owner mismatch');
  }

  const preTarget = resolveTargetForIntake(deps.db, preBinding, a, isCard);

  if (expectedResourceScope !== undefined) {
    if (a.action !== 'attachment' && a.action !== 'resource_rejected') {
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

  if (!await deps.authorize(e.identity, e.destination, preTarget.session_id || null)) {
    throw new TaskChannelError('unauthorized', 'target authorization denied');
  }

  let steerTurnId: string | null = null;
  let steerConnGen: number | null = null;
  let steerCtrlGen: number | null = null;
  if (a.action === 'input' && a.mode === 'steer' && preTarget.access_mode === 'interactive' && deps.service.captureSteer) {
    try {
      const cap = await deps.service.captureSteer(e.identity, preTarget.session_id);
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

  return runTransaction(deps.db, () => {
    const existing = deps.db
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

    const binding = getBindingRowByDestination(deps.db, e.destination);
    if (!binding || binding.state !== 'active' || binding.root_generation !== preBinding.root_generation) {
      throw new TaskChannelError('task_closed', 'task binding changed during intake');
    }
    if (binding.owner_source !== e.identity.source || binding.owner_subject !== e.identity.subject) {
      throw new TaskChannelError('unauthorized', 'task owner changed during intake');
    }
    const target = resolveTargetForIntake(deps.db, binding, a, isCard);
    if (
      target.target_id !== preTarget.target_id ||
      target.target_generation !== preTarget.target_generation ||
      target.session_id !== preTarget.session_id ||
      binding.active_revision !== preBinding.active_revision
    ) {
      throw new TaskChannelError('stale_active_revision', 'task target changed during intake');
    }

    deps.db
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
    deps.db
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
