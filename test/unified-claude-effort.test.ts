import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../src/unified/claude-adapter.js';
import { FakeQuery } from './claude-fake-query.js';

const catalog = [
  {value:'a',displayName:'A',description:'',supportsEffort:true,supportedEffortLevels:['low','high']},
  {value:'b',displayName:'B',description:'',supportsEffort:true,supportedEffortLevels:['max']},
  {value:'c',displayName:'C',description:'',supportsEffort:false,supportedEffortLevels:['high']},
  {value:'d',displayName:'D',description:'',supportsEffort:true},
];
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'claude-effort-')); const queries: FakeQuery[]=[];
  const sdk:any={query:({prompt,options}:any)=>{const q=new FakeQuery(options,prompt); (q as any).supportedModels=async()=>catalog; queries.push(q); return q;},listSessions:async()=>[],getSessionMessages:async()=>[]};
  const port=new ClaudeAdapter('h','s',join(dir,'state'),sdk); const created=await port.create(dir,null); const ref=created.createdSession!.native;
  const guard={expectedControlGeneration:0,expectedConnectionGeneration:created.connectionGeneration!,assertCurrent(){}};
  return {port,ref,guard,queries,close:async()=>{await port.close();rmSync(dir,{recursive:true,force:true});}};
}
const code=(value:string)=>(e:any)=>e.code===value;
test('catalog, model validation, session-only flags and default reset',async()=>{const f=await fixture(); try {
  assert.deepEqual(await f.port.listModels(f.ref),[{id:'a',label:'A',reasoningEfforts:['low','high']},{id:'b',label:'B',reasoningEfforts:['max']},{id:'c',label:'C'},{id:'d',label:'D'}]);
  for(const [model,preferences] of [['a',{reasoningEffort:'max'}],['c',{reasoningEffort:'high'}],['d',{reasoningEffort:'high'}],[null,{reasoningEffort:'high'}],['missing',{}]] as const) await assert.rejects(f.port.updateSettings(f.ref,{model,preferences:preferences as Record<string,string>},f.guard),code('invalid_request'));
  await assert.rejects(f.port.updateSettings(f.ref,{model:'a',preferences:{other:'high'}},f.guard),code('unsupported'));
  assert.deepEqual(f.queries[0]!.calls,[]);
  assert.equal((await f.port.updateSettings(f.ref,{model:'a',preferences:{reasoningEffort:'high'}},f.guard)).settingsApplied,true);
  await f.port.updateSettings(f.ref,{model:'b',preferences:{}},f.guard);
  await f.port.updateSettings(f.ref,{model:null,preferences:{}},f.guard);
  assert.deepEqual(f.queries[0]!.calls,['model:a','flags:{"effortLevel":"high"}','model:b','flags:{"effortLevel":null}','model:']);
  assert.equal(f.queries.length,1); assert.equal(f.queries[0]!.options.permissionMode,'default');
  await assert.rejects(f.port.updateSettings({...f.ref,nativeSessionId:'external'},{model:'a',preferences:{}},f.guard),code('temporarily_unavailable'));
} finally {await f.close();}});
test('partial native writes and revoked guard never confirm or issue a further write',async()=>{const f=await fixture(); try {
  const q=f.queries[0]!; (q as any).applyFlagSettings=async()=>{q.calls.push('flags:failed');throw Error('lost');};
  await assert.rejects(f.port.updateSettings(f.ref,{model:'a',preferences:{reasoningEffort:'high'}},f.guard),code('outcome_unknown'));
  assert.deepEqual(q.calls,['model:a','flags:failed']); q.calls.length=0;
  let count=0; const revoked={...f.guard,assertCurrent(){if(++count===2) throw Error('revoked');}};
  await assert.rejects(f.port.updateSettings(f.ref,{model:'a',preferences:{reasoningEffort:'high'}},revoked),code('outcome_unknown'));
  assert.deepEqual(q.calls,['model:a']); assert.equal(f.queries.length,1);
} finally {await f.close();}});
test('current turn keeps its model and quota, approval and close continue to work',async()=>{const f=await fixture(); try {
  const events:any[]=[]; f.port.onObservation(o=>events.push(o)); const q=f.queries[0]!;
  await f.port.updateSettings(f.ref,{model:'a',preferences:{reasoningEffort:'low'}},f.guard);
  await f.port.input(f.ref,'new',[{type:'text',text:'test'}],f.guard); await q.nextMessage(1);
  await f.port.updateSettings(f.ref,{model:'b',preferences:{reasoningEffort:'max'}},f.guard);
  q.emit({type:'rate_limit_event',rate_limit_info:{status:'allowed_warning',rateLimitType:'five_hour'}});
  const pending=q.ask('Bash',{command:'test'}); await new Promise(r=>setImmediate(r));
  assert.ok(events.some(x=>x.type==='interaction')); q.result([]); await new Promise(r=>setImmediate(r));
  assert.ok(events.some(x=>x.type==='event' && x.event.type==='provider.usage_limit'));
  assert.equal(events.filter(x=>x.type==='turn').at(-1).turn.model,'a');
  await f.port.close(); assert.equal((await pending.result)?.behavior,'deny'); assert.ok(q.calls.includes('close'));
} finally {await f.close();}});
