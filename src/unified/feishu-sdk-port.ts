import { verifiedMessageAppLink } from './feishu-message-link.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import { parseIncoming, parseCardAction } from '../feishu.js';
import { toFeishuCard, parseFeishuAction, parseFeishuText } from './feishu-codec.js';
import type { ChannelAction, FeishuPort, TrustedEnvelope } from './feishu-channel.js';
import type { RuntimeTrustedAction } from './runtime.js';
import type { ChannelCard } from './feishu-cards.js';
import type { Provider } from './contracts.js';
import { imageMediaType } from '../image-media.js';
import {TaskTopicStore,type TaskTopicToken} from './task-topic-store.js';
import {attachmentDisplayName,decodeTextAttachment,MAX_TEXT_ATTACHMENT_BYTES} from './text-attachment.js';
import type { Readable } from 'node:stream';

class ResourceRejected extends Error {}
class FeishuApiRejected extends Error { readonly deliveryKind='api_rejected'; constructor(readonly platformCode:number) {super('Feishu API rejected request');} }
function rejectCode(code:unknown):void {if(typeof code==='number' && Number.isSafeInteger(code) && code!==0) throw new FeishuApiRejected(code);}
class UnknownTopic extends Error {}
class TaskPendingRoute extends Error {}
class UnknownCardRoute extends Error {}
class ClosedTestRoute extends Error {}
class UnknownTestRoute extends Error {}
class ClosedKnownTestCreation extends Error { readonly deliveryKind='known_closed'; }
class PendingKnownTestCreation extends Error { readonly deliveryKind='known_pending'; }
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;
type ResourceMetadata={name?:string;mime?:string};
type MessageEvent = Parameters<NonNullable<Lark.EventHandles['im.message.receive_v1']>>[0];
/** Only call with an SDK authenticated WS event, never an HTTP body. */
export async function receiveSdkMessage(data:MessageEvent, botId:string, owner:string, destinations:ReadonlySet<string>, download:(messageId:string,key:string,type:'image'|'file')=>Promise<Readable>, handle:(e:TrustedEnvelope,a:ChannelAction)=>Promise<unknown>, queueResource?:(e:TrustedEnvelope,messageId:string,key:string,type:'image'|'file',metadata?:ResourceMetadata)=>void|Promise<void>, resolveDestination?:(chatId:string,rootId?:string,parentId?:string,threadId?:string)=>string):Promise<void> {
  const m=parseIncoming(data,botId); if (!m) return;
  const threadId=(data.message as unknown as {thread_id?:string}).thread_id;
  const inTopic=Boolean(m.rootId || m.parentId || threadId);
  if (m.mentionedBot) {
    if (m.senderOpenId !== owner || !destinations.has(m.chatId)) throw new Error('unauthorized');
  } else {
    if (m.senderOpenId !== owner || !destinations.has(m.chatId)) return;
    const isMainSlash=!inTopic && data.message.message_type === 'text' && Boolean(m.text?.trim().startsWith('/'));
    if (!inTopic && !isMainSlash) return;
  }
  let textAction:ChannelAction | undefined;
  if (data.message.message_type === 'text' && m.text) { try { textAction=parseFeishuText(m.text); } catch (error) { if (!m.text.startsWith('/')) throw error; textAction={action:'help'}; } }
  let destination:string;
  try {
    destination=resolveDestination ? resolveDestination(m.chatId,m.rootId,m.parentId,threadId) : m.chatId;
  } catch (error) {
    if (!m.mentionedBot && inTopic && error instanceof UnknownTopic) return;
    throw error;
  }
  const envelope={eventId:`message:${m.messageId}`,destination,identity:{source:'feishu',subject:m.senderOpenId}};
  if (textAction) { await handle(envelope,textAction); return; }
  if (!m.mentionedBot && data.message.message_type === 'text' && !m.text) return;
  if (data.message.message_type !== 'image' && data.message.message_type !== 'file') throw new Error('unsupported inbound message type');
  let body:unknown; try { body=JSON.parse(data.message.content); } catch { throw new Error('invalid resource message'); }
  if (!body || typeof body !== 'object') throw new Error('invalid resource message');
  const resourceType=data.message.message_type; const key=(body as Record<string,unknown>)[resourceType === 'image' ? 'image_key' : 'file_key'];
  if (typeof key !== 'string' || !key || !m.messageId) throw new Error('invalid resource key');
  const obj=body as Record<string,unknown>;if((typeof obj.file_name==='string'&&Buffer.byteLength(obj.file_name)>1024)||(typeof obj.mime_type==='string'&&Buffer.byteLength(obj.mime_type)>128))throw new Error('invalid resource metadata');const metadata:ResourceMetadata={...(typeof obj.file_name==='string'?{name:obj.file_name}:{}),...(typeof obj.mime_type==='string'?{mime:obj.mime_type}:{})};
  if (queueResource) { await queueResource(envelope,m.messageId,key,resourceType,metadata); return; }
  await downloadAndIntake(envelope,m.messageId,key,resourceType,download,handle,undefined,metadata);
}
async function downloadAndIntake(envelope:TrustedEnvelope,messageId:string,key:string,resourceType:'image'|'file',download:(messageId:string,key:string,type:'image'|'file')=>Promise<Readable>,handle:(e:TrustedEnvelope,a:ChannelAction,scope?:string)=>Promise<unknown>,scope?:string,metadata?:ResourceMetadata):Promise<void> {
  const rawName=metadata?.name, mime=metadata?.mime?.toLowerCase();const textHint=resourceType==='file' && (typeof rawName==='string'&&/\.txt$/i.test(rawName)||mime==='text/plain');const stream=await download(messageId,key,resourceType); const chunks:Buffer[]=[]; let length=0;
  try { for await (const part of stream) { const chunk=Buffer.isBuffer(part) ? part : Buffer.from(part); length+=chunk.length; if(length>(textHint?MAX_TEXT_ATTACHMENT_BYTES:MAX_INBOUND_BYTES)) throw new ResourceRejected(textHint?'size':'inbound resource exceeds limit'); chunks.push(chunk); } } finally { if (!stream.destroyed) stream.destroy(); }
  const content=Buffer.concat(chunks); const mediaType=imageMediaType(content);if(resourceType==='file'&&!textHint&&((rawName&&!/\.(png|jpe?g|gif|webp)$/i.test(rawName))||(mime&&!['image/png','image/jpeg','image/gif','image/webp'].includes(mime))||(mime&&mediaType&&mime!==mediaType)))throw new ResourceRejected('unsupported');if(textHint){if(mediaType || (mime&&mime!=='text/plain') || (rawName&&!/\.txt$/i.test(rawName)))throw new ResourceRejected('unsupported');try{decodeTextAttachment(content)}catch(error){throw new ResourceRejected(content.length===0||content.length>MAX_TEXT_ATTACHMENT_BYTES?'size':'encoding')}await handle(envelope,{action:'attachment',name:attachmentDisplayName(rawName??'attachment.txt'),mediaType:'text/plain',content,mode:'new'},scope);return;} if (!mediaType) throw new ResourceRejected('unsupported resource type');
  const ext={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'}[mediaType];
  await handle(envelope,{action:'attachment',name:rawName?attachmentDisplayName(rawName):`image.${ext}`,mediaType,content,mode:'new'},scope);
}

/** Extract callback only from a verified SDK WS event; form values are persisted as input, never identity. */
export function parseSdkCardCallback<T extends RuntimeTrustedAction = ChannelAction>(data:Lark.RawCardActionEvent, owner:string, resolve:(chatId:string,messageId:string)=>string): {envelope:TrustedEnvelope;action:T} | null {
  const a=parseCardAction(data); if (!a || !a.eventId) return null;
  if (a.openId !== owner) throw new Error('unauthorized');
  return {envelope:{eventId:`card:${a.eventId}`,destination:resolve(a.chatId,a.openMessageId),identity:{source:'feishu',subject:a.openId},...(a.openMessageId ? {cardMessageId:a.openMessageId} : {})},action:parseFeishuAction<T>(a.value,a.formValues)};
}
/** Old or malformed cards are guidance only; their untrusted values never reach the channel. */
export async function handleSdkCardCallback<T extends RuntimeTrustedAction = ChannelAction>(data:Lark.RawCardActionEvent, owner:string, destinations:ReadonlySet<string>, resolve:(chatId:string,messageId:string)=>string, handle:(e:TrustedEnvelope,a:T)=>Promise<unknown>):Promise<{toast:{type:'info';content:string}} | undefined> {
  const a=parseCardAction(data); if (!a || !a.eventId) return undefined;
  if (a.openId !== owner || !destinations.has(a.chatId)) throw new Error('unauthorized');
  let action:T;
  try { action=parseFeishuAction<T>(a.value,a.formValues); } catch { return {toast:{type:'info',content:'旧卡或卡片操作已失效，请发送 /sessions 重新选择会话。'}}; }
  let destination:string; try {destination=resolve(a.chatId,a.openMessageId);} catch(error) {return error instanceof TaskPendingRoute ? {toast:{type:'info',content:'任务话题待核查，写入暂不可用。'}} : error instanceof ClosedTestRoute ? {toast:{type:'info',content:'此测试话题已关闭。'}} : error instanceof UnknownTestRoute ? {toast:{type:'info',content:'测试话题创建结果待核查，请联系管理员。'}} : error instanceof UnknownCardRoute ? {toast:{type:'info',content:'卡片已失效，请发送 /sessions 重新选择会话。'}} : {toast:{type:'info',content:'暂时无法处理卡片，请稍后查看会话状态。'}};}
  const envelope:TrustedEnvelope={eventId:`card:${a.eventId}`,destination,identity:{source:'feishu',subject:a.openId},...(a.openMessageId ? {cardMessageId:a.openMessageId} : {})};
  try {await handle(envelope,action);} catch {return {toast:{type:'info',content:'操作状态未确认，请查看会话状态后再操作。'}};} return undefined;
}
export type TestLaneToken={rootId:string;destination:string;appId:string;chatId:string;owner:string;laneId:string;namespace:string;generation:number;provider:'codex'|'claude'};
type TestLaneHandler={handle:(e:TrustedEnvelope,a:ChannelAction,token:TestLaneToken)=>Promise<unknown>;capture:(e:TrustedEnvelope,token:TestLaneToken)=>Promise<string>};
/** Only the SDK WS dispatcher invokes the inbound handler. Credentials are explicitly injected. */
export class FeishuSdkPort implements FeishuPort {
  private readonly client: Lark.Client;
  private readonly appId:string;
  private testHandler:TestLaneHandler|undefined;
  private readonly testResourceFlights=new Map<string,Promise<void>>();
  private readonly testCreates=new Set<Promise<unknown>>();private readonly taskStore:TaskTopicStore;private closeRequested=false;
  private readonly ws: Lark.WSClient;
  private readonly db: DatabaseSync;
  private migrationLocked=false;
  private started = false;
  private closing = false;
  private routeGeneration=0;
  private readonly linkCache=new Map<string,{url:string;expires:number}>();
  private readonly linkFlights=new Map<string,Promise<string|null>>();
  private dbClosed = false;
  constructor(credentials: {appId:string; appSecret:string}, dbPath:string, private readonly destinations: ReadonlySet<string>, private readonly owner:string,private readonly taskEnabled=false,private readonly taskTopicRuntimeEnabled=false) {
    if (!credentials.appId || !credentials.appSecret || !destinations.size || !owner) throw new Error('missing SDK configuration');
    this.appId=credentials.appId;
    const base = { appId: credentials.appId, appSecret: credentials.appSecret, appType:Lark.AppType.SelfBuild, domain:Lark.Domain.Feishu };
    this.client = new Lark.Client(base); this.ws = new Lark.WSClient({...base, loggerLevel:Lark.LoggerLevel.error});
    this.db = new DatabaseSync(dbPath); this.db.exec("CREATE TABLE IF NOT EXISTS sdk_task_creations_v1 (operation_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,state TEXT NOT NULL,root_id TEXT,destination TEXT,payload_digest TEXT NOT NULL,delivery_id TEXT NOT NULL UNIQUE)"); this.db.exec("CREATE TABLE IF NOT EXISTS sdk_text_resources_v1 (event_id TEXT PRIMARY KEY,envelope TEXT NOT NULL,message_id TEXT NOT NULL,resource_key TEXT NOT NULL,metadata TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,reason TEXT,next_attempt INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS sdk_text_resource_tokens_v1 (event_id TEXT PRIMARY KEY,token TEXT NOT NULL)"); this.db.exec('CREATE TABLE IF NOT EXISTS sdk_lane_creations (operation_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, provider TEXT NOT NULL, delivery_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, root_id TEXT, destination TEXT)'); this.db.exec("DROP INDEX IF EXISTS sdk_lane_creation_provider; CREATE UNIQUE INDEX IF NOT EXISTS sdk_lane_creation_reserved ON sdk_lane_creations(provider) WHERE state<>'rejected'; CREATE TABLE IF NOT EXISTS sdk_lane_resource_tokens (event_id TEXT PRIMARY KEY, token TEXT NOT NULL)"); this.db.exec("CREATE TABLE IF NOT EXISTS sdk_native_lane_creations (operation_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,provider TEXT NOT NULL,delivery_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,root_id TEXT,destination TEXT); CREATE UNIQUE INDEX IF NOT EXISTS sdk_native_lane_reserved ON sdk_native_lane_creations(provider) WHERE state<>'rejected'"); this.db.exec('CREATE TABLE IF NOT EXISTS sdk_lane_registry (root_id TEXT PRIMARY KEY, destination TEXT NOT NULL UNIQUE, app_id TEXT NOT NULL, chat_id TEXT NOT NULL, owner TEXT NOT NULL, lane_id TEXT NOT NULL, namespace TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, operation_id TEXT NOT NULL, delivery_id TEXT NOT NULL, created_at INTEGER NOT NULL)'); this.db.exec('CREATE TABLE IF NOT EXISTS sdk_topic_routes (destination TEXT PRIMARY KEY, chat_id TEXT NOT NULL, root_id TEXT NOT NULL UNIQUE, thread_id TEXT, session_id TEXT NOT NULL, UNIQUE(chat_id,session_id)); CREATE TABLE IF NOT EXISTS sdk_message_routes (message_id TEXT PRIMARY KEY, destination TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sdk_deliveries (id TEXT PRIMARY KEY, message_id TEXT); CREATE TABLE IF NOT EXISTS sdk_inbound_resources (event_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, message_id TEXT NOT NULL, resource_key TEXT NOT NULL, resource_type TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sdk_resource_scopes (event_id TEXT PRIMARY KEY, scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sdk_resource_failures (event_id TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL, reason TEXT NOT NULL, next_attempt INTEGER NOT NULL)');
    this.taskStore=new TaskTopicStore(this.db,this.appId,this.owner,this.destinations);
  }
  /** Only a local, constrained operator can create either mock provider root. */
  /** Explicitly enabled, owner-scoped task creation; no implicit topic creation. */
  createTaskTopic(chatId:string,taskId:string,operationId:string,owner:string):Promise<TaskTopicToken> {if(!this.taskEnabled||this.closing) return Promise.reject(new Error('task topic unavailable'));const flight=this.createTaskTopicOnce(chatId,taskId,operationId,owner);this.testCreates.add(flight);void flight.finally(()=>{this.testCreates.delete(flight);if(this.closeRequested&&!this.testCreates.size&&!this.dbClosed){this.dbClosed=true;this.db.close();}}).catch(()=>{});return flight;}
  private async createTaskTopicOnce(chatId:string,taskId:string,operationId:string,owner:string):Promise<TaskTopicToken> {const claim=this.taskStore.claim(chatId,taskId,operationId,owner);if(claim.existing)return claim.existing;const response=await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:chatId,msg_type:'interactive',content:JSON.stringify(toFeishuCard({title:'任务话题',text:'任务话题已建立，目标功能待启用。',actions:[]}))}});if(typeof response.code==='number'&&Number.isSafeInteger(response.code)&&response.code!==0){this.taskStore.rejected(operationId);throw new FeishuApiRejected(response.code);}if(typeof response.data?.message_id!=='string'||!response.data.message_id.trim())throw Error('task creation outcome unknown');const token=this.taskStore.record(chatId,taskId,operationId,response.data.message_id,response.data.thread_id??null,this.closing);if(!token)throw Error('task topic created and closed');return token;}
  recoverKnownTaskTopic(chatId:string,taskId:string,operationId:string,owner:string):TaskTopicToken|null {if(!this.taskEnabled||this.closing)throw Error('task topic unavailable');return this.taskStore.finishKnown(chatId,taskId,operationId,owner);}
  lookupTaskTopic(destination:string,owner:string):TaskTopicToken|null {if(!this.taskEnabled||this.closing||owner!==this.owner)return null;return this.taskStore.lookup(destination);}
  closeTaskTopic(token:TaskTopicToken,owner:string):void {if(!this.taskEnabled||this.closing)throw Error('task topic unavailable');this.taskStore.close(token,owner);this.routeGeneration++;}
  private taskToken(destination:string):TaskTopicToken|null{return this.taskEnabled&&!this.closing?this.taskStore.lookup(destination):null;}
  private async handleTask(e:TrustedEnvelope,token:TaskTopicToken):Promise<unknown> {if(e.identity.source!=='feishu'||e.identity.subject!==this.owner||JSON.stringify(this.taskToken(e.destination))!==JSON.stringify(token))throw Error('task topic unavailable');const id=`task-t0:${e.eventId}`;if(!this.db.prepare('INSERT OR IGNORE INTO sdk_deliveries VALUES (?,NULL)').run(id).changes){const prior=this.db.prepare('SELECT message_id FROM sdk_deliveries WHERE id=?').get(id) as {message_id:string|null}|undefined;return {status:prior?.message_id?'sent':'unknown'};}if(JSON.stringify(this.taskToken(e.destination))!==JSON.stringify(token))throw Error('task topic unavailable');const response=await this.client.im.message.reply({path:{message_id:token.rootId},data:{msg_type:'interactive',content:JSON.stringify(toFeishuCard({title:'任务话题',text:'任务目标功能尚未启用，当前未发送模型输入。',actions:[]})),reply_in_thread:true}});rejectCode(response.code);if(!response.data?.message_id)throw Error('task delivery outcome unknown');if(JSON.stringify(this.taskToken(e.destination))!==JSON.stringify(token))throw Error('task topic unavailable');this.remember(id,response.data.message_id,token.destination);return {status:'unavailable'};}
  createTestTopic(chatId:string,provider:'codex'|'claude',operationId:string,active:()=>boolean):Promise<TestLaneToken> {const flight=this.createTestTopicInner(chatId,provider,operationId,active);this.testCreates.add(flight);void flight.finally(()=>{this.testCreates.delete(flight);if(this.closeRequested && !this.testCreates.size && !this.dbClosed){this.dbClosed=true;this.db.close();}}).catch(()=>{});return flight;}
  async drainTestCreates():Promise<void>{await Promise.allSettled([...this.testCreates]);}
  private async createTestTopicInner(chatId:string,provider:'codex'|'claude',operationId:string,active:()=>boolean):Promise<TestLaneToken> {
    if(this.closing || !active() || !this.destinations.has(chatId) || !['codex','claude'].includes(provider) || !/^[a-zA-Z0-9_-]{1,80}$/.test(operationId)) throw new Error('test creation unauthorized');
    const deliveryId=`test-root:${operationId}`;const prior=this.db.prepare('SELECT state,root_id,destination FROM sdk_lane_creations WHERE operation_id=?').get(operationId) as {state:string;root_id:string|null;destination:string|null}|undefined;
    if(prior){if(prior.state==='rejected')throw new Error('test creation rejected');if(prior.state==='known')throw new PendingKnownTestCreation('test root known; route recovery required');if(prior.state==='closed')throw new ClosedKnownTestCreation('test topic created and closed');if(prior.state==='active'&&prior.destination){const token=this.testToken(prior.destination);if(token&&token.chatId===chatId&&token.provider===provider)return token;}throw new Error('test creation outcome unknown');}
    if(this.db.prepare("SELECT 1 FROM sdk_lane_creations WHERE provider=? AND state<>'rejected' LIMIT 1").get(provider)) throw new Error('test provider already reserved');const attempts=this.db.prepare('SELECT COUNT(*) AS n FROM sdk_lane_creations WHERE provider=?').get(provider) as {n:number};if(attempts.n>=3)throw new Error('test creation attempt limit reached');
    this.db.prepare("INSERT INTO sdk_lane_creations VALUES (?,?,?,?,'unknown',NULL,NULL)").run(operationId,chatId,provider,deliveryId);
    const response=await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:chatId,msg_type:'interactive',content:JSON.stringify(toFeishuCard({title:'测试话题',text:`${provider} 模拟测试`,actions:[]}))}});
    if(typeof response.code==='number' && Number.isSafeInteger(response.code) && response.code!==0){this.db.prepare("UPDATE sdk_lane_creations SET state='rejected' WHERE operation_id=? AND state='unknown'").run(operationId);throw new FeishuApiRejected(response.code);}if(typeof response.data?.message_id!=='string'||!response.data.message_id.trim())throw new Error('test creation outcome unknown');
    const root=response.data.message_id,destination=`topic:${randomUUID()}`,namespace=`mock-test:${provider}`,lane='mock-test';
    this.db.prepare("UPDATE sdk_lane_creations SET state='known',root_id=?,destination=? WHERE operation_id=? AND state='unknown'").run(root,destination,operationId);
    const closed=this.closing || !active(),state=closed?'closed':'active';
    this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO sdk_lane_registry VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(root,destination,this.appId,chatId,this.owner,lane,namespace,closed?2:1,state,1,operationId,deliveryId,Date.now());this.db.prepare('INSERT INTO sdk_topic_routes VALUES (?,?,?,?,?)').run(destination,chatId,root,response.data.thread_id??null,namespace);this.db.prepare('INSERT INTO sdk_message_routes VALUES (?,?)').run(root,destination);this.db.prepare("UPDATE sdk_lane_creations SET state=? WHERE operation_id=? AND state='known'").run(state,operationId);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    if(closed)throw new ClosedKnownTestCreation('test topic created and closed');const token=this.testToken(destination);if(!token)throw new Error('test creation outcome unknown');return token;
  }
  /** Explicit opt-in native Claude root; separate from the immutable mock creation ledger. */
  createNativeTestTopic(chatId:string,operationId:string,active:()=>boolean,provider:Provider='claude'):Promise<TestLaneToken> {const flight=this.createNativeTestTopicInner(chatId,operationId,active,provider);this.testCreates.add(flight);void flight.finally(()=>{this.testCreates.delete(flight);if(this.closeRequested&&!this.testCreates.size&&!this.dbClosed){this.dbClosed=true;this.db.close();}}).catch(()=>{});return flight;}
  private async createNativeTestTopicInner(chatId:string,operationId:string,active:()=>boolean,provider:Provider):Promise<TestLaneToken> {
    if(this.closing||!active()||!['claude','codex'].includes(provider)||!this.destinations.has(chatId)||!/^[a-zA-Z0-9_-]{1,80}$/.test(operationId))throw new Error('test creation unauthorized');
    const prior=this.db.prepare('SELECT state,destination FROM sdk_native_lane_creations WHERE operation_id=?').get(operationId) as {state:string;destination:string|null}|undefined;
    if(prior){if(prior.state==='rejected')throw new Error('test creation rejected');if(prior.state==='active'&&prior.destination){const token=this.testToken(prior.destination);if(token?.laneId==='native-test'&&token.chatId===chatId&&token.provider===provider)return token;}throw new Error('test creation outcome unknown');}
    if(this.db.prepare("SELECT 1 FROM sdk_native_lane_creations WHERE provider=? AND state<>'rejected' LIMIT 1").get(provider))throw new Error('native test provider already reserved');const count=this.db.prepare("SELECT COUNT(*) AS n FROM sdk_native_lane_creations WHERE provider=?").get(provider) as {n:number};if(count.n>=3)throw new Error('test creation attempt limit reached');
    const deliveryId=`native-test-root:${operationId}`;this.db.prepare("INSERT INTO sdk_native_lane_creations VALUES (?,?,?,?,'unknown',NULL,NULL)").run(operationId,chatId,provider,deliveryId);
    const response=await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:chatId,msg_type:'interactive',content:JSON.stringify(toFeishuCard({title:'原生隔离测试',text:`${provider==='claude'?'Claude':'Codex'} · 本地模拟服务`,actions:[]}))}});
    if(typeof response.code==='number'&&Number.isSafeInteger(response.code)&&response.code!==0){this.db.prepare("UPDATE sdk_native_lane_creations SET state='rejected' WHERE operation_id=? AND state='unknown'").run(operationId);throw new FeishuApiRejected(response.code);}if(typeof response.data?.message_id!=='string'||!response.data.message_id.trim())throw new Error('test creation outcome unknown');
    const root=response.data.message_id,destination=`topic:${randomUUID()}`,namespace=`native-test:${provider}`;this.db.prepare("UPDATE sdk_native_lane_creations SET state='known',root_id=?,destination=? WHERE operation_id=? AND state='unknown'").run(root,destination,operationId);const closed=this.closing||!active(),state=closed?'closed':'active';
    this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO sdk_lane_registry VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(root,destination,this.appId,chatId,this.owner,'native-test',namespace,closed?2:1,state,1,operationId,deliveryId,Date.now());this.db.prepare('INSERT INTO sdk_topic_routes VALUES (?,?,?,?,?)').run(destination,chatId,root,response.data.thread_id??null,namespace);this.db.prepare('INSERT INTO sdk_message_routes VALUES (?,?)').run(root,destination);this.db.prepare("UPDATE sdk_native_lane_creations SET state=? WHERE operation_id=? AND state='known'").run(state,operationId);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    if(closed)throw new ClosedKnownTestCreation('test topic created and closed');const token=this.testToken(destination);if(!token)throw new Error('test creation outcome unknown');return token;
  }
  private testToken(destination:string):TestLaneToken|null {
    const row=this.db.prepare('SELECT root_id,destination,app_id,chat_id,owner,lane_id,namespace,generation,state,version FROM sdk_lane_registry WHERE destination=?').get(destination) as {root_id:string;destination:string;app_id:string;chat_id:string;owner:string;lane_id:string;namespace:string;generation:number;state:string;version:number}|undefined;
    if(!row || row.app_id!==this.appId || row.owner!==this.owner || !this.destinations.has(row.chat_id) || !['mock-test','native-test'].includes(row.lane_id) || row.state!=='active' || row.version!==1 || !Number.isSafeInteger(row.generation) || row.generation<1)return null;
    const provider=((row.lane_id==='mock-test'&&row.namespace==='mock-test:codex')||(row.lane_id==='native-test'&&row.namespace==='native-test:codex'))?'codex':((row.lane_id==='mock-test'&&row.namespace==='mock-test:claude')||(row.lane_id==='native-test'&&row.namespace==='native-test:claude'))?'claude':null;if(!provider)return null;
    const route=this.db.prepare('SELECT root_id,chat_id,session_id FROM sdk_topic_routes WHERE destination=?').get(destination) as {root_id:string;chat_id:string;session_id:string}|undefined;if(!route||route.root_id!==row.root_id||route.chat_id!==row.chat_id||route.session_id!==row.namespace)return null;
    return {rootId:row.root_id,destination:row.destination,appId:row.app_id,chatId:row.chat_id,owner:row.owner,laneId:row.lane_id,namespace:row.namespace,generation:row.generation,provider};
  }
  private validateTestToken(token:TestLaneToken):void {if(this.closing || JSON.stringify(this.testToken(token.destination))!==JSON.stringify(token))throw new Error('test lane unavailable');}
  testLaneToken(destination:string):TestLaneToken|null{return this.testToken(destination);}
  isTestClosed(token:TestLaneToken):boolean {const row=this.db.prepare("SELECT root_id,app_id,chat_id,owner,lane_id,namespace,generation,state FROM sdk_lane_registry WHERE destination=?").get(token.destination) as {root_id:string;app_id:string;chat_id:string;owner:string;lane_id:string;namespace:string;generation:number;state:string}|undefined;return !!row&&row.root_id===token.rootId&&row.app_id===token.appId&&row.chat_id===token.chatId&&row.owner===token.owner&&row.lane_id===token.laneId&&row.namespace===token.namespace&&row.state==='closed'&&row.generation>token.generation;}
  listTestTokens():TestLaneToken[]{const rows=this.db.prepare("SELECT destination FROM sdk_lane_registry WHERE lane_id='mock-test' AND state='active'").all() as Array<{destination:string}>;return rows.map(r=>this.testToken(r.destination)).filter((t):t is TestLaneToken=>!!t);}
  listNativeTestTokens():TestLaneToken[]{const rows=this.db.prepare("SELECT destination FROM sdk_lane_registry WHERE lane_id='native-test' AND state='active'").all() as Array<{destination:string}>;return rows.map(r=>this.testToken(r.destination)).filter((t):t is TestLaneToken=>!!t);}
  createTestPort(token:TestLaneToken):FeishuPort & {authorizedDestination:(destination:string)=>boolean} {
    this.validateTestToken(token);const handler=this.testHandler;if(!handler)throw new Error('test lane unavailable');const validate=(destination:string)=>{if(destination!==token.destination)throw new Error('test destination mismatch');if(this.testHandler!==handler)throw new Error('test lane unavailable');this.validateTestToken(token);};
    return {
      isTopicDestination:(destination)=>{try{validate(destination);return true;}catch{return false;}},
      authorizedDestination:(destination)=>{try{validate(destination);return true;}catch{return false;}},
      send:async(destination,card,deliveryId,guard)=>{await guard?.();validate(destination);const response=await this.client.im.message.reply({path:{message_id:token.rootId},data:{msg_type:'interactive',content:JSON.stringify(toFeishuCard(card)),reply_in_thread:true}});rejectCode(response.code);if(!response.data?.message_id)throw new Error('test delivery outcome unknown');this.remember(deliveryId,response.data.message_id,destination);return response.data.message_id;},
      update:async(destination,messageId,card,deliveryId,guard)=>{await guard?.();validate(destination);const row=this.db.prepare('SELECT destination FROM sdk_message_routes WHERE message_id=?').get(messageId) as {destination:string}|undefined;if(row?.destination!==destination)throw new Error('test message mismatch');const response=await this.client.im.message.patch({path:{message_id:messageId},data:{content:JSON.stringify(toFeishuCard(card))}});rejectCode(response.code);this.remember(deliveryId,messageId,destination);},
      sendFile:async(destination,name,content,deliveryId,guard)=>{if(content.length>1024*1024 || !/^[^/\\\x00-\x1f]{1,80}$/.test(name))throw new Error('test fixture rejected');await guard?.();validate(destination);const uploaded=await this.client.im.file.create({data:{file_type:'stream',file_name:name,file:Buffer.from(content)}});if(!uploaded?.file_key)throw new Error('test upload outcome unknown');await guard?.();validate(destination);const response=await this.client.im.message.reply({path:{message_id:token.rootId},data:{msg_type:'file',content:JSON.stringify({file_key:uploaded.file_key}),reply_in_thread:true}});rejectCode(response.code);if(!response.data?.message_id)throw new Error('test delivery outcome unknown');this.remember(deliveryId,response.data.message_id,destination);},
      lookupDelivery:async(deliveryId)=>{validate(token.destination);const row=this.db.prepare('SELECT m.destination FROM sdk_deliveries d JOIN sdk_message_routes m ON m.message_id=d.message_id WHERE d.id=?').get(deliveryId) as {destination:string}|undefined;return row?.destination===token.destination?'sent':'unknown';}
    };
  }
  /** Proof for one fixed fixture delivery; a NULL receipt is an attempt, never absence. */
  testDeliveryEvidence(token:TestLaneToken,deliveryIds:string[]):{unattempted:boolean;knownIds:number} {
    this.validateTestToken(token);if(deliveryIds.length!==2||deliveryIds.some(id=>!id))throw new Error('invalid test repair proof');const attempted=deliveryIds.some(id=>!!this.db.prepare('SELECT 1 FROM sdk_deliveries WHERE id=?').get(id));const row=this.db.prepare('SELECT COUNT(*) AS n FROM sdk_message_routes WHERE destination=? AND message_id<>?').get(token.destination,token.rootId) as {n:number};return {unattempted:!attempted&&row.n===0,knownIds:Number(row.n)};
  }
  testDeliveryKnown(token:TestLaneToken,deliveryId:string):boolean {this.validateTestToken(token);const row=this.db.prepare('SELECT m.destination FROM sdk_deliveries d JOIN sdk_message_routes m ON m.message_id=d.message_id WHERE d.id=?').get(deliveryId) as {destination:string}|undefined;return row?.destination===token.destination;}
  closeTestTopic(token:TestLaneToken):void {this.validateTestToken(token);this.db.prepare("UPDATE sdk_lane_registry SET state='closed',generation=generation+1 WHERE destination=? AND generation=? AND state='active'").run(token.destination,token.generation);this.routeGeneration++;}
  installTestHandler(handler:TestLaneHandler):void {if(this.testHandler)throw new Error('test handler exists');this.testHandler=handler;}
  removeTestHandler(handler:TestLaneHandler):void {if(this.testHandler===handler)this.testHandler=undefined;}
  beginMigrationRollback():void { if(this.migrationLocked) throw new Error('migration lock already held'); this.db.exec('BEGIN IMMEDIATE'); this.migrationLocked=true; }
  endMigrationRollback(commit:boolean):void { if(!this.migrationLocked) throw new Error('migration lock not held'); try {this.db.exec(commit?'COMMIT':'ROLLBACK');} catch(e) {if(commit) {try {this.db.exec('ROLLBACK');} catch {}} throw e;} finally {this.migrationLocked=false;} }
  inspectMigrationRoute(id:string,destination:string):'removable'|'retained'|'absent' { if(!this.migrationLocked) throw new Error('migration lock required'); this.db.exec('SAVEPOINT migration_inspect'); try {const result=this.rollbackMigrationRoute(id); if(result==='retained' && !this.db.prepare('SELECT 1 FROM sdk_topic_routes WHERE destination=?').get(destination)) throw new Error('migration route missing despite receipt; manual review'); this.db.exec('ROLLBACK TO migration_inspect; RELEASE migration_inspect'); return result==='removed'?'removable':result==='absent' && this.db.prepare('SELECT 1 FROM sdk_topic_routes WHERE destination=?').get(destination)?'retained':result;} catch(e) {this.db.exec('ROLLBACK TO migration_inspect; RELEASE migration_inspect'); throw e;} }
  private migrationBegin():void {this.db.exec(this.migrationLocked?'SAVEPOINT migration_op':'BEGIN IMMEDIATE');}
  private migrationCommit():void {this.db.exec(this.migrationLocked?'RELEASE migration_op':'COMMIT');}
  private migrationAbort():void {this.db.exec(this.migrationLocked?'ROLLBACK TO migration_op; RELEASE migration_op':'ROLLBACK');}
  /** Only reviewed snapshot routes in an allowed chat may be installed. */
  public importMigrationRoute(id:string, record:{destination:string;chatId:string;rootId:string;threadId?:string;sessionId:string;owner:string;appId:string}):'inserted'|'already-imported' {
    this.routeGeneration++;
    if (![id,record.destination,record.chatId,record.rootId,record.sessionId,record.owner,record.appId].every(x=>typeof x==='string' && x.trim()) || record.owner!==this.owner || record.appId!==this.appId || !this.destinations.has(record.chatId)) throw new Error('migration route unauthorized');
    const digest=JSON.stringify(record); this.migrationBegin();
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS sdk_migration_receipts (id TEXT PRIMARY KEY,digest TEXT NOT NULL,destination TEXT NOT NULL)');
      const old=this.db.prepare('SELECT digest FROM sdk_migration_receipts WHERE id=?').get(id) as {digest:string}|undefined;
      const route=this.db.prepare('SELECT chat_id,root_id,thread_id,session_id FROM sdk_topic_routes WHERE destination=?').get(record.destination) as {chat_id:string;root_id:string;thread_id:string|null;session_id:string}|undefined;
      if(old) { if(old.digest!==digest || !route || route.chat_id!==record.chatId || route.root_id!==record.rootId || route.thread_id!==(record.threadId ?? null) || route.session_id!==record.sessionId) throw new Error('migration route changed'); this.migrationCommit(); return 'already-imported'; }
      if(route || this.db.prepare('SELECT 1 FROM sdk_topic_routes WHERE root_id=? OR (chat_id=? AND session_id=?)').get(record.rootId,record.chatId,record.sessionId) || this.db.prepare('SELECT 1 FROM sdk_message_routes WHERE message_id=?').get(record.rootId)) throw new Error('migration route conflict');
      this.db.prepare('INSERT INTO sdk_topic_routes VALUES (?,?,?,?,?)').run(record.destination,record.chatId,record.rootId,record.threadId ?? null,record.sessionId);
      this.db.prepare('INSERT INTO sdk_message_routes VALUES (?,?)').run(record.rootId,record.destination);
      this.db.prepare('INSERT INTO sdk_migration_receipts VALUES (?,?,?)').run(id,digest,record.destination); this.migrationCommit(); return 'inserted';
    } catch(e) { this.migrationAbort(); throw e; }
  }
  public rollbackMigrationRoute(id:string):'removed'|'retained'|'absent' {
    this.routeGeneration++;
    this.migrationBegin(); try {
      this.db.exec('CREATE TABLE IF NOT EXISTS sdk_migration_receipts (id TEXT PRIMARY KEY,digest TEXT NOT NULL,destination TEXT NOT NULL)');
      const receipt=this.db.prepare('SELECT digest,destination FROM sdk_migration_receipts WHERE id=?').get(id) as {digest:string;destination:string}|undefined;
      if(!receipt) {this.migrationCommit(); return 'absent';}
      const r=JSON.parse(receipt.digest) as {chatId:string;rootId:string;threadId?:string;sessionId:string};
      const route=this.db.prepare('SELECT chat_id,root_id,thread_id,session_id FROM sdk_topic_routes WHERE destination=?').get(receipt.destination) as {chat_id:string;root_id:string;thread_id:string|null;session_id:string}|undefined;
      const activity=this.db.prepare('SELECT 1 FROM sdk_message_routes WHERE destination=? AND message_id<>? LIMIT 1').get(receipt.destination,r.rootId) || this.db.prepare('SELECT 1 FROM sdk_inbound_resources WHERE envelope LIKE ? LIMIT 1').get(`%${receipt.destination}%`);
      if(!route || route.chat_id!==r.chatId || route.root_id!==r.rootId || route.thread_id!==(r.threadId ?? null) || route.session_id!==r.sessionId || activity) {this.migrationCommit();return 'retained';}
      this.db.prepare('DELETE FROM sdk_message_routes WHERE destination=? AND message_id=?').run(receipt.destination,r.rootId); this.db.prepare('DELETE FROM sdk_topic_routes WHERE destination=?').run(receipt.destination); this.db.prepare('DELETE FROM sdk_migration_receipts WHERE id=?').run(id); this.migrationCommit(); return 'removed';
    } catch(e) {this.migrationAbort();throw e;}
  }
  public isTopicDestination(destination:string):boolean { return !!this.route(destination); }
  public chatDestination(destination:string):string | null { return this.route(destination)?.chat_id ?? null; }
  public reassignTopic(destination:string,sessionId:string):void { this.allowed(destination); this.routeGeneration++; if (!this.route(destination)) throw new Error('topic required'); this.db.prepare('UPDATE sdk_topic_routes SET session_id=? WHERE destination=?').run(sessionId,destination); }
  private laneReserved(destination:string):boolean { return !!this.db.prepare('SELECT 1 FROM sdk_lane_registry WHERE destination=?').get(destination); }
  public authorizedDestination(destination:string):boolean {
    if (this.laneReserved(destination)) return false;
    if (this.destinations.has(destination)) return true;
    const route=this.db.prepare('SELECT chat_id FROM sdk_topic_routes WHERE destination=?').get(destination) as {chat_id:string}|undefined;
    return !!route && this.destinations.has(route.chat_id);
  }
  private allowed(destination:string):void { if(this.closing) throw new Error('SDK port closing'); if (!this.authorizedDestination(destination)) throw new Error('destination unauthorized'); }
  private allowedTaskOrProduction(destination:string):void { if(this.closing) throw new Error('SDK port closing'); if (this.taskTopicRuntimeEnabled && this.taskToken(destination)) return; if (!this.authorizedDestination(destination)) throw new Error('destination unauthorized'); }
  private route(destination:string):{chat_id:string;root_id:string}|undefined { return this.db.prepare('SELECT chat_id,root_id FROM sdk_topic_routes WHERE destination=?').get(destination) as {chat_id:string;root_id:string}|undefined; }
  public resolveDestination(chatId:string,rootId?:string,parentId?:string,threadId?:string):string {
    if (!this.destinations.has(chatId)) throw new Error('destination unauthorized');
    if (!rootId && !parentId && !threadId) return chatId;
    const candidates=[rootId,parentId,threadId].filter((v):v is string=>!!v);
    const found=new Set<string>();
    if(rootId && !this.db.prepare('SELECT 1 FROM sdk_topic_routes WHERE chat_id=? AND (root_id=? OR thread_id=?)').get(chatId,rootId,rootId)) throw new UnknownTopic('unknown topic');
    if(!rootId && threadId && !this.db.prepare('SELECT 1 FROM sdk_topic_routes WHERE chat_id=? AND (root_id=? OR thread_id=?)').get(chatId,threadId,threadId)) throw new UnknownTopic('unknown topic');
    for (const id of candidates) {
      const reserved=this.db.prepare('SELECT destination FROM sdk_lane_registry WHERE root_id=?').get(id) as {destination:string}|undefined;if(reserved) found.add(reserved.destination);
      const rows=this.db.prepare('SELECT destination FROM sdk_topic_routes WHERE chat_id=? AND (root_id=? OR thread_id=?) UNION SELECT r.destination FROM sdk_message_routes m JOIN sdk_topic_routes r ON r.destination=m.destination WHERE r.chat_id=? AND m.message_id=?').all(chatId,id,id,chatId,id) as Array<{destination:string}>;
      for (const row of rows) found.add(row.destination);
    }
    if (found.size===0) throw new UnknownTopic('unknown topic');
    if (found.size!==1) throw new Error('conflicting topic');
    const destination=[...found][0]!;if(!this.authorizedDestination(destination)){const task=this.taskToken(destination);if(task&&task.chatId===chatId)return destination;const token=this.testToken(destination);if(!this.testHandler || !token || token.chatId!==chatId)throw new UnknownTopic('test topic unavailable');}return destination;
  }
  public callbackDestination(chatId:string,messageId:string):string {
    if (!this.destinations.has(chatId)) throw new Error('destination unauthorized');
    const reservedRoot=this.db.prepare('SELECT state,lane_id FROM sdk_lane_registry WHERE root_id=?').get(messageId) as {state:string;lane_id:string}|undefined;
    if(reservedRoot?.state==='closed') {if(reservedRoot.lane_id==='task')throw new UnknownCardRoute('task topic closed');throw new ClosedTestRoute('test topic closed');}
    const row=this.db.prepare('SELECT destination FROM sdk_message_routes WHERE message_id=?').get(messageId) as {destination:string}|undefined;
    if(row){const closed=this.db.prepare("SELECT lane_id FROM sdk_lane_registry WHERE destination=? AND state='closed'").get(row.destination) as {lane_id:string}|undefined;if(closed){if(closed.lane_id==='task')throw new UnknownCardRoute('task topic closed');throw new ClosedTestRoute('test topic closed');}}
    if (!row) {if(this.db.prepare("SELECT 1 FROM sdk_task_creations_v1 WHERE chat_id=? AND state NOT IN ('active','closed','rejected') LIMIT 1").get(chatId))throw new TaskPendingRoute('task creation outcome unknown');if(this.db.prepare("SELECT 1 FROM sdk_lane_creations WHERE chat_id=? AND state IN ('unknown','known')").get(chatId))throw new UnknownTestRoute('test creation unknown');throw new UnknownCardRoute('unknown card message');}
    const task=this.taskToken(row.destination);if(task&&task.chatId===chatId&&(!reservedRoot||task.rootId===messageId))return row.destination;
    if(reservedRoot){const exact=this.testToken(row.destination);if(!exact || exact.rootId!==messageId || exact.chatId!==chatId || !this.testHandler)throw new UnknownCardRoute('test topic unavailable');}
    if(!this.authorizedDestination(row.destination)){const token=this.testToken(row.destination);if(!this.testHandler || !token || token.chatId!==chatId || (reservedRoot && token.rootId!==messageId))throw new UnknownCardRoute('test topic unavailable');}
    const route=this.route(row.destination);
    if ((route?.chat_id ?? row.destination)!==chatId) throw new UnknownCardRoute('card chat mismatch');
    return row.destination;
  }
  private remember(id:string, messageId:string|null,destination:string):void {
    const prior=messageId ? this.db.prepare('SELECT destination FROM sdk_message_routes WHERE message_id=?').get(messageId) as {destination:string}|undefined : undefined; if(prior && prior.destination!==destination) this.routeGeneration++;
    this.db.exec('BEGIN IMMEDIATE'); try { this.db.prepare('INSERT OR REPLACE INTO sdk_deliveries VALUES (?,?)').run(id,messageId); if(messageId) this.db.prepare('INSERT OR REPLACE INTO sdk_message_routes VALUES (?,?)').run(messageId,destination); this.db.exec('COMMIT'); } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async createTopic(destination:string,sessionId:string,card:ChannelCard,deliveryId:string,guard?:()=>Promise<void>):Promise<string> {
    this.allowed(destination); const chat=this.route(destination)?.chat_id ?? destination;
    const existing=this.db.prepare('SELECT destination FROM sdk_topic_routes WHERE chat_id=? AND session_id=?').get(chat,sessionId) as {destination:string}|undefined;
    if(existing) return existing.destination;
    // An uncertain root creation must never be replayed automatically.
    if (!this.db.prepare('INSERT OR IGNORE INTO sdk_deliveries VALUES (?,NULL)').run(deliveryId).changes) throw new Error('topic creation outcome unknown');
    await guard?.(); this.allowed(destination);
    const response=await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:chat,msg_type:'interactive',content:JSON.stringify(toFeishuCard(card))}});
    rejectCode(response.code); if(!response.data?.message_id) throw new Error('Feishu topic creation failed or outcome unknown');
    const root=response.data.message_id; const key=`topic:${randomUUID()}`;
    this.routeGeneration++; this.db.exec('BEGIN IMMEDIATE'); try { this.db.prepare('INSERT INTO sdk_topic_routes VALUES (?,?,?,?,?)').run(key,chat,root,response.data.thread_id ?? null,sessionId); this.db.prepare('INSERT INTO sdk_message_routes VALUES (?,?)').run(root,key); this.db.prepare('UPDATE sdk_deliveries SET message_id=? WHERE id=?').run(root,deliveryId); this.db.exec('COMMIT'); } catch(e) { this.db.exec('ROLLBACK'); throw e; }
    return key;
  }
  async send(destination:string, card:ChannelCard, deliveryId:string, guard?:()=>Promise<void>):Promise<string> {
    await guard?.(); this.allowedTaskOrProduction(destination); const route=this.route(destination); const content=JSON.stringify(toFeishuCard(card));
    const response=route ? await this.client.im.message.reply({path:{message_id:route.root_id},data:{msg_type:'interactive',content,reply_in_thread:true}}) : await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:destination,msg_type:'interactive',content}});
    rejectCode(response.code); if (!response.data?.message_id) throw new Error('Feishu message send failed or outcome unknown');
    this.remember(deliveryId,response.data.message_id,destination); return response.data.message_id;
  }
  async update(destination:string,messageId:string,card:ChannelCard,deliveryId:string,guard?:()=>Promise<void>):Promise<void> {
    await guard?.(); this.allowedTaskOrProduction(destination); if(this.callbackDestination(this.route(destination)?.chat_id ?? destination,messageId)!==destination) throw new Error('message route mismatch');
    const response = await this.client.im.message.patch({path:{message_id:messageId},data:{content:JSON.stringify(toFeishuCard(card))}});
    rejectCode(response.code); this.remember(deliveryId,messageId,destination);
  }
  async sendFile(destination:string,name:string,content:Uint8Array,deliveryId:string,guard?:()=>Promise<void>):Promise<void> {
    this.allowedTaskOrProduction(destination); await guard?.(); const uploaded = await this.client.im.file.create({data:{file_type:'stream',file_name:name,file:Buffer.from(content)}});
    if (!uploaded?.file_key) throw new Error('Feishu upload failed or outcome unknown');
    await guard?.(); this.allowedTaskOrProduction(destination); const route=this.route(destination); const body=JSON.stringify({file_key:uploaded.file_key});
    const sent=route ? await this.client.im.message.reply({path:{message_id:route.root_id},data:{msg_type:'file',content:body,reply_in_thread:true}}) : await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:destination,msg_type:'file',content:body}});
    rejectCode(sent.code); if (!sent.data?.message_id) throw new Error('Feishu file send failed or outcome unknown'); this.remember(deliveryId,sent.data.message_id,destination);
  }
  async lookupDelivery(id:string):Promise<'sent'|'unknown'> { return this.db.prepare('SELECT id FROM sdk_deliveries WHERE id=? AND message_id IS NOT NULL').get(id) ? 'sent' : 'unknown'; }
  private dataVersion():number { const row=this.db.prepare('PRAGMA data_version').get() as {data_version:number};return row.data_version; }
  /** GET is scoped to an already-registered route and revalidated after every await. */
  private async scopedMessageLink(chat:string,messageId:string,scope:string,stillCurrent:()=>boolean):Promise<string|null> {
    const generation=this.routeGeneration, version=this.dataVersion();const valid=()=>!this.closing && generation===this.routeGeneration && version===this.dataVersion() && this.destinations.has(chat) && stillCurrent();
    if(!valid())return null;const key=JSON.stringify([chat,messageId,scope,generation,version]);const cached=this.linkCache.get(key);if(cached && cached.expires>Date.now())return valid()?cached.url:null;if(cached)this.linkCache.delete(key);
    let task=this.linkFlights.get(key);if(!task) {if(this.linkFlights.size>=16)return null;task=(async()=>{let timeout:ReturnType<typeof setTimeout>|undefined;try {const response=await Promise.race([this.client.im.message.get({path:{message_id:messageId},params:{user_id_type:'open_id'}}),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('link lookup timeout')),5000);})]);if(!valid() || response.code!==0 || !Array.isArray(response.data?.items))return null;const matches=response.data.items.filter(m=>m.message_id===messageId);if(matches.length!==1)return null;const m=matches[0]!;if(m.chat_id!==chat || m.sender?.id_type!=='app_id' || !['app','bot'].includes(m.sender.sender_type) || m.sender.id!==this.appId)return null;const url=verifiedMessageAppLink(m);if(!url || !valid())return null;while(this.linkCache.size>=128)this.linkCache.delete(this.linkCache.keys().next().value!);this.linkCache.set(key,{url,expires:Date.now()+30000});return url;}catch{return null;}finally{if(timeout)clearTimeout(timeout);}})();this.linkFlights.set(key,task);}
    try {const value=await task;return !this.closing && valid()?value:null;}catch{return null;}finally{if(this.linkFlights.get(key)===task)this.linkFlights.delete(key);}
  }
  async fileMessageLink(destination:string,sessionId:string,deliveryId:string):Promise<string|null> {
    this.allowed(destination);const read=()=>this.db.prepare('SELECT d.message_id,m.destination FROM sdk_deliveries d JOIN sdk_message_routes m ON m.message_id=d.message_id WHERE d.id=?').get(deliveryId) as {message_id:string;destination:string}|undefined;
    const delivery=read();if(!delivery || delivery.destination!==destination)return null;const route=this.db.prepare('SELECT chat_id,root_id,session_id FROM sdk_topic_routes WHERE destination=?').get(destination) as {chat_id:string;root_id:string;session_id:string}|undefined;if(route && route.session_id!==sessionId)return null;const chat=route?.chat_id ?? destination;if(!this.destinations.has(chat))return null;
    const scope=JSON.stringify([destination,sessionId,deliveryId,route ?? null]);return this.scopedMessageLink(chat,delivery.message_id,scope,()=>{const now=read(),r=this.db.prepare('SELECT chat_id,root_id,session_id FROM sdk_topic_routes WHERE destination=?').get(destination) as typeof route;return !!now && now.message_id===delivery.message_id && now.destination===destination && JSON.stringify(r ?? null)===JSON.stringify(route ?? null);});
  }
  async lookupMessageId(id:string):Promise<string|null> { return (this.db.prepare('SELECT message_id FROM sdk_deliveries WHERE id=?').get(id) as {message_id:string|null}|undefined)?.message_id ?? null; }
  async topicLinkForSession(destination:string,sessionId:string):Promise<string|null> {
    this.allowed(destination);const source=this.route(destination),chat=source?.chat_id ?? destination;const read=()=>this.db.prepare('SELECT destination,chat_id,root_id,session_id FROM sdk_topic_routes WHERE chat_id=? AND session_id=?').get(chat,sessionId) as {destination:string;chat_id:string;root_id:string;session_id:string}|undefined;const row=read();if(!row)return null;this.allowed(row.destination);const scope=JSON.stringify([destination,sessionId,source ?? null,row]);return this.scopedMessageLink(chat,row.root_id,scope,()=>{const now=read();return JSON.stringify(now ?? null)===JSON.stringify(row) && JSON.stringify(this.route(destination) ?? null)===JSON.stringify(source ?? null) && this.authorizedDestination(row.destination);});
  }
  private async dispatchLane(e:TrustedEnvelope,a:RuntimeTrustedAction,production:(e:TrustedEnvelope,a:ChannelAction)=>Promise<unknown>):Promise<unknown>{const task=this.taskToken(e.destination);if(task){if(!this.taskTopicRuntimeEnabled)return this.handleTask(e,task);if(e.identity.source!=='feishu'||e.identity.subject!==this.owner)throw Error('task topic unavailable');return production(e,a as ChannelAction);}const token=this.testToken(e.destination);if(token){const handler=this.testHandler;if(!handler)throw new Error('test lane unavailable');this.validateTestToken(token);return handler.handle(e,a as ChannelAction,token);}this.allowed(e.destination);return production(e,a as ChannelAction);}
  private queueTestResource(e:TrustedEnvelope,messageId:string,key:string,type:'image'|'file',scope:string,token:TestLaneToken,metadata?:ResourceMetadata):void {
    if(token.laneId==='mock-test'&&type==='file'&&(metadata?.name!==undefined||metadata?.mime!==undefined)){this.queueTextResource(e,messageId,key,scope,metadata,token);return;}
    this.validateTestToken(token);if(e.destination!==token.destination || e.identity.source!=='feishu' || e.identity.subject!==token.owner)throw new Error('test resource unauthorized');
    const old=this.db.prepare('SELECT envelope,message_id,resource_key,resource_type FROM sdk_inbound_resources WHERE event_id=?').get(e.eventId) as {envelope:string;message_id:string;resource_key:string;resource_type:string}|undefined;const serialized=JSON.stringify(e),encoded=JSON.stringify(token);
    if(old){const prior=this.db.prepare('SELECT token FROM sdk_lane_resource_tokens WHERE event_id=?').get(e.eventId) as {token:string}|undefined;const priorScope=this.db.prepare('SELECT scope FROM sdk_resource_scopes WHERE event_id=?').get(e.eventId) as {scope:string}|undefined;if(old.envelope!==serialized||old.message_id!==messageId||old.resource_key!==key||old.resource_type!==type||prior?.token!==encoded||priorScope?.scope!==scope)throw new Error('test resource conflict');return;}
    this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO sdk_inbound_resources VALUES (?,?,?,?,?)').run(e.eventId,serialized,messageId,key,type);this.db.prepare('INSERT INTO sdk_resource_scopes VALUES (?,?)').run(e.eventId,scope);this.db.prepare('INSERT INTO sdk_lane_resource_tokens VALUES (?,?)').run(e.eventId,encoded);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async drainTestResources(handle:(e:TrustedEnvelope,a:ChannelAction,scope:string,token:TestLaneToken)=>Promise<unknown>):Promise<void> {
    await this.drainTextInbound((e,a,scope,token)=>{if(!scope||!token)throw new Error('test scope missing');return handle(e,a,scope,token)},true);
    const rows=this.db.prepare("SELECT r.*,l.token,s.scope FROM sdk_inbound_resources r JOIN sdk_lane_resource_tokens l ON l.event_id=r.event_id JOIN sdk_resource_scopes s ON s.event_id=r.event_id LEFT JOIN sdk_resource_failures f ON f.event_id=r.event_id WHERE f.event_id IS NULL OR (f.state='retry' AND f.next_attempt<=?) ORDER BY r.rowid LIMIT 8").all(Date.now()) as Array<{event_id:string;envelope:string;message_id:string;resource_key:string;resource_type:'image'|'file';token:string;scope:string}>;
    for(const row of rows){if(this.testResourceFlights.has(row.event_id) || this.testResourceFlights.size>=8)continue;let active=true;let timer:ReturnType<typeof setTimeout>|undefined;try{const e=JSON.parse(row.envelope) as TrustedEnvelope,token=JSON.parse(row.token) as TestLaneToken;const check=()=>{if(!active)throw new ResourceRejected('test request expired');this.validateTestToken(token);};check();if(e.destination!==token.destination||e.identity.source!=='feishu'||e.identity.subject!==token.owner)throw new ResourceRejected('test scope changed');const flight=downloadAndIntake(e,row.message_id,row.resource_key,row.resource_type,async (id,key,type)=>{check();const response=await this.client.im.messageResource.get({params:{type},path:{message_id:id,file_key:key}});check();return response.getReadableStream();},async (env,action)=>{check();return handle(env,action,row.scope,token);},row.scope);this.testResourceFlights.set(row.event_id,flight);void flight.finally(()=>{if(this.testResourceFlights.get(row.event_id)===flight)this.testResourceFlights.delete(row.event_id);}).catch(()=>{});await Promise.race([flight,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('test resource timeout')),2000);})]);check();this.db.exec('BEGIN IMMEDIATE');try{for(const table of ['sdk_inbound_resources','sdk_resource_scopes','sdk_resource_failures','sdk_lane_resource_tokens'])this.db.prepare(`DELETE FROM ${table} WHERE event_id=?`).run(row.event_id);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}catch{this.db.prepare("INSERT OR REPLACE INTO sdk_resource_failures VALUES (?, 'needs_review', 1, 'test resource unavailable or scope changed', 0)").run(row.event_id);}finally{active=false;if(timer)clearTimeout(timer);}}

  }
  private queueResource(e:TrustedEnvelope,messageId:string,key:string,type:'image'|'file',scope:string,metadata?:ResourceMetadata):void {
    if(type==='file'&&(metadata?.name!==undefined||metadata?.mime!==undefined)){this.allowedTaskOrProduction(e.destination);this.queueTextResource(e,messageId,key,scope,metadata);return;}
    this.allowedTaskOrProduction(e.destination); const serialized=JSON.stringify(e); const old=this.db.prepare('SELECT envelope,message_id,resource_key,resource_type FROM sdk_inbound_resources WHERE event_id=?').get(e.eventId) as {envelope:string;message_id:string;resource_key:string;resource_type:string}|undefined;
    if(old) { const oldScope=this.db.prepare('SELECT scope FROM sdk_resource_scopes WHERE event_id=?').get(e.eventId) as {scope:string}|undefined; if(old.envelope!==serialized || old.message_id!==messageId || old.resource_key!==key || old.resource_type!==type || oldScope?.scope!==scope) throw new Error('resource event conflict'); return; }
    this.db.exec('BEGIN IMMEDIATE'); try { this.db.prepare('INSERT INTO sdk_inbound_resources VALUES (?,?,?,?,?)').run(e.eventId,serialized,messageId,key,type); this.db.prepare('INSERT INTO sdk_resource_scopes VALUES (?,?)').run(e.eventId,scope); this.db.exec('COMMIT'); } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private queueTextResource(e:TrustedEnvelope,messageId:string,key:string,scope:string,metadata:ResourceMetadata,token?:TestLaneToken):void {
    if(token){this.validateTestToken(token);if(token.laneId!=='mock-test'||token.destination!==e.destination||e.identity.source!=='feishu'||e.identity.subject!==token.owner)throw new Error('test resource unauthorized');}
    const envelope=JSON.stringify(e),meta=JSON.stringify(metadata),encoded=token?JSON.stringify(token):null;const old=this.db.prepare('SELECT envelope,message_id,resource_key,metadata,scope FROM sdk_text_resources_v1 WHERE event_id=?').get(e.eventId) as {envelope:string;message_id:string;resource_key:string;metadata:string;scope:string}|undefined;const prior=this.db.prepare('SELECT token FROM sdk_text_resource_tokens_v1 WHERE event_id=?').get(e.eventId) as {token:string}|undefined;if(old){if(old.envelope!==envelope||old.message_id!==messageId||old.resource_key!==key||old.metadata!==meta||old.scope!==scope||(prior?.token??null)!==encoded)throw new Error('resource event conflict');return;}
    this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("INSERT INTO sdk_text_resources_v1 VALUES (?,?,?,?,?,?,'pending',0,NULL,0)").run(e.eventId,envelope,messageId,key,meta,scope);if(encoded)this.db.prepare('INSERT INTO sdk_text_resource_tokens_v1 VALUES (?,?)').run(e.eventId,encoded);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Safe, sanitized inspection; no resource keys, paths or downloaded content. */
  resourceIssues(): Array<{eventId:string;state:string;attempts:number;reason:string}> {
    const old=this.db.prepare('SELECT event_id AS eventId,state,attempts,reason FROM sdk_resource_failures ORDER BY rowid').all() as Array<{eventId:string;state:string;attempts:number;reason:string}>;const text=this.db.prepare("SELECT event_id AS eventId,state,attempts,COALESCE(reason,'resource pending') AS reason FROM sdk_text_resources_v1 WHERE state<>'completed' ORDER BY rowid").all() as Array<{eventId:string;state:string;attempts:number;reason:string}>;return [...old,...text];
  }
  onResourceHealth:(status:'healthy'|'degraded',reason:string|null)=>void=()=>{};
  /** GET may safely repeat; per-item failures are persisted and never block later work. */
  async drainInbound(handle:(envelope:TrustedEnvelope,action:ChannelAction,scope?:string)=>Promise<unknown>):Promise<void> {
    await this.drainTextInbound(handle);
    const rows=this.db.prepare("SELECT r.* FROM sdk_inbound_resources r LEFT JOIN sdk_resource_failures f ON f.event_id=r.event_id WHERE NOT EXISTS (SELECT 1 FROM sdk_lane_resource_tokens l WHERE l.event_id=r.event_id) AND (f.event_id IS NULL OR (f.state='retry' AND f.next_attempt<=?)) ORDER BY r.rowid").all(Date.now()) as Array<{event_id:string;envelope:string;message_id:string;resource_key:string;resource_type:'image'|'file'}>;
    for(const row of rows) {
      try {
        const e=JSON.parse(row.envelope) as TrustedEnvelope; this.allowedTaskOrProduction(e.destination); if(e.identity.source!=='feishu' || e.identity.subject!==this.owner) throw new ResourceRejected('authorization changed');
        const saved=this.db.prepare('SELECT scope FROM sdk_resource_scopes WHERE event_id=?').get(row.event_id) as {scope:string}|undefined; if (!saved) throw new ResourceRejected('resource missing binding scope');
        await downloadAndIntake(e,row.message_id,row.resource_key,row.resource_type,async (messageId,key,type)=>{this.allowedTaskOrProduction(e.destination);return (await this.client.im.messageResource.get({params:{type},path:{message_id:messageId,file_key:key}})).getReadableStream();},async (envelope,action,scope)=>{this.allowedTaskOrProduction(envelope.destination);return handle(envelope,action,scope);},saved.scope);
        this.db.exec('BEGIN IMMEDIATE'); try { this.db.prepare('DELETE FROM sdk_inbound_resources WHERE event_id=?').run(row.event_id); this.db.prepare('DELETE FROM sdk_resource_failures WHERE event_id=?').run(row.event_id); this.db.prepare('DELETE FROM sdk_resource_scopes WHERE event_id=?').run(row.event_id); this.db.exec('COMMIT'); } catch(error) { this.db.exec('ROLLBACK'); throw error; }
        try {this.onResourceHealth('healthy',null);} catch {}
      } catch(error) {
        const previous=this.db.prepare('SELECT attempts FROM sdk_resource_failures WHERE event_id=?').get(row.event_id) as {attempts:number}|undefined;
        const attempts=(previous?.attempts ?? 0)+1; const permanent=error instanceof ResourceRejected;
        const state=permanent?'rejected':attempts>=3?'needs_review':'retry';
        const reason=permanent ? error.message : 'resource download or intake failed; outcome requires checking';
        this.db.prepare('INSERT OR REPLACE INTO sdk_resource_failures VALUES (?,?,?,?,?)').run(row.event_id,state,attempts,reason,Date.now()+Math.min(30000,1000*2**(attempts-1)));try {this.onResourceHealth('degraded',permanent?'资源不符合接收条件':'资源读取或入库待核对');} catch {}
      }
    }
  }
  private async drainTextInbound(handle:(envelope:TrustedEnvelope,action:ChannelAction,scope?:string,token?:TestLaneToken)=>Promise<unknown>,test=false):Promise<void> {
    const rows=this.db.prepare(`SELECT r.*,t.token FROM sdk_text_resources_v1 r LEFT JOIN sdk_text_resource_tokens_v1 t ON t.event_id=r.event_id WHERE r.state IN ('pending','retry','reject_pending') AND r.next_attempt<=? AND t.event_id IS ${test?'NOT ':''}NULL ORDER BY r.rowid LIMIT 8`).all(Date.now()) as Array<{event_id:string;envelope:string;message_id:string;resource_key:string;metadata:string;scope:string;state:string;attempts:number;reason:string|null;token:string|null}>;
    for(const row of rows){if(test&&(this.testResourceFlights.has(row.event_id)||this.testResourceFlights.size>=8))continue;const e=JSON.parse(row.envelope) as TrustedEnvelope;let active=true;let timer:ReturnType<typeof setTimeout>|undefined;try{const token=row.token?JSON.parse(row.token) as TestLaneToken:undefined;const handler=this.testHandler;const check=()=>{if(!active)throw new ResourceRejected('unauthorized');if(test){if(!token||!handler||this.testHandler!==handler||token.laneId!=='mock-test')throw new ResourceRejected('unauthorized');this.validateTestToken(token);if(token.destination!==e.destination||token.owner!==e.identity.subject)throw new ResourceRejected('unauthorized');}else this.allowedTaskOrProduction(e.destination);if(e.identity.source!=='feishu'||e.identity.subject!==this.owner)throw new ResourceRejected('unauthorized');};check();const dispatch=async(env:TrustedEnvelope,action:ChannelAction)=>{check();return handle(env,action,row.scope,token)};if(row.state==='reject_pending'){if(!['size','encoding','unsupported'].includes(row.reason??''))throw new ResourceRejected('unauthorized');await dispatch({...e,eventId:`${e.eventId}:rejected`},{action:'resource_rejected',reason:row.reason as 'size'|'encoding'|'unsupported'});check();this.db.prepare("UPDATE sdk_text_resources_v1 SET state='rejected' WHERE event_id=? AND state='reject_pending'").run(row.event_id);continue;}const metadata=JSON.parse(row.metadata) as ResourceMetadata;const flight=downloadAndIntake(e,row.message_id,row.resource_key,'file',async(id,key,type)=>{check();const response=await this.client.im.messageResource.get({params:{type},path:{message_id:id,file_key:key}});check();return response.getReadableStream()},async(env,action)=>dispatch(env,action),row.scope,metadata);if(test){this.testResourceFlights.set(row.event_id,flight);void flight.finally(()=>{if(this.testResourceFlights.get(row.event_id)===flight)this.testResourceFlights.delete(row.event_id)}).catch(()=>{});await Promise.race([flight,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('test resource timeout')),2000)})]);}else await flight;check();this.db.prepare("UPDATE sdk_text_resources_v1 SET state='completed' WHERE event_id=? AND state IN ('pending','retry')").run(row.event_id);}catch(error){const permanent=error instanceof ResourceRejected,reason=permanent&&['size','encoding','unsupported','unauthorized'].includes(error.message)?error.message:'unsupported',attempts=row.attempts+1;const state=permanent?(reason==='unauthorized'?'rejected':'reject_pending'):row.state==='reject_pending'?'reject_pending':attempts>=3?'needs_review':'retry';this.db.prepare("UPDATE sdk_text_resources_v1 SET state=?,attempts=?,reason=?,next_attempt=? WHERE event_id=?").run(state,attempts,row.state==='reject_pending'?row.reason:permanent?reason:'resource unavailable',Date.now()+Math.min(30000,1000*2**(attempts-1)),row.event_id);if(permanent&&reason!=='unauthorized')try{const token=row.token?JSON.parse(row.token) as TestLaneToken:undefined;if(test){if(!token||!this.testHandler||token.laneId!=='mock-test')throw Error('test unavailable');this.validateTestToken(token);}else this.allowedTaskOrProduction(e.destination);await handle({...e,eventId:`${e.eventId}:rejected`},{action:'resource_rejected',reason:reason as 'size'|'encoding'|'unsupported'},row.scope,token);this.db.prepare("UPDATE sdk_text_resources_v1 SET state='rejected' WHERE event_id=? AND state='reject_pending'").run(row.event_id);}catch{}try{this.onResourceHealth('degraded',permanent?'附件不符合接收条件':'资源读取或入库待核对')}catch{}}finally{active=false;if(timer)clearTimeout(timer);}}
  }
  private parseEligibleMessage(data:MessageEvent,botId:string):{m:NonNullable<ReturnType<typeof parseIncoming>>;thread:string|undefined;inTopic:boolean;isMainSlash:boolean}|null {
    const m=parseIncoming(data,botId);if(!m||m.senderOpenId!==this.owner||!this.destinations.has(m.chatId))return null;
    const thread=(data.message as unknown as {thread_id?:string}).thread_id;
    const inTopic=Boolean(m.rootId||m.parentId||thread);
    const isMainSlash=!inTopic && data.message.message_type==='text' && Boolean(m.text?.trim().startsWith('/'));
    if(!m.mentionedBot&&!inTopic&&!isMainSlash)return null;
    return {m,thread,inTopic,isMainSlash};
  }
  private rootlessTaskWritePending(data:MessageEvent,botId:string):boolean {const info=this.parseEligibleMessage(data,botId);if(!info||info.inTopic)return false;if(data.message.message_type==='text'&&['/help','/health','/sessions'].includes(info.m.text))return false;return !!this.db.prepare("SELECT 1 FROM sdk_task_creations_v1 WHERE chat_id=? AND state NOT IN ('active','closed','rejected') LIMIT 1").get(info.m.chatId);}
  /** Block only ambiguous writes while a task root creation has no resolved route. */
  private async guideTaskPending(data:MessageEvent,botId:string,unknownRoot=false):Promise<boolean> {
    const info=this.parseEligibleMessage(data,botId);if(!info)return false;
    const {m,thread}=info;
    if(!this.db.prepare("SELECT 1 FROM sdk_task_creations_v1 WHERE chat_id=? AND state NOT IN ('active','closed','rejected') LIMIT 1").get(m.chatId))return false;
    const ids=[m.rootId,m.parentId,thread].filter((v):v is string=>!!v),hasRoot=ids.length>0;if(hasRoot&&!unknownRoot)return false;if(hasRoot&&ids.some(id=>!!this.db.prepare('SELECT 1 FROM sdk_topic_routes r LEFT JOIN sdk_message_routes m ON m.destination=r.destination WHERE r.chat_id=? AND (r.root_id=? OR r.thread_id=? OR m.message_id=?) LIMIT 1').get(m.chatId,id,id,id)))return false;
    if(!hasRoot&&data.message.message_type==='text'&&['/help','/health','/sessions'].includes(m.text))return false;
    const id=`task-pending-guidance:${m.messageId}`;if(!this.db.prepare('INSERT OR IGNORE INTO sdk_deliveries VALUES (?,NULL)').run(id).changes)return true;if(this.closing)throw new Error('SDK port closing');
    if(!this.db.prepare("SELECT 1 FROM sdk_task_creations_v1 WHERE chat_id=? AND state NOT IN ('active','closed','rejected') LIMIT 1").get(m.chatId))return true;
    const response=await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:m.chatId,msg_type:'interactive',content:JSON.stringify(toFeishuCard({title:'任务提示',text:'任务话题待核查，写入暂不可用。',actions:[]}))}});rejectCode(response.code);if(!response.data?.message_id)throw new Error('guidance outcome unknown');this.remember(id,response.data.message_id,m.chatId);return true;
  }
  private async guideTestUnavailable(data:MessageEvent,botId:string):Promise<boolean>{
    const info=this.parseEligibleMessage(data,botId);if(!info)return false;const {m,thread}=info;const ids=[m.rootId,m.parentId,thread].filter((x):x is string=>!!x);if(!ids.length)return false;
    const task=ids.some(id=>!!this.db.prepare("SELECT 1 FROM sdk_lane_registry l JOIN sdk_topic_routes r ON r.destination=l.destination LEFT JOIN sdk_message_routes m ON m.destination=l.destination WHERE l.chat_id=? AND l.lane_id='task' AND (l.root_id=? OR r.thread_id=? OR m.message_id=?) LIMIT 1").get(m.chatId,id,id,id));if(task)return false;const closed=ids.some(id=>!!this.db.prepare("SELECT 1 FROM sdk_lane_registry l JOIN sdk_topic_routes r ON r.destination=l.destination LEFT JOIN sdk_message_routes m ON m.destination=l.destination WHERE l.chat_id=? AND l.lane_id IN ('mock-test','native-test') AND l.state='closed' AND (l.root_id=? OR r.thread_id=? OR m.message_id=?) LIMIT 1").get(m.chatId,id,id,id));const taskPending=!!this.db.prepare("SELECT 1 FROM sdk_task_creations_v1 WHERE chat_id=? AND state NOT IN ('active','closed','rejected') LIMIT 1").get(m.chatId);const unknown=!!this.db.prepare("SELECT 1 FROM sdk_lane_creations WHERE chat_id=? AND state IN ('unknown','known')").get(m.chatId);if(!closed&&(taskPending||!unknown))return false;
    const deliveryId=`test-guidance:${m.messageId}`;if(!this.db.prepare('INSERT OR IGNORE INTO sdk_deliveries VALUES (?,NULL)').run(deliveryId).changes)return true;if(this.closing)throw new Error('SDK port closing');const text=closed?'此测试话题已关闭。':'测试话题创建结果待核查，请联系管理员。';const response=await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:m.chatId,msg_type:'interactive',content:JSON.stringify(toFeishuCard({title:'测试提示',text,actions:[]}))}});rejectCode(response.code);if(!response.data?.message_id)throw new Error('guidance outcome unknown');this.remember(deliveryId,response.data.message_id,m.chatId);return true;
  }
  async start(handle:(envelope:TrustedEnvelope,action:ChannelAction)=>Promise<unknown>, captureScope:(e:TrustedEnvelope)=>Promise<string>):Promise<void> {
    if (this.started || this.closing) throw new Error('already started or closing'); this.started = true;
    try {
    const bot = await this.client.request<{bot?:{open_id?:string}}>({url:'/open-apis/bot/v3/info',method:'GET'});
    if (this.closing) throw new Error('SDK port closing');
    const botId = bot.bot?.open_id;
    if (!botId) throw new Error('bot identity unavailable');
    const handles: Partial<Lark.EventHandles> & {'card.action.trigger':(data:Lark.RawCardActionEvent)=>Promise<any>} = {
      'im.message.receive_v1': async data => { try {if(await this.guideTaskPending(data,botId))return;await receiveSdkMessage(data,botId,this.owner,this.destinations,async (messageId,key,type) => (await this.client.im.messageResource.get({params:{type},path:{message_id:messageId,file_key:key}})).getReadableStream(),async (e,a)=>{if(await this.guideTaskPending(data,botId))return;if(this.rootlessTaskWritePending(data,botId))return this.guideTaskPending(data,botId);return this.dispatchLane(e,a,handle);},async (e,id,key,type,metadata)=>{if(await this.guideTaskPending(data,botId))return;const task=this.taskToken(e.destination);if(task){if(e.identity.source!=='feishu'||e.identity.subject!==this.owner)throw Error('task topic unauthorized');if(!this.taskTopicRuntimeEnabled){this.taskStore.holdResource(task,e,e.eventId,id,key,type,metadata);await this.handleTask(e,task);return;}const scope=await captureScope(e);if(await this.guideTaskPending(data,botId))return;this.queueResource(e,id,key,type,scope,metadata);return;}const token=this.testToken(e.destination);if(token){const handler=this.testHandler;if(!handler)throw new Error('test lane unavailable');this.validateTestToken(token);const scope=await handler.capture(e,token);if(this.testHandler!==handler)throw new Error('test lane unavailable');this.validateTestToken(token);this.queueTestResource(e,id,key,type,scope,token,metadata);}else{const scope=await captureScope(e);if(await this.guideTaskPending(data,botId))return;if(this.rootlessTaskWritePending(data,botId)){await this.guideTaskPending(data,botId);return;}this.queueResource(e,id,key,type,scope,metadata);}},(chat,root,parent,thread)=>this.resolveDestination(chat,root,parent,thread));}catch(error){if(error instanceof UnknownTopic && await this.guideTaskPending(data,botId,true))return;if(error instanceof UnknownTopic && await this.guideTestUnavailable(data,botId))return;throw error;} },
      'card.action.trigger': async data => {
        const work = handleSdkCardCallback<RuntimeTrustedAction>(data,this.owner,this.destinations,(chat,message)=>this.callbackDestination(chat,message),(e,a)=>this.dispatchLane(e,a,handle));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<{toast:{type:'info';content:string}}>(resolve => {
          timer = setTimeout(() => resolve({toast:{type:'info',content:'正在处理…'}}), 1500);
        });
        try {
          return await Promise.race([work, timeout]);
        } finally {
          if (timer) clearTimeout(timer);
          void work.catch(() => {});
        }
      },
    };
    if (this.closing) throw new Error('SDK port closing');
    await this.ws.start({eventDispatcher:new Lark.EventDispatcher({}).register(handles)});
    if (this.closing) {this.ws.close();throw new Error('SDK port closing');}
    } catch(error) { this.stopReceiving(); throw error; }
  }
  stopReceiving():void { if(this.closing)return;this.closing=true; this.linkCache.clear(); this.ws.close(); }
  close():void { this.stopReceiving();this.closeRequested=true;if (!this.dbClosed && !this.testCreates.size) {this.dbClosed=true; this.db.close();} }
}
