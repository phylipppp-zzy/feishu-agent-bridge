import { randomUUID } from "node:crypto";
import { query as sdkQuery, type CanUseTool, type ModelInfo, type Options, type PermissionMode, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Runs Claude Code sessions for Feishu through the Agent SDK. The SDK starts the same `claude`
 * binary the person uses locally, with their user, project and local settings, so permission
 * rules, CLAUDE.md, MCP servers and slash commands behave as in the terminal. What Claude does
 * reaches Feishu through the transcript, like any local session; the runner adds what only the
 * live process knows: the reply while it is being written, permission requests and turn ends.
 */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
/** Modes a Feishu user may choose; bypassing permissions is never offered remotely. */
export type FeishuPermissionMode = "default" | "acceptEdits" | "plan" | "auto";
export const FEISHU_PERMISSION_MODES: readonly FeishuPermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

export interface ImageInput { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; base64: string }

/** The image type of `data` from its first bytes; null for anything Claude cannot read as an image. */
export function imageMediaType(data: Buffer): ImageInput["mediaType"] | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** A queue the SDK reads as streaming input, which keeps the session open between turns. */
export class InputQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export interface RunnerHandlers {
  /** Claude started working on a message sent with `send` (its uuid). */
  onPrompt(uuid: string): void;
  /** Text of the reply being written for prompt `uuid`; an empty string clears it. */
  onLiveText(text: string, uuid: string | null): void;
  onTurnEnd(result: { interrupted: boolean; error: string | null }): void;
  canUseTool: CanUseTool;
  /** The Claude Code process ended; `error` is set when it failed rather than finished. */
  onClosed(error: unknown): void;
}

export interface RunnerOptions {
  /** The session to resume, or the id of the new or forked session. */
  sessionId: string;
  mode: "new" | "resume" | "fork";
  /** The session a fork copies. */
  forkFrom?: string;
  cwd: string;
  claudeBin: string;
  permissionMode: FeishuPermissionMode;
  model: string | null;
  effort: EffortLevel | null;
}

export type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export class SessionRunner {
  private readonly input = new InputQueue<SDKUserMessage>();
  private query: Query | null = null;
  private interrupting = false;
  private liveText = "";
  private livePrompt: string | null = null;
  /** Messages sent and not yet answered by a result; a turn is running while this is above zero. */
  private pending = 0;
  private closedPromise: Promise<void> | null = null;

  constructor(readonly options: RunnerOptions, private readonly handlers: RunnerHandlers, private readonly factory: QueryFactory = sdkQuery) {}

  get sessionId(): string { return this.options.sessionId; }
  get busy(): boolean { return this.pending > 0; }

  start(): void {
    const { options } = this;
    const session: Partial<Options> = options.mode === "new" ? { sessionId: options.sessionId }
      : options.mode === "fork" ? { resume: options.forkFrom ?? "", forkSession: true, sessionId: options.sessionId }
      : { resume: options.sessionId };
    this.query = this.factory({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        ...session,
        pathToClaudeCodeExecutable: options.claudeBin,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        // Passed explicitly: without it recent SDKs may start in auto mode.
        permissionMode: options.permissionMode,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        includePartialMessages: true,
        // Echoes each message when Claude starts on it, which tells which prompt a reply belongs to.
        extraArgs: { "replay-user-messages": null },
        canUseTool: this.handlers.canUseTool,
        // The marker keeps the bridge's own sessions out of the presence hook; env replaces the whole environment.
        env: { ...process.env, FEISHU_CLAUDE_BRIDGE: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
      },
    });
    this.closedPromise = this.read();
  }

  /** Sends a message; `next` reaches Claude after the current tool call, `later` waits for the turn to end. */
  send(text: string, images: readonly ImageInput[] = [], priority: "next" | "later" = "next", uuid: string = randomUUID()): string {
    const content = images.length
      ? [...images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mediaType, data: image.base64 } })),
        ...(text ? [{ type: "text" as const, text }] : [])]
      : text;
    this.pending += 1;
    this.input.push({ type: "user", uuid: uuid as NonNullable<SDKUserMessage["uuid"]>, parent_tool_use_id: null, origin: { kind: "human" }, priority, message: { role: "user", content } });
    return uuid;
  }

  async interrupt(): Promise<void> {
    if (!this.query || !this.busy) return;
    this.interrupting = true;
    await this.query.interrupt();
  }

  async setPermissionMode(mode: FeishuPermissionMode): Promise<void> { await this.query?.setPermissionMode(mode as PermissionMode); }
  async setModel(model: string | null): Promise<void> { await this.query?.setModel(model ?? undefined); }
  async setEffort(effort: EffortLevel | null): Promise<void> { await this.query?.applyFlagSettings({ effortLevel: effort }); }
  async supportedModels(): Promise<ModelInfo[]> { return this.query ? this.query.supportedModels() : []; }

  /** Ends the input; Claude Code finishes what it is doing and exits. */
  close(): void { this.input.close(); }

  /** Stops the Claude Code process at once. */
  terminate(): void { this.input.close(); this.query?.close(); }

  /** Resolves when the process has ended, or after `timeoutMs`. */
  async closed(timeoutMs: number): Promise<void> {
    if (!this.closedPromise) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.closedPromise, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
  }

  private async read(): Promise<void> {
    try {
      for await (const message of this.query!) this.handle(message);
      this.handlers.onClosed(null);
    } catch (error) {
      this.handlers.onClosed(error);
    }
  }

  private handle(message: SDKMessage): void {
    if (message.type === "user" && "isReplay" in message && message.isReplay && !message.parent_tool_use_id) {
      this.livePrompt = message.uuid;
      this.handlers.onPrompt(message.uuid);
      return;
    }
    if (message.type === "stream_event") {
      if (message.parent_tool_use_id) return;
      const event = message.event as { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string } };
      // Only the text block being written is shown live; finished blocks come from the transcript.
      if (event.type === "message_start" || (event.type === "content_block_start" && event.content_block?.type === "text")) this.setLiveText("");
      else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) this.setLiveText(this.liveText + event.delta.text);
      return;
    }
    if (message.type === "result") {
      this.setLiveText("");
      const interrupted = this.interrupting && message.subtype !== "success";
      this.interrupting = false;
      this.pending = Math.max(0, this.pending - Math.max(1, message.user_message_uuids?.length ?? 1));
      const error = interrupted ? null
        : message.subtype === "success" ? (message.is_error ? message.result || "请求失败" : null)
        : message.errors.length ? String(message.errors[0]) : message.subtype;
      this.handlers.onTurnEnd({ interrupted, error });
    }
  }

  private setLiveText(text: string): void {
    if (text === this.liveText) return;
    this.liveText = text;
    this.handlers.onLiveText(text, this.livePrompt);
  }
}
