import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../src/unified/claude-adapter.js';
import type { Interaction, WriteContext } from '../src/unified/contracts.js';
import { createIntegratedRuntime } from '../src/unified/runtime.js';
import { evaluateApproval, resolveApprovalFacts, type ApprovalContext, type ApprovalRequest, type ApprovalScope, type GateDecision } from '../src/unified/approval-policy.js';

const tick = () => new Promise(r => setImmediate(r));
function fixture(approvalPolicy?: ApprovalScope) {
  let options: any, prompt: any, end!: () => void, push!: (m: any) => void;
  const events: any[] = [], writes: any[] = [];
  const sdk: any = { query: (p: any) => {
    options = p.options; prompt = p.prompt;
    const queue: any[] = []; let wake: (() => void) | undefined; let closed = false;
    const finish = () => { closed = true; wake?.(); };
    end = finish;
    push = (m: any) => { queue.push(m); wake?.(); };
    return {
      async *[Symbol.asyncIterator]() { while (!closed || queue.length) { if (queue.length) yield queue.shift(); else await new Promise<void>(r => { wake = r; }); } },
      close() { writes.push('close'); finish(); },
      interrupt: async () => { writes.push('interrupt'); },
      setModel: async (x: unknown) => { writes.push(x); },
      supportedModels: async () => [{ value: 'm', displayName: 'Model' }],
    };
  }, listSessions: async () => [], getSessionMessages: async () => [] };
  const adapter = new ClaudeAdapter('host', 'service', mkdtempSync(join(tmpdir(), 'claude-port-')), sdk, undefined, approvalPolicy ? { approvalPolicy } : {});
  adapter.onObservation(x => events.push(x));
  const nextInteraction = () => new Promise<Interaction>(resolve => {
    const off = adapter.onObservation(event => {
      if (event.type !== 'interaction') return;
      off();
      resolve(event.interaction);
    });
  });
  const guard: any = { expectedConnectionGeneration: null, expectedControlGeneration: 1, assertCurrent() {} };
  return { adapter, guard, events, writes, get options() { return options; }, get prompt() { return prompt; },
    push: (m: any) => push(m), end: () => end(), nextInteraction };
}

test('SDK input guarded; tool approval denial and native result are separately observed', async () => {
  const f = fixture(); const id = (await f.adapter.create('/tmp', null)).nativeReference!; const ref = { provider: 'claude' as const, hostId: 'host', serviceId: 'service', nativeSessionId: id };
  const reject = { ...f.guard, assertCurrent() { throw Error('stale'); } };
  await assert.rejects(f.adapter.input(ref, 'new', [{ type: 'text', text: 'hello' }], reject));
  await f.adapter.input(ref, 'new', [{ type: 'text', text: 'hello' }], f.guard);
  const titleUpdates = f.events.filter(event => event.type === 'session');
  assert.deepEqual(titleUpdates.map(event => [event.session.title, event.session.status]), [['hello', 'running']]);
  assert.equal((await f.adapter.read(ref)).session.title, 'hello');
  assert.equal((await f.adapter.list(null, 10)).items[0]?.title, 'hello');
  assert.equal((await f.prompt[Symbol.asyncIterator]().next()).value.message.content, 'hello');
  const observed = f.nextInteraction();
  const ac = new AbortController(); const decision = f.options.canUseTool('Bash', { command: 'sudo true' }, { signal: ac.signal, toolUseID: 'tool1' });
  const i = await observed; assert.equal(i.kind, 'approval');
  await assert.rejects(f.adapter.respond(ref, i, { kind: 'approval', decision: 'allow', scope: 'this_request' }, { ...reject, expectedConnectionGeneration: i.connectionGeneration }));
  await f.adapter.respond(ref, i, { kind: 'approval', decision: 'deny', scope: 'this_request' }, { ...f.guard, expectedConnectionGeneration: i.connectionGeneration });
  assert.equal((await decision).behavior, 'deny'); assert.equal(f.events.at(-1).interaction.status, 'answer_pending_delivery');
  f.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1' }] } }); await tick();
  assert.deepEqual(f.events.at(-1).interaction.nativeResult, { status: 'unknown', source: 'claude_tool_result' });
  f.push({ type: 'result', subtype: 'success', is_error: false }); await tick(); assert.equal(f.events.at(-1).turn.status, 'completed'); f.end();
});

test('multi-question free text, expiration, and unknown sessions cannot be resumed', async () => {
  const f = fixture(); const id = (await f.adapter.create('/tmp', 'm')).nativeReference!; const ref = { provider: 'claude' as const, hostId: 'host', serviceId: 'service', nativeSessionId: id };
  const ac = new AbortController(); const decision = f.options.canUseTool('AskUserQuestion', { questions: [{ question: 'First?', options: [{ label: 'A' }], multiSelect: false }, { question: 'Second?', options: [], multiSelect: true }] }, { signal: ac.signal, toolUseID: 'q' });
  const i: Interaction = f.events.at(-1).interaction; assert.equal(i.kind, 'question_group');
  await f.adapter.respond(ref, i, { kind: 'question_group', answers: { '0': ['custom'], '1': ['x', 'y'] } }, { ...f.guard, expectedConnectionGeneration: i.connectionGeneration });
  assert.deepEqual((await decision).updatedInput.answers, { 'First?': 'custom', 'Second?': 'x, y' });
  const observed = f.nextInteraction();
  const ac2 = new AbortController(); const decision2 = f.options.canUseTool('Bash', { command: 'sudo true' }, { signal: ac2.signal, toolUseID: 'other' }); const j = await observed; ac2.abort(); assert.equal((await decision2).behavior, 'deny'); await assert.rejects(f.adapter.respond(ref, j, { kind: 'approval', decision: 'allow', scope: 'this_request' }, { ...f.guard, expectedConnectionGeneration: j.connectionGeneration }));
  await assert.rejects(f.adapter.resume({ ...ref, nativeSessionId: 'unknown' }), (e: any) => e.code === 'temporarily_unavailable'); f.end();
});

test('image bytes are verified and connection closure expires outstanding requests', async () => {
  const f = fixture(); const id = (await f.adapter.create('/tmp', null)).nativeReference!; const ref = { provider: 'claude' as const, hostId: 'host', serviceId: 'service', nativeSessionId: id };
  const bad = { type: 'artifact' as const, artifactId: 'a', contentVersion: '1', name: 'x.png', mediaType: 'image/png', content: new Uint8Array([1, 2]) };
  await assert.rejects(f.adapter.input(ref, 'new', [bad], f.guard), (e: any) => e.code === 'unsupported');
  const png = { ...bad, content: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }; await f.adapter.input(ref, 'new', [png], f.guard);
  assert.equal((await f.prompt[Symbol.asyncIterator]().next()).value.message.content[0].source.media_type, 'image/png');
  const observed = f.nextInteraction();
  const ac = new AbortController(); const decision = f.options.canUseTool('Bash', { command: 'sudo true' }, { signal: ac.signal, toolUseID: 'pending' }); const i = await observed;
  f.end(); await tick(); assert.equal((await decision).behavior, 'deny'); assert.equal(f.events.at(-1).interaction.status, 'expired');
  await assert.rejects(f.adapter.respond(ref, i, { kind: 'approval', decision: 'allow', scope: 'this_request' }, { ...f.guard, expectedConnectionGeneration: i.connectionGeneration }));
});

