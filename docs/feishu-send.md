# 飞书文件直发接口（`feishu-send`）

`feishu-send` 是 `feishu-agent-bridge` 提供的独立对外文件/图片发送接口（CLI + TypeScript/ESM 库），用于让用户、本机脚本或各类 Agent（Antigravity / Codex / Claude Code）把本地文件、报告和图表直接发到飞书话题或主群。

## 1. 核心特性

- **复用生产凭据与话题路由**：默认只读加载 `/home/zhangzy/.config/feishu-claude-bridge/env` 与 `/home/zhangzy/.config/feishu-unified-bridge/config.json`，按 `sdk.sqlite` 的 `sdk_topic_routes` 精准路由到任意会话对应的飞书话题，不写库、不重启也不干扰常驻桥接服务。
- **智能媒体分流（基于文件魔数）**：
  - `PNG / JPEG / GIF / WebP`（≤ 10 MiB）：默认走飞书图片消息（`im.image.create` + `msg_type: 'image'`），手机/桌面端聊天流直接内嵌大图；
  - `PNG / JPEG / GIF / WebP`（10–30 MiB）：自动降级为文件消息并给出提示；
  - 其他文件（`md / pdf / csv / json / html / py / zip` 等，≤ 30 MiB）：走飞书文件消息（`im.file.create` + `msg_type: 'file'`），飞书端支持在线预览；
  - `SVG`：飞书图片接口不支持 SVG，自动按普通文件发送并提示手机端可能无法直接预览；
  - 传入 `--as-file` 可强制图片按原始文件发送（避免图片压缩）。
- **安全与防误发**：默认拦截空文件（0 字节）、目录、超过 30 MiB 文件，以及 `.env` / 私钥 / `credential` / `.ssh` 等敏感路径（确需发送须显式加 `--allow-sensitive`）。

## 2. CLI 用法

安装软链后可直接执行 `feishu-send`（等价于 `node /home/zhangzy/workspace/feishu-agent-bridge/scripts/feishu-send.mjs`）：

```bash
# 1. 发到当前/指定会话对应的飞书话题（支持完整 session_id 或原生 UUID）
feishu-send --session <conversation_or_session_id> report.md plot.png

# 2. 带标题卡片说明 + 多文件发送（发到最近创建的飞书话题）
feishu-send --latest -t "实验结果" -m "M3-E2 评估曲线与指标表" metrics.csv loss.png

# 3. 发到默认主群（省略目标参数）或指定群/根消息
feishu-send summary.pdf
feishu-send --root om_xxx report.md
feishu-send --chat oc_xxx report.md

# 4. 强制以原始文件发送图片（保留无损原图）
feishu-send --session <id> --as-file figure.png

# 5. 演练校验（不联网、不发消息）与结构化 JSON 输出
feishu-send --dry-run --json --session <id> report.md

# 6. 查看最近的飞书话题路由（获取 session_id / root_id）
feishu-send --list-topics 10
```

## 3. Node / TypeScript 编程接口

模块路径：`/home/zhangzy/workspace/feishu-agent-bridge/dist/src/unified/feishu-send.js`

```ts
import { sendToFeishu, listFeishuTopics } from '/home/zhangzy/workspace/feishu-agent-bridge/dist/src/unified/feishu-send.js';

const result = await sendToFeishu({
  session: 'e1530534-edd6-4ca4-aa84-755e7b809489', // 可选；也可传 rootMessageId / chatId / latest
  title: '阶段交付',                              // 可选
  caption: '实验报告与曲线图',                     // 可选
  files: ['/abs/path/to/report.md', '/abs/path/to/chart.png'],
  asFile: false,                                   // 可选
  dryRun: false,                                   // 可选
});
```

## 4. 与飞书话题内 `/deliver` 的分工

| 入口 | 发起方 | 典型场景 |
| :--- | :--- | :--- |
| `feishu-send` | 本机终端 / 脚本 / Agent 主动推送 | Agent 刚生成报告/图表/PDF，主动把文件推到当前飞书话题方便手机直接查看 |
| 话题内 `/deliver <路径>` | 用户在飞书聊天窗口手动触发 | 用户自己在手机端主动拉取会话项目目录里的某个文件 |
