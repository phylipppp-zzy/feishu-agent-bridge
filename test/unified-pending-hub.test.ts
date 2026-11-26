import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os, { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DispatchGuard, PlatformPort } from '../src/unified/adapter.js';
import {
  answerDigest,
  payloadDigest,
  type Answer,
  type Capabilities,
  type Interaction,
  type Provider,
  type Session,
} from '../src/unified/contracts.js';
import { DecisionSyncStore } from '../src/unified/decision-sync.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { readWaitingClaudePresence } from '../src/unified/hubs/pending-discovery.js';
import { PendingHub, type PendingHubPort } from '../src/unified/pending-hub.js';
import { UnifiedCore } from '../src/unified/service.js';
import { createIntegratedRuntime, UnifiedRuntime, type RuntimeConfig } from '../src/unified/runtime.js';
import { StoreError, UnifiedStore } from '../src/unified/store.js';

const hasCode = (expected: string) => (err: unknown) =>
  err instanceof StoreError && err.detail.code === expected;

const ALL_CAPS = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map(
    (k) => [k, { status: 'available' as const }],
  ),
) as Capabilities;

function makeSession(provider: Provider, idSuffix: string, opts?: { readOnly?: boolean; controlGen?: number }): Session {
  return {
    sessionId: `sess_${provider}_${idSuffix}`,
    native: {
      provider,
      hostId: 'host-1',
      serviceId: `svc-${provider}`,
      nativeSessionId: `native-${provider}-${idSuffix}`,
    },
    project: `/proj/${provider}`,
    title: `${provider} 任务 ${idSuffix}`,
    status: opts?.readOnly ? 'read_only' : 'idle',
    revision: 1,
    capabilities: ALL_CAPS,
    control: {
      serviceId: `svc-${provider}`,
      owner: 'owner-1',
      input: opts?.readOnly ? 'unavailable' : 'available',
      generation: opts?.controlGen ?? 1,
      operationId: null,
      reason: null,
    },
  };
}

function createFakePendingPort() {
  let msgSeq = 0;
  let topicCalls = 0;
  const sends: Array<{ destination: string; card: ChannelCard; deliveryId: string; messageId: string }> = [];
  const updates: Array<{ destination: string; messageId: string; card: ChannelCard; deliveryId: string }> = [];
  const deliveries = new Map<string, string>();

  const port: PendingHubPort = {
    createTopic: async (_destination, _sessionId, _card, deliveryId) => {
      topicCalls++;
      const dest = `topic:pending-hub-${topicCalls}`;
      deliveries.set(deliveryId, `root-msg-${topicCalls}`);
      return dest;
    },
    send: async (destination, card, deliveryId) => {
      const messageId = `pmsg-${++msgSeq}`;
      sends.push({ destination, card, deliveryId, messageId });
      deliveries.set(deliveryId, messageId);
      return messageId;
    },
    update: async (destination, messageId, card, deliveryId) => {
      updates.push({ destination, messageId, card, deliveryId });
      deliveries.set(deliveryId, messageId);
    },
    lookupMessageId: async (deliveryId) => deliveries.get(deliveryId) ?? null,
    lookupDelivery: async (deliveryId) => (deliveries.has(deliveryId) ? 'sent' : 'unknown'),
    topicLinkForSession: async (_dest, sessionId) =>
      `https://applink.feishu.cn/client/thread/open?openchatid=chat-1&openthreadid=th-${sessionId}&thread_position=1`,
  };

  return { port, sends, updates, get topicCalls() { return topicCalls; } };
}

test('runtime Pending Hub delivers read-only CLI reminders, retracts stale signals and reuses cards', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pending-cli-'));
  const directory = join(root, 'presence');
  mkdirSync(directory);
  const fake = createFakePendingPort();
  const runtime = new UnifiedRuntime({
    coreDb: join(root, 'core.sqlite'), channelDb: join(root, 'channel.sqlite'),
    ownerOpenId: 'owner-1', allowedDestinations: ['chat-1'], hostId: 'host-1',
    claudeServiceId: 'svc-claude', codexServiceId: 'svc-codex', claudeStateDir: root,
    allowedProjectRoots: [root],
    catalogSources: [{ provider: 'claude', hostId: 'host-1', serviceId: 'svc-claude', directory: root }],
    codexEndpoint: 'codex-proxy://default', intervalMs: 100, approvalPolicy: { enabled: false },
    pendingHub: { enabled: true, destination: 'chat-1' },
  }, { ...fake.port, async sendFile() {} }, []);
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const hub = runtime.pendingHub!;
  const unknownId = 'standalone-cli';
  const controlled = makeSession('claude', 'controlled');
  const agy = { ...makeSession('agy', 'external', { readOnly: true }), status: 'waiting_approval' as const };
  runtime.store.insertSession(controlled);
  runtime.store.insertSession(agy);
  const presence = (sessionId: string, state: string, overrides: Record<string, unknown> = {}) =>
    writeFileSync(join(directory, `${sessionId}.json`), JSON.stringify({
      version: 1, state, sessionId, pid: process.pid, cwd: root, at: Date.now(),
      event: 'Notification', notificationType: 'permission_prompt', ...overrides,
    }));
  const claudeRef = `cli_notice:claude:${unknownId}`;
  const agyRef = `cli_notice:agy:${agy.native.nativeSessionId}`;
  presence(unknownId, 'waiting');
  presence(controlled.native.nativeSessionId, 'waiting');
  presence('too-old-cli', 'waiting', { at: Date.now() - 11 * 60_000 });
  presence('reused-pid-cli', 'waiting', { pidStartTime: '0' });
  presence('dead-pid-cli', 'waiting', { pid: 2147483647 });
  presence('running-cli', 'running');

  assert.deepEqual(await hub.sync(), { activeCount: 2, withdrawnRefs: [] });
  const list = await hub.listPending({ category: 'approval' });
  assert.deepEqual(list.items.map(item => item.refId), [agyRef, claudeRef]);
  assert.ok(list.items.every(item => item.readonlyNotice && item.kind === 'cli_notice'));
  const agyCard = fake.sends.find(({ card }) => card.title.includes(agy.title))!;
  const claudeCard = fake.sends.find(({ card }) => card.title.startsWith('【终端待审批 · 仅提醒 · Claude'))!;
  assert.ok(agyCard && claudeCard);
  for (const { card, destination } of [agyCard, claudeCard]) {
    assert.equal(destination, 'topic:pending-hub-1');
    assert.equal(card.template, 'orange');
    assert.match(card.text, /工作目录：.*\n.*\n⚠️ 请在电脑终端中处理该审批/);
    assert.ok(card.actions.every(action => action.label === '跳回源话题' && action.url && !Object.keys(action.value).length));
  }
  assert.equal(agyCard.card.actions.length, 1);
  assert.deepEqual(claudeCard.card.actions, []);
  assert.ok(fake.sends.find(({ card }) => card.title.startsWith('待处理汇总'))!.card.text.includes('终端待审批 · 仅提醒'));
  const envelope = { eventId: 'forged', destination: 'topic:pending-hub-1', identity: { source: 'feishu', subject: 'owner-1' } };
  await assert.rejects(hub.submitFromHub(envelope, { kind: 'cli_notice', refId: claudeRef }), hasCode('unsupported'));
  await assert.rejects(hub.submitFromSource(envelope, {
    kind: 'interaction', interactionId: agyRef, sourceSessionId: agy.sessionId, revision: 1, connectionGeneration: 1,
    answer: { kind: 'approval', decision: 'allow', scope: 'this_request' }, toolInputDigest: null,
  }), hasCode('unsupported'));

  runtime.store.updateSession({ ...agy, status: 'idle', revision: agy.revision + 1 }, agy.revision, agy.control.generation);
  presence(unknownId, 'running');
  assert.deepEqual(await hub.sync(), { activeCount: 0, withdrawnRefs: [agyRef, claudeRef] });
  for (const notice of [agyCard, claudeCard]) {
    const patch = fake.updates.find(({ messageId }) => messageId === notice.messageId)!;
    assert.equal(patch.card.title, '【终端待审批 · 提醒已撤回】');
    assert.deepEqual(patch.card.actions, []);
  }
  assert.match(fake.updates.at(-1)!.card.text, /当前没有待处理事项/);
  assert.deepEqual(await hub.sync(), { activeCount: 0, withdrawnRefs: [] });

  presence(unknownId, 'waiting');
  assert.equal((await hub.sync()).activeCount, 1);
  assert.equal(hub.getRef(claudeRef)!.hub_card_message_id, claudeCard.messageId);
  assert.equal(fake.updates.findLast(({ messageId }) => messageId === claudeCard.messageId)!.card.template, 'orange');
  presence(unknownId, 'waiting', { at: Date.now() - 11 * 60_000 });
  assert.deepEqual(await hub.sync(), { activeCount: 0, withdrawnRefs: [claudeRef] });
});

