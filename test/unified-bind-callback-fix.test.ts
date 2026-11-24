import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {FeishuSdkPort,handleSdkCardCallback} from '../src/unified/feishu-sdk-port.js';
import {FeishuChannel} from '../src/unified/feishu-channel.js';
import {sessionCard} from '../src/unified/feishu-cards.js';
import {UnifiedCore} from '../src/unified/service.js';
import {RuntimeInteractive} from '../src/unified/runtime-interactive.js';
import {UnifiedStore} from '../src/unified/store.js';
import type {Session} from '../src/unified/contracts.js';

const event=(event_id:string,message:string,value:any):any=>({event_id,context:{open_message_id:message,open_chat_id:'chat'},operator:{open_id:'owner'},action:{tag:'button',value}});
function setup() {
  const dir=mkdtempSync(join(tmpdir(),'bind-callback-'));
  const sdk=new FeishuSdkPort({appId:'fake',appSecret:'fake'},join(dir,'sdk'),new Set(['chat']),'owner');
  let counter=0;
  const created:any[]=[];
  const replies:Array<{id:string;content:string}>=[];
  const patches:Array<{id:string;content:string}>=[];
  (sdk as any).client={im:{
    message:{
      create:async({data}:any)=>{
        created.push(data);
        return {data:{message_id:`m${++counter}`}};
      },
      reply:async({data}:any)=>{
        const id=`m${++counter}`;
        replies.push({id,content:data.content});
        return {data:{message_id:id}};
      },
      patch:async({path,data}:any)=>{
        patches.push({id:path.message_id,content:data.content});
        return {code:0};
      },
      get:async({path}:any)=>({code:0,data:{items:[
        {message_id:path.message_id,chat_id:'chat',message_position:'7',sender:{id:'fake',id_type:'app_id',sender_type:'app'}},
      ]}}),
    },
    file:{create:async()=>({file_key:'f'})},
  }};
  const store=new UnifiedStore(join(dir,'core'));
  const caps=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:'available'}]));
  const ref={provider:'claude' as const,hostId:'h',serviceId:'svc',nativeSessionId:'native'};
  const active={
    sessionId:'s',native:ref,title:'s',project:'/tmp',status:'idle',revision:1,capabilities:caps,
    control:{serviceId:'svc',owner:'owner',input:'available',generation:2,operationId:null,reason:null},
  } as Session;
  store.insertSession({...active,status:'read_only',control:{...active.control,generation:1,input:'unavailable',owner:null}});
  let reads=0;
  let observed=active;
  const inputs:string[]=[];
  const base:any={
    provider:'claude',
    onObservation:()=>()=>{},
    read:async()=>{
      reads++;
      return {session:observed,messages:[],interactions:[],connectionGeneration:1};
    },
    input:async(_ref:any,_mode:any,blocks:any[],guard:any)=>{
      guard.assertCurrent();
      inputs.push(blocks[0].text);
      return {nativeReference:'native-turn'};
    },
  };
  const core=new UnifiedCore(store,[base],()=>true);
  const channel=new FeishuChannel(core,sdk,async()=>true,join(dir,'channel'));
  const interactive=new RuntimeInteractive(core,store,channel);
  let auto=false;
  const e=(eventId:string,destination='chat')=>({eventId,destination,identity:{source:'feishu',subject:'owner'}});
  const click=(id:string,msg:string,value:any)=>handleSdkCardCallback(
    event(id,msg,value),'owner',new Set(['chat']),
    (chat,message)=>sdk.callbackDestination(chat,message),
    async(envelope,action)=>{
      const result=await channel.intake(envelope,action);
      if(auto)interactive.notifyInbox({kind:'channel',destination:envelope.destination});
      return result;
    },
  );
  const tick=async()=>{
    for(const id of channel.pendingInbox())await channel.drain(id);
    await core.dispatchPending();
    await channel.advanceCompleted();
  };
  return {
    sdk,store,core,channel,active,e,click,tick,created,replies,patches,interactive,inputs,
    channelPath:join(dir,'channel'),
    observe:(session:Session)=>{observed=session;},
    enableInteractive:()=>{auto=true;},
    reads:()=>reads,
    close:()=>{channel.close();core.close();store.close();sdk.close();rmSync(dir,{recursive:true,force:true});},
  };
}

