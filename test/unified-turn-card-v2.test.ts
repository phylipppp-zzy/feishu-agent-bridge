import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  extractAgyContextUsageFromRows,
  formatCacheHitRate,
  formatCompactTokenCount,
  formatContextStatusLine,
  formatContextUsageBadge,
  resolveModelMaxContextTokens,
} from '../src/unified/context-usage.js';
import { cardSchema, encodeCard } from '../src/unified/feishu-card-wire.js';
import { formatThinkingSummary, readToolProgress } from '../src/unified/tool-progress.js';
import { parseFeishuAction, parseFeishuText } from '../src/unified/feishu-codec.js';
import { buildSessionPanel, noticePanel } from '../src/unified/feishu-session-panel.js';
import { buildSessionHelpCard, buildTaskTopicHelpCard } from '../src/unified/help-cards.js';
import { TurnCardDelivery } from '../src/unified/turn-card-delivery.js';
import { turnFinalReplyCard, turnProcessCard, turnProgressCard, type TurnCardState } from '../src/unified/turn-progress-card.js';
import type { FeishuPort } from '../src/unified/feishu-channel.js';
import type { UnifiedService } from '../src/unified/adapter.js';
import type { Message, Session, SessionSnapshot, Turn } from '../src/unified/contracts.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-1',
    native: { provider: 'agy', hostId: 'local', serviceId: 'svc', nativeSessionId: 'native-1' },
    project: '/home/zhangzy/workspace/feishu-agent-bridge',
    title: 'Test Session',
    status: 'idle',
    revision: 3,
    capabilities: {
      view: { status: 'available' },
      send: { status: 'available' },
      queue: { status: 'available' },
      steer: { status: 'unsupported', reason: 'no' },
      answer: { status: 'available' },
      approve: { status: 'available' },
      interrupt: { status: 'available' },
      handoff: { status: 'available' },
      files: { status: 'available' },
      config: { status: 'available' },
    },
    control: { serviceId: 'svc', owner: 'feishu', input: 'available', generation: 2, operationId: null, reason: null },
    ...overrides,
  };
}

test('extractAgyContextUsageFromRows sums input_tokens + cache_read_tokens + output_tokens', () => {
  const usage = extractAgyContextUsageFromRows([
    { type: 'USER_INPUT', content: 'hello' },
    {
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-medium',
      input_tokens: 8799,
      cache_read_tokens: 497066,
      output_tokens: 4879,
    },
  ]);
  assert.ok(usage);
  assert.equal(usage.usedTokens, 510744);
  assert.equal(usage.maxTokens, 1_048_576);
  assert.equal(usage.model, 'gemini-4-neon-medium');
  assert.equal(usage.totalInputTokens, 505_865);
  assert.equal(usage.cacheReadTokens, 497_066);
  assert.equal(formatCacheHitRate(usage), 98);

  const badge = formatContextUsageBadge(usage);
  assert.deepEqual(badge, { text: '511K / 1M (49%)', pct: 49, color: 'wathet' });
  assert.equal(formatContextUsageBadge({ usedTokens: 850_000, maxTokens: 1_048_576 })?.color, 'orange');
  assert.equal(formatContextUsageBadge({ usedTokens: 980_000, maxTokens: 1_048_576 })?.color, 'red');
  assert.equal(formatCompactTokenCount(1_048_576), '1M');
  assert.equal(resolveModelMaxContextTokens('gpt-6.2-astra', 'codex'), 272_000);
});

test('cache hit rate requires a measured read count and finite positive denominator', () => {
  const zero = { usedTokens: 40, maxTokens: 100, totalInputTokens: 40, cacheReadTokens: 0 };
  assert.equal(formatCacheHitRate(zero), 0);
  assert.equal(formatCacheHitRate({ ...zero, cacheReadTokens: 50 }), 100);
  assert.equal(formatCacheHitRate({ ...zero, cacheReadTokens: -2 }), null);
  assert.equal(formatCacheHitRate({ ...zero, cacheReadTokens: NaN }), null);
  assert.equal(formatCacheHitRate({ ...zero, cacheReadTokens: Infinity }), null);
  assert.equal(formatCacheHitRate({ ...zero, totalInputTokens: 0 }), null);
  assert.equal(formatCacheHitRate({ ...zero, totalInputTokens: Infinity }), null);
  assert.equal(formatCacheHitRate(extractAgyContextUsageFromRows([{ input_tokens: 50 }])), null);
  assert.equal(formatCacheHitRate(extractAgyContextUsageFromRows([{ input_tokens: 0, cache_read_tokens: 0, output_tokens: 20 }])), null);
});

