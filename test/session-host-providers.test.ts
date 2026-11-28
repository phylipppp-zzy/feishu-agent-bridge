import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DispatchGuard, PlatformObservation } from '../src/unified/adapter.js';
import { AgyAdapter } from '../src/unified/agy/adapter.js';
import { AgyAcpTransport } from '../src/unified/agy-transport.js';
import { AgyCatalog } from '../src/unified/agy-catalog.js';
import { ClaudeAdapter } from '../src/unified/claude-adapter.js';
import { ClaudeState } from '../src/unified/claude-state.js';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import { CodexTransport } from '../src/unified/codex-transport.js';
import type { Answer, NativeSessionRef } from '../src/unified/contracts.js';
import { HostedPlatformPort, type HostedAttachment, type HostedLiveSnapshot, type HostEvent } from '../src/unified/session-host/hosted-port.js';
import { isStampedProcessAlive } from '../src/unified/session-host/launcher.js';
import { SessionHostJournal } from '../src/unified/session-host/journal.js';
import { SessionHostRegistry } from '../src/unified/session-host/registry.js';
import type { Fields } from '../src/unified/session-host/protocol.js';

const releaseDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const hostMain = new URL('../src/unified/session-host/host-main.js', import.meta.url);
const hostId = 'bridge-test';
const serviceId = 'provider-test';
const allow = { kind: 'approval', decision: 'allow', scope: 'this_request' } as const;
const hasCode = (code: string) => (error: unknown) =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === code;

async function until<T>(find: () => T | undefined | false, description: string, timeout = 5000): Promise<T> {
  const limit = performance.now() + timeout;
  for (;;) {
    const found = find();
    if (found !== false && found !== undefined) return found;
    if (performance.now() > limit) throw new Error('timed out waiting for ' + description);
    await sleep(15);
  }
}

