import type { Provider } from './contracts.js';
import type { ChannelCardTagColor } from './feishu-cards.js';
import { readSafeTranscriptTail } from './agy/catalog-summaries.js';
import { isPlainRecord } from './agy/catalog-types.js';

export interface ContextUsageInfo {
  usedTokens: number;
  maxTokens: number;
  model?: string | null;
}

export interface CompactTurnInfo {
  isCompact: boolean;
  beforeTokens?: number | null;
  afterTokens?: number | null;
  maxTokens?: number | null;
}

const AGY_CONTEXT_TAIL_BYTES = 512 * 1024;
const ONE_MILLION_BINARY = 1_048_576;

/**
 * Resolve maximum context window in tokens for a given model/provider.
 * Kept aligned with AGY context panel analyzer limits.
 */
export function resolveModelMaxContextTokens(model?: string | null, provider?: Provider): number {
  const lower = (model ?? '').trim().toLowerCase();
  if (lower) {
    if (lower.includes('gemini-4') || /\b(carbon|neon|hydrogen|argon)\b/.test(lower)) {
      return ONE_MILLION_BINARY;
    }
    if (/claude[-_ ]?(?:opus|sonnet)[-_ ]?(?:5|4[-._]6)/.test(lower)) {
      return ONE_MILLION_BINARY;
    }
    if (lower.includes('claude')) {
      return 200_000;
    }
    if (lower.includes('gpt-oss')) {
      return 131_072;
    }
    if (/gpt-(?:5|6)/.test(lower) || /\b(sol|astra|luna)\b/.test(lower)) {
      return 272_000;
    }
    if (lower.includes('gemini-3') || lower.includes('gemini-2')) {
      return ONE_MILLION_BINARY;
    }
  }
  if (provider === 'agy') return ONE_MILLION_BINARY;
  if (provider === 'codex') return 272_000;
  return 200_000;
}

export function formatCompactTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens === ONE_MILLION_BINARY || tokens === 1_000_000) return '1M';
  if (tokens >= 1_000_000) {
    const val = (tokens / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `${val}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(Math.round(tokens));
}

export function formatContextUsageBadge(
  usage?: ContextUsageInfo | null,
): { text: string; pct: number; color: ChannelCardTagColor } | null {
  if (!usage || !Number.isFinite(usage.usedTokens) || !Number.isFinite(usage.maxTokens) || usage.maxTokens <= 0) {
    return null;
  }
  const used = Math.max(0, Math.round(usage.usedTokens));
  const max = Math.max(1, Math.round(usage.maxTokens));
  const pct = Math.min(100, Math.round((used / max) * 100));
  const color: ChannelCardTagColor = pct >= 92 ? 'red' : pct >= 80 ? 'orange' : 'wathet';
  return {
    text: `${formatCompactTokenCount(used)} / ${formatCompactTokenCount(max)} (${pct}%)`,
    pct,
    color,
  };
}

/**
 * Format a compact, always-visible status banner line for turn cards so users
 * can monitor live context growth during running turns and decide when to /compact.
 */
export function formatContextStatusLine(
  usage?: ContextUsageInfo | null,
  options?: { modelBadge?: string | null },
): string | null {
  const badge = formatContextUsageBadge(usage);
  if (!badge) return null;
  const slots = 10;
  const filled = Math.max(0, Math.min(slots, Math.round((badge.pct / 100) * slots)));
  const bar = '▓'.repeat(filled) + '░'.repeat(slots - filled);
  const icon = badge.pct >= 92 ? '🔴' : badge.pct >= 80 ? '🟠' : badge.pct >= 65 ? '🟡' : '🟢';
  const hint = badge.pct >= 92
    ? ' · 接近上限，建议立即压缩'
    : badge.pct >= 80
      ? ' · 建议压缩'
      : '';
  const model = options?.modelBadge?.trim();
  const modelSuffix = model ? ` · 模型 \`${model}\`` : '';
  return `${icon} 上下文：\`${badge.text}\` \`${bar}\`${hint}${modelSuffix}`;
}

function safePositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Extract the latest AGY context usage from transcript rows.
 * Note: In AGY transcript.jsonl, `input_tokens` excludes `cache_read_tokens`,
 * so active context length is `input_tokens + cache_read_tokens + output_tokens`.
 */
export function extractAgyContextUsageFromRows(
  rows: readonly Record<string, unknown>[],
): ContextUsageInfo | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const input = safePositiveInt(row.input_tokens);
    const cacheRead = safePositiveInt(row.cache_read_tokens);
    const output = safePositiveInt(row.output_tokens);
    const usedTokens = input + cacheRead + output;
    if (usedTokens <= 0) continue;
    const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null;
    return {
      usedTokens,
      maxTokens: resolveModelMaxContextTokens(model, 'agy'),
      ...(model ? { model } : {}),
    };
  }
  return null;
}

export function readAgyContextUsage(
  conversationId: string,
  options: { brainDir?: string; brainDirs?: readonly string[]; appDataDir?: string } = {},
): ContextUsageInfo | null {
  const text = readSafeTranscriptTail(conversationId, AGY_CONTEXT_TAIL_BYTES, options);
  if (!text) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isPlainRecord(parsed)) rows.push(parsed);
    } catch {
      // Ignore partial trailing line while AGY CLI is writing.
    }
  }
  return extractAgyContextUsageFromRows(rows);
}
