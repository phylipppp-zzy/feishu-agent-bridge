import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { processStamp } from '../src/unified/session-host/launcher.js';
import type { HostMetadata, HostRef } from '../src/unified/session-host/protocol.js';
import { SessionHostRegistry } from '../src/unified/session-host/registry.js';
import { UnifiedStore } from '../src/unified/store.js';

const script = 'scripts/deploy-production.py';
const hostEntry = 'dist/src/unified/session-host/host-main.js';

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'fsh-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function python(...args: string[]) {
  const env = { ...process.env };
  delete env.FEISHU_APP_ID;
  delete env.FEISHU_APP_SECRET;
  delete env.FEISHU_OWNER_OPEN_ID;
  const child = spawn('python3', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}

async function liveProcess(t: TestContext, directory: string) {
  const entry = join(directory, 'host-main.js');
  writeFileSync(entry, "require('node:fs').writeSync(1, 'ready'); setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'inherit'], cwd: directory });
  const stopped = once(child, 'exit');
  t.after(async () => { child.kill(); await stopped; });
  const [ready] = await Promise.race([
    once(child.stdout, 'data', { signal: AbortSignal.timeout(3000) }),
    stopped.then(() => { throw new Error('host process stopped before readiness'); }),
  ]);
  assert.match(String(ready), /ready/);
  assert.ok(child.pid);
  const stamp = processStamp(child.pid);
  assert.ok(stamp);
  return { pid: child.pid, ...stamp };
}

function createRegistry(dir: string) {
  const registry = new SessionHostRegistry(dir);
  return { registry, registryPath: registry.path };
}

function fixture(t: TestContext) {
  const dir = tempDir(t);
  const corePath = join(dir, 'core #?.sqlite');
  new UnifiedStore(corePath).close();
  const core = new DatabaseSync(corePath);
  const { registry, registryPath } = createRegistry(dir);
  const runtime = join(dir, 'run');
  mkdirSync(runtime, { mode: 0o700 });
  const flags = ['--core-db', corePath, '--host-registry', registryPath, '--runtime-dir', runtime];
  const run = (...options: string[]) => python(script, '--check-active-only', '--seamless', ...flags, ...options);
  t.after(() => { core.close(); registry.close(); });
  return { dir, core, registry, registryPath, runtime, run };
}

function addSession(db: DatabaseSync, id: string, ref: HostRef) {
  const [provider, hostId, serviceId, nativeSessionId] = ref;
  db.prepare('INSERT INTO sessions(id,value,revision,control_generation) VALUES (?,?,0,0)').run(id, JSON.stringify({
    status: 'interactive', control: { input: 'available' }, native: { provider, hostId, serviceId, nativeSessionId },
  }));
}

function addOutbox(db: DatabaseSync, table: 'outbox' | 'steer_outbox_v1', id: string, targetId: string,
  kind: string, state: 'pending' | 'in_flight', payload: object = {}) {
  const context = { operationId: id, idempotencyKey: id, targetId };
  db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(id, id, 'digest', JSON.stringify({ ...context, action: kind }));
  db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?,0,?)`).run(id, kind, JSON.stringify(payload), JSON.stringify(context), state);
}

const ref = ['claude', 'bridge-host', 'claude-service', 'native-id'] satisfies HostRef;
const createRef = ['create', ref[0], ref[1], ref[2], 'create-reserved'] as const;

function addHost(registry: SessionHostRegistry, key: string, stamp: Awaited<ReturnType<typeof liveProcess>>,
  releaseDir: string, sessionId: string | null): HostMetadata {
  const metadata: HostMetadata = {
    ...stamp, unit: null, releaseDir, sessionId, protocolVersion: 1,
    provider: ref[0], hostId: ref[1], serviceId: ref[2],
    instanceId: 'test-instance', startedAt: new Date().toISOString(), keyId: '0'.repeat(64),
  };
  registry.upsertInstance(key, metadata, 'detached');
  registry.pinRelease('pin-' + key, key, releaseDir, 'session-host');
  return metadata;
}

test('seamless is exclusive with force and an idle database needs no registry', async t => {
  const dir = tempDir(t);
  const args = ['--check-active-only', '--core-db', join(dir, 'absent.sqlite'),
    '--host-registry', join(dir, 'absent-registry.sqlite'), '--seamless'];
  assert.equal((await python(script, ...args)).status, 0);
  const rejected = await python(script, ...args, '--force');
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /not allowed with argument --seamless/);
});

test('seamless verifies every live host without a SQLite write lease', { skip: process.platform !== 'linux' }, async t => {
  const { dir, core, registry, registryPath, runtime, run } = fixture(t);
  const release = join(dir, 'release');
  mkdirSync(release);
  const stamp = await liveProcess(t, release);
  const key = registry.reserveKeyForRef(ref);
  const metadata = addHost(registry, key, stamp, release, ref[3]);
  const metadataFile = join(runtime, key + '.json');
  writeFileSync(metadataFile, JSON.stringify(metadata), { mode: 0o600 });
  const createKey = registry.reserveKeyForCreate(createRef);
  const createMetadata = addHost(registry, createKey, stamp, release, null);
  assert.equal(registry.markInstanceState(createKey, 'starting'), true);
  writeFileSync(join(runtime, createKey + '.json'), JSON.stringify(createMetadata), { mode: 0o600 });
  addSession(core, 'session', ref);
  core.exec(`
    INSERT INTO turns VALUES ('step-1','session','{"status":"running"}');
    INSERT INTO turns VALUES ('step-2','session','{"status":"queued"}');
    INSERT INTO interactions VALUES ('approval','session','{"kind":"permission","status":"awaiting_answer"}');
    INSERT INTO interactions VALUES ('delivery','session','{"kind":"question","status":"answer_pending_delivery"}');
  `);
  addOutbox(core, 'outbox', 'answer', 'session', 'resolveInteraction', 'in_flight');
  addOutbox(core, 'steer_outbox_v1', 'steer', 'session', 'submitInput', 'pending');
  addOutbox(core, 'outbox', 'create-reserved', 'new:topic', 'createSession', 'in_flight', { provider: ref[0] });
  addOutbox(core, 'outbox', 'create-pending', 'new:topic', 'createSession', 'pending', { provider: ref[0] });

  using writer = new DatabaseSync(registryPath);
  writer.exec('BEGIN IMMEDIATE');
  const clear = await run();
  assert.equal(clear.status, 0, clear.stderr);
  writer.exec('ROLLBACK');

  writeFileSync(metadataFile, JSON.stringify({ ...metadata, instanceId: 'stale-instance' }));
  const stale = await run();
  assert.equal(stale.status, 2, stale.stderr);
  for (const item of ['step-1', 'step-2', 'approval', 'delivery', 'answer', 'steer']) {
    assert.match(stale.stderr, new RegExp(`${item} .*differs from registry`));
  }
});

test('seamless names each legacy, stale, incompatible, missing or unowned active item', {
  skip: process.platform !== 'linux',
}, async t => {
  const { dir, core, registry, registryPath, run } = fixture(t);
  const stamp = await liveProcess(t, dir);
  addSession(core, 'legacy', ['claude', ref[1], ref[2], 'legacy-native']);
  core.exec(`
    INSERT INTO turns VALUES ('legacy-turn','legacy','{"status":"running"}');
    INSERT INTO interactions VALUES ('legacy-approval','legacy','{"status":"awaiting_answer"}');
    INSERT INTO tracking_state VALUES ('legacy',1);
  `);
  addOutbox(core, 'outbox', 'legacy-prompt', 'legacy', 'submitInput', 'pending');
  addOutbox(core, 'steer_outbox_v1', 'orphan-steer', 'missing-session', 'submitInput', 'in_flight');
  addOutbox(core, 'outbox', 'unhosted-create', 'new:topic', 'createSession', 'in_flight', { provider: ref[0] });
  addSession(core, 'hosted', ref);
  core.exec(`INSERT INTO turns VALUES ('hosted-turn','hosted','{"status":"queued"}');`);
  const key = registry.reserveKeyForRef(ref);
  const release = join(dir, 'release');
  mkdirSync(release);
  addHost(registry, key, stamp, release, ref[3]);
  using db = new DatabaseSync(registryPath);
  const errors = [
    ["start_ticks='0'", /start ticks/],
    ["boot_id='old-boot'", /boot ID/],
    ['pid=2147483647', /dead session host PID/],
    ['protocol_version=2', /incompatible session host protocol 2/],
    ["release_dir='/nonexistent/removed-release'", /missing session host release/],
  ] as const;
  for (const [set, reason] of errors) {
    db.exec(`UPDATE host_instances SET ${set}`);
    const blocked = await run();
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, new RegExp(`hosted-turn.*${reason.source}`));
    for (const id of ['legacy-approval', 'legacy-prompt', 'orphan-steer', 'unhosted-create']) {
      assert.match(blocked.stderr, new RegExp(id));
    }
    assert.doesNotMatch(blocked.stderr, /legacy-turn/);
    db.prepare('UPDATE host_instances SET start_ticks=?,boot_id=?,pid=?,protocol_version=1,release_dir=?')
      .run(stamp.startTicks, stamp.bootId, stamp.pid, release);
  }
  core.exec("UPDATE tracking_state SET detached=0 WHERE session_id='legacy'");
  const legacy = await run();
  assert.equal(legacy.status, 2, legacy.stderr);
  assert.match(legacy.stderr, /legacy-turn.*legacy.*no session host/);
});

const loadDeploy = `
from pathlib import Path
import runpy, sys
scope = runpy.run_path('scripts/deploy-production.py')['main'].__globals__
root = Path(sys.argv[1])
scope.update(RELEASES_ROOT=root / 'releases', DEPS_ROOT=root / 'deps',
             UNIT_FILE=root / 'bridge.service', CONF_DIR=root, CONF_FILE=root / 'config.json')
`;

test('GC uses proc paths and all registry pins, and fails closed on broken evidence', {
  skip: process.platform !== 'linux',
}, async t => {
  const root = tempDir(t);
  const releases = join(root, 'releases');
  const paths = (name: string) => join(releases, name);
  const [current, pinned, registered, running, mockRunning, fromUnit, old] = [
    paths('aaaaaaa'), paths('bbbbbbb'), paths('ccccccc'), paths('ddddddd'), paths('eeeeeee'), paths('fffffff'), paths('1111111'),
  ];
  for (const path of [current, pinned, registered, running, mockRunning, fromUnit, old]) mkdirSync(path, { recursive: true });
  const stamp = await liveProcess(t, running);
  const { registry, registryPath } = createRegistry(root);
  const key = registry.reserveKeyForRef(ref);
  registry.upsertInstance(key, {
    ...stamp, unit: null, releaseDir: registered, sessionId: ref[3], protocolVersion: 1,
    provider: ref[0], hostId: ref[1], serviceId: ref[2], instanceId: 'registered',
    startedAt: new Date().toISOString(), keyId: '0'.repeat(64),
  }, 'draining');
  registry.pinRelease('pin-only', key, pinned, 'session-host');
  t.after(() => registry.close());

  const result = await python('-c', loadDeploy + `
from unittest.mock import patch
import sqlite3, subprocess
current, registry, mock_running, active_unit, old = map(Path, sys.argv[2:])
proc = root / 'mock-proc' / '123'
proc.mkdir(parents=True)
(proc / 'cmdline').write_bytes(b'node\\0host-main.js\\0')
(proc / 'cwd').symlink_to(mock_running)
real_scan = scope['running_releases']
assert real_scan(proc.parent) == {mock_running}
scope['running_releases'] = lambda: real_scan() | real_scan(proc.parent)
def systemctl(command, **kwargs):
    if 'list-units' in command:
        assert command[-1] == 'feishu-session-host-*.service'
        return subprocess.CompletedProcess(command, 0, 'feishu-session-host-key.service loaded active running\\n', '')
    assert 'show' in command and command[-1] == 'feishu-session-host-key.service'
    return subprocess.CompletedProcess(command, 0, f'ExecStart={{ argv[]={active_unit}/host-main.js ; }}\\nWorkingDirectory={active_unit}\\n', '')
prune = scope['prune_releases']
def blocked(registry):
    try:
        prune(current, '', 0, registry)
    except RuntimeError as error:
        assert 'cannot verify release protection' in str(error)
        assert old.is_dir()
    else:
        raise AssertionError('GC should fail closed')
corrupt = root / 'corrupt.sqlite'
corrupt.write_text('not sqlite')
with patch.object(subprocess, 'run', systemctl):
    blocked(corrupt)
    with sqlite3.connect(registry) as writer:
        writer.execute('BEGIN IMMEDIATE')
        blocked(registry)
        writer.rollback()
    with patch.dict(scope, running_releases=lambda: real_scan(root / 'missing-proc')):
        blocked(registry)
    prune(current, '', 0, registry)
`, root, current, registryPath, mockRunning, fromUnit, old);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /not a database/);
  assert.match(result.stderr, /database is locked/);
  assert.match(result.stderr, /missing-proc/);
  assert.deepEqual(readdirSync(releases).sort(), [current, pinned, registered, running, mockRunning, fromUnit].map(path => basename(path)).sort());

  registry.unpinRelease('pin-only');
  assert.equal(registry.markInstanceState(key, 'closed', 'registered'), true);
  const closed = await python('-c', loadDeploy + `
scope['prune_releases'](Path(sys.argv[2]), '', 0, Path(sys.argv[3]))
`, root, current, registryPath);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(existsSync(pinned), false);
  assert.equal(existsSync(registered), false);
  assert.equal(existsSync(running), true);
});

test('offline candidate deployment verifies host entry and retains the lockfile-addressed deps of pinned releases', async t => {
  const root = tempDir(t);
  const repo = join(root, 'repo');
  const config = join(root, 'config.json');
  const packageLock = join(repo, 'package-lock.json');
  const dependency = join(repo, 'node_modules/fixture/index.js');
  const host = join(repo, hostEntry);
  for (const path of [dirname(host), dirname(dependency), join(repo, 'src'), join(repo, 'scripts'), join(repo, 'test')]) {
    mkdirSync(path, { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) writeFileSync(join(repo, file), '{}\n');
  copyFileSync('scripts/unified-start.mjs', join(repo, 'scripts/unified-start.mjs'));
  writeFileSync(join(repo, 'dist/src/unified/runtime.js'), 'exports.validateRuntimeConfig = () => {};\n');
  writeFileSync(host, 'host entry\n');
  writeFileSync(dependency, 'sdk-v1\n');
  symlinkSync(dependency, join(repo, 'node_modules/absolute-fixture-link'));
  writeFileSync(config, JSON.stringify({ sdkDb: join(root, 'sdk.sqlite'), runtime: { artifactStatePath: join(root, 'artifact'),
    catalogSources: [], agy: {} } }), { mode: 0o600 });
  const git = await python('-c', `
import subprocess, sys
repo = sys.argv[1]
subprocess.run(['git', 'init', '-q', repo], check=True)
subprocess.run(['git', '-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                'commit', '-qm', 'base', '--allow-empty'], check=True)
`, repo);
  assert.equal(git.status, 0, git.stderr);
  const { registry, registryPath } = createRegistry(root);
  t.after(() => registry.close());
  const deploy = (...args: string[]) => python('-c', loadDeploy + `
scope['REPO'] = Path(sys.argv[2])
sys.exit(scope['main'](sys.argv[3:]))
`, root, repo, '--skip-guard', '--keep-releases=0', '--core-db', join(root, 'idle.sqlite'), '--host-registry', registryPath, ...args);
  const publish = async (...args: string[]) => {
    const result = await deploy(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /offline preflight passed/);
    const release = result.stdout.match(/^RELEASE_DIR=(.+)$/m)?.[1];
    assert.ok(release);
    const generation = JSON.parse(readFileSync(join(release, 'generation.json'), 'utf8'));
    const sha = createHash('sha256').update(readFileSync(packageLock)).digest('hex').slice(0, 16);
    assert.equal(generation.sessionHostProtocolVersion, 1);
    assert.equal(generation.depsSha256, sha);
    assert.equal(generation.depsDir, join(root, 'deps', sha));
    assert.equal(readlinkSync(join(release, 'node_modules')), join(generation.depsDir, 'node_modules'));
    return { release, deps: String(generation.depsDir) };
  };

  const first = await publish('--seamless');
  assert.equal(statSync(dependency).ino, statSync(join(first.release, 'node_modules/fixture/index.js')).ino);
  registry.pinRelease('previous-sdk', registry.reserveKeyForRef(ref), first.release, 'session-host');
  writeFileSync(packageLock, '{"lockfileVersion":3}\n');
  writeFileSync(dependency + '.new', 'sdk-v2\n');
  renameSync(dependency + '.new', dependency);
  const second = await publish('--force');
  const third = await publish('--force');
  assert.equal(third.deps, second.deps);
  assert.notEqual(third.deps, first.deps);
  assert.equal(readFileSync(join(first.release, 'node_modules/fixture/index.js'), 'utf8'), 'sdk-v1\n');
  assert.equal(readFileSync(join(first.release, 'node_modules/absolute-fixture-link'), 'utf8'), 'sdk-v1\n');
  assert.equal(readFileSync(join(third.release, 'node_modules/fixture/index.js'), 'utf8'), 'sdk-v2\n');

  registry.unpinRelease('previous-sdk');
  const fourth = await publish('--force');
  assert.equal(existsSync(first.release), false);
  assert.equal(existsSync(first.deps), false);
  assert.equal(existsSync(second.release), false);
  assert.ok(existsSync(third.release));
  assert.ok(existsSync(fourth.deps));

  const preflight = () => python(join(fourth.release, 'preflight.py'), '--manifest-only');
  const valid = await preflight();
  assert.equal(valid.status, 0, valid.stderr);
  const releaseHost = join(fourth.release, hostEntry);
  writeFileSync(releaseHost, 'tampered host entry\n');
  assert.equal((await preflight()).status, 1);
  rmSync(releaseHost);
  symlinkSync(host, releaseHost);
  assert.equal((await preflight()).status, 1);
  rmSync(releaseHost);
  writeFileSync(releaseHost, 'host entry\n');
  const releaseUnit = join(fourth.release, 'feishu-unified-production.service');
  const validUnit = readFileSync(releaseUnit, 'utf8');
  writeFileSync(releaseUnit, validUnit.replace(/^ExecStart=.*$/m, 'ExecStart=/missing/node'));
  assert.match((await preflight()).stderr, /production unit digest mismatch/);
  writeFileSync(releaseUnit, validUnit);
  const manifest = join(fourth.release, 'dist.sha256');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').split('\n').filter(line => !line.endsWith(hostEntry)).join('\n'));
  assert.equal((await preflight()).status, 1);

  const unit = join(root, 'bridge.service');
  const priorUnit = readFileSync(unit, 'utf8');
  const priorConfig = readFileSync(config, 'utf8');
  assert.ok(priorUnit.includes(`ExecStartPre=/usr/bin/python3 ${fourth.release}/preflight.py\n`));
  rmSync(host);
  const missing = await deploy('--force');
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /session host entry point missing from dist manifest/);
  assert.equal(readFileSync(unit, 'utf8'), priorUnit);
  assert.equal(readFileSync(config, 'utf8'), priorConfig);
});
