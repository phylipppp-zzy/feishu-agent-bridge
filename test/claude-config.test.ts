import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inSyncScope, loadClaudeConfig, parseSyncDirs } from "../src/claude/config.js";

test("SYNC_DIRS is optional, comma separated, expands ~ and resolves symlinks", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-sync-dirs-")));
  try {
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "link"));
    assert.deepEqual(parseSyncDirs(undefined), []);
    assert.deepEqual(parseSyncDirs(" , "), []);
    assert.deepEqual(parseSyncDirs(`${join(dir, "link")} , ${join(dir, "real")},~/work`, "/home/alice"), [join(dir, "real"), "/home/alice/work"]);
    assert.throws(() => parseSyncDirs("relative/dir"), /absolute/);
    const config = loadClaudeConfig({ FEISHU_APP_ID: "a", FEISHU_APP_SECRET: "s", FEISHU_BIND_TOKEN: "t" });
    assert.deepEqual(config.syncDirs, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a session is in scope when its working directory is a sync directory or below it", () => {
  assert.equal(inSyncScope("/anything", []), true);
  assert.equal(inSyncScope(null, []), true);
  assert.equal(inSyncScope(null, ["/a/b"]), false);
  assert.equal(inSyncScope("/a/b", ["/a/b"]), true);
  assert.equal(inSyncScope("/a/b/c/d", ["/a/b"]), true);
  assert.equal(inSyncScope("/a/bc", ["/a/b"]), false);
  assert.equal(inSyncScope("/a", ["/a/b"]), false);
  assert.equal(inSyncScope("/x/y", ["/a/b", "/x"]), true);
  assert.equal(inSyncScope("/x/y", ["/"]), true);
});
