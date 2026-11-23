import type { CardDefinition } from "../types.js";

/** A record of every message produced while rendering one logical card. */
export interface RenderMessageRecord {
  messageIds: string[];
  cards: CardDefinition[];
  degraded: boolean;
}

export type CardSend = (card: CardDefinition) => Promise<string>;
export type CardUpdate = (messageId: string, card: CardDefinition) => Promise<void>;

/** Hard ceiling per logical-card send, including the original attempt and all fallbacks. */
export const MAX_RENDER_FALLBACK_ATTEMPTS = 64;

/** 230099 is the observed Feishu card-content rejection. Other failures are not render errors. */
export function isCardContentRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b230099\b/.test(message);
}

function elementsKey(card: CardDefinition): "elements" | "body" | null {
  if (Array.isArray(card.elements)) return "elements";
  const body = card.body;
  if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).elements)) return "body";
  return null;
}

function cardWithElements(template: CardDefinition, elements: unknown[]): CardDefinition {
  const key = elementsKey(template);
  if (key === "elements") return { ...template, elements };
  if (key === "body") return { ...template, body: { ...(template.body as Record<string, unknown>), elements } };
  return { ...template };
}

/** Bisects one markdown element by Unicode code point, preserving every code point in order. */
function splitMarkdownElement(element: unknown): [unknown, unknown] | null {
  if (!element || typeof element !== "object" || Array.isArray(element)) return null;
  const record = element as Record<string, unknown>;
  if (record.tag !== "markdown" || typeof record.content !== "string") return null;
  const points = Array.from(record.content);
  if (points.length <= 1) return null;
  const middle = Math.ceil(points.length / 2);
  return [
    { ...record, content: points.slice(0, middle).join("") },
    { ...record, content: points.slice(middle).join("") },
  ];
}

function humanValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(humanValue).filter(Boolean).join(" · ");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const tag = typeof object.tag === "string" ? object.tag : "";
    if (tag === "table") return tableAsText(object);
    if (typeof object.content === "string") return object.content;
    if (Array.isArray(object.elements)) return object.elements.map(humanValue).filter(Boolean).join("\n");
    if (Array.isArray(object.columns)) return object.columns.map(humanValue).filter(Boolean).join(" | ");
    if (Array.isArray(object.rows)) return object.rows.map(humanValue).filter(Boolean).join("\n");
    return Object.entries(object).filter(([key]) => key !== "tag").map(([key, item]) => `${key}: ${humanValue(item)}`).filter((line) => !line.endsWith(": ")).join("\n");
  }
  return "";
}

function tableAsText(table: Record<string, unknown>): string {
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const rendered = rows.map((row) => Array.isArray(row) ? row.map(humanValue).join(" | ") : humanValue(row));
  if (rendered.length) return rendered.join("\n");
  return Object.entries(table).filter(([key]) => key !== "tag").map(([key, value]) => `${key}: ${humanValue(value)}`).join("\n");
}

function degradeElement(element: unknown): unknown {
  if (Array.isArray(element)) return element.map(degradeElement);
  if (!element || typeof element !== "object") return element;
  const object = element as Record<string, unknown>;
  if (object.tag === "button") return object;
  if (object.tag === "table") return { tag: "markdown", content: tableAsText(object) };
  if (object.tag === "markdown") {
    const content = object.content;
    return typeof content === "string" ? { ...object, content: fenceMarkdownTables(content) } : object;
  }
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, degradeElement(value)]));
}

function asMarkdown(element: unknown): unknown {
  const degraded = degradeElement(element);
  return degraded && typeof degraded === "object" ? degraded : { tag: "markdown", content: humanValue(degraded) };
}

function tableCells(line: string): string[] {
  let trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}
function isTableRow(line: string): boolean { return tableCells(line).length >= 2; }
function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** Markdown tables in prose can trigger the same rejection as native table elements. */
function fenceMarkdownTables(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inCodeFence = false;
  for (let i = 0; i < lines.length;) {
    if (/^\s*```/.test(lines[i]!)) { inCodeFence = !inCodeFence; out.push(lines[i++]!); continue; }
    if (!inCodeFence && i + 1 < lines.length && isTableRow(lines[i]!) && isTableSeparator(lines[i + 1]!)) {
      out.push("```text");
      while (i < lines.length && isTableRow(lines[i]!)) out.push(lines[i++]!);
      out.push("```");
    } else out.push(lines[i++]!);
  }
  return out.join("\n");
}

/**
 * Send a card, retrying only an identified card-content rejection. On that rejection,
 * convert tables to text, then bisect elements or a single oversized Markdown element.
 * Retries have a fixed global ceiling, including the original attempt.
 */
export async function sendCardWithRenderFallback(card: CardDefinition, send: CardSend): Promise<RenderMessageRecord> {
  let lastContentError: unknown;
  try {
    const id = await send(card);
    return { messageIds: [id], cards: [card], degraded: false };
  } catch (error) {
    if (!isCardContentRejection(error)) throw error;
    lastContentError = error;
  }

  const key = elementsKey(card);
  if (!key) throw new Error("Card content was rejected and the card has no splittable elements (230099)");
  const raw = key === "elements" ? card.elements as unknown[] : (card.body as Record<string, unknown>).elements as unknown[];
  if (!raw.length) throw new Error("Card content was rejected and the card has no elements to degrade (230099)");
  const queue = [raw.map(asMarkdown)];
  const messageIds: string[] = [];
  const cards: CardDefinition[] = [];
  let attempts = 1;
  while (queue.length) {
    if (attempts >= MAX_RENDER_FALLBACK_ATTEMPTS) throw lastContentError;
    const group = queue.shift()!;
    const candidate = cardWithElements(card, group);
    attempts++;
    try {
      messageIds.push(await send(candidate));
      cards.push(candidate);
    } catch (error) {
      if (!isCardContentRejection(error)) throw error;
      lastContentError = error;
      if (group.length > 1) {
        const middle = Math.ceil(group.length / 2);
        queue.unshift(group.slice(middle));
        queue.unshift(group.slice(0, middle));
        continue;
      }
      const split = splitMarkdownElement(group[0]);
      if (!split) throw error;
      queue.unshift([split[1]]);
      queue.unshift([split[0]]);
    }
  }
  return { messageIds, cards, degraded: true };
}

/** Update an existing card first; if its new content is rejected, post a degraded replacement. */
export async function updateCardWithRenderFallback(messageId: string, card: CardDefinition, update: CardUpdate, send: CardSend): Promise<RenderMessageRecord> {
  try {
    await update(messageId, card);
    return { messageIds: [messageId], cards: [card], degraded: false };
  } catch (error) {
    if (!isCardContentRejection(error)) throw error;
  }
  return sendCardWithRenderFallback(card, send);
}
