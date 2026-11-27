import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgyCliWaitingDetector, CORTEX_STEP_STATUS_WAITING, isTrustedAgyCliHolder } from '../src/unified/agy/cli-waiting-detector.js';
import { readAgySummaries, readAgySummaryHierarchy } from '../src/unified/agy/catalog-summaries.js';
import { readReadonlyAgyLiveTurn } from '../src/unified/agy/readonly-live-turn.js';
import type { AgySessionHolder } from '../src/unified/agy/process-guard.js';
import type { Capabilities, NativeSessionRef, Session } from '../src/unified/contracts.js';
import type { PlatformObservation, PlatformPort } from '../src/unified/adapter.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import type { FeishuPort } from '../src/unified/feishu-channel.js';
import { PendingHub } from '../src/unified/hubs/pending-hub.js';
import { UnifiedRuntime, type RuntimeConfig } from '../src/unified/runtime.js';

function createSummariesDb(dbPath: string, rows: Array<Record<string, unknown>>): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      step_count INTEGER,
      last_modified_time TEXT,
      workspace_uris TEXT,
      status TEXT,
      source TEXT,
      project_id TEXT,
      agent_name TEXT,
      parent_conversation_id TEXT,
      nesting_depth INTEGER,
      battle_id TEXT,
      winning_conversation_id TEXT,
      not_fully_idle INTEGER,
      killed INTEGER,
      last_user_input_time TEXT,
      last_user_input_step_index INTEGER,
      app_data_dir TEXT,
      group_id TEXT
    )`);
    const stmt = db.prepare(`INSERT OR REPLACE INTO conversation_summaries VALUES (
      ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    )`);
    for (const r of rows) {
      stmt.run(
        String(r.conversation_id),
        String(r.title ?? ''),
        String(r.preview ?? ''),
        Number(r.step_count ?? 1),
        String(r.last_modified_time ?? '2026-11-26 20:00:00+00:00'),
        String(r.workspace_uris ?? '[]'),
        String(r.status ?? 'CASCADE_RUN_STATUS_IDLE'),
        String(r.source ?? 'cli'),
        String(r.project_id ?? 'default'),
        String(r.agent_name ?? ''),
        String(r.parent_conversation_id ?? ''),
        Number(r.nesting_depth ?? 0),
        '',
        '',
        Number(r.not_fully_idle ?? 0),
        Number(r.killed ?? 0),
        String(r.last_user_input_time ?? '2026-11-26 20:00:00+00:00'),
        Number(r.last_user_input_step_index ?? 0),
        String(r.app_data_dir ?? 'antigravity-cli'),
        '',
      );
    }
  } finally {
    db.close();
  }
}

function createConvStepsDb(dbPath: string, steps: Array<{ idx: number; step_type: number; status: number }>): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL)');
    const stmt = db.prepare('INSERT OR REPLACE INTO steps VALUES (?,?,?)');
    for (const s of steps) stmt.run(s.idx, s.step_type, s.status);
  } finally {
    db.close();
  }
}

function writeTranscript(brainDir: string, cid: string, lines: Array<Record<string, unknown>>): void {
  const logsDir = join(brainDir, cid, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, 'transcript.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function waitForLine(child: ReturnType<typeof spawn>, expected: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for "${expected}", got: ${buf}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.split(/\r?\n/).includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`child exited (${code}) before "${expected}", buf: ${buf}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.on('exit', onExit);
  });
}

