import type { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { UnifiedService } from '../adapter.js';
import type { Artifact } from '../contracts.js';
import {
  isContractCodeError,
  isSafeArtifactName,
  MAX_HANDOFF_ARTIFACTS,
  sha256Hex,
  TaskHandoffError,
  type HandoffArtifactInput,
  type HandoffArtifactRef,
  type TaskHandoffOptions,
} from './handoff-types.js';
import { nonempty } from './types.js';

export function ensureHandoffSchema(db: DatabaseSync): void {
  db.exec(`
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

export function validateHandoffTargetCwd(
  cwd: string,
  allowedProjectRoots?: readonly string[],
): string {
  if (!nonempty(cwd) || cwd.includes('\0') || /[\r\n]/.test(cwd)) {
    throw new TaskHandoffError('invalid_request', 'invalid target cwd');
  }
  const parts = cwd.split(/[\\/]/);
  if (parts.includes('..')) {
    throw new TaskHandoffError('invalid_request', 'target cwd cannot contain parent traversal');
  }
  if (allowedProjectRoots && allowedProjectRoots.length > 0) {
    if (!isAbsolute(cwd)) {
      throw new TaskHandoffError('cwd_mismatch', 'target cwd must be absolute within allowed project roots');
    }
    const canonicalCwd = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
    const allowed = allowedProjectRoots.some((root) => {
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

export async function listControlledArtifacts(
  service: UnifiedService,
  sessionId: string,
): Promise<Artifact[]> {
  const collected: Artifact[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    try {
      const page = await service.listArtifacts(sessionId, {
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

export async function verifyHandoffArtifactRefs(
  service: UnifiedService,
  options: TaskHandoffOptions,
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
    listControlledArtifacts(service, sourceSessionId),
    listControlledArtifacts(service, targetSessionId),
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

    const bytes = await service.readArtifact(
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
    await options.verifyArtifact?.({
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
