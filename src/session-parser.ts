import { createHash } from "node:crypto";
import type { ChoiceQuestion, ChoiceRequest, SessionMetadata, VisibleMessage } from "./types.js";

interface ParsedBatch {
  metadata?: Omit<SessionMetadata, "path" | "firstUserText">;
  messages: VisibleMessage[];
  choiceRequests: ChoiceRequest[];
  /** Tool call ids that already have an output, i.e. questions answered in some frontend. */
  answeredCallIds: string[];
  carry: string;
  completedTurn: boolean;
  turnActive: boolean | undefined;
  unknownTypes: string[];
  model?: string;
  reasoningEffort?: string;
}

const CHOICE_TTL_MS = 24 * 60 * 60_000;

function choiceQuestions(value: unknown): ChoiceQuestion[] {
  if (!value || typeof value !== "object") return [];
  const source = (value as { questions?: unknown }).questions;
  if (!Array.isArray(source)) return [];
  return source.slice(0, 3).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.question !== "string" || !item.question.trim()) return [];
    const options = Array.isArray(item.options) ? item.options.slice(0, 10).flatMap((rawOption) => {
      if (!rawOption || typeof rawOption !== "object") return [];
      const option = rawOption as Record<string, unknown>;
      if (typeof option.label !== "string" || !option.label.trim()) return [];
      return [{ label: option.label.trim(), description: typeof option.description === "string" ? option.description.trim() : "" }];
    }) : [];
    return [{
      id: typeof item.id === "string" && item.id ? item.id : `question_${index + 1}`,
      header: typeof item.header === "string" ? item.header : "需要确认",
      question: item.question.trim(), options,
    }];
  });
}

function requestFromArguments(sessionId: string, timestamp: string, id: string, raw: unknown): ChoiceRequest | null {
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw) as unknown; } catch { return null; }
  }
  const questions = choiceQuestions(parsed);
  if (!questions.length) return null;
  const timestampMs = Date.parse(timestamp);
  return { id, sessionId, timestamp, questions, expiresAt: Number.isFinite(timestampMs) ? timestampMs + CHOICE_TTL_MS : Date.now() + CHOICE_TTL_MS };
}

function embeddedChoice(sessionId: string, timestamp: string, text: string): { request: ChoiceRequest; visibleText: string } | null {
  const match = text.match(/<feishu_input>([\s\S]*?)<\/feishu_input>/i);
  if (!match?.[1]) return null;
  const id = stableMessageId(sessionId, timestamp, "choice", match[1]);
  const request = requestFromArguments(sessionId, timestamp, id, match[1]);
  return request ? { request, visibleText: text.replace(match[0], "").trim() } : null;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => item.type === "input_text" || item.type === "output_text")
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function stableMessageId(sessionId: string, timestamp: string, role: string, text: string): string {
  return createHash("sha256").update(`${sessionId}\0${timestamp}\0${role}\0${text}`).digest("hex");
}

// Context Codex and its host add to a user message (plugin lists, environment, AGENTS.md and
// user instructions). The person did not type it, so it is not shown as their message.
const HOST_BLOCKS = [
  /^<recommended_plugins>[\s\S]*?<\/recommended_plugins>/i,
  /^<environment_context>[\s\S]*?<\/environment_context>/i,
  /^<user_instructions>[\s\S]*?<\/user_instructions>/i,
  /^# AGENTS\.md instructions[^\n]*\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/i,
];

/**
 * A user text without the host context around it. Only whole blocks at the start or the end of
 * the text count as context, as Codex places them; the same tags quoted inside a question, a
 * quotation or a code example stay visible.
 */
export function stripHostContext(text: string): string {
  let rest = text.trim();
  for (let changed = true; changed && rest;) {
    changed = false;
    for (const block of HOST_BLOCKS) {
      const match = rest.match(block);
      if (match) { rest = rest.slice(match[0].length).trim(); changed = true; }
    }
    for (const block of HOST_BLOCKS) {
      const end = new RegExp(`${block.source.slice(1)}$`, block.flags);
      // Only a block that starts on its own line can end the text as context.
      const match = rest.match(end);
      if (match && (match.index === 0 || rest[match.index! - 1] === "\n")) { rest = rest.slice(0, match.index).trim(); changed = true; }
    }
  }
  return rest;
}

/**
 * The text of a user message as recorded (its message id is derived from it, so messages
 * imported before this filter keep their ids) and as shown, without host context. Codex puts
 * each piece of context in its own content item; each item is cleaned on its own.
 */
