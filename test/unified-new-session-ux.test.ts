import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PlatformPort, UnifiedService } from '../src/unified/adapter.js';
import { classifyAgyPermission } from '../src/unified/agy/adapter-permission.js';
import { buildProjectFilesCard } from '../src/unified/artifact-tree-card.js';
import { formatApprovalAction, formatReadableProjectPath, shortenHomePath } from '../src/unified/card-formatters.js';
import type { Capabilities, Session } from '../src/unified/contracts.js';
import { encodeCard } from '../src/unified/feishu-card-wire.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';
import { parseFeishuAction, parseFeishuText } from '../src/unified/feishu-codec.js';
import { buildSessionPanel, noticePanel } from '../src/unified/feishu-session-panel.js';
import { buildMainHelpCard, buildSessionHelpCard } from '../src/unified/help-cards.js';
import { NewSessionDrafts } from '../src/unified/new-session-drafts.js';
import { draftCard } from '../src/unified/new-session-flow.js';
import { UnifiedCore } from '../src/unified/service.js';
import { sessionListCard } from '../src/unified/session-list-card.js';
import { UnifiedStore } from '../src/unified/store.js';
import { ToolProgressTracker, summarizeTool } from '../src/unified/tool-progress.js';
import { topicRootCard } from '../src/unified/topic-title-sync.js';
import { TurnCardDelivery } from '../src/unified/turn-card-delivery.js';
import { turnProgressCard } from '../src/unified/turn-progress-card.js';

const fullCaps: Capabilities = {
  view: { status: 'available' },
  send: { status: 'available' },
  queue: { status: 'available' },
  steer: { status: 'unsupported', reason: 'unsupported' },
  answer: { status: 'available' },
  approve: { status: 'available' },
  interrupt: { status: 'available' },
  handoff: { status: 'available' },
  files: { status: 'available' },
  config: { status: 'available' },
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-ux-1',
    native: { provider: 'agy', hostId: 'local', serviceId: 'agy-svc', nativeSessionId: 'conv-ux-1' },
    project: join(homedir(), 'workspace', 'feishu-agent-bridge'),
    title: '新建会话分区测试',
    status: 'idle',
    updatedAt: '2026-11-27T10:00:00.000Z',
    revision: 1,
    capabilities: fullCaps,
    control: { serviceId: 'agy-svc', owner: 'feishu', input: 'available', generation: 1, operationId: null, reason: null },
    ...overrides,
  };
}

