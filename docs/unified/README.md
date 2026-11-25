# 飞书统一桥接器（Unified v2：三后端 + 任务话题 + 看守/待处理汇总）交付与运维文档

> 目标代码基线：分支 `codex/feishu-unified-v2-agy`（`src/unified/`）。  
> 本文档面向日常使用与部署维护者，仅记录仓库当前已实现并经过验证的行为与配置。

---

## 1. 整体架构与设计边界

Unified v2 在原有 **Codex + Claude** 双后端统一架构基础上，新增 **Antigravity (`agy`)** 第三后端、**T0/T1/T2 同任务话题多后端协作与交接**、以及默认关闭的 **N1 看守汇总 / N2 待处理汇总 / D1 决策同步**。

```text
                       飞书 WebSocket 长连接 (FeishuSdkPort, sdk.sqlite)
                        ├─ 传统会话/话题路由 ──────────────────► FeishuChannel (channel.sqlite)
                        ├─ T0/T1/T2 任务话题 (opt-in) ────────► TaskTopicChannel + TaskHandoffService (共置 channel.sqlite)
                        ├─ N1 固定看守提醒话题 (opt-in) ──────► WatchHub (watch-hub.sqlite)
                        └─ N2 固定待处理汇总话题 (opt-in) ────► PendingHub (pending-hub.sqlite) ◄── D1 DecisionSyncStore (decision-sync.sqlite)
                                                                      │
                                                                      ▼
                                               UnifiedCore + UnifiedStore (core.sqlite)
                                            (单权威状态机、CAS 控制代次、幂等/Outbox、ArtifactRegistry)
                                     ┌────────────────────────┼────────────────────────┐
                                     ▼                        ▼                        ▼
                              ClaudeAdapter            CodexAdapter               AgyAdapter
                       (Claude Agent SDK +       (codex app-server         (agy acp --stdio +
                        ClaudeState +             --stdio WS/Proxy +        AgyCatalog summaries.db/brain +
                        LocalCatalog)             LocalCatalog)             AgyQuotaClient /usage)
```

### 核心安全与隔离红线

1. **单飞书所有者与目的地白名单**：所有入站消息、卡片回调、任务话题操作、看守与待处理动作都只认 `ownerOpenId` 与 `allowedDestinations`（以及经由合法路由登记的子话题）。
2. **核心状态机单权威**：控制权代次（`controlGeneration`）、连接代次（`connectionGeneration`）、审批/问答状态（`Interaction`）仅由 `UnifiedCore`（以及 `D1` 的 `DecisionSyncStore`）持久化裁决；任何通道视图只持有轻量引用，不复制第二套状态机。
3. **默认关闭（Opt-in）与故障隔离**：
   - `agy` 未配置或 `enabled: false` 时，不拉起 ACP 子进程、不查询 `/usage`、`/health` 不输出 `agy_*` 分层。
   - `taskTopic`、`watchHub`、`pendingHub`、`decisionSync` 省略或 `enabled: false` 时，零额外 SQLite 连接、零额外消息投递，100% 保持既有双后端/三后端行为。
   - 单个后端断连、超时或限流仅令该后端对应健康组件降级，不阻塞其余后端与飞书主通道。
4. **不重放不确定投递（Unknown-never-replay）**：飞书建卡、文件发送、模型输入、交接提交遇到超时或回执未知时均保留 `unknown` 诊断并要求先核对（`reconcile` / `lookupDelivery`），绝不盲目重发。

---

## 2. 三后端能力边界矩阵（`R01–R18`）

