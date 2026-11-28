import { existsSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { summarizeTool } from '../tool-progress.js';
import {
  agyFileFingerprint,
  deriveAgySessionTitle,
  isAncestorChainAuthorizedForProject,
  readAgySummaryHierarchy,
  readSafeTranscriptTail,
  resolveAllowedProject,
  resolveSummaryAncestorChain,
} from './catalog-summaries.js';
import {
  DEFAULT_MAX_TITLE_LENGTH,
  isPlainRecord,
  isTruthyFlag,
  type AgySummariesDefaultPair,
} from './catalog-types.js';
import {
  defaultAgyConversationsDir,
  scanAgySessionHolders,
  type AgySessionHolder,
} from './process-guard.js';

/** Confirmed from host `agy` protobuf enum `CortexStepStatus`. */
export const CORTEX_STEP_STATUS_WAITING = 9;
const TERMINAL_CORTEX_STEP_STATUSES = new Set([3, 5, 6, 7, 12]); // DONE, CLEARED, CANCELED, ERROR, INTERRUPTED
const TAIL_TRANSCRIPT_BYTES = 16 * 1024;
const TAIL_STEP_WINDOW = 8;

const TRUSTED_AGY_BIN_RE = /^(?:agy(?:\.\d+\.old)?|antigravity(?:\.\d+\.old)?|language_server(?:_[a-z0-9_]+)?)$/i;

/**
 * Verify that a non-ACP holder process is an authentic Antigravity binary rather than an unrelated tool
 * (e.g. node/sqlite3, even with a spoofed `argv[0]`). Strictly requires verified kernel `/proc/<pid>/exe`.
 */
export function isTrustedAgyCliHolder(holder: AgySessionHolder): boolean {
  if (holder.kind !== 'external_cli') return false;
  if (typeof holder.exe !== 'string' || !holder.exe.trim()) return false;
  const cleanExe = holder.exe.trim().replace(/\s+\(deleted\)$/, '');
  return TRUSTED_AGY_BIN_RE.test(basename(cleanExe));
}

export interface AgyCliWaitingNotice {
  waitingConversationId: string;
  rootConversationId: string;
  rootTitle: string;
  rootProject: string;
  subagentName: string | null;
  waitingStepIdx: number;
  toolSummary: string | null;
  holder: AgySessionHolder;
  appDataDir: string;
}

export interface AgyCliWaitingScanResult {
  notices: AgyCliWaitingNotice[];
  unknownConversationIds: string[];
}

export interface AgyCliWaitingDetectorOptions {
  summariesDbPath?: string;
  summariesDefaultPair?: AgySummariesDefaultPair;
  brainDir?: string;
  brainDirs?: readonly string[];
  conversationsDir?: string;
  allowedProjectRoots?: readonly string[];
  scanHolders?: (conversationsDir: string) => Map<string, AgySessionHolder[]>;
  isTrustedHolder?: (holder: AgySessionHolder) => boolean;
}

interface StepRow {
  idx: number;
  step_type: number;
  status: number;
}

interface CacheEntry {
  fingerprint: string;
  waitingStepIdx: number | null;
}

function extractTrailingWaitingStep(rows: readonly StepRow[]): number | null {
  if (!rows.length) return null;
  let waitingIdx: number | null = null;
  for (const row of rows) {
    if (row.status === CORTEX_STEP_STATUS_WAITING) {
      waitingIdx = row.idx;
    } else if (waitingIdx !== null && row.idx > waitingIdx && TERMINAL_CORTEX_STEP_STATUSES.has(row.status)) {
      // A newer step has already completed/ended after this waiting step: treat as stale history.
      waitingIdx = null;
    }
  }
  return waitingIdx;
}

function readWaitingStepFromDb(dbPath: string): number | null {
  const st = lstatSync(dbPath);
  if (st.isSymbolicLink() || !st.isFile()) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 50 });
  try {
    db.exec('PRAGMA query_only = ON');
    const rows = db.prepare(
      `SELECT idx, step_type, status FROM steps
       WHERE idx >= COALESCE((SELECT MAX(idx) - ? FROM steps), 0)
       ORDER BY idx ASC`,
    ).all(TAIL_STEP_WINDOW) as unknown as StepRow[];
    return extractTrailingWaitingStep(rows);
  } finally {
    db.close();
  }
}

function readLatestToolSummaryFromTranscript(
  conversationId: string,
  project: string,
  options: { brainDir?: string; brainDirs?: readonly string[]; appDataDir?: string },
): string | null {
  const text = readSafeTranscriptTail(conversationId, TAIL_TRANSCRIPT_BYTES, options);
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isPlainRecord(parsed) || parsed.type !== 'PLANNER_RESPONSE') continue;
    if (!Array.isArray(parsed.tool_calls) || !parsed.tool_calls.length) return null;
    const summaries: string[] = [];
    for (const rawCall of parsed.tool_calls.slice(0, 3)) {
      if (!isPlainRecord(rawCall) || typeof rawCall.name !== 'string') continue;
      const args = isPlainRecord(rawCall.args) ? rawCall.args : {};
      const normalizedArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string' && v.startsWith('"') && v.endsWith('"')) {
          try {
            normalizedArgs[k] = JSON.parse(v);
          } catch {
            normalizedArgs[k] = v;
          }
        } else {
          normalizedArgs[k] = v;
        }
      }
      summaries.push(summarizeTool(rawCall.name, normalizedArgs, project).summary);
    }
    return summaries.length ? summaries.join('、') : null;
  }
  return null;
}

