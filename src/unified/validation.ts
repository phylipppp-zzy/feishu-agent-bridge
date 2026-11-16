import { createHash } from 'node:crypto';
import { contractError } from './errors.js';
import type { Validation } from './contracts.js';

type Check = (x: unknown) => boolean;
const str: Check = x => typeof x === 'string' && x.trim().length > 0;
const bool: Check = x => typeof x === 'boolean';
const uint: Check = x => Number.isSafeInteger(x) && (x as number) >= 0;
const date: Check = x => typeof x === 'string' && Number.isFinite(Date.parse(x));
const one = (...v: unknown[]): Check => x => v.includes(x);
const nullable = (v: Check): Check => x => x === null || v(x);
const array = (v: Check): Check => x => Array.isArray(x) && x.every(v);
const obj = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => x => {
  if (!x || typeof x !== 'object' || Array.isArray(x) || ![Object.prototype, null].includes(Object.getPrototypeOf(x))) return false;
  const o = x as Record<string, unknown>;
  return Reflect.ownKeys(o).every(k => typeof k === 'string' && !Object.hasOwn(Object.prototype, k) && k !== 'prototype' && (k !== 'criticalFields' || Object.hasOwn(required,k) || Object.hasOwn(optional,k)) && !!Object.getOwnPropertyDescriptor(o,k)?.enumerable && 'value' in Object.getOwnPropertyDescriptor(o,k)! && (Object.hasOwn(required,k) || Object.hasOwn(optional,k) || json(o[k]))) && Object.entries(required).every(([k,v]) => Object.hasOwn(o,k) && v(o[k])) && Object.entries(optional).every(([k,v]) => !Object.hasOwn(o,k) || v(o[k]));
};
const record = (v: Check): Check => x => !!x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype && Reflect.ownKeys(x).every(k => typeof k === 'string' && !!Object.getOwnPropertyDescriptor(x,k)?.enumerable && 'value' in Object.getOwnPropertyDescriptor(x,k)! && v((x as Record<string,unknown>)[k]));
const json: Check = x => { try { const walk = (v: unknown, seen: Set<object>): boolean => { if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return true; if (!v || typeof v !== 'object' || seen.has(v)) return false; seen.add(v); const valid = Array.isArray(v) ? Object.keys(v).length === v.length && v.every(y => walk(y, seen)) : record(y => walk(y, seen))(v); seen.delete(v); return valid; }; return walk(x,new Set()); } catch { return false; } };
const identity = obj({subject:str,source:str});
const context = obj({operationId:str,idempotencyKey:str,targetId:str,expectedRevision:uint,controlGeneration:uint,identity});
const native = obj({provider:one('claude','codex'),hostId:str,serviceId:str,nativeSessionId:str});
const capability: Check = x => obj({status:one('available')})(x) || obj({status:one('unsupported','temporarily_unavailable'),reason:str})(x);
const capabilities = obj(Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k => [k,capability])));
const control = obj({serviceId:str,owner:nullable(str),input:one('available','unavailable','unknown'),generation:uint,operationId:nullable(str),reason:nullable(str)});
const session = obj({sessionId:str,native,project:str,title:str,status:one('idle','running','waiting_question','waiting_approval','interrupted','failed','unreachable','read_only'),revision:uint,capabilities,control});
const block: Check = x => obj({type:one('text'),text:str})(x) || obj({type:one('artifact'),artifactId:str,contentVersion:str})(x);
const message = obj({messageId:str,sessionId:str,turnId:str,role:one('user','assistant','tool'),blocks:array(block),sequence:uint,revision:uint,final:bool,source:str});
const question = obj({id:str,prompt:str,choices:array(str),multiple:nullable(bool),allowFreeText:bool});
const answer: Check = x => obj({kind:one('question_group'),answers:record(array(str))})(x) || obj({kind:one('question'),values:array(str)})(x) || obj({kind:one('approval'),decision:one('allow','deny'),scope:str})(x);
const result: Check = x => obj({status:one('accepted'),source:str,answer:nullable(answer)})(x) || obj({status:one('unknown'),source:str})(x) || obj({status:one('rejected'),reason:str})(x);
const ibase = {interactionId:str,sessionId:str,turnId:str,nativeRequestId:str,connectionGeneration:uint,revision:uint,status:one('awaiting_answer','answer_pending_delivery','resolved','expired','cancelled'),expiresAt:nullable(date),nativeResult:nullable(result)};
const interaction: Check = x => obj({...ibase,kind:one('question_group'),toolInputDigest:nullable(str),questions:array(question)})(x) || obj({...ibase,kind:one('question'),toolInputDigest:nullable(str),prompt:str,choices:array(str),multiple:bool,allowFreeText:bool})(x) || obj({...ibase,kind:one('approval'),toolInputDigest:str,tool:str,action:str,scope:str})(x);
const error = obj({code:one('unsupported','busy','control_conflict','stale_revision','interaction_expired','unauthorized','temporarily_unavailable','outcome_unknown','idempotency_conflict','invalid_request','snapshot_required'),retryable:bool,suggestedAction:str},{message:str});
const operationResult: Check = x => obj({kind:one('session'),sessionId:str})(x) || obj({kind:one('artifact'),artifactId:str,contentVersion:str})(x) || obj({kind:one('turn'),turnId:str,status:one('completed','failed','interrupted')})(x);
const operation = obj({operationId:str,idempotencyKey:str,targetId:str,action:str,payloadDigest:str,status:one('received','queued','accepted','completed','failed','unknown'),revision:uint,error:nullable(error)},{result:operationResult});
const artifact = obj({artifactId:str,sessionId:str,name:str,mediaType:str,size:uint,contentVersion:str});
const event = obj({schemaVersion:one(1),eventId:str,sessionId:str,objectId:str,objectRevision:uint,sequence:uint,type:str,occurredAt:date,receivedAt:date,operationId:nullable(str),cursor:str,data:json});
const page = (item: Check) => obj({items:array(item),nextCursor:nullable(str)});
const snapshot = obj({value:obj({session,messages:array(message),interactions:array(interaction)}),cursor:str});
const query = obj({limit:uint},{cursor:str,search:str});
const write = (payload: Check) => obj({context,payload});
const empty = obj({});
const submit = obj({context,mode:one('new','queue','steer'),blocks:x => array(block)(x) && (x as unknown[]).length > 0});
const resolve = obj({context,interactionId:str,expectedConnectionGeneration:uint,answer,toolInputDigest:nullable(str)});
// JSON transport encodes bytes as canonical base64, with digest and size checked separately.
const base64: Check = x => typeof x === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x) && Buffer.from(x,'base64').toString('base64') === x;
const wireArtifactShape = obj({name:str,mediaType:str,size:uint,contentDigest:x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x),contentBase64:base64});
const wireArtifact: Check = x => { if (!wireArtifactShape(x)) return false; const a = x as {size:number;contentDigest:string;contentBase64:string}; const bytes = Buffer.from(a.contentBase64,'base64'); return bytes.length === a.size && createHash('sha256').update(bytes).digest('hex') === a.contentDigest; };
const turn = obj({turnId:str,sessionId:str,status:one('queued','running','completed','interrupted','failed'),inputId:nullable(str),startedAt:nullable(date),endedAt:nullable(date),model:nullable(str),outputIds:array(str)});
const observation: Check = x => obj({type:one('connection'),ref:native,connectionGeneration:uint})(x) || (obj({type:one('session'),ref:native,session})(x) && (() => { const o = x as {ref: Record<string, unknown>; session: {native: Record<string, unknown>}}; return ['provider','hostId','serviceId','nativeSessionId'].every(k => o.ref[k] === o.session.native[k]); })()) || obj({type:one('turn'),ref:native,turn})(x) || obj({type:one('message'),ref:native,message})(x) || obj({type:one('interaction'),ref:native,interaction})(x) || obj({type:one('event'),ref:native,event})(x);
const subscription: Check = x => obj({status:one('events'),events:array(event),cursor:str})(x) || obj({status:one('snapshot_required'),error})(x);
const health = obj({backlog:nullable(uint),lastDeliveryAt:nullable(date),component:str,status:one('healthy','degraded','unreachable'),updatedAt:date,reason:nullable(str)});
const model = obj({id:str,label:str});
export const schemas: Record<string, Check> = { identity,context,native,observation,capability,capabilities,control,session,turn,block,message,artifact,operation,interaction,answer,event,error,snapshot,subscription,query,submit,resolve,wireArtifact,
  'request.listSessions':query, 'request.getSession':str, 'request.capabilities':str,
  'request.attachSession':write(obj({provider:one('claude','codex'),hostId:str,serviceId:str,nativeSessionId:str,mode:one('read_only','interactive')})), 'request.detachSession':write(empty), 'request.createSession':write(obj({provider:one('claude','codex'),project:str,model:nullable(str)})),
  'request.readHistory':obj({sessionId:str,query}), 'request.getSnapshot':str, 'request.subscribeEvents':obj({sessionId:str,cursor:str,limit:uint}), 'request.submitInput':submit, 'request.listInteractions':obj({sessionId:str,query}), 'request.getInteraction':str, 'request.resolveInteraction':resolve,
  'request.interruptTurn':write(obj({turnId:str})), 'request.cancelQueuedInput':write(obj({inputId:str})), 'request.getControlState':str, 'request.requestControl':write(obj({owner:str,strategy:one('wait','interrupt')})), 'request.releaseControl':write(obj({owner:str})), 'request.listArtifacts':obj({sessionId:str,query}), 'request.readArtifact':obj({sessionId:str,artifactId:str,contentVersion:str}), 'request.stageInputArtifact':write(wireArtifact), 'request.listModels':obj({sessionId:str,query}), 'request.updateSessionSettings':write(obj({model:nullable(str),preferences:record(str)})), 'request.getOperation':str, 'request.reconcile':str, 'request.setNotificationSubscription':write(obj({enabled:bool,eventTypes:array(str)})), 'request.health':empty, 'request.archiveSession':write(obj({archived:bool})),
  'response.listSessions':page(session), 'response.getSession':session, 'response.capabilities':capabilities, 'response.readHistory':page(message), 'response.getSnapshot':snapshot, 'response.subscribeEvents':subscription, 'response.listInteractions':page(interaction), 'response.getInteraction':interaction, 'response.getControlState':control, 'response.listArtifacts':page(artifact), 'response.readArtifact':base64, 'response.listModels':page(model), 'response.health':array(health),
};
for (const name of ['attachSession','detachSession','createSession','submitInput','resolveInteraction','interruptTurn','cancelQueuedInput','requestControl','releaseControl','stageInputArtifact','updateSessionSettings','getOperation','reconcile','setNotificationSubscription','archiveSession']) schemas[`response.${name}`] = operation;
/** Allow JSON-valued optional extensions, while validating known fields and rejecting dangerous property names. Unknown schema names and invalid payloads fail. */
export function validateWire(name: string, value: unknown): Validation<unknown> {
  try { if (Object.hasOwn(schemas, name) && schemas[name]?.(value)) return {ok:true,value}; } catch { /* untrusted objects may throw */ }
  return {ok:false,error:contractError('invalid_request', `invalid ${name}`)};
}
