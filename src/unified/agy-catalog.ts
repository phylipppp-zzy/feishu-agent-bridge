import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Page } from './contracts.js';

export const DEFAULT_AGY_SUMMARIES_DB_PATH = join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
export const DEFAULT_AGY_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain');

export const AGY_EXCLUDED_ARTIFACT_DIRS = new Set([
  '.system_generated',
  'scratch',
  '.tempmediaStorage',
  'browser_sandbox',
  '.user_uploaded',
  '.git',
  '.jj',
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.config',
  '.claude',
]);

export const DEFAULT_AGY_ARTIFACT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.pdf',
  '.csv',
  '.html',
  '.htm',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
]);

const ACTIVE_CASCADE_STATUSES = new Set([
  'CASCADE_RUN_STATUS_RUNNING',
  'CASCADE_RUN_STATUS_BUSY',
  'CASCADE_RUN_STATUS_CANCELING',
]);

const TERMINAL_STEP_STATUSES = new Set([
  'DONE',
  'ERROR',
  'CANCELED',
  'CLEARED',
  'HALTED',
  'INTERRUPTED',
  'INVALID',
]);

const SECRET_FILENAME_RE =
  /^\.env(?:\..*)?$|^\.(?:netrc|npmrc|pypirc|git-credentials)$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|\.(?:pem|key|p12|pfx|jks|keystore|kdbx|p8|ovpn)$|secret|credential|passw|(?:^|[-_.])(?:private[-_]?key|api[-_]?key|auth[-_]?token|access[-_]?token|oauth[-_]?creds)(?:[-_.]|$)/i;

const SIDECAR_FILENAME_RE = /(?:\.metadata\.json|\.resolved(?:\.[^/]+)?|\.url\.json)$/i;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g;
const ALL_CONTROL_CHARS_RE = /[\x00-\x1f\x7f]+/g;
const CONVERSATION_ID_RE = /^[a-zA-Z0-9._-]+$/;

const HOST_INJECTION_TAGS = [
  'ADDITIONAL_METADATA',
  'USER_SETTINGS_CHANGE',
  'SYSTEM_MESSAGE',
  'COMPACTED_HISTORY',
  'CONTEXT_SUMMARY',
  'SUBAGENT',
] as const;

const SYSTEM_MESSAGE_PREAMBLE_RE =
  /The following is a <SYSTEM_MESSAGE> not actually sent by the user\. It is provided by the system as important information to pay attention to\.\s*/gi;

const MEDIA_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const MAX_ARTIFACT_SCAN_DEPTH = 16;
const MAX_ARTIFACT_SCAN_ENTRIES = 10_000;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TITLE_LENGTH = 80;

export type AgySessionStatus = 'idle' | 'running' | 'canceling' | 'busy' | 'unspecified';

export interface AgyConversationSummaryRow {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  workspace_uris: string;
  status: string;
  source: string;
  project_id: string;
  agent_name: string;
  parent_conversation_id: string;
  nesting_depth: number;
  battle_id: string;
  winning_conversation_id: string;
  not_fully_idle: number | boolean;
  killed: number | boolean;
  last_user_input_time: string;
  last_user_input_step_index: number;
  app_data_dir: string;
  group_id: string;
}

export interface AgyDiscoveredSession {
  conversationId: string;
  title: string;
  rawTitle: string;
  preview: string;
  project: string;
  workspacePaths: string[];
  projectAllowed: boolean;
  stepCount: number;
  status: AgySessionStatus;
  rawStatus: string;
  source: string;
  projectId: string;
  appDataDir: string;
  groupId: string;
  lastModifiedAt: string | null;
  lastUserInputAt: string | null;
  lastUserInputStepIndex: number;
  notFullyIdle: boolean;
  killed: boolean;
  subagentCount: number;
  activeSubagentCount: number;
  isTopLevel: true;
}

export interface AgyTokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgyToolCallSummary {
  name: string;
  args?: Record<string, unknown>;
}

export interface AgyMediaSummary {
  mimeType?: string;
  uri: string;
}

export interface AgyTranscriptStep {
  stepIndex: number | null;
  lineNumber: number;
  source: string;
  type: string;
  status: string;
  createdAt: string | null;
  model: string | null;
  content: string;
  thinking: string | null;
  usage: AgyTokenUsage | null;
  toolCalls: AgyToolCallSummary[];
  media: AgyMediaSummary[];
  error: string | null;
  errorCode: number | null;
  exitCode: number | null;
  truncatedFields: string[];
  resolvedFromFull: boolean;
}

export interface AgyTranscriptMessage {
  messageId: string;
  conversationId: string;
  stepIndex: number | null;
  lineNumber: number;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string | null;
  model: string | null;
  thinking: string | null;
  usage: AgyTokenUsage | null;
  status: string;
  source: string;
  final: boolean;
  resolvedFromFull: boolean;
}

export interface AgyTranscriptReadResult {
  conversationId: string;
  transcriptPath: string | null;
  fullTranscriptPath: string | null;
  usedFullFallback: boolean;
  steps: AgyTranscriptStep[];
  messages: AgyTranscriptMessage[];
  nextLine: number;
  lastCreatedAt: string | null;
  lastStepIndex: number | null;
  cursor: string;
  parseErrors: number;
  truncatedTrailingLine: boolean;
}

