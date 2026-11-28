import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  DispatchGuard, PlatformAcknowledgement, PlatformInputBlock, PlatformObservation, PlatformPort,
} from '../adapter.js';
import type { Answer, Interaction, Message, NativeSessionRef, Session, SessionSnapshot, Turn } from '../contracts.js';
import { contractError, errorDefaults, type ErrorCode } from '../errors.js';
import { isTerminalTurn, readToolProgress, type ToolProgress } from '../tool-progress.js';
import { SessionHostClient, type ClientOptions, type HostCursor, type HostEvent, type HostSnapshot } from './client.js';
import { isStampedProcessAlive, SessionHostLauncher, type LauncherOptions } from './launcher.js';
import {
  commandDigest, counter, HostError, json, MAX_PAYLOAD_BYTES, object, privateDirectory, sameRef,
  sha256, string, writePrivateAtomic, type Fields, type HostIdentity, type HostRef,
} from './protocol.js';
import { SessionHostRegistry } from './registry.js';
import {
  idleRunnerState, type RunnerCommand, type RunnerContext, type RunnerState, type SessionHostRunner,
} from './server.js';

export type { HostCursor, HostEvent, HostSnapshot } from './client.js';

export interface HostedLiveSnapshot {
  session: Session | null;
  turns: Turn[];
  messages: Message[];
  interactions: Interaction[];
  toolProgress: Array<ToolProgress & { connectionGeneration: number }>;
  activeTurnId: string | null;
  connectionGeneration: number | null;
  controlGeneration: number;
  hasResidual: boolean;
  residualUnknown: boolean;
}

export interface HostedContinuityProbe {
  status: 'alive' | 'dead' | 'absent';
  instanceId?: string;
  releaseDir?: string;
  protocolVersion?: number;
  activeTurnId?: string | null;
  pendingInteractionCount?: number;
  state?: unknown;
}

export interface HostedAttachment {
  instanceId: string;
  /** Stage 1 lease generations. Native generations are carried by observations and snapshot.state.data. */
  connectionGeneration: number;
  controlGeneration: number;
  barrierSeq: number;
  mode: 'replay' | 'snapshot';
  snapshot?: HostSnapshot;
  replayedEvents: HostEvent[];
  releaseDir: string;
}

export type HostedObservationHandler = (observation: PlatformObservation, event: HostEvent) => void | Promise<void>;

export interface HostedPlatformPortOptions extends LauncherOptions {
  hostId: string;
  serviceId: string;
  /** Allocate once through SessionHostRegistry and share across a bridge's ports. */
  bridgeEpoch: number;
  clientId?: string;
  local: PlatformPort;
  /** Provider-only bootstrap settings, persisted in a private file. */
  config?: Fields;
  requestTimeoutMs?: number;
}

const hostRef = (ref: NativeSessionRef): HostRef => [ref.provider, ref.hostId, ref.serviceId, ref.nativeSessionId];
function nativeRef(ref: HostRef): NativeSessionRef {
  const [provider, hostId, serviceId, nativeSessionId] = ref;
  if (provider !== 'agy' && provider !== 'claude' && provider !== 'codex') throw new HostError('identity_mismatch');
  return { provider, hostId, serviceId, nativeSessionId };
}

function isContractCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.hasOwn(errorDefaults, code);
}

function decodeBlocks(value: unknown, attachment: Uint8Array | null): PlatformInputBlock[] {
  if (!Array.isArray(value) || !value.length) throw new HostError('invalid_request', 'input blocks required');
  let offset = 0;
  const blocks = value.map((value): PlatformInputBlock => {
    const block = object(value);
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
    if (block.type !== 'artifact' || attachment === null) throw new HostError('invalid_request', 'invalid input block');
    const length = counter(block.byteLength, 'artifact byteLength');
    if (length > attachment.byteLength - offset) throw new HostError('invalid_request', 'incomplete attachment');
    const content = attachment.subarray(offset, offset + length);
    offset += length;
    return {
      type: 'artifact', content,
      artifactId: string(block.artifactId, 'artifactId'), contentVersion: string(block.contentVersion, 'contentVersion'),
      name: string(block.name, 'artifact name'), mediaType: string(block.mediaType, 'artifact mediaType'),
    };
  });
  if (offset !== (attachment?.byteLength ?? 0)) throw new HostError('invalid_request', 'unused attachment bytes');
  return blocks;
}

function dispatchArgs(guard: DispatchGuard): Fields {
  return {
    expectedControlGeneration: guard.expectedControlGeneration,
    expectedConnectionGeneration: guard.expectedConnectionGeneration,
  };
}

type Method = Exclude<keyof PlatformPort, 'provider'>;
type Result<K extends Method> = Awaited<ReturnType<NonNullable<PlatformPort[K]>>>;
type Link = {
  client: SessionHostClient;
  pending: HostEvent[];
  draining: boolean;
  detaching?: Promise<void>;
  attachment: HostedAttachment;
  /** Hold events after the barrier until the caller commits the initial projection. */
  waitingForCommit: boolean;
  closing: boolean;
  nativeActive: boolean;
};

