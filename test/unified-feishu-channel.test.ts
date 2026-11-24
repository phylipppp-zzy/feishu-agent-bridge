import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';
import type { UnifiedService } from '../src/unified/adapter.js';
import type { Interaction, Session, WriteContext } from '../src/unified/contracts.js';
import { interactionCard } from '../src/unified/feishu-cards.js';

// Establish an interactive fixture through the channel's authorized attach/finish path.
async function interactiveBinding(channel:FeishuChannel, service:UnifiedService, env:{eventId:string;destination:string;identity:{source:string;subject:string}}, sessionId:string) {
 const fake=service as any; const oldAttach=fake.attachSession, oldGet=fake.getOperation; const operations=new Map<string,unknown>();
 fake.attachSession=async ({context}:any)=>{const op={operationId:context.operationId,targetId:context.targetId,action:'attachSession',status:'completed',error:null,result:{kind:'session',sessionId}};operations.set(op.operationId,op);return op;};
 fake.getOperation=async (id:string)=>operations.get(id);
 try {
  await channel.handle(env,{action:'bind',sessionId,mode:'read_only'});
  const op=await channel.handle({...env,eventId:`${env.eventId}:upgrade`},{action:'upgrade'}) as {operationId:string};
  await channel.handle({...env,eventId:`${env.eventId}:finish`},{action:'finish',operationId:op.operationId});
 } finally {fake.attachSession=oldAttach;fake.getOperation=oldGet;}
}

for (const provider of ['claude', 'codex'] as const) test(`${provider}: same entry, trusted identity, duplicate input and old answer`, async () => {
 const dir = mkdtempSync(join(tmpdir(),'channel-')); let submissions = 0; let resolutions = 0; const cards: unknown[] = [];
 const session = {sessionId:'s',native:{provider,hostId:'h',serviceId:'svc',nativeSessionId:'native'},project:'p',title:'session',status:'idle',revision:2,control:{input:'available',generation:3}} as unknown as Session;
 const operation = (context: {operationId:string; idempotencyKey:string;targetId:string}) => ({...context,action:'input',payloadDigest:'d',status:'received',revision:0,error:null});
 const service = {
   getSession: async () => session,
   listSessions: async () => ({items:[session],nextCursor:null}),
   submitInput: async ({context}: {context:WriteContext}) => { submissions++; assert.equal(context.identity?.subject, 'trusted'); return operation(context); },
   getInteraction: async () => ({sessionId:'s',status:'resolved'}),
   resolveInteraction: async () => { resolutions++; throw new Error('interaction_expired'); },
 } as unknown as UnifiedService;
 const port: FeishuPort = {send:async (_d,c) => {cards.push(c); return 'message';},update:async () => {},sendFile:async () => {}};
 const auth = async (i: {subject:string}) => i.subject === 'trusted';
 const channel = new FeishuChannel(service,port,auth,join(dir,'channel.sqlite'));
 const env = (eventId: string) => ({eventId,destination:'topic',identity:{source:'verified',subject:'trusted'}});
 try {
  await channel.handle(env('list'),{action:'list'});
  await interactiveBinding(channel,service,env('bind'),'s');
  const action = {action:'input',text:'hello',mode:'new'} as const;
  const first = await channel.handle(env('msg'),action); assert.deepEqual(await channel.handle(env('msg'),action),first); assert.equal(submissions,1);
  await assert.rejects(channel.handle(env('msg'),{...action,text:'changed'}),/idempotency conflict/);
  await assert.rejects(channel.handle({...env('bad'),identity:{source:'verified',subject:'other'}},action),/unauthorized/);
  await assert.rejects(channel.handle(env('answer'),{action:'answer',interactionId:'i',revision:1,connectionGeneration:1,answer:{kind:'question',values:['x']},toolInputDigest:null}),/interaction_expired/);
  assert.deepEqual(await channel.handle(env('answer'),{action:'answer',interactionId:'i',revision:1,connectionGeneration:1,answer:{kind:'question',values:['x']},toolInputDigest:null}),{status:'unknown'}); assert.equal(resolutions,1);
  await channel.handle(env('unbind'),{action:'unbind'}); await assert.rejects(channel.handle(env('after'),action),/not bound/);
  assert.ok(cards.length >= 2);
 } finally {channel.close();rmSync(dir,{recursive:true,force:true});}
});

