import { createHash } from 'node:crypto';
import { payloadDigest, type Identity, type Operation } from '../contracts.js';
import type { ErrorCode } from '../errors.js';
import { nonempty } from './types.js';

export const MAX_HANDOFF_SUMMARY_CHARS = 8000;
export const MAX_HANDOFF_CONSTRAINTS = 50;
export const MAX_HANDOFF_CONSTRAINT_CHARS = 500;
export const MAX_HANDOFF_ARTIFACTS = 20;

export type HandoffStatus =
  | 'draft'
  | 'confirmed'
  | 'submitted'
  | 'unknown'
  | 'rejected'
  | 'expired';

export interface HandoffArtifactRef {
  artifactId: string;
  name: string;
  contentVersion: string;
}

export interface HandoffArtifactInput {
  artifactId: string;
  name?: string;
  contentVersion: string;
}

export interface HandoffDraft {
  handoffId: string;
  taskId: string;
  sourceTargetId: string;
  targetTargetId: string;
  targetSessionId: string;
  targetGeneration: number;
  activeRevision: number;
  targetCwd: string;
  summary: string;
  constraints: string[];
  artifactRefs: HandoffArtifactRef[];
  previewDigest: string;
  status: HandoffStatus;
}

export interface PreviewHandoffRequest {
  handoffId?: string;
  taskId: string;
  sourceTargetId: string;
  targetTargetId: string;
  owner: Identity;
  summary?: string;
  constraints?: string[];
  artifactRefs?: HandoffArtifactInput[];
  expectedTargetCwd?: string;
}

export interface UpdateHandoffDraftRequest {
  handoffId: string;
  expectedPreviewDigest: string;
  owner: Identity;
  summary?: string;
  constraints?: string[];
  artifactRefs?: HandoffArtifactInput[];
}

export interface HandoffConfirmResult {
  status: 'submitted' | 'unknown' | 'rejected';
  handoff: HandoffDraft;
  operation: Operation | null;
  error?: string;
}

export interface TaskHandoffOptions {
  allowedProjectRoots?: readonly string[];
  submitTimeoutMs?: number;
  verifyArtifact?: (ctx: {
    taskId: string;
    sourceSessionId: string;
    targetSessionId: string;
    targetCwd: string;
    ref: HandoffArtifactRef;
    bytes: Uint8Array;
  }) => Promise<void> | void;
}

export class TaskHandoffError extends Error {
  constructor(
    readonly code:
      | ErrorCode
      | 'task_not_found'
      | 'task_closed'
      | 'target_not_found'
      | 'target_revoked'
      | 'read_only_target'
      | 'artifact_out_of_scope'
      | 'cwd_mismatch',
    message: string,
  ) {
    super(message);
  }
}

export interface HandoffRow {
  handoff_id: string;
  task_id: string;
  root_generation: number;
  source_target_id: string;
  target_target_id: string;
  target_session_id: string;
  target_generation: number;
  active_revision: number;
  target_cwd: string;
  summary: string;
  constraints_json: string;
  artifact_refs_json: string;
  preview_digest: string;
  status: HandoffStatus;
  owner_source: string;
  owner_subject: string;
  idempotency_key: string | null;
  submit_operation_id: string | null;
  result_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isSafeArtifactName(name: string): boolean {
  return (
    nonempty(name) &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\\0\r\n]/.test(name) &&
    !name.includes('..')
  );
}

export function isContractCodeError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('detail' in error && (error as { detail?: { code?: unknown } }).detail?.code) {
    const code = (error as { detail: { code: unknown } }).detail.code;
    return typeof code === 'string' ? code : undefined;
  }
  if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return undefined;
}

export function toDraft(row: HandoffRow): HandoffDraft {
  return {
    handoffId: row.handoff_id,
    taskId: row.task_id,
    sourceTargetId: row.source_target_id,
    targetTargetId: row.target_target_id,
    targetSessionId: row.target_session_id,
    targetGeneration: row.target_generation,
    activeRevision: row.active_revision,
    targetCwd: row.target_cwd,
    summary: row.summary,
    constraints: JSON.parse(row.constraints_json) as string[],
    artifactRefs: JSON.parse(row.artifact_refs_json) as HandoffArtifactRef[],
    previewDigest: row.preview_digest,
    status: row.status,
  };
}

export function computePreviewDigest(input: {
  taskId: string;
  rootGeneration: number;
  sourceTargetId: string;
  targetTargetId: string;
  targetSessionId: string;
  targetGeneration: number;
  activeRevision: number;
  targetCwd: string;
  summary: string;
  constraints: string[];
  artifactRefs: HandoffArtifactRef[];
}): string {
  return payloadDigest({
    taskId: input.taskId,
    rootGeneration: input.rootGeneration,
    sourceTargetId: input.sourceTargetId,
    targetTargetId: input.targetTargetId,
    targetSessionId: input.targetSessionId,
    targetGeneration: input.targetGeneration,
    activeRevision: input.activeRevision,
    targetCwd: input.targetCwd,
    summary: input.summary,
    constraints: input.constraints,
    artifactRefs: input.artifactRefs,
  });
}

export function validateSummary(summary: string): string {
  if (typeof summary !== 'string') {
    throw new TaskHandoffError('invalid_request', 'summary must be a string');
  }
  if (summary.includes('\0')) {
    throw new TaskHandoffError('invalid_request', 'summary contains invalid NUL byte');
  }
  const trimmed = summary.trim();
  if (!trimmed) {
    throw new TaskHandoffError('invalid_request', 'handoff summary must not be empty');
  }
  if ([...trimmed].length > MAX_HANDOFF_SUMMARY_CHARS) {
    throw new TaskHandoffError(
      'invalid_request',
      `handoff summary exceeds limit of ${MAX_HANDOFF_SUMMARY_CHARS} characters`,
    );
  }
  return trimmed;
}

export function validateConstraints(constraints: readonly string[] | undefined): string[] {
  if (constraints === undefined) return [];
  if (!Array.isArray(constraints) || constraints.length > MAX_HANDOFF_CONSTRAINTS) {
    throw new TaskHandoffError('invalid_request', 'invalid constraints list');
  }
  return constraints.map((item) => {
    if (!nonempty(item) || item.includes('\0')) {
      throw new TaskHandoffError('invalid_request', 'invalid constraint item');
    }
    const trimmed = item.trim();
    if ([...trimmed].length > MAX_HANDOFF_CONSTRAINT_CHARS) {
      throw new TaskHandoffError('invalid_request', 'constraint item exceeds max length');
    }
    return trimmed;
  });
}
