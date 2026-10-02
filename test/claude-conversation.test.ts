import assert from "node:assert/strict";
import test from "node:test";
import { reduceTranscript } from "../src/claude/conversation.js";
import type { TranscriptEvent } from "../src/claude/transcript.js";

const prompt = (uuid: string, at: string, text = "做点什么", origin: "human" | "command" | "peer" = "human"): TranscriptEvent =>
  ({ kind: "prompt", uuid, at, origin, entrypoint: "claude-vscode", text, attachments: [] });

const turnEvents: TranscriptEvent[] = [
  prompt("p1", "2026-10-02T06:00:00.000Z", "运行测试"),
  { kind: "meta", at: "2026-10-02T06:00:00.000Z", meta: { cwd: "/w", entrypoint: "claude-vscode" } },
  { kind: "text", key: "a1:0", at: "2026-10-02T06:00:01.000Z", text: "我先运行测试。" },
  { kind: "tool", id: "t1", at: "2026-10-02T06:00:02.000Z", name: "Bash", summary: "npm test" },
  { kind: "tool_result", id: "t1", at: "2026-10-02T06:00:10.000Z", isError: false },
  { kind: "text", key: "a2:0", at: "2026-10-02T06:00:11.000Z", text: "测试全部通过。" },
  { kind: "turn_end", at: "2026-10-02T06:00:11.000Z", durationMs: null },
  { kind: "turn_end", at: "2026-10-02T06:00:12.000Z", durationMs: 12_000 },
];

test("one prompt and everything until the next prompt form one turn", () => {
  const result = reduceTranscript("s1", null, [...turnEvents, prompt("p2", "2026-10-02T06:05:00.000Z", "再提交一下")]);
  assert.deepEqual(result.touched.map((turn) => turn.turnId), ["p1", "p2"]);
  const first = result.touched[0]!;
  assert.equal(first.status, "done");
  assert.equal(first.durationMs, 12_000);
  assert.deepEqual(first.blocks.map((block) => [block.kind, block.text, block.status ?? null]),
    [["text", "我先运行测试。", null], ["tool", "npm test", "ok"], ["text", "测试全部通过。", null]]);
  assert.equal(result.current?.turnId, "p2");
  assert.equal(result.current?.status, "running");
  assert.equal(result.firstHumanPrompt, "运行测试");
  assert.deepEqual(result.meta, { cwd: "/w", entrypoint: "claude-vscode" });
  assert.equal(result.firstAt, "2026-10-02T06:00:00.000Z");
});

test("applying events in pieces equals applying them at once, and replays change nothing", () => {
  const whole = reduceTranscript("s1", null, turnEvents).current;
  const head = reduceTranscript("s1", null, turnEvents.slice(0, 4)).current;
  assert.equal(head?.status, "running");
  const pieced = reduceTranscript("s1", head, turnEvents.slice(4)).current;
  assert.deepEqual(pieced, whole);
  assert.deepEqual(reduceTranscript("s1", whole, turnEvents.slice(2)).current?.blocks, whole?.blocks);
  // The input turn is never mutated.
  assert.equal(head?.status, "running");
});

test("new text after the end reopens the turn; interruption fails running tools", () => {
  const done = reduceTranscript("s1", null, turnEvents).current!;
  const continued = reduceTranscript("s1", done, [{ kind: "text", key: "a3:0", at: "2026-10-02T06:01:00.000Z", text: "补充说明" }]).current!;
  assert.equal(continued.status, "running");
  assert.equal(continued.durationMs, null);
  const interrupted = reduceTranscript("s1", null, [prompt("p1", "2026-10-02T06:00:00.000Z"),
    { kind: "tool", id: "t9", at: "2026-10-02T06:00:01.000Z", name: "Bash", summary: "sleep 100" },
    { kind: "interrupted", at: "2026-10-02T06:00:30.000Z" },
    { kind: "turn_end", at: "2026-10-02T06:00:31.000Z", durationMs: null }]).current!;
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.blocks[0]?.status, "error");
  assert.equal(interrupted.durationMs, 30_000);
});

test("local commands end without a reply and a new prompt closes a still-running turn", () => {
  const command = reduceTranscript("s1", null, [prompt("c1", "2026-10-02T06:00:00.000Z", "/clear", "command"), { kind: "command_done", at: "2026-10-02T06:00:01.000Z" }]).current!;
  assert.equal(command.status, "done");
  const result = reduceTranscript("s1", null, [prompt("p1", "2026-10-02T06:00:00.000Z"), prompt("p2", "2026-10-02T06:00:05.000Z")]);
  assert.equal(result.touched[0]?.status, "done");
  assert.equal(result.touched[0]?.endedAt, "2026-10-02T06:00:05.000Z");
  // command_done never ends a human turn.
  assert.equal(reduceTranscript("s1", null, [prompt("p3", "t"), { kind: "command_done", at: "t2" }]).current?.status, "running");
});

test("records before any prompt get an orphan turn, and tool lists are capped", () => {
  const orphan = reduceTranscript("s1", null, [{ kind: "text", key: "a:0", at: "2026-10-02T06:00:00.000Z", text: "续上文" }]).current!;
  assert.equal(orphan.turnId, "s1:orphan:2026-10-02T06:00:00.000Z");
  assert.equal(orphan.prompt, "");
  const tools: TranscriptEvent[] = Array.from({ length: 205 }, (_, index) => ({ kind: "tool", id: `t${index}`, at: "t", name: "Read", summary: `f${index}` }));
  const capped = reduceTranscript("s1", null, [prompt("p1", "t"), ...tools]).current!;
  assert.equal(capped.blocks.length, 200);
  assert.equal(capped.omittedTools, 5);
});
