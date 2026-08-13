# 飞书-Codex 全量同步桥接

[English README](README.en.md)

维护者设计文档：[docs/design.md](docs/design.md)

该服务把本机 `~/.codex/sessions` 中的 Codex 会话同步到飞书私密话题群，并允许从对应话题继续会话。它是本机 Codex CLI 的飞书前端，不安装飞书桌面客户端；消息事件和卡片按钮均由飞书 WebSocket 长连接接收，不需要公网回调地址。

## 当前能力

- 扫描并持续监听 `~/.codex/sessions/**/*.jsonl`；每个 Codex `session_id` 映射到一个飞书根消息，话题回复构成可读对话。
- 飞书可读视图包含用户消息、Codex 正文和进度更新。飞书发起的消息会抑制本地 JSONL 回声，避免重复显示“用户”消息。
- 支持 JSON 2.0 控制台卡片、项目目录 -> 模型 -> 思考强度 -> 任务的新建流程、会话搜索、话题内续聊、图片输入、暂停、重试和取消任务。
- 会话根卡标题使用 Codex 的真实 thread title；历史会话会自动迁移并过滤宿主注入的插件/环境上下文。
- 飞书交互会话使用长驻 `codex app-server --stdio`：支持实时流、同回合引导、原生问答、取消、Plan 和结构化命令/文件审阅；JSONL 仍用于历史导入和本地 CLI 会话同步。
- 会话根卡可切换 Default/Plan；Plan 使用 Codex 原生模式且不自动执行。每轮正文优先使用 CardKit 流式实体，权限或客户端不支持时自动回退普通 JSON 2.0 卡片。
- 超过 50,000 字符的正文以 Markdown 附件发送。图片下载到权限为 `0600` 的受控临时目录，传给 Codex 后删除。
- SQLite 位于 `~/.local/state/feishu-codex-bridge/bridge.sqlite`，保存会话话题映射、解析游标、去重键和失败记录。
- 原始 Codex JSONL 永远只保留在本机 `~/.codex/sessions`，桥接服务不提供原始日志上传功能。
- Default 以 app-server 权限策略运行；容器 Root 模式必须通过显式环境确认，并在每个会话中确认 8 小时授权。没有任何静默 `codex exec` 回退。
- 服务启动时通过 `codex debug models` 读取可见模型与支持的思考强度，缓存到 SQLite。CLI 暂时不可用时使用最近一次有效缓存；没有有效目录时会阻止新建，并提示使用 `/retry`。

## 一键安装

目标环境是带 systemd 的 Linux。安装前需要：

- Node.js 22 或更新版本以及 npm。
- 已安装、已登录并能在终端执行的 Codex CLI。
- 一个能够创建企业自建应用的飞书账号；如果所在企业要求管理员审核，安装后还需管理员批准应用版本。

下载仓库后，在仓库根目录执行：

```bash
./install.sh
```

若下载 ZIP 后脚本没有执行权限，可改用 `bash install.sh`。不要使用 `sudo`；服务必须以实际运行 Codex 的用户身份安装。缺少 Node、Codex 或登录状态时，安装器会直接输出可复制的修复命令；不会代替用户执行远程安装脚本、`sudo` 或登录操作。

安装器会依次完成以下工作：

1. 安装锁定版本的依赖，运行 TypeScript 检查、测试和构建。
2. 显示飞书验证链接；用户确认后，为当前用户创建独立的企业自建应用。
3. 将新凭据先写入权限为 `0600` 的恢复文件，再自动配置最小权限、WebSocket 消息事件、卡片回调、机器人能力、操作菜单和应用可见范围，并提交应用发布；中途失败时重跑即可继续。
4. 自动生成随机绑定码，将 App ID/Secret 写入权限为 `0600` 的 `~/.config/feishu-codex-bridge/env`。
5. 根据当前仓库位置、Node 和 Codex 的真实路径生成用户级 systemd 服务，并立即启动。安装结束后不需要再手动启动服务。
6. 自动运行 `doctor`（只读自检）。仅在飞书机器人 API 已验证可用时，才显示需要在飞书私密话题群中发送的 `/bind` 命令。

