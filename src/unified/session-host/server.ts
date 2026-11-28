import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import {
  checkPrivateSocket, chunkPayload, commandDigest, counter, handshakeMac, hex, HostError, joinChunks, json,
  MAX_PAYLOAD_BYTES, nonce, object, parseJson, parseRef, privateDirectory, RpcWire, runtimePaths, sameRef,
  snapshotDigest, string, verifyMac, type Challenge, type Fields, type HostRef, type RpcId, type RpcMessage, type SnapshotPage,
} from './protocol.js';
import { SessionHostJournal, type JournalEvent, type StoredOperation } from './journal.js';
import type { InstanceState } from './registry.js';

export interface RunnerState {
  activeTurn: boolean;
  pendingInteraction: unknown;
  pendingWakeup: boolean;
  pendingSubagent: boolean;
  residual: 'none' | 'running' | 'unknown';
  data: unknown;
}

export const idleRunnerState: Readonly<RunnerState> = Object.freeze({
  activeTurn: false, pendingInteraction: null, pendingWakeup: false,
  pendingSubagent: false, residual: 'none', data: null,
});

export function parseRunnerState(value: unknown): RunnerState {
  const state = object(value);
  if (typeof state.activeTurn !== 'boolean' || typeof state.pendingWakeup !== 'boolean'
      || typeof state.pendingSubagent !== 'boolean' || !('pendingInteraction' in state) || !('data' in state)
      || (state.residual !== 'none' && state.residual !== 'running' && state.residual !== 'unknown')) {
    throw new HostError('invalid_request', 'invalid runner state');
  }
  return {
    activeTurn: state.activeTurn, pendingInteraction: state.pendingInteraction, pendingWakeup: state.pendingWakeup,
    pendingSubagent: state.pendingSubagent, residual: state.residual, data: state.data,
  };
}

export interface RunnerCommand {
  operationId: string;
  kind: string;
  args: unknown;
  attachment: Uint8Array | null;
}
export interface RunnerContext {
  getState(): RunnerState;
  emit(observation: unknown, options?: { durable?: boolean; terminal?: boolean; state?: RunnerState }): number;
  setState(state: RunnerState): void;
  bindNativeSession(nativeSessionId: string): HostRef;
  reconcileOperation(operationId: string, receipt: unknown): void;
}

export interface SessionHostRunner {
  readonly capabilities: unknown;
  start?(context: RunnerContext): void | Promise<void>;
  validateCommand?(command: RunnerCommand): void;
  execute(command: RunnerCommand, context: RunnerContext): unknown | Promise<unknown>;
  stop?(): void | Promise<void>;
}

export interface SessionHostServerOptions {
  runtimeDir: string;
  key: string;
  ref: HostRef | null;
  instanceId: string;
  releaseDir: string;
  secret: Uint8Array;
  journal: SessionHostJournal;
  runner: SessionHostRunner;
  maxRingEntries?: number;
  maxRingBytes?: number;
  snapshotPageBytes?: number;
  heartbeatMs?: number;
  idleTimeoutMs?: number;
  bindNativeSession?: (nativeSessionId: string) => HostRef;
  onState?: (state: InstanceState) => void;
  isReleaseRetired?: () => boolean;
  onError?: (error: unknown) => void;
}

interface RingEntry {
  seq: number;
  ref: HostRef | null;
  observation: unknown;
  bytes: number;
}
interface Snapshot {
  pages: SnapshotPage[];
  nextPage: number;
  delivered: boolean;
}
interface Peer {
  socket: Socket;
  wire: RpcWire;
  handshakeTimer: NodeJS.Timeout;
  challenged: boolean;
  challenge?: Challenge;
  revoked: boolean;
  queued: number;
}
interface Lease {
  token: string;
  peer: Peer;
  lastPing: number;
  snapshot?: Snapshot;
  deliveredSeq: number;
}

const MAX_SNAPSHOT_PAGE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_CHUNK_ITEM_BYTES = 270 * 1024;

