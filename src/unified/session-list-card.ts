import type { Provider, Session } from './contracts.js';
import { providerDisplayLabel, type ChannelCard } from './feishu-cards.js';

/** Caller supplies at most five authorized sessions and verified topic links. */
export function sessionListCard(items: readonly Session[], options: {topicUrls?: ReadonlyMap<string,string>; nextCursor?: string | null; search?: string; provider?: Provider | 'all'; providerFilters?: boolean} = {}): ChannelCard {
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
    const beijing = Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600 * 1000) : null;
    const time = beijing && Number.isFinite(beijing.getTime()) ? ` · 最近活动 ${beijing.toISOString().slice(0,16).replace('T',' ')} 北京` : '';
    const available = session.capabilities?.view?.status === 'available';
    lines.push(`${index + 1}. ${title}\n${providerDisplayLabel(session.native.provider)} · ${project}${time}${available ? '' : ' · 暂不可查看'}`);
    if (available) {
      const url=options.topicUrls?.get(session.sessionId);
      const label=String(index+1);
      actions.push(url ? {label,value:{},url} : {label,value:{action:'bind',sessionId:session.sessionId,mode:'read_only'}});
    }
  });
  if (options.nextCursor) actions.push({label:'下一页',value:{action:'list',cursor:options.nextCursor,...(options.search ? {search:options.search} : {}),...(options.provider !== undefined ? {provider:options.provider} : {})}});
  if (options.providerFilters) {
    actions.push(
      { label: '全部', value: { action: 'list', provider: 'all' } },
      { label: 'Codex', value: { action: 'list', provider: 'codex', search: 'codex' } },
      { label: 'Claude', value: { action: 'list', provider: 'claude', search: 'claude' } },
      { label: 'Antigravity', value: { action: 'list', provider: 'agy', search: 'agy' } },
    );
  }
  return {title:'会话列表',text:lines.length ? lines.join('\n\n') : '没有可显示的会话。',actions};
}
