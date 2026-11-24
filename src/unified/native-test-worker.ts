import {payloadDigest,type Interaction,type Operation,type ResolveInteraction,type Session,type SessionSnapshot,type SubmitInput,type Provider} from './contracts.js';
import type {UnifiedService} from './adapter.js';
import {contractError} from './errors.js';
import {NativeTestLedger} from './native-test-ledger.js';
import {NativeTestRejected,type NativeTestMethod,type NativeTestTransport} from './native-test-rpc.js';
import {StoreError} from './store.js';

/** Only the TEST channel can hold this service; no SDK/WS lifecycle or arbitrary method forwarding. */
export class NativeTestWorker {
  readonly ledger:NativeTestLedger;readonly service:UnifiedService;private closed=false;private ledgerClosed=false;private closePromise:Promise<void>|undefined;sessionId:string;
  constructor(path:string,scope:string,sessionId:string,private readonly transport:NativeTestTransport,private readonly owner:string='owner',private readonly provider:Provider='claude') {
    if(!sessionId)throw contractError('invalid_request');this.sessionId=sessionId;this.ledger=new NativeTestLedger(path,scope);const self=this;
    this.service=new Proxy({} as UnifiedService,{get(_target,key){
      if(key==='then'||typeof key==='symbol')return undefined;
      if(key==='hasProvider')return (p:Provider)=>p===self.provider;
      if(key==='getSession')return (id:string)=>self.session(id);
      if(key==='getSnapshot')return (id:string)=>self.snapshot(id);
      if(key==='getInteraction')return (id:string)=>self.interaction(id);
      if(key==='getResponseOperation')return async()=>null;
      if(key==='resolveInteraction')return (request:ResolveInteraction)=>self.resolve(request);
      if(key==='getOperation')return (id:string)=>self.operation(id);
      if(key==='listSessions')return async()=>({items:[await self.session(self.sessionId)],nextCursor:null});
      if(key==='capabilities')return async(id:string)=>(await self.session(id)).capabilities;
      if(key==='getConfirmedSettings')return async()=>null;
      if(key==='getWorkState')return (id:string)=>self.read('workState',id);
      if(key==='subscribeEvents')return (id:string,cursor:string,limit:number)=>self.read('events',id,{cursor,limit});
      if(key==='readHistory')return (id:string,q:unknown)=>self.read('history',id,q);
      if(key==='health')return async()=>[{component:'native-test',status:self.closed?'unreachable':'unverified',reason:'隔离测试 worker',backlog:null,lastDeliveryAt:null,updatedAt:null}];
      return async()=>{throw contractError('unsupported','native TEST operation unavailable')};
    }});
  }
  static async open(path:string,scope:string,transport:NativeTestTransport,owner:string,provider:Provider='claude'):Promise<NativeTestWorker> {const worker=new NativeTestWorker(path,scope,'pending',transport,owner,provider);try{const value=await worker.call('hello',{owner}) as {sessionId?:unknown};if(!value||typeof value.sessionId!=='string'||!value.sessionId)throw contractError('invalid_request');worker.sessionId=value.sessionId;return worker;}catch(error){await worker.close();throw error;}}
  private call(method:NativeTestMethod,params:unknown):Promise<unknown>{if(this.closed)return Promise.reject(contractError('temporarily_unavailable'));return this.transport.request(method,params,this.ledger.generation);}
  private check(id:string):void{if(id!==this.sessionId)throw new StoreError(contractError('unauthorized'));}
  private async read(method:NativeTestMethod,id:string,query?:unknown):Promise<unknown>{this.check(id);return this.call(method,{sessionId:id,...(query===undefined?{}:{query})});}
  private safeSession(value:unknown):Session {const s=value as Session;if(!s || s.sessionId!==this.sessionId || s.native?.provider!==this.provider || !s.capabilities || !s.control)throw contractError('invalid_request');const unavailable={status:'unsupported' as const,reason:'隔离测试不接受自由输入'};return {...s,title:`原生测试 · ${this.provider==='claude'?'Claude':'Codex'}`,project:'隔离测试',capabilities:{...s.capabilities,send:unavailable,queue:unavailable,steer:unavailable,interrupt:unavailable,files:unavailable,config:unavailable,handoff:unavailable}};}
  private mapInteraction(value:unknown):Interaction {const i=value as Interaction;if(!i || i.sessionId!==this.sessionId || typeof i.interactionId!=='string' || !i.interactionId || typeof i.nativeRequestId!=='string' || !['question','question_group','approval'].includes(i.kind) || !['awaiting_answer','answer_pending_delivery','resolved','expired','cancelled'].includes(i.status) || !Number.isSafeInteger(i.revision))throw contractError('invalid_request');const constrained=i.kind==='question_group' ? {...i,questions:i.questions.map(q=>({...q,allowFreeText:false,...(this.provider==='codex'?{multiple:false}:{})}))} : i;return this.ledger.observeInteraction(constrained);}
  private async session(id:string):Promise<Session>{return this.safeSession(await this.read('session',id));}
  private async snapshot(id:string):Promise<{cursor:string;value:SessionSnapshot}> {this.check(id);const raw=await this.call('snapshot',{sessionId:id}) as {cursor:string;value:SessionSnapshot};if(!raw || typeof raw.cursor!=='string' || !raw.value || !Array.isArray(raw.value.messages) || !Array.isArray(raw.value.interactions))throw contractError('invalid_request');const interactions=raw.value.interactions.map(i=>this.mapInteraction(i));const present=new Set(interactions.map(i=>i.interactionId));for(const old of this.ledger.expiredInteractions())if(old.sessionId===id&&!present.has(old.interactionId))interactions.push(old);return {...raw,value:{...raw.value,session:this.safeSession(raw.value.session),interactions}};}
  private async interaction(id:string):Promise<Interaction>{const known=this.ledger.interaction(id);if(known.status==='expired')return known;return this.mapInteraction(await this.call('interaction',{interactionId:id}));}
  private async resolve(request:ResolveInteraction):Promise<Operation> {
    this.check(request.context.targetId);let nativeGeneration:number;try{nativeGeneration=this.ledger.mappedNativeGeneration(request.interactionId,request.expectedConnectionGeneration);}catch{throw new StoreError(contractError('interaction_expired'));}const translated={...request,expectedConnectionGeneration:nativeGeneration};const digest=payloadDigest({action:'resolveInteraction',context:request.context,payload:translated});const claim=this.ledger.claim(request.context,'resolveInteraction',digest);if(!claim.dispatch)return claim.operation;
    try{try{this.ledger.nativeInteractionGeneration(request.interactionId,request.expectedConnectionGeneration);}catch{throw new NativeTestRejected('interaction_expired');}const value=await this.call('resolve',{request:translated}) as Operation;return this.ledger.accept(value,this.ledger.generation);}catch(e){if(e instanceof NativeTestRejected){this.ledger.reject(request.context.operationId,e.code);throw new StoreError(contractError(e.code));}this.ledger.markUnknown(request.context.operationId);throw e;}
  }
  private async operation(id:string):Promise<Operation>{const known=this.ledger.get(id);if(!['received','queued','accepted'].includes(known.status))return known;try{return this.ledger.accept(await this.call('operation',{operationId:id}) as Operation,this.ledger.generation);}catch{this.ledger.markUnknown(id);return this.ledger.get(id);}}
  /** Only fixed operator scenarios can submit text to the sandbox model fixture. */
  async trigger(scenario:'question-single'|'question-multiple'|'approval',operationId:string):Promise<Operation> {
    if(!['question-single','question-multiple','approval'].includes(scenario)||(this.provider==='codex'&&scenario==='question-multiple')||!/^[a-zA-Z0-9_-]{1,80}$/.test(operationId))throw contractError('invalid_request');
    const previous=this.ledger.scenarioResult(operationId,scenario);if(previous)return previous;const session=await this.session(this.sessionId);const context={operationId,idempotencyKey:operationId,targetId:this.sessionId,expectedRevision:session.revision,controlGeneration:session.control.generation,identity:{source:'feishu',subject:this.owner}};const request:SubmitInput={context,mode:'new',blocks:[{type:'text',text:`NATIVE_TEST_${scenario}`}]};const digest=payloadDigest({action:'submitInput',context,payload:request});const claim=this.ledger.claim(context,'submitInput',digest,scenario);if(!claim.dispatch)return claim.operation;
    try{return this.ledger.accept(await this.call('scenario',{scenario,context}) as Operation,this.ledger.generation);}catch(e){if(e instanceof NativeTestRejected){this.ledger.reject(operationId,e.code);throw new StoreError(contractError(e.code));}this.ledger.markUnknown(operationId);throw e;}
  }
  async evidence():Promise<{toolResultSeen:boolean;questionAnswerMatches:boolean;markerExists:boolean;acceptedAnswerHash?:string|null;observedAnswerHash?:string|null}>{const value=await this.call('evidence',{}) as {toolResultSeen?:unknown;questionAnswerMatches?:unknown;markerExists?:unknown;acceptedAnswerHash?:unknown;observedAnswerHash?:unknown};if(typeof value?.toolResultSeen!=='boolean'||typeof value.questionAnswerMatches!=='boolean'||typeof value.markerExists!=='boolean')throw contractError('invalid_request');if(this.provider==='codex'){const valid=(x:unknown):x is string|null=>x===null||(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x));if(!valid(value.acceptedAnswerHash)||!valid(value.observedAnswerHash))throw contractError('invalid_request');return {toolResultSeen:value.toolResultSeen,questionAnswerMatches:value.questionAnswerMatches,markerExists:value.markerExists,acceptedAnswerHash:value.acceptedAnswerHash,observedAnswerHash:value.observedAnswerHash};}return {toolResultSeen:value.toolResultSeen,questionAnswerMatches:value.questionAnswerMatches,markerExists:value.markerExists};}
  async pump():Promise<void>{await this.call('pump',{});}
  close():Promise<void>{if(this.closePromise)return this.closePromise;this.closed=true;const work=(async()=>{let transportError:unknown;try{await this.transport.close();}catch(error){transportError=error;}try{if(!this.ledgerClosed){this.ledger.close();this.ledgerClosed=true;}}catch(error){if(!transportError)throw error;}if(transportError)throw transportError;})();this.closePromise=work;void work.catch(()=>{if(this.closePromise===work)this.closePromise=undefined;});return work;}
}