const localMethods = [
  'discoverExisting', 'discoverNewer', 'discoverRunning', 'readAutoActivity', 'listCandidateIds',
  'readCandidateMetadata', 'candidateGeneration', 'listProjectFiles', 'selectProjectFiles', 'findRegisteredReplyFiles',
] as const;

export class HostedPlatformPort implements PlatformPort {
  readonly provider: PlatformPort['provider'];
  private readonly launcher: SessionHostLauncher;
  private readonly clientId: string;
  private readonly local: PlatformPort;
  private readonly links = new Map<string, Link>();
  private readonly opening = new Map<string, Promise<Link>>();
  private readonly attaching = new Map<string, Promise<Link>>();
  private readonly listeners = new Set<(observation: PlatformObservation) => void>();
  private handler?: HostedObservationHandler;
  private closed = false;
  private closing?: Promise<void>;
  declare readonly discoverExisting?: NonNullable<PlatformPort['discoverExisting']>;
  declare readonly discoverNewer?: NonNullable<PlatformPort['discoverNewer']>;
  declare readonly discoverRunning?: NonNullable<PlatformPort['discoverRunning']>;
  declare readonly readAutoActivity?: NonNullable<PlatformPort['readAutoActivity']>;
  declare readonly listCandidateIds?: NonNullable<PlatformPort['listCandidateIds']>;
  declare readonly readCandidateMetadata?: NonNullable<PlatformPort['readCandidateMetadata']>;
  declare readonly candidateGeneration?: NonNullable<PlatformPort['candidateGeneration']>;
  declare readonly listProjectFiles?: NonNullable<PlatformPort['listProjectFiles']>;
  declare readonly selectProjectFiles?: NonNullable<PlatformPort['selectProjectFiles']>;
  declare readonly findRegisteredReplyFiles?: NonNullable<PlatformPort['findRegisteredReplyFiles']>;

  constructor(private readonly options: HostedPlatformPortOptions) {
    this.local = options.local;
    this.provider = this.local.provider;
    counter(options.bridgeEpoch, 'bridgeEpoch', 1);
    string(options.hostId, 'hostId');
    string(options.serviceId, 'serviceId');
    this.clientId = options.clientId ?? randomUUID();
    if (options.configFile && options.config) throw new HostError('invalid_request', 'provide one bootstrap config');
    let configFile = options.configFile;
    if (options.config) {
      const config = json(options.config);
      if (Buffer.byteLength(config) > 64 * 1024) throw new HostError('invalid_request', 'bootstrap config too large');
      const dir = privateDirectory(join(options.stateDir, 'session-host', 'bootstrap'), true);
      configFile = join(dir, sha256(config) + '.json');
      writePrivateAtomic(configFile, config);
    }
    this.launcher = new SessionHostLauncher({ ...options, ...(configFile ? { configFile } : {}) });
    for (const method of localMethods) {
      const call = this.local[method];
      if (call) Object.defineProperty(this, method, { value: call.bind(this.local) });
    }
  }

  private verifyRef(ref: NativeSessionRef): HostRef {
    if (ref.provider !== this.provider || ref.hostId !== this.options.hostId || ref.serviceId !== this.options.serviceId) {
      throw contractError('invalid_request', 'native session reference mismatch');
    }
    string(ref.nativeSessionId, 'nativeSessionId');
    return hostRef(ref);
  }

  private clientOptions(key: string, expectedRef: HostRef | null): ClientOptions {
    return {
      key, expectedRef, runtimeDir: this.launcher.runtimeDir,
      clientId: this.clientId, bridgeEpoch: this.options.bridgeEpoch,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 60_000,
    };
  }

  private withRegistry<T>(read: (registry: SessionHostRegistry) => T): T {
    const registry = new SessionHostRegistry(this.launcher.stateDir);
    try { return read(registry); } finally { registry.close(); }
  }

  async probe(ref: NativeSessionRef): Promise<HostedContinuityProbe> {
    const tuple = this.verifyRef(ref);
    const record = this.withRegistry(registry => registry.getInstanceByRef(tuple));
    if (!record) return { status: 'absent' };
    const info = { instanceId: record.instanceId, releaseDir: record.releaseDir, protocolVersion: record.protocolVersion };
    if (record.state === 'closed' || !isStampedProcessAlive(record)) return { status: 'dead', ...info };
    // Authentication is sufficient to read hello. No attach RPC is sent.
    const hello = await SessionHostClient.probe({ ...this.clientOptions(record.key, tuple), requestTimeoutMs: 1_000 });
    if (hello.instanceId !== record.instanceId || hello.releaseDir !== record.releaseDir) {
      throw new HostError('identity_mismatch', 'instance changed during probe');
    }
    const continuity = (hello.capabilities as { continuity?: ContinuitySummary } | null)?.continuity;
    return { status: 'alive', ...info, state: hello.state, ...(continuity ? {
      activeTurnId: continuity.activeTurnId, pendingInteractionCount: continuity.pendingInteractionCount,
    } : {}) };
  }

  setHostedObservationHandler(handler: HostedObservationHandler): void {
    this.handler = handler;
  }

