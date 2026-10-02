import assert from "node:assert/strict";
import test from "node:test";
import { archivedSessionActionCard, choiceCard, configureCardUi, helpCard, homeCard, modelCard, projectsCard, reasoningEffortCard, recentSessionsCard, remoteQuestionCard, remoteRequestCard, rootGrantCard, sessionCard, wizardReadyCard } from "../src/cards.js";
import type { ModelCapability } from "../src/types.js";

function actions(card: Record<string, unknown>): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    const direct = item.value as Record<string, unknown> | undefined;
    if (item.tag === "button" && typeof direct?.action === "string") found.push(direct.action);
    for (const behavior of (item.behaviors as Array<Record<string, unknown>> | undefined) ?? []) {
      const behaviorValue = behavior.value as Record<string, unknown> | undefined;
      if (behavior.type === "callback" && typeof behaviorValue?.action === "string") found.push(behaviorValue.action);
    }
    Object.values(item).forEach(visit);
  };
  visit(card);
  return found;
}

test("home and help cards expose discoverable button actions", () => {
  const home = homeCard({ paused: false, sessions: 3, active: 0, failures: 0 });
  assert.deepEqual(actions(home), ["new", "recent", "projects", "service"]);
  assert.equal((home.config as Record<string, unknown>).update_multi, true);
  assert.deepEqual(actions(helpCard()), ["home", "new"]);
});

