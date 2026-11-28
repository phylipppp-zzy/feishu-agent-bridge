import { createConnection, type Socket } from 'node:net';
import {
  checkPrivateSocket, chunkPayload, ChunkAssembler, commandDigest, counter, decodeChunkedJson,
  handshakeMac, hex, HostError, json, MAX_PAYLOAD_BYTES, nonce, object, parseRef, privateDirectory,
  readSecret, rpcRequest, RpcWire, runtimePaths, sameRef, snapshotDigest, string, verifyMac,
  type Challenge, type Fields, type HostRef, type RpcMessage,
} from './protocol.js';
import type { JournalEvent, OperationReceipt, StoredOperation } from './journal.js';
import { parseRunnerState, type RunnerState } from './server.js';

export interface HostCursor {
  instanceId: string;
  seq: number;
}
export interface HelloResult {
  version: 1;
  instanceId: string;
  ref: HostRef | null;
  releaseDir: string;
  capabilities: unknown;
  state: unknown;
}
export interface AttachResult {
  lease: string;
  connectionGeneration: number;
  controlGeneration: number;
  firstSeq: number;
  barrierSeq: number;
  mode: 'replay' | 'snapshot';
}
export interface HostEvent extends HostCursor {
  lease: string;
  ref: HostRef | null;
  connectionGeneration: number;
  observation: unknown;
}
export interface HostSnapshot {
  snapshotId: string;
  barrierSeq: number;
  state: RunnerState;
  ref: HostRef | null;
  events: JournalEvent[];
}
export interface ClientOptions {
  runtimeDir: string;
  key: string;
  clientId: string;
  bridgeEpoch: number;
  expectedRef: HostRef | null;
  cursor?: HostCursor | null;
  heartbeatMs?: number | false;
  requestTimeoutMs?: number;
  onEvent?: (event: HostEvent) => void;
  onError?: (error: HostError) => void;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: HostError) => void; timer: NodeJS.Timeout };

function parseAttach(value: unknown): AttachResult {
  const p = object(value);
  const firstSeq = counter(p.firstSeq, 'firstSeq', 1);
  const barrierSeq = counter(p.barrierSeq, 'barrierSeq');
  if ((p.mode !== 'replay' && p.mode !== 'snapshot') || firstSeq - 1 > barrierSeq) {
    throw new HostError('invalid_request', 'invalid attach result');
  }
  return {
    lease: string(p.lease, 'lease'), connectionGeneration: counter(p.connectionGeneration, 'connectionGeneration', 1),
    controlGeneration: counter(p.controlGeneration, 'controlGeneration', 1), firstSeq, barrierSeq, mode: p.mode,
  };
}

function parseReceipt(value: unknown): OperationReceipt {
  const p = object(value);
  const state = p.state;
  if (state === 'absent') return { state };
  if (state !== 'prepared' && state !== 'submitted' && state !== 'terminal' && state !== 'unknown') {
    throw new HostError('invalid_request', 'invalid receipt state');
  }
  if ((state === 'terminal') !== ('receipt' in p) || (state === 'unknown') !== ('error' in p)) {
    throw new HostError('invalid_request', 'invalid receipt body');
  }
  return {
    state, digest: hex(p.digest, 'digest'),
    ...('receipt' in p ? { receipt: p.receipt } : {}), ...('error' in p ? { error: p.error } : {}),
  };
}

