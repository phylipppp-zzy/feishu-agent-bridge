import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIntegratedRuntime} from '../src/unified/runtime.js';
import {RuntimeInteractive} from '../src/unified/runtime-interactive.js';
import type {FeishuChannel} from '../src/unified/feishu-channel.js';
import type {Session,Capabilities,Message} from '../src/unified/contracts.js';

test('discarded native history leaves the readonly baseline pending until a committed retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hydration-generation-'));
  const logs = join(dir, 'logs');
  mkdirSync(logs);
  const capabilities = { view: { status: 'available' } } as Capabilities;
  const session: Session = {
    sessionId: 's', native: { provider: 'claude', hostId: 'h', serviceId: 'c', nativeSessionId: 'n' },
    project: dir, title: 'Session', status: 'read_only', revision: 0, capabilities,
    control: { serviceId: 'c', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: null },
  };
  const old: Message = {
    messageId: 'old', sessionId: 'n', turnId: 't', role: 'assistant', blocks: [{ type: 'text', text: 'history' }],
    sequence: 1, revision: 1, final: true, source: 'fake',
  };
  let generation = 0;
  let race = true;
  const base = {
    provider: 'claude', onObservation: () => () => {},
    list: async () => ({ items: [session], nextCursor: null }),
    read: async () => {
      if (race) {
        runtime.store.setConnectionGeneration('s', generation, generation + 1);
        generation++;
      }
      return { session, messages: [old], interactions: [] };
    },
  } as unknown as import('../src/unified/adapter.js').PlatformPort;
  const titles: string[] = [];
  const runtime = await createIntegratedRuntime({
    coreDb: join(dir, 'core'), channelDb: join(dir, 'channel'), artifactStatePath: join(dir, 'artifacts'),
    ownerOpenId: 'owner', allowedDestinations: ['chat'], hostId: 'h', claudeServiceId: 'c', codexServiceId: 'x',
    claudeStateDir: dir, codexEndpoint: 'codex-proxy://default', intervalMs: 100,
    allowedProjectRoots: [dir], outputRoots: [dir],
    catalogSources: [{ provider: 'claude', directory: logs, hostId: 'h', serviceId: 'c' }],
  }, {
    send: async (_d, card) => { titles.push(card.title); return `msg-${titles.length}`; },
    update: async () => {}, sendFile: async () => {},
  }, [base]);
  try {
    const owner = { source: 'feishu', subject: 'owner' };
    runtime.store.insertSession(session);
    runtime.channel.importMigrationBinding('m', { destination: 'chat', sessionId: 's', bindingId: 'b', owner });
    await runtime.channel.handle({ eventId: 'history', destination: 'chat', identity: owner }, { action: 'history' });
    assert.equal(generation, 1);
    assert.equal(runtime.channel.readonlyHydrated('chat', 's'), false);
    await runtime.tick();
    assert.equal(generation, 2);
    assert.equal(runtime.channel.readonlyHydrated('chat', 's'), false);
    assert.deepEqual(runtime.store.snapshot('s').value.messages, []);
    race = false;
    await runtime.tick();
    assert.equal(runtime.channel.readonlyHydrated('chat', 's'), true);
    assert.equal(runtime.store.snapshot('s').value.messages[0]?.messageId, 'old');
    assert.ok(!titles.some(title=>title.endsWith(' · 回复')));
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('foreground interaction refresh skips only readonly destinations awaiting hydration', async () => {
  const delivered: string[] = [];
  const channel = {
    destinationsForSession: () => ['interactive', 'ready', 'pending'],
    accessMode: (d: string) => d === 'interactive' ? 'interactive' : 'read_only',
    readonlyHydrated: (d: string) => d === 'ready',
    refreshInteraction: async (d: string) => { delivered.push(d); },
  } as unknown as FeishuChannel;
  const runtime = new RuntimeInteractive(null!, null!, channel, undefined, undefined, undefined, true);
  runtime.notifyInteraction('session', 'interaction');
  await runtime.close();
  assert.deepEqual(delivered, ['interactive', 'ready']);
});

test('18 imported readonly bindings hydrate once before sync, preserve cursors and survive restart',async()=>{const dir=mkdtempSync(join(tmpdir(),'hydration-')),project=join(dir,'project'),logs=join(dir,'logs');mkdirSync(project);mkdirSync(logs);const caps=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:'unsupported'}])) as Capabilities;const sessions=Array.from({length:18},(_,i):Session=>({sessionId:`s${i}`,native:{provider:'claude',hostId:'h',serviceId:'c',nativeSessionId:`n${i}`},project,title:`s${i}`,status:'read_only',revision:0,capabilities:caps,control:{serviceId:'c',owner:null,input:'unavailable',generation:0,operationId:null,reason:null}}));let extra=false,reads=0;const base:any={provider:'claude',onObservation:()=>()=>{},list:async()=>({items:sessions,nextCursor:null}),read:async(ref:any)=>{reads++;const session=sessions.find(s=>s.native.nativeSessionId===ref.nativeSessionId)!;const messages:Message[]=Array.from({length:60},(_,i)=>({messageId:`${ref.nativeSessionId}-m${i}`,sessionId:ref.nativeSessionId,turnId:`t${i}`,role:'assistant',blocks:[{type:'text',text:'historical'}],sequence:i,revision:1,final:true,source:'fake'}));if(extra && ref.nativeSessionId==='n0')messages.push({messageId:'new-after-restart',sessionId:ref.nativeSessionId,turnId:'new',role:'assistant',blocks:[{type:'text',text:'new incremental'}],sequence:61,revision:1,final:true,source:'fake'});return {session,messages,interactions:[]}}};let sends=0,failed=0,failNext=false;const port={send:async(_d:string,c:any)=>{if(c.title==='Claude (CLI) · 回复'){sends++;if(failNext){failNext=false;failed++;throw Error('unknown send outcome')}}return `m${sends}`},update:async()=>{},sendFile:async()=>{}};const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),artifactStatePath:join(dir,'artifacts'),ownerOpenId:'owner',allowedDestinations:sessions.map((_,i)=>`chat${i}`),hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'claude'),codexEndpoint:'codex-proxy://default',intervalMs:100,catalogSources:[{provider:'claude' as const,directory:logs,hostId:'h',serviceId:'c'}],allowedProjectRoots:[project],outputRoots:[project]};let runtime=await createIntegratedRuntime(config,port,[base]);try{for(const [i,s] of sessions.entries()){runtime.store.insertSession(s);runtime.channel.importMigrationBinding(`migration${i}`,{destination:`chat${i}`,sessionId:s.sessionId,bindingId:`binding${i}`,owner:{source:'feishu',subject:'owner'}});await runtime.channel.sync(`chat${i}`);}for(let i=0;i<9;i++){const before=reads;await runtime.tick();assert.ok(reads-before<=2);assert.equal(sends,0,'historical messages must not be sent');}assert.equal(reads,18);assert.equal(runtime.channel.bindingsForRestore().filter(b=>runtime.channel.readonlyHydrated(b.destination,b.sessionId)).length,18);await runtime.close();runtime=await createIntegratedRuntime(config,port,[base]);extra=true;await runtime.tick();assert.equal(sends,1);await runtime.tick();assert.equal(sends,1);extra=false;failNext=true;runtime.store.putMessage({messageId:'new-unknown',sessionId:'s0',turnId:'new2',role:'assistant',blocks:[{type:'text',text:'new uncertain'}],sequence:62,revision:1,final:true,source:'fake'},null);await assert.rejects(runtime.tick());assert.equal(failed,1);for(let i=0;i<3;i++)await runtime.tick();assert.equal(failed,1);assert.equal(runtime.channel.pendingDeliveries().length,1);}finally{await runtime.close();rmSync(dir,{recursive:true,force:true})}});