export function userMessageText(content: unknown): { raw: string; visible: string } {
  const items = Array.isArray(content) ? content.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => item.type === "input_text" && typeof item.text === "string" && item.text) .map((item) => String(item.text)) : [];
  return { raw: items.join("\n"), visible: items.map(stripHostContext).filter(Boolean).join("\n") };
}

export function parseJsonlChunk(input: string, previousCarry = "", knownSessionId = "", expectedSessionId = ""): ParsedBatch {
  const joined = previousCarry + input;
  const endsWithNewline = joined.endsWith("\n");
  const lines = joined.split("\n");
  const carry = endsWithNewline ? "" : (lines.pop() ?? "");
  const messages: VisibleMessage[] = [];
  const choiceRequests: ChoiceRequest[] = [];
  const answeredCallIds: string[] = [];
  const unknownTypes = new Set<string>();
  let metadata: ParsedBatch["metadata"];
  let sessionId = knownSessionId;
  let completedTurn = false;
  let turnActive: boolean | undefined;
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  // Incremental reads normally start after session_meta.  A matching cursor
  // already establishes ownership, so later append-only chunks must remain in scope.
  let includeRecord = !expectedSessionId || knownSessionId === expectedSessionId;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      unknownTypes.add("invalid_json");
      continue;
    }
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date(0).toISOString();
    const type = typeof record.type === "string" ? record.type : "unknown";
    const payload = record.payload && typeof record.payload === "object"
      ? record.payload as Record<string, unknown>
      : {};

    if (type === "session_meta") {
      const candidate = String(payload.session_id ?? payload.id ?? sessionId);
      if (expectedSessionId && candidate !== expectedSessionId) {
        includeRecord = false;
        continue;
      }
      sessionId = candidate;
      includeRecord = true;
      metadata = {
        sessionId,
        cwd: String(payload.cwd ?? ""),
        startedAt: String(payload.timestamp ?? timestamp),
        source: String(payload.source ?? payload.originator ?? "unknown"),
      };
      continue;
    }
    if (!includeRecord) continue;
    if (type === "turn_context") {
      if (typeof payload.model === "string" && payload.model) model = payload.model;
      if (typeof payload.effort === "string" && payload.effort) reasoningEffort = payload.effort;
      continue;
    }
    if (type === "event_msg") {
      const eventType = String(payload.type ?? "");
      if (eventType === "task_started") turnActive = true;
      if (eventType === "task_complete" || eventType === "turn_complete" || eventType === "task_completed") {
        completedTurn = true;
        turnActive = false;
      }
      if (eventType === "agent_message" && payload.phase === "commentary" && typeof payload.message === "string" && sessionId) {
        const text = payload.message;
        messages.push({
          id: stableMessageId(sessionId, timestamp, "progress", text),
          sessionId,
          timestamp,
          role: "progress",
          text,
        });
      }
      continue;
    }
    if (type === "response_item") {
      if (payload.type === "function_call" && payload.name === "request_user_input" && sessionId) {
        const request = requestFromArguments(sessionId, timestamp,
          typeof payload.call_id === "string" ? payload.call_id : stableMessageId(sessionId, timestamp, "choice", String(payload.arguments ?? "")),
          payload.arguments);
        if (request) choiceRequests.push(request);
        continue;
      }
      if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
        answeredCallIds.push(payload.call_id);
        continue;
      }
      if (payload.type !== "message" || !sessionId) continue;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      let text = textFromContent(payload.content);
      if (!text) continue;
      let idText = text;
      if (role === "user") {
        const user = userMessageText(payload.content);
        if (!user.visible) continue;
        idText = user.raw;
        text = user.visible;
      }
      if (role === "assistant") {
        const embedded = embeddedChoice(sessionId, timestamp, text);
        if (embedded) {
          choiceRequests.push(embedded.request);
          text = embedded.visibleText;
          if (!text) continue;
        }
      }
      messages.push({
        id: stableMessageId(sessionId, timestamp, role, role === "user" ? idText : text),
        sessionId,
        timestamp,
        role,
        text,
      });
      continue;
    }
    if (type !== "turn_context" && type !== "world_state") unknownTypes.add(type);
  }
  return {
    ...(metadata ? { metadata } : {}),
    messages,
    choiceRequests,
    answeredCallIds,
    carry,
    completedTurn,
    turnActive,
    unknownTypes: [...unknownTypes],
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}
