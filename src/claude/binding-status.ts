import { access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Whether the bridge state in `stateDir` is bound to a Feishu group, for the installer and
 * doctor. The database is opened read-only, so the running service is not disturbed.
 */
export async function readBinding(stateDir: string): Promise<{ boundAt: string | null } | null> {
  const path = join(stateDir, "bridge.sqlite");
  try { await access(path); } catch { return null; }
  // Loading node:sqlite prints an experimental-feature warning that would only confuse script output.
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning instanceof Error ? warning.message : warning).includes("SQLite")) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const value = (key: string) => (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value?: string } | undefined)?.value ?? null;
      return value("feishu.chat_id") ? { boundAt: value("feishu.bound_at") } : null;
    } finally { db.close(); }
  } catch { return null; }
  finally { process.emitWarning = emitWarning; }
}
