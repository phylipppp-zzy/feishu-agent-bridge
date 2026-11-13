import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPermissionHookServerIfEnabled, type PermissionHookServerFactory } from "../src/claude/index.js";
import type { PermissionApprovalHandler } from "../src/claude/permission-hook.js";

test("disabled config does not construct or start a hook server", async () => {
  let factoryCalls = 0;
  const factory: PermissionHookServerFactory = () => {
    factoryCalls += 1;
    return { socketPath: "/unused", async start() {}, async stop() {} };
  };
  const handler: PermissionApprovalHandler = async (request) => ({ ...request, decision: { behavior: "deny" } });
  const service = await startPermissionHookServerIfEnabled({ permissionHookEnabled: false, stateDir: "/unused" }, handler, factory);
  assert.equal(service, null);
  assert.equal(factoryCalls, 0);
});

test("enabled config starts only under the dedicated child directory and returns lifecycle handle", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "permission-hook-lifecycle-"));
  let optionsSeen: Parameters<PermissionHookServerFactory>[0] | undefined;
  let started = 0;
  let stopped = 0;
  const factory: PermissionHookServerFactory = (options) => {
    optionsSeen = options;
    return {
      socketPath: join(String(options.stateDir), "claude-permission-hook.sock"),
      async start() { started += 1; },
      async stop() { stopped += 1; },
    };
  };
  const handler: PermissionApprovalHandler = async (request) => ({ ...request, decision: { behavior: "deny" } });
  try {
    const service = await startPermissionHookServerIfEnabled({ permissionHookEnabled: true, stateDir }, handler, factory);
    assert.ok(service);
    assert.equal(optionsSeen?.stateDir, join(stateDir, "permission-hook"));
    assert.equal(optionsSeen?.onRequest, handler);
    assert.equal(started, 1);
    await service.stop();
    assert.equal(stopped, 1);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("a partially started hook service is stopped when startup fails", async () => {
  let stopped = 0;
  const factory: PermissionHookServerFactory = () => ({
    socketPath: "/unused",
    async start() { throw new Error("listen failed"); },
    async stop() { stopped += 1; },
  });
  const handler: PermissionApprovalHandler = async (request) => ({ ...request, decision: { behavior: "deny" } });
  await assert.rejects(startPermissionHookServerIfEnabled({ permissionHookEnabled: true, stateDir: "/tmp/state" }, handler, factory), /listen failed/);
  assert.equal(stopped, 1);
});
