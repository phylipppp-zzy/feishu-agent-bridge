import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SessionHostClient, type HostEvent } from '../src/unified/session-host/client.js';
import { SessionHostJournal } from '../src/unified/session-host/journal.js';
import {
  acquireFileLock, isStampedProcessAlive, processStamp, SessionHostLauncher,
} from '../src/unified/session-host/launcher.js';
import {
  currentUid, HostError, json, object, privateDirectory, readMetadata, runtimePaths,
  sessionKey, sha256, writePrivateAtomic, type HostMetadata, type HostRef,
} from '../src/unified/session-host/protocol.js';
import { SessionHostRegistry } from '../src/unified/session-host/registry.js';

const entry = fileURLToPath(new URL('../src/unified/session-host/host-main.js', import.meta.url));
const releaseDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ref: HostRef = ['echo', 'local', 'launcher-test', 'native'];
const hasCode = (code: string) => (error: unknown) => error instanceof HostError && error.code === code;

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('condition timed out');
    await sleep(20);
  }
}

function testFixture(t: TestContext, config: Record<string, number> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'fshl-'));
  const runtimeDir = privateDirectory(join(stateDir, 'run'), true);
  const configFile = join(stateDir, 'provider.json');
  writePrivateAtomic(configFile, json(config));
  const registry = new SessionHostRegistry(stateDir);
  const key = sessionKey(ref);
  const paths = runtimePaths(runtimeDir, key);
  const options = { stateDir, runtimeDir, releaseDir, hostEntryScript: entry, configFile, allowDetachedFallback: true };
  const children = new Set<ChildProcess>();
  const clients = new Set<SessionHostClient>();
  t.after(async () => {
    for (const client of clients) client.close();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    const active = registry.listActiveInstances();
    for (const process of active) {
      if (isStampedProcessAlive(process)) globalThis.process.kill(process.pid, 'SIGKILL');
    }
    await waitFor(() => active.every(process => !isStampedProcessAlive(process)));
    registry.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  const env = { ...process.env, NODE_ENV: 'test', NODE_OPTIONS: '', FEISHU_SESSION_HOST_ALLOW_TEST_RUNNER: '1' };
  const spawnScript = (script: string, argument: unknown) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, json(argument)], {
      stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    children.add(child);
    return child;
  };
  const openClient = async (
    metadata: HostMetadata, onEvent?: (event: HostEvent) => void, cursor?: { instanceId: string; seq: number },
    targetKey = key, expectedRef: HostRef | null = ref,
  ) => {
    const client = await SessionHostClient.connect({
      runtimeDir, key: targetKey, clientId: 'second-bridge', bridgeEpoch: registry.allocateBridgeEpoch(),
      expectedRef, ...(onEvent ? { onEvent } : {}), ...(cursor ? { cursor } : {}),
    });
    assert.equal(client.hello.instanceId, metadata.instanceId);
    clients.add(client);
    return client;
  };
  return { stateDir, runtimeDir, registry, key, paths, options, spawnScript, openClient };
}

async function lineFrom(child: ChildProcess): Promise<string> {
  let output = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  await waitFor(() => output.includes('\n') || child.exitCode !== null || child.signalCode !== null, 12_000);
  const end = output.indexOf('\n');
  if (end < 0) throw new Error('child exited before readiness: ' + stderr);
  return output.slice(0, end);
}

const launcherUrl = new URL('../src/unified/session-host/launcher.js', import.meta.url).href;
const clientUrl = new URL('../src/unified/session-host/client.js', import.meta.url).href;
const registryUrl = new URL('../src/unified/session-host/registry.js', import.meta.url).href;

