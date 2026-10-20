# Blender 共通スクリプト（blender/scripts/common）の変更記録

案1「ビードロの向こう」（~/develop/through-the-vidro）と案2「泡沫回廊」（このリポジトリ）は、
同じ共通スクリプトをそれぞれのディレクトリに置いて使う。ディレクトリをまたいで参照しない。
`common` の外（previz.py・export_ride.py・render_previz.py・rooms/）を import しない。
案2固有の名前（区間、部屋の一覧、キュー）を持ち込まない。必要なら引数で受け取る。
変更したら VERSION とこの記録を更新し、相手のリポジトリへコピーして揃える（src/core と同じ。ADR-0005）。

版の付け方: 互換を壊す変更は minor を上げる（0.x の間）。追加・修正は patch。

## 0.1.0 — 2026-10-21（泡沫回廊）

- 初版。
- coords: three.js（Y が上、-Z が前）と Blender（Z が上、+Y が前）の座標の変換。
- cli: `--` の後ろの引数を取り出す。
- naming: `check_names`。小文字の `<部屋>.<部品>[.<番号>]` に合わない名前の一覧。部屋の一覧は引数で受け取る。
- export: `export_glb`。カスタムプロパティを extras へ、Y が上、画像を埋め込まない、カメラ・ライト・アニメーションは書かない、サイズの上限の検査。
- visibility: `cull_hidden`。レール上の地点（と頭の動く範囲）から見回せる範囲に光線を飛ばし、一度も当たらない面を消す。
- bake: `bake_lightmaps`。Cycles の DIFFUSE（DIRECT+INDIRECT）を 2つ目の UV（Lightmap）へ焼き、PNG と物のカスタムプロパティ `lightmap` に残す。
