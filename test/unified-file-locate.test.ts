import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FeishuSdkPort} from '../src/unified/feishu-sdk-port.js';
import {FeishuChannel} from '../src/unified/feishu-channel.js';
import {UnifiedStore} from '../src/unified/store.js';
import {UnifiedCore} from '../src/unified/service.js';
import {parseFeishuAction} from '../src/unified/feishu-codec.js';

test('file repeat locates persisted message within binding and route; unknown never resends',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'file-locate-'));const sdkDb=join(dir,'sdk'),channelDb=join(dir,'channel');let seq=0,uploads=0,fail=false;const cards:any[]=[];const messageChats=new Map<string,string>();
 let sdk:FeishuSdkPort; const install=()=>{(sdk as any).client={im:{message:{create:async({data}:any)=>{if(data.msg_type==='interactive') cards.push(JSON.parse(data.content));const id=`m${++seq}`;messageChats.set(id,data.receive_id);return {data:{message_id:id}};},reply:async({path,data}:any)=>{if(data.msg_type==='file'&&fail) throw Error('unknown send');if(data.msg_type==='interactive') cards.push(JSON.parse(data.content));const id=`m${++seq}`;messageChats.set(id,messageChats.get(path.message_id)!);return {data:{message_id:id}};},get:async({path}:any)=>({code:0,data:{items:[{message_id:path.message_id,chat_id:messageChats.get(path.message_id),message_position:'17',sender:{id:'x',id_type:'app_id',sender_type:'app'}}]}})},file:{create:async()=>{uploads++;return {file_key:`f${uploads}`};}}}};};
 sdk=new FeishuSdkPort({appId:'x',appSecret:'x'},sdkDb,new Set(['a','b']),'owner');install();
 const store=new UnifiedStore(join(dir,'core'));const caps=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:'available'}]));
 const make=(id:string)=>({sessionId:id,native:{provider:'codex',hostId:'h',serviceId:'svc',nativeSessionId:id},project:'p',title:id,status:'idle',revision:0,capabilities:caps,control:{serviceId:'svc',owner:'x',input:'available',generation:1,operationId:null,reason:null}} as any);store.insertSession(make('s'));store.insertSession(make('other'));
 const adapter:any={provider:'codex',onObservation:()=>()=>{},listArtifacts:async()=>['v1','v2','unknown'].map(contentVersion=>({artifactId:'f',name:'file.txt',mediaType:'text/plain',size:1,contentVersion})),readArtifact:async()=>new Uint8Array([1])};const core=new UnifiedCore(store,[adapter],()=>true);
 const makeChannel=()=>new FeishuChannel(core,sdk,async(i,d)=>i.subject==='owner'&&sdk.authorizedDestination(d),channelDb);let channel=makeChannel();const env=(eventId:string,destination:string)=>({eventId,destination,identity:{source:'feishu',subject:'owner'}});const file=(v:string)=>({action:'file' as const,artifactId:'f',contentVersion:v});
 try {
  const one:any=await channel.handle(env('bind','a'),{action:'bind',sessionId:'s'});const other:any=await channel.handle(env('bind-other','b'),{action:'bind',sessionId:'s'});
  await channel.handle(env('files',one.destination),{action:'artifacts'});const oldFile=cards.at(-1).elements[1].actions[0].value;
  const first:any=await channel.handle(env('file-1',one.destination),file('v1'));assert.equal(uploads,1);
  assert.equal(await sdk.fileMessageLink(other.destination,'s',first.deliveryId),null);assert.equal(await sdk.fileMessageLink(one.destination,'other',first.deliveryId),null);
  channel.close();sdk.close();sdk=new FeishuSdkPort({appId:'x',appSecret:'x'},sdkDb,new Set(['a','b']),'owner');install();channel=makeChannel();
  const again:any=await channel.handle(env('file-2',one.destination),file('v1'));assert.equal(uploads,1);assert.equal(again.status,'located');const link=new URL(again.url);assert.equal(link.searchParams.get('openChatId'),'a');assert.equal(link.searchParams.get('position'),'17');assert.equal(link.searchParams.get('openMessageId'),null);assert.equal(cards.at(-1).elements[1].actions[0].url,again.url);
  await channel.handle(env('new-version',one.destination),file('v2'));assert.equal(uploads,2);
  fail=true;await assert.rejects(channel.handle(env('unknown-1',one.destination),file('unknown')),/unknown send/);assert.equal(uploads,3);const unknown:any=await channel.handle(env('unknown-2',one.destination),file('unknown'));assert.equal(unknown.status,'unknown');assert.equal(uploads,3);assert.match(cards.at(-1).elements[0].content,/状态未知|无法定位/);
  fail=false;await channel.handle(env('rebind',one.destination),{action:'bind',sessionId:'other'});await assert.rejects(channel.handle(env('old-card',one.destination),parseFeishuAction(oldFile)),/binding changed/);
  const after:any=await channel.handle(env('new-binding-file',one.destination),file('v1'));assert.equal(uploads,4);assert.notEqual(after.deliveryId,first.deliveryId);
 } finally {channel.close();core.close();store.close();sdk.close();rmSync(dir,{recursive:true,force:true});}
});
