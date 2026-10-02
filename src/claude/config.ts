import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ClaudeBridgeConfig {
  appId: string;
  appSecret: string;
  bindToken: string;
  /** Claude Code configuration directory; transcripts live in `projects/`. */
  claudeHome: string;
  stateDir: string;
  /** New sessions started from Feishu must work in this directory or below it. */
  allowedRoot: string;
  /** The Claude Code executable that runs sessions continued from Feishu. */
  claudeBin: string;
  /** A Feishu-driven Claude Code process idle this long is stopped; the next message resumes the session. */
  runnerIdleMs: number;
  /** Sessions active within this many days get a topic when the bridge first sees them. */
  historyDays: number;
  /** Only sessions working in one of these directories or below them are mirrored; empty mirrors all. */
  syncDirs: string[];
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

/**
 * Comma-separated absolute directories (`~/` allowed). Each is resolved through symlinks,
 * because Claude Code records the physical working directory of a session.
 */
export function parseSyncDirs(raw: string | undefined, home = homedir()): string[] {
  const dirs = (raw ?? "").split(",").map((item) => item.trim()).filter(Boolean).map((dir) => {
    const expanded = dir === "~" ? home : dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
    if (!expanded.startsWith("/")) throw new Error(`SYNC_DIRS entries must be absolute paths: ${dir}`);
    try { return realpathSync(expanded); } catch { return resolve(expanded); }
  });
  return [...new Set(dirs)];
}

/** Whether a session whose working directory is `cwd` lies in the configured sync directories. */
export function inSyncScope(cwd: string | null, syncDirs: readonly string[]): boolean {
  if (!syncDirs.length) return true;
  if (!cwd) return false;
  return syncDirs.some((dir) => cwd === dir || cwd.startsWith(dir.endsWith("/") ? dir : `${dir}/`));
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
    claudeBin: env.CLAUDE_BIN?.trim() || "claude",
    runnerIdleMs: positiveInteger(env, "RUNNER_IDLE_MS", 10 * 60_000),
    historyDays: positiveInteger(env, "HISTORY_DAYS", 3),
    syncDirs: parseSyncDirs(env.SYNC_DIRS, home),
    scanIntervalMs: positiveInteger(env, "SCAN_INTERVAL_MS", 10_000),
    livenessIntervalMs: positiveInteger(env, "LIVENESS_INTERVAL_MS", 30_000),
  };
}
