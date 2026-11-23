import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { PlatformObservation, PlatformPort, UnifiedService } from '../src/unified/adapter.js';
import {
  payloadDigest,
  type Capabilities,
  type ModelOption,
  type NativeSessionRef,
  type Provider,
  type Session,
} from '../src/unified/contracts.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';
import { parseFeishuAction, parseFeishuText } from '../src/unified/feishu-codec.js';
import { FeishuSdkPort } from '../src/unified/feishu-sdk-port.js';
import { UnifiedRuntime, type RuntimeConfig, type RuntimeTrustedAction } from '../src/unified/runtime.js';

const OWNER_ID = 'owner-p4';
const OWNER = { source: 'feishu', subject: OWNER_ID };
const APP_ID = 'cli_phase4_ux';
const ALL_CAPS = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map(
    (k) => [k, { status: 'available' as const }],
  ),
) as Capabilities;

function makeMockSdkClient(chatId: string) {
  let msgSeq = 0;
  const created: Array<{ message_id: string; receive_id: string; msg_type: string; content: string }> = [];
  const replies: Array<{ message_id: string; root_id: string; msg_type: string; content: string }> = [];
  const messageChats = new Map<string, string>();
  const client = {
    request: async () => ({ bot: { open_id: 'bot-p4' } }),
    im: {
      message: {
        create: async ({ data }: { data: { receive_id: string; msg_type: string; content: string } }) => {
          const message_id = `om_create_${++msgSeq}`;
          created.push({ message_id, ...data });
          messageChats.set(message_id, data.receive_id);
          return { code: 0, data: { message_id, thread_id: `omt_${msgSeq}` } };
        },
        reply: async ({ path, data }: { path: { message_id: string }; data: { msg_type: string; content: string } }) => {
          const message_id = `om_reply_${++msgSeq}`;
          replies.push({ message_id, root_id: path.message_id, ...data });
          messageChats.set(message_id, messageChats.get(path.message_id) ?? chatId);
          return { code: 0, data: { message_id } };
        },
        patch: async () => ({ code: 0 }),
        get: async ({ path }: { path: { message_id: string } }) => {
          const targetChat = messageChats.get(path.message_id) ?? chatId;
          return {
            code: 0,
            data: {
              items: [
                {
                  message_id: path.message_id,
                  chat_id: targetChat,
                  sender: { id_type: 'app_id', sender_type: 'app', id: APP_ID },
                  message_app_link: `https://applink.feishu.cn/client/thread/open?openChatId=${targetChat}&openThreadId=omt_${path.message_id}`,
                },
              ],
            },
          };
        },
      },
      messageResource: {
        get: async () => ({ getReadableStream: () => Readable.from([Buffer.from('ok\n')]) }),
      },
      file: { create: async () => ({ file_key: 'fk_p4' }) },
    },
  };
  return { client, created, replies };
}