function fixture(t: TestContext) {
  const stateDir = mkdtempSync(join(tmpdir(), 'fshp-'));
  const registry = new SessionHostRegistry(stateDir);
  const ports: HostedPlatformPort[] = [];
  t.after(async () => {
    await Promise.allSettled(ports.map(port => port.close()));
    const hosts = registry.listActiveInstances().filter(isStampedProcessAlive);
    for (const host of hosts) process.kill(host.pid, 'SIGTERM');
    try { await until(() => hosts.every(host => !isStampedProcessAlive(host)), 'provider host exit', 3000); }
    catch {
      for (const host of hosts.filter(isStampedProcessAlive)) process.kill(host.pid, 'SIGKILL');
      await until(() => hosts.every(host => !isStampedProcessAlive(host)), 'provider host kill');
    } finally {
      registry.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
  return {
    stateDir, registry,
    port(local: ConstructorParameters<typeof HostedPlatformPort>[0]['local'], config: Fields, hostEntryScript?: string) {
      const port = new HostedPlatformPort({
        hostId, serviceId, local, config, stateDir, runtimeDir: join(stateDir, 'run'), releaseDir,
        bridgeEpoch: registry.allocateBridgeEpoch(), detachedOnly: true, allowDetachedFallback: true,
        ...(hostEntryScript ? { hostEntryScript } : {}),
      });
      ports.push(port);
      return port;
    },
  };
}

function watch(port: HostedPlatformPort) {
  const events: Array<{ observation: PlatformObservation; event: HostEvent }> = [];
  port.setHostedObservationHandler((observation, event) => { events.push({ observation, event }); });
  return events;
}

const guard = (operationId: string, generation: number, control = 0): DispatchGuard => ({
  operationId, expectedControlGeneration: control, expectedConnectionGeneration: generation, assertCurrent() {},
});
const prompt = (text: string) => [{ type: 'text' as const, text }];
const native = (provider: NativeSessionRef['provider'], nativeSessionId: string): NativeSessionRef =>
  ({ provider, hostId, serviceId, nativeSessionId });
const pending = (events: ReturnType<typeof watch>) => events.find(({ observation }) =>
  observation.type === 'interaction' && observation.interaction.status === 'awaiting_answer');
const complete = (events: ReturnType<typeof watch>, turnId: string | null) => events.find(({ observation }) =>
  observation.type === 'turn' && observation.turn.turnId === turnId && observation.turn.status === 'completed');
const turnData = (attachment: HostedAttachment) => attachment.snapshot?.state.data as HostedLiveSnapshot;
const observed = (event: HostEvent) => event.observation as PlatformObservation;
const lastSeq = (events: ReturnType<typeof watch>) => events.at(-1)!.event.seq;

function agyPeer(stateDir: string) {
  const script = join(stateDir, 'acp.mjs');
  const log = join(stateDir, 'acp.log');
  writeFileSync(script, `
    import { createInterface } from 'node:readline';
    import { appendFileSync, createReadStream, writeSync } from 'node:fs';
    const send = message => writeSync(1, JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
    const transcript = 'host-agy';
    let approvalPrompt;
    const update = update => send({ method: 'session/update', params: { sessionId: transcript, update } });
    const text = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const tool = status => update({ sessionUpdate: 'tool_call_update', toolCallId: 'permission-tool', status });
    createInterface({ input: createReadStream(undefined, { fd: 0, autoClose: false }) }).on('line', line => {
      const message = JSON.parse(line);
      const { id, method, params } = message;
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(message) + '\\n');
      const reply = result => send({ id, result });
      if (method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
      else if (method === 'session/new' || method === 'session/load') reply({ sessionId: transcript });
      else if (method === 'session/prompt') {
        if (params.prompt[0]?.text === 'finish offline') {
          setTimeout(() => { text('Complete while detached'); reply({ stopReason: 'end_turn' }); }, 350);
          setTimeout(() => text('Wakeup reply'), 2400);
        } else {
          approvalPrompt = id;
          text('Before permission.');
          update({ sessionUpdate: 'tool_call', toolCallId: 'permission-tool', status: 'pending', kind: 'execute', title: 'Fixture' });
          send({ id: 'permission-rpc', method: 'session/request_permission', params: {
            sessionId: transcript, toolCall: { toolCallId: 'permission-tool', title: 'Fixture', kind: 'execute', rawInput: { CommandLine: 'true' } },
            options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
          } });
          setTimeout(() => text(' More streaming text.'), 250);
        }
      } else if (id === 'permission-rpc' && 'result' in message) {
        tool('in_progress');
        tool('completed');
        text(' Granted.');
        send({ id: approvalPrompt, result: { stopReason: 'end_turn' } });
      } else if (id !== undefined) reply({});
    });
  `);
  return {
    config: {
      transport: { agyBin: process.execPath, prependArgs: [script], sandbox: false },
      catalog: { brainDir: join(stateDir, 'brain'), dbPath: join(stateDir, 'summaries.sqlite') },
      approvalPolicy: { enabled: false }, adapterOptions: { wakeupIdleMs: 950 },
    },
    log: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Fields),
  };
}

test('detached AGY host keeps native permission and wakeup state, and replays offline completion', { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const peer = agyPeer(f.stateDir);
  const newPort = () => f.port(new AgyAdapter(new AgyAcpTransport(), new AgyCatalog(peer.config.catalog), hostId, serviceId), peer.config);
  const first = newPort();
  assert.deepEqual(await first.list(null, 10), { items: [], nextCursor: null });
  assert.equal((await first.discoverExisting!(null, 10)).items.length, 0);
  assert.equal(f.registry.listActiveInstances().length, 0);
  assert.deepEqual(await first.probe(native('agy', 'host-agy')), { status: 'absent' });

  const initial = watch(first);
  const created = await first.create(f.stateDir, null, 'create-agy');
  const ref = created.createdSession!.native;
  const generation = created.connectionGeneration!;
  const host = f.registry.getInstanceByRef(['agy', hostId, serviceId, ref.nativeSessionId])!;
  assert.ok(isStampedProcessAlive(host));
  assert.notEqual(host.pid, process.pid);
  assert.equal(f.registry.getCreateReceipt('create-agy')?.key, host.key);
  const bootstrap = join(f.stateDir, 'session-host', 'bootstrap');
  assert.equal(statSync(join(bootstrap, readdirSync(bootstrap)[0]!)).mode & 0o777, 0o600);
  assert.equal(f.registry.listActiveInstances().length, 1);
  const run = await first.input(ref, 'new', prompt('start with permission'), guard('agy-input', generation));
  const interactionEvent = await until(() => pending(initial), 'AGY permission');
  assert.equal(interactionEvent.observation.type, 'interaction');
  const interaction = interactionEvent.observation.interaction;
  assert.equal(interaction.nativeRequestId, '"permission-rpc"');
  await assert.rejects(first.input(ref, 'steer', prompt('unsupported'), guard('agy-steer', generation)), hasCode('unsupported'));
  const cursor = { instanceId: host.instanceId, seq: interactionEvent.event.seq };
  await first.commitAck(ref, cursor.seq);
  const second = newPort();
  const probe = await second.probe(ref);
  assert.equal(probe.status, 'alive');
  assert.equal(probe.pendingInteractionCount, 1);
  assert.equal(probe.activeTurnId, run.nativeReference);
  assert.equal((await first.resume(ref)).connectionGeneration, generation, 'hello did not fence the bridge');
  await first.close({ detachOnly: true });
  assert.ok(isStampedProcessAlive(host));
  await sleep(350);

  const after = watch(second);
  const replay = await second.attachHosted(ref, cursor);
  assert.equal(replay.mode, 'replay');
  assert.equal(replay.instanceId, host.instanceId);
  assert.ok(replay.replayedEvents.map(observed).some(obs =>
    obs.type === 'message' && obs.message.blocks.some(block => block.type === 'text' && block.text.includes('More streaming text.'))));
  await second.commitAck(ref, replay.barrierSeq);
  // Force paginated reconciliation and verify every field of the original request.
  const snapshot = await second.attachHosted(ref, null);
  const data = turnData(snapshot);
  assert.equal(data.activeTurnId, run.nativeReference);
  assert.equal(data.connectionGeneration, generation);
  assert.deepEqual(data.interactions.find(i => i.interactionId === interaction.interactionId), interaction);
  await second.commitAck(ref, snapshot.barrierSeq);
  assert.deepEqual(await second.create(f.stateDir, null, 'create-agy'), created);
  await assert.rejects(second.create(f.stateDir, 'different', 'create-agy'), hasCode('idempotency_conflict'));
  await assert.rejects(second.respond(ref, interaction, allow, guard('stale-agy-control', generation, 99)), hasCode('control_conflict'));
  await second.respond(ref, interaction, allow, guard('agy-allow', generation));
  await second.respond(ref, interaction, allow, guard('agy-allow', generation));
  await until(() => complete(after, run.nativeReference), 'AGY turn completion');
  assert.equal(peer.log().filter(m => m.id === 'permission-rpc').length, 1);
  assert.equal(peer.log().filter(m => m.method === 'session/new').length, 1);
  assert.equal(peer.log().filter(m => m.method === 'session/load').length, 0);

  const offline = await second.input(ref, 'new', prompt('finish offline'), guard('offline-input', generation));
  await until(() => after.find(({ observation }) =>
    observation.type === 'turn' && observation.turn.turnId === offline.nativeReference), 'offline turn start');
  const offlineCursor = { instanceId: host.instanceId, seq: lastSeq(after) };
  await second.commitAck(ref, offlineCursor.seq);
  await second.close({ detachOnly: true });
  await sleep(2_000);
  const third = newPort();
  const wakeupEvents = watch(third);
  const offlineReplay = await third.attachHosted(ref, offlineCursor);
  assert.equal(offlineReplay.mode, 'replay');
  const recovered = offlineReplay.replayedEvents.map(observed);
  assert.ok(recovered.some(obs => obs.type === 'turn' && obs.turn.turnId === offline.nativeReference && obs.turn.status === 'completed'));
  assert.ok(recovered.some(obs => obs.type === 'message' && obs.message.final &&
    obs.message.blocks[0]?.type === 'text' && obs.message.blocks[0].text === 'Complete while detached'));
  const journal = new SessionHostJournal(f.stateDir, host.key);
  t.after(() => journal.close());
  assert.ok(journal.listUnackedEvents(host.instanceId).some(event => event.seq === offlineReplay.barrierSeq));
  await third.commitAck(ref, offlineReplay.barrierSeq);
  assert.equal(journal.listUnackedEvents(host.instanceId, offlineReplay.barrierSeq).length, 0);
  await until(() => wakeupEvents.find(({ observation }) => observation.type === 'turn' && observation.turn.status === 'running'), 'wakeup');
  const wakeup = await third.attachHosted(ref, null);
  assert.equal(wakeup.snapshot?.state.pendingWakeup, true);
  assert.deepEqual(await third.shutdownHost(ref), { outcome: 'busy', reason: 'active turn' });
  await third.commitAck(ref, wakeup.barrierSeq);
  const wakeupId = turnData(wakeup).activeTurnId;
  await until(() => complete(wakeupEvents, wakeupId), 'wakeup completion');
  await third.commitAck(ref, lastSeq(wakeupEvents));
  assert.deepEqual(await third.shutdownHost(ref), { outcome: 'closed' });
});

function claudeWorker(stateDir: string) {
  const script = join(stateDir, 'claude-host.mjs');
  const log = join(stateDir, 'sdk.log');
  const fakeQuery = new URL('./claude-fake-query.js', import.meta.url);
  const runner = new URL('../src/unified/session-host/providers/claude-runner.js', import.meta.url);
  writeFileSync(script, `
    import { appendFileSync } from 'node:fs';
    import { FakeQuery } from ${JSON.stringify(fakeQuery.href)};
    import { ClaudeSessionHostRunner } from ${JSON.stringify(runner.href)};
    import { runSessionHost } from ${JSON.stringify(hostMain.href)};
    const log = value => appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
    const args = Object.fromEntries(Array.from({length:(process.argv.length - 2)/2}, (_, i) =>
      [process.argv[2 + i*2], process.argv[3 + i*2]]));
    const sdk = {
      listSessions: async () => [], getSessionMessages: async () => [],
      query: ({ prompt, options }) => {
        log({ opened: true, hooks: !!options.hooks });
        const fake = new FakeQuery(options, prompt);
        const close = fake.close.bind(fake);
        fake.close = () => { log({ closed: true }); close(); };
        const stream = (id, text, final = false) => {
          const emit = event => fake.emit({ type: 'stream_event', event, session_id: fake.sessionId, parent_tool_use_id: null });
          emit({ type: 'message_start', message: { id } });
          emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
          if (final) emit({ type: 'message_stop' });
        };
        void (async () => {
          const input = await fake.nextMessage(1);
          stream('claude-message-before', 'Claude partial');
          const abort = new AbortController();
          const toolId = 'claude-question-rpc';
          const decision = await options.canUseTool('AskUserQuestion',
            { questions: [{ question: 'Which option?', options: [{ label: 'A' }] }] },
            { signal: abort.signal, suggestions: [], toolUseID: toolId, requestId: 'request-id' });
          log({ decision, aborted: abort.signal.aborted });
          fake.emit({ type:'user', session_id: fake.sessionId, message: { content: [{
            type:'tool_result', tool_use_id: toolId, content: 'answered'
          }] } });
          stream('claude-message-after', 'Claude completed', true);
          fake.result([input.uuid]);
        })().catch(error => log({ failure: String(error) }));
        return fake;
      },
    };
    await runSessionHost({
      provider: args['--provider'], key: args['--key'], stateDir: args['--state-dir'], runtimeDir: args['--runtime-dir'],
      releaseDir: args['--release-dir'], configFile: args['--config-file'],
    }, (_provider, config, bootstrap) => new ClaudeSessionHostRunner({
      ...bootstrap, stateDir: config.claudeStateDir, sdk, approvalPolicy: { enabled: false },
    }));
  `);
  return {
    script,
    log: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Fields) : [],
  };
}

test('Claude canUseTool promise and SDK query survive bridge detach', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const worker = claudeWorker(f.stateDir);
  const claudeStateDir = join(f.stateDir, 'legacy');
  const newPort = () => f.port(new ClaudeAdapter(hostId, serviceId, claudeStateDir), {
    claudeStateDir, approvalPolicy: { enabled: false }, maxRingEntries: 2,
  }, worker.script);
  const first = newPort();
  const initial = watch(first);
  const created = await first.create(f.stateDir, null, 'create-claude');
  const ref = created.createdSession!.native;
  const generation = created.connectionGeneration!;
  const run = await first.input(ref, 'new', prompt('Claude question'), guard('claude-input', generation));
  const request = await until(() => pending(initial), 'Claude canUseTool');
  assert.equal(request.observation.type, 'interaction');
  const original = request.observation.interaction;
  assert.equal(original.kind, 'question_group');
  await assert.rejects(first.input(ref, 'steer', prompt('unsupported'), guard('claude-steer', generation)), hasCode('unsupported'));
  await first.close({ detachOnly: true });
  assert.deepEqual(worker.log(), [{ opened: true, hooks: false }]);
  const second = newPort();
  const later = watch(second);
  const attached = await second.attachHosted(ref, { instanceId: request.event.instanceId, seq: 0 });
  assert.equal(attached.mode, 'snapshot');
  const data = turnData(attached);
  assert.equal(data.activeTurnId, run.nativeReference);
  assert.deepEqual(data.interactions, [original]);
  assert.ok(data.messages.some(m => m.blocks[0]?.type === 'text' && m.blocks[0].text === 'Claude partial'));
  await second.commitAck(ref, attached.barrierSeq);
  assert.equal((await second.resume(ref)).connectionGeneration, generation);
  const answer: Answer = { kind: 'question_group', answers: { '0': ['A'] } };
  await second.respond(ref, original, answer, guard('claude-answer', generation));
  await second.respond(ref, original, answer, guard('claude-answer', generation));
  await until(() => complete(later, run.nativeReference), 'Claude result');
  assert.equal(worker.log().filter(row => row.decision).length, 1);
  assert.deepEqual(worker.log().find(row => row.decision), {
    decision: { behavior: 'allow', updatedInput: {
      questions: [{ question: 'Which option?', options: [{ label: 'A' }] }], answers: { 'Which option?': 'A' },
    } }, aborted: false,
  });
  assert.equal(worker.log().some(row => row.closed), false);
  assert.ok(f.registry.getClaudeOwnership(ref.nativeSessionId), 'SDK state uses the shared registry');
});

