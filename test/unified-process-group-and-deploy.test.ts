import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AgyAcpTransport } from '../src/unified/agy/acp-transport.js';
import { prepareStableAgyBin } from '../src/unified/agy/stable-bin.js';
import { killProcessTree, terminateChildProcess, trackAgyChildForExit } from '../src/unified/agy/transport-common.js';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-lane-c-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function runPython(args: string[]) {
  const proc = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  proc.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [status] = await once(proc, 'close');
  return { status, stdout, stderr };
}

test('deploy active check blocks each work source and supports force and idle', async t => {
  const core = join(tempDir(t), 'core #?.sqlite');
  const run = (...args: string[]) => runPython([
    'scripts/deploy-production.py', '--check-active-only', '--core-db', core, ...args,
  ]);

  assert.equal((await run()).status, 0, 'missing database should be idle');
  using db = new DatabaseSync(core);
  db.exec(`
    CREATE TABLE turns(session_id TEXT, id TEXT, value TEXT, PRIMARY KEY(session_id, id));
    CREATE TABLE outbox(operation_id TEXT PRIMARY KEY, kind TEXT, state TEXT);
    CREATE TABLE steer_outbox_v1(operation_id TEXT PRIMARY KEY, kind TEXT, state TEXT);
    CREATE TABLE interactions(id TEXT PRIMARY KEY, session_id TEXT, value TEXT);
    INSERT INTO turns VALUES ('idle', 'step-1', '{"status":"completed"}');
    INSERT INTO outbox VALUES ('done-op', 'prompt', 'done');
    INSERT INTO interactions VALUES ('resolved', 'idle', '{"status":"answered"}');
  `);
  assert.equal((await run()).status, 0);
  const activeCases = [
    ['turns', `'session-1', 'step-1', '{"status":"running","startedAt":"2026-11-27"}'`, /step-1.*running.*2026-11-27/],
    ['turns', `'session-2', 'step-1', '{"status":"queued"}'`, /step-1.*queued/],
    ['outbox', "'prompt-op', 'prompt', 'in_flight'", /prompt-op.*prompt.*in_flight/],
    ['steer_outbox_v1', "'steer-op', 'steer', 'pending'", /steer-op.*steer.*pending/],
    ['interactions', `'question-1', 'session-1', '{"kind":"question","status":"awaiting_answer"}'`, /question-1.*session-1.*question/],
  ] as const;
  for (const [table, values, summary] of activeCases) {
    db.exec(`INSERT INTO ${table} VALUES (${values})`);
    const blocked = await run();
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, summary);
    assert.match(blocked.stderr, /--force/);
    assert.equal((await run('--force')).status, 0);
    db.exec(`DELETE FROM ${table} WHERE rowid = last_insert_rowid()`);
  }
  assert.equal((await run()).status, 0);
  db.exec('DROP TABLE steer_outbox_v1');
  assert.equal((await run()).status, 0, 'minimal databases need no steer outbox');
  db.exec('DROP TABLE interactions');
  const invalid = await run();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /interactions/);
});

