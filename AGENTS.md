# feishu-agent-bridge 项目开发与生产运维红线

本文件仅适用于 `/home/zhangzy/workspace/feishu-agent-bridge` 及其子目录，固化生产桥接服务（`feishu-unified-production.service`）的运行约束、发布流程与架构防回归红线。

## 1. 生产部署与安全重启（防自杀会话）

- **严禁同步自重启**：在飞书桥接拉起的 Agent 会话内，**禁止**直接执行同步 `systemctl --user restart feishu-unified-production.service`（会当场杀死当前 ACP 父进程导致回合中断）。
- **标准发布流程**：
  1. 跑完 `npm run check && npm run build && npm test && npm run test:journey`。
  2. 若涉及 SQLite schema 变更，**必须先对生产 `core.sqlite` 备份副本做迁移干跑**，并核验 `PRAGMA integrity_check` 为 `ok`、`PRAGMA foreign_key_check` 为空。
  3. 通过 `scripts/deploy-production.py` 打包不可变 release 并执行离线 `preflight.py`。
  4. 执行 `systemctl --user daemon-reload`，再通过 `systemd-run --user --on-active=10s --unit=feishu-bridge-delayed-restart-<shortsha> systemctl --user restart feishu-unified-production.service` 安排 10 秒延迟平滑重启。

## 2. 生产运行时不可变约束

- **审批纯原端透传**：保持 `approvalPolicy.enabled = false`，禁止擅自在桥接层开启审批策略覆盖。
- **AGY 沙箱与宿主机 AppArmor 强耦合**：生产保持 `agy.sandbox = true` 与 `agy.binPath = "/home/zhangzy/.gemini/bin/agy"`。宿主机（Ubuntu 24.04，`kernel.apparmor_restrict_unprivileged_userns=1`）通过 `/etc/apparmor.d/agy-zhangzy` 仅对 `/home/zhangzy/.gemini/bin/agy` 单二进制放行 `userns`；**严禁随意更改 `agy.binPath` 或放宽全局 `sysctl`**。
- **其余默认项**：保持 `agy.defaultMode = "auto"`、`autoTakeControlOnInput = true`、`autoResumeOnRestart = true`、`Environment=NODE_OPTIONS=--no-warnings`。

## 3. 核心架构防回归红线

- **读写隔离解耦**：写隔离态（`recovery_quarantine`）仅拦截写操作，**严禁阻塞授权用户的只读聊天记录刷新与投影**。
- **禁止用易变 `session.revision` 门控动作**：排队输入取消（`cancelQueuedInput`）按 `inputId` + 归属匹配；控制权释放（`releaseControl`）按 `controlGeneration` 校验，不得依赖随状态流转频繁跳变的 `session.revision`。
- **`turns` 复合主键**：`turns` 表使用 `PRIMARY KEY(session_id, id)`，禁止假设 `step-*` 等回合 ID 全局唯一。
- **`/stop` 原子收口**：活动回合内与回合间 `/stop` 须统一收口活动回合中断与排队输入取消；`waiting_approval` / `waiting_question` 及不可 steer 的 `running` 态下新输入统一自动入队并校验 `channelScope`。

## 4. 测试保真要求

- E2E / 契约测试（如 `scripts/e2e-journey/provider.mjs`）必须反映真实 provider 能力（如 `agy` 与 `claude` 的 `steer: unsupported`）与生产配置（`approvalPolicy.enabled = false`），禁止靠理想化 mock 掩盖协议与并发边界缺陷。
