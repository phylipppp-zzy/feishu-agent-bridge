import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { resolve, dirname, basename, join, relative, isAbsolute, sep } from 'node:path';
import { realpathSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { HistoryArchive } from './history-archive.js';
import type { MigrationManifest } from './migration.js';
import { encodeCursor, UnifiedStore } from './store.js';
import { UnifiedCore } from './service.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { codexFilesystemProof, isLocalCodexEndpoint, runtimeApprovalScope } from './codex-approval.js';
import { CodexAdapter } from './codex-adapter.js';
import { CodexTransport } from './codex-transport.js';
import { FeishuChannel, type ChannelAction, type FeishuPort, type TrustedEnvelope } from './feishu-channel.js';
import type { PlatformPort, PlatformObservation } from './adapter.js';
import { contractError } from './errors.js';
import { FeishuSdkPort } from './feishu-sdk-port.js';
import { LocalCatalog, type CatalogRoot } from './local-catalog.js';
import { TestLaneRuntime } from './test-lane.js';
import { ArtifactRegistry } from './artifact-registry.js';
import { EnrichedPort, nativeRefKey } from './port-enrichment.js';
import { localFileLinks } from '../claude/deliver.js';
import { payloadDigest, type Identity, type Session, type Message, type Provider } from './contracts.js';
import { AgyAdapter } from './agy-adapter.js';
import { AgyCatalog } from './agy-catalog.js';
import { AgyQuotaClient, type AgyQuotaSnapshot } from './agy-quota.js';
import { AgyAcpTransport } from './agy-transport.js';
import { agyFileFingerprint } from './agy/catalog-summaries.js';
import { resolveAgySummariesDbPaths } from './agy/catalog-types.js';
import { defaultAgyConversationsDir } from './agy/process-guard.js';
import { AgyCliWaitingDetector } from './agy/cli-waiting-detector.js';
import { readReadonlyAgyLiveTurn } from './agy/readonly-live-turn.js';
import { collectAgyStatusSnapshot } from './agy/session-status.js';
import { providerTitlePrefix } from './feishu-cards.js';
import { DecisionSyncStore } from './decision-sync.js';
import { PendingHub, type PendingQuery } from './pending-hub.js';
import { readWaitingClaudePresence } from './hubs/pending-discovery.js';
import type { PendingCliNotice } from './hubs/pending-types.js';
import { TaskHandoffService } from './task-handoff.js';
import { TaskTopicChannel, TaskChannelError, type TaskAuthorize, type TaskChannelAction } from './task-topic-channel.js';
import type { TaskTopicToken } from './task-topic-store.js';
import { handleTaskControlAction, handleTaskHandoffConfirmation, isTaskControlAction } from './task-topic/control-plane.js';
import { WatchHub } from './watch-hub.js';
import type { WatchSeverity, WatchSource, WatchSourceRef, WatchState } from './hubs/watch-types.js';
import { UsageHub } from './hubs/usage-hub.js';
import type { UsageDashboardPayload } from './hubs/usage-cards.js';
import { RuntimeInteractive } from './runtime-interactive.js';
import { runBackgroundWork } from './runtime-background.js';
import { handlePendingAction } from './runtime-pending-actions.js';

export interface AgyRuntimeConfig {
  enabled?: boolean;
  serviceId: string;
  summariesDbPath?: string;
  brainDir?: string;
  conversationsDir?: string;
  binPath?: string;
  quotaCachePath?: string;
  sandbox?: boolean;
  geminiDir?: string;
  appDataDir?: string;
  processPerSession?: boolean;
  defaultMode?: 'plan' | 'accept-edits' | 'auto';
  addDirs?: string[];
  extraArgs?: string[];
  defaultModel?: string;
  extraWriteRoots?: string[];
}
export interface WatchHubRuntimeConfig { enabled:boolean; destination:string; dbPath?:string }
export interface PendingHubRuntimeConfig { enabled:boolean; destination:string; dbPath?:string }
export interface DecisionSyncRuntimeConfig { enabled:boolean; dbPath?:string; markdownPath?:string; protectedReadOnlyPaths?:string[] }
export interface UsageHubRuntimeConfig { enabled:boolean; destination:string; dbPath?:string; intervalMinutes?:number; snapshotPath?:string; exportScriptPath?:string; toolsBinPath?:string; pythonBinPath?:string; webUrl?:string }
export interface RuntimeConfig { coreDb:string; channelDb:string; ownerOpenId:string; allowedDestinations:string[]; hostId:string; claudeServiceId:string; codexServiceId:string; claudeStateDir:string; codexEndpoint:string; intervalMs:number; agy?:AgyRuntimeConfig; catalogSources?:CatalogRoot[]; allowedProjectRoots?:string[]; outputRoots?:string[]; approvalPolicy?:{enabled?:boolean;extraTrustedRoots?:string[];extraWriteRoots?:string[];codexSharedFilesystem?:boolean;homeDir?:string}; artifactStatePath?:string; historyArchive?:{root:string;manifestPath:string;manifestSha256:string}; autoMirror?:{enabled:boolean;destination?:string;showTitles?:boolean;backfillNativeIds?:Array<{provider:Provider;nativeSessionId:string;replayHistory?:boolean}>}; autoTakeControlOnInput?:boolean; autoResumeOnRestart?:boolean; taskTopic?:{enabled:boolean}; watchHub?:WatchHubRuntimeConfig; pendingHub?:PendingHubRuntimeConfig; decisionSync?:DecisionSyncRuntimeConfig; usageHub?:UsageHubRuntimeConfig; testLane?:{stateDir:string;nativeClaude?:boolean;nativeCodex?:boolean;nativeTTLMinutes?:number} }
export type PendingHubEntry = 'hub' | 'source' | 'pending_hub';
export type RuntimeTrustedAction =
  | ChannelAction
  | TaskChannelAction
  | (Extract<ChannelAction, { action: 'answer' | 'answer_form' }> & {
      entry?: PendingHubEntry;
      sourceSessionId?: string;
      category?: 'question' | 'approval';
    })
  | {
      action: 'confirm_handoff';
      handoffId: string;
      taskId: string;
      previewDigest: string;
      targetGeneration: number;
      activeRevision: number;
    }
  | {
      action: 'decision_answer';
      decisionId: string;
      expectedVersion: number;
      expectedDigest: string;
      selectedOptionId?: string | null;
      freeText?: string | null;
      rawUtterance?: string;
      entry?: PendingHubEntry;
      category?: 'business_decision' | 'execution_auth';
      sourceSessionId?: string;
      bindingId?: string;
    }
  | {
      action: 'pending_page';
      cursor?: string;
      category?: PendingQuery['category'];
      provider?: PendingQuery['provider'];
    }
  | {
      action: 'usage_report';
      trigger: 'message' | 'card';
      range?: 'today' | 'd7' | 'd30';
      rawText?: string;
    };
/** Pure validation: never reads environment, opens a database, connects or sends. */
export function validateRuntimeConfig(c:RuntimeConfig):void {
  if (!c || ![c.coreDb,c.channelDb,c.ownerOpenId,c.hostId,c.claudeServiceId,c.codexServiceId,c.claudeStateDir,c.codexEndpoint].every(x=>typeof x==='string' && !!x.trim()) || !Array.isArray(c.allowedDestinations) || !c.allowedDestinations.length || !c.allowedDestinations.every(x=>typeof x==='string' && !!x.trim()) || c.coreDb===c.channelDb || c.channelDb===':memory:' || !Number.isSafeInteger(c.intervalMs) || c.intervalMs<100) throw new Error('invalid runtime configuration');
  if (c.agy !== undefined) {
    if (!c.agy || typeof c.agy !== 'object' || Array.isArray(c.agy) || typeof c.agy.serviceId !== 'string' || !c.agy.serviceId.trim()) throw new Error('invalid agy configuration');
    if (c.agy.enabled !== undefined && typeof c.agy.enabled !== 'boolean') throw new Error('invalid agy configuration');
    if (c.agy.sandbox !== undefined && typeof c.agy.sandbox !== 'boolean') throw new Error('invalid agy configuration');
    if (c.agy.processPerSession !== undefined && typeof c.agy.processPerSession !== 'boolean') throw new Error('invalid agy configuration');
    if (c.agy.defaultMode !== undefined && !['plan', 'accept-edits', 'auto'].includes(c.agy.defaultMode)) throw new Error('invalid agy configuration');
    if (c.agy.defaultModel !== undefined && (typeof c.agy.defaultModel !== 'string' || !c.agy.defaultModel.trim())) throw new Error('invalid agy configuration');
    if (c.agy.extraArgs !== undefined && (!Array.isArray(c.agy.extraArgs) || !c.agy.extraArgs.every(x => typeof x === 'string' && !!x && !x.includes('\0')))) throw new Error('invalid agy configuration');
    for (const dirs of [c.agy.addDirs, c.agy.extraWriteRoots]) {
      if (dirs !== undefined && (!Array.isArray(dirs) || !dirs.every(x => typeof x === 'string' && isAbsolute(x) && !x.includes('\0')))) throw new Error('invalid agy configuration');
    }
    if (c.agy.binPath !== undefined && (typeof c.agy.binPath !== 'string' || !c.agy.binPath.trim())) throw new Error('invalid agy configuration');
    for (const p of [c.agy.summariesDbPath,c.agy.brainDir,c.agy.quotaCachePath,c.agy.geminiDir,c.agy.appDataDir]) {
      if (p !== undefined && (typeof p !== 'string' || !isAbsolute(p))) throw new Error('invalid agy configuration');
    }
  }
  if(c.taskTopic && typeof c.taskTopic.enabled!=='boolean')throw new Error('invalid task topic configuration');
  if (c.watchHub !== undefined) {
    if (!c.watchHub || typeof c.watchHub !== 'object' || Array.isArray(c.watchHub) || typeof c.watchHub.enabled !== 'boolean') throw new Error('invalid watch hub configuration');
    if (c.watchHub.destination !== undefined && typeof c.watchHub.destination !== 'string') throw new Error('invalid watch hub configuration');
    if (c.watchHub.enabled && (!c.watchHub.destination?.trim() || !c.allowedDestinations.includes(c.watchHub.destination))) throw new Error('invalid watch hub configuration');
    if (c.watchHub.dbPath !== undefined && (typeof c.watchHub.dbPath !== 'string' || !isAbsolute(c.watchHub.dbPath))) throw new Error('invalid watch hub configuration');
  }
  if (c.pendingHub !== undefined) {
    if (!c.pendingHub || typeof c.pendingHub !== 'object' || Array.isArray(c.pendingHub) || typeof c.pendingHub.enabled !== 'boolean') throw new Error('invalid pending hub configuration');
    if (c.pendingHub.destination !== undefined && typeof c.pendingHub.destination !== 'string') throw new Error('invalid pending hub configuration');
    if (c.pendingHub.enabled && (!c.pendingHub.destination?.trim() || !c.allowedDestinations.includes(c.pendingHub.destination))) throw new Error('invalid pending hub configuration');
    if (c.pendingHub.dbPath !== undefined && (typeof c.pendingHub.dbPath !== 'string' || !isAbsolute(c.pendingHub.dbPath))) throw new Error('invalid pending hub configuration');
  }
  if (c.decisionSync !== undefined) {
    if (!c.decisionSync || typeof c.decisionSync !== 'object' || Array.isArray(c.decisionSync) || typeof c.decisionSync.enabled !== 'boolean') throw new Error('invalid decision sync configuration');
    if (c.decisionSync.dbPath !== undefined && (typeof c.decisionSync.dbPath !== 'string' || !isAbsolute(c.decisionSync.dbPath))) throw new Error('invalid decision sync configuration');
    if (c.decisionSync.markdownPath !== undefined && (typeof c.decisionSync.markdownPath !== 'string' || !isAbsolute(c.decisionSync.markdownPath))) throw new Error('invalid decision sync configuration');
    if (c.decisionSync.protectedReadOnlyPaths !== undefined && (!Array.isArray(c.decisionSync.protectedReadOnlyPaths) || !c.decisionSync.protectedReadOnlyPaths.every(p => typeof p === 'string' && isAbsolute(p)))) throw new Error('invalid decision sync configuration');
  }
  if (c.usageHub !== undefined) {
    if (!c.usageHub || typeof c.usageHub !== 'object' || Array.isArray(c.usageHub) || typeof c.usageHub.enabled !== 'boolean') throw new Error('invalid usage hub configuration');
    if (c.usageHub.destination !== undefined && typeof c.usageHub.destination !== 'string') throw new Error('invalid usage hub configuration');
    const rawUsageDest = c.usageHub.destination?.trim();
    if (c.usageHub.enabled && !rawUsageDest) throw new Error('invalid usage hub configuration');
    if (
      rawUsageDest &&
      (c.allowedDestinations.includes(rawUsageDest) ||
        (c.watchHub?.destination && rawUsageDest === c.watchHub.destination.trim()) ||
        (c.pendingHub?.destination && rawUsageDest === c.pendingHub.destination.trim()) ||
        (c.autoMirror?.destination && rawUsageDest === c.autoMirror.destination.trim()))
    ) {
      throw new Error('invalid usage hub configuration');
    }
    if (c.usageHub.intervalMinutes !== undefined && (!Number.isSafeInteger(c.usageHub.intervalMinutes) || c.usageHub.intervalMinutes < 5 || c.usageHub.intervalMinutes > 1440)) {
      throw new Error('invalid usage hub configuration');
    }
    for (const p of [c.usageHub.dbPath, c.usageHub.snapshotPath, c.usageHub.exportScriptPath, c.usageHub.toolsBinPath, c.usageHub.pythonBinPath]) {
      if (p !== undefined && (typeof p !== 'string' || !isAbsolute(p) || p.includes('\0'))) throw new Error('invalid usage hub configuration');
    }
    if (c.usageHub.webUrl !== undefined && (typeof c.usageHub.webUrl !== 'string' || !c.usageHub.webUrl.trim())) throw new Error('invalid usage hub configuration');
  }
  if(c.testLane && (!c.testLane.stateDir || !isAbsolute(c.testLane.stateDir) || (c.testLane.nativeClaude!==undefined && typeof c.testLane.nativeClaude!=='boolean') || (c.testLane.nativeCodex!==undefined && typeof c.testLane.nativeCodex!=='boolean') || (c.testLane.nativeTTLMinutes!==undefined && (!Number.isSafeInteger(c.testLane.nativeTTLMinutes)||c.testLane.nativeTTLMinutes<5||c.testLane.nativeTTLMinutes>120)))) throw new Error('invalid test lane state directory');
  const approval = c.approvalPolicy;
  if (approval !== undefined && (!approval || typeof approval !== 'object' || Array.isArray(approval)
    || approval.enabled !== undefined && typeof approval.enabled !== 'boolean' || approval.codexSharedFilesystem !== undefined && typeof approval.codexSharedFilesystem !== 'boolean'
    || approval.homeDir !== undefined && (typeof approval.homeDir !== 'string' || !isAbsolute(approval.homeDir) || approval.homeDir.includes('\0')))) throw new Error('invalid approval policy configuration');
  for (const list of [c.allowedProjectRoots,c.outputRoots,approval?.extraTrustedRoots,approval?.extraWriteRoots]) if (list !== undefined && (!Array.isArray(list) || !list.every(x=>typeof x==='string' && isAbsolute(x) && !x.includes('\0')))) throw new Error('invalid trusted roots');
  if (c.catalogSources !== undefined && (!Array.isArray(c.catalogSources) || !c.catalogSources.every(x=>x && (x.provider==='claude'||x.provider==='codex'||(x.provider==='agy' && !!c.agy)) && typeof x.directory==='string' && isAbsolute(x.directory) && typeof x.hostId==='string' && !!x.hostId.trim() && typeof x.serviceId==='string' && !!x.serviceId.trim()))) throw new Error('invalid catalog sources');
  if (c.catalogSources?.some(x=>x.hostId!==c.hostId || x.serviceId!==(x.provider==='claude' ? c.claudeServiceId : x.provider==='codex' ? c.codexServiceId : c.agy?.serviceId))) throw new Error('catalog source namespace does not match runtime configuration');
  if (c.artifactStatePath !== undefined && !isAbsolute(c.artifactStatePath)) throw new Error('invalid artifact state path');
  if(c.historyArchive && (!isAbsolute(c.historyArchive.root) || !isAbsolute(c.historyArchive.manifestPath) || !/^[0-9a-f]{64}$/.test(c.historyArchive.manifestSha256))) throw new Error('invalid archive configuration');
  if (c.autoMirror && (typeof c.autoMirror.enabled!=='boolean' || (c.autoMirror.showTitles!==undefined && typeof c.autoMirror.showTitles!=='boolean') || (c.autoMirror.backfillNativeIds!==undefined && (!Array.isArray(c.autoMirror.backfillNativeIds) || !c.autoMirror.backfillNativeIds.every(x=>x && (x.provider==='codex'||x.provider==='claude'||x.provider==='agy') && typeof x.nativeSessionId==='string' && !!x.nativeSessionId.trim()))) || (c.autoMirror.enabled && (!c.autoMirror.destination || !c.allowedDestinations.includes(c.autoMirror.destination))))) throw new Error('invalid auto mirror configuration');
  const url = new URL(c.codexEndpoint); if ((!['ws:','wss:'].includes(url.protocol) && c.codexEndpoint !== 'codex-proxy://default') || url.username || url.password) throw new Error('invalid Codex endpoint');
}
const resolveWatchHubDbPath=(config:RuntimeConfig):string => config.watchHub?.dbPath ?? join(dirname(resolve(config.channelDb)),'watch-hub.sqlite');
const resolvePendingHubDbPath=(config:RuntimeConfig):string => config.pendingHub?.dbPath ?? join(dirname(resolve(config.channelDb)),'pending-hub.sqlite');
const resolveDecisionSyncDbPath=(config:RuntimeConfig):string => config.decisionSync?.dbPath ?? join(dirname(resolve(config.channelDb)),'decision-sync.sqlite');
const resolveUsageHubDbPath=(config:RuntimeConfig):string => config.usageHub?.dbPath ?? join(dirname(resolve(config.channelDb)),'usage-hub.sqlite');
const sessionRecoveryFailure = 'one or more sessions could not be restored; inspect before retry';

/** The caller must ensure inbound envelopes originate from authenticated transport. */
export class UnifiedRuntime {
  readonly store:UnifiedStore; readonly core:UnifiedCore; readonly channel:FeishuChannel;
  private readonly interactive:RuntimeInteractive;
  private _watchHub:WatchHub|undefined; private _pendingHub:PendingHub|undefined; private _decisionSync:DecisionSyncStore|undefined; private _usageHub:UsageHub|undefined; private _taskChannel:TaskTopicChannel|undefined; private _taskHandoff:TaskHandoffService|undefined;
  get watchHub():WatchHub|undefined { return this._watchHub; }
  get pendingHub():PendingHub|undefined { return this._pendingHub; }
  get decisionSync():DecisionSyncStore|undefined { return this._decisionSync; }
  get usageHub():UsageHub|undefined { return this._usageHub; }
  get taskChannel():TaskTopicChannel|undefined { return this._taskChannel; }
  get taskHandoff():TaskHandoffService|undefined { return this._taskHandoff; }
  private readonly startupRestorations = new Map<Provider, Promise<void>>();
  private readonly reconnectRestorations = new Set<Provider>();
  private lastCompactionAt: number | undefined;
  private legacyEventKeysSlimmed = false;
  private unknownDeliveryChangeSince: number | undefined;
  private baselinePreparing=false; private readonly recoveryFailedSessions=new Set<string>(); private readonly unavailableProviders=new Set<Provider>(); private readonly providerEverConnected=new Set<Provider>(); private readonly providerWasDisconnected=new Set<Provider>(); private readonly lowQuotaActive=new Set<Provider>(); private lastUnknownDeliverySnapshot={deliveries:0,inbox:0}; private readonly alertedUnknownOperations=new Set<string>(); private readonly inFlightUnknownOpAlerts=new Set<string>(); private readonly restartPending:string[]; private recoveryFailure:string|null=null; private recoveryStarted:Promise<void>|undefined; private timer:ReturnType<typeof setTimeout>|undefined; private usageTimer:ReturnType<typeof setTimeout>|undefined; private polling=false; private inPollCycle=false; private wakePending=false; private wakeScheduled=false; private lastActivityAt=Date.now(); private readonly pollRunner=()=>void this.runPollCycle(); private running:Promise<void>|undefined; private lastError:string|null=null; private closed=false; private closing=false; private closePromise:Promise<void>|undefined; private readonly intakes=new Set<Promise<unknown>>(); private readonly hubTasks=new Set<Promise<unknown>>(); private readonly lock:DatabaseSync; private readonly providers:PlatformPort[]; private readonly sendPort:Pick<FeishuPort,'send'|'update'>; private readonly port:FeishuPort & {authorizedDestination?:(destination:string)=>boolean;lookupTaskTopic?:(destination:string,owner:string)=>unknown;createTaskTopic?:(chatId:string,taskId:string,operationId:string,owner:string)=>Promise<TaskTopicToken>;drainInbound?:(handle:(e:TrustedEnvelope,a:ChannelAction,scope?:string)=>Promise<unknown>)=>Promise<void>;resourceIssues?:()=>Array<{eventId:string;state:string;attempts:number;reason:string}>};
  constructor(readonly config:RuntimeConfig, port:FeishuPort, providers:PlatformPort[], private readonly options:{canDiscover?:(s:Session)=>boolean;resolveDiscoveryProject?:(native:Omit<Session['native'],'nativeSessionId'>,project:string|null)=>string|null;allowDiscovered?:(id:string)=>boolean;canInspectCandidate?:(native:Session['native'],project:string)=>boolean;requireReadonlyHydration?:boolean;allowedProjectRoots?:readonly string[];refresh?:(runtime:UnifiedRuntime)=>Promise<void>;cleanup?:()=>void;isTrustedAgyCliHolder?:(holder:{pid:number;tty:string;cmdline:string;kind:'external_cli'|'bridge_acp';exe?:string})=>boolean;usageHub?:{now?:()=>number;collectSnapshot?:()=>Promise<UsageDashboardPayload|void>;refreshCooldownMs?:number;collectTimeoutMs?:number}}={}) {
    this.providers=providers; this.port=port; validateRuntimeConfig(config);
    const channelPath=resolve(config.channelDb); const canonical=existsSync(channelPath) ? realpathSync(channelPath) : join(realpathSync(dirname(channelPath)),basename(channelPath));
    this.lock=new DatabaseSync(`${canonical}.runtime-lock`);
    try { this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); } catch { this.lock.close(); throw new Error('channel runtime already active'); }
    let archive:HistoryArchive|undefined;
    try { if(config.historyArchive) { const data=readFileSync(config.historyArchive.manifestPath); if(createHash('sha256').update(data).digest('hex')!==config.historyArchive.manifestSha256) throw new Error('archive manifest hash mismatch'); archive=new HistoryArchive(config.historyArchive.root,JSON.parse(data.toString()) as MigrationManifest); } } catch(e) {this.lock.exec('ROLLBACK');this.lock.close();throw e;}
    const destinations = new Set(config.allowedDestinations);
    const owner = (identity:{source:string;subject:string}) => identity.source==='feishu' && identity.subject===config.ownerOpenId;
    const ownerIdentity:Identity = { source: 'feishu', subject: config.ownerOpenId };
    try {
      this.store = new UnifiedStore(config.coreDb);
      try { this.core = new UnifiedCore(this.store,providers,(identity,session)=>owner(identity) && (!options.canDiscover || options.canDiscover(session)),(identity)=>owner(identity),()=>false,options.canDiscover,archive,options.canInspectCandidate);
        this.core.onRecoveryReconciled = sessionId => this.recordRestoredSession(sessionId);
        this.restartPending=this.store.pendingOutbox();
        const allowedProjectRoots = options.allowedProjectRoots ?? config.allowedProjectRoots ?? [];
        const agyConfig = config.agy;
        const measuredPort=new Proxy(port,{get:(target,key)=>{const value=Reflect.get(target,key); if(typeof value!=='function') return value; if(['send','sendText','update','sendFile'].includes(String(key))) return async (...args:unknown[])=>{let guardFailed=false;const last=args.length-1; if(typeof args[last]==='function') {const guard=args[last] as ()=>Promise<void>;args[last]=async()=>{try {await guard();} catch(error) {guardFailed=true;throw error;}};} try {const result=await Reflect.apply(value,target,args); try {this.channel.recordHealth('feishu_delivery',(key==='send' && !result)?'unverified':'healthy',(key==='send' && !result)?'消息回执未确认':null);} catch {} return result;} catch(error) {const e=error && typeof error==='object' ? error as {deliveryKind?:unknown;platformCode?:unknown} : {}; const rejected=e.deliveryKind==='api_rejected' && typeof e.platformCode==='number' && Number.isSafeInteger(e.platformCode); const reason=guardFailed?'发送前权限或绑定变化':rejected?`平台拒绝（代码 ${e.platformCode}）`:'投递结果未知'; const deliveryId=args[key==='send'||key==='sendText'?2:3];const isWatchDelivery=typeof deliveryId==='string' && (deliveryId.startsWith('watch-') || deliveryId.startsWith('watch:') || deliveryId.startsWith('usage-') || deliveryId.startsWith('usage:'));try {if(typeof deliveryId==='string') this.channel.recordDeliveryDiagnostic(deliveryId,guardFailed?'guard_rejected':rejected?'api_rejected':'unknown',rejected?e.platformCode as number:null);} catch {} try {this.channel.recordHealth('feishu_delivery','degraded',reason);} catch {} if(!guardFailed && !rejected && !isWatchDelivery) this.emitWatchEvent({source:'watch',objectId:`delivery:unknown:${typeof deliveryId==='string'?deliveryId:'feishu'}`,state:'alert',severity:'high',title:'飞书消息投递结果未知',summary:`飞书消息投递结果未知（${reason}），请核对目标话题是否已收到消息。`}); throw error;}}; return value.bind(target);}}); this.sendPort=measuredPort; try { this.channel = new FeishuChannel(this.core,measuredPort,async (identity,destination,sessionId)=>{ if(!owner(identity) || !(this.port.authorizedDestination?.(destination) ?? destinations.has(destination))) return false; if(!sessionId || !options.canDiscover) return true; try {return options.canDiscover(this.store.getSession(sessionId));} catch {return options.allowDiscovered?.(sessionId) ?? false;} },config.channelDb,undefined,options.requireReadonlyHydration === true,{
          ...(allowedProjectRoots[0] ? { defaultCreateProject: allowedProjectRoots[0] } : {}),
          allowedProjectRoots, enabledProviders: providers.map(port => port.provider),
          ...(config.autoTakeControlOnInput ? { autoTakeControlOnInput: true } : {}),
          canReconcileReleasedReadonly: session => this.canReconcileReleasedReadonly(session),
          onInteractionChanged: (sessionId, interactionId) => this.interactive.notifyInteraction(sessionId, interactionId),
          onProgressWake: destination => { if (!this.closing && !this.closed) this.interactive.notifyChannelProgress(destination); },
          readAgyStatus: () => collectAgyStatusSnapshot({
            ...(agyConfig?.summariesDbPath !== undefined ? { summariesDbPath: agyConfig.summariesDbPath } : {}),
            ...(agyConfig?.brainDir !== undefined ? { brainDir: agyConfig.brainDir } : {}),
            conversationsDir: agyConfig?.conversationsDir ?? defaultAgyConversationsDir(agyConfig?.brainDir),
          }),
          ...(agyConfig && agyConfig.enabled !== false ? {
            readReadonlyLiveTurn: (session: Session) => {
              if (session.native.provider !== 'agy') return null;
              return readReadonlyAgyLiveTurn(session.native.nativeSessionId, session.project, {
                ...(agyConfig.summariesDbPath !== undefined ? { summariesDbPath: agyConfig.summariesDbPath } : {}),
                ...(agyConfig.brainDir !== undefined ? { brainDir: agyConfig.brainDir } : {}),
              });
            },
          } : {}),
        }); } catch(error) { this.core.close(); throw error; }
        this.core.validateSteerScope = (scope,sessionId) => {
          if (!owner({source:scope.ownerSource,subject:scope.ownerSubject})) return false;
          const task = this._taskChannel;
          if (task?.getBindingByDestination(scope.destination)) {
            if (this.port.lookupTaskTopic && !this.port.lookupTaskTopic(scope.destination,scope.ownerSubject)) return false;
            return task.isCurrentInputScope(scope,sessionId);
          }
          return (this.port.authorizedDestination?.(scope.destination) ?? destinations.has(scope.destination)) &&
            this.channel.isCurrentSteerScope(scope,sessionId);
        };
        const showAutoTitles = config.autoMirror?.showTitles === true;
        this.core.presentSession=session=>(!showAutoTitles && this.channel.isAutoPrivateTitle(session.native)) ? {...session,title:`${providerTitlePrefix(session.native.provider)} 会话 · ${payloadDigest(session.native).slice(0,8)}`} : session;
        try {
          for (const id of this.store.unknownOperationIds()) this.alertedUnknownOperations.add(id);
          this.lastUnknownDeliverySnapshot = {
            deliveries: this.channel.pendingDeliveries().length,
            inbox: this.channel.unknownInbox().length,
          };
          if (config.decisionSync?.enabled) {
            this._decisionSync = new DecisionSyncStore({
              dbPath: resolveDecisionSyncDbPath(config),
              ...(config.decisionSync.markdownPath !== undefined ? { defaultDocPath: config.decisionSync.markdownPath } : {}),
              ...(config.decisionSync.protectedReadOnlyPaths !== undefined ? { protectedReadOnlyPaths: new Set(config.decisionSync.protectedReadOnlyPaths) } : {}),
              authorizeActor: (actor) => owner(actor),
            });
          }
          if (config.watchHub?.enabled) {
            this._watchHub = new WatchHub({
              dbPath: resolveWatchHubDbPath(config),
              owner: ownerIdentity,
              destination: config.watchHub.destination,
              allowedDestinations: destinations,
              port: measuredPort,
              authorizeTarget: (id, dest) => owner(id) && (this.port.authorizedDestination?.(dest) ?? destinations.has(dest)),
              resolveTopicLink: async (ref, targetDest) => {
                if (ref.taskId && this.port.topicLinkForTask) {
                  const taskUrl = await this.port.topicLinkForTask(targetDest, ref.taskId);
                  if (taskUrl) return taskUrl;
                }
                if (ref.sessionId && this._taskChannel && this.port.topicLinkForTask) {
                  const taskBinding = this._taskChannel.listActiveBindings().find((b) =>
                    this._taskChannel!.listTargets(b.taskId).some((t) => t.sessionId === ref.sessionId),
                  );
                  if (taskBinding) {
                    const taskUrl = await this.port.topicLinkForTask(targetDest, taskBinding.taskId);
                    if (taskUrl) return taskUrl;
                  }
                }
                const sessionId =
                  ref.sessionId ??
                  (ref.taskId && this._taskChannel
                    ? (() => {
                        const b = this._taskChannel.getBinding(ref.taskId);
                        return b?.activeTargetId ? this._taskChannel.getTarget(ref.taskId, b.activeTargetId)?.sessionId : undefined;
                      })()
                    : undefined);
                if (sessionId && this.port.topicLinkForSession) {
                  return this.port.topicLinkForSession(targetDest, sessionId);
                }
                return null;
              },
            });
          }
          if (config.pendingHub?.enabled) {
            const agyWaitingDetector = new AgyCliWaitingDetector();
            const cliNoticeTtlMs = config.intervalMs >= 1000 ? 20_000 : 0;
            let cachedCliNotices: {
              expiresAt: number;
              result: PendingCliNotice[] | { notices: PendingCliNotice[]; unknownRefIds: string[] };
              isStillValid: () => boolean;
            } | undefined;
            this._pendingHub = new PendingHub({
              dbPath: resolvePendingHubDbPath(config),
              owner: ownerIdentity,
              destination: config.pendingHub.destination,
              service: this.core,
              ...(this._decisionSync ? { decisionStore: this._decisionSync } : {}),
              port: measuredPort,
              shouldRefreshSource: ({destination,sessionId,interactionId,messageId}) =>
                !this.channel.ownsInteractionCard(destination,sessionId,interactionId,messageId)
                && !this._taskChannel?.ownsInteractionCard(destination,sessionId,interactionId,messageId),
              shouldDeliverSource: (item) => item.provider === 'decision',
              discoverCliNotices: async () => {
                if (cachedCliNotices && Date.now() < cachedCliNotices.expiresAt && cachedCliNotices.isStillValid()) {
                  return cachedCliNotices.result;
                }
                cachedCliNotices = undefined;
                const claudeNative = { provider: 'claude' as const, hostId: config.hostId, serviceId: config.claudeServiceId };
                const resolveProject = options.resolveDiscoveryProject ?? ((ref, project) => {
                  const sources = config.catalogSources?.filter(source => canonicalDirectory(source.directory) !== null) ?? [];
                  const roots = allowedProjectRoots.flatMap(root => canonicalDirectory(root) ?? []);
                  return discoverySourceAllowed(config, ref, sources) ? trustedDiscoveryProject(project, roots) : null;
                });
                const notices: PendingCliNotice[] = [];
                const unknownRefIds: string[] = [];

                const presenceDirs = [join(config.claudeStateDir, 'presence')];
                const defaultPresenceDir = join(homedir(), '.local', 'state', 'feishu-claude-bridge', 'presence');
                const tempRoot = tmpdir();
                if (!inside(config.claudeStateDir, tempRoot) || inside(defaultPresenceDir, tempRoot)) {
                  presenceDirs.push(defaultPresenceDir);
                }
                const fingerprints = cliNoticeTtlMs ? new Map<string, string | null>() : undefined;
                const holderPids = new Set<number>();
                for (const dir of presenceDirs) fingerprints?.set(dir, agyFileFingerprint(dir));
                const records = await readWaitingClaudePresence(presenceDirs, Date.now());
                if (fingerprints) {
                  for (const { sessionId } of records) {
                    for (const dir of presenceDirs) {
                      const path = join(dir, `${sessionId}.json`);
                      const fingerprint = agyFileFingerprint(path);
                      if (fingerprint !== 'missing') fingerprints.set(path, fingerprint);
                    }
                  }
                }
                if (records.length) {
                  const claudeSessions = new Map(this.store.listSessions()
                    .filter(({ native }) => native.provider === 'claude' && native.hostId === config.hostId &&
                      native.serviceId === config.claudeServiceId)
                    .map(session => [session.native.nativeSessionId, session]));
                  for (const record of records) {
                    const session = claudeSessions.get(record.sessionId);
                    if (session && (session.control.input === 'available' || this.store.isDetached(session.sessionId) ||
                      options.canDiscover && !options.canDiscover(session))) continue;
                    const project = resolveProject(claudeNative, record.cwd ?? session?.project ?? null);
                    if (!project) continue;
                    notices.push({
                      provider: 'claude',
                      nativeSessionId: record.sessionId,
                      title: session ? this.core.presentSession(session).title : `Claude Code 会话 · ${record.sessionId.slice(0, 8)}`,
                      summary: 'Claude Code 终端有待处理的请求。',
                      project,
                      sourceSessionId: session?.sessionId ?? null,
                    });
                  }
                }

                if (config.agy && config.agy.enabled !== false) {
                  const agyNative = { provider: 'agy' as const, hostId: config.hostId, serviceId: config.agy.serviceId };
                  const conversationsDir = config.agy.conversationsDir ?? defaultAgyConversationsDir(config.agy.brainDir);
                  const agyScan = agyWaitingDetector.scan({
                    ...(config.agy.summariesDbPath !== undefined ? { summariesDbPath: config.agy.summariesDbPath } : {}),
                    ...(config.agy.brainDir !== undefined ? { brainDir: config.agy.brainDir } : {}),
                    conversationsDir,
                    ...(config.allowedProjectRoots !== undefined ? { allowedProjectRoots: config.allowedProjectRoots } : {}),
                    ...(options.isTrustedAgyCliHolder !== undefined ? { isTrustedHolder: options.isTrustedAgyCliHolder } : {}),
                  });
                  if (fingerprints) {
                    const watchDb = (path: string) => {
                      fingerprints.set(path, agyFileFingerprint(path));
                      fingerprints.set(`${path}-wal`, agyFileFingerprint(`${path}-wal`));
                    };
                    for (const item of agyScan.notices) {
                      holderPids.add(item.holder.pid);
                      watchDb(join(conversationsDir, `${item.waitingConversationId}.db`));
                    }
                    for (const id of agyScan.unknownConversationIds) watchDb(join(conversationsDir, `${id}.db`));
                    if (agyScan.unknownConversationIds.length) {
                      for (const path of resolveAgySummariesDbPaths(config.agy.summariesDbPath)) watchDb(path);
                    }
                  }
                  for (const unknownId of agyScan.unknownConversationIds) {
                    unknownRefIds.push(`cli_notice:agy:${unknownId}`);
                  }
                  if (agyScan.notices.length) {
                    const agySessions = new Map(this.store.listSessions()
                      .filter(({ native }) => native.provider === 'agy' && native.hostId === config.hostId &&
                        native.serviceId === config.agy!.serviceId)
                      .map(session => [session.native.nativeSessionId, session]));
                    for (const item of agyScan.notices) {
                      const rootSession = agySessions.get(item.rootConversationId);
                      if (rootSession && (rootSession.control.input === 'available' || this.store.isDetached(rootSession.sessionId) ||
                        options.canDiscover && !options.canDiscover(rootSession))) continue;
                      const project = resolveProject(agyNative, item.rootProject);
                      if (!project) continue;
                      const rootTitle = rootSession ? this.core.presentSession(rootSession).title : item.rootTitle;
                      const title = item.subagentName ? `${rootTitle} · 子代理 ${item.subagentName}` : rootTitle;
                      const ttyPart = item.holder.tty ? ` (${item.holder.tty})` : '';
                      const parts = [
                        item.toolSummary
                          ? `终端步骤 #${item.waitingStepIdx} 等待确认/输入：${item.toolSummary}`
                          : `终端步骤 #${item.waitingStepIdx} 等待确认/输入。`,
                        `持有终端：PID ${item.holder.pid}${ttyPart} · 切回命令：agy --conversation ${item.rootConversationId}`,
                      ];
                      notices.push({
                        provider: 'agy',
                        nativeSessionId: item.waitingConversationId,
                        title,
                        summary: parts.join('\n'),
                        project,
                        sourceSessionId: rootSession?.sessionId ?? null,
                      });
                    }
                  }
                }

                const result = unknownRefIds.length ? { notices, unknownRefIds } : notices;
                if (fingerprints) {
                  cachedCliNotices = {
                    expiresAt: Date.now() + cliNoticeTtlMs,
                    result,
                    isStillValid: () => {
                      for (const pid of holderPids) if (!isPidAlive(pid)) return false;
                      for (const [path, fingerprint] of fingerprints) {
                        if (agyFileFingerprint(path) !== fingerprint) return false;
                      }
                      return true;
                    },
                  };
                }
                return result;
              },
              resolveTopicLink: async (sessionId, hubDest) => {
                if (this._taskChannel && this.port.topicLinkForTask) {
                  const sourceDest = this._pendingHub?.getSourceDestination(sessionId);
                  const taskBinding =
                    (sourceDest ? this._taskChannel.getBindingByDestination(sourceDest) : null) ??
                    this._taskChannel.listActiveBindings().find((b) =>
                      this._taskChannel!.listTargets(b.taskId).some((t) => t.sessionId === sessionId),
                    );
                  if (taskBinding) {
                    const taskUrl = await this.port.topicLinkForTask(hubDest, taskBinding.taskId);
                    if (taskUrl) return taskUrl;
                  }
                }
                if (this.port.topicLinkForSession) {
                  return this.port.topicLinkForSession(hubDest, sessionId);
                }
                return null;
              },
              authorize: async (identity, destination, targetId) => {
                if (!owner(identity)) return false;
                const root = this._pendingHub?.getRoot();
                const isHubDest =
                  destination === config.pendingHub!.destination ||
                  (!!root?.topicDestination && destination === root.topicDestination);
                const isTaskDest = !!this._taskChannel?.getBindingByDestination(destination);
                const destOk =
                  isHubDest ||
                  isTaskDest ||
                  (this.port.authorizedDestination
                    ? this.port.authorizedDestination(destination)
                    : destinations.has(destination) ||
                      this.channel.boundDestinations().includes(destination) ||
                      this._pendingHub?.getSourceDestination(targetId) === destination);
                if (!destOk) return false;
                if (!options.canDiscover) return true;
                try {
                  return options.canDiscover(this.store.getSession(targetId));
                } catch {
                  // targetId may be 'hub:text' or a decisionId rather than a core sessionId.
                  return true;
                }
              },
            });
          }
          if (config.taskTopic?.enabled) {
            const authorizeTask: TaskAuthorize = async (identity, destination, sessionId) => {
              if (!owner(identity)) return false;
              const binding = this._taskChannel?.getBindingByDestination(destination);
              const hasTaskLookup = typeof this.port.lookupTaskTopic === 'function';
              const taskToken = hasTaskLookup ? this.port.lookupTaskTopic!(destination, config.ownerOpenId) : null;
              const destOk = hasTaskLookup
                ? !!taskToken
                : (!!binding && binding.state === 'active') ||
                  (this.port.authorizedDestination?.(destination) ?? destinations.has(destination));
              if (!destOk) return false;
              if (!sessionId || !options.canDiscover) return true;
              try {
                return options.canDiscover(this.store.getSession(sessionId));
              } catch {
                return options.allowDiscovered?.(sessionId) ?? false;
              }
            };
            this._taskChannel = new TaskTopicChannel(this.core, measuredPort, authorizeTask, config.channelDb, {
              onInteractionChanged: (sessionId, interactionId) => this.interactive.notifyInteraction(sessionId, interactionId),
            });
            const handoffRoots = options.allowedProjectRoots ?? config.allowedProjectRoots;
            this._taskHandoff = new TaskHandoffService(
              this.core,
              authorizeTask,
              config.channelDb,
              handoffRoots ? { allowedProjectRoots: handoffRoots } : {},
            );
          }
          if (config.usageHub?.enabled) {
            this._usageHub = new UsageHub({
              dbPath: resolveUsageHubDbPath(config),
              owner: ownerIdentity,
              destination: config.usageHub.destination.trim(),
              port: measuredPort,
              ...(config.usageHub.intervalMinutes !== undefined ? { intervalMinutes: config.usageHub.intervalMinutes } : {}),
              ...(config.usageHub.snapshotPath !== undefined ? { snapshotPath: config.usageHub.snapshotPath } : {}),
              ...(config.usageHub.exportScriptPath !== undefined ? { exportScriptPath: config.usageHub.exportScriptPath } : {}),
              ...(config.usageHub.toolsBinPath !== undefined ? { toolsBinPath: config.usageHub.toolsBinPath } : {}),
              ...(config.usageHub.pythonBinPath !== undefined ? { pythonBinPath: config.usageHub.pythonBinPath } : {}),
              ...(config.usageHub.webUrl !== undefined ? { webUrl: config.usageHub.webUrl } : {}),
              ...(options.usageHub?.now !== undefined ? { now: options.usageHub.now } : {}),
              ...(options.usageHub?.collectSnapshot !== undefined ? { collectSnapshot: options.usageHub.collectSnapshot } : {}),
              ...(options.usageHub?.refreshCooldownMs !== undefined ? { refreshCooldownMs: options.usageHub.refreshCooldownMs } : {}),
              ...(options.usageHub?.collectTimeoutMs !== undefined ? { collectTimeoutMs: options.usageHub.collectTimeoutMs } : {}),
            });
          }
        } catch (error) {
          try { this._usageHub?.close(); } catch {}
          try { this._taskHandoff?.close(); } catch {}
          try { this._taskChannel?.close(); } catch {}
          try { this._pendingHub?.close(); } catch {}
          try { this._watchHub?.close(); } catch {}
          try { this._decisionSync?.close(); } catch {}
          this.channel.close();
          this.core.close();
          throw error;
        }
      } catch(error) { this.store.close(); throw error; }
    } catch(error) { this.lock.exec('ROLLBACK'); this.lock.close(); throw error; }
    this.interactive = new RuntimeInteractive(this.core, this.store, this.channel, this._taskChannel, this._pendingHub, () => {
      this.lastError = 'interactive dispatch or synchronization failed';
    }, options.requireReadonlyHydration === true);
    const hasAgy=(config.agy !== undefined && config.agy.enabled !== false) || providers.some(p=>p.provider==='agy');
    const healthComponents=['core','feishu_delivery','feishu_callback','feishu_resources','codex_connection','codex_run','claude_connection','claude_run','claude_quota',...(hasAgy ? ['agy_connection','agy_run','agy_quota'] : []),'interaction_return'];
    for(const component of healthComponents) try {this.channel.invalidateHealth(component,'进程重启后尚未重新观测');} catch {}
    if('onResourceHealth' in port) (port as FeishuPort & {onResourceHealth:(status:'healthy'|'degraded',reason:string|null)=>void}).onResourceHealth=(status,reason)=>{try {this.channel.recordHealth('feishu_resources',status,reason);} catch {}};
    this.core.onAcceptedObservation=o=>{if(this.closing || this.closed)return;this.lastActivityAt=Date.now();const record=(component:string,status:'healthy'|'degraded'|'unverified',reason:string|null=null)=>{try {this.channel.recordHealth(component,status,reason);} catch {}}; const provider=o.ref.provider; this.providerEverConnected.add(provider); const watchSource:WatchSource=provider==='agy'?'agy_status':provider==='codex'?'codex_status':'claude_stop_failure'; if((provider==='claude' || provider==='agy') && o.type==='message' && o.message.role==='assistant') record(`${provider}_connection`,'healthy'); if(o.type==='turn' && ['completed','failed','interrupted'].includes(o.turn.status)) {record(`${provider}_run`,o.turn.status==='completed'?'healthy':o.turn.status==='failed'?'degraded':'unverified',o.turn.status==='completed'?null:o.turn.status==='failed'?'运行失败':'本轮中断，结果未确认'); if(o.turn.status==='failed'){const s=this.store.findSession(o.ref);this.emitWatchEvent({source:watchSource,objectId:`turn:${s?.sessionId ?? o.ref.nativeSessionId}:${o.turn.turnId}`,state:'failed',severity:'high',title:`${providerTitlePrefix(provider)} 轮次执行失败`,summary:`会话 ${s?.title ?? o.ref.nativeSessionId} 的轮次 ${o.turn.turnId} 执行失败，请检查会话状态。`,...(s?{sourceRef:{sessionId:s.sessionId}}:{})});}} if(o.type==='event' && provider==='claude') {if(o.event.type==='provider.api_retry'){try {const session=this.store.findSession(o.ref);const turn=session && this.store.listTurns(session.sessionId).find(t=>t.turnId===o.event.objectId);if(!turn || !['completed','failed','interrupted'].includes(turn.status)){const d=o.event.data && typeof o.event.data==='object' ? o.event.data as {httpStatus?:unknown}:{};const code=typeof d.httpStatus==='number' && Number.isSafeInteger(d.httpStatus) && d.httpStatus>=100 && d.httpStatus<=599 ? d.httpStatus:null;this.channel.recordRetryHealth(code===null?'模型请求正在重试':`模型请求正在重试（HTTP ${code}）`,o.event.receivedAt);}} catch {}}if(o.event.type==='adapter.stream_failed'){record('claude_run','degraded','SDK流中断');record('claude_connection','degraded','SDK流中断');} if(o.event.type==='provider.usage_limit')record('claude_quota','degraded','服务报告额度限制'); if(o.event.type==='provider.usage_available')record('claude_quota','healthy');} if(o.type==='event' && provider==='agy') {if(o.event.type==='adapter.stream_failed'){record('agy_run','degraded','ACP流中断');record('agy_connection','degraded','ACP流中断');} if(o.event.type==='provider.usage_limit')record('agy_quota','degraded','服务报告额度限制'); if(o.event.type==='provider.usage_available')record('agy_quota','healthy');} if(o.type==='event' && ['adapter.stream_failed','turn.timeout','operation.unknown'].includes(o.event.type)) {const s=this.store.findSession(o.ref);const title=o.event.type==='turn.timeout'?`${providerTitlePrefix(provider)} 轮次超时`:o.event.type==='operation.unknown'?`${providerTitlePrefix(provider)} 投递结果未知`:`${providerTitlePrefix(provider)} 流连接中断`;this.emitWatchEvent({source:o.event.type==='operation.unknown'?'watch':watchSource,objectId:`${o.event.type}:${s?.sessionId ?? o.ref.nativeSessionId}:${o.event.objectId}`,state:o.event.type==='turn.timeout'?'failed':'alert',severity:'high',title,summary:`会话 ${s?.title ?? o.ref.nativeSessionId} 发生 ${o.event.type}，请及时核对。`,...(s?{sourceRef:{sessionId:s.sessionId}}:{})});} if(o.type==='interaction') {const i=o.interaction;if(i.status==='answer_pending_delivery') record('interaction_return','unverified','答复已提交，原生结果待确认');else if(i.status==='resolved') record('interaction_return',i.nativeResult?.status==='accepted'?'healthy':'unverified',i.nativeResult?.status==='accepted'?null:'原生结果未确认');} this.notifyObservation(o);};

    const coreHealth=this.core.health.bind(this.core);
    this.core.health=async()=>{ const base=(await coreHealth())[0]!;const h=this.health(); const interactions=this.store.interactionHealthCounts(); const deliveryUnknown=this.channel.unconfirmedDeliveryCount(); const names=healthComponents; return [...names.map(component=>{const f=this.channel.healthFact(component); const issues=component==='feishu_resources'?h.resourceIssues.length:component==='feishu_delivery'?deliveryUnknown:component==='feishu_callback'?h.unknownInbox:component==='interaction_return'?interactions.unknown:0; const status=component==='core' && base.status==='degraded'?'degraded' as const:issues?'degraded' as const:f.status; return {...f,component,status,reason:component==='core' && base.status==='degraded'?base.reason:issues?'存在未确认或失败记录':f.reason,backlog:component==='core'?base.backlog:component==='feishu_callback'?this.channel.pendingInbox().length:component==='feishu_resources'?h.resourceIssues.length:component==='interaction_return'?interactions.pending:null,unknown:component==='feishu_delivery'?deliveryUnknown:component==='feishu_callback'?h.unknownInbox:component==='feishu_resources'?h.resourceIssues.filter(x=>x.state!=='rejected').length:component==='interaction_return'?interactions.unknown:null,lastDeliveryAt:component==='feishu_delivery'?f.lastSuccessAt:null,updatedAt:f.lastObservedAt};}),{component:'runtime',status:h.status,reason:h.reason ?? (h.resourceIssues.length ? '资源待核对' : h.unknownInbox || h.unknownDeliveries ? '存在未知回执' : null),backlog:h.resourceIssues.length,lastDeliveryAt:null,updatedAt:null,lastObservedAt:null,lastSuccessAt:null,lastFailureAt:null,lastFailureReason:null,unknown:h.unknownInbox+h.unknownDeliveries}]; };

  }
  /** Offline preparation: read and baseline only existing readonly bindings, without Feishu delivery. */
  async prepareReadonlyHistoryBaselines(limit=2):Promise<{attempted:number;completed:number;failed:number;remaining:number}> {
    if(this.closed || this.closing || this.running || this.polling || this.timer || this.baselinePreparing) throw new Error('runtime unavailable');if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('invalid baseline limit'); this.baselinePreparing=true;
    try {const pending=()=>this.channel.bindingsForRestore().filter(b=>b.accessMode==='read_only' && !this.channel.readonlyHydrated(b.destination,b.sessionId));
    const groups=new Map<string,ReturnType<FeishuChannel['bindingsForRestore']>>();for(const binding of pending()) {const items=groups.get(binding.sessionId) ?? [];items.push(binding);groups.set(binding.sessionId,items);}let attempted=0,completed=0,failed=0;
    for(const [id,bindings] of [...groups].slice(0,limit)) {attempted++;try {const session=this.store.getSession(id);if(this.store.isDetached(id) || session.status!=='read_only' || session.control.input==='available' || (this.options.canDiscover && !this.options.canDiscover(session))) throw new Error('session unavailable');for(const binding of bindings) if(!await this.channel.isReadonlyBaselineAuthorized(binding.destination,id)) throw new Error('binding unauthorized');if(!await this.core.refreshReadOnlySession(id)) {failed++;continue;}for(const binding of bindings) await this.channel.baselineReadonlyHistory(binding.destination,id);completed++;}catch{failed++;}}
    return {attempted,completed,failed,remaining:new Set(pending().map(b=>b.sessionId)).size};} finally {this.baselinePreparing=false;}
  }
  acceptsBackgroundWork():boolean { return !this.closed && !this.closing; }
  async captureResourceScope(envelope:TrustedEnvelope):Promise<string> {
    if(this.closed || this.closing) throw new Error('closed');
    const capture=this._taskChannel?.getBindingByDestination(envelope.destination)
      ? this._taskChannel.captureResourceScope(envelope)
      : this.channel.captureBindingScope(envelope);
    this.intakes.add(capture);
    try { return await capture; } finally { this.intakes.delete(capture); }
  }
  private notifyObservation(observation:PlatformObservation):void {
    if (observation.type==='interaction') {
      this._pendingHub?.markSummaryDirty();
      this.interactive.notifyInteraction(observation.interaction.sessionId, observation.interaction.interactionId);
      this.wake();
    } else if (observation.type === 'message' && !observation.message.final && observation.message.role === 'assistant' ||
      observation.type === 'event' && (observation.event.type === 'tool.updated' || observation.event.type === 'artifact.available' &&
        typeof (observation.event.data as {turnId?: unknown} | null)?.turnId === 'string')) {
      const session = this.store.findSession(observation.ref);
      if (session) {
        if (observation.type === 'message') this.interactive.notifyProgress(session.sessionId);
        else this.interactive.notifyImmediateProgress(session.sessionId);
      }
    } else if (observation.type==='connection' || observation.type==='turn' || (observation.type==='message' && observation.message.final)) {
      if (observation.type==='connection' && this._pendingHub) {
        const task=this._pendingHub.handleObservation(observation).catch(()=>{});
        this.hubTasks.add(task);
        void task.finally(()=>this.hubTasks.delete(task));
      }
      const session=this.store.findSession(observation.ref);
      if (session) this.interactive.notifySession(session.sessionId, observation.type==='turn');
      this.wake();
    }
  }

  flushInteractive():Promise<void> { return this.interactive.flushInteractive(); }

  private async intakeTopic(e:TrustedEnvelope,a:ChannelAction|TaskChannelAction,scope?:string):Promise<unknown> {
    const task = this._taskChannel?.getBindingByDestination(e.destination);
    if (task && this._taskChannel) {
      const receipt = await this._taskChannel.intake(e,a as TaskChannelAction,scope);
      if (receipt.state==='received') this.interactive.notifyInbox({kind:'task',taskId:task.taskId});
      return receipt;
    }
    const receipt = await this.channel.intake(e,a as ChannelAction,scope);
    if (receipt.state==='received') this.interactive.notifyInbox({kind:'channel',destination:e.destination});
    return receipt;
  }

  async handleTrusted(envelope:TrustedEnvelope,action:RuntimeTrustedAction):Promise<unknown> {
    if(this.closed || this.closing) throw new Error('closed');
    this.lastActivityAt=Date.now();
    const intake=(async()=>{
      const configuredUsageDest = this.config.usageHub?.enabled ? (this.config.usageHub.destination?.trim() || null) : null;
      if (action.action === 'usage_report' || (configuredUsageDest && envelope.destination === configuredUsageDest)) {
        const isOwner = envelope.identity.source === 'feishu' && envelope.identity.subject === this.config.ownerOpenId;
        if (!isOwner || !this._usageHub || !this.config.usageHub?.enabled || envelope.destination !== configuredUsageDest) {
          throw contractError('unauthorized', 'usage hub action unauthorized');
        }
        if (action.action !== 'usage_report' && action.action !== 'input' && action.action !== 'attachment') {
          throw contractError('unsupported', 'action is unavailable for usage hub');
        }
        const usageAction = action.action === 'usage_report'
          ? action
          : {
              action: 'usage_report' as const,
              trigger: 'message' as const,
              ...(action.action === 'input' && action.text.trim() ? { rawText: action.text.trim() } : {}),
            };
        const res = await this._usageHub.handleTrigger(envelope, usageAction);
        this.scheduleUsageWake();
        return res;
      }
      if(isTaskControlAction(action)) {
        return handleTaskControlAction(
          {
            core: this.core,
            port: this.port,
            sendPort: this.sendPort,
            allowedDestinations: new Set(this.config.allowedDestinations),
            isOwner: (identity) => identity.source === 'feishu' && identity.subject === this.config.ownerOpenId,
            taskTopicEnabled: this.config.taskTopic?.enabled === true,
            ...(this._taskChannel ? { taskChannel: this._taskChannel } : {}),
            ...(this._taskHandoff ? { taskHandoff: this._taskHandoff } : {}),
          },
          envelope,
          action,
        );
      }
      if(this._taskHandoff && action.action==='confirm_handoff') {
        return handleTaskHandoffConfirmation(this._taskHandoff,this._taskChannel,this.sendPort,envelope,action);
      }
      const pending = handlePendingAction({
        hub: this._pendingHub, mainDestination: this.config.pendingHub?.destination, core: this.core, port: this.port,
        sendPort: this.sendPort, interactive: this.interactive, wake: () => this.wake(),
        authorize: e => e.identity.source === 'feishu' && e.identity.subject === this.config.ownerOpenId &&
          ((this.port.authorizedDestination?.(e.destination) ?? (this.config.allowedDestinations.includes(e.destination) ||
            this.channel.boundDestinations().includes(e.destination))) || !!this._taskChannel?.getBindingByDestination(e.destination)),
      },envelope,action);
      if (pending) return pending;
      if(this._taskChannel && this._taskChannel.getBindingByDestination(envelope.destination)) {
        if(action.action==='legacy_model') {
          if(!action.model && !action.invalid) return this.intakeTopic(envelope,{action:'models'});
          throw new TaskChannelError('invalid_request','use /models to switch target model');
        }
        return this.intakeTopic(envelope,action as TaskChannelAction);
      }
      if(
        ['confirm_handoff','switch_target','decision_answer','pending_page'].includes(action.action) ||
        ('entry' in action && action.entry!==undefined) ||
        ('taskId' in action && action.taskId!==undefined)
      ) {
        throw contractError('unsupported','action is unavailable for this destination');
      }
      return this.intakeTopic(envelope,action as ChannelAction);
    })();
    this.intakes.add(intake);
    try { const res=await intake; this.lastActivityAt=Date.now(); this.wake(); return res; } finally { this.intakes.delete(intake); }
  }
  /** A manual tick waits for both the background pass and its foreground consequences. */
  async tick():Promise<void> {
    if (this.closed || this.closing || this.baselinePreparing) throw new Error('closed or baseline preparation active');
    try {
      await this.runBackground(true);
    } finally {
      await this.interactive.flushInteractive();
    }
  }

  private async runBackground(settleIntake=false):Promise<void> {
    if (this.running) return this.running;
    this.running = this.backgroundPass(settleIntake);
    try {
      await this.running;
    } finally {
      this.running=undefined;
      if(this.wakePending && this.polling && !this.closing && !this.closed && !this.inPollCycle) {
        this.wakePending=false;
        if(this.timer) clearTimeout(this.timer);
        this.wakeScheduled=true;
        this.timer=setTimeout(this.pollRunner,50);
      }
    }
  }

  private async backgroundPass(settleIntake:boolean):Promise<void> {
    try {
      if(this.hasPendingOrActiveWork()) this.lastActivityAt=Date.now();
      await runBackgroundWork(this, this.interactive, () => this.port.drainInbound?.((e,a,scope)=>this.intakeTopic(e,a,scope)),
        () => this.options.refresh?.(this), this.options.requireReadonlyHydration === true, settleIntake);
      if(this.hasPendingOrActiveWork()) this.lastActivityAt=Date.now();
      this.lastError=null;
      this.core.clearTransientRefreshFailure();
      try { this.channel.recordHealth('core','healthy'); } catch {}
    } catch {
      try { this.channel.recordHealth('core','degraded','调度或同步失败'); } catch {}
      this.lastError='dispatch or synchronization failed; inspect persisted state before retry';
      throw new Error(this.lastError);
    }
  }

  emitWatchEvent(input: {
    source: WatchSource;
    objectId: string;
    state: WatchState;
    severity: WatchSeverity;
    title: string;
    summary: string;
    sourceRef?: WatchSourceRef;
    eventId?: string;
    onIngested?: () => void;
    onSettled?: () => void;
  }): void {
    if (!this._watchHub || this.closing || this.closed) {
      input.onSettled?.();
      return;
    }
    const task = this._watchHub.ingest({
      eventId: input.eventId ?? `rt:${randomUUID()}`,
      source: input.source,
      objectId: input.objectId,
      state: input.state,
      severity: input.severity,
      occurredAt: new Date().toISOString(),
      title: input.title,
      summary: input.summary,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    }).then(() => { input.onIngested?.(); this.wake(); }).catch(() => {}).finally(() => { input.onSettled?.(); });
    this.hubTasks.add(task);
    void task.finally(() => this.hubTasks.delete(task));
  }

  compactEventHistory(now = Date.now()): void {
    if (this.lastCompactionAt !== undefined && now - this.lastCompactionAt < 5 * 60_000) return;
    if (!this.legacyEventKeysSlimmed) this.legacyEventKeysSlimmed = this.store.slimLegacyEventKeys(5000) < 5000;
    const minimum = this.channel.minBoundEventCursorBySession();
    for (const [id, sequence] of this.taskChannel?.minBoundEventCursorBySession() ?? []) {
      minimum.set(id, Math.min(minimum.get(id) ?? sequence, sequence));
    }
    for (const { sessionId } of this.store.listSessions()) {
      const sequence = this.store.eventWatermark(sessionId);
      const floor = this.store.eventFloor(sessionId);
      const retentionFloor = Math.max(0, sequence - 20);
      const targetFloor = Math.min(minimum.get(sessionId) ?? retentionFloor, retentionFloor);
      if (targetFloor > floor && sequence - floor >= 50) {
        this.store.compactEvents(sessionId, encodeCursor(sessionId, targetFloor));
      }
    }
    this.lastCompactionAt = now;
  }

  syncUnknownDeliveryAlerts(): void {
    if (!this._watchHub || this.closing || this.closed) return;
    const deliveries = this.channel.pendingDeliveries().length;
    const inbox = this.channel.unknownInbox().length;
    const prev = this.lastUnknownDeliverySnapshot;
    const hasUnknown = deliveries > 0 || inbox > 0;
    const now = Date.now();
    const debounceMs = this.config.intervalMs >= 1000 ? 15_000 : 0;
    if (hasUnknown === (prev.deliveries > 0 || prev.inbox > 0)) {
      this.unknownDeliveryChangeSince = undefined;
    } else {
      this.unknownDeliveryChangeSince ??= now;
    }
    if (this.unknownDeliveryChangeSince !== undefined && now - this.unknownDeliveryChangeSince >= debounceMs) {
      this.unknownDeliveryChangeSince = undefined;
      this.lastUnknownDeliverySnapshot = { deliveries, inbox };
      if (hasUnknown) {
        this.emitWatchEvent({
          source: 'watch',
          objectId: 'runtime:unknown-deliveries',
          state: 'alert',
          severity: 'normal',
          title: '存在未确认投递或入站记录',
          summary: `当前存在 ${deliveries} 条未确认投递、${inbox} 条未知入站记录，请核对。`,
        });
      } else {
        this.emitWatchEvent({
          source: 'watch',
          objectId: 'runtime:unknown-deliveries',
          state: 'recovered',
          severity: 'low',
          title: '未确认投递与入站记录已清零',
          summary: '所有未确认投递与未知入站记录均已收敛。',
        });
      }
    }
    const currentUnknownOps = new Set(this.store.unknownOperationIds());
    for (const opId of currentUnknownOps) {
      if (this.alertedUnknownOperations.has(opId) || this.inFlightUnknownOpAlerts.has(`alert:${opId}`)) continue;
      this.inFlightUnknownOpAlerts.add(`alert:${opId}`);
      this.emitWatchEvent({
        source: 'watch',
        objectId: `operation.unknown:${opId}`,
        state: 'alert',
        severity: 'high',
        title: '操作投递结果未知',
        summary: `操作 ${opId} 处于未知交付状态（outcome_unknown），请先核对原端状态再决定是否重试。`,
        onIngested: () => { this.alertedUnknownOperations.add(opId); },
        onSettled: () => { this.inFlightUnknownOpAlerts.delete(`alert:${opId}`); },
      });
    }
    for (const opId of [...this.alertedUnknownOperations]) {
      if (currentUnknownOps.has(opId) || this.inFlightUnknownOpAlerts.has(`recover:${opId}`)) continue;
      this.inFlightUnknownOpAlerts.add(`recover:${opId}`);
      this.emitWatchEvent({
        source: 'watch',
        objectId: `operation.unknown:${opId}`,
        state: 'recovered',
        severity: 'low',
        title: '未知交付操作已收敛',
        summary: `操作 ${opId} 已离开未知交付状态。`,
        onIngested: () => { this.alertedUnknownOperations.delete(opId); },
        onSettled: () => { this.inFlightUnknownOpAlerts.delete(`recover:${opId}`); },
      });
    }
  }

  reportQuotaSnapshot(provider: Provider, snapshot: AgyQuotaSnapshot, thresholdPercent = 15): void {
    if (snapshot.state !== 'ok' || snapshot.stale) return;
    const lowWindows = [snapshot.short, snapshot.weekly]
      .filter((w): w is NonNullable<AgyQuotaSnapshot['short']> => Boolean(w) && Number.isFinite(w!.remainingPercent) && w!.remainingPercent < thresholdPercent);
    const source: WatchSource = provider === 'agy' ? 'agy_status' : provider === 'codex' ? 'codex_status' : 'watch';
    if (lowWindows.length > 0) {
      this.lowQuotaActive.add(provider);
      const detail = lowWindows.map(w => `${w.label} 剩余 ${Math.round(w.remainingPercent)}%${w.resetsAt ? `（重置：${w.resetsAt}）` : ''}`).join('；');
      this.emitWatchEvent({
        source,
        objectId: `provider:${provider}:quota`,
        state: 'alert',
        severity: 'normal',
        title: `${providerTitlePrefix(provider)} 配额低于 ${thresholdPercent}%`,
        summary: detail,
      });
    } else if ((snapshot.short || snapshot.weekly) && this.lowQuotaActive.delete(provider)) {
      const detail = [snapshot.short, snapshot.weekly]
        .filter((w): w is NonNullable<AgyQuotaSnapshot['short']> => Boolean(w))
        .map(w => `${w.label} 剩余 ${Math.round(w.remainingPercent)}%`).join('；');
      this.emitWatchEvent({
        source,
        objectId: `provider:${provider}:quota`,
        state: 'recovered',
        severity: 'low',
        title: `${providerTitlePrefix(provider)} 配额已恢复`,
        summary: detail || '配额已恢复至阈值以上。',
      });
    }
  }

  private isTaskTargetAuthorized(taskId: string, sessionId: string): boolean {
    if (this.closed || this.closing || !this._taskChannel) return false;
    const binding = this._taskChannel.getBinding(taskId);
    if (!binding || binding.state !== 'active') return false;
    const target = this._taskChannel.listTargets(taskId).find(t => t.sessionId === sessionId && t.accessMode === 'interactive');
    if (!target) return false;
    if (typeof this.port.lookupTaskTopic === 'function') {
      return !!this.port.lookupTaskTopic(binding.destination, this.config.ownerOpenId);
    }
    if (typeof this.port.authorizedDestination === 'function') {
      return this.port.authorizedDestination(binding.destination);
    }
    return true;
  }

  private collectInteractiveRestoreCandidates(provider?: Provider): Array<{
    sessionId: string;
    owner: Identity;
    stillAuthorized: () => Promise<boolean>;
    checkInitialAuth: () => Promise<boolean>;
  }> {
    const candidates: Array<{
      sessionId: string;
      owner: Identity;
      stillAuthorized: () => Promise<boolean>;
      checkInitialAuth: () => Promise<boolean>;
    }> = [];
    const matchesProvider = (sessionId: string): boolean => {
      if (!provider) return true;
      try { return this.store.getSession(sessionId).native.provider === provider; } catch { return false; }
    };
    for (const binding of this.channel.bindingsForRestore()) {
      if (binding.accessMode !== 'interactive' || !matchesProvider(binding.sessionId)) continue;
      candidates.push({
        sessionId: binding.sessionId,
        owner: binding.owner,
        checkInitialAuth: () => this.channel.isRestoreBindingAuthorized(binding),
        stillAuthorized: async () => {
          if (this.closed || this.closing) return false;
          for (const current of this.channel.bindingsForRestore()) {
            if (current.sessionId === binding.sessionId && current.owner.source === binding.owner.source &&
                current.owner.subject === binding.owner.subject && await this.channel.isRestoreBindingAuthorized(current)) return true;
          }
          return false;
        },
      });
    }
    if (this._taskChannel) {
      const ownerIdentity: Identity = { source: 'feishu', subject: this.config.ownerOpenId };
      for (const binding of this._taskChannel.listActiveBindings()) {
        for (const target of this._taskChannel.listTargets(binding.taskId)) {
          if (target.accessMode !== 'interactive' || !matchesProvider(target.sessionId)) continue;
          const taskId = binding.taskId;
          const sessionId = target.sessionId;
          candidates.push({
            sessionId,
            owner: ownerIdentity,
            checkInitialAuth: async () => this.isTaskTargetAuthorized(taskId, sessionId),
            stillAuthorized: async () => this.isTaskTargetAuthorized(taskId, sessionId),
          });
        }
      }
    }
    return candidates;
  }

  recordProviderConnection(provider:Provider,ready:boolean):void {if(ready)this.providerEverConnected.add(provider);try {this.channel.recordHealth(`${provider}_connection`,ready?'healthy':'degraded',ready?null:'连接不可用');} catch {}}
  setProviderReady(provider:Provider,ready:boolean):void {
    if (ready) {
      this.unavailableProviders.delete(provider);
      this.providerEverConnected.add(provider);
    } else {
      const wasReady = !this.unavailableProviders.has(provider);
      this.unavailableProviders.add(provider);
      const affectedSessionIds = new Set(
        this.collectInteractiveRestoreCandidates(provider)
          .filter(c => this.store.hasInteractiveIntent(c.sessionId) && !this.store.isDetached(c.sessionId))
          .map(c => c.sessionId),
      );
      for (const sessionId of affectedSessionIds) {
        this.recoveryFailedSessions.add(sessionId);
      }
      if (wasReady && this.providerEverConnected.has(provider)) {
        this.providerWasDisconnected.add(provider);
        this.emitWatchEvent({
          source: provider === 'agy' ? 'agy_status' : provider === 'codex' ? 'codex_status' : 'watch',
          objectId: `provider:${provider}:connection`,
          state: 'alert',
          severity: 'high',
          title: `${providerTitlePrefix(provider)} 连接断开`,
          summary: affectedSessionIds.size > 0
            ? `运行期连接断开，已登记 ${affectedSessionIds.size} 个受影响活跃会话待重连恢复。`
            : '运行期连接断开，正在等待自动重连。',
        });
      }
    }
    this.core.setProviderAvailable(provider,ready);
  }
  isProviderUnavailable(provider:Provider):boolean { return this.unavailableProviders.has(provider); }
  private canReconcileReleasedReadonly(session: Session): boolean {
    const { native: { provider }, sessionId, revision } = session;
    // Interactive intent persists through startup and disconnect, even when a provider reports no owner.
    return !this.unavailableProviders.has(provider) && this.core.hasProvider(provider) &&
      !this.store.hasInteractiveIntent(sessionId) && !this.store.recoveryQuarantined(sessionId) &&
      this.store.getSession(sessionId).revision === revision;
  }
  private recordRestoredSession(sessionId: string): void {
    this.recoveryFailedSessions.delete(sessionId);
    if (this.recoveryFailedSessions.size === 0 && this.recoveryFailure === sessionRecoveryFailure) this.recoveryFailure = null;
  }
  /** Explicit startup only; auto-resumes interrupted running sessions only when config.autoResumeOnRestart is enabled. */
  restoreBindings():Promise<void> {
    if(this.baselinePreparing) return Promise.reject(new Error('baseline preparation active')); if(this.recoveryStarted) return this.recoveryStarted;
    this.recoveryStarted=(async()=>{
      if (this.config.autoResumeOnRestart) {
        this.channel.pruneExpiredRestartResumeCandidates();
        this.captureRunningSessionsForRestart();
      }
      this.store.failUnreboundPending(this.restartPending);
      const candidatesByProvider = new Map<Provider, ReturnType<UnifiedRuntime['collectInteractiveRestoreCandidates']>>();
      for (const candidate of this.collectInteractiveRestoreCandidates()) {
        if (!this.store.hasInteractiveIntent(candidate.sessionId)) continue;
        let provider: Provider;
        try { provider = this.store.getSession(candidate.sessionId).native.provider; } catch { continue; }
        const candidates = candidatesByProvider.get(provider);
        if (candidates) candidates.push(candidate);
        else candidatesByProvider.set(provider, [candidate]);
      }
      for (const [provider, candidates] of candidatesByProvider) {
        const restoration = this.restoreStartupProvider(provider, candidates)
          .finally(() => this.startupRestorations.delete(provider));
        this.startupRestorations.set(provider, restoration);
      }
      const results = await Promise.allSettled(this.startupRestorations.values());
      if (results.some(result => result.status === 'rejected')) this.recoveryFailure='binding recovery failed; inspect before retry';
    })().catch(()=>{this.recoveryFailure='binding recovery failed; inspect before retry';});
    return this.recoveryStarted;
  }
  private async restoreStartupProvider(provider: Provider, candidates: ReturnType<UnifiedRuntime['collectInteractiveRestoreCandidates']>): Promise<void> {
    const handled = new Set<string>();
    for (const candidate of candidates) {
      if (this.closed || this.closing) return;
      const { sessionId, owner, stillAuthorized } = candidate;
      if (handled.has(sessionId) || !this.store.hasInteractiveIntent(sessionId)) continue;
      if (this.unavailableProviders.has(provider)) this.recoveryFailedSessions.add(sessionId);
      if (this.recoveryFailedSessions.has(sessionId)) {
        handled.add(sessionId);
        continue;
      }
      if (!await candidate.checkInitialAuth() || this.closed || this.closing) continue;
      handled.add(sessionId);
      if (this.recoveryFailedSessions.has(sessionId)) continue;
      try {
        await this.core.restoreInteractive(sessionId, owner, stillAuthorized);
        if (!this.recoveryFailedSessions.has(sessionId)) await this.maybeAutoResumeAfterRestore(sessionId);
      } catch {
        this.recoveryFailedSessions.add(sessionId);
        this.recoveryFailure = sessionRecoveryFailure;
      }
    }
  }
  isSessionPendingInteractiveRestore(session: Session): boolean {
    if (!this.store.hasInteractiveIntent(session.sessionId)) return false;
    return this.startupRestorations.has(session.native.provider) ||
      this.reconnectRestorations.has(session.native.provider) ||
      this.recoveryFailedSessions.has(session.sessionId);
  }
  /** Retry persisted interactive intent (including runtime-disconnected and taskTopic targets) for the provider that just reconnected. */
  async restoreProviderAfterReconnect(provider:Provider):Promise<{restored:string[];failed:string[]}> {
    this.reconnectRestorations.add(provider);
    try {
    const restoredIds: string[] = [];
    const failedIds: string[] = [];
    const startup = this.startupRestorations.get(provider);
    if (startup) await startup.catch(() => {});
    const unavailable = () => this.closed || this.closing || this.unavailableProviders.has(provider);
    if(unavailable()) return {restored:restoredIds,failed:failedIds};
    const handled = new Set<string>();
    for(const candidate of this.collectInteractiveRestoreCandidates(provider)) {
      if(unavailable()) return {restored:restoredIds,failed:failedIds};
      if(handled.has(candidate.sessionId) || !this.recoveryFailedSessions.has(candidate.sessionId) || !this.store.hasInteractiveIntent(candidate.sessionId)) continue;
      if(!await candidate.checkInitialAuth() || unavailable()) continue;
      handled.add(candidate.sessionId);
      try {
        const outcome = await this.core.restoreInteractiveWithOutcome(candidate.sessionId,candidate.owner,candidate.stillAuthorized);
        if (outcome === 'restored' && !unavailable()) {
          this.recordRestoredSession(candidate.sessionId);
          restoredIds.push(candidate.sessionId);
          await this.maybeAutoResumeAfterRestore(candidate.sessionId);
        }
      } catch {
        failedIds.push(candidate.sessionId);
      }
    }
    if(unavailable()) return {restored:restoredIds,failed:failedIds};
    if(failedIds.length > 0) this.recoveryFailure = sessionRecoveryFailure;
    if (this.providerWasDisconnected.delete(provider)) {
      this.emitWatchEvent({
        source: provider === 'agy' ? 'agy_status' : provider === 'codex' ? 'codex_status' : 'watch',
        objectId: `provider:${provider}:connection`,
        state: failedIds.length > 0 ? 'alert' : 'recovered',
        severity: failedIds.length > 0 ? 'high' : 'normal',
        title: failedIds.length > 0 ? `${providerTitlePrefix(provider)} 重连部分恢复失败` : `${providerTitlePrefix(provider)} 已重连并恢复`,
        summary: `恢复完成：成功 ${restoredIds.length} 个会话，失败 ${failedIds.length} 个会话。`,
      });
    }
    return {restored:restoredIds,failed:failedIds};
    } finally {
      this.reconnectRestorations.delete(provider);
    }
  }
  private hasPendingOrActiveWork():boolean {
    if(this.channel.pendingInbox().length>0) return true;
    if((this._taskChannel?.pendingInbox().length ?? 0)>0) return true;
    if(this.store.pendingOutbox().length>0) return true;
    if(this.store.listSessions().some(s=>s.status==='running' || s.status==='waiting_question' || s.status==='waiting_approval')) return true;
    if(this._watchHub?.listOutbox().some(r=>r.state==='pending')) return true;
    if(this._usageHub?.shouldFlushScheduled()) return true;
    if(this._decisionSync?.listDocOutbox().some(r=>r.state==='pending_sync')) return true;
    return false;
  }
  scheduleUsageWake():void {
    if(this.usageTimer) { clearTimeout(this.usageTimer); this.usageTimer=undefined; }
    if(!this._usageHub || !this.polling || this.closing || this.closed) return;
    const delay=Math.max(50,Math.min(2_147_483_647,this._usageHub.nextWakeDelayMs()));
    this.usageTimer=setTimeout(()=>{
      this.usageTimer=undefined;
      if(!this.closing && !this.closed && this.polling) this.wake();
    },delay);
    this.usageTimer.unref?.();
  }
  nextPollDelayMs(now=Date.now()):number {
    if(this.config.intervalMs<1000) return this.config.intervalMs;
    const idleMs=Math.max(0,now-this.lastActivityAt);
    if(idleMs<=120_000 || this.hasPendingOrActiveWork()) return Math.min(1000,this.config.intervalMs);
    if(idleMs<=600_000) return this.config.intervalMs;
    return Math.min(15000,this.config.intervalMs*3);
  }
  notifyChannelProgress(destination: string): void {
    if (!this.closing && !this.closed) this.interactive.notifyChannelProgress(destination);
  }
  wake():void {
    this.lastActivityAt=Date.now();
    if(!this.polling || this.closing || this.closed) return;
    if(this.running || this.inPollCycle) { this.wakePending=true; return; }
    if(this.wakeScheduled) return;
    if(this.timer) { clearTimeout(this.timer); this.timer=undefined; }
    this.wakeScheduled=true;
    this.timer=setTimeout(this.pollRunner,50);
  }
  private async runPollCycle():Promise<void> {
    if(!this.polling || this.closing || this.closed || this.inPollCycle) return;
    this.timer=undefined; this.wakeScheduled=false; this.inPollCycle=true;
    try {
      await this.restoreBindings().catch(()=>{});
      await this.runBackground().catch(()=>{});
    } finally {
      this.inPollCycle=false;
      if(this.polling && !this.closing && !this.closed) {
        const isWake=this.wakePending;
        this.wakePending=false;
        const delay=isWake ? 50 : this.nextPollDelayMs();
        if(this.timer) { clearTimeout(this.timer); this.timer=undefined; }
        this.wakeScheduled=isWake;
        this.timer=setTimeout(this.pollRunner,delay);
      }
    }
  }
  startPolling():void {
    if(this.closed || this.closing || this.polling || this.timer || this.baselinePreparing) throw new Error('runtime unavailable');
    this.polling=true;
    this.lastActivityAt=Date.now();
    this.scheduleUsageWake();
    void this.runPollCycle();
  }
  health():{status:'healthy'|'degraded';reason:string|null;unknownDeliveries:number;unknownInbox:number;resourceIssues:Array<{eventId:string;state:string;attempts:number;reason:string}>} { const unknownDeliveries=this.channel.pendingDeliveries().length; const unknownInbox=this.channel.unknownInbox().length; const resourceIssues=this.port.resourceIssues?.() ?? []; return {status:this.lastError || this.recoveryFailure || this.store.recoveryQuarantineCount() || unknownDeliveries || unknownInbox || resourceIssues.length ? 'degraded':'healthy',reason:this.lastError ?? this.recoveryFailure ?? (this.store.recoveryQuarantineCount() ? 'reconnect and explicitly attach quarantined sessions' : null),unknownDeliveries,unknownInbox,resourceIssues}; }
  prepareForShutdown(): void {
    if(this.usageTimer) { clearTimeout(this.usageTimer); this.usageTimer=undefined; }
    this.captureRunningSessionsForRestart();
  }
  private captureRunningSessionsForRestart(): void {
    if (!this.config.autoResumeOnRestart) return;
    try {
      const now = Date.now();
      for (const binding of this.channel.bindingsForRestore()) {
        if (binding.accessMode !== 'interactive') continue;
        let session: Session;
        try { session = this.store.getSession(binding.sessionId); } catch { continue; }
        const hasRunningTurn = session.status === 'running' ||
          this.store.listTurns(binding.sessionId).some(turn => turn.status === 'running');
        if (!hasRunningTurn) continue;
        this.channel.recordRestartResumeCandidate(binding.sessionId, binding.destination, binding.owner, now);
      }
    } catch {
      // Best-effort snapshot before shutdown or recovery.
    }
  }
  private async maybeAutoResumeAfterRestore(sessionId: string): Promise<boolean> {
    if (!this.config.autoResumeOnRestart || this.closed || this.closing) return false;
    const pending = this.channel.peekRestartResumeCandidate(sessionId);
    if (!pending) return false;
    let current: Session;
    try { current = this.store.getSession(sessionId); } catch { return false; }
    if (current.control.input !== 'available' || current.status !== 'idle') return false;
    if (this.channel.accessMode(pending.destination) !== 'interactive') return false;
    const binding = this.channel.bindingsForRestore().find(b => b.destination === pending.destination && b.sessionId === sessionId);
    if (!binding) return false;
    const bindingScope = JSON.stringify({
      session_id: binding.sessionId,
      binding_id: binding.bindingId,
      revision: binding.revision,
      access_mode: binding.accessMode,
    });
    const channelScope = {
      destination: pending.destination,
      bindingScope,
      ownerSource: pending.owner.source,
      ownerSubject: pending.owner.subject,
    };
    const operationId = `restart-resume:${sessionId}:${pending.interruptedAt}`;
    try {
      await this.core.submitInput({
        context: {
          operationId,
          idempotencyKey: operationId,
          targetId: sessionId,
          expectedRevision: current.revision,
          controlGeneration: current.control.generation,
          identity: pending.owner,
          channelScope,
        },
        mode: 'new',
        blocks: [{ type: 'text', text: '服务刚刚完成重启恢复，请无感衔接刚才中断的任务继续执行并给出完整结果。' }],
        channelScope,
      });
      this.channel.consumeRestartResumeCandidate(sessionId);
      this.notifyChannelProgress(pending.destination);
      return true;
    } catch {
      return false;
    }
  }
  close():Promise<void> {
    if(this.closePromise) return this.closePromise;
    this.captureRunningSessionsForRestart();
    this.closing=true; this.polling=false; this.wakePending=false; this.wakeScheduled=false;
    if(this.timer) { clearTimeout(this.timer); this.timer=undefined; }
    if(this.usageTimer) { clearTimeout(this.usageTimer); this.usageTimer=undefined; }
    const running=this.running; const intakes=[...this.intakes]; const hubTasks=[...this.hubTasks];
    this.closePromise=(async()=>{ await Promise.allSettled(intakes); await running?.catch(()=>{}); await this.interactive.close().catch(()=>{}); await Promise.allSettled(hubTasks); try { await Promise.all(this.providers.map(p=>p.close?.())); } finally { try { try { this._usageHub?.close(); } catch {} try { this._taskHandoff?.close(); } catch {} try { this._taskChannel?.close(); } catch {} try { this._pendingHub?.close(); } catch {} try { this._watchHub?.close(); } catch {} try { this._decisionSync?.close(); } catch {} this.core.close(); this.channel.close(); this.store.close(); } finally { this.lock.exec('ROLLBACK'); this.lock.close(); this.options.cleanup?.(); this.closed=true; } } })();
    return this.closePromise;
  }
}
const canonicalPath=(path:string):string => { const p=resolve(path); return existsSync(p) ? realpathSync(p) : join(realpathSync(dirname(p)),basename(p)); };
const inside=(child:string,root:string):boolean => {const rel=relative(root,child);return rel==='' || (!isAbsolute(rel) && rel!=='..' && !rel.startsWith(`..${sep}`));};

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function canonicalDirectory(path: string | null): string | null {
  if (!path || !isAbsolute(path)) return null;
  try {
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function trustedDiscoveryProject(project: string | null, canonicalRoots: readonly string[]): string | null {
  const canonical = canonicalDirectory(project);
  return canonical && canonicalRoots.some(root => inside(canonical, root)) ? canonical : null;
}

function runtimeServiceId(config: RuntimeConfig, provider: Provider): string | undefined {
  return provider === 'claude' ? config.claudeServiceId : provider === 'codex' ? config.codexServiceId :
    config.agy?.enabled !== false ? config.agy?.serviceId : undefined;
}

function discoverySourceAllowed(config: RuntimeConfig, native: Omit<Session['native'], 'nativeSessionId'>,
    sources: readonly CatalogRoot[]): boolean {
  return native.hostId === config.hostId && native.serviceId === runtimeServiceId(config, native.provider) &&
    (native.provider === 'agy' || sources.some(source =>
      source.provider === native.provider && source.hostId === native.hostId && source.serviceId === native.serviceId));
}

/** Construct enrichment under a separate state lock; no network connections are opened. */
export async function createIntegratedRuntime(config:RuntimeConfig, port:FeishuPort, bases:PlatformPort[]):Promise<UnifiedRuntime> {
  validateRuntimeConfig(config);
  if (!config.artifactStatePath || !config.catalogSources || !config.allowedProjectRoots || !config.outputRoots) throw new Error('explicit catalog, root and artifact state configuration required');
  const agyEnabled = config.agy !== undefined && config.agy.enabled !== false;
  const persistent=[config.coreDb,config.channelDb,config.artifactStatePath,...(agyEnabled && config.agy?.quotaCachePath ? [config.agy.quotaCachePath] : []),...(config.watchHub?.enabled ? [resolveWatchHubDbPath(config)] : []),...(config.pendingHub?.enabled ? [resolvePendingHubDbPath(config)] : []),...(config.decisionSync?.enabled ? [resolveDecisionSyncDbPath(config)] : []),...(config.usageHub?.enabled ? [resolveUsageHubDbPath(config)] : [])].map(canonicalPath); if (new Set(persistent).size !== persistent.length) throw new Error('runtime state paths must be distinct');
  const projects=config.allowedProjectRoots.map(x=>realpathSync(x)), outputs=config.outputRoots.map(x=>realpathSync(x));
  const sources=config.catalogSources.map(s=>({...s,directory:realpathSync(s.directory)}));
  const serviceIdFor=(provider:Provider):string|undefined=>runtimeServiceId(config,provider);
  const resolveDiscoveryProject = (native: Omit<Session['native'], 'nativeSessionId'>, project: string | null): string | null =>
    discoverySourceAllowed(config, native, sources) ? trustedDiscoveryProject(project, projects) : null;
  const trusted=(s:Session):boolean=>resolveDiscoveryProject(s.native,s.project)!==null;
  const registry=new ArtifactRegistry({},20*1024*1024,config.artifactStatePath); const catalog=new LocalCatalog(sources); const discovered=new Set<string>(); let enrichmentError=false;
  const configure=(s:Session)=>{if(!trusted(s)) throw new Error('session outside trusted configuration'); const project=realpathSync(s.project); registry.setRoots(s.native,outputs.filter(root=>inside(root,project))); registry.setProjectRoot(s.native,project);};
  // Pin each verified native ref to its canonical project; provider events alone cannot establish authority.
  const pinned=new Map<string,Session>();
  const buffered:Array<{observation:PlatformObservation; listener:(o:PlatformObservation)=>void; bytes:number; expires:number}> = [];
  let bufferedBytes=0; let activeRuntime:UnifiedRuntime|undefined;
  const discard=(index:number):void=>{bufferedBytes-=buffered[index]!.bytes;buffered.splice(index,1);};
  const queueObservation=(observation:PlatformObservation,listener:(o:PlatformObservation)=>void):void=>{
    let copy:PlatformObservation, bytes:number; try {copy=structuredClone(observation);bytes=Buffer.byteLength(JSON.stringify(copy));} catch {enrichmentError=true;return;}
    if(bytes>65536 || buffered.length>=128 || bufferedBytes+bytes>1024*1024) {enrichmentError=true;return;}
    buffered.push({observation:copy,listener,bytes,expires:Date.now()+60000});bufferedBytes+=bytes;
  };
  const discardRef=(ref:Session['native']):void=>{for(let i=buffered.length-1;i>=0;i--) if(nativeRefKey(buffered[i]!.observation.ref)===nativeRefKey(ref)) {discard(i);enrichmentError=true;}};
  const pin=(session:Session):boolean=>{
    if (!trusted(session) || !session.native.nativeSessionId || session.control.serviceId!==session.native.serviceId) return false;
    const key=nativeRefKey(session.native), previous=pinned.get(key);
    try { if(previous && realpathSync(previous.project)!==realpathSync(session.project)) return false; } catch { return false; }
    pinned.set(key,structuredClone(session)); return true;
  };
  const namespace=(ref:Session['native'],provider:PlatformPort['provider']):boolean=>ref.provider===provider && ref.hostId===config.hostId && ref.serviceId===serviceIdFor(provider) && !!ref.nativeSessionId;
  const secured=(base:PlatformPort):PlatformPort=>new Proxy(base, {get(target,key) {
    if (key==='hasActiveNativeSession') return (ref: Session['native']) => {
      const session = pinned.get(nativeRefKey(ref));
      return namespace(ref,target.provider) && !!session && trusted(session) && target.hasActiveNativeSession?.(ref) === true;
    };
    if(key==='list') return async (cursor:string|null,limit:number)=>{ const page=await target.list(cursor,limit); return {...page,items:page.items.filter(s=>{if(!namespace(s.native,target.provider)) {enrichmentError=true;return false;} if(!trusted(s)) return false; const ok=pin(s); if(!ok) enrichmentError=true; return ok;})}; };
    if(key==='read') return async (ref:Session['native'])=>{ if(!namespace(ref,target.provider)) throw contractError('invalid_request','provider namespace mismatch'); const snapshot=await target.read(ref); if(payloadDigest(snapshot.session.native)!==payloadDigest(ref) || !pin(snapshot.session)) throw contractError('invalid_request','provider session metadata mismatch'); return snapshot; };
    if(key==='onObservation') return (listener:(o:PlatformObservation)=>void)=>target.onObservation(o=>{
      if(!namespace(o.ref,target.provider)) {enrichmentError=true;return;}
      const existing=pinned.get(nativeRefKey(o.ref));
      if(!existing || !activeRuntime?.store.findSession(o.ref)) {queueObservation(o,listener);return;}
      if(!trusted(existing) || (o.type==='session' && (payloadDigest(o.session.native)!==payloadDigest(o.ref) || !pin(o.session)))) {enrichmentError=true; return;}
      listener(o.type==='session' ? {...o,session:privateTitle(o.session)} : o);
    });
    const value=Reflect.get(target,key,target); return typeof value==='function' ? value.bind(target) : value;
  }});
  const showAutoTitles = config.autoMirror?.showTitles === true;
  const isMissingReadonlyProject = (s: Session): boolean => s.status === 'read_only' && s.control.input !== 'available' && !existsSync(s.project);
  const privateTitle=(session:Session):Session=>(!showAutoTitles && activeRuntime?.channel.isAutoPrivateTitle(session.native)) ? {...session,title:`${providerTitlePrefix(session.native.provider)} 会话 · ${payloadDigest(session.native).slice(0,8)}`} : session;
  class ScopedPort extends EnrichedPort {
    override seedConnectionGeneration(minimum:number):void { super.seedConnectionGeneration(minimum); }
    override seedControlGeneration(ref:Session['native'],minimum:number):void { if(!namespace(ref,this.provider)) throw contractError('invalid_request','provider namespace mismatch'); super.seedControlGeneration(ref,minimum); }
    override async list(cursor:string|null,limit:number) { const page=await super.list(cursor,limit); const items=page.items.filter(s=>{if(!namespace(s.native,this.provider)) {enrichmentError=true;return false;} if(!trusted(s)) return false; if(!pin(s)) {enrichmentError=true;return false;} configure(s); discovered.add(`session_${payloadDigest(s.native)}`); return true;}).map(privateTitle); return {...page,items}; }
    override async discoverNewer(watermark:number,cursor:string|null,limit:number) {const page=await super.discoverNewer(watermark,cursor,limit);const items=page.items.filter(s=>{if(!namespace(s.native,this.provider)) {enrichmentError=true;return false;}if(!trusted(s))return false;if(!pin(s)){enrichmentError=true;return false;}configure(s);discovered.add(`session_${payloadDigest(s.native)}`);return true;}).map(privateTitle);return {...page,items};}
    override async discoverRunning(cursor:string|null,limit:number) { const page=await super.discoverRunning(cursor,limit); const items=page.items.filter(s=>{if(!namespace(s.native,this.provider)) {enrichmentError=true;return false;} if(!trusted(s)) return false; if(!pin(s)) {enrichmentError=true;return false;} configure(s); discovered.add(`session_${payloadDigest(s.native)}`); return true;}).map(privateTitle); return {...page,items}; }
    override async read(ref:Session['native']) { if(!namespace(ref,this.provider))throw contractError('invalid_request','provider namespace mismatch');const result=(!showAutoTitles && activeRuntime?.channel.isAutoPrivateTitle(ref)) ? (ref.provider==='claude' ? await readOldClaude(bases.find(p=>p.provider==='claude')!,ref) : ref.provider==='codex' ? await readOldCodex(bases.find(p=>p.provider==='codex')!,ref) : await readOldAgy(bases.find(p=>p.provider==='agy')!,ref)) : await super.read(ref); if(payloadDigest(result.session.native)!==payloadDigest(ref) || !pin(result.session)) throw contractError('invalid_request','provider session metadata mismatch'); configure(result.session); return {...result,session:privateTitle(result.session)}; }
    override async inspectTurnResidual(ref:Session['native'],turnId:string) {const pinnedSession=pinned.get(nativeRefKey(ref));if(!namespace(ref,this.provider) || !pinnedSession || !trusted(pinnedSession)) throw contractError('unauthorized','provider session scope unavailable');return super.inspectTurnResidual(ref,turnId);}
    override async create(cwd:string,model:string|null) {
      let project:string; try { project=realpathSync(cwd); } catch {throw contractError('invalid_request','untrusted project');}
      const allowedCreate=this.provider==='agy' ? agyEnabled && bases.some(x=>x.provider==='agy') : sources.some(x=>x.provider===this.provider && x.hostId===config.hostId && x.serviceId===serviceIdFor(this.provider));
      if(!allowedCreate || !projects.some(root=>inside(project,root))) throw contractError('invalid_request','untrusted project');
      const effectiveModel = this.provider === 'agy' && model === null && config.agy?.defaultModel ? config.agy.defaultModel : model;
      const ack=await super.create(cwd,effectiveModel); const s=ack.createdSession;
      // A native call has occurred: any inconsistent or unverifiable result has unknown outcome.
      if(ack.status!=='submitted' || !ack.nativeReference || !s || !namespace(s.native,this.provider) || s.native.nativeSessionId!==ack.nativeReference || !trusted(s)) {if(s?.native) discardRef(s.native);throw contractError('outcome_unknown','provider create metadata mismatch');}
      let returnedProject:string; try {returnedProject=realpathSync(s.project);} catch {throw contractError('outcome_unknown','provider project unavailable');}
      if(returnedProject!==project || !pin(s)) {discardRef(s.native);throw contractError('outcome_unknown','provider create project mismatch');}
      configure(s); return ack;
    }
    override async resume(ref:Session['native']) {
      await this.read(ref); const ack=await super.resume(ref);
      if(ack.nativeReference!==ref.nativeSessionId || (ack.createdSession && (payloadDigest(ack.createdSession.native)!==payloadDigest(ref) || !pin(ack.createdSession)))) throw contractError('outcome_unknown','provider resume metadata mismatch');
      return ack;
    }
  }
  const ports=bases.map(base=>new ScopedPort(secured(base),catalog,registry,()=>{enrichmentError=true;}));
  const stateLock=new DatabaseSync(`${canonicalPath(config.artifactStatePath)}.runtime-lock`); try {stateLock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');} catch {stateLock.close(); await Promise.all(ports.map(p=>p.close())); throw new Error('artifact state already active');}
  let proofPending:Promise<unknown>|undefined;
  const proofClaude=async(item:Session):Promise<boolean>=>{if(proofPending) throw new Error('source proof pending');const p=catalog.isClaudeCliMain(item.native,item.project);proofPending=p;void p.finally(()=>{if(proofPending===p)proofPending=undefined;}).catch(()=>{});let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('source proof timed out')),2000);})]);}finally{if(timer)clearTimeout(timer);}};
  const activityClaude=async(item:Session,messages:Message[],watermark:number,observed:number):Promise<string|null>=>{if(proofPending)throw new Error('source proof pending');const p=catalog.claudeActivityBoundary(item.native,item.project,messages,watermark,observed);proofPending=p;void p.finally(()=>{if(proofPending===p)proofPending=undefined;}).catch(()=>{});let timer:ReturnType<typeof setTimeout>|undefined;try{const result=await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('source proof timed out')),2000);})]);if(result==='uncertain'){runtime.channel.markAutoUncertain(config.autoMirror!.destination!,item.native);return null;}return result;}finally{if(timer)clearTimeout(timer);}};
  let oldClaudeCursor:string|null=null;let oldListPending:Promise<unknown>|undefined;let oldReadPending:Promise<unknown>|undefined;let oldCodexCursor:string|null=null;let codexListPending:Promise<unknown>|undefined;let codexActivityPending:Promise<unknown>|undefined;let codexReadPending:Promise<unknown>|undefined;const seenCodexCursors=new Set<string>();
  let oldAgyCursor:string|null=null;let agyListPending:Promise<unknown>|undefined;let agyActivityPending:Promise<unknown>|undefined;let agyReadPending:Promise<unknown>|undefined;const seenAgyCursors=new Set<string>();
  const runBounded=<T>(getPending:()=>Promise<unknown>|undefined,setPending:(p:Promise<unknown>|undefined)=>void,timeoutMs:number,pendingMsg:string,timeoutMsg:string,run:()=>Promise<T>):Promise<T>=>{if(getPending())throw new Error(pendingMsg);const p=run();setPending(p);void p.finally(()=>{if(getPending()===p)setPending(undefined);}).catch(()=>{});let timer:ReturnType<typeof setTimeout>|undefined;return Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(timeoutMsg)),timeoutMs);})]).finally(()=>{if(timer)clearTimeout(timer);});};
  const readOldCodex=(base:PlatformPort,ref:Session['native'])=>runBounded(()=>codexReadPending,p=>{codexReadPending=p;},2000,'old codex read pending','old codex read timed out',()=>base.read(ref));
  const listOldCodex=(base:PlatformPort,cursor:string|null)=>runBounded(()=>codexListPending,p=>{codexListPending=p;},2000,'old codex scan pending','old codex scan timed out',()=>{if(!base.discoverExisting)throw new Error('unsupported');return base.discoverExisting(cursor,1);});
  const readCodexActivity=(base:PlatformPort,ref:Session['native'],watermark:number,observed:number)=>runBounded(()=>codexActivityPending,p=>{codexActivityPending=p;},2000,'old codex read pending','old codex read timed out',()=>{if(!base.readAutoActivity)throw new Error('unsupported');return base.readAutoActivity(ref,watermark,observed);});
  const readOldAgy=(base:PlatformPort,ref:Session['native'])=>runBounded(()=>agyReadPending,p=>{agyReadPending=p;},2000,'old agy read pending','old agy read timed out',()=>base.read(ref));
  const listOldAgy=(base:PlatformPort,cursor:string|null)=>runBounded(()=>agyListPending,p=>{agyListPending=p;},2000,'old agy scan pending','old agy scan timed out',()=>{if(!base.discoverExisting)throw new Error('unsupported');return base.discoverExisting(cursor,1);});
  const readAgyActivity=(base:PlatformPort,ref:Session['native'],watermark:number,observed:number)=>runBounded(()=>agyActivityPending,p=>{agyActivityPending=p;},2000,'old agy read pending','old agy read timed out',()=>{if(!base.readAutoActivity)throw new Error('unsupported');return base.readAutoActivity(ref,watermark,observed);});
  const readOldClaude=(base:PlatformPort,ref:Session['native'])=>runBounded(()=>oldReadPending,p=>{oldReadPending=p;},2000,'old read pending','old read timed out',()=>base.read(ref));
  const listOldClaude=(base:PlatformPort,cursor:string|null)=>runBounded(()=>oldListPending,p=>{oldListPending=p;},2000,'old scan pending','old scan timed out',()=>{const call=base.discoverExisting?.bind(base) ?? base.list.bind(base);return call(cursor,1);});
  const errorText=(err:unknown):string=>{if(err && typeof err==='object') { const obj=err as {message?:unknown;detail?:{message?:unknown}}; if(typeof obj.detail?.message==='string') return obj.detail.message; if(typeof obj.message==='string') return obj.message; } return err instanceof Error ? err.message : String(err ?? '');};
  const isMissingReadonlySessionError=(s:Session,err:unknown):boolean=>{if(s.status!=='read_only' || s.control.input==='available') return false; if(!existsSync(s.project)) return true; const obj=err && typeof err==='object' ? err as {code?:unknown;detail?:{code?:unknown}} : null; if((obj?.code ?? obj?.detail?.code)==='ENOENT') return true; const msg=errorText(err).trim(); return /^(?:agy )?session not found$/i.test(msg) || /thread not found|no rollout found/i.test(msg);};
  const isPendingContentionError=(err:unknown):boolean=>/(?:still|already) pending$|^old (?:codex |agy )?(?:scan|read) pending$|^source proof pending$/i.test(errorText(err).trim());
  const isMetadataTimeoutError=(err:unknown):boolean=>/^(?:old (?:codex |agy )?(?:scan|read) timed out|metadata read timed out|provider list timed out|source proof timed out)$/i.test(errorText(err).trim());
  const autoTimeoutStreaks=new Map<string,number>();
  const refreshTimeoutStreaks=new Map<string,number>();
  const agyBrainDir = agyEnabled ? config.agy?.brainDir : undefined;
  const lastTranscriptStat = new Map<string, string>();
  const scannedAssistantMessages = new Map<string, number>();
  const agyTranscriptSignature = (nativeSessionId: string): string | null => {
    if (!agyBrainDir || !nativeSessionId || nativeSessionId.includes('/') || nativeSessionId.includes('..')) return null;
    const logsDir = join(agyBrainDir, nativeSessionId, '.system_generated', 'logs');
    let compact = '';
    let full = '';
    try { const st = statSync(join(logsDir, 'transcript.jsonl')); compact = `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`; } catch {}
    try { const st = statSync(join(logsDir, 'transcript_full.jsonl')); full = `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`; } catch {}
    return `${compact}|${full}`;
  };
  let fastAgyTimer: ReturnType<typeof setInterval> | undefined;
  let fastRefreshing = false;
  let runtime:UnifiedRuntime; let refreshOffset=0; let autoCursor:string|null=null; let agyAutoCursor:string|null=null; const recentCursors:Record<Provider,string|null>={codex:null,claude:null,agy:null}; const scopeByProvider:Record<Provider,Array<{root:string;watermark:number}>>={codex:[],claude:[],agy:[]}; const localCodexClock=isLocalCodexEndpoint(config.codexEndpoint);
  const codexNewerCooldownMs = config.intervalMs >= 1000 ? 30_000 : 0;
  const codexOldCooldownMs = config.intervalMs >= 1000 ? 90_000 : 0;
  let nextCodexNewerAt = 0;
  let nextCodexOldAt = 0;
  const backfillDone = new Set<string>();
  try { runtime=new UnifiedRuntime(config,port,ports,{canDiscover:trusted,resolveDiscoveryProject,canInspectCandidate:(native,project)=>native.provider==='codex'&&resolveDiscoveryProject(native,project)!==null,allowDiscovered:id=>discovered.has(id),requireReadonlyHydration:true,allowedProjectRoots:config.allowedProjectRoots,cleanup:()=>{if(fastAgyTimer){clearInterval(fastAgyTimer);fastAgyTimer=undefined;}stateLock.exec('ROLLBACK');stateLock.close();},refresh:async r=>{
      let autoFailed=false;
      const handleAutoFailure=(key:string,err:unknown):void=>{if(isPendingContentionError(err))return;if(isMetadataTimeoutError(err)){const next=(autoTimeoutStreaks.get(key)??0)+1;autoTimeoutStreaks.set(key,next);if(next<3)return;}autoFailed=true;};
      try {await r.channel.applyPendingAutoBaselines();} catch {autoFailed=true;}
      if(config.autoMirror?.enabled) {
        try {
        const target=config.autoMirror.destination!, authorized=(port as FeishuPort & {authorizedDestination?:(destination:string)=>boolean}).authorizedDestination?.bind(port);
        if (!(authorized?.(target) ?? config.allowedDestinations.includes(target))) throw new Error('auto mirror destination unavailable');
        const autoProviders: readonly Provider[] = agyEnabled ? ['codex','claude','agy'] : ['codex','claude'];
        for(const provider of autoProviders) {
          if(r.isProviderUnavailable(provider)) continue;
          try {
        const source=ports.find(p=>p.provider===provider);if(!source)continue;const scopes=scopeByProvider[provider];const autoWatermark=scopes.length ? Math.min(...scopes.map(x=>x.watermark)) : null;
        const time=(iso:string|undefined):number=>iso ? (provider==='codex'?Date.parse(iso)/1000:Date.parse(iso)) : NaN;
        const clock=()=>provider==='codex'?Math.floor(Date.now()/1000):Date.now();
        const watermarkFor=(item:Session):number|null=>{try {const project=realpathSync(item.project);const matching=scopes.filter(x=>inside(project,x.root)).map(x=>x.watermark);return matching.length ? Math.min(...matching) : null;}catch{return null;}};
        const oldCandidates=new Set<string>(),activePrivateCandidates=new Set<string>();const candidates:Session[]=[]; if(provider==='codex' && localCodexClock && autoWatermark!==null && bases.find(p=>p.provider==='codex')?.discoverExisting && (oldCodexCursor!==null || Date.now()>=nextCodexOldAt)) try {const base=bases.find(p=>p.provider==='codex')!;const page=await listOldCodex(base,oldCodexCursor);autoTimeoutStreaks.delete('codex:old');const allStaleByUpdated=config.intervalMs>=1000 && page.items.length>0 && page.items.every(item=>{const u=time(item.updatedAt);return Number.isSafeInteger(u) && u<=autoWatermark;});if(allStaleByUpdated || page.nextCursor===null){seenCodexCursors.clear();oldCodexCursor=null;nextCodexOldAt=Date.now()+codexOldCooldownMs;}else {if(seenCodexCursors.has(page.nextCursor))throw new Error('cursor cycle');if(seenCodexCursors.size>=10000)seenCodexCursors.delete(seenCodexCursors.values().next().value!);seenCodexCursors.add(page.nextCursor);oldCodexCursor=page.nextCursor;}if(page.partialFailure)autoFailed=true;for(const item of page.items){if(!namespace(item.native,'codex')||!trusted(item)||!pin(item))continue;configure(item);discovered.add(`session_${payloadDigest(item.native)}`);const created=time(item.createdAt),mark=watermarkFor(item),updated=time(item.updatedAt);if(config.intervalMs>=1000 && Number.isSafeInteger(updated) && mark!==null && updated<=mark)continue;if(mark!==null && Number.isSafeInteger(created) && created<=mark){oldCandidates.add(payloadDigest(item.native));candidates.push(item);}}}catch(err){oldCodexCursor=null;seenCodexCursors.clear();nextCodexOldAt=Date.now()+codexOldCooldownMs;handleAutoFailure('codex:old',err);} if(provider==='agy' && autoWatermark!==null && bases.find(p=>p.provider==='agy')?.discoverExisting) try {const base=bases.find(p=>p.provider==='agy')!;const page=await listOldAgy(base,oldAgyCursor);autoTimeoutStreaks.delete('agy:old');if(page.nextCursor!==null){if(seenAgyCursors.has(page.nextCursor))throw new Error('cursor cycle');if(seenAgyCursors.size>=10000)seenAgyCursors.delete(seenAgyCursors.values().next().value!);seenAgyCursors.add(page.nextCursor);}else seenAgyCursors.clear();oldAgyCursor=page.nextCursor;if(page.partialFailure)autoFailed=true;for(const item of page.items){if(!namespace(item.native,'agy')||!trusted(item)||!pin(item))continue;configure(item);discovered.add(`session_${payloadDigest(item.native)}`);const created=time(item.createdAt),mark=watermarkFor(item);if(mark!==null && Number.isSafeInteger(created) && created<=mark){oldCandidates.add(payloadDigest(item.native));candidates.push(item);}}}catch(err){oldAgyCursor=null;seenAgyCursors.clear();handleAutoFailure('agy:old',err);} if(provider==='claude' && autoWatermark!==null) try {const base=bases.find(p=>p.provider==='claude')!;const page=await listOldClaude(base,oldClaudeCursor);autoTimeoutStreaks.delete('claude:old');oldClaudeCursor=page.nextCursor;if(page.partialFailure)autoFailed=true;for(const item of page.items){if(!namespace(item.native,'claude')||!trusted(item)||!pin(item))continue;configure(item);discovered.add(`session_${payloadDigest(item.native)}`);const created=time(item.createdAt),mark=watermarkFor(item);if(mark!==null && Number.isSafeInteger(created) && created<=mark){oldCandidates.add(payloadDigest(item.native));candidates.push(item);}}}catch(err){oldClaudeCursor=null;handleAutoFailure('claude:old',err);} if((provider==='claude'||provider==='agy'||localCodexClock) && autoWatermark!==null && bases.find(p=>p.provider===provider)?.discoverNewer && (provider!=='codex' || recentCursors.codex!==null || Date.now()>=nextCodexNewerAt)) {try {const recent=await source.discoverNewer(autoWatermark,recentCursors[provider],1);autoTimeoutStreaks.delete(`${provider}:newer`);recentCursors[provider]=recent.nextCursor;if(provider==='codex' && recent.nextCursor===null) nextCodexNewerAt=Date.now()+codexNewerCooldownMs;if(recent.partialFailure)autoFailed=true;for(const item of recent.items) {const created=time(item.createdAt),observed=item.discoveryObservedAt ? time(item.discoveryObservedAt) : clock();if(Number.isSafeInteger(created) && Number.isSafeInteger(observed) && created>observed) r.channel.markAutoUncertain(target,item.native);else if(Number.isSafeInteger(created) && watermarkFor(item)!==null && created>watermarkFor(item)! && created<=observed && !r.channel.isAutoUncertain(target,item.native)) {if(!candidates.some(x=>payloadDigest(x.native)===payloadDigest(item.native)))candidates.push(item);}}} catch(err) {recentCursors[provider]=null;if(provider==='codex') nextCodexNewerAt=Date.now()+codexNewerCooldownMs;handleAutoFailure(`${provider}:newer`,err);}} if(provider==='codex' || provider==='agy') try {const cursor=provider==='codex'?autoCursor:agyAutoCursor;const active=await source.discoverRunning(cursor,1);autoTimeoutStreaks.delete(`${provider}:running`);if(provider==='codex')autoCursor=active.nextCursor;else agyAutoCursor=active.nextCursor;if(active.partialFailure)autoFailed=true;for(const item of active.items){activePrivateCandidates.add(payloadDigest(item.native));oldCandidates.delete(payloadDigest(item.native));if(!candidates.some(x=>payloadDigest(x.native)===payloadDigest(item.native))) candidates.push(item);}} catch(err) {if(provider==='codex')autoCursor=null;else agyAutoCursor=null;handleAutoFailure(`${provider}:running`,err);}
        for(const item of candidates) {
          try {
          if (!(authorized?.(target) ?? config.allowedDestinations.includes(target)) || !trusted(item)) continue;
          if(provider==='claude' && !await proofClaude(item)) continue;
          if(!r.acceptsBackgroundWork()) continue;
          const created=time(item.createdAt);const observed=item.discoveryObservedAt ? time(item.discoveryObservedAt) : clock();if(Number.isSafeInteger(created) && Number.isSafeInteger(observed) && created>observed) r.channel.markAutoUncertain(target,item.native);
          let session=r.store.findSession(item.native);
          if(!session) {
            const capabilities=Object.fromEntries(Object.entries(item.capabilities).map(([name,value])=>[name,name==='view'?value:{status:'unsupported',reason:'discovered session is read-only until attached'}])) as Session['capabilities'];
            const maskCandidateTitle=!showAutoTitles && (oldCandidates.has(payloadDigest(item.native)) || activePrivateCandidates.has(payloadDigest(item.native)));
            const candidate:Session={...item,...(maskCandidateTitle ? {title:`${providerTitlePrefix(provider)} 会话 · ${payloadDigest(item.native).slice(0,8)}`} : {}),sessionId:`session_${payloadDigest(item.native)}`,status:'read_only',capabilities,control:{...item.control,owner:null,input:'unavailable',reason:'discovered session is not attached'}};
            try {r.store.insertSession(candidate);session=candidate;} catch(error) {session=r.store.findSession(item.native);if(!session)throw error;}
          }
          if(r.store.isDetached(session.sessionId) || !trusted(session)) continue;
          const eventId=`auto-mirror:${payloadDigest([target,item.native])}`;
          await r.channel.applyAutoBaseline(eventId);
          if(r.channel.bindingsForRestore().some(b=>b.sessionId===session!.sessionId)) continue;
          if(!showAutoTitles && (provider==='codex' || provider==='agy') && activePrivateCandidates.has(payloadDigest(item.native))){const current=r.store.getSession(session.sessionId);if(current.status!=='read_only'||current.control.input==='available')continue;r.channel.markAutoPrivateTitle(item.native);const title=`${providerTitlePrefix(provider)} 会话 · ${payloadDigest(item.native).slice(0,8)}`;if(current.title!==title)r.store.updateSession({...current,title,revision:current.revision+1},current.revision,current.control.generation);}
          if(provider==='claude' && oldCandidates.has(payloadDigest(item.native))){const mark=watermarkFor(item);if(mark===null)continue;await activityClaude(item,[],mark,clock());if(r.channel.isAutoUncertain(target,item.native) || !r.acceptsBackgroundWork())continue;}
          let activityBaseline:{cursor:string;oldIds:string[]}|undefined;
          if((provider==='codex' || provider==='agy') && oldCandidates.has(payloadDigest(item.native))){if(r.channel.isAutoUncertain(target,item.native))continue;const mark=watermarkFor(item);if(mark===null)continue;const prior=await r.core.getSnapshot(session.sessionId);const base=bases.find(p=>p.provider===provider)!;const evidence=provider==='codex' ? await readCodexActivity(base,item.native,mark,clock()) : await readAgyActivity(base,item.native,mark,clock());if(evidence.status==='future'){r.channel.markAutoUncertain(target,item.native);continue;}if(evidence.status!=='proven'||!evidence.snapshot||!evidence.oldMessageIds||!evidence.newMessageIds||!evidence.oldTurns||!r.acceptsBackgroundWork())continue;const raw=evidence.snapshot;if(payloadDigest(raw.session.native)!==payloadDigest(item.native)||!trusted(raw.session)||!pin(raw.session))throw new Error('invalid native session');const ids=new Set(raw.messages.map(m=>m.messageId));if(prior.value.messages.some(m=>!ids.has(m.messageId)))continue;if(r.channel.bindingsForRestore().some(b=>b.sessionId===session!.sessionId))continue;const current=r.store.getSession(session.sessionId);if(current.status!=='read_only'||current.control.input==='available')continue;if(!showAutoTitles)r.channel.markAutoPrivateTitle(item.native);const refreshedSession=showAutoTitles?raw.session:{...raw.session,title:`${providerTitlePrefix(provider)} 会话 · ${payloadDigest(item.native).slice(0,8)}`};if(!await r.core.refreshReadOnlySession(session.sessionId,{...raw,session:refreshedSession}))continue;if(!r.acceptsBackgroundWork()||r.channel.bindingsForRestore().some(b=>b.sessionId===session!.sessionId))continue;const after=await r.core.getSnapshot(session.sessionId);if(!r.acceptsBackgroundWork()||r.channel.bindingsForRestore().some(b=>b.sessionId===session!.sessionId))continue;const safeCurrent=r.store.getSession(session.sessionId);if(safeCurrent.status!=='read_only'||safeCurrent.control.input==='available')continue;r.store.baselineReadonlyTurns(session.sessionId,evidence.oldTurns.map(t=>({...t,sessionId:session!.sessionId})));const preexisting=new Set(prior.value.messages.map(m=>m.messageId)),newIds=new Set(evidence.newMessageIds);for(const m of after.value.messages)if(preexisting.has(m.messageId)&&newIds.has(m.messageId))r.store.putMessage({...m,revision:m.revision+1},m.revision);activityBaseline={cursor:prior.cursor,oldIds:evidence.oldMessageIds};}
          if(provider==='claude' && oldCandidates.has(payloadDigest(item.native))){const raw=await readOldClaude(bases.find(p=>p.provider==='claude')!,item.native);if(!r.acceptsBackgroundWork())continue;if(payloadDigest(raw.session.native)!==payloadDigest(item.native) || !trusted(raw.session) || !pin(raw.session))throw new Error('invalid native session');const refreshedSession=showAutoTitles?raw.session:{...raw.session,title:`Claude 会话 · ${payloadDigest(item.native).slice(0,8)}`};if(!await r.core.refreshReadOnlySession(session.sessionId,{...raw,session:refreshedSession}))continue;} else if(!activityBaseline && !await r.core.refreshReadOnlySession(session.sessionId)) continue;
          if(!r.acceptsBackgroundWork()) continue;
          const now=clock();let oldMessageIds:string[]|undefined;if(provider==='claude' && oldCandidates.has(payloadDigest(item.native))){if(r.channel.isAutoUncertain(target,item.native))continue;const mark=watermarkFor(item);if(mark===null)continue;const snapshot=await r.core.getSnapshot(session.sessionId);const boundary=await activityClaude(item,snapshot.value.messages,mark,now);if(!boundary || !r.acceptsBackgroundWork())continue;const index=snapshot.value.messages.findIndex(m=>m.messageId===boundary);if(index<0)continue;oldMessageIds=snapshot.value.messages.slice(0,index).map(m=>m.messageId);if(r.channel.bindingsForRestore().some(b=>b.sessionId===session!.sessionId))continue;const current=r.store.getSession(session.sessionId);if(current.status!=='read_only'||current.control.input==='available')continue;if(!showAutoTitles){r.channel.markAutoPrivateTitle(item.native);const title=`Claude 会话 · ${payloadDigest(item.native).slice(0,8)}`;if(current.title!==title)r.store.updateSession({...current,title,revision:current.revision+1},current.revision,current.control.generation);}}
          if(r.channel.bindingsForRestore().some(b=>b.sessionId===session!.sessionId))continue;const provenNew=(provider==='claude'||provider==='agy'||localCodexClock) && autoWatermark!==null && Number.isSafeInteger(created) && (watermarkFor(item)!==null && created>watermarkFor(item)!) && created<=now && !r.channel.isAutoUncertain(target,item.native); await r.channel.prepareAutoBaseline(eventId,session.sessionId,provenNew,activityBaseline?.oldIds ?? oldMessageIds,activityBaseline?.cursor);
          if(!r.acceptsBackgroundWork()) continue;
          await r.channel.handle({eventId,destination:target,identity:{source:'feishu',subject:config.ownerOpenId}},{action:'bind',sessionId:session.sessionId,mode:'read_only'});await r.channel.applyAutoBaseline(eventId);
          autoTimeoutStreaks.delete(`candidate:${provider}`);
          } catch(err) {if(!isMissingReadonlySessionError(item,err)) handleAutoFailure(`candidate:${provider}`,err);}
        }
        } catch(err) {handleAutoFailure(`provider:${provider}`,err);}}
        if (config.autoMirror.backfillNativeIds?.length) {
          for (const entry of config.autoMirror.backfillNativeIds) {
            const key = `${entry.provider}:${entry.nativeSessionId}`;
            if (backfillDone.has(key)) continue;
            if (r.isProviderUnavailable(entry.provider)) continue;
            const serviceId =
              entry.provider === 'codex' ? config.codexServiceId :
              entry.provider === 'claude' ? config.claudeServiceId :
              config.agy?.serviceId;
            if (!serviceId) { backfillDone.add(key); continue; }
            const native: Session['native'] = { provider: entry.provider, hostId: config.hostId, serviceId, nativeSessionId: entry.nativeSessionId };
            const sessionId = `session_${payloadDigest(native)}`;
            if (r.channel.bindingsForRestore().some(b => b.sessionId === sessionId)) {
              if (entry.replayHistory) {
                try {
                  const replayed = await r.channel.replayReadonlyHistoryOnce(sessionId);
                  backfillDone.add(key);
                  if (replayed) break;
                } catch (err) {
                  handleAutoFailure(`backfill-replay:${entry.provider}`, err);
                  break;
                }
              } else {
                backfillDone.add(key);
              }
              continue;
            }
            if (r.store.isDetached(sessionId)) { backfillDone.add(key); continue; }
            const base = bases.find(p => p.provider === entry.provider);
            if (!base) continue;
            try {
              if (!(authorized?.(target) ?? config.allowedDestinations.includes(target)) || !r.acceptsBackgroundWork()) break;
              const raw = await base.read(native);
              if (payloadDigest(raw.session.native) !== payloadDigest(native) || !namespace(raw.session.native, entry.provider) || !trusted(raw.session) || !pin(raw.session)) {
                backfillDone.add(key);
                continue;
              }
              configure(raw.session);
              discovered.add(sessionId);
              let session = r.store.findSession(native);
              if (!session) {
                const capabilities = Object.fromEntries(Object.entries(raw.session.capabilities).map(([name, value]) => [name, name === 'view' ? value : { status: 'unsupported', reason: 'discovered session is read-only until attached' }])) as Session['capabilities'];
                const candidate: Session = { ...raw.session, sessionId, status: 'read_only', capabilities, control: { ...raw.session.control, owner: null, input: 'unavailable', reason: 'discovered session is not attached' } };
                try { r.store.insertSession(candidate); session = candidate; } catch (error) { session = r.store.findSession(native); if (!session) throw error; }
              }
              if (r.store.isDetached(session.sessionId) || !trusted(session)) { backfillDone.add(key); continue; }
              if (r.channel.bindingsForRestore().some(b => b.sessionId === session!.sessionId)) { backfillDone.add(key); continue; }
              const eventId = `auto-mirror:${payloadDigest([target, native])}`;
              await r.channel.applyAutoBaseline(eventId);
              if (r.channel.bindingsForRestore().some(b => b.sessionId === session!.sessionId)) { backfillDone.add(key); continue; }
              if (!await r.core.refreshReadOnlySession(session.sessionId, raw)) continue;
              if (!r.acceptsBackgroundWork() || r.channel.bindingsForRestore().some(b => b.sessionId === session!.sessionId)) continue;
              // Silent baseline (provenNew=false): history is readable via /history, zero replay of old messages, future increments deliver normally.
              await r.channel.prepareAutoBaseline(eventId, session.sessionId, entry.replayHistory === true);
              if (!r.acceptsBackgroundWork()) break;
              await r.channel.handle({ eventId, destination: target, identity: { source: 'feishu', subject: config.ownerOpenId } }, { action: 'bind', sessionId: session.sessionId, mode: 'read_only' });
              await r.channel.applyAutoBaseline(eventId);
              backfillDone.add(key);
              // Bound at most 1 backfill topic per poll cycle to stay gentle on Feishu rate limits.
              break;
            } catch (err) {
              if (isMissingReadonlySessionError({ status: 'read_only', control: { input: 'unavailable' }, project: '/' } as unknown as Session, err)) {
                backfillDone.add(key);
              } else {
                handleAutoFailure(`backfill:${entry.provider}`, err);
              }
              break;
            }
          }
        }
        } catch {autoFailed=true;}
      }
      for(let i=0;i<buffered.length;) {const entry=buffered[i]!,o=entry.observation,existing=pinned.get(nativeRefKey(o.ref)); if(entry.expires<=Date.now()) {discard(i);enrichmentError=true;continue;} if(!existing || !r.store.findSession(o.ref)) {i++;continue;} discard(i); if(!trusted(existing) || (o.type==='session' && (payloadDigest(o.session.native)!==payloadDigest(o.ref) || !pin(o.session)))) {enrichmentError=true;continue;} entry.listener(o.type==='session' ? {...o,session:privateTitle(o.session)} : o);}
      // Native history reads may be expensive. Keep each polling cycle bounded so
      // an imported backlog cannot postpone new inbox work until all sessions refresh.
      const boundIds=new Set(r.channel.bindingsForRestore().map(binding=>binding.sessionId));
      if(r.taskChannel) for(const b of r.taskChannel.listActiveBindings()) for(const t of r.taskChannel.listTargets(b.taskId)) boundIds.add(t.sessionId);
      const candidates=r.store.listSessions().filter(s=>!r.store.isDetached(s.sessionId) && !isMissingReadonlyProject(s) && !(s.status==='read_only' && s.control.input!=='available' && r.isProviderUnavailable(s.native.provider)) && trusted(s) && (boundIds.has(s.sessionId) || s.control.input==='available'));
      const changedPriority: Session[] = [];
      if (agyBrainDir) {
        for (const s of candidates) {
          if (s.native.provider !== 'agy' || s.status !== 'read_only' || s.control.input === 'available') continue;
          const sig = agyTranscriptSignature(s.native.nativeSessionId);
          if (!sig) continue;
          const prev = lastTranscriptStat.get(s.sessionId);
          if (prev !== undefined && prev !== sig) {
            changedPriority.push(s);
            if (changedPriority.length >= 6) break;
          } else if (prev === undefined) {
            lastTranscriptStat.set(s.sessionId, sig);
          }
        }
      }
      const count=Math.min(2,candidates.length), start=candidates.length ? refreshOffset%candidates.length : 0; let refreshFailed=false;
      refreshOffset=candidates.length ? (start+count)%candidates.length : 0;
      const batch: Session[] = [...changedPriority];
      const seenBatch = new Set(batch.map(s => s.sessionId));
      for(let index=0;index<count;index++) {
        const s=candidates[(start+index)%candidates.length]!;
        if(!seenBatch.has(s.sessionId)) { batch.push(s); seenBatch.add(s.sessionId); }
      }
      for(const session of batch) {
        if(isMissingReadonlyProject(session)) continue;
        if(session.status==='read_only' && session.control.input!=='available' && r.isProviderUnavailable(session.native.provider)) continue;
        try {
        configure(session);
        const baselines=r.channel.bindingsForRestore().filter(binding=>binding.sessionId===session.sessionId && binding.accessMode==='read_only' && !r.channel.readonlyHydrated(binding.destination,session.sessionId));
        let refreshed = false;
        if(session.status==='read_only' && session.control.input!=='available') {
          if (r.isSessionPendingInteractiveRestore(session)) continue;
          try {
            refreshed = await r.core.refreshReadOnlySession(session.sessionId);
            refreshTimeoutStreaks.delete(session.sessionId);
            if (session.native.provider === 'agy') {
              const sig = agyTranscriptSignature(session.native.nativeSessionId);
              if (sig) lastTranscriptStat.set(session.sessionId, sig);
            }
          } catch(err) {
            if(isMissingReadonlySessionError(session,err)) {
              // Native session file no longer exists on disk; do not poison core health.
            } else if(isPendingContentionError(err)) {
              // Transient contention with another metadata scan; next tick will revisit.
            } else if(isMetadataTimeoutError(err)) {
              const next=(refreshTimeoutStreaks.get(session.sessionId) ?? 0)+1;
              refreshTimeoutStreaks.set(session.sessionId,next);
              if(next>=3) throw err;
            } else {
              throw err;
            }
          }
        }
        else if(baselines.length) refreshed = await r.core.hydrateSessionHistory(session.sessionId);
        else if(boundIds.has(session.sessionId) && session.control.input==='available' && session.status==='idle') {
          try {
            refreshed = await r.core.refreshIdleInteractiveSession(session.sessionId);
          } catch {
            // Best-effort read-only incremental catch-up for terminal turns.
          }
        }
        if(refreshed) {
          for(const binding of baselines) if(!r.channel.hasPendingAutoBaseline(binding.destination,session.sessionId)) await r.channel.baselineReadonlyHistory(binding.destination,session.sessionId);
          for(const binding of r.channel.bindingsForRestore()) if(binding.sessionId===session.sessionId) r.notifyChannelProgress(binding.destination);
        }
        { const snapshot=await r.core.getSnapshot(session.sessionId);
          const prevScanned = scannedAssistantMessages.get(session.sessionId) ?? 0;
          if (refreshed || snapshot.value.messages.length > prevScanned) {
            const slice = refreshed ? snapshot.value.messages.slice(Math.max(0, prevScanned - 2)) : snapshot.value.messages.slice(prevScanned);
            for(const m of slice) if(m.role==='assistant') for(const block of m.blocks) if(block.type==='text') for(const root of registry.getRoots(session.native)) for(const link of await localFileLinks(block.text.replace(/\]\(localfile:\/\/\//g,'](file:///'),session.project,root)) { try { await registry.register(nativeRefKey(session.native),link.path); } catch {} }
            scannedAssistantMessages.set(session.sessionId, snapshot.value.messages.length);
          }
        }
        } catch(err) { if(!isMissingReadonlySessionError(session,err)) refreshFailed=true; }
      }
      // Consume and reset on report so between-tick async errors are never dropped, while clean subsequent ticks can recover.
      const hadEnrichmentError=enrichmentError; enrichmentError=false;
      if(hadEnrichmentError || refreshFailed || autoFailed) throw new Error('session refresh or artifact observation failed');
    }});
  } catch(error) {stateLock.exec('ROLLBACK');stateLock.close();await Promise.all(ports.map(p=>p.close()));throw error;}
  activeRuntime=runtime;
  if (agyBrainDir) {
    fastAgyTimer = setInterval(() => {
      if (fastRefreshing || !runtime.acceptsBackgroundWork() || runtime.isProviderUnavailable('agy')) return;
      fastRefreshing = true;
      void (async () => {
        try {
          const bindings = runtime.channel.bindingsForRestore();
          const boundMap = new Map<string, string[]>();
          for (const b of bindings) {
            if (b.accessMode !== 'read_only') continue;
            const list = boundMap.get(b.sessionId) ?? [];
            list.push(b.destination);
            boundMap.set(b.sessionId, list);
          }
          for (const [sessionId, destinations] of boundMap) {
            if (!runtime.acceptsBackgroundWork()) break;
            let session: Session;
            try { session = runtime.store.getSession(sessionId); } catch { continue; }
            if (session.native.provider !== 'agy' || session.status !== 'read_only' || session.control.input === 'available') continue;
            if (runtime.store.isDetached(sessionId) || isMissingReadonlyProject(session) || !trusted(session)) continue;
            const sig = agyTranscriptSignature(session.native.nativeSessionId);
            if (!sig) continue;
            const prev = lastTranscriptStat.get(sessionId);
            if (prev === undefined) {
              lastTranscriptStat.set(sessionId, sig);
              continue;
            }
            if (prev === sig) continue;
            lastTranscriptStat.set(sessionId, sig);
            try {
              configure(session);
              const refreshed = await runtime.core.refreshReadOnlySession(sessionId);
              for (const dest of destinations) {
                if (refreshed && !runtime.channel.readonlyHydrated(dest, sessionId) && !runtime.channel.hasPendingAutoBaseline(dest, sessionId)) {
                  await runtime.channel.baselineReadonlyHistory(dest, sessionId);
                }
                runtime.notifyChannelProgress(dest);
              }
            } catch {
              // Best-effort fast lane; main poll loop handles retries and health reporting.
            }
          }
        } finally {
          fastRefreshing = false;
        }
      })();
    }, 1500);
    fastAgyTimer.unref?.();
  }
  const initProviders: readonly Provider[] = agyEnabled ? ['codex','claude','agy'] : ['codex','claude'];
  try {for(const provider of initProviders){const sourceKey=provider==='codex' ? payloadDigest([config.hostId,config.codexServiceId,config.codexEndpoint,sources.filter(s=>s.provider==='codex').map(s=>s.directory).sort()]) : provider==='claude' ? payloadDigest([config.hostId,config.claudeServiceId,sources.filter(s=>s.provider==='claude').map(s=>s.directory).sort()]) : payloadDigest([config.hostId,config.agy!.serviceId,config.agy!.summariesDbPath ?? null,config.agy!.brainDir ?? null,sources.filter(s=>s.provider==='agy').map(s=>s.directory).sort()]);scopeByProvider[provider]=runtime.channel.configureAutoScopeWatermarks(config.autoMirror?.enabled ? config.autoMirror.destination! : null,sourceKey,[...new Set(projects)].sort(),provider==='codex'?Math.floor(Date.now()/1000):Date.now(),provider);} await registry.load(); for(const s of runtime.store.listSessions()) { if(isMissingReadonlyProject(s)) continue; if(pin(s)) configure(s); } return runtime; } catch(error) {await runtime.close();throw error;}
}
/** Explicit opt-in factory. Construction opens isolated local state, never connects. */
export async function createLiveRuntime(config:RuntimeConfig, credentials:{appId:string;appSecret:string}, sdkDb:string) {
  validateRuntimeConfig(config);
  const agyEnabled = config.agy !== undefined && config.agy.enabled !== false;
  const distinctCheck = [config.coreDb,config.channelDb,config.artifactStatePath,...(agyEnabled && config.agy?.quotaCachePath ? [config.agy.quotaCachePath] : []),...(config.watchHub?.enabled ? [resolveWatchHubDbPath(config)] : []),...(config.pendingHub?.enabled ? [resolvePendingHubDbPath(config)] : []),...(config.decisionSync?.enabled ? [resolveDecisionSyncDbPath(config)] : []),...(config.usageHub?.enabled ? [resolveUsageHubDbPath(config)] : [])].filter((x):x is string=>!!x);
  if (!sdkDb || !isAbsolute(sdkDb) || distinctCheck.some(x=>canonicalPath(x)===canonicalPath(sdkDb))) throw new Error('distinct SDK database required');
  const approvalPolicy = runtimeApprovalScope(config);
  const transport=new CodexTransport(config.codexEndpoint);
  const claude=new ClaudeAdapter(config.hostId,config.claudeServiceId,config.claudeStateDir,undefined,undefined,{approvalPolicy});
  const codex=new CodexAdapter(transport,config.hostId,config.codexServiceId,{approvalPolicy,proveSharedFilesystem:codexFilesystemProof(config.codexEndpoint,config.approvalPolicy?.codexSharedFilesystem,config.catalogSources)});
  let agyCatalog:AgyCatalog|undefined, agyTransport:AgyAcpTransport|undefined, agyQuota:AgyQuotaClient|undefined, agyAdapter:AgyAdapter|undefined;
  if (agyEnabled) {
    agyCatalog = new AgyCatalog({
      ...(config.agy!.summariesDbPath !== undefined ? { dbPath: config.agy!.summariesDbPath } : {}),
      ...(config.agy!.brainDir !== undefined ? { brainDir: config.agy!.brainDir } : {}),
      ...(config.allowedProjectRoots !== undefined ? { allowedProjectRoots: config.allowedProjectRoots } : {}),
      ...(config.outputRoots !== undefined ? { outputRoots: config.outputRoots } : {}),
    });
    const agyTransportOptions = {
      ...(config.agy!.binPath !== undefined ? { agyBin: config.agy!.binPath } : {}),
      ...(config.agy!.geminiDir !== undefined ? { geminiDir: config.agy!.geminiDir } : {}),
      ...(config.agy!.appDataDir !== undefined ? { appDataDir: config.agy!.appDataDir } : {}),
      ...(config.agy!.sandbox !== undefined ? { sandbox: config.agy!.sandbox } : {}),
      ...(config.agy!.processPerSession !== undefined ? { processPerSession: config.agy!.processPerSession } : {}),
      ...(config.agy!.defaultMode !== undefined ? { defaultMode: config.agy!.defaultMode } : {}),
      ...(config.agy!.addDirs !== undefined ? { addDirs: config.agy!.addDirs } : {}),
      ...(config.agy!.extraArgs !== undefined ? { extraArgs: config.agy!.extraArgs } : {}),
    } as ConstructorParameters<typeof AgyAcpTransport>[0];
    agyTransport = new AgyAcpTransport(agyTransportOptions);
    agyQuota = new AgyQuotaClient({
      ...(config.agy!.binPath !== undefined ? { agyBin: config.agy!.binPath } : {}),
      ...(config.agy!.quotaCachePath !== undefined ? { cachePath: config.agy!.quotaCachePath } : {}),
    });
    const agyWriteRoots = [...new Set([...(approvalPolicy.writeRoots ?? []), ...(config.agy!.extraWriteRoots ?? [])])];
    const agyApprovalPolicy = {
      ...approvalPolicy,
      writeRoots: agyWriteRoots,
      readRoots: [...new Set([...(approvalPolicy.readRoots ?? []), ...agyWriteRoots])],
      ...(config.agy!.brainDir !== undefined ? { brainDir: config.agy!.brainDir } : {}),
    };
    agyAdapter = new AgyAdapter(agyTransport, agyCatalog, config.hostId, config.agy!.serviceId, agyQuota, { approvalPolicy: agyApprovalPolicy });
  }
  const taskTopicEnabled = config.taskTopic?.enabled === true;
  const usageDestinations = config.usageHub?.enabled ? new Set([config.usageHub.destination.trim()]) : new Set<string>();
  const port=new FeishuSdkPort(credentials,sdkDb,new Set(config.allowedDestinations),config.ownerOpenId,taskTopicEnabled,taskTopicEnabled,usageDestinations); let runtime:UnifiedRuntime;
  const bases:PlatformPort[] = agyAdapter ? [claude,codex,agyAdapter] : [claude,codex];
  try {runtime=await createIntegratedRuntime(config,port,bases);} catch(error) {port.close();transport.close();await agyTransport?.close().catch(()=>{});throw error;}
  const overlayConn = (row:Awaited<ReturnType<UnifiedCore['health']>>[number], h:ReturnType<CodexTransport['health']> | ReturnType<AgyAcpTransport['health']>) => ({
    ...row,
    status:row.reason==='健康诊断记录失败'?'degraded' as const:h.status==='healthy'?'healthy' as const:h.status==='unverified'?'unverified' as const:'degraded' as const,
    reason:row.reason==='健康诊断记录失败'?row.reason:h.status==='unverified'?'当前进程尚无连接观测':h.reason,
    backlog:h.backlog,
    updatedAt:row.lastObservedAt ?? null,
  });
  transport.onHealth=(status,reason)=>{try {runtime.channel.recordHealth('codex_connection',status,reason);} catch {}};
  if (agyTransport) agyTransport.onHealth=(status,reason)=>{try {runtime.channel.recordHealth('agy_connection',status,reason);} catch {}};
  const priorHealth=runtime.core.health.bind(runtime.core);
  runtime.core.health=async()=>{
    const h=transport.health();
    const ah=agyTransport?.health();
    return (await priorHealth()).map(row=>row.component==='codex_connection'?overlayConn(row,h):(ah && row.component==='agy_connection')?overlayConn(row,ah):row);
  };
  let testLane:TestLaneRuntime|undefined;try{if(config.testLane) testLane=new TestLaneRuntime(port,config.testLane.stateDir,config.ownerOpenId,config.intervalMs,[config.coreDb,config.channelDb,config.artifactStatePath!,sdkDb],config.testLane.nativeClaude===true,undefined,config.testLane.nativeTTLMinutes??30,config.testLane.nativeCodex===true);}catch(error){await runtime.close();port.close();transport.close();await agyTransport?.close().catch(()=>{});throw error;}
  const agyLifecycle = agyTransport ? {
    transport: agyTransport,
    ...(agyQuota ? { refreshQuota: async () => { try { const snapshot = await agyQuota.query(); const qh = agyQuota.health(); runtime.channel.recordHealth('agy_quota', qh.status, qh.reason); runtime.reportQuotaSnapshot('agy', snapshot); } catch {} } } : {}),
  } : undefined;
  return {...liveRuntimeLifecycle(runtime,transport,port,testLane,agyLifecycle),testLane};
}
/** Shutdown can race either network startup await; no continuation may start polling after close. */
export function liveRuntimeLifecycle<T extends Pick<UnifiedRuntime,'handleTrusted'|'captureResourceScope'|'startPolling'|'close'> & Partial<Pick<UnifiedRuntime,'restoreBindings'|'restoreProviderAfterReconnect'|'setProviderReady'|'recordProviderConnection'|'prepareForShutdown'>>>(runtime:T, transport:Pick<CodexTransport,'connect'|'close'> & Partial<Pick<CodexTransport,'onDisconnect'|'connected'>>, port:Pick<FeishuSdkPort,'start'|'stopReceiving'|'close'> & Partial<Pick<FeishuSdkPort,'drainTestCreates'>>, testLane?:Pick<TestLaneRuntime,'startPolling'|'startOperator'|'close'>, agy?:{transport:Pick<AgyAcpTransport,'connect'|'close'> & Partial<Pick<AgyAcpTransport,'onDisconnect'|'connected'>>;refreshQuota?:()=>Promise<void>}) {
  let closing=false, started=false, closePromise:Promise<void>|undefined, timer:ReturnType<typeof setTimeout>|undefined, connecting=false, attempt=0; const previousDisconnect=transport.onDisconnect;
  let agyTimer:ReturnType<typeof setTimeout>|undefined, agyConnecting=false, agyAttempt=0; const previousAgyDisconnect=agy?.transport.onDisconnect;
  const schedule=()=>{if(closing || timer || connecting) return;const delay=Math.min(30000,1000*2**Math.min(attempt,5));timer=setTimeout(()=>{timer=undefined;void connect();},delay);timer.unref?.();};
  const connect=async()=>{if(closing || connecting) return;connecting=true;try {await transport.connect();if(closing){transport.close();return;}if(transport.connected===false) throw new Error('connection closed');attempt=0;runtime.setProviderReady?.('codex',true);runtime.recordProviderConnection?.('codex',true);try {await runtime.restoreProviderAfterReconnect?.('codex');} catch {}} catch {if(!closing) {runtime.recordProviderConnection?.('codex',false);attempt=Math.min(attempt+1,5);}} finally {connecting=false;if(!closing && attempt>0) schedule();}};
  if('onDisconnect' in transport) transport.onDisconnect=(generation:number)=>{try {previousDisconnect?.(generation);} catch {} if(!closing){runtime.setProviderReady?.('codex',false);attempt=Math.max(attempt,1);schedule();}};
  const scheduleAgy=()=>{if(!agy || closing || agyTimer || agyConnecting) return;const delay=Math.min(30000,1000*2**Math.min(agyAttempt,5));agyTimer=setTimeout(()=>{agyTimer=undefined;void connectAgy();},delay);agyTimer.unref?.();};
  const connectAgy=async()=>{if(!agy || closing || agyConnecting) return;agyConnecting=true;try {await agy.transport.connect();if(closing){await agy.transport.close().catch(()=>{});return;}if(agy.transport.connected===false) throw new Error('connection closed');agyAttempt=0;runtime.setProviderReady?.('agy',true);runtime.recordProviderConnection?.('agy',true);try {await runtime.restoreProviderAfterReconnect?.('agy');} catch {} if(!closing) void agy.refreshQuota?.().catch(()=>{});} catch {if(!closing) {runtime.recordProviderConnection?.('agy',false);agyAttempt=Math.min(agyAttempt+1,5);}} finally {agyConnecting=false;if(!closing && agyAttempt>0) scheduleAgy();}};
  if(agy && 'onDisconnect' in agy.transport) agy.transport.onDisconnect=(generation:number,reason:string)=>{try {previousAgyDisconnect?.(generation,reason);} catch {} if(!closing){runtime.setProviderReady?.('agy',false);agyAttempt=Math.max(agyAttempt,1);scheduleAgy();}};
  const closeTransports=()=>Promise.allSettled([Promise.resolve().then(()=>transport.close()),...(agy?[agy.transport.close()]:[])]);
  return {runtime,async start(){if(closing || started) throw new Error('runtime closing or started');started=true;runtime.setProviderReady?.('codex',false);if(agy) runtime.setProviderReady?.('agy',false);try {await port.start((e,a)=>runtime.handleTrusted(e,a),e=>runtime.captureResourceScope(e));if(closing){port.stopReceiving();throw new Error('runtime closing');}runtime.startPolling();try {if(testLane){await testLane.startOperator();if(closing)throw new Error('closing');testLane.startPolling();}} catch {void testLane?.close();}if(closing)throw new Error('runtime closing');void connect();if(agy) void connectAgy();} catch(error) {await closeTransports();throw error;}},close(){if(closePromise)return closePromise;closing=true;runtime.prepareForShutdown?.();if(timer)clearTimeout(timer);if(agyTimer)clearTimeout(agyTimer);closePromise=Promise.resolve().then(async()=>{try {try {port.stopReceiving();} finally {await closeTransports();}} finally {try {const results=await Promise.allSettled([runtime.close(),testLane?.close()]);const failed=results.find((r):r is PromiseRejectedResult=>r.status==='rejected');if(failed)throw failed.reason;} finally {try {await port.drainTestCreates?.();await closeTransports();} finally {port.close();}}}});return closePromise;}};
}
