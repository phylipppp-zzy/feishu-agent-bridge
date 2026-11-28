import { DatabaseSync } from "node:sqlite";
import { FeishuApiRejected } from "../src/unified/feishu-sdk-port.js";
import type { ChannelCard } from "../src/unified/feishu-cards.js";
import {test} from 'node:test'; import assert from 'node:assert/strict'; import {mkdtempSync,rmSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; import {FeishuChannel} from '../src/unified/feishu-channel.js';
test('one turn with several message items updates one card and final converges',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const dir=mkdtempSync(join(tmpdir(),'stream-card-')); const messages:any[]=[]; const events:any[]=[]; const sends:any[]=[],updates:any[]=[]; let cursor=0;
 const session:any={sessionId:'s',native:{provider:'codex'},title:'test',project:'/tmp',status:'running',revision:0,control:{input:'unavailable',generation:0}};
 const service:any={getSession:async()=>session,getSnapshot:async()=>({cursor:String(events.length+1),value:{session,messages:[...messages],interactions:[]}}),subscribeEvents:async()=>({status:'events',events:[...events.slice(cursor)],cursor:String(events.length+1)})};
 const port:any={async send(_d:any,c:any){sends.push(c);return `card-${sends.length}`},async update(_d:any,id:any,c:any){updates.push({id,c})},async sendFile(){}};
 const channel=new FeishuChannel(service,port,async()=>true,join(dir,'db')); const env={eventId:'bind',destination:'d',identity:{source:'feishu',subject:'owner'}};
 const add=(id:string,text:string,final:boolean)=>{messages.push({messageId:id,sessionId:'s',turnId:'turn',role:'assistant',blocks:[{type:'text',text}],sequence:messages.length+1,revision:1,final,source:'codex'});events.push({type:'message.updated',objectId:id,eventId:id,data:{}})};
 try {await channel.handle(env,{action:'bind',sessionId:'s'});await channel.sync('d');sends.length=0;add('one','first',false);await channel.sync('d');cursor=events.length;add('two','middle',true);add('three','final',true);await channel.sync('d');assert.equal(sends.length,1);assert.equal(updates.length,0);t.mock.timers.tick(2500);await channel.sync('d');assert.equal(updates.length,1);assert.equal(updates[0].c.text,'first\n\nmiddle\n\nfinal');assert.equal(updates[0].id,'card-1');}finally{channel.close();rmSync(dir,{recursive:true,force:true})}
});

test('twenty partials coalesce, restart reuses card, final applies after the trailing interval',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const dir=mkdtempSync(join(tmpdir(),'stream-restart-'));const session:any={sessionId:'s',native:{provider:'codex'},title:'test',project:'/tmp',status:'running',revision:0,control:{input:'unavailable',generation:0}};let m:any,revision=0;const sends:any[]=[],updates:any[]=[];
 const service:any={getSession:async()=>session,getSnapshot:async()=>({cursor:String(revision+1),value:{session,messages:m?[m]:[],interactions:[]}}),subscribeEvents:async()=>({status:'events',events:m?[{type:'message.updated',objectId:'i',eventId:String(revision),data:{}}]:[],cursor:String(revision+1)})}; const port:any={async send(_d:any,c:any){sends.push(c);return 'card'},async update(_d:any,id:any,c:any){updates.push({id,c})},async sendFile(){}};const open=()=>new FeishuChannel(service,port,async()=>true,join(dir,'db'));let channel=open();
 try{await channel.handle({eventId:'bind',destination:'d',identity:{source:'feishu',subject:'owner'}},{action:'bind',sessionId:'s'});await channel.sync('d');sends.length=0;for(let i=1;i<=20;i++){revision=i;m={messageId:'i',sessionId:'s',turnId:'t',role:'assistant',blocks:[{type:'text',text:String(i)}],sequence:1,revision:i,final:false,source:'codex'};await channel.sync('d');}assert.equal(sends.length,1);assert.equal(updates.length,0);channel.close();channel=open();revision++;m={...m,revision,final:true,blocks:[{type:'text',text:'final'}]};await channel.sync('d');assert.equal(updates.length,0);t.mock.timers.tick(2500);await channel.sync('d');assert.equal(sends.length,1);assert.equal(updates.length,1);assert.equal(updates[0].id,'card');assert.equal(updates[0].c.text,'final');}finally{channel.close();rmSync(dir,{recursive:true,force:true})}
});

