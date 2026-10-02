/**
 * Tolerant reader for Claude Code session transcripts
 * (`<CLAUDE_HOME>/projects/<encoded cwd>/<session id>.jsonl`).
 *
 * Claude Code documents this format as internal and version dependent, so every
 * field is optional here and unknown record types are ignored instead of rejected.
 * Each record becomes zero or more display events; replaying the same record yields
 * the same event keys, which keeps re-imports idempotent.
 */

/** Who started a turn: the person, a subagent hand-back, a background task, a slash or shell command, or the host. */
export type PromptOrigin = "human" | "peer" | "task" | "command" | "system";

export interface TranscriptMeta {
  customTitle?: string;
  aiTitle?: string;
  permissionMode?: string;
  model?: string;
  cwd?: string;
  entrypoint?: string;
  gitBranch?: string;
}

export type TranscriptEvent =
  | { kind: "prompt"; uuid: string; at: string; origin: PromptOrigin; entrypoint: string | null; text: string; attachments: string[] }
  | { kind: "text"; key: string; at: string; text: string }
  | { kind: "tool"; id: string; at: string; name: string; summary: string }
  | { kind: "tool_result"; id: string; at: string; isError: boolean }
  | { kind: "turn_end"; at: string; durationMs: number | null }
  | { kind: "interrupted"; at: string }
  /** A local slash command (such as /clear or /model) finished; it produces no Claude reply. */
  | { kind: "command_done"; at: string }
  | { kind: "note"; key: string; at: string; text: string }
  | { kind: "meta"; at: string; meta: TranscriptMeta };

