# 飞书 ↔ Claude Code 桥接（只读镜像）

本仓库除了 Codex 桥接，还包含一个独立的 Claude Code 桥接。它把本机 Claude Code 的会话（VS Code 扩展和终端里的都算）同步到一个飞书私密话题群，方便在手机上查看。

当前是**第一阶段：只读镜像**。飞书里可以看对话、看执行记录、收到“等待你确认”的提醒、导出完整记录，但不能从飞书发消息给 Claude。需要在手机上继续对话时，可以先在 VS Code 里输入 `/rc`（Remote Control），再用 Claude App 接续。

Claude 桥接和 Codex 桥接互不影响：各用一个飞书应用、一个私密群、一个 systemd 服务和一份配置。两者可以同时运行。

## 在飞书里看到什么

- **一个会话一个话题。** 根卡片显示标题（`/rename` 起的名字优先，其次是 Claude 自动生成的标题）、项目目录、来源（VS Code 或终端）、模型、权限模式、当前状态和最后活动时间，并给出 `claude --resume <会话 ID>` 命令。
- **一轮对话一张卡片。** 先发一条提问（例如“VS Code：修复登录页的样式”），再发一张 Claude 卡片。卡片里是 Claude 的文字回复，工具调用折叠在“执行记录”里（例如 `✓ Bash · npm test`、`✗ Edit · src/a.ts`）。进行中的卡片会随日志更新，结束后标题显示“已完成 · 用时 …”。
- **不是你输入的轮次也会显示**，并注明来源：子 agent 回报、后台任务通知、斜杠命令（如 `/model`）。
- **状态与提醒。** 根卡片上的状态来自 Claude Code 的 hooks：VS Code 或终端中“运行中”“等待你处理”“已打开（空闲）”“未在本机打开”。会话等待你确认权限时，话题里会收到一条提醒，手机上会有推送。
- **中途断掉的轮次**（会话被关掉、请求失败、没有完成记录）在本机不再运行、半小时没有新记录后显示为“未完成”。
- **长回复**：卡片只保留最后约 18,000 字，完整内容会以 Markdown 附件发到话题里。

## 历史会话

- 绑定时，最近 `HISTORY_DAYS`（默认 3）天有活动的会话会自动建话题，只显示**最后一轮**；更早的内容在话题里点“导出完整记录”或发送 `/export`，会收到一个 Markdown 文件。
- 更早的会话只建索引不建话题。在“最近会话”里搜索后点“打开”，会新建话题并显示最后一轮。
- 绑定后新开始的会话，从第一轮开始完整显示。
- 已有话题的会话出现新活动时，只追加新的轮次。

## 只同步部分目录（可选）

默认同步所有目录下的会话。只想同步某个文件夹及其子目录下的对话时，设置 `SYNC_DIRS`：

```bash
# 方式一：通过安装器（可写多个 --sync-dir；会复用已有的飞书应用和 hook）
./install-claude.sh --sync-dir ~/usr/zhangzy/workspace --sync-dir /data/projects
# 恢复同步全部目录
./install-claude.sh --sync-all

# 方式二：直接编辑环境文件，然后重启服务
#   ~/.config/feishu-claude-bridge/env 中写：SYNC_DIRS="/home/sar/usr/zhangzy/workspace,/data/projects"
systemctl --user restart feishu-claude-bridge.service
```

- 判断依据是会话的工作目录（Claude Code 日志里记录的 `cwd`，即在 VS Code 中打开的文件夹或启动 `claude` 时所在的目录），不是 `~/.claude/projects` 下的文件夹名。路径支持 `~/` 开头，符号链接会解析成真实路径。
- 范围外的会话不建话题、不发卡片、不发提醒，也不出现在“最近会话”和搜索结果里。桥接仍会在本机读取它们的日志，只为了判断工作目录。
- **话题的先后始终等于会话实际活动的先后。** 飞书只能在群里追加消息，不能插到过去的位置，所以桥接只在会话有新的一轮时才建话题（第一次绑定时按时间从早到晚建）。
- **范围扩大**：不为过去的活动补建话题。新纳入范围的会话会出现在“最近会话”里，需要时可以点“打开”；它下一次有新的一轮时，自动建话题，只显示这一轮及之后的内容。
- **范围缩小**：范围外的话题保留在群里，根卡片变灰并写明“已移出同步范围，不再更新”。范围再改回来时，根卡片恢复，之后的新内容继续追加到原话题里，不会重复建话题；范围外期间的对话不会补发。
- **清理范围外话题**：控制台（`/status`）在有范围外话题时会出现“清理范围外话题（N）”按钮。点击后先列出要清理的话题，确认后才撤回机器人在这些话题里发过的消息（根卡片、提问、回复卡片、附件、提醒）。你自己发的消息机器人无法撤回。飞书只允许机器人撤回企业“撤回时限”内的消息，**默认是发出后 24 小时**，企业管理员可以在管理后台把时限调长（最长可设为“任何时候”）；超过时限的消息撤不掉，结果卡片会逐条列出原因。根卡片撤不掉的话题会继续保留关联，范围恢复后仍在原话题里更新。
- 控制台会显示当前的同步范围。

