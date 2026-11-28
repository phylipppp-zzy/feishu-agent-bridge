import { DatabaseSync } from "node:sqlite";
import { FeishuApiRejected } from "../src/unified/feishu-sdk-port.js";
import type { ChannelCard } from "../src/unified/feishu-cards.js";
import {test} from 'node:test'; import assert from 'node:assert/strict'; import {mkdtempSync,rmSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; import {FeishuChannel} from '../src/unified/feishu-channel.js';
const PROCESS_DELAY_MS = Number(process.env.FEISHU_PROCESS_CARD_DELAY_MS ?? 5000);
const PATCH_INTERVAL_MS = Number(process.env.FEISHU_PATCH_INTERVAL_MS ?? 2500);
const REJECTION_RETRY_MS = Number(process.env.FEISHU_REJECTION_RETRY_MS ?? 3000);

function streamFixture(t: import('node:test').TestContext, provider = 'codex') {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'stream-card-'));
  const path = join(dir, 'db');
  const start = Date.now();
  const session = { sessionId: 's', native: { provider }, title: 'test', project: dir, status: 'running',
    revision: 0, control: { input: 'unavailable', generation: 0 } };
  let events: any[] = [], messages: any[] = [];
  let turn = { turnId: 't', status: 'running', startedAt: new Date(start).toISOString(), endedAt: null as string | null };
  const writes: Array<{ id: string; card: ChannelCard; delivery: string; kind: 'send' | 'patch' }> = [];
  const service: any = {
    getSession: async () => session,
    getSnapshot: async () => ({ cursor: String(events.length), value: { session, messages, turns: [turn], interactions: [] } }),
    subscribeEvents: async (_sessionId: string, cursor: string) =>
      ({ status: 'events', cursor: String(events.length), events: events.slice(Number(cursor)) }),
  };
  const port: import('../src/unified/feishu-channel.js').FeishuPort = {
    async send(_d, card, delivery) {
      const id = `card-${writes.length + 1}`;
      writes.push({ id, card, delivery, kind: 'send' });
      return id;
    },
    async update(_d, id, card, delivery) { writes.push({ id, card, delivery, kind: 'patch' }); },
    async sendFile() {},
    async sendText() { assert.fail('no duplicate completion notice'); },
  };
  const wakes: string[] = [];
  const open = () => new FeishuChannel(service, port, async () => true, path, undefined, false,
    { onProgressWake: destination => wakes.push(destination) });
  let channel = open();
  const db = new DatabaseSync(path);
  t.after(() => { channel.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    db, port, wakes, writes,
    sync: () => channel.sync('d'),
    pending: () => channel.pendingDeliveries(),
    pendingFinalizations: () => db.prepare('SELECT COUNT(*) AS n FROM channel_turn_pending_finalization').get()?.n,
    diagnostic: (id: string) => db.prepare('SELECT platform_code FROM channel_delivery_diagnostics WHERE delivery_id=?').get(id)?.platform_code,
    restart() { channel.close(); channel = open(); },
    async bind() {
      await channel.handle({ eventId: 'bind', destination: 'd', identity: { source: 'feishu', subject: 'owner' } },
        { action: 'bind', sessionId: 's' });
      db.exec("UPDATE channel_bindings SET access_mode='interactive' WHERE destination='d'");
      await channel.sync('d');
      writes.length = 0;
    },
    message(messageId: string, text: string, revision: number, final = false) {
      const index = messages.findIndex(message => message.messageId === messageId);
      const sequence = index < 0 ? messages.length + 1 : messages[index].sequence;
      const message = { messageId, sessionId: 's', turnId: 't', role: 'assistant', sequence, revision, final,
        blocks: [{ type: 'text', text }] };
      if (index < 0) messages.push(message);
      else messages[index] = message;
      events.push({ type: 'message.updated', objectId: messageId });
    },
    finish(endedAt = turn.endedAt) {
      turn = { ...turn, status: 'completed', endedAt };
      session.status = 'idle';
      events.push({ type: 'turn.updated', objectId: 't', data: turn });
    },
  };
}

