import type { Page } from '../contracts.js';
import {
  decodeCursor,
  encodeCursor,
  sha256,
  type AgyArtifactEntry,
  type AgyArtifactOptions,
  type AgyCatalogOptions,
  type AgyDiscoveredSession,
  type AgyReadTranscriptOptions,
  type AgyTranscriptMessage,
  type AgyTranscriptReadResult,
} from './catalog-types.js';
import { readAgySummaries, type AgyTitleCacheEntry } from './catalog-summaries.js';
import { refreshAgyCatalog } from './catalog-refresh.js';
import { readAgyTranscript, readAgyTranscriptCreatedAt, readCachedAgyTranscript, type AgyTranscriptCacheEntry } from './catalog-transcript.js';
import { discoverAgyArtifacts, readAgyArtifact } from './catalog-artifacts.js';

/**
 * Stateful catalog wrapper over Antigravity local SQLite index, JSONL transcripts, and artifacts.
 * Strictly read-only: never modifies `conversation_summaries.db` or spawns `agy`.
 */
export class AgyCatalog {
  private sessions = new Map<string, AgyDiscoveredSession>();
  private orderedIds: string[] = [];
  private titles = new Map<string, AgyTitleCacheEntry>();
  private readonly transcriptCache = new Map<string, AgyTranscriptCacheEntry>();
  private refreshing?: Promise<AgyDiscoveredSession[]>;
  private version = 0;

  constructor(private readonly options: AgyCatalogOptions = {}) {}

  get dbPath(): string | undefined {
    return this.options.dbPath;
  }

  get brainDir(): string | undefined {
    return this.options.brainDir;
  }

  refresh(): AgyDiscoveredSession[] {
    const titles = new Map<string, AgyTitleCacheEntry>();
    const list = readAgySummaries(this.options, { previous: this.titles, next: titles });
    this.version++;
    return this.replace(list, titles);
  }

  refreshAsync(): Promise<AgyDiscoveredSession[]> {
    if (this.refreshing) return this.refreshing;
    const version = this.version;
    const refresh = refreshAgyCatalog(this.options, this.titles).then(({ list, titles }) =>
      version === this.version ? this.replace(list, titles) : this.items());
    this.refreshing = refresh;
    void refresh.finally(() => { delete this.refreshing; }).catch(() => {});
    return refresh;
  }

  private replace(list: AgyDiscoveredSession[], titles: Map<string, AgyTitleCacheEntry>): AgyDiscoveredSession[] {
    const next = new Map<string, AgyDiscoveredSession>();
    const ids: string[] = [];
    for (const s of list) {
      next.set(s.conversationId, s);
      ids.push(s.conversationId);
    }
    this.sessions = next;
    this.orderedIds = ids;
    this.titles = titles;
    return this.items();
  }

  private items(): AgyDiscoveredSession[] {
    return this.orderedIds.map((id) => structuredClone(this.sessions.get(id)!));
  }

  get(conversationId: string): AgyDiscoveredSession | null {
    const found = this.sessions.get(conversationId);
    return found ? structuredClone(found) : null;
  }

  list(limit: number, cursor?: string, search = ''): Page<AgyDiscoveredSession> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid limit');
    const needle = search.toLowerCase();
    const filtered = this.orderedIds
      .map((id) => this.sessions.get(id)!)
      .filter((s) => `${s.title}\n${s.project}\n${s.conversationId}`.toLowerCase().includes(needle));

    const fingerprint = sha256(JSON.stringify([needle, filtered.map((s) => s.conversationId)]));
    let offset = 0;
    if (cursor) {
      const c = decodeCursor(cursor);
      if (
        c.fingerprint !== fingerprint ||
        typeof c.offset !== 'number' ||
        !Number.isSafeInteger(c.offset) ||
        c.offset < 0 ||
        c.offset > filtered.length
      ) {
        throw new Error('stale or invalid cursor');
      }
      offset = c.offset;
    }

