# src/core — 案1と案2で共有する部品（和集合 0.4.0）

案1「ビードロの向こう」と案2「泡沫回廊」が、それぞれのリポジトリに同じ中身で置く共通部品。
設計書「案1との共有、判断記録と未決事項 › 共通の部品」の表に対応する。変更の歴史は [CHANGELOG.md](CHANGELOG.md)。

0.4.0 で、別々に育った案1（0.3.0）と案2を1つの和集合にした。役目が重なるところは**どちらも残し**、下の「使い分け」で選ぶ。

## 部品の一覧

| 部品 | ファイル | 出どころ | 状態 |
|---|---|---|---|
| ガラスの材質（透過の近景。屈折・吸収・薄膜干渉・溶け合った泡・重なりのセンサー） | glass/ | 案1 | 実装済み |
| ガラスの材質（縁の反射と薄膜干渉。透過を使わない。VR・多数の飾り向け） | materials/glass.ts | 案2 | 実装済み（S-12） |
| 曇りと指の文字の効果（canvas 2D） | fog/condensation.ts | 案2 | 実装済み（S-12） |
| 動きの曲線 | transition/curve.ts（`glassEase`）、easing.ts（`easeGlass` ほか） | 案1・案2 | 実装済み。ガラスの曲線は1つ |
| 遷移の進行（逆再生・待ち・Esc） | transition/ | 案1 | 実装済み |
| 品質プリセットの表（low / mid / high） | quality.ts | 案1 | 実装済み |
| 端末の自動判定と、描画の間隔で動く動的な解像度 | quality-tier.ts | 案2 | 実装済み（S-12） |
| 品質の自動選択・GPU 時間の動的解像度・governor | perf/ | 案1 | 実装済み |
| レンダラの生成、フレーム時間の統計、URL スイッチ、検証用シーンの契約 | renderer.ts, bench.ts, params.ts, scene.ts | 案1 | 実装済み |
| 音の仕組み（音階・拍・立体音響・残響） | sound/scale.ts, sound/grid.ts, sound/space.ts | 案2 | 実装済み（S-11） |
| ガラスの音源（実録音の代わりに合成。ADR-0003） | sound/voices.ts | 案2 | 実装済み（S-11） |
| 音量の系統（全体・音楽・効果音・環境音） | sound/mixer.ts | 案2 | 実装済み |
| 型つきイベント、保存 | events.ts, storage.ts | 案2 | 実装済み |

## 使い分け

### ガラス: `glass/`（案1）と `materials/glass.ts`（案2）

どちらも「ガラスの材質を作る」が、作り方と向く場面が違う。`GlassKind`・`GlassOptions`・`createGlass` のような名前が両方にあるが、別のモジュールなので import の元で選ぶ（混ぜない）。

| | `glass/`（案1） | `materials/glass.ts`（案2） |
|---|---|---|
| 見せ方 | 近景は `MeshPhysicalNodeMaterial` の**透過**（屈折・吸収・分散）。遠景は透過なしの半透明 | **透過を使わない**。縁の反射（フレネル）と薄膜干渉の虹色 |
| 向く場面 | 近くで見るガラスの質感を最優先する。奥に透過ガラスが重なる場所は、`glass/policy.ts` が遠景側を安価な表現に切り替える | VR・多数の飾り。透過の背景画像の制約（1回の描画で1度だけ写る）を避けたい |
| 種類 | 透明・曇り・琥珀・瑠璃・翡翠・気泡入り・虹色・乳白 | 透明・曇り・色・虹色・乳白・鏡 |
| 品質の入力 | `QualityPreset`（`quality.ts`） | `QualityTier`（`quality-tier.ts`）。アプリが `setDefaultGlassTier` で一度決める |
| 触れた反応 | 材質は反応の仕組みを持たない | `pulse`（波紋）、`setHighlight`（縁の光）、`sharedGlass`（引数の同じ材質の共有） |

### 品質: `quality.ts`（案1）と `quality-tier.ts`（案2）

- `quality.ts`: プリセットの**表**（`QUALITY_PRESETS`）。段は `low` / `mid` / `high`（`QualityLevel`）。`QualityPreset` は renderScale・transmissionScale・dispersion・影・アンチエイリアスの方式を持つ。`glass/` と `perf/` がこれを使う。
- `quality-tier.ts`: 端末の手がかりから**段を決める**（`detectTier`。段は `low` / `medium` / `high` で、`QualityTier`）と、その段の描画設定を返す（`presetFor` → **`TierPreset`**。画素比・倍率・fps の目標・後処理・粒子と環境画像の量）、
  描画の間隔で動く `DynamicResolution`。
