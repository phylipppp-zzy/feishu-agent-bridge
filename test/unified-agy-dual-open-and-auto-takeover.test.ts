import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyAdapter } from '../src/unified/agy-adapter.js';
import type { AgyCatalog } from '../src/unified/agy-catalog.js';
import type { AgyAcpTransport } from '../src/unified/agy-transport.js';
import type { Capabilities, Operation, Session, SessionSnapshot } from '../src/unified/contracts.js';
import type { UnifiedService } from '../src/unified/adapter.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';
import { topicRootCard } from '../src/unified/topic-title-sync.js';

function makeMockAgyTransport() {
  const closedSessions: string[] = [];
  const transport = {
    connected: true,
    connectionGeneration: 1,
    defaultMode: 'auto',
    onNotification: () => {},
    onServerRequest: () => {},
    onDisconnect: () => {},
    async request(method: string, params?: Record<string, unknown>) {
      if (method === 'session/new') return { sessionId: 'sess-agy-guard', modes: { currentModeId: 'auto' } };
      if (method === 'session/load') return { sessionId: params?.sessionId ?? 'sess-agy-guard', modes: { currentModeId: 'auto' } };
      if (method === 'session/close') {
        closedSessions.push(String(params?.sessionId ?? ''));
        return {};
      }
      if (method === 'session/prompt') return new Promise(() => {});
      return {};
    },
    notify() {},
    async respondServerRequest() {},
    respondServerError() {},
    async close() {},
  };
  return { transport, closedSessions };
}

function makeMockCatalog(): AgyCatalog {
  return {
    brainDir: '/tmp/fake-brain',
    get: (id: string) => ({
      sessionId: id,
      project: '/tmp',
      title: 'Test AGY Session',
      updatedAt: new Date().toISOString(),
    }),
    refreshAsync: async () => {},
    readTranscript: async () => ({ messages: [] }),
  } as unknown as AgyCatalog;
}

test('AgyAdapter rejects resume when external local terminal agy holds the session db', async () => {
  const { transport } = makeMockAgyTransport();
  const adapter = new AgyAdapter(
    transport as unknown as AgyAcpTransport,
    makeMockCatalog(),
    'host',
    'agy-svc',
    undefined,
    {
      idleReleaseMs: 0,
      externalHolderDetector: () => ({ pid: 1103245, tty: '/dev/pts/2', cmdline: 'agy' }),
    },
  );
  try {
    await assert.rejects(
      adapter.resume({ provider: 'agy', hostId: 'host', serviceId: 'agy-svc', nativeSessionId: 'sess-dual' }),
      (err: unknown) => {
        const detail = err as { code?: string; message?: string };
        assert.equal(detail?.code, 'control_conflict');
        assert.match(detail?.message ?? '', /PID 1103245，\/dev\/pts\/2/);
        assert.match(detail?.message ?? '', /等待当前任务完成并退出终端/);
        return true;
      },
    );
  } finally {
    await adapter.close();
  }
});

test('AgyAdapter.reconcileIdleAndExternalHolders releases idle or externally-held sessions but never active turns', async () => {
  const { transport, closedSessions } = makeMockAgyTransport();
  let externalHeld = false;
  const adapter = new AgyAdapter(
    transport as unknown as AgyAcpTransport,
    makeMockCatalog(),
    'host',
    'agy-svc',
    undefined,
    {
      idleReleaseMs: 60_000,
      externalHolderDetector: () => (externalHeld ? { pid: 2586014, tty: '/dev/pts/14', cmdline: 'agy' } : null),
    },
  );
  try {
    const created = await adapter.create('/tmp', null);
    const ref = created.createdSession!.native;
    assert.equal(adapter.hasActiveNativeSession(ref), true);

    // Not idle yet and no external holder -> stays active
    assert.deepEqual(await adapter.reconcileIdleAndExternalHolders(Date.now() + 5_000), []);
    assert.equal(adapter.hasActiveNativeSession(ref), true);

    // External terminal /resume appears while idle -> auto-releases
    externalHeld = true;
    assert.deepEqual(await adapter.reconcileIdleAndExternalHolders(Date.now() + 6_000), ['sess-agy-guard']);
    assert.equal(adapter.hasActiveNativeSession(ref), false);
    assert.deepEqual(closedSessions, ['sess-agy-guard']);

    // Re-attach once external holder exits, then verify idle timeout release
    externalHeld = false;
    await adapter.resume(ref);
    assert.equal(adapter.hasActiveNativeSession(ref), true);
    assert.deepEqual(await adapter.reconcileIdleAndExternalHolders(Date.now() + 120_000), ['sess-agy-guard']);
    assert.equal(adapter.hasActiveNativeSession(ref), false);
  } finally {
    await adapter.close();
  }
});