test('owned and explicitly resumed external sessions preserve their origin across adapter restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-owned-')); const queries: any[] = []; let sessionId = '';
  const externalId = '12345678-1234-1234-1234-123456789abc';
  const closed: string[] = [];
  let failInitialization = false;
  const sdk: any = {
    listSessions: async () => [sessionId, externalId].filter(Boolean).map(id => ({ sessionId: id, cwd: '/tmp', summary: '', lastModified: 1 })),
    getSessionMessages: async () => [],
    query: (arg: any) => {
      queries.push(arg);
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      return {
        async *[Symbol.asyncIterator]() { await finished; },
        async initializationResult() { if (failInitialization) throw Error('startup failed'); },
        close() { closed.push(arg.options.resume ?? arg.options.sessionId); finish(); },
      };
    },
  };
  const first = new ClaudeAdapter('h', 's', dir, sdk); sessionId = (await first.create('/tmp', null)).nativeReference!;
  await first.close();
  const second = new ClaudeAdapter('h', 's', dir, sdk); const ref = { provider: 'claude' as const, hostId: 'h', serviceId: 's', nativeSessionId: sessionId };
  const external = { ...ref, nativeSessionId: externalId };
  const registry = () => JSON.parse(readFileSync(join(dir, 'claude-owned.json'), 'utf8'));
  assert.equal((await second.resume(ref)).nativeReference, sessionId); assert.equal(queries[1].options.resume, sessionId);
  const ac = new AbortController();
  const observed = new Promise<Interaction>(resolve => {
    const off = second.onObservation(o => {
      if (o.type !== 'interaction') return;
      off();
      resolve(o.interaction);
    });
  });
  const pending = queries[1].options.canUseTool('Bash', { command: 'sudo true' }, { signal: ac.signal, toolUseID: 'p' });
  assert.equal((await observed).connectionGeneration, 2); ac.abort(); await pending;
  assert.equal((await second.read(external)).session.status, 'read_only');
  assert.equal((await second.read(external)).session.capabilities.handoff.status, 'unsupported');
  assert.equal(queries.length, 2);
  assert.equal(Object.hasOwn(registry().sessions, externalId), false);
  failInitialization = true;
  await assert.rejects(second.resume(external), /startup failed/);
  assert.equal(closed.at(-1), externalId);
  assert.equal((await queries[2].prompt[Symbol.asyncIterator]().next()).done, true);
  assert.equal(Object.hasOwn(registry().sessions, externalId), false);
  assert.equal(second.hasActiveNativeSession(external), false);
  failInitialization = false;
  const externalReceipt = await second.resume(external);
  assert.equal(externalReceipt.nativeReference, externalId);
  assert.equal((await second.read(external)).session.control.owner, 's');
  assert.deepEqual(registry().sessions, { [sessionId]: { origin: 'bridge_sdk' }, [externalId]: { origin: 'external_resume' } });
  await second.close();
  const third = new ClaudeAdapter('h', 's', dir, sdk);
  assert.ok((await third.resume(external)).connectionGeneration! > externalReceipt.connectionGeneration!);
  await third.close();
  const invalid = registry();
  invalid.sessions[externalId].origin = 'external';
  writeFileSync(join(dir, 'claude-owned.json'), JSON.stringify(invalid));
  assert.throws(() => new ClaudeAdapter('h', 's', dir, sdk), (e: any) => e.code === 'temporarily_unavailable');
});


test('idle handoff closes the SDK connection and duplicate questions are denied without an answer', async () => {
  const f = fixture(); const created = await f.adapter.create('/tmp', null); const ref = created.createdSession!.native;
  assert.equal(created.createdSession!.control.owner, ref.serviceId);
  assert.equal((await f.adapter.list(null, 10)).items[0]!.capabilities.handoff.status, 'available');
  await assert.rejects(f.adapter.control(ref, 'acquire', f.guard), (e: any) => e.code === 'busy');
  const ac = new AbortController(); const decision = await f.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Same?', options: [{ label: 'A' }] }, { question: 'Same?', options: [{ label: 'B' }] }] }, { signal: ac.signal, toolUseID: 'dup' });
  assert.equal(decision.behavior, 'deny'); assert.match(decision.message, /Unsupported question group/); assert.equal(decision.updatedInput, undefined);
  const o = f.events.at(-1); assert.equal(o.type, 'event'); assert.equal(o.event.type, 'interaction.unsupported'); assert.match(o.event.data.reason, /duplicate/);
  const guard = { ...f.guard, expectedConnectionGeneration: created.connectionGeneration! };
  const ask = f.options.canUseTool('AskUserQuestion', { question: 'Continue?' }, { signal: ac.signal, toolUseID: 'pending' });
  await assert.rejects(f.adapter.control(ref, 'release', guard), (e: any) => e.code === 'busy');
  const interaction = f.events.at(-1).interaction;
  await f.adapter.respond(ref, interaction, { kind: 'question_group', answers: { '0': ['Yes'] } }, guard);
  await ask;
  await assert.rejects(f.adapter.control(ref, 'release', guard), (e: any) => e.code === 'busy');
  f.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'pending' }] } });
  await tick();
  await f.adapter.input(ref, 'new', [{ type: 'text', text: 'handoff test' }], guard);
  await assert.rejects(f.adapter.control(ref, 'release', guard), (e: any) => e.code === 'busy');
  const inputIterator = f.prompt[Symbol.asyncIterator]();
  await inputIterator.next();
  f.push({ type: 'result', subtype: 'success', is_error: false });
  await tick();
  await assert.rejects(f.adapter.control(ref, 'release', { ...guard, expectedConnectionGeneration: created.connectionGeneration! + 1 }),
    (e: any) => e.code === 'control_conflict');
  await assert.rejects(f.adapter.control(ref, 'release', { ...guard, assertCurrent() { throw Error('stale'); } }), /stale/);
  assert.equal(f.writes.includes('close'), false);
  assert.equal((await f.adapter.control(ref, 'release', guard)).nativeReference, 'unsubscribed');
  assert.deepEqual(f.writes, ['close']);
  assert.equal((await inputIterator.next()).done, true);
  assert.equal(f.adapter.hasActiveNativeSession(ref), false);
  const released = f.events.at(-1);
  assert.equal(released.type, 'session');
  assert.equal(released.session.status, 'read_only');
  assert.equal(released.session.control.owner, null);
  assert.equal(released.session.control.input, 'unavailable');
  assert.equal(released.session.capabilities.handoff.status, 'available');
  assert.equal((await f.adapter.read(ref)).session.title, 'handoff test');
  const acquired = await f.adapter.control(ref, 'acquire', guard);
  assert.equal(acquired.nativeReference, ref.nativeSessionId);
  assert.ok(acquired.connectionGeneration! > created.connectionGeneration!);
  assert.equal(f.options.resume, ref.nativeSessionId);
  const active = f.events.at(-1).session;
  assert.equal(active.control.owner, ref.serviceId);
  assert.ok(active.control.generation > released.session.control.generation);
  await f.adapter.close();
});

