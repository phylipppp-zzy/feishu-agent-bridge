import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexTransport, type SocketFactory } from '../src/unified/codex-transport.js';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import type { DispatchGuard, PlatformObservation } from '../src/unified/adapter.js';
import type { Interaction, NativeSessionRef } from '../src/unified/contracts.js';
class FakeSocket extends EventTarget {
  readyState = 0; sent: any[] = [];
  send(raw: string) { const m = JSON.parse(raw); this.sent.push(m); if (m.method === 'initialize') queueMicrotask(() => this.message({ id: m.id, result: {} })); if (m.method === 'thread/resume') queueMicrotask(() => this.message({id:m.id,result:{thread:{id:m.params.threadId,cwd:'/work',status:{type:'idle'}}}})); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
const errorCode = (code: string) => (e: unknown) => (e as { code?: string }).code === code;
const ref: NativeSessionRef = { provider: 'codex', hostId: 'h', serviceId: 's', nativeSessionId: 't' };
const guard: DispatchGuard = { expectedConnectionGeneration: 1, expectedControlGeneration: 1, assertCurrent() {} };
function setup() { const sockets: FakeSocket[] = []; const factory = (() => { const s = new FakeSocket(); sockets.push(s); queueMicrotask(() => s.open()); return s; }) as unknown as SocketFactory; const transport = new CodexTransport('ws://127.0.0.1:1', factory, 100); const adapter = new CodexAdapter(transport, 'h', 's'); const events: PlatformObservation[] = []; adapter.onObservation(e => { events.push(e); }); return { sockets, transport, adapter, events }; }
const question = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'turn', questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }, { id: 'q2', question: 'Why' }] } };
const lastInteraction = (events: PlatformObservation[]): Interaction => { const e = events.at(-1); assert.equal(e?.type, 'interaction'); return (e as Extract<PlatformObservation, { type: 'interaction' }>).interaction; };
test('disconnect makes in-flight outcome unknown without replay', async () => { const { sockets, transport } = setup(); await transport.connect(); const p = transport.request('thread/start', {}); sockets[0]!.close(); await assert.rejects(p, errorCode('outcome_unknown')); await transport.connect(); assert.deepEqual(sockets[1]!.sent.map(x => x.method), ['initialize', 'initialized']); transport.close(); });
test('multiple questions and multiple answers use native schema and await resolved', async () => {
  const { sockets, transport, adapter, events } = setup(); await transport.connect(); await adapter.resume(ref); sockets[0]!.message(question); const i = lastInteraction(events); assert.equal(i.kind, 'question_group'); if (i.kind !== 'question_group') throw Error(); assert.equal(i.questions[0]!.multiple, null);
  await adapter.respond(ref, i, { kind: 'question_group', answers: { q1: ['A', 'B'], q2: ['free text'] } }, guard);
  assert.deepEqual(sockets[0]!.sent.at(-1), { id: 7, result: { answers: { q1: { answers: ['A', 'B'] }, q2: { answers: ['free text'] } } } }); assert.equal(lastInteraction(events).status, 'answer_pending_delivery');
  sockets[0]!.message({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 7 } }); assert.equal(lastInteraction(events).status, 'resolved'); assert.deepEqual(lastInteraction(events).nativeResult, { status: 'accepted', source: 'unknown', answer: null });
  await assert.rejects(adapter.respond(ref, i, { kind: 'question_group', answers: { q1: ['A'], q2: ['x'] } }, guard), errorCode('interaction_expired')); transport.close();
});
test('old connection, wrong session, stale guard and incomplete answers cannot write', async () => {
  const { sockets, transport, adapter, events } = setup(); await transport.connect(); await adapter.resume(ref); sockets[0]!.message(question); const i = lastInteraction(events), answer = { kind: 'question_group' as const, answers: { q1: ['A'], q2: ['x'] } }; const count = sockets[0]!.sent.length;
  await assert.rejects(adapter.respond(ref, i, { kind: 'question_group', answers: { q1: ['A'] } }, guard), errorCode('invalid_request'));
  await assert.rejects(adapter.respond({ ...ref, nativeSessionId: 'other' }, i, answer, guard), errorCode('interaction_expired'));
  await assert.rejects(adapter.respond(ref, i, answer, { ...guard, assertCurrent() { throw { code: 'control_conflict' }; } }), errorCode('control_conflict')); assert.equal(sockets[0]!.sent.length, count);
  sockets[0]!.close(); await transport.connect(); sockets[1]!.message(question); await assert.rejects(adapter.respond(ref, i, answer, guard), errorCode('interaction_expired')); transport.close();
});
test('single approval deny is scoped and guard checked before write', async () => {
  const { sockets, transport, adapter, events } = setup(); await transport.connect(); await adapter.resume(ref); sockets[0]!.message({ id: 'r', method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'x', command: 'true' } }); const i = lastInteraction(events);
  await assert.rejects(adapter.respond(ref, i, { kind: 'approval', decision: 'allow', scope: 'other' }, guard), errorCode('invalid_request'));
  await adapter.respond(ref, i, { kind: 'approval', decision: 'deny', scope: 'this_request' }, guard); assert.deepEqual(sockets[0]!.sent.at(-1), { id: 'r', result: { decision: 'decline' } }); transport.close();
});
test('normalized message and turn observations include native reference', async () => {
  const { sockets, transport, events } = setup(); await transport.connect(); sockets[0]!.message({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn', status: 'inProgress' } } }); const turn = events.at(-1); assert.equal(turn?.type, 'turn'); assert.deepEqual(turn?.ref, ref);
  sockets[0]!.message({ method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'hello' } } }); const msg = events.at(-1); assert.equal(msg?.type, 'message'); if (msg?.type === 'message') assert.deepEqual(msg.message.blocks, [{ type: 'text', text: 'hello' }]); transport.close();
});
test('unsupported file and control operations return standard error', async () => { const { adapter } = setup(); await assert.rejects(adapter.listArtifacts(ref), errorCode('unsupported')); await assert.rejects(adapter.control(ref, 'acquire', guard), errorCode('unsupported')); });
test('list and read normalize provider data and preserve host/service reference', async () => {
  const { sockets, transport, adapter } = setup(); await transport.connect();
  const thread = { id: 't', cwd: '/work', name: 'title', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [{ id: 'item', type: 'agentMessage', text: 'ok' }] }] };
  const pendingList = adapter.list(null, 10); const listId = sockets[0]!.sent.at(-1).id; sockets[0]!.message({ id: listId, result: { data: [thread], nextCursor: null } }); const list = await pendingList; assert.deepEqual(list.items[0]!.native, ref);
  const pendingRead = adapter.read(ref); const readId = sockets[0]!.sent.at(-1).id; sockets[0]!.message({ id: readId, result: { thread } }); const snapshot = await pendingRead; assert.equal(snapshot.session.title, 'title'); assert.equal(snapshot.messages[0]!.messageId, 'item'); assert.deepEqual(snapshot.messages[0]!.blocks, [{ type: 'text', text: 'ok' }]); transport.close();
});
test('secret question is explicitly unsupported without responding', async () => { const { sockets, transport, events } = setup(); await transport.connect(); const count = sockets[0]!.sent.length; sockets[0]!.message({ id: 9, method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'x', questions: [{ id: 'a', question: 'Secret', isSecret: true }] } }); assert.equal(events.at(-1)?.type, 'event'); if (events.at(-1)?.type === 'event') assert.equal((events.at(-1) as Extract<PlatformObservation, { type: 'event' }>).event.type, 'interaction.unsupported'); assert.equal(sockets[0]!.sent.length, count); transport.close(); });

