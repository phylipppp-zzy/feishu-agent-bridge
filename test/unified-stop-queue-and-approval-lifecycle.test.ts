import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { AgyAdapter } from '../src/unified/agy-adapter.js';
import { AgyCatalog } from '../src/unified/agy-catalog.js';
import { AgyAcpTransport } from '../src/unified/agy-transport.js';
import { formatApprovalAction } from '../src/unified/card-formatters.js';
import { canTransitionOperation, DECLINED_ANSWER_MARKER, type Interaction, type Operation, type Session } from '../src/unified/contracts.js';
import { interactionCard, type ChannelCard } from '../src/unified/feishu-cards.js';
import { FeishuChannel, type ChannelAction, type FeishuPort } from '../src/unified/feishu-channel.js';
import { parseFeishuAction, parseFeishuText } from '../src/unified/feishu-codec.js';
import { UnifiedRuntime } from '../src/unified/runtime.js';
import { UnifiedCore } from '../src/unified/service.js';
import { StoreError, UnifiedStore } from '../src/unified/store.js';
import { TaskTopicChannel, type TaskChannelAction } from '../src/unified/task-topic-channel.js';
import { ClaudeAdapter } from '../src/unified/claude-adapter.js';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import { CodexTransport, type SocketFactory } from '../src/unified/codex-transport.js';
import { validateWire } from '../src/unified/validation.js';

const runFile = promisify(execFile);
function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return {wait,release};
}

const command = [
  "python3 -c '", 'import json', 'from pathlib import Path', 'root = Path.cwd()',
  'data = {"root": str(root)}', 'encoded = json.dumps(data)', 'decoded = json.loads(encoded)',
  'print(decoded)', "'",
].join('\n');

// Fixture at the native process boundary. Prompt completion and tool updates are
// deliberately independent of answers, so premature dispatch and stuck approvals are observable.
const acp = `#!/usr/bin/env node
import { createReadStream, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = message => writeSync(1, JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const sessionId = 'contract-session';
let prompt;
let prompts = 0;
let cancels = 0;
let holdCancel = false;
const responses = [];
const finish = stopReason => { send({ id: prompt, result: { stopReason } }); prompt = undefined; };
const input = createReadStream(undefined, { fd: 0, autoClose: false });
createInterface({ input, crlfDelay: Infinity }).on('line', line => {
  const { id, method, params, result } = JSON.parse(line);
  const reply = result => send({ id, result });
  switch (method) {
    case 'initialize': reply({ protocolVersion: 1, agentCapabilities: { loadSession: true },
      agentInfo: { name: 'contract-fixture', version: '1' } }); break;
    case 'session/new': reply({ sessionId }); break;
    case 'session/prompt': prompt = id; prompts++; break;
    case 'session/cancel': cancels++; if (!holdCancel && prompt !== undefined) finish('cancelled'); break;
    case 'test/hold-cancel': holdCancel = true; reply({}); break;
    case 'test/fail-prompt':
      send({ id:prompt, error:{code:-32602,message:'Invalid ACP prompt params'} });
      prompt = undefined;
      reply({});
      break;
    case 'session/close': reply({}); break;
    case 'test/finish': finish(params.stopReason); reply({}); break;
    case 'test/counts': reply({ prompts, cancels, responses }); break;
    case 'test/approval':
      send({ id: params.id, method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId: params.toolCallId ?? params.id, title: 'Run command', kind: 'execute',
          rawInput: { CommandLine: ${JSON.stringify(command)} } },
        options: [{ kind: 'allow_once', optionId: 'allow_once' }, { kind: 'reject_once', optionId: 'reject_once' }],
      } });
      reply({});
      break;
    case 'test/question':
      send({ id: params.id ?? 'question', method: 'elicitation/create', params: {
        sessionId, message: 'Choose env', toolCallId: params.toolCallId, requestedSchema: params.single ? {} : {
          type: 'object', properties: { env: { type: 'string', enum: ['prod', 'staging'] } }, required: ['env'],
        },
      } });
      reply({});
      break;
    case 'test/terminal-burst':
      for (let index = 0; index < params.count; index++) {
        send({ method:'session/update', params:{sessionId,update:{
          sessionUpdate:'tool_call_update',toolCallId:'batch-' + index,status:'completed',kind:'execute',
        }} });
      }
      reply({});
      break;
    case 'test/tool':
      send({ method: 'session/update', params: { sessionId, update: {
        sessionUpdate: params.kind ?? 'tool_call_update', toolCallId: params.id, status: params.status, kind: 'execute',
      } } });
      reply({});
      break;
    case undefined: responses.push({ id, result }); break;
    default: send({ id, error: { code: -32601, message: method } });
  }
});
`;

