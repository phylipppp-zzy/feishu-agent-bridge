import { completionText } from '../src/unified/turn-progress-card.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {UnifiedStore} from '../src/unified/store.js';
import {UnifiedCore} from '../src/unified/service.js';
import {FeishuChannel} from '../src/unified/feishu-channel.js';
import type {PlatformPort} from '../src/unified/adapter.js';
import type {Session,Turn} from '../src/unified/contracts.js';
function setup(){const dir=mkdtempSync(join(tmpdir(),'quiet-'));const db=join(dir,'channel');const store=new UnifiedStore(join(dir,'core'));const caps=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:'available'}]));const session={sessionId:'s',native:{provider:'claude',hostId:'h',serviceId:'svc',nativeSessionId:'n'},project:'p',title:'s',status:'idle',revision:0,capabilities:caps,control:{serviceId:'svc',owner:'owner',input:'available',generation:1,operationId:null,reason:null}} as Session;store.insertSession(session);store.setConnectionGeneration('s',0,1);const port:any={provider:'claude',onObservation:()=>()=>{},input:async(_r:any,_m:any,_b:any,g:any)=>{g.assertCurrent();return {status:'submitted',nativeReference:'t'}}};const core=new UnifiedCore(store,[port],()=>true);const sends:any[]=[],updates:any[]=[],pushes:Array<{text:string;id:string}>=[];const channel=new FeishuChannel(core,{send:async(_d,c)=>{sends.push(c);return `m${sends.length}`},update:async(_d,id,c,deliveryId)=>{updates.push({id,card:c,deliveryId})},sendText:async(_d,text,id)=>{pushes.push({text,id});return `push${pushes.length}`},sendFile:async()=>{}},async()=>true,db);const env=(eventId:string)=>({eventId,destination:'topic',identity:{source:'verified',subject:'owner'}});const bind=async()=>{await channel.handle(env('bind'),{action:'bind',sessionId:'s'});const c=new DatabaseSync(db);c.prepare("UPDATE channel_bindings SET access_mode='interactive' WHERE destination='topic'").run();c.close();await channel.sync('topic');sends.length=0;updates.length=0;};const turn=(status:Turn['status']):Turn=>({turnId:'t',sessionId:'s',status,inputId:null,startedAt:null,endedAt:null,model:null,outputIds:[]});const event=(eventId:string,type:string,data:any)=>store.appendEvent({eventId,sessionId:'s',objectId:eventId,objectRevision:1,type,occurredAt:'2026-01-01T00:00:00Z',receivedAt:'2026-01-01T00:00:00Z',operationId:null,data});return {store,core,channel,env,bind,sends,updates,pushes,turn,event,close:()=>{channel.close();core.close();store.close();rmSync(dir,{recursive:true,force:true})}};}
for(const split of [false,true]) test(`ordinary input sends only reply with ${split?'later':'same'} completion`,async t=>{t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});const x=setup();try{await x.bind();const op:any=await x.channel.handle(x.env('input'),{action:'input',mode:'new',text:'TEST'});assert.equal(x.sends.length,0);const dispatched=await x.core.dispatch(op.operationId);assert.equal(dispatched.status,'accepted',JSON.stringify(dispatched));x.store.putTurn(x.turn('running'));x.store.putMessage({messageId:'m',sessionId:'s',turnId:'t',role:'assistant',blocks:[{type:'text',text:'actual reply'}],sequence:1,revision:1,final:true,source:'fake'},null);if(split) await x.channel.sync('topic');x.store.putTurn(x.turn('completed'));await x.channel.sync('topic');t.mock.timers.tick(1500);await x.channel.sync('topic');assert.equal(x.sends.length,1);assert.equal((split?x.updates[0].card:x.sends[0]).template,'green');assert.match(x.sends[0].text,/actual reply/);}finally{x.close()}});
test('no-output success has one completion while errors, unknowns, quota and queue remain visible',async()=>{const x=setup();try{await x.bind();x.store.putTurn(x.turn('running'));x.store.putTurn(x.turn('completed'));await x.channel.sync('topic');assert.equal(x.sends.length,1);assert.equal(x.sends[0].title,'Claude · 已完成');assert.equal(x.sends[0].template,'green');x.sends.length=0;x.event('bad','operation.failed',{action:'submitInput',status:'failed',error:{code:'busy'},operationId:'bad'});x.event('unknown','operation.unknown',{action:'resolveInteraction',status:'unknown',error:null,operationId:'u'});x.event('quota','provider.usage_limit',{status:'rejected'});await x.channel.sync('topic');assert.equal(x.sends.length,3);assert.ok(x.sends.some(c=>c.text.includes('失败')));assert.ok(x.sends.some(c=>c.text.includes('结果未知')));assert.ok(x.sends.some(c=>c.title==='额度提示'));await x.channel.handle(x.env('queue'),{action:'input',mode:'queue',text:'later'});assert.match(x.sends.at(-1).text,/已排队|等待处理/);assert.ok(x.sends.at(-1).actions.some((a:any)=>a.value.action==='panel'));}finally{x.close()}});
test('approval uses one card and patches it when answered, without duplicate waiting or success cards',async()=>{const x=setup();try{await x.bind();const interaction:any={interactionId:'i',sessionId:'s',turnId:'t',nativeRequestId:'n',connectionGeneration:1,revision:0,status:'awaiting_answer',expiresAt:null,toolInputDigest:'digest',nativeResult:null,kind:'approval',tool:'tool',action:'write',scope:'test'};x.store.insertInteraction(interaction);await x.channel.sync('topic');assert.equal(x.sends.length,1);const card=x.sends[0];assert.equal(card.title,'⚠️ 需人工确认 · tool');assert.equal(card.actions.length,2);await x.channel.handle(x.env('answer'),card.actions[0].value as any);assert.equal(x.sends.length,1);assert.equal(x.updates.length,1);assert.equal(x.updates[0].card.actions.length,0);await x.channel.sync('topic');assert.equal(x.sends.length,1);}finally{x.close()}});