test('dual cards render live context, archive thinking and tool steps, and place final metadata below the reply', () => {
  const message: Message = {
    messageId: 'm-1',
    sessionId: 'sess-1',
    turnId: 't-1',
    role: 'assistant',
    blocks: [{ type: 'text', text: '## 最终结论\n\n全部测试通过。' }],
    sequence: 10,
    revision: 2,
    final: true,
    source: 'agy',
  };
  const state: TurnCardState = {
    provider: 'agy',
    status: 'completed',
    schema: '2.0',
    message,
    tools: [
      { turnId: 't-1', callId: 'phase:thinking', phase: 'succeeded', tool: 'thinking', summary: '🧠 先排查 SQLite 卡死根因，再核对 PATCH 幂等逻辑。' },
      { turnId: 't-1', callId: 'c-1', phase: 'succeeded', tool: 'read_file', summary: '读取文件 · src/unified/turn-card-delivery.ts' },
      { turnId: 't-1', callId: 'c-2', phase: 'succeeded', tool: 'run_command', summary: '执行命令 · npm run check' },
    ],
    duration: 45_000,
    files: [],
    turnId: 't-1',
    modelBadge: 'neon medium',
    contextUsage: { usedTokens: 510_744, maxTokens: 1_048_576, model: 'gemini-4-neon-medium', totalInputTokens: 100, cacheReadTokens: 91 },
    completedAtMs: Date.UTC(2026, 0, 1, 14, 8),
    sessionConnected: true,
    sessionId: message.sessionId,
    stopAction: { label: '⏹ 中断当前回复', value: { action: 'stop', turnId: 't-1', revision: 2, controlGeneration: 3, fallbackCurrent: true } },
  };

  const running = turnProcessCard({ ...state, status: 'running' });
  assert.equal(running.subtitle, undefined);
  assert.equal(running.headerTags, undefined);
  assert.equal(running.executionLog?.position, 'top');
  assert.equal(running.executionLog?.expanded, true);
  assert.match(running.statusBanner ?? '', /511K \/ 1M \(49%\).*缓存命中 91%/);
  assert.doesNotMatch(running.statusBanner ?? '', /neon/);
  assert.deepEqual(running.actions, [state.stopAction]);

  type Wire = {
    body: { elements: Array<{ tag: string; content?: string; expanded?: boolean; elements?: Array<{ content?: string }> }> };
  };
  const archive = turnProcessCard(state);
  assert.equal(archive.title, 'Antigravity · 执行过程已完成 · 2 步 · 用时 45秒 · neon medium');
  assert.equal(archive.statusBanner, undefined);
  assert.deepEqual(archive.actions, []);
  assert.doesNotMatch(archive.text, /最终结论/);
  const archiveWire = encodeCard(archive) as Wire;
  const panel = archiveWire.body.elements[0];
  assert.equal(panel?.tag, 'collapsible_panel');
  assert.equal(panel.expanded, false);
  assert.match(panel.elements?.[0]?.content ?? '', /思考过程/);
  assert.match(panel.elements?.[1]?.content ?? '', /1\. ✅ \*\*读取文件\*\*/);
  assert.match(panel.elements?.[1]?.content ?? '', /2\. ✅ \*\*执行命令\*\*/);

  const reply = turnFinalReplyCard(state);
  assert.equal(reply.title, 'Antigravity · 回复');
  assert.equal(reply.text, '## 最终结论\n\n全部测试通过。');
  assert.match(reply.footer ?? '', /缓存命中 91%\n🧠 neon medium · 🔧 2 步 · ⏱ 45秒 · 🕒 22:08/);
  assert.deepEqual(reply.actions.map(action => action.value.action), ['compact', 'models', 'panel']);
  const elements = (encodeCard(reply) as Wire).body.elements;
  assert.deepEqual(elements.slice(0, 3), [
    { tag: 'markdown', content: reply.text },
    { tag: 'hr' },
    { tag: 'markdown', content: reply.footer },
  ]);
  assert.equal(elements[3]?.tag, 'column_set');
});

test('reply completion time falls back to the current Shanghai time for a non-finite timestamp', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1, 16, 7) });
  const reply = turnFinalReplyCard({
    provider: 'agy', status: 'completed', schema: '2.0', duration: null, files: [],
    tools: [], message: undefined, completedAtMs: NaN,
  });
  assert.match(reply.footer ?? '', /🕒 00:07/);
});

test('CLI running, archived and final reply cards display their respective tags', () => {
  const state: TurnCardState = {
    provider: 'agy', status: 'completed', schema: '2.0', duration: null, files: [],
    tools: [], message: undefined, isCliReadonly: true,
  };
  assert.deepEqual(turnProcessCard({ ...state, status: 'running' }).headerTags, [{ text: '💻 CLI 运行', color: 'wathet' }]);
  assert.deepEqual(turnProcessCard(state).headerTags, [{ text: '💻 CLI 镜像', color: 'wathet' }]);
  assert.deepEqual(turnFinalReplyCard(state).headerTags, [{ text: '💻 CLI 镜像', color: 'wathet' }]);
});

test('turnProgressCard supports /compact running and completed states with token reduction summary', () => {
  const runningCompact = turnProgressCard({
    provider: 'agy',
    status: 'running',
    schema: '2.0',
    message: undefined,
    tools: [],
    duration: 5_000,
    files: [],
    turnId: 't-compact',
    modelBadge: 'neon medium',
    contextUsage: { usedTokens: 510_744, maxTokens: 1_048_576 },
    compactInfo: { isCompact: true, beforeTokens: 510_744, afterTokens: 510_744, maxTokens: 1_048_576 },
  });
  assert.match(runningCompact.title, /正在压缩上下文/);
  assert.match(runningCompact.text, /正在压缩对话上下文/);

  const doneCompact = turnProgressCard({
    provider: 'agy',
    status: 'completed',
    schema: '2.0',
    message: undefined,
    tools: [],
    duration: 12_000,
    files: [],
    turnId: 't-compact',
    modelBadge: 'neon medium',
    contextUsage: { usedTokens: 48_000, maxTokens: 1_048_576 },
    compactInfo: { isCompact: true, beforeTokens: 510_744, afterTokens: 48_000, maxTokens: 1_048_576 },
  });
  assert.match(doneCompact.title, /上下文已压缩/);
  assert.match(doneCompact.text, /`511K` → `48K` \/ `1M`（释放 91%）/);
});

test('standalone /compact reply includes token reduction and trims the final message', () => {
  const reply = turnFinalReplyCard({
    provider: 'agy', status: 'completed', schema: '2.0', duration: 12_000, files: [], tools: [],
    compactInfo: { isCompact: true, beforeTokens: 510_744, afterTokens: 48_000, maxTokens: 1_048_576 },
    message: {
      messageId: 'm-compact', sessionId: 'sess-1', turnId: 't-compact', role: 'assistant',
      blocks: [{ type: 'text', text: '  保留这条总结。  ' }], sequence: 1, revision: 1, final: true, source: 'agy',
    },
  });
  assert.equal(reply.text, '✅ 上下文压缩完成：`511K` → `48K` / `1M`（释放 91%）\n\n保留这条总结。');
});

