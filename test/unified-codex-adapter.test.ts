import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodexTransport, type SocketFactory } from '../src/unified/codex-transport.js';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import { codexFilesystemProof } from '../src/unified/codex-approval.js';
import { interactionCard } from '../src/unified/feishu-cards.js';
import type { DispatchGuard, PlatformObservation } from '../src/unified/adapter.js';
import type { Interaction, NativeSessionRef } from '../src/unified/contracts.js';
class FakeSocket extends EventTarget {
  readyState = 0; sent: any[] = [];
  constructor(private readonly cwd = '/work', private readonly rollout?: string) { super(); }
  send(raw: string) { const m = JSON.parse(raw); this.sent.push(m); this.dispatchEvent(new MessageEvent('sent', { data: m })); if (m.method === 'initialize') queueMicrotask(() => this.message({ id: m.id, result: {} })); if (m.method === 'thread/resume') queueMicrotask(() => this.message({id:m.id,result:{thread:{id:m.params.threadId,cwd:this.cwd,path:this.rollout,status:{type:'idle'}}}})); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  response(id: string): Promise<unknown> {
    return new Promise(resolve => {
      const listener = (event: Event) => {
        const data = (event as MessageEvent).data;
        if (data.id !== id || !('result' in data)) return;
        this.removeEventListener('sent', listener);
        resolve(data.result);
      };
      this.addEventListener('sent', listener);
    });
  }
}
const errorCode = (code: string) => (e: unknown) => (e as { code?: string }).code === code;
const ref: NativeSessionRef = { provider: 'codex', hostId: 'h', serviceId: 's', nativeSessionId: 't' };
const guard: DispatchGuard = { expectedConnectionGeneration: 1, expectedControlGeneration: 1, assertCurrent() {} };
function setup(project?: string, options?: ConstructorParameters<typeof CodexAdapter>[3], rollout?: string) { const sockets: FakeSocket[] = []; const factory = (() => { const s = new FakeSocket(project, rollout); sockets.push(s); queueMicrotask(() => s.open()); return s; }) as unknown as SocketFactory; const transport = new CodexTransport('ws://127.0.0.1:1', factory, 100); const adapter = new CodexAdapter(transport, 'h', 's', options); const events: PlatformObservation[] = []; adapter.onObservation(e => { events.push(e); }); return { sockets, transport, adapter, events }; }
const question = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'turn', questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }, { id: 'q2', question: 'Why' }] } };
const lastInteraction = (events: PlatformObservation[]): Interaction => { const e = events.at(-1); assert.equal(e?.type, 'interaction'); return (e as Extract<PlatformObservation, { type: 'interaction' }>).interaction; };
function nextInteraction(adapter: CodexAdapter): Promise<Interaction> {
  return new Promise(resolve => {
    const off = adapter.onObservation(event => {
      if (event.type !== 'interaction') return;
      off();
      resolve(event.interaction);
    });
  });
}
test('disconnect makes in-flight outcome unknown without replay', async () => { const { sockets, transport } = setup(); await transport.connect(); const p = transport.request('thread/start', {}); sockets[0]!.close(); await assert.rejects(p, errorCode('outcome_unknown')); await transport.connect(); assert.deepEqual(sockets[1]!.sent.map(x => x.method), ['initialize', 'initialized']); transport.close(); });
test('multiple questions and multiple answers use native schema and await resolved', async () => {
  const { sockets, transport, adapter, events } = setup(); await transport.connect(); await adapter.resume(ref); sockets[0]!.message(question); const i = lastInteraction(events); assert.equal(i.kind, 'question_group'); if (i.kind !== 'question_group') throw Error(); assert.equal(i.questions[0]!.multiple, null);
  await adapter.respond(ref, i, { kind: 'question_group', answers: { q1: ['A', 'B'], q2: ['free text'] } }, guard);
  assert.deepEqual(sockets[0]!.sent.at(-1), { id: 7, result: { answers: { q1: { answers: ['A', 'B'] }, q2: { answers: ['free text'] } } } }); assert.equal(lastInteraction(events).status, 'answer_pending_delivery');
  sockets[0]!.message({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 7 } }); assert.equal(lastInteraction(events).status, 'resolved'); assert.deepEqual(lastInteraction(events).nativeResult, { status: 'accepted', source: 'unknown', answer: null });
  await assert.rejects(adapter.respond(ref, i, { kind: 'question_group', answers: { q1: ['A'], q2: ['x'] } }, guard), errorCode('interaction_expired')); transport.close();
});
test('old connection, wrong session, stale guard and incomplete answers cannot write', async () => {
  const { sockets, transport, adapter, events } = setup(); await transport.connect(); await adapter.resume(ref); sockets[0]!.message(question); const i = lastInteraction(events), answer = { kind: 'question_group' as const, answers: { q1: ['A'], q2: ['x'] } }; const count = sockets[0]!.sent.length;
  await assert.rejects(adapter.respond(ref, i, { kind: 'question_group', answers: { q1: ['A'] } }, guard), errorCode('invalid_request'));
  await assert.rejects(adapter.respond({ ...ref, nativeSessionId: 'other' }, i, answer, guard), errorCode('interaction_expired'));
  await assert.rejects(adapter.respond(ref, i, answer, { ...guard, assertCurrent() { throw { code: 'control_conflict' }; } }), errorCode('control_conflict')); assert.equal(sockets[0]!.sent.length, count);
  sockets[0]!.close(); await transport.connect(); sockets[1]!.message(question); await assert.rejects(adapter.respond(ref, i, answer, guard), errorCode('interaction_expired')); transport.close();
});
test('single approval deny is scoped and guard checked before write', async () => {
  const { sockets, transport, adapter } = setup(); await transport.connect(); await adapter.resume(ref);
  sockets[0]!.message({ method: 'turn/started', params: { threadId: 't', turn: { id: 'x', status: 'inProgress' } } });
  const observed = nextInteraction(adapter);
  sockets[0]!.message({ id: 'r', method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'x', command: 'sudo true' } });
  const i = await observed;
  await assert.rejects(adapter.respond(ref, i, { kind: 'approval', decision: 'allow', scope: 'other' }, guard), errorCode('invalid_request'));
  await adapter.respond(ref, i, { kind: 'approval', decision: 'deny', scope: 'this_request' }, guard); assert.deepEqual(sockets[0]!.sent.at(-1), { id: 'r', result: { decision: 'decline' } }); transport.close();
});
test('Codex automatically answers only current-turn approvals with confirmed ordinary targets', { timeout: 2_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'codex-approval-'));
  const homeDir = join(project, 'account');
  const protectedFile = join(homeDir, 'projects/projtool/README.md');
  const { sockets, transport, adapter, events } = setup(project, {
    approvalPolicy: { allowedRoots: [project], homeDir },
  });
  try {
    await mkdir(join(project, 'src'));
    await mkdir(join(project, '.git'));
    await mkdir(dirname(protectedFile), { recursive: true });
    await mkdir(join(project, 'nested', 'deep', '.codex'), { recursive: true });
    await writeFile(join(project, 'nested', 'deep', '.codex', 'hooks.json'), '{}');
    await symlink(tmpdir(), join(project, 'escape'));
    await transport.connect();
    await adapter.resume(ref);
    const socket = sockets[0]!;
    const start = (threadId: string, id: string) => socket.message({
      method: 'turn/started', params: { threadId, turn: { id, status: 'inProgress' } },
    });
    start('t', 'ours');
    start('unrelated', 'ours');
    const command = { method: 'item/commandExecution/requestApproval', params: {
      threadId: 't', turnId: 'ours', command: 'git status -sb && rg -n "ok" src | head -n 2',
    } };
    socket.message({ ...command, id: 'foreign', params: { ...command.params, threadId: 'unrelated' } });
    socket.message({ ...command, id: 'wrong-turn', params: { ...command.params, turnId: 'other' } });
    const reply = socket.response('command');
    socket.message({ ...command, id: 'command' });
    socket.message({ ...command, id: 'command' });
    assert.deepEqual(await reply, { decision: 'accept' });
    assert.equal(socket.sent.filter(request => request.id === 'command').length, 1);
    assert.equal(socket.sent.some(request => ['foreign', 'wrong-turn'].includes(request.id)), false);
    for (const [id, script, decision] of [
      ['shell-string', `/bin/bash -lc '${command.params.command}'`, 'accept'],
      ['shell-argv', ['/usr/bin/bash', '-c', command.params.command], 'accept'],
      ['shell-escaped-quote', String.raw`/bin/bash -lc 'rg -n '\''ok'\'' src'`, 'accept'],
      ['shell-blocked', `/bin/bash -lc 'echo x > ${protectedFile}'`, 'decline'],
    ] as const) {
      const response = socket.response(id);
      socket.message({ ...command, id, params: { ...command.params, command: script, kind: 'command',
        itemId: id, environmentId: null, startedAtMs: 0, additionalPermissions: null,
        proposedExecpolicyAmendment: null, availableDecisions: ['accept', 'decline'],
      } });
      assert.deepEqual(await response, { decision });
    }

    const approval = (id: string, itemId: string, fields: Record<string, unknown> = {}) => socket.message({
      id, method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'ours', itemId, ...fields },
    });
    const itemStarted = (id: string, path: string) => socket.message({
      method: 'item/started', params: {
        threadId: 't', turnId: 'ours', item: { id, type: 'fileChange', changes: [{ path }] },
      },
    });
    itemStarted('safe', 'src/example.ts');
    const safe = socket.response('file-safe');
    approval('file-safe', 'safe');
    assert.deepEqual(await safe, { decision: 'accept' });
    for (const alias of ['grantRoot', 'grant_root']) {
      const nested = socket.response(alias);
      approval(alias, 'safe', { [alias]: join(project, 'src') });
      assert.deepEqual(await nested, { decision: 'accept' });
    }
    const blocked = socket.response('file-blocked');
    approval('file-blocked', 'blocked-item', { changes: [{ path: protectedFile }] });
    assert.deepEqual(await blocked, { decision: 'decline' });
    for (const [id, fields] of [
      ['grant-projtool', { grantRoot: dirname(protectedFile) }],
      ['grant-nested-protected', { grantRoot: join(project, 'nested') }],
      ['protected-file-outside-grant', { grantRoot: '/tmp', changes: [{ path: protectedFile }] }],
      ['protected-alias-other-grant', { grantRoot: '/tmp', grant_root: dirname(protectedFile) }],
      ['protected-with-extra-fields', { grantRoot: dirname(protectedFile), permissions: { write: ['/tmp'] } }],
      ['protected-with-unknown-change', { changes: [{ path: protectedFile, extra: true }] }],
    ] as const) {
      const response = socket.response(id);
      approval(id, 'safe', fields);
      assert.deepEqual(await response, { decision: 'decline' });
    }
    const extraBlocked = socket.response('extended-deny');
    socket.message({ ...command, id: 'extended-deny', params: {
      ...command.params, command: `echo x > ${protectedFile}`, environmentId: 'foreign', cwd: 'unverified',
      additionalPermissions: { fileSystem: { write: ['/tmp'] } }, networkApprovalContext: { host: 'example.invalid' },
      availableDecisions: ['acceptForSession', 'cancel'],
    } });
    assert.deepEqual(await extraBlocked, { decision: 'cancel' });
    assert.equal(events.filter(event => event.type === 'interaction').length, 0);
    itemStarted('protected-paper', join(homeDir, 'papers/draft.tex'));
    for (const [item, reason] of [['missing', /完整参数/], ['protected-paper', /论文/]] as const) {
      const observed = nextInteraction(adapter);
      approval(`file-${item}`, item);
      const interaction = await observed;
      assert.equal(interaction.kind, 'approval');
      if (interaction.kind === 'approval') assert.match(interaction.action, reason);
    }
    const confirm = async (id: string, trigger: () => void) => {
      const observed = nextInteraction(adapter);
      trigger();
      assert.equal((await observed).kind, 'approval');
      assert.equal(socket.sent.some(request => request.id === id), false);
    };
    for (const [id, fields] of [
      ['grant-ancestor', { grantRoot: dirname(project) }],
      ['grant-outside', { grant_root: '/tmp' }],
      ['grant-protected', { grantRoot: join(project, '.git') }],
      ['grant-symlink', { grantRoot: join(project, 'escape') }],
      ['grant-invalid', { grantRoot: { path: join(project, 'src') } }],
      ['unknown-scope', { permissions: { fileSystem: { write: ['/tmp'] } } }],
      ['unknown-change', { changes: [{ path: 'src/example.ts', grants: ['/tmp'] }] }],
    ] as const) await confirm(id, () => approval(id, 'safe', fields));
    for (const [id, fields] of [
      ['extra-outer-word', { command: '/bin/bash -lc git status' }],
      ['extra-argv-word', { command: ['/bin/bash', '-lc', 'git status', 'unused'] }],
      ['outer-redirect', { command: `/bin/bash -lc 'git status' > src/log.txt` }],
      ['additive-command', { additionalPermissions: { fileSystem: { write: ['/tmp'] } } }],
      ['outside-cwd', { cwd: '/tmp', command: 'rg ok src' }],
    ] as const) await confirm(id, () => socket.message({ ...command, id, params: { ...command.params, ...fields } }));

    const constrained = nextInteraction(adapter);
    socket.message({ ...command, id: 'session-only', params: { ...command.params, availableDecisions: ['acceptForSession', 'cancel'] } });
    const interaction = await constrained;
    assert.deepEqual(interactionCard(interaction).actions.map(action => action.label), ['拒绝']);
    assert.match(interactionCard(interaction).text, /未提供单次允许/);
    await assert.rejects(adapter.respond(ref, interaction, { kind: 'approval', decision: 'allow', scope: 'this_request' }, guard), errorCode('invalid_request'));
    assert.equal(socket.sent.some(request => request.id === 'session-only'), false);
    await adapter.respond(ref, interaction, { kind: 'approval', decision: 'deny', scope: 'this_request' }, guard);
    assert.deepEqual(socket.sent.at(-1), { id: 'session-only', result: { decision: 'cancel' } });
  } finally {
    transport.close();
    await rm(project, { recursive: true, force: true });
  }
});
test('remote Codex approvals stay pending for a human when the matching local path is trusted', { timeout: 2_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'codex-remote-approval-'));
  const { sockets, transport, adapter } = setup(project, {
    approvalPolicy: { enabled: true, readRoots: [project] },
    proveSharedFilesystem: codexFilesystemProof('wss://codex.example.test', undefined),
  });
  try {
    await transport.connect();
    await adapter.resume(ref);
    const socket = sockets[0]!;
    socket.message({ method: 'turn/started', params: { threadId: 't', turn: { id: 'remote', status: 'inProgress' } } });
    const observed = nextInteraction(adapter);
    socket.message({
      id: 'remote-command', method: 'item/commandExecution/requestApproval',
      params: { threadId: 't', turnId: 'remote', command: 'cat README.md', cwd: project },
    });
    const interaction = await observed;
    assert.equal(interaction.kind, 'approval');
    assert.equal(socket.sent.some(request => request.id === 'remote-command'), false);
    await adapter.respond(ref, interaction, { kind: 'approval', decision: 'allow', scope: 'this_request' }, guard);
    assert.deepEqual(socket.sent.at(-1), { id: 'remote-command', result: { decision: 'accept' } });
  } finally {
    transport.close();
    await rm(project, { recursive: true, force: true });
  }
});

