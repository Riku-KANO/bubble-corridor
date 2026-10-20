---
name: slice
description: 開発スパインのスライスを1つ進める手順（要件 ID → 振る舞いテスト → 赤 → implementer 委任 → 緑 → レビュー → 統合）。/slice S-10 のように呼ぶ。複数を並行に進めるときは、スライスごとにこの手順を worktree で回す。
---

# /slice — スライスを1つ進める

引数: スライス ID（例: S-10）。省略時は `pnpm spine next`。並行の組は `pnpm spine ready`。

再開時は既存テスト・差分・スパインの notes を読んで状態を確かめる。red は対象テストを再実行し、失敗なら委任へ。green は検査を再実行してレビューへ。reviewed は統合へ。

手順（ゲートを飛ばさない）:

1. **要件の確認**: `pnpm spine show <ID>`。docs/requirements.md の該当 ID、docs/spec.md の該当節、契約（src/contracts、src/config.ts、STUB の署名）を読む。
2. **作業場所**: `scripts/worktree.sh add <ID>` で `.claude/worktrees/<ID>`（ブランチ `slice/<ID>`）を作る。ポートは `scripts/worktree.sh ports <ID>`。以降のテスト作成・委任・検査はこの worktree の中で行う。
3. **テスト作成（親）**: 受け入れ基準を振る舞いテストに落とす（`describe` に要件 ID）。実装の細部ではなく、契約の入出力と設計書の数値で書く。見た目の担当は、純粋なロジック（配置の計算、時刻 → 状態の関数）をテストし、見た目は snap で確かめる。`pnpm spine set <ID> red`。
4. **ゲート: 赤**: 対象テストが意図した未実装（STUB）で失敗することを確認し、コマンドと失敗の要点を `pnpm spine note <ID> '<...>'` に残す。初めから通るなら、テストが不十分か既に実装済みかを確かめる。
5. **委任**: Agent ツールで `implementer`（Sonnet）に委任する。渡すもの: スライス ID、要件 ID と受け入れ基準の要約、テストのパス（変更禁止）、触ってよいパス、worktree のパスとポート、完了条件（`scripts/check.sh --quick` ALL OK）、反復上限3、見た目の担当なら確認ページと snap での自己確認。委任の前に試行回数を notes に保存する（「実装 消費 1/3」）。
6. **ゲート: 緑**: worktree で `scripts/check.sh --quick` が ALL OK を自分で確かめる。通らなければ失敗の要点を添えて委任に戻す（最大3試行。超えたらテストか設計を見直し、必要なら blocked）。`pnpm spine set <ID> green`。
7. **レビュー**: `reviewer`（Opus）に判定を依頼する（委任の前に「レビュー 消費 1/2」を notes に保存）。P1・P2 があれば実装に戻す（レビュー最大2巡）。見た目の担当は snap の画像のパスを渡す。
8. **文書の同期**: 要件・判断（docs/decisions.md）・関門・AGENTS.md・src/core/CHANGELOG.md に変更があれば同時に更新し、検査を再実行する。`pnpm spine set <ID> reviewed`。
9. **統合**: worktree でコミット（メッセージ: `S-xx: <題>`＋要点）。main で `git merge --no-ff slice/<ID>`、`scripts/check.sh --quick` を回し、緑なら `pnpm spine set <ID> integrated` と notes（所要、試行回数、レビューの巡回数と指摘数）をコミット。衝突したら main 側の契約を正として解く。`scripts/worktree.sh remove <ID>`。**push はしない**。

記録: スライスの所要時間、委任の試行回数、レビューの巡回数・指摘数を notes に残す（`pnpm spine note`）。上限（実装3試行・レビュー2巡）はセッションをまたいで数え、notes から復元する。
