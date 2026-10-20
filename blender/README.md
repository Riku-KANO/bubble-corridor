# blender — Blender のパイプライン

設計書「Blenderパイプライン」と ADR-0002。Blender 5.2.2 LTS（`/Applications/Blender.app`。PATH にはない）を `scripts/blender.ts` が探し、ヘッドレスで Python（bpy）を走らせる。

```
rail.json + cues.json ──previz:build──▶ blender/scenes/previz.blend ──previz:render──▶ .snaps/previz/*.png, *.mp4
        ▲                                        │  （人が開いて、カーブ・時刻表・マーカーを直してよい）
        └────────────── previz:export ◀──────────┘
部屋のスクリプト（blender/scripts/rooms/<部屋>.py）: 造形 → 見えない面の削除 → 焼き込み → glb
```

## コマンド

| 目的 | コマンド |
|---|---|
| プレビズを組む | `pnpm previz:build`（`public/assets/rail.json`・`cues.json` → `blender/scenes/previz.blend`）。仮の楽曲は `-- … --audio bgm.wav` |
| rail.json・cues.json を書き出す | `pnpm previz:export`（previz.blend から `public/assets/` へ） |
| 静止画・動画を撮る | `pnpm previz:render`（→ `.snaps/previz/`）。引数は `pnpm previz:render --stills 30,160 --size 640x360`、`--range 100:130 --fps 10`（`--` を挟んでもよい） |
| 任意のスクリプト | `pnpm blender <script.py> [--blend file.blend] [-- 引数]` |

`pnpm previz:render` に引数がなければ、各区間の真ん中の静止画を撮る。出力のファイル名に時刻（秒）が入る（`still_t0160.000.png`、`range_t0100.000-0130.000_10fps.mp4`）。動画の `--fps` は 30 の約数（間引いて描く）。音は `--fps 30` のときだけ入る。

previz.blend は人が開いて直す物なので、既に直した previz.blend があるときに `previz:build` で上書きしない（`--out` を変える）。

## 座標

rail.json と glb は **three.js の向き**（Y が上、-Z が前）。Blender は Z が上、+Y が前。
three (x, y, z) → Blender (x, -z, y)。`common/coords.py` の `three_to_blender` / `blender_to_three` を、取り込みと書き出しで必ず対にして使う（glb は Blender の glTF 書き出しが Y 上へ直す）。

## previz.blend の決まり

- 30fps、frame 0 〜 duration×30（13 分 = 23400）。
- `Rail`（カーブ）: rail.json の点列そのまま、1 本の POLY スプライン。ベジェに直してよい（書き出しは評価した折れ線を使う）。スプラインは 1 本だけ。
- `Gondola`（空の物体）: Follow Path（`offset_factor` のキー、補間は LINEAR）で `Rail` に沿い、Limit Rotation で向きは進行方向の左右だけ（常に水平）。時刻表を直すなら `offset_factor` のキーを動かす。
- `SeatCamera`: `Gondola` の子。座席の目の高さ（0.15m）、縦の視野角 75°、進行方向を向く。
- 部屋のコレクション: `platform` `greenhouse` `rain` `kaleidoscope` `celestial` `dawn`（降車の区間は `platform`）。仮の形と色は設計書の広さに合わせた下書き。部屋の担当が本番の造形に置き換える。
- `Sections`（空の物体）: カスタムプロパティ `<区間の id>` = `[開始の秒, 終わりの秒]`。区間は時刻で持つので、時刻表やレールを直しても楽曲の構成についてくる。
- `Rail` のカスタムプロパティ: `spacing`（点の間隔）、`gentle_y`（元の gentleY）、`rail_signature`（元の点列の署名）、`timeline_dt`（時刻表の細かさ、秒）。

### タイムラインマーカー = キューシート

マーカーの名前 `<id> in=<区間> [<キー>=<値> …]`（64 バイト未満）。時刻は 1/30 秒の整数倍。

```
greenhouse.bloom@48 in=greenhouse
lure@47.1 in=greenhouse target=greenhouse.bloom
membrane@18 in=greenhouse to=greenhouse
photo.capture@48 in=greenhouse shot=bloom
```