test('agent delta uses one native item and completed is authoritative, late delta ignored',async()=>{
 const {sockets,transport,adapter,events}=setup();await transport.connect();await adapter.resume(ref);
 for(const delta of ['a','b','c']) sockets[0]!.message({method:'item/agentMessage/delta',params:{threadId:'t',turnId:'turn',itemId:'i',delta}});
 sockets[0]!.message({method:'item/completed',params:{threadId:'t',turnId:'turn',item:{type:'agentMessage',id:'i',text:'authoritative'}}});
 sockets[0]!.message({method:'item/agentMessage/delta',params:{threadId:'t',turnId:'turn',itemId:'i',delta:'late'}});
 const ms=events.filter((e):e is Extract<PlatformObservation,{type:'message'}>=>e.type==='message');assert.equal(ms.length,4);assert.deepEqual(ms.map(x=>x.message.final),[false,false,false,true]);assert.deepEqual(ms.at(-1)!.message.blocks,[{type:'text',text:'authoritative'}]);assert.ok(ms.every(x=>x.connectionGeneration===1));transport.close();
});
test('residual inspection pages exact observed turn items and fails closed on reconnect',async()=>{const {sockets,transport,adapter}=setup();await transport.connect();await adapter.resume(ref);const emit=(m:any)=>sockets[0]!.message(m);emit({method:'turn/started',params:{threadId:'t',turn:{id:'turn',status:'inProgress'}}});emit({method:'item/started',params:{threadId:'t',turnId:'turn',item:{type:'commandExecution',id:'ours'}}});emit({method:'turn/started',params:{threadId:'t',turn:{id:'other',status:'inProgress'}}});emit({method:'item/started',params:{threadId:'t',turnId:'other',item:{type:'commandExecution',id:'theirs'}}});const pending=adapter.inspectTurnResidual(ref,'turn');let req=sockets[0]!.sent.at(-1);assert.equal(req.method,'thread/backgroundTerminals/list');emit({id:req.id,result:{data:[{itemId:'theirs',processId:'x',command:'secret',cwd:'/private'}],nextCursor:'next'}});await new Promise<void>(r=>setImmediate(r));req=sockets[0]!.sent.at(-1);assert.equal(req.params.cursor,'next');emit({id:req.id,result:{data:[{itemId:'ours',processId:'y',command:'secret',cwd:'/private'}],nextCursor:null}});const result=await pending;assert.equal(result.status,'running');assert.equal(result.count,1);assert.equal(result.complete,true);assert.doesNotMatch(JSON.stringify(result),/secret|private|processId/);sockets[0]!.close();await transport.connect();const stale=await adapter.inspectTurnResidual(ref,'turn');assert.equal(stale.status,'unknown');assert.equal(stale.count,null);transport.close();});