test('Feishu card and message codec preserves actionable answer without trusting identity', async () => {
 const {parseFeishuAction,parseFeishuText,toFeishuCard} = await import('../src/unified/feishu-codec.js');
 const card = interactionCard({interactionId:'i',sessionId:'s',turnId:'t',nativeRequestId:'n',connectionGeneration:2,revision:3,status:'awaiting_answer',expiresAt:null,toolInputDigest:'digest',nativeResult:null,kind:'approval',tool:'test',action:'write',scope:'test-only'});
 const json = toFeishuCard(card) as {elements:Array<{actions?:Array<{value:unknown}>}>};
 const answer = parseFeishuAction({...json.elements[1]!.actions![1]!.value as object,bindingId:'test-binding'});
 assert.equal(answer.action,'answer'); if (answer.action === 'answer' && answer.answer.kind === 'approval') assert.equal(answer.answer.decision,'deny');
 assert.deepEqual(parseFeishuText('/queue hello'),{action:'input',text:'hello',mode:'queue'});
 assert.throws(() => parseFeishuAction({action:'answer',identity:{subject:'spoof'}}),/invalid/);
});

for (const [tool, action, target] of [
 ['Bash', '需要人工确认\n{"input":{"command":"pwd","untrusted":"hidden"},"blockedPath":"/tmp/check"}', 'pwd\n/tmp/check'],
 ['file_change', '{"changes":[{"path":"check.txt","diff":"hidden"}],"grantRoot":"/tmp"}', '/tmp\ncheck.txt'],
 ['run_command', '{"rawInput":{"CommandLine":"git status","untrusted":"hidden"},"locations":[{"path":"/tmp/check"}]}', 'git status\n/tmp/check'],
 ['Read', 'plain.txt<at id="all">hidden</at>', 'plain.txt'],
] as const) test(`approval displays the permitted fields for ${tool}`, () => {
 const request: Extract<Interaction, {kind:'approval'}> = {
  interactionId:'i',sessionId:'s',turnId:'t',nativeRequestId:'n',connectionGeneration:2,revision:3,
  status:'awaiting_answer',expiresAt:null,toolInputDigest:'digest',nativeResult:null,kind:'approval',tool,action,scope:'session',
 };
 const card = interactionCard(request);
 assert.match(card.title, /^⚠️ 需人工确认 · /u);
 assert.equal(card.template, 'orange');
 assert.ok(card.text.includes('\n```\n' + target + '\n```\n'));
 assert.match(card.text, /\*\*生效范围\*\*：本会话内同类操作/u);
 assert.doesNotMatch(card.text, /hidden|awaiting_answer|<at/u);
 assert.deepEqual(card.actions.map(button => button.label), ['允许本次', '拒绝']);
 const unavailable = interactionCard({...request,allowedDecisions:[]});
 assert.deepEqual(unavailable.actions, []);
 assert.match(unavailable.text, /请在原端处理/u);
 const confirmed = interactionCard({...request,status:'resolved',nativeResult:{status:'accepted',source:'fixture',answer:{kind:'approval',decision:'allow',scope:'session'}}});
 assert.equal(confirmed.title, '审批 · 已确认');
 assert.equal(confirmed.template, 'green');
 const denied = interactionCard({...request,status:'resolved',nativeResult:{status:'accepted',source:'fixture',answer:{kind:'approval',decision:'deny',scope:'session'}}});
 assert.equal(denied.title, '审批 · 已拒绝');
 assert.equal(denied.template, 'grey');
});

