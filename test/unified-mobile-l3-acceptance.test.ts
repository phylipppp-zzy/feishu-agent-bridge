import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { UnifiedCore } from '../src/unified/service.js';
import { UnifiedStore } from '../src/unified/store.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';
import { FeishuSdkPort, receiveSdkMessage } from '../src/unified/feishu-sdk-port.js';
import { parseFeishuAction, parseFeishuText } from '../src/unified/feishu-codec.js';
import { createMockAdapter } from '../src/unified/mock-adapter.js';
import { AgyCatalog, readAgySummaries } from '../src/unified/agy-catalog.js';
import { createIntegratedRuntime, validateRuntimeConfig, type RuntimeConfig } from '../src/unified/runtime.js';
import { payloadDigest, type Capabilities, type Provider, type Session } from '../src/unified/contracts.js';
import type { PlatformPort } from '../src/unified/adapter.js';

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
  updatedAt?: string,
): Session {
  return {
    sessionId: `raw-${nativeSessionId}`,
    native: { provider, hostId: 'h', serviceId: provider, nativeSessionId },
    project,
    title,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    status: 'idle',
    revision: 0,
    capabilities: fullCaps,
    control: { serviceId: provider, owner: null, input: 'unavailable', generation: 0, operationId: null, reason: null },
  };
}

function createSummaryDb(dbPath: string, rows: Array<Record<string, unknown>>): void {
  const db = new DatabaseSync(dbPath);
  try {
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
    const insert = db.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, source, project_id, agent_name,
        parent_conversation_id, nesting_depth, battle_id, winning_conversation_id,
        not_fully_idle, killed, last_user_input_time, last_user_input_step_index,
        app_data_dir, raw_summary, group_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      insert.run(
        String(r.conversation_id),
        String(r.title ?? ''),
        String(r.preview ?? ''),
        Number(r.step_count ?? 1),
        String(r.last_modified_time ?? '2026-11-22 10:00:00+00:00'),
        String(r.workspace_uris ?? '[]'),
        String(r.status ?? 'CASCADE_RUN_STATUS_IDLE'),
        'CORTEX_TRAJECTORY_SOURCE_CLI',
        '',
        String(r.agent_name ?? ''),
        String(r.parent_conversation_id ?? ''),
        Number(r.nesting_depth ?? 0),
        '',
        '',
        0,
        0,
        String(r.last_user_input_time ?? '2026-11-22 10:00:00+00:00'),
        0,
        'antigravity',
        null,
        '',
      );
    }
  } finally {
    db.close();
  }
}

