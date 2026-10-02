/** Never serialize SDK request/config objects: they may contain credentials. */
export function safeDiagnostic(value: unknown, secrets: string[] = []): string {
  const scrub = (text: string): string => {
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[redacted]");
    return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/((?:app_secret|access_token|refresh_token|api_key|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]");
  };
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((entry) => safeDiagnostic(entry, secrets)).join(" ");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    const response = item.response as { status?: unknown; data?: { code?: unknown; msg?: unknown } } | undefined;
    const scalar = (field: unknown): string | number | undefined => typeof field === "string" || typeof field === "number" ? field : undefined;
    return scrub(JSON.stringify({ name: scalar(item.name), message: typeof item.message === "string" ? item.message : undefined,
      code: typeof item.code === "string" || typeof item.code === "number" ? item.code : undefined,
      status: scalar(response?.status), apiCode: scalar(response?.data?.code),
      apiMessage: typeof response?.data?.msg === "string" ? response.data.msg : undefined }));
  }
  return String(value);
}

export function installSafeLogging(secrets: string[]): void {
  for (const level of ["log", "error", "warn", "info", "debug", "trace"] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => original(...values.map((value) => safeDiagnostic(value, secrets)));
  }
}

export function isExpiredFeishuMessage(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const item = error as { response?: { data?: { code?: unknown } }; message?: unknown };
  return item.response?.data?.code === 230031 ||
    (typeof item.message === "string" && /Feishu API 230031\b/.test(item.message));
}
