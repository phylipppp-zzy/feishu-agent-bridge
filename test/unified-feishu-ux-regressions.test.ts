import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { parseFeishuAction, parseFeishuText, isBridgeCommand } from '../src/unified/feishu-codec.js';
import { receiveSdkMessage } from '../src/unified/feishu-sdk-port.js';
import { FeishuChannel, type ChannelAction, type FeishuPort } from '../src/unified/feishu-channel.js';
import { questionForm, renderQuestionForm, decodeQuestionForm, DECLINED_ANSWER_MARKER } from '../src/unified/feishu-question-forms.js';
import { encodeCard, cardSchema } from '../src/unified/feishu-card-wire.js';
import { buildHealthCard, buildQuotaCard } from '../src/unified/health-card.js';
import { buildSessionPanel, noticePanel } from '../src/unified/feishu-session-panel.js';
import type { UnifiedService } from '../src/unified/adapter.js';
import type { Interaction, Session, WriteContext } from '../src/unified/contracts.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import type { AgyQuotaSnapshot } from '../src/unified/agy-quota.js';

function topicTextEvent(text: string, messageId = 'm1', rootId = 'root1'): any {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
    message: {
      message_id: messageId,
      chat_id: 'chat',
      chat_type: 'group',
      root_id: rootId,
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}

async function interactiveBind(
  channel: FeishuChannel,
  service: any,
  destination: string,
  sessionId: string,
) {
  const ops = new Map<string, any>();
  const oldAttach = service.attachSession;
  const oldGet = service.getOperation;
  service.attachSession = async ({ context }: any) => {
    const op = {
      operationId: context.operationId,
      targetId: context.targetId,
      action: 'attachSession',
      status: 'completed',
      error: null,
      result: { kind: 'session', sessionId },
    };
    ops.set(op.operationId, op);
    return op;
  };
  service.getOperation = async (id: string) => ops.get(id);
  const env = (eventId: string) => ({ eventId, destination, identity: { source: 'feishu', subject: 'owner' } });
  try {
    await channel.handle(env('bind-ro'), { action: 'bind', sessionId, mode: 'read_only' });
    const up = await channel.handle(env('bind-up'), { action: 'upgrade' }) as { operationId: string };
    await channel.handle(env('bind-fin'), { action: 'finish', operationId: up.operationId });
  } finally {
    service.attachSession = oldAttach;
    service.getOperation = oldGet;
  }
}

test('native slash commands and custom skills pass through in topics without silent /help rewrite', async () => {
  const samples = [
    '/plan 先梳理改造方案',
    '/compact',
    '/goal 跑完回归并汇报',
    '/schedule 每天早上9点巡检',
    '/learn 记住这个约定',
    '/grill-me 设计评审',
    '/sapphire-paper-review papers/demo',
    '/home/zhangzy/workspace/feishu-agent-bridge 看看这个目录',
  ];
  const received: ChannelAction[] = [];
  for (const [idx, text] of samples.entries()) {
    assert.equal(isBridgeCommand(text.split(/\s+/)[0]!), false);
    await receiveSdkMessage(
      topicTextEvent(text, `msg-${idx}`),
      'bot',
      'owner',
      new Set(['chat']),
      async () => Readable.from([]),
      async (_e, a) => { received.push(a); },
      undefined,
      () => 'topic:1',
    );
  }
  assert.equal(received.length, samples.length);
  for (const [idx, text] of samples.entries()) {
    assert.deepEqual(received[idx], { action: 'input', text, mode: 'new' });
  }

  // Malformed known bridge command in a topic produces explicit command_error, not /help
  const errors: ChannelAction[] = [];
  await receiveSdkMessage(
    topicTextEvent('/bind', 'msg-bad'),
    'bot',
    'owner',
    new Set(['chat']),
    async () => Readable.from([]),
    async (_e, a) => { errors.push(a); },
    undefined,
    () => 'topic:1',
  );
  assert.deepEqual(errors, [{ action: 'command_error', command: '/bind', rawText: '/bind' }]);
});

test('/queue and /steer preserve multiline code and indentation', () => {
  const multiline = 'function foo() {\n  const x = 1;\n    return x;\n}';
  assert.deepEqual(parseFeishuText(`/queue ${multiline}`), {
    action: 'input',
    text: multiline,
    mode: 'queue',
  });
  assert.deepEqual(parseFeishuText(`/queue\n  def f():\n    return 1`), {
    action: 'input',
    text: '  def f():\n    return 1',
    mode: 'queue',
  });
  assert.deepEqual(parseFeishuText(`/steer line1\n  indented\n\tTabbed`), {
    action: 'input',
    text: 'line1\n  indented\n\tTabbed',
    mode: 'steer',
  });
});

test('single-arg /model inherits bound provider and running AGY auto-queues with one-click cancel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-ux-model-queue-'));
  const cards: ChannelCard[] = [];
  const submitted: Array<{ mode: string; text: string }> = [];
  const settingsCalls: Array<{ model: string | null; preferences: Record<string, string> }> = [];
  const cancelled: string[] = [];
  const session = {
    sessionId: 'agy-s1',
    native: { provider: 'agy', hostId: 'h', serviceId: 'svc', nativeSessionId: 'n1' },
    project: '/tmp',
    title: 'AGY Session',
    status: 'running',
    revision: 4,
    capabilities: {
      send: { status: 'available' },
      queue: { status: 'available' },
      steer: { status: 'unsupported', reason: 'no steer' },
      interrupt: { status: 'available' },
    },
    control: { input: 'available', generation: 2, owner: 'feishu', serviceId: 'svc', operationId: null, reason: null },
  } as unknown as Session;

  const service: any = {
    getSession: async () => session,
    getWorkState: async () => ({
      runningTurns: [{ turnId: 't1' }],
      queuedInputs: [{ inputId: 'op-queued-1' }],
      canArchive: false,
    }),
    updateSessionSettings: async ({ context, payload }: { context: WriteContext; payload: any }) => {
      settingsCalls.push(payload);
      return { ...context, action: 'updateSessionSettings', status: 'completed', revision: 1, error: null, payloadDigest: 'd' };
    },
    submitInput: async ({ context, mode, blocks }: any) => {
      submitted.push({ mode, text: blocks[0].text });
      return { ...context, operationId: 'op-queued-1', action: 'submitInput', status: 'queued', revision: 1, error: null, payloadDigest: 'd' };
    },
    cancelQueuedInput: async ({ context, payload }: any) => {
      cancelled.push(payload.inputId);
      return { ...context, action: 'cancelQueuedInput', status: 'completed', revision: 1, error: null, payloadDigest: 'd' };
    },
  };
  const port: FeishuPort = {
    isTopicDestination: d => d === 'topic:agy',
    send: async (_d, card) => { cards.push(card); return 'msg-id'; },
    update: async () => {},
    sendFile: async () => {},
  };
  const channel = new FeishuChannel(service as UnifiedService, port, async () => true, join(dir, 'channel.sqlite'));
  const env = (eventId: string) => ({ eventId, destination: 'topic:agy', identity: { source: 'feishu', subject: 'owner' } });
  try {
    await interactiveBind(channel, service, 'topic:agy', 'agy-s1');

    // Single-arg /model
    await channel.handle(env('m-single'), parseFeishuText('/model gemini-4-carbon'));
    assert.deepEqual(settingsCalls, [{ model: 'gemini-4-carbon', preferences: {} }]);

    // Plain text while AGY is running without steer -> auto-queues!
    await channel.handle(env('auto-q'), { action: 'input', text: '顺便把单测也跑一下', mode: 'new' });
    assert.deepEqual(submitted, [{ mode: 'queue', text: '顺便把单测也跑一下' }]);

    const receiptCard = cards.at(-1)!;
    assert.equal(receiptCard.title, '已加入排队');
    const cancelBtn = receiptCard.actions.find(a => a.label === '撤回排队');
    assert.ok(cancelBtn, 'queue receipt card must include one-click 撤回排队 button');

    // Click the cancel button -> round-trips cleanly to cancelQueuedInput
    const cancelAction = parseFeishuAction(cancelBtn.value);
    await channel.handle(env('do-cancel'), cancelAction);
    assert.deepEqual(cancelled, ['op-queued-1']);
  } finally {
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask_question form supports decline button, optional fields, and dropdown+text override', () => {
  const base = {
    interactionId: 'iq1',
    sessionId: 's1',
    turnId: 't1',
    nativeRequestId: 'nr1',
    connectionGeneration: 2,
    revision: 3,
    status: 'awaiting_answer',
    expiresAt: null,
    toolInputDigest: null,
    nativeResult: null,
  } as const;
  const i: Interaction = {
    ...base,
    kind: 'question_group',
    questions: [
      { id: 'q1', prompt: 'Pick one', choices: ['A', 'B'], multiple: false, allowFreeText: true },
      { id: 'q2', prompt: 'Optional note', choices: [], multiple: false, allowFreeText: true, required: false } as any,
    ],
  };
  const form = questionForm(i, 'b1');
  const wire = renderQuestionForm(form) as any;
  const formElements: any[] = wire.body.elements[0].elements;
  const declineBtn = formElements.find(el => el.name === 'decline_question');
  assert.ok(declineBtn, 'form must render decline_question button');
  assert.equal(declineBtn.text.content, '跳过/取消');

  // Optional field hint in placeholder
  const optionalInput = formElements.find(el => el.name === 'q1_text');
  assert.match(optionalInput.placeholder.content, /可选/);

  // Decline callback round-trips without formValues and carries __decline for PendingHub
  const parsedDecline = parseFeishuAction(declineBtn.behaviors[0].value);
  assert.equal(parsedDecline.action, 'answer_form');
  assert.deepEqual((parsedDecline as any).fields, { __decline: true });
  const decodedDecline = decodeQuestionForm(parsedDecline, (parsedDecline as any).fields, i, 'b1');
  assert.equal(decodedDecline.declined, true);
  assert.equal((decodedDecline.answer as any).action, 'decline');
  assert.deepEqual(decodedDecline.answer, {
    kind: 'question_group',
    answers: { q1: [DECLINED_ANSWER_MARKER], q2: [DECLINED_ANSWER_MARKER] },
    action: 'decline',
  });

  // PendingHub passes fields without top-level decline -> still decodes as decline
  const decodedViaPendingHub = decodeQuestionForm(
    { action: 'answer_form', bindingId: 'b1', interactionId: 'iq1', revision: 3, connectionGeneration: 2 },
    { __decline: true },
    i,
    'b1',
  );
  assert.equal(decodedViaPendingHub.declined, true);
  assert.equal((decodedViaPendingHub.answer as any).action, 'decline');

  // Forged __decline in untrusted formValues when button value.decline !== true is rejected
  assert.throws(
    () => parseFeishuAction({ action: 'answer_form', bindingId: 'b1', interactionId: 'iq1', revision: 3, connectionGeneration: 2 }, { __decline: true }),
    /invalid question form callback/,
  );

  // Dropdown + free text both filled -> free text wins, optional field left empty -> succeeds!
  const decodedNormal = decodeQuestionForm(
    { action: 'answer_form', bindingId: 'b1', interactionId: 'iq1', revision: 3, connectionGeneration: 2 },
    { q0_choice: '0', q0_text: 'custom choice', q1_text: '' },
    i,
    'b1',
  );
  assert.deepEqual({ ...(decodedNormal.answer as any).answers }, { q1: ['custom choice'], q2: [] });
});

