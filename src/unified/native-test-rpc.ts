import {randomUUID} from 'node:crypto';
import type {Readable,Writable} from 'node:stream';
import {contractError} from './errors.js';

export type NativeTestMethod='hello'|'session'|'snapshot'|'events'|'interaction'|'workState'|'history'|'operation'|'resolve'|'scenario'|'evidence'|'pump'|'close';
export type NativeRejectCode='busy'|'invalid_request'|'interaction_expired'|'unauthorized'|'unsupported'|'idempotency_conflict';
export const nativeRejectCodes:ReadonlySet<string>=new Set(['busy','invalid_request','interaction_expired','unauthorized','unsupported','idempotency_conflict']);
export class NativeTestRejected extends Error {constructor(readonly code:NativeRejectCode){super('native test rejected before dispatch');}}
const methods:ReadonlySet<string>=new Set(['hello','session','snapshot','events','interaction','workState','history','operation','resolve','scenario','evidence','pump','close']);
export interface NativeTestTransport {request(method:NativeTestMethod,params:unknown,generation:number):Promise<unknown>;close():Promise<void>|void}
/** One line-delimited stream to one sandbox child. It never accepts a method from an external caller. */
export class NativeTestLineRpc implements NativeTestTransport {
  private buffer='';private closed=false;private readonly pending=new Map<string,{generation:number;resolve:(value:unknown)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private readonly input:Writable,output:Readable,private readonly timeoutMs=3000) {
    output.setEncoding('utf8');output.on('data',(chunk:string)=>this.receive(chunk));output.on('end',()=>this.close());output.on('error',()=>this.close());input.on('error',()=>this.close());
  }
  request(method:NativeTestMethod,params:unknown,generation:number):Promise<unknown> {
    if(this.closed||!methods.has(method)||!Number.isSafeInteger(generation)||generation<1)return Promise.reject(contractError('temporarily_unavailable'));
    const id=randomUUID();let text:string;try{text=JSON.stringify({v:1,id,generation,method,params})+'\n';if(Buffer.byteLength(text)>1024*1024)throw Error('oversized');}catch{return Promise.reject(contractError('invalid_request'));}
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(contractError('outcome_unknown'));},this.timeoutMs);this.pending.set(id,{generation,resolve,reject,timer});try{this.input.write(text);}catch{clearTimeout(timer);this.pending.delete(id);reject(contractError('outcome_unknown'));}});
  }
  private receive(chunk:string):void {
    if(this.closed)return;this.buffer+=chunk;if(Buffer.byteLength(this.buffer)>1024*1024){this.close();return;}
    for(;;){const index=this.buffer.indexOf('\n');if(index<0)break;const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);let value:any;try{value=JSON.parse(line);}catch{this.close();return;}if(!value||value.v!==1||typeof value.id!=='string'||!Number.isSafeInteger(value.generation)||typeof value.ok!=='boolean'){this.close();return;}const pending=this.pending.get(value.id);if(!pending||pending.generation!==value.generation)continue;this.pending.delete(value.id);clearTimeout(pending.timer);if(value.ok)pending.resolve(value.result);else if(value.outcome==='rejected'&&typeof value.code==='string'&&nativeRejectCodes.has(value.code))pending.reject(new NativeTestRejected(value.code as NativeRejectCode));else pending.reject(contractError('outcome_unknown'));}
  }
  close():void {if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(contractError('outcome_unknown'));}this.pending.clear();}
}
