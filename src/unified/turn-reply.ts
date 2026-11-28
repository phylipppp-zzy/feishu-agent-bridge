import { cardContentBytes, headByBytes, tailByBytes } from '../text-limits.js';
import type { UnifiedService } from './adapter.js';
import type { Message, SessionSnapshot } from './contracts.js';
import { escapeCardMarkdown } from './feishu-card-wire.js';

export function aggregateTurnAssistantMessage(messages: readonly Message[], turnId: string): Message | undefined {
  const byId = new Map<string, Message>();
  for (const message of messages) {
    if (message.role !== 'assistant' || (message.turnId || message.messageId) !== turnId) continue;
    const previous = byId.get(message.messageId);
    if (!previous || message.revision > previous.revision ||
      message.revision === previous.revision && message.sequence > previous.sequence) byId.set(message.messageId, message);
  }
  const ordered = [...byId.values()].sort((a, b) => a.sequence - b.sequence || a.messageId.localeCompare(b.messageId));
  const latest = ordered.at(-1);
  if (!latest || ordered.length === 1) return latest;
  const blocks: Message['blocks'] = [];
  let hasText = false;
  for (const message of ordered) {
    const firstText = message.blocks.findIndex(block => block.type === 'text' && block.text !== '');
    for (const [index, block] of message.blocks.entries()) {
      if (block.type === 'artifact') blocks.push(block);
      else if (firstText !== -1) {
        blocks.push(hasText && index === firstText ? { ...block, text: '\n' + block.text } : block);
      }
    }
    hasText ||= firstText !== -1;
  }
  return { ...latest, turnId, blocks, revision: ordered.reduce((total, message) => total + message.revision, 0),
    final: ordered.every(message => message.final) };
}

export function resolveTurnReplyFromAnchor(snapshot: SessionSnapshot, anchorId: string): { turnId: string; message: Message } | undefined {
  const messages = snapshot.messages.filter(message => message.sessionId === snapshot.session.sessionId);
  const match = messages.find(message => message.role === 'assistant' && message.messageId === anchorId) ??
    messages.find(message => message.role === 'assistant' && message.turnId === anchorId);
  if (!match) return;
  const turnId = match.turnId || match.messageId;
  return { turnId, message: aggregateTurnAssistantMessage(messages, turnId)! };
}

export async function readTurnReply(service: UnifiedService, sessionId: string, anchorId: string): Promise<Message | undefined> {
  const snapshot = (await service.getSnapshot?.(sessionId))?.value;
  const message = (snapshot && resolveTurnReplyFromAnchor(snapshot, anchorId)?.message) ??
    await service.getMessage?.(sessionId, anchorId);
  if (message?.sessionId === sessionId && message.role === 'assistant') return message;
}

type Fence = { marker: string; start: number; bodyStart: number; closeStart: number | null; end: number };

function markdownFences(text: string): Fence[] {
  const fences: Fence[] = [];
  let open: Fence | undefined;
  for (const line of text.matchAll(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm)) {
    const marker = line[1]!, rest = line[2]!;
    if (open) {
      if (marker[0] === open.marker[0] && marker.length >= open.marker.length && !rest.trim()) {
        open.end = line.index + line[0].length;
        open.closeStart = line.index;
        open = undefined;
      }
    } else if (marker[0] === '~' || !rest.includes('`')) {
      open = { marker, start: line.index, bodyStart: line.index + line[0].length, closeStart: null, end: text.length };
      fences.push(open);
    }
  }
  return fences;
}