test('a detached host survives bridge SIGKILL, replays the offline event and resolves the pending question once', { timeout: 20_000 }, async t => {
  const { registry, paths, key, options, spawnScript, openClient, stateDir } = testFixture(t);
  const bus = spawnSync('/usr/bin/systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 1000 });
  const parent = spawnScript(`
    import { SessionHostLauncher } from ${JSON.stringify(launcherUrl)};
    import { SessionHostClient } from ${JSON.stringify(clientUrl)};
    import { SessionHostRegistry } from ${JSON.stringify(registryUrl)};
    const { options, ref } = JSON.parse(process.argv[1]);
    const [{ key, metadata }, duplicate] = await Promise.all([
      new SessionHostLauncher(options).launch(ref), new SessionHostLauncher(options).launch(ref)
    ]);
    if (duplicate.metadata.pid !== metadata.pid) throw new Error('concurrent launch started two hosts');
    const registry = new SessionHostRegistry(options.stateDir);
    const bridgeEpoch = registry.allocateBridgeEpoch();
    registry.close();
    const client = await SessionHostClient.connect({
      runtimeDir: options.runtimeDir, key, bridgeEpoch, clientId: 'first-bridge', expectedRef: ref,
    });
    await client.attach();
    await client.snapshot();
    await client.command('question', 'pending', { id: 'user-question', prompt: 'Continue?' });
    await client.command('schedule', 'schedule', { delayMs: 1200, value: 'arrived offline' });
    console.log(JSON.stringify({ key, metadata, cursor: client.cursor, bridgeEpoch }));
    setInterval(() => {}, 1000);
  `, { options: { ...options, detachedOnly: bus.status === 0 }, ref });
  const first = object(JSON.parse(await lineFrom(parent)) as unknown);
  const metadata = readMetadata(paths.metadata);
  assert.deepEqual(first.metadata, metadata);
  assert.equal(metadata.unit, null);
  assert.equal(first.key, key);
  assert.notEqual(parent.pid, metadata.pid);
  assert.ok(isStampedProcessAlive(metadata));
  assert.equal(acquireFileLock(paths.lock), null);
  const [pin] = registry.listActivePins();
  assert.equal(pin?.releaseDir, releaseDir);
  assert.ok(pin!.createdAt <= metadata.startedAt);
  for (const path of [paths.metadata, paths.secret, paths.socket, paths.lock, registry.path]) {
    assert.equal(lstatSync(path).uid, currentUid());
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  }
  const install = new SessionHostLauncher({ ...options, detachedOnly: true });
  const concurrent = await Promise.all([install.launch(ref), install.launch(ref)]);
  assert.ok(concurrent.every(result => result.metadata.pid === metadata.pid));
  assert.equal(registry.listActivePins().length, 1);
  const secret = readFileSync(paths.secret, 'utf8');
  assert.equal(readFileSync('/proc/' + metadata.pid + '/cmdline', 'utf8').includes(secret), false);
  assert.equal(readFileSync('/proc/' + metadata.pid + '/environ', 'utf8').includes(secret), false);

  const exited = once(parent, 'exit');
  assert.equal(parent.kill('SIGKILL'), true);
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  const journal = new SessionHostJournal(stateDir, key);
  try {
    await waitFor(() => journal.listUnackedEvents(metadata.instanceId)
      .some(event => object(event.observation).type === 'scheduled'));
    assert.equal(lstatSync(journal.path).mode & 0o777, 0o600);
    assert.equal(registry.getInstanceByKey(key)?.state, 'detached');
    assert.ok(isStampedProcessAlive(metadata));
    assert.equal(registry.listActivePins()[0]?.pinId, pin?.pinId);
    const events: HostEvent[] = [];
    const cursor = object(first.cursor);
    const replay = await openClient(metadata, event => events.push(event), {
      instanceId: String(cursor.instanceId), seq: Number(cursor.seq),
    });
    assert.equal((await replay.attach()).mode, 'replay');
    await waitFor(() => events.length === 1);
    assert.deepEqual(events[0]?.observation, { type: 'scheduled', value: 'arrived offline' });
    assert.equal(readMetadata(paths.metadata).pid, metadata.pid);
    assert.equal(readMetadata(paths.metadata).startTicks, metadata.startTicks);
    assert.ok(Number(journal.getState('bridgeEpoch')) > Number(first.bridgeEpoch));
    assert.deepEqual(await replay.shutdown('still pending'), { outcome: 'busy', reason: 'pending interaction' });

    const answer = { id: 'user-question', answer: 'yes' };
    const resolved = await replay.command('answer-once', 'resolve', answer);
    assert.deepEqual(resolved.receipt, { resolved: true });
    assert.deepEqual(await replay.command('answer-once', 'resolve', answer), resolved);
    assert.deepEqual((await replay.command('answer-twice', 'resolve', answer)).receipt, { resolved: false });
    assert.equal(events.filter(event => object(event.observation).type === 'resolved').length, 1);
    assert.deepEqual(await replay.shutdown('terminal pending'), { outcome: 'busy', reason: 'unacked terminal state' });
    await replay.ack();
    assert.deepEqual(await replay.shutdown('test complete'), { outcome: 'closed' });
    await waitFor(() => !isStampedProcessAlive(metadata) && registry.getInstanceByKey(key)?.state === 'closed');
    assert.deepEqual(registry.listActivePins(), []);
    assert.equal(existsSync(paths.socket), false);
    assert.equal(existsSync(paths.metadata), false);
    assert.equal(existsSync(paths.secret), false);
    assert.equal(existsSync(paths.lock), true);
  } finally {
    journal.close();
  }
});

test('PID reuse cannot reclaim a live socket, and a dead listener is reclaimed after proc and socket checks', { timeout: 12_000 }, async t => {
  const { registry, paths, key, options, spawnScript, openClient } = testFixture(t);
  registry.reserveKeyForRef(ref);
  const listener = spawnScript(`
    import { chmodSync } from 'node:fs';
    import { createServer } from 'node:net';
    const server = createServer(socket => socket.end());
    server.listen(JSON.parse(process.argv[1]), () => {
      chmodSync(JSON.parse(process.argv[1]), 0o600);
      console.log('listening');
    });
  `, paths.socket);
  assert.equal(await lineFrom(listener), 'listening');
  const inode = lstatSync(paths.socket).ino;
  const stamp = processStamp(process.pid)!;
  const forged: HostMetadata = {
    pid: process.pid, bootId: stamp.bootId, startTicks: String(BigInt(stamp.startTicks) + 1n), unit: null,
    releaseDir, protocolVersion: 1, provider: ref[0], hostId: ref[1], serviceId: ref[2], sessionId: ref[3],
    instanceId: 'stale', startedAt: new Date().toISOString(), keyId: '00'.repeat(32),
  };
  writePrivateAtomic(paths.metadata, json(forged));
  assert.equal(isStampedProcessAlive(forged), false);
  await assert.rejects(new SessionHostLauncher({ ...options, detachedOnly: true }).launch(ref), hasCode('busy'));
  assert.equal(lstatSync(paths.socket).ino, inode);
  assert.deepEqual(readMetadata(paths.metadata), forged);
  assert.equal(registry.getInstanceByKey(key), undefined);

  const exited = once(listener, 'exit');
  listener.kill('SIGKILL');
  await exited;
  assert.equal(existsSync(paths.socket), true);
  const launcher = spawnScript(`
    import { SessionHostLauncher } from ${JSON.stringify(launcherUrl)};
    const { options, ref } = JSON.parse(process.argv[1]);
    console.log(JSON.stringify(await new SessionHostLauncher(options).launch(ref)));
  `, { options: { ...options, detachedOnly: true }, ref });
  await lineFrom(launcher);
  const metadata = readMetadata(paths.metadata);
  assert.notEqual(metadata.instanceId, forged.instanceId);
  assert.ok(isStampedProcessAlive(metadata));
  const replacement = await openClient(metadata);
  await replacement.attach();
  await replacement.snapshot();
  assert.deepEqual(await replacement.shutdown('stale socket replaced'), { outcome: 'closed' });
  await waitFor(() => registry.getInstanceByKey(key)?.state === 'closed');
  assert.deepEqual(registry.listActivePins(), []);
});

test('idle GC removes its pin and a later instance snapshots durable unacked evidence from a killed host', { timeout: 15_000 }, async t => {
  const { registry, paths, key, options, spawnScript, openClient } = testFixture(t, { idleTimeoutMs: 800 });
  const start = async () => {
    const launcher = spawnScript(`
      import { SessionHostLauncher } from ${JSON.stringify(launcherUrl)};
      const { options, ref } = JSON.parse(process.argv[1]);
      console.log(JSON.stringify(await new SessionHostLauncher(options).launch(ref)));
    `, { options: { ...options, detachedOnly: true }, ref });
    await lineFrom(launcher);
    return readMetadata(paths.metadata);
  };
  const first = await start();
  await waitFor(() => !isStampedProcessAlive(first) && registry.getInstanceByKey(key)?.state === 'closed');
  assert.deepEqual(registry.listActivePins(), []);

  const killed = await start();
  const client = await openClient(killed);
  await client.attach();
  await client.snapshot();
  await client.command('pending-crash', 'pending', { id: 'crash-question' });
  await client.command('resolved-crash', 'resolve', { id: 'crash-question', answer: 'yes' });
  const cursor = client.cursor!;
  process.kill(killed.pid, 'SIGKILL');
  await waitFor(() => !isStampedProcessAlive(killed));
  assert.equal(registry.listActivePins().length, 1);
  const recovered = await start();
  assert.notEqual(recovered.instanceId, killed.instanceId);
  const next = await openClient(recovered, undefined, cursor);
  assert.equal((await next.attach()).mode, 'snapshot');
  const snapshot = await next.snapshot();
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.events[1]?.terminal, true);
  assert.ok(snapshot.events.every(event => event.instanceId === recovered.instanceId));
  const receipt = await next.receipt('resolved-crash');
  assert.equal(receipt.state, 'terminal');
  assert.deepEqual(receipt.receipt, { resolved: true });
  assert.deepEqual(await next.shutdown('unacked recovery evidence'), { outcome: 'busy', reason: 'unacked terminal state' });
  await next.ack();
  await waitFor(() => registry.getInstanceByKey(key)?.state === 'closed');
  assert.deepEqual(registry.listActivePins(), []);
});

