import assert from "node:assert/strict";
import test from "node:test";
import { cleanPrompt, parseTranscriptChunk, parseTranscriptLine, toolSummary, type TranscriptEvent } from "../src/claude/transcript.js";

// Fixtures follow the record shapes Claude Code 2.1.28x writes; contents are synthetic.
const base = { sessionId: "11111111-2222-3333-4444-555555555555", cwd: "/home/tester/project", version: "2.1.286", gitBranch: "main", userType: "external" };
const line = (record: Record<string, unknown>) => JSON.stringify({ ...base, ...record });
const kinds = (events: TranscriptEvent[]) => events.map((event) => event.kind);

test("a VS Code prompt drops IDE context and keeps attachments and session metadata", () => {
  const events = parseTranscriptLine(line({
    type: "user", uuid: "prompt-1", parentUuid: null, isSidechain: false, timestamp: "2026-10-02T06:00:00.000Z", entrypoint: "claude-vscode",
    permissionMode: "auto", origin: { kind: "human" }, promptSource: "sdk",
    message: { role: "user", content: [
      { type: "text", text: "<ide_opened_file>The user opened the file /home/tester/project/a.ts in the IDE.</ide_opened_file>" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "修复登录页的样式" },
    ] },
  }));
  assert.deepEqual(kinds(events), ["prompt", "meta"]);
  const prompt = events[0] as Extract<TranscriptEvent, { kind: "prompt" }>;
  assert.equal(prompt.uuid, "prompt-1");
  assert.equal(prompt.origin, "human");
  assert.equal(prompt.entrypoint, "claude-vscode");
  assert.equal(prompt.text, "修复登录页的样式");
  assert.deepEqual(prompt.attachments, ["图片"]);
  assert.deepEqual((events[1] as Extract<TranscriptEvent, { kind: "meta" }>).meta,
    { cwd: "/home/tester/project", entrypoint: "claude-vscode", gitBranch: "main", permissionMode: "auto" });
});

test("prompt origins: terminal text, subagent hand-back, background task, host meta", () => {
  const terminal = parseTranscriptLine(line({ type: "user", uuid: "u1", timestamp: "t", entrypoint: "cli", message: { role: "user", content: "运行测试" } }));
  assert.equal((terminal[0] as { origin: string }).origin, "human");
  const peer = parseTranscriptLine(line({ type: "user", uuid: "u2", timestamp: "t", isMeta: true, origin: { kind: "peer", from: "a1" }, message: { role: "user", content: "调研结果……" } }));
  assert.equal((peer[0] as { origin: string }).origin, "peer");
  const task = parseTranscriptLine(line({ type: "user", uuid: "u3", timestamp: "t", origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>done</task-notification>" } }));
  assert.equal((task[0] as { origin: string }).origin, "task");
  assert.deepEqual(parseTranscriptLine(line({ type: "user", uuid: "u4", timestamp: "t", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } })), []);
});

test("slash commands start a command turn that their output ends", () => {
  const command = parseTranscriptLine(line({ type: "user", uuid: "c1", timestamp: "t", entrypoint: "cli",
    message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>" } }));
  assert.equal((command[0] as { origin: string; text: string }).origin, "command");
  assert.equal((command[0] as { text: string }).text, "/model opus");
  const output = parseTranscriptLine(line({ type: "user", uuid: "c2", timestamp: "t", message: { role: "user", content: "<local-command-stdout>Set model to opus</local-command-stdout>" } }));
  assert.deepEqual(kinds(output), ["command_done"]);
  const shell = parseTranscriptLine(line({ type: "user", uuid: "c3", timestamp: "t", message: { role: "user", content: "<bash-input>git status</bash-input>" } }));
  assert.equal((shell[0] as { text: string }).text, "! git status");
});

test("assistant records yield text, tool calls and the end of the turn", () => {
  const thinking = parseTranscriptLine(line({ type: "assistant", uuid: "a0", timestamp: "t1",
    message: { id: "msg_1", model: "claude-opus-5-5", role: "assistant", stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: "x" }] } }));
  assert.deepEqual(kinds(thinking), ["meta"]);
  const tool = parseTranscriptLine(line({ type: "assistant", uuid: "a1", timestamp: "t2",
    message: { id: "msg_1", model: "claude-opus-5-5", role: "assistant", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test\nnpm run build", description: "Run tests" } }] } }));
  assert.deepEqual(tool[1], { kind: "tool", id: "toolu_1", at: "t2", name: "Bash", summary: "npm test" });
  const answer = parseTranscriptLine(line({ type: "assistant", uuid: "a2", timestamp: "t3",
    message: { id: "msg_2", model: "claude-opus-5-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "测试全部通过。" }] } }));
  assert.deepEqual(kinds(answer), ["meta", "text", "turn_end"]);
  assert.equal((answer[1] as { key: string }).key, "a2:0");
  const synthetic = parseTranscriptLine(line({ type: "assistant", uuid: "a3", timestamp: "t4",
    message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "No response requested." }] } }));
  assert.deepEqual(kinds(synthetic), ["text"]);
});

test("tool results, interruptions, turn durations, compaction and titles", () => {
  const results = parseTranscriptLine(line({ type: "user", uuid: "r1", timestamp: "t", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
    { type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true },
  ] } }));
  assert.deepEqual(results, [{ kind: "tool_result", id: "toolu_1", at: "t", isError: false }, { kind: "tool_result", id: "toolu_2", at: "t", isError: true }]);
  assert.deepEqual(kinds(parseTranscriptLine(line({ type: "user", uuid: "i1", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }))), ["interrupted"]);
  assert.deepEqual(parseTranscriptLine(line({ type: "system", subtype: "turn_duration", durationMs: 4200, uuid: "s1", timestamp: "t" })), [{ kind: "turn_end", at: "t", durationMs: 4200 }]);
  assert.deepEqual(kinds(parseTranscriptLine(line({ type: "system", subtype: "compact_boundary", uuid: "s2", timestamp: "t" }))), ["note"]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "custom-title", customTitle: "登录页修复", sessionId: base.sessionId })), [{ kind: "meta", at: "", meta: { customTitle: "登录页修复" } }]);
  assert.deepEqual((parseTranscriptLine(JSON.stringify({ type: "ai-title", aiTitle: "Fix login page" }))[0] as { meta: object }).meta, { aiTitle: "Fix login page" });
  assert.deepEqual((parseTranscriptLine(JSON.stringify({ type: "permission-mode", permissionMode: "plan" }))[0] as { meta: object }).meta, { permissionMode: "plan" });
});

test("sidechain records, unknown types and broken lines are ignored", () => {
  assert.deepEqual(parseTranscriptLine(line({ type: "assistant", uuid: "x", isSidechain: true, timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } })), []);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "queue-operation", operation: "enqueue" })), []);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "attachment", attachment: { type: "environment" } })), []);
  assert.deepEqual(parseTranscriptLine("{not json"), []);
  assert.deepEqual(parseTranscriptChunk(`${line({ type: "user", uuid: "u", timestamp: "t", message: { role: "user", content: "hi" } })}\n\n{broken\n`).map((event) => event.kind), ["prompt", "meta"]);
});

