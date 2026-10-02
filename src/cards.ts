import { basename, relative } from "node:path";
import { actionRow, button, card, cardUiVersion, inputForm, markdown, nextElementId, note, plain, safeMarkdown, shorten } from "./card-kit.js";
import type { CardDefinition, ChoiceOption, ChoiceQuestion, ChoiceRequest, ModelCapability, SessionMetadata } from "./types.js";

export { configureCardUi } from "./card-kit.js";

type SessionView = SessionMetadata & { rootMessageId: string | null; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null };

export const EFFORT_LABELS: Record<string, string> = {
  low: "快速", medium: "平衡", high: "深入", xhigh: "超高", max: "最大", ultra: "极限",
};
export function effortLabel(effort: string): string { return `${EFFORT_LABELS[effort] ?? effort} ${effort}`; }
function summary(cwd?: string, model?: string, effort?: string): string {
  return `项目：${cwd ? `\`${safeMarkdown(cwd)}\`` : "未选择"}　模型：${model ? `\`${safeMarkdown(model)}\`` : "未选择"}　强度：${effort ? `\`${safeMarkdown(effortLabel(effort))}\`` : "未选择"}`;
}

export function homeCard(status: { paused: boolean; sessions: number; active: number; failures: number; queued?: number; waiting?: number; failedTasks?: number; appServer?: string }, notice = ""): CardDefinition {
  return card("Codex 控制台", status.paused ? "orange" : "blue", [
    ...(notice ? [markdown(`**${safeMarkdown(notice)}**`)] : []),
    markdown(`服务：**${status.paused ? "已暂停" : "运行中"}**　会话：**${status.sessions}**　运行中：**${status.active}**　排队：**${status.queued ?? 0}**　等待用户：**${status.waiting ?? 0}**　失败任务：**${status.failedTasks ?? 0}**　失败类别：**${status.failures}**${status.appServer ? `　app-server：**${safeMarkdown(status.appServer)}**` : ""}`),
    actionRow([button("新建会话", "new", "primary"), button("继续最近", "recent"), button("项目", "projects")]),
    actionRow([button("服务管理", "service")]),
    note("会话话题内直接回复或使用 /model 均无需 @ 机器人；优先使用会话根卡的“修改模型”。"),
  ]);
}

export function serviceCard(status: { paused: boolean; sessions: number; active: number; failures: number; queued?: number; waiting?: number; failedTasks?: number; appServer?: string }): CardDefinition {
  return card("服务管理", status.paused ? "orange" : "blue", [
    markdown(`服务：**${status.paused ? "已暂停" : "运行中"}**\n会话：${status.sessions}　运行中：${status.active}　排队：${status.queued ?? 0}　等待用户：${status.waiting ?? 0}　失败任务：${status.failedTasks ?? 0}　未解决失败类别：${status.failures}${status.appServer ? `\napp-server：${safeMarkdown(status.appServer)}` : ""}`),
    actionRow([button("立即同步", "sync", "primary"), status.paused ? button("恢复 Bridge", "resume", "primary") : button("暂停 Bridge", "pause")]),
    actionRow([button("重试失败", "retry"), button("使用帮助", "help"), button("返回控制台", "home")]),
  ]);
}

export function helpCard(): CardDefinition {
  return card("Codex 使用帮助", "wathet", [
    markdown("**快捷工作流**\n点击“新建会话”，依次选择项目、模型、强度，然后在卡片或聊天中输入任务。\n\n在任一会话话题中直接回复即可继续，且无需 @ 机器人。话题里只有 `/` 开头的命令由桥接处理，其他文字（包括“状态”“重试”这类单个词）都会发给 Codex。修改该会话后续续聊的模型时，优先点击会话根卡的“修改模型”；`/model` 与 `/model <模型> <思考强度>` 是文字兜底，同样无需 @。\n\n群主消息中发送单独的 `/` 后会返回命令菜单；在会话话题里发送单独的 `/`，会在话题最新处再发一张会话根卡，长话题不用翻回顶部。这些是发送后的操作面板，不是飞书输入框的实时命令补全。会话搜索支持目录、首条用户消息和短会话 ID，多关键词按 AND 匹配。\n\n示例：`/search example-project`、`/search GUI Agent`、`/search 1a2b3c4d`。\n\n文字入口：`/new <目录> <任务>`、`/sessions`、`/search <关键词>`、`/help`、`/status`、`/sync`、`/pause`、`/resume-sync`、`/retry`、`/cancel`。"),
    actionRow([button("返回控制台", "home", "primary"), button("新建会话", "new")]),
  ]);
}

export function commandMenuCard(notice = ""): CardDefinition {
  return card("Codex 命令菜单", "blue", [
    ...(notice ? [markdown(`**${safeMarkdown(notice)}**`)] : []),
    markdown("群主级操作。群内发送单独的 `/` 后可以再次打开本菜单。会话模型请进入对应话题，点击根卡“修改模型”。"),
    actionRow([button("新建会话", "new", "primary"), button("搜索会话", "search_open"), button("继续最近", "recent")]),
    actionRow([button("控制台", "home"), button("服务管理", "service"), button("帮助", "help")]),
  ]);
}

export function projectsCard(directories: Array<{ cwd: string; count: number; latest?: string }>, allowedRoot: string, wizardId: string, search = ""): CardDefinition {
  // Full paths go in the text, which wraps; button labels that long would be cut to "…" on a phone.
  const list = directories.map(({ cwd, count }, index) => `${index + 1}. ${safeMarkdown(cwd)}（${count} 个会话）`);
  const buttons = directories.map(({ cwd }, index) =>
    button(`${index + 1} · ${shorten(basename(cwd) || "home", 12)}`, "select_project", index === 0 ? "primary" : "default", { cwd, label: relative(allowedRoot, cwd) || ".", wizardId }));
  const rows = buttons.length ? [actionRow(buttons)] : [];
  return card("1/4 选择项目", "turquoise", [
    markdown(`${summary()}\n\n按历史使用记录选择项目，或输入新的已授权目录。${list.length ? `\n${list.join("\n")}` : ""}`),
    ...inputForm({ formName: "project_form", inputName: "project_path", elementId: "project_path", placeholder: `${allowedRoot.replace(/\/$/, "")}/项目目录`, maxLength: 500,
      buttons: [
        { label: "使用输入目录", action: "submit_project_path", type: "primary", extra: { wizardId } },
        { label: "搜索项目", action: "search_projects", extra: { wizardId } },
      ] }),
    ...(search ? [markdown(`搜索：\`${safeMarkdown(search)}\``)] : []), ...rows,
    actionRow([button("返回控制台", "home")]),
  ]);
}