test('binds a pending create to its native ref without moving the host or losing the create receipt', { timeout: 12_000 }, async t => {
  const { registry, options, spawnScript, openClient, runtimeDir } = testFixture(t);
  const create = ['create', ref[0], ref[1], ref[2], 'create-operation'] as const;
  const launcher = spawnScript(`
    import { SessionHostLauncher } from ${JSON.stringify(launcherUrl)};
    const { options, identity } = JSON.parse(process.argv[1]);
    console.log(JSON.stringify(await new SessionHostLauncher(options).launch(identity)));
  `, { options: { ...options, detachedOnly: true }, identity: create });
  const wrapper = object(JSON.parse(await lineFrom(launcher)) as unknown);
  const key = sessionKey(create);
  assert.equal(wrapper.key, key);
  const paths = runtimePaths(runtimeDir, key);
  const metadata = readMetadata(paths.metadata);
  assert.equal(metadata.sessionId, null);
  assert.equal(registry.getInstanceByKey(key)?.state, 'starting');
  const client = await openClient(metadata, undefined, undefined, key, null);
  await client.attach();
  await client.snapshot();
  assert.deepEqual((await client.command('create-operation', 'create', { nativeSessionId: ref[3] })).receipt, { ref });
  assert.equal(readMetadata(paths.metadata).sessionId, ref[3]);
  assert.equal(registry.getCreateReceipt('create-operation')?.key, key);
  assert.deepEqual(registry.getCreateReceipt('create-operation')?.ref, ref);
  assert.equal(registry.getInstanceByRef(ref)?.key, key);
  const reused = await new SessionHostLauncher({ ...options, detachedOnly: true }).launch(ref);
  assert.equal(reused.key, key);
  assert.equal(reused.metadata.pid, metadata.pid);
  await client.ack();
  assert.deepEqual(await client.shutdown('create bound'), { outcome: 'closed' });
  await waitFor(() => registry.getInstanceByKey(key)?.state === 'closed');
  assert.deepEqual(registry.listActivePins(), []);
});

