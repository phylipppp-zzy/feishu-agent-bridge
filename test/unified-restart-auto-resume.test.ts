import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capabilities, NativeSessionRef, Session } from '../src/unified/contracts.js';
import type { PlatformObservation, PlatformPort } from '../src/unified/adapter.js';
import type { FeishuPort } from '../src/unified/feishu-channel.js';
import { UnifiedRuntime, type RuntimeConfig } from '../src/unified/runtime.js';

function makeConfig(dir: string, autoResumeOnRestart: boolean): RuntimeConfig {
  return {
    coreDb: join(dir, 'core.sqlite'),
    channelDb: join(dir, 'channel.sqlite'),
    ownerOpenId: 'owner-1',
    allowedDestinations: ['chat-1', 'topic:resume-1'],
    hostId: 'host-1',
    claudeServiceId: 'claude-svc',
    codexServiceId: 'codex-svc',
    claudeStateDir: dir,
    codexEndpoint: 'codex-proxy://default',
    intervalMs: 1000,
    agy: { enabled: true, serviceId: 'agy-svc' },
    autoResumeOnRestart,
  };
}

function makeAgySession(nativeId: string, status: Session['status'], active: boolean, controlGeneration = active ? 2 : 1): Session {
  const avail = { status: 'available' as const };
  const unsup = { status: 'unsupported' as const, reason: 'ro' };
  const caps: Capabilities = active
    ? { view: avail, send: avail, queue: unsup, steer: unsup, answer: avail, approve: avail, interrupt: avail, handoff: avail, files: avail, config: avail }
    : { view: avail, send: unsup, queue: unsup, steer: unsup, answer: unsup, approve: unsup, interrupt: unsup, handoff: unsup, files: avail, config: unsup };
  return {
    sessionId: nativeId,
    native: { provider: 'agy', hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId: nativeId },
    project: '/tmp',
    title: 'Long Running Task',
    status,
    revision: 1,
    capabilities: caps,
    control: {
      serviceId: 'agy-svc',
      owner: active ? 'agy-svc' : null,
      input: active ? 'available' : 'unavailable',
      generation: controlGeneration,
      operationId: null,
      reason: null,
    },
  };
}

