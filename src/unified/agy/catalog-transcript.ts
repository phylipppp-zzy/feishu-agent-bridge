import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { createHash, type Hash } from 'node:crypto';
import { join } from 'node:path';
import {
  assertValidConversationId,
  CREATED_AT_HEADER_READ_BYTES,
  decodeCursor,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
  encodeCursor,
  extractAgyUserInput,
  isInside,
  isPlainRecord,
  parseAgyTimestamp,
  parseTimestampMs,
  resolveAgyBrainDirs,
  sha256,
  TERMINAL_STEP_STATUSES,
  type AgyMediaSummary,
  type AgyReadTranscriptOptions,
  type AgyTokenUsage,
  type AgyToolCallSummary,
  type AgyTranscriptMessage,
  type AgyTranscriptReadResult,
  type AgyTranscriptStep,
} from './catalog-types.js';

class FileExceedsMaxBytesError extends Error {
  constructor(
    readonly filePath: string,
    readonly fileSize: number,
    readonly maxBytes: number,
  ) {
    super(`file exceeds max bytes (${fileSize} > ${maxBytes}): ${filePath}`);
    this.name = 'FileExceedsMaxBytesError';
  }
}

class TranscriptShortReadError extends Error {
  constructor(path: string) {
    super(`transcript changed while reading: ${path}`);
  }
}

const BOUNDARY_BYTES = 4096;
const INCOMPLETE_LINE_WARNING = 'transcript has an incomplete trailing JSONL line';

export interface AgyTranscriptCacheEntry {
  compactPath: string;
  compactStat: Stats;
  fullStatSig: string;
  maxBytes: number;
  retainedBytes: number;
  byteOffset: number;
  nextLine: number;
  boundarySha256: string;
  prefixHash: Hash;
  hasUnresolvedTruncatedFields: boolean;
  hasTrailingLineWithoutNewline: boolean;
  dependsOnFullTranscript: boolean;
  result: AgyTranscriptReadResult;
}

async function transcriptStat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function transcriptStatSignature(stat: Stats | null): string {
  return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : '';
}

async function validateTranscriptPath(path: string, root: string, stat: Stats): Promise<string> {
  if (!stat.isFile()) throw new Error(`refusing non-regular or symlinked file: ${path}`);
  const canonicalPath = await realpath(path);
  if (!isInside(canonicalPath, root)) throw new Error(`file escapes allowed root: ${path}`);
  return canonicalPath;
}

async function readTranscriptRange(handle: FileHandle, size: number, start: number, path: string): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, start + offset);
    if (!bytesRead) throw new TranscriptShortReadError(path);
    offset += bytesRead;
  }
  return buffer;
}

async function readTranscriptAppend(
  path: string,
  stat: Stats,
  prior: AgyTranscriptCacheEntry,
): Promise<{ boundary: Buffer; delta: Buffer } | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || transcriptStatSignature(current) !== transcriptStatSignature(stat)) return null;
    const boundaryLength = Math.min(prior.byteOffset, BOUNDARY_BYTES);
    const boundary = await readTranscriptRange(handle, boundaryLength, prior.byteOffset - boundaryLength, path);
    if (sha256(boundary) !== prior.boundarySha256) return null;
    const delta = await readTranscriptRange(handle, stat.size - prior.byteOffset, prior.byteOffset, path);
    if (transcriptStatSignature(await handle.stat()) !== transcriptStatSignature(stat)) return null;
    return { boundary, delta };
  } catch (error) {
    if (error instanceof TranscriptShortReadError) return null;
    throw error;
  } finally {
    await handle.close();
  }
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