test('/compact text command, card action, panel metadata, and help cards are wired', () => {
  assert.deepEqual(
    parseFeishuText('/compact', { passthroughUnknownSlash: true }),
    { action: 'input', text: '/compact', mode: 'new' },
  );
  assert.deepEqual(
    parseFeishuAction({ action: 'compact', revision: 3, controlGeneration: 2, bindingId: 'b-1' }),
    { action: 'compact', revision: 3, controlGeneration: 2, bindingId: 'b-1' },
  );

  const session = makeSession();
  const notice = noticePanel(session, { paused: false, completed: true, waiting: true, failed: true, revision: 1 });
  const panel = buildSessionPanel(
    session,
    notice,
    { runningTurns: [], queuedInputs: [], canArchive: true },
    { modelBadge: 'neon medium', contextUsage: { usedTokens: 510_744, maxTokens: 1_048_576 } },
  );
  assert.match(panel.text, /模型：`neon medium`/);
  assert.match(panel.text, /上下文：511K \/ 1M \(49%\)/);
  assert.ok(panel.actions.some(a => a.value.action === 'compact'));

  const runningPanel = buildSessionPanel(
    session,
    notice,
    {
      runningTurns: [{ turnId: 't-1', sessionId: 'sess-1', status: 'running', inputId: null, startedAt: null, endedAt: null, model: null, outputIds: [] }],
      queuedInputs: [],
      canArchive: false,
    },
  );
  const runningCompactBtn = runningPanel.actions.find(a => a.value.action === 'compact');
  assert.ok(runningCompactBtn, 'running panel should expose queued compact button');
  assert.match(runningCompactBtn.label, /排队压缩上下文/);

  assert.match(buildSessionHelpCard('agy', 'interactive').text, /\/compact/);
  assert.doesNotMatch(buildTaskTopicHelpCard('agy').text, /\/compact/);
});

test('live context status line and one-click compact button work during running and completed turns', () => {
  assert.equal(formatContextStatusLine(null), null);
  assert.match(
    formatContextStatusLine({ usedTokens: 84_000, maxTokens: 1_048_576 }, { modelBadge: 'neon medium' }) ?? '',
    /^🟢 上下文：`84K \/ 1M \(8%\)` `▓░░░░░░░░░` · 模型 `neon medium`$/,
  );
  assert.match(
    formatContextStatusLine({ usedTokens: 860_000, maxTokens: 1_048_576 }, { modelBadge: 'neon medium' }) ?? '',
    /^🟠 上下文：`860K \/ 1M \(82%\)` `▓▓▓▓▓▓▓▓░░` · 建议压缩 · 模型 `neon medium`$/,
  );
  assert.match(
    formatContextStatusLine({ usedTokens: 980_000, maxTokens: 1_048_576 }) ?? '',
    /^🔴 上下文：`980K \/ 1M \(93%\)` `▓▓▓▓▓▓▓▓▓░` · 接近上限，建议立即压缩$/,
  );

  const runningHigh = turnProgressCard({
    provider: 'agy',
    status: 'running',
    schema: '2.0',
    message: undefined,
    tools: [{ turnId: 't-run', callId: 'c-1', phase: 'running', tool: 'run_command', summary: '执行命令 · npm test' }],
    duration: 15_000,
    files: [],
    turnId: 't-run',
    allowCompactButton: true,
    modelBadge: 'neon medium',
    contextUsage: { usedTokens: 860_000, maxTokens: 1_048_576 },
  });
  assert.match(runningHigh.statusBanner ?? '', /860K \/ 1M \(82%\)/);
  const runCompactBtn = runningHigh.actions.find(a => a.value.action === 'compact');
  assert.ok(runCompactBtn);
  assert.equal(runCompactBtn.label, '🗜️ 排队压缩上下文 (82%)');
  assert.equal(runCompactBtn.type, 'primary');

  const completedNormal = turnProgressCard({
    provider: 'agy',
    status: 'completed',
    schema: '2.0',
    message: undefined,
    tools: [],
    duration: 5_000,
    files: [],
    turnId: 't-done',
    allowCompactButton: true,
    contextUsage: { usedTokens: 120_000, maxTokens: 1_048_576 },
  });
  const doneCompactBtn = completedNormal.actions.find(a => a.value.action === 'compact');
  assert.ok(doneCompactBtn);
  assert.equal(doneCompactBtn.label, '🗜️ 压缩上下文');
  assert.equal(doneCompactBtn.type, 'default');

  const compactTurn = turnProgressCard({
    provider: 'agy',
    status: 'completed',
    schema: '2.0',
    message: undefined,
    tools: [],
    duration: 5_000,
    files: [],
    turnId: 't-cmp',
    allowCompactButton: true,
    compactInfo: { isCompact: true, beforeTokens: 860_000, afterTokens: 50_000, maxTokens: 1_048_576 },
  });
  assert.equal(compactTurn.actions.some(a => a.value.action === 'compact'), false, 'compact turn itself must not show compact button');

  const readOnlyCard = turnProgressCard({
    provider: 'agy',
    status: 'running',
    schema: '2.0',
    message: undefined,
    tools: [],
    duration: 5_000,
    files: [],
    turnId: 't-ro',
    allowCompactButton: false,
    contextUsage: { usedTokens: 860_000, maxTokens: 1_048_576 },
  });
  assert.equal(readOnlyCard.actions.some(a => a.value.action === 'compact'), false, 'read-only mirror must not show compact button');
});

