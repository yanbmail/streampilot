#!/usr/bin/env bash
# 一键同步：把本地改动提交并推到远端（默认 GitHub）
#
# 用法：
#   ./scripts/sync.sh                 # 自动生成提交说明（带时间戳）
#   ./scripts/sync.sh "修了开机卡顿"   # 自定义提交说明

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d .git ]; then
  echo "✗ 当前目录不是 git 仓库"
  exit 1
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "✗ 还没配置远端，先跑一次：./scripts/publish.sh"
  exit 1
fi

MSG="${1:-chore: 同步更新 $(date '+%Y-%m-%d %H:%M')}"

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "$MSG"
  echo "· 已提交：$MSG"
else
  echo "· 没有本地改动，直接尝试推送"
fi

BRANCH="$(git branch --show-current)"
git push origin "$BRANCH"
echo "✓ 已同步到 $(git remote get-url origin) [$BRANCH]"
