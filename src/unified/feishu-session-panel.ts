import type { UnifiedService } from './adapter.js';
import { formatResumeCommand, sessionStatusLabel, sessionStatusTemplate } from './card-formatters.js';
import type { Session } from './contracts.js';
import type { ChannelCard } from './feishu-cards.js';

type Panel = Pick<ChannelCard, 'text' | 'actions'>;
type NoticeSettings = {paused:boolean; completed:boolean; waiting:boolean; failed:boolean; revision:number};

export function noticePanel(session: Session, settings: NoticeSettings, legacy?: {enabled:number; event_types:string}): Panel {
  const base = {action:'notice_settings', revision:session.revision, controlGeneration:session.control.generation, settingsRevision:settings.revision};
  const names = {completed:'完成', waiting:'等待', failed:'失败'} as const;
  const fields = ['completed','waiting','failed'] as const;
  const legacyFilter = !!legacy && JSON.parse(legacy.event_types).length > 0;
  const summary = fields.map(field => `${names[field]}：${settings[field] ? '开' : '关'}`).join(' · ');
  const text = [
    `通知：${settings.paused ? '已暂停' : '开启'}（${summary}）`,
    ...(legacy?.enabled === 0 ? ['旧版暂停同时停止回复同步，恢复通知后继续。'] : []),
    ...(legacyFilter ? ['已有旧版筛选仍同时生效。'] : []),
  ].join('\n');
  return {text, actions:[
    {label:settings.paused ? '恢复通知' : '暂停通知', value:{...base,field:'paused',value:!settings.paused}},
    ...fields.map(field => ({label:`${settings[field] ? '关闭' : '开启'}${names[field]}提醒`,value:{...base,field,value:!settings[field]}})),
    ...(legacyFilter ? [{label:'清除旧版筛选',value:{...base,field:'legacy',value:false}}] : []),
  ]};
}

export function buildSessionPanel(session: Session, notice: Panel, work: Awaited<ReturnType<UnifiedService['getWorkState']>> | null): ChannelCard {
  const command = formatResumeCommand(session.native);
  const details = [...(command ? [`电脑端接回：\`${command}\``] : []), notice.text];
  if (!work) return {
    title:'只读会话', template:'grey', text:['状态：只读', ...details].join('\n'),
    actions:[{label:'一键接入并续聊',value:{action:'upgrade'}},...notice.actions],
  };

  const base = {revision:session.revision,controlGeneration:session.control.generation};
  const available = session.control.input === 'available';
  const running = work.runningTurns;
  const queued = work.queuedInputs;
  const actions: ChannelCard['actions'] = [];
  if (available && session.capabilities?.interrupt?.status === 'available') {
    running.forEach((turn,index) => actions.push({label:running.length === 1 ? '中断当前回复' : `中断本轮回复 ${index+1}`,type:'primary',value:{action:'stop',turnId:turn.turnId,...base}}));
  }
  if (available && session.capabilities?.queue?.status === 'available') {
    queued.forEach((item,index) => actions.push({label:`取消排队输入 ${index+1}`,value:{action:'cancel',inputId:item.inputId,...base}}));
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
  const text = [`状态：${status}`, ...details, ...(queued.length ? [`排队中：${queued.length} 条`] : [])].join('\n');
  const template = archived ? 'grey' : available ? sessionStatusTemplate(session.status) : 'orange';
  return {title:'会话控制',text,actions,...(template ? {template} : {})};
}
