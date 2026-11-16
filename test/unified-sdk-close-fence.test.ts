import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FeishuSdkPort} from '../src/unified/feishu-sdk-port.js';

test('shutdown prevents new sends and posting a file whose upload finishes after shutdown',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sdk-close-fence-'));const port=new FeishuSdkPort({appId:'test',appSecret:'test'},join(dir,'sdk'),new Set(['chat']),'owner');let posts=0,release!:(v:unknown)=>void;
 (port as any).client={im:{message:{create:async()=>{posts++;return {code:0,data:{message_id:'m'}};}},file:{create:async()=>new Promise(resolve=>{release=resolve;})}}};
 try {
  const uploading=port.sendFile('chat','test.txt',new Uint8Array([1]),'file');
  await new Promise<void>(resolve=>setImmediate(resolve));port.stopReceiving();release({file_key:'key'});
  await assert.rejects(uploading,/closing/);await assert.rejects(port.send('chat',{title:'x',text:'x',actions:[]},'message'),/closing/);
  await assert.rejects(port.createTopic('chat','s',{title:'x',text:'x',actions:[]},'topic'),/closing/);assert.equal(posts,0);
 }finally{port.close();rmSync(dir,{recursive:true,force:true});}
});

test('session topic links use only the allowed chat and exact registered session',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sdk-topic-link-'));const port=new FeishuSdkPort({appId:'test',appSecret:'test'},join(dir,'sdk'),new Set(['chat']),'owner');
 (port as any).client.im.message.create=async()=>({code:0,data:{message_id:'root',thread_id:'thread'}});
 try {
  const topic=await port.createTopic('chat','s',{title:'x',text:'x',actions:[]},'topic');
  const a=await port.topicLinkForSession('chat','s');assert.ok(a);assert.equal(await port.topicLinkForSession(topic,'s'),a);
  assert.equal(await port.topicLinkForSession('chat','different'),null);await assert.rejects(port.topicLinkForSession('other','s'),/unauthorized/);
 }finally{port.close();rmSync(dir,{recursive:true,force:true});}
});