test('multiple message items converge on the separate final reply', async t => {
  const x = streamFixture(t);
  await x.bind();
  x.message('one', 'first', 1);
  await x.sync();
  assert.equal(x.writes.length, 0);
  t.mock.timers.tick(PROCESS_DELAY_MS);
  await x.sync();
  assert.equal(x.writes[0]?.card.text, 'first');
  x.message('two', 'middle', 1, true);
  x.message('three', 'final', 1, true);
  x.finish();
  await x.sync();
  assert.equal(x.writes.length, 1, 'archival remains throttled');
  t.mock.timers.tick(PATCH_INTERVAL_MS);
  await x.sync();
  const [process, archive, reply] = x.writes;
  assert.equal(archive?.id, process?.id);
  assert.match(archive?.card.text ?? '', /过程已归档/);
  assert.equal(reply?.kind, 'send');
  assert.equal(reply?.card.text, 'first\n\nmiddle\n\nfinal');
});

test('twenty partials coalesce, restart archives existing progress and sends one reply', async t => {
  const x = streamFixture(t);
  await x.bind();
  x.message('m', '1', 1);
  await x.sync();
  t.mock.timers.tick(PROCESS_DELAY_MS);
  await x.sync();
  for (let revision = 2; revision <= 20; revision++) {
    x.message('m', String(revision), revision);
    await x.sync();
  }
  assert.deepEqual(x.writes.map(write => write.kind), ['send']);
  x.restart();
  x.message('m', 'final', 21, true);
  x.finish();
  await x.sync();
  assert.equal(x.writes.length, 1);
  t.mock.timers.tick(PATCH_INTERVAL_MS);
  await x.sync();
  await x.sync();
  assert.deepEqual(x.writes.map(write => write.kind), ['send', 'patch', 'send']);
  assert.equal(x.writes[0]?.id, x.writes[1]?.id);
  assert.notEqual(x.writes[0]?.id, x.writes[2]?.id);
  assert.equal(x.writes[2]?.card.text, 'final');
});

test('unconfirmed process creation is not resent and does not block the final reply', async t => {
  const x = streamFixture(t);
  await x.bind();
  const send = x.port.send;
  let processId = '';
  x.port.send = async (...args) => {
    if (args[2].startsWith('stream:')) {
      assert.equal(processId, '');
      processId = args[2];
      throw Error('process acknowledgement lost');
    }
    return send(...args);
  };
  x.port.lookupDelivery = async () => 'unknown';
  x.message('m', 'draft', 1);
  await x.sync();
  t.mock.timers.tick(PROCESS_DELAY_MS);
  await assert.rejects(x.sync(), /process acknowledgement lost/);
  x.restart();
  x.message('m', 'final', 2, true);
  x.finish();
  await x.sync();
  assert.match(processId, /^stream:/);
  assert.deepEqual(x.writes.map(({ kind, card }) => [kind, card.text]), [['send', 'final']]);
  assert.match(x.writes[0]!.delivery, /^turn-reply:/);
  assert.ok(x.db.prepare('SELECT 1 FROM channel_delivery_diagnostics WHERE delivery_id=?').get(processId));
  assert.equal(x.pendingFinalizations(), 0);
});

test('a lost archive PATCH receipt reconciles after restart and the reply is sent once', async t => {
  const x = streamFixture(t, 'claude');
  await x.bind();
  const archive = x.port.update;
  let archiveDelivery = '';
  x.port.update = async (...args) => {
    await archive(...args);
    archiveDelivery = args[3];
    throw Error('archive acknowledgement lost');
  };
  x.port.lookupDelivery = async id => id === archiveDelivery ? 'sent' : 'unknown';
  x.message('m', 'draft', 1);
  await x.sync();
  t.mock.timers.tick(PROCESS_DELAY_MS);
  await x.sync();
  x.message('m', 'final', 2, true);
  x.finish();
  await x.sync();
  assert.deepEqual(x.writes.map(write => write.kind), ['send'], 'archive remains throttled');
  t.mock.timers.tick(PATCH_INTERVAL_MS);
  await assert.rejects(x.sync(), /archive acknowledgement lost/);
  assert.match(archiveDelivery, /^turn-process-final:/);
  x.restart();
  await x.sync();
  assert.deepEqual(x.writes.map(write => write.kind), ['send', 'patch', 'send']);
  assert.match(x.writes[2]!.delivery, /^turn-reply:/);
  assert.equal(x.pendingFinalizations(), 0);
  assert.deepEqual(x.pending(), []);
});

