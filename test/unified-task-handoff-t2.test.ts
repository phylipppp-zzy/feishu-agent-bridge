import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedCore } from '../src/unified/service.js';
import { ArtifactRegistry } from '../src/unified/artifact-registry.js';
import { LocalCatalog } from '../src/unified/local-catalog.js';
import { EnrichedPort } from '../src/unified/port-enrichment.js';
import type { PlatformPort, PlatformObservation, UnifiedService } from '../src/unified/adapter.js';
import type { Capabilities, NativeSessionRef, Provider, Session } from '../src/unified/contracts.js';
import { contractError } from '../src/unified/errors.js';
import { TaskTopicChannel } from '../src/unified/task-topic-channel.js';
import {
  MAX_HANDOFF_SUMMARY_CHARS,
  TaskHandoffError,
  TaskHandoffService,
} from '../src/unified/task-handoff.js';

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
  return {
    sessionId: `sess-${provider}-${nativeSessionId}`,
    native: {
      provider,
      hostId: 'host-1',
      serviceId: `svc-${provider}`,
      nativeSessionId,
    },
    project,
    title: `${provider} task`,
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

function makeFakeProviderPort(provider: Provider, registry: ArtifactRegistry, sessions: Map<string, Session>) {
  const listeners = new Set<(o: PlatformObservation) => void>();
  const inputs: Array<{ ref: NativeSessionRef; text: string }> = [];
  const responds: Array<{ ref: NativeSessionRef; interactionId: string }> = [];
  let turnSeq = 0;
  let controlGen = 1;
  let connGen = 0;

  const base: PlatformPort = {
    provider,
    seedConnectionGeneration: (min) => {
      connGen = Math.max(connGen, min);
    },
    seedControlGeneration: (_ref, min) => {
      controlGen = Math.max(controlGen, min);
    },
    list: async () => ({ items: [...sessions.values()], nextCursor: null }),
    read: async (ref) => {
      const s = sessions.get(ref.nativeSessionId);
      if (!s) throw new Error('missing session');
      return {
        session: { ...s, control: { ...s.control, generation: controlGen } },
        messages: [],
        interactions: [],
        turns: [],
        connectionGeneration: connGen,
      };
    },
    resume: async (ref) => {
      controlGen++;
      connGen++;
      return {
        status: 'submitted',
        nativeReference: ref.nativeSessionId,
        connectionGeneration: connGen,
      };
    },
    create: async () => ({ status: 'submitted', nativeReference: 'new', connectionGeneration: 0 }),
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
    respond: async (ref, interaction, _answer, guard) => {
      guard.assertCurrent();
      responds.push({ ref, interactionId: interaction.interactionId });
      return { status: 'submitted', nativeReference: interaction.nativeRequestId };
    },
    onObservation: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listArtifacts: async () => {
      throw contractError('unsupported');
    },
    readArtifact: async () => {
      throw contractError('unsupported');
    },
    listModels: async () => [],
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
    port: new EnrichedPort(base, new LocalCatalog([]), registry, () => {}),
    inputs,
    responds,
  };
}

test('T2: codex -> agy and agy -> claude preview (0 native input) -> edit -> confirm (target 1x, source 0x) -> idempotent replay -> empty file & Chinese boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-handoff-'));
  const workDir = join(dir, 'workspace');
  const codexRoot = join(workDir, 'codex-proj');
  const agyRoot = join(workDir, 'agy-proj');
  const claudeRoot = join(workDir, 'claude-proj');
  mkdirSync(codexRoot, { recursive: true });
  mkdirSync(agyRoot, { recursive: true });
  mkdirSync(claudeRoot, { recursive: true });

  const planPath = join(codexRoot, 'plan.md');
  const emptyPath = join(codexRoot, 'empty.txt');
  writeFileSync(planPath, '实施步骤 1：完成 T1/T2 交接');
  writeFileSync(emptyPath, '');

  const registry = new ArtifactRegistry({});
  const sCodex = makeSession('codex', 'ncx', codexRoot);
  const sAgy = makeSession('agy', 'nagy', agyRoot);
  const sClaude = makeSession('claude', 'ncl', claudeRoot);

  registry.setRoots(sCodex.native, [codexRoot]);
  registry.setRoots(sAgy.native, [agyRoot]);
  registry.setRoots(sClaude.native, [claudeRoot]);

  const codexKey = JSON.stringify([sCodex.native.provider, sCodex.native.hostId, sCodex.native.serviceId, sCodex.native.nativeSessionId]);
  const planArt = await registry.register(codexKey, planPath, 'text/markdown');
  const emptyArt = await registry.register(codexKey, emptyPath, 'text/plain');

  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  for (const s of [sCodex, sAgy, sClaude]) store.insertSession(s);

  // Add history + approval on Codex to ensure neither full history nor approvals are copied/authorized on Agy
  store.putMessage(
    {
      messageId: 'secret-history-msg',
      sessionId: sCodex.sessionId,
      turnId: 't-old',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'FULL_HISTORY_SECRET_SHOULD_NOT_AUTO_COPY' }],
      sequence: 1,
      revision: 0,
      final: true,
      source: 'codex',
    },
    null,
  );
  store.insertInteraction({
    kind: 'approval',
    interactionId: 'codex-approved-tool',
    sessionId: sCodex.sessionId,
    turnId: 't-old',
    nativeRequestId: 'req-old',
    connectionGeneration: 0,
    revision: 0,
    status: 'awaiting_answer',
    expiresAt: null,
    toolInputDigest: 'dig-1',
    nativeResult: null,
    tool: 'Bash',
    action: 'rm -rf /tmp/x',
    scope: 'dangerous',
  });

  const codexPort = makeFakeProviderPort('codex', registry, new Map([[sCodex.native.nativeSessionId, sCodex]]));
  const agyPort = makeFakeProviderPort('agy', registry, new Map([[sAgy.native.nativeSessionId, sAgy]]));
  const claudePort = makeFakeProviderPort('claude', registry, new Map([[sClaude.native.nativeSessionId, sClaude]]));

  const core = new UnifiedCore(
    store,
    [codexPort.port, agyPort.port, claudePort.port],
    (id) => id.source === 'feishu' && id.subject === 'owner-1',
  );
  await core.attachSession({
    context: {
      operationId: 'attach-codex',
      idempotencyKey: 'attach-codex',
      targetId: 'new:codex',
      expectedRevision: 0,
      controlGeneration: 0,
      identity: OWNER,
    },
    payload: { ...sCodex.native, mode: 'interactive' },
  });
  await core.attachSession({
    context: {
      operationId: 'attach-agy',
      idempotencyKey: 'attach-agy',
      targetId: 'new:agy',
      expectedRevision: 0,
      controlGeneration: 0,
      identity: OWNER,
    },
    payload: { ...sAgy.native, mode: 'interactive' },
  });
  let readHistoryCalls = 0;
  const origReadHistory = core.readHistory.bind(core);
  core.readHistory = async (...args) => {
    readHistoryCalls++;
    return origReadHistory(...args);
  };

  const dbPath = join(dir, 'channel.sqlite');
  const fakeFeishu = { send: async () => 'm', update: async () => {}, sendFile: async () => {} };
  const channel = new TaskTopicChannel(core, fakeFeishu, async (id) => id.subject === 'owner-1', dbPath);
  const handoff = new TaskHandoffService(core, async (id) => id.subject === 'owner-1', dbPath, {
    allowedProjectRoots: [workDir],
  });

  try {
    channel.registerTask({
      taskId: 'task-h',
      destination: 'topic:task-h',
      rootGeneration: 1,
      owner: OWNER,
    });
    await channel.mountTarget({
      taskId: 'task-h',
      targetId: 't-codex',
      sessionId: sCodex.sessionId,
      native: sCodex.native,
      accessMode: 'interactive',
      owner: OWNER,
      makeActive: true,
    });
    await channel.mountTarget({
      taskId: 'task-h',
      targetId: 't-agy',
      sessionId: sAgy.sessionId,
      native: sAgy.native,
      accessMode: 'interactive',
      owner: OWNER,
    });
    await channel.mountTarget({
      taskId: 'task-h',
      targetId: 't-claude',
      sessionId: sClaude.sessionId,
      native: sClaude.native,
      accessMode: 'interactive',
      owner: OWNER,
    });

    // 1. Preview codex -> agy (zero model calls, zero native input, includes empty file & Chinese summary)
    const preview1 = await handoff.previewHandoff({
      handoffId: 'hoff-codex-agy',
      taskId: 'task-h',
      sourceTargetId: 't-codex',
      targetTargetId: 't-agy',
      owner: OWNER,
      summary: '中文交接摘要：Codex 已完成接口定义，请 Antigravity 接续实现测试。',
      constraints: ['禁止执行破坏性 shell 命令', '不得假设已继承 Codex 的工具审批'],
      artifactRefs: [
        { artifactId: planArt.artifactId, name: 'plan.md', contentVersion: planArt.contentVersion },
        { artifactId: emptyArt.artifactId, name: 'empty.txt', contentVersion: emptyArt.contentVersion },
      ],
    });
    assert.equal(preview1.draft.status, 'draft');
    assert.match(preview1.draft.previewDigest, /^[a-f0-9]{64}$/);
    assert.equal(preview1.draft.targetSessionId, sAgy.sessionId);
    assert.equal(preview1.draft.targetCwd, agyRoot);
    assert.equal(preview1.draft.artifactRefs.length, 2);
    assert.equal(codexPort.inputs.length, 0);
    assert.equal(agyPort.inputs.length, 0);
    assert.equal(claudePort.inputs.length, 0);
    assert.equal(readHistoryCalls, 0);
    assert.match(preview1.card.title, /Codex → Antigravity/);
    assert.match(preview1.card.text, /不复制全量历史/);

    // 2. Edit summary via updateHandoffDraft (still 0 native input)
    const edited = await handoff.updateHandoffDraft({
      handoffId: 'hoff-codex-agy',
      expectedPreviewDigest: preview1.draft.previewDigest,
      owner: OWNER,
      summary: '编辑后的中文摘要：仅基于 plan.md 继续推进。',
    });
    assert.notEqual(edited.draft.previewDigest, preview1.draft.previewDigest);
    assert.equal(edited.draft.status, 'draft');
    assert.equal(agyPort.inputs.length, 0);

    // Old previewDigest cannot confirm after edit
    await assert.rejects(
      () =>
        handoff.confirmHandoff(
          'hoff-codex-agy',
          preview1.draft.previewDigest,
          preview1.draft.targetGeneration,
          OWNER,
          'idem-stale',
        ),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'stale_revision',
    );

    // 3. Confirm codex -> agy: target gets 1 submitInput, source gets 0
    const confirm1 = await handoff.confirmHandoff(
      'hoff-codex-agy',
      edited.draft.previewDigest,
      edited.draft.targetGeneration,
      OWNER,
      'idem-c2a',
    );
    assert.equal(confirm1.status, 'submitted');
    assert.equal(confirm1.handoff.status, 'submitted');
    assert.ok(confirm1.operation);
    await core.dispatch(confirm1.operation!.operationId);

    assert.equal(agyPort.inputs.length, 1);
    assert.equal(codexPort.inputs.length, 0);
    assert.equal(claudePort.inputs.length, 0);
    assert.equal(agyPort.responds.length, 0);
    assert.ok(agyPort.inputs[0]!.text.includes('编辑后的中文摘要'));
    assert.ok(agyPort.inputs[0]!.text.includes('plan.md'));
    assert.ok(agyPort.inputs[0]!.text.includes('empty.txt'));
    assert.equal(agyPort.inputs[0]!.text.includes('FULL_HISTORY_SECRET_SHOULD_NOT_AUTO_COPY'), false);

    // 4. Duplicate confirm with same idempotencyKey is idempotent (0 extra inputs!)
    const confirmReplay = await handoff.confirmHandoff(
      'hoff-codex-agy',
      edited.draft.previewDigest,
      edited.draft.targetGeneration,
      OWNER,
      'idem-c2a',
    );
    assert.equal(confirmReplay.status, 'submitted');
    assert.equal(confirmReplay.operation?.operationId, confirm1.operation?.operationId);
    await core.dispatchPending();
    assert.equal(agyPort.inputs.length, 1);

    // Different idempotencyKey on already-submitted handoff is rejected without resending
    await assert.rejects(
      () =>
        handoff.confirmHandoff(
          'hoff-codex-agy',
          edited.draft.previewDigest,
          edited.draft.targetGeneration,
          OWNER,
          'idem-other',
        ),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'idempotency_conflict',
    );
    assert.equal(agyPort.inputs.length, 1);

    // 5. agy -> claude preview & confirm (and exact max summary boundary)
    const maxChineseSummary = '字'.repeat(MAX_HANDOFF_SUMMARY_CHARS);
    const preview2 = await handoff.previewHandoff({
      handoffId: 'hoff-agy-claude',
      taskId: 'task-h',
      sourceTargetId: 't-agy',
      targetTargetId: 't-claude',
      owner: OWNER,
      summary: maxChineseSummary,
      constraints: ['只读验证后汇报'],
    });
    assert.equal(claudePort.inputs.length, 0);
    const confirm2 = await handoff.confirmHandoff(
      'hoff-agy-claude',
      preview2.draft.previewDigest,
      preview2.draft.targetGeneration,
      OWNER,
      'idem-a2c',
    );
    assert.equal(confirm2.status, 'submitted');
    await core.dispatch(confirm2.operation!.operationId);
    assert.equal(claudePort.inputs.length, 1);
    assert.equal(agyPort.inputs.length, 1);
    assert.equal(codexPort.inputs.length, 0);

    // Over-limit summary rejected
    await assert.rejects(
      () =>
        handoff.previewHandoff({
          taskId: 'task-h',
          sourceTargetId: 't-agy',
          targetTargetId: 't-claude',
          owner: OWNER,
          summary: '超'.repeat(MAX_HANDOFF_SUMMARY_CHARS + 1),
        }),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'invalid_request',
    );
  } finally {
    handoff.close();
    channel.close();
    core.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T2: rejects out-of-scope artifacts and rejects post-preview target switch / target generation bump / cwd change / file version change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-cas-rejects-'));
  const workDir = join(dir, 'work');
  const codexDir = join(workDir, 'codex');
  const agyDir = join(workDir, 'agy');
  const otherDir = join(dir, 'outside');
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(agyDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });

  const filePath = join(codexDir, 'spec.txt');
  const outsideFile = join(otherDir, 'secret.txt');
  writeFileSync(filePath, 'version-1');
  writeFileSync(outsideFile, 'top-secret');

  const registry = new ArtifactRegistry({});
  let currentAgyProject = agyDir;
  const sCodex = makeSession('codex', 'ncx', codexDir);
  const sAgy = makeSession('agy', 'nagy', currentAgyProject);
  const sClaude = makeSession('claude', 'ncl', workDir);
  const sOther = makeSession('codex', 'nother', otherDir);

  registry.setRoots(sCodex.native, [codexDir]);
  registry.setRoots(sOther.native, [otherDir]);
  const codexKey = JSON.stringify([sCodex.native.provider, sCodex.native.hostId, sCodex.native.serviceId, sCodex.native.nativeSessionId]);
  const otherKey = JSON.stringify([sOther.native.provider, sOther.native.hostId, sOther.native.serviceId, sOther.native.nativeSessionId]);

  let fileArtifact = await registry.register(codexKey, filePath, 'text/plain');
  const outsideArtifact = await registry.register(otherKey, outsideFile, 'text/plain');

  let submitCalls = 0;
  const sessions = new Map<string, Session>([
    [sCodex.sessionId, sCodex],
    [sAgy.sessionId, sAgy],
    [sClaude.sessionId, sClaude],
    [sOther.sessionId, sOther],
  ]);

  const service = {
    getSession: async (id: string) => {
      if (id === sAgy.sessionId) return { ...sAgy, project: currentAgyProject };
      return sessions.get(id)!;
    },
    listArtifacts: async (sessionId: string) => {
      const target = sessions.get(sessionId)!;
      const key = JSON.stringify([target.native.provider, target.native.hostId, target.native.serviceId, target.native.nativeSessionId]);
      const page = registry.list(key, 100);
      return { ...page, items: page.items.map((a) => ({ ...a, sessionId })) };
    },
    readArtifact: async (sessionId: string, artifactId: string, version: string) => {
      const target = sessions.get(sessionId)!;
      const key = JSON.stringify([target.native.provider, target.native.hostId, target.native.serviceId, target.native.nativeSessionId]);
      return registry.read(key, artifactId, version);
    },
    submitInput: async (req: any) => {
      submitCalls++;
      return {
        operationId: req.context.operationId,
        idempotencyKey: req.context.idempotencyKey,
        targetId: req.context.targetId,
        action: 'submitInput',
        payloadDigest: 'd',
        status: 'completed',
        revision: 1,
        error: null,
      };
    },
  } as unknown as UnifiedService;

  const dbPath = join(dir, 'channel.sqlite');
  const channel = new TaskTopicChannel(
    service,
    { send: async () => 'm', update: async () => {}, sendFile: async () => {} },
    async (id) => id.subject === 'owner-1',
    dbPath,
  );
  const handoff = new TaskHandoffService(service, async (id) => id.subject === 'owner-1', dbPath, {
    allowedProjectRoots: [workDir],
  });

  try {
    channel.registerTask({
      taskId: 'task-r',
      destination: 'topic:task-r',
      rootGeneration: 1,
      owner: OWNER,
    });
    await channel.mountTarget({
      taskId: 'task-r',
      targetId: 't-codex',
      sessionId: sCodex.sessionId,
      native: sCodex.native,
      accessMode: 'interactive',
      owner: OWNER,
      makeActive: true,
    });
    await channel.mountTarget({
      taskId: 'task-r',
      targetId: 't-agy',
      sessionId: sAgy.sessionId,
      native: sAgy.native,
      accessMode: 'interactive',
      owner: OWNER,
    });
    await channel.mountTarget({
      taskId: 'task-r',
      targetId: 't-claude',
      sessionId: sClaude.sessionId,
      native: sClaude.native,
      accessMode: 'interactive',
      owner: OWNER,
    });

    // 1. Out-of-scope / unrelated session artifact rejected
    await assert.rejects(
      () =>
        handoff.previewHandoff({
          taskId: 'task-r',
          sourceTargetId: 't-codex',
          targetTargetId: 't-agy',
          owner: OWNER,
          summary: 'try attach outside artifact',
          artifactRefs: [
            {
              artifactId: outsideArtifact.artifactId,
              name: 'secret.txt',
              contentVersion: outsideArtifact.contentVersion,
            },
          ],
        }),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'artifact_out_of_scope',
    );
    // Path traversal artifact name rejected
    await assert.rejects(
      () =>
        handoff.previewHandoff({
          taskId: 'task-r',
          sourceTargetId: 't-codex',
          targetTargetId: 't-agy',
          owner: OWNER,
          summary: 'bad name',
          artifactRefs: [{ artifactId: fileArtifact.artifactId, name: '../spec.txt', contentVersion: fileArtifact.contentVersion }],
        }),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'artifact_out_of_scope',
    );
    // Out-of-root targetCwd rejected
    currentAgyProject = otherDir;
    await assert.rejects(
      () =>
        handoff.previewHandoff({
          taskId: 'task-r',
          sourceTargetId: 't-codex',
          targetTargetId: 't-agy',
          owner: OWNER,
          summary: 'outside cwd',
        }),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'cwd_mismatch',
    );
    currentAgyProject = agyDir;

    // 2. Reject when activeTarget switched after preview
    const pSwitch = await handoff.previewHandoff({
      handoffId: 'h-switch',
      taskId: 'task-r',
      sourceTargetId: 't-codex',
      targetTargetId: 't-agy',
      owner: OWNER,
      summary: 'before switch',
    });
    const bNow = channel.getBinding('task-r')!;
    await channel.switchActiveTarget({
      taskId: 'task-r',
      targetId: 't-claude',
      expectedActiveRevision: bNow.activeRevision,
      expectedRootGeneration: 1,
      owner: OWNER,
    });
    await assert.rejects(
      () =>
        handoff.confirmHandoff(
          'h-switch',
          pSwitch.draft.previewDigest,
          pSwitch.draft.targetGeneration,
          OWNER,
          'k-switch',
        ),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'stale_revision',
    );
    assert.equal(handoff.getHandoff('h-switch')?.status, 'expired');

    // 3. Reject when targetGeneration bumped after preview
    const pGen = await handoff.previewHandoff({
      handoffId: 'h-gen',
      taskId: 'task-r',
      sourceTargetId: 't-codex',
      targetTargetId: 't-agy',
      owner: OWNER,
      summary: 'before gen bump',
    });
    channel.updateTarget('task-r', 't-agy', OWNER, { bumpGeneration: true });
    await assert.rejects(
      () =>
        handoff.confirmHandoff(
          'h-gen',
          pGen.draft.previewDigest,
          pGen.draft.targetGeneration,
          OWNER,
          'k-gen',
        ),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'stale_revision',
    );
    assert.equal(handoff.getHandoff('h-gen')?.status, 'expired');

    // 4. Reject when targetCwd changed after preview
    const pCwd = await handoff.previewHandoff({
      handoffId: 'h-cwd',
      taskId: 'task-r',
      sourceTargetId: 't-codex',
      targetTargetId: 't-agy',
      owner: OWNER,
      summary: 'before cwd change',
    });
    const agyAltDir = join(workDir, 'agy-other');
    mkdirSync(agyAltDir, { recursive: true });
    currentAgyProject = agyAltDir;
    await assert.rejects(
      () =>
        handoff.confirmHandoff(
          'h-cwd',
          pCwd.draft.previewDigest,
          pCwd.draft.targetGeneration,
          OWNER,
          'k-cwd',
        ),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'cwd_mismatch',
    );
    assert.equal(handoff.getHandoff('h-cwd')?.status, 'expired');
    currentAgyProject = agyDir;

    // 5. Reject when artifact contentVersion changed after preview
    const pFile = await handoff.previewHandoff({
      handoffId: 'h-file',
      taskId: 'task-r',
      sourceTargetId: 't-codex',
      targetTargetId: 't-agy',
      owner: OWNER,
      summary: 'before file mutation',
      artifactRefs: [
        { artifactId: fileArtifact.artifactId, name: 'spec.txt', contentVersion: fileArtifact.contentVersion },
      ],
    });
    writeFileSync(filePath, 'version-2-mutated');
    fileArtifact = await registry.register(codexKey, filePath, 'text/plain');
    await assert.rejects(
      () =>
        handoff.confirmHandoff(
          'h-file',
          pFile.draft.previewDigest,
          pFile.draft.targetGeneration,
          OWNER,
          'k-file',
        ),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'stale_revision',
    );
    assert.equal(handoff.getHandoff('h-file')?.status, 'expired');
    assert.equal(submitCalls, 0);
  } finally {
    handoff.close();
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T2: submission timeout or unknown outcome marks status=unknown and NEVER resends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-timeout-unknown-'));
  const sCodex = makeSession('codex', 'ncx', '/work/cx');
  const sAgy = makeSession('agy', 'nagy', '/work/ag');
  const sessions = new Map<string, Session>([
    [sCodex.sessionId, sCodex],
    [sAgy.sessionId, sAgy],
  ]);

  let submitCalls = 0;
  let mode: 'hang' | 'throw' = 'hang';
  const service = {
    getSession: async (id: string) => sessions.get(id)!,
    listArtifacts: async () => ({ items: [], nextCursor: null }),
    readArtifact: async () => new Uint8Array(),
    submitInput: async () => {
      submitCalls++;
      if (mode === 'throw') throw new Error('network reset');
      return await new Promise<any>(() => {
        // intentionally never resolves to trigger submitTimeoutMs
      });
    },
  } as unknown as UnifiedService;

  const dbPath = join(dir, 'channel.sqlite');
  const channel = new TaskTopicChannel(
    service,
    { send: async () => 'm', update: async () => {}, sendFile: async () => {} },
    async (id) => id.subject === 'owner-1',
    dbPath,
  );
  const handoff = new TaskHandoffService(service, async (id) => id.subject === 'owner-1', dbPath, {
    submitTimeoutMs: 40,
  });

  try {
    channel.registerTask({
      taskId: 'task-u',
      destination: 'topic:task-u',
      rootGeneration: 1,
      owner: OWNER,
    });
    await channel.mountTarget({
      taskId: 'task-u',
      targetId: 't-codex',
      sessionId: sCodex.sessionId,
      native: sCodex.native,
      accessMode: 'interactive',
      owner: OWNER,
      makeActive: true,
    });
    await channel.mountTarget({
      taskId: 'task-u',
      targetId: 't-agy',
      sessionId: sAgy.sessionId,
      native: sAgy.native,
      accessMode: 'interactive',
      owner: OWNER,
    });

    // Case 1: Timeout -> unknown, never resent
    const p1 = await handoff.previewHandoff({
      handoffId: 'h-timeout',
      taskId: 'task-u',
      sourceTargetId: 't-codex',
      targetTargetId: 't-agy',
      owner: OWNER,
      summary: 'timeout test',
    });
    const r1 = await handoff.confirmHandoff(
      'h-timeout',
      p1.draft.previewDigest,
      p1.draft.targetGeneration,
      OWNER,
      'idem-timeout',
    );
    assert.equal(r1.status, 'unknown');
    assert.equal(handoff.getHandoff('h-timeout')?.status, 'unknown');
    assert.equal(submitCalls, 1);

    // Retry with same idempotencyKey returns unknown without resending!
    const r1Replay = await handoff.confirmHandoff(
      'h-timeout',
      p1.draft.previewDigest,
      p1.draft.targetGeneration,
      OWNER,
      'idem-timeout',
    );
    assert.equal(r1Replay.status, 'unknown');
    assert.equal(submitCalls, 1);

    // Retry with new idempotencyKey fails without resending!
    await assert.rejects(
      () =>
        handoff.confirmHandoff(
          'h-timeout',
          p1.draft.previewDigest,
          p1.draft.targetGeneration,
          OWNER,
          'idem-timeout-new',
        ),
      (e: unknown) => e instanceof TaskHandoffError && e.code === 'outcome_unknown',
    );
    assert.equal(submitCalls, 1);

    // Case 2: Transport throw -> unknown, never resent
    mode = 'throw';
    const p2 = await handoff.previewHandoff({
      handoffId: 'h-throw',
      taskId: 'task-u',
      sourceTargetId: 't-codex',
      targetTargetId: 't-agy',
      owner: OWNER,
      summary: 'throw test',
    });
    const r2 = await handoff.confirmHandoff(
      'h-throw',
      p2.draft.previewDigest,
      p2.draft.targetGeneration,
      OWNER,
      'idem-throw',
    );
    assert.equal(r2.status, 'unknown');
    assert.equal(handoff.getHandoff('h-throw')?.status, 'unknown');
    assert.equal(submitCalls, 2);

    const r2Replay = await handoff.confirmHandoff(
      'h-throw',
      p2.draft.previewDigest,
      p2.draft.targetGeneration,
      OWNER,
      'idem-throw',
    );
    assert.equal(r2Replay.status, 'unknown');
    assert.equal(submitCalls, 2);
  } finally {
    handoff.close();
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
