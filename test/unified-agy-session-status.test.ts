import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildAgyStatusCard } from '../src/unified/agy-status-card.js';
import { scanAgySessionHolders, type AgySessionHolder } from '../src/unified/agy/process-guard.js';
import { collectAgyStatusSnapshot, type AgySessionStatusItem, type AgyStatusSnapshot } from '../src/unified/agy/session-status.js';
import type { UnifiedService } from '../src/unified/adapter.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';
import { parseFeishuAction, parseFeishuText, toFeishuCard } from '../src/unified/feishu-codec.js';
import { handleSdkCardCallback, receiveSdkMessage } from '../src/unified/feishu-sdk-port.js';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const external: AgySessionHolder = { pid: 42, tty: '/dev/pts/[5]', cmdline: 'agy --secret=fixture-secret', kind: 'external_cli' };
const bridge: AgySessionHolder = { pid: 43, tty: '', cmdline: 'agy acp', kind: 'bridge_acp' };

test('scanAgySessionHolders reads exact database paths, deduplicates FDs, and identifies process kinds', {
  skip: process.platform !== 'linux',
}, t => {
  const dir = tempDir(t);
  const procRoot = join(dir, 'proc');
  const conversationsDir = join(dir, 'conversations');
  const db = conversationsDir + '/alpha.db';
  const addProcess = (pid: string, argv: string[], targets: string[]) => {
    const pidDir = join(procRoot, pid);
    mkdirSync(join(pidDir, 'fd'), { recursive: true });
    writeFileSync(join(pidDir, 'cmdline'), argv.join('\0') + '\0');
    targets.forEach((target, fd) => symlinkSync(target, join(pidDir, 'fd', String(fd))));
  };
  const cliPid = process.pid + 1;
  const acpPid = cliPid + 1;
  const workerPid = acpPid + 1;
  const emptyPid = workerPid + 1;
  addProcess(String(cliPid), ['agy', '--conversation', 'alpha'], [
    '/dev/pts/5', db, db + '-wal', db + '-shm', join(conversationsDir, 'beta.db'),
    conversationsDir + '/nested/invalid.db', conversationsDir + '/bad..id.db',
    conversationsDir + '/bad id.db', conversationsDir + '/..db',
    conversationsDir + '/other.db-journal', conversationsDir + '-other/sibling.db',
    conversationsDir + '/missing.db (deleted)',
  ]);
  addProcess(String(acpPid), ['agy', 'acp'], ['pipe:[5]', db + '-shm']);
  addProcess(String(workerPid), ['agy', '--worker'], ['pipe:[6]', join(conversationsDir, 'worker.db-wal')]);
  addProcess(String(process.pid), ['agy'], [join(conversationsDir, 'own.db')]);
  addProcess(String(emptyPid), [], [join(conversationsDir, 'empty.db')]);
  addProcess('not-pid', ['agy'], [join(conversationsDir, 'not-pid.db')]);

  const holders = scanAgySessionHolders(conversationsDir, procRoot);
  assert.deepEqual([...holders.keys()].sort(), ['alpha', 'beta', 'worker']);
  const cli = { pid: cliPid, tty: '/dev/pts/5', cmdline: 'agy --conversation alpha', kind: 'external_cli' };
  assert.deepEqual(holders.get('alpha')?.sort((a, b) => a.pid - b.pid), [
    cli,
    { pid: acpPid, tty: '', cmdline: 'agy acp', kind: 'bridge_acp' },
  ]);
  assert.deepEqual(holders.get('beta'), [cli]);
  assert.equal(holders.get('worker')?.[0]?.kind, 'bridge_acp');
  assert.deepEqual(scanAgySessionHolders(conversationsDir, join(dir, 'missing-proc')), new Map());
});

