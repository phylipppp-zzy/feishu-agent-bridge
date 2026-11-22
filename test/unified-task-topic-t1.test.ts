import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedCore } from '../src/unified/service.js';
import { FeishuChannel, type FeishuPort, type TrustedEnvelope } from '../src/unified/feishu-channel.js';
import { FeishuSdkPort } from '../src/unified/feishu-sdk-port.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import type { PlatformPort, PlatformObservation } from '../src/unified/adapter.js';
import type {
  Capabilities,
  Interaction,
  Message,
  NativeSessionRef,
  Provider,
  Session,
} from '../src/unified/contracts.js';
import { TaskTopicChannel, TaskChannelError } from '../src/unified/task-topic-channel.js';
import { TaskHandoffService } from '../src/unified/task-handoff.js';

const ALL_CAPS = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map(
    (k) => [k, { status: 'available' as const }],
  ),
) as Capabilities;

const OWNER = { source: 'feishu', subject: 'owner-1' };

function makeSession(
  provider: Provider,
  nativeSessionId: string,
  project: string,
  readOnly = false,
): Session {
  const native: NativeSessionRef = {
    provider,
    hostId: 'host-1',
    serviceId: `svc-${provider}`,
    nativeSessionId,
  };
  return {
    sessionId: `sess-${provider}-${nativeSessionId}`,
    native,
    project,
    title: `${provider} session`,
    status: readOnly ? 'read_only' : 'idle',
    revision: 0,
    capabilities: readOnly
      ? (Object.fromEntries(
          Object.entries(ALL_CAPS).map(([k, v]) => [
            k,
            k === 'view' ? v : { status: 'unsupported' as const, reason: 'read-only' },
          ]),
        ) as Capabilities)
      : ALL_CAPS,
    control: {
      serviceId: `svc-${provider}`,
      owner: 'owner-1',
      input: readOnly ? 'unavailable' : 'available',
      generation: 1,
      operationId: null,
      reason: null,
    },
  };
}

