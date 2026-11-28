import type { Artifact, Message, Provider, Turn } from './contracts.js';
import {
  formatCompactTokenCount,
  formatContextStatusLine,
  formatContextUsageBadge,
  type CompactTurnInfo,
  type ContextUsageInfo,
} from './context-usage.js';
import { escapeCardMarkdown } from './feishu-card-wire.js';
import { providerBadgeColor, providerDisplayLabel, type ChannelCard, type ChannelCardAction, type ChannelCardHeaderTag } from './feishu-cards.js';
import { isTerminalTool, isTerminalTurn, type ToolProgress } from './tool-progress.js';
import type { TurnToolCounts } from './turn-progress-store.js';

import { formatCardReplyBody } from './turn-reply.js';

const LOG_SIZE = 15;
const SHANGHAI_CLOCK = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
});
const DELEGATED_TOOLS = new Set([
  'invoke_subagent', 'run_workflow', 'swarm', 'swarm_wait', 'manage_subagents', 'manage_task', 'send_message',
]);
const isDispatchSummary = (summary: string): boolean =>
  summary.startsWith('⚡ Codex MCP') || summary.startsWith('⚡ Agent Dispatch');
const TOOL_ICONS = { succeeded: '✓', failed: '✗', running: '⏳', pending: '⏳', cancelled: '—' };
const TOOL_PHASE_LABELS = { succeeded: '已完成', failed: '失败', running: '进行中', pending: '等待开始', cancelled: '已取消' };

export function replyText(message: Message): string {
  return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
}

const COMPACT_EFFORT_SUFFIX_RE = /^(.*?)(?:-tiered)?-(low|medium|high|xhigh|max)$/i;

/** Format a compact model + reasoning effort badge for turn card headers, e.g. `carbon medium`, `neon high`, `sol high`. */
export function formatCompactModelBadge(model?: string | null, effort?: string | null): string {
  const rawModel = typeof model === 'string' ? model.trim() : '';
  let base = rawModel;
  let parsedEffort = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  const m = COMPACT_EFFORT_SUFFIX_RE.exec(base);
  if (m) {
    base = m[1]!.trim();
    if (!parsedEffort) parsedEffort = m[2]!.toLowerCase();
  }
  if (!base) return '';
  const lower = base.toLowerCase();
  let shortModel: string;
  if (/^gemini-\d+(?:\.\d+)?-(carbon|neon|hydrogen|argon)$/.test(lower)) {
    shortModel = lower.split('-').at(-1)!;
  } else if (/^gpt-[\d.]+-(sol|astra|luna)$/.test(lower)) {
    shortModel = lower.split('-').at(-1)!;
  } else if (/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/.test(lower)) {
    const cm = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/.exec(lower)!;
    shortModel = `${cm[1]} ${cm[2]}.${cm[3]}`;
  } else {
    shortModel = lower.replace(/^(?:gemini|claude)-/, '').replace(/-/g, ' ').trim();
  }
  const cleanEffort = /^(low|medium|high|xhigh|max)$/.test(parsedEffort) ? parsedEffort : '';
  return cleanEffort ? `${shortModel} ${cleanEffort}` : shortModel;
}

export function completionText(duration: number, _message?: Message | undefined, _count?: number): string {
  return `✅ 本轮已完成（用时 ${formatDuration(duration)}），完整结论见上方回复卡。`;
}

export interface SessionSubagentActivity {
  conversationId: string;
  agentName: string;
  status: string;
  kind?: 'subagent' | 'dispatch_job';
  activity?: string;
  elapsedSec?: number;
  engine?: 'agy' | 'codex';
}

type CardState = {
  provider: Provider;
  status: Turn['status'] | undefined;
  schema: '1.0' | '2.0';
  message: Message | undefined;
  tools: readonly ToolProgress[];
  toolCounts?: TurnToolCounts | undefined;
  duration: number | null;
  files: readonly Artifact[];
  turnId?: string | undefined;
  activeSubagents?: readonly SessionSubagentActivity[] | undefined;
  allowFullReplyButton?: boolean | undefined;
  allowCompactButton?: boolean | undefined;
  modelBadge?: string | undefined;
  contextUsage?: ContextUsageInfo | null | undefined;
  compactInfo?: CompactTurnInfo | undefined;
};

