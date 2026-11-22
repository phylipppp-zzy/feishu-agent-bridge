import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { StoreError } from '../src/unified/store.js';
import {
  WATCH_SOURCES,
  WatchHub,
  type WatchEvent,
  type WatchHubPort,
} from '../src/unified/watch-hub.js';

const hasCode = (expected: string) => (err: unknown) =>
  err instanceof StoreError && err.detail.code === expected;

function createFakeWatchPort() {
  let topicCalls = 0;
  let nextMsg = 0;
  const sends: Array<{ destination: string; card: ChannelCard; deliveryId: string; messageId: string }> = [];
  const updates: Array<{ destination: string; messageId: string; card: ChannelCard; deliveryId: string }> = [];
  const deliveries = new Map<string, { state: 'sent' | 'not_sent' | 'unknown'; messageId: string | null; topicDest?: string }>();

  let failTopicCreate: 'none' | 'throw' | 'empty' = 'none';
  let failNextSend = false;

  const port: WatchHubPort = {
    createTopic: async (destination, _sessionId, _card, deliveryId, guard) => {
      topicCalls++;
      await guard?.();
      if (failTopicCreate === 'throw') {
        throw new Error('simulated timeout after createTopic');
      }
      if (failTopicCreate === 'empty') {
        return '';
      }
      const topicDest = `topic:watch-root-${topicCalls}`;
      const rootMsgId = `msg-root-${topicCalls}`;
      deliveries.set(deliveryId, { state: 'sent', messageId: rootMsgId, topicDest });
      return topicDest;
    },
    send: async (destination, card, deliveryId, guard) => {
      await guard?.();
      if (failNextSend) {
        failNextSend = false;
        throw new Error('simulated send network timeout');
      }
      const messageId = `msg-${++nextMsg}`;
      sends.push({ destination, card, deliveryId, messageId });
      deliveries.set(deliveryId, { state: 'sent', messageId });
      return messageId;
    },
    update: async (destination, messageId, card, deliveryId, guard) => {
      await guard?.();
      updates.push({ destination, messageId, card, deliveryId });
      deliveries.set(deliveryId, { state: 'sent', messageId });
    },
    lookupDelivery: async (deliveryId) => deliveries.get(deliveryId)?.state ?? 'unknown',
    lookupMessageId: async (deliveryId) => deliveries.get(deliveryId)?.messageId ?? null,
    lookupTopicDestination: async (deliveryId) => deliveries.get(deliveryId)?.topicDest ?? null,
    topicLinkForSession: async (_dest, sessionId) =>
      `https://applink.feishu.cn/client/thread/open?openchatid=chat-1&openthreadid=th-${sessionId}&thread_position=1`,
  };

  return {
    port,
    sends,
    updates,
    deliveries,
    get topicCalls() {
      return topicCalls;
    },
    setFailTopicCreate(mode: 'none' | 'throw' | 'empty') {
      failTopicCreate = mode;
    },
    setFailNextSend(v: boolean) {
      failNextSend = v;
    },
  };
}

const owner = { source: 'feishu', subject: 'owner-1' };