test('FeishuChannel auto-upgrades read_only topic on input and shows compact text warning on dual-open conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-takeover-'));
  try {
    const available = { status: 'available' as const };
    const unsupported = { status: 'unsupported' as const, reason: 'read only' };
    const makeSession = (interactive: boolean): Session => ({
      sessionId: 'sess-1',
      native: { provider: 'agy', hostId: 'h', serviceId: 'agy-svc', nativeSessionId: 'conv-1' },
      project: '/home/zhangzy',
      title: 'AGY Task',
      status: interactive ? 'idle' : 'read_only',
      revision: interactive ? 2 : 1,
      capabilities: interactive
        ? { view: available, send: available, queue: available, steer: available, answer: available, approve: available, interrupt: available, handoff: available, files: available, config: available }
        : { view: available, send: unsupported, queue: unsupported, steer: unsupported, answer: unsupported, approve: unsupported, interrupt: unsupported, handoff: unsupported, files: available, config: unsupported },
      control: {
        serviceId: 'agy-svc',
        owner: interactive ? 'agy-svc' : null,
        input: interactive ? 'available' : 'unavailable',
        generation: interactive ? 2 : 1,
        operationId: null,
        reason: null,
      },
    });

    let interactive = false;
    let blockExternal = false;
    const submittedTexts: string[] = [];
    const sentTexts: string[] = [];
    const sentCards: string[] = [];

    const service = {
      getSession: async () => makeSession(interactive),
      getSnapshot: async (): Promise<{ value: SessionSnapshot; cursor: string }> => ({
        value: { session: makeSession(interactive), messages: [], turns: [], interactions: [] },
        cursor: Buffer.from(JSON.stringify(['sess-1', 1])).toString('base64url'),
      }),
      subscribeEvents: async () => ({ status: 'events' as const, events: [], cursor: Buffer.from(JSON.stringify(['sess-1', 1])).toString('base64url') }),
      getWorkState: async () => ({ queued: [], activeTurn: null }),
      attachSession: async ({ context }: { context: { operationId: string } }): Promise<Operation> => {
        if (blockExternal) {
          const err = new Error('conflict') as Error & { detail?: { code: string; message: string } };
          err.detail = { code: 'control_conflict', message: '本地终端 agy（PID 1103245，/dev/pts/2）正打开此会话，请等待当前任务完成并退出终端，或停止该终端进程后再在飞书继续。' };
          throw err;
        }
        interactive = true;
        return {
          operationId: context.operationId,
          idempotencyKey: context.operationId,
          action: 'attachSession',
          targetId: 'new:topic:1',
          payloadDigest: 'd1',
          status: 'completed',
          revision: 1,
          result: { kind: 'session', sessionId: 'sess-1' },
          error: null,
        };
      },
      submitInput: async ({ context, blocks }: { context: { operationId: string }; blocks: Array<{ type: string; text?: string }> }): Promise<Operation> => {
        submittedTexts.push(blocks.map(b => b.text ?? '').join(''));
        return {
          operationId: context.operationId,
          idempotencyKey: context.operationId,
          action: 'submitInput',
          targetId: 'sess-1',
          payloadDigest: 'd2',
          status: 'completed',
          revision: 1,
          result: { kind: 'turn', turnId: 'turn-auto-1', status: 'completed' },
          error: null,
        };
      },
    } as unknown as UnifiedService;

    const port: FeishuPort = {
      isTopicDestination: () => true,
      send: async (_dest, card) => {
        sentCards.push(card.title);
        return `card-${sentCards.length}`;
      },
      sendText: async (_dest, text) => {
        sentTexts.push(text);
        return `text-${sentTexts.length}`;
      },
      update: async () => {},
      sendFile: async () => {},
    };

    const channel = new FeishuChannel(service, port, async () => true, join(dir, 'channel.sqlite'), undefined, false, {
      autoTakeControlOnInput: true,
    });
    try {
      channel.importMigrationBinding('mig-1', {
        destination: 'topic:1',
        sessionId: 'sess-1',
        bindingId: 'bind-1',
        owner: { source: 'feishu', subject: 'owner' },
      });

      // 1. External terminal holder blocks takeover with compact text notice (not a big card)
      blockExternal = true;
      const blocked = await channel.handle(
        { eventId: 'ev-blocked', destination: 'topic:1', identity: { source: 'feishu', subject: 'owner' } },
        { action: 'input', text: '帮我继续跑实验', mode: 'new' },
      ) as { status?: string; reason?: string };
      assert.equal(blocked.status, 'rejected');
      assert.equal(sentTexts.length, 1);
      assert.match(sentTexts[0]!, /^⚠️ 本地终端 agy（PID 1103245，\/dev\/pts\/2）/);
      assert.equal(submittedTexts.length, 0);
      assert.equal(channel.accessMode('topic:1'), 'read_only');

      // 2. Once external terminal exits, sending a message auto-upgrades and immediately submits input
      blockExternal = false;
      await channel.handle(
        { eventId: 'ev-auto', destination: 'topic:1', identity: { source: 'feishu', subject: 'owner' } },
        { action: 'input', text: '帮我继续跑实验', mode: 'new' },
      );
      assert.equal(channel.accessMode('topic:1'), 'interactive');
      assert.deepEqual(submittedTexts, ['帮我继续跑实验']);
    } finally {
      channel.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topicRootCard displays blue working indicator for externally active read_only sessions', () => {
  const session: Session = {
    sessionId: 'sess-ro',
    native: { provider: 'agy', hostId: 'h', serviceId: 'agy-svc', nativeSessionId: 'conv-ro' },
    project: '/home/zhangzy',
    title: '实验排查',
    status: 'read_only',
    revision: 1,
    capabilities: {
      view: { status: 'available' },
      send: { status: 'unsupported', reason: 'ro' },
      queue: { status: 'unsupported', reason: 'ro' },
      steer: { status: 'unsupported', reason: 'ro' },
      answer: { status: 'unsupported', reason: 'ro' },
      approve: { status: 'unsupported', reason: 'ro' },
      interrupt: { status: 'unsupported', reason: 'ro' },
      handoff: { status: 'unsupported', reason: 'ro' },
      files: { status: 'available' },
      config: { status: 'unsupported', reason: 'ro' },
    },
    control: { serviceId: 'agy-svc', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: null },
  };
  const idleCard = topicRootCard(session);
  assert.match(idleCard.title, /^⚪ /);
  const workingCard = topicRootCard(session, null, { externallyWorking: true });
  assert.match(workingCard.title, /^🔵 /);
  assert.equal(workingCard.template, 'blue');
  assert.match(workingCard.text, /终端运行中/);
});
