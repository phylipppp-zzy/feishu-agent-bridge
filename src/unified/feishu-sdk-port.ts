import { verifiedMessageAppLink } from './feishu-message-link.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import { parseIncoming, parseCardAction } from '../feishu.js';
import { toFeishuCard, parseFeishuAction, parseFeishuText } from './feishu-codec.js';
import type { ChannelAction, FeishuPort, TrustedEnvelope } from './feishu-channel.js';
import type { ChannelCard } from './feishu-cards.js';
import { imageMediaType } from '../image-media.js';
import type { Readable } from 'node:stream';

class ResourceRejected extends Error {}
class FeishuApiRejected extends Error { readonly deliveryKind='api_rejected'; constructor(readonly platformCode:number) {super('Feishu API rejected request');} }
function rejectCode(code:unknown):void {if(typeof code==='number' && Number.isSafeInteger(code) && code!==0) throw new FeishuApiRejected(code);}
class UnknownTopic extends Error {}
class UnknownCardRoute extends Error {}
class ClosedTestRoute extends Error {}
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;
type MessageEvent = Parameters<NonNullable<Lark.EventHandles['im.message.receive_v1']>>[0];
/** Only call with an SDK authenticated WS event, never an HTTP body. */
export async function receiveSdkMessage(data:MessageEvent, botId:string, owner:string, destinations:ReadonlySet<string>, download:(messageId:string,key:string,type:'image'|'file')=>Promise<Readable>, handle:(e:TrustedEnvelope,a:ChannelAction)=>Promise<unknown>, queueResource?:(e:TrustedEnvelope,messageId:string,key:string,type:'image'|'file')=>void|Promise<void>, resolveDestination?:(chatId:string,rootId?:string,parentId?:string,threadId?:string)=>string):Promise<void> {
  const m=parseIncoming(data,botId); if (!m || !m.mentionedBot) return;
  if (m.senderOpenId !== owner || !destinations.has(m.chatId)) throw new Error('unauthorized');
  let textAction:ChannelAction | undefined;
  if (data.message.message_type === 'text' && m.text) { try { textAction=parseFeishuText(m.text); } catch (error) { if (!m.text.startsWith('/')) throw error; textAction={action:'help'}; } }
  const destination=resolveDestination ? resolveDestination(m.chatId,m.rootId,m.parentId,(data.message as unknown as {thread_id?:string}).thread_id) : m.chatId;
  const envelope={eventId:`message:${m.messageId}`,destination,identity:{source:'feishu',subject:m.senderOpenId}};
  if (textAction) { await handle(envelope,textAction); return; }
  if (data.message.message_type !== 'image' && data.message.message_type !== 'file') throw new Error('unsupported inbound message type');
  let body:unknown; try { body=JSON.parse(data.message.content); } catch { throw new Error('invalid resource message'); }
  if (!body || typeof body !== 'object') throw new Error('invalid resource message');
  const resourceType=data.message.message_type; const key=(body as Record<string,unknown>)[resourceType === 'image' ? 'image_key' : 'file_key'];
  if (typeof key !== 'string' || !key || !m.messageId) throw new Error('invalid resource key');
  if (queueResource) { await queueResource(envelope,m.messageId,key,resourceType); return; }
  await downloadAndIntake(envelope,m.messageId,key,resourceType,download,handle);
}
async function downloadAndIntake(envelope:TrustedEnvelope,messageId:string,key:string,resourceType:'image'|'file',download:(messageId:string,key:string,type:'image'|'file')=>Promise<Readable>,handle:(e:TrustedEnvelope,a:ChannelAction,scope?:string)=>Promise<unknown>,scope?:string):Promise<void> {
  const stream=await download(messageId,key,resourceType); const chunks:Buffer[]=[]; let length=0;
  try { for await (const part of stream) { const chunk=Buffer.isBuffer(part) ? part : Buffer.from(part); length+=chunk.length; if(length>MAX_INBOUND_BYTES) throw new ResourceRejected('inbound resource exceeds limit'); chunks.push(chunk); } } finally { if (!stream.destroyed) stream.destroy(); }
  const content=Buffer.concat(chunks); const mediaType=imageMediaType(content); if (!mediaType) throw new ResourceRejected('unsupported resource type');
  const ext={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'}[mediaType];
  await handle(envelope,{action:'attachment',name:`image.${ext}`,mediaType,content,mode:'new'},scope);
}

/** Extract callback only from a verified SDK WS event; form values are persisted as input, never identity. */
export function parseSdkCardCallback(data:Lark.RawCardActionEvent, owner:string, resolve:(chatId:string,messageId:string)=>string): {envelope:TrustedEnvelope;action:ChannelAction} | null {
  const a=parseCardAction(data); if (!a || !a.eventId) return null;
  if (a.openId !== owner) throw new Error('unauthorized');
  return {envelope:{eventId:`card:${a.eventId}`,destination:resolve(a.chatId,a.openMessageId),identity:{source:'feishu',subject:a.openId}},action:parseFeishuAction(a.value,a.formValues)};
}
/** Old or malformed cards are guidance only; their untrusted values never reach the channel. */
export async function handleSdkCardCallback(data:Lark.RawCardActionEvent, owner:string, destinations:ReadonlySet<string>, resolve:(chatId:string,messageId:string)=>string, handle:(e:TrustedEnvelope,a:ChannelAction)=>Promise<unknown>):Promise<{toast:{type:'info';content:string}} | undefined> {
  const a=parseCardAction(data); if (!a || !a.eventId) return undefined;
  if (a.openId !== owner || !destinations.has(a.chatId)) throw new Error('unauthorized');
  let action:ChannelAction;
  try { action=parseFeishuAction(a.value,a.formValues); } catch { return {toast:{type:'info',content:'旧卡或卡片操作已失效，请发送 /sessions 重新选择会话。'}}; }
  let destination:string; try {destination=resolve(a.chatId,a.openMessageId);} catch(error) {return error instanceof ClosedTestRoute ? {toast:{type:'info',content:'此测试话题已关闭。'}} : error instanceof UnknownCardRoute ? {toast:{type:'info',content:'卡片已失效，请发送 /sessions 重新选择会话。'}} : {toast:{type:'info',content:'暂时无法处理卡片，请稍后查看会话状态。'}};}
  const envelope:TrustedEnvelope={eventId:`card:${a.eventId}`,destination,identity:{source:'feishu',subject:a.openId}};
  try {await handle(envelope,action);} catch {return {toast:{type:'info',content:'操作状态未确认，请查看会话状态后再操作。'}};} return undefined;
}
/** Only the SDK WS dispatcher invokes the inbound handler. Credentials are explicitly injected. */
export class FeishuSdkPort implements FeishuPort {
  private readonly client: Lark.Client;
  private readonly appId:string;
  private readonly ws: Lark.WSClient;
  private readonly db: DatabaseSync;
  private migrationLocked=false;
  private started = false;
  private closing = false;
  private routeGeneration=0;
  private readonly linkCache=new Map<string,{url:string;expires:number}>();
  private readonly linkFlights=new Map<string,Promise<string|null>>();
  private dbClosed = false;
  constructor(credentials: {appId:string; appSecret:string}, dbPath:string, private readonly destinations: ReadonlySet<string>, private readonly owner:string) {
    if (!credentials.appId || !credentials.appSecret || !destinations.size || !owner) throw new Error('missing SDK configuration');
    this.appId=credentials.appId;
    const base = { appId: credentials.appId, appSecret: credentials.appSecret, appType:Lark.AppType.SelfBuild, domain:Lark.Domain.Feishu };
    this.client = new Lark.Client(base); this.ws = new Lark.WSClient({...base, loggerLevel:Lark.LoggerLevel.error});
    this.db = new DatabaseSync(dbPath); this.db.exec('CREATE TABLE IF NOT EXISTS sdk_lane_registry (root_id TEXT PRIMARY KEY, destination TEXT NOT NULL UNIQUE, app_id TEXT NOT NULL, chat_id TEXT NOT NULL, owner TEXT NOT NULL, lane_id TEXT NOT NULL, namespace TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, operation_id TEXT NOT NULL, delivery_id TEXT NOT NULL, created_at INTEGER NOT NULL)'); this.db.exec('CREATE TABLE IF NOT EXISTS sdk_topic_routes (destination TEXT PRIMARY KEY, chat_id TEXT NOT NULL, root_id TEXT NOT NULL UNIQUE, thread_id TEXT, session_id TEXT NOT NULL, UNIQUE(chat_id,session_id)); CREATE TABLE IF NOT EXISTS sdk_message_routes (message_id TEXT PRIMARY KEY, destination TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sdk_deliveries (id TEXT PRIMARY KEY, message_id TEXT); CREATE TABLE IF NOT EXISTS sdk_inbound_resources (event_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, message_id TEXT NOT NULL, resource_key TEXT NOT NULL, resource_type TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sdk_resource_scopes (event_id TEXT PRIMARY KEY, scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sdk_resource_failures (event_id TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL, reason TEXT NOT NULL, next_attempt INTEGER NOT NULL)');
  }
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
  public reassignTopic(destination:string,sessionId:string):void { this.allowed(destination); this.routeGeneration++; if (!this.route(destination)) throw new Error('topic required'); this.db.prepare('UPDATE sdk_topic_routes SET session_id=? WHERE destination=?').run(sessionId,destination); }
  private laneReserved(destination:string):boolean { return !!this.db.prepare('SELECT 1 FROM sdk_lane_registry WHERE destination=?').get(destination); }
  public authorizedDestination(destination:string):boolean {
    if (this.laneReserved(destination)) return false;
    if (this.destinations.has(destination)) return true;
    const route=this.db.prepare('SELECT chat_id FROM sdk_topic_routes WHERE destination=?').get(destination) as {chat_id:string}|undefined;
    return !!route && this.destinations.has(route.chat_id);
  }
  private allowed(destination:string):void { if(this.closing) throw new Error('SDK port closing'); if (!this.authorizedDestination(destination)) throw new Error('destination unauthorized'); }
  private route(destination:string):{chat_id:string;root_id:string}|undefined { return this.db.prepare('SELECT chat_id,root_id FROM sdk_topic_routes WHERE destination=?').get(destination) as {chat_id:string;root_id:string}|undefined; }
  public resolveDestination(chatId:string,rootId?:string,parentId?:string,threadId?:string):string {
    if (!this.destinations.has(chatId)) throw new Error('destination unauthorized');
    if (!rootId && !parentId && !threadId) return chatId;
    const candidates=[rootId,parentId,threadId].filter((v):v is string=>!!v);
    for(const id of candidates) if(this.db.prepare('SELECT 1 FROM sdk_lane_registry WHERE root_id=?').get(id)) throw new UnknownTopic('test topic unavailable');
    const found=new Set<string>();
    for (const id of candidates) {
      const rows=this.db.prepare('SELECT destination FROM sdk_topic_routes WHERE chat_id=? AND (root_id=? OR thread_id=?) UNION SELECT r.destination FROM sdk_message_routes m JOIN sdk_topic_routes r ON r.destination=m.destination WHERE r.chat_id=? AND m.message_id=?').all(chatId,id,id,chatId,id) as Array<{destination:string}>;
      for (const row of rows) found.add(row.destination);
    }
    if (found.size===0) throw new UnknownTopic('unknown topic');
    if (found.size!==1) throw new Error('conflicting topic');
    const destination=[...found][0]!;if(!this.authorizedDestination(destination)) throw new UnknownTopic('test topic unavailable');return destination;
  }
  public callbackDestination(chatId:string,messageId:string):string {
    if (!this.destinations.has(chatId)) throw new Error('destination unauthorized');
    const reservedRoot=this.db.prepare('SELECT state FROM sdk_lane_registry WHERE root_id=?').get(messageId) as {state:string}|undefined;
    if(reservedRoot) {if(reservedRoot.state==='closed') throw new ClosedTestRoute('test topic closed');throw new UnknownCardRoute('test topic unavailable');}
    const row=this.db.prepare('SELECT destination FROM sdk_message_routes WHERE message_id=?').get(messageId) as {destination:string}|undefined;
    if (row && this.db.prepare("SELECT 1 FROM sdk_lane_registry WHERE destination=? AND state='closed'").get(row.destination)) throw new ClosedTestRoute('test topic closed');
    if (!row || !this.authorizedDestination(row.destination)) throw new UnknownCardRoute('unknown card message');
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
    await guard?.(); this.allowed(destination); const route=this.route(destination); const content=JSON.stringify(toFeishuCard(card));
    const response=route ? await this.client.im.message.reply({path:{message_id:route.root_id},data:{msg_type:'interactive',content,reply_in_thread:true}}) : await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:destination,msg_type:'interactive',content}});
    rejectCode(response.code); if (!response.data?.message_id) throw new Error('Feishu message send failed or outcome unknown');
    this.remember(deliveryId,response.data.message_id,destination); return response.data.message_id;
  }
  async update(destination:string,messageId:string,card:ChannelCard,deliveryId:string,guard?:()=>Promise<void>):Promise<void> {
    await guard?.(); this.allowed(destination); if(this.callbackDestination(this.route(destination)?.chat_id ?? destination,messageId)!==destination) throw new Error('message route mismatch');
    const response = await this.client.im.message.patch({path:{message_id:messageId},data:{content:JSON.stringify(toFeishuCard(card))}});
    rejectCode(response.code); this.remember(deliveryId,messageId,destination);
  }
  async sendFile(destination:string,name:string,content:Uint8Array,deliveryId:string,guard?:()=>Promise<void>):Promise<void> {
    this.allowed(destination); await guard?.(); const uploaded = await this.client.im.file.create({data:{file_type:'stream',file_name:name,file:Buffer.from(content)}});
    if (!uploaded?.file_key) throw new Error('Feishu upload failed or outcome unknown');
    await guard?.(); this.allowed(destination); const route=this.route(destination); const body=JSON.stringify({file_key:uploaded.file_key});
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
  private queueResource(e:TrustedEnvelope,messageId:string,key:string,type:'image'|'file',scope:string):void {
    this.allowed(e.destination); const serialized=JSON.stringify(e); const old=this.db.prepare('SELECT envelope,message_id,resource_key,resource_type FROM sdk_inbound_resources WHERE event_id=?').get(e.eventId) as {envelope:string;message_id:string;resource_key:string;resource_type:string}|undefined;
    if(old) { const oldScope=this.db.prepare('SELECT scope FROM sdk_resource_scopes WHERE event_id=?').get(e.eventId) as {scope:string}|undefined; if(old.envelope!==serialized || old.message_id!==messageId || old.resource_key!==key || old.resource_type!==type || oldScope?.scope!==scope) throw new Error('resource event conflict'); return; }
    this.db.exec('BEGIN IMMEDIATE'); try { this.db.prepare('INSERT INTO sdk_inbound_resources VALUES (?,?,?,?,?)').run(e.eventId,serialized,messageId,key,type); this.db.prepare('INSERT INTO sdk_resource_scopes VALUES (?,?)').run(e.eventId,scope); this.db.exec('COMMIT'); } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Safe, sanitized inspection; no resource keys, paths or downloaded content. */
  resourceIssues(): Array<{eventId:string;state:string;attempts:number;reason:string}> {
    return this.db.prepare('SELECT event_id AS eventId,state,attempts,reason FROM sdk_resource_failures ORDER BY rowid').all() as Array<{eventId:string;state:string;attempts:number;reason:string}>;
  }
  onResourceHealth:(status:'healthy'|'degraded',reason:string|null)=>void=()=>{};
  /** GET may safely repeat; per-item failures are persisted and never block later work. */
  async drainInbound(handle:(envelope:TrustedEnvelope,action:ChannelAction,scope?:string)=>Promise<unknown>):Promise<void> {
    const rows=this.db.prepare("SELECT r.* FROM sdk_inbound_resources r LEFT JOIN sdk_resource_failures f ON f.event_id=r.event_id WHERE f.event_id IS NULL OR (f.state='retry' AND f.next_attempt<=?) ORDER BY r.rowid").all(Date.now()) as Array<{event_id:string;envelope:string;message_id:string;resource_key:string;resource_type:'image'|'file'}>;
    for(const row of rows) {
      try {
        const e=JSON.parse(row.envelope) as TrustedEnvelope; this.allowed(e.destination); if(e.identity.source!=='feishu' || e.identity.subject!==this.owner) throw new ResourceRejected('authorization changed');
        const saved=this.db.prepare('SELECT scope FROM sdk_resource_scopes WHERE event_id=?').get(row.event_id) as {scope:string}|undefined; if (!saved) throw new ResourceRejected('resource missing binding scope');
        await downloadAndIntake(e,row.message_id,row.resource_key,row.resource_type,async (messageId,key,type)=>{this.allowed(e.destination);return (await this.client.im.messageResource.get({params:{type},path:{message_id:messageId,file_key:key}})).getReadableStream();},async (envelope,action,scope)=>{this.allowed(envelope.destination);return handle(envelope,action,scope);},saved.scope);
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
  async start(handle:(envelope:TrustedEnvelope,action:ChannelAction)=>Promise<unknown>, captureScope:(e:TrustedEnvelope)=>Promise<string>):Promise<void> {
    if (this.started || this.closing) throw new Error('already started or closing'); this.started = true;
    try {
    const bot = await this.client.request<{bot?:{open_id?:string}}>({url:'/open-apis/bot/v3/info',method:'GET'});
    if (this.closing) throw new Error('SDK port closing');
    const botId = bot.bot?.open_id;
    if (!botId) throw new Error('bot identity unavailable');
    const handles: Partial<Lark.EventHandles> & {'card.action.trigger':(data:Lark.RawCardActionEvent)=>Promise<any>} = {
      'im.message.receive_v1': async data => { await receiveSdkMessage(data,botId,this.owner,this.destinations,async (messageId,key,type) => (await this.client.im.messageResource.get({params:{type},path:{message_id:messageId,file_key:key}})).getReadableStream(),handle,async (e,id,key,type)=>this.queueResource(e,id,key,type,await captureScope(e)),(chat,root,parent,thread)=>this.resolveDestination(chat,root,parent,thread)); },
      'card.action.trigger': async data => handleSdkCardCallback(data,this.owner,this.destinations,(chat,message)=>this.callbackDestination(chat,message),handle),
    };
    if (this.closing) throw new Error('SDK port closing');
    await this.ws.start({eventDispatcher:new Lark.EventDispatcher({}).register(handles)});
    if (this.closing) throw new Error('SDK port closing');
    } catch(error) { this.ws.close(); throw error; }
  }
  stopReceiving():void { this.closing=true; this.linkCache.clear(); this.ws.close(); }
  close():void { this.stopReceiving(); if (!this.dbClosed) {this.dbClosed=true; this.db.close();} }
}
