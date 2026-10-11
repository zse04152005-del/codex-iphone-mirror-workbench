#!/bin/zsh
set -e
cd -- "${0:A:h}"

if curl --noproxy '*' --silent --fail --max-time 2 http://127.0.0.1:4173/api/bootstrap >/dev/null 2>&1; then
  echo "手机工作台已经运行：http://127.0.0.1:4173"
  exit 0
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js。请在终端确认 node 已安装并重新运行。"
  read -r '?按回车退出…'
  exit 1
fi
node_bin="$(command -v node)"

echo "手机工作台：http://127.0.0.1:4173"
echo "保持此窗口打开；按 Control-C 停止服务。"
export PATH="${node_bin:h}:$PATH"
exec "$node_bin" server.mjs
