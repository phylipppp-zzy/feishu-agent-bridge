import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchGuard, PlatformObservation, PlatformPort } from '../src/unified/adapter.js';
import { formatApprovalAction, shortenHomePath } from '../src/unified/card-formatters.js';
import {
  payloadDigest,
  type Answer,
  type Capabilities,
  type Interaction,
  type NativeSessionRef,
  type Session,
} from '../src/unified/contracts.js';
import { interactionCard, type ChannelCard } from '../src/unified/feishu-cards.js';
import type { FeishuPort } from '../src/unified/feishu-channel.js';
import { UnifiedRuntime, type RuntimeConfig } from '../src/unified/runtime.js';

const ALL_CAPS = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map(
    (k) => [k, { status: 'available' as const }],
  ),
) as Capabilities;

const OWNER_ID = 'owner-approval-ux';
const OWNER = { source: 'feishu', subject: OWNER_ID };

function makeFakePort(options: { failFirstUpdateForDestination?: string } = {}) {
  let msgSeq = 0;
  let topicSeq = 0;
  let failedOnce = false;
  const authorized = new Set<string>(['chat-main', 'topic:agy-1']);
  const sent: Array<{ destination: string; messageId: string; card: ChannelCard; deliveryId: string }> = [];
  const updated: Array<{ destination: string; messageId: string; card: ChannelCard; deliveryId: string }> = [];
  const topics: Array<{ destination: string; sessionId: string; topicDestination: string; rootMessageId: string }> = [];
  const deliveries = new Map<string, string>();

  const port: FeishuPort & { authorizedDestination: (d: string) => boolean } = {
    authorizedDestination: (d) => authorized.has(d),
    isTopicDestination: (d) => d.startsWith('topic:'),
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
      if (options.failFirstUpdateForDestination === destination && !failedOnce) {
        failedOnce = true;
        throw new Error('transient Feishu PATCH error');
      }
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

function makeFakeAgyPort(hostId: string, serviceId: string, projectDir: string) {
  const listeners = new Set<(o: PlatformObservation) => void>();
  const responds: Array<{ ref: NativeSessionRef; interactionId: string; answer: Answer; operationId?: string }> = [];
  const interactions: Interaction[] = [];
  const nativeRef: NativeSessionRef = { provider: 'agy', hostId, serviceId, nativeSessionId: 'agy-native-1' };
  const session: Session = {
    sessionId: 'agy-native-1',
    native: nativeRef,
    project: projectDir,
    title: 'AGY approval test',
    status: 'idle',
    revision: 0,
    capabilities: ALL_CAPS,
    control: { serviceId, owner: null, input: 'available', generation: 1, operationId: null, reason: null },
  };
  const port = {
    provider: 'agy',
    onObservation: (fn: (observation: PlatformObservation) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    read: async () => ({ session, messages: [], interactions }),
    respond: async (ref: NativeSessionRef, interaction: Interaction, answer: Answer, guard: DispatchGuard) => {
      guard.assertCurrent();
      responds.push({ ref, interactionId: interaction.interactionId, answer, ...(guard.operationId !== undefined ? { operationId: guard.operationId } : {}) });
      return { status: 'submitted' as const, nativeReference: interaction.nativeRequestId };
    },
  } as unknown as PlatformPort;
  const emit = (obs: PlatformObservation) => {
    if (obs.type === 'interaction') {
      const idx = interactions.findIndex((i) => i.interactionId === obs.interaction.interactionId);
      if (idx >= 0) interactions[idx] = obs.interaction;
      else interactions.push(obs.interaction);
    }
    for (const fn of listeners) fn(obs);
  };
  return { port, session, nativeRef, responds, interactions, emit };
}

test('formatApprovalAction renders MCP and structured non-shell/file tools without empty-detail fallback', () => {
  const mcpAction = [
    '无法确认工具的完整参数或影响范围，需人工审批',
    JSON.stringify({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_5813859733774878188',
      name: 'call_mcp_tool',
      args: {
        ServerName: 'codex-bridge_codex',
        ToolName: 'codex_job',
        Arguments: { action: 'wait', job_id: 'job-20261125-175934-8374ff68', wait_seconds: 120 },
      },
      status: 'pending',
      kind: 'execute',
      title: 'MCP Tool codex_job',
    }),
  ].join('\n');

  const mcpView = formatApprovalAction('MCP Tool codex_job', mcpAction, 'this_request');
  assert.equal(mcpView.toolLabel, 'MCP · codex_job');
  assert.equal(mcpView.compactTarget, 'codex-bridge_codex / codex_job');
  assert.doesNotMatch(mcpView.text, /原端未提供可展示的操作详情/);
  assert.ok(mcpView.text.includes('codex-bridge_codex / codex_job'));
  assert.ok(mcpView.text.includes('action: wait'));
  assert.ok(mcpView.text.includes('job_id: job-20261125-175934-8374ff68'));
  assert.ok(mcpView.text.includes('wait_seconds: 120'));

  const webView = formatApprovalAction(
    'search_web',
    JSON.stringify({ name: 'search_web', args: { query: 'feishu card 2.0 markdown', domain: 'open.feishu.cn' } }),
    'this_request',
  );
  assert.equal(webView.toolLabel, '网页搜索');
  assert.equal(webView.compactTarget, 'query: feishu card 2.0 markdown');
  assert.doesNotMatch(webView.text, /原端未提供可展示的操作详情/);
  assert.ok(webView.text.includes('query: feishu card 2.0 markdown'));
  assert.ok(webView.text.includes('domain: open.feishu.cn'));

  // Empty args:{} must not shadow non-empty rawInput, and "Run MCP Tool ..." must not mislabel as shell
  const emptyArgsFallbackView = formatApprovalAction(
    'search_web',
    JSON.stringify({ name: 'search_web', args: {}, rawInput: { query: 'fallback query' } }),
    'this_request',
  );
  assert.ok(emptyArgsFallbackView.text.includes('query: fallback query'));
  assert.equal(emptyArgsFallbackView.compactTarget, 'query: fallback query');

  const verbPrefixedMcpView = formatApprovalAction(
    'Run MCP Tool codex_job',
    JSON.stringify({
      name: 'call_mcp_tool',
      args: { ServerName: 'codex-bridge_codex', ToolName: 'codex_job', Arguments: {} },
      rawInput: { Arguments: { action: 'status', job_id: 'job-99' } },
    }),
    'this_request',
  );
  assert.equal(verbPrefixedMcpView.toolLabel, 'MCP · codex_job');
  assert.ok(verbPrefixedMcpView.text.includes('action: status'));
  assert.ok(verbPrefixedMcpView.text.includes('job_id: job-99'));

  // Sensitive keys and nested auth headers must be redacted, while non-secret keys like author/max_tokens remain visible
  const secretMcpView = formatApprovalAction(
    'MCP Tool http_request',
    JSON.stringify({
      name: 'call_mcp_tool',
      args: {
        ServerName: 'api-bridge',
        ToolName: 'http_request',
        Arguments: {
          url: 'https://api.example.com/v1',
          apiKey: 'sk-live-secret-12345',
          client_secret: 'cs-hidden-999',
          headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret', 'X-Api-Key': 'k-secret', 'X-Trace': 'trace-1' },
          authHeader: 'Basic dXNlcjpwYXNz',
          author: 'alice',
          max_tokens: 512,
        },
      },
    }),
    'this_request',
  );
  assert.ok(secretMcpView.text.includes('url: https://api.example.com/v1'));
  assert.ok(secretMcpView.text.includes('apiKey: [已脱敏]'));
  assert.ok(secretMcpView.text.includes('client_secret: [已脱敏]'));
  assert.ok(secretMcpView.text.includes('author: alice'));
  assert.ok(secretMcpView.text.includes('max_tokens: 512'));
  assert.ok(secretMcpView.text.includes('trace-1'));
  assert.doesNotMatch(secretMcpView.text, /sk-live-secret-12345|cs-hidden-999|eyJhbGciOiJIUzI1NiJ9|k-secret|dXNlcjpwYXNz/);

  const writeFileView = formatApprovalAction(
    'File ../../../scripts/codex_dispatch.py',
    JSON.stringify({ name: 'write_file', args: { Path: '/home/zhangzy/scripts/codex_dispatch.py', Content: 'hidden-body' } }),
    'this_request',
  );
  const expectedShortPath = shortenHomePath('/home/zhangzy/scripts/codex_dispatch.py');
  assert.equal(writeFileView.toolLabel, '写入文件');
  assert.equal(writeFileView.compactTarget, expectedShortPath);
  assert.ok(writeFileView.text.includes(expectedShortPath));
  assert.doesNotMatch(writeFileView.text, /hidden-body/);

  const emptyView = formatApprovalAction('unknown_tool', '{}', 'this_request');
  assert.equal(emptyView.compactTarget, '');
  assert.ok(emptyView.text.includes('原端未提供可展示的操作详情。'));
});

test('interactionCard compresses finished approval cards into compact single-line status with no buttons', () => {
  const baseRequest: Extract<Interaction, { kind: 'approval' }> = {
    interactionId: 'int-compact-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    nativeRequestId: 'nr-1',
    connectionGeneration: 1,
    revision: 2,
    status: 'awaiting_answer',
    expiresAt: null,
    toolInputDigest: 'digest-1',
    nativeResult: null,
    kind: 'approval',
    tool: 'run_command',
    action: '需要人工确认\n' + JSON.stringify({ CommandLine: 'python3 scripts/train.py --epochs 100\necho done' }),
    scope: 'this_request',
  };

  // Awaiting (interactive and read-only) keeps full detail
  const awaitingInteractive = interactionCard(baseRequest, false);
  assert.ok(awaitingInteractive.text.includes('**操作内容**'));
  assert.equal(awaitingInteractive.actions.length, 2);
  const awaitingReadonly = interactionCard(baseRequest, true);
  assert.ok(awaitingReadonly.text.includes('**操作内容**'));
  assert.ok(awaitingReadonly.text.includes('此话题为只读'));
  assert.equal(awaitingReadonly.actions.length, 0);

  // All finished/in-flight states compress into a single line with no buttons or code blocks
  const finishedCases: Array<{
    label: string;
    interaction: Extract<Interaction, { kind: 'approval' }>;
    expectedTitle: string;
    expectedTemplate: ChannelCard['template'];
    expectedStatus: string;
  }> = [
    {
      label: 'confirmed allow',
      interaction: {
        ...baseRequest,
        status: 'resolved',
        nativeResult: { status: 'accepted', source: 'agy', answer: { kind: 'approval', decision: 'allow', scope: 'this_request' } },
      },
      expectedTitle: '审批 · 已确认',
      expectedTemplate: 'green',
      expectedStatus: '原端已确认答复',
    },
    {
      label: 'denied',
      interaction: {
        ...baseRequest,
        status: 'resolved',
        nativeResult: { status: 'accepted', source: 'agy', answer: { kind: 'approval', decision: 'deny', scope: 'this_request' } },
      },
      expectedTitle: '审批 · 已拒绝',
      expectedTemplate: 'grey',
      expectedStatus: '原端已确认答复',
    },
    {
      label: 'resolved on terminal',
      interaction: { ...baseRequest, status: 'resolved', nativeResult: null },
      expectedTitle: '审批 · 已处理',
      expectedTemplate: 'grey',
      expectedStatus: '已在原终端完成处理',
    },
    {
      label: 'expired',
      interaction: { ...baseRequest, status: 'expired' },
      expectedTitle: '审批 · 已过期',
      expectedTemplate: 'grey',
      expectedStatus: '原请求已过期或失效',
    },
    {
      label: 'cancelled',
      interaction: { ...baseRequest, status: 'cancelled' },
      expectedTitle: '审批 · 已取消',
      expectedTemplate: 'grey',
      expectedStatus: '原请求已取消',
    },
    {
      label: 'pending delivery',
      interaction: { ...baseRequest, status: 'answer_pending_delivery' },
      expectedTitle: '审批 · 等待原端确认',
      expectedTemplate: 'orange',
      expectedStatus: '答复已提交，等待原端确认',
    },
  ];

  for (const c of finishedCases) {
    const card = interactionCard(c.interaction, false);
    assert.equal(card.title, c.expectedTitle, c.label);
    assert.equal(card.template, c.expectedTemplate, c.label);
    assert.deepEqual(card.actions, [], c.label);
    assert.ok(!card.text.includes('\n'), `${c.label} should be single-line, got: ${card.text}`);
    assert.ok(!card.text.includes('```'), `${c.label} should not contain code fences`);
    assert.ok(!card.text.includes('**操作内容**'), `${c.label} should not repeat 操作内容`);
    assert.ok(!card.text.includes('**拦截原因**'), `${c.label} should not repeat 拦截原因`);
    assert.ok(card.text.includes('执行命令'), c.label);
    assert.ok(card.text.includes('python3 scripts/train.py --epochs 100'), c.label);
    assert.ok(card.text.includes(c.expectedStatus), c.label);
  }
});

test('PendingHub never duplicates FeishuChannel approval cards even when hub.sync races ahead, and hub approval syncs back to source topic including PATCH retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-ux-sync-'));
  const fake = makeFakePort({ failFirstUpdateForDestination: 'topic:agy-1' });
  const agy = makeFakeAgyPort('host-1', 'svc-agy', dir);
  const config: RuntimeConfig = {
    coreDb: join(dir, 'core.sqlite'),
    channelDb: join(dir, 'channel.sqlite'),
    artifactStatePath: join(dir, 'artifacts.json'),
    ownerOpenId: OWNER_ID,
    allowedDestinations: ['chat-main'],
    hostId: 'host-1',
    claudeServiceId: 'svc-claude',
    codexServiceId: 'svc-codex',
    claudeStateDir: dir,
    codexEndpoint: 'codex-proxy://default',
    intervalMs: 60_000,
    agy: { enabled: true, serviceId: 'svc-agy' },
    pendingHub: { enabled: true, destination: 'chat-main' },
  };
  const runtime = new UnifiedRuntime(config, fake.port, [agy.port]);
  try {
    runtime.store.insertSession(agy.session);
    const session = runtime.store.findSession(agy.nativeRef)!;
    await runtime.channel.handle(
      { eventId: 'bind-agy-1', destination: 'topic:agy-1', identity: OWNER },
      { action: 'bind', sessionId: session.sessionId, mode: 'interactive' },
    );

    const connGen = runtime.store.connectionGeneration(session.sessionId);
    const approvalDigest = payloadDigest({ ToolName: 'codex_job', action: 'wait' });
    const approval: Interaction = {
      interactionId: 'int-agy-race-1',
      sessionId: session.sessionId,
      turnId: 'turn-1',
      nativeRequestId: 'nr-race-1',
      connectionGeneration: connGen ?? 1,
      revision: 1,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: approvalDigest,
      nativeResult: null,
      kind: 'approval',
      tool: 'MCP Tool codex_job',
      action: JSON.stringify({
        name: 'call_mcp_tool',
        args: { ServerName: 'codex-bridge_codex', ToolName: 'codex_job', Arguments: { action: 'wait', job_id: 'j1' } },
      }),
      scope: 'this_request',
    };

    // Insert interaction directly into store and run PendingHub.sync() BEFORE FeishuChannel.sync()
    // to reproduce the exact race condition where PendingHub discovers the interaction first.
    agy.interactions.push({ ...approval, sessionId: agy.nativeRef.nativeSessionId });
    runtime.store.insertInteraction(approval);
    runtime.pendingHub!.bindSourceSession(session.sessionId, 'topic:agy-1');
    await runtime.pendingHub!.sync();

    // PendingHub MUST NOT send a pending-src card into the FeishuChannel-managed topic.
    const sourceCardsAfterHubSync = fake.sent.filter(
      (s) => s.destination === 'topic:agy-1' && s.card.title.includes('需人工确认'),
    );
    assert.equal(sourceCardsAfterHubSync.length, 0, 'PendingHub must not send duplicate pending-src card');
    assert.ok(runtime.pendingHub!.getRef('interaction:int-agy-race-1')?.hub_card_message_id);

    // Now run normal tick(): FeishuChannel delivers its single approval card and PendingHub tracks it.
    await runtime.tick();
    const sourceCardsAfterTick = fake.sent.filter(
      (s) => s.destination === 'topic:agy-1' && s.card.title.includes('需人工确认'),
    );
    assert.equal(sourceCardsAfterTick.length, 1, 'Source topic should have exactly 1 approval card');
    assert.doesNotMatch(sourceCardsAfterTick[0]!.card.text, /原端未提供可展示的操作详情/);
    assert.ok(sourceCardsAfterTick[0]!.card.text.includes('codex-bridge_codex / codex_job'));

    const pendingRoot = runtime.pendingHub!.getRoot()!;
    const intRef = runtime.pendingHub!.getRef('interaction:int-agy-race-1')!;
    assert.equal(intRef.source_card_message_id, sourceCardsAfterTick[0]!.messageId);

    // Approve inside「待处理」(PendingHub). Note: the first PATCH to topic:agy-1 throws a transient error!
    await runtime.handleTrusted(
      {
        eventId: 'hub-approve-1',
        destination: pendingRoot.topicDestination!,
        identity: OWNER,
        cardMessageId: intRef.hub_card_message_id!,
      },
      {
        action: 'answer',
        entry: 'hub',
        sourceSessionId: session.sessionId,
        interactionId: 'int-agy-race-1',
        revision: 1,
        connectionGeneration: connGen ?? 1,
        answer: { kind: 'approval', decision: 'allow', scope: 'this_request' },
        toolInputDigest: approvalDigest,
      } as never,
    );
    await runtime.flushInteractive().catch(() => {});
    // Native AGY confirms the approval with responseEvidence
    const answered = agy.responds[0]!;
    agy.emit({
      type: 'interaction',
      ref: agy.nativeRef,
      responseEvidence: {
        operationId: answered.operationId!,
        interactionId: approval.interactionId,
        nativeRequestId: approval.nativeRequestId,
        connectionGeneration: approval.connectionGeneration,
        answerDigest: payloadDigest(answered.answer),
      },
      interaction: {
        ...approval,
        sessionId: agy.nativeRef.nativeSessionId,
        status: 'resolved',
        revision: 3,
        nativeResult: {
          status: 'accepted',
          source: 'agy',
          answer: answered.answer,
        },
      },
    });
    await new Promise((r) => setImmediate(r));
    await runtime.flushInteractive().catch(() => {});
    // Next tick reconciles the source card after the transient PATCH failure (idempotent PATCH retry!)
    await runtime.tick();
    const resolvedInteraction = await runtime.core.getInteraction('int-agy-race-1');
    assert.equal(resolvedInteraction.status, 'resolved', `interaction status=${resolvedInteraction.status}`);

    assert.equal(agy.responds.length, 1);
    const sourceUpdates = fake.updated.filter((u) => u.messageId === sourceCardsAfterTick[0]!.messageId);
    const hubUpdates = fake.updated.filter((u) => u.messageId === intRef.hub_card_message_id);
    assert.ok(sourceUpdates.length >= 1, 'Source topic card must be updated after hub approval');
    assert.ok(hubUpdates.length >= 1, 'Hub card must be updated after hub approval');

    const finalSourceCard = sourceUpdates.at(-1)!.card;
    const finalHubCard = hubUpdates.at(-1)!.card;
    for (const card of [finalSourceCard, finalHubCard]) {
      assert.equal(card.title, '审批 · 已确认');
      assert.equal(card.template, 'green');
      assert.deepEqual(card.actions, []);
      assert.ok(!card.text.includes('\n'), `resolved card should be compact single-line: ${card.text}`);
      assert.ok(!card.text.includes('**操作内容**'));
      assert.ok(card.text.includes('MCP · codex_job'));
      assert.ok(card.text.includes('原端已确认答复'));
    }
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