安装器不会上传本机 JSONL，不会使用 sudo，也不会复用仓库作者的飞书凭据、用户路径或 SQLite 数据。新建应用默认仅对扫码安装者可见；服务运行时仍会额外校验绑定群和绑定用户。再次运行 `./install.sh` 会复用已有环境文件、用户自定义目录和绑定状态，用于升级依赖、补充新版所需飞书配置、重建并修复 systemd 服务，不会新建第二个飞书应用。环境文件残缺时安装器会停止并提示恢复，不会静默创建新应用。

安装结束时只需按终端最后显示的结果继续操作：

- 若显示“安装完成”和 `/bind` 命令：服务已经在运行。创建一个私密话题群，加入新机器人后，在群中发送该命令。
- 若提示“等待管理员审核”：服务已经安装，但机器人尚不能使用。先在飞书后台批准应用版本；随后在仓库目录运行 `npm run doctor` 重新检查。检查通过后，再运行一次 `./install.sh` 显示原来的 `/bind` 命令；它会复用同一个应用和绑定码，不会新建应用。此时才创建群并绑定。
- 若显示其他失败信息：按安装器输出的修复命令处理后，重新运行 `./install.sh`。不需要手动创建或启动 systemd 服务。

### root 或无 systemd 的容器

当容器中的 Codex 以 root 运行，或 PID 1 不是 systemd 时，可使用容器模式：

```bash
./install.sh --container --existing-app <cli_xxx>
npm run start:container
```

该模式会生成同样的 `0600` 环境文件、配置飞书应用并运行无 systemd 自检，但不创建用户服务。`start:container` 在前台运行，会在桥接子进程异常退出 5 秒后重启，并转发 `SIGINT`/`SIGTERM` 用于优雅停止。

应将 `npm run start:container` 设为容器入口或交由外部平台启动。容器自身被删除或重启后，容器内进程无法自行恢复；必须由容器外部的启动策略重新执行该命令。

成功时终端会显示类似下面的绑定命令：

```text
@机器人 /bind <安装器生成的绑定码>
```

`doctor` 是只读检查，不会启动、停止或重启服务，也不会创建飞书应用。它检查飞书机器人是否可用、环境文件权限、Codex 登录状态和用户服务状态。绑定成功后发送 `/help`。服务会扫描当前用户的 `~/.codex/sessions`，工作目录默认限制在当前用户主目录内。服务器无需 GUI、飞书客户端或公网端口；终端输出的验证链接可在另一台电脑浏览器或手机飞书中打开。

### 已有应用与手工回退

已有飞书企业自建应用时，使用应用所有者或管理员账号扫码确认：

```bash
./install.sh --existing-app <cli_xxx>
```

该模式不会创建第二个应用，会补齐本桥接器所需权限、WebSocket 事件/回调、机器人菜单和“仅扫码者可见”的范围。旧版本已部署实例不会在普通升级时自动改变可见范围；需要显式运行上述命令迁移。

若企业策略禁止扫码创建/更新应用，先在飞书后台完成本 README 的手工配置，再执行：

```bash
mkdir -p ~/.config/feishu-codex-bridge
cp deploy/env.example ~/.config/feishu-codex-bridge/env
chmod 600 ~/.config/feishu-codex-bridge/env
$EDITOR ~/.config/feishu-codex-bridge/env
./install.sh --from-env
```

`--from-env` 不会修改飞书后台。手工模式必须将应用可见范围限制为部署者，配置机器人、最小权限、长连接事件、卡片回调并发布版本；随后运行 `./install.sh --from-env`。该命令会安装并自动启动本地服务，再自动运行 `doctor` 验证。只有终端显示 `/bind` 命令后，才创建群并绑定。

## 飞书应用配置原理与手工回退

正常安装不需要手工配置开发者后台。安装器使用飞书 Node SDK 的设备授权流程创建属于安装者自己的企业自建应用，并通过应用配置 API 设置下列项目。若自动创建流程在企业策略下不可用，可按本节手工创建应用，再将凭据写入 [`deploy/env.example`](deploy/env.example) 所示的用户环境文件。

