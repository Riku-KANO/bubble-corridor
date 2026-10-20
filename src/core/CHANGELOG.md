# 共通部品（src/core）の変更記録

案1「ビードロの向こう」（~/develop/through-the-vidro）と案2「泡沫回廊」（このリポジトリ）は、
同じ共通部品をそれぞれのディレクトリに置いて使う。ディレクトリをまたいで参照しない。
先に変更した側から `pnpm core:sync <相手のリポジトリ>` でまとめてコピーし、VERSION とこの記録で揃っているかを確かめる。

版の付け方: 互換を壊す変更は minor を上げる（0.x の間）。追加・修正は patch。

## 0.1.0 — 2026-10-21（泡沫回廊）

- 初版の骨格。events（型つきイベント）、storage（localStorage の安全な読み書き）、easing（ガラスの曲線）を実装。
- quality、materials/glass、fog/condensation、sound/*（音階・拍・立体音響・残響・ガラスの音源）は署名だけの STUB。M0 の共通の技術検証で本実装に置き換える。

## 未リリース

STUB を本実装に置き換えた（版は親が上げる。公開の名前・引数・戻り値の型は変えず、足したものだけ下に書く）。

- quality: `detectTier`（スマートフォン・VR は low、単体 GPU と Apple M シリーズは high、内蔵 GPU と不明は medium、ソフトウェア描画・2コア以下・2GB 以下は low）、
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
  - quality: `DynamicResolution` の判断を窓の中央値にし、垂直同期で固定された画面（比が約 1.0）でも、倍率が初期値より下なら試しに戻すようにした
    （一度きりの停止で下がったまま戻らない問題）。戻した直後に重くなったら戻した分だけ下げ、待ちを倍にする。「Apple GPU」は medium（Intel の Mac と区別できないため）。Intel Arc の B シリーズを単体として扱う。
  - condensation: 描き直しのたびのグラデーションの確保をやめ（縁の形の絵を一度作って貼る）、文字がない間は文字用の canvas を解放し、
    霞と水滴は dpr 1.5 までの細かさで作って引き伸ばす。