test('listSessions orders by updatedAt descending with missing/invalid last, and FeishuChannel shows agy filters via hasProvider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-list-order-'));
  try {
    const store = new UnifiedStore(join(dir, 'core.sqlite'));
    const sOld = makeSession('codex', 'old', '/p', 'Old Session', '2026-11-20T10:00:00.000Z');
    const sNew = makeSession('claude', 'new', '/p', 'New Session', '2026-11-22T12:00:00.000Z');
    const sMidA = makeSession('codex', 'mid-a', '/p', 'Mid A', '2026-11-21T08:00:00.000Z');
    const sMidB = makeSession('claude', 'mid-b', '/p', 'Mid B', '2026-11-21T08:00:00.000Z');
    const sMissing = makeSession('codex', 'missing', '/p', 'Missing Time');
    const sInvalid = makeSession('claude', 'invalid', '/p', 'Invalid Time', 'not-a-timestamp');

    const codexPort = {
      provider: 'codex',
      onObservation: () => () => {},
      list: async () => ({ items: [sOld, sMidA, sMissing], nextCursor: null }),
    } as unknown as PlatformPort;
    const claudePort = {
      provider: 'claude',
      onObservation: () => () => {},
      list: async () => ({ items: [sInvalid, sMidB, sNew], nextCursor: null }),
    } as unknown as PlatformPort;
    const agyEmptyPort = {
      provider: 'agy',
      onObservation: () => () => {},
      list: async () => ({ items: [], nextCursor: null }),
    } as unknown as PlatformPort;

    const core = new UnifiedCore(store, [codexPort, claudePort, agyEmptyPort], () => true, () => true, () => false, () => true);
    assert.equal(core.hasProvider('agy'), true);
    assert.equal(core.hasProvider('codex'), true);

    const listed = await core.listSessions({ limit: 10 });
    const tieOrder = [sMidA, sMidB].sort((a, b) => payloadDigest(a.native).localeCompare(payloadDigest(b.native)));
    const lastOrder = [sMissing, sInvalid].sort((a, b) => payloadDigest(a.native).localeCompare(payloadDigest(b.native)));
    assert.deepEqual(
      listed.items.map((s) => s.title),
      ['New Session', tieOrder[0]!.title, tieOrder[1]!.title, 'Old Session', lastOrder[0]!.title, lastOrder[1]!.title],
    );

    const cards: any[] = [];
    const port: FeishuPort = {
      send: async (_d, c) => {
        cards.push(c);
        return 'm';
      },
      update: async () => {},
      sendFile: async () => {},
    };
    const channel = new FeishuChannel(core, port, async () => true, join(dir, 'channel.sqlite'));
    await channel.handle({ eventId: 'list-1', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'list' });
    const listCard = cards.at(-1);
    assert.ok(listCard.actions.some((a: any) => a.label === '全部'));
    assert.ok(listCard.actions.some((a: any) => a.label === 'Antigravity'));

    // Also verify createMockAdapter proxy does not reject or mistakenly report agy filter buttons
    const mockChannel = new FeishuChannel(createMockAdapter('codex'), port, async () => true, join(dir, 'mock-channel.sqlite'));
    await mockChannel.handle({ eventId: 'list-mock', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'list' });
    const mockCard = cards.at(-1);
    assert.equal(mockCard.actions.some((a: any) => a.label === 'Antigravity'), false);

    mockChannel.close();
    channel.close();
    core.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codec supports /sessions <search>, /file alias, and create callback without bindingId', () => {
  assert.deepEqual(parseFeishuText('/sessions'), { action: 'list' });
  assert.deepEqual(parseFeishuText('/sessions   agy fix '), { action: 'list', search: 'agy fix' });
  assert.deepEqual(parseFeishuText('/file'), { action: 'artifacts' });
  assert.deepEqual(parseFeishuText('/files'), { action: 'artifacts' });

  assert.deepEqual(parseFeishuAction({ action: 'create', provider: 'agy', project: '/work/proj', model: null }), {
    action: 'create',
    provider: 'agy',
    project: '/work/proj',
    model: null,
  });
  assert.deepEqual(parseFeishuAction({ action: 'create', provider: 'codex', project: '/work/proj', model: 'gpt-5' }), {
    action: 'create',
    provider: 'codex',
    project: '/work/proj',
    model: 'gpt-5',
  });
  assert.throws(() => parseFeishuAction({ action: 'create', provider: 'agy', project: '', model: null }), /invalid/);
  assert.throws(() => parseFeishuAction({ action: 'create', provider: 'other', project: '/work', model: null }), /invalid/);
  assert.throws(() => parseFeishuAction({ action: 'create', provider: 'agy', project: '/work', model: 123 }), /invalid/);
});

