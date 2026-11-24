import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedRuntime, validateRuntimeConfig, type RuntimeConfig } from '../src/unified/runtime.js';
import { parseFeishuText,parseFeishuAction } from '../src/unified/feishu-codec.js';
import type { Capabilities, Interaction, Session } from '../src/unified/contracts.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { runtimeApprovalScope } from '../src/unified/codex-approval.js';
import { evaluateApproval, resolveApprovalFacts } from '../src/unified/approval-policy.js';

async function bindInteractive(runtime:UnifiedRuntime, envelope:{eventId:string;destination:string;identity:{source:string;subject:string}}, sessionId:string) {
 await runtime.handleTrusted(envelope,{action:'bind',sessionId,mode:'interactive'}); await runtime.tick();
 assert.equal(runtime.channel.pendingOperations(envelope.destination).length,0);
}

const caps=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:'available'}])) as Capabilities;
for (const provider of ['claude','codex'] as const) test(`runtime simulated ${provider}: message and question answer`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'unified-runtime-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100};
  const sent:any[]=[];const deliveries=new Map<string,string>();const port={async send(_d:string,c:any,id:string){sent.push(c);const m=`m${sent.length}`;deliveries.set(id,m);return m;},async update(_d:string,_m:string,c:any){sent.push(c);},async sendFile(){},async lookupDelivery(id:string){return deliveries.has(id)?'sent' as const:'unknown' as const;},async lookupMessageId(id:string){return deliveries.get(id)??null;}};
  const writes:string[]=[];const native:any={provider,onObservation:()=>()=>{},async input(_r:any,_m:any,_b:any,g:any){g.assertCurrent();writes.push('input');return {status:'submitted',nativeReference:null};},async respond(_r:any,_i:any,_a:any,g:any){g.assertCurrent();writes.push('answer');return {status:'submitted',nativeReference:null};}};
  const runtime=new UnifiedRuntime(config,port,[native]);
  const s:Session={sessionId:'s',native:{provider,hostId:'h',serviceId:'v',nativeSessionId:'n'},project:'p',title:'demo',status:'idle',revision:0,capabilities:caps,control:{serviceId:'v',owner:'owner',input:'available',generation:1,operationId:null,reason:null}};
  const e=(id:string)=>({eventId:id,destination:'chat',identity:{source:'feishu',subject:'owner'}});
  try {runtime.store.insertSession(s);await assert.rejects(runtime.handleTrusted({...e('bad'),identity:{source:'feishu',subject:'impostor'}},parseFeishuText('/bind s')));await assert.rejects(runtime.handleTrusted({...e('bad2'),destination:'other'},parseFeishuText('/bind s')));
    await bindInteractive(runtime,e('bind'),'s');await runtime.handleTrusted(e('input'),parseFeishuText('hello'));await runtime.tick();assert.deepEqual(writes,['input']);
    const i:Interaction={kind:'question',interactionId:'i',sessionId:'s',turnId:'t',nativeRequestId:'nq',connectionGeneration:1,revision:0,status:'awaiting_answer',expiresAt:null,toolInputDigest:null,nativeResult:null,prompt:'choose',choices:['yes'],multiple:false,allowFreeText:false};runtime.store.setConnectionGeneration('s',0,1);runtime.store.insertInteraction(i);await runtime.tick();const form=sent.find(c=>c.form?.questions[0]?.prompt==='choose')?.form;
    assert.ok(form?.submittable);
    await runtime.handleTrusted(e('answer'),parseFeishuAction({action:'answer_form',interactionId:form.interactionId,bindingId:form.bindingId,revision:form.revision,connectionGeneration:form.connectionGeneration},{q0_choice:'0'}));await runtime.tick();assert.deepEqual(writes,['input','answer']);assert.equal(runtime.health().status,'healthy');
  } finally {await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
test('validation is read-only and rejects unsafe configuration',()=>{assert.throws(()=>validateRuntimeConfig({coreDb:'same',channelDb:'same',ownerOpenId:'',allowedDestinations:[],hostId:'',claudeServiceId:'',codexServiceId:'',claudeStateDir:'',codexEndpoint:'http://bad',intervalMs:0}));});

test('runtime approval configuration requires absolute roots and account home', () => {
  const config: RuntimeConfig = {
    coreDb: '/runtime/core', channelDb: '/runtime/channel', ownerOpenId: 'owner',
    allowedDestinations: ['chat'], hostId: 'h', claudeServiceId: 'c', codexServiceId: 'x',
    claudeStateDir: '/runtime/claude', codexEndpoint: 'ws://127.0.0.1:1234', intervalMs: 100,
  };
  validateRuntimeConfig(config);
  validateRuntimeConfig({ ...config, approvalPolicy: { enabled: false, extraTrustedRoots: ['/output'], extraWriteRoots: ['/explicit'], codexSharedFilesystem: false, homeDir: '/home/account' } });
  for (const approvalPolicy of [
    { homeDir: 'relative' }, { extraTrustedRoots: ['relative'] },
    { homeDir: '/home/account\0other' }, { extraTrustedRoots: [1] }, { enabled: 'false' },
    { extraWriteRoots: ['relative'] }, { codexSharedFilesystem: 'true' },
  ]) {
    assert.throws(() => validateRuntimeConfig({ ...config, approvalPolicy } as RuntimeConfig), /invalid (?:approval policy configuration|trusted roots)/);
  }
});

test('runtime discovery and output roots allow reference reads while writes require session scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-approval-roots-'));
  const project = join(dir, 'active'), sibling = join(dir, 'sibling'), externalOutput = join(dir, 'output');
  try {
    for (const path of [project, sibling, externalOutput]) mkdirSync(path);
    const config = runtimeFixtureConfig(dir);
    const scope = runtimeApprovalScope({ ...config, allowedProjectRoots: [dir], outputRoots: [externalOutput] });
    for (const [kind, path, expected] of [
      ['read', join(sibling, 'reference.ts'), 'allow_once'],
      ['read', join(externalOutput, 'output.txt'), 'allow_once'],
      ['write', join(sibling, 'source.ts'), 'ask'],
      ['write', join(externalOutput, 'output.txt'), 'ask'],
      ['write', join(project, 'output/output.txt'), 'allow_once'],
    ] as const) {
      assert.equal(evaluateApproval(await resolveApprovalFacts({ kind, paths: [path] }, { ...scope, project })).kind, expected, path);
    }
    const explicit = runtimeApprovalScope({ ...config, approvalPolicy: { extraWriteRoots: [externalOutput] } });
    assert.equal(evaluateApproval(await resolveApprovalFacts({ kind: 'write', paths: [join(externalOutput, 'output.txt')] }, { ...explicit, project })).kind, 'allow_once');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function runtimeFixtureConfig(dir: string): RuntimeConfig {
  return {
    coreDb: join(dir, 'core'), channelDb: join(dir, 'channel'), allowedDestinations: ['chat'], ownerOpenId: 'owner',
    hostId: 'h', claudeServiceId: 'c', codexServiceId: 'x', claudeStateDir: join(dir, 'claude'),
    codexEndpoint: 'ws://127.0.0.1:1234', intervalMs: 100,
  };
}

test('background reports a failed binding recovery after completing the remaining work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-binding-recovery-'));
  let refreshes = 0;
  const port = { async send() {}, async update() {}, async sendFile() {} };
  const runtime = new UnifiedRuntime(runtimeFixtureConfig(dir), port, [], { refresh: async () => { refreshes++; } });
  try {
    runtime.channel.advanceCompleted = async () => { throw new AggregateError([Error('old card PATCH failed')]); };
    await assert.rejects(runtime.tick(), /dispatch or synchronization failed/);
    assert.equal(refreshes, 1);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('durable intake dispatches input and approval during a blocked background refresh; restart recovers once', async () => {
  const dir=mkdtempSync(join(tmpdir(),'runtime-inbox-'));
  const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100};
  let holdRefresh=false;
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve=done; });
    return { promise, resolve };
  };
  const refreshEntered=deferred(), refreshRelease=deferred();
  const patchEntered=deferred(), patchRelease=deferred();
  const responseWritten=deferred();
  const sent=new Map<string,ChannelCard>(), patches=new Map<string,ChannelCard>();
  const port={
    async send(_destination:string,card:ChannelCard) { const id='message-'+sent.size; sent.set(id,card); return id; },
    async update(_destination:string,messageId:string,card:ChannelCard) {
      patches.set(messageId,card);
      if (holdRefresh && card.text.includes('等待原端确认')) {
        patchEntered.resolve();
        await patchRelease.promise;
      }
    },
    async sendFile() {},
  };
  const writes:string[]=[];
  const native:any={
    provider:'claude',onObservation:()=>()=>{},
    async input(_ref:any,_mode:any,blocks:any,g:any) {
      g.assertCurrent(); writes.push(blocks[0].text);
      return {status:'submitted',nativeReference:null};
    },
    async respond(_ref:any,_interaction:any,_answer:any,g:any) {
      g.assertCurrent(); writes.push('answer'); responseWritten.resolve();
      return {status:'submitted',nativeReference:null};
    },
  };
  const session:Session={sessionId:'s',native:{provider:'claude',hostId:'h',serviceId:'v',nativeSessionId:'n'},project:dir,title:'demo',status:'idle',revision:0,capabilities:caps,control:{serviceId:'v',owner:'owner',input:'available',generation:1,operationId:null,reason:null}};
  const e=(id:string)=>({eventId:id,destination:'chat',identity:{source:'feishu',subject:'owner'}});
  let runtime=new UnifiedRuntime(config,port,[native],{refresh:async()=>{
    if (holdRefresh) { refreshEntered.resolve(); await refreshRelease.promise; }
  }});
  try {
    runtime.store.insertSession(session);
    await bindInteractive(runtime,e('bind'),'s');
    runtime.store.insertInteraction({
      interactionId:'approve',sessionId:'s',turnId:'t',nativeRequestId:'request',connectionGeneration:0,revision:0,
      status:'awaiting_answer',expiresAt:null,nativeResult:null,kind:'approval',tool:'Bash',action:'sudo true',
      scope:'once',toolInputDigest:'tool',
    });
    await runtime.tick();
    const card=[...sent].find(([,value])=>value.actions.some(button=>button.value.action==='answer'));
    assert.ok(card);
    const [cardMessageId,approvalCard]=card;

    holdRefresh=true;
    const background=runtime.tick();
    await refreshEntered.promise;
    await runtime.handleTrusted(e('one'),{action:'input',mode:'new',text:'one'});
    // A direct foreground barrier runs while the background tick still waits in refresh.
    await runtime.flushInteractive();
    assert.deepEqual(writes,['one']);
    const inputOp=runtime.channel.operationForEvent('one')!;
    assert.equal(runtime.store.getOperation(inputOp.operationId).status,'accepted');

    await runtime.handleTrusted({...e('answer'),cardMessageId},parseFeishuAction(approvalCard.actions[0]!.value));
    const deadline=AbortSignal.timeout(2_000);
    await new Promise<void>((resolve,reject)=>{
      deadline.addEventListener('abort',()=>reject(new Error('foreground approval or card PATCH stalled')), {once:true});
      void Promise.all([patchEntered.promise,responseWritten.promise]).then(()=>resolve());
    });
    assert.equal(patches.get(cardMessageId)?.actions.length,0);
    assert.match(patches.get(cardMessageId)?.text ?? '',/已提交.*等待原端确认/);
    const answerOp=runtime.channel.operationForEvent('answer')!;
    assert.equal(runtime.store.getOutbox(answerOp.operationId).state,'done');
    assert.equal(runtime.store.getOperation(answerOp.operationId).status,'accepted');
    assert.deepEqual(writes,['one','answer']);

    patchRelease.resolve(); refreshRelease.resolve();
    await background;
    // Model a process stopping after the inbox commit and before it notified the scheduler.
    await runtime.channel.intake(e('two'),{action:'input',mode:'new',text:'two'});
    await runtime.close();
    runtime=new UnifiedRuntime(config,port,[native]);
    assert.deepEqual(runtime.channel.pendingInbox(),['two']);
    await runtime.tick();
    await runtime.handleTrusted(e('two'),{action:'input',mode:'new',text:'two'});
    await runtime.tick();
    assert.deepEqual(writes,['one','answer','two']);
  } finally {
    patchRelease.resolve(); refreshRelease.resolve();
    await runtime.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('SDK image event downloads bounded verified bytes and stages them through channel to core',async()=>{
  const {receiveSdkMessage,MAX_INBOUND_BYTES}=await import('../src/unified/feishu-sdk-port.js');const {Readable}=await import('node:stream');
  const dir=mkdtempSync(join(tmpdir(),'runtime-image-')); const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100};
  const port={async send(){return 'm';},async update(){},async sendFile(){}};let input:any;const native:any={provider:'claude',onObservation:()=>()=>{},async input(_r:any,_m:any,b:any,g:any){g.assertCurrent();input=b;}};
  const r=new UnifiedRuntime(config,port,[native]); const s:Session={sessionId:'s',native:{provider:'claude',hostId:'h',serviceId:'v',nativeSessionId:'n'},project:'p',title:'demo',status:'idle',revision:0,capabilities:caps,control:{serviceId:'v',owner:'owner',input:'available',generation:1,operationId:null,reason:null}};
  const envelope={eventId:'bind',destination:'chat',identity:{source:'feishu',subject:'owner'}}; const data:any={sender:{sender_type:'user',sender_id:{open_id:'owner'}},message:{message_id:'image-id',chat_id:'chat',chat_type:'p2p',message_type:'image',content:JSON.stringify({image_key:'img-key'})}};
  const png=Buffer.from([137,80,78,71,13,10,26,10,1,2]); let downloads=0;const download=async(id:string,key:string,type:string)=>{assert.equal(id,'image-id');assert.equal(key,'img-key');assert.equal(type,'image');downloads++;return Readable.from([png]);};
  try {r.store.insertSession(s);await bindInteractive(r,envelope,'s');
    await assert.rejects(receiveSdkMessage({...data,sender:{sender_type:'user',sender_id:{open_id:'other'}}},'bot','owner',new Set(['chat']),download,(e,a)=>r.handleTrusted(e,a)));assert.equal(downloads,0);
    await receiveSdkMessage(data,'bot','owner',new Set(['chat']),download,(e,a)=>r.handleTrusted(e,a));await r.tick();assert.equal(r.channel.pendingOperations('chat').length,0);assert.equal(input[0].mediaType,'image/png');assert.deepEqual(Buffer.from(input[0].content),png);
    await assert.rejects(receiveSdkMessage(data,'bot','owner',new Set(['chat']),async()=>Readable.from([Buffer.alloc(MAX_INBOUND_BYTES+1)]),async()=>{}),/exceeds limit/);
    await assert.rejects(receiveSdkMessage(data,'bot','owner',new Set(['chat']),async()=>Readable.from([Buffer.from('not image')]),async()=>{}),/unsupported resource/);
  } finally {await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('Codex adapter rejects unauthorised artifact before transport write',async()=>{
  const {CodexAdapter}=await import('../src/unified/codex-adapter.js');const {CodexTransport}=await import('../src/unified/codex-transport.js');const transport=new CodexTransport('ws://127.0.0.1:1234');const adapter=new CodexAdapter(transport,'h','v');let guarded=false;
  await assert.rejects(adapter.input({provider:'codex',hostId:'h',serviceId:'v',nativeSessionId:'n'},'new',[{type:'artifact',artifactId:'i',contentVersion:'1',name:'i',mediaType:'image/png',content:new Uint8Array([1])}],{expectedControlGeneration:0,expectedConnectionGeneration:null,assertCurrent(){guarded=true;}}),(e:any)=>e.code==='invalid_request' || e.code==='control_conflict');assert.equal(guarded,false);
});

test('Claude close terminates SDK query and settles pending question',async()=>{
  const {ClaudeAdapter}=await import('../src/unified/claude-adapter.js');const dir=mkdtempSync(join(tmpdir(),'runtime-claude-close-'));let options:any;let closed=false;let wake:(()=>void)|undefined;
  const query:any={async *[Symbol.asyncIterator](){while(!closed)await new Promise<void>(r=>{wake=r;});},close(){closed=true;wake?.();}};
  const sdk:any={query:(arg:any)=>{options=arg.options;return query;},listSessions:async()=>[],getSessionMessages:async()=>[]};const adapter=new ClaudeAdapter('h','v',join(dir,'state'),sdk);const observed:any[]=[];adapter.onObservation(o=>observed.push(o));
  try {await adapter.create('/tmp',null);const answer=options.canUseTool('AskUserQuestion',{questions:[{question:'Why?',options:[],multiSelect:false}]},{signal:new AbortController().signal,toolUseID:'q'});await adapter.close();assert.equal((await answer).behavior,'deny');assert.equal(observed.at(-1).interaction.status,'expired');await assert.rejects(adapter.create('/tmp',null));assert.equal(closed,true);await adapter.close();} finally {await adapter.close();rmSync(dir,{recursive:true,force:true});}
});

test('SDK resource receipt persists before download and resumes after restart without duplicate input',async()=>{
  const {FeishuSdkPort,receiveSdkMessage}=await import('../src/unified/feishu-sdk-port.js');const {Readable}=await import('node:stream');const dir=mkdtempSync(join(tmpdir(),'runtime-resource-'));const db=join(dir,'sdk');const png=Buffer.from([137,80,78,71,13,10,26,10]);let port=new FeishuSdkPort({appId:'test',appSecret:'test'},db,new Set(['chat']),'owner');let downloads=0;const received=new Map<string,string>();
  const event:any={sender:{sender_type:'user',sender_id:{open_id:'owner'}},message:{message_id:'id',chat_id:'chat',chat_type:'p2p',message_type:'image',content:'{"image_key":"key"}'}};
  const ingest=async(e:any,a:any)=>{const old=received.get(e.eventId);const value=JSON.stringify({...a,content:Array.from(a.content)});if(old && old!==value)throw Error('conflict');received.set(e.eventId,value);};
  try {await receiveSdkMessage(event,'bot','owner',new Set(['chat']),async()=>{throw Error('must not download on intake');},ingest,(e,id,key,type)=>(port as any).queueResource(e,id,key,type,'scope'));assert.equal(downloads,0);port.close();port=new FeishuSdkPort({appId:'test',appSecret:'test'},db,new Set(['chat']),'owner');
    (port as any).client.im.messageResource.get=async()=>{downloads++;return {getReadableStream:()=>Readable.from([png])};};await port.drainInbound(ingest);await port.drainInbound(ingest);assert.equal(downloads,1);assert.equal(received.size,1);
  } finally {port.close();rmSync(dir,{recursive:true,force:true});}
});

test('bad resource and transient failure do not block later intake, retry state survives restart',async()=>{
  const {FeishuSdkPort,receiveSdkMessage}=await import('../src/unified/feishu-sdk-port.js');const {Readable}=await import('node:stream');const {DatabaseSync}=await import('node:sqlite');const dir=mkdtempSync(join(tmpdir(),'runtime-deadletter-'));const sdkDb=join(dir,'sdk');const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100};
  let port=new FeishuSdkPort({appId:'test',appSecret:'test'},sdkDb,new Set(['chat']),'owner');const event=(id:string):any=>({sender:{sender_type:'user',sender_id:{open_id:'owner'}},message:{message_id:id,chat_id:'chat',chat_type:'p2p',message_type:'file',content:JSON.stringify({file_key:id})}});let attempts=0;
  const install=()=>{(port as any).client.im.messageResource.get=async({path}:any)=>{if(path.file_key==='temporary'){attempts++;throw Error('temporary');}return {getReadableStream:()=>Readable.from([Buffer.from('unsupported')])};};(port as any).client.im.message.create=async()=>({code:0,data:{message_id:'m'}});};install();
  const enqueue=async(id:string)=>receiveSdkMessage(event(id),'bot','owner',new Set(['chat']),async()=>{throw Error('unexpected');},async()=>{},(e,id,key,type)=>(port as any).queueResource(e,id,key,type,'scope'));
  let r=new UnifiedRuntime(config,port,[]);const e={eventId:'text',destination:'chat',identity:{source:'feishu',subject:'owner'}};
  try {await enqueue('invalid');await enqueue('temporary');await r.handleTrusted(e,{action:'health'});await r.tick();assert.deepEqual(r.channel.pendingInbox(),[]);assert.deepEqual(port.resourceIssues().map(x=>x.state),['rejected','retry']);assert.equal(r.health().status,'degraded');await r.close();port.close();
    port=new FeishuSdkPort({appId:'test',appSecret:'test'},sdkDb,new Set(['chat']),'owner');install();r=new UnifiedRuntime(config,port,[]);assert.deepEqual(port.resourceIssues().map(x=>x.state),['rejected','retry']);
    const db=new DatabaseSync(sdkDb);for(let i=0;i<2;i++){db.exec("UPDATE sdk_resource_failures SET next_attempt=0 WHERE state='retry'");await r.tick();}db.close();assert.equal(attempts,3);assert.deepEqual(port.resourceIssues().map(x=>x.state),['rejected','needs_review']);await r.tick();assert.equal(attempts,3);
  }finally{await r.close();port.close();rmSync(dir,{recursive:true,force:true});}
});

test('close fences new work, shares completion, and waits for active tick and intake',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runtime-close-race-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100};const port={async send(){return 'm';},async update(){},async sendFile(){}};const r=new UnifiedRuntime(config,port,[]);let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve});let completed=false;
  r.core.dispatchPending=async()=>{await hold;r.channel.pendingInbox();};const running=r.tick();const first=r.close();const second=r.close();assert.equal(first,second);void first.then(()=>{completed=true;});
  await assert.rejects(r.tick(),/closed/);await assert.rejects(r.handleTrusted({eventId:'x',destination:'chat',identity:{source:'feishu',subject:'owner'}},{action:'health'}),/closed/);await new Promise<void>(done=>setImmediate(done));assert.equal(completed,false);release();await running;await first;assert.equal(completed,true);rmSync(dir,{recursive:true,force:true});
});

