import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { UnifiedService } from '../src/unified/adapter.js';
import type { Capabilities, Session } from '../src/unified/contracts.js';
import { FeishuChannel } from '../src/unified/feishu-channel.js';
import { FeishuSdkPort } from '../src/unified/feishu-sdk-port.js';
import { UnifiedRuntime } from '../src/unified/runtime.js';
import { displayTopicTitle } from '../src/unified/topic-title-sync.js';

const owner = { source: 'feishu', subject: 'owner' };
const genericTitle = 'Codex 会话 · 1234abcd';
const capabilities = Object.fromEntries(
  ['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(name => [name, { status: 'available' }]),
) as Capabilities;

function session(sessionId: string, title = genericTitle): Session {
  return {
    sessionId, title, native: { provider: 'codex', hostId: 'host', serviceId: 'codex', nativeSessionId: sessionId },
    project: '/tmp', status: 'idle', revision: 0, capabilities,
    control: { input: 'available', generation: 0, serviceId: 'codex', owner: null, operationId: null, reason: null },
  };
}

type CardRequest = { data: { content: string }; path: { message_id: string } };
function titleOf(request: CardRequest): string {
  return (JSON.parse(request.data.content) as { header: { title: { content: string } } }).header.title.content;
}

const schemaMismatch = { code: 230099, msg: 'Failed to create card content, ext=ErrCode: 200830; ErrMsg: schemaV2 card can not change schemaV1; ' };

function transport(dir: string) {
  const sdk = new FeishuSdkPort({ appId: 'app', appSecret: 'fixture' }, join(dir, 'sdk.sqlite'), new Set(['chat']), owner.subject);
  const creates: string[] = [];
  const patches: Array<{ root: string; title: string }> = [];
  let messageNumber = 0;
  const message: { create: (request: CardRequest) => Promise<unknown>; reply: () => Promise<unknown>; patch?: (request: CardRequest) => Promise<unknown> } = {
    create: async request => {
      if (request.data.content.includes('Codex · /tmp · 空闲')) creates.push(titleOf(request));
      return { code: 0, data: { message_id: `root-${++messageNumber}` } };
    },
    reply: async () => ({ code: 0, data: { message_id: 'reply' } }),
  };
  let patchCode = 0;
  const patch = async (request: CardRequest) => {
    patches.push({ root: request.path.message_id, title: titleOf(request) });
    return { code: patchCode };
  };
  message.patch = patch;
  Object.assign(sdk, { client: { im: { message } } });
  const seedRoute = (destination: string, sessionId: string, rootId = 'legacy-root') => sdk.importMigrationRoute(destination, {
    destination, rootId, sessionId, owner: owner.subject, appId: 'app', chatId: 'chat',
  });
  return { sdk, creates, patches, message, patch, seedRoute, patchCode: (code: number) => { patchCode = code; } };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'unified-root-title-'));
  const io = transport(dir);
  const sessions = new Map([['s', session('s')]]);
  const operations = new Map<string, object>();
  const service = {
    getSession: async (id: string) => sessions.get(id)!,
    getSnapshot: async (id: string) => ({ cursor: 'cursor', value: { session: sessions.get(id), interactions: [], messages: [] } }),
    subscribeEvents: async () => ({ status: 'events', cursor: 'cursor', events: [] }),
    getOperation: async (id: string) => operations.get(id),
    attachSession: async ({ context }: { context: { operationId: string; targetId: string } }) => {
      const op = { operationId: context.operationId, targetId: context.targetId, status: 'completed', action: 'attachSession', result: { kind: 'session', sessionId: 's' } };
      operations.set(op.operationId, op);
      return op;
    },
  } as unknown as UnifiedService;
  let authorized = true;
  const channelPath = join(dir, 'channel.sqlite');
  const channel = new FeishuChannel(service, io.sdk, async () => authorized, channelPath);
  let eventNumber = 0;
  const envelope = (destination: string) => ({ eventId: `event-${++eventNumber}`, destination, identity: owner });
  const bind = async (source: string, sessionId = 's') => {
    const result = await channel.handle(envelope(source), { action: 'bind', sessionId, mode: 'read_only' }) as { destination: string };
    return result.destination;
  };
  const seedChannel = (destination: string, sessionId = 's') => channel.importMigrationBinding(destination, {
    destination, sessionId, owner, bindingId: 'initial-binding',
  });
  const cleanup = () => {
    channel.close();
    io.sdk.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    ...io, sessions, channel, channelPath, bind, envelope, seedChannel, cleanup,
    title: (title: string) => { sessions.set('s', { ...sessions.get('s')!, title }); },
    revoke: () => { authorized = false; },
  };
}

