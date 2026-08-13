import { createHash } from "node:crypto";
import type { ChoiceQuestion, ChoiceRequest, SessionMetadata, VisibleMessage } from "./types.js";

interface ParsedBatch {
  metadata?: Omit<SessionMetadata, "path" | "firstUserText">;
  messages: VisibleMessage[];
  choiceRequests: ChoiceRequest[];
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

// These envelopes are injected by Codex/the host, not authored by the user.
// Filter only the complete synthetic record; arbitrary user XML must remain visible.
function isSyntheticHostMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const remaining = trimmed
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();
  return remaining === "";
}

export function parseJsonlChunk(input: string, previousCarry = "", knownSessionId = "", expectedSessionId = ""): ParsedBatch {
  const joined = previousCarry + input;
  const endsWithNewline = joined.endsWith("\n");
  const lines = joined.split("\n");
  const carry = endsWithNewline ? "" : (lines.pop() ?? "");
  const messages: VisibleMessage[] = [];
  const choiceRequests: ChoiceRequest[] = [];
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
      if (payload.type !== "message" || !sessionId) continue;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      let text = textFromContent(payload.content);
      if (!text) continue;
      if (role === "user" && isSyntheticHostMessage(text)) continue;
      if (role === "assistant") {
        const embedded = embeddedChoice(sessionId, timestamp, text);
        if (embedded) {
          choiceRequests.push(embedded.request);
          text = embedded.visibleText;
          if (!text) continue;
        }
      }
      messages.push({
        id: stableMessageId(sessionId, timestamp, role, text),
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
    carry,
    completedTurn,
    turnActive,
    unknownTypes: [...unknownTypes],
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}
