import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PlatformPort } from '../src/unified/adapter.js';
import type { Session } from '../src/unified/contracts.js';
import { contractError } from '../src/unified/errors.js';
import { UnifiedRuntime } from '../src/unified/runtime.js';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import { UnifiedCore } from '../src/unified/service.js';
import { recoveryReleaseConfirmed, UnifiedStore } from '../src/unified/store.js';

class FakeTransport {
  generation=1; connected=true; calls:string[]=[]; project='/work'; answer='finished';
  seedGeneration(n:number){this.generation=Math.max(this.generation,n)+1;}
  async request(method:string):Promise<any>{this.calls.push(method); const thread={id:'t',cwd:this.project,status:{type:'idle'},turns:[{id:'turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:this.answer}]}]}; if(['thread/start','thread/read','thread/resume'].includes(method)) return {thread}; throw Error(method);}
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
  await r.close();tr=new FakeTransport();r=new UnifiedRuntime(config,replyPort,[new CodexAdapter(tr as any,'h','x')]);assert.equal((await r.core.getSession(id)).control.input,'unavailable');assert.equal((await r.core.getOperation('pending')).status,'failed');await r.restoreBindings();assert.equal((await r.core.getOperation('unknown')).status,'unknown');assert.equal((await r.core.getSession(id)).control.input,'available');assert.equal(tr.calls.filter(x=>x==='thread/resume').length,1);assert.equal(tr.calls.filter(x=>x==='thread/start').length,0);assert.equal(tr.calls.filter(x=>x==='turn/start').length,0);assert.equal((await r.core.readHistory(id,{limit:10})).items[0]?.messageId,'answer');await r.handleTrusted({eventId:'check-pending',destination:'chat',identity},{action:'reconcile',operationId:'pending'});await r.tick();assert.ok(cards.some(card=>card.title === '操作回执' && card.text.includes('发送输入：失败')));
  await r.close();tr=new FakeTransport();r=new UnifiedRuntime({...config,ownerOpenId:'revoked'},port,[new CodexAdapter(tr as any,'h','x')]);await r.restoreBindings();assert.equal(tr.calls.includes('thread/resume'),false);
  await r.close();const db2=new DatabaseSync(config.channelDb);db2.prepare("UPDATE channel_bindings SET access_mode='read_only'").run();db2.close();tr=new FakeTransport();r=new UnifiedRuntime(config,port,[new CodexAdapter(tr as any,'h','x')]);await r.restoreBindings();assert.equal(tr.calls.includes('thread/resume'),false);
  await r.close();const db3=new DatabaseSync(config.channelDb);db3.prepare("UPDATE channel_bindings SET access_mode='interactive' WHERE destination='chat'").run();db3.close();tr=new FakeTransport();tr.project='/changed';r=new UnifiedRuntime(config,port,[new CodexAdapter(tr as any,'h','x')]);await r.restoreBindings();assert.equal(tr.calls.includes('thread/resume'),false);assert.equal(r.health().status,'degraded');
 } finally {await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('Claude-style passive reads defer quarantine generation checks until resume', async t => {
  const cases = [
    { name: 'confirmed release accepts the same generation', confirmed: true, generation: 4, before: undefined, expected: null, resumes: 1 },
    { name: 'unknown release rejects the same generation after resume', confirmed: false, generation: 4, before: undefined, expected: /stale recovery resume/, resumes: 1 },
    { name: 'unknown release accepts a newer generation', confirmed: false, generation: 5, before: undefined, expected: null, resumes: 1 },
    { name: 'known stale generation rejects before resume', confirmed: false, generation: 4, before: 4, expected: /new connection required/, resumes: 0 },
    { name: 'resume must supply a valid generation', confirmed: true, generation: -1, before: undefined, expected: /missing identity or generation/, resumes: 1 },
  ];
  for (const { name, confirmed, generation, before, expected, resumes } of cases) await t.test(name, async () => {
    const store = new UnifiedStore(':memory:');
    const session: Session = {
      sessionId: 's', native: { provider: 'claude', hostId: 'h', serviceId: 'c', nativeSessionId: 'n' },
      title: 'Claude', project: '/work', status: 'read_only', revision: 0,
      capabilities: Object.fromEntries(['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config']
        .map(key => [key, { status: 'available' }])) as Session['capabilities'],
      control: { serviceId: 'c', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: null },
    };
    store.insertSession(session);
    store.setConnectionGeneration(session.sessionId, 0, 4);
    store.quarantineRecovery(session.sessionId, confirmed ? recoveryReleaseConfirmed : 'release outcome unknown');
    let active = false;
    let calls = 0;
    const provider: Pick<PlatformPort, 'provider' | 'read' | 'resume' | 'control' | 'onObservation'> = {
      provider: 'claude',
      onObservation: () => () => {},
      async read() {
        return {
          session: active ? { ...session, status: 'idle', control: { ...session.control, input: 'available', generation: 1 } } : session,
          messages: [], interactions: [],
          ...(active ? { connectionGeneration: generation } : before === undefined ? {} : { connectionGeneration: before }),
        };
      },
      async resume() {
        calls++;
        active = true;
        return { status: 'submitted', nativeReference: session.native.nativeSessionId, connectionGeneration: generation };
      },
      async control() {
        active = false;
        return { status: 'submitted', nativeReference: 'unsubscribed' };
      },
    };
    const core = new UnifiedCore(store, [provider as PlatformPort], () => true);
    try {
      const attach = core.attachSession({
        context: { operationId: 'attach', idempotencyKey: 'attach', targetId: session.sessionId, expectedRevision: 0, controlGeneration: 0, identity },
        payload: { ...session.native, mode: 'interactive' },
      });
      if (expected) {
        await assert.rejects(attach, expected);
        assert.equal(store.recoveryQuarantined(session.sessionId), true);
        assert.equal((await core.getSession(session.sessionId)).control.input, 'unavailable');
        assert.equal(active, false);
      } else {
        assert.equal((await attach).status, 'completed');
        assert.equal(store.recoveryQuarantined(session.sessionId), false);
        assert.equal(store.connectionGeneration(session.sessionId), generation);
        assert.equal((await core.getSession(session.sessionId)).control.input, 'available');
      }
      assert.equal(calls, resumes);
    } finally {
      core.close();
      store.close();
    }
  });
});

test('guarded attach quarantines an existing session when release cannot be proved', async t => {
  for (const release of ['confirmed', 'non-confirming', 'lost acknowledgement']) await t.test(release, async () => {
    const releaseConfirmed = release === 'confirmed';
    const store = new UnifiedStore(':memory:');
    const transport = new FakeTransport();
    const adapter = new CodexAdapter(transport as any, 'h', 'x');
    const core = new UnifiedCore(store, [adapter], () => true);
    const native = { provider: 'codex' as const, hostId: 'h', serviceId: 'x', nativeSessionId: 't' };
    const context = { operationId: 'read', idempotencyKey: 'read', targetId: 't', expectedRevision: 0, controlGeneration: 0, identity };
    try {
      const readonly = await core.attachSession({ context, payload: { ...native, mode: 'read_only' } });
      assert.equal(readonly.result?.kind, 'session');
      const id = readonly.result.sessionId;
      let authorized = true;
      const request = transport.request.bind(transport);
      transport.request = async (method: string) => {
        if (method === 'thread/resume') authorized = false;
        if (method !== 'thread/unsubscribe') return request(method);
        transport.calls.push(method);
        if (release === 'lost acknowledgement') throw new Error('lost unsubscribe acknowledgement');
        return { status: 'unsubscribed' };
      };
      if (release === 'non-confirming') {
        const control = adapter.control.bind(adapter);
        adapter.control = async (...args) => {
          await control(...args);
          return { status: 'submitted', nativeReference: 'unverified release' };
        };
      }

      await assert.rejects(core.attachSession({
        context: { ...context, operationId: 'upgrade', idempotencyKey: 'upgrade', targetId: id },
        payload: { ...native, mode: 'interactive' },
      }, { stillAuthorized: () => authorized }), releaseConfirmed ? /attach authorization changed/ : /subscription release could not be confirmed/);
      assert.equal(transport.calls.filter(method => method === 'thread/unsubscribe').length, 1);
      assert.equal((await core.getSession(id)).control.input, 'unavailable');
      assert.deepEqual(store.getRecoveryQuarantine(id), releaseConfirmed ? null : { generation: transport.generation, releaseConfirmed: false });
    } finally {
      core.close();
      store.close();
    }
  });
});

for(const failRelease of [false,true]) test(`revocation releases or quarantines unknown release (${failRelease}) and fences late observations`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-fence-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://localhost:1',intervalMs:100,autoTakeControlOnInput:true};
 let authorized=true;
 const cards: Array<{ title:string; text:string; actions?: unknown[] }> = [];
 const channelPort={...port,authorizedDestination:()=>authorized,async send(_destination:string,card:{title:string;text:string;actions?:unknown[]}){cards.push(card);return 'm';}};
 let tr=new FakeTransport();let r=new UnifiedRuntime(config,channelPort,[new CodexAdapter(tr as any,'h','x')]);
 try {
  const context={operationId:'create',idempotencyKey:'create',targetId:'new',expectedRevision:0,controlGeneration:0,identity};await r.core.createSession({context,payload:{provider:'codex',project:'/work',model:null}});const id=((await r.core.dispatch('create')).result as any).sessionId;
  const db=new DatabaseSync(config.channelDb);db.prepare('INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode) VALUES(?,?,?,?,?,?,?)').run('chat',id,'b','feishu','owner',1,'interactive');db.close();await r.close();
  tr=new FakeTransport();const adapter=new CodexAdapter(tr as any,'h','x');r=new UnifiedRuntime(config,channelPort,[adapter]);let reads=0;const request=tr.request.bind(tr);tr.request=async(method:string)=>{if(method==='thread/read' && ++reads===3)authorized=false;if(method==='thread/unsubscribe'){tr.calls.push(method);if(failRelease)throw Error('lost receipt');return {status:'unsubscribed'};}return request(method);};
  await r.restoreBindings();assert.equal(tr.calls.filter(x=>x==='thread/unsubscribe').length,1);assert.equal(r.health().status,'degraded');assert.equal((await r.core.getSession(id)).control.input,'unavailable');assert.equal(r.store.recoveryQuarantined(id),true);
  const reason=(await r.core.health()).find(x=>x.component==='core')?.reason;assert.match(reason ?? '',failRelease ? /release outcome unknown/ : /subscription released/);
  (tr as any).onMessage({method:'item/completed',params:{threadId:'t',turnId:'late-turn',item:{id:'late',type:'agentMessage',text:'late'}}},tr.generation);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal((await r.core.readHistory(id,{limit:20})).items.some(m=>m.messageId==='late'),false);
  authorized=true;
  const current=await r.core.getSession(id);
  await assert.rejects(r.core.submitInput({context:{...context,targetId:id,operationId:'blocked-input',idempotencyKey:'blocked-input',expectedRevision:current.revision,controlGeneration:current.control.generation},mode:'new',blocks:[{type:'text',text:'blocked'}]}),/recovery quarantine/);
  tr.answer='observed while quarantined';
  assert.equal(await r.core.refreshReadOnlySession(id),true);
  assert.equal(await r.core.hydrateSessionHistory(id),true);
  assert.equal(await r.core.refreshIdleInteractiveSession(id),false);
  assert.equal(r.store.recoveryQuarantined(id),true);
  assert.deepEqual((await r.core.getMessage(id,'answer'))?.blocks,[{type:'text',text:tr.answer}]);
  const envelope={destination:'chat',identity};
  assert.deepEqual(await r.channel.handle({...envelope,eventId:'implicit-input'},{action:'input',text:'try takeover',mode:'new'}),{
    status:'rejected',reason:'control_conflict',message:'recovery quarantine requires an explicit interactive attach',
  });
  assert.equal(tr.calls.filter(x=>x==='thread/resume').length,1);
  const quarantineCard=cards.findLast(card=>card.title==='接入未完成');
  assert.match(quarantineCard?.text ?? '',/恢复隔离.*一键接入并续聊/);
  assert.deepEqual(quarantineCard?.actions,[{label:'一键接入并续聊',value:{action:'upgrade',bindingId:'b'}}]);
  const reattach=await r.channel.handle({...envelope,eventId:'explicit-same'},{action:'upgrade'});
  if (!failRelease) {
    assert.equal((reattach as {status:string}).status,'completed');
    assert.equal(r.store.recoveryQuarantined(id),false);
    assert.equal((await r.core.getSession(id)).control.input,'available');
    assert.equal(tr.calls.filter(x=>x==='thread/resume').length,2);
    assert.equal(r.health().status,'healthy');
    return;
  }
  const detail='new connection required to reconcile recovery quarantine';
  assert.deepEqual(reattach,{status:'rejected',reason:'control_conflict',message:detail});
  assert.ok(cards.findLast(card=>card.title==='接入未完成')?.text.includes(detail));
  assert.equal(tr.calls.filter(x=>x==='thread/resume').length,1);
  await r.close();authorized=true;tr=new FakeTransport();r=new UnifiedRuntime(config,channelPort,[new CodexAdapter(tr as any,'h','x')]);await r.restoreBindings();assert.equal(tr.calls.includes('thread/resume'),false);const reopened=await r.core.getSession(id);await r.core.attachSession({context:{...context,operationId:'explicit-new',idempotencyKey:'explicit-new',targetId:id,expectedRevision:reopened.revision,controlGeneration:reopened.control.generation},payload:{...reopened.native,mode:'interactive'}});assert.equal(r.store.recoveryQuarantined(id),false);assert.equal((await r.core.getSession(id)).control.input,'available');
 } finally {await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('another currently authorized binding keeps the same session during recovery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-other-binding-'));const config={coreDb:join(dir,'core'),channelDb:join(dir,'channel'),ownerOpenId:'owner',allowedDestinations:['a','b'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',claudeStateDir:join(dir,'state'),codexEndpoint:'ws://localhost:1',intervalMs:100};let revoke=false;const channelPort={...port,authorizedDestination:(d:string)=>d==='b'||!revoke};let tr=new FakeTransport();let r=new UnifiedRuntime(config,channelPort,[new CodexAdapter(tr as any,'h','x')]);
 try {const context={operationId:'c',idempotencyKey:'c',targetId:'new',expectedRevision:0,controlGeneration:0,identity};await r.core.createSession({context,payload:{provider:'codex',project:'/work',model:null}});const id=((await r.core.dispatch('c')).result as any).sessionId;const db=new DatabaseSync(config.channelDb);for(const destination of ['a','b'])db.prepare('INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode) VALUES(?,?,?,?,?,?,?)').run(destination,id,destination,'feishu','owner',1,'interactive');db.close();await r.close();tr=new FakeTransport();r=new UnifiedRuntime(config,channelPort,[new CodexAdapter(tr as any,'h','x')]);let reads=0;const request=tr.request.bind(tr);tr.request=async(method:string)=>{if(method==='thread/read' && ++reads===3)revoke=true;return request(method);};await r.restoreBindings();assert.equal((await r.core.getSession(id)).control.input,'available');assert.equal(tr.calls.filter(x=>x==='thread/resume').length,1);assert.equal(tr.calls.includes('thread/unsubscribe'),false);assert.equal(r.store.recoveryQuarantined(id),false);
 } finally {await r.close();rmSync(dir,{recursive:true,force:true});}
});

for (const failBeforeResume of [true, false]) {
  test(failBeforeResume ? 'pre-resume read failure retries without quarantine' : 'revocation during resume releases the new connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-resume-boundary-'));
    const config = {
      coreDb: join(dir, 'core'), channelDb: join(dir, 'channel'), ownerOpenId: 'owner', allowedDestinations: ['chat'],
      hostId: 'h', claudeServiceId: 'c', codexServiceId: 'x', claudeStateDir: join(dir, 'state'),
      codexEndpoint: 'ws://localhost:1', intervalMs: 100,
    };
    let authorized = true;
    const channelPort = { ...port, authorizedDestination: () => authorized };
    let runtime = new UnifiedRuntime(config, channelPort, [new CodexAdapter(new FakeTransport() as any, 'h', 'x')]);
    try {
      const context = { operationId: 'create', idempotencyKey: 'create', targetId: 'new', expectedRevision: 0, controlGeneration: 0, identity };
      await runtime.core.createSession({ context, payload: { provider: 'codex', project: '/work', model: null } });
      const created = await runtime.core.dispatch('create');
      assert.equal(created.result?.kind, 'session');
      const id = created.result.sessionId;
      const previousGeneration = runtime.store.connectionGeneration(id);
      const db = new DatabaseSync(config.channelDb);
      db.prepare('INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision,access_mode) VALUES(?,?,?,?,?,?,?)')
        .run('chat', id, 'b', 'feishu', 'owner', 1, 'interactive');
      db.close();
      await runtime.close();

      const transport = new FakeTransport();
      runtime = new UnifiedRuntime(config, channelPort, [new CodexAdapter(transport as any, 'h', 'x')]);
      assert.ok(transport.generation > previousGeneration);
      let reads = 0;
      const request = transport.request.bind(transport);
      transport.request = async (method: string) => {
        if (method === 'thread/read' && ++reads === 2 && failBeforeResume) {
          transport.calls.push(method);
          throw new Error('read failed before native resume');
        }
        if (method === 'thread/resume' && !failBeforeResume) authorized = false;
        if (method === 'thread/unsubscribe') {
          transport.calls.push(method);
          return { status: 'unsubscribed' };
        }
        return request(method);
      };

      await runtime.restoreBindings();
      assert.equal((await runtime.core.getSession(id)).control.input, 'unavailable');
      assert.equal(runtime.health().status, 'degraded');
      const coreHealth = (await runtime.core.health()).find(row => row.component === 'core');
      if (failBeforeResume) {
        assert.deepEqual(transport.calls, ['thread/read', 'thread/read']);
        assert.equal(runtime.store.getRecoveryQuarantine(id), null);
        assert.match(coreHealth?.reason ?? '', /inspect session before retry/);
        assert.deepEqual(await runtime.restoreProviderAfterReconnect('codex'), { restored: [id], failed: [] });
        assert.equal(transport.calls.filter(method => method === 'thread/resume').length, 1);
        assert.equal((await runtime.core.getSession(id)).control.input, 'available');
        assert.equal(runtime.health().status, 'healthy');
        assert.notEqual((await runtime.core.health()).find(row => row.component === 'core')?.status, 'degraded');
      } else {
        assert.equal(transport.calls.filter(method => method === 'thread/resume').length, 1);
        assert.equal(transport.calls.filter(method => method === 'thread/unsubscribe').length, 1);
        assert.deepEqual(runtime.store.getRecoveryQuarantine(id), { generation: transport.generation, releaseConfirmed: true });
        assert.match(coreHealth?.reason ?? '', /subscription released/);
      }
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('clean pre-subscription resume rejection preserves release-confirmed quarantine for retry and readonly refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-clean-retry-'));
  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  try {
    const ref = { provider: 'agy' as const, hostId: 'h', serviceId: 'agy', nativeSessionId: 'conv-clean-retry' };
    let generation = 6;
    let resumeBlocked = true;
    let active = false;
    let replyText = 'initial';
    const makeSession = (interactive: boolean): Session => ({
      sessionId: '',
      native: ref,
      title: 'Quarantined AGY',
      project: '/work',
      status: interactive ? 'idle' : 'read_only',
      revision: 1,
      control: interactive
        ? { serviceId: 'agy', owner: 'agy', input: 'available', generation: 2, operationId: null, reason: null }
        : { serviceId: 'agy', owner: null, input: 'unavailable', generation: 1, operationId: null, reason: 'recovery verification failed; subscription released' },
      capabilities: {
        view: { status: 'available' },
        send: interactive ? { status: 'available' } : { status: 'temporarily_unavailable', reason: 'read-only' },
        queue: { status: 'unsupported', reason: 'test' },
        steer: { status: 'unsupported', reason: 'test' },
        answer: { status: 'unsupported', reason: 'test' },
        approve: { status: 'unsupported', reason: 'test' },
        interrupt: { status: 'unsupported', reason: 'test' },
        handoff: { status: 'available' },
        files: { status: 'unsupported', reason: 'test' },
        config: { status: 'unsupported', reason: 'test' },
      },
      updatedAt: '2026-11-26T00:00:00Z',
    });
    const fakePort: PlatformPort = {
      provider: 'agy',
      list: async () => ({ items: [], nextCursor: null }),
      read: async () => ({
        session: makeSession(active),
        messages: [{
          messageId: 'm1', sessionId: ref.nativeSessionId, turnId: 'step-1', role: 'assistant',
          blocks: [{ type: 'text', text: replyText }], sequence: 1, revision: 1, final: true, source: 'agy',
        }],
        interactions: [],
        connectionGeneration: generation,
      }),
      create: async () => { throw new Error('unused'); },
      resume: async () => {
        if (resumeBlocked) throw contractError('control_conflict', '本地终端 agy 正在使用该会话');
        active = true;
        return { status: 'submitted', nativeReference: ref.nativeSessionId, connectionGeneration: generation };
      },
      input: async () => { throw new Error('unused'); },
      interrupt: async () => { throw new Error('unused'); },
      respond: async () => { throw new Error('unused'); },
      control: async () => { throw contractError('control_conflict', 'not subscribed'); },
      updateSettings: async () => { throw new Error('unused'); },
      listModels: async () => [],
      archive: async () => { throw new Error('unused'); },
      listArtifacts: async () => [],
      readArtifact: async () => { throw new Error('unused'); },
      onObservation: () => () => {},
    };
    const core = new UnifiedCore(store, [fakePort], () => true, () => true);
    const baseCtx = { targetId: 'new', expectedRevision: 0, controlGeneration: 0, identity };
    const attached = await core.attachSession({
      context: { ...baseCtx, operationId: 'att-0', idempotencyKey: 'att-0' },
      payload: { ...ref, mode: 'read_only' },
    });
    assert.equal(attached.result?.kind, 'session');
    const sessionId = attached.result.sessionId;
    store.quarantineRecovery(sessionId, recoveryReleaseConfirmed, generation);

    // First explicit retry fails cleanly (e.g. external local agy holder).
    await assert.rejects(
      core.attachSession({
        context: { ...baseCtx, operationId: 'att-1', idempotencyKey: 'att-1', targetId: sessionId },
        payload: { ...ref, mode: 'interactive' },
      }),
      { code: 'control_conflict', message: '本地终端 agy 正在使用该会话' },
    );
    // Quarantine must stay releaseConfirmed so readonly refresh and same-gen retry remain available.
    assert.deepEqual(store.getRecoveryQuarantine(sessionId), { generation, releaseConfirmed: true });
    replyText = 'updated while still quarantined';
    assert.equal(await core.refreshReadOnlySession(sessionId), true);
    assert.deepEqual((await core.getMessage(sessionId, 'm1'))?.blocks, [{ type: 'text', text: replyText }]);

    // Once external holder releases, retry on the same generation succeeds and clears quarantine.
    resumeBlocked = false;
    const recovered = await core.attachSession({
      context: { ...baseCtx, operationId: 'att-2', idempotencyKey: 'att-2', targetId: sessionId },
      payload: { ...ref, mode: 'interactive' },
    });
    assert.equal(recovered.status, 'completed');
    assert.equal(store.getRecoveryQuarantine(sessionId), null);
    assert.equal((await core.getSession(sessionId)).control.input, 'available');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