test('P0-3 & P1-2 regressions: long thinking <= 120 code points, no empty panel, and table+subtitle stays 1.0', () => {
  const longThinking = `分析根因⚠️\uFE0F：` + '深入追踪多段状态机与缓存边界，核对所有异常路径与回滚条件。'.repeat(10);
  const summary = formatThinkingSummary(longThinking);
  assert.ok([...summary].length <= 120, 'thinking summary must fit readToolProgress 120 code-point cap');
  const parsed = readToolProgress({ turnId: 't-1', callId: 'phase:thinking', phase: 'running', tool: 'thinking', summary });
  assert.ok(parsed, 'readToolProgress must accept formatted long thinking summary');

  const onlyThinkingCard = turnProgressCard({
    provider: 'agy',
    status: 'completed',
    schema: '2.0',
    message: {
      messageId: 'm-1',
      sessionId: 'sess-1',
      turnId: 't-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: '最终回复' }],
      sequence: 1,
      revision: 1,
      final: true,
      source: 'agy',
    },
    tools: [{ turnId: 't-1', callId: 'phase:thinking', phase: 'running', tool: 'thinking', summary }],
    duration: 5_000,
    files: [],
    turnId: 't-1',
  });
  assert.equal(onlyThinkingCard.executionLog?.count, 0);
  const wire = encodeCard(onlyThinkingCard, '2.0') as { body: { elements: Array<{ tag: string }> } };
  assert.equal(wire.body.elements.some(e => e.tag === 'collapsible_panel'), false, 'must NOT render empty collapsible_panel');

  const manyToolsCard = turnProgressCard({
    provider: 'agy',
    status: 'completed',
    schema: '2.0',
    message: undefined,
    tools: Array.from({ length: 6 }, (_, i) => ({
      turnId: 't-many',
      callId: `c-${i}`,
      phase: 'succeeded' as const,
      tool: 'read_file',
      summary: `读取文件 · f${i}.ts`,
    })),
    duration: 10_000,
    files: [],
    turnId: 't-many',
  });
  assert.equal(manyToolsCard.executionLog?.expanded, false, 'completed card with >5 tools collapses panel');

  assert.equal(
    cardSchema({
      title: '表格卡',
      subtitle: '带副标题',
      headerTags: [{ text: 'Tag' }],
      text: '',
      table: { columns: [{ header: '列' }], rows: [['值']] },
      actions: [],
    }),
    '1.0',
    'table card with subtitle/headerTags must stay on 1.0 to avoid illegal lark_md in Card 2.0',
  );
});

test('execution summary panels contain only real content and use the appropriate title', () => {
  const card = { title: '过程', text: '正在处理', actions: [] };
  const log = { count: 2, lines: [], collapseSummary: true };
  const render = (executionLog: typeof log & { thinking?: string; runningNote?: string }) =>
    (encodeCard({ ...card, executionLog }, '2.0') as { body: { elements: unknown[] } }).body.elements;
  assert.deepEqual(render({ ...log, thinking: '  ' }), [{ tag: 'markdown', content: card.text }]);
  assert.deepEqual(render({ ...log, runningNote: '等待工具' }).at(-1), {
    tag: 'collapsible_panel', element_id: 'execution_log', expanded: false,
    header: { title: { tag: 'markdown', content: '执行状态' } },
    elements: [{ tag: 'markdown', content: '等待工具' }],
  });
  assert.deepEqual(render({ ...log, thinking: '核对正文' }).at(-1), {
    tag: 'collapsible_panel', element_id: 'execution_log', expanded: false,
    header: { title: { tag: 'markdown', content: '思考过程' } },
    elements: [{ tag: 'markdown', content: '核对正文' }],
  });
});

test('card footers omit blank mentions, respect plain fallback and avoid an initial separator', () => {
  const card = { title: '回复', text: '正文', actions: [] };
  for (const schema of ['1.0', '2.0'] as const) {
    const render = (input: Parameters<typeof encodeCard>[0]) => {
      const wire = encodeCard(input, schema) as { elements?: unknown[]; body?: { elements: unknown[] } };
      return wire.body?.elements ?? wire.elements;
    };
    for (const footer of ['  ', ' <at id="ou_test">某人</at> ']) {
      assert.deepEqual(render({ ...card, footer }), [{ tag: 'markdown', content: card.text }]);
    }
    assert.deepEqual(render({ ...card, format: 'plain', footer: '  <at id="ou_test">某人</at> **元信息**  ' }), [
      { tag: 'div', text: { tag: 'plain_text', content: card.text } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'plain_text', content: '**元信息**' } },
    ]);
    assert.deepEqual(render({ ...card, text: '', footer: '元信息' }), [{ tag: 'markdown', content: '元信息' }]);
  }
});

test('Card 2.0 groups seven action buttons into rows of four and three in order', () => {
  const actions = Array.from({ length: 7 }, (_, index) => ({ label: `操作 ${index}`, value: { action: `test_${index}` } }));
  type ActionRow = {
    tag: string;
    columns: { elements: { text: { content: string }; behaviors: { value: { action: string } }[] }[] }[];
  };
  const wire = encodeCard({ title: '回复', text: '正文', actions }, '2.0') as { body: { elements: ActionRow[] } };
  const rows = wire.body.elements.filter(e => e.tag === 'column_set');
  assert.deepEqual(rows.map(row => row.columns.length), [4, 3]);
  assert.deepEqual(rows.flatMap(row => row.columns.map(column => column.elements[0]?.text.content)), actions.map(a => a.label));
  assert.deepEqual(rows.flatMap(row => row.columns.map(column => column.elements[0]?.behaviors[0]?.value)), actions.map(a => a.value));
});

