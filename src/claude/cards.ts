import { homedir } from "node:os";
import { basename } from "node:path";
import { actionRow, button, card, inputForm, markdown, nextElementId, note, safeMarkdown, shorten } from "../card-kit.js";
import type { CardDefinition } from "../types.js";
import type { TurnBlock, TurnView } from "./conversation.js";
import type { ClaudeSession } from "./db.js";
import { formatBytes, type DeliverySelection, type DirectoryListing } from "./deliver.js";
import type { Interaction } from "./interactions.js";

/** Longest assistant text kept in a card; Feishu rejects card content above roughly 30 KB. */
export const CARD_TEXT_LIMIT = 18_000;
const PROMPT_LIMIT = 2_000;
const TOOL_LINES = 40;

export function sourceLabel(entrypoint: string | null): string {
  if (entrypoint === "claude-vscode") return "VS Code";
  if (entrypoint === "cli") return "终端";
  if (entrypoint === "feishu") return "飞书";
  if (entrypoint?.startsWith("sdk")) return "SDK";
  return "本机";
}

export function sessionTitle(session: Pick<ClaudeSession, "customTitle" | "aiTitle" | "firstPrompt">): string {
  return shorten(session.customTitle ?? session.aiTitle ?? session.firstPrompt ?? "", 60) || "Claude 会话";
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60 ? `${seconds % 60}秒` : ""}`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分` : ""}`;
}

export function formatTime(ms: number): string {
  if (!ms) return "未知";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function displayPath(path: string | null): string {
  if (!path) return "未知";
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** The directories whose sessions are mirrored (SYNC_DIRS), for status cards. */
export function scopeLabel(syncDirs: readonly string[]): string {
  return syncDirs.length ? syncDirs.map(displayPath).join("、") : "全部目录";
}

/** Where the session is open right now, as reported by the Claude Code hooks. */
export function presenceLabel(session: Pick<ClaudeSession, "presenceState" | "entrypoint">): string {
  const where = sourceLabel(session.entrypoint);
  switch (session.presenceState) {
    case "running": return `${where} 中运行中`;
    case "waiting": return `${where} 中等待你处理`;
    case "idle": return `${where} 中已打开（空闲）`;
    case "closed": return "未在本机打开";
    // Sessions run from Feishu never report hook states; when the bridge is not running them, nothing is.
    default: return session.entrypoint === "feishu" ? "未在运行" : "未知（尚未收到 hook 状态）";
  }
}

function presenceTemplate(session: Pick<ClaudeSession, "presenceState">): string {
  return session.presenceState === "running" ? "orange" : session.presenceState === "waiting" ? "red" : session.presenceState === "idle" ? "blue" : "grey";
}

function clip(text: string, limit: number, notice: string): string {
  return text.length > limit ? `${text.slice(0, limit)}…（${notice}）` : text;
}

/** The text message that starts a turn in the topic; null when the turn has no visible prompt. */
export function promptLine(turn: TurnView): string | null {
  const attachments = turn.attachments.length ? `（附件：${turn.attachments.join("、")}）` : "";
  const source = sourceLabel(turn.entrypoint);
  switch (turn.origin) {
    case "human": return `${source}：${clip(turn.prompt, PROMPT_LIMIT, "已截断，完整内容见导出记录")}${attachments}`;
    case "command": return `${source} 执行命令：${clip(turn.prompt, 300, "已截断")}`;
    case "peer": return `【子 agent 回报】${clip(turn.prompt.replace(/\s+/g, " "), 300, "已截断")}`;
    case "task": return `【后台任务通知】${clip(turn.prompt.replace(/\s+/g, " "), 300, "已截断")}`;
    default: return turn.prompt ? `【系统消息】${clip(turn.prompt.replace(/\s+/g, " "), 300, "已截断")}` : null;
  }
}

function turnHeading(turn: TurnView): string {
  const source = sourceLabel(turn.entrypoint);
  return ({ human: `${source} 提问`, command: `${source} 命令`, peer: "子 agent 回报", task: "后台任务通知", system: "系统消息" } as const)[turn.origin];
}

function toolName(name: string): string {
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  return mcp ? `${mcp[1]}/${mcp[2]}` : name;
}

export function toolLine(block: TurnBlock): string {
  const mark = block.status === "ok" ? "✓" : block.status === "error" ? "✗" : "…";
  return `${mark} ${toolName(block.name ?? "tool")}${block.text ? ` · ${block.text}` : ""}`;
}

/** Assistant text and notes of a turn, in order. */
export function turnText(turn: TurnView): string {
  return turn.blocks.filter((block) => block.kind !== "tool")
    .map((block) => block.kind === "note" ? `— ${block.text} —` : block.text).join("\n\n");
}

function statusTitle(turn: TurnView, stale: boolean): { title: string; template: string } {
  if (turn.status === "interrupted") return { title: "Claude · 已中断", template: "grey" };
  if (stale) return { title: "Claude · 未完成", template: "grey" };
  if (turn.status === "done") return { title: `Claude · 已完成${turn.durationMs !== null ? ` · 用时 ${formatDuration(turn.durationMs)}` : ""}`, template: "green" };
  return { title: "Claude · 进行中", template: "blue" };
}

/**
 * One card per turn: Claude's text, then the tool calls folded into a panel, like the
 * terminal's transcript. `simpleTools` lists tools as plain text for clients without panels;
 * `stale` marks a turn that stopped without any completion record.
 */
export function claudeTurnCard(turn: TurnView, options: { simpleTools?: boolean; stale?: boolean } = {}): CardDefinition {
  const stale = Boolean(options.stale) && turn.status === "running";
  const { title, template } = statusTitle(turn, stale);
  let text = turnText(turn);
  if (text.length > CARD_TEXT_LIMIT) text = `（前文过长，已省略；完整内容见附件或导出记录）\n\n${text.slice(-CARD_TEXT_LIMIT)}`;
  const tools = turn.blocks.filter((block) => block.kind === "tool");
  const failed = tools.filter((block) => block.status === "error").length;
  const lines = tools.slice(-TOOL_LINES).map((block) => safeMarkdown(toolLine(block)));
  const hidden = tools.length - lines.length + turn.omittedTools;
  if (hidden > 0) lines.unshift(`…另有 ${hidden} 项较早的操作`);
  const empty = stale ? "（这一轮没有完成记录，可能已被关闭或请求失败）" : turn.status === "running" ? "正在处理…" : "（没有文字回复）";
  const elements: Record<string, unknown>[] = [markdown(text || empty)];
  const last = turn.blocks.at(-1);
  if (!stale && turn.status === "running" && last?.kind === "tool" && last.status === "running") elements.push(note(`正在执行：${safeMarkdown(toolLine(last).slice(2))}`));
  if (lines.length) {
    const heading = `执行记录（${tools.length + turn.omittedTools} 项${failed ? `，失败 ${failed} 项` : ""}）`;
    elements.push(options.simpleTools
      ? markdown(`**${heading}**\n${lines.slice(-15).join("\n")}`)
      : { tag: "collapsible_panel", element_id: nextElementId("tools"), expanded: false,
        header: { title: { tag: "markdown", content: heading } }, elements: [markdown(lines.join("\n"))] });
  }
  return card(title, template, elements);
}

/**
 * The topic's root card. `outOfScope` (the current SYNC_DIRS, as text) marks a session that is
 * no longer mirrored; its topic stays as it was.
 */
export const MODE_LABELS: Record<string, string> = {
  default: "默认（逐项确认）", acceptEdits: "自动接受编辑", plan: "计划模式（只读）", auto: "自动（由分类器判断）",
  bypassPermissions: "跳过权限检查", dontAsk: "不询问",
};
export function modeLabel(mode: string | null): string { return mode ? MODE_LABELS[mode] ?? mode : "未知"; }

/** A turn the bridge runs for Feishu right now: running, waiting for an answer, or connected but idle. */
export type LiveState = "running" | "waiting" | "idle";

export interface RootCardOptions {
  outOfScope?: string;
  live?: LiveState | null;
  /** The permission mode, model and effort the next Feishu turn uses. */
  feishuMode?: string;
  feishuModel?: string | null;
  feishuEffort?: string | null;
  /** The session this one was forked from in Feishu, with a link to its topic. */
  forkedFrom?: { title: string; link: string | null };
}

export function claudeRootCard(session: ClaudeSession, options: RootCardOptions = {}): CardDefinition {
  const resume = `claude --resume ${session.sessionId}`;
  if (options.outOfScope !== undefined) {
    return card(`${sessionTitle(session)}（已移出同步范围）`, "grey", [
      markdown([
        `项目：${safeMarkdown(displayPath(session.cwd))}`,
        "状态：**已移出同步范围，不再更新**",
        `当前同步范围：${safeMarkdown(options.outOfScope)}`,
        `会话 ID：\`${session.sessionId}\``,
      ].join("\n")),
      note("这个话题保留在群里，内容停在移出范围之前。同步范围再次包含该目录后，会在这里继续更新；不需要时可在控制台“清理范围外话题”。"),
    ]);
  }
  const live = options.live ?? null;
  const status = live === "running" ? "飞书中运行中" : live === "waiting" ? "飞书中等待你处理" : live === "idle" ? "飞书中已连接（空闲）" : presenceLabel(session);
  const template = live === "running" ? "orange" : live === "waiting" ? "red" : live === "idle" ? "blue" : presenceTemplate(session);
  const id = { sessionId: session.sessionId };
  const fork = options.forkedFrom;
  return card(`${sessionTitle(session)}${fork ? "（分叉）" : ""}`, template, [
    markdown([
      `项目：${safeMarkdown(displayPath(session.cwd))}`,
      ...(fork ? [`分叉自：${fork.link ? `[${safeMarkdown(fork.title)}](${fork.link})` : safeMarkdown(fork.title)}`] : []),
      `来源：${sourceLabel(session.entrypoint)}　模型：${safeMarkdown(session.model ?? "未知")}${session.effort ? `　推理强度：${safeMarkdown(session.effort)}` : ""}　最近的权限模式：${safeMarkdown(modeLabel(session.permissionMode))}`,
      `状态：**${status}**　最后活动：${formatTime(session.lastActivityMs)}`,
      `飞书续聊：${safeMarkdown(modeLabel(options.feishuMode ?? "default"))}　${safeMarkdown(options.feishuModel ?? "默认模型")} · ${options.feishuEffort ? `推理强度 ${safeMarkdown(options.feishuEffort)}` : "默认推理强度"}`,
      `会话 ID：\`${session.sessionId}\``,
    ].join("\n")),
    note(`在本话题直接回复就会继续这个会话：Claude 在本机运行，执行记录和需要你确认的事项都会发到这里。发送 /stop 停止当前回合；以 >> 开头的消息排到本轮结束后再发；单独发送 / 会在话题最新处再发一张本卡片，不用翻回顶部。在手机上发消息会切换到手机侧控制（电脑上这一轮还在运行时，等它结束再发送）。电脑上继续：\`${resume}\`。${session.presenceState === "waiting" && session.presenceMessage && !live ? `\n等待处理：${safeMarkdown(session.presenceMessage)}` : ""}`),
    actionRow([
      ...(live === "running" || live === "waiting" ? [button("停止本轮", "stop_turn", "danger", id)] : []),
      button("权限模式", "mode_card", "default", id),
      button("模型", "model_card", "default", id),
      button("导出完整记录", "export_session", "default", id),
      button("刷新", "refresh_session", "default", id),
    ]),
  ]);
}

