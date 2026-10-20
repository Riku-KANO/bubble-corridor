#!/usr/bin/env bash
# スライスごとの worktree（ADR-0004）。
#   scripts/worktree.sh add S-10      .claude/worktrees/S-10 をブランチ slice/S-10 で作り、依存を入れる
#   scripts/worktree.sh remove S-10   片付ける（ブランチは残す。マージ済みなら git branch -d で消す）
#   scripts/worktree.sh list
#   scripts/worktree.sh ports S-10    この worktree で使う DEV_PORT / E2E_PORT / PREVIEW_PORT
set -euo pipefail
cd "$(dirname "$0")/.."
cmd="${1:-list}"; id="${2:-}"
ports() { n="${1#S-}"; n=$((10#$n)); echo "DEV_PORT=$((5200 + n)) PREVIEW_PORT=$((4300 + n)) E2E_PORT=$((4400 + n))"; }
case "$cmd" in
  add)
    [ -n "$id" ] || { echo "使い方: worktree.sh add <ID>"; exit 1; }
    dir=".claude/worktrees/$id"
    if [ -d "$dir" ]; then echo "既にあります: $dir"; else
      git worktree add "$dir" -b "slice/$id" main
      (cd "$dir" && pnpm install --frozen-lockfile --offline >/dev/null 2>&1 || pnpm install --frozen-lockfile >/dev/null)
    fi
    echo "$dir  ($(ports "$id"))"
    ;;
  remove)
    [ -n "$id" ] || { echo "使い方: worktree.sh remove <ID>"; exit 1; }
    git worktree remove ".claude/worktrees/$id" --force
    ;;
  list) git worktree list ;;
  ports) ports "$id" ;;
  *) echo "不明なコマンド: $cmd"; exit 1 ;;
esac
