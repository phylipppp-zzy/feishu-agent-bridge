import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { UnifiedCore } from '../src/unified/service.js';
import { UnifiedStore } from '../src/unified/store.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';
import { FeishuSdkPort, handleSdkCardCallback, parseSdkCardCallback } from '../src/unified/feishu-sdk-port.js';
import { parseFeishuAction, toFeishuCard } from '../src/unified/feishu-codec.js';
import { ArtifactRegistry } from '../src/unified/artifact-registry.js';
import { AgyCatalog } from '../src/unified/agy-catalog.js';
import { AgyAdapter } from '../src/unified/agy-adapter.js';
import { AgyAcpTransport } from '../src/unified/agy-transport.js';
import { AgyQuotaClient } from '../src/unified/agy-quota.js';
import { validateWire } from '../src/unified/validation.js';
import { createIntegratedRuntime, UnifiedRuntime, type RuntimeConfig } from '../src/unified/runtime.js';
import { payloadDigest, type Artifact, type Capabilities, type Provider, type Session } from '../src/unified/contracts.js';
import type { PlatformPort } from '../src/unified/adapter.js';

const fullCaps = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map((k) => [
    k,
    { status: 'available' },
  ]),
) as Capabilities;

const readonlyCaps = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map((k) => [
    k,
    { status: k === 'view' ? 'available' : 'unsupported' },
  ]),
) as Capabilities;

function makeSession(
  provider: Provider,
  nativeSessionId: string,
  project: string,
  title: string,
  options: { updatedAt?: string; readOnly?: boolean } = {},
): Session {
  return {
    sessionId: `session_${payloadDigest({ provider, hostId: 'h', serviceId: provider, nativeSessionId })}`,
    native: { provider, hostId: 'h', serviceId: provider, nativeSessionId },
    project,
    title,
    ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
    status: options.readOnly ? 'read_only' : 'idle',
    revision: 0,
    capabilities: options.readOnly ? readonlyCaps : fullCaps,
    control: {
      serviceId: provider,
      owner: options.readOnly ? null : 'owner',
      input: options.readOnly ? 'unavailable' : 'available',
      generation: 0,
      operationId: null,
      reason: null,
    },
  };
}

function makeBasePort(provider: Provider, overrides: Partial<PlatformPort> = {}): PlatformPort {
  return {
    provider,
    onObservation: () => () => {},
    list: async () => ({ items: [], nextCursor: null }),
    read: async () => {
      throw new Error('session not found');
    },
    resume: async () => {
      throw new Error('unsupported');
    },
    create: async () => {
      throw new Error('unsupported');
    },
    input: async () => {
      throw new Error('unsupported');
    },
    interrupt: async () => {
      throw new Error('unsupported');
    },
    respond: async () => {
      throw new Error('unsupported');
    },
    control: async () => {
      throw new Error('unsupported');
    },
    updateSettings: async () => {
      throw new Error('unsupported');
    },
    listModels: async () => [],
    listArtifacts: async () => [],
    readArtifact: async () => new Uint8Array(),
    ...overrides,
  };
}