test('all 6 authorized watch sources route to the single fixed watch root topic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-hub-6src-'));
  const dbPath = join(dir, 'watch.sqlite');
  const fake = createFakeWatchPort();
  const hub = new WatchHub({
    dbPath,
    owner,
    destination: 'chat-main',
    allowedDestinations: new Set(['chat-main']),
    port: fake.port,
  });

  try {
    for (let i = 0; i < WATCH_SOURCES.length; i++) {
      const source = WATCH_SOURCES[i]!;
      const event: WatchEvent = {
        eventId: `evt-${source}-${i}`,
        source,
        objectId: `obj-${source}`,
        state: source === 'claude_stop_failure' ? 'failed' : source === 'claude_waiting' ? 'waiting' : 'alert',
        occurredAt: new Date(1_800_000_000_000 + i * 1000).toISOString(),
        severity: 'normal',
        title: `事件-${source}`,
        summary: `来自 ${source} 的状态提醒`,
        sourceRef: { sessionId: `sess-${i}`, taskId: `task-${i}`, destination: `topic:task-${i}` },
      };
      const res = await hub.publish(event);
      assert.equal(res.ingest.status, 'accepted');
      assert.equal(res.deliveries.length, 1);
      assert.equal(res.deliveries[0]!.status, 'sent');
    }

    assert.equal(fake.topicCalls, 1);
    assert.equal(fake.sends.length, 6);
    const destinations = new Set(fake.sends.map((s) => s.destination));
    assert.deepEqual([...destinations], ['topic:watch-root-1']);
    for (const sent of fake.sends) {
      assert.ok(sent.card.actions.some((a) => a.label === '返回任务话题' && a.url?.startsWith('https://applink.feishu.cn/')));
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.ok(tables.includes('watch_hub_roots_v1'));
    assert.ok(tables.includes('watch_hub_events_v1'));
    assert.ok(tables.includes('watch_hub_outbox_v1'));
    db.close();
  } finally {
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same eventId is idempotent and payload conflict rejects cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-hub-idem-'));
  const dbPath = join(dir, 'watch.sqlite');
  const fake = createFakeWatchPort();
  const hub = new WatchHub({
    dbPath,
    owner,
    destination: 'chat-main',
    port: fake.port,
  });

  const event: WatchEvent = {
    eventId: 'evt-same-1',
    source: 'watch',
    objectId: 'gpu-worker-1',
    state: 'alert',
    occurredAt: '2026-11-22T01:00:00Z',
    severity: 'high',
    title: 'GPU 利用率骤降',
    summary: 'GPU 0 利用率连续 5 分钟为 0%',
  };

  try {
    const first = await hub.publish(event);
    assert.equal(first.ingest.status, 'accepted');
    assert.equal(first.deliveries.length, 1);
    assert.equal(fake.sends.length, 1);

    const second = await hub.publish(event);
    assert.equal(second.ingest.status, 'duplicate');
    assert.equal(second.deliveries.length, 0);
    assert.equal(fake.sends.length, 1);

    await assert.rejects(
      hub.ingest({ ...event, summary: '被篡改的摘要' }),
      hasCode('idempotency_conflict'),
    );
  } finally {
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same objectId abnormal -> recovery updates original card and preserves historical unknown facts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-hub-recover-'));
  const dbPath = join(dir, 'watch.sqlite');
  const fake = createFakeWatchPort();
  const hub = new WatchHub({
    dbPath,
    owner,
    destination: 'chat-main',
    port: fake.port,
  });

  try {
    // 1. Abnormal event -> sent to root topic as msg-1
    await hub.publish({
      eventId: 'evt-abn-1',
      source: 'stopwatch',
      objectId: 'train-job-9',
      state: 'failed',
      occurredAt: '2026-11-22T02:00:00Z',
      severity: 'high',
      title: '停训看守异常',
      summary: '训练进程退出码 137',
    });
    assert.equal(fake.sends.length, 1);
    assert.equal(fake.updates.length, 0);

    // 2. Intermediate update hits send/update timeout -> becomes unknown in outbox history
    fake.updates.length = 0;
    const origUpdate = fake.port.update;
    fake.port.update = async () => {
      throw new Error('update timeout -> unknown');
    };
    const mid = await hub.publish({
      eventId: 'evt-abn-2',
      source: 'stopwatch',
      objectId: 'train-job-9',
      state: 'alert',
      occurredAt: '2026-11-22T02:01:00Z',
      severity: 'normal',
      title: '仍在检查进程',
      summary: '等待重启确认',
    });
    assert.equal(mid.deliveries[0]!.status, 'unknown');
    fake.port.update = origUpdate;

    // 3. Recovery arrives for same objectId -> updates original card msg-1 AND does not hide historical unknown!
    const rec = await hub.publish({
      eventId: 'evt-rec-3',
      source: 'stopwatch',
      objectId: 'train-job-9',
      state: 'recovered',
      occurredAt: '2026-11-22T02:05:00Z',
      severity: 'normal',
      title: '训练任务恢复正常',
      summary: '已自动恢复至 checkpoint-400',
    });
    assert.equal(rec.deliveries.length, 1);
    assert.equal(rec.deliveries[0]!.action, 'update');
    assert.equal(rec.deliveries[0]!.status, 'sent');
    assert.equal(rec.deliveries[0]!.hadUnknown, true);

    assert.equal(fake.sends.length, 1); // Never created a second card
    assert.equal(fake.updates.length, 1);
    assert.equal(fake.updates[0]!.messageId, 'msg-1');
    assert.match(fake.updates[0]!.card.title, /已恢复/);
    assert.match(fake.updates[0]!.card.text, /unknown/);

    // 4. Out-of-order older event does NOT regress the recovered card
    const stale = await hub.publish({
      eventId: 'evt-old-0',
      source: 'stopwatch',
      objectId: 'train-job-9',
      state: 'failed',
      occurredAt: '2026-11-22T01:59:00Z',
      severity: 'high',
      title: '迟到旧失败',
      summary: '旧事件',
    });
    assert.equal(stale.ingest.status, 'stale_ignored');
    assert.equal(fake.updates.length, 1);
  } finally {
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown root creation never creates a second root across restarts and reconciles safely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-hub-root-unk-'));
  const dbPath = join(dir, 'watch.sqlite');
  const fake = createFakeWatchPort();
  fake.setFailTopicCreate('throw');

  let hub = new WatchHub({
    dbPath,
    owner,
    destination: 'chat-main',
    port: fake.port,
  });

  try {
    // First event queued, root creation fails -> root becomes 'unknown'
    await hub.ingest({
      eventId: 'evt-before-unk',
      source: 'codex_status',
      objectId: 'codex-1',
      state: 'waiting',
      occurredAt: '2026-11-22T03:00:00Z',
      severity: 'normal',
      title: 'Codex 等待输入',
      summary: '等待确认命令',
    });
    await assert.rejects(hub.flush(), hasCode('outcome_unknown'));
    assert.equal(fake.topicCalls, 1);
    assert.equal(fake.sends.length, 0);
    assert.equal(hub.getRoot()?.state, 'unknown');

    // Reopen WatchHub after restart and retry -> must NOT create a second root!
    hub.close();
    fake.setFailTopicCreate('none');
    hub = new WatchHub({
      dbPath,
      owner,
      destination: 'chat-main',
      port: fake.port,
    });
    await assert.rejects(hub.ensureRoot(), hasCode('outcome_unknown'));
    assert.equal(fake.topicCalls, 1); // Still only 1 createTopic call ever!

    // Simulate platform delivery ledger confirming original root creation actually succeeded on server
    const root = hub.getRoot()!;
    fake.deliveries.set(root.creationDeliveryId, {
      state: 'sent',
      messageId: 'msg-root-1',
      topicDest: 'topic:watch-root-recovered',
    });
    const reconciled = await hub.reconcileRoot();
    assert.equal(reconciled?.state, 'active');
    assert.equal(reconciled?.topicDestination, 'topic:watch-root-recovered');
    assert.equal(reconciled?.hadUnknownHistory, true);
    assert.equal(fake.topicCalls, 1); // Never created a second root!

    // Pending event now flushes to the single recovered root, preserving historical unknown notice
    const delivered = await hub.flush();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.status, 'sent');
    assert.equal(delivered[0]!.hadUnknown, true);
    assert.equal(fake.sends.length, 1);
    assert.equal(fake.sends[0]!.destination, 'topic:watch-root-recovered');
    assert.match(fake.sends[0]!.card.text, /unknown/);
  } finally {
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('low-severity repeat events coalesce without spamming topic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-hub-coalesce-'));
  const dbPath = join(dir, 'watch.sqlite');
  const fake = createFakeWatchPort();
  const hub = new WatchHub({
    dbPath,
    owner,
    destination: 'chat-main',
    port: fake.port,
    coalesceWindowMs: 120_000,
  });

  try {
    // Burst of 3 low-severity events before flush
    const r1 = await hub.ingest({
      eventId: 'low-1',
      source: 'agy_status',
      objectId: 'agy-node-1',
      state: 'info',
      occurredAt: '2026-11-22T04:00:00Z',
      severity: 'low',
      title: 'Agy 进度心跳',
      summary: '第 1 次心跳',
    });
    const r2 = await hub.ingest({
      eventId: 'low-2',
      source: 'agy_status',
      objectId: 'agy-node-1',
      state: 'info',
      occurredAt: '2026-11-22T04:00:20Z',
      severity: 'low',
      title: 'Agy 进度心跳',
      summary: '第 2 次心跳',
    });
    assert.equal(r1.status, 'accepted');
    assert.equal(r2.status, 'coalesced');

    await hub.flush();
    assert.equal(fake.sends.length, 1);
    assert.match(fake.sends[0]!.card.text, /共 2 条事件（低优先级重复合并 1 次）/);

    // Subsequent low-severity repeat within coalesce window does NOT send a new card
    const r3 = await hub.publish({
      eventId: 'low-3',
      source: 'agy_status',
      objectId: 'agy-node-1',
      state: 'info',
      occurredAt: '2026-11-22T04:00:45Z',
      severity: 'low',
      title: 'Agy 进度心跳',
      summary: '第 3 次心跳',
    });
    assert.equal(r3.ingest.status, 'coalesced');
    assert.equal(r3.deliveries.length, 0);
    assert.equal(fake.sends.length, 1);
    assert.equal(fake.updates.length, 0);
  } finally {
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unauthorized source (including weekly_report), wrong owner, and unauthorized destination are rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-hub-auth-'));
  const dbPath = join(dir, 'watch.sqlite');
  const fake = createFakeWatchPort();
  const hub = new WatchHub({
    dbPath,
    owner,
    destination: 'chat-main',
    allowedDestinations: new Set(['chat-main']),
    allowedSourceDestinations: new Set(['topic:authorized-task']),
    port: fake.port,
  });

  try {
    // 1. Ordinary weekly report / arbitrary source rejected -> complete isolation
    for (const badSource of ['weekly_report', 'ordinary_notice', 'legacy_cron']) {
      await assert.rejects(
        hub.publish({
          eventId: `bad-${badSource}`,
          source: badSource as unknown as WatchEvent['source'],
          objectId: 'report-1',
          state: 'info',
          occurredAt: '2026-11-22T05:00:00Z',
          severity: 'normal',
          title: '周报汇总',
          summary: '本周科研进展周报',
        }),
        hasCode('unauthorized'),
      );
    }

    // 2. Unauthorized destination
    await assert.rejects(
      hub.publish(
        {
          eventId: 'bad-dest-1',
          source: 'watch',
          objectId: 'obj-1',
          state: 'alert',
          occurredAt: '2026-11-22T05:01:00Z',
          severity: 'normal',
          title: '告警',
          summary: '测试',
        },
        { destination: 'chat-weekly-report' },
      ),
      hasCode('unauthorized'),
    );

    // 3. Unauthorized sourceRef destination
    await assert.rejects(
      hub.publish({
        eventId: 'bad-srcref-1',
        source: 'claude_waiting',
        objectId: 'obj-2',
        state: 'waiting',
        occurredAt: '2026-11-22T05:02:00Z',
        severity: 'normal',
        title: '等待',
        summary: '测试',
        sourceRef: { sessionId: 's1', destination: 'topic:rogue-chat' },
      }),
      hasCode('unauthorized'),
    );

    // 4. Wrong owner
    await assert.rejects(
      hub.publish(
        {
          eventId: 'bad-owner-1',
          source: 'watch',
          objectId: 'obj-3',
          state: 'alert',
          occurredAt: '2026-11-22T05:03:00Z',
          severity: 'normal',
          title: '告警',
          summary: '测试',
        },
        { owner: { source: 'feishu', subject: 'attacker' } },
      ),
      hasCode('unauthorized'),
    );

    assert.equal(fake.topicCalls, 0);
    assert.equal(fake.sends.length, 0);
    assert.equal(hub.listOutbox().length, 0);
  } finally {
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