export function modelCard(models: ModelCapability[], wizardId: string, currentModel?: string, cwd?: string, wizardMode: "new" | "session" = "new"): CardDefinition {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < models.length; index += 2) rows.push(actionRow(models.slice(index, index + 2).map((model) =>
    button(model.displayName, "select_model", model.slug === currentModel ? "primary" : "default", { wizardId, wizardMode, model: model.slug }))));
  const descriptions = models.map((model) => `**${safeMarkdown(model.displayName)}**  ${safeMarkdown(model.description || model.slug)}\n默认：${safeMarkdown(effortLabel(model.defaultReasoningEffort))}`);
  return card(wizardMode === "session" ? "设置会话模型" : "2/4 选择模型", "purple", [markdown(`${summary(cwd, currentModel)}\n\n${wizardMode === "session" ? "此设置仅影响当前话题之后的续聊；话题内无需 @ 机器人。\n\n" : ""}${descriptions.join("\n\n")}`), ...rows,
    actionRow([button("取消", "cancel_wizard", "danger", { wizardId, wizardMode }), ...(wizardMode === "new" ? [button("返回项目", "projects", "default", { wizardId, wizardMode })] : [])])]);
}

export function reasoningEffortCard(model: ModelCapability, wizardId: string, cwd?: string, wizardMode: "new" | "session" = "new"): CardDefinition {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < model.supportedReasoningEfforts.length; index += 3) rows.push(actionRow(model.supportedReasoningEfforts.slice(index, index + 3).map((effort) =>
    button(effortLabel(effort), "select_reasoning_effort", effort === model.defaultReasoningEffort ? "primary" : "default", { wizardId, wizardMode, effort }))));
  return card(wizardMode === "session" ? "设置思考强度" : "3/4 选择思考强度", "orange", [
    markdown(`${summary(cwd, model.slug)}\n\n${wizardMode === "session" ? "完成后只更新当前话题之后的续聊。\n\n" : ""}默认：**${safeMarkdown(effortLabel(model.defaultReasoningEffort))}**${model.supportedReasoningEfforts.includes("ultra") ? "\n\n极限 ultra 可能启用自动任务委派，耗时和资源开销更高。" : ""}`),
    ...rows, actionRow([button("更换模型", "show_models", "default", { wizardId, wizardMode }), button("取消", "cancel_wizard", "danger", { wizardId, wizardMode })]),
  ]);
}

