import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { counter, HostError, hex, json, parseJson, runtimePaths, string } from './protocol.js';
import { openHostDatabase, transaction } from './registry.js';

export type OperationState = 'prepared' | 'submitted' | 'terminal' | 'unknown';
export interface StoredOperation {
  state: OperationState;
  digest: string;
  receipt?: unknown;
  error?: unknown;
}
export type OperationReceipt = StoredOperation | { state: 'absent' };
export interface JournalEvent {
  seq: number;
  instanceId: string;
  observation: unknown;
  terminal: boolean;
}

const now = () => new Date().toISOString();

export class SessionHostJournal {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(stateDir: string, key: string) {
    // Apply the same key validation even when opening a journal without the launcher.
    runtimePaths('/', key);
    this.path = join(stateDir, 'session-host', key, 'journal.sqlite');
    this.db = openHostDatabase(this.path);
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS operations (
          operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
          receipt_json TEXT, error_json TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS unacked_events (
          seq INTEGER PRIMARY KEY, instance_id TEXT NOT NULL, payload_json TEXT NOT NULL,
          is_terminal INTEGER NOT NULL CHECK(is_terminal IN (0, 1)), created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS host_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  prepareOperation(operationId: string, digest: string, kind: string): { created: boolean; operation: StoredOperation } {
    return transaction(this.db, () => {
      const previous = this.getOperation(operationId);
      if (previous) {
        if (previous.digest !== digest) throw new HostError('invalid_request', 'operation ID digest mismatch');
        return { created: false, operation: previous };
      }
      this.db.prepare("INSERT INTO operations VALUES (?, ?, ?, 'prepared', NULL, NULL, ?)")
        .run(string(operationId, 'operationId'), hex(digest, 'digest'), string(kind, 'kind'), now());
      return { created: true, operation: { state: 'prepared', digest } };
    });
  }

  markOperationSubmitted(operationId: string): void {
    this.changeOperation(operationId, 'submitted', null, null, "'prepared'");
  }

  markOperationTerminal(operationId: string, receipt: unknown): void {
    const encoded = json(receipt);
    this.changeOperation(operationId, 'terminal', encoded, null, "'submitted', 'unknown'");
  }

  markOperationUnknown(operationId: string, error: unknown): void {
    this.changeOperation(operationId, 'unknown', null, json(error), "'submitted'");
  }

  private changeOperation(operationId: string, state: OperationState, receipt: string | null, error: string | null, allowed: string): void {
    const update = this.db.prepare(`UPDATE operations SET state = ?, receipt_json = ?, error_json = ?, updated_at = ?
      WHERE operation_id = ? AND state IN (${allowed})`).run(state, receipt, error, now(), operationId);
    if (update.changes !== 1) throw new Error('invalid operation state transition');
  }

  getOperation(operationId: string): StoredOperation | undefined {
    const row = this.db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId);
    if (!row) return undefined;
    const state = string(row.state, 'operation state');
    if (state !== 'prepared' && state !== 'submitted' && state !== 'terminal' && state !== 'unknown') {
      throw new Error('invalid journal operation state');
    }
    if ((state === 'terminal') !== (row.receipt_json !== null) || (state === 'unknown') !== (row.error_json !== null)) {
      throw new Error('operation state is inconsistent with its receipt or error');
    }
    return {
      state, digest: hex(row.digest, 'operation digest'),
      ...(row.receipt_json === null ? {} : { receipt: parseJson(String(row.receipt_json)) }),
      ...(row.error_json === null ? {} : { error: parseJson(String(row.error_json)) }),
    };
  }

  hasUnknownOperations(): boolean {
    return this.db.prepare("SELECT 1 FROM operations WHERE state IN ('unknown', 'submitted') LIMIT 1").get() !== undefined;
  }

  getState(key: string): unknown {
    const row = this.db.prepare('SELECT value_json FROM host_state WHERE key = ?').get(key);
    return row ? parseJson(String(row.value_json)) : undefined;
  }

  setStates(entries: Readonly<Record<string, unknown>>): void {
    transaction(this.db, () => {
      for (const [key, value] of Object.entries(entries)) this.setState(key, value);
    });
  }

  private setState(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO host_state VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json, updated_at = excluded.updated_at`).run(key, json(value), now());
  }

  beginInstance(instanceId: string): number {
    return transaction(this.db, () => {
      const previous = this.getState('instanceId');
      if (previous === instanceId) throw new Error('host instance ID must never be reused');
      const events = this.listUnackedEvents();
      if (events.some(event => event.instanceId !== previous)) throw new Error('mixed journal instances');
      this.db.prepare('DELETE FROM unacked_events').run();
      let seq = 0;
      // Reissue durable, unacked observations in their original order under the new instance cursor.
      for (const event of events) this.insertEvent({ ...event, instanceId, seq: ++seq });
      this.db.prepare("UPDATE operations SET state = 'unknown', error_json = ?, updated_at = ? WHERE state = 'submitted'")
        .run(json({ code: 'outcome_unknown', message: 'host exited after submission' }), now());
      this.setState('instanceId', instanceId);
      this.setState('ackedSeq', 0);
      return seq;
    });
  }

  recordUnackedEvent(event: JournalEvent, state?: unknown): void {
    transaction(this.db, () => {
      if (this.getState('instanceId') !== event.instanceId) throw new HostError('fenced', 'journal instance changed');
      this.insertEvent(event);
      if (state !== undefined) this.setState('snapshot', state);
    });
  }

  private insertEvent(event: JournalEvent): void {
    this.db.prepare('INSERT INTO unacked_events VALUES (?, ?, ?, ?, ?)').run(
      counter(event.seq, 'seq', 1), string(event.instanceId, 'instanceId'), json(event.observation),
      Number(event.terminal), now(),
    );
  }

  ackUpTo(instanceId: string, seq: number): number {
    return transaction(this.db, () => {
      counter(seq, 'seq');
      if (this.getState('instanceId') !== instanceId) throw new HostError('fenced', 'journal instance changed');
      const ackedSeq = Math.max(counter(this.getState('ackedSeq'), 'ackedSeq'), seq);
      this.db.prepare('DELETE FROM unacked_events WHERE instance_id = ? AND seq <= ?').run(instanceId, ackedSeq);
      this.setState('ackedSeq', ackedSeq);
      return ackedSeq;
    });
  }

  listUnackedEvents(instanceId?: string, barrierSeq = Number.MAX_SAFE_INTEGER): JournalEvent[] {
    return this.db.prepare(`SELECT * FROM unacked_events WHERE (? IS NULL OR instance_id = ?) AND seq <= ? ORDER BY seq`)
      .all(instanceId ?? null, instanceId ?? null, barrierSeq).map(row => ({
        seq: counter(row.seq, 'seq', 1), instanceId: string(row.instance_id, 'instanceId'),
        observation: parseJson(String(row.payload_json)), terminal: row.is_terminal === 1,
      }));
  }

  hasUnackedTerminal(): boolean {
    return this.db.prepare('SELECT 1 FROM unacked_events WHERE is_terminal = 1 LIMIT 1').get() !== undefined;
  }
}