  onObservation(listener: (observation: PlatformObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply the returned replay or snapshot, then commitAck at barrierSeq to release live events. */
  async attachHosted(ref: NativeSessionRef, cursor: HostCursor | null): Promise<HostedAttachment> {
    const tuple = this.verifyRef(ref);
    const key = this.withRegistry(registry => registry.getInstanceByRef(tuple)?.key ?? registry.getBoundCreateKey(tuple));
    const existing = key ? this.links.get(key) : undefined;
    if (existing) {
      try { await this.detachLink(existing); } catch (error) {
        if (!(error instanceof HostError) || !['fenced', 'temporarily_unavailable'].includes(error.code)) throw error;
      }
    }
    return (await this.open(tuple, cursor, true)).attachment;
  }

  private open(identity: HostIdentity, cursor: HostCursor | null, waitForCommit: boolean): Promise<Link> {
    if (this.closed) return Promise.reject(contractError('temporarily_unavailable', 'hosted port is closed'));
    const operationKey = json(identity);
    const inFlight = this.opening.get(operationKey);
    if (inFlight) return inFlight;
    const work = this.connect(identity, cursor, waitForCommit).finally(() => this.opening.delete(operationKey));
    this.opening.set(operationKey, work);
    return work;
  }

  private async connect(identity: HostIdentity, cursor: HostCursor | null, waitForCommit: boolean): Promise<Link> {
    const { key, metadata } = await this.launcher.launch(identity);
    const existing = this.links.get(key);
    if (existing && !existing.closing) return existing;
    const attaching = this.attaching.get(key);
    if (attaching) return attaching;
    const work = this.attachClient(key, metadata.instanceId, identity, cursor, waitForCommit)
      .finally(() => this.attaching.delete(key));
    this.attaching.set(key, work);
    return work;
  }

  private async attachClient(key: string, instanceId: string, identity: HostIdentity, cursor: HostCursor | null, waitForCommit: boolean): Promise<Link> {
    const expectedRef = identity.length === 4 ? identity : this.withRegistry(registry => registry.getIdentity(key)?.ref ?? null);
    const pending: HostEvent[] = [];
    let link: Link | undefined;
    let failure: HostError | undefined;
    let replayWait: { barrier: number; finish: (error?: HostError) => void } | undefined;
    const client = await SessionHostClient.connect({
      ...this.clientOptions(key, expectedRef), cursor,
      onEvent: event => {
        if (link?.closing) return;
        if (pending.length >= 65_536) throw new HostError('snapshot_required', 'hosted observation backlog exceeded');
        pending.push(event);
        if (replayWait && event.seq === replayWait.barrier) replayWait.finish();
        if (link) this.deliver(link);
      },
      onError: error => {
        failure = error;
        replayWait?.finish(error);
        if (link) {
          link.closing = true;
          if (this.links.get(key) === link) this.links.delete(key);
        }
      },
    });
    try {
      if (client.hello.instanceId !== instanceId) throw new HostError('identity_mismatch', 'host instance changed during launch');
      const attached = await client.attach();
      if (attached.mode === 'replay' && (pending.at(-1)?.seq ?? cursor?.seq ?? 0) < attached.barrierSeq) {
        // The attach reply and replay frames can arrive in separate socket reads.
        if (failure) throw failure;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => replayWait?.finish(new HostError('snapshot_required', 'replay barrier timed out')),
            this.options.requestTimeoutMs ?? 60_000).unref();
          replayWait = { barrier: attached.barrierSeq, finish: error => {
            clearTimeout(timer);
            replayWait = undefined;
            if (error) reject(error);
            else resolve();
          } };
        });
      }
      if (failure) throw failure;
      const snapshot = attached.mode === 'snapshot' ? await client.snapshot() : undefined;
      const replayedEvents = pending.filter(event => event.seq <= attached.barrierSeq);
      if (attached.mode === 'replay' && replayedEvents.length !== attached.barrierSeq - (cursor?.seq ?? -1)) {
        throw new HostError('snapshot_required', 'incomplete event replay');
      }
      pending.splice(0, replayedEvents.length);
      const { mode, connectionGeneration, controlGeneration, barrierSeq } = attached;
      const attachment = {
        mode, connectionGeneration, controlGeneration, barrierSeq, replayedEvents,
        ...(snapshot ? { snapshot } : {}), instanceId: client.hello.instanceId, releaseDir: client.hello.releaseDir,
      };
      const continuity = (client.hello.capabilities as { continuity?: ContinuitySummary } | null)?.continuity;
      const data = snapshot?.state.data as HostedLiveSnapshot | null | undefined;
      link = { client, attachment, pending, draining: false, waitingForCommit: waitForCommit,
        closing: false, nativeActive: data ? data.session?.control.owner === this.options.serviceId : continuity?.nativeActive === true };
      for (const event of replayedEvents) this.trackNativeControl(link, event.observation as PlatformObservation);
      this.links.set(key, link);
      this.deliver(link);
      return link;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private trackNativeControl(link: Link, observation: PlatformObservation): void {
    if (observation.type === 'connection') link.nativeActive = true;
    if (observation.type === 'session') link.nativeActive = observation.session.control.owner === this.options.serviceId;
  }

  private deliver(link: Link): void {
    if (link.closing || link.waitingForCommit || link.draining || !link.pending.length) return;
    link.draining = true;
    // Let SessionHostClient verify and advance its cursor before handing an event to
    // code that can commit and acknowledge it.
    void Promise.resolve().then(async () => {
      while (!link.closing && link.pending.length) {
        const events = link.pending.splice(0);
        for (const event of events) {
          if (link.closing) return;
          const observation = event.observation as PlatformObservation | { type: 'session_bound' };
          if (observation.type === 'session_bound') continue;
          this.trackNativeControl(link, observation);
          await this.handler?.(observation, event);
          if (!link.closing) for (const listener of this.listeners) listener(observation);
        }
      }
    }).catch(() => {
      link.closing = true;
      this.forgetLink(link);
      link.client.close();
    }).finally(() => {
      link.draining = false;
      this.deliver(link);
    });
  }

  private forgetLink(link: Link): void {
    for (const [key, candidate] of this.links) if (candidate === link) this.links.delete(key);
  }

  private connected(tuple: HostRef): Link | undefined {
    const key = this.withRegistry(registry => registry.getInstanceByRef(tuple)?.key ?? registry.getBoundCreateKey(tuple));
    const link = key ? this.links.get(key) : undefined;
    return link?.closing ? undefined : link;
  }

  async commitAck(ref: NativeSessionRef, seq: number): Promise<void> {
    const link = this.connected(this.verifyRef(ref));
    if (!link) throw new HostError('temporarily_unavailable', 'hosted session is detached');
    await link.client.ack(seq);
    if (seq >= link.attachment.barrierSeq) {
      link.waitingForCommit = false;
      this.deliver(link);
    }
  }

  async shutdownHost(ref: NativeSessionRef, reason = 'idle cleanup') {
    const link = this.connected(this.verifyRef(ref));
    if (!link) throw new HostError('temporarily_unavailable', 'hosted session is detached');
    return link.client.shutdown(reason);
  }

  private detachLink(link: Link): Promise<void> {
    if (link.detaching) return link.detaching;
    link.closing = true;
    link.detaching = link.client.detach().finally(() => {
      link.client.close();
      this.forgetLink(link);
    });
    return link.detaching;
  }

  close(_options?: { detachOnly?: boolean }): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.allSettled(this.opening.values());
      await Promise.allSettled([...this.links.values()].map(link => this.detachLink(link)));
      await this.local.close?.();
      this.listeners.clear();
    })();
    return this.closing;
  }

  private async invoke<T>(link: Link, operationId: string, kind: string, args: Fields, attachment: Uint8Array | null = null): Promise<T> {
    try {
      const result = await link.client.command(operationId, kind, args, attachment);
      if (result.state !== 'terminal') throw contractError('outcome_unknown');
      const receipt = result.receipt;
      if (receipt !== null && typeof receipt === 'object' && 'providerRejection' in receipt) {
        const error = object(receipt.providerRejection);
        if (!isContractCode(error.code)) throw new HostError('invalid_request', 'invalid provider rejection');
        throw contractError(error.code, typeof error.message === 'string' ? error.message : undefined);
      }
      if (receipt === undefined) throw new HostError('invalid_request', 'missing provider command result');
      return receipt as T;
    } catch (error) {
      if (error instanceof HostError && error.code === 'invalid_request') {
        // Stage 1 reports digest reuse as invalid_request. Confirm it with the durable receipt.
        const previous = await link.client.receipt(operationId).catch(() => undefined);
        if (previous && previous.state !== 'absent' && previous.digest !== commandDigest(kind, args, attachment)) {
          throw contractError('idempotency_conflict');
        }
      }
      if (error instanceof HostError && error.code === 'fenced') throw contractError('control_conflict');
      if (error instanceof HostError && error.code === 'temporarily_unavailable' && (kind === 'create' || guardedCommands.has(kind))) {
        throw contractError('outcome_unknown', 'host connection lost during command');
      }
      if (error instanceof HostError && isContractCode(error.code)) throw contractError(error.code, error.message);
      throw error;
    }
  }

  private async route<K extends Method>(
    ref: NativeSessionRef, kind: K, args: Fields = {}, guard?: DispatchGuard, attachment: Uint8Array | null = null,
  ): Promise<Result<K>> {
    const tuple = this.verifyRef(ref);
    guard?.assertCurrent();
    const connected = this.connected(tuple);
    const link = connected ?? await this.open(tuple, null, false);
    if (!connected) guard?.assertCurrent();
    return this.invoke<Result<K>>(link, guard?.operationId ?? randomUUID(), kind, { ...args, ...(guard ? dispatchArgs(guard) : {}) }, attachment);
  }

  async create(cwd: string, model: string | null, operationId: string = randomUUID()): Promise<PlatformAcknowledgement> {
    string(cwd, 'cwd');
    string(operationId, 'operationId');
    const identity = ['create', this.provider, this.options.hostId, this.options.serviceId, operationId] as const;
    const existing = this.withRegistry(registry => registry.getCreateReceipt(operationId));
    if (existing && json(existing.identity) !== json(identity)) throw contractError('idempotency_conflict');
    const link = (existing?.ref && this.connected(existing.ref)) || await this.open(identity, null, false);
    const result = await this.invoke<PlatformAcknowledgement>(link, operationId, 'create', { cwd, model });
    const receipt = this.withRegistry(registry => registry.getCreateReceipt(operationId));
    if (!receipt?.ref || receipt.ref[3] !== result.nativeReference) throw contractError('outcome_unknown', 'host did not bind created session');
    if (!existing?.ref && result.createdSession?.control.owner === this.options.serviceId) link.nativeActive = true;
    return result;
  }

  list(cursor: string | null, limit: number) { return this.local.list(cursor, limit); }
  read(ref: NativeSessionRef) {
    const link = this.connected(this.verifyRef(ref));
    return link ? this.invoke<SessionSnapshot>(link, randomUUID(), 'read', {}) : this.local.read(ref);
  }
  async resume(ref: NativeSessionRef) {
    const acknowledgement = await this.route(ref, 'resume');
    const link = this.connected(this.verifyRef(ref));
    if (link) link.nativeActive = true;
    return acknowledgement;
  }
  input(ref: NativeSessionRef, mode: 'new' | 'steer', blocks: PlatformInputBlock[], guard: DispatchGuard, turnId?: string) {
    let size = 0;
    const content: Uint8Array[] = [];
    const wire = blocks.map(block => {
      if (block.type === 'text') return block;
      const { content: bytes, ...metadata } = block;
      size += bytes.byteLength;
      content.push(bytes);
      return { ...metadata, byteLength: bytes.byteLength };
    });
    if (size > MAX_PAYLOAD_BYTES) throw contractError('invalid_request', 'input attachments too large');
    return this.route(ref, 'input', { mode, blocks: wire, ...(turnId === undefined ? {} : { turnId }) },
      guard, content.length ? Buffer.concat(content, size) : null);
  }
  interrupt(ref: NativeSessionRef, turnId: string, guard: DispatchGuard) {
    return this.route(ref, 'interrupt', { turnId }, guard);
  }
  respond(ref: NativeSessionRef, interaction: Interaction, answer: Answer, guard: DispatchGuard) {
    return this.route(ref, 'respond', { interaction, answer }, guard);
  }
  updateSettings(ref: NativeSessionRef, settings: Parameters<PlatformPort['updateSettings']>[1], guard: DispatchGuard) {
    return this.route(ref, 'updateSettings', { settings }, guard);
  }
  control(ref: NativeSessionRef, action: 'acquire' | 'release', guard: DispatchGuard) {
    return this.route(ref, 'control', { action }, guard);
  }
  archive(ref: NativeSessionRef, archived: boolean, guard: DispatchGuard) {
    return this.route(ref, 'archive', { archived }, guard);
  }
  inspectTurnResidual(ref: NativeSessionRef, turnId: string) { return this.route(ref, 'inspectTurnResidual', { turnId }); }
  listModels(ref: NativeSessionRef) { return this.route(ref, 'listModels'); }
  getContextUsage(ref: NativeSessionRef) { return this.route(ref, 'getContextUsage'); }
  listArtifacts(ref: NativeSessionRef) { return this.route(ref, 'listArtifacts'); }
  async readArtifact(ref: NativeSessionRef, artifactId: string, contentVersion: string): Promise<Uint8Array> {
    const tuple = this.verifyRef(ref);
    const link = this.connected(tuple) ?? await this.open(tuple, null, false);
    const data = await this.invoke<string>(link, randomUUID(), 'readArtifact', { artifactId, contentVersion });
    return Buffer.from(data, 'base64');
  }
  hasActiveNativeSession(ref: NativeSessionRef): boolean {
    return this.connected(this.verifyRef(ref))?.nativeActive === true;
  }
}