test('deploy gates interactive work and keeps graceful systemd shutdown', async t => {
  const script = readFileSync('scripts/deploy-production.py', 'utf8');
  assert.match(script, /^TimeoutStopSec=30\nKillMode=mixed\nSendSIGKILL=yes$/m);
  const core = join(tempDir(t), 'core.sqlite');
  using db = new DatabaseSync(core);
  const run = () => runPython(['scripts/deploy-production.py', '--check-active-only', '--core-db', core]);
  db.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE tracking_state(session_id TEXT PRIMARY KEY, detached INTEGER);
    CREATE TABLE turns(session_id TEXT, id TEXT, value TEXT, PRIMARY KEY(session_id, id));
    CREATE TABLE interactions(id TEXT PRIMARY KEY, session_id TEXT, value TEXT);
    CREATE TABLE outbox(operation_id TEXT PRIMARY KEY, kind TEXT, state TEXT);
    INSERT INTO sessions VALUES
      ('readonly', '{"status":"read_only","control":{"input":"available"}}'),
      ('unavailable', '{"status":"running","control":{"input":"unavailable"}}'),
      ('detached', '{"status":"running","control":{"input":"available"}}'),
      ('interactive', '{"status":"running","control":{"input":"available"}}');
    INSERT INTO tracking_state VALUES ('detached', 1);
    INSERT INTO turns SELECT id, 'same-step', '{"status":"running"}' FROM sessions WHERE id <> 'interactive';
    INSERT INTO interactions SELECT id || '-answer', id, '{"status":"answer_pending_delivery","kind":"question"}'
      FROM sessions WHERE id <> 'interactive';
  `);
  assert.equal((await run()).status, 0);
  db.exec(`INSERT INTO turns VALUES ('interactive', 'same-step', '{"status":"running"}')`);
  const running = await run();
  assert.equal(running.status, 2);
  assert.match(running.stderr, /Turn: interactive \/ same-step \/ running/);
  db.exec(`DELETE FROM turns WHERE session_id='interactive';
    INSERT INTO interactions VALUES ('interactive-answer', 'interactive', '{"status":"answer_pending_delivery","kind":"question"}')`);
  const answering = await run();
  assert.equal(answering.status, 2);
  assert.match(answering.stderr, /interactive-answer \/ interactive \/ question/);
});

test('a held production deploy lock exits cleanly', async t => {
  const result = await runPython(['-c', `
import fcntl, os, re, sys
from pathlib import Path

root = Path(sys.argv[1])
script = Path('scripts/deploy-production.py')
source = re.sub(r'^RELEASES_ROOT = .*$', lambda _: f'RELEASES_ROOT = Path({str(root)!r})',
                script.read_text(), count=1, flags=re.M)
fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
sys.argv = [str(script), '--force']
exec(compile(source, str(script), 'exec'))
`, tempDir(t)]);
  assert.deepEqual(result, { status: 1, stdout: '', stderr: 'Another production deployment is already in progress.\n' });
});

test('release GC retains the new, unit, running, and newest old releases', { skip: process.platform !== 'linux' }, async () => {
  const result = await runPython(['-c', `
import ast
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

path = Path('scripts/deploy-production.py')
tree = ast.parse(path.read_text())
names = {'release_from_path', 'unit_releases', 'running_releases', 'prune_releases'}
nodes = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))
         or isinstance(node, ast.FunctionDef) and node.name in names]
with TemporaryDirectory() as tmp:
    root = Path(tmp) / 'releases'
    root.mkdir()
    unit = Path(tmp) / 'bridge.service'
    scope = {'RELEASES_ROOT': root, 'UNIT_FILE': unit}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), scope)
    new, current, previous, running, newest, old = [root / name for name in (
        'aaaaaaa-agy-new', 'bbbbbbb', 'ccccccc-uxv2-old', 'ddddddd', 'eeeeeee', 'fffffff',
    )]
    for directory in [new, current, previous, running, newest, old, root / '.staging-active', root / 'unrelated']:
        directory.mkdir()
    scripts = running / 'scripts'
    scripts.mkdir()
    launcher = scripts / 'unified-start.mjs'
    launcher.write_text('import time; time.sleep(10)')
    for directory in [current, previous, running, old]:
        os.utime(directory, (1, 1))
    os.utime(newest, (2, 2))
    unit.write_text(f'ExecStart=/usr/bin/node {current}/scripts/unified-start.mjs --run\\n')
    child = subprocess.Popen([sys.executable, str(launcher)], cwd='/tmp')
    try:
        scope['prune_releases'](new, f'WorkingDirectory={previous}\\n', 1)
        assert {entry.name for entry in root.iterdir()} == {
            new.name, current.name, previous.name, running.name, newest.name, '.staging-active', 'unrelated',
        }
    finally:
        child.terminate()
        child.wait(timeout=2)
`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PRUNED_RELEASE=fffffff/);
});

test('deploy pre/post dev_guard release-check blocks dirty tree, missing guard, and verifies systemd unit parity', async t => {
  const result = await runPython(['-c', `