async function until<T>(read: () => T | undefined, description: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read();
    if (value !== undefined) return value;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function fixture(t: TestContext, timeouts: {promptMaxTimeoutMs?:number; promptIdleTimeoutMs?:number; wakeupIdleMs?:number} = {}, useRuntime = false) {
  const root = await mkdtemp(join(tmpdir(), 'stop-approval-contract-'));
  const bin = join(root, 'acp.mjs');
  await writeFile(bin, acp, { mode: 0o700 });
  const transport = new AgyAcpTransport({ agyBin: bin, requestTimeoutMs: 3000 });
  const catalog = new AgyCatalog({ dbPath: join(root, 'missing.db'), brainDir: root, allowedProjectRoots: [root] });
  const adapter = new AgyAdapter(transport, catalog, 'test-host', 'agy-svc', undefined, {
    idleReleaseMs: 0, ...timeouts,
  });
  const corePath = join(root, 'core.sqlite');
  const cards: ChannelCard[] = [];
  const port: FeishuPort = {
    async send(_destination, card) { cards.push(card); return `msg-${cards.length}`; },
    async update(_destination, _messageId, card) { cards.push(card); },
    async sendFile() {},
  };
  const channelDb = join(root,'channel.sqlite');
  const runtime = useRuntime ? new UnifiedRuntime({
    coreDb:corePath,channelDb,ownerOpenId:'owner',allowedDestinations:['chat'],
    hostId:'test-host',claudeServiceId:'claude',codexServiceId:'codex',
    claudeStateDir:root,codexEndpoint:'ws://127.0.0.1:1',intervalMs:100,
    allowedProjectRoots:[root],taskTopic:{enabled:true},
  },port,[adapter]) : null;
  const store = runtime?.store ?? new UnifiedStore(corePath);
  const core = runtime?.core ?? new UnifiedCore(store,[adapter],() => true);
  const channel = runtime?.channel ?? new FeishuChannel(core,port,async () => true,channelDb);
  t.after(async () => {
    if (runtime) await runtime.close();
    else {
      channel.close();
      core.close();
      store.close();
    }
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  });

  await transport.connect();
  const { createdSession, connectionGeneration } = await adapter.create(root, null);
  assert.ok(createdSession && connectionGeneration);
  const { sessionId } = createdSession;
  store.insertSession(createdSession);
  store.setConnectionGeneration(sessionId, 0, connectionGeneration);

  let event = 0;
  const act = (action: ChannelAction) => channel.handle({
    eventId: `event-${++event}`, destination: 'chat', identity: { source: 'feishu', subject: 'owner' },
  }, action);
  const send = (text: string) => act(parseFeishuText(text));
  const attach = await act({ action: 'bind', sessionId, mode: 'interactive' }) as Operation;
  await act({ action: 'finish', operationId: attach.operationId });

  const session = () => store.getSession(sessionId);
  const snapshot = () => store.snapshot(sessionId).value;
  const running = () => snapshot().turns.find(turn => turn.status === 'running');
  const start = async () => {
    const op = await send('Start a turn') as Operation;
    assert.equal((await core.dispatch(op.operationId)).status, 'accepted');
    return until(running, 'running turn');
  };
  const click = (card: ChannelCard, label: string) => {
    const button = card.actions.find(action => action.label === label);
    assert.ok(button, `Missing button ${label}`);
    return act(parseFeishuAction(button.value));
  };
  const approval = async (id: string) => {
    await transport.request('test/approval', { id });
    const interaction = await until(() => snapshot().interactions.find(item =>
      item.nativeRequestId === JSON.stringify(id) && item.kind === 'approval'), 'approval');
    await channel.sync('chat');
    const card = cards.findLast(item => item.title.startsWith('⚠️ 需人工确认'));
    assert.ok(card);
    return { interaction, card };
  };
  const refresh = async (interaction: Interaction) => {
    await channel.refreshInteraction('chat', sessionId, interaction.interactionId);
    return cards.at(-1)!;
  };
  const counts = () => transport.request('test/counts', {});
  return { root, corePath, core, store, transport, adapter, channel, runtime, port, cards, sessionId, session, snapshot, start, act, send, click, approval, refresh, counts };
}

test('/stop cancels queued inputs before ACP cancellation and settles the stop outbox', async t => {
  const f = await fixture(t);
  const turn = await f.start();
  const queued = await f.send('Do not start this') as Operation;
  assert.deepEqual(f.store.queuedInputs(f.sessionId), [{ inputId: queued.operationId }]);
  await f.core.dispatchPending();
  assert.equal(f.store.getOutbox(queued.operationId).state, 'pending');

  const stop = await f.send('/stop') as Operation;
  assert.equal(f.store.getOutbox(stop.operationId).state, 'pending');
  assert.equal(f.store.getOutbox(queued.operationId).state, 'cancelled');
  assert.deepEqual(f.store.queuedInputs(f.sessionId), []);
  await f.core.dispatchPending();
  await until(() => f.snapshot().turns.find(item => item.turnId === turn.turnId &&
    item.status === 'interrupted'), 'interrupted turn');
  await f.core.dispatchPending();

  assert.equal(f.store.getOperation(stop.operationId).status, 'completed');
  assert.equal(f.store.getOutbox(stop.operationId).state, 'done');
  assert.deepEqual(await f.counts(), { prompts: 1, cancels: 1, responses: [] });
  await f.start();
  assert.deepEqual(await f.counts(), { prompts: 2, cancels: 1, responses: [] });
});

test('panel stop follows a finished target to the sole current turn in the same control generation', async t => {
  const f = await fixture(t);
  const first = await f.start();
  await f.send('/panel');
  const panel = f.cards.at(-1)!;
  await f.transport.request('test/finish', { stopReason: 'end_turn' });
  await until(() => f.session().status === 'idle' ? true : undefined, 'idle session');
  const active = await f.start();
  assert.notEqual(active.turnId, first.turnId);

  const stop = await f.click(panel, '中断当前回复') as Operation;
  await f.core.dispatch(stop.operationId);
  await until(() => f.store.getOutbox(stop.operationId).state === 'done' ? true : undefined, 'settled stop');
  assert.equal((await f.core.getTurn(f.sessionId, active.turnId))?.status, 'interrupted');
  assert.equal((await f.core.getTurn(f.sessionId, first.turnId))?.status, 'completed');
});

test('core startup settles legacy in-flight and unknown stops against a persisted terminal turn', async t => {
  const f = await fixture(t);
  await f.start();
  const claimed = await f.send('/stop') as Operation;
  const unknown = await f.send('/stop') as Operation;
  assert.ok(f.store.claimOutbox(claimed.operationId));
  assert.ok(f.store.claimOutbox(unknown.operationId));
  const lostReceipt = f.store.markDeliveryUnknown(unknown.operationId);
  await f.transport.request('test/finish', { stopReason: 'cancelled' });
  await until(() => f.session().status === 'interrupted' ? true : undefined, 'interrupted turn');

  // Reproduce the records the previous version left behind even after saving the terminal turn.
  const db = new DatabaseSync(f.corePath);
  try {
    for (const [operation, state] of [[claimed, 'in_flight'], [lostReceipt, 'unknown']] as const) {
      db.prepare('UPDATE operations SET value=? WHERE id=?').run(JSON.stringify(operation),operation.operationId);
      db.prepare('UPDATE outbox SET state=? WHERE operation_id=?').run(state,operation.operationId);
    }
  } finally {
    db.close();
  }
  const reopened = new UnifiedStore(f.corePath);
  const restarted = new UnifiedCore(reopened, [], () => true);
  try {
    for (const operation of [claimed, unknown]) {
      assert.equal(reopened.getOperation(operation.operationId).status, 'completed');
      assert.equal(reopened.getOutbox(operation.operationId).state, 'done');
    }
  } finally {
    restarted.close();
    reopened.close();
  }
});

test('waiting approval auto-queues ordinary input and a stale panel can cancel the owned input and release control', async t => {
  const f = await fixture(t);
  await f.start();
  const { card } = await f.approval('approve-to-deny');
  assert.equal(f.session().status, 'waiting_approval');
  const queued = await f.send('Queue while approval is open') as Operation;
  await f.core.dispatchPending();
  assert.deepEqual(f.store.queuedInputs(f.sessionId), [{ inputId: queued.operationId }]);
  await f.send('/panel');
  const panel = f.cards.at(-1)!;
  const revision = f.session().revision;
  const deny = await f.click(card, '拒绝') as Operation;
  assert.equal((await f.core.dispatch(deny.operationId)).status, 'completed');
  assert.ok(f.session().revision > revision);
  assert.equal(f.session().status, 'running');

  const cancel = panel.actions.find(action => action.value.action === 'cancel');
  assert.ok(cancel);
  assert.equal((await f.click(panel, cancel.label) as Operation).status, 'completed');
  const release = panel.actions.find(action => action.value.action === 'control' && action.value.release);
  assert.ok(release);
  await f.transport.request('test/finish', { stopReason: 'end_turn' });
  await until(() => f.session().status === 'idle' ? true : undefined, 'idle before release');
  const released = await f.click(panel, release.label) as Operation;
  assert.equal((await f.core.dispatch(released.operationId)).status, 'completed');
  assert.equal(f.session().control.input, 'unavailable');
});

test('waiting elicitation auto-queues input and a clean answer resolves without tool execution', async t => {
  const f = await fixture(t);
  await f.start();
  await f.transport.request('test/question', {});
  const question = await until(() => f.snapshot().interactions.find(item => item.kind === 'question_group'), 'question');
  assert.equal(f.session().status, 'waiting_question');
  const queued = await f.send('Queue while question is open') as Operation;
  await f.core.dispatchPending();
  assert.deepEqual(f.store.queuedInputs(f.sessionId), [{ inputId: queued.operationId }]);

  const answer = await f.act({ action: 'answer', interactionId: question.interactionId, revision: question.revision,
    connectionGeneration: question.connectionGeneration, toolInputDigest: null,
    answer: { kind: 'question_group', answers: { env: ['prod'] } },
  }) as Operation;
  assert.equal((await f.core.dispatch(answer.operationId)).status, 'completed');
  assert.equal(f.store.getInteraction(question.interactionId).status, 'resolved');
  assert.deepEqual(await f.counts(), { prompts: 1, cancels: 0,
    responses: [{ id: 'question', result: { action: 'accept', content: { env: 'prod' } } }],
  });
});

test('failed tools expire both unanswered approvals and allow responses waiting for execution', async t => {
  const f = await fixture(t);
  await f.start();
  const unanswered = await f.approval('failed-before-click');
  await f.transport.request('test/tool', { id: 'failed-before-click', status: 'failed' });
  assert.equal(f.store.getInteraction(unanswered.interaction.interactionId).status, 'expired');
  assert.deepEqual(await f.click(unanswered.card, '允许本次'), { status: 'rejected', reason: 'stale_revision' });
  const expired = await f.refresh(unanswered.interaction);
  assert.equal(expired.title, '审批 · 已过期');
  assert.deepEqual(expired.actions, []);
  assert.match(expired.text, /python3 -c ' import json .*'（9 行）/u);

  const allowed = await f.approval('failed-after-allow');
  const allow = await f.click(allowed.card, '允许本次') as Operation;
  assert.equal((await f.core.dispatch(allow.operationId)).status, 'accepted');
  assert.equal((await f.refresh(allowed.interaction)).title, '审批 · 等待原端确认');
  await f.transport.request('test/tool', { id: 'failed-after-allow', status: 'failed' });
  assert.equal(f.store.getInteraction(allowed.interaction.interactionId).status, 'expired');
  assert.equal((await f.refresh(allowed.interaction)).title, '审批 · 已过期');

  const denied = await f.approval('denied');
  const deny = await f.click(denied.card, '拒绝') as Operation;
  assert.equal((await f.core.dispatch(deny.operationId)).status, 'completed');
  assert.equal(f.store.getInteraction(denied.interaction.interactionId).status, 'resolved');
  assert.equal((await f.refresh(denied.interaction)).title, '审批 · 已拒绝');
});

test('multiline approval preview preserves both ends of the shell command and the line count', () => {
  const detail = JSON.stringify({ rawInput: { CommandLine: command } });
  const view = formatApprovalAction('execute', detail, 'this_request');
  assert.match(view.compactTarget, /^python3 -c ' import json .*'（9 行）$/u);
  assert.ok([...view.compactTarget].length <= 80);
  assert.ok(view.text.includes(command));
});

test('an ACP prompt timeout and a compacted legacy disconnect both keep stop outcome unknown', async t => {
  const f = await fixture(t, {promptMaxTimeoutMs: 1200});
  const turn = await f.start();
  const claimed = await f.send('/stop') as Operation;
  const lost = await f.send('/stop') as Operation;
  const pending = await f.send('/stop') as Operation;
  assert.ok(f.store.claimOutbox(claimed.operationId));
  assert.ok(f.store.claimOutbox(lost.operationId));
  f.store.markDeliveryUnknown(lost.operationId);
  await until(() => f.snapshot().turns.find(item => item.turnId === turn.turnId && item.status === 'failed'), 'local timeout');

  const events = f.store.subscribeEvents(f.sessionId,f.store.initialCursor(f.sessionId),100);
  assert.equal(events.status, 'events');
  const failure = events.events.find(event => event.type === 'adapter.stream_failed' && event.objectId === turn.turnId);
  assert.ok(failure);
  assert.equal((failure.data as {outcomeUnknown?:boolean}).outcomeUnknown,true);
  for (const op of [claimed,lost,pending]) {
    assert.equal(f.store.getOperation(op.operationId).status,'unknown');
    assert.equal(f.store.getOutbox(op.operationId).state,'unknown');
  }

  f.store.compactEvents(f.sessionId,events.cursor);
  const db = new DatabaseSync(f.corePath);
  try {
    const legacy = {...failure,data:{reason:'connection closed'}};
    assert.equal(db.prepare('UPDATE event_keys SET value=? WHERE event_id=?')
      .run(JSON.stringify(legacy),failure.eventId).changes,1);
    db.prepare('UPDATE operations SET value=? WHERE id=?').run(JSON.stringify(claimed),claimed.operationId);
    db.prepare("UPDATE outbox SET state='in_flight' WHERE operation_id=?").run(claimed.operationId);
  } finally { db.close(); }
  const reopened = new UnifiedStore(f.corePath);
  const restarted = new UnifiedCore(reopened,[],() => true);
  try {
    for (const op of [claimed,lost,pending]) {
      assert.equal(reopened.getOperation(op.operationId).error?.code,'outcome_unknown');
      assert.equal(reopened.getOutbox(op.operationId).state,'unknown');
    }
  } finally {
    restarted.close();
    reopened.close();
  }
});

test('explicit panel and turn-card stops stay scoped to the selected turn', async t => {
  const f = await fixture(t);
  const first = await f.start();
  await f.send('/panel');
  const original = f.cards.at(-1)!.actions.find(action => action.value.action === 'stop')!.value;
  assert.equal(original.fallbackCurrent,true);
  assert.throws(() => parseFeishuAction({...original,fallbackCurrent:'true'}),/invalid/);
  const {fallbackCurrent, ...turnCard} = original;
  assert.equal(fallbackCurrent,true);

  f.store.observeTurn({...first,turnId:'other-turn'});
  await f.send('/panel');
  const panel = f.cards.at(-1)!;
  const stops = panel.actions.filter(action => action.value.action === 'stop');
  assert.equal(stops.length,2);
  assert.ok(stops.every(action => !Object.hasOwn(action.value,'fallbackCurrent')));
  await f.transport.request('test/finish',{stopReason:'end_turn'});
  await until(() => f.snapshot().turns.find(turn => turn.turnId === first.turnId && turn.status === 'completed'), 'first turn completed');
  assert.throws(() => parseFeishuAction({...original,lockTurn:'true'}),/invalid/);
  for (const value of [stops[0]!.value,turnCard,{...original,lockTurn:true}]) {
    assert.deepEqual(await f.act(parseFeishuAction(value)),{status:'already_finished',turnStatus:'completed'});
  }
  assert.equal((await f.core.getTurn(f.sessionId,'other-turn'))?.status,'running');
  assert.equal(f.store.pendingOutbox(f.sessionId,'interruptTurn').length,0);
});

for (const label of ['允许本次','拒绝']) {
  test(`failed tool during the ${label} write settles exactly once`, async t => {
    const f = await fixture(t);
    await f.start();
    const {card,interaction} = await f.approval('writing-tool');
    const op = await f.click(card,label) as Operation;
    const cursor = f.store.snapshot(f.sessionId).cursor;
    const write = f.transport.respondServerRequest.bind(f.transport);
    let acknowledge!: () => void;
    let release!: () => void;
    const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.transport.respondServerRequest = async (...args) => {
      await write(...args);
      acknowledge();
      await held;
    };
    const dispatched = f.core.dispatch(op.operationId);
    try {
      await Promise.race([acknowledged,dispatched.then(() => assert.fail('response did not reach ACP'))]);
      await f.transport.request('test/tool',{id:'writing-tool',status:'failed'});
      assert.equal(f.store.getInteraction(interaction.interactionId).status,'answer_pending_delivery');
      assert.equal(f.store.getOutbox(op.operationId).state,'in_flight');
    } finally {
      release();
      f.transport.respondServerRequest = write;
      await dispatched;
    }
    await until(() => f.store.getInteraction(interaction.interactionId).status === 'expired' ? true : undefined,'terminal interaction');
    assert.equal(f.store.getOperation(op.operationId).status,'accepted');
    assert.equal(f.store.getOutbox(op.operationId).state,'done');
    const events = f.store.subscribeEvents(f.sessionId,cursor,100);
    assert.equal(events.status,'events');
    assert.deepEqual(events.events.filter(event => event.objectId === interaction.interactionId)
      .map(event => (event.data as Interaction).status),['expired']);
  });
}

test('late tool updates and a new permission RPC cannot reopen a terminal toolCallId', async t => {
  const f = await fixture(t);
  await f.start();
  const {interaction} = await f.approval('terminal-tool');
  await f.transport.request('test/tool',{id:'terminal-tool',status:'failed'});
  assert.equal(f.store.getInteraction(interaction.interactionId).status,'expired');
  for (const kind of ['tool_call_update','tool_call']) {
    await f.transport.request('test/tool',{id:'terminal-tool',kind,status:'in_progress'});
  }
  await f.transport.request('test/approval',{id:'late-permission',toolCallId:'terminal-tool'});
  assert.deepEqual((await f.counts() as {responses:unknown[]}).responses,[
    {id:'terminal-tool',result:{outcome:{outcome:'cancelled'}}},
    {id:'late-permission',result:{outcome:{outcome:'cancelled'}}},
  ]);
  assert.deepEqual(f.snapshot().interactions.map(item => item.status),['expired']);
});

test('tool completion confirms an approval when the tool was already running before the answer', async t => {
  const f = await fixture(t);
  await f.start();
  await f.transport.request('test/tool', { id: 'already-running', status: 'in_progress', kind: 'tool_call' });
  const { card, interaction } = await f.approval('already-running');
  const op = await f.click(card, '允许本次') as Operation;
  assert.equal((await f.core.dispatch(op.operationId)).status, 'accepted');
  assert.equal(f.store.getInteraction(interaction.interactionId).status, 'answer_pending_delivery');
  await f.transport.request('test/tool', { id: 'already-running', status: 'completed' });
  const resolved = f.store.getInteraction(interaction.interactionId);
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(resolved.nativeResult, {
    status: 'accepted', source: 'agy_tool_execution',
    answer: { kind: 'approval', decision: 'allow', scope: 'this_request' },
  });
  assert.equal(f.store.getOperation(op.operationId).status, 'completed');
});

for (const terminalEvidence of ['recent tool cache', 'active turn tool status', 'missing turn'] as const) {
  test(`approval submission cancels the ACP request when fenced by ${terminalEvidence}`, async t => {
    const f = await fixture(t);
    await f.start();
    const { card, interaction } = await f.approval('stale-tool');
    const op = await f.click(card, '允许本次') as Operation;
    const nativeId = f.session().native.nativeSessionId;
    // Model terminal evidence retained independently of the still-open request.
    const turns = f.adapter['activeTurns'];
    if (terminalEvidence === 'recent tool cache') f.adapter['ctx'].recentTerminalTools!.set(nativeId, new Set(['stale-tool']));
    else if (terminalEvidence === 'active turn tool status') turns.get(nativeId)!.toolCalls.set('stale-tool', { status: 'completed' });
    else turns.delete(nativeId);

    assert.equal(f.transport.health().pendingServerRequests, 1);
    const result = await f.core.dispatch(op.operationId);
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'interaction_expired');
    assert.equal(f.store.getInteraction(interaction.interactionId).status, 'expired');
    assert.equal(f.transport.health().pendingServerRequests, 0);
    assert.deepEqual((await f.counts() as { responses: unknown[] }).responses, [
      { id: 'stale-tool', result: { outcome: { outcome: 'cancelled' } } },
    ]);
  });
}

