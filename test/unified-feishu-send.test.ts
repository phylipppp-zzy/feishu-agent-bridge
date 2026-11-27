import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FeishuSendError,
  MAX_FEISHU_IMAGE_BYTES,
  inferFeishuUploadFileType,
  inspectSendableFiles,
  listFeishuTopics,
  parseEnvFile,
  resolveFeishuTarget,
  sendToFeishu,
  type FeishuSendTransport,
  type FeishuUploadFileType,
  type ResolvedSendTarget,
} from '../src/unified/feishu-send.js';
import { runFeishuSendCli } from '../src/unified/feishu-send-cli.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function makeTempEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-send-test-'));
  const dbPath = join(dir, 'sdk.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sdk_topic_routes (
      destination TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      root_id TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      session_id TEXT NOT NULL,
      UNIQUE(chat_id, session_id)
    );
  `);
  db.prepare('INSERT INTO sdk_topic_routes VALUES (?, ?, ?, ?, ?)').run(
    'topic:om_root_1',
    'oc_main_chat',
    'om_root_1',
    'omt_1',
    'agy:local:default:aaaa-1111',
  );
  db.prepare('INSERT INTO sdk_topic_routes VALUES (?, ?, ?, ?, ?)').run(
    'topic:om_root_2',
    'oc_main_chat',
    'om_root_2',
    'omt_2',
    'codex:local:default:bbbb-2222',
  );
  db.prepare('INSERT INTO sdk_topic_routes VALUES (?, ?, ?, ?, ?)').run(
    'topic:om_root_3',
    'oc_main_chat',
    'om_root_3',
    'omt_3',
    'session_deadbeef1234',
  );
  db.close();

  const coreDbPath = join(dir, 'core.sqlite');
  const coreDb = new DatabaseSync(coreDbPath);
  coreDb.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, value TEXT NOT NULL);');
  coreDb.prepare('INSERT INTO sessions VALUES (?, ?)').run(
    'session_deadbeef1234',
    JSON.stringify({
      sessionId: 'session_deadbeef1234',
      title: '测试 AGY 会话',
      native: { provider: 'agy', hostId: 'local', serviceId: 'default', nativeSessionId: 'e1530534-test-uuid' },
    }),
  );
  coreDb.close();

  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      sdkDb: dbPath,
      runtime: { allowedDestinations: ['oc_main_chat'], coreDb: coreDbPath },
    }),
  );
  const envPath = join(dir, 'env');
  writeFileSync(envPath, 'FEISHU_APP_ID=cli_test_app\nFEISHU_APP_SECRET="sec_test_value"\n');

  return { dir, dbPath, coreDbPath, configPath, envPath };
}

function createMockTransport() {
  const calls: Array<{ kind: string; target: ResolvedSendTarget; detail: Record<string, unknown> }> = [];
  let seq = 0;
  const transport: FeishuSendTransport = {
    async sendText(target, text) {
      calls.push({ kind: 'text', target, detail: { text } });
      return { messageId: `om_msg_${++seq}` };
    },
    async sendCard(target, title, text) {
      calls.push({ kind: 'card', target, detail: { title, text } });
      return { messageId: `om_msg_${++seq}` };
    },
    async sendImage(target, fileName, content) {
      calls.push({ kind: 'image', target, detail: { fileName, size: content.length } });
      return { messageId: `om_msg_${++seq}`, imageKey: `img_key_${seq}` };
    },
    async sendFile(target, fileName, content, fileType) {
      calls.push({ kind: 'file', target, detail: { fileName, size: content.length, fileType } });
      return { messageId: `om_msg_${++seq}`, fileKey: `file_key_${seq}` };
    },
  };
  return { transport, calls };
}

test('parseEnvFile handles comments, quotes, and whitespace', () => {
  const parsed = parseEnvFile(`
    # comment
    FEISHU_APP_ID = cli_123
    FEISHU_APP_SECRET="secret_456"
    SINGLE='val'
  `);
  assert.deepEqual(parsed, {
    FEISHU_APP_ID: 'cli_123',
    FEISHU_APP_SECRET: 'secret_456',
    SINGLE: 'val',
  });
});

test('resolveFeishuTarget resolves exact session, coreDb nativeSessionId, UUID suffix, latest, and default chat', () => {
  const { dir, dbPath, coreDbPath } = makeTempEnv();
  try {
    const byNative = resolveFeishuTarget({ session: 'e1530534-test-uuid', sdkDbPath: dbPath, coreDbPath });
    assert.deepEqual(byNative, {
      kind: 'topic',
      chatId: 'oc_main_chat',
      rootMessageId: 'om_root_3',
      sessionId: 'session_deadbeef1234',
      destination: 'topic:om_root_3',
      resolvedBy: 'session',
    });

    const bySuffix = resolveFeishuTarget({ session: 'aaaa-1111', sdkDbPath: dbPath, coreDbPath });
    assert.deepEqual(bySuffix, {
      kind: 'topic',
      chatId: 'oc_main_chat',
      rootMessageId: 'om_root_1',
      sessionId: 'agy:local:default:aaaa-1111',
      destination: 'topic:om_root_1',
      resolvedBy: 'session',
    });

    const byLatest = resolveFeishuTarget({ latest: true, sdkDbPath: dbPath });
    assert.equal(byLatest.kind, 'topic');
    assert.equal(byLatest.rootMessageId, 'om_root_3');
    assert.equal(byLatest.resolvedBy, 'latest');

    const byDefault = resolveFeishuTarget({ sdkDbPath: dbPath, defaultChatId: 'oc_main_chat' });
    assert.deepEqual(byDefault, {
      kind: 'chat',
      chatId: 'oc_main_chat',
      resolvedBy: 'default_chat',
    });

    assert.throws(
      () => resolveFeishuTarget({ session: 'nonexistent', sdkDbPath: dbPath }),
      (err: unknown) => err instanceof FeishuSendError && err.code === 'target_not_found',
    );
    assert.throws(
      () => resolveFeishuTarget({ session: 'aaaa-1111', chatId: 'oc_1', sdkDbPath: dbPath }),
      (err: unknown) => err instanceof FeishuSendError && err.code === 'invalid_argument',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectSendableFiles distinguishes real images, fake PNGs, SVGs, sensitive files, and empty files', async () => {
  const { dir } = makeTempEnv();
  try {
    const realPng = join(dir, 'plot.png');
    const fakePng = join(dir, 'fake.png');
    const svgFile = join(dir, 'diagram.svg');
    const emptyFile = join(dir, 'empty.txt');
    const envSecret = join(dir, '.env');
    const subDir = join(dir, 'folder');

    writeFileSync(realPng, PNG_BYTES);
    writeFileSync(fakePng, '<svg>not a png</svg>');
    writeFileSync(svgFile, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(emptyFile, '');
    writeFileSync(envSecret, 'API_KEY=123');
    mkdirSync(subDir);

    const ok = await inspectSendableFiles([realPng, fakePng, svgFile]);
    assert.equal(ok[0]!.mode, 'image');
    assert.equal(ok[1]!.mode, 'file'); // magic bytes not PNG -> safe file mode
    assert.equal(ok[2]!.mode, 'file');
    assert.match(ok[2]!.warning ?? '', /SVG/);

    const forcedFile = await inspectSendableFiles([realPng], { asFile: true });
    assert.equal(forcedFile[0]!.mode, 'file');

    await assert.rejects(
      () => inspectSendableFiles([emptyFile]),
      (err: unknown) => err instanceof FeishuSendError && err.code === 'invalid_file',
    );
    await assert.rejects(
      () => inspectSendableFiles([subDir]),
      (err: unknown) => err instanceof FeishuSendError && err.code === 'invalid_file',
    );
    await assert.rejects(
      () => inspectSendableFiles([envSecret]),
      (err: unknown) => err instanceof FeishuSendError && err.code === 'sensitive_file_blocked',
    );
    const allowedSecret = await inspectSendableFiles([envSecret], { allowSensitive: true });
    assert.equal(allowedSecret[0]!.name, '.env');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized PNG (>10 MiB, <=30 MiB) automatically downgrades to file mode', async () => {
  const { dir } = makeTempEnv();
  try {
    const bigPng = join(dir, 'huge.png');
    const buf = Buffer.alloc(MAX_FEISHU_IMAGE_BYTES + 1024, 0);
    PNG_BYTES.copy(buf, 0);
    writeFileSync(bigPng, buf);

    const inspected = await inspectSendableFiles([bigPng]);
    assert.equal(inspected[0]!.mode, 'file');
    assert.equal(inspected[0]!.downgradedToFile, true);
    assert.match(inspected[0]!.warning ?? '', /10 MiB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendToFeishu sends caption card + image + file to matched session topic and supports dryRun', async () => {
  const { dir, configPath, envPath } = makeTempEnv();
  try {
    const reportPath = join(dir, 'report.md');
    const chartPath = join(dir, 'chart.png');
    writeFileSync(reportPath, '# Summary\nAll green.\n');
    writeFileSync(chartPath, PNG_BYTES);

    const { transport, calls } = createMockTransport();

    const dry = await sendToFeishu({
      files: [reportPath, chartPath],
      session: 'aaaa-1111',
      dryRun: true,
      configPath,
      envPath,
      transport,
    });
    assert.equal(dry.dryRun, true);
    assert.equal(calls.length, 0);
    assert.equal(dry.files[0]!.status, 'dry_run');
    assert.equal(dry.files[1]!.mode, 'image');

    const sent = await sendToFeishu({
      files: [reportPath, chartPath],
      session: 'aaaa-1111',
      title: '实验报告',
      caption: '包含 Markdown 报告与曲线图',
      configPath,
      envPath,
      transport,
    });
    assert.equal(sent.dryRun, false);
    assert.equal(sent.target.kind, 'topic');
    assert.equal(sent.target.rootMessageId, 'om_root_1');
    assert.equal(sent.captionMessageId, 'om_msg_1');
    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.kind, 'card');
    assert.equal(calls[1]!.kind, 'file');
    assert.equal(calls[2]!.kind, 'image');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFeishuSendCli handles --list-topics, --json, and error exit codes', async () => {
  const { dir, dbPath, coreDbPath, configPath, envPath } = makeTempEnv();
  try {
    const listed = listFeishuTopics(dbPath, 20, coreDbPath);
    assert.equal(listed.length, 3);
    assert.equal(listed[0]!.nativeSessionId, 'e1530534-test-uuid');
    assert.equal(listed[0]!.provider, 'agy');

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runFeishuSendCli(['--list-topics', '--json', '--config', configPath, '--env', envPath], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.join('\n')) as { ok: boolean; count: number };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.count, 3);

    const errOut: string[] = [];
    const failCode = await runFeishuSendCli(['--unknown-flag', '--json'], {
      stdout: () => {},
      stderr: (line) => errOut.push(line),
    });
    assert.equal(failCode, 1);
    assert.equal(JSON.parse(errOut.join('\n')).code, 'invalid_argument');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listFeishuTopics and --latest exclude internal hub/task routes and prioritize core.sqlite updatedAt DESC', async () => {
  const { dir, dbPath, coreDbPath, configPath, envPath } = makeTempEnv();
  try {
    const sdkDb = new DatabaseSync(dbPath);
    sdkDb.prepare('INSERT INTO sdk_topic_routes VALUES (?, ?, ?, ?, ?)').run(
      'topic:om_watch_root',
      'oc_main_chat',
      'om_watch_root',
      'omt_watch',
      'watch-hub:root',
    );
    sdkDb.prepare('INSERT INTO sdk_topic_routes VALUES (?, ?, ?, ?, ?)').run(
      'topic:om_pending_root',
      'oc_main_chat',
      'om_pending_root',
      'omt_pending',
      'pending-hub:root',
    );
    sdkDb.prepare('INSERT INTO sdk_topic_routes VALUES (?, ?, ?, ?, ?)').run(
      'topic:om_task_root',
      'oc_main_chat',
      'om_task_root',
      'omt_task',
      'task:alpha',
    );
    sdkDb.close();

    const coreDb = new DatabaseSync(coreDbPath);
    // Give older rowid om_root_1 a NEWER updatedAt than om_root_3
    coreDb.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?)').run(
      'agy:local:default:aaaa-1111',
      JSON.stringify({
        sessionId: 'agy:local:default:aaaa-1111',
        title: '最近活跃会话',
        updatedAt: '2026-11-27T15:30:00.000Z',
        native: { provider: 'agy', hostId: 'local', serviceId: 'default', nativeSessionId: 'aaaa-1111' },
      }),
    );
    coreDb.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?)').run(
      'session_deadbeef1234',
      JSON.stringify({
        sessionId: 'session_deadbeef1234',
        title: '较早会话',
        updatedAt: '2026-11-27T08:00:00.000Z',
        native: { provider: 'agy', hostId: 'local', serviceId: 'default', nativeSessionId: 'e1530534-test-uuid' },
      }),
    );
    coreDb.close();

    const topics = listFeishuTopics(dbPath, 20, coreDbPath);
    assert.equal(topics.length, 3);
    assert.ok(topics.every((t) => !t.sessionId.startsWith('watch-hub:') && !t.sessionId.startsWith('pending-hub:') && !t.sessionId.startsWith('task:')));
    assert.equal(topics[0]!.rootId, 'om_root_1');
    assert.equal(topics[1]!.rootId, 'om_root_3');

    const latestTarget = resolveFeishuTarget({ latest: true, sdkDbPath: dbPath, coreDbPath });
    assert.equal(latestTarget.kind, 'topic');
    assert.equal(latestTarget.rootMessageId, 'om_root_1');

    const { transport, calls } = createMockTransport();
    const sent = await sendToFeishu({
      latest: true,
      caption: '仅发送纯文本进度简报',
      configPath,
      envPath,
      transport,
    });
    assert.equal(sent.target.kind, 'topic');
    assert.equal(sent.target.rootMessageId, 'om_root_1');
    assert.equal(sent.files.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.kind, 'text');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inferFeishuUploadFileType maps document/media extensions and sendToFeishu supports standalone caption/title', async () => {
  const expected: Array<[string, FeishuUploadFileType]> = [
    ['paper.PDF', 'pdf'],
    ['draft.doc', 'doc'],
    ['draft.docx', 'doc'],
    ['table.xls', 'xls'],
    ['table.xlsx', 'xls'],
    ['slides.ppt', 'ppt'],
    ['slides.pptx', 'ppt'],
    ['demo.mp4', 'mp4'],
    ['voice.opus', 'opus'],
    ['notes.md', 'stream'],
    ['archive.tar.gz', 'stream'],
  ];
  for (const [name, ft] of expected) {
    assert.equal(inferFeishuUploadFileType(name), ft);
  }

  const { dir, configPath, envPath } = makeTempEnv();
  try {
    const pdfPath = join(dir, 'paper.pdf');
    const xlsxPath = join(dir, 'metrics.xlsx');
    writeFileSync(pdfPath, '%PDF-1.7 test content');
    writeFileSync(xlsxPath, 'PK\x03\x04xlsx content');

    const { transport, calls } = createMockTransport();
    const fileRes = await sendToFeishu({
      files: [pdfPath, xlsxPath],
      configPath,
      envPath,
      transport,
    });
    assert.equal(fileRes.files[0]!.fileType, 'pdf');
    assert.equal(fileRes.files[1]!.fileType, 'xls');
    assert.equal(calls[0]!.detail.fileType, 'pdf');
    assert.equal(calls[1]!.detail.fileType, 'xls');

    // Standalone card without files
    const cardOnly = await sendToFeishu({
      title: '实验完成通知',
      caption: '全部指标已收敛通过',
      configPath,
      envPath,
      transport,
    });
    assert.equal(cardOnly.files.length, 0);
    assert.ok(cardOnly.captionMessageId);
    assert.equal(calls[2]!.kind, 'card');

    // Neither files nor caption/title -> invalid_argument
    await assert.rejects(
      () => sendToFeishu({ files: [], configPath, envPath, transport }),
      (err: unknown) => err instanceof FeishuSendError && err.code === 'invalid_argument',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