test('sync rechecks authorization, resumes cursor after reopen, and removes answered actions', async () => {
 const dir = mkdtempSync(join(tmpdir(),'channel-sync-')); const db = join(dir,'c.sqlite'); let allowed = true; let revision = 1; let sent = 0; const updates: Array<{actions:unknown[]}> = [];
 const session = {sessionId:'s',native:{provider:'codex'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}} as unknown as Session;
 const interaction = () => ({interactionId:'i',sessionId:'s',turnId:'t',nativeRequestId:'n',connectionGeneration:1,revision,status:revision === 1 ? 'awaiting_answer' : 'resolved',expiresAt:null,toolInputDigest:null,nativeResult:null,kind:'question',prompt:'choose',choices:['yes'],multiple:false,allowFreeText:false});
 const service = {getSession:async()=>session,getInteraction:async()=>interaction(),getSnapshot:async()=>({cursor:'c1',value:{session,interactions:[interaction()],messages:[]}}),subscribeEvents:async()=>({status:'events',cursor:'c2',events:[{eventId:'e1',objectId:'i',type:'interaction.changed'}]})} as unknown as UnifiedService;
 const port:FeishuPort = {send:async()=>{sent++;return 'message-id';},update:async(_d,_id,c)=>{updates.push(c);},sendFile:async()=>{}};
 const auth = async()=>allowed; const env = {eventId:'bind',destination:'topic',identity:{source:'verified',subject:'owner'}};
 let channel = new FeishuChannel(service,port,auth,db);
 try {
   await channel.handle(env,{action:'bind',sessionId:'s'}); await channel.sync('topic'); assert.equal(sent,2);
   channel.close(); channel = new FeishuChannel(service,port,auth,db); revision=2; allowed=false;
   await assert.rejects(channel.sync('topic'),/unauthorized/); assert.equal(updates.length,0);
   allowed=true; await channel.sync('topic'); assert.equal(updates.length,1); assert.equal(updates[0]!.actions.length,0);
   await channel.sync('topic'); assert.equal(updates.length,1);
 } finally {channel.close();rmSync(dir,{recursive:true,force:true});}
});

test('notification pause consumes events quietly across reopen', async () => {
 const dir=mkdtempSync(join(tmpdir(),'channel-pause-')); const db=join(dir,'db'); let eventReads=0; let sends=0;
 const session={sessionId:'s',native:{provider:'claude'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}} as unknown as Session;
 const service={getSession:async()=>session,getSnapshot:async()=>({cursor:'c1',value:{session,interactions:[],messages:[]}}),subscribeEvents:async()=>{eventReads++;return {status:'events',cursor:'c2',events:[{eventId:'e',objectId:'o',type:'done'}]};},setNotificationSubscription:async({context}: {context:WriteContext})=>({...context,action:'notify',payloadDigest:'d',status:'completed',revision:1,error:null})} as unknown as UnifiedService;
 const port:FeishuPort={send:async()=>{sends++;return 'id';},update:async()=>{},sendFile:async()=>{}};
 const env=(eventId:string)=>({eventId,destination:'topic',identity:{source:'v',subject:'owner'}}); let channel=new FeishuChannel(service,port,async()=>true,db);
 try {await channel.handle(env('bind'),{action:'bind',sessionId:'s'});await channel.sync('topic'); await channel.handle(env('pause'),{action:'notifications',enabled:false,eventTypes:['done'],revision:1,controlGeneration:1}); channel.close(); channel=new FeishuChannel(service,port,async()=>true,db); await channel.sync('topic'); assert.equal(eventReads,1); await channel.handle(env('resume'),{action:'notifications',enabled:true,eventTypes:['done'],revision:1,controlGeneration:1}); const before=sends; await channel.sync('topic'); assert.equal(eventReads,2); assert.equal(sends,before);} finally {channel.close();rmSync(dir,{recursive:true,force:true});}
});

test('expired cursor recovers new finals without exporting initial history', async () => {
 const dir=mkdtempSync(join(tmpdir(),'channel-expiry-')); let generation=0; const texts:string[]=[];
 const session={sessionId:'s',native:{provider:'codex'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}} as unknown as Session;
 const msg=(id:string)=>({messageId:id,sessionId:'s',role:'assistant',revision:1,final:true,blocks:[{type:'text',text:id}]});
 const service={getSession:async()=>session,getSnapshot:async()=>({cursor:generation ? 'new' : 'old',value:{session,interactions:[],messages:generation ? [msg('old'),msg('new')] : [msg('old')]}}),subscribeEvents:async()=>({status:'snapshot_required',error:{}})} as unknown as UnifiedService;
 const port:FeishuPort={send:async(_d,c)=>{texts.push(c.text);return 'id';},update:async()=>{},sendFile:async()=>{}};
 const channel=new FeishuChannel(service,port,async()=>true,join(dir,'db'));
 try {await channel.handle({eventId:'b',destination:'t',identity:{source:'v',subject:'u'}},{action:'bind',sessionId:'s'});await channel.sync('t');assert.ok(!texts.includes('old'));generation=1;await channel.sync('t');assert.ok(texts.includes('new'));assert.ok(!texts.includes('old'));} finally {channel.close();rmSync(dir,{recursive:true,force:true});}
});

