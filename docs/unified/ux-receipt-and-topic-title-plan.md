# 飞书统一桥接器 UX 收口方案：消除冗余「操作回执」与话题根卡片真实命名同步

- **适用仓库工作树**：`$HOME/tmp/feishu-unified-v2`（分支 `codex/feishu-unified-v2-agy`，基线提交 `16c64dc`）
- **禁止触碰**：`$HOME/workspace/feishu-agent-bridge`（主工作树）、线上 `~/.config/feishu-unified-bridge/config.json` 与 `feishu-unified-production.service`（代码改完并经测试验证后由运维/用户确认切换）
- **硬性约束**：`src/unified/` 下任意 `.ts` 文件必须严格保持 `< 900` 行；所有相对 ESM 导入带 `.js` 尾缀；改动后运行 `npm run check && npm run build && npm test` 必须 0 失败。

---

## 一、任务 1：收口冗余「操作回执」卡片（只留安全网，正常态静默）

### 1.1 问题根因（实测定位）
1. **重启/重连群发 `接入会话：已完成`**：`src/unified/feishu-channel.ts:834, 840-846` 的 `sync()` 仅过滤了 `submitInput` 与 `resolveInteraction`，导致每次服务重启 `restoreBindings()` 或断线重连 `restoreProviderAfterReconnect()` 触发 `attachSession` 时，每个交互话题都会多发一张 `操作回执：接入会话：已完成`。
2. **`/model` 切模型 1 次 = 1 个 Toast + 2 张卡片**：`handleSdkCardCallback`（`src/unified/feishu-sdk-port.ts:76, 96`）已返回 `{ toast: { type: 'success', content: '已确认' } }`，但 `feishu-channel.ts:725` 仍发「更新设置：已接收，等待处理」，随后 `sync()`（`844`）再发「更新设置：已完成」。
3. **其余冗余中间态与重复发卡**：
   - `cancel`（`719, 725, 844`）：同一次取消连发两张「已完成」；
   - `bind(interactive)`（`538`）、`attach`（`561`）、`upgrade`（`571`）：随后同轮 `advanceCompleted -> finish` 即发 `sessionCard`/新话题，前置「已接收，等待处理；完成后将自动继续」多余；
   - `attachment`（`724-725`）+ `finish(artifact)`（`615`）：连发两张中间卡，且 `src/unified/feishu-cards.ts:38` 漏了 `stageInputArtifact` 映射，回退显示「操作」；
   - `stop` / `legacy_stop`（`643, 725`）：已有 `turn.updated(interrupted)` 专属中断残留核对卡；
   - `src/unified/task-topic/drain.ts:668`：契约拒绝卡把 `ChannelAction` 的 `a.action`（如 `'input'`/`'settings'`/`'stop'`）直接传给 `operationCard()`，命中不了 `feishu-cards.ts:38` 的 CamelCase 键，显示成「操作：失败」。

### 1.2 精确修改方案
1. **`src/unified/feishu-channel.ts:834`**（`sync()` 过滤独立 `operation.completed`）：
   - 将原 `['submitInput', 'resolveInteraction']` 扩为：
     `const SUPPRESSED_COMPLETED_ACTIONS = new Set(['submitInput', 'resolveInteraction', 'attachSession', 'createSession', 'cancelQueuedInput', 'requestControl', 'releaseControl', 'archiveSession', 'updateSessionSettings']);`
   - 仅当 `resolving === true`（修复之前的 `operation.unknown`）时走原地 `port.update`；常规 `operation.completed` 命中该集合时直接静默跳过。
2. **`src/unified/feishu-channel.ts:538, 561, 571`**（`bind(interactive)` / `create` / `attach` / `upgrade`）：
   - `bind(interactive)`、`attach`、`upgrade`：仅当 `op.status === 'failed' || op.status === 'unknown'` 时发送 `operationCard(op)`（`unknown` 保留自带 `[核对结果]`）；`received`/`accepted`/`completed` 直接 `return op`；
   - `create`：若 `e.cardMessageId` 存在（点 `/new` 面板按钮）且非 `failed`/`unknown`，用 `replyOrUpdate` 将原卡原地更新为轻量状态 `{ title: '正在创建会话', text: '已提交创建，完成后将自动打开新话题。', actions: [{ label: '查看处理进度', value: { action: 'finish', operationId: op.operationId } }] }`；若无 `cardMessageId`（文本 `/create`）且非 `failed`/`unknown`，直接静默返回；`failed`/`unknown` 照常发 `operationCard(op)`。