test('private owner group drops @bot requirement for main slash commands and known topics while ignoring noise safely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-no-at-'));
  try {
    const sdk = new FeishuSdkPort({ appId: 'app', appSecret: 'sec' }, join(dir, 'sdk.sqlite'), new Set(['chat-main']), 'owner');
    const createdGuides: any[] = [];
    let handles: any;
    (sdk as any).client = {
      request: async () => ({ bot: { open_id: 'bot' } }),
      im: {
        message: {
          create: async (req: any) => {
            createdGuides.push(req);
            return { code: 0, data: { message_id: `m-${createdGuides.length}` } };
          },
          reply: async () => ({ code: 0, data: { message_id: 'r' } }),
        },
        messageResource: {
          get: async () => ({ getReadableStream: () => Readable.from([Buffer.from('89504e470d0a1a0a0000', 'hex')]) }),
        },
      },
    };
    (sdk as any).ws = {
      start: async ({ eventDispatcher }: any) => {
        handles = eventDispatcher.handles;
      },
      close() {},
    };

    const db = new DatabaseSync(join(dir, 'sdk.sqlite'));
    db.prepare('INSERT INTO sdk_topic_routes VALUES (?,?,?,?,?)').run('topic:known', 'chat-main', 'root-known', 'thread-known', 's1');
    db.close();

    const received: Array<{ destination: string; action: any }> = [];
    const record = (e: { destination: string }, a: unknown) => {
      received.push({ destination: e.destination, action: a });
    };
    await sdk.start(
      async (e, a) => {
        record(e, a);
      },
      async () => 'scope-1',
    );
    const onMsg = handles.get('im.message.receive_v1');

    const mkGroupMsg = (
      id: string,
      opts: {
        sender?: string;
        chat?: string;
        type?: string;
        content?: unknown;
        rootId?: string;
        parentId?: string;
        threadId?: string;
        mentionBot?: boolean;
      },
    ): any => ({
      sender: { sender_type: 'user', sender_id: { open_id: opts.sender ?? 'owner' } },
      message: {
        message_id: id,
        chat_id: opts.chat ?? 'chat-main',
        chat_type: 'group',
        message_type: opts.type ?? 'text',
        content: JSON.stringify(opts.content ?? { text: '' }),
        ...(opts.rootId ? { root_id: opts.rootId } : {}),
        ...(opts.parentId ? { parent_id: opts.parentId } : {}),
        ...(opts.threadId ? { thread_id: opts.threadId } : {}),
        ...(opts.mentionBot ? { mentions: [{ key: '@_user_1', id: { open_id: 'bot' } }] } : {}),
      },
    });

    // 1. Unmentioned owner main-group slash commands work
    await onMsg(mkGroupMsg('m1', { content: { text: '/sessions agy' } }));
    await onMsg(mkGroupMsg('m2', { content: { text: '/new' } }));
    assert.deepEqual(received, [
      { destination: 'chat-main', action: { action: 'list', search: 'agy' } },
      { destination: 'chat-main', action: { action: 'new_help' } },
    ]);

    // 2. Unmentioned owner main-group ordinary text or image is silently ignored
    await onMsg(mkGroupMsg('m3', { content: { text: 'just chatting in group' } }));
    await onMsg(mkGroupMsg('m4', { type: 'image', content: { image_key: 'img-main' } }));
    assert.equal(received.length, 2);

    // 3. Unmentioned owner messages inside known bot topic (text, slash, image) succeed
    await onMsg(mkGroupMsg('m5', { rootId: 'root-known', content: { text: 'continue please' } }));
    await onMsg(mkGroupMsg('m6', { threadId: 'thread-known', content: { text: '/file' } }));
    await onMsg(mkGroupMsg('m7', { rootId: 'root-known', type: 'image', content: { image_key: 'img-topic' } }));
    assert.equal(received[2]?.destination, 'topic:known');
    assert.deepEqual(received[2]?.action, { action: 'input', text: 'continue please', mode: 'new' });
    assert.equal(received[3]?.destination, 'topic:known');
    assert.deepEqual(received[3]?.action, { action: 'artifacts' });
    await sdk.drainInbound(async (e, a) => {
      record(e, a);
    });
    assert.equal(received[4]?.destination, 'topic:known');
    assert.equal(received[4]?.action.action, 'attachment');

    // 4. Unmentioned unrelated thread in group silently ignored (no UnknownTopic throw or guidance spam)
    await onMsg(mkGroupMsg('m8', { rootId: 'unrelated-thread', content: { text: 'random thread reply' } }));
    assert.equal(received.length, 5);
    assert.equal(createdGuides.length, 0);

    // 5. Unmentioned non-owner or outside chat silently ignored (no unauthorized throw)
    await onMsg(mkGroupMsg('m9', { sender: 'other-user', content: { text: '/sessions' } }));
    await onMsg(mkGroupMsg('m10', { chat: 'other-chat', content: { text: '/sessions' } }));
    assert.equal(received.length, 5);

    // 6. Mentioned bot preserves existing strict errors (unauthorized & UnknownTopic)
    await assert.rejects(
      onMsg(mkGroupMsg('m11', { sender: 'other-user', mentionBot: true, content: { text: '@_user_1 /sessions' } })),
      /unauthorized/,
    );
    await assert.rejects(
      onMsg(mkGroupMsg('m12', { rootId: 'unrelated-thread', mentionBot: true, content: { text: '@_user_1 hi' } })),
      /unknown topic/,
    );

    // 7. Pending task creation guards unmentioned main-group writes without spamming ordinary non-slash chat
    const db2 = new DatabaseSync(join(dir, 'sdk.sqlite'));
    db2.prepare("INSERT INTO sdk_task_creations_v1 VALUES ('op-pending','chat-main','unknown',NULL,NULL,'d','del')").run();
    db2.close();
    const beforeCount = received.length;
    await onMsg(mkGroupMsg('m13', { content: { text: 'ordinary chat while pending' } }));
    assert.equal(createdGuides.length, 0);
    await onMsg(mkGroupMsg('m14', { content: { text: '/sessions' } }));
    assert.equal(received.length, beforeCount + 1);
    assert.equal(createdGuides.length, 0);
    await onMsg(mkGroupMsg('m15', { content: { text: '/create claude /work' } }));
    assert.equal(received.length, beforeCount + 1);
    assert.equal(createdGuides.length, 1);
    assert.match(createdGuides[0].data.content, /任务话题待核查/);

    // Also test direct receiveSdkMessage with mentionedBot=false
    const directOut: any[] = [];
    await receiveSdkMessage(
      mkGroupMsg('m16', { content: { text: 'ignored direct' } }),
      'bot',
      'owner',
      new Set(['chat-main']),
      async () => Readable.from([]),
      async (_e, a) => {
        directOut.push(a);
      },
    );
    assert.equal(directOut.length, 0);

    sdk.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/health renders grouped Chinese Beijing-time sections and omits empty groups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-health-'));
  try {
    const cards: any[] = [];
    const port: FeishuPort = {
      send: async (_d, c) => {
        cards.push(c);
        return 'm';
      },
      update: async () => {},
      sendFile: async () => {},
    };
    let rows: any[] = [
      {
        component: 'core',
        status: 'degraded',
        reason: 'dispatch or synchronization failed; inspect persisted state before retry',
        backlog: 2,
        unknown: 1,
        lastObservedAt: '2026-11-22T12:42:00.000Z',
        lastSuccessAt: '2026-11-22T12:41:00.000Z',
        lastFailureAt: '2026-11-22T12:42:00.000Z',
        lastDeliveryAt: null,
        updatedAt: '2026-11-22T12:42:00.000Z',
      },
      {
        component: 'codex_connection',
        status: 'unreachable',
        reason: 'connection closed',
        backlog: 0,
        unknown: 0,
        lastObservedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDeliveryAt: null,
        updatedAt: null,
      },
      {
        component: 'feishu_delivery',
        status: 'healthy',
        reason: null,
        backlog: 0,
        unknown: 0,
        lastObservedAt: '2026-11-22T12:45:00.000Z',
        lastSuccessAt: '2026-11-22T12:41:00.000Z',
        lastFailureAt: null,
        lastDeliveryAt: '2026-11-22T12:41:00.000Z',
        updatedAt: '2026-11-22T12:45:00.000Z',
      },
      {
        component: 'feishu_callback',
        status: 'healthy',
        reason: null,
        backlog: 0,
        unknown: 0,
        lastObservedAt: '2026-11-22T12:46:00.000Z',
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDeliveryAt: null,
        updatedAt: '2026-11-22T12:46:00.000Z',
      },
      {
        component: 'codex_run',
        status: 'unverified',
        reason: '尚无可验证观测',
        backlog: null,
        unknown: null,
        lastObservedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDeliveryAt: null,
        updatedAt: null,
      },
      {
        component: 'agy_run',
        status: 'unverified',
        reason: '尚无可验证观测',
        backlog: null,
        unknown: null,
        lastObservedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDeliveryAt: null,
        updatedAt: null,
      },
    ];
    const service = { health: async () => rows } as any;
    const channel = new FeishuChannel(service, port, async () => true, join(dir, 'channel.sqlite'));
    await channel.handle({ eventId: 'h1', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'health' });
    const text1 = cards.at(-1).text as string;
    assert.match(text1, /【需关注】/);
    assert.match(text1, /- 核心：异常或待核对（存在同步或调度异常，请检查本机状态）；最近成功 11-22 20:41；最近失败 11-22 20:42；待核对 1；积压 2/);
    assert.match(text1, /- Codex连接：不可连接（连接曾断开）/);
    assert.doesNotMatch(text1, /积压 0|待核对 0/);
    assert.match(text1, /【正常】/);
    assert.match(text1, /- 飞书投递：正常（最近成功 11-22 20:41）/);
    assert.match(text1, /- 飞书回调与入站：正常（最近观测 11-22 20:46）/);
    assert.match(text1, /【尚未触发】\nCodex运行、Antigravity运行/);

    // Only healthy -> omit 【需关注】 and 【尚未触发】
    rows = [rows[2]!];
    await channel.handle({ eventId: 'h2', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'health' });
    const text2 = cards.at(-1).text as string;
    assert.match(text2, /【正常】/);
    assert.doesNotMatch(text2, /【需关注】|【尚未触发】/);
    channel.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime gracefully skips missing read_only archived project dirs while keeping strict realpathSync for new/writable sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-missing-ro-'));
  try {
    const project = join(dir, 'proj');
    const missingProj = join(project, 'archived-m4');
    const logs = join(dir, 'logs');
    mkdirSync(project, { recursive: true });
    mkdirSync(missingProj, { recursive: true });
    mkdirSync(logs, { recursive: true });

    const cfg: RuntimeConfig = {
      coreDb: join(dir, 'core.sqlite'),
      channelDb: join(dir, 'channel.sqlite'),
      artifactStatePath: join(dir, 'artifacts.json'),
      ownerOpenId: 'owner',
      allowedDestinations: ['chat'],
      hostId: 'h',
      claudeServiceId: 'c',
      codexServiceId: 'x',
      claudeStateDir: join(dir, 'claude-state'),
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 60_000,
      catalogSources: [{ provider: 'codex', hostId: 'h', serviceId: 'x', directory: logs }],
      allowedProjectRoots: [project],
      outputRoots: [project],
    };

    const seedStore = new UnifiedStore(cfg.coreDb);
    seedStore.insertSession({
      sessionId: 'migration:archived1',
      native: { provider: 'codex', hostId: 'h', serviceId: 'x', nativeSessionId: 'm4-1' },
      project: missingProj,
      title: 'Archived M4 Session',
      status: 'read_only',
      revision: 0,
      capabilities: readonlyCaps,
      control: { serviceId: 'x', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: 'migration' },
    });
    seedStore.close();

    // Remove the archived project directory from disk before runtime startup
    rmSync(missingProj, { recursive: true, force: true });

    const cards: any[] = [];
    const port: FeishuPort = {
      send: async (_d, c) => {
        cards.push(c);
        return 'm';
      },
      update: async () => {},
      sendFile: async () => {},
    };
    const base: PlatformPort = {
      provider: 'codex',
      onObservation: () => () => {},
      list: async () => ({ items: [], nextCursor: null }),
      read: async () => {
        throw new Error('must not read missing archived dir');
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
      listArtifacts: async () => [],
      readArtifact: async () => new Uint8Array(),
      listModels: async () => [],
      updateSettings: async () => ({ status: 'submitted', nativeReference: null }),
      control: async () => ({ status: 'submitted', nativeReference: null }),
    };

    const runtime = await createIntegratedRuntime(cfg, port, [base]);
    try {
      await runtime.tick();
      assert.equal(runtime.health().status, 'healthy');
      const healthRows = await runtime.core.health();
      assert.equal(healthRows.find((r) => r.component === 'core')?.status, 'healthy');

      // Test /new direct create buttons wired via allowedProjectRoots[0]
      await runtime.handleTrusted({ eventId: 'ev-new', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'new_help' });
      await runtime.tick();
      const newCard = cards.at(-1);
      assert.equal(newCard.title, '新建会话');
      assert.deepEqual(
        newCard.actions.map((a: any) => a.label),
        ['新建 Antigravity', '新建 Codex', '新建 Claude'],
      );
      assert.deepEqual(newCard.actions[1].value, { action: 'create', provider: 'codex', project, model: null });

      // Creating in a non-existent dir still fails strict realpathSync validation
      await runtime.core.createSession({
        context: {
          operationId: 'op-missing-create',
          idempotencyKey: 'op-missing-create',
          targetId: 'new:chat',
          expectedRevision: 0,
          controlGeneration: 0,
          identity: { source: 'feishu', subject: 'owner' },
        },
        payload: { provider: 'codex', project: missingProj, model: null },
      });
      const op = await runtime.core.dispatch('op-missing-create');
      assert.equal(op.status, 'unknown');
    } finally {
      await runtime.close();
    }

    // Channel without defaultCreateProject returns empty actions for /new
    const barePort: FeishuPort = { send: async (_d, c) => { cards.push(c); return 'm'; }, update: async () => {}, sendFile: async () => {} };
    const bareChannel = new FeishuChannel({} as any, barePort, async () => true, join(dir, 'bare.sqlite'));
    await bareChannel.handle({ eventId: 'bare-new', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'new_help' });
    assert.deepEqual(cards.at(-1).actions, []);
    bareChannel.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agy-catalog falls back to bounded 16 KiB transcript <USER_REQUEST> when title and preview are empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-agy-title-'));
  try {
    const proj = join(dir, 'proj');
    const brainDir = join(dir, 'brain');
    const dbPath = join(dir, 'summaries.db');
    mkdirSync(proj, { recursive: true });
    mkdirSync(brainDir, { recursive: true });

    const idWithin = 'conv-within-16k';
    const idBeyond = 'conv-beyond-16k';
    const idSymlink = 'conv-symlink';
    const idHasTitle = 'conv-has-title';

    const logsWithin = join(brainDir, idWithin, '.system_generated', 'logs');
    mkdirSync(logsWithin, { recursive: true });
    writeFileSync(
      join(logsWithin, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>internal sys</SYSTEM_MESSAGE>' }),
        JSON.stringify({ type: 'USER_INPUT', content: '<USER_SETTINGS_CHANGE>effort=high</USER_SETTINGS_CHANGE>' }),
        JSON.stringify({
          type: 'USER_INPUT',
          content: '<USER_REQUEST>\n  实现 L3 验收标题提取功能并且测试单行截断效果\n第二行细节\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>',
        }),
      ].join('\n') + '\n' + 'X'.repeat(24 * 1024) + '\n',
      'utf8',
    );

    const logsBeyond = join(brainDir, idBeyond, '.system_generated', 'logs');
    mkdirSync(logsBeyond, { recursive: true });
    writeFileSync(
      join(logsBeyond, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'SYSTEM_MESSAGE', content: 'S'.repeat(18 * 1024) }),
        JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>Too late beyond 16 KiB</USER_REQUEST>' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const outsideTranscript = join(dir, 'outside.jsonl');
    writeFileSync(outsideTranscript, JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>SECRET</USER_REQUEST>' }) + '\n', 'utf8');
    const logsSym = join(brainDir, idSymlink, '.system_generated', 'logs');
    mkdirSync(logsSym, { recursive: true });
    symlinkSync(outsideTranscript, join(logsSym, 'transcript.jsonl'));

    createSummaryDb(dbPath, [
      {
        conversation_id: idWithin,
        title: '',
        preview: '   ',
        workspace_uris: JSON.stringify([pathToFileURL(proj).href]),
      },
      {
        conversation_id: idBeyond,
        title: '',
        preview: '',
        workspace_uris: JSON.stringify([pathToFileURL(proj).href]),
      },
      {
        conversation_id: idSymlink,
        title: '',
        preview: '',
        workspace_uris: JSON.stringify([pathToFileURL(proj).href]),
      },
      {
        conversation_id: idHasTitle,
        title: 'Summary DB Title',
        preview: '',
        workspace_uris: JSON.stringify([pathToFileURL(proj).href]),
      },
    ]);

    const sessions = readAgySummaries({ dbPath, brainDir, allowedProjectRoots: [proj], maxTitleLength: 20 });
    const byId = new Map(sessions.map((s) => [s.conversationId, s]));
    assert.equal(byId.get(idHasTitle)?.title, 'Summary DB Title');
    assert.equal([...byId.get(idWithin)!.title].length, 20);
    assert.ok(byId.get(idWithin)!.title.startsWith('实现 L3 验收标题提取'));
    assert.ok(byId.get(idWithin)!.title.endsWith('…'));
    assert.equal(byId.get(idBeyond)?.title, 'Antigravity 会话 · conv-bey');
    assert.equal(byId.get(idSymlink)?.title, 'Antigravity 会话 · conv-sym');

    const catalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [proj], maxTitleLength: 20 });
    const refreshed = catalog.refresh();
    assert.equal(refreshed.find((s) => s.conversationId === idWithin)?.title, byId.get(idWithin)!.title);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autoMirror.showTitles validates and controls title masking for auto-mirrored sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-show-titles-'));
  try {
    const project = join(dir, 'proj');
    const logs = join(dir, 'logs');
    mkdirSync(project, { recursive: true });
    mkdirSync(logs, { recursive: true });

    const baseSec = Math.floor(Date.now() / 1000);
    const makeCfg = (showTitles?: boolean): RuntimeConfig => ({
      coreDb: join(dir, `core-${String(showTitles)}.sqlite`),
      channelDb: join(dir, `channel-${String(showTitles)}.sqlite`),
      artifactStatePath: join(dir, `artifacts-${String(showTitles)}.json`),
      ownerOpenId: 'owner',
      allowedDestinations: ['chat'],
      hostId: 'h',
      claudeServiceId: 'c',
      codexServiceId: 'x',
      claudeStateDir: join(dir, 'claude'),
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 60_000,
      catalogSources: [{ provider: 'codex', hostId: 'h', serviceId: 'x', directory: logs }],
      allowedProjectRoots: [project],
      outputRoots: [project],
      autoMirror: { enabled: true, destination: 'chat', ...(showTitles !== undefined ? { showTitles } : {}) },
    });

    assert.throws(
      () => validateRuntimeConfig({ ...makeCfg(), autoMirror: { enabled: true, destination: 'chat', showTitles: 'yes' as unknown as boolean } }),
      /invalid auto mirror/,
    );
    validateRuntimeConfig(makeCfg(true));
    validateRuntimeConfig(makeCfg(false));

    const realTitle = 'Fix mobile /sessions ordering bug';
    const session: Session = {
      sessionId: 'cx-active',
      native: { provider: 'codex', hostId: 'h', serviceId: 'x', nativeSessionId: 'cx-active' },
      createdAt: new Date((baseSec + 5) * 1000).toISOString(),
      project,
      title: realTitle,
      status: 'read_only',
      revision: 0,
      capabilities: readonlyCaps,
      control: { serviceId: 'x', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: null },
    };

    const runOnce = async (showTitles?: boolean) => {
      const topicCards: any[] = [];
      const port: FeishuPort & { authorizedDestination: (d: string) => boolean } = {
        authorizedDestination: (d) => d === 'chat' || d.startsWith('topic:'),
        isTopicDestination: (d) => d.startsWith('topic:'),
        createTopic: async (_d, _id, card) => {
          topicCards.push(card);
          return 'topic:1';
        },
        send: async (_d, card) => {
          topicCards.push(card);
          return 'm';
        },
        update: async () => {},
        sendFile: async () => {},
      };
      const base: any = {
        provider: 'codex',
        onObservation: () => () => {},
        list: async () => ({ items: [session], nextCursor: null }),
        discoverRunning: async () => ({ items: [session], nextCursor: null }),
        read: async () => ({ session, messages: [], interactions: [] }),
      };
      const runtime = await createIntegratedRuntime(makeCfg(showTitles), port, [base]);
      try {
        await runtime.tick();
        const stored = runtime.store.findSession(session.native)!;
        const presented = await runtime.core.getSession(stored.sessionId);
        return {
          topicTitle: topicCards[0]?.title,
          presentedTitle: presented.title,
          isMarkedPrivate: runtime.channel.isAutoPrivateTitle(session.native),
        };
      } finally {
        await runtime.close();
      }
    };

    const masked = await runOnce(undefined);
    assert.equal(masked.isMarkedPrivate, true);
    assert.match(masked.topicTitle, /^Codex 会话 · /);
    assert.match(masked.presentedTitle, /^Codex 会话 · /);

    const visible = await runOnce(true);
    assert.equal(visible.isMarkedPrivate, false);
    assert.equal(visible.topicTitle, realTitle);
    assert.equal(visible.presentedTitle, realTitle);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
