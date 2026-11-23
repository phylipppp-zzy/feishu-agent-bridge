import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyManifest, planMigration, type MigrationInput } from '../src/unified/migration.js';

test('legacy fixture planning is non-executing, detects ambiguity, and stages idempotently', () => {
  const root = mkdtempSync(join(tmpdir(),'migration-fixture-'));
  try {
    writeFileSync(join(root,'.migration-copy-root'),'fixture');
    const codex = join(root,'codex.sqlite'); const claude = join(root,'claude.sqlite');
    const a = new DatabaseSync(codex); a.exec(`CREATE TABLE sessions(session_id TEXT PRIMARY KEY,path TEXT,cwd TEXT,title TEXT,chat_id TEXT,thread_id TEXT); INSERT INTO sessions VALUES('native-c','/fixture/c','/project','codex','chat','thread'); CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings VALUES('secret','DO_NOT_READ'); CREATE TABLE messages(message_id TEXT,session_id TEXT,feishu_message_id TEXT,direction TEXT); INSERT INTO messages VALUES('m','native-c','f','out'); CREATE TABLE server_requests(nonce TEXT,session_id TEXT,payload TEXT,status TEXT); INSERT INTO server_requests VALUES('r','native-c','secret-payload','pending');`); a.close();
    const b = new DatabaseSync(claude); b.exec(`CREATE TABLE sessions(session_id TEXT PRIMARY KEY,path TEXT,cwd TEXT,custom_title TEXT,root_message_id TEXT,chat_id TEXT); INSERT INTO sessions VALUES('native-a','/fixture/a','/project','claude','root','chat'); CREATE TABLE file_deliveries(session_id TEXT,turn_id TEXT,path TEXT,version TEXT,source_refs_json TEXT,status TEXT); INSERT INTO file_deliveries VALUES('native-a','turn','file','v1','private','sent');`); b.close();
    const input: MigrationInput = {copyRoot:root,sources:[{provider:'codex',path:codex,hostId:'h',serviceId:'codex-svc',snapshot:{id:'codex-snapshot',method:'fixture',evidence:'synthetic'}},{provider:'claude',path:claude,hostId:'h',serviceId:'claude-svc',snapshot:{id:'claude-snapshot',method:'fixture',evidence:'synthetic'}}],bindings:[{provider:'codex',nativeSessionId:'native-c',destination:'topic-1',owner:{source:'feishu',subject:'u'}},{provider:'claude',nativeSessionId:'native-a',destination:'topic-2',owner:{source:'',subject:''}}]};
    const plan = planMigration(input); assert.equal(plan.sessions.length,2); assert.equal(plan.bindings.length,0); assert.ok(plan.review.some(x=>x.kind==='file_versions')); assert.ok(plan.review.some(x=>x.kind==='pending')); assert.ok(plan.review.some(x=>x.kind==='binding'));
    assert.ok(plan.references.some(r=>r.table==='file_deliveries' && r.fields.version==='v1' && r.snapshotId==='claude-snapshot')); assert.ok(plan.references.some(r=>r.table==='server_requests' && r.fields.nonce==='r')); assert.ok(plan.references.some(r=>r.table==='sessions' && r.fields.path==='/fixture/c'));
    assert.doesNotMatch(JSON.stringify(plan),/DO_NOT_READ|secret-payload|private/);
    const ledger = join(root,'ledger.sqlite'); assert.equal(applyManifest(plan,ledger).state,'dry-run'); assert.equal(applyManifest(plan,ledger,true).state,'staged'); assert.equal(applyManifest(plan,ledger,true).state,'already-staged');
    assert.throws(()=>applyManifest({...plan,notes:['changed']},ledger,true),/different manifest/); assert.throws(()=>applyManifest(plan,codex,true),/not a migration ledger/);
    writeFileSync(`${codex}-wal`,'x'); assert.throws(()=>planMigration(input),/WAL/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('duplicate native identity and duplicate destinations require review',()=>{
  const root=mkdtempSync(join(tmpdir(),'migration-duplicate-')); try {
    writeFileSync(join(root,'.migration-copy-root'),'fixture'); const paths=['a','b'].map(n=>join(root,n));
    for (const p of paths) { const db=new DatabaseSync(p); db.exec("CREATE TABLE sessions(session_id TEXT,cwd TEXT); INSERT INTO sessions VALUES('same','/project')"); db.close(); }
    const source={provider:'codex' as const,hostId:'host',serviceId:'service',snapshot:{id:'snapshot',method:'fixture' as const,evidence:'synthetic'}};
    const p=planMigration({copyRoot:root,sources:paths.map(path=>({...source,path})),bindings:[{provider:'codex',nativeSessionId:'same',destination:'topic',owner:{source:'feishu',subject:'u'}}]});
    assert.equal(p.sessions.length,0); assert.equal(p.bindings.length,0); assert.ok(p.review.some(r=>r.reason==='duplicate native identity'));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('channel migration receipt and conservative rollback protect subsequent activity', async()=> {
  const {FeishuChannel} = await import('../src/unified/feishu-channel.js');
  const root=mkdtempSync(join(tmpdir(),'migration-channel-')); const path=join(root,'channel.sqlite');
  try {
    const channel=new FeishuChannel({} as never,{} as never,async()=>true,path);
    const record={destination:'topic',sessionId:'session',bindingId:'binding',owner:{source:'feishu',subject:'owner'}};
    assert.equal(channel.importMigrationBinding('id',record),'inserted'); assert.equal(channel.importMigrationBinding('id',record),'already-imported');
    assert.throws(()=>channel.importMigrationBinding('id',{...record,sessionId:'other'}),/conflict/);
    assert.throws(()=>channel.importMigrationBinding('other',{...record,bindingId:'other'}),/conflict/);
    assert.equal(channel.rollbackMigrationBinding('id'),'removed'); assert.equal(channel.rollbackMigrationBinding('id'),'absent');
    channel.importMigrationBinding('id',record);
    const db=new DatabaseSync(path); db.prepare('INSERT INTO channel_known_messages VALUES(?,?,?,?)').run('topic','session','new-message',1); db.close();
    assert.equal(channel.rollbackMigrationBinding('id'),'retained'); channel.close();
    const verify=new DatabaseSync(path,{readOnly:true}); assert.ok(verify.prepare('SELECT 1 FROM channel_known_messages').get()); assert.ok(verify.prepare('SELECT 1 FROM channel_bindings').get()); verify.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('actual core/channel saga resumes after interruption and rollback retains new message',async()=>{
  const {UnifiedStore}=await import('../src/unified/store.js'); const {FeishuChannel}=await import('../src/unified/feishu-channel.js'); const {FeishuSdkPort}=await import('../src/unified/feishu-sdk-port.js');
  const {applyToSinks,rollbackFromSinks}=await import('../src/unified/migration.js');
  const root=mkdtempSync(join(tmpdir(),'migration-saga-')); try {
    writeFileSync(join(root,'.migration-copy-root'),'fixture'); const old=join(root,'old.sqlite');
    const db=new DatabaseSync(old); db.exec("CREATE TABLE sessions(session_id TEXT,cwd TEXT,title TEXT,chat_id TEXT,root_message_id TEXT); INSERT INTO sessions VALUES('native','/project','title','chat','root')"); db.close();
    const manifest=planMigration({copyRoot:root,sources:[{provider:'codex',path:old,hostId:'h',serviceId:'svc',snapshot:{id:'snapshot',method:'fixture',evidence:'synthetic'}}],bindings:[{provider:'codex',nativeSessionId:'native',destination:'topic',owner:{source:'feishu',subject:'owner'},chatId:'chat',rootId:'root',appId:'app',scopeEvidence:'fixture app scope'}]});
    const core=new UnifiedStore(join(root,'core.sqlite')); const channel=new FeishuChannel({} as never,{} as never,async()=>true,join(root,'channel.sqlite')); const sdk=new FeishuSdkPort({appId:'app',appSecret:'fixture'},join(root,'sdk.sqlite'),new Set(['chat']),'owner'); const ledger=join(root,'ledger.sqlite');
    const interrupt={importMigrationBinding(){throw new Error('injected interruption');},rollbackMigrationBinding:channel.rollbackMigrationBinding.bind(channel)};
    assert.throws(()=>applyToSinks(manifest,ledger,core,interrupt,sdk),/injected interruption/); assert.equal(core.listSessions().length,1);
    applyToSinks(manifest,ledger,core,channel,sdk); applyToSinks(manifest,ledger,core,channel,sdk); assert.equal(core.listSessions().length,1);
    const s=core.listSessions()[0]!; assert.equal(s.status,'read_only'); assert.equal(s.control.input,'unavailable');
    core.putMessage({messageId:'new-message',sessionId:s.sessionId,turnId:'turn',role:'assistant',blocks:[{type:'text',text:'new reply'}],sequence:1,revision:0,final:true,source:'fixture'},null);
    const result=rollbackFromSinks(manifest,ledger,core,channel,sdk); assert.ok(result.retained.length); assert.equal(core.snapshot(s.sessionId).value.messages[0]?.messageId,'new-message');
    sdk.close(); channel.close(); core.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('verified archive is read through core and migrated SDK route replies in the old topic',async()=>{
  const {UnifiedStore}=await import('../src/unified/store.js'); const {UnifiedCore}=await import('../src/unified/service.js');
  const {FeishuChannel}=await import('../src/unified/feishu-channel.js'); const {FeishuSdkPort}=await import('../src/unified/feishu-sdk-port.js');
  const {HistoryArchive}=await import('../src/unified/history-archive.js'); const {applyToSinks,rollbackFromSinks}=await import('../src/unified/migration.js');
  const root=mkdtempSync(join(tmpdir(),'archive-fixture-')); try {
    writeFileSync(join(root,'.migration-copy-root'),'fixture'); const old=join(root,'old.sqlite'); const db=new DatabaseSync(old);
    db.exec(`CREATE TABLE sessions(session_id TEXT,cwd TEXT,custom_title TEXT,path TEXT,chat_id TEXT,root_message_id TEXT);
      INSERT INTO sessions VALUES('native','/project','old','/missing/transcript','chat','root');
      INSERT INTO sessions VALUES('other','/project','other','/missing/other','chat2','root2');
      CREATE TABLE turns(session_id TEXT,turn_id TEXT,seq INTEGER,view_json TEXT);
      CREATE TABLE file_deliveries(session_id TEXT,turn_id TEXT,path TEXT,version TEXT,source_refs_json TEXT,chat_id TEXT,root_message_id TEXT,status TEXT,file_message_id TEXT);
      CREATE TABLE server_requests(session_id TEXT,nonce TEXT,turn_id TEXT,status TEXT,card_message_id TEXT);`);
    db.prepare('INSERT INTO turns VALUES(?,?,?,?)').run('native','turn',1,JSON.stringify({turnId:'turn',prompt:'old question',blocks:[{kind:'text',text:'old answer'}]}));
    db.prepare('INSERT INTO turns VALUES(?,?,?,?)').run('other','other-turn',1,JSON.stringify({turnId:'other-turn',prompt:'private other',blocks:[]}));
    db.prepare('INSERT INTO file_deliveries VALUES(?,?,?,?,?,?,?,?,?)').run('native','turn','/artifact/report.pdf','v1',JSON.stringify([{label:'report',href:'https://fixture/report'}]),'chat','root','sent','file-message');
    db.prepare('INSERT INTO server_requests VALUES(?,?,?,?,?)').run('native','nonce','turn','pending','old-card'); db.close();
    const manifest=planMigration({copyRoot:root,sources:[{provider:'claude',path:old,hostId:'h',serviceId:'svc',snapshot:{id:'fixture',method:'fixture',evidence:'synthetic'}}],bindings:[{provider:'claude',nativeSessionId:'native',destination:'topic:old',owner:{source:'feishu',subject:'owner'},chatId:'chat',rootId:'root',appId:'app',scopeEvidence:'fixture verified'}]});
    const store=new UnifiedStore(join(root,'core')); const sdk=new FeishuSdkPort({appId:'app',appSecret:'fake'},join(root,'sdk'),new Set(['chat']),'owner'); const archive=new HistoryArchive(root,manifest); const core=new UnifiedCore(store,[],()=>true,()=>false,()=>false,undefined,archive); const channel=new FeishuChannel(core,sdk,async(i,d)=>i.subject==='owner' && sdk.authorizedDestination(d),join(root,'channel')); const ledger=join(root,'ledger');
    try {
      applyToSinks(manifest,ledger,store,channel,sdk); applyToSinks(manifest,ledger,store,channel,sdk);
      const session=store.listSessions().find(s=>s.native.nativeSessionId==='native')!; const page=await core.readHistory(session.sessionId,{limit:100}); const body=JSON.stringify(page);
      assert.match(body,/old question/); assert.match(body,/old answer/); assert.match(body,/report.pdf/); assert.match(body,/file-message/); assert.ok(body.includes('https://fixture/report')); assert.match(body,/old-card/); assert.doesNotMatch(body,/private other/);
      assert.equal((await core.listInteractions(session.sessionId,{limit:10})).items.length,0);
      assert.equal(sdk.resolveDestination('chat','root'),'topic:old'); let replied='';
      (sdk as any).client.im.message.reply=async (x:any)=>{replied=x.path.message_id;return {code:0,data:{message_id:'new-reply'}};};
      await sdk.send('topic:old',{title:'test',text:'fixture',actions:[]},'delivery'); assert.equal(replied,'root');
      store.putMessage({messageId:'new',sessionId:session.sessionId,turnId:'n',role:'assistant',blocks:[{type:'text',text:'new answer'}],sequence:1,revision:0,final:true,source:'fixture'},null);
      const result=rollbackFromSinks(manifest,ledger,store,channel,sdk); assert.ok(result.retained.length); assert.equal((await core.readHistory(session.sessionId,{limit:100})).items.some(x=>x.messageId==='new'),true); assert.equal(sdk.resolveDestination('chat','root'),'topic:old');
      const changed=JSON.parse(JSON.stringify(session)); changed.native.nativeSessionId='other'; assert.deepEqual(await archive.read(changed),[]);
      writeFileSync(`${old}-wal`,'modified'); await assert.rejects(core.readHistory(session.sessionId,{limit:10}),/archive source/);
    } finally {channel.close(); core.close(); store.close(); sdk.close();}
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('explicit checked transcript copy is read and tampering is rejected',async()=>{
  const {createHash}=await import('node:crypto'); const {HistoryArchive}=await import('../src/unified/history-archive.js'); const {UnifiedStore}=await import('../src/unified/store.js'); const {applyToSinks}=await import('../src/unified/migration.js');
  const root=mkdtempSync(join(tmpdir(),'transcript-copy-')); try {
    writeFileSync(join(root,'.migration-copy-root'),'fixture'); const old=join(root,'legacy'); const transcript=join(root,'copy.jsonl');
    const content=[{sessionId:'native',type:'user',uuid:'u',timestamp:'t',message:{role:'user',content:'transcript question'}},{sessionId:'native',type:'assistant',uuid:'a',timestamp:'t',message:{role:'assistant',content:[{type:'text',text:'transcript answer'}]}}].map(x=>JSON.stringify(x)).join('\n')+'\n'; writeFileSync(transcript,content);
    const db=new DatabaseSync(old); db.exec("CREATE TABLE sessions(session_id TEXT,cwd TEXT,path TEXT); INSERT INTO sessions VALUES('native','/project','/old/native.jsonl')"); db.close();
    const manifest=planMigration({copyRoot:root,sources:[{provider:'claude',path:old,hostId:'h',serviceId:'svc',snapshot:{id:'fixture',method:'fixture',evidence:'synthetic'}}],bindings:[],transcripts:[{provider:'claude',nativeSessionId:'native',sourcePath:'/old/native.jsonl',copyPath:transcript,sha256:createHash('sha256').update(content).digest('hex')}]});
    const store=new UnifiedStore(join(root,'core')); try {applyToSinks(manifest,join(root,'ledger'),store,{} as never); const archive=new HistoryArchive(root,manifest); const session=store.listSessions()[0]!; const text=JSON.stringify(await archive.read(session)); assert.match(text,/transcript question/);assert.match(text,/transcript answer/);writeFileSync(transcript,'changed');await assert.rejects(archive.read(session),/hash mismatch/);} finally {store.close();}
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Codex transcript uses native parser with required identity and unknown review',async()=>{
  const {createHash}=await import('node:crypto'); const {HistoryArchive}=await import('../src/unified/history-archive.js'); const {UnifiedStore}=await import('../src/unified/store.js'); const {applyToSinks}=await import('../src/unified/migration.js'); const root=mkdtempSync(join(tmpdir(),'codex-transcript-'));
  try {writeFileSync(join(root,'.migration-copy-root'),'fixture');const old=join(root,'old'),copy=join(root,'copy');const records=[{type:'session_meta',payload:{id:'native',cwd:'/p'}},{type:'response_item',timestamp:'t',payload:{type:'message',role:'user',content:[{type:'input_text',text:'question'}]}},{type:'response_item',timestamp:'t2',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'answer'}]}},{type:'future_record',payload:{text:'not executed'}}];const content=records.map(x=>JSON.stringify(x)).join('\n')+'\n';writeFileSync(copy,content);const db=new DatabaseSync(old);db.exec("CREATE TABLE sessions(session_id TEXT,cwd TEXT,path TEXT); INSERT INTO sessions VALUES('native','/p','/old/path')");db.close();
    const manifest=planMigration({copyRoot:root,sources:[{provider:'codex',path:old,hostId:'h',serviceId:'s',snapshot:{id:'fixture',method:'fixture',evidence:'synthetic'}}],bindings:[],transcripts:[{provider:'codex',nativeSessionId:'native',sourcePath:'/old/path',copyPath:copy,sha256:createHash('sha256').update(content).digest('hex')}]});const store=new UnifiedStore(join(root,'core'));try {applyToSinks(manifest,join(root,'ledger'),store,{} as never);const archive=new HistoryArchive(root,manifest), data=JSON.stringify(await archive.read(store.listSessions()[0]!));assert.match(data,/question/);assert.match(data,/answer/);assert.match(data,/future_record/);assert.doesNotMatch(data,/not executed/);}finally{store.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('rollback preserves the dependency group for activity in any sink and removes an idle group',async()=>{
  const {UnifiedStore}=await import('../src/unified/store.js'); const {FeishuChannel}=await import('../src/unified/feishu-channel.js'); const {FeishuSdkPort}=await import('../src/unified/feishu-sdk-port.js'); const {applyToSinks,rollbackFromSinks}=await import('../src/unified/migration.js');
  for(const kind of ['none','core','sdk','channel'] as const) {
    const root=mkdtempSync(join(tmpdir(),`rollback-${kind}-`)); try {
      writeFileSync(join(root,'.migration-copy-root'),'fixture');const old=join(root,'old'); const d=new DatabaseSync(old);d.exec("CREATE TABLE sessions(session_id TEXT,cwd TEXT,chat_id TEXT,root_message_id TEXT); INSERT INTO sessions VALUES('s','/p','chat','root')");d.close();
      const m=planMigration({copyRoot:root,sources:[{provider:'codex',path:old,hostId:'h',serviceId:'s',snapshot:{id:'fixture',method:'fixture',evidence:'fixture'}}],bindings:[{provider:'codex',nativeSessionId:'s',destination:'topic',owner:{source:'feishu',subject:'owner'},chatId:'chat',rootId:'root',appId:'app',scopeEvidence:'fixture'}]});
      const core=new UnifiedStore(join(root,'core')),channel=new FeishuChannel({} as never,{} as never,async()=>true,join(root,'channel')),sdk=new FeishuSdkPort({appId:'app',appSecret:'fake'},join(root,'sdk'),new Set(['chat']),'owner'),ledger=join(root,'ledger');
      try {applyToSinks(m,ledger,core,channel,sdk); const session=core.listSessions()[0]!;
        if(kind==='core') core.putMessage({messageId:'new',sessionId:session.sessionId,turnId:'t',role:'assistant',blocks:[{type:'text',text:'reply'}],sequence:1,revision:0,final:true,source:'fixture'},null);
        if(kind==='sdk') {const x=new DatabaseSync(join(root,'sdk'));x.prepare('INSERT INTO sdk_message_routes VALUES (?,?)').run('new-message','topic');x.close();}
        if(kind==='channel') {const x=new DatabaseSync(join(root,'channel'));x.prepare('INSERT INTO channel_known_messages VALUES (?,?,?,?)').run('topic',session.sessionId,'new',1);x.close();}
        if(kind==='none') {const blocker=new DatabaseSync(join(root,'sdk'));blocker.exec('BEGIN IMMEDIATE');try {assert.throws(()=>rollbackFromSinks(m,ledger,core,channel,sdk),/locked|busy/i);const probe=new DatabaseSync(join(root,'core'));try {probe.exec('BEGIN IMMEDIATE; ROLLBACK');} finally {probe.close();}} finally {blocker.exec('ROLLBACK');blocker.close();}}
        const result=rollbackFromSinks(m,ledger,core,channel,sdk);
        if(kind==='none') {assert.deepEqual(result.retained,[]);assert.equal(core.listSessions().length,0);assert.throws(()=>sdk.resolveDestination('chat','root'));assert.deepEqual(channel.boundDestinations(),[]);applyToSinks(m,ledger,core,channel,sdk);assert.equal(core.listSessions().length,1);assert.equal(sdk.resolveDestination('chat','root'),'topic');}
        else {assert.ok(result.retained.length,kind);assert.equal(core.listSessions().length,1,kind);assert.equal(sdk.resolveDestination('chat','root'),'topic');assert.deepEqual(channel.boundDestinations(),['topic']);assert.ok(rollbackFromSinks(m,ledger,core,channel,sdk).retained.length);}
      } finally {sdk.close();channel.close();core.close();}
    } finally {rmSync(root,{recursive:true,force:true});}
  }
});

test('partial rollback and lost ledger reconcile missing core from manifest without discarding SDK activity',async()=>{
  const {UnifiedStore}=await import('../src/unified/store.js'); const {FeishuChannel}=await import('../src/unified/feishu-channel.js'); const {FeishuSdkPort}=await import('../src/unified/feishu-sdk-port.js'); const {applyToSinks,rollbackFromSinks}=await import('../src/unified/migration.js');
  const root=mkdtempSync(join(tmpdir(),'rollback-partial-')); try {writeFileSync(join(root,'.migration-copy-root'),'fixture');const old=join(root,'old');const d=new DatabaseSync(old);d.exec("CREATE TABLE sessions(session_id TEXT,cwd TEXT,chat_id TEXT,root_message_id TEXT); INSERT INTO sessions VALUES('s','/p','chat','root')");d.close();
    const m=planMigration({copyRoot:root,sources:[{provider:'codex',path:old,hostId:'h',serviceId:'s',snapshot:{id:'fixture',method:'fixture',evidence:'fixture'}}],bindings:[{provider:'codex',nativeSessionId:'s',destination:'topic',owner:{source:'feishu',subject:'owner'},chatId:'chat',rootId:'root',appId:'app',scopeEvidence:'fixture'}]});const core=new UnifiedStore(join(root,'core')),channel=new FeishuChannel({} as never,{} as never,async()=>true,join(root,'channel')),sdk=new FeishuSdkPort({appId:'app',appSecret:'fake'},join(root,'sdk'),new Set(['chat']),'owner'),ledger=join(root,'ledger');
    try {applyToSinks(m,ledger,core,channel,sdk);const originalEnd=core.endMigrationRollback.bind(core);core.endMigrationRollback=(commit:boolean)=>{originalEnd(commit);if(commit) throw new Error('after core commit');}; assert.throws(()=>rollbackFromSinks(m,ledger,core,channel,sdk),/after core commit/);core.endMigrationRollback=originalEnd;assert.equal(core.listSessions().length,0);const x=new DatabaseSync(join(root,'sdk'));x.prepare('INSERT INTO sdk_message_routes VALUES (?,?)').run('new-message','topic');x.close();rmSync(ledger); const result=rollbackFromSinks(m,ledger,core,channel,sdk);assert.ok(result.retained.length);assert.equal(core.listSessions().length,1);assert.equal(sdk.resolveDestination('chat','root'),'topic');assert.deepEqual(channel.boundDestinations(),['topic']);} finally {sdk.close();channel.close();core.close();}
  } finally {rmSync(root,{recursive:true,force:true});}
});
