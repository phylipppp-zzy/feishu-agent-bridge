import type { UnifiedService } from './adapter.js';
import type { ChannelCard } from './feishu-cards.js';

export type HealthEntry = Awaited<ReturnType<UnifiedService['health']>>[number];

const HEALTH_LABELS: Record<string, string> = {
  core: '核心',
  runtime: '本机调度概况',
  feishu_delivery: '飞书投递',
  feishu_callback: '飞书回调与入站',
  feishu_resources: '飞书资源',
  codex_connection: 'Codex连接',
  codex_run: 'Codex运行',
  claude_connection: 'Claude SDK事件流',
  claude_run: 'Claude运行',
  claude_quota: 'Claude额度',
  agy_connection: 'Antigravity连接',
  agy_run: 'Antigravity运行',
  agy_quota: 'Antigravity额度',
  interaction_return: '问题回传',
};

const HEALTH_STATES: Record<string, string> = {
  healthy: '正常',
  degraded: '异常或待核对',
  unreachable: '不可连接',
  unverified: '尚未触发',
};

const HEALTH_REASON_MAP: Record<string, string> = {
  'dispatch or synchronization failed; inspect persisted state before retry': '存在同步或调度异常，请检查本机状态',
  'connection closed': '连接曾断开',
  'not connected': '尚未连接',
  'transport error': '连接传输异常',
  'response timed out': '响应超时',
  'send failed': '消息发送失败',
  'app-server rejected request': '服务端拒绝请求',
  'invalid app-server message': '服务端消息格式无效',
  'reconnect and explicitly attach quarantined sessions': '存在隔离会话，请重新连接并手动恢复',
  'one or more sessions could not be restored; inspect before retry': '部分会话恢复失败，请检查后再试',
  'binding recovery failed; inspect before retry': '绑定恢复失败，请检查后再试',
  'normalized observation could not be persisted; replay required': '观测记录落盘失败，需要重放',
  'read-only refresh failed': '只读会话刷新失败',
  'restart recovery failed; inspect session before retry': '重启恢复失败，请检查会话后再试',
  'restart recovery failed; subscription released; reconciliation required': '重启恢复失败，订阅已释放，需人工核对',
  'restart recovery failed; subscription release outcome unknown': '重启恢复失败，订阅释放结果未知',
};

function formatBeijingTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const bj = new Date(ms + 8 * 3600 * 1000);
  if (!Number.isFinite(bj.getTime())) return null;
  return bj.toISOString().slice(5, 16).replace('T', ' ');
}

function translateHealthReason(reason: string | null | undefined): string | null {
  return reason ? (HEALTH_REASON_MAP[reason] ?? reason) : null;
}

function healthLabelOf(component: string): string {
  return HEALTH_LABELS[component] ?? component;
}

export function buildHealthCard(health: readonly HealthEntry[]): ChannelCard {
  const attention: string[] = [];
  const normal: string[] = [];
  const unverified: string[] = [];
  const attentionRows: string[][] = [];
  const normalRows: string[][] = [];

  for (const h of health) {
    const label = healthLabelOf(h.component);
    if (h.status === 'healthy') {
      const success = formatBeijingTime(h.lastSuccessAt);
      const observed = formatBeijingTime(h.lastObservedAt);
      const timeText = success ? `（最近成功 ${success}）` : observed ? `（最近观测 ${observed}）` : '';
      normal.push(`- ${label}：正常${timeText}`);
      const detailText = success ? `最近成功 ${success}` : observed ? `最近观测 ${observed}` : '—';
      normalRows.push([label, `✅ ${HEALTH_STATES.healthy}`, detailText]);
    } else if (h.status === 'unverified') {
      unverified.push(label);
    } else {
      const state = HEALTH_STATES[h.status] ?? h.status;
      const icon = h.status === 'unreachable' ? '❌' : '⚠️';
      const reason = translateHealthReason(h.reason ?? h.lastFailureReason);
      const details: string[] = [];
      const success = formatBeijingTime(h.lastSuccessAt);
      const failure = formatBeijingTime(h.lastFailureAt);
      if (success) details.push(`最近成功 ${success}`);
      if (failure) details.push(`最近失败 ${failure}`);
      if (typeof h.unknown === 'number' && h.unknown > 0) details.push(`待核对 ${h.unknown}`);
      if (typeof h.backlog === 'number' && h.backlog > 0) details.push(`积压 ${h.backlog}`);
      attention.push(`- ${label}：${state}${reason ? `（${reason}）` : ''}${details.length ? `；${details.join('；')}` : ''}`);
      const rowDetails = [...(reason ? [reason] : []), ...details];
      attentionRows.push([label, `${icon} ${state}`, rowDetails.length ? rowDetails.join('；') : '—']);
    }
  }

  const sections: string[] = [];
  if (attention.length) sections.push(`【需关注】\n${attention.join('\n')}`);
  if (normal.length) sections.push(`【正常】\n${normal.join('\n')}`);
  if (unverified.length) sections.push(`【尚未触发】\n${unverified.join('、')}`);

  const rows = [...attentionRows, ...normalRows];
  const table = rows.length || unverified.length
    ? {
        columns: [
          { header: '组件', weight: 2 },
          { header: '状态', weight: 1 },
          { header: '最近动态 / 说明', weight: 3 },
        ],
        rows,
        ...(unverified.length ? { footer: `⚪ 尚未触发：${unverified.join('、')}` } : {}),
      }
    : undefined;

  return {
    title: '健康状态',
    text: sections.length ? sections.join('\n\n') : '暂无健康状态记录。',
    ...(table ? { table } : {}),
    actions: [],
  };
}
