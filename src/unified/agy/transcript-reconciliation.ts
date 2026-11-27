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
  if (!streamed || steps.join('\n\n').includes(streamed) || steps.every(step => streamed.includes(step.trim()))) {
    return true;
  }
  const streamedParagraphs = streamed.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return steps.some(step => {
    const trimmed = step.trim();
    return Boolean(trimmed) && streamedParagraphs.includes(trimmed);
  });
}

type History = Pick<SessionSnapshot, 'messages' | 'turns'>;

export interface AgyReconciliationConflict {
  promptText: string;
  liveTurnId: string;
  liveMessageId: string;
  nativeTurnId: string;
  nativeMessageIds: string[];
  reason: 'divergent_reply';
}

const CONFLICT_MARKER = '[对账冲突：原生回复与本地记录内容分歧，已保留双方来源]';

function markConflictMessage(message: Message): Message {
  const raw = rawMessageText(message);
  if (raw.startsWith(CONFLICT_MARKER)) return message;
  const text = raw ? `${CONFLICT_MARKER}\n\n${raw}` : CONFLICT_MARKER;
  return {
    ...message,
    blocks: [{ type: 'text', text }],
  };
}

/** Match native replay to the live IDs already stored before reconnecting. */
export function reconcilePersistedAgyHistory<T extends History>(observed: T, persisted: ReadonlyMap<string, Message>): {
  snapshot: T; updated: Message[]; conflicts: AgyReconciliationConflict[];
} {
  const observedLiveTurns = new Set(observed.messages.filter(message => !transcriptRow(message)).map(message => message.turnId));
  const live = [...persisted.values()].filter(message => message.source === 'agy' && !transcriptRow(message) &&
    !observedLiveTurns.has(message.turnId)).sort((a, b) => a.sequence - b.sequence);
  const assistants = new Map(live.filter(message => message.role === 'assistant').map(message => [message.turnId, message]));
  const prompts = live.filter(message => message.role === 'user')
    .map(message => ({ message, text: agyPromptText(message) }));
  if (!prompts.length) return { snapshot: observed, updated: [], conflicts: [] };

  const preLiveIds = new Set<string>();
  for (const message of persisted.values()) {
    if (message.messageId === prompts[0]!.message.messageId) break;
    if (transcriptRow(message)) preLiveIds.add(message.messageId);
  }
  let baselineThrough = -1;
  for (const [index, message] of observed.messages.entries()) {
    if (preLiveIds.has(message.messageId)) baselineThrough = index;
  }
  const rows = observed.messages;

  const messages: Message[] = [];
  const updated: Message[] = [];
  const conflicts: AgyReconciliationConflict[] = [];
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
    // Repeated native prompts might include a CLI turn or divergent replay.
    // Only deduplicate when reply evidence agrees (or when reply is not yet finalized / live turn had no assistant yet).
    const match = text ? prompts.findIndex((prompt, i) => {
      if (!samePrompt(prompt, i)) return false;
      const liveAssistant = assistants.get(prompt.message.turnId);
      if (!liveAssistant) return true;
      return !finalized || replyMatches(liveAssistant, reply);
    }) : -1;

    if (match < 0) {
      // Check if there is a same-prompt live record whose reply diverges from the finalized native reply,
      // unless a later unconsumed native turn already matches that live record cleanly (making this an external CLI turn).
      const divergentIdx = text && finalized ? prompts.findIndex((prompt, i) => samePrompt(prompt, i) && assistants.has(prompt.message.turnId)) : -1;
      const hasLaterMatchingNativeTurn = (liveTurnId: string): boolean => {
        const liveAssistant = assistants.get(liveTurnId);
        if (!liveAssistant) return false;
        let scan = index;
        while (scan < rows.length) {
          const cand = rows[scan++]!;
          if (!transcriptRow(cand) || cand.role !== 'user' || persisted.has(cand.messageId)) continue;
          const candGroup: Message[] = [];
          while (scan < rows.length && transcriptRow(rows[scan]!) && rows[scan]!.role !== 'user') {
            candGroup.push(rows[scan++]!);
          }
          if (agyPromptText(cand) !== text) continue;
          const candReply = candGroup.filter(step => step.role === 'assistant');
          if (candReply.length > 0 && candReply.every(step => step.final) && replyMatches(liveAssistant, candReply)) {
            return true;
          }
        }
        return false;
      };
      if (divergentIdx >= 0 && !hasLaterMatchingNativeTurn(prompts[divergentIdx]!.message.turnId)) {
        const livePrompt = prompts[divergentIdx]!;
        const liveAssistant = assistants.get(livePrompt.message.turnId)!;
        conflicts.push({
          promptText: text,
          liveTurnId: livePrompt.message.turnId,
          liveMessageId: liveAssistant.messageId,
          nativeTurnId: message.turnId,
          nativeMessageIds: reply.map(step => step.messageId),
          reason: 'divergent_reply',
        });
        messages.push(message);
        let markedFirstAssistant = false;
        for (const step of group) {
          if (step.role === 'assistant' && !markedFirstAssistant) {
            messages.push(markConflictMessage(step));
            markedFirstAssistant = true;
          } else {
            messages.push(step);
          }
        }
      } else {
        messages.push(message);
        for (const step of group) messages.push(step);
      }
      continue;
    }
    const matchedAssistant = assistants.get(prompts[match]!.message.turnId);
    if (matchedAssistant) {
      for (const step of group) {
        if (step.role === 'assistant' && !persisted.has(step.messageId)) skippedTurns.add(step.turnId);
        else messages.push(step);
      }
      skippedTurns.add(message.turnId);
      if (finalized) {
        const enriched = reconcileAgyReply(matchedAssistant, reply, false);
        if (enriched !== matchedAssistant) updated.push(enriched);
        nextPrompt = match + 1;
      }
    } else {
      // Persisted live user prompt had no assistant yet (e.g. interrupted or killed on restart):
      // absorb the duplicate native user prompt while keeping any native assistant reply steps.
      for (const step of group) messages.push(step);
      if (!reply.length) skippedTurns.add(message.turnId);
      nextPrompt = match + 1;
    }
  }
  const turns = observed.turns?.filter(turn => !skippedTurns.has(turn.turnId));
  return { snapshot: { ...observed, messages, ...(turns ? { turns } : {}) }, updated, conflicts };
}
