import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {connect} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LaneFixtureService} from '../src/unified/lane-fixtures.js';
import {FeishuSdkPort} from '../src/unified/feishu-sdk-port.js';
import {FeishuChannel} from '../src/unified/feishu-channel.js';
import {TestLaneRuntime} from '../src/unified/test-lane.js';
import {parseFeishuAction} from '../src/unified/feishu-codec.js';

const execFileAsync=promisify(execFile);
const oldReleaseDir=process.env.SSTEER_OLD_RELEASE || process.env.R12_OLD_RELEASE || process.env.TASK_GUARD_RELEASE || '/home/zhangzy/.local/share/feishu-unified-bridge/releases/0090d1a';

test('fixed file versions survive trigger replay and channel restart with SDK delivery ledger isolation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fixture-versions-'));let seq=0,uploads=0;const chats=new Map<string,string>();const contents:Buffer[]=[];
 const fixturePath=join(dir,'fixture'),sdkPath=join(dir,'sdk'),channelPath=join(dir,'channel');let fixture=new LaneFixtureService('claude',fixturePath);let sdk!:FeishuSdkPort;let channel!:FeishuChannel;
 const install=()=>{(sdk as any).client={im:{message:{create:async({data}:any)=>{const id=`m${++seq}`;chats.set(id,data.receive_id);return {data:{message_id:id}}},reply:async({path}:any)=>{const id=`m${++seq}`;chats.set(id,chats.get(path.message_id)!);return {data:{message_id:id}}},get:async({path}:any)=>({code:0,data:{items:[{message_id:path.message_id,chat_id:chats.get(path.message_id),message_position:'17',sender:{id:'x',id_type:'app_id',sender_type:'app'}}]}})},file:{create:async({data}:any)=>{uploads++;contents.push(Buffer.from(data.file));return {file_key:`f${uploads}`}}}}};};
 const start=()=>{sdk=new FeishuSdkPort({appId:'x',appSecret:'x'},sdkPath,new Set(['a','b']),'owner');install();channel=new FeishuChannel(fixture.service,sdk,async(i,d)=>i.subject==='owner'&&sdk.authorizedDestination(d),channelPath)};start();
 const env=(eventId:string,destination='a')=>({eventId,destination,identity:{source:'feishu',subject:'owner'}});const action=(v:string)=>({action:'file' as const,artifactId:'fixture-file',contentVersion:v});
 try{const bound:any=await channel.handle(env('bind'),{action:'bind',sessionId:'s'});const d=bound.destination;fixture.trigger('file','one');const firstPage=await fixture.service.listArtifacts('s',{limit:100});const v1=firstPage.items.find(x=>x.artifactId==='fixture-file')!;assert.equal(v1.contentVersion,createHash('sha256').update('TEST fixture\n').digest('hex'));await channel.handle(env('first',d),action(v1.contentVersion));assert.equal(uploads,1);await channel.handle(env('first',d),action(v1.contentVersion));assert.equal(uploads,1);const cursor=await fixture.service.subscribeEvents('s','0',100);fixture.trigger('file','one');const replay=await fixture.service.subscribeEvents('s','0',100);assert.equal(replay.status,'events');assert.equal(cursor.status,'events');if(replay.status==='events'&&cursor.status==='events')assert.equal(replay.cursor,cursor.cursor);
 channel.close();sdk.close();fixture.close();fixture=new LaneFixtureService('claude',fixturePath);start();assert.equal((await channel.handle(env('again',d),action(v1.contentVersion)) as any).status,'located');assert.equal(uploads,1);
 fixture.trigger('file-v2','two');fixture.trigger('file-v2','two');const list=await fixture.service.listArtifacts('s',{limit:100});const versions=list.items.filter(x=>x.artifactId==='fixture-file');assert.equal(versions.length,2);const v2=versions[1]!;assert.equal(v2.name,v1.name);assert.notEqual(v2.contentVersion,v1.contentVersion);const bytes=await fixture.service.readArtifact('s',v2.artifactId,v2.contentVersion);assert.equal(createHash('sha256').update(bytes).digest('hex'),v2.contentVersion);assert.deepEqual(Buffer.from(await fixture.service.readArtifact('s',v1.artifactId,v1.contentVersion)),Buffer.from('TEST fixture\n'));await channel.handle(env('v2',d),action(v2.contentVersion));assert.equal(uploads,2);assert.deepEqual(contents[1],Buffer.from(bytes));assert.equal((await channel.handle(env('old',d),action(v1.contentVersion)) as any).status,'located');await assert.rejects(fixture.service.readArtifact('s','fixture-file','missing'));await assert.rejects(channel.handle(env('missing',d),action('missing')));assert.equal(uploads,2);
 const other=new LaneFixtureService('codex',join(dir,'other'));try{assert.equal((await other.service.listArtifacts('s',{limit:100})).items.filter(x=>x.artifactId==='fixture-file').length,1);await assert.rejects(other.service.readArtifact('s','fixture-file',v2.contentVersion));}finally{other.close()}
 }finally{try{channel.close()}catch{}try{sdk.close()}catch{}try{fixture.close()}catch{}rmSync(dir,{recursive:true,force:true})}
});

