import {contractError} from './errors.js';
import type {Operation} from './contracts.js';
/** Single sandbox model turn at a time, including before its native dispatch. */
export class NativeTestSceneGate {
  private active:string|null=null;private readonly scenarios=new Map<string,string>();
  async check(operationId:string,scenario:string,lookup:(id:string)=>Promise<Operation>):Promise<Operation|null> {
    const prior=this.scenarios.get(operationId);if(prior!==undefined){if(prior!==scenario)throw contractError('idempotency_conflict');return lookup(operationId);}
    if(this.active){const status=(await lookup(this.active)).status;if(status!=='completed'&&status!=='failed')throw contractError('busy');this.active=null;}
    return null;
  }
  current():string|null{return this.active;}
  registered(operationId:string,scenario:string):void {if(this.scenarios.has(operationId)||this.active)throw contractError('busy');this.scenarios.set(operationId,scenario);this.active=operationId;}
}
