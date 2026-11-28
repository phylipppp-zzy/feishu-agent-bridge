import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs, { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { AgyCatalog } from '../src/unified/agy/catalog.js';
import { agyFileFingerprint, readAgySummaryHierarchy } from '../src/unified/agy/catalog-summaries.js';
import { readCachedAgyTranscript, type AgyTranscriptCacheEntry } from '../src/unified/agy/catalog-transcript.js';
import { readReadonlyAgyLiveTurn } from '../src/unified/agy/readonly-live-turn.js';
import { type Capabilities, type Interaction, type Session, type Turn } from '../src/unified/contracts.js';
import type { FeishuPort } from '../src/unified/feishu-channel.js';
import { discoverPendingItems } from '../src/unified/hubs/pending-discovery.js';
import { UnifiedRuntime, type RuntimeConfig } from '../src/unified/runtime.js';
import { UnifiedCore } from '../src/unified/service.js';
import { StoreError, UnifiedStore } from '../src/unified/store.js';

const owner = { source: 'feishu', subject: 'owner' };
const timestamp = '2026-11-26T12:00:00Z';

function tempDir(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'unified-hotpaths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function session(id: string, status: Session['status'] = 'idle'): Session {
  const capabilities = Object.fromEntries(
    ['view', 'send', 'queue', 'steer', 'answer', 'approve', 'interrupt', 'handoff', 'files', 'config']
      .map(key => [key, { status: 'available' }]),
  ) as Capabilities;
  return {
    sessionId: id, native: { provider: 'codex', hostId: 'host', serviceId: 'codex', nativeSessionId: id },
    project: '/project', title: id, status, revision: 0, capabilities,
    control: { serviceId: 'codex', owner: 'bridge', input: 'available', generation: 1, operationId: null, reason: null },
  };
}

function inputEvent(eventId: string, sessionId: string, type = 'message.updated', data: unknown = { text: 'x'.repeat(8192) }) {
  return { eventId, sessionId, type, objectId: 'step-1', objectRevision: 0,
    operationId: null, occurredAt: timestamp, receivedAt: timestamp, data };
}

function writeContext(operationId: string, targetId: string) {
  return { operationId, targetId, idempotencyKey: operationId, expectedRevision: 0, controlGeneration: 1, identity: owner };
}

function storeFixture(t: TestContext) {
  const path = join(tempDir(t), 'core.sqlite');
  const store = new UnifiedStore(path);
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); store.close(); });
  return { store, db };
}