for (const provider of ['claude','codex'] as const) test(`${provider}: generated controls round trip and owner management`, async () => {
 const {parseFeishuAction,parseFeishuText,toFeishuCard}=await import('../src/unified/feishu-codec.js');
 const dir=mkdtempSync(join(tmpdir(),'channel-controls-')); const cards:import('../src/unified/feishu-cards.js').ChannelCard[]=[]; const calls:string[]=[];
 const session={sessionId:'s',native:{provider},title:'t',project:'p',status:'idle',revision:1,capabilities:{interrupt:{status:'available'},queue:{status:'available'},handoff:{status:'available'}},control:{input:'available',generation:1}} as unknown as Session;
 const makeOp=(name:string)=>(request:{context:WriteContext})=>{calls.push(name);return Promise.resolve({...request.context,action:name,status:'completed',revision:1,error:null,payloadDigest:'d'});};
 const service={getSession:async()=>session,eventWatermark:()=>0,getWorkState:async()=>({runningTurns:[{turnId:'turn'}],queuedInputs:[{inputId:'queue'}],canArchive:true}),interruptTurn:makeOp('stop'),cancelQueuedInput:makeOp('cancel'),requestControl:makeOp('control'),releaseControl:makeOp('release'),archiveSession:makeOp('archive'),updateSessionSettings:makeOp('settings'),attachSession:makeOp('attach'),listModels:async()=>({items:[{id:'m',label:'Model'}],nextCursor:null})} as unknown as UnifiedService;
 const port:FeishuPort={send:async(_d,c)=>{cards.push(c);return 'id';},update:async()=>{},sendFile:async()=>{}};
 const channel=new FeishuChannel(service,port,async()=>true,join(dir,'db')); const env=(eventId:string,subject='owner')=>({eventId,destination:'d',identity:{source:'v',subject}});
 try {
  await interactiveBinding(channel,service,env('b'),'s');
  await channel.handle(env('p'),parseFeishuText('/panel turn queue'));
  const panel=cards.at(-1)!;
  assert.match(panel.text,/通知：开启（完成：开 · 等待：开 · 失败：开）/);
  assert.doesNotMatch(panel.text,/当前不支持|旧版/);
  const json=toFeishuCard(panel) as {elements:Array<{actions?:Array<{value:unknown}>}>};
  for (const [i,button] of json.elements[1]!.actions!.entries()) await channel.handle(env(`a${i}`),parseFeishuAction(button.value));
  assert.deepEqual(calls.slice(0,6),['archive','archive','control','release','stop','cancel']);
  await channel.handle(env('models'),{action:'models'}); const model=toFeishuCard(cards.at(-1)!) as {elements:Array<{actions?:Array<{value:unknown}>}>}; await channel.handle(env('model-choice'),parseFeishuAction(model.elements[1]!.actions![0]!.value));
  await assert.rejects(channel.handle(env('attach'),parseFeishuText(`/attach ${provider} host service native interactive`)),/use upgrade/); assert.ok(calls.includes('settings'));
  await assert.rejects(channel.handle(env('other','other'),{action:'unbind'}),/binding management unauthorized/);
  await assert.rejects(channel.handle(env('other2','other'),{action:'bind',sessionId:'s'}),/binding management unauthorized/);
 } finally {channel.close();rmSync(dir,{recursive:true,force:true});}
});

