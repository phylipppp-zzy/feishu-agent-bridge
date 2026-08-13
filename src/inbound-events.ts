/** Transport failures for which Feishu can safely retry the same event or API call. */
export function isRetryableTransportError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /(?:\b429\b|\b5\d{2}\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|timeout)/i.test(detail);
}