import ast
import json
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

path = Path('scripts/deploy-production.py')
tree = ast.parse(path.read_text())
names = {'_run_dev_guard_cmd', 'run_pre_deploy_guard', 'run_post_deploy_guard'}
nodes = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))
         or isinstance(node, ast.FunctionDef) and node.name in names]
dev_guard = Path('/home/zhangzy/.codex/skills/sapphire-dev-workflow/scripts/dev_guard.py')
scope = {'DEV_GUARD': dev_guard}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), scope)

with TemporaryDirectory(prefix='deploy-guard-', dir='/home/zhangzy/workspace') as tmp:
    repo = Path(tmp)
    subprocess.run(['git', '-C', str(repo), 'init', '-q'], check=True)
    subprocess.run(['git', '-C', str(repo), 'config', 'user.email', 't@e.com'], check=True)
    subprocess.run(['git', '-C', str(repo), 'config', 'user.name', 'T'], check=True)
    (repo / 'a.txt').write_text('ok\\n', encoding='utf-8')
    subprocess.run(['git', '-C', str(repo), 'add', 'a.txt'], check=True)
    subprocess.run(['git', '-C', str(repo), 'commit', '-q', '-m', 'init'], check=True)
    head = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', '--short', 'HEAD'], text=True).strip()

    # Missing dev_guard.py must fail closed (not silently skip)
    try:
        scope['run_pre_deploy_guard'](repo, repo / 'nonexistent_guard.py')
        raise AssertionError('Expected missing dev_guard.py to fail closed')
    except RuntimeError as exc:
        assert 'not found' in str(exc), str(exc)

    # Clean repo passes pre-deploy guard
    scope['run_pre_deploy_guard'](repo, dev_guard)

    # Matching systemd unit passes post-deploy guard, mismatched fails
    rel = repo.parent / (repo.name + '-rel') / f'{head}-agy-111'
    rel.mkdir(parents=True)
    (rel / 'generation.json').write_text(json.dumps({'commit': head}), encoding='utf-8')
    unit = repo.parent / (repo.name + '.service')
    unit.write_text(f'[Service]\\nWorkingDirectory={rel}\\n', encoding='utf-8')
    try:
        scope['run_post_deploy_guard'](repo, unit, dev_guard)
        (rel / 'generation.json').write_text(json.dumps({'commit': '0000000'}), encoding='utf-8')
        try:
            scope['run_post_deploy_guard'](repo, unit, dev_guard)
            raise AssertionError('Expected mismatched commit to fail post-deploy guard')
        except RuntimeError as exc:
            assert '不一致' in str(exc), str(exc)
    finally:
        unit.unlink(missing_ok=True)
        shutil.rmtree(rel.parent, ignore_errors=True)
print('DEPLOY_GUARD_OK')
`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DEPLOY_GUARD_OK/);

  // Full-script main-flow wiring test: dirty repo blocked with exit code 2 using production DEV_GUARD constant
  const dirtyFlow = await runPython(['-c', `
import re, shutil, subprocess, sys
from pathlib import Path
from tempfile import TemporaryDirectory

script = Path('scripts/deploy-production.py')
with TemporaryDirectory(prefix='deploy-dirty-', dir='/home/zhangzy/workspace') as tmp:
    repo = Path(tmp)
    rel_root = Path(sys.argv[1])
    subprocess.run(['git', '-C', str(repo), 'init', '-q'], check=True)
    subprocess.run(['git', '-C', str(repo), 'config', 'user.email', 't@e.com'], check=True)
    subprocess.run(['git', '-C', str(repo), 'config', 'user.name', 'T'], check=True)
    (repo / 'a.txt').write_text('ok\\n', encoding='utf-8')
    subprocess.run(['git', '-C', str(repo), 'add', 'a.txt'], check=True)
    subprocess.run(['git', '-C', str(repo), 'commit', '-q', '-m', 'init'], check=True)
    (repo / 'dirty.txt').write_text('uncommitted\\n', encoding='utf-8')

    src = script.read_text()
    src = re.sub(r'^REPO = .*$', lambda _: f'REPO = Path({str(repo)!r})', src, count=1, flags=re.M)
    src = re.sub(r'^RELEASES_ROOT = .*$', lambda _: f'RELEASES_ROOT = Path({str(rel_root)!r})', src, count=1, flags=re.M)
    sys.argv = [str(script), '--force']
    exec(compile(src, str(script), 'exec'))
