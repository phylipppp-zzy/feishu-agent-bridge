import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { UnifiedService } from '../src/unified/adapter.js';
import type { Message, Session, Turn } from '../src/unified/contracts.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { FeishuChannel } from '../src/unified/feishu-channel.js';
import { FeishuApiRejected, FeishuSdkPort } from '../src/unified/feishu-sdk-port.js';
import { WatchHub } from '../src/unified/hubs/watch-hub.js';
import type { WatchEvent } from '../src/unified/hubs/watch-types.js';
import { setCustomTopicTitle, syncTopicRootTitle } from '../src/unified/topic-title-sync.js';
import { TurnCardDelivery } from '../src/unified/turn-card-delivery.js';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('running card heartbeats skip elapsed-only writes and preserve the exact final duration', async t => {
  const start = Date.parse('2026-11-27T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE channel_delivery_diagnostics (delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL, platform_code INTEGER);
  `);
  const patches: ChannelCard[] = [];
  const sends: ChannelCard[] = [];
  let wakes = 0;
  const delivery = new TurnCardDelivery(db, {} as UnifiedService, {
    async send(_destination, card) { sends.push(card); return 'card'; },
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
  assert.match(sends[0]!.title, /进行中/);
  assert.doesNotMatch(sends[0]!.title, /用时/);
  for (let i = 1; i <= 3; i++) {
    t.mock.timers.tick(60_000);
    assert.equal(wakes, i);
    await delivery.renderStreamMessage(input);
  }
  assert.equal(patches.length, 0);

  input.tools = [{ turnId: 't', callId: 'tool', phase: 'running', tool: 'Bash', summary: 'Bash · tests' }];
  await delivery.renderStreamMessage(input);
  assert.match(patches[0]!.executionLog!.runningNote!, /Bash/);
  assert.doesNotMatch(patches[0]!.title, /用时/);
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
  assert.equal(titles.length, 0);
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

  const subtitles: Array<string | undefined> = [];
  port.update = async (_destination, _id, updated) => { titles.push(updated.title); subtitles.push(updated.subtitle); };
  const placeholder = 'Codex 会话 · 0123abcd';
  await sync('read_only', placeholder, true);
  await sync('read_only', 'first real title', true);
  await sync('read_only', 'later title drift', true);
  db.exec("UPDATE channel_bindings SET revision=2, access_mode='interactive'");
  const interactiveScope = JSON.stringify(db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings').get());
  await syncTopicRootTitle(db, port, 'topic', interactiveScope, { ...session, status: 'running', title: 'first real title' },
    card => card, async () => {});
  assert.deepEqual(titles.slice(-3), [`🔵 ${placeholder}`, '🔵 first real title', '🔵 first real title']);
  assert.deepEqual(subtitles, ['/work · 终端运行中', '/work · 终端运行中', '/work · 运行中']);
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('readonly topic keeps its live or snapshot running status with no new events', async t => {
  const path = join(tempDir(t), 'channel.sqlite');
  const identity = { source: 'feishu', subject: 'owner' };
  const session = { sessionId: 's', project: '/work', title: 'Terminal session', status: 'read_only',
    native: { provider: 'codex' }, capabilities: {}, control: { input: 'unavailable' } } as Session;
  const turn = { status: 'running' } as Turn;
  let turns: Turn[] = [];
  let live = false;
  const getSnapshot = t.mock.fn(async () => ({ cursor: '0', value: { session, turns, messages: [], interactions: [] } }));
  const service = {
    async getSession() { return session; }, getSnapshot,
    async subscribeEvents() { return { status: 'events' as const, cursor: '0', events: [] }; },
  } as Pick<UnifiedService, 'getSession' | 'getSnapshot' | 'subscribeEvents'> as UnifiedService;
  const patches: ChannelCard[] = [];
  const channel = new FeishuChannel(service, {
    isTopicDestination: () => true, rootMessageId: () => 'root',
    async send() { return 'reply'; }, async sendFile() {},
    async update(_destination, _id, card) { patches.push(card); },
  }, async () => true, path, undefined, false, {
    readReadonlyLiveTurn: () => live ? {
      state: 'running', running: true, anchorId: 'cli', previewText: '', tools: [], activeSubagents: [], signature: 'cli',
    } : null,
  });
  t.after(() => channel.close());
  using db = new DatabaseSync(path);
  db.exec("INSERT INTO channel_bindings(destination,session_id,binding_id,revision,access_mode,owner_source,owner_subject) VALUES ('topic','s','binding',1,'read_only','feishu','owner')");
  const scope = JSON.stringify(db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings').get());
  db.prepare("INSERT INTO channel_cursors(destination,session_id,cursor,binding_scope) VALUES ('topic','s','0',?)").run(scope);
  await channel.sync('topic');
  assert.equal(getSnapshot.mock.callCount(), 0);
  assert.match(patches.at(-1)!.title, /^⚪/u);
  live = true;
  await channel.sync('topic');
  assert.equal(getSnapshot.mock.callCount(), 0);
  assert.match(patches.at(-1)!.subtitle!, /终端运行中/);
  await channel.handle({ destination: 'topic', identity, eventId: 'rename' }, { action: 'rename', title: 'Renamed' });
  assert.equal(patches.at(-1)!.title, '🔵 Renamed');
  live = false;
  turns = [turn];
  await channel.sync('topic');
  assert.equal(getSnapshot.mock.callCount(), 1);
  assert.equal(patches.at(-1)!.title, '🔵 Renamed');
  turns = [];
  await channel.sync('topic');
  await channel.sync('topic');
  assert.equal(getSnapshot.mock.callCount(), 2);
  assert.equal(patches.at(-1)!.title, '⚪ Renamed');
});

test('Watch claims the latest coalesced state and leaves pre-send cancellations pending', async t => {
  const path = join(tempDir(t), 'watch.sqlite');
  const lookupStarted = deferred<void>();
  const receipt = deferred<string | null>();
  const delivered: Array<{ id: string; card: ChannelCard }> = [];
  let cancel = false;
  let cancelledAttempts = 0;
  const hub = new WatchHub({
    dbPath: path, owner: { source: 'feishu', subject: 'owner' }, destination: 'chat',
    port: {
      async send(_destination, _card, id) {
        if (cancel) {
          cancelledAttempts++;
          throw Object.assign(new Error('stopped before send'), { deliveryKind: 'cancelled_before_send' });
        }
        return 'message:' + id;
      },
      async update(_destination, id, card) { delivered.push({ id, card }); },
      async lookupMessageId() { lookupStarted.resolve(); return receipt.promise; },
    },
  });
  t.after(() => hub.close());
  await hub.ensureRoot();
  using db = new DatabaseSync(path);
  const event: WatchEvent = { eventId: 'first', objectId: 'agent', source: 'codex_status', state: 'alert', severity: 'normal',
    title: 'Agent', summary: 'original alert', occurredAt: '2026-11-27T00:00:00Z' };
  const first = await hub.ingest(event);
  db.prepare("UPDATE watch_hub_outbox_v1 SET state='unknown' WHERE outbox_id=?").run(first.outboxId);
  await hub.ingest({ ...event, eventId: 'second', occurredAt: '2026-11-27T00:00:01Z' });
  const flushing = hub.flush();
  await lookupStarted.promise;
  await hub.ingest({ ...event, eventId: 'recovery', state: 'recovered', summary: 'recovery while claiming',
    occurredAt: '2026-11-27T00:00:02Z' });
  receipt.resolve('known-message');
  assert.equal((await flushing)[0]?.status, 'sent');
  assert.equal(delivered[0]?.id, 'known-message');
  assert.match(delivered[0]!.card.text, /recovery while claiming/);

  const unsentIds = ['cancelled', 'untouched'];
  for (const id of unsentIds) await hub.ingest({ ...event, eventId: id, objectId: id });
  cancel = true;
  assert.deepEqual(await hub.flush(), []);
  assert.equal(cancelledAttempts, 1);
  assert.deepEqual(db.prepare("SELECT object_id,state,had_unknown FROM watch_hub_outbox_v1 WHERE object_id<>'agent' ORDER BY rowid")
    .all().map(row => [row.object_id, row.state, row.had_unknown]), unsentIds.map(id => [id, 'pending', 0]));
  cancel = false;
  assert.equal((await hub.flush()).filter(result => result.status === 'sent').length, 2);
});

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
  const { im: { message, file } } = (sdk as unknown as { client: { im: { message: {
    create: (request: { data: { content: string } }) => Promise<{ code: number; data?: { message_id: string } }>;
    patch: (request: { data: { content: string }; path: { message_id: string } }) => Promise<{ code: number }>;
  }; file: { create: () => Promise<{ file_key: string }> } } } }).client;
  return { sdk, message, file, destinations };
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
  const pacedRejection = assert.rejects(paced, { message: 'SDK port closing', deliveryKind: 'cancelled_before_send' });
  const inFlight = sdk.send('chat', card('in flight'), 'usage-msg:user');
  const receiptRejection = assert.rejects(inFlight, /SDK port closing/);
  await started.promise;
  await nextTurn();
  sdk.stopReceiving();
  await pacedRejection;
  sdk.close();
  release.resolve({ code: 0, data: { message_id: 'late' } });
  await receiptRejection;
  await assert.rejects(sdk.update('chat', 'first', card('closed'), 'watch:closed'),
    { message: 'SDK port closing', deliveryKind: 'cancelled_before_send' });
  assert.deepEqual(calls, ['first', 'in flight']);
});

test('stopping intake during the alert PATCH guard cancels without a PATCH', { timeout: 3000 }, async t => {
  const { sdk, message } = sdkFixture(t, '0');
  const guardStarted = deferred<void>();
  const releaseGuard = deferred<void>();
  message.create = async () => ({ code: 0, data: { message_id: 'existing' } });
  const patch = message.patch = t.mock.fn(async () => ({ code: 0 }));
  const id = await sdk.send('chat', card('existing'), 'setup');
  const rejected = assert.rejects(sdk.update('chat', id, card('alert'), 'watch:update', async () => {
    guardStarted.resolve();
    await releaseGuard.promise;
  }), { deliveryKind: 'cancelled_before_send' });
  await guardStarted.promise;
  sdk.stopReceiving();
  releaseGuard.resolve();
  await rejected;
  assert.equal(patch.mock.callCount(), 0);
});

test('stopping intake after an alert file upload cancels before sending the message', { timeout: 3000 }, async t => {
  const { sdk, message, file } = sdkFixture(t, '0');
  const guardStarted = deferred<void>();
  const releaseGuard = deferred<void>();
  const upload = file.create = t.mock.fn(async () => ({ file_key: 'uploaded' }));
  const send = message.create = t.mock.fn(async () => ({ code: 0, data: { message_id: 'unexpected' } }));
  const rejected = assert.rejects(sdk.sendFile('chat', 'alert.txt', Buffer.from('alert'), 'watch:file', async () => {
    if (!upload.mock.callCount()) return;
    guardStarted.resolve();
    await releaseGuard.promise;
  }), { deliveryKind: 'cancelled_before_send' });
  await guardStarted.promise;
  sdk.stopReceiving();
  releaseGuard.resolve();
  await rejected;
  assert.equal(upload.mock.callCount(), 1);
  assert.equal(send.mock.callCount(), 0);
});

test('stopping intake preserves an in-flight message receipt until the SDK DB closes', async t => {
  const { sdk, message } = sdkFixture(t);
  const release = deferred<{ code: number; data: { message_id: string } }>();
  const started = deferred<void>();
  message.create = async () => { started.resolve(); return release.promise; };
  const inFlight = sdk.send('chat', card('in flight'), 'watch:receipt');
  await started.promise;
  sdk.stopReceiving();
  release.resolve({ code: 0, data: { message_id: 'sent' } });
  assert.equal(await inFlight, 'sent');
  assert.equal(await sdk.lookupMessageId('watch:receipt'), 'sent');
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
