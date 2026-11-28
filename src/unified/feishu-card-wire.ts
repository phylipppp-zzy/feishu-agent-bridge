import type { ChannelCard } from './feishu-cards.js';
import type { QuestionForm } from './feishu-question-forms.js';

export const QUESTION_INPUT_MAX_LENGTH = 1000;
export type CardSchema = NonNullable<ChannelCard['schema']>;

const GFM_TABLE_RE = /^\|.+\|\s*\r?\n\|[\s:|-]+\|/m;
const DETAILS_OPEN_RE = /<details\b[^>]*>/iu;
const DETAILS_CLOSE_RE = /<\/details>/iu;
const SUMMARY_TAG_RE = /<summary\b[^>]*>([\s\S]*?)<\/summary>/iu;

interface DetailsRange {
  start: number;
  end: number;
  inner: string;
}

/** Find <details>...</details> ranges strictly outside fenced Markdown code blocks. */
function findDetailsOutsideFences(text: string): DetailsRange[] {
  const ranges: DetailsRange[] = [];
  const fencedIntervals: Array<[number, number]> = [];
  let pos = 0;
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;
  let fenceStart = 0;

  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl + 1;
    const line = text.slice(pos, nl === -1 ? text.length : nl).replace(/\r$/, '');
    const m = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const run = m[1]!;
      const ch = run[0] as '`' | '~';
      if (!fenceChar) {
        fenceChar = ch;
        fenceLen = run.length;
        fenceStart = pos;
      } else if (ch === fenceChar && run.length >= fenceLen && line.trim() === run) {
        fencedIntervals.push([fenceStart, lineEnd]);
        fenceChar = null;
        fenceLen = 0;
      }
    }
    pos = lineEnd;
  }
  if (fenceChar) fencedIntervals.push([fenceStart, text.length]);

  const inFence = (index: number): boolean =>
    fencedIntervals.some(([s, e]) => index >= s && index < e);

  let cursor = 0;
  while (cursor < text.length) {
    const slice = text.slice(cursor);
    const openMatch = DETAILS_OPEN_RE.exec(slice);
    if (!openMatch) break;
    const openStart = cursor + openMatch.index;
    const openEnd = openStart + openMatch[0].length;
    if (inFence(openStart)) {
      cursor = openEnd;
      continue;
    }
    let searchClose = openEnd;
    let foundClose: { start: number; end: number } | null = null;
    while (searchClose < text.length) {
      const closeMatch = DETAILS_CLOSE_RE.exec(text.slice(searchClose));
      if (!closeMatch) break;
      const closeStart = searchClose + closeMatch.index;
      const closeEnd = closeStart + closeMatch[0].length;
      if (!inFence(closeStart)) {
        foundClose = { start: closeStart, end: closeEnd };
        break;
      }
      searchClose = closeEnd;
    }
    if (!foundClose) break;
    ranges.push({ start: openStart, end: foundClose.end, inner: text.slice(openEnd, foundClose.start) });
    cursor = foundClose.end;
  }
  return ranges;
}

function hasRichMarkdownV2(card: ChannelCard): boolean {
  if (card.format === 'plain' || card.table) return false;
  if (card.sections?.length || card.headerTags?.length || card.subtitle) return true;
  if (card.executionLog) return true;
  return GFM_TABLE_RE.test(card.text) || findDetailsOutsideFences(card.text).length > 0;
}

export const cardSchema = (card: ChannelCard): CardSchema =>
  card.schema ?? (card.form || hasRichMarkdownV2(card) ? '2.0' : '1.0');

const plain = (content: string) => ({ tag: 'plain_text', content });
const markdown = (content: string) => ({ tag: 'markdown', content: stripCardMentions(content) });

export function stripCardMentions(text: string): string {
  return text.replace(/<at\b[^>]*>[\s\S]*?<\/at\s*>|<\/?at\b[^>]*>/giu, '');
}

/** Escape a literal field before interpolating it into a Markdown card.
 * Underscores inside identifiers and hyphens outside block syntax are literal. */