`, tempDir(t)]);
  assert.equal(dirtyFlow.status, 2, dirtyFlow.stderr);
  assert.match(dirtyFlow.stderr, /Pre-deploy dev_guard release-check failed/);
  assert.match(dirtyFlow.stderr, /未提交改动/);
});

test('termination signals the detached group and never signals a reaped PID', {
  skip: process.platform === 'win32',
  timeout: 5_000,
}, async t => {
  const leader = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const { writeSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.on('SIGTERM', () => {});
    child.on('exit', () => process.exit(0));
    child.on('spawn', () => writeSync(1, String(child.pid) + '\\n'));
  `], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => {
    if (leader.pid && leader.exitCode === null && leader.signalCode === null) {
      process.kill(-leader.pid, 'SIGKILL');
    }
  });

  const [pidOutput] = await once(leader.stdout, 'data');
  const originalExitListeners = process.listenerCount('exit');
  trackAgyChildForExit(leader);
  assert.equal(process.listenerCount('exit'), originalExitListeners + 1);
  const grandchildPid = Number(String(pidOutput).trim());
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 1);
  process.kill(grandchildPid, 0);
  assert.deepEqual(await terminateChildProcess(leader, 0, 500), { exitCode: 0, signal: null });
  assert.equal(process.listenerCount('exit'), originalExitListeners);
  assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });

  const kill = t.mock.method(process, 'kill', () => true);
  await terminateChildProcess(leader, 0, 0);
  killProcessTree(leader, 'SIGKILL');
  assert.equal(kill.mock.callCount(), 0);
});

test('parent exit cleans up a live detached child', { skip: process.platform !== 'linux', timeout: 5_000 }, async () => {
  const transport = new URL('../src/unified/agy/transport-common.js', import.meta.url);
  const parent = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    import { writeSync } from 'node:fs';
    import { trackAgyChildForExit } from ${JSON.stringify(transport.href)};
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: 'ignore' });
    trackAgyChildForExit(child);
    child.once('spawn', () => {
      writeSync(1, String(child.pid));
      process.exit(0);
    });
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  let pid = '';
  parent.stdout.setEncoding('utf8').on('data', chunk => { pid += chunk; });
  const [code] = await once(parent, 'close');
  assert.equal(code, 0);
  assert.match(pid, /^[1-9]\d*$/);
  const stopped = () => {
    try {
      return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw err;
    }
  };
  for (let attempt = 0; attempt < 20 && !stopped(); attempt++) await delay(25);
  assert.ok(stopped(), 'the detached child should have died before its timer elapsed');
});

test('stages versioned Agy hardlinks and keeps three versions', t => {
  const dir = tempDir(t);
  const agy = join(dir, 'agy');
  const stableBinDir = join(dir, 'stable');
  const versions: string[] = [];
  for (let version = 0; version < 5; version++) {
    const update = join(dir, 'update');
    writeFileSync(update, `version ${version}`, { mode: 0o700 });
    renameSync(update, agy);
    const staged = prepareStableAgyBin(agy, { stableBinDir, sandbox: false });
    assert.equal(staged.staged, true);
    assert.match(staged.execPath, /agy-[0-9a-f]{12}$/);
    assert.equal(readFileSync(staged.execPath, 'utf8'), `version ${version}`);
    assert.equal(statSync(staged.execPath).ino, statSync(agy).ino);
    versions.push(staged.execPath);
  }
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(readdirSync(stableBinDir).length, 3);
  assert.ok(readdirSync(stableBinDir).includes(basename(versions.at(-1)!)));
});

