# src/core 変更記録

`src/core/` は姉妹作と共通の部品です。案1「ビードロの向こう」（~/develop/through-the-vidro）と
案2「泡沫回廊」（~/develop/bubble-corridor）は、同じ共通部品をそれぞれのディレクトリに置いて使います。
ディレクトリをまたいで参照せず、先に変更した側からもう一方へ `pnpm core:sync <相手のリポジトリ>` でまとめてコピーし、
VERSION とこの記録で揃っているかを確かめます。コピーしたら、受け取った側の VERSION をその版に合わせます。

版の付け方: 互換を壊す変更は minor を上げる（0.x の間）。追加・修正は patch。
0.4.0 より前は、案1が 0.1.0〜0.3.0、案2が 0.1.0 と未リリースで、別々の歴史でした。0.4.0 で両方を1つの記録にまとめています
（0.1.0 は両方にあるので2つ並べています）。

## 0.4.0 — 2026-10-21（S-18 和集合: 案1の 0.3.0 を取り込み、案2の部品と並べた）

案1と案2が別々に育てた src/core を、1つのライブラリの和集合にした。案1の 0.3.0 のファイル（VERSION・CHANGELOG・README を除く）は1バイトも変えずに含み、
名前や役目がぶつかるところだけ、案2の側を動かして整理した。案1へは、案1のセッションが `pnpm core:sync` で受け取る。

### 取り込んだもの（案1の 0.3.0、コミット 8aa3a5c の src/core の30ファイル。中身は同じ）

- `glass/`（透過の近景のガラス。屈折・吸収・薄膜干渉・溶け合った泡・重なりのセンサー）、`perf/`（品質の自動選択・GPU 時間の動的解像度・governor）、
  `transition/`（動きの曲線 `glassEase` と遷移の進行）、`renderer.ts`、`bench.ts`、`params.ts`、`scene.ts`、`quality.ts`（品質プリセットの表）と、それぞれの単体テスト。
- 詳しくは下の 0.3.0・0.2.0・0.1.0（ビードロ）の記録を見る。

### 移したもの（名前のぶつかりの整理）

- 案2の `quality.ts` は案1の `quality.ts`（`QUALITY_PRESETS`、`QualityLevel`、`QualityPreset`）と同じファイル名で役目が違うので、
  案2のほうを `quality-tier.ts` へ移した。`quality.ts` は案1のもの。
  `detectTier`・`presetFor`・`DynamicResolution`・`DeviceHints`・`QualityTier` は `quality-tier.ts` から import する。
- 案2の `QualityPreset` は `TierPreset` に改めた（案1の `QualityPreset` とは中身の違う別の型なので、名前で取り違えないように）。
  `RoomContext.quality` の型も `TierPreset`。案2の利用側（materials/glass、contracts/room、rooms/testing、app、dev/core）の import を直した。
- 単体テストは `quality.test.ts` を `quality-tier.test.ts` として中身のまま移した。

### 1つにしたもの

- 動きの曲線は `transition/curve.ts` の `glassEase`（`cubic-bezier(0.55, 0, 0.2, 1)`）の1つにした。案2の `easing.ts` の `easeGlass` は `glassEase` を呼ぶだけの別名になった（名前と引数は同じ）。
  値は変わる: 中点（t=0.5）は約 0.55 から約 0.73、最も急な瞬間の傾きは約 1.8 から約 3.2。終端に残っていた 0.999 → 1 の小さな段差はなくなった。
  それ以外の `easing.ts`（`easeInOutSine`・`easeOutCubic`・`smoothstep`・`lerp`・`wrapAngle`・`damp`）は変えていない。
- 案2の見回し（`src/input/look.ts`）は、正面へ戻す動きで `easeGlass` を使っていたが、新しい曲線は傾きが急で最大の角速度の上限に当たって戻しが約 1.8 倍に伸びるので、
  `easeInOutSine` に替えた（案2の側の変更。core の外）。

### 並べたもの（役目が違うので両方残す。使い分けは README）

