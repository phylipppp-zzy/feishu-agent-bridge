import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { PlatformObservation, PlatformPort, UnifiedService } from '../src/unified/adapter.js';
import { AgyCatalog } from '../src/unified/agy-catalog.js';
import { ArtifactRegistry } from '../src/unified/artifact-registry.js';
import { AgyAdapter } from '../src/unified/agy/adapter.js';
import { handleAcpNotification, handlePromptCompleted } from '../src/unified/agy/adapter-turns.js';
import { readDelegatedSessionActivity } from '../src/unified/agy/delegated-status.js';
import { readReadonlyAgyLiveTurn } from '../src/unified/agy/readonly-live-turn.js';
import type { ActiveTurnState, AdapterContext } from '../src/unified/agy/adapter-types.js';
import { buildArtifactTreeCard } from '../src/unified/artifact-tree-card.js';
import type { ContextUsageInfo } from '../src/unified/context-usage.js';
import type { Artifact, Message, NativeSessionRef, Session, SessionSnapshot, Turn } from '../src/unified/contracts.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';
import { parseFeishuAction } from '../src/unified/feishu-codec.js';
import { LocalCatalog } from '../src/unified/local-catalog.js';
import { EnrichedPort } from '../src/unified/port-enrichment.js';
import { UnifiedCore } from '../src/unified/service.js';
import { UnifiedStore } from '../src/unified/store.js';
import { formatThinkingSummary, readToolProgress, summarizeTool, type ToolProgress } from '../src/unified/tool-progress.js';
import { TurnCardDelivery } from '../src/unified/turn-card-delivery.js';
import { turnFinalReplyCard, turnProcessCard } from '../src/unified/turn-progress-card.js';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-ux-fixes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeSession(ref: NativeSessionRef, project: string, sessionId = 'sess-1'): Session {
  return {
    sessionId,
    native: ref,
    title: 'Test Session',
    project,
    status: 'idle',
    revision: 1,
    updatedAt: new Date().toISOString(),
    control: { serviceId: ref.serviceId, owner: null, input: 'available', generation: 1, operationId: null, reason: null },
    capabilities: {
      view: { status: 'available' },
      send: { status: 'available' },
      queue: { status: 'available' },
      steer: { status: 'unsupported', reason: 'agy does not support mid-turn steer' },
      answer: { status: 'available' },
      approve: { status: 'available' },
      interrupt: { status: 'available' },
      handoff: { status: 'available' },
      files: { status: 'available' },
      config: { status: 'available' },
    },
  };
}

function createSummariesDb(dbPath: string, rows: Array<{
  id: string;
  title?: string;
  status: string;
  notFullyIdle?: number;
  killed?: number;
  parent?: string;
  depth?: number;
  agentName?: string;
  workspace: string;
  lastModified?: string;
  lastUserStep?: number;
}>): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 1,
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
    const ins = db.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, status, last_modified_time, workspace_uris,
        not_fully_idle, killed, nesting_depth, parent_conversation_id, agent_name, last_user_input_step_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      ins.run(
        r.id,
        r.title ?? r.id,
        r.status,
        r.lastModified ?? new Date().toISOString(),
        JSON.stringify([pathToFileURL(r.workspace).href]),
        r.notFullyIdle ?? 0,
        r.killed ?? 0,
        r.depth ?? (r.parent ? 1 : 0),
        r.parent ?? '',
        r.agentName ?? '',
        r.lastUserStep ?? 0,
      );
    }
  } finally {
    db.close();
  }
}