test('TurnCardDelivery archives an existing process card after an orphaned PATCH and sends one reply', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE channel_delivery_diagnostics (delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL, platform_code INTEGER);
    CREATE TABLE channel_history_baselines (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(destination,session_id,binding_scope,message_id));
  `);
  const updates: Array<{ cardId: string; title: string; text: string }> = [];
  const sends: Array<{ deliveryId: string; title: string; text: string }> = [];
  const port = {
    send: async (_dest: string, card: { title: string; text: string }, deliveryId: string) => {
      sends.push({ deliveryId, title: card.title, text: card.text });
      return 'om_new_card';
    },
    update: async (_dest: string, cardId: string, card: { title: string; text: string }) => {
      updates.push({ cardId, title: card.title, text: card.text });
    },
    lookupDelivery: async () => 'unknown' as const,
    sendFile: async () => undefined,
  } as unknown as FeishuPort;

  const service = {
    getConfirmedSettings: async () => ({ model: 'gemini-4-carbon', preferences: { reasoningEffort: 'high' } }),
    getContextUsage: async () => ({ usedTokens: 320_000, maxTokens: 1_048_576, model: 'gemini-4-carbon-high' }),
    findRegisteredReplyFiles: async () => [],
  } as unknown as UnifiedService;

  const delivery = new TurnCardDelivery(db, service, port, {
    guard: async () => undefined,
    stamp: (_dest, card) => card,
    wake: () => undefined,
  });

  const dest = 'topic:oc_test:om_root';
  const sessionId = 'sess-1';
  const scope = 'scope-1';
  const turnId = 'turn-stuck-1';
  const cardId = 'om_existing_card';

  // Seed the exact live deadlock state: existing card_id + running attempt with unknown delivery receipt.
  db.prepare(`INSERT INTO channel_stream_cards VALUES (?,?,?,?,?,1,?,0,'',0)`)
    .run(dest, sessionId, scope, turnId, cardId, Date.now() - 10_000);
  db.prepare(`INSERT INTO channel_turn_card_views VALUES (?,?,?,?,'2.0','running','Antigravity · 进行中 · 用时 137分15秒 · carbon high','sig-old','turn-update:stale',1)`)
    .run(dest, sessionId, scope, turnId);
  db.prepare(`INSERT INTO channel_deliveries VALUES ('turn-update:stale', 'unknown')`).run();
  db.prepare(`INSERT INTO channel_turn_card_attempts VALUES (?,?,?,?,?)`).run(
    dest,
    sessionId,
    scope,
    turnId,
    JSON.stringify({
      view: {
        schema: '2.0',
        status: 'running',
        title: 'Antigravity · 进行中 · 用时 137分15秒 · carbon high',
        signature: 'sig-stale',
        delivery: 'turn-update:stale',
        dirty: 1,
      },
      plain: false,
      retryAfter: 0,
    }),
  );

  const completedTurn: Turn = {
    turnId,
    sessionId,
    status: 'completed',
    inputId: null,
    startedAt: '2026-11-27T17:00:00.000Z',
    endedAt: '2026-11-27T17:02:00.000Z',
    model: 'gemini-4-carbon',
    outputIds: ['msg-final'],
  };
  const finalMessage: Message = {
    messageId: 'msg-final',
    sessionId,
    turnId,
    role: 'assistant',
    blocks: [{ type: 'text', text: '任务已完成，这是最终输出。' }],
    sequence: 5,
    revision: 1,
    final: true,
    source: 'agy',
  };
  const snapshot: SessionSnapshot = {
    session: makeSession(),
    turns: [completedTurn],
    messages: [finalMessage],
    interactions: [],
  };

  await delivery.sync([dest, sessionId, scope], snapshot, [], [finalMessage], () => false);

  assert.equal(sends.length, 1, 'one independent reply follows the archive PATCH');
  assert.match(sends[0]!.deliveryId, /^turn-reply:/);
  assert.match(sends[0]!.text, /任务已完成/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.cardId, cardId);
  assert.match(updates[0]!.title, /执行过程已完成/);
  assert.match(updates[0]!.text, /过程已归档/);

  const remainingPending = db.prepare('SELECT COUNT(*) AS n FROM channel_turn_pending_finalization').get() as { n: number };
  assert.equal(remainingPending.n, 0, 'pending finalization must be cleared');
  const unknownDeliveries = db.prepare("SELECT COUNT(*) AS n FROM channel_deliveries WHERE state='unknown'").get() as { n: number };
  assert.equal(unknownDeliveries.n, 0, 'P0-1: superseded unknown PATCH must be suppressed on confirmCard');

  // A terminal PATCH with an unknown receipt retries after backoff.
  const turnTerm = 'turn-term-retry';
  db.prepare(`INSERT INTO channel_stream_cards VALUES (?,?,?,?,?,1,?,0,'',0)`)
    .run(dest, sessionId, scope, turnTerm, 'om_term_card', Date.now() - 10_000);
  db.prepare(`INSERT INTO channel_deliveries VALUES ('turn-final:stale', 'unknown')`).run();
  db.prepare(`INSERT INTO channel_turn_card_attempts VALUES (?,?,?,?,?)`).run(
    dest, sessionId, scope, turnTerm,
    JSON.stringify({
      view: { schema: '2.0', status: 'completed', title: '已完成', signature: 'sig-t', delivery: 'turn-final:stale', dirty: 1 },
      plain: false, retryAfter: 0,
    }),
  );
  const terminalSnapshot = { ...snapshot, turns: [{ ...completedTurn, turnId: turnTerm }], messages: [] };
  await delivery.sync([dest, sessionId, scope], terminalSnapshot, [], [], () => false);
  assert.equal(updates.length, 1);
  t.mock.timers.tick(5000);
  await delivery.sync([dest, sessionId, scope], terminalSnapshot, [], [], () => false);
  assert.equal(updates.at(-1)?.cardId, 'om_term_card');
  const staleTerm = db.prepare("SELECT state FROM channel_deliveries WHERE delivery_id='turn-final:stale'").get() as { state: string };
  assert.equal(staleTerm.state, 'suppressed', 'superseded terminal unknown PATCH marked suppressed after retry succeeds');

  // P0-2 fast /compact surviving throttle AND queued /compact not hijacking running normal turn:
  let currentUsed = 510_744;
  service.getContextUsage = async () => ({ usedTokens: currentUsed, maxTokens: 1_048_576, model: 'gemini-4-neon-medium' });
  delivery.recordCompactBaseline(sessionId, 'op-compact-queued', { usedTokens: 510_744, maxTokens: 1_048_576 }, true);
  const normalTurn: Turn = {
    turnId: 'turn-normal-running',
    sessionId,
    status: 'running',
    inputId: 'op-normal-1',
    startedAt: new Date().toISOString(),
    endedAt: null,
    model: 'gemini-4-neon',
    outputIds: [],
  };
  await delivery.sync([dest, sessionId, scope], { ...snapshot, turns: [normalTurn], messages: [] }, [], [], () => false);
  assert.doesNotMatch(updates.at(-1)?.title ?? '', /压缩上下文/, 'queued /compact must NOT hijack running normal turn');

  // Now the queued /compact turn starts and finishes quickly:
  currentUsed = 48_000;
  const compactTurn: Turn = {
    turnId: 'turn-compact-actual',
    sessionId,
    status: 'completed',
    inputId: 'op-compact-queued',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    model: 'gemini-4-neon',
    outputIds: [],
  };
  await delivery.sync(
    [dest, sessionId, scope],
    { ...snapshot, turns: [compactTurn], messages: [] },
    [{
      schemaVersion: 1,
      eventId: 'ev-compact',
      sessionId,
      objectId: 'turn-compact-actual',
      objectRevision: 1,
      sequence: 20,
      type: 'turn.updated',
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      operationId: 'op-compact-queued',
      cursor: '20',
      data: compactTurn,
    }],
    [],
    () => false,
  );
  assert.match(sends.at(-1)?.title ?? '', /上下文已压缩/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channel_turn_reply_cards WHERE turn_id=?').get(compactTurn.turnId)?.n, 1);

  // Guardrail check: when card_id is NULL (initial send unknown), must NOT duplicate-send.
  const turnNoCard = 'turn-nocard';
  db.prepare(`INSERT INTO channel_stream_cards VALUES (?,?,?,?,NULL,0,?,0,'',0)`)
    .run(dest, sessionId, scope, turnNoCard, Date.now() - 10_000);
  db.prepare(`INSERT INTO channel_deliveries VALUES ('turn-create:unknown', 'unknown')`).run();
  db.prepare(`INSERT INTO channel_turn_card_attempts VALUES (?,?,?,?,?)`).run(
    dest,
    sessionId,
    scope,
    turnNoCard,
    JSON.stringify({
      view: { schema: '2.0', status: 'running', title: '进行中', signature: 'sig-0', delivery: 'turn-create:unknown', dirty: 1 },
      plain: false,
      retryAfter: 0,
    }),
  );
  const sendsBeforeNoCard = sends.length;
  const turn2: Turn = { ...completedTurn, turnId: turnNoCard };
  await delivery.sync([dest, sessionId, scope], { ...snapshot, turns: [turn2], messages: [] }, [], [], () => false);
  assert.equal(sends.length, sendsBeforeNoCard + 1, 'only the independent reply is sent');
  assert.match(sends.at(-1)!.deliveryId, /^turn-reply:/);
  delivery.close();
});

function dualCardFixture(t: import('node:test').TestContext) {
  const start = Date.parse('2026-11-27T17:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE channel_delivery_diagnostics (delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL, platform_code INTEGER);
    CREATE TABLE channel_history_baselines (destination TEXT, session_id TEXT, binding_scope TEXT);
  `);
  const session = makeSession({ status: 'running' });
  const turn: Turn = { turnId: 'turn', sessionId: session.sessionId, status: 'running', inputId: null,
    model: 'gemini-4-carbon', startedAt: new Date(start).toISOString(), endedAt: null, outputIds: [] };
  const key: [string, string, string] = ['topic', session.sessionId, 'interactive'];
  const writes: Array<{ kind: 'send' | 'patch'; id: string; delivery: string; card: import('../src/unified/feishu-cards.js').ChannelCard }> = [];
  const wakes: string[] = [];
  const service = {
    getContextUsage: async () => ({ usedTokens: 850_000, maxTokens: 1_000_000, cacheReadTokens: 91, totalInputTokens: 100 }),
    getConfirmedSettings: async () => ({ preferences: { reasoningEffort: 'high' } }),
    findRegisteredReplyFiles: async () => ['a', 'b', 'c', 'd'].map(name =>
      ({ artifactId: name, name: name + '.txt', contentVersion: '1', sessionId: session.sessionId, mediaType: 'text/plain', size: 1 })),
  } as unknown as UnifiedService;
  const port: FeishuPort = {
    async send(_destination, card, delivery) {
      const id = `card-${writes.length + 1}`;
      writes.push({ kind: 'send', id, delivery, card });
      return id;
    },
    async update(_destination, id, card, delivery) { writes.push({ kind: 'patch', id, delivery, card }); },
    async sendText() { assert.fail('final card is the completion notification'); },
    async sendFile() {},
  };
  const open = () => new TurnCardDelivery(db, service, port, {
    async guard() {}, stamp: (_dest, card) => card, wake: destination => wakes.push(destination),
  });
  let delivery = open();
  t.after(() => { delivery.close(); db.close(); });
  const restart = () => { delivery.close(); delivery = open(); };
  const message = (text: string, revision = 1, final = false): Message => ({
    messageId: 'message', sessionId: session.sessionId, turnId: turn.turnId, source: 'agy', sequence: 1, revision, final,
    role: 'assistant', blocks: [{ type: 'text', text }],
  });
  const sync = async (current: Turn, draft?: Message, tools: NonNullable<SessionSnapshot['turnProgress']>['tools'] = [], withEvent = true) => {
    const messages = draft ? [draft] : [];
    const snapshot: SessionSnapshot = {
      session, turns: [current], messages, interactions: [], turnProgress: { tools, timing: [] },
    };
    const event = { schemaVersion: 1 as const, eventId: 'e', sessionId: current.sessionId, objectId: current.turnId,
      objectRevision: 1, sequence: 1, type: 'turn.updated' as const, occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(), operationId: null, cursor: '1', data: current };
    await delivery.sync(key, snapshot, withEvent ? [event] : [], withEvent ? messages : [], () => true);
  };
  return { db, port, sync, restart, turn, message, writes, wakes, key, start };
}