test('Item 1: /health renders Card 1.0 column_set table (abnormal first, healthy next, unverified footer) while keeping text fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3b2-health-'));
  try {
    const sentCards: any[] = [];
    const port: FeishuPort = {
      send: async (_d, c) => {
        sentCards.push(c);
        return 'm1';
      },
      update: async () => {},
      sendFile: async () => {},
    };
    let rows: any[] = [
      {
        component: 'feishu_delivery',
        status: 'healthy',
        reason: null,
        backlog: 0,
        unknown: 0,
        lastObservedAt: '2026-11-22T12:45:00.000Z',
        lastSuccessAt: '2026-11-22T12:41:00.000Z',
        lastFailureAt: null,
        lastDeliveryAt: '2026-11-22T12:41:00.000Z',
        updatedAt: '2026-11-22T12:45:00.000Z',
      },
      {
        component: 'core',
        status: 'degraded',
        reason: 'dispatch or synchronization failed; inspect persisted state before retry',
        backlog: 2,
        unknown: 1,
        lastObservedAt: '2026-11-22T12:42:00.000Z',
        lastSuccessAt: '2026-11-22T12:41:00.000Z',
        lastFailureAt: '2026-11-22T12:42:00.000Z',
        lastDeliveryAt: null,
        updatedAt: '2026-11-22T12:42:00.000Z',
      },
      {
        component: 'codex_connection',
        status: 'unreachable',
        reason: 'connection closed',
        backlog: 0,
        unknown: 0,
        lastObservedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDeliveryAt: null,
        updatedAt: null,
      },
      {
        component: 'codex_run',
        status: 'unverified',
        reason: '尚无可验证观测',
        backlog: null,
        unknown: null,
        lastObservedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDeliveryAt: null,
        updatedAt: null,
      },
      {
        component: 'agy_run',
        status: 'unverified',
        reason: '尚无可验证观测',
        backlog: null,
        unknown: null,
        lastObservedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDeliveryAt: null,
        updatedAt: null,
      },
    ];
    const channel = new FeishuChannel({ health: async () => rows } as any, port, async () => true, join(dir, 'channel.sqlite'));
    try {
      await channel.handle({ eventId: 'h-table', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'health' });
      const card = sentCards.at(-1);
      assert.ok(card.table);
      assert.deepEqual(card.table.columns, [
        { header: '组件', weight: 2 },
        { header: '状态', weight: 1 },
        { header: '最近动态 / 说明', weight: 3 },
      ]);
      // Degraded & unreachable first, healthy after
      assert.equal(card.table.rows.length, 3);
      assert.equal(card.table.rows[0][0], '核心');
      assert.equal(card.table.rows[0][1], '⚠️ 异常或待核对');
      assert.match(card.table.rows[0][2], /存在同步或调度异常.*最近成功 11-22 20:41.*最近失败 11-22 20:42.*待核对 1.*积压 2/);
      assert.equal(card.table.rows[1][0], 'Codex连接');
      assert.equal(card.table.rows[1][1], '❌ 不可连接');
      assert.equal(card.table.rows[2][0], '飞书投递');
      assert.equal(card.table.rows[2][1], '✅ 正常');
      assert.equal(card.table.rows[2][2], '最近成功 11-22 20:41');
      assert.equal(card.table.footer, '⚪ 尚未触发：Codex运行、Antigravity运行');
      // Plain-text fallback still preserved
      assert.match(card.text, /【需关注】/);
      assert.match(card.text, /【正常】/);
      assert.match(card.text, /【尚未触发】/);

      const rendered = toFeishuCard(card) as { elements: any[] };
      assert.equal(rendered.elements[0].tag, 'column_set');
      assert.equal(rendered.elements[0].flex_mode, 'none');
      assert.equal(rendered.elements[0].background_style, 'grey');
      assert.equal(rendered.elements[0].columns[0].elements[0].text.tag, 'lark_md');
      assert.equal(rendered.elements[0].columns[0].elements[0].text.content, '**组件**');
      assert.equal(rendered.elements[1].tag, 'hr');
      assert.equal(rendered.elements[2].tag, 'column_set');
      assert.equal(rendered.elements[3].tag, 'column_set');
      assert.equal(rendered.elements[4].tag, 'column_set');
      assert.equal(rendered.elements[5].tag, 'div');
      assert.equal(rendered.elements[5].text.tag, 'lark_md');
      assert.equal(rendered.elements[5].text.content, '⚪ 尚未触发：Codex运行、Antigravity运行');

      // Empty health omits table cleanly
      rows = [];
      await channel.handle({ eventId: 'h-empty', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'health' });
      const emptyCard = sentCards.at(-1);
      assert.equal(emptyCard.table, undefined);
      assert.equal(emptyCard.text, '暂无健康状态记录。');
    } finally {
      channel.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 2: UnifiedRuntime adaptive polling computes delays and wake() triggers immediate tick and cancels on close()', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3b2-wake-'));
  try {
    const sent: any[] = [];
    const port: FeishuPort = {
      send: async (_d, c) => {
        sent.push(c);
        return `m${sent.length}`;
      },
      update: async () => {},
      sendFile: async () => {},
    };
    const fastCfg: RuntimeConfig = {
      coreDb: join(dir, 'fast-core.sqlite'),
      channelDb: join(dir, 'fast-channel.sqlite'),
      ownerOpenId: 'owner',
      allowedDestinations: ['chat'],
      hostId: 'h',
      claudeServiceId: 'c',
      codexServiceId: 'x',
      claudeStateDir: dir,
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 150,
    };
    const fastRuntime = new UnifiedRuntime(fastCfg, port, []);
    try {
      const now = Date.now();
      assert.equal(fastRuntime.nextPollDelayMs(now), 150);
      assert.equal(fastRuntime.nextPollDelayMs(now + 1_000_000), 150);
    } finally {
      await fastRuntime.close();
    }

    const slowCfg: RuntimeConfig = {
      coreDb: join(dir, 'slow-core.sqlite'),
      channelDb: join(dir, 'slow-channel.sqlite'),
      ownerOpenId: 'owner',
      allowedDestinations: ['chat'],
      hostId: 'h',
      claudeServiceId: 'c',
      codexServiceId: 'x',
      claudeStateDir: dir,
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 5000,
    };
    let refreshCount = 0;
    let releaseInFlight: (() => void) | undefined;
    let blockNextRefresh = false;
    const runtime = new UnifiedRuntime(slowCfg, port, [], {
      refresh: async () => {
        refreshCount++;
        if (blockNextRefresh) {
          blockNextRefresh = false;
          await new Promise<void>((resolve) => {
            releaseInFlight = resolve;
          });
        }
      },
    });
    try {
      const baseTime = Date.now();
      // Active window <= 120s -> 1000ms
      assert.equal(runtime.nextPollDelayMs(baseTime + 30_000), 1000);
      // Warm window 2-10min -> intervalMs (5000ms)
      assert.equal(runtime.nextPollDelayMs(baseTime + 180_000), 5000);
      // Deep idle >10min -> min(15000, intervalMs * 3) = 15000ms
      assert.equal(runtime.nextPollDelayMs(baseTime + 700_000), 15000);

      runtime.startPolling();
      // Wait for initial immediate cycle to finish
      await new Promise((r) => setTimeout(r, 40));
      const beforeWake = refreshCount;
      assert.ok(beforeWake >= 1);

      // Sending handleTrusted while timer is waiting 1000ms wakes tick within ~50ms
      const t0 = Date.now();
      await runtime.handleTrusted({ eventId: 'wake-health', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'health' });
      const deadline = Date.now() + 450;
      while (sent.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(sent.length, 1);
      assert.ok(Date.now() - t0 < 450, 'wake() should trigger tick much faster than 1000ms/5000ms interval');

      // Test wakePending while tick() is currently in-flight
      blockNextRefresh = true;
      const inFlightTick = runtime.tick();
      await new Promise((r) => setTimeout(r, 20));
      const countWhileRunning = refreshCount;
      runtime.wake(); // should set wakePending = true
      releaseInFlight?.();
      await inFlightTick;
      // Wait ~120ms for wakePending 50ms follow-up cycle to execute
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(refreshCount > countWhileRunning, 'wake() during active tick must schedule follow-up cycle');
    } finally {
      await runtime.close();
      assert.equal((runtime as any).timer, undefined);
      assert.equal((runtime as any).polling, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 2b: wake() while restoreBindings() is in flight does not overlap poll cycles or leak a second timer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3b2-wake-restore-race-'));
  try {
    const port: FeishuPort = {
      send: async () => 'm1',
      update: async () => {},
      sendFile: async () => {},
    };
    const cfg: RuntimeConfig = {
      coreDb: join(dir, 'core.sqlite'),
      channelDb: join(dir, 'channel.sqlite'),
      ownerOpenId: 'owner',
      allowedDestinations: ['chat'],
      hostId: 'h',
      claudeServiceId: 'c',
      codexServiceId: 'x',
      claudeStateDir: dir,
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 5000,
    };

    let gen = 1;
    let blockFirstRestoreRead = false;
    let restoreReadCalls = 0;
    let markRestoreEntered: (() => void) | undefined;
    const restoreEntered = new Promise<void>((resolve) => {
      markRestoreEntered = resolve;
    });
    let releaseRestore: (() => void) | undefined;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });

    const codexPort = makeBasePort('codex', {
      read: async (ref) => {
        if (blockFirstRestoreRead) {
          blockFirstRestoreRead = false;
          restoreReadCalls++;
          markRestoreEntered?.();
          await restoreGate;
        }
        const base = makeSession('codex', ref.nativeSessionId, '/work', 'Restore Race');
        return {
          session: {
            ...base,
            native: ref,
            control: { ...base.control, serviceId: ref.serviceId, generation: gen },
          },
          messages: [],
          interactions: [],
          connectionGeneration: gen,
        };
      },
      resume: async (ref) => {
        gen++;
        return {
          status: 'submitted',
          nativeReference: ref.nativeSessionId,
          connectionGeneration: gen,
        };
      },
    });

    // Seed an interactive session and binding so restoreBindings() awaits codexPort.read() on startup
    const seedRuntime = new UnifiedRuntime(cfg, port, [codexPort]);
    try {
      const op = await seedRuntime.core.attachSession({
        context: {
          operationId: 'seed-attach',
          idempotencyKey: 'seed-attach',
          targetId: 'new',
          expectedRevision: 0,
          controlGeneration: 0,
          identity: { source: 'feishu', subject: 'owner' },
        },
        payload: { provider: 'codex', hostId: 'h', serviceId: 'x', nativeSessionId: 'cx-restore-race', mode: 'interactive' },
      });
      assert.equal(op.status, 'completed');
      const sessionId = (op.result as { kind: 'session'; sessionId: string }).sessionId;
      const cdb = new DatabaseSync(cfg.channelDb);
      try {
        cdb
          .prepare('INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode) VALUES(?,?,?,?,?,?,?)')
          .run('chat', sessionId, 'b-race', 'feishu', 'owner', 1, 'interactive');
      } finally {
        cdb.close();
      }
    } finally {
      await seedRuntime.close();
    }

    blockFirstRestoreRead = true;
    let refreshCount = 0;
    let activeRefresh = 0;
    let maxActiveRefresh = 0;
    const runtime = new UnifiedRuntime(cfg, port, [codexPort], {
      refresh: async () => {
        activeRefresh++;
        maxActiveRefresh = Math.max(maxActiveRefresh, activeRefresh);
        try {
          refreshCount++;
        } finally {
          activeRefresh--;
        }
      },
    });

    try {
      runtime.startPolling();
      await restoreEntered;
      assert.equal((runtime as any).inPollCycle, true);
      assert.equal((runtime as any).running, undefined);
      assert.equal((runtime as any).timer, undefined);
      assert.equal(refreshCount, 0);

      // Calling wake() while restoreBindings() is in flight must mark wakePending without creating a timer
      runtime.wake();
      runtime.wake();
      assert.equal((runtime as any).wakePending, true);
      assert.equal((runtime as any).wakeScheduled, false);
      assert.equal((runtime as any).timer, undefined);

      // Direct re-entrant runPollCycle() while inPollCycle is true must return early without overlapping
      await (runtime as any).runPollCycle();
      assert.equal((runtime as any).inPollCycle, true);
      assert.equal(refreshCount, 0);
      assert.equal(restoreReadCalls, 1);

      // Wait longer than the 50ms wake delay while restoreBindings() is still paused
      await new Promise((r) => setTimeout(r, 90));
      assert.equal(refreshCount, 0);
      assert.equal(restoreReadCalls, 1);
      assert.equal((runtime as any).timer, undefined);
      assert.equal((runtime as any).inPollCycle, true);
      assert.equal((runtime as any).wakePending, true);

      // Install a sentinel timer to verify runPollCycle()'s finally clears any existing timer before scheduling next
      let staleTimerFired = false;
      const staleStartedAt = Date.now();
      (runtime as any).timer = setTimeout(() => {
        staleTimerFired = true;
      }, 200);

      releaseRestore?.();

      // Wait for initial cycle + 50ms pending-wake follow-up cycle (well under 1000ms active poll interval)
      const deadline = Date.now() + 600;
      while (refreshCount < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(refreshCount, 2, 'pending wake during restoreBindings() must trigger once after runPollCycle finishes');

      // Wait past the 200ms sentinel deadline (still well below 1000ms) to confirm no leaked timer fires
      const remainingTo260 = 260 - (Date.now() - staleStartedAt);
      if (remainingTo260 > 0) {
        await new Promise((r) => setTimeout(r, remainingTo260));
      }
      assert.equal(staleTimerFired, false, 'runPollCycle finally must clear any existing timer before scheduling next');
      assert.equal(refreshCount, 2, 'must not leak a second timer or start overlapping poll cycles');
      assert.equal(maxActiveRefresh, 1);
      assert.equal((runtime as any).wakePending, false);
      assert.equal((runtime as any).wakeScheduled, false);
      assert.ok((runtime as any).timer !== undefined, 'regular poll timer should remain scheduled');
      assert.equal(runtime.health().status, 'healthy');
    } finally {
      releaseRestore?.();
      await runtime.close();
      assert.equal((runtime as any).timer, undefined);
      assert.equal((runtime as any).polling, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 3a: listSessions scopes to requested provider, runs providers in parallel, and heals stale fallback/older titles in store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3b2-list-'));
  try {
    const store = new UnifiedStore(join(dir, 'core.sqlite'));
    const calls: Provider[] = [];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const staleAgyStored: Session = {
      ...makeSession('agy', 'agy-1', dir, 'Antigravity 会话 · deadbeef', { updatedAt: '2026-11-22T01:00:00.000Z', readOnly: true }),
    };
    const olderTitleStored: Session = {
      ...makeSession('codex', 'cx-1', dir, 'Old Codex Title', { updatedAt: '2026-11-22T01:00:00.000Z', readOnly: true }),
    };
    const interactiveStored: Session = {
      ...makeSession('claude', 'cl-live', dir, 'Live Interactive Title', { updatedAt: '2026-11-22T01:00:00.000Z', readOnly: false }),
    };
    const stableRealStored: Session = {
      ...makeSession('codex', 'cx-stable', dir, 'Pinned Real Title', { updatedAt: '2026-11-22T03:00:00.000Z', readOnly: true }),
    };
    store.insertSession(staleAgyStored);
    store.insertSession(olderTitleStored);
    store.insertSession(interactiveStored);
    store.insertSession(stableRealStored);

    const agyDiscovered: Session = {
      ...staleAgyStored,
      title: 'Real Agy Session Title',
      updatedAt: '2026-11-22T01:00:00.000Z',
    };
    const codexDiscoveredNewer: Session = {
      ...olderTitleStored,
      title: 'Refreshed Codex Title',
      updatedAt: '2026-11-22T04:00:00.000Z',
    };
    const codexDiscoveredFallback: Session = {
      ...stableRealStored,
      title: 'Codex 会话 · 1234abcd',
      updatedAt: '2026-11-22T05:00:00.000Z',
    };
    const claudeDiscovered: Session = {
      ...interactiveStored,
      title: 'Should Not Overwrite Interactive',
      updatedAt: '2026-11-22T05:00:00.000Z',
    };

    const codexPort = makeBasePort('codex', {
      list: async () => {
        calls.push('codex');
        await delay(120);
        return { items: [codexDiscoveredNewer, codexDiscoveredFallback], nextCursor: null };
      },
    });
    const claudePort = makeBasePort('claude', {
      list: async () => {
        calls.push('claude');
        await delay(120);
        return { items: [claudeDiscovered], nextCursor: null };
      },
    });
    const agyPort = makeBasePort('agy', {
      list: async () => {
        calls.push('agy');
        await delay(120);
        return { items: [agyDiscovered], nextCursor: null };
      },
    });

    const core = new UnifiedCore(store, [codexPort, claudePort, agyPort], () => true, () => true, () => false, () => true);
    try {
      // 1. Scoped provider query only calls that provider
      const scoped = await core.listSessions({ limit: 10, provider: 'agy' });
      assert.deepEqual(calls, ['agy']);
      assert.equal(scoped.items.length, 1);
      assert.equal(scoped.items[0]?.title, 'Real Agy Session Title');
      assert.equal(store.getSession(staleAgyStored.sessionId).title, 'Real Agy Session Title');

      // 2. Multi-provider query runs in parallel (~120ms, not >=360ms) and heals/preserves titles accurately
      calls.length = 0;
      const t0 = Date.now();
      const all = await core.listSessions({ limit: 10, provider: 'all' });
      const elapsed = Date.now() - t0;
      assert.equal(calls.length, 3);
      assert.ok(elapsed < 280, `expected parallel provider listing (<280ms), got ${elapsed}ms`);

      const byId = new Map(all.items.map((s) => [s.sessionId, s]));
      // Newer real title healed
      assert.equal(byId.get(olderTitleStored.sessionId)?.title, 'Refreshed Codex Title');
      assert.equal(store.getSession(olderTitleStored.sessionId).title, 'Refreshed Codex Title');
      // Real title did NOT regress to generic fallback
      assert.equal(byId.get(stableRealStored.sessionId)?.title, 'Pinned Real Title');
      assert.equal(store.getSession(stableRealStored.sessionId).title, 'Pinned Real Title');
      // Interactive session was NOT overwritten
      assert.equal(byId.get(interactiveStored.sessionId)?.title, 'Live Interactive Title');
      assert.equal(store.getSession(interactiveStored.sessionId).title, 'Live Interactive Title');

      // 3. Search can find the healed title on stored session
      const searched = await core.listSessions({ limit: 10, search: 'Real Agy Session' });
      assert.equal(searched.items.length, 1);
      assert.equal(searched.items[0]?.sessionId, staleAgyStored.sessionId);
    } finally {
      core.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 3b & Item 4: FeishuSdkPort populates cardMessageId, races card.action.trigger at 1500ms, and FeishuChannel updates cards in-place with fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3b2-inplace-'));
  try {
    // Part A: parseSdkCardCallback & handleSdkCardCallback populate cardMessageId, and start() card.action.trigger 1500ms timeout
    const sdk = new FeishuSdkPort({ appId: 'app', appSecret: 'sec' }, join(dir, 'sdk.sqlite'), new Set(['chat-main']), 'owner');
    let seq = 0;
    const patches: any[] = [];
    let handles!: Map<string, (data: any) => Promise<any>>;
    (sdk as any).client = {
      request: async () => ({ bot: { open_id: 'bot' } }),
      im: {
        message: {
          create: async () => ({ code: 0, data: { message_id: `om_msg_${++seq}` } }),
          reply: async () => ({ code: 0, data: { message_id: `om_msg_${++seq}` } }),
          patch: async (arg: any) => {
            patches.push(arg);
            return { code: 0 };
          },
        },
        file: { create: async () => ({ file_key: 'fk' }) },
      },
    };
    (sdk as any).ws = {
      start: async ({ eventDispatcher }: any) => {
        handles = eventDispatcher.handles;
      },
      close() {},
    };

    try {
      const sentMsgId = await sdk.send('chat-main', { title: '列表', text: 'initial', actions: [] }, 'del-init');
      const rawEvt: any = {
        event_id: 'cb-1',
        context: { open_message_id: sentMsgId, open_chat_id: 'chat-main' },
        operator: { open_id: 'owner' },
        action: { tag: 'button', value: { action: 'list', provider: 'codex', search: 'codex' } },
      };
      const parsed = parseSdkCardCallback(rawEvt, 'owner', (c, m) => sdk.callbackDestination(c, m))!;
      assert.equal(parsed.envelope.cardMessageId, sentMsgId);

      const seenEnvelopes: any[] = [];
      await handleSdkCardCallback(
        rawEvt,
        'owner',
        new Set(['chat-main']),
        (c, m) => sdk.callbackDestination(c, m),
        async (env) => {
          seenEnvelopes.push(env);
        },
      );
      assert.equal(seenEnvelopes[0]?.cardMessageId, sentMsgId);

      // Slow handler (>1500ms) inside start() returns toast within ~1500ms without dropping background work
      let backgroundDone = false;
      await sdk.start(
        async (env) => {
          await new Promise((r) => setTimeout(r, 1700));
          await sdk.update(env.destination, env.cardMessageId!, { title: '更新后', text: 'done', actions: [] }, 'bg-update');
          backgroundDone = true;
        },
        async () => 'global',
      );
      const t0 = Date.now();
      const triggerRes = await handles.get('card.action.trigger')!({
        ...rawEvt,
        event_id: 'cb-slow',
      });
      const elapsed = Date.now() - t0;
      assert.deepEqual(triggerRes, { toast: { type: 'info', content: '正在处理…' } });
      assert.ok(elapsed >= 1450 && elapsed < 1700, `expected ~1500ms race, got ${elapsed}ms`);
      assert.equal(backgroundDone, false);
      await new Promise((r) => setTimeout(r, 350));
      assert.equal(backgroundDone, true);
      assert.equal(patches.length, 1);
    } finally {
      sdk.close();
    }

    // Part B: FeishuChannel replyOrUpdate for list, artifacts, create + fallback to send on update failure + no fallback on guard failure
    const sent: any[] = [];
    const updated: any[] = [];
    let failUpdate = false;
    let allow = true;
    const channelPort: FeishuPort = {
      send: async (d, c) => {
        sent.push({ d, c });
        return `sent-${sent.length}`;
      },
      update: async (d, messageId, c, _del, guard) => {
        await guard?.();
        if (failUpdate) throw new Error('card too old');
        updated.push({ d, messageId, c });
      },
      sendFile: async () => {},
    };
    const store = new UnifiedStore(join(dir, 'core2.sqlite'));
    const proj = join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    const s = makeSession('codex', 's-inplace', proj, 'InPlace Session');
    store.insertSession(s);
    const fakeArtifacts: Artifact[] = Array.from({ length: 10 }, (_, i) => ({
      artifactId: `art-${i}`,
      sessionId: s.sessionId,
      name: `file-${i}.txt`,
      relativePath: `sub/file-${i}.txt`,
      mediaType: 'text/plain',
      size: 100 + i,
      contentVersion: `ver-${i}`.padEnd(64, '0'),
    }));
    const codexMock = makeBasePort('codex', {
      list: async () => ({ items: [s], nextCursor: null }),
      listArtifacts: async () => fakeArtifacts,
      create: async (cwd) => ({
        status: 'submitted',
        nativeReference: 'created-1',
        createdSession: makeSession('codex', 'created-1', cwd, 'New'),
        connectionGeneration: 1,
      }),
    });
    const core = new UnifiedCore(store, [codexMock], () => true, () => true, () => false, () => true);
    const channel = new FeishuChannel(core, channelPort, async () => allow, join(dir, 'chan2.sqlite'));
    try {
      await channel.handle({ eventId: 'b1', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'bind', sessionId: s.sessionId });
      const sentBefore = sent.length;

      // 1. list with cardMessageId updates in-place
      await channel.handle(
        { eventId: 'c-list', destination: 'chat', identity: { source: 'feishu', subject: 'owner' }, cardMessageId: 'om_list_1' },
        { action: 'list', provider: 'codex', search: 'codex' },
      );
      assert.equal(sent.length, sentBefore);
      assert.equal(updated.at(-1)?.messageId, 'om_list_1');

      // 2. artifacts with cardMessageId updates in-place
      await channel.handle(
        { eventId: 'c-art', destination: 'chat', identity: { source: 'feishu', subject: 'owner' }, cardMessageId: 'om_art_1' },
        { action: 'artifacts', cursor: '8' },
      );
      assert.equal(sent.length, sentBefore);
      assert.equal(updated.at(-1)?.messageId, 'om_art_1');

      // 3. create with cardMessageId updates in-place
      await channel.handle(
        { eventId: 'c-create', destination: 'chat', identity: { source: 'feishu', subject: 'owner' }, cardMessageId: 'om_new_1' },
        { action: 'create', provider: 'codex', project: proj, model: null },
      );
      assert.equal(sent.length, sentBefore);
      assert.equal(updated.at(-1)?.messageId, 'om_new_1');

      // 4. Fallback to send when port.update throws (and no stale unknown delivery remains)
      failUpdate = true;
      await channel.handle(
        { eventId: 'c-list-fb', destination: 'chat', identity: { source: 'feishu', subject: 'owner' }, cardMessageId: 'om_old' },
        { action: 'list' },
      );
      assert.equal(sent.length, sentBefore + 1);
      assert.deepEqual(channel.pendingDeliveries(), []);

      // 5. If guard fails inside update, never falls back to send
      failUpdate = false;
      const channelPortGuardFail: FeishuPort = {
        ...channelPort,
        update: async (_d, _m, _c, _del, guard) => {
          allow = false;
          await guard?.();
        },
      };
      const channel2 = new FeishuChannel(core, channelPortGuardFail, async () => allow, join(dir, 'chan2.sqlite'));
      try {
        allow = true;
        const sentSnapshot = sent.length;
        await assert.rejects(
          channel2.handle(
            { eventId: 'c-guard-fail', destination: 'chat', identity: { source: 'feishu', subject: 'owner' }, cardMessageId: 'om_guard' },
            { action: 'list' },
          ),
          /unauthorized/,
        );
        assert.equal(sent.length, sentSnapshot);
      } finally {
        channel2.close();
      }
    } finally {
      channel.close();
      core.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 5: /file tree view, relativePath (registry + agy), dedup, 8/page pagination, and >100 download', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3b2-files-'));
  try {
    const project = join(dir, 'proj');
    const docsDir = join(project, 'docs');
    const outsideOut = join(dir, 'outputs');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(outsideOut, { recursive: true });
    const f1 = join(project, 'README.md');
    const f2 = join(docsDir, 'design.md');
    const f3 = join(outsideOut, 'bundle.txt');
    writeFileSync(f1, 'hello', 'utf8');
    writeFileSync(f2, 'A'.repeat(2048), 'utf8');
    writeFileSync(f3, 'outside', 'utf8');

    const ref = { provider: 'codex' as const, hostId: 'h', serviceId: 'svc', nativeSessionId: 'n1' };
    const statePath = join(dir, 'registry.json');
    const registry = new ArtifactRegistry({}, 1024 * 1024, statePath);
    registry.setProjectRoot(ref, project);
    registry.setRoots(ref, [project, outsideOut]);
    const r1 = await registry.register(JSON.stringify([ref.provider, ref.hostId, ref.serviceId, ref.nativeSessionId]), f1);
    const r2 = await registry.register(JSON.stringify([ref.provider, ref.hostId, ref.serviceId, ref.nativeSessionId]), f2);
    const r3 = await registry.register(JSON.stringify([ref.provider, ref.hostId, ref.serviceId, ref.nativeSessionId]), f3);
    assert.equal(r1.relativePath, 'README.md');
    assert.equal(r2.relativePath, 'docs/design.md');
    assert.equal(r3.relativePath, 'outputs/bundle.txt');

    const reloaded = new ArtifactRegistry({}, 1024 * 1024, statePath);
    reloaded.setProjectRoot(ref, project);
    reloaded.setRoots(ref, [project, outsideOut]);
    await reloaded.load();
    const regList = reloaded.list(JSON.stringify([ref.provider, ref.hostId, ref.serviceId, ref.nativeSessionId]), 10);
    assert.deepEqual(regList.items.map((x) => x.relativePath).sort(), ['README.md', 'docs/design.md', 'outputs/bundle.txt']);
    assert.equal(validateWire('response.listArtifacts', regList).ok, true);

    // AgyAdapter brain artifacts carry relativePath = `会话产物/${entry.relativePath}`
    const brainDir = join(dir, 'brain');
    const agyConvDir = join(brainDir, 'conv-art-1', 'reports');
    mkdirSync(agyConvDir, { recursive: true });
    writeFileSync(join(agyConvDir, 'plan.md'), '# Plan\n', 'utf8');
    const dbPath = join(dir, 'summaries.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        workspace_uris TEXT,
        last_modified_at TEXT,
        last_user_input_at TEXT,
        step_count INTEGER,
        status TEXT,
        killed INTEGER,
        is_top_level INTEGER
      );
    `);
    db.prepare(
      'INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('conv-art-1', 'Agy Art', 'preview', JSON.stringify([pathToFileURL(project).href]), '2026-11-22T01:00:00.000Z', null, 1, 'idle', 0, 1);
    db.close();
    const agyCatalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [project] });
    const agyAdapter = new AgyAdapter(
      new AgyAcpTransport({ agyBin: 'true' }),
      agyCatalog,
      'h',
      'agy',
      new AgyQuotaClient({ agyBin: 'true' }),
    );
    const agyArts = await agyAdapter.listArtifacts({ provider: 'agy', hostId: 'h', serviceId: 'agy', nativeSessionId: 'conv-art-1' });
    assert.equal(agyArts.length, 1);
    assert.equal(agyArts[0]?.relativePath, '会话产物/reports/plan.md');

    // parseFeishuAction supports optional cursor on artifacts
    const parsedAction = parseFeishuAction({ action: 'artifacts', bindingId: 'b-1', cursor: '8' });
    assert.deepEqual(parsedAction, { action: 'artifacts', cursor: '8', bindingId: 'b-1' });

    // FeishuChannel: default dir, dedup, same-path different-version hash, tree, 8/page pagination, and >100 download
    const sentCards: any[] = [];
    const uploadedFiles: Array<{ name: string; text: string }> = [];
    const port: FeishuPort = {
      send: async (_d, c) => {
        sentCards.push(c);
        return `m-${sentCards.length}`;
      },
      update: async () => {},
      sendFile: async (_d, name, content) => {
        uploadedFiles.push({ name, text: Buffer.from(content).toString('utf8') });
      },
    };
    const store = new UnifiedStore(join(dir, 'core-file.sqlite'));
    const session = makeSession('codex', 's-files', project, 'Files Session');
    store.insertSession(session);
    const vA = 'a'.repeat(64);
    const vB = 'b'.repeat(64);
    const manyArtifacts: Artifact[] = [
      // Duplicate exact (relativePath, contentVersion) -> collapsed to 1
      { artifactId: 'dup-1', sessionId: session.sessionId, name: 'README.md', relativePath: 'README.md', mediaType: 'text/markdown', size: 120, contentVersion: vA },
      { artifactId: 'dup-2', sessionId: session.sessionId, name: 'README.md', relativePath: 'README.md', mediaType: 'text/markdown', size: 120, contentVersion: vA },
      // Same path, different contentVersion -> both kept with 6-char hash
      { artifactId: 'ver-2', sessionId: session.sessionId, name: 'README.md', relativePath: 'README.md', mediaType: 'text/markdown', size: 2048, contentVersion: vB },
      // 8 more unique files in docs/ and 会话产物/ -> total 10 deduped items across 2 pages (8 + 2)
      ...Array.from({ length: 8 }, (_, i) => ({
        artifactId: `doc-${i}`,
        sessionId: session.sessionId,
        name: i === 0 ? 'very-long-implementation-design-specification-v2.md' : i < 4 ? `doc-${i}.md` : `out-${i}.png`,
        relativePath: i < 4 ? `docs/${i === 0 ? 'very-long-implementation-design-specification-v2.md' : `doc-${i}.md`}` : `会话产物/out-${i}.png`,
        mediaType: 'text/markdown',
        size: i === 0 ? 2 * 1024 * 1024 : 512 * (i + 1),
        contentVersion: `${i}`.padStart(64, 'c'),
      })),
    ];
    const portMock = makeBasePort('codex', {
      listArtifacts: async () => manyArtifacts,
      readArtifact: async (_ref, id) => Buffer.from(`content:${id}`, 'utf8'),
    });
    const core = new UnifiedCore(store, [portMock], () => true);
    const channel = new FeishuChannel(core, port, async () => true, join(dir, 'chan-file.sqlite'));
    try {
      await channel.handle({ eventId: 'bind', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'bind', sessionId: session.sessionId });
      await channel.handle({ eventId: 'files-p1', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'artifacts' });
      const card1 = sentCards.at(-1);
      assert.match(card1.text, new RegExp(`默认目录：${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(card1.text, /共 10 个文件（第 1\/2 页）/);
      assert.match(card1.text, /📁 \.\//);
      assert.match(card1.text, /├── 1\. README\.md \(120 B\) · aaaaaa/);
      assert.match(card1.text, /└── 2\. README\.md \(2\.0 KB\) · bbbbbb/);
      assert.match(card1.text, /📁 docs\//);
      assert.match(card1.text, /2\.0 MB/);
      assert.doesNotMatch(card1.text, new RegExp(vA)); // no 64-char SHA-256
      assert.equal(card1.actions.length, 9); // 8 file buttons + 下一页
      assert.equal(card1.actions[0].label, '1. README.md (aaaaaa)');
      assert.equal(card1.actions[1].label, '2. README.md (bbbbbb)');
      assert.ok(card1.actions[2].label.startsWith('3. ') && card1.actions[2].label.endsWith('…'));
      assert.equal(card1.actions[8].label, '下一页');
      assert.equal(card1.actions[8].value.action, 'artifacts');
      assert.equal(card1.actions[8].value.cursor, '8');
      assert.ok(typeof card1.actions[8].value.bindingId === 'string' && card1.actions[8].value.bindingId.length > 0);
      assert.equal(parseFeishuAction(card1.actions[8].value).action, 'artifacts');

      // Page 2
      await channel.handle({ eventId: 'files-p2', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'artifacts', cursor: '8' });
      const card2 = sentCards.at(-1);
      assert.match(card2.text, /共 10 个文件（第 2\/2 页）/);
      assert.match(card2.text, /📁 会话产物\//);
      assert.equal(card2.actions.length, 3); // 2 file buttons + 上一页
      assert.equal(card2.actions[0].label, '1. out-6.png');
      assert.equal(card2.actions[1].label, '2. out-7.png');
      assert.equal(card2.actions[2].label, '上一页');
      assert.equal(card2.actions[2].value.action, 'artifacts');
      assert.equal(card2.actions[2].value.cursor, '0');
      assert.ok(typeof card2.actions[2].value.bindingId === 'string' && card2.actions[2].value.bindingId.length > 0);

      // Verify >100 items can still be downloaded via action: 'file'
      for (let i = 0; i < 105; i++) {
        manyArtifacts.push({
          artifactId: `extra-${i}`,
          sessionId: session.sessionId,
          name: `extra-${i}.txt`,
          relativePath: `extra/extra-${i}.txt`,
          mediaType: 'text/plain',
          size: 10,
          contentVersion: `${i}`.padStart(64, 'e'),
        });
      }
      await channel.handle(
        { eventId: 'dl-104', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } },
        { action: 'file', artifactId: 'extra-104', contentVersion: '104'.padStart(64, 'e') },
      );
      assert.equal(uploadedFiles.at(-1)?.name, 'extra-104.txt');
      assert.equal(uploadedFiles.at(-1)?.text, 'content:extra-104');
    } finally {
      channel.close();
      core.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 6: core health does not stay poisoned by deleted native read-only sessions, unavailable providers, or transient contention, and recovers cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3b2-core-health-'));
  try {
    const project = join(dir, 'proj');
    const logs = join(dir, 'logs');
    mkdirSync(project, { recursive: true });
    mkdirSync(logs, { recursive: true });

    const cfg: RuntimeConfig = {
      coreDb: join(dir, 'core.sqlite'),
      channelDb: join(dir, 'channel.sqlite'),
      artifactStatePath: join(dir, 'artifacts.json'),
      ownerOpenId: 'owner',
      allowedDestinations: ['chat'],
      hostId: 'h',
      claudeServiceId: 'c',
      codexServiceId: 'x',
      claudeStateDir: join(dir, 'claude-state'),
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 60_000,
      catalogSources: [
        { provider: 'claude', hostId: 'h', serviceId: 'c', directory: logs },
        { provider: 'codex', hostId: 'h', serviceId: 'x', directory: logs },
      ],
      allowedProjectRoots: [project],
      outputRoots: [project],
      autoMirror: { enabled: true, destination: 'chat' },
    };

    const seed = new UnifiedStore(cfg.coreDb);
    const deletedClaudeSession: Session = {
      sessionId: 'session_deleted_claude',
      native: { provider: 'claude', hostId: 'h', serviceId: 'c', nativeSessionId: 'missing-claude-id' },
      project, // project dir STILL exists on disk, only native transcript is missing!
      title: 'Deleted Native Claude',
      status: 'read_only',
      revision: 0,
      capabilities: readonlyCaps,
      control: { serviceId: 'c', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: 'legacy' },
    };
    const codexReadonlySession: Session = {
      sessionId: 'session_codex_ro',
      native: { provider: 'codex', hostId: 'h', serviceId: 'x', nativeSessionId: 'cx-ro' },
      project,
      title: 'Codex RO',
      status: 'read_only',
      revision: 0,
      capabilities: readonlyCaps,
      control: { serviceId: 'x', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: null },
    };
    seed.insertSession(deletedClaudeSession);
    seed.insertSession(codexReadonlySession);
    seed.close();

    let claudeMode: 'missing' | 'pending' | 'timeout' | 'ok' = 'missing';
    const claudeBase = makeBasePort('claude', {
      discoverExisting: async () => {
        if (claudeMode === 'pending') throw new Error('previous metadata read still pending');
        if (claudeMode === 'timeout') throw new Error('metadata read timed out');
        return { items: [], nextCursor: null };
      },
      discoverNewer: async () => ({ items: [], nextCursor: null }),
      read: async (ref) => {
        if (claudeMode === 'missing') throw new Error('session not found');
        if (claudeMode === 'pending') throw new Error('previous metadata read still pending');
        if (claudeMode === 'timeout') throw new Error('metadata read timed out');
        return { session: { ...deletedClaudeSession, native: ref }, messages: [], interactions: [] };
      },
    });
    const codexBase = makeBasePort('codex', {
      discoverRunning: async () => {
        throw new Error('not connected');
      },
      discoverExisting: async () => {
        throw new Error('not connected');
      },
      discoverNewer: async () => {
        throw new Error('not connected');
      },
      read: async () => {
        throw new Error('not connected');
      },
    });
    const port: FeishuPort & { authorizedDestination: (d: string) => boolean } = {
      authorizedDestination: (d) => d === 'chat',
      send: async () => 'm1',
      update: async () => {},
      sendFile: async () => {},
    };

    const runtime = await createIntegratedRuntime(cfg, port, [claudeBase, codexBase]);
    try {
      // Bind deleted Claude session as read_only
      await runtime.channel.handle({ eventId: 'bind-cl', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'bind', sessionId: deletedClaudeSession.sessionId, mode: 'read_only' });
      // Mark Codex disconnected (as liveRuntimeLifecycle does while WS is offline)
      runtime.setProviderReady('codex', false);

      // 1. Deleted native session + disconnected codex must NOT poison core health
      await runtime.tick();
      assert.equal(runtime.health().status, 'healthy');
      assert.equal((await runtime.core.health()).find((r) => r.component === 'core')?.status, 'healthy');

      // 2. Transient pending contention & 1-2 timeouts must NOT poison core health
      claudeMode = 'pending';
      await runtime.tick();
      assert.equal((await runtime.core.health()).find((r) => r.component === 'core')?.status, 'healthy');

      claudeMode = 'timeout';
      await runtime.tick();
      await runtime.tick();
      assert.equal((await runtime.core.health()).find((r) => r.component === 'core')?.status, 'healthy');

      // 3. Real unexpected failure degrades core, and subsequent clean tick recovers BOTH runtime and core.health()
      claudeBase.read = async () => {
        throw new Error('transient disk I/O error');
      };
      await assert.rejects(runtime.tick(), /dispatch or synchronization failed/);
      const degradedCore = (await runtime.core.health()).find((r) => r.component === 'core')!;
      assert.equal(degradedCore.status, 'degraded');

      // Recover on next tick
      claudeMode = 'ok';
      claudeBase.read = async (ref) => ({
        session: { ...deletedClaudeSession, native: ref },
        messages: [],
        interactions: [],
      });
      await runtime.tick();
      assert.equal(runtime.health().status, 'healthy');
      const recoveredCore = (await runtime.core.health()).find((r) => r.component === 'core')!;
      assert.equal(recoveredCore.status, 'healthy');
      assert.equal(recoveredCore.reason, null);
    } finally {
      await runtime.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
