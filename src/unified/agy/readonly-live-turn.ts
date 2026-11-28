import { payloadDigest } from '../contracts.js';
import { extractAgyContextUsageFromRows, type ContextUsageInfo } from '../context-usage.js';
import { formatThinkingSummary, summarizeTool, type ToolProgress } from '../tool-progress.js';
import type { SessionSubagentActivity } from '../turn-progress-card.js';
import {
  isAncestorChainAuthorizedForProject,
  parseWorkspaceUris,
  readAgySummaryHierarchy,
  readTranscriptTailSource,
  safeTranscriptTailSources,
  resolveSummaryAncestorChain,
} from './catalog-summaries.js';
import {
  ACTIVE_CASCADE_STATUSES,
  canonicalizePath,
  extractAgyUserInput,
  isInside,
  isPlainRecord,
  isTruthyFlag,
  type AgySummariesDefaultPair,
} from './catalog-types.js';

const READONLY_TAIL_BYTES = 128 * 1024;
const READONLY_VIEW_CACHE_MAX_ENTRIES = 256;

export interface ReadonlyLiveTurnView {
  state: 'running' | 'idle' | 'unavailable';
  anchorId: string;
  running: boolean;
  previewText: string;
  tools: ToolProgress[];
  activeSubagents: SessionSubagentActivity[];
  contextUsage?: ContextUsageInfo | null;
  signature: string;
}

export interface ReadonlyAgyLiveTurnOptions {
  summariesDbPath?: string;
  summariesDefaultPair?: AgySummariesDefaultPair;
  brainDir?: string;
  brainDirs?: readonly string[];
  appDataDir?: string;
}

const readonlyViewCache = new Map<string, { fingerprint: string; view: ReadonlyLiveTurnView | null }>();

function cacheReadonlyView(conversationId: string, fingerprint: string, view: ReadonlyLiveTurnView | null): void {
  readonlyViewCache.delete(conversationId);
  readonlyViewCache.set(conversationId, { fingerprint, view });
  if (readonlyViewCache.size > READONLY_VIEW_CACHE_MAX_ENTRIES) {
    readonlyViewCache.delete(readonlyViewCache.keys().next().value!);
  }
}

function normalizeTranscriptArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
      try {
        out[key] = JSON.parse(value);
      } catch {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function parseTailTranscriptRows(text: string | null): Array<Record<string, unknown>> {
  if (!text) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isPlainRecord(parsed)) rows.push(parsed);
    } catch {
      // Ignore partial trailing line while external CLI is writing.
    }
  }
  return rows;
}

/**
 * Pure display-only snapshot of an external CLI AGY conversation's active turn
 * (interim text, tool calls including subagent/Codex MCP invocations, and active descendant subagents).
 *
 * Strictly never writes into `Core.turns` or `TurnProgressStore`.
 * Fails closed whenever summaries cannot prove the conversation belongs to the authorized `project`.
 */
