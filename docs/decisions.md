# 判断記録（ADR）

設計書「決めたこと」の表は作品の判断。ここは実装の判断を、新しいものを下に足す。

## ADR-0001 描画の土台は three/webgpu（WebGPURenderer＋TSL）（2026-10-21、仮）

- 設計書: 土台は Three.js と TypeScript。VR は WebGL2 の経路。M0 で WebGPURenderer の WebGL2 経路で VR が使えるかを確かめる。
- three r186 の WebGPURenderer は `XRManager` と `RenderPipeline` を持つ。材質と画面効果は TSL で書き、WebGPU・WebGL2（`forceWebGL`）・VR で同じ部品を使う。
- **M0 の関門1で確定する**。使えなければ VR 版だけ WebGLRenderer にし、共通部品のシェーダを2系統で持つ（設計書のリスク表）。

## ADR-0002 Blender のパイプラインを設計書どおりに使う（2026-10-21、改訂）

- 当初「Blender がない」としてコードのプレビズで代える判断をしたが、確認の誤りだった（PATH だけを見ていた）。Blender 5.2.2 LTS が `/Applications/Blender.app` にあり、ヘッドレス（`-b --factory-startup -P`）で glTF の書き出し、Cycles の焼き込み（Metal GPU）、Eevee の描画ができることを確かめた。
- 設計書「Blenderパイプライン」の流れに従う: レールと部屋の仮の形・カメラ・タイムラインマーカー・仮の楽曲でプレビズ（`blender/scenes/previz.blend`）を組み、通しの動画を Eevee で書き出す → 酔いの確認 → 部屋の本番の造形 → 見えない面の削除 → 焼き込み → 部屋ごとの glb とライトマップ、rail.json、cues.json を書き出す。
- 呼び出しは `scripts/blender.ts`（`BLENDER` の環境変数 → `/Applications/Blender.app/...` → PATH の順に探す）。造形はスクリプト（bpy）で作り、再現できるようにする。人が .blend を開いて直したら、書き出しのスクリプトで JSON と glb を作り直す。
- レールの最初の種は `generateRideData()`（TS）。プレビズに取り込んだ後は Blender が正で、書き出した `public/assets/rail.json` を実行時もテスト（`src/rooms/testing.ts`）も使う。
- 部屋の glb には画像を埋め込まない（ライトマップは別の画像。node のテストでも glb を読める）。部屋の担当は glb の形と焼き込みの上に、触れられる物・動き・ガラスの材質を TS で重ねる。
- 座標: rail.json と glb は three.js の向き（Y が上）。Blender（Z が上）との変換は書き出しと取り込みのスクリプトが受け持つ。
- `blender/scripts/common/` は案1と共有する（`src/core` と同じくコピーで揃える。ADR-0005）。

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