test('Claude ownership and aliases import atomically and retain concurrent process writes', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const dir = join(f.stateDir, 'claude-state');
  const legacy = new ClaudeState(dir, hostId, serviceId);
  legacy.put('legacy', { origin: 'external_resume' });
  const legacyGeneration = legacy.nextGeneration();
  legacy.linkMessage('legacy', 'old-outer', 'old-inner', legacyGeneration, 'legacy-turn');
  const stateUrl = new URL('../src/unified/claude-state.js', import.meta.url).href;
  const child = `
    import { ClaudeState } from ${JSON.stringify(stateUrl)};
    import { writeFileSync } from 'node:fs';
    const [dir, registryPath, name, output] = process.argv.slice(1);
    const state = new ClaudeState(dir, ${JSON.stringify(hostId)}, ${JSON.stringify(serviceId)}, { registryPath });
    const generations = [];
    for (let i = 0; i < 50; i++) {
      const id = name + '-' + i;
      state.put(id, { origin: 'bridge_sdk' });
      const generation = state.nextGeneration();
      generations.push(generation);
      state.linkMessage(id, 'outer', 'inner-' + generation, generation, id);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    state.close();
    writeFileSync(output, JSON.stringify(generations), { mode: 0o600 });
  `;
  const exec = promisify(execFile);
  const names = ['one', 'two'];
  const generations = await Promise.all(names.map(async name => {
    const output = join(f.stateDir, name + '.json');
    await exec(process.execPath, ['--no-warnings', '--input-type=module', '-e', child, dir, f.registry.path, name, output]);
    return JSON.parse(readFileSync(output, 'utf8')) as number[];
  }));
  assert.deepEqual(generations.flat().sort((a, b) => a - b), Array.from({ length: 100 }, (_, n) => n + 2));
  for (const values of generations) assert.ok(values.every((n, i) => !i || n > values[i - 1]!));
  const state = new ClaudeState(dir, hostId, serviceId, { registry: f.registry });
  for (const [n, name] of names.entries()) {
    for (const [i, generation] of generations[n]!.entries()) {
      const id = name + '-' + i;
      assert.equal(state.get(id)?.origin, 'bridge_sdk');
      assert.deepEqual(state.messageLink(id, 'outer'), { id: 'inner-' + generation, generation, turnId: id });
    }
  }
  assert.equal(state.get('legacy')?.origin, 'external_resume');
  assert.equal(state.messageAlias('legacy', 'old-outer'), 'old-inner');
  assert.throws(() => state.linkMessage('legacy', 'old-outer', 'different', 102), hasCode('idempotency_conflict'));
  assert.throws(() => state.linkMessage('legacy', 'old-outer', 'old-inner', 102, 'different-turn'), hasCode('idempotency_conflict'));
  state.close();
  const ownedFile = join(dir, 'claude-owned.json');
  const aliasFile = join(dir, 'claude-message-aliases-v1.json');
  const originalOwned = readFileSync(ownedFile, 'utf8');
  const originalAliases = readFileSync(aliasFile, 'utf8');
  writeFileSync(ownedFile, '{invalid');
  const reopened = new ClaudeState(dir, hostId, serviceId, { registry: f.registry });
  assert.equal(reopened.nextGeneration(), 102);
  reopened.close();
  const freshPath = join(f.stateDir, 'fresh.sqlite');
  assert.throws(() => new ClaudeState(dir, hostId, serviceId, { registryPath: freshPath }), hasCode('temporarily_unavailable'));
  writeFileSync(ownedFile, originalOwned);
  writeFileSync(aliasFile, '{invalid');
  assert.throws(() => new ClaudeState(dir, hostId, serviceId, { registryPath: freshPath }), hasCode('temporarily_unavailable'));
  writeFileSync(aliasFile, originalAliases);
  const repaired = new ClaudeState(dir, hostId, serviceId, { registryPath: freshPath });
  assert.equal(repaired.messageAlias('legacy', 'old-outer'), 'old-inner');
  repaired.close();
  const db = new DatabaseSync(f.registry.path, { readOnly: true });
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

interface PeerSocket {
  send(text: string): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  terminate(): void;
}
interface PeerServer extends NodeJS.EventEmitter {
  address(): { port: number };
  on(event: 'connection', listener: (socket: PeerSocket) => void): this;
  close(callback: () => void): void;
}
const { WebSocketServer } = createRequire(import.meta.url)('ws') as {
  WebSocketServer: new (options: { host: string; port: number }) => PeerServer;
};

async function codexPeer(t: TestContext, project: string) {
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets = new Set<PeerSocket>();
  const messages: Fields[] = [];
  const turns = new Map<string, { id: string; status: string; items: Fields[] }>();
  const thread = (id: string) => ({
    id, cwd: project, name: 'Codex fixture', status: { type: turns.get(id)?.status === 'inProgress' ? 'active' : 'idle' },
    turns: turns.has(id) ? [turns.get(id)] : [],
  });
  const approve = (send: (message: Fields) => void, threadId: string, turnId: string, id: string) => send({
    id, method: 'item/commandExecution/requestApproval',
    params: { threadId, turnId, itemId: 'approval-item', command: 'true', availableDecisions: ['accept', 'decline'] },
  });
  const completeTurn = (send: (message: Fields) => void, threadId: string) => {
    const turn = turns.get(threadId)!;
    turn.status = 'completed';
    send({ method: 'turn/completed', params: { threadId, turn } });
  };
  ws.on('connection', socket => {
    sockets.add(socket);
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as Fields;
      messages.push(message);
      const { method, id } = message;
      const params = message.params as Fields | undefined;
      const send = (value: Fields) => socket.send(JSON.stringify(value));
      const reply = (result: Fields) => send({ id, result });
      if (method === 'initialize') reply({});
      if (method === 'thread/start') reply({ thread: thread('codex-created') });
      if (method === 'thread/read') reply({ thread: thread(String(params?.threadId)) });
      if (method === 'thread/resume') {
        const threadId = String(params?.threadId);
        const turn = { id: 'cold-turn', status: 'inProgress', items: [{ id: 'cold-message', type: 'agentMessage', text: 'cold prefix and tail' }] };
        turns.set(threadId, turn);
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'cold-message', delta: 'tail' } });
        approve(send, threadId, turn.id, 'cold-permission');
        completeTurn(send, threadId);
        setTimeout(() => {
          reply({ thread: thread(threadId) });
          completeTurn(send, threadId);
        }, 25);
      }
      if (method === 'turn/start') {
        const threadId = String(params?.threadId);
        const turn = { id: 'live-turn', status: 'inProgress', items: [] };
        turns.set(threadId, turn);
        send({ method: 'turn/started', params: { threadId, turn } });
        reply({ turn });
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'live-message', delta: 'Codex partial' } });
        approve(send, threadId, turn.id, 'live-permission');
      }
      if (method === 'turn/steer') reply({ turnId: params?.expectedTurnId });
      if (id === 'live-permission' || id === 'cold-permission') {
        const threadId = id === 'live-permission' ? 'codex-created' : 'cold-thread';
        send({ method: 'serverRequest/resolved', params: { threadId, requestId: id } });
        if (id === 'live-permission') completeTurn(send, threadId);
      }
    });
  });
  await once(ws, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(done => ws.close(done));
  });
  return { endpoint: 'ws://127.0.0.1:' + ws.address().port, messages };
}

