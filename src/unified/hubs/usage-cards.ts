import {
  escapeCardMarkdown,
  encodeCard,
} from '../feishu-card-wire.js';
import type {
  ChannelCard,
  ChannelCardAction,
  ChannelCardHeaderTag,
  ChannelCardSection,
} from '../feishu-cards.js';

export type UsageRange = 'today' | 'd7' | 'd30';

export interface UsageBucket {
  requests?: number;
  input?: number;
  output?: number;
  cached?: number;
  cache_write?: number;
  reasoning?: number;
  total_tokens?: number;
  cache_hit_ratio?: number | null;
  cost_usd?: number;
}

export interface UsageQuotaWindow {
  group?: string;
  label?: string;
  window_type?: string;
  remaining_percent?: number | null;
  used_percent?: number | null;
  resets_at?: string | null;
}

export interface UsageBackendQuota {
  stale?: boolean;
  snapshot_at?: string | null;
  windows?: readonly UsageQuotaWindow[];
  cycle_reset?: string | null;
  cycle_rule?: string | null;
}

export interface UsageModelRow {
  model: string;
  requests?: number;
  input?: number;
  output?: number;
  cached?: number;
  cache_write?: number;
  reasoning?: number;
  total_tokens?: number;
  cache_hit_ratio?: number | null;
  cost_usd?: number;
}

export interface UsageBackendEntry {
  id: string;
  name: string;
  status?: string;
  quota?: UsageBackendQuota;
  today?: UsageBucket;
  yesterday?: UsageBucket;
  d7?: UsageBucket;
  d30?: UsageBucket;
  models_today?: readonly UsageModelRow[];
  models_7d?: readonly UsageModelRow[];
  models_30d?: readonly UsageModelRow[];
}

export interface UsageClaudeCycleModel {
  model: string;
  requests?: number;
  total_tokens?: number;
  local_cost_usd?: number | null;
  site_cost_usd?: number | null;
}

export interface UsageClaudeCycle {
  period: string;
  partial?: boolean;
  current?: boolean;
  total_requests?: number;
  total_tokens?: number;
  local_cost_usd?: number | null;
  site_cost_usd?: number | null;
  models?: readonly UsageClaudeCycleModel[];
}

export interface UsageDashboardPayload {
  schema_version?: number;
  generated_at?: string;
  refresh_interval_seconds?: number;
  summary?: Partial<Record<'today' | 'yesterday' | 'd7' | 'd30', UsageBucket>>;
  backends?: readonly UsageBackendEntry[];
  claude_cycles?: readonly UsageClaudeCycle[];
}

export interface RenderUsageCardOptions {
  range?: UsageRange;
  nowMs?: number;
  sourceNote?: string;
  webUrl?: string;
}

export const DEFAULT_USAGE_WEB_URL = 'https://phylipppp-zzy.github.io/usage/';

const RANGE_LABELS: Record<UsageRange, string> = {
  today: '今日',
  d7: '近 7 天',
  d30: '近 30 天',
};

function fmtUsd(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '--';
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n >= 1000) {
    return (
      '$' +
      n.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  return '$' + n.toFixed(2);
}

function fmtTokens(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '--';
  if (n < 1000) return String(Math.round(n));
  const units: ReadonlyArray<readonly [string, number]> = [
    ['B', 1e9],
    ['M', 1e6],
    ['K', 1e3],
  ];
  for (const [u, s] of units) {
    if (n >= s) {
      const val = (n / s).toFixed(n / s >= 100 ? 0 : 1).replace(/\.0$/, '');
      return val + u;
    }
  }
  return String(Math.round(n));
}

function fmtInt(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '--';
}

function fmtRatioPct(ratio: unknown): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return '--';
  return (Number(ratio) * 100).toFixed(1) + '%';
}

function fmtPercentValue(pct: unknown): string {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return '--';
  const clamped = Math.max(0, Math.min(100, Number(pct)));
  return (clamped >= 100 ? '100' : clamped.toFixed(1).replace(/\.0$/, '')) + '%';
}

