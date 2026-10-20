# 共通部品（src/core）の変更記録

案1「ビードロの向こう」（~/develop/through-the-vidro）と案2「泡沫回廊」（このリポジトリ）は、
同じ共通部品をそれぞれのディレクトリに置いて使う。ディレクトリをまたいで参照しない。
先に変更した側から `pnpm core:sync <相手のリポジトリ>` でまとめてコピーし、VERSION とこの記録で揃っているかを確かめる。

版の付け方: 互換を壊す変更は minor を上げる（0.x の間）。追加・修正は patch。

## 0.1.0 — 2026-10-21（泡沫回廊）

- 初版の骨格。events（型つきイベント）、storage（localStorage の安全な読み書き）、easing（ガラスの曲線）を実装。
- quality、materials/glass、fog/condensation、sound/*（音階・拍・立体音響・残響・ガラスの音源）は署名だけの STUB。M0 の共通の技術検証で本実装に置き換える。

## 0.1.1 — 2026-10-21（泡沫回廊、S-11 音楽と音）

- sound/*（音階・拍・立体音響・残響・ガラスの音源）を STUB から本実装に置き換えた。署名は変えていない。
  - scale: ペンタトニック、和音の構成音、触れた音の候補、最も近い音。`chordIntervals`（根音からの音程）を追加。
  - grid: `nextGridTime` は格子点ちょうどを遅らせず、予約の余裕 `minLead` に満たなければ次の格子点。
  - space: `setListenerPose`（yaw は -Z が 0 で左回りが正、pitch は上向きが正）、決定的な乱数で作る残響のインパルス応答（RT60 = REVERB_SECONDS、高域は早く減衰、左右は別の乱数）。`createSpatialPanner` は距離の減衰を緩やかにした。
  - voices: 録音の代わりに Web Audio で合成。harp（擦ったワイングラス）・bell・chime・bottle・drop・bowl・tap と、strings / choir / warm / air のパッド。`noiseBuffer` は種つきで決定的。
