import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_CASCADE_STATUSES,
  ALL_CONTROL_CHARS_RE,
  canonicalizePath,
  CONVERSATION_ID_RE,
  DEFAULT_AGY_BRAIN_DIR,
  DEFAULT_AGY_IDE_BRAIN_DIR,
  DEFAULT_AGY_SUMMARIES_DB_PATH,
  DEFAULT_MAX_TITLE_LENGTH,
  expandHomePath,
  extractAgyUserInput,
  isInside,
  isPlainRecord,
  isTruthyFlag,
  parseAgyTimestamp,
  parseAgyTimestampNanos,
  resolveAgyBrainDirs,
  resolveAgySummariesDbPaths,
  stripHostInjectionBlocks,
  TITLE_TRANSCRIPT_READ_BYTES,
  type AgyConversationSummaryRow,
  type AgyDiscoveredSession,
  type AgySessionStatus,
  type AgySubagentSummary,
  type AgySummariesDefaultPair,
} from './catalog-types.js';

/** Parse a `workspace_uris` JSON array of `file://` URIs into normalized local absolute paths. */
export function parseWorkspaceUris(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const results: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'string' || !item.trim()) continue;
    try {
      const url = new URL(item.trim());
      if (url.protocol !== 'file:') continue;
      if (url.hostname && url.hostname !== 'localhost') continue;
      const fsPath = resolve(fileURLToPath(url));
      if (!seen.has(fsPath)) {
        seen.add(fsPath);
        results.push(fsPath);
      }
    } catch {
      continue;
    }
  }
  return results;
}

/** Resolve the first canonical workspace path allowed by `allowedProjectRoots` (if provided). */
export function resolveAllowedProject(
  workspaceUrisRaw: unknown,
  allowedProjectRoots?: readonly string[],
): { project: string; workspacePaths: string[]; allowed: boolean } {
  const rawPaths = parseWorkspaceUris(workspaceUrisRaw);
  const canonicalPaths = rawPaths.map((p) => {
    try {
      return canonicalizePath(p);
    } catch {
      return resolve(p);
    }
  });

  if (allowedProjectRoots === undefined) {
    return {
      project: canonicalPaths[0] ?? '',
      workspacePaths: canonicalPaths,
      allowed: true,
    };
  }

  if (!allowedProjectRoots.every((r) => typeof r === 'string' && isAbsolute(r))) {
    throw new Error('allowedProjectRoots entries must be absolute paths');
  }
  const canonicalRoots = allowedProjectRoots.map((r) => canonicalizePath(r));
  const matched = canonicalPaths.find((candidate) => canonicalRoots.some((root) => isInside(candidate, root)));
  return {
    project: matched ?? '',
    workspacePaths: canonicalPaths,
    allowed: matched !== undefined,
  };
}

function truncateText(text: string, maxLen: number): string {
  const chars = [...text];
  if (chars.length <= maxLen) return text;
  if (maxLen <= 1) return chars.slice(0, maxLen).join('');
  return `${chars.slice(0, maxLen - 1).join('').trimEnd()}…`;
}

export function isPlaceholderAgyTitle(title: string): boolean {
  return /^\[(?:USER|ASSISTANT)\]$/i.test(title.trim());
}