function codeBlock(text: string, limit: number): string {
  const clipped = text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
  return `\`\`\`\n${clipped.replace(/\`\`\`/g, "ˋˋˋ")}\n\`\`\``;
}

/** What a tool call would do, in a form readable on a phone. */
function toolRequestDetail(toolName: string, input: Record<string, unknown>): string {
  const text = (value: unknown) => typeof value === "string" ? value : "";
  if (toolName === "Bash") return `${text(input.description) ? `${safeMarkdown(text(input.description))}\n` : ""}${codeBlock(text(input.command), 2_000)}`;
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) {
    const path = text(input.file_path) || text(input.notebook_path);
    const change = toolName === "Write" ? codeBlock(text(input.content), 1_200)
      : toolName === "Edit" ? `删除：\n${codeBlock(text(input.old_string), 600)}\n替换为：\n${codeBlock(text(input.new_string), 600)}`
      : codeBlock(JSON.stringify(input.edits ?? input.new_source ?? "", null, 2), 1_200);
    return `文件：${safeMarkdown(path)}\n${change}`;
  }
  if (toolName === "WebFetch") return `网址：${safeMarkdown(text(input.url))}${text(input.prompt) ? `\n目的：${safeMarkdown(text(input.prompt))}` : ""}`;
  return codeBlock(JSON.stringify(input, null, 2), 1_500);
}

