"""乗り場「泡の発着場」（乗り場と降車で同じホール。光だけ変える）と、部屋A（待ち列・乗り場・温室）の共通の道具。

    pnpm blender blender/scripts/rooms/platform.py            # 造形 → 見えない面の削除 → 焼き込み（夜明け前・朝） → glb
    pnpm blender blender/scripts/rooms/platform.py -- --fast  # 焼き込みのサンプルを減らした下書き

絵コンテ（入口で視界が開ける一枚絵）:
  乗車の頭、ゴンドラは南の桟橋の先の水面に浮かぶ。正面（北）へ、夜明け前の青灰の円形のホールが開ける。
  黒い鏡のような水面がホールの床いっぱいに広がり、天井の乳白の灯りの輪が水に映る。
  天井の中心から大小のガラスの泡が房になって吊られ、レールの上の空間を縁取るように左右へ降りてくる。
  泡の房の向こう、正面の壁の高い所に、虹色の膜が張られた真鍮の丸い門がかすかに光る。
  レールはゆっくり上りながら泡の間を抜け、その門へ向かう（目線は水面 → 泡 → 門と、下から上へ導かれる）。
  降車では同じホールに東の高窓から朝日が差し、壁と水面が金色に変わっている。

ホールの形（three.js の座標。Y が上、-Z が北＝乗車の正面）:
  - 円の中心 HALL_C、内壁の半径 HALL_R。北の門（乗り場 → 温室の膜、s = 乗り場の区間の終わり）と
    東の水門（夜明けの岸 → 降車の膜）がちょうど壁の厚みの中に来るように中心を選んである（下の solve_hall）。
  - 床はほぼ全面が水（y = WATER_Y）。南の壁沿いに乗り場の桟橋、壁沿いに細い回廊。
  - 東の水門は、降車のレールが壁を斜めに横切るので、短い水路（canal）として壁から外へ突き出す。

共通の道具（待ち列 lobby.py と温室 greenhouse.py も `from rooms import platform as kit` で使う）:
  レールの読み込みと評価（TS の createRide と同じ Catmull-Rom）、メッシュを作る道具（管、回転体、板）、材質、
  物との最短距離の検査（src/rooms/testing.ts と同じ「物の箱とレールの点の距離」）と、箱が近すぎる大きな物を
  箱が離れる大きさの塊に分ける道具、見えない面の削除・焼き込み・書き出しの流れ。
  造形の座標はすべて three.js の向きで計算し、メッシュを作るときに Blender の向き（x, -z, y）へ直す。
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
import time

import bmesh
import bpy
import numpy as np

sys.dont_write_bytecode = True  # __pycache__ を作らない
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from common.bake import bake_lightmaps  # noqa: E402
from common.cli import script_args  # noqa: E402
from common.export import export_glb, room_load_report  # noqa: E402
from common.naming import check_names  # noqa: E402
from common.visibility import cull_hidden  # noqa: E402

REPO = os.path.abspath(os.path.join(SCRIPTS, '..', '..'))
ASSETS = os.path.join(REPO, 'public', 'assets')
OUT_DIR = os.path.join(ASSETS, 'rooms')
SCENES = os.path.join(REPO, 'blender', 'scenes')

# ── 設計書の数値（src/config.ts の写し。Python からは TS を読めない） ──
#: ゴンドラの半径（GONDOLA_DIAMETER / 2）と、物との最短距離（MOTION.clearanceMin）
GONDOLA_R = 2.4 / 2
CLEARANCE_MIN = 0.5
#: 検査の余裕（Catmull-Rom の補間や書き出しの丸めで食い違わないように）
CLEARANCE_SLACK = 0.08
NEED = GONDOLA_R + CLEARANCE_MIN + CLEARANCE_SLACK
#: 部屋の読み込みの上限（PERF.roomLoadMB、10進）
MAX_ROOM_BYTES = 15 * 1000 * 1000
#: 見回せる範囲（設計書「見えない部分の削除」）
LOOK_YAW = 120.0
LOOK_PITCH = 60.0
HEAD_RADIUS = 0.5


# ═══════════════════════════════════════════════════════════════════════
# レール
# ═══════════════════════════════════════════════════════════════════════
class Rail:
    """public/assets/rail.json。位置は TS の createRide と同じ Catmull-Rom（s は点の番号 × spacing）"""

    def __init__(self, path: str | None = None):
        with open(path or os.path.join(ASSETS, 'rail.json'), encoding='utf8') as f:
            data = json.load(f)
        self.data = data
        self.spacing = float(data['rail']['spacing'])
        self.p = np.asarray(data['rail']['points'], dtype=np.float64)
        self.n = len(self.p)
        self.max_s = (self.n - 1) * self.spacing
        self.sections = {s['id']: (float(s['s0']), float(s['s1'])) for s in data['sections']}
        tl = data['timeline']
        self.tl_t = np.asarray([k['t'] for k in tl], dtype=np.float64)
        self.tl_s = np.asarray([k['s'] for k in tl], dtype=np.float64)

    def _at(self, k: np.ndarray) -> np.ndarray:
        """端の外の点は折り返して作る（TS と同じ）"""
        k = np.asarray(k)
        out = self.p[np.clip(k, 0, self.n - 1)].copy()
        lo = k < 0
        hi = k >= self.n
        if lo.any():
            out[lo] = 2 * self.p[0] - self.p[1]
        if hi.any():
            out[hi] = 2 * self.p[-1] - self.p[-2]
        return out

    def at(self, s) -> np.ndarray:
        """距離 s（スカラーか配列）の点（three.js の座標）"""
        s = np.atleast_1d(np.asarray(s, dtype=np.float64))
        u = np.clip(s, 0, self.max_s) / self.spacing
        i = np.minimum(self.n - 2, np.floor(u).astype(int))
        f = (u - i)[:, None]
        f2, f3 = f * f, f * f * f
        w0 = 0.5 * (-f3 + 2 * f2 - f)
        w1 = 0.5 * (3 * f3 - 5 * f2 + 2)
        w2 = 0.5 * (-3 * f3 + 4 * f2 + f)
        w3 = 0.5 * (f3 - f2)
        return w0 * self._at(i - 1) + w1 * self._at(i) + w2 * self._at(i + 1) + w3 * self._at(i + 2)

    def point(self, s: float) -> np.ndarray:
        return self.at(s)[0]

    def forward(self, s: float, h: float = 0.5) -> np.ndarray:
        """水平の進行方向（単位ベクトル、three.js の座標）"""
        a, b = self.at([max(0.0, s - h), min(self.max_s, s + h)])
        d = b - a
        d[1] = 0.0
        n = np.linalg.norm(d)
        return d / n if n > 1e-9 else np.array([0.0, 0.0, -1.0])

    def yaw(self, s: float) -> float:
        f = self.forward(s)
        return math.atan2(-f[0], -f[2])

    def right(self, s: float) -> np.ndarray:
        f = self.forward(s)
        return np.array([-f[2], 0.0, f[0]])

    def samples(self, s0: float, s1: float, step: float = 0.25) -> np.ndarray:
        n = max(2, int(math.ceil((s1 - s0) / step)) + 1)
        return self.at(np.linspace(s0, s1, n))

    def span(self, *ids: str, before: float = 0.0, after: float = 0.0) -> tuple[float, float]:
        s0 = min(self.sections[i][0] for i in ids) - before
        s1 = max(self.sections[i][1] for i in ids) + after
        return max(0.0, s0), min(self.max_s, s1)

    def time_of(self, s: float) -> float:
        return float(np.interp(s, self.tl_s, self.tl_t))

    def s_at(self, t: float) -> float:
        return float(np.interp(t, self.tl_t, self.tl_s))


def to_blender(v) -> np.ndarray:
    """three (x, y, z) → Blender (x, -z, y)。配列 (n, 3) も"""
    v = np.asarray(v, dtype=np.float64)
    return np.stack([v[..., 0], -v[..., 2], v[..., 1]], axis=-1)


def to_three(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    return np.stack([v[..., 0], v[..., 2], -v[..., 1]], axis=-1)


# ═══════════════════════════════════════════════════════════════════════
# シーンと材質
# ═══════════════════════════════════════════════════════════════════════
def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.unit_settings.system = 'METRIC'


def collection(name: str):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(c)
    return c


def srgb(hex_or_tuple) -> tuple[float, float, float]:
    """sRGB の色（'#rrggbb' か 0〜1 の組）を線形へ"""
    if isinstance(hex_or_tuple, str):
        h = hex_or_tuple.lstrip('#')
        c = tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    else:
        c = tuple(hex_or_tuple)

    def lin(x: float) -> float:
        return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4

    return tuple(lin(x) for x in c)  # type: ignore[return-value]


def material(name: str, color='#cccccc', roughness: float = 0.6, metallic: float = 0.0, emission=None, strength: float = 0.0,
             alpha: float = 1.0, shadow_tint: bool = False):
    """Principled の材質。shadow_tint は焼き込みのときに光を色付きで半分通す（ガラスの植物の影）"""
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    # 片面で書き出す（glTF の doubleSided = false。見える面の向きは造形の側で揃える）
    m.use_backface_culling = True
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*srgb(color), 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if emission is not None and strength > 0:
        bsdf.inputs['Emission Color'].default_value = (*srgb(emission), 1.0)
        bsdf.inputs['Emission Strength'].default_value = strength
    if alpha < 1.0 or shadow_tint:
        # 色ガラスの影: 透明と拡散を混ぜる（光が色付きで抜ける）
        out = nt.nodes.get('Material Output')
        mix = nt.nodes.new('ShaderNodeMixShader')
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        tr.inputs['Color'].default_value = (*srgb(color), 1.0)
        mix.inputs['Fac'].default_value = 1.0 - (alpha if alpha < 1.0 else 0.45)
        nt.links.new(bsdf.outputs['BSDF'], mix.inputs[1])
        nt.links.new(tr.outputs['BSDF'], mix.inputs[2])
        nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
    return m


def emitter(name: str, color, strength: float):
    """焼き込みの光だけに使う発光（書き出さない物か、TS が材質を差し替える物に付ける）"""
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*srgb(color), 1.0)
    em.inputs['Strength'].default_value = strength
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return m


def set_world(color, strength: float) -> None:
    w = bpy.data.worlds.get('World') or bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (*srgb(color), 1.0)
    bg.inputs['Strength'].default_value = strength


def sun(name: str, direction_three, color, strength: float, angle_deg: float = 1.5):
    """太陽（焼き込みだけ。書き出さない）。direction_three は光の進む向き（three.js の座標）"""
    d = bpy.data.lights.new(name, 'SUN')
    d.energy = strength
    d.color = srgb(color)
    d.angle = math.radians(angle_deg)
    ob = bpy.data.objects.new(name, d)
    bpy.context.scene.collection.objects.link(ob)
    v = to_blender(np.asarray(direction_three, dtype=np.float64))
    v = v / np.linalg.norm(v)
    # 太陽は -Z を向く。-Z を v に合わせる
    from mathutils import Vector
    ob.rotation_euler = Vector((-v[0], -v[1], -v[2])).to_track_quat('Z', 'Y').to_euler()
    return ob


# ═══════════════════════════════════════════════════════════════════════
# メッシュを作る道具（three.js の座標で受け取る）
# ═══════════════════════════════════════════════════════════════════════
def mesh_object(name: str, verts, faces, mat=None, coll=None, smooth: bool = True, props: dict | None = None, mats=None, face_mats=None, origin=None):
    """three.js の座標の頂点と面から物を作る。頂点は世界座標。
    origin（three.js の座標）を渡すと物の原点をそこに置く（触れられる物: 縁の光の距離は物の原点から測る）"""
    v3 = np.asarray(verts, dtype=np.float64).reshape(-1, 3)
    if origin is not None:
        v3 = v3 - np.asarray(origin, dtype=np.float64)
    v = to_blender(v3)
    me = bpy.data.meshes.new(name)
    me.from_pydata(v.tolist(), [], [tuple(int(i) for i in f) for f in faces])
    me.validate(clean_customdata=False)
    if mats:
        for m in mats:
            me.materials.append(m)
        if face_mats is not None:
            fm = np.asarray(face_mats, dtype=np.int32)
            me.polygons.foreach_set('material_index', fm[: len(me.polygons)])
    elif mat is not None:
        me.materials.append(mat)
    if smooth:
        me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    if origin is not None:
        ob.location = tuple(to_blender(np.asarray(origin, dtype=np.float64)).tolist())
    (coll or bpy.context.scene.collection).objects.link(ob)
    for k, val in (props or {}).items():
        ob[k] = val
    return ob


class Builder:
    """頂点と面を貯めて、最後に1つの物にする（同じ材質の小物をまとめて描く物の数を減らす）"""

    def __init__(self):
        self.v: list[np.ndarray] = []
        self.f: list[list[int]] = []
        self.fm: list[int] = []
        self.n = 0

    def add(self, verts, faces, mat_index: int = 0) -> None:
        verts = np.asarray(verts, dtype=np.float64).reshape(-1, 3)
        self.v.append(verts)
        for f in faces:
            self.f.append([int(i) + self.n for i in f])
            self.fm.append(mat_index)
        self.n += len(verts)

    def empty(self) -> bool:
        return self.n == 0

    def build(self, name: str, mat=None, coll=None, smooth=True, props=None, mats=None):
        verts = np.concatenate(self.v) if self.v else np.zeros((0, 3))
        return mesh_object(name, verts, self.f, mat, coll, smooth, props, mats=mats, face_mats=self.fm if mats else None)


def frames_along(path: np.ndarray, up_hint=(0.0, 1.0, 0.0)) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """折れ線の各点の接線 T・法線 N・従法線 B（平行移動の枠。ねじれない）"""
    p = np.asarray(path, dtype=np.float64)
    n = len(p)
    t = np.zeros_like(p)
    t[1:-1] = p[2:] - p[:-2]
    t[0] = p[1] - p[0]
    t[-1] = p[-1] - p[-2]
    t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-12)
    up = np.asarray(up_hint, dtype=np.float64)
    if abs(np.dot(up, t[0])) > 0.95:
        up = np.array([1.0, 0.0, 0.0])
    nrm = np.cross(t[0], up)
    nrm /= np.linalg.norm(nrm)
    N = np.zeros_like(p)
    N[0] = nrm
    for i in range(1, n):
        v = N[i - 1] - t[i] * np.dot(N[i - 1], t[i])
        ln = np.linalg.norm(v)
        N[i] = v / ln if ln > 1e-9 else N[i - 1]
    B = np.cross(t, N)
    return t, N, B


def tube(path, radius, sides: int = 8, caps: bool = True, closed: bool = False):
    """折れ線に沿った管（丸い断面）。radius はスカラーか点ごとの配列。頂点と面を返す"""
    p = np.asarray(path, dtype=np.float64)
    n = len(p)
    r = np.broadcast_to(np.asarray(radius, dtype=np.float64), (n,))
    _t, N, B = frames_along(p)
    a = np.linspace(0, 2 * np.pi, sides, endpoint=False)
    ring = np.cos(a)[None, :, None] * N[:, None, :] + np.sin(a)[None, :, None] * B[:, None, :]
    verts = (p[:, None, :] + ring * r[:, None, None]).reshape(-1, 3)
    faces = []
    m = n if closed else n - 1
    for i in range(m):
        j = (i + 1) % n
        for k in range(sides):
            k2 = (k + 1) % sides
            faces.append((i * sides + k, i * sides + k2, j * sides + k2, j * sides + k))
    if caps and not closed:
        verts = np.vstack([verts, p[0], p[-1]])
        c0, c1 = len(verts) - 2, len(verts) - 1
        for k in range(sides):
            k2 = (k + 1) % sides
            faces.append((c0, k2, k))
            faces.append((c1, (n - 1) * sides + k, (n - 1) * sides + k2))
    return verts, faces


def lathe(profile, segments: int = 48, center=(0.0, 0.0, 0.0), cap_top: bool = False, cap_bottom: bool = False, a0: float = 0.0, a1: float = 2 * math.pi):
    """回転体。profile は (半径, 高さ) の並び（下から上）。three.js の Y 軸のまわり"""
    pr = np.asarray(profile, dtype=np.float64)
    full = abs((a1 - a0) - 2 * math.pi) < 1e-9
    nseg = segments if full else segments + 1
    ang = np.linspace(a0, a1, segments, endpoint=False) if full else np.linspace(a0, a1, nseg)
    c = np.asarray(center, dtype=np.float64)
    verts = []
    for r, y in pr:
        for a in ang:
            verts.append((c[0] + r * math.cos(a), c[1] + y, c[2] + r * math.sin(a)))
    faces = []
    m = len(pr)
    for i in range(m - 1):
        for k in range(nseg if full else nseg - 1):
            k2 = (k + 1) % nseg
            faces.append((i * nseg + k, (i + 1) * nseg + k, (i + 1) * nseg + k2, i * nseg + k2))
    verts = np.asarray(verts)
    if full and cap_bottom:
        verts = np.vstack([verts, c + [0, pr[0][1], 0]])
        ci = len(verts) - 1
        for k in range(nseg):
            faces.append((ci, k, (k + 1) % nseg))
    if full and cap_top:
        verts = np.vstack([verts, c + [0, pr[-1][1], 0]])
        ci = len(verts) - 1
        base = (m - 1) * nseg
        for k in range(nseg):
            faces.append((ci, base + (k + 1) % nseg, base + k))
    return verts, faces


def uv_sphere(center, radius, seg: int = 24, rings: int = 14, scale=(1.0, 1.0, 1.0)):
    c = np.asarray(center, dtype=np.float64)
    sc = np.asarray(scale, dtype=np.float64)
    verts = [c + np.array([0, radius, 0]) * sc]
    for i in range(1, rings):
        ph = math.pi * i / rings
        for k in range(seg):
            th = 2 * math.pi * k / seg
            verts.append(c + np.array([math.sin(ph) * math.cos(th), math.cos(ph), math.sin(ph) * math.sin(th)]) * radius * sc)
    verts.append(c - np.array([0, radius, 0]) * sc)
    faces = []
    for k in range(seg):
        faces.append((0, 1 + (k + 1) % seg, 1 + k))
    for i in range(rings - 2):
        b0 = 1 + i * seg
        b1 = 1 + (i + 1) * seg
        for k in range(seg):
            k2 = (k + 1) % seg
            faces.append((b0 + k, b0 + k2, b1 + k2, b1 + k))
    last = len(verts) - 1
    b0 = 1 + (rings - 2) * seg
    for k in range(seg):
        faces.append((last, b0 + k, b0 + (k + 1) % seg))
    return np.asarray(verts), faces


# ═══════════════════════════════════════════════════════════════════════
# 物との最短距離（RIDE-8 / MOTION.clearanceMin）
# ═══════════════════════════════════════════════════════════════════════
def world_verts_three(ob) -> np.ndarray:
    me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float64)
    me.vertices.foreach_get('co', co)
    m = np.array(ob.matrix_world, dtype=np.float64)
    w = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    return to_three(w)


def box_of(ob) -> tuple[np.ndarray, np.ndarray]:
    """three.js の Box3.setFromObject と同じ: 局所の箱の 8 隅を世界へ移した箱（three.js の座標）"""
    me = ob.data
    n = len(me.vertices)
    if n == 0:
        return np.zeros(3), np.zeros(3)
    co = np.empty(n * 3, dtype=np.float64)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    lo, hi = co.min(0), co.max(0)
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    m = np.array(ob.matrix_world, dtype=np.float64)
    w = to_three(corners @ m[:3, :3].T + m[:3, 3])
    return w.min(0), w.max(0)


def box_distance(lo, hi, pts: np.ndarray) -> np.ndarray:
    d = np.maximum(np.maximum(lo - pts, 0.0), pts - hi)
    return np.linalg.norm(d, axis=1)


def is_exempt(ob) -> bool:
    return bool(ob.get('clearance_exempt', False))


def clearance_report(objs, pts: np.ndarray, need: float = NEED, label: str = '') -> list[tuple[str, float]]:
    """箱がレールの点から need 未満の物（免除の物は除く）。[(名前, 最短距離)]"""
    bad = []
    for ob in objs:
        if ob.type != 'MESH' or is_exempt(ob) or len(ob.data.vertices) == 0:
            continue
        lo, hi = box_of(ob)
        d = float(box_distance(lo, hi, pts).min())
        if d < need:
            bad.append((ob.name, d))
    if bad:
        print(f'WARNING {label}: 物の箱がレールに近すぎる（必要 {need:.2f}m）: ' + ', '.join(f'{n}={d:.2f}' for n, d in bad[:20]))
    return bad


def true_clearance(ob, pts: np.ndarray) -> float:
    """物の面とレールの点の本当の最短距離（免除した物の確かめ用）"""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(ob, dg, deform=False)
    m = ob.matrix_world.inverted()
    best = 1e9
    for p in to_blender(pts):
        loc, _n, _i, dist = bvh.find_nearest(m @ Vector(p.tolist()))
        if loc is not None and dist < best:
            best = dist
    return best


def partition_for_clearance(ob, pts: np.ndarray, need: float = NEED, max_pieces: int = 64) -> list:
    """箱がレールに近い大きな物を、どの塊の箱もレールから need 以上離れるよう面の塊に分ける。

    src/rooms/testing.ts は物ごとの箱（軸に沿った直方体）で距離を測る。レールを囲む壁や頭上を渡るアーチは、
    面がレールから十分離れていても箱がレールを含んでしまうので、面を分けて塊ごとの物にする。
    1. 面の中心で、箱の長い軸の中央値で2つに割ることを繰り返す（箱が離れるか、小さくなるまで）。
    2. 割った塊を、合わせても箱が離れている限り同じ物にまとめ直す（物の数を減らす）。
    小さくなっても近い塊は本当に近い物なので、名前と距離を返す（呼ぶ側で直す）。
    """
    me = ob.data
    me.calc_loop_triangles()
    npoly = len(me.polygons)
    if npoly == 0:
        return [ob]
    lo0, hi0 = box_of(ob)
    if box_distance(lo0, hi0, pts).min() >= need:
        return [ob]
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    wv = to_three(co.reshape(-1, 3) @ np.array(ob.matrix_world)[:3, :3].T + np.array(ob.matrix_world)[:3, 3])
    # 面ごとの頂点の範囲
    loop_start = np.empty(npoly, dtype=np.int64)
    loop_total = np.empty(npoly, dtype=np.int64)
    me.polygons.foreach_get('loop_start', loop_start)
    me.polygons.foreach_get('loop_total', loop_total)
    lv = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', lv)
    flo = np.empty((npoly, 3))
    fhi = np.empty((npoly, 3))
    for i in range(npoly):
        vv = wv[lv[loop_start[i]:loop_start[i] + loop_total[i]]]
        flo[i] = vv.min(0)
        fhi[i] = vv.max(0)
    cen = (flo + fhi) / 2

    def clear(idx):
        lo = flo[idx].min(0)
        hi = fhi[idx].max(0)
        return box_distance(lo, hi, pts).min() >= need, lo, hi

    leaves: list[np.ndarray] = []
    bad: list[np.ndarray] = []
    stack = [np.arange(npoly)]
    while stack:
        idx = stack.pop()
        ok, lo, hi = clear(idx)
        if ok:
            leaves.append(idx)
            continue
        size = hi - lo
        if len(idx) < 2:
            bad.append(idx)
            continue
        # 長い軸から順に、面の中心の中央値で割る。中心がそろっていて割れない（長い柱と頭上の梁が同じ高さに
        # 中心を持つなど）ときは、その軸で並べて半分に分ける
        split = None
        for ax in np.argsort(-size):
            med = np.median(cen[idx, ax])
            left = idx[cen[idx, ax] <= med]
            right = idx[cen[idx, ax] > med]
            if len(left) and len(right):
                split = (left, right)
                break
        if split is None:
            order = idx[np.argsort(cen[idx, int(np.argmax(size))], kind='stable')]
            split = (order[: len(order) // 2], order[len(order) // 2:])
        stack.extend(split)
    # まとめ直す（大きい塊から）
    leaves.sort(key=lambda a: -len(a))
    groups: list[np.ndarray] = []
    for idx in leaves:
        placed = False
        for gi, g in enumerate(groups):
            cand = np.concatenate([g, idx])
            if clear(cand)[0]:
                groups[gi] = cand
                placed = True
                break
        if not placed:
            groups.append(idx)
    if bad:
        groups.extend(bad)
        lo = min(float(box_distance(flo[b].min(0), fhi[b].max(0), pts).min()) for b in bad)
        print(f'WARNING partition {ob.name}: 分けても近い面の塊 {len(bad)} 個（最短 {lo:.2f}m）')
    if len(groups) > max_pieces:
        print(f'WARNING partition {ob.name}: {len(groups)} 個に分かれた（上限 {max_pieces}）')
    if len(groups) == 1:
        return [ob]
    return split_object(ob, groups)


def split_object(ob, groups: list[np.ndarray]) -> list:
    """面の番号の組ごとに物を分ける。名前は <元の名前>.<番号>（元の名前に番号がなければ）"""
    base = ob.name
    parts = base.split('.')
    if len(parts) == 3 and parts[2].isdigit():
        base = '.'.join(parts[:2]) + '_' + parts[2]
    out = []
    coll = ob.users_collection[0]
    props = {k: ob[k] for k in ob.keys() if not k.startswith('_')}
    for gi, idx in enumerate(groups):
        me = ob.data.copy()
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        keep = np.zeros(len(bm.faces), dtype=bool)
        keep[idx] = True
        dead = [bm.faces[i] for i in range(len(bm.faces)) if not keep[i]]
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        loose = [v for v in bm.verts if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
        bm.to_mesh(me)
        bm.free()
        nob = bpy.data.objects.new(f'{base}.{gi + 1:03d}', me)
        nob.matrix_world = ob.matrix_world.copy()
        coll.objects.link(nob)
        for k, v in props.items():
            nob[k] = v
        out.append(nob)
    old = ob.data
    bpy.data.objects.remove(ob)
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return out


# ═══════════════════════════════════════════════════════════════════════
# インスタンス（同じ形をまとめて描く物）: 元の形を1つと、置く変換を extras に書く
# ═══════════════════════════════════════════════════════════════════════
#: three (x, y, z) = C · Blender (x, y, z)
_C = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])


def matrix_three(pos_three, rot_yaw: float = 0.0, tilt=(0.0, 0.0), scale=(1.0, 1.0, 1.0), pre=None) -> np.ndarray:
    """three.js の 4×4 の変換（列優先で Matrix4.fromArray に渡せる並び）。
    回転は Y（yaw）→ 傾き（X, Z）の順。pre（3×3）を先に掛けられる"""
    cy, sy = math.cos(rot_yaw), math.sin(rot_yaw)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    cx, sx = math.cos(tilt[0]), math.sin(tilt[0])
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    cz, sz = math.cos(tilt[1]), math.sin(tilt[1])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    r = ry @ rx @ rz @ np.diag(scale)
    if pre is not None:
        r = r @ pre
    m = np.eye(4)
    m[:3, :3] = r
    m[:3, 3] = pos_three
    return m


def instance_box(proto_lo, proto_hi, m4: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """元の形の箱（three.js の局所座標）を変換した箱（three.js の Box3.applyMatrix4 と同じ）"""
    corners = np.array([[x, y, z] for x in (proto_lo[0], proto_hi[0]) for y in (proto_lo[1], proto_hi[1]) for z in (proto_lo[2], proto_hi[2])])
    w = corners @ m4[:3, :3].T + m4[:3, 3]
    return w.min(0), w.max(0)


def proto_box(ob) -> tuple[np.ndarray, np.ndarray]:
    v = world_verts_three(ob)
    return v.min(0), v.max(0)


def write_instances(holder, kind: str, mats: list[np.ndarray]) -> None:
    """インスタンスの変換を extras に書く（three.js の Matrix4 の列優先、小数 4 桁）"""
    flat = []
    for m in mats:
        flat.extend(round(float(x), 4) for x in m.T.reshape(-1))
    holder[f'inst_{kind}'] = flat


# ═══════════════════════════════════════════════════════════════════════
# 仕上げ: モディファイアの適用 → 見えない面の削除 → 箱の検査と分割 → 焼き込み → 書き出し
# ═══════════════════════════════════════════════════════════════════════
def apply_modifiers(objs) -> None:
    for ob in objs:
        if ob.type != 'MESH' or not ob.modifiers:
            continue
        bpy.context.view_layer.objects.active = ob
        for mod in list(ob.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)


def tri_count(objs) -> int:
    n = 0
    for ob in objs:
        if ob.type == 'MESH':
            ob.data.calc_loop_triangles()
            n += len(ob.data.loop_triangles)
    return n


def finish_room(
    room: str,
    rail: Rail,
    objs: list,
    view_points_three: np.ndarray,
    clear_points_three: np.ndarray | None,
    bake_targets: list,
    *,
    size: int = 2048,
    samples: int = 256,
    extra_bakes: list | None = None,
    cull: bool = True,
    keep_unculled: tuple = (),
    percentile: float = 99.99,
    webp: int = 0,
) -> dict:
    """部屋の仕上げ。objs は書き出す物すべて（インスタンスの元の形と extras の入れ物を含む）。

    view_points_three: 見えない面の削除に使う視点の折れ線（three.js の座標）。区間の前後の余裕を含めて渡す。
    clear_points_three: 物との最短距離を守る区間のレールの点（None なら検査しない。待ち列）。
    bake_targets: 光を焼き込む物（不透明・インスタンスでない物）。焼き込みは物の分割の後。
    extra_bakes: [(名前の接尾辞, 準備の関数)] 別の光の状態のライトマップ（例: 朝）。焼いた物には
                 lightmap_<接尾辞> と lightmap_<接尾辞>_scale を残す（UV は同じ）。
    """
    t0 = time.time()
    report: dict = {'room': room}
    # 物の変換（location）を matrix_world に反映してから測る
    bpy.context.view_layer.update()
    apply_modifiers(objs)
    statics = [o for o in objs if o.type == 'MESH' and not o.get('role') == 'proto' and o.name not in keep_unculled]
    report['tris_before'] = tri_count(statics)
    if cull:
        rep = cull_hidden(statics, to_blender(view_points_three).tolist(), yaw_deg=LOOK_YAW, pitch_deg=LOOK_PITCH, head_radius=HEAD_RADIUS)
        print(f"cull: {room} {rep['before_tris']} → {rep['after_tris']} tris（面 {rep['removed_faces']} を削除、{rep['seconds']}s、光線 {rep['rays']}）")
        report['cull'] = {k: rep[k] for k in ('before_tris', 'after_tris', 'removed_faces', 'seconds')}
        for name in rep['emptied']:
            ob = bpy.data.objects.get(name)
            if ob is not None:
                print(f'cull: {name} は全部見えないので消す')
                if ob in objs:
                    objs.remove(ob)
                if ob in bake_targets:
                    bake_targets.remove(ob)
                bpy.data.objects.remove(ob)
        bpy.context.view_layer.update()
    # 箱の検査と分割（焼き込みの前。ライトマップは物ごとに付くので）
    if clear_points_three is not None:
        new_objs = []
        for ob in list(objs):
            if ob.type != 'MESH' or is_exempt(ob) or ob.get('role') == 'proto' or ob.get('no_split'):
                new_objs.append(ob)
                continue
            was_target = ob in bake_targets
            parts = partition_for_clearance(ob, clear_points_three)
            if len(parts) > 1:
                print(f'partition: {parts[0].name.rsplit(".", 1)[0]} → {len(parts)} 個')
                if was_target:
                    bake_targets.remove(ob)
                    bake_targets.extend(parts)
            new_objs.extend(parts)
        objs[:] = new_objs
        bad = clearance_report(objs, clear_points_three, label=room)
        report['clearance_bad'] = bad
        for ob in objs:
            if ob.type == 'MESH' and is_exempt(ob) and ob.get('check_true_clearance'):
                d = true_clearance(ob, clear_points_three)
                print(f'clearance（免除の物の面までの本当の距離）: {ob.name} = {d:.2f}m' + ('' if d >= NEED - CLEARANCE_SLACK else '  WARNING 近い'))
    report['tris_after'] = tri_count([o for o in objs if o.type == 'MESH' and o.get('role') != 'proto'])
    bad_names = check_names(objs, [room])
    if bad_names:
        raise RuntimeError(f'名前の規則に合わない物: {bad_names}')
    # 焼き込み（消した物を反映してから）
    bpy.context.view_layer.update()
    bake_targets[:] = [o for o in bake_targets if o.name in bpy.data.objects and len(o.data.polygons) > 0]
    tb = time.time()
    for suffix, prepare in extra_bakes or []:
        restore = prepare()
        res = bake_lightmaps(bake_targets, OUT_DIR, size=size, samples=samples, name=f'{room}.lightmap_{suffix}', percentile=percentile)
        for o in bake_targets:
            o[f'lightmap_{suffix}'] = o['lightmap']
            o[f'lightmap_{suffix}_scale'] = o['lightmap_scale']
        if restore:
            restore()
        report[f'bake_{suffix}'] = res[0]['scale'] if res else None
    res = bake_lightmaps(bake_targets, OUT_DIR, size=size, samples=samples, name=f'{room}.lightmap', percentile=percentile, repack=not extra_bakes)
    report['bake_seconds'] = round(time.time() - tb, 1)
    report['bake_scale'] = res[0]['scale'] if res else None
    if webp:
        keys = ['lightmap'] + [f'lightmap_{suffix}' for suffix, _ in (extra_bakes or [])]
        report['webp'] = lightmaps_to_webp(bake_targets, keys, webp)
    # 書き出し
    glb = os.path.join(OUT_DIR, f'{room}.glb')
    with emission_clamped(objs):
        size_b = export_glb(objs, glb, rooms=[room])
    load = room_load_report(objs, glb, OUT_DIR)
    report['glb_bytes'] = size_b
    # 部屋が読むすべての外の画像（ライトマップの別の光の状態と、反射用の環境画像も）
    files = sorted({str(o[k]) for o in objs for k in o.keys() if (k.startswith('lightmap') and not k.endswith('_scale')) or k.startswith('env')})
    sizes = {f: os.path.getsize(os.path.join(OUT_DIR, f)) for f in files if os.path.exists(os.path.join(OUT_DIR, f))}
    report['files'] = sizes
    report['load_bytes'] = size_b + sum(sizes.values())
    report['lightmaps'] = load['lightmaps']
    if report['load_bytes'] > MAX_ROOM_BYTES:
        print(f"WARNING: 部屋の読み込みの合計 {report['load_bytes']}B が上限 {MAX_ROOM_BYTES}B を超えています")
    report['objects'] = len([o for o in objs if o.type == 'MESH'])
    report['seconds'] = round(time.time() - t0, 1)
    print('REPORT ' + json.dumps(report, ensure_ascii=False, default=str))
    return report


def lightmaps_to_webp(objs, keys: list[str], quality: int) -> dict:
    """焼いた 8bit の sRGB PNG を、同じ画素の WebP（非可逆、quality）に書き直し、物の extras の名前を差し替えて PNG を消す。
    部屋の読み込みの大きさ（初回は待ち列と乗り場で 10MB 以下）を抑えるため。画素の値はそのまま（色の変換をしない）"""
    out = {}
    names = sorted({o[k] for o in objs for k in keys if o.get(k)})
    for name in names:
        src = os.path.join(OUT_DIR, name)
        dst_name = os.path.splitext(name)[0] + '.webp'
        dst = os.path.join(OUT_DIR, dst_name)
        img = bpy.data.images.load(src, check_existing=False)
        img.colorspace_settings.name = 'Non-Color'  # 画素を変換せずに書く（色の管理を通さない）
        # Image.save は形式を変えない（PNG のまま書く）ので、場面の画像の設定で save_render する
        st = bpy.context.scene.render.image_settings
        vs = bpy.context.scene.view_settings
        keep = (st.file_format, st.quality, st.color_mode, vs.view_transform)
        try:
            st.file_format = 'WEBP'
            st.quality = quality
            st.color_mode = 'RGB'
            vs.view_transform = 'Standard'
            img.save_render(dst, scene=bpy.context.scene)
        finally:
            st.file_format, st.quality, st.color_mode, vs.view_transform = keep
        bpy.data.images.remove(img)
        with open(dst, 'rb') as fh:
            head = fh.read(16)
        if head[:4] != b'RIFF' or head[8:12] != b'WEBP':
            raise RuntimeError(f'WebP になっていない: {dst}')
        before = os.path.getsize(src)
        os.remove(src)
        out[dst_name] = {'png': before, 'webp': os.path.getsize(dst)}
        print(f'webp: {name} {before}B → {dst_name} {os.path.getsize(dst)}B（quality {quality}）')
        for o in objs:
            for k in keys:
                if o.get(k) == name:
                    o[k] = dst_name
    return out


class emission_clamped:
    """書き出しのあいだだけ、発光の強さを 1 以下にする（1 を超えると書き出しが KHR_materials_emissive_strength を使い、
    node のテストの GLTFLoader で読めない。発光の物は TS がガラスの発光に差し替えるので、glb の値は使わない）"""

    def __init__(self, objs):
        self.objs = objs
        self.saved = []

    def __enter__(self):
        mats = {s.material for o in self.objs if o.type == 'MESH' for s in o.material_slots if s.material}
        for m in mats:
            if not m.node_tree:
                continue
            for n in m.node_tree.nodes:
                key = 'Strength' if n.type == 'EMISSION' else 'Emission Strength' if n.type == 'BSDF_PRINCIPLED' else None
                if key and n.inputs[key].default_value > 1.0:
                    self.saved.append((n.inputs[key], n.inputs[key].default_value))
                    n.inputs[key].default_value = 1.0
        return self

    def __exit__(self, *exc):
        for sock, v in self.saved:
            sock.default_value = v
        return False


def render_env(name: str, pos_three, size: tuple[int, int] = (512, 256), samples: int = 48, exposure: float = 0.0) -> str:
    """部屋の中の1点から、反射用の環境画像（正距円筒、8bit の sRGB PNG）を Cycles で撮る（設計書「焼き込み」）。

    three.js の正距円筒の反射（EquirectangularReflectionMapping）と向きを合わせる: 画像の中央が +X（three.js）、
    右へ行くと +Z（three.js）、上が上。カメラは Blender の +X を向け、上を +Z にする。
    戻り値は out_dir からの名前（例 platform.env.png）。読む側は flipY = true（画像の上が上）。
    """
    scene = bpy.context.scene
    keep = (scene.camera, scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage, scene.render.engine,
            scene.view_settings.view_transform, scene.view_settings.exposure, scene.render.filepath)
    cam_data = bpy.data.cameras.new(f'{name}.cam')
    cam_data.type = 'PANO'
    cam_data.panorama_type = 'EQUIRECTANGULAR'
    cam = bpy.data.objects.new(f'{name}.cam', cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = tuple(to_blender(np.asarray(pos_three, dtype=np.float64)).tolist())
    cam.rotation_euler = (math.pi / 2, 0.0, -math.pi / 2)
    path = os.path.join(OUT_DIR, f'{name}.png')
    try:
        scene.camera = cam
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
        scene.render.resolution_x, scene.render.resolution_y = size
        scene.render.resolution_percentage = 100
        scene.view_settings.view_transform = 'Standard'
        scene.view_settings.exposure = exposure
        scene.render.image_settings.file_format = 'PNG'
        scene.render.image_settings.color_depth = '8'
        scene.render.image_settings.color_mode = 'RGB'
        scene.render.filepath = path
        t0 = time.time()
        bpy.ops.render.render(write_still=True)
        print(f'env: {name} {size[0]}x{size[1]} {samples}spp {os.path.getsize(path)}B {time.time() - t0:.1f}s -> {path}')
    finally:
        (scene.camera, scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage, scene.render.engine,
         scene.view_settings.view_transform, scene.view_settings.exposure, scene.render.filepath) = keep
        bpy.data.objects.remove(cam)
        bpy.data.cameras.remove(cam_data)
    return os.path.basename(path)


def save_blend(room: str) -> None:
    os.makedirs(SCENES, exist_ok=True)
    path = os.path.join(SCENES, f'{room}.blend')
    # 上書きのときに .blend1 の控えを作らない
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=True)
    print(f'saved {path}')


def fast_mode() -> bool:
    return '--fast' in script_args()


# ═══════════════════════════════════════════════════════════════════════
# 乗り場のホールの配置（lobby.py と greenhouse.py も使う）
# ═══════════════════════════════════════════════════════════════════════
#: 水面の高さ。ゴンドラの底（中心 1.2m − 半径 1.2m = 0）が少し沈む
WATER_Y = 0.06
#: 桟橋と回廊の床の高さ
DECK_Y = 0.32
#: 壁の厚み
WALL_T = 0.7
#: 壁の高さ（天井のドームの始まり）とドームの頂
WALL_H = 13.5
DOME_TOP = 21.0
#: 北の門（乗り場 → 温室の膜）の開口の半径と、真鍮の輪の半径
GATE_OPEN_R = 3.35
GATE_RING_R = 3.05
#: 東の水門（夜明けの岸 → 降車）の水路の半幅と天井の高さ、水路の東の端（膜より少し外）
CANAL_HALF = 3.3
CANAL_TOP = 5.4
#: 南の入口（待ち列のアーチへ）の開口
SOUTH_DOOR_HALF = 2.3
SOUTH_DOOR_TOP = 5.6


def solve_hall(rail: Rail) -> dict:
    """北の門と東の水門の2点を内壁の円の上（壁の厚みの中央）に置き、始点（桟橋の先）が壁から 6m ほど内側に来る中心。

    2点の垂直二等分線の上で中心を動かし、始点と壁の距離が 6.2m になる所を選ぶ。
    """
    north = rail.point(rail.sections['platform'][1])
    east = rail.point(rail.sections['departure'][0])
    start = rail.point(0.0)
    g = np.array([north[0], north[2]])
    d = np.array([east[0], east[2]])
    s = np.array([start[0], start[2]])
    mid = (g + d) / 2
    gd = d - g
    perp = np.array([gd[1], -gd[0]]) / np.linalg.norm(gd)
    best = None
    for k in np.linspace(-20, 20, 4001):
        c = mid + perp * k
        r = np.linalg.norm(g - c)
        margin = r - np.linalg.norm(s - c)
        if best is None or abs(margin - 6.2) < abs(best[2] - 6.2):
            best = (c, r, margin)
    c, r, margin = best
    # 2点は壁の厚みの中央。内壁はその内側
    return {
        'cx': float(c[0]),
        'cz': float(c[1]),
        'r_mid': float(r),
        'r_in': float(r - WALL_T / 2),
        'r_out': float(r + WALL_T / 2),
        'north': north,
        'east': east,
        'start': start,
    }


def hall_point(h: dict, ang: float, r: float, y: float) -> np.ndarray:
    """ホールの中心からの角度 ang（+X から +Z の向き）と半径 r の点"""
    return np.array([h['cx'] + r * math.cos(ang), y, h['cz'] + r * math.sin(ang)])


def hall_angle(h: dict, p) -> float:
    return math.atan2(p[2] - h['cz'], p[0] - h['cx'])


# ═══════════════════════════════════════════════════════════════════════
# 乗り場の造形
# ═══════════════════════════════════════════════════════════════════════
_uv_sphere = uv_sphere
_lathe = lathe

#: 吊られた泡の8種（元の形の名前）。触れられる泡と飾りの泡で同じ形を使う
BUBBLE_KINDS = ('round', 'twin', 'trio', 'drop', 'ringed', 'nested', 'lantern', 'pearl')


def bubble_shape(kind: str, r: float = 1.0, detail: float = 1.0):
    """泡の形（中心が原点、吊る点は上 +r）。頂点と面。detail は分割の細かさの倍率（飾りのインスタンスは粗く）"""
    b = Builder()

    def uv_sphere(c, rr, seg, rings, scale=(1.0, 1.0, 1.0)):
        return _uv_sphere(c, rr, max(12, int(seg * detail)), max(8, int(rings * detail)), scale)

    def lathe(prof, seg):
        return _lathe(prof, max(12, int(seg * detail)))
    if kind == 'round':
        b.add(*uv_sphere((0, 0, 0), r, 40, 24))
    elif kind == 'twin':
        b.add(*uv_sphere((0, 0, 0), r, 36, 22))
        b.add(*uv_sphere((0.55 * r, -0.85 * r, 0.1 * r), 0.62 * r, 28, 18))
    elif kind == 'trio':
        b.add(*uv_sphere((0, 0, 0), 0.8 * r, 32, 20))
        b.add(*uv_sphere((-0.62 * r, -0.72 * r, 0.25 * r), 0.55 * r, 26, 16))
        b.add(*uv_sphere((0.5 * r, -1.0 * r, -0.3 * r), 0.42 * r, 24, 14))
    elif kind == 'drop':
        # 雫形: 上が細く下が丸い回転体
        prof = []
        for i in range(25):
            a = math.pi * i / 24  # 0 下 → π 上
            y = -math.cos(a) * r * 1.25
            rad = math.sin(a) * r * (0.55 + 0.45 * (1 - i / 24) ** 0.7)
            prof.append((max(rad, 1e-4), y))
        b.add(*lathe(prof, 40))
    elif kind == 'ringed':
        b.add(*uv_sphere((0, 0, 0), r, 40, 24))
    elif kind == 'nested':
        b.add(*uv_sphere((0, 0, 0), r, 40, 24))
        b.add(*uv_sphere((0.15 * r, -0.2 * r, 0.05 * r), 0.45 * r, 24, 14))
    elif kind == 'lantern':
        b.add(*uv_sphere((0, 0, 0), r, 40, 24, scale=(1.0, 1.18, 1.0)))
    elif kind == 'pearl':
        # 小さな泡の連なり（縦）
        for i, (rr, yy) in enumerate(((0.55, 0.0), (0.42, -0.95), (0.32, -1.68), (0.24, -2.22))):
            b.add(*uv_sphere((0.06 * i * r, yy * r, 0), rr * r, 24, 14))
    v = np.concatenate(b.v)
    return v, b.f


def bubble_ring(kind: str, r: float):
    """真鍮の飾りの輪（ringed と lantern）。泡の局所座標"""
    if kind == 'ringed':
        a = np.linspace(0, 2 * np.pi, 64, endpoint=False)
        path = np.stack([np.cos(a) * r * 1.02, np.zeros_like(a), np.sin(a) * r * 1.02], axis=1)
        return tube(path, 0.012 * max(1.0, r), 6, caps=False, closed=True)
    if kind == 'lantern':
        a = np.linspace(0, 2 * np.pi, 48, endpoint=False)
        path = np.stack([np.cos(a) * r * 0.32, np.full_like(a, r * 1.15), np.sin(a) * r * 0.32], axis=1)
        return tube(path, 0.01 * max(1.0, r), 6, caps=False, closed=True)
    return None


def build_platform(rail: Rail, fast: bool) -> None:
    reset_scene()
    rng = random.Random(20261021)
    coll = collection('platform')
    h = solve_hall(rail)
    print(f"hall: 中心 ({h['cx']:.2f}, {h['cz']:.2f}) 内壁 {h['r_in']:.2f}m 外壁 {h['r_out']:.2f}m")
    cx, cz, r_in = h['cx'], h['cz'], h['r_in']
    objs: list = []
    bake: list = []

    s_plat1 = rail.sections['platform'][1]
    s_dep0 = rail.sections['departure'][0]
    north, east = h['north'], h['east']
    start = h['start']
    a_south = hall_angle(h, np.array([start[0], 0, start[2] + 10]))  # 桟橋の向き
    # 降車のレールは南の壁沿いを通る（水平の距離で床や柱を避ける）
    dep_path = rail.samples(*rail.span('departure', before=2.0), 0.25)

    # ── 材質（色は sRGB。base color は TS でもそのまま使う） ──
    m_plaster = material('platform.plaster', '#8792a2', 0.85)
    m_plaster_dark = material('platform.plaster_dark', '#636e7f', 0.85)
    m_stone = material('platform.stone', '#a9aeb5', 0.7)
    m_brass = material('platform.brass', '#b8925a', 0.35, metallic=1.0)
    m_water = material('platform.water', '#0d1824', 0.08)
    m_glass = material('platform.glass', '#dfe8f2', 0.05, alpha=0.15)

    # 材質ごとにまとめる（物の数 = 描く回数を減らす。レールに近い物は後で塊に分ける）
    plaster = Builder()
    plaster_dark = Builder()
    stone = Builder()
    brass = Builder()

    # ── 壁（内側の面だけ。外は見えない）と腰と蛇腹 ──
    seg = 200
    rows = 26
    ang = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    ys = np.linspace(DECK_Y - 0.5, WALL_H, rows)
    verts = np.array([[cx + r_in * math.cos(a), y, cz + r_in * math.sin(a)] for y in ys for a in ang])
    faces = []
    for j in range(rows - 1):
        for i in range(seg):
            i2 = (i + 1) % seg
            # 内側を向く面（上 × 角度の向き は外向きなので逆に回す）
            faces.append((j * seg + i, j * seg + i2, (j + 1) * seg + i2, (j + 1) * seg + i))
    keep = openings_keep(verts, faces, h, rail, windows=True)
    plaster.add(verts, [f for f, k in zip(faces, keep) if k])
    v, f = lathe([(r_in - 0.02, DECK_Y - 0.4), (r_in - 0.12, DECK_Y - 0.2), (r_in - 0.12, DECK_Y + 1.0), (r_in - 0.03, DECK_Y + 1.15)], seg, (cx, 0, cz))
    f = [tuple(reversed(x)) for x in f]
    keep = openings_keep(v, f, h, rail)
    plaster_dark.add(v, [x for x, k in zip(f, keep) if k])
    v, f = lathe([(r_in - 0.02, WALL_H - 0.9), (r_in - 0.35, WALL_H - 0.75), (r_in - 0.45, WALL_H - 0.45), (r_in - 0.8, WALL_H - 0.1), (r_in - 0.8, WALL_H + 0.05)], seg, (cx, 0, cz))
    plaster.add(v, [tuple(reversed(x)) for x in f])

    # ── ドーム: 壁の上から頂へ。頂に乳白の丸窓（オクルス） ──
    dome_r = r_in - 0.8
    oculus_r = 3.2
    prof = []
    for i in range(36):
        a = (math.pi / 2) * i / 35
        rr = dome_r * math.cos(a)
        if rr < oculus_r:
            break
        prof.append((rr, WALL_H + 0.05 + (DOME_TOP - WALL_H) * math.sin(a)))
    v, f = lathe(prof, 160, (cx, 0, cz))
    f = [tuple(reversed(x)) for x in f]
    # ドームの中ほどの帯はガラス（夜明け前は藍の空がにじみ、朝は光が差し込む）。帯の面は漆喰から外してガラスの物へ
    radial = np.array([math.hypot(*(v[list(x)].mean(0) - [cx, 0, cz])[[0, 2]]) for x in f])
    band = (radial > DOME_GLASS[0] * dome_r) & (radial < DOME_GLASS[1] * dome_r)
    plaster.add(v, [x for x, b in zip(f, band) if not b])
    ob = mesh_object('platform.dome_glass', v, [x for x, b in zip(f, band) if b], m_glass, coll,
                     props={'glass': 'clear', 'glass_color': '#c9d8ec', 'glass_opacity': 0.1, 'clearance_exempt': True})
    objs.append(ob)
    dome_y_at = lambda rr: WALL_H + 0.05 + (DOME_TOP - WALL_H) * math.sqrt(max(0.0, 1 - (rr / dome_r) ** 2))  # noqa: E731
    top_y = prof[-1][1]
    top_r = prof[-1][0]
    v, f = lathe([(top_r + 0.05, top_y), (top_r * 0.6, top_y + 0.35), (0.01, top_y + 0.5)], 64, (cx, 0, cz))
    ob = mesh_object('platform.oculus', v, [tuple(reversed(x)) for x in f], m_glass, coll,
                     props={'glass': 'milky', 'glass_color': '#7d8ca4', 'glass_opacity': 0.5, 'glass_emissive': '#8ea6cc', 'glass_emissive_intensity': 0.3, 'clearance_exempt': True})
    objs.append(ob)

    # ドームの真鍮のリブ（放射状に24本）と、オクルスの真鍮の輪
    for k in range(24):
        a = 2 * math.pi * k / 24
        path = []
        for i in range(24):
            rr = dome_r - 0.05 - (dome_r - top_r - 0.1) * i / 23
            path.append((cx + rr * math.cos(a), dome_y_at(rr) - 0.06, cz + rr * math.sin(a)))
        brass.add(*tube(np.array(path), 0.07, 6, caps=False))
    a = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    for rr, at_top in ((top_r + 0.05, True), (dome_r * DOME_GLASS[1], False), (dome_r * DOME_GLASS[0], False), (dome_r * (DOME_GLASS[0] + DOME_GLASS[1]) / 2, False)):
        yy = (top_y - 0.08) if at_top else dome_y_at(rr) - 0.08
        path = np.stack([cx + rr * np.cos(a), np.full_like(a, yy), cz + rr * np.sin(a)], axis=1)
        brass.add(*tube(path, 0.09 if at_top else 0.06, 8, caps=False, closed=True))

    # ── 柱: 壁沿いの細い真鍮の柱。開口の前と、降車のレールのそばには立てない ──
    for k in range(24):
        a = 2 * math.pi * (k + 0.5) / 24
        p = hall_point(h, a, r_in - 0.35, 0)
        if near_opening(h, rail, p, 2.2) or horizontal_distance(dep_path, p) < 3.4:
            continue
        brass.add(*tube(np.array([[p[0], DECK_Y, p[2]], [p[0], WALL_H - 0.85, p[2]]]), 0.11, 10))
        for yy, rr in ((DECK_Y + 0.12, 0.17), (WALL_H - 1.0, 0.16)):
            ca = np.linspace(0, 2 * np.pi, 20, endpoint=False)
            ring = np.stack([p[0] + rr * np.cos(ca), np.full(20, yy), p[2] + rr * np.sin(ca)], axis=1)
            brass.add(*tube(ring, 0.035, 6, caps=False, closed=True))

    # ── 床: 水面（ホールいっぱい）、回廊（壁沿い）、桟橋（南の入口から始点の手前まで） ──
    v, f = lathe([(0.0, WATER_Y), (r_in + 0.1, WATER_Y)], 160, (cx, 0, cz))
    ob = mesh_object('platform.water', v, [tuple(reversed(x)) for x in f], m_water, coll, smooth=False,
                     props={'role': 'water', 'clearance_exempt': True})
    objs.append(ob)
    walk_w = 2.2
    for prof, b in (([(r_in - walk_w + 0.15, DECK_Y), (r_in + 0.05, DECK_Y)], stone),
                    ([(r_in - walk_w, DECK_Y - 0.3), (r_in - walk_w, DECK_Y - 0.02), (r_in - walk_w + 0.02, DECK_Y), (r_in - walk_w + 0.15, DECK_Y)], plaster_dark)):
        v, f = lathe(prof, seg, (cx, 0, cz))
        f = [tuple(reversed(x)) for x in f]
        keep = openings_keep(v, f, h, rail, canal_only=True)
        # 降車のレールのそば（水平 2.7m 以内）は回廊を切る（ゴンドラは南の壁沿いの水面を進む）
        cen = np.array([v[list(x)].mean(0) for x in f])
        keep &= np.array([horizontal_distance(dep_path, c) >= 2.7 for c in cen])
        b.add(v, [x for x, k in zip(f, keep) if k])
    # 回廊の縁の真鍮の低い手すり（回廊が切れる所では切る）
    for a0, a1 in balustrade_arcs(h, rail):
        aa = np.linspace(a0, a1, max(8, int((a1 - a0) * 60)))
        pts = np.stack([cx + (r_in - walk_w + 0.12) * np.cos(aa), np.full_like(aa, DECK_Y + 0.95), cz + (r_in - walk_w + 0.12) * np.sin(aa)], axis=1)
        ok = np.array([horizontal_distance(dep_path, q) >= 3.0 for q in pts])
        for run in runs(ok):
            if len(run) < 3:
                continue
            seg_pts = pts[run]
            brass.add(*tube(seg_pts, 0.025, 6))
            for q in seg_pts[::4]:
                brass.add(*tube(np.array([[q[0], DECK_Y, q[2]], [q[0], DECK_Y + 0.95, q[2]]]), 0.012, 5, caps=False))

    # 桟橋: 南の入口から始点の手前（ゴンドラの殻から少し離す）。先が丸い板
    pier_tip = start[2] + GONDOLA_R + 0.75
    pier_end = hall_point(h, a_south, r_in + 0.1, 0)[2]
    stone.add(*rounded_slab(-1.55, 1.55, pier_tip, pier_end, DECK_Y, 0.35))
    tip_arc = np.linspace(math.pi, 2 * math.pi, 32)
    path = np.stack([np.cos(tip_arc) * 1.45, np.full_like(tip_arc, DECK_Y + 0.02), pier_tip + 1.55 + np.sin(tip_arc) * 1.45], axis=1)
    brass.add(*tube(path, 0.03, 6))
    for side in (-1, 1):
        brass.add(*tube(np.array([[side * 1.42, DECK_Y + 0.9, pier_tip + 1.6], [side * 1.42, DECK_Y + 0.9, pier_end - 0.3]]), 0.025, 6))
        for z in np.arange(pier_tip + 1.6, pier_end - 0.2, 0.6):
            brass.add(*tube(np.array([[side * 1.42, DECK_Y, z], [side * 1.42, DECK_Y + 0.9, z]]), 0.014, 5, caps=False))

    # ── 北の門: 真鍮の丸い門（膜は TS が張る）。開口のまわりに3重の輪と放射の飾り ──
    gfwd = rail.forward(s_plat1)
    gright = np.array([-gfwd[2], 0.0, gfwd[0]])
    gup = np.array([0.0, 1.0, 0.0])
    a = np.linspace(0, 2 * np.pi, 128, endpoint=False)
    for rr, off, thick in ((GATE_RING_R, 0.0, 0.085), (GATE_RING_R + 0.22, -0.12, 0.05), (GATE_RING_R + 0.42, -0.22, 0.035)):
        path = north[None, :] + gfwd[None, :] * off + (np.cos(a)[:, None] * gright[None, :] + np.sin(a)[:, None] * gup[None, :]) * rr
        brass.add(*tube(path, thick, 10, caps=False, closed=True))
    for k in range(32):
        aa = 2 * math.pi * k / 32
        d = math.cos(aa) * gright + math.sin(aa) * gup
        brass.add(*tube(np.array([north + d * (GATE_RING_R + 0.09), north + d * (GATE_RING_R + 0.42) - gfwd * 0.2]), 0.014, 5))
    plaster_dark.add(*gate_reveal(north, gfwd, gright, GATE_OPEN_R, WALL_T + 0.9))
    # 門のまわりの縁（壁の格子の穴のぎざぎざを隠す輪。ホールの側を向く）
    ca = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    ring_dir = np.cos(ca)[:, None] * gright[None, :] + np.sin(ca)[:, None] * gup[None, :]
    face_c = north + gfwd * (-(WALL_T + 0.9) * 0.5)
    inner = face_c[None, :] + ring_dir * GATE_OPEN_R
    outer = face_c[None, :] + ring_dir * (GATE_OPEN_R + 1.15)
    cv = np.vstack([inner, outer])
    cf = []
    for i in range(96):
        i2 = (i + 1) % 96
        q = (i, i2, 96 + i2, 96 + i)
        nrm = np.cross(cv[q[1]] - cv[q[0]], cv[q[2]] - cv[q[0]])
        cf.append(q if np.dot(nrm, -gfwd) > 0 else tuple(reversed(q)))
    plaster_dark.add(cv, cf)
    brass.add(*tube(outer + gfwd * -0.02, 0.05, 8, caps=False, closed=True))

    # ── 南の入口（待ち列のアーチへ）: 壁の厚みのアーチの通路、ホール側の縁、乳白のガラスの扉2枚 ──
    # 待ち列はレールの始点の真後ろに一直線に置く（lobby.py と TS の lobbyViews が同じ距離を使う）。
    # 入口の通路も同じ向きにして、内壁から待ち列の始まり（LOBBY_ORIGIN）までをつなぐ
    door_c, door_out = south_door(h, rail)
    door_side = np.array([-door_out[2], 0, door_out[0]])
    outline = arch_outline(SOUTH_DOOR_HALF, SOUTH_DOOR_TOP, DECK_Y - 0.05, 48)
    depth = LOBBY_ORIGIN - float(np.dot(door_c - start, door_out)) + 0.05
    if depth < WALL_T + 0.2:
        raise RuntimeError(f'入口の通路が壁より短い（{depth:.2f}m）。LOBBY_ORIGIN を見直す')
    rv, rf = [], []
    for k, (x, y) in enumerate(outline):
        for t in (-0.05, depth):
            rv.append(door_c + door_side * x + np.array([0, y, 0]) + door_out * t)
    for k in range(len(outline) - 1):
        a0, a1 = 2 * k, 2 * (k + 1)
        q = (a0, a1, a1 + 1, a0 + 1)
        c_face = np.mean([rv[i] for i in q], axis=0)
        nrm = np.cross(rv[q[1]] - rv[q[0]], rv[q[2]] - rv[q[0]])
        to_axis = (door_c + np.array([0, SOUTH_DOOR_TOP * 0.45, 0]) + door_out * depth * 0.5) - c_face
        to_axis -= door_out * np.dot(to_axis, door_out)
        rf.append(q if np.dot(nrm, to_axis) > 0 else tuple(reversed(q)))
    plaster_dark.add(np.array(rv), rf)
    # 通路の床（桟橋から待ち列の始まりまで）
    fl = [door_c - door_out * 0.6 - door_side * SOUTH_DOOR_HALF, door_c - door_out * 0.6 + door_side * SOUTH_DOOR_HALF,
          door_c + door_out * depth + door_side * SOUTH_DOOR_HALF, door_c + door_out * depth - door_side * SOUTH_DOOR_HALF]
    fl = np.array([p + [0, DECK_Y, 0] for p in fl])
    nrm = np.cross(fl[1] - fl[0], fl[2] - fl[0])
    stone.add(fl, [(0, 1, 2, 3) if nrm[1] > 0 else (3, 2, 1, 0)])
    # ホール側の縁（壁の格子の穴のぎざぎざを隠す）
    outer = arch_outline(SOUTH_DOOR_HALF + 0.85, SOUTH_DOOR_TOP + 0.85, DECK_Y - 0.05, 48)
    cv = [door_c + door_side * x + np.array([0, y, 0]) - door_out * 0.04 for x, y in outline] + [door_c + door_side * x + np.array([0, y, 0]) - door_out * 0.04 for x, y in outer]
    n_o = len(outline)
    cf = []
    for k in range(n_o - 1):
        q = (k, k + 1, n_o + k + 1, n_o + k)
        nrm = np.cross(cv[q[1]] - cv[q[0]], cv[q[2]] - cv[q[0]])
        cf.append(q if np.dot(nrm, -door_out) > 0 else tuple(reversed(q)))
    plaster_dark.add(np.array(cv), cf)
    brass.add(*tube(np.array(cv[n_o:]) - door_out * 0.02, 0.05, 8))
    brass.add(*tube(np.array(cv[:n_o]) - door_out * 0.03, 0.04, 8))
    # 扉: 左右2枚。蝶番（外の縁）を原点にして、TS が開け閉めする（乗車の頭は開いていて、走り出すと閉まる）
    m_door = material('platform.door_glass', '#f3e6d2', 0.3, alpha=0.4)
    door_y0 = DECK_Y
    for side, label in ((-1, 1), (1, 2)):
        hinge = door_c + door_side * side * (SOUTH_DOOR_HALF - 0.04) + door_out * (depth - 0.25)
        # 半分の形: 中心の下 → 外の下 → 外の縦の縁 → アーチの半分 → 中心の上（左右で同じ回り方にする）
        spring = SOUTH_DOOR_TOP - SOUTH_DOOR_HALF
        half_outline = [(0.0, door_y0), (side * SOUTH_DOOR_HALF, door_y0), (side * SOUTH_DOOR_HALF, spring)]
        for i in range(1, 24):
            a = math.pi / 2 * i / 24
            half_outline.append((side * SOUTH_DOOR_HALF * math.cos(a), spring + SOUTH_DOOR_HALF * math.sin(a)))
        half_outline.append((0.0, SOUTH_DOOR_TOP))
        poly = [door_c + door_side * x + np.array([0, max(y, door_y0), 0]) + door_out * (depth - 0.25) for x, y in half_outline]
        poly = np.array(poly)
        cen = poly.mean(0)
        dv = np.vstack([cen, poly])
        df = []
        for i in range(len(poly)):
            q = (0, 1 + i, 1 + (i + 1) % len(poly))
            nrm = np.cross(dv[q[1]] - dv[q[0]], dv[q[2]] - dv[q[0]])
            df.append(q if np.dot(nrm, -door_out) > 0 else tuple(reversed(q)))
        ob = mesh_object(f'platform.door.{label:03d}', dv, df, m_door, coll, smooth=False, origin=hinge,
                         props={'glass': 'milky', 'glass_color': '#a89e90', 'glass_opacity': 0.5, 'glass_emissive': '#ffcf98', 'glass_emissive_intensity': 0.22,
                                'role': 'door_leaf', 'hinge_side': side, 'door_axis': [round(float(x), 4) for x in door_out], 'no_split': True})
        objs.append(ob)
        frame = np.vstack([poly, poly[:1]])
        fr = mesh_object(f'platform.door_frame.{label:03d}', *tube(frame, 0.035, 6), m_brass, coll, origin=hinge, props={'brass': True, 'frame_of': ob.name, 'no_split': True})
        objs.append(fr)

    # ── 東の水路: 壁から外へ。両側の壁と円い天井、ホール側の口に真鍮の縁 ──
    dfwd = rail.forward(s_dep0)  # 西向き（ホールの中へ）
    dright = np.array([-dfwd[2], 0.0, dfwd[0]])
    canal_in = east - dfwd * (WALL_T * 0.5)
    canal_len = 7.5
    plaster_dark.add(*canal_shell(canal_in, dfwd, dright, canal_len))
    mouth = canal_in + dfwd * canal_len
    brass.add(*tube(canal_arch_path(mouth, dright, CANAL_HALF - 0.05, CANAL_TOP - 0.05), 0.07, 8))

    # ── 高窓: 壁の上の丸窓。ガラスは TS、焼き込みでは光を通す ──
    win = Builder()
    for c, n_in, t_dir in window_centers(h, rail):
        wr = WINDOW_R
        disc_a = np.linspace(0, 2 * np.pi, 40, endpoint=False)
        ring = c[None, :] + (np.cos(disc_a)[:, None] * t_dir[None, :] + np.sin(disc_a)[:, None] * gup[None, :]) * wr
        vv = np.vstack([c, ring])
        ff = [(0, 1 + (i + 1) % 40, 1 + i) if np.dot(np.cross(ring[(i + 1) % 40] - c, ring[i] - c), n_in) > 0 else (0, 1 + i, 1 + (i + 1) % 40) for i in range(40)]
        win.add(vv, ff)
        # 窓のまわりの縁（壁の格子で開けた穴のぎざぎざを隠す、濃い色の輪）
        outer = c[None, :] + (np.cos(disc_a)[:, None] * t_dir[None, :] + np.sin(disc_a)[:, None] * gup[None, :]) * (wr + 0.62) + n_in * 0.03
        inner = ring + n_in * 0.03
        av = np.vstack([inner, outer])
        af = []
        for i in range(40):
            i2 = (i + 1) % 40
            q = (i, i2, 40 + i2, 40 + i)
            nrm = np.cross(av[q[1]] - av[q[0]], av[q[2]] - av[q[0]])
            af.append(q if np.dot(nrm, n_in) > 0 else tuple(reversed(q)))
        plaster_dark.add(av, af)
        brass.add(*tube(ring + n_in * 0.04, 0.06, 8, caps=False, closed=True))
        brass.add(*tube(outer + n_in * 0.01, 0.035, 6, caps=False, closed=True))
        brass.add(*tube(np.array([c - t_dir * wr, c + t_dir * wr]) + n_in * 0.03, 0.025, 5))
        brass.add(*tube(np.array([c - gup * wr, c + gup * wr]) + n_in * 0.03, 0.025, 5))
    ob = win.build('platform.windows', m_glass, coll, smooth=False,
                   props={'glass': 'clear', 'glass_color': '#cfdcec', 'glass_opacity': 0.12, 'clearance_exempt': True})
    objs.append(ob)

    # ── 天井の乳白の灯り: ドームの中ほどに12の大きな乳白の玉（焼き込みの光源。TS は乳白の発光のガラス） ──
    lamp_v = Builder()
    lamp_r = 0.62
    lamp_centers = []
    for k in range(12):
        a = 2 * math.pi * (k + 0.5) / 12
        rr = dome_r * 0.6
        yy = dome_y_at(rr) - 2.6
        c = hall_point(h, a, rr, yy)
        lamp_centers.append(c)
        lamp_v.add(*uv_sphere(c, lamp_r, 24, 14, scale=(1, 0.9, 1)))
        brass.add(*tube(np.array([c + [0, lamp_r * 0.85, 0], [c[0], dome_y_at(rr) - 0.1, c[2]]]), 0.02, 5))
        brass.add(*lathe([(lamp_r * 0.25, lamp_r * 0.95), (lamp_r * 0.78, lamp_r * 0.72), (lamp_r * 0.82, lamp_r * 0.6)], 24, c))
    ob = lamp_v.build('platform.lamps', emitter('platform.lamp_light', '#ffe2bc', 16.0), coll,
                      props={'glass': 'milky', 'glass_color': '#fbf1e2', 'glass_opacity': 0.8, 'glass_emissive': '#ffdcae', 'glass_emissive_intensity': 1.3, 'role': 'ceiling_lamp',
                             'lamp_centers': [round(float(x), 3) for c in lamp_centers for x in c], 'lamp_radius': lamp_r})
    objs.append(ob)

    # ── 壁の燭台: 窓のあいだの低い位置に乳白の玉（壁と回廊に暖かい光のたまりを作る。水に映る） ──
    sconce_v = Builder()
    sconce_centers = []
    sconce_r = 0.26
    for k in range(20):
        a = 2 * math.pi * (k + 0.75) / 20
        base = hall_point(h, a, r_in, 4.3)
        if near_opening(h, rail, base, 2.6) or horizontal_distance(dep_path, base) < 3.0:
            continue
        n_in = np.array([-math.cos(a), 0, -math.sin(a)])
        c = base + n_in * 0.55
        sconce_centers.append(c)
        sconce_v.add(*uv_sphere(c, sconce_r, 20, 12))
        # 真鍮の腕と、壁の丸い座金
        brass.add(*tube(np.array([base + n_in * 0.02 - np.array([0, 0.25, 0]), base + n_in * 0.3 - np.array([0, 0.32, 0]), c - np.array([0, sconce_r * 0.9, 0])]), 0.018, 6))
        # 玉を受ける浅い杯
        brass.add(*tube(np.array([c - np.array([0, sconce_r * 1.05, 0]), c - np.array([0, sconce_r * 0.75, 0])]), 0.07, 10))
    ob = sconce_v.build('platform.sconces', emitter('platform.sconce_light', '#ffcf94', 22.0), coll,
                        props={'glass': 'milky', 'glass_color': '#fff1dc', 'glass_opacity': 0.82, 'glass_emissive': '#ffd09a', 'glass_emissive_intensity': 1.6, 'role': 'sconce',
                               'lamp_centers': [round(float(x), 3) for c in sconce_centers for x in c], 'lamp_radius': sconce_r})
    objs.append(ob)

    for name, b, m, bk in (('platform.plaster', plaster, m_plaster, True), ('platform.plaster_dark', plaster_dark, m_plaster_dark, True),
                           ('platform.stone', stone, m_stone, True), ('platform.brass', brass, m_brass, False)):
        ob = b.build(name, m, coll, smooth=True, props={'brass': True} if not bk else None)
        objs.append(ob)
        if bk:
            bake.append(ob)

    # ── 吊られた泡 ──
    protos, holder = build_bubbles(rail, h, coll, rng, objs, dome_y_at)
    objs.extend(protos)
    objs.append(holder)

    # ── 焼き込みだけの光: 北の門の膜の淡い光、南の入口からの光（待ち列のアーチ） ──
    helpers = []
    disc_a = np.linspace(0, 2 * np.pi, 48, endpoint=False)
    ring = north[None, :] + (np.cos(disc_a)[:, None] * gright[None, :] + np.sin(disc_a)[:, None] * gup[None, :]) * GATE_RING_R
    vv = np.vstack([north, ring])
    ff = [(0, 1 + i, 1 + (i + 1) % 48) for i in range(48)]
    helpers.append(mesh_object('platform.bake_gate_light', vv, ff + [tuple(reversed(x)) for x in ff], emitter('platform.gate_light', '#d9e6ff', 2.2), coll, smooth=False))
    sp = door_c + door_out * (depth + 0.4)
    vv = np.array([sp - door_side * SOUTH_DOOR_HALF + [0, DECK_Y, 0], sp + door_side * SOUTH_DOOR_HALF + [0, DECK_Y, 0],
                   sp + door_side * SOUTH_DOOR_HALF + [0, SOUTH_DOOR_TOP, 0], sp - door_side * SOUTH_DOOR_HALF + [0, SOUTH_DOOR_TOP, 0]])
    helpers.append(mesh_object('platform.bake_door_light', vv, [(0, 1, 2, 3), (3, 2, 1, 0)], emitter('platform.door_light', '#ffd9a8', 3.0), coll, smooth=False))

    # ── 光の状態: 夜明け前（書き出す lightmap）と朝（lightmap_morning） ──
    set_world('#27406b', 1.1)
    lamp_mat = bpy.data.materials['platform.lamp_light']

    def morning():
        set_world('#e2e0d8', 2.6)
        sun_ob = sun('platform.sun', MORNING_SUN_DIR, '#ffd8a8', 8.5, 1.0)
        lamp_mat.node_tree.nodes['Emission'].inputs['Strength'].default_value = 1.5
        sc = bpy.data.materials['platform.sconce_light'].node_tree.nodes['Emission'].inputs['Strength']
        sc.default_value = 1.0
        gl = bpy.data.materials['platform.gate_light'].node_tree.nodes['Emission'].inputs['Strength']
        gl.default_value = 0.6

        def restore():
            set_world('#27406b', 1.1)
            bpy.data.objects.remove(sun_ob)
            lamp_mat.node_tree.nodes['Emission'].inputs['Strength'].default_value = 16.0
            gl.default_value = 2.2
            sc.default_value = 22.0
        return restore

    # 反射用の環境画像（ホールの中ほど、レールの高さ）。夜明け前と朝
    env_at = np.array([cx, 4.5, cz])
    holder['env'] = render_env('platform.env', env_at, samples=24 if fast else 96)
    restore = morning()
    holder['env_morning'] = render_env('platform.env_morning', env_at, samples=24 if fast else 96)
    restore()

    vp = np.vstack([rail.samples(*rail.span('platform', after=25.0), 0.5), rail.samples(*rail.span('departure', before=30.0), 0.5)])
    cp = np.vstack([rail.samples(*rail.sections['platform'], 0.25), rail.samples(*rail.sections['departure'], 0.25)])
    samples = 48 if fast else 320
    finish_room('platform', rail, objs, vp, cp, bake, size=2048, samples=samples, extra_bakes=[('morning', morning)], webp=90)
    for ob in helpers:
        bpy.data.objects.remove(ob)
    save_blend('platform')


#: 朝の光の進む向き（three.js の座標）。東（+X）の低い所から西へ、少し北へ
MORNING_SUN_DIR = (-0.78, -0.42, 0.46)
WINDOW_R = 1.25
#: ドームのガラスの帯（ドームの半径に対する、内と外の半径の割合）
DOME_GLASS = (0.4, 0.66)
WINDOW_Y = WALL_H - 3.1


def window_centers(h: dict, rail: Rail):
    out = []
    for k in range(16):
        a = 2 * math.pi * (k + 0.25) / 16
        c = hall_point(h, a, h['r_in'] + 0.05, WINDOW_Y)
        if near_opening(h, rail, c, 3.0):
            continue
        n_in = np.array([-math.cos(a), 0, -math.sin(a)])
        t_dir = np.array([-math.sin(a), 0, math.cos(a)])
        out.append((c, n_in, t_dir))
    return out


def horizontal_distance(path: np.ndarray, p) -> float:
    return float(np.min(np.hypot(path[:, 0] - p[0], path[:, 2] - p[2])))


def runs(mask: np.ndarray) -> list[np.ndarray]:
    """真が続く範囲の番号の並び"""
    out, cur = [], []
    for i, m in enumerate(mask):
        if m:
            cur.append(i)
        elif cur:
            out.append(np.array(cur))
            cur = []
    if cur:
        out.append(np.array(cur))
    return out


def openings_keep(verts, faces, h: dict, rail: Rail, canal_only: bool = False, windows: bool = False) -> np.ndarray:
    """面を残すか（開口の中の面は消す）。北の門: レールから GATE_OPEN_R 以内。東の水路: 水平 CANAL_HALF 以内で天井より下。
    南の入口: 幅と高さの中（上は半円）。windows なら高窓の丸い穴も"""
    verts = np.asarray(verts)
    s_plat1 = rail.sections['platform'][1]
    s_dep0 = rail.sections['departure'][0]
    gate_pts = rail.samples(s_plat1 - 3.0, s_plat1 + 3.0, 0.1)
    canal_pts = rail.samples(max(0.0, s_dep0 - 3.0), s_dep0 + 12.0, 0.1)
    door_c, door_out = south_door(h, rail)
    door_side = np.array([-door_out[2], 0, door_out[0]])
    wins = np.array([c for c, _n, _t in window_centers(h, rail)]) if windows else np.zeros((0, 3))
    keep = np.ones(len(faces), dtype=bool)
    for i, f in enumerate(faces):
        c = verts[list(f)].mean(0)
        if not canal_only:
            if np.min(np.linalg.norm(gate_pts - c, axis=1)) < GATE_OPEN_R:
                keep[i] = False
                continue
            dx = abs(float(np.dot(c - door_c, door_side)))
            if dx < SOUTH_DOOR_HALF and float(np.dot(c - door_c, door_out)) > -3:
                if c[1] < SOUTH_DOOR_TOP - SOUTH_DOOR_HALF + math.sqrt(max(0.0, SOUTH_DOOR_HALF ** 2 - dx * dx)):
                    keep[i] = False
                    continue
            if len(wins) and np.min(np.linalg.norm(wins - c, axis=1)) < WINDOW_R:
                keep[i] = False
                continue
        dh = np.linalg.norm((canal_pts - c)[:, [0, 2]], axis=1)
        if np.min(dh) < CANAL_HALF and (canal_only or c[1] < canal_y(np.min(dh))):
            keep[i] = False
    return keep


def near_opening(h: dict, rail: Rail, p, dist: float) -> bool:
    """点 p（水平）が開口（北の門、東の水路、南の入口）の近くか"""
    pts = [h['north'], h['east'], np.array([h['start'][0], 0, h['start'][2] + 6])]
    for q in pts:
        if math.hypot(p[0] - q[0], p[2] - q[2]) < dist + 2.5:
            return True
    return False


def balustrade_arcs(h: dict, rail: Rail):
    """回廊の手すりを張る角度の範囲（開口の前は切る）"""
    cut = []
    for q, half in ((h['north'], 0.13), (h['east'], 0.16), (np.array([h['start'][0], 0, h['start'][2] + 6]), 0.08)):
        a = hall_angle(h, q)
        cut.append((a - half, a + half))
    # 0〜2π を開口で切る
    arcs = []
    cuts = sorted(((a0 % (2 * math.pi), (a0 % (2 * math.pi)) + (a1 - a0)) for a0, a1 in cut))
    a = cuts[-1][1] - 2 * math.pi
    for c0, c1 in cuts:
        if c0 > a:
            arcs.append((a, c0))
        a = max(a, c1)
    return arcs


#: 待ち列（lobby）の始まり: レールの始点から真後ろへの距離（m）。src/rooms/lobby/index.ts の LOBBY と同じ値
LOBBY_ORIGIN = 7.6


def south_door(h: dict, rail: Rail) -> tuple[np.ndarray, np.ndarray]:
    """南の入口: 始点から真後ろ（進む向きの逆）へ伸ばした線と内壁の交点と、その向き（外へ）"""
    start = rail.point(0.0)
    back = -rail.forward(0.0)
    # |start + back t - c| = r_in を t について解く（水平）
    c = np.array([h['cx'], 0.0, h['cz']])
    d = np.array([start[0], 0.0, start[2]]) - c
    b = float(np.dot(d, back))
    cc = float(np.dot(d, d)) - h['r_in'] ** 2
    t = -b + math.sqrt(b * b - cc)
    p = np.array([start[0], 0.0, start[2]]) + back * t
    return p, back


def arch_outline(half: float, top: float, base_y: float, n: int) -> list[tuple[float, float]]:
    """下が四角、上が半円のアーチの輪郭（左下から上を回って右下へ）。(横, 高さ)"""
    spring = top - half
    pts = [(-half, base_y), (-half, spring)]
    for i in range(1, n):
        a = math.pi - math.pi * i / n
        pts.append((half * math.cos(a), spring + half * math.sin(a)))
    pts += [(half, spring), (half, base_y)]
    return pts


def canal_y(d: float) -> float:
    """水路の天井（円い）の高さ。中心からの水平の距離 d"""
    rr = CANAL_HALF
    return CANAL_TOP - rr * 0.6 + math.sqrt(max(0.0, rr * rr - d * d)) * 0.6


def canal_arch_path(c, right, half: float, top: float) -> np.ndarray:
    pts = []
    for i in range(41):
        d = -half + 2 * half * i / 40
        pts.append(c + right * d + np.array([0, canal_y_custom(d, half, top), 0]))
    pts = [c + right * (-half) + np.array([0, WATER_Y, 0])] + pts + [c + right * half + np.array([0, WATER_Y, 0])]
    return np.array(pts)


def canal_y_custom(d: float, half: float, top: float) -> float:
    return top - half * 0.6 + math.sqrt(max(0.0, half * half - d * d)) * 0.6


def canal_shell(c0, fwd, right, length: float):
    """水路の面: 内側（両側の壁と円い天井）と、ホールに見える外側（厚み 0.45m の外の皮、向きは外）。
    c0 は外の端、fwd へ length 進むとホールの口。外の皮のうちホールの外に出る面は見えない面として消える"""
    nu, nv = 24, 33
    verts = []
    faces = []
    for skin, (half, top, flip) in enumerate(((CANAL_HALF, CANAL_TOP, False), (CANAL_HALF + 0.45, CANAL_TOP + 0.45, True))):
        base_i = len(verts)
        for j in range(nu):
            t = length * j / (nu - 1)
            base = c0 + fwd * t
            for i in range(nv):
                d = -half + 2 * half * i / (nv - 1)
                y = WATER_Y - 0.3 if i in (0, nv - 1) else canal_y_custom(d, half, top)
                verts.append(base + right * d + np.array([0, y, 0]))
        for j in range(nu - 1):
            for i in range(nv - 1):
                f = (base_i + j * nv + i, base_i + (j + 1) * nv + i, base_i + (j + 1) * nv + i + 1, base_i + j * nv + i + 1)
                faces.append(tuple(reversed(f)) if flip else f)
        if skin == 1:
            # 口の縁（内と外の皮をつなぐ）
            jm = nu - 1
            for i in range(nv - 1):
                a0 = jm * nv + i
                faces.append((a0, a0 + 1, base_i + a0 + 1, base_i + a0))
    return np.array(verts), faces

def gate_reveal(c, fwd, right, r: float, depth: float):
    """門の開口の筒（壁の厚み）"""
    a = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    up = np.array([0.0, 1.0, 0.0])
    verts = []
    for t in (-depth * 0.5, depth * 0.5):
        for x in a:
            verts.append(c + fwd * t + (math.cos(x) * right + math.sin(x) * up) * r)
    faces = []
    n = len(a)
    for i in range(n):
        i2 = (i + 1) % n
        # 筒の内側（軸の方）を向く面
        faces.append((i, i2, n + i2, n + i))
    return np.array(verts), faces


def rounded_slab(x0: float, x1: float, z0: float, z1: float, top: float, thick: float):
    """先（z0 側）が半円の板（上面と側面。下面は見えないので作らない）。桟橋"""
    cxm = (x0 + x1) / 2
    hw = (x1 - x0) / 2
    outline = [(cxm + math.cos(a) * hw, z0 + hw + math.sin(a) * hw) for a in np.linspace(math.pi, 2 * math.pi, 33)]
    outline += [(x1, z1), (x0, z1)]
    outline = np.array(outline)
    n = len(outline)
    c = outline.mean(0)
    verts = [(c[0], top, c[1])] + [(x, top, z) for x, z in outline] + [(x, top - thick, z) for x, z in outline]
    faces = []
    for i in range(n):
        i2 = (i + 1) % n
        faces.append((0, 1 + i2, 1 + i))
        faces.append((1 + i, 1 + i2, 1 + n + i2, 1 + n + i))
    return np.array(verts), faces

def build_bubbles(rail: Rail, h: dict, coll, rng: random.Random, objs: list, dome_y_at):
    """吊られた泡。触れられる泡（8つ、レールのそばに1つずつ）と、飾りの泡（8種のインスタンス）。

    触れられる泡はレールから箱の距離 2.0〜3.2m、目の高さの近く。吊り糸は TS が描く（吊る点を extras の hang に書く）。
    飾りの泡は天井の中心の房と、ホールのあちこち。糸も含めて、レールから水平に NEED 以上離す。
    """
    plat = rail.samples(*rail.sections['platform'], 0.25)
    dep = rail.samples(*rail.sections['departure'], 0.25)
    clear_pts = np.vstack([plat, dep])
    m_bub = material('platform.bubble', '#e8f0fa', 0.05, alpha=0.1)
    m_brass = bpy.data.materials['platform.brass']
    protos = []
    proto_box_map = {}
    # 元の形（原点、半径 1）
    for kind in BUBBLE_KINDS:
        v, f = bubble_shape(kind, 1.0, detail=0.62)
        ob = mesh_object(f'platform.proto_{kind}', v, f, m_bub, coll, props={'role': 'proto', 'glass': 'iridescent', 'clearance_exempt': True})
        protos.append(ob)
        proto_box_map[kind] = proto_box(ob)
        ring = bubble_ring(kind, 1.0)
        if ring is not None:
            ob = mesh_object(f'platform.proto_{kind}_ring', ring[0], ring[1], m_brass, coll, props={'role': 'proto', 'brass': True, 'clearance_exempt': True})
            protos.append(ob)
    # 触れられる泡: 乗り場の区間の s に沿って左右交互に
    s0, s1 = rail.sections['platform']
    touch_s = np.linspace(s0 + 5.5, s1 - 4.0, 8)
    for i, s in enumerate(touch_s):
        kind = BUBBLE_KINDS[i % len(BUBBLE_KINDS)]
        side = 1 if i % 2 == 0 else -1
        r = [0.42, 0.36, 0.4, 0.38, 0.44, 0.4, 0.36, 0.3][i]
        p = rail.point(s)
        right = rail.right(s)
        lo_k, hi_k = proto_box_map[kind]
        placed = None
        for lateral in np.arange(2.0, 4.5, 0.1):
            c = p + right * side * (lateral + r) + np.array([0, 0.25 + 0.35 * math.sin(i * 1.7), 0])
            m4 = matrix_three(c, rng.uniform(0, 2 * math.pi), scale=(r, r, r))
            lo, hi = instance_box(lo_k, hi_k, m4)
            # 糸も含めて（箱を上へ伸ばす）
            hi_t = hi.copy()
            hi_t[1] = 18.0
            if box_distance(lo, hi_t, clear_pts).min() >= NEED + 0.05:
                placed = (c, m4)
                break
        if placed is None:
            raise RuntimeError(f'触れられる泡 {i} を置けない')
        c, m4 = placed
        v, f = bubble_shape(kind, r)
        yaw = rng.uniform(0, 2 * math.pi)
        rot = np.array([[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]])
        v = v @ rot.T + c
        hang = [round(float(c[0]), 4), round(float(dome_y_at(math.hypot(c[0] - h['cx'], c[2] - h['cz'])) - 0.2), 4), round(float(c[2]), 4)]
        ob = mesh_object(f'platform.touch_bubble.{i + 1:03d}', v, f, m_bub, coll, origin=c,
                         props={'touch_kind': 'hanging-bubble', 'touch_id': f'platform/bubble-{i + 1}', 'glass': 'iridescent', 'role': 'hanging-bubble',
                                'hang': hang, 'radius': round(float(r * (1.25 if kind in ('twin', 'trio', 'pearl') else 1.0)), 3), 'kind': kind, 'no_split': True})
        objs.append(ob)
        ring = bubble_ring(kind, r)
        if ring is not None:
            rv = ring[0] @ rot.T + c
            ob2 = mesh_object(f'platform.touch_bubble_ring.{i + 1:03d}', rv, ring[1], m_brass, coll, origin=c, props={'brass': True, 'ring_of': ob.name, 'no_split': True})
            objs.append(ob2)
    # 飾りの泡: 天井の中心から下がる「泡のシャンデリア」（同心の輪に並ぶ糸に、下ほど大きな泡が連なる）と、
    # 壁際に低く吊られた大きな泡、そのあいだの空間にまばらな泡。糸も含めてレールから離す
    holder = bpy.data.objects.new('platform.instances', None)
    coll.objects.link(holder)
    mats: dict[str, list] = {k: [] for k in BUBBLE_KINDS}
    hangs: dict[str, list] = {k: [] for k in BUBBLE_KINDS}
    placed_pts: list[np.ndarray] = []

    def place(kind: str, c: np.ndarray, scale: float, ceil: float, gap: float = 1.25) -> bool:
        lo_k, hi_k = proto_box_map[kind]
        m4 = matrix_three(c, rng.uniform(0, 2 * math.pi), tilt=(rng.uniform(-0.08, 0.08), rng.uniform(-0.08, 0.08)), scale=(scale, scale, scale))
        lo, hi = instance_box(lo_k, hi_k, m4)
        hi_t = hi.copy()
        hi_t[1] = ceil
        if box_distance(lo, hi_t, clear_pts).min() < NEED + 0.15:
            return False
        if placed_pts and min(float(np.linalg.norm(q[:3] - c)) - q[3] for q in placed_pts) < scale * gap:
            return False
        placed_pts.append(np.array([c[0], c[1], c[2], scale * gap]))
        mats[kind].append(m4)
        hangs[kind].extend([round(float(c[0]), 3), round(float(c[1] + scale * 0.95), 3), round(float(c[2]), 3), round(float(ceil - 0.1), 3)])
        return True

    strand_kinds = ('round', 'nested', 'round', 'pearl', 'drop', 'round', 'twin')
    for k, rr in enumerate((1.6, 3.9, 6.2, 8.5, 10.8)):
        n = max(4, round(2 * math.pi * rr / 2.5))
        for j in range(n):
            a = 2 * math.pi * (j + 0.5 * (k % 2)) / n + k * 0.21
            x = h['cx'] + rr * math.cos(a)
            z = h['cz'] + rr * math.sin(a)
            ceil = dome_y_at(math.hypot(x - h['cx'], z - h['cz']))
            # 下の端は中心ほど低い（逆さの円錐）。糸ごとに少しずらす
            y = 7.2 + 0.62 * rr + rng.uniform(-0.5, 0.5)
            size = 0.62 - 0.03 * k + rng.uniform(-0.06, 0.08)
            first = True
            left = 3 if k <= 2 else 2
            while y < ceil - 1.8 and left > 0:
                left -= 1
                kind = 'lantern' if first and k <= 1 else strand_kinds[rng.randrange(len(strand_kinds))]
                place(kind, np.array([x, y, z]), size, ceil)
                first = False
                y += size * 2.2 + rng.uniform(0.35, 0.9)
                size *= rng.uniform(0.62, 0.8)
                if size < 0.14:
                    break
    # 壁際の大きな泡（柱のあいだ、低め）
    for j in range(22):
        a = 2 * math.pi * (j + 0.5) / 22 + 0.07
        rr = h['r_in'] - rng.uniform(3.2, 4.6)
        x = h['cx'] + rr * math.cos(a)
        z = h['cz'] + rr * math.sin(a)
        kind = ('ringed', 'round', 'trio', 'nested', 'twin', 'drop')[j % 6]
        place(kind, np.array([x, rng.uniform(4.2, 8.5), z]), rng.uniform(0.55, 0.95), dome_y_at(rr))
    # あいだの空間にまばらに
    tries = 0
    count = 0
    while count < 34 and tries < 6000:
        tries += 1
        rr = rng.uniform(12.5, h['r_in'] - 5.5)
        a = rng.uniform(0, 2 * math.pi)
        x = h['cx'] + rr * math.cos(a)
        z = h['cz'] + rr * math.sin(a)
        kind = BUBBLE_KINDS[rng.randrange(len(BUBBLE_KINDS))]
        if place(kind, np.array([x, rng.uniform(5.5, 12.5), z]), rng.uniform(0.2, 0.5), dome_y_at(rr), gap=2.2):
            count += 1
    # 低品質で数を減らすときに偏らないよう、順番を混ぜる（同じ並びで糸の情報も）
    for kind in BUBBLE_KINDS:
        order = list(range(len(mats[kind])))
        rng.shuffle(order)
        write_instances(holder, kind, [mats[kind][i] for i in order])
        hh = hangs[kind]
        holder[f'hang_{kind}'] = [x for i in order for x in hh[i * 4:i * 4 + 4]]
    print('bubbles: ' + ', '.join(f'{k}={len(v)}' for k, v in mats.items()))
    return protos, holder


def main() -> None:
    rail = Rail()
    build_platform(rail, fast_mode())


if __name__ == '__main__':
    main()
