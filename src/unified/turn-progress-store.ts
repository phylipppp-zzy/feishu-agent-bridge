import type { DatabaseSync } from 'node:sqlite';
import type { Event, Turn } from './contracts.js';
import { isTerminalTool, isTerminalTurn, nativeTimestamp, readToolProgress, type ToolProgress } from './tool-progress.js';

const RECENT_TURNS = 32;
const CALLS_PER_TURN = 256;

export interface TurnTiming {
  turnId: string;
  startedMs: number | null;
  endedMs: number | null;
  liveStartSequence: number | null;
  liveEndSequence: number | null;
}

export interface TurnToolCounts {
  turnId: string;
  totalTools: number;
  failedTools: number;
}

export interface TurnProgressSnapshot {
  timing: TurnTiming[];
  tools: Array<ToolProgress & { sequence: number; connectionGeneration: number }>;
  toolCounts?: TurnToolCounts[];
}

interface TimingRow {
  generation: number;
  started_ms: number | null;
  native_start: number;
  ended_ms: number | null;
  live_start: number | null;
  live_end: number | null;
  turn_id: string;
}

export const turnProgressSchema = `
  CREATE TABLE IF NOT EXISTS turn_progress_timing (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn_id TEXT NOT NULL,
    generation INTEGER NOT NULL, started_ms INTEGER, native_start INTEGER NOT NULL, ended_ms INTEGER,
    live_start INTEGER, live_end INTEGER, sequence INTEGER NOT NULL, terminal INTEGER NOT NULL,
    PRIMARY KEY(session_id,turn_id)
  );
  CREATE INDEX IF NOT EXISTS turn_progress_timing_recent ON turn_progress_timing(session_id,terminal,sequence DESC);
  CREATE TABLE IF NOT EXISTS turn_progress_calls (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, generation INTEGER NOT NULL,
    turn_id TEXT NOT NULL, call_id TEXT NOT NULL, phase TEXT NOT NULL, tool TEXT NOT NULL,
    summary TEXT NOT NULL, sequence INTEGER NOT NULL, first_sequence INTEGER NOT NULL,
    PRIMARY KEY(session_id,generation,turn_id,call_id)
  );
  CREATE INDEX IF NOT EXISTS turn_progress_calls_recent ON turn_progress_calls(session_id,turn_id,first_sequence DESC);
  CREATE TABLE IF NOT EXISTS turn_progress_clipped_calls (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn_id TEXT NOT NULL,
    generation INTEGER NOT NULL, call_id TEXT NOT NULL, phase TEXT NOT NULL, first_sequence INTEGER NOT NULL,
    PRIMARY KEY(session_id,turn_id,generation,call_id)
  );
`;

export function timestampMs(value: unknown): number | null {
  const iso = nativeTimestamp(value);
  return iso === null ? null : Date.parse(iso);
}

export class TurnProgressStore {
  constructor(private readonly db: DatabaseSync) {}

  recordTurn(turn: Turn, generation: number, sequence: number, observedAt?: number, evidenceOnly = false): boolean {
    if (turn.status === 'queued') return false;
    const key = [turn.sessionId, turn.turnId] as const;
    const row = this.db.prepare('SELECT * FROM turn_progress_timing WHERE session_id=? AND turn_id=?').get(...key) as TimingRow | undefined;
    const terminal = isTerminalTurn(turn.status);
    const priorStart = row?.generation === generation ? row.live_start : null;
    const priorEnd = row?.generation === generation ? row.live_end : null;
    const live = observedAt !== undefined;
    const liveStart = priorStart ?? (!terminal && live ? sequence : null);
    const liveEnd = terminal && liveStart !== null ? priorEnd ?? (live ? sequence : null) : null;
    if (evidenceOnly && liveStart === priorStart && liveEnd === priorEnd) return false;
    const nativeStart = timestampMs(turn.startedAt);
    const nativeEnd = terminal ? timestampMs(turn.endedAt) : null;
    const start = row?.native_start ? row.started_ms : nativeStart ?? row?.started_ms ??
      (turn.status === 'running' ? observedAt ?? null : null);
    const end = terminal ? nativeEnd ?? row?.ended_ms ?? observedAt ?? null : null;
    this.db.prepare(`INSERT INTO turn_progress_timing VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,turn_id) DO UPDATE SET generation=excluded.generation,
      started_ms=excluded.started_ms,native_start=excluded.native_start,ended_ms=excluded.ended_ms,
      live_start=excluded.live_start,live_end=excluded.live_end,sequence=excluded.sequence,terminal=excluded.terminal`)
      .run(...key, generation, start, Number(nativeStart !== null || !!row?.native_start),
        end, liveStart, liveEnd, sequence, Number(terminal));
    // Disconnected providers can leave old running rows without a terminal observation.
    const pruneTiming = this.db.prepare(`DELETE FROM turn_progress_timing WHERE session_id=? AND turn_id IN (
      SELECT turn_id FROM turn_progress_timing WHERE session_id=? AND terminal=? ORDER BY sequence DESC LIMIT -1 OFFSET ?)`);
    for (const state of [0, 1]) pruneTiming.run(turn.sessionId, turn.sessionId, state, RECENT_TURNS);
    this.pruneCalls(turn.sessionId);
    return true;
  }

