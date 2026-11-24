import type { DirectoryListing } from '../claude/deliver.js';
import type { ModelOption, ConfirmedSettings, ResponseEvidence } from './contracts.js';
import type { Artifact, Capabilities, ControlState, EventSubscription, Interaction, Message, Operation, Page, Provider, ResolveInteraction, Session, SessionSnapshot, Snapshot, SubmitInput, WriteContext, Turn, NativeSessionRef, Answer, Event, TurnResidual, CandidateMetadata } from './contracts.js';

export interface ListQuery { cursor?: string; limit: number; search?: string; provider?: Provider | 'all'; stable?: boolean }
export interface WriteRequest<T> { context: WriteContext; payload: T }
export type { ResponseEvidence } from './contracts.js';
/** Unified service contract. Implementations must persist receipts and enforce idempotency atomically. */
export interface UnifiedService {
  hasProvider?(provider: Provider): boolean;
  listSessions(query: ListQuery): Promise<Page<Session>>;
  unknownCreateProvider?(identity:{source:string;subject:string},destination:string,operationId:string):Promise<Provider|null>;
  inspectUnknownCreateCandidates?(identity:{source:string;subject:string},destination:string,operationId:string,query:{cursor?:string;nativeId?:string}):Promise<{items:CandidateMetadata[];nextCursor:string|null;partial:boolean}>;
  getSession(sessionId: string): Promise<Session>;
  capabilities(sessionId: string): Promise<Capabilities>;
  attachSession(request: WriteRequest<{ provider: Provider; hostId: string; serviceId: string; nativeSessionId: string; mode: 'read_only' | 'interactive' }>): Promise<Operation>;
  detachSession(request: WriteRequest<Record<string, never>>): Promise<Operation>;
  createSession(request: WriteRequest<{ provider: Provider; project: string; model: string | null }>): Promise<Operation>;
  readHistory(sessionId: string, query: ListQuery): Promise<Page<Message>>;
  listProjectFiles?(sessionId:string, directory:string, showHidden:boolean):Promise<DirectoryListing>;
  selectProjectFiles?(sessionId:string, args:string):Promise<Artifact[]>;
  getSnapshot(sessionId: string): Promise<Snapshot<SessionSnapshot>>;
  initialCursor?(sessionId:string):Promise<string>;
  subscribeEvents(sessionId: string, cursor: string, limit: number): Promise<EventSubscription>;
  getTurn?(sessionId:string,turnId:string):Promise<Turn|null>;
  hasStopRequest?(sessionId:string,turnId:string):Promise<boolean>;
  getWorkState(sessionId:string): Promise<{runningTurns:Turn[];queuedInputs:Array<{inputId:string}>;canArchive:boolean}>;
  submitInput(request: SubmitInput): Promise<Operation>;
  captureSteer?(identity:{source:string;subject:string},sessionId:string):Promise<{turnId:string;connectionGeneration:number;controlGeneration:number}>;
  listInteractions(sessionId: string, query: ListQuery): Promise<Page<Interaction>>;
  getInteraction(interactionId: string): Promise<Interaction>;
  getResponseOperation?(interactionId: string): Promise<Operation | null>;
  resolveInteraction(request: ResolveInteraction): Promise<Operation>;
  interruptTurn(request: WriteRequest<{ turnId: string }>): Promise<Operation>;
  inspectTurnResidual?(sessionId:string,turnId:string):Promise<TurnResidual>;
  cancelQueuedInput(request: WriteRequest<{ inputId: string }>): Promise<Operation>;
  getControlState(sessionId: string): Promise<ControlState>;
  requestControl(request: WriteRequest<{ owner: string; strategy: 'wait' | 'interrupt' }>): Promise<Operation>;
  releaseControl(request: WriteRequest<{ owner: string }>): Promise<Operation>;
  listArtifacts(sessionId: string, query: ListQuery): Promise<Page<Artifact>>;
  readArtifact(sessionId: string, artifactId: string, contentVersion: string): Promise<Uint8Array>;
  stageInputArtifact(request: WriteRequest<{ name: string; mediaType: string; size: number; contentDigest: string; content: Uint8Array }>): Promise<Operation>;
  getConfirmedSettings?(sessionId: string): Promise<ConfirmedSettings | null>;
  listModels(sessionId: string, query: ListQuery): Promise<Page<ModelOption>>;
  updateSessionSettings(request: WriteRequest<{ model: string | null; preferences: Record<string, string> }>): Promise<Operation>;
  getOperation(operationId: string): Promise<Operation>;
  reconcile(operationId: string): Promise<Operation>;
  setNotificationSubscription(request: WriteRequest<{ enabled: boolean; eventTypes: string[] }>): Promise<Operation>;
  health(): Promise<Array<{ backlog: number | null; lastDeliveryAt: string | null; component: string; status: 'healthy' | 'degraded' | 'unreachable' | 'unverified'; updatedAt: string | null; reason: string | null; lastObservedAt?:string|null; lastSuccessAt?:string|null; lastFailureAt?:string|null; lastFailureReason?:string|null; unknown?:number|null }>>;
  archiveSession(request: WriteRequest<{ archived: boolean }>): Promise<Operation>;
}
/** Provider-facing boundary. Core owns authentication, CAS, durable receipts,
 * queues, event ordering/snapshots and notification subscriptions. RPC completion
 * is an acknowledgement, not a persisted Operation or interaction resolution.
 * Unsupported provider capabilities must reject with the stable unsupported error. */
