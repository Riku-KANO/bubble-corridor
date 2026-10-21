"""第5室「夜明けの岸」の造形（BLD-4〜7）。

    pnpm blender blender/scripts/rooms/dawn.py [-- --samples 256 --size 2048 --no-bake]

このスクリプトが原本。blender/scenes/dawn.blend と public/assets/rooms/dawn.glb・dawn.lightmap.png・dawn.sunmap.png は
ここから作り直す書き出し（.blend を手で直したら、その直しをこのスクリプトへ戻す）。

一枚絵（絵コンテの代わり）:
  11:00、天球の殻（出口の膜）を抜けると視界が一気に開ける。ゴンドラは鏡のように凪いだ水面すれすれを進み、
  左にはガラスの砂浜がゆるい弧を描いて前方の遠くまで続き、その先の岬に最初の乗り場（泡の発着場）が小さく見える。
  右は水平線まで開けた海で、右前方の水平線の上だけが桃色と金にほどけている（11:50 にそこから朝日が昇る）。
  真鍮の細い標柱が左右に一対ずつ、ガラスの浮き玉の灯をともして乗り場へ導き、その列が水面に映る。
  砂浜の奥には低い砂丘、さらに奥には霞んだ丘が三重に重なる（遠景は板の絵）。振り返ると、夜の天球が海に半ば沈んでいる。

ここで作る物（名前は `dawn.<部品>[.<番号>]`、カスタムプロパティは glb の extras → three の userData）:
  - dawn.beach          ガラスの砂浜（高さの場）。光を2回焼く: 空の光（lightmap）と朝日（sunmap。TS が時刻で混ぜる）
  - dawn.water          水面（role=water、clearance_exempt）。TS が平面反射の材質に替える
  - dawn.posts_left/right   真鍮の標柱（左右でまとめる。物の箱がレールをまたがないように）
  - dawn.lamps_left/right   標柱の上のガラスの浮き玉の灯（glass）
  - dawn.membrane       乗り場（降車）への膜（role=membrane、clearance_exempt）
  - dawn.membrane_ring.N    膜の縁の真鍮の輪（instance_group）
  - dawn.hills.0〜3     遠景の丘の板（role=hills、layer）。TS が霞の色を時刻で塗る
  - dawn.pebble_a/b/c   海のガラスの小石の型（role=pebble_template。焼かない）
  - dawn.pebbles        小石を置く場所（extras の points: [x, y, z, 大きさ, 向き, 種類] × 数。three の座標）
  - dawn.hidden_bubble  隠れた小さな泡（touch_kind=hidden-bubble）
  - dawn.globe          振り返ったときの天球の代役（外殻の球。role=globe、glass、clearance_exempt）と、
    dawn.globe_ring.N   それを抱く真鍮の子午線と黄道（instance_group）。星の天球の部屋が先読みの窓から外れた後（11:10〜）に、
                        同じ形・同じ向き（celestial.py の globe_frame）で入れ替わる。中の殻と星は膜を抜ける瞬間に消してある

座標: 形は three の座標（Y が上）で考えて、Blender へ置くときに three_to_blender で直す。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

from common.bake import bake_lightmaps  # noqa: E402
from common.cli import script_args  # noqa: E402
from common.coords import horizontal_frames, three_to_blender  # noqa: E402
from common.export import export_glb, room_load_report  # noqa: E402
from common.naming import check_names  # noqa: E402
from common.visibility import cull_hidden  # noqa: E402
from rooms.celestial import MERIDIAN_ARCS, MERIDIAN_MINOR, MERIDIAN_SEGMENTS, SHELL_RADII, globe_frame, ring_matrices  # noqa: E402
from rooms.celestial import arc_bmesh as globe_arc_bmesh  # noqa: E402

ROOT = os.path.abspath(os.path.join(SCRIPTS, '..', '..'))
RAIL_JSON = os.path.join(ROOT, 'public', 'assets', 'rail.json')
OUT_DIR = os.path.join(ROOT, 'public', 'assets', 'rooms')
GLB = os.path.join(OUT_DIR, 'dawn.glb')
BLEND = os.path.join(ROOT, 'blender', 'scenes', 'dawn.blend')

ROOM = 'dawn'
SEED = 20261021
CLEARANCE = 1.2 + 0.5 + 0.05
#: 朝日の向き（three の座標、水平）: 進行方向（-X）から右へ 30°。TS（src/rooms/dawn/sky.ts の SUN_AZIMUTH_DEG）と揃える
SUN_AZIMUTH_DEG = 30.0
#: 焼くときの朝日の高さ（度）。低い朝日の長い影
SUN_BAKE_ELEVATION_DEG = 4.0
#: 天球（星の天球の外殻）。砂浜はこの球の手前で水に沈める（ガラスの球の中に砂を入れない）
GLOBE_RADIUS = 61.5
#: 乗り場のホール（原点のまわり）。水面はここを空ける（乗り場の担当が自分の床と水を持つ）
HALL_RADIUS = 15.0


def B(x: float, y: float, z: float) -> tuple[float, float, float]:
    """three の座標 → Blender の座標"""
    return three_to_blender((x, y, z))


class Rail:
    def __init__(self, path: str):
        with open(path, encoding='utf-8') as f:
            ride = json.load(f)
        self.spacing = float(ride['rail']['spacing'])
        self.three = np.array(ride['rail']['points'], dtype=np.float64)
        self.points = np.array([three_to_blender(p) for p in ride['rail']['points']], dtype=np.float64)
        self.T = np.array([e['t'] for e in ride['timeline']], dtype=np.float64)
        self.S = np.array([e['s'] for e in ride['timeline']], dtype=np.float64)
        self.sections = {e['id']: (float(e['s0']), float(e['s1'])) for e in ride['sections']}
        self.fwd, self.right = horizontal_frames(self.points)

    def s_at(self, t: float) -> float:
        return float(np.interp(t, self.T, self.S))

    def point(self, s: float, three: bool = False) -> np.ndarray:
        pts = self.three if three else self.points
        x = min(max(s / self.spacing, 0.0), len(pts) - 1.000001)
        i = int(math.floor(x))
        f = x - i
        return pts[i] * (1 - f) + pts[i + 1] * f

    def samples(self, s0: float, s1: float, step: float = 0.5, three: bool = False) -> np.ndarray:
        n = max(2, int(math.ceil((s1 - s0) / step)) + 1)
        return np.array([self.point(s0 + (s1 - s0) * k / (n - 1), three) for k in range(n)])


def box_distance(lo: np.ndarray, hi: np.ndarray, pts: np.ndarray) -> float:
    d = np.maximum(np.maximum(lo - pts, 0.0), pts - hi)
    return float(np.sqrt((d * d).sum(axis=1)).min())


def world_box(obj) -> tuple[np.ndarray, np.ndarray]:
    m = np.array(obj.matrix_world)
    co = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get('co', co)
    w = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    return w.min(axis=0), w.max(axis=0)


# ── 造形の道具 ────────────────────────────────────────────────────────────
def collection(name: str):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(c)
    return c


def material(name: str, color=(0.8, 0.8, 0.8), *, metallic=0.0, roughness=0.5, alpha=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        bsdf = m.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
        out = next(n for n in m.node_tree.nodes if n.type == 'OUTPUT_MATERIAL')
        m.node_tree.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Alpha'].default_value = alpha
    m.diffuse_color = (*color, alpha)
    return m


def mesh_object(name: str, bm, coll, mat=None, props: dict | None = None, smooth=True):
    me = bpy.data.meshes.new(name)
    if smooth:
        for f in bm.faces:
            f.smooth = True
    bm.to_mesh(me)
    bm.free()
    if mat is not None:
        me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    for k, v in (props or {}).items():
        ob[k] = v
    coll.objects.link(ob)
    return ob


def uv_sphere(radius: float, u: int, v: int):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=radius)
    return bm


def lathe(bm, profile: list[tuple[float, float]], center: tuple[float, float, float], segments: int):
    """three の座標の縦の軸（中心 center）の周りに (半径, 高さ) を回した面を bm に足す。端が軸の上なら閉じる"""
    cx, cy, cz = center
    rings = []
    for rho, y in profile:
        if rho < 1e-6:
            rings.append([bm.verts.new(B(cx, cy + y, cz))])
        else:
            rings.append([bm.verts.new(B(cx + rho * math.cos(math.tau * k / segments), cy + y, cz + rho * math.sin(math.tau * k / segments))) for k in range(segments)])
    for a, b in zip(rings[:-1], rings[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        if len(a) == 1:
            for k in range(segments):
                bm.faces.new((a[0], b[(k + 1) % segments], b[k]))
        elif len(b) == 1:
            for k in range(segments):
                bm.faces.new((a[k], a[(k + 1) % segments], b[0]))
        else:
            for k in range(segments):
                bm.faces.new((a[k], a[(k + 1) % segments], b[(k + 1) % segments], b[k]))


def arc_bmesh(major: float, minor: float, span: float, n_major: int, n_minor: int = 8):
    bm = bmesh.new()
    rows = []
    for i in range(n_major + 1):
        phi = -span / 2 + span * i / n_major
        radial = Vector((math.cos(phi), math.sin(phi), 0.0))
        c = radial * major
        rows.append([bm.verts.new(c + (radial * math.cos(math.tau * j / n_minor) + Vector((0, 0, 1)) * math.sin(math.tau * j / n_minor)) * minor) for j in range(n_minor)])
    for i in range(n_major):
        for j in range(n_minor):
            bm.faces.new((rows[i][j], rows[i][(j + 1) % n_minor], rows[i + 1][(j + 1) % n_minor], rows[i + 1][j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)
    for m in list(bpy.data.materials):
        bpy.data.materials.remove(m)
    for li in list(bpy.data.lights):
        bpy.data.lights.remove(li)


class Noise2:
    """種を固定した滑らかな値のノイズ（-1〜1）"""

    def __init__(self, seed: int, n: int = 256):
        rng = np.random.default_rng(seed)
        self.n = n
        self.v = rng.uniform(-1, 1, (n, n))

    def __call__(self, x: float, y: float) -> float:
        xi, yi = math.floor(x), math.floor(y)
        fx, fy = x - xi, y - yi
        sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
        n = self.n
        a = self.v[xi % n, yi % n]
        b = self.v[(xi + 1) % n, yi % n]
        c = self.v[xi % n, (yi + 1) % n]
        d = self.v[(xi + 1) % n, (yi + 1) % n]
        return float(a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy)


# ── 砂浜の形（three の座標） ─────────────────────────────────────────────
def shoreline(x: float) -> float:
    """波打ち際の z（左が +Z）。中ほどでレールに最も近く、乗り場の手前で岬のように離れる"""
    return 6.0 + 0.0035 * (x - 52.0) ** 2 + 0.06 * max(0.0, 30.0 - x) ** 2


def smoothstep(e0: float, e1: float, x: float) -> float:
    k = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return k * k * (3 - 2 * k)


def build(rail: Rail, rng: random.Random, globe_center: np.ndarray) -> dict:
    coll = collection(ROOM)
    s0, s1 = rail.sections[ROOM]
    path3 = rail.samples(s0 - 2, s1 + 2, 0.5, three=True)  # three の座標
    path = rail.samples(s0 - 2, s1 + 2, 0.5)  # Blender の座標
    objs: dict[str, list] = {'beach': [], 'brass': [], 'glass': [], 'water': [], 'membrane': [], 'hills': [], 'template': [], 'marker': [], 'hidden': [], 'globe': []}

    sand_mat = material(f'{ROOM}.sand', (0.86, 0.86, 0.88), roughness=0.7)
    brass_mat = material(f'{ROOM}.brass', (0.78, 0.60, 0.34), metallic=1.0, roughness=0.3)
    glass_mat = material(f'{ROOM}.glass', (0.95, 0.95, 1.0), roughness=0.05, alpha=0.2)
    water_mat = material(f'{ROOM}.water', (0.2, 0.3, 0.4), roughness=0.05)
    hill_mat = material(f'{ROOM}.hill', (0.45, 0.42, 0.55), roughness=1.0)

    # 1. ガラスの砂浜: 波打ち際からの距離 d で高さを決める。水の下へも少し続け、天球の手前では水に沈める
    noise = Noise2(SEED)
    xs = np.arange(16.0, 134.0 + 1e-6, 1.0)
    ds = np.concatenate([np.arange(-7.0, 14.0, 0.5), np.arange(14.0, 76.0 + 1e-6, 1.5)])
    gc = globe_center  # three の座標

    def height(x: float, d: float) -> float:
        if d < 0:
            h = 0.06 * d
        elif d < 14:
            h = 0.045 * d
        else:
            h = 0.63 + 0.035 * (d - 14)
        dune = smoothstep(12.0, 32.0, d) * (1.7 + 1.3 * noise(x / 17.0, d / 13.0) + 0.5 * noise(x / 6.0 + 40, d / 5.0))
        h += dune
        h += 0.08 * noise(x / 3.0 + 9, d / 2.5) * smoothstep(1.0, 6.0, d)  # 小さなうねり
        return h

    bm = bmesh.new()
    grid = []
    for x in xs:
        row = []
        zs = shoreline(float(x))
        for d in ds:
            z = zs + float(d)
            h = height(float(x), float(d))
            # 天球の外殻の手前 6m から水に沈める（ガラスの球に砂を入れない）
            dist = math.sqrt((x - gc[0]) ** 2 + (h - gc[1]) ** 2 + (z - gc[2]) ** 2)
            h -= 4.0 * smoothstep(GLOBE_RADIUS + 7.0, GLOBE_RADIUS + 1.0, dist)
            row.append(bm.verts.new(B(float(x), h, z)))
        grid.append(row)
    for i in range(len(xs) - 1):
        for j in range(len(ds) - 1):
            bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
    # 天球の中に入る面と、レールの側へ出すぎる水の下の面（物の箱がレールから 1.75m 以内に来ないよう z < 2.6）は消す
    dead = []
    for f in bm.faces:
        for v in f.verts:
            x, y, z = v.co.x, v.co.z, -v.co.y  # Blender → three
            if z < 2.6 or math.sqrt((x - gc[0]) ** 2 + (y - gc[1]) ** 2 + (z - gc[2]) ** 2) < GLOBE_RADIUS + 0.6:
                dead.append(f)
                break
    bmesh.ops.delete(bm, geom=list(set(dead)), context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    beach = mesh_object(f'{ROOM}.beach', bm, coll, sand_mat, {'role': 'beach'})
    objs['beach'].append(beach)

    # 2. 真鍮の標柱と、その上のガラスの浮き玉の灯（左右で一つずつにまとめる）
    stations = [88.0, 75.0, 62.0, 49.0, 36.0, 23.0]
    for side, sign in (('left', 1.0), ('right', -1.0)):
        bm_post = bmesh.new()
        bm_lamp = bmesh.new()
        for x in stations:
            z = 3.6 * sign
            prof = [(0.0, -0.8), (0.055, -0.8)]
            for y in np.linspace(-0.8, 2.2, 16):
                bead = 0.03 * math.exp(-((y - 0.95) / 0.05) ** 2) + 0.025 * math.exp(-((y - 1.75) / 0.04) ** 2)
                prof.append((0.05 + bead, float(y)))
            # 頂の受け皿（丸い縁）
            prof += [(0.07, 2.24), (0.13, 2.30), (0.15, 2.34), (0.12, 2.36), (0.0, 2.33)]
            lathe(bm_post, prof, (x, 0.0, z), 12)
            g = bmesh.ops.create_uvsphere(bm_lamp, u_segments=20, v_segments=10, radius=0.17)
            bmesh.ops.translate(bm_lamp, verts=g['verts'], vec=Vector(B(x, 2.5, z)))
        bmesh.ops.remove_doubles(bm_post, verts=bm_post.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(bm_post, faces=bm_post.faces)
        objs['brass'].append(mesh_object(f'{ROOM}.posts_{side}', bm_post, coll, brass_mat, {'role': 'post'}))
        objs['glass'].append(mesh_object(f'{ROOM}.lamps_{side}', bm_lamp, coll, glass_mat, {'role': 'lamp', 'glass': 'milky'}))

    # 3. 乗り場への膜（区間の終わり、レールに直交する円）と、縁の真鍮の輪
    end3 = rail.point(s1, three=True)
    i_end = int(round(s1 / rail.spacing))
    fwd_b = rail.fwd[min(i_end, len(rail.fwd) - 1)]
    fwd3 = np.array([fwd_b[0], fwd_b[2], -fwd_b[1]])  # Blender → three
    n3 = fwd3 / np.linalg.norm(fwd3)
    up3 = np.array([0.0, 1.0, 0.0])
    side3 = np.cross(up3, n3)
    side3 /= np.linalg.norm(side3)
    bm = bmesh.new()
    centre = bm.verts.new(B(*end3))
    rings = []
    for j in range(1, 9):
        r = 2.7 * j / 8
        rings.append([bm.verts.new(B(*(end3 + (side3 * math.cos(a) + up3 * math.sin(a)) * r))) for a in np.linspace(0, math.tau, 48, endpoint=False)])
    for k in range(48):
        bm.faces.new((centre, rings[0][k], rings[0][(k + 1) % 48]))
    for ra, rb in zip(rings[:-1], rings[1:]):
        for k in range(48):
            bm.faces.new((ra[k], rb[k], rb[(k + 1) % 48], ra[(k + 1) % 48]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    objs['membrane'].append(mesh_object(f'{ROOM}.membrane', bm, coll, glass_mat, {'role': 'membrane', 'glass': 'membrane', 'clearance_exempt': True, 'to': 'departure'}))
    arc = bpy.data.meshes.new(f'{ROOM}.arc_membrane')
    bm = arc_bmesh(2.85, 0.05, math.tau / 12, 4)
    bm.to_mesh(arc)
    bm.free()
    for f in arc.polygons:
        f.use_smooth = True
    arc.materials.append(brass_mat)
    nb = np.array(B(*n3))
    hint = np.array(B(*up3))
    x_ax = hint - nb * np.dot(hint, nb)
    x_ax /= np.linalg.norm(x_ax)
    y_ax = np.cross(nb, x_ax)
    rot = Matrix(((x_ax[0], y_ax[0], nb[0]), (x_ax[1], y_ax[1], nb[1]), (x_ax[2], y_ax[2], nb[2]))).to_4x4()
    loc = Matrix.Translation(Vector(B(*end3)))
    for k in range(12):
        ob = bpy.data.objects.new(f'{ROOM}.membrane_ring.{k:03d}', arc)
        ob.matrix_world = loc @ rot @ Matrix.Rotation(math.tau * k / 12, 4, 'Z')
        ob['role'] = 'brass'
        ob['instance_group'] = 'membrane_ring'
        coll.objects.link(ob)
        objs['brass'].append(ob)

    # 4. 遠景の丘の板（中心 (55, 0, 0) の周りの円弧。進行方向から左へ測った方位 A）。上の縁が丘の形
    hills = [
        # (半径, 方位の始め, 終わり, 高さの基準, ゆらぎ, ノイズの種)
        (180.0, 14.0, 178.0, 9.0, 14.0, 1),
        (330.0, -6.0, 155.0, 16.0, 26.0, 2),
        (580.0, -20.0, 118.0, 22.0, 34.0, 3),
        (640.0, -80.0, -48.0, 6.0, 12.0, 4),  # 右の遠い岬（朝日を挟む）
    ]
    for li, (rad, a0, a1, base, var, sd) in enumerate(hills):
        nz = Noise2(SEED + 17 * sd)
        bm = bmesh.new()
        cols = []
        n = int(abs(a1 - a0) / 0.75) + 1
        for k in range(n + 1):
            a = math.radians(a0 + (a1 - a0) * k / n)
            dx, dz = -math.cos(a), math.sin(a)
            u = k / n
            taper = smoothstep(0.0, 0.12, u) * smoothstep(1.0, 0.86, u)  # 端は低く海へ落ちる
            h = (base + var * (0.55 + 0.45 * nz(k * 0.09, 3.3) + 0.25 * nz(k * 0.31, 7.1))) * (0.25 + 0.75 * taper)
            x, z = 55.0 + dx * rad, dz * rad
            cols.append((bm.verts.new(B(x, -4.0, z)), bm.verts.new(B(x, h, z))))
        for (a, b), (c, d) in zip(cols[:-1], cols[1:]):
            bm.faces.new((a, c, d, b))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        objs['hills'].append(mesh_object(f'{ROOM}.hills.{li}', bm, coll, hill_mat, {'role': 'hills', 'layer': li, 'distance': rad, 'clearance_exempt': True}, smooth=False))

    # 5. 海のガラスの小石: 型と、置く場所（波打ち際に寄り集まる）
    for name, sub, squash in (('pebble_a', 2, 0.55), ('pebble_b', 2, 0.42), ('pebble_c', 1, 0.6)):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
        for v in bm.verts:
            v.co.z *= squash
            v.co.x *= 1.0 + 0.25 * (name == 'pebble_b')
        ob = mesh_object(f'{ROOM}.{name}', bm, coll, glass_mat, {'role': 'pebble_template', 'glass': 'frosted', 'pebble_kind': name[-1]})
        ob.location = Vector(B(55.0, -300.0, 0.0))
        objs['template'].append(ob)
    pts: list[float] = []
    tries = 0
    while len(pts) < 6 * 300 and tries < 20000:
        tries += 1
        x = rng.uniform(26.0, 120.0)
        d = rng.choice([rng.uniform(-0.2, 2.5), rng.uniform(0.0, 7.0), rng.uniform(2.0, 16.0)])
        z = shoreline(x) + d
        y = height(x, d)
        if math.sqrt((x - gc[0]) ** 2 + (y - gc[1]) ** 2 + (z - gc[2]) ** 2) < GLOBE_RADIUS + 8:
            continue
        if float(np.sqrt(((path3 - np.array([x, y, z])) ** 2).sum(axis=1)).min()) < 3.5:
            continue
        s = rng.uniform(0.05, 0.11) * (1.6 if rng.random() < 0.1 else 1.0)  # 指先ほどの小石
        pts += [round(x, 3), round(y + s * 0.2, 3), round(z, 3), round(s, 3), round(rng.uniform(0, math.tau), 3), float(rng.randrange(3))]
    marker = bpy.data.objects.new(f'{ROOM}.pebbles', None)
    marker['role'] = 'pebbles'
    marker['points'] = pts
    coll.objects.link(marker)
    objs['marker'].append(marker)
    print(f'{ROOM}: 小石 {len(pts) // 6} 個')

    # 6. 隠れた小さな泡: 右の標柱の根もと、水面に浮かぶ（朝日の方を見ると気づく）
    ob = mesh_object(f'{ROOM}.hidden_bubble', uv_sphere(0.15, 24, 12), coll, glass_mat, {
        'role': 'hidden', 'glass': 'iridescent', 'touch_kind': 'hidden-bubble', 'touch_id': f'{ROOM}/hidden',
    })
    ob.location = Vector(B(37.3, 0.42, -4.3))  # 朝日（右前）を見ると、その手前の標柱の根もとに
    objs['hidden'].append(ob)

    # 7. 振り返ったときの天球の代役: 外殻の球と、真鍮の子午線と黄道（星の天球と同じ形と向き）
    g = globe_frame(rail)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=96, v_segments=48, radius=SHELL_RADII[-1])
    globe = mesh_object(f'{ROOM}.globe', bm, coll, glass_mat, {'role': 'globe', 'glass': 'iridescent', 'clearance_exempt': True, 'radius': SHELL_RADII[-1]})
    globe.location = Vector(g['C'].tolist())
    objs['globe'].append(globe)
    arc_me = bpy.data.meshes.new(f'{ROOM}.arc_globe')
    bm = globe_arc_bmesh(g['r_mer'], MERIDIAN_MINOR, math.tau / MERIDIAN_ARCS, MERIDIAN_SEGMENTS)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(arc_me)
    bm.free()
    arc_me.materials.append(brass_mat)
    k = 0
    for n in (g['n_mer'], g['n_ecl']):
        for m in ring_matrices(g['C'], n, MERIDIAN_ARCS):
            ob = bpy.data.objects.new(f'{ROOM}.globe_ring.{k:03d}', arc_me)
            ob.matrix_world = m
            ob['role'] = 'brass'
            ob['instance_group'] = 'globe_ring'
            coll.objects.link(ob)
            objs['brass'].append(ob)
            k += 1

    # 8. 物とレールの距離（テストと同じ、物の軸に沿った箱で）
    bpy.context.view_layer.update()
    for o in objs['beach'] + objs['brass'] + objs['glass'] + objs['hidden']:
        d = box_distance(*world_box(o), path)
        if d < CLEARANCE:
            raise SystemExit(f'{o.name} がレールに近すぎます（{d:.2f}m < {CLEARANCE}m）')
    print(f"{ROOM}: 物とレールの最短（箱）: 砂浜 {box_distance(*world_box(beach), path):.2f}m、標柱 {min(box_distance(*world_box(o), path) for o in objs['brass']):.2f}m")
    return {'objs': objs, 'coll': coll, 'water_mat': water_mat}


def make_water(coll, mat) -> object:
    """水面: 中心 (55, 0, 0)、半径 1600m の円盤（輪を重ねる）。天球とホールの穴は TS がシェーダで空ける"""
    bm = bmesh.new()
    radii = [0.0, 12.0, 30.0, 60.0, 110.0, 200.0, 380.0, 750.0, 1600.0]
    seg = 64
    rings = []
    for r in radii:
        if r == 0:
            rings.append([bm.verts.new(B(55.0, 0.0, 0.0))])
        else:
            rings.append([bm.verts.new(B(55.0 + r * math.cos(math.tau * k / seg), 0.0, r * math.sin(math.tau * k / seg))) for k in range(seg)])
    for a, b in zip(rings[:-1], rings[1:]):
        if len(a) == 1:
            for k in range(seg):
                bm.faces.new((a[0], b[k], b[(k + 1) % seg]))
        else:
            for k in range(seg):
                bm.faces.new((a[k], b[k], b[(k + 1) % seg], a[(k + 1) % seg]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:  # 上向きに揃える
        if f.normal.z < 0:
            f.normal_flip()
    return mesh_object(f'{ROOM}.water', bm, coll, mat, {'role': 'water', 'clearance_exempt': True}, smooth=False)


def set_world(color: tuple[float, float, float], strength: float) -> None:
    world = bpy.context.scene.world or bpy.data.worlds.new('World')
    bpy.context.scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (*color, 1.0)
    bg.inputs['Strength'].default_value = strength


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--samples', type=int, default=256)
    ap.add_argument('--size', type=int, default=2048)
    ap.add_argument('--no-bake', action='store_true')
    args = ap.parse_args(script_args())
    t_start = time.time()
    clear_scene()
    rail = Rail(RAIL_JSON)
    rng = random.Random(SEED)
    # 星の天球の中心（9:50 のゴンドラの位置。celestial.py と同じ求め方）
    gc = rail.point(rail.s_at(177 * 10.0 / 3.0), three=True)
    info = build(rail, rng, gc)
    objs = info['objs']
    coll = info['coll']
    bpy.context.view_layer.update()

    # 見えない面の削除: 砂浜と標柱。水面（不透明）を仮の遮りとして置き、水の下の砂を消す。区間の前後に 30m の余裕
    s0, s1 = rail.sections[ROOM]
    span = rail.samples(max(0.0, s0 - 30), s1 + 30, rail.spacing)
    bm = bmesh.new()
    vs = [bm.verts.new(B(55 + x, -0.02, z)) for x, z in ((-900, -900), (900, -900), (900, 900), (-900, 900))]
    bm.faces.new(vs)
    occluder = mesh_object(f'{ROOM}.occluder', bm, coll, None, {'see_through': False})
    bpy.context.view_layer.update()
    opaque = objs['beach'] + [o for o in objs['brass'] if o.get('instance_group') is None]
    rep = cull_hidden(opaque + [occluder], span, yaw_deg=120, pitch_deg=60, head_radius=0.5)
    bpy.data.objects.remove(occluder, do_unlink=True)
    print(f"cull: {rep['before_tris']} → {rep['after_tris']} 三角形（遮りの板を含む。{rep['removed_faces']} 面を削除、{rep['rays']} 本、{rep['seconds']}s）")
    for name, o in rep['objects'].items():
        if name != f'{ROOM}.occluder':
            print(f"  {name}: {o['before_tris']} → {o['after_tris']}")

    water = make_water(coll, info['water_mat'])
    objs['water'].append(water)

    export = objs['beach'] + objs['water'] + objs['brass'] + objs['glass'] + objs['membrane'] + objs['hills'] + objs['template'] + objs['marker'] + objs['hidden'] + objs['globe']
    bad = check_names(export, rooms=[ROOM])
    if bad:
        raise SystemExit(f'名前の規則に合わない物: {bad}')
    bpy.context.view_layer.update()

    if not args.no_bake:
        # 焼くのは砂浜だけ。焼くあいだは、ガラス・水・遠景・型を描かない（光を遮らない）。小石はガラスなので影を焼かない
        hide = objs['water'] + objs['glass'] + objs['membrane'] + objs['hills'] + objs['template'] + objs['hidden'] + objs['globe'] + [o for o in objs['brass'] if o.get('instance_group')]
        for o in hide:
            o.hide_render = True
        # (a) 朝日: 低い太陽だけ（空は黒）
        sun_three = np.array([-math.cos(math.radians(SUN_AZIMUTH_DEG)), 0.0, -math.sin(math.radians(SUN_AZIMUTH_DEG))])
        el = math.radians(SUN_BAKE_ELEVATION_DEG)
        sun_three = sun_three * math.cos(el) + np.array([0.0, math.sin(el), 0.0])
        sun_b = Vector(B(*sun_three))
        light = bpy.data.lights.new(f'{ROOM}.bake_sun', 'SUN')
        light.energy = 3.0
        light.angle = math.radians(1.2)
        sun = bpy.data.objects.new(f'{ROOM}.bake_sun', light)
        sun.rotation_euler = (-sun_b).to_track_quat('-Z', 'Y').to_euler()
        coll.objects.link(sun)
        set_world((0.0, 0.0, 0.0), 0.0)
        t0 = time.time()
        res = bake_lightmaps(objs['beach'], OUT_DIR, size=args.size, samples=args.samples, name=f'{ROOM}.sunmap')
        for o in objs['beach']:
            o['sunmap'] = o['lightmap']
            o['sunmap_scale'] = o['lightmap_scale']
        print(f"bake 朝日: {time.time() - t0:.1f}s scale={res[0]['scale']} max/scale={res[0]['max_over_scale']:.2f}")
        # (b) 空の光: 一様な白い空（色は TS が時刻で付ける）
        sun.hide_render = True
        set_world((1.0, 1.0, 1.0), 1.0)
        t0 = time.time()
        res = bake_lightmaps(objs['beach'], OUT_DIR, size=args.size, samples=args.samples, name=f'{ROOM}.lightmap', repack=False)
        print(f"bake 空: {time.time() - t0:.1f}s scale={res[0]['scale']} max/scale={res[0]['max_over_scale']:.2f}")
        for o in hide:
            o.hide_render = False
    elif not all(o.get('lightmap') for o in objs['beach']):
        for o in objs['beach']:
            o['lightmap'] = f'{ROOM}.lightmap.png'
            o['lightmap_scale'] = 1.0
            o['sunmap'] = f'{ROOM}.sunmap.png'
            o['sunmap_scale'] = 1.0
        print('WARNING: --no-bake: lightmap_scale は 1.0 の仮です（焼き直してください）')

    size = export_glb(export, GLB, rooms=[ROOM])
    print(f'glb: {GLB} {size}B、物 {len(export)}')
    if all(os.path.exists(os.path.join(OUT_DIR, o['lightmap'])) for o in objs['beach']):
        rep = room_load_report(objs['beach'], GLB, OUT_DIR)
        sun_png = os.path.join(OUT_DIR, f'{ROOM}.sunmap.png')
        if os.path.exists(sun_png):
            total = rep['total'] + os.path.getsize(sun_png)
            print(f'room load（朝日のライトマップを含む）: {total}B / 上限 15000000B' + ('  WARNING: 上限を超えています' if total > 15_000_000 else ''))
    os.makedirs(os.path.dirname(BLEND), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND, compress=True)
    print(f'blend: {BLEND}、全体 {time.time() - t_start:.1f}s')


if __name__ == '__main__':
    main()
