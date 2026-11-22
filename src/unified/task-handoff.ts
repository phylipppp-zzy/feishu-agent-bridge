import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { UnifiedService } from './adapter.js';
import {
  payloadDigest,
  type Artifact,
  type Identity,
  type Operation,
  type Provider,
  type Session,
  type WriteContext,
} from './contracts.js';
import { type ErrorCode } from './errors.js';
import { providerDisplayLabel, providerTitlePrefix, type ChannelCard } from './feishu-cards.js';
import type { TaskAccessMode, TaskAuthorize, TaskState, TaskTargetState } from './task-topic-channel.js';

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

interface BindingRow {
  task_id: string;
  destination: string;
  root_generation: number;
  owner_source: string;
  owner_subject: string;
  task_revision: number;
  active_target_id: string | null;
  active_revision: number;
  state: TaskState;
}

interface TargetRow {
  task_id: string;
  target_id: string;
  provider: Provider;
  host_id: string;
  service_id: string;
  native_session_id: string;
  session_id: string;
  target_generation: number;
  access_mode: TaskAccessMode;
  state: TaskTargetState;
}

interface HandoffRow {
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

const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const counter = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isSafeArtifactName(name: string): boolean {
  return (
    nonempty(name) &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\\0\r\n]/.test(name) &&
    !name.includes('..')
  );
}