export function extractTokenUsage(row: Record<string, unknown>): AgyTokenUsage | null {
  const fields: Array<[string, keyof AgyTokenUsage]> = [
    ['input_tokens', 'inputTokens'],
    ['cache_read_tokens', 'cacheReadTokens'],
    ['output_tokens', 'outputTokens'],
    ['total_tokens', 'totalTokens'],
  ];

  const usage: AgyTokenUsage = {};
  let validCount = 0;

  for (const [rawKey, outKey] of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, rawKey)) continue;
    const rawVal = row[rawKey];
    if (rawVal === undefined || rawVal === null) continue;
    const parsed = nonNegIntOrNull(rawVal);
    if (parsed === null) return null;
    usage[outKey] = parsed;
    validCount += 1;
  }

  if (validCount === 0) return null;

  if (
    usage.totalTokens === undefined &&
    usage.inputTokens !== undefined &&
    usage.cacheReadTokens !== undefined &&
    usage.outputTokens !== undefined
  ) {
    usage.totalTokens = usage.inputTokens + usage.cacheReadTokens + usage.outputTokens;
  }

  return usage;
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
  const info = await transcriptStat(filePath);
  if (!info) return null;
  const canonicalPath = await validateTranscriptPath(filePath, canonicalRoot, info);
  if (info.size > maxBytes) {
    throw new FileExceedsMaxBytesError(filePath, info.size, maxBytes);
  }
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`file invalid: ${filePath}`);
    }
    if (stat.size > maxBytes) {
      throw new FileExceedsMaxBytesError(filePath, stat.size, maxBytes);
    }
    return await readTranscriptRange(handle, stat.size, 0, filePath);
  } finally {
    await handle.close();
  }
}

async function readTailWithinRoot(
  filePath: string,
  canonicalRoot: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; totalSize: number } | null> {
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
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`file invalid: ${filePath}`);
    const toRead = Math.min(stat.size, maxBytes);
    const startOffset = Math.max(0, stat.size - toRead);
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const { bytesRead } = await handle.read(buf, offset, toRead - offset, startOffset + offset);
      if (!bytesRead) throw new Error(`transcript changed while reading: ${filePath}`);
      offset += bytesRead;
    }
    let slice = buf;
    if (startOffset > 0) {
      const firstNewline = slice.indexOf(0x0a);
      slice = firstNewline >= 0 ? slice.subarray(firstNewline + 1) : Buffer.alloc(0);
    }
    return { buffer: slice, totalSize: stat.size };
  } finally {
    await handle.close();
  }
}

async function resolveTranscriptSessionDir(
  conversationId: string,
  options: { brainDir?: string; brainDirs?: readonly string[]; appDataDir?: string },
): Promise<string | null> {
  const brainDirs = resolveAgyBrainDirs(options);
  for (const brainDir of brainDirs) {
    let canonicalBrainDir: string;
    try {
      canonicalBrainDir = await realpath(brainDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const sessionDir = join(canonicalBrainDir, conversationId);
    let sessionInfo;
    try {
      sessionInfo = await lstat(sessionDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (sessionInfo.isSymbolicLink() || !sessionInfo.isDirectory()) {
      throw new Error(`refusing non-directory or symlinked session brain dir: ${sessionDir}`);
    }
    const canonicalSessionDir = await realpath(sessionDir);
    if (!isInside(canonicalSessionDir, canonicalBrainDir)) {
      throw new Error(`session brain dir escapes brainDir: ${sessionDir}`);
    }
    return canonicalSessionDir;
  }
  return null;
}

async function readFileHeaderWithinRoot(
  filePath: string,
  canonicalRoot: string,
  maxHeaderBytes: number,
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
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`file invalid: ${filePath}`);
    const toRead = Math.min(stat.size, maxHeaderBytes);
    if (toRead <= 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const { bytesRead } = await handle.read(buf, offset, toRead - offset, offset);
      if (!bytesRead) throw new Error(`transcript changed while reading: ${filePath}`);
      offset += bytesRead;
    }
    return buf;
  } finally {
    await handle.close();
  }
}

/**
 * Read only the first 8 KiB header of `transcript.jsonl` (or `transcript_full.jsonl`)
 * to extract the initial `created_at` timestamp without loading the whole file.
 */
export async function readAgyTranscriptCreatedAt(
  conversationId: string,
  options: {
    brainDir?: string;
    brainDirs?: readonly string[];
    appDataDir?: string;
    maxHeaderBytes?: number;
  } = {},
): Promise<string | null> {
  assertValidConversationId(conversationId);
  const maxHeaderBytes = options.maxHeaderBytes ?? CREATED_AT_HEADER_READ_BYTES;
  const canonicalSessionDir = await resolveTranscriptSessionDir(conversationId, options);
  if (!canonicalSessionDir) return null;

  const candidates = [
    join(canonicalSessionDir, '.system_generated', 'logs', 'transcript.jsonl'),
    join(canonicalSessionDir, '.system_generated', 'logs', 'transcript_full.jsonl'),
  ];

  let firstReadError: unknown;
  for (const filePath of candidates) {
    let buf: Buffer | null;
    try {
      buf = await readFileHeaderWithinRoot(filePath, canonicalSessionDir, maxHeaderBytes);
    } catch (err) {
      firstReadError ??= err;
      continue;
    }
    if (!buf || buf.length === 0) continue;
    const headerText = buf.toString('utf8');
    const lines = headerText.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainRecord(parsed)) {
          const ts = parseAgyTimestamp(parsed.created_at);
          if (ts) return ts;
        }
      } catch {
        // First line may exceed maxHeaderBytes: fall back to regex extraction of created_at.
        const strMatch = /"created_at"\s*:\s*"([^"]+)"/.exec(trimmed);
        if (strMatch?.[1]) {
          const ts = parseAgyTimestamp(strMatch[1]);
          if (ts) return ts;
        }
        const numMatch = /"created_at"\s*:\s*(\d+(?:\.\d+)?)/.exec(trimmed);
        if (numMatch?.[1]) {
          const ts = parseAgyTimestamp(Number(numMatch[1]));
          if (ts) return ts;
        }
      }
      // Only inspect the first non-empty line for session creation time.
      break;
    }
  }
  if (firstReadError !== undefined) throw firstReadError;
  return null;
}