test('compact event keys preserve external replay, conflicts and stream failure evidence', t => {
  const { store, db } = storeFixture(t);
  store.insertSession(session('s'));
  const turn: Turn = {
    sessionId: 's', turnId: 'step-1', status: 'running', inputId: null, startedAt: timestamp,
    endedAt: null, model: null, outputIds: [],
  };
  store.putTurn(turn);
  const subscription = store.subscribeEvents('s', store.initialCursor('s'), 100);
  assert.equal(subscription.status, 'events');
  const internal = subscription.events.find(event => event.type === 'turn.updated');
  assert.ok(internal);

  const external = inputEvent(randomUUID(), 's');
  const observed = inputEvent(randomUUID(), 's');
  const original = store.appendEvent(external);
  assert.equal(store.appendObservedEvent(observed), true);
  const stop = store.registerOperation(writeContext('stop', 's'), 'interruptTurn', { turnId: turn.turnId });
  assert.equal(store.claimOutbox(stop.operationId), true);

  const legacy = store.appendEvent(inputEvent('legacy', 's'));
  const legacyInput = inputEvent('legacy', 's');
  const legacyObserved = inputEvent(randomUUID(), 's', 'interaction.updated', {});
  assert.equal(store.appendObservedEvent(legacyObserved), true);
  const unsupported = inputEvent(randomUUID(), 's', 'interaction.unsupported', { reason: 'Unsupported URL elicitation' });
  const nativeTool = inputEvent(randomUUID(), 's', 'tool.updated', {
    turnId: turn.turnId, callId: 'step-1', phase: 'running', tool: 'read_file', summary: 'read_file',
  });
  const legacyProviderEvents = [store.appendEvent(unsupported), store.appendEvent(nativeTool)];
  const failure = inputEvent('failure', 's', 'adapter.stream_failed', { reason: 'disconnect' });
  const failedEvent = store.appendEvent(failure);
  const definiteFailure = inputEvent('definite', 's', 'adapter.stream_failed', { definiteFailure: true });
  store.appendEvent(definiteFailure);

  const key = db.prepare('SELECT value FROM event_keys WHERE event_id=?');
  const summary = (id: string) => {
    const row = key.get(id);
    assert.ok(row);
    return JSON.parse(String(row.value));
  };
  assert.equal(summary(external.eventId)._k, 1);
  assert.equal(summary(external.eventId).i, undefined);
  assert.equal(summary(observed.eventId).i, undefined);
  assert.equal(summary(internal.eventId).i, 1);
  assert.equal(summary(failure.eventId).u, 1);
  assert.equal(summary(failure.eventId).i, undefined);
  assert.equal(summary(definiteFailure.eventId).u, 0);
  assert.ok(Number(db.prepare('SELECT MAX(length(CAST(value AS BLOB))) AS bytes FROM event_keys').get()!.bytes) < 250);

  // Seed identical legacy rows so both historical replay and batched slimming run through real SQLite.
  const legacyWrite = db.prepare('UPDATE event_keys SET value=? WHERE event_id=?');
  const history = store.subscribeEvents('s', store.initialCursor('s'), 100);
  assert.equal(history.status, 'events');
  const legacyObservedEvent = history.events.find(event => event.eventId === legacyObserved.eventId);
  assert.ok(legacyObservedEvent);
  for (const event of [legacy, legacyObservedEvent, failedEvent, ...legacyProviderEvents]) {
    assert.equal(legacyWrite.run(JSON.stringify(event), event.eventId).changes, 1);
  }
  const conflict = (err: unknown) => err instanceof StoreError && err.detail.code === 'idempotency_conflict';
  assert.deepEqual(store.appendEvent(legacyInput), legacy);
  assert.throws(() => store.appendEvent({ ...legacyInput, data: { text: 'changed' } }), conflict);
  assert.equal(store.slimLegacyEventKeys(1), 1);
  assert.equal(store.slimLegacyEventKeys(), 4);
  assert.equal(store.slimLegacyEventKeys(), 0);
  assert.equal(summary(legacyObserved.eventId)._k, 1);
  assert.equal(summary(legacyObserved.eventId).i, undefined);
  assert.equal(summary(failure.eventId).t, 'adapter.stream_failed');
  assert.equal(summary(failure.eventId).o, turn.turnId);
  assert.equal(summary(failure.eventId).u, 1);
  assert.equal(summary(failure.eventId).i, undefined);
  assert.deepEqual(store.appendEvent(legacyInput), legacy);

  const floorCursor = store.snapshot('s').cursor;
  const priorWatermark = store.eventWatermark('s');
  store.compactEvents('s', floorCursor);
  assert.equal(store.eventFloor('s'), priorWatermark);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get()!.n, 0);
  assert.equal(key.get(internal.eventId), undefined);
  assert.deepEqual(store.appendEvent(external), original);
  assert.deepEqual(store.appendEvent(failure), failedEvent);
  assert.equal(store.appendObservedEvent(observed), false);
  assert.equal(store.appendObservedEvent(legacyObserved), false);
  assert.equal(store.appendObservedEvent(unsupported), false);
  assert.equal(store.appendObservedEvent(nativeTool), false);
  assert.throws(() => store.appendEvent({ ...external, data: { text: 'changed' } }), conflict);
  assert.equal(store.eventWatermark('s'), priorWatermark);
  store.putTurn({ ...turn, status: 'failed', endedAt: timestamp });
  assert.equal(store.getOperation(stop.operationId).error?.code, 'outcome_unknown');
  assert.equal(store.getOutbox(stop.operationId).state, 'unknown');
});

