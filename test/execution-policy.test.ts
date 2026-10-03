import assert from "node:assert/strict";
import test from "node:test";
import { remoteApprovalAllowed } from "../src/execution-policy.js";

const context = { taskId: "t1", sessionId: "s1", collaborationMode: "default" as const, executionMode: "workspace-write" as const, canonicalCwd: "/work/project", allowedMcpServers: new Set<string>() };

test("execution policy is default-deny for unsafe approvals", () => {
  assert.equal(remoteApprovalAllowed("command_approval", { command: "printf ok" }, [], context).allowed, true);
  assert.equal(remoteApprovalAllowed("command_approval", { command: "curl https://example.invalid" }, [], context).allowed, false);
  assert.equal(remoteApprovalAllowed("file_approval", { grantRoot: "/tmp" }, [], context).allowed, false);
  assert.equal(remoteApprovalAllowed("permissions", { permissions: [{ type: "network" }] }, [], context).allowed, false);
  assert.equal(remoteApprovalAllowed("permissions", { permissions: { network: { enabled: true } } }, [], context).allowed, false);
  assert.equal(remoteApprovalAllowed("permissions", { permissions: {} }, [], context).allowed, false);
  assert.equal(remoteApprovalAllowed("mcp_elicitation", { serverName: "unknown" }, [], context).allowed, false);
});

test("Plan mode cannot approve side effects and never accepts secrets", () => {
  const plan = { ...context, collaborationMode: "plan" as const };
  assert.equal(remoteApprovalAllowed("command_approval", { command: "printf ok" }, [], plan).allowed, false);
  assert.equal(remoteApprovalAllowed("user_input", { questions: [{ isSecret: true }] }, [], plan).allowed, false);
});
