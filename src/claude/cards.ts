import { homedir } from "node:os";
import { basename } from "node:path";
import { actionRow, button, card, inputForm, markdown, nextElementId, note, safeMarkdown, shorten } from "../card-kit.js";
import type { CardDefinition } from "../types.js";
import type { TurnBlock, TurnView } from "./conversation.js";
import type { ClaudeSession } from "./db.js";

/** Longest assistant text kept in a card; Feishu rejects card content above roughly 30 KB. */
export const CARD_TEXT_LIMIT = 18_000;
const PROMPT_LIMIT = 2_000;
const TOOL_LINES = 40;

export function sourceLabel(entrypoint: string | null): string {
  if (entrypoint === "claude-vscode") return "VS Code";
  if (entrypoint === "cli") return "终端";
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

function displayPath(path: string | null): string {
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
    default: return "未知（尚未收到 hook 状态）";
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
export function claudeRootCard(session: ClaudeSession, options: { outOfScope?: string } = {}): CardDefinition {
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
  return card(sessionTitle(session), presenceTemplate(session), [
    markdown([
      `项目：${safeMarkdown(displayPath(session.cwd))}`,
      `来源：${sourceLabel(session.entrypoint)}　模型：${safeMarkdown(session.model ?? "未知")}　权限模式：${safeMarkdown(session.permissionMode ?? "未知")}`,
      `状态：**${presenceLabel(session)}**　最后活动：${formatTime(session.lastActivityMs)}`,
      `会话 ID：\`${session.sessionId}\``,
    ].join("\n")),
    note(`只读镜像：这里同步显示本机的对话。要继续这个会话，请在电脑上用 VS Code 打开它，或运行 \`${resume}\`；手机上可以先在 VS Code 中输入 /rc，再用 Claude App 接续。${session.presenceState === "waiting" && session.presenceMessage ? `\n等待处理：${safeMarkdown(session.presenceMessage)}` : ""}`),
    actionRow([button("导出完整记录", "export_session", "primary", { sessionId: session.sessionId }), button("刷新", "refresh_session", "default", { sessionId: session.sessionId })]),
  ]);
}

export function claudeHomeCard(status: { paused: boolean; indexed: number; topics: number; open: number; failures: number; scope: string; outOfScopeTopics?: number }, notice = ""): CardDefinition {
  return card("Claude 控制台", status.paused ? "orange" : "blue", [
    ...(notice ? [markdown(`**${safeMarkdown(notice)}**`)] : []),
    markdown(`服务：**${status.paused ? "已暂停" : "运行中"}**　已索引会话：**${status.indexed}**　已建话题：**${status.topics}**　本机打开中：**${status.open}**　未解决失败：**${status.failures}**\n同步范围：${safeMarkdown(status.scope)}`),
    actionRow([
      button("最近会话", "recent", "primary"),
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
    note("确认后会撤回机器人在这些话题里发过的全部消息（根卡片、提问、回复卡片、附件和提醒）。你自己发的消息机器人无法撤回；超过飞书撤回时限的消息也撤不掉，结果里会逐条列出。会话仍保留在本机索引中，以后同步范围包含它们、且有新活动时，会重新建话题。"),
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
      "**当前是只读镜像阶段**：本机 Claude Code（VS Code 或终端）的会话会同步到这个群，每个会话一个话题，每一轮对话一张卡片，执行记录折叠在卡片里。",
      "最近几天有活动的会话会自动建话题，并显示最后一轮；更早的内容可以在话题里点“导出完整记录”。更早的会话可以在“最近会话”中搜索后打开。",
      "会话在 VS Code 或终端里等待你确认权限时，话题里会收到提醒。",
      "只想同步部分目录时，在环境文件中设置 `SYNC_DIRS`（多个目录用英文逗号分隔），重启服务后生效；控制台会显示当前的同步范围。",
      "",
      "**群主消息中的命令**：`/` 命令菜单、`/help` 帮助、`/status` 控制台、`/sessions` 最近会话、`/search <关键词>` 搜索、`/sync` 立即同步、`/pause` 与 `/resume-sync` 暂停或恢复同步。",
      "**会话话题中的命令**：`/export` 导出完整记录。其它消息暂不会发给 Claude。",
    ].join("\n")),
    actionRow([button("返回控制台", "home", "primary"), button("最近会话", "recent")]),
  ]);
}

export function claudeCommandMenuCard(notice = ""): CardDefinition {
  return card("Claude 命令菜单", "blue", [
    ...(notice ? [markdown(`**${safeMarkdown(notice)}**`)] : []),
    markdown("群主消息中发送单独的 `/` 可以再次打开本菜单。"),
    actionRow([button("最近会话", "recent", "primary"), button("控制台", "home"), button("帮助", "help")]),
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

export function claudeNoticeCard(title: string, text: string, template = "grey"): CardDefinition {
  return card(title, template, [markdown(safeMarkdown(text))]);
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