/** A tool permission request, answered on the card or by replying with a reason to refuse. */
export function claudePermissionCard(interaction: Interaction): CardDefinition {
  const nonce = { nonce: interaction.nonce };
  return card(`Claude 请求使用 ${toolName(interaction.toolName)}`, "orange", [
    ...(interaction.title ? [markdown(`**${safeMarkdown(interaction.title)}**`)] : []),
    markdown(toolRequestDetail(interaction.toolName, interaction.input)),
    ...(interaction.reason ? [note(`原因：${safeMarkdown(interaction.reason)}`)] : []),
    actionRow([
      button("允许", "perm_allow", "primary", nonce),
      ...(interaction.allowAlways ? [button("本会话都允许", "perm_always", "default", nonce)] : []),
      button("拒绝", "perm_deny", "danger", nonce),
    ]),
    note("也可以直接在本话题回复文字：等于拒绝，并把这段话告诉 Claude。"),
  ]);
}

/** One question of an AskUserQuestion request; multi-question requests are answered in turn. */
export function claudeQuestionCard(interaction: Interaction, index: number): CardDefinition {
  const question = interaction.questions[index];
  if (!question) return claudeNoticeCard("问题已失效", "这个问题已经回答或已取消。");
  const details = question.options.map((option, optionIndex) => `${optionIndex + 1}. **${safeMarkdown(option.label)}**${option.description ? `：${safeMarkdown(option.description)}` : ""}`);
  return card(`Claude 提问 ${index + 1}/${interaction.questions.length}${question.header ? ` · ${shorten(question.header, 20)}` : ""}`, "orange", [
    markdown(`**${safeMarkdown(question.question)}**${details.length ? `\n${details.join("\n")}` : ""}`),
    ...(question.multiSelect ? [] : [actionRow(question.options.map((option, optionIndex) =>
      button(`${optionIndex + 1}. ${shorten(option.label, 16)}`, "ask_answer", optionIndex === 0 ? "primary" : "default", { nonce: interaction.nonce, question: index, option: optionIndex })))]),
    actionRow([button("不回答", "ask_skip", "default", { nonce: interaction.nonce })]),
    note(question.multiSelect ? "可多选：在本话题回复选项编号，用逗号分隔，例如 1,3；也可以直接回复自己的答案。" : "也可以在本话题回复选项编号，或直接回复自己的答案。"),
  ]);
}

