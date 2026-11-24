import { parseFeishuAction } from '../src/unified/feishu-codec.js';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {FeishuChannel} from '../src/unified/feishu-channel.js';import type {UnifiedService} from '../src/unified/adapter.js';
for(const fails of [false,true]) test(`long history exports full UTF-8 once; uncertain=${fails}`,async()=>{const dir=mkdtempSync(join(tmpdir(),'long-output-'));const full='中文😄'.repeat(1200);let uploads=0;let bytes=Buffer.alloc(0);const cards:any[]=[];const session={sessionId:'s',native:{provider:'codex'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}};const service={getSession:async()=>session,readHistory:async()=>({items:[{role:'assistant',blocks:[{type:'text',text:full}]}],nextCursor:null})} as unknown as UnifiedService;const port={send:async(_d:string,c:any)=>{cards.push(c);return 'm';},update:async()=>{},sendFile:async(_d:string,_n:string,b:Uint8Array)=>{uploads++;bytes=Buffer.from(b);if(fails)throw Error('lost');},fileMessageLink:async()=> 'https://example.test/file'};const channel=new FeishuChannel(service,port,async()=>true,join(dir,'db'));const e=(id:string)=>({eventId:id,destination:'d',identity:{source:'v',subject:'owner'}});try{await channel.handle(e('bind'),{action:'bind',sessionId:'s'});await channel.handle(e('h1'),{action:'history'});await channel.handle(e('h2'),{action:'history'});assert.equal(uploads,1);assert.equal(bytes.toString(),'assistant: '+full);assert.ok([...cards.at(-1).text].length<1100);if(fails){assert.match(cards.at(-1).text,/结果未知/);assert.equal(channel.pendingDeliveries().length,1);}else assert.equal(cards.at(-1).actions[0].url,'https://example.test/file');}finally{channel.close();rmSync(dir,{recursive:true,force:true});}});
test('long automatic reply uploads exact UTF-8 only on a full_reply click', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'long-event-'));
  const full = 'hello🌍'.repeat(700) + '\n可读的末尾';
  const cards: any[] = [];
  const uploads: Buffer[] = [];
  const session = { sessionId: 's', native: { provider: 'codex' }, title: 't', project: '/tmp',
    status: 'idle', revision: 1, control: { input: 'available', generation: 1 } };
  const message = { messageId: 'm', sessionId: 's', turnId: 't', role: 'assistant', sequence: 1,
    final: true, revision: 1, blocks: [{ type: 'text', text: full }] };
  let messages: unknown[] = [];
  const service = {
    getSession: async () => session,
    getSnapshot: async () => ({ cursor: 'c', value: { session, interactions: [], messages } }),
    subscribeEvents: async () => ({ status: 'events', events: [{ eventId: 'e', objectId: 'm', type: 'message.updated' }], cursor: 'c2' }),
  } as unknown as UnifiedService;
  const port = {
    send: async (_d: string, card: unknown) => { cards.push(card); return 'id'; },
    update: async () => {},
    sendFile: async (_d: string, _n: string, bytes: Uint8Array) => { uploads.push(Buffer.from(bytes)); },
    fileMessageLink: async () => 'https://example.test/file',
  };
  const channel = new FeishuChannel(service, port, async () => true, join(dir, 'db'));
  const env = (eventId: string) => ({ eventId, destination: 'd', identity: { source: 'v', subject: 'owner' } });
  try {
    await channel.handle(env('bind'), { action: 'bind', sessionId: 's' });
    await channel.sync('d');
    messages = [message, { ...message, messageId: 'foreign', sessionId: 'other' }];
    await channel.sync('d');
    await channel.sync('d');
    const reply = cards.at(-1);
    assert.equal(reply.schema, '2.0');
    assert.equal(uploads.length, 0);
    assert.match(reply.text, /可读的末尾$/);
    const action = parseFeishuAction(reply.actions.find((button: any) => button.label === '发送完整正文 (.txt)').value);
    await channel.handle(env('forged'), { action: 'full_reply', messageId: 'foreign' });
    assert.equal(uploads.length, 0);
    await channel.handle(env('click'), action);
    await channel.handle(env('again'), action);
    assert.deepEqual(uploads, [Buffer.from(full, 'utf8')]);
    assert.equal(cards.at(-1).actions[0].url, 'https://example.test/file');
  } finally {
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('long file keys are scoped to each binding epoch and session',async()=>{const dir=mkdtempSync(join(tmpdir(),'long-epoch-'));const ids:string[]=[];const cards:any[]=[];let id='s';const session=()=>({sessionId:id,native:{provider:'codex'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}});const service={getSession:async(s:string)=>({...session(),sessionId:s}),readHistory:async()=>({items:[{role:'assistant',blocks:[{type:'text',text:'一😄'.repeat(1600)}]}],nextCursor:null})} as unknown as UnifiedService;const port={send:async(_d:string,c:any)=>{cards.push(c);return 'm';},update:async()=>{},sendFile:async(_d:string,_n:string,_b:Uint8Array,key:string)=>{ids.push(key);},fileMessageLink:async(_d:string,_s:string,key:string)=>`https://example.test/${key}`};const c=new FeishuChannel(service,port,async()=>true,join(dir,'db'));const e=(eventId:string)=>({eventId,destination:'d',identity:{source:'v',subject:'owner'}});try{await c.handle(e('b1'),{action:'bind',sessionId:'s'});await c.handle(e('h1'),{action:'history'});await c.handle(e('same'),{action:'history'});assert.equal(ids.length,1);await c.handle(e('u'),{action:'unbind'});await c.handle(e('b2'),{action:'bind',sessionId:'s'});await c.handle(e('h2'),{action:'history'});id='other';await c.handle(e('b3'),{action:'bind',sessionId:'other'});await c.handle(e('h3'),{action:'history'});assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);assert.ok(cards.at(-1).actions[0].url.endsWith(ids[2]));}finally{c.close();rmSync(dir,{recursive:true,force:true});}});
for(const scenario of ['normal','unbind','rebind','revoke'] as const) test(`SDK upload guard checks before file message: ${scenario}`,async()=>{const {FeishuSdkPort}=await import('../src/unified/feishu-sdk-port.js');const dir=mkdtempSync(join(tmpdir(),'long-sdk-'));const sdk=new FeishuSdkPort({appId:'test',appSecret:'test'},join(dir,'sdk'),new Set(['d']),'owner');(sdk as any).createTopic=undefined;(sdk as any).send=async()=> 'card';let release!:()=>void,started!:()=>void;const waitUpload=new Promise<void>(r=>release=r),hasStarted=new Promise<void>(r=>started=r);let sends=0;(sdk as any).client.im.file.create=async()=>{started();await waitUpload;return {file_key:'key'};};(sdk as any).client.im.message.create=async()=>{sends++;return {data:{message_id:'f'}};};let enabled=true;let turn=0;const message={messageId:'m',sessionId:'s',turnId:'t',sequence:1,role:'assistant',final:true,revision:1,blocks:[{type:'text',text:'内容'.repeat(2000)}]};const session=(id:string)=>({sessionId:id,native:{provider:'codex'},title:id,project:'p',status:'idle',revision:1,control:{input:'available',generation:1}});const service={getSession:async(id:string)=>session(id),getSnapshot:async()=>({cursor:'c',value:{session:session('s'),interactions:[],messages:turn?[message]:[]}}),subscribeEvents:async()=>({status:'events',events:[{eventId:'event',objectId:'m',type:'message.updated',data:{}}],cursor:'c2'})} as unknown as UnifiedService;const channel=new FeishuChannel(service,sdk,async()=>enabled,join(dir,'channel'));const replacement=new FeishuChannel(service,sdk,async()=>enabled,join(dir,'channel'));const e=(eventId:string)=>({eventId,destination:'d',identity:{source:'feishu',subject:'owner'}});try{await channel.handle(e('bind'),{action:'bind',sessionId:'s'});await channel.sync('d');turn=1;await channel.sync('d');const running=channel.handle(e('full-reply'),{action:'full_reply',messageId:'m'});await hasStarted;if(scenario==='unbind')await replacement.handle(e('unbind'),{action:'unbind'});if(scenario==='rebind')await replacement.handle(e('rebind'),{action:'bind',sessionId:'other'});if(scenario==='revoke')enabled=false;release();if(scenario==='normal')await running;else await assert.rejects(running,/binding|unauthorized/);assert.equal(sends,scenario==='normal'?1:0);}finally{release();replacement.close();channel.close();sdk.close();rmSync(dir,{recursive:true,force:true});}});
test('ordinary artifact passes authorization guard to transport after read',async()=>{const dir=mkdtempSync(join(tmpdir(),'artifact-guard-'));let allowed=true,guardSeen=false,sent=0;const session={sessionId:'s',native:{provider:'codex'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}};const service={getSession:async()=>session,listArtifacts:async()=>({items:[{artifactId:'a',contentVersion:'1',name:'a.txt'}],nextCursor:null}),readArtifact:async()=>new Uint8Array([1])} as unknown as UnifiedService;const port={send:async()=> 'm',update:async()=>{},sendFile:async(_d:string,_n:string,_b:Uint8Array,_id:string,guard?:()=>Promise<void>)=>{guardSeen=!!guard;allowed=false;await guard?.();sent++;}};const c=new FeishuChannel(service,port,async()=>allowed,join(dir,'db'));const e=(eventId:string)=>({eventId,destination:'d',identity:{source:'v',subject:'owner'}});try{await c.handle(e('b'),{action:'bind',sessionId:'s'});await assert.rejects(c.handle(e('f'),{action:'file',artifactId:'a',contentVersion:'1'}),/unauthorized/);assert.equal(guardSeen,true);assert.equal(sent,0);}finally{c.close();rmSync(dir,{recursive:true,force:true});}});
