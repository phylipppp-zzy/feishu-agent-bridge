import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { payloadDigest, type Identity } from './contracts.js';
import { contractError } from './errors.js';
import { StoreError } from './store.js';

export const DECISION_SYNC_START = '<!-- DECISION_SYNC_START -->';
export const DECISION_SYNC_END = '<!-- DECISION_SYNC_END -->';

export const DECISION_KINDS = ['business_decision', 'execution_auth'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export type DecisionStatus = 'pending' | 'answered' | 'expired' | 'cancelled';
export type DecisionSyncStatus =
  | 'not_synced'
  | 'pending_sync'
  | 'synced'
  | 'conflict_pending_manual_merge';

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface DecisionSource {
  system: string;
  sessionId?: string;
  destination?: string;
  refId?: string;
}

export interface DecisionBounds {
  scope?: string;
  target?: string;
  maxCost?: string;
  rollbackPlan?: string;
  note?: string;
}

export interface ExecutionSpec {
  actionDigest: string;
  target: string;
  expiry: string;
  executorId: string;
  maxCost?: string;
  rollbackPlan?: string;
}

export interface DecisionRecord {
  decisionId: string;
  kind: DecisionKind;
  title: string;
  prompt: string;
  version: number;
  digest: string;
  options: DecisionOption[];
  allowFreeText: boolean;
  source: DecisionSource;
  bounds: DecisionBounds;
  executionSpec: ExecutionSpec | null;
  status: DecisionStatus;
  syncStatus: DecisionSyncStatus;
  ownerGeneration: number;
  expiresAt: string | null;
  execConsumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionAnswerRecord {
  answerId: string;
  decisionId: string;
  decisionVersion: number;
  decisionDigest: string;
  entryPoint: string;
  idempotencyKey: string;
  actor: Identity;
  selectedOptionId: string | null;
  selectedLabel: string | null;
  freeText: string | null;
  rawUtterance: string;
  sourceDestination: string | null;
  answeredAt: string;
  answerDigest: string;
}

export interface DecisionDocOutboxRecord {
  outboxId: string;
  docPath: string;
  decisionId: string | null;
  decisionVersion: number | null;
  state: 'pending_sync' | 'synced' | 'conflict_pending_manual_merge';
  expectedFileHash: string | null;
  lastSyncedBlockHash: string | null;
  lastSyncedFileHash: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDecisionInput {
  decisionId: string;
  kind: DecisionKind;
  title: string;
  prompt: string;
  options: DecisionOption[];
  allowFreeText?: boolean;
  source: DecisionSource;
  bounds?: DecisionBounds;
  executionSpec?: ExecutionSpec | null;
  ownerGeneration?: number;
  expiresAt?: string | null;
}

export interface UpdateDecisionInput {
  decisionId: string;
  expectedVersion: number;
  title?: string;
  prompt?: string;
  options?: DecisionOption[];
  allowFreeText?: boolean;
  source?: DecisionSource;
  bounds?: DecisionBounds;
  executionSpec?: ExecutionSpec | null;
  expiresAt?: string | null;
}

export interface AnswerDecisionInput {
  decisionId: string;
  expectedVersion: number;
  expectedDigest: string;
  entryPoint: string;
  idempotencyKey: string;
  actor: Identity;
  selectedOptionId?: string | null;
  freeText?: string | null;
  rawUtterance?: string;
  sourceDestination?: string | null;
}

export interface AnswerDecisionResult {
  winner: boolean;
  idempotent: boolean;
  decision: DecisionRecord;
  answer: DecisionAnswerRecord;
}

export interface MarkdownFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFileAtomic(path: string, content: string): void;
}

export interface SyncMarkdownDocumentOptions {
  expectedFileHash?: string;
  createIfMissing?: boolean;
  allowRebaseAfterManualMerge?: boolean;
  triggerDecisionId?: string;
  triggerDecisionVersion?: number;
}

export type SyncMarkdownResult =
  | {
      syncStatus: 'synced';
      docPath: string;
      fileHash: string;
      blockHash: string;
      decisionCount: number;
    }
  | {
      syncStatus: 'conflict_pending_manual_merge';
      docPath: string;
      expectedFileHash: string | null;
      actualFileHash: string | null;
      reason: string;
    }
  | {
      syncStatus: 'pending_sync';
      docPath: string;
      error: string;
      retryable: true;
    };

export interface DecisionSyncStoreOptions {
  dbPath: string;
  defaultDocPath?: string;
  protectedReadOnlyPaths?: ReadonlySet<string>;
  authorizeActor?: (actor: Identity, decision: DecisionRecord, action: 'create' | 'update' | 'answer') => boolean;
  fs?: MarkdownFileSystem;
  now?: () => number;
}

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function fail(code: Parameters<typeof contractError>[0], message: string): never {
  throw new StoreError(contractError(code, message));
}

function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const defaultMarkdownFs: MarkdownFileSystem = {
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

function normalizeOptions(options: DecisionOption[]): DecisionOption[] {
  if (!Array.isArray(options)) fail('invalid_request', 'options must be an array');
  const seen = new Set<string>();
  const result: DecisionOption[] = [];
  for (const item of options) {
    if (!item || !nonempty(item.id) || !nonempty(item.label)) {
      fail('invalid_request', 'each decision option must have non-empty id and label');
    }
    if (seen.has(item.id)) fail('invalid_request', `duplicate option id: ${item.id}`);
    seen.add(item.id);
    const normalized: DecisionOption = { id: item.id, label: item.label };
    if (item.description !== undefined) {
      if (typeof item.description !== 'string') fail('invalid_request', 'option description must be a string');
      if (item.description.trim()) normalized.description = item.description;
    }
    result.push(normalized);
  }
  return result;
}

function normalizeSource(source: DecisionSource): DecisionSource {
  if (!source || !nonempty(source.system)) fail('invalid_request', 'decision source.system is required');
  const normalized: DecisionSource = { system: source.system };
  if (source.sessionId !== undefined) {
    if (!nonempty(source.sessionId)) fail('invalid_request', 'source.sessionId must be non-empty');
    normalized.sessionId = source.sessionId;
  }
  if (source.destination !== undefined) {
    if (!nonempty(source.destination)) fail('invalid_request', 'source.destination must be non-empty');
    normalized.destination = source.destination;
  }
  if (source.refId !== undefined) {
    if (!nonempty(source.refId)) fail('invalid_request', 'source.refId must be non-empty');
    normalized.refId = source.refId;
  }
  return normalized;
}

function normalizeBounds(bounds: DecisionBounds | undefined): DecisionBounds {
  if (bounds === undefined) return {};
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) {
    fail('invalid_request', 'decision bounds must be an object');
  }
  const normalized: DecisionBounds = {};
  for (const key of ['scope', 'target', 'maxCost', 'rollbackPlan', 'note'] as const) {
    const value = bounds[key];
    if (value !== undefined) {
      if (typeof value !== 'string') fail('invalid_request', `bounds.${key} must be a string`);
      if (value.trim()) normalized[key] = value;
    }
  }
  return normalized;
}

function normalizeExecutionSpec(kind: DecisionKind, spec: ExecutionSpec | null | undefined): ExecutionSpec | null {
  if (kind === 'business_decision') {
    if (spec !== undefined && spec !== null) {
      fail('invalid_request', 'business_decision must not include executionSpec');
    }
    return null;
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    fail('invalid_request', 'execution_auth requires executionSpec');
  }
  if (
    !nonempty(spec.actionDigest) ||
    !nonempty(spec.target) ||
    !nonempty(spec.expiry) ||
    !nonempty(spec.executorId) ||
    !Number.isFinite(Date.parse(spec.expiry))
  ) {
    fail('invalid_request', 'executionSpec requires actionDigest, target, valid expiry, and executorId');
  }
  const normalized: ExecutionSpec = {
    actionDigest: spec.actionDigest,
    target: spec.target,
    expiry: spec.expiry,
    executorId: spec.executorId,
  };
  if (spec.maxCost !== undefined) {
    if (!nonempty(spec.maxCost)) fail('invalid_request', 'executionSpec.maxCost must be non-empty');
    normalized.maxCost = spec.maxCost;
  }
  if (spec.rollbackPlan !== undefined) {
    if (!nonempty(spec.rollbackPlan)) fail('invalid_request', 'executionSpec.rollbackPlan must be non-empty');
    normalized.rollbackPlan = spec.rollbackPlan;
  }
  return normalized;
}

export function computeDecisionDigest(params: {
  decisionId: string;
  kind: DecisionKind;
  title: string;
  prompt: string;
  version: number;
  options: DecisionOption[];
  allowFreeText: boolean;
  source: DecisionSource;
  bounds: DecisionBounds;
  executionSpec: ExecutionSpec | null;
  expiresAt: string | null;
}): string {
  return payloadDigest(params);
}

interface DecisionRow {
  decision_id: string;
  kind: DecisionKind;
  title: string;
  prompt: string;
  version: number;
  digest: string;
  options_json: string;
  allow_free_text: number;
  source_json: string;
  bounds_json: string;
  execution_spec_json: string | null;
  status: DecisionStatus;
  sync_status: DecisionSyncStatus;
  owner_generation: number;
  expires_at: string | null;
  exec_consumed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AnswerRow {
  answer_id: string;
  decision_id: string;
  decision_version: number;
  decision_digest: string;
  entry_point: string;
  idempotency_key: string;
  actor_source: string;
  actor_subject: string;
  selected_option_id: string | null;
  selected_label: string | null;
  free_text: string | null;
  raw_utterance: string;
  source_destination: string | null;
  answered_at: string;
  answer_digest: string;
}

interface OutboxRow {
  outbox_id: string;
  doc_path: string;
  decision_id: string | null;
  decision_version: number | null;
  state: 'pending_sync' | 'synced' | 'conflict_pending_manual_merge';
  expected_file_hash: string | null;
  last_synced_block_hash: string | null;
  last_synced_file_hash: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

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

  private mapDecision(row: DecisionRow): DecisionRecord {
    return {
      decisionId: row.decision_id,
      kind: row.kind,
      title: row.title,
      prompt: row.prompt,
      version: row.version,
      digest: row.digest,
      options: JSON.parse(row.options_json) as DecisionOption[],
      allowFreeText: row.allow_free_text === 1,
      source: JSON.parse(row.source_json) as DecisionSource,
      bounds: JSON.parse(row.bounds_json) as DecisionBounds,
      executionSpec: row.execution_spec_json ? (JSON.parse(row.execution_spec_json) as ExecutionSpec) : null,
      status: row.status,
      syncStatus: row.sync_status,
      ownerGeneration: row.owner_generation,
      expiresAt: row.expires_at,
      execConsumedAt: row.exec_consumed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAnswer(row: AnswerRow): DecisionAnswerRecord {
    return {
      answerId: row.answer_id,
      decisionId: row.decision_id,
      decisionVersion: row.decision_version,
      decisionDigest: row.decision_digest,
      entryPoint: row.entry_point,
      idempotencyKey: row.idempotency_key,
      actor: { source: row.actor_source, subject: row.actor_subject },
      selectedOptionId: row.selected_option_id,
      selectedLabel: row.selected_label,
      freeText: row.free_text,
      rawUtterance: row.raw_utterance,
      sourceDestination: row.source_destination,
      answeredAt: row.answered_at,
      answerDigest: row.answer_digest,
    };
  }

  private mapOutbox(row: OutboxRow): DecisionDocOutboxRecord {
    return {
      outboxId: row.outbox_id,
      docPath: row.doc_path,
      decisionId: row.decision_id,
      decisionVersion: row.decision_version,
      state: row.state,
      expectedFileHash: row.expected_file_hash,
      lastSyncedBlockHash: row.last_synced_block_hash,
      lastSyncedFileHash: row.last_synced_file_hash,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getDecision(decisionId: string): DecisionRecord {
    const row = this.db
      .prepare('SELECT * FROM decisions_v1 WHERE decision_id=?')
      .get(decisionId) as DecisionRow | undefined;
    if (!row) fail('invalid_request', `unknown decision: ${decisionId}`);
    return this.mapDecision(row);
  }

  listDecisions(filter?: { kind?: DecisionKind; status?: DecisionStatus }): DecisionRecord[] {
    const rows = this.db.prepare('SELECT * FROM decisions_v1 ORDER BY created_at, decision_id').all() as unknown as DecisionRow[];
    return rows
      .map((r) => this.mapDecision(r))
      .filter((d) => (!filter?.kind || d.kind === filter.kind) && (!filter?.status || d.status === filter.status));
  }

  getAnswers(decisionId: string): DecisionAnswerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM decision_answers_v1 WHERE decision_id=? ORDER BY decision_version, rowid')
      .all(decisionId) as unknown as AnswerRow[];
    return rows.map((r) => this.mapAnswer(r));
  }

  listDocOutbox(docPath?: string): DecisionDocOutboxRecord[] {
    const rows = (
      docPath
        ? this.db
            .prepare('SELECT * FROM decision_doc_outbox_v1 WHERE doc_path=? ORDER BY rowid')
            .all(resolve(docPath))
        : this.db.prepare('SELECT * FROM decision_doc_outbox_v1 ORDER BY rowid').all()
    ) as unknown as OutboxRow[];
    return rows.map((r) => this.mapOutbox(r));
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
        return this.mapDecision(existing);
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
      const current = this.mapDecision(currentRow);

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
          answer: this.mapAnswer(priorAnswer),
        };
      }

      const currentRow = this.db
        .prepare('SELECT * FROM decisions_v1 WHERE decision_id=?')
        .get(input.decisionId) as DecisionRow | undefined;
      if (!currentRow) fail('invalid_request', `unknown decision: ${input.decisionId}`);
      const current = this.mapDecision(currentRow);

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
        answer: this.mapAnswer(savedAnswerRow),
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
    const decisions = this.listDecisions();
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
      const answers = this.getAnswers(d.decisionId);
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

  /**
   * Publishes only the anchored block inside `docPath`, preserving 100% of external human blocks.
   * Detects out-of-band file modifications via hash check before writing and refuses overwrite on conflict.
   * Never rolls back committed answers on conflict or I/O failure.
   */
  syncMarkdownDocument(docPath: string, options: SyncMarkdownDocumentOptions = {}): SyncMarkdownResult {
    if (!nonempty(docPath)) fail('invalid_request', 'docPath is required');
    const resolvedPath = resolve(docPath);
    if (this.protectedReadOnlyPaths.has(resolvedPath)) {
      fail('unauthorized', `target markdown document is protected read-only: ${resolvedPath}`);
    }

    const timestamp = new Date(this.now()).toISOString();
    const outboxRow = this.db
      .prepare('SELECT * FROM decision_doc_outbox_v1 WHERE doc_path=?')
      .get(resolvedPath) as OutboxRow | undefined;
    const lastSyncedFileHash = outboxRow?.last_synced_file_hash ?? null;
    const exists = this.fs.exists(resolvedPath);
    const decisions = this.listDecisions();
    const generatedBlock = this.renderGeneratedBlock();

    const recordConflict = (
      expectedFileHash: string | null,
      actualFileHash: string | null,
      reason: string,
    ): SyncMarkdownResult => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (outboxRow) {
          this.db
            .prepare(
              `UPDATE decision_doc_outbox_v1
               SET state='conflict_pending_manual_merge', expected_file_hash=?, last_error=?, updated_at=?
               WHERE outbox_id=?`,
            )
            .run(expectedFileHash, reason, timestamp, outboxRow.outbox_id);
        } else {
          this.db
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
        this.db
          .prepare(
            "UPDATE decisions_v1 SET sync_status='conflict_pending_manual_merge', updated_at=? WHERE sync_status IN ('not_synced', 'pending_sync')",
          )
          .run(timestamp);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
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
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (outboxRow) {
          this.db
            .prepare(
              `UPDATE decision_doc_outbox_v1
               SET state='pending_sync', attempts=attempts+1, last_error=?, updated_at=?
               WHERE outbox_id=?`,
            )
            .run(errorMessage, timestamp, outboxRow.outbox_id);
        } else {
          this.db
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
        this.db
          .prepare(
            "UPDATE decisions_v1 SET sync_status='pending_sync', updated_at=? WHERE sync_status IN ('not_synced', 'pending_sync', 'conflict_pending_manual_merge')",
          )
          .run(timestamp);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
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
        currentContent = this.fs.readFile(resolvedPath);
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
      this.fs.writeFileAtomic(resolvedPath, nextContent);
    } catch (error) {
      return recordWriteFailure(error instanceof Error ? error.message : String(error));
    }

    const fileHash = sha256Text(nextContent);
    const blockHash = sha256Text(generatedBlock);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (outboxRow) {
        this.db
          .prepare(
            `UPDATE decision_doc_outbox_v1
             SET state='synced', expected_file_hash=?, last_synced_block_hash=?,
                 last_synced_file_hash=?, last_error=NULL, updated_at=?
             WHERE outbox_id=?`,
          )
          .run(fileHash, blockHash, fileHash, timestamp, outboxRow.outbox_id);
      } else {
        this.db
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
      this.db
        .prepare(
          "UPDATE decisions_v1 SET sync_status='synced', updated_at=? WHERE sync_status IN ('not_synced', 'pending_sync', 'conflict_pending_manual_merge')",
        )
        .run(timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
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

  retryPendingSyncs(): SyncMarkdownResult[] {
    const pending = this.db
      .prepare("SELECT doc_path FROM decision_doc_outbox_v1 WHERE state='pending_sync' ORDER BY rowid")
      .all() as Array<{ doc_path: string }>;
    return pending.map((row) => this.syncMarkdownDocument(row.doc_path));
  }
}
