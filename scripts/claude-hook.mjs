#!/usr/bin/env node
// Claude Code hook for feishu-claude-bridge, registered in the user's Claude Code settings by
// install-claude.mjs as `<node> <repo>/scripts/claude-hook.mjs --state-dir <STATE_DIR>`.
// It only records each session's live state in <STATE_DIR>/presence/<session_id>.json.
//
// The hook must stay invisible: plain stdout of SessionStart and UserPromptSubmit hooks is added
// to Claude's context, so nothing is ever written to stdout or stderr, every error is swallowed and
// the exit code is always 0. Only Node.js built-ins are used so the hook works without dist/.
import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;
const WAITING_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog", "agent_needs_input"]);
const MESSAGE_LIMIT = 300;
const MAX_ANCESTORS = 8;
const STDIN_LIMIT_BYTES = 32 * 1024 * 1024;
// Claude Code closes stdin right after writing the event; this only guards manual runs from a TTY.
const STDIN_TIMEOUT_MS = 2_000;

function quit() { process.exit(0); }
process.on("uncaughtException", quit);
process.on("unhandledRejection", quit);

function stateDirArgument(argv) {
  const index = argv.indexOf("--state-dir");
  const value = index >= 0 ? argv[index + 1] : undefined;
  // A relative path would resolve against the session's cwd, which differs per session.
  return typeof value === "string" && isAbsolute(value) ? value : null;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > STDIN_LIMIT_BYTES) quit();
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", quit);
  });
}

function presenceState(input) {
  switch (input.hook_event_name) {
    // Compaction also starts a session and can happen in the middle of a turn; keep the last state.
    case "SessionStart": return input.source === "compact" ? null : "idle";
    case "UserPromptSubmit": return "running";
    case "Stop":
    case "StopFailure": return "idle";
    case "SessionEnd": return "closed";
    case "Notification": {
      const type = input.notification_type;
      if (typeof type !== "string") return null;
      if (WAITING_NOTIFICATIONS.has(type)) return "waiting";
      // The question was answered and the turn goes on.
      if (type === "elicitation_complete" || type === "elicitation_response") return "running";
      if (type.startsWith("elicitation")) return "waiting";
      return type === "idle_prompt" ? "idle" : null;
    }
    default: return null;
  }
}

function text(value) { return typeof value === "string" ? value : null; }

function truncate(value) {
  if (value === null || value.length <= MESSAGE_LIMIT) return value;
  return Array.from(value).slice(0, MESSAGE_LIMIT).join("");
}

/** Fields of /proc/<pid>/stat after the comm, which is parenthesized and may contain spaces or ")". */
function statFields(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // fields[0] is field 3 (state); field N of proc(5) is fields[N - 3].
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
}

function isClaudeProcess(pid) {
  try { if (readFileSync(`/proc/${pid}/comm`, "utf8").replace(/\n$/, "") === "claude") return true; } catch { /* try the next signal */ }
  try { if (basename(readlinkSync(`/proc/${pid}/exe`)).includes("claude")) return true; } catch { /* try the next signal */ }
  try {
    const argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0", 1)[0];
    if (argv0 && basename(argv0) === "claude") return true;
  } catch { /* not a Claude Code process we can identify */ }
  return false;
}

/** The Claude Code process that ran this hook (through `sh -c`), with its start time to detect PID reuse. */
function claudeProcess() {
  let pid = process.ppid;
  for (let depth = 0; depth < MAX_ANCESTORS && Number.isSafeInteger(pid) && pid > 1; depth += 1) {
    let fields;
    try { fields = statFields(pid); } catch { return null; }
    if (isClaudeProcess(pid)) {
      const startTime = fields[19];
      return { pid, startTime: startTime && /^\d+$/.test(startTime) ? startTime : null };
    }
    pid = Number(fields[1]);
  }
  return null;
}

/** Replaces the target atomically so the bridge never reads a partially written file. */
function writeAtomically(target, content) {
  const temporary = `${target}.tmp-${process.pid}`;
  try { unlinkSync(temporary); } catch { /* normally absent */ }
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, content);
    } finally { closeSync(fd); }
    renameSync(temporary, target);
  } catch {
    try { unlinkSync(temporary); } catch { /* nothing left behind */ }
  }
}

async function main() {
  // Sessions the bridge starts itself through the SDK must not report presence.
  if (process.env.FEISHU_CLAUDE_BRIDGE === "1") return;
  const stateDir = stateDirArgument(process.argv.slice(2));
  if (!stateDir) return;
  setTimeout(quit, STDIN_TIMEOUT_MS).unref();
  const input = JSON.parse(await readStdin());
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return;
  const state = presenceState(input);
  if (!state) return;
  const owner = claudeProcess();
  const notification = input.hook_event_name === "Notification";
  const record = {
    version: 1,
    sessionId,
    event: input.hook_event_name,
    state,
    notificationType: notification ? text(input.notification_type) : null,
    message: notification ? truncate(text(input.message)) : null,
    transcriptPath: text(input.transcript_path),
    cwd: text(input.cwd),
    source: text(input.source),
    reason: text(input.reason),
    pid: owner?.pid ?? null,
    pidStartTime: owner?.startTime ?? null,
    at: Date.now(),
  };
  const directory = join(stateDir, "presence");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeAtomically(join(directory, `${sessionId}.json`), JSON.stringify(record));
}

main().catch(() => undefined).finally(quit);
