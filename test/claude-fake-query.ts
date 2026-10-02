import { randomUUID } from "node:crypto";
import type { CanUseTool, Options, PermissionResult, PermissionUpdate, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { InputQueue, type QueryFactory } from "../src/claude/runner.js";

/**
 * Stands in for Claude Code behind the Agent SDK: records what the bridge sends and the controls
 * it uses, and emits the messages a test scripts. Ending the input ends the output, as the real
 * process exits when its input closes.
 */
export class FakeQuery {
  readonly received: SDKUserMessage[] = [];
  readonly calls: string[] = [];
  private readonly output = new InputQueue<SDKMessage>();
  private failure: unknown = null;

  constructor(readonly options: Options, private readonly prompt: AsyncIterable<SDKUserMessage>) { void this.consume(); }

  private async consume(): Promise<void> {
    for await (const message of this.prompt) this.received.push(message);
    this.output.close();
  }

  get sessionId(): string { return String(this.options.sessionId ?? this.options.resume ?? ""); }

  /** Claude starts working on a message: the SDK echoes it back. */
  replay(message: SDKUserMessage): void {
    this.emit({ type: "user", isReplay: true, uuid: message.uuid, session_id: this.sessionId, parent_tool_use_id: null, message: message.message });
  }

  /** Claude writes reply text, streamed as one new text block. */
  stream(text: string): void {
    const event = (body: Record<string, unknown>) => this.emit({ type: "stream_event", uuid: randomUUID(), session_id: this.sessionId, parent_tool_use_id: null, event: body });
    event({ type: "message_start", message: {} });
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  }

  /** The turn that answered `uuids` ended. */
  result(uuids: readonly string[], fields: Record<string, unknown> = {}): void {
    this.emit({ type: "result", subtype: "success", is_error: false, duration_ms: 1_000, duration_api_ms: 900, num_turns: 1, result: "", session_id: this.sessionId,
      uuid: randomUUID(), user_message_uuids: uuids, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], ...fields });
  }

  /** Claude Code asks whether a tool may run. */
  ask(toolName: string, input: Record<string, unknown>, suggestions: PermissionUpdate[] = []): { result: Promise<PermissionResult | null>; abort: AbortController } {
    const abort = new AbortController();
    const result = (this.options.canUseTool as CanUseTool)(toolName, input, { signal: abort.signal, suggestions, toolUseID: `toolu_${randomUUID()}`, requestId: randomUUID() });
    return { result, abort };
  }

  /** The process fails; the SDK's iterator throws. */
  crash(error: Error): void { this.failure = error; this.output.close(); }

  emit(message: Record<string, unknown>): void { this.output.push(message as unknown as SDKMessage); }

  async nextMessage(count: number, timeoutMs = 2_000): Promise<SDKUserMessage> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length < count) {
      if (Date.now() > deadline) throw new Error(`expected ${count} messages, got ${this.received.length}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.received[count - 1]!;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    const messages = this.output[Symbol.asyncIterator]();
    return {
      next: async () => {
        const next = await messages.next();
        if (next.done && this.failure) throw this.failure;
        return next;
      },
    };
  }

  async interrupt(): Promise<undefined> { this.calls.push("interrupt"); return undefined; }
  async setPermissionMode(mode: string): Promise<void> { this.calls.push(`mode:${mode}`); }
  async setModel(model?: string): Promise<void> { this.calls.push(`model:${model ?? ""}`); }
  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> { this.calls.push(`flags:${JSON.stringify(settings)}`); }
  async supportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
    return [{ value: "default", displayName: "Default (recommended)", description: "" }, { value: "opus", displayName: "Opus", description: "" },
      { value: "sonnet", displayName: "Sonnet", description: "" }];
  }
  close(): void { this.calls.push("close"); this.output.close(); }
}

export function fakeQueries(): { factory: QueryFactory; queries: FakeQuery[] } {
  const queries: FakeQuery[] = [];
  const factory: QueryFactory = ({ prompt, options }) => {
    const query = new FakeQuery(options, prompt);
    queries.push(query);
    return query as unknown as Query;
  };
  return { factory, queries };
}
