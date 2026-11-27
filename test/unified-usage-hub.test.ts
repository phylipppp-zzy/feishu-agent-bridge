import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { encodeCard } from '../src/unified/feishu-card-wire.js';
import {
  FeishuSdkPort,
  handleSdkCardCallback,
  receiveSdkMessage,
} from '../src/unified/feishu-sdk-port.js';
import {
  UnifiedRuntime,
  validateRuntimeConfig,
  type RuntimeConfig,
  type RuntimeTrustedAction,
} from '../src/unified/runtime.js';
import {
  renderUsageDashboardCard,
  type UsageDashboardPayload,
} from '../src/unified/hubs/usage-cards.js';
import { UsageHub } from '../src/unified/hubs/usage-hub.js';

function makeSamplePayload(overrides?: Partial<UsageDashboardPayload>): UsageDashboardPayload {
  return {
    schema_version: 1,
    generated_at: '2026-11-27T14:00:30+08:00',
    refresh_interval_seconds: 600,
    summary: {
      today: {
        requests: 512,
        input: 82_000_000,
        output: 1_200_000,
        cached: 76_000_000,
        total_tokens: 83_200_000,
        cache_hit_ratio: 0.927,
        cost_usd: 128.4,
      },
      yesterday: {
        requests: 640,
        input: 95_000_000,
        output: 1_400_000,
        cached: 89_000_000,
        total_tokens: 96_400_000,
        cache_hit_ratio: 0.936,
        cost_usd: 100.0,
      },
      d7: {
        requests: 3500,
        input: 610_000_000,
        output: 9_100_000,
        cached: 570_000_000,
        total_tokens: 619_100_000,
        cache_hit_ratio: 0.934,
        cost_usd: 770.0,
      },
      d30: {
        requests: 14_200,
        input: 2_400_000_000,
        output: 38_000_000,
        cached: 2_280_000_000,
        total_tokens: 2_438_000_000,
        cache_hit_ratio: 0.95,
        cost_usd: 2_940.0,
      },
    },
    backends: [
      {
        id: 'codex',
        name: 'Codex',
        status: 'ok',
        quota: {
          stale: false,
          snapshot_at: '2026-11-27T14:00:25+08:00',
          windows: [
            {
              group: 'Codex',
              label: '周额度',
              window_type: 'weekly',
              remaining_percent: 42,
              used_percent: 58,
              resets_at: '2026-11-30T21:00:00+08:00',
            },
          ],
        },
        today: { cost_usd: 48.4, total_tokens: 32_000_000, requests: 210, cache_hit_ratio: 0.96 },
        d7: { cost_usd: 290.0, total_tokens: 210_000_000, requests: 1400, cache_hit_ratio: 0.96 },
        d30: { cost_usd: 1140.0, total_tokens: 910_000_000, requests: 6100, cache_hit_ratio: 0.97 },
        models_today: [
          { model: 'gpt-6.2-astra', cost_usd: 30.2, total_tokens: 12_000_000, requests: 70, cache_hit_ratio: 0.95 },
          { model: 'gpt-6.2-sol', cost_usd: 18.2, total_tokens: 20_000_000, requests: 140, cache_hit_ratio: 0.97 },
        ],
        models_7d: [
          { model: 'gpt-6.2-astra', cost_usd: 180.0, total_tokens: 80_000_000, requests: 480, cache_hit_ratio: 0.95 },
          { model: 'gpt-6.2-sol', cost_usd: 110.0, total_tokens: 130_000_000, requests: 920, cache_hit_ratio: 0.97 },
        ],
        models_30d: [
          { model: 'gpt-6.2-astra', cost_usd: 720.0, total_tokens: 360_000_000, requests: 2100, cache_hit_ratio: 0.96 },
          { model: 'gpt-6.2-sol', cost_usd: 420.0, total_tokens: 550_000_000, requests: 4000, cache_hit_ratio: 0.98 },
        ],
      },
      {
        id: 'antigravity',
        name: 'Antigravity',
        status: 'ok',
        quota: {
          stale: false,
          snapshot_at: '2026-11-27T14:00:30+08:00',
          windows: [
            {
              group: 'Gemini',
              label: 'Gemini 5小时',
              window_type: 'short',
              remaining_percent: 68.5,
              used_percent: 31.5,
              resets_at: '2026-11-27T17:30:00+08:00',
            },
            {
              group: 'Gemini',
              label: 'Gemini 周额度',
              window_type: 'weekly',
              remaining_percent: 28.0,
              used_percent: 72.0,
              resets_at: '2026-12-03T15:00:00+08:00',
            },
          ],
        },
        today: { cost_usd: 70.0, total_tokens: 48_000_000, requests: 280, cache_hit_ratio: 0.9 },
        d7: { cost_usd: 410.0, total_tokens: 370_000_000, requests: 1900, cache_hit_ratio: 0.91 },
        d30: { cost_usd: 1500.0, total_tokens: 1_350_000_000, requests: 7200, cache_hit_ratio: 0.93 },
        models_today: [
          { model: 'gemini-4-carbon-high', cost_usd: 42.0, total_tokens: 24_000_000, requests: 120, cache_hit_ratio: 0.9 },
          { model: 'gemini-4-neon-medium', cost_usd: 16.0, total_tokens: 14_000_000, requests: 90, cache_hit_ratio: 0.91 },
          { model: 'gemini-4-hydrogen', cost_usd: 8.0, total_tokens: 7_000_000, requests: 50, cache_hit_ratio: 0.89 },
          { model: 'claude-opus-4-6[agy]', cost_usd: 4.0, total_tokens: 3_000_000, requests: 20, cache_hit_ratio: 0.88 },
        ],
        models_7d: [
          { model: 'gemini-4-carbon-high', cost_usd: 300.0, total_tokens: 260_000_000, requests: 1300, cache_hit_ratio: 0.91 },
          { model: 'gemini-4-neon-medium', cost_usd: 110.0, total_tokens: 110_000_000, requests: 600, cache_hit_ratio: 0.91 },
        ],
        models_30d: [
          { model: 'gemini-4-carbon-high', cost_usd: 1100.0, total_tokens: 950_000_000, requests: 5000, cache_hit_ratio: 0.93 },
        ],
      },
      {
        id: 'claude',
        name: 'Claude',
        status: 'local_only',
        quota: {
          stale: true,
          snapshot_at: '2026-11-27T14:00:30+08:00',
          windows: [],
          cycle_reset: '2026-11-30T13:00:00+08:00',
          cycle_rule: '每周一 13:00 重置',
        },
        today: { cost_usd: 10.0, total_tokens: 3_200_000, requests: 22, cache_hit_ratio: 0.85 },
        d7: { cost_usd: 70.0, total_tokens: 39_100_000, requests: 200, cache_hit_ratio: 0.88 },
        d30: { cost_usd: 300.0, total_tokens: 178_000_000, requests: 900, cache_hit_ratio: 0.9 },
        models_today: [
          { model: 'claude-sonnet-5-5', cost_usd: 10.0, total_tokens: 3_200_000, requests: 22, cache_hit_ratio: 0.85 },
        ],
        models_7d: [
          { model: 'claude-sonnet-5-5', cost_usd: 70.0, total_tokens: 39_100_000, requests: 200, cache_hit_ratio: 0.88 },
        ],
        models_30d: [
          { model: 'claude-sonnet-5-5', cost_usd: 300.0, total_tokens: 178_000_000, requests: 900, cache_hit_ratio: 0.9 },
        ],
      },
    ],
    claude_cycles: [
      {
        period: '11-16 13:00 起',
        partial: false,
        current: false,
        total_requests: 120,
        total_tokens: 24_000_000,
        local_cost_usd: 64.5,
        site_cost_usd: 64.2,
        models: [{ model: 'claude-sonnet-5-5', requests: 120, total_tokens: 24_000_000, local_cost_usd: 64.5 }],
      },
      {
        period: '11-23 13:00 起',
        partial: true,
        current: true,
        total_requests: 200,
        total_tokens: 39_100_000,
        local_cost_usd: 70.0,
        site_cost_usd: null,
        models: [{ model: 'claude-sonnet-5-5', requests: 200, total_tokens: 39_100_000, local_cost_usd: 70.0 }],
      },
    ],
    ...overrides,
  };
}

