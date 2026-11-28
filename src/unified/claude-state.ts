import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openHostDatabase, transaction, type SessionHostRegistry } from './session-host/registry.js';
import { contractError } from './errors.js';

type Entry = { origin: 'bridge_sdk' | 'external_resume' };
type MessageLink = { id: string; generation: number; turnId?: string };
interface State { version: 1; hostId: string; serviceId: string; generation: number; sessions: Record<string, Entry> }
function validMessageLink(entry: unknown): entry is MessageLink {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const link = entry as Partial<MessageLink>;
  return typeof link.id === 'string' && !!link.id &&
    Number.isSafeInteger(link.generation) && link.generation! > 0 &&
    (link.turnId === undefined || typeof link.turnId === 'string' && !!link.turnId);
}
export interface ClaudeStateOptions {
  registry?: SessionHostRegistry;
  /** Path to the shared registry SQLite file. */
  registryPath?: string;
}

/** JSON remains available for single-process embeddings. Hosted adapters share SQLite. */
export class ClaudeState {
  private readonly path: string; private readonly aliasPath:string; private readonly hostId:string; private readonly serviceId:string;
  private aliases: Record<string, Record<string, MessageLink>> = {};
  private state: State;
  private readonly db?: DatabaseSync;

  constructor(dir: string, hostId: string, serviceId: string, options: ClaudeStateOptions = {}) {
    if (!dir) throw contractError('invalid_request', 'Claude state directory required'); mkdirSync(dir, { recursive: true, mode: 0o700 }); this.path = join(dir, 'claude-owned.json'); this.aliasPath=join(dir,'claude-message-aliases-v1.json'); this.hostId=hostId; this.serviceId=serviceId;
    this.state = { version: 1, hostId, serviceId, generation: 0, sessions: {} };
    const path = options.registry?.path ?? options.registryPath ?? process.env.FEISHU_SESSION_HOST_REGISTRY_DB;
    if (!path) {
      this.loadLegacy();
      return;
    }
    const db = openHostDatabase(resolve(path));
    try {
      transaction(db, () => this.importLegacy(db));
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private loadLegacy(): void {
    const { hostId, serviceId } = this;
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as State;
      if (value.version !== 1 || value.hostId !== hostId || value.serviceId !== serviceId ||
          !Number.isSafeInteger(value.generation) || value.generation < 0 ||
          !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) ||
          Object.entries(value.sessions).some(([id, entry]) => !id || !entry || typeof entry !== 'object' ||
            Array.isArray(entry) || (entry.origin !== 'bridge_sdk' && entry.origin !== 'external_resume'))) {
        throw Error('invalid state');
      }
      this.state = value;
    }
    catch (e: any) { if (e?.code !== 'ENOENT') throw contractError('temporarily_unavailable', 'Claude ownership registry invalid or inaccessible'); }
    try {
      const value = JSON.parse(readFileSync(this.aliasPath, 'utf8'));
      if (value.version !== 1 || value.hostId !== hostId || value.serviceId !== serviceId ||
        !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) ||
        Object.entries(value.sessions).some(([session, aliases]) => !session || !aliases ||
          typeof aliases !== 'object' || Array.isArray(aliases) ||
          Object.entries(aliases).some(([outer, entry]) => !outer || !validMessageLink(entry)))) {
        throw Error('invalid alias state');
      }
      this.aliases = value.sessions;
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw contractError('temporarily_unavailable', 'Claude message aliases invalid or inaccessible');
    }
  }
  private importLegacy(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS claude_owned (
        session_id TEXT PRIMARY KEY, origin TEXT NOT NULL, generation INTEGER NOT NULL,
        alias TEXT UNIQUE, metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claude_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS claude_message_aliases (
        session_id TEXT NOT NULL, outer_id TEXT NOT NULL, inner_id TEXT NOT NULL,
        generation INTEGER NOT NULL, turn_id TEXT, PRIMARY KEY (session_id, outer_id)
      );
    `);
    const marker = 'legacy_import:' + JSON.stringify([this.hostId, this.serviceId]);
    if (db.prepare('SELECT 1 FROM claude_counters WHERE name = ?').get(marker)) return;
    this.loadLegacy();
    let generation = this.state.generation;
    for (const [id, entry] of Object.entries(this.state.sessions)) {
      if (!db.prepare('SELECT 1 FROM claude_owned WHERE session_id = ?').get(id)) this.writeEntry(db, id, entry);
    }
    for (const [sessionId, aliases] of Object.entries(this.aliases)) {
      for (const [outer, link] of Object.entries(aliases)) {
        this.writeLink(db, sessionId, outer, link);
        generation = Math.max(generation, link.generation);
      }
    }
    db.prepare(`INSERT INTO claude_counters VALUES ('connection_generation', ?)
      ON CONFLICT(name) DO UPDATE SET value = max(value, excluded.value)`).run(generation);
    db.prepare('INSERT INTO claude_counters VALUES (?, 1)').run(marker);
    this.state.sessions = {};
    this.aliases = {};
  }

  private increment(db: DatabaseSync, name: string): number {
    const row = db.prepare(`INSERT INTO claude_counters VALUES (?, 1)
      ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`).get(name);
    const value = row?.value;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw contractError('temporarily_unavailable', 'Claude generation exhausted');
    }
    return value;
  }

  private writeEntry(db: DatabaseSync, id: string, entry: Entry): void {
    const generation = this.increment(db, 'ownership_generation');
    db.prepare(`INSERT INTO claude_owned VALUES (?, ?, ?, NULL, '{}', ?)
      ON CONFLICT(session_id) DO UPDATE SET origin = excluded.origin,
        generation = excluded.generation, updated_at = excluded.updated_at`)
      .run(id, entry.origin, generation, new Date().toISOString());
  }

  private writeLink(db: DatabaseSync, sessionId: string, outer: string, link: MessageLink): void {
    const previous = this.readLink(db, sessionId, outer);
    if (!this.shouldLink(previous, link)) return;
    db.prepare(`INSERT INTO claude_message_aliases VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, outer_id) DO UPDATE SET generation = excluded.generation, turn_id = excluded.turn_id`)
      .run(sessionId, outer, link.id, link.generation, link.turnId ?? null);
  }

  private readLink(db: DatabaseSync, sessionId: string, outer: string): MessageLink | undefined {
    const row = db.prepare('SELECT inner_id, generation, turn_id FROM claude_message_aliases WHERE session_id = ? AND outer_id = ?')
      .get(sessionId, outer);
    if (!row) return undefined;
    const link = { id: row.inner_id, generation: row.generation, ...(row.turn_id === null ? {} : { turnId: row.turn_id }) };
    if (!validMessageLink(link)) throw contractError('temporarily_unavailable', 'Claude message alias row invalid');
    return link;
  }

  private shouldLink(previous: Readonly<MessageLink> | undefined, link: MessageLink): boolean {
    if (previous && (previous.id !== link.id || previous.turnId && link.turnId && previous.turnId !== link.turnId)) {
      throw contractError('idempotency_conflict', 'Claude message identity changed');
    }
    return !previous || (!previous.turnId && !!link.turnId);
  }

  close(): void { this.db?.close(); }

  private save(next: State): void { const tmp = `${this.path}.${randomUUID()}.tmp`; try { writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(tmp, this.path); this.state = next; } catch { throw contractError('temporarily_unavailable', 'Claude ownership registry write failed'); } }
  get(id: string): Entry | undefined {
    if (!this.db) return Object.hasOwn(this.state.sessions, id) ? this.state.sessions[id] : undefined;
    const row = this.db.prepare('SELECT origin FROM claude_owned WHERE session_id = ?').get(id);
    if (!row) return undefined;
    if (row.origin !== 'bridge_sdk' && row.origin !== 'external_resume') {
      throw contractError('temporarily_unavailable', 'Claude ownership row invalid');
    }
    return { origin: row.origin };
  }

  put(id: string, entry: Entry): void {
    const db = this.db;
    if (db) transaction(db, () => this.writeEntry(db, id, entry));
    else this.save({ ...this.state, sessions: { ...this.state.sessions, [id]: entry } });
  }
  linkMessage(sessionId: string, outer: string, inner: string, generation: number, turnId?: string): void {
    const link = { id: inner, generation, ...(turnId === undefined ? {} : { turnId }) };
    if (!outer || !validMessageLink(link)) throw contractError('invalid_request');
    const db = this.db;
    if (db) {
      transaction(db, () => {
        if (!this.get(sessionId)) throw contractError('invalid_request');
        this.writeLink(db, sessionId, outer, link);
      });
      return;
    }
    if (!this.get(sessionId)) throw contractError('invalid_request');
    if (!this.shouldLink(this.messageLink(sessionId, outer), link)) return;
    const sessions = { ...this.aliases, [sessionId]: { ...this.aliases[sessionId], [outer]: link } };
    const tmp = `${this.aliasPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, hostId: this.hostId, serviceId: this.serviceId, sessions }), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.aliasPath);
      this.aliases = sessions;
    } catch {
      throw contractError('temporarily_unavailable', 'Claude message alias write failed');
    }
  }
  messageLink(sessionId: string, outer: string): Readonly<MessageLink> | undefined {
    if (this.db) return this.get(sessionId) && this.readLink(this.db, sessionId, outer);
    const aliases = this.get(sessionId) && this.aliases[sessionId];
    return aliases && Object.hasOwn(aliases, outer) ? aliases[outer] : undefined;
  }
  messageAlias(sessionId: string, outer: string): string | undefined { return this.messageLink(sessionId, outer)?.id; }
  nextGeneration(): number {
    const db = this.db;
    if (db) return transaction(db, () => this.increment(db, 'connection_generation'));
    const generation = this.state.generation + 1;
    this.save({ ...this.state, generation });
    return generation;
  }
}