1. 登录 <https://open.feishu.cn/app>，创建企业自建应用并添加机器人能力；应用可见范围仅选择部署者。
2. 在“权限管理”申请应用身份权限：
   - `im:message:send_as_bot`：机器人发送文本、卡片和附件。
   - `im:message.group_at_msg:readonly`：接收群聊中提及机器人的消息。
   - `im:message`：读取机器人根消息，并在点击卡片后显式更新原卡片。
   - `im:message.group_msg`：以应用身份读取绑定私密群中的根消息，用于回填会话话题元数据。该权限可读取群消息，仅应授予专用私密群。
   - `im:resource`：下载用户图片，以及发送超长正文的附件。
   - `cardkit:card:write`：创建和流式更新每轮临时输出卡片实体。
   - `application:application:patch`：受管安装自动维护本应用配置并发布版本。
   - `application:application:self_manage`：doctor 只读核验本应用线上版本、事件和回调配置。
3. 在“事件与回调”选择“使用长连接接收事件/回调”，订阅 `im.message.receive_v1`、`application.bot.menu_v6` 和回调 `card.action.trigger`。
4. 可选配置机器人自定义菜单，事件键分别使用 `codex.home`、`codex.new`、`codex.sessions`、`codex.search` 和 `codex.service`。菜单项类型必须为“事件”，不是跳转链接。
5. 创建并发布新版本；创建私密话题群，只加入授权用户和机器人。

卡片按钮通过同一条 WebSocket 长连接回传，不需要公网 IP、域名、隧道、Verification Token 或 Encrypt Key。不要申请通讯录、群管理等与本服务无关的权限。

手工环境文件至少包含 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、一次性 `FEISHU_BIND_TOKEN` 和卡片版本：

```dotenv
FEISHU_CARD_UI_VERSION=2
```

生产使用 JSON 2.0。将该值临时改为 `1` 后，执行下文的“升级源码后”命令重启服务即可回滚到上一版卡片构造器，但 v1 输入框不支持新的表单提交路径。`--from-env` 也会自动生成并启动用户服务；只有完全不使用安装器时，才需要根据 [`deploy/feishu-codex-bridge.service`](deploy/feishu-codex-bridge.service) 中的占位符手工创建服务文件。

```text
/bind <FEISHU_BIND_TOKEN>
```

绑定后，服务会记录群 ID 和当前用户的 `open_id`，并开始后台同步历史会话。绑定码不会用于绑定第二个群或用户。迁移到新群时使用下面的受保护 `npm run rebind` 命令，不要手工删除生产数据库。

### 迁移到新群并重新导入全部会话

先在飞书创建新的私密话题群，将机器人和授权用户加入该群。为避免旧群成员或旧绑定码继续拥有入口，先在环境文件中更换为新的随机 `FEISHU_BIND_TOKEN`，并保持文件权限为 `0600`。

下面的命令会先备份 SQLite，再仅重置飞书群绑定、话题映射、已发送消息去重记录和 JSONL 游标；不会删除本机 JSONL、会话模型设置或旧群中的任何消息：

```bash
systemctl --user stop feishu-codex-bridge.service
$EDITOR ~/.config/feishu-codex-bridge/env
npm run rebind -- --confirm
systemctl --user start feishu-codex-bridge.service
```

然后在新群中发送 `@机器人 /bind <新的 FEISHU_BIND_TOKEN>`。绑定成功后会自动完整重扫 `~/.codex/sessions`，为每个会话创建最新卡片和话题；也可在绑定后发送 `/sync` 观察补扫。

## 常用工作流

### 新建与继续会话

最方便的入口是“Codex 控制台”卡片：点击“新建会话”，依次选择项目、Codex 模型和该模型支持的思考强度，最后在卡片表单中填写任务并提交。图片、超过 1,000 字符的任务和图文任务继续使用聊天框。每次有效选择都会延长向导 10 分钟；旧卡片、过期卡片和重复点击不会覆盖当前向导。