test('tool turn archives process before delivering the standalone reply and metadata', async t => {
  const x = dualCardFixture(t);
  const tools = [{ turnId: x.turn.turnId, callId: 'read', phase: 'running' as const, tool: 'Read', summary: 'Read · report', sequence: 1, connectionGeneration: 1 }];
  await x.sync(x.turn, x.message('draft preview'), tools);
  assert.equal(x.writes.length, 1);
  const process = x.writes[0]!;
  assert.equal(process.card.template, 'blue');
  assert.match(process.card.statusBanner!, /缓存命中 91%/);
  assert.equal(process.card.executionLog?.expanded, true);
  assert.match(process.card.executionLog?.runningNote ?? '', /Read/);
  assert.equal(process.card.text, 'draft preview');
  assert.deepEqual(process.card.actions[0]?.value, {
    action: 'stop', turnId: x.turn.turnId, revision: 3, controlGeneration: 2, lockTurn: true,
  });
  assert.equal(process.card.subtitle, undefined);
  assert.ok(!process.card.headerTags?.length);
  t.mock.timers.tick(2500);
  const final = 'FINAL_HEAD\n\n' + '中'.repeat(10_000) + '\n\nFINAL_TAIL';
  await x.sync({ ...x.turn, status: 'completed', endedAt: new Date().toISOString() },
    x.message(final, 2, true), [{ ...tools[0]!, phase: 'failed' }]);
  assert.deepEqual(x.writes.map(write => write.kind), ['send', 'patch', 'send']);
  const [, archive, reply] = x.writes;
  assert.equal(archive!.id, process.id);
  assert.match(archive!.delivery, /^turn-process-final:/);
  assert.equal(archive!.card.executionLog?.expanded, false);
  assert.equal(archive!.card.statusBanner, undefined);
  assert.match(archive!.card.text, /过程已归档/);
  assert.doesNotMatch(archive!.card.text, /draft preview|FINAL_HEAD/);
  assert.ok(archive!.card.actions.every(action => action.value.action !== 'stop'));
  assert.notEqual(reply!.id, process.id);
  assert.match(reply!.delivery, /^turn-reply:/);
  assert.equal(reply!.card.title, 'Antigravity · 回复');
  assert.equal(reply!.card.executionLog, undefined);
  assert.match(reply!.card.text, /^FINAL_HEAD/);
  assert.match(reply!.card.text, /FINAL_TAIL$/);
  assert.ok(Buffer.byteLength(reply!.card.text) <= 20_000);
  assert.match(reply!.card.footer!, /850K.*85%.*缓存命中 91%/);
  assert.match(reply!.card.footer!, /🧠 .*carbon.*high.* · 🔧 1 步（失败 1） · ⏱ .* · 🕒 \d{2}:\d{2}/i);
  assert.deepEqual(reply!.card.actions.map(action => action.value.action),
    ['full_reply', 'file', 'file', 'file', 'compact', 'models', 'panel']);
  const compact = reply!.card.actions.find(action => action.value.action === 'compact');
  assert.equal(compact?.type, 'primary');
  assert.match(compact?.label ?? '', /\(85%\)/);
  const wire = encodeCard(reply!.card) as { body: { elements: Array<{ tag: string; content?: string }> } };
  const divider = wire.body.elements.findIndex(element => element.tag === 'hr');
  assert.ok(divider > 0);
  assert.ok(wire.body.elements.slice(0, divider).every(element => element.tag === 'markdown'));
  assert.ok(wire.body.elements.slice(0, divider).map(element => element.content).join('\n\n') === reply!.card.text);
  assert.deepEqual(wire.body.elements[divider], { tag: 'hr' });
  assert.equal(wire.body.elements[divider + 1]?.content, reply!.card.footer);
});

