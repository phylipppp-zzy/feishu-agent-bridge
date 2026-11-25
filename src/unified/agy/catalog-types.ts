import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DEFAULT_AGY_SUMMARIES_DB_PATH = join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
export const DEFAULT_AGY_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain');
export const DEFAULT_AGY_IDE_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity', 'brain');
export const CREATED_AT_HEADER_READ_BYTES = 8 * 1024;

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
  '.json',
  '.py',
  '.sh',
  '.tex',
  '.svg',
  '.yaml',
  '.yml',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
]);

export const ACTIVE_CASCADE_STATUSES = new Set([
  'CASCADE_RUN_STATUS_RUNNING',
  'CASCADE_RUN_STATUS_BUSY',
  'CASCADE_RUN_STATUS_CANCELING',
]);

export const TERMINAL_STEP_STATUSES = new Set([
  'DONE',
  'ERROR',
  'CANCELED',
  'CLEARED',
  'HALTED',
  'INTERRUPTED',
  'INVALID',
]);

export const SECRET_FILENAME_RE =
  /^\.env(?:\..*)?$|^\.(?:netrc|npmrc|pypirc|git-credentials)$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|\.(?:pem|key|p12|pfx|jks|keystore|kdbx|p8|ovpn)$|secret|credential|passw|(?:^|[-_.])(?:private[-_]?key|api[-_]?key|auth[-_]?token|access[-_]?token|oauth[-_]?creds)(?:[-_.]|$)/i;

export const SIDECAR_FILENAME_RE = /(?:\.metadata\.json|\.resolved(?:\.[^/]+)?|\.url\.json)$/i;
export const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g;
export const ALL_CONTROL_CHARS_RE = /[\x00-\x1f\x7f]+/g;
export const CONVERSATION_ID_RE = /^[a-zA-Z0-9._-]+$/;

export const HOST_INJECTION_TAGS = [
  'ADDITIONAL_METADATA',
  'USER_SETTINGS_CHANGE',
  'SYSTEM_MESSAGE',
  'COMPACTED_HISTORY',
  'CONTEXT_SUMMARY',
  'SUBAGENT',
] as const;

export const SYSTEM_MESSAGE_PREAMBLE_RE =
  /The following is a <SYSTEM_MESSAGE> not actually sent by the user\. It is provided by the system as important information to pay attention to\.\s*/gi;

export const MEDIA_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.tex': 'application/x-tex',
  '.svg': 'image/svg+xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export const MAX_ARTIFACT_SCAN_DEPTH = 16;
export const MAX_ARTIFACT_SCAN_ENTRIES = 10_000;
export const DEFAULT_MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_TITLE_LENGTH = 80;
export const TITLE_TRANSCRIPT_READ_BYTES = 16 * 1024;

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

export type AgyCreatedAtSource = 'transcript' | 'unknown';

export interface AgyCreatedAtInfo {
  createdAt: string | null;
  source: AgyCreatedAtSource;
}

export interface AgyTokenUsage {
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
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
  fullTranscriptSkippedReason?: string | null;
  warnings?: string[];
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
  brainDirs?: readonly string[];
  allowedProjectRoots?: readonly string[];
  outputRoots?: readonly string[];
  allowedSymlinkRoots?: readonly string[];
  includeOutsideRoots?: boolean;
  maxTitleLength?: number;
  maxTranscriptBytes?: number;
  maxArtifactBytes?: number;
  allowedArtifactExtensions?: readonly string[];
}

export interface AgyReadTranscriptOptions {
  brainDir?: string;
  brainDirs?: readonly string[];
  appDataDir?: string;
  afterLine?: number;
  sinceTimestamp?: string | number;
  afterStepIndex?: number;
  cursor?: string;
  maxBytes?: number;
}

export interface AgyArtifactOptions {
  brainDir?: string;
  brainDirs?: readonly string[];
  appDataDir?: string;
  maxBytes?: number;
  allowedExtensions?: readonly string[];
  includeScratch?: boolean;
  allowedSymlinkRoots?: readonly string[];
}

/**
 * Resolve candidate brain directories ordered by `appDataDir` preference.
 * When neither `brainDir` nor `brainDirs` is explicitly specified, includes both
 * `~/.gemini/antigravity-cli/brain` and `~/.gemini/antigravity/brain`.
 */
export function resolveAgyBrainDirs(options?: {
  brainDir?: string;
  brainDirs?: readonly string[];
  appDataDir?: string;
}): string[] {
  const candidates: string[] = [];
  const pushUnique = (dir: string | undefined): void => {
    if (typeof dir !== 'string' || !dir.trim()) return;
    const resolved = resolve(expandHomePath(dir.trim()));
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  const hasExplicit = Boolean(options?.brainDir?.trim()) || Boolean(options?.brainDirs?.length);
  if (hasExplicit) {
    if (options?.brainDir) pushUnique(options.brainDir);
    if (options?.brainDirs) {
      for (const dir of options.brainDirs) pushUnique(dir);
    }
  } else {
    pushUnique(DEFAULT_AGY_BRAIN_DIR);
    pushUnique(DEFAULT_AGY_IDE_BRAIN_DIR);
  }

  const appDataDir = options?.appDataDir?.trim();
  if (appDataDir && candidates.length > 1) {
    const normalizedApp = isAbsolute(appDataDir) ? resolve(appDataDir) : appDataDir;
    candidates.sort((a, b) => {
      const aMatch =
        (isAbsolute(normalizedApp) && (a === join(normalizedApp, 'brain') || dirname(a) === normalizedApp)) ||
        basename(dirname(a)) === normalizedApp;
      const bMatch =
        (isAbsolute(normalizedApp) && (b === join(normalizedApp, 'brain') || dirname(b) === normalizedApp)) ||
        basename(dirname(b)) === normalizedApp;
      if (aMatch === bMatch) return 0;
      return aMatch ? -1 : 1;
    });
  }

  return candidates;
}

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function expandHomePath(target: string): string {
  if (target === '~') return homedir();
  if (target.startsWith('~/')) return join(homedir(), target.slice(2));
  return target;
}

/**
 * Canonicalize a path for containment checks even if leaf segments do not yet exist on disk,
 * while resolving all existing ancestor symlinks via realpathSync.
 */
export function canonicalizePath(targetPath: string): string {
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

export function assertValidConversationId(conversationId: string): string {
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

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, unknown> {
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

export function parseTimestampMs(raw: unknown): number | null {
  const iso = parseAgyTimestamp(raw);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function stripHostInjectionBlocks(text: string): string {
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
