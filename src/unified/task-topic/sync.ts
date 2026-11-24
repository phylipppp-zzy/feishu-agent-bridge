import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from '../adapter.js';
import { payloadDigest, type Interaction, type Message, type Provider } from '../contracts.js';
import { providerTitlePrefix, type ChannelCard } from '../feishu-cards.js';
import type { FeishuPort } from '../feishu-channel.js';
import { taskInteractionCard } from './cards.js';
import { deliverTaskCard } from './drain.js';
import { getBindingRow, getTargetRow } from './schema.js';
import {
  targetBindingScope,
  TaskChannelError,
  toBinding,
  toTarget,
  type BindingRow,
  type TargetRow,
  type TaskAuthorize,
} from './types.js';

export interface TaskSyncDeps {
  db: DatabaseSync;
  service: UnifiedService;
  port: FeishuPort;
  authorize: TaskAuthorize;
  streamThrottleMs: number;
  withInteractionLock?: (key: string, run: () => Promise<void>) => Promise<void>;
  renderStreamMessage?: (
    binding: BindingRow,
    target: TargetRow,
    scope: string,
    message: Message,
    turnCompleted?: boolean,
  ) => Promise<void>;
}

export async function verifySyncTarget(
  deps: Pick<TaskSyncDeps, 'db' | 'authorize'>,
  binding: BindingRow,
  target: TargetRow,
): Promise<void> {
  const currentBinding = getBindingRow(deps.db, binding.task_id);
  const currentTarget = getTargetRow(deps.db, binding.task_id, target.target_id);
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
  const allowed = await deps.authorize(
    { source: currentBinding.owner_source, subject: currentBinding.owner_subject },
    currentBinding.destination,
    currentTarget.session_id,
  );
  if (!allowed) {
    throw new TaskChannelError('unauthorized', 'task target authorization revoked');
  }
}

