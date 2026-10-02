import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { parseTranscriptChunk, type TranscriptEvent } from "./transcript.js";

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const READ_CHUNK_BYTES = 8 * 1024 * 1024;

/** Session id of a main transcript `<projects>/<project>/<id>.jsonl`; subagent and replaced files have none. */
export function transcriptSessionId(path: string): string | null {
  return basename(path).match(SESSION_FILE)?.[1] ?? null;
}

/** Whether `path` is a main transcript directly inside a project directory of `projectsDir`. */
export function isTranscriptPath(path: string, projectsDir: string): boolean {
  const parts = relative(projectsDir, path).split(sep);
  return parts.length === 2 && parts[0] !== ".." && Boolean(transcriptSessionId(path));
}

/** The folder under `projects/` where Claude Code keeps the transcripts of sessions started in `dir`. */
export function projectFolderName(dir: string): string { return dir.replace(/[^a-zA-Z0-9]/g, "-"); }

/**
 * The directory a session was started in. Each record carries the session's current directory,
 * which follows its shell into subdirectories; the transcript's folder keeps the starting one.
 * Falls back to `cwd` when no parent matches (for example a directory added with --add-dir).
 */
export function sessionProjectDir(transcriptPath: string, cwd: string | null): string | null {
  if (!cwd) return null;
  const folder = basename(dirname(transcriptPath));
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (projectFolderName(dir) === folder) return dir;
    if (dir === dirname(dir)) return cwd;
  }
}

export async function transcriptFiles(projectsDir: string): Promise<string[]> {
  const files: string[] = [];
  let projects;
  try { projects = await readdir(projectsDir, { withFileTypes: true }); } catch { return files; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let entries;
    try { entries = await readdir(join(projectsDir, project.name), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isFile() && transcriptSessionId(entry.name)) files.push(join(projectsDir, project.name, entry.name));
  }
  return files.sort();
}

/**
 * Parses complete lines between `start` and `end` in bounded chunks. A trailing
 * partial line is left for the next read; `next` is where that read should begin.
 */
export async function readTranscriptEvents(path: string, start: number, end: number): Promise<{ events: TranscriptEvent[]; next: number }> {
  const events: TranscriptEvent[] = [];
  const handle = await open(path, "r");
  try {
    let position = start;
    let carry = Buffer.alloc(0);
    let next = start;
    while (position < end) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, end - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline < 0) { carry = Buffer.from(data); continue; }
      events.push(...parseTranscriptChunk(data.subarray(0, lastNewline).toString("utf8")));
      next = position - (data.length - lastNewline - 1);
      carry = Buffer.from(data.subarray(lastNewline + 1));
    }
    return { events, next };
  } finally { await handle.close(); }
}

export interface TranscriptImporterOptions {
  readonly projectsDir: string;
  readonly isEnabled: () => boolean;
  readonly needsRead: (path: string, size: number, mtimeMs: number, inode: string) => boolean;
  readonly processFile: (path: string) => Promise<void>;
  readonly onError: (operation: string, path: string, error: unknown) => void;
}

/** Watches Claude Code transcripts and serializes processing per file. */
export class TranscriptImporter {
  private watcher: FSWatcher | null = null;
  private readonly fileQueues = new Map<string, Promise<void>>();
  private syncing: Promise<void> | null = null;

  constructor(private readonly options: TranscriptImporterOptions) {}

  async startWatching(): Promise<void> {
    if (this.watcher) return;
    this.watcher = watch(this.options.projectsDir, {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (path, stats) => Boolean(stats?.isFile()) && !isTranscriptPath(path, this.options.projectsDir),
    });
    this.watcher.on("add", (path) => this.enqueue(path));
    this.watcher.on("change", (path) => this.enqueue(path));
    this.watcher.on("error", (error) => this.options.onError("transcript_watcher", this.options.projectsDir, error));
  }

  async stopWatching(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
    await Promise.allSettled(this.fileQueues.values());
  }

  /** Scans every transcript and processes those whose size, modification time or inode changed. */
  syncChangedFiles(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.scan().catch((error) => {
      this.options.onError("transcript_scan", this.options.projectsDir, error);
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  enqueue(path: string): Promise<void> {
    if (!isTranscriptPath(path, this.options.projectsDir) || !this.options.isEnabled()) return Promise.resolve();
    const previous = this.fileQueues.get(path) ?? Promise.resolve();
    const next = previous.then(() => this.options.processFile(path)).catch((error) => {
      this.options.onError("process_transcript", path, error);
    }).finally(() => {
      if (this.fileQueues.get(path) === next) this.fileQueues.delete(path);
    });
    this.fileQueues.set(path, next);
    return next;
  }

  private async scan(): Promise<void> {
    if (!this.options.isEnabled()) return;
    const changed: string[] = [];
    for (const path of await transcriptFiles(this.options.projectsDir)) {
      try {
        const info = await stat(path);
        if (this.options.needsRead(path, info.size, info.mtimeMs, String(info.ino))) changed.push(path);
      } catch { /* the file was removed while scanning */ }
    }
    // Oldest first and one at a time: topics are then created in activity order,
    // so the most recently active session ends up as the newest topic.
    const mtimes = new Map<string, number>();
    for (const path of changed) mtimes.set(path, (await stat(path).catch(() => null))?.mtimeMs ?? 0);
    changed.sort((a, b) => (mtimes.get(a) ?? 0) - (mtimes.get(b) ?? 0));
    for (const path of changed) await this.enqueue(path);
  }
}