- 型の名前が似ているので注意: 案1の `QualityPreset`（`quality.ts`）と案2の `TierPreset`（`quality-tier.ts`）は**別の型**（0.4.0 で案2の側を `QualityPreset` から改めた）。段の名前も `mid` と `medium` で違う。変換はしない。

### 動的な解像度: `perf/dynamic-resolution.ts`（案1）と `quality-tier.ts` の `DynamicResolution`（案2）

どちらも同じ名前のクラスだが別物。

- 案1 `perf/dynamic-resolution.ts`: **GPU 時間**（タイムスタンプ）で動かす。5個の中央値と EMA、ヒステリシス。`perf/governor.ts`（品質の自動選択 → 切り替え → 測り直し → 動的解像度）に組み込まれて使う。
  GPU のタイムスタンプを信用できないとき（Apple/Metal）は止まる。
- 案2 `quality-tier.ts` の `DynamicResolution`: **`requestAnimationFrame` の間隔**（ms）をそのまま `sample()` に渡す。約0.5秒の窓の中央値で判断し、重ければすぐ下げ、軽くなっても待ってから試しに戻す。
  GPU のタイムスタンプに頼らないので、VR や垂直同期で固定された画面でも動く。

### 動きの曲線

ガラスらしい「ゆっくり始まって粘りながら止まる」曲線は1つ。実体は `transition/curve.ts` の `glassEase`（`cubic-bezier(0.55, 0, 0.2, 1)`、DOM 用の `GLASS_EASE_CSS` もある）。
`easing.ts` の `easeGlass` は `glassEase` を呼ぶだけの別名で、同じ値を返す。`easeInOutSine`・`easeOutCubic`・`smoothstep`・`lerp`・`wrapAngle`・`damp` は `easing.ts` にそのまま残る。

## 決まり

- **core の外を import しない**（`three` などの外部パッケージは可）。`scripts/check-core.ts` が検査する。
- 案1と案2それぞれの固有の名前（案2の区間・部屋・キュー、案1の場面など）を持ち込まない。必要なら引数で受け取る。
- 変更したら VERSION と CHANGELOG.md を更新する。相手のリポジトリへは `pnpm core:sync` でコピーする（相手の版の方が新しいときは止まる。先に相手から取り込む）。
- 案1から取り込んだファイル（glass/、perf/、transition/、renderer.ts、bench.ts、params.ts、scene.ts、quality.ts）は、こちらで書き換えない。直したいときは案1で直して取り込む。

## ガラスの使い方: `materials/glass.ts`（案2）（飾りは共有し、前の部屋で先にコンパイルする）

- 材質1つの組み立ては数 ms かかる（200 個を `createGlass` で作ると約 1 秒止まる）。温室の植物・雨粒・星の玉のような
  **飾りのガラスは `sharedGlass(kind, params, opts)` で共有する**（種類・tier・引数が同じなら同じ材質）。
  共有したハンドルの縁の光（`setHighlight`）・波紋（`pulse`）・時刻（`setTime`）は共有している全員に効く。
  触れられる物だけを `createGlass` で個別に作る。`dispose` は呼んだ数だけ数え、全員が手放したときに材質を解放する。
- **次の部屋の材質は、前の部屋にいる間に `renderer.compileAsync(scene, camera)` で先にコンパイルする**（部屋の境目の膜で止めないため）。
- アプリは起動時に `setDefaultGlassTier(tier)` で品質を一度決める（各所で `tier` を渡さなくてよい）。
- 部屋の空気に合わせて、擬似反射の照明を `setGlassLighting({ sky, ground, keyDir, keyColor, keyIntensity })` で変える
  （`scene.environment` があれば擬似反射は弱まり、環境画像の反射が主になる）。
- 光の点滅を抑えるモードでは `setGlassFlashScale(0.3)` のように波紋の閃光を弱める。
- 泡の内側から見る殻（ゴンドラ、天球）は `doubleSided: true` で作る。既定のまま使えば、内側から見たとき視界の中央は澄み、虹色は視界の外周だけにかすかに出る
  （カメラが殻の境界球の内側に入ると自動で切り替わる）。面全体に色を出したい膜の板は `face` を上げる（上げた分だけ内側扱いにならない）。
- 動的な解像度（`quality-tier.ts` の `DynamicResolution`）には、`requestAnimationFrame` の間隔（ms）をそのまま `sample()` に渡す（垂直同期で固定された画面でよい）。
