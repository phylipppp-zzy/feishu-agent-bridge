import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_CASCADE_STATUSES,
  ALL_CONTROL_CHARS_RE,
  canonicalizePath,
  CONVERSATION_ID_RE,
  DEFAULT_AGY_BRAIN_DIR,
  DEFAULT_AGY_SUMMARIES_DB_PATH,
  DEFAULT_MAX_TITLE_LENGTH,
  expandHomePath,
  extractAgyUserInput,
  isInside,
  isPlainRecord,
  isTruthyFlag,
  parseAgyTimestamp,
  stripHostInjectionBlocks,
  TITLE_TRANSCRIPT_READ_BYTES,
  type AgyConversationSummaryRow,
  type AgyDiscoveredSession,
  type AgySessionStatus,
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

/** Read and aggregate top-level Antigravity sessions from `conversation_summaries.db` in strict read-only mode. */
export function readAgySummaries(
  options: {
    dbPath?: string;
    brainDir?: string;
    allowedProjectRoots?: readonly string[];
    includeOutsideRoots?: boolean;
    maxTitleLength?: number;
  } = {},
  titleCache?: AgyTitleCache,
): AgyDiscoveredSession[] {
  const dbPath = resolve(expandHomePath(options.dbPath ?? DEFAULT_AGY_SUMMARIES_DB_PATH));
  const brainDir = resolve(expandHomePath(options.brainDir ?? DEFAULT_AGY_BRAIN_DIR));
  let canonicalBrainDir: string | null = null;
  try {
    if (existsSync(brainDir)) canonicalBrainDir = realpathSync(brainDir);
  } catch {
    canonicalBrainDir = null;
  }
  if (!existsSync(dbPath)) return [];
  const st = lstatSync(dbPath);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`refusing non-regular summaries database: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
  let rows: AgyConversationSummaryRow[];
  try {
    db.exec('PRAGMA query_only = ON');
    rows = db
      .prepare(
        `SELECT
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
        FROM conversation_summaries`,
      )
      .all() as unknown as AgyConversationSummaryRow[];
  } finally {
    db.close();
  }

  const byId = new Map<string, AgyConversationSummaryRow>();
  for (const row of rows) {
    if (typeof row.conversation_id === 'string' && CONVERSATION_ID_RE.test(row.conversation_id) && row.conversation_id !== '.' && row.conversation_id !== '..') {
      byId.set(row.conversation_id, row);
    }
  }

  const isTopLevelRow = (row: AgyConversationSummaryRow): boolean =>
    row.nesting_depth === 0 &&
    (row.parent_conversation_id ?? '') === '' &&
    (row.agent_name ?? '') === '';

  const counts = new Map<string, { total: number; active: number }>();
  const resolveTopAncestor = (startRow: AgyConversationSummaryRow): string | null => {
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

  for (const row of byId.values()) {
    if (isTopLevelRow(row)) continue;
    const rootId = resolveTopAncestor(row);
    if (!rootId) continue;
    const entry = counts.get(rootId) ?? { total: 0, active: 0 };
    entry.total += 1;
    const active =
      !isTruthyFlag(row.killed) &&
      (ACTIVE_CASCADE_STATUSES.has(row.status) || isTruthyFlag(row.not_fully_idle));
    if (active) entry.active += 1;
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
    const subCounts = counts.get(row.conversation_id) ?? { total: 0, active: 0 };
    const rawTitle = typeof row.title === 'string' ? row.title : '';
    const preview = typeof row.preview === 'string' ? row.preview : '';
    const rawStatus = typeof row.status === 'string' ? row.status : '';
    const derivedTitle =
      derivePresentAgyTitle(rawTitle, preview, maxTitleLength) ??
      readTranscriptTitleFromBrain(row.conversation_id, canonicalBrainDir, maxTitleLength, titleCache) ??
      deriveAgySessionTitle(row.conversation_id, '', '', maxTitleLength);
    sessions.push({
      conversationId: row.conversation_id,
      title: derivedTitle,
      rawTitle,
      preview,
      project: projectInfo.project,
      workspacePaths: projectInfo.workspacePaths,
      projectAllowed: projectInfo.allowed,
      stepCount: Number.isFinite(row.step_count) ? Number(row.step_count) : 0,
      status: mapCascadeStatus(rawStatus),
      rawStatus,
      source: typeof row.source === 'string' ? row.source : '',
      projectId: typeof row.project_id === 'string' ? row.project_id : '',
      appDataDir: typeof row.app_data_dir === 'string' ? row.app_data_dir : '',
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