test('actual 0090d1a rollback rejects v2, locates v1, and restores v2 cleanly',{skip:existsSync(oldReleaseDir)?false:`set R12_OLD_RELEASE (missing ${oldReleaseDir})`},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fixture-versions-rollback-'));let seq=0,uploads=0;const chats=new Map<string,string>();const contents:Buffer[]=[];
 const fixturePath=join(dir,'fixture'),sdkPath=join(dir,'sdk'),channelPath=join(dir,'channel');let fixture=new LaneFixtureService('claude',fixturePath);let sdk!:FeishuSdkPort;let channel!:FeishuChannel;
 const install=()=>{(sdk as any).client={im:{message:{create:async({data}:any)=>{const id=`m${++seq}`;chats.set(id,data.receive_id);return {data:{message_id:id}}},reply:async({path}:any)=>{const id=`m${++seq}`;chats.set(id,chats.get(path.message_id)!);return {data:{message_id:id}}},get:async({path}:any)=>({code:0,data:{items:[{message_id:path.message_id,chat_id:chats.get(path.message_id),message_position:'17',sender:{id:'x',id_type:'app_id',sender_type:'app'}}]}})},file:{create:async({data}:any)=>{uploads++;contents.push(Buffer.from(data.file));return {file_key:`f${uploads}`}}}}};};
 const start=()=>{sdk=new FeishuSdkPort({appId:'x',appSecret:'x'},sdkPath,new Set(['a','b']),'owner');install();channel=new FeishuChannel(fixture.service,sdk,async(i,d)=>i.subject==='owner'&&sdk.authorizedDestination(d),channelPath)};start();
 const env=(eventId:string,destination='a')=>({eventId,destination,identity:{source:'feishu',subject:'owner'}});const action=(v:string)=>({action:'file' as const,artifactId:'fixture-file',contentVersion:v});
 try{
 const bound:any=await channel.handle(env('bind'),{action:'bind',sessionId:'s'});const d=bound.destination;
 fixture.trigger('file','one');fixture.trigger('file-v2','two');
 const versions=(await fixture.service.listArtifacts('s',{limit:100})).items.filter(x=>x.artifactId==='fixture-file');
 assert.equal(versions.length,2);const [v1,v2]=[versions[0]!,versions[1]!];
 await channel.handle(env('v1',d),action(v1.contentVersion));await channel.handle(env('v2',d),action(v2.contentVersion));assert.equal(uploads,2);
 channel.close();sdk.close();fixture.close();
 const oldFixtureModule=await import(pathToFileURL(join(oldReleaseDir,'dist/src/unified/lane-fixtures.js')).href);const oldChannelModule=await import(pathToFileURL(join(oldReleaseDir,'dist/src/unified/feishu-channel.js')).href);const oldFixture=new oldFixtureModule.LaneFixtureService('claude',fixturePath);sdk=new FeishuSdkPort({appId:'x',appSecret:'x'},sdkPath,new Set(['a','b']),'owner');install();const oldChannel=new oldChannelModule.FeishuChannel(oldFixture.service,sdk,async(i:any,d:string)=>i.subject==='owner'&&sdk.authorizedDestination(d),channelPath);
 try{await assert.rejects(oldChannel.handle(env('old-v2',d),action(v2.contentVersion)));assert.equal(uploads,2);assert.equal((await oldChannel.handle(env('old-v1',d),action(v1.contentVersion))).status,'located');oldFixture.trigger('file','legacy-op');assert.equal(uploads,2)}finally{oldChannel.close();sdk.close();oldFixture.close()}
 fixture=new LaneFixtureService('claude',fixturePath);start();assert.equal((await fixture.service.listArtifacts('s',{limit:100})).items.filter(x=>x.artifactId==='fixture-file').length,2);assert.equal((await channel.handle(env('after-old',d),action(v2.contentVersion)) as any).status,'located');assert.equal(uploads,2);
 }finally{try{channel.close()}catch{}try{sdk.close()}catch{}try{fixture.close()}catch{}rmSync(dir,{recursive:true,force:true})}
});

