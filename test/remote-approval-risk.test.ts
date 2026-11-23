import assert from "node:assert/strict";
import test from "node:test";
import { classifyRemoteApprovalRisk } from "../src/claude/remote-approval-risk.js";

const bash = (command: string) => classifyRemoteApprovalRisk("Bash", { command });

test("flags user examples and adjacent high-risk shell actions", () => {
  for (const [command, reason] of [
    ["systemctl --user restart feishu-claude-bridge.service", /启停或重启服务/],
    ["git push origin main", /git push/],
    ["git push --force-with-lease origin main", /force push/],
    ["node scripts/send-feishu-test-message.mjs", /飞书发送/],
    ["aws ec2 run-instances --instance-type g5.xlarge", /费用/],
    ["curl https://example.invalid", /网络|git 远程操作/],
    ["cat ~/.ssh/id_rsa", /密钥/],
  ] as const) {
    const risk = bash(command);
    assert.equal(risk.riskLevel, "high", command);
    assert.equal(risk.needsSecondConfirmation, true, command);
    assert.match(risk.reasons.join(" "), reason, command);
  }
});

test("classifies an exact safe shell wrapper consistently and leaves shell composition unknown", () => {
  assert.equal(bash("git status --short").riskLevel, "low");
  assert.equal(bash("/bin/bash -lc 'git status --short'").riskLevel, "low");
  assert.equal(bash("echo harmless && node ./script.js").riskLevel, "unknown");
  assert.equal(bash("node -e \"process.exit(0)\"").needsSecondConfirmation, true);
});

test("unknown tools and non-user permission-like actions require review, without claiming static certainty", () => {
  const unknown = classifyRemoteApprovalRisk("MCP__shell__run", { command: "do-opaque-thing" });
  assert.equal(unknown.riskLevel, "unknown");
  assert.equal(unknown.needsSecondConfirmation, true);
});

test("known local read-only tools stay single-step unless a sensitive path is present", () => {
  assert.equal(classifyRemoteApprovalRisk("Read", { file_path: "README.md" }).needsSecondConfirmation, false);
  assert.equal(classifyRemoteApprovalRisk("Read", { file_path: "/workspace/README.md" }).riskLevel, "unknown");
  const secret = classifyRemoteApprovalRisk("Read", { file_path: "/home/user/.config/cloud/credentials.json" });
  assert.equal(secret.riskLevel, "high");
  assert.equal(secret.needsSecondConfirmation, true);
});

test("confirmation digest changes with exact command parameters and wrapper", () => {
  const first = bash("git push origin main");
  const wrapped = bash("/bin/bash -lc 'git push origin main'");
  const changed = bash("git push origin release");
  assert.notEqual(first.inputDigest, wrapped.inputDigest);
  assert.notEqual(first.inputDigest, changed.inputDigest);
  assert.equal(first.riskLevel, "high");
  assert.equal(changed.riskLevel, "high");
  // Runtime integration must bind phase-two taps to this digest and the original nonce/card version.
});