test('uncertain initial stream delivery is not resent on restart or final',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'stream-unknown-'));const session:any={sessionId:'s',native:{provider:'codex'},title:'test',project:'/tmp',status:'running',revision:0,control:{input:'unavailable',generation:0}};let m:any,attempts=0;const service:any={getSession:async()=>session,getSnapshot:async()=>({cursor:'c',value:{session,messages:m?[m]:[],interactions:[]}}),subscribeEvents:async()=>({status:'events',events:m?[{type:'message.updated',objectId:'i',eventId:'e',data:{}}]:[],cursor:'c'})};let fail=false;const port:any={async send(){if(fail){attempts++;throw Error('unknown')}return 'bind'},async update(){throw Error('unexpected update')},async sendFile(){}};const open=()=>new FeishuChannel(service,port,async()=>true,join(dir,'db'));let channel=open();try{await channel.handle({eventId:'bind',destination:'d',identity:{source:'feishu',subject:'owner'}},{action:'bind',sessionId:'s'});await channel.sync('d');fail=true;m={messageId:'i',sessionId:'s',turnId:'t',role:'assistant',blocks:[{type:'text',text:'partial'}],sequence:1,revision:1,final:false,source:'codex'};await assert.rejects(channel.sync('d'));channel.close();channel=open();m={...m,revision:2,final:true};await channel.sync('d');assert.equal(attempts,1);assert.equal(channel.pendingDeliveries().length,1);}finally{channel.close();rmSync(dir,{recursive:true,force:true})}
});

