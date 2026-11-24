import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FeishuChannel } from '../src/unified/feishu-channel.js';
import { parseFeishuAction } from '../src/unified/feishu-codec.js';
import type { UnifiedService } from '../src/unified/adapter.js';

test('binding modes isolate writes, persist and require successful attach to upgrade', async () => {
 const dir=mkdtempSync(join(tmpdir(),'readonly-')); const path=join(dir,'channel.db');
 const identity={source:'feishu',subject:'owner'}; const env=(eventId:string,destination='ro')=>({eventId,destination,identity});
 const session={sessionId:'s',title:'s',project:'p',status:'idle',revision:1,native:{provider:'codex',hostId:'h',serviceId:'svc',nativeSessionId:'n'},control:{input:'available',generation:1}};
 let writes=0, fail=false, reads=0; const ops=new Map<string,unknown>(); const cards:Array<any>=[];
 const service={getSession:async()=>session,readHistory:async()=>{reads++;return {items:[],nextCursor:null};},attachSession:async({context}:any)=>{ if(fail) throw Error('resume failed'); const op={operationId:context.operationId,targetId:context.targetId,status:'completed',action:'attachSession',error:null,result:{kind:'session',sessionId:'s'}}; ops.set(op.operationId,op); return op; },getOperation:async(id:string)=>ops.get(id),submitInput:async()=>{writes++;return {status:'completed',action:'input',error:null}},resolveInteraction:async()=>{writes++;},getInteraction:async()=>({sessionId:'s'}),stageInputArtifact:async()=>{writes++;}} as unknown as UnifiedService;
 const port={send:async(_d:string,c:any)=>{cards.push(c);return 'm'},update:async()=>{},sendFile:async()=>{}};
 let channel=new FeishuChannel(service,port,async()=>true,path); const handle=(id:string,d:string,a:any)=>channel.handle(env(id,d),a);
 try {
  await handle('bind-ro','ro',{action:'bind',sessionId:'s'});
  const attach:any=await handle('attach-rw','rw',{action:'attach',provider:'codex',hostId:'h',serviceId:'svc',nativeSessionId:'n',mode:'interactive'});
  await handle('finish-rw','rw',{action:'finish',operationId:attach.operationId});
  assert.deepEqual(await handle('approval','ro',{action:'answer',interactionId:'i',revision:1,connectionGeneration:1,answer:{kind:'approval',decision:'allow',scope:'x'},toolInputDigest:'x'}),{status:'rejected',reason:'read_only_binding'});
  await assert.rejects(channel.captureBindingScope(env('resource')),/read-only/);
  await handle('input-rw','rw',{action:'input',text:'hello',mode:'new'}); assert.equal(writes,1);
  await handle('history','ro',{action:'history'}); await handle('notifications','ro',{action:'notifications',enabled:false,eventTypes:[],revision:1,controlGeneration:1}); assert.equal(reads,1);
  channel.close(); channel=new FeishuChannel(service,port,async()=>true,path);
  assert.deepEqual(await handle('ro-restart','ro',{action:'input',text:'x',mode:'new'}),{status:'rejected',reason:'read_only_binding'}); await handle('rw-restart','rw',{action:'input',text:'x',mode:'new'}); assert.equal(writes,2);
  await handle('panel','ro',{action:'panel'}); const old=cards.at(-1).actions.find((x:any)=>x.value.action==='upgrade').value;
  fail=true;
  assert.deepEqual(await handle('upgrade-fail','ro',{action:'upgrade'}),{status:'rejected',reason:'temporarily_unavailable'});
  assert.match(cards.at(-1).text,/原端暂时无法完成接入/);
  assert.deepEqual(await handle('still-ro','ro',{action:'input',text:'x',mode:'new'}),{status:'rejected',reason:'read_only_binding'});
  fail=false;
  const requested:any=await handle('legacy-bind','ro',{action:'bind',sessionId:'s',mode:'interactive'});
  assert.equal(requested.status,'completed');
  await assert.rejects(channel.captureBindingScope(env('pending-bind')),/read-only/);
  const upgrade:any=await handle('upgrade','ro',parseFeishuAction(old));
  assert.equal(upgrade.operationId,requested.operationId);
  await handle('finish-upgrade','ro',{action:'finish',operationId:upgrade.operationId});
  await assert.rejects(handle('old-card','ro',parseFeishuAction(old)),/binding changed/);
  channel.close(); channel=new FeishuChannel(service,port,async()=>true,path);
  await handle('after-restart','ro',{action:'input',text:'x',mode:'new'}); assert.equal(writes,3);
 } finally {channel.close();rmSync(dir,{recursive:true,force:true});}
});

