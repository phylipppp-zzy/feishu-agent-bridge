import type { Provider, Session } from '../contracts.js';
import { shortenHomePath } from '../card-formatters.js';
import { escapeCardMarkdown, stripCardMentions } from '../feishu-card-wire.js';
import { providerDisplayLabel, providerTitlePrefix, type ChannelCard } from '../feishu-cards.js';
import {
  MAX_HANDOFF_SUMMARY_CHARS,
  validateSummary,
  type HandoffDraft,
} from './handoff-types.js';

/**
 * Render an explicit, model-neutral preview card for Feishu.
 * Never claims tool authorization or implicit history carry-over.
 */
export function handoffPreviewCard(
  draft: HandoffDraft,
  sourceProvider: Provider,
  targetProvider: Provider,
): ChannelCard {
  const artifactsText = draft.artifactRefs.length
    ? draft.artifactRefs
        .map((a) => `- ${escapeCardMarkdown(a.name)} (id=${escapeCardMarkdown(a.artifactId)}, ver=${escapeCardMarkdown(a.contentVersion.slice(0, 12))})`)
        .join('\n')
    : '（无引用文件）';
  const constraintsText = draft.constraints.length
    ? draft.constraints.map((c) => `- ${escapeCardMarkdown(c)}`).join('\n')
    : '（无额外约束）';
  const summaryPreview =
    [...draft.summary].length > 800 ? `${[...draft.summary].slice(0, 800).join('')}…` : draft.summary;
  const text = [
    `来源: ${providerDisplayLabel(sourceProvider)} (${escapeCardMarkdown(draft.sourceTargetId)})`,
    `目标: ${providerDisplayLabel(targetProvider)} (${escapeCardMarkdown(draft.targetTargetId)})`,
    `目标工作目录: ${escapeCardMarkdown(shortenHomePath(draft.targetCwd))}`,
    `摘要:\n${stripCardMentions(summaryPreview)}`,
    `约束:\n${constraintsText}`,
    `引用文件:\n${artifactsText}`,
    `预览摘要哈希: ${draft.previewDigest.slice(0, 16)}`,
    '说明: 仅发送以上显式摘要、约束与受控文件引用；不复制全量历史，也不转移任何工具权限授权。',
  ].join('\n');

  const actions: ChannelCard['actions'] =
    draft.status === 'draft'
      ? [
          {
            label: `确认交接到 ${providerTitlePrefix(targetProvider)}`,
            value: {
              action: 'confirm_handoff',
              handoffId: draft.handoffId,
              taskId: draft.taskId,
              previewDigest: draft.previewDigest,
              targetGeneration: draft.targetGeneration,
              activeRevision: draft.activeRevision,
            },
          },
        ]
      : [];

  return {
    title: `跨后端交接预览 · ${providerTitlePrefix(sourceProvider)} → ${providerTitlePrefix(targetProvider)}`,
    text,
    actions,
  };
}

export function formatHandoffSubmissionText(draft: HandoffDraft): string {
  const parts: string[] = [
    `[显式任务交接摘要 | handoffId=${draft.handoffId} | digest=${draft.previewDigest}]`,
    '注意: 本交接仅提供显式摘要、约束与受控文件引用，不包含源后端全量历史，亦不授予或继承任何工具审批权限。',
    `目标工作目录 (cwd): ${draft.targetCwd}`,
    `交接摘要:\n${draft.summary}`,
  ];
  if (draft.constraints.length) {
    parts.push(`约束条件:\n${draft.constraints.map((c, idx) => `${idx + 1}. ${c}`).join('\n')}`);
  }
  if (draft.artifactRefs.length) {
    parts.push(
      `受控文件引用:\n${draft.artifactRefs
        .map((a) => `- ${a.name} (artifactId=${a.artifactId}, contentVersion=${a.contentVersion})`)
        .join('\n')}`,
    );
  }
  return parts.join('\n\n');
}

export function buildDeterministicSummary(sourceSession: Session, targetSession: Session): string {
  const raw = [
    `从 ${providerDisplayLabel(sourceSession.native.provider)} (${sourceSession.title || sourceSession.native.nativeSessionId}) 交接到 ${providerDisplayLabel(targetSession.native.provider)}`,
    `原工作目录: ${sourceSession.project}；目标工作目录: ${targetSession.project}`,
    `原会话状态: ${sourceSession.status}`,
  ].join('\n');
  return validateSummary([...raw].slice(0, MAX_HANDOFF_SUMMARY_CHARS).join(''));
}