test('unknown but valid card route gives guidance; internal failure gives safe toast',async()=>{const x=setup();try{const action={action:'bind',sessionId:'s',mode:'interactive'};const stale=await x.click('old','unregistered',action);assert.match(stale!.toast.content,/\/sessions/);assert.deepEqual(x.channel.pendingInbox(),[]);const message=await x.sdk.send('chat',sessionCard(x.active,'unbound'),'catalog');const bad=await handleSdkCardCallback(event('error',message,action),'owner',new Set(['chat']),(chat,id)=>x.sdk.callbackDestination(chat,id),async()=>{throw Error('secret-internal-db-error')});assert.match(bad!.toast.content,/未确认/);assert.doesNotMatch(bad!.toast.content,/secret|db/);assert.deepEqual(x.channel.pendingInbox(),[]);}finally{x.close()}});

test('a read-only panel callback patches the original card and immediately enables input', async () => {
  const x=setup();
  try {
    await x.channel.handle(x.e('sessions'),{action:'list'});
    const list=JSON.parse(x.created[0].content);
    const open=list.elements[1].actions.find((a:any)=>a.value?.action==='bind'&&a.value?.mode==='read_only').value;
    assert.equal(await x.click('view','m1',open),undefined);
    assert.deepEqual(x.channel.pendingInbox(),['card:view']);
    await x.tick();
    const [before]=x.channel.bindingsForRestore();
    assert.equal(before?.accessMode,'read_only');
    const destination=before!.destination;
    await x.channel.handle(x.e('panel',destination),{action:'panel'});
    const panel=x.replies.at(-1)!;
    const button=JSON.parse(panel.content).elements.flatMap((element:any)=>element.actions ?? [])
      .find((action:any)=>action.value?.action==='upgrade').value;
    const sentCount=x.replies.length;
    assert.equal(x.reads(),0);

    x.enableInteractive();
    assert.equal(await x.click('attach',panel.id,button),undefined);
    assert.deepEqual(x.channel.pendingInbox(destination),['card:attach']);
    await x.interactive.flushInteractive();
    const [after]=x.channel.bindingsForRestore();
    assert.equal(x.reads(),1);
    assert.equal(after?.accessMode,'interactive');
    assert.equal(after?.sessionId,'s');
    assert.equal(after?.revision,before!.revision+1);
    assert.notEqual(after?.bindingId,before?.bindingId);
    assert.equal(x.replies.length,sentCount);
    assert.equal(x.patches.length,1);
    assert.equal(x.patches[0]!.id,panel.id);
    assert.match(x.patches[0]!.content,/✅ 已接入，现在可直接发送消息续聊/);
    const patchedActions=JSON.parse(x.patches[0]!.content).elements.flatMap((element:any)=>element.actions ?? []);
    assert.deepEqual(patchedActions.map((action:any)=>action.value?.action),['history','panel','artifacts']);
    assert.ok(patchedActions.every((action:any)=>action.value?.bindingId===after?.bindingId));

    const unscoped=sessionCard(x.active,'unbound').actions.find(action=>action.value.mode==='interactive')!.value;
    const stale=await x.click('stale-unscoped',panel.id,unscoped);
    assert.match(stale!.toast.content,/未确认/);
    assert.equal(await x.click('attach',panel.id,button),undefined);
    await x.interactive.flushInteractive();
    assert.equal(x.reads(),1);
    assert.equal(x.patches.length,1);
    assert.equal(x.channel.bindingsForRestore()[0]?.bindingId,after?.bindingId);

    await x.channel.intake(x.e('next-message',destination),{action:'input',text:'continue here',mode:'new'});
    x.interactive.notifyInbox({kind:'channel',destination});
    await x.interactive.flushInteractive();
    assert.deepEqual(x.inputs,['continue here']);
    assert.equal(x.replies.length,sentCount);
  } finally { x.close(); }
});