interface ContinuitySummary {
  activeTurnId: string | null;
  pendingInteractionCount: number;
  nativeActive: boolean;
}

interface HostedRunnerState extends RunnerState {
  pendingInteractions: number;
  residualStatus: RunnerState['residual'];
  connectionGeneration: number | null;
  controlGeneration: number;
}

export interface NativeRunnerState {
  session?: Session | null;
  turns?: Turn[];
  messages?: Message[];
  interactions?: Interaction[];
  activeTurnId?: string | null;
  connectionGeneration?: number | null;
  controlGeneration?: number;
  pendingWakeup?: boolean;
  pendingSubagent?: boolean;
  pendingNativeRequests?: number;
  hasResidual?: boolean;
  residualUnknown?: boolean;
}

const guardedCommands = new Set(['input', 'interrupt', 'respond', 'updateSettings', 'control', 'archive']);
const readCommands = new Set(['resume', 'snapshot', 'read', 'inspectTurnResidual', 'listModels', 'getContextUsage', 'listArtifacts', 'readArtifact']);
const isPending = (interaction: Interaction) =>
  interaction.status === 'awaiting_answer' || interaction.status === 'answer_pending_delivery';

/** Shared dispatch and observation projection for the provider ends of the wire. */
export abstract class AdapterSessionHostRunner implements SessionHostRunner {
  private readonly steer: 'available' | 'unsupported';
  get capabilities() { return { steer: this.steer, attachments: true, continuity: this.continuity }; }
  private continuity: ContinuitySummary = { activeTurnId: null, pendingInteractionCount: 0, nativeActive: false };
  protected ref: NativeSessionRef | null;
  private context?: RunnerContext;
  private unsubscribe?: () => void;
  private creating: PlatformObservation[] | undefined;
  private session: Session | null = null;
  private readonly turns = new Map<string, Turn>();
  private readonly messages = new Map<string, Message>();
  private readonly interactions = new Map<string, Interaction>();
  private readonly toolProgress = new Map<string, HostedLiveSnapshot['toolProgress'][number]>();
  private activeTurnId: string | null = null;
  private connectionGeneration: number | null = null;
  private lostWork = false;
  private lastState?: string;