test('scoped runtime attaches and hands back the same external Claude session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-runtime-handoff-'));
  const project = join(dir,'project'), logs = join(dir,'logs');
  mkdirSync(project); mkdirSync(logs);
  const nativeSessionId = '11111111-2222-4333-8444-555555555555';
  const ref = {provider:'claude',hostId:'h',serviceId:'c',nativeSessionId} as const;
  const resumed: string[] = [];
  let closes = 0;
  const sdk: any = {
    listSessions: async () => [{sessionId:nativeSessionId,cwd:project,summary:'Desktop session',lastModified:1}],
    getSessionMessages: async () => [],
    query: ({options}: any) => {
      resumed.push(options.resume);
      let end!: () => void;
      const closed = new Promise<void>(resolve => { end = resolve; });
      return {async *[Symbol.asyncIterator]() { await closed; }, close() { closes++; end(); }};
    },
  };
  const adapter = new ClaudeAdapter('h','c',dir,sdk);
  const config = {
    coreDb:join(dir,'core.db'),channelDb:join(dir,'channel.db'),artifactStatePath:join(dir,'artifact.json'),
    ownerOpenId:'owner',allowedDestinations:['chat'],hostId:'h',claudeServiceId:'c',codexServiceId:'x',
    claudeStateDir:dir,codexEndpoint:'codex-proxy://default',intervalMs:100,
    catalogSources:[{...ref,directory:logs}],allowedProjectRoots:[project],outputRoots:[project],
  };
  const bot = {send:async () => 'message',update:async () => {},sendFile:async () => {}};
  let runtime = await createIntegratedRuntime(config,bot,[adapter]);
  const context = (operationId: string, sessionId = 'new'): WriteContext => {
    const session = runtime.store.findSession(ref);
    return {operationId,idempotencyKey:operationId,targetId:sessionId,identity:{source:'feishu',subject:'owner'},
      expectedRevision:session?.revision ?? 0,controlGeneration:session?.control.generation ?? 0};
  };
  try {
    const binding = await runtime.core.attachSession({context:context('read'),payload:{...ref,mode:'read_only'}});
    assert.equal(binding.result?.kind,'session');
    const sessionId = binding.result.sessionId;
    assert.deepEqual(resumed,[]);
    await runtime.core.attachSession({context:context('upgrade'),payload:{...ref,mode:'interactive'}});
    const generation = runtime.store.connectionGeneration(sessionId);
    assert.deepEqual(resumed,[nativeSessionId]);
    assert.equal(runtime.store.getSession(sessionId).control.owner,'c');
    await runtime.core.releaseControl({context:context('release',sessionId),payload:{owner:'c'}});
    assert.equal((await runtime.core.dispatch('release')).status,'completed');
    assert.equal(closes,1);
    assert.equal(runtime.store.getSession(sessionId).status,'read_only');
    assert.equal(runtime.store.hasInteractiveIntent(sessionId),false);
    await runtime.core.requestControl({context:context('acquire',sessionId),payload:{owner:'c',strategy:'wait'}});
    assert.equal((await runtime.core.dispatch('acquire')).status,'completed');
    assert.equal(runtime.store.getSession(sessionId).control.input,'available');
    assert.ok(runtime.store.connectionGeneration(sessionId) > generation);
    assert.deepEqual(resumed,[nativeSessionId,nativeSessionId]);
    await runtime.close();
    runtime = await createIntegratedRuntime(config,bot,[new ClaudeAdapter('h','c',dir,sdk)]);
    assert.equal(runtime.store.getSession(sessionId).control.input,'unavailable');
    await runtime.core.attachSession({context:context('attach-after-restart'),payload:{...ref,mode:'interactive'}});
    assert.equal(runtime.store.getSession(sessionId).control.input,'available');
    assert.deepEqual(resumed,[nativeSessionId,nativeSessionId,nativeSessionId]);
  } finally {
    await runtime.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('native tool error does not assert that the approval was rejected', async () => {
  const f = fixture(); const id = (await f.adapter.create('/tmp', null)).nativeReference!; const ref = { provider: 'claude' as const, hostId: 'host', serviceId: 'service', nativeSessionId: id };
  const observed = f.nextInteraction();
  const ac = new AbortController(); const decision = f.options.canUseTool('Bash', { command: 'sudo true' }, { signal: ac.signal, toolUseID: 'err' }); const i = await observed;
  await f.adapter.respond(ref, i, { kind: 'approval', decision: 'allow', scope: 'this_request' }, { ...f.guard, expectedConnectionGeneration: i.connectionGeneration }); await decision;
  f.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'err', is_error: true }] } }); await tick();
  assert.deepEqual(f.events.at(-1).interaction.nativeResult, { status: 'unknown', source: 'claude_tool_result_error' }); f.end();
});

