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

test('SDK input guarded; tool approval denial and native result are separately observed', async () => {
  const f = fixture(); const id = (await f.adapter.create('/tmp', null)).nativeReference!; const ref = { provider: 'claude' as const, hostId: 'host', serviceId: 'service', nativeSessionId: id };
  const reject = { ...f.guard, assertCurrent() { throw Error('stale'); } };
  await assert.rejects(f.adapter.input(ref, 'new', [{ type: 'text', text: 'hello' }], reject));
  await f.adapter.input(ref, 'new', [{ type: 'text', text: 'hello' }], f.guard);
  const titleUpdates = f.events.filter(event => event.type === 'session');
  assert.deepEqual(titleUpdates.map(event => [event.session.title, event.session.status]), [['hello', 'running']]);
  assert.equal((await f.adapter.read(ref)).session.title, 'hello');
  assert.equal((await f.adapter.list(null, 10)).items[0]?.title, 'hello');
  assert.equal((await f.prompt[Symbol.asyncIterator]().next()).value.message.content, 'hello');
  const ac = new AbortController(); const decision = f.options.canUseTool('Bash', { command: 'echo hi' }, { signal: ac.signal, toolUseID: 'tool1' });
  const i: Interaction = f.events.at(-1).interaction; assert.equal(i.kind, 'approval');
  await assert.rejects(f.adapter.respond(ref, i, { kind: 'approval', decision: 'allow', scope: 'this_request' }, { ...reject, expectedConnectionGeneration: i.connectionGeneration }));
  await f.adapter.respond(ref, i, { kind: 'approval', decision: 'deny', scope: 'this_request' }, { ...f.guard, expectedConnectionGeneration: i.connectionGeneration });
  assert.equal((await decision).behavior, 'deny'); assert.equal(f.events.at(-1).interaction.status, 'answer_pending_delivery');
  f.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1' }] } }); await tick();
  assert.deepEqual(f.events.at(-1).interaction.nativeResult, { status: 'unknown', source: 'claude_tool_result' });
  f.push({ type: 'result', subtype: 'success', is_error: false }); await tick(); assert.equal(f.events.at(-1).turn.status, 'completed'); f.end();
});

test('multi-question free text, expiration, and external sessions remain read-only', async () => {
  const f = fixture(); const id = (await f.adapter.create('/tmp', 'm')).nativeReference!; const ref = { provider: 'claude' as const, hostId: 'host', serviceId: 'service', nativeSessionId: id };
  const ac = new AbortController(); const decision = f.options.canUseTool('AskUserQuestion', { questions: [{ question: 'First?', options: [{ label: 'A' }], multiSelect: false }, { question: 'Second?', options: [], multiSelect: true }] }, { signal: ac.signal, toolUseID: 'q' });
  const i: Interaction = f.events.at(-1).interaction; assert.equal(i.kind, 'question_group');
  await f.adapter.respond(ref, i, { kind: 'question_group', answers: { '0': ['custom'], '1': ['x', 'y'] } }, { ...f.guard, expectedConnectionGeneration: i.connectionGeneration });
  assert.deepEqual((await decision).updatedInput.answers, { 'First?': 'custom', 'Second?': 'x, y' });
  const ac2 = new AbortController(); const decision2 = f.options.canUseTool('Bash', {}, { signal: ac2.signal, toolUseID: 'other' }); const j: Interaction = f.events.at(-1).interaction; ac2.abort(); assert.equal((await decision2).behavior, 'deny'); await assert.rejects(f.adapter.respond(ref, j, { kind: 'approval', decision: 'allow', scope: 'this_request' }, { ...f.guard, expectedConnectionGeneration: j.connectionGeneration }));
  await assert.rejects(f.adapter.resume({ ...ref, nativeSessionId: 'external' }), (e: any) => e.code === 'unsupported'); f.end();
});

test('image bytes are verified and connection closure expires outstanding requests', async () => {
  const f = fixture(); const id = (await f.adapter.create('/tmp', null)).nativeReference!; const ref = { provider: 'claude' as const, hostId: 'host', serviceId: 'service', nativeSessionId: id };
  const bad = { type: 'artifact' as const, artifactId: 'a', contentVersion: '1', name: 'x.png', mediaType: 'image/png', content: new Uint8Array([1, 2]) };
  await assert.rejects(f.adapter.input(ref, 'new', [bad], f.guard), (e: any) => e.code === 'unsupported');
  const png = { ...bad, content: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }; await f.adapter.input(ref, 'new', [png], f.guard);
  assert.equal((await f.prompt[Symbol.asyncIterator]().next()).value.message.content[0].source.media_type, 'image/png');
  const ac = new AbortController(); const decision = f.options.canUseTool('Bash', {}, { signal: ac.signal, toolUseID: 'pending' }); const i = f.events.at(-1).interaction;
  f.end(); await tick(); assert.equal((await decision).behavior, 'deny'); assert.equal(f.events.at(-1).interaction.status, 'expired');
  await assert.rejects(f.adapter.respond(ref, i, { kind: 'approval', decision: 'allow', scope: 'this_request' }, { ...f.guard, expectedConnectionGeneration: i.connectionGeneration }));
});

