import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../src/unified/claude-adapter.js';
import type { Interaction } from '../src/unified/contracts.js';

const tick = () => new Promise(r => setImmediate(r));
function fixture() {
  let options: any, prompt: any, end!: () => void; let history: any[] = []; const events: any[] = [], writes: any[] = [];
  const queue: any[] = []; let wake: (() => void) | undefined; let closed = false;
  const q: any = { async *[Symbol.asyncIterator]() { while (!closed || queue.length) { if (queue.length) yield queue.shift(); else await new Promise<void>(r => { wake = r; }); } }, interrupt: async () => { writes.push('interrupt'); }, setModel: async (x: unknown) => { writes.push(x); }, supportedModels: async () => [{ value: 'm', displayName: 'Model' }] };
  end = () => { closed = true; wake?.(); };
  const sdk: any = { query: (p: any) => { options = p.options; prompt = p.prompt; return q; }, listSessions: async () => [], getSessionMessages: async () => history };
  const adapter = new ClaudeAdapter('host', 'service', mkdtempSync(join(tmpdir(), 'claude-port-')), sdk); adapter.onObservation(x => events.push(x));
  const guard: any = { expectedConnectionGeneration: null, expectedControlGeneration: 1, assertCurrent() {} };
  const push = (m: any) => { queue.push(m); wake?.(); };
  return { adapter, guard, events, writes, setHistory(v:any[]) {history=v}, get options() { return options; }, get prompt() { return prompt; }, push, end };
}

test('live stream and persisted SDK history refer to same message',async()=>{const f=fixture(); const id=(await f.adapter.create('/tmp',null)).nativeReference!;const ref={provider:'claude' as const,hostId:'host',serviceId:'service',nativeSessionId:id}; const push=(event:any)=>f.push({type:'stream_event',parent_tool_use_id:null,event});push({type:'message_start',message:{id:'inner'}});push({type:'content_block_start',index:0,content_block:{type:'text',text:''}});push({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'same'}});push({type:'message_stop'});f.push({type:'assistant',uuid:'outer',parent_tool_use_id:null,message:{id:'inner',content:[{type:'text',text:'same'}]}});await tick();f.setHistory([{type:'assistant',uuid:'outer',session_id:id,parent_tool_use_id:null,message:{id:'inner',content:[{type:'text',text:'same'}]}}]);const snap=await f.adapter.read(ref);console.log(JSON.stringify({ids:snap.messages.map(m=>m.messageId),count:snap.messages.length}));assert.equal(snap.messages.length,1);f.end()});