test('Fix #1: standalone 发送文件 button opens new picker card below reply card, paginates in place, and rejects invalid payloads', async t => {
  const dir = tempDir(t);
  const project = join(dir, 'proj');
  mkdirSync(project, { recursive: true });
  const ref: NativeSessionRef = { provider: 'agy', hostId: 'h', serviceId: 's', nativeSessionId: 'conv-files' };
  const session = makeSession(ref, project, 'sess-files');
  const files: Artifact[] = Array.from({ length: 10 }, (_, idx) => ({
    artifactId: `a-${idx}`,
    sessionId: session.sessionId,
    name: idx === 0 ? 'architecture_deep_dive_report.md' : `artifact_${idx}.csv`,
    relativePath: idx === 0 ? 'docs/architecture_deep_dive_report.md' : `outputs/artifact_${idx}.csv`,
    mediaType: 'text/markdown',
    size: 1024 * (idx + 1),
    contentVersion: String(idx).padStart(64, '1'),
  }));
  const msg: Message = {
    messageId: 'm-final',
    sessionId: session.sessionId,
    turnId: 't-1',
    role: 'assistant',
    blocks: [{ type: 'text', text: '已生成产物文件。' }],
    sequence: 1,
    revision: 1,
    final: true,
    source: 'agy',
  };
  const card = turnFinalReplyCard({
    provider: 'agy',
    status: 'completed',
    schema: '2.0',
    message: msg,
    tools: [],
    duration: 4_000,
    files: [files[0]!, files[1]!],
    turnId: 't-1',
    sessionId: session.sessionId,
    sessionConnected: true,
  });
  const sendBtn = card.actions.find(a => a.value.action === 'artifacts');
  assert.ok(sendBtn);
  assert.equal(sendBtn.label, '📎 发送文件 (2)');
  assert.equal(sendBtn.value.newCard, true);
  assert.equal(sendBtn.value.messageId, 'm-final');
  assert.equal(card.actions.some(a => a.value.action === 'file'), false);

  // Positive + negative codec checks
  assert.deepEqual(parseFeishuAction({ ...sendBtn.value, bindingId: 'b-1' }), {
    action: 'artifacts',
    sessionId: session.sessionId,
    newCard: true,
    messageId: 'm-final',
    bindingId: 'b-1',
  });
  assert.throws(() => parseFeishuAction({ action: 'artifacts', newCard: 'yes', bindingId: 'b-1' }), /invalid/);
  assert.throws(() => parseFeishuAction({ action: 'artifacts', messageId: 'm'.repeat(513), bindingId: 'b-1' }), /invalid/);

  const sentCards: Array<{ title: string; text: string; actions: Array<{ label: string; value: Record<string, unknown> }> }> = [];
  const updatedCards: Array<{ id: string; c: { title: string; text: string; actions: Array<{ label: string; value: Record<string, unknown> }> } }> = [];
  const port: FeishuPort = {
    send: async (_d, c) => { sentCards.push(c as never); return `msg-${sentCards.length}`; },
    update: async (_d, id, c) => { updatedCards.push({ id, c: c as never }); },
    sendFile: async () => {},
  };
  const store = new UnifiedStore(join(dir, 'core.sqlite'));
  store.insertSession(session);
  store.putMessage(msg, null);
  const basePort: PlatformPort = {
    provider: 'agy',
    list: async () => ({ items: [session], nextCursor: null }),
    read: async () => ({ session, messages: [msg], interactions: [] }),
    resume: async () => ({ status: 'submitted', nativeReference: ref.nativeSessionId }),
    create: async () => ({ status: 'submitted', nativeReference: ref.nativeSessionId }),
    input: async () => ({ status: 'submitted', nativeReference: 't-2' }),
    interrupt: async () => ({ status: 'submitted', nativeReference: 't-1' }),
    respond: async () => ({ status: 'submitted', nativeReference: null }),
    onObservation: () => () => {},
    listArtifacts: async () => files,
    findRegisteredReplyFiles: () => [files[0]!],
    readArtifact: async () => Buffer.from('ok'),
    listModels: async () => [],
    updateSettings: async () => ({ status: 'submitted', nativeReference: null }),
    control: async () => ({ status: 'submitted', nativeReference: null }),
  };
  const core = new UnifiedCore(store, [basePort], () => true);
  const channel = new FeishuChannel(core, port, async () => true, join(dir, 'chan.sqlite'));
  try {
    await channel.handle({ eventId: 'bind-1', destination: 'chat', identity: { source: 'feishu', subject: 'owner' } }, { action: 'bind', sessionId: session.sessionId });
    const sentBefore = sentCards.length;
    const updBefore = updatedCards.length;
    await channel.handle(
      { eventId: 'open-picker', destination: 'chat', identity: { source: 'feishu', subject: 'owner' }, cardMessageId: 'reply-card-id' },
      sendBtn.value as Parameters<FeishuChannel['handle']>[1],
    );
    assert.equal(sentCards.length, sentBefore + 1, 'newCard=true must send a new card');
    assert.equal(updatedCards.length, updBefore, 'newCard=true must NOT overwrite reply card');
    const picker = sentCards.at(-1)!;
    assert.equal(picker.title, '发送文件 · 对话产物');
    assert.match(picker.text, /architecture_deep_dive_report\.md.*\[本轮\]/);
    const nextPageBtn = picker.actions.find(a => a.label === '下一页');
    assert.ok(nextPageBtn);
    assert.equal(nextPageBtn.value.messageId, 'm-final', 'pagination must retain messageId');
    assert.equal(nextPageBtn.value.newCard, undefined, 'pagination must update in place');

    // Pagination updates the picker card in place instead of sending another card
    const sentBeforePage = sentCards.length;
    await channel.handle(
      { eventId: 'page-2', destination: 'chat', identity: { source: 'feishu', subject: 'owner' }, cardMessageId: 'picker-card-id' },
      nextPageBtn.value as Parameters<FeishuChannel['handle']>[1],
    );
    assert.equal(sentCards.length, sentBeforePage);
    assert.equal(updatedCards.length, updBefore + 1);
    assert.equal(updatedCards.at(-1)?.id, 'picker-card-id');

    const tree = buildArtifactTreeCard([files[1]!, files[0]!], {
      projectDir: project,
      pinnedKeys: [`${files[0]!.relativePath}\0${files[0]!.contentVersion}`],
    });
    assert.equal(tree.items[0]?.artifactId, 'a-0');
  } finally {
    await channel.close();
    store.close();
  }
});