也可以使用：

```text
/new <目录> <提示>
```

`/new` 会先保存提示和图片引用，然后显示模型与强度卡片；选择完成后自动执行，不必再次发送提示。目录必须存在，经过 `realpath` 后位于安装用户的主目录内；目录穿越和符号链接逃逸会被拒绝。新会话创建后，日志落盘时自动出现新的飞书话题。

继续既有会话时，直接在该会话的话题内发送，无需再提及机器人：

```text
<消息>
```

服务使用对应的 `session_id` 执行 `codex exec resume`。同一会话正在本地 Codex CLI 或桥接服务中运行时，飞书续聊会暂缓，避免两个前端并发修改同一线程。

新建时选定的模型和思考强度会随 `session_id` 保存，之后的续聊会继续传入同一配置。历史会话会从本机 JSONL 最近的 `turn_context.payload.model` 与 `payload.effort` 回填；没有这些字段的历史会话继续继承本机 Codex 全局配置。若保存的模型从当前目录中消失，桥接器会停止该话题续聊，要求重新选择，而不会静默切换。

在已映射的话题内，优先点击会话根卡的“修改模型”。也可以直接发送 `/model` 打开同一模型卡片；两种方式都无需 `@机器人`。高级文字兜底为：

```text
/model <模型> <思考强度>
```

该设置原子更新并用于之后的续聊。群主消息中的 `/model` 不会修改任何会话。群主消息发送单独的 `/` 后会返回操作面板；飞书长连接只能处理已经发送的消息，因此这不是输入框内的实时命令补全。

Plan 通过会话根卡切换；新会话默认 Default。服务等级和速度档位不与会话模型设置混用。

“最近会话”按项目分组，每页显示 8 条。搜索只查询 SQLite 中的工作目录、首条用户消息和短会话 ID，不读取完整 JSONL；多关键词使用 AND 匹配。会话标题使用飞书消息链接定位根消息。

搜索示例：

```text
/search example-project
/search GUI Agent
/search <短会话ID>
```

`/sessions` 会打开带输入框的搜索卡片；不输入关键词时显示最近会话。

### 控制台与文字入口

控制台提供新建会话、最近会话、项目目录、刷新状态、立即同步、暂停/恢复同步、帮助和重试失败任务。

在绑定私密群中，已知斜杠命令无需提及机器人；普通群主消息仍必须提及机器人。发送单独的 `/` 会打开“新建、搜索、最近、控制台、服务管理、帮助”命令面板。未知 `/xxx` 只返回该面板，不会提交给 Codex。

卡片按钮不可用、过期或不便点击时，可使用下列入口：

- `/help`、`帮助`、`?`：显示使用帮助。
- `/`：显示命令面板。
- `/sessions`：打开会话搜索卡片。
- `/search <关键词>`：按目录、首条用户消息和短会话 ID 搜索；多个关键词按 AND 匹配。
- `新建`、`项目`、`会话`、`最近`、`状态`：打开相应卡片。
- `/status`：显示已索引会话、活动任务、失败数和允许目录。
- `/sync`：立即全量补扫本地会话。
- `/pause`、`/resume-sync`：暂停或恢复同步与续聊。
- `/retry`：标记失败任务为已处理、刷新 Codex 模型目录并从持久化游标重新扫描。
- `/cancel`：取消当前话题中由桥接服务启动的任务，或取消当前向导/选择。
- `/model`：仅在已映射 Codex 会话话题中选择后续续聊的模型和思考强度。

## Codex 需要你的回答时

方案选择和业务确认以真实飞书卡片按钮呈现。卡片失效或过期时，在同一话题回复 `1` 选择第一个选项，或直接回复自定义文本；普通自由文本问题也直接在话题内回答。

允许通过卡片确认的事项包括：

- 是否联网查询公开资料或候选项目的近期提交。
- 依赖、研究、实现和方案选择。
- 是否修改已授权工作目录内的文件。