    const end = Math.min(offset + limit, filtered.length);
    return {
      items: filtered.slice(offset, end).map((s) => structuredClone(s)),
      nextCursor: end < filtered.length ? encodeCursor({ fingerprint, offset: end }) : null,
    };
  }

  private symlinkRoots(): readonly string[] | undefined {
    if (this.options.allowedSymlinkRoots !== undefined) return this.options.allowedSymlinkRoots;
    const combined = [
      ...(this.options.allowedProjectRoots ?? []),
      ...(this.options.outputRoots ?? []),
    ];
    return combined.length > 0 ? combined : undefined;
  }

  async readTranscript(
    conversationId: string,
    options: Omit<AgyReadTranscriptOptions, 'brainDir'> = {},
  ): Promise<AgyTranscriptReadResult> {
    const readOpts: AgyReadTranscriptOptions = { ...options };
    if (this.options.brainDir !== undefined) readOpts.brainDir = this.options.brainDir;
    if (readOpts.brainDirs === undefined && this.options.brainDirs !== undefined) {
      readOpts.brainDirs = this.options.brainDirs;
    }
    if (readOpts.appDataDir === undefined) {
      const appDataDir = this.sessions.get(conversationId)?.appDataDir;
      if (appDataDir) readOpts.appDataDir = appDataDir;
    }
    if (readOpts.maxBytes === undefined && this.options.maxTranscriptBytes !== undefined) {
      readOpts.maxBytes = this.options.maxTranscriptBytes;
    }
    if (options.cursor !== undefined || options.afterLine !== undefined || options.sinceTimestamp !== undefined ||
        options.afterStepIndex !== undefined) {
      return readAgyTranscript(conversationId, readOpts);
    }
    const previous = this.transcriptCache.get(conversationId);
    const maxCacheBytes = 64 * 1024 * 1024;
    const result = await readCachedAgyTranscript(conversationId, readOpts, this.transcriptCache, maxCacheBytes);
    if (previous?.result === result || !this.transcriptCache.has(conversationId)) return result;
    // Bound retained histories by entry count and the size of source and parsed rows.
    let bytes = 0;
    for (const entry of this.transcriptCache.values()) bytes += entry.retainedBytes;
    for (const [id, entry] of this.transcriptCache) {
      if (this.transcriptCache.size <= 128 && bytes <= maxCacheBytes) break;
      this.transcriptCache.delete(id);
      bytes -= entry.retainedBytes;
    }
    return result;
  }

  async readTranscriptCreatedAt(
    conversationId: string,
    appDataDir?: string,
  ): Promise<string | null> {
    const resolvedAppDataDir = appDataDir ?? this.sessions.get(conversationId)?.appDataDir;
    return readAgyTranscriptCreatedAt(conversationId, {
      ...(this.options.brainDir !== undefined ? { brainDir: this.options.brainDir } : {}),
      ...(this.options.brainDirs !== undefined ? { brainDirs: this.options.brainDirs } : {}),
      ...(resolvedAppDataDir ? { appDataDir: resolvedAppDataDir } : {}),
    });
  }

  async history(
    conversationId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<AgyTranscriptMessage>> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid limit');
    const transcript = await this.readTranscript(conversationId);
    const messages = transcript.messages;

    let offset = 0;
    if (cursor) {
      const c = decodeCursor(cursor);
      if (
        c.conversationId !== conversationId ||
        typeof c.offset !== 'number' ||
        !Number.isSafeInteger(c.offset) ||
        c.offset < 0 ||
        c.offset > messages.length ||
        c.prefix !== sha256(JSON.stringify(messages.slice(0, c.offset).map((m) => m.messageId)))
      ) {
        throw new Error('stale or invalid cursor');
      }
      offset = c.offset;
    }

    const end = Math.min(offset + limit, messages.length);
    return {
      items: messages.slice(offset, end).map((m) => structuredClone(m)),
      nextCursor: encodeCursor({
        conversationId,
        offset: end,
        prefix: sha256(JSON.stringify(messages.slice(0, end).map((m) => m.messageId))),
      }),
    };
  }

  async listArtifacts(
    conversationId: string,
    options: { includeScratch?: boolean } = {},
  ): Promise<AgyArtifactEntry[]> {
    const artOpts: AgyArtifactOptions = {};
    if (this.options.brainDir !== undefined) artOpts.brainDir = this.options.brainDir;
    if (this.options.brainDirs !== undefined) artOpts.brainDirs = this.options.brainDirs;
    const appDataDir = this.sessions.get(conversationId)?.appDataDir;
    if (appDataDir) artOpts.appDataDir = appDataDir;
    if (this.options.maxArtifactBytes !== undefined) artOpts.maxBytes = this.options.maxArtifactBytes;
    if (this.options.allowedArtifactExtensions !== undefined) {
      artOpts.allowedExtensions = this.options.allowedArtifactExtensions;
    }
    const symlinkRoots = this.symlinkRoots();
    if (symlinkRoots !== undefined) artOpts.allowedSymlinkRoots = symlinkRoots;
    if (options.includeScratch !== undefined) artOpts.includeScratch = options.includeScratch;
    return discoverAgyArtifacts(conversationId, artOpts);
  }

  async readArtifact(
    conversationId: string,
    relativePath: string,
    expectedContentVersion?: string,
    options: { includeScratch?: boolean } = {},
  ): Promise<{ entry: AgyArtifactEntry; content: Uint8Array }> {
    const artOpts: AgyArtifactOptions & { expectedContentVersion?: string } = {};
    if (this.options.brainDir !== undefined) artOpts.brainDir = this.options.brainDir;
    if (this.options.brainDirs !== undefined) artOpts.brainDirs = this.options.brainDirs;
    const appDataDir = this.sessions.get(conversationId)?.appDataDir;
    if (appDataDir) artOpts.appDataDir = appDataDir;
    if (this.options.maxArtifactBytes !== undefined) artOpts.maxBytes = this.options.maxArtifactBytes;
    if (this.options.allowedArtifactExtensions !== undefined) {
      artOpts.allowedExtensions = this.options.allowedArtifactExtensions;
    }
    const symlinkRoots = this.symlinkRoots();
    if (symlinkRoots !== undefined) artOpts.allowedSymlinkRoots = symlinkRoots;
    if (options.includeScratch !== undefined) artOpts.includeScratch = options.includeScratch;
    if (expectedContentVersion !== undefined) artOpts.expectedContentVersion = expectedContentVersion;
    return readAgyArtifact(conversationId, relativePath, artOpts);
  }
}
