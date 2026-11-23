import {EventEmitter} from 'node:events';
/** Owns only the bwrap helper spawned for this TEST worker. */
export class NativeTestSupervisor {
  private exited=false;private readonly done:Promise<void>;private closePromise:Promise<void>|undefined;
  constructor(private readonly child:EventEmitter & {pid?:number|undefined;kill(signal?:NodeJS.Signals):boolean},private readonly stopRpc:()=>void,private readonly graceMs=2000) {
    this.done=new Promise(resolve=>{const finish=()=>{if(this.exited)return;this.exited=true;resolve();};child.once('exit',finish);child.on('error',(error:NodeJS.ErrnoException)=>{if(child.pid===undefined && typeof error.syscall==='string' && error.syscall.startsWith('spawn '))finish();});});
  }
  private async wait():Promise<boolean>{if(this.exited)return true;let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([this.done.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),this.graceMs);})]);}finally{if(timer)clearTimeout(timer);}}
  close():Promise<void>{if(this.closePromise)return this.closePromise;this.closePromise=(async()=>{this.stopRpc();if(this.exited)return;try{this.child.kill('SIGTERM');}catch{}if(await this.wait())return;try{this.child.kill('SIGKILL');}catch{}if(!await this.wait())throw Error('native test helper exit unconfirmed');})();return this.closePromise;}
}
