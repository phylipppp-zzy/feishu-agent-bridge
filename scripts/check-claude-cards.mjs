#!/usr/bin/env node
// Asks Feishu to check every Claude bridge card without posting anything to a chat: each card is
// created as a CardKit card entity, which runs the same content checks as sending it (for example
// the 1000-character input limit) but is never shown to anyone.
// Feishu's CardKit accepts some properties a message would reject (such as an unknown property on a
// column set), so a card that passes here should still be looked at once in Feishu after layout changes.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { configureCardUi } from "../dist/src/card-kit.js";
import { parseEnvironment } from "../dist/src/installer.js";
import { installSafeLogging } from "../dist/src/safe-log.js";
import * as c from "../dist/src/claude/cards.js";

const env = parseEnvironment(await readFile(join(homedir(), ".config", "feishu-claude-bridge", "env"), "utf8"));
installSafeLogging([env.FEISHU_APP_SECRET, env.FEISHU_BIND_TOKEN].filter(Boolean));
configureCardUi(2);
const client = new Lark.Client({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu, loggerLevel: Lark.LoggerLevel.fatal });

const home = homedir();
const session = {
  sessionId: "00000000-0000-4000-8000-000000000000", path: "/dev/null", cwd: join(home, "project"), customTitle: "卡片检查", aiTitle: null, firstPrompt: null,
  entrypoint: "claude-vscode", model: "claude-opus-5-5", permissionMode: "auto", gitBranch: null, startedAtMs: 0, lastActivityMs: Date.now(), rootMessageId: null,
  rootAppLink: null, chatId: null, currentTurnId: null, presenceState: "running", presenceAtMs: 0, presencePid: null, presencePidStart: null, presenceMessage: null,
  waitingNotifiedAtMs: 0, rootDirty: false, rootOutOfScope: false, prefMode: null, prefModel: null, prefEffort: null, forkedFrom: null, readonlyNoticeAtMs: 0,
};
const interaction = (fields) => ({ nonce: "n", sessionId: session.sessionId, kind: "permission", toolName: "Bash", input: { command: "ls -la", description: "列目录" },
  suggestions: [], allowAlways: true, title: "Claude wants to run ls", reason: "需要确认", questions: [], answers: [], cardMessageId: null, resolve() {}, ...fields });
const questions = [
  { question: "用哪个方案？", header: "方案", multiSelect: false, options: [{ label: "甲", description: "简单" }, { label: "乙", description: "灵活" }] },
  { question: "测哪些？", header: "测试", multiSelect: true, options: [{ label: "单元", description: "" }, { label: "集成", description: "" }] },
];
const models = ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5", "Sonnet 5", "Opus 5"].map((label) => ({ value: label.toLowerCase().replace(/\W+/g, "-"), label }));
const dirs = [join(home, "project"), join(home, "a-rather-long-directory-name/with/several/levels")];
const turn = { turnId: "t", origin: "human", entrypoint: "feishu", prompt: "p", attachments: [], startedAt: "", updatedAt: "", endedAt: null, durationMs: null,
  status: "running", omittedTools: 0, blocks: [{ key: "a", kind: "text", text: "回复 ▍" }, { key: "n", kind: "note", text: "补充：看日志" },
    { key: "tool:1", kind: "tool", name: "Bash", text: "npm test", status: "running" }] };

const cards = {
  root: c.claudeRootCard(session, { live: "running", feishuMode: "auto", feishuModel: "opus", feishuEffort: "high", forkedFrom: { title: "原会话", link: "https://applink.feishu.cn/x" } }),
  rootOutOfScope: c.claudeRootCard(session, { outOfScope: "~/project" }),
  turn: c.claudeTurnCard(turn),
  turnSimple: c.claudeTurnCard({ ...turn, status: "done", durationMs: 1_000 }, { simpleTools: true }),
  permission: c.claudePermissionCard(interaction({})),
  permissionEdit: c.claudePermissionCard(interaction({ toolName: "Edit", input: { file_path: "/a.ts", old_string: "a", new_string: "b" } })),
  question: c.claudeQuestionCard(interaction({ kind: "question", questions }), 0),
  questionMulti: c.claudeQuestionCard(interaction({ kind: "question", questions }), 1),
  plan: c.claudePlanCard(interaction({ kind: "plan", input: { plan: "## 计划\n1. 改代码\n2. 测试" } })),
  requestDone: c.claudeInteractionDoneCard(interaction({}), "已允许", "green", "ls -la"),
  localBusy: c.claudeLocalBusyCard({ ...session, presenceState: "waiting" }, "n", 2),
  mode: c.claudeModeCard(session, "auto", ["default", "acceptEdits", "plan", "auto"]),
  model: c.claudeModelCard(session, models, ["low", "medium", "high", "xhigh", "max"], { model: models[0].value, effort: "high" }),
  newSession: c.claudeNewSessionCard(dirs, "~/project"),
  newSessionDraft: c.claudeNewSessionCard(dirs, "~/project", { nonce: "d", preview: "整理 README" }, "目录不存在"),
  newTask: c.claudeNewTaskCard(dirs[0], "请填写要 Claude 做什么"),
  started: c.claudeStartedCard(dirs[0], "https://applink.feishu.cn/x"),
  home: c.claudeHomeCard({ paused: false, indexed: 3, topics: 2, open: 1, failures: 0, scope: "~/project", outOfScopeTopics: 1 }, "提示"),
  help: c.claudeHelpCard(),
  menu: c.claudeCommandMenuCard("未知命令"),
  recent: c.claudeRecentCard([session], "检查", 1, true),
  cleanup: c.claudeCleanupCard([session], "n", "~/project"),
  cleanupResult: c.claudeCleanupResultCard({ topics: 1, withdrawn: 2, kept: [{ title: "x", reason: "超时" }] }),
  notice: c.claudeNoticeCard("已新建会话", "目录：~/project"),
};

let failed = 0;
for (const [name, card] of Object.entries(cards)) {
  let result;
  try { result = await client.cardkit.v1.card.create({ data: { type: "card_json", data: JSON.stringify(card) } }); }
  catch (error) { result = error?.response?.data ?? { code: -1, msg: String(error) }; }
  if (result?.code === 0) console.log(`OK    ${name}`);
  else { failed += 1; console.log(`FAIL  ${name}: ${result?.code} ${String(result?.msg ?? "").slice(0, 300)}`); }
}
console.log(failed ? `\n${failed} 张卡片未通过飞书校验。` : `\n全部 ${Object.keys(cards).length} 张卡片通过飞书校验（没有向任何群发送消息）。`);
process.exitCode = failed ? 1 : 0;