  constructor(protected readonly adapter: PlatformPort, ref?: NativeSessionRef) {
    this.ref = ref ?? null;
    this.steer = adapter.provider === 'codex' ? 'available' : 'unsupported';
  }

  start(context: RunnerContext): void {
    this.context = context;
    const previous = context.getState();
    const snapshot = previous.data as HostedLiveSnapshot | null;
    if (snapshot && this.ref && (!snapshot.session || sameRef(hostRef(snapshot.session.native), hostRef(this.ref)))) {
      if (snapshot.session) this.session = { ...snapshot.session, status: 'read_only',
        control: { ...snapshot.session.control, owner: null, input: 'unavailable', reason: 'provider host exited' } };
      for (const turn of snapshot.turns) this.turns.set(turn.turnId, turn);
      for (const message of snapshot.messages) this.messages.set(message.messageId, message);
      for (const interaction of snapshot.interactions) {
        this.interactions.set(interaction.interactionId, isPending(interaction) ? {
          ...interaction, status: 'expired', revision: interaction.revision + 1,
          nativeResult: { status: 'unknown', source: 'provider_host_exited' },
        } : interaction);
      }
      for (const update of snapshot.toolProgress ?? []) {
        this.toolProgress.set(json([update.connectionGeneration, update.turnId, update.callId]), update);
      }
      this.connectionGeneration = snapshot.connectionGeneration;
      this.lostWork = previous.activeTurn || previous.pendingInteraction !== null || previous.pendingWakeup ||
        previous.pendingSubagent || previous.residual !== 'none';
      if (snapshot.connectionGeneration !== null) this.adapter.seedConnectionGeneration?.(snapshot.connectionGeneration);
      this.adapter.seedControlGeneration?.(this.ref, snapshot.controlGeneration);
    }
    this.unsubscribe = this.adapter.onObservation(observation => this.observe(observation));
    this.refreshState();
  }

