import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
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
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buf, offset, stat.size - offset, offset);
      if (!bytesRead) throw new Error(`transcript changed while reading: ${filePath}`);
      offset += bytesRead;
    }
    return buf;
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
    if (expectedPrefixDigest !== null && startLine > 0) throw new Error('stale or invalid cursor');
    return emptyResult(null, null, false);
  }

  const compactPath = join(canonicalSessionDir, '.system_generated', 'logs', 'transcript.jsonl');
  const fullPath = join(canonicalSessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');

  let compactBuf: Buffer | null = null;
  let primaryBuf: Buffer | null = null;
  let usedFullFallback = false;
  let primaryTailDegraded = false;
  let fullBufCache: Buffer | null | undefined;

  try {
    compactBuf = await readRegularFileWithinRoot(compactPath, canonicalSessionDir, maxBytes);
  } catch (err) {
    if (err instanceof FileExceedsMaxBytesError) {
      if (expectedPrefixDigest !== null && startLine > 0) throw new Error('stale or invalid cursor');
      const tail = await readTailWithinRoot(compactPath, canonicalSessionDir, maxBytes);
      compactBuf = tail?.buffer ?? null;
      primaryTailDegraded = true;
      warnings.push(
        `transcript.jsonl exceeds max bytes (${err.fileSize} > ${err.maxBytes}); degraded to tail ${maxBytes} bytes window`,
      );
    } else {
      throw err;
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

  const primaryText = primaryBuf.toString('utf8');
  const { lines, truncatedTrailingLine } = splitCompleteJsonlLines(primaryText);
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
    let contentResolvedFromFull = false;
    if (truncatedFields.length > 0 && !usedFullFallback) {
      const idx = await loadFullIndex();
      if (idx) {
        const fields = truncatedFields.filter(field =>
          field !== '__proto__' && field !== 'constructor' && field !== 'prototype',
        );
        const candidate = findFullTranscriptRow(
          idx, row, stepIndex, primaryTailDegraded ? undefined : lineNumber, fields, createdAt,
        );
        if (candidate) {
          for (const field of fields) {
            if (hasFullField(candidate, field)) {
              row[field] = candidate[field];
              resolvedFromFull = true;
              if (field === 'content') contentResolvedFromFull = true;
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
    warnings.push('transcript has an incomplete trailing JSONL line');
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
}
