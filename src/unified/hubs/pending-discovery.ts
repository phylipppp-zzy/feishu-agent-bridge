import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePresence, processAlive, type PresenceRecord } from '../../claude/presence.js';
import type { UnifiedService } from '../adapter.js';
import type { DecisionSyncStore } from './decision-store.js';
import {
  buildDecisionPendingItem,
  buildInteractionPendingItem,
  isActionableDecision,
  isActionableInteraction,
} from './pending-cards.js';
import type { PendingCliNotice, PendingCliNoticeItem, PendingHubOptions, PendingItemView } from './pending-types.js';

interface Discovery {
  service: UnifiedService;
  decisionStore: DecisionSyncStore | undefined;
  boundSources: Array<{ session_id: string; source_destination: string }>;
  discoverCliNotices: PendingHubOptions['discoverCliNotices'];
  resolveSourceLink(sessionId: string | null): Promise<string | null>;
}

const PRESENCE_TTL_MS = 10 * 60_000;
const PRESENCE_BATCH_SIZE = 32;

export async function readWaitingClaudePresence(directories: readonly string[], now: number): Promise<PresenceRecord[]> {
  const visited = new Set<string>();
  const latest = new Map<string, PresenceRecord>();
  const oldestMtime = Math.min(now, Date.now()) - PRESENCE_TTL_MS;
  for (const directory of directories) {
    let canonical;
    let files;
    try {
      canonical = await realpath(directory);
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      files = await readdir(canonical, { withFileTypes: true });
    } catch {
      continue;
    }
    const candidates = files.filter(file => file.isFile() && file.name.endsWith('.json'));
    for (let offset = 0; offset < candidates.length; offset += PRESENCE_BATCH_SIZE) {
      const records = await Promise.all(candidates.slice(offset, offset + PRESENCE_BATCH_SIZE).map(async file => {
        const path = join(canonical, file.name);
        let raw: string;
        try {
          if ((await stat(path)).mtimeMs < oldestMtime) return null;
          raw = await readFile(path, 'utf8');
        } catch {
          // Hooks replace records independently. One unreadable record should not hide other sessions.
          return null;
        }
        const record = parsePresence(raw);
        if (!record || file.name !== `${record.sessionId}.json` ||
            !Number.isFinite(record.at) || record.at > now || now - record.at >= PRESENCE_TTL_MS) return null;
        return record;
      }));
      for (const record of records) {
        if (!record) continue;
        const previous = latest.get(record.sessionId);
        if (!previous || previous.at < record.at) latest.set(record.sessionId, record);
      }
    }
  }
  return [...latest.values()].filter(record =>
    record.state === 'waiting' &&
    (record.event === 'Notification' || record.event === 'PermissionRequest') &&
    (record.event === 'PermissionRequest' ||
      record.notificationType === 'permission_prompt' ||
      record.kind === 'permission_prompt' ||
      record.kind === 'permission_request') &&
    record.pid !== null && Number.isSafeInteger(record.pid) && record.pid > 0 &&
    processAlive(record.pid, record.pidStartTime));
}

export interface PendingDiscoveryResult {
  items: PendingItemView[];
  unknownRefIds: Set<string>;
}

/** Discover candidates outside the per-card lock. The caller revalidates before delivery. */
export async function discoverPendingItemsWithMeta(context: Discovery, now: number): Promise<PendingDiscoveryResult> {
  const { service, decisionStore, boundSources, resolveSourceLink } = context;
  const boundDestinations = new Map(boundSources.map(bound => [bound.session_id, bound.source_destination]));
  const sessionIds = new Set<string>();

  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await service.listSessions({ limit: 100, storedOnly: true, ...(cursor ? { cursor } : {}) });
    for (const session of page.items) {
      sessionIds.add(session.sessionId);
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (seenCursors.has(cursor) || seenCursors.size >= 100) break;
      seenCursors.add(cursor);
    }
  } while (cursor);

  const items: PendingItemView[] = [];
  const notices = new Map<string, PendingCliNotice>();
  const unknownRefIds = new Set<string>();
  const addNotice = (notice: PendingCliNotice) => {
    const key = `cli_notice:${notice.provider}:${notice.nativeSessionId}` as const;
    if (!notices.has(key)) notices.set(key, notice);
  };
  const discoveredCli = await context.discoverCliNotices?.();
  const cliNotices = Array.isArray(discoveredCli) ? discoveredCli : (discoveredCli?.notices ?? []);
  if (!Array.isArray(discoveredCli) && discoveredCli?.unknownRefIds) {
    for (const refId of discoveredCli.unknownRefIds) unknownRefIds.add(refId);
  }
  for (const notice of cliNotices) {
    if (!notice.sourceSessionId || sessionIds.has(notice.sourceSessionId)) addNotice(notice);
  }
  for (const sessionId of sessionIds) {
    const sourceDestination = boundDestinations.get(sessionId) ?? null;
    const result = await service.getSnapshot(sessionId).catch(() => null);
    if (!result) continue;
    const { session, connectionGeneration, interactions } = result.value;
    if (session.status === 'waiting_approval' && session.control.input !== 'available') {
      addNotice({
        provider: session.native.provider,
        nativeSessionId: session.native.nativeSessionId,
        title: session.title,
        summary: '会话正在等待终端审批。',
        project: session.project,
        sourceSessionId: sessionId,
      });
    }
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

  for (const notice of notices.values()) {
    const item: PendingCliNoticeItem = {
      ...notice,
      refId: `cli_notice:${notice.provider}:${notice.nativeSessionId}`,
      kind: 'cli_notice',
      category: 'approval',
      readonlyNotice: true,
      expiresAt: null,
      sourceSessionId: notice.sourceSessionId ?? null,
      sourceDestination: null,
      sourceTopicUrl: notice.sourceTopicUrl ?? await resolveSourceLink(notice.sourceSessionId ?? null),
    };
    items.push(item);
  }

  for (const decision of decisionStore?.listDecisions({ status: 'pending' }) ?? []) {
    if (isActionableDecision(decision, now)) {
      const sourceTopicUrl = await resolveSourceLink(decision.source.sessionId ?? null);
      items.push(buildDecisionPendingItem(decision, sourceTopicUrl));
    }
  }
  return { items: items.sort((a, b) => a.refId.localeCompare(b.refId)), unknownRefIds };
}

export async function discoverPendingItems(context: Discovery, now: number): Promise<PendingItemView[]> {
  return (await discoverPendingItemsWithMeta(context, now)).items;
}
