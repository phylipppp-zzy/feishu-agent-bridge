# 调研：通过 feishu-codex-bridge 在飞书上查看项目交付文件

日期：2026-10-05
范围：只做调研，没有修改桥接代码。第六节是在飞书客户端里的实测结果。

## 一、问题

能否借助本机已有的“Claude Code → 飞书”同步项目，在飞书（尤其是手机端）直接查看项目交付的文件？这里的交付文件指 Markdown 报告、PDF、图表图片、CSV/JSON 结果、代码、HTML 报告和压缩包等。如果可行，有哪些呈现方式，各自的代价是什么？

## 二、结论

**可行。** 桥接已经具备三样基础能力：企业自建应用身份、按会话划分的话题，以及“上传文件并在话题里发送”的函数。还需要补的是：

1. 决定“哪些文件算交付文件”的触发方式。
2. 发送图片消息的接口。
3. 如果要生成飞书云文档或放进云空间，还需要新增相应权限。

如果只用聊天文件消息和卡片，不需要申请新权限。如果要用云文档、云空间、知识库或多维表格，需要在飞书开发者后台新增权限，并重新发布应用版本。

建议分两个阶段做：

- 第一阶段：在话题里发一张“交付摘要卡片”，再把文件逐个作为文件消息或图片消息发出。改动小，不需要新权限。
- 第二阶段：把 Markdown 报告转成飞书云文档，在卡片里放文档链接。手机阅读效果最好，但需要新增权限，还要处理文档归属。

## 三、本地项目现状

项目位置：`/home/sar/usr/zhangzy/workspace/feishu-agent-bridge`。当前部署的是 `feat/claude-mirror` 分支，HEAD 为 `685a213`，由 systemd 用户服务 `feishu-claude-bridge.service` 运行。

### 3.1 工作方式

- 一个常驻进程监听 `~/.claude/projects/*.jsonl`。每个 Claude Code 会话对应私密话题群里的一个话题，每轮对话一张卡片。
- 飞书侧通过 WebSocket 长连接接收消息和卡片按钮回调，不需要公网回调地址。在话题里回复就能继续会话，也能在飞书里审批权限请求。
- 鉴权方式是企业自建应用（app_id、app_secret，以应用身份调用，即 tenant_access_token），不是自定义机器人 webhook。这一点决定了可行性：webhook 机器人不能上传文件或图片，自建应用可以。

### 3.2 已申请的权限

见 `src/installer.ts:6-17`：

- `im:message:send_as_bot`、`im:message.group_at_msg:readonly`、`im:message`、`im:message.group_msg`
- `im:resource`（上传、下载消息里的文件和图片）
- `cardkit:card:write`
- `application:application:patch`、`application:application:self_manage`

没有任何云空间（drive）、云文档（docx）、知识库（wiki）、多维表格（bitable）相关权限。

### 3.3 和交付文件有关的现有代码

| 能力 | 状态 | 位置 |
|---|---|---|
| 上传文件并在话题里发文件消息 | 已实现，可复用 | `FeishuClient.replyFile(rootMessageId, fileName, data)`，`src/feishu.ts:379-388`；上传时固定使用 `file_type: "stream"` |
| 实际发送的文件 | 只发桥接自己生成的 `.md` | 超长回复的附件（`src/claude/runtime.ts:504-507`）、`/export` 导出的会话记录（`runtime.ts:1014-1021`） |
| JSON 2.0 卡片 | 已实现 | `src/card-kit.ts`、`src/claude/cards.ts`；已用到 markdown、折叠面板、表单、按钮回调 |
| 发送图片消息 | 未实现 | 没有调用 `im.image.create` |
| 下载用户发来的图片 | 已实现 | `FeishuClient.downloadImage` |
| 云文档、云空间、知识库、多维表格 | 未实现，文档中也没有提到 | — |
| “交付文件”这一概念 | 没有 | 文件路径只以文本形式出现在执行记录里（例如 Write、Edit 后面的相对路径） |

### 3.4 顺带发现的问题（与本需求无直接关系）