/** Claude finished planning (ExitPlanMode); choose how to carry the plan out, or ask for changes. */
export function claudePlanCard(interaction: Interaction): CardDefinition {
  const plan = typeof interaction.input.plan === "string" ? interaction.input.plan : "";
  const nonce = { nonce: interaction.nonce };
  return card("Claude 提交了计划，等你确认", "orange", [
    markdown(plan ? (plan.length > CARD_TEXT_LIMIT ? `${plan.slice(0, CARD_TEXT_LIMIT)}\n\n…（计划过长，已截断）` : plan) : "（没有收到计划正文）"),
    actionRow([
      button("执行，自动接受编辑", "plan_edits", "primary", nonce),
      button("执行，逐项确认", "plan_default", "default", nonce),
      button("继续修改计划", "plan_revise", "default", nonce),
    ]),
    note("也可以直接在本话题回复修改意见，Claude 会据此继续完善计划。"),
  ]);
}

/**
 * The session is in the middle of a turn in VS Code or a terminal. The phone takes over as soon as
 * that turn ends: until then both sides would write into the same session at once.
 */
export function claudeLocalBusyCard(session: ClaudeSession, nonce: string, messages: number): CardDefinition {
  const waiting = session.presenceState === "waiting";
  return card(waiting ? "电脑上正在等你确认" : "电脑上这一轮还在运行", "orange", [
    markdown([
      `会话在**${presenceLabel(session)}**。为避免两边同时写入同一个会话，${messages > 1 ? `你的 ${messages} 条消息` : "你的消息"}会在电脑上这一轮结束后自动发送，并切换到手机侧控制。`,
      ...(waiting ? ["电脑上的这一轮在等待确认，只能在电脑上处理；不想等的话，可以立即切换或分叉。"] : []),
    ].join("\n")),
    actionRow([
      button("立即切换到手机", "conflict_takeover", "primary", { nonce }),
      button("分叉到新话题", "conflict_fork", "default", { nonce }),
      button("取消", "conflict_cancel", "default", { nonce }),
    ]),
    note("立即切换：不等电脑上这一轮结束，现在就发送，两边的内容可能交错。分叉：复制到目前为止的对话，在新话题里继续，电脑上的会话不受影响。"),
  ]);
}

/** What became of a request once it is answered, cancelled or refused. */
export function claudeInteractionDoneCard(interaction: Interaction, outcome: string, template: string, detail = ""): CardDefinition {
  const subject = interaction.kind === "question" ? "Claude 提问" : interaction.kind === "plan" ? "Claude 的计划" : `使用 ${toolName(interaction.toolName)}`;
  return card(`${subject} · ${outcome}`, template, detail ? [markdown(safeMarkdown(detail))] : [note("已处理。")]);
}