export function wizardReadyCard(cwd: string, model: ModelCapability, effort: string, wizardId: string): CardDefinition {
  return card("4/4 输入任务", "green", [
    markdown(`${summary(cwd, model.slug, effort)}\n\n卡片适合简短文本。图片、长文本和自由交流请直接在聊天中发送，空任务不会创建会话。`),
    ...inputForm({ formName: "task_form", inputName: "task_prompt", elementId: "task_prompt", placeholder: "输入要交给 Codex 的任务",
      maxLength: 1000, required: true, multiline: true, rows: 4,
      buttons: [{ label: "创建会话", action: "submit_task", type: "primary", extra: { wizardId } }] }),
    actionRow([button("在聊天中输入", "await_chat_task", "default", { wizardId, wizardMode: "new" })]),
    actionRow([button("更换模型", "show_models", "default", { wizardId, wizardMode: "new" }), button("取消", "cancel_wizard", "danger", { wizardId, wizardMode: "new" }), button("返回控制台", "home")]),
  ]);
}

export function recentSessionsCard(sessions: SessionView[], search = "", page = 0, hasMore = false): CardDefinition {
  const grouped = new Map<string, SessionView[]>();
  for (const session of sessions) grouped.set(session.cwd, [...(grouped.get(session.cwd) ?? []), session]);
  let itemIndex = page * 8;
  const lines = [...grouped.entries()].flatMap(([cwd, items]) => [
    `**${safeMarkdown(basename(cwd) || "home")}**  \`${safeMarkdown(cwd)}\``,
    ...items.map((session) => {
      itemIndex += 1;
      const title = safeMarkdown(shorten(session.title || session.firstUserText, 55) || "Codex 会话");
      const time = safeMarkdown(session.startedAt.slice(0, 16).replace("T", " "));
      const config = safeMarkdown([session.model, session.reasoningEffort].filter(Boolean).join(" / ") || "继承全局配置");
      return session.rootAppLink ? `${itemIndex}. [${title}](${session.rootAppLink}) · ${time} · ${config}`
        : `${itemIndex}. ${title} · ${time} · ${config} · \`${session.sessionId.slice(0, 8)}\` · 暂不可跳转`;
    }),
  ]);
  return card("最近 Codex 会话", "indigo", [
    ...inputForm({ formName: "search_form", inputName: "session_search", elementId: "session_search", placeholder: "目录、首条消息或短会话 ID",
      maxLength: 120, buttons: [{ label: "搜索", action: "search_sessions", type: "primary", extra: { page } }] }),
    actionRow([button("清除", "recent")]),
    ...(search ? [markdown(`搜索：\`${safeMarkdown(search)}\``)] : []), markdown(lines.length ? lines.join("\n") : "尚未找到会话。"),
    actionRow([
      ...(page > 0 ? [button("上一页", "recent_page", "default", { page: page - 1, search })] : []),
      ...(hasMore ? [button("下一页", "recent_page", "default", { page: page + 1, search })] : []),
    ]),
    actionRow([button("新建会话", "new", "primary"), button("返回控制台", "home")]),
  ]);
}