function createSummaries(dbPath: string, project: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time TEXT NOT NULL,
        workspace_uris TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        battle_id TEXT NOT NULL DEFAULT '',
        winning_conversation_id TEXT NOT NULL DEFAULT '',
        not_fully_idle INTEGER NOT NULL DEFAULT 0,
        killed INTEGER NOT NULL DEFAULT 0,
        last_user_input_time TEXT NOT NULL DEFAULT '',
        last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
        app_data_dir TEXT NOT NULL DEFAULT '',
        group_id TEXT NOT NULL DEFAULT ''
      )
    `);
    const insert = db.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, status, last_modified_time, workspace_uris, not_fully_idle, nesting_depth, parent_conversation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const workspace = JSON.stringify([pathToFileURL(project).href]);
    for (const [id, status, hour, notFullyIdle, nestingDepth, parent] of [
      ['idle-old', 'IDLE', '08', 0, 0, ''],
      ['running-one', 'RUNNING', '09', 0, 0, ''],
      ['canceling-one', 'CANCELING', '10', 0, 0, ''],
      ['busy-one', 'BUSY', '11', 0, 0, ''],
      ['not-fully-idle', 'IDLE', '12', 1, 0, ''],
      ['idle-new', 'IDLE', '13', 0, 0, ''],
      ['unknown-one', 'UNSPECIFIED', '14', 0, 0, ''],
      ['child-one', 'RUNNING', '15', 0, 1, 'idle-new'],
    ] as const) {
      insert.run(id, id, 'CASCADE_RUN_STATUS_' + status, `2026-11-25T${hour}:00:00Z`, workspace, notFullyIdle, nestingDepth, parent);
    }
  } finally {
    db.close();
  }
}

test('collectAgyStatusSnapshot classifies top-level summaries and keeps holders missing from the catalog', t => {
  const dir = tempDir(t);
  const summariesDbPath = join(dir, 'conversation_summaries.db');
  createSummaries(summariesDbPath, dir);
  const options = {
    summariesDbPath,
    scanHolders: () => new Map([
      ['idle-old', [external]],
      ['idle-new', [bridge]],
      ['running-one', [external, bridge]],
      ['only-in-proc', [external]],
      ['bridge-only', [bridge]],
    ]),
  };
  const snapshot = collectAgyStatusSnapshot(options);
  assert.equal(new Date(snapshot.observedAt).toISOString(), snapshot.observedAt);
  assert.equal(snapshot.summariesAvailable, true);
  assert.equal(snapshot.totalSummaries, 7);
  assert.equal(snapshot.error, undefined);
  assert.deepEqual(snapshot.running.map(item => [item.sessionId, item.status, item.notFullyIdle]), [
    ['not-fully-idle', 'idle', true],
    ['busy-one', 'busy', false],
    ['canceling-one', 'canceling', false],
    ['running-one', 'running', false],
  ]);
  assert.deepEqual(snapshot.held.map(item => item.sessionId), [
    'running-one', 'idle-old', 'only-in-proc', 'idle-new', 'bridge-only',
  ]);
  const running = snapshot.running.find(item => item.sessionId === 'running-one');
  assert.equal(running?.project, dir);
  assert.deepEqual(running?.holders, [external, bridge]);
  assert.deepEqual(snapshot.held.find(item => item.sessionId === 'only-in-proc'), {
    sessionId: 'only-in-proc',
    shortId: 'only-in-',
    title: 'Antigravity 会话 · only-in-',
    status: 'unspecified',
    notFullyIdle: false,
    lastModifiedTime: null,
    project: '',
    holders: [external],
  });
  assert.deepEqual(snapshot.completed.map(item => item.sessionId), ['idle-new', 'idle-old']);
  assert.deepEqual(collectAgyStatusSnapshot({ ...options, maxCompleted: 1 }).completed.map(item => item.sessionId), ['idle-new']);
});

test('collectAgyStatusSnapshot distinguishes missing and broken summaries while retaining live holders', t => {
  const summariesDbPath = join(tempDir(t), 'conversation_summaries.db');
  const options = { summariesDbPath, scanHolders: () => new Map([['only-in-proc', [external]]]) };
  const missing = collectAgyStatusSnapshot(options);
  assert.equal(missing.summariesAvailable, false);
  assert.equal(missing.error, undefined);
  assert.equal(missing.held[0]?.sessionId, 'only-in-proc');
  assert.equal(buildAgyStatusCard(missing).template, 'orange');
  writeFileSync(summariesDbPath, 'invalid SQLite file');
  const broken = collectAgyStatusSnapshot(options);
  assert.equal(broken.summariesAvailable, false);
  assert.match(broken.error ?? '', /file is not a database/i);
  assert.deepEqual(broken.held, missing.held);
  assert.equal(buildAgyStatusCard(broken).template, 'grey');
});

const running: AgySessionStatusItem = {
  sessionId: 'abcdef12-full',
  shortId: 'abcdef12',
  title: 'Fix *issue*',
  status: 'running',
  notFullyIdle: true,
  lastModifiedTime: '2026-11-25T16:03:00.000Z',
  project: '/project/[demo]',
  holders: [external, bridge],
};
const idle: AgySessionStatusItem = {
  ...running, sessionId: 'fedcba98-full', shortId: 'fedcba98', title: 'Done', status: 'idle', notFullyIdle: false,
  holders: [external],
};
const empty: AgyStatusSnapshot = {
  observedAt: '2026-11-25T16:05:00.000Z',
  summariesAvailable: true, totalSummaries: 0, running: [], held: [], completed: [],
};

test('buildAgyStatusCard renders Beijing times, escaped fields, categories, and actions', () => {
  const snapshot = { ...empty, totalSummaries: 2, running: [running], held: [running, idle], completed: [idle] };
  const card = buildAgyStatusCard(snapshot);
  assert.equal(card.title, 'Antigravity 会话与进程状态');
  assert.equal(card.template, 'orange');
  const [summary, active, held, completed] = card.text.split('\n\n');
  assert.equal(summary, '进行中 1 · 被进程持有 2（本地终端 2 / 飞书桥接 1） · 最近已完成 1\n采样：11-26 00:05 北京');
  assert.ok(active?.includes('Fix \\*issue\\* · abcdef12 · /project/\\[demo\\] · 运行中 · 11-26 00:03 北京'));
  assert.ok(held?.includes('本地终端 PID 42 (/dev/pts/\\[5\\]) / 飞书桥接 ACP PID 43'));
  assert.ok(completed?.includes('Done · fedcba98 · /project/\\[demo\\] · 11-26 00:03 北京 · 本地终端 PID 42'));
  assert.doesNotMatch(card.text, /fixture-secret/);
  assert.deepEqual(card.actions, [
    { label: '刷新状态', value: { action: 'agy_status' } },
    { label: 'Antigravity 会话列表', value: { action: 'list', provider: 'agy' } },
  ]);
  assert.equal(buildAgyStatusCard({ ...empty, running: [{ ...running, holders: [bridge] }] }).template, 'blue');
  assert.equal(buildAgyStatusCard({ ...empty, held: [idle], completed: [idle] }).template, 'orange');
  assert.equal(buildAgyStatusCard({ ...empty, completed: [{ ...idle, holders: [] }] }).template, 'green');
  assert.equal(buildAgyStatusCard(empty).template, 'grey');
  assert.match(buildAgyStatusCard(empty).text, /当前没有进程持有任何 agy 会话。/);
});

test('buildAgyStatusCard limits each section and labels non-idle variants', () => {
  const active = [
    { ...running, status: 'busy' as const },
    { ...running, status: 'canceling' as const },
    { ...running, status: 'idle' as const },
  ];
  const card = buildAgyStatusCard({
    ...empty,
    running: [...active, ...Array<AgySessionStatusItem>(14).fill(running)],
    held: Array<AgySessionStatusItem>(16).fill(running),
    completed: Array<AgySessionStatusItem>(10).fill(idle),
  });
  const [summary, runningText, heldText, completedText] = card.text.split('\n\n');
  assert.match(summary!, /进行中 17 · 被进程持有 16.*最近已完成 8/);
  assert.match(runningText!, /忙碌[\s\S]*取消中[\s\S]*未完全空闲/);
  assert.equal(runningText!.split('\n').filter(line => line.startsWith('•')).length, 15);
  assert.match(runningText!, /…其余 2 条$/);
  assert.equal(heldText!.split('\n').filter(line => line.startsWith('•')).length, 15);
  assert.match(heldText!, /…其余 1 条$/);
  assert.equal(completedText!.split('\n').filter(line => line.startsWith('•')).length, 8);
  assert.match(completedText!, /…其余 2 条$/);
});

test('Feishu agy commands deliver a new card and the refresh callback updates it in place', async t => {
  const cards: ChannelCard[] = [];
  const updated: Array<[string, ChannelCard]> = [];
  const port: FeishuPort = {
    send: async (_destination, card) => { cards.push(card); return 'status-message'; },
    update: async (_destination, messageId, card) => { updated.push([messageId, card]); },
    sendFile: async () => {},
  };
  let reads = 0;
  const channel = new FeishuChannel({} as UnifiedService, port, async () => true, ':memory:', undefined, false, {
    readAgyStatus: async () => ++reads === 1
      ? { ...empty, running: [running], held: [running], totalSummaries: 1 }
      : { ...empty, completed: [{ ...idle, holders: [] }], totalSummaries: 1 },
  });
  t.after(() => channel.close());
  for (const command of ['/agy', '/agy-status']) {
    assert.deepEqual(parseFeishuText(command), { action: 'agy_status' });
    const invalid = command + ' extra';
    assert.deepEqual(parseFeishuText(invalid), { action: 'command_error', command, rawText: invalid });
    assert.deepEqual(parseFeishuText(invalid, { passthroughUnknownSlash: true }), { action: 'command_error', command, rawText: invalid });
  }
  const destinations = new Set(['main']);
  const handle = channel.handle.bind(channel);
  type MessageEvent = Parameters<typeof receiveSdkMessage>[0];
  const message = {
    sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
    message: {
      message_id: 'agy',
      chat_id: 'main',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '/agy' }),
    },
  } as MessageEvent;
  await receiveSdkMessage(message, 'bot', 'owner', destinations, async () => Readable.from([]), handle);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.template, 'orange');

  const wire = toFeishuCard(cards[0]!) as { elements: Array<{ actions?: Array<{ value: Record<string, unknown> }> }> };
  const refresh = wire.elements.find(element => element.actions)?.actions?.[0]?.value;
  assert.ok(refresh);
  assert.deepEqual(parseFeishuAction(refresh), { action: 'agy_status' });
  const callback = {
    event_id: 'refresh',
    context: { open_message_id: 'status-message', open_chat_id: 'main' },
    operator: { open_id: 'owner' },
    action: { tag: 'button', value: refresh },
  } as Parameters<typeof handleSdkCardCallback>[0];
  await handleSdkCardCallback(callback, 'owner', destinations, chatId => chatId, handle);
  assert.equal(reads, 2);
  assert.equal(cards.length, 1);
  assert.deepEqual(updated.map(([messageId, card]) => [messageId, card.template]), [['status-message', 'green']]);
});