test('snapshot and subscription read through a WAL writer and migration savepoints', t => {
  const { store, db } = storeFixture(t);
  store.insertSession(session('s'));
  const before = store.appendEvent(inputEvent('before', 's'));
  const from = store.initialCursor('s');
  db.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(store.snapshot('s').cursor, before.cursor);
    assert.deepEqual(store.subscribeEvents('s', from, 10), { status: 'events', cursor: before.cursor, events: [before] });
  } finally {
    db.exec('ROLLBACK');
  }
  store.beginMigrationRollback();
  try {
    const during = store.appendEvent(inputEvent('during', 's'));
    assert.throws(() => store.snapshot('missing'), StoreError);
    assert.throws(() => store.subscribeEvents('s', 'invalid', 10), StoreError);
    assert.equal(store.snapshot('s').cursor, during.cursor);
    assert.deepEqual(store.subscribeEvents('s', before.cursor, 10), { status: 'events', cursor: during.cursor, events: [during] });
  } finally {
    store.endMigrationRollback(false);
  }
  assert.equal(store.snapshot('s').cursor, before.cursor);
});

test('pending discovery uses candidates and preserves presentation, authorization and generation', async t => {
  const { store, db } = storeFixture(t);
  const core = new UnifiedCore(store, [], () => true, undefined, undefined, entry => entry.sessionId !== 'hidden');
  t.after(() => core.close());
  core.presentSession = entry => ({ ...entry, title: 'presented ' + entry.title });

  const waitingApproval = (id: string): Session => {
    const entry = session(id, 'waiting_approval');
    return { ...entry, control: { ...entry.control, input: 'unavailable' } };
  };
  const question: Interaction = {
    interactionId: 'question', sessionId: 'question-session', turnId: 'step-1', nativeRequestId: 'request',
    connectionGeneration: 3, revision: 0, status: 'awaiting_answer', expiresAt: null, toolInputDigest: null,
    nativeResult: null, kind: 'question', prompt: 'Choose', choices: ['A'], multiple: false, allowFreeText: false,
  };
  for (const entry of [session('idle'), session(question.sessionId), waitingApproval('approval'), waitingApproval('hidden'), waitingApproval('detached')]) {
    store.insertSession(entry);
  }
  db.prepare('INSERT INTO tracking_state(session_id,detached) VALUES(?,1)').run('detached');
  store.setConnectionGeneration(question.sessionId, 0, question.connectionGeneration);
  store.insertInteraction(question);
  const awaitingDelivery = { ...question, interactionId: 'delivery-pending', nativeRequestId: 'request-2' };
  store.insertInteraction(awaitingDelivery);
  store.resolveInteraction({
    context: writeContext('response', question.sessionId), interactionId: awaitingDelivery.interactionId,
    expectedConnectionGeneration: question.connectionGeneration, answer: { kind: 'question', values: ['A'] },
    toolInputDigest: null,
  });

  const byId = new Map(store.listPendingInteractionCandidates().map(candidate => [candidate.session.sessionId, candidate]));
  assert.deepEqual([...byId.keys()].sort(), ['approval', 'hidden', question.sessionId].sort());
  assert.equal(byId.get(question.sessionId)?.connectionGeneration, 3);
  assert.deepEqual(byId.get(question.sessionId)?.interactions.map(interaction => interaction.status), [
    'awaiting_answer', 'answer_pending_delivery',
  ]);

  const snapshots = t.mock.method(core, 'getSnapshot', async () => assert.fail('pending discovery scanned snapshots'));
  const listings = t.mock.method(core, 'listSessions', async () => assert.fail('pending discovery listed all sessions'));
  const items = await discoverPendingItems({
    service: core, decisionStore: undefined, boundSources: [], resolveSourceLink: async () => null,
    discoverCliNotices: async () => [
      { provider: 'codex', nativeSessionId: 'idle-cli', title: 'Idle CLI', summary: '', project: '/project', sourceSessionId: 'idle' },
      { provider: 'codex', nativeSessionId: 'hidden-cli', title: 'Hidden CLI', summary: '', project: '/project', sourceSessionId: 'hidden' },
    ],
  }, Date.now());
  assert.deepEqual(items.map(item => item.sourceSessionId).sort(), ['approval', 'idle', question.sessionId].sort());
  assert.equal(items.find(item => item.sourceSessionId === 'approval')?.title, 'presented approval');
  assert.equal(snapshots.mock.callCount(), 0);
  assert.equal(listings.mock.callCount(), 0);
});