test('TestLaneRuntime operator.sock file-v2 exposes distinct artifact buttons and downloads/locates both versions offline',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fixture-versions-e2e-'));
 const sdkPath=join(dir,'sdk'),laneDir=join(dir,'lane'),channelPath=join(dir,'channel');
 const v1Hash=createHash('sha256').update('TEST fixture\n').digest('hex');
 const v2Hash=createHash('sha256').update('TEST fixture 第二版本\n').digest('hex');
 const operatorScript=fileURLToPath(new URL('../scripts/test-lane-operator.mjs',import.meta.url));
 const sdk=new FeishuSdkPort({appId:'app',appSecret:'fake'},sdkPath,new Set(['chat']),'owner');
 let seq=0,uploads=0,prod=0;
 const chats=new Map<string,string>();
 const positions=new Map<string,string>();
 const replies:Array<{id:string;root:string;msgType:string;content:string}>=[];
 const uploaded:Array<{name:string;content:Buffer;messageId?:string}>=[];
 let handles:any;
 (sdk as any).client={
  request:async()=>({bot:{open_id:'bot'}}),
  im:{
   message:{
    create:async({data}:any)=>{const id=`root-${++seq}`;chats.set(id,data.receive_id);positions.set(id,String(seq));return {data:{message_id:id}};},
    reply:async({path,data}:any)=>{
     const id=`reply-${++seq}`;
     chats.set(id,chats.get(path.message_id)!);
     positions.set(id,String(100+seq));
     replies.push({id,root:path.message_id,msgType:data.msg_type,content:data.content});
     if(data.msg_type==='file'&&uploaded.length)uploaded.at(-1)!.messageId=id;
     return {data:{message_id:id}};
    },
    patch:async()=>({code:0}),
    get:async({path}:any)=>({code:0,data:{items:[{message_id:path.message_id,chat_id:chats.get(path.message_id),message_position:positions.get(path.message_id)??'17',sender:{id:'app',id_type:'app_id',sender_type:'app'}}]}}),
   },
   file:{create:async({data}:any)=>{uploads++;uploaded.push({name:data.file_name,content:Buffer.from(data.file)});return {file_key:`fk-${uploads}`};}},
  },
 };
 (sdk as any).ws={start:async({eventDispatcher}:any)=>{handles=eventDispatcher.handles;},close(){}};
 const lane=new TestLaneRuntime(sdk,laneDir,'owner',1000,[sdkPath]);
 const callSocket=(body:unknown)=>new Promise<any>((resolve,reject)=>{
  const socket=connect(join(laneDir,'operator.sock'));let data='';
  socket.on('connect',()=>socket.write(JSON.stringify(body)+'\n'));
  socket.on('data',chunk=>{data+=chunk.toString('utf8');});
  socket.on('end',()=>resolve(JSON.parse(data)));
  socket.on('error',reject);
 });
 let channel:FeishuChannel|undefined;
 try{
  await lane.startOperator();
  await sdk.start(async()=>{prod++;},async()=>{throw Error('unexpected production capture');});
  const createdClaude=await callSocket({action:'create',provider:'claude',chatId:'chat',operationId:'create-claude'});
  assert.equal(createdClaude.ok,true);
  const createdCodex=await callSocket({action:'create',provider:'codex',chatId:'chat',operationId:'create-codex'});
  assert.equal(createdCodex.ok,true);
  const claudeRoot=createdClaude.result.rootId as string;
  const codexRoot=createdCodex.result.rootId as string;
  await lane.tick();

  // Single-version codex lane renders numbered '1. fixture.txt', '2. fixture.png' button labels.
  const receiveMsg=(id:string,text:string,rootId:string)=>({sender:{sender_type:'user',sender_id:{open_id:'owner'}},message:{message_id:id,chat_id:'chat',chat_type:'p2p',message_type:'text',content:JSON.stringify({text}),root_id:rootId}});
  await handles.get('im.message.receive_v1')(receiveMsg('codex-files','/files',codexRoot));
  await lane.tick();
  const codexFilesCard=replies.find(r=>r.root===codexRoot&&r.msgType==='interactive'&&JSON.parse(r.content).header?.title?.content==='文件')!;
  assert.ok(codexFilesCard);
  const codexLabels=JSON.parse(codexFilesCard.content).elements[1].actions.map((a:any)=>a.text.content);
  assert.deepEqual(codexLabels,['1. fixture.txt','2. fixture.png']);

  // Trigger file-v2 via scripts/test-lane-operator.mjs over operator.sock.
  const {stdout}=await execFileAsync(process.execPath,[operatorScript,laneDir,'trigger','claude','file-v2','trigger-file-v2']);
  assert.deepEqual(JSON.parse(stdout),{ok:true,result:{accepted:true}});
  await lane.tick();
  assert.ok(replies.some(r=>r.root===claudeRoot&&r.content.includes('fixture.txt（第二版本）')));

  // Request /files in claude test topic: dual-version fixture.txt buttons get short 6-char version suffix, single-version fixture.png stays clean.
  await handles.get('im.message.receive_v1')(receiveMsg('claude-files','/files',claudeRoot));
  await lane.tick();
  assert.equal(prod,0);
  const claudeFilesCard=replies.find(r=>r.root===claudeRoot&&r.msgType==='interactive'&&JSON.parse(r.content).header?.title?.content==='文件')!;
  assert.ok(claudeFilesCard);
  const buttons=JSON.parse(claudeFilesCard.content).elements[1].actions as Array<{text:{content:string};value:Record<string,unknown>}>;
  assert.deepEqual(buttons.map(b=>b.text.content),[`1. fixture.txt (${v1Hash.slice(0,6)})`,'2. fixture.png',`3. fixture.txt (${v2Hash.slice(0,6)})`]);
  assert.equal(new Set(buttons.map(b=>b.text.content)).size,3);

  const btnV1=buttons[0]!,btnV2=buttons[2]!;
  assert.equal(btnV1.value.contentVersion,v1Hash);
  assert.equal(btnV2.value.contentVersion,v2Hash);

  // Click both buttons through card.action.trigger and verify both versions download with distinct contents.
  const click=(eventId:string,messageId:string,value:Record<string,unknown>)=>handles.get('card.action.trigger')({event_id:eventId,context:{open_message_id:messageId,open_chat_id:'chat'},operator:{open_id:'owner'},action:{tag:'button',value}});
  await click('click-v1',claudeFilesCard.id,btnV1.value);
  await lane.tick();
  assert.equal(uploads,1);
  assert.equal(uploaded[0]!.name,'fixture.txt');
  assert.equal(uploaded[0]!.content.toString('utf8'),'TEST fixture\n');

  await click('click-v2',claudeFilesCard.id,btnV2.value);
  await lane.tick();
  assert.equal(uploads,2);
  assert.equal(uploaded[1]!.name,'fixture.txt');
  assert.equal(uploaded[1]!.content.toString('utf8'),'TEST fixture 第二版本\n');

  // Re-clicking v1 never duplicates upload.
  await click('click-v1-again',claudeFilesCard.id,btnV1.value);
  await lane.tick();
  assert.equal(uploads,2);
  assert.equal(prod,0);

  // Verify FeishuChannel + FeishuSdkPort artifacts buttons + click download + repeat locate for both versions.
  const claudeFixture=(lane as any).entries.get('claude').fixture as LaneFixtureService;
  const sentCards:any[]=[];
  const origReply=(sdk as any).client.im.message.reply;
  (sdk as any).client.im.message.reply=async(arg:any)=>{if(arg.data.msg_type==='interactive')sentCards.push(JSON.parse(arg.data.content));return origReply(arg);};
  channel=new FeishuChannel(claudeFixture.service,sdk,async(i,d)=>i.subject==='owner'&&sdk.authorizedDestination(d),channelPath);
  const env=(eventId:string,destination='chat')=>({eventId,destination,identity:{source:'feishu',subject:'owner'}});
  const bound:any=await channel.handle(env('chan-bind'),{action:'bind',sessionId:'s'});
  const dest=bound.destination as string;
  await channel.handle(env('chan-artifacts',dest),{action:'artifacts'});
  const channelButtons=sentCards.at(-1).elements[1].actions as Array<{text:{content:string};value:Record<string,unknown>}>;
  assert.deepEqual(channelButtons.map(b=>b.text.content),[`1. fixture.txt (${v1Hash.slice(0,6)})`,'2. fixture.png',`3. fixture.txt (${v2Hash.slice(0,6)})`]);

  await channel.handle(env('chan-dl-v1',dest),parseFeishuAction(channelButtons[0]!.value));
  assert.equal(uploads,3);
  assert.equal(uploaded[2]!.content.toString('utf8'),'TEST fixture\n');

  await channel.handle(env('chan-dl-v2',dest),parseFeishuAction(channelButtons[2]!.value));
  assert.equal(uploads,4);
  assert.equal(uploaded[3]!.content.toString('utf8'),'TEST fixture 第二版本\n');

  const locV1:any=await channel.handle(env('chan-loc-v1',dest),parseFeishuAction(channelButtons[0]!.value));
  assert.equal(locV1.status,'located');
  assert.equal(sentCards.at(-1).elements[1].actions[0].text.content,'定位原文件消息');
  assert.equal(sentCards.at(-1).elements[1].actions[0].url,locV1.url);

  const locV2:any=await channel.handle(env('chan-loc-v2',dest),parseFeishuAction(channelButtons[2]!.value));
  assert.equal(locV2.status,'located');
  assert.equal(sentCards.at(-1).elements[1].actions[0].text.content,'定位原文件消息');
  assert.equal(sentCards.at(-1).elements[1].actions[0].url,locV2.url);
  assert.notEqual(locV1.url,locV2.url);
  assert.equal(uploads,4);
 }finally{
  try{channel?.close();}catch{}
  try{await lane.close();}catch{}
  try{sdk.close();}catch{}
  rmSync(dir,{recursive:true,force:true});
 }
});