export function claudeModeCard(session: ClaudeSession, current: string, modes: readonly string[]): CardDefinition {
  return card("飞书续聊的权限模式", "blue", [
    markdown(`当前：**${safeMarkdown(modeLabel(current))}**\n会话：${safeMarkdown(sessionTitle(session))}`),
    actionRow(modes.map((mode) => button(modeLabel(mode), "set_mode", mode === current ? "primary" : "default", { sessionId: session.sessionId, mode }))),
    note("权限仍按你在 settings.json 中的允许和拒绝规则判断；没有被规则覆盖的操作，会在这里发卡片请你确认。飞书端不提供跳过权限检查的模式。"),
  ]);
}

export function claudeModelCard(session: ClaudeSession, models: ReadonlyArray<{ value: string; label: string }>, efforts: readonly string[], current: { model: string | null; effort: string | null }): CardDefinition {
  return card("飞书续聊的模型", "blue", [
    markdown(`当前：**${safeMarkdown(current.model ?? "默认模型")}**${current.effort ? ` · 推理强度 ${safeMarkdown(current.effort)}` : ""}`),
    actionRow([button("默认模型", "set_model", current.model ? "default" : "primary", { sessionId: session.sessionId, model: "" }),
      ...models.map((model) => button(model.label, "set_model", model.value === current.model ? "primary" : "default", { sessionId: session.sessionId, model: model.value }))]),
    actionRow([button("默认强度", "set_effort", current.effort ? "default" : "primary", { sessionId: session.sessionId, effort: "" }),
      ...efforts.map((effort) => button(effort, "set_effort", effort === current.effort ? "primary" : "default", { sessionId: session.sessionId, effort }))]),
    note("选择具体的模型或强度，正在运行的会话立即生效；选“默认”时，从下一条消息开始改用你在 Claude Code 设置中保存的模型和强度（而不是模型自带的默认值）。设置只影响飞书里的对话，不会修改 VS Code 和终端的设置。"),
  ]);
}

/**
 * Step one of a new session: pick a recent project directory or type one. With a draft (a
 * message sent in the group's main timeline), picking the directory starts the session with it.
 */
export function claudeNewSessionCard(directories: readonly string[], scope: string, draft?: { nonce: string; preview: string }, notice = ""): CardDefinition {
  const extra = draft ? { draft: draft.nonce } : {};
  // Full paths go in the text, which wraps; a button label that long would be cut to "…" on a phone.
  const list = directories.map((dir, index) => `${index + 1}. ${safeMarkdown(displayPath(dir))}`);
  const buttons = directories.map((dir, index) => button(`${index + 1} · ${shorten(basename(dir) || dir, 12)}`, "new_pick", "default", { cwd: dir, ...extra }));
  return card("新建 Claude 会话", "turquoise", [
    ...(notice ? [markdown(`**${safeMarkdown(notice)}**`)] : []),
    ...(draft ? [markdown(`任务：${safeMarkdown(shorten(draft.preview, 200) || "（图片）")}`)] : []),
    markdown(`${draft ? "选择在哪个目录中开始" : "选择项目目录"}（同步范围：${safeMarkdown(scope)}）：${list.length ? `\n${list.join("\n")}` : ""}`),
    ...(buttons.length ? [actionRow(buttons)] : []),
    ...inputForm({ formName: "new_dir_form", inputName: "new_dir", elementId: "new_dir", placeholder: "或输入目录的绝对路径，例如 ~/usr/zhangzy/workspace/项目", maxLength: 300,
      buttons: [{ label: "使用这个目录", action: "new_pick_path", type: "primary", extra }] }),
    actionRow([button("返回控制台", "home")]),
  ]);
}

/** Step two of a new session: the first message, in the chosen directory. */
export function claudeNewTaskCard(cwd: string, notice = ""): CardDefinition {
  return card("新建 Claude 会话", "turquoise", [
    ...(notice ? [markdown(`**${safeMarkdown(notice)}**`)] : []),
    markdown(`目录：${safeMarkdown(displayPath(cwd))}`),
    ...inputForm({ formName: "new_task_form", inputName: "new_task", elementId: "new_task", placeholder: "要 Claude 做什么（更长的任务可以在新话题里接着补充）", maxLength: 1_000, multiline: true, rows: 5,
      buttons: [{ label: "开始", action: "new_submit", type: "primary", extra: { cwd } }] }),
    note("会在这个目录中启动 Claude Code（使用你本机的设置），并为它新建一个话题。"),
    actionRow([button("重新选择目录", "new_session")]),
  ]);
}