function indexLinkDestinations(markdown: string) {
  const length = markdown.length;
  const nonSpace = new Uint32Array(length + 1);
  const bareEnd = new Uint32Array(length + 1);
  const angleEnd = new Uint32Array(length + 1);
  const titleEnd = new Uint32Array(length + 1);
  nonSpace[length] = bareEnd[length] = angleEnd[length] = length;
  // Failed destinations and titles can overlap. Index their delimiters once.
  for (let i = length - 1; i >= 0; i--) {
    const char = markdown[i]!;
    const space = /\s/.test(char);
    const newline = char === '\r' || char === '\n';
    nonSpace[i] = space ? nonSpace[i + 1]! : i;
    bareEnd[i] = space || char === ')' ? i : bareEnd[i + 1]!;
    angleEnd[i] = char === '>' ? i : newline ? length : angleEnd[i + 1]!;
    const after = nonSpace[i + 1]!;
    titleEnd[i] = (char === '"' || char === "'") && markdown[after] === ')' ? after + 1
      : newline ? 0 : titleEnd[i + 1]!;
  }
  const finish = (urlEnd: number): number => {
    const after = nonSpace[urlEnd]!;
    if (markdown[after] === ')') return after + 1;
    if (after > urlEnd && (markdown[after] === '"' || markdown[after] === "'")) return titleEnd[after + 1]!;
    return 0;
  };
  return (index: number): { end: number; web: boolean } | undefined => {
    const url = nonSpace[index]!;
    const angle = angleEnd[url]!;
    const end = (markdown[url] === '<' && angle > url + 1 && angle < length ? finish(angle + 1) : 0) ||
      (bareEnd[url]! > url ? finish(bareEnd[url]!) : 0);
    if (end) return { end, web: /^<?https?:\/\//i.test(markdown.slice(url, url + 9)) };
  };
}

function sanitizeInline(markdown: string): string {
  if (!markdown.includes('](')) return markdown;
  const tokens = /\\[^\r\n]|`+|!?\[|[\]\r\n]/g;
  const ticks = new Map<number, { offsets: number[]; next: number }>();
  for (const run of markdown.matchAll(/`+/g)) {
    const length = run[0].length;
    let group = ticks.get(length);
    if (!group) ticks.set(length, group = { offsets: [], next: 0 });
    group.offsets.push(run.index);
  }
  let findDestination: ReturnType<typeof indexLinkDestinations> | undefined;
  let opener: RegExpExecArray | undefined;
  let start = 0;
  const result: string[] = [];
  for (let token = tokens.exec(markdown); token; token = tokens.exec(markdown)) {
    if (token[0].startsWith('\\')) continue;
    if (token[0][0] === '`') {
      const length = token[0].length;
      const group = ticks.get(length);
      if (group) {
        while ((group.offsets[group.next] ?? Infinity) <= token.index) group.next++;
        const close = group.offsets[group.next];
        if (close !== undefined) {
          tokens.lastIndex = close + length;
          if (opener && /[\r\n]/.test(markdown.slice(token.index, close))) opener = undefined;
        }
      }
      continue;
    }
    if (token[0].endsWith('[')) {
      opener = token;
      continue;
    }
    const open = opener;
    opener = undefined;
    if (!open || token[0] !== ']' || markdown[token.index + 1] !== '(') continue;
    const labelStart = open.index + open[0].length;
    if (labelStart === token.index) continue;
    findDestination ??= indexLinkDestinations(markdown);
    const destination = findDestination(token.index + 2);
    if (!destination) continue;
    tokens.lastIndex = destination.end;
    if (destination.web) continue;
    const label = markdown.slice(labelStart, token.index);
    const display = label.replace(/`/g, '');
    result.push(markdown.slice(start, open.index), display ? '`' + display + '`' : escapeCardMarkdown(label));
    start = destination.end;
  }
  if (!result.length) return markdown;
  result.push(markdown.slice(start));
  return result.join('');
}

export function sanitizeCardMarkdownLinks(markdown: string): { text: string; rewroteLinks: boolean } {
  const fragments: string[] = [];
  let start = 0;
  for (const fence of markdownFences(markdown)) {
    fragments.push(sanitizeInline(markdown.slice(start, fence.start)), markdown.slice(fence.start, fence.end));
    start = fence.end;
  }
  fragments.push(sanitizeInline(markdown.slice(start)));
  const text = fragments.join('');
  return { text, rewroteLinks: text !== markdown };
}

export const CARD_REPLY_BUDGET_BYTES = 20_000;
export function formatCardReplyBody(markdown: string, allowFullReplyButton = true): { text: string; truncated: boolean } {
  const { text } = sanitizeCardMarkdownLinks(markdown);
  if (cardContentBytes(text) <= CARD_REPLY_BUDGET_BYTES) return { text, truncated: false };

  const fences = markdownFences(text);
  // Reserve space for up to three fence lines around the omitted section.
  const maxMarker = fences.reduce((size, fence) => Math.max(size, fence.marker.length), 3);
  const repairBudget = 3 * (Math.min(maxMarker, 300) + cardContentBytes('\n'));
  const omission = allowFullReplyButton
    ? '\n\n> …（中间内容已省略，点击底部「发送完整正文 (.txt)」查看全文）…\n\n'
    : '\n\n> …（中间内容已省略）…\n\n';
  const budget = CARD_REPLY_BUDGET_BYTES - cardContentBytes(omission) - repairBudget;
  let head = headByBytes(text, Math.floor(budget * 0.7), cardContentBytes);
  let tail = tailByBytes(text, Math.ceil(budget * 0.3), cardContentBytes);
  const headBreak = head.lastIndexOf('\n');
  const tailBreak = tail.indexOf('\n');
  if (headBreak > head.length * 0.8) head = head.slice(0, headBreak + 1);
  if (tailBreak !== -1 && tailBreak < tail.length * 0.2 && text[text.length - tail.length - 1] !== '\n') {
    tail = tail.slice(tailBreak + 1);
  }

  const headFence = fences.find(fence => fence.start < head.length && head.length < fence.end);
  if (headFence) {
    if (head.length < headFence.bodyStart || headFence.marker.length > 300) head = head.slice(0, headFence.start);
    else head = head.slice(0, headFence.closeStart ?? head.length).trimEnd() + '\n' + headFence.marker;
  }

  const tailStart = text.length - tail.length;
  const tailFence = fences.find(fence => fence.start < tailStart && tailStart < fence.end);
  if (tailFence) {
    if (tailFence.marker.length > 300 || (tailFence.closeStart !== null && tailStart > tailFence.closeStart)) {
      tail = text.slice(tailFence.end);
    } else {
      tail = tailFence.marker + '\n' + text.slice(Math.max(tailStart, tailFence.bodyStart));
    }
  }
  const last = fences.at(-1);
  if (last?.closeStart === null && tail) {
    if (last.marker.length <= 300) tail = tail.trimEnd() + '\n' + last.marker;
    else if (tailStart <= last.start) tail = text.slice(tailStart, last.start);
  }

  return { text: head.trimEnd() + omission + tail, truncated: true };
}
