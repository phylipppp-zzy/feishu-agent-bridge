import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyAdapter } from '../src/unified/agy-adapter.js';
import { AgyCatalog } from '../src/unified/agy-catalog.js';
import { AgyAcpTransport, buildAgyAcpArgs } from '../src/unified/agy-transport.js';
import {
  convertSchemaValue,
  DEFAULT_AGY_MODELS,
  DEFAULT_PROMPT_MAX_TIMEOUT_MS,
  extractSchemaChoices,
  schemaAllowsFreeText,
} from '../src/unified/agy/adapter-types.js';
import type { DispatchGuard, PlatformObservation } from '../src/unified/adapter.js';
import type { Answer, Interaction } from '../src/unified/contracts.js';
import { UnifiedCore } from '../src/unified/service.js';
import { UnifiedStore } from '../src/unified/store.js';

function makeGuard(expectedConnectionGeneration: number | null): DispatchGuard {
  return {
    expectedControlGeneration: 0,
    expectedConnectionGeneration,
    assertCurrent() {},
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, msg = 'condition timed out'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 15));
  }
  assert.ok(predicate(), msg);
}

async function writeCoreFakeAgy(binPath: string, rpcLogPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
import { appendFileSync, createReadStream, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';

const rpcLogPath = ${JSON.stringify(rpcLogPath)};
const log = (entry) => appendFileSync(rpcLogPath, JSON.stringify(entry) + '\\n');
const writeMsg = (obj) => writeSync(1, JSON.stringify(obj) + '\\n');

let seq = 0;
let srvReqId = 500;
const pendingServerReplies = new Map();
const activePrompts = new Map();

const sendServerRequest = (method, params) => {
  const id = 'core-srv-' + (++srvReqId);
  writeMsg({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    pendingServerReplies.set(id, { resolve, reject });
  });
};

const rl = createInterface({ input: createReadStream(undefined, { fd: 0, autoClose: false }), crlfDelay: Infinity });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  if (msg.id !== undefined && msg.method === undefined && pendingServerReplies.has(msg.id)) {
    const waiter = pendingServerReplies.get(msg.id);
    pendingServerReplies.delete(msg.id);
    log({ direction: 'client_reply', id: msg.id, result: msg.result, error: msg.error });
    if (msg.error) waiter.reject(msg.error);
    else waiter.resolve(msg.result);
    return;
  }

  const { id, method, params } = msg;
  log({ direction: 'client_call', hasId: id !== undefined, id: id ?? null, method, params });

  const reply = (result) => {
    if (id !== undefined) writeMsg({ jsonrpc: '2.0', id, result });
  };
  const replyError = (code, message) => {
    if (id !== undefined) writeMsg({ jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'initialize') {
    reply({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'fake-agy-core', version: '1.5.16-test' },
    });
    return;
  }

  if (method === 'session/new') {
    const sid = 'core-sess-' + (++seq);
    reply({
      sessionId: sid,
      models: {
        currentModelId: 'gemini-4-carbon-high',
        availableModels: [
          { modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
          { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        ],
      },
      configOptions: [{ id: 'thought_level', category: 'thought_level', currentValue: 'high' }],
    });
    return;
  }

  if (method === 'session/load') {
    reply({
      sessionId: params.sessionId,
      models: {
        currentModelId: 'gemini-4-neon-xhigh',
        availableModels: [
          { modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
          { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        ],
      },
      configOptions: [{ id: 'thought_level', category: 'thought_level', currentValue: 'xhigh' }],
    });
    return;
  }

  if (method === 'session/set_model') {
    if (params.modelId === 'fail-model') {
      replyError(-32000, 'model unavailable');
      return;
    }
    reply({});
    return;
  }

  if (method === 'session/set_config_option' || method === 'session/close' || method === 'session/set_mode') {
    if (method === 'session/close' && params.sessionId === globalThis.__failCloseSid) {
      replyError(-32601, 'session/close not supported');
      return;
    }
    reply({});
    return;
  }

  if (method === 'test/fail_close_for') {
    globalThis.__failCloseSid = params.sessionId;
    reply({});
    return;
  }

  if (method === 'test/emit_terminal_tool') {
    reply({});
    writeMsg({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId: params.toolCallId, status: 'completed' },
      },
    });
    return;
  }

  if (method === 'test/emit_stalled_wakeup_tool') {
    reply({});
    writeMsg({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'wakeup-stuck-1', title: 'Stuck tool', status: 'in_progress' },
      },
    });
    return;
  }

  // Strictly ACP v1 notification: NEVER reply to session/cancel!
  if (method === 'session/cancel') {
    const entry = activePrompts.get(params.sessionId);
    if (entry && entry.onCancel) {
      entry.onCancel();
    }
    return;
  }

  if (method === 'test/emit_wakeup') {
    const sid = params.sessionId;
    reply({});
    writeMsg({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Subagent finished: ' } },
      },
    });
    const permReply = await sendServerRequest('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 'wakeup-tc-1', title: 'Apply patch', kind: 'execute', rawInput: { CommandLine: 'sudo true' } },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' },
      ],
    });
    log({ wakeupPermReply: permReply });
    writeMsg({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'all done.' } },
      },
    });
    return;
  }

  if (method === 'test/emit_unroutable_requests') {
    reply({});
    const r1 = await sendServerRequest('elicitation/create', {
      sessionId: 'nonexistent-session',
      mode: 'form',
      message: 'Unroutable',
      requestedSchema: { type: 'object', properties: { x: { type: 'string' } } },
    }).catch((err) => ({ rpcError: err }));
    const r2 = await sendServerRequest('session/request_permission', {
      toolCall: { toolCallId: 'missing-sid' },
      options: [{ optionId: 'allow_once', kind: 'allow_once' }],
    }).catch((err) => ({ rpcError: err }));
    log({ unroutableReplies: [r1, r2] });
    return;
  }

  if (method === 'session/prompt') {
    const sid = params.sessionId;
    const text = Array.isArray(params.prompt)
      ? params.prompt.map(b => (b && b.type === 'text' ? b.text : '')).join('\\n')
      : '';

    const emitChunk = (chunkText) => writeMsg({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunkText } },
      },
    });

    if (text === 'keepalive-stream') {
      // Emit chunks every 45ms for 225ms (exceeds 110ms idle timeout if not renewed!)
      for (let i = 1; i <= 5; i++) {
        await new Promise(r => setTimeout(r, 45));
        emitChunk('p' + i + ' ');
      }
      reply({ stopReason: 'end_turn' });
      return;
    }

    if (text === 'approval-across-idle') {
      // Request permission, wait for user to reply after > idleTimeoutMs
      const perm = await sendServerRequest('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 'tc-slow-perm', title: 'Slow approval', kind: 'execute', rawInput: { CommandLine: 'sudo ls' } },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' },
        ],
      });
      emitChunk('approved:' + perm?.outcome?.optionId);
      reply({ stopReason: 'end_turn' });
      return;
    }

    if (text === 'hang-then-late-chunk') {
      // Never reply to prompt; emit a late chunk 220ms later after idle timeout (110ms)
      setTimeout(() => {
        emitChunk('LATE_ZOMBIE_CHUNK');
      }, 220);
      return;
    }

    if (text === 'cancel-no-reply-confirm') {
      writeMsg({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: { sessionUpdate: 'tool_call', toolCallId: 'tc-res-1', title: 'Running tool', status: 'in_progress' },
        },
      });
      await new Promise((resolve) => {
        activePrompts.set(sid, {
          onCancel: () => {
            activePrompts.delete(sid);
            resolve({ stopReason: 'cancelled' });
          },
        });
      }).then(res => reply(res));
      return;
    }

    if (text === 'cancel-races-end-turn') {
      await new Promise((resolve) => {
        activePrompts.set(sid, {
          onCancel: () => {
            activePrompts.delete(sid);
            emitChunk('Finished anyway');
            resolve({ stopReason: 'end_turn' });
          },
        });
      }).then(res => reply(res));
      return;
    }

    if (text.startsWith('stop-reason:')) {
      const reason = text.slice('stop-reason:'.length);
      emitChunk('partial');
      if (reason === 'missing') {
        reply({});
      } else {
        reply({ stopReason: reason });
      }
      return;
    }

    if (text === 'elicit-secret') {
      const res = await sendServerRequest('elicitation/create', {
        sessionId: sid,
        toolCallId: 'tc-secret',
        mode: 'url',
        message: 'OAuth login',
        requestedSchema: {},
      });
      log({ secretElicitReply: res });
      reply({ stopReason: 'end_turn' });
      return;
    }

    if (text === 'elicit-decline') {
      const res = await sendServerRequest('elicitation/create', {
        sessionId: sid,
        toolCallId: 'tc-decline',
        mode: 'form',
        message: 'Pick count',
        requestedSchema: {
          type: 'object',
          properties: {
            count: { type: 'integer', description: 'Count' },
            ratio: { type: 'number', description: 'Ratio' },
            env: { type: 'string', enum: ['dev', 'prod'] },
            tags: { type: 'array', items: { anyOf: [{ enum: ['a', 'b'] }, { type: 'string' }] } },
          },
        },
      });
      log({ declineElicitReply: res });
      reply({ stopReason: 'end_turn' });
      return;
    }

    if (text === 'same-chunk-prompt-and-wakeup') {
      const promptReply = JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', response: 'Done old' } });
      const wakeupNotif = JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'shared-msg-id',
            content: { type: 'text', text: 'Fresh wakeup text' },
          },
        },
      });
      writeSync(1, promptReply + '\\n' + wakeupNotif + '\\n');
      return;
    }

    if (text === 'cancel-with-pending-perm') {
      const permPromise = sendServerRequest('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 'tc-cancel-perm', title: 'Needs approval', kind: 'execute', rawInput: { CommandLine: 'sudo whoami' } },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' },
        ],
      });
      activePrompts.set(sid, {
        onCancel: async () => {
          activePrompts.delete(sid);
          const permRes = await permPromise;
          log({ cancelPendingPermReply: permRes });
          reply({ stopReason: 'cancelled' });
        },
      });
      return;
    }

    if (text === 'approval-always-test') {
      const perm = await sendServerRequest('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 'tc-always-1', title: 'Run tool', kind: 'execute', rawInput: { CommandLine: 'sudo true' } },
        options: [
          { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' },
        ],
      });
      log({ allowAlwaysPermReply: perm });
      reply({ stopReason: 'end_turn' });
      return;
    }

    if (text === 'elicit-optional-and-sentinel') {
      const res1 = await sendServerRequest('elicitation/create', {
        sessionId: sid,
        toolCallId: 'tc-opt-1',
        mode: 'form',
        message: 'Optional field test',
        requestedSchema: {
          type: 'object',
          required: ['reqField'],
          properties: {
            reqField: { type: 'string', description: 'Required' },
            optField: { type: 'string', description: 'Optional' },
          },
        },
      });
      const res2 = await sendServerRequest('elicitation/create', {
        sessionId: sid,
        toolCallId: 'tc-opt-2',
        mode: 'form',
        message: 'Sentinel skip test',
        requestedSchema: {
          type: 'object',
          properties: {
            choice: { type: 'string', enum: ['a', 'b'] },
          },
        },
      });
      const res3 = await sendServerRequest('elicitation/create', {
        sessionId: sid,
        toolCallId: 'tc-opt-3',
        mode: 'form',
        message: 'Invalid opId test',
        requestedSchema: {
          type: 'object',
          properties: {
            num: { type: 'integer' },
          },
        },
      });
      log({ optionalAndSentinelReplies: [res1, res2, res3] });
      reply({ stopReason: 'end_turn' });
      return;
    }

    emitChunk('Echo:' + text);
    reply({ stopReason: 'end_turn' });
  }
});
`;
  await writeFile(binPath, script, 'utf8');
  await chmod(binPath, 0o755);
}

test('P0/P1: DEFAULT_AGY_MODELS omits gemini-3-flash-preview, strict convertSchemaValue & schemaAllowsFreeText', () => {
  assert.equal(DEFAULT_AGY_MODELS.some(m => m.id === 'gemini-3-flash-preview'), false);
  assert.equal(DEFAULT_PROMPT_MAX_TIMEOUT_MS, 24 * 60 * 60_000);

  // Strict convertSchemaValue rejects 2.9 for integer, NaN/Infinity for number, bad booleans
  assert.equal(convertSchemaValue('42', 'integer'), 42);
  assert.equal(convertSchemaValue('-7', 'integer'), -7);
  assert.equal(convertSchemaValue('3.14', 'number'), 3.14);
  assert.equal(convertSchemaValue('true', 'boolean'), true);
  assert.equal(convertSchemaValue('false', 'boolean'), false);
  assert.throws(() => convertSchemaValue('2.9', 'integer'), { code: 'invalid_request' });
  assert.throws(() => convertSchemaValue('NaN', 'number'), { code: 'invalid_request' });
  assert.throws(() => convertSchemaValue('Infinity', 'number'), { code: 'invalid_request' });
  assert.throws(() => convertSchemaValue('-Infinity', 'number'), { code: 'invalid_request' });
  assert.throws(() => convertSchemaValue('maybe', 'boolean'), { code: 'invalid_request' });

  // allowFreeText: strict enum single-select disables free text; array without enum or with anyOf allows free text
  const strictEnum = { type: 'string', enum: ['a', 'b'] };
  assert.equal(schemaAllowsFreeText(strictEnum, extractSchemaChoices(strictEnum)), false);

  const freeString = { type: 'string' };
  assert.equal(schemaAllowsFreeText(freeString, extractSchemaChoices(freeString)), true);

  const freeArray = { type: 'array', items: { type: 'string' } };
  assert.equal(schemaAllowsFreeText(freeArray, extractSchemaChoices(freeArray)), true);

  const strictArray = { type: 'array', items: { type: 'string', enum: ['x', 'y'] } };
  assert.equal(schemaAllowsFreeText(strictArray, extractSchemaChoices(strictArray)), false);

  const arrayWithOther = { type: 'array', items: { anyOf: [{ enum: ['x', 'y'] }, { type: 'string' }] } };
  assert.deepEqual(extractSchemaChoices(arrayWithOther), ['x', 'y']);
  assert.equal(schemaAllowsFreeText(arrayWithOther, extractSchemaChoices(arrayWithOther)), true);

  // buildAgyAcpArgs defaults & flags (never emits --mode for agy acp)
  assert.deepEqual(buildAgyAcpArgs(), ['acp', '--stdio', '--process-per-session']);
  const customArgs = buildAgyAcpArgs({
    processPerSession: false,
    defaultMode: 'plan',
    addDirs: ['/tmp/a', '/tmp/b'],
    extraArgs: ['--foo'],
  });
  assert.deepEqual(customArgs, ['acp', '--stdio', '--add-dir', '/tmp/a', '--add-dir', '/tmp/b', '--foo']);
  assert.equal(customArgs.includes('--mode'), false);
});

test('P0-1: Activity-renewed prompt timeout, approval across idle timeout, timeout sends session/cancel + locks session against late chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-acp-core-p01-'));
  const binPath = join(root, 'fake-agy.mjs');
  const rpcLogPath = join(root, 'rpc.jsonl');
  await writeCoreFakeAgy(binPath, rpcLogPath);

  const transport = new AgyAcpTransport({ agyBin: binPath });
  const catalog = new AgyCatalog({ dbPath: join(root, 'missing.db'), brainDir: root, allowedProjectRoots: [root] });
  const adapter = new AgyAdapter(transport, catalog, 'host-1', 'agy-svc', undefined, {
    promptIdleTimeoutMs: 110,
    promptMaxTimeoutMs: 5000,
    wakeupIdleMs: 50,
  });
  const observed: PlatformObservation[] = [];
  adapter.onObservation(obs => observed.push(obs));

  try {
    await transport.connect();
    const gen1 = transport.connectionGeneration;
    const created = await adapter.create(root, null);
    const ref = created.createdSession!.native;

    // 1. Handshake advertised form elicitation capability
    const initLogs = (await readFile(rpcLogPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const initCall = initLogs.find(e => e.method === 'initialize');
    assert.deepEqual(initCall?.params?.clientCapabilities, { elicitation: { form: {} } });

    // 2. Streaming session/update renews idle timeout past 110ms (225ms total)
    const s1 = observed.length;
    await adapter.input(ref, 'new', [{ type: 'text', text: 'keepalive-stream' }], makeGuard(gen1));
    await waitFor(() => observed.slice(s1).some(o => o.type === 'turn' && o.turn.status === 'completed'), 3000);
    const msg1 = observed.slice(s1).find(o => o.type === 'message' && o.message.role === 'assistant' && o.message.final);
    assert.ok(msg1?.type === 'message');
    assert.match((msg1.message.blocks[0] as { text: string }).text, /p5/);

    // 3. Pending user approval pauses idle timeout (wait 160ms > 110ms before responding)
    const s2 = observed.length;
    await adapter.input(ref, 'new', [{ type: 'text', text: 'approval-across-idle' }], makeGuard(gen1));
    await waitFor(() => observed.slice(s2).some(o => o.type === 'interaction' && o.interaction.kind === 'approval'));
    const approvalInt = observed.slice(s2).find(
      (o): o is Extract<PlatformObservation, { type: 'interaction' }> => o.type === 'interaction' && o.interaction.kind === 'approval',
    )!.interaction;
    await new Promise(r => setTimeout(r, 160));
    await adapter.respond(ref, approvalInt, { kind: 'approval', decision: 'allow', scope: 'this_request' }, makeGuard(gen1));
    await waitFor(() => observed.slice(s2).some(o => o.type === 'turn' && o.turn.status === 'completed'), 3000);

    // 4. Genuine idle timeout emits session/cancel notification, locks session, and drops late zombie chunks
    const s3 = observed.length;
    await adapter.input(ref, 'new', [{ type: 'text', text: 'hang-then-late-chunk' }], makeGuard(gen1));
    await waitFor(() => observed.slice(s3).some(o => o.type === 'turn' && o.turn.status === 'failed'), 2000);

    // Next dispatch on the same locked session must be rejected!
    await assert.rejects(
      adapter.input(ref, 'new', [{ type: 'text', text: 'must-be-blocked' }], makeGuard(gen1)),
      { code: 'control_conflict' },
    );

    // Wait for late zombie chunk (at 220ms) and verify it is NOT attributed to any turn or wakeup!
    await new Promise(r => setTimeout(r, 200));
    const zombieMsgs = observed.slice(s3).filter(
      o => o.type === 'message' && o.message.blocks.some(b => b.type === 'text' && b.text.includes('LATE_ZOMBIE_CHUNK')),
    );
    assert.equal(zombieMsgs.length, 0, 'late zombie chunk must never be attributed after timeout lock');

    // Verify session/cancel was sent as a notification (hasId: false)
    const logsAfterTimeout = (await readFile(rpcLogPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const cancelNotif = logsAfterTimeout.find(e => e.method === 'session/cancel');
    assert.ok(cancelNotif, 'timeout must send session/cancel notification');
    assert.equal(cancelNotif.hasId, false, 'session/cancel must be a JSON-RPC notification without id');

    // Release & reacquire unlocks session cleanly and backfills current model from session/load
    await adapter.control(ref, 'release', makeGuard(gen1));
    await adapter.control(ref, 'acquire', makeGuard(gen1));
    const s4 = observed.length;
    await adapter.input(ref, 'new', [{ type: 'text', text: 'after-unlock' }], makeGuard(gen1));
    await waitFor(() => observed.slice(s4).some(o => o.type === 'turn' && o.turn.status === 'completed'), 2000);
    const unlockedTurn = observed.slice(s4).find(o => o.type === 'turn' && o.turn.status === 'completed');
    assert.ok(unlockedTurn?.type === 'turn');
    assert.equal(unlockedTurn.turn.model, 'gemini-4-neon', 'loadSession must backfill currentModelId');
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('P0-2: /stop uses ACP v1 notification (no reply), honors stopReason, records non-end_turn reasons, and preserves residual snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-acp-core-p02-'));
  const binPath = join(root, 'fake-agy.mjs');
  const rpcLogPath = join(root, 'rpc.jsonl');
  await writeCoreFakeAgy(binPath, rpcLogPath);

  const transport = new AgyAcpTransport({ agyBin: binPath });
  const catalog = new AgyCatalog({ dbPath: join(root, 'missing.db'), brainDir: root, allowedProjectRoots: [root] });
  const adapter = new AgyAdapter(transport, catalog, 'host-1', 'agy-svc');
  const observed: PlatformObservation[] = [];
  adapter.onObservation(obs => observed.push(obs));

  try {
    await transport.connect();
    const gen1 = transport.connectionGeneration;
    const created = await adapter.create(root, null);
    const ref = created.createdSession!.native;

    // 1. Cancel confirmed via stopReason: 'cancelled' (fake AGY does NOT reply to session/cancel)
    const s1 = observed.length;
    const ack1 = await adapter.input(ref, 'new', [{ type: 'text', text: 'cancel-no-reply-confirm' }], makeGuard(gen1));
    await waitFor(() => observed.slice(s1).some(o => o.type === 'event' && o.event.type === 'tool.updated'));
    await adapter.interrupt(ref, ack1.nativeReference!, makeGuard(gen1));
    await waitFor(() => observed.slice(s1).some(o => o.type === 'turn' && o.turn.status === 'interrupted'), 2000);

    // Post-termination inspectTurnResidual must return the captured in-progress tool snapshot!
    const residual = await adapter.inspectTurnResidual(ref, ack1.nativeReference!);
    assert.equal(residual.status, 'running');
    assert.equal(residual.count, 1);
    assert.ok(residual.observedAt);
    assert.equal(residual.complete, false);

    // 2. Cancel races with end_turn: must end as 'completed', NOT 'interrupted'!
    const s2 = observed.length;
    const ack2 = await adapter.input(ref, 'new', [{ type: 'text', text: 'cancel-races-end-turn' }], makeGuard(gen1));
    await new Promise(r => setTimeout(r, 30));
    await adapter.interrupt(ref, ack2.nativeReference!, makeGuard(gen1));
    await waitFor(() => observed.slice(s2).some(o => o.type === 'turn' && o.turn.endedAt !== null), 2000);
    const turn2 = observed.slice(s2).find(o => o.type === 'turn' && o.turn.endedAt !== null);
    assert.ok(turn2?.type === 'turn');
    assert.equal(turn2.turn.status, 'completed', 'stopReason=end_turn must yield completed even after cancelRequested');
    const stopEvt2 = observed.slice(s2).find(o => o.type === 'event' && o.event.type === 'turn.stop_reason');
    assert.ok(stopEvt2?.type === 'event');
    assert.deepEqual(stopEvt2.event.data, {
      turnId: ack2.nativeReference,
      stopReason: 'end_turn',
      cancelRequested: true,
      terminalStatus: 'completed',
    });

    // 3. max_tokens, max_turn_requests, refusal, missing stopReason must NOT become 'completed'
    for (const reason of ['max_tokens', 'max_turn_requests', 'refusal', 'missing']) {
      const s = observed.length;
      await adapter.input(ref, 'new', [{ type: 'text', text: `stop-reason:${reason}` }], makeGuard(gen1));
      await waitFor(() => observed.slice(s).some(o => o.type === 'turn' && o.turn.endedAt !== null), 2000);
      const t = observed.slice(s).find(o => o.type === 'turn' && o.turn.endedAt !== null);
      assert.ok(t?.type === 'turn');
      assert.equal(t.turn.status, 'failed', `stopReason=${reason} must not be reported as completed`);
      const ev = observed.slice(s).find(o => o.type === 'event' && o.event.type === 'turn.stop_reason');
      assert.ok(ev?.type === 'event');
      assert.equal((ev.event.data as { stopReason: string }).stopReason, reason);
    }

    // Verify all session/cancel calls had no JSON-RPC id
    const logs = (await readFile(rpcLogPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const cancels = logs.filter(e => e.method === 'session/cancel');
    assert.equal(cancels.length, 2);
    assert.ok(cancels.every(c => c.hasId === false));
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('P0-3 & P1: Out-of-turn wakeup synthesis, 0 dangling server requests, elicitation decline/validation, and create preserves sessionId on set_model error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-acp-core-p03-'));
  const binPath = join(root, 'fake-agy.mjs');
  const rpcLogPath = join(root, 'rpc.jsonl');
  await writeCoreFakeAgy(binPath, rpcLogPath);

  const transport = new AgyAcpTransport({ agyBin: binPath });
  const catalog = new AgyCatalog({ dbPath: join(root, 'missing.db'), brainDir: root, allowedProjectRoots: [root] });
  const adapter = new AgyAdapter(transport, catalog, 'host-1', 'agy-svc', undefined, {
    wakeupIdleMs: 60,
  });
  const observed: PlatformObservation[] = [];
  adapter.onObservation(obs => observed.push(obs));

  try {
    await transport.connect();
    const gen1 = transport.connectionGeneration;

    // 1. create() with failing set_model must preserve sessionId and remain active
    const createdFailModel = await adapter.create(root, 'fail-model');
    assert.equal(createdFailModel.status, 'submitted');
    assert.ok(createdFailModel.nativeReference);
    assert.equal(createdFailModel.settingsApplied, undefined);
    const ref = createdFailModel.createdSession!.native;
    assert.equal(adapter.hasActiveNativeSession(ref), true);

    // 2. Out-of-turn wakeup: server emits session/update + session/request_permission with no active foreground turn
    const sWake = observed.length;
    await transport.request('test/emit_wakeup', { sessionId: ref.nativeSessionId });
    await waitFor(
      () => observed.slice(sWake).some(o => o.type === 'interaction' && o.interaction.kind === 'approval'),
      2000,
    );
    const wakeupStartTurn = observed.slice(sWake).find(o => o.type === 'turn' && o.turn.status === 'running');
    assert.ok(wakeupStartTurn?.type === 'turn');
    assert.match(wakeupStartTurn.turn.turnId, /^wakeup:/);
    const wakeupPerm = observed.slice(sWake).find(
      (o): o is Extract<PlatformObservation, { type: 'interaction' }> => o.type === 'interaction' && o.interaction.kind === 'approval',
    )!.interaction;
    assert.equal(wakeupPerm.turnId, wakeupStartTurn.turn.turnId);

    // Answer wakeup permission -> wakeup turn receives final chunk and completes cleanly
    await adapter.respond(ref, wakeupPerm, { kind: 'approval', decision: 'allow', scope: 'this_request' }, makeGuard(gen1));
    await waitFor(
      () => observed.slice(sWake).some(o => o.type === 'turn' && o.turn.turnId === wakeupStartTurn.turn.turnId && o.turn.status === 'completed'),
      2000,
    );
    const wakeupFinalMsg = observed.slice(sWake).find(
      o => o.type === 'message' && o.message.turnId === wakeupStartTurn.turn.turnId && o.message.final,
    );
    assert.ok(wakeupFinalMsg?.type === 'message');
    assert.equal((wakeupFinalMsg.message.blocks[0] as { text: string }).text, 'Subagent finished: all done.');

    // 3. Unroutable server requests must receive explicit protocol replies (0 dangling)
    await transport.request('test/emit_unroutable_requests', {});
    await new Promise(r => setTimeout(r, 80));
    assert.equal(transport.health().pendingServerRequests, 0, '0 dangling server requests');

    // 4. Secret/URL elicitation must emit interaction.unsupported AND reply { action: 'decline' }
    const sSecret = observed.length;
    await adapter.input(ref, 'new', [{ type: 'text', text: 'elicit-secret' }], makeGuard(gen1));
    await waitFor(() => observed.slice(sSecret).some(o => o.type === 'turn' && o.turn.status === 'completed'), 2000);
    assert.ok(observed.slice(sSecret).some(o => o.type === 'event' && o.event.type === 'interaction.unsupported'));
    assert.equal(transport.health().pendingServerRequests, 0);

    // 5. Elicitation strict validation (reject 2.9 for integer, NaN for number, free text for strict enum) + decline action
    const sDecline = observed.length;
    await adapter.input(ref, 'new', [{ type: 'text', text: 'elicit-decline' }], makeGuard(gen1));
    await waitFor(() => observed.slice(sDecline).some(o => o.type === 'interaction' && o.interaction.kind === 'question_group'), 2000);
    const qGroup = observed.slice(sDecline).find(
      (o): o is Extract<PlatformObservation, { type: 'interaction' }> => o.type === 'interaction' && o.interaction.kind === 'question_group',
    )!.interaction;
    assert.equal(qGroup.kind, 'question_group');
    const envQ = qGroup.questions.find(q => q.id === 'env')!;
    const tagsQ = qGroup.questions.find(q => q.id === 'tags')!;
    assert.equal(envQ.allowFreeText, false, 'strict enum single-select must have allowFreeText=false');
    assert.equal(tagsQ.multiple, true);
    assert.equal(tagsQ.allowFreeText, true, 'array with anyOf string must allow free text');

    // Reject 2.9 for integer
    await assert.rejects(
      adapter.respond(ref, qGroup, {
        kind: 'question_group',
        answers: { count: ['2.9'], ratio: ['1.5'], env: ['prod'], tags: ['a', 'custom'] },
      }, makeGuard(gen1)),
      { code: 'invalid_request' },
    );
    // Reject NaN for number
    await assert.rejects(
      adapter.respond(ref, qGroup, {
        kind: 'question_group',
        answers: { count: ['2'], ratio: ['NaN'], env: ['prod'], tags: ['a'] },
      }, makeGuard(gen1)),
      { code: 'invalid_request' },
    );
    // Reject non-enum value for strict enum
    await assert.rejects(
      adapter.respond(ref, qGroup, {
        kind: 'question_group',
        answers: { count: ['2'], ratio: ['1.5'], env: ['invalid-env'], tags: ['a'] },
      }, makeGuard(gen1)),
      { code: 'invalid_request' },
    );

    // Decline action succeeds and replies { action: 'decline' }
    await adapter.respond(
      ref,
      qGroup,
      { kind: 'question_group', answers: {}, action: 'decline' } as Answer,
      makeGuard(gen1),
    );
    await waitFor(() => observed.slice(sDecline).some(o => o.type === 'turn' && o.turn.status === 'completed'), 2000);

    const logs = (await readFile(rpcLogPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(logs.find(e => e.secretElicitReply)?.secretElicitReply, { action: 'decline' });
    assert.deepEqual(logs.find(e => e.declineElicitReply)?.declineElicitReply, { action: 'decline' });
    const unroutable = logs.find(e => e.unroutableReplies)?.unroutableReplies;
    assert.ok(Array.isArray(unroutable) && unroutable.length === 2);
    assert.deepEqual(unroutable[0], { action: 'decline' });
    assert.equal(unroutable[1]?.rpcError?.code, -32602);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Verifier regressions: /stop settles pending perm, same-chunk wakeup isolation, dynamic residual pruning, stalled wakeup timeout, failed close lock persistence, sentinel & optional fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-acp-core-reg-'));
  const binPath = join(root, 'fake-agy.mjs');
  const rpcLogPath = join(root, 'rpc.jsonl');
  await writeCoreFakeAgy(binPath, rpcLogPath);

  const transport = new AgyAcpTransport({ agyBin: binPath, defaultMode: 'plan' });
  const catalog = new AgyCatalog({ dbPath: join(root, 'missing.db'), brainDir: root, allowedProjectRoots: [root] });
  const adapter = new AgyAdapter(transport, catalog, 'host-1', 'agy-svc', undefined, {
    promptIdleTimeoutMs: 120,
    promptMaxTimeoutMs: 5000,
    wakeupIdleMs: 40,
  });
  const observed: PlatformObservation[] = [];
  adapter.onObservation(obs => observed.push(obs));

  try {
    await transport.connect();
    const gen1 = transport.connectionGeneration;
    const created = await adapter.create(root, null);
    const ref = created.createdSession!.native;

    // 1. /stop settles pending unanswered permission request immediately so server unblocks
    const s1 = observed.length;
    const ack1 = await adapter.input(ref, 'new', [{ type: 'text', text: 'cancel-with-pending-perm' }], makeGuard(gen1));
    await waitFor(() => observed.slice(s1).some(o => o.type === 'interaction' && o.interaction.kind === 'approval'), 2000);
    await adapter.interrupt(ref, ack1.nativeReference!, makeGuard(gen1));
    await waitFor(() => observed.slice(s1).some(o => o.type === 'turn' && o.turn.status === 'interrupted'), 2000);
    assert.equal(transport.health().pendingServerRequests, 0);

    // 2. Dynamic residual pruning: terminal tool_call_update after cancel clears residual from running -> none
    const s2 = observed.length;
    const ack2 = await adapter.input(ref, 'new', [{ type: 'text', text: 'cancel-no-reply-confirm' }], makeGuard(gen1));
    await waitFor(() => observed.slice(s2).some(o => o.type === 'event' && o.event.type === 'tool.updated'), 2000);
    await adapter.interrupt(ref, ack2.nativeReference!, makeGuard(gen1));
    await waitFor(() => observed.slice(s2).some(o => o.type === 'turn' && o.turn.status === 'interrupted'), 2000);
    assert.equal((await adapter.inspectTurnResidual(ref, ack2.nativeReference!)).status, 'running');
    await transport.request('test/emit_terminal_tool', { sessionId: ref.nativeSessionId, toolCallId: 'tc-res-1' });
    await new Promise(r => setTimeout(r, 40));
    const prunedResidual = await adapter.inspectTurnResidual(ref, ack2.nativeReference!);
    assert.equal(prunedResidual.status, 'none');
    assert.equal(prunedResidual.count, 0);

    // 3. Same-chunk stdout: prompt response + wakeup notification arrive together -> wakeup gets its own turnId & isolated messageId
    const s3 = observed.length;
    const ack3 = await adapter.input(ref, 'new', [{ type: 'text', text: 'same-chunk-prompt-and-wakeup' }], makeGuard(gen1));
    await waitFor(
      () => observed.slice(s3).some(o => o.type === 'turn' && o.turn.turnId.startsWith('wakeup:') && o.turn.status === 'completed'),
      2000,
    );
    const wakeupTurn = observed.slice(s3).find(
      o => o.type === 'turn' && o.turn.turnId.startsWith('wakeup:') && o.turn.status === 'completed',
    );
    assert.ok(wakeupTurn?.type === 'turn');
    assert.notEqual(wakeupTurn.turn.turnId, ack3.nativeReference);
    const wakeupMsg = observed.slice(s3).find(
      o => o.type === 'message' && o.message.turnId === wakeupTurn.turn.turnId && o.message.final,
    );
    assert.ok(wakeupMsg?.type === 'message');
    assert.equal(wakeupMsg.message.messageId, `${wakeupTurn.turn.turnId}:shared-msg-id`);

    // 4. Stalled wakeup tool call converges to 'failed' after promptIdleTimeoutMs instead of hanging forever
    const s4 = observed.length;
    await transport.request('test/emit_stalled_wakeup_tool', { sessionId: ref.nativeSessionId });
    await waitFor(
      () => observed.slice(s4).some(o => o.type === 'turn' && o.turn.turnId.startsWith('wakeup:') && o.turn.status === 'failed'),
      2000,
    );

    // 5. Optional field, skip sentinel '[已跳过/取消]', and guard.operationId invalid answer auto-decline
    const s5 = observed.length;
    await adapter.input(ref, 'new', [{ type: 'text', text: 'elicit-optional-and-sentinel' }], makeGuard(gen1));
    await waitFor(() => observed.slice(s5).some(o => o.type === 'interaction' && o.interaction.kind === 'question_group'), 2000);
    const int1 = observed.slice(s5).find(
      (o): o is Extract<PlatformObservation, { type: 'interaction' }> => o.type === 'interaction' && o.interaction.kind === 'question_group',
    )!.interaction;
    assert.equal(int1.kind, 'question_group');
    assert.equal((int1.questions.find(q => q.id === 'optField') as { required?: boolean })?.required, false);
    await adapter.respond(ref, int1, { kind: 'question_group', answers: { reqField: ['ok'], optField: [] } }, makeGuard(gen1));

    await waitFor(
      () => observed.slice(s5).filter(o => o.type === 'interaction' && o.interaction.kind === 'question_group' && o.interaction.status === 'awaiting_answer').length >= 2,
      2000,
    );
    const int2 = observed.slice(s5).filter(
      (o): o is Extract<PlatformObservation, { type: 'interaction' }> =>
        o.type === 'interaction' && o.interaction.kind === 'question_group' && o.interaction.status === 'awaiting_answer',
    )[1]!.interaction;
    await adapter.respond(ref, int2, { kind: 'question_group', answers: { choice: ['[已跳过/取消]'] } }, makeGuard(gen1));

    await waitFor(
      () => observed.slice(s5).filter(o => o.type === 'interaction' && o.interaction.kind === 'question_group' && o.interaction.status === 'awaiting_answer').length >= 3,
      2000,
    );
    const int3 = observed.slice(s5).filter(
      (o): o is Extract<PlatformObservation, { type: 'interaction' }> =>
        o.type === 'interaction' && o.interaction.kind === 'question_group' && o.interaction.status === 'awaiting_answer',
    )[2]!.interaction;
    await assert.rejects(
      adapter.respond(
        ref,
        int3,
        { kind: 'question_group', answers: { num: ['2.9'] } },
        { ...makeGuard(gen1), operationId: 'op-invalid-int' },
      ),
      { code: 'invalid_request' },
    );
    await waitFor(() => observed.slice(s5).some(o => o.type === 'turn' && o.turn.status === 'completed'), 2000);
    assert.equal(transport.health().pendingServerRequests, 0);

    // 6. Locked session exposes failed + send temporarily_unavailable while keeping control.input='available' for releaseControl,
    //    and failed session/close does NOT unlock on same generation
    await transport.request('test/fail_close_for', { sessionId: ref.nativeSessionId });
    const s6 = observed.length;
    await adapter.input(ref, 'new', [{ type: 'text', text: 'hang-then-late-chunk' }], makeGuard(gen1));
    await waitFor(() => observed.slice(s6).some(o => o.type === 'turn' && o.turn.status === 'failed'), 2000);
    const lockedSession = (await adapter.read(ref)).session;
    assert.equal(lockedSession.status, 'failed');
    assert.equal(lockedSession.control.input, 'available');
    assert.equal(lockedSession.capabilities.send.status, 'temporarily_unavailable');
    assert.equal(lockedSession.capabilities.handoff.status, 'available');

    // Release with failing session/close + acquire on same gen must KEEP session locked
    await adapter.control(ref, 'release', makeGuard(gen1));
    await adapter.control(ref, 'acquire', makeGuard(gen1));
    await assert.rejects(
      adapter.input(ref, 'new', [{ type: 'text', text: 'still-locked' }], makeGuard(gen1)),
      { code: 'control_conflict' },
    );

    const logs = (await readFile(rpcLogPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(logs.find(e => e.cancelPendingPermReply)?.cancelPendingPermReply, {
      outcome: { outcome: 'cancelled' },
    });
    assert.deepEqual(logs.find(e => e.optionalAndSentinelReplies)?.optionalAndSentinelReplies, [
      { action: 'accept', content: { reqField: 'ok' } },
      { action: 'decline' },
      { action: 'decline' },
    ]);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('UnifiedCore + UnifiedStore end-to-end: timeout lock -> submitInput rejected -> releaseControl -> requestControl -> next turn succeeds + allow_always forwarding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-acp-core-e2e-lock-'));
  const binPath = join(root, 'fake-agy.mjs');
  const rpcLogPath = join(root, 'rpc.jsonl');
  await writeCoreFakeAgy(binPath, rpcLogPath);

  const transport = new AgyAcpTransport({ agyBin: binPath });
  const catalog = new AgyCatalog({ dbPath: join(root, 'missing.db'), brainDir: root, allowedProjectRoots: [root] });
  const adapter = new AgyAdapter(transport, catalog, 'host-1', 'agy-svc', undefined, {
    promptIdleTimeoutMs: 100,
    promptMaxTimeoutMs: 5000,
    wakeupIdleMs: 40,
  });
  const store = new UnifiedStore(join(root, 'core.sqlite'));
  const core = new UnifiedCore(store, [adapter], () => true);

  try {
    await transport.connect();
    const gen1 = transport.connectionGeneration;
    const created = await adapter.create(root, null);
    const session = created.createdSession!;
    store.insertSession(session);
    store.setConnectionGeneration(session.sessionId, 0, gen1);

    const ctx = (opId: string) => {
      const cur = store.getSession(session.sessionId);
      return {
        operationId: opId,
        idempotencyKey: opId,
        targetId: session.sessionId,
        expectedRevision: cur.revision,
        controlGeneration: cur.control.generation,
        identity: { source: 'feishu', subject: 'ou_owner' },
      };
    };

    // 1. allow_always option is advertised and forwarded when scope='session'
    const observed: PlatformObservation[] = [];
    adapter.onObservation(obs => observed.push(obs));
    const sAllow = observed.length;
    await adapter.input(session.native, 'new', [{ type: 'text', text: 'approval-always-test' }], makeGuard(gen1));
    await waitFor(() => observed.slice(sAllow).some(o => o.type === 'interaction' && o.interaction.kind === 'approval'), 2000);
    const alwaysInt = observed.slice(sAllow).find(
      (o): o is Extract<PlatformObservation, { type: 'interaction' }> => o.type === 'interaction' && o.interaction.kind === 'approval',
    )!.interaction as Interaction & { allowAlways?: boolean; allowedScopes?: readonly string[] };
    assert.equal(alwaysInt.allowAlways, true);
    assert.deepEqual(alwaysInt.allowedScopes, ['this_request', 'session', 'allow_always']);
    await adapter.respond(
      session.native,
      alwaysInt,
      { kind: 'approval', decision: 'allow', scope: 'session' },
      makeGuard(gen1),
    );
    await waitFor(() => observed.slice(sAllow).some(o => o.type === 'turn' && o.turn.status === 'completed'), 2000);

    // 2. Timeout lock through UnifiedCore -> submitInput rejected -> releaseControl -> requestControl -> next turn succeeds
    await core.submitInput({
      context: ctx('op-hang'),
      mode: 'new',
      blocks: [{ type: 'text', text: 'hang-then-late-chunk' }],
    });
    await core.dispatch('op-hang');
    await waitFor(() => store.getSession(session.sessionId).capabilities.send.status === 'temporarily_unavailable', 2000);

    await assert.rejects(
      core.submitInput({
        context: ctx('op-blocked'),
        mode: 'new',
        blocks: [{ type: 'text', text: 'blocked-while-locked' }],
      }),
      /send unavailable/,
    );

    await core.releaseControl({ context: ctx('op-release'), payload: { owner: 'agy-svc' } });
    assert.equal((await core.dispatch('op-release')).status, 'completed');

    await core.requestControl({ context: ctx('op-acquire'), payload: { owner: 'agy-svc', strategy: 'wait' } });
    assert.equal((await core.dispatch('op-acquire')).status, 'completed');

    const sAfter = observed.length;
    await core.submitInput({
      context: ctx('op-ok'),
      mode: 'new',
      blocks: [{ type: 'text', text: 'after-core-unlock' }],
    });
    assert.equal((await core.dispatch('op-ok')).status, 'accepted');
    await waitFor(() => observed.slice(sAfter).some(o => o.type === 'turn' && o.turn.status === 'completed'), 2000);

    const logs = (await readFile(rpcLogPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(logs.find(e => e.allowAlwaysPermReply)?.allowAlwaysPermReply, {
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    });
  } finally {
    core.close();
    await adapter.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
