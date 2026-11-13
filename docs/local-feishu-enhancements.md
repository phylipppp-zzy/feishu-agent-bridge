# 飞书本地增强说明

状态：代码已在本地隔离 worktree 集成，离线检查通过；尚未部署、未改用户级 Claude settings，未连接真实 Feishu，也未运行真实 Claude CLI/IPC 审批。源文件和文档会作为可审查 patch 交负责人；最后测试计数以负责人合并 render fallback 修复后的结果为准。

## 正文里的本机文件链接

turn 卡保留原始 Markdown href，并在卡片末尾提供逐文件“发送文件”回调按钮。原 href 本身不是飞书原生文件链接。首次点击后，文件作为当前会话话题中的消息发送；发送成功后，同一 turn 卡完整更新为该文件消息的 Feishu app link，正文和其它文件入口保留。相同 label 的不同 href 按原始 href 分开绑定。支持普通相对路径、`./`、`../`、根相对路径及 `file://`；拒绝带 http/mail 等 scheme 的链接；支持 `:12` 和 `#L12-L14` 行号后缀。

每次点击先确认绑定操作者/群、源 turn 卡和会话目标，再按既有 allowRoot 与凭据过滤检查文件。渲染阶段只做路径筛选/stat，不读文件正文；点击后才读入 buffer。映射跨 runtime 重启保留；源文件删除后已发送 href 仍可跳转旧文件消息。版本指纹使用大小、mtime、inode；发送 buffer 的 SHA-256 也会落库。若内容被原地替换且大小、mtime、inode 均不变，点击阶段的 metadata 版本检查不能识别这次变化。

Feishu 文件发送使用稳定 UUID，但已知 SDK 幂等窗口约一小时。如果服务端已接受消息、客户端却在保存 message ID 前崩溃，窗口之后仍可能重复发送。未进行真实文件发送或 Feishu app link 验证。

## A：多轮积压汇总

当前 runtime 仅把至少 **10 条未显示、已结束**的 pending turns 归档为一张汇总卡和完整 Markdown 附件。附件使用完整 `turnMarkdown`，含用户 prompt、助手正文和已有工具摘要。普通轮次少于 10 条时仍逐轮显示；已有 turn 卡的后续更新不被归档；running/审批中的回合保持单独显示。

成员归档及 card/file message ID 分别持久化。附件发送失败后可从缺少步骤重试，不重复已持久化的摘要卡。Feishu 已接受消息但客户端在 ID 落库前崩溃仍有不确定窗口；卡片/附件稳定 UUID 受服务端幂等窗口限制。

## C：运行中进程空闲回收

主回合或后台任务忙时 runner 保持打开。已知空闲后默认 10 分钟回收；后台状态未知时保守等待 2 小时。旧环境变量 `RUNNER_IDLE_MS` 继续作为已知空闲间隔的兼容自定义值，unknown 状态仍为 2 小时。idle timer 触发时会再次验证 runner 身份、忙闲状态和等待审批状态。

## 提醒订阅

`REMINDER_SUBSCRIPTION_ENABLED` 默认关闭。启用后，明确的 waiting/StopFailure 提醒发到同群独立订阅话题；普通会话消息仍在原话题。订阅 root 按群持久记录，并有进程内并发创建保护。订阅发送失败会尝试源话题 fallback；任一目的地成功才记为已发送/已通知。订阅与 fallback 都失败时写入 `permanent_failed` 和错误证据，不标为已通知，不会无限自动重试。重放同一事件不会继续刷屏。

目前没有用户命令/UI 可重试 permanent_failed 单事件。需要人工重试时，先停止服务并备份 state DB，再由熟悉 SQLite 的维护者按 `session_id` 与 `reminder_id` 精确更新 `reminder_deliveries` 对应单行的 `status='failed', attempt_count=0`，然后等待同一 hook event 重放；不要清空整表。下一次 claim 会清除旧 error 字段，因此应先保存失败记录。未来可加入显式单事件重试入口。

