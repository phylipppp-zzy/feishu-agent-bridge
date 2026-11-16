import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DispatchGuard, PlatformPort } from '../src/unified/adapter.js';
import type { Capabilities, Provider, Session, SubmitInput } from '../src/unified/contracts.js';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedCore } from '../src/unified/service.js';

for (const provider of ['claude', 'codex'] as Provider[]) test(`${provider}: persisted input, duplicate, unknown recovery and terminal answer`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-')); const path = join(dir,'state.db');
  const capabilities = Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k => [k,{status:'available'}])) as Capabilities;
  const session: Session = { sessionId:'s', native:{provider,hostId:'h',serviceId:'v',nativeSessionId:'n'}, title:'same',project:'p',status:'idle',revision:0,capabilities,control:{serviceId:'v',owner:'o',input:'available',generation:1,operationId:null,reason:null} };
  let sends = 0; let fail = true;
  const port = { provider, onObservation: () => () => {}, input: async (_ref: unknown, _mode: unknown, _blocks: unknown, guard: DispatchGuard) => { guard.assertCurrent(); sends++; if (fail) throw new Error('lost receipt'); return { status:'submitted',nativeReference:null }; } } as unknown as PlatformPort;
  let store = new UnifiedStore(path); store.insertSession(session); store.setConnectionGeneration('s',0,1);
  let core = new UnifiedCore(store,[port],() => true);
  const input: SubmitInput = { context:{operationId:'x',idempotencyKey:'k',targetId:'s',expectedRevision:0,controlGeneration:1,identity:{subject:'u',source:'test'}},mode:'new',blocks:[{type:'text',text:'hello'}] };
  try {
    assert.equal((await core.submitInput(input)).status,'received'); assert.equal((await core.submitInput(input)).operationId,'x');
    assert.equal((await core.dispatch('x')).status,'unknown'); core.close(); store.close();
    store = new UnifiedStore(path); core = new UnifiedCore(store,[port],() => true); fail = false;
    await core.dispatchPending(); assert.equal(sends,1); assert.equal((await core.getOperation('x')).status,'unknown');
    store.insertInteraction({interactionId:'i',sessionId:'s',turnId:'t',nativeRequestId:'r',connectionGeneration:1,revision:0,status:'awaiting_answer',expiresAt:null,toolInputDigest:null,nativeResult:null,kind:'question',prompt:'?',choices:['a'],multiple:false,allowFreeText:false});
    await core.resolveInteraction({context:{...input.context,operationId:'a',idempotencyKey:'a'},interactionId:'i',expectedConnectionGeneration:1,answer:{kind:'question',values:['a']},toolInputDigest:null});
    const i = store.getInteraction('i'); await core.observe({type:'interaction',ref:session.native,interaction:{...i,nativeResult:{status:'accepted',source:'terminal',answer:null}}});
    assert.equal(store.getInteraction('i').status,'resolved'); assert.equal(store.getOutbox('a').state,'cancelled');
  } finally { core.close(); store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('one core routes both providers, attach, queue cancellation and create unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(),'core-both-')); const path = join(dir,'db'); const store = new UnifiedStore(path);
  const caps = Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k => [k,{status:'available'}])) as Capabilities;
  const calls: string[] = [];
  const ports = (['claude','codex'] as Provider[]).map(provider => ({provider,onObservation:() => () => {}, read:async (ref: Session['native']) => ({session:{sessionId:'native',native:ref,title:provider,project:'p',status:'idle',revision:0,capabilities:caps,control:{serviceId:'v',owner:'o',input:'available',generation:0,operationId:null,reason:null}},messages:[],interactions:[],connectionGeneration:0}), resume:async (ref:Session['native'])=>({status:'submitted',nativeReference:ref.nativeSessionId,connectionGeneration:0}), input:async (_r: unknown,_m:unknown,_b:unknown,g:DispatchGuard) => {g.assertCurrent(); calls.push(provider); return {status:'submitted',nativeReference:null};},create:async () => {calls.push('create'); return {status:'submitted',nativeReference:null};}} as unknown as PlatformPort));
  const core = new UnifiedCore(store,ports,() => true,() => true);
  const context = (targetId:string, id:string) => ({targetId,operationId:id,idempotencyKey:id,expectedRevision:0,controlGeneration:0,identity:{subject:'u',source:'test'}});
  try {
    for (const provider of ['claude','codex'] as Provider[]) {
      const attached = await core.attachSession({context:context(provider,`attach-${provider}`),payload:{provider,hostId:'h',serviceId:'v',nativeSessionId:provider,mode:'interactive'}}); const sid = (attached.result as {sessionId:string}).sessionId;
      const req: SubmitInput = {context:context(sid,`input-${provider}`),mode:'new',blocks:[{type:'text',text:'same'}]}; await core.submitInput(req); assert.equal((await core.dispatch(req.context.operationId)).status,'accepted');
      const queued: SubmitInput = {context:context(sid,`queue-${provider}`),mode:'queue',blocks:[{type:'text',text:'later'}]}; await core.submitInput(queued);
      await core.cancelQueuedInput({context:context(sid,`cancel-${provider}`),payload:{inputId:queued.context.operationId}}); assert.equal(store.getOutbox(queued.context.operationId).state,'cancelled');
    }
    assert.deepEqual(calls,['claude','codex']);
    const create = {context:context('future','create'),payload:{provider:'codex' as const,project:'p',model:null}};
    await core.createSession(create); assert.equal((await core.dispatch('create')).status,'unknown'); assert.equal((await core.createSession(create)).status,'unknown'); await core.dispatch('create'); assert.equal(calls.filter(x => x === 'create').length,1);
    assert.equal((await core.listSessions({limit:10})).items.length,2);
  } finally { core.close(); store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('recovery leaves active worker alone and fences expired lease', () => {
  const dir = mkdtempSync(join(tmpdir(),'core-lease-')); const path = join(dir,'db'); const a = new UnifiedStore(path); const b = new UnifiedStore(path);
  try {
    const gen = a.acquireDispatchLease('s','worker',100,50); assert.equal(gen,1); assert.equal(b.acquireDispatchLease('s','other',120,50),null);
    assert.doesNotThrow(() => a.assertDispatchLease('s','worker',gen!,149)); assert.throws(() => a.assertDispatchLease('s','worker',gen!,150));
    const gen2 = b.acquireDispatchLease('s','other',150,50); assert.equal(gen2,2); assert.throws(() => a.assertDispatchLease('s','worker',gen!,151));
    a.releaseDispatchLease('s','worker',gen!); assert.doesNotThrow(() => b.assertDispatchLease('s','other',gen2!,151));
  } finally { a.close(); b.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('creation completes only after unique native reference is listed', async () => {
  const dir = mkdtempSync(join(tmpdir(),'core-create-')); const store = new UnifiedStore(join(dir,'db'));
  const caps = Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k => [k,{status:'available'}])) as Capabilities;
  const native: Session = {sessionId:'provider-local',native:{provider:'codex',hostId:'h',serviceId:'v',nativeSessionId:'created'},title:'new',project:'p',status:'idle',revision:0,capabilities:caps,control:{serviceId:'v',owner:'o',input:'available',generation:0,operationId:null,reason:null}};
  const port = {provider:'codex',onObservation:()=>()=>{},create:async()=>({status:'submitted',nativeReference:'created',connectionGeneration:0}),list:async()=>({items:[native],nextCursor:null})} as unknown as PlatformPort;
  const core = new UnifiedCore(store,[port],()=>true,()=>true);
  try { await core.createSession({context:{targetId:'unified',operationId:'create',idempotencyKey:'create',expectedRevision:0,controlGeneration:0,identity:{subject:'u',source:'test'}},payload:{provider:'codex',project:'p',model:null}}); const done=await core.dispatch('create'); assert.equal(done.status,'completed'); assert.equal((await core.getSession((done.result as {sessionId:string}).sessionId)).native.nativeSessionId,'created'); } finally {core.close(); store.close(); rmSync(dir,{recursive:true,force:true});}
});

test('staged artifact is digest-checked, session-scoped and delivered as bytes', async () => {
  const {createHash} = await import('node:crypto'); const dir = mkdtempSync(join(tmpdir(),'core-artifact-')); const store = new UnifiedStore(join(dir,'db'));
  const caps = Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k => [k,{status:'available'}])) as Capabilities;
  const session: Session = {sessionId:'s',native:{provider:'claude',hostId:'h',serviceId:'v',nativeSessionId:'n'},title:'x',project:'p',status:'idle',revision:0,capabilities:caps,control:{serviceId:'v',owner:'o',input:'available',generation:0,operationId:null,reason:null}}; store.insertSession(session);
  let received: unknown; const port = {provider:'claude',onObservation:()=>()=>{},input:async (_r:unknown,_m:unknown,blocks:unknown,g:DispatchGuard)=>{g.assertCurrent();received=blocks;return {status:'submitted',nativeReference:null};}} as unknown as PlatformPort; const core = new UnifiedCore(store,[port],()=>true);
  const context = (id:string) => ({targetId:'s',operationId:id,idempotencyKey:id,expectedRevision:0,controlGeneration:0,identity:{subject:'u',source:'test'}});
  try { const content = new TextEncoder().encode('hello'); const digest = createHash('sha256').update(content).digest('hex'); await core.stageInputArtifact({context:context('file'),payload:{name:'a.txt',mediaType:'text/plain',size:content.length,contentDigest:digest,content}}); assert.deepEqual(await core.readArtifact('s','file',digest),content); await core.submitInput({context:context('send'),mode:'new',blocks:[{type:'artifact',artifactId:'file',contentVersion:digest}]}); await core.dispatch('send'); assert.deepEqual(received,[{type:'artifact',artifactId:'file',contentVersion:digest,name:'a.txt',mediaType:'text/plain',content}]); assert.throws(()=>store.stagedArtifact('other','file',digest)); } finally {core.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('operation results validate their discriminated shape', async () => {
  const {schemas} = await import('../src/unified/validation.js');
  const op = {operationId:'x',idempotencyKey:'x',targetId:'s',action:'stageInputArtifact',payloadDigest:'abc',status:'completed',revision:1,error:null};
  assert.equal(schemas.operation!(op),true); assert.equal(schemas.operation!({...op,result:{kind:'artifact',artifactId:'f',contentVersion:'v'}}),true); assert.equal(schemas.operation!({...op,result:{kind:'session',sessionId:'s'}}),true); assert.equal(schemas.operation!({...op,result:{kind:'artifact',artifactId:'f'}}),false); assert.equal(schemas.operation!({...op,result:{kind:'unknown'}}),false);
});
