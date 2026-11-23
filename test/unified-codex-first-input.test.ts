import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import { CodexTransport, type SocketFactory } from '../src/unified/codex-transport.js';
import type { Operation } from '../src/unified/contracts.js';
import { createIntegratedRuntime } from '../src/unified/runtime.js';

class AppServerSocket extends EventTarget {
  readyState = 0;
  readonly starts: Array<{ threadId: string; input: Array<{ text: string }> }> = [];
  constructor(private readonly project: string) { super(); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  send(raw: string) {
    const request = JSON.parse(raw);
    const reply = (result: unknown) => queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result }) }));
    });
    switch (request.method) {
      case 'initialize': return reply({});
      case 'thread/start': return reply({ thread: { id: 'native', cwd: this.project, name: null, status: { type: 'idle' } } });
      case 'thread/list': return reply({ data: [], nextCursor: null });
      case 'turn/start':
        this.starts.push(request.params);
        return reply({ turn: { id: 'first-turn' } });
    }
  }
}

test('integrated Feishu Codex creation sends the first question while the thread is absent from thread/list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-first-question-'));
  const logs = join(dir, 'logs');
  mkdirSync(logs);
  writeFileSync(join(logs, 'external.jsonl'), JSON.stringify({
    type: 'session_meta', payload: { id: 'external', cwd: dir },
  }) + '\n');
  const socket = new AppServerSocket(dir);
  const transport = new CodexTransport('ws://127.0.0.1:1', (() => {
    queueMicrotask(() => socket.open());
    return socket;
  }) as unknown as SocketFactory, 1000);
  const provider = new CodexAdapter(transport, 'h', 'v');
  const runtime = await createIntegratedRuntime({
    coreDb: join(dir, 'core.sqlite'), channelDb: join(dir, 'channel.sqlite'), artifactStatePath: join(dir, 'artifacts.json'),
    ownerOpenId: 'owner', allowedDestinations: ['chat'], hostId: 'h', codexServiceId: 'v', claudeServiceId: 'c',
    claudeStateDir: dir, codexEndpoint: transport.endpoint, intervalMs: 100,
    catalogSources: [{ provider: 'codex', directory: logs, hostId: 'h', serviceId: 'v' }],
    allowedProjectRoots: [dir], outputRoots: [dir],
  }, { send: async () => 'message', update: async () => {}, sendFile: async () => {} }, [provider]);
  const identity = { source: 'feishu', subject: 'owner' };
  const envelope = (eventId: string) => ({ eventId, destination: 'chat', identity });
  try {
    await transport.connect();
    const create = await runtime.channel.handle(envelope('create'), {
      action: 'create', provider: 'codex', project: dir, model: null,
    }) as Operation;
    const created = await runtime.core.dispatch(create.operationId);
    assert.equal(created.status, 'completed');
    assert.equal(created.result?.kind, 'session');
    const sessionId = created.result.sessionId;
    await runtime.channel.advanceCompleted();
    assert.deepEqual(runtime.channel.boundDestinations(), ['chat']);
    assert.equal((await provider.list(null, 1)).items.length, 0);

    const question = '检查飞书首句能否提交';
    const input = await runtime.channel.handle(envelope('first-question'), { action: 'input', mode: 'new', text: question }) as Operation;
    assert.equal((await runtime.core.dispatch(input.operationId)).status, 'accepted');
    assert.equal(socket.starts.length, 1);
    assert.equal(socket.starts[0]?.threadId, 'native');
    assert.equal(socket.starts[0]?.input[0]?.text, question);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await runtime.core.getSession(sessionId)).title, question);

    const attach = await runtime.core.attachSession({
      context: { targetId: 'external', operationId: 'attach-external', idempotencyKey: 'attach-external', expectedRevision: 0, controlGeneration: 0, identity },
      payload: { provider: 'codex', hostId: 'h', serviceId: 'v', nativeSessionId: 'external', mode: 'read_only' },
    });
    assert.equal(attach.status, 'completed');
    assert.equal(attach.result?.kind, 'session');
    assert.equal((await runtime.core.getSession(attach.result.sessionId)).status, 'read_only');
    await assert.rejects(runtime.core.attachSession({
      context: { targetId: 'external', operationId: 'upgrade-external', idempotencyKey: 'upgrade-external', expectedRevision: 0, controlGeneration: 0, identity },
      payload: { provider: 'codex', hostId: 'h', serviceId: 'v', nativeSessionId: 'external', mode: 'interactive' },
    }), { code: 'unsupported' });

    const native = (await runtime.core.getSession(sessionId)).native;
    assert.equal(provider.hasActiveNativeSession(native), true);
    assert.equal(provider.hasActiveNativeSession({ ...native, hostId: 'other' }), false);
    transport.close();
    assert.equal(provider.hasActiveNativeSession(native), false);
  } finally {
    await runtime.close();
    transport.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
