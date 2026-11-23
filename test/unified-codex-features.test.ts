import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import type { CodexTransport } from '../src/unified/codex-transport.js';
import type { NativeSessionRef } from '../src/unified/contracts.js';
const ref:NativeSessionRef={provider:'codex',hostId:'h',serviceId:'s',nativeSessionId:'t'};
const guard={expectedConnectionGeneration:1,expectedControlGeneration:0,assertCurrent(){}};
function setup() {
  const calls:Array<{method:string;params:any}>=[];
  const thread={id:'t',cwd:'/tmp',status:{type:'idle'}};
  const transport={connected:true,generation:1,onMessage(){},onDisconnect(){}, async request(method:string,params:any) { calls.push({method,params}); if(method==='thread/start'||method==='thread/resume') return {thread}; if(method==='model/list') return params.cursor ? {data:[{model:'m2',displayName:'M2'}],nextCursor:null}:{data:[{model:'m1',displayName:'M1'}],nextCursor:'p2'}; if(method==='thread/unsubscribe') return {status:'unsubscribed'}; if(method==='turn/start') return {turn:{id:'turn'}}; return {}; }};
  return {adapter:new CodexAdapter(transport as unknown as CodexTransport,'h','s'),calls};
}
const code=(v:string)=>(e:unknown)=>(e as {code:string}).code===v;
test('staged image bytes and plain text reach the native turn in order',async()=>{
 const {adapter,calls}=setup(); await adapter.create('/tmp',null); calls.length=0; const png=Uint8Array.from([137,80,78,71,13,10,26,10,1]);
 await adapter.input(ref,'new',[{type:'text',text:'hi'},{type:'artifact',artifactId:'a',contentVersion:'1',name:'a.png',mediaType:'image/png',content:png},{type:'artifact',artifactId:'b',contentVersion:'1',name:'b.txt',mediaType:'text/plain',content:Buffer.from('hello')}],guard);
 assert.deepEqual(calls[0]!.params.input,[{type:'text',text:'hi',text_elements:[]},{type:'image',url:`data:image/png;base64,${Buffer.from(png).toString('base64')}`},{type:'text',text:'File content ("b.txt"):\nhello',text_elements:[]}]);
 await assert.rejects(adapter.input(ref,'new',[{type:'artifact',artifactId:'a',contentVersion:'1',name:'a',mediaType:'image/jpeg',content:png}],guard),code('invalid_request'));
 await assert.rejects(adapter.input(ref,'new',[{type:'artifact',artifactId:'a',contentVersion:'1',name:'a',mediaType:'application/pdf',content:png}],guard),code('unsupported'));
 await assert.rejects(adapter.input(ref,'new',[{type:'artifact',artifactId:'a',contentVersion:'1',name:'a',mediaType:'text/plain',content:Uint8Array.from([255])}],guard),code('invalid_request')); assert.equal(calls.length,1);
});
test('model pages, settings and archive obey guard and next-turn schema',async()=>{
 const {adapter,calls}=setup(); await adapter.create('/tmp',null); assert.deepEqual(await adapter.listModels(ref),[{id:'m1',label:'M1'},{id:'m2',label:'M2'}]);
 await assert.rejects(adapter.updateSettings(ref,{model:'unknown',preferences:{}},guard),code('invalid_request'));
 await assert.rejects(adapter.updateSettings(ref,{model:'m1',preferences:{effort:'high'}},guard),code('unsupported'));
 const result=await adapter.updateSettings(ref,{model:'m2',preferences:{}},guard); assert.equal((result as any).settingsApplied,true);
 await adapter.input(ref,'new',[{type:'text',text:'hi'}],guard); assert.equal(calls.at(-1)!.params.model,'m2');
 const n=calls.length; await assert.rejects(adapter.archive(ref,true,{...guard,assertCurrent(){throw {code:'control_conflict'}}}),code('control_conflict')); assert.equal(calls.length,n);
 await adapter.archive(ref,true,guard); await adapter.archive(ref,false,guard); assert.deepEqual(calls.slice(-2).map(c=>c.method),['thread/archive','thread/unarchive']);
});
test('owned control changes track subscription, unknown sessions cannot be acquired',async()=>{
 const {adapter,calls}=setup(); await assert.rejects(adapter.control(ref,'acquire',guard),code('unsupported')); await adapter.create('/tmp',null);
 const r=await adapter.control(ref,'release',guard); assert.equal(r.nativeReference,'unsubscribed'); assert.equal(calls.at(-1)!.method,'thread/unsubscribe');
 const n=calls.length; await assert.rejects(adapter.input(ref,'new',[{type:'text',text:'blocked'}],guard),code('control_conflict')); assert.equal(calls.length,n);
 await adapter.control(ref,'acquire',guard); assert.equal(calls.at(-1)!.method,'thread/resume');
});

test('catalog reasoning effort is validated and reaches only later new turns',async()=>{
 const {adapter,calls}=setup(); await adapter.create('/tmp',null); const transport=adapter.transport as any; const request=transport.request.bind(transport); transport.request=async(method:string,params:any)=> method==='model/list' ? (params.cursor ? {data:[{model:'m2',displayName:'M2',supportedReasoningEfforts:[{reasoningEffort:'high',description:''}]}],nextCursor:null} : {data:[{model:'m1',displayName:'M1',supportedReasoningEfforts:[{reasoningEffort:'low',description:''}]}],nextCursor:'p2'}) : request(method,params);
 assert.deepEqual((await adapter.listModels(ref)).map(x=>x.reasoningEfforts),[['low'],['high']]);
 await assert.rejects(adapter.updateSettings(ref,{model:'m2',preferences:{reasoningEffort:'low'}},guard),code('invalid_request'));
 await assert.rejects(adapter.updateSettings(ref,{model:'m2',preferences:{reasoningEffort:'high',other:'x'}},guard),code('unsupported'));
 await adapter.updateSettings(ref,{model:'m2',preferences:{reasoningEffort:'high'}},guard); await adapter.input(ref,'new',[{type:'text',text:'next'}],guard); assert.equal(calls.at(-1)!.params.effort,'high');
});
test('existing direct Codex text attachments above 1 MiB remain supported',async()=>{const {adapter,calls}=setup();await adapter.create('/tmp',null);calls.length=0;const content=Buffer.alloc(1024*1024+1,65);await adapter.input(ref,'new',[{type:'artifact',artifactId:'a',contentVersion:'v',name:'large.txt',mediaType:'text/plain',content}],guard);assert.equal(calls.length,1);assert.equal(calls[0]!.params.input[0].text.length,'File content ("large.txt"):\n'.length+content.length)});