function splitCompleteJsonlLines(text: string): { lines: string[]; truncatedTrailingLine: boolean; hasTrailingLineWithoutNewline?: true } {
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
      return { lines: rawLines, truncatedTrailingLine: false, hasTrailingLineWithoutNewline: true };
    }
  } catch {
    // Half-written trailing JSONL line during active session flush: leave it for the next read.
  }
  rawLines.pop();
  return { lines: rawLines, truncatedTrailingLine: true };
}

interface FullTranscriptIndex {
  byStepIndex: Map<number, Record<string, unknown>[]>;
  byLine: Array<Record<string, unknown> | null>;
}

function buildFullTranscriptIndex(text: string): FullTranscriptIndex {
  const { lines } = splitCompleteJsonlLines(text);
  const byStepIndex: FullTranscriptIndex['byStepIndex'] = new Map();
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
        if (step !== null) {
          const rows = byStepIndex.get(step);
          if (rows) rows.push(parsed);
          else byStepIndex.set(step, [parsed]);
        }
      } else {
        byLine.push(null);
      }
    } catch {
      byLine.push(null);
    }
  }
  return { byStepIndex, byLine };
}

function hasFullField(candidate: Record<string, unknown>, field: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(candidate, field)) return false;
  if (Array.isArray(candidate.truncated_fields) && candidate.truncated_fields.includes(field)) return false;
  const value = candidate[field];
  if (typeof value === 'string') return value.trim().length > 0;
  if (field === 'content' || field === 'thinking') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainRecord(value)) return Object.keys(value).length > 0;
  return value !== null && value !== undefined;
}