function derivePresentAgyTitle(
  title: unknown,
  preview: unknown,
  maxLength = DEFAULT_MAX_TITLE_LENGTH,
): string | null {
  if (typeof title === 'string') {
    const cleanTitle = stripHostInjectionBlocks(title)
      .replace(ALL_CONTROL_CHARS_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleanTitle && !isPlaceholderAgyTitle(cleanTitle)) return truncateText(cleanTitle, maxLength);
  }
  if (typeof preview === 'string') {
    const cleanedPreview = extractAgyUserInput(preview);
    const firstLine = cleanedPreview
      .split(/\r?\n/)
      .map((line) => line.replace(ALL_CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim())
      .find(Boolean);
    if (firstLine && !isPlaceholderAgyTitle(firstLine)) return truncateText(firstLine, maxLength);
  }
  return null;
}

function cleanUserRequestLine(rawContent: string, maxLength: number): string | null {
  const cleaned = extractAgyUserInput(rawContent).replace(/<truncated\s+\d+\s+bytes>\s*$/gi, '').trim();
  if (!cleaned) return null;
  const firstLine = cleaned
    .split(/\r?\n/)
    .map((line) => line.replace(ALL_CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim())
    .find(Boolean);
  return firstLine && !isPlaceholderAgyTitle(firstLine) ? truncateText(firstLine, maxLength) : null;
}

function decodePartialJsonStringField(line: string, fieldName: string): string | null {
  const match = new RegExp(`"${fieldName}"\\s*:\\s*"`).exec(line);
  if (!match) return null;
  let out = '';
  let i = match.index + match[0].length;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '"') break;
    if (ch === '\\') {
      if (i + 1 >= line.length) break;
      const esc = line[i + 1]!;
      if (esc === 'n') { out += '\n'; i += 2; continue; }
      if (esc === 'r') { out += '\r'; i += 2; continue; }
      if (esc === 't') { out += '\t'; i += 2; continue; }
      if (esc === 'b') { out += '\b'; i += 2; continue; }
      if (esc === 'f') { out += '\f'; i += 2; continue; }
      if (esc === 'u') {
        const hex = line.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        }
        break;
      }
      out += esc;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out || null;
}

function readTranscriptTitleFromBrain(
  conversationId: string,
  canonicalBrainDir: string | null,
  maxLength: number,
  cache?: AgyTitleCache,
): string | null {
  if (!canonicalBrainDir) return null;
  try {
    const sessionDir = join(canonicalBrainDir, conversationId);
    const sessionStat = lstatSync(sessionDir);
    if (sessionStat.isSymbolicLink() || !sessionStat.isDirectory()) return null;
    const canonicalSessionDir = realpathSync(sessionDir);
    if (!isInside(canonicalSessionDir, canonicalBrainDir)) return null;

    let current = canonicalSessionDir;
    for (const seg of ['.system_generated', 'logs']) {
      current = join(current, seg);
      const segStat = lstatSync(current);
      if (segStat.isSymbolicLink() || !segStat.isDirectory()) return null;
    }
    const transcriptPath = join(current, 'transcript.jsonl');
    const fileStat = lstatSync(transcriptPath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    const canonicalPath = realpathSync(transcriptPath);
    if (!isInside(canonicalPath, canonicalSessionDir)) return null;

    let fd: number | undefined;
    try {
      fd = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile()) return null;
      const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${maxLength}`;
      const cached = cache?.previous.get(canonicalPath);
      if (cached?.stamp === stamp) {
        cache?.next.set(canonicalPath, cached);
        return cached.title;
      }
      const toRead = Math.min(st.size, TITLE_TRANSCRIPT_READ_BYTES);
      if (toRead <= 0) return null;
      const buf = Buffer.allocUnsafe(toRead);
      let bytesRead = 0;
      while (bytesRead < toRead) {
        const n = readSync(fd, buf, bytesRead, toRead - bytesRead, bytesRead);
        if (n <= 0) break;
        bytesRead += n;
      }
      const title = transcriptTitle(buf.subarray(0, bytesRead).toString('utf8'), st.size > bytesRead, maxLength);
      cache?.next.set(canonicalPath, { stamp, title });
      return title;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
  } catch {
    return null;
  }
}

function transcriptTitle(rawText: string, truncatedAtCap: boolean, maxLength: number): string | null {
  const rawLines = rawText.split(/\r?\n/);
  const completeLines = truncatedAtCap ? rawLines.slice(0, -1) : rawLines;
  for (const line of completeLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isPlainRecord(parsed) || parsed.type !== 'USER_INPUT' || typeof parsed.content !== 'string') continue;
    const extracted = cleanUserRequestLine(parsed.content, maxLength);
    if (extracted) return extracted;
  }

  if (truncatedAtCap) {
    const trailing = rawLines.at(-1) ?? '';
    if (/"type"\s*:\s*"USER_INPUT"/.test(trailing)) {
      const partialContent = decodePartialJsonStringField(trailing, 'content');
      if (partialContent) {
        const extracted = cleanUserRequestLine(partialContent, maxLength);
        if (extracted) return extracted;
      }
    }
  }
  return null;
}

export type AgyTitleCacheEntry = { stamp: string; title: string | null };
interface AgyTitleCache {
  previous: Map<string, AgyTitleCacheEntry>;
  next: Map<string, AgyTitleCacheEntry>;
}

/** Derive a display title: non-empty `title`, else cleaned `preview` first line, else `Antigravity 会话 · <shortId>`. */
export function deriveAgySessionTitle(
  conversationId: string,
  title: unknown,
  preview: unknown,
  maxLength = DEFAULT_MAX_TITLE_LENGTH,
): string {
  const present = derivePresentAgyTitle(title, preview, maxLength);
  if (present) return present;
  const shortId = (typeof conversationId === 'string' && conversationId.slice(0, 8)) || 'unknown';
  return `Antigravity 会话 · ${shortId}`;
}

function mapCascadeStatus(raw: string): AgySessionStatus {
  switch (raw) {
    case 'CASCADE_RUN_STATUS_IDLE':
      return 'idle';
    case 'CASCADE_RUN_STATUS_RUNNING':
      return 'running';
    case 'CASCADE_RUN_STATUS_CANCELING':
      return 'canceling';
    case 'CASCADE_RUN_STATUS_BUSY':
      return 'busy';
    default:
      return 'unspecified';
  }
}

const SUMMARY_SELECT_SQL = `SELECT
  conversation_id,
  title,
  preview,
  step_count,
  last_modified_time,
  workspace_uris,
  status,
  source,
  project_id,
  agent_name,
  parent_conversation_id,
  nesting_depth,
  battle_id,
  winning_conversation_id,
  not_fully_idle,
  killed,
  last_user_input_time,
  last_user_input_step_index,
  app_data_dir,
  group_id
FROM conversation_summaries`;

export interface AgySummaryHierarchy {
  byId: ReadonlyMap<string, AgyConversationSummaryRow>;
  isTopLevelRow: (row: AgyConversationSummaryRow) => boolean;
  resolveTopAncestor: (startRow: AgyConversationSummaryRow) => string | null;
  activeDescendantsByRoot: ReadonlyMap<string, readonly AgyConversationSummaryRow[]>;
  partialFailure: boolean;
}

const SUMMARY_CACHE_TTL_MS = 1500;
const SUMMARY_CACHE_MAX_ENTRIES = 16;
const summaryHierarchyCache = new Map<string, {
  fingerprint: string;
  loadedAt: number;
  hierarchy: AgySummaryHierarchy;
}>();

function statFingerprint(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export function agyFileFingerprint(path: string): string | null {
  try {
    return statFingerprint(lstatSync(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : null;
  }
}

/**
 * Resolve ONLY explicitly configured or built-in default brain roots for security-sensitive readers.
 * Untrusted `appDataDir` values from SQLite may only choose ordering among built-in defaults,
 * never inject arbitrary external directories.
 */
function resolveAuthorizedBrainDirs(options: {
  brainDir?: string;
  brainDirs?: readonly string[];
  appDataDir?: string;
}): string[] {
  const configured: string[] = [];
  const pushUnique = (dir: string | undefined): void => {
    if (typeof dir !== 'string' || !dir.trim()) return;
    const abs = resolve(expandHomePath(dir.trim()));
    if (!configured.includes(abs)) configured.push(abs);
  };
  if (options.brainDir?.trim() || options.brainDirs?.length) {
    pushUnique(options.brainDir);
    if (options.brainDirs) {
      for (const d of options.brainDirs) pushUnique(d);
    }
    return configured;
  }
  const preferIde = options.appDataDir?.trim() === 'antigravity';
  if (preferIde) {
    pushUnique(DEFAULT_AGY_IDE_BRAIN_DIR);
    pushUnique(DEFAULT_AGY_BRAIN_DIR);
  } else {
    pushUnique(DEFAULT_AGY_BRAIN_DIR);
    pushUnique(DEFAULT_AGY_IDE_BRAIN_DIR);
  }
  return configured;
}

export type AncestorChainResult =
  | { status: 'ok'; chain: AgyConversationSummaryRow[]; rootRow: AgyConversationSummaryRow }
  | { status: 'missing' }
  | { status: 'invalid' };

/** Walk the full parent chain from `startRow` to its top-level root with 64-level cycle protection. */
export function resolveSummaryAncestorChain(
  startRow: AgyConversationSummaryRow,
  hierarchy: AgySummaryHierarchy,
): AncestorChainResult {
  if (hierarchy.isTopLevelRow(startRow)) {
    return { status: 'ok', chain: [startRow], rootRow: startRow };
  }
  const chain: AgyConversationSummaryRow[] = [startRow];
  const visited = new Set<string>([startRow.conversation_id]);
  let parentId = startRow.parent_conversation_id;
  let depth = 0;
  while (parentId && depth < 64) {
    if (visited.has(parentId)) return { status: 'invalid' };
    visited.add(parentId);
    const parent = hierarchy.byId.get(parentId);
    if (!parent) return { status: 'missing' };
    chain.push(parent);
    if (hierarchy.isTopLevelRow(parent)) {
      return { status: 'ok', chain, rootRow: parent };
    }
    parentId = parent.parent_conversation_id;
    depth++;
  }
  return { status: 'invalid' };
}

/**
 * Verify that EVERY node along a descendant's ancestor chain is alive (not killed)
 * and that EVERY explicit workspace declared by any descendant/intermediate node
 * stays within `allowedProjectRoots` (if set) AND is consistent with `rootProject`.
 */
export function isAncestorChainAuthorizedForProject(
  chain: readonly AgyConversationSummaryRow[],
  rootId: string,
  rootProject: string,
  allowedProjectRoots?: readonly string[],
): boolean {
  const canonicalRoot = canonicalizePath(rootProject);
  for (const node of chain) {
    if (isTruthyFlag(node.killed)) return false;
    const nodeWorkspaces = parseWorkspaceUris(node.workspace_uris);
    if (!nodeWorkspaces.length) continue;
    if (allowedProjectRoots !== undefined) {
      const nodeProj = resolveAllowedProject(node.workspace_uris, allowedProjectRoots);
      if (!nodeProj.allowed) return false;
      for (const ws of nodeWorkspaces) {
        const wsCheck = resolveAllowedProject(JSON.stringify([`file://${ws}`]), allowedProjectRoots);
        if (!wsCheck.allowed) return false;
      }
    }
    if (node.conversation_id === rootId) continue;
    const allConsistent = nodeWorkspaces.every((ws) => {
      const canonicalWs = canonicalizePath(ws);
      return canonicalWs === canonicalRoot || isInside(canonicalWs, canonicalRoot) || isInside(canonicalRoot, canonicalWs);
    });
    if (!allConsistent) return false;
  }
  return true;
}