test('Gate 1: AgyCliWaitingDetector rejects stale historical status=9, resolves grandchild subagents, and enforces workspace roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-wait-g1-'));
  try {
    const allowedProject = join(root, 'allowed-repo');
    const outsideProject = join(root, 'secret-repo');
    mkdirSync(allowedProject, { recursive: true });
    mkdirSync(outsideProject, { recursive: true });

    const summariesDb = join(root, 'conversation_summaries.db');
    const brainDir = join(root, 'brain');
    const convDir = join(root, 'conversations');
    mkdirSync(brainDir, { recursive: true });
    mkdirSync(convDir, { recursive: true });

    createSummariesDb(summariesDb, [
      {
        conversation_id: 'root-ok',
        title: 'Swarm Protocol Overview',
        workspace_uris: JSON.stringify([`file://${allowedProject}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
      {
        conversation_id: 'child-ok',
        agent_name: 'research-worker',
        parent_conversation_id: 'root-ok',
        nesting_depth: 1,
        workspace_uris: JSON.stringify([`file://${allowedProject}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
      {
        conversation_id: 'grandchild-ok',
        agent_name: 'deep-auditor',
        parent_conversation_id: 'child-ok',
        nesting_depth: 2,
        workspace_uris: JSON.stringify([`file://${allowedProject}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
      {
        conversation_id: 'root-stale',
        title: 'Stale Waiting History',
        workspace_uris: JSON.stringify([`file://${allowedProject}`]),
      },
      {
        conversation_id: 'root-outside',
        title: 'Secret Repo Task',
        workspace_uris: JSON.stringify([`file://${outsideProject}`]),
      },
      {
        conversation_id: 'orphan-child',
        agent_name: 'orphan',
        parent_conversation_id: 'missing-parent',
        nesting_depth: 1,
        workspace_uris: JSON.stringify([`file://${allowedProject}`]),
      },
      {
        conversation_id: 'cycle-a',
        agent_name: 'cyc-a',
        parent_conversation_id: 'cycle-b',
        nesting_depth: 1,
        workspace_uris: JSON.stringify([`file://${allowedProject}`]),
      },
      {
        conversation_id: 'cycle-b',
        agent_name: 'cyc-b',
        parent_conversation_id: 'cycle-a',
        nesting_depth: 1,
        workspace_uris: JSON.stringify([`file://${allowedProject}`]),
      },
      {
        conversation_id: 'killed-child',
        agent_name: 'killed-agent',
        parent_conversation_id: 'root-ok',
        nesting_depth: 1,
        killed: 1,
        workspace_uris: JSON.stringify([`file://${allowedProject}`]),
      },
    ]);

    // Counterexample: step 10 is WAITING (9), but step 11 is DONE (3) -> must NOT alert!
    createConvStepsDb(join(convDir, 'root-stale.db'), [
      { idx: 10, step_type: 132, status: CORTEX_STEP_STATUS_WAITING },
      { idx: 11, step_type: 132, status: 3 },
    ]);
    // Genuine trailing WAITING on grandchild subagent
    createConvStepsDb(join(convDir, 'grandchild-ok.db'), [
      { idx: 1, step_type: 15, status: 3 },
      { idx: 2, step_type: 132, status: CORTEX_STEP_STATUS_WAITING },
    ]);
    writeTranscript(brainDir, 'grandchild-ok', [
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'edit_file', args: { Path: `"${join(allowedProject, 'AGENTS.md')}"` } }],
      },
    ]);
    // Outside-root, orphan, cycle, killed all have status=9 -> all must be rejected!
    for (const id of ['root-outside', 'orphan-child', 'cycle-a', 'killed-child']) {
      createConvStepsDb(join(convDir, `${id}.db`), [{ idx: 5, step_type: 132, status: CORTEX_STEP_STATUS_WAITING }]);
    }

    const holder: AgySessionHolder = { pid: 12345, tty: '/dev/pts/4', cmdline: 'agy', kind: 'external_cli', exe: '/home/zhangzy/.gemini/bin/agy' };
    const holders = new Map<string, AgySessionHolder[]>([
      ['root-stale', [holder]],
      ['grandchild-ok', [holder]],
      ['root-outside', [holder]],
      ['orphan-child', [holder]],
      ['cycle-a', [holder]],
      ['killed-child', [holder]],
    ]);

    const detector = new AgyCliWaitingDetector();
    const res = detector.scan({
      summariesDbPath: summariesDb,
      brainDir,
      conversationsDir: convDir,
      allowedProjectRoots: [allowedProject],
      scanHolders: () => holders,
    });

    assert.equal(res.notices.length, 1);
    assert.equal(res.notices[0]!.waitingConversationId, 'grandchild-ok');
    assert.equal(res.notices[0]!.rootConversationId, 'root-ok');
    assert.equal(res.notices[0]!.rootTitle, 'Swarm Protocol Overview');
    assert.equal(res.notices[0]!.subagentName, 'deep-auditor');
    assert.equal(res.notices[0]!.waitingStepIdx, 2);
    assert.equal(res.notices[0]!.toolSummary, 'edit_file · AGENTS.md');

    // Verify readAgySummaries also exposes activeSubagents for root-ok (including grandchild)
    const summaries = readAgySummaries({ dbPath: summariesDb, brainDir, allowedProjectRoots: [allowedProject] });
    const rootSummary = summaries.find(s => s.conversationId === 'root-ok');
    assert.ok(rootSummary);
    assert.equal(rootSummary.activeSubagentCount, 2);
    assert.deepEqual(
      rootSummary.activeSubagents?.map(s => s.agentName).sort(),
      ['deep-auditor', 'research-worker'],
    );
    assert.equal(readAgySummaryHierarchy(summariesDb).resolveTopAncestor(
      readAgySummaryHierarchy(summariesDb).byId.get('grandchild-ok')!,
    ), 'root-ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gate 1: PendingHub syncLock serializes concurrent syncs and patches cli_notice on content change (A->A->B->withdraw->reactivate)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pending-synclock-'));
  try {
    const sent: Array<{ id: string; card: ChannelCard }> = [];
    const updated: Array<{ id: string; card: ChannelCard }> = [];
    let seq = 0;
    const port = {
      send: async (_dest: string, card: ChannelCard) => {
        const id = `om_${++seq}`;
        sent.push({ id, card });
        return id;
      },
      update: async (_dest: string, msgId: string, card: ChannelCard) => {
        updated.push({ id: msgId, card });
      },
    };
    let currentTitle = 'Task A';
    let active = true;
    let unknown = false;
    const hub = new PendingHub({
      dbPath: join(root, 'pending-hub.sqlite'),
      owner: { source: 'feishu', subject: 'owner-1' },
      destination: 'chat-1',
      port,
      service: {
        listSessions: async () => ({ items: [], nextCursor: null }),
        getSnapshot: async () => { throw new Error('unused'); },
      } as unknown as ConstructorParameters<typeof PendingHub>[0]['service'],
      discoverCliNotices: async () => {
        if (unknown) return { notices: [], unknownRefIds: ['cli_notice:agy:conv-1'] };
        if (!active) return [];
        return [{
          provider: 'agy',
          nativeSessionId: 'conv-1',
          title: currentTitle,
          summary: `步骤等待：${currentTitle}`,
          project: root,
          sourceSessionId: null,
        }];
      },
    });
    try {
      // 1. Initial sync -> sends card once (rev 1)
      const r1 = await hub.sync();
      assert.equal(r1.activeCount, 1);
      const ref1 = hub.getRef('cli_notice:agy:conv-1')!;
      assert.equal(ref1.revision, 1);
      const hubCardId = ref1.hub_card_message_id!;
      assert.ok(hubCardId);
      const cardSent = sent.find(s => s.id === hubCardId)!.card;
      assert.equal(cardSent.actions.filter(a => !a.url).length, 0, 'cli_notice must have zero approve/deny buttons');

      // 2. Identical content (A -> A) -> NO duplicate PATCH on hubCardId
      const updatesBefore = updated.filter(u => u.id === hubCardId).length;
      await hub.sync();
      assert.equal(updated.filter(u => u.id === hubCardId).length, updatesBefore);

      // 3. Content changed (A -> B) -> increments revision and PATCHes same hubCardId
      currentTitle = 'Task B';
      await hub.sync();
      const ref2 = hub.getRef('cli_notice:agy:conv-1')!;
      assert.equal(ref2.revision, 2);
      const cardPatches = updated.filter(u => u.id === hubCardId);
      assert.equal(cardPatches.length, updatesBefore + 1);
      assert.match(cardPatches.at(-1)!.card.title, /Task B/);

      // 4. Transient unknown scan error -> must NOT falsely withdraw active card
      unknown = true;
      const rUnknown = await hub.sync();
      assert.deepEqual(rUnknown.withdrawnRefs, []);
      assert.equal(hub.getRef('cli_notice:agy:conv-1')!.card_active, 1);

      // 5. Cleared -> withdraws same hubCardId (card_active = 0)
      unknown = false;
      active = false;
      const rWithdraw = await hub.sync();
      assert.deepEqual(rWithdraw.withdrawnRefs, ['cli_notice:agy:conv-1']);
      assert.equal(hub.getRef('cli_notice:agy:conv-1')!.card_active, 0);

      // 6. Concurrent syncs during reactivation -> serialized cleanly, final state active=1
      active = true;
      currentTitle = 'Task C';
      await Promise.all([hub.sync(), hub.sync()]);
      const ref3 = hub.getRef('cli_notice:agy:conv-1')!;
      assert.equal(ref3.card_active, 1);
      assert.equal(ref3.hub_card_message_id, hubCardId);
      assert.match(updated.filter(u => u.id === hubCardId).at(-1)!.card.title, /Task C/);
    } finally {
      hub.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gate 2: Real child process /proc + real SQLite WAL (without checkpoint or process exit) triggers and withdraws AGY CLI notice in PendingHub', async () => {
  if (process.platform !== 'linux') return;
  const root = mkdtempSync(join(tmpdir(), 'agy-wal-proc-g2-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const project = join(root, 'repo');
    const brainDir = join(root, 'brain');
    const convDir = join(root, 'conversations');
    const summariesDb = join(root, 'conversation_summaries.db');
    mkdirSync(project, { recursive: true });
    mkdirSync(brainDir, { recursive: true });
    mkdirSync(convDir, { recursive: true });

    const rootCid = 'root-live-wal-1';
    const subCid = 'sub-live-wal-1';
    createSummariesDb(summariesDb, [
      {
        conversation_id: rootCid,
        title: 'Live WAL Test Session',
        workspace_uris: JSON.stringify([`file://${project}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
      {
        conversation_id: subCid,
        agent_name: 'wal-subagent',
        parent_conversation_id: rootCid,
        nesting_depth: 1,
        workspace_uris: JSON.stringify([`file://${project}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
    ]);
    writeTranscript(brainDir, subCid, [
      {
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"git status"' } }],
      },
    ]);

    const subDbPath = join(convDir, `${subCid}.db`);
    const holderScript = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(subDbPath)});
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL)');
      db.prepare('INSERT OR REPLACE INTO steps VALUES (5, 132, 9)').run();
      process.stdout.write('READY_WAITING\\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        if (chunk.includes('RESOLVE_WAL')) {
          db.prepare('UPDATE steps SET status=3 WHERE idx=5').run();
          process.stdout.write('WAL_RESOLVED_STILL_ALIVE\\n');
        } else if (chunk.includes('EXIT')) {
          db.close();
          process.exit(0);
        }
      });
    `;
    child = spawn(process.execPath, ['-e', holderScript], { argv0: 'agy', stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForLine(child, 'READY_WAITING');

    // Negative control: plain node process holding a waiting DB must NOT trigger a false AGY CLI notice.
    const untrustedCid = 'untrusted-node-conv';
    const exitCid = 'exit-withdraw-conv';
    createSummariesDb(summariesDb, [
      {
        conversation_id: rootCid,
        title: 'Live WAL Test Session',
        workspace_uris: JSON.stringify([`file://${project}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
      {
        conversation_id: subCid,
        agent_name: 'wal-subagent',
        parent_conversation_id: rootCid,
        nesting_depth: 1,
        workspace_uris: JSON.stringify([`file://${project}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
      {
        conversation_id: untrustedCid,
        title: 'Plain Node Holder',
        workspace_uris: JSON.stringify([`file://${project}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
      {
        conversation_id: exitCid,
        title: 'Exit Withdraw Session',
        workspace_uris: JSON.stringify([`file://${project}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
    ]);
    const untrustedDbPath = join(convDir, `${untrustedCid}.db`);
    const exitDbPath = join(convDir, `${exitCid}.db`);
    const simpleHolderScript = (dbFile: string) => `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbFile)});
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL)');
      db.prepare('INSERT OR REPLACE INTO steps VALUES (2, 132, 9)').run();
      process.stdout.write('READY\\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { if (chunk.includes('EXIT')) { db.close(); process.exit(0); } });
    `;
    const untrustedChild = spawn(process.execPath, ['-e', simpleHolderScript(untrustedDbPath)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exitChild = spawn(process.execPath, ['-e', simpleHolderScript(exitDbPath)], { argv0: 'agy', stdio: ['pipe', 'pipe', 'pipe'] });
    await Promise.all([waitForLine(untrustedChild, 'READY'), waitForLine(exitChild, 'READY')]);

    const sent: Array<{ id: string; card: ChannelCard }> = [];
    const updated: Array<{ id: string; card: ChannelCard }> = [];
    let msgSeq = 0;
    const port: FeishuPort = {
      isTopicDestination: d => d.startsWith('topic:'),
      send: async (_d, card) => {
        const id = `om_live_${++msgSeq}`;
        sent.push({ id, card });
        return id;
      },
      update: async (_d, id, card) => {
        updated.push({ id, card });
      },
      sendFile: async () => {},
    };

    const config: RuntimeConfig = {
      coreDb: join(root, 'core.sqlite'),
      channelDb: join(root, 'channel.sqlite'),
      ownerOpenId: 'owner-1',
      allowedDestinations: ['chat-1'],
      hostId: 'host-1',
      claudeServiceId: 'claude-svc',
      codexServiceId: 'codex-svc',
      claudeStateDir: join(root, 'claude-state'),
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 1000,
      allowedProjectRoots: [project],
      outputRoots: [],
      agy: {
        enabled: true,
        serviceId: 'agy-svc',
        summariesDbPath: summariesDb,
        brainDir,
        conversationsDir: convDir,
      },
      pendingHub: { enabled: true, destination: 'chat-1' },
      approvalPolicy: { enabled: false },
    };

    // Verify default /proc/<pid>/exe trust check rejects a node process even when it spoofs argv0='agy',
    // while accepting authentic live and in-place self-updated `agy.<ts>.old (deleted)` executables.
    assert.equal(isTrustedAgyCliHolder({ pid: 1, tty: '/dev/pts/1', cmdline: 'agy', kind: 'external_cli', exe: '/home/zhangzy/.gemini/bin/agy' }), true);
    assert.equal(isTrustedAgyCliHolder({ pid: 2, tty: '/dev/pts/1', cmdline: 'agy', kind: 'external_cli', exe: '/home/zhangzy/.local/bin/agy.1795718458729403771.old (deleted)' }), true);
    assert.equal(isTrustedAgyCliHolder({ pid: 3, tty: '/dev/pts/1', cmdline: 'agy', kind: 'external_cli', exe: '/usr/bin/node' }), false);
    assert.equal(isTrustedAgyCliHolder({ pid: 4, tty: '/dev/pts/1', cmdline: 'agy', kind: 'external_cli' }), false);
    const strictDefaultDetector = new AgyCliWaitingDetector();
    const spoofedScan = strictDefaultDetector.scan({
      summariesDbPath: summariesDb,
      brainDir,
      conversationsDir: convDir,
      allowedProjectRoots: [project],
    });
    assert.equal(spoofedScan.notices.length, 0, 'default /proc/<pid>/exe verification must reject node spoofing argv0=agy');

    const trustedTestPids = new Set([child.pid, exitChild.pid]);
    const rt = new UnifiedRuntime(config, port, [], {
      isTrustedAgyCliHolder: (h) => trustedTestPids.has(h.pid),
    });
    try {
      // Phase 1: Real /proc detects both trusted `agy` holders (subCid & exitCid) and ignores plain `node` holder (untrustedCid).
      const s1 = await rt.pendingHub!.sync();
      assert.equal(s1.activeCount, 2);
      assert.equal(rt.pendingHub!.getRef(`cli_notice:agy:${untrustedCid}`), null, 'untrusted plain node holder must not trigger reminder');
      const ref = rt.pendingHub!.getRef(`cli_notice:agy:${subCid}`);
      assert.ok(ref && ref.card_active === 1 && ref.hub_card_message_id);
      const hubMsgId = ref.hub_card_message_id;
      const deliveredCard = sent.find(s => s.id === hubMsgId)!.card;
      assert.match(deliveredCard.title, /Live WAL Test Session · 子代理 wal-subagent/);
      assert.match(deliveredCard.text, /run_command · git status/);
      assert.equal(deliveredCard.actions.filter(a => !a.url).length, 0, 'must have zero approve/deny buttons');

      // Phase 2A: Keep child ALIVE and FD open; update WAL 9 -> 3 WITHOUT checkpointing!
      child.stdin!.write('RESOLVE_WAL\n');
      await waitForLine(child, 'WAL_RESOLVED_STILL_ALIVE');
      assert.equal(child.exitCode, null, 'holder process must still be alive during WAL verification');

      const s2 = await rt.pendingHub!.sync();
      assert.equal(s2.activeCount, 1);
      assert.deepEqual(s2.withdrawnRefs, [`cli_notice:agy:${subCid}`]);
      assert.equal(rt.pendingHub!.getRef(`cli_notice:agy:${subCid}`)!.card_active, 0);
      const withdrawnPatch = updated.filter(u => u.id === hubMsgId).at(-1);
      assert.ok(withdrawnPatch);
      assert.match(withdrawnPatch.card.title, /提醒已撤回/);

      // Phase 2B: Separate process-exit withdrawal (DB still has status=9, holder exits)
      const exitPromise = new Promise<void>((res) => exitChild.once('exit', () => res()));
      exitChild.stdin!.write('EXIT\n');
      await exitPromise;
      const s3 = await rt.pendingHub!.sync();
      assert.equal(s3.activeCount, 0);
      assert.deepEqual(s3.withdrawnRefs, [`cli_notice:agy:${exitCid}`]);
    } finally {
      if (untrustedChild.exitCode === null) { untrustedChild.stdin?.write('EXIT\n'); untrustedChild.kill('SIGTERM'); }
      if (exitChild.exitCode === null) { exitChild.stdin?.write('EXIT\n'); exitChild.kill('SIGTERM'); }
      await rt.close();
    }
  } finally {
    if (child && child.exitCode === null) {
      child.stdin?.write('EXIT\n');
      child.kill('SIGTERM');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gate 2: Readonly display-only live turn projection shows subagents/Codex MCP in Feishu card with ZERO writes to Core.turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-ro-live-g2-'));
  try {
    const project = join(root, 'repo');
    const brainDir = join(root, 'brain');
    const summariesDb = join(root, 'conversation_summaries.db');
    mkdirSync(project, { recursive: true });
    mkdirSync(brainDir, { recursive: true });

    const cid = 'ro-live-conv-1';
    createSummariesDb(summariesDb, [
      {
        conversation_id: cid,
        title: 'CLI Research Run',
        workspace_uris: JSON.stringify([`file://${project}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
      {
        conversation_id: 'ro-sub-1',
        agent_name: 'astra-auditor',
        parent_conversation_id: cid,
        nesting_depth: 1,
        workspace_uris: JSON.stringify([`file://${project}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
    ]);

    // Stage 1: Interim text + invoke_subagent + codex_engineer in transcript
    writeTranscript(brainDir, cid, [
      { step_index: 1, source: 'USER', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>开始深度分析</USER_REQUEST>' },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '我先派发子代理与 Codex MCP 并行核查。',
        tool_calls: [
          { name: 'invoke_subagent', args: { Role: '"Astra Auditor"' } },
          { name: 'call_mcp_tool', args: { ServerName: '"codex-bridge_codex"', ToolName: '"codex_engineer"', Arguments: { tier: 'sol' } } },
        ],
      },
    ]);

    const liveView = readReadonlyAgyLiveTurn(cid, project, { summariesDbPath: summariesDb, brainDir });
    assert.ok(liveView && liveView.running);
    assert.equal(liveView.tools.length, 2);
    assert.equal(liveView.activeSubagents.length, 1);

    let rejectFinalOnce = true;
    const sent: Array<{ id: string; card: ChannelCard }> = [];
    const updated: Array<{ id: string; card: ChannelCard }> = [];
    let seq = 0;
    const port: FeishuPort = {
      isTopicDestination: d => d.startsWith('topic:'),
      send: async (_d, card) => {
        const id = `om_ro_${++seq}`;
        sent.push({ id, card });
        return id;
      },
      update: async (_d, id, card) => {
        if (rejectFinalOnce && card.template === 'green') {
          rejectFinalOnce = false;
          throw Object.assign(new Error('rate limited'), { deliveryKind: 'api_rejected', platformCode: 230429 });
        }
        updated.push({ id, card });
      },
      sendFile: async () => {},
    };

    const avail = { status: 'available' as const };
    const unsup = { status: 'unsupported' as const, reason: 'ro' };
    const roCaps: Capabilities = { view: avail, send: unsup, queue: unsup, steer: unsup, answer: unsup, approve: unsup, interrupt: unsup, handoff: unsup, files: avail, config: unsup };
    const roSession: Session = {
      sessionId: 'session_ro_live_1',
      native: { provider: 'agy', hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId: cid },
      project,
      title: 'CLI Research Run',
      status: 'read_only',
      revision: 1,
      capabilities: roCaps,
      control: { serviceId: 'agy-svc', owner: null, input: 'unavailable', generation: 1, operationId: null, reason: 'discovered agy session is read-only until attached' },
    };
    const fakeProvider = {
      provider: 'agy',
      onObservation: () => () => {},
      list: async () => ({ items: [roSession], nextCursor: null }),
      read: async () => ({ session: roSession, messages: [], turns: [], interactions: [] }),
    } as unknown as PlatformPort;

    const config: RuntimeConfig = {
      coreDb: join(root, 'core.sqlite'),
      channelDb: join(root, 'channel.sqlite'),
      ownerOpenId: 'owner-1',
      allowedDestinations: ['topic:ro-1'],
      hostId: 'host-1',
      claudeServiceId: 'claude-svc',
      codexServiceId: 'codex-svc',
      claudeStateDir: join(root, 'claude-state'),
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 1000,
      allowedProjectRoots: [project],
      outputRoots: [],
      agy: { enabled: true, serviceId: 'agy-svc', summariesDbPath: summariesDb, brainDir },
      approvalPolicy: { enabled: false },
    };

    const prevInterval = process.env.FEISHU_PATCH_INTERVAL_MS;
    process.env.FEISHU_PATCH_INTERVAL_MS = '1';
    const rt = new UnifiedRuntime(config, port, [fakeProvider]);
    try {
      rt.store.insertSession(roSession);
      rt.channel.importMigrationBinding('mig-ro-1', {
        destination: 'topic:ro-1',
        sessionId: roSession.sessionId,
        bindingId: 'bind-ro-1',
        owner: { source: 'feishu', subject: 'owner-1' },
      });

      // Establish cursor then sync -> should create live readonly card WITHOUT writing Core.turns
      await rt.channel.sync('topic:ro-1');
      await rt.channel.sync('topic:ro-1');
      assert.equal(rt.store.listTurns(roSession.sessionId).length, 0, 'readonly projection must NEVER insert fake running turns into Core.turns');
      const liveCard = sent.find(s => /子代理与 Codex 状态/.test(s.card.text));
      assert.ok(liveCard, 'expected running readonly card with subagent/Codex status');
      assert.match(liveCard.card.text, /Astra Auditor/);
      assert.match(liveCard.card.text, /Codex MCP/);
      assert.match(liveCard.card.text, /会话级活跃子代理：astra-auditor/);
      assert.match(liveCard.card.text, /我先派发子代理与 Codex MCP 并行核查。/);

      // P1-1 & P1-3: Intermediate PLANNER_RESPONSE/DONE arriving while running must NOT prematurely close card,
      // and A -> B -> A -> B revisit must PATCH every transition via monotonic patch_seq.
      rt.store.applyHistoryRefresh(rt.store.getSession(roSession.sessionId), 0, {
        session: roSession,
        messages: [{
          messageId: 'interim-msg-ro-1',
          sessionId: roSession.sessionId,
          turnId: 'step-2',
          role: 'assistant',
          blocks: [{ type: 'text', text: '我先派发子代理与 Codex MCP 并行核查。' }],
          sequence: 1,
          revision: 1,
          final: true,
          source: 'transcript',
        }],
        turns: [],
        interactions: [],
      });
      // Transition to B (>20KB preview to verify no broken full_reply button), then back to A, then back to B!
      const longInterimB = '进度 B：' + '详细排查日志。'.repeat(4000);
      writeTranscript(brainDir, cid, [
        { step_index: 1, source: 'USER', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>开始深度分析</USER_REQUEST>' },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: longInterimB,
          tool_calls: [
            { name: 'invoke_subagent', args: { Role: '"Astra Auditor"' } },
          ],
        },
      ]);
      await new Promise(r => setTimeout(r, 5));
      await rt.channel.sync('topic:ro-1');
      assert.equal(updated.some(u => u.card.template === 'green'), false, 'intermediate final step while running must not prematurely close card');
      const patchB1 = updated.filter(u => u.id === liveCard.id).at(-1)!;
      assert.ok(patchB1 && patchB1.card.template === 'blue');
      assert.equal(patchB1.card.actions.some(a => (a.value as { action?: string } | undefined)?.action === 'full_reply'), false, 'readonly preview must not emit broken full_reply button');

      // Revert to A
      writeTranscript(brainDir, cid, [
        { step_index: 1, source: 'USER', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>开始深度分析</USER_REQUEST>' },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: '我先派发子代理与 Codex MCP 并行核查。',
          tool_calls: [{ name: 'invoke_subagent', args: { Role: '"Astra Auditor"' } }],
        },
      ]);
      await new Promise(r => setTimeout(r, 5));
      await rt.channel.sync('topic:ro-1');
      const countAfterA = updated.length;

      // Return to B again -> must PATCH again (no deliveryId collision!)
      writeTranscript(brainDir, cid, [
        { step_index: 1, source: 'USER', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>开始深度分析</USER_REQUEST>' },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: longInterimB,
          tool_calls: [{ name: 'invoke_subagent', args: { Role: '"Astra Auditor"' } }],
        },
      ]);
      await new Promise(r => setTimeout(r, 5));
      await rt.channel.sync('topic:ro-1');
      assert.equal(updated.length, countAfterA + 1, 'A -> B -> A -> B revisit must issue a fresh PATCH');

      // Stage 2: Final response lands in transcript + summaries becomes IDLE -> 1st PATCH is rejected (230429),
      // 2nd sync MUST retry and deliver the final reply on the SAME card (ZERO lost final message!).
      createSummariesDb(summariesDb, [
        {
          conversation_id: cid,
          title: 'CLI Research Run',
          workspace_uris: JSON.stringify([`file://${project}`]),
          status: 'CASCADE_RUN_STATUS_IDLE',
          not_fully_idle: 0,
        },
        {
          conversation_id: 'ro-sub-1',
          agent_name: 'astra-auditor',
          parent_conversation_id: cid,
          nesting_depth: 1,
          workspace_uris: JSON.stringify([`file://${project}`]),
          status: 'CASCADE_RUN_STATUS_IDLE',
          not_fully_idle: 0,
        },
      ]);
      writeTranscript(brainDir, cid, [
        { step_index: 1, source: 'USER', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>开始深度分析</USER_REQUEST>' },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: '我先派发子代理与 Codex MCP 并行核查。',
          tool_calls: [
            { name: 'invoke_subagent', args: { Role: '"Astra Auditor"' } },
            { name: 'call_mcp_tool', args: { ServerName: '"codex-bridge_codex"', ToolName: '"codex_engineer"', Arguments: { tier: 'sol' } } },
          ],
        },
        { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'subagent ok' },
        { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'codex ok' },
        { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '全部核查完成，最终结论已就绪。' },
      ]);
      // Simulate Core history refresh delivering the final assistant message
      rt.store.applyHistoryRefresh(rt.store.getSession(roSession.sessionId), 0, {
        session: roSession,
        messages: [
          {
            messageId: 'interim-msg-ro-1',
            sessionId: roSession.sessionId,
            turnId: 'step-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: '我先派发子代理与 Codex MCP 并行核查。' }],
            sequence: 1,
            revision: 1,
            final: true,
            source: 'transcript',
          },
          {
            messageId: 'final-msg-ro-1',
            sessionId: roSession.sessionId,
            turnId: 'step-5',
            role: 'assistant',
            blocks: [{ type: 'text', text: '全部核查完成，最终结论已就绪。' }],
            sequence: 2,
            revision: 1,
            final: true,
            source: 'transcript',
          },
        ],
        turns: [],
        interactions: [],
      });
      await new Promise(r => setTimeout(r, 5));
      // 1st sync hits injected 230429 api_rejected -> must keep slot and NOT mark final message known
      await rt.channel.sync('topic:ro-1');
      assert.equal(updated.some(u => u.id === liveCard.id && u.card.template === 'green'), false);
      // 2nd sync retries final PATCH and succeeds on the same card!
      await rt.channel.sync('topic:ro-1');

      const finalPatch = updated.filter(u => u.id === liveCard.id).at(-1);
      assert.ok(finalPatch, 'expected in-place PATCH retry on the same readonly card');
      assert.equal(finalPatch.card.template, 'green');
      assert.equal(finalPatch.card.text, '全部核查完成，最终结论已就绪。');
      assert.doesNotMatch(finalPatch.card.text, /子代理与 Codex 状态/);
      assert.equal(rt.store.listTurns(roSession.sessionId).length, 0, 'Core.turns must remain untouched by readonly projection');
    } finally {
      if (prevInterval === undefined) delete process.env.FEISHU_PATCH_INTERVAL_MS;
      else process.env.FEISHU_PATCH_INTERVAL_MS = prevInterval;
      await rt.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gate 1: Dual summaries DB nanosecond tie-break, symlink fallback, partial failure unknownRefIds, and symlink transcript / workspace isolation', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-security-dual-'));
  try {
    const projectA = join(root, 'project-a');
    const projectB = join(root, 'project-b');
    const brainDir = join(root, 'brain');
    const convDir = join(root, 'conversations');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    mkdirSync(brainDir, { recursive: true });
    mkdirSync(convDir, { recursive: true });

    // 1) Dual DB merge with 9-digit nanosecond precision (same millisecond, newer nanosecond wins even with fewer steps)
    const cliDb = join(root, 'cli_summaries.db');
    const ideDb = join(root, 'ide_summaries.db');
    createSummariesDb(cliDb, [
      {
        conversation_id: 'nano-conv',
        title: 'Newer Nanosecond Status',
        step_count: 3,
        last_modified_time: '2026-11-26T20:00:00.123456789Z',
        workspace_uris: JSON.stringify([`file://${projectA}`]),
        status: 'CASCADE_RUN_STATUS_IDLE',
      },
    ]);
    createSummariesDb(ideDb, [
      {
        conversation_id: 'nano-conv',
        title: 'Older Nanosecond Higher Steps',
        step_count: 99,
        last_modified_time: '2026-11-26T20:00:00.123100000Z',
        workspace_uris: JSON.stringify([`file://${projectA}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
      },
    ]);
    const merged = readAgySummaryHierarchy(undefined, { cliPath: cliDb, idePath: ideDb });
    assert.equal(merged.partialFailure, false);
    assert.equal(merged.byId.get('nano-conv')?.title, 'Newer Nanosecond Status');

    // 2) Symlinked CLI DB pointing to regular IDE DB must fall back to regular IDE DB instead of failing
    const cliSymlink = join(root, 'cli_symlink.db');
    symlinkSync(ideDb, cliSymlink);
    const fallbackMerged = readAgySummaryHierarchy(undefined, { cliPath: cliSymlink, idePath: ideDb });
    assert.equal(fallbackMerged.byId.get('nano-conv')?.title, 'Older Nanosecond Higher Steps');

    // 3) Partial failure: corrupt CLI DB + valid IDE DB -> CLI-only waiting session goes into unknownConversationIds
    const corruptCliDb = join(root, 'corrupt_cli.db');
    writeFileSync(corruptCliDb, 'not-a-valid-sqlite-file', 'utf8');
    createConvStepsDb(join(convDir, 'cli-only-waiting.db'), [{ idx: 1, step_type: 132, status: CORTEX_STEP_STATUS_WAITING }]);
    const holder: AgySessionHolder = { pid: 9999, tty: '/dev/pts/8', cmdline: 'agy', kind: 'external_cli', exe: '/home/zhangzy/.gemini/bin/agy' };
    const detector = new AgyCliWaitingDetector();
    const partialRes = detector.scan({
      summariesDefaultPair: { cliPath: corruptCliDb, idePath: ideDb },
      brainDir,
      conversationsDir: convDir,
      allowedProjectRoots: [projectA],
      scanHolders: () => new Map([['cli-only-waiting', [holder]]]),
    });
    assert.equal(partialRes.notices.length, 0);
    assert.deepEqual(partialRes.unknownConversationIds, ['cli-only-waiting']);

    // 4) P0-1: Symlinked session dir or logs dir, cross-project descendants, multi-workspace conflict, and unconfigured app_data_dir
    const secretCid = 'secret-conv-1';
    const victimCid = 'victim-conv-1';
    const unconfiguredBrainDir = join(root, 'unconfigured-brain');
    writeTranscript(brainDir, secretCid, [
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'TOP_SECRET_LEAK_MARKER',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"cat SECRET_KEY"' } }],
      },
    ]);
    writeTranscript(unconfiguredBrainDir, victimCid, [
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'UNCONFIGURED_BRAIN_BODY',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"echo leak"' } }],
      },
    ]);
    // Redirect victim-conv-1/.system_generated/logs -> secret-conv-1/.system_generated/logs
    mkdirSync(join(brainDir, victimCid, '.system_generated'), { recursive: true });
    symlinkSync(
      join(brainDir, secretCid, '.system_generated', 'logs'),
      join(brainDir, victimCid, '.system_generated', 'logs'),
    );
    const secSummaries = join(root, 'sec_summaries.db');
    createSummariesDb(secSummaries, [
      {
        conversation_id: victimCid,
        title: 'Victim Session',
        workspace_uris: JSON.stringify([`file://${projectA}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
        app_data_dir: unconfiguredBrainDir,
      },
      {
        conversation_id: 'cross-proj-sub',
        agent_name: 'CROSS_SCOPE_TITLE',
        parent_conversation_id: victimCid,
        nesting_depth: 1,
        workspace_uris: JSON.stringify([`file://${projectA}`, `file://${projectB}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
      {
        conversation_id: 'killed-mid-sub',
        agent_name: 'killed-mid',
        parent_conversation_id: victimCid,
        nesting_depth: 1,
        killed: 1,
        workspace_uris: JSON.stringify([`file://${projectA}`]),
        status: 'CASCADE_RUN_STATUS_IDLE',
      },
      {
        conversation_id: 'grandchild-of-killed',
        agent_name: 'LIVE_UNDER_KILLED',
        parent_conversation_id: 'killed-mid-sub',
        nesting_depth: 2,
        workspace_uris: JSON.stringify([`file://${projectA}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
    ]);
    createConvStepsDb(join(convDir, `${victimCid}.db`), [{ idx: 3, step_type: 132, status: CORTEX_STEP_STATUS_WAITING }]);
    createConvStepsDb(join(convDir, 'cross-proj-sub.db'), [{ idx: 4, step_type: 132, status: CORTEX_STEP_STATUS_WAITING }]);

    const secScan = detector.scan({
      summariesDbPath: secSummaries,
      brainDir,
      conversationsDir: convDir,
      allowedProjectRoots: [projectA, projectB],
      scanHolders: () => new Map([
        [victimCid, [holder]],
        ['cross-proj-sub', [holder]],
      ]),
    });
    // victimCid emits notice (valid root), but toolSummary MUST be null (symlinked logs dir & unconfigured app_data_dir refused!)
    // cross-proj-sub MUST be rejected because it declares projectB alongside projectA (.every() check)!
    assert.equal(secScan.notices.length, 1);
    assert.equal(secScan.notices[0]!.waitingConversationId, victimCid);
    assert.equal(secScan.notices[0]!.toolSummary, null);

    // readReadonlyAgyLiveTurn must refuse symlinked logs, unconfigured app_data_dir, cross-project descendants, AND killed-ancestor descendants!
    const liveVictim = readReadonlyAgyLiveTurn(victimCid, projectA, { summariesDbPath: secSummaries, brainDir });
    assert.ok(liveVictim);
    assert.equal(liveVictim.previewText, '', 'symlinked/unconfigured transcript must never be disclosed');
    assert.equal(liveVictim.tools.length, 0);
    assert.equal(liveVictim.activeSubagents.length, 0, 'cross-project and killed-ancestor descendants must be filtered out');
    assert.equal(readReadonlyAgyLiveTurn(victimCid, projectB, { summariesDbPath: secSummaries, brainDir }), null, 'mismatched project must fail closed');
    assert.equal(readReadonlyAgyLiveTurn('missing-from-summaries', projectA, { summariesDbPath: secSummaries, brainDir }), null, 'missing summaries row must fail closed');
    // Multi-workspace root mixing [projectA, projectB] must fail closed when queried for projectA only
    const multiRootDb = join(root, 'multi_root_summaries.db');
    createSummariesDb(multiRootDb, [
      {
        conversation_id: 'multi-root-conv',
        title: 'Mixed Root',
        workspace_uris: JSON.stringify([`file://${projectA}`, `file://${projectB}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
      },
    ]);
    assert.equal(readReadonlyAgyLiveTurn('multi-root-conv', projectA, { summariesDbPath: multiRootDb, brainDir }), null, 'root with outside workspace must fail closed');
    const unavail = readReadonlyAgyLiveTurn(victimCid, projectA, { summariesDbPath: corruptCliDb, brainDir });
    assert.equal(unavail?.state, 'unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gate 2: Readonly multi-turn refresh preserves both turns, unavailable defers without duplicate card, and timeout reconciles via lookupDelivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-ro-reconcile-'));
  try {
    const project = join(root, 'repo');
    const brainDir = join(root, 'brain');
    const summariesDb = join(root, 'conversation_summaries.db');
    mkdirSync(project, { recursive: true });
    mkdirSync(brainDir, { recursive: true });

    const cid = 'ro-multi-conv-1';
    createSummariesDb(summariesDb, [
      {
        conversation_id: cid,
        title: 'Multi-Turn CLI Run',
        workspace_uris: JSON.stringify([`file://${project}`]),
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
        last_user_input_step_index: 1,
      },
    ]);
    writeTranscript(brainDir, cid, [
      { step_index: 1, source: 'USER', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>第一轮提问</USER_REQUEST>' },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '第一轮正在调用子代理…',
        tool_calls: [{ name: 'invoke_subagent', args: { Role: '"Worker 1"' } }],
      },
    ]);

    let simulateTimeoutOnce = false;
    let lookupResult: 'sent' | 'not_sent' | 'unknown' = 'sent';
    let lookupCalls = 0;
    const sent: Array<{ id: string; card: ChannelCard }> = [];
    const updated: Array<{ id: string; card: ChannelCard }> = [];
    let seq = 0;
    const port: FeishuPort = {
      isTopicDestination: d => d.startsWith('topic:'),
      send: async (_d, card) => {
        const id = `om_mt_${++seq}`;
        sent.push({ id, card });
        return id;
      },
      update: async (_d, id, card) => {
        if (simulateTimeoutOnce && card.template === 'green') {
          simulateTimeoutOnce = false;
          throw new Error('network timeout');
        }
        updated.push({ id, card });
      },
      lookupDelivery: async () => {
        lookupCalls += 1;
        return lookupResult;
      },
      sendFile: async () => {},
    };

    const avail = { status: 'available' as const };
    const unsup = { status: 'unsupported' as const, reason: 'ro' };
    const roCaps: Capabilities = { view: avail, send: unsup, queue: unsup, steer: unsup, answer: unsup, approve: unsup, interrupt: unsup, handoff: unsup, files: avail, config: unsup };
    const roSession: Session = {
      sessionId: 'session_ro_multi_1',
      native: { provider: 'agy', hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId: cid },
      project,
      title: 'Multi-Turn CLI Run',
      status: 'read_only',
      revision: 1,
      capabilities: roCaps,
      control: { serviceId: 'agy-svc', owner: null, input: 'unavailable', generation: 1, operationId: null, reason: 'read-only' },
    };
    const fakeProvider = {
      provider: 'agy',
      onObservation: () => () => {},
      list: async () => ({ items: [roSession], nextCursor: null }),
      read: async () => ({ session: roSession, messages: [], turns: [], interactions: [] }),
    } as unknown as PlatformPort;

    const config: RuntimeConfig = {
      coreDb: join(root, 'core.sqlite'),
      channelDb: join(root, 'channel.sqlite'),
      ownerOpenId: 'owner-1',
      allowedDestinations: ['topic:ro-mt'],
      hostId: 'host-1',
      claudeServiceId: 'claude-svc',
      codexServiceId: 'codex-svc',
      claudeStateDir: join(root, 'claude-state'),
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 1000,
      allowedProjectRoots: [project],
      outputRoots: [],
      agy: { enabled: true, serviceId: 'agy-svc', summariesDbPath: summariesDb, brainDir },
      approvalPolicy: { enabled: false },
    };

    const prevInterval = process.env.FEISHU_PATCH_INTERVAL_MS;
    process.env.FEISHU_PATCH_INTERVAL_MS = '1';
    const rt = new UnifiedRuntime(config, port, [fakeProvider]);
    try {
      rt.store.insertSession(roSession);
      rt.channel.importMigrationBinding('mig-ro-mt', {
        destination: 'topic:ro-mt',
        sessionId: roSession.sessionId,
        bindingId: 'bind-ro-mt',
        owner: { source: 'feishu', subject: 'owner-1' },
      });

      // Open Turn 1 live card
      await rt.channel.sync('topic:ro-mt');
      await rt.channel.sync('topic:ro-mt');
      const liveCard1 = sent.find(s => /Worker 1/.test(s.card.text));
      assert.ok(liveCard1);
      const sentBeforeMulti = sent.length;

      // Temporarily corrupt summaries DB (unavailable) while Turn 1 final + Turn 2 user + Turn 2 final arrive!
      writeFileSync(summariesDb, 'corrupt-temporarily', 'utf8');
      rt.store.applyHistoryRefresh(rt.store.getSession(roSession.sessionId), 0, {
        session: roSession,
        messages: [
          { messageId: 't1-final', sessionId: roSession.sessionId, turnId: 'step-3', role: 'assistant', blocks: [{ type: 'text', text: 'TURN_1_FINAL_BODY' }], sequence: 1, revision: 1, final: true, source: 'transcript' },
          { messageId: 't2-user', sessionId: roSession.sessionId, turnId: 'step-4', role: 'user', blocks: [{ type: 'text', text: '第二轮提问' }], sequence: 2, revision: 1, final: true, source: 'transcript' },
          { messageId: 't2-final', sessionId: roSession.sessionId, turnId: 'step-5', role: 'assistant', blocks: [{ type: 'text', text: 'TURN_2_FINAL_BODY' }], sequence: 3, revision: 1, final: true, source: 'transcript' },
        ],
        turns: [],
        interactions: [],
      });
      await rt.channel.sync('topic:ro-mt');
      // During unavailable: Turn 1 final MUST be deferred (not sent as a duplicate card!), while Turn 2 is outside Turn 1's boundary and delivers!
      assert.equal(sent.slice(sentBeforeMulti).some(s => s.card.text.includes('TURN_1_FINAL_BODY')), false, 'unavailable must defer Turn 1 final without opening duplicate card');
      assert.equal(sent.slice(sentBeforeMulti).some(s => s.card.text.includes('TURN_2_FINAL_BODY')), true, 'Turn 2 final must NOT be swallowed by Turn 1 slot');

      // Now restore summaries DB as IDLE and inject a transport timeout on Turn 1's final PATCH!
      rmSync(summariesDb, { force: true });
      createSummariesDb(summariesDb, [
        {
          conversation_id: cid,
          title: 'Multi-Turn CLI Run',
          workspace_uris: JSON.stringify([`file://${project}`]),
          status: 'CASCADE_RUN_STATUS_IDLE',
          not_fully_idle: 0,
          last_user_input_step_index: 4,
        },
      ]);
      simulateTimeoutOnce = true;
      lookupResult = 'unknown'; // Matches real FeishuSdkPort behavior after PATCH timeout
      await assert.rejects(() => rt.channel.sync('topic:ro-mt'), /network timeout/);

      // Next sync sees lookupDelivery='unknown' -> clears unknown & schedules idempotent retry; following sync completes PATCH on same card!
      await rt.channel.sync('topic:ro-mt');
      assert.equal(lookupCalls, 1, 'must query port.lookupDelivery to reconcile timed-out PATCH');
      await rt.channel.sync('topic:ro-mt');
      const retriedGreen = updated.filter(u => u.id === liveCard1.id && u.card.template === 'green').at(-1);
      assert.ok(retriedGreen && retriedGreen.card.text === 'TURN_1_FINAL_BODY', 'unknown PATCH timeout must converge idempotently on same card');
      // Subsequent sync is a clean no-op
      await rt.channel.sync('topic:ro-mt');
      assert.equal(lookupCalls, 1);
    } finally {
      if (prevInterval === undefined) delete process.env.FEISHU_PATCH_INTERVAL_MS;
      else process.env.FEISHU_PATCH_INTERVAL_MS = prevInterval;
      await rt.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