绑定启动时若可选订阅 root 创建失败，只记本地错误并继续普通会话同步；后续提醒会再次尝试建订阅 root，失败时回退到会话话题。

## E/F：权限审批与 IPC 开关

桥内既有 `SessionRunner` 普通 `CanUseTool` 审批仍使用现有 `InteractionRegistry` 卡片流程；它不依赖外部 IPC listener 开关。外部 Claude 会话通过本地 `PermissionRequest` IPC listener 的请求接入独立 `RemotePermissionApprovals` 状态机。该 listener 配置 `PERMISSION_HOOK_ENABLED` 默认关闭；不开启时，普通桥内审批仍按现有路径工作，外部 IPC hook 不会启动。

新状态机对低风险输入单步允许/拒绝；高风险和 unknown 先展示完整核对内容，第二张新 nonce 卡才允许最终批准。旧 nonce、身份/群/卡片/request/digest 不匹配、重放、超时、abort、会话取消和服务停止均拒绝。工具输入过长而无法完整展示，或包含不能安全展示的隐藏敏感值时，拒绝手机审批。分类器只用于保守交互确认，不是执行沙箱。

IPC handler 只接受已索引、绑定当前群且处于同步范围的会话；cwd 必须匹配已知 session cwd。不会通过请求中的 `transcript_path` 打开任意文件。权限 hook listener 与真实 Claude CLI 的集成没有实际启用或验证。

### H：用户自行安装 settings hook

仓库只准备了可审查/可撤销的 settings helper 和 CLI；不表示用户 settings 已修改。只有用户自行选择目标 settings 和 state 绝对路径后，才手动运行 helper。`--apply` 会写文件，须由用户本人决定是否执行；`--remove --apply` 用于用户批准后的撤销。模板会注册 PermissionRequest command hook；未启用 `PERMISSION_HOOK_ENABLED` 的 bridge 无法处理它，CLI 将 fail closed。

### B：Stop / asyncRewake 实验边界

当前 `remote-hooks-plan.ts` 中的 Stop schema 只是 fixture。手动 settings helper **不会**注册 Stop hook。实际 Claude CLI 是否接受 `asyncRewake`、何时唤醒、如何区分无任务与查询失败、消息来源和重复 Stop/后台任务行为均未在目标 CLI 环境验证。未完成独立受控实验前不得安装候选 Stop hook，也不能宣称异步 Stop 投递可用。H 的 PermissionRequest 安装和 B 的 Stop/asyncRewake 实验是两件事。

## 本地验收与建议部署审查

已完成的本地验证使用临时 SQLite、临时文件及 mock Feishu/runner；未改用户 settings、未发真实消息、未运行真实 CLI。当前报告记载 `npm run check` 通过，所选离线测试在 render fallback UTF-8 边界修复合并前为 96/96；最终计数请以负责人重新执行的合并后结果更新。无 GPU 或明显压力测试，也无真实 Feishu 或 CLI 行为验证。

建议后续审查部署按此顺序进行：

1. 审阅源码/documentation diff、配置默认值、migration、权限范围和测试结果；先做本地 review 与离线 check/test。
2. 在临时 settings/state 目录审阅 helper 的 preview、备份和 remove 演练；确认模板仅注册所需事件与目标脚本路径。
3. 明确用户要启用的功能、真实 settings 文件/state 目录、维护窗口及回滚责任；外部 listener 默认保持关闭。
4. 用户自行备份并决定是否应用 settings；停止/启动服务、实际启用 listener 和真实 Feishu/CLI 验证均由用户批准后执行。
5. 先用无敏感、无计费的受控样例验证成功/拒绝/超时/回滚，再决定是否扩大范围；保存 logs 与结果，确保随时可撤销。

本轮没有部署、改用户 settings、构建或写原仓库 `dist`、重启服务、推送代码或向外发送消息。