function makeBaseRuntimeConfig(dir: string, usageHub?: RuntimeConfig['usageHub']): RuntimeConfig {
  const claudeDir = join(dir, 'claude-state');
  return {
    coreDb: join(dir, 'core.sqlite'),
    channelDb: join(dir, 'channel.sqlite'),
    ownerOpenId: 'ou_owner',
    allowedDestinations: ['oc_main'],
    hostId: 'gpu3-local-v1',
    claudeServiceId: 'svc-claude',
    codexServiceId: 'svc-codex',
    claudeStateDir: claudeDir,
    codexEndpoint: 'codex-proxy://default',
    intervalMs: 1000,
    ...(usageHub ? { usageHub } : {}),
  };
}

function attachFakeLarkClient(sdk: FeishuSdkPort) {
  let msgSeq = 0;
  const creates: Array<{ receive_id: string; msg_type: string; content: string }> = [];
  const patches: Array<{ message_id: string; content: string }> = [];
  const replies: Array<{ message_id: string; content: string }> = [];
  let resourceDownloads = 0;

  (sdk as unknown as { client: unknown }).client = {
    im: {
      message: {
        create: async ({ data }: { data: { receive_id: string; msg_type: string; content: string } }) => {
          creates.push(data);
          return { code: 0, data: { message_id: `om_usage_${++msgSeq}` } };
        },
        patch: async ({ path, data }: { path: { message_id: string }; data: { content: string } }) => {
          patches.push({ message_id: path.message_id, content: data.content });
          return { code: 0 };
        },
        reply: async ({ path, data }: { path: { message_id: string }; data: { content: string } }) => {
          replies.push({ message_id: path.message_id, content: data.content });
          return { code: 0, data: { message_id: `om_reply_${++msgSeq}` } };
        },
      },
      messageResource: {
        get: async () => {
          resourceDownloads++;
          return { getReadableStream: () => Readable.from([Buffer.from('unused')]) };
        },
      },
    },
  };

  return {
    creates,
    patches,
    replies,
    get resourceDownloads() {
      return resourceDownloads;
    },
  };
}