export type TurnCardState = CardState & {
  isCliReadonly?: boolean | undefined;
  sessionConnected?: boolean | undefined;
  sessionId?: string | undefined;
  completedAtMs?: number | null | undefined;
  stopAction?: ChannelCardAction | undefined;
  isWakeup?: boolean | undefined;
};

function formatRunningNote(active: readonly ToolProgress[]): string | undefined {
  if (!active.length) return undefined;
  const latest = active.at(-1)!;
  const extra = active.length > 1 ? `（另有 ${active.length - 1} 项并行）` : '';
  if (/^(?:⚡ (?:Codex MCP|Agent Dispatch)|🤖|🐝)/u.test(latest.summary)) {
    return `⏳ ${latest.summary}${extra}`;
  }
  if (latest.tool === 'thinking') {
    return `🧠 正在深度思考…${extra}`;
  }
  return `⏳ 正在执行：${latest.summary}${extra}`;
}

function isSubagentActiveStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  return !s || s === 'running' || s === 'queued' || s === 'busy' || s.includes('running');
}

function formatSubagentActivityLine(sub: SessionSubagentActivity): { active: boolean; line: string } {
  const label = sub.agentName?.trim() || `子代理 ${sub.conversationId.slice(0, 8)}`;
  const active = isSubagentActiveStatus(sub.status);
  const s = sub.status.trim().toLowerCase();
  const elapsed = typeof sub.elapsedSec === 'number' && Number.isFinite(sub.elapsedSec) && sub.elapsedSec >= 0
    ? formatDuration(sub.elapsedSec * 1000)
    : '';
  const detailParts: string[] = [];
  if (s === 'queued') detailParts.push('排队中');
  else if (active) detailParts.push('运行中');
  else if (s === 'completed' || s === 'idle') detailParts.push('已完成');
  else if (s === 'timed_out') detailParts.push('已超时');
  else if (s === 'cancelled') detailParts.push('已取消');
  else detailParts.push('失败');
  if (elapsed) detailParts.push(elapsed);
  if (active && sub.activity?.trim()) detailParts.push(escapeCardMarkdown(sub.activity.trim()));
  const icon = active ? '⏳' : (s === 'completed' || s === 'idle') ? '✓' : s === 'cancelled' ? '—' : '✗';
  if (sub.kind === 'dispatch_job') {
    const engineBadge = sub.engine === 'agy' ? '⚡ AGY' : '⚡ Codex';
    return {
      active,
      line: `- ${icon} ${engineBadge} \\[${escapeCardMarkdown(label)}\\]（${detailParts.join(' · ')}）`,
    };
  }
  const rolePrefix = active ? '🤖 会话级活跃子代理：' : '🤖 子代理：';
  return {
    active,
    line: `- ${icon} ${rolePrefix}${escapeCardMarkdown(label)}（${detailParts.join(' · ')}）`,
  };
}

function isAsyncDispatchLaunch(item: ToolProgress): boolean {
  if (item.tool === 'invoke_subagent') return true;
  if ((item.tool === 'call_mcp_tool' || item.tool.startsWith('mcp_')) && isDispatchSummary(item.summary)) {
    return !/(?:等待作业|查询作业|取消作业|作业列表|状态查询)/.test(item.summary);
  }
  return false;
}

