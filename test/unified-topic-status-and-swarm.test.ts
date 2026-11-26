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
import { summarizeTool } from '../src/unified/tool-progress.js';
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
  assert.equal(summarizeTool('call_mcp_tool', { ToolName: 'codex_engineer' }).summary, '🔌 MCP：codex_engineer');

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
  assert.equal(swarmCard.text, '🐝 Swarm 多代理协作进行中…');
  assert.match(swarmCard.executionLog?.runningNote ?? '', /🐝 Swarm 协作中：等待成员回报/);

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