test('pure text waits for the process delay, and a text-only terminal turn can skip it', async t => {
  const x = dualCardFixture(t);
  const delayMs = Number(process.env.FEISHU_PROCESS_CARD_DELAY_MS ?? 5000);
  await x.sync(x.turn, x.message('short draft'));
  t.mock.timers.tick(delayMs - 1);
  await x.sync(x.turn, x.message('short draft'));
  assert.equal(x.writes.length, 0);
  await x.sync({ ...x.turn, status: 'completed', endedAt: new Date().toISOString() }, x.message('short answer', 2, true));
  assert.deepEqual(x.writes.map(write => [write.kind, write.card.text]), [['send', 'short answer']]);
  t.mock.timers.tick(delayMs);
  assert.deepEqual(x.wakes, [], 'terminal settled before the delayed wake');

  const next = { ...x.turn, turnId: 'long', startedAt: new Date().toISOString() };
  const partial = { ...x.message('long draft'), messageId: 'long-msg', turnId: 'long' };
  await x.sync(next, partial);
  assert.equal(x.writes.length, 1);
  t.mock.timers.tick(delayMs);
  assert.deepEqual(x.wakes, ['topic']);
  await x.sync(next, partial, [], false);
  assert.equal(x.writes[1]?.card.text, 'long draft');
  assert.equal(x.writes[1]?.card.template, 'blue');
  t.mock.timers.tick(2500);
  await x.sync({ ...next, status: 'completed' }, { ...partial, final: true, revision: 2 });
  assert.deepEqual(x.writes.slice(1).map(write => write.kind), ['send', 'patch', 'send']);
});

