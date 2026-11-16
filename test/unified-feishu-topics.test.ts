import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FeishuSdkPort,receiveSdkMessage} from '../src/unified/feishu-sdk-port.js';
import {FeishuChannel} from '../src/unified/feishu-channel.js';
import type {UnifiedService} from '../src/unified/adapter.js';
import type {WriteContext} from '../src/unified/contracts.js';
import {Readable} from 'node:stream';

test('two persisted topics route messages, callbacks, files and binding scopes independently',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'topics-')); const db=join(dir,'sdk'); const calls:Array<{kind:string;id:string;type:string}>=[]; let n=0;
 const install=(port:FeishuSdkPort)=>{(port as any).client={im:{message:{create:async ({data}:any)=>{const id=`m${++n}`;calls.push({kind:'create',id:data.receive_id,type:data.msg_type});return {data:{message_id:id,thread_id:`thread${n}`}};},reply:async ({path,data}:any)=>{calls.push({kind:'reply',id:path.message_id,type:data.msg_type});return {data:{message_id:`m${++n}`}};},patch:async()=>({})},file:{create:async()=>({file_key:'file'})}}};};
 let port=new FeishuSdkPort({appId:'x',appSecret:'x'},db,new Set(['chat']),'owner'); install(port);
 const submissions:string[]=[];
 const session=(id:string)=>({sessionId:id,native:{provider:'codex'},project:'p',title:id,status:'idle',revision:1,control:{input:'available',generation:1}});
 const answers:string[]=[]; const attachments:string[]=[]; const answered=new Set<string>();
 const service={getSession:async(id:string)=>session(id),getInteraction:async(id:string)=>({interactionId:id,sessionId:id,turnId:'turn',nativeRequestId:`request-${id}`,connectionGeneration:1,revision:answered.has(id)?2:1,status:answered.has(id)?'answer_pending_delivery':'awaiting_answer',expiresAt:null,toolInputDigest:null,nativeResult:null,kind:'question',prompt:'Choose',choices:['yes'],multiple:false,allowFreeText:false}),resolveInteraction:async({context}: {context:WriteContext})=>{answers.push(context.targetId);answered.add(context.targetId);return {...context,action:'answer',status:'completed',error:null};},stageInputArtifact:async({context}: {context:WriteContext})=>{attachments.push(context.targetId);return {...context,action:'stage',status:'completed',error:null};},submitInput:async({context}: {context:WriteContext})=>{submissions.push(context.targetId);return {...context,action:'input',status:'completed',error:null};}} as unknown as UnifiedService;
 let channel=new FeishuChannel(service,port,async(i,d)=>i.subject==='owner'&&port.authorizedDestination(d),join(dir,'channel'));
 const env=(id:string,destination='chat')=>({eventId:id,destination,identity:{source:'feishu',subject:'owner'}});
 try {
  const a=await channel.handle(env('b1'),{action:'bind',sessionId:'one'}) as {destination:string}; const b=await channel.handle(env('b2'),{action:'bind',sessionId:'two'}) as {destination:string};
  const operations=new Map<string,unknown>(); let upgradeSession=''; (service as any).attachSession=async ({context}:any)=>{const op={operationId:context.operationId,action:'attachSession',status:'completed',error:null,result:{kind:'session',sessionId:upgradeSession}}; operations.set(op.operationId,op);return op;}; (service as any).getOperation=async(id:string)=>operations.get(id);
  for(const [destination,id] of [[a.destination,'one'],[b.destination,'two']]) { upgradeSession=id!; const op=await channel.handle(env(`upgrade-${id}`,destination),{action:'upgrade'}) as {operationId:string}; await channel.handle(env(`finish-${id}`,destination),{action:'finish',operationId:op.operationId}); }
  assert.notEqual(a.destination,b.destination); assert.equal(calls.filter(x=>x.kind==='create').length,2);
  const roots=['m1','m3']; assert.equal(port.resolveDestination('chat',roots[0]),a.destination); assert.equal(port.resolveDestination('chat',roots[1]),b.destination);
  assert.equal(port.callbackDestination('chat','m2'),a.destination); assert.equal(port.callbackDestination('chat','m4'),b.destination);
  assert.throws(()=>port.callbackDestination('other','m2'),/unauthorized/); assert.throws(()=>port.authorizedDestination('topic:forged') || (()=>{throw Error('unauthorized')})(),/unauthorized/);
  assert.throws(()=>port.resolveDestination('chat','m1','m3'),/conflicting/);
  const sdkEvent=(id:string,root:string)=>({sender:{sender_type:'user',sender_id:{open_id:'owner'}},message:{message_id:id,chat_id:'chat',chat_type:'group',message_type:'text',content:JSON.stringify({text:'@bot hello'}),mentions:[{key:'@bot',id:{open_id:'bot'}}],root_id:root}} as any);
  for(const [id,root] of [['i1','m1'],['i2','m3']]) await receiveSdkMessage(sdkEvent(id!,root!),'bot','owner',new Set(['chat']),async()=>Readable.from([]),(e,x)=>channel.handle(e,x),undefined,(...args)=>port.resolveDestination(...args));
  assert.deepEqual(submissions,['one','two']); for(const [index,d] of [a.destination,b.destination].entries()) { const sid=index?'two':'one'; await channel.handle(env(`answer${index}`,port.callbackDestination('chat',index?'m4':'m2')),{action:'answer',interactionId:sid,revision:1,connectionGeneration:1,answer:{kind:'question',values:['yes']},toolInputDigest:null}); await channel.handle(env(`attachment${index}`,d),{action:'attachment',name:'x.png',mediaType:'image/png',content:new Uint8Array([1]),mode:'new'}); } assert.deepEqual(answers,['one','two']); assert.deepEqual(attachments,['one','two']); await port.sendFile(a.destination,'a.png',new Uint8Array([1]),'file1'); assert.deepEqual(calls.at(-1),{kind:'reply',id:'m1',type:'file'});
  await channel.intake(env('queued',a.destination),{action:'input',mode:'new',text:'old'}); await channel.handle(env('rebind',a.destination),{action:'bind',sessionId:'three'}); assert.deepEqual(await channel.drain('queued'),{status:'expired',reason:'binding_changed'});
  channel.close();port.close(); port=new FeishuSdkPort({appId:'x',appSecret:'x'},db,new Set(['chat']),'owner');install(port); channel=new FeishuChannel(service,port,async(i,d)=>i.subject==='owner'&&port.authorizedDestination(d),join(dir,'channel'));
  assert.equal(port.resolveDestination('chat','m3'),b.destination); assert.equal(port.callbackDestination('chat','m4'),b.destination); assert.deepEqual(new Set(channel.boundDestinations()),new Set([a.destination,b.destination]));
 } finally {channel.close();port.close();rmSync(dir,{recursive:true,force:true});}
});

