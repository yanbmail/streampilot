#!/usr/bin/env bash
# 把本地仓库推送到远程（GitHub / Gitee / 自建 GitLab 都适用）
#
# 用法：
#   ./scripts/publish.sh                      # 推到已配置的 origin（默认指向 GitHub）
#   ./scripts/publish.sh <远程仓库地址>        # 换一个远程地址并推送
#
# 前提：本地已完成 git init 并至少有一次提交（仓库里已经做好了）。

set -euo pipefail
cd "$(dirname "$0")/.."

DEFAULT_REMOTE="https://github.com/yanbmail/streampilot.git"
REMOTE_URL="${1:-}"

if [ ! -d .git ]; then
  echo "✗ 当前目录不是 git 仓库"
  exit 1
fi

if [ -n "$REMOTE_URL" ]; then
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$REMOTE_URL"
    echo "· 已更新 origin 地址"
  else
    git remote add origin "$REMOTE_URL"
    echo "· 已添加 origin"
  fi
elif ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "$DEFAULT_REMOTE"
  echo "· 已添加默认 origin：$DEFAULT_REMOTE"
fi

git branch -M main
echo "· 正在推送 main 分支…"
git push -u origin main

echo
echo "✓ 推送完成：$(git remote get-url origin)"
echo "  以后改完代码只要：./scripts/sync.sh \"改了说明\""