function makeFakeProvider(
  provider: Provider,
  hostId: string,
  serviceId: string,
  projectDir: string,
  models?: ModelOption[],
) {
  const listeners = new Set<(o: PlatformObservation) => void>();
  const sessions = new Map<string, Session>();
  const inputs: Array<{ ref: NativeSessionRef; text: string }> = [];
  const settingsUpdates: Array<{ ref: NativeSessionRef; model: string | null; preferences: Record<string, string> }> = [];
  let turnSeq = 0;

  const port: PlatformPort = {
    provider,
    seedConnectionGeneration: () => {},
    seedControlGeneration: () => {},
    list: async () => ({ items: [...sessions.values()], nextCursor: null }),
    read: async (ref) => {
      const s = sessions.get(ref.nativeSessionId);
      if (!s) throw new Error(`missing native session: ${ref.nativeSessionId}`);
      return { session: s, messages: [], interactions: [], turns: [], connectionGeneration: 1 };
    },
    resume: async (ref) => ({ status: 'submitted', nativeReference: ref.nativeSessionId, connectionGeneration: 1 }),
    create: async () => ({ status: 'submitted', nativeReference: 'new', connectionGeneration: 1 }),
    input: async (ref, _mode, blocks, guard) => {
      guard.assertCurrent();
      inputs.push({ ref, text: blocks.map((b) => (b.type === 'text' ? b.text : `[file:${b.name}]`)).join('\n') });
      return { status: 'submitted', nativeReference: `turn-${provider}-${++turnSeq}` };
    },
    interrupt: async (_ref, turnId, guard) => {
      guard.assertCurrent();
      return { status: 'submitted', nativeReference: turnId };
    },
    respond: async (_ref, interaction, _answer, guard) => {
      guard.assertCurrent();
      return { status: 'submitted', nativeReference: interaction.nativeRequestId };
    },
    onObservation: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    listArtifacts: async () => [],
    readArtifact: async () => new Uint8Array(),
    listModels: async () =>
      models ?? [{ id: `${provider}-default`, label: `${provider} default`, reasoningEfforts: ['medium', 'high'] }],
    updateSettings: async (ref, settings, guard) => {
      guard.assertCurrent();
      settingsUpdates.push({ ref, ...settings });
      return { status: 'submitted', nativeReference: null, settingsApplied: true };
    },
    control: async (_ref, _action, guard) => {
      guard.assertCurrent();
      return { status: 'submitted', nativeReference: null };
    },
  };

  const seed = (nativeSessionId: string): Session => {
    const s: Session = {
      sessionId: `session_${payloadDigest({ provider, hostId, serviceId, nativeSessionId })}`,
      native: { provider, hostId, serviceId, nativeSessionId },
      project: projectDir,
      title: `${provider} ${nativeSessionId}`,
      status: 'idle',
      revision: 0,
      capabilities: ALL_CAPS,
      control: {
        serviceId,
        owner: OWNER_ID,
        input: 'available',
        generation: 1,
        operationId: null,
        reason: null,
      },
    };
    sessions.set(nativeSessionId, s);
    return s;
  };

  return { port, inputs, settingsUpdates, seed };
}

function makeConfig(dir: string, projectDir: string): RuntimeConfig {
  return {
    coreDb: join(dir, 'core.sqlite'),
    channelDb: join(dir, 'channel.sqlite'),
    ownerOpenId: OWNER_ID,
    allowedDestinations: ['chat-main'],
    hostId: 'host-1',
    claudeServiceId: 'svc-claude',
    codexServiceId: 'svc-codex',
    claudeStateDir: join(dir, 'claude-state'),
    codexEndpoint: 'ws://127.0.0.1:1',
    intervalMs: 60_000,
    allowedProjectRoots: [projectDir],
    outputRoots: [projectDir],
    agy: { enabled: true, serviceId: 'svc-agy' },
    taskTopic: { enabled: true },
    watchHub: { enabled: true, destination: 'chat-main', dbPath: join(dir, 'watch-hub.sqlite') },
    decisionSync: {
      enabled: true,
      dbPath: join(dir, 'decision-sync.sqlite'),
      markdownPath: join(dir, 'decisions.md'),
    },
  };
}

test('parseFeishuText supports /help, /help admin, and multiline /swarm', () => {
  assert.deepEqual(parseFeishuText('/help'), { action: 'help' });
  assert.deepEqual(parseFeishuText('/help admin'), { action: 'help', scope: 'admin' });
  assert.throws(() => parseFeishuText('/help bogus'), /invalid or unsupported command/);

  assert.deepEqual(parseFeishuText('/swarm'), { action: 'swarm', prompt: '', rawText: '/swarm' });
  assert.deepEqual(parseFeishuText('  /swarm 排查测试失败\n第二行细节  '), {
    action: 'swarm',
    prompt: '排查测试失败\n第二行细节',
    rawText: '/swarm 排查测试失败\n第二行细节',
  });

  // new_help callback button is binding-exempt so main chat buttons work
  assert.deepEqual(parseFeishuAction({ action: 'new_help' }), { action: 'new_help' });
});