export function claudeHomeCard(status: { paused: boolean; indexed: number; topics: number; open: number; failures: number; scope: string; outOfScopeTopics?: number }, notice = ""): CardDefinition {
  return card("Claude 控制台", status.paused ? "orange" : "blue", [
    ...(notice ? [markdown(`**${safeMarkdown(notice)}**`)] : []),
    markdown(`服务：**${status.paused ? "已暂停" : "运行中"}**　已索引会话：**${status.indexed}**　已建话题：**${status.topics}**　本机打开中：**${status.open}**　未解决失败：**${status.failures}**\n同步范围：${safeMarkdown(status.scope)}`),
    actionRow([
      button("新建会话", "new_session", "primary"),
      button("最近会话", "recent"),
      button("立即同步", "sync"),
      button(status.paused ? "恢复同步" : "暂停同步", status.paused ? "resume" : "pause"),
      button("帮助", "help"),
    ]),
    ...(status.outOfScopeTopics ? [actionRow([button(`清理范围外话题（${status.outOfScopeTopics}）`, "cleanup_preview", "danger")])] : []),
  ]);
}

/** Lists the topics a cleanup would withdraw; nothing happens until the person confirms. */
export function claudeCleanupCard(sessions: ClaudeSession[], nonce: string, scope: string): CardDefinition {
  const lines = sessions.slice(0, 20).map((session, index) => `${index + 1}. ${safeMarkdown(sessionTitle(session))} · ${safeMarkdown(displayPath(session.cwd))}`);
  if (sessions.length > 20) lines.push(`…另有 ${sessions.length - 20} 个`);
  return card(`清理 ${sessions.length} 个范围外话题`, "red", [
    markdown(`以下话题的工作目录不在当前同步范围（${safeMarkdown(scope)}）内：\n${lines.join("\n")}`),
    note("确认后会撤回机器人在这些话题里发过的全部消息（根卡片、提问、回复卡片、附件和提醒）。你自己发的消息机器人无法撤回；超过企业撤回时限（默认为发出后 24 小时，可由管理员调整）的消息也撤不掉，结果里会逐条列出。会话仍保留在本机索引中，以后同步范围包含它们、且有新活动时，会重新建话题。"),
    actionRow([button("确认清理", "cleanup_confirm", "danger", { nonce }), button("取消", "home")]),
  ]);
}

export function claudeCleanupResultCard(result: { topics: number; withdrawn: number; kept: Array<{ title: string; reason: string }> }): CardDefinition {
  const kept = result.kept.slice(0, 20).map((item) => `- ${safeMarkdown(item.title)}：${safeMarkdown(item.reason)}`);
  if (result.kept.length > 20) kept.push(`- …另有 ${result.kept.length - 20} 条`);
  return card("范围外话题清理完成", result.kept.length ? "orange" : "green", [
    markdown(`处理话题：**${result.topics}**　撤回消息：**${result.withdrawn}**　未能撤回：**${result.kept.length}**`),
    ...(kept.length ? [markdown(`未能撤回的消息：\n${kept.join("\n")}`)] : []),
    actionRow([button("返回控制台", "home")]),
  ]);
}

export function claudeHelpCard(): CardDefinition {
  return card("Claude 桥接帮助", "wathet", [
    markdown([
      "本机 Claude Code（VS Code 或终端）的会话会同步到这个群：每个会话一个话题，每一轮对话一张卡片，执行记录折叠在卡片里。",
      "**继续对话**：在会话话题里直接回复即可。Claude 在本机运行，使用你本机的设置；需要你确认的权限、提问和计划会以卡片发到话题里。在手机上发消息会切换到手机侧控制；电脑上这一轮还在运行时，会等它结束后再发送。",
      "**话题中的命令**：`/` 在话题最新处调出会话控制卡片（同根卡片）；`/status` 同上；`/model` 模型和推理强度；`/mode` 权限模式；`/help` 本帮助；`/stop` 停止当前回合；以 `>>` 开头的消息排到本轮结束后再发；`/export` 导出完整记录；`/ls [路径]` 查看会话目录（或指定目录）下的文件，加 `-a` 显示以 . 开头的项；`/deliver <路径…>` 把本机文件发到话题里（相对会话目录，可以是文件、目录或通配符，如 `/deliver output/*.png report.md`）。其它以 `/` 开头的内容（如 `/compact`）会直接交给 Claude。",
      "**新建会话**：控制台点“新建会话”；在群主消息中 @我 直接写任务，再选目录；或发送 `/new <目录> <任务>`。",
      "最近几天有活动的会话会自动建话题；更早的会话可以在“最近会话”中搜索后打开。只想同步部分目录时，在环境文件中设置 `SYNC_DIRS`。",
      "",
      "**群主消息中的命令**：`/` 命令菜单、`/help` 帮助、`/status` 控制台、`/new` 新建会话、`/sessions` 最近会话、`/search <关键词>` 搜索、`/sync` 立即同步、`/pause` 与 `/resume-sync` 暂停或恢复同步。",
    ].join("\n")),
    actionRow([button("返回控制台", "home", "primary"), button("新建会话", "new_session"), button("最近会话", "recent")]),
  ]);
}

