import { readFile, readdir, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { PresenceState } from "./db.js";

/**
 * Live state of Claude Code sessions as reported by `scripts/claude-hook.mjs`, which
 * Claude Code runs on SessionStart, UserPromptSubmit, Stop, Notification and SessionEnd.
 * VS Code sessions run the same user-level hooks as terminal sessions.
 */
export interface PresenceRecord {
  sessionId: string;
  event: string;
  state: PresenceState;
  notificationType: string | null;
  message: string | null;
  transcriptPath: string | null;
  cwd: string | null;
  pid: number | null;
  pidStartTime: string | null;
  at: number;
}

const STATES = new Set(["idle", "running", "waiting", "closed"]);

export function parsePresence(raw: string): PresenceRecord | null {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (!value || typeof value !== "object" || value.version !== 1) return null;
  const text = (item: unknown) => typeof item === "string" && item ? item : null;
  const sessionId = text(value.sessionId);
  const state = text(value.state);
  if (!sessionId || !/^[A-Za-z0-9-]{8,80}$/.test(sessionId) || !state || !STATES.has(state) || typeof value.at !== "number") return null;
  return {
    sessionId, event: text(value.event) ?? "", state: state as PresenceState, notificationType: text(value.notificationType), message: text(value.message),
    transcriptPath: text(value.transcriptPath), cwd: text(value.cwd), pid: typeof value.pid === "number" ? value.pid : null,
    pidStartTime: text(value.pidStartTime), at: value.at,
  };
}

/** Whether the process still runs and is the same process (its start time guards against PID reuse). */
export function processAlive(pid: number, startTime: string | null, procRoot = "/proc"): boolean {
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    if (!startTime) return true;
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Field 22 of /proc/<pid>/stat; fields[0] here is field 3 (state).
    return fields[19] === startTime;
  } catch { return false; }
}

export class PresenceWatcher {
  private watcher: FSWatcher | null = null;

  constructor(private readonly directory: string, private readonly onRecord: (record: PresenceRecord) => Promise<void>) {}

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.watcher = watch(this.directory, { ignoreInitial: true, depth: 0, awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 } });
    const handle = (path: string) => { if (path.endsWith(".json")) void this.read(path); };
    this.watcher.on("add", handle);
    this.watcher.on("change", handle);
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }

  /** Reads every state file; used at startup, when change events may have been missed. */
  async scan(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); } catch { return; }
    for (const name of names) if (name.endsWith(".json")) await this.read(join(this.directory, name));
  }

  private async read(path: string): Promise<void> {
    let raw: string;
    try { raw = await readFile(path, "utf8"); } catch { return; }
    const record = parsePresence(raw);
    if (record && basename(path) === `${record.sessionId}.json`) await this.onRecord(record).catch(() => undefined);
  }
}