- **hooks 丢失**：桥接安装在 `~/.claude/settings.json` 里的 6 条 hooks（SessionStart、UserPromptSubmit、Stop、StopFailure、Notification、SessionEnd，都调用 `scripts/claude-hook.mjs`）已经不在了。备份 `settings.json.bak-202610040844` 里还有。备份文件名是 12 位时间戳，而桥接自己的备份名是 14 位，所以推测不是用桥接的卸载脚本移除的，而是手工编辑或其他工具改写 settings.json 时丢失的。presence 文件最后一次写入是 10-03 20:27（EDT）。影响：根卡片没有本机实时状态，收不到“等待你处理”的提醒，手机和电脑之间的冲突检测失效。
- **网络错误**：服务日志里有连续的 TLS `ECONNRESET`，数据库里有 3 条未解决的 `render_session` 失败记录，最近一条在 2026-10-05 10:03 UTC。

## 四、呈现方式对比

| 方式 | 做法与接口 | 限制 | 适合的文件 | 改动量 |
|---|---|---|---|---|
| A. 话题里发文件消息 | `POST /open-apis/im/v1/files` 上传，`file_type` 可选 `pdf`、`doc`、`xls`、`ppt`、`mp4`、`opus`、`stream`；拿到 `file_key` 后发 `file` 消息。可直接复用 `replyFile` | 单个文件不超过 30 MB，不能上传空文件 | PDF、Office、zip、CSV、HTML、原始 Markdown 和代码 | 最小，不需要新权限 |
| B. 发图片消息 | `POST /open-apis/im/v1/images` 上传（`image_type: message`），拿到 `image_key` 后发 `image` 消息 | 大小上限约 10 MB（未核实）；SVG 会被拒绝（错误码 234011，实测），必须先转成 PNG | 图表、截图 | 小，所需的 `im:resource` 已有 |
| C. 交付摘要卡片 | JSON 2.0 卡片的富文本（markdown）组件，加按钮 | 见 4.1 | 文件清单、关键指标、到文件或文档的链接 | 小 |
| D. 转成飞书云文档 | 两条路，见 4.2 | 需要 docx、drive 权限；见 4.2 的归属问题 | Markdown 报告（手机阅读效果最好，可以评论） | 中 |
| E. 云空间文件夹归档 | `POST /open-apis/drive/v1/files/upload_all`，`parent_type` 固定为 `explorer`，`parent_node` 为目标文件夹；超过 20 MB 用分片上传 | 单次不超过 20 MB；应用身份必须对目标文件夹有编辑权限；用户按文件夹的权限看到文件。权限任选其一：`drive:drive`、`drive:file`、`drive:file:upload` | 按项目归档原始交付物 | 中 |
| F. 知识库目录树 | 把文档挂到知识空间节点下 | 需要把应用（或含机器人的群）加为知识空间成员（未核实具体做法） | 长期的项目交付目录 | 中到大 |
| G. 多维表格 | 用导入任务把 CSV 转为多维表格（不超过 100 MB），或逐条写记录并使用附件字段 | 需要 bitable 权限 | 实验结果表、交付清单 | 中 |
| H. 飞书官方 MCP | `larksuite/lark-openapi-mcp`（目前是 Beta），把开放平台接口包装成 MCP 工具，让 Claude 会话自己调用 | 和桥接是两条独立的路，权限和身份要单独配置 | 临时、按需发送 | 不改桥接 |

### 4.1 卡片 markdown 组件的能力（JSON 2.0）

根据官方文档：

- 支持：一到六级标题、加粗、斜体、删除线、有序和无序列表、引用（`>`）、分割线、链接（包括带图标的链接和区分设备的跳转链接）、代码块（支持语法高亮，覆盖 70 多种语言）。
- 表格：支持 markdown 表格，但除标题行外每个表格只显示 5 行数据，超出部分分页显示；一个富文本组件里最多放 4 个表格。数据较多时要改用卡片的原生表格组件。
- 图片：必须先通过图片上传接口拿到 `image_key`，写成 `![说明](image_key)`；不能直接写图片 URL。
- 公式：不支持。实测 `$...$` 在手机端显示为原文。
- 卡片整体大小上限：本次查到的文档没有写明（未核实）。桥接现有代码按约 18000 字截断卡片正文。

### 4.2 把 Markdown 转成飞书云文档的两条路

