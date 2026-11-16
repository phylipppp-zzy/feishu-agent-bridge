import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UnifiedRuntime } from '../src/unified/runtime.js';
import { CodexAdapter } from '../src/unified/codex-adapter.js';

class FakeTransport {
  generation=1; connected=true; calls:string[]=[]; project='/work';
  seedGeneration(n:number){this.generation=Math.max(this.generation,n)+1;}
  async request(method:string):Promise<any>{this.calls.push(method); const thread={id:'t',cwd:this.project,status:{type:'idle'},turns:[{id:'turn',items:[{id:'answer',type:'agentMessage',text:'finished'}]}]}; if(['thread/start','thread/read','thread/resume'].includes(method)) return {thread}; throw Error(method);}
}
const port={async send(){return 'm'},async update(){},async sendFile(){}};
const identity={source:'feishu',subject:'owner'};
test('restart recovers only authorized interactive bindings with real CodexAdapter, no turn replay',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat','second','ro'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://localhost:1',intervalMs:100};
 const cards:any[]=[];const replyPort={...port,async send(_destination:string,card:any){cards.push(card);return 'm';}};let tr=new FakeTransport(); let r=new UnifiedRuntime(config,replyPort,[new CodexAdapter(tr as any,'h','x')]);
 try {
  const context={operationId:'create',idempotencyKey:'create',targetId:'new',expectedRevision:0,controlGeneration:0,identity};
  await r.core.createSession({context,payload:{provider:'codex',project:'/work',model:null}}); const op=await r.core.dispatch('create');assert.equal(op.status,'completed');const id=(op.result as any).sessionId;
  await r.core.createSession({context:{...context,operationId:'unknown',idempotencyKey:'unknown'},payload:{provider:'codex',project:'/work',model:null}});r.store.claimCreate('unknown');r.store.markDeliveryUnknown('unknown');
  const s=await r.core.getSession(id);await r.core.submitInput({context:{...context,operationId:'pending',idempotencyKey:'pending',targetId:id,expectedRevision:s.revision,controlGeneration:s.control.generation},mode:'new',blocks:[{type:'text',text:'not sent'}]});
  const db=new DatabaseSync(config.channelDb);for(const [destination,mode] of [['chat','interactive'],['second','interactive'],['ro','read_only']] as const) db.prepare('INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode) VALUES(?,?,?,?,?,?,?)').run(destination,id,destination,'feishu','owner',1,mode);db.close();
  const b=r.channel.bindingsForRestore()[0]!;assert.equal(await r.channel.isRestoreBindingAuthorized(b),true);assert.equal(await r.channel.isRestoreBindingAuthorized({...b,revision:2}),false);
  await r.close();tr=new FakeTransport();r=new UnifiedRuntime(config,replyPort,[new CodexAdapter(tr as any,'h','x')]);assert.equal((await r.core.getSession(id)).control.input,'unavailable');assert.equal((await r.core.getOperation('pending')).status,'failed');await r.restoreBindings();assert.equal((await r.core.getOperation('unknown')).status,'unknown');assert.equal((await r.core.getSession(id)).control.input,'available');assert.equal(tr.calls.filter(x=>x==='thread/resume').length,1);assert.equal(tr.calls.filter(x=>x==='thread/start').length,0);assert.equal(tr.calls.filter(x=>x==='turn/start').length,0);assert.equal((await r.core.readHistory(id,{limit:10})).items[0]?.messageId,'answer');await r.handleTrusted({eventId:'check-pending',destination:'chat',identity},{action:'reconcile',operationId:'pending'});await r.tick();assert.ok(cards.some(card=>card.text.includes('submitInput: failed')));
  await r.close();tr=new FakeTransport();r=new UnifiedRuntime({...config,ownerOpenId:'revoked'},port,[new CodexAdapter(tr as any,'h','x')]);await r.restoreBindings();assert.equal(tr.calls.includes('thread/resume'),false);
  await r.close();const db2=new DatabaseSync(config.channelDb);db2.prepare("UPDATE channel_bindings SET access_mode='read_only'").run();db2.close();tr=new FakeTransport();r=new UnifiedRuntime(config,port,[new CodexAdapter(tr as any,'h','x')]);await r.restoreBindings();assert.equal(tr.calls.includes('thread/resume'),false);
  await r.close();const db3=new DatabaseSync(config.channelDb);db3.prepare("UPDATE channel_bindings SET access_mode='interactive' WHERE destination='chat'").run();db3.close();tr=new FakeTransport();tr.project='/changed';r=new UnifiedRuntime(config,port,[new CodexAdapter(tr as any,'h','x')]);await r.restoreBindings();assert.equal(tr.calls.includes('thread/resume'),false);assert.equal(r.health().status,'degraded');
 } finally {await r.close();rmSync(dir,{recursive:true,force:true});}
});