export interface AgyArtifactEntry {
  artifactId: string;
  conversationId: string;
  relativePath: string;
  path: string;
  name: string;
  mediaType: string;
  size: number;
  mtimeMs: number;
  contentVersion: string;
}

export interface AgyCatalogOptions {
  dbPath?: string;
  brainDir?: string;
  allowedProjectRoots?: readonly string[];
  includeOutsideRoots?: boolean;
  maxTitleLength?: number;
  maxTranscriptBytes?: number;
  maxArtifactBytes?: number;
  allowedArtifactExtensions?: readonly string[];
}

export interface AgyReadTranscriptOptions {
  brainDir?: string;
  afterLine?: number;
  sinceTimestamp?: string | number;
  afterStepIndex?: number;
  cursor?: string;
  maxBytes?: number;
}

export interface AgyArtifactOptions {
  brainDir?: string;
  maxBytes?: number;
  allowedExtensions?: readonly string[];
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function expandHomePath(target: string): string {
  if (target === '~') return homedir();
  if (target.startsWith('~/')) return join(homedir(), target.slice(2));
  return target;
}

/**
 * Canonicalize a path for containment checks even if leaf segments do not yet exist on disk,
 * while resolving all existing ancestor symlinks via realpathSync.
 */
function canonicalizePath(targetPath: string): string {
  const abs = resolve(expandHomePath(targetPath));
  if (existsSync(abs)) return realpathSync(abs);
  const missing: string[] = [];
  let current = abs;
  while (!existsSync(current)) {
    const parent = resolve(current, '..');
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync(current) : current;
  return missing.length ? join(base, ...missing) : base;
}

function assertValidConversationId(conversationId: string): string {
  if (
    typeof conversationId !== 'string' ||
    !conversationId ||
    conversationId === '.' ||
    conversationId === '..' ||
    !CONVERSATION_ID_RE.test(conversationId)
  ) {
    throw new Error(`invalid agy conversation id: ${String(conversationId)}`);
  }
  return conversationId;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isPlainRecord(parsed)) throw new Error('invalid cursor');
    return parsed;
  } catch {
    throw new Error('invalid cursor');
  }
}

/**
 * Parse Antigravity / Go SQLite timestamps such as:
 * - `"2026-11-21 14:53:24.288703821+00:00"`
 * - `"2026-11-22T12:54:40Z"`
 * - `"0001-01-01 00:00:00+00:00"` (returns null sentinel)
 */