type TranscriptTailOptions = { brainDir?: string; brainDirs?: readonly string[]; appDataDir?: string };
type TranscriptTailSource = { path: string; stat: Stats; fingerprint: string };

/** Resolve candidate transcript paths without opening or reading any files. */
export function* safeTranscriptTailSources(
  conversationId: string,
  options: TranscriptTailOptions,
): Generator<TranscriptTailSource> {
  if (
    !conversationId ||
    conversationId === '.' ||
    conversationId === '..' ||
    !CONVERSATION_ID_RE.test(conversationId)
  ) {
    return;
  }
  const dirs = resolveAuthorizedBrainDirs(options);
  for (const dir of dirs) {
    let canonicalBrainDir: string;
    try {
      if (!existsSync(dir)) continue;
      canonicalBrainDir = realpathSync(dir);
    } catch {
      continue;
    }
    try {
      const sessionDir = join(canonicalBrainDir, conversationId);
      const sessionStat = lstatSync(sessionDir);
      if (sessionStat.isSymbolicLink() || !sessionStat.isDirectory()) continue;
      const canonicalSessionDir = realpathSync(sessionDir);
      if (!isInside(canonicalSessionDir, canonicalBrainDir)) continue;

      let current = canonicalSessionDir;
      let validSegments = true;
      for (const seg of ['.system_generated', 'logs']) {
        current = join(current, seg);
        const segStat = lstatSync(current);
        if (segStat.isSymbolicLink() || !segStat.isDirectory()) {
          validSegments = false;
          break;
        }
        const canonicalSeg = realpathSync(current);
        if (!isInside(canonicalSeg, canonicalSessionDir)) {
          validSegments = false;
          break;
        }
        current = canonicalSeg;
      }
      if (!validSegments) continue;

      const transcriptPath = join(current, 'transcript.jsonl');
      const fileStat = lstatSync(transcriptPath);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) continue;
      const canonicalPath = realpathSync(transcriptPath);
      if (!isInside(canonicalPath, canonicalSessionDir)) continue;
      yield { path: canonicalPath, stat: fileStat, fingerprint: statFingerprint(fileStat) };
    } catch {
      continue;
    }
  }
}