test('Fix #2: EnrichedPort forwards getContextUsage and TurnCardDelivery refreshes updated usage with prior fallback', async t => {
  const dir = tempDir(t);
  const project = join(dir, 'proj');
  mkdirSync(project, { recursive: true });
  const ref: NativeSessionRef = { provider: 'agy', hostId: 'h', serviceId: 's', nativeSessionId: 'conv-ctx' };
  const wrongRef: NativeSessionRef = { provider: 'codex', hostId: 'h', serviceId: 's', nativeSessionId: 'conv-ctx' };
  let calls = 0;
  const makeBase = (withCtx: boolean): PlatformPort => ({
    provider: 'agy',
    list: async () => ({ items: [], nextCursor: null }),
    read: async () => { throw new Error('unused'); },
    resume: async () => ({ status: 'submitted', nativeReference: null }),
    create: async () => ({ status: 'submitted', nativeReference: null }),
    input: async () => ({ status: 'submitted', nativeReference: null }),
    interrupt: async () => ({ status: 'submitted', nativeReference: null }),
    respond: async () => ({ status: 'submitted', nativeReference: null }),
    onObservation: () => () => {},
    listArtifacts: async () => [],
    readArtifact: async () => new Uint8Array(),
    listModels: async () => [],
    updateSettings: async () => ({ status: 'submitted', nativeReference: null }),
    control: async () => ({ status: 'submitted', nativeReference: null }),
    ...(withCtx ? {
      getContextUsage: async () => {
        calls += 1;
        return {
          usedTokens: 120_000 * calls,
          maxTokens: 1_048_576,
          model: 'gemini-4-neon-high',
          totalInputTokens: 100_000,
          cacheReadTokens: 88_000,
        };
      },
    } : {}),
  });

  const catalog = new LocalCatalog([]);
  const registry = new ArtifactRegistry({}, 20 * 1024 * 1024, join(dir, 'artifacts.json'));
  const enriched = new EnrichedPort(makeBase(true), catalog, registry, () => {});
  const enrichedNoCtx = new EnrichedPort(makeBase(false), catalog, registry, () => {});
  try {
    assert.equal((await enriched.getContextUsage(ref))?.usedTokens, 120_000);
    assert.equal((await enriched.getContextUsage(ref))?.usedTokens, 240_000);
    await assert.rejects(() => enriched.getContextUsage(wrongRef), { code: 'invalid_request' });
    assert.equal(await enrichedNoCtx.getContextUsage(ref), null);
  } finally {
    await enriched.close();
    await enrichedNoCtx.close();
  }

  // Real TurnCardDelivery refresh regression: 1st reply caches 120K -> 2nd refresh pulls 240K -> 3rd failure keeps 240K
  const db = new DatabaseSync(join(dir, 'chan-ctx.sqlite'));
  db.exec(`CREATE TABLE channel_deliveries (delivery_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE channel_delivery_diagnostics (delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL, platform_code INTEGER);
    CREATE TABLE channel_history_baselines (destination TEXT NOT NULL, session_id TEXT NOT NULL, binding_scope TEXT NOT NULL, PRIMARY KEY(destination,session_id,binding_scope));
    CREATE TABLE channel_known_messages (destination TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(destination,session_id,message_id));`);
  let mode: 'first' | 'second' | 'throw' = 'first';
  const writes: Array<{ kind: 'send' | 'patch'; footer?: string | undefined }> = [];
  const service = {
    getContextUsage: async (): Promise<ContextUsageInfo | null> => {
      if (mode === 'throw') throw new Error('transient');
      return {
        usedTokens: mode === 'first' ? 120_000 : 240_000,
        maxTokens: 1_048_576,
        model: 'gemini-4-neon-high',
      };
    },
    getConfirmedSettings: async () => null,
    findRegisteredReplyFiles: async () => [],
  } as unknown as UnifiedService;
  const port: FeishuPort = {
    send: async (_d, card) => { writes.push({ kind: 'send', footer: card.footer }); return `card-${writes.length}`; },
    update: async (_d, _id, card) => { writes.push({ kind: 'patch', footer: card.footer }); },
    sendFile: async () => {},
  };
  const delivery = new TurnCardDelivery(db, service, port, {
    guard: async () => {},
    stamp: (_d, c) => c,
    wake: () => {},
  });
  try {
    const session = makeSession(ref, project, 'sess-ctx');
    const key = ['chat', session.sessionId, '{"access_mode":"interactive"}'] as const;
    const turn: Turn = {
      turnId: 't-ctx', sessionId: session.sessionId, status: 'completed',
      inputId: null, startedAt: new Date(Date.now() - 5_000).toISOString(), endedAt: new Date().toISOString(),
      model: 'gemini-4-neon-high', outputIds: ['m-ctx'],
    };
    const syncReply = async (rev: number, text: string) => {
      const msg: Message = {
        messageId: 'm-ctx', sessionId: session.sessionId, turnId: turn.turnId,
        role: 'assistant', blocks: [{ type: 'text', text }], sequence: 1, revision: rev, final: true, source: 'agy',
      };
      const snap: SessionSnapshot = { session, turns: [turn], messages: [msg], interactions: [], turnProgress: { tools: [], timing: [] } };
      await delivery.sync([...key], snap, [{
        schemaVersion: 1, eventId: `e-${rev}`, sessionId: session.sessionId, objectId: turn.turnId, objectRevision: rev,
        sequence: rev, type: 'turn.updated', occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
        operationId: null, cursor: String(rev), data: turn,
      }], [msg], () => true);
    };
    await syncReply(1, '第一版回复');
    assert.match(writes.at(-1)?.footer ?? '', /120K/);

    mode = 'second';
    await syncReply(2, '第二版更新回复');
    assert.match(writes.at(-1)?.footer ?? '', /240K/, 'reply refresh must fetch fresh contextUsage instead of freezing prior 120K');

    mode = 'throw';
    await syncReply(3, '第三版回退回复');
    assert.match(writes.at(-1)?.footer ?? '', /240K/, 'when getContextUsage throws, must retain prior 240K fallback');
  } finally {
    delivery.close();
    db.close();
  }
});

