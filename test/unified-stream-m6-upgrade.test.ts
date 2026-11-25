import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {FeishuChannel} from '../src/unified/feishu-channel.js';
test('M6 current readonly baseline upgrades without replay, next partial and final converge',async(t)=>{const path=process.env.G2_M6_DIST;if(!path){t.skip('set G2_M6_DIST to isolated M6 feishu-channel.js');return}t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});const {FeishuChannel:M6}=await import(path);const dir=mkdtempSync(join(tmpdir(),'m6-upgrade-'));const session:any={sessionId:'s',native:{provider:'codex'},title:'test',project:'/tmp',status:'running',revision:0,control:{input:'unavailable',generation:0}};let revision=1;let message:any={messageId:'m',sessionId:'s',turnId:'t',role:'assistant',blocks:[{type:'text',text:'old partial'}],sequence:1,revision,final:false,source:'codex'};const sent:any[]=[],updated:any[]=[];let events:any[]=[];const service:any={getSession:async()=>session,getSnapshot:async()=>({cursor:String(revision),value:{session,messages:[message],interactions:[]}}),subscribeEvents:async()=>({status:'events',events,cursor:String(revision)})};const port:any={async send(_d:any,c:any){sent.push(c);return 'card'},async update(_d:any,_id:any,c:any){updated.push(c)},async sendFile(){}};let channel:any=new M6(service,port,async()=>true,join(dir,'db'));try{await channel.handle({eventId:'bind',destination:'d',identity:{source:'feishu',subject:'owner'}},{action:'bind',sessionId:'s'});await channel.sync('d');channel.close();sent.length=0;channel=new FeishuChannel(service,port,async()=>true,join(dir,'db'));await channel.sync('d');assert.equal(sent.length,0);revision=2;message={...message,revision,blocks:[{type:'text',text:'new partial'}]};events=[{type:'message.updated',objectId:'m',eventId:'2',data:{}}];await channel.sync('d');assert.equal(sent.length,1);assert.equal(sent[0].text,'new partial');revision=3;message={...message,revision,final:true,blocks:[{type:'text',text:'complete'}]};events=[{type:'message.updated',objectId:'m',eventId:'3',data:{}}];await channel.sync('d');t.mock.timers.tick(1500);await channel.sync('d');assert.equal(updated.at(-1)?.text,'complete');}finally{channel.close();rmSync(dir,{recursive:true,force:true})}});

test('Wave A stream slot keeps its original SDK schema while finalization upgrades new replies to 2.0', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const { FeishuSdkPort } = await import('../src/unified/feishu-sdk-port.js');
  const { FeishuChannel } = await import('../src/unified/feishu-channel.js');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'legacy-stream-schema-'));
  const channelPath = join(dir, 'channel');
  const sdkPath = join(dir, 'sdk');
  const sdk = new FeishuSdkPort({ appId: 'x', appSecret: 'x' }, sdkPath, new Set(['chat']), 'owner');
  const replies: any[] = [];
  const patches: any[] = [];
  (sdk as any).client.im.message.get = async () => ({ code: 0, data: { items: [] } });
  (sdk as any).client.im.message.create = async () => ({ data: { message_id: 'root' } });
  (sdk as any).client.im.message.reply = async ({ data }: any) => {
    const id = `reply${replies.length + 1}`;
    replies.push({ id, card: JSON.parse(data.content) });
    return { data: { message_id: id } };
  };
  (sdk as any).client.im.message.patch = async ({ path, data }: any) => {
    patches.push({ id: path.message_id, card: JSON.parse(data.content) });
    return { code: 0 };
  };
  const session: any = { sessionId: 's', native: { provider: 'codex' }, title: 'test', project: dir,
    status: 'idle', revision: 0, control: { input: 'unavailable', generation: 0 } };
  const messages: any[] = [], turns: any[] = [], events: any[] = [];
  let cursor = 'baseline';
  const service: any = { getSession: async () => session,
    getSnapshot: async () => ({ cursor, value: { session, messages, turns, interactions: [] } }),
    subscribeEvents: async () => ({ status: 'events', cursor, events }) };
  const channel = new FeishuChannel(service, sdk, async () => true, channelPath);
  try {
    const identity = { source: 'feishu', subject: 'owner' };
    const bound = await channel.handle({ eventId: 'bind', destination: 'chat', identity }, { action: 'bind', sessionId: 's' }) as {destination: string};
    const { destination } = bound;
    await channel.sync(destination);
    const former = await sdk.send(destination, { schema: '1.0', title: '回复中', text: '旧正文', actions: [] }, 'old-send');
    const db = new DatabaseSync(channelPath);
    try {
      const scope = JSON.stringify(db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings WHERE destination=?').get(destination));
      db.prepare('INSERT INTO channel_stream_cards VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(destination, 's', scope, 'old', former, 1, Date.now(), 0, 'old-message', 1);
    } finally { db.close(); }
    patches.length = 0;
    messages.push({ messageId: 'old-message', role: 'assistant', turnId: 'old', sessionId: 's', sequence: 1,
      revision: 2, final: true, blocks: [{ type: 'text', text: '旧卡完成' }] });
    turns.push({ turnId: 'old', status: 'completed' });
    events.push({ type: 'turn.updated', objectId: 'old', eventId: 'old-done', data: { status: 'completed' } });
    cursor = 'terminal';
    await channel.sync(destination);
    t.mock.timers.tick(1500);
    await channel.sync(destination);
    const oldPatch = patches.find(patch => patch.id === former);
    assert.equal(oldPatch.card.header.template, 'green');
    assert.equal(oldPatch.card.schema, undefined);
    assert.ok(oldPatch.card.elements);
    turns.push({ turnId: 'new', status: 'completed' });
    events.push({ type: 'turn.updated', objectId: 'new', eventId: 'new-done', data: { status: 'completed' } });
    cursor = 'next';
    await channel.sync(destination);
    const newest = replies.at(-1)!;
    assert.equal(newest.card.schema, '2.0');
    assert.equal(newest.card.header.template, 'green');
    const ledger = new DatabaseSync(sdkPath);
    try {
      const lookup = ledger.prepare('SELECT schema_version FROM sdk_card_schemas WHERE message_id=?');
      assert.equal(lookup.get(former)?.schema_version, '1.0');
      assert.equal(lookup.get(newest.id)?.schema_version, '2.0');
    } finally { ledger.close(); }
  } finally {
    channel.close();
    sdk.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
