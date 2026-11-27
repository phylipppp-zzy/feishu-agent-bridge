import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import { createIntegratedRuntime } from '../src/unified/runtime.js';
import type { Capabilities, Session } from '../src/unified/contracts.js';

test('running discovery skips thread/list completely when thread/loaded/list is empty', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const t: any = {
    connected: true,
    generation: 1,
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') {
        return params.cursor === null ? { data: [], nextCursor: 'l2' } : { data: [], nextCursor: null };
      }
      throw Error(`unexpected call: ${method}`);
    },
  };
  const adapter = new CodexAdapter(t, 'host', 'service');
  let cursor: string | null = null;
  const found: Session[] = [];
  do {
    const page = await adapter.discoverRunning(cursor, 1);
    found.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(found, []);
  assert.deepEqual(calls.map((x) => x.method), ['thread/loaded/list', 'thread/loaded/list']);
});

test('running discovery queries loaded IDs in scoped includedThreadIds batches and rejects out-of-batch or non-main items', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const t: any = {
    connected: true,
    generation: 1,
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') {
        return params.cursor === null ? { data: ['active', 'idle', 'sub'], nextCursor: 'l2' } : { data: ['loaded-only'], nextCursor: null };
      }
      if (method === 'thread/list') {
        assert.deepEqual(params.includedThreadIds, ['active', 'idle', 'sub', 'loaded-only']);
        return params.cursor === null
          ? {
              data: [
                { id: 'active', cwd: '/tmp', source: 'cli', parentThreadId: null, status: { type: 'active' } },
                { id: 'idle', cwd: '/tmp', source: 'cli', parentThreadId: null, status: { type: 'idle' } },
                { id: 'sub', cwd: '/tmp', source: { subAgent: 'worker' }, parentThreadId: 'active', status: { type: 'active' } },
              ],
              nextCursor: 'p2',
            }
          : { data: [], nextCursor: null };
      }
      throw Error('unexpected call');
    },
  };
  const adapter = new CodexAdapter(t, 'host', 'service');
  let cursor: string | null = null;
  const found: Session[] = [];
  do {
    const page = await adapter.discoverRunning(cursor, 1);
    found.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(found.map((s) => s.native.nativeSessionId), ['active']);
  assert.equal(found[0]?.status, 'read_only');
  assert.deepEqual(calls.map((x) => x.method), ['thread/loaded/list', 'thread/loaded/list', 'thread/list', 'thread/list']);
  assert.ok(calls.every((x) => !('sourceKinds' in x.params)));
  assert.ok(calls.every((x) => x.params.limit === 100));

  // Out-of-batch thread ID returned by backend must fail closed with snapshot_required.
  const badTransport: any = {
    connected: true,
    generation: 1,
    request: async (method: string) =>
      method === 'thread/loaded/list'
        ? { data: ['wanted'], nextCursor: null }
        : { data: [{ id: 'not-in-batch', cwd: '/tmp', source: 'cli', status: { type: 'active' } }], nextCursor: null },
  };
  const badAdapter = new CodexAdapter(badTransport, 'h', 's');
  const first = await badAdapter.discoverRunning(null, 1);
  assert.ok(first.nextCursor);
  await assert.rejects(badAdapter.discoverRunning(first.nextCursor, 1), { code: 'snapshot_required' });
});

test('discovery fails closed on reconnect and invalid page', async () => {
  const t: any = { connected: true, generation: 1, request: async () => ({ data: ['x'], nextCursor: 'next' }) };
  const adapter = new CodexAdapter(t, 'h', 's');
  const page = await adapter.discoverRunning(null, 1);
  t.generation++;
  await assert.rejects(adapter.discoverRunning(page.nextCursor, 1));
  t.request = async () => ({ data: [null], nextCursor: null });
  await assert.rejects(adapter.discoverRunning(null, 1));
});

