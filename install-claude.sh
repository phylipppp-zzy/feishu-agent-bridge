#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$PROJECT_DIR"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: ./install-claude.sh [--existing-app <cli_xxx> | --from-env] [--no-hooks]

  no option                 Create a new self-built Feishu app by QR code.
  --existing-app <cli_xxx>  QR-authorize and configure an existing self-built app.
  --from-env                Use a manually configured ~/.config/feishu-claude-bridge/env.
  --no-hooks                Do not register the session-state hooks in Claude Code settings.json.
EOF
  exit 0
fi

for argument in "$@"; do
  if [[ "$argument" == "--container" ]]; then
    echo "Claude Code 桥接的安装器暂不支持 --container。" >&2
    exit 1
  fi
done

if [[ "${EUID}" -eq 0 ]]; then
  echo "请以实际使用 Claude Code 的普通用户执行安装器，不要使用 sudo。" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  cat >&2 <<'EOF'
需要 Node.js 22 或更新版本以及 npm。请以当前用户执行：

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 22
nvm use 22

完成后重新运行 ./install-claude.sh。
EOF
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 )); then
  cat >&2 <<EOF
需要 Node.js 22 或更新版本；当前为 $(node --version)。请执行：

. "\$HOME/.nvm/nvm.sh"
nvm install 22
nvm use 22

完成后重新运行 ./install-claude.sh。
EOF
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  cat >&2 <<'EOF'
未在 PATH 中找到 Claude Code CLI（claude）。请执行：

curl -fsSL https://claude.ai/install.sh | bash

完成后重新运行 ./install-claude.sh。
EOF
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "当前安装器仅支持带 systemd 的 Linux。" >&2
  exit 1
fi

echo "[1/4] 安装锁定版本的 Node.js 依赖"
npm ci
echo "[2/4] 检查源码"
npm run check
echo "[3/4] 运行测试并构建"
npm test
npm run build
echo "[4/4] 创建飞书应用、注册 Claude Code hook 并安装用户服务"
exec node scripts/install-claude.mjs "$@"
