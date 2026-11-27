#!/usr/bin/env node
// Gate 3A: Validates unified bridge cards (including delegated subagent/Codex MCP running cards,
// long interim text + panel cards, AGY CLI waiting reminder cards, and withdrawn cards) against
// Feishu's real CardKit v1 API (`cardkit.v1.card.create`) without posting any message to any chat.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { parseEnvironment } from '../dist/src/installer.js';
import { installSafeLogging } from '../dist/src/safe-log.js';
import { encodeCard } from '../dist/src/unified/feishu-card-wire.js';
import { packCardCallbacks } from '../dist/src/unified/feishu-callback-values.js';
import { turnProgressCard } from '../dist/src/unified/turn-progress-card.js';
import { summarizeTool } from '../dist/src/unified/tool-progress.js';
import { renderPendingItemCard } from '../dist/src/unified/hubs/pending-cards.js';
import { renderUsageDashboardCard } from '../dist/src/unified/hubs/usage-cards.js';
import { sessionCard } from '../dist/src/unified/feishu-cards.js';
import { sessionListCard } from '../dist/src/unified/session-list-card.js';
import { topicRootCard } from '../dist/src/unified/topic-title-sync.js';

async function readEnv() {
  for (const name of ['feishu-claude-bridge', 'feishu-codex-bridge']) {
    try {
      return parseEnvironment(await readFile(join(homedir(), '.config', name, 'env'), 'utf8'));
    } catch {
      // try next
    }
  }
  throw new Error('没有找到 ~/.config/feishu-claude-bridge/env 或 ~/.config/feishu-codex-bridge/env。');
}

const env = await readEnv();
installSafeLogging([env.FEISHU_APP_SECRET, env.FEISHU_BIND_TOKEN].filter(Boolean));
const client = new Lark.Client({
  appId: env.FEISHU_APP_ID,
  appSecret: env.FEISHU_APP_SECRET,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.fatal,
});

const delegatedTools = [
  { turnId: 't-1', callId: 'c-early', phase: 'running', ...summarizeTool('invoke_subagent', { Role: 'Early Long Runner 🐝' }) },
  { turnId: 't-1', callId: 'c-codex-1', phase: 'running', ...summarizeTool('call_mcp_tool', { ServerName: 'codex-bridge_codex', ToolName: 'codex_review', Arguments: { tier: 'astra' } }) },
  { turnId: 't-1', callId: 'c-codex-2', phase: 'running', ...summarizeTool('call_mcp_tool', { ServerName: 'codex-bridge_codex', ToolName: 'codex_job', Arguments: { action: 'wait', job_id: 'job-20261126-214500-a1b2c3d4' } }) },
  ...Array.from({ length: 7 }, (_, i) => ({
    turnId: 't-1',
    callId: `c-done-${i}`,
    phase: 'succeeded',
    ...summarizeTool('invoke_subagent', { Role: `Worker ${i}` }),
  })),
];

const interimMessage = {
  messageId: 'm-1',
  sessionId: 's-1',
  turnId: 't-1',
  role: 'assistant',
  final: false,
  revision: 1,
  sequence: 1,
  source: 'agy',
  blocks: [{ type: 'text', text: '已启动子代理与 Codex MCP 并行排查，下面先同步初步发现：\n\n' + '核心分析段落。'.repeat(120) }],
};

const finalMessage = {
  ...interimMessage,
  final: true,
  revision: 2,
  blocks: [{ type: 'text', text: '## 最终结论\n\n全部校验通过，详情见正文。' }],
};

const activeSubagents = [
  { conversationId: '2f467ac4-86d5-415f-84c8-78eaa53718aa', agentName: 'carbon-researcher', status: 'running' },
];

const agyCliNoticeMain = {
  refId: 'cli_notice:agy:95395cff-9f84-4412-83ef-48724930f7fb',
  kind: 'cli_notice',
  category: 'approval',
  provider: 'agy',
  readonlyNotice: true,
  nativeSessionId: '95395cff-9f84-4412-83ef-48724930f7fb',
  title: 'Swarm Protocol Overview',
  summary: '终端步骤 #213 等待确认/输入：edit_file · AGENTS.md\n持有终端：PID 1103245 (/dev/pts/3) · 切回命令：agy --conversation 95395cff-9f84-4412-83ef-48724930f7fb',
  project: '/home/zhangzy',
  sourceSessionId: 'session_test_1',
  sourceDestination: null,
  expiresAt: null,
  sourceTopicUrl: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_test',
};

