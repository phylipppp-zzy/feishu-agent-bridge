import assert from 'node:assert/strict';
import { chmodSync, chownSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { collectSnapshot, SessionHostClient, type ClientOptions, type HostEvent } from '../src/unified/session-host/client.js';
import { SessionHostJournal } from '../src/unified/session-host/journal.js';
import {
  chunkPayload, commandDigest, currentUid, handshakeMac, HostError, joinChunks, json, MAX_FRAME_BYTES, nonce, object,
  privateDirectory, rpcRequest, RpcWire, runtimePaths, sessionKey, sha256, writePrivateAtomic,
  type Fields, type HostRef, type RpcMessage,
} from '../src/unified/session-host/protocol.js';
import { SessionHostRegistry } from '../src/unified/session-host/registry.js';
import {
  idleRunnerState, SessionHostServer, type SessionHostRunner, type SessionHostServerOptions,
} from '../src/unified/session-host/server.js';

const ref: HostRef = ['mock', 'test-host', 'test-service', 'native'];
const instanceId = 'test-instance';
const key = sessionKey(ref);
const hasCode = (code: string) => (error: unknown) => error instanceof HostError && error.code === code;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('condition timed out');
    await sleep(10);
  }
}

async function fixture(
  t: TestContext,
  overrides: Partial<Pick<SessionHostServerOptions, 'maxRingEntries' | 'maxRingBytes' | 'snapshotPageBytes' | 'heartbeatMs'>> = {},
  runner?: SessionHostRunner,
) {
  const dir = mkdtempSync(join(tmpdir(), 'fshi-'));
  const runtimeDir = join(dir, 'run');
  const paths = runtimePaths(runtimeDir, key);
  privateDirectory(runtimeDir, true);
  const secret = nonce();
  writePrivateAtomic(paths.secret, secret);
  const journal = new SessionHostJournal(dir, key);
  const registry = new SessionHostRegistry(dir);
  const server = new SessionHostServer({
    runtimeDir, key, ref, instanceId, releaseDir: dir, secret: Buffer.from(secret, 'hex'), journal,
    runner: runner ?? {
      capabilities: { steer: 'unsupported' },
      execute: (command, context) => {
        const data = {
          args: command.args,
          attachment: command.attachment ? { byteLength: command.attachment.byteLength, sha256: sha256(command.attachment) } : null,
        };
        context.emit(data, { terminal: command.kind === 'terminal' });
        return data;
      },
    },
    ...overrides,
  });
  const clients: SessionHostClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
    registry.close();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await server.listen();
  const connect = async (options: Partial<ClientOptions> = {}) => {
    const client = await SessionHostClient.connect({
      runtimeDir, key, clientId: 'bridge', bridgeEpoch: registry.allocateBridgeEpoch(), expectedRef: ref, ...options,
    });
    clients.push(client);
    return client;
  };
  return { dir, runtimeDir, paths, secret, journal, registry, server, connect };
}

function rawPeer(t: TestContext, path: string) {
  const socket = createConnection(path);
  const responses: RpcMessage[] = [];
  let failure: Error | undefined;
  socket.on('error', error => { failure = error; });
  t.after(() => socket.destroy());
  const wire = new RpcWire(socket, message => responses.push(message), error => { failure = error; }, () => true);
  let nextId = 0;
  return {
    socket, responses,
    async request(method: string, params: Fields) {
      const id = ++nextId;
      wire.send(rpcRequest(id, method, params));
      await waitFor(() => failure !== undefined || responses.some(message => message.id === id));
      if (failure) throw failure;
      const response = responses.find(message => message.id === id);
      if (!response || 'method' in response) throw new Error('missing response');
      if ('error' in response) throw new HostError(response.error.code, response.error.message);
      return response.result;
    },
  };
}

