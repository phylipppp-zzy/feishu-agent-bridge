import type { PromptOrigin, TranscriptEvent, TranscriptMeta } from "./transcript.js";

/**
 * Groups transcript events into turns: one prompt (from the person, a subagent
 * hand-back, a background task or a command) and everything Claude did until the
 * next prompt. Each turn becomes one Feishu card, mirroring one exchange in the terminal.
 */

export type TurnStatus = "running" | "done" | "interrupted";
export type ToolStatus = "running" | "ok" | "error";

export interface TurnBlock {
  key: string;
  kind: "text" | "tool" | "note";
  text: string;
  name?: string;
  status?: ToolStatus;
}

export interface TurnView {
  turnId: string;
  origin: PromptOrigin;
  entrypoint: string | null;
  prompt: string;
  attachments: string[];
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: TurnStatus;
  blocks: TurnBlock[];
  /** Tool calls beyond the per-turn cap; counted but not listed. */
  omittedTools: number;
}

export interface ReduceResult {
  /** Turns created or changed by the events, in the order they were first touched. */
  touched: TurnView[];
  current: TurnView | null;
  meta: TranscriptMeta;
  firstHumanPrompt: string | null;
  firstAt: string | null;
  lastAt: string | null;
}

const MAX_TOOL_BLOCKS = 200;

function elapsed(from: string, to: string): number | null {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function upsert(turn: TurnView, block: TurnBlock): void {
  const index = turn.blocks.findIndex((item) => item.key === block.key);
  if (index >= 0) turn.blocks[index] = { ...turn.blocks[index], ...block };
  else turn.blocks.push(block);
}

/** New text or tool use after the turn ended means Claude continued it (for example after a Stop hook). */
function reopen(turn: TurnView): void {
  if (turn.status !== "done") return;
  turn.status = "running";
  turn.endedAt = null;
  turn.durationMs = null;
}

/**
 * Applies events to the session's current turn. The function is pure: the given turn
 * is copied, and replaying the same events yields the same views.
 */
export function reduceTranscript(sessionId: string, current: TurnView | null, events: readonly TranscriptEvent[]): ReduceResult {
  const touched = new Map<string, TurnView>();
  let turn: TurnView | null = current ? structuredClone(current) : null;
  const meta: TranscriptMeta = {};
  let firstHumanPrompt: string | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  const touch = (view: TurnView, at: string) => {
    if (at) view.updatedAt = at;
    touched.set(view.turnId, view);
  };
  // Records that precede every prompt (a transcript read from the middle) still need a home.
  const ensureTurn = (at: string): TurnView => {
    turn ??= { turnId: `${sessionId}:orphan:${at || "start"}`, origin: "system", entrypoint: null, prompt: "", attachments: [],
      startedAt: at, updatedAt: at, endedAt: null, durationMs: null, status: "running", blocks: [], omittedTools: 0 };
    return turn;
  };

  for (const event of events) {
    if (event.at) { firstAt ??= event.at; lastAt = event.at; }
    switch (event.kind) {
      case "meta":
        Object.assign(meta, event.meta);
        break;
      case "prompt": {
        if (turn?.status === "running") {
          turn.status = "done";
          turn.endedAt = event.at || turn.updatedAt;
          touch(turn, "");
        }
        turn = { turnId: event.uuid, origin: event.origin, entrypoint: event.entrypoint, prompt: event.text, attachments: event.attachments,
          startedAt: event.at, updatedAt: event.at, endedAt: null, durationMs: null, status: "running", blocks: [], omittedTools: 0 };
        if (event.origin === "human") firstHumanPrompt ??= event.text;
        touch(turn, event.at);
        break;
      }
      case "text": {
        const view = ensureTurn(event.at);
        reopen(view);
        upsert(view, { key: event.key, kind: "text", text: event.text });
        touch(view, event.at);
        break;
      }
      case "tool": {
        const view = ensureTurn(event.at);
        reopen(view);
        const key = `tool:${event.id}`;
        const existing = view.blocks.find((block) => block.key === key);
        if (existing) upsert(view, { key, kind: "tool", name: event.name, text: event.summary });
        else if (view.blocks.filter((block) => block.kind === "tool").length >= MAX_TOOL_BLOCKS) view.omittedTools += 1;
        else view.blocks.push({ key, kind: "tool", name: event.name, text: event.summary, status: "running" });
        touch(view, event.at);
        break;
      }
      case "tool_result": {
        const block = turn?.blocks.find((item) => item.key === `tool:${event.id}`);
        if (!turn || !block) break;
        block.status = event.isError ? "error" : "ok";
        touch(turn, event.at);
        break;
      }
      case "note": {
        const view = ensureTurn(event.at);
        upsert(view, { key: event.key, kind: "note", text: event.text });
        touch(view, event.at);
        break;
      }
      case "turn_end": {
        if (!turn || turn.status === "interrupted") break;
        turn.status = "done";
        turn.endedAt = event.at || turn.updatedAt;
        turn.durationMs = event.durationMs ?? turn.durationMs ?? elapsed(turn.startedAt, turn.endedAt);
        touch(turn, event.at);
        break;
      }
      case "command_done": {
        if (!turn || turn.origin !== "command" || turn.status !== "running") break;
        turn.status = "done";
        turn.endedAt = event.at || turn.updatedAt;
        turn.durationMs = elapsed(turn.startedAt, turn.endedAt);
        touch(turn, event.at);
        break;
      }
      case "interrupted": {
        if (!turn) break;
        turn.status = "interrupted";
        turn.endedAt = event.at || turn.updatedAt;
        turn.durationMs = elapsed(turn.startedAt, turn.endedAt);
        for (const block of turn.blocks) if (block.kind === "tool" && block.status === "running") block.status = "error";
        touch(turn, event.at);
        break;
      }
    }
  }
  return { touched: [...touched.values()], current: turn, meta, firstHumanPrompt, firstAt, lastAt };
}