test('sandbox staging requires an AppArmor attachment that grants userns', { skip: process.platform !== 'linux' }, t => {
  const dir = tempDir(t);
  const agy = join(dir, 'agy');
  const stableBinDir = join(dir, 'stable');
  const profile = join(dir, 'profile');
  const restrict = join(dir, 'restrict');
  const warnings: string[] = [];
  const options = {
    sandbox: true,
    stableBinDir,
    appArmorProfilePath: profile,
    usernsRestrictPath: restrict,
    onWarning: (message: string) => warnings.push(message),
  };
  writeFileSync(agy, 'version', { mode: 0o700 });
  writeFileSync(restrict, '1\n');
  writeFileSync(profile, `profile agy ${agy} flags=(unconfined) {
    userns,
    ${stableBinDir}/agy-* ix,
  }`);
  const fallback = { execPath: agy, staged: false, reason: 'apparmor_path_restricted' };
  assert.deepEqual(prepareStableAgyBin(agy, options), fallback);
  assert.deepEqual(readdirSync(stableBinDir), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /load an AppArmor profile.*userns/);

  writeFileSync(profile, `profile agy "${stableBinDir}/agy-*" { userns, deny userns, }`);
  assert.deepEqual(prepareStableAgyBin(agy, options), fallback);
  writeFileSync(profile, `profile agy "${stableBinDir}/agy-*" {
    #include <local/agy>
    userns,
  }`);
  assert.deepEqual(prepareStableAgyBin(agy, options), fallback);
  writeFileSync(profile, `abi <abi/4.0>,
include <tunables/global>
profile agy "${stableBinDir}/agy-*" flags=(unconfined) {
  userns,
}`);
  const staged = prepareStableAgyBin(agy, options);
  assert.equal(staged.staged, true);
  assert.equal(readFileSync(staged.execPath, 'utf8'), 'version');
  assert.equal(warnings.length, 3);
  writeFileSync(restrict, '0\n');
  rmSync(profile);
  assert.deepEqual(prepareStableAgyBin(agy, options), staged);
});

test('ACP retries a transient ENOENT and fails with a bounded retry when it persists', { timeout: 5_000 }, async t => {
  const dir = tempDir(t);
  const program = join(dir, 'agy');
  const prepared = join(dir, 'prepared');
  writeFileSync(prepared, `#!${process.execPath}
    const { createInterface } = require('node:readline');
    const { createReadStream, writeSync } = require('node:fs');
    createInterface({ input: createReadStream(undefined, { fd: 0, autoClose: false }) }).once('line', line => {
      const { id, method } = JSON.parse(line);
      if (method !== 'initialize') process.exit(1);
      writeSync(1, JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } }) + '\\n');
    });
  `, { mode: 0o700 });
  const stableBinDir = join(dir, 'stable');
  const transport = new AgyAcpTransport({ agyBin: program, closeTimeoutMs: 100, stableBinDir });
  t.after(() => transport.close());
  const connecting = transport.connect();
  const restoring = delay(25).then(() => renameSync(prepared, program));
  const [initialized] = await Promise.all([connecting, restoring]);
  assert.equal(initialized.protocolVersion, 1);
  assert.equal(transport.connectionGeneration, 1);
  assert.equal(readdirSync(stableBinDir).length, 1);
  await transport.close();

  const missing = new AgyAcpTransport({ agyBin: join(dir, 'missing') });
  const started = performance.now();
  await assert.rejects(missing.connect(), { code: 'temporarily_unavailable', message: /ENOENT/ });
  assert.ok(performance.now() - started >= 400, 'expected both retry delays');
  assert.equal(missing.status, 'degraded');
  assert.equal(missing.connectionGeneration, 0);

  const cancelled = missing.connect();
  const rejected = assert.rejects(cancelled, { code: 'temporarily_unavailable', message: /closed before initialize/ });
  await missing.close();
  await rejected;
  assert.equal(missing.connectionGeneration, 0);
});
