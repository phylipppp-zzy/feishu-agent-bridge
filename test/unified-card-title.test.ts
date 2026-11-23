import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toFeishuCard} from '../src/unified/feishu-codec.js';

test('unnamed native and migrated sessions always produce a usable card header',()=>{
  for(const title of ['', '  \n']) {
    const card=toFeishuCard({title,text:'session',actions:[]}) as {header:{title:{content:string}}};
    assert.equal(card.header.title.content,'未命名会话');
  }
  const named=toFeishuCard({title:'Codex 会话',text:'session',actions:[]}) as {header:{title:{content:string}}};
  assert.equal(named.header.title.content,'Codex 会话');
});