test('Claude presence skips old mtimes before reading JSON and supports synthetic scan clocks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pending-cli-mtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const writePresence = (sessionId: string, at: number, mtime: number) => {
    const path = join(root, `${sessionId}.json`);
    writeFileSync(path, JSON.stringify({
      version: 1, state: 'waiting', sessionId, pid: process.pid, at,
      event: 'Notification', notificationType: 'permission_prompt',
    }));
    utimesSync(path, mtime / 1000, mtime / 1000);
    return path;
  };
  const futureScan = now + 30 * 60_000;
  writePresence('old-on-disk', futureScan - 100, now - 11 * 60_000);
  const recentPath = writePresence('fresh-on-disk', futureScan - 100, now);
  const readMock = t.mock.method(fsPromises, 'readFile');
  syncBuiltinESMExports();
  try {
    assert.deepEqual((await readWaitingClaudePresence([root], futureScan)).map(record => record.sessionId), ['fresh-on-disk']);
    assert.deepEqual(readMock.mock.calls.map(call => call.arguments[0]), [recentPath]);

    readMock.mock.resetCalls();
    const earlyScan = now - 60 * 60_000;
    const historicalPath = writePresence('early-clock', earlyScan - 100, earlyScan - 100);
    assert.deepEqual((await readWaitingClaudePresence([root], earlyScan)).map(record => record.sessionId), ['early-clock']);
    assert.ok(readMock.mock.calls.some(call => call.arguments[0] === historicalPath));
  } finally {
    readMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Claude permission presence shares integrated authorization and isolates the host default directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pending-cli-authority-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const defaultDir = join(home, '.local', 'state', 'feishu-claude-bridge', 'presence');
  const actualHome = os.homedir();
  const hostHome = actualHome === tmpdir() || actualHome.startsWith(tmpdir() + sep)
    ? join(dirname(tmpdir()), 'feishu-test-host-home') : actualHome;
  const hostDefaultDir = join(hostHome, '.local', 'state', 'feishu-claude-bridge', 'presence');
  const stateDir = join(root, 'configured');
  const configuredDir = join(stateDir, 'presence');
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  for (const path of [defaultDir, configuredDir, project, outside]) mkdirSync(path, { recursive: true });
  symlinkSync(outside, join(project, 'escape'));
  const now = Date.now();
  const presence = (dir: string, sessionId: string, overrides: Record<string, unknown> = {}) =>
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({
      version: 1, state: 'waiting', sessionId, pid: process.pid, cwd: project, at: now - 100,
      event: 'Notification', notificationType: 'permission_prompt', ...overrides,
    }));
  presence(configuredDir, 'configured-session');
  presence(defaultDir, 'default-session');
  presence(defaultDir, 'kind-session', { notificationType: null, kind: 'permission_request' });
  presence(configuredDir, 'question-session', { notificationType: 'elicitation_dialog' });
  presence(configuredDir, 'idle-session', { notificationType: 'idle_prompt' });
  presence(configuredDir, 'input-session', { notificationType: 'agent_needs_input' });
  presence(configuredDir, 'inconsistent-event', { event: 'Stop' });
  presence(configuredDir, 'outside-session', { cwd: join(project, 'escape') });
  presence(configuredDir, 'missing-project', { cwd: join(project, 'removed') });
  presence(configuredDir, 'unreadable-record');
  presence(configuredDir, 'updated-session', { at: now - 200 });
  presence(defaultDir, 'updated-session', { state: 'running', at: now - 50 });

  const config: RuntimeConfig = {
    coreDb: join(root, 'core.sqlite'), channelDb: join(root, 'channel.sqlite'),
    artifactStatePath: join(root, 'artifacts.json'), ownerOpenId: 'owner-1',
    allowedDestinations: ['chat-1'], hostId: 'host-1', claudeServiceId: 'svc-claude',
    codexServiceId: 'svc-codex', claudeStateDir: stateDir, codexEndpoint: 'codex-proxy://default',
    intervalMs: 100, allowedProjectRoots: [project], outputRoots: [],
    catalogSources: [{ provider: 'claude', directory: stateDir, hostId: 'host-1', serviceId: 'svc-claude' }],
    pendingHub: { enabled: true, destination: 'chat-1' }, approvalPolicy: { enabled: false },
  };
  const fake = createFakePendingPort();
  const port = { ...fake.port, async sendFile() {} };
  const readFile = fsPromises.readFile;
  const readdir = fsPromises.readdir;
  let defaultScans = 0;
  const homeMock = t.mock.method(os, 'homedir', () => home);
  const readMock = t.mock.method(fsPromises, 'readFile', (...args: Parameters<typeof readFile>) => {
    if (args[0] === join(configuredDir, 'unreadable-record.json')) {
      return Promise.reject(Object.assign(new Error('unreadable'), { code: 'EACCES' }));
    }
    return readFile(...args);
  });
  const scanMock = t.mock.method(fsPromises, 'readdir', (...args: Parameters<typeof readdir>) => {
    if (args[0] === defaultDir) defaultScans++;
    return readdir(...args);
  });
  const pathMock = t.mock.method(fsPromises, 'realpath');
  syncBuiltinESMExports();
  const refs = async (options: RuntimeConfig, integrated = true) => {
    const runtime = integrated ? await createIntegratedRuntime(options, port, []) : new UnifiedRuntime(options, port, []);
    try {
      return (await runtime.pendingHub!.listPending()).items.map(item => item.refId);
    } finally {
      await runtime.close();
    }
  };
  try {
    assert.deepEqual(await refs(config), [
      'cli_notice:claude:configured-session', 'cli_notice:claude:default-session', 'cli_notice:claude:kind-session',
    ]);
    assert.equal(defaultScans, 1);
    homeMock.mock.mockImplementation(() => hostHome);
    assert.deepEqual(await refs(config), ['cli_notice:claude:configured-session', 'cli_notice:claude:updated-session']);
    assert.ok(pathMock.mock.calls.every(call => call.arguments[0] !== hostDefaultDir), 'host presence is never opened');
    homeMock.mock.mockImplementation(() => home);
    assert.deepEqual(await refs({ ...config, allowedProjectRoots: [] }), []);
    assert.deepEqual(await refs({ ...config, catalogSources: [] }), []);
    await assert.rejects(refs({ ...config, catalogSources: [
      { ...config.catalogSources![0]!, serviceId: 'different-service' },
    ] }), /catalog source namespace does not match runtime configuration/);
    const { catalogSources: _sources, ...withoutSources } = config;
    assert.deepEqual(await refs(withoutSources, false), []);

    rmSync(configuredDir, { recursive: true, force: true });
    assert.deepEqual(await refs(config), ['cli_notice:claude:default-session', 'cli_notice:claude:kind-session']);
    symlinkSync(defaultDir, configuredDir);
    const scansBeforeAlias = defaultScans;
    assert.deepEqual(await refs(config), ['cli_notice:claude:default-session', 'cli_notice:claude:kind-session']);
    assert.equal(defaultScans - scansBeforeAlias, 1, 'canonical aliases are scanned once');
  } finally {
    homeMock.mock.restore();
    readMock.mock.restore();
    scanMock.mock.restore();
    pathMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('historical Pending Hub bindings do not rediscover excluded or detached read-only sessions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pending-cli-bound-'));
  const store = new UnifiedStore(join(root, 'core.sqlite'));
  const excluded = makeSession('codex', 'excluded', { readOnly: true });
  const detached = makeSession('codex', 'detached', { readOnly: true });
  const owner = { source: 'feishu', subject: 'owner-1' };
  const fake = createFakePendingPort();
  let allowExcluded = true;
  const core = new UnifiedCore(store, [], () => true, undefined, undefined,
    session => allowExcluded || session.sessionId !== excluded.sessionId);
  const hub = new PendingHub({ dbPath: join(root, 'hub.sqlite'), service: core, port: fake.port,
    owner, destination: 'chat-1' });
  t.after(() => {
    hub.close();
    core.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.insertSession({ ...excluded, status: 'waiting_approval' });
  store.insertSession(detached);
  store.detachTracking({ operationId: 'detach', idempotencyKey: 'detach', identity: owner,
    targetId: detached.sessionId, expectedRevision: detached.revision, controlGeneration: detached.control.generation });
  store.updateSession({ ...detached, status: 'waiting_approval', revision: 2 }, 1, detached.control.generation);
  for (const session of [excluded, detached]) hub.bindSourceSession(session.sessionId, `topic:${session.sessionId}`);

  const ref = `cli_notice:codex:${excluded.native.nativeSessionId}`;
  assert.deepEqual(await hub.sync(), { activeCount: 1, withdrawnRefs: [] });
  assert.deepEqual((await hub.listPending()).items.map(item => item.refId), [ref]);
  allowExcluded = false;
  assert.deepEqual(await hub.sync(), { activeCount: 0, withdrawnRefs: [ref] });
  assert.deepEqual((await hub.listPending()).items, []);
});

