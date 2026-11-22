import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlatformObservation, PlatformPort } from '../src/unified/adapter.js';
import type { Capabilities, NativeSessionRef, Session } from '../src/unified/contracts.js';
import type { FeishuPort } from '../src/unified/feishu-channel.js';
import { createIntegratedRuntime, type RuntimeConfig } from '../src/unified/runtime.js';

const caps = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map(
    k => [k, { status: k === 'view' ? 'available' : 'unsupported' }],
  ),
) as Capabilities;

function makeSession(project: string, nativeSessionId: string): Session {
  return {
    sessionId: nativeSessionId,
    native: { provider: 'codex', hostId: 'h', serviceId: 'x', nativeSessionId },
    project,
    title: nativeSessionId,
    status: 'read_only',
    revision: 0,
    capabilities: caps,
    control: {
      serviceId: 'x',
      owner: null,
      input: 'unavailable',
      generation: 0,
      operationId: null,
      reason: null,
    },
  };
}

function makeFixture(dir: string) {
  const project = join(dir, 'project');
  const logs = join(dir, 'logs');
  mkdirSync(project, { recursive: true });
  mkdirSync(logs, { recursive: true });

  const config: RuntimeConfig = {
    coreDb: join(dir, 'core.sqlite'),
    channelDb: join(dir, 'channel.sqlite'),
    artifactStatePath: join(dir, 'artifacts.json'),
    ownerOpenId: 'owner',
    allowedDestinations: ['chat'],
    hostId: 'h',
    claudeServiceId: 'c',
    codexServiceId: 'x',
    claudeStateDir: dir,
    codexEndpoint: 'codex-proxy://default',
    intervalMs: 100,
    catalogSources: [{ provider: 'codex', directory: logs, hostId: 'h', serviceId: 'x' }],
    allowedProjectRoots: [project],
    outputRoots: [project],
  };

  const port: FeishuPort & { authorizedDestination(destination: string): boolean } = {
    authorizedDestination: (destination: string) => destination === 'chat',
    async send() { return 'm1'; },
    async update() {},
    async sendFile() {},
  };

  return { project, config, port };
}

function makeBasePort(options: {
  listItems?: () => Session[];
  discoverRunning?: () => Promise<{ items: Session[]; nextCursor: null }>;
  read?: (ref: NativeSessionRef) => Promise<{
    session: Session;
    messages: [];
    turns: [];
    interactions: [];
  }>;
  onEmitReady?: (emit: (o: PlatformObservation) => void) => void;
}): PlatformPort {
  const listeners = new Set<(o: PlatformObservation) => void>();
  return {
    provider: 'codex',
    onObservation(listener) {
      listeners.add(listener);
      options.onEmitReady?.(o => {
        for (const fn of listeners) fn(o);
      });
      return () => {
        listeners.delete(listener);
      };
    },
    async list() {
      return { items: options.listItems?.() ?? [], nextCursor: null };
    },
    ...(options.discoverRunning ? { discoverRunning: options.discoverRunning } : {}),
    async read(ref) {
      if (options.read) return options.read(ref);
      const found = (options.listItems?.() ?? []).find(
        s => s.native.nativeSessionId === ref.nativeSessionId,
      );
      if (!found) throw new Error('session not found');
      return { session: found, messages: [], turns: [], interactions: [] };
    },
    async resume() { throw new Error('unsupported'); },
    async create() { throw new Error('unsupported'); },
    async input() { throw new Error('unsupported'); },
    async interrupt() { throw new Error('unsupported'); },
    async respond() { throw new Error('unsupported'); },
    async control() { throw new Error('unsupported'); },
    async updateSettings() { throw new Error('unsupported'); },
    async listModels() { return []; },
    async listArtifacts() { return []; },
    async readArtifact() { return new Uint8Array(); },
  };
}

async function coreHealthRow(runtime: Awaited<ReturnType<typeof createIntegratedRuntime>>) {
  const rows = await runtime.core.health();
  const core = rows.find(r => r.component === 'core');
  assert.ok(core, 'core health row must exist');
  return core;
}