export function claudeCommandMenuCard(notice = ""): CardDefinition {
  return card("Claude 命令菜单", "blue", [
    ...(notice ? [markdown(`**${safeMarkdown(notice)}**`)] : []),
    markdown("群主消息中发送单独的 `/` 可以再次打开本菜单。"),
    actionRow([button("新建会话", "new_session", "primary"), button("最近会话", "recent"), button("控制台", "home"), button("帮助", "help")]),
  ]);
}

export function claudeRecentCard(sessions: ClaudeSession[], search = "", page = 0, hasMore = false): CardDefinition {
  const lines = sessions.map((session, index) => {
    const number = page * 8 + index + 1;
    const title = safeMarkdown(sessionTitle(session));
    const where = `${safeMarkdown(basename(session.cwd ?? "") || "~")} · ${formatTime(session.lastActivityMs)} · ${presenceLabel(session)}`;
    return session.rootAppLink ? `${number}. [${title}](${session.rootAppLink}) · ${where}` : `${number}. ${title} · ${where}`;
  });
  const openButtons = sessions.flatMap((session, index) => session.rootMessageId ? [] : [button(`打开 ${page * 8 + index + 1}`, "open_session", "default", { sessionId: session.sessionId })]);
  return card(search ? "搜索 Claude 会话" : "最近 Claude 会话", "indigo", [
    ...inputForm({ formName: "search_form", inputName: "session_search", elementId: "session_search", placeholder: "标题、首条消息、目录或会话 ID",
      maxLength: 120, buttons: [{ label: "搜索", action: "search_sessions", type: "primary" }] }),
    ...(search ? [markdown(`搜索：${safeMarkdown(search)}`)] : []),
    markdown(lines.length ? lines.join("\n") : "没有找到会话。"),
    ...(openButtons.length ? [note("没有话题的会话可以点击“打开”，会新建话题并显示最后一轮。"), actionRow(openButtons)] : []),
    actionRow([
      ...(page > 0 ? [button("上一页", "recent_page", "default", { page: page - 1, search })] : []),
      ...(hasMore ? [button("下一页", "recent_page", "default", { page: page + 1, search })] : []),
      button("返回控制台", "home"),
    ]),
  ]);
}

/** What `/deliver` is about to send to the topic, and what it leaves out. */
export function claudeDeliverCard(cwd: string | null, selection: DeliverySelection): CardDefinition {
  const sent = selection.files.map((file, index) =>
    `${index + 1}. ${safeMarkdown(file.label)} · ${formatBytes(file.size)}${file.kind === "image" ? " · 图片" : ""}`);
  const skipped = selection.skipped.slice(0, 20).map((item) => `- ${safeMarkdown(item.label)}：${safeMarkdown(item.reason)}`);
  if (selection.skipped.length > 20) skipped.push(`- …另有 ${selection.skipped.length - 20} 项`);
  const total = selection.files.reduce((sum, file) => sum + file.size, 0);
  return card("交付文件", selection.files.length ? "green" : "orange", [
    markdown(`目录：${safeMarkdown(displayPath(cwd))}`),
    markdown(selection.files.length ? `**发送 ${selection.files.length} 个文件，共 ${formatBytes(total)}**，依次出现在下方：\n${sent.join("\n")}` : "**没有可以发送的文件。**"),
    ...(skipped.length ? [markdown(`**未发送**：\n${skipped.join("\n")}`)] : []),
  ]);
}

