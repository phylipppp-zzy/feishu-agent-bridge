import { DatabaseSync } from 'node:sqlite';
import { CARD_REPLY_BUDGET_BYTES, formatCardReplyBody, sanitizeCardMarkdownLinks } from '../src/unified/turn-reply.js';
import { replyText, turnProgressCard } from '../src/unified/turn-progress-card.js';
import { cardContentBytes } from '../src/text-limits.js';
import { TaskTopicChannel } from '../src/unified/task-topic/channel.js';
import type { Message } from '../src/unified/contracts.js';
import { parseFeishuAction } from '../src/unified/feishu-codec.js';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {FeishuChannel} from '../src/unified/feishu-channel.js';import type {UnifiedService} from '../src/unified/adapter.js';
for(const fails of [false,true]) test(`long history exports full UTF-8 once; uncertain=${fails}`,async()=>{const dir=mkdtempSync(join(tmpdir(),'long-output-'));const full='中文😄'.repeat(1200);let uploads=0;let bytes=Buffer.alloc(0);const cards:any[]=[];const session={sessionId:'s',native:{provider:'codex'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}};const service={getSession:async()=>session,readHistory:async()=>({items:[{role:'assistant',blocks:[{type:'text',text:full}]}],nextCursor:null})} as unknown as UnifiedService;const port={send:async(_d:string,c:any)=>{cards.push(c);return 'm';},update:async()=>{},sendFile:async(_d:string,_n:string,b:Uint8Array)=>{uploads++;bytes=Buffer.from(b);if(fails)throw Error('lost');},fileMessageLink:async()=> 'https://example.test/file'};const channel=new FeishuChannel(service,port,async()=>true,join(dir,'db'));const e=(id:string)=>({eventId:id,destination:'d',identity:{source:'v',subject:'owner'}});try{await channel.handle(e('bind'),{action:'bind',sessionId:'s'});await channel.handle(e('h1'),{action:'history'});await channel.handle(e('h2'),{action:'history'});assert.equal(uploads,1);assert.equal(bytes.toString(),'assistant: '+full);assert.ok([...cards.at(-1).text].length<1100);if(fails){assert.match(cards.at(-1).text,/结果未知/);assert.equal(channel.pendingDeliveries().length,1);}else assert.equal(cards.at(-1).actions[0].url,'https://example.test/file');}finally{channel.close();rmSync(dir,{recursive:true,force:true});}});
test('long automatic reply uploads exact UTF-8 only on a full_reply click', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'long-event-'));
  const first = '核心结论 [本地报告](file:///tmp/report.md)';
  const full = '```text\n' + 'hello🌍'.repeat(2600) + '\n```\n可读的末尾';
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
    messages = [{ ...message, messageId: 'earlier', sequence: 0, blocks: [{ type: 'text', text: first }] },
      message, { ...message, messageId: 'foreign', sessionId: 'other' }];
    await channel.sync('d');
    await channel.sync('d');
    const reply = cards.at(-1);
    assert.equal(reply.schema, '2.0');
    assert.equal(uploads.length, 0);
    assert.match(reply.text, /^核心结论 `本地报告`/);
    assert.match(reply.text, /可读的末尾$/);
    assert.match(reply.text, /\n```\n\n> .*已省略[^\n]*\n\n```\n/);
    assert.equal(reply.text.match(/^```/gm)?.length, 4);
    assert.ok(cardContentBytes(reply.text) <= CARD_REPLY_BUDGET_BYTES);
    assert.match(reply.footer, /🔧 0 步 · 🕒 \d{2}:\d{2}/);
    assert.doesNotMatch(reply.text, /🔧 0 步/);
    const action = parseFeishuAction(reply.actions.find((button: any) => button.label === '发送完整正文 (.txt)').value);
    await channel.handle(env('forged'), { action: 'full_reply', messageId: 'foreign' });
    assert.equal(uploads.length, 0);
    await channel.handle(env('click'), action);
    await channel.handle(env('again'), action);
    await channel.handle(env('earlier-anchor'), { action: 'full_reply', messageId: 'earlier' });
    await channel.handle(env('turn-anchor'), { action: 'full_reply', messageId: 't' });
    assert.deepEqual(uploads, [Buffer.from(first + '\n\n' + full, 'utf8')]);
    assert.equal(cards.at(-1).actions[0].url, 'https://example.test/file');
  } finally {
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('3,485 and 4,096 character Chinese Markdown reports fit intact with display-only link rewrites', () => {
  for (const length of [3485, 4096]) {
    const intro = '## 核心结论\n[报告](file:///tmp/report.md) [文档](https://example.test/docs)\n---\n';
    const ending = '\n`[代码](./unchanged)`\n~~~md\n[示例](localfile:///tmp/example)\n~~~\n可读的末尾';
    const raw = intro + '结'.repeat(length - intro.length - ending.length) + ending;
    const message: Message = { messageId: 'm', sessionId: 's', turnId: 't', role: 'assistant', source: 'codex',
      sequence: 1, revision: 1, final: true, blocks: [{ type: 'text', text: raw }] };
    assert.equal(raw.length, length);
    const expected = raw.replace('[报告](file:///tmp/report.md)', '`报告`');
    assert.deepEqual(formatCardReplyBody(raw), { text: expected, truncated: false });
    const card = turnProgressCard({ provider: 'codex', status: 'completed', schema: '2.0', message, tools: [], duration: null, files: [] });
    assert.equal(card.text, expected);
    assert.deepEqual(card.actions, []);
    assert.equal(replyText(message), raw);
  }
});

test('Markdown link sanitization scans unmatched brackets in under 50 ms', () => {
  const input = '['.repeat(20_000);
  const start = performance.now();
  const result = sanitizeCardMarkdownLinks(input);
  const elapsed = performance.now() - start;
  assert.deepEqual(result, { text: input, rewroteLinks: false });
  assert.ok(elapsed < 50, `bracket scan took ${elapsed.toFixed(1)} ms`);

  const malformed = '[x](< '.repeat(5_000) + '[报告](file:///tmp/report "title")';
  assert.equal(sanitizeCardMarkdownLinks(malformed).text, '[x](< '.repeat(5_000) + '`报告`');
  const escaped = String.raw`\[escaped](file:///tmp)
[a\]b](<file:///tmp/my report> 'title') ![web](<HTTPS://example.test/image>)`;
  assert.equal(sanitizeCardMarkdownLinks(escaped).text, '\\[escaped](file:///tmp)\n`a\\]b` ![web](<HTTPS://example.test/image>)');
});

test('upgraded read-only bindings exclude unchanged baseline items from automatic replies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'long-output-baseline-'));
  const path = join(dir, 'db');
  const session = { sessionId: 's', native: { provider: 'agy' }, title: 'test', project: dir, status: 'read_only',
    control: { input: 'unavailable', generation: 0 } };
  const first: Message = { messageId: 'before', sessionId: 's', turnId: 't', sequence: 1, revision: 1, role: 'assistant',
    source: 'agy', final: true, blocks: [{ type: 'text', text: 'already known' }] };
  const later: Message = { ...first, messageId: 'after', sequence: 2, blocks: [{ type: 'text', text: 'new reply' }] };
  const messages = [first];
  const cards: string[] = [];
  const service = {
    getSession: async () => session,
    getSnapshot: async () => ({ cursor: 'c', value: { session, interactions: [], messages } }),
    subscribeEvents: async () => ({ status: 'events', cursor: 'c', events: [{ type: 'message.updated', objectId: later.messageId }] }),
  } as unknown as UnifiedService;
  const port = { send: async (_destination: string, card: { text: string }) => { cards.push(card.text); return 'card'; },
    update: async () => {}, sendFile: async () => {} };
  const channel = new FeishuChannel(service, port, async () => true, path);
  const db = new DatabaseSync(path);
  try {
    await channel.handle({ eventId: 'bind', destination: 'd', identity: { source: 'feishu', subject: 'owner' } },
      { action: 'bind', sessionId: 's' });
    await channel.baselineReadonlyHistory('d', 's');
    db.exec('DELETE FROM channel_turn_baseline_messages');
    messages.push(later);
    await channel.sync('d');
    assert.equal(cards.at(-1), 'new reply');
    await channel.sync('d');
    assert.deepEqual(db.prepare("SELECT message_id FROM channel_turn_baseline_messages WHERE message_id<>''").all()
      .map(row => row.message_id), ['before']);
  } finally { db.close(); channel.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('task topic streams the whole turn and sends the raw file from its scoped action', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-long-output-'));
  const session = { sessionId: 's', native: { provider: 'codex', hostId: 'h', serviceId: 'x', nativeSessionId: 'n' },
    control: { generation: 1 } } as const;
  const cards: any[] = [];
  const uploads: Buffer[] = [];
  const messages: Message[] = [];
  const events: Array<{ type: string; objectId: string; data?: { status: string } }> = [];
  const service = {
    getSession: async () => session,
    getSnapshot: async () => ({ cursor: 'c', value: { session, messages, interactions: [] } }),
    subscribeEvents: async () => ({ status: 'events', cursor: 'c', events }),
  } as unknown as UnifiedService;
  const port = {
    send: async (_dest: string, card: unknown) => { cards.push(card); return 'id'; },
    update: async (_dest: string, id: string, card: unknown) => { assert.equal(id, 'id'); cards.push(card); },
    sendFile: async (_dest: string, _name: string, bytes: Uint8Array, _id: string, guard?: () => Promise<void>) => {
      await guard?.();
      uploads.push(Buffer.from(bytes));
    },
  };
  const channel = new TaskTopicChannel(service, port, async () => true, join(dir, 'db'));
  const owner = { source: 'feishu', subject: 'owner' };
  const first = '核心结论 [本地报告](file:///tmp/report.md)';
  const last = '内容'.repeat(4000) + '\n最终段落';
  const item = (messageId: string, text: string, sequence: number, final: boolean): Message => ({
    messageId, sessionId: 's', turnId: 'turn', sequence, revision: 1, final, source: 'codex',
    role: 'assistant', blocks: [{ type: 'text', text }],
  });
  try {
    channel.registerTask({ taskId: 'task', destination: 'topic:task', rootGeneration: 1, owner });
    await channel.mountTarget({ taskId: 'task', targetId: 'target', sessionId: 's', native: session.native, accessMode: 'read_only', owner });
    assert.deepEqual((await channel.syncTask('task')).failedTargets, []);
    messages.push(item('earlier', first, 1, false));
    events.push({ type: 'message.updated', objectId: 'earlier' });
    assert.deepEqual((await channel.syncTask('task')).failedTargets, []);
    messages.push(item('last', last, 2, true));
    events.splice(0, 1, { type: 'turn.updated', objectId: 'turn', data: { status: 'completed' } });
    assert.deepEqual((await channel.syncTask('task')).failedTargets, []);
    assert.equal(cards.length, 2);
    const card = cards[1];
    assert.match(card.text, /核心结论 `本地报告`/);
    assert.match(card.text, /最终段落$/);
    const action = parseFeishuAction<import('../src/unified/task-topic/types.js').TaskChannelAction>(card.actions[0].value);
    await channel.handle({ eventId: 'card:full', destination: 'topic:task', identity: owner }, action);
    assert.deepEqual(uploads, [Buffer.from(first + '\n\n' + last)]);
  } finally { channel.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('long file keys are scoped to each binding epoch and session',async()=>{const dir=mkdtempSync(join(tmpdir(),'long-epoch-'));const ids:string[]=[];const cards:any[]=[];let id='s';const session=()=>({sessionId:id,native:{provider:'codex'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}});const service={getSession:async(s:string)=>({...session(),sessionId:s}),readHistory:async()=>({items:[{role:'assistant',blocks:[{type:'text',text:'一😄'.repeat(1600)}]}],nextCursor:null})} as unknown as UnifiedService;const port={send:async(_d:string,c:any)=>{cards.push(c);return 'm';},update:async()=>{},sendFile:async(_d:string,_n:string,_b:Uint8Array,key:string)=>{ids.push(key);},fileMessageLink:async(_d:string,_s:string,key:string)=>`https://example.test/${key}`};const c=new FeishuChannel(service,port,async()=>true,join(dir,'db'));const e=(eventId:string)=>({eventId,destination:'d',identity:{source:'v',subject:'owner'}});try{await c.handle(e('b1'),{action:'bind',sessionId:'s'});await c.handle(e('h1'),{action:'history'});await c.handle(e('same'),{action:'history'});assert.equal(ids.length,1);await c.handle(e('u'),{action:'unbind'});await c.handle(e('b2'),{action:'bind',sessionId:'s'});await c.handle(e('h2'),{action:'history'});id='other';await c.handle(e('b3'),{action:'bind',sessionId:'other'});await c.handle(e('h3'),{action:'history'});assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);assert.ok(cards.at(-1).actions[0].url.endsWith(ids[2]));}finally{c.close();rmSync(dir,{recursive:true,force:true});}});
for(const scenario of ['normal','unbind','rebind','revoke'] as const) test(`SDK upload guard checks before file message: ${scenario}`,async()=>{const {FeishuSdkPort}=await import('../src/unified/feishu-sdk-port.js');const dir=mkdtempSync(join(tmpdir(),'long-sdk-'));const sdk=new FeishuSdkPort({appId:'test',appSecret:'test'},join(dir,'sdk'),new Set(['d']),'owner');(sdk as any).createTopic=undefined;(sdk as any).send=async()=> 'card';let release!:()=>void,started!:()=>void;const waitUpload=new Promise<void>(r=>release=r),hasStarted=new Promise<void>(r=>started=r);let sends=0;(sdk as any).client.im.file.create=async()=>{started();await waitUpload;return {file_key:'key'};};(sdk as any).client.im.message.create=async()=>{sends++;return {data:{message_id:'f'}};};let enabled=true;let turn=0;const message={messageId:'m',sessionId:'s',turnId:'t',sequence:1,role:'assistant',final:true,revision:1,blocks:[{type:'text',text:'内容'.repeat(2000)}]};const session=(id:string)=>({sessionId:id,native:{provider:'codex'},title:id,project:'p',status:'idle',revision:1,control:{input:'available',generation:1}});const service={getSession:async(id:string)=>session(id),getSnapshot:async()=>({cursor:'c',value:{session:session('s'),interactions:[],messages:turn?[message]:[]}}),subscribeEvents:async()=>({status:'events',events:[{eventId:'event',objectId:'m',type:'message.updated',data:{}}],cursor:'c2'})} as unknown as UnifiedService;const channel=new FeishuChannel(service,sdk,async()=>enabled,join(dir,'channel'));const replacement=new FeishuChannel(service,sdk,async()=>enabled,join(dir,'channel'));const e=(eventId:string)=>({eventId,destination:'d',identity:{source:'feishu',subject:'owner'}});try{await channel.handle(e('bind'),{action:'bind',sessionId:'s'});await channel.sync('d');turn=1;await channel.sync('d');const running=channel.handle(e('full-reply'),{action:'full_reply',messageId:'m'});await hasStarted;if(scenario==='unbind')await replacement.handle(e('unbind'),{action:'unbind'});if(scenario==='rebind')await replacement.handle(e('rebind'),{action:'bind',sessionId:'other'});if(scenario==='revoke')enabled=false;release();if(scenario==='normal')await running;else await assert.rejects(running,/binding|unauthorized/);assert.equal(sends,scenario==='normal'?1:0);}finally{release();replacement.close();channel.close();sdk.close();rmSync(dir,{recursive:true,force:true});}});
test('ordinary artifact passes authorization guard to transport after read',async()=>{const dir=mkdtempSync(join(tmpdir(),'artifact-guard-'));let allowed=true,guardSeen=false,sent=0;const session={sessionId:'s',native:{provider:'codex'},title:'t',project:'p',status:'idle',revision:1,control:{input:'available',generation:1}};const service={getSession:async()=>session,listArtifacts:async()=>({items:[{artifactId:'a',contentVersion:'1',name:'a.txt'}],nextCursor:null}),readArtifact:async()=>new Uint8Array([1])} as unknown as UnifiedService;const port={send:async()=> 'm',update:async()=>{},sendFile:async(_d:string,_n:string,_b:Uint8Array,_id:string,guard?:()=>Promise<void>)=>{guardSeen=!!guard;allowed=false;await guard?.();sent++;}};const c=new FeishuChannel(service,port,async()=>allowed,join(dir,'db'));const e=(eventId:string)=>({eventId,destination:'d',identity:{source:'v',subject:'owner'}});try{await c.handle(e('b'),{action:'bind',sessionId:'s'});await assert.rejects(c.handle(e('f'),{action:'file',artifactId:'a',contentVersion:'1'}),/unauthorized/);assert.equal(guardSeen,true);assert.equal(sent,0);}finally{c.close();rmSync(dir,{recursive:true,force:true});}});