test('elicitation linked to a completed tool can still be answered in the active turn', async t => {
  const f = await fixture(t);
  await f.start();
  await f.transport.request('test/tool', { id: 'elicitation-tool', status: 'completed' });
  await f.transport.request('test/question', { id: 'tool-elicitation', toolCallId: 'elicitation-tool' });
  const interaction = await until(() => f.snapshot().interactions.find(item => item.kind === 'question_group'), 'elicitation');
  assert.equal(f.adapter['ctx'].requests.get(interaction.interactionId)?.toolCallId, 'elicitation-tool');
  const op = await f.act({ action: 'answer', interactionId: interaction.interactionId, revision: interaction.revision,
    connectionGeneration: interaction.connectionGeneration, toolInputDigest: null,
    answer: { kind: 'question_group', answers: { env: ['prod'] } },
  }) as Operation;
  assert.equal((await f.core.dispatch(op.operationId)).status, 'completed');
  assert.equal(f.store.getInteraction(interaction.interactionId).status, 'resolved');
  assert.equal(f.transport.health().pendingServerRequests, 0);
  assert.deepEqual((await f.counts() as { responses: unknown[] }).responses, [
    { id: 'tool-elicitation', result: { action: 'accept', content: { env: 'prod' } } },
  ]);
});

test('tool execution before disconnect resolves an approval when its held write receipt succeeds', async t => {
  const f = await fixture(t);
  await f.start();
  const { card, interaction } = await f.approval('executed-before-disconnect');
  const op = await f.click(card, '允许本次') as Operation;
  const writing = gate(), finish = gate();
  const write = f.transport.respondServerRequest.bind(f.transport);
  f.transport.respondServerRequest = async (...args) => {
    await write(...args);
    writing.release();
    await finish.wait;
  };
  const dispatch = f.core.dispatch(op.operationId);
  try {
    await Promise.race([writing.wait, dispatch.then(() => assert.fail('reply did not reach ACP'))]);
    const request = f.adapter['ctx'].requests.get(interaction.interactionId)!;
    assert.equal(request.submission, 'writing');
    await f.transport.request('test/tool', { id: 'executed-before-disconnect', status: 'completed' });
    assert.equal(request.executed, true);
    await f.transport.close();
    assert.equal(request.closedSource, 'connection_closed');
    assert.equal(request.submission, 'writing');
  } finally {
    finish.release();
    f.transport.respondServerRequest = write;
    await dispatch;
  }
  const resolved = f.store.getInteraction(interaction.interactionId);
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(resolved.nativeResult, {
    status: 'accepted', source: 'agy_tool_execution', answer: { kind: 'approval', decision: 'allow', scope: 'this_request' },
  });
  assert.equal(f.store.getOperation(op.operationId).status, 'completed');
  assert.equal(f.store.getOutbox(op.operationId).state, 'done');
});