function transcriptPaths(root: string, id: string) {
  const brainDir = join(root, 'brain');
  const logs = join(brainDir, id, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  return { brainDir, compact: join(logs, 'transcript.jsonl'), full: join(logs, 'transcript_full.jsonl') };
}

function reply(step_index: number, content: string, truncated_fields?: string[]) {
  return { step_index, content, truncated_fields, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: timestamp };
}

test('catalog reads unchanged transcripts without bytes and processes appends only from the newline boundary', async t => {
  const id = 'incremental-catalog';
  const { brainDir, compact, full } = transcriptPaths(tempDir(t), id);
  const catalog = new AgyCatalog({ brainDir });
  const prefix = JSON.stringify(reply(1, 'x'.repeat(9000))) + '\n';
  writeFileSync(compact, prefix);
  const reads: Array<{ start: number; bytes: number }> = [];
  const originalOpen = fsPromises.open;
  const opened = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    if (args[0] !== compact) return file;
    const read = file.read.bind(file);
    file.read = (async (buffer: Buffer, offset: number, length: number, start: number) => {
      const result = await read(buffer, offset, length, start);
      reads.push({ start, bytes: result.bytesRead });
      return result;
    }) as typeof file.read;
    return file;
  });
  syncBuiltinESMExports();
  t.after(() => { opened.mock.restore(); syncBuiltinESMExports(); });

  const first = await catalog.readTranscript(id);
  assert.equal(first.messages.length, 1);
  assert.ok(reads.length);
  reads.length = 0;
  assert.deepEqual(await catalog.readTranscript(id), first);
  assert.equal(reads.length, 0);

  const next = JSON.stringify(reply(2, 'next λ response'));
  const partial = next.slice(0, -8);
  appendFileSync(compact, partial);
  const pending = await catalog.readTranscript(id);
  assert.equal(pending.truncatedTrailingLine, true);
  assert.equal(pending.nextLine, first.nextLine);
  assert.ok(reads.some(read => read.start === Buffer.byteLength(prefix) && read.bytes === Buffer.byteLength(partial)));
  assert.ok(reads.every(read => read.start >= Buffer.byteLength(prefix) - 4096));
  reads.length = 0;

  appendFileSync(compact, next.slice(-8));
  const appended = await catalog.readTranscript(id);
  assert.equal(appended.truncatedTrailingLine, false);
  assert.equal(appended.nextLine, first.nextLine + 1);
  assert.deepEqual(appended.messages.map(message => message.text), ['x'.repeat(9000), 'next λ response']);
  assert.ok(reads.some(read => read.start === Buffer.byteLength(prefix) && read.bytes === Buffer.byteLength(next)));
  assert.ok(reads.every(read => read.start >= Buffer.byteLength(prefix) - 4096));
  appendFileSync(compact, '\n');
  assert.deepEqual(await catalog.readTranscript(id), appended);

  const truncated = reply(3, 'partial', ['content']);
  appendFileSync(compact, JSON.stringify(truncated) + '\n');
  assert.equal((await catalog.readTranscript(id)).messages.at(-1)?.text, 'partial');
  writeFileSync(full, JSON.stringify({ ...reply(3, 'partial recovered without timestamp'), created_at: undefined }) + '\n');
  const resolved = await catalog.readTranscript(id);
  assert.equal(resolved.messages.at(-1)?.text, 'partial recovered without timestamp');
  assert.equal(resolved.messages.at(-1)?.resolvedFromFull, true);

  const offset = statSync(compact).size;
  const compactAppend = JSON.stringify(reply(4, 'another prefix', ['content'])) + '\n';
  appendFileSync(full, [reply(3, 'exact timestamp wins'), reply(4, 'another prefix completed in full')]
    .map(row => JSON.stringify(row)).join('\n') + '\n');
  appendFileSync(compact, compactAppend);
  reads.length = 0;
  const bothGrew = await catalog.readTranscript(id);
  assert.deepEqual(bothGrew.messages.slice(-2).map(message => [message.text, message.resolvedFromFull]), [
    ['exact timestamp wins', true],
    ['another prefix completed in full', true],
  ]);
  assert.ok(reads.some(read => read.start === 0 && read.bytes === offset + Buffer.byteLength(compactAppend)));

  // In-place shrink and a larger replacement invalidate the committed prefix independently.
  writeFileSync(compact, JSON.stringify(reply(4, 'shortened')) + '\n');
  assert.deepEqual((await catalog.readTranscript(id)).messages.map(message => message.text), ['shortened']);
  const replacementPath = compact + '.replacement';
  const replacement = 'new'.repeat(4000);
  writeFileSync(replacementPath, JSON.stringify(reply(5, replacement)) + '\n');
  renameSync(replacementPath, compact);
  assert.deepEqual((await catalog.readTranscript(id)).messages.map(message => message.text), [replacement]);

  // Overwriting bytes near the old newline and then growing must also take the full-read path.
  const overwritten = replacement.replace(/new/g, 'old');
  const rebuilt = [reply(5, overwritten), reply(6, 'after rewrite')].map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(compact, rebuilt);
  assert.deepEqual((await catalog.readTranscript(id)).messages.map(message => message.text), [overwritten, 'after rewrite']);

  appendFileSync(compact, '{invalid}\n');
  assert.equal((await catalog.readTranscript(id)).parseErrors, 1);
  reads.length = 0;
  assert.equal((await catalog.readTranscript(id)).parseErrors, 1);
  assert.ok(reads.length > 0, 'a malformed line must be retried');
  writeFileSync(compact, rebuilt + JSON.stringify(reply(7, 'corrected')) + '\n');
  const corrected = await catalog.readTranscript(id);
  assert.equal(corrected.parseErrors, 0);
  assert.equal(corrected.messages.at(-1)?.text, 'corrected');
});