test("prompt cleaning keeps pasted content and tool summaries stay short and relative", () => {
  assert.equal(cleanPrompt(["<system-reminder>ignore</system-reminder>看这段：<pasted_content id=\"p1\">line 1\nline 2</pasted_content>"]), "看这段：[粘贴内容]\nline 1\nline 2");
  assert.equal(toolSummary("Edit", { file_path: "/home/tester/project/src/a.ts" }, "/home/tester/project"), "src/a.ts");
  assert.equal(toolSummary("Grep", { pattern: "TODO", path: "/home/tester/project/src" }, "/home/tester/project"), "TODO · src");
  assert.equal(toolSummary("mcp__projtool__remote_exec", { command: "nvidia-smi" }, null), "nvidia-smi");
  assert.ok(toolSummary("Bash", { command: "x".repeat(500) }, null).length <= 120);
});

test("messages sent while Claude works are shown inside the running turn; other queued input is not", () => {
  const queued = (attachment: Record<string, unknown>) => parseTranscriptLine(line({ type: "attachment", uuid: "q-1", timestamp: "2026-10-02T06:02:00.000Z", attachment }));
  assert.deepEqual(queued({ type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, humanTurn: true, prompt: "另外把日志也看一下", source_uuid: "u-9" }),
    [{ kind: "note", key: "q-1:queued", at: "2026-10-02T06:02:00.000Z", text: "补充：另外把日志也看一下" }]);
  assert.deepEqual(queued({ type: "queued_command", commandMode: "prompt", origin: { kind: "human" },
    prompt: [{ type: "text", text: "<system-reminder>x</system-reminder>看这张图" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }),
    [{ kind: "note", key: "q-1:queued", at: "2026-10-02T06:02:00.000Z", text: "补充：看这张图（附件：图片）" }]);
  assert.deepEqual(queued({ type: "queued_command", commandMode: "prompt", origin: { kind: "peer" }, prompt: "<agent-message>报告</agent-message>" }), []);
  assert.deepEqual(queued({ type: "queued_command", commandMode: "task-notification", prompt: "<task-notification></task-notification>" }), []);
  assert.deepEqual(queued({ type: "skill_listing", content: "..." }), []);
});