test('authenticates both peers, rejects reused or forged challenges, and keeps hello read-only', async t => {
  const { paths, secret, connect, journal } = await fixture(t);
  const client = await connect({ bridgeEpoch: 10 });
  assert.equal(client.hello.instanceId, instanceId);
  assert.equal(journal.getState('bridgeEpoch'), undefined);
  assert.equal((await client.attach()).mode, 'snapshot');
  assert.equal(journal.getState('bridgeEpoch'), 10);

  const clientNonce = nonce();
  const params = { versions: [1], clientId: 'raw', bridgeEpoch: 11, key, clientNonce };
  const raw = rawPeer(t, paths.socket);
  await assert.rejects(raw.request('command', { lease: 'fake' }), hasCode('unauthorized'));
  const hello = object(await raw.request('hello', params));
  const hostNonce = String(hello.hostNonce);
  const attach = { instanceId, clientId: 'raw', bridgeEpoch: 11, lastSeq: null, expectedRef: ref };
  await assert.rejects(raw.request('attach', { ...attach, clientMac: '00'.repeat(32) }), hasCode('unauthorized'));
  const correct = handshakeMac(Buffer.from(secret, 'hex'), 'client', { ...params, instanceId, hostNonce });
  await assert.rejects(raw.request('attach', { ...attach, clientMac: correct }), hasCode('unauthorized'));
  await assert.rejects(raw.request('hello', { ...params, clientNonce: nonce() }), hasCode('unauthorized'));

  await assert.rejects(rawPeer(t, paths.socket).request('hello', params), hasCode('unauthorized'));
  const forged = rawPeer(t, paths.socket);
  const fresh = { ...params, clientNonce: nonce() };
  await forged.request('hello', fresh);
  await assert.rejects(forged.request('attach', {
    ...attach, clientMac: handshakeMac(Buffer.from(secret, 'hex'), 'client', { ...fresh, instanceId, hostNonce }),
  }), hasCode('unauthorized'));
  await assert.rejects(rawPeer(t, paths.socket).request('hello', { ...fresh, versions: [2] }), hasCode('version_mismatch'));
  assert.equal(journal.getState('bridgeEpoch'), 10);
  await client.ping();

  writePrivateAtomic(paths.secret, nonce());
  await assert.rejects(connect(), hasCode('unauthorized'));
});

test('enforces runtime ownership, private modes, symlink rejection and UTF-8 socket path limit', async t => {
  const { paths, connect, runtimeDir, dir } = await fixture(t);
  assert.equal(lstatSync(paths.socket).mode & 0o777, 0o600);
  assert.equal(lstatSync(paths.secret).mode & 0o777, 0o600);
  chmodSync(paths.secret, 0o640);
  await assert.rejects(connect(), hasCode('unauthorized'));
  chmodSync(paths.secret, 0o600);
  chmodSync(paths.socket, 0o660);
  await assert.rejects(connect(), hasCode('unauthorized'));
  chmodSync(paths.socket, 0o600);
  chmodSync(runtimeDir, 0o750);
  await assert.rejects(connect(), hasCode('unauthorized'));
  chmodSync(runtimeDir, 0o700);

  const link = join(dir, 'link');
  symlinkSync(runtimeDir, link);
  await assert.rejects(connect({ runtimeDir: link }), hasCode('unauthorized'));
  assert.throws(() => runtimePaths(join(dir, '界'.repeat(24)), key), /90 UTF-8 bytes/);

  const uid = currentUid();
  if (uid === 0) {
    chownSync(paths.secret, 65534, 65534);
    await assert.rejects(connect(), hasCode('unauthorized'));
    chownSync(paths.secret, 0, 0);
  } else {
    const foreignDir = ['/root', '/etc', '/usr', '/var'].find(candidate => {
      const stat = lstatSync(candidate, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) return false;
      if (candidate === '/root') assert.equal(stat.mode & 0o777, 0o700);
      return stat.uid !== uid;
    });
    assert.ok(foreignDir, 'expected a directory owned by another UID');
    assert.throws(() => privateDirectory(foreignDir), hasCode('unauthorized'));
  }
});

test('rejects oversized frames, invalid UTF-8, and malformed JSON over Unix sockets', async t => {
  const { paths, connect } = await fixture(t);
  for (const [bytes, message] of [
    [Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61), /frame exceeds/],
    [Buffer.from([0xc0, 0xaf, 10]), /invalid UTF-8/],
    [Buffer.from('{"jsonrpc":\n'), /malformed JSON/],
  ] as const) {
    const raw = rawPeer(t, paths.socket);
    raw.socket.write(bytes);
    await waitFor(() => raw.responses.length > 0);
    const response = raw.responses[0]!;
    assert.ok('error' in response);
    assert.equal(response.id, null);
    assert.equal(response.error.code, 'invalid_request');
    assert.match(response.error.message, message);
  }
  assert.equal((await connect()).hello.instanceId, instanceId);
});