test('/new draftCard renders Card 2.0 step sections, isolates Agent buttons from folder groups, and labels homedir() as "~ (主目录)"', () => {
  const home = homedir();
  const roots = [
    join(home, 'workspace'),
    join(home, 'papers'),
    join(home, 'research'),
    home,
  ];
  const draft = {
    token: 'abcdefghijklmnopqrstuv',
    event_id: 'ev-1',
    owner: '["feishu","ou_owner"]',
    destination: 'oc_main',
    scope: 'scope-1',
    card_message_id: 'om_draft_1',
    provider: 'agy' as const,
    projects: [
      join(home, 'workspace', 'feishu-agent-bridge'),
      join(home, 'workspace', 'gui-rl'),
      join(home, 'papers', 'my-paper'),
      join(home, 'workspace'),
      join(home, 'papers'),
      home,
    ],
    initial_prompt: null,
    revision: 0,
    expires_at: Date.now() + 60_000,
    state: 'open' as const,
    create_operation_id: null,
    chosen_index: null,
    create_context: null,
  };

  const card = draftCard(draft, ['agy', 'codex', 'claude'], roots);
  assert.equal(card.schema, '2.0');
  assert.equal(card.template, 'blue');
  assert.equal(card.title, '新建会话');
  assert.equal(card.subtitle, '第 1 步选执行 Agent · 第 2 步点文件夹开启话题');
  assert.deepEqual(card.headerTags, [{ text: 'Agent：Antigravity', color: 'purple' }]);
  assert.doesNotMatch(card.text, /首句任务/);
  assert.match(card.text, /当前后端：Antigravity/);

  assert.ok(card.sections && card.sections.length === 4);
  // Section 0: Only Agent buttons
  assert.deepEqual(
    card.sections[0]!.actions?.map(a => a.label),
    ['✓ Antigravity', 'Codex', 'Claude'],
  );
  assert.ok(card.sections[0]!.actions?.every(a => a.value.action === 'new_provider'));

  // Section 1 & 2: Grouped subprojects by parent root
  assert.equal(card.sections[1]!.dividerBefore, true);
  assert.match(card.sections[1]!.text ?? '', /第 2 步 · 选择会话所属文件夹/);
  assert.match(card.sections[1]!.text ?? '', /所属路径：`~\/workspace`/);
  assert.deepEqual(card.sections[1]!.actions?.map(a => a.label), ['feishu-agent-bridge', 'gui-rl']);

  assert.match(card.sections[2]!.text ?? '', /所属路径：`~\/papers`/);
  assert.deepEqual(card.sections[2]!.actions?.map(a => a.label), ['my-paper']);

  // Section 3: Top-level workspace roots with "~ (主目录)" instead of "zhangzy"
  assert.equal(card.sections[3]!.dividerBefore, true);
  assert.match(card.sections[3]!.text ?? '', /直接进入顶层工作区目录/);
  assert.deepEqual(card.sections[3]!.actions?.map(a => a.label), ['~/workspace', '~/papers', '~ (主目录)']);
  assert.ok(!card.actions.some(a => a.label === home.split('/').at(-1)));

  // Top-level actions invariant: 3 providers + 6 unique indices 0..5
  const pickIndices = card.actions.filter(a => a.value.action === 'new_pick').map(a => a.value.i);
  assert.equal(pickIndices.length, 6);
  assert.deepEqual([...pickIndices].sort((a, b) => Number(a) - Number(b)), [0, 1, 2, 3, 4, 5]);

  // Wire encoding check: Card 2.0 header subtitle + text_tag_list + hr dividers
  const encoded = encodeCard(card) as { schema: string; header: Record<string, unknown>; body: { elements: Array<{ tag: string }> } };
  assert.equal(encoded.schema, '2.0');
  assert.ok(encoded.body.elements.some(el => el.tag === 'hr'));

  // Direct NewSessionDrafts check: in-memory explicit_project survives selectProvider
  const memDraftDb = new DatabaseSync(':memory:');
  try {
    const drafts = new NewSessionDrafts(memDraftDb);
    const env = { eventId: 'e1', destination: 'oc_main', cardMessageId: 'om_1', identity: { source: 'feishu', subject: 'u1' } };
    const opened = drafts.open(env, 's1', 'agy', draft.projects, '首句', draft.projects[0]);
    drafts.setCardMessage(opened.token, 'om_1');
    assert.equal(opened.explicit_project, draft.projects[0]);
    const switched = drafts.selectProvider(opened.token, 0, 'codex', env, 's1');
    assert.equal(switched?.provider, 'codex');
    assert.equal(switched?.explicit_project, draft.projects[0]);
  } finally {
    memDraftDb.close();
  }
});

