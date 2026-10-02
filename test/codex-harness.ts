import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexAppServer, JsonRpcMessage } from "../src/app-server.js";
import { CodexCliProbe } from "../src/codex.js";
import { BridgeDatabase } from "../src/db.js";
import { SyncService } from "../src/sync.js";
import type { BridgeConfig, FeishuPort, IncomingFeishuMessage, TurnState } from "../src/types.js";

/**
 * Fakes for driving the Codex bridge through failure paths: a Feishu port whose calls can be
 * made to fail or wait, and an app-server whose replies a test decides per call.
 */

export class FakeFeishu implements FeishuPort {
  texts: Array<{ root: string; text: string }> = [];
  cards: Array<{ root: string; id: string; card: Record<string, unknown> }> = [];
  updated: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  files: Array<{ root: string; name: string; data: Buffer; uuid?: string }> = [];
  calls: string[] = [];
  /** Return an error to make that call fail. */
  failReplyText: ((text: string) => Error | null) | null = null;
  failReplyCard: ((card: Record<string, unknown>) => Error | null) | null = null;
  failReplyFile: (() => Error | null) | null = null;
  /** When set, card updates wait for this promise. */
  updateGate: Promise<void> | null = null;
  private sequence = 0;
  async start(): Promise<void> {}
  async createSessionRoot(chatId: string, title: string, _detail: string, card?: Record<string, unknown>) {
    if (card) this.cards.push({ root: "", id: "root-1", card });
    return { messageId: "root-1", appLink: "https://example.test/root-1", chatId, threadId: `thread-${title.length}` };
  }
  async replyText(root: string, text: string): Promise<string> {
    this.calls.push("replyText");
    const failure = this.failReplyText?.(text); if (failure) throw failure;
    this.texts.push({ root, text }); return `text-${++this.sequence}`;
  }
  async replyFile(root: string, name: string, data: Buffer, options?: { uuid?: string }): Promise<string> {
    this.calls.push("replyFile");
    const failure = this.failReplyFile?.(); if (failure) throw failure;
    this.files.push({ root, name, data, ...(options?.uuid ? { uuid: options.uuid } : {}) }); return `file-${++this.sequence}`;
  }
  async downloadImage(): Promise<Buffer> { return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]); }
  async sendText(_chat: string, text: string): Promise<string> { this.texts.push({ root: "", text }); return `text-${++this.sequence}`; }
  async sendCard(_chat: string, card: Record<string, unknown>): Promise<string> { const id = `card-${++this.sequence}`; this.cards.push({ root: "", id, card }); return id; }
  /** When set, card replies wait for this promise. */
  replyCardGate: Promise<void> | null = null;
  async replyCard(root: string, card: Record<string, unknown>): Promise<string> {
    this.calls.push("replyCard");
    if (this.replyCardGate) await this.replyCardGate;
    const failure = this.failReplyCard?.(card); if (failure) throw failure;
    const id = `card-${++this.sequence}`; this.cards.push({ root, id, card }); return id;
  }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (this.updateGate) await this.updateGate;
    this.updated.push({ messageId, card });
  }
  async deleteMessage(): Promise<void> {}
  async getMessageMetadata() { return { chatId: "chat-1", threadId: "thread-1", appLink: "https://example.test/root-1" }; }
  /** The latest version of a card, after updates. */
  latest(id: string): Record<string, unknown> | undefined {
    return this.updated.filter((update) => update.messageId === id).at(-1)?.card ?? this.cards.find((card) => card.id === id)?.card;
  }
}

export function title(card: Record<string, unknown> | undefined): string {
  return (card?.header as { title?: { content?: string } } | undefined)?.title?.content ?? "";
}

type Reply = unknown | Error | Promise<unknown>;

export function fakeAppServer(reply: (method: string, params: Record<string, unknown>) => Reply = () => ({})) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = {
    appServerEpoch: 1,
    getHealth: () => ({ state: "healthy", epoch: 1, sinceMs: 0 }),
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const result = await reply(method, params);
      if (result instanceof Error) throw result;
      return result;
    },
    unsubscribeThread: async () => undefined,
    interrupt: async () => undefined,
    close: async () => undefined,
  } as unknown as CodexAppServer;
  return { server, calls, count: (method: string) => calls.filter((call) => call.method === method).length };
}