test('serializes a running command and concurrent takeovers, then fences older and same-epoch foreign clients', async t => {
  let entered = false;
  let finish!: () => void;
  const running = new Promise<void>(resolve => { finish = resolve; });
  t.after(finish);
  let executions = 0;
  const { connect } = await fixture(t, {}, {
    capabilities: { steer: 'unsupported' },
    execute: async () => {
      executions++;
      entered = true;
      await running;
      return { passed: true };
    },
  });
  const first = await connect({ bridgeEpoch: 1, clientId: 'first' });
  await first.attach();
  await first.snapshot();
  const inFlight = first.command('write', 'echo', null);
  await waitFor(() => entered);
  assert.deepEqual(await first.shutdown('test in-flight'), { outcome: 'busy', reason: 'in-flight command' });
  const next = await connect({ bridgeEpoch: 2, clientId: 'second' });
  const newest = await connect({ bridgeEpoch: 3, clientId: 'third' });
  let attached = false;
  const takeovers = Promise.allSettled([
    next.attach().then(result => { attached = true; return result; }),
    newest.attach().then(result => { attached = true; return result; }),
  ]);
  await sleep(20);
  assert.equal(attached, false);
  finish();
  assert.equal((await inFlight).state, 'terminal');
  assert.equal((await takeovers)[1]?.status, 'fulfilled');
  await assert.rejects(first.command('late', 'echo', null), hasCode('fenced'));
  await assert.rejects(first.detach(), hasCode('fenced'));
  await assert.rejects(next.detach(), hasCode('fenced'));
  for (const [bridgeEpoch, clientId] of [[2, 'second'], [3, 'foreign']] as const) {
    await assert.rejects((await connect({ bridgeEpoch, clientId })).attach(), hasCode('fenced'));
  }
  const resumed = await connect({ bridgeEpoch: 3, clientId: 'third' });
  await resumed.attach();
  assert.equal((await resumed.receipt('write')).state, 'terminal');
  assert.equal(executions, 1);
});

test('three missed heartbeats revoke only the lease and allow replay on the same instance', async t => {
  const { connect, server } = await fixture(t, { heartbeatMs: 30 });
  let fenced = false;
  const unresponsive = await connect({ heartbeatMs: false, onError: error => { fenced = error.code === 'fenced'; } });
  await unresponsive.attach();
  await unresponsive.snapshot();
  await waitFor(() => fenced);
  await assert.rejects(unresponsive.ping(), hasCode('fenced'));
  server.publish({ type: 'while-detached' });
  const events: HostEvent[] = [];
  const resumed = await connect({ cursor: unresponsive.cursor, heartbeatMs: 20, onEvent: event => events.push(event) });
  assert.equal((await resumed.attach()).mode, 'replay');
  await waitFor(() => events.length === 1);
  assert.deepEqual(events[0]?.observation, { type: 'while-detached' });
  assert.equal(resumed.hello.instanceId, instanceId);
});

test('evicts by entry count and byte budget with durable snapshot and monotonic live continuation', async t => {
  for (const [name, limits] of [
    ['entry count', { maxRingEntries: 2, maxRingBytes: 1_000_000 }],
    ['byte budget', { maxRingEntries: 500, maxRingBytes: 240 }],
  ] as const) {
    await t.test(name, async child => {
      const { connect, server, journal } = await fixture(child, { ...limits, snapshotPageBytes: 240 });
      const client = await connect();
      await client.attach();
      await client.snapshot();
      const first = await client.command('same-id', 'terminal', { status: 'done' });
      assert.deepEqual(await client.command('same-id', 'terminal', { status: 'done' }), first);
      assert.deepEqual(await client.receipt('same-id'), first);
      assert.deepEqual(await client.receipt('absent'), { state: 'absent' });
      await assert.rejects(client.command('same-id', 'terminal', { status: 'changed' }), hasCode('invalid_request'));
      for (let i = 0; i < 4; i++) server.publish({ i, text: 'x'.repeat(106) });
      assert.equal(journal.listUnackedEvents(instanceId).length, 5);
      assert.equal(journal.hasUnackedTerminal(), true);
      await client.detach();

      const live: HostEvent[] = [];
      const resumed = await connect({ cursor: { instanceId, seq: 0 }, onEvent: event => live.push(event) });
      const attach = await resumed.attach();
      assert.equal(attach.mode, 'snapshot');
      assert.ok(attach.firstSeq > 1);
      if (name === 'entry count') assert.equal(attach.firstSeq, 4);
      if (name === 'byte budget') assert.ok(attach.firstSeq >= 5);
      server.publish({ type: 'after-barrier' });
      assert.equal(resumed.cursor?.seq, 0);
      const snapshot = await resumed.snapshot();
      assert.equal(snapshot.barrierSeq, 5);
      assert.equal(snapshot.events.length, 5);
      assert.equal(snapshot.events[0]?.terminal, true);
      assert.deepEqual(snapshot.events[0]?.observation, first.receipt);
      await waitFor(() => live.length === 1);
      assert.equal(live[0]?.seq, 6);
      assert.equal(await resumed.ack(), 6);
      assert.equal(await resumed.ack(4), 6);
      assert.equal(journal.hasUnackedTerminal(), false);
    });
  }
});

