# 泡沫回廊（bubble-corridor）

シャボン玉のようなガラスのゴンドラに乗り、5つのガラスの部屋を巡る約13分のライド型ブラウザ体験。英題「Utakata: A Ride Through Glass」。
設計書は [docs/spec.md](docs/spec.md)（原本は Claude Docs「泡沫回廊 企画・設計書」https://claude.ai/artifact/9zLziSKmevDRkkzLQSNtXF ）。
数値は設計書に従い [src/config.ts](src/config.ts) に集める。要件 ID は [docs/requirements.md](docs/requirements.md)、関門は [docs/gates.md](docs/gates.md)、実装の判断は [docs/decisions.md](docs/decisions.md)。

姉妹作の案1「ビードロの向こう」は `~/develop/through-the-vidro` で並行して作る。共通部品 [src/core](src/core/README.md) は両方のディレクトリに同じものを置き、ディレクトリをまたいで参照しない（ADR-0005）。

技術: three.js r186 の `three/webgpu`（WebGPURenderer＋TSL。WebGL2 と VR の経路も同じ部品）、TypeScript、Vite 8、Web Audio、WebXR。配信は Cloudflare の静的配信（M4）。パッケージ管理は **pnpm のみ**。

## コマンド

| 目的 | コマンド |
|---|---|
| 開発サーバー | `pnpm dev`（http://localhost:5173、`DEV_PORT` で変える） |
| 単体テストを監視 | `pnpm test:watch` |
| 検査（速い） | `scripts/check.sh --quick`（core の境界・スパイン・型・Lint・単体） |
| 検査（すべて） | `scripts/check.sh`（＋ビルド・動きの上限・e2e） |
| 見どころを撮る | `pnpm snap ride`（`--only bloom,freeze`、`--mobile`、`--webgl`。画像は `.snaps/`） |
| 画面の流れを撮る | `pnpm snap screens` |
| 途中から乗る・早送り | URL に `?debug&t=590`、`?debug&t=0&rate=20`（[src/app/params.ts](src/app/params.ts)） |
| 動きの上限の検査 | `pnpm comfort` |
| スパイン | `pnpm spine list|next|ready|show|set|note|validate` |
| 開発ループの実行権 | `pnpm loop begin|status|finish|stop|resume` |
| スライスの worktree | `scripts/worktree.sh add|remove|list|ports <ID>` |
| 共通部品を案1へコピー | `pnpm core:sync ../through-the-vidro [--apply]` |

## 開発ループ（ループエンジニアリング）

小さく作って、機械に確かめさせて、直す。この輪を速く回すことを最優先にする。

1. **内側の輪（秒）**: 純粋なロジックはテストを先に書く。`*.test.ts` を実装の隣に置き、`pnpm test:watch` で回す。
2. **中の輪（分）**: `scripts/check.sh --quick` を緑にしてから報告・コミットする。赤のままコミットしない。
3. **外の輪（数分）**: 見た目・手触り・音は確認ページ `dev/<担当>.html`（本番ビルドに含まれない）と `pnpm snap` で確かめる。撮った画像は Read で開いて目で見る。
4. **関門（マイルストーン）**: [docs/gates.md](docs/gates.md) の関門を満たすまで次の段階へ進まない。

失敗したら: エラーを読む → 最小の再現（テスト）を書く → 直す → 輪を回し直す。同じ修正を3回試して直らなければ、前提を疑って設計を見直す。

### スライスの進め方（グラフ。ゲートを飛ばさない）

スパイン [process/spine.yaml](process/spine.yaml) の1件 = 1スライス。手順は [.claude/skills/slice/SKILL.md](.claude/skills/slice/SKILL.md)。

要件 ID を確認 → **親が振る舞いテストを書く**（テスト名に要件 ID）→ **赤**を確認して notes に証跡 → `implementer` に委任（最大3試行、テストの変更と依存の追加は禁止）→ `check.sh --quick` で**緑** → `reviewer` が判定（最大2巡）→ 文書を同期 → **統合**（親がコミットし main へマージ）。

- 並行: 同じ wave で paths が重ならないスライスは、それぞれの worktree（`.claude/worktrees/<ID>`、ブランチ `slice/<ID>`）で同時に進める。`pnpm spine ready` が組を出す。
- 統合: 検査とレビューを通ったら親が main へマージしてよい（発案者の指示 2026-10-21）。**push はしない**。
- 定期実行: `/development-loop`（[.claude/skills/development-loop/SKILL.md](.claude/skills/development-loop/SKILL.md)）。上限は [process/development-loop.json](process/development-loop.json)。停止を無人で解除しない。

## 構成と担当（並行開発）

各担当は自分の範囲のファイルだけを編集する。境界は**契約**で定める。