function formatDelegatedStatus(
  tools: readonly ToolProgress[],
  activeSubagents?: readonly SessionSubagentActivity[],
): string {
  const deduped = new Map<string, ToolProgress>();
  for (const item of tools) {
    if (DELEGATED_TOOLS.has(item.tool) || ((item.tool === 'call_mcp_tool' || item.tool.startsWith('mcp_')) && isDispatchSummary(item.summary))) {
      deduped.delete(item.callId);
      deduped.set(item.callId, item);
    }
  }
  const hasRealSubagents = Boolean(activeSubagents?.some(s => s.kind !== 'dispatch_job'));
  const hasRealDispatchJobs = Boolean(activeSubagents?.some(s => s.kind === 'dispatch_job'));
  const combined: Array<{ active: boolean; line: string }> = [];
  if (activeSubagents?.length) {
    const seenSubIds = new Set<string>();
    for (const sub of activeSubagents) {
      if (seenSubIds.has(sub.conversationId)) continue;
      seenSubIds.add(sub.conversationId);
      combined.push(formatSubagentActivityLine(sub));
    }
  }
  for (const item of [...deduped.values()].reverse()) {
    const isSubagentLaunch = item.tool === 'invoke_subagent';
    const isMcpDispatchLaunch = !isSubagentLaunch && isAsyncDispatchLaunch(item);
    // Once real runtime status is available, omit succeeded async launch echoes so we show real status instead of dispatch echoes.
    if (item.phase === 'succeeded' && ((isSubagentLaunch && hasRealSubagents) || (isMcpDispatchLaunch && hasRealDispatchJobs))) {
      continue;
    }
    const phaseLabel = item.phase === 'succeeded' && (isSubagentLaunch || isMcpDispatchLaunch)
      ? '已派发'
      : TOOL_PHASE_LABELS[item.phase];
    combined.push({
      active: !isTerminalTool(item.phase),
      line: `- ${TOOL_ICONS[item.phase]} ${escapeCardMarkdown(item.summary)}（${phaseLabel}）`,
    });
  }
  combined.sort((a, b) => Number(!a.active) - Number(!b.active));
  const maxItems = 8;
  const shown = combined.slice(0, maxItems);
  const lines = shown.map(item => item.line);
  const omitted = combined.length - shown.length;
  if (omitted > 0) {
    lines.push(`- … 另有 ${omitted} 项子代理/Codex 记录`);
  }
  if (!lines.length) return '';
  return ['**子代理与 Codex 状态**', ...lines].join('\n');
}

function extractThinkingSummary(tools: readonly ToolProgress[]): string | undefined {
  for (let i = tools.length - 1; i >= 0; i--) {
    const item = tools[i]!;
    if (item.tool !== 'thinking') continue;
    const stripped = item.summary.replace(/^🧠\s*/u, '').trim();
    if (stripped && stripped !== '正在深度思考…') return stripped;
  }
  return undefined;
}

function formatCompactResultText(compactInfo: CompactTurnInfo, replyPreview: string): string {
  const before = compactInfo.beforeTokens;
  const after = compactInfo.afterTokens;
  const max = compactInfo.maxTokens;
  let summaryLine = '✅ 上下文已压缩。';
  if (typeof before === 'number' && before > 0 && typeof after === 'number' && after > 0) {
    const savedPct = before > after ? Math.round(((before - after) / before) * 100) : 0;
    const maxSuffix = typeof max === 'number' && max > 0 ? ` / \`${formatCompactTokenCount(max)}\`` : '';
    const savedSuffix = savedPct > 0 ? `（释放 ${savedPct}%）` : '';
    summaryLine = `✅ 上下文压缩完成：\`${formatCompactTokenCount(before)}\` → \`${formatCompactTokenCount(after)}\`${maxSuffix}${savedSuffix}`;
  } else if (typeof after === 'number' && after > 0) {
    const maxSuffix = typeof max === 'number' && max > 0 ? ` / \`${formatCompactTokenCount(max)}\`` : '';
    summaryLine = `✅ 上下文压缩完成，当前占用：\`${formatCompactTokenCount(after)}\`${maxSuffix}`;
  }
  return replyPreview ? `${summaryLine}\n\n${replyPreview}` : summaryLine;
}

function countTools(tools: readonly ToolProgress[], toolCounts?: TurnToolCounts) {
  const realTools = tools.filter(tool => tool.tool !== 'thinking');
  const count = Math.max(0, (toolCounts?.totalTools ?? tools.length) - (tools.length - realTools.length));
  const failedCount = toolCounts?.failedTools ?? realTools.filter(tool => tool.phase === 'failed').length;
  return { realTools, count, failedCount };
}

function replyPreview(message: Message | undefined, allowFullReplyButton = true) {
  const raw = message?.blocks.map(block => block.type === 'text' ? block.text :
    `[文件 ${escapeCardMarkdown(block.artifactId)}]`).join('\n') ?? '';
  return formatCardReplyBody(raw, allowFullReplyButton);
}

function replyActions(
  files: readonly Artifact[],
  fullReplyAnchor?: string,
  options?: { sessionId?: string; messageId?: string },
): ChannelCardAction[] {
  const actions: ChannelCardAction[] = [];
  if (fullReplyAnchor) actions.push({ label: '发送完整正文 (.txt)', value: { action: 'full_reply', messageId: fullReplyAnchor } });
  if (files.length > 0) {
    actions.push({
      label: files.length > 1 ? `📎 发送文件 (${files.length})` : '📎 发送文件',
      value: {
        action: 'artifacts',
        newCard: true,
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options?.messageId ? { messageId: options.messageId } : {}),
      },
    });
  }
  return actions;
}

