import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeDatabase } from "../src/db.js";

test("session search uses AND terms and treats wildcard characters literally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-search-"));
  try {
    const db = new BridgeDatabase(dir);
    db.upsertSession({ sessionId: "abcdef12-session", path: join(dir, "one.jsonl"), cwd: "/home/tester/example-project",
      startedAt: "2026-08-04T01:00:00Z", source: "cli", firstUserText: "GUI Agent paper review 100%" });
    db.upsertSession({ sessionId: "99999999-session", path: join(dir, "two.jsonl"), cwd: "/home/tester/tools",
      startedAt: "2026-08-04T02:00:00Z", source: "cli", firstUserText: "GUI experiment" });
    assert.deepEqual(db.listRecentSessions(8, "GUI Agent").map((item) => item.sessionId), ["abcdef12-session"]);
    assert.deepEqual(db.listRecentSessions(8, "abcdef12").map((item) => item.sessionId), ["abcdef12-session"]);
    assert.deepEqual(db.listRecentSessions(8, "100%").map((item) => item.sessionId), ["abcdef12-session"]);
    assert.equal(db.listRecentSessions(8, "missing").length, 0);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
