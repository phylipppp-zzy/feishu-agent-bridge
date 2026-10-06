import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * When the bridge last wrote into a session's transcript from Feishu, in
 * `<STATE_DIR>/feishu-activity/<session_id>.json`. `scripts/claude-hook.mjs` compares it with the
 * time a VS Code or terminal window loaded the session: a window opened before that does not show
 * the Feishu turns, and a prompt sent from it would branch the conversation away from them.
 */
export function markFeishuActivity(stateDir: string, sessionId: string, at = Date.now()): void {
  const directory = join(stateDir, "feishu-activity");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${sessionId}.json`);
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    const fd = openSync(temporary, "w", 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, sessionId, at }));
    } finally { closeSync(fd); }
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* nothing left behind */ }
    throw error;
  }
}
