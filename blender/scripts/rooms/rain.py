"""第2室「雨の回廊」（3:30〜6:00）の造形 → 見えない面の削除 → 焼き込み → glb（BLD-4〜7）。

    pnpm blender blender/scripts/rooms/rain.py [-- --samples 512 --size 2048 --quick --no-env]

出力: public/assets/rooms/rain.glb・rain.lightmap.png（焼いた光。焼いた後にざらつきを取る）・rain.env.png（中庭から撮った正距円筒の環境画像。
濡れた床・水面・真鍮の映り込みと、止まった雨粒の簡易な屈折に使う）、blender/scenes/rain.blend。

絵コンテ（入口で視界が開ける一枚絵）:
  温室の広さから一転して、低いガラスの穹窿（ヴォールト）の回廊がゆるく右へ曲がりながら灰青の霧の奥へ続く。
  左右に雫形のガラスの柱が並び、雫の中に琥珀の灯りがともる。濡れた石の床と中央の水路に灯りがにじんで映り、
  左（曲がりの外側）の水の膜の壁の向こうに街の灯りがにじむ。曲がった先は見えず、奥へ誘われる。
見どころ（5:10）: 回廊の中ほどの、屋根のない楕円の中庭。降る雨が一粒ずつガラス玉に変わって空中で止まる。
  ゴンドラは細いガラスの庇（ひさし）の下を、止まった雨粒の間をすり抜けて進む（庇の下には雨が落ちない）。
分岐（5:50）: 回廊の突き当たりの円い膜の左右に、琥珀（左）と瑠璃（右）の扉が床から立ち上がる。

作る物（名前は `rain.<部品>[.<番号>]`。カスタムプロパティは glb の extras → three の userData）:
  焼き込む物（不透明・メッシュを共有しない）: floor・plinth・court_plinth・endwall
  ガラス（glass。焼き込まない。光線は通す）: wall_glass・roof_glass・canopy・column_a/b/c・door_amber/lapis・membrane
  真鍮（brass。金属なので焼き込まない）: roof_ribs・mullions・column_fit_*・canopy_ribs・doorframe_*・portal_ring
  発光（emissive。焼き込みの光源）: lamp（柱の雫の中の灯り）・city_lights（街の灯り）・doorlight_*（扉の奥の光）
  遠景: city（建物の影。TS が霧に溶ける暗い材質にする）、水面: pool・channel（TS が水の材質にする）
  柱・灯り・金具はリンク複製（メッシュを共有）で置き、TS がインスタンス描画にまとめる。

物との距離（RIDE-8、ゴンドラの半径 1.2m ＋ 0.5m = レールの中心から 1.7m）:
  ・床の上面は z=0（レールは 1.9m）、屋根と庇の下面は z≥3.68 なので、箱で測っても 1.7m を超える。
  ・壁・腰壁・突き当たりの壁・膜の輪は回廊の殻（連続した形）で、軸に沿った箱では測れない。clearance_exempt にし、
    代わりにここで本当の形とレールの最短距離（BVH）を測って 1.7m＋余裕 以上を確かめる（下回ったら止める）。
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
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from common.bake import bake_lightmaps  # noqa: E402
from common.cli import script_args  # noqa: E402
from common.coords import blender_to_three, three_to_blender  # noqa: E402
from common.export import export_glb, room_load_report  # noqa: E402
from common.naming import check_names  # noqa: E402
from common.visibility import cull_hidden  # noqa: E402

warnings.filterwarnings('ignore', category=DeprecationWarning)

ROOM = 'rain'
#: 区間のレール上の範囲（rail.json の sections から読む）。見えない面の判定は前後に余裕を足す
CULL_MARGIN = 30.0
#: ゴンドラの半径 ＋ 物との最短距離（config.ts の GONDOLA_DIAMETER / 2 + MOTION.clearanceMin）
CLEAR = 1.2 + 0.5
#: 殻（clearance_exempt）に求める本当の距離（余裕を 0.1m 足す）
SHELL_CLEAR = CLEAR + 0.1

# ── 回廊の寸法（m。Blender の座標、z が上。床は z=0） ──
HALF_W = 3.4  # ガラスの壁の位置（レールの中心から左右）
PLINTH_IN = 3.22  # 腰壁の内側の面
PLINTH_H = 0.55  # 腰壁の高さ
SPRING_Z = 3.75  # 穹窿の起点の高さ
CROWN_Z = 4.55  # 穹窿の頂の高さ
COLUMN_U = 2.6  # 柱の軸（左右）
COLUMN_STEP = 4.5  # 柱の間隔（レールに沿って）
CHANNEL_HALF = 0.42  # 中央の水路の半幅
CHANNEL_DEPTH = 0.07
# 中庭（楕円）。中心はレールの s=COURT_S、長軸はその点の進行方向
COURT_S = 302.0
COURT_A = 12.5
COURT_B = 7.0
CANOPY_HALF = 1.95  # 庇の半幅（この内側には雨を降らせない）
CANOPY_Z0 = 3.70  # 庇の縁の下面
CANOPY_Z1 = 3.92  # 庇の中央
# 突き当たり
END_S_OFFSET = 0.5  # 区間の終わりからの壁の位置（膜はこの手前）
PORTAL_R = 1.86  # 膜の輪の半径（輪の太さ 0.05 → 内側 1.81m）
DOOR_U = 2.72  # 扉の中心（左右）
DOOR_HALF = 0.42  # 扉の半幅
DOOR_Z0 = 0.16
DOOR_Z1 = 3.05
FACADE_R = 5.3  # 突き当たりの壁（万華鏡の館の六角の正面）の角までの半径。万華鏡の筒（5.0、端の壁 5.1）より大きい


# ── レール ──────────────────────────────────────────────────────────
class Rail:
    """rail.json の点列（three の座標）を Blender の座標にして、s（m）での位置と水平な向きを返す"""

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
        """位置 c、前 f（水平の単位ベクトル）、右 r（水平）"""
        c = self.point(s)
        d = self.point(s + 1.0) - self.point(s - 1.0)
        d[2] = 0.0
        f = d / max(1e-9, np.linalg.norm(d))
        r = np.array([f[1], -f[0], 0.0])
        return c, f, r

    def span_points(self, s0: float, s1: float, step: float = 1.0) -> list[tuple[float, float, float]]:
        out = []
        s = s0
        while s <= s1 + 1e-9:
            out.append(tuple(self.point(s)))
            s += step
        return out

    def local(self, p: np.ndarray, s_hint: float, window: float = 40.0):
        """点 p の最寄りのレールの s と、横（右が正）・前の成分（水平）"""
        best = (1e18, s_hint)
        for s in np.arange(max(0.0, s_hint - window), s_hint + window, 0.5):
            c = self.point(s)
            d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2
            if d < best[0]:
                best = (d, s)
        s = best[1]
        # 0.05m まで詰める
        for step in (0.25, 0.1, 0.05):
            for cand in (s - step, s + step):
                c = self.point(cand)
                d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2
                if d < best[0]:
                    best = (d, cand)
            s = best[1]
        c, f, r = self.frame(s)
        v = p - c
        return s, float(v[0] * r[0] + v[1] * r[1]), float(v[0] * f[0] + v[1] * f[1])


# ── 材質（焼き込み用と書き出し用） ────────────────────────────────────
class Mats:
    """焼き込みのときの材質（発光の強さ・ガラスの透け）と、書き出す材質（glTF の基本だけ。拡張を使わない）を対で持つ"""

    def __init__(self):
        self.bake: dict[str, bpy.types.Material] = {}
        self.export: dict[str, bpy.types.Material] = {}

    def add(self, key: str, color, rough=0.5, metal=0.0, alpha=1.0, emit=None, emit_strength=0.0, export_color=None):
        bm = bpy.data.materials.new(f'{ROOM}.{key}.bake')
        bm.use_nodes = True
        p = bm.node_tree.nodes.get('Principled BSDF')
        p.inputs['Base Color'].default_value = (*color, 1.0)
        p.inputs['Roughness'].default_value = rough
        p.inputs['Metallic'].default_value = metal
        p.inputs['Alpha'].default_value = alpha
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
            q.inputs['Emission Strength'].default_value = 1.0  # 1 を超えると KHR_materials_emissive_strength が付く
        self.bake[key] = bm
        self.export[key] = em
        return bm

    def use(self, which: str, objs):
        table = self.bake if which == 'bake' else self.export
        for o in objs:
            key = o.get('mat_key')
            if key and o.type == 'MESH':
                o.data.materials.clear()
                o.data.materials.append(table[key])


MATS = Mats()


# ── 形の道具 ─────────────────────────────────────────────────────────
COLL: bpy.types.Collection | None = None
OBJECTS: list = []


def mesh_object(name: str, verts, faces, mat_key: str, props: dict | None = None, smooth=True, sharp_angle_deg: float | None = 50.0, uvs=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], [tuple(int(i) for i in f) for f in faces])
    me.validate(clean_customdata=False)
    me.update()
    if uvs is not None:
        # 頂点ごとの UV（m 単位: レールに沿った長さ、断面に沿った長さ）。glb の TEXCOORD_0。TS の筋・目地に使う
        layer = me.uv_layers.new(name='UVMap')
        for li, loop in enumerate(me.loops):
            layer.data[li].uv = uvs[loop.vertex_index]
    obj = bpy.data.objects.new(name, me)
    COLL.objects.link(obj)
    obj['mat_key'] = mat_key
    me.materials.append(MATS.bake[mat_key])
    if smooth:
        me.shade_smooth()
        if sharp_angle_deg is not None:
            _mark_sharp(me, sharp_angle_deg)
    for k, v in (props or {}).items():
        obj[k] = v
    OBJECTS.append(obj)
    return obj


def _mark_sharp(me, angle_deg: float):
    """面の間の角度が大きい辺を鋭い辺にする（丸い所はなめらか、折れた所だけ折る）"""
    bm = bmesh.new()
    bm.from_mesh(me)
    lim = math.radians(angle_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim:
            e.smooth = False
    bm.to_mesh(me)
    bm.free()


def linked_copy(src, name: str, loc, rot_z: float = 0.0, props: dict | None = None):
    obj = bpy.data.objects.new(name, src.data)
    COLL.objects.link(obj)
    obj.location = tuple(map(float, loc))
    obj.rotation_euler = (0.0, 0.0, rot_z)
    for k in src.keys():
        if k not in ('lightmap', 'lightmap_scale'):
            obj[k] = src[k]
    for k, v in (props or {}).items():
        obj[k] = v
    OBJECTS.append(obj)
    return obj


def arc(c, r0, a0, a1, n):
    """(u, z) の円弧の点（c を中心、半径 r0、角度 a0→a1）"""
    return [(c[0] + r0 * math.cos(a0 + (a1 - a0) * i / n), c[1] + r0 * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def sweep_uv(prof, s0: float, s1: float, ds: float = 1.0):
    """sweep と同じ並びの UV（u = レールの s（m）、v = 断面に沿った長さ（m））"""
    n = max(1, int(math.ceil((s1 - s0) / ds)))
    ss = [s0 + (s1 - s0) * i / n for i in range(n + 1)]
    acc = [0.0]
    for a, b in zip(prof[:-1], prof[1:]):
        acc.append(acc[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return [(s, acc[k]) for s in ss for k in range(len(prof))]


def sweep(rail: Rail, prof, s0: float, s1: float, ds: float = 1.0, close_profile=False):
    """断面 prof（(u, z) の列。u は右が正、z は絶対の高さ）をレールに沿って s0→s1 へ掃く。

    面の向き: 断面を進む向きを (u, z) 平面で左へ 90° 回した向き（例: u が増える向きに進む断面は上を向く）。
    """
    n = max(1, int(math.ceil((s1 - s0) / ds)))
    ss = [s0 + (s1 - s0) * i / n for i in range(n + 1)]
    verts = []
    for s in ss:
        c, f, r = rail.frame(s)
        for u, z in prof:
            verts.append((c[0] + r[0] * u, c[1] + r[1] * u, z))
    m = len(prof)
    faces = []
    kmax = m if close_profile else m - 1
    for i in range(n):
        for k in range(kmax):
            k2 = (k + 1) % m
            faces.append((i * m + k, i * m + k2, (i + 1) * m + k2, (i + 1) * m + k))
    return verts, faces


def lathe(prof, seg: int = 24):
    """(半径, z) の断面を z 軸の周りに回す。半径 0 の点は極にまとめる。法線は外向き（断面は下から上へ）"""
    verts = []
    index = []
    for rr, z in prof:
        if rr < 1e-6:
            index.append([len(verts)] * seg)
            verts.append((0.0, 0.0, z))
        else:
            row = []
            for j in range(seg):
                a = 2 * math.pi * j / seg
                row.append(len(verts))
                verts.append((rr * math.cos(a), rr * math.sin(a), z))
            index.append(row)
    faces = []
    for i in range(len(prof) - 1):
        for j in range(seg):
            j2 = (j + 1) % seg
            a, b, c, d = index[i][j], index[i][j2], index[i + 1][j2], index[i + 1][j]
            quad = [a, b, c, d]
            uniq = []
            for q in quad:
                if q not in uniq:
                    uniq.append(q)
            if len(uniq) >= 3:
                faces.append(tuple(uniq))
    return verts, faces


def torus_points(center, axis_u, axis_v, R, r, n_major=48, n_minor=10):
    """中心 center、輪の平面の軸 axis_u・axis_v、半径 R、太さ r の輪"""
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


def tube_along(points, radius: float, n_minor: int = 8):
    """点列に沿った細い管（真鍮の枠）。端は閉じない（短い枠の端は見えにくい）"""
    pts = [np.asarray(p, dtype=np.float64) for p in points]
    verts = []
    for i, p in enumerate(pts):
        t = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        t = t / max(1e-9, np.linalg.norm(t))
        a = np.array([0.0, 0.0, 1.0]) if abs(t[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
        u = np.cross(t, a)
        u /= np.linalg.norm(u)
        v = np.cross(t, u)
        for j in range(n_minor):
            b = 2 * math.pi * j / n_minor
            verts.append(p + (u * math.cos(b) + v * math.sin(b)) * radius)
    faces = []
    for i in range(len(pts) - 1):
        for j in range(n_minor):
            j2 = (j + 1) % n_minor
            faces.append((i * n_minor + j, i * n_minor + j2, (i + 1) * n_minor + j2, (i + 1) * n_minor + j))
    return verts, faces


def rail_kd(rail: 'Rail', s0: float, s1: float, step: float = 0.25) -> KDTree:
    ss = np.arange(s0, s1 + 1e-6, step)
    kd = KDTree(len(ss))
    for i, s in enumerate(ss):
        kd.insert(Vector(rail.point(float(s))), i)
    kd.balance()
    return kd


def recalc_closed(obj) -> None:
    """閉じた形（箱・扉の葉・厚みのある壁）の面を外へ向ける"""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def face_toward(obj, kd: KDTree | None = None, direction=None) -> int:
    """片面の板・殻の面の表を、最寄りのレールの点（kd）か、決まった向き direction へ向ける。裏返した面の数"""
    me = obj.data
    mw = obj.matrix_world
    rot = mw.to_3x3()
    bm = bmesh.new()
    bm.from_mesh(me)
    n_flip = 0
    for fa in bm.faces:
        c = mw @ fa.calc_center_median()
        nrm = rot @ fa.normal
        if direction is not None:
            want = Vector(direction)
        else:
            co, _i, _d = kd.find(c)
            want = co - c
        if nrm.dot(want) < 0:
            fa.normal_flip()
            n_flip += 1
    bm.to_mesh(me)
    bm.free()
    me.update()
    return n_flip


class Builder:
    """複数の部品を1つのメッシュにまとめる"""

    def __init__(self):
        self.v: list = []
        self.f: list = []

    def add(self, verts, faces):
        o = len(self.v)
        self.v.extend(verts)
        self.f.extend(tuple(i + o for i in face) for face in faces)


# ── 中庭の楕円 ─────────────────────────────────────────────────────────
class Court:
    def __init__(self, rail: Rail):
        self.c, self.f, self.r = rail.frame(COURT_S)

    def inside(self, p, pad: float = 0.0) -> bool:
        v = np.asarray(p[:2]) - self.c[:2]
        x = v[0] * self.f[0] + v[1] * self.f[1]
        y = v[0] * self.r[0] + v[1] * self.r[1]
        return (x / (COURT_A + pad)) ** 2 + (y / (COURT_B + pad)) ** 2 < 1.0

    def point(self, th: float, scale: float = 1.0):
        return self.c[:2] + self.f[:2] * (COURT_A * scale * math.cos(th)) + self.r[:2] * (COURT_B * scale * math.sin(th))


def wall_cut(rail: Rail, court: Court, side: float, s0: float, s1: float):
    """壁の線（横 side×HALF_W）が楕円に入る区間 [a, b]（s）。壁はこの外にだけある"""
    inside = []
    s = s0
    while s <= s1:
        c, f, r = rail.frame(s)
        p = c + r * (side * HALF_W)
        if court.inside(p):
            inside.append(s)
        s += 0.05
    return (min(inside), max(inside)) if inside else None


# ── 造形 ──────────────────────────────────────────────────────────────
def build(rail: Rail, rng: random.Random) -> dict:
    s0, s1 = rail.sections[ROOM]
    end_s = s1 + END_S_OFFSET
    start_s = s0 - 0.5
    court = Court(rail)
    cutL = wall_cut(rail, court, -1, start_s, end_s)
    cutR = wall_cut(rail, court, 1, start_s, end_s)
    vault_in = min(cutL[0], cutR[0])
    vault_out = max(cutL[1], cutR[1])
    floor_in = max(cutL[0], cutR[0]) + 1.0
    floor_out = min(cutL[1], cutR[1]) - 1.0
    info = {'court_cut_left': cutL, 'court_cut_right': cutR, 'vault': [vault_in, vault_out]}
    kd = rail_kd(rail, start_s - 5, end_s + 5)

    # 材質（色は線形。焼き込みは光だけなので、色は TS の材質の色として書き出す）
    MATS.add('stone', (0.075, 0.085, 0.10), rough=0.32)  # 濡れた灰青の石の床
    MATS.add('plinth', (0.16, 0.17, 0.19), rough=0.45)  # 腰壁の石
    MATS.add('endwall', (0.30, 0.32, 0.36), rough=0.6)  # 突き当たりの曇りの壁（乳白の石）
    MATS.add('glass', (0.8, 0.86, 0.92), rough=0.05, alpha=0.32)
    MATS.add('glass_roof', (0.8, 0.86, 0.92), rough=0.12, alpha=0.45)
    MATS.add('column', (0.85, 0.9, 0.95), rough=0.05, alpha=0.25)
    MATS.add('brass', (0.62, 0.45, 0.22), rough=0.35, metal=1.0)
    MATS.add('lamp', (0.0, 0.0, 0.0), emit=(1.0, 0.58, 0.24), emit_strength=85.0, export_color=(1.0, 0.6, 0.28))
    MATS.add('citylight', (0.0, 0.0, 0.0), emit=(1.0, 0.66, 0.36), emit_strength=6.0, export_color=(1.0, 0.7, 0.4))
    MATS.add('city', (0.05, 0.06, 0.075), rough=0.8)
    MATS.add('water', (0.02, 0.025, 0.03), rough=0.05)
    MATS.add('door_amber', (1.0, 0.62, 0.25), rough=0.05, alpha=0.5)
    MATS.add('door_lapis', (0.2, 0.36, 0.9), rough=0.05, alpha=0.5)
    MATS.add('doorlight_amber', (0.0, 0.0, 0.0), emit=(1.0, 0.6, 0.25), emit_strength=0.0, export_color=(1.0, 0.6, 0.25))
    MATS.add('doorlight_lapis', (0.0, 0.0, 0.0), emit=(0.25, 0.45, 1.0), emit_strength=0.0, export_color=(0.25, 0.45, 1.0))
    MATS.add('membrane', (0.9, 0.95, 1.0), rough=0.05, alpha=0.1)

    # 1. 床: 中央の水路（なめらかな溝）と、壁ぎわへわずかに上がる床。区間を 6 つほどに分けて作り、焼いた後に 1 つにまとめる
    ch = CHANNEL_HALF
    floor_prof = [(-HALF_W - 0.1, 0.02), (-PLINTH_IN - 0.05, 0.0), (-1.4, 0.0)]
    floor_prof += [(-ch - 0.12, 0.0), (-ch, -0.012)]
    floor_prof += [(u, -0.012 - (CHANNEL_DEPTH - 0.012) * math.sqrt(max(0.0, 1 - (u / ch) ** 2))) for u in np.linspace(-ch, ch, 11)[1:-1]]
    floor_prof += [(ch, -0.012), (ch + 0.12, 0.0)]
    floor_prof += [(1.4, 0.0), (PLINTH_IN + 0.05, 0.0), (HALF_W + 0.1, 0.02)]
    floor_parts = []
    for a, b in ((start_s, floor_in),):
        n = max(1, round((b - a) / 16))
        for i in range(n):
            sa = a + (b - a) * i / n
            sb = a + (b - a) * (i + 1) / n
            v, f = sweep(rail, floor_prof, sa, sb, 1.0)
            floor_parts.append(mesh_object(f'{ROOM}.floor.{len(floor_parts):03d}', v, f, 'stone', {'bake_group': 'floor'}, sharp_angle_deg=35, uvs=sweep_uv(floor_prof, sa, sb, 1.0)))
    v, f = sweep(rail, floor_prof, floor_out, end_s + 0.3, 1.0)
    floor_parts.append(mesh_object(f'{ROOM}.floor.{len(floor_parts):03d}', v, f, 'stone', {'bake_group': 'floor'}, sharp_angle_deg=35, uvs=sweep_uv(floor_prof, floor_out, end_s + 0.3, 1.0)))

    # 水路の水面（水の材質は TS。z は床より少し下）
    chp = [(-ch + 0.01, -0.03), (ch - 0.01, -0.03)]
    v, f = sweep(rail, chp, start_s, floor_in, 1.0)
    vb, fb = sweep(rail, chp, floor_out, end_s, 1.0)
    bw = Builder()
    bw.add(v, f)
    bw.add(vb, fb)
    uv_ch = sweep_uv(chp, start_s, floor_in, 1.0) + sweep_uv(chp, floor_out, end_s, 1.0)
    face_toward(mesh_object(f'{ROOM}.channel', bw.v, bw.f, 'water', {'role': 'water', 'look': 'water'}, uvs=uv_ch), direction=(0, 0, 1))

    # 2. 腰壁（左右）。上は丸く（角を作らない）。中庭では切る
    pl_prof_r = [(PLINTH_IN, 0.0), (PLINTH_IN, PLINTH_H - 0.12)] + arc((PLINTH_IN + 0.12, PLINTH_H - 0.12), 0.12, math.pi, math.pi / 2, 4)[1:] + [(HALF_W + 0.3, PLINTH_H), (HALF_W + 0.3, 0.0)]
    # 断面を進む向きの左が面の表。右の腰壁は内側の面を上へ進むので左（レールの側）を向く。左は鏡に映して逆にたどる
    pl_prof_l = list(reversed([(-u, z) for u, z in pl_prof_r]))
    plinths = []
    for side, prof, cut in ((-1, pl_prof_l, cutL), (1, pl_prof_r, cutR)):
        for a, b in ((start_s, cut[0] + 0.4), (cut[1] - 0.4, end_s)):
            n = max(1, round((b - a) / 22))
            for i in range(n):
                sa = a + (b - a) * i / n
                sb = a + (b - a) * (i + 1) / n
                v, f = sweep(rail, prof, sa, sb, 1.0)
                plinths.append(mesh_object(f'{ROOM}.plinth.{len(plinths):03d}', v, f, 'plinth', {'bake_group': 'plinth', 'clearance_exempt': True, 'shell': True}, sharp_angle_deg=40))
                face_toward(plinths[-1], kd)

    # 3. ガラスの壁（腰壁の上〜穹窿の起点）。柱の間でわずかに外へふくらむ
    gw = Builder()
    gw_uv = []
    for side, cut in ((-1, cutL), (1, cutR)):
        for a, b in ((start_s, cut[0] + 0.25), (cut[1] - 0.25, end_s)):
            prof = [(side * HALF_W, PLINTH_H - 0.02), (side * HALF_W, SPRING_Z + 0.02)]
            if side < 0:
                prof = list(reversed(prof))  # 面をレールの側へ
            v, f = sweep(rail, prof, a, b, 0.5)
            # 柱の間でふくらませる（外へ最大 6cm）
            for k in range(0, len(v), 2):
                s_here = a + (b - a) * (k // 2) / max(1, (len(v) // 2) - 1)
                bulge = 0.06 * math.sin(math.pi * (((s_here - s0) / COLUMN_STEP) % 1.0))
                c, fw, r = rail.frame(s_here)
                for kk in (k, k + 1):
                    x, y, z = v[kk]
                    t = (z - PLINTH_H) / (SPRING_Z - PLINTH_H)
                    amt = bulge * math.sin(math.pi * min(1.0, max(0.0, t)))
                    v[kk] = (x + r[0] * side * amt, y + r[1] * side * amt, z)
            gw.add(v, f)
            # v は上ほど小さく（筋は v が増える向きに流れる = 下へ）
            gw_uv += [(uu, SPRING_Z + 0.02 - zz) for (uu, _), (_x, _y, zz) in zip(sweep_uv(prof, a, b, 0.5), v)]
    face_toward(mesh_object(f'{ROOM}.wall_glass', gw.v, gw.f, 'glass', {'glass': 'clear', 'look': 'wallglass', 'clearance_exempt': True, 'shell': True}, uvs=gw_uv), kd)

    # 4. 穹窿の屋根（ガラス）。中庭の上は開ける
    R = (HALF_W ** 2 + (CROWN_Z - SPRING_Z) ** 2) / (2 * (CROWN_Z - SPRING_Z))
    cz = CROWN_Z - R
    a0 = math.atan2(SPRING_Z - cz, HALF_W)
    roof_prof = arc((0.0, cz), R, math.pi - a0, a0, 16)  # 左（u 負）から右へ。面は下（内側）を向くよう後で反転
    roof_prof = list(reversed(roof_prof))
    rb = Builder()
    rb_uv = []
    half_len = R * (math.pi - 2 * a0) / 2
    for a, b in ((start_s, vault_in), (vault_out, end_s)):
        v, f = sweep(rail, roof_prof, a, b, 1.0)
        rb.add(v, f)
        rb_uv += [(uu, abs(vv - half_len)) for uu, vv in sweep_uv(roof_prof, a, b, 1.0)]  # v = 頂からの長さ（水は頂から左右へ流れる）
    face_toward(mesh_object(f'{ROOM}.roof_glass', rb.v, rb.f, 'glass_roof', {'glass': 'clear', 'look': 'roofglass'}, uvs=rb_uv), kd)

    def vault_z(u: float) -> float:
        return cz + math.sqrt(max(0.0, R * R - u * u))

    # 5. 柱（雫形、3種）と金具。リンク複製で並べる
    colA = lathe([(0.0, 0.0), (0.16, 0.0), (0.16, 0.05), (0.07, 0.12), (0.06, 0.3), (0.13, 0.55), (0.22, 0.8), (0.26, 0.98), (0.25, 1.12), (0.2, 1.3), (0.12, 1.55), (0.065, 1.9), (0.05, 2.6), (0.05, 3.6), (0.06, 3.9), (0.0, 4.1)], 24)
    colB = lathe([(0.0, 0.0), (0.16, 0.0), (0.16, 0.05), (0.06, 0.12), (0.05, 1.0), (0.05, 1.9), (0.09, 2.15), (0.17, 2.45), (0.24, 2.75), (0.25, 2.92), (0.21, 3.12), (0.13, 3.32), (0.07, 3.6), (0.06, 3.9), (0.0, 4.1)], 24)
    colC = lathe([(0.0, 0.0), (0.16, 0.0), (0.16, 0.05), (0.06, 0.12), (0.12, 0.35), (0.17, 0.55), (0.16, 0.72), (0.08, 0.95), (0.05, 1.4), (0.1, 1.75), (0.18, 2.05), (0.19, 2.25), (0.13, 2.5), (0.06, 2.9), (0.05, 3.6), (0.06, 3.9), (0.0, 4.1)], 24)
    src = {
        'a': mesh_object(f'{ROOM}.column_a', *colA, 'column', {'glass': 'frosted', 'look': 'column', 'instance': 'column_a'}),
        'b': mesh_object(f'{ROOM}.column_b', *colB, 'column', {'glass': 'frosted', 'look': 'column', 'instance': 'column_b'}),
        'c': mesh_object(f'{ROOM}.column_c', *colC, 'column', {'glass': 'frosted', 'look': 'column', 'instance': 'column_c'}),
    }
    # 金具: 足の輪と柱頭の輪（真鍮）
    fit = Builder()
    fit.add(*torus_points((0, 0, 0.08), (1, 0, 0), (0, 1, 0), 0.15, 0.035, 24, 8))
    fit.add(*torus_points((0, 0, 3.72), (1, 0, 0), (0, 1, 0), 0.075, 0.03, 24, 8))
    fit.add(*torus_points((0, 0, 3.86), (1, 0, 0), (0, 1, 0), 0.085, 0.025, 24, 8))
    fit_src = mesh_object(f'{ROOM}.column_fit', fit.v, fit.f, 'brass', {'look': 'brass', 'instance': 'column_fit'})
    # 灯り（雫の中の琥珀の玉）。A は低い雫、B は高い雫の中
    lamp_src = mesh_object(f'{ROOM}.lamp', *lathe([(0.0, -0.085)] + [(0.085 * math.sin(math.pi * i / 8), -0.085 * math.cos(math.pi * i / 8)) for i in range(1, 8)] + [(0.0, 0.085)], 16), 'lamp', {'look': 'lamp', 'instance': 'lamp'})
    lamp_z = {'a': 0.98, 'b': 2.86, 'c': None}
    # 突き当たりの扉の上の灯り（扉の枠と壁を照らす）
    ce0, fe0, re0 = rail.frame(s1 + END_S_OFFSET)
    for side in (-1, 1):
        p = ce0 + re0 * (side * DOOR_U) - fe0 * 0.28
        linked_copy(lamp_src, f'{ROOM}.lamp.{900 + (side > 0):03d}', (p[0], p[1], DOOR_Z1 + 0.32), 0.0)
    order = ['a', 'b', 'c']
    columns = []
    k = 0
    s = s0 + 3.0
    while s < s1 - 1.5:
        c, f, r = rail.frame(s)
        for side in (-1, 1):
            kind = order[(k + (1 if side > 0 else 0)) % 3]
            base = (c[0] + r[0] * side * COLUMN_U, c[1] + r[1] * side * COLUMN_U, 0.0)
            in_court = court.inside(base)
            col = linked_copy(src[kind], f'{ROOM}.column_{kind}.{len(columns):03d}', base, rng.uniform(0, math.tau))
            columns.append(col)
            linked_copy(fit_src, f'{ROOM}.column_fit.{len(columns):03d}', base, 0.0)
            if lamp_z[kind] is not None:
                linked_copy(lamp_src, f'{ROOM}.lamp.{len(columns):03d}', (base[0], base[1], lamp_z[kind]), 0.0)
            if in_court:
                col['in_court'] = True
        k += 1
        s += COLUMN_STEP
    info['columns'] = len(columns)
    # 複製の元は消す（メッシュは複製が持つ）
    for o in (*src.values(), fit_src, lamp_src):
        OBJECTS.remove(o)
        bpy.data.objects.remove(o)
    bpy.context.view_layer.update()

    # 6. 穹窿の真鍮の肋骨（柱ごとの弧）と、壁の縦の桟（壁は殻なので exempt）
    ribs = Builder()
    s = s0 + 3.0
    while s < s1 - 1.0:
        if not (vault_in - 0.2 < s < vault_out + 0.2):
            c, f, r = rail.frame(s)
            pts = []
            for i in range(25):
                u = -HALF_W + 2 * HALF_W * i / 24
                pts.append((c[0] + r[0] * u, c[1] + r[1] * u, vault_z(u) - 0.035))
            ribs.add(*tube_along(pts, 0.03, 8))
            # 柱頭から壁の上への腕（上へ反る）
            for side in (-1, 1):
                arm = []
                for i in range(9):
                    t = i / 8
                    u = side * (COLUMN_U + (HALF_W - COLUMN_U) * t)
                    z = 3.86 + (vault_z(u) - 0.05 - 3.86) * math.sin(t * math.pi / 2)
                    arm.append((c[0] + r[0] * u, c[1] + r[1] * u, max(z, 3.8)))
                ribs.add(*tube_along(arm, 0.022, 6))
        s += COLUMN_STEP
    # 穹窿の端（中庭への口）の弧
    for se in (vault_in, vault_out):
        c, f, r = rail.frame(se)
        pts = [(c[0] + r[0] * u, c[1] + r[1] * u, vault_z(u) - 0.04) for u in np.linspace(-HALF_W, HALF_W, 33)]
        ribs.add(*tube_along(pts, 0.045, 8))
    mesh_object(f'{ROOM}.roof_ribs', ribs.v, ribs.f, 'brass', {'look': 'brass'})

    mull = Builder()
    for side, cut in ((-1, cutL), (1, cutR)):
        s = s0 + 3.0 + COLUMN_STEP / 2
        while s < s1:
            if not (cut[0] - 0.3 < s < cut[1] + 0.3):
                c, f, r = rail.frame(s)
                u = side * (HALF_W - 0.02)
                pts = [(c[0] + r[0] * u, c[1] + r[1] * u, z) for z in np.linspace(PLINTH_H - 0.03, SPRING_Z + 0.03, 6)]
                mull.add(*tube_along(pts, 0.022, 6))
            s += COLUMN_STEP
        # 腰壁の上の真鍮の手すり
        for a, b in ((start_s, cut[0] + 0.25), (cut[1] - 0.25, end_s)):
            pts = []
            for ss in np.arange(a, b + 0.01, 1.0):
                c, f, r = rail.frame(ss)
                u = side * (PLINTH_IN + 0.1)
                pts.append((c[0] + r[0] * u, c[1] + r[1] * u, PLINTH_H + 0.03))
            mull.add(*tube_along(pts, 0.02, 6))
    mesh_object(f'{ROOM}.mullions', mull.v, mull.f, 'brass', {'look': 'brass', 'clearance_exempt': True, 'shell': True})

    # 7. 中庭: 楕円の水面、縁の腰壁、低いガラスの壁、庇
    n_th = 120
    pool_v = [(court.c[0], court.c[1], 0.035)]
    for i in range(n_th):
        th = 2 * math.pi * i / n_th
        q = court.point(th, 1.0)
        pool_v.append((q[0], q[1], 0.035))
    pool_f = [(0, 1 + i, 1 + (i + 1) % n_th) for i in range(n_th)]
    pool_uv = [(float(p[0]), float(p[1])) for p in pool_v]
    # court の extras: [中心の x, 中心の z, 長軸の向きの x, z, 長半径, 短半径]（three の座標。TS が雨を降らせる範囲に使う）
    ccx, _, ccz = blender_to_three((court.c[0], court.c[1], 0.0))
    fx3, _, fz3 = blender_to_three((court.f[0], court.f[1], 0.0))
    face_toward(mesh_object(f'{ROOM}.pool', pool_v, pool_f, 'water', {'role': 'water', 'look': 'pool', 'court': [ccx, ccz, fx3, fz3, COURT_A, COURT_B], 'vault_in': float(vault_in), 'vault_out': float(vault_out)}, smooth=False, uvs=pool_uv), direction=(0, 0, 1))

    def court_arc(side: float):
        """楕円の、回廊の口より外の弧（|u| ≥ HALF_W）の角度の列"""
        ths = []
        for i in range(721):
            th = (-math.pi if side < 0 else 0.0) + math.pi * i / 720
            q = court.point(th)
            p = np.array([q[0], q[1], 0.0])
            _s, u, _fw = rail.local(p, COURT_S)
            if abs(u) >= HALF_W - 0.25:
                ths.append(th)
        return ths

    cp = []
    cg = Builder()
    cg_uv = []
    for side in (-1, 1):
        ths = court_arc(side)
        ths = ths[:: max(1, len(ths) // 70)]
        # 腰壁: 内側（水面の縁）から外へ。断面は楕円の内向き n と上で作る
        prof = [(-0.25, 0.0), (-0.25, PLINTH_H - 0.12)] + arc((-0.13, PLINTH_H - 0.12), 0.12, math.pi, math.pi / 2, 4)[1:] + [(0.35, PLINTH_H), (0.35, 0.0)]
        verts = []
        for th in ths:
            q = court.point(th)
            # 外向きの法線（楕円）
            g = court.f[:2] * (math.cos(th) / COURT_A) + court.r[:2] * (math.sin(th) / COURT_B)
            g = g / np.linalg.norm(g)
            for d, z in prof:
                verts.append((q[0] + g[0] * d, q[1] + g[1] * d, z))
        m = len(prof)
        faces = []
        for i in range(len(ths) - 1):
            for kk in range(m - 1):
                a_, b_, c_, d_ = i * m + kk, i * m + kk + 1, (i + 1) * m + kk + 1, (i + 1) * m + kk
                faces.append((a_, b_, c_, d_) if side < 0 else (a_, d_, c_, b_))
        cp.append(mesh_object(f'{ROOM}.court_plinth.{len(cp):03d}', verts, faces, 'plinth', {'bake_group': 'court_plinth', 'clearance_exempt': True, 'shell': True}, sharp_angle_deg=40))
        face_toward(cp[-1], kd)
        # 低いガラスの壁（2.9m まで。上に街が見える）
        verts = []
        acc = 0.0
        prev = None
        for th in ths:
            q = court.point(th)
            if prev is not None:
                acc += float(np.linalg.norm(q - prev))
            prev = q
            for z in (PLINTH_H - 0.02, 2.9):
                verts.append((q[0], q[1], z))
                cg_uv.append((acc, 2.9 - z))
        faces = []
        for i in range(len(ths) - 1):
            a_, b_, c_, d_ = 2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2
            faces.append((a_, b_, c_, d_) if side < 0 else (a_, d_, c_, b_))
        cg.add(verts, faces)
        # 真鍮の上の縁
    face_toward(mesh_object(f'{ROOM}.court_glass', cg.v, cg.f, 'glass', {'glass': 'clear', 'look': 'wallglass', 'clearance_exempt': True, 'shell': True}, uvs=cg_uv), kd)
    ctop = Builder()
    for side in (-1, 1):
        ths = court_arc(side)[::6]
        ctop.add(*tube_along([(*court.point(th), 2.92) for th in ths], 0.03, 6))
        ctop.add(*tube_along([(*court.point(th), PLINTH_H + 0.03) for th in ths], 0.02, 6))
    mesh_object(f'{ROOM}.court_rail', ctop.v, ctop.f, 'brass', {'look': 'brass', 'clearance_exempt': True, 'shell': True})

    # 庇（中庭の上のガラスの帯）と真鍮の横桟・柱への腕
    cprof = [(u, CANOPY_Z0 + (CANOPY_Z1 - CANOPY_Z0) * (1 - (u / CANOPY_HALF) ** 2)) for u in np.linspace(-CANOPY_HALF, CANOPY_HALF, 9)]
    cprof = list(reversed(cprof))  # 下を向ける
    v, f = sweep(rail, cprof, vault_in - 0.6, vault_out + 0.6, 0.75)
    cl_half = sweep_uv(cprof, 0, 0, 1)[-1][1] / 2
    c_uv = [(uu, abs(vv - cl_half)) for uu, vv in sweep_uv(cprof, vault_in - 0.6, vault_out + 0.6, 0.75)]
    face_toward(mesh_object(f'{ROOM}.canopy', v, f, 'glass_roof', {'glass': 'clear', 'look': 'roofglass'}, uvs=c_uv), kd)
    cr = Builder()
    s = vault_in
    while s <= vault_out + 0.01:
        c, f, r = rail.frame(s)
        pts = [(c[0] + r[0] * u, c[1] + r[1] * u, z - 0.03) for u, z in reversed(cprof)]
        cr.add(*tube_along(pts, 0.02, 6))
        s += 1.5
    for side in (-1, 1):
        pts = []
        for ss in np.arange(vault_in - 0.6, vault_out + 0.61, 1.0):
            c, f, r = rail.frame(ss)
            pts.append((c[0] + r[0] * side * CANOPY_HALF, c[1] + r[1] * side * CANOPY_HALF, CANOPY_Z0 - 0.02))
        cr.add(*tube_along(pts, 0.028, 6))
    for col in columns:
        if col.get('in_court'):
            p = np.array(col.location)
            s_c, u_c, _ = rail.local(p, COURT_S)
            c, f, r = rail.frame(s_c)
            side = 1.0 if u_c > 0 else -1.0
            arm = []
            for i in range(7):
                t = i / 6
                u = side * (COLUMN_U - (COLUMN_U - CANOPY_HALF) * t)
                z = 3.86 + (CANOPY_Z0 - 0.02 - 3.86) * t
                arm.append((c[0] + r[0] * u, c[1] + r[1] * u, z))
            cr.add(*tube_along(arm, 0.022, 6))
    mesh_object(f'{ROOM}.canopy_ribs', cr.v, cr.f, 'brass', {'look': 'brass'})

    # 8. 突き当たりの壁（膜の円い口と、左右の扉の口）
    ce, fe, re_ = rail.frame(end_s)
    zc = float(rail.point(end_s)[2])

    def at_end(u: float, z: float, d: float = 0.0):
        return (ce[0] + re_[0] * u + fe[0] * d, ce[1] + re_[1] * u + fe[1] * d, z)

    # 壁の輪郭: 回廊の断面（床〜穹窿）。口: 中央の円（半径 PORTAL_R+0.04）、左右の扉（半円の頭の長方形）
    def outline_corridor(n=40):
        """突き当たりの壁は万華鏡の館の六角の正面（万華鏡の筒より少し大きい。回廊のガラス越しに見える館の顔）"""
        return [(FACADE_R * math.cos(math.radians(60 * k)), zc + FACADE_R * math.sin(math.radians(60 * k))) for k in range(6)]

    def hole_circle(n=48):
        return [(PORTAL_R * math.cos(2 * math.pi * i / n), zc + PORTAL_R * math.sin(2 * math.pi * i / n)) for i in range(n)]

    def hole_door(side: float, n=12):
        u0 = side * DOOR_U
        hw = DOOR_HALF + 0.04
        top = DOOR_Z1 - hw
        pts = [(u0 - hw, DOOR_Z0 - 0.02), (u0 + hw, DOOR_Z0 - 0.02)]
        pts += [(u0 + hw * math.cos(math.pi * i / n), top + hw * math.sin(math.pi * i / n)) for i in range(n + 1)]
        return pts

    ew = _wall_with_holes(outline_corridor(), [hole_circle(), hole_door(-1), hole_door(1)], at_end, thickness=0.35)
    recalc_closed(mesh_object(f'{ROOM}.endwall', ew[0], ew[1], 'endwall', {'bake_group': 'endwall', 'clearance_exempt': True, 'shell': True}, sharp_angle_deg=60))
    # 館の正面の縁（真鍮の六角の枠）
    hexf = Builder()
    corners = [at_end(FACADE_R * 0.985 * math.cos(math.radians(60 * k)), zc + FACADE_R * 0.985 * math.sin(math.radians(60 * k)), -0.05) for k in range(6)]
    rounded = []
    for k in range(6):
        a_, b_, c_ = np.array(corners[k - 1]), np.array(corners[k]), np.array(corners[(k + 1) % 6])
        rounded += [b_ + (a_ - b_) * 0.06, b_, b_ + (c_ - b_) * 0.06]
    rounded.append(rounded[0])
    hexf.add(*tube_along(rounded, 0.06, 8))
    mesh_object(f'{ROOM}.facade_frame', hexf.v, hexf.f, 'brass', {'look': 'brass', 'clearance_exempt': True, 'shell': True})
    # 膜の輪（真鍮）と膜
    ring = Builder()
    ring.add(*torus_points(at_end(0, zc, -0.06), re_, (0, 0, 1), PORTAL_R + 0.03, 0.05, 64, 10))
    ring.add(*torus_points(at_end(0, zc, -0.24), re_, (0, 0, 1), PORTAL_R + 0.04, 0.025, 64, 8))
    mesh_object(f'{ROOM}.portal_ring', ring.v, ring.f, 'brass', {'look': 'brass', 'clearance_exempt': True, 'shell': True})
    disc = [at_end(0, zc, -0.6)]
    for i in range(64):
        a = 2 * math.pi * i / 64
        disc.append(at_end(PORTAL_R * math.cos(a), zc + PORTAL_R * math.sin(a), -0.6))
    mem = mesh_object(f'{ROOM}.membrane', disc, [(0, 1 + (i + 1) % 64, 1 + i) for i in range(64)], 'membrane', {'role': 'membrane', 'glass': 'iridescent', 'look': 'membrane', 'clearance_exempt': True})
    mem['to'] = 'kaleidoscope'
    face_toward(mem, direction=(-fe[0], -fe[1], 0.0))

    # 9. 扉（左: 琥珀、右: 瑠璃）。観音開きの2枚の葉。葉の原点は蝶番（外側の縁）。扉の奥に光の板
    for side, door in ((-1, 'amber'), (1, 'lapis')):
        u0 = side * DOOR_U
        hw = DOOR_HALF
        top = DOOR_Z1 - hw
        heading = math.atan2(fe[1], fe[0])  # Blender の x 軸からの角度
        for leaf, sgn in ((0, -1), (1, 1)):
            # 葉の局所座標: x = 蝶番から扉の中心へ（0→hw）、y = 厚み、z = 高さ
            hinge_u = u0 + sgn * hw
            prof = []
            n = 10
            for i in range(n + 1):
                t = i / n
                x = hw * t
                # 上は半円（扉の中心で最も高い）
                zt = top + math.sqrt(max(0.0, hw * hw - (hw - x) ** 2))
                prof.append((x, zt))
            verts = []
            faces = []
            th = 0.03
            for i, (x, zt) in enumerate(prof):
                for y in (-th, th):
                    verts.append((x, y, DOOR_Z0))
                    verts.append((x, y, zt))
            # i ごとに 4 点: (y-, 下), (y-, 上), (y+, 下), (y+, 上)
            for i in range(len(prof) - 1):
                a = i * 4
                b = (i + 1) * 4
                faces.append((a, b, b + 1, a + 1))  # 表（y-）
                faces.append((a + 2, a + 3, b + 3, b + 2))  # 裏（y+）
                faces.append((a + 1, b + 1, b + 3, a + 3))  # 上
                faces.append((a, a + 2, b + 2, b))  # 下
            faces.append((0, 1, 3, 2))
            last = (len(prof) - 1) * 4
            faces.append((last, last + 2, last + 3, last + 1))
            o = mesh_object(f'{ROOM}.door_{door}.{leaf:03d}', verts, faces, f'door_{door}', {'glass': 'tinted', 'look': 'door', 'door': door, 'leaf': leaf, 'role': 'door', 'touch_kind': 'door', 'touch_id': f'door-{door}'}, sharp_angle_deg=60)
            recalc_closed(o)
            # 局所 x を扉の中心へ向ける: 右の葉（sgn=+1）は u が減る向き、左の葉は u が増える向き
            # 局所 y（厚み）をレールの前へ向ける
            o.location = at_end(hinge_u, 0.0, -0.05)
            yaw = heading - math.pi / 2  # 局所 x = 右（u+）、局所 y = 前
            if sgn > 0:
                o.rotation_euler = (0.0, 0.0, yaw + math.pi)  # x = 左（u-）、y = 後ろ（面は対称なので見た目は同じ）
            else:
                o.rotation_euler = (0.0, 0.0, yaw)
        # 枠（真鍮）: 扉の口の縁
        hw2 = DOOR_HALF + 0.05
        top2 = DOOR_Z1 - hw2 + 0.0
        pts = [at_end(u0 - hw2, DOOR_Z0 - 0.04, -0.2)]
        pts += [at_end(u0 + hw2 * math.cos(math.pi - math.pi * i / 16), top2 + hw2 * math.sin(math.pi - math.pi * i / 16), -0.2) for i in range(17)]
        pts += [at_end(u0 + hw2, DOOR_Z0 - 0.04, -0.2)]
        fr = Builder()
        fr.add(*tube_along(pts, 0.035, 8))
        fr.add(*tube_along([at_end(u0 - hw2 - 0.05, DOOR_Z0 - 0.06, -0.2), at_end(u0 + hw2 + 0.05, DOOR_Z0 - 0.06, -0.2)], 0.035, 8))
        mesh_object(f'{ROOM}.doorframe_{door}', fr.v, fr.f, 'brass', {'look': 'brass', 'door': door})
        # 扉の奥の光の板（壁の向こう側。扉が開くと見える）
        lv = []
        for i in range(13):
            a = math.pi * i / 12
            lv.append(at_end(u0 + hw2 * math.cos(a), top2 + hw2 * math.sin(a), 0.33))
        lv += [at_end(u0 - hw2, DOOR_Z0 - 0.05, 0.33), at_end(u0 + hw2, DOOR_Z0 - 0.05, 0.33)]
        n = len(lv)
        lf = [tuple([n - 1] + list(range(0, 13)) + [n - 2])]
        face_toward(mesh_object(f'{ROOM}.doorlight_{door}', lv, lf, f'doorlight_{door}', {'look': 'doorlight', 'door': door}, smooth=False), direction=(-fe[0], -fe[1], 0.0))

    # 10. 遠景の街（建物の影と窓の灯り）。回廊の外、左右に。曲がりの外側（左）を厚く
    city = Builder()
    lights = Builder()
    light_cols: list = []
    s = s0 + 2.0
    while s < s1 + 2.0:
        c, f, r = rail.frame(s)
        for side in (-1, 1):
            if rng.random() < (0.25 if side > 0 else 0.1):
                continue
            dist = rng.uniform(10.0, 34.0) if side < 0 else rng.uniform(9.0, 26.0)
            w = rng.uniform(4.0, 9.0)
            dpt = rng.uniform(4.0, 8.0)
            h = rng.uniform(6.0, 21.0) * (0.75 if side > 0 else 1.0)
            ctr = c + r * side * (dist + dpt / 2) + f * rng.uniform(-1.5, 1.5)
            yaw = math.atan2(f[1], f[0]) + rng.uniform(-0.12, 0.12)
            v, fc = _rounded_box(ctr, yaw, w, dpt, h, 0.6)
            city.add(v, fc)
            # 窓の灯り（回廊に向いた面）。水の膜越しににじむので大きめの丸い光の板
            face_u = -side
            ax_f = np.array([math.cos(yaw), math.sin(yaw), 0.0])
            ax_r = np.array([ax_f[1], -ax_f[0], 0.0])
            front = ctr + ax_r * face_u * (dpt / 2 + 0.05)
            for row in range(int(h // 1.7)):
                for colw in range(int(w // 1.1)):
                    if rng.random() > 0.38:
                        continue
                    pz = 1.2 + row * 1.7 + rng.uniform(-0.1, 0.1)
                    px = -w / 2 + 0.55 + colw * 1.1
                    size = rng.uniform(0.22, 0.42)
                    p = front + ax_f * px
                    q = [p + ax_f * (-size) + np.array([0, 0, pz - size]), p + ax_f * size + np.array([0, 0, pz - size]), p + ax_f * size + np.array([0, 0, pz + size]), p + ax_f * (-size) + np.array([0, 0, pz + size])]
                    base_i = len(lights.v)
                    lights.add(q, [(0, 1, 2, 3) if face_u > 0 else (0, 3, 2, 1)])
                    warm = rng.random()
                    col = (1.0, 0.62, 0.3) if warm < 0.7 else ((1.0, 0.86, 0.66) if warm < 0.93 else (0.55, 0.85, 0.9))
                    light_cols.extend([col] * 4)
        s += rng.uniform(6.0, 11.0)
    recalc_closed(mesh_object(f'{ROOM}.city', city.v, city.f, 'city', {'look': 'city', 'clearance_exempt': True}, sharp_angle_deg=50))
    cl = mesh_object(f'{ROOM}.city_lights', lights.v, lights.f, 'citylight', {'look': 'citylight', 'clearance_exempt': True}, smooth=False)
    face_toward(cl, kd)
    # 色（頂点の色）と UV（0〜1。TS の丸い光の板に使う）
    me = cl.data
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for j, li in enumerate(poly.loop_indices):
            vi = me.loops[li].vertex_index
            cc = light_cols[vi]
            attr.data[li].color = (*cc, 1.0)
            uvl.data[li].uv = ((0, 0), (1, 0), (1, 1), (0, 1))[j % 4]
    info['city_lights'] = len(light_cols) // 4

    info['bake'] = [o.name for o in OBJECTS if o.get('bake_group')]
    return info


def _rounded_box(ctr, yaw, w, d, h, rad):
    """角を丸めた箱（上の縁を丸く。遠景なので面は少なく）"""
    ax_f = np.array([math.cos(yaw), math.sin(yaw), 0.0])
    ax_r = np.array([ax_f[1], -ax_f[0], 0.0])
    verts = []
    faces = []
    # 平面の角を丸めた輪郭（8点×角）
    ring = []
    for cx, cy, a0 in ((w / 2 - rad, d / 2 - rad, 0.0), (-w / 2 + rad, d / 2 - rad, math.pi / 2), (-w / 2 + rad, -d / 2 + rad, math.pi), (w / 2 - rad, -d / 2 + rad, 3 * math.pi / 2)):
        for i in range(4):
            a = a0 + (math.pi / 2) * i / 3
            ring.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    m = len(ring)
    levels = [(0.0, 1.0), (h - rad, 1.0), (h - rad * 0.3, 0.75), (h, 0.35)]
    for z, sc in levels:
        for x, y in ring:
            p = ctr + ax_f * x * (sc if z >= h - rad else 1) + ax_r * y * (sc if z >= h - rad else 1)
            verts.append((p[0], p[1], z))
    for li in range(len(levels) - 1):
        for i in range(m):
            i2 = (i + 1) % m
            faces.append((li * m + i, li * m + i2, (li + 1) * m + i2, (li + 1) * m + i))
    top = len(verts)
    verts.append((ctr[0], ctr[1], h))
    for i in range(m):
        faces.append(((len(levels) - 1) * m + i, (len(levels) - 1) * m + (i + 1) % m, top))
    return verts, faces


def _wall_with_holes(outline, holes, to_world, thickness: float):
    """外形 outline（(u, z) の多角形）から穴 holes をくり抜いた厚みのある壁。三角形分割は Blender に任せる"""
    bm = bmesh.new()
    loops = [outline] + holes
    edges = []
    for loop in loops:
        vs = [bm.verts.new((u, z, 0.0)) for u, z in loop]
        for i in range(len(vs)):
            edges.append(bm.edges.new((vs[i], vs[(i + 1) % len(vs)])))
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
    # 穴の中の面を消す（面の中心が穴の多角形の中にあれば消す）
    def inside(poly, x, y):
        c = False
        j = len(poly) - 1
        for i in range(len(poly)):
            xi, yi = poly[i]
            xj, yj = poly[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
                c = not c
            j = i
        return c

    dead = []
    for fa in bm.faces:
        cen = fa.calc_center_median()
        if any(inside(h, cen.x, cen.y) for h in holes):
            dead.append(fa)
    bmesh.ops.delete(bm, geom=dead, context='FACES')
    # 厚み: 面を押し出す
    for fa in bm.faces:
        if fa.normal.z < 0:
            fa.normal_flip()
    ret = bmesh.ops.extrude_face_region(bm, geom=list(bm.faces))
    moved = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
    for v in moved:
        v.co.z += thickness
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    verts = []
    for v in bm.verts:
        u, z, d = v.co.x, v.co.y, v.co.z
        verts.append(to_world(u, z, d))
    faces = [tuple(v.index for v in fa.verts) for fa in bm.faces]
    bm.free()
    # 世界座標に写すと、(u, z, d) → (右, 上, 前) は左手系になるので面の向きを反転する
    faces = [tuple(reversed(f)) for f in faces]
    return verts, faces


# ── 物との距離（殻は本当の形で測る） ──────────────────────────────────────
def check_shell_clearance(rail: Rail, objs) -> dict:
    s0, s1 = rail.sections[ROOM]
    samples = [Vector(rail.point(s)) for s in np.arange(s0, s1 + 0.01, 0.25)]
    worst = {}
    bad = []
    for o in objs:
        if not o.get('clearance_exempt') or o.get('role') == 'membrane' or o.type != 'MESH' or len(o.data.polygons) == 0:
            continue
        me = o.data
        mw = o.matrix_world
        verts = [mw @ v.co for v in me.vertices]
        polys = [tuple(p.vertices) for p in me.polygons]
        tree = BVHTree.FromPolygons(verts, polys)
        dmin = 1e9
        for p in samples:
            hit = tree.find_nearest(p)
            if hit[0] is not None:
                dmin = min(dmin, hit[3])
        worst[o.name] = round(dmin, 3)
        if dmin < SHELL_CLEAR:
            bad.append((o.name, dmin))
    if bad:
        raise RuntimeError(f'殻がレールに近すぎます（{SHELL_CLEAR}m 未満）: {bad}')
    return worst


def check_box_clearance(rail: Rail, objs) -> list:
    """TS の検査と同じ（軸に沿った箱。three の座標で同じになる）。殻以外の物の違反の一覧"""
    s0, s1 = rail.sections[ROOM]
    samples = np.array([rail.point(s) for s in np.arange(s0, s1 + 0.01, 0.5)])
    bad = []
    for o in objs:
        if o.get('clearance_exempt') or o.type != 'MESH' or len(o.data.vertices) == 0 or o.location.z < -50:
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


# ── 環境画像（反射と雨粒の屈折に使う。中庭の中心から撮る） ───────────────────
def render_env(rail: Rail, path: str, size=(1024, 512), samples=48):
    sc = bpy.context.scene
    cam = bpy.data.cameras.new(f'{ROOM}.envcam')
    cam.type = 'PANO'
    cam.panorama_type = 'EQUIRECTANGULAR'
    co = bpy.data.objects.new(f'{ROOM}.envcam', cam)
    sc.collection.objects.link(co)
    c = rail.point(COURT_S)
    co.location = (float(c[0]), float(c[1]), float(c[2]) + 0.15)
    co.rotation_euler = (math.pi / 2, 0.0, 0.0)  # 前 = +Y（Blender）。u = 0.5 + atan2(x, y)/2π、上が画像の上
    sc.camera = co
    hidden = []
    for o in OBJECTS:
        if o.get('look') in ('door', 'doorlight', 'membrane'):
            if not o.hide_render:
                o.hide_render = True
                hidden.append(o)
    keep = (sc.render.engine, sc.render.resolution_x, sc.render.resolution_y, sc.render.filepath)
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_depth = '8'
    sc.render.image_settings.color_mode = 'RGB'
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.render.filepath = path
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    for o in hidden:
        o.hide_render = False
    sc.render.engine, sc.render.resolution_x, sc.render.resolution_y, sc.render.filepath = keep
    bpy.data.objects.remove(co)
    return round(time.time() - t0, 1)


def setup_world(strength: float = 1.0):
    sc = bpy.context.scene
    w = bpy.data.worlds.new(f'{ROOM}.sky')
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes['Background']
    # 雨の昼の曇り空: 上は明るい灰青、地平は少し暗く。グラデーションは Sky の代わりに上下の混ぜで
    grad = nt.nodes.new('ShaderNodeTexGradient')
    grad.gradient_type = 'LINEAR'
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    # Generated は World ではベクトルの向き。z を 0〜1 に
    mapr = nt.nodes.new('ShaderNodeMapRange')
    mapr.inputs['From Min'].default_value = -0.2
    mapr.inputs['From Max'].default_value = 1.0
    nt.links.new(sep.outputs['Z'], mapr.inputs['Value'])
    nt.links.new(mapr.outputs['Result'], ramp.inputs['Fac'])
    ramp.color_ramp.elements[0].color = (0.16, 0.18, 0.21, 1.0)
    ramp.color_ramp.elements[1].color = (0.62, 0.68, 0.76, 1.0)
    e = ramp.color_ramp.elements.new(0.35)
    e.color = (0.42, 0.47, 0.54, 1.0)
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = strength
    del grad
    sc.world = w



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
    ap.add_argument('--blend', default=os.path.join(ROOT, 'blender/scenes/rain.blend'))
    ap.add_argument('--size', type=int, default=2048)
    ap.add_argument('--samples', type=int, default=512)
    ap.add_argument('--quick', action='store_true', help='焼き込みを小さく速く（確かめ用）')
    ap.add_argument('--no-env', action='store_true')
    args = ap.parse_args(script_args())
    if args.quick:
        args.size, args.samples = 512, 16

    t_all = time.time()
    ride = json.load(open(args.rail))
    rail = Rail(ride)
    rng = random.Random(21)

    # 空の場面から作る
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    global COLL
    COLL = bpy.data.collections.new(ROOM)
    bpy.context.scene.collection.children.link(COLL)
    setup_world(0.85)

    info = build(rail, rng)
    objs = [o for o in OBJECTS]
    bad_names = check_names(objs, [ROOM])
    if bad_names:
        raise RuntimeError(f'名前の規則に合わない: {bad_names}')

    # 物との距離: 殻は本当の形、それ以外は TS と同じ箱で
    shell = check_shell_clearance(rail, objs)
    box_bad = check_box_clearance(rail, objs)
    if box_bad:
        raise RuntimeError(f'ゴンドラに近すぎる物（箱で {CLEAR}m 未満）: {box_bad}')

    # 見えない面の削除（区間の前後に余裕）。元の型（複製の元。z=-100 に置いた物）は除く
    s0, s1 = rail.sections[ROOM]
    span = rail.span_points(max(0.0, s0 - CULL_MARGIN), s1 + CULL_MARGIN, 1.0)
    # 動く物（扉の葉は開く、膜は通り抜ける）とインスタンス（柱・灯り）は、止まった形の見え方で削らない
    cull_objs = [o for o in objs if o.type == 'MESH' and not o.get('instance') and o.get('look') not in ('door', 'doorlight', 'membrane')]
    rep = cull_hidden(cull_objs, span, yaw_deg=120, pitch_deg=60, head_radius=0.5)
    print(f"cull: {rep['before_tris']} -> {rep['after_tris']} 三角形（{rep['removed_faces']} 面を削除、{rep['rays']} 本、{rep['seconds']}s）")
    for name in rep['emptied']:
        print(f'  空になった物: {name}')

    # 焼き込み（アトラス 1 枚）。ガラス・インスタンス・発光・真鍮・水は外す
    baked = [o for o in objs if o.get('bake_group') and len(o.data.polygons) > 0]
    # ガラスは焼き込みの材質の Alpha で光を弱めて通す（影は薄くなる）
    lamps_scene = [o for o in objs if o.get('look') in ('doorlight',)]
    for o in lamps_scene:
        o.hide_render = True  # 扉の奥の光は TS の演出（焼き込みに入れない）
    t_b = time.time()
    res = bake_lightmaps(baked, args.out_dir, size=args.size, samples=args.samples, name=f'{ROOM}.lightmap')
    bake_sec = round(time.time() - t_b, 1)
    smooth = smooth_lightmap(os.path.join(args.out_dir, f'{ROOM}.lightmap.png')) if res else None
    print(f'smooth: {smooth}')
    for o in lamps_scene:
        o.hide_render = False

    # 焼いた後、同じ組の物を1つにまとめる（描く物の数を減らす。Lightmap UV と extras は残る）
    joined = {}
    by_group: dict[str, list[str]] = {}
    for o in baked:
        by_group.setdefault(o['bake_group'], []).append(o.name)
    for group, names in sorted(by_group.items()):
        members = [bpy.data.objects[n] for n in names]
        if len(members) > 1:
            for o in bpy.context.view_layer.objects:
                o.select_set(False)
            for o in members:
                o.select_set(True)
            bpy.context.view_layer.objects.active = members[0]
            bpy.ops.object.join()
        o = bpy.context.view_layer.objects.active if len(members) > 1 else members[0]
        o.name = f'{ROOM}.{group}'
        o.data.name = o.name
        joined[group] = o.name
    objs = [o for o in COLL.objects]
    OBJECTS[:] = objs

    env_sec = None
    if not args.no_env:
        env_sec = render_env(rail, os.path.join(args.out_dir, f'{ROOM}.env.png'), size=(512, 256) if args.quick else (1024, 512), samples=8 if args.quick else 48)

    # 書き出し（材質は glTF の基本だけの物に替える）。元の型（z=-100）も書き出す（TS がインスタンスの形に使う）
    MATS.use('export', objs)
    glb = os.path.join(args.out_dir, f'{ROOM}.glb')
    size = export_glb(objs, glb, rooms=[ROOM], options={'export_vertex_color': 'ACTIVE'})
    load = room_load_report(objs, glb, args.out_dir)
    ext = _glb_extensions(glb)
    if ext:
        raise RuntimeError(f'glb に拡張が入りました（node のテストで読めません）: {ext}')
    MATS.use('bake', objs)
    os.makedirs(os.path.dirname(args.blend), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend), compress=True)

    tris = 0
    for o in objs:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    summary = {
        'room': ROOM,
        'objects': len(objs),
        'triangles_after': tris,
        'cull': {k: rep[k] for k in ('before_tris', 'after_tris', 'removed_faces', 'seconds')},
        'bake': {'size': args.size, 'samples': args.samples, 'seconds': bake_sec, 'scale': res[0]['scale'] if res else None, 'max_over_scale': res[0]['max_over_scale'] if res else None},
        'env_seconds': env_sec,
        'glb_bytes': size,
        'load': load,
        'shell_clearance': shell,
        'joined': joined,
        'info': info,
        'total_seconds': round(time.time() - t_all, 1),
    }
    print('SUMMARY ' + json.dumps(summary, ensure_ascii=False, default=str))


def _glb_extensions(path: str) -> list:
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + n])
    return (j.get('extensionsUsed') or []) + (j.get('extensionsRequired') or [])


if __name__ == '__main__':
    main()
