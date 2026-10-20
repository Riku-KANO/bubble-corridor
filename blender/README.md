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
| プレビズを組む | `pnpm previz:build`（`public/assets/rail.json`・`cues.json` → `blender/scenes/previz.blend`）。仮の楽曲は `-- --audio bgm.wav`。**既にある出力は上書きしない**（人が直した previz.blend を消さないため）。上書きは `--force`、別の場所は `--out` |
| rail.json・cues.json を書き出す | `pnpm previz:export`（previz.blend から `public/assets/` へ）。書き出したら `pnpm comfort`（動きの上限の検査）を回す |
| 静止画・動画を撮る | `pnpm previz:render`（→ `.snaps/previz/`）。引数は `pnpm previz:render --stills 30,160 --size 640x360`、`--range 100:130 --fps 10`（`--` を挟んでもよい） |
| 任意のスクリプト | `pnpm blender <script.py> [--blend file.blend] [-- 引数]` |

`pnpm previz:render` に引数がなければ、各区間の真ん中の静止画を撮る。出力のファイル名に時刻（秒）が入る（`still_t0160.000.png`、`range_t0100.000-0130.000_10fps.mp4`）。動画の `--fps` は 30 の約数（間引いて描く）。音は `--fps 30` のときだけ入る。

previz.blend は人が開いて直す物。`previz:build` は既にある出力を上書きしないので、組み直すときは `--force`（直した変更は消える）。

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
- `Rail` のカスタムプロパティ: `duration`（乗車時間、秒）、`spacing`（点の間隔）、`gentle_y`（元の gentleY。往復のためだけに持つ）、`rail_signature`（元の点列の署名）、`timeline_dt`（時刻表の細かさ、秒）。
- 空の色（World）は区間ごとにキーが打ってある（夜明け前の青灰 → 朝 → 雨の昼 → 金 → 天球の夜の藍 → 金と桃色の夜明け → 朝）。仮の下書きなので好きに直してよい。

### タイムラインマーカー = キューシート

マーカーの名前 `<id> in=<区間> [<キー>=<値> …]`（64 バイト未満）。時刻は 1/30 秒の整数倍。

```
greenhouse.bloom@48 in=greenhouse
lure@47.1 in=greenhouse target=greenhouse.bloom
membrane@18 in=greenhouse to=greenhouse
photo.capture@48 in=greenhouse shot=bloom
```

id は `<出来事の名前>@<通しの小節>`。人が足すときは名前だけでよい（`greenhouse.bloom`、`photo.capture shot=bloom`）。書き出しが id・小節（t ÷ 10/3）・区間（`Sections` の時刻）を決める。マーカーはすべてキューになる（キュー以外のマーカーを置かない）。

書き出しはマーカーを検査し、**違反はすべて一覧にして止める**（何も書かない）: 出来事の名前（`CUE_NAMES`。Blender の自動の名前 `F_9000` や打ち間違いはここで止まる）、data のキーと値（`to` は区間、`target` は出来事の名前、`shot` は撮影の名前）、`in=` の区間名、時刻が 0 〜 duration の中か。マーカーを動かして id の `@小節` や `in=` が時刻と食い違ったときは WARNING（id は時刻から作り直す。`in=` は書かれたものを使う）。名前の一覧は `export_ride.py` の写しで、`scripts/blender-constants.test.ts` が契約と同じかを検査する。

### 書き出しの計算（人が直した変更が反映される）

- 点列: `Rail` を評価した折れ線。点がすでに 1m 間隔（累積の長さが 10cm 以内）ならそのまま、そうでなければ 1m 間隔に打ち直す。
- 時刻表: `Gondola` の位置を 0.25〜0.5 秒ごとに評価し、レール上の最も近い点の距離を s にする（単調に直す。後ろへ動くと警告）。
- gentleY: レールは 1 本で gentleY は持たない（ADR-0008）。元の rail.json にあって点列が元のままなら、往復のため保存した値をそのまま書く。レールを直したら落とす（WARNING）。作り直しはしない。
- 区間: `Sections` の時刻を時刻表で距離に直す。
- 乗車時間（duration）と時刻の基準は、`Rail` の `duration` と frame 0。シーンの frame 範囲を変えても無視する（WARNING）。乗車時間を変えるなら `duration` を直す。fps が 30 でないと止まる。
- 打ち直した点の直線距離の累積が 番号 × 間隔 より 0.1m を超えて短くなったら WARNING（曲がりが急。時刻表の s と実際の道のりがずれる）。
- 時刻表をグラフエディタで直すときは、キーの補間を**ベジェ**にしてなめらかにする（LINEAR のままだと速度が階段になる。ride 側は単調な 3 次エルミートで補う）。書き出し後は `pnpm comfort` で速度・加速・上下・回転の上限を確かめる。
- 往復の誤差（合成のレールで実測）: 点 0.1mm、時刻表 0.3mm、区間の範囲 0.3mm。

## common（案1と共有。VERSION と CHANGELOG.md で揃える）

