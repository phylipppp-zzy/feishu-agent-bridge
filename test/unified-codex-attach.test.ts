import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexTransport, type SocketFactory } from '../src/unified/codex-transport.js';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import { UnifiedCore } from '../src/unified/service.js';
import { UnifiedStore } from '../src/unified/store.js';
const thread={id:'native',cwd:'/trusted',status:{type:'idle'},turns:[]};
class Socket extends EventTarget {
 readyState=0; sent:any[]=[]; rejectResume=false;
 send(raw:string){const m=JSON.parse(raw);this.sent.push(m);if(!m.id || !m.method)return;const result=m.method==='thread/read'?{thread}:m.method==='thread/resume'?{thread}:m.method==='thread/unsubscribe'?{status:'unsubscribed'}:m.method==='turn/start'?{turn:{id:crypto.randomUUID()}}:{};queueMicrotask(()=>this.message(this.rejectResume && m.method==='thread/resume'?{id:m.id,error:{code:-32000}}:{id:m.id,result}));}
 open(){this.readyState=1;this.dispatchEvent(new Event('open'));} close(){this.readyState=3;this.dispatchEvent(new Event('close'));} message(m:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(m)}));}
}
const context=(id:string,targetId='new',revision=0,generation=0)=>({targetId,operationId:id,idempotencyKey:id,expectedRevision:revision,controlGeneration:generation,identity:{subject:'u',source:'trusted'}});
const payload={provider:'codex' as const,hostId:'h',serviceId:'v',nativeSessionId:'native',mode:'interactive' as const};
function backend(){let socket!:Socket;const transport=new CodexTransport('ws://localhost:1',(()=>{socket=new Socket();queueMicrotask(()=>socket.open());return socket;}) as unknown as SocketFactory,200);const adapter=new CodexAdapter(transport,'h','v');return {transport,adapter,get socket(){return socket;}};}
const err=(c:string)=>(e:unknown)=>((e as any).code ?? (e as any).detail?.code)===c;
test('authorized existing session attach, release, reacquire and restart retain native identity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'codex-attach-'));const path=join(dir,'db');let store=new UnifiedStore(path);let b=backend();await b.transport.connect();let core=new UnifiedCore(store,[b.adapter],()=>true,()=>true,()=>false,s=>s.project==='/trusted');
 try {
  const a=await core.attachSession({context:context('attach'),payload});const sid=(a.result as {sessionId:string}).sessionId;let s=await core.getSession(sid); assert.equal(s.native.nativeSessionId,'native');assert.equal(s.control.input,'available');assert.equal(b.socket.sent.filter(x=>x.method==='thread/resume').length,1);const oldGeneration=store.connectionGeneration(sid);
  let req={context:context('input',sid,s.revision,s.control.generation),mode:'new' as const,blocks:[{type:'text' as const,text:'hello'}]};await core.submitInput(req);assert.equal((await core.dispatch('input')).status,'accepted');
  b.socket.message({id:77,method:'item/tool/requestUserInput',params:{threadId:'native',turnId:'turn',questions:[{id:'q',question:'Choose'}]}}); await new Promise(resolve=>setImmediate(resolve)); const oldInteraction=store.snapshot(sid).value.interactions.at(-1)!;
  s=await core.getSession(sid);await core.releaseControl({context:context('release',sid,s.revision,s.control.generation),payload:{owner:'v'}});await core.dispatch('release');await new Promise(resolve=>setImmediate(resolve));s=await core.getSession(sid);assert.equal(s.control.input,'unavailable');const count=b.socket.sent.filter(x=>x.method==='turn/start').length;
  await assert.rejects(core.submitInput({...req,context:context('blocked',sid,s.revision,s.control.generation)}));assert.equal(b.socket.sent.filter(x=>x.method==='turn/start').length,count);
  await core.requestControl({context:context('acquire',sid,s.revision,s.control.generation),payload:{owner:'v',strategy:'wait'}});await core.dispatch('acquire');await new Promise(resolve=>setImmediate(resolve));s=await core.getSession(sid);assert.equal(s.control.input,'available');
  core.close();b.transport.close();store.close();store=new UnifiedStore(path);b=backend();await b.transport.connect();core=new UnifiedCore(store,[b.adapter],()=>true,()=>true,()=>false,x=>x.project==='/trusted');
  const prior=await core.getSession(sid);assert.equal(prior.control.input,'unavailable'); await assert.rejects(core.submitInput({...req,context:context('restart-blocked',sid,prior.revision,prior.control.generation)}));
  const resumed=await core.attachSession({context:context('reattach'),payload});assert.equal((resumed.result as {sessionId:string}).sessionId,sid);s=await core.getSession(sid);assert.equal(s.control.input,'available');assert.ok(store.connectionGeneration(sid)>oldGeneration);assert.ok(s.control.generation>1);
  await assert.rejects(b.adapter.respond(payload,oldInteraction,{kind:'question_group',answers:{q:['old']}},{expectedConnectionGeneration:oldGeneration,expectedControlGeneration:1,assertCurrent(){}}),err('interaction_expired'));
  req={...req,context:context('after-restart',sid,s.revision,s.control.generation)};await core.submitInput(req);assert.equal((await core.dispatch('after-restart')).status,'accepted');
 } finally {core.close();b.transport.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('read only, untrusted actor or project never resumes; rejected native resume never attaches',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'codex-attach-'));const store=new UnifiedStore(join(dir,'db'));const b=backend();await b.transport.connect();let allow=false;let trusted=true;const core=new UnifiedCore(store,[b.adapter],()=>allow,()=>true,()=>false,s=>trusted && s.project==='/trusted');
 try {await assert.rejects(core.attachSession({context:context('no'),payload}),err('unauthorized'));assert.equal(b.socket.sent.filter(x=>x.method==='thread/resume').length,0);allow=true;trusted=false; await assert.rejects(core.attachSession({context:context('outside-root'),payload}),err('unauthorized')); assert.equal(b.socket.sent.filter(x=>x.method==='thread/resume').length,0); trusted=true;
 await core.attachSession({context:context('readonly'),payload:{...payload,mode:'read_only'}});assert.equal(b.socket.sent.filter(x=>x.method==='thread/resume').length,0);
 b.socket.rejectResume=true;await assert.rejects(core.attachSession({context:context('conflict'),payload}),err('temporarily_unavailable'));assert.equal(store.listSessions()[0]!.control.input,'unavailable');
 }finally{core.close();b.transport.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