**路线一：导入任务**

1. 上传源文件。可以用“上传素材”接口（临时文件，导入后删除），也可以用“上传文件”接口（文件会永久占用上传者的空间）。
2. 调用“创建导入任务”接口（`drive/v1/import_tasks`），返回 `ticket`。
3. 用 `ticket` 轮询“查询导入任务结果”接口。

支持的源格式与目标类型：

| 源格式 | 目标类型 | 大小上限 |
|---|---|---|
| md、mark、markdown | docx | 文档未写明 |
| html | docx | 20 MB |
| docx | docx | 600 MB |
| txt | docx | 20 MB |
| csv | sheet 或 bitable | sheet 20 MB，bitable 100 MB |
| xlsx | sheet 或 bitable | 800 MB |

导入不支持 PDF。PDF 只能作为文件发送或放进云空间。

**路线二：转换为文档块**

1. `POST /open-apis/docx/v1/documents` 创建空文档。
2. `POST /open-apis/docx/v1/documents/blocks/convert` 把 Markdown 或 HTML 转成文档块。
3. `POST /open-apis/docx/v1/documents/{document_id}/blocks/{block_id}/children` 把块插入文档。

注意事项：

- 单次最多插入 1000 个块，超过要分批。
- 插入表格块前要去掉 `merge_info` 字段。
- 图片要另外上传，再替换到图片块里（具体步骤未核实）。
- 公式等复杂元素的转换效果未实测。

路线二能精确控制图片和插入位置，适合程序生成的报告。路线一实现简单，适合原样导入。

**两条路共同的问题：文档归属。** 以应用身份创建的文档和文件，所有者是应用。用户要看到它们，有两种做法：

- 由应用给用户添加协作者权限（云文档权限成员接口，具体 scope 名称未核实）。
- 用户先建一个文件夹并共享给应用，应用把文档建在这个文件夹里。

## 五、建议路线

### 第一阶段：最小可用（A + B + C）

> 2026-10-05 已实现并部署：会话话题里的 `/deliver <路径…>` 命令，代码在 `src/claude/deliver.ts`，用法见桥接的 `docs/claude.md`“发送交付文件”一节。SVG 没有做自动转换，而是作为文件发送（手机上不能预览）。

在话题里发一张“交付摘要卡片”，列出文件名、大小和关键指标，然后把文件逐个作为文件消息或图片消息发出。

触发方式先用显式命令，例如在话题里发 `/deliver <路径或通配符>`。实现时需要注意：

- 路径限制在该会话的工作目录和 `ALLOWED_ROOT` 内。
- 排除 `.env`、密钥、凭据类文件。
- 超过 30 MB 的文件只在卡片里列出，不发送。
- 图片（png、jpg）走图片消息；SVG 先转成 PNG 再走图片消息；其余走文件消息。PDF 用 `stream` 上传即可，实测与 `pdf` 类型没有区别。

改动集中在 `src/feishu.ts`（新增 `replyImage`）、`src/claude/runtime.ts`（新增命令处理）和 `src/claude/cards.ts`（新增摘要卡片）。不需要新权限。

### 第二阶段：Markdown 报告转云文档（D）

优先用“转换为文档块”路线，生成的文档链接放进摘要卡片。需要在后台新增 docx、drive 和权限成员相关的 scope，重新发布应用版本，并在 `src/installer.ts` 的权限列表里同步加上。

### 可选：长期归档（E、F、G）

与 projtool 对接：在 `commit_report` 之后，或在 `output/` 目录里出现新的 `metrics.json`、`report.html` 时，自动生成交付清单，写入云空间文件夹、知识库或多维表格。

## 六、实测结果

### 6.1 测试方法

2026-10-05 在已绑定的飞书群里发了一条测试根消息，并在它的话题里依次发送：

- 01 至 06：md、csv、json、py、html、svg 文件，均以 `file_type: stream` 上传。
- 07、08：同一个 PDF（约 1 MB），分别以 `file_type: pdf` 和 `file_type: stream` 上传。
- 09：一张 PNG 图片消息；另外尝试把 SVG 作为图片上传。
- 10：一张 JSON 2.0 卡片，包含 7 行数据的 markdown 表格、Python 代码块、`$...$` 公式、引用、链接和用 `image_key` 内嵌的图片。

