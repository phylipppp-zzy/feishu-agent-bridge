import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  TOPIC_TITLE_SCHEMA,
  displayTopicTitle,
  setCustomTopicTitle,
  syncTopicRootTitle,
  topicRootCard,
} from '../src/unified/topic-title-sync.js';
import { readToolProgress, summarizeTool, ToolProgressTracker, type ToolProgress } from '../src/unified/tool-progress.js';
import { turnProgressCard } from '../src/unified/turn-progress-card.js';
import { parseFeishuText } from '../src/unified/feishu-codec.js';
import { encodeCard } from '../src/unified/feishu-card-wire.js';
import { DEFAULT_PROMPT_IDLE_TIMEOUT_MS } from '../src/unified/agy/adapter-types.js';
import type { Session } from '../src/unified/contracts.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import type { FeishuPort } from '../src/unified/feishu-channel.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-1',
    native: { provider: 'agy', hostId: 'local', serviceId: 'agy', nativeSessionId: 'native-1' },
    project: '/home/zhangzy',
    title: '论文审稿实验对比',
    status: 'idle',
    updatedAt: '2026-11-25T10:00:00Z',
    revision: 1,
    control: { owner: 'feishu', serviceId: 'agy', input: 'available', generation: 1, operationId: null, reason: null },
    capabilities: {} as Session['capabilities'],
    ...overrides,
  };
}

test('topicRootCard puts status dot + core title first and renders bold full title + metadata in body', () => {
  const idle = makeSession({ status: 'idle', title: '[AGY · zhangzy] 论文审稿实验对比' });
  assert.equal(displayTopicTitle(idle), '🟢 论文审稿实验对比');
  const card = topicRootCard(idle);
  assert.equal(card.title, '🟢 论文审稿实验对比');
  assert.match(card.text, /^\*\*论文审稿实验对比\*\*\nAntigravity · /);

  const running = makeSession({ status: 'running', title: '🟢 论文审稿实验对比' });
  assert.equal(displayTopicTitle(running), '🔵 论文审稿实验对比');
  assert.equal(topicRootCard(running).template, 'blue');

  const waiting = makeSession({ status: 'waiting_approval' });
  assert.equal(displayTopicTitle(waiting), '🟡 论文审稿实验对比');
  assert.equal(topicRootCard(waiting).template, 'orange');

  const failed = makeSession({ status: 'failed' });
  assert.equal(displayTopicTitle(failed), '🔴 论文审稿实验对比');
  assert.equal(topicRootCard(failed).template, 'red');
});