test('Feishu post rich text extracts ordered text and images, and multi-type attachments stage localPath', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  const received: Array<{ eventId: string; action: ChannelAction }> = [];
  const postEvent: any = {
    sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
    message: {
      message_id: 'post-1',
      chat_id: 'chat',
      chat_type: 'group',
      root_id: 'root1',
      message_type: 'post',
      content: JSON.stringify({
        zh_cn: {
          title: '实验记录',
          content: [
            [{ tag: 'text', text: '第一段说明' }],
            [{ tag: 'img', image_key: 'img_k1' }],
            [{ tag: 'text', text: '第二段说明' }, { tag: 'img', image_key: 'img_k2' }],
          ],
        },
      }),
    },
  };
  await receiveSdkMessage(
    postEvent,
    'bot',
    'owner',
    new Set(['chat']),
    async () => Readable.from([png]),
    async (e, a) => { received.push({ eventId: e.eventId, action: a }); },
    undefined,
    () => 'topic:1',
  );
  assert.equal(received.length, 3);
  assert.deepEqual(received[0]!.action, { action: 'input', text: '实验记录\n第一段说明\n第二段说明', mode: 'new' });
  assert.equal(received[1]!.action.action, 'attachment');
  assert.equal(received[2]!.action.action, 'attachment');
  assert.equal(received[1]!.eventId, 'message:post-1:img:0');
  assert.equal(received[2]!.eventId, 'message:post-1:img:1');

  // Code / Markdown / JSON / YAML / Log / PDF attachments
  const fileCases: Array<[string, Buffer, string | undefined, string]> = [
    ['notes.md', Buffer.from('# Title\nbody'), 'text/markdown', 'text/plain'],
    ['config.json', Buffer.from('{"a":1}'), 'application/json', 'text/plain'],
    ['spec.yaml', Buffer.from('key: value\n'), 'application/yaml', 'text/plain'],
    ['app.log', Buffer.from('[INFO] ok\n'), 'text/plain', 'text/plain'],
    ['script.py', Buffer.from('print("hi")\n'), undefined, 'text/plain'],
    ['paper.pdf', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'), 'application/pdf', 'application/pdf'],
  ];
  for (const [idx, [fileName, bytes, mime, expectedMedia]] of fileCases.entries()) {
    const out: ChannelAction[] = [];
    const fileEvent: any = {
      sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
      message: {
        message_id: `file-${idx}`,
        chat_id: 'chat',
        chat_type: 'p2p',
        message_type: 'file',
        content: JSON.stringify({ file_key: `fk-${idx}`, file_name: fileName, ...(mime ? { mime_type: mime } : {}) }),
      },
    };
    await receiveSdkMessage(
      fileEvent,
      'bot',
      'owner',
      new Set(['chat']),
      async () => Readable.from([bytes]),
      async (_e, a) => { out.push(a); },
    );
    assert.equal(out.length, 1, fileName);
    const att = out[0] as Extract<ChannelAction, { action: 'attachment' }>;
    assert.equal(att.action, 'attachment');
    assert.equal(att.mediaType, expectedMedia);
    assert.ok(att.localPath && existsSync(att.localPath), `${fileName} should be staged locally for AGY read_file`);
    assert.deepEqual(readFileSync(att.localPath!), bytes);
  }
});