/** Read a verified source, checking that the opened file still matches the resolved path. */
export function readTranscriptTailSource(source: TranscriptTailSource, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== source.stat.dev || st.ino !== source.stat.ino) return null;
    if (st.size === 0) return '';
    const toRead = Math.min(st.size, maxBytes);
    const offset = st.size - toRead;
    const buf = Buffer.allocUnsafe(toRead);
    let bytesRead = 0;
    while (bytesRead < toRead) {
      const n = readSync(fd, buf, bytesRead, toRead - bytesRead, offset + bytesRead);
      if (n <= 0) break;
      bytesRead += n;
    }
    const text = buf.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const firstNl = text.indexOf('\n');
      return firstNl >= 0 ? text.slice(firstNl + 1) : '';
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function readSafeTranscriptTail(
  conversationId: string,
  maxBytes: number,
  options: TranscriptTailOptions,
): string | null {
  if (maxBytes <= 0) return null;
  for (const source of safeTranscriptTailSources(conversationId, options)) {
    const text = readTranscriptTailSource(source, maxBytes);
    if (text !== null) return text;
  }
  return null;
}

function readSingleSummariesDb(dbPath: string): AgyConversationSummaryRow[] {
  if (!existsSync(dbPath)) return [];
  const st = lstatSync(dbPath);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`refusing non-regular summaries database: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
  try {
    db.exec('PRAGMA query_only = ON');
    return db.prepare(SUMMARY_SELECT_SQL).all() as unknown as AgyConversationSummaryRow[];
  } finally {
    db.close();
  }
}

function isNewerSummaryRow(candidate: AgyConversationSummaryRow, current: AgyConversationSummaryRow): boolean {
  const nextNs = parseAgyTimestampNanos(candidate.last_modified_time);
  const prevNs = parseAgyTimestampNanos(current.last_modified_time);
  if (nextNs !== null && prevNs !== null) {
    if (nextNs !== prevNs) return nextNs > prevNs;
  } else if (nextNs !== prevNs) {
    return nextNs !== null;
  }
  const nextSteps = typeof candidate.step_count === 'number' ? candidate.step_count : -1;
  const prevSteps = typeof current.step_count === 'number' ? current.step_count : -1;
  return nextSteps > prevSteps;
}

export function readAgySummaryHierarchy(
  dbPath?: string,
  defaultPair?: AgySummariesDefaultPair,
): AgySummaryHierarchy {
  const dbPaths = resolveAgySummariesDbPaths(dbPath, defaultPair);
  const cacheKey = JSON.stringify(dbPaths);
  const fingerprints = dbPaths.flatMap(path => [agyFileFingerprint(path), agyFileFingerprint(`${path}-wal`)]);
  const fingerprint = fingerprints.includes(null) ? null : JSON.stringify(fingerprints);
  const cached = summaryHierarchyCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    const age = Date.now() - cached.loadedAt;
    if (age >= 0 && age < SUMMARY_CACHE_TTL_MS) return cached.hierarchy;
  }
  const byId = new Map<string, AgyConversationSummaryRow>();
  let firstError: unknown = null;
  let loadedAny = false;
  for (const candidatePath of dbPaths) {
    if (!existsSync(candidatePath)) continue;
    try {
      const rows = readSingleSummariesDb(candidatePath);
      loadedAny = true;
      for (const row of rows) {
        if (
          typeof row.conversation_id !== 'string' ||
          !CONVERSATION_ID_RE.test(row.conversation_id) ||
          row.conversation_id === '.' ||
          row.conversation_id === '..'
        ) {
          continue;
        }
        const existing = byId.get(row.conversation_id);
        if (!existing || isNewerSummaryRow(row, existing)) {
          byId.set(row.conversation_id, row);
        }
      }
    } catch (error) {
      if (dbPaths.length === 1) throw error;
      if (firstError === null) firstError = error;
    }
  }
  if (!loadedAny && firstError !== null) throw firstError;

  const isTopLevelRow = (row: AgyConversationSummaryRow): boolean =>
    row.nesting_depth === 0 &&
    (row.parent_conversation_id ?? '') === '' &&
    (row.agent_name ?? '') === '';

  const resolveTopAncestor = (startRow: AgyConversationSummaryRow): string | null => {
    if (isTopLevelRow(startRow)) return startRow.conversation_id;
    const visited = new Set<string>([startRow.conversation_id]);
    let parentId = startRow.parent_conversation_id;
    let depth = 0;
    while (parentId && depth < 64) {
      if (visited.has(parentId)) return null;
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return null;
      if (isTopLevelRow(parent)) return parent.conversation_id;
      parentId = parent.parent_conversation_id;
      depth++;
    }
    return null;
  };

  const activeDescendantsByRoot = new Map<string, AgyConversationSummaryRow[]>();
  for (const row of byId.values()) {
    if (isTopLevelRow(row) || isTruthyFlag(row.killed) ||
        !(ACTIVE_CASCADE_STATUSES.has(row.status) || isTruthyFlag(row.not_fully_idle))) continue;
    const rootId = resolveTopAncestor(row);
    if (rootId === null) continue;
    const rows = activeDescendantsByRoot.get(rootId);
    if (rows) rows.push(row);
    else activeDescendantsByRoot.set(rootId, [row]);
  }
  const hierarchy: AgySummaryHierarchy = {
    byId, isTopLevelRow, resolveTopAncestor, activeDescendantsByRoot, partialFailure: firstError !== null,
  };
  if (fingerprint !== null) {
    summaryHierarchyCache.delete(cacheKey);
    summaryHierarchyCache.set(cacheKey, { fingerprint, loadedAt: Date.now(), hierarchy });
    if (summaryHierarchyCache.size > SUMMARY_CACHE_MAX_ENTRIES) {
      summaryHierarchyCache.delete(summaryHierarchyCache.keys().next().value!);
    }
  }
  return hierarchy;
}

export function readAgySummaries(
  options: {
    dbPath?: string;
    brainDir?: string;
    brainDirs?: readonly string[];
    allowedProjectRoots?: readonly string[];
    includeOutsideRoots?: boolean;
    maxTitleLength?: number;
  } = {},
  titleCache?: { previous: Map<string, AgyTitleCacheEntry>; next: Map<string, AgyTitleCacheEntry> },
): AgyDiscoveredSession[] {
  const canonicalBrainDirCache = new Map<string, string | null>();
  const resolveCanonicalBrain = (dir: string): string | null => {
    if (canonicalBrainDirCache.has(dir)) return canonicalBrainDirCache.get(dir)!;
    let canonical: string | null = null;
    try {
      if (existsSync(dir)) canonical = realpathSync(dir);
    } catch {
      canonical = null;
    }
    canonicalBrainDirCache.set(dir, canonical);
    return canonical;
  };
  const readTitleFromBrains = (conversationId: string, appDataDir: string, maxLen: number): string | null => {
    const dirs = resolveAgyBrainDirs({
      ...(options.brainDir !== undefined ? { brainDir: options.brainDir } : {}),
      ...(options.brainDirs !== undefined ? { brainDirs: options.brainDirs } : {}),
      ...(appDataDir ? { appDataDir } : {}),
    });
    for (const dir of dirs) {
      const title = readTranscriptTitleFromBrain(conversationId, resolveCanonicalBrain(dir), maxLen, titleCache);
      if (title) return title;
    }
    return null;
  };

  const { byId, isTopLevelRow, resolveTopAncestor } = readAgySummaryHierarchy(options.dbPath);

  const counts = new Map<string, { total: number; active: number; activeList: AgySubagentSummary[] }>();

  for (const row of byId.values()) {
    if (isTopLevelRow(row)) continue;
    const rootId = resolveTopAncestor(row);
    if (!rootId) continue;
    const entry = counts.get(rootId) ?? { total: 0, active: 0, activeList: [] };
    entry.total += 1;
    const active =
      !isTruthyFlag(row.killed) &&
      (ACTIVE_CASCADE_STATUSES.has(row.status) || isTruthyFlag(row.not_fully_idle));
    if (active) {
      entry.active += 1;
      entry.activeList.push({
        conversationId: row.conversation_id,
        agentName: typeof row.agent_name === 'string' && row.agent_name.trim()
          ? row.agent_name.trim()
          : (typeof row.title === 'string' && row.title.trim() ? row.title.trim() : row.conversation_id.slice(0, 8)),
        status: mapCascadeStatus(typeof row.status === 'string' ? row.status : ''),
        lastModifiedAt: parseAgyTimestamp(row.last_modified_time),
      });
    }
    counts.set(rootId, entry);
  }

  const maxTitleLength = options.maxTitleLength ?? DEFAULT_MAX_TITLE_LENGTH;
  const sessions: AgyDiscoveredSession[] = [];

  for (const row of byId.values()) {
    if (!isTopLevelRow(row)) continue;
    const projectInfo = resolveAllowedProject(row.workspace_uris, options.allowedProjectRoots);
    if (options.allowedProjectRoots !== undefined && !projectInfo.allowed && !options.includeOutsideRoots) {
      continue;
    }
    const subCounts = counts.get(row.conversation_id) ?? { total: 0, active: 0, activeList: [] };
    subCounts.activeList.sort((a, b) => (b.lastModifiedAt ?? '').localeCompare(a.lastModifiedAt ?? ''));
    const rawTitle = typeof row.title === 'string' ? row.title : '';
    const preview = typeof row.preview === 'string' ? row.preview : '';
    const rawStatus = typeof row.status === 'string' ? row.status : '';
    const appDataDir = typeof row.app_data_dir === 'string' ? row.app_data_dir : '';
    const derivedTitle =
      derivePresentAgyTitle(rawTitle, preview, maxTitleLength) ??
      readTitleFromBrains(row.conversation_id, appDataDir, maxTitleLength) ??
      deriveAgySessionTitle(row.conversation_id, '', '', maxTitleLength);
    sessions.push({
      conversationId: row.conversation_id,
      title: derivedTitle,
      rawTitle,
      preview,
      project: projectInfo.project,
      workspacePaths: projectInfo.workspacePaths,
      projectAllowed: projectInfo.allowed,
      stepCount:
        typeof row.step_count === 'number' && Number.isSafeInteger(row.step_count) && row.step_count >= 0
          ? row.step_count
          : 0,
      status: mapCascadeStatus(rawStatus),
      rawStatus,
      source: typeof row.source === 'string' ? row.source : '',
      projectId: typeof row.project_id === 'string' ? row.project_id : '',
      appDataDir,
      groupId: typeof row.group_id === 'string' ? row.group_id : '',
      lastModifiedAt: parseAgyTimestamp(row.last_modified_time),
      lastUserInputAt: parseAgyTimestamp(row.last_user_input_time),
      lastUserInputStepIndex: Number.isFinite(row.last_user_input_step_index)
        ? Number(row.last_user_input_step_index)
        : -1,
      notFullyIdle: isTruthyFlag(row.not_fully_idle),
      killed: isTruthyFlag(row.killed),
      subagentCount: subCounts.total,
      activeSubagentCount: subCounts.active,
      ...(subCounts.activeList.length ? { activeSubagents: subCounts.activeList } : {}),
      isTopLevel: true,
    });
  }

  sessions.sort((a, b) => {
    const ta = a.lastModifiedAt ?? '';
    const tb = b.lastModifiedAt ?? '';
    if (ta !== tb) return tb.localeCompare(ta);
    return a.conversationId.localeCompare(b.conversationId);
  });

  return sessions;
}