test('rejects tampered snapshot pages and digest without committing the cursor, then releases verified buffered events', async t => {
  const { dir, paths, secret, server } = await fixture(t, { maxRingEntries: 1, snapshotPageBytes: 240 });
  const proxyDir = privateDirectory(join(dir, 'proxy'), true);
  const proxyPaths = runtimePaths(proxyDir, key);
  writePrivateAtomic(proxyPaths.secret, secret);
  const sockets = new Set<Socket>();
  let tamper: 'page' | 'digest' | null = 'page';
  let totalPages = 0;
  const proxy = createServer(downstream => {
    const upstream = createConnection(paths.socket);
    for (const socket of [upstream, downstream]) {
      sockets.add(socket);
      socket.on('error', error => {
        if (!('code' in error) || error.code !== 'ECONNRESET') throw error;
      });
      socket.once('close', () => sockets.delete(socket));
    }
    downstream.once('close', () => upstream.destroy());
    upstream.once('close', () => downstream.destroy());
    const snapshotIds = new Set<number | string>();
    const clientWire = new RpcWire(downstream, message => {
      if ('method' in message && message.method === 'snapshot' && message.id !== undefined) snapshotIds.add(message.id);
      hostWire.send(message);
    }, error => { throw error; }, () => true);
    const hostWire = new RpcWire(upstream, message => {
      if ('result' in message && snapshotIds.delete(message.id)) {
        const page = object(message.result);
        totalPages = Number(page.totalPages);
        if (tamper === 'page' && page.page === 1) page.items = [{ type: 'event', value: null }];
        if (tamper === 'digest' && 'digest' in page) page.digest = '00'.repeat(32);
      }
      clientWire.send(message);
    }, error => { throw error; }, () => true);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  });
  await new Promise<void>(resolve => proxy.listen(proxyPaths.socket, resolve));
  chmodSync(proxyPaths.socket, 0o600);
  for (let i = 0; i < 4; i++) server.publish({ text: 'a'.repeat(400), i });
  server.publish({ text: '大'.repeat(400_000) });
  const emitted: HostEvent[] = [];
  const cursor = { instanceId: 'old-instance', seq: 3 };
  const client = await SessionHostClient.connect({
    runtimeDir: proxyDir, key, clientId: 'proxy-bridge', bridgeEpoch: 1, expectedRef: ref, cursor,
    onEvent: event => emitted.push(event),
  });
  t.after(() => client.close());
  assert.equal((await client.attach()).mode, 'snapshot');
  server.publish({ after: true });
  await assert.rejects(client.snapshot(), hasCode('snapshot_required'));
  assert.ok(totalPages > 2);
  assert.deepEqual(client.cursor, cursor);
  assert.equal(emitted.length, 0);
  tamper = 'digest';
  await assert.rejects(client.snapshot(), hasCode('snapshot_required'));
  assert.deepEqual(client.cursor, cursor);
  await assert.rejects(client.ack(), hasCode('snapshot_required'));
  tamper = null;
  const snapshot = await client.snapshot();
  assert.equal(snapshot.barrierSeq, 5);
  assert.equal(object(snapshot.events[4]?.observation).text, '大'.repeat(400_000));
  await waitFor(() => emitted.length === 1);
  assert.equal(emitted[0]?.seq, 6);
});

