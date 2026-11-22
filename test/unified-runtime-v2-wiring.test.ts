import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchGuard, PlatformObservation, PlatformPort } from '../src/unified/adapter.js';
import { ArtifactRegistry } from '../src/unified/artifact-registry.js';
import {
  payloadDigest,
  type Answer,
  type Capabilities,
  type Interaction,
  type NativeSessionRef,
  type Provider,
  type Session,
} from '../src/unified/contracts.js';
import { DECISION_SYNC_END, DECISION_SYNC_START } from '../src/unified/decision-sync.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import type { FeishuPort } from '../src/unified/feishu-channel.js';
import {
  createIntegratedRuntime,
  createLiveRuntime,
  UnifiedRuntime,
  validateRuntimeConfig,
  type RuntimeConfig,
} from '../src/unified/runtime.js';
import { StoreError } from '../src/unified/store.js';
import { parseFeishuText } from '../src/unified/feishu-codec.js';

const ALL_CAPS = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map(
    (k) => [k, { status: 'available' as const }],
  ),
) as Capabilities;

const OWNER_ID = 'owner-v2';
const OWNER = { source: 'feishu', subject: OWNER_ID };

function makeFakeFeishuPort() {
  let msgSeq = 0;
  let topicSeq = 0;
  const authorized = new Set<string>(['chat-main']);
  const sent: Array<{ destination: string; messageId: string; card: ChannelCard; deliveryId: string }> = [];
  const updated: Array<{ destination: string; messageId: string; card: ChannelCard; deliveryId: string }> = [];
  const topics: Array<{ destination: string; sessionId: string; topicDestination: string; rootMessageId: string }> = [];
  const deliveries = new Map<string, string>();

  const port: FeishuPort & { authorizedDestination: (d: string) => boolean } = {
    authorizedDestination: (d) => authorized.has(d),
    isTopicDestination: (d) => topics.some((t) => t.topicDestination === d),
    createTopic: async (destination, sessionId, _card, deliveryId, guard) => {
      await guard?.();
      const existing = topics.find((t) => t.destination === destination && t.sessionId === sessionId);
      if (existing) return existing.topicDestination;
      const idx = ++topicSeq;
      const topicDestination = `topic:hub-${idx}`;
      const rootMessageId = `root-${idx}`;
      authorized.add(topicDestination);
      deliveries.set(deliveryId, rootMessageId);
      topics.push({ destination, sessionId, topicDestination, rootMessageId });
      return topicDestination;
    },
    send: async (destination, card, deliveryId, guard) => {
      await guard?.();
      const messageId = `msg-${++msgSeq}`;
      sent.push({ destination, messageId, card, deliveryId });
      deliveries.set(deliveryId, messageId);
      return messageId;
    },
    update: async (destination, messageId, card, deliveryId, guard) => {
      await guard?.();
      updated.push({ destination, messageId, card, deliveryId });
      deliveries.set(deliveryId, messageId);
    },
    sendFile: async (_destination, _name, _content, deliveryId, guard) => {
      await guard?.();
      deliveries.set(deliveryId, `file-${++msgSeq}`);
    },
    lookupDelivery: async (deliveryId) => (deliveries.has(deliveryId) ? 'sent' : 'unknown'),
    lookupMessageId: async (deliveryId) => deliveries.get(deliveryId) ?? null,
    topicLinkForSession: async (_dest, sessionId) =>
      `https://applink.feishu.cn/client/thread/open?openchatid=chat-main&openthreadid=th-${sessionId}&thread_position=1`,
  };

  return { port, sent, updated, topics };
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
      return {
        session: s,
        messages: [],
        interactions: [],
        turns: [],
        connectionGeneration: 1,
      };
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
      title: `${provider} task ${nativeSessionId}`,
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

function makeBaseIntegratedConfig(dir: string): RuntimeConfig {
  const project = join(dir, 'project');
  const claudeLogs = join(dir, 'claude-logs');
  const codexLogs = join(dir, 'codex-logs');
  mkdirSync(project, { recursive: true });
  mkdirSync(claudeLogs, { recursive: true });
  mkdirSync(codexLogs, { recursive: true });

  return {
    coreDb: join(dir, 'core.sqlite'),
    channelDb: join(dir, 'channel.sqlite'),
    artifactStatePath: join(dir, 'artifacts.json'),
    ownerOpenId: OWNER_ID,
    allowedDestinations: ['chat-main'],
    hostId: 'host-1',
    claudeServiceId: 'svc-claude',
    codexServiceId: 'svc-codex',
    claudeStateDir: join(dir, 'claude-state'),
    codexEndpoint: 'ws://127.0.0.1:1',
    intervalMs: 60_000,
    allowedProjectRoots: [project],
    outputRoots: [project],
    catalogSources: [
      { provider: 'claude', hostId: 'host-1', serviceId: 'svc-claude', directory: claudeLogs },
      { provider: 'codex', hostId: 'host-1', serviceId: 'svc-codex', directory: codexLogs },
    ],
    agy: {
      enabled: true,
      serviceId: 'svc-agy',
      summariesDbPath: join(dir, 'agy-summaries.db'),
      brainDir: join(dir, 'agy-brain'),
      quotaCachePath: join(dir, 'agy-quota.json'),
    },
  };
}

test('validateRuntimeConfig checks optional watchHub/pendingHub/decisionSync and path distinctness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-v2-val-'));
  try {
    const base = makeBaseIntegratedConfig(dir);
    validateRuntimeConfig(base);

    // Invalid watchHub
    assert.throws(
      () => validateRuntimeConfig({ ...base, watchHub: { enabled: true, destination: 'other-chat' } }),
      /watch hub/,
    );
    assert.throws(
      () => validateRuntimeConfig({ ...base, watchHub: { enabled: true, destination: 'chat-main', dbPath: 'rel.sqlite' } }),
      /watch hub/,
    );
    assert.throws(
      () => validateRuntimeConfig({ ...base, watchHub: { enabled: 'yes' as unknown as boolean, destination: 'chat-main' } }),
      /watch hub/,
    );

    // Invalid pendingHub
    assert.throws(
      () => validateRuntimeConfig({ ...base, pendingHub: { enabled: true, destination: '' } }),
      /pending hub/,
    );
    assert.throws(
      () => validateRuntimeConfig({ ...base, pendingHub: { enabled: true, destination: 'outside' } }),
      /pending hub/,
    );
    assert.throws(
      () => validateRuntimeConfig({ ...base, pendingHub: { enabled: false, destination: 'chat-main', dbPath: 'rel/p.db' } }),
      /pending hub/,
    );

    // Invalid decisionSync
    assert.throws(
      () => validateRuntimeConfig({ ...base, decisionSync: { enabled: true, dbPath: 'rel/dec.sqlite' } }),
      /decision sync/,
    );
    assert.throws(
      () => validateRuntimeConfig({ ...base, decisionSync: { enabled: true, markdownPath: 'rel/dec.md' } }),
      /decision sync/,
    );
    assert.throws(
      () =>
        validateRuntimeConfig({
          ...base,
          decisionSync: { enabled: true, protectedReadOnlyPaths: ['relative/readonly.md'] },
        }),
      /decision sync/,
    );

    // Disabled configurations validate cleanly
    validateRuntimeConfig({
      ...base,
      taskTopic: { enabled: false },
      watchHub: { enabled: false, destination: 'chat-main' },
      pendingHub: { enabled: false, destination: 'chat-main' },
      decisionSync: { enabled: false },
    });

    // Duplicate DB paths across enabled hubs fail distinctness in createIntegratedRuntime and createLiveRuntime
    const dupPath = join(dir, 'shared-hub.sqlite');
    const fake = makeFakeFeishuPort();
    await assert.rejects(
      createIntegratedRuntime(
        {
          ...base,
          watchHub: { enabled: true, destination: 'chat-main', dbPath: dupPath },
          pendingHub: { enabled: true, destination: 'chat-main', dbPath: dupPath },
        },
        fake.port,
        [],
      ),
      /runtime state paths must be distinct/,
    );

    await assert.rejects(
      createLiveRuntime(
        {
          ...base,
          decisionSync: { enabled: true, dbPath: dupPath },
        },
        { appId: 'cli_test', appSecret: 'sec_test' },
        dupPath,
      ),
      /distinct SDK database required/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('omitted or disabled T1/T2/N1/N2/D1 flags produce zero side effects and zero extra SQLite files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-v2-off-'));
  try {
    const base = makeBaseIntegratedConfig(dir);
    const project = join(dir, 'project');
    const fake = makeFakeFeishuPort();
    const claude = makeFakeProvider('claude', 'host-1', 'svc-claude', project);
    const codex = makeFakeProvider('codex', 'host-1', 'svc-codex', project);

    // 1. Completely omitted flags on UnifiedRuntime
    const direct = new UnifiedRuntime(
      {
        coreDb: join(dir, 'direct-core.sqlite'),
        channelDb: join(dir, 'direct-channel.sqlite'),
        ownerOpenId: OWNER_ID,
        allowedDestinations: ['chat-main'],
        hostId: 'host-1',
        claudeServiceId: 'svc-claude',
        codexServiceId: 'svc-codex',
        claudeStateDir: join(dir, 'claude-state'),
        codexEndpoint: 'ws://127.0.0.1:1',
        intervalMs: 60_000,
      },
      fake.port,
      [claude.port, codex.port],
    );
    try {
      assert.equal(direct.watchHub, undefined);
      assert.equal(direct.pendingHub, undefined);
      assert.equal(direct.decisionSync, undefined);
      assert.equal(direct.taskChannel, undefined);
      assert.equal(direct.taskHandoff, undefined);
      await direct.handleTrusted(
        { eventId: 'evt-help', destination: 'chat-main', identity: OWNER },
        parseFeishuText('/help'),
      );
      await direct.tick();
      assert.equal(existsSync(join(dir, 'watch-hub.sqlite')), false);
      assert.equal(existsSync(join(dir, 'pending-hub.sqlite')), false);
      assert.equal(existsSync(join(dir, 'decision-sync.sqlite')), false);
    } finally {
      await direct.close();
    }

    // 2. Explicitly enabled: false on createIntegratedRuntime
    const integrated = await createIntegratedRuntime(
      {
        ...base,
        taskTopic: { enabled: false },
        watchHub: { enabled: false, destination: 'chat-main', dbPath: join(dir, 'disabled-watch.sqlite') },
        pendingHub: { enabled: false, destination: 'chat-main', dbPath: join(dir, 'disabled-pending.sqlite') },
        decisionSync: { enabled: false, dbPath: join(dir, 'disabled-decision.sqlite') },
      },
      fake.port,
      [claude.port, codex.port],
    );
    try {
      assert.equal(integrated.watchHub, undefined);
      assert.equal(integrated.pendingHub, undefined);
      assert.equal(integrated.decisionSync, undefined);
      assert.equal(integrated.taskChannel, undefined);
      assert.equal(integrated.taskHandoff, undefined);
      await integrated.tick();
      assert.equal(existsSync(join(dir, 'disabled-watch.sqlite')), false);
      assert.equal(existsSync(join(dir, 'disabled-pending.sqlite')), false);
      assert.equal(existsSync(join(dir, 'disabled-decision.sqlite')), false);
    } finally {
      await integrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opt-in T1/T2/N1/N2/D1 joint workflow across claude + codex + agy and clean SQLite close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-v2-joint-'));
  try {
    const base = makeBaseIntegratedConfig(dir);
    const project = join(dir, 'project');
    const legacyDoc = join(dir, '待你决定.md');
    const syncDoc = join(dir, 'decisions-view.md');
    writeFileSync(legacyDoc, '# 只读历史文件\n严禁改写\n', 'utf8');
    const humanHead = '# 联合流程决定视图\n\n人工说明保留。\n';
    const humanTail = '\n## 附录\n保留末尾。\n';
    writeFileSync(syncDoc, `${humanHead}${DECISION_SYNC_START}\n${DECISION_SYNC_END}${humanTail}`, 'utf8');

    const cfg: RuntimeConfig = {
      ...base,
      taskTopic: { enabled: true },
      watchHub: { enabled: true, destination: 'chat-main' },
      pendingHub: { enabled: true, destination: 'chat-main' },
      decisionSync: {
        enabled: true,
        markdownPath: syncDoc,
        protectedReadOnlyPaths: [legacyDoc],
      },
    };
    validateRuntimeConfig(cfg);

    const fake = makeFakeFeishuPort();
    const claude = makeFakeProvider('claude', 'host-1', 'svc-claude', project);
    const codex = makeFakeProvider('codex', 'host-1', 'svc-codex', project);
    const agy = makeFakeProvider('agy', 'host-1', 'svc-agy', project);

    const sClaude = claude.seed('cl-1');
    const sCodex = codex.seed('cx-1');
    const sAgy = agy.seed('ag-1');

    // Stage an artifact file under project so handoff references a verified ArtifactRegistry entry
    const specFile = join(project, 'handoff-spec.md');
    writeFileSync(specFile, 'API spec v1\n', 'utf8');
    const preReg = new ArtifactRegistry({}, 20 * 1024 * 1024, base.artifactStatePath!);
    preReg.setRoots(sCodex.native, [project]);
    const stagedArt = await preReg.register(
      JSON.stringify([sCodex.native.provider, sCodex.native.hostId, sCodex.native.serviceId, sCodex.native.nativeSessionId]),
      specFile,
      'text/markdown',
    );

    const runtime = await createIntegratedRuntime(cfg, fake.port, [claude.port, codex.port, agy.port]);
    try {
      assert.ok(runtime.watchHub);
      assert.ok(runtime.pendingHub);
      assert.ok(runtime.decisionSync);
      assert.ok(runtime.taskChannel);
      assert.ok(runtime.taskHandoff);

      // Verify protectedReadOnlyPaths enforcement
      assert.throws(
        () => runtime.decisionSync!.syncMarkdownDocument(legacyDoc),
        (err: unknown) => err instanceof StoreError && err.detail.code === 'unauthorized',
      );
      assert.equal(readFileSync(legacyDoc, 'utf8'), '# 只读历史文件\n严禁改写\n');

      // Attach all 3 sessions interactively through core
      for (const [idx, s] of [sClaude, sCodex, sAgy].entries()) {
        const op = await runtime.core.attachSession({
          context: {
            operationId: `att-${idx}`,
            idempotencyKey: `att-${idx}`,
            targetId: `new:${s.native.provider}`,
            expectedRevision: 0,
            controlGeneration: 0,
            identity: OWNER,
          },
          payload: { ...s.native, mode: 'interactive' },
        });
        assert.equal(op.status, 'completed');
      }

      // 1. Register T1 task topic and mount all 3 backends simultaneously
      const binding = runtime.taskChannel!.registerTask({
        taskId: 'task-joint-1',
        destination: 'topic:task-joint-1',
        rootGeneration: 1,
        owner: OWNER,
      });
      await runtime.taskChannel!.mountTarget({
        taskId: binding.taskId,
        targetId: 't-claude',
        sessionId: sClaude.sessionId,
        native: sClaude.native,
        accessMode: 'interactive',
        owner: OWNER,
        makeActive: true,
      });
      await runtime.taskChannel!.mountTarget({
        taskId: binding.taskId,
        targetId: 't-codex',
        sessionId: sCodex.sessionId,
        native: sCodex.native,
        accessMode: 'interactive',
        owner: OWNER,
      });
      await runtime.taskChannel!.mountTarget({
        taskId: binding.taskId,
        targetId: 't-agy',
        sessionId: sAgy.sessionId,
        native: sAgy.native,
        accessMode: 'interactive',
        owner: OWNER,
      });

      // Route captureResourceScope & text input through UnifiedRuntime
      const scopeJson = await runtime.captureResourceScope({
        eventId: 'cap-task-1',
        destination: 'topic:task-joint-1',
        identity: OWNER,
      });
      assert.equal(JSON.parse(scopeJson).targetId, 't-claude');

      await runtime.handleTrusted(
        { eventId: 'msg-task-cl', destination: 'topic:task-joint-1', identity: OWNER },
        parseFeishuText('请 Claude 检查脚本'),
      );
      await runtime.tick();
      assert.equal(claude.inputs.length, 1);
      assert.equal(claude.inputs[0]!.text, '请 Claude 检查脚本');

      // Switch active target to agy via handleTrusted card action
      const currentBinding = runtime.taskChannel!.getBinding(binding.taskId)!;
      await runtime.handleTrusted(
        { eventId: 'card:switch-agy', destination: 'topic:task-joint-1', identity: OWNER },
        {
          action: 'switch_target',
          taskId: binding.taskId,
          rootGeneration: currentBinding.rootGeneration,
          activeRevision: currentBinding.activeRevision,
          targetId: 't-agy',
        },
      );
      await runtime.tick();
      assert.equal(runtime.taskChannel!.getBinding(binding.taskId)!.activeTargetId, 't-agy');

      // 2. T2 Handoff: codex -> agy preview + confirm via handleTrusted
      const { draft } = await runtime.taskHandoff!.previewHandoff({
        handoffId: 'hoff-joint-1',
        taskId: binding.taskId,
        sourceTargetId: 't-codex',
        targetTargetId: 't-agy',
        owner: OWNER,
        summary: 'Codex 已完成契约草稿，请 Antigravity 补齐验收用例。',
        constraints: ['禁止执行破坏性命令'],
        artifactRefs: [
          {
            artifactId: stagedArt.artifactId,
            name: 'handoff-spec.md',
            contentVersion: stagedArt.contentVersion,
          },
        ],
      });
      assert.equal(agy.inputs.length, 0);

      const confirmRes = (await runtime.handleTrusted(
        { eventId: 'card:confirm-hoff', destination: 'topic:task-joint-1', identity: OWNER },
        {
          action: 'confirm_handoff',
          handoffId: draft.handoffId,
          taskId: binding.taskId,
          previewDigest: draft.previewDigest,
          targetGeneration: draft.targetGeneration,
          activeRevision: draft.activeRevision,
        },
      )) as { status: string };
      assert.equal(confirmRes.status, 'submitted');
      await runtime.tick();
      assert.equal(agy.inputs.length, 1);
      assert.match(agy.inputs[0]!.text, /Codex 已完成契约草稿/);
      assert.equal(codex.inputs.length, 0);

      // 3. N1 WatchHub: reject unauthorized weekly_report, flush authorized agy_status on tick
      await assert.rejects(
        runtime.watchHub!.ingest({
          eventId: 'bad-weekly',
          source: 'weekly_report' as never,
          objectId: 'rep-1',
          state: 'info',
          occurredAt: new Date().toISOString(),
          severity: 'normal',
          title: '周报',
          summary: '不应进入 watchHub',
        }),
        /unauthorized/,
      );
      await runtime.watchHub!.ingest({
        eventId: 'watch-agy-1',
        source: 'agy_status',
        objectId: 'agy-worker-1',
        state: 'alert',
        occurredAt: new Date().toISOString(),
        severity: 'high',
        title: 'Antigravity 节点状态提醒',
        summary: '模型配额接近阈值',
        sourceRef: { taskId: binding.taskId },
      });

      // 4. N2 PendingHub + D1 DecisionSync: agy approval + business_decision
      const approvalDigest = payloadDigest({ cmd: 'npm test' });
      const agyApproval: Interaction = {
        interactionId: 'int-agy-joint',
        sessionId: sAgy.native.nativeSessionId,
        turnId: 'turn-agy-1',
        nativeRequestId: 'nr-agy-1',
        connectionGeneration: 1,
        revision: 1,
        status: 'awaiting_answer',
        expiresAt: null,
        toolInputDigest: approvalDigest,
        nativeResult: null,
        kind: 'approval',
        tool: 'run_command',
        action: 'npm test',
        scope: 'this_request',
      };
      agy.emit({ type: 'interaction', ref: sAgy.native, interaction: agyApproval });
      await new Promise((r) => setImmediate(r));

      const bizDec = runtime.decisionSync!.createDecision({
        decisionId: 'DEC-JOINT-1',
        kind: 'business_decision',
        title: '确认下一阶段实验方案',
        prompt: '是否先准备消融方案？',
        options: [{ id: 'prepare', label: '准备方案' }],
        source: { system: 'planner', sessionId: sAgy.sessionId, destination: 'topic:task-joint-1' },
      });

      await runtime.tick();

      // WatchHub flushed 1 card to its dedicated root topic
      const watchRoot = runtime.watchHub!.getRoot()!;
      assert.equal(watchRoot.state, 'active');
      assert.equal(
        fake.sent.filter((s) => s.destination === watchRoot.topicDestination).length,
        1,
      );

      // PendingHub tracked taskChannel's source card instead of sending a duplicate source card
      const pendingRoot = runtime.pendingHub!.getRoot()!;
      assert.equal(pendingRoot.state, 'active');
      const intRef = runtime.pendingHub!.getRef('interaction:int-agy-joint')!;
      assert.equal(intRef.card_active, 1);
      assert.equal(intRef.source_destination, 'topic:task-joint-1');
      assert.ok(intRef.source_card_message_id);
      assert.ok(intRef.hub_card_message_id);
      const taskSourceCardsForAgy = fake.sent.filter(
        (s) => s.destination === 'topic:task-joint-1' && s.card.title.includes('审批'),
      );
      assert.equal(taskSourceCardsForAgy.length, 1);

      // Ordinary text in PendingHub topic NEVER approves anything
      const chatRes = (await runtime.handleTrusted(
        { eventId: 'hub-chat-1', destination: pendingRoot.topicDestination!, identity: OWNER },
        parseFeishuText('同意'),
      )) as { handled: boolean; status: string };
      assert.equal(chatRes.handled, false);
      assert.equal(chatRes.status, 'ignored_ordinary_chat');
      assert.equal(agy.responds.length, 0);

      // Answer agy approval through PendingHub -> withdraws BOTH task topic card and hub card
      await runtime.handleTrusted(
        { eventId: 'card:hub-ans-agy', destination: pendingRoot.topicDestination!, identity: OWNER },
        {
          action: 'answer',
          entry: 'hub',
          sourceSessionId: sAgy.sessionId,
          interactionId: 'int-agy-joint',
          revision: 1,
          connectionGeneration: 1,
          answer: { kind: 'approval', decision: 'allow', scope: 'this_request' },
          toolInputDigest: approvalDigest,
        } as never,
      );
      assert.equal(agy.responds.length, 1);
      assert.equal(runtime.pendingHub!.getRef('interaction:int-agy-joint')?.card_active, 0);
      assert.ok(
        fake.updated.some((u) => u.messageId === intRef.source_card_message_id && u.card.actions.length === 0),
      );
      assert.ok(
        fake.updated.some((u) => u.messageId === intRef.hub_card_message_id && u.card.actions.length === 0),
      );

      // Answer business_decision through handleTrusted -> tick flushes anchored Markdown preserving human sections
      await runtime.handleTrusted(
        { eventId: 'card:hub-dec-1', destination: pendingRoot.topicDestination!, identity: OWNER },
        {
          action: 'decision_answer',
          entry: 'hub',
          decisionId: bizDec.decisionId,
          expectedVersion: bizDec.version,
          expectedDigest: bizDec.digest,
          selectedOptionId: 'prepare',
        },
      );
      await runtime.tick();

      const syncedMd = readFileSync(syncDoc, 'utf8');
      assert.ok(syncedMd.startsWith(humanHead));
      assert.ok(syncedMd.endsWith(humanTail));
      assert.match(syncedMd, /DEC-JOINT-1/);
      assert.match(syncedMd, /已登记答复: prepare/);
      assert.equal(runtime.decisionSync!.getDecision('DEC-JOINT-1').syncStatus, 'synced');
    } finally {
      const watchHub = runtime.watchHub;
      const pendingHub = runtime.pendingHub;
      const decisionSync = runtime.decisionSync;
      const taskChannel = runtime.taskChannel;
      await runtime.close();
      await runtime.close(); // Idempotent close

      // All SQLite handles must be closed cleanly
      assert.throws(() => watchHub!.listOutbox());
      assert.throws(() => decisionSync!.listDecisions());
      assert.throws(() => taskChannel!.listActiveBindings());
      assert.throws(() => pendingHub!.getRoot());
    }

    // Reopening fresh runtime on the same directory succeeds immediately after close()
    const reopened = await createIntegratedRuntime(cfg, fake.port, [claude.port, codex.port, agy.port]);
    try {
      assert.equal(reopened.decisionSync!.getDecision('DEC-JOINT-1').status, 'answered');
      assert.equal(reopened.taskChannel!.getBinding('task-joint-1')?.activeTargetId, 't-agy');
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