test("session model controls are primary and explicitly scoped to the topic", () => {
  const model: ModelCapability = { slug: "gpt-test", displayName: "Test", description: "test", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium"] };
  const root = JSON.stringify(sessionCard({ cwd: "/home/tester/project", firstUserText: "test", sessionId: "session-1" }));
  assert.match(root, /"action":"session_model"/);
  assert.match(root, /"type":"primary"/);
  assert.equal((modelCard([model], "wizard-1", undefined, "/home/tester/project", "session").header as { title: { content: string } }).title.content, "设置会话模型");
  assert.equal((reasoningEffortCard(model, "wizard-1", "/home/tester/project", "session").header as { title: { content: string } }).title.content, "设置思考强度");
  assert.match(JSON.stringify(helpCard()), /无需 @ 机器人/);
});

test("JSON 2.0 cards use body elements and real form submit controls", () => {
  const model: ModelCapability = { slug: "gpt-test", displayName: "Test", description: "test", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium"] };
  configureCardUi(2);
  try {
    const home = homeCard({ paused: false, sessions: 1, active: 0, failures: 0 });
    assert.equal(home.schema, "2.0");
    assert.equal("elements" in home, false);
    assert.ok((home.body as { elements: unknown[] }).elements.length > 0);
    assert.doesNotMatch(JSON.stringify(home), /"tag":"action"/);
    assert.doesNotMatch(JSON.stringify(home), /"tag":"note"/);
    const task = wizardReadyCard("/home/tester/project", model, "medium", "wizard-1");
    const serialized = JSON.stringify(task);
    assert.match(serialized, /"tag":"form"/);
    assert.match(serialized, /"name":"task_prompt"/);
    assert.match(serialized, /"required":true/);
    assert.match(serialized, /"form_action_type":"submit"/);
    assert.match(serialized, /"type":"callback"/);
    assert.match(serialized, /"element_id":"btn_\d+"/);
    assert.deepEqual(actions(task), ["submit_task", "await_chat_task", "show_models", "cancel_wizard", "home"]);
    const projects = JSON.stringify(projectsCard([], "/home/tester", "wizard-1"));
    assert.match(projects, /"name":"project_path"/);
    assert.match(projects, /"action":"submit_project_path"/);
    assert.match(projects, /"action":"search_projects"/);
    // Full project paths are listed as text; buttons carry a number and a short name, which phones do not cut off.
    const listed = JSON.stringify(projectsCard([{ cwd: "/home/tester/a-very-long-project-directory/code/main", count: 3 }], "/home/tester", "wizard-1"));
    assert.match(listed, /1\. \/home\/tester\/a\\\\-very\\\\-long\\\\-project\\\\-directory\/code\/main（3 个会话）/);
    assert.match(listed, /"content":"1 · main"/);
    const search = JSON.stringify(recentSessionsCard([]));
    assert.match(search, /"name":"session_search"/);
    assert.match(search, /"action":"search_sessions"/);
    assert.doesNotMatch(`${projects}${search}`, /"tag":"action"|"tag":"note"/);
  } finally { configureCardUi(1); }
});

test("recent session card contains a clickable topic link", () => {
  const card = recentSessionsCard([{
    sessionId: "session-1", path: "/tmp/session.jsonl", cwd: "/home/tester/example-project",
    startedAt: "2026-08-03T00:00:00Z", source: "cli", firstUserText: "Read the paper",
    rootMessageId: "root-1", rootAppLink: "https://example.test/topic", chatId: "chat-1", threadId: "thread-1", sessionCardMessageId: null,
  }]);
  assert.match(JSON.stringify(card), /\[Read the paper\]\(https:\/\/example\.test\/topic\)/);
});

test("choice card exposes real action buttons with text fallback", () => {
  const card = choiceCard({
    id: "request-1", sessionId: "session-1", timestamp: "2026-08-03T00:00:00Z", expiresAt: Date.now() + 1000,
    questions: [{ id: "q1", header: "方案", question: "选择方案", options: [
      { label: "A", description: "first" }, { label: "B", description: "second" },
    ] }],
  }, 0);
  assert.deepEqual(actions(card), ["choice_answer", "choice_answer", "choice_cancel"]);
  assert.match(JSON.stringify(card), /本话题回复 1/);
});

test("large choices use a dropdown in Card 2.0", () => {
  configureCardUi(2);
  try {
    const card = choiceCard({
      id: "request-many", sessionId: "session-1", timestamp: "2026-08-03T00:00:00Z", expiresAt: Date.now() + 1000,
      questions: [{ id: "q1", header: "方案", question: "选择方案", options: ["A", "B", "C", "D"].map((label) => ({ label, description: "" })) }],
    }, 0);
    const json = JSON.stringify(card);
    assert.match(json, /"tag":"select_static"/);
    assert.match(json, /"action":"choice_answer"/);
  } finally { configureCardUi(1); }
});

test("native question cards list the options and offer no fake approval", () => {
  const questions = [
    { id: "scope", header: "范围", question: "处理哪些内容？", options: [{ label: "完整", description: "全部" }, { label: "精简", description: "重点" }] },
    { id: "note", header: "备注", question: "还有什么要求？", options: [] },
  ];
  const first = remoteQuestionCard("opaque-nonce", questions, 0);
  assert.deepEqual(actions(first), ["remote_answer", "remote_answer", "remote_approve"]);
  const json = JSON.stringify(first);
  assert.match(json, /opaque-nonce/);
  assert.match(json, /"decision":"decline"/);
  assert.doesNotMatch(json, /"decision":"accept"|批准一次/);
  assert.match(json, /精简/);
  assert.equal((first.header as { title: { content: string } }).title.content, "Codex 等待你的回答 1/2");
  assert.deepEqual(actions(remoteQuestionCard("opaque-nonce", questions, 1)), ["remote_approve"]);
});

test("choice cards from the local log say where to answer", () => {
  const card = choiceCard({
    id: "request-1", sessionId: "session-1", timestamp: "2026-08-03T00:00:00Z", expiresAt: Date.now() + 1000,
    questions: [{ id: "q1", header: "方案", question: "选择方案", options: [{ label: "A", description: "" }] }],
  }, 0);
  assert.match(JSON.stringify(card), /终端还在等待时，请直接在终端回答/);
});

test("remote root and approval cards keep only opaque callback state", () => {
  const root = JSON.stringify(rootGrantCard("opaque-root-nonce", "/work", "修复部署脚本", Date.now() + 60_000));
  assert.match(root, /root_grant_confirm/);
  assert.match(root, /opaque-root-nonce/);
  assert.doesNotMatch(root, /sessionId/);
  const approval = JSON.stringify(remoteRequestCard({ nonce: "opaque-nonce", type: "command_approval", title: "批准", detail: "command", decisions: ["accept", "decline"] }));
  assert.match(approval, /opaque-nonce/);
  assert.match(approval, /remote_approve/);
  assert.doesNotMatch(approval, /acceptForSession/);
});


test("archived session cards require an opaque explicit decision", () => {
  const card = archivedSessionActionCard("opaque-nonce", "Archived topic");
  assert.deepEqual(actions(card), ["unarchive_confirm", "unarchive_cancel"]);
  const serialized = JSON.stringify(card);
  assert.match(serialized, /opaque-nonce/);
  assert.doesNotMatch(serialized, /threadId|sessionId|prompt/);
  assert.deepEqual(actions(sessionCard({ cwd: "/work", firstUserText: "x", sessionId: "s1", lifecycle: "abandoned" })), ["turn_review"]);
  assert.match(JSON.stringify(sessionCard({ cwd: "/work", firstUserText: "x", sessionId: "s1", lifecycle: "abandoned" })), /创建失败，未执行/);
});