| 编号 | 能力项 | Claude (`claude`) | Codex (`codex`) | Antigravity (`agy`) | 说明与限制 |
| --- | --- | --- | --- | --- | --- |
| **R01** | 会话发现与列表 (`/sessions`, `/list`) | 支持（SDK + `LocalCatalog`） | 支持（`thread/list` + `LocalCatalog`） | 支持（`AgyCatalog` 读 `conversation_summaries.db` + `brain/`） | `agy` 子代理（`nesting_depth > 0` / 有父会话）不作为独立会话暴露 |
| **R02** | 接入已有会话 (`/bind`, `/attach`, `/upgrade`) | 仅桥内自建（`ClaudeState` 记录）可 `interactive`；外部 CLI 仅 `read_only` | 支持 `read_only` 与 `interactive`（`thread/resume`） | 支持 `read_only` 与 `interactive`（`session/load`） | 外部只读话题点击控制面板可触发 `/upgrade`（在允许范围内） |
| **R03** | 创建新会话 (`/create <provider> <cwd> [model]`) | 支持（SDK `query()`） | 支持（`thread/start`） | 支持（ACP `session/new`） | `cwd` 必须通过 `realpath` 且位于 `allowedProjectRoots` 内 |
| **R04** | 提交输入与排队 (正文 / `/queue`) | `new` 支持；`queue` 由 Core 协调 | `new` 支持；原生 `queue` + Core 协调 | `new` 支持；`queue` 由 Core 协调 | 本轮未结束时普通正文不会直接覆盖当前轮 |
| **R05** | 历史记录与导出 (`/history`, `/export`) | 支持（SDK 历史 + `HistoryArchive`） | 支持（`thread/read` + `HistoryArchive`） | 支持（`transcript.jsonl` / `transcript_full.jsonl`） | `agy` 自动剥离宿主注入标签（如 `<SYSTEM_MESSAGE>`）；`/export` 双读一致性校验 |
| **R06** | 问答与工具审批识别 | 支持（`AskUserQuestion`、`CanUseTool`） | 支持（`requestUserInput`、命令/文件审批） | 支持（`elicitation/create`、`session/request_permission`） | 外部只读终端会话的待处理项在源话题只展示只读提示 |
| **R07** | 问答与审批回传（卡片按钮 / 结构化表单） | 仅桥内交互会话支持 | 支持 | 支持 | 严格校验 `revision`、`connectionGeneration`、`toolInputDigest` 与表单 `bindingId` |
| **R08** | 原生控制权切入/释放 (`/control`) | `unsupported` | 支持（`acquire` / `release`） | `handoff: unsupported`（`control('release')` 仅用于释放 ACP 会话） | 跨后端交接请使用 T2 显式结构化交接，不依赖原生终端接管 |
| **R09** | 中断当前回复与残留核对 (`/stop`) | 支持中断；支持进程内 `ClaudeResidualObservation` | 支持中断；支持 `thread/backgroundTerminals/list` 残留核对 | 支持中断（`session/cancel`）；支持活跃 tool call 残留核对 | 断连或无完整连接归属时保守返回 `unknown`，不谎报“已彻底终止” |
| **R10** | 快照与增量事件订阅 | 支持（Core 统一游标与快照） | 支持（Core 统一游标与快照） | 支持（Core 统一游标与快照） | 游标过期自动走 `snapshot_required` 对齐并补发未见终态 |
| **R11** | 运行中同回合追加引导 (`/steer`) | `unsupported` | **唯一支持**（单运行轮捕获 `turnId` + 双代次） | `unsupported` | 切目标、换轮或重连后自动失效；仅 Codex 可用 |
| **R12** | 产物列表、安全读取与文件发送 (`/files`, `/ls`, `/deliver`) | 依赖 `EnrichedPort` 项目文件与输出链接注册 | 依赖 `EnrichedPort` 项目文件与输出链接注册 | **原生支持** `brain/<convId>/` 白名单产物 + `EnrichedPort` 项目文件 | 同名多版本文件按钮自动带 `(<contentVersion 前8位>)`；排除 `.system_generated/` 与敏感文件/越界软链 |
| **R13** | 入站图片与纯文本附件 | 支持 PNG/JPEG/GIF/WebP 与 UTF-8 `.txt` | 支持 PNG/JPEG/GIF/WebP 与 UTF-8 `.txt` | 支持 PNG/JPEG/GIF/WebP 与 UTF-8 `.txt`（单附件上限 10 MiB） | 先持久化凭证再下载；校验 Magic Bytes 与 UTF-8 无 NUL |
| **R14** | 模型列表与思考强度切换 (`/models`, `/model`) | 支持模型与 `reasoningEffort` | 支持（`model/list` + 思考强度） | 支持（ACP 返回模型或默认模型目录 + `session/set_model` / `thought_level`） | `agy` 自动剥离 `-xhigh` 等后缀并拆分传递 `reasoningEffort` |
| **R15** | 归档与飞书通知偏好 (`/archive`, 面板通知开关) | `archive` `unsupported`；飞书通知偏好支持 | 支持 `thread/archive` 与通知偏好 | `archive` `unsupported`；飞书通知偏好支持 | 通知偏好细分为完成/等待/失败与全局暂停 |
| **R16** | 未知结果核对与候选排查 (`/reconcile`, `/finish`, `/pending`, `/candidates`) | 支持 `/reconcile`、`/finish`、`/pending` | 支持以上全部 + `/candidates`（`thread/loaded/list` 元数据只读核对） | 支持 `/reconcile`、`/finish`、`/pending` | 候选展示明确标明“历史未验证”，不会自动认领创建结果 |
| **R17** | 自动镜像与只读历史基线 (`autoMirror`) | 支持（独立 `channel_auto_claude_scope_watermarks` + 主会话证明） | 支持（独立 `channel_auto_scope_watermarks`） | 支持（独立 `channel_auto_agy_scope_watermarks`，屏蔽子代理） | 各后端独立 watermark；仅证明为启动后新建且非未来时间戳的会话才自动增量同步 |
| **R18** | 健康诊断分层 (`/health`) | `claude_connection`、`claude_run`、`claude_quota` | `codex_connection`、`codex_run` | `agy_connection`、`agy_run`、`agy_quota`（仅启用 `agy` 时显示） | 与 `core`、`runtime`、`feishu_*`、`interaction_return` 统一聚合展示 |

