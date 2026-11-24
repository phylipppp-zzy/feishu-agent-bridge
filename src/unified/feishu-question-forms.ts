import type { Answer, Interaction } from './contracts.js';

/** Card JSON 2.0 form uses only components supported inside a form container. */
export const QUESTION_INPUT_MAX_LENGTH = 1000;
type Question = { id: string; prompt: string; choices: string[]; multiple: boolean; allowFreeText: boolean };
export interface QuestionForm {
  interactionId: string;
  revision: number;
  connectionGeneration: number;
  bindingId: string;
  questions: Question[];
  kind: 'question' | 'question_group';
  submittable: boolean;
  statusText?: string;
  submitValueFields?: Record<string, unknown>;
}
export interface FormAnswerAction {
  action: 'answer'; bindingId: string; interactionId: string; revision: number;
  connectionGeneration: number; answer: Extract<Answer, {kind:'question' | 'question_group'}>; toolInputDigest: null;
}
const plain = (content:string) => ({tag:'plain_text',content});
const record = (v:unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const available = (i:Interaction, readOnly:boolean, now:number): boolean => !readOnly && i.status === 'awaiting_answer' && (i.expiresAt === null || (Number.isFinite(Date.parse(i.expiresAt)) && Date.parse(i.expiresAt) > now));

/** Only authoritative interaction data may define questions and answer validity. */
export function questionForm(
  interaction: Interaction,
  bindingId: string,
  readOnly = false,
  now = Date.now(),
  submitValueFields?: Record<string, unknown>,
): QuestionForm {
  if (!bindingId || !Number.isFinite(now) || interaction.kind === 'approval') throw new Error('invalid question form');
  const questions:Question[] = interaction.kind === 'question' ? [{id:'question',prompt:interaction.prompt,choices:[...interaction.choices],multiple:interaction.multiple,allowFreeText:interaction.allowFreeText}] : interaction.questions.map(q=>({id:q.id,prompt:q.prompt,choices:[...q.choices],multiple:q.multiple !== false,allowFreeText:q.allowFreeText}));
  if (!questions.length || new Set(questions.map(q=>q.id)).size !== questions.length || questions.some(q=>!q.id || new Set(q.choices).size !== q.choices.length || q.choices.some(c=>!c.trim()) || (!q.choices.length && !q.allowFreeText))) throw new Error('invalid authoritative question');
  return {interactionId:interaction.interactionId,revision:interaction.revision,connectionGeneration:interaction.connectionGeneration,bindingId,kind:interaction.kind,questions,submittable:available(interaction,readOnly,now),...(submitValueFields ? {submitValueFields:{...submitValueFields}} : {})};
}
/** A complete schema 2.0 interactive card. Per-option yes/no selects preserve a real multiple-answer array. */
export function renderQuestionForm(form: QuestionForm): Record<string,unknown> {
  const elements:Record<string,unknown>[]=[];
  for (const [i,q] of form.questions.entries()) {
    elements.push({tag:'markdown',content:q.prompt});
    if (!form.submittable) continue;
    if (q.multiple) {
      for (const [j,choice] of q.choices.entries()) elements.push({tag:'select_static',name:`q${i}_c${j}`,element_id:`q${i}_c${j}`,placeholder:plain(choice),required:false,options:[{text:plain(`选择：${choice}`),value:'yes'},{text:plain(`不选择：${choice}`),value:'no'}]});
    } else if (q.choices.length) {
      elements.push({tag:'select_static',name:`q${i}_choice`,element_id:`q${i}_choice`,placeholder:plain('选择一个选项'),required:false,options:q.choices.map((c,j)=>({text:plain(c),value:String(j)}))});
    }
    if (q.allowFreeText) elements.push({tag:'input',name:`q${i}_text`,element_id:`q${i}_text`,required:false,placeholder:plain('输入文字答复'),max_length:QUESTION_INPUT_MAX_LENGTH,input_type:'multiline_text',rows:4,auto_resize:true,max_rows:8});
  }
  if (form.statusText) elements.push({tag:'markdown',content:form.statusText});
  if (!form.submittable) return {schema:'2.0',header:{title:plain('问题已不可答复')},body:{elements}};
  const metadata={...(form.submitValueFields ?? {}),action:'answer_form',bindingId:form.bindingId,interactionId:form.interactionId,revision:form.revision,connectionGeneration:form.connectionGeneration};
  elements.push({tag:'button',name:'submit_question',element_id:'submit_question',text:plain('提交答复'),type:'primary',form_action_type:'submit',behaviors:[{type:'callback',value:metadata}]});
  return {schema:'2.0',header:{title:plain('回答问题')},body:{elements:[{tag:'form',name:'question_form',element_id:'question_form',direction:'vertical',vertical_spacing:'8px',elements}]}};
}
/** Decode only form fields; metadata is compared with server-side current state and binding. */
export function decodeQuestionForm(value:unknown, fields:unknown, current:Interaction, bindingId:string, readOnly = false, now = Date.now()): FormAnswerAction {
  const form=questionForm(current,bindingId,readOnly,now);
  if (!form.submittable || !record(value) || value.action !== 'answer_form' || value.bindingId !== form.bindingId || value.interactionId !== form.interactionId || value.revision !== form.revision || value.connectionGeneration !== form.connectionGeneration || !record(fields)) throw new Error('expired or invalid form');
  const keys=new Set<string>(); const answers:Record<string,string[]> = Object.create(null) as Record<string,string[]>;
  for (const [i,q] of form.questions.entries()) {
    const selected:string[]=[];
    if (q.multiple) {
      for (const [j,choice] of q.choices.entries()) { const key=`q${i}_c${j}`;keys.add(key);const v=fields[key]; if (v !== undefined && v !== null && v !== '' && v !== 'yes' && v !== 'no') throw new Error('invalid selection'); if (v === 'yes') selected.push(choice); }
    } else if (q.choices.length) {
      const key=`q${i}_choice`;keys.add(key);const v=fields[key];
      if (v !== undefined && v !== null && v !== '') { if (typeof v !== 'string' || !/^(0|[1-9]\d*)$/.test(v) || Number(v) >= q.choices.length) throw new Error('invalid selection'); selected.push(q.choices[Number(v)]!); }
    }
    if (q.allowFreeText) { const key=`q${i}_text`; keys.add(key); const v=fields[key]; if (v !== undefined && v !== null && typeof v !== 'string') throw new Error('invalid text'); if (typeof v === 'string' && [...v].length > QUESTION_INPUT_MAX_LENGTH) throw new Error('text too long'); if (typeof v === 'string' && v.trim()) selected.push(v); }
    if (!selected.length || (!q.multiple && selected.length !== 1) || new Set(selected).size !== selected.length) throw new Error('invalid answer');
    answers[q.id]=selected;
  }
  if (Object.keys(fields).some(k=>!keys.has(k))) throw new Error('unexpected form field');
  const answer:FormAnswerAction['answer'] = form.kind === 'question' ? {kind:'question',values:answers.question!} : {kind:'question_group',answers};
  return {action:'answer',bindingId:form.bindingId,interactionId:form.interactionId,revision:form.revision,connectionGeneration:form.connectionGeneration,answer,toolInputDigest:null};
}