for (const receipt of ['sent', 'not_sent'] as const) test(`restarts recover a throttled final PATCH and completion push (${receipt})`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'turn-final-recovery-'));
  const session = { sessionId: 's', native: { provider: 'claude' }, title: 'test', project: dir, status: 'running',
    revision: 0, control: { input: 'unavailable', generation: 0 } };
  const delivered = new Set<string>();
  const checked: string[] = [];
  const writes: string[] = [];
  const start = Date.now();
  let status: 'running' | 'completed' = 'running';
  let timingAvailable = true;
  let confirmUnsent = false;
  let events: any[] = [], messages: any[] = [];
  const getSnapshot = async () => ({ cursor: 'c', value: { session, messages, interactions: [],
    turnProgress: { tools: [], timing: timingAvailable ? [{ turnId: 't', startedMs: start,
      endedMs: status === 'completed' ? start + 120_000 : null, liveStartSequence: 10, liveEndSequence: status === 'completed' ? 11 : null }] : [] },
  } });
  const service: any = { getSession: async () => session, getSnapshot,
    subscribeEvents: async () => ({ status: 'events', cursor: 'c', events }) };
  const port = {
    async send() { return 'same-id'; },
    async update(_destination: string, messageId: string, _card: unknown, deliveryId: string) {
      assert.equal(messageId, 'same-id');
      if (!deliveryId.startsWith('turn-final:')) return;
      writes.push(deliveryId);
      delivered.add(deliveryId);
      throw Error('PATCH acknowledgement lost');
    },
    async sendText(_destination: string, _text: string, deliveryId: string) {
      writes.push(deliveryId);
      if (receipt === 'sent' || confirmUnsent) delivered.add(deliveryId);
      if (confirmUnsent) return;
      throw Error('text acknowledgement lost');
    },
    async lookupDelivery(deliveryId: string) {
      checked.push(deliveryId);
      return delivered.has(deliveryId) ? 'sent' as const : confirmUnsent ? 'not_sent' as const : 'unknown' as const;
    },
    async sendFile() {},
  };
  const open = () => new FeishuChannel(service, port, async () => true, join(dir, 'db'));
  let channel = open();
  try {
    await channel.handle({ eventId: 'bind', destination: 'd', identity: { source: 'feishu', subject: 'owner' } },
      { action: 'bind', sessionId: 's' });
    await channel.sync('d');
    messages = [{ messageId: 'm', sessionId: 's', sequence: 1, revision: 1, role: 'assistant', turnId: 't',
      final: false, blocks: [{ type: 'text', text: 'reply' }] }];
    events = [{ type: 'message.updated', objectId: 'm' }];
    await channel.sync('d');
    t.mock.timers.tick(119_999);
    messages = [{ ...messages[0], revision: 2, blocks: [{ type: 'text', text: 'latest reply' }] }];
    await channel.sync('d');
    t.mock.timers.tick(1);
    status = 'completed';
    events = [{ type: 'turn.updated', objectId: 't', data: { status } }];
    await channel.sync('d');
    assert.deepEqual(writes, [], 'final PATCH is still throttled');
    events = [];
    t.mock.timers.tick(2500);
    await assert.rejects(channel.sync('d'), /PATCH acknowledgement lost/);
    channel.close();
    timingAvailable = false;
    channel = open();
    await assert.rejects(channel.sync('d'), /text acknowledgement lost/);
    channel.close();
    channel = open();
    await channel.sync('d');
    assert.equal(writes.length, 2, 'an unknown effect cannot be retried');
    assert.match(writes[0]!, /^turn-final:/);
    assert.match(writes[1]!, /^turn-push:/);
    if (receipt === 'not_sent') {
      assert.equal(channel.pendingDeliveries()[0]?.deliveryId, writes[1]);
      confirmUnsent = true;
      await channel.sync('d');
      assert.deepEqual(writes, [writes[0], writes[1], writes[1]], 'proven non-delivery is retried with the same ID');
    }
    await channel.sync('d');
    assert.ok(writes.every(id => checked.includes(id)));
    assert.deepEqual(channel.pendingDeliveries(), []);
  } finally { channel.close(); rmSync(dir, { recursive: true, force: true }); }
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
    assert.deepEqual(sent.map(card => [card.template, card.text, card.actions]), [
      ['green', 'first', []], ['green', 'second', []], ['blue', 'third', []],
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
    t.mock.timers.tick(60_000);
    assert.deepEqual(wake, ['d']);
    for (const [status, input] of [['running', 'unavailable'], ['read_only', 'available'], ['unreachable', 'available']] as const) {
      await channel.sync('d');
      t.mock.timers.tick(2500);
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

for (const { code, exhaust = false, rejectReplacement = false } of [
  { code: 230429 }, { code: 230099 }, { code: 230031 }, { code: 230031, rejectReplacement: true },
  { code: 230429, exhaust: true, rejectReplacement: true },
]) test(`final card rejection ${code} settles (exhaust=${exhaust}, replacement rejects=${rejectReplacement})`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'turn-final-rejected-'));
  const path = join(dir, 'db');
  const start = Date.now();
  const session = { sessionId: 's', native: { provider: 'claude' }, title: 'test', project: dir, status: 'running',
    revision: 0, control: { input: 'unavailable', generation: 0 } };
  let messages: any[] = [], events: any[] = [];
  let completed = false;
  const final = '核心结论\n' + '内容。'.repeat(code === 230099 ? 3000 : 1300) + '\n最终段落';
  const writes: Array<{ id: string; card: ChannelCard }> = [];
  const replacements: Array<{ id: string; card: ChannelCard }> = [];
  const pushes: string[] = [], wake: string[] = [];
  const service: any = {
    getSession: async () => session,
    getSnapshot: async () => ({ cursor: 'c', value: { session, messages, interactions: [],
      turnProgress: { tools: [], timing: [{ turnId: 't', startedMs: start, endedMs: completed ? start + 120_000 : null,
        liveStartSequence: 10, liveEndSequence: completed ? 11 : null }] } } }),
    subscribeEvents: async () => ({ status: 'events', cursor: 'c', events }),
  };
  const port = {
    async send(_destination: string, card: ChannelCard, delivery: string) {
      if (!delivery.endsWith(':replace')) return 'stream-card';
      replacements.push({ id: delivery, card });
      if (rejectReplacement) throw new FeishuApiRejected(230031);
      return 'replacement-card';
    },
    async update(_destination: string, id: string, card: ChannelCard, delivery: string) {
      assert.equal(id, 'stream-card');
      writes.push({ id: delivery, card });
      if (exhaust || writes.length === 1) throw new FeishuApiRejected(code);
    },
    async sendText(_destination: string, text: string) {
      assert.equal(writes.length, exhaust ? 7 : code === 230031 ? 1 : 2);
      pushes.push(text);
    },
    async lookupDelivery() { return 'unknown' as const; },
    async sendFile() {},
  };
  const open = () => new FeishuChannel(service, port, async () => true, path, undefined, false,
    { onProgressWake: destination => wake.push(destination) });
  let channel = open();
  const db = new DatabaseSync(path);
  try {
    await channel.handle({ eventId: 'bind', destination: 'd', identity: { source: 'feishu', subject: 'owner' } },
      { action: 'bind', sessionId: 's' });
    await channel.sync('d');
    messages = [{ messageId: 'm', sessionId: 's', sequence: 1, revision: 1, role: 'assistant', turnId: 't',
      final: false, blocks: [{ type: 'text', text: 'stream' }] }];
    events = [{ type: 'message.updated', objectId: 'm' }];
    await channel.sync('d');
    t.mock.timers.tick(120_000);
    completed = true;
    messages = [{ ...messages[0], revision: 2, final: true, blocks: [{ type: 'text', text: final }] }];
    events = [{ type: 'turn.updated', objectId: 't', data: { status: 'completed' } }];
    await channel.sync('d');
    assert.match(writes[0]!.id, /^turn-final:/);
    if (code === 230429) {
      assert.equal(writes.length, 1);
      assert.deepEqual(pushes, []);
      assert.deepEqual({ ...db.prepare('SELECT status, dirty FROM channel_turn_card_views').get() }, { status: 'running', dirty: 1 });
      assert.equal(db.prepare('SELECT revision FROM channel_stream_cards').get()?.revision, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channel_turn_pending_finalization').get()?.n, 1);
      assert.deepEqual(channel.pendingDeliveries(), []);
      events = [];
      channel.close();
      channel = open();
      await channel.sync('d');
      t.mock.timers.tick(2999);
      assert.deepEqual(wake, []);
      t.mock.timers.tick(1);
      assert.deepEqual(wake, ['d']);
      await channel.sync('d');
      assert.equal(writes[1]!.id, writes[0]!.id);
      assert.equal(writes[1]!.card.text, final);
      if (exhaust) {
        for (const delay of [6000, 12_000, 24_000, 30_000, 30_000]) {
          const count: number = writes.length;
          t.mock.timers.tick(delay - 1);
          await channel.sync('d');
          assert.equal(writes.length, count);
          t.mock.timers.tick(1);
          await channel.sync('d');
          assert.equal(writes.length, count + 1);
        }
        assert.ok(writes.every(write => write.id === writes[0]!.id));
      }
    } else if (code === 230099) {
      assert.equal(writes[1]!.id, writes[0]!.id + ':plain');
      assert.equal(writes[1]!.card.format, 'plain');
      assert.equal(writes[1]!.card.text, writes[0]!.card.text);
      assert.deepEqual(writes[1]!.card.actions, writes[0]!.card.actions);
      assert.equal(writes[1]!.card.actions[0]?.value.action, 'full_reply');
    }
    if (code === 230031 || exhaust) {
      assert.equal(replacements.length, 1);
      assert.equal(replacements[0]!.id, writes[0]!.id + ':replace');
      assert.equal(replacements[0]!.card.format, 'plain');
      assert.equal(replacements[0]!.card.text, final);
      assert.equal(db.prepare('SELECT platform_code FROM channel_delivery_diagnostics WHERE delivery_id=?')
        .get(writes[0]!.id)?.platform_code, code);
    }
    assert.equal(db.prepare('SELECT dirty FROM channel_turn_card_views').get()?.dirty, 0);
    assert.deepEqual({ ...db.prepare('SELECT card_id, revision FROM channel_stream_cards').get() }, {
      card_id: code === 230031 && !rejectReplacement ? 'replacement-card' : 'stream-card',
      revision: rejectReplacement ? 1 : 2,
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channel_turn_card_attempts').get()?.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channel_turn_pending_finalization').get()?.n, 0);
    assert.deepEqual(channel.pendingDeliveries(), []);
    assert.equal(pushes.length, 1);
    const wakeCount = wake.length;
    t.mock.timers.tick(120_000);
    assert.equal(wake.length, wakeCount);
    await channel.sync('d');
    assert.equal(replacements.length, code === 230031 || exhaust ? 1 : 0);
    assert.equal(pushes.length, 1);
  } finally { db.close(); channel.close(); rmSync(dir, { recursive: true, force: true }); }
});