### v2 新增可选扩展模块对照（默认全部关闭）

| 模块 | 开关字段 | 持久化位置 | 核心职责与边界 |
| --- | --- | --- | --- |
| **T0/T1** 任务话题与多后端挂载 | `runtime.taskTopic.enabled` | `sdk.sqlite` (`sdk_task_*`) + `channel.sqlite` (`task_*`) | 单一任务话题可同时挂载 `claude` / `codex` / `agy`；显式 `activeTarget` CAS 切换、入站目标锁定、按目标隔离游标与流式卡片、跨目标交互路由 |
| **T2** 跨后端显式交接 | `runtime.taskTopic.enabled` | `channel.sqlite` (`task_handoffs_v1`) | 零 LLM、零隐式历史复制、零工具授权转移；`preview`（0 模型写入）→ 编辑 → `confirm`（CAS 单次提交摘要、约束、目标 `cwd` 与受控文件引用） |
| **N1** 看守与运行提醒汇总 | `runtime.watchHub.enabled` | 独立 `watch-hub.sqlite`（默认与 `channelDb` 同目录） | 单一固定「看守与运行提醒」话题；仅允许 6 个受控源（`watch`, `stopwatch`, `claude_waiting`, `claude_stop_failure`, `codex_status`, `agy_status`），拒绝普通周报；异常→恢复更新原卡 |
| **N2** 待处理统一汇总 | `runtime.pendingHub.enabled` | 独立 `pending-hub.sqlite`（默认与 `channelDb` 同目录） | 单一固定「待处理」话题聚合 4 类项（模型问答、工具权限、业务决定、执行授权）；源话题 / Hub / 原终端三方单胜者并发竞争，处理后双卡同步撤下；普通聊天文本绝不批准任何请求 |
| **D1** 业务决定与执行授权同步 | `runtime.decisionSync.enabled` | 独立 `decision-sync.sqlite` | 默认空基线（不导入旧文档）；`protectedReadOnlyPaths` 写保护；`business_decision`（选「准备方案」0 执行器调用）严格隔离于 `execution_auth`（一次性摘要绑定）；追加式不可变账本；锚定区更新与冲突保护 |

---

## 3. 配置示例与无痛回滚

统一运行入口为 `scripts/unified-start.mjs`（要求配置文件权限为 `0600`、属主为当前用户，且顶级字段仅允许 `sdkDb` 与 `runtime`；飞书凭据通过环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 注入）。