原生 Codex 请求会以卡片展示命令、文件、网络或 MCP 影响范围，并使用一次性 nonce 防止重复或跨用户提交。若启用 `ALLOW_GROUP_SECRET_INPUT=1`，secret 值会经过飞书平台但不会被桥接器写入 SQLite、日志或回复；不启用时此类请求会拒绝。

## 同步内容与隐私

飞书只接收可读对话：用户消息、助手正文和进度更新。系统与开发指令、内部事件、工具调用参数和工具输出不会发送到飞书，仍保留在本机 JSONL。

原始 JSONL 不上传；既有飞书附件不会被自动删除。旧环境文件中的 `UPLOAD_RAW_ARCHIVES` 会被忽略，可在下次维护时删除该行。

普通群主消息必须提及当前机器人；服务会按机器人 `open_id` 验证提及对象。绑定用户发送的已知斜杠命令是例外，可省略提及。仅提及其他用户或未提及机器人的普通群主消息不会执行。已映射 Codex 会话的话题内，可直接回复文本、图片或选择编号，无需再提及机器人。发送图片时，应使用一条同时包含 `@机器人`、提示文字和图片的富文本消息；在既有会话话题内则无需提及。

## Codex 执行边界

- 工作目录必须经 `realpath` 校验并位于安装器写入的 `ALLOWED_ROOT`，默认为当前用户主目录；符号链接逃逸和目录外路径会被拒绝。
- 飞书交互回合不使用 `codex exec`；新建和续聊均通过 app-server 的 `thread/*` 与 `turn/*` 生命周期执行。
- 默认 `workspace-write` 环境在 sandbox smoke test 失败时 fail-closed。只有 `CODEX_EXECUTION_MODE=root-danger-full-access`、`ROOT_FULL_ACCESS_ACK=I_UNDERSTAND_CODEX_CAN_MODIFY_THE_ENTIRE_CONTAINER` 同时存在时，才允许无沙箱 Root 模式。
- Root 模式可读写整个容器、访问网络并启动进程；飞书会话卡须确认后才开始 Default 回合，授权最长八小时，并在 app-server 重启、目录变化、用户重绑或撤销时失效。
- 每个续聊会话都受活动任务与 JSONL 活动状态保护，避免桥接器与本地 Codex 同时写入同一会话。
- 每次新建和续聊都传入会话保存的 `-m <model>` 与 `-c model_reasoning_effort="<effort>"`；没有保存设置的历史会话不传覆盖项，继续使用本机 Codex 默认值。

## 服务生命周期与运维

安装器会立即启动用户级服务，无需用户手动执行启动命令。服务已启用且 `linger=no` 时，首次 SSH 登录也会启动它；后续 SSH 连接复用正在运行的服务，不会每连接一次就重启。最后一个当前用户的登录会话退出后服务停止；下次登录再启动。

管理员可执行以下命令，让服务在没有登录会话时也常驻：

```bash
sudo loginctl enable-linger "$USER"
```

日常检查（均不改变服务状态）：

```bash
npm run doctor
npm run check
npm test
systemctl --user status feishu-codex-bridge.service
journalctl --user -u feishu-codex-bridge.service --since today
```

只有升级源码或手工修改配置后，才需要使用下列命令让运行进程加载新构建产物：

```bash
npm run build
systemctl --user restart feishu-codex-bridge.service
```

## 已知限制

- 飞书客户端深链需要在桌面端和移动端各实际验证一次；若某个客户端版本不支持定位根消息，仍可通过搜索结果中的项目、摘要和短 ID 找到会话。
- 一键安装器会自动配置机器人菜单；只有手工回退安装时，才需要在开发者后台配置事件键、订阅 `application.bot.menu_v6` 并重新发布应用。发送 `/` 的聊天命令面板不依赖后台菜单配置。
- 长连接无法监听用户尚未发送的 `/` 输入内容，因此不能像本地终端一样在输入阶段自动弹出命令补全。

升级 Codex 或飞书 SDK 后，应先运行测试，再在测试群检查 JSONL 事件契约、卡片回调、话题续聊和图片输入。解析器会告警并忽略未知 JSONL 事件类型，不会把未知内部事件发送到可读视图。
