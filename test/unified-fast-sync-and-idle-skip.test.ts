import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capabilities, Session, SessionSnapshot } from '../src/unified/contracts.js';
import type { UnifiedService } from '../src/unified/adapter.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';

function makeReadonlySession(): Session {
  const available = { status: 'available' as const };
  const unsupported = { status: 'unsupported' as const, reason: 'ro' };
  const capabilities: Capabilities = {
    view: available,
    send: unsupported,
    queue: unsupported,
    steer: unsupported,
    answer: unsupported,
    approve: unsupported,
    interrupt: unsupported,
    handoff: unsupported,
    files: available,
    config: unsupported,
  };
  return {
    sessionId: 'sess-idle-fast',
    native: { provider: 'agy', hostId: 'h', serviceId: 'agy-svc', nativeSessionId: 'conv-idle-fast' },
    project: '/home/zhangzy',
    title: 'Idle Topic Fast-Path Test',
    status: 'read_only',
    revision: 1,
    capabilities,
    control: { serviceId: 'agy-svc', owner: null, input: 'unavailable', generation: 0, operationId: null, reason: null },
  };
}

test('FeishuChannel.sync skips getSnapshot on idle topics when cursor has no new events and no pending work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-fast-path-'));
  try {
    const session = makeReadonlySession();
    const cursor = Buffer.from(JSON.stringify(['sess-idle-fast', 1])).toString('base64url');
    let snapshotReads = 0;

    const service = {
      getSession: async () => session,
      getSnapshot: async (): Promise<{ value: SessionSnapshot; cursor: string }> => {
        snapshotReads++;
        return {
          value: { session, messages: [], turns: [], interactions: [] },
          cursor,
        };
      },
      subscribeEvents: async () => ({
        status: 'events' as const,
        events: [],
        cursor,
      }),
      getWorkState: async () => ({ queued: [], activeTurn: null }),
    } as unknown as UnifiedService;

    const port: FeishuPort = {
      isTopicDestination: () => true,
      rootMessageId: async () => 'root-msg-1',
      send: async () => 'm-1',
      update: async () => {},
      sendFile: async () => {},
    };

    const channel = new FeishuChannel(service, port, async () => true, join(dir, 'channel.sqlite'));
    try {
      channel.importMigrationBinding('mig-idle-1', {
        destination: 'topic:idle',
        sessionId: 'sess-idle-fast',
        bindingId: 'bind-idle-1',
        owner: { source: 'feishu', subject: 'owner' },
      });

      // 1st sync: initializes cursor and syncs topic root title
      await channel.sync('topic:idle');
      const afterFirst = snapshotReads;
      assert.ok(afterFirst >= 1);

      // 2nd & 3rd syncs with 0 new events and same cursor: MUST fast-path without calling getSnapshot
      await channel.sync('topic:idle');
      await channel.sync('topic:idle');
      assert.equal(snapshotReads, afterFirst, 'idle topic must skip full getSnapshot when nothing changed');
    } finally {
      channel.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
