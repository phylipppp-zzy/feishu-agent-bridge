import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  AgyCatalog,
  deriveAgySessionTitle,
  discoverAgyArtifacts,
  extractAgyUserInput,
  isExcludedAgyArtifactPath,
  parseAgyTimestamp,
  readAgyArtifact,
  readAgySummaries,
  readAgyTranscript,
} from '../src/unified/agy-catalog.js';
import {
  extractTokenUsage,
  readAgyTranscriptCreatedAt,
} from '../src/unified/agy/catalog-transcript.js';
import {
  closeAgyCatalogRefreshWorker,
  getAgyCatalogRefreshWorkerSpawnCount,
} from '../src/unified/agy/catalog-refresh.js';
import { reconcilePersistedAgyHistory } from '../src/unified/agy/transcript-reconciliation.js';
import { discoverNewerSessions, resolveCreatedAtInfo } from '../src/unified/agy/adapter-discovery.js';
import type { Message } from '../src/unified/contracts.js';

test('deriveAgySessionTitle skips role placeholders', () => {
  const id = '33333333-3333-4333-8333-333333333333';
  assert.equal(deriveAgySessionTitle(id, '', '[USER]'), 'Antigravity 会话 · 33333333');
  assert.equal(deriveAgySessionTitle(id, ' [assistant] ', 'First prompt'), 'First prompt');
});

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
        Number(r.step_count ?? 0),
        String(r.last_modified_time ?? '2026-11-22 10:00:00.000000000+00:00'),
        String(r.workspace_uris ?? '[]'),
        String(r.status ?? 'CASCADE_RUN_STATUS_IDLE'),
        String(r.source ?? 'CORTEX_TRAJECTORY_SOURCE_CLI'),
        String(r.project_id ?? ''),
        String(r.agent_name ?? ''),
        String(r.parent_conversation_id ?? ''),
        Number(r.nesting_depth ?? 0),
        String(r.battle_id ?? ''),
        String(r.winning_conversation_id ?? ''),
        Number(r.not_fully_idle ?? 0),
        Number(r.killed ?? 0),
        String(r.last_user_input_time ?? '0001-01-01 00:00:00+00:00'),
        Number(r.last_user_input_step_index ?? -1),
        String(r.app_data_dir ?? 'antigravity'),
        null,
        String(r.group_id ?? ''),
      );
    }
  } finally {
    db.close();
  }
}

const jsonl = (...items: unknown[]): string => items.map((x) => JSON.stringify(x)).join('\n') + '\n';

test('parseAgyTimestamp normalizes nanoseconds and treats 0001-01-01 sentinel as null', () => {
  assert.equal(parseAgyTimestamp('0001-01-01 00:00:00+00:00'), null);
  assert.equal(parseAgyTimestamp('0001-01-01T00:00:00Z'), null);
  assert.equal(parseAgyTimestamp('2026-11-21 14:53:24.288703821+00:00'), '2026-11-21T14:53:24.288Z');
  assert.equal(parseAgyTimestamp('2026-11-21 12:52:18.26099859+00:00'), '2026-11-21T12:52:18.260Z');
  assert.equal(parseAgyTimestamp('2026-11-22T12:54:40Z'), '2026-11-22T12:54:40.000Z');
});

