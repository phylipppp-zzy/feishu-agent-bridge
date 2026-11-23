import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIntegratedRuntime} from '../src/unified/runtime.js';
import type {Session,Capabilities} from '../src/unified/contracts.js';

test('auto mirror binds once, hydrates before sync, and never takes control',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'auto-ro-')),project=join(dir,'project'),logs=join(dir,'logs');mkdirSync(project);mkdirSync(logs);
 const caps=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:k==='view'?'available':'unsupported'}])) as Capabilities;
 const session:Session={sessionId:'n',native:{provider:'codex',hostId:'h',serviceId:'x',nativeSessionId:'n'},project,title:'active',status:'read_only',revision:0,capabilities:caps,control:{serviceId:'x',owner:null,input:'unavailable',generation:0,operationId:null,reason:null}};
 let creates=0,reads=0;const sent:string[]=[];const cards:any[]=[];const forbidden:string[]=[];let latest=false;
 const message=(id:string)=>({messageId:id,sessionId:'n',turnId:'t',role:'assistant',blocks:[{type:'text',text:id}],sequence:id==='old'?1:2,revision:1,final:true,source:'codex'});
 const base:any={provider:'codex',onObservation:()=>()=>{},list:async()=>({items:[session],nextCursor:null}),discoverRunning:async()=>({items:[session],nextCursor:null}),read:async()=>{reads++;return {session,messages:latest?[message('old'),message('new')]:[message('old')],interactions:[]};},resume:async()=>{forbidden.push('resume');throw Error();},input:async()=>{forbidden.push('input');throw Error();}};
 const port:any={authorizedDestination:()=>true,isTopicDestination:(d:string)=>d.startsWith('topic:'),createTopic:async()=>{creates++;latest=true;return 'topic:n';},send:async(d:string,card:any)=>{sent.push(d);cards.push(card);return 'message';},update:async()=>{},sendFile:async()=>{}};
 const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'artifacts'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'claude'),codexEndpoint:'codex-proxy://default',intervalMs:100,catalogSources:[{provider:'codex' as const,directory:logs,hostId:'h',serviceId:'x'}],allowedProjectRoots:[project],outputRoots:[project],autoMirror:{enabled:true,destination:'chat'}};
 const runtime=await createIntegratedRuntime(config,port,[base]);try {await runtime.tick();await runtime.tick();assert.equal(creates,1);assert.ok(reads>=1);const binding=runtime.channel.bindingsForRestore()[0]!;assert.equal(binding.accessMode,'read_only');assert.ok(runtime.channel.readonlyHydrated(binding.destination,binding.sessionId));assert.deepEqual(forbidden,[]);assert.equal(runtime.store.listSessions().length,1);assert.ok(cards.some(card=>JSON.stringify(card).includes('new')));assert.ok(!cards.some(card=>JSON.stringify(card).includes('old')));}finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('unknown topic creation is never retried after restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'auto-ro-')),project=join(dir,'project'),logs=join(dir,'logs');mkdirSync(project);mkdirSync(logs);
 const caps=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:k==='view'?'available':'unsupported'}])) as Capabilities;
 const session:Session={sessionId:'n',native:{provider:'codex',hostId:'h',serviceId:'x',nativeSessionId:'n'},project,title:'active',status:'read_only',revision:0,capabilities:caps,control:{serviceId:'x',owner:null,input:'unavailable',generation:0,operationId:null,reason:null}};
 let creates=0,reads=0;const sent:string[]=[];const cards:any[]=[];const forbidden:string[]=[];let latest=false;
 const message=(id:string)=>({messageId:id,sessionId:'n',turnId:'t',role:'assistant',blocks:[{type:'text',text:id}],sequence:id==='old'?1:2,revision:1,final:true,source:'codex'});
 const base:any={provider:'codex',onObservation:()=>()=>{},list:async()=>({items:[session],nextCursor:null}),discoverRunning:async()=>({items:[session],nextCursor:null}),read:async()=>{reads++;return {session,messages:latest?[message('old'),message('new')]:[message('old')],interactions:[]};},resume:async()=>{forbidden.push('resume');throw Error();},input:async()=>{forbidden.push('input');throw Error();}};
 const port:any={authorizedDestination:()=>true,isTopicDestination:(d:string)=>d.startsWith('topic:'),createTopic:async()=>{creates++;throw Error('unknown');},send:async(d:string,card:any)=>{sent.push(d);cards.push(card);return 'message';},update:async()=>{},sendFile:async()=>{}};
 const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'artifacts'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'claude'),codexEndpoint:'codex-proxy://default',intervalMs:100,catalogSources:[{provider:'codex' as const,directory:logs,hostId:'h',serviceId:'x'}],allowedProjectRoots:[project],outputRoots:[project],autoMirror:{enabled:true,destination:'chat'}};
 const runtime=await createIntegratedRuntime(config,port,[base]);try {await assert.rejects(runtime.tick());assert.equal(creates,1);}finally{await runtime.close();}
 const restarted=await createIntegratedRuntime(config,port,[base]);try {await restarted.tick();assert.equal(creates,1);assert.equal(restarted.health().unknownInbox,1);assert.deepEqual(forbidden,[]);}finally{await restarted.close();rmSync(dir,{recursive:true,force:true});}
});