test('interactive topic card retries attachment when the original control is unavailable', async () => {
  const x=setup();
  try {
    await x.channel.handle(x.e('attach'),{action:'bind',sessionId:'s',mode:'interactive'});
    await x.tick();
    const original=x.channel.bindingsForRestore()[0]!;
    assert.equal(original.accessMode,'interactive');

    const current=x.store.getSession('s');
    const unavailable:Session={
      ...current, revision:current.revision+1,
      control:{...current.control,input:'unavailable',owner:null},
    };
    x.store.updateSession(unavailable,current.revision,current.control.generation);
    x.observe(unavailable);
    const card=sessionCard(await x.core.getSession('s'),'interactive');
    assert.match(card.text,/会话已绑定但原端控制暂不可用/);
    assert.doesNotMatch(card.text,/现在可直接发送消息续聊/);
    assert.deepEqual(card.actions.find(action=>action.label==='重新接入')?.value,{action:'upgrade'});

    const sent=await x.sdk.send(original.destination,card,'disconnected-card');
    const upgrade={action:'upgrade',bindingId:original.bindingId};
    assert.equal(await x.click('retry-unavailable',sent,upgrade),undefined);
    await x.tick();
    assert.equal(x.reads(),2);
    assert.match(x.patches.at(-1)!.content,/接入未完成/);
    assert.doesNotMatch(x.patches.at(-1)!.content,/现在可直接发送消息续聊/);

    const readOnly:Session={...unavailable,status:'read_only',revision:unavailable.revision+1,
      control:{...unavailable.control,input:'available'}};
    x.store.updateSession(readOnly,unavailable.revision,unavailable.control.generation);
    x.observe({...x.active,control:{...x.active.control,generation:readOnly.control.generation+1}});
    const retryCard=sessionCard(await x.core.getSession('s'),'interactive');
    assert.match(retryCard.text,/会话已绑定但原端控制暂不可用/);
    const retry=await x.sdk.send(original.destination,retryCard,'retry-card');
    assert.equal(await x.click('retry-ready',retry,upgrade),undefined);
    await x.tick();
    assert.equal(x.reads(),3);
    assert.equal(x.patches.at(-1)!.id,retry);
    assert.match(x.patches.at(-1)!.content,/现在可直接发送消息续聊/);
    assert.doesNotMatch(x.patches.at(-1)!.content,/重新接入/);
    assert.equal(x.channel.bindingsForRestore()[0]?.bindingId,original.bindingId);
  } finally { x.close(); }
});

for (const method of ['send','patch'] as const) {
  test(`binding ${method} stays pending until an uncertain delivery is confirmed`, async () => {
    const x=setup();
    const db=new DatabaseSync(x.channelPath,{readOnly:true});
    try {
      if (method==='patch') {
        await x.channel.handle(x.e('bind'),{action:'bind',sessionId:'s',mode:'read_only'});
        const binding=x.channel.bindingsForRestore()[0]!;
        const card=await x.sdk.send(binding.destination,sessionCard(await x.core.getSession('s'),'read_only'),'read-only-card');
        await x.click('attach',card,{action:'upgrade',bindingId:binding.bindingId});
        await x.channel.drain('card:attach');
      } else {
        await x.channel.handle(x.e('attach'),{action:'bind',sessionId:'s',mode:'interactive'});
      }

      const sdkLookup=x.sdk.lookupDelivery.bind(x.sdk);
      let confirmed=false;
      let deliveryId='';
      let calls=0;
      x.sdk.lookupDelivery=async id=>confirmed ? sdkLookup(id) : 'unknown';
      if (method==='send') {
        const send=x.sdk.send.bind(x.sdk);
        x.sdk.send=async (...args)=>{
          const message=await send(...args);
          if (!args[2].includes(':topic-reply')) return message;
          deliveryId=args[2];
          calls++;
          throw new Error('lost delivery response');
        };
      } else {
        const update=x.sdk.update.bind(x.sdk);
        x.sdk.update=async (...args)=>{
          await update(...args);
          if (!args[3].includes(':topic-reply')) return;
          deliveryId=args[3];
          calls++;
          throw new Error('lost delivery response');
        };
      }

      const state=()=>db.prepare('SELECT state FROM channel_binding_deliveries WHERE delivery_id=?').get(deliveryId)?.state;
      await assert.rejects(x.channel.advanceCompleted(),/channel completion recovery failed/);
      assert.ok(deliveryId);
      assert.equal(state(),'pending');
      await x.channel.advanceCompleted();
      assert.equal(state(),'pending');
      assert.deepEqual(x.channel.pendingDeliveries().map(delivery=>({...delivery})),[{deliveryId,state:'unknown'}]);
      assert.equal(calls,1);

      confirmed=true;
      await x.channel.advanceCompleted();
      assert.equal(state(),'completed');
      assert.deepEqual(x.channel.pendingDeliveries(),[]);
      assert.equal(calls,1);
    } finally { db.close(); x.close(); }
  });
}

