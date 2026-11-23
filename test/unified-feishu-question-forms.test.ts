import test from 'node:test';
import assert from 'node:assert/strict';
import { questionForm, renderQuestionForm, decodeQuestionForm } from '../src/unified/feishu-question-forms.js';
import type { Interaction } from '../src/unified/contracts.js';

const base = {interactionId:'i',sessionId:'s',turnId:'t',nativeRequestId:'n',connectionGeneration:2,revision:3,status:'awaiting_answer',expiresAt:null,toolInputDigest:null,nativeResult:null} as const;
const metadata = {action:'answer_form',bindingId:'binding',interactionId:'i',revision:3,connectionGeneration:2};
test('single choice and free text are distinct, mutually exclusive for a single answer',()=>{
 const i:Interaction={...base,kind:'question',prompt:'What?',choices:['a','b'],multiple:false,allowFreeText:true};
 assert.deepEqual(decodeQuestionForm(metadata,{q0_choice:'1'},i,'binding').answer,{kind:'question',values:['b']});
 assert.deepEqual(decodeQuestionForm(metadata,{q0_text:'free, text'},i,'binding').answer,{kind:'question',values:['free, text']});
 assert.throws(()=>decodeQuestionForm(metadata,{q0_choice:'0',q0_text:'other'},i,'binding'),/invalid answer/);
 assert.throws(()=>decodeQuestionForm(metadata,{q0_choice:'5'},i,'binding'),/invalid selection/);
 assert.throws(()=>decodeQuestionForm(metadata,{q0_text:'x'.repeat(1001)},i,'binding'),/too long/);
});
test('multiple answers and grouped questions preserve arrays without comma splitting',()=>{
 const i:Interaction={...base,kind:'question_group',questions:[{id:'first',prompt:'Pick',choices:['a,b','c'],multiple:true,allowFreeText:true},{id:'second',prompt:'Text',choices:[],multiple:false,allowFreeText:true}]};
 const out=decodeQuestionForm(metadata,{q0_c0:'yes',q0_c1:'yes',q0_text:'extra, value',q1_text:'hello'},i,'binding');
 assert.deepEqual({...((out.answer as {answers:Record<string,string[]>}).answers)},{first:['a,b','c','extra, value'],second:['hello']});
 const card=renderQuestionForm(questionForm(i,'binding')); const text=JSON.stringify(card);
 assert.match(text,/"tag":"form"/);assert.match(text,/"tag":"select_static"/);assert.doesNotMatch(text,/multi_select_static/);assert.match(text,/"max_length":1000/);
});
test('readonly, expired, resolved, stale binding or fields cannot submit',()=>{
 const i:Interaction={...base,kind:'question',prompt:'q',choices:['a'],multiple:false,allowFreeText:false};
 for(const view of [questionForm(i,'binding',true),questionForm({...i,status:'resolved'},'binding'),questionForm({...i,expiresAt:'2020-01-01T00:00:00Z'},'binding')]) assert.doesNotMatch(JSON.stringify(renderQuestionForm(view)),/form_action_type/);
 for(const m of [{...metadata,bindingId:'wrong'},{...metadata,revision:2},{...metadata,connectionGeneration:1},{...metadata,interactionId:'other'}]) assert.throws(()=>decodeQuestionForm(m,{q0_choice:'0'},i,'binding'));
 assert.throws(()=>decodeQuestionForm(metadata,{q0_choice:'0',identity:'attacker'},i,'binding'),/unexpected/);
 assert.throws(()=>decodeQuestionForm({...metadata,answer:{kind:'approval'}},{q0_choice:['0']},i,'binding'),/invalid selection/);
 assert.throws(()=>decodeQuestionForm(metadata,{q0_choice:'0'},i,'binding',true));
});
