import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAllowedPath } from "../src/path-policy.js";

test("allows descendants and blocks parent and symlink escapes", async () => {
  const base = await mkdtemp(join(tmpdir(), "bridge-path-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(join(root, "project"), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(root, "escape"));
  try {
    assert.equal(await resolveAllowedPath("project", root), join(root, "project"));
    await assert.rejects(resolveAllowedPath(outside, root), /outside ALLOWED_ROOT/);
    await assert.rejects(resolveAllowedPath(join(root, "escape"), root), /outside ALLOWED_ROOT/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
