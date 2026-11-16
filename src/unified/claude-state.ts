import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contractError } from './errors.js';

type Entry = { origin: 'bridge_sdk' };
interface State { version: 1; hostId: string; serviceId: string; generation: number; sessions: Record<string, Entry> }
/** Single-process registry. The embedding service must give this adapter exclusive stateDir ownership. */
export class ClaudeState {
  private readonly path: string;
  private state: State;
  constructor(dir: string, hostId: string, serviceId: string) {
    if (!dir) throw contractError('invalid_request', 'Claude state directory required'); mkdirSync(dir, { recursive: true, mode: 0o700 }); this.path = join(dir, 'claude-owned.json');
    try { const value = JSON.parse(readFileSync(this.path, 'utf8')) as State; if (value.version !== 1 || value.hostId !== hostId || value.serviceId !== serviceId || !Number.isSafeInteger(value.generation) || value.generation < 0 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) || Object.values(value.sessions).some(entry => !entry || entry.origin !== 'bridge_sdk')) throw Error('invalid state'); this.state = value; }
    catch (e: any) { if (e?.code !== 'ENOENT') throw contractError('temporarily_unavailable', 'Claude ownership registry invalid or inaccessible'); this.state = { version: 1, hostId, serviceId, generation: 0, sessions: {} }; }
  }
  private save(next: State): void { const tmp = `${this.path}.${randomUUID()}.tmp`; try { writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(tmp, this.path); this.state = next; } catch { throw contractError('temporarily_unavailable', 'Claude ownership registry write failed'); } }
  get(id: string): Entry | undefined { return Object.hasOwn(this.state.sessions, id) ? this.state.sessions[id] : undefined; }
  put(id: string, entry: Entry): void { this.save({ ...this.state, sessions: { ...this.state.sessions, [id]: entry } }); }
  nextGeneration(): number { const generation = this.state.generation + 1; this.save({ ...this.state, generation }); return generation; }
}
