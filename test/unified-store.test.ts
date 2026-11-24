import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { UnifiedStore, StoreError } from '../src/unified/store.js';
import { answerDigest, type Capabilities, type Interaction, type ResolveInteraction, type Session } from '../src/unified/contracts.js';

const caps = Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k => [k, {status:'available'}])) as Capabilities;
const session: Session = { sessionId:'s', native:{provider:'codex',hostId:'h',serviceId:'svc',nativeSessionId:'native'}, project:'p', title:'t', status:'idle', revision:0, capabilities:caps, control:{serviceId:'svc',owner:'x',input:'available',generation:1,operationId:null,reason:null} };
const interaction: Interaction = { interactionId:'i',sessionId:'s',turnId:'t',nativeRequestId:'42',connectionGeneration:1,revision:0,status:'awaiting_answer',expiresAt:null,toolInputDigest:null,nativeResult:null,kind:'question',prompt:'?',choices:['a','b'],multiple:false,allowFreeText:false };
function request(id: string, value = 'a'): ResolveInteraction { return {context:{operationId:id,idempotencyKey:id,targetId:'s',expectedRevision:0,controlGeneration:1,identity:{subject:'u',source:'test'}},interactionId:'i',expectedConnectionGeneration:1,answer:{kind:'question',values:[value]},toolInputDigest:null}; }
function evidence(id: string) {
  return {operationId:id,interactionId:'i',nativeRequestId:'42',connectionGeneration:1,answerDigest:answerDigest(request(id).answer)};
}
function nativeAcceptance(id: string) { return {status:'accepted' as const,source:'matching-tool',answer:request(id).answer}; }
function code(fn: () => unknown, expected: string): void { assert.throws(fn, (e: unknown) => e instanceof StoreError && e.detail.code === expected); }
function setup(): {dir:string; path:string; store:UnifiedStore} { const dir = mkdtempSync(join(tmpdir(),'unified-store-')); const path = join(dir,'new.sqlite'); const store = new UnifiedStore(path); store.insertSession(session); store.setConnectionGeneration('s',0,1); store.insertInteraction(interaction); return {dir,path,store}; }
function child(path: string, id: string, mode = 'answer'): Promise<string> {
  return new Promise((resolve,reject) => {
    const out = `${path}.${id}.${mode}.out`;
    const fd = openSync(out,'w');
    try {
      const p = spawn(process.execPath,['--import','tsx',import.meta.filename],{
        env:{...process.env, STORE_WORKER:'1', STORE_PATH:path, STORE_ID:id, STORE_MODE:mode},
        stdio:['ignore',fd,'inherit'],
      });
      p.on('error',reject);
      p.on('close', (code,signal) => {
        if (code !== 0) { reject(new Error(`store worker exited: ${code ?? signal}`)); return; }
        try { resolve(readFileSync(out,'utf8').trim()); }
        catch (error) { reject(error); }
      });
    } finally { closeSync(fd); }
  });
}
if (process.env.STORE_WORKER === '1') {
  const store = new UnifiedStore(process.env.STORE_PATH!); try { if (process.env.STORE_MODE === 'claim') console.log(store.claimOutbox('a') ? 'claimed' : 'blocked'); else if (process.env.STORE_MODE === 'switch') { store.setConnectionGeneration('s',1,2); console.log('switched'); } else { store.resolveInteraction(request(process.env.STORE_ID!)); console.log('won'); } } catch (e) { console.log(e instanceof StoreError ? e.detail.code : 'unexpected'); } finally { store.close(); }
} else {
  test('cross-process answer CAS; native terminal result is authoritative and survives reopen', async () => {
    const {dir,path,store} = setup(); store.close();
    try { const results = await Promise.all([child(path,'one'),child(path,'two')]); assert.equal(results.filter(x => x === 'won').length,1); assert.equal(results.filter(x => x === 'stale_revision').length,1);
      let db = new UnifiedStore(path); const winner = results[0] === 'won' ? 'one' : 'two'; assert.equal(db.getInteraction('i').status,'answer_pending_delivery');
      db.recordNativeResult('i',1,'42',{status:'accepted',source:'terminal',answer:null}); assert.equal(db.getOutbox(winner).state,'cancelled'); db.close();
      db = new UnifiedStore(path); assert.deepEqual(db.getInteraction('i').nativeResult,{status:'accepted',source:'terminal',answer:null}); assert.equal(db.getInteraction('i').status,'resolved'); code(() => db.resolveInteraction(request('third')),'stale_revision'); db.close();
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  test('duplicate key, control and connection generations, unknown recovery', () => {
    const {dir,path,store} = setup(); try {
      const a = request('a'); assert.equal(store.resolveInteraction(a).status,'received'); assert.deepEqual(store.resolveInteraction(a),store.getOperation('a')); code(() => store.resolveInteraction(request('a','b')),'idempotency_conflict');
      assert.equal(store.claimOutbox('a'),true); assert.equal(store.claimOutbox('a'),false); store.close();
      const reopened = new UnifiedStore(path); assert.equal(reopened.recoverInFlight()[0]?.status,'unknown'); assert.equal(reopened.getOperation('a').status,'unknown'); assert.equal(reopened.claimOutbox('a'),false);
      code(() => reopened.reconcileOperation('a','completed'),'invalid_request');
      reopened.recordNativeResult('i',1,'42',nativeAcceptance('a'),true,evidence('a'));
      assert.equal(reopened.getOperation('a').status,'completed'); assert.equal(reopened.getOutbox('a').state,'done');
      reopened.setConnectionGeneration('s',1,2); code(() => reopened.recordNativeResult('i',1,'42',{status:'accepted',source:'old',answer:null}),'interaction_expired');
      const next = {...session,revision:1,control:{...session.control,generation:2}}; reopened.updateSession(next,0,1); code(() => reopened.registerOperation({ ...request('x').context, expectedRevision:1 },'send',{}),'control_conflict'); reopened.close();
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  test('a local response receipt and a correlated native result advance separate durable states', () => {
    for (const early of [false,true]) {
      const {dir,store} = setup();
      try {
        store.resolveInteraction(request('a'));
        code(() => store.recordNativeResult('i',1,'42',nativeAcceptance('a'),true,evidence('a')),'invalid_request');
        assert.equal(store.claimOutbox('a'),true);
        if (!early) {
          assert.equal(store.acceptResponseSubmission('a').status,'accepted');
          assert.equal(store.getOutbox('a').state,'done');
          assert.equal(store.getInteraction('i').status,'answer_pending_delivery');
          assert.deepEqual(store.interactionHealthCounts(),{pending:1,unknown:0});
        }
        for (const mismatch of [{answerDigest:'other'}, {nativeRequestId:'other'}, {connectionGeneration:2}, {interactionId:'other'}]) {
          code(() => store.recordNativeResult('i',1,'42',nativeAcceptance('a'),true,{...evidence('a'),...mismatch}),'invalid_request');
        }
        const resolved = store.recordNativeResult('i',1,'42',nativeAcceptance('a'),true,evidence('a'));
        assert.equal(resolved.status,'resolved');
        assert.equal(store.getOperation('a').status,'completed');
        assert.equal(store.getOutbox('a').state,'done');
        assert.deepEqual(store.recordNativeResult('i',1,'42',nativeAcceptance('a'),true,evidence('a')),resolved);
        assert.equal(store.acceptResponseSubmission('a').revision,2);
        const events = store.subscribeEvents('s',store.initialCursor('s'),100);
        assert.equal(events.status,'events');
        if (events.status === 'events') assert.deepEqual(events.events.filter(event=>event.type.startsWith('operation.')).map(event=>event.type),['operation.received','operation.accepted','operation.completed']);
      } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
    }
  });
  test('an uncorrelated closure preserves a local receipt and leaves a genuinely in-flight delivery unknown', () => {
    for (const submitted of [true,false]) {
      for (const disconnected of [true,false]) {
        const {dir,store} = setup();
        try {
          store.resolveInteraction(request('a'));
          assert.equal(store.claimOutbox('a'),true);
          if (submitted) store.acceptResponseSubmission('a');
          if (disconnected) store.setConnectionGeneration('s',1,2);
          else store.recordNativeResult('i',1,'42',{status:'accepted',source:'terminal',answer:null});
          assert.equal(store.getOutbox('a').state,submitted ? 'done' : 'unknown');
          assert.equal(store.getResponseOperation('i')?.status,submitted ? 'accepted' : 'unknown');
          assert.equal(store.getInteraction('i').status,disconnected ? 'expired' : 'resolved');
          assert.deepEqual(store.interactionHealthCounts(),{pending:0,unknown:submitted ? 0 : 1});
          assert.equal(store.claimOutbox('a'),false);
          const confirmed = store.recordNativeResult('i',1,'42',nativeAcceptance('a'),true,evidence('a'));
          assert.equal(confirmed.status,'resolved');
          assert.equal(store.getOperation('a').status,'completed');
        } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
      }
    }
  });
  test('two connections fence old pending delivery and retain its context', () => {
    const {dir,path,store: a} = setup(); const b = new UnifiedStore(path);
    try { const req = request('a'); a.resolveInteraction(req);
      assert.deepEqual(a.getOutbox('a').context,req.context); assert.equal(a.getOutbox('a').connectionGeneration,1);
      b.setConnectionGeneration('s',1,2); b.updateSession({...session,revision:1,control:{...session.control,generation:2}},0,1);
      assert.equal(a.claimOutbox('a'),false); assert.equal(a.getOutbox('a').state,'cancelled'); assert.equal(a.getOperation('a').status,'failed');
      assert.equal(a.getInteraction('i').status,'expired'); assert.deepEqual(a.resolveInteraction(req),a.getOperation('a'));
      assert.equal(a.applyHistoryRefresh(session,1,{
        session,interactions:[],
        turns:[{turnId:'t',sessionId:'native',status:'running',inputId:null,startedAt:null,endedAt:null,model:null,outputIds:[]}],
        messages:[{messageId:'m',sessionId:'native',turnId:'t',role:'assistant',blocks:[{type:'text',text:'stale'}],sequence:1,revision:1,final:true,source:'codex'}],
      }), false);
      assert.deepEqual(a.listTurns('s'),[]);
      assert.deepEqual(a.snapshot('s').value.messages,[]);
      assert.equal(a.applyHistoryRefresh(a.getSession('s'),2,{session,messages:[],interactions:[]}), true);
    } finally { b.close(); a.close(); rmSync(dir,{recursive:true,force:true}); }
  });
  test('control change fences pending and a claimed delivery becomes unknown on generation change', () => {
    for (const claimed of [false,true]) { const {dir,path,store: a} = setup(); const b = new UnifiedStore(path);
      try { a.resolveInteraction(request('a')); if (claimed) assert.equal(a.claimOutbox('a'),true);
        b.updateSession({...session,revision:1,control:{...session.control,generation:2}},0,1);
        assert.equal(a.claimOutbox('a'),false); assert.equal(a.getOutbox('a').state,claimed ? 'unknown' : 'cancelled');
        assert.equal(a.getOperation('a').status,claimed ? 'unknown' : 'failed');
        assert.equal(a.getInteraction('i').nativeResult,null);
      } finally { b.close(); a.close(); rmSync(dir,{recursive:true,force:true}); }
    }
  });
  test('concurrent claim and generation switch serialize across SQLite connections', async () => {
    const {dir,path,store} = setup(); store.resolveInteraction(request('a')); store.close();
    try { const results = await Promise.all([child(path,'x','claim'),child(path,'y','switch')]);
      assert.equal(results[1],'switched'); assert.ok(['claimed','blocked'].includes(results[0]!));
      const reopened = new UnifiedStore(path); try {
        assert.equal(reopened.getOutbox('a').state,results[0] === 'claimed' ? 'unknown' : 'cancelled');
        assert.equal(reopened.getOperation('a').status,results[0] === 'claimed' ? 'unknown' : 'failed');
        assert.equal(reopened.claimOutbox('a'),false); assert.equal(reopened.getInteraction('i').status,'expired');
      } finally { reopened.close(); }
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  test('expired interaction cannot be claimed', () => {
    const {dir,store} = setup(); try { store.resolveInteraction(request('a')); assert.equal(store.claimOutbox('a',NaN),false); assert.equal(store.getOutbox('a').state,'cancelled'); assert.equal(store.getInteraction('i').status,'expired'); } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
  });
  test('refuses a database belonging to another application', () => {
    const dir = mkdtempSync(join(tmpdir(),'unified-store-')); const path = join(dir,'other.sqlite');
    try { const db = new DatabaseSync(path); db.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES ('keep')"); db.close();
      assert.throws(() => new UnifiedStore(path), /refusing/); const verify = new DatabaseSync(path); assert.equal(verify.prepare('SELECT value FROM original').get()?.value,'keep'); verify.close();
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  test('snapshot and event watermark, deduplication, compaction and replay', () => {
    const {dir,store} = setup(); try {
      const snap = store.snapshot('s'); assert.equal(snap.value.interactions.length,1); assert.deepEqual(snap.value.messages,[]);
      const input = {eventId:'e',sessionId:'s',objectId:'s',objectRevision:0,type:'example',occurredAt:'2026-01-01T00:00:00Z',receivedAt:'2026-01-01T00:00:00Z',operationId:null,data:{x:1}};
      const event = store.appendEvent(input); assert.deepEqual(store.appendEvent(input),event); code(() => store.appendEvent({...input,data:{x:2}}),'idempotency_conflict');
      const page = store.subscribeEvents('s',snap.cursor,10); assert.equal(page.status,'events'); if (page.status === 'events') assert.deepEqual(page.events,[event]);
      store.compactEvents('s',event.cursor); assert.deepEqual(store.appendEvent(input),event); assert.equal(store.subscribeEvents('s',snap.cursor,10).status,'snapshot_required'); assert.equal(store.subscribeEvents('s',store.snapshot('s').cursor,10).status,'events');
    } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
  });

  test('bounded tool projection and live timing survive cursor compaction and restart', async () => {
    const { ToolProgressTracker } = await import('../src/unified/tool-progress.js');
    const { turnProgressCard } = await import('../src/unified/turn-progress-card.js');
    const dir = mkdtempSync(join(tmpdir(), 'tool-projection-'));
    const path = join(dir, 'db');
    let store = new UnifiedStore(path);
    const ref = { provider: 'claude' as const, hostId: 'h', serviceId: 'v', nativeSessionId: 'native' };
    const startedAt = '2026-01-01T00:00:00.000Z';
    const end = Date.parse(startedAt) + 120_001;
    try {
      store.insertSession({ sessionId: 's', native: ref, project: dir, title: 'tools', status: 'idle', revision: 0,
        capabilities: {} as Session['capabilities'],
        control: { serviceId: 'v', owner: 'owner', input: 'available', generation: 0, operationId: null, reason: null } });
      store.setConnectionGeneration('s', 0, 1);
      const turn = { sessionId: 's', turnId: 't', inputId: null, model: null, outputIds: [], endedAt: null, startedAt,
        status: 'running' as const };
      store.putTurn(turn);
      const historicalStart = store.eventWatermark('s');
      assert.equal(store.snapshot('s').value.turnProgress!.timing[0]!.liveStartSequence, null);
      assert.equal(store.observeTurn(turn, Date.parse(startedAt) + 20), true);
      const started = store.snapshot('s').value.turnProgress!.timing[0]!;
      assert.ok(started.liveStartSequence! > historicalStart);
      const runningCursor = store.eventWatermark('s');
      assert.equal(store.observeTurn(turn, Date.parse(startedAt) + 30), false);
      assert.equal(store.eventWatermark('s'), runningCursor);
      const tracker = new ToolProgressTracker();
      const append = (id: string, phase: 'pending' | 'running' | 'succeeded' | 'failed',
        generation = 1, emitter = tracker) => {
        const o = emitter.observe(ref, generation, 't', id, phase, { tool: 'Bash', summary: `Bash · ${id}` });
        assert.equal(o?.type, 'event');
        if (o?.type !== 'event') throw Error('expected tool event');
        const { schemaVersion, sequence, cursor, ...event } = o.event;
        return store.appendObservedEvent({ ...event, sessionId: 's' }, generation);
      };
      assert.equal(append('stale', 'running', 0), false);
      assert.equal(append('long', 'running'), true);
      assert.equal(append('queued', 'pending'), true);
      for (let n = 0; n < 260; n++) {
        assert.equal(append(String(n), 'running'), true);
        assert.equal(append(String(n), n === 0 || n === 259 ? 'failed' : 'succeeded'), true);
      }
      const projection = store.snapshot('s').value.turnProgress!;
      assert.equal(projection.tools.length, 256);
      assert.ok(projection.tools.some(tool => tool.callId === 'long' && tool.phase === 'running'));
      assert.ok(!projection.tools.some(tool => tool.callId === '0' || tool.callId === 'queued'));
      assert.deepEqual(projection.toolCounts, [{ turnId: 't', totalTools: 262, failedTools: 2 }]);
      const cardState = { provider: 'claude', schema: '2.0', message: undefined,
        tools: projection.tools, toolCounts: projection.toolCounts![0], duration: null, files: [] } as const;
      const card = turnProgressCard({ ...cardState, status: 'running' });
      assert.equal(card.executionLog!.count, 262);
      assert.equal(card.executionLog!.failedCount, 2);
      assert.equal(card.executionLog!.runningNote, '⏳ 正在执行：Bash · long');
      assert.equal(card.executionLog!.lines[0], '已省略较早的 247 项');
      assert.equal(turnProgressCard({ ...cardState, status: 'completed' }).text, '完成 262 项工具操作');
      assert.equal(append('0', 'failed', 1, new ToolProgressTracker()), false);
      assert.equal(append('0', 'succeeded', 1, new ToolProgressTracker()), false);
      assert.equal(append('queued', 'running'), true);
      const completed = { ...turn, endedAt: new Date(end).toISOString(), status: 'completed' as const };
      store.putTurn(completed);
      const historicalEnd = store.eventWatermark('s');
      const pendingTiming = store.snapshot('s').value.turnProgress!.timing[0]!;
      assert.equal(pendingTiming.liveStartSequence, started.liveStartSequence);
      assert.equal(pendingTiming.liveEndSequence, null);
      assert.equal(store.observeTurn(completed, end + 10), true);
      assert.equal(store.getSession('s').status, 'idle');
      const completedCursor = store.eventWatermark('s');
      assert.equal(store.observeTurn(completed, end + 20), false);
      assert.equal(store.eventWatermark('s'), completedCursor);
      const checkpoint = store.snapshot('s');
      store.compactEvents('s', checkpoint.cursor);
      store.close();
      store = new UnifiedStore(path);
      const recovered = store.snapshot('s');
      assert.deepEqual(recovered, checkpoint);
      assert.equal(recovered.value.turns[0]?.startedAt, startedAt);
      const { timing, tools, toolCounts } = recovered.value.turnProgress!;
      assert.equal(timing[0]!.endedMs! - timing[0]!.startedMs!, 120_001);
      assert.equal(timing[0]!.liveStartSequence, started.liveStartSequence);
      assert.ok(timing[0]!.liveEndSequence! > historicalEnd);
      assert.deepEqual(toolCounts, [{ turnId: 't', totalTools: 262, failedTools: 2 }]);
      assert.equal(tools.length, 256);
      assert.deepEqual(tools.filter(tool => tool.phase === 'running').map(tool => tool.callId), ['long', 'queued']);
      assert.equal(tools.at(-1)?.phase, 'failed');
      assert.ok(tools.every(tool => tool.connectionGeneration === 1 && tool.sequence > 0));
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('live completion cannot reuse a start from an earlier connection generation', () => {
    const {dir,store} = setup();
    try {
      const turn = { sessionId: 's', turnId: 't', inputId: null, model: null, outputIds: [], endedAt: null,
        startedAt: '2026-01-01T00:00:00.000Z' };
      const start = Date.parse(turn.startedAt);
      assert.equal(store.observeTurn({...turn, status:'running'}, start), true);
      store.setConnectionGeneration('s', 1, 2);
      const completed = {...turn, status:'completed' as const};
      store.putTurn(completed);
      assert.equal(store.observeTurn(completed, start + 120_001), false);
      const timing = store.snapshot('s').value.turnProgress!.timing[0]!;
      assert.equal(timing.liveStartSequence, null);
      assert.equal(timing.liveEndSequence, null);
    } finally { store.close(); rmSync(dir, {recursive:true, force:true}); }
  });
}
