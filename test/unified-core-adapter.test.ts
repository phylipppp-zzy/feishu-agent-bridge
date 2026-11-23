import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexTransport, type SocketFactory } from '../src/unified/codex-transport.js';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import { ClaudeAdapter } from '../src/unified/claude-adapter.js';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedCore } from '../src/unified/service.js';
import type { Capabilities, Interaction, ResolveInteraction, Session } from '../src/unified/contracts.js';

const tick = () => new Promise<void>(r => setImmediate(r));
const caps = Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k => [k,{status:'available'}])) as Capabilities;
function session(provider:'codex'|'claude', hostId:string, serviceId:string, nativeSessionId:string): Session { return {sessionId:'unified',native:{provider,hostId,serviceId,nativeSessionId},project:'p',title:'x',status:'idle',revision:0,capabilities:caps,control:{serviceId,owner:'test',input:'available',generation:1,operationId:null,reason:null}}; }
function response(i: Interaction, id:string, answer:ResolveInteraction['answer']): ResolveInteraction { return {context:{targetId:'unified',operationId:id,idempotencyKey:id,expectedRevision:i.revision,controlGeneration:1,identity:{subject:'test',source:'test'}},interactionId:i.interactionId,expectedConnectionGeneration:i.connectionGeneration,answer,toolInputDigest:i.toolInputDigest}; }
class Socket extends EventTarget { readyState=0; sent:any[]=[]; send(raw:string){const m=JSON.parse(raw);this.sent.push(m);if(m.method==='initialize') queueMicrotask(()=>this.message({id:m.id,result:{}})); if(m.method==='thread/resume') queueMicrotask(()=>this.message({id:m.id,result:{thread:{id:m.params.threadId,cwd:'p',status:{type:'idle'}}}}));} open(){this.readyState=1;this.dispatchEvent(new Event('open'));} close(){this.readyState=3;this.dispatchEvent(new Event('close'));} message(m:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(m)}));} }
test('C1 Codex real adapter: answer, terminal first, duplicate, expiry and deny',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'c1-codex-'));const store=new UnifiedStore(join(dir,'db'));let socket!:Socket;const transport=new CodexTransport('ws://127.0.0.1:1',(()=>{socket=new Socket();queueMicrotask(()=>socket.open());return socket;}) as unknown as SocketFactory,100);const adapter=new CodexAdapter(transport,'h','v');const core=new UnifiedCore(store,[adapter],()=>true);store.insertSession(session('codex','h','v','native'));
  const interaction = () => store.snapshot('unified').value.interactions.at(-1)!;
  const question=(id:number)=>({id,method:'item/tool/requestUserInput',params:{threadId:'native',turnId:'turn',questions:[{id:'q',question:'Choose'}]}});
  try {await transport.connect();await adapter.resume({provider:'codex',hostId:'h',serviceId:'v',nativeSessionId:'native'});socket.message(question(7));const first=interaction();const req=response(first,'answer',{kind:'question_group',answers:{q:['yes']}});assert.equal((await core.resolveInteraction(req)).status,'received');assert.equal((await core.resolveInteraction(req)).operationId,'answer');assert.equal(store.getNativeInteraction(first.interactionId).revision,first.revision);assert.equal((await core.dispatch('answer')).status,'accepted');assert.deepEqual(socket.sent.at(-1),{id:7,result:{answers:{q:{answers:['yes']}}}});assert.equal(store.getInteraction(first.interactionId).status,'answer_pending_delivery');socket.message({method:'serverRequest/resolved',params:{threadId:'native',requestId:7}});assert.equal(store.getInteraction(first.interactionId).status,'resolved');
    socket.message(question(8));const second=interaction();const pending=response(second,'loser',{kind:'question_group',answers:{q:['no']}});await core.resolveInteraction(pending);const count=socket.sent.length;socket.message({method:'serverRequest/resolved',params:{threadId:'native',requestId:8}});assert.equal(store.getInteraction(second.interactionId).nativeResult?.status,'accepted');assert.equal(store.getOutbox('loser').state,'cancelled');await core.dispatch('loser');assert.equal(socket.sent.length,count);await assert.rejects(core.resolveInteraction(response(second,'old',{kind:'question_group',answers:{q:['yes']}})));
    socket.message({id:9,method:'item/commandExecution/requestApproval',params:{threadId:'native',turnId:'turn',command:'true'}});const approval=interaction();await core.resolveInteraction(response(approval,'deny',{kind:'approval',decision:'deny',scope:'this_request'}));assert.equal((await core.dispatch('deny')).status,'accepted');assert.deepEqual(socket.sent.at(-1),{id:9,result:{decision:'decline'}});
    socket.message({id:11,method:'item/commandExecution/requestApproval',params:{threadId:'native',turnId:'turn',command:'true'}});const allow=interaction();await core.resolveInteraction(response(allow,'allow',{kind:'approval',decision:'allow',scope:'this_request'}));assert.equal((await core.dispatch('allow')).status,'accepted');assert.deepEqual(socket.sent.at(-1),{id:11,result:{decision:'accept'}});
    socket.message(question(10));const stale=interaction();socket.close();assert.equal(store.getInteraction(stale.interactionId).status,'expired');await assert.rejects(core.resolveInteraction(response(stale,'expired',{kind:'question_group',answers:{q:['x']}})));
  } finally {core.close();transport.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('C1 Claude real adapter: question and approval retain native revision; expired request cannot send',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'c1-claude-'));const store=new UnifiedStore(join(dir,'db'));let options:any;const queue:any[]=[];let wake:(()=>void)|undefined;let closed=false;
  const query:any={async *[Symbol.asyncIterator](){while(!closed||queue.length){if(queue.length)yield queue.shift();else await new Promise<void>(r=>{wake=r;});}},close(){closed=true;wake?.();}};
  const sdk:any={query:(arg:any)=>{options=arg.options;return query;},listSessions:async()=>[],getSessionMessages:async()=>[]};const adapter=new ClaudeAdapter('h','v',join(dir,'owned'),sdk);const native=(await adapter.create('/tmp',null)).nativeReference!;store.insertSession(session('claude','h','v',native));const core=new UnifiedCore(store,[adapter],()=>true);
  const last=()=>store.snapshot('unified').value.interactions.at(-1)!;
  try {let ac=new AbortController();const decision=options.canUseTool('AskUserQuestion',{questions:[{question:'Why?',options:[],multiSelect:false}]},{signal:ac.signal,toolUseID:'q'});const i=last();const req=response(i,'q-answer',{kind:'question_group',answers:{'0':['yes']}});await core.resolveInteraction(req);assert.equal(store.getInteraction(i.interactionId).revision,i.revision+1);assert.equal(store.getNativeInteraction(i.interactionId).revision,i.revision);assert.equal((await core.dispatch('q-answer')).status,'accepted');assert.equal((await decision).updatedInput.answers['Why?'],'yes');assert.equal(store.getInteraction(i.interactionId).status,'answer_pending_delivery');
    ac=new AbortController();const deny=options.canUseTool('Bash',{command:'true'},{signal:ac.signal,toolUseID:'approval'});const a=last();await core.resolveInteraction(response(a,'deny',{kind:'approval',decision:'deny',scope:'this_request'}));assert.equal((await core.dispatch('deny')).status,'accepted');assert.equal((await deny).behavior,'deny'); queue.push({type:'user',message:{content:[{type:'tool_result',tool_use_id:'approval'}]}});wake?.();await tick();assert.equal(store.getInteraction(a.interactionId).nativeResult?.status,'unknown');assert.equal(store.getInteraction(a.interactionId).status,'resolved');assert.equal(store.getOutbox('deny').state,'unknown');
    ac=new AbortController();const expired=options.canUseTool('Bash',{command:'true'},{signal:ac.signal,toolUseID:'expired'});const e=last();ac.abort();await expired;assert.equal(store.getInteraction(e.interactionId).status,'expired');await assert.rejects(core.resolveInteraction(response(e,'stale',{kind:'approval',decision:'allow',scope:'this_request'})));await tick();
  } finally {core.close();query.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('native request snapshot and pending intent survive reopening without fabricating revision', () => {
  const dir=mkdtempSync(join(tmpdir(),'c1-reopen-'));const path=join(dir,'db');let store=new UnifiedStore(path);store.insertSession(session('codex','h','v','native'));store.setConnectionGeneration('unified',0,1);
  const original:Interaction={interactionId:'i',sessionId:'native',turnId:'t',nativeRequestId:'r',connectionGeneration:1,revision:41,status:'awaiting_answer',expiresAt:null,toolInputDigest:null,nativeResult:null,kind:'question',prompt:'?',choices:['x'],multiple:false,allowFreeText:false};
  try {store.insertInteraction({...original,sessionId:'unified'},original);store.resolveInteraction(response({...original,sessionId:'unified'},'op',{kind:'question',values:['x']}));store.close();store=new UnifiedStore(path);assert.deepEqual(store.getNativeInteraction('i'),original);assert.equal(store.getInteraction('i').revision,42);assert.equal(store.getOutbox('op').state,'pending');}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('missing adapter guard is unknown and never automatically resent', async () => {
  const dir=mkdtempSync(join(tmpdir(),'c1-guard-'));const store=new UnifiedStore(join(dir,'db'));store.insertSession(session('codex','h','v','native'));let writes=0;
  const port:any={provider:'codex',onObservation:()=>()=>{},input:async()=>{writes++;return {status:'submitted',nativeReference:null};}};const core=new UnifiedCore(store,[port],()=>true);
  try {await core.submitInput({context:{targetId:'unified',operationId:'op',idempotencyKey:'op',expectedRevision:0,controlGeneration:1,identity:{subject:'u',source:'test'}},mode:'new',blocks:[{type:'text',text:'x'}]});assert.equal((await core.dispatch('op')).status,'unknown');await core.dispatchPending();assert.equal(writes,1);}finally{core.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('terminal unknown cancels unsent intent; nonterminal unknown does not imply resolution', () => {
  for (const terminal of [true,false]) { const dir=mkdtempSync(join(tmpdir(),'c1-terminal-'));const store=new UnifiedStore(join(dir,'db'));store.insertSession(session('codex','h','v','native'));store.setConnectionGeneration('unified',0,1);
    const i:Interaction={interactionId:'i',sessionId:'unified',turnId:'t',nativeRequestId:'r',connectionGeneration:1,revision:2,status:'awaiting_answer',expiresAt:null,toolInputDigest:null,nativeResult:null,kind:'question',prompt:'?',choices:['x'],multiple:false,allowFreeText:false};
    try {store.insertInteraction(i);store.resolveInteraction(response(i,'op',{kind:'question',values:['x']}));const updated=store.recordNativeResult('i',1,'r',{status:'unknown',source:'unknown'},terminal);assert.equal(updated.status,terminal?'resolved':'answer_pending_delivery');assert.equal(updated.nativeResult?.status,'unknown');assert.equal(store.getOutbox('op').state,terminal?'cancelled':'pending');}finally{store.close();rmSync(dir,{recursive:true,force:true});}
  }
});
