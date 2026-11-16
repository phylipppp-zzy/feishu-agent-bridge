import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CodexAdapter} from '../src/unified/codex-adapter.js';

test('running discovery incrementally intersects loaded IDs with raw active main listing',async()=>{
  const calls:Array<{method:string;params:any}>=[];
  const t:any={connected:true,generation:1,request:async(method:string,params:any)=>{calls.push({method,params});
    if(method==='thread/loaded/list') return params.cursor===null?{data:['active','idle'],nextCursor:'l2'}:{data:['loaded-only'],nextCursor:null};
    if(method==='thread/list') return params.cursor===null?{data:[{id:'active',cwd:'/tmp',status:{type:'active'}},{id:'idle',cwd:'/tmp',status:{type:'idle'}},{id:'not-loaded',cwd:'/tmp',status:{type:'active'}}],nextCursor:'p2'}:{data:[{id:'other',cwd:'/tmp',status:{type:'active'}}],nextCursor:null};
    throw Error('unexpected call');}};
  const adapter=new CodexAdapter(t,'host','service');let cursor:string|null=null;const found=[];
  do {const page=await adapter.discoverRunning(cursor,1);found.push(...page.items);cursor=page.nextCursor;} while(cursor);
  assert.deepEqual(found.map(s=>s.native.nativeSessionId),['active']);
  assert.equal(found[0]?.status,'read_only');
  assert.deepEqual(calls.map(x=>x.method),['thread/loaded/list','thread/loaded/list','thread/list','thread/list']);
  assert.ok(calls.every(x=>!('sourceKinds' in x.params)));
  assert.ok(calls.every(x=>x.params.limit===100));
});

test('discovery fails closed on reconnect and invalid page',async()=>{
  const t:any={connected:true,generation:1,request:async()=>({data:['x'],nextCursor:'next'})};const adapter=new CodexAdapter(t,'h','s');
  const page=await adapter.discoverRunning(null,1);t.generation++;await assert.rejects(adapter.discoverRunning(page.nextCursor,1));
  t.request=async()=>({data:[null],nextCursor:null});await assert.rejects(adapter.discoverRunning(null,1));
});