test('Fix #3: formatThinkingSummary preserves word boundaries and multiline breaks while enforcing caps', () => {
  const prefix = 'Exploring system capabilities and loopback network settings to determine why previous egress rules bypassed expected translation paths. ';
  const repeated = prefix.repeat(18);
  const formatted = formatThinkingSummary(repeated);
  assert.ok(formatted.startsWith('🧠 …'));
  assert.ok([...formatted].length <= 1200);
  assert.ok([...formatted].length >= 900);
  const firstWord = /^🧠 …(\S+)/.exec(formatted)?.[1] ?? '';
  assert.ok(prefix.split(/\s+/).includes(firstWord), `expected clean whole-word boundary, got firstWord=${firstWord}`);
  assert.ok(readToolProgress({ turnId: 't1', callId: 'phase:thinking', phase: 'running', tool: 'thinking', summary: formatted }));

  // Multiline thinking accepted; non-\n control chars & >1200 rejected; normal tool \n & >120 rejected
  const multiline = formatThinkingSummary('第一段分析。\n\n第二段结论。');
  assert.match(multiline, /\n\n/);
  assert.ok(readToolProgress({ turnId: 't1', callId: 'phase:thinking', phase: 'running', tool: 'thinking', summary: multiline }));
  assert.equal(readToolProgress({ turnId: 't1', callId: 'phase:thinking', phase: 'running', tool: 'thinking', summary: 'x'.repeat(1201) }), undefined);
  assert.equal(readToolProgress({ turnId: 't1', callId: 'phase:thinking', phase: 'running', tool: 'thinking', summary: 'abc\u0007def' }), undefined);
  assert.equal(readToolProgress({ turnId: 't1', callId: 'c1', phase: 'running', tool: 'read_file', summary: 'line1\nline2' }), undefined);
  assert.equal(readToolProgress({ turnId: 't1', callId: 'c1', phase: 'running', tool: 'read_file', summary: 'x'.repeat(121) }), undefined);
});

