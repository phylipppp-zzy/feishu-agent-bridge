import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from '../adapter.js';
import {
  payloadDigest,
  type Identity,
  type Interaction,
  type Operation,
  type WriteContext,
} from '../contracts.js';
import { contractError, type ErrorCode } from '../errors.js';
import {
  operationCard,
  providerTitlePrefix,
  type ChannelCard,
} from '../feishu-cards.js';
import { decodeQuestionForm } from '../feishu-question-forms.js';
import type { FeishuPort, TrustedEnvelope } from '../feishu-channel.js';
import {
  buildAdminHelpCard,
  buildModelsCard,
  buildSwarmUnsupportedCard,
  buildTaskTopicHelpCard,
} from '../help-cards.js';
import { taskPanelCard } from './cards.js';
import { getBindingRow, getTargetRow } from './schema.js';
import {
  interactionFormBindingId,
  TaskChannelError,
  toBinding,
  type BindingRow,
  type InboxRow,
  type TargetRow,
  type TaskAuthorize,
  type TaskBindingRecord,
  type TaskChannelAction,
  type TaskTargetRecord,
} from './types.js';

const REJECTED_OPERATION_ACTIONS: Readonly<Record<string, string>> = {
  input: 'submitInput', attachment: 'submitInput', stop: 'interruptTurn',
  settings: 'updateSessionSettings', cancel: 'cancelQueuedInput', control: 'requestControl',
  answer: 'resolveInteraction', answer_form: 'resolveInteraction',
};

export interface TaskDeliverDeps {
  db: DatabaseSync;
  port: FeishuPort;
}

export async function deliverTaskCard(
  deps: TaskDeliverDeps,
  destination: string,
  taskId: string,
  targetId: string | null,
  card: ChannelCard,
  deliveryId: string,
  guard?: () => Promise<void>,
): Promise<string | void> {
  await guard?.();
  const inserted = deps.db
    .prepare(
      "INSERT OR IGNORE INTO task_deliveries_v1(delivery_id, task_id, target_id, state) VALUES (?, ?, ?, 'unknown')",
    )
    .run(deliveryId, taskId, targetId);
  if (!inserted.changes) return undefined;
  const messageId = await deps.port.send(destination, card, deliveryId, guard);
  await guard?.();
  deps.db.prepare("UPDATE task_deliveries_v1 SET state = 'sent' WHERE delivery_id = ?").run(deliveryId);
  return messageId;
}

export interface TaskDrainDeps extends TaskDeliverDeps {
  service: UnifiedService;
  authorize: TaskAuthorize;
  listTargets: (taskId: string, includeRevoked?: boolean) => TaskTargetRecord[];
  switchActiveTarget: (input: {
    taskId: string;
    targetId: string;
    expectedActiveRevision: number;
    expectedRootGeneration: number;
    owner: Identity;
  }) => Promise<TaskBindingRecord>;
  renderInteraction: (
    binding: BindingRow,
    target: TargetRow,
    interaction: Interaction,
    controlGeneration: number,
  ) => Promise<void>;
}