for(const failRelease of [false,true]) test(`revocation releases or quarantines unknown release (${failRelease}) and fences late observations`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-fence-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://localhost:1',intervalMs:100};
 let authorized=true; const channelPort={...port,authorizedDestination:()=>authorized};let tr=new FakeTransport();let r=new UnifiedRuntime(config,channelPort,[new CodexAdapter(tr as any,'h','x')]);
 try {
  const context={operationId:'create',idempotencyKey:'create',targetId:'new',expectedRevision:0,controlGeneration:0,identity};await r.core.createSession({context,payload:{provider:'codex',project:'/work',model:null}});const id=((await r.core.dispatch('create')).result as any).sessionId;
  const db=new DatabaseSync(config.channelDb);db.prepare('INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode) VALUES(?,?,?,?,?,?,?)').run('chat',id,'b','feishu','owner',1,'interactive');db.close();await r.close();
  tr=new FakeTransport();const adapter=new CodexAdapter(tr as any,'h','x');r=new UnifiedRuntime(config,channelPort,[adapter]);let reads=0;const request=tr.request.bind(tr);tr.request=async(method:string)=>{if(method==='thread/read' && ++reads===3)authorized=false;if(method==='thread/unsubscribe'){tr.calls.push(method);if(failRelease)throw Error('lost receipt');return {status:'unsubscribed'};}return request(method);};
  await r.restoreBindings();assert.equal(tr.calls.filter(x=>x==='thread/unsubscribe').length,1);assert.equal(r.health().status,'degraded');assert.equal((await r.core.getSession(id)).control.input,'unavailable');assert.equal(r.store.recoveryQuarantined(id),true);
  const reason=(await r.core.health()).find(x=>x.component==='core')?.reason;assert.match(reason ?? '',failRelease ? /release outcome unknown/ : /subscription released/);
  (tr as any).onMessage({method:'item/completed',params:{threadId:'t',turnId:'late-turn',item:{id:'late',type:'agentMessage',text:'late'}}},tr.generation);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal((await r.core.readHistory(id,{limit:20})).items.some(m=>m.messageId==='late'),false);
  const current=await r.core.getSession(id);await assert.rejects(r.core.attachSession({context:{...context,operationId:'explicit-same',idempotencyKey:'explicit-same',targetId:id,expectedRevision:current.revision,controlGeneration:current.control.generation},payload:{...current.native,mode:'interactive'}}));
  await r.close();authorized=true;tr=new FakeTransport();r=new UnifiedRuntime(config,channelPort,[new CodexAdapter(tr as any,'h','x')]);await r.restoreBindings();assert.equal(tr.calls.includes('thread/resume'),false);const reopened=await r.core.getSession(id);await r.core.attachSession({context:{...context,operationId:'explicit-new',idempotencyKey:'explicit-new',targetId:id,expectedRevision:reopened.revision,controlGeneration:reopened.control.generation},payload:{...reopened.native,mode:'interactive'}});assert.equal(r.store.recoveryQuarantined(id),false);assert.equal((await r.core.getSession(id)).control.input,'available');
 } finally {await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('another currently authorized binding keeps the same session during recovery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-other-binding-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['a','b'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://localhost:1',intervalMs:100};let revoke=false;const channelPort={...port,authorizedDestination:(d:string)=>d==='b'||!revoke};let tr=new FakeTransport();let r=new UnifiedRuntime(config,channelPort,[new CodexAdapter(tr as any,'h','x')]);
 try {const context={operationId:'c',idempotencyKey:'c',targetId:'new',expectedRevision:0,controlGeneration:0,identity};await r.core.createSession({context,payload:{provider:'codex',project:'/work',model:null}});const id=((await r.core.dispatch('c')).result as any).sessionId;const db=new DatabaseSync(config.channelDb);for(const destination of ['a','b'])db.prepare('INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode) VALUES(?,?,?,?,?,?,?)').run(destination,id,destination,'feishu','owner',1,'interactive');db.close();await r.close();tr=new FakeTransport();r=new UnifiedRuntime(config,channelPort,[new CodexAdapter(tr as any,'h','x')]);let reads=0;const request=tr.request.bind(tr);tr.request=async(method:string)=>{if(method==='thread/read' && ++reads===3)revoke=true;return request(method);};await r.restoreBindings();assert.equal((await r.core.getSession(id)).control.input,'available');assert.equal(tr.calls.filter(x=>x==='thread/resume').length,1);assert.equal(tr.calls.includes('thread/unsubscribe'),false);assert.equal(r.store.recoveryQuarantined(id),false);
 } finally {await r.close();rmSync(dir,{recursive:true,force:true});}
});
