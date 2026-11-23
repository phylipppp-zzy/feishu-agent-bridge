import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { payloadDigest, type Identity } from '../contracts.js';
import {
  defaultMarkdownFs,
  renderDecisionGeneratedBlock,
  syncDecisionMarkdownDocument,
} from './decision-markdown.js';
import {
  DECISION_KINDS,
  computeDecisionDigest,
  fail,
  mapAnswerRow,
  mapDecisionRow,
  mapOutboxRow,
  nonempty,
  normalizeBounds,
  normalizeExecutionSpec,
  normalizeOptions,
  normalizeSource,
  sha256Text,
  type AnswerDecisionInput,
  type AnswerDecisionResult,
  type AnswerRow,
  type CreateDecisionInput,
  type DecisionAnswerRecord,
  type DecisionDocOutboxRecord,
  type DecisionKind,
  type DecisionRecord,
  type DecisionRow,
  type DecisionStatus,
  type DecisionSyncStoreOptions,
  type ExecutionSpec,
  type MarkdownFileSystem,
  type OutboxRow,
  type SyncMarkdownDocumentOptions,
  type SyncMarkdownResult,
  type UpdateDecisionInput,
} from './decision-types.js';

/**
 * D1: Structured business decision / execution authorization ledger
 * with protected anchored Markdown dual-view publisher.
 * Default empty baseline: zero auto-import from existing documents.
 */
export class DecisionSyncStore {
  private readonly db: DatabaseSync;
  private readonly defaultDocPath: string | null;
  private readonly protectedReadOnlyPaths: ReadonlySet<string>;
  private readonly authorizeActor:
    | ((actor: Identity, decision: DecisionRecord, action: 'create' | 'update' | 'answer') => boolean)
    | undefined;
  private readonly fs: MarkdownFileSystem;
  private readonly now: () => number;