type SdkMessageEvent = Parameters<typeof receiveSdkMessage>[0];
type SdkCardCallbackEvent = Parameters<typeof handleSdkCardCallback>[0];

function buildMessageEvent(opts: {
  messageId: string;
  chatId: string;
  senderOpenId: string;
  messageType?: string;
  content: Record<string, unknown>;
  mentions?: Array<{ key: string; id: { open_id: string } }>;
  rootId?: string;
  parentId?: string;
  threadId?: string;
}): SdkMessageEvent {
  return {
    sender: {
      sender_type: 'user',
      sender_id: { open_id: opts.senderOpenId },
    },
    message: {
      message_id: opts.messageId,
      chat_id: opts.chatId,
      chat_type: 'group',
      message_type: opts.messageType ?? 'text',
      content: JSON.stringify(opts.content),
      ...(opts.mentions ? { mentions: opts.mentions } : {}),
      ...(opts.rootId ? { root_id: opts.rootId } : {}),
      ...(opts.parentId ? { parent_id: opts.parentId } : {}),
      ...(opts.threadId ? { thread_id: opts.threadId } : {}),
    },
  } as unknown as SdkMessageEvent;
}

test('renderUsageDashboardCard encodes Card 2.0 sections, collapsible panel, alert templates, and <256B callbacks', () => {
  const nowMs = Date.parse('2026-11-27T14:05:30+08:00');
  const payload = makeSamplePayload();
  const card = renderUsageDashboardCard(payload, {
    range: 'today',
    nowMs,
    sourceNote: '实时采集',
  });

  assert.equal(card.schema, '2.0');
  assert.equal(card.template, 'orange'); // Gemini weekly 28% (<35%)
  assert.equal(card.title, '📊 AI 用量与额度看板 · 今日');
  assert.match(card.subtitle ?? '', /实时采集/);
  assert.ok(card.headerTags?.some((t) => t.text === '实时同步' && t.color === 'green'));
  assert.ok(card.headerTags?.some((t) => t.text.includes('额度预警') && t.color === 'orange'));
  assert.equal(card.sections?.length, 4);
  assert.equal(card.actions.length, 5);

  // Verify [🔄 立即刷新] has no range field, and [✓ 今日] is primary
  assert.deepEqual(card.actions[0]!.value, { action: 'usage_report', trigger: 'card' });
  assert.deepEqual(card.actions[1]!.value, { action: 'usage_report', trigger: 'card', range: 'today' });
  assert.equal(card.actions[1]!.type, 'primary');
  assert.equal(card.actions[4]!.url, 'https://phylipppp-zzy.github.io/usage/');

  for (const action of card.actions) {
    assert.ok(Buffer.byteLength(JSON.stringify(action.value), 'utf8') < 256);
  }

  const wire = encodeCard(card);
  const wireJson = JSON.stringify(wire);
  assert.ok(Buffer.byteLength(wireJson, 'utf8') < 25_000);
  assert.equal(wire.schema, '2.0');
  assert.match(wireJson, /collapsible_panel/);
  assert.match(card.text, /Claude\*\* · 在线未连通/);
  assert.match(card.text, /\\\[agy\\\]/); // dynamic model name escaped with escapeCardMarkdown

  // Critical red alert template (<15%) and d7 range
  const redPayload = makeSamplePayload({
    generated_at: '2026-11-27T12:00:00+08:00', // >2h old -> stale red tag
    backends: [
      {
        id: 'codex',
        name: 'Codex',
        quota: { windows: [{ label: '周额度', remaining_percent: 9.5, resets_at: '2026-11-28T00:00:00+08:00' }] },
        d7: { cost_usd: 770 },
      },
    ],
  });
  const redCard = renderUsageDashboardCard(redPayload, { range: 'd7', nowMs });
  assert.equal(redCard.template, 'red');
  assert.ok(redCard.headerTags?.some((t) => t.text === '快照滞后' && t.color === 'red'));
  assert.equal(redCard.actions[2]!.type, 'primary');
  assert.match(redCard.sections?.[0]?.text ?? '', /日均 \$110\.00/);

  // Null / missing payload -> grey fallback
  const greyCard = renderUsageDashboardCard(null, { nowMs });
  assert.equal(greyCard.template, 'grey');
});