export function escapeCardMarkdown(text: string): string {
  return stripCardMentions(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*{}\[\]()#+.!|~$]/g, '\\$&')
    .replace(/(?<![\p{L}\p{N}_])_+|_+(?![\p{L}\p{N}_])/gu, run => run.replace(/_/g, '\\_'))
    .replace(/(^[ \t]*)-(?=[ \t]|-+\s*$|$)/gm, '$1\\-');
}

function header(card: ChannelCard, schema: CardSchema = '1.0') {
  const subtitle = card.subtitle?.trim();
  const tags = schema === '2.0' && card.headerTags?.length
    ? card.headerTags
        .filter(t => t.text.trim().length > 0)
        .map(t => ({
          tag: 'text_tag',
          text: plain(t.text.trim()),
          color: t.color ?? 'neutral',
        }))
    : undefined;
  return {
    ...(card.template ? { template: card.template } : {}),
    title: plain(card.title.trim() || '未命名会话'),
    ...(subtitle ? { subtitle: plain(subtitle) } : {}),
    ...(tags?.length ? { text_tag_list: tags } : {}),
  };
}

const MAX_V2_MARKDOWN_CHUNK_CHARS = 5500;

function splitMarkdownForV2(text: string): string[] {
  if (text.length <= MAX_V2_MARKDOWN_CHUNK_CHARS) return [text];
  // Group into atomic blocks (paragraphs or complete fenced code blocks).
  const blocks: string[] = [];
  const lines = text.split('\n');
  let cur: string[] = [];
  let openFence: string | null = null;
  const flushBlock = () => {
    const joined = cur.join('\n').trim();
    if (joined) blocks.push(joined);
    cur = [];
  };
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!openFence) openFence = marker;
      else if (line.trim().startsWith(openFence[0]!.repeat(openFence.length))) openFence = null;
    }
    if (!openFence && line.trim() === '') {
      flushBlock();
      continue;
    }
    cur.push(line);
  }
  flushBlock();
  if (blocks.length <= 1) return [text];

  const chunks: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  for (const block of blocks) {
    const addLen = block.length + (buf.length ? 2 : 0);
    if (buf.length > 0 && bufLen + addLen > MAX_V2_MARKDOWN_CHUNK_CHARS) {
      chunks.push(buf.join('\n\n'));
      buf = [block];
      bufLen = block.length;
    } else {
      buf.push(block);
      bufLen += addLen;
    }
  }
  if (buf.length) chunks.push(buf.join('\n\n'));
  return chunks.length ? chunks : [text];
}

function pushMarkdownChunks(elements: unknown[], text: string): void {
  for (const chunk of splitMarkdownForV2(text)) {
    elements.push(markdown(chunk));
  }
}

function markdownElementsV2(text: string, panelCounter = { next: 0 }): unknown[] {
  const cleaned = stripCardMentions(text);
  const ranges = findDetailsOutsideFences(cleaned);
  if (!ranges.length) return splitMarkdownForV2(cleaned).map(chunk => markdown(chunk));
  const elements: unknown[] = [];
  let lastIndex = 0;
  for (const range of ranges) {
    const before = cleaned.slice(lastIndex, range.start).trim();
    if (before) pushMarkdownChunks(elements, before);
    const inner = range.inner;
    const summaryMatch = SUMMARY_TAG_RE.exec(inner);
    const title = summaryMatch?.[1]?.trim() || '展开详情';
    const body = (summaryMatch
      ? inner.slice(0, summaryMatch.index) + inner.slice(summaryMatch.index + summaryMatch[0].length)
      : inner).trim();
    elements.push({
      tag: 'collapsible_panel',
      element_id: `details_${panelCounter.next++}`,
      expanded: false,
      header: { title: markdown(title) },
      elements: body ? splitMarkdownForV2(body).map(chunk => markdown(chunk)) : [],
    });
    lastIndex = range.end;
  }
  const after = cleaned.slice(lastIndex);
  if (after.trim()) pushMarkdownChunks(elements, after.trim());
  return elements;
}