- ガラス: 案1の `glass/`（透過の近景、`MeshPhysicalNodeMaterial`）と、案2の `materials/glass.ts`（透過を使わず縁の反射と薄膜干渉で見せる。VR・多数の飾り向け）。
  `GlassKind`・`GlassOptions`・`createGlass` のような名前は両方にあるが、別のモジュールなので import の元で選ぶ。
- 動的な解像度: 案1の `perf/dynamic-resolution.ts`（GPU 時間で動かす。`perf/governor.ts` に組み込まれる）と、案2の `quality-tier.ts` の `DynamicResolution`（GPU のタイムスタンプに頼らず、`requestAnimationFrame` の間隔だけで動く）。
- 品質: 案1の `quality.ts`（low/mid/high の表）と、案2の `quality-tier.ts`（low/medium/high を端末の手がかりから決め、`TierPreset` を返す）。段の名前が `mid` と `medium` で違う。

### 泡沫回廊の本実装（0.1.0 の STUB の置き換え。S-11 音楽と音、S-12 ガラス・曇り・品質。この版で初めて公開）

STUB を本実装に置き換えた（公開の名前・引数・戻り値の型は変えず、足したものだけ下に書く）。

- quality-tier（0.4.0 で quality.ts から移した）: `detectTier`（スマートフォン・VR は low、単体 GPU と Apple M シリーズは high、内蔵 GPU と不明は medium、ソフトウェア描画・2コア以下・2GB 以下は low）、
  `presetFor`（PC 60fps・スマートフォン 30fps・VR 72fps、VR と low は後処理なし、品質が上がるほど粒子と環境画像が増える）、
  `DynamicResolution`（約0.5秒の窓の平均で判断。重ければすぐ下げ、軽くなってもしばらく待ってから戻す。1回の変化は 0.1 以下）。
- materials/glass: 6種（透明・曇り・色・虹色・乳白・鏡）を TSL で実装。透過は使わず、縁の反射（フレネル）と薄膜干渉の虹色で見せる。
  縁の光・波紋・時刻はすべて uniform で即時に効く。tier（high: ノイズ2段、medium: 1段、low: サイン波）で計算を変える。`createBrass` は環境画像がなくても黒くならない。
  足したもの: `GlassHandle.pulse(now, origin?)` の省略できる第2引数（世界座標の触れた点。省くと面の中心から広がる）。
- fog/condensation: 曇り（ノイズの霞と細かい水滴、中心から広がる）・晴れ・指でなぞった文字（左から拭き取るように現れる）・消す（曇りに溶ける）を canvas 2D で実装。
  2D が使えない環境（jsdom）でも例外を出さず時間だけ進む。書体は `var(--font-serif)` のような CSS 変数で指定できる。
  足したもの: `CondensationOptions.onDraw`（描き直すたびに呼ぶ。CanvasTexture の `needsUpdate` 用）。
- dev/core.html（確認ページ）を追加。ガラス6種を球・板・泡で並べ、曇りと指の文字（DOM と 3D のテクスチャ）を見られる。
- 追加（レビュー1巡目の指摘への対応）:
  - materials/glass: `GlassParams.face`（正面の虹色の強さ。既定 0.01）、`setGlassLighting` / `resetGlassLighting`（擬似反射の空・地面・光の向きと色。
    `scene.environment` があれば擬似反射を弱める）、`sharedGlass`（引数の同じガラスを共有。縁の光と波紋は共有している全員に効く）、
    `setGlassFlashScale`（波紋の閃光の強さ。光の点滅を抑えるモード用）、`setDefaultGlassTier` / `getDefaultGlassTier`。
  - fog/condensation: `WriteOptions.minFontPx`（自動で縮めるときの最小の文字の大きさ。既定 18）。
