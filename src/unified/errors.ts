/** Stable errors: consumers must not parse provider exception text. */
export type ErrorCode = 'unsupported' | 'busy' | 'control_conflict' | 'stale_revision' | 'interaction_expired' | 'unauthorized' | 'temporarily_unavailable' | 'outcome_unknown' | 'idempotency_conflict' | 'invalid_request' | 'snapshot_required';
export interface ContractError { code: ErrorCode; retryable: boolean; suggestedAction: string; message?: string }
export const errorDefaults: Record<ErrorCode, Pick<ContractError, 'retryable' | 'suggestedAction'>> = {
  unsupported: { retryable: false, suggestedAction: 'choose_supported_action' },
  busy: { retryable: true, suggestedAction: 'wait_and_check' },
  control_conflict: { retryable: false, suggestedAction: 'refresh_control' },
  stale_revision: { retryable: false, suggestedAction: 'refresh_object' },
  interaction_expired: { retryable: false, suggestedAction: 'refresh_interaction' },
  unauthorized: { retryable: false, suggestedAction: 'check_authorization' },
  temporarily_unavailable: { retryable: true, suggestedAction: 'retry_later' },
  outcome_unknown: { retryable: false, suggestedAction: 'reconcile_operation' },
  idempotency_conflict: { retryable: false, suggestedAction: 'inspect_existing_operation' },
  invalid_request: { retryable: false, suggestedAction: 'correct_request' },
  snapshot_required: { retryable: false, suggestedAction: 'fetch_snapshot_then_subscribe' },
};
export function contractError(code: ErrorCode, message?: string): ContractError {
  return { code, ...errorDefaults[code], ...(message === undefined ? {} : { message }) };
}

/** Mock protocol mappings only; real SDK error codes must be verified at integration. */
const mockProviderErrors: Record<'claude' | 'codex', Record<string, ErrorCode>> = {
  claude: { overloaded: 'busy', permission_denied: 'unauthorized', disconnected: 'temporarily_unavailable', unsupported: 'unsupported', result_lost: 'outcome_unknown' },
  codex: { turn_busy: 'busy', forbidden: 'unauthorized', offline: 'temporarily_unavailable', not_implemented: 'unsupported', receipt_lost: 'outcome_unknown' },
};
export function mapMockProviderError(provider: 'claude' | 'codex', code: string): ContractError {
  return contractError(mockProviderErrors[provider][code] ?? 'outcome_unknown');
}