for (const completion of ['completed prompt', 'failed prompt', 'wakeup'] as const) {
  test(`a ${completion} closes a submitted approval with no tool execution confirmation`, async t => {
    const f = await fixture(t, completion === 'wakeup' ? { wakeupIdleMs: 60, promptIdleTimeoutMs: 900 } : {});
    if (completion === 'wakeup') {
      await f.transport.request('test/tool', { id: 'no-confirmation', status: 'in_progress', kind: 'tool_call' });
      await until(() => f.snapshot().turns.find(turn => turn.status === 'running'), 'wakeup turn');
    } else await f.start();
    const { card, interaction } = await f.approval('no-confirmation');
    const op = await f.click(card, '允许本次') as Operation;
    assert.equal((await f.core.dispatch(op.operationId)).status, 'accepted');
    assert.equal(f.store.getInteraction(interaction.interactionId).status, 'answer_pending_delivery');

    if (completion === 'completed prompt') await f.transport.request('test/finish', { stopReason: 'end_turn' });
    if (completion === 'failed prompt') await f.transport.request('test/fail-prompt', {});
    await until(() => f.snapshot().turns.find(turn => turn.turnId === interaction.turnId &&
      turn.status === (completion === 'completed prompt' ? 'completed' : 'failed')), 'terminal turn');
    const expired = f.store.getInteraction(interaction.interactionId);
    assert.equal(expired.status, 'expired');
    assert.deepEqual(expired.nativeResult, { status: 'unknown', source: 'agy_turn_ended' });
    assert.equal((await f.refresh(interaction)).title, '审批 · 已过期');
    assert.equal(f.store.getOutbox(op.operationId).state, 'done');
  });
}

test('queued Feishu and task attachments and text are fenced by their real binding', async t => {
  const f = await fixture(t);
  await f.start();
  await f.approval('still-open');
  const owner = {source:'feishu',subject:'owner'};
  const task = new TaskTopicChannel(f.core,f.port,async () => true,join(f.root,'task.sqlite'));
  t.after(() => task.close());
  const destination = 'topic:queue-contract';
  task.registerTask({taskId:'queue-contract',destination,rootGeneration:1,owner});
  await task.mountTarget({
    taskId:'queue-contract',targetId:'agy',sessionId:f.sessionId,native:f.session().native,
    accessMode:'interactive',owner,makeActive:true,
  });
  let sequence = 0;
  const taskAct = (action: TaskChannelAction) =>
    task.handle({eventId:`task-${++sequence}`,destination,identity:owner},action) as Promise<Operation>;
  const file = {action:'attachment',name:'attachment.txt',mediaType:'text/plain',
    content:Buffer.from('attachment'),mode:'new'} as const;
  const pdf = {...file,name:'attachment.pdf',mediaType:'application/pdf',localPath:join(f.root,'attachment.pdf')};
  const direct = await f.act(pdf) as Operation;
  const staged = await f.act(file) as Operation;
  const finished = await f.act({action:'finish',operationId:staged.operationId}) as Operation;
  const taskInput = await taskAct({action:'input',text:'queued task',mode:'new'});
  const taskPdf = await taskAct(pdf);
  const taskFile = await taskAct(file);

  await f.core.dispatchPending();
  const operationIds = [direct,finished,taskInput,taskPdf,taskFile].map(op => op.operationId);
  assert.deepEqual(f.store.queuedInputs(f.sessionId).map(item => item.inputId),operationIds);
  for (const id of operationIds) assert.ok((f.store.getOutbox(id).payload as import('../src/unified/contracts.js').SubmitInput).channelScope);
  await f.send('/unbind');
  task.revokeTarget('queue-contract','agy',owner);
  await f.transport.request('test/finish',{stopReason:'end_turn'});
  await until(() => f.session().status === 'idle' ? true : undefined,'idle after unbinding attachments');
  await f.core.dispatchPending();
  for (const id of operationIds) assert.equal(f.store.getOperation(id).error?.code,'control_conflict');
  assert.equal((await f.counts() as {prompts:number}).prompts,1);
});

test('declining a choice form sends ACP decline and never records the placeholder as the answer', async t => {
  const f = await fixture(t);
  await f.start();
  await f.transport.request('test/question',{});
  const question = await until(() => f.snapshot().interactions.find(item => item.kind === 'question_group'),'question form');
  const card = await f.refresh(question);
  assert.ok(card.form);
  const op = await f.act(parseFeishuAction({
    action:'decline_form',bindingId:card.form.bindingId,interactionId:question.interactionId,
    revision:question.revision,connectionGeneration:question.connectionGeneration,
  })) as Operation;
  assert.equal((await f.core.dispatch(op.operationId)).status,'completed');
  assert.deepEqual(f.store.getInteraction(question.interactionId).nativeResult,{
    status:'accepted',source:'agy_response_write',answer:null,disposition:'skipped',
  });
  const resolved = await f.refresh(question);
  assert.equal(resolved.title,'问题 · 已跳过');
  assert.match(resolved.text,/已跳过\/取消/);
  assert.doesNotMatch(resolved.text,/已答复|prod/);
  assert.deepEqual(await f.counts(),{prompts:1,cancels:0,responses:[{id:'question',result:{action:'decline'}}]});
});

test('cancelling an individual question resolves it as skipped and retains the ACP cancel action', async t => {
  const f = await fixture(t);
  await f.start();
  await f.transport.request('test/question',{single:true});
  const question = await until(() => f.snapshot().interactions.find(item => item.kind === 'question'),'single question');
  await f.refresh(question);
  const answer = {kind:'question',values:['unused placeholder'],action:'cancel'} as const;
  const op = await f.act({
    action:'answer',interactionId:question.interactionId,revision:question.revision,
    connectionGeneration:question.connectionGeneration,toolInputDigest:null,answer:{...answer,values:[...answer.values]},
  }) as Operation;
  assert.equal((await f.core.dispatch(op.operationId)).status,'completed');
  assert.deepEqual(f.store.getInteraction(question.interactionId).nativeResult,{
    status:'accepted',source:'agy_response_write',answer:null,disposition:'skipped',
  });
  const card = await f.refresh(question);
  assert.equal(card.title,'问题 · 已跳过');
  assert.doesNotMatch(card.text,/unused placeholder|已答复/);
  assert.deepEqual(await f.counts(),{prompts:1,cancels:0,responses:[{id:'question',result:{action:'cancel'}}]});
});

test('bare /stop cancels pending queue between turns and reports the actual count', async t => {
  const f = await fixture(t);
  await f.start();
  const queued = await Promise.all(['queue one','queue two'].map(text => f.send(text) as Promise<Operation>));
  await f.transport.request('test/finish',{stopReason:'end_turn'});
  await until(() => f.session().status === 'idle' ? true : undefined,'between turns');
  assert.deepEqual(await f.send('/stop'),{status:'completed',cancelled:2});
  assert.equal(f.cards.at(-1)?.text,'已取消排队中的 2 条输入');
  assert.deepEqual(queued.map(op => f.store.getOutbox(op.operationId).state),['cancelled','cancelled']);
  await f.core.dispatchPending();
  assert.deepEqual(await f.counts(),{prompts:1,cancels:0,responses:[]});
});

test('deployment and generated preflight reject malformed and sandbox-disabling extraArgs', async () => {
  const script = `
import ast
from pathlib import Path

path = Path('scripts/deploy-production.py')
source = path.read_text()
compile(source, str(path), 'exec')
tree = ast.parse(source)
validator = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'validate_agy_sandbox')
validator_source = ast.get_source_segment(source, validator)
preflight = next(node for node in tree.body if isinstance(node, ast.Assign) and any(
    isinstance(target, ast.Name) and target.id == 'preflight_code' for target in node.targets
))
scope = {name: '' for name in ('release_dir','dist_manifest_sha','start_script_sha','source_manifest_sha','commit','branch')}
exec(compile(ast.Module(body=[validator],type_ignores=[]), str(path), 'exec'), scope)
class Source:
    def getsource(self, fn):
        assert fn is scope['validate_agy_sandbox']
        return validator_source
scope['inspect'] = Source()
generated = eval(compile(ast.Expression(preflight.value), str(path), 'eval'), scope)
compile(generated, 'preflight.py', 'exec')
preflight_tree = ast.parse(generated)
generated_validator = next(node for node in preflight_tree.body if isinstance(node, ast.FunctionDef)
                           and node.name == 'validate_agy_sandbox')
assert any(isinstance(node, ast.Expr) and ast.unparse(node.value) == 'validate_agy_sandbox(rt)' for node in tree.body)
assert any(isinstance(node, ast.Expr) and ast.unparse(node.value) == 'validate_agy_sandbox(r)'
           for node in ast.walk(preflight_tree))
generated_scope = {}
exec(compile(ast.Module(body=[generated_validator],type_ignores=[]), 'preflight.py', 'exec'), generated_scope)

disabled = [['--no-sandbox'], ['--sandbox=false'], ['--sandbox=off'], ['--sandbox=0'],
            ['--sandbox','false'], ['--sandbox','off'], ['--sandbox','0']]
bad = [None, '--sandbox', [False], [''], ['  '], ['arg' + chr(0)], *disabled]
for validate in (scope['validate_agy_sandbox'], generated_scope['validate_agy_sandbox']):
    for args in bad:
        runtime = {'approvalPolicy': {'enabled': False}, 'agy': {'sandbox': True, 'extraArgs': args}}
        try:
            validate(runtime)
        except RuntimeError:
            pass
        else:
            raise AssertionError(f'allowed {args!r}')
    for config in ({'sandbox': True}, {'sandbox': True, 'extraArgs': ['--sandbox', 'true', '--keep'] }):
        validate({'approvalPolicy': {'enabled': False}, 'agy': config})
`;
  await runFile('python3',['-c',script]);
});

