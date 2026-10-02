import assert from "node:assert/strict";
import test from "node:test";
import { configureCardUi } from "../src/card-kit.js";
import { CARD_TEXT_LIMIT, claudeInteractionDoneCard, claudeLocalBusyCard, claudeModeCard, claudeNewSessionCard, claudePermissionCard, claudePlanCard,
  claudeQuestionCard, claudeRootCard, claudeTurnCard, formatDuration, presenceLabel, promptLine, transcriptMarkdown } from "../src/claude/cards.js";
import type { Interaction } from "../src/claude/interactions.js";
import type { TurnView } from "../src/claude/conversation.js";
import type { ClaudeSession } from "../src/claude/db.js";

configureCardUi(2);

const turn = (overrides: Partial<TurnView> = {}): TurnView => ({
  turnId: "p1", origin: "human", entrypoint: "claude-vscode", prompt: "修复登录页", attachments: [], startedAt: "2026-10-02T06:00:00.000Z",
  updatedAt: "2026-10-02T06:01:00.000Z", endedAt: null, durationMs: null, status: "running", omittedTools: 0,
  blocks: [{ key: "a:0", kind: "text", text: "我先看看样式文件。" }, { key: "tool:t1", kind: "tool", name: "Read", text: "src/login.css", status: "ok" },
    { key: "tool:t2", kind: "tool", name: "mcp__projtool__remote_exec", text: "nvidia-smi", status: "error" },
    { key: "tool:t3", kind: "tool", name: "Bash", text: "npm test", status: "running" }],
  ...overrides,
});

const session: ClaudeSession = {
  sessionId: "aaaaaaaa-0000-4000-8000-000000000001", path: "/x.jsonl", cwd: "/srv/project", customTitle: null, aiTitle: "Fix login page", firstPrompt: "修复登录页",
  entrypoint: "claude-vscode", model: "claude-opus-5-5", permissionMode: "auto", gitBranch: "main", startedAtMs: 0, lastActivityMs: Date.parse("2026-10-02T06:01:00Z"),
  rootMessageId: null, rootAppLink: null, chatId: null, currentTurnId: null, presenceState: "waiting", presenceAtMs: 0, presencePid: null, presencePidStart: null,
  presenceMessage: "Claude needs your permission to use Bash", waitingNotifiedAtMs: 0, rootDirty: false, rootOutOfScope: false, readonlyNoticeAtMs: 0,
  prefMode: null, prefModel: null, prefEffort: null, forkedFrom: null,
};

test("turn cards show progress, the folded tool log and the final duration", () => {
  const running = JSON.stringify(claudeTurnCard(turn()));
  assert.match(running, /Claude · 进行中/);
  assert.match(running, /正在执行：Bash · npm test/);
  assert.match(running, /"tag":"collapsible_panel"/);
  assert.match(running, /执行记录（3 项，失败 1 项）/);
  assert.match(running, /projtool\/remote\\\\_exec/);
  const done = claudeTurnCard(turn({ status: "done", durationMs: 83_000, blocks: turn().blocks.map((block) => block.kind === "tool" ? { ...block, status: "ok" as const } : block) }));
  assert.equal((done.header as { title: { content: string } }).title.content, "Claude · 已完成 · 用时 1分23秒");
  assert.doesNotMatch(JSON.stringify(done), /正在执行/);
  const simple = JSON.stringify(claudeTurnCard(turn(), { simpleTools: true }));
  assert.doesNotMatch(simple, /collapsible_panel/);
  assert.match(simple, /✓ Read · src\/login\\\\.css/);
  assert.equal((claudeTurnCard(turn(), { stale: true }).header as { title: { content: string } }).title.content, "Claude · 未完成");
});

test("over-long text keeps its end, and prompt lines name where the turn came from", () => {
  const long = JSON.stringify(claudeTurnCard(turn({ blocks: [{ key: "a:0", kind: "text", text: `开头${"中".repeat(CARD_TEXT_LIMIT + 10)}结尾` }] })));
  assert.match(long, /前文过长，已省略/);
  assert.match(long, /结尾/);
  assert.doesNotMatch(long, /开头/);
  assert.equal(promptLine(turn()), "VS Code：修复登录页");
  assert.equal(promptLine(turn({ entrypoint: "cli", attachments: ["图片"] })), "终端：修复登录页（附件：图片）");
  assert.equal(promptLine(turn({ origin: "command", entrypoint: "cli", prompt: "/model opus" })), "终端 执行命令：/model opus");
  assert.match(promptLine(turn({ origin: "peer", prompt: "调研完成" })) ?? "", /^【子 agent 回报】调研完成/);
  assert.equal(promptLine(turn({ origin: "system", prompt: "" })), null);
  assert.equal(formatDuration(3_725_000), "1小时2分");
});