export type Internals = {
  turnCoordinator: { hasActiveTurn(sessionId: string): boolean; mutableTurn(sessionId: string): TurnState | null };
  approvalService: { pendingCount(): number };
  onAppServerNotification(message: JsonRpcMessage): Promise<void>;
  onAppServerRequest(message: JsonRpcMessage): Promise<unknown>;
  drainTaskQueue(sessionId: string | null): Promise<void>;
};

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition was not met in time: ${condition.toString().slice(0, 160)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const baseMs = Date.parse("2026-08-05T00:00:00Z");
export const at = (seconds: number) => new Date(baseMs + seconds * 1_000).toISOString();
export const jsonl = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
export const userRecord = (seconds: number, text: string) => ({ timestamp: at(seconds), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
export const assistantRecord = (seconds: number, text: string) => ({ timestamp: at(seconds), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
export const eventRecord = (seconds: number, type: string) => ({ timestamp: at(seconds), type: "event_msg", payload: { type } });

export function inbound(overrides: Partial<IncomingFeishuMessage> = {}): IncomingFeishuMessage {
  return { messageId: "message-1", chatId: "chat-1", chatType: "group", senderOpenId: "user-1", mentionedBot: false, text: "", imageKeys: [], rootId: "root-1", ...overrides };
}

export function cardAction(action: string, value: Record<string, unknown> = {}, openMessageId = "card-x") {
  return { openId: "user-1", chatId: "chat-1", openMessageId, action, value, formValues: {} };
}

export const SESSION_ID = "44444444-4444-4444-4444-444444444444";

/** One imported local Codex session whose topic root is `root-1`, served by the given app-server. */
export async function importedSession(home: string, appServer?: CodexAppServer, records: unknown[] = [userRecord(1, "hello"), assistantRecord(2, "world"), eventRecord(3, "task_complete")]) {
  const codexHome = join(home, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "05");
  const path = join(sessions, `rollout-2026-08-05T00-00-00-${SESSION_ID}.jsonl`);
  await mkdir(sessions, { recursive: true });
  const meta = { timestamp: at(0), type: "session_meta", payload: { session_id: SESSION_ID, cwd: home, timestamp: at(0), source: "cli" } };
  await writeFile(path, jsonl([meta, ...records]));
  const config: BridgeConfig = {
    appId: "app", appSecret: "secret", allowedRoot: home, codexHome, codexBin: "/bin/false", stateDir: join(home, "state"),
    bindToken: "token", scanIntervalMs: 1_000, activeSessionQuietMs: 1,
  };
  const db = new BridgeDatabase(config.stateDir);
  db.setSetting("feishu.chat_id", "chat-1"); db.setSetting("feishu.open_id", "user-1");
  const feishu = new FakeFeishu();
  const service = new SyncService(config, db, feishu, new CodexCliProbe("/bin/false", codexHome), appServer);
  await service.syncAll();
  return { service, db, feishu, path, config, internals: service as unknown as Internals };
}

/** Stops the service and lets background work settle before the database closes. */
export async function shutdown(env: Awaited<ReturnType<typeof importedSession>>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await env.service.stop();
  env.db.close();
}

/** Keeps the event loop alive while a test waits on the bridge's own (unreferenced) timers. */
export async function whileWaiting<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 10);
  try { return await promise; } finally { clearInterval(keepAlive); }
}

/** Starts a bridge turn `turn-1` in the imported session by sending a topic message. */
export async function startTurn(env: Awaited<ReturnType<typeof importedSession>>, text = "开始任务"): Promise<void> {
  await env.service.onFeishuMessage(inbound({ messageId: "start-1", text }));
  await waitFor(() => env.internals.turnCoordinator.hasActiveTurn(SESSION_ID));
}