- 修正:
  - glass: 波紋の距離がカメラと同じ奥行きの物（ゴンドラの殻）で NaN になり、本体色・虹色・縁の光まで消えて全画面が点滅する問題を直した
    （0 で割らない。カメラが殻の内側のときは視線の正面から広げ、穏やかにする）。
  - glass: 薄い殻（透明・虹色）の正面の寄与を縁だけに絞り、泡の内側から見た視界の中央が澄んだままになるようにした。標準の鏡面反射の正面も弱めた。
  - glass: `scene.fog` の中で、遠くのガラスが霧より明るく浮く問題を直した（霧の色に A を掛けて混ぜる）。
  - quality-tier: `DynamicResolution` の判断を窓の中央値にし、垂直同期で固定された画面（比が約 1.0）でも、倍率が初期値より下なら試しに戻すようにした
    （一度きりの停止で下がったまま戻らない問題）。戻した直後に重くなったら戻した分だけ下げ、待ちを倍にする。「Apple GPU」は medium（Intel の Mac と区別できないため）。Intel Arc の B シリーズを単体として扱う。
  - condensation: 描き直しのたびのグラデーションの確保をやめ（縁の形の絵を一度作って貼る）、文字がない間は文字用の canvas を解放し、
    霞と水滴は dpr 1.5 までの細かさで作って引き伸ばす。
- 修正（レビュー2巡目、本体アプリのゴンドラの殻で見つかったもの）:
  - glass: カメラが両面の物の境界球の内側にいる（殻の内側）とき、虹色の「縁」を視線との角度（内側では視界のどこでもほぼ 0）ではなく画面上の半径で測り、
    視界の外周だけにかすかに出す。中央は無色で、時刻で全体の色が回る位相も使わない。擬似照明の広いハイライトも 0.1 倍に落とす（画面下の白い塊が出ない）。
    `face` を上げた物は内側扱いにならない（面全体の色を保つ膜の板用）。
  - glass: `setupSpecular` は標準の結果に倍率を掛けるだけにした。`setupFog` は `builder.fogNode` を使い（scene.fog でも scene.fogNode でも、
    A で割った色に霧を当てて A を掛け直す F(rgb/A)×A で、霧の色に A を掛けて混ぜる。fogNode は1回だけ評価する。親が統合のときに直した:
    2回評価すると three が計算を一時変数にまとめて使い回し、薄い霧でガラスが A 倍に暗くなった）、pow の底に負が渡らないようにした。three r186 の実装を前提としコメントに明記した。
  - quality-tier: `DynamicResolution` は、試しに上げた直後を 8 フレームだけで判定して重ければすぐ戻し、失敗した倍率を「天井」として 60 秒（失敗が続けば倍々、最大 8 倍）上げない。
    戻しの分岐は「試しに上げた直後（最初の窓まで）」だけに限った。天井は reset()・守れた試し・本当に余裕のある窓（目標の 0.8 倍以下）が続いたときに外れる。
    重い状態が続いても、試しの上げと戻しは約 60 秒・120 秒・… 間隔になる。
  - condensation: 拭き取りの形を作り直すかどうかを、文字列の鍵ではなく数の比較で決める。
