import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ClaudeBridgeConfig {
  appId: string;
  appSecret: string;
  bindToken: string;
  /** Claude Code configuration directory; transcripts live in `projects/`. */
  claudeHome: string;
  stateDir: string;
  /** Working directories a later continuation phase may use; kept for parity with the Codex bridge. */
  allowedRoot: string;
  /** Sessions active within this many days get a topic when the bridge first sees them. */
  historyDays: number;
  scanIntervalMs: number;
  livenessIntervalMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadClaudeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeBridgeConfig {
  const home = homedir();
  return {
    appId: required(env, "FEISHU_APP_ID"),
    appSecret: required(env, "FEISHU_APP_SECRET"),
    bindToken: required(env, "FEISHU_BIND_TOKEN"),
    claudeHome: resolve(env.CLAUDE_HOME ?? `${home}/.claude`),
    stateDir: resolve(env.STATE_DIR ?? `${home}/.local/state/feishu-claude-bridge`),
    allowedRoot: resolve(env.ALLOWED_ROOT ?? home),
    historyDays: positiveInteger(env, "HISTORY_DAYS", 3),
    scanIntervalMs: positiveInteger(env, "SCAN_INTERVAL_MS", 10_000),
    livenessIntervalMs: positiveInteger(env, "LIVENESS_INTERVAL_MS", 30_000),
  };
}
