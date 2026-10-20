---
name: development-loop
description: Claude の定期実行または /loop から開発スパインを一巡進める。並行に着手できるスライスを worktree ごとに同時に進め、永続チェックポイント・重複起動防止・上限と停滞による停止を使う。単発のスライス指定には /slice を使う。
---

# 開発ループの一巡

作業ディレクトリはこのスキルを含むリポジトリのルート（main の checkout）。AGENTS.md と CLAUDE.md を読む。
定期実行の各回は新しいセッションなので、会話の履歴ではなく process/spine.yaml とチェックポイント（`pnpm loop`）を使う。
親は Opus、実装担当は Sonnet、レビューは Opus。

1. `pnpm -s loop begin` を一度実行する。
   - `action: skip` は別の実行中。編集・委任を始めず終える。
   - `action: stop` は停止状態。理由が新しく発生したときだけ発案者に伝える。このスキルから `resume` しない。
   - エラー・JSON 不正・コマンド実行不可も着手しない。内容を発案者に報告する。
2. `action: run` の token、slices（並行に進める組）、deadline、previous_summary を引き継ぐ。
   main で `git status --short` を見て、前回の対象外の差分があれば触らずに残す（同じ checkout で別の作業をしていない前提。していたら blocked で終える）。
3. slices の各スライスを `.claude/skills/slice/SKILL.md` の手順で進める。
   - テストの作成と赤の確認は親が順に行い、`implementer` への委任は**1つのメッセージで同時に**出す（worktree ごとに1つ）。
   - 緑の確認とレビューも、終わったものから順に行う。レビューの依頼は並行してよい。
   - 実装は累積最大3試行、レビューは累積最大2巡。notes から消費回数を復元し、各委任・レビューの前に notes へ保存する。
   - テストの変更・依存の追加を実装担当に許可しない。必要なら理由を残して blocked。
4. 新しい工程・委任の前に `pnpm -s loop status --token <token>` で有効か・期限内かを確かめる。
   終了10分前には新しい委任を始めず、結果を回収して notes に残す。子エージェントにも期限を伝える。
5. 統合は親が行う（AGENTS.md「統合」。発案者の指示 2026-10-21 により自動で main へマージしてよい。push・デプロイはしない）。
   統合のたびに main で `scripts/check.sh --quick` を回し、赤なら直すか、そのマージを戻して blocked。
6. 終わりに必ず finish する。結果が不明なら成功とせず blocked。

   ```sh
   pnpm -s loop finish --token <token> --outcome continue --summary '<対象、テスト結果、レビュー結果、統合、残件、次工程>'
   pnpm -s loop finish --token <token> --outcome blocked --summary '<試したこと、停止理由、必要な判断>'
   ```

停止条件: 3回続けて進捗なし、12起動、初回から600分、一巡90分、stop_before のスライスの手前、関門の人の確認待ち、要件・設計の判断待ち、手動停止。上限は process/development-loop.json が正。停止中の繰り返し起動では同じ報告を繰り返さない。完了・新しい障害・判断の依頼を報告する。