test('loopback Codex requires rollout proof from the known native thread', { timeout: 5_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'codex-filesystem-proof-'));
  const directory = join(project, 'catalog');
  const rollout = join(directory, 'rollout.jsonl');
  const outside = join(project, 'other.jsonl');
  const endpoint = 'ws://127.0.0.1:1234';
  const sources = [{ directory, provider: 'codex' as const, hostId: 'h', serviceId: 's' }];
  try {
    await mkdir(directory);
    await writeFile(rollout, '');
    await writeFile(outside, '');
    await symlink(outside, join(directory, 'escape.jsonl'));
    for (const [native, shared, accepts] of [
      [undefined, undefined, false], [outside, undefined, false], [join(directory, 'escape.jsonl'), undefined, false],
      [join(directory, 'missing.jsonl'), undefined, false], [rollout, undefined, true], [rollout, false, false],
      [undefined, true, true],
    ] as const) {
      const { sockets, transport, adapter } = setup(project, { proveSharedFilesystem: codexFilesystemProof(endpoint, shared, sources) }, native);
      try {
        await transport.connect();
        await adapter.resume(ref);
        const socket = sockets[0]!;
        socket.message({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn', status: 'inProgress' } } });
        const result = accepts ? socket.response('approval') : nextInteraction(adapter);
        socket.message({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {
          threadId: 't', turnId: 'turn', command: 'cat README.md',
        } });
        if (accepts) assert.deepEqual(await result, { decision: 'accept' });
        else {
          assert.match((await result as Extract<Interaction, { kind: 'approval' }>).action, /共享本机文件系统/);
          assert.equal(socket.sent.some(request => request.id === 'approval'), false);
        }
      } finally { transport.close(); }
    }
    assert.equal(await codexFilesystemProof('codex-proxy://default', false)(undefined), true);
    assert.equal(await codexFilesystemProof('wss://codex.example.test', true)(undefined), true);
  } finally { await rm(project, { recursive: true, force: true }); }
});
test('normalized message and turn observations include native reference', async () => {
  const { sockets, transport, events } = setup(); await transport.connect(); sockets[0]!.message({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn', status: 'inProgress' } } }); const turn = events.at(-1); assert.equal(turn?.type, 'turn'); assert.deepEqual(turn?.ref, ref);
  sockets[0]!.message({ method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'hello' } } }); const msg = events.at(-1); assert.equal(msg?.type, 'message'); if (msg?.type === 'message') assert.deepEqual(msg.message.blocks, [{ type: 'text', text: 'hello' }]); transport.close();
});
test('unsupported file and control operations return standard error', async () => { const { adapter } = setup(); await assert.rejects(adapter.listArtifacts(ref), errorCode('unsupported')); await assert.rejects(adapter.control(ref, 'acquire', guard), errorCode('unsupported')); });
test('list and read normalize provider data and preserve host/service reference', async () => {
  const { sockets, transport, adapter } = setup(); await transport.connect();
  const thread = { id: 't', cwd: '/work', name: 'title', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [{ id: 'item', type: 'agentMessage', text: 'ok' }] }] };
  const pendingList = adapter.list(null, 10); const listId = sockets[0]!.sent.at(-1).id; sockets[0]!.message({ id: listId, result: { data: [thread], nextCursor: null } }); const list = await pendingList; assert.deepEqual(list.items[0]!.native, ref);
  const pendingRead = adapter.read(ref); const readId = sockets[0]!.sent.at(-1).id; sockets[0]!.message({ id: readId, result: { thread } }); const snapshot = await pendingRead; assert.equal(snapshot.session.title, 'title'); assert.equal(snapshot.messages[0]!.messageId, 'item'); assert.deepEqual(snapshot.messages[0]!.blocks, [{ type: 'text', text: 'ok' }]); transport.close();
});
test('secret question is explicitly unsupported without responding', async () => { const { sockets, transport, events } = setup(); await transport.connect(); const count = sockets[0]!.sent.length; sockets[0]!.message({ id: 9, method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'x', questions: [{ id: 'a', question: 'Secret', isSecret: true }] } }); assert.equal(events.at(-1)?.type, 'event'); if (events.at(-1)?.type === 'event') assert.equal((events.at(-1) as Extract<PlatformObservation, { type: 'event' }>).event.type, 'interaction.unsupported'); assert.equal(sockets[0]!.sent.length, count); transport.close(); });