export async function collectSnapshot(
  fetchPage: (page: number, snapshotId?: string) => Promise<unknown>,
  expectedInstanceId: string,
  expectedBarrierSeq: number,
): Promise<HostSnapshot> {
  let snapshotId: string | undefined;
  let totalPages = 1;
  const wireItems: unknown[] = [];
  for (let page = 0; page < totalPages; page++) {
    const p = object(await fetchPage(page, snapshotId));
    const id = string(p.snapshotId, 'snapshotId');
    const count = counter(p.totalPages, 'totalPages', 1);
    if (p.page !== page || p.barrierSeq !== expectedBarrierSeq || count > 100_000
        || (snapshotId !== undefined && (snapshotId !== id || totalPages !== count))
        || !Array.isArray(p.items) || p.items.length === 0) {
      throw new HostError('snapshot_required', 'inconsistent snapshot page');
    }
    snapshotId = id;
    totalPages = count;
    wireItems.push(...p.items);
    if (page === totalPages - 1) {
      if (!verifyMac(snapshotDigest(wireItems), p.digest)) {
        throw new HostError('snapshot_required', 'snapshot digest mismatch');
      }
    } else if ('digest' in p) {
      throw new HostError('snapshot_required', 'premature snapshot digest');
    }
  }
  let state: RunnerState | undefined;
  let ref: HostRef | null = null;
  const events: JournalEvent[] = [];
  let chunks: ChunkAssembler | undefined;
  for (const wireItem of wireItems) {
    let item = object(wireItem);
    if (item.type === 'chunk') {
      chunks ??= new ChunkAssembler();
      const bytes = chunks.push(item.value);
      if (!bytes) continue;
      chunks = undefined;
      item = object(decodeChunkedJson(bytes));
    } else if (chunks) {
      throw new HostError('snapshot_required', 'interrupted snapshot item');
    }
    if (item.type === 'state' && !state) {
      state = parseRunnerState(item.value);
      ref = item.ref === null ? null : parseRef(item.ref);
    } else if (item.type === 'event' && state) {
      const event = object(item.value);
      const seq = counter(event.seq, 'seq', 1);
      if (seq > expectedBarrierSeq || seq <= (events.at(-1)?.seq ?? 0) || event.instanceId !== expectedInstanceId
          || typeof event.terminal !== 'boolean' || !('observation' in event)) {
        throw new HostError('snapshot_required', 'invalid snapshot event');
      }
      events.push({ seq, instanceId: expectedInstanceId, terminal: event.terminal, observation: event.observation });
    } else {
      throw new HostError('snapshot_required', 'invalid snapshot item');
    }
  }
  if (!snapshotId || !state || chunks) throw new HostError('snapshot_required', 'incomplete snapshot');
  return { snapshotId, barrierSeq: expectedBarrierSeq, ref, state, events };
}

export class SessionHostClient {
  private readonly socket: Socket;
  private readonly wire: RpcWire;
  private readonly pending = new Map<number, Pending>();
  private readonly buffered: HostEvent[] = [];
  private bufferedBytes = 0;
  private requestId = 0;
  private failure: HostError | undefined;
  private challenge!: Challenge;
  private greeting!: HelloResult;
  private attachment: AttachResult | undefined;
  private currentRef: HostRef | null;
  private currentCursor: HostCursor | null;
  private waitingForSnapshot = true;
  private readingSnapshot = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private attachStarted = false;
  private readonly heartbeatMs: number | false;
  private readonly requestTimeoutMs: number;

  private constructor(private readonly options: ClientOptions, socketPath: string) {
    this.requestTimeoutMs = counter(options.requestTimeoutMs ?? 10_000, 'requestTimeoutMs', 1);
    this.heartbeatMs = options.heartbeatMs === false ? false : counter(options.heartbeatMs ?? 5000, 'heartbeatMs', 1);
    this.currentRef = options.expectedRef;
    this.currentCursor = options.cursor ? {
      instanceId: string(options.cursor.instanceId, 'cursor instanceId'), seq: counter(options.cursor.seq, 'cursor seq'),
    } : null;
    this.socket = createConnection(socketPath);
    this.socket.on('error', error => this.fail(new HostError('temporarily_unavailable', error.message)));
    this.socket.once('close', () => this.fail(new HostError('temporarily_unavailable', 'session host connection closed')));
    this.wire = new RpcWire(this.socket, message => this.receive(message), error => this.fail(error), () => true);
  }