function findFullTranscriptRow(
  index: FullTranscriptIndex,
  row: Record<string, unknown>,
  stepIndex: number | null,
  lineNumber: number | undefined,
  fields: string[],
  createdAt: string | null,
): Record<string, unknown> | undefined {
  const compareMetadataValue = (expected: unknown, actual: unknown) => {
    if (typeof expected !== 'string' || !expected.trim() || typeof actual !== 'string' || !actual.trim()) return 0;
    return actual === expected ? 1 : -1;
  };
  const compareTimestamp = (candidateCreatedAt: unknown) => {
    const raw = compareMetadataValue(row.created_at, candidateCreatedAt);
    if (raw !== 0) return raw;
    if (row.created_at === undefined || row.created_at === null || candidateCreatedAt === undefined || candidateCreatedAt === null) return 0;
    const parsedCandidate = parseAgyTimestamp(candidateCreatedAt);
    if (createdAt && parsedCandidate) return createdAt === parsedCandidate ? 1 : -1;
    return 0;
  };
  const compatible = (candidate: Record<string, unknown>) =>
    (typeof row.type !== 'string' || typeof candidate.type !== 'string' || row.type === candidate.type) &&
    compareTimestamp(candidate.created_at) >= 0;
  const byLine = lineNumber === undefined ? undefined : index.byLine[lineNumber];
  const candidates = stepIndex !== null ? index.byStepIndex.get(stepIndex) ?? [] : byLine ? [byLine] : [];
  const needsContent = fields.includes('content');
  // Reused step indexes can point to distinct replies. Establish the match before considering field coverage.
  const ranked = candidates.filter(compatible).map((candidate, position) => {
    const availableFields = fields.filter(field => hasFullField(candidate, field));
    const hasContent = needsContent && availableFields.includes('content');
    return {
      candidate,
      position,
      timestampMatch: compareTimestamp(candidate.created_at),
      sourceStatusMatch: compareMetadataValue(row.source, candidate.source) +
        compareMetadataValue(row.status, candidate.status),
      typeModelMatch: compareMetadataValue(row.type, candidate.type) +
        compareMetadataValue(row.model, candidate.model),
      completeLineMatch: Number(candidate === byLine && availableFields.length === fields.length),
      hasContent: Number(hasContent),
      fieldCount: availableFields.length,
      contentLength: hasContent && typeof candidate.content === 'string' ? candidate.content.trim().length : 0,
    };
  });
  ranked.sort((a, b) =>
    b.timestampMatch - a.timestampMatch ||
    b.sourceStatusMatch - a.sourceStatusMatch ||
    b.typeModelMatch - a.typeModelMatch ||
    b.completeLineMatch - a.completeLineMatch ||
    b.hasContent - a.hasContent ||
    b.fieldCount - a.fieldCount ||
    b.contentLength - a.contentLength ||
    b.position - a.position,
  );
  return ranked[0]?.candidate;
}

/**
 * Parse Antigravity `transcript.jsonl` (and look up `truncated_fields` from `transcript_full.jsonl` when needed).
 * Supports incremental reads via `cursor`, `afterLine`, or `sinceTimestamp` + `afterStepIndex`.
 */
export async function readAgyTranscript(
  conversationId: string,
  options: AgyReadTranscriptOptions = {},
): Promise<AgyTranscriptReadResult> {
  return readTranscript(conversationId, options);
}

export async function readCachedAgyTranscript(
  conversationId: string,
  options: AgyReadTranscriptOptions,
  cache: Map<string, AgyTranscriptCacheEntry>,
  maxCacheBytes: number,
): Promise<AgyTranscriptReadResult> {
  return readTranscript(conversationId, options, cache, maxCacheBytes);
}