test('same-turn failure appears once and ordinary attach and settings completions stay quiet', async () => {
  const x = setup();
  try {
    await x.bind();
    x.event('bad','operation.failed',{action:'submitInput',status:'failed',error:{code:'busy'},operationId:'bad',result:{kind:'turn',turnId:'t',status:'failed'}});
    x.event('turn-failed','turn.updated',{turnId:'t',status:'failed'});
    x.event('session-failed','session.updated',{status:'failed'});
    for (const action of ['attachSession','updateSessionSettings']) {
      x.event(action,'operation.completed',{action,status:'completed',operationId:action,error:null});
    }
    await x.channel.sync('topic');
    assert.equal(x.sends.length,1);
    assert.match(x.sends[0].text,/失败/);
  } finally { x.close(); }
});

for (const action of ['attachSession','updateSessionSettings']) {
  test(`confirmed ${action} updates the existing unknown receipt`, async () => {
    const x = setup();
    try {
      await x.bind();
      x.event('unknown','operation.unknown',{action,status:'unknown',operationId:'op',error:null});
      await x.channel.sync('topic');
      assert.equal(x.sends.length,1);
      assert.equal(x.sends[0].actions[0].value.action,'reconcile');
      x.event('completed','operation.completed',{action,status:'completed',operationId:'op',error:null});
      await x.channel.sync('topic');
      await x.channel.sync('topic');
      assert.equal(x.sends.length,1);
      assert.equal(x.updates.length,1);
      assert.equal(x.updates[0].id,'m1');
      assert.match(x.updates[0].card.text,/已完成/);
    } finally { x.close(); }
  });
}
test('external waiting without a visible interaction still notifies',async()=>{const x=setup();try{await x.bind();const current=x.store.getSession('s');x.store.updateSession({...current,status:'waiting_approval',revision:current.revision+1},current.revision,current.control.generation);await x.channel.sync('topic');assert.equal(x.sends.filter(c=>c.text.includes('等待审批')).length,1);}finally{x.close()}});

for (const duration of [119_999, 120_000, 120_001]) {
  for (const paused of [false, true]) for (const completed of [false, true]) {
    test(`completion at ${duration} ms, paused=${paused}, completed=${completed}`, async t => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
      const x = setup();
      try {
        await x.bind();
        const settings = x.store.getSession('s');
        let revision = 0;
        for (const [field, value] of [['paused', paused], ['completed', completed]] as const) {
          await x.channel.handle(x.env(field), { action: 'notice_settings', field, value, settingsRevision: revision++,
            revision: settings.revision, controlGeneration: settings.control.generation });
        }
        x.sends.length = 0;
        const startedAt = new Date().toISOString();
        x.store.observeTurn({ ...x.turn('running'), startedAt });
        x.store.putMessage({ messageId: 'reply', sessionId: 's', turnId: 't', role: 'assistant',
          blocks: [{ type: 'text', text: '# **结果** [报告](docs/report.pdf)\n更多细节' }],
          sequence: 1, revision: 1, final: true, source: 'claude' }, null);
        await x.channel.sync('topic');
        assert.equal(x.sends[0].template, 'blue', 'a final message block is not a terminal turn');
        t.mock.timers.tick(duration);
        x.store.observeTurn({ ...x.turn('completed'), endedAt: new Date().toISOString() });
        await x.channel.sync('topic');
        t.mock.timers.tick(1500);
        await x.channel.sync('topic');
        assert.equal(x.sends.length, 1);
        const result = x.updates.at(-1);
        assert.equal(result.id, 'm1');
        assert.equal(result.card.title, 'Claude · 已完成 · 用时 2分00秒');
        assert.equal(result.card.schema, '2.0');
        assert.equal(result.card.template, 'green');
        assert.match(result.deliveryId, /^turn-final:/);
        const expected = duration >= 120_000 && !paused && completed ? 1 : 0;
        assert.equal(x.pushes.length, expected);
        if (expected) {
          assert.deepEqual(x.pushes[0]!.text, '✅ 本轮已完成（用时 2分00秒）· 结果 报告');
          assert.match(x.pushes[0]!.id, /^turn-push:/);
        }
        await x.channel.sync('topic');
        assert.equal(x.pushes.length, expected);
      } finally { x.close(); }
    });
  }
}