function makeFakeProviderPort(provider: Provider) {
  const listeners = new Set<(o: PlatformObservation) => void>();
  const inputs: Array<{ ref: NativeSessionRef; mode: string; text: string }> = [];
  const responds: Array<{ ref: NativeSessionRef; interactionId: string; answer: unknown }> = [];
  let turnCounter = 0;

  const port: PlatformPort = {
    provider,
    list: async () => ({ items: [], nextCursor: null }),
    read: async (ref) => {
      throw new Error(`unused read for ${ref.nativeSessionId}`);
    },
    resume: async (ref) => ({
      status: 'submitted',
      nativeReference: ref.nativeSessionId,
      connectionGeneration: 0,
    }),
    create: async () => ({ status: 'submitted', nativeReference: 'new', connectionGeneration: 0 }),
    input: async (ref, mode, blocks, guard) => {
      guard.assertCurrent();
      const text = blocks.map((b) => (b.type === 'text' ? b.text : `[file:${b.name}]`)).join('\n');
      inputs.push({ ref, mode, text });
      return { status: 'submitted', nativeReference: `turn-${provider}-${++turnCounter}` };
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
    onObservation: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
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

  return {
    port,
    inputs,
    responds,
    emit: (o: PlatformObservation) => {
      for (const fn of listeners) fn(o);
    },
  };
}

function makeFakeFeishuPort() {
  const sent: Array<{ destination: string; messageId: string; card: ChannelCard; deliveryId: string }> = [];
  const updated: Array<{ destination: string; messageId: string; card: ChannelCard; deliveryId: string }> = [];
  let seq = 0;

  const port: FeishuPort = {
    send: async (destination, card, deliveryId, guard) => {
      await guard?.();
      const messageId = `msg-${++seq}`;
      sent.push({ destination, messageId, card, deliveryId });
      return messageId;
    },
    update: async (destination, messageId, card, deliveryId, guard) => {
      await guard?.();
      updated.push({ destination, messageId, card, deliveryId });
    },
    sendFile: async (_d, _n, _c, _id, guard) => {
      await guard?.();
    },
    lookupDelivery: async (deliveryId) =>
      sent.some((x) => x.deliveryId === deliveryId) || updated.some((x) => x.deliveryId === deliveryId)
        ? 'sent'
        : 'unknown',
    lookupMessageId: async (deliveryId) =>
      sent.find((x) => x.deliveryId === deliveryId)?.messageId ?? null,
  };

  return { port, sent, updated };
}

test('T1: mounts claude + codex + agy concurrently in co-located channel.sqlite with isolated same-turnId stream cards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't1-three-providers-'));
  const coreDbPath = join(dir, 'core.sqlite');
  const channelDbPath = join(dir, 'channel.sqlite');

  const store = new UnifiedStore(coreDbPath);
  const claude = makeFakeProviderPort('claude');
  const codex = makeFakeProviderPort('codex');
  const agy = makeFakeProviderPort('agy');

  const sClaude = makeSession('claude', 'n-claude', '/work/repo');
  const sCodex = makeSession('codex', 'n-codex', '/work/repo');
  const sAgy = makeSession('agy', 'n-agy', '/work/repo');
  for (const s of [sClaude, sCodex, sAgy]) {
    store.insertSession(s);
  }

  let allowAuth = true;
  const core = new UnifiedCore(
    store,
    [claude.port, codex.port, agy.port],
    (id) => allowAuth && id.source === 'feishu' && id.subject === 'owner-1',
  );
  const feishu = makeFakeFeishuPort();

  // Co-locate with legacy FeishuChannel in the exact same channel.sqlite
  const legacyChannel = new FeishuChannel(
    core,
    feishu.port,
    async (id) => allowAuth && id.subject === 'owner-1',
    channelDbPath,
  );
  const taskChannel = new TaskTopicChannel(
    core,
    feishu.port,
    async (id) => allowAuth && id.subject === 'owner-1',
    channelDbPath,
    { streamThrottleMs: 0 },
  );

  try {
    // Legacy channel binding still works unaffected
    await legacyChannel.handle(
      { eventId: 'legacy-bind', destination: 'chat-main', identity: OWNER },
      { action: 'bind', sessionId: sCodex.sessionId },
    );
    assert.deepEqual(legacyChannel.boundDestinations(), ['chat-main']);

    // Register task topic and mount all 3 providers simultaneously
    const binding = taskChannel.registerTask({
      taskId: 'task-multi',
      destination: 'topic:task-multi',
      rootGeneration: 1,
      owner: OWNER,
    });
    assert.equal(binding.taskRevision, 1);
    assert.equal(binding.activeRevision, 1);

    await taskChannel.mountTarget({
      taskId: 'task-multi',
      targetId: 't-claude',
      sessionId: sClaude.sessionId,
      native: sClaude.native,
      accessMode: 'interactive',
      owner: OWNER,
      makeActive: true,
    });
    await taskChannel.mountTarget({
      taskId: 'task-multi',
      targetId: 't-codex',
      sessionId: sCodex.sessionId,
      native: sCodex.native,
      accessMode: 'interactive',
      owner: OWNER,
    });
    await taskChannel.mountTarget({
      taskId: 'task-multi',
      targetId: 't-agy',
      sessionId: sAgy.sessionId,
      native: sAgy.native,
      accessMode: 'interactive',
      owner: OWNER,
    });

    const targets = taskChannel.listTargets('task-multi');
    assert.equal(targets.length, 3);
    assert.deepEqual(
      targets.map((t) => t.native.provider),
      ['claude', 'codex', 'agy'],
    );

    // Duplicate native session under another targetId must fail
    await assert.rejects(
      () =>
        taskChannel.mountTarget({
          taskId: 'task-multi',
          targetId: 't-codex-dup',
          sessionId: sCodex.sessionId,
          native: sCodex.native,
          accessMode: 'interactive',
          owner: OWNER,
        }),
      /already mounted/,
    );

    // Baseline sync establishes 3 independent cursors
    const initSync = await taskChannel.syncTask('task-multi');
    assert.deepEqual(initSync.syncedTargets, ['t-claude', 't-codex', 't-agy']);
    assert.equal(initSync.failedTargets.length, 0);

    // All three providers stream outputs concurrently with the EXACT SAME turnId!
    const sharedTurnId = 'shared-turn-1';
    const makeMsg = (s: Session, text: string, rev: number, final: boolean): Message => ({
      messageId: `msg-${s.native.provider}-1`,
      sessionId: s.sessionId,
      turnId: sharedTurnId,
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      sequence: 1,
      revision: rev,
      final,
      source: s.native.provider,
    });

    await core.observe({ type: 'message', ref: sClaude.native, message: makeMsg(sClaude, 'Claude partial', 1, false) });
    await core.observe({ type: 'message', ref: sCodex.native, message: makeMsg(sCodex, 'Codex partial', 1, false) });
    await core.observe({ type: 'message', ref: sAgy.native, message: makeMsg(sAgy, 'Agy partial', 1, false) });

    feishu.sent.length = 0;
    await taskChannel.syncTask('task-multi');
    assert.equal(feishu.sent.length, 3);
    assert.equal(new Set(feishu.sent.map((x) => x.messageId)).size, 3);
    assert.match(feishu.sent[0]!.card.title, /^Claude/);
    assert.match(feishu.sent[1]!.card.title, /^Codex/);
    assert.match(feishu.sent[2]!.card.title, /^Antigravity/);

    const cardByProvider = new Map(
      feishu.sent.map((x) => [x.card.title.split(' ')[0], x.messageId]),
    );

    // Final messages + turn completions on the same shared turnId update their own card slots only
    await core.observe({ type: 'message', ref: sClaude.native, message: makeMsg(sClaude, 'Claude final', 2, true) });
    await core.observe({ type: 'message', ref: sCodex.native, message: makeMsg(sCodex, 'Codex final', 2, true) });
    await core.observe({ type: 'message', ref: sAgy.native, message: makeMsg(sAgy, 'Agy final', 2, true) });

    await taskChannel.syncTask('task-multi');
    assert.equal(feishu.sent.length, 3); // no extra cards created
    assert.equal(feishu.updated.length, 3);

    const updatedClaude = feishu.updated.find((u) => u.messageId === cardByProvider.get('Claude'));
    const updatedCodex = feishu.updated.find((u) => u.messageId === cardByProvider.get('Codex'));
    const updatedAgy = feishu.updated.find((u) => u.messageId === cardByProvider.get('Antigravity'));
    assert.ok(updatedClaude && updatedClaude.card.text.includes('Claude final'));
    assert.ok(updatedCodex && updatedCodex.card.text.includes('Codex final'));
    assert.ok(updatedAgy && updatedAgy.card.text.includes('Agy final'));

    // Verify 3 separate cursor rows exist in task_cursors_v1
    for (const t of targets) {
      const c = taskChannel.getCursor('task-multi', t.targetId, t.targetGeneration);
      assert.ok(c && c.sessionId === t.sessionId);
    }

    // Provider isolation: if agy fails, claude and codex continue syncing normally
    const origSubscribe = core.subscribeEvents.bind(core);
    (core as any).subscribeEvents = async (id: string, cursor: string, limit: number) => {
      if (id === sAgy.sessionId) throw new Error('agy temporarily offline');
      return origSubscribe(id, cursor, limit);
    };
    const res = await taskChannel.syncTask('task-multi');
    assert.deepEqual(res.syncedTargets, ['t-claude', 't-codex']);
    assert.equal(res.failedTargets.length, 1);
    assert.equal(res.failedTargets[0]!.targetId, 't-agy');
    assert.equal(res.failedTargets[0]!.provider, 'agy');

    // Legacy channel_bindings table schema remains completely untouched
    const db = new DatabaseSync(channelDbPath, { readOnly: true });
    const legacyCols = (db.prepare('PRAGMA table_info(channel_bindings)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.equal(legacyCols.includes('task_id'), false);
    assert.equal(legacyCols.includes('active_target_id'), false);
    db.close();
  } finally {
    taskChannel.close();
    legacyChannel.close();
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T1: switchActiveTarget CAS, pre-switch captured A still dispatches A, stale active_revision card rejected, revoked A never falls back to B', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't1-switch-cas-'));
  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  const claude = makeFakeProviderPort('claude');
  const codex = makeFakeProviderPort('codex');
  const agy = makeFakeProviderPort('agy');

  const sA = makeSession('claude', 'n-a', '/work/a');
  const sB = makeSession('codex', 'n-b', '/work/b');
  const sRO = makeSession('agy', 'n-ro', '/work/ro', true);
  for (const s of [sA, sB, sRO]) store.insertSession(s);

  const core = new UnifiedCore(
    store,
    [claude.port, codex.port, agy.port],
    (id) => id.source === 'feishu' && id.subject === 'owner-1',
  );
  const feishu = makeFakeFeishuPort();
  const taskChannel = new TaskTopicChannel(
    core,
    feishu.port,
    async (id) => id.subject === 'owner-1',
    join(dir, 'channel.sqlite'),
  );

  const env = (eventId: string, subject = 'owner-1'): TrustedEnvelope => ({
    eventId,
    destination: 'topic:task-cas',
    identity: { source: 'feishu', subject },
  });

  try {
    taskChannel.registerTask({
      taskId: 'task-cas',
      destination: 'topic:task-cas',
      rootGeneration: 1,
      owner: OWNER,
    });
    await taskChannel.mountTarget({
      taskId: 'task-cas',
      targetId: 'target-a',
      sessionId: sA.sessionId,
      native: sA.native,
      accessMode: 'interactive',
      owner: OWNER,
      makeActive: true,
    });
    await taskChannel.mountTarget({
      taskId: 'task-cas',
      targetId: 'target-b',
      sessionId: sB.sessionId,
      native: sB.native,
      accessMode: 'interactive',
      owner: OWNER,
    });
    await taskChannel.mountTarget({
      taskId: 'task-cas',
      targetId: 'target-ro',
      sessionId: sRO.sessionId,
      native: sRO.native,
      accessMode: 'read_only',
      owner: OWNER,
    });

    const initialBinding = taskChannel.getBinding('task-cas')!;
    assert.equal(initialBinding.activeTargetId, 'target-a');
    assert.equal(initialBinding.activeRevision, 2);

    // 1. Pre-switch input captured for A
    const capA = await taskChannel.intake(env('msg-before-switch'), {
      action: 'input',
      text: 'message for A before switch',
      mode: 'new',
    });
    assert.equal(capA.capturedTargetId, 'target-a');
    assert.equal(capA.sessionId, sA.sessionId);

    // Capture a resource scope before switch
    const oldResScope = await taskChannel.captureResourceScope(env('res-pre'));

    // Also render a panel card before switch (carries activeRevision: 2)
    await taskChannel.handle(env('panel-before'), { action: 'panel' });
    const oldPanelCard = feishu.sent.find((x) => x.card.title === '任务目标面板')!.card;
    const oldSwitchBtnValue = oldPanelCard.actions[0]!.value as any;
    assert.equal(oldSwitchBtnValue.activeRevision, 2);

    // 2. CAS negative tests on switchActiveTarget
    await assert.rejects(
      () =>
        taskChannel.switchActiveTarget({
          taskId: 'task-cas',
          targetId: 'target-b',
          expectedActiveRevision: 1, // stale
          expectedRootGeneration: 1,
          owner: OWNER,
        }),
      (e: unknown) => e instanceof TaskChannelError && e.code === 'stale_active_revision',
    );
    await assert.rejects(
      () =>
        taskChannel.switchActiveTarget({
          taskId: 'task-cas',
          targetId: 'target-b',
          expectedActiveRevision: 2,
          expectedRootGeneration: 99, // wrong root generation
          owner: OWNER,
        }),
      (e: unknown) => e instanceof TaskChannelError && e.code === 'stale_revision',
    );
    await assert.rejects(
      () =>
        taskChannel.switchActiveTarget({
          taskId: 'task-cas',
          targetId: 'target-b',
          expectedActiveRevision: 2,
          expectedRootGeneration: 1,
          owner: { source: 'feishu', subject: 'attacker' },
        }),
      (e: unknown) => e instanceof TaskChannelError && e.code === 'unauthorized',
    );
    await assert.rejects(
      () =>
        taskChannel.switchActiveTarget({
          taskId: 'task-cas',
          targetId: 'target-ro', // read-only target rejected
          expectedActiveRevision: 2,
          expectedRootGeneration: 1,
          owner: OWNER,
        }),
      (e: unknown) => e instanceof TaskChannelError && e.code === 'read_only_target',
    );

    // 3. Valid CAS switch A -> B
    const switched = await taskChannel.switchActiveTarget({
      taskId: 'task-cas',
      targetId: 'target-b',
      expectedActiveRevision: 2,
      expectedRootGeneration: 1,
      owner: OWNER,
    });
    assert.equal(switched.activeTargetId, 'target-b');
    assert.equal(switched.activeRevision, 3);

    // Resource scope captured before switch must reject after switch
    await assert.rejects(
      () =>
        taskChannel.intake(
          env('res-after'),
          {
            action: 'attachment',
            name: 'note.txt',
            mediaType: 'text/plain',
            content: Buffer.from('hi'),
            mode: 'new',
          },
          oldResScope,
        ),
      (e: unknown) => e instanceof TaskChannelError && e.code === 'stale_active_revision',
    );

    // 4. Old card carrying old active_revision=2 is rejected at intake
    await assert.rejects(
      () => taskChannel.intake(env('card:stale-click'), oldSwitchBtnValue),
      (e: unknown) => e instanceof TaskChannelError && e.code === 'stale_active_revision',
    );
    assert.equal(taskChannel.getInboxScope('card:stale-click'), null);

    // 5. Drain pre-switch captured input -> dispatches to A ONCE, 0 to B
    await taskChannel.drain('msg-before-switch');
    await core.dispatchPending();
    assert.equal(claude.inputs.length, 1);
    assert.equal(claude.inputs[0]!.text, 'message for A before switch');
    assert.equal(codex.inputs.length, 0);

    // Re-draining same eventId is idempotent
    await taskChannel.drain('msg-before-switch');
    await core.dispatchPending();
    assert.equal(claude.inputs.length, 1);

    // 6. Post-switch new ordinary input -> dispatches to B ONCE, 0 more to A
    await taskChannel.handle(env('msg-after-switch'), {
      action: 'input',
      text: 'message for B after switch',
      mode: 'new',
    });
    await core.dispatchPending();
    assert.equal(codex.inputs.length, 1);
    assert.equal(codex.inputs[0]!.text, 'message for B after switch');
    assert.equal(claude.inputs.length, 1);

    // 7. If A was captured and then revoked/bumped before drain -> REJECTED, NEVER falls back to B!
    await taskChannel.switchActiveTarget({
      taskId: 'task-cas',
      targetId: 'target-a',
      expectedActiveRevision: 3,
      expectedRootGeneration: 1,
      owner: OWNER,
    });
    await taskChannel.intake(env('msg-a-before-revoke'), {
      action: 'input',
      text: 'should never reach B',
      mode: 'new',
    });
    taskChannel.revokeTarget('task-cas', 'target-a', OWNER);
    // Even if active target is switched to B afterwards, captured A event must NOT redirect to B!
    const afterRevokeBinding = taskChannel.getBinding('task-cas')!;
    await taskChannel.switchActiveTarget({
      taskId: 'task-cas',
      targetId: 'target-b',
      expectedActiveRevision: afterRevokeBinding.activeRevision,
      expectedRootGeneration: 1,
      owner: OWNER,
    });

    const drainRevoked = (await taskChannel.drain('msg-a-before-revoke')) as {
      status: string;
      reason: string;
    };
    await core.dispatchPending();
    assert.equal(drainRevoked.status, 'expired');
    assert.equal(claude.inputs.length, 1);
    assert.equal(codex.inputs.length, 1);
  } finally {
    taskChannel.close();
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T1: cross-target interaction routing targets exact card targetId/sessionId regardless of activeTarget, and rejects read-only targets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't1-interactions-'));
  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  const claude = makeFakeProviderPort('claude');
  const codex = makeFakeProviderPort('codex');
  const agy = makeFakeProviderPort('agy');

  const sClaude = makeSession('claude', 'n-claude', '/work/c');
  const sCodex = makeSession('codex', 'n-codex', '/work/x');
  const sAgyRO = makeSession('agy', 'n-agy-ro', '/work/ro', true);
  for (const s of [sClaude, sCodex, sAgyRO]) store.insertSession(s);

  const core = new UnifiedCore(
    store,
    [claude.port, codex.port, agy.port],
    (id) => id.source === 'feishu' && id.subject === 'owner-1',
  );
  const feishu = makeFakeFeishuPort();
  const taskChannel = new TaskTopicChannel(
    core,
    feishu.port,
    async (id) => id.subject === 'owner-1',
    join(dir, 'channel.sqlite'),
  );

  try {
    taskChannel.registerTask({
      taskId: 'task-int',
      destination: 'topic:task-int',
      rootGeneration: 1,
      owner: OWNER,
    });
    await taskChannel.mountTarget({
      taskId: 'task-int',
      targetId: 't-claude',
      sessionId: sClaude.sessionId,
      native: sClaude.native,
      accessMode: 'interactive',
      owner: OWNER,
    });
    await taskChannel.mountTarget({
      taskId: 'task-int',
      targetId: 't-codex',
      sessionId: sCodex.sessionId,
      native: sCodex.native,
      accessMode: 'interactive',
      owner: OWNER,
      makeActive: true, // activeTarget is Codex!
    });
    await taskChannel.mountTarget({
      taskId: 'task-int',
      targetId: 't-agy-ro',
      sessionId: sAgyRO.sessionId,
      native: sAgyRO.native,
      accessMode: 'read_only',
      owner: OWNER,
    });

    // Baseline sync
    await taskChannel.syncTask('task-int');
    feishu.sent.length = 0;

    // Emit approval interaction on Claude (NOT activeTarget) and question on read-only Agy
    const iClaude: Interaction = {
      kind: 'approval',
      interactionId: 'int-claude-1',
      sessionId: sClaude.sessionId,
      turnId: 'turn-c',
      nativeRequestId: 'req-c1',
      connectionGeneration: 0,
      revision: 0,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: 'digest-bash-1',
      nativeResult: null,
      tool: 'Bash',
      action: 'run tests',
      scope: 'workspace',
    };
    const iAgyRO: Interaction = {
      kind: 'question',
      interactionId: 'int-agy-ro-1',
      sessionId: sAgyRO.sessionId,
      turnId: 'turn-a',
      nativeRequestId: 'req-a1',
      connectionGeneration: 0,
      revision: 0,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: null,
      nativeResult: null,
      prompt: 'Pick one',
      choices: ['opt1', 'opt2'],
      multiple: false,
      allowFreeText: false,
    };
    await core.observe({ type: 'interaction', ref: sClaude.native, interaction: iClaude });
    // Read-only session has interaction inserted directly in store or snapshot to verify read-only card
    store.insertInteraction(iAgyRO);

    await taskChannel.syncTask('task-int');
    const claudeCard = feishu.sent.find((x) => x.card.title.startsWith('Claude'))!;
    const agyCard = feishu.sent.find((x) => x.card.title.startsWith('Antigravity'))!;
    assert.ok(claudeCard && claudeCard.card.actions.length === 2);
    assert.equal(agyCard.card.actions.length, 0);
    assert.equal(agyCard.card.form?.submittable, false);
    assert.match(agyCard.card.text, /只读/);

    // Click "允许" on Claude's card while activeTarget is Codex!
    const allowAction = claudeCard.card.actions[0]!.value as any;
    assert.equal(allowAction.targetId, 't-claude');
    assert.equal(allowAction.sessionId, sClaude.sessionId);

    const resolveOp = (await taskChannel.handle(
      { eventId: 'card:allow-claude', destination: 'topic:task-int', identity: OWNER },
      allowAction,
    )) as { targetId: string; action: string };
    assert.equal(resolveOp.targetId, sClaude.sessionId);
    assert.equal(resolveOp.action, 'resolveInteraction');

    await core.dispatchPending();
    assert.equal(claude.responds.length, 1);
    assert.equal(claude.responds[0]!.interactionId, 'int-claude-1');
    assert.equal(codex.responds.length, 0);

    // Forged answer targeting read-only Agy MUST be rejected explicitly with 0 core/port calls
    const roRes = (await taskChannel.handle(
      { eventId: 'card:forged-ro', destination: 'topic:task-int', identity: OWNER },
      {
        action: 'answer',
        taskId: 'task-int',
        rootGeneration: 1,
        activeRevision: taskChannel.getBinding('task-int')!.activeRevision,
        targetId: 't-agy-ro',
        targetGeneration: 1,
        sessionId: sAgyRO.sessionId,
        interactionId: 'int-agy-ro-1',
        revision: 0,
        connectionGeneration: 0,
        answer: { kind: 'question', values: ['opt1'] },
        toolInputDigest: null,
      },
    )) as { status: string; reason: string };
    assert.equal(roRes.status, 'rejected');
    assert.equal(roRes.reason, 'read_only_target');
    assert.equal(agy.responds.length, 0);

    // Wrong targetGeneration or sessionId mismatch is rejected at intake
    await assert.rejects(
      () =>
        taskChannel.intake(
          { eventId: 'card:wrong-gen', destination: 'topic:task-int', identity: OWNER },
          { ...allowAction, targetGeneration: 99 },
        ),
      (e: unknown) => e instanceof TaskChannelError && e.code === 'stale_revision',
    );
    await assert.rejects(
      () =>
        taskChannel.intake(
          { eventId: 'card:wrong-sess', destination: 'topic:task-int', identity: OWNER },
          { ...allowAction, sessionId: sCodex.sessionId },
        ),
      (e: unknown) => e instanceof TaskChannelError && e.code === 'stale_revision',
    );

    // Native resolution on Claude retracts buttons from Claude's card on syncTask
    await core.observe({
      type: 'interaction',
      ref: sClaude.native,
      interaction: {
        ...iClaude,
        status: 'resolved',
        nativeResult: { status: 'accepted', source: 'terminal', answer: { kind: 'approval', decision: 'allow', scope: 'workspace' } },
      },
    });
    await taskChannel.syncTask('task-int');
    const claudeUpdated = feishu.updated.filter((u) => u.messageId === claudeCard.messageId).at(-1)!;
    assert.equal(claudeUpdated.card.actions.length, 0);
  } finally {
    taskChannel.close();
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T1: 0090d1a rollback guard preserves co-located task_bindings/targets/inbox/cursors/handoffs and never leaks task events to old channel', async (t) => {
  const release = process.env.TASK_GUARD_RELEASE;
  if (!release) {
    t.skip('set TASK_GUARD_RELEASE');
    return;
  }

  const { FeishuSdkPort: GuardSdk } = await import(`${release}/dist/src/unified/feishu-sdk-port.js`);
  const { FeishuChannel: OldChannel } = await import(`${release}/dist/src/unified/feishu-channel.js`);

  const dir = mkdtempSync(join(tmpdir(), 't1-009-rollback-'));
  const sdkPath = join(dir, 'sdk.sqlite');
  const corePath = join(dir, 'core.sqlite');
  const channelPath = join(dir, 'channel.sqlite');

  const store = new UnifiedStore(corePath);
  const claude = makeFakeProviderPort('claude');
  const codex = makeFakeProviderPort('codex');
  const agy = makeFakeProviderPort('agy');
  const sClaude = makeSession('claude', 'rb-claude', '/work/rb');
  const sCodex = makeSession('codex', 'rb-codex', '/work/rb');
  const sAgy = makeSession('agy', 'rb-agy', '/work/rb');
  for (const s of [sClaude, sCodex, sAgy]) store.insertSession(s);

  const core = new UnifiedCore(
    store,
    [claude.port, codex.port, agy.port],
    (id) => id.source === 'feishu' && id.subject === 'owner',
  );

  let sdk: any;
  let feishuChannel: FeishuChannel | undefined;
  let taskChannel: TaskTopicChannel | undefined;
  let handoffSvc: TaskHandoffService | undefined;
  let guardSdk: any;
  let oldChannel: any;

  try {
    // 1. Create active task topic in current FeishuSdkPort (taskEnabled=true)
    sdk = new FeishuSdkPort({ appId: 'app', appSecret: 'sec' }, sdkPath, new Set(['chat']), 'owner', true);
    let msgSeq = 0;
    sdk.client = {
      request: async () => ({ bot: { open_id: 'bot' } }),
      im: {
        message: {
          create: async () => ({ data: { message_id: `root-${++msgSeq}` } }),
          reply: async () => ({ data: { message_id: `reply-${++msgSeq}` } }),
        },
        messageResource: {
          get: async () => {
            throw new Error('unexpected download');
          },
        },
        file: {},
      },
    };
    sdk.ws = { start: async () => {}, close() {} };
    const token = await sdk.createTaskTopic('chat', 'task-rb', 'op-rb', 'owner');

    // 2. Write production binding + co-located T1/T2 state into channel.sqlite
    feishuChannel = new FeishuChannel(
      core,
      sdk,
      async (id, d) => id.subject === 'owner' && sdk.authorizedDestination(d),
      channelPath,
    );
    const prodBindRes = (await feishuChannel.handle(
      { eventId: 'prod-bind', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } },
      { action: 'bind', sessionId: sCodex.sessionId },
    )) as { destination: string };
    const prodDest = prodBindRes.destination;

    taskChannel = new TaskTopicChannel(
      core,
      sdk,
      async (id) => id.subject === 'owner',
      channelPath,
    );
    handoffSvc = new TaskHandoffService(core, async (id) => id.subject === 'owner', channelPath);

    taskChannel.registerFromToken(token);
    await taskChannel.mountTarget({
      taskId: token.taskId,
      targetId: 'rb-claude',
      sessionId: sClaude.sessionId,
      native: sClaude.native,
      accessMode: 'interactive',
      owner: { source: 'feishu', subject: 'owner' },
      makeActive: true,
    });
    await taskChannel.mountTarget({
      taskId: token.taskId,
      targetId: 'rb-codex',
      sessionId: sCodex.sessionId,
      native: sCodex.native,
      accessMode: 'interactive',
      owner: { source: 'feishu', subject: 'owner' },
    });
    await taskChannel.mountTarget({
      taskId: token.taskId,
      targetId: 'rb-agy',
      sessionId: sAgy.sessionId,
      native: sAgy.native,
      accessMode: 'interactive',
      owner: { source: 'feishu', subject: 'owner' },
    });

    await taskChannel.syncTask(token.taskId);
    await taskChannel.intake(
      { eventId: 'task-pending-evt', destination: token.destination, identity: { source: 'feishu', subject: 'owner' } },
      { action: 'input', text: 'pending task input', mode: 'new' },
    );
    await handoffSvc.previewHandoff({
      handoffId: 'hoff-rb',
      taskId: token.taskId,
      sourceTargetId: 'rb-codex',
      targetTargetId: 'rb-agy',
      owner: { source: 'feishu', subject: 'owner' },
      summary: 'rollback preservation check',
    });

    handoffSvc.close();
    handoffSvc = undefined;
    taskChannel.close();
    taskChannel = undefined;
    feishuChannel.close();
    feishuChannel = undefined;
    sdk.close();
    sdk = undefined;

    // 3. Rollback to 0090d1a Guard SDK + Old FeishuChannel
    guardSdk = new GuardSdk({ appId: 'app', appSecret: 'sec' }, sdkPath, new Set(['chat']), 'owner');
    let handles: any;
    let prodCalls = 0;
    guardSdk.client = {
      request: async () => ({ bot: { open_id: 'bot' } }),
      im: { message: { create: async () => ({ data: { message_id: 'guard-msg' } }) } },
    };
    guardSdk.ws = {
      start: async ({ eventDispatcher }: any) => {
        handles = eventDispatcher.handles;
      },
      close() {},
    };
    await guardSdk.start(
      async () => {
        prodCalls++;
      },
      async () => 'prod-scope',
    );

    const msgEvt = (id: string, root?: string) => ({
      sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
      message: {
        message_id: id,
        chat_id: 'chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/sessions' }),
        ...(root ? { root_id: root } : {}),
      },
    });

    // Main chat production still works
    await handles.get('im.message.receive_v1')(msgEvt('main-ok'));
    assert.equal(prodCalls, 1);

    // Task root rejected by 0090d1a guard; 0 production calls & not treated as TEST
    await assert.rejects(handles.get('im.message.receive_v1')(msgEvt('task-msg', token.rootId)));
    assert.equal(prodCalls, 1);

    oldChannel = new OldChannel(
      core,
      guardSdk,
      async (id: any, d: string) => id.subject === 'owner' && guardSdk.authorizedDestination(d),
      channelPath,
    );
    assert.deepEqual(oldChannel.boundDestinations(), [prodDest]);
    assert.equal(oldChannel.boundDestinations().includes(token.destination), false);
    assert.equal(oldChannel.pendingInbox().includes('task-pending-evt'), false);
    assert.equal(oldChannel.unknownInbox().includes('task-pending-evt'), false);
    await oldChannel.sync(prodDest);

    oldChannel.close();
    oldChannel = undefined;
    guardSdk.close();
    guardSdk = undefined;

    // 4. Re-open current T1/T2 and confirm zero loss / zero corruption
    const reopenedTask = new TaskTopicChannel(
      core,
      makeFakeFeishuPort().port,
      async (id) => id.subject === 'owner',
      channelPath,
    );
    const reopenedHandoff = new TaskHandoffService(
      core,
      async (id) => id.subject === 'owner',
      channelPath,
    );
    try {
      assert.equal(reopenedTask.getBinding(token.taskId)?.activeTargetId, 'rb-claude');
      assert.equal(reopenedTask.listTargets(token.taskId).length, 3);
      assert.deepEqual(reopenedTask.pendingInbox(token.taskId), ['task-pending-evt']);
      assert.ok(reopenedTask.getCursor(token.taskId, 'rb-agy', 1));
      assert.equal(reopenedHandoff.getHandoff('hoff-rb')?.status, 'draft');
    } finally {
      reopenedHandoff.close();
      reopenedTask.close();
    }
  } finally {
    try {
      oldChannel?.close();
    } catch {}
    try {
      guardSdk?.close();
    } catch {}
    try {
      handoffSvc?.close();
    } catch {}
    try {
      taskChannel?.close();
    } catch {}
    try {
      feishuChannel?.close();
    } catch {}
    try {
      sdk?.close();
    } catch {}
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