test('transfers chunked binary attachments and large JSON payloads and rejects corrupt bytes before execution', async t => {
  const { connect, paths } = await fixture(t);
  const client = await connect();
  await client.attach();
  await client.snapshot();
  const payload = Buffer.alloc(MAX_FRAME_BYTES + 97, 0xe7);
  const result = await client.command('large', 'echo', { text: 'z'.repeat(MAX_FRAME_BYTES + 1) }, payload);
  assert.deepEqual(object(result.receipt).attachment, { byteLength: payload.length, sha256: sha256(payload) });
  assert.equal(String(object(object(result.receipt).args).text).length, MAX_FRAME_BYTES + 1);

  const raw = rawPeer(t, paths.socket);
  // Use a second real authenticated socket to send corrupted attachment chunks.
  const handshake = { versions: [1], clientId: 'chunk-tester', bridgeEpoch: 10, key, clientNonce: nonce() };
  const hello = object(await raw.request('hello', handshake));
  const secret = (await import('node:fs')).readFileSync(paths.secret, 'utf8');
  const grant = object(await raw.request('attach', {
    ...handshake, instanceId, lastSeq: null, expectedRef: ref,
    clientMac: handshakeMac(Buffer.from(secret, 'hex'), 'client', { ...handshake, instanceId, hostNonce: String(hello.hostNonce) }),
  }));
  const chunks = chunkPayload(payload);
  assert.ok(chunks.length > 1);
  const first = chunks[0]!;
  first.dataBase64 = 'AAAA' + first.dataBase64.slice(4);
  await assert.rejects(raw.request('command', {
    ...grant, operationId: 'bad-chunk', kind: 'echo', args: null, attachment: chunks,
    ref, digest: commandDigest('echo', null, payload),
  }), /chunk payload integrity failure/);
  assert.deepEqual(await raw.request('receipt', { lease: grant.lease, operationId: 'bad-chunk' }), { state: 'absent' });
});

test('shutdown and retired-release GC wait for turns, interactions, residuals, wakeups, subagents, and terminal ack', async t => {
  const { connect, server, journal } = await fixture(t);
  const client = await connect();
  await client.attach();
  await client.snapshot();
  for (const [state, reason] of [
    [{ activeTurn: true }, 'active turn'],
    [{ pendingInteraction: { id: 'pending' } }, 'pending interaction'],
    [{ pendingWakeup: true }, 'pending wakeup'],
    [{ pendingSubagent: true }, 'pending subagent'],
    [{ residual: 'unknown' as const }, 'residual unknown'],
  ] as const) {
    const seq = server.publish({ reason }, { state: { ...idleRunnerState, ...state } });
    await waitFor(() => client.cursor?.seq === seq);
    assert.deepEqual(await client.shutdown('retire'), { outcome: 'busy', reason });
  }
  const seq = server.publish({ done: true }, { terminal: true, state: { ...idleRunnerState } });
  await waitFor(() => client.cursor?.seq === seq);
  assert.deepEqual(await client.shutdown('retire'), { outcome: 'busy', reason: 'unacked terminal state' });
  server.markReleaseRetired();
  assert.equal(journal.hasUnackedTerminal(), true);
  assert.equal(await client.ack(), seq);
  await server.closed;
  assert.equal(journal.hasUnackedTerminal(), false);
});

test('verifies chunk byte count, hash and sequence and authenticates the snapshot digest offline', async () => {
  const bytes = Buffer.alloc(MAX_FRAME_BYTES + 1, 0x42);
  const chunks = chunkPayload(bytes);
  assert.deepEqual(joinChunks(chunks), bytes);
  assert.throws(() => joinChunks(chunks.slice(0, -1)), /incomplete chunk payload/);
  assert.throws(() => joinChunks([...chunks].reverse()), /invalid chunk sequence/);
  const first = chunks[0]!;
  assert.throws(() => joinChunks([{ ...first, dataBase64: 'AAAA' + first.dataBase64.slice(4) }, ...chunks.slice(1)]),
    /chunk payload integrity failure/);

  const items = [
    { type: 'state', value: idleRunnerState, ref },
    { type: 'event', value: { instanceId, seq: 1, terminal: true, observation: { completed: true } } },
  ];
  const fetch = (digest: string) => async (page: number, snapshotId?: string) => {
    assert.equal(snapshotId, page === 0 ? undefined : 'snapshot-test');
    return {
      snapshotId: 'snapshot-test', barrierSeq: 1, totalPages: 2, page, items: [items[page]],
      ...(page === 1 ? { digest } : {}),
    };
  };
  await assert.rejects(collectSnapshot(fetch('00'.repeat(32)), instanceId, 1), hasCode('snapshot_required'));
  const snapshot = await collectSnapshot(fetch(sha256(json(items))), instanceId, 1);
  assert.equal(snapshot.events[0]?.terminal, true);
});