test('durable intake returns before core execution and survives restart', async () => {
 const dir=mkdtempSync(join(tmpdir(),'channel-inbox-'));const db=join(dir,'db'); let calls=0;
 const session={sessionId:'s',native:{provider:'codex'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}} as unknown as Session;
 const service={getSession:async()=>session,submitInput:async({context}:{context:WriteContext})=>{calls++;return {...context,action:'input',status:'completed',revision:1,error:null,payloadDigest:'d'};}} as unknown as UnifiedService;
 const port:FeishuPort={send:async()=> 'id',update:async()=>{},sendFile:async()=>{}}; const env=(eventId:string)=>({eventId,destination:'d',identity:{source:'v',subject:'owner'}});
 let channel=new FeishuChannel(service,port,async()=>true,db); try {await interactiveBinding(channel,service,env('b'),'s'); const a={action:'input',text:'hello',mode:'new'} as const; assert.equal((await channel.intake(env('m'),a)).state,'received');assert.equal(calls,0);assert.deepEqual(channel.pendingInbox(),['m']);channel.close();channel=new FeishuChannel(service,port,async()=>true,db);await channel.drain('m');await channel.drain('m');assert.equal(calls,1);assert.deepEqual(channel.unknownInbox(),[]);} finally {channel.close();rmSync(dir,{recursive:true,force:true});}
});

test('explicit binding administrator can manage but ordinary authorized user can only input', async () => {
 const dir=mkdtempSync(join(tmpdir(),'channel-admin-')); let inputs=0;
 const session={sessionId:'s',native:{provider:'codex'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}} as unknown as Session;
 const service={getSession:async()=>session,submitInput:async({context}:{context:WriteContext})=>{inputs++;return {...context,action:'input',status:'completed',revision:1,error:null,payloadDigest:'d'};}} as unknown as UnifiedService;
 const port:FeishuPort={send:async()=> 'id',update:async()=>{},sendFile:async()=>{}};
 const channel=new FeishuChannel(service,port,async()=>true,join(dir,'db'),async i=>i.subject==='admin'); const e=(id:string,subject:string)=>({eventId:id,destination:'d',identity:{source:'v',subject}});
 try {await interactiveBinding(channel,service,e('b','owner'),'s');await channel.handle(e('i','user'),{action:'input',text:'hello',mode:'new'});assert.equal(inputs,1);await assert.rejects(channel.handle(e('u','user'),{action:'unbind'}),/binding management unauthorized/);await channel.handle(e('a','admin'),{action:'unbind'});} finally {channel.close();rmSync(dir,{recursive:true,force:true});}
});

test('queued actions expire after rebind or unbind/rebind, never target another session', async () => {
 const dir=mkdtempSync(join(tmpdir(),'channel-binding-')); const db=join(dir,'db');const targets:string[]=[];let resolutions=0;
 const mk=(id:string)=>({sessionId:id,native:{provider:'codex'},title:id,project:'p',status:'idle',revision:1,control:{input:'available',generation:1}} as unknown as Session);
 const service={getSession:async(id:string)=>mk(id),submitInput:async({context}:{context:WriteContext})=>{targets.push(context.targetId);return {...context,action:'input',status:'completed',revision:1,error:null,payloadDigest:'d'};},getInteraction:async()=>({sessionId:'A'}),resolveInteraction:async()=>{resolutions++;}} as unknown as UnifiedService;
 const port:FeishuPort={send:async()=> 'id',update:async()=>{},sendFile:async()=>{}}; const e=(eventId:string)=>({eventId,destination:'d',identity:{source:'v',subject:'owner'}}); const channel=new FeishuChannel(service,port,async()=>true,db);
 const input={action:'input',text:'hello',mode:'new'} as const;
 const answer: import('../src/unified/feishu-channel.js').ChannelAction={action:'answer',interactionId:'i',revision:1,connectionGeneration:1,answer:{kind:'question',values:['yes']},toolInputDigest:null};
 try {
  await interactiveBinding(channel,service,e('bindA'),'A'); await channel.intake(e('old'),input);await channel.intake(e('old-answer'),answer);
  await interactiveBinding(channel,service,e('bindB'),'B');
  assert.deepEqual(await channel.drain('old'),{status:'expired',reason:'binding_changed'});assert.deepEqual(await channel.drain('old-answer'),{status:'expired',reason:'binding_changed'});assert.deepEqual(targets,[]);assert.equal(resolutions,0);
  await channel.intake(e('old'),input);assert.deepEqual(await channel.drain('old'),{status:'expired',reason:'binding_changed'});
  await channel.handle(e('new'),input);assert.deepEqual(targets,['B']);
  await channel.intake(e('before-unbind'),input);await channel.handle(e('unbind'),{action:'unbind'});await interactiveBinding(channel,service,e('restore'),'B');
  assert.deepEqual(await channel.drain('before-unbind'),{status:'expired',reason:'binding_changed'});assert.deepEqual(targets,['B']);
  await channel.handle(e('fresh'),input);assert.deepEqual(targets,['B','B']);
 } finally {channel.close();rmSync(dir,{recursive:true,force:true});}
});

