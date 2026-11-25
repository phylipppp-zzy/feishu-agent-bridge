import type { Message, SessionSnapshot } from '../contracts.js';

function rawMessageText(message: Message): string {
  return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
}

export function agyPromptText(message: Message): string {
  return rawMessageText(message).replace(/\r\n/g, '\n').trim();
}

export function reconcileAgyReply(counterpart: Message, nativeReply: readonly Message[], keepDivergentSteps: boolean): Message {
  if (!counterpart.final || !nativeReply.length || nativeReply.some(message => !message.final)) return counterpart;
  const steps = nativeReply.map(rawMessageText).filter(Boolean);
  const text = steps.join('\n\n');
  const streamed = rawMessageText(counterpart);
  const normalized = streamed.trim();
  if (text.trim() === normalized) return counterpart;

  let merged = streamed;
  if (!normalized || text.includes(normalized)) {
    merged = text;
  } else if (keepDivergentSteps) {
    for (const step of steps) {
      const trimmed = step.trim();
      if (trimmed && !merged.includes(trimmed)) merged += '\n\n' + step;
    }
  }
  return merged === streamed ? counterpart : {
    ...counterpart, blocks: [{ type: 'text', text: merged }], revision: counterpart.revision + 1,
  };
}

const transcriptRow = (message: Message): boolean => message.source === 'agy' && /^(?:step|line)-\d+$/.test(message.turnId);

function replyMatches(counterpart: Message, nativeReply: readonly Message[]): boolean {
  const streamed = rawMessageText(counterpart).trim();
  const steps = nativeReply.map(rawMessageText).filter(Boolean);
  return !streamed || steps.join('\n\n').includes(streamed) || steps.every(step => streamed.includes(step.trim()));
}

type History = Pick<SessionSnapshot, 'messages' | 'turns'>;

/** Match native replay to the live IDs already stored before reconnecting. */
export function reconcilePersistedAgyHistory<T extends History>(observed: T, persisted: ReadonlyMap<string, Message>): {
  snapshot: T; updated: Message[];
} {
  const observedLiveTurns = new Set(observed.messages.filter(message => !transcriptRow(message)).map(message => message.turnId));
  const live = [...persisted.values()].filter(message => message.source === 'agy' && !transcriptRow(message) &&
    !observedLiveTurns.has(message.turnId)).sort((a, b) => a.sequence - b.sequence);
  const assistants = new Map(live.filter(message => message.role === 'assistant').map(message => [message.turnId, message]));
  const prompts = live.filter(message => message.role === 'user' && assistants.has(message.turnId))
    .map(message => ({ message, text: agyPromptText(message) }));
  if (!prompts.length) return { snapshot: observed, updated: [] };

  const preLiveIds = new Set<string>();
  for (const message of persisted.values()) {
    if (message.messageId === prompts[0]!.message.messageId) break;
    if (transcriptRow(message)) preLiveIds.add(message.messageId);
  }
  let baselineThrough = -1;
  for (const [index, message] of observed.messages.entries()) {
    if (preLiveIds.has(message.messageId)) baselineThrough = index;
  }
  const nativePromptCounts = new Map<string, number>();
  const rows = observed.messages;
  for (let i = baselineThrough + 1; i < rows.length; i++) {
    const message = rows[i]!;
    if (!transcriptRow(message) || message.role !== 'user' || persisted.has(message.messageId)) continue;
    const text = agyPromptText(message);
    nativePromptCounts.set(text, (nativePromptCounts.get(text) ?? 0) + 1);
  }

  const messages: Message[] = [];
  const updated: Message[] = [];
  const skippedTurns = new Set<string>();
  let nextPrompt = 0;
  let index = 0;
  while (index < rows.length) {
    const message = rows[index++]!;
    if (index - 1 <= baselineThrough || !transcriptRow(message) || message.role !== 'user' || persisted.has(message.messageId)) {
      messages.push(message);
      continue;
    }
    const group: Message[] = [];
    while (index < rows.length && transcriptRow(rows[index]!) && rows[index]!.role !== 'user') {
      group.push(rows[index++]!);
    }
    const reply = group.filter(step => step.role === 'assistant');
    const text = agyPromptText(message);
    const finalized = reply.length > 0 && reply.every(step => step.final);
    const samePrompt = (prompt: typeof prompts[number], i: number) => i >= nextPrompt && prompt.text === text;
    // Repeated native prompts might include a CLI turn. Use reply evidence to
    // choose the pairing before consuming a live prompt from the queue.
    let match = text ? prompts.findIndex((prompt, i) => samePrompt(prompt, i) &&
      (!finalized || replyMatches(assistants.get(prompt.message.turnId)!, reply))) : -1;
    if (match < 0 && text && nativePromptCounts.get(text) === 1) match = prompts.findIndex(samePrompt);
    if (match < 0) {
      messages.push(message);
      for (const step of group) messages.push(step);
      continue;
    }
    for (const step of group) {
      if (step.role === 'assistant' && !persisted.has(step.messageId)) skippedTurns.add(step.turnId);
      else messages.push(step);
    }
    skippedTurns.add(message.turnId);
    if (finalized) {
      const counterpart = assistants.get(prompts[match]!.message.turnId)!;
      const enriched = reconcileAgyReply(counterpart, reply, false);
      if (enriched !== counterpart) updated.push(enriched);
      nextPrompt = match + 1;
    }
  }
  const turns = observed.turns?.filter(turn => !skippedTurns.has(turn.turnId));
  return { snapshot: { ...observed, messages, ...(turns ? { turns } : {}) }, updated };
}