async function readTranscript(
  conversationId: string,
  options: AgyReadTranscriptOptions,
  cache?: Map<string, AgyTranscriptCacheEntry>,
  maxCacheBytes = 0,
): Promise<AgyTranscriptReadResult> {
  assertValidConversationId(conversationId);
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

  const warnings: string[] = [];
  let fullTranscriptSkippedReason: string | null = null;

  const emptyResult = (transcriptPath: string | null, fullPath: string | null, usedFullFallback: boolean): AgyTranscriptReadResult => ({
    conversationId,
    transcriptPath,
    fullTranscriptPath: fullPath,
    usedFullFallback,
    fullTranscriptSkippedReason,
    warnings: [...warnings],
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

  const canonicalSessionDir = await resolveTranscriptSessionDir(conversationId, options);
  if (!canonicalSessionDir) {
    cache?.delete(conversationId);
    if (expectedPrefixDigest !== null && startLine > 0) throw new Error('stale or invalid cursor');
    return emptyResult(null, null, false);
  }

  const compactPath = join(canonicalSessionDir, '.system_generated', 'logs', 'transcript.jsonl');
  const fullPath = join(canonicalSessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');

  const [compactStat, fullStat] = cache
    ? await Promise.all([transcriptStat(compactPath), transcriptStat(fullPath)]) : [null, null];
  const fullStatSig = transcriptStatSignature(fullStat);
  const prior = cache?.get(conversationId);
  let append: Awaited<ReturnType<typeof readTranscriptAppend>> = null;
  if (prior && compactStat && compactStat.size <= maxBytes && prior.compactPath === compactPath &&
      prior.maxBytes === maxBytes && !prior.hasUnresolvedTruncatedFields && !prior.result.usedFullFallback) {
    const fullUnchanged = fullStatSig === prior.fullStatSig;
    if (fullUnchanged && transcriptStatSignature(compactStat) === transcriptStatSignature(prior.compactStat)) {
      await validateTranscriptPath(compactPath, canonicalSessionDir, compactStat);
      if (prior.dependsOnFullTranscript && fullStat) await validateTranscriptPath(fullPath, canonicalSessionDir, fullStat);
      cache?.delete(conversationId);
      cache?.set(conversationId, prior);
      return prior.result;
    }
    // The cached result includes a valid unterminated row. Reparse it with its
    // original prefix if the file changes, as the row may be extended in place.
    if (!prior.hasTrailingLineWithoutNewline && compactStat.dev === prior.compactStat.dev && compactStat.ino === prior.compactStat.ino &&
        compactStat.size > prior.compactStat.size && prior.byteOffset > 0 &&
        (fullUnchanged || !prior.dependsOnFullTranscript)) {
      const path = await validateTranscriptPath(compactPath, canonicalSessionDir, compactStat);
      if (prior.dependsOnFullTranscript && fullStat) await validateTranscriptPath(fullPath, canonicalSessionDir, fullStat);
      append = await readTranscriptAppend(path, compactStat, prior);
    }
  }
  cache?.delete(conversationId);
  const base = append ? prior : undefined;

  let compactBuf: Buffer | null = null;
  let primaryBuf: Buffer | null = null;
  let usedFullFallback = false;
  let primaryTailDegraded = false;
  let fullBufCache: Buffer | null | undefined;

  if (append) {
    compactBuf = append.delta;
  } else {
    try {
      compactBuf = await readRegularFileWithinRoot(compactPath, canonicalSessionDir, maxBytes);
    } catch (err) {
      if (!(err instanceof FileExceedsMaxBytesError)) throw err;
      if (expectedPrefixDigest !== null && startLine > 0) throw new Error('stale or invalid cursor');
      const tail = await readTailWithinRoot(compactPath, canonicalSessionDir, maxBytes);
      compactBuf = tail?.buffer ?? null;
      primaryTailDegraded = true;
      warnings.push(
        `transcript.jsonl exceeds max bytes (${err.fileSize} > ${err.maxBytes}); degraded to tail ${maxBytes} bytes window`,
      );
    }
  }
  primaryBuf = compactBuf;

  if (primaryBuf === null) {
    try {
      fullBufCache = await readRegularFileWithinRoot(fullPath, canonicalSessionDir, maxBytes);
    } catch (err) {
      if (err instanceof FileExceedsMaxBytesError) {
        if (expectedPrefixDigest !== null && startLine > 0) throw new Error('stale or invalid cursor');
        const tail = await readTailWithinRoot(fullPath, canonicalSessionDir, maxBytes);
        fullBufCache = tail?.buffer ?? null;
        primaryTailDegraded = true;
        fullTranscriptSkippedReason = 'full_transcript_exceeds_max_bytes';
        warnings.push(
          `transcript_full.jsonl exceeds max bytes (${err.fileSize} > ${err.maxBytes}); degraded to tail ${maxBytes} bytes window`,
        );
      } else {
        throw err;
      }
    }
    primaryBuf = fullBufCache;
    usedFullFallback = fullBufCache !== null;
  }

  if (primaryBuf === null) {
    if (expectedPrefixDigest !== null && startLine > 0) throw new Error('stale or invalid cursor');
    return emptyResult(null, null, false);
  }

  const cacheable = cache && compactStat && compactBuf && !primaryTailDegraded;
  // Return a complete final record immediately, but keep the append boundary at the last newline.
  const completeEnd = cacheable ? primaryBuf.lastIndexOf(0x0a) + 1 : 0;
  const completeBytes = primaryBuf.subarray(0, completeEnd);
  const { lines, truncatedTrailingLine, hasTrailingLineWithoutNewline } =
    splitCompleteJsonlLines(primaryBuf.toString('utf8'));
  if (primaryTailDegraded && expectedPrefixDigest !== null && startLine > 0) {
    throw new Error('stale or invalid cursor');
  }

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
  if (base?.result.fullTranscriptSkippedReason && fullStat) {
    fullTranscriptSkippedReason = base.result.fullTranscriptSkippedReason;
    warnings.push(
      `transcript_full.jsonl exceeds max bytes (${fullStat.size} > ${maxBytes}); degraded to compact transcript.jsonl`,
    );
    fullIndex = null;
  }
  const loadFullIndex = async (): Promise<FullTranscriptIndex | null> => {
    if (fullIndex !== undefined) return fullIndex;
    if (usedFullFallback) {
      fullIndex = null;
      return null;
    }
    if (fullBufCache === undefined) {
      try {
        fullBufCache = await readRegularFileWithinRoot(fullPath, canonicalSessionDir, maxBytes);
      } catch (err) {
        if (err instanceof FileExceedsMaxBytesError) {
          fullTranscriptSkippedReason = 'full_transcript_exceeds_max_bytes';
          warnings.push(
            `transcript_full.jsonl exceeds max bytes (${err.fileSize} > ${err.maxBytes}); degraded to compact transcript.jsonl`,
          );
          fullBufCache = null;
          fullIndex = null;
          return null;
        }
        throw err;
      }
    }
    fullIndex = fullBufCache ? buildFullTranscriptIndex(fullBufCache.toString('utf8')) : null;
    return fullIndex;
  };

  const steps: AgyTranscriptStep[] = base?.result.steps.slice() ?? [];
  const messages: AgyTranscriptMessage[] = base?.result.messages.slice() ?? [];
  let retainedBytes = cacheable ? compactStat.size + (base ? base.retainedBytes - base.compactStat.size : 0) : 0;
  const messageIndexById = new Map(messages.map((message, index) => [message.messageId, index]));
  let parseErrors = 0;
  let lastCreatedAt: string | null = base?.result.lastCreatedAt ?? carriedCreatedAt;
  let lastStepIndex: number | null = base?.result.lastStepIndex ?? carriedStepIndex;
  let hasUnresolvedTruncatedFields = false;
  let dependsOnFullTranscript = base?.dependsOnFullTranscript ?? false;
  const firstLine = base?.nextLine ?? 0;

  for (let index = startLine; index < lines.length; index++) {
    const lineNumber = firstLine + index;
    const trimmed = lines[index]?.trim() ?? '';
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
    let contentResolvedFromFull = false;
    if (truncatedFields.length > 0 && !usedFullFallback) {
      dependsOnFullTranscript = true;
      const idx = await loadFullIndex();
      const fields = truncatedFields.filter(field =>
        field !== '__proto__' && field !== 'constructor' && field !== 'prototype',
      );
      const candidate = idx && findFullTranscriptRow(
        idx, row, stepIndex, primaryTailDegraded ? undefined : lineNumber, fields, createdAt,
      );
      for (const field of fields) {
        if (candidate && hasFullField(candidate, field)) {
          row[field] = candidate[field];
          resolvedFromFull = true;
          if (field === 'content') contentResolvedFromFull = true;
        } else if (!fullTranscriptSkippedReason) {
          hasUnresolvedTruncatedFields = true;
        }
      }
    }

    const stepType = typeof row.type === 'string' ? row.type : '';
    const source = typeof row.source === 'string' ? row.source : '';
    const status = typeof row.status === 'string' ? row.status : '';
    const model = typeof row.model === 'string' && row.model ? row.model : null;
    // IMPORTANT: PLANNER_RESPONSE stores assistant text in `content`, NOT `text`.
    const content = typeof row.content === 'string' ? row.content : '';
    const contentIncomplete = truncatedFields.includes('content') && !contentResolvedFromFull;
    const messageContent = contentIncomplete ? content.replace(/\s*<truncated \d+ bytes>\s*$/u, '') : content;
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
    if (cacheable) retainedBytes += Buffer.byteLength(JSON.stringify(step));

    if (createdAt) lastCreatedAt = createdAt;
    if (stepIndex !== null) lastStepIndex = stepIndex;

    let msgRole: 'user' | 'assistant' | null = null;
    let msgText = '';
    if (stepType === 'USER_INPUT') {
      msgRole = 'user';
      msgText = extractAgyUserInput(messageContent);
    } else if (stepType === 'PLANNER_RESPONSE') {
      msgRole = 'assistant';
      msgText = messageContent;
    }

    if (msgRole && msgText.trim()) {
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
        final: !contentIncomplete && (status === '' || TERMINAL_STEP_STATUSES.has(status)),
        resolvedFromFull,
      };
      const existingIdx = messageIndexById.get(messageId);
      if (cacheable) {
        retainedBytes += Buffer.byteLength(JSON.stringify(message));
        if (existingIdx !== undefined) retainedBytes -= Buffer.byteLength(JSON.stringify(messages[existingIdx]!));
      }
      if (existingIdx !== undefined) {
        messages[existingIdx] = message;
      } else {
        messageIndexById.set(messageId, messages.length);
        messages.push(message);
      }
    }
  }

  if (parseErrors > 0) {
    warnings.push(`transcript contains ${parseErrors} malformed JSONL line(s)`);
  }
  if (truncatedTrailingLine) {
    warnings.push(INCOMPLETE_LINE_WARNING);
  }

  const nextLine = firstLine + lines.length;
  const prefixHash = base?.prefixHash.copy() ?? createHash('sha256');
  if (firstLine && lines.length) prefixHash.update('\n');
  prefixHash.update(lines.join('\n'));
  const cursor = encodeCursor({
    conversationId,
    line: nextLine,
    lastCreatedAt,
    lastStepIndex,
    prefixDigest: prefixHash.copy().digest('hex'),
  });

  const result: AgyTranscriptReadResult = {
    conversationId,
    transcriptPath: compactBuf ? compactPath : null,
    fullTranscriptPath: usedFullFallback || fullBufCache ? fullPath : base?.result.fullTranscriptPath ?? null,
    usedFullFallback,
    fullTranscriptSkippedReason,
    warnings,
    steps,
    messages,
    nextLine,
    lastCreatedAt,
    lastStepIndex,
    cursor,
    parseErrors,
    truncatedTrailingLine,
  };

  if (cacheable && retainedBytes <= maxCacheBytes) {
    const [currentCompact, currentFull] = await Promise.all([transcriptStat(compactPath), transcriptStat(fullPath)]);
    if (primaryBuf.length + (base?.byteOffset ?? 0) === compactStat.size &&
        transcriptStatSignature(currentCompact) === transcriptStatSignature(compactStat) &&
        transcriptStatSignature(currentFull) === fullStatSig) {
      const retry = hasUnresolvedTruncatedFields || parseErrors > 0;
      const boundary = append?.boundary ?? Buffer.alloc(0);
      const boundarySha256 = retry ? base?.boundarySha256 ?? sha256('') : sha256(Buffer.concat([
        boundary,
        completeBytes.subarray(-BOUNDARY_BYTES),
      ]).subarray(-BOUNDARY_BYTES));
      cache.set(conversationId, {
        compactPath,
        compactStat,
        fullStatSig,
        maxBytes,
        retainedBytes,
        byteOffset: (base?.byteOffset ?? 0) + (retry ? 0 : completeEnd),
        nextLine: retry ? base?.nextLine ?? 0 : nextLine,
        boundarySha256,
        prefixHash: retry ? base?.prefixHash ?? createHash('sha256') : prefixHash,
        hasUnresolvedTruncatedFields: retry,
        hasTrailingLineWithoutNewline: hasTrailingLineWithoutNewline === true,
        dependsOnFullTranscript,
        result,
      });
    }
  }
  return result;
}