export function readReadonlyAgyLiveTurn(
  conversationId: string,
  project: string,
  options: ReadonlyAgyLiveTurnOptions = {},
): ReadonlyLiveTurnView | null {
  let hierarchy: ReturnType<typeof readAgySummaryHierarchy>;
  try {
    hierarchy = readAgySummaryHierarchy(options.summariesDbPath, options.summariesDefaultPair);
  } catch {
    return {
      state: 'unavailable',
      anchorId: `cli-live:${conversationId.slice(0, 12)}:unavailable`,
      running: false,
      previewText: '',
      tools: [],
      activeSubagents: [],
      signature: 'unavailable',
    };
  }

  const rootRow = hierarchy.byId.get(conversationId);
  if (!rootRow) {
    if (hierarchy.partialFailure) {
      return {
        state: 'unavailable',
        anchorId: `cli-live:${conversationId.slice(0, 12)}:unavailable`,
        running: false,
        previewText: '',
        tools: [],
        activeSubagents: [],
        signature: 'unavailable',
      };
    }
    return null;
  }
  if (!hierarchy.isTopLevelRow(rootRow) || isTruthyFlag(rootRow.killed)) return null;

  // Prove ALL of the root conversation's summaries workspaces belong strictly within the authorized bound session project.
  const canonicalProject = canonicalizePath(project);
  const rootWorkspaces = parseWorkspaceUris(rootRow.workspace_uris);
  if (
    !rootWorkspaces.length ||
    !rootWorkspaces.every((ws) => {
      const canonicalWs = canonicalizePath(ws);
      return canonicalWs === canonicalProject || isInside(canonicalWs, canonicalProject);
    })
  ) {
    return null;
  }

  const appDataDir =
    options.appDataDir ||
    (typeof rootRow.app_data_dir === 'string' ? rootRow.app_data_dir : '');
  const summaryRunning =
    ACTIVE_CASCADE_STATUSES.has(rootRow.status) || isTruthyFlag(rootRow.not_fully_idle);

  const activeSubagents: SessionSubagentActivity[] = [];
  for (const row of hierarchy.activeDescendantsByRoot.get(conversationId) ?? []) {
    const chainResult = resolveSummaryAncestorChain(row, hierarchy);
    if (chainResult.status !== 'ok' || chainResult.rootRow.conversation_id !== conversationId) continue;
    if (!isAncestorChainAuthorizedForProject(chainResult.chain, conversationId, project)) continue;
    activeSubagents.push({
      conversationId: row.conversation_id,
      agentName: typeof row.agent_name === 'string' && row.agent_name.trim()
        ? row.agent_name.trim()
        : (typeof row.title === 'string' && row.title.trim() ? row.title.trim() : row.conversation_id.slice(0, 8)),
      status: row.status,
    });
  }

  const sources = safeTranscriptTailSources(conversationId, {
    ...(options.brainDir !== undefined ? { brainDir: options.brainDir } : {}),
    ...(options.brainDirs !== undefined ? { brainDirs: options.brainDirs } : {}),
    ...(appDataDir ? { appDataDir } : {}),
  });
  const first = sources.next();
  const fingerprint = JSON.stringify([
    canonicalProject, project, rootRow.status, rootRow.not_fully_idle, rootRow.step_count,
    rootRow.last_modified_time, rootRow.last_user_input_step_index, activeSubagents,
    first.done ? null : [first.value.path, first.value.fingerprint],
  ]);
  const cached = readonlyViewCache.get(conversationId);
  if (cached?.fingerprint === fingerprint) return cached.view;

  let tail = first.done ? null : readTranscriptTailSource(first.value, READONLY_TAIL_BYTES);
  // Retry the preferred source on future polls if its open failed during this read.
  const cacheable = first.done || tail !== null;
  if (!cacheable) {
    for (const source of sources) {
      tail = readTranscriptTailSource(source, READONLY_TAIL_BYTES);
      if (tail !== null) break;
    }
  }
  const rows = parseTailTranscriptRows(tail);

  let lastUserIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.type === 'USER_INPUT' || row.source === 'USER') {
      const content = typeof row.content === 'string' ? extractAgyUserInput(row.content) : '';
      if (content) {
        lastUserIdx = i;
        break;
      }
    }
  }
  const turnRows = lastUserIdx >= 0 ? rows.slice(lastUserIdx + 1) : rows.slice(-20);
  // Stable turn anchor: prefer summaries' last_user_input_step_index (remains invariant even past 128 KiB tail),
  // falling back to transcript USER_INPUT step_index, then a constant 'active' key (never rows.length).
  const summaryUserStep =
    typeof rootRow.last_user_input_step_index === 'number' &&
    Number.isSafeInteger(rootRow.last_user_input_step_index) &&
    rootRow.last_user_input_step_index >= 0
      ? rootRow.last_user_input_step_index
      : null;
  const transcriptUserStep =
    lastUserIdx >= 0 && typeof rows[lastUserIdx]?.step_index === 'number'
      ? Number(rows[lastUserIdx]!.step_index)
      : null;
  const anchorStep =
    summaryUserStep !== null
      ? `user-${summaryUserStep}`
      : transcriptUserStep !== null
        ? `user-${transcriptUserStep}`
        : 'active';
  const anchorId = `cli-live:${conversationId.slice(0, 12)}:${anchorStep}`;

  const tools: ToolProgress[] = [];
  const interimTexts: string[] = [];
  let pendingCallStart = 0;
  let sawTrailingUnresolvedCalls = false;
  let lastRowWasFinalTextOnly = false;
  let callOrdinal = 0;

  let latestThinking = '';
  for (const row of turnRows) {
    if (row.type === 'PLANNER_RESPONSE') {
      const rawThinking = typeof row.thinking === 'string' ? row.thinking.trim() : '';
      if (rawThinking) {
        latestThinking = rawThinking;
      }
      const rawContent = typeof row.content === 'string' ? row.content.trim() : '';
      const rawCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
      if (rawContent) interimTexts.push(rawContent);
      if (rawCalls.length > 0) {
        pendingCallStart = tools.length;
        for (const call of rawCalls) {
          if (!isPlainRecord(call) || typeof call.name !== 'string') continue;
          const args = isPlainRecord(call.args) ? normalizeTranscriptArgs(call.args) : {};
          const detail = summarizeTool(call.name, args, project);
          const stepPart = typeof row.step_index === 'number' ? row.step_index : callOrdinal;
          tools.push({
            turnId: anchorId,
            callId: `${anchorId}:call:${stepPart}:${callOrdinal++}`,
            phase: 'running',
            tool: detail.tool,
            summary: detail.summary,
          });
        }
        sawTrailingUnresolvedCalls = true;
        lastRowWasFinalTextOnly = false;
      } else if (rawContent && row.status === 'DONE') {
        lastRowWasFinalTextOnly = true;
        sawTrailingUnresolvedCalls = false;
      }
    } else if (row.type === 'GENERIC' && row.source === 'MODEL') {
      const idx = tools.findIndex((t, pos) => pos >= pendingCallStart && t.phase === 'running');
      if (idx >= 0) {
        const failed = row.status === 'ERROR' || (typeof row.exit_code === 'number' && row.exit_code !== 0);
        tools[idx] = { ...tools[idx]!, phase: failed ? 'failed' : 'succeeded' };
      }
      sawTrailingUnresolvedCalls = tools.some((t, pos) => pos >= pendingCallStart && t.phase === 'running');
    }
  }

  const running = summaryRunning || activeSubagents.length > 0 || (sawTrailingUnresolvedCalls && !lastRowWasFinalTextOnly);
  if (latestThinking) {
    tools.unshift({
      turnId: anchorId,
      callId: `${anchorId}:thinking`,
      phase: running && !sawTrailingUnresolvedCalls ? 'running' : 'succeeded',
      tool: 'thinking',
      summary: formatThinkingSummary(latestThinking),
    });
  }
  if (!running && !tools.length && !activeSubagents.length && !rows.length) {
    if (cacheable) cacheReadonlyView(conversationId, fingerprint, null);
    return null;
  }

  const contextUsage = extractAgyContextUsageFromRows(rows);
  const previewText = running ? interimTexts.join('\n\n') : '';
  const state = running ? 'running' : 'idle';
  const signature = payloadDigest([anchorId, state, previewText, tools, activeSubagents, contextUsage]);
  const view: ReadonlyLiveTurnView = {
    state,
    anchorId,
    running,
    previewText,
    tools,
    activeSubagents,
    ...(contextUsage ? { contextUsage } : {}),
    signature,
  };
  if (cacheable) cacheReadonlyView(conversationId, fingerprint, view);
  return view;
}