test('Codex hot attach preserves its socket and native RPC request and sends chunked steer input', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const peer = await codexPeer(t, f.stateDir);
  const newPort = () => f.port(new CodexAdapter(new CodexTransport(peer.endpoint), hostId, serviceId), {
    codexEndpoint: peer.endpoint, approvalPolicy: { enabled: false },
  });
  const first = newPort();
  const initial = watch(first);
  const created = await first.create(f.stateDir, null, 'create-codex');
  const ref = created.createdSession!.native;
  const generation = created.connectionGeneration!;
  const run = await first.input(ref, 'new', prompt('Codex approval'), guard('codex-input', generation));
  const request = await until(() => pending(initial), 'Codex approval');
  assert.equal(request.observation.type, 'interaction');
  await first.close({ detachOnly: true });
  const second = newPort();
  const after = watch(second);
  const attached = await second.attachHosted(ref, null);
  assert.equal(attached.instanceId, request.event.instanceId);
  const approval = turnData(attached).interactions[0]!;
  assert.deepEqual(approval, request.observation.interaction);
  await second.commitAck(ref, attached.barrierSeq);
  assert.equal((await second.resume(ref)).connectionGeneration, generation);
  const text = 'x'.repeat(900_000);
  assert.equal((await second.input(ref, 'steer', [{
    type: 'artifact', artifactId: 'file', contentVersion: 'one', name: 'fixture.txt', mediaType: 'text/plain', content: Buffer.from(text),
  }], guard('codex-steer', generation), 'live-turn')).nativeReference, 'live-turn');
  const steered = peer.messages.find(message => message.method === 'turn/steer')?.params as { input: Array<{ text: string }> };
  assert.equal(steered.input[0]!.text, 'File content ("fixture.txt"):\n' + text);
  await second.respond(ref, approval, allow, guard('codex-allow', generation));
  await second.respond(ref, approval, allow, guard('codex-allow', generation));
  await until(() => complete(after, run.nativeReference), 'Codex completion');
  assert.equal(peer.messages.filter(m => m.method === 'initialize').length, 1);
  assert.equal(peer.messages.filter(m => m.method === 'thread/resume').length, 0);
  assert.deepEqual(peer.messages.filter(m => m.id === 'live-permission'), [{ id: 'live-permission', result: { decision: 'accept' } }]);
});

