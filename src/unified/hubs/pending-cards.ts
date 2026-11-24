import type { Interaction, Session } from '../contracts.js';
import { formatApprovalAction } from '../card-formatters.js';
import { escapeCardMarkdown } from '../feishu-card-wire.js';
import {
  interactionCard,
  providerDisplayLabel,
  providerTitlePrefix,
  type ChannelCard,
} from '../feishu-cards.js';
import { questionForm } from '../feishu-question-forms.js';
import type { DecisionRecord } from './decision-types.js';
import {
  PENDING_CATEGORY_LABELS,
  fail,
  isSafePendingAppLink,
  type PendingCategory,
  type PendingDecisionItem,
  type PendingInteractionItem,
  type PendingItemView,
  type PendingPage,
  type PendingQuery,
  type PendingSourceProvider,
} from './pending-types.js';

export function buildPendingRootCard(topicTitle: string): ChannelCard {
  return {
    title: topicTitle,
    text: '待处理统一汇总视图：集中归集模型问答、工具权限、业务决定与执行授权。',
    actions: [],
  };
}

export function buildWithdrawnCard(category: PendingCategory, reason: string): ChannelCard {
  return {
    title: `【已失效 · ${PENDING_CATEGORY_LABELS[category]}】`,
    template: 'grey',
    ...(category === 'question' ? { schema: '2.0' as const } : {}),
    text: `${reason}。本卡片操作已撤下，不可重复提交。`,
    actions: [],
  };
}

export function isActionableInteraction(
  interaction: Interaction,
  session: Session,
  snapshotConnectionGeneration: number | undefined,
  nowMs: number,
): boolean {
  if (interaction.status !== 'awaiting_answer') return false;
  if (interaction.expiresAt !== null) {
    const exp = Date.parse(interaction.expiresAt);
    if (!Number.isFinite(exp) || exp <= nowMs) return false;
  }
  if (session.status === 'read_only' || session.status === 'unreachable') return false;
  if (session.control.input !== 'available') return false;
  if (
    snapshotConnectionGeneration !== undefined &&
    interaction.connectionGeneration !== snapshotConnectionGeneration
  ) {
    return false;
  }
  return true;
}

export function isActionableDecision(decision: DecisionRecord, nowMs: number): boolean {
  if (decision.status !== 'pending') return false;
  if (decision.expiresAt !== null) {
    const exp = Date.parse(decision.expiresAt);
    if (!Number.isFinite(exp) || exp <= nowMs) return false;
  }
  return true;
}

export function buildInteractionPendingItem(params: {
  interaction: Interaction;
  session: Session;
  sourceSessionId: string;
  sourceDestination: string | null;
  sourceTopicUrl: string | null;
}): PendingInteractionItem {
  const { interaction, session, sourceSessionId, sourceDestination, sourceTopicUrl } = params;
  const category: 'question' | 'approval' = interaction.kind === 'approval' ? 'approval' : 'question';
  const provider = providerTitlePrefix(session.native.provider);
  let title: string;
  let summary: string;
  if (interaction.kind === 'approval') {
    const approval = formatApprovalAction(interaction.tool, interaction.action, interaction.scope);
    title = `${provider} 工具权限 · ${approval.toolLabel}`;
    summary = approval.text;
  } else if (interaction.kind === 'question') {
    title = `${provider} 问题: ${interaction.prompt}`;
    summary = interaction.prompt;
  } else {
    title = `${provider} 组合问题 (${interaction.questions.length} 项)`;
    summary = interaction.questions.map(q => q.prompt).join('；');
  }

  return {
    refId: `interaction:${interaction.interactionId}`,
    category,
    provider: session.native.provider,
    title,
    summary,
    sourceSessionId,
    sourceDestination,
    interactionId: interaction.interactionId,
    revision: interaction.revision,
    connectionGeneration: interaction.connectionGeneration,
    turnId: interaction.turnId,
    nativeRequestId: interaction.nativeRequestId,
    expiresAt: interaction.expiresAt,
    interaction,
    sourceTopicUrl,
  };
}

export function buildDecisionPendingItem(
  decision: DecisionRecord,
  sourceTopicUrl: string | null,
): PendingDecisionItem {
  return {
    refId: `decision:${decision.decisionId}`,
    category: decision.kind,
    provider: 'decision',
    title: `${decision.kind === 'business_decision' ? '业务决定' : '执行授权'}: ${decision.title}`,
    summary: decision.prompt,
    decisionId: decision.decisionId,
    version: decision.version,
    digest: decision.digest,
    sourceSessionId: decision.source.sessionId ?? null,
    sourceDestination: decision.source.destination ?? null,
    expiresAt: decision.expiresAt,
    decision,
    sourceTopicUrl,
  };
}