  protected abstract inspect(ref: NativeSessionRef): NativeRunnerState;
  protected async connectProvider(): Promise<void> {}

  protected refreshState(): void {
    if (!this.context) return;
    const state = this.getRunnerState();
    const encoded = json(state);
    if (encoded === this.lastState) return;
    try { this.context.setState(state); } catch (error) {
      if (error instanceof HostError && error.code === 'temporarily_unavailable') return;
      throw error;
    }
    this.updateContinuity(state, encoded);
  }

  private observe(observation: PlatformObservation): void {
    if (this.creating) {
      this.creating.push(observation);
      return;
    }
    if (!this.ref || !sameRef(hostRef(observation.ref), hostRef(this.ref)) || !this.context) return;
    if (observation.type === 'connection') this.connectionGeneration = observation.connectionGeneration;
    if (observation.type === 'session') this.session = observation.session;
    if (observation.type === 'message') this.messages.set(observation.message.messageId, observation.message);
    if (observation.type === 'interaction') this.interactions.set(observation.interaction.interactionId, observation.interaction);
    if (observation.type === 'event' && observation.event.type === 'tool.updated' && observation.connectionGeneration !== undefined) {
      const progress = readToolProgress(observation.event.data);
      if (progress) {
        const connectionGeneration = observation.connectionGeneration;
        this.toolProgress.set(json([connectionGeneration, progress.turnId, progress.callId]), { ...progress, connectionGeneration });
      }
    }
    if (observation.type === 'turn') {
      this.turns.set(observation.turn.turnId, observation.turn);
      if (observation.turn.status === 'running') this.activeTurnId = observation.turn.turnId;
      else if (observation.turn.turnId === this.activeTurnId) this.activeTurnId = null;
    }
    const state = this.getRunnerState();
    const terminal = (observation.type === 'turn' && isTerminalTurn(observation.turn.status)) ||
      (observation.type === 'message' && observation.message.final) ||
      (observation.type === 'interaction' && !isPending(observation.interaction));
    try { this.context.emit(observation, { terminal, state }); } catch (error) {
      if (error instanceof HostError && error.code === 'temporarily_unavailable') return;
      throw error;
    }
    this.updateContinuity(state, json(state));
  }