test('offline preparation performs only bounded readonly reads and no outbound sends',async()=>{const {UnifiedRuntime}=await import('../src/unified/runtime.js');const dir=mkdtempSync(join(tmpdir(),'hydrate-offline-'));const caps=Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k=>[k,{status:'unsupported'}])) as Capabilities;const sessions=Array.from({length:3},(_,i):Session=>({sessionId:`s${i}`,native:{provider:'claude',hostId:'h',serviceId:'c',nativeSessionId:`n${i}`},project:dir,title:`s${i}`,status:'read_only',revision:0,capabilities:caps,control:{serviceId:'c',owner:null,input:'unavailable',generation:0,operationId:null,reason:null}}));let sends=0,reads=0;const base:any={provider:'claude',onObservation:()=>()=>{},read:async(ref:any)=>{reads++;const session=sessions.find(s=>s.native.nativeSessionId===ref.nativeSessionId)!;return {session,messages:[{messageId:`${ref.nativeSessionId}-old`,sessionId:ref.nativeSessionId,turnId:'t',role:'assistant',blocks:[{type:'text',text:'history'}],sequence:1,revision:1,final:true,source:'fake'}],interactions:[]}}};const port={send:async()=>{sends++;return 'message'},update:async()=>{sends++},sendFile:async()=>{sends++}};const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['c0','c1','c2'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:dir,codexEndpoint:'codex-proxy://default',intervalMs:100};const runtime=new UnifiedRuntime(config,port,[base]);try{for(const [i,s] of sessions.entries()){runtime.store.insertSession(s);runtime.channel.importMigrationBinding(`m${i}`,{destination:`c${i}`,sessionId:s.sessionId,bindingId:`b${i}`,owner:{source:'feishu',subject:'owner'}})}await runtime.channel.intake({eventId:'pending-list',destination:'c0',identity:{source:'feishu',subject:'owner'}},{action:'list'});const channelDb=new DatabaseSync(join(dir,'channel'));channelDb.prepare("INSERT INTO channel_deliveries VALUES ('old-unknown','unknown')").run();channelDb.close();assert.deepEqual(await runtime.prepareReadonlyHistoryBaselines(2),{attempted:2,completed:2,failed:0,remaining:1});assert.deepEqual(await runtime.prepareReadonlyHistoryBaselines(2),{attempted:1,completed:1,failed:0,remaining:0});assert.equal(reads,3);assert.equal(sends,0);assert.deepEqual(runtime.channel.pendingInbox(),['pending-list']);assert.equal(runtime.channel.pendingDeliveries().length,1);runtime.store.putMessage({messageId:'fresh-after-baseline',sessionId:'s0',turnId:'new',role:'assistant',blocks:[{type:'text',text:'fresh'}],sequence:2,revision:1,final:true,source:'fake'},null);await runtime.channel.sync('c0');assert.equal(sends,1);await runtime.channel.sync('c0');assert.equal(sends,1);assert.equal(runtime.channel.pendingDeliveries().length,1);}finally{await runtime.close();rmSync(dir,{recursive:true,force:true})}});
