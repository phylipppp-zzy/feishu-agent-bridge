import { escapeCardMarkdown } from '../feishu-card-wire.js';
import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from '../adapter.js';
import { payloadDigest, type Interaction, type Message, type Provider } from '../contracts.js';
import { providerTitlePrefix, type ChannelCard } from '../feishu-cards.js';
import type { FeishuPort } from '../feishu-channel.js';
import { aggregateTurnAssistantMessage, formatCardReplyBody } from '../turn-reply.js';
import { taskInteractionCard } from './cards.js';
import { deliverTaskCard } from './drain.js';
import { getBindingRow, getTargetRow, runTransaction } from './schema.js';
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
  ) => Promise<boolean>;
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
): Promise<boolean> {
  const sequence = Number.isSafeInteger(message.sequence) ? message.sequence : 0;
  const turnKey = message.turnId || message.messageId;
  const guard = () => verifySyncTarget(deps, binding, target);
  await guard();

  const row = deps.db
    .prepare(
      'SELECT card_id, revision, updated_at, message_id, latest_sequence FROM task_stream_cards_v1 WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND turn_key = ?',
    )
    .get(binding.task_id, target.target_id, target.target_generation, target.session_id, turnKey) as
    | {
        card_id: string | null;
        revision: number;
        updated_at: number;
        message_id: string;
        latest_sequence: number;
      }
    | undefined;

  if (row && sequence < row.latest_sequence) {
    return row.card_id !== null;
  }
  if (
    row?.card_id &&
    row.message_id === message.messageId &&
    row.revision >= message.revision && !turnCompleted
  ) {
    return true;
  }
  if (row && !message.final && !turnCompleted && Date.now() - row.updated_at < deps.streamThrottleMs) {
    return false;
  }

  const label = providerTitlePrefix(target.provider);
  const body = message.blocks
    .map((b) => (b.type === 'text' ? b.text : `[文件 ${escapeCardMarkdown(b.artifactId)}]`))
    .join('\n');
  const title = turnCompleted ? `${label} · 回复 · 本轮已完成` : message.final ? `${label} · 回复` : `${label} · 回复中`;
  const preview = formatCardReplyBody(`来源: ${label} (${target.target_id})\n${body}`);
  const card: ChannelCard = { title, text: preview.text, actions: [] };
  if (preview.truncated) {
    const current = getBindingRow(deps.db, binding.task_id)!;
    card.actions.push({ label: '发送完整正文 (.txt)', value: {
      action: 'full_reply', messageId: message.messageId, taskId: binding.task_id,
      rootGeneration: binding.root_generation, activeRevision: current.active_revision,
      targetId: target.target_id, targetGeneration: target.target_generation, sessionId: target.session_id,
    } });
  }

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
          Number(message.final || turnCompleted),
          message.messageId,
          sequence,
          binding.task_id,
          target.target_id,
          target.target_generation,
          target.session_id,
          turnKey,
        );
    }
    return Boolean(cardId) ||
      deps.db.prepare('SELECT state FROM task_deliveries_v1 WHERE delivery_id = ?').get(deliveryId)?.state === 'sent';
  }

  if (!row.card_id) return false;
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
    const prior = deps.db.prepare('SELECT state FROM task_deliveries_v1 WHERE delivery_id = ?').get(updateId);
    return prior?.state === 'sent';
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
      Number(message.final || turnCompleted),
      message.messageId,
      sequence,
      binding.task_id,
      target.target_id,
      target.target_generation,
      target.session_id,
      turnKey,
    );
  return true;
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
      const previous = deps.db
        .prepare('SELECT state FROM task_deliveries_v1 WHERE delivery_id = ?')
        .get(deliveryId) as { state: string } | undefined;
      if (previous?.state === 'sent' || (await deps.port.lookupDelivery?.(deliveryId)) === 'sent') {
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
        return;
      }
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
  const key = [binding.task_id, target.target_id, target.target_generation, target.session_id] as const;
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

  const readCursor = deps.db.prepare(`SELECT cursor FROM task_cursors_v1
    WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND binding_scope = ?`);
  const previousCursor = readCursor.get(...key, scope)?.cursor as string | undefined;

  const events = previousCursor === undefined ? undefined
    : await deps.service.subscribeEvents(target.session_id, previousCursor, 100);
  await guard();
  const snapshot = await deps.service.getSnapshot(target.session_id);
  await guard();
  for (const interaction of snapshot.value.interactions) {
    await renderTaskInteraction(
      deps, binding, target, interaction, snapshot.value.session.control.generation,
    );
  }

  const messages = snapshot.value.messages.filter(message => message.sessionId === target.session_id);
  if (events) {
    const baseline = new Map((deps.db.prepare(`SELECT message_id, revision FROM task_baseline_messages_v1
      WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ?`)
      .all(...key) as Array<{ message_id: string; revision: number }>).map(row => [row.message_id, row.revision]));
    const known = new Map((deps.db.prepare(`SELECT message_id, revision FROM task_known_messages_v1
      WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ?`)
      .all(...key) as Array<{ message_id: string; revision: number }>).map(row => [row.message_id, row.revision]));
    const replies = new Map<string, Message[]>();
    const byId = new Map<string, Message>();
    for (const message of messages) {
      if (message.role !== 'assistant' || (baseline.get(message.messageId) ?? -1) >= message.revision) continue;
      byId.set(message.messageId, message);
      const turnKey = message.turnId || message.messageId;
      const items = replies.get(turnKey) ?? [];
      items.push(message);
      replies.set(turnKey, items);
    }

    const completed = new Set(snapshot.value.turns?.filter(turn => turn.status === 'completed').map(turn => turn.turnId));
    const candidates = new Set<string>();
    const isUnknown = (message: Message) => (known.get(message.messageId) ?? -1) < message.revision;
    if (events.status === 'events') {
      for (const event of events.events) {
        if (event.type === 'message.updated') {
          const message = byId.get(event.objectId);
          if (message && isUnknown(message)) candidates.add(message.turnId || message.messageId);
        } else if (event.type === 'turn.updated') {
          const data = event.data as { status?: string; turnId?: string } | undefined;
          if (data?.status === 'completed') {
            const turnId = typeof data.turnId === 'string' ? data.turnId : event.objectId;
            completed.add(turnId);
            candidates.add(turnId);
          }
        }
      }
      // Throttling can outlast the event that caused it. Revisit undelivered
      // revisions on existing cards even when the next sync has no new events.
      const cards = deps.db.prepare(`SELECT turn_key FROM task_stream_cards_v1
        WHERE task_id = ? AND target_id = ? AND target_generation = ? AND session_id = ? AND card_id IS NOT NULL`)
        .all(...key) as Array<{ turn_key: string }>;
      for (const { turn_key } of cards) {
        if (replies.get(turn_key)?.some(isUnknown)) candidates.add(turn_key);
      }
    } else {
      for (const [turnKey, items] of replies) {
        if (items.some(isUnknown)) candidates.add(turnKey);
      }
    }

    const remember = deps.db.prepare(`INSERT INTO task_known_messages_v1 VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, target_id, target_generation, session_id, message_id)
      DO UPDATE SET revision = MAX(revision, excluded.revision)`);
    for (const turnKey of candidates) {
      const items = replies.get(turnKey);
      if (!items) continue;
      const reply = aggregateTurnAssistantMessage(items, turnKey)!;
      if (await renderStream(binding, target, scope, reply, completed.has(turnKey))) {
        await guard();
        for (const item of items) remember.run(...key, item.messageId, item.revision);
      }
    }
  }

  await guard();
  const cursor = events?.status === 'events' ? events.cursor : snapshot.cursor;
  runTransaction(deps.db, () => {
    if (readCursor.get(...key, scope)?.cursor !== previousCursor) return;
    if (!events) {
      const baseline = deps.db.prepare('INSERT OR IGNORE INTO task_baseline_messages_v1 VALUES (?, ?, ?, ?, ?, ?)');
      for (const message of messages) baseline.run(...key, message.messageId, message.revision);
    }
    deps.db.prepare('INSERT OR REPLACE INTO task_cursors_v1 VALUES (?, ?, ?, ?, ?, ?)')
      .run(...key, cursor, scope);
  });
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