  private updateContinuity(state: HostedRunnerState, encoded: string): void {
    const data = state.data as HostedLiveSnapshot | null;
    this.continuity = {
      activeTurnId: data?.activeTurnId ?? null, pendingInteractionCount: state.pendingInteractions,
      nativeActive: !!this.ref && this.adapter.hasActiveNativeSession?.(this.ref) === true,
    };
    this.lastState = encoded;
  }

  getRunnerState(): HostedRunnerState {
    if (!this.ref) return { ...idleRunnerState, pendingInteractions: 0, residualStatus: 'none',
      connectionGeneration: null, controlGeneration: 0 };
    const state = this.inspect(this.ref);
    const turns = new Map(this.turns);
    for (const turn of state.turns ?? []) turns.set(turn.turnId, turn);
    const messages = new Map(this.messages);
    for (const message of state.messages ?? []) messages.set(message.messageId, message);
    const interactions = new Map(this.interactions);
    for (const interaction of state.interactions ?? []) interactions.set(interaction.interactionId, interaction);
    const activeTurnId = state.activeTurnId === undefined ? this.activeTurnId : state.activeTurnId;
    const pending = [...interactions.values()].filter(isPending);
    const pendingInteractions = pending.length + (state.pendingNativeRequests ?? 0);
    let session = state.session ?? this.session;
    if (session?.control.owner && this.adapter.hasActiveNativeSession?.(this.ref) === false) session = {
      ...session, status: 'read_only', control: { ...session.control, owner: null, input: 'unavailable' },
    };
    if (session?.control.owner && session.status !== 'failed') session = {
      ...session, status: pending.some(i => i.kind === 'approval') ? 'waiting_approval' :
        pending.length ? 'waiting_question' : activeTurnId ? 'running' : 'idle',
    };
    const data: HostedLiveSnapshot = {
      session, turns: [...turns.values()], messages: [...messages.values()], interactions: [...interactions.values()],
      toolProgress: [...this.toolProgress.values()],
      activeTurnId, connectionGeneration: state.connectionGeneration ?? this.connectionGeneration,
      controlGeneration: state.controlGeneration ?? session?.control.generation ?? 0,
      hasResidual: state.hasResidual === true, residualUnknown: this.lostWork || state.residualUnknown === true,
    };
    const residualStatus = data.hasResidual ? 'running' : data.residualUnknown ? 'unknown' : 'none';
    return {
      activeTurn: activeTurnId !== null, pendingInteraction: pendingInteractions ? pending : null,
      pendingWakeup: state.pendingWakeup === true, pendingSubagent: state.pendingSubagent === true,
      residual: residualStatus, residualStatus, pendingInteractions, data,
      connectionGeneration: data.connectionGeneration, controlGeneration: data.controlGeneration,
    };
  }

  validateCommand({ kind, args, attachment }: RunnerCommand): void {
    const value = object(args);
    if (attachment !== null && kind !== 'input') throw new HostError('invalid_request', 'unexpected attachment');
    if (guardedCommands.has(kind)) {
      counter(value.expectedControlGeneration, 'control generation');
      if (value.expectedConnectionGeneration !== null) counter(value.expectedConnectionGeneration, 'connection generation', 1);
    } else if (kind !== 'create' && !readCommands.has(kind)) {
      throw new HostError('invalid_request', 'unknown provider command');
    }
    switch (kind) {
      case 'create':
        string(value.cwd, 'cwd');
        if (value.model !== null) string(value.model, 'model');
        break;
      case 'input':
        if (value.mode !== 'new' && value.mode !== 'steer') throw new HostError('invalid_request', 'invalid input mode');
        if (value.turnId !== undefined) string(value.turnId, 'turnId');
        decodeBlocks(value.blocks, attachment);
        break;
      case 'inspectTurnResidual':
      case 'interrupt':
        string(value.turnId, 'turnId');
        break;
      case 'control':
        if (value.action !== 'acquire' && value.action !== 'release') throw new HostError('invalid_request', 'invalid control action');
        break;
      case 'archive':
        if (typeof value.archived !== 'boolean') throw new HostError('invalid_request', 'invalid archived flag');
        break;
      case 'respond':
        object(value.interaction);
        object(value.answer);
        break;
      case 'updateSettings': {
        const settings = object(value.settings);
        if (settings.model !== null) string(settings.model, 'model');
        if (Object.values(object(settings.preferences)).some(v => typeof v !== 'string')) {
          throw new HostError('invalid_request', 'invalid preferences');
        }
        break;
      }
      case 'readArtifact':
        string(value.artifactId, 'artifactId');
        string(value.contentVersion, 'contentVersion');
    }
  }

