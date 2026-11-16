import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleSdkCardCallback,receiveSdkMessage} from '../src/unified/feishu-sdk-port.js';
import {Readable} from 'node:stream';

const card=(action:unknown,owner='owner',chat='chat'):any=>({event_id:'e',context:{open_message_id:'old',open_chat_id:chat},operator:{open_id:owner},action:{tag:'button',value:action}});
const msg=(text:string,owner='owner',chat='chat'):any=>({sender:{sender_type:'user',sender_id:{open_id:owner}},message:{message_id:'m',chat_id:chat,chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}});
test('old and unknown SDK cards show owner-only toast without trusting old fields',async()=>{
 let calls=0, resolutions=0; const handle=async()=>{calls++;}; const resolve=()=>{resolutions++;return 'chat';};
 for(const value of [{action:'set_model',sessionId:'spoof',model:'m'}, {action:'alien',sessionId:'spoof'}]) {
  const result=await handleSdkCardCallback(card(value),'owner',new Set(['chat']),resolve,handle); assert.match(result!.toast.content,/\/sessions/); assert.equal(calls,0); assert.equal(resolutions,0);
  await assert.rejects(handleSdkCardCallback(card(value,'other'),'owner',new Set(['chat']),resolve,handle),/unauthorized/);
  await assert.rejects(handleSdkCardCallback(card(value,'owner','outside'),'owner',new Set(['chat']),resolve,handle),/unauthorized/);
 }
 await handleSdkCardCallback(card({action:'list'}),'owner',new Set(['chat']),resolve,handle); assert.equal(calls,1);assert.equal(resolutions,1);
 const unavailable=await handleSdkCardCallback(card({action:'list'}),'owner',new Set(['chat']),()=>{throw Error('private database detail');},handle);assert.match(unavailable!.toast.content,/暂时无法处理/);assert.doesNotMatch(unavailable!.toast.content,/private/);
});
test('unknown and malformed slash use static help after owner and chat checks',async()=>{
 const actions:any[]=[];const download=async()=>Readable.from([]);const handle=async(_e:unknown,a:unknown)=>{actions.push(a);};
 for(const text of ['/what-ever','/stop invalid']) await receiveSdkMessage(msg(text),'bot','owner',new Set(['chat']),download,handle);
 assert.deepEqual(actions,[{action:'help'},{action:'help'}]);
 await assert.rejects(receiveSdkMessage(msg('/what-ever','other'),'bot','owner',new Set(['chat']),download,handle),/unauthorized/);
 await assert.rejects(receiveSdkMessage(msg('/what-ever','owner','outside'),'bot','owner',new Set(['chat']),download,handle),/unauthorized/); assert.equal(actions.length,2);
});
test('unimported topic help is rejected before the parent chat handler',async()=>{
 const {FeishuSdkPort}=await import('../src/unified/feishu-sdk-port.js'); const {mkdtempSync,rmSync}=await import('node:fs'); const {join}=await import('node:path'); const {tmpdir}=await import('node:os'); const dir=mkdtempSync(join(tmpdir(),'legacy-topic-')); const port=new FeishuSdkPort({appId:'x',appSecret:'x'},join(dir,'sdk'),new Set(['chat']),'owner'); const received:any[]=[]; const event=msg('/unknown');event.message.root_id='unimported';
 try {await assert.rejects(receiveSdkMessage(event,'bot','owner',new Set(['chat']),async()=>Readable.from([]),async(e,a)=>{received.push({e,a});},undefined,(...args)=>port.resolveDestination(...args)),/unknown topic/); assert.equal(received.length,0);event.message.content=JSON.stringify({text:'ordinary input'});await assert.rejects(receiveSdkMessage(event,'bot','owner',new Set(['chat']),async()=>Readable.from([]),async()=>{},undefined,(...args)=>port.resolveDestination(...args)),/unknown topic/); } finally {port.close();rmSync(dir,{recursive:true,force:true});}
});