test("the root card shows where the session is open and how to continue it", () => {
  const root = JSON.stringify(claudeRootCard(session));
  assert.match(root, /Fix login page/);
  assert.match(root, /VS Code 中等待你处理/);
  assert.match(root, /claude --resume aaaaaaaa-0000-4000-8000-000000000001/);
  assert.match(root, /"action":"export_session"/);
  assert.equal(presenceLabel({ presenceState: null, entrypoint: "cli" }), "未知（尚未收到 hook 状态）");
  const exported = transcriptMarkdown(session, [turn({ status: "done", durationMs: 1_000 })]);
  assert.match(exported, /^# Fix login page/);
  assert.match(exported, /## 1\. VS Code 提问/);
  assert.match(exported, /<details><summary>执行记录（3 项）<\/summary>/);
});

const interaction = (overrides: Partial<Interaction> = {}): Interaction => ({
  nonce: "n-1", sessionId: session.sessionId, kind: "permission", toolName: "Bash", input: { command: "npm test", description: "运行测试" }, suggestions: [],
  allowAlways: true, title: "Claude wants to run npm test", reason: null, questions: [], answers: [], cardMessageId: null, resolve: () => undefined, ...overrides,
});

test("the root card offers Feishu controls while the bridge runs the session, and marks forks", () => {
  const running = JSON.stringify(claudeRootCard(session, { live: "running", feishuMode: "acceptEdits", feishuModel: "sonnet", feishuEffort: "high" }));
  assert.match(running, /飞书中运行中/);
  assert.match(running, /飞书续聊：自动接受编辑　sonnet · high/);
  assert.match(running, /"action":"stop_turn"/);
  // Button rows wrap on phones instead of shrinking the labels to "…".
  assert.match(running, /"tag":"column_set","flex_mode":"flow"/);
  assert.doesNotMatch(JSON.stringify(claudeRootCard(session, { live: "idle" })), /"action":"stop_turn"/);
  const fork = claudeRootCard(session, { forkedFrom: { title: "原会话", link: "https://example.test/root" } });
  assert.equal((fork.header as { title: { content: string } }).title.content, "Fix login page（分叉）");
  assert.match(JSON.stringify(fork), /分叉自：\[原会话\]\(https:\/\/example\.test\/root\)/);
  assert.equal(presenceLabel({ presenceState: null, entrypoint: "feishu" }), "未在运行");
});

test("request cards show what Claude wants and every way to answer", () => {
  const permission = JSON.stringify(claudePermissionCard(interaction()));
  assert.match(permission, /Claude 请求使用 Bash/);
  assert.match(permission, /npm test/);
  assert.match(permission, /"action":"perm_always"/);
  assert.doesNotMatch(JSON.stringify(claudePermissionCard(interaction({ allowAlways: false }))), /perm_always/);
  const questions = [{ question: "用哪个？", header: "方案", multiSelect: false, options: [{ label: "甲", description: "简单" }, { label: "乙", description: "" }] },
    { question: "测哪些？", header: "测试", multiSelect: true, options: [{ label: "单元", description: "" }] }];
  const first = JSON.stringify(claudeQuestionCard(interaction({ kind: "question", toolName: "AskUserQuestion", questions }), 0));
  assert.match(first, /Claude 提问 1\/2 · 方案/);
  assert.match(first, /"action":"ask_answer"/);
  const second = JSON.stringify(claudeQuestionCard(interaction({ kind: "question", toolName: "AskUserQuestion", questions }), 1));
  assert.doesNotMatch(second, /ask_answer/);
  assert.match(second, /用逗号分隔/);
  const plan = JSON.stringify(claudePlanCard(interaction({ kind: "plan", toolName: "ExitPlanMode", input: { plan: "## 步骤\n1. 改代码" } })));
  assert.match(plan, /1\. 改代码/);
  assert.match(plan, /"action":"plan_edits"/);
  assert.equal((claudeInteractionDoneCard(interaction(), "已允许", "green", "npm test").header as { title: { content: string } }).title.content, "使用 Bash · 已允许");
  const conflict = JSON.stringify(claudeLocalBusyCard(session, "n-2", 2));
  assert.match(conflict, /VS Code 中等待你处理/);
  assert.match(conflict, /你的 2 条消息会在电脑上这一轮结束后自动发送/);
  assert.match(conflict, /"action":"conflict_fork"/);
  const modes = JSON.stringify(claudeModeCard(session, "default", ["default", "acceptEdits", "plan", "auto"]));
  assert.doesNotMatch(modes, /bypassPermissions/);
  const picker = JSON.stringify(claudeNewSessionCard(["/srv/project"], "全部目录", { nonce: "d-1", preview: "整理 README" }));
  assert.match(picker, /任务：整理 README/);
  assert.match(picker, /"draft":"d-1"/);
});