function isContractCodeError(error: unknown): string | undefined {
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

function toDraft(row: HandoffRow): HandoffDraft {
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

function computePreviewDigest(input: {
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

function validateSummary(summary: string): string {
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

function validateConstraints(constraints: readonly string[] | undefined): string[] {
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

/**
 * Render an explicit, model-neutral preview card for Feishu.
 * Never claims tool authorization or implicit history carry-over.
 */
export function handoffPreviewCard(
  draft: HandoffDraft,
  sourceProvider: Provider,
  targetProvider: Provider,
): ChannelCard {
  const artifactsText = draft.artifactRefs.length
    ? draft.artifactRefs
        .map((a) => `- ${a.name} (id=${a.artifactId}, ver=${a.contentVersion.slice(0, 12)})`)
        .join('\n')
    : '（无引用文件）';
  const constraintsText = draft.constraints.length
    ? draft.constraints.map((c) => `- ${c}`).join('\n')
    : '（无额外约束）';
  const summaryPreview =
    [...draft.summary].length > 800 ? `${[...draft.summary].slice(0, 800).join('')}…` : draft.summary;
  const text = [
    `来源: ${providerDisplayLabel(sourceProvider)} (${draft.sourceTargetId})`,
    `目标: ${providerDisplayLabel(targetProvider)} (${draft.targetTargetId}) · gen=${draft.targetGeneration}`,
    `目标工作目录: ${draft.targetCwd}`,
    `摘要:\n${summaryPreview}`,
    `约束:\n${constraintsText}`,
    `引用文件:\n${artifactsText}`,
    `预览摘要哈希: ${draft.previewDigest.slice(0, 16)}`,
    '说明: 仅发送以上显式摘要、约束与受控文件引用；不复制全量历史，也不转移任何工具权限授权。',
  ].join('\n');

  const actions: ChannelCard['actions'] =
    draft.status === 'draft'
      ? [
          {
            label: `确认交接到 ${providerTitlePrefix(targetProvider)}`,
            value: {
              action: 'confirm_handoff',
              handoffId: draft.handoffId,
              taskId: draft.taskId,
              previewDigest: draft.previewDigest,
              targetGeneration: draft.targetGeneration,
              activeRevision: draft.activeRevision,
            },
          },
        ]
      : [];

  return {
    title: `跨后端交接预览 · ${providerTitlePrefix(sourceProvider)} → ${providerTitlePrefix(targetProvider)}`,
    text,
    actions,
  };
}

function formatHandoffSubmissionText(draft: HandoffDraft): string {
  const parts: string[] = [
    `[显式任务交接摘要 | handoffId=${draft.handoffId} | digest=${draft.previewDigest}]`,
    '注意: 本交接仅提供显式摘要、约束与受控文件引用，不包含源后端全量历史，亦不授予或继承任何工具审批权限。',
    `目标工作目录 (cwd): ${draft.targetCwd}`,
    `交接摘要:\n${draft.summary}`,
  ];
  if (draft.constraints.length) {
    parts.push(`约束条件:\n${draft.constraints.map((c, idx) => `${idx + 1}. ${c}`).join('\n')}`);
  }
  if (draft.artifactRefs.length) {
    parts.push(
      `受控文件引用:\n${draft.artifactRefs
        .map((a) => `- ${a.name} (artifactId=${a.artifactId}, contentVersion=${a.contentVersion})`)
        .join('\n')}`,
    );
  }
  return parts.join('\n\n');
}

/**
 * T2: Zero-LLM explicit structured summary handoff across any two mounted targets
 * (`codex` / `claude` / `agy`) in a task topic.
 */
export class TaskHandoffService {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly handoffLocks = new Map<string, Promise<void>>();
  private readonly submitTimeoutMs: number;
  private closed = false;

  constructor(
    private readonly service: UnifiedService,
    private readonly authorize: TaskAuthorize,
    dbOrPath: string | DatabaseSync,
    private readonly options: TaskHandoffOptions = {},
  ) {
    this.submitTimeoutMs = options.submitTimeoutMs ?? 10_000;
    if (typeof dbOrPath === 'string') {
      this.db = new DatabaseSync(dbOrPath);
      this.ownsDb = true;
      if (dbOrPath !== ':memory:') {
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      } else {
        this.db.exec('PRAGMA busy_timeout=5000;');
      }
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_bindings_v1 (
        task_id TEXT PRIMARY KEY,
        destination TEXT UNIQUE NOT NULL,
        root_generation INTEGER NOT NULL,
        owner_source TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        task_revision INTEGER NOT NULL,
        active_target_id TEXT,
        active_revision INTEGER NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_targets_v1 (
        task_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        host_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL,
        access_mode TEXT NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY(task_id, target_id),
        UNIQUE(task_id, provider, host_id, service_id, native_session_id)
      );
      CREATE TABLE IF NOT EXISTS task_handoffs_v1 (
        handoff_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        root_generation INTEGER NOT NULL,
        source_target_id TEXT NOT NULL,
        target_target_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        target_generation INTEGER NOT NULL,
        active_revision INTEGER NOT NULL,
        target_cwd TEXT NOT NULL,
        summary TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL,
        preview_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_source TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        idempotency_key TEXT,
        submit_operation_id TEXT,
        result_json TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDb) this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw error;
    }
  }

  private async withHandoffLock<T>(handoffId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.handoffLocks.get(handoffId) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const tail = previous.then(() => lock);
    this.handoffLocks.set(handoffId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.handoffLocks.get(handoffId) === tail) {
        this.handoffLocks.delete(handoffId);
      }
    }
  }

  private getBindingRow(taskId: string): BindingRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_bindings_v1 WHERE task_id = ?')
      .get(taskId) as BindingRow | undefined;
  }

  private getTargetRow(taskId: string, targetId: string): TargetRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_targets_v1 WHERE task_id = ? AND target_id = ?')
      .get(taskId, targetId) as TargetRow | undefined;
  }

  private getHandoffRow(handoffId: string): HandoffRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_handoffs_v1 WHERE handoff_id = ?')
      .get(handoffId) as HandoffRow | undefined;
  }

  getHandoff(handoffId: string): HandoffDraft | null {
    const row = this.getHandoffRow(handoffId);
    return row ? toDraft(row) : null;
  }

  private validateTargetCwd(cwd: string): string {
    if (!nonempty(cwd) || cwd.includes('\0') || /[\r\n]/.test(cwd)) {
      throw new TaskHandoffError('invalid_request', 'invalid target cwd');
    }
    const parts = cwd.split(/[\\/]/);
    if (parts.includes('..')) {
      throw new TaskHandoffError('invalid_request', 'target cwd cannot contain parent traversal');
    }
    const roots = this.options.allowedProjectRoots;
    if (roots && roots.length > 0) {
      if (!isAbsolute(cwd)) {
        throw new TaskHandoffError('cwd_mismatch', 'target cwd must be absolute within allowed project roots');
      }
      const canonicalCwd = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
      const allowed = roots.some((root) => {
        const canonicalRoot = existsSync(root) ? realpathSync(root) : resolve(root);
        const rel = relative(canonicalRoot, canonicalCwd);
        return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
      });
      if (!allowed) {
        throw new TaskHandoffError('cwd_mismatch', 'target cwd is outside allowed project roots');
      }
    }
    return cwd;
  }

  private async listControlledArtifacts(sessionId: string): Promise<Artifact[]> {
    const collected: Artifact[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      try {
        const page = await this.service.listArtifacts(sessionId, {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        collected.push(...page.items);
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor)) break;
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      } catch (error) {
        if (isContractCodeError(error) === 'unsupported') return [];
        throw error;
      }
    }
    return collected;
  }

  private async verifyArtifactRefs(
    taskId: string,
    sourceSessionId: string,
    targetSessionId: string,
    targetCwd: string,
    refs: readonly HandoffArtifactInput[] | undefined,
  ): Promise<HandoffArtifactRef[]> {
    if (!refs || refs.length === 0) return [];
    if (!Array.isArray(refs) || refs.length > MAX_HANDOFF_ARTIFACTS) {
      throw new TaskHandoffError('invalid_request', 'invalid artifactRefs count');
    }
    const seenIds = new Set<string>();
    for (const ref of refs) {
      if (!ref || !nonempty(ref.artifactId) || !nonempty(ref.contentVersion)) {
        throw new TaskHandoffError('invalid_request', 'invalid artifact reference');
      }
      if (ref.name !== undefined && !isSafeArtifactName(ref.name)) {
        throw new TaskHandoffError('artifact_out_of_scope', 'unsafe artifact file name');
      }
      if (seenIds.has(ref.artifactId)) {
        throw new TaskHandoffError('invalid_request', 'duplicate artifact reference');
      }
      seenIds.add(ref.artifactId);
    }

    const [sourceArtifacts, targetArtifacts] = await Promise.all([
      this.listControlledArtifacts(sourceSessionId),
      this.listControlledArtifacts(targetSessionId),
    ]);
    const available = [...sourceArtifacts, ...targetArtifacts];

    const verified: HandoffArtifactRef[] = [];
    for (const ref of refs) {
      const matches = available.filter((a) => a.artifactId === ref.artifactId);
      if (matches.length === 0) {
        throw new TaskHandoffError(
          'artifact_out_of_scope',
          `artifact ${ref.artifactId} is outside controlled task scope`,
        );
      }
      const artifact = matches.find((a) => a.contentVersion === ref.contentVersion) ?? matches[0]!;
      if (artifact.contentVersion !== ref.contentVersion) {
        throw new TaskHandoffError(
          'stale_revision',
          `artifact ${ref.artifactId} contentVersion mismatch`,
        );
      }
      if (!isSafeArtifactName(artifact.name)) {
        throw new TaskHandoffError('artifact_out_of_scope', 'controlled artifact has unsafe name');
      }
      if (ref.name !== undefined && ref.name !== artifact.name) {
        throw new TaskHandoffError('invalid_request', 'artifact name mismatch');
      }
      if (artifact.sessionId !== sourceSessionId && artifact.sessionId !== targetSessionId) {
        throw new TaskHandoffError('artifact_out_of_scope', 'artifact belongs to unrelated session');
      }

      const bytes = await this.service.readArtifact(
        artifact.sessionId,
        artifact.artifactId,
        artifact.contentVersion,
      );
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== artifact.size) {
        throw new TaskHandoffError('stale_revision', 'artifact size changed or unreadable');
      }
      if (/^[a-f0-9]{64}$/.test(artifact.contentVersion) && sha256Hex(bytes) !== artifact.contentVersion) {
        throw new TaskHandoffError('stale_revision', 'artifact content digest changed');
      }

      const verifiedRef: HandoffArtifactRef = {
        artifactId: artifact.artifactId,
        name: artifact.name,
        contentVersion: artifact.contentVersion,
      };
      await this.options.verifyArtifact?.({
        taskId,
        sourceSessionId,
        targetSessionId,
        targetCwd,
        ref: verifiedRef,
        bytes,
      });
      verified.push(verifiedRef);
    }
    return verified;
  }

  private buildDeterministicSummary(sourceSession: Session, targetSession: Session): string {
    const raw = [
      `从 ${providerDisplayLabel(sourceSession.native.provider)} (${sourceSession.title || sourceSession.native.nativeSessionId}) 交接到 ${providerDisplayLabel(targetSession.native.provider)}`,
      `原工作目录: ${sourceSession.project}；目标工作目录: ${targetSession.project}`,
      `原会话状态: ${sourceSession.status}`,
    ].join('\n');
    return validateSummary([...raw].slice(0, MAX_HANDOFF_SUMMARY_CHARS).join(''));
  }

  /**
   * Zero-LLM preview: builds and persists a structured `HandoffDraft` and card view
   * with 0 native inputs and without copying full history or tool permissions.
   */
  async previewHandoff(req: PreviewHandoffRequest): Promise<{ draft: HandoffDraft; card: ChannelCard }> {
    if (
      !nonempty(req.taskId) ||
      !nonempty(req.sourceTargetId) ||
      !nonempty(req.targetTargetId) ||
      req.sourceTargetId === req.targetTargetId ||
      !nonempty(req.owner?.source) ||
      !nonempty(req.owner?.subject)
    ) {
      throw new TaskHandoffError('invalid_request', 'invalid previewHandoff parameters');
    }
    const handoffId = req.handoffId ?? `handoff-${randomUUID()}`;
    if (!nonempty(handoffId)) {
      throw new TaskHandoffError('invalid_request', 'invalid handoffId');
    }

    const preBinding = this.getBindingRow(req.taskId);
    if (!preBinding) throw new TaskHandoffError('task_not_found', 'task not found');
    if (preBinding.state !== 'active') throw new TaskHandoffError('task_closed', 'task is closed');
    if (
      preBinding.owner_source !== req.owner.source ||
      preBinding.owner_subject !== req.owner.subject
    ) {
      throw new TaskHandoffError('unauthorized', 'task owner mismatch');
    }

    const preSource = this.getTargetRow(req.taskId, req.sourceTargetId);
    const preTarget = this.getTargetRow(req.taskId, req.targetTargetId);
    if (!preSource || !preTarget) {
      throw new TaskHandoffError('target_not_found', 'source or target not mounted on task');
    }
    if (preSource.state !== 'active' || preTarget.state !== 'active') {
      throw new TaskHandoffError('target_revoked', 'source or target is not active');
    }
    if (preTarget.access_mode !== 'interactive') {
      throw new TaskHandoffError('read_only_target', 'target is read-only and cannot accept handoff');
    }

    const [sourceAllowed, targetAllowed] = await Promise.all([
      this.authorize(req.owner, preBinding.destination, preSource.session_id),
      this.authorize(req.owner, preBinding.destination, preTarget.session_id),
    ]);
    if (!sourceAllowed || !targetAllowed) {
      throw new TaskHandoffError('unauthorized', 'handoff authorization denied');
    }

    const [sourceSession, targetSession] = await Promise.all([
      this.service.getSession(preSource.session_id),
      this.service.getSession(preTarget.session_id),
    ]);
    if (targetSession.status === 'unreachable') {
      throw new TaskHandoffError('temporarily_unavailable', 'target session is unreachable');
    }
    if (targetSession.status === 'read_only' || targetSession.control.input !== 'available') {
      throw new TaskHandoffError('control_conflict', 'target session input control unavailable');
    }

    const targetCwd = this.validateTargetCwd(targetSession.project);
    if (req.expectedTargetCwd !== undefined && req.expectedTargetCwd !== targetCwd) {
      throw new TaskHandoffError('cwd_mismatch', 'expectedTargetCwd does not match trusted target session project');
    }

    const summary =
      req.summary !== undefined
        ? validateSummary(req.summary)
        : this.buildDeterministicSummary(sourceSession, targetSession);
    const constraints = validateConstraints(req.constraints);
    const artifactRefs = await this.verifyArtifactRefs(
      req.taskId,
      preSource.session_id,
      preTarget.session_id,
      targetCwd,
      req.artifactRefs,
    );

    const now = new Date().toISOString();
    const draft = this.tx(() => {
      if (this.getHandoffRow(handoffId)) {
        throw new TaskHandoffError('idempotency_conflict', 'handoffId already exists');
      }
      const binding = this.getBindingRow(req.taskId);
      const source = this.getTargetRow(req.taskId, req.sourceTargetId);
      const target = this.getTargetRow(req.taskId, req.targetTargetId);
      if (
        !binding ||
        binding.state !== 'active' ||
        binding.root_generation !== preBinding.root_generation ||
        binding.active_revision !== preBinding.active_revision ||
        !source ||
        source.state !== 'active' ||
        source.target_generation !== preSource.target_generation ||
        !target ||
        target.state !== 'active' ||
        target.target_generation !== preTarget.target_generation ||
        target.access_mode !== 'interactive'
      ) {
        throw new TaskHandoffError('stale_revision', 'task or targets changed during handoff preview');
      }

      const previewDigest = computePreviewDigest({
        taskId: binding.task_id,
        rootGeneration: binding.root_generation,
        sourceTargetId: source.target_id,
        targetTargetId: target.target_id,
        targetSessionId: target.session_id,
        targetGeneration: target.target_generation,
        activeRevision: binding.active_revision,
        targetCwd,
        summary,
        constraints,
        artifactRefs,
      });

      this.db
        .prepare(
          "INSERT INTO task_handoffs_v1(handoff_id, task_id, root_generation, source_target_id, target_target_id, target_session_id, target_generation, active_revision, target_cwd, summary, constraints_json, artifact_refs_json, preview_digest, status, owner_source, owner_subject, idempotency_key, submit_operation_id, result_json, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, NULL, ?, ?)",
        )
        .run(
          handoffId,
          binding.task_id,
          binding.root_generation,
          source.target_id,
          target.target_id,
          target.session_id,
          target.target_generation,
          binding.active_revision,
          targetCwd,
          summary,
          JSON.stringify(constraints),
          JSON.stringify(artifactRefs),
          previewDigest,
          req.owner.source,
          req.owner.subject,
          now,
          now,
        );

      return toDraft(this.getHandoffRow(handoffId)!);
    });

    return {
      draft,
      card: handoffPreviewCard(draft, preSource.provider, preTarget.provider),
    };
  }

  /**
   * Edit an existing draft summary / constraints / artifactRefs before confirmation
   * with CAS on `expectedPreviewDigest`. Performs 0 native inputs.
   */
  async updateHandoffDraft(
    req: UpdateHandoffDraftRequest,
  ): Promise<{ draft: HandoffDraft; card: ChannelCard }> {
    return this.withHandoffLock(req.handoffId, async () => {
      const existing = this.getHandoffRow(req.handoffId);
      if (!existing) throw new TaskHandoffError('invalid_request', 'handoff draft not found');
      if (existing.owner_source !== req.owner.source || existing.owner_subject !== req.owner.subject) {
        throw new TaskHandoffError('unauthorized', 'handoff owner mismatch');
      }
      if (existing.status !== 'draft') {
        throw new TaskHandoffError('stale_revision', `handoff is in state ${existing.status}`);
      }
      if (existing.preview_digest !== req.expectedPreviewDigest) {
        throw new TaskHandoffError('stale_revision', 'previewDigest mismatch');
      }

      const binding = this.getBindingRow(existing.task_id);
      const source = this.getTargetRow(existing.task_id, existing.source_target_id);
      const target = this.getTargetRow(existing.task_id, existing.target_target_id);
      if (
        !binding ||
        binding.state !== 'active' ||
        binding.root_generation !== existing.root_generation ||
        binding.active_revision !== existing.active_revision ||
        !source ||
        source.state !== 'active' ||
        !target ||
        target.state !== 'active' ||
        target.target_generation !== existing.target_generation ||
        target.access_mode !== 'interactive'
      ) {
        throw new TaskHandoffError('stale_revision', 'task or target changed');
      }

      if (!await this.authorize(req.owner, binding.destination, target.session_id)) {
        throw new TaskHandoffError('unauthorized', 'handoff authorization denied');
      }
      const targetSession = await this.service.getSession(target.session_id);
      const targetCwd = this.validateTargetCwd(targetSession.project);
      if (targetCwd !== existing.target_cwd) {
        throw new TaskHandoffError('cwd_mismatch', 'target cwd changed since initial preview');
      }

      const summary =
        req.summary !== undefined ? validateSummary(req.summary) : existing.summary;
      const constraints =
        req.constraints !== undefined
          ? validateConstraints(req.constraints)
          : (JSON.parse(existing.constraints_json) as string[]);
      const artifactRefs =
        req.artifactRefs !== undefined
          ? await this.verifyArtifactRefs(
              existing.task_id,
              source.session_id,
              target.session_id,
              targetCwd,
              req.artifactRefs,
            )
          : await this.verifyArtifactRefs(
              existing.task_id,
              source.session_id,
              target.session_id,
              targetCwd,
              JSON.parse(existing.artifact_refs_json) as HandoffArtifactRef[],
            );

      const nextDigest = computePreviewDigest({
        taskId: existing.task_id,
        rootGeneration: existing.root_generation,
        sourceTargetId: existing.source_target_id,
        targetTargetId: existing.target_target_id,
        targetSessionId: existing.target_session_id,
        targetGeneration: existing.target_generation,
        activeRevision: existing.active_revision,
        targetCwd,
        summary,
        constraints,
        artifactRefs,
      });

      const updated = this.tx(() => {
        const res = this.db
          .prepare(
            "UPDATE task_handoffs_v1 SET summary = ?, constraints_json = ?, artifact_refs_json = ?, preview_digest = ?, updated_at = ? WHERE handoff_id = ? AND status = 'draft' AND preview_digest = ?",
          )
          .run(
            summary,
            JSON.stringify(constraints),
            JSON.stringify(artifactRefs),
            nextDigest,
            new Date().toISOString(),
            req.handoffId,
            req.expectedPreviewDigest,
          );
        if (res.changes !== 1) {
          throw new TaskHandoffError('stale_revision', 'concurrent modification on handoff draft');
        }
        return toDraft(this.getHandoffRow(req.handoffId)!);
      });

      return {
        draft: updated,
        card: handoffPreviewCard(updated, source.provider, target.provider),
      };
    });
  }

  private expireDraftIfStillDraft(handoffId: string, reason: string): void {
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE task_handoffs_v1 SET status = 'expired', error_message = ?, updated_at = ? WHERE handoff_id = ? AND status = 'draft'",
        )
        .run(reason, new Date().toISOString(), handoffId);
    });
  }

  /**
   * Single-transaction CAS confirmation and exactly-once `UnifiedCore.submitInput` to target.
   * Source backend receives 0 inputs. Duplicate confirmation is idempotent.
   * Submission timeout or ambiguous error marks `unknown` and NEVER resends.
   */
  async confirmHandoff(
    handoffId: string,
    expectedPreviewDigest: string,
    expectedTargetGeneration: number,
    owner: Identity,
    idempotencyKey: string,
  ): Promise<HandoffConfirmResult> {
    if (
      !nonempty(handoffId) ||
      !nonempty(expectedPreviewDigest) ||
      !counter(expectedTargetGeneration) ||
      !nonempty(owner?.source) ||
      !nonempty(owner?.subject) ||
      !nonempty(idempotencyKey)
    ) {
      throw new TaskHandoffError('invalid_request', 'invalid confirmHandoff arguments');
    }

    return this.withHandoffLock(handoffId, async () => {
      const initial = this.getHandoffRow(handoffId);
      if (!initial) {
        throw new TaskHandoffError('invalid_request', 'handoff draft not found');
      }
      if (initial.owner_source !== owner.source || initial.owner_subject !== owner.subject) {
        throw new TaskHandoffError('unauthorized', 'handoff owner mismatch');
      }

      if (initial.status === 'submitted') {
        if (
          initial.idempotency_key === idempotencyKey &&
          initial.preview_digest === expectedPreviewDigest &&
          initial.target_generation === expectedTargetGeneration
        ) {
          return {
            status: 'submitted',
            handoff: toDraft(initial),
            operation: initial.result_json ? (JSON.parse(initial.result_json) as Operation) : null,
          };
        }
        throw new TaskHandoffError('idempotency_conflict', 'handoff already submitted with different key or parameters');
      }

      if (initial.status === 'unknown' || initial.status === 'confirmed') {
        if (initial.status === 'confirmed') {
          // A prior confirmation crashed in flight: treat as unknown and NEVER resend.
          this.tx(() => {
            this.db
              .prepare(
                "UPDATE task_handoffs_v1 SET status = 'unknown', error_message = COALESCE(error_message, 'handoff submission outcome unknown'), updated_at = ? WHERE handoff_id = ? AND status = 'confirmed'",
              )
              .run(new Date().toISOString(), handoffId);
          });
        }
        const latest = this.getHandoffRow(handoffId)!;
        if (
          latest.idempotency_key === idempotencyKey &&
          latest.preview_digest === expectedPreviewDigest &&
          latest.target_generation === expectedTargetGeneration
        ) {
          return {
            status: 'unknown',
            handoff: toDraft(latest),
            operation: latest.result_json ? (JSON.parse(latest.result_json) as Operation) : null,
            error: latest.error_message ?? 'handoff submission outcome unknown',
          };
        }
        throw new TaskHandoffError('outcome_unknown', 'handoff outcome unknown; do not resend');
      }

      if (initial.status === 'expired' || initial.status === 'rejected') {
        throw new TaskHandoffError('stale_revision', `handoff is ${initial.status}`);
      }

      if (initial.preview_digest !== expectedPreviewDigest) {
        throw new TaskHandoffError('stale_revision', 'previewDigest mismatch');
      }
      if (initial.target_generation !== expectedTargetGeneration) {
        const currentTarget = this.getTargetRow(initial.task_id, initial.target_target_id);
        if (!currentTarget || currentTarget.state !== 'active' || currentTarget.target_generation !== initial.target_generation) {
          this.expireDraftIfStillDraft(handoffId, 'target generation changed after preview');
        }
        throw new TaskHandoffError('stale_revision', 'target generation mismatch');
      }

      const preBinding = this.getBindingRow(initial.task_id);
      const preSource = this.getTargetRow(initial.task_id, initial.source_target_id);
      const preTarget = this.getTargetRow(initial.task_id, initial.target_target_id);

      if (
        !preBinding ||
        preBinding.state !== 'active' ||
        preBinding.root_generation !== initial.root_generation ||
        preBinding.owner_source !== owner.source ||
        preBinding.owner_subject !== owner.subject
      ) {
        this.expireDraftIfStillDraft(handoffId, 'task binding changed or closed');
        throw new TaskHandoffError('stale_revision', 'task binding changed or closed');
      }
      if (preBinding.active_revision !== initial.active_revision) {
        this.expireDraftIfStillDraft(handoffId, 'active target switched after preview');
        throw new TaskHandoffError('stale_revision', 'active target switched after preview');
      }
      if (
        !preSource ||
        preSource.state !== 'active' ||
        !preTarget ||
        preTarget.state !== 'active' ||
        preTarget.target_generation !== expectedTargetGeneration ||
        preTarget.session_id !== initial.target_session_id
      ) {
        this.expireDraftIfStillDraft(handoffId, 'source or target changed after preview');
        throw new TaskHandoffError('stale_revision', 'source or target changed or revoked after preview');
      }
      if (preTarget.access_mode !== 'interactive') {
        this.expireDraftIfStillDraft(handoffId, 'target downgraded to read-only');
        throw new TaskHandoffError('read_only_target', 'target is read-only');
      }

      if (!await this.authorize(owner, preBinding.destination, preTarget.session_id)) {
        throw new TaskHandoffError('unauthorized', 'handoff target authorization denied');
      }

      const targetSession = await this.service.getSession(preTarget.session_id);
      const currentCwd = this.validateTargetCwd(targetSession.project);
      if (currentCwd !== initial.target_cwd) {
        this.expireDraftIfStillDraft(handoffId, 'target cwd changed after preview');
        throw new TaskHandoffError('cwd_mismatch', 'target cwd changed after preview');
      }
      if (targetSession.status === 'unreachable') {
        throw new TaskHandoffError('temporarily_unavailable', 'target session unreachable');
      }
      if (targetSession.status === 'read_only' || targetSession.control.input !== 'available') {
        throw new TaskHandoffError('control_conflict', 'target session control unavailable');
      }

      const savedArtifacts = JSON.parse(initial.artifact_refs_json) as HandoffArtifactRef[];
      try {
        await this.verifyArtifactRefs(
          initial.task_id,
          preSource.session_id,
          preTarget.session_id,
          currentCwd,
          savedArtifacts,
        );
      } catch (error) {
        this.expireDraftIfStillDraft(
          handoffId,
          error instanceof Error ? error.message : 'artifact verification failed',
        );
        throw error;
      }

      const submitOpId = `handoff:${handoffId}:${expectedPreviewDigest.slice(0, 16)}`;

      const claimed = this.tx(() => {
        const row = this.getHandoffRow(handoffId);
        const binding = this.getBindingRow(initial.task_id);
        const source = this.getTargetRow(initial.task_id, initial.source_target_id);
        const target = this.getTargetRow(initial.task_id, initial.target_target_id);

        if (
          !row ||
          row.status !== 'draft' ||
          row.preview_digest !== expectedPreviewDigest ||
          row.target_generation !== expectedTargetGeneration ||
          row.owner_source !== owner.source ||
          row.owner_subject !== owner.subject
        ) {
          throw new TaskHandoffError('stale_revision', 'handoff draft changed before confirmation');
        }
        if (
          !binding ||
          binding.state !== 'active' ||
          binding.root_generation !== row.root_generation ||
          binding.active_revision !== row.active_revision ||
          binding.owner_source !== owner.source ||
          binding.owner_subject !== owner.subject ||
          !source ||
          source.state !== 'active' ||
          !target ||
          target.state !== 'active' ||
          target.target_generation !== expectedTargetGeneration ||
          target.session_id !== row.target_session_id ||
          target.access_mode !== 'interactive'
        ) {
          this.db
            .prepare(
              "UPDATE task_handoffs_v1 SET status = 'expired', error_message = 'target or binding changed before CAS claim', updated_at = ? WHERE handoff_id = ? AND status = 'draft'",
            )
            .run(new Date().toISOString(), handoffId);
          throw new TaskHandoffError('stale_revision', 'target or binding changed before confirmation');
        }

        const constraints = JSON.parse(row.constraints_json) as string[];
        const artifacts = JSON.parse(row.artifact_refs_json) as HandoffArtifactRef[];
        const recomputed = computePreviewDigest({
          taskId: row.task_id,
          rootGeneration: row.root_generation,
          sourceTargetId: row.source_target_id,
          targetTargetId: row.target_target_id,
          targetSessionId: row.target_session_id,
          targetGeneration: row.target_generation,
          activeRevision: row.active_revision,
          targetCwd: currentCwd,
          summary: row.summary,
          constraints,
          artifactRefs: artifacts,
        });
        if (recomputed !== expectedPreviewDigest) {
          this.db
            .prepare(
              "UPDATE task_handoffs_v1 SET status = 'expired', error_message = 'previewDigest verification failed', updated_at = ? WHERE handoff_id = ? AND status = 'draft'",
            )
            .run(new Date().toISOString(), handoffId);
          throw new TaskHandoffError('stale_revision', 'previewDigest verification failed');
        }

        const updated = this.db
          .prepare(
            "UPDATE task_handoffs_v1 SET status = 'confirmed', idempotency_key = ?, submit_operation_id = ?, updated_at = ? WHERE handoff_id = ? AND status = 'draft' AND preview_digest = ? AND target_generation = ?",
          )
          .run(
            idempotencyKey,
            submitOpId,
            new Date().toISOString(),
            handoffId,
            expectedPreviewDigest,
            expectedTargetGeneration,
          );
        if (updated.changes !== 1) {
          throw new TaskHandoffError('stale_revision', 'handoff CAS claim conflict');
        }
        return toDraft(this.getHandoffRow(handoffId)!);
      });

      const writeContext: WriteContext = {
        operationId: submitOpId,
        idempotencyKey: submitOpId,
        targetId: claimed.targetSessionId,
        expectedRevision: targetSession.revision,
        controlGeneration: targetSession.control.generation,
        identity: owner,
      };

      const submitPromise = this.service.submitInput({
        context: writeContext,
        mode: 'new',
        blocks: [{ type: 'text', text: formatHandoffSubmissionText(claimed) }],
      });
      void submitPromise.catch(() => undefined);

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const op = await Promise.race([
          submitPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new TaskHandoffError('outcome_unknown', 'handoff submitInput timed out')),
              this.submitTimeoutMs,
            );
          }),
        ]);
        if (op.status === 'unknown') {
          const msg = op.error?.message ?? 'submitInput returned unknown';
          this.tx(() => {
            this.db
              .prepare(
                "UPDATE task_handoffs_v1 SET status = 'unknown', result_json = ?, error_message = ?, updated_at = ? WHERE handoff_id = ? AND status = 'confirmed'",
              )
              .run(JSON.stringify(op), msg, new Date().toISOString(), handoffId);
          });
          return {
            status: 'unknown',
            handoff: toDraft(this.getHandoffRow(handoffId)!),
            operation: op,
            error: msg,
          };
        }
        if (op.status === 'failed') {
          const msg = op.error?.message ?? 'submitInput failed';
          this.tx(() => {
            this.db
              .prepare(
                "UPDATE task_handoffs_v1 SET status = 'rejected', result_json = ?, error_message = ?, updated_at = ? WHERE handoff_id = ? AND status = 'confirmed'",
              )
              .run(JSON.stringify(op), msg, new Date().toISOString(), handoffId);
          });
          return {
            status: 'rejected',
            handoff: toDraft(this.getHandoffRow(handoffId)!),
            operation: op,
            error: msg,
          };
        }
        this.tx(() => {
          this.db
            .prepare(
              "UPDATE task_handoffs_v1 SET status = 'submitted', result_json = ?, updated_at = ? WHERE handoff_id = ? AND status = 'confirmed'",
            )
            .run(JSON.stringify(op), new Date().toISOString(), handoffId);
        });
        return {
          status: 'submitted',
          handoff: toDraft(this.getHandoffRow(handoffId)!),
          operation: op,
        };
      } catch (error) {
        const code = isContractCodeError(error);
        const msg = error instanceof Error ? error.message : String(error);
        const definitePreSubmitRejection =
          code !== undefined &&
          ['invalid_request', 'unsupported', 'unauthorized', 'control_conflict', 'stale_revision'].includes(code);
        const nextStatus: HandoffStatus = definitePreSubmitRejection ? 'rejected' : 'unknown';
        this.tx(() => {
          this.db
            .prepare(
              "UPDATE task_handoffs_v1 SET status = ?, error_message = ?, updated_at = ? WHERE handoff_id = ? AND status = 'confirmed'",
            )
            .run(nextStatus, msg, new Date().toISOString(), handoffId);
        });
        return {
          status: nextStatus === 'rejected' ? 'rejected' : 'unknown',
          handoff: toDraft(this.getHandoffRow(handoffId)!),
          operation: null,
          error: msg,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  }
}