test('owned registry survives adapter restart and increments generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-owned-')); const queries: any[] = []; let sessionId = '';
  const sdk: any = { listSessions: async () => sessionId ? [{ sessionId, cwd: '/tmp', summary: '', lastModified: 1 }] : [], getSessionMessages: async () => [], query: (arg: any) => { queries.push(arg); return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, close() {} }; } };
  const first = new ClaudeAdapter('h', 's', dir, sdk); sessionId = (await first.create('/tmp', null)).nativeReference!;
  const second = new ClaudeAdapter('h', 's', dir, sdk); const ref = { provider: 'claude' as const, hostId: 'h', serviceId: 's', nativeSessionId: sessionId };
  assert.equal((await second.resume(ref)).nativeReference, sessionId); assert.equal(queries[1].options.resume, sessionId);
  const ac = new AbortController(); const observations: any[] = []; second.onObservation(o => observations.push(o)); const pending = queries[1].options.canUseTool('Bash', {}, { signal: ac.signal, toolUseID: 'p' });
  assert.equal(observations[0].interaction.connectionGeneration, 2); ac.abort(); await pending;
  await assert.rejects(second.resume({ ...ref, nativeSessionId: 'unknown' }), (e: any) => e.code === 'unsupported');
});


test('handoff is unsupported and duplicate questions are denied without an answer', async () => {
  const f = fixture(); const id = (await f.adapter.create('/tmp', null)).nativeReference!; const ref = { provider: 'claude' as const, hostId: 'host', serviceId: 'service', nativeSessionId: id };
  assert.equal((await f.adapter.list(null, 10)).items[0]!.capabilities.handoff.status, 'unsupported');
  for (const action of ['acquire', 'release'] as const) await assert.rejects(f.adapter.control(ref, action, f.guard), (e: any) => e.code === 'unsupported');
  const ac = new AbortController(); const decision = await f.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Same?', options: [{ label: 'A' }] }, { question: 'Same?', options: [{ label: 'B' }] }] }, { signal: ac.signal, toolUseID: 'dup' });
  assert.equal(decision.behavior, 'deny'); assert.match(decision.message, /Unsupported question group/); assert.equal(decision.updatedInput, undefined);
  const o = f.events.at(-1); assert.equal(o.type, 'event'); assert.equal(o.event.type, 'interaction.unsupported'); assert.match(o.event.data.reason, /duplicate/); f.end();
});

test('native tool error does not assert that the approval was rejected', async () => {
  const f = fixture(); const id = (await f.adapter.create('/tmp', null)).nativeReference!; const ref = { provider: 'claude' as const, hostId: 'host', serviceId: 'service', nativeSessionId: id };
  const ac = new AbortController(); const decision = f.options.canUseTool('Bash', {}, { signal: ac.signal, toolUseID: 'err' }); const i: Interaction = f.events.at(-1).interaction;
  await f.adapter.respond(ref, i, { kind: 'approval', decision: 'allow', scope: 'this_request' }, { ...f.guard, expectedConnectionGeneration: i.connectionGeneration }); await decision;
  f.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'err', is_error: true }] } }); await tick();
  assert.deepEqual(f.events.at(-1).interaction.nativeResult, { status: 'unknown', source: 'claude_tool_result_error' }); f.end();
});

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
  f.push({type:'assistant',uuid:'outer-two',parent_tool_use_id:null,message:{id:'inner',content:[{type:'text',text:'xyz'}]}});
  push({type:'content_block_delta',index:2,delta:{type:'text_delta',text:'late'}});
  await tick(); const messages=f.events.filter(x=>x.type==='message').map(x=>x.message); assert.ok(messages.filter(x=>!x.final).length>=3); assert.ok(messages.every(x=>x.messageId==='inner')); assert.deepEqual(messages.at(-1).blocks,[{type:'text',text:'abc\nxyz'}]); assert.equal(messages.at(-1).final,true); f.end();
});