| 範囲 | 担当 | 主なファイル |
|---|---|---|
| 統合・アプリ本体 | main | `src/app/**`、`src/main.ts`、`src/contracts/**`、`src/config.ts`、`src/rooms/index.ts`、`src/rooms/placeholder.ts`、設定ファイル類、`e2e/smoke.spec.ts`、`e2e/ride.spec.ts` |
| 乗り物と時間 | ride | `src/ride/**`、`scripts/build-ride-data.ts`、`scripts/comfort.ts`、`public/assets/rail.json`・`cues.json` |
| 音楽と音 | audio | `src/audio/**`、`src/core/sound/**` |
| 共通部品（見た目） | core-visual | `src/core/materials/**`、`src/core/fog/**`、`src/core/quality.ts` |
| 画面 | ui | `src/ui/**`、`src/styles/**` |
| ライドフォト | photo | `src/photo/**` |
| 見回すと触れる | input | `src/input/**` |
| 画面効果 | fx | `src/fx/**` |
| 部屋A | rooms-a | `src/rooms/lobby/**`、`src/rooms/platform/**`、`src/rooms/greenhouse/**`、`src/gondola/**` |
| 部屋B | rooms-b | `src/rooms/rain/**`、`src/rooms/kaleidoscope/**` |
| 部屋C | rooms-c | `src/rooms/celestial/**`、`src/rooms/dawn/**` |
| VR | xr | `src/xr/**`、`e2e/xr.spec.ts`、`e2e/render-paths.spec.ts` |

各担当は確認ページ `dev/<担当>.html` と `src/dev/<担当>/**` も持てる。

### 契約（変えるときは統合担当と調整する）

- [src/contracts/](src/contracts/)：担当をまたぐ型（区間・部屋・キュー・イベント・時計・レール・部屋・音・写真・画面・入力・VR・画面効果・ゴンドラ）。
- [src/config.ts](src/config.ts)：設計書の数値。
- `src/core` の各ファイルの**エクスポート名と引数**（案1と共有するので特に慎重に）。

契約を変えたくなったら、自分の範囲で回避できないか先に考える。どうしても必要なら、変更内容と理由を最終報告に書く（統合担当がまとめて反映する）。`STUB:` と書かれたファイルは担当が本実装に置き換える前提の仮実装。**エクスポート名・引数・戻り値の型は契約どおりに保つ**。

### 並行開発のルール

- `package.json` と `pnpm-lock.yaml` は統合担当だけが変更する。依存を追加したいときは理由を報告する（サプライチェーン対策は [pnpm-workspace.yaml](pnpm-workspace.yaml)）。
- 他の担当の範囲のファイルは編集しない。必要な変更は報告に書く。
- 並行で動かすときは worktree ごとにポートを変える（`scripts/worktree.sh ports <ID>` の `DEV_PORT`・`PREVIEW_PORT`・`E2E_PORT`）。
- 同じ checkout を複数のセッションで同時に使わない。

## 作品の決まり（設計書の柱）

1. **何もしなくても完成している**: 一切操作しなくても13分が作品として成立する。
2. **触れれば必ず応える**: 0.1秒以内に光と動き、音は楽曲の調と拍に揃える。失敗はない。
3. **カメラの道筋が決まっていることを活かす**: すべての区間を「どこから見て最も美しいか」で配置する。見えない裏側は作らない。
4. **誰も酔わせない**: 速度・加速・上下・回転の上限（config の `MOTION`）。ゴンドラは常に水平。VR でカメラを演出で動かさない。

- 進行の時計は**楽曲の再生時刻**。ゴンドラの位置・演出・画面効果はすべて時刻から計算する（フレームの積み上げで状態を作らない。`?t=` で途中から始めても同じ絵になること）。
- 黒い画面を使わない（例外は天球の2秒の暗転）。光の明滅は1秒に3回未満。光の点滅を抑えるモードを尊重する。
- 乗車中は画面に固定の表示を出さない。

## セキュリティ

- **生の HTML を挿入しない**: `innerHTML`・`outerHTML`・`insertAdjacentHTML`・`document.write` は Lint で禁止。文字列は `textContent` で出す。
- **動的コード実行をしない**: `eval`・`new Function`・文字列の `setTimeout` は禁止。
- **外部のデータは信頼しない**: localStorage・URL パラメータ・JSON は [src/core/storage.ts](src/core/storage.ts) の `own`/`num`/`oneOf`/`subsetOf` などで既知のキーだけを検証して読む。
- **外部オリジンに依存しない**: フォント・画像・音・モデルはすべて自サイトから配信する。
- **秘密情報をコミットしない**。

## コーディング規約

- TypeScript strict。コメントは日本語で「なぜ」を書く。周りのコードの書き方に合わせる。
- 画面に出す文言はすべて i18n のキー（日本語と英語の両方）。
- 設計書の数値はハードコードせず [src/config.ts](src/config.ts) を参照する。設計書に値がない数（「仮」と書いたもの）は config に足して報告する。
- 性能: 毎フレームのオブジェクト生成を避け、作業用のベクトルは使い回す。動く光源は持たない（発光の材質で表現する）。透過（transmission）は使わず、縁の反射と薄膜干渉で見せる。
