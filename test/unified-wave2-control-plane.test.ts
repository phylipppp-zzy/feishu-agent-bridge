import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { PlatformObservation, PlatformPort } from '../src/unified/adapter.js';
import {
  payloadDigest,
  type Answer,
  type Capabilities,
  type NativeSessionRef,
  type Provider,
  type Session,
} from '../src/unified/contracts.js';
import { parseFeishuAction, parseFeishuText } from '../src/unified/feishu-codec.js';
import { FeishuSdkPort } from '../src/unified/feishu-sdk-port.js';
import {
  UnifiedRuntime,
  type RuntimeConfig,
  type RuntimeTrustedAction,
} from '../src/unified/runtime.js';

const OWNER_ID = 'owner-cp';
const OWNER = { source: 'feishu', subject: OWNER_ID };
const APP_ID = 'cli_wave2_cp';
const ALL_CAPS = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map(
    (k) => [k, { status: 'available' as const }],
  ),
) as Capabilities;

function makeMockSdkClient(chatId: string) {
  let msgSeq = 0;
  const created: Array<{ message_id: string; receive_id: string; msg_type: string; content: string }> = [];
  const replies: Array<{
    message_id: string;
    root_id: string;
    msg_type: string;
    content: string;
    reply_in_thread?: boolean;
  }> = [];
  const patches: Array<{ message_id: string; content: string }> = [];
  const messageChats = new Map<string, string>();

  const client = {
    request: async () => ({ bot: { open_id: 'bot-cp' } }),
    im: {
      message: {
        create: async ({ data }: { data: { receive_id: string; msg_type: string; content: string } }) => {
          const message_id = `om_create_${++msgSeq}`;
          created.push({ message_id, ...data });
          messageChats.set(message_id, data.receive_id);
          return { code: 0, data: { message_id, thread_id: `omt_${msgSeq}` } };
        },
        reply: async ({
          path,
          data,
        }: {
          path: { message_id: string };
          data: { msg_type: string; content: string; reply_in_thread?: boolean };
        }) => {
          const message_id = `om_reply_${++msgSeq}`;
          replies.push({ message_id, root_id: path.message_id, ...data });
          messageChats.set(message_id, messageChats.get(path.message_id) ?? chatId);
          return { code: 0, data: { message_id } };
        },
        patch: async ({ path, data }: { path: { message_id: string }; data: { content: string } }) => {
          patches.push({ message_id: path.message_id, content: data.content });
          return { code: 0 };
        },
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
      file: {
        create: async () => ({ file_key: 'fk_cp' }),
      },
    },
  };

  return { client, created, replies, patches };
}

function makeFakeProvider(provider: Provider, hostId: string, serviceId: string, projectDir: string) {
  const listeners = new Set<(o: PlatformObservation) => void>();
  const sessions = new Map<string, Session>();
  const inputs: Array<{ ref: NativeSessionRef; text: string }> = [];
  const responds: Array<{ ref: NativeSessionRef; interactionId: string; answer: Answer }> = [];
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
    resume: async (ref) => ({
      status: 'submitted',
      nativeReference: ref.nativeSessionId,
      connectionGeneration: 1,
    }),
    create: async () => ({ status: 'submitted', nativeReference: 'new', connectionGeneration: 1 }),
    input: async (ref, _mode, blocks, guard) => {
      guard.assertCurrent();
      const text = blocks.map((b) => (b.type === 'text' ? b.text : `[file:${b.name}]`)).join('\n');
      inputs.push({ ref, text });
      return { status: 'submitted', nativeReference: `turn-${provider}-${++turnSeq}` };
    },
    interrupt: async (_ref, turnId, guard) => {
      guard.assertCurrent();
      return { status: 'submitted', nativeReference: turnId };
    },
    respond: async (ref, interaction, answer, guard) => {
      guard.assertCurrent();
      responds.push({ ref, interactionId: interaction.interactionId, answer });
      return { status: 'submitted', nativeReference: interaction.nativeRequestId };
    },
    onObservation: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    listArtifacts: async () => [],
    readArtifact: async () => new Uint8Array(),
    listModels: async () => [{ id: `${provider}-default`, label: `${provider} default` }],
    updateSettings: async (_ref, _settings, guard) => {
      guard.assertCurrent();
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

  const emit = (o: PlatformObservation) => {
    for (const fn of listeners) fn(o);
  };

  return { port, inputs, responds, seed, emit };
}

function makeConfig(dir: string, projectDir: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
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
    pendingHub: { enabled: true, destination: 'chat-main', dbPath: join(dir, 'pending-hub.sqlite') },
    decisionSync: {
      enabled: true,
      dbPath: join(dir, 'decision-sync.sqlite'),
      markdownPath: join(dir, 'decisions.md'),
    },
    ...overrides,
  };
}

test('parseFeishuText parses /task and /handoff commands strictly', () => {
  assert.deepEqual(parseFeishuText('/task'), { action: 'task_panel' });
  assert.deepEqual(parseFeishuText('/task   Build Wave 2 control plane '), {
    action: 'task_create',
    title: 'Build Wave 2 control plane',
  });
  assert.deepEqual(parseFeishuText('/task mount sess_123'), {
    action: 'task_mount',
    sessionId: 'sess_123',
  });
  assert.deepEqual(parseFeishuText('/task mount sess_123 interactive'), {
    action: 'task_mount',
    sessionId: 'sess_123',
    mode: 'interactive',
  });
  assert.deepEqual(parseFeishuText('/task mount sess_123 read_only'), {
    action: 'task_mount',
    sessionId: 'sess_123',
    mode: 'read_only',
  });
  assert.deepEqual(parseFeishuText('/handoff agy-1234abcd'), {
    action: 'handoff_preview',
    targetId: 'agy-1234abcd',
  });

  for (const bad of ['/task mount', '/task mount s1 bogus', '/task mount s1 interactive extra', '/handoff', '/handoff a b']) {
    assert.throws(() => parseFeishuText(bad), /invalid or unsupported command/);
  }
});

test('E2E: /task create -> /task mount -> /task panel -> /handoff -> confirm_handoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-w2-cp-e2e-'));
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

  const claude = makeFakeProvider('claude', 'host-1', 'svc-claude', projectDir);
  const agy = makeFakeProvider('agy', 'host-1', 'svc-agy', projectDir);
  const sClaude = claude.seed('claude-native-1');
  const sAgy = agy.seed('agy-native-1');

  const runtime = new UnifiedRuntime(makeConfig(dir, projectDir), port, [claude.port, agy.port]);
  try {
    runtime.store.insertSession(sClaude);
    runtime.store.insertSession(sAgy);

    // 1. /task <title> in main group
    const createRes = (await runtime.handleTrusted(
      { eventId: 'ev-task-create-1', destination: 'chat-main', identity: OWNER },
      parseFeishuText('/task 多后端协同排查'),
    )) as { status: string; taskId: string; destination: string; title: string; topicUrl: string | null };

    assert.equal(createRes.status, 'created');
    assert.match(createRes.taskId, /^task_[0-9a-f]{16}$/);
    assert.ok(createRes.destination.startsWith('topic:'));
    assert.equal(createRes.title, '多后端协同排查');
    assert.ok(createRes.topicUrl?.startsWith('https://applink.feishu.cn/client/thread/open?'));

    // Root card text reflects taskTopicRuntimeEnabled=true
    const rootCard = JSON.parse(sdk.created[0]!.content);
    assert.equal(
      rootCard.elements[0].content,
      '任务话题已建立，进入话题后发送 /help 查看可用功能，或发送 /task 管理后端目标。',
    );
    // Confirmation card in main group has clickable topic link button
    const confirmCard = JSON.parse(sdk.created[1]!.content);
    assert.equal(confirmCard.header.title.content, '任务话题已创建');
    assert.equal(confirmCard.elements[1].actions[0].text.content, '打开任务话题');
    assert.equal(confirmCard.elements[1].actions[0].url, createRes.topicUrl);

    // 2. /task mount <sessionId> for Claude (becomes active target automatically)
    const mountClaude = (await runtime.handleTrusted(
      { eventId: 'ev-mount-claude', destination: createRes.destination, identity: OWNER },
      parseFeishuText(`/task mount ${sClaude.sessionId} interactive`),
    )) as { status: string; targetId: string };
    assert.equal(mountClaude.status, 'mounted');

    // 3. /task mount <sessionId> for Agy
    const mountAgy = (await runtime.handleTrusted(
      { eventId: 'ev-mount-agy', destination: createRes.destination, identity: OWNER },
      parseFeishuText(`/task mount ${sAgy.sessionId} interactive`),
    )) as { status: string; targetId: string };
    assert.equal(mountAgy.status, 'mounted');

    // Latest reply in task topic is updated taskPanelCard showing both targets & switch button
    const panelReply = JSON.parse(sdk.replies.at(-1)!.content);
    assert.equal(panelReply.header.title.content, '任务目标面板');
    assert.ok(panelReply.elements[0].content.includes(mountClaude.targetId));
    assert.ok(panelReply.elements[0].content.includes(mountAgy.targetId));
    assert.doesNotMatch(panelReply.elements[0].content, /rev=|activeRev=|gen=/);

    // 4. /task (no args) inside task topic shows task panel on tick
    const repliesBeforePanel = sdk.replies.length;
    await runtime.handleTrusted(
      { eventId: 'ev-task-panel', destination: createRes.destination, identity: OWNER },
      parseFeishuText('/task'),
    );
    await runtime.tick();
    const newReplies = sdk.replies.slice(repliesBeforePanel).map((r) => JSON.parse(r.content));
    assert.ok(newReplies.some((c) => c.header?.title?.content === '任务目标面板'));

    // 5. /handoff <targetId> previews cross-target handoff and sends handoffPreviewCard
    const previewRes = (await runtime.handleTrusted(
      { eventId: 'ev-handoff-preview', destination: createRes.destination, identity: OWNER },
      parseFeishuText(`/handoff ${mountAgy.targetId}`),
    )) as { status: string; draft: { handoffId: string }; card: { actions: Array<{ value: unknown }> } };
    assert.equal(previewRes.status, 'previewed');

    const previewReply = JSON.parse(sdk.replies.at(-1)!.content);
    assert.match(previewReply.header.title.content, /跨后端交接预览/);
    const confirmBtnValue = previewReply.elements[1].actions[0].value;
    const parsedConfirm = parseFeishuAction<RuntimeTrustedAction>(confirmBtnValue);
    assert.equal(parsedConfirm.action, 'confirm_handoff');

    // 6. confirm_handoff executes structured handoff to Agy target
    await runtime.handleTrusted(
      { eventId: 'ev-handoff-confirm', destination: createRes.destination, identity: OWNER },
      parsedConfirm,
    );
    await runtime.tick();
    assert.equal(agy.inputs.length, 1);
    assert.match(agy.inputs[0]!.text, /显式任务交接摘要/);
    assert.equal(claude.inputs.length, 0);
  } finally {
    await runtime.close();
    port.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('taskTopic.enabled=false fails closed on /task and /handoff, and T0 root text is preserved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-w2-cp-t0-'));
  const projectDir = join(dir, 'proj');
  mkdirSync(projectDir, { recursive: true });
  const sdk = makeMockSdkClient('chat-main');
  const port = new FeishuSdkPort(
    { appId: APP_ID, appSecret: 'secret' },
    join(dir, 'sdk.sqlite'),
    new Set(['chat-main']),
    OWNER_ID,
    true,
    false, // T0 mode: taskTopicRuntimeEnabled=false
  );
  (port as unknown as { client: unknown }).client = sdk.client;

  const claude = makeFakeProvider('claude', 'host-1', 'svc-claude', projectDir);
  const runtime = new UnifiedRuntime(
    makeConfig(dir, projectDir, {
      taskTopic: { enabled: false },
      watchHub: { enabled: false, destination: 'chat-main' },
      pendingHub: { enabled: false, destination: 'chat-main' },
      decisionSync: { enabled: false },
    }),
    port,
    [claude.port],
  );
  try {
    // T0 createTaskTopicOnce preserves exact legacy root card text
    await port.createTaskTopic('chat-main', 't0_task_1', 'op_t0_1', OWNER_ID);
    const t0Card = JSON.parse(sdk.created[0]!.content);
    assert.equal(t0Card.elements[0].content, '任务话题已建立，目标功能待启用。');

    // /task and /handoff fail closed when taskTopic.enabled is false
    for (const cmd of ['/task 测试', '/task', '/task mount s1', '/handoff t1']) {
      await assert.rejects(
        runtime.handleTrusted(
          { eventId: `ev-disabled-${cmd}`, destination: 'chat-main', identity: OWNER },
          parseFeishuText(cmd),
        ),
        { code: 'unsupported' },
      );
    }
  } finally {
    await runtime.close();
    port.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topicLinkForTask wires jump buttons for WatchHub and PendingHub on task-mounted targets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-w2-cp-links-'));
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

  const claude = makeFakeProvider('claude', 'host-1', 'svc-claude', projectDir);
  const sClaude = claude.seed('claude-link-1');

  const runtime = new UnifiedRuntime(makeConfig(dir, projectDir), port, [claude.port]);
  try {
    runtime.store.insertSession(sClaude);

    const created = (await runtime.handleTrusted(
      { eventId: 'ev-link-task', destination: 'chat-main', identity: OWNER },
      parseFeishuText('/task 告警与待办回跳测试'),
    )) as { taskId: string; destination: string; topicUrl: string | null };
    assert.ok(created.topicUrl);

    // Direct FeishuSdkPort.topicLinkForTask check
    const directUrl = await port.topicLinkForTask('chat-main', created.taskId);
    assert.equal(directUrl, created.topicUrl);

    // Mount session on task topic
    await runtime.handleTrusted(
      { eventId: 'ev-link-mount', destination: created.destination, identity: OWNER },
      parseFeishuText(`/task mount ${sClaude.sessionId} interactive`),
    );

    // 1. WatchHub alert referencing taskId resolves topicLinkForTask jump button
    await runtime.watchHub!.ingest({
      eventId: 'watch-task-link-1',
      source: 'watch',
      objectId: 'gpu-node-7',
      state: 'alert',
      occurredAt: new Date().toISOString(),
      severity: 'high',
      title: 'GPU 温度异常',
      summary: 'GPU7 温度达到 88C',
      sourceRef: { taskId: created.taskId },
    });
    await runtime.tick();

    const watchCard = sdk.replies
      .map((r) => JSON.parse(r.content))
      .find((c) => typeof c.header?.title?.content === 'string' && c.header.title.content.includes('GPU 温度异常'));
    assert.ok(watchCard, 'WatchHub card should be delivered');
    const watchButtons = watchCard.elements.find((e: { tag: string }) => e.tag === 'action')?.actions ?? [];
    assert.ok(
      watchButtons.some((b: { url?: string }) => b.url === created.topicUrl),
      'WatchHub card should include task topic jump link',
    );

    // 2. PendingHub interaction on task-mounted session resolves topicLinkForTask jump button
    claude.emit({
      type: 'interaction',
      ref: sClaude.native,
      interaction: {
        interactionId: 'int-task-link-1',
        sessionId: sClaude.native.nativeSessionId,
        turnId: 'turn-1',
        nativeRequestId: 'req-cleanup-1',
        connectionGeneration: 1,
        revision: 1,
        status: 'awaiting_answer',
        expiresAt: null,
        toolInputDigest: payloadDigest({ cmd: 'cleanup.sh' }),
        nativeResult: null,
        kind: 'approval',
        tool: 'run_command',
        action: 'cleanup.sh',
        scope: 'this_request',
      },
    });
    await new Promise((r) => setImmediate(r));
    await runtime.tick();

    const pendingCard = sdk.replies
      .map((r) => JSON.parse(r.content))
      .find(
        (c) =>
          c.elements?.[0]?.tag === 'markdown' &&
          c.elements[0].content.includes('cleanup.sh') &&
          (c.elements.find((e: { tag: string }) => e.tag === 'action')?.actions ?? []).some(
            (b: { url?: string }) => b.url === created.topicUrl,
          ),
      );
    assert.ok(pendingCard, 'PendingHub card should be delivered with task topic jump link');
  } finally {
    await runtime.close();
    port.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scripts/wave2-operator.mjs watch-ingest, decision-create, and decision-list work against SQLite DBs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-w2-operator-'));
  const projectDir = join(dir, 'proj');
  mkdirSync(projectDir, { recursive: true });
  const cfgPath = join(dir, 'config.json');
  const runtimeConfig = makeConfig(dir, projectDir);
  writeFileSync(cfgPath, JSON.stringify({ runtime: runtimeConfig, sdkDb: join(dir, 'sdk.sqlite') }, null, 2));
  chmodSync(cfgPath, 0o600);

  const scriptPath = resolve('scripts/wave2-operator.mjs');
  const runCli = (args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
        encoding: 'utf8',
      }),
    );

  try {
    // 1. watch-ingest (abnormal -> alert, critical -> high)
    const watchRes = runCli([
      'watch-ingest',
      '--config',
      cfgPath,
      '--source',
      'watch',
      '--object',
      'train-job-42',
      '--severity',
      'critical',
      '--status',
      'abnormal',
      '--title',
      '训练任务 OOM',
      '--summary',
      'rank0 显存溢出',
      '--session',
      'session_abc',
    ]);
    assert.equal(watchRes.ok, true);
    assert.equal(watchRes.result.status, 'accepted');
    assert.equal(watchRes.result.state, 'alert');

    // 2. decision-create (business_decision)
    const decRes = runCli([
      'decision-create',
      '--config',
      cfgPath,
      '--kind',
      'business_decision',
      '--title',
      '是否切换新数据集',
      '--prompt',
      '请确认是否启用 v2 训练集',
      '--options',
      'yes:切换v2,no:保持v1',
    ]);
    assert.equal(decRes.ok, true);
    assert.equal(decRes.decision.status, 'pending');
    assert.equal(decRes.decision.syncStatus, 'synced');
    assert.match(readFileSync(runtimeConfig.decisionSync!.markdownPath!, 'utf8'), /是否切换新数据集/);

    // 3. decision-create (execution_auth)
    const authRes = runCli([
      'decision-create',
      '--config',
      cfgPath,
      '--kind',
      'execution_auth',
      '--title',
      '授权重启服务',
      '--prompt',
      '是否允许重启 worker-3',
      '--options',
      'approve:批准重启,reject:暂缓',
    ]);
    assert.equal(authRes.ok, true);
    assert.equal(authRes.decision.kind, 'execution_auth');

    // 4. decision-list
    const listRes = runCli(['decision-list', '--config', cfgPath]);
    assert.equal(listRes.ok, true);
    assert.equal(listRes.decisions.length, 2);
    assert.equal(listRes.decisions[0].status, 'pending');
    assert.equal(listRes.decisions[0].syncStatus, 'synced');

    // 5. Verify live UnifiedRuntime.tick() flushes the ingested watch alert & pending decisions to Feishu!
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
    const claude = makeFakeProvider('claude', 'host-1', 'svc-claude', projectDir);
    const runtime = new UnifiedRuntime(runtimeConfig, port, [claude.port]);
    try {
      await runtime.tick();
      const allCards = [...sdk.created, ...sdk.replies].map((m) => JSON.parse(m.content));
      assert.ok(allCards.some((c) => c.header?.title?.content?.includes('训练任务 OOM')));
      assert.ok(allCards.some((c) => c.header?.title?.content?.includes('是否切换新数据集')));
    } finally {
      await runtime.close();
      port.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