const agyCliNoticeSubagent = {
  ...agyCliNoticeMain,
  refId: 'cli_notice:agy:2f467ac4-86d5-415f-84c8-78eaa53718aa',
  nativeSessionId: '2f467ac4-86d5-415f-84c8-78eaa53718aa',
  title: 'Swarm Protocol Overview · 子代理 carbon-researcher',
  sourceTopicUrl: null,
};

const channelCards = {
  turnRunningV2WithInterimAndWorkers: turnProgressCard({
    provider: 'agy',
    status: 'running',
    schema: '2.0',
    message: interimMessage,
    tools: [
      { turnId: 't-1', callId: 'phase:thinking', phase: 'running', tool: 'thinking', summary: '🧠 正在分析子代理回报与关键日志差异。' },
      ...delegatedTools,
    ],
    duration: 42_000,
    files: [],
    turnId: 't-1',
    activeSubagents,
    modelBadge: 'neon medium',
    contextUsage: { usedTokens: 510_744, maxTokens: 1_048_576, model: 'gemini-4-neon-medium' },
  }),
  turnRunningV1WithInterimAndWorkers: turnProgressCard({
    provider: 'agy',
    status: 'running',
    schema: '1.0',
    message: interimMessage,
    tools: delegatedTools,
    duration: 42_000,
    files: [],
    turnId: 't-1',
    activeSubagents,
    modelBadge: 'neon medium',
    contextUsage: { usedTokens: 510_744, maxTokens: 1_048_576, model: 'gemini-4-neon-medium' },
  }),
  turnCompletedV2CollapsedPanel: turnProgressCard({
    provider: 'agy',
    status: 'completed',
    schema: '2.0',
    message: finalMessage,
    tools: [
      { turnId: 't-1', callId: 'phase:thinking', phase: 'succeeded', tool: 'thinking', summary: '🧠 已定位根因并完成回归测试。' },
      ...delegatedTools,
    ],
    duration: 95_000,
    files: [],
    turnId: 't-1',
    modelBadge: 'carbon high',
    contextUsage: { usedTokens: 860_000, maxTokens: 1_048_576, model: 'gemini-4-carbon-high' },
  }),
  turnCompactDoneV2: turnProgressCard({
    provider: 'agy',
    status: 'completed',
    schema: '2.0',
    message: undefined,
    tools: [],
    duration: 12_000,
    files: [],
    turnId: 't-compact',
    modelBadge: 'neon medium',
    contextUsage: { usedTokens: 48_000, maxTokens: 1_048_576, model: 'gemini-4-neon-medium' },
    compactInfo: { isCompact: true, beforeTokens: 510_744, afterTokens: 48_000, maxTokens: 1_048_576 },
  }),
  cliNoticeAgyMainWithLink: renderPendingItemCard(agyCliNoticeMain, 'hub', 'hub-bind-1', Date.now()),
  cliNoticeAgySubagentNoLink: renderPendingItemCard(agyCliNoticeSubagent, 'hub', 'hub-bind-1', Date.now()),
  cliNoticeWithdrawn: {
    title: '【终端待审批 · 提醒已撤回】',
    template: 'grey',
    text: '终端已无待审批信号。',
    actions: [],
  },
  usageDashboardV2: renderUsageDashboardCard({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    summary: {
      today: { requests: 120, input: 5_000_000, output: 120_000, cached: 4_500_000, total_tokens: 5_120_000, cache_hit_ratio: 0.9, cost_usd: 18.5 },
      yesterday: { requests: 100, input: 4_000_000, output: 100_000, cached: 3_600_000, total_tokens: 4_100_000, cache_hit_ratio: 0.9, cost_usd: 15.0 },
      d7: { requests: 800, input: 35_000_000, output: 900_000, cached: 31_000_000, total_tokens: 35_900_000, cache_hit_ratio: 0.89, cost_usd: 120.0 },
      d30: { requests: 3000, input: 150_000_000, output: 4_000_000, cached: 135_000_000, total_tokens: 154_000_000, cache_hit_ratio: 0.9, cost_usd: 450.0 },
    },
    backends: [
      {
        id: 'antigravity',
        name: 'Antigravity',
        status: 'ok',
        quota: { stale: false, windows: [{ group: 'Gemini', label: 'Gemini 5小时', window_type: '5h', remaining_percent: 78, resets_at: new Date(Date.now() + 7200_000).toISOString() }] },
        today: { requests: 60, total_tokens: 2_500_000, cost_usd: 10.5 },
        models_today: [
          { model: 'gemini-4-carbon', requests: 40, total_tokens: 2_000_000, cache_hit_ratio: 0.92, cost_usd: 9.0 },
          { model: 'gemini-4-hydrogen', requests: 20, total_tokens: 500_000, cache_hit_ratio: 0.85, cost_usd: 1.5 },
        ],
      },
      {
        id: 'codex',
        name: 'Codex',
        status: 'ok',
        quota: { stale: false, windows: [{ group: 'Codex', label: '周额度', window_type: 'weekly', remaining_percent: 42, resets_at: new Date(Date.now() + 86400_000).toISOString() }] },
        today: { requests: 60, total_tokens: 2_620_000, cost_usd: 8.0 },
        models_today: [{ model: 'gpt-6.2-astra', requests: 60, total_tokens: 2_620_000, cache_hit_ratio: 0.95, cost_usd: 8.0 }],
      },
    ],
    claude_cycles: [{ period: '11-24 ~ 12-01', current: true, total_requests: 50, total_tokens: 1_200_000, local_cost_usd: 6.2, site_cost_usd: 6.1 }],
  }),
  sessionListV2WithSections: sessionListCard([{
    sessionId: 'sess_1',
    native: { provider: 'agy', hostId: 'local', serviceId: 'svc', nativeSessionId: 'uuid-1' },
    project: '/home/zhangzy/workspace/feishu-agent-bridge',
    title: '重构新建对话卡片',
    status: 'idle',
    revision: 1,
    updatedAt: new Date().toISOString(),
    capabilities: { view: { status: 'available' } },
    control: { serviceId: 'svc', owner: 'feishu', input: 'available', generation: 1, operationId: null, reason: null },
  }], { providerFilters: true, provider: 'all' }),
  sessionInteractiveV2: sessionCard({
    sessionId: 'sess_1',
    native: { provider: 'agy', hostId: 'local', serviceId: 'svc', nativeSessionId: 'uuid-1' },
    project: '/home/zhangzy/workspace/feishu-agent-bridge',
    title: '重构新建对话卡片',
    status: 'idle',
    revision: 1,
    capabilities: { view: { status: 'available' } },
    control: { serviceId: 'svc', owner: 'feishu', input: 'available', generation: 1, operationId: null, reason: null },
  }, 'interactive'),
  topicRootV2: topicRootCard({
    sessionId: 'sess_1',
    native: { provider: 'agy', hostId: 'local', serviceId: 'svc', nativeSessionId: 'uuid-1' },
    project: '/home/zhangzy/workspace/feishu-agent-bridge',
    title: '重构新建对话卡片',
    status: 'running',
    revision: 1,
    capabilities: { view: { status: 'available' } },
    control: { serviceId: 'svc', owner: 'feishu', input: 'available', generation: 1, operationId: null, reason: null },
  }),
};

