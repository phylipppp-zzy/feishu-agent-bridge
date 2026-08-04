import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonlChunk } from "../src/session-parser.js";

const meta = JSON.stringify({
  timestamp: "2026-08-03T00:00:00Z", type: "session_meta",
  payload: { session_id: "session-1", cwd: "/home/tester/example-project", timestamp: "2026-08-03T00:00:00Z", source: "cli" },
});

test("parses complete records and carries a partial line", () => {
  const user = JSON.stringify({ timestamp: "2026-08-03T00:00:01Z", type: "response_item", payload: {
    type: "message", role: "user", content: [{ type: "input_text", text: "hello" }],
  } });
  const split = user.length - 5;
  const first = parseJsonlChunk(`${meta}\n${user.slice(0, split)}`);
  assert.equal(first.metadata?.sessionId, "session-1");
  assert.equal(first.messages.length, 0);
  const second = parseJsonlChunk(`${user.slice(split)}\n`, first.carry, "session-1");
  assert.equal(second.messages[0]?.text, "hello");
});

test("parses an append-only chunk after session metadata was consumed", () => {
  const sessionId = "session-append";
  const input = `${JSON.stringify({ timestamp: "2026-08-04T00:00:01Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "later reply" }] } })}\n`;
  const batch = parseJsonlChunk(input, "", sessionId, sessionId);
  assert.deepEqual(batch.messages.map((message) => [message.role, message.text]), [["assistant", "later reply"]]);
});

test("keeps visible messages while excluding hidden metadata and duplicate final events", () => {
  const lines = [
    meta,
    JSON.stringify({ timestamp: "2026-08-03T00:00:01Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "hidden" }] } }),
    JSON.stringify({ timestamp: "2026-08-03T00:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>hidden</environment_context>" }] } }),
    JSON.stringify({ timestamp: "2026-08-03T00:00:03Z", type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "working" } }),
    JSON.stringify({ timestamp: "2026-08-03T00:00:04Z", type: "event_msg", payload: { type: "agent_message", phase: "final", message: "answer" } }),
    JSON.stringify({ timestamp: "2026-08-03T00:00:05Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] } }),
    JSON.stringify({ timestamp: "2026-08-03T00:00:06Z", type: "event_msg", payload: { type: "task_complete" } }),
    JSON.stringify({ timestamp: "2026-08-03T00:00:07Z", type: "future_event", payload: {} }),
  ];
  const result = parseJsonlChunk(`${lines.join("\n")}\n`);
  assert.deepEqual(result.messages.map(({ role, text }) => [role, text]), [["progress", "working"], ["assistant", "answer"]]);
  assert.equal(result.completedTurn, true);
  assert.equal(result.turnActive, false);
  assert.deepEqual(result.unknownTypes, ["future_event"]);
});

test("extracts native and embedded user-input requests", () => {
  const native = JSON.stringify({ timestamp: "2026-08-03T00:00:01Z", type: "response_item", payload: {
    type: "function_call", name: "request_user_input", call_id: "choice-1",
    arguments: JSON.stringify({ questions: [{ id: "scope", header: "范围", question: "选择范围", options: [
      { label: "完整", description: "处理全部内容" }, { label: "精简", description: "只处理重点" },
    ] }] }),
  } });
  const embedded = JSON.stringify({ timestamp: "2026-08-03T00:00:02Z", type: "response_item", payload: {
    type: "message", role: "assistant", content: [{ type: "output_text", text:
      '请选择。<feishu_input>{"questions":[{"id":"confirm","header":"确认","question":"继续吗？","options":[{"label":"继续","description":"继续执行"},{"label":"取消","description":"停止"}]}]}</feishu_input>' }],
  } });
  const result = parseJsonlChunk(`${meta}\n${native}\n${embedded}\n`);
  assert.equal(result.choiceRequests.length, 2);
  assert.equal(result.choiceRequests[0]?.questions[0]?.options[1]?.label, "精简");
  assert.deepEqual(result.messages.map((message) => message.text), ["请选择。"]);
});

test("uses the latest turn context model and reasoning effort", () => {
  const result = parseJsonlChunk(`${meta}\n${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-terra", effort: "low" } })}\n${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "ultra" } })}\n`);
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.reasoningEffort, "ultra");
});

test("keeps only the owning session segment when a log contains subagent metadata", () => {
  const own = JSON.stringify({ timestamp: "2026-08-03T00:00:01Z", type: "response_item", payload: {
    type: "message", role: "assistant", content: [{ type: "output_text", text: "own answer" }],
  } });
  const foreignMeta = JSON.stringify({ timestamp: "2026-08-03T00:00:02Z", type: "session_meta", payload: {
    session_id: "subagent-1", cwd: "/tmp", timestamp: "2026-08-03T00:00:02Z", source: "cli",
  } });
  const foreign = JSON.stringify({ timestamp: "2026-08-03T00:00:03Z", type: "response_item", payload: {
    type: "message", role: "assistant", content: [{ type: "output_text", text: "subagent answer" }],
  } });
  const result = parseJsonlChunk(`${meta}\n${own}\n${foreignMeta}\n${foreign}\n`, "", "session-1", "session-1");
  assert.equal(result.metadata?.sessionId, "session-1");
  assert.deepEqual(result.messages.map((message) => message.text), ["own answer"]);
});

test("uses the original request timestamp when expiring historical choices", () => {
  const request = JSON.stringify({ timestamp: "2020-01-01T00:00:00Z", type: "response_item", payload: {
    type: "function_call", name: "request_user_input", call_id: "choice-1",
    arguments: JSON.stringify({ questions: [{ question: "continue?", options: [{ label: "yes", description: "" }] }] }),
  } });
  const result = parseJsonlChunk(`${meta}\n${request}\n`);
  assert.ok(result.choiceRequests[0]!.expiresAt < Date.now());
});
