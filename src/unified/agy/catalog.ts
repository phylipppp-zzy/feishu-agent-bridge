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
import { readAgySummaries } from './catalog-summaries.js';
import { readAgyTranscript } from './catalog-transcript.js';
import { discoverAgyArtifacts, readAgyArtifact } from './catalog-artifacts.js';

/**
 * Stateful catalog wrapper over Antigravity local SQLite index, JSONL transcripts, and artifacts.
 * Strictly read-only: never modifies `conversation_summaries.db` or spawns `agy`.
 */
export class AgyCatalog {
  private sessions = new Map<string, AgyDiscoveredSession>();
  private orderedIds: string[] = [];

  constructor(private readonly options: AgyCatalogOptions = {}) {}

  refresh(): AgyDiscoveredSession[] {
    const summaryOpts: Parameters<typeof readAgySummaries>[0] = {};
    if (this.options.dbPath !== undefined) summaryOpts.dbPath = this.options.dbPath;
    if (this.options.brainDir !== undefined) summaryOpts.brainDir = this.options.brainDir;
    if (this.options.allowedProjectRoots !== undefined) {
      summaryOpts.allowedProjectRoots = this.options.allowedProjectRoots;
    }
    if (this.options.includeOutsideRoots !== undefined) {
      summaryOpts.includeOutsideRoots = this.options.includeOutsideRoots;
    }
    if (this.options.maxTitleLength !== undefined) summaryOpts.maxTitleLength = this.options.maxTitleLength;

    const list = readAgySummaries(summaryOpts);
    const next = new Map<string, AgyDiscoveredSession>();
    const ids: string[] = [];
    for (const s of list) {
      next.set(s.conversationId, s);
      ids.push(s.conversationId);
    }
    this.sessions = next;
    this.orderedIds = ids;
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

  async readTranscript(
    conversationId: string,
    options: Omit<AgyReadTranscriptOptions, 'brainDir'> = {},
  ): Promise<AgyTranscriptReadResult> {
    const readOpts: AgyReadTranscriptOptions = { ...options };
    if (this.options.brainDir !== undefined) readOpts.brainDir = this.options.brainDir;
    if (readOpts.maxBytes === undefined && this.options.maxTranscriptBytes !== undefined) {
      readOpts.maxBytes = this.options.maxTranscriptBytes;
    }
    return readAgyTranscript(conversationId, readOpts);
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

  async listArtifacts(conversationId: string): Promise<AgyArtifactEntry[]> {
    const artOpts: AgyArtifactOptions = {};
    if (this.options.brainDir !== undefined) artOpts.brainDir = this.options.brainDir;
    if (this.options.maxArtifactBytes !== undefined) artOpts.maxBytes = this.options.maxArtifactBytes;
    if (this.options.allowedArtifactExtensions !== undefined) {
      artOpts.allowedExtensions = this.options.allowedArtifactExtensions;
    }
    return discoverAgyArtifacts(conversationId, artOpts);
  }

  async readArtifact(
    conversationId: string,
    relativePath: string,
    expectedContentVersion?: string,
  ): Promise<{ entry: AgyArtifactEntry; content: Uint8Array }> {
    const artOpts: AgyArtifactOptions & { expectedContentVersion?: string } = {};
    if (this.options.brainDir !== undefined) artOpts.brainDir = this.options.brainDir;
    if (this.options.maxArtifactBytes !== undefined) artOpts.maxBytes = this.options.maxArtifactBytes;
    if (this.options.allowedArtifactExtensions !== undefined) {
      artOpts.allowedExtensions = this.options.allowedArtifactExtensions;
    }
    if (expectedContentVersion !== undefined) artOpts.expectedContentVersion = expectedContentVersion;
    return readAgyArtifact(conversationId, relativePath, artOpts);
  }
}