## 安装

前提：带 systemd 的 Linux（WSL2 可以，需要启用 systemd）、Node.js 22 及以上、能在终端运行的 `claude` 命令。

```bash
./install-claude.sh
```

安装器会依次：安装依赖并运行检查、测试和构建；显示飞书验证链接，确认后为你创建一个独立的“Claude Bridge”企业自建应用（不能与 Codex 桥接共用同一个应用）；写入权限为 `0600` 的 `~/.config/feishu-claude-bridge/env`；在 `~/.claude/settings.json` 中加入状态 hook（先备份原文件为 `settings.json.bak-<时间>`）；创建并启动用户服务 `feishu-claude-bridge.service`；最后运行自检。

常用选项：

- `--existing-app <cli_xxx>`：复用已有的飞书应用（用应用所有者账号扫码）。
- `--from-env`：使用手工填写的 `~/.config/feishu-claude-bridge/env`（参照 `deploy/env.claude.example`），不修改飞书后台。
- `--sync-dir <目录>`、`--sync-all`：设置或清除同步范围，见上一节。
- `--no-hooks`：不修改 `~/.claude/settings.json`。这时根卡片上没有实时状态，也收不到“等待你处理”的提醒，对话内容照常同步。

安装完成后，在飞书创建一个私密话题群，把新机器人加进群，发送：

```text
@机器人 /bind <安装器显示的绑定码>
```

## 状态 hook 做了什么

安装器在 `~/.claude/settings.json` 的 `SessionStart`、`UserPromptSubmit`、`Stop`、`StopFailure`、`Notification`、`SessionEnd` 事件上各加一条命令，调用 `scripts/claude-hook.mjs`。它只把会话的状态（运行中、等待、空闲、关闭）、等待原因和 Claude Code 进程号写到 `~/.local/state/feishu-claude-bridge/presence/<会话 ID>.json`，不联网、不输出任何内容、出错也不影响 Claude Code，每次耗时约 20 毫秒。VS Code 扩展里的会话同样会触发这些用户级 hook。

Claude Code 没有“权限请求已处理”的 hook 事件，所以你在本机批准后，桥接是根据会话日志里出现的新记录判断会话已恢复运行的。

移除这些 hook：

```bash
npm run uninstall:claude-hooks
```

## 群里的命令

群主消息（普通消息需要 @机器人，斜杠命令不需要）：

- `/`：命令菜单；`/help`、`帮助`：帮助。
- `/status`、`状态`：控制台（服务状态、已索引会话数、已建话题数、本机打开中的会话数）。
- `/sessions`、`会话`、`最近`：最近会话；`/search <关键词>`：按标题、首条消息、目录或会话 ID 搜索，多个关键词同时匹配。
- `/sync`、`同步`：立即扫描；`/pause`、`暂停` 与 `/resume-sync`、`恢复`：暂停或恢复同步。

会话话题里：`/export` 导出完整记录。其它消息不会发给 Claude，机器人会提示如何继续这个会话（每个话题十分钟内最多提示一次）。中文快捷词只在群主消息中生效。

## 同步哪些内容

发送到飞书的只有：你的提问（去掉 IDE 自动附加的打开文件、选中内容等上下文）、Claude 的文字回复、工具调用的一行摘要（命令的第一行、文件路径、搜索关键词等）及其成功或失败。不发送 thinking、工具的完整输出、子 agent 的过程和原始 JSONL。

## 运维

```bash
npm run doctor:claude                                   # 只读自检
systemctl --user status feishu-claude-bridge.service
journalctl --user -u feishu-claude-bridge.service --since today
```

- 状态数据库：`~/.local/state/feishu-claude-bridge/bridge.sqlite`。
- WSL 需要保持运行；systemd 用户服务在没有登录会话时会停止，可以执行 `sudo loginctl enable-linger $USER` 让它常驻。
- 会话日志格式属于 Claude Code 内部实现，会随版本变化。解析器对未知记录一律忽略；升级 Claude Code 后如发现显示异常，先运行测试，再检查 `src/claude/transcript.ts`。

## 实现位置

| 模块 | 作用 |
| --- | --- |
| `src/claude/transcript.ts` | 读取会话日志的每一行，转成提问、文字、工具调用、轮次结束等事件 |
| `src/claude/conversation.ts` | 把事件归并成“轮次”，重复读取同一段日志结果不变 |
| `src/claude/importer.ts` | 监听 `~/.claude/projects`，按游标增量读取 |
| `src/claude/presence.ts` | 读取 hook 写入的状态文件，检查 Claude Code 进程是否还在 |
| `src/claude/db.ts` | 会话索引、游标、已发送的卡片、飞书事件去重 |
| `src/claude/cards.ts` | 根卡片、轮次卡片、控制台和导出的 Markdown |
| `src/claude/runtime.ts` | 串起导入、渲染、状态和飞书消息处理 |