test('channel database is single-active and lock releases on close and process death',async()=>{
  const {spawn}=await import('node:child_process');
  const {closeSync,openSync,readFileSync}=await import('node:fs');
  const {setTimeout:delay}=await import('node:timers/promises');
  const dir=mkdtempSync(join(tmpdir(),'runtime-lock-'));
  const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100};
  const port={async send(){return 'm';},async update(){},async sendFile(){}};
  let first=new UnifiedRuntime(config,port,[]);
  try {
    assert.throws(()=>new UnifiedRuntime({...config,coreDb:join(dir,'other')},port,[]),/already active/);
    await first.close();
    first=new UnifiedRuntime(config,port,[]);
    await first.close();
    const source=`import {UnifiedRuntime} from './src/unified/runtime.ts'; import {writeSync} from 'node:fs'; const c=${JSON.stringify(config)};new UnifiedRuntime(c,{async send(){return 'm'},async update(){},async sendFile(){}},[]);writeSync(1,'ready');setInterval(()=>{},1000);`;
    const output=join(dir,'worker-ready');
    const fd=openSync(output,'w');
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{cwd:process.cwd(),stdio:['ignore',fd,'inherit']});
    closeSync(fd);
    const exited=new Promise<void>((resolve,reject)=>{
      child.once('error',reject);
      child.once('exit',()=>resolve());
    });
    try {
      const ready=async()=>{
        const deadline=Date.now()+10_000;
        while (readFileSync(output,'utf8')!=='ready') {
          if (Date.now()>=deadline) throw new Error('lock worker did not report readiness');
          await delay(20);
        }
      };
      await Promise.race([ready(),exited.then(()=>{throw new Error('lock worker exited before readiness');})]);
      assert.throws(()=>new UnifiedRuntime({...config,coreDb:join(dir,'other')},port,[]),/already active/);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    first=new UnifiedRuntime(config,port,[]);
  } finally {
    await first.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('deferred image cannot cross destination rebind',async()=>{
  const {FeishuSdkPort}=await import('../src/unified/feishu-sdk-port.js');const {Readable}=await import('node:stream');const dir=mkdtempSync(join(tmpdir(),'resource-scope-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100};const port=new FeishuSdkPort({appId:'test',appSecret:'test'},join(dir,'sdk'),new Set(['chat']),'owner');(port as any).createTopic=undefined;(port as any).client.im.message.create=async()=>({code:0,data:{message_id:'m'}});(port as any).client.im.messageResource.get=async()=>({getReadableStream:()=>Readable.from([Buffer.from([137,80,78,71,13,10,26,10])])});const r=new UnifiedRuntime(config,port,[{provider:'claude',onObservation:()=>()=>{}} as any]);const e=(id:string)=>({eventId:id,destination:'chat',identity:{source:'feishu',subject:'owner'}});const s=(id:string):Session=>({sessionId:id,native:{provider:'claude',hostId:'h',serviceId:'v',nativeSessionId:id},project:'p',title:id,status:'idle',revision:0,capabilities:caps,control:{serviceId:'v',owner:'owner',input:'available',generation:1,operationId:null,reason:null}});
  try {r.store.insertSession(s('one'));r.store.insertSession(s('two'));await bindInteractive(r,e('bind1'),'one');const scope=await r.captureResourceScope(e('image'));(port as any).queueResource(e('image'),'image','key','image',scope);await r.handleTrusted(e('bind2'),{action:'bind',sessionId:'two'});
    // Apply the rebind first to model a deferred download after a change of target.
    await r.channel.drain('bind2');await r.tick();assert.equal(r.channel.pendingOperations('chat').length,0);assert.equal(port.resourceIssues().length,1);assert.equal((await r.core.health()).find(x=>x.component==='runtime')?.status,'degraded');
  }finally{await r.close();port.close();rmSync(dir,{recursive:true,force:true});}
});

test('close waits for authenticated intake already in progress',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'intake-close-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100};const port={async send(){return 'm';},async update(){},async sendFile(){}};const r=new UnifiedRuntime(config,port,[]);let release!:()=>void;const gate=new Promise<void>(x=>{release=x;});const original=r.channel.intake.bind(r.channel);r.channel.intake=async(...args)=>{await gate;return original(...args);};let done=false;
  try {const intake=r.handleTrusted({eventId:'h',destination:'chat',identity:{source:'feishu',subject:'owner'}},{action:'health'});const closing=r.close();void closing.then(()=>{done=true;});await new Promise<void>(x=>setImmediate(x));assert.equal(done,false);release();await intake;await closing;assert.equal(done,true);}finally{release();await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('integrated SDK channel discovers both providers, attaches history and sends scoped artifacts',async()=>{
  const {createIntegratedRuntime}=await import('../src/unified/runtime.js');const {FeishuSdkPort,receiveSdkMessage}=await import('../src/unified/feishu-sdk-port.js');const {mkdirSync,writeFileSync}=await import('node:fs');
  const dir=mkdtempSync(join(tmpdir(),'integrated-catalog-'));const project=join(dir,'project'),logsC=join(dir,'claude-logs'),logsX=join(dir,'codex-logs');for(const x of [project,logsC,logsX])mkdirSync(x);const path=join(project,'result.txt');writeFileSync(path,'fixture output');
  const text=`result [file](${path})`;writeFileSync(join(logsC,'cl-native.jsonl'),[JSON.stringify({type:'user',uuid:'c1',cwd:project,message:{content:'hello claude'}}),JSON.stringify({type:'assistant',uuid:'c2',message:{content:[{type:'text',text}]}})].join('\n')+'\n');
  writeFileSync(join(logsX,'codex.jsonl'),[JSON.stringify({type:'session_meta',payload:{id:'cx-native',cwd:project}}),JSON.stringify({type:'response_item',timestamp:'2026-01-01',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}})].join('\n')+'\n');
  const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'artifacts.json'),ownerOpenId:'owner',allowedDestinations:['chat-c','chat-x'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100,catalogSources:[{provider:'claude' as const,directory:logsC,hostId:'h',serviceId:'c'},{provider:'codex' as const,directory:logsX,hostId:'h',serviceId:'x'}],allowedProjectRoots:[project],outputRoots:[project]};
  const port=new FeishuSdkPort({appId:'test',appSecret:'test'},join(dir,'sdk'),new Set(config.allowedDestinations),'owner');(port as any).createTopic=undefined;const cards:any[]=[];const files:Buffer[]=[];(port as any).client.im.message.create=async({data}:any)=>{cards.push(data);return {code:0,data:{message_id:`m${cards.length}`}};};(port as any).client.im.file.create=async({data}:any)=>{files.push(data.file);return {file_key:'fixture-key'};};
  const base=(provider:'claude'|'codex'):any=>({provider,onObservation:()=>()=>{},list:async()=>({items:[],nextCursor:null})});const runtime=await createIntegratedRuntime(config,port,[base('claude'),base('codex')]);
  const message=async(chat:string,id:string,text:string)=>{const data:any={sender:{sender_type:'user',sender_id:{open_id:'owner'}},message:{message_id:id,chat_id:chat,chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}};await receiveSdkMessage(data,'bot','owner',new Set(config.allowedDestinations),async()=>{throw Error('unexpected download');},(e,a)=>runtime.handleTrusted(e,a));await runtime.tick();};
  try {await message('chat-c','list','/list');const found=await runtime.core.listSessions({limit:10});assert.equal(found.items.length,2);assert.ok(found.items.every(s=>s.status==='read_only'));
    for(const [chat,provider,service,native] of [['chat-c','claude','c','cl-native'],['chat-x','codex','x','cx-native']] as const){
      await message(chat,`attach-${provider}`,`/attach ${provider} h ${service} ${native} read_only`);assert.equal(runtime.channel.pendingOperations(chat).length,0);await message(chat,`history-${provider}`,'/history');assert.ok(cards.some(x=>x.receive_id===chat && x.content.includes('result')));
      await message(chat,`files-${provider}`,'/files');const latest=[...cards].reverse().find(x=>x.receive_id===chat && x.content.includes('result.txt'));assert.ok(latest);const card=JSON.parse(latest.content);const value=card.elements.flatMap((x:any)=>x.actions??[]).map((x:any)=>x.value).find((x:any)=>x.action==='file');assert.ok(value);await runtime.handleTrusted({eventId:`download-${provider}`,destination:chat,identity:{source:'feishu',subject:'owner'}},parseFeishuAction(value));await runtime.tick();
    }assert.equal(files.length,2);assert.ok(files.every(f=>f.toString()==='fixture output'));assert.equal((await runtime.core.listSessions({limit:10})).items.length,2);
  }finally{await runtime.close();port.close();rmSync(dir,{recursive:true,force:true});}
});

test('empty discovery roots deny discovery and shared artifact state is single-active',async()=>{
  const {createIntegratedRuntime}=await import('../src/unified/runtime.js');const dir=mkdtempSync(join(tmpdir(),'integration-lock-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'artifacts'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100,catalogSources:[],allowedProjectRoots:[],outputRoots:[]};const port={async send(){return 'm';},async update(){},async sendFile(){}};const base:any={provider:'claude',onObservation:()=>()=>{},list:async()=>({items:[{sessionId:'x',native:{provider:'claude',hostId:'h',serviceId:'c',nativeSessionId:'n'},project:dir,title:'x',status:'idle',revision:0,capabilities:caps,control:{serviceId:'c',owner:null,input:'available',generation:1,operationId:null,reason:null}}],nextCursor:null})};const r=await createIntegratedRuntime(config,port,[base]);
  try {assert.equal((await r.core.listSessions({limit:10})).items.length,0);await assert.rejects(createIntegratedRuntime({...config,coreDb:join(dir,'other-core'),channelDb:join(dir,'other-channel')},port,[base]),/artifact state already active/);}finally{await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('revoked project root prevents existing bound-session reads after restart',async()=>{
  const {createIntegratedRuntime}=await import('../src/unified/runtime.js');const {mkdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'integration-revoke-'));const project=join(dir,'p'),logs=join(dir,'logs');mkdirSync(project);mkdirSync(logs);const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'artifacts'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100,catalogSources:[{provider:'claude' as const,directory:logs,hostId:'h',serviceId:'c'}],allowedProjectRoots:[project],outputRoots:[project]};const sent:any[]=[];const port={async send(_d:string,c:any){sent.push(c);return 'm';},async update(){},async sendFile(){}};const base:any={provider:'claude',onObservation:()=>()=>{},list:async()=>({items:[],nextCursor:null})};let r=await createIntegratedRuntime(config,port,[base]);const e=(eventId:string)=>({eventId,destination:'chat',identity:{source:'feishu',subject:'owner'}});const session:Session={sessionId:'s',native:{provider:'claude',hostId:'h',serviceId:'c',nativeSessionId:'n'},project,title:'private title',status:'read_only',revision:0,capabilities:caps,control:{serviceId:'c',owner:null,input:'unavailable',generation:0,operationId:null,reason:null}};
  try {r.store.insertSession(session);await r.handleTrusted(e('bind'),{action:'bind',sessionId:'s'});await r.channel.drain('bind');await r.close();r=await createIntegratedRuntime({...config,allowedProjectRoots:[],outputRoots:[]},port,[base]);sent.length=0;await assert.rejects(r.handleTrusted(e('list'),{action:'list'}),/unauthorized/);assert.equal(sent.length,0);await assert.rejects(r.handleTrusted(e('history'),{action:'history'}),/unauthorized/);
  }finally{await r.close();rmSync(dir,{recursive:true,force:true});}
});

for(const provider of ['claude','codex'] as const) test(`${provider} creation verifies canonical project, namespace and acknowledgement`,async()=>{
  const {createIntegratedRuntime}=await import('../src/unified/runtime.js');const {mkdirSync,symlinkSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'creation-scope-'));const project=join(dir,'p'),other=join(dir,'other'),outside=join(dir,'outside'),logs=join(dir,'logs'),alias=join(dir,'alias');for(const path of [project,other,outside,logs])mkdirSync(path);symlinkSync(project,alias);
  const service=provider==='claude'?'c':'x';const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'artifacts'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100,catalogSources:[{provider,directory:logs,hostId:'h',serviceId:service}],allowedProjectRoots:[alias,other],outputRoots:[project]};
  let mode='outside',calls=0;const make=(id:string):Session=>({sessionId:id,native:{provider,hostId:'h',serviceId:service,nativeSessionId:id},project:alias,title:'test',status:'idle',revision:0,capabilities:caps,control:{serviceId:service,owner:'owner',input:'available',generation:1,operationId:null,reason:null}});
  const base:any={provider,onObservation:()=>()=>{},list:async()=>({items:[],nextCursor:null}),create:async()=>{calls++;const s=make(`native-${calls}`);if(mode==='outside')s.project=outside;if(mode==='other')s.project=other;if(mode==='host')s.native.hostId='foreign';if(mode==='service')s.native.serviceId='foreign';if(mode==='provider')s.native.provider=provider==='claude'?'codex':'claude';return {status:'submitted',nativeReference:mode==='mismatch'?'wrong':s.native.nativeSessionId,...(mode==='missing'?{}:{createdSession:s}),connectionGeneration:1};}};
  const port={async send(){return 'm';},async update(){},async sendFile(){}};const r=await createIntegratedRuntime(config,port,[base]);const context=(id:string)=>({targetId:'new:chat',operationId:id,idempotencyKey:id,expectedRevision:0,controlGeneration:0,identity:{source:'feishu',subject:'owner'}});
  try {for(mode of ['outside','other','host','service','provider','mismatch','missing']){const id=`bad-${mode}`;await r.core.createSession({context:context(id),payload:{provider,project,model:null}});assert.equal((await r.core.dispatch(id)).status,'unknown');assert.equal(r.store.listSessions().length,0);const n=calls;await r.core.dispatchPending();assert.equal(calls,n);}
    mode='valid';await r.core.createSession({context:context('valid'),payload:{provider,project,model:null}});assert.equal((await r.core.dispatch('valid')).status,'completed');assert.equal(r.store.listSessions().length,1);assert.equal(r.store.listSessions()[0]!.project,alias);
  } finally {await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('provider read, list and observations cannot change pinned namespace or project',async()=>{
  const {createIntegratedRuntime}=await import('../src/unified/runtime.js');const {mkdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'read-scope-'));const project=join(dir,'project'),other=join(dir,'other'),logs=join(dir,'logs');for(const p of [project,other,logs])mkdirSync(p);const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'state'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'claude'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100,catalogSources:[{provider:'claude' as const,directory:logs,hostId:'h',serviceId:'c'}],allowedProjectRoots:[project,other],outputRoots:[project,other]};
  const s:Session={sessionId:'native',native:{provider:'claude',hostId:'h',serviceId:'c',nativeSessionId:'n'},project,title:'safe',status:'idle',revision:0,capabilities:caps,control:{serviceId:'c',owner:'owner',input:'available',generation:1,operationId:null,reason:null}};let listener:(x:any)=>void=()=>{};let corrupt=false;
  const base:any={provider:'claude',onObservation:(f:any)=>{listener=f;return()=>{};},list:async()=>({items:[s,{...s,native:{...s.native,hostId:'foreign'}}],nextCursor:null}),read:async()=>({session:corrupt?{...s,project:other}:s,messages:[],interactions:[]})};const port={async send(){return 'm';},async update(){},async sendFile(){}};const r=await createIntegratedRuntime(config,port,[base]);
  try {const page=await r.core.listSessions({limit:10});assert.equal(page.items.length,1);const ctx={targetId:'new:chat',operationId:'attach',idempotencyKey:'attach',expectedRevision:0,controlGeneration:0,identity:{source:'feishu',subject:'owner'}};corrupt=true;await assert.rejects(r.core.attachSession({context:ctx,payload:{...s.native,mode:'read_only'}}));assert.equal(r.store.listSessions().length,1);assert.equal(r.store.listSessions()[0]!.project,project);assert.equal(r.store.listSessions()[0]!.status,'read_only');
    corrupt=false;await r.core.attachSession({context:ctx,payload:{...s.native,mode:'read_only'}});const session=r.store.listSessions()[0]!;listener({type:'session',ref:s.native,session:{...s,project:other}});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(r.store.getSession(session.sessionId).project,project);assert.equal((await r.core.health()).find(x=>x.component==='runtime')?.status,'healthy');await assert.rejects(r.tick());assert.equal(r.health().status,'degraded');
  }finally{await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('scoped enrichment forwards persisted connection and control generation seeds',async()=>{
  const {createIntegratedRuntime}=await import('../src/unified/runtime.js');const {mkdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'scoped-seed-'));const project=join(dir,'p'),logs=join(dir,'logs');mkdirSync(project);mkdirSync(logs);const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'state'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'claude'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100,catalogSources:[{provider:'codex' as const,directory:logs,hostId:'h',serviceId:'x'}],allowedProjectRoots:[project],outputRoots:[project]};
  const session:Session={sessionId:'s',native:{provider:'codex',hostId:'h',serviceId:'x',nativeSessionId:'n'},project,title:'test',status:'idle',revision:0,capabilities:caps,control:{serviceId:'x',owner:null,input:'available',generation:7,operationId:null,reason:null}};const seeds:number[]=[];const control:number[]=[];const base:any={provider:'codex',onObservation:()=>()=>{},seedConnectionGeneration:(n:number)=>seeds.push(n),seedControlGeneration:(_ref:any,n:number)=>control.push(n),list:async()=>({items:[session],nextCursor:null}),read:async()=>({session,messages:[],interactions:[],connectionGeneration:10}),resume:async()=>({status:'submitted',nativeReference:'n',connectionGeneration:10})};const port={async send(){return 'm';},async update(){},async sendFile(){}};let r=await createIntegratedRuntime(config,port,[base]);
  try {r.store.insertSession(session);r.store.setConnectionGeneration('s',0,9);await r.close();r=await createIntegratedRuntime(config,port,[base]);assert.equal(seeds.at(-1),9);const persistedGeneration=r.store.getSession('s').control.generation;assert.ok(persistedGeneration>=7);const context={targetId:'new:chat',operationId:'attach',idempotencyKey:'attach',expectedRevision:0,controlGeneration:0,identity:{source:'feishu',subject:'owner'}};await r.core.attachSession({context,payload:{...session.native,mode:'interactive'}}).catch(()=>{});assert.deepEqual(control,[persistedGeneration]);}finally{await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime authorizes trusted topic routes and synchronizes bound routes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runtime-topic-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['parent'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100};const topic='topic:fixture';const port={authorizedDestination:(d:string)=>d==='parent'||d===topic,async send(){return 'm';},async update(){},async sendFile(){}};const r=new UnifiedRuntime(config,port,[]);const s:Session={sessionId:'s',native:{provider:'claude',hostId:'h',serviceId:'c',nativeSessionId:'n'},project:'p',title:'demo',status:'idle',revision:0,capabilities:caps,control:{serviceId:'c',owner:'owner',input:'available',generation:1,operationId:null,reason:null}};const e=(destination:string,eventId:string)=>({eventId,destination,identity:{source:'feishu',subject:'owner'}});const synced:string[]=[];const original=r.channel.sync.bind(r.channel);r.channel.sync=async d=>{synced.push(d);return original(d);};
  try {r.store.insertSession(s);await assert.rejects(r.handleTrusted(e('topic:forged','bad'),{action:'bind',sessionId:'s'}),/unauthorized/);await r.handleTrusted(e(topic,'bind'),{action:'bind',sessionId:'s'});await r.tick();assert.ok(synced.includes(topic));await r.handleTrusted(e(topic,'history'),{action:'history'});await r.tick();}finally{await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('early provider observations wait for verified create and mapped session',async()=>{
  const {createIntegratedRuntime}=await import('../src/unified/runtime.js');const {mkdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'early-observation-'));const project=join(dir,'p'),other=join(dir,'other'),logs=join(dir,'logs');for(const p of [project,other,logs])mkdirSync(p);const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'state'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'claude'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100,catalogSources:[{provider:'claude' as const,directory:logs,hostId:'h',serviceId:'c'}],allowedProjectRoots:[project],outputRoots:[project]};const s:Session={sessionId:'n',native:{provider:'claude',hostId:'h',serviceId:'c',nativeSessionId:'n'},project,title:'test',status:'idle',revision:0,capabilities:caps,control:{serviceId:'c',owner:null,input:'available',generation:0,operationId:null,reason:null}};let emit:(o:any)=>void=()=>{};let called=0;
  const base:any={provider:'claude',onObservation:(f:any)=>{emit=f;return()=>{};},list:async()=>({items:[],nextCursor:null}),create:async()=>{called++;emit({type:'session',ref:s.native,session:s});emit({type:'message',ref:s.native,message:{messageId:'early',sessionId:'n',turnId:'t',role:'assistant',blocks:[{type:'text',text:'early reply'}],sequence:1,revision:1,final:true,source:'fixture'}});return {status:'submitted',nativeReference:'n',createdSession:s,connectionGeneration:1};}};const port={async send(){return 'm';},async update(){},async sendFile(){}};const r=await createIntegratedRuntime(config,port,[base]);
  try {const context={targetId:'new:chat',operationId:'create',idempotencyKey:'create',expectedRevision:0,controlGeneration:0,identity:{source:'feishu',subject:'owner'}};await r.core.createSession({context,payload:{provider:'claude',project,model:null}});await r.tick();assert.equal(called,1);const session=r.store.listSessions()[0]!;assert.equal((await r.core.readHistory(session.sessionId,{limit:10})).items[0]?.messageId,'early');assert.equal(r.health().status,'healthy');}finally{await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('early observation from rejected create is discarded without delivery',async()=>{
  const {createIntegratedRuntime}=await import('../src/unified/runtime.js');const {mkdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'bad-early-'));const project=join(dir,'p'),other=join(dir,'other'),logs=join(dir,'logs');for(const p of [project,other,logs])mkdirSync(p);const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'state'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'claude'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100,catalogSources:[{provider:'claude' as const,directory:logs,hostId:'h',serviceId:'c'}],allowedProjectRoots:[project],outputRoots:[project]};const s:Session={sessionId:'native',native:{provider:'claude',hostId:'h',serviceId:'c',nativeSessionId:'n'},project:other,title:'bad',status:'idle',revision:0,capabilities:caps,control:{serviceId:'c',owner:null,input:'available',generation:0,operationId:null,reason:null}};let emit:(o:any)=>void=()=>{};let sends=0;
  const base:any={provider:'claude',onObservation:(f:any)=>{emit=f;return()=>{};},list:async()=>({items:[],nextCursor:null}),create:async()=>{emit({type:'message',ref:s.native,message:{messageId:'unsafe',sessionId:'native',turnId:'t',role:'assistant',blocks:[{type:'text',text:'outside'}],sequence:1,revision:1,final:true,source:'fixture'}});return {status:'submitted',nativeReference:'n',createdSession:s,connectionGeneration:1};}};const port={async send(){sends++;return 'm';},async update(){},async sendFile(){}};const r=await createIntegratedRuntime(config,port,[base]);
  try {const context={targetId:'new:chat',operationId:'bad',idempotencyKey:'bad',expectedRevision:0,controlGeneration:0,identity:{source:'feishu',subject:'owner'}};await r.core.createSession({context,payload:{provider:'claude',project,model:null}});assert.equal((await r.core.dispatch('bad')).status,'unknown');await assert.rejects(r.tick());assert.equal(r.store.listSessions().length,0);assert.equal(sends,0);}finally{await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('foreign catalog namespace fails configuration before provider access',async()=>{
  const {createIntegratedRuntime}=await import('../src/unified/runtime.js');const {mkdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'foreign-catalog-'));const project=join(dir,'p'),logs=join(dir,'logs');mkdirSync(project);mkdirSync(logs);const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'state'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'claude'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100,catalogSources:[] as Array<{provider:'claude'|'codex';directory:string;hostId:string;serviceId:string}>,allowedProjectRoots:[project],outputRoots:[project]};let reads=0;const base=(provider:'claude'|'codex'):any=>({provider,onObservation:()=>()=>{},list:async()=>{reads++;return {items:[],nextCursor:null};},read:async()=>{reads++;throw Error('unexpected');}});const port={async send(){return 'm';},async update(){},async sendFile(){}};
  try {for(const [provider,hostId,serviceId] of [['claude','foreign','c'],['claude','h','foreign'],['codex','foreign','x'],['codex','h','foreign'],['codex','h','c']] as const){const candidate={...config,catalogSources:[{provider,directory:logs,hostId,serviceId}]};assert.throws(()=>validateRuntimeConfig(candidate),/catalog source namespace/);await assert.rejects(createIntegratedRuntime(candidate,port,[base(provider)]),/catalog source namespace/);assert.equal(reads,0);}for(const [provider,serviceId] of [['claude','c'],['codex','x']] as const)validateRuntimeConfig({...config,catalogSources:[{provider,directory:logs,hostId:'h',serviceId}]});}
  finally {rmSync(dir,{recursive:true,force:true});}
});

test('read-only rejection is durable and does not starve later authorized work',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'readonly-reject-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['a','b'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://127.0.0.1:1234',intervalMs:100};
 const sent:Array<{d:string;title:string}>=[];let writes=0;const port={async send(d:string,c:any){sent.push({d,title:c.title});return 'm';},async update(){},async sendFile(){}};const native:any={provider:'codex',onObservation:()=>()=>{},async input(){writes++;}};
 const session=(id:string):Session=>({sessionId:id,native:{provider:'codex',hostId:'h',serviceId:'x',nativeSessionId:id},project:'p',title:id,status:'idle',revision:0,capabilities:caps,control:{serviceId:'x',owner:'owner',input:'available',generation:1,operationId:null,reason:null}});
 const e=(eventId:string,destination='a')=>({eventId,destination,identity:{source:'feishu',subject:'owner'}});let r=new UnifiedRuntime(config,port,[native]);
 try {r.store.insertSession(session('s'));r.store.insertSession(session('t'));await r.handleTrusted(e('bind-a'),{action:'bind',sessionId:'s'});await r.handleTrusted(e('bind-b','b'),{action:'bind',sessionId:'t'});await r.tick();
  const bad={action:'input',mode:'new',text:'forbidden'} as const;await r.handleTrusted(e('bad'),bad);await r.handleTrusted(e('later'),{action:'history'});await r.handleTrusted(e('other','b'),{action:'history'});await r.tick();
  assert.deepEqual(r.channel.pendingInbox(),[]);assert.equal(writes,0);assert.ok(sent.some(x=>x.title==='操作未执行'));assert.equal(sent.filter(x=>x.title==='会话历史').length,2);assert.equal(r.health().status,'healthy');
  await r.close();r=new UnifiedRuntime(config,port,[native]);await r.handleTrusted(e('bad'),bad);await r.handleTrusted(e('after-restart'),{action:'history'});await r.tick();assert.deepEqual(r.channel.pendingInbox(),[]);assert.equal(writes,0);assert.equal(sent.filter(x=>x.title==='操作未执行').length,1);assert.equal(sent.filter(x=>x.title==='会话历史').length,3);
 }finally{await r.close();rmSync(dir,{recursive:true,force:true});}
});

for (const provider of ['claude', 'codex', 'agy'] as const) {
  test(`${provider} tool-only progress wakes only its topic, then preserves the completed card and schema`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const { ToolProgressTracker } = await import('../src/unified/tool-progress.js');
    const { encodeCard } = await import('../src/unified/feishu-card-wire.js');
    const dir = mkdtempSync(join(tmpdir(), 'runtime-tool-progress-'));
    const sent: Array<{ destination: string; id: string; card: ChannelCard }> = [];
    const patches: Array<{ destination: string; id: string; card: ChannelCard }> = [];
    const pushed: string[] = [];
    let dispatches = 0;
    let uploads = 0;
    const port = {
      async send(destination: string, card: ChannelCard) {
        const id = `m${sent.length + 1}`;
        sent.push({ destination, id, card });
        return id;
      },
      async update(destination: string, id: string, card: ChannelCard) { patches.push({ destination, id, card }); },
      async sendText(_destination: string, text: string) { pushed.push(text); },
      async sendFile() { uploads++; },
    };
    const native: any = { provider, onObservation: () => () => {}, input: async () => { dispatches++; } };
    const runtime = new UnifiedRuntime({ ...runtimeFixtureConfig(dir), allowedDestinations: ['chat', 'other'] }, port, [native]);
    const ref = { provider, hostId: 'h', serviceId: 'v', nativeSessionId: 'native' };
    const session: Session = { sessionId: 's', native: ref, project: dir, title: 'progress', status: 'idle', revision: 0,
      capabilities: caps, control: { serviceId: 'v', owner: 'owner', input: 'available', generation: 1, operationId: null, reason: null } };
    const bind = (destination: string, sessionId: string) => runtime.channel.handle({
      eventId: `bind-${destination}`, destination, identity: { source: 'feishu', subject: 'owner' },
    }, { action: 'bind', sessionId });
    try {
      runtime.store.insertSession(session);
      runtime.store.insertSession({ ...session, sessionId: 'other', native: { ...ref, nativeSessionId: 'other-native' } });
      await bind('chat', 's');
      await bind('other', 'other');
      await runtime.channel.sync('chat');
      await runtime.channel.sync('other');
      await runtime.core.observe({ type: 'connection', ref, connectionGeneration: 1 });
      await runtime.flushInteractive();
      sent.length = 0;
      const turns = { turnId: 't', sessionId: 'native', inputId: null, model: null, outputIds: [],
        startedAt: new Date().toISOString(), endedAt: null };
      await runtime.core.observe({ type: 'turn', ref, connectionGeneration: 1, turn: { ...turns, status: 'running' } });
      await runtime.flushInteractive();
      assert.equal(sent.length, 0);
      const subscriptions: string[] = [];
      const subscribe = runtime.core.subscribeEvents.bind(runtime.core);
      runtime.core.subscribeEvents = async (id, ...args) => { subscriptions.push(id); return subscribe(id, ...args); };
      const tracker = new ToolProgressTracker();
      const tool = (callId: string, phase: 'running' | 'succeeded' | 'failed') => tracker.observe(ref, 1, 't', callId, phase,
        { tool: 'Bash', summary: 'Bash · pytest' })!;
      await runtime.core.observe(tool('1', 'running'));
      await runtime.flushInteractive();
      const first = sent[0]!;
      assert.equal(first.destination, 'chat');
      assert.equal(first.card.template, 'blue');
      assert.equal(first.card.text, '正在处理…');
      assert.equal(first.card.schema, '2.0');
      assert.match(first.card.executionLog!.runningNote!, /Bash · pytest/);
      const wire = encodeCard(first.card) as { schema: string; body: { elements: Array<Record<string, unknown>> } };
      assert.equal(wire.schema, '2.0');
      const panel = wire.body.elements.find(element => element.tag === 'collapsible_panel');
      assert.equal(panel?.expanded, false);
      assert.match(JSON.stringify(panel), /执行记录（1 项）/);
      assert.deepEqual((await runtime.core.getSnapshot('s')).value.messages, []);
      assert.deepEqual(subscriptions, ['s']);
      await runtime.core.observe(tool('2', 'running'));
      await runtime.core.observe(tool('1', 'succeeded'));
      await runtime.flushInteractive();
      assert.equal(patches.length, 0);
      t.mock.timers.tick(1499);
      await runtime.flushInteractive();
      assert.equal(patches.length, 0);
      t.mock.timers.tick(1);
      await runtime.flushInteractive();
      assert.equal(patches.length, 1);
      assert.deepEqual(patches[0]!.card.executionLog!.lines, ['✓ Bash · pytest', '⏳ Bash · pytest']);
      t.mock.timers.tick(13_500);
      await runtime.flushInteractive();
      assert.match(patches.at(-1)!.card.title, /用时 15秒/);
      await runtime.core.observe(tool('2', 'failed'));
      await runtime.core.observe({ type: 'turn', ref, connectionGeneration: 1,
        turn: { ...turns, status: 'completed', startedAt: null, endedAt: new Date().toISOString() } });
      await runtime.flushInteractive();
      t.mock.timers.tick(1500);
      await runtime.flushInteractive();
      assert.equal(patches.at(-1)!.card.template, 'green');
      assert.equal(patches.at(-1)!.card.executionLog!.failedCount, 1);
      assert.ok(patches.every(patch => patch.destination === 'chat' && patch.id === first.id && patch.card.schema === '2.0'));
      assert.equal(sent.length, 1);
      assert.equal(dispatches + uploads + pushed.length, 0);
      const after = patches.length;
      const reads = subscriptions.length;
      t.mock.timers.tick(30_000);
      await runtime.flushInteractive();
      assert.equal(patches.length, after);
      assert.equal(subscriptions.length, reads, 'completion removes the heartbeat');
      await runtime.close();
      t.mock.timers.tick(30_000);
      assert.equal(subscriptions.length, reads);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('runtime coalesces assistant deltas per session and drains the tail without delaying final observations', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'runtime-delta-wake-'));
  const port = { async send() { return 'm'; }, async update() {}, async sendFile() {} };
  const native: any = { provider: 'codex', onObservation: () => () => {} };
  const runtime = new UnifiedRuntime({ ...runtimeFixtureConfig(dir), allowedDestinations: ['chat', 'other'] }, port, [native]);
  const ref = { provider: 'codex' as const, hostId: 'h', serviceId: 'v', nativeSessionId: 'n' };
  const otherRef = { ...ref, nativeSessionId: 'other-native' };
  const session: Session = { sessionId: 's', native: ref, project: dir, title: 'stream', status: 'idle', revision: 0,
    capabilities: caps, control: { serviceId: 'v', owner: 'owner', input: 'available', generation: 1, operationId: null, reason: null } };
  const updates: string[] = [];
  const otherUpdates: string[] = [];
  const nextImmediate = () => new Promise<void>(resolve => setImmediate(resolve));
  const turn = { turnId: 't', sessionId: 'n', inputId: null, model: null, outputIds: [], startedAt: null, endedAt: null };
  const message = (revision: number, final = false, messageId = 'reply', target = ref) => runtime.core.observe({
    type: 'message', ref: target, connectionGeneration: 1, message: { messageId, sessionId: target.nativeSessionId, turnId: 't',
      role: 'assistant', blocks: [{ type: 'text', text: String(revision) }], sequence: 1, revision, final, source: 'codex' } });
  try {
    runtime.store.insertSession(session);
    runtime.store.insertSession({ ...session, sessionId: 'other', native: otherRef });
    for (const [destination, sessionId] of [['chat', session.sessionId], ['other', 'other']] as const) {
      await runtime.channel.handle({ eventId: `bind-${destination}`, destination, identity: { source: 'feishu', subject: 'owner' } },
        { action: 'bind', sessionId });
    }
    await runtime.core.observe({ type: 'connection', ref, connectionGeneration: 1 });
    await runtime.core.observe({ type: 'connection', ref: otherRef, connectionGeneration: 1 });
    await runtime.flushInteractive();
    runtime.channel.sync = async destination => {
      const snapshot = (await runtime.core.getSnapshot(destination === 'chat' ? 's' : 'other')).value;
      const message = snapshot.messages.at(-1);
      const block = message?.blocks[0];
      const status = snapshot.turns?.[0]?.status;
      const received = destination === 'chat' ? updates : otherUpdates;
      received.push(`${block?.type === 'text' ? block.text : ''}${message?.final ? ' final' : ''}${status ? ` ${status}` : ''}`);
    };
    await message(1);
    await nextImmediate();
    assert.deepEqual(updates, ['1']);
    for (let revision = 2; revision <= 10; revision++) {
      await message(revision);
      await nextImmediate();
    }
    await message(1, false, 'other-reply', otherRef);
    await nextImmediate();
    assert.deepEqual(otherUpdates, ['1']);
    t.mock.timers.tick(349);
    await nextImmediate();
    assert.deepEqual(updates, ['1']);
    t.mock.timers.tick(1);
    await nextImmediate();
    assert.deepEqual(updates, ['1', '10']);

    await message(11);
    await runtime.core.observe({ type: 'turn', ref, connectionGeneration: 1,
      turn: { ...turn, status: 'completed', endedAt: new Date().toISOString() } });
    await nextImmediate();
    assert.deepEqual(updates, ['1', '10', '11 completed']);
    await message(12);
    await nextImmediate();
    await message(13);
    await message(14, true);
    await nextImmediate();
    assert.deepEqual(updates, ['1', '10', '11 completed', '12 completed', '14 final completed']);
    t.mock.timers.tick(350);
    await nextImmediate();
    assert.equal(updates.length, 5, 'urgent wakes consume queued deltas');

    await message(15, false, 'next-reply');
    await nextImmediate();
    await message(16, false, 'next-reply');
    await runtime.flushInteractive();
    assert.equal(updates.at(-1), '16 completed');
    await message(17, false, 'next-reply');
    await runtime.close();
    assert.equal(updates.at(-1), '17 completed');
    const afterClose = updates.length;
    t.mock.timers.tick(350);
    await nextImmediate();
    assert.equal(updates.length, afterClose);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