test('oversized resolved transcript bypasses the cache and preserves existing entries', async t => {
  const root = tempDir(t);
  const small = transcriptPaths(root, 'small');
  const oversized = transcriptPaths(root, 'oversized');
  writeFileSync(small.compact, JSON.stringify(reply(1, 'small')) + '\n');
  writeFileSync(oversized.compact, JSON.stringify(reply(1, 'prefix', ['content'])) + '\n');
  const text = '前'.repeat(600);
  writeFileSync(oversized.full, JSON.stringify(reply(1, text)) + '\n');
  const cache = new Map<string, AgyTranscriptCacheEntry>();
  const read = (id: string) => readCachedAgyTranscript(id, { brainDir: small.brainDir }, cache, 3000);
  const cached = await read('small');
  assert.ok(cache.has('small'));
  const resolved = await read('oversized');
  assert.equal(resolved.messages[0]?.text, text);
  assert.ok(statSync(oversized.compact).size + Buffer.byteLength(text) < 3000, 'either parsed collection alone fits');
  assert.deepEqual([...cache.keys()], ['small']);
  assert.equal(await read('small'), cached);
});

function openSummariesDb(t: TestContext, dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT,
      workspace_uris TEXT, status TEXT, source TEXT, project_id TEXT, agent_name TEXT,
      parent_conversation_id TEXT, nesting_depth INTEGER, battle_id TEXT, winning_conversation_id TEXT,
      not_fully_idle INTEGER, killed INTEGER, last_user_input_time TEXT, last_user_input_step_index INTEGER,
      app_data_dir TEXT, group_id TEXT
    )`);
  return db;
}

test('shared summaries and readonly live view avoid repeated queries and tail reads, and notice WAL changes', t => {
  const root = tempDir(t);
  const dbPath = join(root, 'summaries.db');
  const db = openSummariesDb(t, dbPath);
  const firstId = 'readonly-one';
  const secondId = 'readonly-two';
  const { brainDir, compact } = transcriptPaths(root, firstId);
  const project = join(root, 'project');
  mkdirSync(project);
  const insert = db.prepare(`INSERT INTO conversation_summaries
    (conversation_id, title, step_count, last_modified_time, workspace_uris, status, nesting_depth, not_fully_idle, killed, last_user_input_step_index)
    VALUES (?, 'Title', 2, ?, ?, 'CASCADE_RUN_STATUS_RUNNING', 0, 1, 0, 1)`);
  for (const id of [firstId, secondId]) insert.run(id, timestamp, JSON.stringify([pathToFileURL(project).href]));
  const user = { step_index: 1, source: 'USER', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>Start</USER_REQUEST>' };
  writeFileSync(compact, [user, reply(2, 'working')].map(row => JSON.stringify(row)).join('\n') + '\n');
  const options = { brainDir, summariesDbPath: dbPath };
  const sql = t.mock.method(DatabaseSync.prototype, 'prepare');
  const read = t.mock.method(fs, 'readSync');
  syncBuiltinESMExports();
  t.after(() => { read.mock.restore(); sql.mock.restore(); syncBuiltinESMExports(); });
  const summaryQueries = () => sql.mock.calls.filter(call => String(call.arguments[0]).includes('FROM conversation_summaries')).length;

  assert.equal(readAgySummaryHierarchy(dbPath).byId.size, 2);
  const view = readReadonlyAgyLiveTurn(firstId, project, options);
  assert.ok(view?.running);
  assert.match(view.previewText, /working/);
  const tailReads = read.mock.callCount();
  assert.ok(tailReads > 0);
  assert.deepEqual(readReadonlyAgyLiveTurn(firstId, project, options), view);
  assert.ok(readReadonlyAgyLiveTurn(secondId, project, options)?.running);
  assert.equal(read.mock.callCount(), tailReads);
  assert.equal(summaryQueries(), 1);

  appendFileSync(compact, JSON.stringify(reply(3, 'working on the next step')) + '\n');
  assert.match(readReadonlyAgyLiveTurn(firstId, project, options)!.previewText, /next step/);
  assert.ok(read.mock.callCount() > tailReads);
  assert.equal(summaryQueries(), 1);
  db.prepare("UPDATE conversation_summaries SET title='WAL edit' WHERE conversation_id=?").run(firstId);
  assert.equal(readAgySummaryHierarchy(dbPath).byId.get(firstId)?.title, 'WAL edit');
  assert.equal(summaryQueries(), 2);
});

const offlinePort: FeishuPort = {
  async send() { return 'message-id'; },
  async update() {},
  async sendFile() {},
};

function runtimeConfig(root: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    coreDb: join(root, 'core.sqlite'), channelDb: join(root, 'channel.sqlite'),
    ownerOpenId: owner.subject, allowedDestinations: ['chat-main'], hostId: 'host',
    claudeServiceId: 'claude', codexServiceId: 'codex', claudeStateDir: root,
    codexEndpoint: 'codex-proxy://default', intervalMs: 1000, approvalPolicy: { enabled: false }, ...overrides,
  };
}

test('PendingHub caches unchanged CLI polls and refreshes on WAL writes and holder exit', { skip: process.platform !== 'linux' }, async t => {
  const root = tempDir(t);
  const presenceDir = join(root, 'presence');
  mkdirSync(presenceDir);
  const summariesDbPath = join(root, 'summaries.db');
  const summaries = openSummariesDb(t, summariesDbPath);
  const waiting = ['wal-holder', 'exit-holder'].map(id => {
    summaries.prepare('INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, nesting_depth) VALUES (?, ?, ?, 0)')
      .run(id, id, JSON.stringify([pathToFileURL(root).href]));
    const path = join(root, `${id}.db`);
    const db = new DatabaseSync(path);
    t.after(() => db.close());
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL);
      INSERT INTO steps VALUES (1, 132, 9)`);
    return { path, db };
  });
  // Keep the SQLite writers open in this process so holder exit cannot checkpoint either WAL.
  const fds = waiting.map(({ path }) => openSync(path, 'r'));
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'ignore', 'ignore', ...fds],
  });
  for (const fd of fds) closeSync(fd);
  await once(holder, 'spawn');
  const stopHolder = async () => {
    if (holder.exitCode !== null || holder.signalCode !== null) return;
    const exited = once(holder, 'exit');
    holder.kill();
    await exited;
  };
  t.after(stopHolder);
  const runtime = new UnifiedRuntime(runtimeConfig(root, {
    allowedProjectRoots: [root],
    catalogSources: [{ provider: 'claude', directory: root, hostId: 'host', serviceId: 'claude' }],
    pendingHub: { enabled: true, destination: 'chat-main' },
    agy: { serviceId: 'agy', summariesDbPath, conversationsDir: root, brainDir: join(root, 'brain') },
  }), offlinePort, [], { isTrustedAgyCliHolder: candidate => candidate.pid === holder.pid });
  t.after(() => runtime.close());
  const hub = runtime.pendingHub!;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const procRead = t.mock.method(fs, 'readdirSync');
  const presenceRead = t.mock.method(fsPromises, 'readdir');
  syncBuiltinESMExports();
  t.after(() => { procRead.mock.restore(); presenceRead.mock.restore(); syncBuiltinESMExports(); });
  const scans = () => [
    procRead.mock.calls.filter(call => call.arguments[0] === '/proc').length,
    presenceRead.mock.calls.filter(call => call.arguments[0] === presenceDir).length,
  ];

  assert.equal((await hub.sync()).activeCount, 2);
  assert.equal((await hub.sync()).activeCount, 2);
  assert.deepEqual(scans(), [1, 1]);

  const wal = waiting[0]!;
  const mainBefore = agyFileFingerprint(wal.path);
  const walBefore = agyFileFingerprint(`${wal.path}-wal`);
  wal.db.exec('UPDATE steps SET status=3 WHERE idx=1');
  assert.equal(agyFileFingerprint(wal.path), mainBefore);
  assert.notEqual(agyFileFingerprint(`${wal.path}-wal`), walBefore);
  assert.deepEqual(await hub.sync(), { activeCount: 1, withdrawnRefs: ['cli_notice:agy:wal-holder'] });

  const exitPaths = [waiting[1]!.path, `${waiting[1]!.path}-wal`];
  const beforeExit = exitPaths.map(agyFileFingerprint);
  await stopHolder();
  assert.deepEqual(exitPaths.map(agyFileFingerprint), beforeExit);
  assert.deepEqual(await hub.sync(), { activeCount: 0, withdrawnRefs: ['cli_notice:agy:exit-holder'] });
  now += 19_999;
  assert.equal((await hub.sync()).activeCount, 0);
  assert.deepEqual(scans(), [3, 3]);
  now += 1;
  assert.equal((await hub.sync()).activeCount, 0);
  assert.deepEqual(scans(), [4, 4]);

  const presencePath = join(presenceDir, 'claude-waiting.json');
  const presence = { version: 1, sessionId: 'claude-waiting', event: 'PermissionRequest',
    state: 'waiting', cwd: root, pid: process.pid, at: now };
  writeFileSync(presencePath, JSON.stringify(presence));
  assert.equal((await hub.sync()).activeCount, 1);
  const dirBeforeEdit = agyFileFingerprint(presenceDir);
  writeFileSync(presencePath, JSON.stringify({ ...presence, state: 'running' }));
  assert.equal(agyFileFingerprint(presenceDir), dirBeforeEdit);
  assert.deepEqual(await hub.sync(), { activeCount: 0, withdrawnRefs: ['cli_notice:claude:claude-waiting'] });
});