3. **`src/unified/feishu-channel.ts:615, 643, 696, 724-725`** & **`src/unified/feishu-cards.ts:38`**：
   - `feishu-cards.ts:38` 补充 `stageInputArtifact: '提交附件'`；
   - `attachment`（`724-725`）仅在 `op.status === 'failed' || op.status === 'unknown'` 时发 `operationCard`；
   - `finish(artifact)`（`615`）仅在 `['queued', 'failed', 'unknown'].includes(result.status)` 时发 `operationCard(result)`（`queued` 附 `[查看排队]`）；
   - `legacy_stop`（`643`）、`legacy_model`（`696`）及 `725` 统一加前置门控：
     `if (op.status !== 'failed' && op.status !== 'unknown' && !(a.action === 'input' && (a.mode === 'queue' || op.status === 'queued'))) return op;`
   - **必须保留的安全网**：`reconcile`（`708`）、所有 `failed` / `unknown`、`queued` 输入、交互答复刷新（`722`）；不要把 `bind`/`upgrade` 加入 `CONFIRM_TOAST_ACTIONS`（保持 `test/unified-bind-callback-fix.test.ts:18` 回调返回 `undefined`）。
4. **`src/unified/task-topic/drain.ts:668`**：
   - 增加动作名映射（`input`/`attachment` → `'submitInput'`、`stop` → `'interruptTurn'`、`settings` → `'updateSessionSettings'`、`cancel` → `'cancelQueuedInput'`、`control` → `'requestControl'`、`answer`/`answer_form` → `'resolveInteraction'`）后再传给 `operationCard`。
5. **受影响的单测**：
   - `test/unified-quiet-cards.test.ts:16`：更新为验证「非 `resolving` 的 `attachSession`/`updateSessionSettings` 完成事件不发独立回执卡，未知结果事后确认完成仍保留原地更新」。其余关键回归测试（`unified-recovery`、`unified-notice-unknown-resolution`、`unified-operations-notifications`、`unified-bind-callback-fix`、`unified-runtime`、`unified-feishu-channel` 等）均应零破坏通过。

---

## 二、任务 2：飞书话题根卡片真实名称幂等同步 + 三端首句命名补齐

### 2.1 问题根因
1. 飞书侧边栏话题名取自建话题瞬间根卡片的 `header.title.content`；`FeishuChannel.sync()` 从未对 `sdk_topic_routes.root_id` 调用 `im.message.patch`，导致 `core.sqlite` 已更新为真实中文标题（如 `查看当前feishu同步项目进展`、`你好`），飞书侧边栏仍永久冻结在 `Antigravity 会话 · 9e79bb52` / `5e545dcb`。
2. `src/unified/agy/adapter-turns.ts:213-216` 收到 ACP `session_info_update` 时只更新了内存 `meta.title`，未 `emit({ type: 'session', ... })`。
3. `src/unified/codex-adapter.ts:57, 180` 与 `src/unified/claude-adapter.ts:51, 82, 145` 对新建会话首轮提问均未推导标题，也未 emit `session` 观测。

### 2.2 精确修改方案
1. **抽取共享标题工具 `src/unified/session-title.ts`**：
   - 统一导出 `deriveTitleFromInputBlocks(blocks)`（从 `src/unified/agy/adapter-types.ts` 抽离，首个非空文本行/附件名、折叠空白、截断 48 字符加 `…`）、`isGenericSessionTitle(title)`（匹配空串、`'未命名会话'`、`/(?:Claude|Codex|Antigravity) 会话 · [0-9a-f]{8}$/i`）、`normalizeTopicTitle(title)`（折叠空白、截断 60 字符、兜底 `'未命名会话'`）。
2. **扩展 `FeishuPort` & `FeishuSdkPort`**：
   - `src/unified/feishu-channel.ts`（`FeishuPort`）：新增可选 `rootMessageId?(destination: string): Promise<string | null> | string | null;`
   - `src/unified/feishu-sdk-port.ts`（`FeishuSdkPort`）：实现 `rootMessageId(destination: string): string | null { return this.route(destination)?.root_id ?? null; }`。
