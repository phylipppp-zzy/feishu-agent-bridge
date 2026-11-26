import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { runtimeApprovalScope } from '../src/unified/codex-approval.js';
import { ClaudeAdapter } from '../src/unified/claude-adapter.js';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import { AgyAdapter } from '../src/unified/agy-adapter.js';
import type { AgyCatalog } from '../src/unified/agy-catalog.js';
import type { AgyAcpTransport, AgyServerRequest } from '../src/unified/agy-transport.js';
import type { CodexTransport } from '../src/unified/codex-transport.js';
import type { PlatformObservation } from '../src/unified/adapter.js';
import type { Interaction } from '../src/unified/contracts.js';
import type { RuntimeConfig } from '../src/unified/runtime.js';

test('runtimeApprovalScope defaults to harness passthrough (enabled: false)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-passthrough-scope-'));
  try {
    const config: RuntimeConfig = {
      coreDb: join(dir, 'core'),
      channelDb: join(dir, 'channel'),
      allowedDestinations: ['chat'],
      ownerOpenId: 'owner',
      hostId: 'h',
      claudeServiceId: 'c',
      codexServiceId: 'x',
      claudeStateDir: join(dir, 'claude'),
      codexEndpoint: 'ws://127.0.0.1:1234',
      intervalMs: 100,
    };
    assert.equal(runtimeApprovalScope(config).enabled, false);
    assert.equal(runtimeApprovalScope({ ...config, approvalPolicy: {} }).enabled, false);
    assert.equal(runtimeApprovalScope({ ...config, approvalPolicy: { enabled: true } }).enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgyAdapter passes harness permission requests through without bridge policy text when disabled', async () => {
  let serverRequestHandler: ((req: AgyServerRequest) => void) | null = null;
  const responses: Array<{ rpcId: string | number; result: unknown }> = [];
  const transport = {
    connected: true,
    connectionGeneration: 1,
    defaultMode: 'auto',
    onNotification: () => {},
    onServerRequest: () => {},
    onDisconnect: () => {},
    async request(method: string) {
      if (method === 'session/new') return { sessionId: 'sess-agy-pass', modes: { currentModeId: 'default' } };
      if (method === 'session/set_mode') return {};
      if (method === 'session/prompt') return new Promise(() => {});
      return {};
    },
    notify() {},
    async respondServerRequest(_gen: number, rpcId: string | number, result: unknown) {
      responses.push({ rpcId, result });
    },
    respondServerError() {},
    async close() {},
  };
  Object.defineProperty(transport, 'onServerRequest', {
    get: () => serverRequestHandler ?? (() => {}),
    set: (fn: (req: AgyServerRequest) => void) => {
      serverRequestHandler = fn;
    },
  });
  const catalog = {
    get: () => null,
    refreshAsync: async () => {},
    readTranscript: async () => ({ messages: [] }),
  } as unknown as AgyCatalog;

  const adapter = new AgyAdapter(
    transport as unknown as AgyAcpTransport,
    catalog,
    'host',
    'agy-svc',
    undefined,
    { approvalPolicy: { enabled: false } },
  );
  const interactions: Interaction[] = [];
  adapter.onObservation((obs: PlatformObservation) => {
    if (obs.type === 'interaction') interactions.push(obs.interaction);
  });

  const created = await adapter.create('/tmp', null);
  const ref = created.createdSession!.native;
  await adapter.input(ref, 'new', [{ type: 'text', text: 'run something' }], {
    operationId: 'op-1',
    expectedControlGeneration: 0,
    expectedConnectionGeneration: 1,
    assertCurrent() {},
  });

  serverRequestHandler!({
    generation: 1,
    rpcId: 42,
    method: 'session/request_permission',
    params: {
      sessionId: 'sess-agy-pass',
      toolCall: {
        toolCallId: 'call-1',
        name: 'run_command',
        kind: 'execute',
        args: { CommandLine: 'systemctl --user status foo', BypassSandbox: true },
      },
      options: [
        { optionId: 'allow_once', kind: 'allow_once' },
        { optionId: 'allow_always', kind: 'allow_always' },
        { optionId: 'reject_once', kind: 'reject_once' },
      ],
    },
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(interactions.length, 1);
  const approval = interactions[0]!;
  assert.equal(approval.kind, 'approval');
  assert.equal((approval as Interaction & { allowAlways?: boolean }).allowAlways, true);
  assert.doesNotMatch(approval.action, /部署配置已停用自动审批|无法确认工具的完整参数/);
  assert.equal(responses.length, 0);

  await adapter.close();
});

test('ClaudeAdapter omits PreToolUse hook and passes canUseTool through when bridge approval is disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-passthrough-'));
  try {
    let capturedOptions: Options | undefined;
    let releaseStream: (() => void) | undefined;
    const sdk = {
      query(args: { options?: Options }) {
        capturedOptions = args.options;
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>(resolve => {
              releaseStream = resolve;
            });
          },
          close() {
            releaseStream?.();
          },
          interrupt: async () => {},
        };
      },
      listSessions: async () => [],
      getSessionMessages: async () => [],
    } as unknown as ConstructorParameters<typeof ClaudeAdapter>[3];

    const adapter = new ClaudeAdapter('host', 'claude-svc', dir, sdk, '/bin/true', {
      approvalPolicy: { enabled: false },
    });
    const interactions: Interaction[] = [];
    adapter.onObservation(obs => {
      if (obs.type === 'interaction') interactions.push(obs.interaction);
    });

    await adapter.create(dir, null);
    assert.ok(capturedOptions);
    assert.equal(capturedOptions.hooks, undefined);
    assert.ok(capturedOptions.canUseTool);

    const controller = new AbortController();
    const pending = capturedOptions.canUseTool(
      'Bash',
      { command: 'systemctl --user status foo' },
      { signal: controller.signal, toolUseID: 'tool-1', requestId: 'req-1' } as Parameters<NonNullable<Options['canUseTool']>>[2],
    );
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(interactions.length, 1);
    const approval = interactions[0]!;
    assert.equal(approval.kind, 'approval');
    assert.doesNotMatch(approval.action, /部署配置已停用自动审批|无法确认工具的完整参数/);

    controller.abort();
    const settled = await pending;
    assert.ok(settled);
    assert.equal(settled.behavior, 'deny');
    await adapter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CodexAdapter passes native approval through without bridge checks when disabled', async () => {
  let sharedFsCalled = false;
  const transport = {
    connected: true,
    generation: 1,
    onMessage: null as ((m: Record<string, unknown>, generation: number) => void) | null,
    onDisconnect: null as ((generation: number) => void) | null,
    async request(method: string) {
      if (method === 'thread/start') {
        return {
          thread: {
            id: 'thr-1',
            cwd: '/tmp',
            preview: '',
            createdAt: 1,
            updatedAt: 1,
            status: { type: 'idle' },
          },
        };
      }
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
      return {};
    },
    respond() {},
    close() {},
  };

  const adapter = new CodexAdapter(transport as unknown as CodexTransport, 'host', 'codex-svc', {
    approvalPolicy: { enabled: false },
    proveSharedFilesystem: async () => {
      sharedFsCalled = true;
      return false;
    },
  });
  const interactions: Interaction[] = [];
  adapter.onObservation(obs => {
    if (obs.type === 'interaction') interactions.push(obs.interaction);
  });

  const created = await adapter.create('/tmp', null);
  await adapter.input(created.createdSession!.native, 'new', [{ type: 'text', text: 'hi' }], {
    operationId: 'op-1',
    expectedControlGeneration: 0,
    expectedConnectionGeneration: 1,
    assertCurrent() {},
  });

  assert.equal(typeof transport.onMessage, 'function');
  transport.onMessage!({
    id: 7,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thr-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      command: 'systemctl --user status foo',
      cwd: '/tmp',
      availableDecisions: ['accept', 'decline'],
    },
  }, 1);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(sharedFsCalled, false);
  assert.equal(interactions.length, 1);
  const approval = interactions[0]!;
  assert.equal(approval.kind, 'approval');
  assert.doesNotMatch(approval.action, /部署配置已停用自动审批|无法确认工具的完整参数/);
});