id は `<出来事の名前>@<通しの小節>`。人が足すときは名前だけでよい（`greenhouse.bloom`、`photo.capture shot=bloom`）。書き出しが id・小節（t ÷ 10/3）・区間（`Sections` の時刻）を決める。マーカーはすべてキューになる（キュー以外のマーカーを置かない）。

### 書き出しの計算（人が直した変更が反映される）

- 点列: `Rail` を評価した折れ線。点がすでに 1m 間隔（累積の長さが 10cm 以内）ならそのまま、そうでなければ 1m 間隔に打ち直す。
- 時刻表: `Gondola` の位置を 0.25〜0.5 秒ごとに評価し、レール上の最も近い点の距離を s にする（単調に直す。後ろへ動くと警告）。
- gentleY: 点列が元のままなら保存した値。変わっていれば、最初の点の高さを基準に上下の動きを半分にして作り直す。
- 区間: `Sections` の時刻を時刻表で距離に直す。duration はシーンの長さ。
- 往復の誤差（合成のレールで実測）: 点 0.1mm、時刻表 0.3mm、区間の範囲 0.3mm。

## common（案1と共有。VERSION と CHANGELOG.md で揃える）

`blender/scripts/common/` は案1「ビードロの向こう」にも同じものを置く（ADR-0005）。common の外（previz.py・export_ride.py・render_previz.py・rooms/）を import しない。案2固有の名前は引数で受け取る。変更したら VERSION と CHANGELOG.md を更新する。

| モジュール | 関数 | 役目 |
|---|---|---|
| `coords` | `three_to_blender`、`blender_to_three`、`horizontal_frames` | 座標の変換、レールの各地点の水平な向き |
| `naming` | `check_names(objects, rooms=None)` | `<部屋>.<部品>[.<番号>]`（小文字）に合わない名前の一覧 |
| `visibility` | `cull_hidden(objects, rail_points, yaw_deg, pitch_deg, head_radius)` | レールから一度も見えない面を消し、前後の三角形の数などを返す |
| `bake` | `bake_lightmaps(objects, out_dir, size, samples)` | Cycles で光と影を 2 つ目の UV `Lightmap` に焼く |
| `export` | `export_glb(objects, path)` | 部屋の glb（15MB 以下、画像なし、extras、Y 上） |

## 部屋のスクリプトの書き方（`blender/scripts/rooms/<部屋>.py`）

```python
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))          # blender/scripts を通す
import bpy
from common.coords import three_to_blender
from common.naming import check_names
from common.visibility import cull_hidden
from common.bake import bake_lightmaps
from common.export import export_glb

ride = json.load(open('public/assets/rail.json'))
rail = [three_to_blender(p) for p in ride['rail']['points']]   # Blender の座標
# 1. 造形: 物の名前は `<部屋>.<部品>[.<番号>]`（小文字）。カスタムプロパティを付ける
#    role / touch_kind / touch_id / glass / clearance_exempt … → glb の extras（userData）
#    see_through=True の物（ガラス）は光線を通す（奥の物を削らない）
# 2. モディファイアを適用し、見えない面を消す
#    cull_hidden(objs, rail_span, yaw_deg=120, pitch_deg=60, head_radius=0.5)
# 3. 焼き込み: bake_lightmaps(objs, 'public/assets/rooms', size=2048, samples=128, name='<部屋>.lightmap')
# 4. 書き出し: export_glb(objs, 'public/assets/rooms/<部屋>.glb')
```

- 名前の規則は `check_names(objs, rooms=[...])` で検査する（`export_glb` も違反を警告する）。
- `bake_lightmaps` は材質のない物に材質を作り、メッシュを共有する物は単独のコピーにする。ライトマップは sRGB の 8bit PNG（1.0 を超える光は切れる）。物のカスタムプロパティ `lightmap` に `out_dir` からの場所が入り、glb の extras になる。three.js では `lightMap` の channel 1 に掛ける。
- `cull_hidden` はメッシュ（`obj.data`）の面を直接消す。全部消えた物は空のメッシュで残る（`report['emptied']`。消すかは呼ぶ側が決める）。レールの点は Blender の座標で渡し、部屋の区間の範囲だけ渡すとよい。
- glb は 15MB を超えると `export_glb` が止まる。

## テスト

`pnpm exec vitest run scripts/blender.test.ts`（Blender を起動するので数十秒。`scripts/check.sh --quick` は `SKIP_BLENDER=1` で省く）。