### 3.1 `config.json` 完整配置示例（含 `agy` 与可选模块）

> 若仅需先启用 `agy` 而不开启新话题/汇总视图，保持 `taskTopic`、`watchHub`、`pendingHub`、`decisionSync` 省略或设为 `"enabled": false` 即可。

```json
{
  "sdkDb": "/home/<user>/.local/share/feishu-unified-bridge/state/sdk.sqlite",
  "runtime": {
    "coreDb": "/home/<user>/.local/share/feishu-unified-bridge/state/core.sqlite",
    "channelDb": "/home/<user>/.local/share/feishu-unified-bridge/state/channel.sqlite",
    "artifactStatePath": "/home/<user>/.local/share/feishu-unified-bridge/state/artifacts.json",
    "ownerOpenId": "ou_xxxxxxxxxxxxxxxxxxxxxxxx",
    "allowedDestinations": ["oc_xxxxxxxxxxxxxxxxxxxxxxxx"],
    "hostId": "local-host",
    "claudeServiceId": "claude-sdk",
    "codexServiceId": "codex-app-server",
    "claudeStateDir": "/home/<user>/.local/share/feishu-unified-bridge/state/claude",
    "codexEndpoint": "codex-proxy://default",
    "intervalMs": 1500,
    "allowedProjectRoots": ["/home/<user>/workspace"],
    "outputRoots": ["/home/<user>/workspace"],
    "catalogSources": [
      {
        "provider": "claude",
        "hostId": "local-host",
        "serviceId": "claude-sdk",
        "directory": "/home/<user>/.claude/projects"
      },
      {
        "provider": "codex",
        "hostId": "local-host",
        "serviceId": "codex-app-server",
        "directory": "/home/<user>/.codex/sessions"
      }
    ],
    "autoMirror": {
      "enabled": true,
      "destination": "oc_xxxxxxxxxxxxxxxxxxxxxxxx"
    },
    "agy": {
      "enabled": true,
      "serviceId": "agy-acp",
      "binPath": "/home/<user>/.gemini/bin/agy",
      "summariesDbPath": "/home/<user>/.gemini/antigravity/conversation_summaries.db",
      "brainDir": "/home/<user>/.gemini/antigravity-cli/brain",
      "quotaCachePath": "/home/<user>/.local/share/feishu-unified-bridge/state/agy-quota.json",
      "sandbox": false
    },
    "taskTopic": {
      "enabled": false
    },
    "watchHub": {
      "enabled": false,
      "destination": "oc_xxxxxxxxxxxxxxxxxxxxxxxx",
      "dbPath": "/home/<user>/.local/share/feishu-unified-bridge/state/watch-hub.sqlite"
    },
    "pendingHub": {
      "enabled": false,
      "destination": "oc_xxxxxxxxxxxxxxxxxxxxxxxx",
      "dbPath": "/home/<user>/.local/share/feishu-unified-bridge/state/pending-hub.sqlite"
    },
    "decisionSync": {
      "enabled": false,
      "dbPath": "/home/<user>/.local/share/feishu-unified-bridge/state/decision-sync.sqlite",
      "markdownPath": "/home/<user>/research/decisions-view.md",
      "protectedReadOnlyPaths": [
        "/home/<user>/待你决定.md"
      ]
    }
  }
}
```

#### 配置校验规则（`validateRuntimeConfig`）

- 所有文件路径（`agy.*` 中的路径、`watchHub.dbPath`、`pendingHub.dbPath`、`decisionSync.dbPath`、`decisionSync.markdownPath`、`decisionSync.protectedReadOnlyPaths[]`）**必须为绝对路径**。
- `watchHub.enabled = true` 与 `pendingHub.enabled = true` 时，各自的 `destination` **必须包含在 `allowedDestinations` 内**。
- 启用中的各持久化文件（`coreDb`、`channelDb`、`artifactStatePath`、`sdkDb`、`agy.quotaCachePath`、`watchHub.dbPath`、`pendingHub.dbPath`、`decisionSync.dbPath`）**路径必须互不相同**（`taskChannel` 与 `taskHandoff` 设计上安全共置于 `channelDb` 内，无需额外 DB 路径）。

