import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  extractAgyContextUsageFromRows,
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
import { turnProgressCard } from '../src/unified/turn-progress-card.js';
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

  const badge = formatContextUsageBadge(usage);
  assert.deepEqual(badge, { text: '511K / 1M (49%)', pct: 49, color: 'wathet' });
  assert.equal(formatContextUsageBadge({ usedTokens: 850_000, maxTokens: 1_048_576 })?.color, 'orange');
  assert.equal(formatContextUsageBadge({ usedTokens: 980_000, maxTokens: 1_048_576 })?.color, 'red');
  assert.equal(formatCompactTokenCount(1_048_576), '1M');
  assert.equal(resolveModelMaxContextTokens('gpt-6.2-astra', 'codex'), 272_000);
});

test('turnProgressCard v2 renders model + context in header and places thinking + steps BEFORE final answer', () => {
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
  const card = turnProgressCard({
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
    contextUsage: { usedTokens: 510_744, maxTokens: 1_048_576, model: 'gemini-4-neon-medium' },
  });

  assert.match(card.subtitle ?? '', /neon medium/);
  assert.match(card.subtitle ?? '', /511K \/ 1M \(49%\)/);
  assert.equal(card.headerTags?.length, 2);
  assert.equal(card.executionLog?.position, 'top');
  assert.equal(card.executionLog?.expanded, true);

  const wire = encodeCard(card, '2.0') as {
    header: { subtitle?: { content: string }; text_tag_list?: Array<{ text: { content: string } }> };
    body: { elements: Array<{ tag: string; content?: string; elements?: Array<{ content?: string }> }> };
  };
  assert.match(wire.header.subtitle?.content ?? '', /511K \/ 1M/);
  assert.equal(wire.header.text_tag_list?.[0]?.text.content, 'neon medium');
  assert.equal(wire.header.text_tag_list?.[1]?.text.content, '上下文 511K / 1M (49%)');

  const elements = wire.body.elements;
  const bannerIdx = elements.findIndex(el => el.tag === 'markdown' && (el.content ?? '').includes('511K / 1M (49%)'));
  const thinkingIdx = elements.findIndex(el => el.tag === 'markdown' && (el.content ?? '').includes('思考过程'));
  const panelIdx = elements.findIndex(el => el.tag === 'collapsible_panel');
  const hrIdx = elements.findIndex(el => el.tag === 'hr');
  const answerIdx = elements.findIndex(el => el.tag === 'markdown' && (el.content ?? '').includes('最终结论'));
  assert.equal(bannerIdx, 0, 'live context status banner should appear at top of card body');
  assert.ok(thinkingIdx > bannerIdx, 'thinking block should follow context status banner');
  assert.ok(panelIdx > thinkingIdx, 'steps panel should follow thinking');
  assert.ok(hrIdx > panelIdx, 'divider should separate process from final answer');
  assert.ok(answerIdx > hrIdx, 'final answer should appear at bottom after divider');

  const panelBody = elements[panelIdx]!.elements?.[0]?.content ?? '';
  assert.match(panelBody, /1\. ✅ \*\*读取文件\*\*/);
  assert.match(panelBody, /2\. ✅ \*\*执行命令\*\*/);
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

test('TurnCardDelivery recovers completed turn stuck behind orphaned running-unknown PATCH on same card', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE channel_delivery_diagnostics (delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL, platform_code INTEGER);
    CREATE TABLE channel_history_baselines (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(destination,session_id,binding_scope,message_id));
  `);
  const updates: Array<{ cardId: string; title: string; text: string }> = [];
  const sends: string[] = [];
  const port = {
    send: async (_dest: string, _card: unknown, deliveryId: string) => {
      sends.push(deliveryId);
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

  assert.equal(sends.length, 0, 'must NOT create a duplicate card');
  assert.equal(updates.length, 1, 'must PATCH the existing card in-place');
  assert.equal(updates[0]!.cardId, cardId);
  assert.match(updates[0]!.title, /已完成/);
  assert.match(updates[0]!.text, /任务已完成/);

  const remainingPending = db.prepare('SELECT COUNT(*) AS n FROM channel_turn_pending_finalization').get() as { n: number };
  assert.equal(remainingPending.n, 0, 'pending finalization must be cleared');
  const unknownDeliveries = db.prepare("SELECT COUNT(*) AS n FROM channel_deliveries WHERE state='unknown'").get() as { n: number };
  assert.equal(unknownDeliveries.n, 0, 'P0-1: superseded unknown PATCH must be suppressed on confirmCard');

  // P0-1 terminal completed+unknown retry & cap at 3 attempts:
  const turnTerm = 'turn-term-retry';
  db.prepare(`INSERT INTO channel_stream_cards VALUES (?,?,?,?,?,1,?,0,'',0)`)
    .run(dest, sessionId, scope, turnTerm, 'om_term_card', Date.now() - 10_000);
  db.prepare(`INSERT INTO channel_deliveries VALUES ('turn-final:stale', 'unknown')`).run();
  db.prepare(`INSERT INTO channel_turn_card_attempts VALUES (?,?,?,?,?)`).run(
    dest, sessionId, scope, turnTerm,
    JSON.stringify({
      view: { schema: '2.0', status: 'completed', title: '已完成', signature: 'sig-t', delivery: 'turn-final:stale', dirty: 1 },
      plain: false, retryAfter: 0, attempts: 1,
    }),
  );
  await delivery.sync([dest, sessionId, scope], { ...snapshot, turns: [{ ...completedTurn, turnId: turnTerm }], messages: [] }, [], [], () => false);
  assert.equal(updates.at(-1)?.cardId, 'om_term_card', 'terminal unknown PATCH with attempts < 3 retries');
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
  // First sync sends the compact card (since no prior card existed for turn-compact-actual); verify it didn't lose baseline on repeated sync:
  const compactView = db.prepare('SELECT title FROM channel_turn_card_views WHERE turn_id=?').get('turn-compact-actual') as { title: string } | undefined;
  assert.match(compactView?.title ?? '', /上下文已压缩/);

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
  assert.equal(sends.length, sendsBeforeNoCard, 'must NOT duplicate-send when card_id is still unknown');
  delivery.close();
});
