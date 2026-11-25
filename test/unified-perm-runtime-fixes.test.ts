import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DispatchGuard, PlatformObservation, PlatformPort } from '../src/unified/adapter.js';
import {
  agyAlwaysOption,
  agyOnceOption,
  agyPermissionOptions,
  classifyAgyPermission,
} from '../src/unified/agy/adapter-permission.js';
import type { AgyQuotaSnapshot } from '../src/unified/agy-quota.js';
import { evaluateApproval, resolveApprovalFacts } from '../src/unified/approval-policy.js';
import { formatApprovalAction } from '../src/unified/card-formatters.js';
import { runtimeApprovalScope } from '../src/unified/codex-approval.js';
import type { Capabilities, Interaction, Provider, Session, SubmitInput } from '../src/unified/contracts.js';
import { contractError } from '../src/unified/errors.js';
import { interactionCard, type ChannelCard } from '../src/unified/feishu-cards.js';
import type { FeishuPort } from '../src/unified/feishu-channel.js';
import { UnifiedRuntime, validateRuntimeConfig, type RuntimeConfig } from '../src/unified/runtime.js';
import { UnifiedCore } from '../src/unified/service.js';
import { StoreError, UnifiedStore } from '../src/unified/store.js';

const ALL_CAPS = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map(
    (k) => [k, { status: 'available' as const }],
  ),
) as Capabilities;

const OWNER_ID = 'owner-perm-rt';
const OWNER = { source: 'feishu', subject: OWNER_ID };

function makeRuntimeConfig(dir: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    coreDb: join(dir, 'core.sqlite'),
    channelDb: join(dir, 'channel.sqlite'),
    ownerOpenId: OWNER_ID,
    allowedDestinations: ['chat-main'],
    hostId: 'host-1',
    claudeServiceId: 'claude-svc',
    codexServiceId: 'codex-svc',
    claudeStateDir: join(dir, 'claude-state'),
    codexEndpoint: 'ws://127.0.0.1:18080',
    intervalMs: 1000,
    agy: { enabled: true, serviceId: 'agy-svc' },
    ...overrides,
  };
}

function makeFakePort() {
  let seq = 0;
  const authorized = new Set<string>(['chat-main']);
  const sent: Array<{ destination: string; card: ChannelCard; deliveryId: string; messageId: string }> = [];
  const updated: Array<{ destination: string; messageId: string; card: ChannelCard; deliveryId: string }> = [];
  const deliveries = new Map<string, string>();
  const port: FeishuPort & { authorizedDestination: (d: string) => boolean } = {
    authorizedDestination: (d) => authorized.has(d),
    isTopicDestination: (d) => d.startsWith('topic:'),
    createTopic: async (_dest, sessionId, _card, deliveryId, guard) => {
      await guard?.();
      const topicDest = `topic:${sessionId}-${++seq}`;
      authorized.add(topicDest);
      deliveries.set(deliveryId, `root-${seq}`);
      return topicDest;
    },
    send: async (destination, card, deliveryId, guard) => {
      await guard?.();
      const messageId = `msg-${++seq}`;
      sent.push({ destination, card, deliveryId, messageId });
      deliveries.set(deliveryId, messageId);
      return messageId;
    },
    update: async (destination, messageId, card, deliveryId, guard) => {
      await guard?.();
      updated.push({ destination, messageId, card, deliveryId });
      deliveries.set(deliveryId, messageId);
    },
    sendFile: async (_dest, _name, _content, deliveryId, guard) => {
      await guard?.();
      deliveries.set(deliveryId, `file-${++seq}`);
    },
    lookupDelivery: async (deliveryId) => (deliveries.has(deliveryId) ? 'sent' : 'unknown'),
    lookupMessageId: async (deliveryId) => deliveries.get(deliveryId) ?? null,
    topicLinkForSession: async (_dest, sessionId) => `https://applink.feishu.cn/thread/${sessionId}`,
  };
  return { port, sent, updated, authorized };
}