test('expired early observation degrades current tick and recovers to healthy on subsequent clean ticks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enrichment-expiry-'));
  const originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;

  let emit!: (o: PlatformObservation) => void;
  const { config, port } = makeFixture(dir);
  const base = makeBasePort({
    onEmitReady: fn => {
      emit = fn;
    },
  });

  const runtime = await createIntegratedRuntime(config, port, [base]);
  try {
    // Clean baseline tick -> core is healthy.
    await runtime.tick();
    const baseline = await coreHealthRow(runtime);
    assert.equal(baseline.status, 'healthy');
    assert.equal(baseline.lastFailureAt, null);
    assert.equal(runtime.health().status, 'healthy');

    // Emit an early observation for an unknown session; it enters the 60s buffer.
    const unknownRef: NativeSessionRef = {
      provider: 'codex',
      hostId: 'h',
      serviceId: 'x',
      nativeSessionId: 'early-unknown-session',
    };
    const iso = new Date(now).toISOString();
    emit({
      type: 'event',
      ref: unknownRef,
      event: {
        schemaVersion: 1,
        eventId: 'evt-early',
        sessionId: 'early-unknown-session',
        objectId: 'turn-1',
        objectRevision: 1,
        sequence: 1,
        type: 'turn.started',
        occurredAt: iso,
        receivedAt: iso,
        operationId: null,
        cursor: '1',
        data: {},
      },
    });

    // Advance past the 60s expiry window so refresh discards it and sets enrichmentError = true.
    now += 61_000;
    await assert.rejects(runtime.tick(), /dispatch or synchronization failed/);

    const degraded = await coreHealthRow(runtime);
    assert.equal(degraded.status, 'degraded');
    assert.equal(degraded.reason, '调度或同步失败');
    assert.ok(degraded.lastFailureAt);
    assert.equal(degraded.lastFailureReason, '调度或同步失败');
    assert.equal(runtime.health().status, 'degraded');

    // Subsequent clean ticks must converge back to healthy while preserving failure history.
    await runtime.tick();
    const recovered = await coreHealthRow(runtime);
    assert.equal(recovered.status, 'healthy');
    assert.equal(recovered.reason, null);
    assert.equal(recovered.lastFailureAt, degraded.lastFailureAt);
    assert.equal(recovered.lastFailureReason, '调度或同步失败');
    assert.equal(runtime.health().status, 'healthy');
    assert.equal(runtime.health().reason, null);

    await runtime.tick();
    const steady = await coreHealthRow(runtime);
    assert.equal(steady.status, 'healthy');
    assert.equal(steady.lastFailureAt, degraded.lastFailureAt);
  } finally {
    Date.now = originalNow;
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('async between-tick onObservation and EnrichedPort errors are reported once without premature reset or suppression', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enrichment-async-'));
  const { project, config, port } = makeFixture(dir);
  const validSession = makeSession(project, 'known-session');
  let failRead = false;
  let emit!: (o: PlatformObservation) => void;

  const base = makeBasePort({
    listItems: () => [validSession],
    read: async ref => {
      if (failRead) throw new Error('transient read failure');
      return { session: validSession, messages: [], turns: [], interactions: [] };
    },
    onEmitReady: fn => {
      emit = fn;
    },
  });

  const runtime = await createIntegratedRuntime(config, port, [base]);
  try {
    // Pin and configure output roots for validSession.
    await runtime.core.listSessions({ limit: 10 });
    await runtime.tick();
    assert.equal((await coreHealthRow(runtime)).status, 'healthy');

    // 1) Async onObservation namespace error fired between two ticks must NOT be cleared before reporting.
    await new Promise<void>(resolve => {
      setTimeout(() => {
        const badRef: NativeSessionRef = {
          provider: 'codex',
          hostId: 'wrong-host',
          serviceId: 'x',
          nativeSessionId: 'bad-ns',
        };
        emit({
          type: 'connection',
          ref: badRef,
          connectionGeneration: 1,
        });
        resolve();
      }, 5);
    });

    await assert.rejects(runtime.tick(), /dispatch or synchronization failed/);
    const firstFailure = await coreHealthRow(runtime);
    assert.equal(firstFailure.status, 'degraded');
    assert.ok(firstFailure.lastFailureAt);

    // Next clean tick must recover to healthy.
    await runtime.tick();
    const firstRecovery = await coreHealthRow(runtime);
    assert.equal(firstRecovery.status, 'healthy');
    assert.equal(firstRecovery.lastFailureAt, firstFailure.lastFailureAt);
    assert.equal(firstRecovery.lastFailureReason, '调度或同步失败');

    // 2) Second failure via async EnrichedPort.observeFiles onError callback between ticks must also be reported.
    failRead = true;
    emit({
      type: 'message',
      ref: validSession.native,
      message: {
        messageId: 'm-assistant-1',
        sessionId: 'known-session',
        turnId: 't-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'hello' }],
        sequence: 1,
        revision: 1,
        final: true,
        source: 'codex',
      },
    });
    // Allow EnrichedPort's internal async observeFiles promise chain to catch and call onError().
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    failRead = false;

    await assert.rejects(runtime.tick(), /dispatch or synchronization failed/);
    const secondFailure = await coreHealthRow(runtime);
    assert.equal(secondFailure.status, 'degraded');
    assert.ok(secondFailure.lastFailureAt);

    // Next clean tick must converge to healthy again.
    await runtime.tick();
    const secondRecovery = await coreHealthRow(runtime);
    assert.equal(secondRecovery.status, 'healthy');
    assert.equal(secondRecovery.lastFailureAt, secondFailure.lastFailureAt);
    assert.equal(secondRecovery.lastFailureReason, '调度或同步失败');
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in-tick enrichment error still fails current tick and repeated errors are never suppressed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enrichment-intick-'));
  const { project, config, port } = makeFixture(dir);
  const autoConfig: RuntimeConfig = {
    ...config,
    autoMirror: { enabled: true, destination: 'chat' },
  };
  const validSession = makeSession(project, 'valid-session');
  const badNamespaceSession: Session = {
    ...makeSession(project, 'bad-ns-session'),
    native: { provider: 'codex', hostId: 'unexpected-host', serviceId: 'x', nativeSessionId: 'bad-ns-session' },
  };

  let injectBadDiscovery = true;
  const base = makeBasePort({
    listItems: () => [validSession],
    discoverRunning: async () => ({
      items: injectBadDiscovery ? [badNamespaceSession] : [],
      nextCursor: null,
    }),
  });

  const runtime = await createIntegratedRuntime(autoConfig, port, [base]);
  try {
    // Tick 1: in-tick ScopedPort.discoverRunning triggers enrichmentError.
    await assert.rejects(runtime.tick(), /dispatch or synchronization failed/);
    assert.equal((await coreHealthRow(runtime)).status, 'degraded');

    // Tick 2: consecutive error still fails.
    await assert.rejects(runtime.tick(), /dispatch or synchronization failed/);
    assert.equal((await coreHealthRow(runtime)).status, 'degraded');

    // Tick 3: error clears once discovery becomes clean.
    injectBadDiscovery = false;
    await runtime.tick();
    const recovered = await coreHealthRow(runtime);
    assert.equal(recovered.status, 'healthy');
    assert.ok(recovered.lastFailureAt);
    assert.equal(recovered.lastFailureReason, '调度或同步失败');

    // Tick 4: a subsequent error re-appears and is reported accurately.
    injectBadDiscovery = true;
    await assert.rejects(runtime.tick(), /dispatch or synchronization failed/);
    assert.equal((await coreHealthRow(runtime)).status, 'degraded');

    // Tick 5: recovers again.
    injectBadDiscovery = false;
    await runtime.tick();
    assert.equal((await coreHealthRow(runtime)).status, 'healthy');
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
