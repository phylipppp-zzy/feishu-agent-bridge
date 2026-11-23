import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCatalog } from '../src/unified/local-catalog.js';
import { ArtifactRegistry } from '../src/unified/artifact-registry.js';
import { EnrichedPort, nativeRefKey } from '../src/unified/port-enrichment.js';
import { UnifiedCore } from '../src/unified/service.js';
import { UnifiedStore } from '../src/unified/store.js';
import type { PlatformObservation, PlatformPort } from '../src/unified/adapter.js';
import type { Session } from '../src/unified/contracts.js';
import { contractError } from '../src/unified/errors.js';

for (const provider of ['codex','claude'] as const) test(`${provider}: decorated discovery, read, observation, core artifact route and restart`, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'enriched-'));
  try {
    const logs=join(dir,'logs'), output=join(dir,'output'), state=join(dir,'registry.json'); await mkdir(logs); await mkdir(output);
    const ref={provider,hostId:'h',serviceId:'s',nativeSessionId:'native'};
    const rows=provider==='codex' ? [{type:'session_meta',payload:{id:'native',cwd:output}},{type:'response_item',timestamp:'2026-01-01',payload:{type:'message',role:'user',content:[{type:'input_text',text:'hello'}]}}] : [{type:'user',uuid:'m1',cwd:output,message:{content:'hello'}}];
    await writeFile(join(logs,'native.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
    const cat = new LocalCatalog([{provider,directory:logs,hostId:'h',serviceId:'s'}]);
    const reg = new ArtifactRegistry({},100,state); await reg.load(); assert.deepEqual(reg.getRoots(ref),[]); reg.setRoots(ref,[output]);
    let emit:(o:PlatformObservation)=>void = ()=>{}; let baseReads=0;
    const base:any={provider,onObservation:(f:typeof emit)=>{emit=f;return ()=>{};},list:async()=>({items:[],nextCursor:null}),listArtifacts:async()=>{throw contractError('unsupported');},readArtifact:async()=>{baseReads++;throw contractError('unsupported');}};
    const errors:unknown[]=[]; const port=new EnrichedPort(base as PlatformPort,cat,reg,e=>errors.push(e));
    const page=await port.list(null,1); assert.equal(page.items.length,1); assert.deepEqual(page.items[0]?.native,ref); assert.equal((await port.read(ref)).session.status,'read_only');
    await assert.rejects(port.resume(ref),e=>(e as any).code==='unsupported');
    const db=join(dir,'core.sqlite'), store=new UnifiedStore(db), core=new UnifiedCore(store,[port],()=>true);
    const ctx={targetId:'u',operationId:'attach',idempotencyKey:'attach',expectedRevision:1,controlGeneration:0,identity:{subject:'u',source:'test'}};
    try {
      const attached=await core.attachSession({context:ctx,payload:{...ref,mode:'read_only'}}); assert.equal(attached.result?.kind,'session'); const sessionId=(attached.result as {kind:'session';sessionId:string}).sessionId; assert.equal((await core.getSession(sessionId)).native.nativeSessionId,'native');
      const path=join(output,'result.txt'), second=join(output,'relative.txt'), outside=join(dir,'private'); await writeFile(path,'hello'); await writeFile(second,'relative'); await writeFile(outside,'secret'); await symlink(outside,join(output,'escape'));
      const message={messageId:'m',sessionId:'native',turnId:'t',role:'assistant' as const,blocks:[{type:'text' as const,text:`[output](${path}) [relative](relative.txt) [again](localfile://${path}) [escape](localfile://${join(output,'escape')})`}],sequence:1,revision:1,final:true,source:'test'};
      const observed:PlatformObservation[]=[];port.onObservation(o=>observed.push(o));emit({type:'message',ref,message}); await port.drain();
      assert.equal(errors.length,0); const events=observed.filter(o=>o.type==='event'); assert.equal(events.length,2); for(const o of events) if(o.type==='event') assert.ok(Math.abs(Date.now()-Date.parse(o.event.occurredAt))<5000); emit({type:'message',ref,message}); await port.drain(); const replay=observed.filter(o=>o.type==='event'); assert.equal(replay.length,4); if (replay[0]?.type==='event' && replay[2]?.type==='event') assert.equal(replay[0].event.occurredAt,replay[2].event.occurredAt);
      const arts=await core.listArtifacts(sessionId,{limit:10}); assert.equal(arts.items.length,2);const a=arts.items.find(x=>x.name==='result.txt')!; assert.equal(a.sessionId,sessionId);
      assert.equal(Buffer.from(await core.readArtifact(sessionId,a.artifactId,a.contentVersion)).toString(),'hello');
      const reg2=new ArtifactRegistry({},100,state);await reg2.load(); await assert.rejects(reg2.read(nativeRefKey(ref),a.artifactId,a.contentVersion)); reg2.setRoots(ref,[output]); assert.equal(Buffer.from(await reg2.read(nativeRefKey(ref),a.artifactId,a.contentVersion)).toString(),'hello');
      await assert.rejects(reg2.read('other',a.artifactId,a.contentVersion)); await writeFile(path,'new'); await assert.rejects(reg2.read(nativeRefKey(ref),a.artifactId,a.contentVersion));
      assert.equal(baseReads,0);
    } finally {core.close();store.close();await port.close();}
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('base sessions take precedence and merged pages retain their snapshot',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'merged-')); try {
    const lines=(id:string)=>JSON.stringify({type:'session_meta',payload:{id,cwd:'/same'}})+'\n';
    await writeFile(join(dir,'a.jsonl'),lines('a'));await writeFile(join(dir,'b.jsonl'),lines('b'));
    const cat=new LocalCatalog([{provider:'codex',directory:dir,hostId:'h',serviceId:'s'}]); await cat.refresh();
    const original=cat.list(10).items.find(s=>s.native.nativeSessionId==='a')!;
    const live:Session={...original,title:'live',status:'idle',control:{...original.control,input:'available'}};
    const base:any={provider:'codex',onObservation:()=>()=>{},list:async()=>({items:[live],nextCursor:null}),read:async()=>({session:live,messages:[],interactions:[]}),listArtifacts:async()=>[{artifactId:'native',sessionId:'a',name:'n',mediaType:'text/plain',size:1,contentVersion:'v'}],readArtifact:async()=>new Uint8Array([1])};
    const port=new EnrichedPort(base,cat,new ArtifactRegistry({}),()=>{});
    try {const p=await port.list(null,1);assert.ok(p.nextCursor);const q=await port.list(p.nextCursor,1);assert.equal(p.items.length+q.items.length,2); assert.equal((await port.read(live.native)).session.title,'live');assert.equal((await port.listArtifacts(live.native))[0]?.artifactId,'native');assert.deepEqual(await port.readArtifact(live.native,'native','v'),new Uint8Array([1]));await writeFile(join(dir,'c.jsonl'),lines('c'));const stable=await port.list(p.nextCursor,1);assert.equal(stable.items.length,1);assert.equal(stable.nextCursor,null);const fresh=await port.list(null,10);assert.equal(fresh.items.length,3);assert.equal(fresh.items.find(x=>x.native.nativeSessionId==='a')?.title,'live');}finally{await port.close();}
  } finally {await rm(dir,{recursive:true,force:true});}
});

