# 判断記録（ADR）

設計書「決めたこと」の表は作品の判断。ここは実装の判断を、新しいものを下に足す。

## ADR-0001 描画の土台は three/webgpu（WebGPURenderer＋TSL）（2026-10-21、仮）

- 設計書: 土台は Three.js と TypeScript。VR は WebGL2 の経路。M0 で WebGPURenderer の WebGL2 経路で VR が使えるかを確かめる。
- three r186 の WebGPURenderer は `XRManager` と `RenderPipeline` を持つ。材質と画面効果は TSL で書き、WebGPU・WebGL2（`forceWebGL`）・VR で同じ部品を使う。
- **M0 の関門1で確定する**。使えなければ VR 版だけ WebGLRenderer にし、共通部品のシェーダを2系統で持つ（設計書のリスク表）。

## ADR-0002 Blender の代わりにコードでプレビズを作る（2026-10-21）

- この開発環境に Blender がない。設計書の流れ（絵コンテ → Blender のプレビズ → 本番の造形 → 焼き込み → 書き出し）のうち、
  レール・時刻表・キューシートは同じ形の JSON をコード（`scripts/build-ride-data.ts`、`buildCueSheet`）で作り、部屋の形もコードで作る。
- `rail.json` と `cues.json` の形は Blender の書き出しと同じにする（`src/contracts/ride.ts`）。Blender が使えるようになったら書き出しに差し替える。
- 部屋の形はレールの点（`ride.pointAt`）を基準に置く。レールが変わっても部屋が追従する。

## ADR-0003 ガラスの音は合成で作る（2026-10-21）

- 設計書はガラスの実録音（ワイングラス、ガラス瓶、風鈴、ガラスの器）を使う。録音が揃うまで Web Audio の合成（加算・FM・減衰の速い倍音）で作る。
- 音色の名前と引数（`src/core/sound/voices.ts`）は録音に差し替えても変えない。

## ADR-0004 並行開発は「担当の範囲・契約・worktree」（2026-10-21）

- destroyer-game の方式（担当ごとの範囲と契約、STUB の差し替え）と、game-design-agents の方式（スパイン、テスト先行、implementer / reviewer、スライスごとの worktree）を合わせる。
- 契約は `src/contracts/*`、`src/config.ts`、`src/core` の署名。変えるのは統合担当だけ。
- スライスは `.claude/worktrees/<ID>`（ブランチ `slice/<ID>`）で進め、検査とレビューを通ったら統合担当が main へマージする（発案者の指示 2026-10-21「自動で統合」。push はしない）。

## ADR-0005 共通部品は両方のディレクトリに置き、コピーで揃える（2026-10-21）

- 設計書「並行して進める方法」。`src/core` は案1（~/develop/through-the-vidro）にも同じものを置く。ディレクトリをまたいで参照しない。
- `src/core/VERSION` と `src/core/CHANGELOG.md` で版を揃え、`pnpm core:sync <相手>` でコピーする。相手のリポジトリで作業中のものを上書きしないよう、相手の VERSION が新しければ止まる。

## ADR-0006 書体（2026-10-21、案1と共通）

- 細めの明朝体は Zen Old Mincho、細身のサンセリフは Noto Sans JP（300）。@fontsource から自サイトで配信する（外部オリジンに依存しない）。

## ADR-0007 型と Lint（2026-10-21）

- TypeScript 6 ＋ typescript-eslint（destroyer-game と同じ組み合わせ）。生の HTML の挿入と動的なコード実行は Lint で禁止。