### 3.2 无痛回滚说明

#### 方式一：配置级软回滚（推荐首选，零停机风险）

只需将 `config.json` 中对应段的 `"enabled"` 改为 `false`（或删除对应配置段）并重启服务：
1. 关闭 `agy`（`agy.enabled: false`）：停止拉起 `agy acp --stdio` 与额度查询，`/health` 自动去掉 `agy_*` 分层，现有 `claude` / `codex` 会话绑定与历史毫发无损。
2. 关闭 `taskTopic` / `watchHub` / `pendingHub` / `decisionSync`（`enabled: false`）：主群与既有单会话话题立即恢复原有纯双/三后端运行模式，已落盘的 `task_*`、`watch-hub.sqlite`、`pending-hub.sqlite`、`decision-sync.sqlite` 保留在磁盘上不被破坏。

#### 方式二：二进制版本回滚到已封存基线（`0090d1a`）

若需将整套运行代码回退至上一代已封存基线 `0090d1a`：
1. 先按方式一停用新增开关或直接切换 release 软链回到 `0090d1a` 并重启。
2. **数据与隔离保障（已通过离线回归测试验证）**：
   - `0090d1a` 的 `FeishuSdkPort` 守卫继续正常路由主群与旧版会话话题，同时自动拦截发往已创建 `task` 根话题的消息与回调，不会把任务话题当成测试线也不会污染主群绑定。
   - `0090d1a` 的 `FeishuChannel` 仅读取 `channel_*` 表，完全忽略同库中新增的 `task_*` 表和 `channel_auto_agy_scope_watermarks` 表；旧版生产会话绑定、游标与历史不受任何影响。
   - 后续重新升级回 Unified v2 时，既有任务绑定、交接草稿、待处理映射与决策账本均可原样恢复。

---

## 4. 一次集中手机真机验收清单（`U01–U08`）

建议在独立测试群或维护窗口内按顺序一次完成以下 8 项手机端飞书真机验收；每项均有明确的成功标准与防误触检查点。

