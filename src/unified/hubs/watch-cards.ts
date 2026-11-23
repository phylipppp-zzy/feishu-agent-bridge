import type { ChannelCard } from '../feishu-cards.js';
import type {
  WatchEvent,
  WatchSeverity,
  WatchSource,
  WatchSourceRef,
  WatchState,
} from './watch-types.js';

export const WATCH_SOURCE_LABELS: Record<WatchSource, string> = {
  watch: '看守 (watch)',
  stopwatch: '停训看守 (stopwatch)',
  claude_waiting: 'Claude 等待 (claude_waiting)',
  claude_stop_failure: 'Claude 异常停止 (claude_stop_failure)',
  codex_status: 'Codex 状态 (codex_status)',
  agy_status: 'Antigravity 状态 (agy_status)',
};

export const WATCH_STATE_LABELS: Record<WatchState, string> = {
  alert: '告警',
  waiting: '等待处理',
  failed: '异常失败',
  recovered: '已恢复',
  info: '运行提示',
};

export const WATCH_SEVERITY_LABELS: Record<WatchSeverity, string> = {
  low: '低',
  normal: '普通',
  high: '高',
};

export function isSafeWatchAppLink(url: string | null | undefined): url is string {
  if (!url || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' && ['applink.feishu.cn', 'applink.larksuite.com'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function createWatchRootCard(topicTitle: string): ChannelCard {
  return {
    title: topicTitle,
    text: '看守与运行提醒统一话题（仅限受控看守与状态事件，普通周报独立通知）。',
    actions: [],
  };
}

export function renderWatchCard(params: {
  event: WatchEvent;
  normalizedRef: WatchSourceRef | null;
  previousState: WatchState | null;
  eventCount: number;
  coalescedCount: number;
  hadUnknown: boolean;
  topicUrl: string | null;
}): ChannelCard {
  const { event, normalizedRef, previousState, eventCount, coalescedCount, hadUnknown, topicUrl } = params;
  const lines: string[] = [
    `来源: ${WATCH_SOURCE_LABELS[event.source]}`,
    `对象: ${event.objectId}`,
    `状态: ${WATCH_STATE_LABELS[event.state]} (${event.state})${previousState && previousState !== event.state ? ` <- 原状态: ${WATCH_STATE_LABELS[previousState]} (${previousState})` : ''}`,
    `级别: ${WATCH_SEVERITY_LABELS[event.severity]} (${event.severity})`,
    `时间: ${event.occurredAt}`,
    `摘要: ${event.summary}`,
  ];
  if (normalizedRef) {
    const refParts: string[] = [];
    if (normalizedRef.sessionId) refParts.push(`session=${normalizedRef.sessionId}`);
    if (normalizedRef.taskId) refParts.push(`task=${normalizedRef.taskId}`);
    if (normalizedRef.destination) refParts.push(`dest=${normalizedRef.destination}`);
    if (refParts.length > 0) lines.push(`引用: ${refParts.join(' · ')}`);
  }
  if (coalescedCount > 0 || eventCount > 1) {
    lines.push(`合并计数: 共 ${eventCount} 条事件（低优先级重复合并 ${coalescedCount} 次）`);
  }
  if (hadUnknown) {
    lines.push('历史未知记录: 存在未确认投递/创建结果 (unknown) 历史，当前状态更新不隐瞒该历史记录，请核对。');
  }
  const actions: ChannelCard['actions'] = [];
  if (isSafeWatchAppLink(topicUrl)) {
    actions.push({ label: '返回任务话题', value: {}, url: topicUrl });
  }
  const prefix = event.state === 'recovered' ? '【已恢复】' : event.severity === 'high' ? '【高优提醒】' : '【运行提醒】';
  return {
    title: `${prefix}${event.title}`,
    text: lines.join('\n'),
    actions,
  };
}

export function appendUnknownHistoryNotice(card: ChannelCard): ChannelCard {
  if (card.text.includes('unknown')) return card;
  return {
    ...card,
    text: `${card.text}\n历史未知记录: 存在未确认投递/创建结果 (unknown) 历史，当前状态更新不隐瞒该历史记录，请核对。`,
  };
}
