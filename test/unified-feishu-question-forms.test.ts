import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { questionForm, renderQuestionForm, decodeQuestionForm } from '../src/unified/feishu-question-forms.js';
import { encodeCard, escapeCardMarkdown } from '../src/unified/feishu-card-wire.js';
import { FeishuSdkPort } from '../src/unified/feishu-sdk-port.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import type { Interaction } from '../src/unified/contracts.js';

const base = {interactionId:'i',sessionId:'s',turnId:'t',nativeRequestId:'n',connectionGeneration:2,revision:3,status:'awaiting_answer',expiresAt:null,toolInputDigest:null,nativeResult:null} as const;
const metadata = {action:'answer_form',bindingId:'binding',interactionId:'i',revision:3,connectionGeneration:2};
test('single choice and free text allow free text override for a single answer',()=>{
 const i:Interaction={...base,kind:'question',prompt:'What?',choices:['a','b'],multiple:false,allowFreeText:true};
 assert.deepEqual(decodeQuestionForm(metadata,{q0_choice:'1'},i,'binding').answer,{kind:'question',values:['b']});
 assert.deepEqual(decodeQuestionForm(metadata,{q0_text:'free, text'},i,'binding').answer,{kind:'question',values:['free, text']});
 assert.deepEqual(decodeQuestionForm(metadata,{q0_choice:'0',q0_text:'other'},i,'binding').answer,{kind:'question',values:['other']});
 assert.throws(()=>decodeQuestionForm(metadata,{q0_choice:'5'},i,'binding'),/invalid selection/);
 assert.throws(()=>decodeQuestionForm(metadata,{q0_text:'x'.repeat(1001)},i,'binding'),/too long/);
});
test('multiple answers and grouped questions preserve arrays without comma splitting',()=>{
 const i:Interaction={...base,kind:'question_group',questions:[{id:'first',prompt:'Pick',choices:['a,b','c'],multiple:true,allowFreeText:true},{id:'second',prompt:'Text',choices:[],multiple:false,allowFreeText:true}]};
 for (const choices of [{q0_multi:['0','1']}, {q0_c0:'yes',q0_c1:'yes'}]) {
  const out=decodeQuestionForm(metadata,{...choices,q0_text:'extra, value',q1_text:'hello'},i,'binding');
  assert.deepEqual({...((out.answer as {answers:Record<string,string[]>}).answers)},{first:['a,b','c','extra, value'],second:['hello']});
 }
 for (const invalid of [
  {q0_multi:'0'}, {q0_multi:[0]}, {q0_multi:['01']}, {q0_multi:['-1']}, {q0_multi:['2']},
  {q0_multi:['0','0']}, {q0_multi:['0'],q0_c1:'no'},
 ]) assert.throws(()=>decodeQuestionForm(metadata,{...invalid,q1_text:'hello'},i,'binding'),/invalid selection/);
 assert.throws(()=>decodeQuestionForm(metadata,{q0_multi:['0'],q0_c2:'no',q1_text:'hello'},i,'binding'),/unexpected form field/);
 const card=renderQuestionForm(questionForm(i,'binding')); const text=JSON.stringify(card);
 assert.match(text,/"tag":"form"/);assert.doesNotMatch(text,/"tag":"select_static"/);assert.match(text,/"max_length":1000/);
 const { body } = card as {body:{elements:Array<{elements: unknown[]}>}};
 assert.deepEqual(body.elements[0]!.elements[1], {
  tag:'multi_select_static',name:'q0_multi',element_id:'q0_multi',
  placeholder:{tag:'plain_text',content:'可多选'},required:false,
  options:[{text:{tag:'plain_text',content:'a,b'},value:'0'},{text:{tag:'plain_text',content:'c'},value:'1'}],
 });
});