  async execute(command: RunnerCommand, context: RunnerContext): Promise<unknown> {
    try {
      const result = await this.dispatch(command, context);
      this.refreshState();
      return result;
    } catch (error) {
      this.refreshState();
      // A deterministic provider rejection is a durable receipt. An ambiguous write
      // must reach Stage 1 so its journal preserves an unknown outcome.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (isContractCode(code) && code !== 'outcome_unknown') {
        const detail = error as { message?: unknown };
        return { providerRejection: { code, ...(typeof detail.message === 'string' ? { message: detail.message.slice(0, 4096) } : {}) } };
      }
      throw error;
    }
  }

  private mergeHistory(history: SessionSnapshot): void {
    if (!this.session?.control.owner) this.session = history.session;
    this.connectionGeneration = history.connectionGeneration ?? this.connectionGeneration;
    for (const turn of history.turns ?? []) if (!this.turns.has(turn.turnId)) {
      this.turns.set(turn.turnId, turn);
      if (turn.status === 'running') this.activeTurnId ??= turn.turnId;
    }
    for (const message of history.messages) if (!this.messages.has(message.messageId)) this.messages.set(message.messageId, message);
    for (const interaction of history.interactions) if (!this.interactions.has(interaction.interactionId)) {
      this.interactions.set(interaction.interactionId, interaction);
    }
  }

  private async dispatch(command: RunnerCommand, context: RunnerContext): Promise<unknown> {
    const { kind } = command;
    const args = object(command.args);
    const adapter = this.adapter;
    if (kind === 'snapshot') return this.getRunnerState().data;
    if (kind === 'create') {
      if (this.ref) throw contractError('invalid_request', 'host is already bound');
      await this.connectProvider();
      this.creating = [];
      try {
        const acknowledgement = await adapter.create(args.cwd as string, args.model as string | null);
        if (!acknowledgement.nativeReference) throw contractError('outcome_unknown', 'provider did not return native session ID');
        this.ref = nativeRef(context.bindNativeSession(acknowledgement.nativeReference));
        this.session = acknowledgement.createdSession ?? null;
        this.connectionGeneration = acknowledgement.connectionGeneration ?? null;
        const buffered = this.creating;
        this.creating = undefined;
        for (const observation of buffered) this.observe(observation);
        return acknowledgement;
      } finally {
        this.creating = undefined;
      }
    }
    const ref = this.ref;
    if (!ref) throw contractError('invalid_request', 'host has no native session');
    if (kind === 'resume') {
      if (adapter.hasActiveNativeSession?.(ref)) {
        const generation = this.inspect(ref).connectionGeneration ?? this.connectionGeneration;
        return { status: 'submitted', nativeReference: ref.nativeSessionId,
          ...(generation === null ? {} : { connectionGeneration: generation }) };
      }
      await this.connectProvider();
      const acknowledgement = await adapter.resume(ref);
      this.connectionGeneration = acknowledgement.connectionGeneration ?? this.connectionGeneration;
      // History is a baseline. Observations received while reading take precedence.
      try { this.mergeHistory(await adapter.read(ref)); } catch { /* Live observations still form a usable snapshot. */ }
      return acknowledgement;
    }

    const guard: DispatchGuard = {
      operationId: command.operationId,
      expectedControlGeneration: args.expectedControlGeneration as number,
      expectedConnectionGeneration: args.expectedConnectionGeneration as number | null,
      assertCurrent: () => {
        const state = this.getRunnerState().data as HostedLiveSnapshot;
        if (guard.expectedControlGeneration !== state.controlGeneration ||
            guard.expectedConnectionGeneration !== null && guard.expectedConnectionGeneration !== state.connectionGeneration) {
          throw contractError('control_conflict');
        }
      },
    };
    if (kind === 'input' && args.mode === 'steer' && this.steer === 'unsupported') throw contractError('unsupported');
    if (guardedCommands.has(kind)) guard.assertCurrent();
    switch (kind) {
      case 'input': return adapter.input(ref, args.mode as 'new' | 'steer', decodeBlocks(args.blocks, command.attachment), guard, args.turnId as string | undefined);
      case 'interrupt': return adapter.interrupt(ref, args.turnId as string, guard);
      case 'respond': return adapter.respond(ref, args.interaction as Interaction, args.answer as Answer, guard);
      case 'updateSettings': return adapter.updateSettings(ref, args.settings as Parameters<PlatformPort['updateSettings']>[1], guard);
      case 'control':
        if (args.action === 'acquire') await this.connectProvider();
        return adapter.control(ref, args.action as 'acquire' | 'release', guard);
      case 'archive':
        if (adapter.archive) return adapter.archive(ref, args.archived as boolean, guard);
        break;
      case 'inspectTurnResidual':
        if (adapter.inspectTurnResidual) return adapter.inspectTurnResidual(ref, args.turnId as string);
        break;
      case 'listModels':
        await this.connectProvider();
        return adapter.listModels(ref);
      case 'getContextUsage': return await adapter.getContextUsage?.(ref) ?? null;
      case 'listArtifacts': return adapter.listArtifacts(ref);
      case 'readArtifact': return Buffer.from(await adapter.readArtifact(ref, args.artifactId as string, args.contentVersion as string)).toString('base64');
      case 'read':
        await this.connectProvider();
        return adapter.read(ref);
    }
    throw contractError('unsupported');
  }

  async stop(): Promise<void> {
    delete this.context;
    this.unsubscribe?.();
    await this.adapter.close?.();
  }
}