test('agent delta uses one native item and completed is authoritative, late delta ignored',async()=>{
 const {sockets,transport,adapter,events}=setup();await transport.connect();await adapter.resume(ref);
 for(const delta of ['a','b','c']) sockets[0]!.message({method:'item/agentMessage/delta',params:{threadId:'t',turnId:'turn',itemId:'i',delta}});
 sockets[0]!.message({method:'item/completed',params:{threadId:'t',turnId:'turn',item:{type:'agentMessage',id:'i',text:'authoritative'}}});
 sockets[0]!.message({method:'item/agentMessage/delta',params:{threadId:'t',turnId:'turn',itemId:'i',delta:'late'}});
 const ms=events.filter((e):e is Extract<PlatformObservation,{type:'message'}>=>e.type==='message');assert.equal(ms.length,4);assert.deepEqual(ms.map(x=>x.message.final),[false,false,false,true]);assert.deepEqual(ms.at(-1)!.message.blocks,[{type:'text',text:'authoritative'}]);assert.ok(ms.every(x=>x.connectionGeneration===1));transport.close();
});
test('residual inspection pages exact observed turn items and fails closed on reconnect',async()=>{const {sockets,transport,adapter}=setup();await transport.connect();await adapter.resume(ref);const emit=(m:any)=>sockets[0]!.message(m);emit({method:'turn/started',params:{threadId:'t',turn:{id:'turn',status:'inProgress'}}});emit({method:'item/started',params:{threadId:'t',turnId:'turn',item:{type:'commandExecution',id:'ours'}}});emit({method:'turn/started',params:{threadId:'t',turn:{id:'other',status:'inProgress'}}});emit({method:'item/started',params:{threadId:'t',turnId:'other',item:{type:'commandExecution',id:'theirs'}}});const pending=adapter.inspectTurnResidual(ref,'turn');let req=sockets[0]!.sent.at(-1);assert.equal(req.method,'thread/backgroundTerminals/list');emit({id:req.id,result:{data:[{itemId:'theirs',processId:'x',command:'secret',cwd:'/private'}],nextCursor:'next'}});await new Promise<void>(r=>setImmediate(r));req=sockets[0]!.sent.at(-1);assert.equal(req.params.cursor,'next');emit({id:req.id,result:{data:[{itemId:'ours',processId:'y',command:'secret',cwd:'/private'}],nextCursor:null}});const result=await pending;assert.equal(result.status,'running');assert.equal(result.count,1);assert.equal(result.complete,true);assert.doesNotMatch(JSON.stringify(result),/secret|private|processId/);sockets[0]!.close();await transport.connect();const stale=await adapter.inspectTurnResidual(ref,'turn');assert.equal(stale.status,'unknown');assert.equal(stale.count,null);transport.close();});
test('recent discovery uses native created seconds, interactive main source and bounded pages',async()=>{const {sockets,transport,adapter}=setup();await transport.connect();try{const now=Math.floor(Date.now()/1000),base={cwd:'/work',status:{type:'idle'},parentThreadId:null};const p=adapter.discoverNewer(now-10,null,2);const req=sockets[0]!.sent.at(-1);assert.equal(req.method,'thread/list');assert.equal(req.params.sortKey,'created_at');assert.equal(req.params.sortDirection,'desc');assert.equal(req.params.sourceKinds,undefined);sockets[0]!.message({id:req.id,result:{data:[{...base,id:'new',source:'cli',createdAt:now-1},{...base,id:'future',source:'vscode',createdAt:now+60},{...base,id:'sub',source:{subAgent:'x'},createdAt:now-1},{...base,id:'parent',source:'cli',parentThreadId:'root',createdAt:now-1},{...base,id:'edge',source:'cli',createdAt:now-10},{...base,id:'old',source:'cli',createdAt:now-20}],nextCursor:null}});const page=await p;assert.deepEqual(page.items.map(x=>x.native.nativeSessionId),['new','future']);assert.ok(page.items.every(x=>x.discoveryObservedAt));assert.equal(page.nextCursor,null);}finally{transport.close()}});
test('created-order old page ends recent scan without traversing historical backlog',async()=>{const {sockets,transport,adapter}=setup();await transport.connect();try{const now=Math.floor(Date.now()/1000),base={cwd:'/work',status:{type:'idle'},parentThreadId:null,source:'cli'};const p=adapter.discoverNewer(now-10,null,2);const req=sockets[0]!.sent.at(-1);sockets[0]!.message({id:req.id,result:{data:[{...base,id:'old1',createdAt:now-11},{...base,id:'old2',createdAt:now-12}],nextCursor:'old-pages'}});const page=await p;assert.deepEqual(page.items,[]);assert.equal(page.nextCursor,null);}finally{transport.close()}});
test('recent discovery handles duplicate and out-of-order pages without repeating identities',async()=>{const {sockets,transport,adapter}=setup();await transport.connect();try{const now=Math.floor(Date.now()/1000),base={cwd:'/work',status:{type:'idle'},parentThreadId:null,source:'cli'};const p=adapter.discoverNewer(now-10,null,1);let req=sockets[0]!.sent.at(-1);sockets[0]!.message({id:req.id,result:{data:[{...base,id:'one',createdAt:now-1}],nextCursor:'page2'}});const first=await p;assert.equal(first.items[0]?.native.nativeSessionId,'one');assert.ok(first.nextCursor);const q=adapter.discoverNewer(now-10,first.nextCursor,1);req=sockets[0]!.sent.at(-1);sockets[0]!.message({id:req.id,result:{data:[{...base,id:'old',createdAt:now-20},{...base,id:'one',createdAt:now-1},{...base,id:'two',createdAt:now-2}],nextCursor:null}});const second=await q;assert.deepEqual(second.items.map(x=>x.native.nativeSessionId),['two']);assert.equal(second.nextCursor,null);}finally{transport.close()}});
test('recent discovery reaches 10001st new item without cursor expiry or unbounded identity history',async()=>{const originalNow=Date.now;let now=originalNow(),calls=0;Date.now=()=>now;const created=Math.floor(now/1000)-1,watermark=created-10;const transport:any={connected:true,generation:1,onMessage:()=>{},onDisconnect:()=>{},async request(method:string,params:any){assert.equal(method,'thread/list');calls++;const offset=params.cursor?Number(params.cursor):0;const data=Array.from({length:Math.min(100,10001-offset)},(_,i)=>({id:`n${offset+i}`,cwd:'/work',status:{type:'idle'},source:'cli',parentThreadId:null,createdAt:created}));return {data,nextCursor:offset+100<10001?String(offset+100):null}}};const adapter=new CodexAdapter(transport,'h','s');try{let cursor:string|null=null,count=0,last='';do {const page=await adapter.discoverNewer(watermark,cursor,1);count+=page.items.length;last=page.items.at(-1)?.native.nativeSessionId ?? last;cursor=page.nextCursor;now+=100;}while(cursor!==null && count<10010);assert.equal(count,10001);assert.equal(last,'n10000');assert.equal(calls,101);}finally{Date.now=originalNow}});
test('bad new item metadata is isolated while later good item is returned',async()=>{const now=Math.floor(Date.now()/1000),transport:any={connected:true,generation:1,onMessage:()=>{},onDisconnect:()=>{},async request(){return {data:[{id:'bad',cwd:4,status:{type:'idle'},source:'cli',parentThreadId:null,createdAt:now-1},{id:'good',cwd:'/work',status:{type:'idle'},source:'cli',parentThreadId:null,createdAt:now-1}],nextCursor:null}}};const adapter=new CodexAdapter(transport,'h','s');const page=await adapter.discoverNewer(now-10,null,2);assert.equal(page.partialFailure,true);assert.deepEqual(page.items.map(s=>s.native.nativeSessionId),['good']);});