test('callback created under old binding cannot act on new binding', async () => {
 const {parseFeishuAction}=await import('../src/unified/feishu-codec.js'); const dir=mkdtempSync(join(tmpdir(),'channel-stale-card-')); const cards:import('../src/unified/feishu-cards.js').ChannelCard[]=[]; let stopped=0;
 const service={getSession:async(id:string)=>({sessionId:id,native:{provider:'codex'},title:id,project:'p',status:'idle',revision:1,capabilities:{interrupt:{status:'available'},queue:{status:'available'},handoff:{status:'available'}},control:{input:'available',generation:1}}),getWorkState:async()=>({runningTurns:[{turnId:'old'}],queuedInputs:[],canArchive:false}),interruptTurn:async()=>{stopped++;}} as unknown as UnifiedService;
 const port:FeishuPort={send:async(_d,c)=>{cards.push(c);return 'id';},update:async()=>{},sendFile:async()=>{}}; const channel=new FeishuChannel(service,port,async()=>true,join(dir,'db'));const e=(eventId:string)=>({eventId,destination:'d',identity:{source:'v',subject:'owner'}});
 try {await interactiveBinding(channel,service,e('a'),'A');await channel.handle(e('p'),{action:'panel',turnId:'old'});const button=cards.at(-1)!.actions.find(x=>x.label==='中断当前回复')!;await channel.handle(e('b'),{action:'bind',sessionId:'B'});await assert.rejects(channel.handle(e('stale'),parseFeishuAction(button.value)),/binding changed/);assert.equal(stopped,0);}finally{channel.close();rmSync(dir,{recursive:true,force:true});}
});

test('legacy commands expose reachable migration paths',async()=>{ const {parseFeishuText}=await import('../src/unified/feishu-codec.js'); assert.deepEqual(parseFeishuText('/sessions'),{action:'list'}); assert.deepEqual(parseFeishuText('/help'),{action:'help'}); assert.deepEqual(parseFeishuText('/new /tmp hello'),{action:'new_help',initialPrompt:'/tmp hello'}); assert.deepEqual(parseFeishuText('/model'),{action:'legacy_model'}); assert.deepEqual(parseFeishuText('/model m high'),{action:'legacy_model',model:'m',effort:'high'}); assert.deepEqual(parseFeishuText('/model m'),{action:'legacy_model',invalid:true}); });

test('new drafts preserve multiline prompts and keep compact callbacks', async () => {
 const {parseFeishuAction,parseFeishuText}=await import('../src/unified/feishu-codec.js');
 for (const [input,expected] of [
  ['/new',{action:'new_help'}],
  ['/new codex',{action:'new_help',provider:'codex'}],
  ['/new agy 第一行\n  第二行  ',{action:'new_help',provider:'agy',initialPrompt:'第一行\n  第二行  '}],
  ['/new Claude 第一行\n第二行',{action:'new_help',initialPrompt:'Claude 第一行\n第二行'}],
 ] as const) assert.deepEqual(parseFeishuText(input),expected);
 const t='abcdefghijklmnopqrstuv';
 for (const action of [{action:'new_provider',t,r:1,p:'claude'}, {action:'new_pick',t,r:2,i:0}]) {
  assert.deepEqual(parseFeishuAction(action),action);
 }
 assert.throws(() => parseFeishuAction({action:'new_pick',t,r:2,i:-1}),/invalid/);
 assert.throws(() => parseFeishuAction({action:'new_provider',t:'short',r:1,p:'codex'}),/invalid/);
});