test('Fix #4: delegated status enforces project/killed isolation, real dead-PID detection, and accurate dispatch suppression', t => {
  const dir = tempDir(t);
  const projectA = join(dir, 'projA');
  const projectB = join(dir, 'projB');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  const summariesDb = join(dir, 'summaries.db');
  const scratchDir = join(dir, 'dispatch-scratch');
  mkdirSync(scratchDir, { recursive: true });

  const rootId = '11111111-1111-1111-1111-111111111111';
  const subWorkerId = '22222222-2222-2222-2222-222222222222';
  const killedSubId = '22222222-2222-2222-2222-222222222223';
  const otherRootId = '99999999-9999-9999-9999-999999999999';
  createSummariesDb(summariesDb, [
    { id: rootId, status: 'CASCADE_RUN_STATUS_RUNNING', workspace: projectA },
    { id: subWorkerId, status: 'CASCADE_RUN_STATUS_RUNNING', parent: rootId, agentName: 'Carbon High DNS Review', workspace: projectA },
    { id: killedSubId, status: 'CASCADE_RUN_STATUS_RUNNING', killed: 1, parent: rootId, agentName: 'Killed Worker', workspace: projectA },
    { id: otherRootId, status: 'CASCADE_RUN_STATUS_RUNNING', workspace: projectA },
  ]);

  // Poisoned subagent_parents.json trying to route killedSubId back to rootId
  writeFileSync(join(scratchDir, 'subagent_parents.json'), JSON.stringify({
    [killedSubId]: { parent: rootId },
  }));

  // 1) Legit live Codex job inside projectA
  const jobDir = join(scratchDir, 'job-20261128-010000-abcdef12');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job_state.json'), JSON.stringify({
    state: 'running',
    backend: 'codex',
    tier: 'astra',
    cwd: projectA,
    conversation_id: subWorkerId,
    started_at_utc: new Date(Date.now() - 75_000).toISOString(),
  }));
  writeFileSync(join(jobDir, 'events.jsonl'), `${JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'pytest -q' } })}\n`);

  // 2) Cross-project job (cwd = projectB) owned by subWorkerId -> MUST BE BLOCKED!
  const crossProjJob = join(scratchDir, 'job-20261128-010000-crossproj');
  mkdirSync(crossProjJob, { recursive: true });
  writeFileSync(join(crossProjJob, 'job_state.json'), JSON.stringify({
    state: 'running',
    backend: 'codex',
    tier: 'sol',
    cwd: projectB,
    conversation_id: subWorkerId,
    started_at_utc: new Date(Date.now() - 20_000).toISOString(),
  }));

  // 3) Job owned by killedSubId -> MUST BE BLOCKED even with subagent_parents.json!
  const killedJob = join(scratchDir, 'job-20261128-010000-killedjob');
  mkdirSync(killedJob, { recursive: true });
  writeFileSync(join(killedJob, 'job_state.json'), JSON.stringify({
    state: 'running',
    backend: 'codex',
    tier: 'luna',
    cwd: projectA,
    conversation_id: killedSubId,
    started_at_utc: new Date(Date.now() - 10_000).toISOString(),
  }));

  // 4) Unrelated root job -> MUST BE BLOCKED
  const otherJob = join(scratchDir, 'job-20261128-010000-00000000');
  mkdirSync(otherJob, { recursive: true });
  writeFileSync(join(otherJob, 'job_state.json'), JSON.stringify({
    state: 'running',
    backend: 'codex',
    tier: 'sol',
    cwd: projectA,
    conversation_id: otherRootId,
    started_at_utc: new Date(Date.now() - 20_000).toISOString(),
  }));

  const activities = readDelegatedSessionActivity(rootId, projectA, {
    summariesDbPath: summariesDb,
    dispatchScratchDir: scratchDir,
    isJobAlive: () => true,
  });
  assert.equal(activities.length, 2, 'must return ONLY authorized subagent + projectA dispatch job');
  assert.ok(activities.some(a => a.kind === 'dispatch_job' && a.agentName === 'astra' && a.activity === '执行命令: pytest'));
  assert.ok(activities.some(a => a.kind === 'subagent' && a.agentName === 'Carbon High DNS Review'));

  // Fail-closed checks: wrong project & missing DB must return []
  assert.deepEqual(readDelegatedSessionActivity(rootId, projectB, { summariesDbPath: summariesDb, dispatchScratchDir: scratchDir, isJobAlive: () => true }), []);
  assert.deepEqual(readDelegatedSessionActivity(rootId, projectA, { summariesDbPath: join(dir, 'missing.db'), dispatchScratchDir: scratchDir, isJobAlive: () => true }), []);

  // Real isJobAliveFast check (NO mock!): dead PID must converge 'running' -> 'failed'
  const deadJobDir = join(scratchDir, 'job-20261128-010000-deadpid1');
  mkdirSync(deadJobDir, { recursive: true });
  writeFileSync(join(deadJobDir, 'job_state.json'), JSON.stringify({
    state: 'running',
    backend: 'codex',
    tier: 'sol',
    cwd: projectA,
    pid: 999999999,
    conversation_id: subWorkerId,
    started_at_utc: new Date(Date.now() - 30_000).toISOString(),
  }));
  const realActivities = readDelegatedSessionActivity(rootId, projectA, {
    summariesDbPath: summariesDb,
    dispatchScratchDir: scratchDir,
  });
  const deadItem = realActivities.find(a => a.conversationId === 'dispatch:job-20261128-010000-deadpid1');
  assert.equal(deadItem?.status, 'failed', 'dead PID running job must converge to failed via real isJobAliveFast');

  // Card rendering: suppresses succeeded invoke_subagent & succeeded codex_engineer launch echo, keeps codex_job(wait)
  const card = turnProcessCard({
    provider: 'agy',
    status: 'running',
    schema: '2.0',
    message: undefined,
    tools: [
      { turnId: 't1', callId: 'c-sub', phase: 'succeeded', ...summarizeTool('invoke_subagent', { Role: 'Carbon High DNS Review' }) },
      { turnId: 't1', callId: 'c-mcp', phase: 'succeeded', ...summarizeTool('call_mcp_tool', { ServerName: 'codex-bridge_codex', ToolName: 'codex_engineer', Arguments: { tier: 'astra' } }) },
      { turnId: 't1', callId: 'c-wait', phase: 'running', ...summarizeTool('call_mcp_tool', { ServerName: 'codex-bridge_codex', ToolName: 'codex_job', Arguments: { action: 'wait', job_id: 'job-20261128-010000-abcdef12' } }) },
    ],
    duration: null,
    files: [],
    turnId: 't1',
    activeSubagents: activities,
  });
  assert.match(card.text, /⚡ Codex \\\[astra\\\]（运行中 · .*执行命令: pytest）/);
  assert.match(card.text, /等待作业/);
  assert.doesNotMatch(card.text, /派发子代理：Carbon High DNS Review/);
  assert.doesNotMatch(card.text, /工程实现/);

  // Ordinary call_mcp_tool must NOT set awaitingAsyncWakeup, whereas Codex MCP MUST
  const turnA: ActiveTurnState = {
    turnId: 't-mcp', generation: 1, model: null, startedAt: new Date().toISOString(),
    assistantMessageId: null, assistantSequence: null, assistantRevision: 0, assistantText: '',
    assistantFinalized: false, interrupted: false, cancelRequested: false,
    inProgressToolCalls: new Set(), toolCalls: new Map(), fullToolCalls: new Set(), approvalRequestIds: new Map(),
  };
  const mcpCtx = {
    transport: { connected: true, connectionGeneration: 1 },
    catalog: { get: () => undefined },
    active: new Set([rootId]),
    activeTurns: new Map([[rootId, turnA]]),
    knownSessions: new Map([[rootId, { cwd: projectA, title: 't', updatedAt: new Date().toISOString() }]]),
    requests: new Map(),
    isClosed: () => false,
    nextSequence: () => 1,
    ref: () => ({ provider: 'agy', hostId: 'h', serviceId: 's', nativeSessionId: rootId }),
    emit: () => {},
    putSessionTurn: () => {},
    upsertLiveMessage: () => {},
  } as unknown as AdapterContext;
  handleAcpNotification(mcpCtx, {
    generation: 1,
    method: 'session/update',
    params: {
      sessionId: rootId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'call_mcp_tool', status: 'in_progress', rawInput: { ToolName: 'lookup_paper' } },
    },
  });
  assert.equal(turnA.awaitingAsyncWakeup, undefined, 'ordinary sync call_mcp_tool must not set awaitingAsyncWakeup');
  handleAcpNotification(mcpCtx, {
    generation: 1,
    method: 'session/update',
    params: {
      sessionId: rootId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc-2', name: 'call_mcp_tool', status: 'in_progress', rawInput: { ServerName: 'codex-bridge_codex', ToolName: 'codex_engineer', Arguments: { tier: 'sol' } } },
    },
  });
  assert.equal(turnA.awaitingAsyncWakeup, true, 'Codex MCP call_mcp_tool must set awaitingAsyncWakeup');
});