test('readAgySummaries filters top-level sessions, aggregates nested subagents, derives titles, and enforces allowedProjectRoots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-db-'));
  try {
    const allowedRoot = join(dir, 'allowed');
    const siblingPrefixDir = join(dir, 'allowed-other');
    const outsideDir = join(dir, 'outside');
    const projA = join(allowedRoot, 'proj a');
    const projB = join(allowedRoot, 'proj-b');
    const symlinkEscapeProj = join(allowedRoot, 'escape-proj');

    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });
    await mkdir(siblingPrefixDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, symlinkEscapeProj);

    const dbPath = join(dir, 'conversation_summaries.db');
    createSummaryDb(dbPath, [
      {
        conversation_id: '11111111-aaaa-bbbb-cccc-000000000001',
        title: '  Explicit Session Title  ',
        preview: 'should not override title',
        step_count: 14,
        last_modified_time: '2026-11-22 12:00:00.123456789+00:00',
        last_user_input_time: '2026-11-22 11:59:00+00:00',
        last_user_input_step_index: 12,
        workspace_uris: JSON.stringify([pathToFileURL(projA).href]),
        nesting_depth: 0,
        parent_conversation_id: '',
        agent_name: '',
      },
      // Depth 1 & depth 2 subagents under 11111111-...
      {
        conversation_id: 'sub-depth1-idle',
        nesting_depth: 1,
        parent_conversation_id: '11111111-aaaa-bbbb-cccc-000000000001',
        agent_name: 'research',
        status: 'CASCADE_RUN_STATUS_IDLE',
        not_fully_idle: 0,
        workspace_uris: JSON.stringify([pathToFileURL(projA).href]),
      },
      {
        conversation_id: 'sub-depth1-running',
        nesting_depth: 1,
        parent_conversation_id: '11111111-aaaa-bbbb-cccc-000000000001',
        agent_name: 'verifier',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 0,
        workspace_uris: JSON.stringify([pathToFileURL(projA).href]),
      },
      {
        conversation_id: 'sub-depth2-busy',
        nesting_depth: 2,
        parent_conversation_id: 'sub-depth1-running',
        agent_name: 'teamwork_interviewer',
        status: 'CASCADE_RUN_STATUS_IDLE',
        not_fully_idle: 1,
        workspace_uris: JSON.stringify([pathToFileURL(projA).href]),
      },
      {
        conversation_id: 'sub-depth1-killed',
        nesting_depth: 1,
        parent_conversation_id: '11111111-aaaa-bbbb-cccc-000000000001',
        agent_name: 'worker',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        killed: 1,
        workspace_uris: JSON.stringify([pathToFileURL(projA).href]),
      },
      // Depth 0 row that has non-empty agent_name -> must NOT be treated as top-level.
      {
        conversation_id: 'pseudo-top-with-agent',
        nesting_depth: 0,
        parent_conversation_id: '',
        agent_name: 'self',
        workspace_uris: JSON.stringify([pathToFileURL(projA).href]),
      },
      // Empty title -> derive from cleaned preview first line & truncate.
      {
        conversation_id: '22222222-aaaa-bbbb-cccc-000000000002',
        title: '',
        preview:
          '<USER_REQUEST>\n  第一行需求描述需要清洗标签并测试长度截断边界超出三十个字符就会被截断\n第二行补充说明\n</USER_REQUEST>\n<ADDITIONAL_METADATA>cwd=/tmp</ADDITIONAL_METADATA>',
        step_count: 3,
        last_modified_time: '2026-11-22 11:00:00+00:00',
        workspace_uris: JSON.stringify([`file://localhost${encodeURI(projB)}`]),
        nesting_depth: 0,
        parent_conversation_id: '',
        agent_name: '',
      },
      // Empty title and empty preview -> fallback to Antigravity 会话 · <shortId>.
      {
        conversation_id: '33333333-aaaa-bbbb-cccc-000000000003',
        title: '   ',
        preview: '',
        step_count: 0,
        last_modified_time: '0001-01-01 00:00:00+00:00',
        last_user_input_time: '0001-01-01 00:00:00+00:00',
        workspace_uris: JSON.stringify([pathToFileURL(projA).href]),
        nesting_depth: 0,
        parent_conversation_id: '',
        agent_name: '',
      },
      // Outside allowedProjectRoots (sibling prefix /allowed-other must NOT match /allowed).
      {
        conversation_id: '44444444-outside-prefix',
        title: 'Outside Prefix',
        workspace_uris: JSON.stringify([pathToFileURL(siblingPrefixDir).href]),
        nesting_depth: 0,
        parent_conversation_id: '',
        agent_name: '',
      },
      // Symlink pointing outside allowedProjectRoots -> must be rejected.
      {
        conversation_id: '55555555-symlink-escape',
        title: 'Symlink Escape',
        workspace_uris: JSON.stringify([pathToFileURL(symlinkEscapeProj).href]),
        nesting_depth: 0,
        parent_conversation_id: '',
        agent_name: '',
      },
    ]);

    // Make DB read-only on filesystem too to ensure zero write attempts.
    await chmod(dbPath, 0o444);

    const sessions = readAgySummaries({
      dbPath,
      allowedProjectRoots: [allowedRoot],
      maxTitleLength: 24,
    });

    assert.equal(sessions.length, 3);
    assert.deepEqual(
      sessions.map((s) => s.conversationId),
      [
        '11111111-aaaa-bbbb-cccc-000000000001',
        '22222222-aaaa-bbbb-cccc-000000000002',
        '33333333-aaaa-bbbb-cccc-000000000003',
      ],
    );

    const s1 = sessions[0]!;
    assert.equal(s1.title, 'Explicit Session Title');
    assert.equal(s1.project, projA);
    assert.equal(s1.subagentCount, 4);
    assert.equal(s1.activeSubagentCount, 2);
    assert.equal(s1.lastModifiedAt, '2026-11-22T12:00:00.123Z');
    assert.equal(s1.lastUserInputAt, '2026-11-22T11:59:00.000Z');
    assert.equal(s1.lastUserInputStepIndex, 12);

    const s2 = sessions[1]!;
    assert.equal(s2.project, projB);
    assert.equal([...s2.title].length, 24);
    assert.ok(s2.title.startsWith('第一行需求描述需要清洗标签'));
    assert.ok(s2.title.endsWith('…'));
    assert.doesNotMatch(s2.title, /USER_REQUEST|ADDITIONAL_METADATA/);

    const s3 = sessions[2]!;
    assert.equal(s3.title, 'Antigravity 会话 · 33333333');
    assert.equal(s3.lastModifiedAt, null);
    assert.equal(s3.lastUserInputAt, null);

    // Pagination & search via AgyCatalog.
    const catalog = new AgyCatalog({ dbPath, allowedProjectRoots: [allowedRoot], maxTitleLength: 24 });
    catalog.refresh();
    const page1 = catalog.list(2);
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = catalog.list(2, page1.nextCursor!);
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextCursor, null);

    const filtered = catalog.list(10, undefined, 'proj-b');
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0]!.conversationId, '22222222-aaaa-bbbb-cccc-000000000002');

    // Missing DB degrades gracefully to empty list.
    assert.deepEqual(readAgySummaries({ dbPath: join(dir, 'nonexistent.db') }), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractAgyUserInput and readAgyTranscript resolve USER_INPUT, PLANNER_RESPONSE.content, truncated_fields, and incremental cursors', async () => {
  assert.equal(
    extractAgyUserInput(
      '<SYSTEM_MESSAGE>hidden</SYSTEM_MESSAGE>\n<USER_REQUEST>\n  实现增量解析\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>model=x</USER_SETTINGS_CHANGE>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>',
    ),
    '实现增量解析',
  );
  assert.equal(
    extractAgyUserInput('<USER_SETTINGS_CHANGE>only settings</USER_SETTINGS_CHANGE><ADDITIONAL_METADATA>m</ADDITIONAL_METADATA>'),
    '',
  );

  const dir = await mkdtemp(join(tmpdir(), 'agy-transcript-'));
  try {
    const brainDir = join(dir, 'brain');
    const convId = 'conv-main-01';
    const logsDir = join(brainDir, convId, '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });

    const compactPath = join(logsDir, 'transcript.jsonl');
    const fullPath = join(logsDir, 'transcript_full.jsonl');

    const fullUserPrompt = '这是完整用户输入：' + 'X'.repeat(4500);
    const fullAssistantReply = '这是完整助手回复正文：' + 'Y'.repeat(4500);

    await writeFile(
      compactPath,
      jsonl(
        {
          step_index: 0,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          created_at: '2026-11-22T12:00:00Z',
          content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>sys</SYSTEM_MESSAGE>',
        },
        {
          step_index: 1,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-22T12:00:01Z',
          content: `<USER_REQUEST>\n${fullUserPrompt.slice(0, 100)}\n</USER_REQUEST>\n<truncated 4400 bytes>`,
          truncated_fields: ['content'],
        },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-22T12:00:02Z',
          model: 'gemini-4-hydrogen-tiered-xhigh',
          thinking: 'checking files',
          tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/a"' } }],
          input_tokens: 100,
          cache_read_tokens: 200,
          output_tokens: 50,
        },
        {
          step_index: 3,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-22T12:00:02Z',
          model: 'gemini-4-hydrogen-tiered-xhigh',
          thinking: 'thinking truncated...',
          content: `${fullAssistantReply.slice(0, 120)}\n<truncated 4380 bytes>`,
          text: 'WRONG_TEXT_FIELD_MUST_NOT_BE_READ',
          input_tokens: 300,
          cache_read_tokens: 400,
          output_tokens: 150,
          truncated_fields: ['content', 'thinking'],
        },
        {
          step_index: 4,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-22T12:00:03Z',
          content: '<USER_SETTINGS_CHANGE>\neffort=max\n</USER_SETTINGS_CHANGE>',
        },
      ) + '{"step_index":99,"partial":true',
    );

    const compactOnly = await readAgyTranscript(convId, { brainDir });
    const partial = compactOnly.messages.find(message => message.role === 'assistant');
    assert.equal(partial?.final, false);
    assert.equal(partial?.text, fullAssistantReply.slice(0, 120));

    await writeFile(
      fullPath,
      jsonl(
        {
          step_index: 1,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-22T12:00:01Z',
          content: `<USER_REQUEST>\n${fullUserPrompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nhost=linux\n</ADDITIONAL_METADATA>`,
        },
        // Duplicate step_index=3 in transcript_full.jsonl: last row must win.
        {
          step_index: 3,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'GENERATING',
          created_at: '2026-11-22T12:00:02Z',
          content: 'stale partial content',
          thinking: 'stale thinking',
        },
        {
          step_index: 3,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-22T12:00:02Z',
          model: 'gemini-4-hydrogen-tiered-xhigh',
          thinking: 'full detailed reasoning',
          content: fullAssistantReply,
          text: 'WRONG_TEXT_FIELD_MUST_NOT_BE_READ',
          input_tokens: 300,
          cache_read_tokens: 400,
          output_tokens: 150,
        },
      ),
    );

    const r1 = await readAgyTranscript(convId, { brainDir });
    assert.equal(r1.usedFullFallback, false);
    assert.equal(r1.truncatedTrailingLine, true);
    assert.equal(r1.nextLine, 5);
    assert.equal(r1.steps.length, 5);
    assert.equal(r1.messages.length, 2);

    const userMsg = r1.messages[0]!;
    assert.equal(userMsg.role, 'user');
    assert.equal(userMsg.text, fullUserPrompt);
    assert.equal(userMsg.resolvedFromFull, true);

    const assistantMsg = r1.messages[1]!;
    assert.equal(assistantMsg.role, 'assistant');
    assert.equal(assistantMsg.text, fullAssistantReply);
    assert.equal(assistantMsg.thinking, 'full detailed reasoning');
    assert.equal(assistantMsg.model, 'gemini-4-hydrogen-tiered-xhigh');
    assert.deepEqual(assistantMsg.usage, {
      inputTokens: 300,
      cacheReadTokens: 400,
      outputTokens: 150,
      totalTokens: 850,
    });
    assert.equal(assistantMsg.resolvedFromFull, true);

    // Same-second timestamp + afterStepIndex tie-breaker: step 3 has same timestamp as step 2 (12:00:02Z).
    const sinceStep2 = await readAgyTranscript(convId, {
      brainDir,
      sinceTimestamp: '2026-11-22T12:00:02Z',
      afterStepIndex: 2,
    });
    assert.equal(sinceStep2.messages.length, 1);
    assert.equal(sinceStep2.messages[0]!.stepIndex, 3);

    // Complete the trailing line and append a new PLANNER_RESPONSE, then read incrementally after restart.
    await writeFile(
      compactPath,
      (await import('node:fs/promises').then((m) => m.readFile(compactPath, 'utf8'))).replace(
        '{"step_index":99,"partial":true',
        jsonl({
          step_index: 5,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-22T12:00:05Z',
          model: 'gemini-4-hydrogen-tiered-xhigh',
          content: '增量新增助手回复',
          input_tokens: 10,
          cache_read_tokens: 20,
          output_tokens: 5,
        }),
      ),
    );

    const restartedCatalog = new AgyCatalog({ brainDir });
    const delta = await restartedCatalog.readTranscript(convId, { cursor: r1.cursor });
    assert.equal(delta.messages.length, 1);
    assert.equal(delta.messages[0]!.text, '增量新增助手回复');
    assert.equal(delta.messages[0]!.stepIndex, 5);

    // Restart deduplication: re-reading from line 0 yields identical deterministic messageIds.
    const fullReRead = await restartedCatalog.readTranscript(convId);
    assert.equal(fullReRead.messages.length, 3);
    assert.equal(fullReRead.messages[0]!.messageId, r1.messages[0]!.messageId);
    assert.equal(fullReRead.messages[1]!.messageId, r1.messages[1]!.messageId);
    assert.equal(fullReRead.messages[2]!.messageId, delta.messages[0]!.messageId);

    // History pagination cursor also works across restart.
    const h1 = await new AgyCatalog({ brainDir }).history(convId, 2);
    assert.equal(h1.items.length, 2);
    await appendFile(
      compactPath,
      jsonl({
        step_index: 6,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-22T12:00:06Z',
        content: '第四条消息',
      }),
    );
    const h2 = await new AgyCatalog({ brainDir }).history(convId, 10, h1.nextCursor!);
    assert.deepEqual(
      h2.items.map((m) => m.text),
      ['增量新增助手回复', '第四条消息'],
    );

    // Direct afterLine incremental read without cursor.
    const fromLine5 = await readAgyTranscript(convId, { brainDir, afterLine: 5 });
    assert.deepEqual(
      fromLine5.messages.map((m) => m.text),
      ['增量新增助手回复', '第四条消息'],
    );

    // Fallback when only transcript_full.jsonl exists.
    const convFallback = 'conv-full-only';
    const fbLogs = join(brainDir, convFallback, '.system_generated', 'logs');
    await mkdir(fbLogs, { recursive: true });
    await writeFile(
      join(fbLogs, 'transcript_full.jsonl'),
      jsonl({
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-22T12:01:00Z',
        content: '仅存在 transcript_full.jsonl 时的回退正文',
      }),
    );
    const fbResult = await readAgyTranscript(convFallback, { brainDir });
    assert.equal(fbResult.usedFullFallback, true);
    assert.equal(fbResult.messages.length, 1);
    assert.equal(fbResult.messages[0]!.text, '仅存在 transcript_full.jsonl 时的回退正文');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('discoverAgyArtifacts and readAgyArtifact enforce allowlist, excluded dirs/sidecars, credentials, and symlink containment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-artifacts-'));
  try {
    const brainDir = join(dir, 'brain');
    const outsideDir = join(dir, 'outside');
    const convId = 'conv-art-01';
    const sessionDir = join(brainDir, convId);

    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, 'secret.md'), 'TOP_SECRET_OUTSIDE');

    await mkdir(join(sessionDir, 'reports'), { recursive: true });
    await mkdir(join(sessionDir, '.system_generated', 'logs'), { recursive: true });
    await mkdir(join(sessionDir, 'scratch'), { recursive: true });
    await mkdir(join(sessionDir, '.tempmediaStorage'), { recursive: true });
    await mkdir(join(sessionDir, 'browser_sandbox'), { recursive: true });
    await mkdir(join(sessionDir, '.user_uploaded'), { recursive: true });
    await mkdir(join(sessionDir, '.git'), { recursive: true });
    await mkdir(join(sessionDir, '.jj'), { recursive: true });
    await mkdir(join(sessionDir, 'reports', 'scratch'), { recursive: true });

    // Safe artifacts
    await writeFile(join(sessionDir, 'implementation_plan.md'), '# Plan\nSafe plan');
    await writeFile(join(sessionDir, 'reports', 'token_usage_report.md'), '# Token Usage');
    await writeFile(join(sessionDir, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Excluded directories
    await writeFile(join(sessionDir, '.system_generated', 'logs', 'summary.md'), 'internal');
    await writeFile(join(sessionDir, 'scratch', 'draft.md'), 'scratch');
    await writeFile(join(sessionDir, '.tempmediaStorage', 'tmp.png'), 'png');
    await writeFile(join(sessionDir, 'browser_sandbox', 'dom.html'), '<html></html>');
    await writeFile(join(sessionDir, '.user_uploaded', 'input.md'), 'user upload');
    await writeFile(join(sessionDir, '.git', 'note.md'), 'git');
    await writeFile(join(sessionDir, '.jj', 'note.md'), 'jj');
    await writeFile(join(sessionDir, 'reports', 'scratch', 'nested.md'), 'nested scratch');

    // Excluded sidecar files
    await writeFile(join(sessionDir, 'implementation_plan.md.metadata.json'), '{}');
    await writeFile(join(sessionDir, 'implementation_plan.md.resolved'), 'old');
    await writeFile(join(sessionDir, 'implementation_plan.md.resolved.0'), 'old0');
    await writeFile(join(sessionDir, 'ref.url.json'), '{}');

    // Excluded credential files & dotfiles
    await writeFile(join(sessionDir, '.env'), 'SECRET=1');
    await writeFile(join(sessionDir, '.env.local'), 'SECRET=2');
    await writeFile(join(sessionDir, 'credentials.md'), 'creds');
    await writeFile(join(sessionDir, 'my_secret.txt'), 'secret');
    await writeFile(join(sessionDir, 'password_list.md'), 'pass');
    await writeFile(join(sessionDir, 'api_key.txt'), 'key');
    await writeFile(join(sessionDir, 'id_rsa'), 'priv');
    await writeFile(join(sessionDir, 'cert.pem'), 'pem');
    await writeFile(join(sessionDir, '.hidden.md'), 'hidden');

    // Symlink escapes (file + dir)
    await symlink(join(outsideDir, 'secret.md'), join(sessionDir, 'escape.md'));
    await symlink(outsideDir, join(sessionDir, 'escape_dir'));

    const artifacts = await discoverAgyArtifacts(convId, { brainDir });
    assert.deepEqual(
      artifacts.map((a) => a.relativePath),
      ['chart.png', 'implementation_plan.md', 'reports/token_usage_report.md'],
    );
    assert.equal(artifacts[0]!.mediaType, 'image/png');
    assert.equal(artifacts[1]!.mediaType, 'text/markdown');

    const plan = await readAgyArtifact(convId, 'implementation_plan.md', { brainDir });
    assert.equal(Buffer.from(plan.content).toString('utf8'), '# Plan\nSafe plan');
    assert.equal(plan.entry.contentVersion, artifacts[1]!.contentVersion);

    // Expected content version check rejects stale reads.
    await assert.rejects(
      readAgyArtifact(convId, 'implementation_plan.md', {
        brainDir,
        expectedContentVersion: '0'.repeat(64),
      }),
    );

    // Explicit security rejection checks.
    for (const badPath of [
      'escape.md',
      'escape_dir/secret.md',
      '../outside/secret.md',
      '.system_generated/logs/summary.md',
      'scratch/draft.md',
      '.tempmediaStorage/tmp.png',
      'browser_sandbox/dom.html',
      '.user_uploaded/input.md',
      '.git/note.md',
      '.jj/note.md',
      'implementation_plan.md.metadata.json',
      'implementation_plan.md.resolved',
      'implementation_plan.md.resolved.0',
      'ref.url.json',
      '.env',
      'credentials.md',
      'my_secret.txt',
      'api_key.txt',
      '.hidden.md',
    ]) {
      assert.equal(
        isExcludedAgyArtifactPath(badPath) || badPath.includes('escape') || badPath.startsWith('..'),
        true,
        `expected unsafe classification for ${badPath}`,
      );
      await assert.rejects(
        readAgyArtifact(convId, badPath, { brainDir }),
        `readAgyArtifact must reject ${badPath}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readAgyTranscript degrades to compact transcript.jsonl when transcript_full.jsonl exceeds maxBytes and reports warnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-large-full-'));
  try {
    const brainDir = join(dir, 'brain');
    const convId = 'conv-large-01';
    const logsDir = join(brainDir, convId, '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });

    const compactPath = join(logsDir, 'transcript.jsonl');
    const fullPath = join(logsDir, 'transcript_full.jsonl');

    await writeFile(
      compactPath,
      jsonl(
        {
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-22T12:00:00Z',
          content: '<USER_REQUEST>测试大文件降级</USER_REQUEST>',
        },
        {
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-22T12:00:05Z',
          content: '紧凑版回复正文\n<truncated 50000 bytes>',
          truncated_fields: ['content'],
        },
      ),
    );
    // Write a full transcript larger than our test maxBytes (4 KiB)
    await writeFile(
      fullPath,
      jsonl({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-22T12:00:05Z',
        content: 'X'.repeat(8192),
      }),
    );

    const res = await readAgyTranscript(convId, { brainDir, maxBytes: 4096 });
    assert.equal(res.messages.length, 2, 'must not return empty history on oversized transcript_full.jsonl');
    assert.equal(res.messages[0]!.text, '测试大文件降级');
    assert.equal(res.messages[1]!.text, '紧凑版回复正文');
    assert.equal(res.fullTranscriptSkippedReason, 'full_transcript_exceeds_max_bytes');
    assert.ok(res.warnings?.some((w) => w.includes('degraded to compact transcript.jsonl')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readAgyTranscriptCreatedAt reads only 8 KiB header and unknown createdAt is never used as post-watermark proof', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-created-at-'));
  try {
    const brainDir = join(dir, 'brain');
    const proj = join(dir, 'workspace');
    await mkdir(proj, { recursive: true });
    const convWithTs = 'conv-with-ts';
    const convNoTs = 'conv-no-ts';
    const logsWithTs = join(brainDir, convWithTs, '.system_generated', 'logs');
    await mkdir(logsWithTs, { recursive: true });

    // Put valid first line followed by 32 KiB of invalid lines that would fail full parse if read.
    await writeFile(
      join(logsWithTs, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 0,
        type: 'SYSTEM_MESSAGE',
        created_at: '2026-11-22T08:00:00Z',
        content: 'init',
      }) + '\n' + 'NOT_JSON_'.repeat(4000) + '\n',
    );

    const ts = await readAgyTranscriptCreatedAt(convWithTs, { brainDir });
    assert.equal(ts, '2026-11-22T08:00:00.000Z');
    assert.equal(await readAgyTranscriptCreatedAt(convNoTs, { brainDir }), null);

    const dbPath = join(dir, 'conversation_summaries.db');
    createSummaryDb(dbPath, [
      {
        conversation_id: convWithTs,
        title: 'Old Session With Transcript',
        step_count: 2,
        last_modified_time: '2026-11-25 10:00:00+00:00',
        last_user_input_time: '2026-11-25 10:00:00+00:00',
        workspace_uris: JSON.stringify([pathToFileURL(proj).href]),
      },
      {
        conversation_id: convNoTs,
        title: 'Old Session Without Transcript',
        step_count: 2,
        last_modified_time: '2026-11-25 10:00:00+00:00',
        last_user_input_time: '2026-11-25 10:00:00+00:00',
        workspace_uris: JSON.stringify([pathToFileURL(proj).href]),
      },
    ]);

    const catalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [proj] });
    catalog.refresh();
    const fakeCtx: any = {
      catalog,
      transport: { connected: false, connectionGeneration: 1 },
      isClosed: () => false,
      pruneSnapshots: () => {},
      recentDiscovery: new Map(),
      controlEpoch: new Map(),
      serviceId: 'agy-svc',
      buildSession: (id: string, _s: any, _m: any, createdAt?: string) => ({
        sessionId: id,
        createdAt,
        project: proj,
        title: id,
      }),
    };

    const infoNoTs = await resolveCreatedAtInfo(fakeCtx, catalog.get(convNoTs)!);
    assert.deepEqual(infoNoTs, { createdAt: null, source: 'unknown' });

    const infoWithTs = await resolveCreatedAtInfo(fakeCtx, catalog.get(convWithTs)!);
    assert.deepEqual(infoWithTs, { createdAt: '2026-11-22T08:00:00.000Z', source: 'transcript' });

    // Watermark is 2026-11-24: convNoTs has lastModifiedAt on 2026-11-25, but unknown createdAt must NOT pass!
    const newer = await discoverNewerSessions(fakeCtx, Date.parse('2026-11-24T00:00:00Z'), null, 10);
    assert.equal(newer.items.length, 0);
  } finally {
    await closeAgyCatalogRefreshWorker();
    await rm(dir, { recursive: true, force: true });
  }
});

test('AgyCatalog supports multiple brainDirs, reusable refresh worker, and preserves missing token usage fields', async () => {
  // extractTokenUsage must not zero-fill missing/null fields
  assert.deepEqual(extractTokenUsage({ input_tokens: 120, output_tokens: 30 }), {
    inputTokens: 120,
    outputTokens: 30,
  });
  assert.deepEqual(extractTokenUsage({ input_tokens: 120, cache_read_tokens: null, output_tokens: 30 }), {
    inputTokens: 120,
    outputTokens: 30,
  });
  assert.equal(extractTokenUsage({ input_tokens: -1, output_tokens: 10 }), null);
  assert.equal(extractTokenUsage({ input_tokens: null, output_tokens: undefined }), null);

  const dir = await mkdtemp(join(tmpdir(), 'agy-multi-brain-'));
  try {
    const cliBrain = join(dir, 'antigravity-cli', 'brain');
    const ideBrain = join(dir, 'antigravity', 'brain');
    const proj = join(dir, 'workspace');
    await mkdir(proj, { recursive: true });

    const ideConv = 'conv-ide-01';
    const ideLogs = join(ideBrain, ideConv, '.system_generated', 'logs');
    await mkdir(ideLogs, { recursive: true });
    await writeFile(
      join(ideLogs, 'transcript.jsonl'),
      jsonl({
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-22T12:00:00Z',
        content: '<USER_REQUEST>IDE 会话首条提问</USER_REQUEST>',
      }),
    );

    const dbPath = join(dir, 'conversation_summaries.db');
    createSummaryDb(dbPath, [
      {
        conversation_id: ideConv,
        title: '',
        preview: '',
        step_count: 1,
        app_data_dir: 'antigravity',
        workspace_uris: JSON.stringify([pathToFileURL(proj).href]),
      },
    ]);

    const catalog = new AgyCatalog({
      dbPath,
      brainDirs: [cliBrain, ideBrain],
      allowedProjectRoots: [proj],
    });
    const beforeSpawns = getAgyCatalogRefreshWorkerSpawnCount();
    const first = await catalog.refreshAsync();
    const afterFirst = getAgyCatalogRefreshWorkerSpawnCount();
    const second = await catalog.refreshAsync();
    const afterSecond = getAgyCatalogRefreshWorkerSpawnCount();

    assert.equal(first.length, 1);
    assert.equal(first[0]!.title, 'IDE 会话首条提问');
    assert.equal(second.length, 1);
    assert.equal(afterSecond, afterFirst, 'refresh worker should be reused across calls');
    assert.ok(afterFirst >= beforeSpawns);

    const tr = await catalog.readTranscript(ideConv);
    assert.equal(tr.messages.length, 1);
    assert.equal(tr.messages[0]!.text, 'IDE 会话首条提问');
  } finally {
    await closeAgyCatalogRefreshWorker();
    await rm(dir, { recursive: true, force: true });
  }
});

test('discoverAgyArtifacts supports expanded extensions, on-demand scratch, and whitelisted symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-art-ext-'));
  try {
    const brainDir = join(dir, 'brain');
    const outputsDir = join(dir, 'outputs');
    const outsideDir = join(dir, 'outside');
    const convId = 'conv-ext-01';
    const sessionDir = join(brainDir, convId);
    await mkdir(join(sessionDir, 'scratch'), { recursive: true });
    await mkdir(outputsDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    await writeFile(join(sessionDir, 'metrics.json'), '{"ok":true}');
    await writeFile(join(sessionDir, 'analyze.py'), 'print("hi")\n');
    await writeFile(join(sessionDir, 'run.sh'), '#!/bin/sh\necho ok\n');
    await writeFile(join(sessionDir, 'paper.tex'), '\\section{Intro}\n');
    await writeFile(join(sessionDir, 'fig.svg'), '<svg></svg>');
    await writeFile(join(sessionDir, 'config.yaml'), 'a: 1\n');
    await writeFile(join(sessionDir, 'scratch', 'probe.py'), 'print("scratch")\n');

    await writeFile(join(outputsDir, 'result.json'), '{"acc":0.95}');
    await writeFile(join(outputsDir, '.env'), 'SECRET=nope');
    await writeFile(join(outsideDir, 'leak.json'), '{"leak":true}');

    await symlink(join(outputsDir, 'result.json'), join(sessionDir, 'linked_result.json'));
    await symlink(join(outputsDir, '.env'), join(sessionDir, 'linked_secret.json'));
    await symlink(join(outsideDir, 'leak.json'), join(sessionDir, 'linked_outside.json'));

    const defaultList = await discoverAgyArtifacts(convId, {
      brainDir,
      allowedSymlinkRoots: [outputsDir],
    });
    const rels = defaultList.map((e) => e.relativePath);
    assert.deepEqual(rels, [
      'analyze.py',
      'config.yaml',
      'fig.svg',
      'linked_result.json',
      'metrics.json',
      'paper.tex',
      'run.sh',
    ]);

    const withScratch = await discoverAgyArtifacts(convId, {
      brainDir,
      allowedSymlinkRoots: [outputsDir],
      includeScratch: true,
    });
    assert.ok(withScratch.some((e) => e.relativePath === 'scratch/probe.py'));

    const linkedRead = await readAgyArtifact(convId, 'linked_result.json', {
      brainDir,
      allowedSymlinkRoots: [outputsDir],
    });
    assert.equal(Buffer.from(linkedRead.content).toString('utf8'), '{"acc":0.95}');

    await assert.rejects(
      readAgyArtifact(convId, 'linked_outside.json', { brainDir, allowedSymlinkRoots: [outputsDir] }),
    );
    await assert.rejects(
      readAgyArtifact(convId, 'linked_secret.json', { brainDir, allowedSymlinkRoots: [outputsDir] }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reconcilePersistedAgyHistory preserves both sources and marks conflict when repeated prompt has divergent native reply', () => {
  const mkMsg = (
    messageId: string,
    turnId: string,
    role: 'user' | 'assistant',
    text: string,
    sequence: number,
  ): Message => ({
    messageId,
    sessionId: 's1',
    turnId,
    role,
    blocks: [{ type: 'text', text }],
    sequence,
    revision: 1,
    final: true,
    source: 'agy',
  });

  const persisted = new Map<string, Message>([
    ['live-u1', mkMsg('live-u1', 'turn-live-1', 'user', '继续', 1)],
    ['live-a1', mkMsg('live-a1', 'turn-live-1', 'assistant', '本地记录的回复 A', 2)],
  ]);

  const observed = {
    messages: [
      mkMsg('native-u1', 'step-1', 'user', '继续', 1),
      mkMsg('native-a1', 'step-2', 'assistant', '原生完全不同的新回复 B', 2),
    ],
    turns: [],
  };

  const res = reconcilePersistedAgyHistory(observed, persisted);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0]!.reason, 'divergent_reply');
  assert.equal(res.conflicts[0]!.liveTurnId, 'turn-live-1');
  assert.equal(res.conflicts[0]!.nativeTurnId, 'step-1');
  assert.equal(res.snapshot.messages.length, 2, 'must not silently drop divergent native reply');
  const nativeReplyText = res.snapshot.messages[1]!.blocks[0]!;
  assert.equal(nativeReplyText.type, 'text');
  if (nativeReplyText.type === 'text') {
    assert.match(nativeReplyText.text, /对账冲突/);
    assert.match(nativeReplyText.text, /原生完全不同的新回复 B/);
  }
});