test('journey provider capabilities match the raw Claude and Agy adapter contracts', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { JourneyProvider } from './scripts/e2e-journey/provider.mjs';
    import { validateWire } from './src/unified/validation.ts';
    for (const [provider, queue, steer] of [
      ['claude','unsupported','unsupported'], ['agy','unsupported','unsupported'], ['codex','available','available'],
    ]) {
      const fixture = new JourneyProvider(provider,'host','service');
      const {capabilities} = fixture.seed({project:'/tmp',active:true});
      assert.equal(validateWire('capabilities',capabilities).ok,true);
      assert.equal(capabilities.queue.status,queue);
      assert.equal(capabilities.steer.status,steer);
      const readOnly = fixture.seed({project:'/tmp',active:false});
      assert.equal(validateWire('capabilities',readOnly.capabilities).ok,true);
      for (const name of ['send','queue','steer','answer','approve','interrupt','config','handoff']) {
        assert.deepEqual(readOnly.capabilities[name],{status:'unsupported',reason:'read-only session'});
      }
      const resumed = await fixture.resume(readOnly.native);
      assert.deepEqual(resumed.createdSession.capabilities,capabilities);
      await fixture.control(readOnly.native,'release',{assertCurrent(){}});
      assert.deepEqual((await fixture.read(readOnly.native)).session.capabilities,
        {...readOnly.capabilities,handoff:{status:'available'}});
      if (provider === 'codex') {
        assert.equal(capabilities.files.status,'unsupported');
        assert.equal(readOnly.capabilities.files.status,'unsupported');
      }
    }
  `;
  await runFile(process.execPath,['--no-warnings','--import','tsx','--input-type=module','-e',script]);
});

for (const revokeDuringWrite of [false,true]) {
  test(`auto-takeover queue rejects a revoked binding ${revokeDuringWrite ? 'inside the dispatch guard' : 'before dispatch'}`, async t => {
    const f = await fixture(t);
    const owner = {source:'feishu',subject:'owner'};
    const destination = 'chat';
    const bindingScope = await f.channel.captureBindingScope({eventId:'scope',destination,identity:owner});
    const channelScope = {destination,bindingScope,ownerSource:owner.source,ownerSubject:owner.subject};
    const session = f.session();
    const context = {operationId:'auto-input',idempotencyKey:'auto-input',targetId:f.sessionId,
      expectedRevision:session.revision,controlGeneration:session.control.generation,identity:owner,channelScope};
    const queued = await f.core.submitInput({context,channelScope,mode:'queue',blocks:[{type:'text',text:'follow-up'}]});
    if (revokeDuringWrite) {
      const entered = gate(), proceed = gate();
      const input = f.adapter.input.bind(f.adapter);
      f.adapter.input = async (...args) => {
        entered.release();
        await proceed.wait;
        return input(...args);
      };
      const dispatch = f.core.dispatch(queued.operationId);
      try {
        await Promise.race([entered.wait,dispatch.then(() => assert.fail('dispatch did not reach provider'))]);
        await f.act({action:'unbind'});
      } finally { proceed.release(); }
      assert.equal((await dispatch).status,'failed');
    } else {
      await f.act({action:'unbind'});
      assert.equal((await f.core.dispatch(queued.operationId)).status,'failed');
    }
    assert.equal(f.store.getOperation(queued.operationId).error?.code,'control_conflict');
    assert.deepEqual(await f.counts(),{prompts:0,cancels:0,responses:[]});
  });
}

test('bare /stop waits for an already claimed queued input and stops the newly running turn', async t => {
  const f = await fixture(t);
  await f.start();
  const next = await f.send('next queued') as Operation;
  const rest = await f.send('remaining queued') as Operation;
  await f.transport.request('test/finish',{stopReason:'end_turn'});
  await until(() => f.session().status === 'idle' ? true : undefined,'between turns');

  const entered = gate(), proceed = gate(), stopEntered = gate();
  const input = f.adapter.input.bind(f.adapter);
  f.adapter.input = async (...args) => {
    entered.release();
    await proceed.wait;
    return input(...args);
  };
  const atomicStop = f.core.stopOrCancelQueued.bind(f.core);
  f.core.stopOrCancelQueued = (...args) => {
    stopEntered.release();
    return atomicStop(...args);
  };
  const dispatch = f.core.dispatch(next.operationId);
  await Promise.race([entered.wait,dispatch.then(() => assert.fail('queued dispatch did not start'))]);
  const stopping = f.send('/stop');
  try {
    await Promise.race([stopEntered.wait,stopping.then(() => assert.fail('stop bypassed the atomic path'))]);
    assert.equal(f.store.getOutbox(next.operationId).state,'in_flight');
  } finally { proceed.release(); }
  const nextAccepted = await dispatch;
  assert.equal(nextAccepted.status,'accepted');
  const stop = await stopping as Operation;
  assert.equal(stop.action,'interruptTurn');
  assert.equal(f.store.getOutbox(rest.operationId).state,'cancelled');
  assert.deepEqual(f.store.getOutbox(stop.operationId).payload,{turnId:f.store.operationTurn(next.operationId)?.turnId});
  await f.core.dispatch(stop.operationId);
  await until(() => f.store.getOperation(stop.operationId).status === 'completed' ? true : undefined,'interrupted queued turn');
  assert.deepEqual(await f.counts(),{prompts:2,cancels:1,responses:[]});
});

test('task topic bare /stop reports zero mounts, clears a sole target queue, and scopes a multi-mount stop', async t => {
  const f = await fixture(t);
  const owner = {source:'feishu',subject:'owner'};
  const destination = 'topic:stop-contract';
  const task = new TaskTopicChannel(f.core,f.port,async () => true,join(f.root,'task-stop.sqlite'));
  t.after(() => task.close());
  const taskId = 'task-stop';
  task.registerTask({taskId,destination,rootGeneration:1,owner});
  let sequence = 0;
  const stop = () => task.handle({eventId:`task-stop-${++sequence}`,destination,identity:owner},{action:'legacy_stop'});
  assert.deepEqual(await stop(),{status:'rejected',reason:'no_mounted_target'});
  assert.match(f.cards.at(-1)!.text,/没有挂载会话/);
  await task.mountTarget({taskId,targetId:'agy',sessionId:f.sessionId,native:f.session().native,accessMode:'interactive',owner});
  const first = await f.start();
  const queued = await f.send('task queue') as Operation;
  await f.transport.request('test/finish',{stopReason:'end_turn'});
  await until(() => f.session().status === 'idle' ? true : undefined,'task between turns');
  assert.deepEqual(await stop(),{status:'completed',cancelled:1});
  assert.equal(f.store.getOutbox(queued.operationId).state,'cancelled');

  const other = {...f.session(),sessionId:'other-session',native:{...f.session().native,nativeSessionId:'other-native'}};
  f.store.insertSession(other);
  await task.mountTarget({taskId,targetId:'other',sessionId:other.sessionId,native:other.native,accessMode:'interactive',owner});
  assert.deepEqual(await stop(),{status:'rejected',reason:'no_active_target'});
  assert.match(f.cards.at(-1)!.text,/选择/);

  const binding = task.getBinding(taskId)!;
  await task.switchActiveTarget({taskId,targetId:'agy',expectedActiveRevision:binding.activeRevision,
    expectedRootGeneration:binding.rootGeneration,owner});
  const current = await f.start();
  assert.notEqual(current.turnId,first.turnId);
  const operation = await stop() as Operation;
  assert.equal(operation.targetId,f.sessionId);
  assert.deepEqual(f.store.getOutbox(operation.operationId).payload,{turnId:current.turnId});
  await f.core.dispatch(operation.operationId);
  await until(() => f.store.getOperation(operation.operationId).status === 'completed' ? true : undefined,'task interrupted');
});

test('wakeup tool timeout keeps the stop outcome unknown', async t => {
  const f = await fixture(t,{wakeupIdleMs:40,promptIdleTimeoutMs:750});
  await f.transport.request('test/tool',{id:'wakeup-stalled',status:'in_progress',kind:'tool_call'});
  const wakeup = await until(() => f.snapshot().turns.find(turn => turn.status === 'running'),'running wakeup');
  const op = await f.send('/stop') as Operation;
  assert.equal((await f.core.dispatch(op.operationId)).status,'accepted');
  await until(() => f.snapshot().turns.find(turn => turn.turnId === wakeup.turnId && turn.status === 'failed'),'failed wakeup');
  const events = f.store.subscribeEvents(f.sessionId,f.store.initialCursor(f.sessionId),100);
  assert.equal(events.status,'events');
  assert.deepEqual(events.events.find(event => event.type === 'adapter.stream_failed' && event.objectId === wakeup.turnId)?.data,
    {reason:'wakeup tool call timed out without further updates',wakeup:true,outcomeUnknown:true});
  assert.equal(f.store.getOperation(op.operationId).status,'unknown');
  assert.equal(f.store.getOutbox(op.operationId).state,'unknown');
});

test('late terminal traffic and permissions cannot create a phantom Agy wakeup after turn completion', async t => {
  const f = await fixture(t,{wakeupIdleMs:35});
  const turn = await f.start();
  await f.transport.request('test/tool',{id:'already-terminal',status:'completed'});
  await f.transport.request('test/terminal-burst',{count:4097},{timeoutMs:30000});
  await f.transport.request('test/finish',{stopReason:'end_turn'});
  await until(() => f.session().status === 'idle' ? true : undefined,'completed native turn');
  // The original call ID was evicted from the 4096-entry ring. A late terminal
  // update must be recorded without opening a wakeup, then fence later traffic.
  for (const [kind,status] of [['tool_call_update','completed'],['tool_call_update','in_progress'],['tool_call','in_progress']]) {
    await f.transport.request('test/tool',{id:'already-terminal',kind,status});
  }
  await f.transport.request('test/tool',{status:'completed'});
  await f.transport.request('test/approval',{id:'late-rpc',toolCallId:'already-terminal'});
  assert.deepEqual((await f.counts() as {responses:unknown[]}).responses,[{id:'late-rpc',result:{outcome:{outcome:'cancelled'}}}]);
  assert.deepEqual(f.snapshot().turns.map(item => item.turnId),[turn.turnId]);
  assert.deepEqual(f.snapshot().interactions,[]);
  assert.equal(f.session().status,'idle');
});

test('runtime task handoff queues into a waiting target and fences delivery after task closure', async t => {
  const f = await fixture(t,{},true);
  await f.start();
  await f.transport.request('test/question',{});
  assert.equal(f.session().status,'waiting_question');
  const owner = {source:'feishu',subject:'owner'};
  const tasks = f.runtime?.taskChannel;
  const handoff = f.runtime?.taskHandoff;
  assert.ok(tasks && handoff);
  const target = f.session();
  const source: Session = {...target,sessionId:'handoff-source',status:'idle',
    native:{...target.native,nativeSessionId:'handoff-source'}};
  f.store.insertSession(source);
  const taskId = 'handoff-queue';
  tasks.registerTask({taskId,destination:'topic:handoff-queue',rootGeneration:1,owner});
  for (const [targetId,session] of [['source',source],['target',target]] as const) {
    await tasks.mountTarget({taskId,targetId,sessionId:session.sessionId,native:session.native,accessMode:'interactive',owner});
  }
  const {draft} = await handoff.previewHandoff({handoffId:'waiting-handoff',taskId,sourceTargetId:'source',
    targetTargetId:'target',owner,summary:'Continue after answering',constraints:[],artifactRefs:[]});
  const result = await handoff.confirmHandoff(draft.handoffId,draft.previewDigest,draft.targetGeneration,owner,'confirm-waiting');
  assert.equal(result.status,'submitted');
  assert.ok(result.operation);
  await f.core.dispatchPending();
  assert.deepEqual(f.store.queuedInputs(f.sessionId),[{inputId:result.operation.operationId}]);
  tasks.closeTask(taskId,owner);
  await f.transport.request('test/finish',{stopReason:'end_turn'});
  await until(() => f.session().status === 'idle' ? true : undefined,'idle after task closure');
  assert.equal((await f.core.dispatch(result.operation.operationId)).error?.code,'control_conflict');
  assert.equal((await f.counts() as {prompts:number}).prompts,1);
});

function questionSession(provider: 'claude' | 'codex', nativeSessionId: string, project: string): Session {
  return {
    sessionId:`${provider}-question`,native:{provider,hostId:'host',serviceId:provider,nativeSessionId},
    title:'Question',project,status:'idle',revision:0,
    capabilities:{view:{status:'available'},send:{status:'available'},queue:{status:'available'},
      steer:{status:'available'},answer:{status:'available'},approve:{status:'available'},
      interrupt:{status:'available'},handoff:{status:'available'},files:{status:'available'},config:{status:'available'}},
    control:{serviceId:provider,owner:provider,input:'available',generation:1,operationId:null,reason:null},
  };
}

async function submitDecline(core: UnifiedCore, session: Session, question: Interaction, questionId: string, action: 'decline' | 'cancel') {
  const answer = {kind:'question_group' as const,answers:{[questionId]:[DECLINED_ANSWER_MARKER]},action};
  const operationId = `${session.sessionId}-decline`;
  const current = await core.getSession(session.sessionId);
  return core.resolveInteraction({
    context:{operationId,idempotencyKey:operationId,targetId:session.sessionId,expectedRevision:question.revision,
      controlGeneration:current.control.generation,identity:{source:'feishu',subject:'owner'}},
    interactionId:question.interactionId,expectedConnectionGeneration:question.connectionGeneration,
    toolInputDigest:null,answer,
  });
}

function verifySkipped(store: UnifiedStore, question: Interaction, op: Operation, source: string) {
  const resolved = store.getInteraction(question.interactionId);
  assert.deepEqual(resolved.nativeResult,{status:'accepted',source,answer:null,disposition:'skipped'});
  assert.equal(resolved.status,'resolved');
  assert.equal(validateWire('interaction',resolved).ok,true);
  assert.equal(validateWire('interaction',{...resolved,nativeResult:{...resolved.nativeResult,disposition:'wrong'}}).ok,false);
  assert.equal(store.getOperation(op.operationId).status,'completed');
  assert.equal(store.getOutbox(op.operationId).state,'done');
  const card = interactionCard(resolved,false,store.getOperation(op.operationId));
  assert.equal(card.title,'问题 · 已跳过');
  assert.match(card.text,/已跳过\/取消/);
  assert.doesNotMatch(card.text,/已答复|\[已跳过\/取消\]/);
}

test('Claude settles a skipped question and preserves stop uncertainty after SDK stream closure', async t => {
  const root = await mkdtemp(join(tmpdir(),'claude-decline-'));
  const store = new UnifiedStore(join(root,'db'));
  const resume = gate();
  let receive = gate();
  let closed = false;
  const messages: unknown[] = [];
  let canUseTool!: NonNullable<import('@anthropic-ai/claude-agent-sdk').Options['canUseTool']>;
  const sdk = {
    query({options}: {options: {canUseTool: typeof canUseTool}}) {
      canUseTool = options.canUseTool;
      resume.release();
      return {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            if (messages.length) yield messages.shift();
            else {
              await receive.wait;
              receive = gate();
            }
          }
        },
        async interrupt() {},
        close() { closed = true; receive.release(); },
      };
    },
    async listSessions() { return []; },
    async getSessionMessages() { return []; },
  } as unknown as NonNullable<ConstructorParameters<typeof ClaudeAdapter>[3]>;
  const adapter = new ClaudeAdapter('host','claude',join(root,'owned'),sdk);
  const create = adapter.create(root,null);
  await resume.wait;
  const {nativeReference,connectionGeneration} = await create;
  assert.ok(nativeReference && connectionGeneration);
  const session = questionSession('claude',nativeReference,root);
  store.insertSession(session);
  store.setConnectionGeneration(session.sessionId,0,connectionGeneration);
  const core = new UnifiedCore(store,[adapter],() => true);
  t.after(async () => {
    core.close();
    await adapter.close();
    store.close();
    await rm(root,{recursive:true,force:true});
  });
  const start = await core.submitInput({
    context:{operationId:'claude-start',idempotencyKey:'claude-start',targetId:session.sessionId,expectedRevision:0,
      controlGeneration:session.control.generation,identity:{source:'feishu',subject:'owner'}},
    mode:'new',blocks:[{type:'text',text:'Ask a question'}],
  });
  assert.equal((await core.dispatch(start.operationId)).status,'accepted');
  const decision = canUseTool('AskUserQuestion',{questions:[{question:'Which?',options:[],multiSelect:false}]},
    {signal:new AbortController().signal,toolUseID:'native-question'} as Parameters<typeof canUseTool>[2]);
  const question = await until(() => store.snapshot(session.sessionId).value.interactions.at(-1),'Claude question');
  const op = await submitDecline(core,session,question,'0','decline');
  await core.dispatch(op.operationId);
  assert.deepEqual(await decision,{behavior:'deny',message:'User declined to answer'});
  messages.push({type:'user',message:{content:[{type:'tool_result',tool_use_id:'native-question',is_error:true}]}});
  receive.release();
  await until(() => store.getOperation(op.operationId).status === 'completed' ? true : undefined,'Claude skip evidence');
  verifySkipped(store,question,op,'claude_question_declined');
  const current = store.getSession(session.sessionId);
  const stop = await core.stopOrCancelQueued({operationId:'claude-stop',idempotencyKey:'claude-stop',targetId:session.sessionId,
    expectedRevision:current.revision,controlGeneration:current.control.generation,identity:{source:'feishu',subject:'owner'}});
  assert.ok('operationId' in stop);
  assert.equal((await core.dispatch(stop.operationId)).status,'accepted');
  closed = true;
  receive.release();
  await until(() => store.listTurns(session.sessionId).find(turn => turn.status === 'failed'),'Claude turn stream close');
  const events = store.subscribeEvents(session.sessionId,store.initialCursor(session.sessionId),100);
  assert.equal(events.status,'events');
  assert.deepEqual(events.events.find(event => event.type === 'adapter.stream_failed')?.data,
    {kind:'sdk_stream_closed_without_result',exitCode:null});
  assert.equal(store.getOperation(stop.operationId).status,'unknown');
  assert.equal(store.getOutbox(stop.operationId).state,'unknown');
});

class QuestionSocket extends EventTarget {
  readyState = 0;
  sent: unknown[] = [];
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  message(message: unknown) { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(message)})); }
  send(raw: string) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.method === 'initialize') queueMicrotask(() => this.message({id:message.id,result:{}}));
    if (message.method === 'thread/resume') queueMicrotask(() => this.message({id:message.id,
      result:{thread:{id:message.params.threadId,cwd:'/tmp',status:{type:'idle'}}}}));
  }
}

async function codexQuestionFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(),'codex-decline-'));
  const store = new UnifiedStore(join(root,'db'));
  const socket = new QuestionSocket();
  const factory = (() => {queueMicrotask(() => socket.open()); return socket;}) as unknown as SocketFactory;
  const transport = new CodexTransport('ws://127.0.0.1:1',factory,1000);
  const adapter = new CodexAdapter(transport,'host','codex');
  const core = new UnifiedCore(store,[adapter],() => true);
  const session = questionSession('codex','native-thread','/tmp');
  store.insertSession(session);
  t.after(async () => {
    core.close();
    transport.close();
    store.close();
    await rm(root,{recursive:true,force:true});
  });
  await transport.connect();
  await adapter.resume(session.native);
  socket.message({method:'turn/started',params:{threadId:'native-thread',turn:{id:'turn',status:'inProgress'}}});
  socket.message({id:7,method:'item/tool/requestUserInput',params:{
    threadId:'native-thread',turnId:'turn',questions:[{id:'q',question:'Choose'}],
  }});
  const question = store.snapshot(session.sessionId).value.interactions.at(-1)!;
  const op = await submitDecline(core,session,question,'q','cancel');
  return {store,socket,transport,core,question,op};
}

test('Codex cancels a question with an empty answers object and settles on serverRequest/resolved', async t => {
  const {store,socket,core,question,op} = await codexQuestionFixture(t);
  assert.equal((await core.dispatch(op.operationId)).status,'accepted');
  assert.deepEqual(socket.sent.at(-1),{id:7,result:{answers:{}}});
  socket.message({method:'serverRequest/resolved',params:{threadId:'native-thread',requestId:7}});
  verifySkipped(store,question,op,'codex_question_declined');
});

test('Codex does not attribute native closure to a decline whose response write threw', async t => {
  const {store,socket,transport,core,question,op} = await codexQuestionFixture(t);
  t.mock.method(transport,'respond',() => {throw new Error('response write failed');});
  assert.equal((await core.dispatch(op.operationId)).status,'unknown');
  socket.message({method:'serverRequest/resolved',params:{threadId:'native-thread',requestId:7}});
  const resolved = store.getInteraction(question.interactionId);
  assert.equal(resolved.status,'resolved');
  assert.deepEqual(resolved.nativeResult,{status:'unknown',source:'unknown'});
  assert.equal(store.getOperation(op.operationId).status,'unknown');
  assert.equal(store.getOutbox(op.operationId).state,'unknown');
});

test('production config publishes only a validated candidate against an unchanged live file', async () => {
  const script = `
import ast
import json
import os
import stat
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from types import SimpleNamespace

tree = ast.parse(Path('scripts/deploy-production.py').read_text())
config_read = next(node for node in tree.body if isinstance(node, ast.Assign)
                   and ast.unparse(node.value) == 'CONF_FILE.read_bytes()')
release_publish = next(node for node in tree.body if isinstance(node, ast.Expr)
                       and ast.unparse(node.value) == 'os.rename(staging, release_dir)')
assert config_read.lineno > release_publish.lineno, 'read configuration after release staging'
step = next(node for node in tree.body if isinstance(node, ast.Try)
            and 'NamedTemporaryFile(' in ast.unparse(node))
publication = compile(ast.Module(body=[step],type_ignores=[]), '<config publication>', 'exec')
with TemporaryDirectory() as root:
    release = Path(root)
    live = release / 'config.json'
    live.write_text('old configuration')
    paths = []
    def inspect(command, check):
        assert check and command[-2] == '--config'
        temp = Path(command[-1])
        assert temp.parent == release and temp.name.startswith('.config.json.') and temp.suffix == '.tmp'
        assert stat.S_IMODE(temp.stat().st_mode) == 0o600
        assert json.loads(temp.read_text()) == {'new': True}
        assert live.read_text() == 'old configuration'
        paths.append(temp)
    def reject(command, *, check):
        inspect(command, check)
        raise ValueError('fixture rejects config')
    scope = {'os':os,'json':json,'Path':Path,'NamedTemporaryFile':NamedTemporaryFile,
             'CONF_FILE':live,'CONF_DIR':release,'release_dir':release,'cfg':{'new':True},'orig_bytes':live.read_bytes(),
             'subprocess':SimpleNamespace(run=reject)}
    try:
        exec(publication, scope)
    except ValueError:
        assert live.read_text() == 'old configuration'
        assert not paths[0].exists()
    else:
        raise AssertionError('failed candidate was published')
    def concurrent_edit(command, *, check):
        inspect(command, check)
        live.write_text('concurrently edited configuration')
    scope['subprocess'].run = concurrent_edit
    try:
        exec(publication, scope)
    except RuntimeError as exc:
        assert 'changed during validation' in str(exc)
        assert live.read_text() == 'concurrently edited configuration'
        assert not paths[-1].exists()
    else:
        raise AssertionError('concurrent config edit was overwritten')
    live.write_bytes(scope['orig_bytes'])
    def accept(command, *, check):
        inspect(command, check)
    scope['subprocess'].run = accept
    exec(publication, scope)
    assert len(set(paths)) == 3 and all(not temp.exists() for temp in paths)
    assert json.loads(live.read_text()) == {'new': True}
`;
  await runFile('python3',['-c',script]);
});

test('ordinary Feishu input queued during approval cannot dispatch after /unbind', async t => {
  const f = await fixture(t);
  await f.start();
  await f.approval('waiting-for-unbind');
  const queued = await f.send('Queued through Feishu') as Operation;
  assert.equal(f.store.getOutbox(queued.operationId).state,'pending');
  await f.send('/unbind');
  await f.transport.request('test/finish',{stopReason:'end_turn'});
  await until(() => f.session().status === 'idle' ? true : undefined,'idle unbound session');
  assert.equal((await f.core.dispatch(queued.operationId)).error?.code,'control_conflict');
  assert.equal((await f.counts() as {prompts:number}).prompts,1);
});

function verifyLocalStopTransitions(store: UnifiedStore, sessionId: string, operationId: string) {
  const page = store.subscribeEvents(sessionId,store.initialCursor(sessionId),100);
  assert.equal(page.status,'events');
  const events = page.events.filter(event => event.operationId === operationId && event.type.startsWith('operation.'));
  const statuses = events.map(event => (event.data as Operation).status);
  assert.deepEqual(events.map(event => event.type),['operation.received','operation.accepted','operation.completed']);
  for (let index = 1; index < statuses.length; index++) {
    assert.ok(canTransitionOperation(statuses[index-1]!,statuses[index]!));
  }
  assert.deepEqual(statuses,['received','accepted','completed']);
}

test('a persisted queue-only stop replays under another dispatcher lease and preserves later input', async t => {
  const f = await fixture(t);
  const session = f.session();
  const identity = {source:'feishu',subject:'owner'};
  const context = {operationId:'queue-stop',idempotencyKey:'queue-stop',targetId:f.sessionId,
    expectedRevision:session.revision,controlGeneration:session.control.generation,identity};
  const first = await f.act({action:'input',text:'Q1',mode:'queue'}) as Operation;
  const stopped = await f.core.stopOrCancelQueued(context);
  assert.deepEqual(stopped,{status:'completed',cancelled:1});
  assert.equal(f.store.getOutbox(first.operationId).state,'cancelled');
  assert.equal(f.store.getOutbox(context.operationId).state,'done');
  assert.equal(validateWire('operation',f.store.getOperation(context.operationId)).ok,true);
  verifyLocalStopTransitions(f.store,f.sessionId,context.operationId);

  const second = await f.act({action:'input',text:'Q2',mode:'queue'}) as Operation;
  const reopened = new UnifiedStore(f.corePath);
  const restarted = new UnifiedCore(reopened,[],() => true);
  const lease = f.store.acquireDispatchLease(f.sessionId,'other-worker',Date.now(),30000);
  try {
    assert.ok(lease !== null);
    await assert.rejects(restarted.stopOrCancelQueued({...context,operationId:'new-stop',idempotencyKey:'new-stop'}),
      error => error instanceof StoreError && error.detail.code === 'busy');
    assert.deepEqual(await restarted.stopOrCancelQueued(context),stopped);
    assert.equal(reopened.getOutbox(second.operationId).state,'pending');
    await assert.rejects(restarted.stopOrCancelQueued({...context,operationId:'different'}),/idempotency_conflict/);
  } finally {
    if (lease !== null) f.store.releaseDispatchLease(f.sessionId,'other-worker',lease);
    restarted.close();
    reopened.close();
  }
});

test('Agy disconnect after an acknowledged wakeup stop leaves the interrupt outcome unknown', async t => {
  const f = await fixture(t);
  await f.transport.request('test/tool',{id:'active-during-disconnect',status:'in_progress',kind:'tool_call'});
  const turn = await until(() => f.snapshot().turns.find(item => item.status === 'running'),'running wakeup');
  const stop = await f.send('/stop') as Operation;
  assert.equal((await f.core.dispatch(stop.operationId)).status,'accepted');
  await f.transport.close();
  await until(() => f.snapshot().turns.find(item => item.turnId === turn.turnId && item.status === 'failed'),'disconnect turn');
  const events = f.store.subscribeEvents(f.sessionId,f.store.initialCursor(f.sessionId),100);
  assert.equal(events.status,'events');
  const streamFailure = events.events.find(event => event.type === 'adapter.stream_failed' && event.objectId === turn.turnId);
  assert.deepEqual(streamFailure?.data,{reason:'connection closed',outcomeUnknown:true});
  assert.equal(f.store.getOperation(stop.operationId).status,'unknown');
  assert.equal(f.store.getOutbox(stop.operationId).state,'unknown');
});

for (const kind of ['question','deny']) {
  test(`Agy disconnect during ${kind} reply write cannot resolve the interaction`, async t => {
    const f = await fixture(t);
    let interaction: Interaction;
    let op: Operation;
    if (kind === 'deny') {
      const approval = await f.approval('deny-on-disconnect');
      interaction = approval.interaction;
      op = await f.click(approval.card,'拒绝') as Operation;
    } else {
      await f.transport.request('test/question',{});
      interaction = await until(() => f.snapshot().interactions.find(item => item.kind === 'question_group'),'question');
      op = await f.act({action:'answer',interactionId:interaction.interactionId,revision:interaction.revision,
        connectionGeneration:interaction.connectionGeneration,toolInputDigest:null,
        answer:{kind:'question_group',answers:{env:['prod']}}}) as Operation;
    }
    const cursor = f.store.snapshot(f.sessionId).cursor;
    const nativeUpdates: Interaction[] = [];
    t.after(f.adapter.onObservation(event => {
      if (event.type === 'interaction' && event.interaction.interactionId === interaction.interactionId) {
        nativeUpdates.push(event.interaction);
      }
    }));
    const writing = gate(), finish = gate();
    const write = f.transport.respondServerRequest.bind(f.transport);
    f.transport.respondServerRequest = async (...args) => {
      await write(...args);
      writing.release();
      await finish.wait;
    };
    const dispatch = f.core.dispatch(op.operationId);
    try {
      await Promise.race([writing.wait,dispatch.then(() => assert.fail('reply did not reach ACP'))]);
      await f.transport.close();
    } finally {
      finish.release();
      await dispatch;
    }
    await until(() => f.store.getInteraction(interaction.interactionId).status === 'expired' ? true : undefined,'expired interaction');
    // Drain the deferred weak-close callback even if control loss already expired the durable interaction.
    await new Promise<void>(resolve => setImmediate(resolve));
    const result = f.store.getInteraction(interaction.interactionId).nativeResult;
    assert.notEqual(result?.status,'accepted');
    assert.deepEqual(nativeUpdates.map(update => [update.status,update.nativeResult]),[
      ['expired',{status:'unknown',source:'connection_closed'}],
    ]);
    const events = f.store.subscribeEvents(f.sessionId,cursor,100);
    assert.equal(events.status,'events');
    assert.ok(!events.events.some(event => event.objectId === interaction.interactionId &&
      (event.data as Interaction).status === 'resolved'));
    assert.equal(f.store.getOperation(op.operationId).status,'unknown');
  });
}

test('idle input captured by Feishu cannot be sent after the topic is unbound', async t => {
  const f = await fixture(t);
  const input = await f.send('New input before unlink') as Operation;
  assert.equal((f.store.getOutbox(input.operationId).payload as {mode:string}).mode,'new');
  await f.send('/unbind');
  assert.equal((await f.core.dispatch(input.operationId)).error?.code,'control_conflict');
  assert.equal((await f.counts() as {prompts:number}).prompts,0);
});

for (const afterClaim of [false,true]) {
  test(`pending /stop from an unbound Feishu topic is fenced ${afterClaim ? 'at the transport guard' : 'before provider dispatch'}`, async t => {
    const f = await fixture(t);
    await f.start();
    const stop = await f.send('/stop') as Operation;
    assert.ok(f.store.getOutbox(stop.operationId).context.channelScope);
    if (afterClaim) {
      const entered = gate(), resume = gate();
      const nativeInterrupt = f.adapter.interrupt.bind(f.adapter);
      f.adapter.interrupt = async (...args) => {
        entered.release();
        await resume.wait;
        return nativeInterrupt(...args);
      };
      const dispatch = f.core.dispatch(stop.operationId);
      try {
        await Promise.race([entered.wait,dispatch.then(() => assert.fail('interrupt did not reach the transport boundary'))]);
        await f.send('/unbind');
      } finally { resume.release(); }
      assert.equal((await dispatch).error?.code,'control_conflict');
    } else {
      await f.send('/unbind');
      assert.equal((await f.core.dispatch(stop.operationId)).error?.code,'control_conflict');
    }
    assert.equal(f.store.getOutbox(stop.operationId).state,'done');
    assert.deepEqual(await f.counts(),{prompts:1,cancels:0,responses:[]});
  });
}

for (const ambiguous of [false,true]) {
  test(`replaying a persisted ${ambiguous ? 'ambiguous' : 'empty'} stop rejection cannot cancel later inputs`, async t => {
    const f = await fixture(t);
    if (ambiguous) {
      const turn = await f.start();
      f.store.observeTurn({...turn,turnId:'parallel-turn'});
    }
    const session = f.session();
    const context = {operationId:'rejected-stop',idempotencyKey:'rejected-stop',targetId:f.sessionId,
      expectedRevision:session.revision,controlGeneration:session.control.generation,identity:{source:'feishu',subject:'owner'}};
    const rejected = {status:'rejected',reason:ambiguous ? 'ambiguous_running_turn' : 'no_running_turn'};
    assert.deepEqual(await f.core.stopOrCancelQueued(context),rejected);
    assert.equal(f.store.getOutbox(context.operationId).state,'done');
    assert.equal(validateWire('operation',f.store.getOperation(context.operationId)).ok,true);
    verifyLocalStopTransitions(f.store,f.sessionId,context.operationId);
    if (ambiguous) {
      for (const turn of f.snapshot().turns) {
        f.store.observeTurn({...turn,status:'completed',endedAt:new Date().toISOString()});
      }
    }
    const queued = await f.act({action:'input',text:'later input',mode:'queue'}) as Operation;
    const reopened = new UnifiedStore(f.corePath);
    const allowed = new UnifiedCore(reopened,[],() => true);
    const denied = new UnifiedCore(reopened,[],(_identity,_session,action) => action !== 'interruptTurn');
    try {
      await assert.rejects(denied.stopOrCancelQueued(context),/unauthorized/);
      await assert.rejects(denied.stopOrCancelQueued({...context,idempotencyKey:'other-stop',operationId:'other-stop'}),/unauthorized/);
      assert.deepEqual(await allowed.stopOrCancelQueued(context),rejected);
      assert.equal(reopened.getOutbox(queued.operationId).state,'pending');
    } finally {
      denied.close();
      allowed.close();
      reopened.close();
    }
  });
}

test('a definite ACP -32602 prompt failure settles an acknowledged interrupt as failed', async t => {
  const f = await fixture(t);
  const turn = await f.start();
  await f.transport.request('test/hold-cancel',{});
  const stop = await f.send('/stop') as Operation;
  assert.equal((await f.core.dispatch(stop.operationId)).status,'accepted');
  await f.transport.request('test/fail-prompt',{});
  await until(() => f.snapshot().turns.find(item => item.turnId === turn.turnId && item.status === 'failed'),'definite prompt failure');
  const events = f.store.subscribeEvents(f.sessionId,f.store.initialCursor(f.sessionId),100);
  assert.equal(events.status,'events');
  const failure = events.events.find(event => event.type === 'adapter.stream_failed' && event.objectId === turn.turnId);
  assert.deepEqual(failure?.data,{reason:'Invalid ACP prompt params',definiteFailure:true,cancelRequested:true});
  assert.equal(f.store.getOutbox(stop.operationId).state,'done');
  assert.equal(f.store.getOperation(stop.operationId).status,'failed');
  assert.equal(f.store.getOperation(stop.operationId).error?.code,'busy');
});
