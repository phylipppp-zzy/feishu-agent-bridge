import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchGuard, PlatformPort } from '../src/unified/adapter.js';
import {
  payloadDigest,
  type Answer,
  type Capabilities,
  type Interaction,
  type Provider,
  type Session,
} from '../src/unified/contracts.js';
import { DecisionSyncStore } from '../src/unified/decision-sync.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { PendingHub, type PendingHubPort } from '../src/unified/pending-hub.js';
import { UnifiedCore } from '../src/unified/service.js';
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
  } finally {
    hub.close();
    decisionStore.close();
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('3-way competition (source vs hub vs native terminal) guarantees single winner and withdraws both cards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pending-race-'));
  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  const { ports, respondCalls } = createProviderPorts();
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

    // 1. Concurrent Hub vs Source answer on int-race-1 -> ONLY ONE winner, port.respond called ONCE, both cards withdrawn
    const [hubAttempt, srcAttempt] = await Promise.allSettled([
      hub.submitFromHub(
        { eventId: 'evt-hub-win', destination: 'topic:pending-hub-1', identity: owner },
        {
          kind: 'interaction',
          sourceSessionId: claudeSess.sessionId,
          interactionId: 'int-race-1',
          revision: 1,
          connectionGeneration: 1,
          answer: { kind: 'approval', decision: 'allow', scope: 'this_request' },
          toolInputDigest: digest1,
          cardMessageId: ref1Before.hub_card_message_id!,
        },
      ),
      hub.submitFromSource(
        { eventId: 'evt-src-lose', destination: 'topic:claude-race', identity: owner },
        {
          kind: 'interaction',
          sourceSessionId: claudeSess.sessionId,
          interactionId: 'int-race-1',
          revision: 1,
          connectionGeneration: 1,
          answer: { kind: 'approval', decision: 'deny', scope: 'this_request' },
          toolInputDigest: digest1,
          cardMessageId: ref1Before.source_card_message_id!,
        },
      ),
    ]);

    const fulfilled = [hubAttempt, srcAttempt].filter((r) => r.status === 'fulfilled');
    const rejected = [hubAttempt, srcAttempt].filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(respondCalls.filter((c) => c.interactionId === 'int-race-1').length, 1);

    const ref1After = hub.getRef('interaction:int-race-1')!;
    assert.equal(ref1After.card_active, 0);
    // Both source card and hub card updated with actions: []
    const srcWithdraw1 = fake.updates.find((u) => u.messageId === ref1Before.source_card_message_id);
    const hubWithdraw1 = fake.updates.find((u) => u.messageId === ref1Before.hub_card_message_id);
    assert.ok(srcWithdraw1 && srcWithdraw1.card.actions.length === 0);
    assert.ok(hubWithdraw1 && hubWithdraw1.card.actions.length === 0);

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