const INTERRUPTED = /^\[Request interrupted by user/;
const COMMAND = /^\s*<command-(?:name|message)>/;
const SHELL_INPUT = /^\s*<bash-input>/;
// Output that Claude Code records as a user message after a local command; not something the person typed.
const COMMAND_OUTPUT = /^\s*<(?:local-command-(?:stdout|stderr|caveat)|bash-(?:stdout|stderr))>/;
// The result of a local slash command or `!` shell command; it ends that command's turn.
const COMMAND_RESULT = /^\s*<(?:local-command-(?:stdout|stderr)|bash-(?:stdout|stderr))>/;
// Context the IDE or host attaches to a prompt; the person did not write it.
const ATTACHED_CONTEXT = /<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/g;
const PASTED = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content>/g;
const MAX_TEXT_CHARS = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function asRecord(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function str(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }

type MetaInput = { [K in keyof TranscriptMeta]?: string | undefined };

function compactMeta(values: MetaInput): TranscriptMeta {
  const meta: TranscriptMeta = {};
  for (const [key, value] of Object.entries(values) as Array<[keyof TranscriptMeta, string | undefined]>) if (value) meta[key] = value;
  return meta;
}

function metaEvent(at: string, values: MetaInput): TranscriptEvent[] {
  const meta = compactMeta(values);
  return Object.keys(meta).length ? [{ kind: "meta", at, meta }] : [];
}

function oneLine(value: unknown, limit = 120): string {
  if (typeof value !== "string") return "";
  const line = value.split("\n").find((part) => part.trim()) ?? "";
  const compact = line.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function relativePath(path: unknown, cwd: string | null): string {
  if (typeof path !== "string") return "";
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

/** A short, terminal-like description of a tool call, e.g. the command of `Bash` or the file of `Edit`. */
export function toolSummary(name: string, input: Record<string, unknown>, cwd: string | null): string {
  switch (name) {
    case "Bash": return oneLine(input.command) || oneLine(input.description);
    case "Read": case "Write": case "Edit": case "MultiEdit": return oneLine(relativePath(input.file_path, cwd));
    case "NotebookEdit": return oneLine(relativePath(input.notebook_path, cwd));
    case "Glob": case "Grep": return [oneLine(input.pattern), oneLine(relativePath(input.path, cwd))].filter(Boolean).join(" · ");
    case "Agent": case "Task": return oneLine(input.description) || oneLine(input.subagent_type);
    case "WebFetch": return oneLine(input.url);
    case "WebSearch": return oneLine(input.query);
    case "TodoWrite": return Array.isArray(input.todos) ? `${input.todos.length} 项` : "";
    case "AskUserQuestion": return oneLine(asRecord(Array.isArray(input.questions) ? input.questions[0] : undefined).question);
    case "Skill": return oneLine(input.skill) || oneLine(input.command);
    default: return oneLine(Object.values(input).find((value) => typeof value === "string"));
  }
}

function commandText(raw: string): string {
  const shell = raw.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  if (shell) return `! ${shell[1]!.trim()}`;
  const name = raw.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim() ?? "";
  const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? "";
  const command = name ? (name.startsWith("/") ? name : `/${name}`) : raw.replace(/<[^>]+>/g, " ").trim();
  return [command, args].filter(Boolean).join(" ");
}

/** The text the person typed, without IDE context; pasted blocks stay visible. */
export function cleanPrompt(parts: readonly string[]): string {
  return parts
    .map((part) => part.replace(ATTACHED_CONTEXT, "").replace(PASTED, (_match, body: string) => `[粘贴内容]\n${body.trim()}`).trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT_CHARS);
}

function promptOrigin(record: Record<string, unknown>, text: string): PromptOrigin | null {
  const kind = str(asRecord(record.origin).kind);
  if (kind === "human") return COMMAND.test(text) || SHELL_INPUT.test(text) ? "command" : "human";
  if (kind === "peer") return "peer";
  if (kind === "task-notification") return "task";
  if (kind) return record.isMeta === true ? null : "system";
  // Records written before `origin` existed.
  if (record.isMeta === true || COMMAND_OUTPUT.test(text)) return null;
  if (COMMAND.test(text) || SHELL_INPUT.test(text)) return "command";
  return "human";
}

function userEvents(record: Record<string, unknown>, at: string): TranscriptEvent[] {
  const content = asRecord(record.message).content;
  const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
  const results = blocks.filter((block) => block.type === "tool_result");
  if (results.length) {
    return results.flatMap((block): TranscriptEvent[] => {
      const id = str(block.tool_use_id);
      return id ? [{ kind: "tool_result", id, at, isError: block.is_error === true }] : [];
    });
  }
  const parts = typeof content === "string" ? [content] : blocks.filter((block) => block.type === "text").map((block) => str(block.text) ?? "");
  const raw = parts.join("\n");
  if (INTERRUPTED.test(raw.trim())) return [{ kind: "interrupted", at }];
  if (COMMAND_RESULT.test(raw)) return [{ kind: "command_done", at }];
  const uuid = str(record.uuid);
  const origin = uuid ? promptOrigin(record, raw) : null;
  if (!uuid || !origin) return [];
  const attachments = blocks.flatMap((block) => block.type === "image" ? ["图片"] : block.type === "document" ? ["文档"] : []);
  const text = origin === "command" ? commandText(raw) : cleanPrompt(parts);
  if (!text && !attachments.length) return [];
  const entrypoint = str(record.entrypoint) ?? null;
  return [
    { kind: "prompt", uuid, at, origin, entrypoint, text, attachments },
    ...metaEvent(at, { cwd: str(record.cwd), entrypoint: entrypoint ?? undefined, gitBranch: str(record.gitBranch), permissionMode: str(record.permissionMode) }),
  ];
}

function assistantEvents(record: Record<string, unknown>, at: string): TranscriptEvent[] {
  const message = asRecord(record.message);
  const recordId = str(record.uuid) ?? str(message.id) ?? at;
  const cwd = str(record.cwd) ?? null;
  const model = str(message.model);
  const events: TranscriptEvent[] = model && model !== "<synthetic>" ? [{ kind: "meta", at, meta: { model } }] : [];
  const content = Array.isArray(message.content) ? message.content : [];
  content.forEach((value, index) => {
    const block = asRecord(value);
    if (block.type === "text") {
      const text = (str(block.text) ?? "").trim();
      if (text) events.push({ kind: "text", key: `${recordId}:${index}`, at, text: text.slice(0, MAX_TEXT_CHARS) });
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      const id = str(block.id);
      const name = str(block.name) ?? "tool";
      if (id) events.push({ kind: "tool", id, at, name, summary: toolSummary(name, asRecord(block.input), cwd) });
    }
  });
  const stop = str(message.stop_reason);
  if (stop === "end_turn" || stop === "stop_sequence") events.push({ kind: "turn_end", at, durationMs: null });
  return events;
}

function systemEvents(record: Record<string, unknown>, at: string): TranscriptEvent[] {
  const subtype = str(record.subtype);
  if (subtype === "turn_duration") return [{ kind: "turn_end", at, durationMs: typeof record.durationMs === "number" ? record.durationMs : null }];
  if (subtype === "compact_boundary") return [{ kind: "note", key: `${str(record.uuid) ?? at}:compact`, at, text: "上下文已压缩" }];
  if (subtype === "local_command") return [{ kind: "command_done", at }];
  return [];
}

export function transcriptEvents(record: Record<string, unknown>): TranscriptEvent[] {
  // Subagent work is summarised by its tool call in the main transcript.
  if (record.isSidechain === true) return [];
  const at = str(record.timestamp) ?? "";
  switch (record.type) {
    case "user": return userEvents(record, at);
    case "assistant": return assistantEvents(record, at);
    case "system": return systemEvents(record, at);
    case "custom-title": return metaEvent(at, { customTitle: str(record.customTitle) });
    case "ai-title": return metaEvent(at, { aiTitle: str(record.aiTitle) });
    case "summary": return metaEvent(at, { aiTitle: str(record.summary) });
    case "permission-mode": return metaEvent(at, { permissionMode: str(record.permissionMode) });
    default: return [];
  }
}

export function parseTranscriptLine(line: string): TranscriptEvent[] {
  if (!line.trim()) return [];
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? transcriptEvents(value) : [];
  } catch { return []; }
}

/** Events of every complete line; a trailing partial line is left for the next read. */
export function parseTranscriptChunk(chunk: string): TranscriptEvent[] {
  return chunk.split("\n").flatMap(parseTranscriptLine);
}