| 验收项 | 覆盖模块 | 手机端操作步骤 | 预期结果与通过标准 |
| --- | --- | --- | --- |
| **U01** | 三后端共存与 `/health` | 在群内发送 `/health`、`/sessions`、`/new`。 | `/health` 清晰显示 `Claude`、`Codex`、`Antigravity` 三套分层状态；`/sessions` 与 `/new` 均含「Antigravity」筛选按钮；刻意断开某个后端时仅该后端状态降级，其余两个仍正常列表与响应。 |
| **U02** | `agy` 新建、对话、切换模型与中断 | 发送 `/create agy <允许的项目目录>`；在新话题发一条普通任务；发送 `/model` 切换模型与思考强度；触发问答/工具审批并点击卡片按钮；在长输出中途发送 `/stop`。 | 仅建一个新话题；回复卡标题/正文前缀清晰标示 `Antigravity`；`/model` 下轮生效；权限卡支持批准/拒绝并回传 ACP；`/stop` 返回本轮中断与残留核对状态。 |
| **U03** | `agy` 自动镜像与子代理屏蔽 | 在终端用 `agy` 启动一个新顶层会话，并在其中触发至少 1 个子代理（`nesting_depth > 0`），然后等待轮询同步。 | 飞书仅自动镜像 **1** 个顶层只读话题（如标题附带子代理计数提示），绝不给子代理单独建话题；既有的历史旧会话不会被反复刷屏推送。 |
| **U04** | 双版本文件 `R12` 消歧与发送定位 | 在同一会话（如 `agy` 的 `brain` 目录或项目目录）生成同名文件的 v1、v2 两个不同内容版本；发送 `/files`。 | 卡片正文列出两个完整版本哈希，按钮标题分别为 `<文件名> (<v1前8位>)` 与 `<文件名> (<v2前8位>)`（单版本文件保持原名）；分别点击两个按钮，飞书依次收到不同内容的文件；再次点击已发送过的版本按钮，不再重复上传，而是返回「定位原文件消息」跳转链接；`.system_generated/` 与 `.env` 均不可见不可发送。 |
| **U05** | `T1` 同话题多后端挂载与输入防串台 | 开启 `taskTopic.enabled`：在同一任务话题同时挂载 `claude`（活跃）、`codex`、`agy`；先向 `claude` 发送消息，随后通过面板切换到 `agy` 并立即向 `agy` 发消息；尝试对 `read_only` 目标点写操作。 | 同一轮次下各后端流式卡片独立更新、不互相覆盖；切换前后在途消息严格锁定入站时捕获的目标，绝不串给新目标；只读目标点击批准/输入被明确拒绝；切回 `codex` 时 `/steer` 可用，在 `claude`/`agy` 时明确提示不支持。 |
| **U06** | `T2` 跨后端零 LLM 显式交接 | 在任务话题发起 `codex → agy` 交接预览卡片，检查正文后点击「确认交接到 Antigravity」；随后再重复点击同一张确认按钮一次；另测一次预览后先切换活跃目标再点旧预览卡。 | 预览阶段 `agy` 收到 **0** 次输入；预览卡显式列出目标 `cwd`、摘要、约束、引用文件，且声明“不复制全量历史、不继承工具权限”；首次点击确认后仅 `agy` 收到 1 条结构化交接信息（`codex` 收到 0 条）；重复点击幂等不重发；目标切换后旧预览卡被拒绝。 |
| **U07** | `N1` 看守与运行提醒固定话题 | 开启 `watchHub`：通过看守脚本或受控测试注入一条 `watch`/`agy_status` 告警，随后再注入同 `objectId` 恢复事件；再尝试用非白名单源（如 `weekly_report`）写入。 | 群内只建立 **1** 个「看守与运行提醒」根话题；恢复事件直接更新原告警卡片为「已恢复」，不新增刷屏卡片；点击卡片「返回任务话题」可直达源话题；普通周报被拒绝，绝不混入看守话题。 |
| **U08** | `N2` 待处理汇总与 `D1` 决策同步 | 开启 `pendingHub` + `decisionSync`（配置 `markdownPath` 与 `protectedReadOnlyPaths: [待你决定.md]`）：同时造出 1 个模型问答/工具审批、1 个 `business_decision`（「准备方案」）、1 个 `execution_auth`；在「待处理」汇总直接发文本「同意」；然后通过点击汇总按钮提交审批与业务决定；最后在原终端确认另一个待处理项。 | 「待处理」汇总正确统计 4 类计数并显示后端分布；在汇总发文本「同意」不会批准任何项；点击按钮批准后，**汇总与源话题两处卡片同时失效撤下**，且「准备方案」触发 **0** 次执行器调用；原终端处理后两处卡片同样同步撤下；`待你决定.md` 字节级零改动，`markdownPath` 仅在 `<!-- DECISION_SYNC_START/END -->` 锚点内写入答复，锚点外人工内容完整保留。 |

---

## 5. 维护者常用本地检查命令

在目标工作区运行以下命令进行构建与离线回归校验（均不连接真实飞书与线上服务）：

```bash
# 1. TypeScript 类型检查与构建
npm run check && npm run build

# 2. 定向运行三后端、R12、T0/T1/T2、N1/N2/D1 与统一装配测试
node --import tsx --test \
  test/unified-agy-adapter.test.ts \
  test/unified-runtime-v2-wiring.test.ts \
  test/unified-pending-hub.test.ts \
  test/unified-watch-hub.test.ts \
  test/unified-decision-sync.test.ts \
  test/unified-task-topic-t1.test.ts \
  test/unified-task-handoff-t2.test.ts

# 3. 带 0090d1a 回滚守卫的离线全套（需本地存在 sealed 0090d1a 目录）
TASK_GUARD_RELEASE="$HOME/tmp/feishu-0090d1a-verify" \
  node --import tsx --test \
  test/unified-ssteer-channel.test.ts \
  test/unified-file-fixture-versions.test.ts \
  test/unified-task-topic-t0.test.ts \
  test/unified-task-topic-t1.test.ts \
  test/unified-unknown-candidates.test.ts

# 4. 全量测试
npm test
```
