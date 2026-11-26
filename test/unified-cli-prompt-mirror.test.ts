import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Capabilities, Event, Message, Session, SessionSnapshot } from '../src/unified/contracts.js';
import type { UnifiedService } from '../src/unified/adapter.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';

function makeSession(status: Session['status']): Session {
  const available = { status: 'available' as const };
  const unsupported = { status: 'unsupported' as const, reason: 'read only' };
  const capabilities: Capabilities = status === 'read_only'
    ? { view: available, send: unsupported, queue: unsupported, steer: unsupported, answer: unsupported, approve: unsupported, interrupt: unsupported, handoff: unsupported, files: unsupported, config: unsupported }
    : { view: available, send: available, queue: available, steer: available, answer: available, approve: available, interrupt: available, handoff: available, files: available, config: available };
  return {
    sessionId: 'sess-cli-1',
    native: { provider: 'agy', hostId: 'h', serviceId: 'agy-svc', nativeSessionId: 'conv-1' },
    project: '/home/zhangzy',
    title: 'CLI Session',
    status,
    revision: 1,
    capabilities,
    control: {
      serviceId: 'agy-svc',
      owner: status === 'read_only' ? null : 'agy-svc',
      input: status === 'read_only' ? 'unavailable' : 'available',
      generation: 1,
      operationId: null,
      reason: null,
    },
  };
}

function makeMessage(id: string, turnId: string, role: 'user' | 'assistant', text: string, sequence: number): Message {
  return {
    messageId: id,
    sessionId: 'sess-cli-1',
    turnId,
    role,
    blocks: [{ type: 'text', text }],
    sequence,
    revision: 1,
    final: true,
    source: 'agy',
  };
}

function makeEvent(seq: number, messageId: string): Event {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    eventId: `ev-${seq}`,
    sessionId: 'sess-cli-1',
    objectId: messageId,
    objectRevision: 1,
    sequence: seq,
    type: 'message.updated',
    occurredAt: now,
    receivedAt: now,
    operationId: null,
    cursor: Buffer.from(JSON.stringify(['sess-cli-1', seq])).toString('base64url'),
    data: {},
  };
}

test('FeishuChannel mirrors new CLI user prompts before assistant replies in read_only sessions without leaking baseline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-prompt-mirror-'));
  try {
    const sent: Array<{ kind: 'text' | 'card'; body: string }> = [];
    const session = makeSession('read_only');
    let messages: Message[] = [
      makeMessage('u-old', 't-old', 'user', 'secret baseline prompt', 1),
      makeMessage('a-old', 't-old', 'assistant', 'old reply', 2),
    ];
    let events: Event[] = [];
    let cursorSeq = 2;

    const service = {
      getSession: async () => session,
      getSnapshot: async (): Promise<{ value: SessionSnapshot; cursor: string }> => ({
        value: { session, messages, turns: [], interactions: [] },
        cursor: Buffer.from(JSON.stringify(['sess-cli-1', cursorSeq])).toString('base64url'),
      }),
      subscribeEvents: async () => ({
        status: 'events' as const,
        events,
        cursor: Buffer.from(JSON.stringify(['sess-cli-1', cursorSeq])).toString('base64url'),
      }),
      getWorkState: async () => ({ queued: [], activeTurn: null }),
    } as unknown as UnifiedService;

    const port: FeishuPort = {
      isTopicDestination: () => true,
      send: async (_dest, card) => {
        sent.push({ kind: 'card', body: card.text });
        return `card-${sent.length}`;
      },
      sendText: async (_dest, text) => {
        sent.push({ kind: 'text', body: text });
        return `text-${sent.length}`;
      },
      update: async () => {},
      sendFile: async () => {},
    };

    const channel = new FeishuChannel(service, port, async () => true, join(dir, 'channel.sqlite'));
    try {
      channel.importMigrationBinding('mig-cli-1', {
        destination: 'topic:cli',
        sessionId: 'sess-cli-1',
        bindingId: 'bind-cli-1',
        owner: { source: 'feishu', subject: 'owner' },
      });
      await channel.sync('topic:cli');
      assert.equal(sent.length, 0, 'baseline history must not be replayed');

      messages = [
        ...messages,
        makeMessage('u-new', 't-new', 'user', '检查线上日志并总结报错', 3),
        makeMessage('a-new', 't-new', 'assistant', '已检查完毕，无异常。', 4),
      ];
      cursorSeq = 4;
      events = [makeEvent(3, 'u-new'), makeEvent(4, 'a-new')];

      await channel.sync('topic:cli');
      assert.equal(sent.length, 2);
      assert.equal(sent[0]!.kind, 'text');
      assert.match(sent[0]!.body, /^💻 CLI 指令：\n检查线上日志并总结报错$/);
      assert.equal(sent[1]!.kind, 'card');
      assert.equal(sent[1]!.body, '已检查完毕，无异常。');

      // Replaying the same events must be idempotent.
      await channel.sync('topic:cli');
      assert.equal(sent.length, 2);
    } finally {
      channel.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FeishuChannel does not echo user prompts in interactive Feishu-controlled sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-prompt-interactive-'));
  try {
    const sent: Array<{ kind: 'text' | 'card'; body: string }> = [];
    const session = makeSession('idle');
    let messages: Message[] = [];
    let events: Event[] = [];
    let cursorSeq = 0;

    const service = {
      getSession: async () => session,
      getSnapshot: async (): Promise<{ value: SessionSnapshot; cursor: string }> => ({
        value: { session, messages, turns: [], interactions: [] },
        cursor: Buffer.from(JSON.stringify(['sess-cli-1', cursorSeq])).toString('base64url'),
      }),
      subscribeEvents: async () => ({
        status: 'events' as const,
        events,
        cursor: Buffer.from(JSON.stringify(['sess-cli-1', cursorSeq])).toString('base64url'),
      }),
      getWorkState: async () => ({ queued: [], activeTurn: null }),
    } as unknown as UnifiedService;

    const port: FeishuPort = {
      isTopicDestination: () => true,
      send: async (_dest, card) => {
        sent.push({ kind: 'card', body: card.text });
        return `card-${sent.length}`;
      },
      sendText: async (_dest, text) => {
        sent.push({ kind: 'text', body: text });
        return `text-${sent.length}`;
      },
      update: async () => {},
      sendFile: async () => {},
    };

    const dbPath = join(dir, 'channel.sqlite');
    const channel = new FeishuChannel(service, port, async () => true, dbPath);
    try {
      channel.importMigrationBinding('mig-feishu-1', {
        destination: 'topic:feishu',
        sessionId: 'sess-cli-1',
        bindingId: 'bind-feishu-1',
        owner: { source: 'feishu', subject: 'owner' },
      });
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE channel_bindings SET access_mode='interactive' WHERE destination=?").run('topic:feishu');
      db.close();
      await channel.sync('topic:feishu');

      messages = [
        makeMessage('u-feishu', 't-1', 'user', '我在飞书里发的消息', 1),
        makeMessage('a-feishu', 't-1', 'assistant', '收到。', 2),
      ];
      cursorSeq = 2;
      events = [makeEvent(1, 'u-feishu'), makeEvent(2, 'a-feishu')];

      await channel.sync('topic:feishu');
      assert.equal(sent.length, 1, 'interactive Feishu prompt must not be echoed');
      assert.equal(sent[0]!.kind, 'card');
      assert.equal(sent[0]!.body, '收到。');
    } finally {
      channel.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
