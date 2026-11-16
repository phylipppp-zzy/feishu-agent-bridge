import type { Session } from './contracts.js';
import type { ChannelCard } from './feishu-cards.js';

/** Caller supplies at most five authorized sessions and verified topic links. */
export function sessionListCard(items: readonly Session[], options: {topicUrls?: ReadonlyMap<string,string>; nextCursor?: string | null} = {}): ChannelCard {
  if (items.length > 5) throw new Error('session list page exceeds five items');
  const compact = (value: string, max: number): string => {
    const chars = [...value.replace(/\s+/g, ' ').trim()];
    return chars.length > max ? chars.slice(0,max - 1).join('') + '…' : chars.join('');
  };
  const lines:string[] = [];
  const actions:ChannelCard['actions'] = [];
  items.forEach((session, index) => {
    const title = compact(session.title, 42) || '未命名会话';
    const project = compact(session.project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '', 24) || '项目未知';
    const timestamp = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
    const time = Number.isFinite(timestamp) ? ` · 最近活动 ${new Date(timestamp).toISOString().slice(0,16).replace('T',' ')} UTC` : '';
    const available = session.capabilities?.view?.status === 'available';
    lines.push(`${index + 1}. ${title}\n${session.native.provider} · ${project}${time}${available ? '' : ' · 暂不可查看'}`);
    if (available) {
      const url=options.topicUrls?.get(session.sessionId);
      const label=String(index+1);
      actions.push(url ? {label,value:{},url} : {label,value:{action:'bind',sessionId:session.sessionId,mode:'read_only'}});
    }
  });
  if (options.nextCursor) actions.push({label:'下一页',value:{action:'list',cursor:options.nextCursor}});
  return {title:'会话列表',text:lines.length ? lines.join('\n\n') : '没有可显示的会话。',actions};
}
