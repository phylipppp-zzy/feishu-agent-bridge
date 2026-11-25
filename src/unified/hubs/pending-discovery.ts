import type { UnifiedService } from '../adapter.js';
import type { DecisionSyncStore } from './decision-store.js';
import {
  buildDecisionPendingItem,
  buildInteractionPendingItem,
  isActionableDecision,
  isActionableInteraction,
} from './pending-cards.js';
import type { PendingItemView } from './pending-types.js';

interface Discovery {
  service: UnifiedService;
  decisionStore: DecisionSyncStore | undefined;
  boundSources: Array<{ session_id: string; source_destination: string }>;
  resolveSourceLink(sessionId: string | null): Promise<string | null>;
}

/** Discover candidates outside the per-card lock. The caller revalidates before delivery. */
export async function discoverPendingItems(context: Discovery, now: number): Promise<PendingItemView[]> {
  const { service, decisionStore, boundSources, resolveSourceLink } = context;
  const sources = new Map<string, string | null>();
  for (const bound of boundSources) sources.set(bound.session_id, bound.source_destination);

  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await service.listSessions({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const session of page.items) {
      if (!sources.has(session.sessionId)) sources.set(session.sessionId, null);
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (seenCursors.has(cursor) || seenCursors.size >= 100) break;
      seenCursors.add(cursor);
    }
  } while (cursor);

  const items: PendingItemView[] = [];
  for (const [sessionId, sourceDestination] of sources) {
    const result = await service.getSnapshot(sessionId).catch(() => null);
    if (!result) continue;
    const { session, connectionGeneration, interactions } = result.value;
    const actionable = interactions.filter((interaction) =>
      isActionableInteraction(interaction, session, connectionGeneration, now));
    if (!actionable.length) continue;
    const sourceTopicUrl = await resolveSourceLink(sessionId);
    for (const interaction of actionable) {
      items.push(buildInteractionPendingItem({
        interaction,
        session,
        sourceSessionId: sessionId,
        sourceDestination,
        sourceTopicUrl,
      }));
    }
  }

  for (const decision of decisionStore?.listDecisions({ status: 'pending' }) ?? []) {
    if (isActionableDecision(decision, now)) {
      const sourceTopicUrl = await resolveSourceLink(decision.source.sessionId ?? null);
      items.push(buildDecisionPendingItem(decision, sourceTopicUrl));
    }
  }
  return items.sort((a, b) => a.refId.localeCompare(b.refId));
}