for (const rejectedWith of ['response', 'axios error'] as const) {
  test(`legacy root schema 2 fallback recognizes the Feishu ${rejectedWith} and avoids repeated patches`, async () => {
    const f = fixture();
    const requests: CardRequest[] = [];
    try {
      f.seedRoute('topic:legacy', 's');
      f.seedChannel('topic:legacy');
      f.sessions.set('s', session('s', '旧话题的真实标题'));
      f.message.patch = async request => {
        requests.push(request);
        if (JSON.parse(request.data.content).schema === '2.0') return { code: 0 };
        if (rejectedWith === 'axios error') throw Object.assign(new Error('Request failed with status code 400'), { response: { data: schemaMismatch } });
        return schemaMismatch;
      };

      await f.channel.sync('topic:legacy');
      await f.channel.sync('topic:legacy');
      assert.equal(requests.length, 2);
      assert.equal(JSON.parse(requests[0]!.data.content).schema, undefined);
      assert.deepEqual(JSON.parse(requests[1]!.data.content), {
        schema: '2.0',
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: '[Codex · tmp] 旧话题的真实标题' } },
        body: { elements: [{ tag: 'markdown', content: 'Codex · /tmp · 空闲' }] },
      });
      assert.ok(requests.every(request => request.path.message_id === 'legacy-root'));

      f.sessions.set('s', session('s', '改名后的标题'));
      await f.channel.sync('topic:legacy');
      await f.channel.sync('topic:legacy');
      assert.equal(requests.length, 3);
      assert.equal(JSON.parse(requests[2]!.data.content).schema, '2.0');
      assert.equal(titleOf(requests[2]!), '[Codex · tmp] 改名后的标题');
    } finally {
      f.cleanup();
    }
  });
}

test('root schema fallback leaves other platform errors and unrelated card updates alone', async () => {
  const f = fixture();
  const requests: CardRequest[] = [];
  try {
    f.seedRoute('topic:legacy', 's');
    f.seedChannel('topic:legacy');
    f.sessions.set('s', session('s', '旧话题的真实标题'));
    f.message.patch = async request => {
      requests.push(request);
      return { code: 230099, msg: 'Failed to create card content, ext=ErrCode: 200861' };
    };
    await f.channel.sync('topic:legacy');
    assert.equal(requests.length, 1);
    f.message.patch = async request => {
      requests.push(request);
      return schemaMismatch;
    };
    await assert.rejects(f.sdk.update('topic:legacy', 'legacy-root', { title: '普通更新', text: '', actions: [] }, 'ordinary-update'));
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => JSON.parse(request.data.content).schema === undefined));
  } finally {
    f.cleanup();
  }
});

