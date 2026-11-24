import type { Interaction, Operation } from '../contracts.js';
import {
  interactionCard,
  interactionStatusText,
  providerDisplayLabel,
  providerTitlePrefix,
  type ChannelCard,
} from '../feishu-cards.js';
import { questionForm } from '../feishu-question-forms.js';
import {
  interactionFormBindingId,
  type TaskBindingRecord,
  type TaskTargetRecord,
} from './types.js';

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
  operation?: Operation | null,
): ChannelCard {
  const readOnly = target.accessMode === 'read_only';
  const baseCard = interactionCard(interaction, readOnly, operation);
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
    const statusText = interactionStatusText(interaction, operation);
    card.form = questionForm(
      interaction,
      interactionFormBindingId(target.taskId, target.targetId, target.targetGeneration),
      readOnly || !!statusText,
      Date.now(),
      stamp,
    );
    if (statusText) card.form.statusText = statusText;
  }
  return card;
}
