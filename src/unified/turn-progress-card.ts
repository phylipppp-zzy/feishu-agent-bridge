import type { Artifact, Message, Provider, Turn } from './contracts.js';
import {
  formatCompactTokenCount,
  formatContextStatusLine,
  formatContextUsageBadge,
  type CompactTurnInfo,
  type ContextUsageInfo,
} from './context-usage.js';
import { escapeCardMarkdown } from './feishu-card-wire.js';
import { providerBadgeColor, providerDisplayLabel, type ChannelCard, type ChannelCardHeaderTag } from './feishu-cards.js';
import { isTerminalTool, type ToolProgress } from './tool-progress.js';
import type { TurnToolCounts } from './turn-progress-store.js';

import { formatCardReplyBody } from './turn-reply.js';

const LOG_SIZE = 15;
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
  const combined: Array<{ active: boolean; line: string }> = [];
  for (const item of [...deduped.values()].reverse()) {
    combined.push({
      active: !isTerminalTool(item.phase),
      line: `- ${TOOL_ICONS[item.phase]} ${escapeCardMarkdown(item.summary)}（${TOOL_PHASE_LABELS[item.phase]}）`,
    });
  }
  if (activeSubagents?.length) {
    const seenSubIds = new Set<string>();
    for (const sub of activeSubagents) {
      if (seenSubIds.has(sub.conversationId)) continue;
      seenSubIds.add(sub.conversationId);
      const label = sub.agentName?.trim() || `子代理 ${sub.conversationId.slice(0, 8)}`;
      combined.push({
        active: true,
        line: `- ⏳ 🤖 会话级活跃子代理：${escapeCardMarkdown(label)}（运行中）`,
      });
    }
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
  const totalThinkingCount = tools.filter(tool => tool.tool === 'thinking').length;
  const count = Math.max(0, (toolCounts?.totalTools ?? tools.length) - totalThinkingCount);
  const failedCount = toolCounts?.failedTools ?? visibleTools.filter(tool => tool.phase === 'failed').length;
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

  const raw = message?.blocks.map(block => block.type === 'text' ? block.text :
    `[文件 ${escapeCardMarkdown(block.artifactId)}]`).join('\n') ?? '';
  const preview = formatCardReplyBody(raw);
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
  const actions: ChannelCard['actions'] = [];
  if (preview.truncated && message && allowFullReplyButton) actions.push({ label: '发送完整正文 (.txt)', value: { action: 'full_reply', messageId: message.messageId } });
  for (const file of files.slice(0, 3)) {
    const name = [...file.name];
    actions.push({ label: `发送文件：${name.length > 22 ? name.slice(0, 21).join('') + '…' : file.name}`,
      value: { action: 'file', artifactId: file.artifactId, contentVersion: file.contentVersion } });
  }
  if (allowCompactButton && !isCompact) {
    const highUsage = Boolean(ctxBadge && ctxBadge.pct >= 80);
    const pctSuffix = highUsage && ctxBadge ? ` (${ctxBadge.pct}%)` : '';
    actions.push({
      label: running ? `🗜️ 排队压缩上下文${pctSuffix}` : `🗜️ 压缩上下文${pctSuffix}`,
      type: highUsage ? 'primary' : 'default',
      value: { action: 'compact' },
    });
  }
  const logTools = visibleTools.filter(tool => tool.tool !== 'thinking');
  const lines = logTools.slice(-LOG_SIZE).map(tool => `${TOOL_ICONS[tool.phase]} ${tool.summary}`);
  if (count > lines.length && logTools.length > 0) lines.unshift(`已省略较早的 ${count - lines.length} 项`);
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