test('card wire keeps form framing, uses versioned actions, and preserves natural Markdown', () => {
 const i:Interaction={...base,kind:'question',prompt:'q',choices:['a'],multiple:false,allowFreeText:false};
 const markdown='源会话说明 **加粗**\n```\nexample\n```';
 const card:ChannelCard={
  title:'【待处理】问题',text:markdown,template:'orange',
  form:questionForm(i,'binding'),
  actions:[{ label:'源话题',url:'https://example.test/topic',value:{} }],
 };
 const encoded=encodeCard(card);
 assert.deepEqual(encoded.header,{template:'orange',title:{tag:'plain_text',content:card.title}});
 const {elements} = encoded.body as {elements:Array<Record<string,unknown>>};
 assert.deepEqual(elements.map(e=>e.tag),['markdown','form','button']);
 assert.equal(elements[0]!.content,markdown);
 const withMention = {title:'回复',text:markdown+'<at id=all>不会显示</at>',actions:[]};
 assert.deepEqual(encodeCard(withMention).elements,[{tag:'markdown',content:markdown}]);
 assert.deepEqual(elements[2]!.behaviors,[{type:'open_url',default_url:'https://example.test/topic'}]);
 const plain:ChannelCard={title:'纯文本',text:'**字面**',format:'plain',actions:[]};
 assert.deepEqual(encodeCard(plain).elements,[{tag:'div',text:{tag:'plain_text',content:'**字面**'}}]);
 assert.equal(escapeCardMarkdown('<AT id=all>所有人</at>[文件](地址)*'),'\\[文件\\]\\(地址\\)\\*');
 const executionLog = {count:2,lines:['read <at id=all>不应显示</at>file'],failedCount:1,runningNote:'⏳ 正在执行：[读取中]'};
 const logCard = {title:'回复',text:markdown,actions:[],executionLog};
 const v1 = encodeCard(logCard);
 const v2 = encodeCard(logCard,'2.0');
 assert.match(JSON.stringify(v1),/执行记录（2 项，失败 1 项）/);
 const {elements: logElements} = v2.body as {elements: Array<Record<string,unknown>>};
 assert.deepEqual(logElements.slice(1),[
  {tag:'markdown',content:'⏳ 正在执行：\\[读取中\\]'},
  {tag:'collapsible_panel',element_id:'execution_log',expanded:false,
   header:{title:{tag:'markdown',content:'执行记录（2 项，失败 1 项）'}},
   elements:[{tag:'markdown',content:'read file'}]},
 ]);
 const onlyNote = encodeCard({...logCard,executionLog:{count:1,lines:[],runningNote:executionLog.runningNote}},'2.0');
 const {elements: onlyNoteElements} = onlyNote.body as {elements: unknown[]};
 assert.deepEqual(onlyNoteElements[1],logElements[1]);
 assert.doesNotMatch(JSON.stringify(v2),/不应显示|<at/);
});

test('SDK PATCH honors persisted schema pins when a form is replaced after restart', async () => {
 const dir=mkdtempSync(join(tmpdir(),'unified-card-schema-'));
 const dbPath=join(dir,'sdk.sqlite');
 const patches:Array<Record<string,unknown>>=[];
 const createPort = () => {
  const port = new FeishuSdkPort({appId:'app',appSecret:'fixture'},dbPath,new Set(['chat']),'owner');
  Object.assign(port,{client:{im:{message:{
   create:async()=>({code:0,data:{message_id:'root'}}),
   reply:async()=>({code:0,data:{message_id:'question'}}),
   patch:async({data}:{data:{content:string}})=>{patches.push(JSON.parse(data.content));return {code:0};},
  }}}});
  return port;
 };
 const i:Interaction={...base,kind:'question',prompt:'q',choices:['a'],multiple:false,allowFreeText:false};
 const ordinary:ChannelCard={title:'会话',text:'Markdown 正文',actions:[]};
 let port=createPort();
 try {
  const destination = await port.createTopic('chat','session',ordinary,'create');
  await port.send(destination,{...ordinary,form:questionForm(i,'binding')},'send');
  const db=new DatabaseSync(dbPath);
  try {
   const rows=db.prepare('SELECT message_id,schema_version FROM sdk_card_schemas ORDER BY message_id').all();
   assert.deepEqual(rows.map(row=>({...row})),[
    {message_id:'question',schema_version:'2.0'},{message_id:'root',schema_version:'1.0'},
   ]);
  } finally {db.close();}
  port.close();
  port=createPort();
  const actions = [{label:'打开',url:'https://example.test/topic',value:{}},{label:'返回',value:{action:'history'}}];
  await port.update(destination,'question',{...ordinary,actions},'retire');
  await port.update(destination,'root',{...ordinary,schema:'2.0'},'title');
  assert.deepEqual(patches.map(card=>card.schema),['2.0',undefined]);
  const {elements}=patches[0]!.body as {elements:Array<Record<string,unknown>>};
  assert.deepEqual(elements[1],{tag:'column_set',flex_mode:'flow',columns:[
   {tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content:'打开'},type:'default',behaviors:[{type:'open_url',default_url:actions[0]!.url}]}]},
   {tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content:'返回'},type:'default',behaviors:[{type:'callback',value:{action:'history'}}]}]},
  ]});
 } finally {port.close();rmSync(dir,{recursive:true,force:true});}
});
test('readonly, expired, resolved, stale binding or fields cannot submit',()=>{
 const i:Interaction={...base,kind:'question',prompt:'q',choices:['a'],multiple:false,allowFreeText:false};
 for(const view of [questionForm(i,'binding',true),questionForm({...i,status:'resolved'},'binding'),questionForm({...i,expiresAt:'2020-01-01T00:00:00Z'},'binding')]) assert.doesNotMatch(JSON.stringify(renderQuestionForm(view)),/form_action_type/);
 for(const m of [{...metadata,bindingId:'wrong'},{...metadata,revision:2},{...metadata,connectionGeneration:1},{...metadata,interactionId:'other'}]) assert.throws(()=>decodeQuestionForm(m,{q0_choice:'0'},i,'binding'));
 assert.throws(()=>decodeQuestionForm(metadata,{q0_choice:'0',identity:'attacker'},i,'binding'),/unexpected/);
 assert.throws(()=>decodeQuestionForm({...metadata,answer:{kind:'approval'}},{q0_choice:['0']},i,'binding'),/invalid selection/);
 assert.throws(()=>decodeQuestionForm(metadata,{q0_choice:'0'},i,'binding',true));
});