function cardElements(card: ChannelCard, omitEmpty = false, schema: CardSchema = '1.0', panelCounter = { next: 0 }): unknown[] {
  if (!card.table) {
    if (omitEmpty && !card.text.trim()) return [];
    if (card.format === 'plain') return [{ tag: 'div', text: plain(card.text) }];
    return schema === '2.0' ? markdownElementsV2(card.text, panelCounter) : [markdown(card.text)];
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

function formatExecutionLine(line: string, index: number, numbered: boolean): string {
  const escaped = escapeCardMarkdown(line);
  if (!numbered || line.startsWith('已省略较早的 ')) return escaped;
  const iconMatch = /^([✓✗⏳—])\s+(.+)$/u.exec(line);
  if (!iconMatch) return `${index}. ${escaped}`;
  const icon = iconMatch[1]!;
  const rest = iconMatch[2]!;
  const statusEmoji = icon === '✓' ? '✅' : icon === '✗' ? '❌' : icon === '⏳' ? '⏳' : '➖';
  const sepIdx = rest.indexOf(' · ');
  if (sepIdx > 0) {
    const action = escapeCardMarkdown(rest.slice(0, sepIdx));
    const detail = escapeCardMarkdown(rest.slice(sepIdx + 3));
    return `${index}. ${statusEmoji} **${action}** · ${detail}`;
  }
  return `${index}. ${statusEmoji} **${escapeCardMarkdown(rest)}**`;
}

function executionElements(log: ChannelCard['executionLog'], schema: CardSchema): unknown[] {
  if (!log || (!log.count && !log.lines.length && !log.runningNote && !log.thinking)) return [];
  const richTop = log.position === 'top';
  let stepNum = 0;
  const lines = log.lines.map((line) => {
    if (!line.startsWith('已省略较早的 ')) stepNum += 1;
    return formatExecutionLine(line, stepNum, richTop);
  });
  const topBlocks: unknown[] = [];
  if (log.thinking?.trim()) {
    const cleanThinking = escapeCardMarkdown(log.thinking.trim());
    topBlocks.push(markdown(`**🧠 思考过程**\n${cleanThinking}`));
  }
  if (log.runningNote) {
    const escapedNote = escapeCardMarkdown(log.runningNote);
    topBlocks.push(markdown(richTop ? `**${escapedNote}**` : escapedNote));
  }
  const hasSteps = lines.length > 0;
  if (!hasSteps) return topBlocks;
  const label = richTop ? '执行步骤' : '执行记录';
  const title = `${label}（${log.count} 项${log.failedCount ? `，失败 ${log.failedCount} 项` : ''}）`;
  if (schema === '1.0') return [...topBlocks, markdown([`**${title}**`, ...lines].join('\n'))];
  return [
    ...topBlocks,
    {
      tag: 'collapsible_panel',
      element_id: 'execution_log',
      expanded: log.expanded ?? false,
      header: { title: markdown(richTop ? `**${title}**` : title) },
      elements: lines.length ? [markdown(lines.join('\n'))] : [],
    },
  ];
}

function questionElements(form: QuestionForm): unknown[] {
  const elements: Record<string, unknown>[] = [];
  for (const [i, q] of form.questions.entries()) {
    const optionalSuffix = q.required === false ? '（可选）' : '';
    elements.push(markdown(q.prompt));
    if (!form.submittable) continue;
    if (q.choices.length) {
      const name = q.multiple ? `q${i}_multi` : `q${i}_choice`;
      elements.push({
        tag: q.multiple ? 'multi_select_static' : 'select_static',
        name,
        element_id: name,
        placeholder: plain(`${q.multiple ? '可多选' : '选择一个选项'}${optionalSuffix}`),
        required: false,
        options: q.choices.map((content, j) => ({ text: plain(content), value: String(j) })),
      });
    }
    if (q.allowFreeText) {
      const name = `q${i}_text`;
      elements.push({
        tag: 'input', name, element_id: name, required: false, placeholder: plain(`输入文字答复${optionalSuffix}`),
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
  elements.push({
    tag: 'button', name: 'decline_question', element_id: 'decline_question', text: plain('跳过/取消'),
    type: 'default', behaviors: [{ type: 'callback', value: { ...value, action: 'decline_form', decline: true } }],
  });
  return [{ tag: 'form', name: 'question_form', element_id: 'question_form', direction: 'vertical', vertical_spacing: '8px', elements }];
}

function actionsV2(actions: readonly ChannelCard['actions'][number][]): unknown[] {
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
    horizontal_spacing: '8px',
    horizontal_align: 'left',
    columns: buttons.map(button => ({ tag: 'column', width: 'auto', elements: [button] })),
  }];
}

function sectionElements(
  sections: NonNullable<ChannelCard['sections']>,
  schema: CardSchema,
  panelCounter = { next: 0 },
): { elements: unknown[]; renderedActions: boolean } {
  const elements: unknown[] = [];
  let renderedActions = false;
  for (const section of sections) {
    if (section.dividerBefore) elements.push({ tag: 'hr' });
    const text = section.text?.trim();
    if (text) {
      if (schema === '2.0') elements.push(...markdownElementsV2(text, panelCounter));
      else elements.push(markdown(text));
    }
    if (section.actions?.length) {
      renderedActions = true;
      if (schema === '2.0') {
        elements.push(...actionsV2(section.actions));
      } else {
        elements.push({
          tag: 'action',
          actions: section.actions.map(a => ({
            tag: 'button',
            text: plain(a.label),
            type: a.type ?? 'default',
            ...(a.url ? { url: a.url } : { value: a.value }),
          })),
        });
      }
    }
  }
  return { elements, renderedActions };
}

function encodeV2(card: ChannelCard, form?: QuestionForm): Record<string, unknown> {
  const panelCounter = { next: 0 };
  const sectioned = card.sections?.length ? sectionElements(card.sections, '2.0', panelCounter) : null;
  const baseBody = sectioned
    ? (card.table
        ? cardElements(card, false, '2.0', panelCounter)
        : (card.text.trim() && !card.sections?.some(s => s.text?.trim())
            ? cardElements(card, !!form, '2.0', panelCounter)
            : []))
    : cardElements(card, !!form, '2.0', panelCounter);
  const bannerElems = card.statusBanner?.trim() ? [markdown(card.statusBanner.trim())] : [];
  const execElems = executionElements(card.executionLog, '2.0');
  const execOnTop = card.executionLog?.position === 'top' && execElems.length > 0;
  const contentBlocks = execOnTop
    ? [
        ...bannerElems,
        ...execElems,
        ...(baseBody.length > 0 ? [{ tag: 'hr' }, ...baseBody] : []),
      ]
    : [
        ...bannerElems,
        ...baseBody,
        ...(sectioned ? sectioned.elements : []),
        ...(form ? questionElements(form) : []),
        ...execElems,
      ];
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: header(card, '2.0'),
    body: {
      elements: [
        ...contentBlocks,
        ...(execOnTop && sectioned ? sectioned.elements : []),
        ...(execOnTop && form ? questionElements(form) : []),
        ...(sectioned?.renderedActions ? [] : actionsV2(card.actions)),
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
  const sectioned = card.sections?.length ? sectionElements(card.sections, '1.0') : null;
  const baseElements = sectioned
    ? (card.table || (card.text.trim() && !card.sections?.some(s => s.text?.trim())) ? cardElements(card) : [])
    : cardElements(card);
  const bannerElems = card.statusBanner?.trim() ? [markdown(card.statusBanner.trim())] : [];
  const execElems = executionElements(card.executionLog, '1.0');
  const execOnTop = card.executionLog?.position === 'top' && execElems.length > 0;
  const elements = execOnTop
    ? [
        ...bannerElems,
        ...execElems,
        ...(baseElements.length > 0 ? [{ tag: 'hr' }, ...baseElements] : []),
        ...(sectioned ? sectioned.elements : []),
      ]
    : [
        ...bannerElems,
        ...baseElements,
        ...(sectioned ? sectioned.elements : []),
        ...execElems,
      ];
  if (!sectioned?.renderedActions && card.actions.length) {
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
    header: header(card, '1.0'),
    elements,
  };
}