export interface SessionCardPresentation {
  executionMode?: "workspace-write" | "root-danger-full-access";
  rootExecutionReady?: boolean;
  rootPreflightReasons?: string[];
  hasActiveWork?: boolean;
}

export function sessionCard(session: { cwd: string; firstUserText: string; title?: string | null; sessionId: string; model?: string | null; reasoningEffort?: string | null; collaborationMode?: string | null; lifecycle?: string | null }, status = "可继续", presentation: SessionCardPresentation = {}): CardDefinition {
  const title = shorten(session.title || session.firstUserText) || "Codex 会话";
  const plan = session.collaborationMode === "plan";
  const lifecycle = session.lifecycle ?? "active";
  if (lifecycle !== "active") status = lifecycle === "archived" ? "已归档" : lifecycle === "deleted" ? "已删除" : "创建失败，未执行";
  const mode = plan ? "Plan（只读规划）" : "Default（执行）";
  const root = presentation.executionMode === "root-danger-full-access";
  const risk = root
    ? (presentation.rootExecutionReady === false ? "Root 容器预检失败：" + ((presentation.rootPreflightReasons ?? []).join("；") || "执行已禁用") : "专用容器 Root 模式：本任务可读写容器、访问网络并启动进程；每次任务单独授权。")
    : plan ? "Plan：只读沙箱、禁止网络，不会请求 Root。" : "Default：仅允许 canonical 工作目录写入，禁止网络。";
  const controls = lifecycle === "active"
    ? [button("修改模型", "session_model", "primary", { sessionId: session.sessionId }), button(plan ? "切换 Default" : "切换 Plan", "session_toggle_mode", "default", { sessionId: session.sessionId }),
      button("查看本轮审阅", "turn_review", "default", { sessionId: session.sessionId })]
    : [button("查看本轮审阅", "turn_review", "default", { sessionId: session.sessionId })];
  const tick = "\\x60";
  return card(title, status === "运行中" ? "orange" : lifecycle === "active" ? "green" : "grey", [
    markdown("项目：" + tick + safeMarkdown(session.cwd) + tick + "\\n模型：" + tick + safeMarkdown(session.model ?? "继承全局配置") + tick + "　强度：" + tick + safeMarkdown(session.reasoningEffort ? effortLabel(session.reasoningEffort) : "默认") + tick + "\\n模式：**" + safeMarkdown(mode) + "**\\n状态：**" + safeMarkdown(status) + "**　ID：" + tick + session.sessionId.slice(0, 8) + tick),
    actionRow(controls),
    note(risk + (presentation.hasActiveWork ? " 当前有任务运行中，设置只在下一轮生效。" : "")),
  ]);
}
export function archivedSessionActionCard(nonce: string, title: string): CardDefinition {
  return card("会话已归档", "orange", [
    markdown("会话 **" + safeMarkdown(shorten(title || "Codex 会话")) + "** 已归档。原消息已保留，只有确认取消归档后才会执行。"),
    actionRow([button("取消归档并继续", "unarchive_confirm", "primary", { nonce }), button("保持归档", "unarchive_cancel", "default", { nonce })]),
  ]);
}

/** `resendTurnId`: the turn whose result did not reach Feishu; the card offers to send it again without running anything. */
export function runStatusCard(state: string, detail: string, cancellable = false, sessionId?: string, resendTurnId?: string): CardDefinition {
  const actions = [
    ...(cancellable ? [button("取消任务", "cancel_run", "danger", sessionId ? { sessionId } : {})] : []),
    ...(resendTurnId ? [button("重发结果", "resend_result", "primary", { turnId: resendTurnId })] : []),
  ];
  return card("Codex 运行状态", state === "失败" || state === "结果发送失败" || state === "取消失败" ? "red" : state === "完成" ? "green" : "orange", [
    markdown(`状态：**${safeMarkdown(state)}**\n${safeMarkdown(detail || "等待 Codex 输出")}`),
    ...(actions.length ? [actionRow(actions)] : []),
  ]);
}