test('Fix #5: AGY network error banner classifies DNS/EOF, redacts secrets, isolates across turns, and ignores prose quotes', t => {
  const dir = tempDir(t);
  const brainDir = join(dir, 'brain');
  const runCase = (convId: string, transcriptRows: unknown[], assistantText: string) => {
    const logDir = join(brainDir, convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'transcript.jsonl'), transcriptRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const emitted: PlatformObservation[] = [];
    const ref: NativeSessionRef = { provider: 'agy', hostId: 'h', serviceId: 's', nativeSessionId: convId };
    const turnState: ActiveTurnState = {
      turnId: `turn-${convId}`, generation: 1, model: 'gemini-4-neon', startedAt: new Date().toISOString(),
      assistantMessageId: `msg-${convId}`, assistantSequence: 1, assistantRevision: 1, assistantText,
      assistantFinalized: false, interrupted: false, cancelRequested: false,
      inProgressToolCalls: new Set(), toolCalls: new Map(), fullToolCalls: new Set(), approvalRequestIds: new Map(),
    };
    const ctx = {
      transport: { connected: true, connectionGeneration: 1 },
      catalog: { brainDir, get: () => undefined },
      active: new Set([convId]),
      activeTurns: new Map([[convId, turnState]]),
      requests: new Map(),
      isClosed: () => false,
      nextSequence: () => 2,
      ref: () => ref,
      emit: (o: PlatformObservation) => emitted.push(o),
      putSessionTurn: () => {},
      upsertLiveMessage: () => {},
    } as unknown as AdapterContext;
    handlePromptCompleted(ctx, convId, turnState, { stopReason: 'end_turn' });
    const msgObs = emitted.find(o => o.type === 'message');
    const turnObs = emitted.find(o => o.type === 'turn');
    return {
      status: turnObs && turnObs.type === 'turn' ? turnObs.turn.status : undefined,
      body: msgObs && msgObs.type === 'message' && msgObs.message.blocks[0]?.type === 'text' ? msgObs.message.blocks[0].text : '',
    };
  };

  // 1) DNS 127.0.0.53 timeout
  const dnsRes = runCase('33333333-3333-3333-3333-333333333331', [
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '检查文档' },
    { type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 1): stream reading error: unexpected EOF' },
    { type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 2): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": Post "https://oauth2.googleapis.com/token": dial tcp: lookup oauth2.googleapis.com on 127.0.0.53:53: read udp 127.0.0.1:46016->127.0.0.53:53: i/o timeout' },
  ], '\n⚠ There was a network issue connecting to the server, please try again.\n');
  assert.equal(dnsRes.status, 'failed');
  assert.match(dnsRes.body, /本机 DNS 解析超时或异常（oauth2\.googleapis\.com）（127\.0\.0\.53:53）（已自动重试 2 次）/);

  // 2) Secret-bearing uncategorized error must NEVER leak creds, tokens, IPs, or home paths
  const secretRes = runCase('33333333-3333-3333-3333-333333333332', [
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'run' },
    { type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 1): proxyconnect tcp http://alice:SUPER_SECRET@10.20.30.40:7890 Bearer ya29.SECRET_TOKEN /home/zhangzy/.config/secret' },
  ], '⚠ There was a network issue connecting to the server, please try again.');
  assert.equal(secretRes.status, 'failed');
  assert.match(secretRes.body, /上游网络请求异常（详情见本机 transcript 日志）/);
  assert.doesNotMatch(secretRes.body, /SUPER_SECRET|ya29|10\.20\.30\.40|\/home\/zhangzy/);

  // 3) Cross-turn USER_INPUT boundary: prior turn ERROR_MESSAGE must not contaminate new turn
  const crossTurnRes = runCase('33333333-3333-3333-3333-333333333333', [
    { type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 1): stream reading error: unexpected EOF' },
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'new turn' },
  ], '⚠ There was a network issue connecting to the server, please try again.');
  assert.equal(crossTurnRes.status, 'failed');
  assert.doesNotMatch(crossTurnRes.body, /unexpected EOF/);

  // 4) Normal prose quoting the English banner must remain completed untouched
  const proseRes = runCase('33333333-3333-3333-3333-333333333334', [], '排查说明：用户反馈出现了 ⚠ There was a network issue connecting to the server, please try again. 提示。');
  assert.equal(proseRes.status, 'completed');
  assert.match(proseRes.body, /^排查说明：/);
});