test('new topics remember the serialized root header and patch only on title transitions', async () => {
  const f = fixture();
  try {
    f.title('   会话   第一版   ');
    const destination = await f.bind('chat');
    assert.equal(f.sdk.rootMessageId('chat'), null);
    assert.equal(f.sdk.rootMessageId(destination), 'root-1');
    assert.deepEqual(f.creates, ['[Codex · tmp] 会话 第一版']);
    f.sessions.set('s', { ...f.sessions.get('s')!, status: 'running' });
    await f.channel.sync(destination);
    assert.equal(f.patches.length, 0);

    for (const title of ['你好', '新的话题名', '你好', '新的话题名']) {
      f.title(title);
      await f.channel.sync(destination);
      await f.channel.sync(destination);
    }
    assert.deepEqual(f.patches.map(patch => patch.title), ['你好', '新的话题名', '你好', '新的话题名'].map(title => `[Codex · tmp] ${title}`));
    assert.ok(f.patches.every(patch => patch.root === 'root-1'));
  } finally {
    f.cleanup();
  }
});

test('a persisted unprefixed root title migrates exactly once even when generic', async () => {
  const f = fixture();
  try {
    const destination = await f.bind('chat');
    const db = new DatabaseSync(f.channelPath);
    try {
      db.prepare('UPDATE channel_topic_titles SET synced_title=? WHERE destination=?').run(genericTitle, destination);
      await f.channel.sync(destination);
      await f.channel.sync(destination);
      assert.deepEqual(f.patches, [{ root: 'root-1', title: `[Codex · tmp] ${genericTitle}` }]);
      assert.equal(db.prepare('SELECT synced_title FROM channel_topic_titles WHERE destination=?').get(destination)?.synced_title, `[Codex · tmp] ${genericTitle}`);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test('interactive finish seeds a new root before its first sync', async () => {
  const f = fixture();
  try {
    f.title('交互会话标题');
    const op = await f.channel.handle(f.envelope('chat'), { action: 'bind', sessionId: 's', mode: 'interactive' }) as { operationId: string };
    const result = await f.channel.handle(f.envelope('chat'), { action: 'finish', operationId: op.operationId }) as { destination: string };
    await f.channel.sync(result.destination);
    assert.deepEqual(f.creates, ['[Codex · tmp] 交互会话标题']);
    assert.deepEqual(f.patches, []);
  } finally {
    f.cleanup();
  }
});

test('an existing SDK root remains eligible for its first title patch when bind reuses it', async () => {
  const f = fixture();
  try {
    f.seedRoute('topic:existing', 's');
    f.title('存量会话真实标题');
    assert.equal(await f.bind('chat'), 'topic:existing');
    await f.channel.sync('topic:existing');
    await f.channel.sync('topic:existing');
    assert.deepEqual(f.creates, []);
    assert.deepEqual(f.patches, [{ root: 'legacy-root', title: '[Codex · tmp] 存量会话真实标题' }]);
  } finally {
    f.cleanup();
  }
});

test('rebinding a topic does not reuse a stale title or skip a known change to a generic title', async () => {
  const f = fixture();
  try {
    f.title('旧绑定标题');
    const destination = await f.bind('chat');
    f.sessions.set('other', session('other'));
    await f.bind(destination, 'other');
    await f.channel.sync(destination);
    await f.bind(destination);
    await f.channel.sync(destination);
    assert.deepEqual(f.patches.map(patch => patch.title), [`[Codex · tmp] ${genericTitle}`, '[Codex · tmp] 旧绑定标题']);
  } finally {
    f.cleanup();
  }
});

test('230429 cleans the delivery reservation and retries only after the 30-second backoff', async (t) => {
  const f = fixture();
  const clock = t.mock.method(Date, 'now', () => now);
  let now = 2_000_000_000_000;
  try {
    f.seedRoute('topic:legacy', 's');
    f.seedChannel('topic:legacy');
    f.title('等候限流恢复');
    f.patchCode(230429);
    await f.channel.sync('topic:legacy');
    assert.equal(f.patches.length, 1);
    assert.equal(f.channel.unconfirmedDeliveryCount(), 0);
    const db = new DatabaseSync(f.channelPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT retry_after FROM channel_topic_titles').get()?.retry_after, now + 30_000);
    } finally {
      db.close();
    }
    f.patchCode(0);
    now += 29_999;
    await f.channel.sync('topic:legacy');
    assert.equal(f.patches.length, 1);
    now++;
    await f.channel.sync('topic:legacy');
    await f.channel.sync('topic:legacy');
    assert.equal(f.patches.length, 2);
    assert.equal(f.channel.unconfirmedDeliveryCount(), 0);
  } finally {
    clock.mock.restore();
    f.cleanup();
  }
});

test('230031 permanently skips the expired root while a replacement root resumes title sync', async () => {
  const f = fixture();
  const destination = 'topic:legacy';
  try {
    f.seedRoute(destination, 's');
    f.seedChannel(destination);
    f.title('过期根卡的新标题');
    f.patchCode(230031);
    await f.channel.sync(destination);
    const channelDb = new DatabaseSync(f.channelPath, { readOnly: true });
    try {
      const row = channelDb.prepare('SELECT synced_title,retry_after FROM channel_topic_titles WHERE destination=?').get(destination);
      assert.equal(row?.synced_title, '');
      assert.equal(row?.retry_after, Number.MAX_SAFE_INTEGER);
    } finally {
      channelDb.close();
    }
    f.title('换根后的标题');
    f.patchCode(0);
    await f.channel.sync(destination);
    assert.equal(f.patches.length, 1);
    assert.equal(f.channel.unconfirmedDeliveryCount(), 0);

    const sdkDb = new DatabaseSync(join(dirname(f.channelPath), 'sdk.sqlite'));
    try {
      sdkDb.prepare('UPDATE sdk_topic_routes SET root_id=? WHERE destination=?').run('replacement-root', destination);
      sdkDb.prepare('INSERT INTO sdk_message_routes VALUES (?,?)').run('replacement-root', destination);
    } finally {
      sdkDb.close();
    }
    await f.channel.sync(destination);
    await f.channel.sync(destination);
    assert.deepEqual(f.patches, [
      { root: 'legacy-root', title: '[Codex · tmp] 过期根卡的新标题' },
      { root: 'replacement-root', title: '[Codex · tmp] 换根后的标题' },
    ]);
  } finally {
    f.cleanup();
  }
});

test('a mock SDK without message.patch leaves synchronization usable', async () => {
  const f = fixture();
  try {
    f.seedRoute('topic:legacy', 's');
    f.seedChannel('topic:legacy');
    f.title('兼容旧测试传输');
    delete f.message.patch;
    await f.channel.sync('topic:legacy');
    assert.equal(f.channel.unconfirmedDeliveryCount(), 0);
    f.message.patch = f.patch;
    await f.channel.sync('topic:legacy');
    assert.deepEqual(f.patches, [{ root: 'legacy-root', title: '[Codex · tmp] 兼容旧测试传输' }]);
  } finally {
    f.cleanup();
  }
});

test('a root route lookup failure leaves creation and synchronization usable', async () => {
  const f = fixture();
  const rootMessageId = f.sdk.rootMessageId.bind(f.sdk);
  try {
    f.title('路由恢复后的标题');
    f.sdk.rootMessageId = () => { throw new Error('fixture route lookup failure'); };
    const destination = await f.bind('chat');
    await f.channel.sync(destination);
    assert.equal(f.patches.length, 0);

    f.sdk.rootMessageId = rootMessageId;
    await f.channel.sync(destination);
    assert.deepEqual(f.patches, [{ root: 'root-1', title: '[Codex · tmp] 路由恢复后的标题' }]);
  } finally {
    f.cleanup();
  }
});

for (const changed of [false, true]) {
  test(`a confirmed SDK patch is ${changed ? 'superseded' : 'recovered'} if writing the channel title receipt fails`, async () => {
    const f = fixture();
    const db = new DatabaseSync(f.channelPath);
    try {
      f.seedRoute('topic:legacy', 's');
      f.seedChannel('topic:legacy');
      await f.channel.sync('topic:legacy');
      assert.equal(f.patches.length, 0);
      f.title('确认后恢复');
      db.exec(`
        CREATE TRIGGER fail_title_receipt BEFORE INSERT ON channel_topic_titles
        BEGIN SELECT RAISE(ABORT, 'fixture title receipt failure'); END
      `);
      await assert.rejects(f.channel.sync('topic:legacy'), /fixture title receipt failure/);
      assert.equal(f.patches.length, 1);
      assert.equal(f.channel.unconfirmedDeliveryCount(), 1);

      db.exec('DROP TRIGGER fail_title_receipt');
      if (changed) f.title(genericTitle);
      await f.channel.sync('topic:legacy');
      assert.deepEqual(f.patches.map(patch => patch.title), changed ? ['[Codex · tmp] 确认后恢复', `[Codex · tmp] ${genericTitle}`] : ['[Codex · tmp] 确认后恢复']);
      assert.equal(f.channel.unconfirmedDeliveryCount(), 0);
    } finally {
      db.close();
      f.cleanup();
    }
  });
}

for (const invalidation of ['authorization', 'binding'] as const) {
  test(`root updates propagate ${invalidation} loss at the transport guard`, async () => {
    const f = fixture();
    try {
      const destination = await f.bind('chat');
      f.title('权限变动前的标题');
      const update = f.sdk.update.bind(f.sdk);
      f.sdk.update = async (...args) => {
        if (invalidation === 'authorization') f.revoke();
        else await f.channel.handle(f.envelope(destination), { action: 'unbind' });
        await update(...args);
      };
      await assert.rejects(f.channel.sync(destination), invalidation === 'authorization' ? /unauthorized/ : /binding changed/);
      assert.deepEqual(f.patches, []);
      assert.equal(f.channel.unconfirmedDeliveryCount(), 0);
    } finally {
      f.cleanup();
    }
  });
}

test('automatic privacy masking holds for both legacy roots and already-patched roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unified-root-title-private-'));
  const { sdk, patches, seedRoute } = transport(dir);
  const runtime = new UnifiedRuntime({
    coreDb: join(dir, 'core.sqlite'), channelDb: join(dir, 'channel.sqlite'), artifactStatePath: join(dir, 'artifacts'),
    ownerOpenId: owner.subject, allowedDestinations: ['chat'], hostId: 'host', claudeServiceId: 'claude', codexServiceId: 'codex',
    claudeStateDir: dir, codexEndpoint: 'codex-proxy://default', intervalMs: 100,
    autoMirror: { enabled: true, destination: 'chat', showTitles: false },
  }, sdk, []);
  try {
    const masked = session('masked', '不得出现在飞书的标题');
    const visible = session('visible', '曾经公开的标题');
    for (const entry of [masked, visible]) {
      runtime.store.insertSession(entry);
      const destination = `topic:${entry.sessionId}`;
      seedRoute(destination, entry.sessionId, `root-${entry.sessionId}`);
      runtime.channel.importMigrationBinding(destination, { destination, owner, sessionId: entry.sessionId, bindingId: entry.sessionId });
    }
    runtime.channel.markAutoPrivateTitle(masked.native);
    await runtime.channel.sync('topic:masked');
    assert.equal(patches.length, 0);

    await runtime.channel.sync('topic:visible');
    assert.equal(patches[0]?.title, displayTopicTitle(visible));
    runtime.channel.markAutoPrivateTitle(visible.native);
    runtime.store.updateSession({ ...visible, revision: 1, title: '保密改名' }, 0, 0);
    await runtime.channel.sync('topic:visible');
    await runtime.channel.sync('topic:visible');
    assert.equal(patches.length, 2);
    assert.match(patches[1]!.title, /^\[Codex · tmp\] Codex 会话 · [0-9a-f]{8}$/);
    assert.doesNotMatch(JSON.stringify(patches), /不得出现在飞书|保密改名/);
  } finally {
    await runtime.close();
    sdk.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