function compactAction(contextUsage: CardState['contextUsage'], running = false): ChannelCardAction {
  const pct = formatContextUsageBadge(contextUsage)?.pct ?? 0;
  const pctSuffix = pct >= 80 ? ` (${pct}%)` : '';
  return {
    label: running ? `🗜️ 排队压缩上下文${pctSuffix}` : `🗜️ 压缩上下文${pctSuffix}`,
    type: pct >= 80 ? 'primary' : 'default',
    value: { action: 'compact' },
  };
}

function stepLines(logTools: readonly ToolProgress[], count: number): string[] {
  const lines = logTools.slice(-LOG_SIZE).map(tool => `${TOOL_ICONS[tool.phase]} ${tool.summary}`);
  if (count > lines.length && logTools.length > 0) lines.unshift(`已省略较早的 ${count - lines.length} 项`);
  return lines;
}

function turnHeader(state: TurnCardState, running: boolean) {
  const { provider, isCliReadonly } = state;
  const prefix = providerDisplayLabel(provider) + (isCliReadonly ? ' (CLI)' : '');
  const headerTags: ChannelCardHeaderTag[] | undefined = isCliReadonly
    ? [{ text: running ? '💻 CLI 运行' : '💻 CLI 镜像', color: 'wathet' }]
    : undefined;
  const isCompact = Boolean(state.compactInfo?.isCompact);
  const isWakeup = state.isWakeup ?? Boolean(state.turnId?.startsWith('wakeup:'));
  const model = state.modelBadge?.trim() || formatCompactModelBadge(state.contextUsage?.model);
  return { prefix, headerTags, isCompact, isWakeup, model };
}

export function turnProcessCard(state: TurnCardState): ChannelCard {
  const { status, tools, toolCounts, contextUsage, duration, isCliReadonly } = state;
  const running = !isTerminalTurn(status);
  const { prefix, headerTags, isCompact, isWakeup, model } = turnHeader(state, running);
  const { realTools, count, failedCount } = countTools(tools, toolCounts);
  const lines = stepLines(realTools, count);
  const thinking = extractThinkingSummary(tools);
  const runningTools = running ? tools.filter(tool => tool.phase === 'running') : [];
  const runningNote = formatRunningNote(runningTools.filter(tool => tool.tool !== 'thinking'));
  const executionLog = {
    count, lines, failedCount, position: 'top' as const, expanded: running,
    ...(running && thinking ? { thinking } : {}),
    ...(runningNote ? { runningNote } : {}),
    collapseSummary: true,
  };
  const badge = model ? ` · ${model}` : '';
  const delegatedStatus = formatDelegatedStatus(realTools, running ? state.activeSubagents : undefined);
  if (running) {
    const heading = isCompact ? '正在压缩上下文' : isWakeup ? '后台唤醒进行中' : '进行中';
    const statusBanner = formatContextStatusLine(contextUsage);
    const preview = replyPreview(state.message, false).text;
    const idleBody = isCompact ? '🗜️ 正在压缩对话上下文，请稍候…'
      : runningTools.some(tool => tool.tool === 'post_message' || tool.tool === 'read_board') ? '🐝 Swarm 多代理协作进行中…'
        : runningTools.some(tool => tool.tool === 'thinking') && !runningNote ? '🧠 正在深度思考…'
          : isWakeup ? '🤖 后台异步唤醒处理中…'
            : isCliReadonly ? '💻 电脑终端 CLI 正在运行…' : '正在处理…';
    return {
      schema: state.schema,
      title: `${prefix} · ${heading}${badge}`,
      template: 'blue',
      ...(headerTags ? { headerTags } : {}),
      ...(statusBanner ? { statusBanner } : {}),
      executionLog,
      text: [delegatedStatus, preview].filter(Boolean).join('\n\n---\n\n') || idleBody,
      actions: !isCliReadonly && state.sessionConnected && state.stopAction ? [state.stopAction] : [],
    };
  }
  const heading = isCompact ? '压缩过程已完成' : status === 'failed' ? '执行过程失败'
    : status === 'interrupted' ? '执行过程已中断' : '执行过程已完成';
  const steps = count > 0 ? ` · ${count} 步` : '';
  const elapsed = duration === null ? '' : ` · 用时 ${formatDuration(duration)}`;
  const thinkingBlock = thinking ? `**🧠 思考过程**\n${escapeCardMarkdown(thinking)}` : '';
  return {
    schema: state.schema,
    title: `${prefix} · ${heading}${steps}${elapsed}${badge}`,
    template: status === 'failed' ? 'red' : status === 'interrupted' ? 'grey' : 'green',
    ...(headerTags ? { headerTags } : {}),
    executionLog,
    text: [thinkingBlock, delegatedStatus, '过程已归档，最终回复见下方卡片。'].filter(Boolean).join('\n\n'),
    actions: [],
  };
}

