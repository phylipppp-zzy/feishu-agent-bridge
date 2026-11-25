import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexTransport } from '../src/unified/codex-transport.js';
import { CodexAdapter } from '../src/unified/codex-adapter.js';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedCore } from '../src/unified/service.js';
const fix1Root=process.env.FIX1_ROOT || join(homedir(),'tmp/codex-features-fix1');
const transport=new CodexTransport('ws://127.0.0.1:19431',undefined,10000);await transport.connect();const adapter=new CodexAdapter(transport,'fixture-host','fixture-service');const store=new UnifiedStore(join(fix1Root,'state.db'));const core=new UnifiedCore(store,[adapter],i=>i.subject==='fixture',()=>false,()=>false,s=>s.project===join(fix1Root,'project'));
const ctx=(id:string,targetId:string,rev=0,gen=0)=>({operationId:id,idempotencyKey:id,targetId,expectedRevision:rev,controlGeneration:gen,identity:{subject:'fixture',source:'local-test'}});
try {
 const page=await adapter.list(null,100); if(page.items.length!==1)throw Error(`expected exactly 1 isolated TUI thread, found ${page.items.length}`); const found=page.items[0]!;
 let raw:any; for(let i=0;i<90;i++){raw=await transport.request('thread/read',{threadId:found.native.nativeSessionId,includeTurns:false}); if(raw.thread.status.type==='idle')break; await new Promise(r=>setTimeout(r,1000));} if(raw.thread.status.type!=='idle')throw Error(`TUI thread did not reach idle: ${raw.thread.status.type}`);
 const attached=await core.attachSession({context:ctx('attach','bootstrap'),payload:{...found.native,mode:'interactive'}}); const sid=(attached.result as {sessionId:string}).sessionId; const s=await core.getSession(sid);
 const done = new Promise<{status:string;matched:boolean}>(resolve=>{const off=adapter.onObservation(o=>{if(o.type==='turn' && ['completed','failed','interrupted'].includes(o.turn.status)){off();resolve({status:o.turn.status,matched:o.ref.nativeSessionId===found.native.nativeSessionId});}});});
 await core.submitInput({context:ctx('input',sid,s.revision,s.control.generation),mode:'new',blocks:[{type:'text',text:'Reply with exactly FIX1_BRIDGE_OK.'}]});const op=await core.dispatch('input');const result=await Promise.race([done,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('turn timeout')),90000);timer.unref();})]);
 const snapshot=await adapter.read(found.native);const matched=snapshot.messages.some(m=>m.role==='assistant' && m.blocks.some(b=>b.type==='text' && b.text.includes('FIX1_BRIDGE_OK')));
 console.log(JSON.stringify({tuiThreadCount:page.items.length,sessionIdMatched:s.native.nativeSessionId===found.native.nativeSessionId,attach:attached.status,input:op.status,turn:result.status,turnThreadMatched:result.matched,replyMatched:matched}));
}finally{core.close();transport.close();store.close();}