test('registry epochs, identity collisions and Claude generations are transactional and persist across connections', t => {
  const { registry, stateDir, key } = testFixture(t);
  const other = new SessionHostRegistry(stateDir);
  try {
    assert.equal(registry.allocateBridgeEpoch(), 1);
    assert.equal(other.allocateBridgeEpoch(), 2);
    assert.equal(registry.reserveKeyForRef(ref), sha256(json(ref)).slice(0, 32));
    const reserved = ['create', 'echo', 'local', 'launcher-test', 'once'] as const;
    const createKey = registry.reserveKeyForCreate(reserved);
    assert.equal(other.reserveKeyForCreate(reserved), createKey);
    assert.throws(() => other.reserveKeyForCreate(['create', 'echo', 'other-host', 'launcher-test', 'once']), hasCode('identity_mismatch'));
    const first = registry.putClaudeOwnership({ sessionId: 'claude-session', origin: 'fixture', alias: 'alpha', metadata: {} }, null);
    assert.throws(() => other.putClaudeOwnership(first, null), hasCode('fenced'));
    const second = other.putClaudeOwnership({ ...first, metadata: { durable: true } }, first.generation);
    assert.equal(second.generation, first.generation + 1);
    assert.deepEqual(registry.getClaudeOwnership('claude-session'), second);
    assert.equal(registry.allocateClaudeCounter('alias'), 1);
    assert.equal(other.allocateClaudeCounter('alias'), 2);
    const raw = new DatabaseSync(registry.path);
    try {
      assert.deepEqual(Object.values(raw.prepare('PRAGMA integrity_check').get()!), ['ok']);
      assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
      raw.prepare('UPDATE session_keys SET identity_json = ? WHERE host_key = ?').run('["wrong"]', key);
      assert.throws(() => other.reserveKeyForRef(ref), hasCode('identity_mismatch'));
    } finally {
      raw.close();
    }
  } finally {
    other.close();
  }
});

