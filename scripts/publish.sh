#!/usr/bin/env bash
# 把本地仓库推送到远程（GitHub / Gitee / 自建 GitLab 都适用）
#
# 用法：
#   ./scripts/publish.sh git@github.com:你的用户名/streampilot.git
#   ./scripts/publish.sh https://gitee.com/你的用户名/streampilot.git
#
# 前提：本地已完成 git init 并至少有一次提交（仓库里已经做好了）。

set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE_URL="${1:-}"
if [ -z "$REMOTE_URL" ]; then
  echo "用法：./scripts/publish.sh <远程仓库地址>"
  echo "例：  ./scripts/publish.sh git@github.com:yourname/streampilot.git"
  exit 1
fi

if [ ! -d .git ]; then
  echo "✗ 当前目录不是 git 仓库"
  exit 1
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
  echo "· 已更新 origin 地址"
else
  git remote add origin "$REMOTE_URL"
  echo "· 已添加 origin"
fi

git branch -M main
echo "· 正在推送 main 分支…"
git push -u origin main

echo
echo "✓ 推送完成：$REMOTE_URL"
echo "  以后改完代码只要：git add -A && git commit -m \"说明\" && git push"
