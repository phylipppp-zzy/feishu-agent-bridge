#!/usr/bin/env node
// Claude Code hook for feishu-claude-bridge, registered in the user's Claude Code settings by
// install-claude.mjs as `<node> <repo>/scripts/claude-hook.mjs --state-dir <STATE_DIR>`.
// It records each session's live state in <STATE_DIR>/presence/<session_id>.json, and stops a
// prompt sent from a window that opened the session before it was continued from Feishu.
//
// The hook must stay invisible: plain stdout of SessionStart and UserPromptSubmit hooks is added
// to Claude's context, so nothing is written to stdout or stderr, every error is swallowed and the
// exit code is always 0. The one exception is the JSON block decision for such a prompt, which
// Claude Code shows to the person and does not add to the context. Only Node.js built-ins are
// used so the hook works without dist/.
import { createHash } from "node:crypto";
import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;
const WAITING_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog", "agent_needs_input"]);
const MESSAGE_LIMIT = 300;
const MAX_ANCESTORS = 8;
const STDIN_LIMIT_BYTES = 32 * 1024 * 1024;
// Claude Code closes stdin right after writing the event; this only guards manual runs from a TTY.
const STDIN_TIMEOUT_MS = 2_000;
/** SessionStart sources after which the window shows the session as it is in the transcript (compaction keeps what it had). */
const LOADING_SOURCES = new Set(["startup", "resume", "clear", "fork"]);
/** Clock ticks per second of /proc/<pid>/stat start times; 100 on every mainstream Linux build. */
const CLOCK_TICKS = 100;

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

/** When the process started, in ms since the epoch: for windows opened before the hook recorded their SessionStart. */
function processStartMs(startTime) {
  if (!startTime) return null;
  const btime = /^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
  return btime ? Number(btime) * 1_000 + Number(startTime) * (1_000 / CLOCK_TICKS) : null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
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

function windowKey(owner) { return `${owner.pid}:${owner.startTime ?? ""}`; }

/** Windows (Claude Code processes) that opened the session, with when they loaded it; gone processes are dropped. */
function readWindows(stateDir, sessionId) {
  const stored = readJson(join(stateDir, "windows", `${sessionId}.json`));
  const windows = stored && typeof stored.windows === "object" && stored.windows ? stored.windows : {};
  for (const key of Object.keys(windows)) {
    const [pid, startTime] = key.split(":");
    let alive = false;
    try { alive = statFields(Number(pid))[19] === startTime; } catch { /* gone */ }
    if (!alive) delete windows[key];
  }
  return windows;
}

function writeWindows(stateDir, sessionId, windows) {
  const directory = join(stateDir, "windows");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeAtomically(join(directory, `${sessionId}.json`), JSON.stringify({ version: 1, windows }));
}

function promptHash(prompt) { return createHash("sha256").update(prompt).digest("hex").slice(0, 32); }

/**
 * Why a prompt from this window must not go out, or null. The bridge records in
 * <STATE_DIR>/feishu-activity/<session_id>.json when it last wrote into the session from Feishu;
 * a window that loaded the session before that still has the older conversation in memory, and a
 * prompt from it would continue from there, leaving the Feishu turns on a branch the window never
 * shows again. Sending the same prompt twice continues in the window anyway.
 */
function staleWindow(stateDir, sessionId, owner, prompt) {
  const activity = readJson(join(stateDir, "feishu-activity", `${sessionId}.json`));
  if (!activity || typeof activity.at !== "number") return null;
  const windows = readWindows(stateDir, sessionId);
  const key = windowKey(owner);
  const known = windows[key];
  const loadedAt = typeof known?.loadedAt === "number" ? known.loadedAt : processStartMs(owner.startTime);
  if (loadedAt === null || activity.at <= loadedAt) return null;
  const hash = prompt ? promptHash(prompt) : null;
  if (hash && known?.blockedPrompt === hash) {
    // The person chose to continue here: the window counts as up to date until Feishu is used again.
    windows[key] = { loadedAt: activity.at };
    writeWindows(stateDir, sessionId, windows);
    return null;
  }
  windows[key] = { loadedAt, ...(hash ? { blockedPrompt: hash } : {}) };
  writeWindows(stateDir, sessionId, windows);
  return [
    "这个会话在飞书（手机）上继续过，当前窗口是在那之前打开的：看不到那几轮对话，这里的 Claude 也不知道。为了不让对话分成两条，这条消息没有发出。",
    `请关闭这个会话，从历史会话中重新打开它（终端里：claude --resume ${sessionId}），再发送。`,
    "如果确实要在这个窗口里接着说（飞书上那几轮将不在这里的对话中），把同样的内容再发送一次即可。",
  ].join("\n");
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
  if (owner && input.hook_event_name === "SessionStart" && LOADING_SOURCES.has(input.source)) {
    const windows = readWindows(stateDir, sessionId);
    windows[windowKey(owner)] = { loadedAt: Date.now() };
    writeWindows(stateDir, sessionId, windows);
  }
  if (owner && input.hook_event_name === "UserPromptSubmit") {
    const reason = staleWindow(stateDir, sessionId, owner, text(input.prompt) ?? "");
    // The prompt does not run, so the session's state does not change either.
    if (reason) { writeSync(1, JSON.stringify({ decision: "block", reason })); return; }
  }
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
