import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../src/unified/claude-adapter.js';
import type { Interaction } from '../src/unified/contracts.js';

const tick = () => new Promise(r => setImmediate(r));
function fixture() {
  let options: any, prompt: any, end!: () => void; const events: any[] = [], writes: any[] = [];
  const queue: any[] = []; let wake: (() => void) | undefined; let closed = false;
  const q: any = { async *[Symbol.asyncIterator]() { while (!closed || queue.length) { if (queue.length) yield queue.shift(); else await new Promise<void>(r => { wake = r; }); } }, interrupt: async () => { writes.push('interrupt'); }, setModel: async (x: unknown) => { writes.push(x); }, supportedModels: async () => [{ value: 'm', displayName: 'Model' }] };
  end = () => { closed = true; wake?.(); };
  const sdk: any = { query: (p: any) => { options = p.options; prompt = p.prompt; return q; }, listSessions: async () => [], getSessionMessages: async () => [] };
  const adapter = new ClaudeAdapter('host', 'service', mkdtempSync(join(tmpdir(), 'claude-port-')), sdk); adapter.onObservation(x => events.push(x));
  const guard: any = { expectedConnectionGeneration: null, expectedControlGeneration: 1, assertCurrent() {} };
  const push = (m: any) => { queue.push(m); wake?.(); };
  return { adapter, guard, events, writes, get options() { return options; }, get prompt() { return prompt; }, push, end };
}

test('partial text blocks converge on one message and omit tool and thinking', async()=>{
  const f=fixture(); await f.adapter.create('/tmp',null); assert.equal(f.options.includePartialMessages,true);
  const push=(event:any)=>f.push({type:'stream_event',parent_tool_use_id:null,event});
  push({type:'message_start',message:{id:'inner'}});
  push({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
  for(const text of ['a','b','c']) push({type:'content_block_delta',index:0,delta:{type:'text_delta',text}});
  f.push({type:'assistant',uuid:'outer-one',parent_tool_use_id:null,message:{id:'inner',content:[{type:'text',text:'abc'}]}});
  push({type:'content_block_start',index:1,content_block:{type:'tool_use'}});
  push({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'secret'}});
  push({type:'content_block_start',index:2,content_block:{type:'text',text:''}});
  push({type:'content_block_delta',index:2,delta:{type:'text_delta',text:'xyz'}});
  push({type:'message_stop'});
  f.push({type:'assistant',uuid:'outer-two',parent_tool_use_id:null,message:{id:'inner',content:[{type:'text',text:'ABC corrected'},{type:'text',text:'XYZ corrected'}]}});
  push({type:'content_block_delta',index:2,delta:{type:'text_delta',text:'late'}});
  await tick(); const messages=f.events.filter(x=>x.type==='message').map(x=>x.message); assert.ok(messages.filter(x=>!x.final).length>=3); assert.ok(messages.every(x=>x.messageId==='inner')); console.log(JSON.stringify({actual:messages.at(-1).blocks}));assert.deepEqual(messages.at(-1).blocks,[{type:'text',text:'ABC corrected\nXYZ corrected'}]); assert.equal(messages.at(-1).final,true); f.end();
});