  acceptsTool(sessionId: string, generation: number, data: ToolProgress): boolean {
    const key = [sessionId, data.turnId, generation, data.callId] as const;
    const prior = this.db.prepare(`SELECT phase,tool,summary FROM turn_progress_calls
      WHERE session_id=? AND turn_id=? AND generation=? AND call_id=?
      UNION ALL SELECT phase,NULL,NULL FROM turn_progress_clipped_calls
      WHERE session_id=? AND turn_id=? AND generation=? AND call_id=?`)
      .get(...key, ...key) as { phase: ToolProgress['phase']; tool: string | null; summary: string | null } | undefined;
    if (prior && (isTerminalTool(prior.phase) && prior.phase !== data.phase ||
      prior.phase === 'running' && data.phase === 'pending' ||
      prior.tool === null && prior.phase === data.phase)) return false;
    const turn = this.db.prepare("SELECT json_extract(value,'$.status') AS status FROM turns WHERE id=? AND session_id=?")
      .get(data.turnId, sessionId) as { status: Turn['status'] } | undefined;
    if (isTerminalTurn(turn?.status) && !isTerminalTool(data.phase)) return false;
    return !prior || prior.phase !== data.phase || prior.tool !== data.tool || prior.summary !== data.summary;
  }

  recordTool(event: Event, generation: number): void {
    const data = readToolProgress(event.data);
    if (!data) return;
    const key = [event.sessionId, data.turnId, generation, data.callId] as const;
    const clipped = this.db.prepare(`DELETE FROM turn_progress_clipped_calls
      WHERE session_id=? AND turn_id=? AND generation=? AND call_id=? RETURNING first_sequence`).get(...key) as
      { first_sequence: number } | undefined;
    this.db.prepare(`INSERT INTO turn_progress_calls VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,generation,turn_id,call_id) DO UPDATE
      SET phase=excluded.phase,tool=excluded.tool,summary=excluded.summary,sequence=excluded.sequence`)
      .run(event.sessionId, generation, data.turnId, data.callId, data.phase, data.tool, data.summary,
        event.sequence, clipped?.first_sequence ?? event.sequence);
    this.clipCalls(event.sessionId, data.turnId);
    this.pruneCalls(event.sessionId);
  }

  private clipCalls(sessionId: string, turnId: string): void {
    // Active calls take precedence even if the active set alone exceeds the detail limit.
    const overflow = this.db.prepare(`SELECT rowid FROM turn_progress_calls
      WHERE session_id=? AND turn_id=? AND phase<>'running' ORDER BY first_sequence DESC LIMIT -1
      OFFSET MAX(0, ? - (SELECT COUNT(*) FROM turn_progress_calls WHERE session_id=? AND turn_id=? AND phase='running'))`)
      .all(sessionId, turnId, CALLS_PER_TURN, sessionId, turnId) as { rowid: number }[];
    if (!overflow.length) return;
    const archive = this.db.prepare(`INSERT INTO turn_progress_clipped_calls
      SELECT session_id,turn_id,generation,call_id,phase,first_sequence FROM turn_progress_calls WHERE rowid=?`);
    const remove = this.db.prepare('DELETE FROM turn_progress_calls WHERE rowid=?');
    for (const { rowid } of overflow) {
      archive.run(rowid);
      remove.run(rowid);
    }
  }

  private pruneCalls(sessionId: string): void {
    const pruned = this.db.prepare(`DELETE FROM turn_progress_calls WHERE session_id=? AND turn_id IN (
      SELECT turn_id FROM turn_progress_calls WHERE session_id=? AND turn_id NOT IN (
        SELECT turn_id FROM turn_progress_timing WHERE session_id=? AND terminal=0
      ) GROUP BY turn_id ORDER BY MAX(sequence) DESC LIMIT -1 OFFSET ?) RETURNING turn_id`)
      .all(sessionId, sessionId, sessionId, RECENT_TURNS) as { turn_id: string }[];
    if (!pruned.length) return;
    const remove = this.db.prepare('DELETE FROM turn_progress_clipped_calls WHERE session_id=? AND turn_id=?');
    for (const turnId of new Set(pruned.map(row => row.turn_id))) remove.run(sessionId, turnId);
  }

  snapshot(sessionId: string): TurnProgressSnapshot {
    const timing = this.db.prepare('SELECT * FROM turn_progress_timing WHERE session_id=?').all(sessionId) as unknown as TimingRow[];
    const tools = this.db.prepare(`SELECT turn_id as turnId,call_id as callId,phase,tool,summary,sequence,
      generation as connectionGeneration FROM turn_progress_calls WHERE session_id=? ORDER BY first_sequence`)
      .all(sessionId) as unknown as TurnProgressSnapshot['tools'];
    const toolCounts = this.db.prepare(`SELECT turn_id AS turnId, SUM(total) AS totalTools, SUM(failed) AS failedTools FROM (
      SELECT turn_id, COUNT(*) AS total, SUM(phase='failed') AS failed
      FROM turn_progress_calls WHERE session_id=? GROUP BY turn_id
      UNION ALL
      SELECT turn_id, COUNT(*), SUM(phase='failed')
      FROM turn_progress_clipped_calls WHERE session_id=? GROUP BY turn_id
    ) GROUP BY turn_id`).all(sessionId, sessionId) as unknown as TurnToolCounts[];
    return { timing: timing.map(row => ({
      turnId: row.turn_id, startedMs: row.started_ms, endedMs: row.ended_ms,
      liveStartSequence: row.live_start, liveEndSequence: row.live_end,
    })), tools, toolCounts: toolCounts.map(row => ({ ...row })) };
  }
}