test('empty failed and interrupted turns send final replies with distinct terminal states', async t => {
  const x = dualCardFixture(t);
  await x.sync({ ...x.turn, status: 'failed' });
  await x.sync({ ...x.turn, turnId: 'interrupted', status: 'interrupted' });
  assert.deepEqual(x.writes.map(({ card }) => [card.template, card.title, card.text]), [
    ['red', 'Antigravity · 执行失败', '本轮执行失败，未形成完整回复。'],
    ['grey', 'Antigravity · 已中断', '本轮已中断，未形成完整回复。'],
  ]);
  for (const { card } of x.writes) {
    assert.match(card.footer!, /🔧 0 步 · 🕒 \d{2}:\d{2}/);
    assert.deepEqual(card.actions.map(action => action.value.action), ['compact', 'models', 'panel']);
  }
});

test('late duration and a higher-revision reply patch the existing reply after restart', async t => {
  const x = dualCardFixture(t);
  const completed = { ...x.turn, status: 'completed' as const };
  const tools = [
    { turnId: x.turn.turnId, callId: 'thinking', phase: 'succeeded' as const, tool: 'thinking', summary: '思考完成',
      sequence: 1, connectionGeneration: 1 },
    { turnId: x.turn.turnId, callId: 'read', phase: 'succeeded' as const, tool: 'Read', summary: 'Read · report',
      sequence: 2, connectionGeneration: 1 },
  ];
  await x.sync(completed, x.message('initial reply', 1, true), tools);
  x.restart();
  t.mock.timers.tick(125_000);
  const timed = { ...completed, endedAt: new Date().toISOString() };
  await x.sync(timed, x.message('initial reply', 1, true));
  t.mock.timers.tick(2500);
  await x.sync(timed, x.message('revised reply', 2, true));
  t.mock.timers.tick(2500);
  await x.sync(completed, x.message('stale reply', 1, true));
  await x.sync(completed);
  await x.sync(timed, x.message('revised reply', 2, true));
  assert.deepEqual(x.writes.map(write => write.kind), ['send', 'patch', 'patch']);
  assert.equal(new Set(x.writes.map(write => write.id)).size, 1);
  assert.doesNotMatch(x.writes[0]!.card.footer!, /⏱/);
  assert.match(x.writes[1]!.card.footer!, /⏱ 2分05秒/);
  assert.equal(x.writes[2]!.card.text, 'revised reply');
  for (const { card } of x.writes) assert.match(card.footer!, /🔧 1 步/);
});

for (const status of ['completed', 'failed', 'interrupted'] as const) {
  test(`already sent legacy ${status} card stays settled after upgrade and rescan`, async t => {
    const x = dualCardFixture(t);
    const delivery = 'turn-final:legacy';
    x.db.prepare('INSERT INTO channel_deliveries VALUES (?,?)').run(delivery, 'sent');
    x.db.prepare(`INSERT INTO channel_turn_card_views
      (destination,session_id,binding_scope,turn_id,schema,status,title,signature,delivery,dirty)
      VALUES (?,?,?,?,'2.0',?,'legacy','legacy',?,0)`).run(...x.key, x.turn.turnId, status, delivery);
    x.restart();
    await x.sync({ ...x.turn, status }, x.message('existing reply', 2, true));
    await x.sync({ ...x.turn, status }, x.message('late reply', 3, true));
    assert.deepEqual(x.writes, []);
    assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM channel_turn_reply_cards').get()?.n, 0);
  });
}

for (const dirty of [undefined, 0, 1] as const) {
  test(`legacy final stream slot stays settled with a pruned receipt and a pending input (dirty=${dirty})`, async t => {
    const x = dualCardFixture(t);
    const key = [...x.key, x.turn.turnId];
    const turn = { ...x.turn, status: 'completed' as const };
    x.db.prepare("INSERT INTO channel_stream_cards VALUES (?,?,?,?,?,1,?,1,'',0)")
      .run(...key, 'legacy-card', x.start - 10_000);
    if (dirty !== undefined) {
      x.db.prepare(`INSERT INTO channel_turn_card_views
        (destination,session_id,binding_scope,turn_id,schema,status,title,signature,delivery,dirty)
        VALUES (?,?,?,?,'1.0','completed','legacy','legacy','turn-final:legacy',?)`).run(...key, dirty);
    }
    x.db.prepare('INSERT INTO channel_turn_pending_finalization VALUES (?,?,?,?,?)')
      .run(...key, JSON.stringify({ turn, timing: { startedMs: x.start, endedMs: x.start + 1000 } }));
    x.restart();
    await x.sync(turn, undefined, [], false);
    await x.sync(turn, x.message('late reply', 2, true));
    assert.deepEqual(x.writes, []);
    assert.equal(x.db.prepare('SELECT card_id FROM channel_stream_cards').get()?.card_id, 'legacy-card');
    assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM channel_turn_reply_cards').get()?.n, 0);
    assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM channel_turn_pending_finalization').get()?.n, 0);
  });
}

test('an unfinished legacy pending finalization without tool rows delivers the reply after restart', async t => {
  const x = dualCardFixture(t);
  const turn = { ...x.turn, status: 'completed' as const };
  x.db.prepare('INSERT INTO channel_turn_pending_finalization VALUES (?,?,?,?,?)')
    .run(...x.key, turn.turnId, JSON.stringify({ turn, timing: { startedMs: x.start, endedMs: x.start + 1000 } }));
  x.restart();
  await x.sync(turn, undefined, [], false);
  assert.deepEqual(x.writes.map(write => write.kind), ['send']);
  assert.match(x.writes[0]!.delivery, /^turn-reply:/);
  assert.match(x.writes[0]!.card.footer!, /⏱ 1秒/);
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM channel_turn_pending_finalization').get()?.n, 0);
});