function formatClockTime(ms: number): string {
  return SHANGHAI_CLOCK.format(new Date(Number.isFinite(ms) ? ms : Date.now()));
}

export function turnFinalReplyCard(state: TurnCardState): ChannelCard {
  const { status, message, tools, toolCounts, contextUsage, duration, isCliReadonly } = state;
  const { prefix, headerTags, isCompact, isWakeup, model } = turnHeader(state, false);
  const { count, failedCount } = countTools(tools, toolCounts);
  const heading = status === 'failed' ? '执行失败' : status === 'interrupted' ? '已中断'
    : isCompact ? '上下文已压缩' : isWakeup ? '后台唤醒回复' : '回复';
  const fallback = status === 'failed' ? '本轮执行失败，未形成完整回复。'
    : status === 'interrupted' ? '本轮已中断，未形成完整回复。'
      : count ? `已完成 ${count} 项工具操作。` : '本轮处理完成。';
  const canReadFiles = Boolean(isCliReadonly || state.sessionConnected);
  const preview = replyPreview(message, canReadFiles);
  const actions: ChannelCardAction[] = [];
  if (isCliReadonly) actions.push({ label: '一键接入并续聊', value: { action: 'upgrade' } });
  if (canReadFiles) actions.push(...replyActions(state.files, preview.truncated ? message?.messageId : undefined, {
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(message?.messageId ? { messageId: message.messageId } : {}),
  }));
  if (!isCliReadonly && state.sessionConnected) {
    if (!isCompact) actions.push(compactAction(contextUsage));
    actions.push({ label: '切换模型', value: { action: 'models' } });
  }
  if ((isCliReadonly || state.sessionConnected) && state.sessionId) {
    actions.push({ label: '会话控制', value: { action: 'panel', sessionId: state.sessionId } });
  }
  const stats = [
    model ? `🧠 ${escapeCardMarkdown(model)}` : '',
    `🔧 ${count} 步${failedCount ? `（失败 ${failedCount}）` : ''}`,
    duration === null ? '' : `⏱ ${formatDuration(duration)}`,
    `🕒 ${formatClockTime(state.completedAtMs ?? Date.now())}`,
    isCliReadonly ? '💻 电脑终端 CLI' : '',
  ].filter(Boolean).join(' · ');
  return {
    schema: state.schema,
    title: `${prefix} · ${heading}`,
    template: status === 'failed' ? 'red' : status === 'interrupted' ? 'grey' : 'green',
    ...(headerTags ? { headerTags } : {}),
    text: isCompact && status === 'completed' && state.compactInfo
      ? formatCompactResultText(state.compactInfo, preview.text.trim())
      : preview.text.trim() ? preview.text : fallback,
    footer: [formatContextStatusLine(contextUsage), stats].filter(Boolean).join('\n'),
    actions,
  };
}

