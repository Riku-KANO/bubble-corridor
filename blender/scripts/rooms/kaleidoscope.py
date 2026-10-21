"""第3室「万華鏡の間」（6:00〜8:00）の造形 → 見えない面の削除 → 焼き込み → glb（BLD-4〜7）。

    pnpm blender blender/scripts/rooms/kaleidoscope.py [-- --samples 256 --size 2048 --quick --no-env]

出力: public/assets/rooms/kaleidoscope.glb・kaleidoscope.lightmap.png・kaleidoscope.env.png（筒の中から撮った本物の多重の鏡の
環境画像。TS が金・青の色を掛けて鏡の板と真鍮に映す）、blender/scenes/kaleidoscope.blend。

絵コンテ（入口で視界が開ける一枚絵）:
  雨の回廊の円い膜を抜けると、六角の長い筒（巨大な万華鏡の胴）がまっすぐ奥の光の点へ伸びる。
  筒の6つの角には内側から光るプリズムの棒が列をなし、鏡の板が光の列を何重にも映して消失点へ集める。
  筒の軸のまわりには色ガラスのロゼット（花の輪）がいくつも浮かび、ゆっくり互い違いに回る。
  ゴンドラは輪の中心をまっすぐ抜けていく。金の万華鏡は琥珀と金、青の万華鏡は瑠璃と水色（形は共通、色は TS が替える）。
見どころ（7:20）: 散らばったガラス片が集まり、前方に巨大な花の模様を描く（画面効果の折り返しで部屋全体の模様になる）。

作る物（名前は `kaleidoscope.<部品>[.<番号>]`。カスタムプロパティは glb の extras → three の userData）:
  焼き込む物: panel（鏡の板。拡散の光を焼き、鏡の映り込みは TS が環境画像で足す）・endwall
  インスタンス（リンク複製）: prism（角の光る棒。焼き込みの光源）・rosette_<k>_petal / _jewel（回る模様）・shard_a/b/c（散らばるガラス片）
  ガラス片（触れられる物）: touchshard（touch_kind = shard、touch_id）
  真鍮: ribs（筒の継ぎ目の六角の輪。殻）・portal_ring、膜: membrane（天球へ）

物との距離（RIDE-8）: 筒の板・輪・端の壁は軸から 1.85m 以上（本当の形で測る）。ロゼット・ガラス片は軸から 2.4m 以上（箱で測る）。
画面効果の折り返し（src/fx/composite.ts の FOLD_NEAR）より遠く、部屋の物は視点から 2m より遠くに置く。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import struct
import sys
import time
import warnings

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from common.bake import bake_lightmaps  # noqa: E402
from common.cli import script_args  # noqa: E402
from common.coords import three_to_blender  # noqa: E402
from common.export import export_glb, room_load_report  # noqa: E402
from common.naming import check_names  # noqa: E402
from common.visibility import cull_hidden  # noqa: E402

warnings.filterwarnings('ignore', category=DeprecationWarning)

ROOM = 'kaleidoscope'
CULL_MARGIN = 30.0
CLEAR = 1.2 + 0.5
SHELL_CLEAR = CLEAR + 0.1

# ── 筒の寸法（m） ──
HEX_R = 5.0  # 六角の角までの半径（内接は 4.33）
SEG = 3.0  # 板の長さ（継ぎ目の間隔）
PANEL_INSET = 0.32  # 角から板までのすき間（プリズムの棒が入る）
PANEL_GAP = 0.12  # 板と板の継ぎ目
PANEL_T = 0.12  # 板の厚み
FILLET = 0.07  # 板の縁の丸み
PORTAL_R = 1.9  # 端の壁の円い口
#: ロゼット（回る模様）の位置（区間の頭からの m）と作り（花びらの数、内と外の半径、花びらの形）
ROSETTES = [
    (10.0, 12, 2.45, 3.7, 'lens'),
    (22.0, 8, 2.5, 4.0, 'diamond'),
    (34.0, 16, 2.45, 3.5, 'lens'),
    (46.0, 10, 2.55, 3.95, 'diamond'),
    (58.0, 18, 2.45, 3.4, 'lens'),
    (70.0, 12, 2.6, 4.05, 'diamond'),
    (96.0, 9, 2.5, 3.8, 'lens'),
]
#: 散らばるガラス片の数（形ごと）と、触れられるガラス片の数
SHARDS = {'shard_a': 90, 'shard_b': 80, 'shard_c': 70}
TOUCH_SHARDS = 18


# ── レール ──────────────────────────────────────────────────────────
class Rail:
    def __init__(self, ride: dict):
        self.spacing = float(ride['rail']['spacing'])
        self.P = np.array([three_to_blender(p) for p in ride['rail']['points']], dtype=np.float64)
        self.sections = {sec['id']: (float(sec['s0']), float(sec['s1'])) for sec in ride['sections']}

    def point(self, s: float) -> np.ndarray:
        x = min(max(s / self.spacing, 0.0), len(self.P) - 1.000001)
        i = int(math.floor(x))
        f = x - i
        return self.P[i] * (1 - f) + self.P[i + 1] * f

    def frame(self, s: float):
        c = self.point(s)
        d = self.point(s + 1.0) - self.point(s - 1.0)
        d[2] = 0.0
        f = d / max(1e-9, np.linalg.norm(d))
        r = np.array([f[1], -f[0], 0.0])
        return c, f, r

    def span_points(self, s0: float, s1: float, step: float = 1.0):
        out = []
        s = s0
        while s <= s1 + 1e-9:
            out.append(tuple(self.point(s)))
            s += step
        return out


# ── 材質 ──────────────────────────────────────────────────────────────
class Mats:
    """焼き込み・環境画像のときの材質と、書き出す材質（glTF の基本だけ。拡張を使わない）"""

    def __init__(self):
        self.bake: dict = {}
        self.export: dict = {}

    def add(self, key, color, rough=0.5, metal=0.0, alpha=1.0, emit=None, emit_strength=0.0, export_color=None, coat=0.0):
        bm = bpy.data.materials.new(f'{ROOM}.{key}.bake')
        bm.use_nodes = True
        p = bm.node_tree.nodes.get('Principled BSDF')
        p.inputs['Base Color'].default_value = (*color, 1.0)
        p.inputs['Roughness'].default_value = rough
        p.inputs['Metallic'].default_value = metal
        p.inputs['Alpha'].default_value = alpha
        if coat:
            p.inputs['Coat Weight'].default_value = coat
        if emit is not None:
            p.inputs['Emission Color'].default_value = (*emit, 1.0)
            p.inputs['Emission Strength'].default_value = emit_strength
        em = bpy.data.materials.new(f'{ROOM}.{key}')
        em.use_nodes = True
        q = em.node_tree.nodes.get('Principled BSDF')
        q.inputs['Base Color'].default_value = (*(export_color or color), 1.0)
        q.inputs['Roughness'].default_value = rough
        q.inputs['Metallic'].default_value = metal
        if emit is not None:
            q.inputs['Emission Color'].default_value = (*emit, 1.0)
            q.inputs['Emission Strength'].default_value = 1.0
        self.bake[key] = bm
        self.export[key] = em

    def use(self, which: str, objs):
        table = self.bake if which == 'bake' else self.export
        for o in objs:
            key = o.get('mat_key')
            if key and o.type == 'MESH':
                o.data.materials.clear()
                o.data.materials.append(table[key])


MATS = Mats()
COLL = None
OBJECTS: list = []


def mesh_object(name, verts, faces, mat_key, props=None, smooth=True, sharp_angle_deg=50.0):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], [tuple(int(i) for i in f) for f in faces])
    me.validate(clean_customdata=False)
    me.update()
    obj = bpy.data.objects.new(name, me)
    COLL.objects.link(obj)
    obj['mat_key'] = mat_key
    me.materials.append(MATS.bake[mat_key])
    if smooth:
        me.shade_smooth()
        if sharp_angle_deg is not None:
            bm = bmesh.new()
            bm.from_mesh(me)
            lim = math.radians(sharp_angle_deg)
            for e in bm.edges:
                if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim:
                    e.smooth = False
            bm.to_mesh(me)
            bm.free()
    for k, v in (props or {}).items():
        obj[k] = v
    OBJECTS.append(obj)
    return obj


def linked_copy(src, name, matrix: Matrix, props=None):
    obj = bpy.data.objects.new(name, src.data)
    COLL.objects.link(obj)
    obj.matrix_world = matrix
    for k in src.keys():
        obj[k] = src[k]
    for k, v in (props or {}).items():
        obj[k] = v
    OBJECTS.append(obj)
    return obj


def recalc_closed(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def face_toward_axis(obj, rail: Rail, s_hint: float):
    """片面・閉じた板の面の表を、筒の軸へ向ける（軸の最寄りの点へ）"""
    me = obj.data
    mw = obj.matrix_world
    rot = mw.to_3x3()
    bm = bmesh.new()
    bm.from_mesh(me)
    c0, f0, _ = rail.frame(s_hint)
    for fa in bm.faces:
        c = mw @ fa.calc_center_median()
        # 軸（直線）上の最寄りの点
        t = (np.array(c) - c0) @ f0
        a = Vector(c0 + f0 * t)
        if (rot @ fa.normal).dot(a - c) < 0:
            fa.normal_flip()
    bm.to_mesh(me)
    bm.free()
    me.update()


class Builder:
    def __init__(self):
        self.v: list = []
        self.f: list = []

    def add(self, verts, faces):
        o = len(self.v)
        self.v.extend(verts)
        self.f.extend(tuple(i + o for i in face) for face in faces)


def torus_points(center, axis_u, axis_v, R, r, n_major=48, n_minor=10):
    center = np.asarray(center)
    au = np.asarray(axis_u)
    av = np.asarray(axis_v)
    aw = np.cross(au, av)
    verts = []
    for i in range(n_major):
        a = 2 * math.pi * i / n_major
        d = au * math.cos(a) + av * math.sin(a)
        for j in range(n_minor):
            b = 2 * math.pi * j / n_minor
            verts.append(center + d * (R + r * math.cos(b)) + aw * (r * math.sin(b)))
    faces = []
    for i in range(n_major):
        i2 = (i + 1) % n_major
        for j in range(n_minor):
            j2 = (j + 1) % n_minor
            faces.append((i * n_minor + j, i2 * n_minor + j, i2 * n_minor + j2, i * n_minor + j2))
    return verts, faces


def tube_along(points, radius, n_minor=8, closed=False):
    pts = [np.asarray(p, dtype=np.float64) for p in points]
    n = len(pts)
    verts = []
    for i, p in enumerate(pts):
        if closed:
            t = pts[(i + 1) % n] - pts[(i - 1) % n]
        else:
            t = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        t = t / max(1e-9, np.linalg.norm(t))
        a = np.array([0.0, 0.0, 1.0]) if abs(t[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
        u = np.cross(t, a)
        u /= np.linalg.norm(u)
        v = np.cross(t, u)
        for j in range(n_minor):
            b = 2 * math.pi * j / n_minor
            verts.append(p + (u * math.cos(b) + v * math.sin(b)) * radius)
    faces = []
    for i in range(n if closed else n - 1):
        i2 = (i + 1) % n
        for j in range(n_minor):
            j2 = (j + 1) % n_minor
            faces.append((i * n_minor + j, i * n_minor + j2, i2 * n_minor + j2, i2 * n_minor + j))
    return verts, faces


# ── 形の部品 ──────────────────────────────────────────────────────────
def pillow_panel(w: float, l: float, t: float, r: float, nu: int = 8, nv: int = 8):
    """丸い縁の板（局所: x = 幅、y = 長さ、z = 厚み。表は +z）。角を作らない"""
    verts = []
    faces = []
    # 角を丸めた長方形の輪郭（反時計回り、+z から見て）
    outline = []
    for cx, cy, a0 in ((w / 2 - r, l / 2 - r, 0.0), (-w / 2 + r, l / 2 - r, math.pi / 2), (-w / 2 + r, -l / 2 + r, math.pi), (w / 2 - r, -l / 2 + r, 1.5 * math.pi)):
        for i in range(5):
            a = a0 + (math.pi / 2) * i / 4
            outline.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    m = len(outline)
    # 縁の丸み: 断面は4段（下 → 縁 → 表の縁 → 表の内側へ少し入る）
    rings = [(0.0, 0.0), (t * 0.55, 0.0), (t, -r * 0.6)]
    for z, inset in rings:
        for x, y in outline:
            k = 1.0
            if inset:
                d = math.hypot(x, y)
                k = max(0.0, (d + inset) / d) if d > 1e-6 else 1.0
            verts.append((x * k, y * k, z))
    for ri in range(len(rings) - 1):
        for i in range(m):
            i2 = (i + 1) % m
            faces.append((ri * m + i, ri * m + i2, (ri + 1) * m + i2, (ri + 1) * m + i))
    # 表の面（内側の格子をつなぐのは手間なので、中心の点と扇で張る。焼き込みの UV は smart project が作る）
    top0 = (len(rings) - 1) * m
    cidx = len(verts)
    verts.append((0.0, 0.0, t + 0.004))
    for i in range(m):
        faces.append((top0 + i, top0 + (i + 1) % m, cidx))
    return verts, faces


def lens_shape(length: float, width: float, thick: float, n: int = 10):
    """両凸のレンズ形のガラス片（局所: x = 長さ、y = 幅、z = 厚み）。縁は丸い"""
    outline = []
    for i in range(n + 1):
        t = i / n
        x = -length / 2 + length * t
        outline.append((x, width / 2 * math.sin(math.pi * t) ** 0.8))
    for i in range(n - 1, 0, -1):
        t = i / n
        x = -length / 2 + length * t
        outline.append((x, -width / 2 * math.sin(math.pi * t) ** 0.8))
    return _puff(outline, thick)


def diamond_shape(length: float, width: float, thick: float):
    """角を丸めた菱形"""
    pts = []
    corners = [(length / 2, 0.0), (0.0, width / 2), (-length / 2, 0.0), (0.0, -width / 2)]
    for k in range(4):
        a = np.array(corners[k - 1])
        b = np.array(corners[k])
        c = np.array(corners[(k + 1) % 4])
        # 角 b を丸める
        p1 = b + (a - b) * 0.12
        p2 = b + (c - b) * 0.12
        for i in range(4):
            t = i / 3
            q = (1 - t) ** 2 * p1 + 2 * (1 - t) * t * b + t * t * p2
            pts.append(tuple(q))
    return _puff(pts, thick)


def _puff(outline, thick: float):
    """輪郭（xy、反時計回り）をふくらませた薄い片（上下に中心の点）"""
    m = len(outline)
    verts = [(x, y, 0.0) for x, y in outline]
    verts.append((0.0, 0.0, thick / 2))
    verts.append((0.0, 0.0, -thick / 2))
    top = m
    bot = m + 1
    faces = []
    for i in range(m):
        i2 = (i + 1) % m
        faces.append((i, i2, top))
        faces.append((i2, i, bot))
    return verts, faces


def jewel_shape(r: float, flat: float = 0.45, seg: int = 16, rings: int = 6):
    """押しつぶした玉（カボション）"""
    verts = [(0.0, 0.0, -r * flat)]
    for j in range(1, rings):
        ph = math.pi * j / rings
        z = -math.cos(ph) * r * flat
        rr = math.sin(ph) * r
        for i in range(seg):
            a = 2 * math.pi * i / seg
            verts.append((rr * math.cos(a), rr * math.sin(a), z))
    verts.append((0.0, 0.0, r * flat))
    faces = []
    for i in range(seg):
        faces.append((0, 1 + (i + 1) % seg, 1 + i))
    for j in range(rings - 2):
        for i in range(seg):
            a = 1 + j * seg + i
            b = 1 + j * seg + (i + 1) % seg
            faces.append((a, b, b + seg, a + seg))
    top = len(verts) - 1
    base = 1 + (rings - 2) * seg
    for i in range(seg):
        faces.append((base + i, base + (i + 1) % seg, top))
    return verts, faces


def prism_rod(length: float, r: float):
    """角の丸い三角柱の棒（局所: y が長さ。三角の頂点の1つは +x）"""
    prof = []
    for k in range(3):
        a0 = 2 * math.pi * k / 3
        for i in range(4):
            a = a0 - math.pi / 3 + (2 * math.pi / 3) * i / 3
            # 三角の角を丸めた輪郭（角の近くで外へ）
            rr = r * (0.82 + 0.18 * math.cos(3 * (a - a0)))
            prof.append((rr * math.cos(a), rr * math.sin(a)))
    m = len(prof)
    verts = []
    for y in (-length / 2, length / 2):
        for x, z in prof:
            verts.append((x, y, z))
    faces = []
    for i in range(m):
        i2 = (i + 1) % m
        faces.append((i, i2, m + i2, m + i))
    verts.append((0.0, -length / 2, 0.0))
    verts.append((0.0, length / 2, 0.0))
    a = 2 * m
    b = 2 * m + 1
    for i in range(m):
        i2 = (i + 1) % m
        faces.append((i2, i, a))
        faces.append((m + i, m + i2, b))
    return verts, faces


def frame_matrix(origin, x_axis, y_axis, z_axis, scale: float = 1.0) -> Matrix:
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0] = x_axis[i] * scale
        m[i][1] = y_axis[i] * scale
        m[i][2] = z_axis[i] * scale
        m[i][3] = origin[i]
    return m


# ── 造形 ──────────────────────────────────────────────────────────────
def build(rail: Rail, rng: random.Random) -> dict:
    s0, s1 = rail.sections[ROOM]
    a_s = s0 + 1.2  # 入口の壁の表（雨の回廊の突き当たりの壁は s0+0.5〜s0+0.85。その奥の扉の光の板と重ならないよう離す）
    b_s = s1 + 0.55  # 出口の壁
    c0, F, R = rail.frame((s0 + s1) / 2)
    UP = np.array([0.0, 0.0, 1.0])
    info = {}

    MATS.add('panel', (0.16, 0.16, 0.17), rough=0.18, coat=0.0)
    MATS.add('endwall', (0.2, 0.2, 0.21), rough=0.3)
    MATS.add('brass', (0.62, 0.45, 0.22), rough=0.3, metal=1.0)
    MATS.add('prism', (0.9, 0.92, 0.95), rough=0.05, emit=(1.0, 0.97, 0.92), emit_strength=9.0, export_color=(1.0, 0.97, 0.92))
    MATS.add('glass', (0.9, 0.92, 0.95), rough=0.05, alpha=0.45)
    MATS.add('membrane', (0.9, 0.95, 1.0), rough=0.05, alpha=0.1)
    MATS.add('glowring', (0.0, 0.0, 0.0), emit=(1.0, 0.95, 0.85), emit_strength=6.0, export_color=(1.0, 0.95, 0.85))

    def at(s, ang, rad):
        """軸の点 s の、角度 ang（右から上へ）・半径 rad の点"""
        c = rail.point(s)
        return c + (R * math.cos(ang) + UP * math.sin(ang)) * rad

    # 1. 鏡の板（6面 × 区切り）。面の中心の角度は 30° + 60°k（角は 0°, 60°, ...: 右と左が角、上と下が平ら）
    apothem = HEX_R * math.cos(math.pi / 6)
    side = HEX_R  # 六角の辺の長さ = 外接半径
    pw = side - 2 * PANEL_INSET
    n_seg = int(round((b_s - a_s) / SEG))
    seg_len = (b_s - a_s) / n_seg
    panels = []
    for k in range(6):
        ang = math.radians(30 + 60 * k)
        normal_in = -(R * math.cos(ang) + UP * math.sin(ang))  # 軸へ向く
        tangent = R * math.cos(ang + math.pi / 2) + UP * math.sin(ang + math.pi / 2)
        for i in range(n_seg):
            sc = a_s + seg_len * (i + 0.5)
            center = rail.point(sc) - normal_in * (apothem + PANEL_T)
            v, f = pillow_panel(pw, seg_len - PANEL_GAP, PANEL_T, FILLET)
            mtx = frame_matrix(center, tangent, F, normal_in)
            world = [tuple(mtx @ Vector(p)) for p in v]
            o = mesh_object(f'{ROOM}.panel.{len(panels):03d}', world, f, 'panel', {'bake_group': 'panel', 'look': 'mirror', 'clearance_exempt': True, 'shell': True}, sharp_angle_deg=60)
            panels.append(o)
    info['panels'] = len(panels)

    # 2. 角のプリズムの棒（焼き込みの光源。TS ではインスタンスの光るガラス）
    rod_src = mesh_object(f'{ROOM}.prism', *prism_rod(seg_len - 0.32, 0.13), 'prism', {'look': 'prism', 'instance': 'prism'})
    recalc_closed(rod_src)
    rods = 0
    for k in range(6):
        ang = math.radians(60 * k)
        radial = R * math.cos(ang) + UP * math.sin(ang)
        tangent = R * math.cos(ang + math.pi / 2) + UP * math.sin(ang + math.pi / 2)
        for i in range(n_seg):
            sc = a_s + seg_len * (i + 0.5)
            center = rail.point(sc) + radial * (HEX_R - 0.42)
            # 三角の頂点（局所 +x）を軸へ向ける
            mtx = frame_matrix(center, -radial, F, np.cross(-radial, F))
            linked_copy(rod_src, f'{ROOM}.prism.{rods:03d}', mtx)
            rods += 1
    OBJECTS.remove(rod_src)
    bpy.data.objects.remove(rod_src)
    info['prisms'] = rods

    # 3. 継ぎ目の真鍮の六角の輪（殻）と、角に沿った細い桟
    ribs = Builder()
    for i in range(n_seg + 1):
        sc = a_s + seg_len * i
        pts = [at(sc, math.radians(60 * k), (apothem - 0.03) / math.cos(math.pi / 6)) for k in range(6)]
        # 角を丸めた六角（角ごとに3点）
        rounded = []
        for k in range(6):
            a = pts[k - 1]
            b = pts[k]
            c = pts[(k + 1) % 6]
            rounded += [b + (a - b) * 0.08, b, b + (c - b) * 0.08]
        ribs.add(*tube_along(rounded, 0.04, 8, closed=True))
    mesh_object(f'{ROOM}.ribs', ribs.v, ribs.f, 'brass', {'look': 'brass', 'clearance_exempt': True, 'shell': True})

    # 4. 端の壁（六角の板に円い口）と光の輪（焼き込みの光源）と膜
    def end_wall(s, name, facing):
        """facing = 1 なら前（+F）を向く面が表（出口の壁は手前を向く: facing = -1）"""
        bm = bmesh.new()
        outer = [at(s, math.radians(60 * k), HEX_R + 0.1) for k in range(6)]
        inner = [at(s, 2 * math.pi * i / 48, PORTAL_R) for i in range(48)]
        vo = [bm.verts.new(tuple(p)) for p in outer]
        vi = [bm.verts.new(tuple(p)) for p in inner]
        edges = [bm.edges.new((vo[i], vo[(i + 1) % 6])) for i in range(6)] + [bm.edges.new((vi[i], vi[(i + 1) % 48])) for i in range(48)]
        bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
        # 円の中の面を消す
        cen = Vector(rail.point(s))
        dead = [fa for fa in bm.faces if (fa.calc_center_median() - cen).length < PORTAL_R * 0.98]
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        ret = bmesh.ops.extrude_face_region(bm, geom=list(bm.faces))
        for v in [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]:
            v.co += Vector(F * 0.25 * (-facing))
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        verts = [tuple(v.co) for v in bm.verts]
        faces = [tuple(v.index for v in fa.verts) for fa in bm.faces]
        bm.free()
        return mesh_object(name, verts, faces, 'endwall', {'bake_group': 'endwall', 'clearance_exempt': True, 'shell': True}, sharp_angle_deg=50)

    end_wall(a_s, f'{ROOM}.endwall.000', 1)
    end_wall(b_s, f'{ROOM}.endwall.001', -1)
    rings = Builder()
    glows = Builder()
    for s, d in ((a_s, 0.05), (b_s, -0.05)):
        rings.add(*torus_points(rail.point(s + d), R, UP, PORTAL_R + 0.03, 0.055, 72, 10))
        glows.add(*torus_points(rail.point(s + d * 3), R, UP, PORTAL_R + 0.22, 0.05, 72, 8))
    mesh_object(f'{ROOM}.portal_ring', rings.v, rings.f, 'brass', {'look': 'brass', 'clearance_exempt': True, 'shell': True})
    mesh_object(f'{ROOM}.glowring', glows.v, glows.f, 'glowring', {'look': 'glowring', 'clearance_exempt': True, 'shell': True})
    disc = [tuple(rail.point(s1))]
    cm = rail.point(s1)
    for i in range(64):
        a = 2 * math.pi * i / 64
        disc.append(tuple(cm + (R * math.cos(a) + UP * math.sin(a)) * (PORTAL_R - 0.02)))
    disc_f = [(0, 1 + i, 1 + (i + 1) % 64) for i in range(64)]
    # 面は来る側（-F）へ向ける
    n0 = np.cross(np.array(disc[1]) - np.array(disc[0]), np.array(disc[2]) - np.array(disc[1]))
    if n0 @ F > 0:
        disc_f = [tuple(reversed(f)) for f in disc_f]
    mesh_object(f'{ROOM}.membrane', disc, disc_f, 'membrane', {'role': 'membrane', 'glass': 'iridescent', 'look': 'membrane', 'clearance_exempt': True, 'to': 'celestial'}, smooth=False)

    # 5. ロゼット（回る模様。輪ごとに形と数が違う）。花びらと玉はリンク複製
    petal_lens = mesh_object(f'{ROOM}.petal_lens', *lens_shape(1.0, 0.36, 0.05), 'glass', {'glass': 'tinted', 'look': 'petal'})
    petal_dia = mesh_object(f'{ROOM}.petal_diamond', *diamond_shape(1.0, 0.42, 0.05), 'glass', {'glass': 'tinted', 'look': 'petal'})
    jewel = mesh_object(f'{ROOM}.jewel', *jewel_shape(0.12), 'glass', {'glass': 'tinted', 'look': 'jewel'})
    n_inst = 0
    for k, (ds, n, r0, r1, shape) in enumerate(ROSETTES):
        s = s0 + ds
        src = petal_lens if shape == 'lens' else petal_dia
        L = r1 - r0
        tilt = math.radians(18 if k % 2 == 0 else -18)
        for i in range(n):
            ang = 2 * math.pi * (i + (0.5 if k % 2 else 0.0)) / n
            radial = R * math.cos(ang) + UP * math.sin(ang)
            tangent = R * math.cos(ang + math.pi / 2) + UP * math.sin(ang + math.pi / 2)
            center = rail.point(s) + radial * (r0 + L / 2)
            # 花びらの長さの向き = 放射、面は軸の向き（F）を少し傾ける
            zf = F * math.cos(tilt) + tangent * math.sin(tilt)
            yf = np.cross(zf, radial)
            m = frame_matrix(center, radial * L, yf * (0.9 + 0.2 * L / 1.5), zf, 1.0)
            linked_copy(src, f'{ROOM}.rosette_{k}_petal.{i:03d}', m, {'instance': f'rosette_{k}_petal', 'rosette': k, 'role': 'pattern_part', 'rosette_s': float(s)})
            n_inst += 1
        # 内側の玉の輪
        nj = n * (2 if n < 12 else 1)
        for i in range(nj):
            ang = 2 * math.pi * (i + 0.25) / nj
            radial = R * math.cos(ang) + UP * math.sin(ang)
            tangent = R * math.cos(ang + math.pi / 2) + UP * math.sin(ang + math.pi / 2)
            center = rail.point(s) + radial * (r0 + 0.02)
            m = frame_matrix(center, radial, tangent, -F, 0.9)
            linked_copy(jewel, f'{ROOM}.rosette_{k}_jewel.{i:03d}', m, {'instance': f'rosette_{k}_jewel', 'rosette': k, 'role': 'pattern_part', 'rosette_s': float(s)})
            n_inst += 1
    info['rosette_parts'] = n_inst

    # 6. 散らばるガラス片（見どころで花の模様に集まる。家の位置は筒の壁ぎわ、軸から 2.5〜3.9m）
    shard_src = {
        'shard_a': mesh_object(f'{ROOM}.shard_a', *lens_shape(0.42, 0.16, 0.035), 'glass', {'glass': 'tinted', 'look': 'shard'}),
        'shard_b': mesh_object(f'{ROOM}.shard_b', *diamond_shape(0.36, 0.2, 0.035), 'glass', {'glass': 'tinted', 'look': 'shard'}),
        'shard_c': mesh_object(f'{ROOM}.shard_c', *lens_shape(0.3, 0.22, 0.04, 8), 'glass', {'glass': 'tinted', 'look': 'shard'}),
    }
    rosette_s = [s0 + r[0] for r in ROSETTES]
    for key, count in SHARDS.items():
        placed = 0
        while placed < count:
            s = rng.uniform(s0 + 6.0, s1 - 18.0)
            if any(abs(s - rs) < 1.2 for rs in rosette_s):
                continue
            ang = rng.uniform(0, 2 * math.pi)
            rad = rng.uniform(2.55, 3.9)
            center = at(s, ang, rad)
            # 向きはばらばら
            axis = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
            m = Matrix.Translation(Vector(center)) @ Matrix.Rotation(rng.uniform(0, math.tau), 4, axis)
            linked_copy(shard_src[key], f'{ROOM}.{key}.{placed:03d}', m, {'instance': key})
            placed += 1
    # 触れられるガラス片（目の高さの近く、軸から 2.45〜2.9m）
    touch_src = mesh_object(f'{ROOM}.touchshard', *diamond_shape(0.46, 0.26, 0.05), 'glass', {'glass': 'tinted', 'look': 'touchshard'})
    for i in range(TOUCH_SHARDS):
        s = s0 + 8.0 + (s1 - s0 - 30.0) * (i + 0.5) / TOUCH_SHARDS
        ang = math.radians(rng.choice([rng.uniform(-35, 35), rng.uniform(145, 215), rng.uniform(40, 70), rng.uniform(110, 140)]))
        rad = rng.uniform(2.5, 2.9)
        center = at(s, ang, rad)
        axis = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
        m = Matrix.Translation(Vector(center)) @ Matrix.Rotation(rng.uniform(0, math.tau), 4, axis)
        o = bpy.data.objects.new(f'{ROOM}.touchshard.{i:03d}', touch_src.data.copy())
        COLL.objects.link(o)
        o.matrix_world = m
        for k in touch_src.keys():
            o[k] = touch_src[k]
        o['touch_kind'] = 'shard'
        o['touch_id'] = f'shard-{i:02d}'
        OBJECTS.append(o)
    # 複製の元は消す
    for o in (petal_lens, petal_dia, jewel, touch_src, *shard_src.values()):
        OBJECTS.remove(o)
        bpy.data.objects.remove(o)
    bpy.context.view_layer.update()
    return info


# ── 検査 ──────────────────────────────────────────────────────────────
def check_shell_clearance(rail: Rail, objs) -> dict:
    s0, s1 = rail.sections[ROOM]
    samples = [Vector(rail.point(s)) for s in np.arange(s0, s1 + 0.01, 0.25)]
    worst = {}
    bad = []
    for o in objs:
        if not o.get('clearance_exempt') or o.get('role') == 'membrane' or o.type != 'MESH' or len(o.data.polygons) == 0:
            continue
        mw = o.matrix_world
        verts = [mw @ v.co for v in o.data.vertices]
        tree = BVHTree.FromPolygons(verts, [tuple(p.vertices) for p in o.data.polygons])
        dmin = min(tree.find_nearest(p)[3] for p in samples)
        worst[o.name] = round(dmin, 3)
        if dmin < SHELL_CLEAR:
            bad.append((o.name, dmin))
    if bad:
        raise RuntimeError(f'殻がレールに近すぎます（{SHELL_CLEAR}m 未満）: {bad}')
    return {k: v for k, v in worst.items() if not k.startswith(f'{ROOM}.panel.')} | {'panels_min': min((v for k, v in worst.items() if k.startswith(f'{ROOM}.panel.')), default=None)}


def check_box_clearance(rail: Rail, objs) -> list:
    s0, s1 = rail.sections[ROOM]
    samples = np.array([rail.point(s) for s in np.arange(s0, s1 + 0.01, 0.5)])
    bad = []
    for o in objs:
        if o.get('clearance_exempt') or o.type != 'MESH' or len(o.data.vertices) == 0:
            continue
        mw = np.array(o.matrix_world)
        co = np.array([v.co for v in o.data.vertices])
        lo = co.min(axis=0)
        hi = co.max(axis=0)
        corners = np.array([[x, y, z, 1.0] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]) @ mw.T
        blo = corners[:, :3].min(axis=0)
        bhi = corners[:, :3].max(axis=0)
        d = np.linalg.norm(np.maximum(0, np.maximum(blo - samples, samples - bhi)), axis=1)
        if d.min() < CLEAR:
            bad.append((o.name, round(float(d.min()), 3)))
    return bad


def setup_world():
    w = bpy.data.worlds.new(f'{ROOM}.world')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.02, 0.02, 0.025, 1.0)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.3
    bpy.context.scene.world = w


def render_env(rail: Rail, path: str, size, samples: int, s_at: float):
    sc = bpy.context.scene
    cam = bpy.data.cameras.new(f'{ROOM}.envcam')
    cam.type = 'PANO'
    cam.panorama_type = 'EQUIRECTANGULAR'
    co = bpy.data.objects.new(f'{ROOM}.envcam', cam)
    sc.collection.objects.link(co)
    c = rail.point(s_at)
    co.location = tuple(map(float, c))
    co.rotation_euler = (math.pi / 2, 0.0, 0.0)
    sc.camera = co
    hidden = []
    for o in COLL.objects:
        if o.get('look') in ('membrane', 'touchshard', 'shard'):
            o.hide_render = True
            hidden.append(o)
    # 環境画像では鏡の板を本物の鏡にする（多重の映り込みを Cycles で撮る）
    mirror = bpy.data.materials.new(f'{ROOM}.mirror.env')
    mirror.use_nodes = True
    p = mirror.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (0.8, 0.8, 0.82, 1.0)
    p.inputs['Metallic'].default_value = 1.0
    p.inputs['Roughness'].default_value = 0.06
    keep = {}
    for o in COLL.objects:
        if o.get('look') == 'mirror':
            keep[o.name] = list(o.data.materials)
            o.data.materials.clear()
            o.data.materials.append(mirror)
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 10
    sc.cycles.glossy_bounces = 8
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_depth = '8'
    sc.render.image_settings.color_mode = 'RGB'
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = -2.6
    sc.render.filepath = path
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    sc.view_settings.exposure = 0.0
    for o in hidden:
        o.hide_render = False
    for o in COLL.objects:
        if o.name in keep:
            o.data.materials.clear()
            for m in keep[o.name]:
                o.data.materials.append(m)
    bpy.data.objects.remove(co)
    return round(time.time() - t0, 1)


def _glb_extensions(path: str) -> list:
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + n])
    return (j.get('extensionsUsed') or []) + (j.get('extensionsRequired') or [])



# ── ライトマップのざらつきを取る（焼いた後の後処理） ─────────────────────────────
def smooth_lightmap(path: str, sigma: float = 1.1) -> dict:
    """焼いたライトマップの細かなモンテカルロのざらつき（小さな灯りの光の粒）を取る。

    線形に直して、3×3 の中央値（1 テクセルの突起を消す）→ 島の中だけのガウスのぼかし（島の外の黒を混ぜない）をかけ、
    8bit の sRGB に戻して同じ場所に書く。σ は約 1 テクセル（2048px の部屋で数 cm。光と影の形はほぼ変わらない）。
    """
    from common.bake import _srgb_encode, png_info, write_png_rgb8

    img = bpy.data.images.load(path, check_existing=False)
    img.colorspace_settings.name = 'Non-Color'  # 画素の値をそのまま（sRGB の符号のまま）読む
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    enc = px.reshape(h, w, 4)[::-1, :, :3]
    lin = np.where(enc <= 0.04045, enc / 12.92, ((enc + 0.055) / 1.055) ** 2.4).astype(np.float32)
    mask = (enc.max(axis=2) > 0.5 / 255).astype(np.float32)

    def shifted(a, dy, dx):
        p = np.pad(a, ((1, 1), (1, 1)) + ((0, 0),) * (a.ndim - 2), mode='edge')
        return p[1 + dy:1 + dy + a.shape[0], 1 + dx:1 + dx + a.shape[1]]

    # 中央値（島の外の画素は自分の値で置き換えてから取る）。メモリを抑えるため色ごとに
    med = np.empty_like(lin)
    for ch in range(3):
        c = lin[:, :, ch]
        stack = np.stack([np.where(shifted(mask, dy, dx) > 0, shifted(c, dy, dx), c) for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
        med[:, :, ch] = np.median(stack, axis=0)
        del stack
    # 島の中だけのガウス（分けて 2 回の 1 次元）
    r = max(1, int(math.ceil(sigma * 2.5)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2).astype(np.float32)
    k /= k.sum()

    def blur(a):
        out = np.zeros_like(a)
        for i, kv in enumerate(k):
            out += kv * np.roll(a, i - r, axis=0)
        a2 = np.zeros_like(out)
        for i, kv in enumerate(k):
            a2 += kv * np.roll(out, i - r, axis=1)
        return a2

    num = blur(med * mask[..., None])
    den = blur(mask)[..., None]
    sm = np.where(den > 1e-4, num / np.maximum(den, 1e-4), med)
    sm = np.where(mask[..., None] > 0, sm, 0.0)
    grain = float(np.abs(lin - sm).mean())
    rgb = (np.rint(_srgb_encode(sm) * 255.0)).astype(np.uint8)
    write_png_rgb8(path, rgb)
    info = png_info(path)
    if info['depth'] != 8 or info['color_type'] != 2:
        raise RuntimeError(f'ライトマップが 8bit の RGB ではありません: {info}')
    return {'bytes': os.path.getsize(path), 'mean_change': round(grain, 5)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--rail', default=os.path.join(ROOT, 'public/assets/rail.json'))
    ap.add_argument('--out-dir', default=os.path.join(ROOT, 'public/assets/rooms'))
    ap.add_argument('--blend', default=os.path.join(ROOT, 'blender/scenes/kaleidoscope.blend'))
    ap.add_argument('--size', type=int, default=2048)
    ap.add_argument('--samples', type=int, default=256)
    ap.add_argument('--quick', action='store_true')
    ap.add_argument('--no-env', action='store_true')
    args = ap.parse_args(script_args())
    if args.quick:
        args.size, args.samples = 512, 16

    t_all = time.time()
    ride = json.load(open(args.rail))
    rail = Rail(ride)
    rng = random.Random(33)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    global COLL
    COLL = bpy.data.collections.new(ROOM)
    bpy.context.scene.collection.children.link(COLL)
    setup_world()

    info = build(rail, rng)
    objs = list(COLL.objects)
    bad_names = check_names(objs, [ROOM])
    if bad_names:
        raise RuntimeError(f'名前の規則に合わない: {bad_names}')
    shell = check_shell_clearance(rail, objs)
    box_bad = check_box_clearance(rail, objs)
    if box_bad:
        raise RuntimeError(f'ゴンドラに近すぎる物（箱で {CLEAR}m 未満）: {box_bad[:10]}')

    s0, s1 = rail.sections[ROOM]
    span = rail.span_points(max(0.0, s0 - CULL_MARGIN), s1 + CULL_MARGIN, 1.0)
    cull_objs = [o for o in objs if o.type == 'MESH' and not o.get('instance') and o.get('look') not in ('touchshard',)]
    rep = cull_hidden(cull_objs, span, yaw_deg=120, pitch_deg=60, head_radius=0.5)
    print(f"cull: {rep['before_tris']} -> {rep['after_tris']} 三角形（{rep['removed_faces']} 面を削除、{rep['rays']} 本、{rep['seconds']}s）")

    baked = [o for o in objs if o.get('bake_group') and len(o.data.polygons) > 0]
    t_b = time.time()
    res = bake_lightmaps(baked, args.out_dir, size=args.size, samples=args.samples, name=f'{ROOM}.lightmap', percentile=99.95)
    bake_sec = round(time.time() - t_b, 1)
    smooth = smooth_lightmap(os.path.join(args.out_dir, f'{ROOM}.lightmap.png')) if res else None
    print(f'smooth: {smooth}')

    # 同じ組をまとめる（板は 6 面ごと…ではなく 1 つ。描く物を減らす）
    by_group: dict = {}
    for o in baked:
        by_group.setdefault(o['bake_group'], []).append(o.name)
    joined = {}
    for group, names in sorted(by_group.items()):
        members = [bpy.data.objects[n] for n in names]
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        for o in members:
            o.select_set(True)
        bpy.context.view_layer.objects.active = members[0]
        if len(members) > 1:
            bpy.ops.object.join()
        o = bpy.context.view_layer.objects.active
        o.name = f'{ROOM}.{group}'
        o.data.name = o.name
        joined[group] = o.name
    objs = list(COLL.objects)

    env_sec = None
    if not args.no_env:
        env_sec = render_env(rail, os.path.join(args.out_dir, f'{ROOM}.env.png'), (512, 256) if args.quick else (1024, 512), 8 if args.quick else 64, (s0 + s1) / 2 - 5)

    MATS.use('export', objs)
    glb = os.path.join(args.out_dir, f'{ROOM}.glb')
    size = export_glb(objs, glb, rooms=[ROOM])
    load = room_load_report(objs, glb, args.out_dir)
    ext = _glb_extensions(glb)
    if ext:
        raise RuntimeError(f'glb に拡張が入りました: {ext}')
    MATS.use('bake', objs)
    os.makedirs(os.path.dirname(args.blend), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend), compress=True)
    summary = {
        'room': ROOM,
        'objects': len(objs),
        'cull': {k: rep[k] for k in ('before_tris', 'after_tris', 'removed_faces', 'seconds')},
        'bake': {'size': args.size, 'samples': args.samples, 'seconds': bake_sec, 'scale': res[0]['scale'] if res else None, 'max_over_scale': res[0]['max_over_scale'] if res else None, 'clipped': res[0]['clipped_frac'] if res else None},
        'env_seconds': env_sec,
        'glb_bytes': size,
        'load': load,
        'shell_clearance': shell,
        'joined': joined,
        'info': info,
        'total_seconds': round(time.time() - t_all, 1),
    }
    print('SUMMARY ' + json.dumps(summary, ensure_ascii=False, default=str))


if __name__ == '__main__':
    main()
