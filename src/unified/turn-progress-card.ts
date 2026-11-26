import type { Artifact, Message, Provider, Turn } from './contracts.js';
import { stripCardMentions, escapeCardMarkdown } from './feishu-card-wire.js';
import { providerDisplayLabel, type ChannelCard } from './feishu-cards.js';
import type { ToolProgress } from './tool-progress.js';
import type { TurnToolCounts } from './turn-progress-store.js';

import { formatCardReplyBody } from './turn-reply.js';

const LOG_SIZE = 15;

export function replyText(message: Message): string {
  return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
}

export function completionText(duration: number, message: Message | undefined, count: number): string {
  const firstLine = message && stripCardMentions(replyText(message))
    .replace(/!?\[([^\]\r\n]*)\]\([^\r\n)]*\)/g, '$1')
    .replace(/<[^>\r\n]*>/g, '')
    .split(/\r\n|[\r\n\u0085\u2028\u2029]/u).map(line => line.replace(/^\s*(?:(?:#{1,6}|>|[-*+]|\d+[.)])\s+)+/, '').replace(/[`*_~]/g, '').trim())
    .find(Boolean);
  const chars = [...(firstLine ?? '')];
  const summary = chars.length > 80 ? `${chars.slice(0, 79).join('').trimEnd()}…` : firstLine ?? `完成 ${count} 项工具操作`;
  return `✅ 本轮已完成（用时 ${formatDuration(duration)}）· ${summary}`.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
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
};

function formatRunningNote(active: readonly ToolProgress[]): string | undefined {
  if (!active.length) return undefined;
  const latest = active.at(-1)!;
  const extra = active.length > 1 ? `（另有 ${active.length - 1} 项并行）` : '';
  if (latest.tool === 'swarm_wait') return `🐝 Swarm 协作中：等待成员回报…${extra}`;
  if (latest.tool === 'swarm' || latest.tool === 'post_message' || latest.tool === 'read_board') {
    return `${latest.summary}${extra}`;
  }
  if (latest.tool === 'invoke_subagent' || latest.tool === 'run_workflow') {
    return `${latest.summary}${extra}`;
  }
  if (latest.tool === 'thinking') {
    return `🧠 正在深度思考…${extra}`;
  }
  return `⏳ 正在执行：${latest.summary}${extra}`;
}

export function turnProgressCard({ provider, status, schema, message, tools, toolCounts, duration, files, turnId }: CardState): ChannelCard {
  const title = providerDisplayLabel(provider);
  const isWakeup = Boolean(turnId?.startsWith('wakeup:'));
  const visibleTools = tools.filter(tool => !(tool.tool === 'thinking' && tool.phase !== 'running'));
  const finishedThinkingCount = tools.length - visibleTools.length;
  const count = Math.max(0, (toolCounts?.totalTools ?? tools.length) - finishedThinkingCount);
  const failedCount = toolCounts?.failedTools ?? visibleTools.filter(tool => tool.phase === 'failed').length;
  const running = status === 'running' || status === 'queued' || status === undefined && !message?.final;
  const elapsed = duration === null ? '' : ` · 用时 ${formatDuration(duration)}`;
  const header: Pick<ChannelCard, 'title' | 'template'> = status === 'completed'
    ? { title: `${title} · ${isWakeup ? '后台唤醒已完成' : '已完成'}${elapsed}`, template: 'green' }
    : status === 'failed' ? { title: `${title} · 执行失败`, template: 'red' }
      : status === 'interrupted' ? { title: `${title} · 已中断`, template: 'grey' }
        : running
          ? { title: `${title} · ${isWakeup ? '后台唤醒进行中' : '进行中'}${elapsed}`, template: 'blue' }
          : { title: `${title} · 回复` };
  const raw = message?.blocks.map(block => block.type === 'text' ? block.text :
    `[文件 ${escapeCardMarkdown(block.artifactId)}]`).join('\n') ?? '';
  const preview = formatCardReplyBody(raw);
  const active = running ? visibleTools.filter(tool => tool.phase === 'running') : [];
  const activeReal = active.filter(tool => tool.tool !== 'thinking');
  const onlyThinking = active.length > 0 && activeReal.length === 0;
  const hasActiveSwarm = activeReal.some(tool => tool.tool === 'swarm' || tool.tool === 'swarm_wait' || tool.tool === 'post_message' || tool.tool === 'read_board');
  const runningNote = formatRunningNote(activeReal);
  const idleBody = onlyThinking
    ? '🧠 正在深度思考…'
    : hasActiveSwarm
      ? '🐝 Swarm 多代理协作进行中…'
      : isWakeup
        ? '🤖 后台异步唤醒处理中…'
        : '正在处理…';
  const text = preview.text || (running ? idleBody : status === 'completed' ?
      (count ? `完成 ${count} 项工具操作` : '本轮处理完成。') : '本轮未形成完整回复。');
  const actions: ChannelCard['actions'] = [];
  if (preview.truncated && message) actions.push({ label: '发送完整正文 (.txt)', value: { action: 'full_reply', messageId: message.messageId } });
  for (const file of files.slice(0, 3)) {
    const name = [...file.name];
    actions.push({ label: `发送文件：${name.length > 22 ? name.slice(0, 21).join('') + '…' : file.name}`,
      value: { action: 'file', artifactId: file.artifactId, contentVersion: file.contentVersion } });
  }
  const icons = { succeeded: '✓', failed: '✗', running: '⏳', pending: '⏳', cancelled: '—' };
  const logTools = visibleTools.filter(tool => tool.tool !== 'thinking');
  const lines = logTools.slice(-LOG_SIZE).map(tool => `${icons[tool.phase]} ${tool.summary}`);
  if (count > lines.length && logTools.length > 0) lines.unshift(`已省略较早的 ${count - lines.length} 项`);
  const executionLog = (logTools.length > 0 || runningNote) ? { count: Math.max(logTools.length, count), failedCount,
    lines, ...(runningNote ? { runningNote } : {}) } : undefined;
  return { schema, ...header, text, actions, ...(executionLog ? { executionLog } : {}) };
}