for (const outcome of ['unknown', 'sent with id', 'sent without id'] as const) {
  test(`direct final reply reconciles a lost create receipt after restart (${outcome})`, async t => {
    const x = streamFixture(t);
    await x.bind();
    const send = x.port.send;
    x.port.send = async (...args) => {
      assert.match(args[2], /^turn-reply:/);
      await send(...args);
      throw Error('reply acknowledgement lost');
    };
    x.port.lookupDelivery = async id => {
      assert.equal(id, x.writes[0]?.delivery);
      return outcome === 'unknown' ? 'unknown' : 'sent';
    };
    x.port.lookupMessageId = async id => outcome === 'sent with id'
      ? x.writes.find(write => write.delivery === id)?.id ?? null : null;
    x.message('m', 'final', 1, true);
    x.finish();
    await assert.rejects(x.sync(), /reply acknowledgement lost/);
    x.restart();
    await x.sync();
    const create = x.writes[0]!;
    assert.equal(x.writes.length, 1);
    assert.equal(x.db.prepare('SELECT card_id FROM channel_turn_reply_cards').get()?.card_id,
      outcome === 'sent with id' ? create.id : null);
    assert.equal(x.pendingFinalizations(), outcome === 'unknown' ? 1 : 0);

    t.mock.timers.tick(7000);
    x.finish(new Date().toISOString());
    await x.sync();
    x.message('m', 'late final', 2, true);
    await x.sync();
    assert.deepEqual(x.writes.filter(write => write.kind === 'send'), [create]);
    if (outcome === 'sent with id') {
      const patches = x.writes.slice(1);
      assert.deepEqual(patches.map(patch => patch.card.text), ['final', 'late final']);
      for (const patch of patches) {
        assert.equal(patch.kind, 'patch');
        assert.equal(patch.id, create.id);
        assert.match(patch.delivery, /^turn-reply-update:/);
        assert.match(patch.card.footer ?? '', /⏱/);
      }
    } else {
      assert.equal(x.writes.length, 1);
    }
    assert.equal(x.pendingFinalizations(), outcome === 'unknown' ? 1 : 0);
    x.restart();
    await x.sync();
    assert.equal(x.writes.length, outcome === 'sent with id' ? 3 : 1);
  });
}

test('a final reply PATCH with an unknown receipt retries on the same card after backoff', async t => {
  const x = streamFixture(t);
  await x.bind();
  x.message('m', 'final', 1, true);
  x.finish();
  await x.sync();
  const replyId = x.writes[0]!.id;
  const update = x.port.update;
  x.port.update = async (...args) => {
    await update(...args);
    if (x.writes.length === 2) throw Error('reply PATCH acknowledgement lost');
  };
  x.port.lookupDelivery = async () => 'unknown';
  t.mock.timers.tick(1);
  x.message('m', 'late final', 2, true);
  await assert.rejects(x.sync(), /reply PATCH acknowledgement lost/);
  assert.match(x.writes[1]!.delivery, /^turn-reply-update:/);
  x.restart();
  await x.sync();
  t.mock.timers.tick(REJECTION_RETRY_MS - 1);
  await x.sync();
  assert.equal(x.writes.length, 2);
  assert.equal(x.pendingFinalizations(), 1);
  t.mock.timers.tick(1);
  await x.sync();
  assert.deepEqual(x.writes.map(({ kind, id }) => [kind, id]), [
    ['send', replyId], ['patch', replyId], ['patch', replyId],
  ]);
  assert.equal(x.writes[2]!.delivery, x.writes[1]!.delivery);
  assert.equal(x.writes[2]!.card.text, 'late final');
  assert.equal(x.pendingFinalizations(), 0);
});

