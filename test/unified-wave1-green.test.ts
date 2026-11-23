import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../src/unified/claude-adapter.js';
import { AgyAdapter } from '../src/unified/agy-adapter.js';
import { AgyCatalog } from '../src/unified/agy-catalog.js';
import type { AgyAcpTransport } from '../src/unified/agy-transport.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';
import { FeishuSdkPort } from '../src/unified/feishu-sdk-port.js';
import { parseFeishuText } from '../src/unified/feishu-codec.js';
import { ArtifactRegistry } from '../src/unified/artifact-registry.js';
import { EnrichedPort } from '../src/unified/port-enrichment.js';
import { LocalCatalog } from '../src/unified/local-catalog.js';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedCore } from '../src/unified/service.js';
import { createIntegratedRuntime, type RuntimeConfig } from '../src/unified/runtime.js';
import { payloadDigest, type Capabilities, type Provider, type Session } from '../src/unified/contracts.js';
import type { DispatchGuard, PlatformObservation, PlatformPort } from '../src/unified/adapter.js';

const fullCaps = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map((k) => [
    k,
    { status: 'available' },
  ]),
) as Capabilities;

const readonlyCaps = Object.fromEntries(
  ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config'].map((k) => [
    k,
    { status: k === 'view' ? 'available' : 'unsupported' },
  ]),
) as Capabilities;

function makeSession(
  provider: Provider,
  nativeSessionId: string,
  project: string,
  title: string,
  options: { readOnly?: boolean; sessionId?: string } = {},
): Session {
  return {
    sessionId: options.sessionId ?? `session_${payloadDigest({ provider, hostId: 'h', serviceId: provider, nativeSessionId })}`,
    native: { provider, hostId: 'h', serviceId: provider, nativeSessionId },
    project,
    title,
    status: options.readOnly ? 'read_only' : 'idle',
    revision: 0,
    capabilities: options.readOnly ? readonlyCaps : fullCaps,
    control: {
      serviceId: provider,
      owner: options.readOnly ? null : 'owner',
      input: options.readOnly ? 'unavailable' : 'available',
      generation: 0,
      operationId: null,
      reason: null,
    },
  };
}

function makeBasePort(provider: Provider, overrides: Partial<PlatformPort> = {}): PlatformPort {
  return {
    provider,
    onObservation: () => () => {},
    list: async () => ({ items: [], nextCursor: null }),
    read: async () => {
      throw new Error('session not found');
    },
    resume: async () => {
      throw new Error('unsupported');
    },
    create: async () => {
      throw new Error('unsupported');
    },
    input: async () => {
      throw new Error('unsupported');
    },
    interrupt: async () => {
      throw new Error('unsupported');
    },
    respond: async () => {
      throw new Error('unsupported');
    },
    control: async () => {
      throw new Error('unsupported');
    },
    updateSettings: async () => {
      throw new Error('unsupported');
    },
    listModels: async () => [],
    listArtifacts: async () => [],
    readArtifact: async () => new Uint8Array(),
    ...overrides,
  };
}