test('Scene-scoped /help and Main Chat topic-only command guidance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-p4-help-'));
  const cards: Array<{ dest: string; card: ChannelCard }> = [];
  const sessions = new Map<string, Session>([
    [
      's-agy',
      {
        sessionId: 's-agy',
        native: { provider: 'agy', hostId: 'h', serviceId: 'svc-agy', nativeSessionId: 'n-agy' },
        project: '/work',
        title: 'Agy Session',
        status: 'idle',
        revision: 1,
        capabilities: ALL_CAPS,
        control: { serviceId: 'svc-agy', owner: OWNER_ID, input: 'available', generation: 1, operationId: null, reason: null },
      },
    ],
    [
      's-codex',
      {
        sessionId: 's-codex',
        native: { provider: 'codex', hostId: 'h', serviceId: 'svc-codex', nativeSessionId: 'n-codex' },
        project: '/work',
        title: 'Codex Session',
        status: 'idle',
        revision: 1,
        capabilities: ALL_CAPS,
        control: { serviceId: 'svc-codex', owner: OWNER_ID, input: 'available', generation: 1, operationId: null, reason: null },
      },
    ],
    [
      's-claude',
      {
        sessionId: 's-claude',
        native: { provider: 'claude', hostId: 'h', serviceId: 'svc-claude', nativeSessionId: 'n-claude' },
        project: '/work',
        title: 'Claude Session',
        status: 'idle',
        revision: 1,
        capabilities: ALL_CAPS,
        control: { serviceId: 'svc-claude', owner: OWNER_ID, input: 'available', generation: 1, operationId: null, reason: null },
      },
    ],
  ]);

  const service = {
    getSession: async (id: string) => {
      const s = sessions.get(id);
      if (!s) throw new Error('missing session');
      return s;
    },
  } as unknown as UnifiedService;

  const port: FeishuPort = {
    isTopicDestination: (dest) => dest.startsWith('topic:'),
    send: async (dest, card) => {
      cards.push({ dest, card });
      return `msg-${cards.length}`;
    },
    update: async () => {},
    sendFile: async () => {},
  };

  const channel = new FeishuChannel(service, port, async () => true, join(dir, 'channel.sqlite'));
  const env = (eventId: string, destination: string) => ({ eventId, destination, identity: OWNER });

  try {
    // 1. Main Chat /help
    await channel.handle(env('h-main', 'chat-main'), parseFeishuText('/help'));
    const mainHelp = cards.at(-1)!.card;
    assert.equal(mainHelp.title, '帮助');
    assert.match(mainHelp.text, /\/sessions/);
    assert.match(mainHelp.text, /\/new/);
    assert.match(mainHelp.text, /\/task/);
    assert.match(mainHelp.text, /\/health/);
    assert.match(mainHelp.text, /\/help admin/);
    assert.doesNotMatch(mainHelp.text, /\/steer/);
    assert.deepEqual(
      mainHelp.actions.map((a) => a.value.action),
      ['list', 'new_help'],
    );
    // Quick buttons round-trip through parseFeishuAction without bindingId
    for (const btn of mainHelp.actions) {
      parseFeishuAction(btn.value);
    }

    // 2. /help admin
    await channel.handle(env('h-admin', 'chat-main'), parseFeishuText('/help admin'));
    const adminHelp = cards.at(-1)!.card;
    assert.match(adminHelp.title, /运维管理/);
    for (const cmd of ['/health', '/pending', '/panel', '/unbind', '/export']) {
      assert.ok(adminHelp.text.includes(cmd), `admin help should include ${cmd}`);
    }

    // 3. Agy Topic /help
    await channel.handle(env('b-agy', 'topic:agy'), { action: 'bind', sessionId: 's-agy' });
    await channel.handle(env('h-agy', 'topic:agy'), parseFeishuText('/help'));
    const agyHelp = cards.at(-1)!.card;
    assert.match(agyHelp.title, /Antigravity/);
    assert.match(agyHelp.text, /\/swarm/);
    assert.match(agyHelp.text, /\/model/);
    assert.doesNotMatch(agyHelp.text, /\/steer/);

    // 4. Codex Topic /help
    await channel.handle(env('b-codex', 'topic:codex'), { action: 'bind', sessionId: 's-codex' });
    await channel.handle(env('h-codex', 'topic:codex'), parseFeishuText('/help'));
    const codexHelp = cards.at(-1)!.card;
    assert.match(codexHelp.title, /Codex/);
    assert.match(codexHelp.text, /\/steer/);
    assert.doesNotMatch(codexHelp.text, /\/swarm/);

    // 5. Claude Topic /help
    await channel.handle(env('b-claude', 'topic:claude'), { action: 'bind', sessionId: 's-claude' });
    await channel.handle(env('h-claude', 'topic:claude'), parseFeishuText('/help'));
    const claudeHelp = cards.at(-1)!.card;
    assert.match(claudeHelp.title, /Claude/);
    assert.doesNotMatch(claudeHelp.text, /\/swarm/);
    assert.doesNotMatch(claudeHelp.text, /\/steer/);

    // 6. Main Chat topic-only commands return friendly guidance card with quick buttons
    for (const cmd of ['/model', '/ls', '/file', '/history', '/stop', '/swarm 测试']) {
      const res = await channel.handle(env(`main-${cmd}`, 'chat-main'), parseFeishuText(cmd));
      assert.deepEqual(res, { status: 'guidance' });
      const card = cards.at(-1)!.card;
      assert.match(card.text, /该命令需要在具体会话话题中使用/);
      assert.deepEqual(
        card.actions.map((a) => a.value.action),
        ['list', 'new_help'],
      );
    }
  } finally {
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/swarm passthrough in interactive agy, one-click upgrade in read-only agy & normal text, rejection in codex/claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-p4-swarm-'));
  const cards: Array<{ dest: string; card: ChannelCard }> = [];
  const submitted: Array<{ sessionId: string; mode: string; text: string }> = [];
  const ops = new Map<string, unknown>();

  const makeSession = (id: string, provider: Provider): Session => ({
    sessionId: id,
    native: { provider, hostId: 'h', serviceId: `svc-${provider}`, nativeSessionId: `n-${id}` },
    project: '/work',
    title: id,
    status: 'idle',
    revision: 1,
    capabilities: ALL_CAPS,
    control: { serviceId: `svc-${provider}`, owner: OWNER_ID, input: 'available', generation: 1, operationId: null, reason: null },
  });
  const sessions = new Map<string, Session>([
    ['s-agy', makeSession('s-agy', 'agy')],
    ['s-codex', makeSession('s-codex', 'codex')],
    ['s-claude', makeSession('s-claude', 'claude')],
  ]);

  const service = {
    getSession: async (id: string) => sessions.get(id)!,
    attachSession: async ({ context, payload }: { context: { operationId: string }; payload: { provider: Provider } }) => {
      const sessionId = payload.provider === 'agy' ? 's-agy' : `s-${payload.provider}`;
      const op = { operationId: context.operationId, status: 'completed', action: 'attachSession', error: null, result: { kind: 'session', sessionId } };
      ops.set(op.operationId, op);
      return op;
    },
    getOperation: async (id: string) => ops.get(id),
    submitInput: async ({ context, mode, blocks }: { context: { targetId: string }; mode: string; blocks: Array<{ type: string; text?: string }> }) => {
      submitted.push({ sessionId: context.targetId, mode, text: blocks.map((b) => b.text ?? '').join('\n') });
      return { operationId: 'op-input', status: 'completed', action: 'submitInput', error: null, result: { kind: 'turn', turnId: 't-1' } };
    },
    listModels: async () => ({
      items: [
        { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', reasoningEfforts: ['low', 'medium'] },
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoningEfforts: ['medium'] },
        { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', reasoningEfforts: ['high'] },
        { id: 'gemini-4-neon', label: 'Gemini 4 Neon', reasoningEfforts: ['medium'] },
      ],
      nextCursor: 'page-2',
    }),
  } as unknown as UnifiedService;

  const port: FeishuPort = {
    send: async (dest, card) => {
      cards.push({ dest, card });
      return `msg-${cards.length}`;
    },
    update: async () => {},
    sendFile: async () => {},
  };

  const channel = new FeishuChannel(service, port, async () => true, join(dir, 'channel.sqlite'));
  const env = (eventId: string, destination: string) => ({ eventId, destination, identity: OWNER });

  try {
    // 1. Read-only agy topic: normal text input offers direct 一键接入并续聊 (upgrade) button
    await channel.handle(env('bind-agy-ro', 'topic:agy'), { action: 'bind', sessionId: 's-agy' });
    const roTextRes = await channel.handle(env('ro-text', 'topic:agy'), parseFeishuText('你好'));
    assert.deepEqual(roTextRes, { status: 'rejected', reason: 'read_only_binding' });
    const roTextCard = cards.at(-1)!.card;
    assert.equal(roTextCard.title, '操作未执行');
    const upgradeBtnFromText = roTextCard.actions.find((a) => a.value.action === 'upgrade');
    assert.ok(upgradeBtnFromText, 'read-only text rejection should include direct upgrade button');
    assert.equal(upgradeBtnFromText.label, '一键接入并续聊');
    assert.ok(roTextCard.actions.some((a) => a.value.action === 'panel'));

    // 2. Read-only agy topic: /swarm replies with one-click upgrade button
    const roSwarmRes = await channel.handle(env('ro-swarm', 'topic:agy'), parseFeishuText('/swarm 分析日志'));
    assert.deepEqual(roSwarmRes, { status: 'rejected', reason: 'read_only_binding' });
    const roSwarmCard = cards.at(-1)!.card;
    assert.match(roSwarmCard.text, /只读镜像/);
    const upgradeBtn = roSwarmCard.actions.find((a) => a.value.action === 'upgrade');
    assert.ok(upgradeBtn, 'read-only agy /swarm should include upgrade button');
    assert.equal(upgradeBtn.label, '一键接入并续聊');

    // 3. Click upgrade button -> finish -> interactive agy topic
    const upgradeOp = (await channel.handle(env('do-upgrade', 'topic:agy'), parseFeishuAction(upgradeBtn.value))) as {
      operationId: string;
    };
    await channel.handle(env('finish-upgrade', 'topic:agy'), { action: 'finish', operationId: upgradeOp.operationId });

    // 4. Interactive agy topic: /swarm passes rawText directly as mode:'new' input
    const multilineSwarm = '/swarm 并发审查\n保留换行';
    await channel.handle(env('rw-swarm', 'topic:agy'), parseFeishuText(multilineSwarm));
    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0], { sessionId: 's-agy', mode: 'new', text: multilineSwarm });

    // 5. Curated /model ordering for agy: Carbon -> Neon -> Hydrogen first, pagination preserved
    await channel.handle(env('agy-models', 'topic:agy'), parseFeishuText('/model'));
    const modelCard = cards.at(-1)!.card;
    const modelActions = modelCard.actions.filter((a) => a.value.action === 'settings');
    assert.equal(modelActions[0]!.value.model, 'gemini-4-carbon');
    assert.match(modelActions[0]!.label, /深度推理/);
    assert.equal(modelActions[1]!.value.model, 'gemini-4-neon');
    assert.match(modelActions[1]!.label, /均衡推荐/);
    assert.equal(modelActions[2]!.value.model, 'gemini-4-hydrogen');
    assert.match(modelActions[2]!.label, /轻量快速/);
    assert.ok(modelCard.actions.some((a) => a.value.action === 'models' && a.value.cursor === 'page-2'));

    // 6. Codex & Claude topics reject /swarm with friendly guidance
    for (const [dest, sid] of [
      ['topic:codex', 's-codex'],
      ['topic:claude', 's-claude'],
    ] as const) {
      await channel.handle(env(`bind-${sid}`, dest), { action: 'bind', sessionId: sid });
      const res = await channel.handle(env(`swarm-${sid}`, dest), parseFeishuText('/swarm test'));
      assert.deepEqual(res, { status: 'rejected', reason: 'unsupported' });
      assert.match(cards.at(-1)!.card.text, /仅 Antigravity 交互会话支持/);
    }
  } finally {
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TaskTopic /help, /swarm passthrough, and clickable taskScope-stamped /models buttons', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-p4-task-'));
  const projectDir = join(dir, 'proj');
  mkdirSync(projectDir, { recursive: true });
  const sdk = makeMockSdkClient('chat-main');
  const port = new FeishuSdkPort(
    { appId: APP_ID, appSecret: 'secret' },
    join(dir, 'sdk.sqlite'),
    new Set(['chat-main']),
    OWNER_ID,
    true,
    true,
  );
  (port as unknown as { client: unknown }).client = sdk.client;

  const agy = makeFakeProvider('agy', 'host-1', 'svc-agy', projectDir, [
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', reasoningEfforts: ['low'] },
    { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', reasoningEfforts: ['high'] },
    { id: 'gemini-4-neon', label: 'Gemini 4 Neon', reasoningEfforts: ['medium'] },
  ]);
  const claude = makeFakeProvider('claude', 'host-1', 'svc-claude', projectDir);
  const sAgy = agy.seed('agy-task-1');
  const sClaude = claude.seed('claude-task-1');

  const runtime = new UnifiedRuntime(makeConfig(dir, projectDir), port, [claude.port, agy.port]);
  try {
    runtime.store.insertSession(sAgy);
    runtime.store.insertSession(sClaude);

    // 1. Create Task Topic
    const created = (await runtime.handleTrusted(
      { eventId: 'ev-create-task', destination: 'chat-main', identity: OWNER },
      parseFeishuText('/task Phase 4 产品体验测试'),
    )) as { taskId: string; destination: string };

    // 2. /help works in Task Topic even before mounting any target
    await runtime.handleTrusted(
      { eventId: 'ev-task-help-empty', destination: created.destination, identity: OWNER },
      parseFeishuText('/help'),
    );
    await runtime.tick();
    const emptyHelpCard = JSON.parse(sdk.replies.at(-1)!.content);
    assert.equal(emptyHelpCard.header.title.content, '帮助 · 任务话题');
    assert.match(emptyHelpCard.elements[0].text.content, /\/handoff/);
    assert.match(emptyHelpCard.elements[0].text.content, /\/swarm/);

    // 3. Mount interactive Agy target
    await runtime.handleTrusted(
      { eventId: 'ev-mount-agy', destination: created.destination, identity: OWNER },
      parseFeishuText(`/task mount ${sAgy.sessionId} interactive`),
    );

    // 4. /models in Task Topic renders clickable taskScope-stamped buttons
    await runtime.handleTrusted(
      { eventId: 'ev-task-models', destination: created.destination, identity: OWNER },
      parseFeishuText('/models'),
    );
    await runtime.tick();
    const modelsCard = JSON.parse(sdk.replies.at(-1)!.content);
    assert.equal(modelsCard.header.title.content, 'Antigravity · 模型');
    const actionBlock = modelsCard.elements.find((e: { tag: string }) => e.tag === 'action');
    assert.ok(actionBlock && actionBlock.actions.length >= 3, 'TaskTopic /models should render clickable buttons');
    const firstBtn = actionBlock.actions[0];
    assert.equal(firstBtn.value.action, 'settings');
    assert.equal(firstBtn.value.model, 'gemini-4-carbon');
    assert.equal(firstBtn.value.taskId, created.taskId);
    assert.equal(firstBtn.value.sessionId, sAgy.sessionId);

    // Clicking the stamped button parses cleanly and updates settings on the active Agy target
    const parsedModelAction = parseFeishuAction<RuntimeTrustedAction>(firstBtn.value);
    await runtime.handleTrusted(
      { eventId: 'card:ev-task-model-click', destination: created.destination, identity: OWNER },
      parsedModelAction,
    );
    await runtime.tick();
    assert.equal(agy.settingsUpdates.length, 1);
    assert.equal(agy.settingsUpdates[0]!.model, 'gemini-4-carbon');

    // 5. /swarm in Task Topic with active interactive Agy target passes rawText through
    await runtime.handleTrusted(
      { eventId: 'ev-task-swarm', destination: created.destination, identity: OWNER },
      parseFeishuText('/swarm 多后端任务协同'),
    );
    await runtime.tick();
    assert.equal(agy.inputs.length, 1);
    assert.equal(agy.inputs[0]!.text, '/swarm 多后端任务协同');
  } finally {
    await runtime.close();
    port.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scripts/wave2-operator.mjs rejects 0644 config file and requires 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-p4-op-mode-'));
  const projectDir = join(dir, 'proj');
  mkdirSync(projectDir, { recursive: true });
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ runtime: makeConfig(dir, projectDir) }, null, 2));
  chmodSync(cfgPath, 0o644);

  const scriptPath = resolve('scripts/wave2-operator.mjs');
  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, ['--import', 'tsx', scriptPath, 'decision-list', '--config', cfgPath], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      (err: unknown) => {
        const stderr = String((err as { stderr?: unknown })?.stderr ?? '');
        return stderr.includes('0600') || stderr.includes('private permissions');
      },
    );

    chmodSync(cfgPath, 0o600);
    const out = JSON.parse(
      execFileSync(process.execPath, ['--import', 'tsx', scriptPath, 'decision-list', '--config', cfgPath], {
        encoding: 'utf8',
      }),
    );
    assert.equal(out.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
