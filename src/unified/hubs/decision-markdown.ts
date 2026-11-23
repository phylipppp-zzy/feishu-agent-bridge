import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  DECISION_SYNC_END,
  DECISION_SYNC_START,
  fail,
  nonempty,
  sha256Text,
  type DecisionAnswerRecord,
  type DecisionRecord,
  type MarkdownFileSystem,
  type OutboxRow,
  type SyncMarkdownDocumentOptions,
  type SyncMarkdownResult,
} from './decision-types.js';

export const defaultMarkdownFs: MarkdownFileSystem = {
  exists: (filePath: string) => existsSync(filePath),
  readFile: (filePath: string) => readFileSync(filePath, 'utf8'),
  writeFileAtomic: (filePath: string, content: string) => {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tempPath = join(dir, `.decision-sync-${process.pid}-${randomUUID()}.tmp`);
    try {
      writeFileSync(tempPath, content, 'utf8');
      renameSync(tempPath, filePath);
    } catch (error) {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors after write failure.
      }
      throw error;
    }
  },
};

export function renderDecisionGeneratedBlock(
  decisions: DecisionRecord[],
  getAnswers: (decisionId: string) => DecisionAnswerRecord[],
): string {
  const lines: string[] = [
    '## 结构化决定与授权状态（系统生成区，请勿手动编辑锚点内内容）',
    '',
  ];
  if (decisions.length === 0) {
    lines.push('当前暂无待处理或已登记的结构化决定。');
    return lines.join('\n');
  }

  for (const d of decisions) {
    const kindLabel = d.kind === 'business_decision' ? '业务决定' : '执行授权';
    const answers = getAnswers(d.decisionId);
    const latestAnswer = answers.find((a) => a.decisionVersion === d.version) ?? null;
    lines.push(`### ${d.decisionId} · ${d.title}`);
    lines.push(`- 类别: ${kindLabel} (${d.kind})`);
    lines.push(`- 状态: ${d.status} · 版本: v${d.version} · 摘要: ${d.digest.slice(0, 12)} · 负责人代次: ${d.ownerGeneration}`);
    lines.push(`- 说明: ${d.prompt}`);
    lines.push(`- 选项: ${d.options.map((o) => `${o.id}:${o.label}`).join(' | ')}${d.allowFreeText ? ' (支持自由输入)' : ''}`);
    if (d.bounds.scope || d.bounds.target || d.bounds.maxCost) {
      lines.push(
        `- 边界: ${[d.bounds.scope && `scope=${d.bounds.scope}`, d.bounds.target && `target=${d.bounds.target}`, d.bounds.maxCost && `maxCost=${d.bounds.maxCost}`].filter(Boolean).join(' · ')}`,
      );
    }
    if (d.executionSpec) {
      lines.push(
        `- 执行规格: executor=${d.executionSpec.executorId} · target=${d.executionSpec.target} · actionDigest=${d.executionSpec.actionDigest} · expiry=${d.executionSpec.expiry}`,
      );
    }
    if (latestAnswer) {
      lines.push(
        `- 已登记答复: ${latestAnswer.selectedOptionId ?? '(自由输入)'}${latestAnswer.selectedLabel ? ` (${latestAnswer.selectedLabel})` : ''} · 原话: ${JSON.stringify(latestAnswer.rawUtterance)} · 入口: ${latestAnswer.entryPoint} · 作答人: ${latestAnswer.actor.subject} · 时间: ${latestAnswer.answeredAt}`,
      );
    } else {
      lines.push('- 已登记答复: 暂无（待决定）');
    }
    if (answers.some((a) => a.decisionVersion < d.version)) {
      const prior = answers
        .filter((a) => a.decisionVersion < d.version)
        .map((a) => `v${a.decisionVersion}:${a.selectedOptionId ?? a.rawUtterance}`)
        .join(', ');
      lines.push(`- 历史版本答复留痕: ${prior}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export interface SyncMarkdownContext {
  db: DatabaseSync;
  fs: MarkdownFileSystem;
  protectedReadOnlyPaths: ReadonlySet<string>;
  now: () => number;
  listDecisions: () => DecisionRecord[];
  renderGeneratedBlock: () => string;
}

export function syncDecisionMarkdownDocument(
  ctx: SyncMarkdownContext,
  docPath: string,
  options: SyncMarkdownDocumentOptions = {},
): SyncMarkdownResult {
  if (!nonempty(docPath)) fail('invalid_request', 'docPath is required');
  const resolvedPath = resolve(docPath);
  if (ctx.protectedReadOnlyPaths.has(resolvedPath)) {
    fail('unauthorized', `target markdown document is protected read-only: ${resolvedPath}`);
  }

  const timestamp = new Date(ctx.now()).toISOString();
  const outboxRow = ctx.db
    .prepare('SELECT * FROM decision_doc_outbox_v1 WHERE doc_path=?')
    .get(resolvedPath) as OutboxRow | undefined;
  const lastSyncedFileHash = outboxRow?.last_synced_file_hash ?? null;
  const exists = ctx.fs.exists(resolvedPath);
  const decisions = ctx.listDecisions();
  const generatedBlock = ctx.renderGeneratedBlock();

  const recordConflict = (
    expectedFileHash: string | null,
    actualFileHash: string | null,
    reason: string,
  ): SyncMarkdownResult => {
    ctx.db.exec('BEGIN IMMEDIATE');
    try {
      if (outboxRow) {
        ctx.db
          .prepare(
            `UPDATE decision_doc_outbox_v1
             SET state='conflict_pending_manual_merge', expected_file_hash=?, last_error=?, updated_at=?
             WHERE outbox_id=?`,
          )
          .run(expectedFileHash, reason, timestamp, outboxRow.outbox_id);
      } else {
        ctx.db
          .prepare(
            `INSERT INTO decision_doc_outbox_v1(
              outbox_id, doc_path, decision_id, decision_version, state,
              expected_file_hash, last_synced_block_hash, last_synced_file_hash,
              attempts, last_error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'conflict_pending_manual_merge', ?, NULL, NULL, 0, ?, ?, ?)`,
          )
          .run(
            `doc:${sha256Text(resolvedPath)}`,
            resolvedPath,
            options.triggerDecisionId ?? null,
            options.triggerDecisionVersion ?? null,
            expectedFileHash,
            reason,
            timestamp,
            timestamp,
          );
      }
      ctx.db
        .prepare(
          "UPDATE decisions_v1 SET sync_status='conflict_pending_manual_merge', updated_at=? WHERE sync_status IN ('not_synced', 'pending_sync')",
        )
        .run(timestamp);
      ctx.db.exec('COMMIT');
    } catch (error) {
      ctx.db.exec('ROLLBACK');
      throw error;
    }
    return {
      syncStatus: 'conflict_pending_manual_merge',
      docPath: resolvedPath,
      expectedFileHash,
      actualFileHash,
      reason,
    };
  };

  const recordWriteFailure = (errorMessage: string): SyncMarkdownResult => {
    ctx.db.exec('BEGIN IMMEDIATE');
    try {
      if (outboxRow) {
        ctx.db
          .prepare(
            `UPDATE decision_doc_outbox_v1
             SET state='pending_sync', attempts=attempts+1, last_error=?, updated_at=?
             WHERE outbox_id=?`,
          )
          .run(errorMessage, timestamp, outboxRow.outbox_id);
      } else {
        ctx.db
          .prepare(
            `INSERT INTO decision_doc_outbox_v1(
              outbox_id, doc_path, decision_id, decision_version, state,
              expected_file_hash, last_synced_block_hash, last_synced_file_hash,
              attempts, last_error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'pending_sync', NULL, NULL, NULL, 1, ?, ?, ?)`,
          )
          .run(
            `doc:${sha256Text(resolvedPath)}`,
            resolvedPath,
            options.triggerDecisionId ?? null,
            options.triggerDecisionVersion ?? null,
            errorMessage,
            timestamp,
            timestamp,
          );
      }
      ctx.db
        .prepare(
          "UPDATE decisions_v1 SET sync_status='pending_sync', updated_at=? WHERE sync_status IN ('not_synced', 'pending_sync', 'conflict_pending_manual_merge')",
        )
        .run(timestamp);
      ctx.db.exec('COMMIT');
    } catch (error) {
      ctx.db.exec('ROLLBACK');
      throw error;
    }
    return {
      syncStatus: 'pending_sync',
      docPath: resolvedPath,
      error: errorMessage,
      retryable: true,
    };
  };

  let nextContent: string;
  if (!exists) {
    if (lastSyncedFileHash !== null && !options.allowRebaseAfterManualMerge) {
      return recordConflict(lastSyncedFileHash, null, 'previously synced document is missing');
    }
    if (options.expectedFileHash !== undefined) {
      return recordConflict(options.expectedFileHash, null, 'expected file missing on disk');
    }
    if (options.createIfMissing === false) {
      return recordWriteFailure('target markdown file does not exist and createIfMissing is false');
    }
    nextContent = `${DECISION_SYNC_START}\n${generatedBlock}\n${DECISION_SYNC_END}\n`;
  } else {
    let currentContent: string;
    try {
      currentContent = ctx.fs.readFile(resolvedPath);
    } catch (error) {
      return recordWriteFailure(error instanceof Error ? error.message : String(error));
    }
    const actualFileHash = sha256Text(currentContent);
    if (options.expectedFileHash !== undefined && actualFileHash !== options.expectedFileHash) {
      return recordConflict(
        options.expectedFileHash,
        actualFileHash,
        'file hash differs from caller expectedFileHash',
      );
    }
    if (
      lastSyncedFileHash !== null &&
      actualFileHash !== lastSyncedFileHash &&
      !options.allowRebaseAfterManualMerge
    ) {
      return recordConflict(
        lastSyncedFileHash,
        actualFileHash,
        'file modified manually since last sync; manual merge required',
      );
    }

    const startIdx = currentContent.indexOf(DECISION_SYNC_START);
    const lastStartIdx = currentContent.lastIndexOf(DECISION_SYNC_START);
    const endIdx = currentContent.indexOf(DECISION_SYNC_END);
    const lastEndIdx = currentContent.lastIndexOf(DECISION_SYNC_END);

    if (
      startIdx === -1 ||
      endIdx === -1 ||
      startIdx !== lastStartIdx ||
      endIdx !== lastEndIdx ||
      endIdx <= startIdx
    ) {
      return recordConflict(
        options.expectedFileHash ?? lastSyncedFileHash,
        actualFileHash,
        'missing, duplicate, or malformed DECISION_SYNC anchors',
      );
    }

    const before = currentContent.slice(0, startIdx + DECISION_SYNC_START.length);
    const after = currentContent.slice(endIdx);
    nextContent = `${before}\n${generatedBlock}\n${after}`;
  }

  try {
    ctx.fs.writeFileAtomic(resolvedPath, nextContent);
  } catch (error) {
    return recordWriteFailure(error instanceof Error ? error.message : String(error));
  }

  const fileHash = sha256Text(nextContent);
  const blockHash = sha256Text(generatedBlock);

  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    if (outboxRow) {
      ctx.db
        .prepare(
          `UPDATE decision_doc_outbox_v1
           SET state='synced', expected_file_hash=?, last_synced_block_hash=?,
               last_synced_file_hash=?, last_error=NULL, updated_at=?
           WHERE outbox_id=?`,
        )
        .run(fileHash, blockHash, fileHash, timestamp, outboxRow.outbox_id);
    } else {
      ctx.db
        .prepare(
          `INSERT INTO decision_doc_outbox_v1(
            outbox_id, doc_path, decision_id, decision_version, state,
            expected_file_hash, last_synced_block_hash, last_synced_file_hash,
            attempts, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'synced', ?, ?, ?, 0, NULL, ?, ?)`,
        )
        .run(
          `doc:${sha256Text(resolvedPath)}`,
          resolvedPath,
          options.triggerDecisionId ?? null,
          options.triggerDecisionVersion ?? null,
          fileHash,
          blockHash,
          fileHash,
          timestamp,
          timestamp,
        );
    }
    ctx.db
      .prepare(
        "UPDATE decisions_v1 SET sync_status='synced', updated_at=? WHERE sync_status IN ('not_synced', 'pending_sync', 'conflict_pending_manual_merge')",
      )
      .run(timestamp);
    ctx.db.exec('COMMIT');
  } catch (error) {
    ctx.db.exec('ROLLBACK');
    throw error;
  }

  return {
    syncStatus: 'synced',
    docPath: resolvedPath,
    fileHash,
    blockHash,
    decisionCount: decisions.length,
  };
}