test('syncTopicRootTitle updates root card on status transitions and honors custom /rename title', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE channel_bindings (destination TEXT PRIMARY KEY, session_id TEXT, binding_id TEXT, revision INTEGER, access_mode TEXT);
    CREATE TABLE channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT);
    ${TOPIC_TITLE_SCHEMA}
  `);
  const binding = { session_id: 'sess-1', binding_id: 'b1', revision: 1, access_mode: 'interactive' };
  db.prepare('INSERT INTO channel_bindings VALUES (?,?,?,?,?)')
    .run('topic:1', binding.session_id, binding.binding_id, binding.revision, binding.access_mode);
  const scope = JSON.stringify(binding);

  const patches: ChannelCard[] = [];
  const port = {
    isTopicDestination: () => true,
    rootMessageId: () => 'root-1',
    update: async (_d: string, _id: string, card: ChannelCard) => { patches.push(card); },
  } as unknown as FeishuPort;

  const base = makeSession({ status: 'idle', title: '初始标题' });
  await syncTopicRootTitle(db, port, 'topic:1', scope, base, c => c, async () => {});
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.title, '🟢 初始标题');

  // Same state does not re-patch
  await syncTopicRootTitle(db, port, 'topic:1', scope, base, c => c, async () => {});
  assert.equal(patches.length, 1);

  // Transition to running patches root card color and dot
  await syncTopicRootTitle(db, port, 'topic:1', scope, makeSession({ status: 'running', title: '初始标题' }), c => c, async () => {});
  assert.equal(patches.length, 2);
  assert.equal(patches[1]!.title, '🔵 初始标题');
  assert.equal(patches[1]!.template, 'blue');

  // /rename custom title overrides upstream title updates
  setCustomTopicTitle(db, 'topic:1', 'sess-1', '自定义重点课题');
  await syncTopicRootTitle(db, port, 'topic:1', scope, makeSession({ status: 'idle', title: '上游自动标题' }), c => c, async () => {});
  assert.equal(patches.length, 3);
  assert.equal(patches[2]!.title, '🟢 自定义重点课题');
  assert.match(patches[2]!.text, /^\*\*自定义重点课题\*\*/);
  db.close();
});

test('Swarm, subagent, thinking, and wakeup progress cards render clear Chinese status', () => {
  assert.equal(summarizeTool('swarm', { action: 'add', name: 'acp-core' }).summary, '🐝 Swarm 启动成员：acp-core');
  assert.equal(summarizeTool('swarm_wait', { since: 10 }).summary, '🐝 Swarm 等待成员回报');
  assert.equal(summarizeTool('post_message', { text: 'hi' }).summary, '🐝 Swarm 协作板发帖');
  assert.equal(summarizeTool('invoke_subagent', { Role: 'Codebase Auditor' }).summary, '🤖 派发子代理：Codebase Auditor');
  assert.equal(summarizeTool('call_mcp_tool', { ToolName: 'codex_engineer' }).summary, '⚡ Codex MCP (工程实现)');

  const swarmCard = turnProgressCard({
    provider: 'agy',
    status: 'running',
    schema: '2.0',
    message: undefined,
    tools: [{ turnId: 't1', callId: 'c1', phase: 'running', tool: 'swarm_wait', summary: '🐝 Swarm 等待成员回报' }],
    duration: 45_000,
    files: [],
    turnId: 't1',
  });
  assert.equal(swarmCard.text, '**子代理与 Codex 状态**\n- ⏳ 🐝 Swarm 等待成员回报（进行中）');
  assert.equal(swarmCard.executionLog?.runningNote, '⏳ 🐝 Swarm 等待成员回报');

  const thinkingCard = turnProgressCard({
    provider: 'agy',
    status: 'running',
    schema: '2.0',
    message: undefined,
    tools: [{ turnId: 't1', callId: 'phase:thinking', phase: 'running', tool: 'thinking', summary: '🧠 正在深度思考…' }],
    duration: 15_000,
    files: [],
    turnId: 't1',
  });
  assert.equal(thinkingCard.text, '🧠 正在深度思考…');

  const wakeupCard = turnProgressCard({
    provider: 'agy',
    status: 'running',
    schema: '2.0',
    message: undefined,
    tools: [],
    duration: 5_000,
    files: [],
    turnId: 'wakeup:abc',
  });
  assert.match(wakeupCard.title, /后台唤醒进行中/);
  assert.equal(wakeupCard.text, '🤖 后台异步唤醒处理中…');
});

test('Codex MCP progress uses only allowlisted metadata and recognizes delegation helpers', () => {
  const actions = {
    codex_engineer: '工程实现', codex_review: '代码审查', codex_followup: '续接会话',
    codex_lookup: '低成本检索', codex_status: '状态查询',
  };
  for (const [ToolName, label] of Object.entries(actions)) {
    assert.equal(summarizeTool('call_mcp_tool', {
      ServerName: 'codex-bridge_codex', ToolName,
      Arguments: { tier: 'astra-deep', prompt: 'private prompt', api_key: 'secret token' },
    }).summary, `⚡ Codex MCP (astra-deep · ${label})`);
  }
  for (const [action, label] of Object.entries({ wait: '等待作业', query: '查询作业', cancel: '取消作业' })) {
    assert.equal(summarizeTool('call_mcp_tool', {
      server_name: 'codex-bridge_codex', tool_name: 'codex_job',
      arguments: { action, tier: 'private prompt', job_id: 'job-20261125-175934-314ddb40' },
    }).summary, `⚡ Codex MCP (${label} …314ddb40)`);
  }
  assert.equal(summarizeTool('call_mcp_tool', {
    ServerName: 'codex-bridge_codex', ToolName: 'unrecognized', Arguments: { tier: 'secret', job_id: 'sk-credentials' },
  }).summary, '⚡ Codex MCP (工具调用)');
  assert.equal(summarizeTool('call_mcp_tool', { ToolName: 'lookup_paper' }).summary, '🔌 MCP：lookup_paper');
  assert.equal(summarizeTool('manage_subagents', {}).summary, '🤖 管理子代理');
  assert.equal(summarizeTool('send_message', { message: 'private prompt' }).summary, '🤖 通知子代理');
});

test('turn progress keeps active delegated calls before main completion and collapses on completed', () => {
  const tool = (callId: string, phase: ToolProgress['phase'], name: string, input: unknown = {}): ToolProgress =>
    ({ turnId: 't1', callId, phase, ...summarizeTool(name, input) });
  const tools = [
    tool('child-early', 'running', 'invoke_subagent', { Role: 'Early Long Runner' }),
    ...Array.from({ length: 8 }, (_, i) => tool(`child-${i}`, 'succeeded', 'invoke_subagent', { Role: `Auditor ${i}` })),
    tool('child-live', 'running', 'invoke_subagent', { Role: 'Astra Auditor' }),
    tool('mcp', 'running', 'call_mcp_tool', { ToolName: 'codex_review', Arguments: { tier: 'astra' } }),
    tool('ordinary', 'succeeded', 'call_mcp_tool', { ToolName: 'lookup_paper' }),
  ];
  const state = { provider: 'agy', status: 'running', schema: '2.0', message: undefined, tools, duration: null, files: [] } as const;
  const card = turnProgressCard(state);
  const lines = card.text.split('\n');
  assert.equal(lines.length, 10);
  assert.deepEqual(lines.slice(0, 5), [
    '**子代理与 Codex 状态**',
    '- ⏳ ⚡ Codex MCP \\(astra · 代码审查\\)（进行中）',
    '- ⏳ 🤖 派发子代理：Astra Auditor（进行中）',
    '- ⏳ 🤖 派发子代理：Early Long Runner（进行中）',
    '- ✓ 🤖 派发子代理：Auditor 7（已完成）',
  ]);
  assert.match(card.text, /另有 3 项子代理\/Codex 记录/);
  assert.doesNotMatch(card.text, /Auditor [012]|lookup_paper/);
  assert.equal(card.executionLog?.runningNote, '⏳ ⚡ Codex MCP (astra · 代码审查)（另有 2 项并行）');
  const interimReply = turnProgressCard({ ...state, message: {
    messageId: 'reply', sessionId: 'session', turnId: 't1', role: 'assistant',
    final: false, revision: 1, sequence: 1, source: 'agy', blocks: [{ type: 'text', text: '阶段过渡说明' }],
  } });
  assert.match(interimReply.text, /\*\*子代理与 Codex 状态\*\*/);
  assert.match(interimReply.text, /---\n\n阶段过渡说明$/);
  assert.equal(interimReply.executionLog?.count, tools.length);
  const completedWithText = turnProgressCard({ ...state, status: 'completed', message: {
    messageId: 'reply', sessionId: 'session', turnId: 't1', role: 'assistant',
    final: true, revision: 2, sequence: 1, source: 'agy', blocks: [{ type: 'text', text: '最终完整结论' }],
  } });
  assert.equal(completedWithText.text, '最终完整结论');
  assert.doesNotMatch(completedWithText.text, /子代理与 Codex 状态/);
  const completedNoText = turnProgressCard({ ...state, status: 'completed' });
  assert.doesNotMatch(completedNoText.text, /子代理与 Codex 状态/);
  assert.equal(completedNoText.executionLog?.runningNote, undefined);
});

test('tool tracker keeps the Codex MCP summary when completion omits or clears Arguments', () => {
  const tracker = new ToolProgressTracker();
  const ref = makeSession().native;
  const detail = summarizeTool('call_mcp_tool', { ToolName: 'codex_review', Arguments: { tier: 'astra' } });
  tracker.observe(ref, 1, 'turn', 'mcp', 'running', detail);
  const generic = summarizeTool('call_mcp_tool', {});
  assert.equal(generic.summary, '🔌 MCP');
  assert.equal(tracker.observe(ref, 1, 'turn', 'mcp', 'running', generic), undefined);
  const done = tracker.observe(ref, 1, 'turn', 'mcp', 'succeeded', generic);
  assert.ok(done?.type === 'event');
  assert.deepEqual(done.event.data, { turnId: 'turn', callId: 'mcp', phase: 'succeeded', ...detail });

  // Also verify codex_job(wait + job_id) does not downgrade to 查询作业 when completion sends Arguments: {}
  const jobWait = summarizeTool('call_mcp_tool', {
    ServerName: 'codex-bridge_codex',
    ToolName: 'codex_job',
    Arguments: { action: 'wait', job_id: 'job-20261126-111851-314ddb40' },
  });
  assert.equal(jobWait.summary, '⚡ Codex MCP (等待作业 …314ddb40)');
  tracker.observe(ref, 1, 'turn', 'mcp-job', 'running', jobWait);
  const jobEmpty = summarizeTool('call_mcp_tool', {
    ServerName: 'codex-bridge_codex',
    ToolName: 'codex_job',
    Arguments: {},
  });
  const jobDone = tracker.observe(ref, 1, 'turn', 'mcp-job', 'succeeded', jobEmpty);
  assert.ok(jobDone?.type === 'event');
  assert.equal((jobDone.event.data as ToolProgress).summary, '⚡ Codex MCP (等待作业 …314ddb40)');

  // P2: Unified 8-item budget shared between delegated tools and active session subagents.
  const eightDoneTools: ToolProgress[] = Array.from({ length: 8 }, (_, idx) => ({
    turnId: 'turn',
    callId: `done-${idx}`,
    phase: 'succeeded',
    ...summarizeTool('invoke_subagent', { Role: `Finished ${idx}` }),
  }));
  const threeActiveSubs = [
    { conversationId: 'sub-11111111', agentName: 'Active Sub A', status: 'running' },
    { conversationId: 'sub-22222222', agentName: 'Active Sub B', status: 'running' },
    { conversationId: 'sub-33333333', agentName: 'Active Sub C', status: 'running' },
  ];
  const unifiedCard = turnProgressCard({
    provider: 'agy',
    status: 'running',
    schema: '2.0',
    message: undefined,
    tools: eightDoneTools,
    duration: null,
    files: [],
    turnId: 'turn',
    activeSubagents: threeActiveSubs,
  });
  assert.match(unifiedCard.text, /Active Sub A/);
  assert.match(unifiedCard.text, /Active Sub B/);
  assert.match(unifiedCard.text, /Active Sub C/);
  assert.match(unifiedCard.text, /另有 3 项子代理\/Codex 记录/);
  const bulletLines = unifiedCard.text.split('\n').filter((line) => line.startsWith('- '));
  // 8 visible items + 1 omitted summary line = 9 bullet lines total
  assert.equal(bulletLines.length, 9);
});

test('summary limits count Unicode code points and never split an emoji', () => {
  const role = 'a'.repeat(34) + '🐝🐝🐝';
  const summary = summarizeTool('invoke_subagent', { Role: role }).summary;
  assert.equal(summary, `🤖 派发子代理：${'a'.repeat(34)}🐝…`);
  assert.equal([...summary].every(char => !/\p{Cs}/u.test(char)), true);
  const fields = { turnId: 'turn', callId: 'tool', phase: 'running', tool: 'tool' };
  assert.ok(readToolProgress({ ...fields, summary: '🐝'.repeat(120) }));
  assert.equal(readToolProgress({ ...fields, summary: '🐝'.repeat(121) }), undefined);
  assert.equal(readToolProgress({ ...fields, summary: String.fromCharCode(0xd83d) }), undefined);
});

test('parseFeishuText supports /rename <title> and rejects empty /rename', () => {
  assert.deepEqual(parseFeishuText('/rename 论文实验对比'), { action: 'rename', title: '论文实验对比' });
  assert.throws(() => parseFeishuText('/rename   '), /invalid or unsupported command/);
});

test('long V2 markdown replies split across paragraph boundaries without breaking fenced code blocks', () => {
  assert.equal(DEFAULT_PROMPT_IDLE_TIMEOUT_MS, 60 * 60_000);
  const paraA = '第一段分析内容：' + '甲'.repeat(3000);
  const paraB = '第二段完整结论：' + '乙'.repeat(3000);
  const card = encodeCard({
    schema: '2.0',
    title: 'Antigravity · 已完成',
    template: 'green',
    text: `${paraA}\n\n${paraB}`,
    actions: [],
  }) as { schema?: string; body?: { elements?: Array<{ tag?: string; content?: string }> } };
  assert.equal(card.schema, '2.0');
  const mdElements = (card.body?.elements ?? []).filter(el => el.tag === 'markdown');
  assert.equal(mdElements.length, 2);
  assert.ok(mdElements[0]!.content!.includes('第一段分析内容'));
  assert.ok(mdElements[1]!.content!.includes('第二段完整结论'));
});