export function assistantMarkdownCard(text: string): CardDefinition { return card("Codex", "blue", [markdown(text)]); }

export function errorCard(message: string): CardDefinition { return card("操作失败", "red", [markdown(safeMarkdown(message)), actionRow([button("返回控制台", "home")])]); }

/** Option buttons (or a Card 2.0 dropdown for long lists); `value` identifies the question. */
function optionControls(options: ChoiceOption[], action: string, value: Record<string, unknown>, selectId: string, selectName: string): Record<string, unknown>[] {
  if (options.length <= 3) {
    return [actionRow(options.map((option, optionIndex) =>
      button(`${optionIndex + 1}. ${shorten(option.label, 14)}`, action, optionIndex === 0 ? "primary" : "default", { ...value, optionIndex })))];
  }
  if (cardUiVersion() === 2) {
    return [{ tag: "select_static", element_id: selectId, name: selectName,
      placeholder: plain("选择一个选项"), options: options.map((option, optionIndex) => ({ text: plain(`${optionIndex + 1}. ${option.label}`), value: String(optionIndex) })),
      behaviors: [{ type: "callback", value: { action, ...value } }] }];
  }
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < options.length; index += 3) rows.push(actionRow(options.slice(index, index + 3).map((option, offset) =>
    button(`${index + offset + 1}. ${shorten(option.label, 14)}`, action, index === 0 ? "primary" : "default", { ...value, optionIndex: index + offset }))));
  return rows;
}

function questionDetails(question: ChoiceQuestion): Record<string, unknown>[] {
  const details = question.options.map((option, index) => `${index + 1}. **${safeMarkdown(option.label)}**${option.description ? `：${safeMarkdown(option.description)}` : ""}`);
  return [markdown(`**${safeMarkdown(question.header || "需要确认")}**\n\n${safeMarkdown(question.question)}`), ...(details.length ? [markdown(details.join("\n"))] : [])];
}

/** A question found in the local Codex log; the terminal may still be waiting for it. */
export function choiceCard(request: ChoiceRequest, questionIndex: number): CardDefinition {
  const question = request.questions[questionIndex];
  if (!question) return errorCard("待选问题已失效。");
  const optionRows = optionControls(question.options, "choice_answer", { requestId: request.id, sessionId: request.sessionId, questionIndex },
    `choice_${request.id}_${questionIndex}`, `choice_${questionIndex}`);
  return card(`Codex 等待你的选择 ${questionIndex + 1}/${request.questions.length}`, "orange", [...questionDetails(question), ...optionRows,
    actionRow([button("取消本次选择", "choice_cancel", "danger", { requestId: request.id, sessionId: request.sessionId })]),
    note((question.options.length ? "按钮不可用时，在本话题回复 1；也可以直接回复自定义答案。" : "请直接在本话题回复你的答案。")
      + "\n这个问题来自本机 Codex：终端还在等待时，请直接在终端回答，回答后这张卡会自动关闭；终端已关闭时，可以在这里回答，回答会作为一条新消息继续会话。")]);
}

/** A native question from a Feishu-started turn; answers return to Codex within the same turn. */
export function remoteQuestionCard(nonce: string, questions: ChoiceQuestion[], questionIndex: number): CardDefinition {
  const decline = actionRow([button("不回答", "remote_approve", "default", { nonce, decision: "decline" })]);
  const question = questions[questionIndex];
  if (!question) return card("Codex 等待你的输入", "orange", [markdown("Codex 请求输入，但没有可以显示的问题。"), decline]);
  return card(`Codex 等待你的回答 ${questionIndex + 1}/${questions.length}`, "orange", [...questionDetails(question),
    ...(question.options.length ? optionControls(question.options, "remote_answer", { nonce, questionIndex }, nextElementId("answer"), `answer_${questionIndex}`) : []),
    decline,
    note((question.options.length ? "也可以在本话题回复选项编号，或直接回复自定义答案。" : "请直接在本话题回复你的答案。") + "回答会在 Codex 当前这一轮内生效。")]);
}