export function parseAgyTimestamp(raw: unknown): string | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const ms = raw > 1e12 ? raw : raw * 1000;
    const dt = new Date(ms);
    return Number.isFinite(dt.getTime()) && dt.getUTCFullYear() >= 1970 ? dt.toISOString() : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('0001-01-01')) return null;

  // Normalize "YYYY-MM-DD HH:MM:SS(.nnnnnnnnn)?(Z|+HH:MM|-HH:MM)" into ISO-8601 millisecond precision
  // so V8 never falls back to legacy non-ISO date parsing.
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i.exec(trimmed);
  if (match) {
    const year = Number(match[1]);
    if (!Number.isSafeInteger(year) || year <= 1) return null;
    const frac = (match[7] ?? '').slice(0, 3).padEnd(3, '0');
    let tz = match[8] ?? 'Z';
    if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
    const isoCandidate = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${frac}${tz.toUpperCase()}`;
    const parsedMs = Date.parse(isoCandidate);
    if (!Number.isFinite(parsedMs)) return null;
    const dt = new Date(parsedMs);
    return dt.getUTCFullYear() >= 1970 ? dt.toISOString() : null;
  }

  const fallbackMs = Date.parse(trimmed);
  if (!Number.isFinite(fallbackMs)) return null;
  const dt = new Date(fallbackMs);
  return dt.getUTCFullYear() >= 1970 ? dt.toISOString() : null;
}

function parseTimestampMs(raw: unknown): number | null {
  const iso = parseAgyTimestamp(raw);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

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

function stripHostInjectionBlocks(text: string): string {
  let cleaned = text.replace(SYSTEM_MESSAGE_PREAMBLE_RE, '');
  for (const tag of HOST_INJECTION_TAGS) {
    const pairRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    cleaned = cleaned.replace(pairRe, '');
    // Handle truncated trailing metadata blocks if full transcript wasn't available.
    const unclosedTrailingRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'gi');
    cleaned = cleaned.replace(unclosedTrailingRe, '');
  }
  return cleaned;
}

/**
 * Extract visible user prompt text from an Antigravity `USER_INPUT` step content.
 * Prefers inner `<USER_REQUEST>...</USER_REQUEST>` content and strips host-injected blocks.
 */
export function extractAgyUserInput(rawContent: string): string {
  if (typeof rawContent !== 'string' || !rawContent) return '';
  let text = rawContent.replace(CONTROL_CHARS_RE, '');

  const requests: string[] = [];
  const reqRe = /<USER_REQUEST\b[^>]*>([\s\S]*?)<\/USER_REQUEST>/gi;
  let match: RegExpExecArray | null;
  while ((match = reqRe.exec(text)) !== null) {
    if (match[1] !== undefined) requests.push(match[1]);
  }

  if (requests.length > 0) {
    text = requests.join('\n\n');
  } else {
    // Fallback if opening <USER_REQUEST> was truncated before closing tag.
    text = text.replace(/<\/?USER_REQUEST\b[^>]*>/gi, '');
  }

  text = stripHostInjectionBlocks(text);
  return text.trim();
}

function truncateText(text: string, maxLen: number): string {
  const chars = [...text];
  if (chars.length <= maxLen) return text;
  if (maxLen <= 1) return chars.slice(0, maxLen).join('');
  return `${chars.slice(0, maxLen - 1).join('').trimEnd()}…`;
}

/** Derive a display title: non-empty `title`, else cleaned `preview` first line, else `Antigravity 会话 · <shortId>`. */
export function deriveAgySessionTitle(
  conversationId: string,
  title: unknown,
  preview: unknown,
  maxLength = DEFAULT_MAX_TITLE_LENGTH,
): string {
  if (typeof title === 'string') {
    const cleanTitle = stripHostInjectionBlocks(title)
      .replace(ALL_CONTROL_CHARS_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleanTitle) return truncateText(cleanTitle, maxLength);
  }
  if (typeof preview === 'string') {
    const cleanedPreview = extractAgyUserInput(preview);
    const firstLine = cleanedPreview
      .split(/\r?\n/)
      .map((line) => line.replace(ALL_CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim())
      .find(Boolean);
    if (firstLine) return truncateText(firstLine, maxLength);
  }
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
    allowedProjectRoots?: readonly string[];
    includeOutsideRoots?: boolean;
    maxTitleLength?: number;
  } = {},
): AgyDiscoveredSession[] {
  const dbPath = resolve(expandHomePath(options.dbPath ?? DEFAULT_AGY_SUMMARIES_DB_PATH));
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
    sessions.push({
      conversationId: row.conversation_id,
      title: deriveAgySessionTitle(row.conversation_id, rawTitle, preview, maxTitleLength),
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

/** Deterministic message ID for restart deduplication across incremental reads. */
export function stableAgyMessageId(
  conversationId: string,
  stepIndex: number | null,
  lineNumber: number,
  role: 'user' | 'assistant',
): string {
  const stepIdentity = stepIndex !== null ? `step:${stepIndex}` : `line:${lineNumber}`;
  return sha256(JSON.stringify(['agy', conversationId, stepIdentity, role]));
}

function nonNegIntOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function extractTokenUsage(row: Record<string, unknown>): AgyTokenUsage | null {
  const hasAny =
    Object.prototype.hasOwnProperty.call(row, 'input_tokens') ||
    Object.prototype.hasOwnProperty.call(row, 'cache_read_tokens') ||
    Object.prototype.hasOwnProperty.call(row, 'output_tokens');
  if (!hasAny) return null;
  const inputTokens = nonNegIntOrNull(row.input_tokens ?? 0);
  const cacheReadTokens = nonNegIntOrNull(row.cache_read_tokens ?? 0);
  const outputTokens = nonNegIntOrNull(row.output_tokens ?? 0);
  if (inputTokens === null || cacheReadTokens === null || outputTokens === null) return null;
  return {
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
  };
}

function extractToolCalls(value: unknown): AgyToolCallSummary[] {
  if (!Array.isArray(value)) return [];
  const result: AgyToolCallSummary[] = [];
  for (const item of value) {
    if (!isPlainRecord(item) || typeof item.name !== 'string' || !item.name) continue;
    const call: AgyToolCallSummary = { name: item.name };
    if (isPlainRecord(item.args)) call.args = item.args;
    result.push(call);
  }
  return result;
}

function extractMedia(value: unknown): AgyMediaSummary[] {
  if (!Array.isArray(value)) return [];
  const result: AgyMediaSummary[] = [];
  for (const item of value) {
    if (!isPlainRecord(item) || typeof item.uri !== 'string' || !item.uri) continue;
    const media: AgyMediaSummary = { uri: item.uri };
    if (typeof item.mime_type === 'string' && item.mime_type) media.mimeType = item.mime_type;
    result.push(media);
  }
  return result;
}

async function readRegularFileWithinRoot(
  filePath: string,
  canonicalRoot: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`refusing non-regular or symlinked file: ${filePath}`);
  }
  const canonicalPath = await realpath(filePath);
  if (!isInside(canonicalPath, canonicalRoot)) {
    throw new Error(`file escapes allowed root: ${filePath}`);
  }
  if (info.size > maxBytes) {
    throw new Error(`file exceeds max bytes (${info.size} > ${maxBytes}): ${filePath}`);
  }
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(`file invalid or exceeds max bytes: ${filePath}`);
    }
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buf, offset, stat.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function splitCompleteJsonlLines(text: string): { lines: string[]; truncatedTrailingLine: boolean } {
  if (!text) return { lines: [], truncatedTrailingLine: false };
  const endsWithNewline = text.endsWith('\n');
  const rawLines = text.split(/\r?\n/);
  if (endsWithNewline) {
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
    return { lines: rawLines, truncatedTrailingLine: false };
  }
  const last = rawLines[rawLines.length - 1] ?? '';
  if (!last.trim()) {
    rawLines.pop();
    return { lines: rawLines, truncatedTrailingLine: false };
  }
  try {
    const parsed: unknown = JSON.parse(last);
    if (isPlainRecord(parsed)) {
      return { lines: rawLines, truncatedTrailingLine: false };
    }
  } catch {
    // Half-written trailing JSONL line during active session flush: leave it for the next read.
  }
  rawLines.pop();
  return { lines: rawLines, truncatedTrailingLine: true };
}

interface FullTranscriptIndex {
  byStepIndex: Map<number, Record<string, unknown>>;
  byLine: Array<Record<string, unknown> | null>;
}

function buildFullTranscriptIndex(text: string): FullTranscriptIndex {
  const { lines } = splitCompleteJsonlLines(text);
  const byStepIndex = new Map<number, Record<string, unknown>>();
  const byLine: Array<Record<string, unknown> | null> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      byLine.push(null);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isPlainRecord(parsed)) {
        byLine.push(parsed);
        const step = nonNegIntOrNull(parsed.step_index);
        if (step !== null) byStepIndex.set(step, parsed);
      } else {
        byLine.push(null);
      }
    } catch {
      byLine.push(null);
    }
  }
  return { byStepIndex, byLine };
}

/**
 * Parse Antigravity `transcript.jsonl` (and look up `truncated_fields` from `transcript_full.jsonl` when needed).
 * Supports incremental reads via `cursor`, `afterLine`, or `sinceTimestamp` + `afterStepIndex`.
 */
export async function readAgyTranscript(
  conversationId: string,
  options: AgyReadTranscriptOptions = {},
): Promise<AgyTranscriptReadResult> {
  assertValidConversationId(conversationId);
  const brainDir = resolve(expandHomePath(options.brainDir ?? DEFAULT_AGY_BRAIN_DIR));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;

  let startLine = options.afterLine ?? 0;
  let sinceMs: number | null = null;
  if (options.sinceTimestamp !== undefined) {
    sinceMs =
      typeof options.sinceTimestamp === 'number' && options.sinceTimestamp === 0
        ? 0
        : parseTimestampMs(options.sinceTimestamp);
    if (sinceMs === null) {
      throw new Error('invalid sinceTimestamp');
    }
  }
  const afterStepIndex = options.afterStepIndex;
  let expectedPrefixDigest: string | null = null;
  let carriedCreatedAt: string | null = null;
  let carriedStepIndex: number | null = null;

  if (options.cursor) {
    const c = decodeCursor(options.cursor);
    if (
      c.conversationId !== conversationId ||
      typeof c.line !== 'number' ||
      !Number.isSafeInteger(c.line) ||
      c.line < 0 ||
      typeof c.prefixDigest !== 'string'
    ) {
      throw new Error('stale or invalid cursor');
    }
    startLine = c.line;
    expectedPrefixDigest = c.prefixDigest;
    if (typeof c.lastCreatedAt === 'string') carriedCreatedAt = c.lastCreatedAt;
    if (typeof c.lastStepIndex === 'number' && Number.isSafeInteger(c.lastStepIndex)) {
      carriedStepIndex = c.lastStepIndex;
    }
  }

  if (!Number.isSafeInteger(startLine) || startLine < 0) {
    throw new Error('invalid afterLine');
  }

  const emptyResult = (transcriptPath: string | null, fullPath: string | null, usedFullFallback: boolean): AgyTranscriptReadResult => ({
    conversationId,
    transcriptPath,
    fullTranscriptPath: fullPath,
    usedFullFallback,
    steps: [],
    messages: [],
    nextLine: 0,
    lastCreatedAt: null,
    lastStepIndex: null,
    cursor: encodeCursor({
      conversationId,
      line: 0,
      lastCreatedAt: null,
      lastStepIndex: null,
      prefixDigest: sha256(''),
    }),
    parseErrors: 0,
    truncatedTrailingLine: false,
  });

  if (!existsSync(brainDir)) {
    if (expectedPrefixDigest !== null && startLine > 0) throw new Error('stale or invalid cursor');
    return emptyResult(null, null, false);
  }

  const canonicalBrainDir = await realpath(brainDir);
  const sessionDir = join(canonicalBrainDir, conversationId);
  if (!existsSync(sessionDir)) {
    if (expectedPrefixDigest !== null && startLine > 0) throw new Error('stale or invalid cursor');
    return emptyResult(null, null, false);
  }
  const sessionInfo = await lstat(sessionDir);
  if (sessionInfo.isSymbolicLink() || !sessionInfo.isDirectory()) {
    throw new Error(`refusing non-directory or symlinked session brain dir: ${sessionDir}`);
  }
  const canonicalSessionDir = await realpath(sessionDir);
  if (!isInside(canonicalSessionDir, canonicalBrainDir)) {
    throw new Error(`session brain dir escapes brainDir: ${sessionDir}`);
  }

  const compactPath = join(canonicalSessionDir, '.system_generated', 'logs', 'transcript.jsonl');
  const fullPath = join(canonicalSessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');

  const compactBuf = await readRegularFileWithinRoot(compactPath, canonicalSessionDir, maxBytes);
  let primaryBuf = compactBuf;
  let usedFullFallback = false;
  let fullBufCache: Buffer | null | undefined;

  if (primaryBuf === null) {
    fullBufCache = await readRegularFileWithinRoot(fullPath, canonicalSessionDir, maxBytes);
    primaryBuf = fullBufCache;
    usedFullFallback = fullBufCache !== null;
  }

  if (primaryBuf === null) {
    if (expectedPrefixDigest !== null && startLine > 0) throw new Error('stale or invalid cursor');
    return emptyResult(null, null, false);
  }

  const primaryText = primaryBuf.toString('utf8');
  const { lines, truncatedTrailingLine } = splitCompleteJsonlLines(primaryText);

  if (startLine > lines.length) {
    if (expectedPrefixDigest !== null) throw new Error('stale or invalid cursor');
    return emptyResult(
      compactBuf ? compactPath : null,
      usedFullFallback ? fullPath : null,
      usedFullFallback,
    );
  }

  if (expectedPrefixDigest !== null) {
    const actualPrefixDigest = sha256(lines.slice(0, startLine).join('\n'));
    if (actualPrefixDigest !== expectedPrefixDigest) {
      throw new Error('stale or invalid cursor');
    }
  }

  let fullIndex: FullTranscriptIndex | null | undefined;
  const loadFullIndex = async (): Promise<FullTranscriptIndex | null> => {
    if (fullIndex !== undefined) return fullIndex;
    if (usedFullFallback) {
      fullIndex = null;
      return null;
    }
    if (fullBufCache === undefined) {
      fullBufCache = await readRegularFileWithinRoot(fullPath, canonicalSessionDir, maxBytes);
    }
    fullIndex = fullBufCache ? buildFullTranscriptIndex(fullBufCache.toString('utf8')) : null;
    return fullIndex;
  };

  const steps: AgyTranscriptStep[] = [];
  const messages: AgyTranscriptMessage[] = [];
  const messageIndexById = new Map<string, number>();
  let parseErrors = 0;
  let lastCreatedAt: string | null = carriedCreatedAt;
  let lastStepIndex: number | null = carriedStepIndex;

  for (let lineNumber = startLine; lineNumber < lines.length; lineNumber++) {
    const trimmed = lines[lineNumber]?.trim() ?? '';
    if (!trimmed) continue;

    let rawRow: unknown;
    try {
      rawRow = JSON.parse(trimmed);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (!isPlainRecord(rawRow)) {
      parseErrors += 1;
      continue;
    }

    const row: Record<string, unknown> = { ...rawRow };
    const stepIndex = nonNegIntOrNull(row.step_index);
    const createdAt = parseAgyTimestamp(row.created_at);
    const createdAtMs = createdAt ? Date.parse(createdAt) : null;

    if (sinceMs !== null) {
      if (createdAtMs === null) {
        continue;
      }
      if (createdAtMs < sinceMs) {
        continue;
      }
      if (createdAtMs === sinceMs) {
        if (afterStepIndex === undefined || stepIndex === null || stepIndex <= afterStepIndex) {
          continue;
        }
      }
    }

    const truncatedFields = Array.isArray(row.truncated_fields)
      ? row.truncated_fields.filter((f): f is string => typeof f === 'string' && f.length > 0)
      : [];

    let resolvedFromFull = false;
    if (truncatedFields.length > 0 && !usedFullFallback) {
      const idx = await loadFullIndex();
      if (idx) {
        const candidate =
          stepIndex !== null ? idx.byStepIndex.get(stepIndex) : idx.byLine[lineNumber] ?? undefined;
        if (
          candidate &&
          (typeof row.type !== 'string' || typeof candidate.type !== 'string' || candidate.type === row.type)
        ) {
          for (const field of truncatedFields) {
            if (candidate[field] !== undefined) {
              row[field] = candidate[field];
              resolvedFromFull = true;
            }
          }
        }
      }
    }

    const stepType = typeof row.type === 'string' ? row.type : '';
    const source = typeof row.source === 'string' ? row.source : '';
    const status = typeof row.status === 'string' ? row.status : '';
    const model = typeof row.model === 'string' && row.model ? row.model : null;
    // IMPORTANT: PLANNER_RESPONSE stores assistant text in `content`, NOT `text`.
    const content = typeof row.content === 'string' ? row.content : '';
    const thinking = typeof row.thinking === 'string' && row.thinking ? row.thinking : null;
    const error = typeof row.error === 'string' && row.error ? row.error : null;
    const errorCode =
      typeof row.error_code === 'number' && Number.isSafeInteger(row.error_code) ? row.error_code : null;
    const exitCode =
      typeof row.exit_code === 'number' && Number.isSafeInteger(row.exit_code) ? row.exit_code : null;
    const usage = extractTokenUsage(row);
    const toolCalls = extractToolCalls(row.tool_calls);
    const media = extractMedia(row.media);

    const step: AgyTranscriptStep = {
      stepIndex,
      lineNumber,
      source,
      type: stepType,
      status,
      createdAt,
      model,
      content,
      thinking,
      usage,
      toolCalls,
      media,
      error,
      errorCode,
      exitCode,
      truncatedFields,
      resolvedFromFull,
    };
    steps.push(step);

    if (createdAt) lastCreatedAt = createdAt;
    if (stepIndex !== null) lastStepIndex = stepIndex;

    let msgRole: 'user' | 'assistant' | null = null;
    let msgText = '';
    if (stepType === 'USER_INPUT') {
      msgRole = 'user';
      msgText = extractAgyUserInput(content);
    } else if (stepType === 'PLANNER_RESPONSE') {
      msgRole = 'assistant';
      msgText = content.trim();
    }

    if (msgRole && msgText) {
      const messageId = stableAgyMessageId(conversationId, stepIndex, lineNumber, msgRole);
      const message: AgyTranscriptMessage = {
        messageId,
        conversationId,
        stepIndex,
        lineNumber,
        role: msgRole,
        text: msgText,
        createdAt,
        model,
        thinking,
        usage,
        status,
        source,
        final: status === '' || TERMINAL_STEP_STATUSES.has(status),
        resolvedFromFull,
      };
      const existingIdx = messageIndexById.get(messageId);
      if (existingIdx !== undefined) {
        messages[existingIdx] = message;
      } else {
        messageIndexById.set(messageId, messages.length);
        messages.push(message);
      }
    }
  }

  const nextLine = lines.length;
  const cursor = encodeCursor({
    conversationId,
    line: nextLine,
    lastCreatedAt,
    lastStepIndex,
    prefixDigest: sha256(lines.join('\n')),
  });

  return {
    conversationId,
    transcriptPath: compactBuf ? compactPath : null,
    fullTranscriptPath: usedFullFallback || fullBufCache ? fullPath : null,
    usedFullFallback,
    steps,
    messages,
    nextLine,
    lastCreatedAt,
    lastStepIndex,
    cursor,
    parseErrors,
    truncatedTrailingLine,
  };
}

/** Check whether a relative artifact path under `<brainDir>/<conversationId>/` must be excluded. */
export function isExcludedAgyArtifactPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized === '..') return true;
  const segments = normalized.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) return true;
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i]!;
    if (dir.startsWith('.') || AGY_EXCLUDED_ARTIFACT_DIRS.has(dir)) return true;
  }
  const fileName = segments[segments.length - 1]!;
  if (fileName.startsWith('.')) return true;
  if (AGY_EXCLUDED_ARTIFACT_DIRS.has(fileName)) return true;
  if (SIDECAR_FILENAME_RE.test(fileName)) return true;
  if (SECRET_FILENAME_RE.test(fileName)) return true;
  return false;
}

function normalizeAllowedExtensions(allowedExtensions?: readonly string[]): Set<string> {
  if (!allowedExtensions) return DEFAULT_AGY_ARTIFACT_EXTENSIONS;
  return new Set(allowedExtensions.map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`)));
}