export type PlatformAcknowledgement = { status: 'submitted'; nativeReference: string | null; createdSession?: Session; connectionGeneration?: number; settingsApplied?: true }; 
/** Each observation carries its native ref for core's durable ID mapping.
 * Object sessionId must be the ref nativeSessionId or the corresponding unified sessionId; core validates it before mapping.
 * Provider message revision may use a stable native item ID and native event sequence;
 * after reconnect core reconciles snapshot revisions and assigns durable cursors. */
export type PlatformObservation =
  | { type: 'connection'; ref: NativeSessionRef; connectionGeneration: number }
  | { type: 'session'; ref: NativeSessionRef; session: Session }
  | { type: 'turn'; ref: NativeSessionRef; turn: Turn; connectionGeneration?:number }
  | { type: 'message'; ref: NativeSessionRef; message: Message; connectionGeneration?: number }
  | { type: 'interaction'; ref: NativeSessionRef; interaction: Interaction; responseEvidence?: ResponseEvidence }
  | { type: 'event'; ref: NativeSessionRef; event: Event; connectionGeneration?:number };
/** Core holds the session dispatch lock through provider submission. Provider calls
 * assertCurrent immediately before the SDK/socket write; throw aborts submission.
 * External native clients are outside this lock and still require native arbitration. */
export interface DispatchGuard { operationId?: string; expectedControlGeneration: number; expectedConnectionGeneration: number | null; assertCurrent(): void }
export type PlatformInputBlock = {type:'text'; text:string} | {type:'artifact'; artifactId:string; contentVersion:string; name:string; mediaType:string; content:Uint8Array};
export interface PlatformPort {
  readonly provider: Provider;
  candidateGeneration?():number|null;
  listCandidateIds?(cursor:string|null,limit:number):Promise<{items:string[];nextCursor:string|null;partial?:boolean}>;
  readCandidateMetadata?(id:string):Promise<CandidateMetadata>;
  close?(): Promise<void>;
  seedConnectionGeneration?(minimum: number): void;
  seedControlGeneration?(ref: NativeSessionRef, minimum: number): void;
  /** A live provider connection holds this exact ref, even when native listing omits it. */
  hasActiveNativeSession?(ref: NativeSessionRef): boolean;
  list(cursor: string | null, limit: number): Promise<Page<Session>>;
  discoverExisting?(cursor:string|null,limit:number):Promise<Page<Session>>;
  readAutoActivity?(ref:NativeSessionRef,watermark:number,observed:number):Promise<{status:'proven'|'unknown'|'future';snapshot?:SessionSnapshot;oldMessageIds?:string[];newMessageIds?:string[];oldTurns?:Turn[]}>;
  discoverRunning?(cursor: string | null, limit: number): Promise<Page<Session>>;
  discoverNewer?(watermark:number,cursor:string|null,limit:number):Promise<Page<Session>>;
  read(ref: NativeSessionRef): Promise<SessionSnapshot>;
  resume(ref: NativeSessionRef): Promise<PlatformAcknowledgement>;
  create(cwd: string, model: string | null): Promise<PlatformAcknowledgement>;
  /** For input, nativeReference must be the resulting turn ID, or null if not provable. */
  input(ref: NativeSessionRef, mode: 'new' | 'steer', blocks: PlatformInputBlock[], guard: DispatchGuard, turnId?: string): Promise<PlatformAcknowledgement>;
  interrupt(ref: NativeSessionRef, turnId: string, guard: DispatchGuard): Promise<PlatformAcknowledgement>;
  inspectTurnResidual?(ref:NativeSessionRef,turnId:string):Promise<TurnResidual>;
  respond(ref: NativeSessionRef, interaction: Interaction, answer: Answer, guard: DispatchGuard): Promise<PlatformAcknowledgement>;
  onObservation(listener: (observation: PlatformObservation) => void): () => void;
  listProjectFiles?(ref:NativeSessionRef, directory:string, showHidden:boolean):Promise<DirectoryListing>;
  selectProjectFiles?(ref:NativeSessionRef, args:string):Promise<Artifact[]>;
  listArtifacts(ref: NativeSessionRef): Promise<Artifact[]>;
  readArtifact(ref: NativeSessionRef, artifactId: string, contentVersion: string): Promise<Uint8Array>;
  listModels(ref: NativeSessionRef): Promise<ModelOption[]>;
  updateSettings(ref: NativeSessionRef, settings: { model: string | null; preferences: Record<string, string> }, guard: DispatchGuard): Promise<PlatformAcknowledgement>;
  control(ref: NativeSessionRef, action: 'acquire' | 'release', guard: DispatchGuard): Promise<PlatformAcknowledgement>;
  archive?(ref: NativeSessionRef, archived: boolean, guard: DispatchGuard): Promise<PlatformAcknowledgement>;
}
/** Compatibility name for the provider port, not the core service. */
export type AgentAdapter = PlatformPort;