export async function renderTaskStreamMessage(
  deps: TaskSyncDeps,
  binding: BindingRow,
  target: TargetRow,
  scope: string,
  message: Message,
  turnCompleted = false,
): Promise<void> {
  const sequence = Number.isSafeInteger(message.sequence) ? message.sequence : 0;
  const turnKey = message.turnId || message.messageId;
  const guard = () => verifySyncTarget(deps, binding, target);
  await guard();

  const row = deps.db
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
  if (row && !message.final && Date.now() - row.updated_at < deps.streamThrottleMs) {
    if (row.message_id !== message.messageId) {
      deps.db
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
    deps.db
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
    const cardId = await deliverTaskCard(
      deps,
      binding.destination,
      binding.task_id,
      target.target_id,
      card,
      deliveryId,
      guard,
    );
    await guard();
    if (cardId) {
      deps.db
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
    !deps.db
      .prepare(
        "INSERT OR IGNORE INTO task_deliveries_v1(delivery_id, task_id, target_id, state) VALUES (?, ?, ?, 'unknown')",
      )
      .run(updateId, binding.task_id, target.target_id).changes
  ) {
    return;
  }
  await guard();
  await deps.port.update(binding.destination, row.card_id, card, updateId, guard);
  await guard();
  deps.db.prepare("UPDATE task_deliveries_v1 SET state = 'sent' WHERE delivery_id = ?").run(updateId);
  deps.db
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

export async function renderTaskInteraction(
  deps: TaskSyncDeps,
  binding: BindingRow,
  target: TargetRow,
  interaction: Interaction,
  controlGeneration: number,
): Promise<void> {
  const render = async () => {
    const current = await deps.service.getInteraction(interaction.interactionId);
    if (current.sessionId !== target.session_id) return;
    await renderCurrentTaskInteraction(deps, binding, target, current, controlGeneration);
  };
  if (!deps.withInteractionLock) return render();
  return deps.withInteractionLock(payloadDigest([
    binding.task_id, target.target_id, target.target_generation, interaction.interactionId,
  ]), render);
}

async function renderCurrentTaskInteraction(
  deps: TaskSyncDeps,
  binding: BindingRow,
  target: TargetRow,
  interaction: Interaction,
  controlGeneration: number,
): Promise<void> {
  const guard = () => verifySyncTarget(deps, binding, target);
  await guard();

  const row = deps.db
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

  const latestBinding = getBindingRow(deps.db, binding.task_id) ?? binding;
  const operation = interaction.status === 'awaiting_answer'
    ? undefined
    : await deps.service.getResponseOperation?.(interaction.interactionId);
  const card = taskInteractionCard(
    toBinding(latestBinding),
    toTarget(target),
    interaction,
    controlGeneration,
    operation,
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
      !deps.db
        .prepare(
          "INSERT OR IGNORE INTO task_deliveries_v1(delivery_id, task_id, target_id, state) VALUES (?, ?, ?, 'unknown')",
        )
        .run(deliveryId, binding.task_id, target.target_id).changes
    ) {
      if ((await deps.port.lookupDelivery?.(deliveryId)) === 'sent') {
        await guard();
        deps.db.prepare("UPDATE task_deliveries_v1 SET state = 'sent' WHERE delivery_id = ?").run(deliveryId);
        deps.db
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
    await deps.port.update(binding.destination, row.message_id, card, deliveryId, guard);
    await guard();
    deps.db.prepare("UPDATE task_deliveries_v1 SET state = 'sent' WHERE delivery_id = ?").run(deliveryId);
    deps.db
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
    let messageId = await deliverTaskCard(
      deps,
      binding.destination,
      binding.task_id,
      target.target_id,
      card,
      deliveryId,
      guard,
    );
    await guard();
    if (!messageId) messageId = (await deps.port.lookupMessageId?.(deliveryId)) ?? undefined;
    await guard();
    if (messageId) {
      deps.db
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

export async function syncSingleTaskTarget(
  deps: TaskSyncDeps,
  binding: BindingRow,
  target: TargetRow,
): Promise<void> {
  const scope = targetBindingScope(binding, target);
  const guard = () => verifySyncTarget(deps, binding, target);
  const renderStream = (
    b: BindingRow,
    t: TargetRow,
    s: string,
    m: Message,
    turnCompleted = false,
  ) =>
    deps.renderStreamMessage
      ? deps.renderStreamMessage(b, t, s, m, turnCompleted)
      : renderTaskStreamMessage(deps, b, t, s, m, turnCompleted);

  await guard();

  // Reconcile existing interaction cards (also catches terminal resolutions or active_revision bumps).
  const existingCards = deps.db
    .prepare(
      'SELECT interaction_id FROM task_interaction_cards_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ?',
    )
    .all(binding.task_id, target.target_id, target.target_generation, target.session_id) as Array<{
    interaction_id: string;
  }>;
  const sessionForCards = await deps.service.getSession(target.session_id);
  await guard();
  for (const row of existingCards) {
    const interaction = await deps.service.getInteraction(row.interaction_id);
    await guard();
    if (interaction.sessionId !== target.session_id) continue;
    await renderTaskInteraction(deps, binding, target, interaction, sessionForCards.control.generation);
  }

  const cursorRow = deps.db
    .prepare(
      'SELECT cursor FROM task_cursors_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND binding_scope = ?',
    )
    .get(binding.task_id, target.target_id, target.target_generation, target.session_id, scope) as
    | { cursor: string }
    | undefined;

  let cursor = cursorRow?.cursor;
  let expired = false;

  if (cursor) {
    const events = await deps.service.subscribeEvents(target.session_id, cursor, 100);
    await guard();
    if (events.status === 'events') {
      const snapshot = await deps.service.getSnapshot(target.session_id);
      await guard();
      for (const interaction of snapshot.value.interactions) {
        await renderTaskInteraction(
          deps,
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
          const known = deps.db
            .prepare(
              'SELECT revision FROM task_known_messages_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND message_id = ?',
            )
            .get(binding.task_id, target.target_id, target.target_generation, target.session_id, msg.messageId) as
            | { revision: number }
            | undefined;
          if (known && known.revision >= msg.revision) continue;
          await renderStream(binding, target, scope, msg);
          if (msg.final) {
            deps.db
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
              await renderStream(binding, target, scope, finalMsg, true);
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
    const snapshot = await deps.service.getSnapshot(target.session_id);
    await guard();
    for (const msg of snapshot.value.messages) {
      const known = deps.db
        .prepare(
          'SELECT revision FROM task_known_messages_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND message_id = ?',
        )
        .get(binding.task_id, target.target_id, target.target_generation, target.session_id, msg.messageId) as
        | { revision: number }
        | undefined;
      if (expired && msg.role === 'assistant' && (!known || known.revision < msg.revision)) {
        await renderStream(binding, target, scope, msg);
      }
      if (!expired || msg.final) {
        deps.db
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
      await renderTaskInteraction(
        deps,
        binding,
        target,
        interaction,
        snapshot.value.session.control.generation,
      );
    }
    cursor = snapshot.cursor;
  }

  await guard();
  deps.db
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

export async function syncAllTaskTargets(
  deps: TaskSyncDeps,
  taskId: string,
): Promise<{
  syncedTargets: string[];
  failedTargets: Array<{ targetId: string; provider: Provider; reason: string }>;
}> {
  const binding = getBindingRow(deps.db, taskId);
  if (!binding || binding.state !== 'active') {
    throw new TaskChannelError('task_not_found', 'active task binding not found');
  }
  const targets = deps.db
    .prepare("SELECT * FROM task_targets_v1 WHERE task_id = ? AND state = 'active' ORDER BY rowid")
    .all(taskId) as unknown as TargetRow[];

  const syncedTargets: string[] = [];
  const failedTargets: Array<{ targetId: string; provider: Provider; reason: string }> = [];

  for (const target of targets) {
    try {
      await syncSingleTaskTarget(deps, binding, target);
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