test('production command uses a separate transient unit and explicit minimal environment', t => {
  const { key, options } = testFixture(t);
  const command = new SessionHostLauncher({ ...options, allowDetachedFallback: false })
    .buildSystemdCommand('agy', key, ['PATH', 'FEISHU_APP_SECRET', 'RANDOM_VAR']);
  assert.equal(command.executable, '/usr/bin/systemd-run');
  assert.deepEqual(command.args.slice(0, 6), [
    '--user', '--unit=feishu-session-host-' + key, '--service-type=exec', '--property=KillMode=control-group',
    '--property=UMask=0077', '--working-directory=' + releaseDir,
  ]);
  assert.ok(command.args.includes('--property=UnsetEnvironment=FEISHU_APP_SECRET RANDOM_VAR'));
  const delimiter = command.args.indexOf('--');
  assert.deepEqual(command.args.slice(delimiter + 1), [
    process.execPath, entry, '--provider', 'agy', '--key', key, '--runtime-dir', options.runtimeDir,
    '--state-dir', options.stateDir, '--release-dir', releaseDir, '--config-file', options.configFile,
  ]);
  assert.deepEqual(Object.keys(command.env).sort(), ['NODE_OPTIONS', 'PATH', 'XDG_RUNTIME_DIR']);
  assert.ok(!command.args.some(arg => /BindsTo|PartOf|setenv=FEISHU_APP_SECRET/.test(arg)));
});

test('OS lock persists after its helper exits and rejects a competing file description', t => {
  const { paths } = testFixture(t);
  const lock = acquireFileLock(paths.lock);
  assert.notEqual(lock, null);
  try {
    assert.equal(acquireFileLock(paths.lock), null);
    const contender = spawnSync('/usr/bin/flock', [
      '--nonblock', '--conflict-exit-code', '75', paths.lock, '/usr/bin/true',
    ]);
    assert.equal(contender.status, 75);
  } finally {
    closeSync(lock!);
  }
  const acquired = acquireFileLock(paths.lock);
  assert.notEqual(acquired, null);
  closeSync(acquired!);
});

test('journal restart preserves pending observations and converts interrupted submission to unknown', t => {
  const { stateDir, key } = testFixture(t);
  const digest = sha256('operation');
  const journal = new SessionHostJournal(stateDir, key);
  try {
    assert.equal(journal.beginInstance('before'), 0);
    journal.recordUnackedEvent({ instanceId: 'before', seq: 1, observation: { applied: true }, terminal: false });
    journal.recordUnackedEvent({ instanceId: 'before', seq: 2, observation: { completed: true }, terminal: true });
    journal.ackUpTo('before', 1);
    journal.prepareOperation('interrupted', digest, 'resolve');
    journal.markOperationSubmitted('interrupted');
  } finally {
    journal.close();
  }
  const recovered = new SessionHostJournal(stateDir, key);
  try {
    assert.equal(recovered.beginInstance('after'), 1);
    assert.deepEqual(recovered.listUnackedEvents(), [{
      instanceId: 'after', seq: 1, observation: { completed: true }, terminal: true,
    }]);
    assert.equal(recovered.getOperation('interrupted')?.state, 'unknown');
    assert.equal(recovered.hasUnknownOperations(), true);
    assert.throws(() => recovered.prepareOperation('interrupted', sha256('different'), 'resolve'), hasCode('invalid_request'));
    recovered.markOperationTerminal('interrupted', { reconciled: true });
    assert.equal(recovered.hasUnknownOperations(), false);
    assert.throws(() => recovered.ackUpTo('before', 1), hasCode('fenced'));
    recovered.ackUpTo('after', 1);
    assert.equal(recovered.hasUnackedTerminal(), false);
    const raw = new DatabaseSync(recovered.path);
    try {
      assert.deepEqual(Object.values(raw.prepare('PRAGMA integrity_check').get()!), ['ok']);
      assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      raw.close();
    }
  } finally {
    recovered.close();
  }
});