test('Watch startup prewarms unknown state and reports only sustained delivery changes', async t => {
  const config = runtimeConfig(tempDir(t), { watchHub: { enabled: true, destination: 'chat-main' } });
  const initial = new UnifiedRuntime(config, offlinePort, []);
  initial.store.insertSession(session('watch'));
  const op = initial.store.registerOperation(writeContext('historical', 'watch'), 'send', {});
  assert.ok(initial.store.claimOutbox(op.operationId));
  initial.store.markDeliveryUnknown(op.operationId);
  await initial.close();
  const channelDb = new DatabaseSync(config.channelDb);
  t.after(() => channelDb.close());
  const insert = channelDb.prepare("INSERT INTO channel_deliveries(delivery_id,state) VALUES (?,'unknown')");
  const remove = channelDb.prepare('DELETE FROM channel_deliveries WHERE delivery_id=?');
  insert.run('historical');
  const runtime = new UnifiedRuntime(config, offlinePort, []);
  t.after(() => runtime.close());
  const eventsDb = new DatabaseSync(join(config.claudeStateDir, 'watch-hub.sqlite'), { readOnly: true });
  t.after(() => eventsDb.close());
  const events = () => eventsDb.prepare('SELECT object_id, state FROM watch_hub_events_v1 ORDER BY rowid')
    .all().map(row => [row.object_id, row.state]);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const sample = async (advanceMs: number) => {
    now += advanceMs;
    runtime.syncUnknownDeliveryAlerts();
    await setImmediate();
  };
  assert.deepEqual(runtime.store.unknownOperationIds(), ['historical']);
  await sample(0);
  await sample(16_000);
  assert.deepEqual(events(), []);

  remove.run('historical');
  await sample(0);
  await sample(15_000);
  assert.deepEqual(events(), [['runtime:unknown-deliveries', 'recovered']]);

  insert.run('fleeting');
  await sample(0);
  remove.run('fleeting');
  await sample(1000);
  await sample(15_000);
  assert.equal(events().length, 1);

  insert.run('persistent');
  await sample(0);
  await sample(14_999);
  assert.equal(events().length, 1);
  await sample(1);
  assert.deepEqual(events(), [
    ['runtime:unknown-deliveries', 'recovered'],
    ['runtime:unknown-deliveries', 'alert'],
  ]);
  insert.run('extra-in-flight');
  await sample(0);
  remove.run('extra-in-flight');
  await sample(1000);
  await sample(15_000);
  assert.equal(events().length, 2);
});

