import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionListCard} from '../src/unified/session-list-card.js';
import {CodexAdapter} from '../src/unified/codex-adapter.js';
import {ClaudeAdapter} from '../src/unified/claude-adapter.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Session} from '../src/unified/contracts.js';
const item=(id:string,title:string):Session=>({sessionId:id,native:{provider:'codex',hostId:'h',serviceId:'s',nativeSessionId:`native-${id}`},project:'/work/project',title,status:'idle',revision:0,capabilities:{view:{status:'available'}} as Session['capabilities'],control:{serviceId:'s',owner:null,input:'unavailable',generation:0,operationId:null,reason:null}});
test('list card shows safe titles and one readonly entry, omitting unknown metadata',()=>{
 const a=item('internal-a',''),b=item('internal-b','中'.repeat(60)),c=item('internal-c','不可查看');b.updatedAt='2026-11-16T10:00:00.000Z'; c.capabilities={view:{status:'temporarily_unavailable',reason:'unknown'}} as Session['capabilities'];
 const card=sessionListCard([a,b,c],{topicUrls:new Map([['internal-b','https://example.test/topic']]),nextCursor:'cursor'});
 assert.match(card.text,/未命名会话/);assert.match(card.text,/中{41}…/);assert.match(card.text,/最近活动 2026-11-16 10:00 UTC/);assert.doesNotMatch(card.text,/internal|native-/);assert.match(card.text,/暂不可查看/);
 assert.deepEqual(card.actions,[{label:'打开 未命名会话1',value:{action:'bind',sessionId:'internal-a',mode:'read_only'}},{label:`打开 ${'中'.repeat(17)}…`,value:{},url:'https://example.test/topic'},{label:'下一页',value:{action:'list',cursor:'cursor'}}]);assert.throws(()=>sessionListCard(Array(6).fill(a)),/five/);
});
test('native list metadata maps verified timestamps and titles',async()=>{
 const transport:any={connected:true,generation:1,request:async()=>({data:[{id:'x',cwd:'/p',name:'名称',status:{type:'idle'},updatedAt:1700000000},{id:'y',cwd:'/p',name:'',status:{type:'idle'},updatedAt:Infinity}],nextCursor:null})};
 const codex=new CodexAdapter(transport,'h','s');const page=await codex.list(null,5);assert.equal(page.items[0]!.title,'名称');assert.equal(page.items[0]!.updatedAt,'2023-11-14T22:13:20.000Z');assert.equal(page.items[1]!.updatedAt,undefined);
 const dir=mkdtempSync(join(tmpdir(),'list-meta-'));const sdk:any={listSessions:async()=>[{sessionId:'c',cwd:'/p',customTitle:' ',summary:'摘要',lastModified:1700000000000}],getSessionMessages:async()=>[]};const claude=new ClaudeAdapter('h','s',join(dir,'state'),sdk);try {const cp=await claude.list(null,5);assert.equal(cp.items[0]!.title,'摘要');assert.equal(cp.items[0]!.updatedAt,'2023-11-14T22:13:20.000Z');} finally {await claude.close();rmSync(dir,{recursive:true,force:true});}
});
