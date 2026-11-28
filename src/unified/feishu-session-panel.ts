import type { UnifiedService } from './adapter.js';
import type { AgyQuotaSnapshot } from './agy-quota.js';
import { formatInlineCode, formatResumeCommand, sessionStatusLabel, sessionStatusTemplate, shortenHomePath } from './card-formatters.js';
import type { Session } from './contracts.js';
import { formatContextUsageBadge, type ContextUsageInfo } from './context-usage.js';
import { providerDisplayLabel, type ChannelCard } from './feishu-cards.js';
import { formatQuotaSummary } from './health-card.js';
import { formatCompactModelBadge } from './turn-progress-card.js';

type Panel = Pick<ChannelCard, 'text' | 'actions'>;
type NoticeSettings = {paused:boolean; completed:boolean; waiting:boolean; failed:boolean; revision:number};

export function noticePanel(session: Session, settings: NoticeSettings, legacy?: {enabled:number; event_types:string}): Panel {
  const base = {action:'notice_settings', revision:session.revision, controlGeneration:session.control.generation, settingsRevision:settings.revision};
  const legacyFilter = !!legacy && JSON.parse(legacy.event_types).length > 0;
  const text = [
    `通知：${settings.paused ? '已暂停' : '开启'}`,
    ...(legacy?.enabled === 0 ? ['旧版暂停同时停止回复同步，恢复通知后继续。'] : []),
    ...(legacyFilter ? ['已有旧版筛选仍同时生效。'] : []),
  ].join('\n');
  return {text, actions:[
    {label:settings.paused ? '恢复通知' : '暂停通知', value:{...base,field:'paused',value:!settings.paused}},
    ...(legacyFilter ? [{label:'清除旧版筛选',value:{...base,field:'legacy',value:false}}] : []),
  ]};
}

export function buildSessionPanel(
  session: Session,
  notice: Panel,
  work: Awaited<ReturnType<UnifiedService['getWorkState']>> | null,
  options?: { quota?: AgyQuotaSnapshot | null; contextUsage?: ContextUsageInfo | null; modelBadge?: string },
): ChannelCard {
  const command = formatResumeCommand(session.native);
  const providerLabel = providerDisplayLabel(session.native.provider);
  const shortPath = shortenHomePath(session.project);
  const modelLabel = options?.modelBadge?.trim() || formatCompactModelBadge(options?.contextUsage?.model);
  const ctxBadge = formatContextUsageBadge(options?.contextUsage);
  const contextLines = [
    `🤖 Agent：${providerLabel}`,
    `📂 路径：\`${formatInlineCode(shortPath)}\``,
    ...(modelLabel ? [`🧠 模型：\`${formatInlineCode(modelLabel)}\``] : []),
    ...(ctxBadge ? [`📏 上下文：${ctxBadge.text}`] : []),
  ];
  const quotaLines = session.native.provider === 'agy' && options && 'quota' in options
    ? formatQuotaSummary(options.quota)
    : [];
  const details = [...(command ? [`电脑端接回：\`${command}\``] : []), ...quotaLines, notice.text];
  if (!work) return {
    title:'只读会话',
    template:'grey',
    text:[...contextLines, '状态：只读', ...details].join('\n'),
    actions:[{label:'一键接入并续聊',value:{action:'upgrade'}},...notice.actions],
  };

  const base = {revision:session.revision,controlGeneration:session.control.generation};
  const available = session.control.input === 'available';
  const running = work.runningTurns;
  const queued = work.queuedInputs;
  const actions: ChannelCard['actions'] = [];
  if (available && session.capabilities?.interrupt?.status === 'available') {
    running.forEach((turn,index) => actions.push({
      label:running.length === 1 ? '中断当前回复' : `中断本轮回复 ${index+1}`,
      type:'primary',
      value:{action:'stop',turnId:turn.turnId,...base,...(running.length === 1 ? {fallbackCurrent:true} : {})},
    }));
  }
  if (available && session.capabilities?.queue?.status === 'available') {
    queued.forEach((item,index) => actions.push({label:queued.length === 1 ? '撤回排队' : `撤回排队 ${index+1}`,value:{action:'cancel',inputId:item.inputId,...base}}));
  }
  if (available) {
    actions.push({
      label: running.length ? '排队压缩上下文 (/compact)' : '压缩上下文 (/compact)',
      value: { action: 'compact', ...base },
    });
  }
  actions.push(...notice.actions);
  if (!available) actions.push({label:'重新接入',value:{action:'upgrade'}});
  const archived = session.archived === true || String(session.status) === 'archived';
  if (work.canArchive) actions.push({
    label:archived ? '恢复归档' : '归档',value:{action:'archive',archived:!archived,...base},
  });
  if (session.capabilities?.handoff?.status === 'available') {
    const { owner, serviceId } = session.control;
    const ownsControl = !!owner && (owner === 'feishu' || owner === serviceId);
    actions.push({label:ownsControl ? '释放控制' : '切换到飞书',
      value:{action:'control',owner:ownsControl ? owner : serviceId || 'feishu',strategy:'wait',...(ownsControl ? {release:true} : {}),...base}});
  }
  const status = archived ? '已归档' : available ? sessionStatusLabel(session.status) : '连接不可用';
  const text = [...contextLines, `状态：${status}`, ...details, ...(queued.length ? [`排队中：${queued.length} 条`] : [])].join('\n');
  const template = archived ? 'grey' : available ? sessionStatusTemplate(session.status) : 'orange';
  return {title:'会话控制',text,actions,...(template ? {template} : {})};
}
