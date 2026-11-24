import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname, basename, join, relative, isAbsolute, sep } from 'node:path';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { HistoryArchive } from './history-archive.js';
import type { MigrationManifest } from './migration.js';
import { UnifiedStore } from './store.js';
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
import { AgyQuotaClient } from './agy-quota.js';
import { AgyAcpTransport } from './agy-transport.js';
import { providerTitlePrefix } from './feishu-cards.js';
import { DecisionSyncStore } from './decision-sync.js';
import { PendingHub, type PendingQuery, type PendingSubmitPayload } from './pending-hub.js';
import { TaskHandoffError, TaskHandoffService } from './task-handoff.js';
import { TaskTopicChannel, TaskChannelError, type TaskAuthorize, type TaskChannelAction } from './task-topic-channel.js';
import type { TaskTopicToken } from './task-topic-store.js';
import { handleTaskControlAction, isTaskControlAction } from './task-topic/control-plane.js';
import { WatchHub } from './watch-hub.js';
import { RuntimeInteractive } from './runtime-interactive.js';
import { runBackgroundWork } from './runtime-background.js';

export interface AgyRuntimeConfig { enabled?:boolean; serviceId:string; summariesDbPath?:string; brainDir?:string; binPath?:string; quotaCachePath?:string; sandbox?:boolean; geminiDir?:string; appDataDir?:string }
export interface WatchHubRuntimeConfig { enabled:boolean; destination:string; dbPath?:string }
export interface PendingHubRuntimeConfig { enabled:boolean; destination:string; dbPath?:string }
export interface DecisionSyncRuntimeConfig { enabled:boolean; dbPath?:string; markdownPath?:string; protectedReadOnlyPaths?:string[] }
export interface RuntimeConfig { coreDb:string; channelDb:string; ownerOpenId:string; allowedDestinations:string[]; hostId:string; claudeServiceId:string; codexServiceId:string; claudeStateDir:string; codexEndpoint:string; intervalMs:number; agy?:AgyRuntimeConfig; catalogSources?:CatalogRoot[]; allowedProjectRoots?:string[]; outputRoots?:string[]; approvalPolicy?:{enabled?:boolean;extraTrustedRoots?:string[];extraWriteRoots?:string[];codexSharedFilesystem?:boolean;homeDir?:string}; artifactStatePath?:string; historyArchive?:{root:string;manifestPath:string;manifestSha256:string}; autoMirror?:{enabled:boolean;destination?:string;showTitles?:boolean}; taskTopic?:{enabled:boolean}; watchHub?:WatchHubRuntimeConfig; pendingHub?:PendingHubRuntimeConfig; decisionSync?:DecisionSyncRuntimeConfig; testLane?:{stateDir:string;nativeClaude?:boolean;nativeCodex?:boolean;nativeTTLMinutes?:number} }
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
    };
