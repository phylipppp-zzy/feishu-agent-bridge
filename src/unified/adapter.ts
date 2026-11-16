import type { Artifact, Capabilities, ControlState, EventSubscription, Interaction, Message, Operation, Page, Provider, ResolveInteraction, Session, SessionSnapshot, Snapshot, SubmitInput, WriteContext, Turn, NativeSessionRef, Answer, Event } from './contracts.js';

export interface ListQuery { cursor?: string; limit: number; search?: string }
export interface WriteRequest<T> { context: WriteContext; payload: T }
/** Unified service contract. Implementations must persist receipts and enforce idempotency atomically. */
export interface UnifiedService {
  listSessions(query: ListQuery): Promise<Page<Session>>;
  getSession(sessionId: string): Promise<Session>;
  capabilities(sessionId: string): Promise<Capabilities>;
  attachSession(request: WriteRequest<{ provider: Provider; hostId: string; serviceId: string; nativeSessionId: string; mode: 'read_only' | 'interactive' }>): Promise<Operation>;
  detachSession(request: WriteRequest<Record<string, never>>): Promise<Operation>;
  createSession(request: WriteRequest<{ provider: Provider; project: string; model: string | null }>): Promise<Operation>;
  readHistory(sessionId: string, query: ListQuery): Promise<Page<Message>>;
  getSnapshot(sessionId: string): Promise<Snapshot<SessionSnapshot>>;
  subscribeEvents(sessionId: string, cursor: string, limit: number): Promise<EventSubscription>;
  getWorkState(sessionId:string): Promise<{runningTurns:Turn[];queuedInputs:Array<{inputId:string}>;canArchive:boolean}>;
  submitInput(request: SubmitInput): Promise<Operation>;
  listInteractions(sessionId: string, query: ListQuery): Promise<Page<Interaction>>;
  getInteraction(interactionId: string): Promise<Interaction>;
  resolveInteraction(request: ResolveInteraction): Promise<Operation>;
  interruptTurn(request: WriteRequest<{ turnId: string }>): Promise<Operation>;
  cancelQueuedInput(request: WriteRequest<{ inputId: string }>): Promise<Operation>;
  getControlState(sessionId: string): Promise<ControlState>;
  requestControl(request: WriteRequest<{ owner: string; strategy: 'wait' | 'interrupt' }>): Promise<Operation>;
  releaseControl(request: WriteRequest<{ owner: string }>): Promise<Operation>;
  listArtifacts(sessionId: string, query: ListQuery): Promise<Page<Artifact>>;
  readArtifact(sessionId: string, artifactId: string, contentVersion: string): Promise<Uint8Array>;
  stageInputArtifact(request: WriteRequest<{ name: string; mediaType: string; size: number; contentDigest: string; content: Uint8Array }>): Promise<Operation>;
  listModels(sessionId: string, query: ListQuery): Promise<Page<{ id: string; label: string }>>;
  updateSessionSettings(request: WriteRequest<{ model: string | null; preferences: Record<string, string> }>): Promise<Operation>;
  getOperation(operationId: string): Promise<Operation>;
  reconcile(operationId: string): Promise<Operation>;
  setNotificationSubscription(request: WriteRequest<{ enabled: boolean; eventTypes: string[] }>): Promise<Operation>;
  health(): Promise<Array<{ backlog: number | null; lastDeliveryAt: string | null; component: string; status: 'healthy' | 'degraded' | 'unreachable'; updatedAt: string; reason: string | null }>>;
  archiveSession(request: WriteRequest<{ archived: boolean }>): Promise<Operation>;
}
/** Provider-facing boundary. Core owns authentication, CAS, durable receipts,
 * queues, event ordering/snapshots and notification subscriptions. RPC completion
 * is an acknowledgement, not a persisted Operation or interaction resolution.
 * Unsupported provider capabilities must reject with the stable unsupported error. */
export type PlatformAcknowledgement = { status: 'submitted'; nativeReference: string | null; createdSession?: Session; connectionGeneration?: number; settingsApplied?: true }; 
/** Each observation carries its native ref for core's durable ID mapping.
 * Object sessionId may be a temporary native identifier; core replaces it using ref.
 * Provider message revision may use a stable native item ID and native event sequence;
 * after reconnect core reconciles snapshot revisions and assigns durable cursors. */
export type PlatformObservation =
  | { type: 'connection'; ref: NativeSessionRef; connectionGeneration: number }
  | { type: 'session'; ref: NativeSessionRef; session: Session }
  | { type: 'turn'; ref: NativeSessionRef; turn: Turn }
  | { type: 'message'; ref: NativeSessionRef; message: Message }
  | { type: 'interaction'; ref: NativeSessionRef; interaction: Interaction }
  | { type: 'event'; ref: NativeSessionRef; event: Event };
/** Core holds the session dispatch lock through provider submission. Provider calls
 * assertCurrent immediately before the SDK/socket write; throw aborts submission.
 * External native clients are outside this lock and still require native arbitration. */
export interface DispatchGuard { expectedControlGeneration: number; expectedConnectionGeneration: number | null; assertCurrent(): void }
export type PlatformInputBlock = {type:'text'; text:string} | {type:'artifact'; artifactId:string; contentVersion:string; name:string; mediaType:string; content:Uint8Array};
export interface PlatformPort {
  readonly provider: Provider;
  close?(): Promise<void>;
  seedConnectionGeneration?(minimum: number): void;
  seedControlGeneration?(ref: NativeSessionRef, minimum: number): void;
  list(cursor: string | null, limit: number): Promise<Page<Session>>;
  read(ref: NativeSessionRef): Promise<SessionSnapshot>;
  resume(ref: NativeSessionRef): Promise<PlatformAcknowledgement>;
  create(cwd: string, model: string | null): Promise<PlatformAcknowledgement>;
  /** For input, nativeReference must be the resulting turn ID, or null if not provable. */
  input(ref: NativeSessionRef, mode: 'new' | 'steer', blocks: PlatformInputBlock[], guard: DispatchGuard, turnId?: string): Promise<PlatformAcknowledgement>;
  interrupt(ref: NativeSessionRef, turnId: string, guard: DispatchGuard): Promise<PlatformAcknowledgement>;
  respond(ref: NativeSessionRef, interaction: Interaction, answer: Answer, guard: DispatchGuard): Promise<PlatformAcknowledgement>;
  onObservation(listener: (observation: PlatformObservation) => void): () => void;
  listArtifacts(ref: NativeSessionRef): Promise<Artifact[]>;
  readArtifact(ref: NativeSessionRef, artifactId: string, contentVersion: string): Promise<Uint8Array>;
  listModels(ref: NativeSessionRef): Promise<Array<{ id: string; label: string }>>;
  updateSettings(ref: NativeSessionRef, settings: { model: string | null; preferences: Record<string, string> }, guard: DispatchGuard): Promise<PlatformAcknowledgement>;
  control(ref: NativeSessionRef, action: 'acquire' | 'release', guard: DispatchGuard): Promise<PlatformAcknowledgement>;
  archive?(ref: NativeSessionRef, archived: boolean, guard: DispatchGuard): Promise<PlatformAcknowledgement>;
}
/** Compatibility name for the provider port, not the core service. */
export type AgentAdapter = PlatformPort;
