import {test} from 'node:test'; import assert from 'node:assert/strict'; import {mkdtempSync,rmSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; import {FeishuChannel} from '../src/unified/feishu-channel.js';
test('a late older final never replaces the current reply item',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const dir=mkdtempSync(join(tmpdir(),'stream-card-')); const messages:any[]=[]; const events:any[]=[]; const sends:any[]=[],updates:any[]=[]; let cursor=0;
 const session:any={sessionId:'s',native:{provider:'codex'},title:'test',project:'/tmp',status:'running',revision:0,control:{input:'unavailable',generation:0}};
 const service:any={getSession:async()=>session,getSnapshot:async()=>({cursor:String(events.length+1),value:{session,messages:[...messages],interactions:[]}}),subscribeEvents:async()=>({status:'events',events:[...events.slice(cursor)],cursor:String(events.length+1)})};
 const port:any={async send(_d:any,c:any){sends.push(c);return `card-${sends.length}`},async update(_d:any,id:any,c:any){updates.push({id,c})},async sendFile(){}};
 const channel=new FeishuChannel(service,port,async()=>true,join(dir,'db')); const env={eventId:'bind',destination:'d',identity:{source:'feishu',subject:'owner'}};
 const add=(id:string,text:string,final:boolean)=>{messages.push({messageId:id,sessionId:'s',turnId:'turn',role:'assistant',blocks:[{type:'text',text}],sequence:messages.length+1,revision:1,final,source:'codex'});events.push({type:'message.updated',objectId:id,eventId:id,data:{}})};
 try {await channel.handle(env,{action:'bind',sessionId:'s'});await channel.sync('d');sends.length=0;add('one','first',false);await channel.sync('d');cursor=events.length;add('two','middle',true);add('three','final',true);await channel.sync('d');assert.equal(sends.length,1);assert.equal(updates.length,0);t.mock.timers.tick(1500);await channel.sync('d');assert.equal(updates.length,1);assert.equal(updates[0].c.text,'final');assert.equal(updates[0].id,'card-1');cursor=events.length; messages[0].final=true;messages[0].revision=2;events.push({type:'message.updated',objectId:'one',eventId:'late-old',data:{}});await channel.sync('d');assert.equal(updates.at(-1)?.c.text,'final');}finally{channel.close();rmSync(dir,{recursive:true,force:true})}
});

