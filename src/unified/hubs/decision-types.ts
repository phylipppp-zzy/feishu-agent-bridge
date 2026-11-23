import { createHash } from 'node:crypto';
import { payloadDigest, type Identity } from '../contracts.js';
import { contractError } from '../errors.js';
import { StoreError } from '../store.js';

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

export interface DecisionRow {
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

export interface AnswerRow {
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

export interface OutboxRow {
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

export const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function fail(code: Parameters<typeof contractError>[0], message: string): never {
  throw new StoreError(contractError(code, message));
}

export function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function normalizeOptions(options: DecisionOption[]): DecisionOption[] {
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

export function normalizeSource(source: DecisionSource): DecisionSource {
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

export function normalizeBounds(bounds: DecisionBounds | undefined): DecisionBounds {
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

export function normalizeExecutionSpec(kind: DecisionKind, spec: ExecutionSpec | null | undefined): ExecutionSpec | null {
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

export function mapDecisionRow(row: DecisionRow): DecisionRecord {
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

export function mapAnswerRow(row: AnswerRow): DecisionAnswerRecord {
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

export function mapOutboxRow(row: OutboxRow): DecisionDocOutboxRecord {
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