/** `/ls`: a directory's entries, with buttons to move between directories and send its files. */
export function claudeListCard(session: ClaudeSession, listing: DirectoryListing, showHidden = false, notice = ""): CardDefinition {
  const id = { sessionId: session.sessionId };
  const noticeLine = notice ? [markdown(`**${safeMarkdown(notice)}**`)] : [];
  if (listing.kind === "error") return card("查看目录", "red", [markdown(safeMarkdown(listing.message))]);
  if (listing.kind === "file") {
    return card("文件信息", "wathet", [
      ...noticeLine,
      markdown(`${safeMarkdown(displayPath(listing.path))}\n${formatBytes(listing.entry.size)} · 修改于 ${formatTime(listing.entry.mtimeMs)}`),
      actionRow([button("发送这个文件", "deliver_paths", "primary", { ...id, path: listing.path })]),
    ]);
  }
  const lines = listing.entries.map((entry) => entry.kind === "dir"
    ? `- **${safeMarkdown(entry.name)}/**`
    : `- ${safeMarkdown(entry.name)} · ${formatBytes(entry.size)} · ${formatTime(entry.mtimeMs)}`);
  const more = listing.total - listing.entries.length;
  const summary = [`共 ${listing.total} 项${more > 0 ? `，只列出前 ${listing.entries.length} 项` : ""}`,
    ...(listing.hidden ? [`另有 ${listing.hidden} 个以 . 开头的项，发送 /ls -a 查看`] : [])].join("；");
  const dirs = listing.entries.filter((entry) => entry.kind === "dir").slice(0, 12);
  const hasFiles = listing.entries.some((entry) => entry.kind === "file");
  const extra = showHidden ? { hidden: "1" } : {};
  return card("目录内容", "wathet", [
    ...noticeLine,
    markdown(`目录：**${safeMarkdown(displayPath(listing.path))}**`),
    markdown(lines.length ? lines.join("\n") : "（空目录）"),
    note(`${summary}。点目录名进入；发送 /deliver <文件名> 把文件发到话题里（路径相对会话目录）。`),
    ...(dirs.length ? [actionRow(dirs.map((entry) => button(`${shorten(entry.name, 20)}/`, "ls_dir", "default", { ...id, ...extra, path: `${listing.path}/${entry.name}` })))] : []),
    actionRow([
      ...(listing.parent ? [button("上一级", "ls_dir", "default", { ...id, ...extra, path: listing.parent })] : []),
      ...(session.cwd && listing.path !== session.cwd ? [button("会话目录", "ls_dir", "default", { ...id, ...extra, path: session.cwd })] : []),
      ...(hasFiles ? [button("发送本目录的文件", "deliver_paths", "primary", { ...id, path: listing.path })] : []),
    ]),
  ]);
}

export function claudeNoticeCard(title: string, text: string, template = "grey"): CardDefinition {
  return card(title, template, [markdown(safeMarkdown(text))]);
}

/** A session was started from a card; links to its new topic. */
export function claudeStartedCard(cwd: string, link: string | null): CardDefinition {
  return card("已新建会话", "green", [
    markdown(`目录：${safeMarkdown(displayPath(cwd))}`),
    link ? markdown(`[打开话题](${link})`) : note("话题已在群里创建。"),
  ]);
}

/** A readable Markdown transcript of every turn, for the export button and over-long replies. */
export function transcriptMarkdown(session: ClaudeSession, turns: readonly TurnView[]): string {
  const sections = turns.map((turn, index) => {
    const prompt = turn.prompt ? `${turn.prompt}${turn.attachments.length ? `\n\n（附件：${turn.attachments.join("、")}）` : ""}` : "（无）";
    const tools = turn.blocks.filter((block) => block.kind === "tool").map((block) => `- ${toolLine(block)}`);
    const status = turn.status === "done" ? `已完成${turn.durationMs !== null ? `，用时 ${formatDuration(turn.durationMs)}` : ""}` : turn.status === "interrupted" ? "已中断" : "进行中";
    return [
      `## ${index + 1}. ${turnHeading(turn)} · ${formatTime(Date.parse(turn.startedAt))}`,
      "", "**提问**", "", prompt, "", `**Claude**（${status}）`, "", turnText(turn) || "（没有文字回复）",
      ...(tools.length ? ["", `<details><summary>执行记录（${tools.length} 项）</summary>`, "", ...tools, "", "</details>"] : []),
    ].join("\n");
  });
  return [`# ${sessionTitle(session)}`, "", `- 会话 ID：${session.sessionId}`, `- 项目：${displayPath(session.cwd)}`,
    `- 来源：${sourceLabel(session.entrypoint)}`, `- 导出时间：${formatTime(Date.now())}`, "", ...sections.flatMap((section) => ["---", "", section, ""])].join("\n");
}

/** A single turn as Markdown, attached when its text is too long for a card. */
export function turnMarkdown(session: ClaudeSession, turn: TurnView): string {
  return transcriptMarkdown(session, [turn]);
}
