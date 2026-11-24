import type { Artifact, Message, Provider, Turn } from './contracts.js';
import { stripCardMentions, escapeCardMarkdown } from './feishu-card-wire.js';
import { providerDisplayLabel, type ChannelCard } from './feishu-cards.js';
import type { ToolProgress } from './tool-progress.js';
import type { TurnToolCounts } from './turn-progress-store.js';

const PREVIEW_LENGTH = 3000;
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
  const summary = firstLine ? [...firstLine].slice(0, 80).join('') : `完成 ${count} 项工具操作`;
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
};

export function turnProgressCard({ provider, status, schema, message, tools, toolCounts, duration, files }: CardState): ChannelCard {
  const title = providerDisplayLabel(provider);
  const count = toolCounts?.totalTools ?? tools.length;
  const failedCount = toolCounts?.failedTools ?? tools.filter(tool => tool.phase === 'failed').length;
  const running = status === 'running' || status === 'queued' || status === undefined && !message?.final;
  const elapsed = duration === null ? '' : ` · 用时 ${formatDuration(duration)}`;
  const header: Pick<ChannelCard, 'title' | 'template'> = status === 'completed'
    ? { title: `${title} · 已完成${elapsed}`, template: 'green' }
    : status === 'failed' ? { title: `${title} · 执行失败`, template: 'red' }
      : status === 'interrupted' ? { title: `${title} · 已中断`, template: 'grey' }
        : running
          ? { title: `${title} · 进行中${elapsed}`, template: 'blue' }
          : { title: `${title} · 回复` };
  const raw = message?.blocks.map(block => block.type === 'text' ? block.text :
    `[文件 ${escapeCardMarkdown(block.artifactId)}]`).join('\n') ?? '';
  const chars = [...raw];
  const long = chars.length > PREVIEW_LENGTH;
  const text = long
    ? `仅显示正文末尾，点击底部按钮获取完整正文。\n\n${chars.slice(-PREVIEW_LENGTH).join('')}`
    : raw || (running ? '正在处理…' : status === 'completed' ?
      (count ? `完成 ${count} 项工具操作` : '本轮处理完成。') : '本轮未形成完整回复。');
  const actions: ChannelCard['actions'] = [];
  if (long && message) actions.push({ label: '发送完整正文 (.txt)', value: { action: 'full_reply', messageId: message.messageId } });
  for (const file of files.slice(0, 3)) {
    const name = [...file.name];
    actions.push({ label: `发送文件：${name.length > 22 ? name.slice(0, 21).join('') + '…' : file.name}`,
      value: { action: 'file', artifactId: file.artifactId, contentVersion: file.contentVersion } });
  }
  const active = running ? tools.filter(tool => tool.phase === 'running') : [];
  const runningNote = active.length ? `⏳ 正在执行：${active.at(-1)!.summary}${active.length > 1 ? `（另有 ${active.length - 1} 项并行）` : ''}` : undefined;
  const icons = { succeeded: '✓', failed: '✗', running: '⏳', pending: '⏳', cancelled: '—' };
  const lines = tools.slice(-LOG_SIZE).map(tool => `${icons[tool.phase]} ${tool.summary}`);
  if (count > lines.length) lines.unshift(`已省略较早的 ${count - lines.length} 项`);
  const executionLog = count ? { count, failedCount,
    lines, ...(runningNote ? { runningNote } : {}) } : undefined;
  return { schema, ...header, text, actions, ...(executionLog ? { executionLog } : {}) };
}
