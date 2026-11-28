import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { SessionSubagentActivity } from '../turn-progress-card.js';
import {
  isAncestorChainAuthorizedForProject,
  parseWorkspaceUris,
  readAgySummaryHierarchy,
  resolveSummaryAncestorChain,
} from './catalog-summaries.js';
import {
  ACTIVE_CASCADE_STATUSES,
  canonicalizePath,
  isInside,
  isPlainRecord,
  isTruthyFlag,
  parseAgyTimestamp,
  type AgySummariesDefaultPair,
} from './catalog-types.js';

const SUBAGENT_PARENTS_FILENAME = 'subagent_parents.json';
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'timed_out', 'cancelled']);
const EVENTS_TAIL_BYTES = 24 * 1024;
const MAX_PARENTS_BYTES = 4 * 1024 * 1024;
const MAX_JOB_STATE_BYTES = 1024 * 1024;
const MAX_SCAN_DIRS = 500;
const RECENT_TERMINAL_WINDOW_MS = 10 * 60_000;
const STALE_SUBAGENT_WINDOW_MS = 30 * 60_000;
const DISPATCH_SNAPSHOT_TTL_MS = 1_500;
const MAX_JOB_CACHE_ENTRIES = 512;
const SAFE_BADGE_RE = /^[\w./:@-]{1,64}$/;
const SAFE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);

let cachedBootId: string | null | undefined;

interface CachedTerminalJob {
  mtimeMs: number;
  size: number;
  terminal: boolean;
  js: Record<string, unknown>;
}

const jobFileCache = new Map<string, CachedTerminalJob>();
const parentsFileCache = new Map<string, { mtimeMs: number; size: number; map: Map<string, string> }>();
const dispatchSnapshotCache = new Map<string, { at: number; items: SessionSubagentActivity[] }>();

function getBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}

