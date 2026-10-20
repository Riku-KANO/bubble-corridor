# 共通部品（src/core）の変更記録

案1「ビードロの向こう」（~/develop/through-the-vidro）と案2「泡沫回廊」（このリポジトリ）は、
同じ共通部品をそれぞれのディレクトリに置いて使う。ディレクトリをまたいで参照しない。
先に変更した側から `pnpm core:sync <相手のリポジトリ>` でまとめてコピーし、VERSION とこの記録で揃っているかを確かめる。

版の付け方: 互換を壊す変更は minor を上げる（0.x の間）。追加・修正は patch。

## 0.1.0 — 2026-10-21（泡沫回廊）

- 初版の骨格。events（型つきイベント）、storage（localStorage の安全な読み書き）、easing（ガラスの曲線）を実装。
- quality、materials/glass、fog/condensation、sound/*（音階・拍・立体音響・残響・ガラスの音源）は署名だけの STUB。M0 の共通の技術検証で本実装に置き換える。