test('UsageHub + FeishuSdkPort + UnifiedRuntime handle all 5 ordinary-group message forms without polluting resource tables and block unauthorized users', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-hub-group-'));
  const snapshotPath = join(dir, 'usage-data.json');
  writeFileSync(snapshotPath, JSON.stringify(makeSamplePayload()));

  const sdkDbPath = join(dir, 'sdk.sqlite');
  const sdk = new FeishuSdkPort(
    { appId: 'cli_app', appSecret: 'sec' },
    sdkDbPath,
    new Set(['oc_main']),
    'ou_owner',
    true,
    true,
    new Set(['oc_usage']),
  );
  const lark = attachFakeLarkClient(sdk);

  let collectCalls = 0;
  let clockMs = Date.parse('2026-11-27T14:02:00+08:00');
  const config = makeBaseRuntimeConfig(dir, {
    enabled: true,
    destination: 'oc_usage',
    snapshotPath,
  });
  const runtime = new UnifiedRuntime(config, sdk, [], {
    usageHub: {
      now: () => clockMs,
      refreshCooldownMs: 45_000,
      collectSnapshot: async () => {
        collectCalls++;
        return makeSamplePayload({ generated_at: new Date(clockMs).toISOString() });
      },
    },
  });

  const dispatchFromSdk = async (event: SdkMessageEvent) => {
    await receiveSdkMessage(
      event,
      'ou_bot',
      'ou_owner',
      new Set(['oc_main']),
      async () => {
        throw new Error('should never download inbound resources in usage group');
      },
      (env, act) => runtime.handleTrusted(env, act),
      () => {
        throw new Error('should never queue resources in usage group');
      },
      (chat, root, parent, thread) => sdk.resolveDestination(chat, root, parent, thread),
      new Set(['oc_usage']),
    );
  };

  try {
    // 1. Plain text without '/' and without @bot ("用量")
    await dispatchFromSdk(
      buildMessageEvent({
        messageId: 'om_in_1',
        chatId: 'oc_usage',
        senderOpenId: 'ou_owner',
        content: { text: '用量' },
      }),
    );
    assert.equal(lark.creates.length, 1);
    assert.equal(lark.creates[0]!.receive_id, 'oc_usage');
    assert.equal(collectCalls, 1);

    // 2. Pure @bot with empty text (within 45s cooldown -> reuses fresh snapshot)
    clockMs += 5_000;
    await dispatchFromSdk(
      buildMessageEvent({
        messageId: 'om_in_2',
        chatId: 'oc_usage',
        senderOpenId: 'ou_owner',
        content: { text: '@_user_1   ' },
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      }),
    );
    assert.equal(lark.creates.length, 2);
    assert.equal(collectCalls, 1); // 45s cooldown respected

    // 3. Left-swipe quote reply inside usage group (carries root_id / parent_id / thread_id + "30天" hint)
    clockMs += 50_000; // past 45s cooldown
    await dispatchFromSdk(
      buildMessageEvent({
        messageId: 'om_in_3',
        chatId: 'oc_usage',
        senderOpenId: 'ou_owner',
        rootId: 'om_old_card',
        parentId: 'om_old_card',
        threadId: 'omt_unregistered_thread',
        content: { text: '看下近 30天消耗' },
      }),
    );
    assert.equal(lark.creates.length, 3);
    assert.equal(collectCalls, 2);
    assert.match(lark.creates[2]!.content, /近 30 天/);

    // 4. Image message in usage group -> triggers usage_report without downloading or polluting sdk_inbound_resources
    clockMs += 5_000;
    await dispatchFromSdk(
      buildMessageEvent({
        messageId: 'om_in_4',
        chatId: 'oc_usage',
        senderOpenId: 'ou_owner',
        messageType: 'image',
        content: { image_key: 'img_v3_test' },
      }),
    );
    assert.equal(lark.creates.length, 4);
    assert.equal(lark.resourceDownloads, 0);

    // 5. Duplicate eventId delivery is idempotent
    await dispatchFromSdk(
      buildMessageEvent({
        messageId: 'om_in_4',
        chatId: 'oc_usage',
        senderOpenId: 'ou_owner',
        messageType: 'image',
        content: { image_key: 'img_v3_test' },
      }),
    );
    assert.equal(lark.creates.length, 4);

    // 6. Non-owner message without @bot is ignored; with @bot throws unauthorized
    await dispatchFromSdk(
      buildMessageEvent({
        messageId: 'om_intruder_1',
        chatId: 'oc_usage',
        senderOpenId: 'ou_stranger',
        content: { text: '用量' },
      }),
    );
    assert.equal(lark.creates.length, 4);

    await assert.rejects(
      () =>
        dispatchFromSdk(
          buildMessageEvent({
            messageId: 'om_intruder_2',
            chatId: 'oc_usage',
            senderOpenId: 'ou_stranger',
            content: { text: '@_user_1 用量' },
            mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
          }),
        ),
      /unauthorized/,
    );

    // 7. Topic creation in usage group remains strictly forbidden
    await assert.rejects(
      () => sdk.createTopic('oc_usage', 'sess_1', { title: 't', text: 'x', actions: [] }, 'deliv_1'),
      /destination unauthorized/,
    );
    await assert.rejects(
      () => sdk.createTaskTopic('oc_usage', 'task_1', 'op_1', 'ou_owner'),
      /unauthorized|unavailable|destination/i,
    );

    // 8. Verify zero rows in sdk_inbound_resources and sdk_text_resources_v1
    const rawSdkDb = new DatabaseSync(sdkDbPath, { readOnly: true });
    try {
      const resCount = (rawSdkDb.prepare('SELECT COUNT(*) AS n FROM sdk_inbound_resources').get() as { n: number }).n;
      const txtCount = (rawSdkDb.prepare('SELECT COUNT(*) AS n FROM sdk_text_resources_v1').get() as { n: number }).n;
      assert.equal(resCount, 0);
      assert.equal(txtCount, 0);
    } finally {
      rawSdkDb.close();
    }

    // 9. Card button callbacks: [7 天] zero-wait switch & [🔄 立即刷新] in-place patch via handleSdkCardCallback
    const sentCardMessageId = 'om_usage_4';
    const d7Toast = await handleSdkCardCallback<RuntimeTrustedAction>(
      {
        event_id: 'cb_d7_1',
        context: { open_message_id: sentCardMessageId, open_chat_id: 'oc_usage' },
        operator: { open_id: 'ou_owner' },
        action: { tag: 'button', value: { action: 'usage_report', trigger: 'card', range: 'd7' } },
      } as unknown as SdkCardCallbackEvent,
      'ou_owner',
      new Set(['oc_main', 'oc_usage']),
      (chat, msg) => sdk.callbackDestination(chat, msg),
      (env, act) => runtime.handleTrusted(env, act),
    );
    assert.deepEqual(d7Toast, { toast: { type: 'success', content: '已确认' } });
    assert.equal(lark.patches.length, 1);
    assert.equal(lark.patches[0]!.message_id, sentCardMessageId);
    assert.match(lark.patches[0]!.content, /近 7 天/);
    assert.equal(collectCalls, 2); // snapshot on disk is fresh (<=10m) -> zero live collect!

    // Advance >45s and click [🔄 立即刷新] (no range field) -> triggers live refresh & patches 'today'
    clockMs += 60_000;
    const refreshToast = await handleSdkCardCallback<RuntimeTrustedAction>(
      {
        event_id: 'cb_refresh_1',
        context: { open_message_id: sentCardMessageId, open_chat_id: 'oc_usage' },
        operator: { open_id: 'ou_owner' },
        action: { tag: 'button', value: { action: 'usage_report', trigger: 'card' } },
      } as unknown as SdkCardCallbackEvent,
      'ou_owner',
      new Set(['oc_main', 'oc_usage']),
      (chat, msg) => sdk.callbackDestination(chat, msg),
      (env, act) => runtime.handleTrusted(env, act),
    );
    assert.deepEqual(refreshToast, { toast: { type: 'success', content: '已确认' } });
    assert.equal(collectCalls, 3);
    assert.equal(lark.patches.length, 2);
    assert.match(lark.patches[1]!.content, /📊 AI 用量与额度看板 · 今日/);
  } finally {
    await runtime.close();
    sdk.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UsageHub aligns scheduled slots to XX:01:00, survives same-slot restart without resending, reconciles unknown state, and sends on next hour', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-hub-sched-'));
  const snapshotPath = join(dir, 'usage-data.json');
  const dbPath = join(dir, 'usage-hub.sqlite');
  const sdkDbPath = join(dir, 'sdk.sqlite');

  let clockMs = Date.parse('2026-11-27T10:00:30+08:00');
  writeFileSync(
    snapshotPath,
    JSON.stringify(makeSamplePayload({ generated_at: '2026-11-27T10:00:10+08:00' })),
  );

  const sdk1 = new FeishuSdkPort(
    { appId: 'cli_app', appSecret: 'sec' },
    sdkDbPath,
    new Set(['oc_main']),
    'ou_owner',
    false,
    false,
    new Set(['oc_usage']),
  );
  const lark1 = attachFakeLarkClient(sdk1);

  try {
    const hub1 = new UsageHub({
      dbPath,
      owner: { source: 'feishu', subject: 'ou_owner' },
      destination: 'oc_usage',
      port: sdk1,
      snapshotPath,
      now: () => clockMs,
    });

    // At 10:00:30, current slot is the 09:01..10:00:59 slot; flush it first
    const first = await hub1.flushScheduled();
    assert.equal(first.status, 'sent');
    assert.equal(lark1.creates.length, 1);

    // Delay to next boundary (10:01:00) from 10:00:30 should be exactly 30_000ms
    assert.equal(hub1.nextWakeDelayMs(clockMs), 30_000);

    // Move to 10:01:05 -> crosses XX:01 boundary into new slot
    clockMs = Date.parse('2026-11-27T10:01:05+08:00');
    assert.equal(hub1.shouldFlushScheduled(clockMs), true);
    const second = await hub1.flushScheduled();
    assert.equal(second.status, 'sent');
    assert.equal(lark1.creates.length, 2);
    hub1.close();

    // Restart process within the same hour at 10:42:00 -> must NOT resend
    clockMs = Date.parse('2026-11-27T10:42:00+08:00');
    const hub2 = new UsageHub({
      dbPath,
      owner: { source: 'feishu', subject: 'ou_owner' },
      destination: 'oc_usage',
      port: sdk1,
      snapshotPath,
      now: () => clockMs,
    });
    assert.equal(hub2.shouldFlushScheduled(clockMs), false);
    const sameHour = await hub2.flushScheduled();
    assert.equal(sameHour.status, 'already_sent');
    assert.equal(lark1.creates.length, 2);

    // Advance to next hour 11:01:02 -> sends new hourly report
    clockMs = Date.parse('2026-11-27T11:01:02+08:00');
    writeFileSync(
      snapshotPath,
      JSON.stringify(makeSamplePayload({ generated_at: '2026-11-27T11:00:15+08:00' })),
    );
    assert.equal(hub2.shouldFlushScheduled(clockMs), true);
    const nextHour = await hub2.flushScheduled();
    assert.equal(nextHour.status, 'sent');
    assert.equal(lark1.creates.length, 3);

    // Simulate crash leaving 12:01 slot in 'unknown' state where Feishu DID NOT record receipt -> never double-send
    clockMs = Date.parse('2026-11-27T12:05:00+08:00');
    const slot12 = hub2.currentSlot(clockMs);
    hub2.close();

    const rawDb = new DatabaseSync(dbPath);
    rawDb
      .prepare(
        "INSERT INTO usage_hub_slots_v1(slot, delivery_id, state, message_id, created_at, updated_at, last_error) VALUES (?, ?, 'unknown', NULL, ?, ?, 'simulated crash')",
      )
      .run(slot12, `usage-auto:oc_usage:${slot12}`, clockMs, clockMs);
    rawDb.close();

    const hub3 = new UsageHub({
      dbPath,
      owner: { source: 'feishu', subject: 'ou_owner' },
      destination: 'oc_usage',
      port: sdk1,
      snapshotPath,
      now: () => clockMs,
    });
    const unconfirmed = await hub3.flushScheduled();
    assert.equal(unconfirmed.status, 'unknown_unconfirmed');
    assert.equal(lark1.creates.length, 3); // did not blindly resend!
    assert.equal(hub3.shouldFlushScheduled(clockMs), false); // no busy-spin on already-reconciled unknown slot
    hub3.close();
  } finally {
    sdk1.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UsageHub subprocess collector never passes --publish and falls back to cached snapshot on subprocess timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-hub-proc-'));
  const snapshotPath = join(dir, 'usage-data.json');
  const scriptPath = join(dir, 'fake_export_usage.py');
  const argvLogPath = join(dir, 'argv.json');
  const dbPath = join(dir, 'usage-hub.sqlite');

  writeFileSync(
    snapshotPath,
    JSON.stringify(makeSamplePayload({ generated_at: '2026-11-27T13:55:00+08:00' })),
  );

  // Real Python script: records argv, fails if --publish is passed, and hangs when hang marker exists
  const hangMarker = join(dir, 'hang.flag');
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path

args = sys.argv[1:]
Path(${JSON.stringify(argvLogPath)}).write_text(json.dumps(args), encoding="utf-8")
if "--publish" in args or "--create-gist" in args:
    sys.exit(99)
if Path(${JSON.stringify(hangMarker)}).exists():
    time.sleep(2.0)
out_idx = args.index("--out") + 1
Path(args[out_idx]).write_text(Path(${JSON.stringify(snapshotPath)}).read_text(encoding="utf-8"), encoding="utf-8")
sys.exit(0)
`,
  );
  chmodSync(scriptPath, 0o755);
  writeFileSync(hangMarker, '1');

  const sentCards: Array<{ deliveryId: string; subtitle?: string }> = [];
  const port = {
    send: async (_dest: string, card: { subtitle?: string }, deliveryId: string) => {
      sentCards.push({ deliveryId, ...(card.subtitle ? { subtitle: card.subtitle } : {}) });
      return `om_proc_${sentCards.length}`;
    },
    update: async () => {},
  };

  const hub = new UsageHub({
    dbPath,
    owner: { source: 'feishu', subject: 'ou_owner' },
    destination: 'oc_usage',
    port,
    snapshotPath,
    exportScriptPath: scriptPath,
    toolsBinPath: '/home/zhangzy/.local/bin/tools',
    pythonBinPath: '/usr/bin/python3',
    collectTimeoutMs: 150,
    refreshCooldownMs: 0,
    now: () => Date.parse('2026-11-27T14:00:00+08:00'),
  });

  try {
    // 1. Subprocess hangs past 150ms timeout -> gracefully falls back to snapshotPath with '缓存快照'
    const fallbackRes = await hub.handleTrigger(
      {
        eventId: 'message:timeout_1',
        destination: 'oc_usage',
        identity: { source: 'feishu', subject: 'ou_owner' },
      },
      { action: 'usage_report', trigger: 'message', rawText: '用量' },
    );
    assert.equal(fallbackRes.status, 'sent');
    assert.equal(sentCards.length, 1);
    assert.match(sentCards[0]!.subtitle ?? '', /缓存快照/);

    const loggedArgs = JSON.parse(readFileSync(argvLogPath, 'utf8')) as string[];
    assert.ok(!loggedArgs.includes('--publish'));
    assert.ok(!loggedArgs.includes('--create-gist'));
    assert.equal(loggedArgs[0], '--out');
    assert.ok(loggedArgs[1]!.startsWith(`${snapshotPath}.hub-`), `expected isolated out path, got ${loggedArgs[1]}`);
    assert.deepEqual(loggedArgs.slice(2), ['--tools-bin', '/home/zhangzy/.local/bin/tools']);

    // 2. Remove hang marker -> subprocess succeeds quickly -> sourceNote is '实时采集'
    rmSync(hangMarker, { force: true });
    const liveRes = await hub.handleTrigger(
      {
        eventId: 'message:live_2',
        destination: 'oc_usage',
        identity: { source: 'feishu', subject: 'ou_owner' },
      },
      { action: 'usage_report', trigger: 'message', rawText: '用量' },
    );
    assert.equal(liveRes.status, 'sent');
    assert.equal(sentCards.length, 2);
    assert.match(sentCards[1]!.subtitle ?? '', /实时采集/);
  } finally {
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateRuntimeConfig rejects usageHub destination collisions and ensureUsageGroup finds or creates chat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-hub-cfg-'));
  try {
    // Valid isolated usageHub config passes
    assert.doesNotThrow(() =>
      validateRuntimeConfig(
        makeBaseRuntimeConfig(dir, {
          enabled: true,
          destination: 'oc_usage_group',
          intervalMinutes: 60,
        }),
      ),
    );

    // Collision with main chat allowedDestinations -> rejected
    assert.throws(
      () =>
        validateRuntimeConfig(
          makeBaseRuntimeConfig(dir, {
            enabled: true,
            destination: 'oc_main',
          }),
        ),
      /invalid usage hub configuration/,
    );

    // Collision with watchHub destination -> rejected
    assert.throws(
      () =>
        validateRuntimeConfig({
          ...makeBaseRuntimeConfig(dir, {
            enabled: true,
            destination: 'oc_watch_shared',
          }),
          watchHub: { enabled: false, destination: 'oc_watch_shared' },
        }),
      /invalid usage hub configuration/,
    );

    // Invalid intervalMinutes -> rejected
    assert.throws(
      () =>
        validateRuntimeConfig(
          makeBaseRuntimeConfig(dir, {
            enabled: true,
            destination: 'oc_usage_group',
            intervalMinutes: 1,
          }),
        ),
      /invalid usage hub configuration/,
    );

    // Relative snapshotPath -> rejected
    assert.throws(
      () =>
        validateRuntimeConfig(
          makeBaseRuntimeConfig(dir, {
            enabled: true,
            destination: 'oc_usage_group',
            snapshotPath: 'relative/usage-data.json',
          }),
        ),
      /invalid usage hub configuration/,
    );

    // Test ensureUsageGroup helper (pagination + create)
    const cfgPath = join(dir, 'config.json');
    const envPath = join(dir, 'env');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        runtime: { ownerOpenId: 'ou_owner_ensure', allowedDestinations: ['oc_main'] },
      }),
    );
    writeFileSync(envPath, 'FEISHU_APP_ID=cli_x\nFEISHU_APP_SECRET=sec_y\n');

    const scriptCandidate1 = resolve(import.meta.dirname, '../scripts/ensure-usage-group.mjs');
    const scriptCandidate2 = resolve(import.meta.dirname, '../../scripts/ensure-usage-group.mjs');
    const ensureScriptPath = existsSync(scriptCandidate1) ? scriptCandidate1 : scriptCandidate2;
    const { ensureUsageGroup } = (await import(pathToFileURL(ensureScriptPath).href)) as {
      ensureUsageGroup: (opts: Record<string, unknown>) => Promise<{
        ok: boolean;
        created: boolean;
        chatId: string | null;
        name: string;
      }>;
    };
    let createPayload: unknown = null;
    const mockClient = {
      im: {
        chat: {
          list: async ({ params }: { params?: { page_token?: string } }) => {
            if (!params?.page_token) {
              return {
                code: 0,
                data: {
                  items: [{ chat_id: 'oc_other', name: '日常群', chat_status: 'normal' }],
                  has_more: true,
                  page_token: 'p2',
                },
              };
            }
            return {
              code: 0,
              data: {
                items: [{ chat_id: 'oc_found_usage', name: 'AI 用量监控', chat_status: 'normal' }],
                has_more: false,
              },
            };
          },
          create: async (req: unknown) => {
            createPayload = req;
            return { code: 0, data: { chat_id: 'oc_created_usage', name: '新监控群' } };
          },
        },
      },
    };

    const existing = await ensureUsageGroup({
      configPath: cfgPath,
      envPath,
      client: mockClient,
    });
    assert.deepEqual(existing, {
      ok: true,
      created: false,
      chatId: 'oc_found_usage',
      name: 'AI 用量监控',
    });

    const created = await ensureUsageGroup({
      name: '新监控群',
      create: true,
      configPath: cfgPath,
      envPath,
      client: mockClient,
    });
    assert.deepEqual(created, {
      ok: true,
      created: true,
      chatId: 'oc_created_usage',
      name: '新监控群',
    });
    assert.deepEqual((createPayload as { data: { user_id_list: string[] } }).data.user_id_list, [
      'ou_owner_ensure',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