export class SessionHostServer {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: unknown) => void;
  private readonly socketPath: string;
  private readonly server: Server;
  private readonly peers = new Set<Peer>();
  private readonly seenNonces = new Set<string>();
  private readonly ring: RingEntry[] = [];
  private ringBytes = 0;
  private readonly maxRingEntries: number;
  private readonly maxRingBytes: number;
  private readonly snapshotPageBytes: number;
  private readonly heartbeatMs: number;
  private readonly idleTimeoutMs: number;
  private seq: number;
  private ref: HostRef | null;
  private state: RunnerState;
  private connectionGeneration: number;
  private controlGeneration: number;
  private currentBridgeEpoch: number;
  private currentClientId: string | null;
  private lease: Lease | undefined;
  private lastWork = performance.now();
  private commandInFlight = false;
  private retired = false;
  private closing = false;
  private timer: NodeJS.Timeout | undefined;
  private serial: Promise<void> = Promise.resolve();
  private readonly context: RunnerContext;

  constructor(private readonly options: SessionHostServerOptions) {
    this.socketPath = runtimePaths(options.runtimeDir, options.key).socket;
    if (options.secret.byteLength !== 32) throw new HostError('invalid_request', 'invalid handshake key length');
    this.ref = options.ref;
    this.maxRingEntries = counter(options.maxRingEntries ?? 4096, 'maxRingEntries', 1);
    this.maxRingBytes = counter(options.maxRingBytes ?? 8 * 1024 * 1024, 'maxRingBytes', 1);
    this.snapshotPageBytes = Math.min(MAX_SNAPSHOT_PAGE_BYTES, counter(options.snapshotPageBytes ?? MAX_SNAPSHOT_PAGE_BYTES, 'snapshotPageBytes', 1));
    this.heartbeatMs = counter(options.heartbeatMs ?? 5000, 'heartbeatMs', 1);
    this.idleTimeoutMs = counter(options.idleTimeoutMs ?? 30 * 60 * 1000, 'idleTimeoutMs', 1);
    const journal = options.journal;
    const previousState = journal.getState('snapshot');
    this.state = previousState === undefined ? { ...idleRunnerState } : parseRunnerState(previousState);
    this.connectionGeneration = counter(journal.getState('connectionGeneration') ?? 0, 'connectionGeneration');
    this.controlGeneration = counter(journal.getState('controlGeneration') ?? 0, 'controlGeneration');
    this.currentBridgeEpoch = counter(journal.getState('bridgeEpoch') ?? 0, 'bridgeEpoch');
    const persistedClient = journal.getState('clientId');
    this.currentClientId = this.currentBridgeEpoch === 0 ? null : string(persistedClient, 'clientId');
    this.seq = journal.beginInstance(options.instanceId);
    this.closed = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    this.context = {
      getState: () => parseRunnerState(parseJson(json(this.state))),
      emit: (observation, settings) => this.publish(observation, settings),
      setState: state => this.setState(state),
      bindNativeSession: nativeId => this.bindNativeSession(nativeId),
      reconcileOperation: (operationId, receipt) => {
        if (this.closing) throw new HostError('temporarily_unavailable', 'host is closing');
        if (options.journal.getOperation(operationId)?.state !== 'unknown') {
          throw new HostError('invalid_request', 'only unknown operations can be reconciled');
        }
        options.journal.markOperationTerminal(operationId, receipt);
        this.lastWork = performance.now();
      },
    };
    this.server = createServer(socket => this.accept(socket));
  }

  async listen(): Promise<void> {
    privateDirectory(this.options.runtimeDir, true);
    await this.options.runner.start?.(this.context);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.server.on('error', error => {
      this.report(error);
      void this.close();
    });
    chmodSync(this.socketPath, 0o600);
    checkPrivateSocket(this.socketPath);
    let pending = false;
    this.timer = setInterval(() => {
      if (this.closing) return;
      const lease = this.lease;
      if (lease && performance.now() - lease.lastPing >= this.heartbeatMs * 3) {
        try {
          this.release(lease, true);
        } catch (error) {
          this.report(error);
        }
      }
      if (pending) return;
      pending = true;
      this.enqueue(() => {
        try {
          const now = performance.now();
          if (this.canRetire() && (this.isRetired() || now - this.lastWork >= this.idleTimeoutMs)) {
            this.startClose();
          }
        } finally {
          pending = false;
        }
      });
    }, Math.min(this.heartbeatMs, this.idleTimeoutMs, 1000));
    this.timer.unref();
  }

  publish(observation: unknown, options: { durable?: boolean; terminal?: boolean; state?: RunnerState } = {}): number {
    if (this.closing) throw new HostError('temporarily_unavailable', 'host is closing');
    const encoded = json(observation);
    if (Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES - 64 * 1024) {
      throw new HostError('invalid_request', 'event payload too large');
    }
    const immutable = parseJson(encoded);
    const seq = counter(this.seq + 1, 'seq', 1);
    const state = options.state === undefined ? undefined : this.normalizeState(options.state);
    if (options.terminal || options.durable !== false) {
      this.options.journal.recordUnackedEvent({
        seq, instanceId: this.options.instanceId, observation: immutable, terminal: options.terminal === true,
      }, state);
    } else if (state) {
      this.options.journal.setStates({ snapshot: state });
    }
    if (state) this.state = state;
    this.seq = seq;
    this.lastWork = performance.now();
    const record = { seq, ref: this.ref, observation: immutable };
    const bytes = Buffer.byteLength(json(record));
    const entry = { ...record, bytes };
    this.ring.push(entry);
    this.ringBytes += bytes;
    while (this.ring.length > this.maxRingEntries || this.ringBytes > this.maxRingBytes) {
      this.ringBytes -= this.ring.shift()!.bytes;
    }
    if (this.lease) this.sendEvent(this.lease, entry);
    return seq;
  }

  markReleaseRetired(): void {
    this.retired = true;
    this.enqueue(() => this.retireIfReady());
  }

  canRetire(): boolean {
    return this.retirementBlocker() === null;
  }

  close(): Promise<void> {
    this.enqueue(() => this.startClose());
    return this.closed;
  }

  private setState(state: RunnerState): void {
    if (this.closing) throw new HostError('temporarily_unavailable', 'host is closing');
    const immutable = this.normalizeState(state);
    this.options.journal.setStates({ snapshot: immutable });
    this.state = immutable;
    this.lastWork = performance.now();
  }

  private normalizeState(state: RunnerState): RunnerState {
    const immutable = parseRunnerState(parseJson(json(state)));
    if (Buffer.byteLength(json(immutable)) > MAX_PAYLOAD_BYTES - 64 * 1024) {
      throw new HostError('invalid_request', 'runner snapshot state too large');
    }
    return immutable;
  }

  private bindNativeSession(nativeId: string): HostRef {
    if (this.closing) throw new HostError('temporarily_unavailable', 'host is closing');
    string(nativeId, 'nativeSessionId');
    if (this.ref?.[3] === nativeId) return this.ref;
    if (this.ref || !this.options.bindNativeSession) throw new HostError('identity_mismatch', 'cannot change bound native session');
    this.ref = parseRef(this.options.bindNativeSession(nativeId));
    this.publish({ type: 'session_bound', ref: this.ref });
    return this.ref;
  }

  private retirementBlocker(): string | null {
    if (this.commandInFlight) return 'in-flight command';
    if (this.state.activeTurn) return 'active turn';
    if (this.state.pendingInteraction !== null) return 'pending interaction';
    if (this.state.pendingWakeup) return 'pending wakeup';
    if (this.state.pendingSubagent) return 'pending subagent';
    if (this.state.residual !== 'none') return 'residual ' + this.state.residual;
    if (this.options.journal.hasUnknownOperations()) return 'unknown operation outcome';
    if (this.options.journal.hasUnackedTerminal()) return 'unacked terminal state';
    return null;
  }

  private isRetired(): boolean {
    return this.retired || this.options.isReleaseRetired?.() === true;
  }

  private retireIfReady(): void {
    if (!this.closing && this.isRetired() && this.canRetire()) this.startClose();
  }

  private enqueue(action: () => void | Promise<void>): void {
    this.serial = this.serial.then(action).catch(error => this.report(error));
  }

  private report(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else console.error('Session host internal failure:', error);
  }

  private accept(socket: Socket): void {
    socket.on('error', error => {
      if ('code' in error && (error.code === 'EPIPE' || error.code === 'ECONNRESET')) return;
      this.report(error);
    });
    if (this.closing || this.peers.size >= 64) {
      socket.destroy();
      return;
    }
    const handshakeTimer = setTimeout(() => socket.destroy(), 10_000);
    handshakeTimer.unref();
    const peer: Peer = {
      socket, handshakeTimer, challenged: false, revoked: false, queued: 0,
      wire: new RpcWire(socket, message => this.receive(peer, message), error => {
        this.sendError(peer, null, error);
        peer.revoked = true;
        socket.end();
      }, () => this.lease?.peer === peer),
    };
    this.peers.add(peer);
    socket.once('close', () => {
      clearTimeout(handshakeTimer);
      this.peers.delete(peer);
      this.enqueue(() => {
        if (this.lease?.peer === peer) this.release(this.lease, false);
      });
    });
  }

  private receive(peer: Peer, message: RpcMessage): void {
    if (!('method' in message) || message.id === undefined) {
      this.sendError(peer, null, new HostError('invalid_request', 'expected a request'));
      return;
    }
    const { id, method, params } = message;
    if (peer.revoked) {
      this.sendError(peer, id, new HostError('fenced'));
      return;
    }
    if (method === 'hello') {
      this.handle(peer, id, () => this.hello(peer, params));
      return;
    }
    if (method === 'ping') {
      this.handle(peer, id, () => {
        this.requireLease(peer, params).lastPing = performance.now();
        return { ok: true };
      });
      return;
    }
    if (method === 'shutdown' && this.commandInFlight) {
      this.handle(peer, id, () => {
        this.requireLease(peer, params);
        this.validateShutdown(params);
        return { outcome: 'busy', reason: 'in-flight command' };
      });
      return;
    }
    if (peer.queued >= 128) {
      this.sendError(peer, id, new HostError('busy', 'too many queued requests'));
      return;
    }
    peer.queued++;
    this.enqueue(async () => {
      try {
        if (peer.revoked || peer.socket.destroyed) throw new HostError('fenced');
        if (this.closing) throw new HostError('temporarily_unavailable', 'host is closing');
        if (method === 'attach') {
          this.attach(peer, id, params);
        } else {
          await this.attachedRequest(peer, id, method, params);
        }
      } catch (error) {
        this.sendError(peer, id, error);
      } finally {
        peer.queued--;
      }
    });
  }

  private handle(peer: Peer, id: RpcId, handler: () => unknown): void {
    try {
      this.reply(peer, id, handler());
    } catch (error) {
      this.sendError(peer, id, error);
    }
  }

  private hello(peer: Peer, p: Fields): unknown {
    if (this.closing) throw new HostError('temporarily_unavailable');
    if (peer.challenged) throw new HostError('unauthorized', 'one challenge per connection');
    peer.challenged = true;
    if (!Array.isArray(p.versions) || !p.versions.includes(1)) throw new HostError('version_mismatch');
    if (p.key !== this.options.key) throw new HostError('identity_mismatch');
    const clientNonce = hex(p.clientNonce, 'clientNonce');
    if (this.seenNonces.has(clientNonce)) throw new HostError('unauthorized', 'reused client nonce');
    const challenge: Challenge = {
      key: this.options.key, instanceId: this.options.instanceId, clientId: string(p.clientId, 'clientId'),
      bridgeEpoch: counter(p.bridgeEpoch, 'bridgeEpoch', 1), clientNonce, hostNonce: nonce(),
    };
    this.seenNonces.add(clientNonce);
    peer.challenge = challenge;
    return {
      version: 1, instanceId: this.options.instanceId, ref: this.ref, releaseDir: this.options.releaseDir,
      hostNonce: challenge.hostNonce, hostMac: handshakeMac(this.options.secret, 'host', challenge),
      capabilities: this.options.runner.capabilities, state: { activeTurn: this.state.activeTurn, residual: this.state.residual },
    };
  }

  private attach(peer: Peer, id: RpcId, p: Fields): void {
    const challenge = peer.challenge;
    delete peer.challenge;
    if (!challenge || p.instanceId !== challenge.instanceId || p.clientId !== challenge.clientId
        || p.bridgeEpoch !== challenge.bridgeEpoch
        || !verifyMac(handshakeMac(this.options.secret, 'client', challenge), p.clientMac)) {
      throw new HostError('unauthorized', 'client challenge verification failed');
    }
    if (!sameRef(p.expectedRef === null ? null : parseRef(p.expectedRef), this.ref)) {
      throw new HostError('identity_mismatch', 'expected ref differs from host ref');
    }
    const { bridgeEpoch, clientId } = challenge;
    if (bridgeEpoch < this.currentBridgeEpoch || (bridgeEpoch === this.currentBridgeEpoch && clientId !== this.currentClientId)) {
      throw new HostError('fenced', 'bridge epoch belongs to a newer or different bridge');
    }
    const lastSeq = p.lastSeq === null ? null : counter(p.lastSeq, 'lastSeq');
    const lastInstanceId = p.lastInstanceId === undefined ? challenge.instanceId : string(p.lastInstanceId, 'lastInstanceId');
    const barrierSeq = this.seq;
    const firstSeq = this.ring[0]?.seq ?? barrierSeq + 1;
    const replay = lastSeq !== null && lastSeq >= firstSeq - 1 && lastSeq <= barrierSeq
      && lastInstanceId === this.options.instanceId;
    const snapshot = replay ? undefined : this.makeSnapshot(barrierSeq);
    const connectionGeneration = counter(this.connectionGeneration + 1, 'connectionGeneration');
    const controlGeneration = counter(this.controlGeneration + 1, 'controlGeneration');
    this.options.journal.setStates({ bridgeEpoch, clientId, connectionGeneration, controlGeneration });
    this.currentBridgeEpoch = bridgeEpoch;
    this.currentClientId = clientId;
    this.connectionGeneration = connectionGeneration;
    this.controlGeneration = controlGeneration;
    const previous = this.lease;
    const lease: Lease = {
      token: randomUUID(), peer, lastPing: performance.now(), deliveredSeq: replay ? lastSeq : 0,
      ...(snapshot ? { snapshot } : {}),
    };
    this.lease = lease;
    clearTimeout(peer.handshakeTimer);
    if (previous) this.revoke(previous.peer);
    this.options.onState?.('attached');
    this.reply(peer, id, {
      lease: lease.token, connectionGeneration, controlGeneration, firstSeq, barrierSeq,
      mode: replay ? 'replay' : 'snapshot',
    });
    if (replay) {
      for (const entry of this.ring) {
        if (entry.seq > lastSeq && !this.sendEvent(lease, entry)) break;
      }
    }
  }

  private requireLease(peer: Peer, p: Fields): Lease {
    if (peer.revoked) throw new HostError('fenced');
    const lease = this.lease;
    if (lease?.peer === peer) {
      if (p.lease !== lease.token) throw new HostError('fenced', 'invalid lease');
      return lease;
    }
    if (peer.challenged && !peer.challenge && typeof p.lease === 'string') throw new HostError('fenced');
    throw new HostError('unauthorized', 'attach required');
  }

  private async attachedRequest(peer: Peer, id: RpcId, method: string, p: Fields): Promise<void> {
    const lease = this.requireLease(peer, p);
    switch (method) {
      case 'command':
        this.reply(peer, id, await this.command(p));
        break;
      case 'receipt':
        this.reply(peer, id, this.options.journal.getOperation(string(p.operationId, 'operationId')) ?? { state: 'absent' });
        break;
      case 'ack': {
        const seq = counter(p.seq, 'seq');
        if (seq > lease.deliveredSeq || (lease.snapshot && !lease.snapshot.delivered)) {
          throw new HostError('snapshot_required', 'cannot acknowledge an undelivered cursor');
        }
        const ackedSeq = this.options.journal.ackUpTo(this.options.instanceId, seq);
        if (lease.snapshot && seq >= lease.snapshot.pages[0]!.barrierSeq) delete lease.snapshot;
        this.reply(peer, id, { ackedSeq });
        this.retireIfReady();
        break;
      }
      case 'snapshot':
        this.reply(peer, id, this.snapshotPage(lease, p));
        break;
      case 'detach':
        this.reply(peer, id, { ok: true });
        this.release(lease, false);
        peer.socket.end();
        break;
      case 'shutdown': {
        const atSeq = this.validateShutdown(p);
        const reason = this.retirementBlocker() ?? (atSeq === this.seq ? null : 'cursor changed');
        this.reply(peer, id, reason === null ? { outcome: 'closed' } : { outcome: 'busy', reason });
        if (reason === null) this.startClose();
        break;
      }
      default:
        throw new HostError('invalid_request', 'unknown session host method');
    }
  }

  private validateShutdown(p: Fields): number {
    if (p.expectedInstanceId !== this.options.instanceId) throw new HostError('fenced', 'host instance changed');
    string(p.reason, 'reason');
    return counter(p.atSeq, 'atSeq');
  }

  private async command(p: Fields): Promise<StoredOperation> {
    if (!sameRef(p.ref === null ? null : parseRef(p.ref), this.ref)) throw new HostError('identity_mismatch');
    if (p.connectionGeneration !== this.connectionGeneration || p.controlGeneration !== this.controlGeneration) {
      throw new HostError('fenced', 'command generations changed');
    }
    const operationId = string(p.operationId, 'operationId');
    const kind = string(p.kind, 'kind');
    if (!('args' in p)) throw new HostError('invalid_request', 'command args required');
    const attachment = p.attachment === undefined ? null
      : Array.isArray(p.attachment) ? joinChunks(p.attachment) : undefined;
    if (attachment === undefined) throw new HostError('invalid_request', 'invalid command attachment');
    const digest = hex(p.digest, 'digest');
    if (commandDigest(kind, p.args, attachment) !== digest) throw new HostError('invalid_request', 'command digest mismatch');
    const journal = this.options.journal;
    const previous = journal.getOperation(operationId);
    if (previous) {
      if (previous.digest !== digest) throw new HostError('invalid_request', 'operation ID digest mismatch');
      return previous;
    }
    const command = { operationId, kind, args: p.args, attachment };
    this.options.runner.validateCommand?.(command);
    const prepared = journal.prepareOperation(operationId, digest, kind);
    if (!prepared.created) return prepared.operation;
    journal.markOperationSubmitted(operationId);
    this.commandInFlight = true;
    this.lastWork = performance.now();
    try {
      const receipt = await this.options.runner.execute(command, this.context);
      if (Buffer.byteLength(json(receipt)) > MAX_PAYLOAD_BYTES - 64 * 1024) {
        throw new HostError('invalid_request', 'provider receipt too large');
      }
      journal.markOperationTerminal(operationId, receipt);
      return { state: 'terminal', digest, receipt };
    } catch (error) {
      journal.markOperationUnknown(operationId, { code: 'outcome_unknown', message: 'provider submission requires reconciliation' });
      this.report(error);
      throw new HostError('outcome_unknown');
    } finally {
      this.commandInFlight = false;
      this.lastWork = performance.now();
    }
  }

  private makeSnapshot(barrierSeq: number): Snapshot {
    const events = this.options.journal.listUnackedEvents(this.options.instanceId, barrierSeq);
    const snapshotId = randomUUID();
    const groups: unknown[][] = [[]];
    const items: unknown[] = [];
    let bytes = 2;
    const append = (item: unknown, size: number) => {
      let page = groups[groups.length - 1]!;
      if (page.length && bytes + size + 1 > this.snapshotPageBytes) {
        page = [];
        groups.push(page);
        bytes = 2;
      }
      page.push(item);
      items.push(item);
      bytes += size + 1;
    };
    const appendItem = (item: { type: 'state'; value: RunnerState; ref: HostRef | null } | { type: 'event'; value: JournalEvent }) => {
      const encoded = Buffer.from(json(item));
      if (encoded.length <= Math.max(this.snapshotPageBytes, 1024) && encoded.length <= MAX_SNAPSHOT_PAGE_BYTES) {
        append(item, encoded.length);
      } else {
        for (const chunk of chunkPayload(encoded)) {
          const part = { type: 'chunk', value: chunk };
          const size = Buffer.byteLength(json(part));
          if (size > MAX_SNAPSHOT_CHUNK_ITEM_BYTES) throw new Error('snapshot chunk exceeds page budget');
          append(part, size);
        }
      }
    };
    appendItem({ type: 'state', value: this.state, ref: this.ref });
    for (const event of events) appendItem({ type: 'event', value: event });
    const digest = snapshotDigest(items);
    return {
      nextPage: 0,
      delivered: false,
      pages: groups.map((items, page) => ({
        snapshotId, barrierSeq, page, totalPages: groups.length, items,
        ...(page === groups.length - 1 ? { digest } : {}),
      })),
    };
  }

  private snapshotPage(lease: Lease, p: Fields): SnapshotPage {
    const index = counter(p.page, 'page');
    if (index === 0 && p.snapshotId === undefined && !lease.snapshot) {
      lease.snapshot = this.makeSnapshot(this.seq);
    }
    const snapshot = lease.snapshot;
    const page = snapshot?.pages[index];
    if (!snapshot || !page || (p.snapshotId === undefined ? index !== 0 : p.snapshotId !== page.snapshotId)) {
      throw new HostError('snapshot_required', 'snapshot page or ID changed');
    }
    if (index === 0 && p.snapshotId === undefined) {
      snapshot.nextPage = 0;
      snapshot.delivered = false;
    }
    if (index !== snapshot.nextPage) throw new HostError('snapshot_required', 'snapshot page out of order');
    snapshot.nextPage++;
    if (page.digest !== undefined) {
      snapshot.delivered = true;
      lease.deliveredSeq = Math.max(lease.deliveredSeq, page.barrierSeq);
    }
    return page;
  }

  private sendEvent(lease: Lease, event: RingEntry): boolean {
    const sent = this.send(lease.peer, {
      jsonrpc: '2.0', method: 'event', params: {
        instanceId: this.options.instanceId, lease: lease.token, seq: event.seq, ref: event.ref,
        connectionGeneration: this.connectionGeneration, observation: event.observation,
      },
    });
    if (sent) lease.deliveredSeq = event.seq;
    return sent;
  }

  private release(lease: Lease, revoke: boolean): void {
    if (this.lease !== lease) return;
    this.lease = undefined;
    if (revoke) this.revoke(lease.peer);
    if (!this.closing) this.options.onState?.('detached');
  }

  private revoke(peer: Peer): void {
    peer.revoked = true;
    this.send(peer, { jsonrpc: '2.0', method: 'revoked', params: { code: 'fenced' } });
    // Leave one turn for requests already read from this socket to receive a fenced error.
    setImmediate(() => {
      peer.socket.end();
      const timer = setTimeout(() => peer.socket.destroy(), 250);
      timer.unref();
    });
  }

  private send(peer: Peer, message: RpcMessage): boolean {
    try {
      peer.wire.send(message);
      return true;
    } catch (error) {
      if (!peer.socket.destroyed && !peer.socket.writableEnded) this.report(error);
      peer.socket.destroy();
      return false;
    }
  }

  private reply(peer: Peer, id: RpcId, result: unknown): void {
    this.send(peer, { jsonrpc: '2.0', id, result });
  }

  private sendError(peer: Peer, id: RpcId | null, error: unknown): void {
    if (!(error instanceof HostError)) this.report(error);
    const e = error instanceof HostError ? error : new HostError('temporarily_unavailable', 'session host internal failure');
    this.send(peer, { jsonrpc: '2.0', id, error: { code: e.code, message: e.message } });
  }

  private startClose(): void {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    this.lease = undefined;
    void this.finishClose().then(this.resolveClosed, this.rejectClosed);
  }

  private async finishClose(): Promise<void> {
    const drained = new Promise<void>((resolve, reject) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(error => error ? reject(error) : resolve());
    });
    for (const peer of this.peers) peer.socket.end();
    const timeout = setTimeout(() => {
      for (const peer of this.peers) peer.socket.destroy();
    }, 250);
    timeout.unref();
    try {
      await drained;
      await this.options.runner.stop?.();
    } finally {
      clearTimeout(timeout);
    }
  }
}