test('Codex discoverNewer/discoverExisting respect 30s/90s production cooldowns and autoMirror.backfillNativeIds silently binds without replaying history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-cooldown-backfill-'));
  const project = join(dir, 'proj');
  const logs = join(dir, 'logs');
  mkdirSync(project);
  mkdirSync(logs);
  const originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;

  const caps = Object.fromEntries(
    ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map((k) => [
      k,
      { status: k === 'view' ? 'available' : 'unsupported' },
    ]),
  ) as Capabilities;

  let newerCalls = 0;
  let oldCalls = 0;
  let extraMsg = false;
  const backfillId = 'backfill-codex-1';
  const backfillSession: Session = {
    sessionId: backfillId,
    native: { provider: 'codex', hostId: 'h', serviceId: 'x', nativeSessionId: backfillId },
    createdAt: new Date(now - 3_600_000).toISOString(),
    project,
    title: 'Backfilled Session',
    status: 'read_only',
    revision: 0,
    capabilities: caps,
    control: { serviceId: 'x', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: null },
  };
  const base: any = {
    provider: 'codex',
    onObservation: () => () => {},
    list: async () => ({ items: [backfillSession], nextCursor: null }),
    discoverRunning: async () => ({ items: [], nextCursor: null }),
    discoverNewer: async () => {
      newerCalls += 1;
      return { items: [], nextCursor: null };
    },
    discoverExisting: async () => {
      oldCalls += 1;
      return { items: [], nextCursor: null };
    },
    read: async () => ({
      session: backfillSession,
      messages: [
        { messageId: 'old-1', sessionId: backfillId, turnId: 't1', role: 'assistant', blocks: [{ type: 'text', text: 'OLD_HISTORY_MSG' }], sequence: 1, revision: 1, final: true, source: 'codex' },
        ...(extraMsg
          ? [{ messageId: 'new-1', sessionId: backfillId, turnId: 't2', role: 'assistant', blocks: [{ type: 'text', text: 'FUTURE_INCREMENT_MSG' }], sequence: 2, revision: 1, final: true, source: 'codex' }]
          : []),
      ],
      turns: [],
      interactions: [],
    }),
  };

  const sentCards: any[] = [];
  let topicCreates = 0;
  const port: any = {
    authorizedDestination: () => true,
    isTopicDestination: (d: string) => d.startsWith('topic:'),
    createTopic: async () => {
      topicCreates += 1;
      return `topic:bf-${topicCreates}`;
    },
    send: async (_d: any, card: any) => {
      sentCards.push(card);
      return `m_${sentCards.length}`;
    },
    update: async () => {},
    sendFile: async () => {},
  };

  const cfg: any = {
    coreDb: join(dir, 'core.sqlite'),
    channelDb: join(dir, 'channel.sqlite'),
    artifactStatePath: join(dir, 'artifacts.sqlite'),
    ownerOpenId: 'owner',
    allowedDestinations: ['chat'],
    hostId: 'h',
    claudeServiceId: 'c',
    codexServiceId: 'x',
    claudeStateDir: dir,
    codexEndpoint: 'codex-proxy://default',
    intervalMs: 5000,
    catalogSources: [{ provider: 'codex', directory: logs, hostId: 'h', serviceId: 'x' }],
    allowedProjectRoots: [project],
    outputRoots: [project],
    autoMirror: {
      enabled: true,
      destination: 'chat',
      showTitles: true,
      backfillNativeIds: [{ provider: 'codex', nativeSessionId: backfillId }],
    },
  };

  const rt = await createIntegratedRuntime(cfg, port, [base]);
  try {
    // Tick 1: initial scan runs once + silently backfills backfillId without replaying OLD_HISTORY_MSG
    await rt.tick();
    assert.equal(newerCalls, 1);
    assert.equal(oldCalls, 1);
    assert.equal(topicCreates, 1);
    assert.equal(sentCards.some((c) => String(c.text).includes('OLD_HISTORY_MSG')), false, 'silent backfill must not replay old messages');
    const bound = rt.channel.bindingsForRestore()[0];
    assert.ok(bound && bound.accessMode === 'read_only');
    const history = await rt.core.readHistory(bound.sessionId, { limit: 10 });
    assert.equal(history.items.length, 1);
    assert.equal((history.items[0]!.blocks[0] as any).text, 'OLD_HISTORY_MSG');

    // Inside cooldown (+10s): neither discoverNewer (30s) nor discoverExisting (90s) fires again!
    now += 10_000;
    await rt.tick();
    assert.equal(newerCalls, 1);
    assert.equal(oldCalls, 1);

    // After 31s total: discoverNewer fires, discoverExisting still in 90s cooldown!
    now += 21_000;
    await rt.tick();
    assert.equal(newerCalls, 2);
    assert.equal(oldCalls, 1);

    // After 91s total: discoverExisting fires again; future message on backfilled topic delivers once!
    extraMsg = true;
    now += 60_000;
    await rt.tick();
    await rt.tick();
    assert.equal(oldCalls, 2);
    assert.equal(topicCreates, 1);
    assert.equal(sentCards.filter((c) => String(c.text).includes('FUTURE_INCREMENT_MSG')).length, 1);
  } finally {
    await rt.close();
    Date.now = originalNow;
    rmSync(dir, { recursive: true, force: true });
  }
});