/**
 * Strictly read-only detector for external AGY CLI sessions (including nested subagents)
 * paused on `CORTEX_STEP_STATUS_WAITING` (9).
 *
 * - Only inspects `.db` files actively held by a trusted live `external_cli` AGY process.
 * - Caches `(dev, ino, size, mtimeMs)` for `.db` + `-wal` so unchanged DBs perform zero SQLite opens.
 * - Resolves subagents to their root top-level conversation via cycle-safe `readAgySummaryHierarchy`,
 *   checking every intermediate ancestor's status and workspace consistency.
 */
export class AgyCliWaitingDetector {
  private readonly cache = new Map<string, CacheEntry>();

  scan(options: AgyCliWaitingDetectorOptions = {}): AgyCliWaitingScanResult {
    const conversationsDir = options.conversationsDir ?? defaultAgyConversationsDir(options.brainDir);
    const holdersById = options.scanHolders
      ? options.scanHolders(conversationsDir)
      : scanAgySessionHolders(conversationsDir);
    const checkTrusted = options.isTrustedHolder ?? isTrustedAgyCliHolder;

    const externalCandidates: Array<{ id: string; holder: AgySessionHolder }> = [];
    for (const [id, holders] of holdersById) {
      if (!holders.length) continue;
      // Never alert when the bridge ACP worker is holding or sharing this conversation.
      if (holders.some(h => h.kind === 'bridge_acp')) continue;
      const cliHolder = holders.find(h => h.kind === 'external_cli' && checkTrusted(h));
      if (cliHolder) externalCandidates.push({ id, holder: cliHolder });
    }

    // Evict stale cache entries for conversations no longer held open.
    const activeIds = new Set(externalCandidates.map(c => c.id));
    for (const key of this.cache.keys()) {
      if (!activeIds.has(key)) this.cache.delete(key);
    }

    if (!externalCandidates.length) {
      return { notices: [], unknownConversationIds: [] };
    }

    let hierarchy: ReturnType<typeof readAgySummaryHierarchy>;
    try {
      hierarchy = readAgySummaryHierarchy(options.summariesDbPath, options.summariesDefaultPair);
    } catch {
      return { notices: [], unknownConversationIds: externalCandidates.map(c => c.id) };
    }

    const notices: AgyCliWaitingNotice[] = [];
    const unknownConversationIds: string[] = [];

    for (const { id: waitingId, holder } of externalCandidates) {
      const dbPath = join(conversationsDir, `${waitingId}.db`);
      if (!existsSync(dbPath)) continue;

      const dbFingerprint = agyFileFingerprint(dbPath);
      const walFingerprint = agyFileFingerprint(`${dbPath}-wal`);
      const fingerprint = dbFingerprint && walFingerprint ? `${dbFingerprint}|${walFingerprint}` : null;
      const cached = this.cache.get(waitingId);
      let waitingStepIdx: number | null;
      if (cached && cached.fingerprint === fingerprint) {
        waitingStepIdx = cached.waitingStepIdx;
      } else {
        try {
          waitingStepIdx = readWaitingStepFromDb(dbPath);
          if (fingerprint !== null) this.cache.set(waitingId, { fingerprint, waitingStepIdx });
        } catch {
          // Do not cache transient read errors (e.g. SQLITE_BUSY) as "not waiting".
          unknownConversationIds.push(waitingId);
          continue;
        }
      }

      if (waitingStepIdx === null) continue;

      const row = hierarchy.byId.get(waitingId);
      if (!row) {
        if (hierarchy.partialFailure) unknownConversationIds.push(waitingId);
        continue;
      }
      if (isTruthyFlag(row.killed)) continue;

      const chainResult = resolveSummaryAncestorChain(row, hierarchy);
      if (chainResult.status === 'missing') {
        if (hierarchy.partialFailure) unknownConversationIds.push(waitingId);
        continue;
      }
      if (chainResult.status !== 'ok') continue;

      const { chain, rootRow } = chainResult;
      const rootId = rootRow.conversation_id;

      const rootProjectInfo = resolveAllowedProject(rootRow.workspace_uris, options.allowedProjectRoots);
      if (options.allowedProjectRoots !== undefined && !rootProjectInfo.allowed) continue;
      if (!rootProjectInfo.project) continue;

      if (!isAncestorChainAuthorizedForProject(chain, rootId, rootProjectInfo.project, options.allowedProjectRoots)) {
        continue;
      }

      const rootTitle = deriveAgySessionTitle(
        rootId,
        typeof rootRow.title === 'string' ? rootRow.title : '',
        typeof rootRow.preview === 'string' ? rootRow.preview : '',
        DEFAULT_MAX_TITLE_LENGTH,
      );
      const subagentName =
        waitingId !== rootId
          ? (typeof row.agent_name === 'string' && row.agent_name.trim()
              ? row.agent_name.trim()
              : (typeof row.title === 'string' && row.title.trim() ? row.title.trim() : waitingId.slice(0, 8)))
          : null;
      const appDataDir =
        (typeof row.app_data_dir === 'string' && row.app_data_dir.trim()) ||
        (typeof rootRow.app_data_dir === 'string' && rootRow.app_data_dir.trim()) ||
        '';
      const toolSummary = readLatestToolSummaryFromTranscript(waitingId, rootProjectInfo.project, {
        ...(options.brainDir !== undefined ? { brainDir: options.brainDir } : {}),
        ...(options.brainDirs !== undefined ? { brainDirs: options.brainDirs } : {}),
        ...(appDataDir ? { appDataDir } : {}),
      });

      notices.push({
        waitingConversationId: waitingId,
        rootConversationId: rootId,
        rootTitle,
        rootProject: rootProjectInfo.project,
        subagentName,
        waitingStepIdx,
        toolSummary,
        holder,
        appDataDir,
      });
    }

    notices.sort((a, b) => a.waitingConversationId.localeCompare(b.waitingConversationId));
    return { notices, unknownConversationIds };
  }
}