for (const hasArchive of [false,true]) test(`archive capability matches base and inherited wrapper (${hasArchive ? 'available' : 'unsupported'})`,async()=>{
 const {FeishuChannel}=await import('../src/unified/feishu-channel.js');const dir=await mkdtemp(join(tmpdir(),'enriched-archive-'));const logs=join(dir,'logs');await mkdir(logs);
 const rows=[{type:'user',uuid:'m',cwd:dir,message:{content:'hello'}}];await writeFile(join(logs,'external.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
 const ref={provider:'claude' as const,hostId:'h',serviceId:'s',nativeSessionId:'live'};const caps=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:'available'}]));
 const live={sessionId:'s',native:ref,title:'live',project:dir,status:'idle',revision:0,capabilities:caps,control:{serviceId:'s',owner:'owner',input:'available',generation:1,operationId:null,reason:null}} as Session;
 let calls=0,seenGuard:unknown;const base:any={provider:'claude',marker:'base',onObservation:()=>()=>{},list:async()=>({items:[live],nextCursor:null})};
 if(hasArchive) base.archive=async function(this:any,r:any,archived:boolean,guard:any){assert.equal(this.marker,'base');assert.deepEqual(r,ref);assert.equal(archived,true);seenGuard=guard;guard.assertCurrent();calls++;return {status:'submitted',nativeReference:null};};
 class ScopedPort extends EnrichedPort {} const cat=new LocalCatalog([{provider:'claude',directory:logs,hostId:'h',serviceId:'s'}]);const port=new ScopedPort(base,cat,new ArtifactRegistry({}),()=>{});const store=new UnifiedStore(join(dir,'db'));store.insertSession(live);const core=new UnifiedCore(store,[port],()=>true);const cards:any[]=[];const channel=new FeishuChannel(core,{send:async(_d,c)=>{cards.push(c);return 'm';},update:async()=>{},sendFile:async()=>{}},async()=>true,join(dir,'channel'));const env=(eventId:string)=>({eventId,destination:'chat',identity:{source:'feishu',subject:'owner'}});
 try {
  assert.equal(typeof port.archive,hasArchive ? 'function' : 'undefined');assert.equal((await core.getWorkState('s')).canArchive,hasArchive);
  const op:any=await channel.handle(env('bind'),{action:'bind',sessionId:'s',mode:'interactive'});await channel.handle(env('finish'),{action:'finish',operationId:op.operationId});await channel.handle(env('panel'),{action:'panel'});
  const button=cards.at(-1).actions.find((a:any)=>a.label==='归档');assert.equal(!!button,hasArchive);
  if(hasArchive){const receipt:any=await channel.handle(env('archive'),button.value);await core.dispatch(receipt.operationId);assert.equal(calls,1);assert.ok(seenGuard);const external={...ref,nativeSessionId:'external'};await assert.rejects(port.archive!(external,true,{expectedControlGeneration:0,expectedConnectionGeneration:null,assertCurrent(){throw Error('guard must not be called');}}),(e:any)=>e.code==='unsupported');assert.equal(calls,1);}
 }finally{channel.close();core.close();store.close();await port.close();await rm(dir,{recursive:true,force:true});}
});
