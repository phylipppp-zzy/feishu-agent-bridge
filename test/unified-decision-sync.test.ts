import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DECISION_SYNC_END,
  DECISION_SYNC_START,
  DecisionSyncStore,
  type MarkdownFileSystem,
} from '../src/unified/decision-sync.js';
import { StoreError } from '../src/unified/store.js';

const hasCode = (expected: string) => (err: unknown) =>
  err instanceof StoreError && err.detail.code === expected;
const owner = { source: 'feishu', subject: 'user-owner' };

test('empty baseline imports 0 old decisions and protects read-only legacy 待你决定.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-empty-'));
  const legacyDoc = join(dir, '待你决定.md');
  const legacyContent = [
    '# 待你决定',
    '## 已完成历史决定',
    '- UI-S1: 已决定采用统一入口',
    '- H: 用户自行运行 hook',
  ].join('\n');
  writeFileSync(legacyDoc, legacyContent, 'utf8');

  const store = new DecisionSyncStore({
    dbPath: join(dir, 'decisions.sqlite'),
    protectedReadOnlyPaths: new Set([legacyDoc]),
  });

  try {
    // Default empty baseline: 0 auto-import, 0 auto-outbox
    assert.deepEqual(store.listDecisions(), []);
    assert.deepEqual(store.listDocOutbox(), []);
    assert.equal(readFileSync(legacyDoc, 'utf8'), legacyContent);

    // Attempting to sync into protected read-only path is explicitly rejected
    assert.throws(() => store.syncMarkdownDocument(legacyDoc), hasCode('unauthorized'));
    assert.equal(readFileSync(legacyDoc, 'utf8'), legacyContent);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dual-entry concurrent answers enforce SQLite CAS single winner and immutable append-only ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-cas-'));
  const dbPath = join(dir, 'decisions.sqlite');
  let store = new DecisionSyncStore({ dbPath });

  try {
    const decision = store.createDecision({
      decisionId: 'DEC-101',
      kind: 'business_decision',
      title: '论文图表风格选择',
      prompt: '请选择主实验图表的配色方案',
      options: [
        { id: 'A', label: '蓝灰学术风格' },
        { id: 'B', label: '高对比色盲友好风格' },
      ],
      source: { system: 'research-plan', sessionId: 'sess-1' },
      bounds: { scope: 'paper-figures' },
    });

    // Entry 1 (Feishu Hub) wins
    const win = store.answerDecision({
      decisionId: decision.decisionId,
      expectedVersion: decision.version,
      expectedDigest: decision.digest,
      entryPoint: 'feishu_hub',
      idempotencyKey: 'feishu-evt-1',
      actor: owner,
      selectedOptionId: 'B',
      rawUtterance: '选 B 高对比色盲友好',
    });
    assert.equal(win.winner, true);
    assert.equal(win.idempotent, false);
    assert.equal(win.decision.status, 'answered');

    // Idempotent retry with exact same idempotencyKey returns cleanly without duplicating
    const idem = store.answerDecision({
      decisionId: decision.decisionId,
      expectedVersion: decision.version,
      expectedDigest: decision.digest,
      entryPoint: 'feishu_hub',
      idempotencyKey: 'feishu-evt-1',
      actor: owner,
      selectedOptionId: 'B',
      rawUtterance: '选 B 高对比色盲友好',
    });
    assert.equal(idem.winner, false);
    assert.equal(idem.idempotent, true);

    // Entry 2 (Local CLI) arriving concurrently with different idempotencyKey is rejected!
    assert.throws(
      () =>
        store.answerDecision({
          decisionId: decision.decisionId,
          expectedVersion: decision.version,
          expectedDigest: decision.digest,
          entryPoint: 'local_cli',
          idempotencyKey: 'cli-evt-2',
          actor: owner,
          selectedOptionId: 'A',
          rawUtterance: '选 A',
        }),
      hasCode('stale_revision'),
    );

    // Immutable append-only journal check at SQLite level
    const rawDb = new DatabaseSync(dbPath);
    assert.throws(
      () => rawDb.prepare("UPDATE decision_answers_v1 SET selected_option_id='A' WHERE decision_id='DEC-101'").run(),
      /append-only/,
    );
    assert.throws(
      () => rawDb.prepare("DELETE FROM decision_answers_v1 WHERE decision_id='DEC-101'").run(),
      /append-only/,
    );
    rawDb.close();

    // Owner generation transfer & restart preserve committed answers
    const transferred = store.transferOwnerGeneration('DEC-101', 1, 2);
    assert.equal(transferred.ownerGeneration, 2);
    assert.equal(transferred.status, 'answered');

    store.close();
    store = new DecisionSyncStore({ dbPath });
    const reloaded = store.getDecision('DEC-101');
    assert.equal(reloaded.status, 'answered');
    assert.equal(reloaded.ownerGeneration, 2);
    const answers = store.getAnswers('DEC-101');
    assert.equal(answers.length, 1);
    assert.equal(answers[0]!.selectedOptionId, 'B');
    assert.equal(answers[0]!.rawUtterance, '选 B 高对比色盲友好');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('option upgrade increments version & digest and rejects stale old option A', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-upgrade-'));
  let currentNow = 1_800_000_000_000;
  const store = new DecisionSyncStore({
    dbPath: join(dir, 'decisions.sqlite'),
    now: () => currentNow,
  });

  try {
    const v1 = store.createDecision({
      decisionId: 'DEC-202',
      kind: 'business_decision',
      title: '评测基线选择',
      prompt: '选择基线方案',
      options: [
        { id: 'A', label: '旧方案 A：单卡 8bit' },
        { id: 'B', label: '旧方案 B：双卡 bf16' },
      ],
      source: { system: 'planner' },
    });

    const v2 = store.updateDecision({
      decisionId: 'DEC-202',
      expectedVersion: v1.version,
      prompt: '选项实质变化：A 现为全新架构',
      options: [
        { id: 'A', label: '新方案 A：全新分布式训练（非旧 A）' },
        { id: 'C', label: '新方案 C：保留旧策略' },
      ],
    });

    assert.equal(v2.version, 2);
    assert.notEqual(v2.digest, v1.digest);

    // Old version/digest claiming "A" must be rejected and never mapped to new A!
    assert.throws(
      () =>
        store.answerDecision({
          decisionId: 'DEC-202',
          expectedVersion: v1.version,
          expectedDigest: v1.digest,
          entryPoint: 'feishu_hub',
          idempotencyKey: 'old-a-click',
          actor: owner,
          selectedOptionId: 'A',
        }),
      hasCode('stale_revision'),
    );

    // Passing v2 version with stale v1 digest also rejected
    assert.throws(
      () =>
        store.answerDecision({
          decisionId: 'DEC-202',
          expectedVersion: v2.version,
          expectedDigest: v1.digest,
          entryPoint: 'feishu_hub',
          idempotencyKey: 'stale-digest-click',
          actor: owner,
          selectedOptionId: 'A',
        }),
      hasCode('stale_revision'),
    );

    // Valid v2 answer succeeds
    const ok = store.answerDecision({
      decisionId: 'DEC-202',
      expectedVersion: v2.version,
      expectedDigest: v2.digest,
      entryPoint: 'feishu_hub',
      idempotencyKey: 'new-c-click',
      actor: owner,
      selectedOptionId: 'C',
    });
    assert.equal(ok.decision.version, 2);
    assert.equal(ok.answer.selectedOptionId, 'C');

    // Expiry enforcement
    const exp = store.createDecision({
      decisionId: 'DEC-EXP',
      kind: 'business_decision',
      title: '限时确认',
      prompt: '是否同意',
      options: [{ id: 'yes', label: '同意' }],
      source: { system: 'planner' },
      expiresAt: new Date(currentNow + 5000).toISOString(),
    });
    currentNow += 10_000;
    assert.throws(
      () =>
        store.answerDecision({
          decisionId: exp.decisionId,
          expectedVersion: exp.version,
          expectedDigest: exp.digest,
          entryPoint: 'feishu_hub',
          idempotencyKey: 'exp-click',
          actor: owner,
          selectedOptionId: 'yes',
        }),
      /interaction_expired|expired/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protected Markdown publisher updates only anchored block, preserves 100% human blocks, and handles manual conflict without dropping answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-md-'));
  const docPath = join(dir, 'decisions-view.md');
  const humanHeader = [
    '# 项目人工决定文档',
    '',
    '<!-- 人工说明区，系统不得修改这里任何字符 -->',
    '1. 人工约束：先跑小规模验证，禁止擅自提交大规模作业。',
    '',
    '',
  ].join('\n');
  const humanFooter = [
    '',
    '## 人工附录',
    '- 备注：保留原格式和空行  ',
    '- 联系人：张三',
    '',
  ].join('\n');

  writeFileSync(
    docPath,
    `${humanHeader}${DECISION_SYNC_START}\n旧占位内容\n${DECISION_SYNC_END}${humanFooter}`,
    'utf8',
  );

  const store = new DecisionSyncStore({
    dbPath: join(dir, 'decisions.sqlite'),
    defaultDocPath: docPath,
  });

  try {
    const d1 = store.createDecision({
      decisionId: 'DEC-MD-1',
      kind: 'business_decision',
      title: '数据清洗策略',
      prompt: '请选择清洗阈值',
      options: [
        { id: 'strict', label: '严格过滤' },
        { id: 'loose', label: '宽松过滤' },
      ],
      source: { system: 'pipeline' },
    });

    const sync1 = store.syncMarkdownDocument(docPath);
    assert.equal(sync1.syncStatus, 'synced');

    const content1 = readFileSync(docPath, 'utf8');
    const start1 = content1.indexOf(DECISION_SYNC_START);
    const end1 = content1.indexOf(DECISION_SYNC_END);
    assert.equal(content1.slice(0, start1), humanHeader);
    assert.equal(content1.slice(end1 + DECISION_SYNC_END.length), humanFooter);
    assert.match(content1.slice(start1, end1), /DEC-MD-1/);
    assert.match(content1.slice(start1, end1), /暂无（待决定）/);

    // Now simulate human editing the Markdown file manually out-of-band!
    const manuallyEdited = content1.replace('严格过滤', '人工修改后的严格过滤备注');
    writeFileSync(docPath, manuallyEdited, 'utf8');

    // User answers DEC-MD-1 via Feishu
    const answered = store.answerDecision({
      decisionId: d1.decisionId,
      expectedVersion: d1.version,
      expectedDigest: d1.digest,
      entryPoint: 'feishu_hub',
      idempotencyKey: 'ans-md-1',
      actor: owner,
      selectedOptionId: 'strict',
      rawUtterance: '选严格过滤',
    });
    assert.equal(answered.decision.status, 'answered');

    // Attempting to sync must detect conflict, refuse to overwrite disk, and NEVER roll back committed answer!
    const conflict = store.syncMarkdownDocument(docPath);
    assert.equal(conflict.syncStatus, 'conflict_pending_manual_merge');
    assert.equal(readFileSync(docPath, 'utf8'), manuallyEdited);

    const persistedDecision = store.getDecision('DEC-MD-1');
    assert.equal(persistedDecision.status, 'answered');
    assert.equal(persistedDecision.syncStatus, 'conflict_pending_manual_merge');
    assert.equal(store.getAnswers('DEC-MD-1').length, 1);

    // After manual merge acknowledgement, allowRebaseAfterManualMerge syncs cleanly while keeping human edits outside anchors
    const rebased = store.syncMarkdownDocument(docPath, { allowRebaseAfterManualMerge: true });
    assert.equal(rebased.syncStatus, 'synced');
    const content2 = readFileSync(docPath, 'utf8');
    const start2 = content2.indexOf(DECISION_SYNC_START);
    const end2 = content2.indexOf(DECISION_SYNC_END);
    assert.equal(content2.slice(0, start2), humanHeader);
    assert.equal(content2.slice(end2 + DECISION_SYNC_END.length), humanFooter);
    assert.match(content2.slice(start2, end2), /已登记答复: strict/);
    assert.equal(store.getDecision('DEC-MD-1').syncStatus, 'synced');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('document write I/O failure retains committed answer as pending_sync and retries cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-iofail-'));
  const docPath = join(dir, 'decisions.md');
  let failWrite = true;
  const memFiles = new Map<string, string>();

  const flakyFs: MarkdownFileSystem = {
    exists: (p) => memFiles.has(p),
    readFile: (p) => memFiles.get(p)!,
    writeFileAtomic: (p, content) => {
      if (failWrite) throw new Error('EACCES: simulated disk write failure');
      memFiles.set(p, content);
    },
  };

  const store = new DecisionSyncStore({
    dbPath: join(dir, 'decisions.sqlite'),
    defaultDocPath: docPath,
    fs: flakyFs,
  });

  try {
    const d = store.createDecision({
      decisionId: 'DEC-IO-1',
      kind: 'business_decision',
      title: '数据备份路径',
      prompt: '选择归档路径',
      options: [{ id: 'archive', label: '归档至 /data/zhangzy/archive' }],
      source: { system: 'storage-mgr' },
    });

    const ans = store.answerDecision({
      decisionId: d.decisionId,
      expectedVersion: d.version,
      expectedDigest: d.digest,
      entryPoint: 'feishu_hub',
      idempotencyKey: 'io-ans-1',
      actor: owner,
      selectedOptionId: 'archive',
    });
    assert.equal(ans.decision.status, 'answered');

    const failedSync = store.syncMarkdownDocument(docPath);
    assert.equal(failedSync.syncStatus, 'pending_sync');
    assert.equal(store.getDecision('DEC-IO-1').status, 'answered');
    assert.equal(store.getDecision('DEC-IO-1').syncStatus, 'pending_sync');
    assert.equal(store.getAnswers('DEC-IO-1').length, 1);
    assert.equal(store.listDocOutbox(docPath)[0]?.attempts, 1);

    // Clear I/O failure and retry without re-asking user
    failWrite = false;
    const retried = store.retryPendingSyncs();
    assert.equal(retried.length, 1);
    assert.equal(retried[0]!.syncStatus, 'synced');
    assert.equal(store.getDecision('DEC-IO-1').syncStatus, 'synced');
    assert.match(memFiles.get(docPath) ?? '', /DEC-IO-1/);
    assert.match(memFiles.get(docPath) ?? '', /已登记答复: archive/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('business_decision "准备方案" triggers 0 executor calls and stays strictly separated from execution_auth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-sep-'));
  let executorCalls = 0;
  const store = new DecisionSyncStore({ dbPath: join(dir, 'decisions.sqlite') });

  try {
    // business_decision cannot attach executionSpec
    assert.throws(
      () =>
        store.createDecision({
          decisionId: 'DEC-BAD-BIZ',
          kind: 'business_decision',
          title: '非法携带执行器规格',
          prompt: '测试',
          options: [{ id: 'prepare', label: '准备方案' }],
          source: { system: 'test' },
          executionSpec: {
            actionDigest: 'sha256:abc',
            target: 'gpu-cluster',
            expiry: '2026-12-01T00:00:00Z',
            executorId: 'shell',
          },
        }),
      hasCode('invalid_request'),
    );

    const biz = store.createDecision({
      decisionId: 'DEC-BIZ-PLAN',
      kind: 'business_decision',
      title: 'dp_check 下一步策略',
      prompt: '是否先准备 dp_check 方案？',
      options: [
        { id: 'prepare_plan', label: '准备方案' },
        { id: 'defer', label: '暂缓' },
      ],
      source: { system: 'advisor-meeting' },
      bounds: { note: '仅文字与方案准备，绝不提交训练作业' },
    });

    const bizAnswer = store.answerDecision({
      decisionId: biz.decisionId,
      expectedVersion: biz.version,
      expectedDigest: biz.digest,
      entryPoint: 'feishu_hub',
      idempotencyKey: 'biz-prepare-plan',
      actor: owner,
      selectedOptionId: 'prepare_plan',
      rawUtterance: '选择准备方案',
    });
    assert.equal(bizAnswer.decision.status, 'answered');
    assert.equal(executorCalls, 0);

    // Attempting to execute a business_decision must fail with unsupported and 0 executor calls
    await assert.rejects(
      store.consumeExecutionAuth(biz.decisionId, 'any-digest', async () => {
        executorCalls++;
      }),
      hasCode('unsupported'),
    );
    assert.equal(executorCalls, 0);

    // execution_auth requires explicit spec, answering alone STILL invokes 0 executor calls
    const exec = store.createDecision({
      decisionId: 'DEC-EXEC-1',
      kind: 'execution_auth',
      title: '重启测试服务授权',
      prompt: '核对目标与动作摘要后确认是否执行一次性重启',
      options: [
        { id: 'approve_once', label: '授权执行一次' },
        { id: 'deny', label: '拒绝' },
      ],
      source: { system: 'ops' },
      executionSpec: {
        actionDigest: 'digest-restart-svc-v1',
        target: 'sandbox-test-service',
        expiry: '2030-01-01T00:00:00Z',
        executorId: 'systemd-restart',
        rollbackPlan: '回退旧 unit 文件',
      },
    });

    store.answerDecision({
      decisionId: exec.decisionId,
      expectedVersion: exec.version,
      expectedDigest: exec.digest,
      entryPoint: 'feishu_hub',
      idempotencyKey: 'exec-approve-1',
      actor: owner,
      selectedOptionId: 'approve_once',
    });
    assert.equal(executorCalls, 0);

    // Wrong digest rejected
    await assert.rejects(
      store.consumeExecutionAuth(exec.decisionId, 'wrong-digest', async () => {
        executorCalls++;
      }),
      hasCode('stale_revision'),
    );
    assert.equal(executorCalls, 0);

    // Correct digest consumes exactly once
    await store.consumeExecutionAuth(exec.decisionId, 'digest-restart-svc-v1', async (spec) => {
      executorCalls++;
      assert.equal(spec.target, 'sandbox-test-service');
    });
    assert.equal(executorCalls, 1);

    // Replay of one-time execution_auth rejected
    await assert.rejects(
      store.consumeExecutionAuth(exec.decisionId, 'digest-restart-svc-v1', async () => {
        executorCalls++;
      }),
      hasCode('stale_revision'),
    );
    assert.equal(executorCalls, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