async function resolveArtifactSessionDir(
  conversationId: string,
  brainDir: string,
): Promise<{ canonicalBrainDir: string; canonicalSessionDir: string } | null> {
  assertValidConversationId(conversationId);
  if (!existsSync(brainDir)) return null;
  const canonicalBrainDir = await realpath(brainDir);
  const sessionDir = join(canonicalBrainDir, conversationId);
  let info;
  try {
    info = await lstat(sessionDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`refusing symlinked or non-directory artifact root: ${sessionDir}`);
  }
  const canonicalSessionDir = await realpath(sessionDir);
  if (!isInside(canonicalSessionDir, canonicalBrainDir)) {
    throw new Error(`artifact root escapes brainDir: ${sessionDir}`);
  }
  return { canonicalBrainDir, canonicalSessionDir };
}

async function readSafeArtifactBytes(
  filePath: string,
  canonicalSessionDir: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; size: number; mtimeMs: number; canonicalPath: string }> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`refusing symlink or non-regular artifact file: ${filePath}`);
  }
  const canonicalPath = await realpath(filePath);
  if (!isInside(canonicalPath, canonicalSessionDir)) {
    throw new Error(`artifact escapes session directory: ${filePath}`);
  }
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(`invalid artifact size or type: ${filePath}`);
    }
    try {
      const fdPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!isInside(fdPath, canonicalSessionDir) || fdPath !== canonicalPath) {
        throw new Error(`artifact path changed during open: ${filePath}`);
      }
    } catch (err) {
      // /proc/self/fd may not exist on non-Linux hosts; re-throw security errors.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buf, offset, stat.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return {
      bytes: buf.subarray(0, offset),
      size: offset,
      mtimeMs: stat.mtimeMs,
      canonicalPath,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Scan `<brainDir>/<conversationId>/` for allowlisted artifact files (reports, markdown, images).
 * Strictly excludes `.system_generated/`, `scratch/`, `.tempmediaStorage/`, `browser_sandbox/`,
 * `.user_uploaded/`, `.git/`, `.jj/`, sidecar metadata/resolved/url JSONs, symlinks, and credentials.
 */
export async function discoverAgyArtifacts(
  conversationId: string,
  options: AgyArtifactOptions = {},
): Promise<AgyArtifactEntry[]> {
  const brainDir = resolve(expandHomePath(options.brainDir ?? DEFAULT_AGY_BRAIN_DIR));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const allowedExts = normalizeAllowedExtensions(options.allowedExtensions);

  const dirs = await resolveArtifactSessionDir(conversationId, brainDir);
  if (!dirs) return [];

  const { canonicalSessionDir } = dirs;
  const entries: AgyArtifactEntry[] = [];
  let visited = 0;

  const walk = async (currentDir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > MAX_ARTIFACT_SCAN_DEPTH) return;
    const dirents = (await readdir(currentDir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const ent of dirents) {
      if (++visited > MAX_ARTIFACT_SCAN_ENTRIES) {
        throw new Error('agy artifact scan budget exceeded');
      }
      const relPath = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const fullPath = join(currentDir, ent.name);

      let info;
      try {
        info = await lstat(fullPath);
      } catch {
        continue;
      }

      // Never follow symlinks inside brain/<id>/ (prevents escape and sidecar leaks).
      if (info.isSymbolicLink()) continue;

      if (info.isDirectory()) {
        if (ent.name.startsWith('.') || AGY_EXCLUDED_ARTIFACT_DIRS.has(ent.name)) continue;
        await walk(fullPath, relPath, depth + 1);
        continue;
      }

      if (!info.isFile()) continue;
      if (isExcludedAgyArtifactPath(relPath)) continue;

      const ext = extname(ent.name).toLowerCase();
      if (!allowedExts.has(ext)) continue;
      if (info.size < 0 || info.size > maxBytes) continue;

      try {
        const readRes = await readSafeArtifactBytes(fullPath, canonicalSessionDir, maxBytes);
        entries.push({
          artifactId: sha256(JSON.stringify([conversationId, readRes.canonicalPath])),
          conversationId,
          relativePath: relPath,
          path: readRes.canonicalPath,
          name: ent.name,
          mediaType: MEDIA_TYPES[ext] ?? 'application/octet-stream',
          size: readRes.size,
          mtimeMs: readRes.mtimeMs,
          contentVersion: sha256(readRes.bytes),
        });
      } catch {
        continue;
      }
    }
  };

  await walk(canonicalSessionDir, '', 0);
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

/** Validate and read a specific artifact relative path inside `<brainDir>/<conversationId>/`. */
export async function readAgyArtifact(
  conversationId: string,
  relPath: string,
  options: AgyArtifactOptions & { expectedContentVersion?: string } = {},
): Promise<{ entry: AgyArtifactEntry; content: Uint8Array }> {
  const brainDir = resolve(expandHomePath(options.brainDir ?? DEFAULT_AGY_BRAIN_DIR));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const allowedExts = normalizeAllowedExtensions(options.allowedExtensions);

  if (typeof relPath !== 'string' || !relPath || isAbsolute(relPath) || relPath.includes('\0')) {
    throw new Error('relative artifact path required');
  }

  const dirs = await resolveArtifactSessionDir(conversationId, brainDir);
  if (!dirs) throw new Error(`agy session directory not found: ${conversationId}`);
  const { canonicalSessionDir } = dirs;

  const targetPath = resolve(canonicalSessionDir, relPath);
  const rel = relative(canonicalSessionDir, targetPath).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`artifact path escapes session directory: ${relPath}`);
  }
  if (isExcludedAgyArtifactPath(rel)) {
    throw new Error(`artifact path is excluded by security policy: ${rel}`);
  }

  const ext = extname(basename(targetPath)).toLowerCase();
  if (!allowedExts.has(ext)) {
    throw new Error(`artifact extension is not allowlisted: ${ext || '(none)'}`);
  }

  // Verify no intermediate directory is a symlink before opening target.
  const segments = rel.split('/');
  let cursor = canonicalSessionDir;
  for (let i = 0; i < segments.length - 1; i++) {
    cursor = join(cursor, segments[i]!);
    const dirStat = await lstat(cursor);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`refusing symlinked or invalid directory segment: ${segments[i]}`);
    }
  }

  const readRes = await readSafeArtifactBytes(targetPath, canonicalSessionDir, maxBytes);
  const contentVersion = sha256(readRes.bytes);
  if (options.expectedContentVersion && options.expectedContentVersion !== contentVersion) {
    throw new Error('artifact content version mismatch');
  }

  return {
    entry: {
      artifactId: sha256(JSON.stringify([conversationId, readRes.canonicalPath])),
      conversationId,
      relativePath: rel,
      path: readRes.canonicalPath,
      name: basename(readRes.canonicalPath),
      mediaType: MEDIA_TYPES[ext] ?? 'application/octet-stream',
      size: readRes.size,
      mtimeMs: readRes.mtimeMs,
      contentVersion,
    },
    content: readRes.bytes,
  };
}