function resolveDispatchScratchDir(override?: string): string | null {
  const configured = override?.trim()
    || process.env.AGENT_DISPATCH_SCRATCH?.trim()
    || process.env.CODEX_DISPATCH_SCRATCH?.trim();
  const candidate = configured
    ? (configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured)
    : (() => {
        try {
          const user = userInfo().username;
          return user ? join('/ssd', user, 'scratch', 'codex-dispatch') : '';
        } catch {
          return '';
        }
      })();
  if (!candidate) return null;
  try {
    const st = lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function readSmallRegularFileSafe(filePath: string, maxBytes: number): { text: string; mtimeMs: number; size: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, SAFE_OPEN_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size < 0 || st.size > maxBytes) return null;
    if (st.size === 0) return { text: '', mtimeMs: st.mtimeMs, size: 0 };
    const buf = Buffer.allocUnsafe(st.size);
    let total = 0;
    while (total < st.size) {
      const n = readSync(fd, buf, total, st.size - total, total);
      if (n <= 0) break;
      total += n;
    }
    return { text: buf.subarray(0, total).toString('utf8'), mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function isPidAliveFast(pid: unknown, expectedStartTicks?: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM') return false;
  }
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rparen = raw.lastIndexOf(')');
    if (rparen >= 0) {
      const fields = raw.slice(rparen + 2).split(/\s+/);
      if (fields[0] === 'Z' || fields[0] === 'X') return false;
      if (typeof expectedStartTicks === 'number' && Number.isSafeInteger(expectedStartTicks) && fields.length > 19) {
        const parsedTicks = Number(fields[19]);
        if (Number.isFinite(parsedTicks) && parsedTicks !== expectedStartTicks) return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

export function isJobAliveFast(js: Record<string, unknown>): boolean {
  const expectedBoot = typeof js.boot_id === 'string' && js.boot_id.trim() ? js.boot_id.trim() : null;
  if (expectedBoot) {
    const curBoot = getBootId();
    if (curBoot && curBoot !== expectedBoot) return false;
  }
  return (
    isPidAliveFast(js.child_pid, js.child_start_ticks)
    || isPidAliveFast(js.pid, js.pid_start_ticks)
  );
}

function clipText(raw: string, limit = 44): string {
  const clean = raw.replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length <= limit ? clean : `${chars.slice(0, limit - 1).join('')}…`;
}

function readTailUtf8(filePath: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, SAFE_OPEN_FLAGS);
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size === 0) return '';
    const toRead = Math.min(fst.size, maxBytes);
    const offset = fst.size - toRead;
    const buf = Buffer.allocUnsafe(toRead);
    let total = 0;
    while (total < toRead) {
      const n = readSync(fd, buf, total, toRead - total, offset + total);
      if (n <= 0) break;
      total += n;
    }
    return buf.subarray(0, total).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function extractLatestCodexActivity(eventsPath: string): string {
  const raw = readTailUtf8(eventsPath, EVENTS_TAIL_BYTES);
  if (raw === null) return '启动中…';
  if (!raw.trim()) return '等待首条事件…';
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('{')) continue;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!isPlainRecord(ev)) continue;
    const evType = typeof ev.type === 'string' ? ev.type : '';
    if (evType === 'item.started' || evType === 'item.completed' || evType === 'item.updated') {
      const item = isPlainRecord(ev.item) ? ev.item : null;
      if (!item) continue;
      const itype = typeof item.type === 'string' ? item.type : '';
      if (itype === 'web_search') return '联网检索中…';
      if (itype === 'command_execution') {
        const cmd = typeof item.command === 'string' ? item.command.trim().split(/\s+/)[0] : '';
        const bin = cmd ? cmd.split('/').at(-1) ?? '' : '';
        return bin && /^[\w.-]{1,32}$/.test(bin) ? `执行命令: ${bin}` : '执行命令中…';
      }
      if (itype === 'file_change') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const firstPath = isPlainRecord(changes[0]) && typeof changes[0].path === 'string' ? changes[0].path : '';
        const fname = firstPath ? firstPath.split('/').at(-1) ?? '' : '';
        return fname ? `修改文件: ${clipText(fname, 28)}` : '修改文件中…';
      }
      if (itype === 'reasoning') return '深度推理中…';
      if (itype === 'agent_message' || itype === 'assistant_message') return '整理输出中…';
      if (itype === 'mcp_tool_call') {
        const tool = typeof item.tool === 'string' ? item.tool : (typeof item.name === 'string' ? item.name : '');
        return tool ? `工具调用: ${clipText(tool, 30)}` : '工具调用中…';
      }
    } else if (evType === 'turn.started') {
      return '思考与规划中…';
    } else if (evType === 'thread.started') {
      return '会话已建立…';
    }
  }
  return '运行中…';
}

function loadSubagentParents(scratchRoot: string): Map<string, string> {
  const ledgerPath = join(scratchRoot, SUBAGENT_PARENTS_FILENAME);
  let st;
  try {
    st = lstatSync(ledgerPath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_PARENTS_BYTES) return new Map();
  } catch {
    return new Map();
  }
  const cached = parentsFileCache.get(ledgerPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.map;
  }
  const parents = new Map<string, string>();
  const file = readSmallRegularFileSafe(ledgerPath, MAX_PARENTS_BYTES);
  if (!file || !file.text.trim()) return parents;
  try {
    const raw: unknown = JSON.parse(file.text);
    if (!isPlainRecord(raw)) return parents;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim()) {
        parents.set(k, v.trim());
      } else if (isPlainRecord(v) && typeof v.parent === 'string' && v.parent.trim()) {
        parents.set(k, v.parent.trim());
      }
    }
  } catch {
    // Optional ledger
  }
  if (parentsFileCache.size >= 16) {
    const oldest = parentsFileCache.keys().next().value;
    if (oldest) parentsFileCache.delete(oldest);
  }
  parentsFileCache.set(ledgerPath, { mtimeMs: file.mtimeMs, size: file.size, map: parents });
  return parents;
}