export function renderPendingItemCard(
  item: PendingItemView,
  entryPoint: 'hub' | 'source',
  hubBindingId: string,
  nowMs: number,
): ChannelCard {
  if (item.provider !== 'decision') {
    const base = interactionCard(item.interaction, false);
    const actions: ChannelCard['actions'] = base.actions.map((a) => ({
      ...a,
      value: {
        ...a.value,
        entry: entryPoint,
        category: item.category,
        sourceSessionId: item.sourceSessionId,
        bindingId: hubBindingId,
      },
    }));
    if (entryPoint === 'hub' && isSafePendingAppLink(item.sourceTopicUrl)) {
      actions.push({ label: '跳回源话题', value: {}, url: item.sourceTopicUrl });
    }
    const prefix =
      entryPoint === 'source'
        ? `【等待你处理 · ${PENDING_CATEGORY_LABELS[item.category]}】`
        : `【待处理 · ${PENDING_CATEGORY_LABELS[item.category]} · ${providerDisplayLabel(item.provider)}】`;
    const sourceNote = entryPoint === 'source' ? '（已同步至「待处理」汇总，任一处处理即可）' : '';
    const card: ChannelCard = {
      ...base,
      title: `${prefix}${base.title}`,
      text: item.interaction.kind === 'approval' ? [base.text, sourceNote].filter(Boolean).join('\n\n') : '',
      actions,
    };
    if (item.interaction.kind !== 'approval') {
      card.schema = '2.0';
      card.actions = actions.filter(action => action.url);
      card.form = questionForm(item.interaction, hubBindingId, false, nowMs, {
        entry: entryPoint,
        category: item.category,
        sourceSessionId: item.sourceSessionId,
      });
      if (sourceNote) card.form.statusText = sourceNote;
    }
    return card;
  }

  const d = item.decision;
  const actions: ChannelCard['actions'] = d.options.map((opt) => ({
    label: opt.label,
    value: {
      action: 'decision_answer',
      entry: entryPoint,
      category: item.category,
      decisionId: d.decisionId,
      expectedVersion: d.version,
      expectedDigest: d.digest,
      selectedOptionId: opt.id,
      bindingId: hubBindingId,
    },
  }));
  if (entryPoint === 'hub' && isSafePendingAppLink(item.sourceTopicUrl)) {
    actions.push({ label: '跳回源话题', value: {}, url: item.sourceTopicUrl });
  }
  const specLine =
    d.kind === 'execution_auth' && d.executionSpec
      ? `\n执行目标: ${escapeCardMarkdown(d.executionSpec.target)} · 动作摘要: ${escapeCardMarkdown(d.executionSpec.actionDigest)} · 过期: ${escapeCardMarkdown(d.executionSpec.expiry)}`
      : '\n性质: 仅业务决定（绝不自动触发执行器/shell）';
  return {
    title: `【待处理 · ${PENDING_CATEGORY_LABELS[item.category]}】${d.title}`,
    text: `ID: ${escapeCardMarkdown(d.decisionId)} (v${d.version})\n${escapeCardMarkdown(d.prompt)}${specLine}`,
    actions,
  };
}

export function formatPendingSummaryCard(
  topicTitle: string,
  page: PendingPage,
  query: PendingQuery = {},
): ChannelCard {
  const headerLine = [
    `模型问答: ${page.countsByCategory.question} 项`,
    `工具权限: ${page.countsByCategory.approval} 项`,
    `业务决定: ${page.countsByCategory.business_decision} 项`,
    `执行授权: ${page.countsByCategory.execution_auth} 项`,
  ].join(' · ');
  const providerLine = `后端分布: Claude ${page.countsByProvider.claude} · Codex ${page.countsByProvider.codex} · Antigravity ${page.countsByProvider.agy} · 决定 ${page.countsByProvider.decision}`;
  const itemLines =
    page.items.length === 0
      ? ['当前没有待处理事项。']
      : page.items.map(
          (item, idx) =>
            `${idx + 1}. 【${PENDING_CATEGORY_LABELS[item.category]}】${escapeCardMarkdown(item.title.replace(/\s+/gu, ' '))}`,
        );
  const actions: ChannelCard['actions'] = [];
  for (const [index, item] of page.items.entries()) {
    if (isSafePendingAppLink(item.sourceTopicUrl)) {
      actions.push({ label: `${index + 1} · 跳回源话题`, value: {}, url: item.sourceTopicUrl });
    }
  }
  if (page.nextCursor !== null) {
    actions.push({
      label: '下一页',
      value: {
        action: 'pending_page',
        cursor: page.nextCursor,
        ...(query.category ? { category: query.category } : {}),
        ...(query.provider ? { provider: query.provider } : {}),
      },
    });
  }
  return {
    title: `${topicTitle}汇总（共 ${page.total} 项）`,
    text: `${headerLine}\n${providerLine}\n\n${itemLines.join('\n')}`,
    actions,
  };
}

export function paginatePendingItems(all: PendingItemView[], query: PendingQuery = {}): PendingPage {
  const countsByCategory: Record<PendingCategory, number> = {
    question: 0,
    approval: 0,
    business_decision: 0,
    execution_auth: 0,
  };
  const countsByProvider: Record<PendingSourceProvider, number> = {
    claude: 0,
    codex: 0,
    agy: 0,
    decision: 0,
  };
  for (const item of all) {
    countsByCategory[item.category] += 1;
    countsByProvider[item.provider] += 1;
  }

  const search = query.search?.trim().toLowerCase();
  const filtered = all.filter((item) => {
    if (query.category && query.category !== 'all' && item.category !== query.category) return false;
    if (query.provider && query.provider !== 'all' && item.provider !== query.provider) return false;
    if (search) {
      const hay = `${item.refId} ${item.category} ${item.provider} ${item.title} ${item.summary} ${item.sourceSessionId ?? ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const limit = query.limit ?? 5;
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail('invalid_request', 'invalid pending pagination cursor or limit');
  }

  const slice = filtered.slice(start, start + limit);
  const nextCursor = start + limit < filtered.length ? String(start + limit) : null;
  return {
    items: slice,
    total: filtered.length,
    nextCursor,
    countsByCategory,
    countsByProvider,
  };
}