test('Codex cold resume delivers a delta, approval and terminal exactly once before reconciling history', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const peer = await codexPeer(t, f.stateDir);
  const port = f.port(new CodexAdapter(new CodexTransport(peer.endpoint), hostId, serviceId), {
    codexEndpoint: peer.endpoint, approvalPolicy: { enabled: false },
  });
  const events = watch(port);
  const ref = native('codex', 'cold-thread');
  const resumed = await port.resume(ref);
  await until(() => complete(events, 'cold-turn'), 'cold resume terminal turn');
  const observedTypes = events.map(({ observation }) => observation.type);
  assert.deepEqual(observedTypes, ['message', 'interaction', 'turn']);
  const delta = events[0]?.observation;
  assert.equal(delta?.type, 'message');
  assert.deepEqual(delta.message.blocks, [{ type: 'text', text: 'cold prefix and tail' }]);
  const request = pending(events)?.observation;
  assert.equal(request?.type, 'interaction');
  const snapshot = await port.attachHosted(ref, null);
  const data = turnData(snapshot);
  assert.equal(data.activeTurnId, null);
  assert.deepEqual(data.interactions, [request.interaction]);
  assert.equal(data.turns.filter(turn => turn.status === 'completed').length, 1);
  assert.equal(data.messages.length, 1);
  assert.deepEqual(data.messages[0]?.blocks, [{ type: 'text', text: 'cold prefix and tail' }]);
  await port.commitAck(ref, snapshot.barrierSeq);
  await port.respond(ref, request.interaction, allow, guard('cold-allow', resumed.connectionGeneration!, data.controlGeneration));
  await until(() => peer.messages.find(message => message.id === 'cold-permission'), 'cold approval reply');
  assert.equal(peer.messages.filter(message => message.method === 'thread/resume').length, 1);
});