function belongsToConversation(
  jobConvId: string | null,
  rootConvId: string,
  descendantIds: ReadonlySet<string>,
  blockedIds: ReadonlySet<string>,
  parents: ReadonlyMap<string, string>,
): boolean {
  if (!jobConvId) return false;
  let cur: string | undefined = jobConvId;
  const visited = new Set<string>();
  while (cur && !visited.has(cur)) {
    if (blockedIds.has(cur)) return false;
    if (cur === rootConvId || descendantIds.has(cur)) return true;
    visited.add(cur);
    cur = parents.get(cur);
  }
  return false;
}

function isJobCwdAuthorized(jobCwd: unknown, canonicalProject: string): boolean {
  if (typeof jobCwd !== 'string' || !jobCwd.trim() || !canonicalProject) return false;
  const canonicalCwd = canonicalizePath(jobCwd.trim());
  return canonicalCwd === canonicalProject || isInside(canonicalCwd, canonicalProject);
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCachedJobState(jsPath: string): { js: Record<string, unknown>; mtimeMs: number } | null {
  let st;
  try {
    st = lstatSync(jsPath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_JOB_STATE_BYTES) return null;
  } catch {
    return null;
  }
  const cached = jobFileCache.get(jsPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return { js: cached.js, mtimeMs: cached.mtimeMs };
  }
  const file = readSmallRegularFileSafe(jsPath, MAX_JOB_STATE_BYTES);
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  const rawState = typeof parsed.state === 'string' ? parsed.state.trim().toLowerCase() : '';
  if (jobFileCache.size >= MAX_JOB_CACHE_ENTRIES) {
    const oldest = jobFileCache.keys().next().value;
    if (oldest) jobFileCache.delete(oldest);
  }
  jobFileCache.set(jsPath, {
    mtimeMs: file.mtimeMs,
    size: file.size,
    terminal: TERMINAL_JOB_STATES.has(rawState),
    js: parsed,
  });
  return { js: parsed, mtimeMs: file.mtimeMs };
}

export interface DelegatedStatusOptions {
  summariesDbPath?: string;
  summariesDefaultPair?: AgySummariesDefaultPair;
  dispatchScratchDir?: string;
  nowMs?: number;
  recentTerminalWindowMs?: number;
  isJobAlive?: (js: Record<string, unknown>) => boolean;
}

export function readDispatchJobsForConversation(
  conversationId: string,
  project: string,
  descendantIds: ReadonlySet<string>,
  blockedIds: ReadonlySet<string> = new Set(),
  options: Pick<DelegatedStatusOptions, 'dispatchScratchDir' | 'nowMs' | 'recentTerminalWindowMs' | 'isJobAlive'> = {},
): SessionSubagentActivity[] {
  if (!project.trim()) return [];
  const scratchRoot = resolveDispatchScratchDir(options.dispatchScratchDir);
  if (!scratchRoot) return [];
  const canonicalProject = canonicalizePath(project);
  const useSnapshotCache = options.nowMs === undefined && options.isJobAlive === undefined;
  const cacheKey = useSnapshotCache
    ? JSON.stringify([scratchRoot, conversationId, canonicalProject, [...descendantIds].sort(), [...blockedIds].sort()])
    : '';
  const nowMs = options.nowMs ?? Date.now();
  if (useSnapshotCache) {
    const snap = dispatchSnapshotCache.get(cacheKey);
    if (snap && nowMs - snap.at >= 0 && nowMs - snap.at < DISPATCH_SNAPSHOT_TTL_MS) {
      return snap.items;
    }
  }

  let entries;
  try {
    entries = readdirSync(scratchRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const recentWindowMs = options.recentTerminalWindowMs ?? RECENT_TERMINAL_WINDOW_MS;
  const checkAlive = options.isJobAlive ?? isJobAliveFast;
  const parents = loadSubagentParents(scratchRoot);
  const results: Array<{ active: boolean; sortMs: number; item: SessionSubagentActivity }> = [];

  let scanned = 0;
  for (const dirent of entries) {
    if (scanned >= MAX_SCAN_DIRS) break;
    if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === 'locks') continue;
    scanned += 1;
    const entryDir = join(scratchRoot, dirent.name);
    if (existsSync(join(entryDir, 'meta.json'))) continue;
    const loaded = readCachedJobState(join(entryDir, 'job_state.json'));
    if (!loaded) continue;
    const { js, mtimeMs } = loaded;
    const jobConvId = typeof js.conversation_id === 'string' && js.conversation_id.trim()
      ? js.conversation_id.trim()
      : null;
    if (!belongsToConversation(jobConvId, conversationId, descendantIds, blockedIds, parents)) continue;
    if (!isJobCwdAuthorized(js.cwd, canonicalProject)) continue;

    const rawState = typeof js.state === 'string' ? js.state.trim().toLowerCase() : 'running';
    const startedMs = parseIsoMs(js.started_at_utc) ?? mtimeMs;
    const endedMs = parseIsoMs(js.finished_at_utc) ?? parseIsoMs(js.completed_at_utc) ?? mtimeMs;

    let normalizedStatus: string;
    let isActive = false;
    if (TERMINAL_JOB_STATES.has(rawState)) {
      if (nowMs - endedMs > recentWindowMs) continue;
      normalizedStatus = rawState;
    } else if (checkAlive(js)) {
      isActive = true;
      normalizedStatus = rawState === 'queued' ? 'queued' : 'running';
    } else {
      if (nowMs - mtimeMs > recentWindowMs) continue;
      normalizedStatus = 'failed';
    }

    const isAgy = js.backend === 'agy' || js.mode === 'agy';
    const rawTier = typeof js.tier === 'string' && js.tier.trim()
      ? js.tier.trim()
      : (typeof js.tool_name === 'string' && js.tool_name.trim() ? js.tool_name.trim() : (isAgy ? 'agy' : 'codex'));
    const rawAgent = typeof js.agent === 'string' && js.agent.trim() ? js.agent.trim() : '';
    const safeTier = SAFE_BADGE_RE.test(rawTier) ? rawTier : (isAgy ? 'agy' : 'codex');
    const safeAgent = rawAgent && SAFE_BADGE_RE.test(rawAgent) ? rawAgent : '';
    const agentName = safeAgent ? `${safeTier}/${safeAgent}` : safeTier;

    const elapsedSec = Math.max(0, Math.round(((isActive ? nowMs : endedMs) - startedMs) / 1000));
    let activity: string | undefined;
    if (isActive) {
      if (normalizedStatus === 'queued') {
        activity = '排队中…';
      } else if (isAgy) {
        let outBytes = 0;
        try {
          const st = lstatSync(join(entryDir, 'stdout.txt'));
          if (!st.isSymbolicLink() && st.isFile()) outBytes = st.size;
        } catch {}
        activity = outBytes > 0 ? `AGY 整理结果中 (${outBytes}B)…` : 'AGY 推理执行中…';
      } else {
        activity = extractLatestCodexActivity(join(entryDir, 'events.jsonl'));
      }
    }

    results.push({
      active: isActive,
      sortMs: isActive ? startedMs : endedMs,
      item: {
        conversationId: `dispatch:${dirent.name}`,
        agentName,
        status: normalizedStatus,
        kind: 'dispatch_job',
        engine: isAgy ? 'agy' : 'codex',
        elapsedSec,
        ...(activity ? { activity } : {}),
      },
    });
  }

  results.sort((a, b) => Number(!a.active) - Number(!b.active) || b.sortMs - a.sortMs);
  const items = results.map(r => r.item);
  if (useSnapshotCache) {
    if (dispatchSnapshotCache.size >= 128) {
      const oldest = dispatchSnapshotCache.keys().next().value;
      if (oldest) dispatchSnapshotCache.delete(oldest);
    }
    dispatchSnapshotCache.set(cacheKey, { at: nowMs, items });
  }
  return items;
}

/**
 * Read live & recently completed AGY subagents and agent-dispatch (Codex/AGY) background jobs
 * strictly scoped to `conversationId` and authorized `project` (fail-closed on DB/root check errors).
 */
export function readDelegatedSessionActivity(
  conversationId: string,
  project: string,
  options: DelegatedStatusOptions = {},
): SessionSubagentActivity[] {
  if (!project.trim()) return [];
  const nowMs = options.nowMs ?? Date.now();
  const recentWindowMs = options.recentTerminalWindowMs ?? RECENT_TERMINAL_WINDOW_MS;
  const subagents: Array<{ active: boolean; sortMs: number; item: SessionSubagentActivity }> = [];
  const descendantIds = new Set<string>();
  const blockedIds = new Set<string>();

  let hierarchy: ReturnType<typeof readAgySummaryHierarchy>;
  try {
    hierarchy = readAgySummaryHierarchy(options.summariesDbPath, options.summariesDefaultPair);
  } catch {
    return [];
  }

  const rootRow = hierarchy.byId.get(conversationId);
  if (!rootRow || !hierarchy.isTopLevelRow(rootRow) || isTruthyFlag(rootRow.killed)) {
    return [];
  }
  const canonicalProject = canonicalizePath(project);
  const rootWorkspaces = parseWorkspaceUris(rootRow.workspace_uris);
  if (
    !rootWorkspaces.length ||
    !rootWorkspaces.every(ws => {
      const canonicalWs = canonicalizePath(ws);
      return canonicalWs === canonicalProject || isInside(canonicalWs, canonicalProject);
    })
  ) {
    return [];
  }

  for (const row of hierarchy.byId.values()) {
    if (hierarchy.isTopLevelRow(row)) continue;
    const chainResult = resolveSummaryAncestorChain(row, hierarchy);
    if (chainResult.status !== 'ok' || chainResult.rootRow.conversation_id !== conversationId) continue;
    if (isTruthyFlag(row.killed) || !isAncestorChainAuthorizedForProject(chainResult.chain, conversationId, project)) {
      blockedIds.add(row.conversation_id);
      continue;
    }
    descendantIds.add(row.conversation_id);

    const modifiedIso = parseAgyTimestamp(row.last_modified_time);
    const modifiedMs = modifiedIso ? Date.parse(modifiedIso) : null;
    const rawActive = ACTIVE_CASCADE_STATUSES.has(row.status) || isTruthyFlag(row.not_fully_idle);
    const isStaleIdleFlag =
      !ACTIVE_CASCADE_STATUSES.has(row.status)
      && modifiedMs !== null
      && nowMs - modifiedMs > STALE_SUBAGENT_WINDOW_MS;
    const active = rawActive && !isStaleIdleFlag;

    if (!active && (modifiedMs === null || nowMs - modifiedMs > recentWindowMs)) {
      continue;
    }
    const label = typeof row.agent_name === 'string' && row.agent_name.trim()
      ? row.agent_name.trim()
      : (typeof row.title === 'string' && row.title.trim() ? row.title.trim() : row.conversation_id.slice(0, 8));
    const status = active
      ? 'running'
      : (typeof row.status === 'string' && row.status.toUpperCase().includes('ERROR') ? 'failed' : 'completed');
    subagents.push({
      active,
      sortMs: modifiedMs ?? 0,
      item: {
        conversationId: row.conversation_id,
        agentName: label,
        status,
        kind: 'subagent',
      },
    });
  }

  subagents.sort((a, b) => Number(!a.active) - Number(!b.active) || b.sortMs - a.sortMs);
  const dispatchJobs = readDispatchJobsForConversation(conversationId, project, descendantIds, blockedIds, options);
  const combined = [...dispatchJobs, ...subagents.map(s => s.item)];
  combined.sort((a, b) => {
    const aActive = a.status === 'running' || a.status === 'queued' || a.status === 'CASCADE_RUN_STATUS_RUNNING';
    const bActive = b.status === 'running' || b.status === 'queued' || b.status === 'CASCADE_RUN_STATUS_RUNNING';
    return Number(!aActive) - Number(!bActive);
  });
  return combined;
}
