import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { configureCardUi } from "../src/card-kit.js";
import { ClaudeBridgeDatabase } from "../src/claude/db.js";
import type { ClaudeBridgeConfig } from "../src/claude/config.js";
import { ClaudeRuntime } from "../src/claude/runtime.js";
import { localFileLinks } from "../src/claude/deliver.js";
import { claudeTurnCard } from "../src/claude/cards.js";
import type { TurnView } from "../src/claude/conversation.js";
import type { CardDefinition, FeishuPort } from "../src/types.js";
import { fakeQueries } from "./claude-fake-query.js";

configureCardUi(2);
const SESSION = "11111111-1111-4111-8111-111111111111";
const cardText = (card: CardDefinition) => JSON.stringify(card);

class FilePort {
  sent: Array<{ root: string; name: string; data: Buffer; uuid?: string }> = [];
  updated: Array<{ id: string; card: CardDefinition }> = [];
  replies: Array<{ root: string; card: CardDefinition; id: string }> = [];
  failure: Error | null = null;
  async replyFile(root: string, name: string, data: Buffer, options?: { uuid?: string }): Promise<string> {
    if (this.failure) { const error = this.failure; this.failure = null; throw error; }
    this.sent.push({ root, name, data: Buffer.from(data), ...(options?.uuid ? { uuid: options.uuid } : {}) });
    return `file-${this.sent.length}`;
  }
  async getMessageMetadata(id: string) { return { chatId: "chat-test", threadId: "thread-test", appLink: `https://example.test/${id}` }; }
  async updateCard(id: string, card: CardDefinition): Promise<void> { this.updated.push({ id, card }); }
  async replyCard(root: string, card: CardDefinition): Promise<string> { const id = `result-${this.replies.length + 1}`; this.replies.push({ root, card, id }); return id; }
  asPort(): FeishuPort { return this as unknown as FeishuPort; }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "claude-file-links-"));
  const project = join(home, "project");
  const stateDir = join(home, "state");
  await mkdir(project, { recursive: true });
  const config: ClaudeBridgeConfig = { appId: "offline", appSecret: "unused", bindToken: "unused", claudeHome: join(home, ".claude"), stateDir,
    allowedRoot: project, claudeBin: "unused", runnerIdleMs: 60_000, historyDays: 1, syncDirs: [], scanIntervalMs: 60_000, livenessIntervalMs: 60_000, cardSettleMs: 0 };
  const db = new ClaudeBridgeDatabase(stateDir);
  db.updateSession({ sessionId: SESSION, path: join(home, "transcript.jsonl"), meta: { cwd: project }, firstPrompt: null, startedAtMs: 0, lastActivityMs: 0 });
  db.setSessionRoot(SESSION, "root-test", null, "chat-test");
  db.setSetting("feishu.chat_id", "chat-test");
  db.setSetting("feishu.open_id", "user-test");
  const feishu = new FilePort();
  const { factory } = fakeQueries();
  const runtime = new ClaudeRuntime(config, db, feishu.asPort(), factory);
  const action = async (eventId: string, path: string, version: string, openId = "user-test", chatId = "chat-test", turnId = "turn-test") => runtime.onCardAction({
    eventId, openId, chatId, openMessageId: "button-card", action: "deliver_link", value: { sessionId: SESSION, turnId, path, version }, formValues: {},
  });
  const close = async () => { await runtime.stop(); db.close(); await rm(home, { recursive: true, force: true }); };
  return { home, project, stateDir, config, db, feishu, runtime, action, close };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for offline callback result");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function linkedVersion(project: string, file: string) {
  const links = await localFileLinks(`[open report](${pathToFileURL(file).href})`, project, project);
  assert.equal(links.length, 1);
  return links[0]!;
}

test("local body file links are offered only for safe allowed files", async () => {
  const env = await fixture();
  try {
    const report = join(env.project, "report one.md");
    const secret = join(env.project, ".env");
    const outside = join(env.home, "outside.md");
    await writeFile(report, "offline fixture");
    await writeFile(secret, "do not select");
    await writeFile(outside, "outside");
    const links = await localFileLinks(`[report](${pathToFileURL(report).href}) [secret](${pathToFileURL(secret).href}) [outside](${pathToFileURL(outside).href}) [web](https://example.test/x)`, env.project, env.project);
    assert.deepEqual(links.map((item) => item.path), [report]);
    assert.match(links[0]!.version, /^\d+:[\d.]+:\d+$/);
  } finally { await env.close(); }
});

test("bare relative paths and line suffixes resolve safely; external links and directories are not sent", async () => {
  const env = await fixture();
  try {
    const file = join(env.project, "report.md");
    await writeFile(file, "safe");
    await mkdir(join(env.project, "folder"));
    const links = await localFileLinks("[bare](report.md:12) [fragment](report.md#L2-L4) [directory](folder) [web](https://example.test/report.md) [mail](mailto:a@b.test)", env.project, env.project);
    assert.equal(links.length, 1, "same path aliases collapse to one sendable file");
    assert.equal(links[0]!.path, file);
  } finally { await env.close(); }
});

