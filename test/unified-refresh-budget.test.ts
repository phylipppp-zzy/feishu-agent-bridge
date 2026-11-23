import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIntegratedRuntime} from '../src/unified/runtime.js';
import type {Session,Capabilities} from '../src/unified/contracts.js';

async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'refresh-budget-')),project=join(dir,'project'),outside=join(dir,'outside'),logs=join(dir,'logs');
  for(const p of [project,outside,logs]) mkdirSync(p);
  const caps=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:'unsupported'}])) as Capabilities;
  const session=(id:string,cwd=project):Session=>({sessionId:id,native:{provider:'claude',hostId:'h',serviceId:'c',nativeSessionId:id},project:cwd,title:id,status:'read_only',revision:0,capabilities:caps,control:{serviceId:'c',owner:null,input:'unavailable',generation:0,operationId:null,reason:null}});
  const sessions=Array.from({length:5},(_,i)=>session(`n${i}`)),reads:string[]=[];let fail:string|null=null;
  const base:any={provider:'claude',onObservation:()=>()=>{},list:async()=>({items:[...sessions,session('outside',outside)],nextCursor:null}),read:async(ref:any)=>{reads.push(ref.nativeSessionId);if(ref.nativeSessionId===fail)throw Error('read unavailable');return {session:sessions.find(s=>s.native.nativeSessionId===ref.nativeSessionId)!,messages:[],interactions:[]};}};
  let sent=0;const port={async send(){sent++;return `m${sent}`;},async update(){},async sendFile(){}};
  const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'artifacts'),ownerOpenId:'owner',allowedDestinations:['chat','chat0','chat1','chat2','chat3','chat4'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'claude'),codexEndpoint:'codex-proxy://default',intervalMs:100,catalogSources:[{provider:'claude' as const,directory:logs,hostId:'h',serviceId:'c'}],allowedProjectRoots:[project],outputRoots:[project]};
  const runtime=await createIntegratedRuntime(config,port,[base]);
  return {runtime,sessions,reads,setFail:(id:string|null)=>{fail=id;},get sent(){return sent;},async close(){await runtime.close();rmSync(dir,{recursive:true,force:true});}};
}

test('native discovery filters outside projects without poisoning runtime health',async()=>{
  const f=await fixture();try{const page=await f.runtime.core.listSessions({limit:10});assert.equal(page.items.length,5);assert.ok(page.items.every(s=>s.native.nativeSessionId!=='outside'));await f.runtime.tick();assert.equal(f.runtime.health().status,'healthy');}finally{await f.close();}
});

test('read-only refresh has a per-tick budget and visits every session while inbox work proceeds',async()=>{
  const f=await fixture();try{
    for(const [i,s] of f.sessions.entries()) {f.runtime.store.insertSession(s);await f.runtime.channel.handle({eventId:`bind${i}`,destination:`chat${i}`,identity:{source:'feishu',subject:'owner'}},{action:'bind',sessionId:s.sessionId,mode:'read_only'});} f.reads.length=0;
    const sentBefore=f.sent;const envelope={eventId:'health',destination:'chat',identity:{source:'feishu',subject:'owner'}};
    await f.runtime.handleTrusted(envelope,{action:'health'});
    await f.runtime.tick();assert.equal(f.sent,sentBefore+1);assert.equal(f.reads.length,2);
    await f.runtime.tick();assert.equal(f.reads.length,4);
    await f.runtime.tick();assert.equal(f.reads.length,6);assert.equal(new Set(f.reads).size,5);
  }finally{await f.close();}
});

test('one failed history read does not starve its neighbor or later refresh batches',async()=>{
  const f=await fixture();try{
    for(const [i,s] of f.sessions.entries()) {f.runtime.store.insertSession(s);await f.runtime.channel.handle({eventId:`bind${i}`,destination:`chat${i}`,identity:{source:'feishu',subject:'owner'}},{action:'bind',sessionId:s.sessionId,mode:'read_only'});} f.reads.length=0;
    f.setFail('n0');await assert.rejects(f.runtime.tick());assert.deepEqual(f.reads,['n0','n1']);
    await f.runtime.tick();assert.deepEqual(f.reads,['n0','n1','n2','n3']);
    f.setFail(null);await f.runtime.tick();assert.equal(new Set(f.reads).size,5);assert.equal(f.runtime.health().status,'healthy');
  }finally{await f.close();}
});