function makeFakeProvider(nativeId: string, initialStatus: Session['status'], inputs: string[]): PlatformPort {
  let active = false;
  let status: Session['status'] = initialStatus;
  let controlGeneration = 1;
  const listeners = new Set<(obs: PlatformObservation) => void>();
  return {
    provider: 'agy',
    onObservation(fn: (obs: PlatformObservation) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    seedControlGeneration(_ref: NativeSessionRef, minimum: number) {
      controlGeneration = Math.max(controlGeneration, minimum);
    },
    hasActiveNativeSession: () => active,
    async list() { return { items: [makeAgySession(nativeId, status, active, controlGeneration)], nextCursor: null }; },
    async read() { return { session: makeAgySession(nativeId, status, active, controlGeneration), messages: [], turns: [], interactions: [], connectionGeneration: 1 }; },
    async resume() {
      active = true;
      status = 'idle';
      controlGeneration += 1;
      return { status: 'submitted', nativeReference: nativeId, connectionGeneration: 1 };
    },
    async create() {
      controlGeneration += 1;
      return { status: 'submitted', nativeReference: nativeId, createdSession: makeAgySession(nativeId, 'idle', true, controlGeneration), connectionGeneration: 1 };
    },
    async input(_ref: NativeSessionRef, _mode: 'new' | 'steer', blocks: Array<{ type: string; text?: string }>) {
      const text = blocks.map(b => (b.type === 'text' ? b.text ?? '' : '')).join('');
      inputs.push(text);
      status = 'running';
      return { status: 'submitted', nativeReference: 'turn-resumed', connectionGeneration: 1 };
    },
    async respond() { return { status: 'submitted', nativeReference: null }; },
    async interrupt() { return { status: 'submitted', nativeReference: null }; },
    async control(_ref: NativeSessionRef, action: 'acquire' | 'release') {
      active = action === 'acquire';
      status = active ? 'idle' : 'read_only';
      controlGeneration += 1;
      return { status: 'submitted', nativeReference: nativeId, connectionGeneration: 1 };
    },
  } as unknown as PlatformPort;
}

test('UnifiedRuntime auto-resumes running interactive sessions once after restart when autoResumeOnRestart is true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-auto-resume-'));
  try {
    const port: FeishuPort = {
      isTopicDestination: d => d.startsWith('topic:'),
      send: async () => 'm-1',
      update: async () => {},
      sendFile: async () => {},
    };

    // 1. Simulate a running interactive session before graceful shutdown
    const inputsBefore: string[] = [];
    const rt1 = new UnifiedRuntime(makeConfig(dir, true), port, [makeFakeProvider('conv-run', 'running', inputsBefore)]);
    const seeded = makeAgySession('conv-run', 'running', true);
    const sid = 'session_restart_run_1';
    rt1.store.insertSession({ ...seeded, sessionId: sid });
    const storeDb = (rt1.store as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    storeDb.prepare('INSERT OR REPLACE INTO interactive_intent(session_id) VALUES (?)').run(sid);
    rt1.channel.importMigrationBinding('mig-run-1', {
      destination: 'topic:resume-1',
      sessionId: sid,
      bindingId: 'bind-run-1',
      owner: { source: 'feishu', subject: 'owner-1' },
    });
    // Upgrade binding row to interactive
    const db = (rt1.channel as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    db.prepare("UPDATE channel_bindings SET access_mode='interactive' WHERE destination=?").run('topic:resume-1');
    await rt1.close();

    // 2. Restart runtime: provider reconnects asynchronously and auto-resumes the interrupted session ONCE
    const inputsAfter: string[] = [];
    const rt2 = new UnifiedRuntime(makeConfig(dir, true), port, [makeFakeProvider('conv-run', 'idle', inputsAfter)]);
    try {
      rt2.setProviderReady('agy', false);
      await rt2.restoreBindings();
      assert.equal(inputsAfter.length, 0, 'must not resume while provider is unavailable');

      rt2.setProviderReady('agy', true);
      const res = await rt2.restoreProviderAfterReconnect('agy');
      assert.deepEqual(res.restored, [sid]);
      await rt2.core.dispatchPending();
      assert.equal(inputsAfter.length, 1);
      assert.match(inputsAfter[0]!, /重启恢复/);

      // Second reconnect must NOT duplicate resume prompt
      await rt2.restoreProviderAfterReconnect('agy');
      await rt2.core.dispatchPending();
      assert.equal(inputsAfter.length, 1);
    } finally {
      await rt2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FeishuChannel.takeRestartResumeCandidate drops stale candidates older than 10 minutes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-resume-stale-'));
  try {
    const port: FeishuPort = {
      isTopicDestination: () => true,
      send: async () => 'm-1',
      update: async () => {},
      sendFile: async () => {},
    };
    const rt = new UnifiedRuntime(makeConfig(dir, false), port, []);
    try {
      const now = Date.now();
      rt.channel.recordRestartResumeCandidate('sess-old', 'topic:old', { source: 'feishu', subject: 'owner-1' }, now - 15 * 60_000);
      assert.equal(rt.channel.takeRestartResumeCandidate('sess-old', 10 * 60_000, now), null);
      rt.channel.recordRestartResumeCandidate('sess-fresh', 'topic:fresh', { source: 'feishu', subject: 'owner-1' }, now - 30_000);
      const taken = rt.channel.takeRestartResumeCandidate('sess-fresh', 10 * 60_000, now);
      assert.equal(taken?.destination, 'topic:fresh');
      assert.equal(rt.channel.takeRestartResumeCandidate('sess-fresh', 10 * 60_000, now), null, 'must be consumed once');
    } finally {
      await rt.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FeishuChannel does not downgrade interactive binding during transient provider disconnect recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-no-downgrade-'));
  try {
    const port: FeishuPort = {
      isTopicDestination: d => d.startsWith('topic:'),
      send: async () => 'm-1',
      update: async () => {},
      sendFile: async () => {},
    };
    const inputs: string[] = [];
    const rt = new UnifiedRuntime(makeConfig(dir, false), port, [makeFakeProvider('conv-disc', 'read_only', inputs)]);
    try {
      const sid = 'session_disc_1';
      const base = makeAgySession('conv-disc', 'read_only', false, 3);
      for (const reason of [
        'explicit resume required after provider disconnect',
        'explicit resume required after provider restart',
        'discovered agy session is read-only until attached',
      ]) {
        const current = rt.store.findSession(base.native);
        if (!current) {
          rt.store.insertSession({
            ...base,
            sessionId: sid,
            control: { ...base.control, owner: null, input: 'unavailable', reason },
          });
          rt.channel.importMigrationBinding('mig-disc-1', {
            destination: 'topic:resume-1',
            sessionId: sid,
            bindingId: 'bind-disc-1',
            owner: { source: 'feishu', subject: 'owner-1' },
          });
          const db = (rt.channel as unknown as { db: import('node:sqlite').DatabaseSync }).db;
          db.prepare("UPDATE channel_bindings SET access_mode='interactive' WHERE destination=?").run('topic:resume-1');
        } else {
          rt.store.updateSession({
            ...current,
            revision: current.revision + 1,
            control: { ...current.control, generation: current.control.generation + 1, reason },
          }, current.revision, current.control.generation);
        }
        await rt.channel.sync('topic:resume-1');
        assert.equal(rt.channel.accessMode('topic:resume-1'), 'interactive', `must preserve interactive mode for reason: ${reason}`);
      }
    } finally {
      await rt.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