接口返回结果由脚本记录；能否预览由用户在手机客户端上查看。测试结束后 11 条消息已全部撤回。桥接服务在测试期间没有产生任何日志，测试消息没有干扰现有会话。

### 6.2 结果

| 编号 | 内容 | 接口结果 | 手机端显示 |
|---|---|---|---|
| 01 | Markdown 文件 | 发送成功 | 可以在线预览 |
| 02 | CSV 文件 | 发送成功 | 可以在线预览 |
| 03 | JSON 文件 | 发送成功 | 可以在线预览 |
| 04 | Python 代码文件 | 发送成功 | 可以在线预览 |
| 05 | HTML 文件 | 发送成功 | 可以在线预览 |
| 06 | SVG 文件 | 发送成功 | **不能预览**，需要用其他应用打开 |
| 07 | PDF（`file_type: pdf`） | 发送成功 | 可以在线预览 |
| 08 | PDF（`file_type: stream`） | 发送成功 | 可以在线预览，与 07 没有可见区别 |
| 09 | PNG 图片消息 | 发送成功 | 正常显示 |
| — | SVG 作为图片上传 | **被拒绝**，错误码 234011“无法识别图片格式” | — |
| 10 | markdown 卡片 | 发送成功，没有被拒收 | 表格、代码块、内嵌图片没有报告问题；**公式没有渲染**，显示为原文 |

说明：用户只报告了有问题的项，“可以在线预览”“正常显示”是指用户没有报告问题。桌面端没有单独核对。7 行表格是否分页显示，用户没有特别说明，视为可以接受。

### 6.3 对方案的影响

1. 聊天文件消息足以覆盖大部分交付文件：Markdown、CSV、JSON、代码、HTML、PDF 在手机上都能直接查看。第一阶段的价值因此比预期更高。
2. SVG 两条路都不理想：作为图片上传会被拒绝，作为文件发送又不能预览。实现时应在本地把 SVG 转成 PNG 后以图片消息发送（需要 `rsvg-convert` 或类似工具），同时可以附上原始 SVG 文件。
3. PDF 上传时用 `pdf` 还是 `stream` 对预览没有影响，沿用现有 `replyFile` 的 `stream` 即可。
4. 卡片不能显示公式。含公式的报告应以文件形式发送，或在第二阶段转成飞书云文档（云文档有公式块，但 Markdown 转换后公式能否保留仍未实测）；卡片里只放不含公式的摘要。

### 6.4 仍未确认的问题

- 桌面端的预览效果是否与手机端一致。
- Markdown 文件预览时是渲染后的排版还是纯文本（本次只确认能打开查看）。
- 云文档转换对公式、图片的支持情况（需要先申请 docx 权限）。

## 参考资料

- [上传文件（IM）- 飞书开放平台](https://open.feishu.cn/document/server-docs/im-v1/file/create?lang=zh-CN)
- [上传文件（云空间）- 飞书开放平台](https://open.feishu.cn/document/server-docs/docs/drive-v1/upload/upload_all?lang=zh-CN)
- [导入文件概述 - 飞书开放平台](https://open.feishu.cn/document/server-docs/docs/drive-v1/import_task/import-user-guide?lang=zh-CN)
- [文档常见问题（含 Markdown/HTML 转换为文档块）- 飞书开放平台](https://open.feishu.cn/document/docs/docs/faq?lang=zh-CN)
- [富文本（Markdown）组件，JSON 2.0 - 飞书开放平台](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/rich-text)
- [表格组件，JSON 2.0 - 飞书开放平台](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table?lang=zh-CN)
- [文件上传、在线预览的大小及格式要求 - 飞书帮助中心](https://www.feishu.cn/hc/zh-CN/articles/360049067549)（本次未能取回内容）
- [larksuite/lark-openapi-mcp - GitHub](https://github.com/larksuite/lark-openapi-mcp)
- 本地代码：`feishu-codex-bridge` 的 `src/feishu.ts`、`src/installer.ts`、`src/claude/runtime.ts`、`src/claude/cards.ts`、`docs/claude.md`