test('service: pre-write busy error converges to failed (never unknown) and updateSettings is deduplicated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-rt-service-'));
  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  const ref = { provider: 'agy' as const, hostId: 'h', serviceId: 's', nativeSessionId: 'agy-1' };
  const session: Session = {
    sessionId: 'sess-1',
    native: ref,
    title: 'agy',
    project: dir,
    status: 'idle',
    revision: 0,
    capabilities: ALL_CAPS,
    control: { serviceId: 's', owner: 'o', input: 'available', generation: 1, operationId: null, reason: null },
  };
  let busy = true;
  let updateSettingsCalls = 0;
  let inputCalls = 0;
  let obsListener: ((o: PlatformObservation) => void) | undefined;
  const port = {
    provider: 'agy' as const,
    onObservation: (fn: (o: PlatformObservation) => void) => {
      obsListener = fn;
      return () => {};
    },
    updateSettings: async (_r: unknown, _s: unknown, guard: DispatchGuard) => {
      guard.assertCurrent();
      updateSettingsCalls++;
      return { status: 'submitted' as const, nativeReference: null, settingsApplied: true };
    },
    input: async (_r: unknown, _m: unknown, _b: unknown, guard: DispatchGuard) => {
      if (busy) throw contractError('busy', 'turn already running');
      guard.assertCurrent();
      inputCalls++;
      return { status: 'submitted' as const, nativeReference: `turn-${inputCalls}` };
    },
  } as unknown as PlatformPort;

  store.insertSession(session);
  store.setConnectionGeneration('sess-1', 0, 1);
  const core = new UnifiedCore(store, [port], () => true);
  const ctx = (id: string) => ({
    operationId: id,
    idempotencyKey: id,
    targetId: 'sess-1',
    expectedRevision: 0,
    controlGeneration: 1,
    identity: OWNER,
  });

  try {
    // 1. Pre-write busy on mode='new' must fail cleanly, never markDeliveryUnknown.
    const busyReq: SubmitInput = { context: ctx('op-busy'), mode: 'new', blocks: [{ type: 'text', text: 'hi' }] };
    await core.submitInput(busyReq);
    const busyOp = await core.dispatch('op-busy');
    assert.equal(busyOp.status, 'failed');
    assert.equal(busyOp.error?.code, 'busy');
    assert.equal(store.getOutbox('op-busy').state, 'done');

    // 2. Confirm settings once -> subsequent submitInputs on same generation skip redundant updateSettings.
    busy = false;
    await core.updateSessionSettings({
      context: ctx('op-set-1'),
      payload: { model: 'gemini-4-carbon', preferences: { reasoningEffort: 'medium' } },
    });
    const setOp = await core.dispatch('op-set-1');
    assert.equal(setOp.status, 'completed');
    assert.equal(updateSettingsCalls, 1);

    for (const id of ['op-in-1', 'op-in-2', 'op-in-3']) {
      await core.submitInput({ context: ctx(id), mode: 'new', blocks: [{ type: 'text', text: id }] });
      const res = await core.dispatch(id);
      assert.equal(res.status, 'accepted');
    }
    assert.equal(inputCalls, 3);
    assert.equal(updateSettingsCalls, 1, 'no redundant updateSettings RPCs across turns');

    // 3. Connection generation advances -> next submitInput re-syncs settings once, then skips again.
    await core.observe({ type: 'connection', ref, connectionGeneration: 2 });
    assert.ok(obsListener !== undefined);
    await core.submitInput({ context: ctx('op-in-4'), mode: 'new', blocks: [{ type: 'text', text: 'after-reconn' }] });
    assert.equal((await core.dispatch('op-in-4')).status, 'accepted');
    assert.equal(updateSettingsCalls, 2);
    await core.submitInput({ context: ctx('op-in-5'), mode: 'new', blocks: [{ type: 'text', text: 'after-reconn-2' }] });
    assert.equal((await core.dispatch('op-in-5')).status, 'accepted');
    assert.equal(updateSettingsCalls, 2);
  } finally {
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approval policy: homeDir in allowedProjectRoots is not a cross-project read whitelist and hard blocks hold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-rt-home-'));
  const fakeHome = join(dir, 'home');
  const projectA = join(fakeHome, 'workspace', 'proj-a');
  const projectB = join(fakeHome, 'workspace', 'proj-b');
  const reviewsDir = join(fakeHome, 'reviews');
  const projtoolDir = join(fakeHome, 'projects', 'projtool');
  const claudeDir = join(projectA, '.claude');
  const extraWrite = join(dir, 'scratch');

  try {
    for (const p of [projectA, projectB, reviewsDir, projtoolDir, claudeDir, extraWrite]) {
      mkdirSync(p, { recursive: true });
    }
    writeFileSync(join(projectA, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(projectB, 'b.ts'), 'export const b = 2;\n');
    writeFileSync(join(reviewsDir, 'blind.pdf'), 'secret');
    writeFileSync(join(projtoolDir, 'tool.py'), 'print(1)\n');
    writeFileSync(join(claudeDir, 'settings.json'), '{}');

    const cfg = makeRuntimeConfig(dir, {
      allowedProjectRoots: [fakeHome],
      outputRoots: [],
      approvalPolicy: { enabled: true, homeDir: fakeHome, extraWriteRoots: [extraWrite] },
    });
    const scope = runtimeApprovalScope(cfg);
    assert.ok(!scope.readRoots.includes(fakeHome), 'homeDir must not be blindly added to readRoots');

    // Reading inside current projectA is allowed.
    const inProjRead = evaluateApproval(
      await resolveApprovalFacts({ kind: 'read', paths: [join(projectA, 'a.ts')] }, { ...scope, project: projectA }),
    );
    assert.equal(inProjRead.kind, 'allow_once');

    // Reading sibling projectB is NOT auto-allowed when allowedProjectRoots was homeDir.
    const crossProjRead = evaluateApproval(
      await resolveApprovalFacts({ kind: 'read', paths: [join(projectB, 'b.ts')] }, { ...scope, project: projectA }),
    );
    assert.equal(crossProjRead.kind, 'ask');

    // Reading reviews/ is NOT auto-allowed even if allowedRoots directly passed fakeHome.
    const reviewsRead = evaluateApproval(
      await resolveApprovalFacts(
        { kind: 'read', paths: [join(reviewsDir, 'blind.pdf')] },
        { allowedRoots: [fakeHome], homeDir: fakeHome, project: projectA },
      ),
    );
    assert.equal(reviewsRead.kind, 'ask');

    // Writing to projtool or .claude/settings.json stays hard-denied.
    const projtoolWrite = evaluateApproval(
      await resolveApprovalFacts({ kind: 'write', paths: [join(projtoolDir, 'tool.py')] }, { ...scope, project: projectA }),
    );
    assert.equal(projtoolWrite.kind, 'deny');

    const claudeWrite = evaluateApproval(
      await resolveApprovalFacts({ kind: 'write', paths: [join(claudeDir, 'settings.json')] }, { ...scope, project: projectA }),
    );
    assert.equal(claudeWrite.kind, 'deny');

    // Writing to explicit extraWriteRoots is allowed.
    const scratchWrite = evaluateApproval(
      await resolveApprovalFacts({ kind: 'write', paths: [join(extraWrite, 'out.txt')] }, { ...scope, project: projectA }),
    );
    assert.equal(scratchWrite.kind, 'allow_once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter-permission: ArtifactMetadata, read-only MCP/search_web, brain/<sessionId>, allow_always & allow fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-rt-agy-'));
  const project = join(dir, 'repo');
  const brainDir = join(dir, 'brain');
  const sessionBrain = join(brainDir, 'sess-abc-123');
  const otherBrain = join(brainDir, 'sess-other');
  const extraWrite = join(dir, 'outputs');

  try {
    for (const p of [project, sessionBrain, otherBrain, extraWrite]) mkdirSync(p, { recursive: true });
    const scope = { enabled: true, brainDir, writeRoots: [extraWrite] };

    // 1. ArtifactMetadata on write_file inside brain/<sessionId> -> allow_once.
    const artifactWrite = {
      name: 'write_file',
      rawInput: {
        Path: join(sessionBrain, 'plan.md'),
        Content: '# Plan',
        Overwrite: true,
        ArtifactMetadata: { Summary: 'Plan summary', UserFacing: true, RequestFeedback: false },
      },
    };
    assert.equal((await classifyAgyPermission(artifactWrite, project, scope, 'sess-abc-123')).kind, 'allow_once');

    // Writing to another session's brain directory -> ask.
    const otherBrainWrite = {
      ...artifactWrite,
      rawInput: { ...artifactWrite.rawInput, Path: join(otherBrain, 'plan.md') },
    };
    assert.equal((await classifyAgyPermission(otherBrainWrite, project, scope, 'sess-abc-123')).kind, 'ask');

    // Writing to extraWriteRoots -> allow_once.
    const extraWriteCall = {
      name: 'write_file',
      rawInput: { Path: join(extraWrite, 'result.json'), Content: '{}', Overwrite: true },
    };
    assert.equal((await classifyAgyPermission(extraWriteCall, project, scope, 'sess-abc-123')).kind, 'allow_once');

    // 2. Read-only MCP tools & search_web auto-allow (and respect enabled: false).
    for (const tool of [
      { name: 'search_web', rawInput: { query: 'test' } },
      { name: 'list_resources', rawInput: { ServerName: 'codex' } },
      { name: 'read_resource', rawInput: { ServerName: 'codex', Uri: 'codex://x' } },
      { name: 'codex_lookup', rawInput: { prompt: 'check' } },
      { name: 'mcp__codex-bridge__codex_status', rawInput: {} },
      { name: 'call_mcp_tool', rawInput: { ToolName: 'codex_job', jobId: '123' } },
    ]) {
      assert.equal((await classifyAgyPermission(tool, project, scope)).kind, 'allow_once', JSON.stringify(tool));
      assert.equal((await classifyAgyPermission(tool, project, { enabled: false })).kind, 'ask', JSON.stringify(tool));
    }

    // Mutating MCP tool stays ask.
    assert.equal(
      (await classifyAgyPermission({ name: 'call_mcp_tool', rawInput: { ToolName: 'codex_engineer' } }, project, scope)).kind,
      'ask',
    );

    // 3. Option extraction: allow_always + safe fallback when provider only offers `allow`.
    const onlyAllowOpts = [
      { kind: 'allow', optionId: 'opt-allow' },
      { kind: 'reject', optionId: 'opt-reject' },
    ];
    assert.equal(agyOnceOption(onlyAllowOpts, 'allow_once'), 'opt-allow');
    assert.equal(agyOnceOption(onlyAllowOpts, 'reject_once'), 'opt-reject');

    const fullOpts = [
      { kind: 'allow_once', optionId: 'once' },
      { kind: 'allow_always', optionId: 'always' },
      { kind: 'reject_once', optionId: 'deny' },
    ];
    assert.deepEqual(agyPermissionOptions(fullOpts), {
      allowOnce: 'once',
      allowAlways: 'always',
      rejectOnce: 'deny',
      rejectAlways: null,
    });
    assert.equal(agyAlwaysOption(fullOpts, 'allow_always'), 'always');
    // Never mistake allow_always for allow_once.
    assert.equal(agyOnceOption([{ kind: 'allow_always', optionId: 'allow_always' }], 'allow_once'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cards & formatters: session allow button and expanded >400 char command/path display', () => {
  const longCmd = `python3 scripts/run_eval.py --config ${'a'.repeat(500)}/exp.yaml --seed 42`;
  const formatted = formatApprovalAction('run_command', JSON.stringify({ CommandLine: longCmd, Cwd: '/work/proj' }), 'this_request');
  assert.ok(formatted.text.includes('--seed 42'), 'command over 400 chars should not be prematurely truncated');
  assert.ok(formatted.text.includes('/work/proj'), 'working directory should be displayed');

  const baseApproval: Interaction = {
    interactionId: 'int-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    nativeRequestId: 'rpc-1',
    connectionGeneration: 1,
    revision: 1,
    status: 'awaiting_answer',
    expiresAt: null,
    toolInputDigest: 'digest-1',
    nativeResult: null,
    kind: 'approval',
    tool: 'run_command',
    action: JSON.stringify({ CommandLine: longCmd }),
    scope: 'this_request',
  };
  const cardWithAlways = interactionCard({ ...baseApproval, allowAlways: true });
  assert.deepEqual(
    cardWithAlways.actions.map((a) => a.label),
    ['允许本次', '本会话允许', '拒绝'],
  );
  const sessionBtn = cardWithAlways.actions.find((a) => a.label === '本会话允许')!;
  assert.deepEqual((sessionBtn.value as { answer: unknown }).answer, {
    kind: 'approval',
    decision: 'allow',
    scope: 'session',
  });
});

test('store: streaming chunk updates avoid O(N^2) event growth and compactEvents preserves idempotency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-rt-store-'));
  const dbPath = join(dir, 'core.sqlite');
  const store = new UnifiedStore(dbPath);
  const ref = { provider: 'agy' as const, hostId: 'h', serviceId: 's', nativeSessionId: 'n1' };
  const session: Session = {
    sessionId: 's1',
    native: ref,
    project: dir,
    title: 'stream',
    status: 'running',
    revision: 0,
    capabilities: ALL_CAPS,
    control: { serviceId: 's', owner: 'o', input: 'available', generation: 1, operationId: null, reason: null },
  };

  try {
    store.insertSession(session);
    const startCursor = store.initialCursor('s1');
    const chunk = 'x'.repeat(1024);
    for (let i = 1; i <= 40; i++) {
      store.putMessage(
        {
          messageId: 'm-stream',
          sessionId: 's1',
          turnId: 't1',
          role: 'assistant',
          blocks: [{ type: 'text', text: chunk.repeat(i) }],
          sequence: 1,
          revision: i,
          final: i === 40,
          source: 'agy',
        },
        i === 1 ? null : i - 1,
      );
    }

    const rawDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const eventRows = rawDb.prepare("SELECT length(value) AS len FROM events WHERE session_id='s1'").all() as Array<{ len: number }>;
      const keyRows = rawDb.prepare("SELECT length(value) AS len FROM event_keys").all() as Array<{ len: number }>;
      // Only 1 event row (final) remains instead of 40 cumulative copies.
      assert.equal(eventRows.length, 1);
      assert.equal(keyRows.length, 1);
    } finally {
      rawDb.close();
    }

    const sub = store.subscribeEvents('s1', startCursor, 100);
    assert.equal(sub.status, 'events');
    if (sub.status === 'events') {
      assert.equal(sub.events.length, 1);
      assert.equal((sub.events[0]!.data as { final: boolean }).final, true);
    }

    // Explicit appendEvent + compactEvents preserves replay idempotency and conflict detection.
    const explicitInput = {
      eventId: 'evt-explicit-1',
      sessionId: 's1',
      objectId: 's1',
      objectRevision: 1,
      type: 'custom.ping',
      occurredAt: '2026-01-01T00:00:00Z',
      receivedAt: '2026-01-01T00:00:00Z',
      operationId: null,
      data: { ok: true },
    };
    const appended = store.appendEvent(explicitInput);
    store.compactEvents('s1', appended.cursor);
    assert.equal(store.eventFloor('s1'), appended.sequence);
    assert.deepEqual(store.appendEvent(explicitInput), appended);
    assert.throws(
      () => store.appendEvent({ ...explicitInput, data: { ok: false } }),
      (err: unknown) => err instanceof StoreError && err.detail.code === 'idempotency_conflict',
    );
    assert.equal(store.subscribeEvents('s1', startCursor, 10).status, 'snapshot_required');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime: disconnect/reconnect restores channel + taskTopic targets, wires WatchHub alerts, and validates new AgyRuntimeConfig', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-rt-reconn-'));
  const cfg = makeRuntimeConfig(dir, {
    watchHub: { enabled: true, destination: 'chat-main' },
    taskTopic: { enabled: true },
    agy: {
      enabled: true,
      serviceId: 'agy-svc',
      processPerSession: true,
      defaultMode: 'accept-edits',
      addDirs: [dir],
      extraArgs: ['--verbose'],
      defaultModel: 'gemini-4-carbon',
      extraWriteRoots: [dir],
    },
  });
  assert.doesNotThrow(() => validateRuntimeConfig(cfg));
  assert.throws(() => validateRuntimeConfig({ ...cfg, agy: { ...cfg.agy!, defaultMode: 'invalid' as 'auto' } }));

  const fake = makeFakePort();
  let connGen = 1;
  let resumeCalls: string[] = [];
  let obsListener: ((o: PlatformObservation) => void) | undefined;
  const nativeSessions = new Map<string, Session>();
  const makeSession = (nativeId: string, gen: number): Session => ({
    sessionId: `native-${nativeId}`,
    native: { provider: 'agy', hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId: nativeId },
    title: `AGY ${nativeId}`,
    project: dir,
    status: 'idle',
    revision: 0,
    capabilities: ALL_CAPS,
    control: { serviceId: 'agy-svc', owner: 'feishu', input: 'available', generation: gen, operationId: null, reason: null },
  });
  let controlGen = 1;
  nativeSessions.set('chan-1', makeSession('chan-1', controlGen));
  nativeSessions.set('task-1', makeSession('task-1', controlGen));
  const extraMessages = new Map<string, Array<{ id: string; text: string }>>();

  const agyPort: PlatformPort = {
    provider: 'agy',
    seedConnectionGeneration: () => {},
    seedControlGeneration: (_ref, min) => {
      controlGen = Math.max(controlGen, min);
    },
    list: async () => ({ items: [...nativeSessions.values()], nextCursor: null }),
    read: async (ref) => {
      const s = nativeSessions.get(ref.nativeSessionId)!;
      const msgs = (extraMessages.get(ref.nativeSessionId) ?? []).map((m, idx) => ({
        messageId: m.id,
        sessionId: ref.nativeSessionId,
        turnId: `term-turn-${idx}`,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: m.text }],
        sequence: idx + 1,
        revision: 1,
        final: true,
        source: 'agy',
      }));
      return { session: s, messages: msgs, interactions: [], turns: [], connectionGeneration: connGen };
    },
    resume: async (ref) => {
      resumeCalls.push(ref.nativeSessionId);
      controlGen++;
      nativeSessions.set(ref.nativeSessionId, makeSession(ref.nativeSessionId, controlGen));
      return { status: 'submitted', nativeReference: ref.nativeSessionId, connectionGeneration: connGen };
    },
    create: async () => ({ status: 'submitted', nativeReference: 'new', connectionGeneration: connGen }),
    input: async (_r, _m, _b, guard) => {
      guard.assertCurrent();
      return { status: 'submitted', nativeReference: 't-1' };
    },
    interrupt: async (_r, turnId, guard) => {
      guard.assertCurrent();
      return { status: 'submitted', nativeReference: turnId };
    },
    respond: async (_r, i, _a, guard) => {
      guard.assertCurrent();
      return { status: 'submitted', nativeReference: i.nativeRequestId };
    },
    onObservation: (fn) => {
      obsListener = fn;
      return () => {};
    },
    listArtifacts: async () => [],
    readArtifact: async () => new Uint8Array(),
    listModels: async () => [],
    updateSettings: async (_r, _s, guard) => {
      guard.assertCurrent();
      return { status: 'submitted', nativeReference: null, settingsApplied: true };
    },
    control: async (_r, _a, guard) => {
      guard.assertCurrent();
      return { status: 'submitted', nativeReference: null };
    },
  };

  const runtime = new UnifiedRuntime(cfg, fake.port, [agyPort]);
  try {
    // Attach regular channel session & taskTopic independent session.
    const a1 = await runtime.core.attachSession({
      context: { operationId: 'att-1', idempotencyKey: 'att-1', targetId: 'chan-1', expectedRevision: 0, controlGeneration: 0, identity: OWNER },
      payload: { provider: 'agy', hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId: 'chan-1', mode: 'interactive' },
    });
    const chanSid = (a1.result as { sessionId: string }).sessionId;
    await runtime.channel.handle(
      { eventId: 'bind-1', destination: 'chat-main', identity: OWNER },
      { action: 'bind', sessionId: chanSid, mode: 'interactive' },
    );
    await runtime.tick();

    const a2 = await runtime.core.attachSession({
      context: { operationId: 'att-2', idempotencyKey: 'att-2', targetId: 'task-1', expectedRevision: 0, controlGeneration: 0, identity: OWNER },
      payload: { provider: 'agy', hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId: 'task-1', mode: 'interactive' },
    });
    const taskSid = (a2.result as { sessionId: string }).sessionId;
    fake.authorized.add('topic:task-independent');
    runtime.taskChannel!.registerTask({
      taskId: 'task-ind-1',
      destination: 'topic:task-independent',
      rootGeneration: 1,
      owner: OWNER,
    });
    await runtime.taskChannel!.mountTarget({
      taskId: 'task-ind-1',
      targetId: 'tgt-agy-1',
      sessionId: taskSid,
      native: { provider: 'agy', hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId: 'task-1' },
      accessMode: 'interactive',
      owner: OWNER,
      makeActive: true,
    });

    // Idle interactive session can incrementally pick up new terminal messages.
    extraMessages.set('chan-1', [{ id: 'term-msg-1', text: 'terminal reply' }]);
    const caughtUp = await runtime.core.refreshIdleInteractiveSession(chanSid);
    assert.equal(caughtUp, true);
    assert.ok((await runtime.core.getSnapshot(chanSid)).value.messages.some((m) => m.messageId === 'term-msg-1'));

    // Runtime disconnect -> reconnect restores BOTH regular channel and taskTopic targets + emits WatchHub events.
    resumeCalls = [];
    runtime.setProviderReady('agy', false);
    connGen = 2;
    runtime.setProviderReady('agy', true);
    const report = await runtime.restoreProviderAfterReconnect('agy');
    assert.deepEqual(report.failed, []);
    assert.ok(report.restored.includes(chanSid), 'regular channel session restored');
    assert.ok(report.restored.includes(taskSid), 'taskTopic independent target restored');
    assert.ok(resumeCalls.includes('chan-1') && resumeCalls.includes('task-1'));

    // Turn timeout & low quota threshold alerts wire into WatchHub.
    await runtime.core.observe({
      type: 'event',
      ref: { provider: 'agy', hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId: 'chan-1' },
      connectionGeneration: connGen,
      event: {
        schemaVersion: 1,
        eventId: 'evt-timeout-1',
        sessionId: 'chan-1',
        objectId: 'turn-99',
        objectRevision: 1,
        sequence: 1,
        type: 'turn.timeout',
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        operationId: null,
        cursor: 'c1',
        data: { reason: 'prompt timeout' },
      },
    });
    const lowQuota: AgyQuotaSnapshot = {
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
        name: '5h',
        limitId: 'l1',
        windowMinutes: 300,
        windowType: 'short',
        usedPercent: 92,
        remainingPercent: 8,
        remainingAmount: null,
        disabled: false,
        resetsAt: '2026-11-25T20:00:00Z',
        snapshotAt: new Date().toISOString(),
        ageSeconds: 0,
        stale: false,
      },
      weekly: null,
      windows: [],
      lastSnapshotAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      ageSeconds: 0,
      error: null,
      health: {
        component: 'agy_quota',
        status: 'healthy',
        reason: null,
        updatedAt: null,
        lastObservedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureReason: null,
        backlog: null,
        unknown: null,
        lastDeliveryAt: null,
      },
    };
    runtime.reportQuotaSnapshot('agy', lowQuota, 15);
    await runtime.tick();

    const outbox = runtime.watchHub!.listOutbox();
    assert.ok(outbox.some((r) => r.objectId === 'provider:agy:connection'), 'ACP disconnect/reconnect in WatchHub');
    assert.ok(outbox.some((r) => r.objectId.startsWith('turn.timeout:')), 'turn timeout in WatchHub');
    assert.ok(outbox.some((r) => r.objectId === 'provider:agy:quota'), 'low quota alert in WatchHub');
    assert.ok(obsListener !== undefined);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
