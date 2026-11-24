import { constants, existsSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertValidConversationId,
  decodeCursor,
  DEFAULT_AGY_BRAIN_DIR,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
  encodeCursor,
  expandHomePath,
  extractAgyUserInput,
  isInside,
  isPlainRecord,
  parseAgyTimestamp,
  parseTimestampMs,
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
    let contentResolvedFromFull = false;
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
            if (
              field !== '__proto__' &&
              field !== 'constructor' &&
              field !== 'prototype' &&
              Object.prototype.hasOwnProperty.call(candidate, field) &&
              candidate[field] !== undefined
            ) {
              row[field] = candidate[field];
              resolvedFromFull = true;
              if (field === 'content' && typeof candidate[field] === 'string') contentResolvedFromFull = true;
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