test('SDK approval policy permits routine commands and enforces red lines before native defaults', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-policy-'));
  const home = join(directory, 'home');
  const f = fixture({ homeDir: home });
  try {
    await f.adapter.create(directory, null);
    assert.equal(f.options.permissionMode, 'default');
    const signal = new AbortController().signal;
    const hook = f.options.hooks.PreToolUse[0].hooks[0];
    const check = (tool: string, input: Record<string, unknown>, toolUseID: string) => hook({
      hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: toolUseID, cwd: directory,
    }, toolUseID, { signal });
    const ordinary = { command: 'git status -sb && rg -n "UnifiedCore" src/unified | head -n 5' };
    assert.deepEqual(await check('Bash', ordinary, 'routine'), {});
    assert.deepEqual(await f.options.canUseTool('Bash', ordinary, { signal, toolUseID: 'routine' }), {
      behavior: 'allow', updatedInput: ordinary,
    });
    assert.deepEqual(await check('Bash', { ...ordinary, dangerouslyDisableSandbox: false }, 'sandboxed'), {});
    const unknownInputs: [string, Record<string, unknown>][] = [
      ['Bash', { ...ordinary, dangerouslyDisableSandbox: true }],
      ['Bash', { ...ordinary, dangerouslyDisableSandbox: null }],
      ['Bash', { ...ordinary, cwd: '/etc' }],
      ...['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit'].map(
        (tool): [string, Record<string, unknown>] => [tool, {
          [tool === 'NotebookEdit' ? 'notebook_path' : ['Glob', 'Grep', 'LS'].includes(tool) ? 'path' : 'file_path']: join(directory, 'file.txt'),
          extension: true,
        }],
      ),
      ['MultiEdit', { file_path: join(directory, 'file.txt'), edits: [{ old_string: 'a', new_string: 'b', file_path: '/etc/hosts' }] }],
    ];
    for (const [index, [tool, input]] of unknownInputs.entries()) {
      assert.equal((await check(tool, input, `manual-${index}`)).hookSpecificOutput.permissionDecision, 'ask', tool);
    }
    const protectedInput = { file_path: join(directory, '.claude/settings.json') };
    assert.equal((await check('Write', protectedInput, 'deny')).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await f.options.canUseTool('Write', protectedInput, { signal, toolUseID: 'deny' })).behavior, 'deny');
    const projtoolFile = join(home, 'projects/projtool/edit.ts');
    assert.equal((await f.options.canUseTool('Write', { file_path: 'safe.ts' }, {
      signal, toolUseID: 'blocked', blockedPath: projtoolFile,
    })).behavior, 'deny');
    assert.equal((await f.options.canUseTool('Write', { file_path: projtoolFile }, {
      signal, toolUseID: 'blocked-input', defaultToNo: true,
    })).behavior, 'deny');
    assert.deepEqual(f.events.filter(event => event.type === 'interaction'), []);
    for (const [native, reason] of [
      [{ matchedAskRule: { source: 'user', toolName: 'Write' }, decisionReason: 'ask rule matched' }, /ask rule matched/],
      [{ blockedPath: 'safe.ts' }, /原生权限规则/],
      [{ defaultToNo: true }, /原生权限规则/],
    ] as const) {
      const next = f.nextInteraction();
      const controller = new AbortController();
      const pending = f.options.canUseTool('Write', { file_path: 'safe.ts' }, {
        ...native, signal: controller.signal, toolUseID: `native-${Object.keys(native)[0]}`,
      });
      assert.match((await next as Extract<Interaction, { kind: 'approval' }>).action, reason);
      controller.abort();
      assert.equal((await pending).behavior, 'deny');
    }
    assert.equal((await check('Read', { file_path: join(directory, '..', 'neighbor.txt') }, 'neighbor')).hookSpecificOutput.permissionDecision, 'ask');
    const paper = { file_path: join(home, 'papers/draft.tex') };
    assert.equal((await check('Edit', paper, 'paper')).hookSpecificOutput.permissionDecision, 'ask');
    const observed = f.nextInteraction();
    const controller = new AbortController();
    const decision = f.options.canUseTool('Edit', paper, { signal: controller.signal, toolUseID: 'paper' });
    assert.match((await observed as Extract<Interaction, { kind: 'approval' }>).action, /论文/);
    controller.abort();
    assert.equal((await decision).behavior, 'deny');
  } finally {
    f.end();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('approval facts resolve shell effects, symbolic links, and effective Git push URLs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'approval-policy-'));
  const homeDir = join(directory, 'account');
  const projtool = join(homeDir, 'projects/projtool');
  const papers = join(homeDir, 'papers');
  const reviews = join(homeDir, 'reviews');
  const checker = join(homeDir, 'scripts/pm-check/pm_check.py');
  const exec = promisify(execFile);
  try {
    for (const path of [join(directory, 'sub/deep'), papers, projtool, join(reviews, 'private'), join(homeDir, 'scripts/pm-check')]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(checker, 'print("fixture")\n');
    writeFileSync(join(directory, 'pm_check.py'), 'from urllib.parse import unquote\nprint(unquote("example"))\n');
    writeFileSync(join(directory, 'file.txt'), 'fixture\n');
    writeFileSync(join(directory, 'package.json'), '{"scripts":{"check":"echo check","test":"echo test"}}');
    mkdirSync(join(directory, 'sub/build'));
    const tscConfig = (name: string, compilerOptions: Record<string, unknown>) => {
      writeFileSync(join(directory, 'sub/build', name), JSON.stringify({ compilerOptions }));
    };
    writeFileSync(join(directory, 'sub/build/tsconfig.json'), '{ // fixture\n "compilerOptions": {"outDir":"dist","rootDir":".",},\n}');
    writeFileSync(join(directory, 'sub/build/inherited.json'), '{"extends":"./tsconfig.json"}');
    tscConfig('escape.json', { outDir: '/etc' });
    tscConfig('declarations.json', { outDir: 'dist', declarationDir: 'declarations-link', declaration: true });
    symlinkSync('/etc', join(directory, 'sub/build/declarations-link'));
    tscConfig('protected.json', { outDir: '../../account/projects/projtool' });
    tscConfig('incremental.json', { outDir: 'dist', tsBuildInfoFile: 'build.tsbuildinfo', incremental: true });
    tscConfig('incremental-escape.json', { outDir: 'dist', tsBuildInfoFile: '/etc/build.tsbuildinfo', incremental: true });
    tscConfig('info-escape.json', { outDir: 'dist', tsBuildInfoFile: '/etc/build.tsbuildinfo' });
    tscConfig('no-output.json', {});
    tscConfig('nested-link.json', { outDir: 'dist-link' });
    mkdirSync(join(directory, 'sub/build/dist-link'));
    symlinkSync('/etc', join(directory, 'sub/build/dist-link/escape'));
    symlinkSync('/etc', join(directory, 'outside'));
    symlinkSync(join(directory, 'missing'), join(directory, 'dangling'));
    symlinkSync(papers, join(directory, 'paper-link'));
    symlinkSync(join(directory, 'sub/deep'), join(directory, 'dir-link'));
    symlinkSync(join(reviews, 'private'), join(directory, 'review-link'));
    symlinkSync(directory, join(reviews, 'public-link'));
    mkdirSync(join(directory, 'cleanup/nested/.claude'), { recursive: true });
    writeFileSync(join(directory, 'cleanup/nested/.claude/settings.json'), '{}');
    mkdirSync(join(directory, 'linked-cleanup'));
    symlinkSync(projtool, join(directory, 'linked-cleanup/tool'));
    mkdirSync(join(directory, 'repo-cleanup/.git'), { recursive: true });
    mkdirSync(join(directory, 'outside-cleanup'));
    symlinkSync('/etc', join(directory, 'outside-cleanup/link'));
    const git = (...args: string[]) => exec('git', ['-C', directory, ...args]);
    const gitValue = async (...args: string[]) => (await git(...args)).stdout.trim();
    const commitTree = (tree: string, ...args: string[]) => gitValue('-c', 'user.name=Approval Test',
      '-c', 'user.email=test@example.invalid', 'commit-tree', tree, '-m', 'fixture', ...args);
    await git('init', '-q', '--initial-branch=main');
    await git('add', '--', 'file.txt');
    const initial = await commitTree(await gitValue('write-tree'));
    await git('update-ref', 'refs/heads/main', initial);
    const blob = await gitValue('rev-parse', 'HEAD:file.txt');
    const branch = async (name: string, path: string) => {
      await git('update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
      const commit = await commitTree(await gitValue('write-tree'), '-p', initial);
      await git('update-ref', `refs/heads/${name}`, commit);
      await git('read-tree', 'HEAD');
      return commit;
    };
    const other = await branch('other', 'sub/ ordinary file.txt');
    const restricted = await branch('restricted', '.claude/settings.json');
    await branch('paper', 'account/papers/draft.tex');
    await git('update-ref', 'refs/heads/ambiguous', other);
    await git('update-ref', 'refs/tags/ambiguous', restricted);
    await git('remote', 'add', 'origin', 'https://example.com/some/project.git');
    await git('config', 'remote.origin.pushurl', 'https://github.com/phylipppp-zzy/research.git');
    await git('remote', 'add', 'alias', 'project-policy-test:research.git');
    await git('config', 'url.ssh://git@ssh.github.com:443/phylipppp-zzy/.pushInsteadOf', 'project-policy-test:');
    await git('remote', 'add', 'blocked', 'https://github.com/phylipppp-zzy/projtool.git');
    await git('remote', 'add', 'foreign', 'https://example.com/phylipppp-zzy/research.git');
    await git('remote', 'add', '123', 'https://example.com/phylipppp-zzy/research.git');
    await git('-C', join(reviews, 'private'), 'init', '-q');
    await git('-C', join(reviews, 'private'), 'remote', 'add', 'origin', 'https://github.com/phylipppp-zzy/research.git');
    const commands: [string, GateDecision['kind']][] = [
      ['cd sub && git status -sb && rg -n "A B" ../src | head -n 5; echo ok > "out file"', 'allow_once'],
      ['cd sub; git status -sb\nrg -n "A B" src', 'allow_once'],
      ['ls -la\ncat ./sub/file.txt || echo empty', 'allow_once'],
      ['cat -n /etc/hosts', 'ask'],
      ['wc -l /etc/hosts', 'ask'],
      ['readlink -f /etc/hosts', 'ask'],
      ['ls -n /etc/hosts', 'ask'],
      ['head -n10 file.txt && tail --lines=10 -- file.txt && cut -f1 file.txt', 'allow_once'],
      ['tail -f file.txt', 'ask'],
      ['tail --follow=name file.txt', 'ask'],
      ['wc --files0-from=list.txt', 'ask'],
      ['cat --lines file.txt', 'ask'],
      ['rg -nf file.txt -ffile.txt --file=file.txt sub', 'allow_once'],
      ['grep -nf file.txt -ffile.txt --file=file.txt sub', 'allow_once'],
      ['rg -f file.txt -f /etc/hosts sub', 'ask'],
      ['grep --file=file.txt --file=/etc/hosts sub', 'ask'],
      ['grep -n -f/etc/hosts sub', 'ask'],
      ['rg -nf/etc/hosts sub', 'ask'],
      ['rg -f=/etc/hosts sub', 'ask'],
      ['rg -nf=/etc/hosts sub', 'ask'],
      ['rg -f file.txt /etc/hosts', 'ask'],
      ['rg --files /etc', 'ask'],
      ['rg --pre=tool fixture sub', 'ask'],
      ['rg -nz fixture sub', 'ask'],
      ['grep --unrecognized fixture sub', 'ask'],
      ['npm run check && npm test && go test ./... && python3 -m py_compile src.py', 'allow_once'],
      ['make all', 'ask'],
      ['npm run check -- --unknown=value', 'ask'],
      ['tsc --noEmit --pretty && vitest --run --silent && go test -race -count=2 -run Test ./...', 'allow_once'],
      ['tsc -p sub/build', 'allow_once'],
      ['tsc -p sub/build/tsconfig.json', 'allow_once'],
      ['tsc -p sub/build/inherited.json', 'ask'],
      ['tsc -p sub/build/missing.json', 'ask'],
      ['tsc -p sub/build/escape.json', 'ask'],
      ['tsc -p sub/build/escape.json --noEmit true', 'allow_once'],
      ['tsc -p sub/build/escape.json --noEmit false', 'ask'],
      ['tsc -p sub/build/no-output.json --noEmit null', 'ask'],
      ['tsc -p sub/build/protected.json', 'deny'],
      ['tsc -p sub/build/declarations.json --outDir out', 'ask'],
      ['tsc -p sub/build/nested-link.json', 'ask'],
      ['tsc -p sub/build/incremental.json --noEmit', 'allow_once'],
      ['tsc -p sub/build/incremental-escape.json --noEmit', 'ask'],
      ['tsc -p sub/build/info-escape.json', 'ask'],
      ['tsc -p sub/build/no-output.json', 'ask'],
      ['tsc -p sub/build/no-output.json --outDir dist', 'allow_once'],
      ['tsc -p sub/build/no-output.json --outDir null', 'ask'],
      ['npx vitest --run', 'ask'],
      ['pytest -q --tb=short -k smoke -m unit --maxfail=1', 'allow_once'],
      ['pytest -qs', 'ask'],
      ['pytest -p plugin', 'ask'],
      ['pytest --log-file=sub/test.log', 'allow_once'],
      [`pytest --log-file=${projtool}/x`, 'deny'],
      [`python3 -m pytest --junitxml ${projtool}/x.xml`, 'deny'],
      ['pytest --unknown=value', 'ask'],
      ['pytest -c sub/pytest.ini', 'ask'],
      ['npx vitest --config=sub/config.ts', 'ask'],
      ['npx vitest --unknown=value', 'ask'],
      ['jest --setupFiles ./setup.js', 'ask'],
      ['cargo test --config ./cargo.toml', 'ask'],
      ['go test -exec ./runner ./...', 'ask'],
      ['eslint --format=stylish src', 'allow_once'],
      ['eslint --format=/etc/custom-formatter.js src', 'ask'],
      ['make -f - check', 'ask'],
      ['go test -o=account/projects/projtool/test.bin ./...', 'deny'],
      ['cargo test --target-dir=account/papers --release --lib', 'ask'],
      ['python3 pm_check.py sub/file.txt', 'ask'],
      [`python3 '${checker}' sub/file.txt`, 'allow_once'],
      [`python3 '${checker}' --all sub/file.txt`, 'ask'],
      [`python3 '${checker}' /etc/hosts`, 'ask'],
      ['node --check file.txt', 'allow_once'],
      ['node -c file.txt', 'allow_once'],
      ['node --test --test-name-pattern hello file.txt', 'allow_once'],
      ['node file.txt --check', 'ask'],
      ['node file.txt --test', 'ask'],
      ['node -- --check file.txt', 'ask'],
      ['node --check file.txt extra', 'ask'],
      ['node --test file.txt --test-force-exit', 'ask'],
      ['node --test --import ./unknown.mjs file.txt', 'ask'],
      ['node --test --test-reporter-destination=output file.txt', 'ask'],
      ['node --check --env-file=.env file.txt', 'ask'],
      ['node --test /etc/hosts', 'ask'],
      ['npx tsx file.txt --test', 'ask'],
      ['uniq -cf1 in out', 'allow_once'],
      ['uniq --skip-chars=1 -- in account/papers/draft.tex', 'ask'],
      ['uniq in account/projects/projtool/out', 'deny'],
      ['uniq --unknown in out', 'ask'],
      ['uniq in out extra', 'ask'],
      ['sort -noaccount/projects/projtool/out in', 'deny'],
      ['sort --temporary-directory=account/papers in', 'ask'],
      ['cd dir-link && cd .. && echo ok > output', 'ask'],
      ['cd -L sub && pwd', 'ask'],
      ['cd -P sub && pwd', 'ask'],
      [`python3 -c 'from pathlib import Path; print(Path("sub/file.txt").exists())'`, 'allow_once'],
      [`python3 -c 'from pathlib import Path; Path("/etc/resolv.conf").write_text("")'`, 'ask'],
      ['git push', 'allow_once'],
      ['git status && git push', 'allow_once'],
      ['sort file.txt | git push', 'allow_once'],
      ['sort -o output.txt file.txt | git push', 'ask'],
      ['echo log > output.txt && git push', 'ask'],
      ['git switch other && git push', 'ask'],
      ['touch file.txt && git switch other', 'ask'],
      ['npm test && git checkout other', 'ask'],
      ['git -C sub push -u alias HEAD', 'allow_once'],
      ['git push git@github.com:phylipppp-zzy/research.git HEAD', 'allow_once'],
      ['git push origin main refs/heads/other', 'allow_once'],
      ['git push origin main refs/heads/feature', 'ask'],
      ['git push --all origin', 'ask'],
      ['git push origin --tags', 'ask'],
      ['git push --force origin HEAD', 'ask'],
      ['git push origin +HEAD:main', 'ask'],
      ['git push origin :main', 'ask'],
      ['git push --delete origin main', 'ask'],
      ['git push --mirror origin', 'ask'],
      ['git push foreign HEAD', 'ask'],
      ["git push '123'> output.log", 'ask'],
      ['git push 2> output.log', 'allow_once'],
      ['printf -v PATH /tmp && git push', 'ask'],
      ['git push --force blocked HEAD', 'deny'],
      ['git -C account/reviews/private push origin HEAD', 'deny'],
      ['git -C review-link push origin HEAD', 'deny'],
      ['git -C account/reviews/public-link push origin HEAD', 'deny'],
      ['cd account/reviews && git push origin HEAD', 'deny'],
      ['git commit -aqvsm draft --allow-empty', 'allow_once'],
      ['git commit --message=draft --all --quiet --verbose --signoff', 'allow_once'],
      ['git commit -Ffile.txt', 'allow_once'],
      ['git commit --file=file.txt', 'allow_once'],
      ['git commit -t file.txt', 'allow_once'],
      ['git commit --template=file.txt', 'allow_once'],
      ['git commit -F missing.txt', 'ask'],
      ['git commit --file=outside/hosts', 'ask'],
      ['git commit -t /etc/hosts', 'ask'],
      ['git commit --template=sub', 'ask'],
      ['git commit --amend -m draft', 'ask'],
      ['git commit --exec=command -m draft', 'ask'],
      ['git commit -c HEAD', 'ask'],
      ['git stash list', 'ask'],
      ['git stash show -p', 'ask'],
      ['git stash', 'ask'],
      ['git stash push -u -m draft', 'ask'],
      ['git stash push -u -m draft -- file.txt', 'ask'],
      ['git stash save draft', 'ask'],
      ['git status -sb && git log --oneline -n2 && git diff --cached --name-only', 'allow_once'],
      ['git grep -n -e fixture -- file.txt && git rev-parse --verify --short HEAD', 'allow_once'],
      ['git grep -O fixture', 'ask'],
      ['git grep --open-files-in-pager=more fixture', 'ask'],
      ['git diff --ext-diff', 'ask'],
      ['git diff --textconv', 'ask'],
      ...['clear', 'drop', 'pop', 'apply', 'branch new', 'push --all', 'push -qa'].map(
        (args): [string, GateDecision['kind']] => [`git stash ${args}`, 'ask'],
      ),
      ['git restore file.txt', 'ask'],
      ['git restore --source HEAD -- file.txt', 'ask'],
      ['git restore --staged -- file.txt', 'allow_once'],
      ['git restore -S file.txt', 'allow_once'],
      ['git restore -SW -- file.txt', 'ask'],
      ['git restore --staged --worktree -- file.txt', 'ask'],
      ['git checkout -- file.txt', 'ask'],
      ['git checkout HEAD -- .', 'ask'],
      ['git checkout file.txt', 'ask'],
      ['git checkout -b safe-branch', 'allow_once'],
      ['git checkout -B safe-branch', 'ask'],
      ['git checkout -m safe-branch', 'ask'],
      ['git switch -c safe-branch', 'allow_once'],
      ['git switch other', 'allow_once'],
      ['git checkout other', 'allow_once'],
      ['git switch -c new other', 'allow_once'],
      ['git switch restricted', 'deny'],
      ['git -C sub switch restricted', 'deny'],
      ['git checkout -b new restricted', 'deny'],
      [`git checkout --detach ${restricted}`, 'deny'],
      ['git switch paper', 'ask'],
      ['git switch ambiguous', 'ask'],
      ['git switch does-not-exist', 'ask'],
      ['git switch --discard-changes safe-branch', 'ask'],
      ['git branch -d branch', 'ask'],
      ['git branch -M branch', 'ask'],
      ['git branch --force branch', 'ask'],
      ['git merge --abort', 'ask'],
      ['git merge other', 'ask'],
      ['git status && sudo true', 'ask'],
      ['git status && rm -rf /data/zhangzy/outputs', 'ask'],
      ['rm -rf account/projects', 'deny'],
      ['rm -rf cleanup', 'deny'],
      ['mv cleanup renamed', 'deny'],
      ['rm -rf linked-cleanup', 'deny'],
      ['rm -rf repo-cleanup', 'ask'],
      ['rm -rf outside-cleanup', 'ask'],
      ['cat account/papers/draft.tex account/projects/projtool/README.md', 'allow_once'],
      ['echo text >> paper-link/draft.tex', 'ask'],
      ['echo text > account/projects/projtool/file', 'deny'],
      ['cp -taccount/projects/projtool new-file', 'deny'],
      ["sed -i 's/a/b/g' sub/file.txt", 'allow_once'],
      ["sed -i 's/a/b/g' account/projects/projtool/file", 'deny'],
      ['echo text > outside/hosts', 'ask'],
      ['echo text > dangling/file', 'ask'],
    ];
    const files: [ApprovalRequest, GateDecision['kind']][] = [
      [{ kind: 'read', paths: ['sub/file.txt'] }, 'allow_once'],
      [{ kind: 'write', paths: ['sub/new-file.txt'] }, 'allow_once'],
      [{ kind: 'write', paths: ['paper-link/draft.tex'] }, 'ask'],
      [{ kind: 'write', paths: ['dangling/file'] }, 'ask'],
      [{ kind: 'write', paths: [join(projtool, 'new-file')] }, 'deny'],
      [{ kind: 'write', paths: ['sub/.claude/settings.json'] }, 'deny'],
      [{ kind: 'write', paths: ['sub/.claude/skills/sapphire-owned/SKILL.md'] }, 'allow_once'],
      ...[
        '.claude/skills/ml-research-workflow/SKILL.md', '.agents/skills/image-debug/a',
        '.codex/skills/projtool-bootstrap/SKILL.md', '.claude/hooks/check-running-instances.sh',
        '.claude/hooks/check-ssh-train.sh', '.codex/hooks.json', '.codex/hooks/run-claude-pretooluse-hook.sh',
      ].map((path): [ApprovalRequest, GateDecision['kind']] => [{ kind: 'write', paths: [`sub/${path}`] }, 'deny']),
      [{ kind: 'question' }, 'question'],
    ];
    for (const [request, expected] of [
      ...commands.map(([command, expected]) => [{ kind: 'command', command }, expected] as [ApprovalRequest, GateDecision['kind']]),
      ...files,
    ]) {
      const actual = evaluateApproval(await resolveApprovalFacts(request, { cwd: directory, project: directory, homeDir }));
      assert.equal(actual.kind, expected, `${JSON.stringify(request)} yielded ${JSON.stringify(actual)}`);
      if (request.kind === 'command' && request.command?.match(/review.+push/) && expected === 'deny') {
        assert.ok(actual.kind === 'deny' && /reviews\/.*保密盲审/.test(actual.reason));
      }
    }
    const scope = { cwd: directory, project: directory, homeDir };
    const read: ApprovalRequest = { kind: 'read', paths: ['file.txt'] };
    const cases: [ApprovalRequest, ApprovalContext, GateDecision['kind']][] = [
      [read, { cwd: directory }, 'ask'],
      [read, { ...scope, allowedRoots: [] }, 'allow_once'],
      [read, { ...scope, allowedRoots: [join(directory, 'sub')] }, 'allow_once'],
      [read, { ...scope, allowedRoots: [directory] }, 'allow_once'],
      [read, { ...scope, enabled: false }, 'ask'],
      [{ kind: 'write', paths: [projtool] }, { ...scope, enabled: false }, 'ask'],
      [{ kind: 'question' }, { ...scope, enabled: false }, 'question'],
      [{ kind: 'command', command: 'pwd' }, { ...scope, cwd: join(directory, 'dir-link') }, 'ask'],
      [{ kind: 'command', command: 'git push origin HEAD' }, { ...scope, cwd: reviews }, 'deny'],
      [{ kind: 'command', command: 'node --test' }, { ...scope, cwd: papers }, 'ask'],
      [{ kind: 'write', paths: [checker] }, scope, 'ask'],
      [{ kind: 'write', paths: [join(homeDir, '.ssh/config')] }, scope, 'ask'],
      [{ kind: 'write', paths: [join(homeDir, '.config/settings')] }, scope, 'ask'],
    ];
    for (const [request, context, expected] of cases) {
      const actual = evaluateApproval(await resolveApprovalFacts(request, context));
      assert.equal(actual.kind, expected, `${JSON.stringify([request, context])} yielded ${JSON.stringify(actual)}`);
    }
    const push = async (command: string) => evaluateApproval(await resolveApprovalFacts({ kind: 'command', command }, scope));
    const reviewed = await branch('reviewed', 'account/reviews/blind draft.txt');
    await git('update-ref', 'refs/heads/removed', await commitTree(await gitValue('write-tree'), '-p', reviewed));
    await git('update-ref', 'refs/tags/reviewed-tag', reviewed);
    for (const command of [
      'git push origin main', 'git push origin missing', 'git push origin reviewed', 'git push origin +removed:main', 'git push origin main removed',
      'git push origin tag reviewed-tag', 'git push origin --tags', 'git push origin --all',
      'git push origin "refs/heads/*:refs/heads/*"',
    ]) {
      const decision = await push(command);
      assert.ok(decision.kind === 'deny' && /reviews\/.*保密盲审/.test(decision.reason), command);
    }
    await git('config', 'remote.origin.push', 'removed:refs/heads/main');
    assert.equal((await push('git push origin')).kind, 'deny');
    await git('config', '--unset-all', 'remote.origin.push');
    for (const ref of ['refs/heads/reviewed', 'refs/heads/removed', 'refs/tags/reviewed-tag']) {
      await git('update-ref', '-d', ref);
    }
    assert.equal((await push('git push origin main')).kind, 'allow_once');
    assert.equal((await push(`git push origin ${reviewed}:refs/heads/main`)).kind, 'deny');
    assert.equal((await push('git -C sub stash')).kind, 'ask');
    await git('-C', projtool, 'init', '-q');
    const protectedTip = await gitValue('-C', projtool, '-c', 'user.name=Approval Test',
      '-c', 'user.email=test@example.invalid', 'commit-tree',
      await gitValue('-C', projtool, 'write-tree'), '-m', 'fixture');
    await git('-C', projtool, 'worktree', 'add', '--detach', join(directory, 'protected-worktree'), protectedTip);
    await git('worktree', 'add', '--detach', join(directory, 'ordinary-worktree'), initial);
    assert.equal((await push('git -C protected-worktree status -sb')).kind, 'allow_once');
    assert.equal((await push('git -C protected-worktree commit -m draft')).kind, 'deny');
    assert.equal((await push('git -C protected-worktree reset --hard')).kind, 'deny');
    assert.equal((await push('git -C ordinary-worktree commit -m draft')).kind, 'allow_once');
    const linkedOnly = { cwd: join(directory, 'ordinary-worktree'), project: join(directory, 'ordinary-worktree'), homeDir, readRoots: [directory] };
    assert.equal(evaluateApproval(await resolveApprovalFacts({ kind: 'command', command: 'git commit -m draft' }, linkedOnly)).kind, 'ask');
    assert.equal((await push('git -C ordinary-worktree stash -u')).kind, 'ask');
    await git('config', '--add', 'remote.origin.push', '+HEAD:refs/heads/main');
    assert.equal((await push('git push origin')).kind, 'ask');
    await git('config', '--add', 'remote.origin.push', 'x'.repeat(70_000));
    assert.equal((await push('git push origin')).kind, 'ask', 'an overflowing config query cannot hide a force refspec');
    await git('config', '--unset-all', 'remote.origin.push');
    await git('config', 'remote.origin.mirror', 'invalid');
    assert.equal((await push('git push origin HEAD')).kind, 'ask', 'an invalid boolean config value cannot count as unset');
    await git('config', '--unset-all', 'remote.origin.mirror');
    await git('config', '--add', 'url.https://example.invalid/.pushInsteadOf', 'x'.repeat(70_000));
    assert.equal((await push('git push git@github.com:phylipppp-zzy/research.git HEAD')).kind, 'ask',
      'an overflowing URL rewrite query cannot count as having no rewrite rules');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('package script approval checks lifecycle scripts and trusted local Node test imports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'approval-package-'));
  const project = join(root, 'project');
  const dependencies = join(root, 'dependencies');
  const homeDir = join(root, 'account');
  const context = { project, cwd: project, homeDir };
  const decide = async (command: string, overrides: Partial<ApprovalContext> = {}) =>
    evaluateApproval(await resolveApprovalFacts({ kind: 'command', command }, { ...context, ...overrides }));
  const manifest = (scripts: Record<string, string>) =>
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts }));
  try {
    mkdirSync(join(project, 'test'), { recursive: true });
    writeFileSync(join(project, 'test/sample.test.ts'), '');
    assert.equal((await decide('npm test')).kind, 'ask', 'missing manifest');
    writeFileSync(join(project, 'package.json'), '{');
    assert.equal((await decide('npm test')).kind, 'ask', 'invalid manifest');
    manifest({ pretest: 'echo prepare', test: 'node --import tsx --test test/*.test.ts', posttest: 'echo done' });
    assert.equal((await decide('npm test')).kind, 'ask', 'missing tsx');
    mkdirSync(join(dependencies, 'tsx'), { recursive: true });
    symlinkSync(dependencies, join(project, 'node_modules'));
    assert.equal((await decide('npm test')).kind, 'ask', 'tsx outside read scope');
    const trustDependencies = { readRoots: [dependencies] };
    for (const command of ['npm test', 'pnpm run test', 'yarn test', 'node --test --import=tsx test/sample.test.ts']) {
      assert.equal((await decide(command, trustDependencies)).kind, 'allow_once', command);
    }
    assert.equal((await decide('node --check --import=tsx test/sample.test.ts', trustDependencies)).kind, 'ask');
    assert.equal((await decide('npm test -- --unknown-flag', trustDependencies)).kind, 'ask');
    symlinkSync('/etc/hosts', join(project, 'test/outside.test.ts'));
    assert.equal((await decide('npm test', trustDependencies)).kind, 'ask', 'glob includes target outside read scope');
    manifest({
      test: 'pnpm run check',
      check: 'echo check',
      deep: 'npm run test',
      preguard: 'make all',
      guard: 'echo guard',
      postguard: 'echo guard > .claude/settings.json',
    });
    assert.equal((await decide('npm test')).kind, 'allow_once');
    assert.equal((await decide('npm run deep')).kind, 'ask', 'nested script depth limit');
    assert.equal((await decide('npm run missing')).kind, 'ask', 'missing script');
    assert.equal((await decide('yarn run guard -- --unknown-flag')).kind, 'deny', 'lifecycle deny wins over asks');
    writeFileSync(join(project, 'conftest.py'), '');
    assert.equal((await decide('pytest -q')).kind, 'ask', 'implicit executable configuration');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('partial text blocks converge on one message and omit tool and thinking', async()=>{
  const f=fixture(); await f.adapter.create('/tmp',null); assert.equal(f.options.includePartialMessages,true);
  const push=(event:any)=>f.push({type:'stream_event',parent_tool_use_id:null,event});
  push({type:'message_start',message:{id:'inner'}});
  push({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
  for(const text of ['a','b','c']) push({type:'content_block_delta',index:0,delta:{type:'text_delta',text}});
  f.push({type:'assistant',uuid:'outer-one',parent_tool_use_id:null,message:{id:'inner',content:[{type:'text',text:'abc'}]}});
  push({type:'content_block_start',index:1,content_block:{type:'tool_use'}});
  push({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'secret'}});
  push({type:'content_block_start',index:2,content_block:{type:'text',text:''}});
  push({type:'content_block_delta',index:2,delta:{type:'text_delta',text:'xyz'}});
  push({type:'message_stop'});
  f.push({type:'assistant',uuid:'outer-two',parent_tool_use_id:null,message:{id:'inner',content:[{type:'text',text:'xyz'}]}});
  push({type:'content_block_delta',index:2,delta:{type:'text_delta',text:'late'}});
  await tick(); const messages=f.events.filter(x=>x.type==='message').map(x=>x.message); assert.ok(messages.filter(x=>!x.final).length>=3); assert.ok(messages.every(x=>x.messageId==='inner')); assert.deepEqual(messages.at(-1).blocks,[{type:'text',text:'abc\nxyz'}]); assert.equal(messages.at(-1).final,true); f.end();
});

for (const is_error of [false, true]) test(`Claude emits safe tool lifecycle, error=${is_error}`, async () => {
  const f = fixture();
  const created = await f.adapter.create('/tmp/project', null);
  const ref = created.createdSession!.native;
  try {
    const input = await f.adapter.input(ref, 'new', [{ type: 'text', text: 'tools' }], f.guard);
    const call = { type: 'tool_use', name: 'Bash', id: 'tool-a', input: { command: 'npm test --token=private-data' } };
    const start = { type: 'stream_event', event: { type: 'content_block_start', content_block: call } };
    f.push({ ...start, parent_agent_id: 'child' });
    f.push(start);
    f.push({ type: 'assistant', uuid: 'm', message: { content: [call] } });
    f.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-a', is_error, content: 'private output' }] } });
    f.push(start);
    await tick();
    const tools = f.events.filter(o => o.type === 'event' && o.event.type === 'tool.updated');
    assert.deepEqual(tools.map(o => o.event.data), [
      { turnId: input.nativeReference, callId: 'tool-a', phase: 'running', tool: 'Bash', summary: 'Bash · npm test' },
      { turnId: input.nativeReference, callId: 'tool-a', phase: is_error ? 'failed' : 'succeeded', tool: 'Bash', summary: 'Bash · npm test' },
    ]);
    assert.ok(tools.every(o => o.connectionGeneration === created.connectionGeneration));
    assert.equal(f.events.some(o => o.type === 'message' && o.message.role === 'assistant'), false);
  } finally { f.end(); }
});
