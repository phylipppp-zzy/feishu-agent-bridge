import { closeSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  counter, HostError, json, openPrivateFile, parseIdentity, parseJson, privateDirectory, sessionKey, sha256, string,
  type CreateIdentity, type HostIdentity, type HostMetadata, type HostRef,
} from './protocol.js';

type Row = Record<string, unknown>;
export type InstanceState = 'reserved' | 'starting' | 'ready' | 'attached' | 'detached' | 'draining' | 'closed';
export interface RegisteredInstance extends Omit<HostMetadata, 'keyId' | 'hostId' | 'serviceId'> {
  key: string;
  state: InstanceState;
  updatedAt: string;
}
export interface ReleasePin {
  pinId: string;
  key: string;
  releaseDir: string;
  reason: string;
  createdAt: string;
}
export interface ReservedIdentity {
  key: string;
  identity: HostIdentity;
  ref: HostRef | null;
}
export interface ClaudeOwnership {
  sessionId: string;
  origin: string;
  generation: number;
  alias: string | null;
  metadata: unknown;
  updatedAt: string;
}

export function openHostDatabase(path: string): DatabaseSync {
  privateDirectory(dirname(path), true);
  closeSync(openPrivateFile(path, constants.O_RDWR | constants.O_CREAT));
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

const now = () => new Date().toISOString();

function toInstance(row: Row): RegisteredInstance {
  const state = string(row.state, 'state');
  if (state !== 'reserved' && state !== 'starting' && state !== 'ready' && state !== 'attached'
      && state !== 'detached' && state !== 'draining' && state !== 'closed') throw new Error('invalid registry instance state');
  if (row.protocol_version !== 1) throw new HostError('version_mismatch');
  return {
    key: string(row.host_key, 'host_key'),
    instanceId: string(row.instance_id, 'instance_id'),
    provider: string(row.provider, 'provider'),
    sessionId: row.native_session_id === null ? null : string(row.native_session_id, 'native_session_id'),
    releaseDir: string(row.release_dir, 'release_dir'),
    unit: row.unit_name === null ? null : string(row.unit_name, 'unit_name'),
    pid: counter(row.pid, 'pid', 1),
    bootId: string(row.boot_id, 'boot_id'),
    startTicks: string(row.start_ticks, 'start_ticks'),
    state,
    protocolVersion: 1,
    startedAt: string(row.started_at, 'started_at'),
    updatedAt: string(row.updated_at, 'updated_at'),
  };
}

export function hostPinId(key: string, releaseDir: string): string {
  return 'host:' + key + ':' + sha256(releaseDir);
}

export class SessionHostRegistry {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'session-host', 'registry.sqlite');
    this.db = openHostDatabase(this.path);
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_keys (
          host_key TEXT PRIMARY KEY, identity_json TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
          host_id TEXT NOT NULL, service_id TEXT NOT NULL, native_session_id TEXT,
          create_operation_id TEXT UNIQUE, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS session_keys_ref ON session_keys(provider, host_id, service_id, native_session_id);
        CREATE TABLE IF NOT EXISTS host_instances (
          host_key TEXT PRIMARY KEY, instance_id TEXT NOT NULL, provider TEXT NOT NULL, native_session_id TEXT,
          release_dir TEXT NOT NULL, unit_name TEXT, pid INTEGER NOT NULL, boot_id TEXT NOT NULL, start_ticks TEXT NOT NULL,
          state TEXT NOT NULL, protocol_version INTEGER NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS release_pins (
          pin_id TEXT PRIMARY KEY, host_key TEXT NOT NULL, release_dir TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS claude_owned (
          session_id TEXT PRIMARY KEY, origin TEXT NOT NULL, generation INTEGER NOT NULL, alias TEXT UNIQUE,
          metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS claude_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  allocateBridgeEpoch(): number {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'bridge_epoch'").get();
      const previous = row ? string(row.value, 'bridge_epoch') : '0';
      if (!/^(0|[1-9]\d*)$/.test(previous)) throw new Error('invalid durable bridge epoch');
      const epoch = counter(Number(previous) + 1, 'bridge_epoch', 1);
      this.db.prepare("INSERT INTO meta VALUES ('bridge_epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(epoch));
      return epoch;
    });
  }

  reserveKeyForRef(ref: HostRef): string {
    return transaction(this.db, () => this.reserve(ref));
  }

  reserveKeyForCreate(identity: CreateIdentity): string {
    return transaction(this.db, () => this.reserve(identity));
  }

  private reserve(input: HostIdentity): string {
    const identity = parseIdentity(input);
    const key = sessionKey(identity);
    const encoded = json(identity);
    const row = this.db.prepare('SELECT identity_json FROM session_keys WHERE host_key = ?').get(key);
    if (row) {
      if (row.identity_json !== encoded) throw new HostError('identity_mismatch', 'host key collision');
      this.getIdentity(key);
      return key;
    }
    const creating = identity.length === 5;
    const [provider, hostId, serviceId, id] = creating ? [identity[1], identity[2], identity[3], identity[4]] : identity;
    if (creating && this.db.prepare('SELECT host_key FROM session_keys WHERE create_operation_id = ?').get(identity[4])) {
      throw new HostError('identity_mismatch', 'create operation is already reserved for another identity');
    }
    this.db.prepare('INSERT INTO session_keys VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(key, encoded, provider, hostId, serviceId, creating ? null : id, creating ? id : null, now());
    return key;
  }

  getIdentity(key: string): ReservedIdentity | undefined {
    const row = this.db.prepare('SELECT * FROM session_keys WHERE host_key = ?').get(key);
    if (!row) return undefined;
    const identity = parseIdentity(parseJson(string(row.identity_json, 'identity_json')));
    const [provider, hostId, serviceId, nativeSessionId] = identity.length === 5
      ? [identity[1], identity[2], identity[3], identity[4]] : identity;
    const nativeId = row.native_session_id === null ? null : string(row.native_session_id, 'native_session_id');
    if (sessionKey(identity) !== key || provider !== row.provider || hostId !== row.host_id || serviceId !== row.service_id
        || (identity.length === 4 ? nativeId !== nativeSessionId || row.create_operation_id !== null
          : row.create_operation_id !== identity[4])) {
      throw new HostError('identity_mismatch', 'registry identity differs from its key or columns');
    }
    return { key, identity, ref: nativeId === null ? null : [provider, hostId, serviceId, nativeId] };
  }

  bindCreateToNativeSession(key: string, nativeSessionId: string): HostRef {
    string(nativeSessionId, 'nativeSessionId');
    return transaction(this.db, () => {
      const reserved = this.getIdentity(key);
      if (!reserved || reserved.identity.length !== 5) throw new HostError('identity_mismatch', 'not a create reservation');
      const [, provider, hostId, serviceId] = reserved.identity;
      const ref: HostRef = [provider, hostId, serviceId, nativeSessionId];
      if (reserved.ref && reserved.ref[3] !== nativeSessionId) throw new HostError('identity_mismatch', 'create already bound');
      if (this.instancesForRef(ref).some(instance => instance.key !== key)
          || this.db.prepare(`SELECT host_key FROM session_keys WHERE provider = ? AND host_id = ? AND service_id = ?
            AND native_session_id = ? AND create_operation_id IS NOT NULL AND host_key <> ?`).get(...ref, key)) {
        throw new HostError('identity_mismatch', 'native session already has another owner');
      }
      this.reserve(ref);
      this.db.prepare('UPDATE session_keys SET native_session_id = ? WHERE host_key = ?').run(nativeSessionId, key);
      this.db.prepare('UPDATE host_instances SET native_session_id = ?, updated_at = ? WHERE host_key = ?')
        .run(nativeSessionId, now(), key);
      return ref;
    });
  }

  upsertInstance(key: string, meta: HostMetadata, state: InstanceState): void {
    transaction(this.db, () => {
      const identity = this.getIdentity(key);
      if (!identity) throw new HostError('identity_mismatch', 'host key is not reserved');
      const { ref } = identity;
      const base = identity.identity.length === 5 ? identity.identity.slice(1) : identity.identity;
      if (meta.provider !== base[0] || meta.hostId !== base[1] || meta.serviceId !== base[2]
          || meta.sessionId !== (ref?.[3] ?? null)) throw new HostError('identity_mismatch');
      if (ref && this.instancesForRef(ref).some(instance => instance.key !== key)) {
        throw new HostError('busy', 'native session already has a host');
      }
      const previous = this.getInstanceByKey(key);
      if (previous && previous.state !== 'closed' && previous.instanceId !== meta.instanceId) {
        throw new HostError('busy', 'host key already has an instance');
      }
      this.db.prepare(`
        INSERT INTO host_instances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_key) DO UPDATE SET instance_id=excluded.instance_id, provider=excluded.provider,
          native_session_id=excluded.native_session_id, release_dir=excluded.release_dir, unit_name=excluded.unit_name,
          pid=excluded.pid, boot_id=excluded.boot_id, start_ticks=excluded.start_ticks, state=excluded.state,
          protocol_version=excluded.protocol_version, started_at=excluded.started_at, updated_at=excluded.updated_at
      `).run(key, meta.instanceId, meta.provider, meta.sessionId, meta.releaseDir, meta.unit, meta.pid,
        meta.bootId, meta.startTicks, state, meta.protocolVersion, meta.startedAt, now());
    });
  }

  markInstanceState(key: string, state: InstanceState, instanceId?: string): boolean {
    return this.db.prepare(`UPDATE host_instances SET state = ?, updated_at = ? WHERE host_key = ?
      AND (? IS NULL OR instance_id = ?) AND (state NOT IN ('closed', 'draining') OR ? IN ('draining', 'closed'))
      AND (state <> 'closed' OR ? = 'closed')`)
      .run(state, now(), key, instanceId ?? null, instanceId ?? null, state, state).changes === 1;
  }

  finishInstance(key: string, instanceId: string, releaseDir: string): void {
    transaction(this.db, () => {
      if (this.markInstanceState(key, 'closed', instanceId)) this.unpinRelease(hostPinId(key, releaseDir));
    });
  }

  pinRelease(pinId: string, key: string, releaseDir: string, reason: string): void {
    transaction(this.db, () => {
      const pin = this.db.prepare('SELECT * FROM release_pins WHERE pin_id = ?').get(pinId);
      if (pin) {
        if (pin.host_key !== key || pin.release_dir !== releaseDir || pin.reason !== reason) {
          throw new HostError('identity_mismatch', 'release pin changed identity');
        }
        return;
      }
      this.db.prepare('INSERT INTO release_pins VALUES (?, ?, ?, ?, ?)').run(pinId, key, releaseDir, reason, now());
    });
  }

  unpinRelease(pinId: string): void {
    this.db.prepare('DELETE FROM release_pins WHERE pin_id = ?').run(pinId);
  }

  listActivePins(): ReleasePin[] {
    return this.db.prepare('SELECT * FROM release_pins ORDER BY created_at, pin_id').all().map(row => ({
      pinId: string(row.pin_id, 'pin_id'), key: string(row.host_key, 'host_key'),
      releaseDir: string(row.release_dir, 'release_dir'), reason: string(row.reason, 'reason'),
      createdAt: string(row.created_at, 'created_at'),
    }));
  }

  listActiveInstances(): RegisteredInstance[] {
    return this.db.prepare("SELECT * FROM host_instances WHERE state <> 'closed' ORDER BY host_key").all().map(toInstance);
  }

  private instancesForRef(ref: HostRef): RegisteredInstance[] {
    return this.db.prepare(`SELECT h.* FROM host_instances h JOIN session_keys k USING (host_key)
      WHERE k.provider = ? AND k.host_id = ? AND k.service_id = ? AND k.native_session_id = ? AND h.state <> 'closed'`)
      .all(...ref).map(toInstance);
  }

  getInstanceByRef(ref: HostRef): RegisteredInstance | undefined {
    const active = this.instancesForRef(ref);
    if (active.length > 1) throw new HostError('identity_mismatch', 'multiple active hosts for native session');
    return active[0] ?? this.getInstanceByKey(this.getBoundCreateKey(ref) ?? sessionKey(ref));
  }

  getBoundCreateKey(ref: HostRef): string | undefined {
    const rows = this.db.prepare(`SELECT host_key FROM session_keys WHERE provider = ? AND host_id = ? AND service_id = ?
      AND native_session_id = ? AND create_operation_id IS NOT NULL LIMIT 2`).all(...ref);
    if (rows.length > 1) throw new HostError('identity_mismatch', 'multiple create owners for native session');
    const row = rows[0];
    return row ? string(row.host_key, 'host_key') : undefined;
  }

  getInstanceByKey(key: string): RegisteredInstance | undefined {
    const row = this.db.prepare('SELECT * FROM host_instances WHERE host_key = ?').get(key);
    return row ? toInstance(row) : undefined;
  }

  getCreateReceipt(operationId: string): (ReservedIdentity & { instance: RegisteredInstance | null }) | undefined {
    const row = this.db.prepare('SELECT host_key FROM session_keys WHERE create_operation_id = ?').get(operationId);
    if (!row) return undefined;
    const key = string(row.host_key, 'host_key');
    const identity = this.getIdentity(key);
    if (!identity) throw new Error('missing create identity');
    return { ...identity, instance: this.getInstanceByKey(key) ?? null };
  }

  private incrementClaudeCounter(name: string): number {
    const row = this.db.prepare('SELECT value FROM claude_counters WHERE name = ?').get(name);
    const next = counter((row ? counter(row.value, 'counter') : 0) + 1, 'next counter', 1);
    this.db.prepare(`INSERT INTO claude_counters VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`)
      .run(name, next);
    return next;
  }

  allocateClaudeCounter(name: string): number {
    return transaction(this.db, () => this.incrementClaudeCounter(string(name, 'name')));
  }

  getClaudeOwnership(sessionId: string): ClaudeOwnership | undefined {
    const row = this.db.prepare('SELECT * FROM claude_owned WHERE session_id = ?').get(sessionId);
    if (!row) return undefined;
    return {
      sessionId: string(row.session_id, 'session_id'), origin: string(row.origin, 'origin'),
      generation: counter(row.generation, 'generation', 1), alias: row.alias === null ? null : string(row.alias, 'alias'),
      metadata: parseJson(string(row.metadata_json, 'metadata_json')), updatedAt: string(row.updated_at, 'updated_at'),
    };
  }

  putClaudeOwnership(input: Omit<ClaudeOwnership, 'generation' | 'updatedAt'>, expectedGeneration: number | null): ClaudeOwnership {
    return transaction(this.db, () => {
      const previous = this.getClaudeOwnership(input.sessionId);
      if ((previous?.generation ?? null) !== expectedGeneration) throw new HostError('fenced', 'Claude ownership changed');
      const generation = this.incrementClaudeCounter('ownership_generation');
      const updatedAt = now();
      this.db.prepare(`INSERT INTO claude_owned VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
        origin=excluded.origin, generation=excluded.generation, alias=excluded.alias,
        metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
        .run(string(input.sessionId, 'sessionId'), string(input.origin, 'origin'), generation,
          input.alias === null ? null : string(input.alias, 'alias'), json(input.metadata), updatedAt);
      return { ...input, generation, updatedAt };
    });
  }
}