export function turnProgressCard({
  provider,
  status,
  schema,
  message,
  tools,
  toolCounts,
  duration,
  files,
  turnId,
  activeSubagents,
  allowFullReplyButton = true,
  allowCompactButton = false,
  modelBadge,
  contextUsage,
  compactInfo,
}: CardState): ChannelCard {
  const title = providerDisplayLabel(provider);
  const isWakeup = Boolean(turnId?.startsWith('wakeup:'));
  const isCompact = Boolean(compactInfo?.isCompact);
  const visibleTools = tools.filter(tool => !(tool.tool === 'thinking' && tool.phase !== 'running'));
  const { realTools: logTools, count, failedCount } = countTools(tools, toolCounts);
  const running = status === 'running' || status === 'queued' || status === undefined && !message?.final;
  const elapsed = duration === null ? '' : ` · 用时 ${formatDuration(duration)}`;
  const interruptedElapsed = duration !== null && duration >= 5000 ? elapsed : '';
  const cleanModelBadge = modelBadge?.trim() || formatCompactModelBadge(contextUsage?.model);
  const badge = cleanModelBadge ? ` · ${cleanModelBadge}` : '';
  const ctxBadge = formatContextUsageBadge(contextUsage);

  const header: Pick<ChannelCard, 'title' | 'template'> = status === 'completed'
    ? { title: `${title} · ${isCompact ? '上下文已压缩' : isWakeup ? '后台唤醒已完成' : '已完成'}${elapsed}${badge}`, template: 'green' }
    : status === 'failed' ? { title: `${title} · 执行失败${elapsed}${badge}`, template: 'red' }
      : status === 'interrupted' ? { title: `${title} · 已中断${interruptedElapsed}${badge}`, template: 'grey' }
        : running
          ? { title: `${title} · ${isCompact ? '正在压缩上下文' : isWakeup ? '后台唤醒进行中' : '进行中'}${elapsed}${badge}`, template: 'blue' }
          : { title: `${title} · 回复${badge}` };

  const subtitleParts: string[] = [];
  if (cleanModelBadge) subtitleParts.push(`模型 ${cleanModelBadge}`);
  if (ctxBadge) subtitleParts.push(`上下文 ${ctxBadge.text}`);
  const subtitle = subtitleParts.length ? subtitleParts.join(' · ') : undefined;

  const headerTags: ChannelCardHeaderTag[] = [];
  if (cleanModelBadge) headerTags.push({ text: cleanModelBadge, color: providerBadgeColor(provider) });
  if (ctxBadge) headerTags.push({ text: `上下文 ${ctxBadge.text}`, color: ctxBadge.color });
  const statusBanner = formatContextStatusLine(contextUsage, { modelBadge: cleanModelBadge }) ?? undefined;

  const preview = replyPreview(message);
  const active = running ? visibleTools.filter(tool => tool.phase === 'running') : [];
  const activeReal = active.filter(tool => tool.tool !== 'thinking');
  const onlyThinking = active.length > 0 && activeReal.length === 0;
  const runningNote = formatRunningNote(activeReal);
  const delegatedStatus = running ? formatDelegatedStatus(visibleTools, activeSubagents) : '';
  const thinkingSummary = extractThinkingSummary(tools);
  const idleBody = isCompact
    ? '🗜️ 正在压缩对话上下文，请稍候…'
    : activeReal.some(tool => tool.tool === 'post_message' || tool.tool === 'read_board')
      ? '🐝 Swarm 多代理协作进行中…'
      : onlyThinking
        ? '🧠 正在深度思考…'
        : isWakeup
          ? '🤖 后台异步唤醒处理中…'
          : '正在处理…';
  const text = running
    ? (delegatedStatus
        ? (preview.text ? `${delegatedStatus}\n\n---\n\n${preview.text}` : delegatedStatus)
        : (preview.text || idleBody))
    : isCompact && status === 'completed'
      ? formatCompactResultText(compactInfo!, preview.text)
      : (preview.text || (status === 'completed'
          ? (count ? `完成 ${count} 项工具操作` : '本轮处理完成。')
          : '本轮未形成完整回复。'));
  const actions = replyActions(files, preview.truncated && allowFullReplyButton ? message?.messageId : undefined, {
    ...(message?.messageId ? { messageId: message.messageId } : {}),
  });
  if (allowCompactButton && !isCompact) actions.push(compactAction(contextUsage, running));
  const lines = stepLines(logTools, count);
  const executionLog = (logTools.length > 0 || runningNote || thinkingSummary)
    ? {
        count: logTools.length > 0 ? Math.max(logTools.length, count) : 0,
        lines,
        failedCount,
        ...(runningNote ? { runningNote } : {}),
        ...(thinkingSummary ? { thinking: thinkingSummary } : {}),
        expanded: running || logTools.length <= 5,
        position: 'top' as const,
      }
    : undefined;
  return {
    schema,
    ...header,
    ...(subtitle ? { subtitle } : {}),
    ...(headerTags.length ? { headerTags } : {}),
    ...(statusBanner ? { statusBanner } : {}),
    text,
    actions,
    ...(executionLog ? { executionLog } : {}),
  };
}
