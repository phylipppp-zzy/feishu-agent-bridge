import { statSync } from 'node:fs';
import { deriveAgySessionTitle, readAgySummaries } from './catalog-summaries.js';
import { DEFAULT_AGY_SUMMARIES_DB_PATH, expandHomePath, type AgySessionStatus } from './catalog-types.js';
import { defaultAgyConversationsDir, scanAgySessionHolders, type AgySessionHolder } from './process-guard.js';

export interface AgySessionStatusItem {
  sessionId: string;
  shortId: string;
  title: string;
  status: AgySessionStatus;
  notFullyIdle: boolean;
  lastModifiedTime: string | null;
  project: string;
  holders: AgySessionHolder[];
}

export interface AgyStatusSnapshot {
  observedAt: string;
  running: AgySessionStatusItem[];
  held: AgySessionStatusItem[];
  completed: AgySessionStatusItem[];
  totalSummaries: number;
  summariesAvailable: boolean;
  error?: string;
}

export function collectAgyStatusSnapshot(options: {
  summariesDbPath?: string;
  brainDir?: string;
  conversationsDir?: string;
  procRoot?: string;
  scanHolders?: () => Map<string, AgySessionHolder[]>;
  maxCompleted?: number;
} = {}): AgyStatusSnapshot {
  const snapshot: AgyStatusSnapshot = {
    observedAt: new Date().toISOString(),
    running: [],
    held: [],
    completed: [],
    totalSummaries: 0,
    summariesAvailable: false,
  };
  const dbPath = expandHomePath(options.summariesDbPath ?? DEFAULT_AGY_SUMMARIES_DB_PATH);
  let summaries: ReturnType<typeof readAgySummaries> = [];
  try {
    if (statSync(dbPath, { throwIfNoEntry: false })) {
      summaries = readAgySummaries({
        dbPath,
        ...(options.brainDir !== undefined ? { brainDir: options.brainDir } : {}),
        includeOutsideRoots: true,
      });
      snapshot.summariesAvailable = true;
    }
  } catch (error) {
    snapshot.error = error instanceof Error ? error.message : String(error);
  }
  const holdersById = options.scanHolders
    ? options.scanHolders()
    : scanAgySessionHolders(options.conversationsDir ?? defaultAgyConversationsDir(options.brainDir), options.procRoot);
  snapshot.totalSummaries = summaries.length;
  const summaryIds = new Set<string>();

  // The catalog already sorts top-level summaries by last modification time.
  for (const summary of summaries) {
    const sessionId = summary.conversationId;
    summaryIds.add(sessionId);
    const item: AgySessionStatusItem = {
      sessionId,
      shortId: sessionId.slice(0, 8),
      title: summary.title,
      status: summary.status,
      notFullyIdle: summary.notFullyIdle,
      lastModifiedTime: summary.lastModifiedAt,
      project: summary.project,
      holders: holdersById.get(sessionId) ?? [],
    };
    if (item.notFullyIdle || item.status === 'running' || item.status === 'busy' || item.status === 'canceling') {
      snapshot.running.push(item);
    } else if (item.status === 'idle') {
      snapshot.completed.push(item);
    }
    if (item.holders.length) snapshot.held.push(item);
  }
  for (const [sessionId, holders] of holdersById) {
    if (summaryIds.has(sessionId) || !holders.length) continue;
    snapshot.held.push({
      sessionId,
      shortId: sessionId.slice(0, 8),
      title: deriveAgySessionTitle(sessionId, '', ''),
      status: 'unspecified',
      notFullyIdle: false,
      lastModifiedTime: null,
      project: '',
      holders,
    });
  }
  const hasExternal = (item: AgySessionStatusItem) => item.holders.some(holder => holder.kind === 'external_cli');
  snapshot.held.sort((a, b) =>
    Number(hasExternal(b)) - Number(hasExternal(a)) ||
    (b.lastModifiedTime ?? '').localeCompare(a.lastModifiedTime ?? '') ||
    a.sessionId.localeCompare(b.sessionId));
  if (options.maxCompleted !== undefined) {
    snapshot.completed = snapshot.completed.slice(0, options.maxCompleted);
  }
  return snapshot;
}