`blender/scripts/common/` は案1「ビードロの向こう」にも同じものを置く（ADR-0005）。common の外（previz.py・export_ride.py・render_previz.py・rooms/）を import しない。案2固有の名前は引数で受け取る。変更したら VERSION と CHANGELOG.md を更新する。

| モジュール | 関数 | 役目 |
|---|---|---|
| `coords` | `three_to_blender`、`blender_to_three`、`horizontal_frames` | 座標の変換、レールの各地点の水平な向き |
| `naming` | `check_names(objects, rooms=None)` | `<部屋>.<部品>[.<番号>]`（小文字）に合わない名前の一覧 |
| `visibility` | `cull_hidden(objects, rail_points, yaw_deg, pitch_deg, head_radius)` | レールから一度も見えない面を消し、前後の三角形の数などを返す |
| `bake` | `bake_lightmaps(objects, out_dir, size, samples)` | Cycles で光と影を 2 つ目の UV `Lightmap` に焼く（8bit の sRGB PNG） |
| `export` | `export_glb(objects, path)` | 部屋の glb（15MB（10進）以下、画像なし、extras、Y 上） |

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
#    glass を持つ物（ガラス）は光線を通す（奥の物を削らない）。ガラスとインスタンスは焼き込みの対象から外す
# 2. モディファイアを適用し、見えない面を消す
#    cull_hidden(objs, rail_span, yaw_deg=120, pitch_deg=60, head_radius=0.5)
# 3. 焼き込み: bake_lightmaps(objs, 'public/assets/rooms', size=2048, samples=128, name='<部屋>.lightmap')
# 4. 書き出し: export_glb(objs, 'public/assets/rooms/<部屋>.glb')
```

- 名前の規則は `check_names(objs, rooms=[...])` で検査する（`export_glb` も違反を警告する）。
- **インスタンス描画する物（植物・雨粒など、メッシュを共有する物）とガラスは、焼き込みの対象から外す**。`bake_lightmaps` はメッシュを共有する物があると、一覧を出して止まる（`split_shared=True` で単独のコピーにして焼くが、数千のメッシュになるので避ける）。
- `cull_hidden` はメッシュ（`obj.data`）の面を直接消す。全部消えた物は空のメッシュで残る（`report['emptied']`。消すかは呼ぶ側が決める）。モディファイアは適用してから呼ぶ。
  - ガラスの向こうの物を削らないよう、**ガラス（`glass` プロパティを持つ物、または `see_through` が真の物）は光線を通す**（`see_through=False` を書けば遮る）。判定の関数は `see_through=` 引数で差し替えられる。
  - レールの点は Blender の座標で渡す。**部屋の区間の範囲だけでなく、前後に余裕（例: 手前 30m、奥 30m）を足す**（前の部屋から見えるので、区間だけだと手前から見える面を削りすぎる）。
- `export_glb` は 15MB（10進。`PERF.roomLoadMB`）を超えると止まる。ライトマップの PNG は glb の外なので別に数える。

### 焼き込みとライトマップ（three.js 側の使い方）

- 焼くのは光だけ（色は含めない）。**float で焼いて、明るい側の 99.5 百分位で割り、sRGB の 8bit PNG（RGB）で書く**（8bit 以外ならエラー。2048px・128spp の小さな場面で約 1.8MB）。1.0 を超える強い光でも飽和しない。割った倍率を物のカスタムプロパティ `lightmap_scale` に残す（線形の光 = 画像を線形に直した値 × `lightmap_scale`）。`lightmap` に out_dir からの画像の場所。どちらも glb の extras（userData）に入る。
- ライトマップは 2 つ目の UV（`Lightmap`、glb の TEXCOORD_1）を使う。PNG の上下は glTF の UV に合わせてある。

```ts
const tex = await new TextureLoader().loadAsync(`${dir}/${node.userData.lightmap}`);
tex.colorSpace = SRGBColorSpace; // 8bit の sRGB（線形に直して使う）
tex.flipY = false;               // glTF の UV に合わせる（TextureLoader の既定は true）
tex.channel = 1;                 // 2つ目の UV（TEXCOORD_1）
material.lightMap = tex;
// Blender で焼いた値は「反射の明るさ（放射輝度）」。three の lightMap は拡散反射に 1/π を掛けて足すので、π を掛けて揃える
material.lightMapIntensity = Math.PI * node.userData.lightmap_scale;
```

  見た目は Blender の描画と並べて合わせる（`lightMapIntensity` は演出の明るさとして調整してよい）。
- 焼き込みの名前（`name`）の既定は物の名前の `<部屋>` から作る（`greenhouse.lightmap` → `greenhouse.lightmap.png`）。計算機は環境変数 `BLENDER_BAKE_DEVICE`（`CPU` / `GPU` / `AUTO`。既定の AUTO は Metal などの GPU があれば GPU）。

## テスト

`pnpm exec vitest run scripts/blender.test.ts`（Blender を起動するので数十秒。`scripts/check.sh --quick` は `SKIP_BLENDER=1` で省く）。`scripts/blender-constants.test.ts` は Blender を起動せず、スクリプトに写した数値・名前の一覧が config・契約と同じかを毎回検査する。