/**
 * Stateful catalog wrapper over Antigravity local SQLite index, JSONL transcripts, and artifacts.
 * Strictly read-only: never modifies `conversation_summaries.db` or spawns `agy`.
 */
export class AgyCatalog {
  private sessions = new Map<string, AgyDiscoveredSession>();
  private orderedIds: string[] = [];

  constructor(private readonly options: AgyCatalogOptions = {}) {}

  refresh(): AgyDiscoveredSession[] {
    const summaryOpts: Parameters<typeof readAgySummaries>[0] = {};
    if (this.options.dbPath !== undefined) summaryOpts.dbPath = this.options.dbPath;
    if (this.options.allowedProjectRoots !== undefined) {
      summaryOpts.allowedProjectRoots = this.options.allowedProjectRoots;
    }
    if (this.options.includeOutsideRoots !== undefined) {
      summaryOpts.includeOutsideRoots = this.options.includeOutsideRoots;
    }
    if (this.options.maxTitleLength !== undefined) summaryOpts.maxTitleLength = this.options.maxTitleLength;

    const list = readAgySummaries(summaryOpts);
    const next = new Map<string, AgyDiscoveredSession>();
    const ids: string[] = [];
    for (const s of list) {
      next.set(s.conversationId, s);
      ids.push(s.conversationId);
    }
    this.sessions = next;
    this.orderedIds = ids;
    return this.orderedIds.map((id) => structuredClone(this.sessions.get(id)!));
  }