for (const completedBeforeAck of [false, true]) {
  test(`Codex first input and native rename preserve the latest turn status (early completion: ${completedBeforeAck})`, async () => {
    const {transport, adapter, sockets, events} = setup();
    try {
      await transport.connect();
      const socket = sockets[0]!;
      const creation = adapter.create('/work', null);
      socket.message({id: socket.sent.at(-1).id, result: {thread: {id: 't', cwd: '/work', status: {type: 'idle'}}}});
      await creation;
      const input = adapter.input(ref, 'new', [{type: 'text', text: '\n  查看   进展\n第二行'}], guard);
      const startId = socket.sent.at(-1).id;
      if (completedBeforeAck) {
        socket.message({method: 'turn/completed', params: {threadId: 't', turn: {id: 'turn', status: 'completed'}}});
      }
      socket.message({id: startId, result: {turn: {id: 'turn'}}});
      await input;
      const lastSession = () => {
        const event = events.at(-1);
        assert.equal(event?.type, 'session');
        return [event.session.title, event.session.status];
      };
      assert.deepEqual(lastSession(), ['查看 进展', completedBeforeAck ? 'idle' : 'running']);
      socket.message({method: 'turn/started', params: {threadId: 't', turn: {id: 'next', status: 'inProgress'}}});
      socket.message({method: 'thread/name/updated', params: {threadId: 't', threadName: '新的名称'}});
      assert.deepEqual(lastSession(), ['新的名称', 'running']);
      socket.message({method: 'turn/completed', params: {threadId: 't', turn: {id: 'next', status: 'completed'}}});
      socket.message({method: 'thread/name/updated', params: {threadId: 't', threadName: '归档前检查'}});
      assert.deepEqual(lastSession(), ['归档前检查', 'idle']);
      socket.message({method: 'turn/completed', params: {threadId: 't', turn: {id: 'final', status: 'interrupted'}}});
      socket.message({method: 'thread/name/updated', params: {threadId: 't', threadName: '保留中断状态'}});
      assert.deepEqual(lastSession(), ['保留中断状态', 'interrupted']);
    } finally {
      transport.close();
    }
  });
}