test('Wave1 Item 1a: tick() skips missing archived read-only binding so core converges to healthy, while validating existing/writable/untrusted sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w1-missing-ro-'));
  try {
    const allowedRoot = join(dir, 'allowed');
    const deletedProject = join(allowedRoot, 'deleted-proj');
    const existingProject = join(allowedRoot, 'live-proj');
    const outsideProject = join(dir, 'outside-proj');
    const logs = join(dir, 'logs');
    mkdirSync(deletedProject, { recursive: true });
    mkdirSync(existingProject, { recursive: true });
    mkdirSync(outsideProject, { recursive: true });
    mkdirSync(logs, { recursive: true });

    const cfg: RuntimeConfig = {
      coreDb: join(dir, 'core.sqlite'),
      channelDb: join(dir, 'channel.sqlite'),
      artifactStatePath: join(dir, 'artifacts.json'),
      ownerOpenId: 'owner',
      allowedDestinations: ['chat-ro', 'chat-ok'],
      hostId: 'h',
      claudeServiceId: 'c',
      codexServiceId: 'x',
      claudeStateDir: join(dir, 'claude-state'),
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 60_000,
      catalogSources: [
        { provider: 'claude', hostId: 'h', serviceId: 'c', directory: logs },
        { provider: 'codex', hostId: 'h', serviceId: 'x', directory: logs },
      ],
      allowedProjectRoots: [allowedRoot],
      outputRoots: [allowedRoot],
    };

    const roMissingSession: Session = {
      ...makeSession('claude', 'cl-archived-missing', deletedProject, 'Archived RO', { readOnly: true }),
      native: { provider: 'claude', hostId: 'h', serviceId: 'c', nativeSessionId: 'cl-archived-missing' },
      control: { serviceId: 'c', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: 'external' },
    };
    const liveExistingSession: Session = {
      ...makeSession('codex', 'cx-live-ok', existingProject, 'Live Existing'),
      native: { provider: 'codex', hostId: 'h', serviceId: 'x', nativeSessionId: 'cx-live-ok' },
      control: { serviceId: 'x', owner: 'owner', input: 'available', generation: 0, operationId: null, reason: null },
    };

    const seedStore = new UnifiedStore(cfg.coreDb);
    seedStore.insertSession(roMissingSession);
    seedStore.insertSession(liveExistingSession);
    seedStore.close();

    const seedChan = new FeishuChannel(
      {} as any,
      { send: async () => 'm', update: async () => {}, sendFile: async () => {} },
      async () => true,
      cfg.channelDb,
    );
    seedChan.importMigrationBinding('m-ro', {
      destination: 'chat-ro',
      sessionId: roMissingSession.sessionId,
      bindingId: 'b-ro',
      owner: { source: 'feishu', subject: 'owner' },
    });
    seedChan.importMigrationBinding('m-ok', {
      destination: 'chat-ok',
      sessionId: liveExistingSession.sessionId,
      bindingId: 'b-ok',
      owner: { source: 'feishu', subject: 'owner' },
    });
    seedChan.close();

    const claudeBase = makeBasePort('claude');
    const codexBase = makeBasePort('codex', {
      read: async () => ({ session: liveExistingSession, messages: [], interactions: [] }),
    });
    const port: FeishuPort & { authorizedDestination: (d: string) => boolean } = {
      authorizedDestination: (d) => ['chat-ro', 'chat-ok'].includes(d),
      send: async () => 'm1',
      update: async () => {},
      sendFile: async () => {},
    };

    let runtime = await createIntegratedRuntime(cfg, port, [claudeBase, codexBase]);
    await runtime.prepareReadonlyHistoryBaselines(10);
    await runtime.tick();
    assert.equal(runtime.health().status, 'healthy');
    await runtime.close();

    // Now delete the read-only session's project directory on disk before restart
    rmSync(deletedProject, { recursive: true, force: true });

    runtime = await createIntegratedRuntime(cfg, port, [claudeBase, codexBase]);
    try {
      await runtime.tick();
      assert.equal(runtime.health().status, 'healthy');
      const coreHealth = (await runtime.core.health()).find((r) => r.component === 'core');
      assert.equal(coreHealth?.status, 'healthy');
      assert.equal(coreHealth?.reason, null);
    } finally {
      await runtime.close();
    }

    // Security check 1: existing read-only project outside allowedProjectRoots must still fail validation
    const untrustedRo: Session = {
      ...makeSession('claude', 'cl-untrusted-ro', outsideProject, 'Untrusted RO', { readOnly: true }),
      native: { provider: 'claude', hostId: 'h', serviceId: 'c', nativeSessionId: 'cl-untrusted-ro' },
      control: { serviceId: 'c', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: null },
    };
    const dir2 = mkdtempSync(join(tmpdir(), 'w1-sec-'));
    try {
      const cfg2: RuntimeConfig = {
        ...cfg,
        coreDb: join(dir2, 'core.sqlite'),
        channelDb: join(dir2, 'channel.sqlite'),
        artifactStatePath: join(dir2, 'artifacts.json'),
        allowedDestinations: ['chat-untrusted'],
      };
      const s2 = new UnifiedStore(cfg2.coreDb);
      s2.insertSession(untrustedRo);
      s2.close();
      const c2 = new FeishuChannel({} as any, { send: async () => 'm', update: async () => {}, sendFile: async () => {} }, async () => true, cfg2.channelDb);
      c2.importMigrationBinding('m-untrusted', {
        destination: 'chat-untrusted',
        sessionId: untrustedRo.sessionId,
        bindingId: 'b-u',
        owner: { source: 'feishu', subject: 'owner' },
      });
      // Force hydrated so requireReadonlyHydration doesn't skip sync
      c2.close();
      const chanDb2 = new DatabaseSync(cfg2.channelDb);
      chanDb2.prepare('INSERT INTO channel_history_baselines VALUES (?,?,?)').run(
        'chat-untrusted',
        untrustedRo.sessionId,
        JSON.stringify({ session_id: untrustedRo.sessionId, binding_id: 'b-u', revision: 0, access_mode: 'read_only' }),
      );
      chanDb2.close();

      const rt2 = await createIntegratedRuntime(cfg2, { authorizedDestination: (d: string) => d === 'chat-untrusted', send: async () => 'm', update: async () => {}, sendFile: async () => {} } as any, [claudeBase, codexBase]);
      try {
        await assert.rejects(rt2.tick(), /dispatch or synchronization failed/);
        assert.equal(rt2.health().status, 'degraded');
      } finally {
        await rt2.close();
      }

      // Security check 2: writable session whose project was deleted must NOT be skipped
      const deletedWritable = join(allowedRoot, 'deleted-writable');
      mkdirSync(deletedWritable, { recursive: true });
      const writableSession: Session = {
        ...makeSession('claude', 'cl-writable-del', deletedWritable, 'Writable'),
        native: { provider: 'claude', hostId: 'h', serviceId: 'c', nativeSessionId: 'cl-writable-del' },
        control: { serviceId: 'c', owner: 'owner', input: 'available', generation: 0, operationId: null, reason: null },
      };
      const cfg3: RuntimeConfig = {
        ...cfg,
        coreDb: join(dir2, 'core3.sqlite'),
        channelDb: join(dir2, 'channel3.sqlite'),
        artifactStatePath: join(dir2, 'artifacts3.json'),
        allowedDestinations: ['chat-w'],
      };
      const s3 = new UnifiedStore(cfg3.coreDb);
      s3.insertSession(writableSession);
      s3.close();
      const c3 = new FeishuChannel({} as any, { send: async () => 'm', update: async () => {}, sendFile: async () => {} }, async () => true, cfg3.channelDb);
      c3.importMigrationBinding('m-w', {
        destination: 'chat-w',
        sessionId: writableSession.sessionId,
        bindingId: 'b-w',
        owner: { source: 'feishu', subject: 'owner' },
      });
      c3.close();
      const chanDb3 = new DatabaseSync(cfg3.channelDb);
      chanDb3.prepare("UPDATE channel_bindings SET access_mode='interactive' WHERE destination='chat-w'").run();
      chanDb3.close();
      rmSync(deletedWritable, { recursive: true, force: true });

      const rt3 = await createIntegratedRuntime(cfg3, { authorizedDestination: (d: string) => d === 'chat-w', send: async () => 'm', update: async () => {}, sendFile: async () => {} } as any, [claudeBase, codexBase]);
      try {
        await assert.rejects(rt3.tick(), /dispatch or synchronization failed/);
        assert.equal(rt3.health().status, 'degraded');
      } finally {
        await rt3.close();
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Wave1 Item 1b: ClaudeAdapter.discoverExisting skips missing/empty cwd without partialFailure and does not degrade core', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w1-claude-cwd-'));
  try {
    const project = join(dir, 'proj');
    const logs = join(dir, 'logs');
    mkdirSync(project, { recursive: true });
    mkdirSync(logs, { recursive: true });

    const sdk: any = {
      query: () => {
        throw new Error('forbidden');
      },
      getSessionMessages: async () => [],
      listSessions: async ({ offset }: { offset: number }) => {
        if (offset === 0) {
          return [
            { sessionId: 'old-no-cwd', summary: 'no cwd', lastModified: 10, createdAt: 1000 },
            { sessionId: 'old-empty-cwd', cwd: '', summary: 'empty cwd', lastModified: 11, createdAt: 1001 },
          ];
        }
        if (offset === 2) {
          return [
            { sessionId: 'valid-one', cwd: project, summary: 'valid', lastModified: 12, createdAt: 1002 },
          ];
        }
        return [];
      },
    };

    const adapter = new ClaudeAdapter('h', 'c', join(dir, 'state'), sdk);
    try {
      const p1 = await adapter.discoverExisting(null, 2);
      assert.equal(p1.items.length, 0);
      assert.equal(p1.partialFailure, undefined);
      assert.equal(p1.nextCursor, '2');

      const p2 = await adapter.discoverExisting(p1.nextCursor, 2);
      assert.equal(p2.items.length, 1);
      assert.equal(p2.items[0]?.native.nativeSessionId, 'valid-one');
      assert.equal(p2.partialFailure, undefined);
      assert.equal(p2.nextCursor, null);

      // Invalid non-string cwd still marks partialFailure: true
      sdk.listSessions = async () => [
        { sessionId: 'bad-cwd-type', cwd: 123, summary: 'bad', lastModified: 12, createdAt: 1002 },
      ];
      const pBad = await adapter.discoverExisting(null, 2);
      assert.equal(pBad.items.length, 0);
      assert.equal(pBad.partialFailure, true);
    } finally {
      await adapter.close();
    }

    // End-to-end with createIntegratedRuntime: old session without cwd must not trigger autoFailed
    const sdkAuto: any = {
      query: () => {
        throw new Error('forbidden');
      },
      getSessionMessages: async () => [],
      listSessions: async ({ offset }: { offset: number }) =>
        offset === 0
          ? [{ sessionId: 'old-no-cwd', summary: 'legacy', lastModified: 10, createdAt: 1000 }]
          : [],
    };
    const autoAdapter = new ClaudeAdapter('h', 'c', join(dir, 'state-rt'), sdkAuto);
    const cfg: RuntimeConfig = {
      coreDb: join(dir, 'core.sqlite'),
      channelDb: join(dir, 'channel.sqlite'),
      artifactStatePath: join(dir, 'artifacts.json'),
      ownerOpenId: 'owner',
      allowedDestinations: ['chat'],
      hostId: 'h',
      claudeServiceId: 'c',
      codexServiceId: 'x',
      claudeStateDir: join(dir, 'state-rt'),
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 60_000,
      catalogSources: [{ provider: 'claude', hostId: 'h', serviceId: 'c', directory: logs }],
      allowedProjectRoots: [project],
      outputRoots: [project],
      autoMirror: { enabled: true, destination: 'chat' },
    };
    const runtime = await createIntegratedRuntime(
      cfg,
      { authorizedDestination: (d: string) => d === 'chat', send: async () => 'm', update: async () => {}, sendFile: async () => {} } as any,
      [
        autoAdapter,
        makeBasePort('codex', {
          discoverRunning: async () => ({ items: [], nextCursor: null }),
          discoverExisting: async () => ({ items: [], nextCursor: null }),
          discoverNewer: async () => ({ items: [], nextCursor: null }),
        }),
      ],
    );
    try {
      await runtime.tick();
      assert.equal(runtime.health().status, 'healthy');
      assert.equal((await runtime.core.health()).find((r) => r.component === 'core')?.status, 'healthy');
    } finally {
      await runtime.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Wave1 Item 2: /new -> create inside bound topic routes to parent chatDestination and falls back cleanly on mock port without chatDestination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w1-topic-create-'));
  try {
    // Part A: real FeishuSdkPort implements chatDestination and routes /new->create from bound topic to parent chat
    const sdkPort = new FeishuSdkPort({ appId: 'app', appSecret: 'sec' }, join(dir, 'sdk.sqlite'), new Set(['chat-main']), 'owner');
    let msgSeq = 0;
    const topicRoots: string[] = [];
    (sdkPort as any).client = {
      im: {
        message: {
          create: async ({ data }: any) => {
            const id = `root_${++msgSeq}`;
            topicRoots.push(id);
            return { code: 0, data: { message_id: id, thread_id: `th_${msgSeq}`, content: data.content } };
          },
          reply: async () => ({ code: 0, data: { message_id: `reply_${++msgSeq}` } }),
          patch: async () => ({ code: 0 }),
          get: async () => ({ code: 0, data: { items: [] } }),
        },
        file: { create: async () => ({ file_key: 'fk' }) },
      },
    };

    const project = join(dir, 'proj');
    mkdirSync(project, { recursive: true });
    const store = new UnifiedStore(join(dir, 'core.sqlite'));
    const s1 = makeSession('codex', 'existing-1', project, 'Existing Session');
    store.insertSession(s1);
    let createdCount = 0;
    const codexMock = makeBasePort('codex', {
      list: async () => ({ items: [s1], nextCursor: null }),
      read: async (ref) => ({
        session: makeSession('codex', ref.nativeSessionId, project, `Session ${ref.nativeSessionId}`),
        messages: [],
        interactions: [],
      }),
      create: async (cwd) => {
        const nid = `created-${++createdCount}`;
        return {
          status: 'submitted',
          nativeReference: nid,
          createdSession: makeSession('codex', nid, cwd, `Created ${nid}`),
          connectionGeneration: 1,
        };
      },
    });
    const core = new UnifiedCore(store, [codexMock], () => true, () => true, () => false, () => true);
    const channel = new FeishuChannel(
      core,
      sdkPort,
      async (i, d) => i.subject === 'owner' && sdkPort.authorizedDestination(d),
      join(dir, 'channel.sqlite'),
    );

    try {
      assert.equal(sdkPort.isTopicDestination('chat-main'), false);
      assert.equal(sdkPort.chatDestination('chat-main'), null);

      const bindRes = (await channel.handle(
        { eventId: 'bind-s1', destination: 'chat-main', identity: { source: 'feishu', subject: 'owner' } },
        { action: 'bind', sessionId: s1.sessionId },
      )) as { destination: string };
      const topic1 = bindRes.destination;
      assert.equal(sdkPort.isTopicDestination(topic1), true);
      assert.equal(sdkPort.chatDestination(topic1), 'chat-main');

      // Trigger /new -> create inside already-bound topic1
      const op = (await channel.handle(
        { eventId: 'create-in-topic1', destination: topic1, identity: { source: 'feishu', subject: 'owner' } },
        { action: 'create', provider: 'codex', project, model: null },
      )) as { operationId: string };
      await core.dispatchPending();
      await channel.advanceCompleted();

      const bindings = channel.bindingsForRestore();
      assert.equal(bindings.length, 2, 'must keep topic1 bound to s1 and bind new topic2 to created session');
      const b1 = bindings.find((b) => b.destination === topic1);
      const b2 = bindings.find((b) => b.destination !== topic1);
      assert.equal(b1?.sessionId, s1.sessionId);
      assert.ok(b2 && b2.destination.startsWith('topic:'));
      assert.equal(b2.accessMode, 'interactive');
      assert.notEqual(b2.sessionId, s1.sessionId);
      assert.equal(sdkPort.chatDestination(b2.destination), 'chat-main');

      // Also verify manual finish tapped inside topic1 works if pending is in parent chat
      const op2 = (await channel.handle(
        { eventId: 'create-in-topic1-manual', destination: topic1, identity: { source: 'feishu', subject: 'owner' } },
        { action: 'create', provider: 'codex', project, model: null },
      )) as { operationId: string };
      await core.dispatchPending();
      const finishRes = (await channel.handle(
        { eventId: 'manual-finish', destination: topic1, identity: { source: 'feishu', subject: 'owner' } },
        { action: 'finish', operationId: op2.operationId },
      )) as { destination: string; accessMode: string; sessionId: string };
      assert.notEqual(finishRes.destination, topic1);
      assert.equal(finishRes.accessMode, 'interactive');
      assert.equal(channel.bindingsForRestore().length, 3);
    } finally {
      channel.close();
      core.close();
      store.close();
      sdkPort.close();
    }

    // Part B: mock port with isTopicDestination=true and NO chatDestination returns friendly card instead of creating orphan session
    const sentMock: any[] = [];
    let createCalls = 0;
    const mockPort: FeishuPort = {
      isTopicDestination: (d) => d.startsWith('topic:'),
      send: async (_d, c) => {
        sentMock.push(c);
        return `m-${sentMock.length}`;
      },
      update: async () => {},
      sendFile: async () => {},
    };
    const mockService: any = {
      createSession: async () => {
        createCalls++;
        return { operationId: 'op-x', action: 'createSession', status: 'received', revision: 0, error: null };
      },
    };
    const mockChan = new FeishuChannel(mockService, mockPort, async () => true, join(dir, 'mock-chan.sqlite'));
    try {
      mockChan.importMigrationBinding('m-topic', {
        destination: 'topic:abc',
        sessionId: 's-existing',
        bindingId: 'b-abc',
        owner: { source: 'feishu', subject: 'owner' },
      });
      const res = await mockChan.handle(
        { eventId: 'create-no-chatdest', destination: 'topic:abc', identity: { source: 'feishu', subject: 'owner' } },
        { action: 'create', provider: 'codex', project, model: null },
      );
      assert.deepEqual(res, { status: 'guidance' });
      assert.equal(createCalls, 0, 'must not create orphan session when chatDestination is unavailable');
      const card = sentMock.at(-1);
      assert.match(card.text, /主群.*\/new|\/new/);
    } finally {
      mockChan.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Wave1 Item 3 & Item 4: /ls renders Linux tree format with human sizes and empty /file shows /ls hint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w1-ls-file-'));
  try {
    const project = join(dir, 'project');
    const archiveDir = join(project, 'archive');
    const srcDir = join(project, 'src');
    mkdirSync(archiveDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), 'A'.repeat(5799), 'utf8');
    writeFileSync(join(project, 'README.md'), 'R'.repeat(7065), 'utf8');
    writeFileSync(join(project, 'big.txt'), 'B'.repeat(15360), 'utf8');
    writeFileSync(join(project, 'tiny.txt'), 'hi', 'utf8');
    writeFileSync(join(project, '.hidden-note'), 'secret', 'utf8');

    const ref = { provider: 'codex' as const, hostId: 'h', serviceId: 's', nativeSessionId: 'n-ls' };
    const session = {
      ...makeSession('codex', 'n-ls', project, 'Tree Session', { readOnly: true, sessionId: 's-ls' }),
      native: ref,
    };
    const base = makeBasePort('codex', {
      list: async () => ({ items: [session], nextCursor: null }),
      read: async () => ({ session, messages: [], interactions: [] }),
      listArtifacts: async () => [],
    });
    const registry = new ArtifactRegistry({});
    registry.setProjectRoot(ref, project);
    const enriched = new EnrichedPort(base, new LocalCatalog([]), registry, () => {});
    const store = new UnifiedStore(join(dir, 'core.sqlite'));
    store.insertSession(session);
    const core = new UnifiedCore(store, [enriched], () => true);

    const cards: any[] = [];
    const port: FeishuPort = {
      send: async (_d, c) => {
        cards.push(c);
        return `m-${cards.length}`;
      },
      update: async () => {},
      sendFile: async () => {},
    };
    const channel = new FeishuChannel(core, port, async () => true, join(dir, 'chan.sqlite'));

    try {
      await channel.handle({ eventId: 'bind', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'bind', sessionId: 's-ls' });

      // Item 3: /ls tree format
      await channel.handle({ eventId: 'ls-root', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, parseFeishuText('/ls'));
      const lsText = cards.at(-1).text as string;
      const lines = lsText.split('\n');
      assert.equal(lines[0], `📁 ${project}`);
      assert.equal(lines[1], '├── archive/');
      assert.equal(lines[2], '├── src/');
      assert.equal(lines[3], '├── AGENTS.md (5.7 KB)');
      assert.equal(lines[4], '├── big.txt (15 KB)');
      assert.equal(lines[5], '├── README.md (6.9 KB)');
      assert.equal(lines[6], '└── tiny.txt (2 B)');
      assert.equal(lines[7], '显示 6/6 项，隐藏 1 项');
      assert.doesNotMatch(lsText, /\[目录\]|\[文件\]/);

      // Empty subdir shows (空目录)
      await channel.handle({ eventId: 'ls-empty', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, parseFeishuText('/ls archive'));
      assert.equal(cards.at(-1).text, `📁 ${archiveDir}\n(空目录)\n显示 0/0 项，隐藏 0 项`);

      // Single file shows human size
      await channel.handle({ eventId: 'ls-file', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, parseFeishuText('/ls AGENTS.md'));
      assert.equal(cards.at(-1).text, 'AGENTS.md (5.7 KB)');

      // Item 4: Empty /file helpful hint
      await channel.handle({ eventId: 'empty-file', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'artifacts' });
      const fileCard = cards.at(-1);
      assert.equal(
        fileCard.text,
        `默认目录：${project}\n\n暂无可下载文件。\n提示：如需浏览项目目录，可发送 /ls 或 /ls <子目录>。`,
      );
    } finally {
      channel.close();
      core.close();
      store.close();
      await enriched.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Wave1 Item 5: AgyAdapter updates generic title from first user prompt and emits session observation into UnifiedCore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w1-agy-title-'));
  try {
    const project = join(dir, 'proj');
    const brainDir = join(dir, 'brain');
    const dbPath = join(dir, 'summaries.db');
    mkdirSync(project, { recursive: true });
    mkdirSync(brainDir, { recursive: true });

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT "",
        preview TEXT NOT NULL DEFAULT "",
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT "",
        source TEXT NOT NULL DEFAULT "",
        project_id TEXT NOT NULL DEFAULT "",
        agent_name TEXT NOT NULL DEFAULT "",
        parent_conversation_id TEXT NOT NULL DEFAULT "",
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        battle_id TEXT NOT NULL DEFAULT "",
        winning_conversation_id TEXT NOT NULL DEFAULT "",
        not_fully_idle numeric NOT NULL DEFAULT false,
        killed numeric NOT NULL DEFAULT false,
        last_user_input_time datetime NOT NULL,
        last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
        app_data_dir TEXT NOT NULL DEFAULT "",
        raw_summary BLOB,
        group_id TEXT NOT NULL DEFAULT ""
      );
    `);
    db.close();

    const uuid1 = 'deadbeef-1234-5678-90ab-cdef12345678';
    const uuid2 = 'cafebabe-1234-5678-90ab-cdef12345678';
    let createSeq = 0;
    const fakeTransport = {
      connected: true,
      connectionGeneration: 1,
      onNotification: () => {},
      onServerRequest: () => {},
      onDisconnect: () => {},
      seedGeneration: () => {},
      close: async () => {},
      request: async (method: string) => {
        if (method === 'session/new') {
          const sessionId = ++createSeq === 1 ? uuid1 : uuid2;
          return { sessionId, models: { availableModels: [] }, configOptions: [] };
        }
        if (method === 'session/prompt') {
          return { stopReason: 'end_turn' };
        }
        return {};
      },
      respondServerRequest: () => {},
    } as unknown as AgyAcpTransport;

    const catalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [project] });
    const adapter = new AgyAdapter(fakeTransport, catalog, 'h', 'agy-svc');
    const observations: PlatformObservation[] = [];
    adapter.onObservation((o) => observations.push(o));

    const store = new UnifiedStore(join(dir, 'core.sqlite'));
    const core = new UnifiedCore(store, [adapter], () => true, () => true);

    try {
      // 1. Short multi-line prompt -> title from first non-empty line, persisted in UnifiedCore, second prompt does NOT overwrite
      const createOp = await core.createSession({
        context: {
          operationId: 'op-c1',
          idempotencyKey: 'op-c1',
          targetId: 'new:chat',
          expectedRevision: 0,
          controlGeneration: 0,
          identity: { source: 'feishu', subject: 'owner' },
        },
        payload: { provider: 'agy', project, model: null },
      });
      await core.dispatch(createOp.operationId);
      const doneCreate = await core.getOperation(createOp.operationId);
      assert.equal(doneCreate.result?.kind, 'session');
      const sid1 = doneCreate.result.kind === 'session' ? doneCreate.result.sessionId : '';
      assert.equal((await core.getSession(sid1)).title, 'Antigravity 会话 · deadbeef');

      const sBefore = await core.getSession(sid1);
      const inputOp1 = await core.submitInput({
        context: {
          operationId: 'op-in1',
          idempotencyKey: 'op-in1',
          targetId: sid1,
          expectedRevision: sBefore.revision,
          controlGeneration: sBefore.control.generation,
          identity: { source: 'feishu', subject: 'owner' },
        },
        mode: 'new',
        blocks: [{ type: 'text', text: '  Fix   core\n\thealth   degraded bug  ' }],
      });
      await core.dispatch(inputOp1.operationId);
      await new Promise((r) => setImmediate(r));

      const sessionObs = observations.filter(
        (o): o is Extract<PlatformObservation, { type: 'session' }> =>
          o.type === 'session' && o.ref.nativeSessionId === uuid1,
      );
      assert.equal(sessionObs.length, 1);
      assert.equal(sessionObs[0]?.session.title, 'Fix core');
      assert.equal((await core.getSession(sid1)).title, 'Fix core');
      assert.equal((await adapter.read(sBefore.native)).session.title, 'Fix core');

      // Wait for prompt completion then send a second prompt -> title must stay unchanged
      await new Promise((r) => setTimeout(r, 20));
      const sAfter1 = await core.getSession(sid1);
      const inputOp2 = await core.submitInput({
        context: {
          operationId: 'op-in2',
          idempotencyKey: 'op-in2',
          targetId: sid1,
          expectedRevision: sAfter1.revision,
          controlGeneration: sAfter1.control.generation,
          identity: { source: 'feishu', subject: 'owner' },
        },
        mode: 'new',
        blocks: [{ type: 'text', text: 'Second prompt should not overwrite title' }],
      });
      await core.dispatch(inputOp2.operationId);
      await new Promise((r) => setImmediate(r));
      assert.equal((await core.getSession(sid1)).title, 'Fix core');

      // 2. Long prompt (>48 chars) -> truncated to <= 48 chars
      const ack2 = await adapter.create(project, null);
      const ref2 = ack2.createdSession!.native;
      assert.equal(ack2.createdSession?.title, 'Antigravity 会话 · cafebabe');
      const guard2: DispatchGuard = {
        expectedControlGeneration: 0,
        expectedConnectionGeneration: 1,
        assertCurrent: () => {},
      };
      const longText = 'This is a very long first prompt that exceeds forty eight characters in length for testing';
      await adapter.input(
        ref2,
        'new',
        [
          { type: 'artifact', artifactId: 'a1', contentVersion: 'v1', name: 'note.txt', mediaType: 'text/plain', content: Buffer.from('attachment content') },
          { type: 'text', text: longText },
        ],
        guard2,
      );
      const snap2 = await adapter.read(ref2);
      assert.ok([...snap2.session.title].length <= 48, `expected <=48 chars, got ${[...snap2.session.title].length}`);
      assert.ok(snap2.session.title.endsWith('…'));
      assert.ok(snap2.session.title.startsWith('This is a very long first prompt'));

      // 3. Existing session with a real catalog title is preserved on resume + input
      const realId = '11112222-3333-4444-5555-666677778888';
      const dbWrite = new DatabaseSync(dbPath);
      dbWrite.prepare(
        `INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, last_user_input_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(realId, 'Existing Named Session', 'preview', 2, '2026-11-22T01:00:00.000Z', JSON.stringify([pathToFileURL(project).href]), 'CASCADE_RUN_STATUS_IDLE', '2026-11-22T01:00:00.000Z');
      dbWrite.close();
      const realRef = { provider: 'agy' as const, hostId: 'h', serviceId: 'agy-svc', nativeSessionId: realId };
      await adapter.resume(realRef);
      await adapter.input(realRef, 'new', [{ type: 'text', text: 'New prompt must not replace existing real title' }], guard2);
      assert.equal((await adapter.read(realRef)).session.title, 'Existing Named Session');
      const rename = (title: string) => fakeTransport.onNotification?.({
        generation: 1, method: 'session/update',
        params: {sessionId: realId, update: {sessionUpdate: 'session_info_update', title}},
      });
      rename('原生改名');
      assert.ok(observations.some(o => o.type === 'session' && o.session.title === '原生改名'));
      rename('Antigravity 会话 · 11112222');
      assert.equal((await adapter.read(realRef)).session.title, '原生改名');
    } finally {
      core.close();
      store.close();
      await adapter.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
