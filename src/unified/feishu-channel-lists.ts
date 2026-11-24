import type { UnifiedService } from './adapter.js';
import type { Artifact, Session } from './contracts.js';
import type { Authorize, ChannelAction, FeishuPort, TrustedEnvelope } from './feishu-channel.js';
import { providerTitlePrefix, type ChannelCard } from './feishu-cards.js';
import { sessionListCard } from './session-list-card.js';
import { ReadAuthorizationRevoked } from './topic-title-sync.js';

export async function showSessionList(
  service: UnifiedService,
  port: FeishuPort,
  authorize: Authorize,
  envelope: TrustedEnvelope,
  {search,provider,cursor}: Extract<ChannelAction,{action:'list'}>,
  guard: () => Promise<void>,
  reply: (card:ChannelCard,suffix:string,extraGuard:()=>Promise<void>) => Promise<string|void>,
): Promise<{nextCursor:string|null}> {
  const page = await service.listSessions({
    limit:5,
    ...(search === undefined ? {} : {search}),
    ...(provider && provider !== 'all' ? {provider} : {}),
    ...(cursor === undefined ? {} : {cursor}),
  });
  const {identity,destination} = envelope;
  const sessions = [];
  for (const session of page.items) {
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
  const card = sessionListCard(visible,{topicUrls,nextCursor:page.nextCursor,providerFilters,...(search ? {search} : {}),...(provider !== undefined ? {provider} : {})});
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