test('/new supports [path] [prompt], breaks 5-dir cap, and /create handles spaces in paths', async () => {
  // /create with spaces in path
  assert.deepEqual(parseFeishuText('/create agy "/home/zhangzy/my project" gemini-4-carbon'), {
    action: 'create',
    provider: 'agy',
    project: '/home/zhangzy/my project',
    model: 'gemini-4-carbon',
  });
  assert.deepEqual(parseFeishuText("/create agy '/home/zhangzy/my project'"), {
    action: 'create',
    provider: 'agy',
    project: '/home/zhangzy/my project',
    model: null,
  });
  assert.deepEqual(parseFeishuText('/create agy /home/zhangzy/my\\ project'), {
    action: 'create',
    provider: 'agy',
    project: '/home/zhangzy/my project',
    model: null,
  });

  // /new [path] [prompt] and >5 directories
  const dir = mkdtempSync(join(tmpdir(), 'feishu-ux-new-'));
  const projects: string[] = [];
  for (let i = 0; i < 8; i++) {
    const p = join(dir, `proj-${i}`);
    mkdirSync(p);
    projects.push(p);
  }
  const explicitDir = join(dir, 'my target proj');
  mkdirSync(explicitDir);

  const cards: ChannelCard[] = [];
  const service: any = {
    hasProvider: (p: string) => p === 'agy',
    listSessions: async () => ({
      items: projects.map((project, idx) => ({
        sessionId: `s-${idx}`,
        native: { provider: 'agy', hostId: 'h', serviceId: 'svc', nativeSessionId: `n-${idx}` },
        project,
        title: `Session ${idx}`,
        status: 'idle',
        revision: 1,
        capabilities: { view: { status: 'available' } },
        control: { input: 'available', generation: 1 },
      })),
      nextCursor: null,
    }),
  };
  const port: FeishuPort = {
    isTopicDestination: () => false,
    send: async (_d, card) => { cards.push(card); return 'draft-msg'; },
    update: async () => {},
    sendFile: async () => {},
  };
  const channel = new FeishuChannel(service as UnifiedService, port, async () => true, join(dir, 'channel.sqlite'), undefined, false, {
    allowedProjectRoots: [dir],
    enabledProviders: ['agy'],
  });
  try {
    const parsed = parseFeishuText(`/new "${explicitDir}" 帮我改引言`);
    assert.deepEqual(parsed, { action: 'new_help', project: explicitDir, initialPrompt: '帮我改引言' });
    await channel.handle({ eventId: 'new-1', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, parsed);
    const card = cards.at(-1)!;
    const pickButtons = card.actions.filter(a => a.value.action === 'new_pick');
    assert.ok(pickButtons.length >= 9, `expected >5 directory buttons, got ${pickButtons.length}`);
    assert.equal(pickButtons[0]!.label, 'my target proj');
    assert.equal(pickButtons[0]!.type, 'primary');
    assert.match(card.text, /首句任务：帮我改引言/);
  } finally {
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/sessions keyword filter, /quota command, health-card and panel quota display', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-ux-quota-'));
  const cards: ChannelCard[] = [];
  const quotaSnapshot: AgyQuotaSnapshot = {
    state: 'ok',
    source: 'live',
    apiKeyMode: false,
    fromCache: false,
    stale: false,
    timedOut: false,
    exitCode: 0,
    binaryPath: '/usr/bin/agy',
    short: {
      group: 'gemini',
      label: 'Gemini 5h',
      name: 'gemini_5h',
      limitId: 'l1',
      windowMinutes: 300,
      windowType: 'short',
      usedPercent: 18,
      remainingPercent: 82,
      remainingAmount: null,
      disabled: false,
      resetsAt: '2026-11-25T13:00:00Z',
      snapshotAt: '2026-11-25T08:00:00Z',
      ageSeconds: 10,
      stale: false,
    },
    weekly: {
      group: 'gemini',
      label: 'Gemini Weekly',
      name: 'gemini_weekly',
      limitId: 'l2',
      windowMinutes: 10080,
      windowType: 'weekly',
      usedPercent: 35.5,
      remainingPercent: 64.5,
      remainingAmount: null,
      disabled: false,
      resetsAt: '2026-12-01T00:00:00Z',
      snapshotAt: '2026-11-25T08:00:00Z',
      ageSeconds: 10,
      stale: false,
    },
    windows: [],
    lastSnapshotAt: '2026-11-25T08:00:00Z',
    observedAt: '2026-11-25T08:00:10Z',
    ageSeconds: 10,
    error: null,
    health: {
      component: 'agy_quota',
      status: 'healthy',
      reason: null,
      updatedAt: '2026-11-25T08:00:10Z',
      lastObservedAt: '2026-11-25T08:00:10Z',
      lastSuccessAt: '2026-11-25T08:00:10Z',
      lastFailureAt: null,
      lastFailureReason: null,
      backlog: null,
      unknown: null,
      lastDeliveryAt: null,
    },
  };

  // Quota card with real data vs unknown/unsampled
  const qCard = buildQuotaCard(quotaSnapshot);
  assert.match(qCard.text, /5h 额度：剩余 82%.*重置 11-25 21:00 北京/);
  assert.match(qCard.text, /周额度：剩余 64\.5%.*重置 12-01 08:00 北京/);
  const unknownQCard = buildQuotaCard(null);
  assert.match(unknownQCard.text, /5h 额度：未知（未采样）/);
  assert.match(unknownQCard.text, /周额度：未知（未采样）/);

  // Health card with quota
  const hCard = buildHealthCard([quotaSnapshot.health], quotaSnapshot);
  assert.match(hCard.text, /5h 剩余 82%/);
  assert.match(hCard.text, /周剩余 64\.5%/);

  // Panel with quota for AGY
  const agySession = {
    sessionId: 'agy-1',
    native: { provider: 'agy', hostId: 'h', serviceId: 'svc', nativeSessionId: 'native1' },
    project: '/home/zhangzy/workspace/gui-rl',
    title: 'GUI-RL 论文实验',
    status: 'idle',
    revision: 1,
    capabilities: { view: { status: 'available' }, queue: { status: 'available' } },
    control: { input: 'available', generation: 1, owner: null, serviceId: 'svc', operationId: null, reason: null },
  } as unknown as Session;
  const otherSession = {
    ...agySession,
    sessionId: 'codex-1',
    native: { provider: 'codex', hostId: 'h', serviceId: 'svc', nativeSessionId: 'native2' },
    project: '/home/zhangzy/workspace/other',
    title: '无关会话',
  } as unknown as Session;

  const panelCard = buildSessionPanel(
    agySession,
    noticePanel(agySession, { paused: false, completed: true, waiting: true, failed: true, revision: 0 }),
    { runningTurns: [], queuedInputs: [], canArchive: false },
    { quota: quotaSnapshot },
  );
  assert.match(panelCard.text, /5h 额度：剩余 82%/);
  assert.match(panelCard.text, /周额度：剩余 64\.5%/);

  // Channel /quota and /sessions <关键词>
  const service: any = {
    listSessions: async (q?: { search?: string }) => {
      const all = [agySession, otherSession];
      const needle = q?.search?.trim().toLowerCase();
      const items = needle
        ? all.filter(s => `${s.title} ${s.project} ${s.native.provider}`.toLowerCase().includes(needle))
        : all;
      return { items, nextCursor: null };
    },
    health: async () => [quotaSnapshot.health],
  };
  const port: FeishuPort = {
    send: async (_d, card) => { cards.push(card); return 'm'; },
    update: async () => {},
    sendFile: async () => {},
  };
  const channel = new FeishuChannel(service as UnifiedService, port, async () => true, join(dir, 'channel.sqlite'), undefined, false, {
    readQuota: async () => quotaSnapshot,
  });
  try {
    await channel.handle({ eventId: 'q1', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, parseFeishuText('/quota'));
    assert.equal(cards.at(-1)!.title, 'Antigravity 额度');
    assert.match(cards.at(-1)!.text, /82%/);

    await channel.handle({ eventId: 's1', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, parseFeishuText('/sessions gui-rl'));
    const listCard = cards.at(-1)!;
    assert.match(listCard.text, /筛选关键词：gui-rl/);
    assert.match(listCard.text, /GUI-RL 论文实验/);
    assert.doesNotMatch(listCard.text, /无关会话/);
  } finally {
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Card JSON 2.0 renders native Markdown tables and <details> collapsible panels', () => {
  const tableCard: ChannelCard = {
    title: '实验对比',
    text: '结果汇总：\n\n| 模型 | 准确率 |\n| --- | --- |\n| Carbon | 95.2% |',
    actions: [],
  };
  assert.equal(cardSchema(tableCard), '2.0');
  const encodedTable = encodeCard(tableCard) as any;
  assert.equal(encodedTable.schema, '2.0');
  assert.equal(encodedTable.body.elements[0].tag, 'markdown');
  assert.match(encodedTable.body.elements[0].content, /\| Carbon \| 95\.2% \|/);

  const detailsCard: ChannelCard = {
    title: '分析详情',
    text: '结论如下：\n<details><summary>查看堆栈</summary>\n```\nError: boom\n```\n</details>\n后续步骤。',
    actions: [],
  };
  assert.equal(cardSchema(detailsCard), '2.0');
  const encodedDetails = encodeCard(detailsCard) as any;
  assert.equal(encodedDetails.schema, '2.0');
  assert.deepEqual(
    encodedDetails.body.elements.map((e: any) => e.tag),
    ['markdown', 'collapsible_panel', 'markdown'],
  );
  assert.equal(encodedDetails.body.elements[1].header.title.content, '查看堆栈');
  assert.match(encodedDetails.body.elements[1].elements[0].content, /Error: boom/);

  // <details> inside a fenced code block must NOT be split into collapsible_panel
  const fencedDetailsCard: ChannelCard = {
    title: '代码示例',
    text: '示例 HTML：\n```html\n<details><summary>Demo</summary>\ninside code\n</details>\n```\n结束。',
    actions: [],
  };
  assert.equal(cardSchema(fencedDetailsCard), '1.0');
  const encodedFencedV2 = encodeCard(fencedDetailsCard, '2.0') as any;
  assert.deepEqual(
    encodedFencedV2.body.elements.map((e: any) => e.tag),
    ['markdown'],
  );
  assert.match(encodedFencedV2.body.elements[0].content, /<details><summary>Demo<\/summary>/);
});

test('E2E: enum-only question decline passes real UnifiedCore + UnifiedStore validation and delivers action=decline', async () => {
  const { UnifiedStore } = await import('../src/unified/store.js');
  const { UnifiedCore } = await import('../src/unified/service.js');
  const dir = mkdtempSync(join(tmpdir(), 'feishu-ux-decline-e2e-'));
  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  const responded: Array<{ interactionId: string; answer: any }> = [];
  const fakePort: any = {
    provider: 'agy',
    list: async () => ({ items: [], nextCursor: null }),
    read: async () => { throw new Error('unused'); },
    resume: async () => ({ status: 'submitted', nativeReference: null, connectionGeneration: 1 }),
    create: async () => ({ status: 'submitted', nativeReference: null }),
    input: async () => ({ status: 'submitted', nativeReference: 't1' }),
    interrupt: async () => ({ status: 'submitted', nativeReference: null }),
    respond: async (_ref: any, interaction: any, answer: any, guard: any) => {
      guard.assertCurrent();
      responded.push({ interactionId: interaction.interactionId, answer });
      return { status: 'submitted', nativeReference: null };
    },
    onObservation: () => () => {},
    listArtifacts: async () => [],
    readArtifact: async () => new Uint8Array(),
    listModels: async () => [],
    updateSettings: async () => ({ status: 'submitted', nativeReference: null }),
    control: async () => ({ status: 'submitted', nativeReference: null }),
  };
  const core = new UnifiedCore(store, [fakePort], () => true);
  const cards: ChannelCard[] = [];
  const port: FeishuPort = {
    isTopicDestination: d => d === 'topic:e2e',
    send: async (_d, card) => { cards.push(card); return 'msg-1'; },
    update: async () => {},
    sendFile: async () => {},
  };
  const channel = new FeishuChannel(core, port, async () => true, join(dir, 'channel.sqlite'));
  try {
    const session: Session = {
      sessionId: 'agy-enum-s1',
      native: { provider: 'agy', hostId: 'h', serviceId: 'svc', nativeSessionId: 'n-enum' },
      project: dir,
      title: 'AGY Enum Decline',
      status: 'waiting_question',
      revision: 1,
      capabilities: {
        view: { status: 'available' },
        send: { status: 'available' },
        queue: { status: 'available' },
        steer: { status: 'unsupported', reason: 'no steer' },
        answer: { status: 'available' },
        approve: { status: 'available' },
        interrupt: { status: 'available' },
        handoff: { status: 'available' },
        files: { status: 'available' },
        config: { status: 'available' },
      },
      control: { serviceId: 'svc', owner: 'feishu', input: 'available', generation: 1, operationId: null, reason: null },
    };
    store.insertSession(session);
    const enumInteraction: Interaction = {
      interactionId: 'iq-enum-1',
      sessionId: session.sessionId,
      turnId: 'turn-1',
      nativeRequestId: 'req-1',
      connectionGeneration: 0,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: null,
      nativeResult: null,
      kind: 'question',
      prompt: 'Choose strictly',
      choices: ['A', 'B'],
      multiple: false,
      allowFreeText: false,
    };
    store.insertInteraction(enumInteraction);
    await interactiveBind(channel, core, 'topic:e2e', session.sessionId);

    const db = new DatabaseSync(join(dir, 'channel.sqlite'), { readOnly: true });
    const bindingId = (db.prepare('SELECT binding_id FROM channel_bindings WHERE destination=?').get('topic:e2e') as { binding_id: string }).binding_id;
    db.close();

    const wire = renderQuestionForm(questionForm(enumInteraction, bindingId)) as any;
    const declineBtn = wire.body.elements[0].elements.find((el: any) => el.name === 'decline_question');
    const action = parseFeishuAction(declineBtn.behaviors[0].value);
    const op: any = await channel.handle(
      { eventId: 'evt-decline', destination: 'topic:e2e', identity: { source: 'feishu', subject: 'owner' } },
      action,
    );
    assert.equal(op.status, 'received');
    await core.dispatch(op.operationId);
    assert.equal(responded.length, 1);
    assert.equal(responded[0]!.interactionId, 'iq-enum-1');
    assert.equal(responded[0]!.answer.action, 'decline');
    assert.deepEqual(responded[0]!.answer.values, ['A']);
    const after = await core.getInteraction('iq-enum-1');
    assert.equal(after.status, 'answer_pending_delivery');
  } finally {
    channel.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('staged PDF intake avoids serializing large Uint8Array into SQLite inbox and preserves byte size', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-ux-pdf-size-'));
  const submitted: string[] = [];
  const session = {
    sessionId: 'agy-pdf',
    native: { provider: 'agy', hostId: 'h', serviceId: 'svc', nativeSessionId: 'n-pdf' },
    project: dir,
    title: 'PDF Session',
    status: 'idle',
    revision: 1,
    capabilities: { send: { status: 'available' }, queue: { status: 'available' }, steer: { status: 'unsupported', reason: 'no' } },
    control: { input: 'available', generation: 1, owner: 'feishu', serviceId: 'svc', operationId: null, reason: null },
  } as unknown as Session;
  const service: any = {
    getSession: async () => session,
    submitInput: async ({ context, blocks }: any) => {
      submitted.push(blocks[0].text);
      return { ...context, action: 'submitInput', status: 'completed', revision: 1, error: null, payloadDigest: 'd' };
    },
  };
  const port: FeishuPort = {
    isTopicDestination: d => d === 'topic:pdf',
    send: async () => 'm',
    update: async () => {},
    sendFile: async () => {},
  };
  const dbPath = join(dir, 'channel.sqlite');
  const channel = new FeishuChannel(service as UnifiedService, port, async () => true, dbPath);
  try {
    await interactiveBind(channel, service, 'topic:pdf', 'agy-pdf');
    const bigPdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1024 * 1024, 65)]);
    const localPath = join(dir, 'big.pdf');
    await channel.handle(
      { eventId: 'pdf-1', destination: 'topic:pdf', identity: { source: 'feishu', subject: 'owner' } },
      { action: 'attachment', name: 'big.pdf', mediaType: 'application/pdf', content: bigPdf, size: bigPdf.length, mode: 'new', localPath },
    );
    assert.equal(submitted.length, 1);
    assert.match(submitted[0]!, new RegExp(`${bigPdf.length} 字节`));
    assert.match(submitted[0]!, new RegExp(localPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT action FROM channel_inbox WHERE event_id=?').get('pdf-1') as { action: string };
    db.close();
    assert.ok(row.action.length < 1024, `PDF inbox payload must stay compact, got ${row.action.length} bytes`);
  } finally {
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