  constructor(options: DecisionSyncStoreOptions) {
    if (!options || !nonempty(options.dbPath)) fail('invalid_request', 'dbPath is required');
    this.defaultDocPath = options.defaultDocPath ? resolve(options.defaultDocPath) : null;
    this.protectedReadOnlyPaths = new Set(
      [...(options.protectedReadOnlyPaths ?? [])].map((p) => resolve(p)),
    );
    this.authorizeActor = options.authorizeActor;
    this.fs = options.fs ?? defaultMarkdownFs;
    this.now = options.now ?? (() => Date.now());

    this.db = new DatabaseSync(options.dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS decisions_v1 (
        decision_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        version INTEGER NOT NULL,
        digest TEXT NOT NULL,
        options_json TEXT NOT NULL,
        allow_free_text INTEGER NOT NULL,
        source_json TEXT NOT NULL,
        bounds_json TEXT NOT NULL,
        execution_spec_json TEXT,
        status TEXT NOT NULL,
        sync_status TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        expires_at TEXT,
        exec_consumed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decision_answers_v1 (
        answer_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decisions_v1(decision_id),
        decision_version INTEGER NOT NULL,
        decision_digest TEXT NOT NULL,
        entry_point TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        actor_source TEXT NOT NULL,
        actor_subject TEXT NOT NULL,
        selected_option_id TEXT,
        selected_label TEXT,
        free_text TEXT,
        raw_utterance TEXT NOT NULL,
        source_destination TEXT,
        answered_at TEXT NOT NULL,
        answer_digest TEXT NOT NULL,
        UNIQUE(decision_id, decision_version)
      );
      CREATE TRIGGER IF NOT EXISTS decision_answers_immutable_update
        BEFORE UPDATE ON decision_answers_v1
        BEGIN
          SELECT RAISE(ABORT, 'decision_answers_v1 is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS decision_answers_immutable_delete
        BEFORE DELETE ON decision_answers_v1
        BEGIN
          SELECT RAISE(ABORT, 'decision_answers_v1 is append-only');
        END;
      CREATE TABLE IF NOT EXISTS decision_doc_outbox_v1 (
        outbox_id TEXT PRIMARY KEY,
        doc_path TEXT NOT NULL,
        decision_id TEXT,
        decision_version INTEGER,
        state TEXT NOT NULL,
        expected_file_hash TEXT,
        last_synced_block_hash TEXT,
        last_synced_file_hash TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getDecision(decisionId: string): DecisionRecord {
    const row = this.db
      .prepare('SELECT * FROM decisions_v1 WHERE decision_id=?')
      .get(decisionId) as DecisionRow | undefined;
    if (!row) fail('invalid_request', `unknown decision: ${decisionId}`);
    return mapDecisionRow(row);
  }

  listDecisions(filter?: { kind?: DecisionKind; status?: DecisionStatus }): DecisionRecord[] {
    const rows = this.db.prepare('SELECT * FROM decisions_v1 ORDER BY created_at, decision_id').all() as unknown as DecisionRow[];
    return rows
      .map((r) => mapDecisionRow(r))
      .filter((d) => (!filter?.kind || d.kind === filter.kind) && (!filter?.status || d.status === filter.status));
  }

  getAnswers(decisionId: string): DecisionAnswerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM decision_answers_v1 WHERE decision_id=? ORDER BY decision_version, rowid')
      .all(decisionId) as unknown as AnswerRow[];
    return rows.map((r) => mapAnswerRow(r));
  }

  listDocOutbox(docPath?: string): DecisionDocOutboxRecord[] {
    const rows = (
      docPath
        ? this.db
            .prepare('SELECT * FROM decision_doc_outbox_v1 WHERE doc_path=? ORDER BY rowid')
            .all(resolve(docPath))
        : this.db.prepare('SELECT * FROM decision_doc_outbox_v1 ORDER BY rowid').all()
    ) as unknown as OutboxRow[];
    return rows.map((r) => mapOutboxRow(r));
  }

  createDecision(input: CreateDecisionInput): DecisionRecord {
    if (!input || !nonempty(input.decisionId) || !nonempty(input.title) || !nonempty(input.prompt)) {
      fail('invalid_request', 'decisionId, title, and prompt are required');
    }
    if (!(DECISION_KINDS as readonly string[]).includes(input.kind)) {
      fail('invalid_request', `invalid decision kind: ${String(input.kind)}`);
    }
    const options = normalizeOptions(input.options);
    const allowFreeText = Boolean(input.allowFreeText);
    if (options.length === 0 && !allowFreeText) {
      fail('invalid_request', 'decision requires at least one option or allowFreeText');
    }
    const source = normalizeSource(input.source);
    const bounds = normalizeBounds(input.bounds);
    const executionSpec = normalizeExecutionSpec(input.kind, input.executionSpec);
    const ownerGeneration = input.ownerGeneration ?? 1;
    if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) {
      fail('invalid_request', 'ownerGeneration must be a positive integer');
    }
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt !== null && (!nonempty(expiresAt) || !Number.isFinite(Date.parse(expiresAt)))) {
      fail('invalid_request', 'expiresAt must be null or valid timestamp');
    }

    const version = 1;
    const digest = computeDecisionDigest({
      decisionId: input.decisionId,
      kind: input.kind,
      title: input.title,
      prompt: input.prompt,
      version,
      options,
      allowFreeText,
      source,
      bounds,
      executionSpec,
      expiresAt,
    });
    const timestamp = new Date(this.now()).toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare('SELECT * FROM decisions_v1 WHERE decision_id=?')
        .get(input.decisionId) as DecisionRow | undefined;
      if (existing) {
        if (existing.digest !== digest) {
          fail('idempotency_conflict', `decision ${input.decisionId} already exists with different payload`);
        }
        this.db.exec('COMMIT');
        return mapDecisionRow(existing);
      }

      this.db
        .prepare(
          `INSERT INTO decisions_v1(
            decision_id, kind, title, prompt, version, digest, options_json,
            allow_free_text, source_json, bounds_json, execution_spec_json,
            status, sync_status, owner_generation, expires_at, exec_consumed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'not_synced', ?, ?, NULL, ?, ?)`,
        )
        .run(
          input.decisionId,
          input.kind,
          input.title,
          input.prompt,
          version,
          digest,
          JSON.stringify(options),
          allowFreeText ? 1 : 0,
          JSON.stringify(source),
          JSON.stringify(bounds),
          executionSpec ? JSON.stringify(executionSpec) : null,
          ownerGeneration,
          expiresAt,
          timestamp,
          timestamp,
        );
      this.db.exec('COMMIT');
      return this.getDecision(input.decisionId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Upgrades decision content/options to a new version + digest.
   * Any historical answer stays permanently preserved in decision_answers_v1 for its old version,
   * and old option choices (e.g. old "A") can never auto-map to the new version.
   */
  updateDecision(input: UpdateDecisionInput): DecisionRecord {
    if (!input || !nonempty(input.decisionId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      fail('invalid_request', 'decisionId and valid expectedVersion are required');
    }
    const timestamp = new Date(this.now()).toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentRow = this.db
        .prepare('SELECT * FROM decisions_v1 WHERE decision_id=?')
        .get(input.decisionId) as DecisionRow | undefined;
      if (!currentRow) fail('invalid_request', `unknown decision: ${input.decisionId}`);
      if (currentRow.version !== input.expectedVersion) {
        fail('stale_revision', `expected version ${input.expectedVersion}, got ${currentRow.version}`);
      }
      const current = mapDecisionRow(currentRow);

      const title = input.title !== undefined ? input.title : current.title;
      const prompt = input.prompt !== undefined ? input.prompt : current.prompt;
      if (!nonempty(title) || !nonempty(prompt)) fail('invalid_request', 'title and prompt must be non-empty');
      const options = input.options !== undefined ? normalizeOptions(input.options) : current.options;
      const allowFreeText = input.allowFreeText !== undefined ? Boolean(input.allowFreeText) : current.allowFreeText;
      if (options.length === 0 && !allowFreeText) {
        fail('invalid_request', 'decision requires at least one option or allowFreeText');
      }
      const source = input.source !== undefined ? normalizeSource(input.source) : current.source;
      const bounds = input.bounds !== undefined ? normalizeBounds(input.bounds) : current.bounds;
      const executionSpec =
        input.executionSpec !== undefined
          ? normalizeExecutionSpec(current.kind, input.executionSpec)
          : current.executionSpec;
      const expiresAt = input.expiresAt !== undefined ? input.expiresAt : current.expiresAt;
      if (expiresAt !== null && (!nonempty(expiresAt) || !Number.isFinite(Date.parse(expiresAt)))) {
        fail('invalid_request', 'expiresAt must be null or valid timestamp');
      }

      const nextVersion = current.version + 1;
      const nextDigest = computeDecisionDigest({
        decisionId: current.decisionId,
        kind: current.kind,
        title,
        prompt,
        version: nextVersion,
        options,
        allowFreeText,
        source,
        bounds,
        executionSpec,
        expiresAt,
      });

      this.db
        .prepare(
          `UPDATE decisions_v1
           SET title=?, prompt=?, version=?, digest=?, options_json=?, allow_free_text=?,
               source_json=?, bounds_json=?, execution_spec_json=?, status='pending',
               sync_status='pending_sync', expires_at=?, exec_consumed_at=NULL, updated_at=?
           WHERE decision_id=? AND version=?`,
        )
        .run(
          title,
          prompt,
          nextVersion,
          nextDigest,
          JSON.stringify(options),
          allowFreeText ? 1 : 0,
          JSON.stringify(source),
          JSON.stringify(bounds),
          executionSpec ? JSON.stringify(executionSpec) : null,
          expiresAt,
          timestamp,
          current.decisionId,
          current.version,
        );

      if (this.defaultDocPath) {
        this.enqueueDocOutboxInTx(this.defaultDocPath, current.decisionId, nextVersion, timestamp);
      }
      this.db.exec('COMMIT');
      return this.getDecision(current.decisionId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Handler rotation only changes ownerGeneration; committed answers are never wiped. */
  transferOwnerGeneration(
    decisionId: string,
    expectedOwnerGeneration: number,
    nextOwnerGeneration: number,
  ): DecisionRecord {
    if (!Number.isSafeInteger(nextOwnerGeneration) || nextOwnerGeneration < 1) {
      fail('invalid_request', 'nextOwnerGeneration must be a positive integer');
    }
    const timestamp = new Date(this.now()).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getDecision(decisionId);
      if (current.ownerGeneration !== expectedOwnerGeneration) {
        fail('control_conflict', 'ownerGeneration mismatch');
      }
      this.db
        .prepare('UPDATE decisions_v1 SET owner_generation=?, updated_at=? WHERE decision_id=? AND owner_generation=?')
        .run(nextOwnerGeneration, timestamp, decisionId, expectedOwnerGeneration);
      this.db.exec('COMMIT');
      return this.getDecision(decisionId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Single-transaction CAS answer commitment.
   * Never invokes any shell or executor; records immutable answer in decision_answers_v1.
   */
  answerDecision(input: AnswerDecisionInput): AnswerDecisionResult {
    if (
      !input ||
      !nonempty(input.decisionId) ||
      !nonempty(input.entryPoint) ||
      !nonempty(input.idempotencyKey) ||
      !input.actor ||
      !nonempty(input.actor.source) ||
      !nonempty(input.actor.subject) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      !nonempty(input.expectedDigest)
    ) {
      fail('invalid_request', 'invalid decision answer request');
    }

    const selectedOptionId = input.selectedOptionId ?? null;
    const freeText = input.freeText !== undefined && input.freeText !== null ? input.freeText.trim() || null : null;
    if (!selectedOptionId && !freeText) {
      fail('invalid_request', 'either selectedOptionId or freeText is required');
    }

    const answerDigest = payloadDigest({
      decisionId: input.decisionId,
      expectedVersion: input.expectedVersion,
      expectedDigest: input.expectedDigest,
      selectedOptionId,
      freeText,
      actor: input.actor,
    });
    const nowMs = this.now();
    const timestamp = new Date(nowMs).toISOString();
    let expiredToPersist = false;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const priorAnswer = this.db
        .prepare('SELECT * FROM decision_answers_v1 WHERE idempotency_key=?')
        .get(input.idempotencyKey) as AnswerRow | undefined;
      if (priorAnswer) {
        if (
          priorAnswer.decision_id !== input.decisionId ||
          priorAnswer.decision_version !== input.expectedVersion ||
          priorAnswer.decision_digest !== input.expectedDigest ||
          priorAnswer.answer_digest !== answerDigest
        ) {
          fail('idempotency_conflict', 'idempotencyKey reused with conflicting decision answer');
        }
        const decision = this.getDecision(input.decisionId);
        this.db.exec('COMMIT');
        return {
          winner: false,
          idempotent: true,
          decision,
          answer: mapAnswerRow(priorAnswer),
        };
      }

      const currentRow = this.db
        .prepare('SELECT * FROM decisions_v1 WHERE decision_id=?')
        .get(input.decisionId) as DecisionRow | undefined;
      if (!currentRow) fail('invalid_request', `unknown decision: ${input.decisionId}`);
      const current = mapDecisionRow(currentRow);

      if (this.authorizeActor && !this.authorizeActor(input.actor, current, 'answer')) {
        fail('unauthorized', 'actor is not authorized to answer this decision');
      }
      if (current.version !== input.expectedVersion) {
        fail('stale_revision', `decision version changed (expected ${input.expectedVersion}, actual ${current.version})`);
      }
      if (current.digest !== input.expectedDigest) {
        fail('stale_revision', 'decision digest mismatch');
      }
      if (current.expiresAt !== null && Date.parse(current.expiresAt) <= nowMs) {
        if (current.status === 'pending') {
          this.db
            .prepare("UPDATE decisions_v1 SET status='expired', updated_at=? WHERE decision_id=? AND status='pending'")
            .run(timestamp, current.decisionId);
          expiredToPersist = true;
        }
        fail('interaction_expired', 'decision has expired');
      }
      if (current.status === 'answered') {
        fail('stale_revision', 'decision has already been answered');
      }
      if (current.status !== 'pending') {
        fail('interaction_expired', `decision is ${current.status}`);
      }

      let selectedLabel: string | null = null;
      if (selectedOptionId !== null) {
        const option = current.options.find((o) => o.id === selectedOptionId);
        if (!option) fail('invalid_request', `unknown option id: ${selectedOptionId}`);
        selectedLabel = option.label;
      }
      if (freeText !== null && !current.allowFreeText) {
        fail('invalid_request', 'freeText is not allowed for this decision');
      }

      const rawUtterance = nonempty(input.rawUtterance)
        ? input.rawUtterance
        : [selectedLabel, freeText].filter(Boolean).join(' · ');
      const answerId = `ans:${payloadDigest([current.decisionId, current.version, input.idempotencyKey])}`;

      this.db
        .prepare(
          `INSERT INTO decision_answers_v1(
            answer_id, decision_id, decision_version, decision_digest, entry_point,
            idempotency_key, actor_source, actor_subject, selected_option_id, selected_label,
            free_text, raw_utterance, source_destination, answered_at, answer_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          answerId,
          current.decisionId,
          current.version,
          current.digest,
          input.entryPoint,
          input.idempotencyKey,
          input.actor.source,
          input.actor.subject,
          selectedOptionId,
          selectedLabel,
          freeText,
          rawUtterance,
          input.sourceDestination ?? null,
          timestamp,
          answerDigest,
        );

      const updated = this.db
        .prepare(
          `UPDATE decisions_v1
           SET status='answered', sync_status='pending_sync', updated_at=?
           WHERE decision_id=? AND version=? AND digest=? AND status='pending'`,
        )
        .run(timestamp, current.decisionId, current.version, current.digest);
      if (updated.changes !== 1) {
        fail('stale_revision', 'concurrent answer modified decision state');
      }

      if (this.defaultDocPath) {
        this.enqueueDocOutboxInTx(this.defaultDocPath, current.decisionId, current.version, timestamp);
      }

      const savedDecision = this.getDecision(current.decisionId);
      const savedAnswerRow = this.db
        .prepare('SELECT * FROM decision_answers_v1 WHERE answer_id=?')
        .get(answerId) as unknown as AnswerRow;
      this.db.exec('COMMIT');

      return {
        winner: true,
        idempotent: false,
        decision: savedDecision,
        answer: mapAnswerRow(savedAnswerRow),
      };
    } catch (error) {
      if (expiredToPersist) {
        this.db.exec('COMMIT');
      } else {
        this.db.exec('ROLLBACK');
      }
      throw error;
    }
  }

  /**
   * Explicitly consumes a one-time execution_auth record.
   * Strictly rejects business_decision with `unsupported` and 0 executor calls.
   */
  async consumeExecutionAuth(
    decisionId: string,
    expectedActionDigest: string,
    executor: (spec: ExecutionSpec, decision: DecisionRecord, answer: DecisionAnswerRecord) => Promise<void>,
  ): Promise<void> {
    const decision = this.getDecision(decisionId);
    if (decision.kind !== 'execution_auth' || !decision.executionSpec) {
      fail('unsupported', 'business_decision cannot trigger any executor');
    }
    if (decision.status !== 'answered') {
      fail('control_conflict', 'execution_auth has not been answered');
    }
    if (decision.executionSpec.actionDigest !== expectedActionDigest) {
      fail('stale_revision', 'execution actionDigest mismatch');
    }
    if (Date.parse(decision.executionSpec.expiry) <= this.now()) {
      fail('interaction_expired', 'execution authorization expired');
    }
    const answers = this.getAnswers(decisionId).filter((a) => a.decisionVersion === decision.version);
    const answer = answers[answers.length - 1];
    if (!answer) fail('control_conflict', 'missing committed answer for execution_auth');
    if (answer.selectedOptionId === 'deny' || answer.selectedOptionId === 'cancel') {
      fail('unauthorized', 'execution authorization was denied');
    }

    const timestamp = new Date(this.now()).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed = this.db
        .prepare(
          "UPDATE decisions_v1 SET exec_consumed_at=?, updated_at=? WHERE decision_id=? AND kind='execution_auth' AND version=? AND status='answered' AND exec_consumed_at IS NULL",
        )
        .run(timestamp, timestamp, decisionId, decision.version);
      if (claimed.changes !== 1) {
        fail('stale_revision', 'execution_auth already consumed or changed');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    await executor(decision.executionSpec, this.getDecision(decisionId), answer);
  }

  private enqueueDocOutboxInTx(
    docPath: string,
    decisionId: string | null,
    decisionVersion: number | null,
    timestamp: string,
  ): void {
    const normalizedPath = resolve(docPath);
    const existing = this.db
      .prepare('SELECT outbox_id FROM decision_doc_outbox_v1 WHERE doc_path=?')
      .get(normalizedPath) as { outbox_id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE decision_doc_outbox_v1
           SET decision_id=COALESCE(?, decision_id), decision_version=COALESCE(?, decision_version),
               state='pending_sync', updated_at=?
           WHERE outbox_id=?`,
        )
        .run(decisionId, decisionVersion, timestamp, existing.outbox_id);
    } else {
      this.db
        .prepare(
          `INSERT INTO decision_doc_outbox_v1(
            outbox_id, doc_path, decision_id, decision_version, state,
            expected_file_hash, last_synced_block_hash, last_synced_file_hash,
            attempts, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending_sync', NULL, NULL, NULL, 0, NULL, ?, ?)`,
        )
        .run(`doc:${sha256Text(normalizedPath)}`, normalizedPath, decisionId, decisionVersion, timestamp, timestamp);
    }
  }

  renderGeneratedBlock(): string {
    return renderDecisionGeneratedBlock(this.listDecisions(), (id) => this.getAnswers(id));
  }

  /**
   * Publishes only the anchored block inside `docPath`, preserving 100% of external human blocks.
   * Detects out-of-band file modifications via hash check before writing and refuses overwrite on conflict.
   * Never rolls back committed answers on conflict or I/O failure.
   */
  syncMarkdownDocument(docPath: string, options: SyncMarkdownDocumentOptions = {}): SyncMarkdownResult {
    return syncDecisionMarkdownDocument(
      {
        db: this.db,
        fs: this.fs,
        protectedReadOnlyPaths: this.protectedReadOnlyPaths,
        now: this.now,
        listDecisions: () => this.listDecisions(),
        renderGeneratedBlock: () => this.renderGeneratedBlock(),
      },
      docPath,
      options,
    );
  }

  retryPendingSyncs(): SyncMarkdownResult[] {
    const pending = this.db
      .prepare("SELECT doc_path FROM decision_doc_outbox_v1 WHERE state='pending_sync' ORDER BY rowid")
      .all() as Array<{ doc_path: string }>;
    return pending.map((row) => this.syncMarkdownDocument(row.doc_path));
  }
}
