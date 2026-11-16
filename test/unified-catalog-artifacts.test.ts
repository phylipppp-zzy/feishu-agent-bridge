import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCatalog } from '../src/unified/local-catalog.js';
import { ArtifactRegistry } from '../src/unified/artifact-registry.js';

const jsonl = (...items: unknown[]) => items.map(x=>JSON.stringify(x)).join('\n')+'\n';
test('provider catalogs preserve native refs, stable pages and incremental history across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(),'catalog-'));
  try {
    const codex = join(dir,'codex'), claude = join(dir,'claude'); await mkdir(codex); await mkdir(claude);
    const codexRecord = (id: string) => jsonl({type:'session_meta',payload:{id,cwd:'/same'}},{type:'response_item',timestamp:'2026-01-01',payload:{type:'message',role:'user',content:[{type:'input_text',text:'same'}]}});
    await writeFile(join(codex,'a.jsonl'),codexRecord('c1')); await writeFile(join(codex,'b.jsonl'),codexRecord('c2'));
    await writeFile(join(codex,'null.jsonl'),jsonl({type:'session_meta',payload:{id:null,cwd:null}}));
    const claudeRecord = (id: string) => jsonl({type:'user',uuid:id,cwd:'/same',message:{content:'same'}});
    await writeFile(join(claude,'a.jsonl'),claudeRecord('a')); await writeFile(join(claude,'b.jsonl'),claudeRecord('b'));
    const roots = [{provider:'codex' as const,directory:codex,hostId:'h',serviceId:'s'}, {provider:'claude' as const,directory:claude,hostId:'h',serviceId:'s'}];
    const catalog = new LocalCatalog(roots); await catalog.refresh();
    const first = catalog.list(2,undefined,'same'), second = catalog.list(2,first.nextCursor!,'same');
    assert.equal(first.items.length,2); assert.equal(second.items.length,2); assert.equal(second.nextCursor,null);
    assert.equal(new Set([...first.items,...second.items].map(s=>s.sessionId)).size,4);
    for (const s of [...first.items,...second.items]) { assert.equal(s.status,'read_only'); assert.equal(s.control.owner,null); assert.equal(s.capabilities.send.status,'unsupported'); }
    for (const provider of ['codex','claude'] as const) {
      const s = [...first.items,...second.items].find(x=>x.native.provider===provider)!;
      const history = catalog.history(s.native,1); assert.equal(history.items.length,1);
      const path = provider === 'codex' ? join(codex, s.native.nativeSessionId === 'c1' ? 'a.jsonl' : 'b.jsonl') : join(claude,`${s.native.nativeSessionId}.jsonl`);
      await appendFile(path, provider === 'codex' ? jsonl({type:'response_item',timestamp:'2026-01-02',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'new'}]}}) : jsonl({type:'assistant',uuid:'new',message:{content:[{type:'text',text:'new'}]}}));
      const restarted = new LocalCatalog(roots); await restarted.refresh();
      const delta = restarted.history(s.native,10,history.nextCursor!); assert.equal(delta.items.length,1); assert.equal(delta.items[0]?.blocks[0]?.type,'text');
      const other = [...first.items,...second.items].find(x=>x.sessionId!==s.sessionId)!;
      assert.throws(()=>restarted.history(other.native,10,history.nextCursor!));
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('artifact registry enforces roots, session, version, size and pagination', async () => {
  const dir = await mkdtemp(join(tmpdir(),'artifacts-'));
  try {
    const root = join(dir,'root'), outside = join(dir,'private'); await mkdir(root); await writeFile(outside,'secret');
    const a = join(root,'a.txt'), b = join(root,'b.txt'); await writeFile(a,'one'); await writeFile(b,'two'); await symlink(outside,join(root,'escape'));
    const registry = new ArtifactRegistry({s:[root],other:[root]},8);
    await assert.rejects(registry.register('s',join(root,'escape'))); await assert.rejects(registry.register('s',outside));
    const one = await registry.register('s',a,'text/plain'); await registry.register('s',b);
    const p = registry.list('s',1); assert.equal(p.items.length,1); assert.equal(registry.list('s',1,p.nextCursor!).items.length,1); assert.throws(()=>registry.list('other',1,p.nextCursor!));
    assert.equal(Buffer.from(await registry.read('s',one.artifactId,one.contentVersion)).toString(),'one');
    await assert.rejects(registry.read('other',one.artifactId,one.contentVersion));
    await writeFile(a,'changed'); await assert.rejects(registry.read('s',one.artifactId,one.contentVersion));
    const next = await registry.register('s',a); assert.notEqual(next.contentVersion,one.contentVersion); await assert.rejects(registry.read('s',one.artifactId,one.contentVersion));
    await writeFile(a,'012345678'); await assert.rejects(registry.register('s',a));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
