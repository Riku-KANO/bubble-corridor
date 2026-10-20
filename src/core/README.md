# src/core — 案1と共有する部品

設計書「案1との共有、判断記録と未決事項 › 共通の部品」の表に対応する。

| 部品 | ファイル | 状態 |
|---|---|---|
| ガラスの材質ライブラリ | materials/glass.ts | 実装済み（S-12） |
| 曇りと指の文字の効果 | fog/condensation.ts | 実装済み（S-12） |
| 遷移の仕組み（動きの曲線） | easing.ts | 実装済み |
| 音の仕組み（音階・拍・立体音響・残響） | sound/scale.ts, sound/grid.ts, sound/space.ts | STUB（M0） |
| ガラスの音源 | sound/voices.ts | STUB（実録音の代わりに合成。ADR-0003） |
| 品質プリセットと自動判定 | quality.ts | 実装済み（S-12） |
| 型つきイベント、保存 | events.ts, storage.ts | 実装済み |

## 決まり

- **core の外を import しない**（`three` などの外部パッケージは可）。`scripts/check-core.ts` が検査する。
- 案2固有の名前（区間、部屋、キュー）を持ち込まない。必要なら引数で受け取る。
- 変更したら VERSION と CHANGELOG.md を更新する。相手のリポジトリへは `pnpm core:sync` でコピーする。

## ガラスの使い方（飾りは共有し、前の部屋で先にコンパイルする）

- 材質1つの組み立ては数 ms かかる（200 個を `createGlass` で作ると約 1 秒止まる）。温室の植物・雨粒・星の玉のような
  **飾りのガラスは `sharedGlass(kind, params, opts)` で共有する**（種類・tier・引数が同じなら同じ材質）。
  共有したハンドルの縁の光（`setHighlight`）・波紋（`pulse`）・時刻（`setTime`）は共有している全員に効く。
  触れられる物だけを `createGlass` で個別に作る。`dispose` は呼んだ数だけ数え、全員が手放したときに材質を解放する。
- **次の部屋の材質は、前の部屋にいる間に `renderer.compileAsync(scene, camera)` で先にコンパイルする**（部屋の境目の膜で止めないため）。
- アプリは起動時に `setDefaultGlassTier(tier)` で品質を一度決める（各所で `tier` を渡さなくてよい）。
- 部屋の空気に合わせて、擬似反射の照明を `setGlassLighting({ sky, ground, keyDir, keyColor, keyIntensity })` で変える
  （`scene.environment` があれば擬似反射は弱まり、環境画像の反射が主になる）。
- 光の点滅を抑えるモードでは `setGlassFlashScale(0.3)` のように波紋の閃光を弱める。
- 泡の内側から見る殻（ゴンドラ、天球）は、既定のまま使えば正面（視界の中央）は澄んでいる。面全体に色を出したい膜の板は `face` を上げる。
- 動的な解像度（`DynamicResolution`）には、`requestAnimationFrame` の間隔（ms）をそのまま `sample()` に渡す（垂直同期で固定された画面でよい）。