function createProviderPorts() {
  const respondCalls: Array<{ provider: Provider; interactionId: string; answer: unknown }> = [];
  const ports: PlatformPort[] = (['claude', 'codex', 'agy'] as Provider[]).map(
    (provider) =>
      ({
        provider,
        onObservation: () => () => {},
        respond: async (_ref: unknown, interaction: Interaction, answer: Answer, guard: DispatchGuard) => {
          guard.assertCurrent();
          respondCalls.push({ provider, interactionId: interaction.interactionId, answer });
          return { status: 'submitted', nativeReference: interaction.nativeRequestId };
        },
      }) as unknown as PlatformPort,
  );
  return { ports, respondCalls };
}

const owner = { source: 'feishu', subject: 'owner-1' };

test('aggregates 4 categories across claude/codex/agy with filtering, pagination, and empty decision baseline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pending-agg-'));
  const coreDbPath = join(dir, 'core.sqlite');
  const hubDbPath = join(dir, 'hub.sqlite');
  const decDbPath = join(dir, 'decisions.sqlite');

  const store = new UnifiedStore(coreDbPath);
  const { ports } = createProviderPorts();
  const core = new UnifiedCore(store, ports, () => true);
  const decisionStore = new DecisionSyncStore({ dbPath: decDbPath });
  const fake = createFakePendingPort();
  const hub = new PendingHub({
    dbPath: hubDbPath,
    owner,
    destination: 'chat-main',
    allowedDestinations: new Set(['chat-main', 'topic:pending-hub-1', 'topic:claude', 'topic:codex', 'topic:agy']),
    service: core,
    decisionStore,
    port: fake.port,
  });

  try {
    // Empty baseline: business_decision and execution_auth are explicitly 0 (no auto-import from docs)
    const emptyPage = await hub.listPending();
    assert.equal(emptyPage.total, 0);
    assert.equal(emptyPage.countsByCategory.business_decision, 0);
    assert.equal(emptyPage.countsByCategory.execution_auth, 0);

    // Seed sessions across all 3 providers
    for (const provider of ['claude', 'codex', 'agy'] as Provider[]) {
      const sess = makeSession(provider, '1');
      store.insertSession(sess);
      store.setConnectionGeneration(sess.sessionId, 0, 1);
      hub.bindSourceSession(sess.sessionId, `topic:${provider}`);
    }

    // Claude: question + approval
    store.insertInteraction({
      interactionId: 'int-claude-q',
      sessionId: 'sess_claude_1',
      turnId: 't1',
      nativeRequestId: 'nr-c-q',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: null,
      nativeResult: null,
      kind: 'question',
      prompt: '选择实验脚本参数？',
      choices: ['smoke', 'full'],
      multiple: false,
      allowFreeText: true,
    });
    store.insertInteraction({
      interactionId: 'int-claude-a',
      sessionId: 'sess_claude_1',
      turnId: 't1',
      nativeRequestId: 'nr-c-a',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: payloadDigest({ cmd: 'pytest' }),
      nativeResult: null,
      kind: 'approval',
      tool: 'Bash',
      action: 'run pytest',
      scope: 'this_request',
    });

    // Codex: question_group + approval
    store.insertInteraction({
      interactionId: 'int-codex-qg',
      sessionId: 'sess_codex_1',
      turnId: 't2',
      nativeRequestId: 'nr-x-qg',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: null,
      nativeResult: null,
      kind: 'question_group',
      questions: [
        { id: 'env', prompt: '目标环境', choices: ['staging', 'local'], multiple: false, allowFreeText: false },
      ],
    });
    store.insertInteraction({
      interactionId: 'int-codex-a',
      sessionId: 'sess_codex_1',
      turnId: 't2',
      nativeRequestId: 'nr-x-a',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: payloadDigest({ patch: 'src/a.ts' }),
      nativeResult: null,
      kind: 'approval',
      tool: 'file_change',
      action: 'edit src/a.ts',
      scope: 'this_request',
    });

    // Agy: question + approval
    store.insertInteraction({
      interactionId: 'int-agy-q',
      sessionId: 'sess_agy_1',
      turnId: 't3',
      nativeRequestId: 'nr-a-q',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: null,
      nativeResult: null,
      kind: 'question',
      prompt: 'Antigravity 模型选择？',
      choices: ['gemini-pro', 'gemini-flash'],
      multiple: false,
      allowFreeText: false,
    });
    store.insertInteraction({
      interactionId: 'int-agy-a',
      sessionId: 'sess_agy_1',
      turnId: 't3',
      nativeRequestId: 'nr-a-a',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: payloadDigest({ tool: 'run_command' }),
      nativeResult: null,
      kind: 'approval',
      tool: 'run_command',
      action: 'npm test',
      scope: 'this_request',
    });

    // DecisionStore: 1 business_decision + 1 execution_auth
    decisionStore.createDecision({
      decisionId: 'dec-biz-1',
      kind: 'business_decision',
      title: '决定下一轮消融实验方案',
      prompt: '选择消融维度',
      options: [{ id: 'prepare', label: '准备方案' }],
      source: { system: 'planner', sessionId: 'sess_claude_1', destination: 'topic:claude' },
    });
    decisionStore.createDecision({
      decisionId: 'dec-exec-1',
      kind: 'execution_auth',
      title: '授权执行数据校验脚本',
      prompt: '核对目标与有效期',
      options: [
        { id: 'approve', label: '授权一次' },
        { id: 'deny', label: '拒绝' },
      ],
      source: { system: 'ops', sessionId: 'sess_codex_1', destination: 'topic:codex' },
      executionSpec: {
        actionDigest: 'sha256:verify',
        target: 'local-check',
        expiry: '2030-01-01T00:00:00Z',
        executorId: 'validator',
      },
    });

    // Full listing & counts across 4 categories & 3 backends + decisions
    const p1 = await hub.listPending({ limit: 3 });
    assert.equal(p1.total, 8);
    assert.equal(p1.items.length, 3);
    assert.ok(p1.nextCursor !== null);
    assert.deepEqual(p1.countsByCategory, {
      question: 3,
      approval: 3,
      business_decision: 1,
      execution_auth: 1,
    });
    assert.deepEqual(p1.countsByProvider, {
      claude: 2,
      codex: 2,
      agy: 2,
      decision: 2,
    });

    const p2 = await hub.listPending({ limit: 3, cursor: p1.nextCursor! });
    assert.equal(p2.items.length, 3);
    const p3 = await hub.listPending({ limit: 3, cursor: p2.nextCursor! });
    assert.equal(p3.items.length, 2);
    assert.equal(p3.nextCursor, null);

    // Filter by category and provider
    const agyApprovals = await hub.listPending({ category: 'approval', provider: 'agy' });
    assert.equal(agyApprovals.total, 1);
    assert.equal(agyApprovals.items[0]!.refId, 'interaction:int-agy-a');

    // Sync to Hub + source topics and check single Hub root + jump-to-source link in summary
    const synced = await hub.sync();
    assert.equal(synced.activeCount, 8);
    assert.equal(fake.topicCalls, 1);
    const summarySend = fake.sends.find((s) => s.card.title.includes('待处理汇总'));
    assert.ok(summarySend);
    assert.match(summarySend.card.text, /模型问答: 3 项 · 工具权限: 3 项 · 业务决定: 1 项 · 执行授权: 1 项/);
    assert.ok(summarySend.card.actions.some((a) => a.url?.startsWith('https://applink.feishu.cn/')));
    const sourceApprovalId = hub.getRef('interaction:int-claude-a')?.source_card_message_id;
    const sourceApproval = fake.sends.find(send => send.messageId === sourceApprovalId)?.card;
    assert.ok(sourceApproval);
    assert.equal(sourceApproval.template, 'orange');
    assert.match(sourceApproval.text, /（已同步至「待处理」汇总，任一处处理即可）$/u);
    assert.doesNotMatch(sourceApproval.text, /int-claude-a|轻量等待引用|awaiting_answer/u);

    const assertWithdrawn = (refId: string) => {
      const ref = hub.getRef(refId);
      assert.equal(ref?.card_active, 0);
      for (const id of [ref?.source_card_message_id, ref?.hub_card_message_id]) {
        assert.ok(id);
        assert.ok(fake.updates.some(update => update.messageId === id && update.card.actions.length === 0));
      }
    };
    const decisionsDb = new DatabaseSync(decDbPath);
    try {
      decisionsDb.prepare('DELETE FROM decisions_v1 WHERE decision_id=?').run('dec-biz-1');
    } finally {
      decisionsDb.close();
    }
    store.insertInteraction({
      ...store.getInteraction('int-claude-q'),
      interactionId: 'int-claude-q-new',
      nativeRequestId: 'nr-c-q-new',
    });
    assert.deepEqual(await hub.sync(), { activeCount: 8, withdrawnRefs: ['decision:dec-biz-1'] });
    assertWithdrawn('decision:dec-biz-1');
    assert.equal(hub.getRef('interaction:int-claude-q-new')?.card_active, 1);

    const hubWithoutDecisionStore = new PendingHub({
      dbPath: hubDbPath, owner, destination: 'chat-main', service: core, port: fake.port,
    });
    try {
      assert.deepEqual(await hubWithoutDecisionStore.sync(), { activeCount: 7, withdrawnRefs: ['decision:dec-exec-1'] });
      assertWithdrawn('decision:dec-exec-1');
      assert.deepEqual(await hubWithoutDecisionStore.sync(), { activeCount: 7, withdrawnRefs: [] });
    } finally {
      hubWithoutDecisionStore.close();
    }
  } finally {
    hub.close();
    decisionStore.close();
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('competing callbacks update both cards immediately while stale background discovery is blocked', { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pending-race-'));
  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  const { ports, respondCalls } = createProviderPorts();
  const core = new UnifiedCore(store, ports, () => true);
  const decisionStore = new DecisionSyncStore({ dbPath: join(dir, 'decisions.sqlite') });
  const fake = createFakePendingPort();
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const discoveryStarted = deferred();
  const releaseDiscovery = deferred();
  const listSessions = core.listSessions.bind(core);
  let lists = 0;
  core.listSessions = async (query) => {
    lists++;
    return listSessions(query);
  };
  const linkForSession = fake.port.topicLinkForSession!;
  let holdDiscovery = false;
  let staleSync: ReturnType<PendingHub['sync']> | undefined;
  fake.port.topicLinkForSession = async (destination, sessionId) => {
    if (holdDiscovery && sessionId === 'sess_claude_race') {
      discoveryStarted.resolve();
      await releaseDiscovery.promise;
    }
    return linkForSession(destination, sessionId);
  };
  const hub = new PendingHub({
    dbPath: join(dir, 'hub.sqlite'),
    owner,
    destination: 'chat-main',
    service: core,
    decisionStore,
    port: fake.port,
  });

  try {
    const claudeSess = makeSession('claude', 'race');
    const codexSess = makeSession('codex', 'race');
    store.insertSession(claudeSess);
    store.setConnectionGeneration(claudeSess.sessionId, 0, 1);
    hub.bindSourceSession(claudeSess.sessionId, 'topic:claude-race');

    store.insertSession(codexSess);
    store.setConnectionGeneration(codexSess.sessionId, 0, 1);
    hub.bindSourceSession(codexSess.sessionId, 'topic:codex-race');

    const digest1 = payloadDigest({ cmd: 'git status' });
    const int1: Interaction = {
      interactionId: 'int-race-1',
      sessionId: claudeSess.sessionId,
      turnId: 't1',
      nativeRequestId: 'nr-race-1',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: digest1,
      nativeResult: null,
      kind: 'approval',
      tool: 'Bash',
      action: 'git status',
      scope: 'this_request',
    };
    store.insertInteraction(int1);

    const int2: Interaction = {
      interactionId: 'int-race-terminal',
      sessionId: codexSess.sessionId,
      turnId: 't2',
      nativeRequestId: 'nr-race-2',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: null,
      nativeResult: null,
      kind: 'question',
      prompt: '是否继续？',
      choices: ['yes', 'no'],
      multiple: false,
      allowFreeText: false,
    };
    store.insertInteraction(int2);

    const biz = decisionStore.createDecision({
      decisionId: 'dec-race-1',
      kind: 'business_decision',
      title: '选择分支',
      prompt: '选 A 或 B',
      options: [
        { id: 'A', label: '方案 A' },
        { id: 'B', label: '方案 B' },
      ],
      source: { system: 'planner', sessionId: claudeSess.sessionId, destination: 'topic:claude-race' },
    });

    await hub.sync();
    const ref1Before = hub.getRef('interaction:int-race-1')!;
    const ref2Before = hub.getRef('interaction:int-race-terminal')!;
    assert.ok(ref1Before.source_card_message_id);
    assert.ok(ref1Before.hub_card_message_id);
    assert.ok(ref2Before.source_card_message_id);
    assert.ok(ref2Before.hub_card_message_id);

    holdDiscovery = true;
    staleSync = hub.sync();
    await discoveryStarted.promise;
    const listsBeforeSubmit = lists;
    const sendsBeforeSubmit = fake.sends.length;
    const answer: Answer = { kind: 'approval', decision: 'allow', scope: 'this_request' };
    const hubEnvelope = { eventId: 'evt-hub-win', destination: 'topic:pending-hub-1', identity: owner };
    const sourceEnvelope = { eventId: 'evt-src-lose', destination: 'topic:claude-race', identity: owner };
    const payload = {
      kind: 'interaction' as const,
      sourceSessionId: claudeSess.sessionId,
      interactionId: int1.interactionId,
      revision: 1,
      connectionGeneration: 1,
      answer,
      toolInputDigest: digest1,
    };
    const submittedOperations = new Set<string>();
    const refRefresh = new Set<string>();
    let summaryDirty = false;
    const notifications = {
      notifyOperation: (operationId: string) => { submittedOperations.add(operationId); },
      notifyInteraction: (_sessionId: string, interactionId: string) => { refRefresh.add(interactionId); },
      notifySummary: () => { summaryDirty = true; },
    };
    const hubPayload = { ...payload, cardMessageId: ref1Before.hub_card_message_id! };
    const sourcePayload = { ...payload, cardMessageId: ref1Before.source_card_message_id! };

    const [hubAttempt, sourceAttempt] = await Promise.allSettled([
      hub.submitAnswer('hub', hubEnvelope, hubPayload, notifications),
      hub.submitAnswer('source', sourceEnvelope, sourcePayload, notifications),
    ]);
    assert.ok(summaryDirty);
    assert.equal(lists, listsBeforeSubmit, 'fast callbacks never start a summary scan');
    assert.equal([hubAttempt, sourceAttempt].filter((attempt) => attempt.status === 'fulfilled').length, 1);
    const winner = hubAttempt.status === 'fulfilled' ? hubAttempt : sourceAttempt;
    const receipt = winner.status === 'fulfilled' ? winner.value.operation! : assert.fail('missing approval winner');
    assert.equal(receipt.status, 'received');
    assert.deepEqual([...submittedOperations], [receipt.operationId]);
    assert.deepEqual([...refRefresh], [int1.interactionId]);
    assert.equal(respondCalls.length, 0);

    const [acknowledgement] = await Promise.all([
      core.dispatch(receipt.operationId),
      hub.refreshInteractionRef(int1.interactionId),
    ]);
    assert.equal(acknowledgement.status, 'accepted');
    assert.equal(store.getOutbox(receipt.operationId).state, 'done');
    assert.equal(respondCalls.filter((call) => call.interactionId === int1.interactionId).length, 1);
    assert.equal(hub.getRef('interaction:int-race-1')!.card_active, 0);
    const messageIds = [ref1Before.source_card_message_id, ref1Before.hub_card_message_id];
    for (const messageId of messageIds) {
      const patches = fake.updates.filter((update) => update.messageId === messageId);
      assert.equal(patches.length, 1);
      assert.deepEqual(patches[0]!.card.actions, []);
      assert.match(patches[0]!.card.text, /答复已提交，等待原端确认/);
    }

    // The already-claimed event is idempotent, including after the visible card advances.
    const replay = await (hubAttempt.status === 'fulfilled'
      ? hub.submitAnswer('hub', hubEnvelope, hubPayload, notifications)
      : hub.submitAnswer('source', sourceEnvelope, sourcePayload, notifications));
    assert.equal(replay.operation?.operationId, receipt.operationId);
    assert.equal(replay.operation?.status, 'accepted');
    assert.equal(lists, listsBeforeSubmit);

    holdDiscovery = false;
    releaseDiscovery.resolve();
    await staleSync;
    assert.equal(fake.sends.length, sendsBeforeSubmit, 'stale discovery must not send a replacement card');
    for (const messageId of messageIds) {
      assert.equal(fake.updates.filter((update) => update.messageId === messageId).length, 1);
    }

    const responseEvidence = {
      operationId: receipt.operationId,
      interactionId: int1.interactionId,
      nativeRequestId: int1.nativeRequestId,
      connectionGeneration: int1.connectionGeneration,
      answerDigest: answerDigest(answer),
    };
    const confirmation = {
      type: 'interaction' as const,
      ref: claudeSess.native,
      interaction: { ...int1, status: 'resolved' as const, nativeResult: { status: 'accepted' as const, source: 'adapter', answer } },
      responseEvidence,
    };
    await core.observe(confirmation);
    await hub.handleObservation(confirmation);
    assert.equal((await core.getOperation(receipt.operationId)).status, 'completed');
    for (const messageId of messageIds) {
      const patches = fake.updates.filter((update) => update.messageId === messageId);
      assert.equal(patches.length, 2, 'terminal evidence updates the same withdrawn card');
      assert.deepEqual(patches[1]!.card.actions, []);
      assert.match(patches[1]!.card.text, /原端已确认答复/);
    }

    // 2. Native terminal resolves int-race-terminal FIRST -> 0 respond calls, both cards withdrawn via observation
    await core.observe({
      type: 'interaction',
      ref: codexSess.native,
      interaction: {
        ...int2,
        status: 'resolved',
        nativeResult: { status: 'accepted', source: 'terminal', answer: { kind: 'question', values: ['yes'] } },
      },
    });
    const observedInt2 = await core.getInteraction('int-race-terminal');
    await hub.handleObservation({
      type: 'interaction',
      ref: codexSess.native,
      interaction: observedInt2,
    });

    assert.equal(respondCalls.filter((c) => c.interactionId === 'int-race-terminal').length, 0);
    assert.equal(hub.getRef('interaction:int-race-terminal')?.card_active, 0);
    assert.ok(fake.updates.some((u) => u.messageId === ref2Before.source_card_message_id && u.card.actions.length === 0));
    assert.ok(fake.updates.some((u) => u.messageId === ref2Before.hub_card_message_id && u.card.actions.length === 0));

    // Trying to submit from Hub or Source after terminal answered is rejected!
    await assert.rejects(
      hub.submitFromHub(
        { eventId: 'evt-after-term', destination: 'topic:pending-hub-1', identity: owner },
        {
          kind: 'interaction',
          sourceSessionId: codexSess.sessionId,
          interactionId: 'int-race-terminal',
          revision: 1,
          connectionGeneration: 1,
          answer: { kind: 'question', values: ['no'] },
          toolInputDigest: null,
        },
      ),
      /stale_revision|interaction_expired/,
    );
    assert.equal(respondCalls.filter((c) => c.interactionId === 'int-race-terminal').length, 0);

    // 3. Concurrent Hub vs Source answer on business_decision -> single winner, both cards withdrawn
    const [decWin, decLose] = await Promise.allSettled([
      hub.submitFromSource(
        { eventId: 'evt-dec-src', destination: 'topic:claude-race', identity: owner },
        {
          kind: 'decision',
          decisionId: biz.decisionId,
          expectedVersion: biz.version,
          expectedDigest: biz.digest,
          selectedOptionId: 'A',
        },
      ),
      hub.submitFromHub(
        { eventId: 'evt-dec-hub', destination: 'topic:pending-hub-1', identity: owner },
        {
          kind: 'decision',
          decisionId: biz.decisionId,
          expectedVersion: biz.version,
          expectedDigest: biz.digest,
          selectedOptionId: 'B',
        },
      ),
    ]);
    assert.equal([decWin, decLose].filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal([decWin, decLose].filter((r) => r.status === 'rejected').length, 1);
    assert.equal(hub.getRef('decision:dec-race-1')?.card_active, 0);
  } finally {
    releaseDiscovery.resolve();
    await staleSync?.catch(() => {});
    hub.close();
    decisionStore.close();
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects wrong owner, wrong destination, wrong card/scope, old revision/connection, readonly, and ordinary chat text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pending-guard-'));
  let nowMs = 1_800_000_000_000;
  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  const { ports, respondCalls } = createProviderPorts();
  const core = new UnifiedCore(store, ports, () => true);
  const decisionStore = new DecisionSyncStore({ dbPath: join(dir, 'decisions.sqlite'), now: () => nowMs });
  const fake = createFakePendingPort();
  const hub = new PendingHub({
    dbPath: join(dir, 'hub.sqlite'),
    owner,
    destination: 'chat-main',
    allowedDestinations: new Set(['chat-main', 'topic:pending-hub-1', 'topic:agy-src']),
    service: core,
    decisionStore,
    port: fake.port,
    now: () => nowMs,
  });

  try {
    const agySess = makeSession('agy', 'guard');
    const roSess = makeSession('claude', 'ro', { readOnly: true });
    store.insertSession(agySess);
    store.setConnectionGeneration(agySess.sessionId, 0, 2);
    hub.bindSourceSession(agySess.sessionId, 'topic:agy-src');

    store.insertSession(roSess);
    store.setConnectionGeneration(roSess.sessionId, 0, 1);
    hub.bindSourceSession(roSess.sessionId, 'topic:ro-src');

    const digest = payloadDigest({ cmd: 'echo ok' });
    store.insertInteraction({
      interactionId: 'int-guard-1',
      sessionId: agySess.sessionId,
      turnId: 't1',
      nativeRequestId: 'nr-1',
      connectionGeneration: 2,
      revision: 3,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: digest,
      nativeResult: null,
      kind: 'approval',
      tool: 'run_command',
      action: 'echo ok',
      scope: 'this_request',
    });

    store.insertInteraction({
      interactionId: 'int-ro-1',
      sessionId: roSess.sessionId,
      turnId: 't2',
      nativeRequestId: 'nr-2',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: null,
      nativeResult: null,
      kind: 'question',
      prompt: '只读会话问题',
      choices: ['A'],
      multiple: false,
      allowFreeText: false,
    });

    store.insertInteraction({
      interactionId: 'int-form-1',
      sessionId: agySess.sessionId,
      turnId: 't3',
      nativeRequestId: 'nr-3',
      connectionGeneration: 2,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: null,
      nativeResult: null,
      kind: 'question',
      prompt: '需要表单提交的问题',
      choices: ['opt1', 'opt2'],
      multiple: false,
      allowFreeText: true,
    });

    await hub.sync();
    // Read-only session interaction must NOT be surfaced as pending/actionable
    const listed = await hub.listPending();
    assert.ok(!listed.items.some((i) => i.refId === 'interaction:int-ro-1'));

    const ref = hub.getRef('interaction:int-guard-1')!;
    const validPayload = {
      kind: 'interaction' as const,
      sourceSessionId: agySess.sessionId,
      interactionId: 'int-guard-1',
      revision: 3,
      connectionGeneration: 2,
      answer: { kind: 'approval' as const, decision: 'allow' as const, scope: 'this_request' },
      toolInputDigest: digest,
      cardMessageId: ref.hub_card_message_id!,
    };

    // 1. Wrong owner
    await assert.rejects(
      hub.submitFromHub(
        { eventId: 'bad-user', destination: 'topic:pending-hub-1', identity: { source: 'feishu', subject: 'other-user' } },
        validPayload,
      ),
      hasCode('unauthorized'),
    );

    // 2. Wrong destination / group
    await assert.rejects(
      hub.submitFromHub(
        { eventId: 'bad-dest', destination: 'topic:other-group', identity: owner },
        validPayload,
      ),
      hasCode('unauthorized'),
    );

    // 3. Wrong cardMessageId
    await assert.rejects(
      hub.submitFromHub(
        { eventId: 'bad-card', destination: 'topic:pending-hub-1', identity: owner },
        { ...validPayload, cardMessageId: 'forged-card-id' },
      ),
      hasCode('invalid_request'),
    );

    // 4. Wrong targetScope
    await assert.rejects(
      hub.submitFromHub(
        { eventId: 'bad-scope', destination: 'topic:pending-hub-1', identity: owner },
        { ...validPayload, targetScope: 'sess_other' },
      ),
      hasCode('unauthorized'),
    );

    // 5. Stale revision
    await assert.rejects(
      hub.submitFromHub(
        { eventId: 'bad-rev', destination: 'topic:pending-hub-1', identity: owner },
        { ...validPayload, revision: 2 },
      ),
      hasCode('stale_revision'),
    );

    // 6. Stale connectionGeneration
    await assert.rejects(
      hub.submitFromHub(
        { eventId: 'bad-gen', destination: 'topic:pending-hub-1', identity: owner },
        { ...validPayload, connectionGeneration: 1 },
      ),
      hasCode('interaction_expired'),
    );

    // 7. Read-only session rejected
    await assert.rejects(
      hub.submitFromHub(
        { eventId: 'bad-ro', destination: 'topic:pending-hub-1', identity: owner },
        {
          kind: 'interaction',
          sourceSessionId: roSess.sessionId,
          interactionId: 'int-ro-1',
          revision: 1,
          connectionGeneration: 1,
          answer: { kind: 'question', values: ['A'] },
          toolInputDigest: null,
        },
      ),
      hasCode('control_conflict'),
    );

    // 8. Ordinary Hub chat text MUST NEVER approve or answer anything
    for (const chatText of ['同意', '允许', 'allow', 'yes', 'A', '/approve']) {
      const chatRes = await hub.handleHubText(
        { eventId: `chat-${chatText}`, destination: 'topic:pending-hub-1', identity: owner },
        chatText,
      );
      assert.equal(chatRes.handled, false);
      assert.equal(chatRes.status, 'ignored_ordinary_chat');
    }
    assert.equal(respondCalls.length, 0);
    assert.equal((await core.getInteraction('int-guard-1')).status, 'awaiting_answer');

    // 9. Verified structured question_form succeeds with exact bindingId
    const hubBindingId = createHash('sha256').update('pending-hub:singleton').digest('hex').slice(0, 16);
    const formRes = await hub.submitFromHub(
      { eventId: 'good-form', destination: 'topic:pending-hub-1', identity: owner },
      {
        kind: 'question_form',
        sourceSessionId: agySess.sessionId,
        interactionId: 'int-form-1',
        revision: 1,
        connectionGeneration: 2,
        bindingId: hubBindingId,
        fields: { q0_choice: '1', q0_text: '' },
      },
    );
    assert.equal(formRes.status, 'submitted');
    assert.equal(respondCalls.length, 1);
  } finally {
    hub.close();
    decisionStore.close();
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart never resurrects answered, expired, or old-generation permissions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pending-restart-'));
  const coreDbPath = join(dir, 'core.sqlite');
  const hubDbPath = join(dir, 'hub.sqlite');
  const decDbPath = join(dir, 'decisions.sqlite');
  let nowMs = 1_800_000_000_000;

  const store1 = new UnifiedStore(coreDbPath);
  const ports1 = createProviderPorts();
  let core = new UnifiedCore(store1, ports1.ports, () => true);
  let decisionStore = new DecisionSyncStore({ dbPath: decDbPath, now: () => nowMs });
  const fake1 = createFakePendingPort();
  let hub = new PendingHub({
    dbPath: hubDbPath,
    owner,
    destination: 'chat-main',
    service: core,
    decisionStore,
    port: fake1.port,
    now: () => nowMs,
  });

  try {
    const claudeSess = makeSession('claude', 'restart');
    store1.insertSession(claudeSess);
    store1.setConnectionGeneration(claudeSess.sessionId, 0, 1);
    hub.bindSourceSession(claudeSess.sessionId, 'topic:claude-restart');

    // Already answered before first sync
    store1.insertInteraction({
      interactionId: 'int-already-answered',
      sessionId: claudeSess.sessionId,
      turnId: 't1',
      nativeRequestId: 'nr-ans',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: null,
      nativeResult: null,
      kind: 'question',
      prompt: '已答历史题',
      choices: ['yes'],
      multiple: false,
      allowFreeText: false,
    });
    store1.recordNativeResult('int-already-answered', 1, 'nr-ans', {
      status: 'accepted',
      source: 'terminal',
      answer: { kind: 'question', values: ['yes'] },
    }, true);

    // Will expire across restart
    store1.insertInteraction({
      interactionId: 'int-will-expire',
      sessionId: claudeSess.sessionId,
      turnId: 't2',
      nativeRequestId: 'nr-exp',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: new Date(nowMs + 5_000).toISOString(),
      toolInputDigest: payloadDigest({ cmd: 'rm' }),
      nativeResult: null,
      kind: 'approval',
      tool: 'Bash',
      action: 'rm',
      scope: 'this_request',
    });

    // Old connection generation permission
    store1.insertInteraction({
      interactionId: 'int-old-gen',
      sessionId: claudeSess.sessionId,
      turnId: 't3',
      nativeRequestId: 'nr-gen',
      connectionGeneration: 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: payloadDigest({ cmd: 'ls' }),
      nativeResult: null,
      kind: 'approval',
      tool: 'Bash',
      action: 'ls',
      scope: 'this_request',
    });

    // Sync initially -> int-already-answered must NOT be surfaced! Only the 2 open items appear
    const s1 = await hub.sync();
    assert.equal(s1.activeCount, 2);
    assert.equal(hub.getRef('interaction:int-already-answered'), null);

    // Simulate restart: time advances past expiry, connection generation increments to 2
    nowMs += 20_000;
    store1.setConnectionGeneration(claudeSess.sessionId, 1, 2);

    hub.close();
    decisionStore.close();
    core.close();
    store1.close();

    // Reopen fresh instances against same SQLite DBs
    const store2 = new UnifiedStore(coreDbPath);
    const ports2 = createProviderPorts();
    core = new UnifiedCore(store2, ports2.ports, () => true);
    decisionStore = new DecisionSyncStore({ dbPath: decDbPath, now: () => nowMs });
    const fake2 = createFakePendingPort();
    hub = new PendingHub({
      dbPath: hubDbPath,
      owner,
      destination: 'chat-main',
      service: core,
      decisionStore,
      port: fake2.port,
      now: () => nowMs,
    });

    try {
      const listedAfterRestart = await hub.listPending();
      assert.equal(listedAfterRestart.total, 0);

      const s2 = await hub.sync();
      assert.equal(s2.activeCount, 0);
      // Both stale/expired cards from before restart are withdrawn, 0 new pending cards sent!
      assert.deepEqual(s2.withdrawnRefs.sort(), ['interaction:int-old-gen', 'interaction:int-will-expire']);
      assert.equal(fake2.sends.length, 0);
      assert.equal(ports2.respondCalls.length, 0);
    } finally {
      store2.close();
    }
  } finally {
    hub.close();
    decisionStore.close();
    core.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decision v1 -> v2 upgrade reusing card message IDs does not collide on second withdrawal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pending-rev-withdraw-'));
  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  const { ports } = createProviderPorts();
  const core = new UnifiedCore(store, ports, () => true);
  const decisionStore = new DecisionSyncStore({ dbPath: join(dir, 'decisions.sqlite') });
  const fake = createFakePendingPort();
  const hub = new PendingHub({
    dbPath: join(dir, 'hub.sqlite'),
    owner,
    destination: 'chat-main',
    service: core,
    decisionStore,
    port: fake.port,
  });

  try {
    const sess = makeSession('agy', 'dec-rev');
    store.insertSession(sess);
    store.setConnectionGeneration(sess.sessionId, 0, 1);
    hub.bindSourceSession(sess.sessionId, 'topic:agy-dec-rev');

    const v1 = decisionStore.createDecision({
      decisionId: 'dec-upgrade-withdraw',
      kind: 'business_decision',
      title: '选择训练超参方案',
      prompt: '请选择方案',
      options: [{ id: 'opt1', label: '方案 1' }],
      source: { system: 'planner', sessionId: sess.sessionId, destination: 'topic:agy-dec-rev' },
    });

    await hub.sync();
    const refV1 = hub.getRef('decision:dec-upgrade-withdraw')!;
    assert.equal(refV1.revision, 1);
    assert.ok(refV1.source_card_message_id);
    assert.ok(refV1.hub_card_message_id);

    // Withdraw v1 cards
    const ansV1 = await hub.submitFromHub(
      { eventId: 'evt-v1-ans', destination: 'topic:pending-hub-1', identity: owner },
      {
        kind: 'decision',
        decisionId: v1.decisionId,
        expectedVersion: v1.version,
        expectedDigest: v1.digest,
        selectedOptionId: 'opt1',
        cardMessageId: refV1.hub_card_message_id!,
      },
    );
    assert.deepEqual(ansV1.withdrawnCards, { sourceUpdated: true, hubUpdated: true });
    assert.equal(hub.getRef('decision:dec-upgrade-withdraw')?.card_active, 0);

    // Upgrade decision to v2 (reuses existing source & hub card message IDs)
    const v2 = decisionStore.updateDecision({
      decisionId: v1.decisionId,
      expectedVersion: v1.version,
      prompt: '升级后的 v2 方案确认',
      options: [{ id: 'opt2', label: '方案 2' }],
    });
    assert.equal(v2.version, 2);

    await hub.sync();
    const refV2 = hub.getRef('decision:dec-upgrade-withdraw')!;
    assert.equal(refV2.revision, 2);
    assert.equal(refV2.card_active, 1);
    assert.equal(refV2.source_card_message_id, refV1.source_card_message_id);
    assert.equal(refV2.hub_card_message_id, refV1.hub_card_message_id);

    const updatesBeforeV2Withdraw = fake.updates.length;
    const ansV2 = await hub.submitFromSource(
      { eventId: 'evt-v2-ans', destination: 'topic:agy-dec-rev', identity: owner },
      {
        kind: 'decision',
        decisionId: v2.decisionId,
        expectedVersion: v2.version,
        expectedDigest: v2.digest,
        selectedOptionId: 'opt2',
        cardMessageId: refV2.source_card_message_id!,
      },
    );
    assert.deepEqual(ansV2.withdrawnCards, { sourceUpdated: true, hubUpdated: true });
    assert.equal(hub.getRef('decision:dec-upgrade-withdraw')?.card_active, 0);

    const v2WithdrawUpdates = fake.updates.slice(updatesBeforeV2Withdraw);
    assert.equal(
      v2WithdrawUpdates.some((u) => u.messageId === refV2.source_card_message_id && u.card.actions.length === 0),
      true,
    );
    assert.equal(
      v2WithdrawUpdates.some((u) => u.messageId === refV2.hub_card_message_id && u.card.actions.length === 0),
      true,
    );
  } finally {
    hub.close();
    decisionStore.close();
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
