import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { liveRuntimeLifecycle } from '../src/unified/runtime.js';
// @ts-expect-error JavaScript candidate entry has no declaration.
import { main } from '../scripts/unified-start.mjs';

test('entry is opt-in, validates without secrets, and closes on signal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unified-entry-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ runtime: { artifactStatePath: '/a', catalogSources: [], allowedProjectRoots: [], outputRoots: [] }, sdkDb: '/s' }), { mode: 0o600 });
    let created = 0, closed = 0, started = 0;
    const signals = new EventEmitter();
    const deps = { log() {}, fail() {}, signals, get env(): never { throw new Error('unexpected env read'); }, loadRuntime: async () => ({ validateRuntimeConfig() {}, createLiveRuntime: async () => { created++; return { start: async () => { started++; queueMicrotask(() => signals.emit('SIGTERM')); }, close: async () => { closed++; } }; } }) };
    assert.equal(await main(['--config', path], deps), 0);
    assert.equal(created, 0);
    assert.equal(await main(['--run', '--config', path], { log: deps.log, fail: deps.fail, signals, loadRuntime: deps.loadRuntime, env: { FEISHU_APP_ID: 'id', FEISHU_APP_SECRET: 'secret' } }), 0);
    assert.deepEqual([created, started, closed], [1, 1, 1]);
    await chmod(path, 0o644);
    assert.equal(await main(['--run', '--config', path], deps), 1);
    assert.equal(await main(['--config', path, '--unknown'], deps), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('pending start is closed immediately on signal and a late rejection is observed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unified-entry-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ runtime: { artifactStatePath: '/a', catalogSources: [], allowedProjectRoots: [], outputRoots: [] }, sdkDb: '/s' }), { mode: 0o600 });
    const signals = new EventEmitter();
    let rejectStart!: (e: Error) => void, closed = 0, markStarted!: () => void;
    const entered = new Promise<void>(resolve => { markStarted = resolve; });
    const pending = new Promise<void>((_resolve, reject) => { rejectStart = reject; });
    const output: string[] = [];
    const result = main(['--run', '--config', path], { signals, env: { FEISHU_APP_ID: 'id', FEISHU_APP_SECRET: 'secret' }, log: (x: string) => output.push(x), fail: (x: string) => output.push(x), loadRuntime: async () => ({ validateRuntimeConfig() {}, createLiveRuntime: async () => ({ start: () => { markStarted(); return pending; }, close: async () => { closed++; signals.emit('SIGINT'); } }) }) });
    await entered;
    signals.emit('SIGTERM');
    assert.equal(await result, 0);
    assert.equal(closed, 1);
    rejectStart(new Error('secret'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(output.some(x => x.includes('started') || x.includes('secret')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('start or close failure returns nonzero without exposing credentials and closes once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unified-entry-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ runtime: { artifactStatePath: '/a', catalogSources: [], allowedProjectRoots: [], outputRoots: [] }, sdkDb: '/s' }), { mode: 0o600 });
    for (const mode of ['start', 'close']) {
      const signals = new EventEmitter(); let closed = 0; const output: string[] = [];
      const status = await main(['--run', '--config', path], { signals, env: { FEISHU_APP_ID: 'id', FEISHU_APP_SECRET: 'secret' }, log: (x: string) => output.push(x), fail: (x: string) => output.push(x), loadRuntime: async () => ({ validateRuntimeConfig() {}, createLiveRuntime: async () => ({ start: async () => { if (mode === 'start') throw Error('secret'); queueMicrotask(() => signals.emit('SIGTERM')); }, close: async () => { closed++; if (mode === 'close') throw Error('secret'); } }) }) });
      assert.equal(status, 1); assert.equal(closed, 1); assert.equal(output.some(x => x.includes('secret')), false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('late start completion does not announce started; factory failure is sanitized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unified-entry-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ runtime: { artifactStatePath: '/a', catalogSources: [], allowedProjectRoots: [], outputRoots: [] }, sdkDb: '/s' }), { mode: 0o600 });
    const signals = new EventEmitter(); let resolveStart!: () => void, entered!: () => void, closed = 0;
    const pending = new Promise<void>(resolve => { resolveStart = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const output: string[] = [];
    const base = { signals, env: { FEISHU_APP_ID: 'id', FEISHU_APP_SECRET: 'secret' }, log: (x: string) => output.push(x), fail: (x: string) => output.push(x) };
    const result = main(['--run', '--config', path], { ...base, loadRuntime: async () => ({ validateRuntimeConfig() {}, createLiveRuntime: async () => ({ start: () => { entered(); return pending; }, close: async () => { closed++; } }) }) });
    await ready; signals.emit('SIGTERM'); assert.equal(await result, 0);
    resolveStart(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 1); assert.equal(output.some(x => x.includes('started')), false);
    assert.equal(await main(['--run', '--config', path], { ...base, loadRuntime: async () => ({ validateRuntimeConfig() {}, createLiveRuntime: async () => { throw Error('secret'); } }) }), 1);
    assert.equal(output.some(x => x.includes('secret')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('real lifecycle with entry closes during either pending startup phase', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unified-entry-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ runtime: { artifactStatePath: '/a', catalogSources: [], allowedProjectRoots: [], outputRoots: [] }, sdkDb: '/s' }), { mode: 0o600 });
    for (const phase of ['connect', 'port']) {
      const signals = new EventEmitter(); let release!: () => void, entered!: () => void, polling = 0, portStarts = 0, runtimeCloses = 0;
      const pending = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
      const runtime = { handleTrusted: async () => {}, captureResourceScope: async () => '', startPolling: () => { polling++; }, close: async () => { runtimeCloses++; } };
      const transport = { connect: async () => { if (phase === 'connect') { entered(); await pending; } }, close() {} };
      const port = { start: async () => { portStarts++; if (phase === 'port') { entered(); await pending; } }, stopReceiving() {}, close() {} };
      const live = liveRuntimeLifecycle(runtime as never, transport as never, port as never);
      const result = main(['--run', '--config', path], { signals, env: { FEISHU_APP_ID: 'id', FEISHU_APP_SECRET: 'secret' }, log() {}, fail() {}, loadRuntime: async () => ({ validateRuntimeConfig() {}, createLiveRuntime: async () => live }) });
      await ready; signals.emit('SIGTERM'); assert.equal(await result, 0); release(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(runtimeCloses, 1); assert.equal(polling, 0); assert.equal(portStarts, phase === 'connect' ? 0 : 1);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('actual SDK port rejects late bot identity and closes late WS start', async () => {
  const { FeishuSdkPort } = await import('../src/unified/feishu-sdk-port.js');
  for (const phase of ['bot', 'ws']) {
    let release!: () => void, entered!: () => void, starts = 0, closes = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const port = new FeishuSdkPort({ appId: 'fixture', appSecret: 'fixture' }, ':memory:', new Set(['chat']), 'owner');
    const inject = port as unknown as { client: unknown; ws: unknown };
    inject.client = { request: async () => { if (phase === 'bot') { entered(); await pending; } return { bot: { open_id: 'bot' } }; } };
    inject.ws = { start: async () => { starts++; if (phase === 'ws') { entered(); await pending; } }, close: () => { closes++; } };
    const start = port.start(async () => {}, async () => '');
    await ready; port.stopReceiving(); port.close(); port.close(); release();
    await assert.rejects(start);
    assert.equal(starts, phase === 'bot' ? 0 : 1);
    assert.ok(closes >= 2);
  }
});