test('/new preserves explicitProject across Agent switch without SQLite schema changes and renders rich creation receipts', async () => {
  const rawDir = mkdtempSync(join(tmpdir(), 'fab-new-ux-flow-'));
  const dir = realpathSync(rawDir);
  const wsRoot = join(dir, 'workspace');
  const explicitDir = join(wsRoot, 'target-app');
  const siblingDir = join(wsRoot, 'other-app');
  mkdirSync(explicitDir, { recursive: true });
  mkdirSync(siblingDir, { recursive: true });

  const coreDb = join(dir, 'core.sqlite');
  const channelDb = join(dir, 'channel.sqlite');
  const store = new UnifiedStore(coreDb);
  const createdProjects: Array<{ provider: string; project: string }> = [];

  const makePort = (providerName: 'agy' | 'codex'): PlatformPort => ({
    provider: providerName,
    onObservation: () => () => {},
    list: async () => ({ items: [makeSession({ sessionId: `${providerName}-1`, project: siblingDir })], nextCursor: null }),
    read: async () => ({ session: makeSession({ project: explicitDir }), messages: [], interactions: [], connectionGeneration: 1 }),
    resume: async () => ({ status: 'submitted', nativeReference: 'conv-new', connectionGeneration: 1 }),
    create: async (cwd) => {
      createdProjects.push({ provider: providerName, project: cwd });
      const created = makeSession({
        sessionId: `created-${providerName}`,
        native: { provider: providerName, hostId: 'local', serviceId: `${providerName}-svc`, nativeSessionId: `native-${providerName}` },
        project: cwd,
        title: '新对话',
      });
      return { status: 'submitted', nativeReference: `native-${providerName}`, createdSession: created, connectionGeneration: 1 };
    },
    input: async () => ({ status: 'submitted', nativeReference: 'turn-1' }),
    interrupt: async () => ({ status: 'submitted', nativeReference: 'turn-1' }),
    respond: async () => ({ status: 'submitted', nativeReference: 'int-1' }),
    listArtifacts: async () => [],
    readArtifact: async () => new Uint8Array(),
    listModels: async () => [],
    updateSettings: async () => ({ status: 'submitted', nativeReference: null }),
    control: async () => ({ status: 'submitted', nativeReference: null }),
  });

  const core = new UnifiedCore(store, [makePort('agy'), makePort('codex')], () => true, () => true);
  const cards = new Map<string, ChannelCard>();
  const patchHistory: ChannelCard[] = [];
  let rootCardCaptured: ChannelCard | undefined;
  const topicDest = 'topic:created-1';

  const port: FeishuPort = {
    isTopicDestination: d => d === topicDest,
    chatDestination: d => (d === topicDest ? 'oc_main' : d),
    createTopic: async (_d, _s, card, _id, guard) => {
      await guard?.();
      rootCardCaptured = card;
      return topicDest;
    },
    topicLinkForSession: async () => 'https://applink.feishu.cn/client/thread/open?test=1',
    send: async (_d, card, id, guard) => {
      await guard?.();
      cards.set(id, card);
      return id;
    },
    update: async (_d, id, card, _deliveryId, guard) => {
      await guard?.();
      cards.set(id, card);
      patchHistory.push(card);
    },
    sendFile: async () => {},
  };

  const channel = new FeishuChannel(core, port, async () => true, channelDb, undefined, false, {
    allowedProjectRoots: [wsRoot, dir],
    enabledProviders: ['agy', 'codex'],
  });
  const identity = { source: 'feishu', subject: 'ou_owner' };

  try {
    // Verify SQLite schema of channel_new_session_drafts has ZERO extra columns
    const checkDb = new DatabaseSync(channelDb, { readOnly: true });
    try {
      const cols = (checkDb.prepare('PRAGMA table_info(channel_new_session_drafts)').all() as Array<{ name: string }>).map(c => c.name);
      assert.ok(!cols.includes('explicit_project'));
    } finally {
      checkDb.close();
    }

    const cmd = parseFeishuText(`/new "${explicitDir}" 先检查接口契约`);
    assert.deepEqual(cmd, { action: 'new_help', project: explicitDir, initialPrompt: '先检查接口契约' });
    await channel.handle({ eventId: 'ev-open', destination: 'oc_main', identity }, cmd);

    const draftMsgId = 'ev-open:new-draft';
    const initialDraft = cards.get(draftMsgId)!;
    assert.match(initialDraft.text, /指定目标文件夹/);
    assert.match(initialDraft.text, /首句任务：先检查接口契约/);

    // Switch provider from Antigravity to Codex: explicitProject highlight must survive!
    const switchCodex = parseFeishuAction(initialDraft.actions.find(a => a.label === 'Codex')!.value);
    await channel.handle({ eventId: 'ev-switch', destination: 'oc_main', cardMessageId: draftMsgId, identity }, switchCodex);

    const switchedDraft = cards.get(draftMsgId)!;
    assert.match(switchedDraft.text, /当前后端：Codex/);
    assert.match(switchedDraft.text, /指定目标文件夹/);
    assert.deepEqual(switchedDraft.headerTags, [{ text: 'Agent：Codex', color: 'turquoise' }]);
    const primaryPick = switchedDraft.actions.find(a => a.value.action === 'new_pick' && a.type === 'primary');
    assert.ok(primaryPick, 'explicit target folder button should remain primary after switching Agent');
    assert.equal(primaryPick.label, 'target-app');

    // Pick target-app -> verify showDraftProgress and final completion receipt card
    const op = await channel.handle(
      { eventId: 'ev-pick', destination: 'oc_main', cardMessageId: draftMsgId, identity },
      parseFeishuAction(primaryPick.value),
    ) as { operationId: string };
    const progressCard = patchHistory.at(-1)!;
    assert.equal(progressCard.schema, '2.0');
    assert.equal(progressCard.title, '正在创建 Codex 会话…');
    assert.match(progressCard.text, /🤖 \*\*Agent\*\*：Codex/);
    assert.match(progressCard.text, /📂 \*\*文件夹\*\*：`.*target-app`/);

    const dispatched = await core.dispatch(op.operationId);
    assert.equal(dispatched.status, 'completed');
    const derived = await channel.advanceOperation(op.operationId);
    if (derived) await core.dispatch(derived.operationId);
    await channel.advanceCompleted();

    assert.deepEqual(createdProjects, [{ provider: 'codex', project: explicitDir }]);
    const finalDraftCard = cards.get(draftMsgId)!;
    assert.equal(finalDraftCard.schema, '2.0');
    assert.equal(finalDraftCard.title, '会话已创建 · Codex');
    assert.equal(finalDraftCard.template, 'green');
    assert.match(finalDraftCard.text, /🤖 \*\*Agent\*\*：Codex\s+｜\s+📂 \*\*路径\*\*：`.*target-app`/);
    assert.equal(finalDraftCard.actions[0]?.label, '打开话题');

    assert.ok(rootCardCaptured);
    assert.equal(rootCardCaptured.schema, '2.0');
    assert.ok(rootCardCaptured.subtitle?.includes('target-app'));
    assert.deepEqual(rootCardCaptured.headerTags, [{ text: 'Codex', color: 'turquoise' }]);
  } finally {
    channel.close();
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readable paths, sessionListCard sections, topicRootCard, /panel, /help, /ls tip, and /file <path> parsing work cohesively', () => {
  const home = homedir();
  assert.equal(formatReadableProjectPath(home), '~ (主目录)');
  assert.equal(formatReadableProjectPath(join(home, 'workspace', 'feishu-agent-bridge')), '~/workspace/feishu-agent-bridge');
  const deepPath = join(home, 'workspace', 'nested-group', 'deep-layer', 'very-long-subproject-folder');
  const shortenedDeep = formatReadableProjectPath(deepPath, 34);
  assert.ok([...shortenedDeep].length <= 34);
  assert.match(shortenedDeep, /^~\/workspace\/…\//);

  const list = sessionListCard(
    [
      makeSession({ sessionId: 's1', project: home, title: '主目录笔记整理' }),
      makeSession({ sessionId: 's2', native: { provider: 'codex', hostId: 'h', serviceId: 's', nativeSessionId: 'n2' }, project: join(home, 'workspace', 'gui-rl'), title: 'RL 实验排查' }),
    ],
    { provider: 'all', providerFilters: true, nextCursor: 'c-next' },
  );
  assert.equal(list.schema, '2.0');
  assert.match(list.text, /Antigravity · `~ \(主目录\)`/);
  assert.match(list.text, /Codex · `~\/workspace\/gui-rl`/);
  assert.equal(list.sections?.length, 2);
  assert.equal(list.sections?.[1]?.dividerBefore, true);
  assert.equal(list.sections?.[0]?.actions?.length, 3); // 2 bind + 1 next page
  assert.equal(list.sections?.[1]?.actions?.length, 4); // 4 provider filters
  // Mutating card.text (as showSessionList does for keyword search) propagates into section[0].text
  list.text = `筛选关键词：RL\n\n${list.text}`;
  assert.match(list.sections?.[0]?.text ?? '', /^筛选关键词：RL/);

  const root = topicRootCard(makeSession({ status: 'running', title: '多模型协同验证' }));
  assert.equal(root.schema, '2.0');
  assert.equal(root.subtitle, '~/workspace/feishu-agent-bridge · 运行中');
  assert.deepEqual(root.headerTags, [{ text: 'Antigravity', color: 'purple' }]);
  assert.match(root.text, /^\*\*多模型协同验证\*\*\nAntigravity · `~\/workspace\/feishu-agent-bridge` · 运行中$/);

  const session = makeSession({ status: 'running' });
  const notice = noticePanel(session, { paused: false, completed: true, waiting: true, failed: true, revision: 0 });
  const roPanel = buildSessionPanel(session, notice, null);
  assert.match(roPanel.text, /🤖 Agent：Antigravity/);
  assert.match(roPanel.text, /📂 路径：`~\/workspace\/feishu-agent-bridge`/);
  assert.match(roPanel.text, /状态：只读/);
  const rwPanel = buildSessionPanel(session, notice, { runningTurns: [], queuedInputs: [], canArchive: true });
  assert.match(rwPanel.text, /🤖 Agent：Antigravity/);
  assert.match(rwPanel.text, /📂 路径：`~\/workspace\/feishu-agent-bridge`/);
  assert.match(rwPanel.text, /状态：运行中/);

  const mainHelp = buildMainHelpCard();
  assert.match(mainHelp.text, /\/new \[agy\|codex\|claude\] \[路径\] \[首句\]/);
  assert.match(mainHelp.text, /\/quota/);
  const sessionHelp = buildSessionHelpCard('agy', 'interactive');
  assert.match(sessionHelp.text, /\/file <相对路径>/);
  assert.match(sessionHelp.text, /\/rename <新标题>/);
  assert.match(sessionHelp.text, /\/quota/);

  const lsCard = buildProjectFilesCard({
    kind: 'dir',
    path: '.',
    parent: null,
    total: 2,
    hidden: 1,
    entries: [
      { name: 'src', kind: 'dir', size: 0, mtimeMs: 0 },
      { name: 'README.md', kind: 'file', size: 512, mtimeMs: 0 },
    ],
  });
  assert.match(lsCard.text, /💡 发送 \/file <相对路径> 可直接把文件发到飞书，\/ls -a 查看隐藏文件/);

  assert.deepEqual(parseFeishuText('/file'), { action: 'artifacts' });
  assert.deepEqual(parseFeishuText('/file outputs/report.md'), { action: 'deliver_files', args: 'outputs/report.md' });
});

test('agent-dispatch v3.2 progress visualization, manage_task, failed/interrupted elapsed headers, activeSubagents passthrough, and permission gate', async () => {
  // 1. agent_dispatch with object & JSON-string Arguments (real ACP fidelity) + secret scrubbing
  assert.equal(
    summarizeTool('call_mcp_tool', {
      ServerName: 'agent-dispatch_mcp',
      ToolName: 'agent_dispatch',
      Arguments: JSON.stringify({
        model: 'carbon-high',
        agent: 'review-core',
        prompt: 'DO NOT LEAK SECRET PROMPT',
        apiKey: 'sk-secret-token',
      }),
    }).summary,
    '⚡ Agent Dispatch (carbon-high · review-core · 跨模型派发)',
  );
  assert.equal(
    summarizeTool('mcp_agent-dispatch_mcp_agent_dispatch', {
      model: 'sol',
      agent: 'dev-arch-lead',
      prompt: 'hidden',
    }).summary,
    '⚡ Agent Dispatch (sol · dev-arch-lead · 跨模型派发)',
  );
  assert.equal(
    summarizeTool('call_mcp_tool', {
      ServerName: 'agent-dispatch_mcp',
      ToolName: 'agent_status',
      Arguments: {},
    }).summary,
    '⚡ Agent Dispatch (状态查询)',
  );
  assert.equal(summarizeTool('manage_task', { Action: 'status', TaskId: 't-1' }).summary, '🤖 管理后台任务');

  // 2. Tracker preserves agent_dispatch & agent_job metadata when completion clears Arguments
  const tracker = new ToolProgressTracker();
  const ref = makeSession().native;
  const startDispatch = summarizeTool('call_mcp_tool', {
    ServerName: 'agent-dispatch_mcp',
    ToolName: 'agent_dispatch',
    Arguments: { model: 'carbon-high', agent: 'dev-chaos-breaker' },
  });
  tracker.observe(ref, 1, 'turn-1', 'call-disp', 'running', startDispatch);
  const doneDispatch = tracker.observe(ref, 1, 'turn-1', 'call-disp', 'succeeded', summarizeTool('call_mcp_tool', {
    ServerName: 'agent-dispatch_mcp',
    ToolName: 'agent_dispatch',
    Arguments: {},
  }));
  assert.ok(doneDispatch?.type === 'event');
  assert.equal((doneDispatch.event.data as { summary: string }).summary, '⚡ Agent Dispatch (carbon-high · dev-chaos-breaker · 跨模型派发)');

  const startJob = summarizeTool('call_mcp_tool', {
    ServerName: 'agent-dispatch_mcp',
    ToolName: 'agent_job',
    Arguments: { action: 'wait', job_id: 'job-20261127-151000-deadbeef' },
  });
  assert.equal(startJob.summary, '⚡ Agent Dispatch (等待作业 …deadbeef)');
  tracker.observe(ref, 1, 'turn-1', 'call-job', 'running', startJob);
  const doneJob = tracker.observe(ref, 1, 'turn-1', 'call-job', 'succeeded', summarizeTool('call_mcp_tool', {
    ServerName: 'agent-dispatch_mcp',
    ToolName: 'agent_job',
    Arguments: {},
  }));
  assert.ok(doneJob?.type === 'event');
  assert.equal((doneJob.event.data as { summary: string }).summary, '⚡ Agent Dispatch (等待作业 …deadbeef)');

  // 3. turnProgressCard delegated status, runningNote, and failed/interrupted elapsed headers
  const runningCard = turnProgressCard({
    provider: 'agy',
    status: 'running',
    schema: '2.0',
    message: undefined,
    tools: [
      { turnId: 't1', callId: 'c1', phase: 'running', tool: 'manage_task', summary: '🤖 管理后台任务' },
      { turnId: 't1', callId: 'c2', phase: 'running', tool: 'call_mcp_tool', summary: '⚡ Agent Dispatch (carbon-high · review-core · 跨模型派发)' },
    ],
    duration: 30_000,
    files: [],
    turnId: 't1',
    modelBadge: 'carbon high',
  });
  assert.equal(runningCard.title, 'Antigravity · 进行中 · 用时 30秒 · carbon high');
  assert.match(runningCard.text, /\*\*子代理与 Codex 状态\*\*/);
  assert.match(runningCard.text, /⚡ Agent Dispatch \\\(carbon-high · review-core · 跨模型派发\\\)（进行中）/);
  assert.match(runningCard.text, /🤖 管理后台任务（进行中）/);
  assert.equal(runningCard.executionLog?.runningNote, '⏳ ⚡ Agent Dispatch (carbon-high · review-core · 跨模型派发)（另有 1 项并行）');

  const failedCard = turnProgressCard({
    provider: 'codex',
    status: 'failed',
    schema: '2.0',
    message: undefined,
    tools: [],
    duration: 18_000,
    files: [],
    modelBadge: 'sol medium',
  });
  assert.equal(failedCard.title, 'Codex · 执行失败 · 用时 18秒 · sol medium');
  assert.equal(failedCard.template, 'red');

  const interruptedLong = turnProgressCard({
    provider: 'agy',
    status: 'interrupted',
    schema: '2.0',
    message: undefined,
    tools: [],
    duration: 65_000,
    files: [],
    modelBadge: 'carbon medium',
  });
  assert.equal(interruptedLong.title, 'Antigravity · 已中断 · 用时 1分05秒 · carbon medium');
  assert.equal(interruptedLong.template, 'grey');

  // 4. TurnCardDelivery safely forwards activeSubagents and survives reader failure
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE channel_delivery_diagnostics (delivery_id TEXT PRIMARY KEY, kind TEXT, platform_code INTEGER);
    CREATE TABLE channel_history_baselines (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, PRIMARY KEY(destination,session_id,binding_scope));
    CREATE TABLE channel_auto_baselines (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot TEXT NOT NULL, destination TEXT, binding_scope TEXT);
  `);
  const deliveredCards: ChannelCard[] = [];
  const fakePort: FeishuPort = {
    send: async (_d, c) => { deliveredCards.push(c); return 'card-1'; },
    update: async (_d, _m, c) => { deliveredCards.push(c); },
    sendFile: async () => {},
  };
  let shouldThrowSubagents = false;
  const delivery = new TurnCardDelivery(memDb, {} as UnifiedService, fakePort, {
    guard: async () => {},
    stamp: (_d, c) => c,
    wake: () => {},
    readActiveSubagents: async () => {
      if (shouldThrowSubagents) throw new Error('transient subagent db busy');
      return [{ conversationId: 'sub-conv-12345678', agentName: 'dev-qa-gatekeeper', status: 'running' }];
    },
  });
  const runningSession = makeSession({ status: 'running' });
  await delivery.sync(
    ['topic:1', runningSession.sessionId, 'scope-1'],
    {
      session: runningSession,
      turns: [{ turnId: 'turn-sub', sessionId: runningSession.sessionId, status: 'running', startedAt: '2026-11-27T10:00:00Z' } as any],
      messages: [],
      interactions: [],
      turnProgress: {
        tools: [{ turnId: 'turn-sub', callId: 'c-1', phase: 'running', tool: 'manage_task', summary: '🤖 管理后台任务', sequence: 1, connectionGeneration: 1 }],
        timing: [],
      },
    },
    [],
    [],
    () => true,
  );
  assert.match(deliveredCards.at(-1)?.text ?? '', /会话级活跃子代理：dev-qa-gatekeeper/);
  shouldThrowSubagents = true;
  await delivery.sync(
    ['topic:1', runningSession.sessionId, 'scope-1'],
    {
      session: runningSession,
      turns: [{ turnId: 'turn-sub-2', sessionId: runningSession.sessionId, status: 'running', startedAt: '2026-11-27T10:00:05Z' } as any],
      messages: [],
      interactions: [],
      turnProgress: {
        tools: [{ turnId: 'turn-sub-2', callId: 'c-2', phase: 'running', tool: 'manage_task', summary: '🤖 管理后台任务', sequence: 2, connectionGeneration: 1 }],
        timing: [],
      },
    },
    [],
    [],
    () => true,
  );
  delivery.close();
  memDb.close();

  // 5. Approval label + classifyAgyPermission for agent-dispatch_mcp (positive + negative boundaries)
  const approvalView = formatApprovalAction(
    'mcp_agent-dispatch_mcp_agent_dispatch',
    JSON.stringify({
      name: 'mcp_agent-dispatch_mcp_agent_dispatch',
      args: { model: 'carbon-high', agent: 'review-core', cwd: join(homedir(), 'workspace', 'feishu-agent-bridge') },
    }),
    'this_request',
  );
  assert.equal(approvalView.toolLabel, 'MCP · agent-dispatch/agent_dispatch');
  assert.ok(approvalView.compactTarget.includes(shortenHomePath(join(homedir(), 'workspace', 'feishu-agent-bridge'))));

  const permDir = mkdtempSync(join(tmpdir(), 'fab-perm-ad-'));
  try {
    for (const tool of [
      { kind: 'execute', name: 'call_mcp_tool', rawInput: { ServerName: 'agent-dispatch_mcp', ToolName: 'agent_dispatch' } },
      { kind: 'other', name: 'call_mcp_tool', rawInput: { ServerName: 'agent-dispatch_mcp', ToolName: 'agent_job' } },
      { kind: 'other', name: 'call_mcp_tool', rawInput: { ServerName: 'agent-dispatch_mcp', ToolName: 'agent_status' } },
      { kind: 'execute', name: 'mcp_agent-dispatch_mcp_agent_dispatch', rawInput: { model: 'carbon' } },
    ]) {
      assert.equal((await classifyAgyPermission(tool, permDir, { enabled: true })).kind, 'allow_once');
      assert.equal((await classifyAgyPermission(tool, permDir, { enabled: false })).kind, 'ask');
    }
    // Negative boundary: untrusted server or smuggled CommandLine must ask
    assert.equal(
      (await classifyAgyPermission(
        { kind: 'execute', name: 'call_mcp_tool', rawInput: { ServerName: 'evil_mcp', ToolName: 'agent_dispatch' } },
        permDir,
        { enabled: true },
      )).kind,
      'ask',
    );
    assert.equal(
      (await classifyAgyPermission(
        { kind: 'execute', name: 'call_mcp_tool', rawInput: { ServerName: 'agent-dispatch_mcp', ToolName: 'agent_dispatch', CommandLine: 'rm -rf /' } },
        permDir,
        { enabled: true },
      )).kind,
      'ask',
    );
  } finally {
    rmSync(permDir, { recursive: true, force: true });
  }
});
