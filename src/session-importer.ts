import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { BridgeDatabase } from "./db.js";
import type { SessionImporterPort } from "./bridge-contracts.js";

export async function jsonlFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}

export interface SessionImporterOptions {
  readonly sessionsDir: string;
  readonly db: BridgeDatabase;
  readonly isEnabled: () => boolean;
  readonly processFile: (path: string) => Promise<void>;
  readonly reconcileHistory: () => Promise<void>;
  readonly onError: (operation: string, path: string, error: unknown) => void;
}

/** Owns JSONL watcher, file queues, and bounded changed-file scanning. */
export class SessionImporter implements SessionImporterPort {
  private watcher: FSWatcher | null = null;
  private readonly fileQueues = new Map<string, Promise<void>>();
  private syncing: Promise<void> | null = null;

  constructor(private readonly options: SessionImporterOptions) {}

  async startWatching(): Promise<void> {
    if (this.watcher) return;
    this.watcher = watch(this.options.sessionsDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.watcher.on("add", (path) => this.queueFile(path));
    this.watcher.on("change", (path) => this.queueFile(path));
    this.watcher.on("error", (error) => this.options.onError("session_watcher", this.options.sessionsDir, error));
  }

  async stopWatching(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
    await Promise.allSettled(this.fileQueues.values());
    this.fileQueues.clear();
  }

  async syncChangedFiles(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.scanChangedFiles().catch((error) => {
      this.options.onError("sync_all", this.options.sessionsDir, error);
      throw error;
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async reconcileHistory(): Promise<void> {
    await this.options.reconcileHistory();
  }

  enqueue(path: string): void {
    void this.enqueueFile(path);
  }

  enqueueAndWait(path: string): Promise<void> {
    return this.enqueueFile(path);
  }

  private async scanChangedFiles(): Promise<void> {
    if (!this.options.isEnabled()) return;
    const changed: string[] = [];
    for (const path of await jsonlFiles(this.options.sessionsDir)) {
      const info = await stat(path);
      const cursor = this.options.db.getCursor(path);
      if (cursor.parsedOffset >= info.size && cursor.size === info.size && cursor.mtimeMs >= info.mtimeMs) continue;
      changed.push(path);
    }
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, changed.length) }, async () => {
      while (cursor < changed.length) {
        const path = changed[cursor++];
        if (path) await this.enqueueFile(path);
      }
    });
    await Promise.all(workers);
  }

  private queueFile(path: string): void {
    void this.enqueueFile(path);
  }

  private enqueueFile(path: string): Promise<void> {
    if (!path.endsWith(".jsonl") || !this.options.isEnabled()) return Promise.resolve();
    const previous = this.fileQueues.get(path) ?? Promise.resolve();
    const next = previous.then(() => this.options.processFile(path)).catch((error) => {
      this.options.onError("process_file", path, error);
    }).finally(() => {
      if (this.fileQueues.get(path) === next) this.fileQueues.delete(path);
    });
    this.fileQueues.set(path, next);
    return next;
  }
}
