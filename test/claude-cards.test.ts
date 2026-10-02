import assert from "node:assert/strict";
import test from "node:test";
import { configureCardUi } from "../src/card-kit.js";
import { CARD_TEXT_LIMIT, claudeRootCard, claudeTurnCard, formatDuration, presenceLabel, promptLine, transcriptMarkdown } from "../src/claude/cards.js";
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
