import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TurnView } from "../src/claude/conversation.js";
import { ClaudeBridgeDatabase } from "../src/claude/db.js";

const view = (turnId: string, prompt: string): TurnView => ({ turnId, origin: "human", entrypoint: "cli", prompt, attachments: [], startedAt: "2026-10-02T06:00:00.000Z",
  updatedAt: "2026-10-02T06:00:00.000Z", endedAt: null, durationMs: null, status: "running", blocks: [], omittedTools: 0 });

async function withDatabase(work: (db: ClaudeBridgeDatabase, stateDir: string) => void | Promise<void>, prepare?: (stateDir: string) => void): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "claude-db-"));
  prepare?.(stateDir);
  const db = new ClaudeBridgeDatabase(stateDir);
  try { await work(db, stateDir); } finally { db.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test("turns of a forked session keep their own rows although they repeat the original's ids, also after upgrading an old database", async () => {
  await withDatabase((db) => {
    const kept = db.getTurn("s1", "p1");
    assert.equal(kept?.cardMessageId, "card-1");
    assert.equal(kept?.view.prompt, "原来的问题");
    db.saveTurn("fork", view("p1", "原来的问题"), "pending");
    db.setTurnCard("fork", "p1", "card-2", "hash");
    assert.equal(db.getTurn("s1", "p1")?.cardMessageId, "card-1");
    assert.equal(db.getTurn("fork", "p1")?.cardMessageId, "card-2");
  }, (stateDir) => {
    // A database written before turns were keyed per session.
    const old = new DatabaseSync(join(stateDir, "bridge.sqlite"));
    old.exec(`CREATE TABLE turns (turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, view_json TEXT NOT NULL,
      render_state TEXT NOT NULL CHECK(render_state IN ('pending','hidden')), prompt_message_id TEXT, card_message_id TEXT, rendered_hash TEXT,
      rendered_at_ms INTEGER NOT NULL DEFAULT 0, attachment_message_id TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE INDEX turns_session_seq ON turns(session_id, seq);`);
    old.prepare("INSERT INTO turns(turn_id,session_id,seq,view_json,render_state,card_message_id,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)")
      .run("p1", "s1", 1, JSON.stringify(view("p1", "原来的问题")), "pending", "card-1", 1, 1);
    old.close();
  });
});

test("an SDK entrypoint does not replace where a session is known to come from", async () => {
  await withDatabase((db) => {
    const update = (sessionId: string, entrypoint: string) => db.updateSession({ sessionId, path: `/p/${sessionId}.jsonl`, meta: { entrypoint }, firstPrompt: null, startedAtMs: null, lastActivityMs: 1 });
    update("feishu", "feishu");
    update("feishu", "sdk-ts");
    assert.equal(db.getSession("feishu")?.entrypoint, "feishu");
    update("feishu", "claude-vscode");
    assert.equal(db.getSession("feishu")?.entrypoint, "claude-vscode");
    update("app", "sdk-py");
    assert.equal(db.getSession("app")?.entrypoint, "sdk-py");
  });
});

test("prompts typed in Feishu are remembered per session, never withdrawn, and preferences are stored per session", async () => {
  await withDatabase((db) => {
    db.updateSession({ sessionId: "s1", path: "/p/s1.jsonl", meta: { cwd: "/srv/a" }, firstPrompt: null, startedAtMs: null, lastActivityMs: 2 });
    db.updateSession({ sessionId: "s2", path: "/p/s2.jsonl", meta: { cwd: "/srv/b/c" }, firstPrompt: null, startedAtMs: null, lastActivityMs: 3 });
    db.setSessionRoot("s1", "root-1", null, "chat");
    db.recordFeishuPrompt("s1", "u1", "om_person");
    db.recordFeishuPrompt("s1", "u2", null);
    assert.deepEqual(db.feishuPrompt("s1", "u1"), { messageId: "om_person" });
    assert.deepEqual(db.feishuPrompt("s1", "u2"), { messageId: null });
    assert.equal(db.feishuPrompt("s2", "u1"), null);
    db.saveTurn("s1", view("u1", "飞书里的问题"), "pending", "feishu:om_person");
    db.saveTurn("s1", view("u1", "飞书里的问题"), "pending", null);
    assert.equal(db.getTurn("s1", "u1")?.promptMessageId, "feishu:om_person");
    db.setTurnCard("s1", "u1", "card-1", "hash");
    assert.deepEqual(db.topicMessages("s1"), ["card-1", "root-1"]);

    db.setSessionPrefs("s1", { mode: "plan", model: "sonnet" });
    db.setSessionPrefs("s1", { model: "" , effort: "high" });
    const session = db.getSession("s1")!;
    assert.deepEqual([session.prefMode, session.prefModel, session.prefEffort, session.rootDirty], ["plan", null, "high", true]);
    assert.deepEqual(db.recentDirectories(5), ["/srv/b/c", "/srv/a"]);
    assert.deepEqual(db.recentDirectories(5, ["/srv/b"]), ["/srv/b/c"]);
  });
});
