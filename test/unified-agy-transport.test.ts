import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgyAcpTransport,
  AgyStreamJsonRunner,
  DEFAULT_AGY_BIN,
  buildAgyAcpArgs,
  buildAgyStreamJsonArgs,
  type AgyAcpNotification,
  type AgyServerRequest,
  type AgyStreamEvent,
  type AgyTransportError,
} from '../src/unified/agy-transport.js';

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeExecutableNodeScript(dir: string, name: string, source: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

const hasCode = (expected: string) => (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === expected;

function fakeAcpServerSource(): string {
  return `
import { createInterface } from 'node:readline';
import { appendFileSync, createReadStream, writeSync } from 'node:fs';

const logFile = process.env.FAKE_LOG_FILE || '';
const mode = process.env.FAKE_MODE || 'normal';
const argv = process.argv.slice(2);

function log(entry) {
  if (logFile) {
    appendFileSync(logFile, JSON.stringify(entry) + '\\n');
  }
}

function send(msg) {
  writeSync(1, JSON.stringify(msg) + '\\n');
}

if (mode === 'crash_before_init') {
  writeSync(2, 'fatal before init\\n');
  process.exit(1);
}

if (mode === 'ignore_eof_and_sigterm') {
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    log({ event: 'ignored_sigterm' });
  });
}

// Read the inherited descriptor directly so the mock works in restricted stdio environments.
const rl = createInterface({ input: createReadStream(undefined, { fd: 0, autoClose: false }), crlfDelay: Infinity });
let activePromptId = null;
let promptTimer = null;

rl.on('line', line => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  log({ direction: 'in', msg });

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {}, load: {}, list: {} },
          _meta: { antigravity: { argv } },
        },
        agentInfo: { name: 'Fake ACP Server', version: '1.5.14' },
        authMethods: [
          { id: 'oauth-personal', name: 'Log in with Google' },
          { id: 'gemini-api-key', name: 'Gemini API key' },
        ],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId: 'sess-fake-1', argv },
    });
    return;
  }

  if (msg.method === 'session/load' || msg.method === 'session/list' || msg.method === 'session/set_model' || msg.method === 'session/set_config_option') {
    if (msg.method === 'session/list' && msg.params?.unauthenticated) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'Authentication required' },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { ok: true, method: msg.method, params: msg.params },
    });
    return;
  }

  if (msg.method === 'session/prompt') {
    const scenario = msg.params?.scenario || 'stream';
    if (scenario === 'unknown_server_request') {
      send({
        jsonrpc: '2.0',
        id: 'unknown-srv-req',
        method: 'fs/read_text_file',
        params: { path: '/etc/passwd' },
      });
      activePromptId = msg.id;
      return;
    }
    if (scenario === 'same_id_types') {
      activePromptId = msg.id;
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: { sessionId: msg.params.sessionId, toolCall: { toolCallId: 'num' }, options: [] },
      });
      send({
        jsonrpc: '2.0',
        id: '1',
        method: 'elicitation/create',
        params: { sessionId: msg.params.sessionId, toolCallId: 'str', mode: 'form', message: 'q', requestedSchema: {} },
      });
      return;
    }
    if (scenario === 'stream') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '，ACP！' } },
        },
      });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'end_turn' },
      });
      return;
    }

    if (scenario === 'permission_and_elicitation') {
      activePromptId = msg.id;
      send({
        jsonrpc: '2.0',
        id: 101,
        method: 'session/request_permission',
        params: {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: 'tc-1', title: 'Run shell', kind: 'execute' },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
      return;
    }

    if (scenario === 'elicitation_only') {
      activePromptId = msg.id;
      send({
        jsonrpc: '2.0',
        id: 'elicit-dup',
        method: 'elicitation/create',
        params: {
          sessionId: msg.params.sessionId,
          toolCallId: 'tc-2',
          mode: 'form',
          message: 'Enter target branch',
          requestedSchema: { type: 'object', properties: { branch: { type: 'string' } } },
        },
      });
      return;
    }

    if (scenario === 'wait_cancel') {
      activePromptId = msg.id;
      promptTimer = setTimeout(() => {
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        activePromptId = null;
      }, 5000);
      return;
    }

    if (scenario === 'hang') {
      return;
    }

    if (scenario === 'crash_mid_request') {
      setTimeout(() => {
        writeSync(2, 'unexpected crash\\n');
        process.kill(process.pid, 'SIGKILL');
      }, 20);
      return;
    }
  }

  if (msg.method === 'session/cancel') {
    if (promptTimer) {
      clearTimeout(promptTimer);
      promptTimer = null;
    }
    if (activePromptId !== null) {
      send({
        jsonrpc: '2.0',
        id: activePromptId,
        result: { stopReason: 'cancelled' },
      });
      activePromptId = null;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  // Response to server-initiated request
  if (!msg.method && msg.id !== undefined) {
    if (msg.id === 101 && activePromptId !== null) {
      send({
        jsonrpc: '2.0',
        id: 'elicit-1',
        method: 'elicitation/create',
        params: {
          sessionId: 'sess-fake-1',
          toolCallId: 'tc-elicit',
          mode: 'form',
          message: 'Pick environment',
          requestedSchema: { type: 'object', properties: { env: { type: 'string' } } },
        },
      });
      return;
    }
    if (msg.id === 'elicit-1' && activePromptId !== null) {
      send({
        jsonrpc: '2.0',
        id: activePromptId,
        result: { stopReason: 'end_turn', completedInteractions: [101, 'elicit-1'] },
      });
      activePromptId = null;
      return;
    }
    if (msg.id === 'elicit-dup' && activePromptId !== null) {
      send({
        jsonrpc: '2.0',
        id: activePromptId,
        result: { stopReason: 'end_turn', resolved: msg.result || msg.error },
      });
      activePromptId = null;
      return;
    }
    if (msg.id === 'unknown-srv-req' && activePromptId !== null) {
      send({
        jsonrpc: '2.0',
        id: activePromptId,
        result: { stopReason: 'end_turn', unknownErrorCode: msg.error?.code },
      });
      activePromptId = null;
      return;
    }
    if ((msg.id === 1 || msg.id === '1') && activePromptId !== null) {
      if (!globalThis.__idPairs) globalThis.__idPairs = [];
      globalThis.__idPairs.push([typeof msg.id, msg.id]);
      if (globalThis.__idPairs.length === 2) {
        send({
          jsonrpc: '2.0',
          id: activePromptId,
          result: { stopReason: 'end_turn', idPairs: globalThis.__idPairs },
        });
        globalThis.__idPairs = [];
        activePromptId = null;
      }
      return;
    }
  }
});

rl.on('close', () => {
  log({ event: 'stdin_eof' });
  if (mode !== 'ignore_eof_and_sigterm') {
    process.exit(0);
  }
});
`;
}

function fakeStreamJsonServerSource(): string {
  return `
import { createInterface } from 'node:readline';
import { createReadStream, writeSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_STREAM_MODE || 'normal';

if (mode === 'cli_error') {
  writeSync(2, 'Error: invalid flag combination\\n');
  process.exit(2);
}

if (mode === 'hang_and_ignore_sigterm') {
  process.on('SIGTERM', () => {});
  writeSync(1, JSON.stringify({
    event: 'init',
    conversation_id: 'conv-hang',
    init: { model: 'gemini-4-hydrogen', cwd: process.cwd() },
  }) + '\\n');
  setInterval(() => {}, 1000);
}

const rl = createInterface({ input: createReadStream(undefined, { fd: 0, autoClose: false }), crlfDelay: Infinity });
const receivedInputs = [];

rl.on('line', line => {
  if (!line.trim()) return;
  receivedInputs.push(JSON.parse(line));
});

rl.on('close', async () => {
  if (mode === 'hang_and_ignore_sigterm') return;

  // Emit an init event split across chunks and multi-byte UTF-8 boundary, plus a non-JSON warning line
  writeSync(1, 'diagnostic non-json preamble\\n');
  const initLine = JSON.stringify({
    event: 'init',
    conversation_id: 'conv-123',
    init: {
      model: 'gemini-4-hydrogen-tiered-xhigh',
      cwd: '/work',
      agent: 'default',
      tools: ['read_file', 'run_command'],
      permission_mode: 'accept-edits',
      argv,
    },
  }) + '\\n';
  const initBuf = Buffer.from(initLine, 'utf8');
  writeSync(1, initBuf.subarray(0, 20));
  await new Promise(r => setTimeout(r, 10));
  writeSync(1, initBuf.subarray(20));

  const step1 = JSON.stringify({
    event: 'step_update',
    conversation_id: 'conv-123',
    step_update: {
      conversation_id: 'conv-123',
      step_index: 1,
      state: 'running',
      step_type: 'agent_response',
      text_delta: '第一段中文',
    },
  }) + '\\n';
  const step1Buf = Buffer.from(step1, 'utf8');
  // Split right inside a 3-byte UTF-8 sequence to verify StringDecoder chunk safety
  const splitIdx = step1Buf.indexOf(Buffer.from('中', 'utf8')) + 1;
  writeSync(1, step1Buf.subarray(0, splitIdx));
  await new Promise(r => setTimeout(r, 10));
  writeSync(1, step1Buf.subarray(splitIdx));

  writeSync(1, JSON.stringify({
    event: 'step_update',
    conversation_id: 'conv-123',
    step_update: {
      conversation_id: 'conv-123',
      step_index: 2,
      state: 'done',
      step_type: 'tool_group',
      tool_name: 'read_file',
      usage: { input_tokens: 100, output_tokens: 40, thinking_tokens: 15, cache_read_tokens: 50, total_tokens: 205 },
    },
  }) + '\\n');

  writeSync(1, JSON.stringify({
    event: 'result',
    conversation_id: 'conv-123',
    result: {
      conversation_id: 'conv-123',
      status: 'SUCCESS',
      response: '完成',
      num_turns: receivedInputs.length,
      receivedInputs,
      argv,
    },
  }) + '\\n');
});
`;
}

test('CLI arg builders enforce P0-2 ACP and stream-json flag contracts', () => {
  assert.equal(DEFAULT_AGY_BIN, join(homedir(), '.gemini', 'bin', 'agy'));

  const acpArgs = buildAgyAcpArgs({
    geminiDir: '/tmp/gem',
    appDataDir: 'app-cli',
    sandbox: true,
    disableTelemetry: true,
  });
  assert.deepEqual(acpArgs, [
    'acp',
    '--stdio',
    '--gemini-dir',
    '/tmp/gem',
    '--app-data-dir',
    'app-cli',
    '--sandbox',
    '--disable-telemetry',
  ]);

  const streamArgs = buildAgyStreamJsonArgs({
    conversationId: 'conv-1',
    model: 'gemini-4-hydrogen',
    effort: 'high',
    mode: 'accept-edits',
    sandbox: true,
  });
  assert.deepEqual(streamArgs, [
    '-p=',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--conversation',
    'conv-1',
    '--model',
    'gemini-4-hydrogen',
    '--effort',
    'high',
    '--mode',
    'accept-edits',
    '--sandbox',
  ]);
  // Verify -p= is never split into ['-p', '--input-format', ...]
  const pIndex = streamArgs.indexOf('-p=');
  assert.notEqual(pIndex, -1);
  assert.equal(streamArgs.includes('-p'), false);
});

test('AgyAcpTransport completes initialize, session/new, streaming session/prompt, and session/cancel', async () => {
  const dir = createTempDir('agy-acp-basic-');
  try {
    const fakeBin = writeExecutableNodeScript(dir, 'fake-agy.mjs', fakeAcpServerSource());
    const logFile = join(dir, 'events.log');
    const healthEvents: Array<{ status: string; reason: string | null }> = [];
    const notifications: AgyAcpNotification[] = [];

    const transport = new AgyAcpTransport({
      agyBin: fakeBin,
      geminiDir: join(dir, 'gem'),
      appDataDir: 'bridge-cli',
      sandbox: true,
      disableTelemetry: true,
      env: { ...process.env, FAKE_LOG_FILE: logFile },
    });

    assert.equal(transport.status, 'unverified');
    assert.equal(transport.connected, false);
    assert.equal(transport.connectionGeneration, 0);
    assert.equal(transport.health().status, 'unverified');

    transport.onHealth = (status, reason) => healthEvents.push({ status, reason });
    transport.onNotification = n => notifications.push(n);

    const init = await transport.connect();
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentCapabilities?.loadSession, true);
    assert.equal(init.authMethods?.length, 2);
    assert.equal(transport.connectionGeneration, 1);
    assert.equal(transport.status, 'healthy');
    assert.equal(transport.connected, true);
    assert.deepEqual(healthEvents.at(-1), { status: 'healthy', reason: null });
    assert.deepEqual((init.agentCapabilities?._meta?.antigravity as { argv: string[] }).argv, [
      'acp',
      '--stdio',
      '--gemini-dir',
      join(dir, 'gem'),
      '--app-data-dir',
      'bridge-cli',
      '--sandbox',
      '--disable-telemetry',
    ]);

    const created = (await transport.request('session/new', { cwd: dir })) as { sessionId: string };
    assert.equal(created.sessionId, 'sess-fake-1');

    const loaded = (await transport.request('session/load', { sessionId: 'sess-fake-1', cwd: dir })) as { ok: boolean };
    assert.equal(loaded.ok, true);

    const listed = (await transport.request('session/list', {})) as { ok: boolean; method: string };
    assert.equal(listed.method, 'session/list');

    const setModel = (await transport.request('session/set_model', { sessionId: 'sess-fake-1', modelId: 'gemini-4-hydrogen' })) as { method: string };
    assert.equal(setModel.method, 'session/set_model');

    const setConfig = (await transport.request('session/set_config_option', { sessionId: 'sess-fake-1', configId: 'effort', value: 'high' })) as { method: string };
    assert.equal(setConfig.method, 'session/set_config_option');

    await assert.rejects(
      transport.request('session/list', { unauthenticated: true }),
      (err: AgyTransportError) => err.code === 'unauthorized' && err.rpcCode === -32000,
    );

    const promptRes = (await transport.request('session/prompt', {
      sessionId: 'sess-fake-1',
      scenario: 'stream',
      prompt: [{ type: 'text', text: 'hi' }],
    })) as { stopReason: string };
    assert.equal(promptRes.stopReason, 'end_turn');
    assert.equal(notifications.length, 2);
    assert.equal(notifications[0]?.method, 'session/update');
    assert.equal(notifications[0]?.generation, 1);
    assert.equal(notifications[1]?.method, 'session/update');

    // Verify session/cancel interrupts an in-flight session/prompt
    const pendingPrompt = transport.request('session/prompt', {
      sessionId: 'sess-fake-1',
      scenario: 'wait_cancel',
    });
    const cancelRes = (await transport.request('session/cancel', { sessionId: 'sess-fake-1' })) as Record<string, unknown>;
    assert.deepEqual(cancelRes, {});
    const cancelledPrompt = (await pendingPrompt) as { stopReason: string };
    assert.equal(cancelledPrompt.stopReason, 'cancelled');

    await transport.close();
    // close() must be idempotent
    await transport.close();
    assert.equal(transport.connected, false);
    assert.ok(readFileSync(logFile, 'utf8').includes('"stdin_eof"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgyAcpTransport enforces bidirectional permission/elicitation, single-response rpcId, and generation fencing', async () => {
  const dir = createTempDir('agy-acp-rpc-');
  try {
    const fakeBin = writeExecutableNodeScript(dir, 'fake-agy.mjs', fakeAcpServerSource());
    const logFile = join(dir, 'rpc.log');
    const serverRequests: AgyServerRequest[] = [];
    const disconnects: number[] = [];
    const writes: Array<Promise<void>> = [];

    const transport = new AgyAcpTransport({
      agyBin: fakeBin,
      env: { ...process.env, FAKE_LOG_FILE: logFile },
    });

    transport.onDisconnect = gen => disconnects.push(gen);
    transport.onServerRequest = req => {
      serverRequests.push(req);
      if (req.method === 'session/request_permission') {
        const result = { outcome: { outcome: 'selected', optionId: 'allow_once' } };
        const rejection = new Error('stale operation');
        assert.throws(() => transport.respondServerRequest(req.generation, req.rpcId, result, () => {
          throw rejection;
        }), error => error === rejection);
        writes.push(transport.respondServerRequest(req.generation, req.rpcId, result));
        // Duplicate response for the same numeric rpcId must be rejected synchronously without sending a second reply
        assert.throws(
          () => transport.respondServerRequest(req.generation, req.rpcId, { outcome: { optionId: 'reject_once' } }),
          hasCode('idempotency_conflict'),
        );
        assert.throws(
          () => transport.respondServerError(req.generation, req.rpcId, -32000, 'duplicate'),
          hasCode('idempotency_conflict'),
        );
      } else if (req.method === 'elicitation/create' && req.rpcId === 'elicit-1') {
        writes.push(transport.respondServerRequest(req.generation, req.rpcId, {
          action: 'accept',
          content: { env: 'staging' },
        }));
        // Duplicate response for string rpcId must also be rejected
        assert.throws(
          () => transport.respondServerRequest(req.generation, req.rpcId, { action: 'cancel' }),
          hasCode('idempotency_conflict'),
        );
      }
    };

    await transport.connect();
    assert.equal(transport.connectionGeneration, 1);

    const promptResult = (await transport.request('session/prompt', {
      sessionId: 'sess-fake-1',
      scenario: 'permission_and_elicitation',
    })) as { stopReason: string; completedInteractions: unknown[] };

    assert.equal(writes.length, 2);
    await Promise.all(writes);
    assert.equal(promptResult.stopReason, 'end_turn');
    assert.deepEqual(promptResult.completedInteractions, [101, 'elicit-1']);
    assert.deepEqual(
      serverRequests.map(r => [r.method, r.rpcId, r.generation]),
      [
        ['session/request_permission', 101, 1],
        ['elicitation/create', 'elicit-1', 1],
      ],
    );

    // Ensure only one reply per rpcId was written to fake server stdin
    const logEntries = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as { direction?: string; msg?: { id?: unknown; method?: string } });
    const repliesTo101 = logEntries.filter(e => e.direction === 'in' && !e.msg?.method && e.msg?.id === 101);
    const repliesToElicit1 = logEntries.filter(e => e.direction === 'in' && !e.msg?.method && e.msg?.id === 'elicit-1');
    assert.equal(repliesTo101.length, 1);
    assert.equal(repliesToElicit1.length, 1);

    // Now test stale connectionGeneration rejection across disconnect + reconnect:
    // Start an elicitation request on generation 1 without answering it before closing/reconnecting
    let capturedStaleReq: AgyServerRequest | undefined;
    transport.onServerRequest = req => {
      capturedStaleReq = req;
    };
    const danglingPrompt = transport.request('session/prompt', {
      sessionId: 'sess-fake-1',
      scenario: 'elicitation_only',
    });
    // Wait until elicitation/create arrives on generation 1
    await new Promise<void>(resolve => {
      const check = () => (capturedStaleReq ? resolve() : setTimeout(check, 5));
      check();
    });
    assert.equal(capturedStaleReq?.generation, 1);
    assert.equal(capturedStaleReq?.rpcId, 'elicit-dup');

    const danglingRejection = assert.rejects(danglingPrompt, hasCode('outcome_unknown'));
    await transport.close();
    await danglingRejection;
    assert.deepEqual(disconnects, [1]);

    // While disconnected, stale generation 1 reply must be rejected
    assert.throws(
      () => transport.respondServerRequest(1, 'elicit-dup', { action: 'accept', content: { branch: 'main' } }),
      hasCode('interaction_expired'),
    );

    // Reconnect (generation advances to 2) and emit the SAME rpcId 'elicit-dup' on generation 2
    let capturedGen2Req: AgyServerRequest | undefined;
    transport.onServerRequest = req => {
      capturedGen2Req = req;
    };
    await transport.connect();
    assert.equal(transport.connectionGeneration, 2);

    const gen2Prompt = transport.request('session/prompt', {
      sessionId: 'sess-fake-1',
      scenario: 'elicitation_only',
    });
    await new Promise<void>(resolve => {
      const check = () => (capturedGen2Req ? resolve() : setTimeout(check, 5));
      check();
    });
    assert.equal(capturedGen2Req?.generation, 2);
    assert.equal(capturedGen2Req?.rpcId, 'elicit-dup');

    // Replying with old generation 1 must STILL be rejected even though gen 2 has the same rpcId!
    assert.throws(
      () => transport.respondServerRequest(1, 'elicit-dup', { action: 'accept', content: { branch: 'stale' } }),
      hasCode('interaction_expired'),
    );
    assert.throws(
      () => transport.respondServerError(1, 'elicit-dup', -32000, 'stale error'),
      hasCode('interaction_expired'),
    );

    // Replying with current generation 2 via respondServerError succeeds cleanly
    transport.respondServerError(2, 'elicit-dup', -32001, 'user declined');
    const gen2Result = (await gen2Prompt) as { resolved: { code: number; message: string } };
    assert.equal(gen2Result.resolved.code, -32001);
    assert.equal(gen2Result.resolved.message, 'user declined');

    await transport.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgyAcpTransport rejects in-flight requests, updates degraded health, and fires onDisconnect on unexpected exit', async () => {
  const dir = createTempDir('agy-acp-crash-');
  try {
    const fakeBin = writeExecutableNodeScript(dir, 'fake-agy.mjs', fakeAcpServerSource());
    const healthStates: Array<{ status: string; reason: string | null }> = [];
    const disconnectedGens: number[] = [];

    const transport = new AgyAcpTransport({
      agyBin: fakeBin,
      requestTimeoutMs: 500,
    });
    transport.onHealth = (status, reason) => healthStates.push({ status, reason });
    transport.onDisconnect = gen => disconnectedGens.push(gen);

    await transport.connect();
    assert.equal(transport.status, 'healthy');

    const inflight = transport.request('session/prompt', {
      sessionId: 'sess-fake-1',
      scenario: 'crash_mid_request',
    });
    await assert.rejects(inflight, hasCode('outcome_unknown'));
    assert.equal(transport.connected, false);
    assert.equal(transport.status, 'degraded');
    assert.equal(healthStates.at(-1)?.status, 'degraded');
    assert.match(healthStates.at(-1)?.reason ?? '', /exited on signal SIGKILL/);
    assert.deepEqual(disconnectedGens, [1]);

    // Test request timeout on live connection
    await transport.connect();
    assert.equal(transport.connectionGeneration, 2);
    await assert.rejects(
      transport.request('session/prompt', { sessionId: 'sess-fake-1', scenario: 'hang' }, 60),
      hasCode('outcome_unknown'),
    );
    assert.equal(transport.status, 'degraded');
    await transport.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgyAcpTransport close falls back to SIGTERM and SIGKILL when child ignores EOF and SIGTERM', async () => {
  const dir = createTempDir('agy-acp-kill-');
  try {
    const fakeBin = writeExecutableNodeScript(dir, 'fake-agy.mjs', fakeAcpServerSource());
    const logFile = join(dir, 'kill.log');
    const transport = new AgyAcpTransport({
      agyBin: fakeBin,
      closeTimeoutMs: 60,
      env: { ...process.env, FAKE_MODE: 'ignore_eof_and_sigterm', FAKE_LOG_FILE: logFile },
    });

    await transport.connect();
    const pending = transport.request('session/prompt', { sessionId: 'sess-fake-1', scenario: 'hang' });
    const pendingRejection = assert.rejects(pending, hasCode('outcome_unknown'));
    await transport.close();
    await pendingRejection;
    assert.equal(transport.connected, false);

    const logs = readFileSync(logFile, 'utf8');
    assert.match(logs, /stdin_eof/);
    assert.match(logs, /ignored_sigterm/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgyAcpTransport handles unknown server requests, numeric vs string rpcId separation, and connect failures', async () => {
  const dir = createTempDir('agy-acp-edge-');
  try {
    const fakeBin = writeExecutableNodeScript(dir, 'fake-agy.mjs', fakeAcpServerSource());
    const transport = new AgyAcpTransport({ agyBin: fakeBin });
    const seenRequests: AgyServerRequest[] = [];
    transport.onServerRequest = req => {
      seenRequests.push(req);
      if (req.rpcId === 1) {
        transport.respondServerRequest(req.generation, 1, { outcome: { optionId: 'allow_once' } });
      } else if (req.rpcId === '1') {
        transport.respondServerRequest(req.generation, '1', { action: 'accept', content: {} });
      }
    };

    await transport.connect();

    // Unknown server request receives JSON-RPC -32601 Method not found automatically without invoking onServerRequest
    const unknownRes = (await transport.request('session/prompt', {
      sessionId: 'sess-fake-1',
      scenario: 'unknown_server_request',
    })) as { unknownErrorCode: number };
    assert.equal(unknownRes.unknownErrorCode, -32601);
    assert.equal(seenRequests.length, 0);

    // Numeric rpcId `1` and string rpcId `'1'` are tracked independently
    const sameIdRes = (await transport.request('session/prompt', {
      sessionId: 'sess-fake-1',
      scenario: 'same_id_types',
    })) as { idPairs: Array<[string, number | string]> };
    assert.deepEqual(sameIdRes.idPairs, [
      ['number', 1],
      ['string', '1'],
    ]);
    await transport.close();

    // Crash before initialize rejects connect() and marks degraded without firing onDisconnect
    const crashDisconnects: number[] = [];
    const crashTransport = new AgyAcpTransport({
      agyBin: fakeBin,
      env: { ...process.env, FAKE_MODE: 'crash_before_init' },
    });
    crashTransport.onDisconnect = gen => crashDisconnects.push(gen);
    await assert.rejects(crashTransport.connect(), hasCode('temporarily_unavailable'));
    assert.equal(crashTransport.status, 'degraded');
    assert.equal(crashTransport.connectionGeneration, 0);
    assert.deepEqual(crashDisconnects, []);

    // Missing binary fails fast with degraded state
    const enoentTransport = new AgyAcpTransport({ agyBin: join(dir, 'does-not-exist-agy') });
    await assert.rejects(enoentTransport.connect(), hasCode('temporarily_unavailable'));
    assert.equal(enoentTransport.status, 'degraded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgyStreamJsonRunner passes -p= flags, parses init/step_update/result across chunked UTF-8, and supports cancellation', async () => {
  const dir = createTempDir('agy-stream-');
  try {
    const fakeBin = writeExecutableNodeScript(dir, 'fake-stream.mjs', fakeStreamJsonServerSource());
    const observedEvents: AgyStreamEvent[] = [];
    const parseErrors: string[] = [];

    const runner = new AgyStreamJsonRunner({
      agyBin: fakeBin,
      conversationId: 'conv-123',
      model: 'gemini-4-hydrogen',
      effort: 'high',
      mode: 'accept-edits',
      sandbox: true,
      onEvent: ev => observedEvents.push(ev),
      onParseError: line => parseErrors.push(line),
    });

    const outcome = await runner.run('继续总结进展');
    assert.equal(outcome.conversationId, 'conv-123');
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.init?.model, 'gemini-4-hydrogen-tiered-xhigh');
    assert.equal(outcome.steps.length, 2);
    assert.equal(outcome.steps[0]?.text_delta, '第一段中文');
    assert.equal(outcome.steps[1]?.tool_name, 'read_file');
    assert.equal(outcome.steps[1]?.usage?.total_tokens, 205);
    assert.equal(outcome.result?.status, 'SUCCESS');
    assert.equal(outcome.result?.response, '完成');
    assert.deepEqual(outcome.result?.receivedInputs, [
      { event: 'user', message: { content: '继续总结进展' } },
    ]);
    assert.deepEqual(outcome.result?.argv, [
      '-p=',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--conversation',
      'conv-123',
      '--model',
      'gemini-4-hydrogen',
      '--effort',
      'high',
      '--mode',
      'accept-edits',
      '--sandbox',
    ]);
    assert.deepEqual(
      observedEvents.map(e => e.event),
      ['init', 'step_update', 'step_update', 'result'],
    );
    assert.deepEqual(parseErrors, ['diagnostic non-json preamble']);

    // Non-zero exit code returns invalid_request for RC=2 with stderr preserved
    const failingRunner = new AgyStreamJsonRunner({
      agyBin: fakeBin,
      env: { ...process.env, FAKE_STREAM_MODE: 'cli_error' },
    });
    await assert.rejects(
      failingRunner.run('bad flags'),
      (err: AgyTransportError) => err.code === 'invalid_request' && err.exitCode === 2 && /invalid flag/.test(err.stderr ?? ''),
    );

    // Cancellation terminates even a process ignoring SIGTERM via SIGKILL fallback
    const cancellableRunner = new AgyStreamJsonRunner({
      agyBin: fakeBin,
      closeTimeoutMs: 60,
      env: { ...process.env, FAKE_STREAM_MODE: 'hang_and_ignore_sigterm' },
    });
    let sawInit = false;
    const runPromise = cancellableRunner.run([{ type: 'text', text: 'long task' }], {
      onEvent: ev => {
        if (ev.event === 'init') sawInit = true;
      },
    });
    const runRejection = assert.rejects(
      runPromise,
      (err: AgyTransportError) => err.code === 'outcome_unknown' && err.cancelled === true,
    );
    await new Promise<void>(resolve => {
      const check = () => (sawInit ? resolve() : setTimeout(check, 5));
      check();
    });
    await cancellableRunner.cancel();
    await cancellableRunner.cancel(); // idempotent
    await runRejection;
    assert.equal(cancellableRunner.cancelled, true);
    assert.equal(cancellableRunner.running, false);

    // AbortSignal also terminates a running stream-json child
    const abortRunner = new AgyStreamJsonRunner({
      agyBin: fakeBin,
      closeTimeoutMs: 60,
      env: { ...process.env, FAKE_STREAM_MODE: 'hang_and_ignore_sigterm' },
    });
    const controller = new AbortController();
    let abortInit = false;
    const abortPromise = abortRunner.run('abortable', {
      signal: controller.signal,
      onEvent: ev => {
        if (ev.event === 'init') abortInit = true;
      },
    });
    const abortRejection = assert.rejects(
      abortPromise,
      (err: AgyTransportError) => err.code === 'outcome_unknown' && err.cancelled === true,
    );
    await new Promise<void>(resolve => {
      const check = () => (abortInit ? resolve() : setTimeout(check, 5));
      check();
    });
    controller.abort();
    await abortRejection;

    // Multi-turn stdin streaming with endInput: false + sendUserMessage + endInput
    const multiRunner = new AgyStreamJsonRunner({ agyBin: fakeBin });
    const multiPromise = multiRunner.run('turn 1', { endInput: false });
    multiRunner.sendUserMessage('turn 2');
    multiRunner.endInput();
    const multiOutcome = await multiPromise;
    assert.equal(multiOutcome.result?.num_turns, 2);
    assert.deepEqual(multiOutcome.result?.receivedInputs, [
      { event: 'user', message: { content: 'turn 1' } },
      { event: 'user', message: { content: 'turn 2' } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