test('completion under pause stays quiet when resumed before the terminal event is delivered', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const x = setup();
  try {
    await x.bind();
    x.store.observeTurn(x.turn('running'));
    const pause = async (value: boolean, revision: number) => {
      const session = x.store.getSession('s');
      await x.channel.handle(x.env(`pause-${revision}`), { action: 'notice_settings', field: 'paused',
        value, settingsRevision: revision, revision: session.revision, controlGeneration: session.control.generation });
    };
    await pause(true, 0);
    t.mock.timers.tick(120_001);
    x.store.observeTurn(x.turn('completed'));
    await pause(false, 1);
    await x.channel.sync('topic');
    assert.equal(x.sends.filter(card => card.template === 'green').length, 1);
    assert.deepEqual(x.pushes, []);
  } finally { x.close(); }
});

test('recovered native timestamps display the duration without a live completion push', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const x = setup();
  try {
    await x.bind();
    x.store.putTurn({ ...x.turn('running'), startedAt: new Date(Date.now() - 180_000).toISOString() });
    x.store.observeTurn(x.turn('completed'));
    await x.channel.sync('topic');
    assert.equal(x.sends.at(-1).title, 'Claude · 已完成 · 用时 3分00秒');
    assert.deepEqual(x.pushes, []);
  } finally { x.close(); }
});

test('registered reply file lookup is optional for unavailable and failing providers', async () => {
  const x = setup();
  let reads = 0;
  const failing = { provider: 'claude', onObservation: () => () => {}, findRegisteredReplyFiles: () => {
    reads++;
    throw Error('artifact registry could not be read');
  } } as unknown as PlatformPort;
  const missing = new UnifiedCore(x.store, [], () => true);
  const configured = new UnifiedCore(x.store, [failing], () => true);
  try {
    assert.deepEqual(await missing.findRegisteredReplyFiles('s', []), []);
    configured.setProviderAvailable('claude', false);
    assert.deepEqual(await configured.findRegisteredReplyFiles('s', []), []);
    assert.equal(reads, 0);
    configured.setProviderAvailable('claude', true);
    assert.deepEqual(await configured.findRegisteredReplyFiles('s', []), []);
    assert.equal(reads, 1);
  } finally { missing.close(); configured.close(); x.close(); }
});

test('a snapshot-first completion can be followed by a same-generation live completion push', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const x = setup();
  try {
    await x.bind();
    const running = { ...x.turn('running'), startedAt: new Date().toISOString() };
    x.store.observeTurn(running);
    t.mock.timers.tick(120_000);
    const completed = { ...running, status: 'completed' as const };
    x.store.putTurn(completed);
    await x.channel.sync('topic');
    assert.equal(x.sends.at(-1).title, 'Claude · 已完成');
    assert.equal(x.pushes.length, 0);
    const ref = x.store.getSession('s').native;
    await x.core.observe({ type: 'turn', ref, connectionGeneration: 1, turn: completed });
    await x.channel.sync('topic');
    t.mock.timers.tick(1500);
    await x.channel.sync('topic');
    assert.equal(x.updates.at(-1).card.title, 'Claude · 已完成 · 用时 2分00秒');
    assert.equal(x.pushes.length, 1);
    assert.match(x.pushes[0]!.id, /^turn-push:/);
  } finally { x.close(); }
});

test('completion summary marks an abbreviated first line', () => {
  const text = '结'.repeat(79) + ' 尾句';
  const message = { blocks: [{ type: 'text', text }] } as Parameters<typeof completionText>[1];
  assert.equal(completionText(120_000, message, 0), `✅ 本轮已完成（用时 2分00秒）· ${'结'.repeat(79)}…`);
});
