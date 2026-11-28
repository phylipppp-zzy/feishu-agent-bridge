import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { UnifiedService } from '../src/unified/adapter.js';
import type { Message, Session, Turn } from '../src/unified/contracts.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { FeishuApiRejected, FeishuSdkPort } from '../src/unified/feishu-sdk-port.js';
import { setCustomTopicTitle, syncTopicRootTitle } from '../src/unified/topic-title-sync.js';
import { TurnCardDelivery } from '../src/unified/turn-card-delivery.js';

test('running card heartbeats skip elapsed-only writes and preserve the exact final duration', async t => {
  const start = Date.parse('2026-11-27T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE channel_delivery_diagnostics (delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL, platform_code INTEGER);
  `);
  const patches: ChannelCard[] = [];
  let wakes = 0;
  const delivery = new TurnCardDelivery(db, {} as UnifiedService, {
    async send() { return 'card'; },
    async update(_destination, _id, card) { patches.push(card); },
    async sendFile() {},
  }, {
    async guard() {},
    stamp: (_destination, card) => card,
    wake: () => { wakes++; },
  });
  t.after(() => { delivery.close(); db.close(); });
  const turn: Turn = { turnId: 't', sessionId: 's', status: 'running', inputId: null, model: null,
    startedAt: new Date(start).toISOString(), endedAt: null, outputIds: [] };
  const message: Message = { messageId: 'm', sessionId: 's', turnId: 't', role: 'assistant',
    blocks: [{ type: 'text', text: 'draft' }], sequence: 1, revision: 1, final: false, source: 'codex' };
  const input: Parameters<TurnCardDelivery['renderStreamMessage']>[0] = {
    key: ['chat', 's', 'scope', 't'], turn, message, tools: [], provider: 'codex', sessionConnected: true,
  };
  await delivery.renderStreamMessage(input);
  for (let i = 1; i <= 3; i++) {
    t.mock.timers.tick(60_000);
    assert.equal(wakes, i);
    await delivery.renderStreamMessage(input);
  }
  assert.equal(patches.length, 0);

  input.tools = [{ turnId: 't', callId: 'tool', phase: 'running', tool: 'Bash', summary: 'Bash · tests' }];
  await delivery.renderStreamMessage(input);
  assert.match(patches[0]!.executionLog!.runningNote!, /Bash/);
  input.message = { ...message, blocks: [{ type: 'text', text: 'updated' }], revision: 2 };
  t.mock.timers.tick(2499);
  await delivery.renderStreamMessage(input);
  assert.equal(patches.length, 1);
  t.mock.timers.tick(1);
  await delivery.renderStreamMessage(input);
  assert.equal(patches[1]!.text, 'updated');

  t.mock.timers.tick(4000);
  await delivery.finalizeTurnCard({
    ...input, turn: { ...turn, status: 'completed', endedAt: new Date(start + 183_000).toISOString() },
  });
  assert.equal(patches.length, 3);
  assert.match(patches[2]!.title, /已完成 · 用时 3分03秒/);
  const priorWakes = wakes;
  t.mock.timers.tick(60_000);
  assert.equal(wakes, priorWakes);
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('legacy topic title skips upstream drift and follows status, rename and rename removal', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE channel_bindings (destination TEXT PRIMARY KEY, session_id TEXT, binding_id TEXT, revision INTEGER, access_mode TEXT);
    CREATE TABLE channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE channel_topic_titles (
      destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, root_message_id TEXT NOT NULL,
      synced_title TEXT NOT NULL, retry_after INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(destination,session_id,binding_scope));
    CREATE TABLE channel_topic_custom_titles (
      destination TEXT NOT NULL, session_id TEXT NOT NULL, custom_title TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(destination,session_id));
    INSERT INTO channel_bindings VALUES ('topic','s','b',1,'interactive');
  `);
  const scope = JSON.stringify(db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings').get());
  db.prepare("INSERT INTO channel_topic_titles VALUES ('topic','s',?,'root','🟢 original',0)").run(scope);
  const titles: string[] = [];
  const port = {
    isTopicDestination: () => true, rootMessageId: () => 'root',
    async send() { return 'root'; }, async sendFile() {},
    async update(_destination: string, _id: string, card: ChannelCard) { titles.push(card.title); },
  };
  const session = { sessionId: 's', project: '/work', native: { provider: 'codex' } } as Session;
  const sync = (status: Session['status'], title: string, externallyWorking?: boolean) =>
    syncTopicRootTitle(db, port, 'topic', scope, { ...session, status, title }, card => card, async () => {},
      { ...(externallyWorking === undefined ? {} : { externallyWorking }) });
  await sync('idle', 'upstream drift');
  assert.deepEqual(titles, []);
  await sync('running', 'upstream drift');
  await sync('running', 'upstream drift · agents 2');
  await sync('idle', 'new upstream title');
  setCustomTopicTitle(db, 'topic', 's', 'manual rename');
  await sync('idle', 'another upstream title');
  await sync('idle', 'ignored upstream title');
  db.exec('DELETE FROM channel_topic_custom_titles');
  await sync('idle', 'restored upstream title');
  await sync('read_only', 'restored upstream title', true);
  await sync('read_only', 'restored upstream title', false);
  assert.deepEqual(titles, ['🔵 upstream drift', '🟢 new upstream title', '🟢 manual rename',
    '🟢 restored upstream title', '🔵 restored upstream title', '⚪ restored upstream title']);
  assert.deepEqual({ ...db.prepare('SELECT synced_status,synced_custom_title FROM channel_topic_titles').get() },
    { synced_status: 'read_only', synced_custom_title: '' });
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const card = (title: string): ChannelCard => ({ title, text: title, actions: [] });

function sdkFixture(t: TestContext, alertInterval = '60000') {
  const env = { ...process.env };
  process.env.FEISHU_ALERT_QUEUE_INTERVAL_MS = alertInterval;
  process.env.FEISHU_ALERT_429_COOLDOWN_MS = '60000';
  const destinations = new Set(['chat']);
  const sdk = new FeishuSdkPort({ appId: 'test', appSecret: 'test' }, ':memory:', destinations, 'owner',
    false, false, new Set(['usage']));
  t.after(() => sdk.close());
  for (const key of ['FEISHU_ALERT_QUEUE_INTERVAL_MS', 'FEISHU_ALERT_429_COOLDOWN_MS']) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const { im: { message } } = (sdk as unknown as { client: { im: { message: {
    create: (request: { data: { content: string } }) => Promise<{ code: number; data?: { message_id: string } }>;
    patch: (request: { data: { content: string }; path: { message_id: string } }) => Promise<{ code: number }>;
  } } } }).client;
  return { sdk, message, destinations };
}

test('alert 230429 cooldown leaves terminal and interactive usage PATCHes ready', { timeout: 3000 }, async t => {
  const { sdk, message } = sdkFixture(t, '0');
  const calls: string[] = [];
  let id = 0;
  message.create = async ({ data }) => {
    const title = JSON.parse(data.content).header.title.content as string;
    calls.push(title);
    return title === 'rate limited' ? { code: 230429 } : { code: 0, data: { message_id: String(++id) } };
  };
  message.patch = async ({ data }) => {
    calls.push(JSON.parse(data.content).header.title.content);
    return { code: 0 };
  };
  const turn = await sdk.send('chat', card('turn'), 'stream:t');
  const usage = await sdk.send('usage', card('dashboard'), 'usage-msg:init');
  await assert.rejects(sdk.send('chat', card('rate limited'), 'watch:429'),
    (error: unknown) => error instanceof FeishuApiRejected && error.platformCode === 230429);
  const alerts = [
    sdk.send('usage', card('cooldown'), 'usage-auto:later'),
    sdk.send('chat', card('queued'), 'watch-later'),
  ];
  const drained = Promise.allSettled(alerts);
  await sdk.update('chat', turn, card('completed'), 'turn-final:t');
  await sdk.update('usage', usage, card('interactive'), 'usage-card:refresh');
  await nextTurn();
  sdk.close();
  const settled = await drained;
  assert.deepEqual(calls, ['turn', 'dashboard', 'rate limited', 'completed', 'interactive']);
  for (const result of settled) {
    assert.equal(result.status, 'rejected');
    assert.match(String(result.reason), /SDK port closing/);
  }
});

test('same-message PATCHes serialize and their guards run again after the lock wait', { timeout: 3000 }, async t => {
  const { sdk, message } = sdkFixture(t, '0');
  message.create = async () => ({ code: 0, data: { message_id: 'm' } });
  const id = await sdk.send('chat', card('initial'), 'stream:t');
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const patches: string[] = [];
  message.patch = async ({ data }) => {
    const title = JSON.parse(data.content).header.title.content as string;
    patches.push(title);
    if (title === 'old') {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    return { code: 0 };
  };
  const old = sdk.update('chat', id, card('old'), 'turn-update:t');
  await firstStarted.promise;
  let allowed = true;
  const revoked = sdk.update('chat', id, card('revoked'), 'turn-update:revoked', async () => {
    if (!allowed) throw new Error('binding revoked');
  });
  const rejected = assert.rejects(revoked, /binding revoked/);
  const newest = sdk.update('chat', id, card('newest'), 'turn-final:t');
  await nextTurn();
  allowed = false;
  releaseFirst.resolve();
  await Promise.all([old, newest, rejected]);
  assert.deepEqual(patches, ['old', 'newest']);
});

test('stopReceiving aborts paced delivery and late SDK receipts cannot access the closed DB', { timeout: 3000 }, async t => {
  const { sdk, message } = sdkFixture(t);
  const release = deferred<{ code: number; data: { message_id: string } }>();
  const started = deferred<void>();
  const calls: string[] = [];
  message.create = async ({ data }) => {
    const title = JSON.parse(data.content).header.title.content as string;
    calls.push(title);
    if (title === 'in flight') { started.resolve(); return release.promise; }
    return { code: 0, data: { message_id: title } };
  };
  await sdk.send('chat', card('first'), 'watch-first');
  const paced = sdk.send('chat', card('paced'), 'watch:second');
  const pacedRejection = assert.rejects(paced, /SDK port closing/);
  const inFlight = sdk.send('chat', card('in flight'), 'usage-msg:user');
  const receiptRejection = assert.rejects(inFlight, /SDK port closing/);
  await started.promise;
  await nextTurn();
  sdk.stopReceiving();
  await pacedRejection;
  sdk.close();
  release.resolve({ code: 0, data: { message_id: 'late' } });
  await receiptRejection;
  await assert.rejects(sdk.update('chat', 'first', card('closed'), 'watch:closed'), /SDK port closing/);
  assert.deepEqual(calls, ['first', 'in flight']);
});

test('a terminal PATCH can supersede an older alert waiting on the same message', { timeout: 3000 }, async t => {
  const { sdk, message } = sdkFixture(t, '0');
  const started = deferred<void>();
  const release = deferred<void>();
  message.create = async ({ data }) => {
    const title = JSON.parse(data.content).header.title.content as string;
    if (title === 'blocking alert') {
      started.resolve();
      await release.promise;
    }
    return { code: 0, data: { message_id: title } };
  };
  const patches: string[] = [];
  message.patch = async ({ data }) => {
    patches.push(JSON.parse(data.content).header.title.content);
    return { code: 0 };
  };
  const id = await sdk.send('chat', card('message'), 'stream:t');
  const blocking = sdk.send('chat', card('blocking alert'), 'watch:blocking');
  await started.promise;
  const superseded = assert.rejects(sdk.update('chat', id, card('old alert'), 'watch:old'),
    /superseded by user update/);
  await sdk.update('chat', id, card('completed'), 'turn-final:t');
  assert.deepEqual(patches, ['completed']);

  const later = sdk.update('chat', id, card('later alert'), 'watch:later');
  await assert.rejects(sdk.update('chat', id, card('denied user'), 'interaction:denied', async () => {
    throw new Error('binding revoked');
  }), /binding revoked/);
  release.resolve();
  await Promise.all([blocking, superseded, later]);
  assert.deepEqual(patches, ['completed', 'later alert']);
});

test('alert writes recheck the delivery guard and destination after the queue wait', { timeout: 3000 }, async t => {
  const { sdk, message, destinations } = sdkFixture(t, '0');
  destinations.add('revoked-chat');
  const started = deferred<void>();
  const release = deferred<void>();
  const calls: string[] = [];
  message.create = async ({ data }) => {
    const title = JSON.parse(data.content).header.title.content as string;
    calls.push(title);
    if (title === 'first') {
      started.resolve();
      await release.promise;
    }
    return { code: 0, data: { message_id: title } };
  };
  const first = sdk.send('chat', card('first'), 'watch:first');
  await started.promise;
  let allowGuard = true;
  const guardRejected = assert.rejects(sdk.send('chat', card('revoked guard'), 'usage:auto:guard', async () => {
    if (!allowGuard) throw new Error('guard revoked');
  }), /guard revoked/);
  const routeRejected = assert.rejects(sdk.send('revoked-chat', card('revoked route'), 'watch-route'),
    /destination unauthorized/);
  const last = sdk.send('usage', card('last'), 'usage-auto-last');
  await nextTurn();
  allowGuard = false;
  destinations.delete('revoked-chat');
  release.resolve();
  await Promise.all([first, guardRejected, routeRejected, last]);
  assert.deepEqual(calls, ['first', 'last']);
});