test('two main panel create completions bind distinct roots',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'topic-create-')); const port=new FeishuSdkPort({appId:'x',appSecret:'x'},join(dir,'sdk'),new Set(['chat']),'owner'); let n=0;
 (port as any).client={im:{message:{create:async()=>({data:{message_id:`root${++n}`}}),reply:async()=>({data:{message_id:`reply${++n}`}})}}};
 const results=new Map<string,string>(); let created=0; const inputs:string[]=[];
 const service={submitInput:async({context}:{context:WriteContext})=>{inputs.push(context.targetId);return {operationId:context.operationId,status:'completed',action:'input',error:null};},createSession:async({context}: {context:WriteContext})=>{const sid=`session${++created}`;results.set(context.operationId,sid);return {operationId:context.operationId,status:'completed',action:'create',error:null};},getOperation:async(id:string)=>({status:'completed',result:{kind:'session',sessionId:results.get(id)}}),getSession:async(id:string)=>({sessionId:id,title:id,native:{provider:'codex'},project:'p',status:'idle',control:{input:'available',generation:1}})} as unknown as UnifiedService;
 const channel=new FeishuChannel(service,port,async(i,d)=>i.subject==='owner'&&port.authorizedDestination(d),join(dir,'channel')); const env=(eventId:string)=>({eventId,destination:'chat',identity:{source:'feishu',subject:'owner'}});
 try { const destinations:string[]=[]; for(const id of ['first','second']) {const op=await channel.handle(env(id),{action:'create',provider:'codex',project:'p',model:null}) as {operationId:string}; const result=await channel.handle(env(`${id}-finish`),{action:'finish',operationId:op.operationId}) as {destination:string}; destinations.push(result.destination); await channel.handle({...env(`${id}-input`),destination:result.destination},{action:'input',text:'hello',mode:'new'}); } assert.deepEqual(inputs,['session1','session2']); assert.notEqual(destinations[0],destinations[1]); assert.equal(channel.boundDestinations().length,2); } finally {channel.close();port.close();rmSync(dir,{recursive:true,force:true});}
});
