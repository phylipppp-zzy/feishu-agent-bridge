import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type * as Lark from '@larksuiteoapi/node-sdk';
import type { PlatformObservation, PlatformPort } from '../src/unified/adapter.js';
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
import { parseFeishuAction, toFeishuCard } from '../src/unified/feishu-codec.js';
import { questionForm, renderQuestionForm } from '../src/unified/feishu-question-forms.js';
import type { FeishuCallbackValues } from '../src/unified/feishu-callback-values.js';
import { FeishuSdkPort, handleSdkCardCallback, parseSdkCardCallback } from '../src/unified/feishu-sdk-port.js';
import {
  createIntegratedRuntime,
  createLiveRuntime,
  type RuntimeConfig,
  type RuntimeTrustedAction,
} from '../src/unified/runtime.js';
import { handoffPreviewCard } from '../src/unified/task-handoff.js';
import { taskInteractionCard, taskPanelCard, type TaskChannelAction } from '../src/unified/task-topic-channel.js';

const OWNER_ID = 'owner-wave2';
const OWNER = { source: 'feishu', subject: OWNER_ID };
const ALL_CAPS = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map(
    (k) => [k, { status: 'available' as const }],
  ),
) as Capabilities;

function makeMockSdkClient() {
  let msgSeq = 0;
  const created: Array<{ receive_id: string; msg_type: string; content: string }> = [];
  const replies: Array<{ message_id: string; msg_type: string; content: string; reply_in_thread?: boolean }> = [];
  const patches: Array<{ message_id: string; content: string }> = [];
  const sentCards = new Map<string, { destination?: string; content: string }>();

  const client = {
    request: async () => ({ bot: { open_id: 'bot-wave2' } }),
    im: {
      message: {
        create: async ({ data }: { data: { receive_id: string; msg_type: string; content: string } }) => {
          const message_id = `om_create_${++msgSeq}`;
          created.push(data);
          sentCards.set(message_id, { destination: data.receive_id, content: data.content });
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
          replies.push({ message_id: path.message_id, ...data });
          sentCards.set(message_id, { content: data.content });
          return { code: 0, data: { message_id } };
        },
        patch: async ({ path, data }: { path: { message_id: string }; data: { content: string } }) => {
          patches.push({ message_id: path.message_id, content: data.content });
          const prior = sentCards.get(path.message_id);
          sentCards.set(path.message_id, { ...(prior?.destination ? { destination: prior.destination } : {}), content: data.content });
          return { code: 0 };
        },
        get: async () => ({ code: 0, data: { items: [] } }),
      },
      messageResource: {
        get: async () => ({ getReadableStream: () => Readable.from([Buffer.from('hello task\n')]) }),
      },
      file: {
        create: async () => ({ file_key: 'fk_wave2' }),
      },
    },
  };

  return { client, created, replies, patches, sentCards };
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

function makeCardEvent(
  eventId: string,
  chatId: string,
  messageId: string,
  value: unknown,
  formValues?: Record<string, unknown>,
  openId = OWNER_ID,
): Lark.RawCardActionEvent {
  return {
    event_id: eventId,
    context: { open_chat_id: chatId, open_message_id: messageId },
    operator: { open_id: openId },
    action: {
      tag: 'button',
      value,
      ...(formValues ? { form_value: formValues } : {}),
    },
  } as unknown as Lark.RawCardActionEvent;
}

test('parseFeishuAction decodes Wave 2 card actions strictly and preserves legacy bindingId guard', () => {
  // 1. switch_target (directly and from taskPanelCard)
  const panel = taskPanelCard(
    {
      taskId: 'task-1',
      destination: 'topic:task-1',
      rootGeneration: 2,
      owner: OWNER,
      taskRevision: 3,
      activeTargetId: 't-claude',
      activeRevision: 4,
      state: 'active',
    },
    [
      {
        taskId: 'task-1',
        targetId: 't-claude',
        native: { provider: 'claude', hostId: 'h', serviceId: 'c', nativeSessionId: 'n1' },
        sessionId: 's-claude',
        targetGeneration: 1,
        accessMode: 'interactive',
        state: 'active',
      },
      {
        taskId: 'task-1',
        targetId: 't-agy',
        native: { provider: 'agy', hostId: 'h', serviceId: 'a', nativeSessionId: 'n2' },
        sessionId: 's-agy',
        targetGeneration: 1,
        accessMode: 'interactive',
        state: 'active',
      },
    ],
  );
  assert.deepEqual(parseFeishuAction<RuntimeTrustedAction>(panel.actions[0]!.value), {
    action: 'switch_target',
    taskId: 'task-1',
    rootGeneration: 2,
    activeRevision: 4,
    targetId: 't-agy',
  });
  for (const bad of [
    { action: 'switch_target', targetId: 't-agy' },
    { action: 'switch_target', taskId: '', rootGeneration: 1, activeRevision: 1, targetId: 't-agy' },
    { action: 'switch_target', taskId: 'task-1', rootGeneration: -1, activeRevision: 1, targetId: 't-agy' },
    { action: 'switch_target', taskId: 'task-1', rootGeneration: 1.5, activeRevision: 1, targetId: 't-agy' },
    { action: 'switch_target', taskId: 'task-1', rootGeneration: 1, activeRevision: '1', targetId: 't-agy' },
    { action: 'switch_target', taskId: 'task-1', rootGeneration: 1, activeRevision: 1, targetId: '   ' },
    { action: 'switch_target', taskId: 'task-1', rootGeneration: 1, activeRevision: 1, targetId: 't-agy', bindingId: '' },
  ]) {
    assert.throws(() => parseFeishuAction(bad), /invalid/);
  }

  // 2. confirm_handoff (from handoffPreviewCard)
  const preview = handoffPreviewCard(
    {
      handoffId: 'hoff-1',
      taskId: 'task-1',
      sourceTargetId: 't-codex',
      targetTargetId: 't-agy',
      targetSessionId: 's-agy',
      targetGeneration: 3,
      activeRevision: 5,
      targetCwd: '/work/proj',
      summary: 'summary',
      constraints: ['no rm'],
      artifactRefs: [],
      previewDigest: 'dig-abc',
      status: 'draft',
    },
    'codex',
    'agy',
  );
  assert.deepEqual(parseFeishuAction<RuntimeTrustedAction>(preview.actions[0]!.value), {
    action: 'confirm_handoff',
    handoffId: 'hoff-1',
    taskId: 'task-1',
    previewDigest: 'dig-abc',
    targetGeneration: 3,
    activeRevision: 5,
  });
  for (const bad of [
    { action: 'confirm_handoff', handoffId: 'h', taskId: 't', previewDigest: '', targetGeneration: 1, activeRevision: 1 },
    { action: 'confirm_handoff', handoffId: '', taskId: 't', previewDigest: 'd', targetGeneration: 1, activeRevision: 1 },
    { action: 'confirm_handoff', handoffId: 'h', taskId: 't', previewDigest: 'd', targetGeneration: -1, activeRevision: 1 },
    { action: 'confirm_handoff', handoffId: 'h', taskId: 't', previewDigest: 'd', targetGeneration: 1, activeRevision: '1' },
    { action: 'confirm_handoff', handoffId: 'h', previewDigest: 'd', targetGeneration: 1, activeRevision: 1 },
  ]) {
    assert.throws(() => parseFeishuAction(bad), /invalid/);
  }

  // 3. decision_answer
  assert.deepEqual(
    parseFeishuAction<RuntimeTrustedAction>({
      action: 'decision_answer',
      decisionId: 'DEC-1',
      expectedVersion: 1,
      expectedDigest: 'dig-1',
      selectedOptionId: 'opt-a',
      entry: 'hub',
      category: 'business_decision',
      bindingId: 'hub-bind-1',
    }),
    {
      action: 'decision_answer',
      decisionId: 'DEC-1',
      expectedVersion: 1,
      expectedDigest: 'dig-1',
      selectedOptionId: 'opt-a',
      entry: 'hub',
      category: 'business_decision',
      bindingId: 'hub-bind-1',
    },
  );
  assert.deepEqual(
    parseFeishuAction<RuntimeTrustedAction>({
      action: 'decision_answer',
      decisionId: 'DEC-2',
      expectedVersion: 2,
      expectedDigest: 'dig-2',
      selectedOptionId: null,
      freeText: 'approve with cap',
      rawUtterance: 'approve with cap',
      entry: 'pending_hub',
    }),
    {
      action: 'decision_answer',
      decisionId: 'DEC-2',
      expectedVersion: 2,
      expectedDigest: 'dig-2',
      selectedOptionId: null,
      freeText: 'approve with cap',
      rawUtterance: 'approve with cap',
      entry: 'pending_hub',
    },
  );
  for (const bad of [
    { action: 'decision_answer', decisionId: 'DEC-1', expectedVersion: 1, expectedDigest: 'dig-1' },
    { action: 'decision_answer', decisionId: 'DEC-1', expectedVersion: 1, expectedDigest: 'dig-1', selectedOptionId: null, freeText: '   ' },
    { action: 'decision_answer', decisionId: 'DEC-1', expectedVersion: 1, expectedDigest: 'dig-1', selectedOptionId: '' },
    { action: 'decision_answer', decisionId: '', expectedVersion: 1, expectedDigest: 'dig-1', selectedOptionId: 'a' },
    { action: 'decision_answer', decisionId: 'DEC-1', expectedVersion: -1, expectedDigest: 'dig-1', selectedOptionId: 'a' },
    { action: 'decision_answer', decisionId: 'DEC-1', expectedVersion: 1, expectedDigest: '', selectedOptionId: 'a' },
    { action: 'decision_answer', decisionId: 'DEC-1', expectedVersion: 1, expectedDigest: 'dig-1', selectedOptionId: 'a', entry: 'wrong' },
    { action: 'decision_answer', decisionId: 'DEC-1', expectedVersion: 1, expectedDigest: 'dig-1', selectedOptionId: 'a', category: 'approval' },
    { action: 'decision_answer', decisionId: 'DEC-1', expectedVersion: 1, expectedDigest: 'dig-1', freeText: 123 },
    { action: 'decision_answer', decisionId: 'DEC-1', expectedVersion: 1, expectedDigest: 'dig-1', selectedOptionId: 'a', rawUtterance: '' },
  ]) {
    assert.throws(() => parseFeishuAction(bad), /invalid/);
  }

  // 4. pending_page
  assert.deepEqual(parseFeishuAction<RuntimeTrustedAction>({ action: 'pending_page' }), {
    action: 'pending_page',
  });
  assert.deepEqual(
    parseFeishuAction<RuntimeTrustedAction>({
      action: 'pending_page',
      cursor: '5',
      category: 'execution_auth',
      provider: 'decision',
    }),
    {
      action: 'pending_page',
      cursor: '5',
      category: 'execution_auth',
      provider: 'decision',
    },
  );
  for (const bad of [
    { action: 'pending_page', cursor: '' },
    { action: 'pending_page', cursor: '   ' },
    { action: 'pending_page', cursor: 5 },
    { action: 'pending_page', category: 'unknown_cat' },
    { action: 'pending_page', provider: 'openai' },
  ]) {
    assert.throws(() => parseFeishuAction(bad), /invalid/);
  }

  // 5. PendingHub passthrough on answer & answer_form (entry: 'pending_hub' | 'hub' | 'source', sourceSessionId)
  assert.deepEqual(
    parseFeishuAction<RuntimeTrustedAction>({
      action: 'answer',
      entry: 'pending_hub',
      sourceSessionId: 'sess-agy-1',
      category: 'approval',
      interactionId: 'int-1',
      revision: 1,
      connectionGeneration: 2,
      answer: { kind: 'approval', decision: 'allow', scope: 'this_request' },
      toolInputDigest: 'dig-tool',
    }),
    {
      action: 'answer',
      entry: 'pending_hub',
      sourceSessionId: 'sess-agy-1',
      category: 'approval',
      interactionId: 'int-1',
      revision: 1,
      connectionGeneration: 2,
      answer: { kind: 'approval', decision: 'allow', scope: 'this_request' },
      toolInputDigest: 'dig-tool',
    },
  );

  assert.deepEqual(
    parseFeishuAction<RuntimeTrustedAction>(
      {
        action: 'answer_form',
        entry: 'pending_hub',
        sourceSessionId: 'sess-codex-1',
        category: 'question',
        interactionId: 'int-2',
        revision: 3,
        connectionGeneration: 1,
      },
      { q0_text: 'yes' },
    ),
    {
      action: 'answer_form',
      entry: 'pending_hub',
      sourceSessionId: 'sess-codex-1',
      category: 'question',
      interactionId: 'int-2',
      revision: 3,
      connectionGeneration: 1,
      fields: { q0_text: 'yes' },
    },
  );

  // Invalid PendingHub passthrough values throw cleanly
  assert.throws(
    () =>
      parseFeishuAction({
        action: 'answer',
        entry: 'bad_entry',
        interactionId: 'int-1',
        revision: 1,
        connectionGeneration: 1,
        answer: { kind: 'question', values: ['ok'] },
        toolInputDigest: null,
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      parseFeishuAction({
        action: 'answer',
        entry: 'pending_hub',
        sourceSessionId: '  ',
        interactionId: 'int-1',
        revision: 1,
        connectionGeneration: 1,
        answer: { kind: 'question', values: ['ok'] },
        toolInputDigest: null,
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      parseFeishuAction(
        {
          action: 'answer_form',
          entry: 'pending_hub',
          sourceSessionId: '',
          interactionId: 'int-2',
          revision: 1,
          connectionGeneration: 1,
        },
        { q0_text: 'yes' },
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      parseFeishuAction(
        {
          action: 'answer_form',
          entry: 'pending_hub',
          bindingId: '',
          interactionId: 'int-2',
          revision: 1,
          connectionGeneration: 1,
        },
        { q0_text: 'yes' },
      ),
    /invalid/,
  );

  // Legacy session-topic callbacks MUST still require bindingId
  assert.throws(
    () =>
      parseFeishuAction({
        action: 'answer',
        interactionId: 'int-1',
        revision: 1,
        connectionGeneration: 1,
        answer: { kind: 'question', values: ['yes'] },
        toolInputDigest: null,
      }),
    /missing binding identity/,
  );
  assert.throws(
    () =>
      parseFeishuAction({
        action: 'answer',
        sourceSessionId: 'sess-1',
        interactionId: 'int-1',
        revision: 1,
        connectionGeneration: 1,
        answer: { kind: 'question', values: ['yes'] },
        toolInputDigest: null,
      }),
    /missing binding identity/,
  );
  assert.throws(
    () =>
      parseFeishuAction(
        {
          action: 'answer_form',
          sourceSessionId: 'sess-1',
          interactionId: 'int-2',
          revision: 1,
          connectionGeneration: 1,
        },
        { q0_text: 'yes' },
      ),
    /invalid question form callback/,
  );
  assert.throws(() => parseFeishuAction({ action: 'stop', turnId: 't1', revision: 1, controlGeneration: 1 }), /missing binding identity/);
  assert.throws(() => parseFeishuAction({ action: 'panel' }), /missing binding identity/);

  // 6. TaskTopicChannel taskInteractionCard answer button
  const taskCard = taskInteractionCard(
    {
      taskId: 'task-1',
      destination: 'topic:task-1',
      rootGeneration: 1,
      owner: OWNER,
      taskRevision: 1,
      activeTargetId: 't-codex',
      activeRevision: 1,
      state: 'active',
    },
    {
      taskId: 'task-1',
      targetId: 't-claude',
      native: { provider: 'claude', hostId: 'h', serviceId: 'c', nativeSessionId: 'n1' },
      sessionId: 'sess-cl',
      targetGeneration: 2,
      accessMode: 'interactive',
      state: 'active',
    },
    {
      interactionId: 'int-cl',
      sessionId: 'sess-cl',
      turnId: 'turn-1',
      nativeRequestId: 'req-1',
      connectionGeneration: 3,
      revision: 4,
      status: 'awaiting_answer',
      expiresAt: null,
      toolInputDigest: 'dig-cmd',
      nativeResult: null,
      kind: 'approval',
      tool: 'bash',
      action: 'ls',
      scope: 'once',
    },
    7,
  );
  const parsedTaskAns = parseFeishuAction<TaskChannelAction>(taskCard.actions[0]!.value) as Extract<
    TaskChannelAction,
    { action: 'answer' }
  >;
  assert.equal(parsedTaskAns.action, 'answer');
  assert.equal(parsedTaskAns.taskId, 'task-1');
  assert.equal(parsedTaskAns.targetId, 't-claude');
  assert.equal(parsedTaskAns.targetGeneration, 2);
  assert.equal(parsedTaskAns.sessionId, 'sess-cl');
  assert.equal(parsedTaskAns.controlGeneration, 7);
});

test('FeishuSdkPort forwards task topic messages and callbacks when taskTopicRuntimeEnabled=true and preserves T0 placeholder when false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wave2-sdk-forward-'));
  try {
    // Part A: taskEnabled=true, taskTopicRuntimeEnabled=false -> T0 placeholder intercepts
    {
      const dbPath = join(dir, 'sdk-t0.sqlite');
      const sdk = new FeishuSdkPort({ appId: 'app', appSecret: 'sec' }, dbPath, new Set(['chat-main']), OWNER_ID, true, false);
      const mock = makeMockSdkClient();
      let handles!: Map<string, (data: any) => Promise<any>>;
      (sdk as any).client = mock.client;
      (sdk as any).ws = {
        start: async ({ eventDispatcher }: any) => {
          handles = eventDispatcher.handles;
        },
        close() {},
      };
      try {
        const token = await sdk.createTaskTopic('chat-main', 'task-t0', 'op-t0', OWNER_ID);
        const forwarded: Array<{ e: unknown; a: unknown }> = [];
        await sdk.start(
          async (e, a) => {
            forwarded.push({ e, a });
          },
          async () => 'scope',
        );

        await handles.get('im.message.receive_v1')!({
          sender: { sender_type: 'user', sender_id: { open_id: OWNER_ID } },
          message: {
            message_id: 'msg-t0-1',
            chat_id: 'chat-main',
            chat_type: 'p2p',
            message_type: 'text',
            root_id: token.rootId,
            content: JSON.stringify({ text: 'hello' }),
          },
        });
        await handles.get('card.action.trigger')!(
          makeCardEvent('cb-t0-1', 'chat-main', token.rootId, {
            action: 'switch_target',
            taskId: token.taskId,
            rootGeneration: token.generation,
            activeRevision: 1,
            targetId: 't-agy',
          }),
        );

        assert.equal(forwarded.length, 0);
        assert.equal(mock.replies.length, 2);
        assert.match(mock.replies[0]!.content, /任务目标功能尚未启用/);
      } finally {
        sdk.close();
      }
    }

    // Part B: taskEnabled=true, taskTopicRuntimeEnabled=true -> forwards verified messages and card callbacks to handle(e, a)
    {
      const dbPath = join(dir, 'sdk-w2.sqlite');
      const sdk = new FeishuSdkPort({ appId: 'app', appSecret: 'sec' }, dbPath, new Set(['chat-main']), OWNER_ID, true, true);
      const mock = makeMockSdkClient();
      let handles!: Map<string, (data: any) => Promise<any>>;
      (sdk as any).client = mock.client;
      (sdk as any).ws = {
        start: async ({ eventDispatcher }: any) => {
          handles = eventDispatcher.handles;
        },
        close() {},
      };
      try {
        const token = await sdk.createTaskTopic('chat-main', 'task-w2', 'op-w2', OWNER_ID);
        // Send a card into the task topic via sdk.send (must be authorized when taskTopicRuntimeEnabled=true)
        const cardMsgId = await sdk.send(
          token.destination,
          { title: '任务面板', text: '选择目标', actions: [] },
          'del-panel-1',
        );
        const forwarded: Array<{ e: any; a: any }> = [];
        await sdk.start(
          async (e, a) => {
            forwarded.push({ e, a });
          },
          async (e) => `task-scope:${e.destination}`,
        );

        // 1. Task topic text message forwards directly
        await handles.get('im.message.receive_v1')!({
          sender: { sender_type: 'user', sender_id: { open_id: OWNER_ID } },
          message: {
            message_id: 'msg-w2-1',
            chat_id: 'chat-main',
            chat_type: 'p2p',
            message_type: 'text',
            root_id: token.rootId,
            content: JSON.stringify({ text: '请开始执行' }),
          },
        });
        assert.equal(forwarded.length, 1);
        assert.equal(forwarded[0]!.e.destination, token.destination);
        assert.deepEqual(forwarded[0]!.a, { action: 'input', text: '请开始执行', mode: 'new' });

        // 2. Task topic card callback forwards switch_target directly (without T0 placeholder)
        const cbToast = await handles.get('card.action.trigger')!(
          makeCardEvent('cb-w2-switch', 'chat-main', cardMsgId, {
            action: 'switch_target',
            taskId: token.taskId,
            rootGeneration: token.generation,
            activeRevision: 1,
            targetId: 't-codex',
          }),
        );
        assert.deepEqual(cbToast, { toast: { type: 'success', content: '已确认' } });
        assert.equal(forwarded.length, 2);
        assert.equal(forwarded[1]!.e.destination, token.destination);
        assert.equal(forwarded[1]!.e.cardMessageId, cardMsgId);
        assert.deepEqual(forwarded[1]!.a, {
          action: 'switch_target',
          taskId: token.taskId,
          rootGeneration: token.generation,
          activeRevision: 1,
          targetId: 't-codex',
        });

        // 3. Malformed Wave 2 card payload returns safe guidance toast and never calls handle
        const badToast = await handles.get('card.action.trigger')!(
          makeCardEvent('cb-w2-bad', 'chat-main', cardMsgId, {
            action: 'switch_target',
            taskId: token.taskId,
          }),
        );
        assert.match(badToast.toast.content, /旧卡或卡片操作已失效/);
        assert.equal(forwarded.length, 2);

        // 4. Task topic attachment captures scope and drains via drainInbound without T0 placeholder
        await handles.get('im.message.receive_v1')!({
          sender: { sender_type: 'user', sender_id: { open_id: OWNER_ID } },
          message: {
            message_id: 'msg-w2-file',
            chat_id: 'chat-main',
            chat_type: 'p2p',
            message_type: 'file',
            root_id: token.rootId,
            content: JSON.stringify({ file_key: 'fk_in', file_name: 'notes.txt' }),
          },
        });
        const drained: Array<{ e: any; a: any; scope: string | undefined }> = [];
        await sdk.drainInbound(async (e, a, scope) => {
          drained.push({ e, a, scope });
        });
        assert.equal(drained.length, 1);
        assert.equal(drained[0]!.e.destination, token.destination);
        assert.equal(drained[0]!.scope, `task-scope:${token.destination}`);
        assert.equal(drained[0]!.a.action, 'attachment');
        // Still only the 1 reply from sdk.send; zero T0 placeholder replies!
        assert.equal(mock.replies.length, 1);

        // 5. Closing task topic immediately fails closed on card callbacks and sdk.send
        sdk.closeTaskTopic(token, OWNER_ID);
        const closedToast = await handles.get('card.action.trigger')!(
          makeCardEvent('cb-w2-closed', 'chat-main', cardMsgId, {
            action: 'switch_target',
            taskId: token.taskId,
            rootGeneration: token.generation,
            activeRevision: 1,
            targetId: 't-codex',
          }),
        );
        assert.match(closedToast.toast.content, /卡片已失效/);
        await assert.rejects(
          sdk.send(token.destination, { title: 'x', text: 'y', actions: [] }, 'del-after-close'),
          /unauthorized/,
        );
        assert.equal(forwarded.length, 2);
      } finally {
        sdk.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createLiveRuntime wires taskTopicRuntimeEnabled from config.taskTopic.enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wave2-live-wiring-'));
  try {
    const base = makeBaseIntegratedConfig(dir);

    // 1. taskTopic disabled -> sdk.taskTopicRuntimeEnabled === false
    const offDir = join(dir, 'off');
    mkdirSync(offDir, { recursive: true });
    const offCfg: RuntimeConfig = {
      ...base,
      coreDb: join(offDir, 'core.sqlite'),
      channelDb: join(offDir, 'channel.sqlite'),
      artifactStatePath: join(offDir, 'artifacts.json'),
      agy: { enabled: false, serviceId: 'svc-agy' },
      taskTopic: { enabled: false },
    };
    const offLive = await createLiveRuntime(offCfg, { appId: 'app', appSecret: 'sec' }, join(offDir, 'sdk.sqlite'));
    try {
      const offPort = (offLive.runtime as unknown as { port: FeishuSdkPort }).port;
      assert.equal((offPort as unknown as { taskTopicRuntimeEnabled: boolean }).taskTopicRuntimeEnabled, false);
    } finally {
      await offLive.close();
    }

    // 2. taskTopic enabled -> sdk.taskTopicRuntimeEnabled === true
    const onDir = join(dir, 'on');
    mkdirSync(onDir, { recursive: true });
    const onCfg: RuntimeConfig = {
      ...base,
      coreDb: join(onDir, 'core.sqlite'),
      channelDb: join(onDir, 'channel.sqlite'),
      artifactStatePath: join(onDir, 'artifacts.json'),
      agy: { enabled: false, serviceId: 'svc-agy' },
      taskTopic: { enabled: true },
    };
    const onLive = await createLiveRuntime(onCfg, { appId: 'app', appSecret: 'sec' }, join(onDir, 'sdk.sqlite'));
    try {
      const onPort = (onLive.runtime as unknown as { port: FeishuSdkPort }).port;
      assert.equal((onPort as unknown as { taskTopicRuntimeEnabled: boolean }).taskTopicRuntimeEnabled, true);
    } finally {
      await onLive.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end handleSdkCardCallback -> runtime.handleTrusted across switch_target, confirm_handoff, decision_answer, pending_page, and PendingHub answer/answer_form', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wave2-e2e-'));
  try {
    const base = makeBaseIntegratedConfig(dir);
    const project = join(dir, 'project');
    const syncDoc = join(dir, 'decisions.md');
    writeFileSync(syncDoc, `# Decisions\n${DECISION_SYNC_START}\n${DECISION_SYNC_END}\n`, 'utf8');

    const cfg: RuntimeConfig = {
      ...base,
      taskTopic: { enabled: true },
      pendingHub: { enabled: true, destination: 'chat-main' },
      decisionSync: { enabled: true, markdownPath: syncDoc },
    };

    const sdk = new FeishuSdkPort(
      { appId: 'app', appSecret: 'sec' },
      join(dir, 'sdk.sqlite'),
      new Set(['chat-main']),
      OWNER_ID,
      true,
      true,
    );
    const mock = makeMockSdkClient();
    (sdk as any).client = mock.client;

    const claude = makeFakeProvider('claude', 'host-1', 'svc-claude', project);
    const codex = makeFakeProvider('codex', 'host-1', 'svc-codex', project);
    const agy = makeFakeProvider('agy', 'host-1', 'svc-agy', project);
    const sClaude = claude.seed('cl-1');
    const sCodex = codex.seed('cx-1');
    const sAgy = agy.seed('ag-1');

    const runtime = await createIntegratedRuntime(cfg, sdk, [claude.port, codex.port, agy.port]);
    try {
      // Attach all 3 sessions interactively
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

      // Create task topic via FeishuSdkPort & register into TaskTopicChannel
      const taskToken = await sdk.createTaskTopic('chat-main', 'task-e2e', 'op-task-e2e', OWNER_ID);
      runtime.taskChannel!.registerFromToken(taskToken);
      await runtime.taskChannel!.mountTarget({
        taskId: taskToken.taskId,
        targetId: 't-claude',
        sessionId: sClaude.sessionId,
        native: sClaude.native,
        accessMode: 'interactive',
        owner: OWNER,
        makeActive: true,
      });
      await runtime.taskChannel!.mountTarget({
        taskId: taskToken.taskId,
        targetId: 't-codex',
        sessionId: sCodex.sessionId,
        native: sCodex.native,
        accessMode: 'interactive',
        owner: OWNER,
      });
      await runtime.taskChannel!.mountTarget({
        taskId: taskToken.taskId,
        targetId: 't-agy',
        sessionId: sAgy.sessionId,
        native: sAgy.native,
        accessMode: 'interactive',
        owner: OWNER,
      });

      const { callbackValues } = sdk as unknown as { callbackValues: FeishuCallbackValues };
      const expand = (messageId: string, value: Record<string, unknown>) =>
        callbackValues.resolve(messageId, value) as Record<string, unknown>;
      const invokeCallback = async (
        eventId: string,
        messageId: string,
        value: unknown,
        formValues?: Record<string, unknown>,
      ) => {
        let capturedResult: unknown;
        const callbackResult = await handleSdkCardCallback<RuntimeTrustedAction>(
          makeCardEvent(eventId, 'chat-main', messageId, value, formValues),
          OWNER_ID,
          new Set(['chat-main']),
          (c, m) => sdk.callbackDestination(c, m),
          async (e, a) => {
            capturedResult = await runtime.handleTrusted(e, a);
          },
          expand,
        );
        return { callbackResult, capturedResult };
      };

      // 1. End-to-end switch_target via handleSdkCardCallback -> runtime.handleTrusted
      await runtime.taskChannel!.handle(
        { eventId: 'cmd-panel', destination: taskToken.destination, identity: OWNER },
        { action: 'panel' },
      );
      const panelMsgId = [...mock.sentCards.entries()].findLast(([, v]) => v.content.includes('switch_target'))![0];
      const panelJson = JSON.parse(mock.sentCards.get(panelMsgId)!.content) as {
        elements: Array<{ actions?: Array<{ value: Record<string, unknown> }> }>;
      };
      const switchAgyBtn = panelJson.elements
        .flatMap((el) => el.actions ?? [])
        .find((a) => a.value.action === 'switch_target' && a.value.targetId === 't-agy')!.value;

      const switchRes = await invokeCallback('cb-switch-agy', panelMsgId, switchAgyBtn);
      assert.deepEqual(switchRes.callbackResult, { toast: { type: 'success', content: '已确认' } });
      await runtime.tick();
      assert.equal(runtime.taskChannel!.getBinding(taskToken.taskId)!.activeTargetId, 't-agy');

      // 1b. Non-active target interaction card inside TaskTopicChannel via handleSdkCardCallback -> runtime.handleTrusted
      const claudeApprovalDigest = payloadDigest({ cmd: 'echo task-cl' });
      claude.emit({
        type: 'interaction',
        ref: sClaude.native,
        interaction: {
          interactionId: 'int-e2e-task-cl',
          sessionId: sClaude.native.nativeSessionId,
          turnId: 'turn-cl-1',
          nativeRequestId: 'nr-cl-1',
          connectionGeneration: 1,
          revision: 1,
          status: 'awaiting_answer',
          expiresAt: null,
          toolInputDigest: claudeApprovalDigest,
          nativeResult: null,
          kind: 'approval',
          tool: 'bash',
          action: 'echo task-cl',
          scope: 'once',
        },
      });
      await new Promise((r) => setImmediate(r));
      await runtime.tick();
      const claudeTaskCard = runtime.taskChannel!.listInteractionCards().find(card => card.interactionId === 'int-e2e-task-cl')!;
      const claudeTaskBtn = JSON.parse(mock.sentCards.get(claudeTaskCard.messageId)!.content).elements[1].actions[0].value;
      assert.equal(Buffer.byteLength(JSON.stringify(claudeTaskBtn)) <= 256, true);
      assert.equal(expand(claudeTaskCard.messageId, claudeTaskBtn).interactionId, 'int-e2e-task-cl');
      const misplaced = await invokeCallback('cb-misplaced', panelMsgId, claudeTaskBtn);
      assert.match(misplaced.callbackResult!.toast.content, /旧卡或卡片操作已失效/);
      const claudeTaskRes = await invokeCallback('cb-task-cl-ans', claudeTaskCard.messageId, claudeTaskBtn);
      assert.equal(claudeTaskRes.callbackResult, undefined);
      await runtime.tick();
      assert.equal(claude.responds.length, 1);
      assert.equal(claude.responds[0]!.interactionId, 'int-e2e-task-cl');

      // 2. End-to-end confirm_handoff via handleSdkCardCallback -> runtime.handleTrusted
      const { draft } = await runtime.taskHandoff!.previewHandoff({
        handoffId: 'hoff-e2e',
        taskId: taskToken.taskId,
        sourceTargetId: 't-codex',
        targetTargetId: 't-agy',
        owner: OWNER,
        summary: '请 Antigravity 接续验收测试。',
        constraints: ['只读验证'],
      });
      const previewCardMsgId = await sdk.send(
        taskToken.destination,
        handoffPreviewCard(draft, 'codex', 'agy'),
        'del-preview-e2e',
      );
      const previewBtn = JSON.parse(mock.sentCards.get(previewCardMsgId)!.content).elements[1].actions[0].value;
      const handoffRes = await invokeCallback('cb-confirm-hoff', previewCardMsgId, previewBtn);
      assert.deepEqual(handoffRes.callbackResult, { toast: { type: 'success', content: '已确认' } });
      assert.equal((handoffRes.capturedResult as { status: string }).status, 'submitted');
      await runtime.tick();
      assert.equal(agy.inputs.length, 1);
      assert.match(agy.inputs[0]!.text, /请 Antigravity 接续验收测试/);

      // 3. End-to-end decision_answer + pending_page via handleSdkCardCallback -> runtime.handleTrusted
      // Create 6 pending decisions so PendingHub summary card paginates (limit=5)
      for (let i = 1; i <= 6; i++) {
        const isExecAuth = i % 2 === 0;
        runtime.decisionSync!.createDecision({
          decisionId: `DEC-E2E-${i}`,
          kind: isExecAuth ? 'execution_auth' : 'business_decision',
          title: `决定 #${i}`,
          prompt: `是否执行步骤 ${i}？`,
          options: [
            { id: 'yes', label: '同意' },
            { id: 'no', label: '暂缓' },
          ],
          ...(isExecAuth
            ? {
                executionSpec: {
                  actionDigest: `act-${i}`,
                  target: 'staging',
                  expiry: new Date(Date.now() + 3600_000).toISOString(),
                  executorId: 'exec-1',
                },
              }
            : {}),
          source: { system: 'planner', sessionId: sAgy.sessionId, destination: taskToken.destination },
        });
      }
      await runtime.tick();

      const pendingRoot = runtime.pendingHub!.getRoot()!;
      assert.equal(pendingRoot.state, 'active');

      // Locate decision card for DEC-E2E-1 inside PendingHub and answer via handleSdkCardCallback
      const dec1Ref = runtime.pendingHub!.getRef('decision:DEC-E2E-1')!;
      assert.ok(dec1Ref.hub_card_message_id);
      const dec1CardJson = JSON.parse(mock.sentCards.get(dec1Ref.hub_card_message_id)!.content);
      const dec1ApproveBtn = dec1CardJson.elements[1].actions[0].value;
      assert.equal(expand(dec1Ref.hub_card_message_id, dec1ApproveBtn).action, 'decision_answer');

      const decRes = await invokeCallback('cb-dec-1', dec1Ref.hub_card_message_id, dec1ApproveBtn);
      assert.deepEqual(decRes.callbackResult, { toast: { type: 'success', content: '已确认' } });
      assert.equal(runtime.decisionSync!.getDecision('DEC-E2E-1').status, 'answered');
      await runtime.tick();
      assert.match(readFileSync(syncDoc, 'utf8'), /DEC-E2E-1[\s\S]*已登记答复: yes/);

      // Summary card still has 5 remaining pending items; seed 1 more so page 2 exists (total=6 -> nextCursor='5')
      runtime.decisionSync!.createDecision({
        decisionId: 'DEC-E2E-7',
        kind: 'business_decision',
        title: '决定 #7',
        prompt: '补充决定',
        options: [{ id: 'ok', label: '确认' }],
        source: { system: 'planner' },
      });
      await runtime.tick();
      const summaryMsgId = [...mock.sentCards.entries()].findLast(([, v]) => v.content.includes('pending_page'))![0];
      const summaryJson = JSON.parse(mock.sentCards.get(summaryMsgId)!.content);
      const pageBtn = summaryJson.elements
        .flatMap((el: { actions?: Array<{ value: Record<string, unknown> }> }) => el.actions ?? [])
        .find((a: { value: Record<string, unknown> }) => a.value.action === 'pending_page')!.value;

      const patchesBeforePage = mock.patches.length;
      const pageRes = await invokeCallback('cb-pending-page', summaryMsgId, pageBtn);
      assert.equal(pageRes.callbackResult, undefined);
      const pageData = pageRes.capturedResult as { items: unknown[]; total: number; nextCursor: string | null };
      assert.equal(pageData.total, 6);
      assert.equal(pageData.items.length, 1);
      assert.equal(pageData.nextCursor, null);
      assert.equal(mock.patches.length, patchesBeforePage + 1);
      assert.equal(mock.patches[mock.patches.length - 1]!.message_id, summaryMsgId);
      assert.match(mock.patches[mock.patches.length - 1]!.content, /待处理汇总（共 6 项）/);
      const pageCard = JSON.parse(mock.patches[mock.patches.length - 1]!.content);
      assert.match(pageCard.elements[0].content, /决定 \\#7/);

      // pending_page without cardMessageId falls back to port.send
      const createdBeforeSend = mock.created.length;
      const repliesBeforeSend = mock.replies.length;
      const pageSendRes = (await runtime.handleTrusted(
        {
          eventId: 'cb-pending-page-nocard',
          destination: pendingRoot.topicDestination ?? 'chat-main',
          identity: OWNER,
        },
        { action: 'pending_page', cursor: '5' },
      )) as { items: unknown[]; total: number; nextCursor: string | null };
      assert.equal(pageSendRes.total, 6);
      assert.equal(pageSendRes.items.length, 1);
      assert.equal(mock.created.length + mock.replies.length, createdBeforeSend + repliesBeforeSend + 1);

      // 4. End-to-end PendingHub answer (entry: 'pending_hub', sourceSessionId, NO bindingId)
      const approvalDigest = payloadDigest({ cmd: 'git status' });
      const agyApproval: Interaction = {
        interactionId: 'int-e2e-approval',
        sessionId: sAgy.native.nativeSessionId,
        turnId: 'turn-ag-1',
        nativeRequestId: 'nr-ag-1',
        connectionGeneration: 1,
        revision: 1,
        status: 'awaiting_answer',
        expiresAt: null,
        toolInputDigest: approvalDigest,
        nativeResult: null,
        kind: 'approval',
        tool: 'run_command',
        action: 'git status',
        scope: 'this_request',
      };
      agy.emit({ type: 'interaction', ref: sAgy.native, interaction: agyApproval });
      await new Promise((r) => setImmediate(r));
      await runtime.tick();

      const appRef = runtime.pendingHub!.getRef('interaction:int-e2e-approval')!;
      assert.ok(appRef.hub_card_message_id);
      const hubAnswerRes = await invokeCallback('cb-hub-ans-pending-hub', appRef.hub_card_message_id, {
        action: 'answer',
        entry: 'pending_hub',
        sourceSessionId: sAgy.sessionId,
        category: 'approval',
        interactionId: 'int-e2e-approval',
        revision: 1,
        connectionGeneration: 1,
        answer: { kind: 'approval', decision: 'allow', scope: 'this_request' },
        toolInputDigest: approvalDigest,
      });
      assert.equal(hubAnswerRes.callbackResult, undefined);
      await runtime.flushInteractive();
      assert.equal(agy.responds.length, 1);
      assert.equal(runtime.pendingHub!.getRef('interaction:int-e2e-approval')?.card_active, 0);

      // 5. End-to-end PendingHub answer_form (real form card + entry: 'pending_hub' & sourceSessionId)
      const codexQuestion: Interaction = {
        interactionId: 'int-e2e-qform',
        sessionId: sCodex.native.nativeSessionId,
        turnId: 'turn-cx-1',
        nativeRequestId: 'nr-cx-1',
        connectionGeneration: 1,
        revision: 1,
        status: 'awaiting_answer',
        expiresAt: null,
        toolInputDigest: null,
        nativeResult: null,
        kind: 'question',
        prompt: '选择或输入验证策略',
        choices: ['快速回归', '全量测试'],
        multiple: true,
        allowFreeText: true,
      };
      codex.emit({ type: 'interaction', ref: sCodex.native, interaction: codexQuestion });
      await new Promise((r) => setImmediate(r));
      await runtime.tick();

      const qRef = runtime.pendingHub!.getRef('interaction:int-e2e-qform')!;
      assert.ok(qRef.hub_card_message_id);
      const qCardJson = JSON.parse(mock.sentCards.get(qRef.hub_card_message_id)!.content);
      const submitBtn = qCardJson.body.elements.find((element: {tag: string}) => element.tag === 'form').elements.find(
        (x: { form_action_type?: string }) => x.form_action_type === 'submit',
      );
      const hubSubmit = expand(qRef.hub_card_message_id, submitBtn.behaviors[0].value);
      assert.equal(hubSubmit.entry, 'hub');
      assert.equal(hubSubmit.sourceSessionId, sCodex.sessionId);
      assert.equal(hubSubmit.category, 'question');
      const hubFormRes = await invokeCallback(
        'cb-hub-form',
        qRef.hub_card_message_id,
        submitBtn.behaviors[0].value,
        { q0_multi: ['0', '1'] },
      );
      assert.equal(hubFormRes.callbackResult, undefined);
      await runtime.flushInteractive();
      assert.equal(codex.responds.length, 1);
      assert.deepEqual(codex.responds[0]!.answer, { kind: 'question', values: ['快速回归', '全量测试'] });

      // 6. Verify malformed payload through handleSdkCardCallback does NOT mutate state & returns guidance toast
      const badRes = await invokeCallback('cb-malformed-dec', dec1Ref.hub_card_message_id, {
        action: 'decision_answer',
        decisionId: 'DEC-E2E-2',
        expectedVersion: 'not-a-number',
        expectedDigest: 'x',
        selectedOptionId: 'yes',
      });
      assert.match(badRes.callbackResult!.toast.content, /旧卡或卡片操作已失效/);
      assert.equal(runtime.decisionSync!.getDecision('DEC-E2E-2').status, 'pending');

      // 7. Verify parseSdkCardCallback also preserves PendingHub fields without bindingId
      const parsedHubCard = parseSdkCardCallback<RuntimeTrustedAction>(
        makeCardEvent(
          'cb-parse-check',
          'chat-main',
          qRef.hub_card_message_id,
          {
            action: 'answer_form',
            entry: 'pending_hub',
            sourceSessionId: sCodex.sessionId,
            interactionId: 'int-e2e-qform',
            revision: 1,
            connectionGeneration: 1,
          },
          { q0_text: 'custom note' },
        ),
        OWNER_ID,
        (c, m) => sdk.callbackDestination(c, m),
      )!;
      assert.equal(parsedHubCard.action.action, 'answer_form');
      assert.equal((parsedHubCard.action as { entry?: string }).entry, 'pending_hub');
      assert.equal((parsedHubCard.action as { sourceSessionId?: string }).sourceSessionId, sCodex.sessionId);

      // 8. Regression: TaskTopicChannel.taskInteractionCard -> toFeishuCard -> renderQuestionForm -> handleSdkCardCallback -> runtime.handleTrusted
      const claudeQuestion: Interaction = {
        interactionId: 'int-e2e-task-qform',
        sessionId: sClaude.native.nativeSessionId,
        turnId: 'turn-cl-q1',
        nativeRequestId: 'nr-cl-q1',
        connectionGeneration: 1,
        revision: 1,
        status: 'awaiting_answer',
        expiresAt: null,
        toolInputDigest: null,
        nativeResult: null,
        kind: 'question',
        prompt: '请选择任务话题的构建目标',
        choices: ['debug', 'release'],
        multiple: false,
        allowFreeText: true,
      };
      // Also assert submitValueFields cannot overwrite core form metadata keys
      const safeRendered = renderQuestionForm(
        questionForm(claudeQuestion, 'bind-keep', false, Date.now(), {
          action: 'spoofed',
          bindingId: 'spoofed',
          interactionId: 'spoofed',
          revision: 999,
          connectionGeneration: 999,
          taskId: 'task-kept',
        }),
      ) as { body: { elements: Array<{ tag: string; elements: Array<{ form_action_type?: string; behaviors?: Array<{ value: Record<string, unknown> }> }> }> } };
      const safeSubmitVal = safeRendered.body.elements[0]!.elements.find((e) => e.form_action_type === 'submit')!.behaviors![0]!.value;
      assert.equal(safeSubmitVal.action, 'answer_form');
      assert.equal(safeSubmitVal.bindingId, 'bind-keep');
      assert.equal(safeSubmitVal.interactionId, 'int-e2e-task-qform');
      assert.equal(safeSubmitVal.revision, 1);
      assert.equal(safeSubmitVal.connectionGeneration, 1);
      assert.equal(safeSubmitVal.taskId, 'task-kept');

      claude.emit({ type: 'interaction', ref: sClaude.native, interaction: claudeQuestion });
      await new Promise((r) => setImmediate(r));
      await runtime.tick();

      const taskBindingNow = runtime.taskChannel!.getBinding(taskToken.taskId)!;
      const claudeTargetNow = runtime.taskChannel!.getTarget(taskToken.taskId, 't-claude')!;
      const taskQCard = taskInteractionCard(
        taskBindingNow,
        claudeTargetNow,
        {
          ...claudeQuestion,
          sessionId: sClaude.sessionId,
        },
        sClaude.control.generation,
      );
      const renderedTaskQCard = toFeishuCard(taskQCard) as {
        schema: string;
        body: { elements: Array<{ tag: string; elements: Array<{ form_action_type?: string; behaviors?: Array<{ value: Record<string, unknown> }> }> }> };
      };
      assert.equal(renderedTaskQCard.schema, '2.0');
      const taskQSubmitVal = renderedTaskQCard.body.elements.find(element => element.tag === 'form')!.elements.find((e) => e.form_action_type === 'submit')!.behaviors![0]!.value;
      assert.equal(taskQSubmitVal.taskId, taskToken.taskId);
      assert.equal(taskQSubmitVal.targetId, 't-claude');
      assert.equal(taskQSubmitVal.sessionId, sClaude.sessionId);

      // Find the real Card 2.0 sent by TaskTopicChannel.syncTask (with taskId + targetId + controlGeneration)
      const syncedTaskQ = runtime.taskChannel!.listInteractionCards().find(card => card.interactionId === 'int-e2e-task-qform')!;
      assert.ok(syncedTaskQ, 'expected TaskTopicChannel.syncTask to send Card 2.0 with task scope');
      const syncedTaskQJson = JSON.parse(mock.sentCards.get(syncedTaskQ.messageId)!.content) as {
        schema: string;
        body: { elements: Array<{ tag: string; elements: Array<{ form_action_type?: string; behaviors?: Array<{ value: Record<string, unknown> }> }> }> };
      };
      assert.equal(syncedTaskQJson.schema, '2.0');
      const syncedSubmitVal = syncedTaskQJson.body.elements.find(element => element.tag === 'form')!.elements.find((e) => e.form_action_type === 'submit')!.behaviors![0]!.value;
      assert.equal(expand(syncedTaskQ.messageId, syncedSubmitVal).taskId, taskToken.taskId);
      const taskQRes = await invokeCallback('cb-task-qform-e2e', syncedTaskQ.messageId, syncedSubmitVal, { q0_choice: '1' });
      assert.equal(taskQRes.callbackResult, undefined);
      await runtime.tick();
      assert.equal(claude.responds.length, 2);
      assert.equal(claude.responds[1]!.interactionId, 'int-e2e-task-qform');
      assert.deepEqual(claude.responds[1]!.answer, { kind: 'question', values: ['release'] });

      // 9. Regression: confirm_handoff rejects mismatched draft.taskId even when binding.taskId === action.taskId
      const taskToken2 = await sdk.createTaskTopic('chat-main', 'task-e2e-2', 'op-task-e2e-2', OWNER_ID);
      runtime.taskChannel!.registerFromToken(taskToken2);
      await runtime.taskChannel!.mountTarget({
        taskId: taskToken2.taskId,
        targetId: 't2-codex',
        sessionId: sCodex.sessionId,
        native: sCodex.native,
        accessMode: 'interactive',
        owner: OWNER,
        makeActive: true,
      });
      await runtime.taskChannel!.mountTarget({
        taskId: taskToken2.taskId,
        targetId: 't2-agy',
        sessionId: sAgy.sessionId,
        native: sAgy.native,
        accessMode: 'interactive',
        owner: OWNER,
      });
      const { draft: draftTask2 } = await runtime.taskHandoff!.previewHandoff({
        handoffId: 'hoff-task2',
        taskId: taskToken2.taskId,
        sourceTargetId: 't2-codex',
        targetTargetId: 't2-agy',
        owner: OWNER,
        summary: 'Task 2 handoff',
        constraints: [],
      });
      // Attempt to confirm task2's handoff from task1's destination with action.taskId === task1
      await assert.rejects(
        runtime.handleTrusted(
          { eventId: 'cb-hoff-wrong-task', destination: taskToken.destination, identity: OWNER },
          {
            action: 'confirm_handoff',
            handoffId: draftTask2.handoffId,
            taskId: taskToken.taskId,
            previewDigest: draftTask2.previewDigest,
            targetGeneration: draftTask2.targetGeneration,
            activeRevision: draftTask2.activeRevision,
          },
        ),
        /handoff task mismatch/,
      );
      assert.equal(runtime.taskHandoff!.getHandoff(draftTask2.handoffId)?.status, 'draft');

      // 10. Regression: task-topic resource_rejected with scope sends '附件未提交' guidance card instead of throwing invalid_request
      const resourceEnv = {
        eventId: 'msg-task-res-rej:rejected',
        destination: taskToken.destination,
        identity: OWNER,
      };
      const capturedScope = await runtime.captureResourceScope(resourceEnv);
      const repliesBeforeRej = mock.replies.length;
      await runtime.taskChannel!.intake(
        resourceEnv,
        { action: 'resource_rejected', reason: 'size' },
        capturedScope,
      );
      const drainedRej = (await runtime.taskChannel!.drain(resourceEnv.eventId)) as { status: string; reason: string };
      assert.deepEqual(drainedRej, { status: 'rejected', reason: 'size' });
      assert.equal(mock.replies.length, repliesBeforeRej + 1);
      assert.match(mock.replies[mock.replies.length - 1]!.content, /附件未提交/);
      assert.match(mock.replies[mock.replies.length - 1]!.content, /文本附件为空或超过 1 MiB/);
    } finally {
      await runtime.close();
      sdk.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
