import assert from "node:assert/strict";
import test from "node:test";
import { askedQuestions, InteractionRegistry, planResult, questionResult, typedAnswer } from "../src/claude/interactions.js";
import { imageMediaType, SessionRunner, type RunnerHandlers, type RunnerOptions } from "../src/claude/runner.js";
import { fakeQueries } from "./claude-fake-query.js";

function recorder() {
  const log: string[] = [];
  const handlers: RunnerHandlers = {
    onPrompt: (uuid) => log.push(`prompt:${uuid}`),
    onLiveText: (text, uuid) => log.push(`live:${uuid}:${text}`),
    onTurnEnd: (result) => log.push(`end:${result.interrupted}:${result.error ?? ""}`),
    canUseTool: async () => ({ behavior: "deny", message: "no" }),
    onClosed: (error) => log.push(`closed:${error instanceof Error ? error.message : ""}`),
  };
  return { log, handlers };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const options = (overrides: Partial<RunnerOptions> = {}): RunnerOptions => ({
  sessionId: "11111111-0000-4000-8000-000000000001", mode: "resume", cwd: "/srv/project", claudeBin: "/usr/local/bin/claude",
  permissionMode: "default", model: null, effort: null, ...overrides,
});

test("image types are read from the data, not from the file name", () => {
  assert.equal(imageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(imageMediaType(Buffer.from("GIF89a....", "latin1")), "image/gif");
  assert.equal(imageMediaType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")), "image/webp");
  assert.equal(imageMediaType(Buffer.from("%PDF-1.7")), null);
});

test("the runner starts Claude Code with the person's settings and the session to resume, fork or create", () => {
  const { factory, queries } = fakeQueries();
  const { handlers } = recorder();
  new SessionRunner(options({ model: "sonnet", effort: "high" }), handlers, factory).start();
  new SessionRunner(options({ mode: "fork", forkFrom: "22222222-0000-4000-8000-000000000002" }), handlers, factory).start();
  new SessionRunner(options({ mode: "new", permissionMode: "plan" }), handlers, factory).start();
  const [resumed, forked, created] = queries.map((query) => query.options);
  assert.equal(resumed?.resume, "11111111-0000-4000-8000-000000000001");
  assert.equal(resumed?.sessionId, undefined);
  assert.deepEqual([resumed?.model, resumed?.effort], ["sonnet", "high"]);
  assert.deepEqual(resumed?.settingSources, ["user", "project", "local"]);
  assert.deepEqual(resumed?.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.deepEqual(resumed?.extraArgs, { "replay-user-messages": null });
  assert.equal(resumed?.pathToClaudeCodeExecutable, "/usr/local/bin/claude");
  assert.equal((resumed?.env as Record<string, string>).FEISHU_CLAUDE_BRIDGE, "1");
  assert.deepEqual([forked?.resume, forked?.forkSession, forked?.sessionId], ["22222222-0000-4000-8000-000000000002", true, "11111111-0000-4000-8000-000000000001"]);
  assert.deepEqual([created?.resume, created?.sessionId, created?.permissionMode], [undefined, "11111111-0000-4000-8000-000000000001", "plan"]);
});

test("the runner tracks turns by their results and reports the prompt Claude is answering", async () => {
  const { factory, queries } = fakeQueries();
  const { log, handlers } = recorder();
  const runner = new SessionRunner(options(), handlers, factory);
  runner.start();
  const query = queries[0]!;
  assert.equal(runner.busy, false);
  const first = runner.send("看图", [{ mediaType: "image/png", base64: "AAAA" }], "next", "u-1");
  const second = runner.send("然后提交", [], "later", "u-2");
  assert.equal(runner.busy, true);
  const [image, queued] = [await query.nextMessage(1), await query.nextMessage(2)];
  assert.deepEqual(image.message.content, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "看图" }]);
  assert.deepEqual([image.uuid, image.priority, image.origin], [first, "next", { kind: "human" }]);
  assert.deepEqual([queued.message.content, queued.priority], ["然后提交", "later"]);

  query.replay(image);
  query.stream("好的");
  query.result([first], { subtype: "success", is_error: true, result: "API Error: overloaded" });
  query.replay(queued);
  await until(() => log.includes("prompt:u-2"));
  assert.equal(runner.busy, true);
  await runner.interrupt();
  query.result([second], { subtype: "error_during_execution", errors: ["aborted"] });
  runner.close();
  await runner.closed(1_000);
  assert.deepEqual(log, ["prompt:u-1", "live:u-1:好的", "live:u-1:", "end:false:API Error: overloaded", "prompt:u-2", "end:true:", "closed:"]);
  assert.equal(runner.busy, false);
  assert.deepEqual(query.calls, ["interrupt"]);
});

test("a failing process is reported once its output ends", async () => {
  const { factory, queries } = fakeQueries();
  const { log, handlers } = recorder();
  const runner = new SessionRunner(options(), handlers, factory);
  runner.start();
  queries[0]!.crash(new Error("spawn claude ENOENT"));
  await runner.closed(1_000);
  assert.deepEqual(log, ["closed:spawn claude ENOENT"]);
});

test("questions are read from AskUserQuestion input and answered by number or in words", () => {
  const questions = askedQuestions({ questions: [
    { question: "用哪个方案？", header: "方案", options: [{ label: "甲", description: "简单" }, { label: "乙" }, { description: "无标签" }] },
    { question: "要哪些测试？", header: "测试", multiSelect: true, options: [{ label: "单元" }, { label: "集成" }] },
    { header: "缺少问题" },
  ] });
  assert.deepEqual(questions.map((question) => [question.question, question.multiSelect, question.options.map((option) => option.label)]),
    [["用哪个方案？", false, ["甲", "乙"]], ["要哪些测试？", true, ["单元", "集成"]]]);
  assert.equal(typedAnswer(questions[0]!, "2"), "乙");
  assert.equal(typedAnswer(questions[0]!, "1,2"), "1,2");
  assert.equal(typedAnswer(questions[0]!, "3"), "3");
  assert.equal(typedAnswer(questions[1]!, "1，2"), "单元, 集成");
  assert.equal(typedAnswer(questions[1]!, " 都不要 "), "都不要");
});

test("requests settle once, answers are keyed by question, and plans switch the session's mode", async () => {
  const registry = new InteractionRegistry();
  const results: unknown[] = [];
  const base = { toolName: "AskUserQuestion", input: { questions: [] }, suggestions: [], allowAlways: false, title: null, reason: null, resolve: (result: unknown) => results.push(result) };
  const question = registry.add({ ...base, sessionId: "s1", kind: "question", questions: [{ question: "颜色？", header: "", options: [], multiSelect: false }] });
  const plan = registry.add({ ...base, sessionId: "s1", kind: "plan", toolName: "ExitPlanMode", input: { plan: "做" }, questions: [] });
  const other = registry.add({ ...base, sessionId: "s2", kind: "permission", toolName: "Bash", input: { command: "ls" }, questions: [] });
  assert.equal(registry.forSession("s1")?.nonce, question.nonce);
  question.answers[0] = "蓝";
  assert.deepEqual(questionResult(question), { behavior: "allow", updatedInput: { questions: [], answers: { "颜色？": "蓝" } } });
  assert.deepEqual(planResult(plan, "acceptEdits"), { behavior: "allow", updatedInput: { plan: "做" }, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
  registry.settle(question.nonce, questionResult(question));
  assert.equal(registry.settle(question.nonce, { behavior: "deny", message: "late" }), null);
  assert.deepEqual(registry.cancelSession("s1", "结束").map((item) => item.nonce), [plan.nonce]);
  assert.deepEqual(registry.sessions(), ["s2"]);
  assert.equal(registry.has("s1"), false);
  assert.equal(registry.get(other.nonce)?.kind, "permission");
  assert.deepEqual(results, [{ behavior: "allow", updatedInput: { questions: [], answers: { "颜色？": "蓝" } } }, { behavior: "deny", message: "结束" }]);
});