export function choiceResolvedElsewhereCard(): CardDefinition { return card("问题已在其它地方处理", "grey", [note("Codex 已经收到回答或已继续对话；这张卡片不再接受回答。")]); }
export function choiceCancelledCard(): CardDefinition { return card("选择已取消", "grey", [note("本次问题已关闭；Codex 不会继续执行。")]); }
export function choiceAcceptedCard(answer: string, complete: boolean): CardDefinition { return card(complete ? "选择已提交" : "选择已记录", "green", [markdown(`你的回答：**${safeMarkdown(answer)}**`), note(complete ? "Codex 正在继续处理。" : "请继续回答下一项。")]); }

export function rootGrantCard(nonce: string, cwd: string, taskSummary: string, expiresAt: number): CardDefinition {
  return card("确认本任务的 Root 无沙箱授权", "red", [
    markdown("本次任务将在 `" + safeMarkdown(cwd) + "` 中以 **root、无 Codex 沙箱**执行。容器级风险：可读写容器中的可访问文件、启动进程；网络按容器策略提供。\n\n任务摘要：" + safeMarkdown(taskSummary) + "\n\n此授权仅能使用一次，且于 " + new Date(expiresAt).toLocaleString("zh-CN", { hour12: false }) + " 失效。"),
    actionRow([button("仅批准本任务", "root_grant_confirm", "danger", { nonce }), button("拒绝本任务", "root_grant_cancel", "default", { nonce })]),
  ]);
}

export function remoteRequestCard(request: { nonce: string; type: string; title: string; detail: string; decisions?: string[]; secret?: boolean }): CardDefinition {
  const decisions = request.decisions ?? [];
  const allowed = (value: string) => !decisions.length || decisions.includes(value);
  const buttons = [
    ...(allowed("accept") ? [button("批准一次", "remote_approve", "primary", { nonce: request.nonce, decision: "accept" })] : []),
    button("拒绝", "remote_approve", "danger", { nonce: request.nonce, decision: "decline" }),
    button("取消回合", "remote_approve", "default", { nonce: request.nonce, decision: "cancel" }),
  ];
  return card(request.title, "orange", [
    markdown(safeMarkdown(request.detail)),
    ...(request.secret ? [note("敏感内容会经过飞书平台；提交值不会被桥接器写入数据库、日志或回复。 ")] : []),
    actionRow(buttons),
    ...(request.type === "command_approval" ? [actionRow([button("告诉 Codex 怎么做", "remote_guidance", "default", { nonce: request.nonce })])] : []),
  ]);
}

export function remoteRequestResolvedCard(title: string, detail: string, success = true): CardDefinition {
  return card(title, success ? "green" : "grey", [markdown(safeMarkdown(detail))]);
}

export function reviewCard(items: Array<{ kind: string; status: string; payload: Record<string, unknown> }>): CardDefinition {
  if (!items.length) return card("本轮审阅", "grey", [markdown("Codex 未提供结构化变更、命令或测试数据。")]);
  const lines = items.slice(-24).map((item) => {
    const command = typeof item.payload.command === "string" ? `\n\`${safeMarkdown(item.payload.command)}\`` : "";
    const changes = Array.isArray(item.payload.changes) ? `\n${safeMarkdown(item.payload.changes.map(String).join("\n"))}` : "";
    const output = typeof item.payload.aggregatedOutput === "string" ? `\n${safeMarkdown(item.payload.aggregatedOutput.slice(0, 2000))}` : "";
    return `**${safeMarkdown(item.kind)}** · ${safeMarkdown(item.status)}${command}${changes}${output}`;
  });
  return card("本轮审阅", "blue", [markdown(lines.join("\n\n"))]);
}
