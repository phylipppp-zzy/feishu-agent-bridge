import type { DatabaseSync } from 'node:sqlite';
import type { ChannelInputScope } from '../contracts.js';
import type { BindingRow, TargetRow } from './types.js';

export function ensureTaskTopicSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_bindings_v1 (
      task_id TEXT PRIMARY KEY,
      destination TEXT UNIQUE NOT NULL,
      root_generation INTEGER NOT NULL,
      owner_source TEXT NOT NULL,
      owner_subject TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      active_target_id TEXT,
      active_revision INTEGER NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_targets_v1 (
      task_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      host_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      access_mode TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY(task_id, target_id),
      UNIQUE(task_id, provider, host_id, service_id, native_session_id)
    );
    CREATE TABLE IF NOT EXISTS task_inbox_scope_v1 (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      destination TEXT NOT NULL,
      root_generation INTEGER NOT NULL,
      task_revision INTEGER NOT NULL,
      target_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      active_revision INTEGER NOT NULL,
      owner_source TEXT NOT NULL,
      owner_subject TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      result TEXT
    );
    CREATE TABLE IF NOT EXISTS task_inbox_payloads_v1 (
      event_id TEXT PRIMARY KEY,
      envelope TEXT NOT NULL,
      action TEXT NOT NULL,
      steer_turn_id TEXT,
      steer_connection_generation INTEGER,
      steer_control_generation INTEGER
    );
    CREATE INDEX IF NOT EXISTS task_targets_active_session_v1 ON task_targets_v1(session_id) WHERE state='active';
    CREATE INDEX IF NOT EXISTS task_inbox_received_task_v1 ON task_inbox_scope_v1(task_id) WHERE state='received';
    CREATE TABLE IF NOT EXISTS task_cursors_v1 (
      task_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      cursor TEXT NOT NULL,
      binding_scope TEXT NOT NULL,
      PRIMARY KEY(task_id, target_id, target_generation)
    );
    CREATE TABLE IF NOT EXISTS task_deliveries_v1 (
      delivery_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      target_id TEXT,
      state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_stream_cards_v1 (
      task_id TEXT NOT NULL,
      destination TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      turn_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      card_id TEXT,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      final INTEGER NOT NULL,
      latest_sequence INTEGER NOT NULL,
      PRIMARY KEY(task_id, target_id, target_generation, session_id, turn_key)
    );
    CREATE TABLE IF NOT EXISTS task_known_messages_v1 (
      task_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY(task_id, target_id, target_generation, session_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS task_baseline_messages_v1 (
      task_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY(task_id, target_id, target_generation, session_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS task_interaction_cards_v1 (
      task_id TEXT NOT NULL,
      destination TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      active_revision INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      PRIMARY KEY(task_id, target_id, target_generation, session_id, interaction_id)
    );
  `);
}

export function runTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failure if already aborted
    }
    throw error;
  }
}

export function getBindingRow(db: DatabaseSync, taskId: string): BindingRow | undefined {
  return db
    .prepare('SELECT * FROM task_bindings_v1 WHERE task_id = ?')
    .get(taskId) as BindingRow | undefined;
}

export function getBindingRowByDestination(db: DatabaseSync, destination: string): BindingRow | undefined {
  return db
    .prepare('SELECT * FROM task_bindings_v1 WHERE destination = ?')
    .get(destination) as BindingRow | undefined;
}

export function taskInputScope(binding: BindingRow, target: TargetRow): ChannelInputScope {
  return {
    destination:binding.destination,
    bindingScope:JSON.stringify([binding.task_id,binding.root_generation,target.target_id,target.target_generation]),
    ownerSource:binding.owner_source,
    ownerSubject:binding.owner_subject,
  };
}

export function firstMountedTargets(db: DatabaseSync, taskId: string): TargetRow[] {
  return db.prepare("SELECT * FROM task_targets_v1 WHERE task_id = ? AND state = 'active' ORDER BY rowid LIMIT 2")
    .all(taskId) as unknown as TargetRow[];
}

export function getTargetRow(db: DatabaseSync, taskId: string, targetId: string): TargetRow | undefined {
  return db
    .prepare('SELECT * FROM task_targets_v1 WHERE task_id = ? AND target_id = ?')
    .get(taskId, targetId) as TargetRow | undefined;
}
