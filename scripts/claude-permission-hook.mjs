#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { isAbsolute } from "node:path";

const MAX_TIMEOUT_MS = 600_000;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const PROTOCOL = "feishu-permission-hook-v1";
const FALLBACK_MESSAGE = "审批服务不可用、已断开或超时，已拒绝。";

function deny(message = FALLBACK_MESSAGE) {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } } };
}

function parseArgs(argv) {
  let socketPath = null;
  let timeoutMs = MAX_TIMEOUT_MS;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--socket" && flag !== "--timeout-ms") throw new Error(`unknown option: ${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate option: ${flag}`);
    seen.add(flag);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--socket") socketPath = value;
    else timeoutMs = Number(value);
  }
  if (!socketPath || !isAbsolute(socketPath)) throw new Error("--socket must be an absolute Unix socket path");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error("--timeout-ms must be 1..600000");
  return { socketPath, timeoutMs };
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) throw new Error("hook input exceeds size limit");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!input || typeof input !== "object" || input.hook_event_name !== "PermissionRequest"
    || typeof input.session_id !== "string" || typeof input.transcript_path !== "string"
    || typeof input.cwd !== "string" || typeof input.tool_name !== "string" || !Object.hasOwn(input, "tool_input")) {
    throw new Error("stdin is not a PermissionRequest hook payload");
  }
  return input;
}

function requestApproval(socketPath, timeoutMs, input) {
  const requestId = randomUUID();
  const inputDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const request = { protocol: PROTOCOL, requestId, inputDigest, input };
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let finished = false;
    let connected = false;
    let buffer = Buffer.alloc(0);
    const finish = (decision) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(decision);
    };
    const timer = setTimeout(() => finish({ behavior: "deny", message: "审批等待超时，已拒绝。" }), timeoutMs);
    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE_BYTES) { finish({ behavior: "deny", message: FALLBACK_MESSAGE }); return; }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let reply;
      try { reply = JSON.parse(buffer.subarray(0, newline).toString("utf8")); } catch { finish({ behavior: "deny", message: FALLBACK_MESSAGE }); return; }
      if (reply?.protocol !== PROTOCOL || reply.requestId !== requestId || reply.inputDigest !== inputDigest
        || !reply.decision || !["allow", "deny"].includes(reply.decision.behavior)) {
        finish({ behavior: "deny", message: "审批响应与本次请求不匹配，已拒绝。" });
      } else finish(reply.decision);
    });
    socket.once("error", () => finish({ behavior: "deny", message: connected ? FALLBACK_MESSAGE : "审批服务不可用，已拒绝。" }));
    socket.once("close", () => { if (!finished) finish({ behavior: "deny", message: FALLBACK_MESSAGE }); });
  });
}

function hookOutput(decision) {
  if (decision?.behavior === "allow") {
    if ((decision.updatedInput !== undefined && (!decision.updatedInput || typeof decision.updatedInput !== "object" || Array.isArray(decision.updatedInput)))
      || (decision.updatedPermissions !== undefined && !Array.isArray(decision.updatedPermissions))) return deny("审批响应格式无效，已拒绝。");
    const result = { hookEventName: "PermissionRequest", decision: { behavior: "allow" } };
    if (decision.updatedInput && typeof decision.updatedInput === "object" && !Array.isArray(decision.updatedInput)) result.decision.updatedInput = decision.updatedInput;
    if (Array.isArray(decision.updatedPermissions)) result.decision.updatedPermissions = decision.updatedPermissions;
    return { hookSpecificOutput: result };
  }
  if (decision?.behavior === "deny") {
    if ((decision.message !== undefined && typeof decision.message !== "string")
      || (decision.interrupt !== undefined && typeof decision.interrupt !== "boolean")) return deny("审批响应格式无效，已拒绝。");
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {
      behavior: "deny", ...(typeof decision.message === "string" ? { message: decision.message } : {}),
      ...(typeof decision.interrupt === "boolean" ? { interrupt: decision.interrupt } : {}),
    } } };
  }
  return deny(FALLBACK_MESSAGE);
}

let output = deny();
try {
  const { socketPath, timeoutMs } = parseArgs(process.argv.slice(2));
  const input = await readInput();
  output = hookOutput(await requestApproval(socketPath, timeoutMs, input));
} catch (error) {
  output = deny(error instanceof Error ? error.message : FALLBACK_MESSAGE);
}
process.stdout.write(`${JSON.stringify(output)}\n`);