test('Fix #6: real AgyCatalog silent-turn reconciliation honors all anti-false-positive guards and readonly not_fully_idle logic', async t => {
  const dir = tempDir(t);
  const project = join(dir, 'proj');
  const brainDir = join(dir, 'brain');
  const summariesDb = join(dir, 'summaries.db');
  const noDispatch = join(dir, 'no-dispatch');
  mkdirSync(project, { recursive: true });
  const convId = '44444444-4444-4444-4444-444444444444';
  const logDir = join(brainDir, convId, '.system_generated', 'logs');
  mkdirSync(logDir, { recursive: true });
  const finalReply = '已经把新文档发送到飞书，随时告诉我哪一节还要修改。';
  const now = Date.now();
  writeFileSync(join(logDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 2, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '继续', created_at: new Date(now - 85_000).toISOString() }),
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: finalReply, tool_calls: [], created_at: new Date(now - 60_000).toISOString() }),
  ].join('\n') + '\n');

  // Case 6B: readonly live turn clears stuck not_fully_idle when text-only DONE and no subagents,
  // but stays running when active subagent exists!
  createSummariesDb(summariesDb, [
    { id: convId, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: 1, workspace: project, lastUserStep: 2 },
  ]);
  const roIdle = readReadonlyAgyLiveTurn(convId, project, { summariesDbPath: summariesDb, brainDir, dispatchScratchDir: noDispatch });
  assert.equal(roIdle?.running, false);

  const subActiveDb = join(dir, 'summaries-sub-active.db');
  createSummariesDb(subActiveDb, [
    { id: convId, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: 1, workspace: project, lastUserStep: 2 },
    { id: '55555555-5555-5555-5555-555555555555', status: 'CASCADE_RUN_STATUS_RUNNING', parent: convId, agentName: 'Live Worker', workspace: project },
  ]);
  const roStillRunning = readReadonlyAgyLiveTurn(convId, project, { summariesDbPath: subActiveDb, brainDir, dispatchScratchDir: noDispatch });
  assert.equal(roStillRunning?.running, true, 'must stay running when an active subagent exists');

  // Case 6A: Real AgyCatalog (uses catalog.dbPath!)
  const summariesIdleDb = join(dir, 'summaries-idle.db');
  createSummariesDb(summariesIdleDb, [
    { id: convId, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: 0, workspace: project, lastUserStep: 2 },
  ]);
  const realCatalog = new AgyCatalog({ dbPath: summariesIdleDb, brainDir, allowedProjectRoots: [project] });
  await realCatalog.refresh();

  const emitted: PlatformObservation[] = [];
  const abandonedSessions: string[] = [];
  const cancelledSessions: string[] = [];
  const fakeTransport = {
    connected: true,
    connectionGeneration: 1,
    onNotification: () => () => {},
    onServerRequest: () => () => {},
    onStatusChange: () => () => {},
    request: async () => ({}),
    notify: (method: string, params?: { sessionId?: string }) => {
      if (method === 'session/cancel' && params?.sessionId) cancelledSessions.push(params.sessionId);
    },
    abandonSessionPrompt: (sessionId: string) => {
      abandonedSessions.push(sessionId);
      return true;
    },
  };
  const adapter = new AgyAdapter(
    fakeTransport as never,
    realCatalog,
    'host',
    'svc',
    undefined,
    { idleReleaseMs: 0, externalHolderDetector: () => null },
  );
  adapter.onObservation(o => emitted.push(o));
  const internal = adapter as unknown as { active: Set<string>; activeTurns: Map<string, ActiveTurnState> };
  internal.active.add(convId);

  const makeHungTurn = (overrides: Partial<ActiveTurnState> = {}): ActiveTurnState => ({
    turnId: 'turn-hung',
    generation: 1,
    model: 'gemini-4-neon',
    startedAt: new Date(now - 90_000).toISOString(),
    lastActivityAt: now - 60_000,
    assistantMessageId: 'm-hung',
    assistantSequence: 1,
    assistantRevision: 5,
    assistantText: finalReply,
    assistantFinalized: false,
    interrupted: false,
    cancelRequested: false,
    baselineUserStepIndex: 1,
    inProgressToolCalls: new Set(),
    toolCalls: new Map(),
    fullToolCalls: new Set(),
    approvalRequestIds: new Map(),
    ...overrides,
  });

  // Negative anti-false-positive guards: NONE of these may reconcile!
  for (const [label, override] of [
    ['silence < 45s', { lastActivityAt: now - 10_000 }],
    ['inProgressToolCalls > 0', { inProgressToolCalls: new Set(['tc-1']) }],
    ['awaitingAsyncWakeup', { awaitingAsyncWakeup: true }],
    ['cancelRequested', { cancelRequested: true }],
    ['truncated partial text mismatch', { assistantText: '已经把新文档发送到飞书，' }],
    ['stale baselineUserStepIndex >= row.step_index', { baselineUserStepIndex: 3 }],
  ] as const) {
    internal.activeTurns.set(convId, makeHungTurn(override));
    await adapter.reconcileIdleAndExternalHolders(now);
    assert.equal(internal.activeTurns.has(convId), true, `must NOT reconcile when: ${label}`);
  }

  // Positive: all guards pass -> reconciles cleanly, cancels & abandons orphaned prompt RPC!
  internal.activeTurns.set(convId, makeHungTurn());
  await adapter.reconcileIdleAndExternalHolders(now);
  assert.equal(internal.activeTurns.has(convId), false, 'silent turn confirmed IDLE + exact DONE on disk must reconcile');
  assert.deepEqual(abandonedSessions, [convId]);
  assert.deepEqual(cancelledSessions, [convId]);
  assert.ok(emitted.some(o => o.type === 'turn' && o.turn.turnId === 'turn-hung' && o.turn.status === 'completed'));
});
