import type { DatabaseSync } from 'node:sqlite';
import type { Operation } from './contracts.js';
import type { Authorize, FeishuPort, TrustedEnvelope } from './feishu-channel.js';
import { ReadAuthorizationRevoked } from './topic-title-sync.js';

export const SUPPRESSED_COMPLETED_ACTIONS = new Set([
  'submitInput', 'resolveInteraction', 'attachSession', 'createSession', 'cancelQueuedInput',
  'requestControl', 'releaseControl', 'archiveSession', 'updateSessionSettings',
]);

export function needsOperationNotice(operation: Operation): boolean {
  return operation.status === 'failed' || operation.status === 'unknown';
}

export function operationFromReceipt(receipt: unknown): Operation | null {
  if (!receipt || typeof receipt !== 'object') return null;
  const op = receipt as Partial<Operation>;
  return typeof op.operationId === 'string' && typeof op.action === 'string' && typeof op.targetId === 'string' ? op as Operation : null;
}

export function pendingSessionAuthorization(
  db: DatabaseSync,
  port: FeishuPort,
  authorize: Authorize,
  envelope: TrustedEnvelope,
  operationId: string,
): { destination: string; guard: () => Promise<void> } | undefined {
  const pending = db.prepare(`
    SELECT p.destination,s.scope,a.envelope FROM channel_pending p
    JOIN channel_pending_scope s USING(operation_id)
    JOIN channel_pending_actors a USING(operation_id)
    WHERE p.operation_id=? AND p.kind='session'
  `).get(operationId) as {destination:string; scope:string; envelope:string} | undefined;
  if (!pending) return;
  const { destination } = pending;
  if (destination !== envelope.destination && destination !== port.chatDestination?.(envelope.destination)) return;
  const original = JSON.parse(pending.envelope) as TrustedEnvelope;
  if (original.destination !== destination || original.identity.source !== envelope.identity.source ||
      original.identity.subject !== envelope.identity.subject) return;

  const binding = db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings WHERE destination=?');
  const current = binding.get(destination) as {session_id:string} | undefined;
  const isCurrent = (row: unknown) => pending.scope === JSON.stringify(row ?? null);
  if (!isCurrent(current)) return;
  const guard = async () => {
    if (!isCurrent(binding.get(destination)) ||
        !await authorize(envelope.identity,destination,current?.session_id ?? null) ||
        !isCurrent(binding.get(destination))) {
      throw new ReadAuthorizationRevoked('pending operation unauthorized or changed');
    }
  };
  return { destination, guard };
}
