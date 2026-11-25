import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { UnifiedService } from './adapter.js';
import type { Artifact, Session } from './contracts.js';
import type { Authorize, ChannelAction, FeishuPort, TrustedEnvelope } from './feishu-channel.js';
import { providerTitlePrefix, type ChannelCard } from './feishu-cards.js';
import { buildModelsCard } from './help-cards.js';
import { sessionListCard } from './session-list-card.js';
import { ReadAuthorizationRevoked } from './topic-title-sync.js';

export async function sessionModelPage(service: UnifiedService, session: Session, cursor?: string, readOnly?: boolean) {
  const id = session.sessionId;
  const [page, confirmed] = await Promise.all([
    service.listModels(id, {limit:100, ...(cursor ? {cursor} : {})}),
    service.getConfirmedSettings?.(id),
  ]);
  const card = buildModelsCard({provider:session.native.provider, items:page.items, nextCursor:page.nextCursor,
    confirmed:confirmed ?? null, revision:session.revision, controlGeneration:session.control.generation,
    ...(readOnly ? {readOnly} : {})});
  return {card, page};
}

function matchesSessionSearch(session: Session, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  const haystacks = [
    session.title,
    session.project,
    session.sessionId,
    session.native.provider,
    session.native.nativeSessionId,
  ];
  return haystacks.some(value => typeof value === 'string' && value.toLowerCase().includes(needle));
}

export async function showSessionList(
  service: UnifiedService,
  port: FeishuPort,
  authorize: Authorize,
  envelope: TrustedEnvelope,
  {search,provider,cursor}: Extract<ChannelAction,{action:'list'}>,
  guard: () => Promise<void>,
  reply: (card:ChannelCard,suffix:string,extraGuard:()=>Promise<void>) => Promise<string|void>,
): Promise<{nextCursor:string|null}> {
  const trimmedSearch = search?.trim();
  const page = await service.listSessions({
    limit:5,
    ...(trimmedSearch ? {search:trimmedSearch} : {}),
    ...(provider && provider !== 'all' ? {provider} : {}),
    ...(cursor === undefined ? {} : {cursor}),
  });
  const {identity,destination} = envelope;
  const sessions = [];
  for (const session of page.items) {
    if (trimmedSearch && !matchesSessionSearch(session, trimmedSearch)) continue;
    if (await authorize(identity,destination,session.sessionId)) sessions.push(session);
  }
  const links = await Promise.all(sessions.map(async session => {
    await guard();
    const url = await port.topicLinkForSession?.(destination,session.sessionId);
    await guard();
    return [session.sessionId,url] as const;
  }));
  const topicUrls = new Map<string,string>();
  for (const [id,url] of links) if (url) topicUrls.set(id,url);
  const visible: Session[] = [];
  for (const session of sessions) {
    await guard();
    if (await authorize(identity,destination,session.sessionId)) visible.push(session);
    await guard();
  }
  const listGuard = async () => {
    for (const session of visible) {
      await guard();
      if (!await authorize(identity,destination,session.sessionId)) throw new ReadAuthorizationRevoked('unauthorized');
    }
    await guard();
  };
  const hasAgy = service.hasProvider?.('agy') as unknown;
  if (hasAgy instanceof Promise) void hasAgy.catch(() => {});
  const providerFilters = provider !== undefined || page.items.some(s => s.native.provider === 'agy') || hasAgy === true;
  const card = sessionListCard(visible,{topicUrls,nextCursor:page.nextCursor,providerFilters,...(trimmedSearch ? {search:trimmedSearch} : {}),...(provider !== undefined ? {provider} : {})});
  if (trimmedSearch) {
    card.text = visible.length
      ? `筛选关键词：${trimmedSearch}\n\n${card.text}`
      : `没有匹配「${trimmedSearch}」的会话。`;
  }
  if (page.unavailableProviders?.length) card.text += `\n暂不可用：${page.unavailableProviders.map(providerTitlePrefix).join('、')}，列表可能不完整。`;
  await reply(card,'reply',listGuard);
  return {nextCursor:page.nextCursor};
}

export async function listAllArtifacts(service: UnifiedService, sessionId: string): Promise<Artifact[]> {
  const items: Artifact[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await service.listArtifacts(sessionId, { limit: 1000, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 1000) throw new Error('invalid artifact pagination');
      seen.add(cursor);
    }
  } while (cursor);
  return items;
}

export async function historyTextCard(db: DatabaseSync, port: FeishuPort, key: [string, string, string],
  text: string, actions: ChannelCard['actions'], guard: () => Promise<void>, onSend: () => void): Promise<ChannelCard> {
  const [destination, sessionId, scope] = key;
  const title = '会话历史';
  await guard();
  if ([...text].length <= 3000) return { title, text, actions };
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  const id = `long:${createHash('sha256').update(JSON.stringify([destination, sessionId, scope, digest])).digest('hex')}`;
  await guard();
  if (db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id).changes) {
    try {
      onSend();
      await port.sendFile(destination, `完整内容-${digest.slice(0, 12)}.txt`, Buffer.from(text, 'utf8'), id, guard);
      db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id);
    } catch { /* The upload may have succeeded. */ }
  }
  await guard();
  const row = db.prepare('SELECT state FROM channel_deliveries WHERE delivery_id=?').get(id) as { state: string };
  const sent = row.state === 'sent';
  const url = sent ? await port.fileMessageLink?.(destination, sessionId, id) : null;
  await guard();
  return { title, text: `${[...text].slice(0, 1000).join('')}\n\n${sent ? '全文已作为文件发送。' : '全文文件投递结果未知，请核对后再操作。'}`,
    actions: [...actions, ...(url ? [{ label: '打开全文', url, value: { action: 'open_file' } }] : [])] };
}
