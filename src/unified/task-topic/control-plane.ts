import { createHash } from 'node:crypto';
import type { UnifiedService } from '../adapter.js';
import { payloadDigest, type Identity } from '../contracts.js';
import { contractError } from '../errors.js';
import type { ChannelAction, FeishuPort, TrustedEnvelope } from '../feishu-channel.js';
import type { TaskTopicToken } from '../task-topic-store.js';
import { taskPanelCard } from './cards.js';
import type { TaskTopicChannel } from './channel.js';
import type { TaskHandoffService } from './handoff.js';
import { TaskHandoffError } from './handoff-types.js';
import { TaskChannelError, type TaskAccessMode } from './types.js';

export type TaskControlAction = Extract<
  ChannelAction,
  { action: 'task_create' | 'task_mount' | 'task_panel' | 'handoff_preview' }
>;

export interface TaskControlDeps {
  core: UnifiedService;
  port: FeishuPort & {
    authorizedDestination?: (destination: string) => boolean;
    createTaskTopic?: (
      chatId: string,
      taskId: string,
      operationId: string,
      owner: string,
    ) => Promise<TaskTopicToken>;
  };
  sendPort: Pick<FeishuPort, 'send'>;
  allowedDestinations: ReadonlySet<string>;
  isOwner: (identity: Identity) => boolean;
  taskTopicEnabled: boolean;
  taskChannel?: TaskTopicChannel;
  taskHandoff?: TaskHandoffService;
}

export function isTaskControlAction(action: { action: string }): action is TaskControlAction {
  return (
    action.action === 'task_create' ||
    action.action === 'task_mount' ||
    action.action === 'task_panel' ||
    action.action === 'handoff_preview'
  );
}

export async function handleTaskControlAction(
  deps: TaskControlDeps,
  envelope: TrustedEnvelope,
  action: TaskControlAction,
): Promise<unknown> {
  if (!deps.isOwner(envelope.identity)) {
    throw contractError('unauthorized', 'unauthorized task control actor');
  }
  if (!deps.taskTopicEnabled || !deps.taskChannel) {
    throw contractError('unsupported', 'task topic is not enabled');
  }

  const taskChannel = deps.taskChannel;
  const binding = taskChannel.getBindingByDestination(envelope.destination);

  if (action.action === 'task_create') {
    if (binding) {
      throw contractError('invalid_request', 'cannot create a task topic inside an existing task topic');
    }
    const destAuthorized =
      deps.port.authorizedDestination?.(envelope.destination) ??
      deps.allowedDestinations.has(envelope.destination);
    if (!destAuthorized || deps.port.isTopicDestination?.(envelope.destination)) {
      throw contractError('unauthorized', 'task creation is only allowed in an authorized main chat');
    }
    if (typeof deps.port.createTaskTopic !== 'function') {
      throw contractError('unsupported', 'task topic creation is unavailable on this port');
    }
    const idHash = createHash('sha256')
      .update(JSON.stringify([envelope.destination, envelope.eventId]))
      .digest('hex')
      .slice(0, 16);
    const taskId = `task_${idHash}`;
    const operationId = `op_task_${idHash}`;
    const token = await deps.port.createTaskTopic(
      envelope.destination,
      taskId,
      operationId,
      envelope.identity.subject,
    );
    const created = taskChannel.registerFromToken(token, envelope.identity.source);
    const topicUrl = deps.port.topicLinkForTask
      ? await deps.port.topicLinkForTask(envelope.destination, created.taskId)
      : null;
    await deps.sendPort.send(
      envelope.destination,
      {
        title: '任务话题已创建',
        text: [
          `标题: ${action.title}`,
          '点击下方按钮进入任务话题，在话题内发送 /task 可管理后端目标，发送 /help 查看全部命令。',
        ].join('\n'),
        actions: topicUrl ? [{ label: '打开任务话题', value: {}, url: topicUrl }] : [],
      },
      `task-create:${envelope.eventId}`,
    );
    return {
      status: 'created',
      taskId: created.taskId,
      destination: created.destination,
      title: action.title,
      topicUrl,
    };
  }

  if (action.action === 'task_panel') {
    if (!binding || binding.state !== 'active') {
      throw contractError('invalid_request', 'use /task <title> in main chat or /task inside a task topic');
    }
    return taskChannel.intake(envelope, { action: 'panel' });
  }

  if (action.action === 'task_mount') {
    if (!binding || binding.state !== 'active') {
      throw new TaskChannelError('task_not_found', 'active task topic required for /task mount');
    }
    if (
      binding.owner.source !== envelope.identity.source ||
      binding.owner.subject !== envelope.identity.subject
    ) {
      throw new TaskChannelError('unauthorized', 'task owner mismatch');
    }
    const session = await deps.core.getSession(action.sessionId);
    const mode: TaskAccessMode =
      action.mode ??
      (session.status !== 'read_only' && session.control.input === 'available'
        ? 'interactive'
        : 'read_only');
    const existingTargets = taskChannel.listTargets(binding.taskId, true);
    const sameNative = existingTargets.find(
      (t) =>
        t.native.provider === session.native.provider &&
        t.native.hostId === session.native.hostId &&
        t.native.serviceId === session.native.serviceId &&
        t.native.nativeSessionId === session.native.nativeSessionId,
    );
    const targetId =
      sameNative?.targetId ?? `${session.native.provider}-${payloadDigest(session.native).slice(0, 8)}`;
    const target = await taskChannel.mountTarget({
      taskId: binding.taskId,
      targetId,
      sessionId: session.sessionId,
      native: session.native,
      accessMode: mode,
      owner: envelope.identity,
      makeActive: mode === 'interactive' && !binding.activeTargetId,
    });
    const updatedBinding = taskChannel.getBinding(binding.taskId) ?? binding;
    const targets = taskChannel.listTargets(binding.taskId);
    await deps.sendPort.send(
      binding.destination,
      taskPanelCard(updatedBinding, targets),
      `task-mount:${envelope.eventId}`,
    );
    return {
      status: 'mounted',
      taskId: binding.taskId,
      targetId: target.targetId,
      target,
    };
  }

  // handoff_preview
  if (!binding || binding.state !== 'active') {
    throw new TaskHandoffError('task_not_found', 'active task topic required for /handoff');
  }
  if (!deps.taskHandoff) {
    throw contractError('unsupported', 'task handoff is unavailable');
  }
  if (
    binding.owner.source !== envelope.identity.source ||
    binding.owner.subject !== envelope.identity.subject
  ) {
    throw new TaskHandoffError('unauthorized', 'task owner mismatch');
  }
  if (!binding.activeTargetId) {
    throw new TaskHandoffError('invalid_request', 'no active source target for handoff');
  }
  const { draft, card } = await deps.taskHandoff.previewHandoff({
    taskId: binding.taskId,
    sourceTargetId: binding.activeTargetId,
    targetTargetId: action.targetId,
    owner: envelope.identity,
  });
  await deps.sendPort.send(binding.destination, card, `handoff-preview:${envelope.eventId}`);
  return {
    status: 'previewed',
    draft,
    card,
  };
}
