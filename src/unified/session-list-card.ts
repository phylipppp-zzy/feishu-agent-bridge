import type { Provider, Session } from './contracts.js';
import { compactCardField, formatInlineCode, formatReadableProjectPath } from './card-formatters.js';
import { providerDisplayLabel, type ChannelCard } from './feishu-cards.js';
import { escapeCardMarkdown } from './feishu-card-wire.js';

/** Caller supplies at most five authorized sessions and verified topic links. */
export function sessionListCard(items: readonly Session[], options: {topicUrls?: ReadonlyMap<string,string>; nextCursor?: string | null; search?: string; provider?: Provider | 'all'; providerFilters?: boolean} = {}): ChannelCard {
  if (items.length > 5) throw new Error('session list page exceeds five items');
  const lines: string[] = [];
  const mainActions: ChannelCard['actions'] = [];
  items.forEach((session, index) => {
    const title = compactCardField(session.title, 42) || '未命名会话';
    const readablePath = formatReadableProjectPath(session.project);
    const timestamp = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
    const beijing = Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600 * 1000) : null;
    const time = beijing && Number.isFinite(beijing.getTime()) ? ` · 最近活动 ${beijing.toISOString().slice(0,16).replace('T',' ')} 北京` : '';
    const available = session.capabilities?.view?.status === 'available';
    lines.push(`${index + 1}. ${escapeCardMarkdown(title)}\n${providerDisplayLabel(session.native.provider)} · \`${formatInlineCode(readablePath)}\`${time}${available ? '' : ' · 暂不可查看'}`);
    if (available) {
      const url = options.topicUrls?.get(session.sessionId);
      const label = `${index + 1} · ${url ? '打开' : '接入'}`;
      mainActions.push(url ? {label,value:{},url} : {label,value:{action:'bind',sessionId:session.sessionId,mode:'read_only'}});
    }
  });
  const searchValue = (provider?: Provider | 'all') => options.search
    ? { search: options.search, ...(provider !== 'all' && options.search === provider ? { explicitSearch: true } : {}) }
    : {};
  if (options.nextCursor) mainActions.push({label:'下一页',value:{action:'list',cursor:options.nextCursor,...searchValue(options.provider),...(options.provider !== undefined ? {provider:options.provider} : {})}});
  const filterActions: ChannelCard['actions'] = [];
  if (options.providerFilters) {
    for (const provider of ['all', 'codex', 'claude', 'agy'] as const) {
      const label = provider === 'all' ? '全部' : providerDisplayLabel(provider);
      const selected = provider === (options.provider ?? 'all');
      filterActions.push({
        ...(selected ? { label: `✓ ${label}`, type: 'primary' } : { label }),
        value: { action: 'list', provider, ...searchValue(provider) },
      });
    }
  }
  const actions: ChannelCard['actions'] = [...mainActions, ...filterActions];
  const card: ChannelCard = {
    ...(options.providerFilters ? { schema: '2.0' as const } : {}),
    title: '会话列表',
    text: lines.length ? lines.join('\n\n') : '没有可显示的会话。',
    actions,
  };
  if (options.providerFilters) {
    card.sections = [
      {
        get text() { return card.text; },
        ...(mainActions.length ? { actions: mainActions } : {}),
      },
      {
        dividerBefore: true,
        text: '🤖 **筛选 Agent**',
        actions: filterActions,
      },
    ];
  }
  return card;
}
