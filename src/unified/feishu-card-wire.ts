import type { ChannelCard } from './feishu-cards.js';
import type { QuestionForm } from './feishu-question-forms.js';

export const QUESTION_INPUT_MAX_LENGTH = 1000;
export type CardSchema = NonNullable<ChannelCard['schema']>;
export const cardSchema = (card: ChannelCard): CardSchema => card.schema ?? (card.form ? '2.0' : '1.0');

const plain = (content: string) => ({ tag: 'plain_text', content });
const markdown = (content: string) => ({ tag: 'markdown', content: stripCardMentions(content) });

export function stripCardMentions(text: string): string {
  return text.replace(/<at\b[^>]*>[\s\S]*?<\/at\s*>|<\/?at\b[^>]*>/giu, '');
}

/** Escape a literal field before interpolating it into a Markdown card. */
export function escapeCardMarkdown(text: string): string {
  return stripCardMentions(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~$-]/g, '\\$&');
}

function header(card: ChannelCard) {
  return {
    ...(card.template ? { template: card.template } : {}),
    title: plain(card.title.trim() || '未命名会话'),
  };
}

function cardElements(card: ChannelCard, omitEmpty = false): unknown[] {
  if (!card.table) {
    if (omitEmpty && !card.text.trim()) return [];
    return [card.format === 'plain' ? { tag: 'div', text: plain(card.text) } : markdown(card.text)];
  }
  const table = card.table;
  const renderColumns = (cells: string[], bold: boolean) => table.columns.map((col, idx) => ({
    tag: 'column',
    width: 'weighted',
    weight: col.weight ?? 1,
    vertical_align: 'top',
    elements: [{
      tag: 'div',
      text: { tag: 'lark_md', content: stripCardMentions(bold ? `**${cells[idx] ?? col.header}**` : (cells[idx] ?? '')) },
    }],
  }));
  return [
    {
      tag: 'column_set',
      flex_mode: 'none',
      background_style: 'grey',
      columns: renderColumns(table.columns.map(c => c.header), true),
    },
    { tag: 'hr' },
    ...table.rows.map(row => ({ tag: 'column_set', flex_mode: 'none', columns: renderColumns(row, false) })),
    ...(table.footer ? [{ tag: 'div', text: { tag: 'lark_md', content: stripCardMentions(table.footer) } }] : []),
  ];
}

function executionElements(log: ChannelCard['executionLog'], schema: CardSchema): unknown[] {
  if (!log || (!log.count && !log.lines.length && !log.runningNote)) return [];
  const title = `执行记录（${log.count} 项${log.failedCount ? `，失败 ${log.failedCount} 项` : ''}）`;
  const lines = log.lines.map(escapeCardMarkdown);
  const status = log.runningNote ? [markdown(escapeCardMarkdown(log.runningNote))] : [];
  if (schema === '1.0') return [...status, markdown([`**${title}**`, ...lines].join('\n'))];
  return [...status, {
    tag: 'collapsible_panel',
    element_id: 'execution_log',
    expanded: false,
    header: { title: markdown(title) },
    elements: lines.length ? [markdown(lines.join('\n'))] : [],
  }];
}

function questionElements(form: QuestionForm): unknown[] {
  const elements: Record<string, unknown>[] = [];
  for (const [i, q] of form.questions.entries()) {
    elements.push(markdown(q.prompt));
    if (!form.submittable) continue;
    if (q.choices.length) {
      const name = q.multiple ? `q${i}_multi` : `q${i}_choice`;
      elements.push({
        tag: q.multiple ? 'multi_select_static' : 'select_static',
        name,
        element_id: name,
        placeholder: plain(q.multiple ? '可多选' : '选择一个选项'),
        required: false,
        options: q.choices.map((content, j) => ({ text: plain(content), value: String(j) })),
      });
    }
    if (q.allowFreeText) {
      const name = `q${i}_text`;
      elements.push({
        tag: 'input', name, element_id: name, required: false, placeholder: plain('输入文字答复'),
        max_length: QUESTION_INPUT_MAX_LENGTH, input_type: 'multiline_text', rows: 4, auto_resize: true, max_rows: 8,
      });
    }
  }
  if (form.statusText) elements.push(markdown(form.statusText));
  if (!form.submittable) return elements;
  const value = {
    ...form.submitValueFields,
    action: 'answer_form',
    bindingId: form.bindingId,
    interactionId: form.interactionId,
    revision: form.revision,
    connectionGeneration: form.connectionGeneration,
  };
  elements.push({
    tag: 'button', name: 'submit_question', element_id: 'submit_question', text: plain('提交答复'),
    type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value }],
  });
  return [{ tag: 'form', name: 'question_form', element_id: 'question_form', direction: 'vertical', vertical_spacing: '8px', elements }];
}

function actionsV2(actions: ChannelCard['actions']): unknown[] {
  const buttons = actions.map(a => ({
    tag: 'button',
    text: plain(a.label),
    type: a.type ?? 'default',
    behaviors: [a.url ? { type: 'open_url', default_url: a.url } : { type: 'callback', value: a.value }],
  }));
  if (buttons.length < 2) return buttons;
  return [{
    tag: 'column_set',
    flex_mode: 'flow',
    columns: buttons.map(button => ({ tag: 'column', width: 'auto', elements: [button] })),
  }];
}

function encodeV2(card: ChannelCard, form?: QuestionForm): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: header(card),
    body: {
      elements: [
        ...cardElements(card, !!form),
        ...(form ? questionElements(form) : []),
        ...executionElements(card.executionLog, '2.0'),
        ...actionsV2(card.actions),
      ],
    },
  };
}

export function renderQuestionForm(form: QuestionForm, card?: ChannelCard): Record<string, unknown> {
  return encodeV2(card ?? { title: form.submittable ? '回答问题' : '问题已不可答复', text: '', actions: [] }, form);
}

export function encodeCard(card: ChannelCard, forceSchema?: CardSchema): Record<string, unknown> {
  if ((forceSchema ?? cardSchema(card)) === '2.0') {
    return card.form ? renderQuestionForm(card.form, card) : encodeV2(card);
  }
  const elements = [...cardElements(card), ...executionElements(card.executionLog, '1.0')];
  if (card.actions.length) {
    elements.push({
      tag: 'action',
      actions: card.actions.map(a => ({
        tag: 'button',
        text: plain(a.label),
        type: a.type ?? 'default',
        ...(a.url ? { url: a.url } : { value: a.value }),
      })),
    });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: header(card),
    elements,
  };
}
