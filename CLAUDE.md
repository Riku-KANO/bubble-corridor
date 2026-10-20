@AGENTS.md

## Claude Code 向け補足

- 親（このリポジトリで対話・ループを回すセッション）は**テストの作成・レビュー・統合**を担い、実装は Agent ツールで `implementer`（Sonnet）に委任する。委任時は対象の要件 ID、先に書いたテストのパス、触ってよいパス、worktree のパスとポート、守る設計原則を渡す。
- 並行するスライスは、`scripts/worktree.sh add <ID>` で作った worktree ごとに `implementer` を1つずつ同時に走らせる（1つのメッセージで複数の Agent 呼び出し）。implementer には「その worktree の中だけで作業する」と明示する。
- レビューは `reviewer`（Opus、読み取り専用）。見た目の担当（部屋・画面効果・材質・画面）は、`pnpm snap` の画像も判定材料に渡す。
- 統合は親が行う: worktree で `scripts/check.sh --quick` → コミット → main で `git merge --no-ff slice/<ID>` → main で `scripts/check.sh --quick` → `pnpm spine set <ID> integrated`。push はしない。
- 定期開発は `/development-loop`。`/loop 30m /development-loop` から呼べる。停止を無人で解除しない。
- 設計書の原本（Claude Docs）を更新したら `docs/spec.md` を取り直す（先頭のコメントに rev と日付）。