test('ordered turn events fill missing snapshot entries and terminal cards survive file lookup failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-event-fallback-'));
  const session = { sessionId: 's', native: { provider: 'codex' }, title: 'test', project: dir, status: 'idle',
    revision: 0, control: { input: 'available', generation: 0 } };
  const events: any[] = [], messages: any[] = [], sent: any[] = [];
  let turns: Array<{ turnId: string; status: string }> | undefined;
  const reads: string[] = [];
  const service: any = {
    getSession: async () => session,
    getSnapshot: async () => ({ cursor: String(events.length), value: { session, messages, interactions: [], turns } }),
    subscribeEvents: async (_id: string, cursor: string) => {
      reads.push(cursor);
      return { status: 'events', cursor: String(events.length), events: events.slice(Number(cursor)) };
    },
    findRegisteredReplyFiles: async () => { throw Error('registry is unavailable'); },
  };
  const channel = new FeishuChannel(service, {
    async send(_destination, card) { sent.push(card); return String(sent.length); },
    async update() { assert.fail('each turn gets a single terminal card'); },
    async sendFile() {},
  }, async () => true, join(dir, 'db'));
  try {
    await channel.handle({ eventId: 'bind', destination: 'd', identity: { source: 'feishu', subject: 'owner' } },
      { action: 'bind', sessionId: 's' });
    await channel.sync('d');
    sent.length = 0;
    for (const turnId of ['first', 'second', 'third']) {
      if (turnId === 'second') turns = [];
      if (turnId === 'third') turns = [{ turnId, status: 'running' }];
      for (const status of ['running', 'completed', 'running']) events.push({ type: 'turn.updated', objectId: turnId, data: { status } });
      messages.push({ messageId: `m-${turnId}`, sessionId: 's', turnId, sequence: messages.length + 1, revision: 1,
        role: 'assistant', final: true, blocks: [{ type: 'text', text: turnId }] });
      await channel.sync('d');
    }
    assert.deepEqual(reads, ['0', '3', '6']);
    assert.deepEqual(sent.map(card => [card.template, card.text, card.actions.map((action: any) => action.value.action)]), [
      ['green', 'first', ['upgrade', 'panel']], ['green', 'second', ['upgrade', 'panel']],
    ]);
  } finally { channel.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('runtime heartbeat stops when session status or input control becomes unavailable', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'turn-heartbeat-'));
  const session = { sessionId: 's', native: { provider: 'codex' }, title: 'test', project: dir, status: 'running',
    revision: 0, control: { input: 'available', generation: 0 } };
  const startedAt = new Date().toISOString();
  const wake: string[] = [];
  const events: any[] = [], messages: any[] = [];
  const service: any = {
    getSession: async () => session,
    getSnapshot: async () => ({ cursor: String(events.length), value: { session, messages, interactions: [],
      turns: [{ turnId: 't', status: 'running', startedAt }] } }),
    subscribeEvents: async (_id: string, cursor: string) => ({
      status: 'events', cursor: String(events.length), events: events.slice(Number(cursor)),
    }),
  };
  const channel = new FeishuChannel(service, {
    async send() { return 'card'; }, async update() {}, async sendFile() {},
  }, async () => true, join(dir, 'db'), undefined, false, { onProgressWake: destination => wake.push(destination) });
  try {
    await channel.handle({ eventId: 'bind', destination: 'd', identity: { source: 'feishu', subject: 'owner' } },
      { action: 'bind', sessionId: 's' });
    await channel.sync('d');
    events.push({ type: 'message.updated', objectId: 'm' });
    messages.push({ messageId: 'm', sessionId: 's', turnId: 't', sequence: 1, revision: 1,
      role: 'assistant', final: false, blocks: [{ type: 'text', text: 'partial' }] });
    await channel.sync('d');
    t.mock.timers.tick(PROCESS_DELAY_MS);
    assert.deepEqual(wake, ['d']);
    await channel.sync('d');
    t.mock.timers.tick(60_000);
    assert.deepEqual(wake, ['d', 'd']);
    for (const [status, input] of [['running', 'unavailable'], ['read_only', 'available'], ['unreachable', 'available']] as const) {
      await channel.sync('d');
      t.mock.timers.tick(PATCH_INTERVAL_MS);
      session.status = status;
      session.control.input = input;
      await channel.sync('d');
      const count = wake.length;
      t.mock.timers.tick(60_000);
      assert.equal(wake.length, count, `${status}/${input} cancels the pending heartbeat`);
      session.status = 'running';
      session.control.input = 'available';
      await channel.sync('d');
      t.mock.timers.tick(60_000);
      assert.equal(wake.length, count + 1, 'a connected running snapshot restores the heartbeat');
    }
  } finally { channel.close(); rmSync(dir, { recursive: true, force: true }); }
});

const rejectionCases = [
  { code: 230099, exhaust: false },
  { code: 230429, exhaust: false },
  { code: 230429, exhaust: true },
  { code: 230031, exhaust: false },
] as const;