let failed = 0;
for (const [name, card] of Object.entries(channelCards)) {
  // CardKit v1.card.create validates Card JSON 2.0 wire payloads server-side without posting to any chat.
  // Run through the same packCardCallbacks pipeline used by FeishuSdkPort.
  const { content } = packCardCallbacks(encodeCard(card, '2.0'));
  let result;
  try {
    result = await client.cardkit.v1.card.create({
      data: { type: 'card_json', data: content },
    });
  } catch (error) {
    result = error?.response?.data ?? { code: -1, msg: String(error) };
  }
  if (result?.code === 0) {
    console.log(`OK    ${name} (CardKit 2.0 + packCardCallbacks)`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}: ${result?.code} ${String(result?.msg ?? '').slice(0, 300)}`);
  }
}

// Local structural check for Card 1.0 wire payloads (Feishu CardKit API only validates 2.0; 1.0 uses im.message.create).
const { content: v1Content } = packCardCallbacks(encodeCard(channelCards.turnRunningV1WithInterimAndWorkers, '1.0'));
const v1Wire = JSON.parse(v1Content);
const allowedV1Tags = new Set(['div', 'markdown', 'hr', 'note', 'action']);
const v1Valid =
  Array.isArray(v1Wire.elements) &&
  v1Wire.elements.length > 0 &&
  v1Wire.elements.every((el) => allowedV1Tags.has(el?.tag)) &&
  v1Wire.elements.some((el) => el?.tag === 'markdown' && String(el.content).includes('子代理与 Codex 状态'));
if (v1Valid) {
  console.log('OK    turnRunningV1WithInterimAndWorkers (Card 1.0 local wire structure + packCardCallbacks)');
} else {
  failed += 1;
  console.log('FAIL  turnRunningV1WithInterimAndWorkers (Card 1.0 local wire structure)');
}

console.log(
  failed
    ? `\n${failed} 张统一卡片未通过飞书 CardKit 服务端校验。`
    : `\n全部 ${Object.keys(channelCards).length} 张统一卡片通过飞书 CardKit 服务端校验（零群消息打扰）。`,
);
process.exitCode = failed ? 1 : 0;