  static async connect(options: ClientOptions): Promise<SessionHostClient> {
    const paths = runtimePaths(options.runtimeDir, options.key);
    privateDirectory(options.runtimeDir);
    checkPrivateSocket(paths.socket);
    const secret = readSecret(paths.secret);
    const client = new SessionHostClient(options, paths.socket);
    try {
      await client.authenticate(secret);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  static async probe(options: ClientOptions): Promise<HelloResult> {
    const client = await SessionHostClient.connect(options);
    try {
      return client.hello;
    } finally {
      client.close();
    }
  }

  get hello(): HelloResult {
    return this.greeting;
  }

  get cursor(): HostCursor | null {
    return this.currentCursor && { ...this.currentCursor };
  }

  async attach(): Promise<AttachResult> {
    if (this.attachStarted) throw new HostError('unauthorized', 'one attach per connection');
    this.attachStarted = true;
    const { instanceId, clientId, bridgeEpoch } = this.challenge;
    let result: AttachResult;
    try {
      result = parseAttach(await this.request('attach', {
        instanceId, clientId, bridgeEpoch, clientMac: this.clientMac,
        lastSeq: this.currentCursor?.seq ?? null, expectedRef: this.options.expectedRef,
        ...(this.currentCursor ? { lastInstanceId: this.currentCursor.instanceId } : {}),
      }));
    } catch (error) {
      this.fail(asHostError(error));
      throw error;
    } finally {
      this.clientMac = '';
    }
    this.attachment = result;
    this.waitingForSnapshot = result.mode === 'snapshot';
    if (!this.waitingForSnapshot) {
      const cursor = this.currentCursor;
      if (!cursor || cursor.instanceId !== instanceId || cursor.seq < result.firstSeq - 1 || cursor.seq > result.barrierSeq) {
        this.fail(new HostError('snapshot_required', 'invalid replay barrier'));
        throw this.failure;
      }
      try {
        this.flushEvents();
      } catch (error) {
        this.fail(asHostError(error));
        throw error;
      }
    }
    if (this.heartbeatMs !== false) {
      let pending = false;
      this.heartbeat = setInterval(() => {
        if (pending) return;
        pending = true;
        void this.ping().catch(error => this.fail(asHostError(error))).finally(() => { pending = false; });
      }, this.heartbeatMs);
      this.heartbeat.unref();
    }
    return result;
  }

  async snapshot(): Promise<HostSnapshot> {
    const attachment = this.attached();
    if (!this.waitingForSnapshot || this.readingSnapshot) throw new HostError('invalid_request', 'no pending snapshot or already reading');
    this.readingSnapshot = true;
    try {
      const snapshot = await collectSnapshot((page, snapshotId) => this.request('snapshot', {
        lease: attachment.lease, page, ...(snapshotId === undefined ? {} : { snapshotId }),
      }), this.hello.instanceId, attachment.barrierSeq);
      if (this.failure) throw this.failure;
      if (this.currentRef !== null && !sameRef(snapshot.ref, this.currentRef)) throw new HostError('identity_mismatch');
      this.currentRef = snapshot.ref;
      this.currentCursor = { instanceId: this.hello.instanceId, seq: snapshot.barrierSeq };
      this.waitingForSnapshot = false;
      // The caller applies the snapshot before buffered live observations are released.
      setImmediate(() => {
        if (!this.failure) {
          try {
            this.flushEvents();
          } catch (error) {
            this.fail(asHostError(error));
          }
        }
      });
      return snapshot;
    } finally {
      this.readingSnapshot = false;
    }
  }

  async command(operationId: string, kind: string, args: unknown, attachment: Uint8Array | null = null): Promise<StoredOperation> {
    const { lease, connectionGeneration, controlGeneration } = this.attached();
    const result = parseReceipt(await this.request('command', {
      lease, operationId, kind, args, ref: this.currentRef, connectionGeneration, controlGeneration,
      digest: commandDigest(kind, args, attachment),
      ...(attachment === null ? {} : { attachment: chunkPayload(attachment) }),
    }));
    if (result.state === 'absent') throw new HostError('invalid_request', 'command returned no receipt');
    return result;
  }

  async receipt(operationId: string): Promise<OperationReceipt> {
    return parseReceipt(await this.request('receipt', { lease: this.attached().lease, operationId }));
  }

  async ack(seq = this.currentCursor?.seq): Promise<number> {
    const cursor = this.currentCursor;
    if (!cursor || cursor.instanceId !== this.hello.instanceId || seq === undefined || seq > cursor.seq
        || this.waitingForSnapshot || this.readingSnapshot) throw new HostError('snapshot_required', 'cursor has not been verified');
    const result = object(await this.request('ack', { lease: this.attached().lease, seq: counter(seq, 'seq') }));
    return counter(result.ackedSeq, 'ackedSeq');
  }

  async ping(): Promise<void> {
    await this.request('ping', { lease: this.attached().lease });
  }

  async detach(): Promise<void> {
    await this.request('detach', { lease: this.attached().lease });
    this.close();
  }

  async shutdown(reason: string): Promise<{ outcome: 'closed' } | { outcome: 'busy'; reason: string }> {
    const result = object(await this.request('shutdown', {
      lease: this.attached().lease, expectedInstanceId: this.hello.instanceId,
      atSeq: this.currentCursor?.seq ?? this.attached().barrierSeq, reason,
    }));
    if (result.outcome === 'closed') return { outcome: 'closed' };
    if (result.outcome === 'busy') return { outcome: 'busy', reason: string(result.reason, 'reason') };
    throw new HostError('invalid_request', 'invalid shutdown outcome');
  }

  close(): void {
    this.fail(new HostError('temporarily_unavailable', 'session host client closed locally'), false);
  }

  private clientMac = '';

  private async authenticate(secret: Uint8Array): Promise<void> {
    const clientId = string(this.options.clientId, 'clientId');
    const bridgeEpoch = counter(this.options.bridgeEpoch, 'bridgeEpoch', 1);
    const clientNonce = nonce();
    const result = object(await this.request('hello', {
      versions: [1], clientId, bridgeEpoch, key: this.options.key, clientNonce,
    }));
    if (result.version !== 1) throw new HostError('version_mismatch');
    const instanceId = string(result.instanceId, 'instanceId');
    this.challenge = {
      key: this.options.key, instanceId, clientId, bridgeEpoch, clientNonce, hostNonce: hex(result.hostNonce, 'hostNonce'),
    };
    if (!verifyMac(handshakeMac(secret, 'host', this.challenge), result.hostMac)) {
      throw new HostError('unauthorized', 'host challenge verification failed');
    }
    const ref = result.ref === null ? null : parseRef(result.ref);
    if (!sameRef(ref, this.options.expectedRef)) throw new HostError('identity_mismatch', 'host ref changed');
    this.greeting = {
      version: 1, instanceId, ref, releaseDir: string(result.releaseDir, 'releaseDir'),
      capabilities: result.capabilities, state: result.state,
    };
    this.clientMac = handshakeMac(secret, 'client', this.challenge);
  }

  private attached(): AttachResult {
    if (this.failure) throw this.failure;
    if (!this.attachment) throw new HostError('unauthorized', 'attach required');
    return this.attachment;
  }

  private request(method: string, params: Fields): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new HostError('temporarily_unavailable', method + ' timed out'));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.wire.send(rpcRequest(id, method, params));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asHostError(error));
      }
    });
  }

  private receive(message: RpcMessage): void {
    if ('method' in message) {
      if (message.id !== undefined) throw new HostError('invalid_request', 'unexpected host request');
      if (message.method === 'revoked' && message.params.code === 'fenced') {
        this.fail(new HostError('fenced'));
        return;
      }
      if (message.method !== 'event' || !this.attachStarted) throw new HostError('invalid_request', 'unexpected host notification');
      const p = message.params;
      if (!('observation' in p)) throw new HostError('invalid_request', 'event observation missing');
      const event: HostEvent = {
        instanceId: string(p.instanceId, 'instanceId'), lease: string(p.lease, 'lease'), seq: counter(p.seq, 'seq', 1),
        ref: p.ref === null ? null : parseRef(p.ref), connectionGeneration: counter(p.connectionGeneration, 'connectionGeneration', 1),
        observation: p.observation,
      };
      if (this.waitingForSnapshot || this.buffered.length) {
        this.bufferedBytes += Buffer.byteLength(json(p));
        if (this.bufferedBytes > 2 * MAX_PAYLOAD_BYTES || this.buffered.length >= 65_536) {
          throw new HostError('snapshot_required', 'too many events arrived before the cursor was ready');
        }
        this.buffered.push(event);
      } else {
        this.consumeEvent(event);
      }
      return;
    }
    if (message.id === null && 'error' in message) {
      this.fail(new HostError(message.error.code, message.error.message));
      return;
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!pending || typeof message.id !== 'number') throw new HostError('invalid_request', 'unexpected response ID');
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ('error' in message) pending.reject(new HostError(message.error.code, message.error.message));
    else pending.resolve(message.result);
  }

  private consumeEvent(event: HostEvent): void {
    const attachment = this.attached();
    if (event.lease !== attachment.lease || event.connectionGeneration !== attachment.connectionGeneration
        || event.instanceId !== this.hello.instanceId) throw new HostError('fenced', 'event lease changed');
    if (!this.currentCursor || event.seq !== this.currentCursor.seq + 1) throw new HostError('snapshot_required', 'event sequence gap');
    if (event.ref && this.currentRef && !sameRef(event.ref, this.currentRef)) throw new HostError('identity_mismatch');
    this.currentRef ??= event.ref;
    this.options.onEvent?.(event);
    this.currentCursor = { instanceId: event.instanceId, seq: event.seq };
  }

  private flushEvents(): void {
    const events = this.buffered.splice(0);
    this.bufferedBytes = 0;
    for (const event of events) this.consumeEvent(event);
  }

  private fail(error: HostError, notify = true): void {
    if (this.failure) return;
    this.failure = error;
    clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket.destroy();
    if (notify) this.options.onError?.(error);
  }
}

function asHostError(error: unknown): HostError {
  return error instanceof HostError ? error : new HostError('temporarily_unavailable', 'session host client failure');
}