for (const phase of ['archive PATCH', 'reply send'] as const) {
  for (const { code, exhaust } of rejectionCases) {
    test(`${phase} handles platform rejection ${code} (exhaust=${exhaust})`, async t => {
      const x = streamFixture(t, 'claude');
      await x.bind();
      const archive = phase === 'archive PATCH';
      if (archive) {
        x.message('m', 'draft', 1);
        await x.sync();
        t.mock.timers.tick(PROCESS_DELAY_MS);
        await x.sync();
        t.mock.timers.tick(PATCH_INTERVAL_MS);
      }
      const prefix = archive ? 'turn-process-final:' : 'turn-reply:';
      const attempts = () => x.writes.filter(write => write.delivery.startsWith(prefix));
      const checkRejection = () => {
        if (exhaust || attempts().length === 1) throw new FeishuApiRejected(code);
      };
      if (archive) {
        const update = x.port.update;
        x.port.update = async (...args) => {
          await update(...args);
          checkRejection();
        };
      } else {
        const send = x.port.send;
        x.port.send = async (...args) => {
          const id = await send(...args);
          checkRejection();
          return id;
        };
      }
      x.port.lookupDelivery = async () => 'unknown';
      x.message('m', 'final', 2, true);
      x.finish();
      await x.sync();
      const first = attempts()[0]!;
      assert.match(first.delivery, archive ? /^turn-process-final:/ : /^turn-reply:/);
      if (code === 230429) {
        assert.equal(attempts().length, 1);
        x.restart();
        const backoffs = exhaust ? 6 : 1;
        for (let index = 0; index < backoffs; index++) {
          const delay = Math.min(30_000, REJECTION_RETRY_MS * 2 ** index);
          t.mock.timers.tick(delay - 1);
          await x.sync();
          assert.equal(attempts().length, index + 1);
          assert.equal(x.pendingFinalizations(), 1);
          if (archive) assert.equal(x.writes.filter(write => write.delivery.startsWith('turn-reply:')).length, 0);
          t.mock.timers.tick(1);
          await x.sync();
          assert.equal(attempts().length, index + 2);
        }
        assert.ok(attempts().every(write => write.delivery === first.delivery));
      } else if (code === 230099) {
        assert.equal(attempts().length, 2);
        const plain = attempts()[1]!;
        assert.equal(plain.card.format, 'plain');
        assert.equal(plain.card.text, first.card.text);
        assert.equal(plain.card.footer, first.card.footer);
        assert.deepEqual(plain.card.actions, first.card.actions);
        if (archive) assert.equal(plain.delivery, first.delivery + ':plain');
      } else {
        assert.equal(attempts().length, 1);
      }
      if (code === 230031 || exhaust) {
        assert.equal(x.diagnostic(first.delivery), code);
      }
      if (archive) {
        assert.ok(attempts().every(write => write.id === x.writes[0]!.id && write.kind === 'patch'));
        assert.deepEqual(x.writes.filter(write => write.kind === 'send').map(write => write.card.text), ['draft', 'final']);
      }
      assert.equal(x.pendingFinalizations(), 0);
      assert.deepEqual(x.pending(), []);
      const writes = x.writes.length;
      x.restart();
      x.message('m', 'final', 3, true);
      t.mock.timers.tick(30_000);
      await x.sync();
      assert.equal(x.writes.length, writes);
      assert.equal(x.pendingFinalizations(), 0);
    });
  }
}

test('ambiguous archive PATCH attempts back off three times before giving way to the reply', async t => {
  const x = streamFixture(t);
  await x.bind();
  x.message('m', 'draft', 1);
  await x.sync();
  t.mock.timers.tick(PROCESS_DELAY_MS);
  await x.sync();
  t.mock.timers.tick(PATCH_INTERVAL_MS);
  x.message('m', 'final', 2, true);
  x.finish();
  const update = x.port.update;
  x.port.update = async (...args) => {
    await update(...args);
    throw Error('archive acknowledgement lost');
  };
  x.port.lookupDelivery = async () => 'unknown';
  await assert.rejects(x.sync(), /archive acknowledgement lost/);
  for (const [index, delay] of [5000, 10_000, 20_000].entries()) {
    x.restart();
    await x.sync();
    t.mock.timers.tick(delay - 1);
    await x.sync();
    assert.equal(x.writes.length, index + 2);
    assert.equal(x.pendingFinalizations(), 1);
    t.mock.timers.tick(1);
    await assert.rejects(x.sync(), /archive acknowledgement lost/);
    assert.equal(x.writes.length, index + 3);
  }
  await x.sync();
  assert.deepEqual(x.writes.map(write => write.kind), ['send', 'patch', 'patch', 'patch', 'patch', 'send']);
  assert.ok(x.writes.slice(1, -1).every(write => write.id === x.writes[0]!.id));
  assert.match(x.writes.at(-1)!.delivery, /^turn-reply:/);
  assert.equal(x.writes.at(-1)!.card.text, 'final');
  const lastAttempt = x.writes.at(-2)!;
  assert.equal(x.db.prepare('SELECT kind FROM channel_delivery_diagnostics WHERE delivery_id=?')
    .get(lastAttempt.delivery)?.kind, 'unknown');
  assert.equal(x.pendingFinalizations(), 0);
  x.restart();
  t.mock.timers.tick(30_000);
  await x.sync();
  assert.equal(x.writes.length, 6);
});