export async function drainTaskEventLocked(deps: TaskDrainDeps, eventId: string): Promise<unknown> {
  const row = deps.db
    .prepare('SELECT * FROM task_inbox_scope_v1 WHERE event_id = ?')
    .get(eventId) as InboxRow | undefined;
  if (!row) throw new TaskChannelError('invalid_request', 'task inbox event not found');
  if (row.state !== 'received') {
    return row.result ? JSON.parse(row.result) : { status: 'unknown' };
  }

  const payload = deps.db
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
    deps.db
      .prepare('UPDATE task_inbox_scope_v1 SET state = ?, result = ? WHERE event_id = ?')
      .run(state, JSON.stringify(result ?? null), eventId);
    return result;
  };

  const verifyCapturedTarget = async (): Promise<
    { ok: true; binding: BindingRow; target: TargetRow | null } | { ok: false; status: 'expired' | 'rejected'; reason: string }
  > => {
    const binding = getBindingRow(deps.db, row.task_id);
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

    if ((a.action === 'panel' || a.action === 'help') && row.target_id === '') {
      const allowed = await deps.authorize(e.identity, e.destination, null);
      if (!allowed) return { ok: false, status: 'rejected', reason: 'unauthorized' };
      return { ok: true, binding, target: null };
    }

    // Strictly look up the CAPTURED target_id — NEVER read binding.active_target_id!
    const target = getTargetRow(deps.db, row.task_id, row.target_id);
    if (
      !target ||
      target.state !== 'active' ||
      target.target_generation !== row.target_generation ||
      target.session_id !== row.session_id
    ) {
      return { ok: false, status: 'expired', reason: 'captured_target_changed_or_revoked' };
    }
    const allowed = await deps.authorize(e.identity, e.destination, row.session_id);
    if (!allowed) return { ok: false, status: 'rejected', reason: 'unauthorized' };

    const recheckBinding = getBindingRow(deps.db, row.task_id);
    const recheckTarget = getTargetRow(deps.db, row.task_id, row.target_id);
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
    await deliverTaskCard(
      deps,
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
    const claim = deps.db
      .prepare("UPDATE task_inbox_scope_v1 SET state = 'unknown' WHERE event_id = ? AND state = 'received'")
      .run(eventId);
    if (!claim.changes) return { status: 'unknown' };
    try {
      const nextBinding = await deps.switchActiveTarget({
        taskId: row.task_id,
        targetId: row.target_id,
        expectedActiveRevision: row.active_revision,
        expectedRootGeneration: row.root_generation,
        owner: e.identity,
      });
      const targets = deps.listTargets(row.task_id);
      await deliverTaskCard(
        deps,
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
    const claim = deps.db
      .prepare("UPDATE task_inbox_scope_v1 SET state = 'unknown' WHERE event_id = ? AND state = 'received'")
      .run(eventId);
    if (!claim.changes) return { status: 'unknown' };
    const targets = deps.listTargets(row.task_id);
    const card = taskPanelCard(toBinding(check.binding), targets);
    await deliverTaskCard(deps, e.destination, row.task_id, null, card, `${eventId}:panel`);
    return finalize('completed', {
      status: 'completed',
      activeTargetId: check.binding.active_target_id,
      activeRevision: check.binding.active_revision,
      targets,
    });
  }

  if (a.action === 'help') {
    const claim = deps.db
      .prepare("UPDATE task_inbox_scope_v1 SET state = 'unknown' WHERE event_id = ? AND state = 'received'")
      .run(eventId);
    if (!claim.changes) return { status: 'unknown' };
    const card =
      a.scope === 'admin'
        ? buildAdminHelpCard()
        : buildTaskTopicHelpCard(check.target?.provider ?? null);
    await deliverTaskCard(deps, e.destination, row.task_id, check.target?.target_id ?? null, card, `${eventId}:help`);
    return finalize('completed', { status: 'guidance' });
  }

  if (a.action === 'swarm') {
    const swarmTarget = check.target!;
    if (swarmTarget.provider !== 'agy') {
      const claim = deps.db
        .prepare("UPDATE task_inbox_scope_v1 SET state = 'unknown' WHERE event_id = ? AND state = 'received'")
        .run(eventId);
      if (!claim.changes) return { status: 'unknown' };
      await deliverTaskCard(
        deps,
        e.destination,
        row.task_id,
        row.target_id,
        buildSwarmUnsupportedCard(),
        `${eventId}:swarm-unsupported`,
      );
      return finalize('rejected', { status: 'rejected', reason: 'unsupported' });
    }
    if (swarmTarget.access_mode !== 'interactive') {
      const claim = deps.db
        .prepare("UPDATE task_inbox_scope_v1 SET state = 'unknown' WHERE event_id = ? AND state = 'received'")
        .run(eventId);
      if (!claim.changes) return { status: 'unknown' };
      await deliverTaskCard(
        deps,
        e.destination,
        row.task_id,
        row.target_id,
        {
          title: `${providerTitlePrefix(swarmTarget.provider)} · 无法启动 /swarm`,
          text: '此 Antigravity 目标当前为只读模式，无法直接启动 /swarm。请先挂载或切换到可交互的 Antigravity 目标。',
          actions: [],
        },
        `${eventId}:swarm-readonly`,
      );
      return finalize('rejected', { status: 'rejected', reason: 'read_only_target', targetId: row.target_id });
    }
  }

  if (a.action === 'resource_rejected') {
    const claim = deps.db
      .prepare("UPDATE task_inbox_scope_v1 SET state = 'unknown' WHERE event_id = ? AND state = 'received'")
      .run(eventId);
    if (!claim.changes) return { status: 'unknown' };
    const text = {
      unsupported: '仅支持图片和 UTF-8 文本附件。',
      size: '文本附件为空或超过 1 MiB，未提交。',
      encoding: '文本附件不是有效 UTF-8 或包含 NUL，未提交。',
    }[a.reason];
    await deliverTaskCard(
      deps,
      e.destination,
      row.task_id,
      row.target_id || null,
      { title: '附件未提交', text, actions: [] },
      `${eventId}:resource-rejected`,
    );
    return finalize('completed', { status: 'rejected', reason: a.reason });
  }

  const target = check.target!;
  const session = await deps.service.getSession(row.session_id);
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
    const interaction = await deps.service.getInteraction(a.interactionId);
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
    const interaction = await deps.service.getInteraction(a.interactionId);
    if (interaction.sessionId !== row.session_id) {
      return finalize('rejected', { status: 'rejected', reason: 'interaction_target_mismatch' });
    }
  }

  if (
    a.action === 'input' &&
    a.mode === 'steer' &&
    (!payload.steer_turn_id ||
      payload.steer_connection_generation === null ||
      payload.steer_control_generation === null ||
      session.control.generation !== payload.steer_control_generation)
  ) {
    return finalize('rejected', { status: 'rejected', reason: 'steer_unavailable' });
  }

  const claim = deps.db
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
      const op = await deps.service.submitInput({
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
    } else if (a.action === 'swarm') {
      const op = await deps.service.submitInput({
        context: makeContext(session.revision, session.control.generation),
        mode: 'new',
        blocks: [{ type: 'text', text: a.rawText }],
      });
      result = op;
    } else if (a.action === 'answer') {
      const op = await deps.service.resolveInteraction({
        context: makeContext(a.revision, a.controlGeneration ?? session.control.generation),
        interactionId: a.interactionId,
        expectedConnectionGeneration: a.connectionGeneration,
        answer: a.answer,
        toolInputDigest: a.toolInputDigest,
      });
      result = op;
    } else if (a.action === 'answer_form') {
      const op = await deps.service.resolveInteraction({
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
      const op = await deps.service.interruptTurn({
        context: makeContext(a.revision, a.controlGeneration),
        payload: { turnId: a.turnId },
      });
      result = op;
    } else if (a.action === 'settings') {
      const op = await deps.service.updateSessionSettings({
        context: makeContext(a.revision, a.controlGeneration),
        payload: { model: a.model, preferences: a.preferences },
      });
      result = op;
    } else if (a.action === 'cancel') {
      const op = await deps.service.cancelQueuedInput({
        context: makeContext(a.revision, a.controlGeneration),
        payload: { inputId: a.inputId },
      });
      result = op;
    } else if (a.action === 'attachment') {
      const digest = createHash('sha256').update(a.content).digest('hex');
      const stageOp = await deps.service.stageInputArtifact({
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
        const refreshed = await deps.service.getSession(row.session_id);
        const submitId = `task-attach:${eventId}`;
        result = await deps.service.submitInput({
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
      const page = await deps.service.readHistory(row.session_id, {
        limit: 20,
        ...(a.cursor ? { cursor: a.cursor } : {}),
      });
      const label = providerTitlePrefix(target.provider);
      await deliverTaskCard(
        deps,
        e.destination,
        row.task_id,
        row.target_id,
        {
          title: `${label} · 历史`,
          text:
            page.items
              .map(
                (m) =>
                  `${m.role}: ${m.blocks.map((b) => (b.type === 'text' ? b.text : `[文件 ${b.artifactId}]`)).join(' ')}`,
              )
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
      const page = await deps.service.listArtifacts(row.session_id, { limit: 100 });
      const label = providerTitlePrefix(target.provider);
      const counts = new Map<string, number>();
      for (const f of page.items) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
      await deliverTaskCard(
        deps,
        e.destination,
        row.task_id,
        row.target_id,
        {
          title: `${label} · 文件`,
          text: page.items.map((f) => `${f.name} (${f.contentVersion})`).join('\n') || '暂无文件。',
          actions: page.items.map((f) => ({
            label: (counts.get(f.name) ?? 0) > 1 ? `${f.name} (${f.contentVersion.slice(0, 8)})` : f.name,
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
      const page = await deps.service.listArtifacts(row.session_id, { limit: 100 });
      const file = page.items.find(
        (f) => f.artifactId === a.artifactId && f.contentVersion === a.contentVersion,
      );
      if (!file) return finalize('rejected', { status: 'rejected', reason: 'artifact_not_found' });
      const bytes = await deps.service.readArtifact(row.session_id, file.artifactId, file.contentVersion);
      const deliveryId = `task-file:${payloadDigest([row.task_id, row.target_id, row.target_generation, file.artifactId, file.contentVersion])}`;
      if (
        deps.db
          .prepare("INSERT OR IGNORE INTO task_deliveries_v1(delivery_id, task_id, target_id, state) VALUES (?, ?, ?, 'unknown')")
          .run(deliveryId, row.task_id, row.target_id).changes
      ) {
        await deps.port.sendFile(e.destination, file.name, bytes, deliveryId);
        deps.db.prepare("UPDATE task_deliveries_v1 SET state = 'sent' WHERE delivery_id = ?").run(deliveryId);
      }
      result = { deliveryId, status: 'sent' };
    } else if (a.action === 'models') {
      const page = await deps.service.listModels(row.session_id, {
        limit: 100,
        ...(a.cursor ? { cursor: a.cursor } : {}),
      });
      const label = providerTitlePrefix(target.provider);
      await deliverTaskCard(
        deps,
        e.destination,
        row.task_id,
        row.target_id,
        buildModelsCard({
          provider: target.provider,
          items: page.items,
          nextCursor: page.nextCursor,
          revision: session.revision,
          controlGeneration: session.control.generation,
          readOnly: target.access_mode !== 'interactive',
          title: `${label} · 模型`,
          taskScope: {
            taskId: row.task_id,
            rootGeneration: row.root_generation,
            activeRevision: check.binding.active_revision,
            targetId: row.target_id,
            targetGeneration: row.target_generation,
            sessionId: row.session_id,
          },
        }),
        `${eventId}:models`,
      );
      result = page;
    }

    if (
      (a.action === 'answer' || a.action === 'answer_form') &&
      result &&
      (result as Operation).status !== 'failed' &&
      (result as Operation).status !== 'unknown'
    ) {
      try {
        const updatedInteraction = await deps.service.getInteraction(a.interactionId);
        const currentBinding = getBindingRow(deps.db, row.task_id);
        const currentTarget = getTargetRow(deps.db, row.task_id, row.target_id);
        if (currentBinding && currentTarget && currentTarget.state === 'active') {
          await deps.renderInteraction(
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
      await deliverTaskCard(
        deps,
        e.destination,
        row.task_id,
        row.target_id,
        operationCard({
          operationId: eventId,
          idempotencyKey: eventId,
          targetId: row.session_id,
          action: REJECTED_OPERATION_ACTIONS[a.action] ?? a.action,
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