test('a recalled binding card retires both delivery records without another PATCH', async () => {
  const x = setup();
  const db = new DatabaseSync(x.channelPath, { readOnly: true });
  try {
    await x.channel.handle(x.e('bind'), { action: 'bind', sessionId: 's', mode: 'read_only' });
    const [binding] = x.channel.bindingsForRestore();
    const card = await x.sdk.send(binding!.destination, sessionCard(await x.core.getSession('s'), 'read_only'), 'read-only-card');
    await x.click('attach', card, { action: 'upgrade', bindingId: binding!.bindingId });
    await x.channel.drain('card:attach');
    let deliveryId = '';
    let attempts = 0;
    x.sdk.update = async (_destination, _message, _card, id) => {
      deliveryId = id;
      attempts++;
      throw Object.assign(new Error('Feishu API rejected request'), { platformCode: 230031 });
    };
    await x.channel.advanceCompleted();
    await x.channel.advanceCompleted();
    assert.equal(attempts, 1);
    for (const table of ['channel_binding_deliveries', 'channel_deliveries']) {
      assert.equal(db.prepare(`SELECT state FROM ${table} WHERE delivery_id=?`).get(deliveryId)?.state, 'expired');
    }
    assert.equal(await x.channel.reconcileDelivery(deliveryId), 'not_sent');
    assert.deepEqual(x.channel.pendingDeliveries(), []);
  } finally { db.close(); x.close(); }
});

test('readonly topic upgrades only on its own explicit callback, main panel cannot upgrade existing readonly topic',async()=>{const x=setup();try{const ro:any=await x.channel.handle(x.e('bind'),{action:'bind',sessionId:'s',mode:'read_only'});const root=ro.destination;const original=x.channel.bindingsForRestore()[0]!;const catalog=await x.sdk.send('chat',sessionCard(x.active,'unbound'),'catalog');const button=sessionCard(x.active,'unbound').actions.find(a=>a.value.mode==='interactive')!.value;await x.click('main',catalog,button);await x.tick();assert.equal(x.channel.bindingsForRestore()[0]?.accessMode,'read_only');assert.equal(x.channel.bindingsForRestore()[0]?.bindingId,original.bindingId);const card=await x.sdk.send(root,sessionCard(await x.core.getSession('s'),'read_only'),'ro-card');await x.click('upgrade',card,{...button,bindingId:original.bindingId});await x.tick();assert.equal(x.channel.bindingsForRestore()[0]?.accessMode,'interactive');assert.notEqual(x.channel.bindingsForRestore()[0]?.bindingId,original.bindingId);}finally{x.close()}});

test('session list sends one five-item card, keeps authorization and pagination',async()=>{const dir=mkdtempSync(join(tmpdir(),'session-list-'));const cards:any[]=[];const queries:any[]=[];const service:any={listSessions:async(q:any)=>{queries.push(q);const count=q.cursor?2:5;return {items:Array.from({length:count},(_,i)=>({sessionId:`internal-${i}`,native:{provider:'claude'},title:`Title ${i}`,project:`/project/${i}`,capabilities:{view:{status:'available'}}})),nextCursor:q.cursor?null:'cursor1'}}};const channel=new FeishuChannel(service,{send:async(_d,c)=>{cards.push(c);return 'm'},update:async()=>{},sendFile:async()=>{}},async(_i,_d,id)=>id!=='internal-2',join(dir,'channel'));const e=(eventId:string)=>({eventId,destination:'chat',identity:{source:'feishu',subject:'owner'}});try{await channel.handle(e('list'),{action:'list',search:'term'});assert.equal(cards.length,1);assert.equal(queries[0].limit,5);assert.equal(queries[0].search,'term');assert.equal(cards[0].actions.length,5);assert.ok(cards[0].actions.every((a:any)=>!a.label.includes('internal')));assert.doesNotMatch(cards[0].text,/Title 2/);const next=cards[0].actions.find((a:any)=>a.label==='下一页');await channel.handle(e('next'),next.value);assert.equal(cards.length,2);assert.equal(queries[1].cursor,'cursor1');assert.equal(queries[1].search,'term');assert.equal(cards[1].actions.length,2);}finally{channel.close();rmSync(dir,{recursive:true,force:true})}});

test('queued interactive callback expires after the topic is rebound',async()=>{const x=setup();try{x.store.insertSession({...x.active,sessionId:'other',native:{...x.active.native,nativeSessionId:'other'}});const ro:any=await x.channel.handle(x.e('bind'),{action:'bind',sessionId:'s',mode:'read_only'});const original=x.channel.bindingsForRestore()[0]!;const card=await x.sdk.send(ro.destination,sessionCard(await x.core.getSession('s'),'read_only'),'old-card');const button={...sessionCard(x.active,'unbound').actions.find(a=>a.value.mode==='interactive')!.value,bindingId:original.bindingId};await x.click('queued',card,button);await x.channel.handle(x.e('rebind',ro.destination),{action:'bind',sessionId:'other',mode:'read_only'});const result=await x.channel.drain('card:queued');assert.deepEqual(result,{status:'expired',reason:'binding_changed'});assert.equal(x.reads(),0);assert.equal(x.channel.bindingsForRestore()[0]?.sessionId,'other');}finally{x.close()}});