3. **在 `channel.sqlite` 建表并实现 `syncTopicRootTitle`（幂等、防限流、保隐私）**：
   - 建表：
     ```sql
     CREATE TABLE IF NOT EXISTS channel_topic_titles (
       destination TEXT NOT NULL,
       session_id TEXT NOT NULL,
       binding_scope TEXT NOT NULL,
       root_message_id TEXT NOT NULL,
       synced_title TEXT NOT NULL,
       retry_after INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY(destination, session_id, binding_scope)
     )
     ```
   - **新建话题基线写入**：在 `bind`（`540`）和 `finish`（`598, 606`）经 `createTopic` 建出全新话题并提交 `channel_bindings` 后，若该 `(destination, rootId)` 从未服务过其他会话，直接 `INSERT OR IGNORE` 写入 `synced_title = normalizeTopicTitle(session.title)`，避免刚建完立即多余 patch。
   - **`sync(destination)` 中调用 `syncTopicRootTitle(destination, scope, snapshot.value.session, syncGuard)`**：
     - 必须以 `snapshot.value.session`（已经过 `UnifiedCore.presentSession` 隐私边界校验）为准，严禁绕过 `autoMirror.showTitles=false` 掩码；
     - 无 `isTopicDestination` 或无 `rootId` 直接返回；
     - 若 `row?.synced_title === desiredTitle` 直接返回（稳态 **0 次 API 调用**）；
     - 若 `!row`（升级后首次遇见的存量老话题）且 `isGenericSessionTitle(desiredTitle)`，直接 `INSERT OR IGNORE` 记基线不调 `patch`；
     - 若 `row && row.retry_after > Date.now()` 退避期内直接返回；
     - 调用 `this.port.update(destination, rootId, this.stampCard(destination, rootCard), deliveryId, guard)`：
       - 成功：标记 `channel_deliveries='sent'`，更新 `channel_topic_titles(synced_title=desiredTitle, retry_after=0)`；
       - `BindingExpired` / `ReadAuthorizationRevoked`：直接 rethrow；
       - 限流 `230429`：删掉占坑 `channel_deliveries` 行、写 `retry_after = Date.now() + 30_000` 并吞掉异常不阻塞消息流；
       - 单测 fake Port 未实现 `patch` 等其他非认证错：清理未受理占坑并降级返回，绝不阻断 `sync()`。
4. **三端 Adapter 首句命名与原生改名补齐**：
   - `src/unified/agy/adapter-turns.ts:213-216`：`session_info_update` 更新 `meta.title` 后（非通用标题或当前仍通用标题时）立刻 `ctx.emit({ type: 'session', ref: ctx.ref(sessionId), session: ctx.buildSession(...) })`。
   - `src/unified/codex-adapter.ts`：`receive()` 在 `turn/started`/`turn/completed` 同步更新 `knownSessions` 内存 `status`，新增处理 `thread/name/updated` 并 emit `session`；`input()` 当新建会话无 `name`/`preview` 时用 `deriveTitleFromInputBlocks(blocks)` 赋值 `info.name` 并在 `turn/start` 成功后 emit `session`（确保带 `active` 状态不回退）。
   - `src/unified/claude-adapter.ts`：`Live` 增加可选 `title?: string`，`session()`/`list()`/`find()` 优先回退 `live.title`；`input()` 在设置 `live.turn = id` **之后**若无标题则用 `deriveTitleFromInputBlocks(blocks)` 赋值并 emit `session`（保持 `status: 'running'`）。

---

## 三、验收与测试要求
1. 新增单元测试（如 `test/unified-ux-quiet-and-titles.test.ts`）覆盖：
   - 重启恢复 `attachSession`、`settings`、`cancel`、`bind(interactive)`、`upgrade`、`attachment` 均不发冗余操作回执；`failed`/`unknown`/`queued`/`reconcile` 仍完整保留；`TaskTopicChannel` 拒绝卡动作中文名正确；
   - 新建话题发首句后自动 `patch` 根卡片标题；存量老话题首轮 `sync()` 自动从代码名更名为真实中文名；稳态连续 `sync()` 0 次额外 `patch`；`230429` 限流退避与无 `patch` Mock 降级；`autoPrivateTitle` 隐私掩码不被突破；
   - Agy `session_info_update`、Codex 首句 + `thread/name/updated`、Claude 首句均能更新会话标题并触发 `session` 观测。
2. 校验命令：
   - `find src/unified -name '*.ts' -exec wc -l {} + | sort -rn | head -n 10`（全部 `< 900` 行）
   - `npm run check && npm run build && npm test`（0 失败）
   - 核对 `$HOME/workspace/feishu-agent-bridge` 未被改动（`git status` 干净）。
