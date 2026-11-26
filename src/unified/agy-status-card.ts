import { compactCardField, shortenHomePath } from './card-formatters.js';
import { escapeCardMarkdown } from './feishu-card-wire.js';
import type { ChannelCard } from './feishu-cards.js';
import type { AgySessionHolder } from './agy/process-guard.js';
import type { AgySessionStatusItem, AgyStatusSnapshot } from './agy/session-status.js';

const STATUS_LABELS: Record<AgySessionStatusItem['status'], string> = {
  running: '运行中',
  busy: '忙碌',
  canceling: '取消中',
  idle: '空闲',
  unspecified: '状态未知',
};

function formatBeijingTime(iso: string | null): string {
  if (!iso) return '时间未知';
  const beijing = new Date(Date.parse(iso) + 8 * 3600 * 1000);
  return Number.isFinite(beijing.getTime())
    ? beijing.toISOString().slice(5, 16).replace('T', ' ') + ' 北京'
    : '时间未知';
}

function statusLabel(item: AgySessionStatusItem): string {
  if (item.notFullyIdle && (item.status === 'idle' || item.status === 'unspecified')) return '未完全空闲';
  return STATUS_LABELS[item.status];
}

function holderLabel(holder: AgySessionHolder): string {
  if (holder.kind === 'bridge_acp') return `飞书桥接 ACP PID ${holder.pid}`;
  const tty = holder.tty ? ` (${escapeCardMarkdown(compactCardField(holder.tty, 60))})` : '';
  return `本地终端 PID ${holder.pid}${tty}`;
}

function sessionLabel(item: AgySessionStatusItem): string {
  const title = escapeCardMarkdown(compactCardField(item.title, 80));
  const project = item.project ? ` · ${escapeCardMarkdown(compactCardField(shortenHomePath(item.project), 60))}` : '';
  return `• ${title} · ${escapeCardMarkdown(item.shortId)}${project}`;
}

function holderSuffix(holders: AgySessionHolder[]): string {
  return holders.length ? ` · ${holders.map(holderLabel).join(' / ')}` : '';
}

function section(
  heading: string,
  items: AgySessionStatusItem[],
  limit: number,
  empty: string,
  render: (item: AgySessionStatusItem) => string,
): string {
  const lines = items.length ? items.slice(0, limit).map(render) : [empty];
  if (items.length > limit) lines.push(`…其余 ${items.length - limit} 条`);
  return [`**${heading}**`, ...lines].join('\n');
}

export function buildAgyStatusCard(snapshot: AgyStatusSnapshot): ChannelCard {
  const { running, held, completed } = snapshot;
  const external = held.filter(item => item.holders.some(holder => holder.kind === 'external_cli')).length;
  const bridge = held.filter(item => item.holders.some(holder => holder.kind === 'bridge_acp')).length;
  const template: ChannelCard['template'] = snapshot.error ? 'grey'
    : external ? 'orange'
    : running.length ? 'blue'
    : completed.length || held.some(item => item.status === 'idle') ? 'green'
    : 'grey';
  const summary = [
    `进行中 ${running.length} · 被进程持有 ${held.length}（本地终端 ${external} / 飞书桥接 ${bridge}） · 最近已完成 ${Math.min(completed.length, 8)}`,
    `采样：${formatBeijingTime(snapshot.observedAt)}`,
  ];
  if (snapshot.error) summary.push('会话摘要读取失败，请刷新重试。');
  else if (!snapshot.summariesAvailable) summary.push('未找到会话摘要数据库。');
  return {
    title: 'Antigravity 会话与进程状态',
    template,
    format: 'markdown',
    text: [
      summary.join('\n'),
      section('进行中', running, 15, '暂无进行中的会话。', item =>
        `${sessionLabel(item)} · ${statusLabel(item)} · ${formatBeijingTime(item.lastModifiedTime)}${holderSuffix(item.holders)}`),
      section('被进程持有的会话', held, 15, '当前没有进程持有任何 agy 会话。', item =>
        `${sessionLabel(item)} · ${statusLabel(item)}${holderSuffix(item.holders)}`),
      section('最近已完成', completed, 8, '暂无已完成的会话。', item =>
        `${sessionLabel(item)} · ${formatBeijingTime(item.lastModifiedTime)}${holderSuffix(item.holders.filter(holder => holder.kind === 'external_cli'))}`),
    ].join('\n\n'),
    actions: [
      { label: '刷新状态', value: { action: 'agy_status' } },
      { label: 'Antigravity 会话列表', value: { action: 'list', provider: 'agy' } },
    ],
  };
}