test('periodic compaction retains the newest 20 events and honors both binding cursor fences', async t => {
  const config = runtimeConfig(tempDir(t), { taskTopic: { enabled: true } });
  const runtime = new UnifiedRuntime(config, offlinePort, []);
  t.after(() => runtime.close());
  const { store, channel, taskChannel } = runtime;
  assert.ok(taskChannel);
  const db = new DatabaseSync(config.channelDb);
  t.after(() => db.close());
  assert.ok(db.prepare('PRAGMA index_list(channel_deliveries)').all().some(index => index.name === 'channel_deliveries_state'));

  const grow = (id: string, count: number) => {
    const start = store.eventWatermark(id);
    return Array.from({ length: count }, (_, i) =>
      store.appendEvent(inputEvent(id + '-' + (start + i), id, 'example', { turn: start + i })));
  };
  const unbound = 'unbound';
  const shared = 'shared';
  store.insertSession(session(unbound));
  grow(unbound, 80);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await runtime.tick();
  assert.equal(store.eventFloor(unbound), 60);

  store.insertSession(session(shared));
  const history = grow(shared, 80);
  db.prepare('INSERT INTO channel_bindings(destination,session_id,binding_id,owner_source,owner_subject,revision) VALUES(?,?,?,?,?,0)')
    .run('chat-main', shared, 'binding', owner.source, owner.subject);
  db.prepare('INSERT INTO task_bindings_v1 VALUES(?,?,1,?,?,1,NULL,1,?)')
    .run('task', 'task-dest', owner.source, owner.subject, 'active');
  db.prepare('INSERT INTO task_targets_v1 VALUES(?,?,?,?,?,?,?,1,?,?)')
    .run('task', 'target', 'codex', 'host', 'codex', shared, shared, 'read_only', 'active');
  assert.deepEqual(channel.minBoundEventCursorBySession(), new Map([[shared, 0]]));
  assert.deepEqual(taskChannel.minBoundEventCursorBySession(), new Map([[shared, 0]]));

  const bindingScope = JSON.stringify({ session_id: shared, binding_id: 'binding', revision: 0, access_mode: 'read_only' });
  db.prepare('INSERT INTO channel_cursors(destination,session_id,cursor,binding_scope) VALUES(?,?,?,?)')
    .run('chat-main', shared, history[54]!.cursor, bindingScope);
  const taskScope = JSON.stringify({ taskId: 'task', rootGeneration: 1, targetId: 'target',
    targetGeneration: 1, sessionId: shared, accessMode: 'read_only' });
  db.prepare('INSERT INTO task_cursors_v1 VALUES(?,?,1,?,?,?)')
    .run('task', 'target', shared, history[39]!.cursor, taskScope);
  assert.deepEqual(channel.minBoundEventCursorBySession(), new Map([[shared, 55]]));
  assert.deepEqual(taskChannel.minBoundEventCursorBySession(), new Map([[shared, 40]]));

  now += 299_999;
  runtime.compactEventHistory();
  assert.equal(store.eventFloor(shared), 0);
  now += 1;
  runtime.compactEventHistory();
  assert.equal(store.eventFloor(shared), 40);
  assert.equal(store.subscribeEvents(shared, history[39]!.cursor, 100).status, 'events');

  db.prepare('UPDATE task_bindings_v1 SET root_generation=2').run();
  assert.deepEqual(taskChannel.minBoundEventCursorBySession(), new Map([[shared, 0]]));
  db.prepare('UPDATE task_bindings_v1 SET state=?').run('closed');
  assert.deepEqual(taskChannel.minBoundEventCursorBySession(), new Map());
});