  get(conversationId: string): AgyDiscoveredSession | null {
    const found = this.sessions.get(conversationId);
    return found ? structuredClone(found) : null;
  }

  list(limit: number, cursor?: string, search = ''): Page<AgyDiscoveredSession> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid limit');
    const needle = search.toLowerCase();
    const filtered = this.orderedIds
      .map((id) => this.sessions.get(id)!)
      .filter((s) => `${s.title}\n${s.project}\n${s.conversationId}`.toLowerCase().includes(needle));

    const fingerprint = sha256(JSON.stringify([needle, filtered.map((s) => s.conversationId)]));
    let offset = 0;
    if (cursor) {
      const c = decodeCursor(cursor);
      if (
        c.fingerprint !== fingerprint ||
        typeof c.offset !== 'number' ||
        !Number.isSafeInteger(c.offset) ||
        c.offset < 0 ||
        c.offset > filtered.length
      ) {
        throw new Error('stale or invalid cursor');
      }
      offset = c.offset;
    }

    const end = Math.min(offset + limit, filtered.length);
    return {
      items: filtered.slice(offset, end).map((s) => structuredClone(s)),
      nextCursor: end < filtered.length ? encodeCursor({ fingerprint, offset: end }) : null,
    };
  }

  async readTranscript(
    conversationId: string,
    options: Omit<AgyReadTranscriptOptions, 'brainDir'> = {},
  ): Promise<AgyTranscriptReadResult> {
    const readOpts: AgyReadTranscriptOptions = { ...options };
    if (this.options.brainDir !== undefined) readOpts.brainDir = this.options.brainDir;
    if (readOpts.maxBytes === undefined && this.options.maxTranscriptBytes !== undefined) {
      readOpts.maxBytes = this.options.maxTranscriptBytes;
    }
    return readAgyTranscript(conversationId, readOpts);
  }

  async history(
    conversationId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<AgyTranscriptMessage>> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid limit');
    const transcript = await this.readTranscript(conversationId);
    const messages = transcript.messages;

    let offset = 0;
    if (cursor) {
      const c = decodeCursor(cursor);
      if (
        c.conversationId !== conversationId ||
        typeof c.offset !== 'number' ||
        !Number.isSafeInteger(c.offset) ||
        c.offset < 0 ||
        c.offset > messages.length ||
        c.prefix !== sha256(JSON.stringify(messages.slice(0, c.offset).map((m) => m.messageId)))
      ) {
        throw new Error('stale or invalid cursor');
      }
      offset = c.offset;
    }

    const end = Math.min(offset + limit, messages.length);
    return {
      items: messages.slice(offset, end).map((m) => structuredClone(m)),
      nextCursor: encodeCursor({
        conversationId,
        offset: end,
        prefix: sha256(JSON.stringify(messages.slice(0, end).map((m) => m.messageId))),
      }),
    };
  }

  async listArtifacts(conversationId: string): Promise<AgyArtifactEntry[]> {
    const artOpts: AgyArtifactOptions = {};
    if (this.options.brainDir !== undefined) artOpts.brainDir = this.options.brainDir;
    if (this.options.maxArtifactBytes !== undefined) artOpts.maxBytes = this.options.maxArtifactBytes;
    if (this.options.allowedArtifactExtensions !== undefined) {
      artOpts.allowedExtensions = this.options.allowedArtifactExtensions;
    }
    return discoverAgyArtifacts(conversationId, artOpts);
  }

  async readArtifact(
    conversationId: string,
    relativePath: string,
    expectedContentVersion?: string,
  ): Promise<{ entry: AgyArtifactEntry; content: Uint8Array }> {
    const artOpts: AgyArtifactOptions & { expectedContentVersion?: string } = {};
    if (this.options.brainDir !== undefined) artOpts.brainDir = this.options.brainDir;
    if (this.options.maxArtifactBytes !== undefined) artOpts.maxBytes = this.options.maxArtifactBytes;
    if (this.options.allowedArtifactExtensions !== undefined) {
      artOpts.allowedExtensions = this.options.allowedArtifactExtensions;
    }
    if (expectedContentVersion !== undefined) artOpts.expectedContentVersion = expectedContentVersion;
    return readAgyArtifact(conversationId, relativePath, artOpts);
  }
}
