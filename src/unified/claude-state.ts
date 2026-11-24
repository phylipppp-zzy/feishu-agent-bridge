import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contractError } from './errors.js';

type Entry = { origin: 'bridge_sdk' };
type MessageLink = { id: string; generation: number; turnId?: string };
interface State { version: 1; hostId: string; serviceId: string; generation: number; sessions: Record<string, Entry> }
function validMessageLink(entry: unknown): entry is MessageLink {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const link = entry as Partial<MessageLink>;
  return typeof link.id === 'string' && !!link.id &&
    Number.isSafeInteger(link.generation) && link.generation! > 0 &&
    (link.turnId === undefined || typeof link.turnId === 'string' && !!link.turnId);
}
/** Single-process registry. The embedding service must give this adapter exclusive stateDir ownership. */
export class ClaudeState {
  private readonly path: string; private readonly aliasPath:string; private readonly hostId:string; private readonly serviceId:string;
  private aliases: Record<string, Record<string, MessageLink>> = {};
  private state: State;
  constructor(dir: string, hostId: string, serviceId: string) {
    if (!dir) throw contractError('invalid_request', 'Claude state directory required'); mkdirSync(dir, { recursive: true, mode: 0o700 }); this.path = join(dir, 'claude-owned.json'); this.aliasPath=join(dir,'claude-message-aliases-v1.json'); this.hostId=hostId; this.serviceId=serviceId;
    try { const value = JSON.parse(readFileSync(this.path, 'utf8')) as State; if (value.version !== 1 || value.hostId !== hostId || value.serviceId !== serviceId || !Number.isSafeInteger(value.generation) || value.generation < 0 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) || Object.values(value.sessions).some(entry => !entry || entry.origin !== 'bridge_sdk')) throw Error('invalid state'); this.state = value; }
    catch (e: any) { if (e?.code !== 'ENOENT') throw contractError('temporarily_unavailable', 'Claude ownership registry invalid or inaccessible'); this.state = { version: 1, hostId, serviceId, generation: 0, sessions: {} }; }
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
  private save(next: State): void { const tmp = `${this.path}.${randomUUID()}.tmp`; try { writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(tmp, this.path); this.state = next; } catch { throw contractError('temporarily_unavailable', 'Claude ownership registry write failed'); } }
  get(id: string): Entry | undefined { return Object.hasOwn(this.state.sessions, id) ? this.state.sessions[id] : undefined; }
  put(id: string, entry: Entry): void { this.save({ ...this.state, sessions: { ...this.state.sessions, [id]: entry } }); }
  linkMessage(sessionId: string, outer: string, inner: string, generation: number, turnId?: string): void {
    const link = { id: inner, generation, ...(turnId === undefined ? {} : { turnId }) };
    if (!this.get(sessionId) || !outer || !validMessageLink(link)) throw contractError('invalid_request');
    const previous = this.messageLink(sessionId, outer);
    if (previous && (previous.id !== inner || previous.turnId && turnId && previous.turnId !== turnId)) {
      throw contractError('idempotency_conflict', 'Claude message identity changed');
    }
    if (previous && (previous.turnId || !turnId)) return;
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
    const aliases = this.get(sessionId) && this.aliases[sessionId];
    return aliases && Object.hasOwn(aliases, outer) ? aliases[outer] : undefined;
  }
  messageAlias(sessionId: string, outer: string): string | undefined { return this.messageLink(sessionId, outer)?.id; }
  nextGeneration(): number { const generation = this.state.generation + 1; this.save({ ...this.state, generation }); return generation; }
}