test('legacy schema and imports default to read only', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'legacy-')); const path=join(dir,'channel.db'); const db=new DatabaseSync(path);
 db.exec("CREATE TABLE channel_bindings(destination TEXT PRIMARY KEY,session_id TEXT NOT NULL,binding_id TEXT NOT NULL,owner_source TEXT NOT NULL,owner_subject TEXT NOT NULL,revision INTEGER NOT NULL); INSERT INTO channel_bindings VALUES ('old','s','id','feishu','owner',1)"); db.close();
 const channel=new FeishuChannel({} as UnifiedService,{send:async()=>{},update:async()=>{},sendFile:async()=>{}},async()=>true,path);
 try { channel.importMigrationBinding('migration',{destination:'import',sessionId:'s',bindingId:'new',owner:{source:'feishu',subject:'owner'}}); for(const destination of ['old','import']) await assert.rejects(channel.captureBindingScope({eventId:'e',destination,identity:{source:'feishu',subject:'owner'}}),/read-only/); } finally {channel.close();rmSync(dir,{recursive:true,force:true});}
});

test('SDK topic reuse cannot elevate an existing read-only root; two parent chats isolate modes with real core',async()=>{
 const {FeishuSdkPort}=await import('../src/unified/feishu-sdk-port.js'); const {UnifiedStore}=await import('../src/unified/store.js'); const {UnifiedCore}=await import('../src/unified/service.js');
 const dir=mkdtempSync(join(tmpdir(),'readonly-sdk-core-')); let number=0; const sent:any[]=[];
 const sdk=new FeishuSdkPort({appId:'x',appSecret:'x'},join(dir,'sdk'),new Set(['chat-a','chat-b']),'owner');
 (sdk as any).client={im:{message:{create:async({data}:any)=>{sent.push(data);return {data:{message_id:`m${++number}`}};},reply:async({data}:any)=>{sent.push(data);return {data:{message_id:`m${++number}`}};}}}};
 const store=new UnifiedStore(join(dir,'core')); const capabilities=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:'available'}]));
 store.insertSession({sessionId:'s',native:{provider:'codex',hostId:'h',serviceId:'svc',nativeSessionId:'native'},project:'p',title:'s',status:'idle',revision:0,capabilities,control:{serviceId:'svc',owner:'x',input:'available',generation:1,operationId:null,reason:null}} as any);
 const core=new UnifiedCore(store,[{provider:'codex',onObservation:()=>()=>{}} as any],()=>true);const channel=new FeishuChannel(core,sdk,async(i,d)=>i.subject==='owner'&&sdk.authorizedDestination(d),join(dir,'channel'));
 const e=(eventId:string,destination:string)=>({eventId,destination,identity:{source:'feishu',subject:'owner'}});
 try {
  const ro:any=await channel.handle(e('ro','chat-a'),{action:'bind',sessionId:'s',mode:'read_only'});
  const same:any=await channel.handle(e('same','chat-a'),{action:'bind',sessionId:'s',mode:'interactive'});
  const reused:any=await channel.handle(e('finish-same','chat-a'),{action:'finish',operationId:same.operationId});
  assert.equal(reused.destination,ro.destination);assert.equal(reused.accessMode,'read_only');assert.equal(reused.reason,'upgrade_in_existing_topic');
  assert.deepEqual(await channel.handle(e('still-ro',ro.destination),{action:'input',text:'no',mode:'new'}),{status:'rejected',reason:'read_only_binding'});
  const rwOp:any=await channel.handle(e('other','chat-b'),{action:'bind',sessionId:'s',mode:'interactive'});
  const rw:any=await channel.handle(e('finish-other','chat-b'),{action:'finish',operationId:rwOp.operationId});
  assert.notEqual(rw.destination,ro.destination);assert.equal(rw.accessMode,'interactive');
  const submitted:any=await channel.handle(e('rw-input',rw.destination),{action:'input',text:'yes',mode:'new'});assert.equal(submitted.targetId,'s');
  assert.deepEqual(await channel.handle(e('ro-input',ro.destination),{action:'input',text:'no',mode:'new'}),{status:'rejected',reason:'read_only_binding'});
  assert.equal(channel.boundDestinations().length,2);
  const existing = sent.map(x => JSON.parse(String(x.content))).find(x => x.header?.title.content === '只读话题已存在');
  assert.equal(existing.header.template, 'grey');
  assert.deepEqual(existing.elements[1].actions.map((a: any) => [a.text.content, a.value.action]), [
   ['一键接入并续聊', 'upgrade'], ['会话控制', 'panel'],
  ]);
 } finally {channel.close();core.close();store.close();sdk.close();rmSync(dir,{recursive:true,force:true});}
});

test('read-only interaction wording never offers an answer; interactive cards remain actionable',async()=>{
 const {interactionCard}=await import('../src/unified/feishu-cards.js');
 const q:any={kind:'question',interactionId:'q',sessionId:'s',turnId:'t',nativeRequestId:'n',connectionGeneration:1,revision:0,status:'awaiting_answer',expiresAt:null,toolInputDigest:null,nativeResult:null,prompt:'choose',choices:['yes'],multiple:false,allowFreeText:false};
 const approval:any={...q,kind:'approval',tool:'write',action:'write',scope:'s',toolInputDigest:'digest'};
 for(const item of [q,approval]) {const ro=interactionCard(item,true);assert.equal(ro.actions.length,0);assert.doesNotMatch(ro.text,/可通过答复入口|可答|多选/);assert.match(ro.text,/原终端/);assert.ok(interactionCard(item).actions.length>0);}
});
