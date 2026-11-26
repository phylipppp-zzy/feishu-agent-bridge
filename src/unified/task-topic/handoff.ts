import { shouldAutoQueueInput } from '../contracts.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { UnifiedService } from '../adapter.js';
import type { Identity, Operation, WriteContext } from '../contracts.js';
import type { ChannelCard } from '../feishu-cards.js';
import {
  buildDeterministicSummary,
  formatHandoffSubmissionText,
  handoffPreviewCard,
} from './handoff-cards.js';
import {
  computePreviewDigest,
  isContractCodeError,
  TaskHandoffError,
  toDraft,
  validateConstraints,
  validateSummary,
  type HandoffArtifactRef,
  type HandoffConfirmResult,
  type HandoffDraft,
  type HandoffRow,
  type HandoffStatus,
  type PreviewHandoffRequest,
  type TaskHandoffOptions,
  type UpdateHandoffDraftRequest,
} from './handoff-types.js';
import {
  ensureHandoffSchema,
  validateHandoffTargetCwd,
  verifyHandoffArtifactRefs,
} from './handoff-validation.js';
import { getBindingRow, getTargetRow, runTransaction, taskInputScope } from './schema.js';
import { counter, nonempty, type TaskAuthorize } from './types.js';

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
    ensureHandoffSchema(this.db);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDb) this.db.close();
  }

  private tx<T>(fn: () => T): T {
    return runTransaction(this.db, fn);
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

  private getHandoffRow(handoffId: string): HandoffRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_handoffs_v1 WHERE handoff_id = ?')
      .get(handoffId) as HandoffRow | undefined;
  }

  getHandoff(handoffId: string): HandoffDraft | null {
    const row = this.getHandoffRow(handoffId);
    return row ? toDraft(row) : null;
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

    const preBinding = getBindingRow(this.db, req.taskId);
    if (!preBinding) throw new TaskHandoffError('task_not_found', 'task not found');
    if (preBinding.state !== 'active') throw new TaskHandoffError('task_closed', 'task is closed');
    if (
      preBinding.owner_source !== req.owner.source ||
      preBinding.owner_subject !== req.owner.subject
    ) {
      throw new TaskHandoffError('unauthorized', 'task owner mismatch');
    }

    const preSource = getTargetRow(this.db, req.taskId, req.sourceTargetId);
    const preTarget = getTargetRow(this.db, req.taskId, req.targetTargetId);
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

    const targetCwd = validateHandoffTargetCwd(targetSession.project, this.options.allowedProjectRoots);
    if (req.expectedTargetCwd !== undefined && req.expectedTargetCwd !== targetCwd) {
      throw new TaskHandoffError('cwd_mismatch', 'expectedTargetCwd does not match trusted target session project');
    }

    const summary =
      req.summary !== undefined
        ? validateSummary(req.summary)
        : buildDeterministicSummary(sourceSession, targetSession);
    const constraints = validateConstraints(req.constraints);
    const artifactRefs = await verifyHandoffArtifactRefs(
      this.service,
      this.options,
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
      const binding = getBindingRow(this.db, req.taskId);
      const source = getTargetRow(this.db, req.taskId, req.sourceTargetId);
      const target = getTargetRow(this.db, req.taskId, req.targetTargetId);
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

      const binding = getBindingRow(this.db, existing.task_id);
      const source = getTargetRow(this.db, existing.task_id, existing.source_target_id);
      const target = getTargetRow(this.db, existing.task_id, existing.target_target_id);
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
      const targetCwd = validateHandoffTargetCwd(targetSession.project, this.options.allowedProjectRoots);
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
          ? await verifyHandoffArtifactRefs(
              this.service,
              this.options,
              existing.task_id,
              source.session_id,
              target.session_id,
              targetCwd,
              req.artifactRefs,
            )
          : await verifyHandoffArtifactRefs(
              this.service,
              this.options,
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
        const currentTarget = getTargetRow(this.db, initial.task_id, initial.target_target_id);
        if (!currentTarget || currentTarget.state !== 'active' || currentTarget.target_generation !== initial.target_generation) {
          this.expireDraftIfStillDraft(handoffId, 'target generation changed after preview');
        }
        throw new TaskHandoffError('stale_revision', 'target generation mismatch');
      }

      const preBinding = getBindingRow(this.db, initial.task_id);
      const preSource = getTargetRow(this.db, initial.task_id, initial.source_target_id);
      const preTarget = getTargetRow(this.db, initial.task_id, initial.target_target_id);

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
      const currentCwd = validateHandoffTargetCwd(targetSession.project, this.options.allowedProjectRoots);
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
        await verifyHandoffArtifactRefs(
          this.service,
          this.options,
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

      const {claimed,channelScope} = this.tx(() => {
        const row = this.getHandoffRow(handoffId);
        const binding = getBindingRow(this.db, initial.task_id);
        const source = getTargetRow(this.db, initial.task_id, initial.source_target_id);
        const target = getTargetRow(this.db, initial.task_id, initial.target_target_id);

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
        return {claimed:toDraft(this.getHandoffRow(handoffId)!),channelScope:taskInputScope(binding,target)};
      });

      const writeContext: WriteContext = {
        operationId: submitOpId,
        idempotencyKey: submitOpId,
        targetId: claimed.targetSessionId,
        expectedRevision: targetSession.revision,
        controlGeneration: targetSession.control.generation,
        identity: owner,
      };

      const mode = shouldAutoQueueInput(targetSession) ? 'queue' : 'new';
      const submitPromise = this.service.submitInput({
        context: writeContext,
        mode,
        channelScope,
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