- S-11 音楽と音（2026-10-21）:
  - sound/*（音階・拍・立体音響・残響・ガラスの音源）を STUB から本実装に置き換えた。署名は変えていない。
    - scale: ペンタトニック、和音の構成音、触れた音の候補、最も近い音。`chordIntervals`（根音からの音程）を追加。
    - grid: `nextGridTime` は格子点ちょうどを遅らせず、予約の余裕 `minLead` に満たなければ次の格子点。
    - space: `setListenerPose`（yaw は -Z が 0 で左回りが正、pitch は上向きが正。毎フレーム呼ばれるので関数も配列も作らない）、決定的な乱数で作る残響のインパルス応答（RT60 = REVERB_SECONDS、高域は早く減衰、左右は別の乱数、1サンプルごとに定数を掛けて減衰させる）。`createSpatialPanner` は既定のまま（距離の減衰などは使う側で決める）。
    - voices: 録音の代わりに Web Audio で合成。harp（擦ったワイングラス）・bell・chime・bottle・drop・bowl・tap と、strings / choir / warm / air のパッド。`noiseBuffer` は種つきで決定的。
      - 減衰する倍音は、時定数の5倍（約 -43dB）で1本ずつ止める（止める直前の60msでさらに絞る）。小さすぎて聞こえない倍音は作らない。解除用の門は止めるときに初めて挟む。
      - `Voice` に `liveSources(at)`（at に鳴っている音源の数。音源ごとに「始まる時刻 ≤ at < 止まる時刻」で数え、先読みで予約しただけの音は始まる時刻まで数えない。同時発音の予算の数え方）を足した。`prepareVoices(ctx)`（使い回す雑音を先に作る）を足した。

## 0.3.0 — 2026-10-21（ビードロ。M0 統合: S-01 ガラス材質、S-04 遷移）

### S-01 ガラス材質

- `glass/` を追加（ガラス材質ライブラリ）。`import { … } from '../core/glass'` で使う
  - `kinds.ts`: ガラスの種類（透明・曇り・琥珀・瑠璃・翡翠・気泡入り・虹色・乳白）の数値。屈折率1.5、透明の粗さ0、曇りの粗さ0.45（範囲0.4〜0.6）。
    設計書にない値（色ガラスの吸収色と距離、分散の強さ、薄膜の厚みなど）は「仮」と注記
  - `policy.ts`: 描画の経路（透過 / 遠景の安価な表現 / 不透明）と、分散・薄膜干渉の有効無効を、置き場所
    （near / far / behind-glass）・役割（scenery / orb / drop / showcase）・品質プリセットから決める純粋関数。
    behind-glass は品質に関係なく安価な表現（設計の対策1「重なる場所は遠景側を安価な表現に切り替える」）
  - `materials.ts`: `createGlass(kind, preset, options)` → `{ material, features }`。近景は MeshPhysicalNodeMaterial の透過。
    厚みは `thicknessMap`（glTF の厚みテクスチャ、G）か、なければ場所ごとのムラ（ノイズ）に、視線の角度の係数を掛ける
    （殻は縁ほど厚く＝縁が緑、塊は縁ほど薄い）。遠景は透過なしの半透明（フレネル＋環境の反射＋自前の線形の霞、`fog: false`。
    霞はシーンの Fog と同じ値を渡す）。乳白は不透明＋内側からの発光。虹色の安価な代わりは、近景では反射の色づけ、
    遠景では縁（フレネル）に寄せた色で、どちらも光らない。発光は役割 drop（光の雫）だけ。ほかに `createFrostedFloorMaterial`（不透明の曇りガラスの床＋真鍮の目地、遠くでは目地を薄める）、
    `createBrassMaterial`、`createInnerBubbleMaterial`
  - `optics.ts`: フレネル（Schlick、正面4%）、吸収（Beer–Lambert）、視線の角度による光路の係数 `viewPathFactor` の純粋関数
  - `fused-bubbles.ts`: 泡が溶け合った形（球のなめらかな和集合を中心から光線で包む）、その境界球 `fusedBubbleSilhouette`、
    気泡入りガラスの内部の泡の配置（種つき）
  - `meshes.ts`: 上の形の three.js 化（BufferGeometry、表面に沿った線＝真鍮の枠の芯、内部の泡の InstancedMesh）
  - `overlap.ts`: 「透過ガラスの奥に透過ガラス」が画面上で重なる組を見つけるセンサー（境界球を視線からの円錐として比べる）

既知の制約（three r186。姉妹作でも同じ）:

- 透過の背景画像は1回の描画につき1度、最初の透過物の直前に写される。奥の透過物は映らないので、床・内部の泡・乳白は不透明で描く。
  半透明の合成で描く遠景の安価なガラスは、奥から順に描かれて透過物より先に載るため、近景の透過越しにも見える
- 品質プリセットの `transmissionScale` は効かない（背景画像は描画バッファと同じ大きさで写される）
- 曇りのぼかしは画面上で一様（ミップの段数 = log2(幅) × 粗さ）。ガラスのすぐ後ろの小さな物も消える

### S-04 遷移

- `transition/curve.ts`（新規）: 全遷移で共通の動きの曲線 `glassEase`（ゆっくり始まり、粘りながら止まる。
  `cubic-bezier(0.55, 0, 0.2, 1)`、行き過ぎなし）。同じ曲線を DOM 用に `GLASS_EASE_CSS` として出す。
  任意の制御点の `cubicBezier(x1, y1, x2, y2)` と、曲線上の位置からその時刻を求める `glassEaseInverse(y)` も公開。
- `transition/transition.ts`（新規）: 遷移1本の進行 `Transition`（線形の `progress` と曲線上の `value`、
  `reverse()` で同じ動きを逆再生、`holdAt` + `isReady` で次の場面の準備が間に合わないとき途中の姿勢で待つ、
  `startAtEnd` で終点から戻る）。`acceptsEscape(spec)`（0.5秒を超える遷移は Esc を受け付ける）、
  部分区間を 0..1 に写す `segment(p, from, to)`。
- `transition/index.ts`: 上の再輸出。
- 既存のファイルは変更なし。案2へは `src/core/transition/` をそのままコピーすればよい（three への依存なし）。

## 0.2.0 — 2026-10-21（ビードロ。S-05）

- `perf/governor.ts`（新規）: 品質の自動選択 → 選んだプリセットへの切り替え → 測り直し → 動的解像度、をまとめた状態機械。
  GPU のタイムスタンプは Apple/Metal では判断に使わず、それ以外でも平均フレーム時間を超えたら信用しない。そのとき動的解像度は止め、
  品質の検証はフレーム時間（取りこぼしとジッタ）で行う。シーンの作り直しが失敗したら前のプリセットへ戻す（`sceneFailed`）
- `perf/quality-select.ts`（新規）: 推奨プリセットの判定。段ごとのコスト係数（low 0.85 / mid 1 / high 1.7）、CPU 律速と
  フレームレートの上限（30fps の省電力など）の見分け
- `perf/dynamic-resolution.ts`（新規）: GPU 時間による動的解像度（5個の中央値＋EMA、ヒステリシス、待ち時間、上げすぎの抑制と、
  落ち着いたらその抑制を戻す）
- `bench.ts`: `GpuStats` と `summarizeGpuTimes` を追加
- `renderer.ts`: `trackTimestamp` を有効化。戻り値に `baseDpr`、`gpuName`、`gpuTiming`、`gpuTimingTrusted`（Apple/Metal は false）を追加
- `params.ts`: `quality=auto`、`autoWindow`、`autoFrom`、`autoForce`、`dynres`、`dynresTarget`、`gpuTrust` を追加
- 注意（案2にも関係）: WebGPU（r186）では、画面と違う大きさの RenderTarget に transmission の材質を描くとフレームが捨てられる。
  Apple/Metal では GPU のタイムスタンプの合計が約10倍に膨らむ。影のカメラの layers は明示する

## 0.1.0 — 2026-10-21（ビードロ。S-00）

- `renderer.ts`: WebGPURenderer の生成（WebGL2 への自動切替、AgX、sRGB、描画解像度の倍率）
- `quality.ts`: 品質プリセット 低・中・高（設計書「品質プリセット」の表）
- `bench.ts`: フレーム時間の統計（平均・p50/p95/p99・最大）と描画予算の判定
- `params.ts`: URL スイッチ（scene / bench / warmup / quality / webgl / stats）
- `scene.ts`: 検証用シーンの契約（SceneFactory / SandboxScene / SceneContext）

## 0.1.0 — 2026-10-21（泡沫回廊。初版の骨格）

- 初版の骨格。events（型つきイベント）、storage（localStorage の安全な読み書き）、easing（ガラスの曲線）を実装。
- quality、materials/glass、fog/condensation、sound/*（音階・拍・立体音響・残響・ガラスの音源）は署名だけの STUB。M0 の共通の技術検証で本実装に置き換える。