/** Pure validation: never reads environment, opens a database, connects or sends. */
export function validateRuntimeConfig(c:RuntimeConfig):void {
  if (!c || ![c.coreDb,c.channelDb,c.ownerOpenId,c.hostId,c.claudeServiceId,c.codexServiceId,c.claudeStateDir,c.codexEndpoint].every(x=>typeof x==='string' && !!x.trim()) || !Array.isArray(c.allowedDestinations) || !c.allowedDestinations.length || !c.allowedDestinations.every(x=>typeof x==='string' && !!x.trim()) || c.coreDb===c.channelDb || c.channelDb===':memory:' || !Number.isSafeInteger(c.intervalMs) || c.intervalMs<100) throw new Error('invalid runtime configuration');
  if (c.agy !== undefined) {
    if (!c.agy || typeof c.agy !== 'object' || Array.isArray(c.agy) || typeof c.agy.serviceId !== 'string' || !c.agy.serviceId.trim()) throw new Error('invalid agy configuration');
    if (c.agy.enabled !== undefined && typeof c.agy.enabled !== 'boolean') throw new Error('invalid agy configuration');
    if (c.agy.sandbox !== undefined && typeof c.agy.sandbox !== 'boolean') throw new Error('invalid agy configuration');
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
  if (c.autoMirror && (typeof c.autoMirror.enabled!=='boolean' || (c.autoMirror.showTitles!==undefined && typeof c.autoMirror.showTitles!=='boolean') || (c.autoMirror.enabled && (!c.autoMirror.destination || !c.allowedDestinations.includes(c.autoMirror.destination))))) throw new Error('invalid auto mirror configuration');
  const url = new URL(c.codexEndpoint); if ((!['ws:','wss:'].includes(url.protocol) && c.codexEndpoint !== 'codex-proxy://default') || url.username || url.password) throw new Error('invalid Codex endpoint');
}
const resolveWatchHubDbPath=(config:RuntimeConfig):string => config.watchHub?.dbPath ?? join(dirname(resolve(config.channelDb)),'watch-hub.sqlite');
const resolvePendingHubDbPath=(config:RuntimeConfig):string => config.pendingHub?.dbPath ?? join(dirname(resolve(config.channelDb)),'pending-hub.sqlite');
const resolveDecisionSyncDbPath=(config:RuntimeConfig):string => config.decisionSync?.dbPath ?? join(dirname(resolve(config.channelDb)),'decision-sync.sqlite');

/** The caller must ensure inbound envelopes originate from authenticated transport. */
export class UnifiedRuntime {
  readonly store:UnifiedStore; readonly core:UnifiedCore; readonly channel:FeishuChannel;
  private readonly interactive:RuntimeInteractive;
  private _watchHub:WatchHub|undefined; private _pendingHub:PendingHub|undefined; private _decisionSync:DecisionSyncStore|undefined; private _taskChannel:TaskTopicChannel|undefined; private _taskHandoff:TaskHandoffService|undefined;
  get watchHub():WatchHub|undefined { return this._watchHub; }
  get pendingHub():PendingHub|undefined { return this._pendingHub; }
  get decisionSync():DecisionSyncStore|undefined { return this._decisionSync; }
  get taskChannel():TaskTopicChannel|undefined { return this._taskChannel; }
  get taskHandoff():TaskHandoffService|undefined { return this._taskHandoff; }
  private baselinePreparing=false; private readonly recoveryFailedSessions=new Set<string>(); private readonly unavailableProviders=new Set<Provider>(); private readonly restartPending:string[]; private recoveryFailure:string|null=null; private recoveryStarted:Promise<void>|undefined; private timer:ReturnType<typeof setTimeout>|undefined; private polling=false; private inPollCycle=false; private wakePending=false; private wakeScheduled=false; private lastActivityAt=Date.now(); private readonly pollRunner=()=>void this.runPollCycle(); private running:Promise<void>|undefined; private lastError:string|null=null; private closed=false; private closing=false; private closePromise:Promise<void>|undefined; private readonly intakes=new Set<Promise<unknown>>(); private readonly hubTasks=new Set<Promise<unknown>>(); private readonly lock:DatabaseSync; private readonly providers:PlatformPort[]; private readonly sendPort:Pick<FeishuPort,'send'>; private readonly port:FeishuPort & {authorizedDestination?:(destination:string)=>boolean;lookupTaskTopic?:(destination:string,owner:string)=>unknown;createTaskTopic?:(chatId:string,taskId:string,operationId:string,owner:string)=>Promise<TaskTopicToken>;drainInbound?:(handle:(e:TrustedEnvelope,a:ChannelAction,scope?:string)=>Promise<unknown>)=>Promise<void>;resourceIssues?:()=>Array<{eventId:string;state:string;attempts:number;reason:string}>};
  constructor(readonly config:RuntimeConfig, port:FeishuPort, providers:PlatformPort[], private readonly options:{canDiscover?:(s:Session)=>boolean;allowDiscovered?:(id:string)=>boolean;canInspectCandidate?:(native:Session['native'],project:string)=>boolean;requireReadonlyHydration?:boolean;allowedProjectRoots?:readonly string[];refresh?:(runtime:UnifiedRuntime)=>Promise<void>;cleanup?:()=>void}={}) {
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
      this.restartPending=this.store.pendingOutbox();
      try { this.core = new UnifiedCore(this.store,providers,(identity,session)=>owner(identity) && (!options.canDiscover || options.canDiscover(session)),(identity)=>owner(identity),()=>false,options.canDiscover,archive,options.canInspectCandidate);
        const defaultCreateProject = options.allowedProjectRoots?.[0] ?? config.allowedProjectRoots?.[0];
        const measuredPort=new Proxy(port,{get:(target,key)=>{const value=Reflect.get(target,key); if(typeof value!=='function') return value; if(['send','update','sendFile'].includes(String(key))) return async (...args:unknown[])=>{let guardFailed=false;const last=args.length-1; if(typeof args[last]==='function') {const guard=args[last] as ()=>Promise<void>;args[last]=async()=>{try {await guard();} catch(error) {guardFailed=true;throw error;}};} try {const result=await Reflect.apply(value,target,args); try {this.channel.recordHealth('feishu_delivery',(key==='send' && !result)?'unverified':'healthy',(key==='send' && !result)?'消息回执未确认':null);} catch {} return result;} catch(error) {const e=error && typeof error==='object' ? error as {deliveryKind?:unknown;platformCode?:unknown} : {}; const rejected=e.deliveryKind==='api_rejected' && typeof e.platformCode==='number' && Number.isSafeInteger(e.platformCode); const reason=guardFailed?'发送前权限或绑定变化':rejected?`平台拒绝（代码 ${e.platformCode}）`:'投递结果未知'; const deliveryId=args[key==='send'?2:3];try {if(typeof deliveryId==='string') this.channel.recordDeliveryDiagnostic(deliveryId,guardFailed?'guard_rejected':rejected?'api_rejected':'unknown',rejected?e.platformCode as number:null);} catch {} try {this.channel.recordHealth('feishu_delivery','degraded',reason);} catch {} throw error;}}; return value.bind(target);}}); this.sendPort=measuredPort; try { this.channel = new FeishuChannel(this.core,measuredPort,async (identity,destination,sessionId)=>{ if(!owner(identity) || !(this.port.authorizedDestination?.(destination) ?? destinations.has(destination))) return false; if(!sessionId || !options.canDiscover) return true; try {return options.canDiscover(this.store.getSession(sessionId));} catch {return options.allowDiscovered?.(sessionId) ?? false;} },config.channelDb,undefined,options.requireReadonlyHydration === true,{
          ...(defaultCreateProject ? { defaultCreateProject } : {}),
          onInteractionChanged: (sessionId, interactionId) => this.interactive.notifyInteraction(sessionId, interactionId),
        }); } catch(error) { this.core.close(); throw error; }
        this.core.validateSteerScope=(scope,sessionId)=>owner({source:scope.ownerSource,subject:scope.ownerSubject}) && (this.port.authorizedDestination?.(scope.destination) ?? destinations.has(scope.destination)) && this.channel.isCurrentSteerScope(scope,sessionId);
        const showAutoTitles = config.autoMirror?.showTitles === true;
        this.core.presentSession=session=>(!showAutoTitles && this.channel.isAutoPrivateTitle(session.native)) ? {...session,title:`${providerTitlePrefix(session.native.provider)} 会话 · ${payloadDigest(session.native).slice(0,8)}`} : session;
        try {
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
        } catch (error) {
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
    this.core.onAcceptedObservation=o=>{if(this.closing || this.closed)return;this.lastActivityAt=Date.now();const record=(component:string,status:'healthy'|'degraded'|'unverified',reason:string|null=null)=>{try {this.channel.recordHealth(component,status,reason);} catch {}}; const provider=o.ref.provider; if((provider==='claude' || provider==='agy') && o.type==='message' && o.message.role==='assistant') record(`${provider}_connection`,'healthy'); if(o.type==='turn' && ['completed','failed','interrupted'].includes(o.turn.status)) record(`${provider}_run`,o.turn.status==='completed'?'healthy':o.turn.status==='failed'?'degraded':'unverified',o.turn.status==='completed'?null:o.turn.status==='failed'?'运行失败':'本轮中断，结果未确认'); if(o.type==='event' && provider==='claude') {if(o.event.type==='provider.api_retry'){try {const session=this.store.findSession(o.ref);const turn=session && this.store.listTurns(session.sessionId).find(t=>t.turnId===o.event.objectId);if(!turn || !['completed','failed','interrupted'].includes(turn.status)){const d=o.event.data && typeof o.event.data==='object' ? o.event.data as {httpStatus?:unknown}:{};const code=typeof d.httpStatus==='number' && Number.isSafeInteger(d.httpStatus) && d.httpStatus>=100 && d.httpStatus<=599 ? d.httpStatus:null;this.channel.recordRetryHealth(code===null?'模型请求正在重试':`模型请求正在重试（HTTP ${code}）`,o.event.receivedAt);}} catch {}}if(o.event.type==='adapter.stream_failed'){record('claude_run','degraded','SDK流中断');record('claude_connection','degraded','SDK流中断');} if(o.event.type==='provider.usage_limit')record('claude_quota','degraded','服务报告额度限制'); if(o.event.type==='provider.usage_available')record('claude_quota','healthy');} if(o.type==='event' && provider==='agy') {if(o.event.type==='adapter.stream_failed'){record('agy_run','degraded','ACP流中断');record('agy_connection','degraded','ACP流中断');} if(o.event.type==='provider.usage_limit')record('agy_quota','degraded','服务报告额度限制'); if(o.event.type==='provider.usage_available')record('agy_quota','healthy');} if(o.type==='interaction') {const i=o.interaction;if(i.status==='answer_pending_delivery') record('interaction_return','unverified','答复已提交，原生结果待确认');else if(i.status==='resolved') record('interaction_return',i.nativeResult?.status==='accepted'?'healthy':'unverified',i.nativeResult?.status==='accepted'?null:'原生结果未确认');} this.notifyObservation(o);};

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
        const binding=this._taskChannel?.getBindingByDestination(envelope.destination);
        if(this._taskChannel && (!binding || binding.taskId!==action.taskId)) {
          throw new TaskHandoffError('stale_revision','task binding mismatch');
        }
        const draft=this._taskHandoff.getHandoff(action.handoffId);
        if(draft && draft.taskId!==action.taskId) {
          throw new TaskHandoffError('stale_revision','handoff task mismatch');
        }
        if(draft && draft.activeRevision!==action.activeRevision) {
          throw new TaskHandoffError('stale_revision','active revision mismatch');
        }
        return this._taskHandoff.confirmHandoff(
          action.handoffId,
          action.previewDigest,
          action.targetGeneration,
          envelope.identity,
          envelope.eventId,
        );
      }
      if(this._pendingHub) {
        const hubRoot=this._pendingHub.getRoot();
        const hubBindingId=createHash('sha256').update('pending-hub:singleton').digest('hex').slice(0,16);
        const inHubTopic=!!hubRoot?.topicDestination && hubRoot.topicDestination!==hubRoot.chatDestination && envelope.destination===hubRoot.topicDestination;
        const meta=action as {entry?:unknown;bindingId?:unknown;sourceSessionId?:unknown};
        const entry=meta.entry==='source' ? 'source' : (meta.entry==='hub' || meta.entry==='pending_hub') ? 'hub' : undefined;
        if(action.action==='decision_answer') {
          const payload:PendingSubmitPayload={
            kind:'decision',
            decisionId:action.decisionId,
            expectedVersion:action.expectedVersion,
            expectedDigest:action.expectedDigest,
            ...(action.selectedOptionId!==undefined ? {selectedOptionId:action.selectedOptionId} : {}),
            ...(action.freeText!==undefined ? {freeText:action.freeText} : {}),
            ...(action.rawUtterance!==undefined ? {rawUtterance:action.rawUtterance} : {}),
            ...(envelope.cardMessageId ? {cardMessageId:envelope.cardMessageId} : {}),
          };
          return this._pendingHub.submitAnswer(entry==='source' ? 'source' : 'hub',envelope,payload,{
            notifyOperation: id => this.interactive.notifyOperation(id),
            notifyInteraction: (sessionId,id) => this.interactive.notifyInteraction(sessionId,id),
            notifyDecision: id => this.interactive.notifyDecision(id),
            notifySummary: () => this.wake(),
          });
        }
        if((action.action==='answer' || action.action==='answer_form') && (entry!==undefined || meta.bindingId===hubBindingId || inHubTopic)) {
          const sourceSessionId=typeof meta.sourceSessionId==='string' && meta.sourceSessionId.trim()
            ? meta.sourceSessionId
            : (await this.core.getInteraction(action.interactionId)).sessionId;
          const payload:PendingSubmitPayload=action.action==='answer_form'
            ? {
                kind:'question_form',
                sourceSessionId,
                interactionId:action.interactionId,
                revision:action.revision,
                connectionGeneration:action.connectionGeneration,
                bindingId:typeof meta.bindingId==='string' ? meta.bindingId : '',
                fields:action.fields,
                ...(envelope.cardMessageId ? {cardMessageId:envelope.cardMessageId} : {}),
              }
            : {
                kind:'interaction',
                sourceSessionId,
                interactionId:action.interactionId,
                revision:action.revision,
                connectionGeneration:action.connectionGeneration,
                answer:action.answer,
                toolInputDigest:action.toolInputDigest,
                ...(envelope.cardMessageId ? {cardMessageId:envelope.cardMessageId} : {}),
              };
          return this._pendingHub.submitAnswer(entry==='source' ? 'source' : 'hub',envelope,payload,{
            notifyOperation: id => this.interactive.notifyOperation(id),
            notifyInteraction: (sessionId,id) => this.interactive.notifyInteraction(sessionId,id),
            notifySummary: () => this.wake(),
          });
        }
        if(action.action==='pending_page' && (inHubTopic || envelope.destination===this.config.pendingHub!.destination)) {
          return this._pendingHub.renderPage(envelope,{
            ...(action.cursor!==undefined ? {cursor:action.cursor} : {}),
            ...(action.category!==undefined ? {category:action.category} : {}),
            ...(action.provider!==undefined ? {provider:action.provider} : {}),
          });
        }
      }
      if(this._taskChannel && this._taskChannel.getBindingByDestination(envelope.destination)) {
        if(action.action==='legacy_model') {
          if(!action.model && !action.invalid) return this.intakeTopic(envelope,{action:'models'});
          throw new TaskChannelError('invalid_request','use /models to switch target model');
        }
        return this.intakeTopic(envelope,action as TaskChannelAction);
      }
      if(this._pendingHub) {
        const hubRoot=this._pendingHub.getRoot();
        const inHubTopic=!!hubRoot?.topicDestination && hubRoot.topicDestination!==hubRoot.chatDestination && envelope.destination===hubRoot.topicDestination;
        if(inHubTopic && action.action==='input') {
          return this._pendingHub.handleHubText(envelope,action.text);
        }
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

  recordProviderConnection(provider:Provider,ready:boolean):void {try {this.channel.recordHealth(`${provider}_connection`,ready?'healthy':'degraded',ready?null:'连接不可用');} catch {}}
  setProviderReady(provider:Provider,ready:boolean):void {if(ready)this.unavailableProviders.delete(provider);else this.unavailableProviders.add(provider);this.core.setProviderAvailable(provider,ready);}
  isProviderUnavailable(provider:Provider):boolean { return this.unavailableProviders.has(provider); }
  /** Explicit startup only; no input or new model turn is started by restoration. */
  restoreBindings():Promise<void> {
    if(this.baselinePreparing) return Promise.reject(new Error('baseline preparation active')); if(this.recoveryStarted) return this.recoveryStarted;
    this.recoveryStarted=(async()=>{
      this.store.failUnreboundPending(this.restartPending);
      const restored=new Set<string>();
      for(const binding of this.channel.bindingsForRestore()) {
        if(this.closed || this.closing) return;
        if(binding.accessMode!=='interactive' || restored.has(binding.sessionId) || !this.store.hasInteractiveIntent(binding.sessionId)) continue;
        if(this.unavailableProviders.has(this.store.getSession(binding.sessionId).native.provider)) {this.recoveryFailedSessions.add(binding.sessionId);continue;}
        if(!await this.channel.isRestoreBindingAuthorized(binding) || this.closed || this.closing) continue;
        restored.add(binding.sessionId);
        try { await this.core.restoreInteractive(binding.sessionId,binding.owner,async()=>{if(this.closed || this.closing)return false;for(const current of this.channel.bindingsForRestore()) if(current.sessionId===binding.sessionId && current.owner.source===binding.owner.source && current.owner.subject===binding.owner.subject && await this.channel.isRestoreBindingAuthorized(current)) return true; return false;}); }
        catch { this.recoveryFailedSessions.add(binding.sessionId); this.recoveryFailure='one or more sessions could not be restored; inspect before retry'; }
      }
    })().catch(()=>{this.recoveryFailure='binding recovery failed; inspect before retry';});
    return this.recoveryStarted;
  }
  /** Retry only persisted interactive intent for the provider that just reconnected. */
  async restoreProviderAfterReconnect(provider:Provider):Promise<void> { if(this.closed || this.closing) return; let failed=false;const seen=new Set<string>();for(const binding of this.channel.bindingsForRestore()) {if(this.closed || this.closing) return;if(binding.accessMode!=='interactive' || seen.has(binding.sessionId) || !this.recoveryFailedSessions.has(binding.sessionId) || !this.store.hasInteractiveIntent(binding.sessionId)) continue;const session=this.store.getSession(binding.sessionId);if(session.native.provider!==provider || !await this.channel.isRestoreBindingAuthorized(binding)) continue;seen.add(binding.sessionId);try {await this.core.restoreInteractive(binding.sessionId,binding.owner,async()=>{if(this.closed || this.closing)return false;for(const current of this.channel.bindingsForRestore()) if(current.sessionId===binding.sessionId && current.owner.source===binding.owner.source && current.owner.subject===binding.owner.subject && await this.channel.isRestoreBindingAuthorized(current)) return true;return false;});this.recoveryFailedSessions.delete(binding.sessionId);} catch {failed=true;}} if(failed) this.recoveryFailure='one or more sessions could not be restored; inspect before retry';else if(this.recoveryFailedSessions.size===0 && this.recoveryFailure==='one or more sessions could not be restored; inspect before retry') this.recoveryFailure=null; }
  private hasPendingOrActiveWork():boolean {
    if(this.channel.pendingInbox().length>0) return true;
    if((this._taskChannel?.pendingInbox().length ?? 0)>0) return true;
    if(this.store.pendingOutbox().length>0) return true;
    if(this.store.listSessions().some(s=>s.status==='running' || s.status==='waiting_question' || s.status==='waiting_approval')) return true;
    if(this._watchHub?.listOutbox().some(r=>r.state==='pending')) return true;
    if(this._decisionSync?.listDocOutbox().some(r=>r.state==='pending_sync')) return true;
    return false;
  }
  nextPollDelayMs(now=Date.now()):number {
    if(this.config.intervalMs<1000) return this.config.intervalMs;
    const idleMs=Math.max(0,now-this.lastActivityAt);
    if(idleMs<=120_000 || this.hasPendingOrActiveWork()) return Math.min(1000,this.config.intervalMs);
    if(idleMs<=600_000) return this.config.intervalMs;
    return Math.min(15000,this.config.intervalMs*3);
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
    void this.runPollCycle();
  }
  health():{status:'healthy'|'degraded';reason:string|null;unknownDeliveries:number;unknownInbox:number;resourceIssues:Array<{eventId:string;state:string;attempts:number;reason:string}>} { const unknownDeliveries=this.channel.pendingDeliveries().length; const unknownInbox=this.channel.unknownInbox().length; const resourceIssues=this.port.resourceIssues?.() ?? []; return {status:this.lastError || this.recoveryFailure || this.store.recoveryQuarantineCount() || unknownDeliveries || unknownInbox || resourceIssues.length ? 'degraded':'healthy',reason:this.lastError ?? this.recoveryFailure ?? (this.store.recoveryQuarantineCount() ? 'reconnect and explicitly attach quarantined sessions' : null),unknownDeliveries,unknownInbox,resourceIssues}; }
  close():Promise<void> {
    if(this.closePromise) return this.closePromise;
    this.closing=true; this.polling=false; this.wakePending=false; this.wakeScheduled=false;
    if(this.timer) { clearTimeout(this.timer); this.timer=undefined; }
    const running=this.running; const intakes=[...this.intakes]; const hubTasks=[...this.hubTasks];
    this.closePromise=(async()=>{ await Promise.allSettled(intakes); await running?.catch(()=>{}); await this.interactive.close().catch(()=>{}); await Promise.allSettled(hubTasks); try { await Promise.all(this.providers.map(p=>p.close?.())); } finally { try { try { this._taskHandoff?.close(); } catch {} try { this._taskChannel?.close(); } catch {} try { this._pendingHub?.close(); } catch {} try { this._watchHub?.close(); } catch {} try { this._decisionSync?.close(); } catch {} this.core.close(); this.channel.close(); this.store.close(); } finally { this.lock.exec('ROLLBACK'); this.lock.close(); this.options.cleanup?.(); this.closed=true; } } })();
    return this.closePromise;
  }
}
const canonicalPath=(path:string):string => { const p=resolve(path); return existsSync(p) ? realpathSync(p) : join(realpathSync(dirname(p)),basename(p)); };
const inside=(child:string,root:string):boolean => {const rel=relative(root,child);return rel==='' || (!isAbsolute(rel) && rel!=='..' && !rel.startsWith(`..${sep}`));};
/** Construct enrichment under a separate state lock; no network connections are opened. */
export async function createIntegratedRuntime(config:RuntimeConfig, port:FeishuPort, bases:PlatformPort[]):Promise<UnifiedRuntime> {
  validateRuntimeConfig(config);
  if (!config.artifactStatePath || !config.catalogSources || !config.allowedProjectRoots || !config.outputRoots) throw new Error('explicit catalog, root and artifact state configuration required');
  const agyEnabled = config.agy !== undefined && config.agy.enabled !== false;
  const persistent=[config.coreDb,config.channelDb,config.artifactStatePath,...(agyEnabled && config.agy?.quotaCachePath ? [config.agy.quotaCachePath] : []),...(config.watchHub?.enabled ? [resolveWatchHubDbPath(config)] : []),...(config.pendingHub?.enabled ? [resolvePendingHubDbPath(config)] : []),...(config.decisionSync?.enabled ? [resolveDecisionSyncDbPath(config)] : [])].map(canonicalPath); if (new Set(persistent).size !== persistent.length) throw new Error('runtime state paths must be distinct');
  const projects=config.allowedProjectRoots.map(x=>realpathSync(x)), outputs=config.outputRoots.map(x=>realpathSync(x));
  const sources=config.catalogSources.map(s=>({...s,directory:realpathSync(s.directory)}));
  const serviceIdFor=(provider:Provider):string|undefined=>provider==='claude'?config.claudeServiceId:provider==='codex'?config.codexServiceId:agyEnabled?config.agy!.serviceId:undefined;
  const sourceAllowed=(s:Session)=>s.native.hostId===config.hostId && s.native.serviceId===serviceIdFor(s.native.provider) && (s.native.provider==='agy' ? agyEnabled : sources.some(x=>x.provider===s.native.provider && x.hostId===s.native.hostId && x.serviceId===s.native.serviceId));
  const trusted=(s:Session):boolean=>{try {return sourceAllowed(s) && isAbsolute(s.project) && projects.some(root=>inside(realpathSync(s.project),root));}catch{return false;}};
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
      const ack=await super.create(cwd,model); const s=ack.createdSession;
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
  let runtime:UnifiedRuntime; let refreshOffset=0; let autoCursor:string|null=null; let agyAutoCursor:string|null=null; const recentCursors:Record<Provider,string|null>={codex:null,claude:null,agy:null}; const scopeByProvider:Record<Provider,Array<{root:string;watermark:number}>>={codex:[],claude:[],agy:[]}; const localCodexClock=isLocalCodexEndpoint(config.codexEndpoint);
  try { runtime=new UnifiedRuntime(config,port,ports,{canDiscover:trusted,canInspectCandidate:(native,project)=>{try{return native.provider==='codex'&&native.hostId===config.hostId&&native.serviceId===config.codexServiceId&&sources.some(x=>x.provider==='codex'&&x.hostId===native.hostId&&x.serviceId===native.serviceId)&&isAbsolute(project)&&projects.some(root=>inside(realpathSync(project),root))}catch{return false}},allowDiscovered:id=>discovered.has(id),requireReadonlyHydration:true,allowedProjectRoots:config.allowedProjectRoots,cleanup:()=>{stateLock.exec('ROLLBACK');stateLock.close();},refresh:async r=>{
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
        const oldCandidates=new Set<string>(),activePrivateCandidates=new Set<string>();const candidates:Session[]=[]; if(provider==='codex' && localCodexClock && autoWatermark!==null && bases.find(p=>p.provider==='codex')?.discoverExisting) try {const base=bases.find(p=>p.provider==='codex')!;const page=await listOldCodex(base,oldCodexCursor);autoTimeoutStreaks.delete('codex:old');if(page.nextCursor!==null){if(seenCodexCursors.has(page.nextCursor))throw new Error('cursor cycle');if(seenCodexCursors.size>=10000)seenCodexCursors.delete(seenCodexCursors.values().next().value!);seenCodexCursors.add(page.nextCursor);}else seenCodexCursors.clear();oldCodexCursor=page.nextCursor;if(page.partialFailure)autoFailed=true;for(const item of page.items){if(!namespace(item.native,'codex')||!trusted(item)||!pin(item))continue;configure(item);discovered.add(`session_${payloadDigest(item.native)}`);const created=time(item.createdAt),mark=watermarkFor(item);if(mark!==null && Number.isSafeInteger(created) && created<=mark){oldCandidates.add(payloadDigest(item.native));candidates.push(item);}}}catch(err){oldCodexCursor=null;seenCodexCursors.clear();handleAutoFailure('codex:old',err);} if(provider==='agy' && autoWatermark!==null && bases.find(p=>p.provider==='agy')?.discoverExisting) try {const base=bases.find(p=>p.provider==='agy')!;const page=await listOldAgy(base,oldAgyCursor);autoTimeoutStreaks.delete('agy:old');if(page.nextCursor!==null){if(seenAgyCursors.has(page.nextCursor))throw new Error('cursor cycle');if(seenAgyCursors.size>=10000)seenAgyCursors.delete(seenAgyCursors.values().next().value!);seenAgyCursors.add(page.nextCursor);}else seenAgyCursors.clear();oldAgyCursor=page.nextCursor;if(page.partialFailure)autoFailed=true;for(const item of page.items){if(!namespace(item.native,'agy')||!trusted(item)||!pin(item))continue;configure(item);discovered.add(`session_${payloadDigest(item.native)}`);const created=time(item.createdAt),mark=watermarkFor(item);if(mark!==null && Number.isSafeInteger(created) && created<=mark){oldCandidates.add(payloadDigest(item.native));candidates.push(item);}}}catch(err){oldAgyCursor=null;seenAgyCursors.clear();handleAutoFailure('agy:old',err);} if(provider==='claude' && autoWatermark!==null) try {const base=bases.find(p=>p.provider==='claude')!;const page=await listOldClaude(base,oldClaudeCursor);autoTimeoutStreaks.delete('claude:old');oldClaudeCursor=page.nextCursor;if(page.partialFailure)autoFailed=true;for(const item of page.items){if(!namespace(item.native,'claude')||!trusted(item)||!pin(item))continue;configure(item);discovered.add(`session_${payloadDigest(item.native)}`);const created=time(item.createdAt),mark=watermarkFor(item);if(mark!==null && Number.isSafeInteger(created) && created<=mark){oldCandidates.add(payloadDigest(item.native));candidates.push(item);}}}catch(err){oldClaudeCursor=null;handleAutoFailure('claude:old',err);} if((provider==='claude'||provider==='agy'||localCodexClock) && autoWatermark!==null && bases.find(p=>p.provider===provider)?.discoverNewer) {try {const recent=await source.discoverNewer(autoWatermark,recentCursors[provider],1);autoTimeoutStreaks.delete(`${provider}:newer`);recentCursors[provider]=recent.nextCursor;if(recent.partialFailure)autoFailed=true;for(const item of recent.items) {const created=time(item.createdAt),observed=item.discoveryObservedAt ? time(item.discoveryObservedAt) : clock();if(Number.isSafeInteger(created) && Number.isSafeInteger(observed) && created>observed) r.channel.markAutoUncertain(target,item.native);else if(Number.isSafeInteger(created) && watermarkFor(item)!==null && created>watermarkFor(item)! && created<=observed && !r.channel.isAutoUncertain(target,item.native)) {if(!candidates.some(x=>payloadDigest(x.native)===payloadDigest(item.native)))candidates.push(item);}}} catch(err) {recentCursors[provider]=null;handleAutoFailure(`${provider}:newer`,err);}} if(provider==='codex' || provider==='agy') try {const cursor=provider==='codex'?autoCursor:agyAutoCursor;const active=await source.discoverRunning(cursor,1);autoTimeoutStreaks.delete(`${provider}:running`);if(provider==='codex')autoCursor=active.nextCursor;else agyAutoCursor=active.nextCursor;if(active.partialFailure)autoFailed=true;for(const item of active.items){activePrivateCandidates.add(payloadDigest(item.native));oldCandidates.delete(payloadDigest(item.native));if(!candidates.some(x=>payloadDigest(x.native)===payloadDigest(item.native))) candidates.push(item);}} catch(err) {if(provider==='codex')autoCursor=null;else agyAutoCursor=null;handleAutoFailure(`${provider}:running`,err);}
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
        } catch {autoFailed=true;}
      }
      for(let i=0;i<buffered.length;) {const entry=buffered[i]!,o=entry.observation,existing=pinned.get(nativeRefKey(o.ref)); if(entry.expires<=Date.now()) {discard(i);enrichmentError=true;continue;} if(!existing || !r.store.findSession(o.ref)) {i++;continue;} discard(i); if(!trusted(existing) || (o.type==='session' && (payloadDigest(o.session.native)!==payloadDigest(o.ref) || !pin(o.session)))) {enrichmentError=true;continue;} entry.listener(o.type==='session' ? {...o,session:privateTitle(o.session)} : o);}
      // Native history reads may be expensive. Keep each polling cycle bounded so
      // an imported backlog cannot postpone new inbox work until all sessions refresh.
      const boundIds=new Set(r.channel.bindingsForRestore().map(binding=>binding.sessionId));
      if(r.taskChannel) for(const b of r.taskChannel.listActiveBindings()) for(const t of r.taskChannel.listTargets(b.taskId)) boundIds.add(t.sessionId);
      const candidates=r.store.listSessions().filter(s=>!r.store.isDetached(s.sessionId) && !isMissingReadonlyProject(s) && !(s.status==='read_only' && s.control.input!=='available' && r.isProviderUnavailable(s.native.provider)) && trusted(s) && (boundIds.has(s.sessionId) || s.control.input==='available'));
      const count=Math.min(2,candidates.length), start=candidates.length ? refreshOffset%candidates.length : 0; let refreshFailed=false;
      refreshOffset=candidates.length ? (start+count)%candidates.length : 0;
      for(let index=0;index<count;index++) {
        const session=candidates[(start+index)%candidates.length]!;
        if(isMissingReadonlyProject(session)) continue;
        if(session.status==='read_only' && session.control.input!=='available' && r.isProviderUnavailable(session.native.provider)) continue;
        try {
        configure(session);
        const baselines=r.channel.bindingsForRestore().filter(binding=>binding.sessionId===session.sessionId && binding.accessMode==='read_only' && !r.channel.readonlyHydrated(binding.destination,session.sessionId));
        let refreshed = false;
        if(session.status==='read_only' && session.control.input!=='available') {
          try {
            refreshed = await r.core.refreshReadOnlySession(session.sessionId);
            refreshTimeoutStreaks.delete(session.sessionId);
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
        if(refreshed) for(const binding of baselines) if(!r.channel.hasPendingAutoBaseline(binding.destination,session.sessionId)) await r.channel.baselineReadonlyHistory(binding.destination,session.sessionId);
        { const snapshot=await r.core.getSnapshot(session.sessionId);
          for(const m of snapshot.value.messages) if(m.role==='assistant') for(const block of m.blocks) if(block.type==='text') for(const root of registry.getRoots(session.native)) for(const link of await localFileLinks(block.text.replace(/\]\(localfile:\/\/\//g,'](file:///'),session.project,root)) { try { await registry.register(nativeRefKey(session.native),link.path); } catch {} }
        }
        } catch(err) { if(!isMissingReadonlySessionError(session,err)) refreshFailed=true; }
      }
      // Consume and reset on report so between-tick async errors are never dropped, while clean subsequent ticks can recover.
      const hadEnrichmentError=enrichmentError; enrichmentError=false;
      if(hadEnrichmentError || refreshFailed || autoFailed) throw new Error('session refresh or artifact observation failed');
    }});
  } catch(error) {stateLock.exec('ROLLBACK');stateLock.close();await Promise.all(ports.map(p=>p.close()));throw error;}
  activeRuntime=runtime;
  const initProviders: readonly Provider[] = agyEnabled ? ['codex','claude','agy'] : ['codex','claude'];
  try {for(const provider of initProviders){const sourceKey=provider==='codex' ? payloadDigest([config.hostId,config.codexServiceId,config.codexEndpoint,sources.filter(s=>s.provider==='codex').map(s=>s.directory).sort()]) : provider==='claude' ? payloadDigest([config.hostId,config.claudeServiceId,sources.filter(s=>s.provider==='claude').map(s=>s.directory).sort()]) : payloadDigest([config.hostId,config.agy!.serviceId,config.agy!.summariesDbPath ?? null,config.agy!.brainDir ?? null,sources.filter(s=>s.provider==='agy').map(s=>s.directory).sort()]);scopeByProvider[provider]=runtime.channel.configureAutoScopeWatermarks(config.autoMirror?.enabled ? config.autoMirror.destination! : null,sourceKey,[...new Set(projects)].sort(),provider==='codex'?Math.floor(Date.now()/1000):Date.now(),provider);} await registry.load(); for(const s of runtime.store.listSessions()) { if(isMissingReadonlyProject(s)) continue; if(pin(s)) configure(s); } return runtime; } catch(error) {await runtime.close();throw error;}
}
/** Explicit opt-in factory. Construction opens isolated local state, never connects. */
export async function createLiveRuntime(config:RuntimeConfig, credentials:{appId:string;appSecret:string}, sdkDb:string) {
  validateRuntimeConfig(config);
  const agyEnabled = config.agy !== undefined && config.agy.enabled !== false;
  const distinctCheck = [config.coreDb,config.channelDb,config.artifactStatePath,...(agyEnabled && config.agy?.quotaCachePath ? [config.agy.quotaCachePath] : []),...(config.watchHub?.enabled ? [resolveWatchHubDbPath(config)] : []),...(config.pendingHub?.enabled ? [resolvePendingHubDbPath(config)] : []),...(config.decisionSync?.enabled ? [resolveDecisionSyncDbPath(config)] : [])].filter((x):x is string=>!!x);
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
    });
    agyTransport = new AgyAcpTransport({
      ...(config.agy!.binPath !== undefined ? { agyBin: config.agy!.binPath } : {}),
      ...(config.agy!.geminiDir !== undefined ? { geminiDir: config.agy!.geminiDir } : {}),
      ...(config.agy!.appDataDir !== undefined ? { appDataDir: config.agy!.appDataDir } : {}),
      ...(config.agy!.sandbox !== undefined ? { sandbox: config.agy!.sandbox } : {}),
    });
    agyQuota = new AgyQuotaClient({
      ...(config.agy!.binPath !== undefined ? { agyBin: config.agy!.binPath } : {}),
      ...(config.agy!.quotaCachePath !== undefined ? { cachePath: config.agy!.quotaCachePath } : {}),
    });
    agyAdapter = new AgyAdapter(agyTransport, agyCatalog, config.hostId, config.agy!.serviceId, agyQuota, { approvalPolicy });
  }
  const taskTopicEnabled = config.taskTopic?.enabled === true;
  const port=new FeishuSdkPort(credentials,sdkDb,new Set(config.allowedDestinations),config.ownerOpenId,taskTopicEnabled,taskTopicEnabled); let runtime:UnifiedRuntime;
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
    ...(agyQuota ? { refreshQuota: async () => { try { await agyQuota.query(); const qh = agyQuota.health(); runtime.channel.recordHealth('agy_quota', qh.status, qh.reason); } catch {} } } : {}),
  } : undefined;
  return {...liveRuntimeLifecycle(runtime,transport,port,testLane,agyLifecycle),testLane};
}
/** Shutdown can race either network startup await; no continuation may start polling after close. */
export function liveRuntimeLifecycle<T extends Pick<UnifiedRuntime,'handleTrusted'|'captureResourceScope'|'startPolling'|'close'> & Partial<Pick<UnifiedRuntime,'restoreBindings'|'restoreProviderAfterReconnect'|'setProviderReady'|'recordProviderConnection'>>>(runtime:T, transport:Pick<CodexTransport,'connect'|'close'> & Partial<Pick<CodexTransport,'onDisconnect'|'connected'>>, port:Pick<FeishuSdkPort,'start'|'stopReceiving'|'close'> & Partial<Pick<FeishuSdkPort,'drainTestCreates'>>, testLane?:Pick<TestLaneRuntime,'startPolling'|'startOperator'|'close'>, agy?:{transport:Pick<AgyAcpTransport,'connect'|'close'> & Partial<Pick<AgyAcpTransport,'onDisconnect'|'connected'>>;refreshQuota?:()=>Promise<void>}) {
  let closing=false, started=false, closePromise:Promise<void>|undefined, timer:ReturnType<typeof setTimeout>|undefined, connecting=false, attempt=0; const previousDisconnect=transport.onDisconnect;
  let agyTimer:ReturnType<typeof setTimeout>|undefined, agyConnecting=false, agyAttempt=0; const previousAgyDisconnect=agy?.transport.onDisconnect;
  const schedule=()=>{if(closing || timer || connecting) return;const delay=Math.min(30000,1000*2**Math.min(attempt,5));timer=setTimeout(()=>{timer=undefined;void connect();},delay);timer.unref?.();};
  const connect=async()=>{if(closing || connecting) return;connecting=true;try {await transport.connect();if(closing){transport.close();return;}if(transport.connected===false) throw new Error('connection closed');attempt=0;runtime.setProviderReady?.('codex',true);runtime.recordProviderConnection?.('codex',true);try {await runtime.restoreProviderAfterReconnect?.('codex');} catch {}} catch {if(!closing) {runtime.recordProviderConnection?.('codex',false);attempt=Math.min(attempt+1,5);}} finally {connecting=false;if(!closing && attempt>0) schedule();}};
  if('onDisconnect' in transport) transport.onDisconnect=(generation:number)=>{try {previousDisconnect?.(generation);} catch {} if(!closing){runtime.setProviderReady?.('codex',false);attempt=Math.max(attempt,1);schedule();}};
  const scheduleAgy=()=>{if(!agy || closing || agyTimer || agyConnecting) return;const delay=Math.min(30000,1000*2**Math.min(agyAttempt,5));agyTimer=setTimeout(()=>{agyTimer=undefined;void connectAgy();},delay);agyTimer.unref?.();};
  const connectAgy=async()=>{if(!agy || closing || agyConnecting) return;agyConnecting=true;try {await agy.transport.connect();if(closing){await agy.transport.close().catch(()=>{});return;}if(agy.transport.connected===false) throw new Error('connection closed');agyAttempt=0;runtime.setProviderReady?.('agy',true);runtime.recordProviderConnection?.('agy',true);try {await runtime.restoreProviderAfterReconnect?.('agy');} catch {} if(!closing) void agy.refreshQuota?.().catch(()=>{});} catch {if(!closing) {runtime.recordProviderConnection?.('agy',false);agyAttempt=Math.min(agyAttempt+1,5);}} finally {agyConnecting=false;if(!closing && agyAttempt>0) scheduleAgy();}};
  if(agy && 'onDisconnect' in agy.transport) agy.transport.onDisconnect=(generation:number,reason:string)=>{try {previousAgyDisconnect?.(generation,reason);} catch {} if(!closing){runtime.setProviderReady?.('agy',false);agyAttempt=Math.max(agyAttempt,1);scheduleAgy();}};
  const closeTransports=()=>Promise.allSettled([Promise.resolve().then(()=>transport.close()),...(agy?[agy.transport.close()]:[])]);
  return {runtime,async start(){if(closing || started) throw new Error('runtime closing or started');started=true;runtime.setProviderReady?.('codex',false);if(agy) runtime.setProviderReady?.('agy',false);try {await port.start((e,a)=>runtime.handleTrusted(e,a),e=>runtime.captureResourceScope(e));if(closing){port.stopReceiving();throw new Error('runtime closing');}runtime.startPolling();try {if(testLane){await testLane.startOperator();if(closing)throw new Error('closing');testLane.startPolling();}} catch {void testLane?.close();}if(closing)throw new Error('runtime closing');void connect();if(agy) void connectAgy();} catch(error) {await closeTransports();throw error;}},close(){if(closePromise)return closePromise;closing=true;if(timer)clearTimeout(timer);if(agyTimer)clearTimeout(agyTimer);closePromise=Promise.resolve().then(async()=>{try {try {port.stopReceiving();} finally {await closeTransports();}} finally {try {const results=await Promise.allSettled([runtime.close(),testLane?.close()]);const failed=results.find((r):r is PromiseRejectedResult=>r.status==='rejected');if(failed)throw failed.reason;} finally {try {await port.drainTestCreates?.();await closeTransports();} finally {port.close();}}}});return closePromise;}};
}