test("turn cards keep same-label local links bound to their own send or jump action", async () => {
  const env = await fixture();
  try {
    const first = join(env.project, "one.md");
    const second = join(env.project, "two.md");
    await writeFile(first, "one");
    await writeFile(second, "two");
    const links = [(await linkedVersion(env.project, first)), (await linkedVersion(env.project, second))].map((link, index) => ({
      ...link, label: "Report", references: [{ label: "Report", href: pathToFileURL(index ? second : first).href }],
      ...(index === 0 ? { sentAppLink: "https://example.test/already-sent" } : {}),
    }));
    const view = { status: "done", durationMs: null, blocks: [{ kind: "text", text: `[Report](${pathToFileURL(first).href}) then [Report](${pathToFileURL(second).href})` }] } as unknown as TurnView;
    const card = claudeTurnCard(view, { sessionId: SESSION, fileLinks: links });
    const serialized = cardText(card);
    assert.equal((serialized.match(/deliver_link/g) ?? []).length, 1);
    assert.ok(serialized.includes(links[1]!.version));
    assert.ok(serialized.includes("[Report](https://example.test/already-sent)"));
    assert.ok(serialized.includes("Report（请点卡片下方按钮）"));
    assert.ok(serialized.includes(second), "the remaining callback stays bound to the second file");
    assert.ok(!serialized.includes(pathToFileURL(first).href), "a local path is not presented as a native Feishu link");
  } finally { await env.close(); }
});

test("authorized first click sends one file; repeat and DB restart return the original message link", async () => {
  const env = await fixture();
  try {
    const path = join(env.project, "report.md");
    await writeFile(path, "the selected file only");
    const link = await linkedVersion(env.project, path);
    const turnId = "turn-test";
    const view = { turnId, status: "done", durationMs: null, omittedTools: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      origin: "human", entrypoint: "claude-vscode", prompt: "", attachments: [], blocks: [{ kind: "text", text: `[report](${pathToFileURL(path).href})` }] } as unknown as TurnView;
    env.db.saveTurn(SESSION, view, "pending");
    env.db.setTurnCard(SESSION, turnId, "button-card", "initial-hash");
    assert.equal((await env.action("first", path, link.version)).delivery, "toast");
    await waitFor(() => env.feishu.updated.length >= 1);
    assert.equal(env.feishu.sent.length, 1);
    assert.equal(env.feishu.sent[0]!.root, "root-test");
    assert.equal(env.feishu.sent[0]!.data.toString(), "the selected file only");
    assert.ok(env.feishu.sent[0]!.uuid);
    assert.ok(cardText(env.feishu.updated[0]!.card).includes("https://applink.feishu.cn/client/chat/open"));
    assert.ok(!cardText(env.feishu.updated[0]!.card).includes("deliver_link"), "the sent file link becomes a direct markdown message link");
    assert.ok(cardText(env.feishu.updated[0]!.card).includes("file-1"));
    assert.ok(cardText(env.feishu.updated[0]!.card).includes("[report](https://applink.feishu.cn/client/chat/open?"), "the source turn body now links to its sent file message");
    assert.equal(env.feishu.replies.length, 0, "successful send updates the full source turn card in place");

    await env.action("second", path, link.version);
    await waitFor(() => env.feishu.updated.length >= 2);
    assert.equal(env.feishu.sent.length, 1, "a repeated tap does not send a second file");
    assert.ok(cardText(env.feishu.updated[1]!.card).includes("file-1"));

    env.db.close();
    const db = new ClaudeBridgeDatabase(env.stateDir);
    const { factory } = fakeQueries();
    const runtime = new ClaudeRuntime(env.config, db, env.feishu.asPort(), factory);
    await runtime.onCardAction({ eventId: "after-restart", openId: "user-test", chatId: "chat-test", openMessageId: "button-card", action: "deliver_link",
      value: { sessionId: SESSION, turnId, path, version: link.version }, formValues: {} });
    await waitFor(() => env.feishu.updated.length >= 3);
    assert.equal(env.feishu.sent.length, 1, "persisted mapping survives reopening the database");
    assert.ok(cardText(env.feishu.updated[2]!.card).includes("file-1"));
    await writeFile(path, "new version");
    const later = new Date(Date.now() + 5_000);
    await utimes(path, later, later);
    const newLink = await linkedVersion(env.project, path);
    assert.notEqual(newLink.version, link.version);
    await runtime.onCardAction({ eventId: "new-version", openId: "user-test", chatId: "chat-test", openMessageId: "button-card", action: "deliver_link",
      value: { sessionId: SESSION, turnId, path, version: newLink.version }, formValues: {} });
    await waitFor(() => env.feishu.updated.length >= 4);
    assert.equal(env.feishu.sent.length, 2, "a changed file version gets a separate Feishu message");
    assert.equal(env.feishu.sent[1]!.data.toString(), "new version");
    await runtime.onCardAction({ eventId: "old-version-again", openId: "user-test", chatId: "chat-test", openMessageId: "button-card", action: "deliver_link",
      value: { sessionId: SESSION, turnId, path, version: link.version }, formValues: {} });
    await waitFor(() => env.feishu.updated.length >= 5);
    assert.ok(cardText(env.feishu.updated[4]!.card).includes("file-2"), "current turn version stays linked to the latest file version");
    await unlink(path);
    await runtime.onCardAction({ eventId: "after-delete", openId: "user-test", chatId: "chat-test", openMessageId: "button-card", action: "deliver_link",
      value: { sessionId: SESSION, turnId, path, version: link.version }, formValues: {} });
    await waitFor(() => env.feishu.updated.length >= 6);
    assert.equal(env.feishu.sent.length, 2, "a deleted source file still maps to its already-sent Feishu message");
    db.saveTurn(SESSION, { ...view, blocks: [{ key: "text", kind: "text", text: `${view.blocks[0]!.text}\ntranscript refreshed` }] }, "pending");
    await runtime.renderSession(SESSION);
    await waitFor(() => env.feishu.updated.length >= 7);
    assert.ok(cardText(env.feishu.updated[6]!.card).includes("file-2"), "a later render retains the persisted jump even after local deletion");
    assert.ok(cardText(env.feishu.updated[6]!.card).includes("transcript refreshed"));
    await runtime.stop();
    db.close();
  } finally {
    // The database may have been reopened above; cleanup is idempotent for files.
    await rm(env.home, { recursive: true, force: true });
  }
});

