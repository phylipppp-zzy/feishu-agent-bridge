import type { Answer, Interaction } from './contracts.js';
import { QUESTION_INPUT_MAX_LENGTH } from './feishu-card-wire.js';

/** Card JSON 2.0 form uses only components supported inside a form container. */
export { QUESTION_INPUT_MAX_LENGTH, renderQuestionForm } from './feishu-card-wire.js';
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
function choiceIndex(value: unknown, count: number): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || Number(value) >= count) {
    throw new Error('invalid selection');
  }
  return Number(value);
}

function multipleChoices(fields: Record<string, unknown>, keys: Set<string>, index: number, choices: string[]): string[] {
  const multiKey = `q${index}_multi`;
  const legacyKeys = choices.map((_, j) => `q${index}_c${j}`);
  keys.add(multiKey);
  for (const key of legacyKeys) keys.add(key);
  if (Object.hasOwn(fields, multiKey)) {
    const values = fields[multiKey];
    if (!Array.isArray(values) || legacyKeys.some(key => Object.hasOwn(fields, key))) throw new Error('invalid selection');
    const indices = Array.from(values, value => choiceIndex(value, choices.length));
    if (new Set(indices).size !== indices.length) throw new Error('invalid selection');
    return indices.map(j => choices[j]!);
  }
  return choices.filter((_, j) => {
    const value = fields[legacyKeys[j]!];
    if (value !== undefined && value !== null && value !== '' && value !== 'yes' && value !== 'no') {
      throw new Error('invalid selection');
    }
    return value === 'yes';
  });
}

/** Decode only form fields; metadata is compared with server-side current state and binding. */
export function decodeQuestionForm(value:unknown, fields:unknown, current:Interaction, bindingId:string, readOnly = false, now = Date.now()): FormAnswerAction {
  const form=questionForm(current,bindingId,readOnly,now);
  if (!form.submittable || !record(value) || value.action !== 'answer_form' || value.bindingId !== form.bindingId || value.interactionId !== form.interactionId || value.revision !== form.revision || value.connectionGeneration !== form.connectionGeneration || !record(fields)) throw new Error('expired or invalid form');
  const keys=new Set<string>(); const answers:Record<string,string[]> = Object.create(null) as Record<string,string[]>;
  for (const [i,q] of form.questions.entries()) {
    const selected:string[]=[];
    if (q.multiple && q.choices.length) {
      selected.push(...multipleChoices(fields, keys, i, q.choices));
    } else if (q.choices.length) {
      const key=`q${i}_choice`;keys.add(key);const v=fields[key];
      if (v !== undefined && v !== null && v !== '') selected.push(q.choices[choiceIndex(v, q.choices.length)]!);
    }
    if (q.allowFreeText) { const key=`q${i}_text`; keys.add(key); const v=fields[key]; if (v !== undefined && v !== null && typeof v !== 'string') throw new Error('invalid text'); if (typeof v === 'string' && [...v].length > QUESTION_INPUT_MAX_LENGTH) throw new Error('text too long'); if (typeof v === 'string' && v.trim()) selected.push(v); }
    if (!selected.length || (!q.multiple && selected.length !== 1) || new Set(selected).size !== selected.length) throw new Error('invalid answer');
    answers[q.id]=selected;
  }
  if (Object.keys(fields).some(k=>!keys.has(k))) throw new Error('unexpected form field');
  const answer:FormAnswerAction['answer'] = form.kind === 'question' ? {kind:'question',values:answers.question!} : {kind:'question_group',answers};
  return {action:'answer',bindingId:form.bindingId,interactionId:form.interactionId,revision:form.revision,connectionGeneration:form.connectionGeneration,answer,toolInputDigest:null};
}