function fmtBjTime(iso: string | null | undefined, withDate = true): string {
  if (!iso) return '未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知';
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    ...(withDate ? { month: '2-digit', day: '2-digit' } : {}),
  };
  return new Intl.DateTimeFormat('zh-CN', opts).format(d).replace(/\//g, '-');
}

function fmtCompactCountdown(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '满额 / 无窗口';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '未知';
  const diffSec = Math.floor((target - nowMs) / 1000);
  if (diffSec <= 0) return '即将重置';
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h 后重置`;
  if (hours > 0) return `${hours}h ${mins}m 后重置`;
  return `${Math.max(1, mins)}m 后重置`;
}

function renderProgressBar10(remainingPercent: number | null | undefined): string {
  if (remainingPercent === null || remainingPercent === undefined || !Number.isFinite(Number(remainingPercent))) {
    return '░░░░░░░░░░';
  }
  const clamped = Math.max(0, Math.min(100, Number(remainingPercent)));
  const filled = Math.max(0, Math.min(10, Math.round(clamped / 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function buildUsageCardActions(range: UsageRange, webUrl: string): ChannelCardAction[] {
  return [
    {
      label: '🔄 立即刷新',
      value: { action: 'usage_report', trigger: 'card' },
    },
    {
      label: range === 'today' ? '✓ 今日' : '今日',
      value: { action: 'usage_report', trigger: 'card', range: 'today' },
      ...(range === 'today' ? { type: 'primary' as const } : {}),
    },
    {
      label: range === 'd7' ? '✓ 7 天' : '7 天',
      value: { action: 'usage_report', trigger: 'card', range: 'd7' },
      ...(range === 'd7' ? { type: 'primary' as const } : {}),
    },
    {
      label: range === 'd30' ? '✓ 30 天' : '30 天',
      value: { action: 'usage_report', trigger: 'card', range: 'd30' },
      ...(range === 'd30' ? { type: 'primary' as const } : {}),
    },
    {
      label: '🌐 网页看板',
      value: {},
      url: webUrl,
    },
  ];
}

function formatClaudeCycleSummary(cycles: readonly UsageClaudeCycle[], limit: number): string[] {
  if (!cycles.length || limit <= 0) return [];
  const ordered = [...cycles].reverse().slice(0, limit);
  const lines: string[] = ['**Claude 近期计费周期**'];
  for (const c of ordered) {
    const statusLabel = c.current ? '当前周期' : c.partial ? '部分记录' : '完整周期';
    const sitePart =
      c.site_cost_usd !== null && c.site_cost_usd !== undefined ? ` / 网站 ${fmtUsd(c.site_cost_usd)}` : '';
    const topModels = (c.models ?? [])
      .slice(0, 3)
      .map((m) => `${escapeCardMarkdown(m.model)} ${fmtUsd(m.site_cost_usd ?? m.local_cost_usd ?? 0)}`)
      .join('、');
    lines.push(
      `• **${escapeCardMarkdown(c.period)}**（${statusLabel}）：本机 ${fmtUsd(c.local_cost_usd)}${sitePart} · ${fmtTokens(c.total_tokens)} tok${topModels ? `（${topModels}）` : ''}`,
    );
  }
  return lines;
}

export function renderUsageDashboardCard(
  data: UsageDashboardPayload | null,
  options?: RenderUsageCardOptions,
): ChannelCard {
  const range: UsageRange = options?.range ?? 'today';
  const rangeLabel = RANGE_LABELS[range];
  const nowMs = options?.nowMs ?? Date.now();
  const webUrl = options?.webUrl?.trim() || DEFAULT_USAGE_WEB_URL;
  const sourceSuffix = options?.sourceNote?.trim() ? ` · ${options.sourceNote.trim()}` : '';
  const actions = buildUsageCardActions(range, webUrl);
  const title = `📊 AI 用量与额度看板 · ${rangeLabel}`;

  if (!data || (!data.summary && !(data.backends && data.backends.length > 0))) {
    const missingText =
      '当前尚未读取到有效的本地用量快照数据。请点击下方「🔄 立即刷新」或在群内发送任意消息触发实时采集。';
    return {
      schema: '2.0',
      template: 'grey',
      title,
      subtitle: `暂无可用快照${sourceSuffix} · 每小时自动播报 / 发消息即时刷新`,
      headerTags: [{ text: '快照缺失', color: 'neutral' }],
      sections: [
        { text: missingText },
        { dividerBefore: true, actions },
      ],
      text: missingText,
      actions,
    };
  }

  const backends = data.backends ?? [];
  const allWindowPercents: number[] = [];
  for (const b of backends) {
    for (const w of b.quota?.windows ?? []) {
      if (w.remaining_percent !== null && w.remaining_percent !== undefined && Number.isFinite(Number(w.remaining_percent))) {
        allWindowPercents.push(Number(w.remaining_percent));
      }
    }
  }
  const minRemaining = allWindowPercents.length > 0 ? Math.min(...allWindowPercents) : null;

  const template: NonNullable<ChannelCard['template']> =
    minRemaining !== null && minRemaining < 15
      ? 'red'
      : minRemaining !== null && minRemaining < 35
        ? 'orange'
        : 'blue';

  const genMs = data.generated_at ? Date.parse(data.generated_at) : Number.NaN;
  const ageMinutes = Number.isFinite(genMs) ? Math.max(0, Math.floor((nowMs - genMs) / 60_000)) : Number.POSITIVE_INFINITY;
  const headerTags: ChannelCardHeaderTag[] = [
    ageMinutes <= 20
      ? { text: '实时同步', color: 'green' }
      : ageMinutes <= 60
        ? { text: '稍有延迟', color: 'orange' }
        : { text: '快照滞后', color: 'red' },
  ];
  if (minRemaining !== null && minRemaining < 35) {
    headerTags.push({
      text: minRemaining < 15 ? `额度告急 ${fmtPercentValue(minRemaining)}` : `额度预警 ${fmtPercentValue(minRemaining)}`,
      color: minRemaining < 15 ? 'red' : 'orange',
    });
  }

  const bjUpdated = fmtBjTime(data.generated_at, true);
  const subtitle = `更新于 ${bjUpdated} 北京${sourceSuffix} · 每小时自动播报 / 发消息即时刷新`;

  // Section 1: 消耗总览
  const summary = data.summary ?? {};
  const cur = summary[range] ?? {};
  const yesterday = summary.yesterday ?? {};
  let compareNote = '';
  if (range === 'today') {
    const yCost = Number(yesterday.cost_usd ?? 0);
    const tCost = Number(cur.cost_usd ?? 0);
    if (yCost > 0) {
      const diff = ((tCost - yCost) / yCost) * 100;
      const sign = diff >= 0 ? '+' : '';
      compareNote = `（较昨日 ${fmtUsd(yCost)} ${sign}${diff.toFixed(0)}%）`;
    } else {
      compareNote = `（昨日 ${fmtUsd(yCost)}）`;
    }
  } else if (range === 'd7') {
    compareNote = `（日均 ${fmtUsd(Number(cur.cost_usd ?? 0) / 7)}）`;
  } else {
    compareNote = `（日均 ${fmtUsd(Number(cur.cost_usd ?? 0) / 30)}）`;
  }

  const defaultBackendOrder: ReadonlyArray<{ id: string; fallbackName: string }> = [
    { id: 'codex', fallbackName: 'Codex' },
    { id: 'antigravity', fallbackName: 'Antigravity' },
    { id: 'claude', fallbackName: 'Claude' },
  ];
  const backendMap = new Map(backends.map((b) => [b.id, b]));
  const orderedBackends: Array<{ id: string; name: string; entry?: UsageBackendEntry }> = defaultBackendOrder.map(
    ({ id, fallbackName }) => {
      const entry = backendMap.get(id);
      return { id, name: entry?.name || fallbackName, ...(entry ? { entry } : {}) };
    },
  );
  for (const b of backends) {
    if (!defaultBackendOrder.some((d) => d.id === b.id)) {
      orderedBackends.push({ id: b.id, name: b.name || b.id, entry: b });
    }
  }

  const totalBackendCost = orderedBackends.reduce(
    (sum, item) => sum + Number(item.entry?.[range]?.cost_usd ?? 0),
    0,
  );
  const backendParts = orderedBackends.map((item) => {
    const cost = Number(item.entry?.[range]?.cost_usd ?? 0);
    const pct = totalBackendCost > 0 ? (cost / totalBackendCost) * 100 : 0;
    return `${escapeCardMarkdown(item.name)} **${fmtUsd(cost)}** (${pct.toFixed(0)}%)`;
  });

  const modelKey: 'models_today' | 'models_7d' | 'models_30d' =
    range === 'today' ? 'models_today' : range === 'd7' ? 'models_7d' : 'models_30d';
  const activeModelSet = new Set<string>();
  const mergedModels: Array<UsageModelRow & { backendId: string; backendName: string }> = [];
  for (const b of backends) {
    for (const m of b[modelKey] ?? []) {
      const active = Number(m.requests ?? 0) > 0 || Number(m.total_tokens ?? 0) > 0 || Number(m.cost_usd ?? 0) > 0;
      if (active) {
        activeModelSet.add(`${b.id}:${m.model}`);
        mergedModels.push({
          ...m,
          backendId: b.id,
          backendName: b.name || b.id,
        });
      }
    }
  }

  const section1Lines = [
    `💰 **${rangeLabel}总估算费用**：**${fmtUsd(cur.cost_usd)}** ${compareNote}`.trim(),
    backendParts.join(' · '),
    `总 Token **${fmtTokens(cur.total_tokens)}**（输出 ${fmtTokens(cur.output)}） · 缓存命中率 **${fmtRatioPct(cur.cache_hit_ratio)}**（复用 ${fmtTokens(cur.cached)}） · 调用 **${fmtInt(cur.requests)} 次**（${activeModelSet.size} 个活跃模型）`,
  ];
  const section1Text = section1Lines.join('\n');

  // Section 2: 实时额度仪表盘
  const quotaLines: string[] = ['⏱️ **实时额度仪表盘**'];
  for (const b of backends) {
    const wins = b.quota?.windows ?? [];
    if (wins.length > 0) {
      for (const w of wins) {
        const rem =
          w.remaining_percent !== null && w.remaining_percent !== undefined && Number.isFinite(Number(w.remaining_percent))
            ? Number(w.remaining_percent)
            : null;
        const dot = rem === null ? '⚪' : rem < 15 ? '🔴' : rem < 35 ? '🟡' : '🟢';
        const rawLabel = w.label?.trim() || b.name || b.id;
        const winTitle =
          b.id === 'codex' && !/^codex\b/iu.test(rawLabel) ? `Codex ${rawLabel}` : rawLabel;
        const bar = renderProgressBar10(rem);
        const countdown = fmtCompactCountdown(w.resets_at, nowMs);
        const resetBj = w.resets_at ? fmtBjTime(w.resets_at, true) : '';
        const resetSuffix = resetBj && resetBj !== '未知' ? `（${resetBj}）` : '';
        quotaLines.push(
          `${dot} **${escapeCardMarkdown(winTitle)}** \`${bar}\` **${fmtPercentValue(rem)}** 剩余 · ${countdown}${resetSuffix}`,
        );
      }
    } else {
      const cycleReset = b.quota?.cycle_reset;
      const resetPart = cycleReset
        ? `${fmtCompactCountdown(cycleReset, nowMs)}（${fmtBjTime(cycleReset, true)}）`
        : b.quota?.cycle_rule
          ? escapeCardMarkdown(b.quota.cycle_rule)
          : '仅本地统计';
      quotaLines.push(`🟠 **${escapeCardMarkdown(b.name || b.id)}** · 在线未连通 · ${resetPart}`);
    }
  }
  const crossPeriodLine =
    range === 'today'
      ? `近 7 天合计 ${fmtUsd(summary.d7?.cost_usd)} · 近 30 天合计 ${fmtUsd(summary.d30?.cost_usd)}`
      : range === 'd7'
        ? `今日合计 ${fmtUsd(summary.today?.cost_usd)} · 近 30 天合计 ${fmtUsd(summary.d30?.cost_usd)}`
        : `今日合计 ${fmtUsd(summary.today?.cost_usd)} · 近 7 天合计 ${fmtUsd(summary.d7?.cost_usd)}`;
  quotaLines.push(`📌 ${crossPeriodLine}`);
  const section2Text = quotaLines.join('\n');

  // Section 3: 模型消耗排行 & 详情折叠
  mergedModels.sort(
    (a, b) =>
      Number(b.cost_usd ?? 0) - Number(a.cost_usd ?? 0) ||
      Number(b.total_tokens ?? 0) - Number(a.total_tokens ?? 0) ||
      Number(b.requests ?? 0) - Number(a.requests ?? 0),
  );

  const buildSection3Text = (extraModelCap: number, cycleCap: number): string => {
    const topModels = mergedModels.slice(0, 5);
    const restModels = mergedModels.slice(5, 5 + extraModelCap);
    const lines: string[] = [`🏆 **模型消耗排行（${rangeLabel}）**`];
    if (topModels.length === 0) {
      lines.push('当前范围内暂无活跃模型调用记录。');
    } else {
      for (const [idx, m] of topModels.entries()) {
        lines.push(
          `${idx + 1}. **${escapeCardMarkdown(m.model)}** (${escapeCardMarkdown(m.backendName)}) — **${fmtUsd(m.cost_usd)}** · ${fmtTokens(m.total_tokens)} tok · ${fmtInt(m.requests)} 次 · 缓存 ${fmtRatioPct(m.cache_hit_ratio)}`,
        );
      }
    }

    const detailBlocks: string[] = [];
    if (restModels.length > 0) {
      const moreLines = ['**其余活跃模型**'];
      for (const [offset, m] of restModels.entries()) {
        moreLines.push(
          `${6 + offset}. **${escapeCardMarkdown(m.model)}** (${escapeCardMarkdown(m.backendName)}) — **${fmtUsd(m.cost_usd)}** · ${fmtTokens(m.total_tokens)} tok · ${fmtInt(m.requests)} 次 · 缓存 ${fmtRatioPct(m.cache_hit_ratio)}`,
        );
      }
      if (mergedModels.length > 5 + extraModelCap) {
        moreLines.push(`…另有 ${mergedModels.length - (5 + extraModelCap)} 个低消耗模型详见网页看板`);
      }
      detailBlocks.push(moreLines.join('\n'));
    }
    const cycleLines = formatClaudeCycleSummary(data.claude_cycles ?? [], cycleCap);
    if (cycleLines.length > 0) {
      detailBlocks.push(cycleLines.join('\n'));
    }

    if (detailBlocks.length > 0) {
      lines.push(
        `<details><summary>展开更多活跃模型与 Claude 周期明细</summary>\n${detailBlocks.join('\n\n')}\n</details>`,
      );
    }
    return lines.join('\n');
  };

  let section3Text = buildSection3Text(12, 3);
  const buildCandidateCard = (sec3: string): ChannelCard => {
    const sections: ChannelCardSection[] = [
      { text: section1Text },
      { dividerBefore: true, text: section2Text },
      { dividerBefore: true, text: sec3 },
      { dividerBefore: true, actions },
    ];
    return {
      schema: '2.0',
      template,
      title,
      subtitle,
      headerTags,
      sections,
      text: [section1Text, section2Text, sec3].join('\n\n'),
      actions,
    };
  };

  let card = buildCandidateCard(section3Text);
  if (Buffer.byteLength(JSON.stringify(encodeCard(card)), 'utf8') > 24_000) {
    section3Text = buildSection3Text(4, 2);
    card = buildCandidateCard(section3Text);
  }
  if (Buffer.byteLength(JSON.stringify(encodeCard(card)), 'utf8') > 24_000) {
    section3Text = buildSection3Text(0, 1);
    card = buildCandidateCard(section3Text);
  }

  return card;
}