test("wrong callback identity, stale/out-of-scope/credential links cannot send; Feishu failure remains retryable", async () => {
  const env = await fixture();
  try {
    const path = join(env.project, "report.md");
    await writeFile(path, "retry me");
    const link = await linkedVersion(env.project, path);
    const view = { turnId: "turn-test", status: "done", durationMs: null, omittedTools: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      origin: "human", entrypoint: "claude-vscode", prompt: "", attachments: [], blocks: [{ kind: "text", text: `[report](${pathToFileURL(path).href})` }] } as unknown as TurnView;
    env.db.saveTurn(SESSION, view, "pending");
    env.db.setTurnCard(SESSION, "turn-test", "button-card", "initial-hash");
    await env.action("wrong-user", path, link.version, "other-user");
    assert.equal(env.feishu.sent.length, 0, "callback authentication runs before file access or send");
    await env.action("wrong-chat", path, link.version, "user-test", "other-chat");
    assert.equal(env.feishu.sent.length, 0);
    await env.action("stale", path, "0:0:0");
    await waitFor(() => env.feishu.replies.length >= 1);
    assert.equal(env.feishu.sent.length, 0);
    await env.action("outside", join(env.home, "outside.md"), link.version);
    await waitFor(() => env.feishu.replies.length >= 2);
    await env.action("credential", join(env.project, ".env"), link.version);
    await waitFor(() => env.feishu.replies.length >= 3);
    assert.equal(env.feishu.sent.length, 0);

    env.feishu.failure = new Error("offline mock failure");
    await env.action("fail-once", path, link.version);
    await waitFor(() => env.feishu.replies.length >= 4);
    assert.equal(env.feishu.sent.length, 0);
    assert.equal(env.db.getFileDelivery(SESSION, "turn-test", path, link.version, "chat-test", "root-test")?.status, "failed");
    await env.action("retry", path, link.version);
    await waitFor(() => env.feishu.updated.length >= 1);
    assert.equal(env.feishu.sent.length, 1);
    assert.equal(env.db.getFileDelivery(SESSION, "turn-test", path, link.version, "chat-test", "root-test")?.status, "sent");
  } finally { await env.close(); }
});

test("a pending delivery left by a process restart can be retried", async () => {
  const env = await fixture();
  try {
    const request = "stable-request";
    assert.equal(env.db.claimFileDelivery(SESSION, "turn-test", "/tmp/x", "v1", [], "chat-test", "root-test", request), "claimed");
    env.db.close();
    const db = new ClaudeBridgeDatabase(env.stateDir);
    assert.equal(db.getFileDelivery(SESSION, "turn-test", "/tmp/x", "v1", "chat-test", "root-test")?.status, "failed");
    assert.equal(db.claimFileDelivery(SESSION, "turn-test", "/tmp/x", "v1", [], "chat-test", "root-test", request), "claimed");
    db.close();
  } finally { await rm(env.home, { recursive: true, force: true }); }
});
