"""乗り場「泡の発着場」（乗り場と降車で同じホール。光だけ変える）と、部屋A（待ち列・乗り場・温室）の共通の道具。
このスクリプトが原本（blender/scenes/platform.blend と glb・ライトマップ・環境画像はその書き出し）。

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
  - 東の水門は、降車のレールが壁を斜めに横切るので、ホールの円の岸の側を「水門の湾」として切り欠き（降車の区間の
    始まり +1m より岸の側には、飾りも含めて乗り場の形を置かない。ADR-0013 の部屋の境目）、水門の館（正面と北・南の返しの
    厚い壁。正面は s0 +1.5m）で閉じる。正面の水路のアーチから、短い水路（canal）がホールの中へ入る。夜明けの岸の膜の輪は正面の 1.5m 手前に立ち、
    水路のアーチ（半幅 CANAL_HALF）の中に収まる。

外側（夜明けの岸から遠くに見え、温室の頭で振り返ると見える）:
  外壁（内壁と同じ丸い高窓の穴を正確に縫った円筒）、外の蛇腹と腰、鉛色のドームの屋根と乳白のガラスの帯、頂の塔。
  外側は別のアトラス（lightmap_exterior、1024px）に焼く。基本の光は温室の昼（温室から見るとき）、朝は岸の空と
  ホールの向こうの低い朝日（岸から見ると逆光）。TS は朝日の時刻に合わせて外側の明るさを上げる。

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

    def data(self) -> tuple[np.ndarray, list[list[int]]]:
        return (np.concatenate(self.v) if self.v else np.zeros((0, 3))), self.f

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
# 壁の道具: 丸い穴を正確に縫う円筒の壁、輪郭のあいだを埋める面、領域の切り落とし
# ═══════════════════════════════════════════════════════════════════════
def cylinder_wall(cx: float, cz: float, r: float, y0: float, y1: float, seg: int, rows: int, inward: bool, holes=(), keep_fn=None):
    """中心 (cx, cz)、半径 r の円筒の壁（内向きか外向きの面）。

    holes = [(角度, 高さ, 半径)] か [(角度, 高さ, 輪郭)]: 穴のまわりの升目をくり抜き、升目の縁の頂点と穴の輪郭の頂点を
    同じ向きで結んで、穴を正確に縫う（隣の升目と頂点を共有するので隙間ができない）。輪郭は壁に沿って広げた平面
    （横 = 角度 × 半径、縦 = 高さ。穴の中心から）の点の並びで、中心から見て星形であること（門の円・入口のアーチ）。
    keep_fn(升目の4頂点) が偽の升目は落とす（水路など）。
    """
    ang = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    ys = np.linspace(y0, y1, rows)
    da = 2 * np.pi / seg
    dy = (y1 - y0) / (rows - 1)
    pt = lambda a, y: np.array([cx + r * math.cos(a), y, cz + r * math.sin(a)])  # noqa: E731
    verts = [pt(a, y) for y in ys for a in ang]
    removed = set()
    patches = []
    for ac, yc, shape in holes:
        if isinstance(shape, (int, float)):
            rho = (lambda hr: (lambda th: hr))(float(shape))
            s_lo, s_hi, y_lo, y_hi = -shape, shape, -shape, shape
        else:
            pts = np.asarray(shape, dtype=np.float64)
            rho = polar_outline(pts)
            s_lo, s_hi = float(pts[:, 0].min()), float(pts[:, 0].max())
            y_lo, y_hi = float(pts[:, 1].min()), float(pts[:, 1].max())
        i0 = int(math.floor((ac + (s_lo - 0.3) / r) / da))
        i1 = int(math.ceil((ac + (s_hi + 0.3) / r) / da))
        j0 = max(0, int(math.floor((yc + y_lo - 0.3 - y0) / dy)))
        j1 = min(rows - 1, int(math.ceil((yc + y_hi + 0.3 - y0) / dy)))
        for i in range(i0, i1):
            for j in range(j0, j1):
                removed.add((i % seg, j))
        # 長方形の縁を、格子の頂点を通って一周（角度順）
        edge = [(i, j0) for i in range(i0, i1)] + [(i1, j) for j in range(j0, j1)] + [(i, j1) for i in range(i1, i0, -1)] + [(i0, j) for j in range(j1, j0, -1)]
        patches.append((ac, yc, rho, edge))
    faces = []
    for j in range(rows - 1):
        for i in range(seg):
            if (i, j) in removed:
                continue
            q = (j * seg + i, j * seg + (i + 1) % seg, (j + 1) * seg + (i + 1) % seg, (j + 1) * seg + i)
            if keep_fn is not None and not keep_fn(np.array([verts[k] for k in q])):
                continue
            faces.append(q)
    for ac, yc, rho, edge in patches:
        ring_idx = []
        circ_idx = []
        for i, j in edge:
            ring_idx.append(j * seg + i % seg)
            # 縁の頂点の、穴の中心からの向き（壁に沿って広げた平面で）。その向きの輪郭の点と結ぶ
            s_off = (i * da - ac) * r
            y_off = ys[j] - yc
            th = math.atan2(y_off, s_off)
            hr = rho(th)
            verts.append(pt(ac + hr * math.cos(th) / r, yc + hr * math.sin(th)))
            circ_idx.append(len(verts) - 1)
        n = len(edge)
        for k in range(n):
            k2 = (k + 1) % n
            faces.append((ring_idx[k], ring_idx[k2], circ_idx[k2], circ_idx[k]))
    verts = np.array(verts)
    out = []
    for f in faces:
        q = list(f)
        c = verts[q].mean(0)
        nrm = np.cross(verts[q[1]] - verts[q[0]], verts[q[2]] - verts[q[0]])
        if np.linalg.norm(nrm) < 1e-12 and len(q) > 3:
            nrm = np.cross(verts[q[2]] - verts[q[0]], verts[q[3]] - verts[q[0]])
        radial = np.array([c[0] - cx, 0.0, c[2] - cz])
        want = -radial if inward else radial
        out.append(tuple(q) if np.dot(nrm, want) > 0 else tuple(reversed(q)))
    return verts, out


def polar_outline(pts: np.ndarray):
    """中心 (0, 0) から見て星形の輪郭の点の並び → 向き th の輪郭までの距離を返す関数（点のあいだは線分で）"""
    pts = np.asarray(pts, dtype=np.float64)
    n = len(pts)

    def rho(th: float) -> float:
        d = np.array([math.cos(th), math.sin(th)])
        best = None
        for k in range(n):
            a, b = pts[k], pts[(k + 1) % n]
            e = b - a
            den = d[0] * (-e[1]) - d[1] * (-e[0])
            if abs(den) < 1e-12:
                continue
            # t d = a + u e を解く
            t = (a[0] * (-e[1]) - a[1] * (-e[0])) / den
            u = (d[0] * a[1] - d[1] * a[0]) / den
            if t > 0 and -1e-9 <= u <= 1 + 1e-9 and (best is None or t < best):
                best = t
        return float(best if best is not None else np.max(np.linalg.norm(pts, axis=1)))
    return rho


def wall_hole_outline(cx: float, cz: float, r: float, origin, axis, ring_pts) -> tuple[float, float, np.ndarray]:
    """開口（origin を通り axis の向きの筒。ring_pts は筒の断面の点、世界の座標）が半径 r の円筒の壁と交わる輪郭。
    戻り値は (中心の角度, 中心の高さ, 輪郭の点 (横 = 角度の差 × r, 縦 = 高さの差))"""
    axis = np.asarray(axis, dtype=np.float64)
    c = np.array([cx, 0.0, cz])

    def hit(p0) -> np.ndarray:
        p = np.asarray(p0, dtype=np.float64) - c
        dx, dz = axis[0], axis[2]
        a = dx * dx + dz * dz
        b = 2 * (p[0] * dx + p[2] * dz)
        cc = p[0] ** 2 + p[2] ** 2 - r * r
        disc = math.sqrt(max(0.0, b * b - 4 * a * cc))
        ts = [(-b - disc) / (2 * a), (-b + disc) / (2 * a)]
        t = min(ts, key=abs)
        return np.asarray(p0, dtype=np.float64) + axis * t

    ctr = hit(origin)
    ac = math.atan2(ctr[2] - cz, ctr[0] - cx)
    out = []
    for q in ring_pts:
        w = hit(q)
        da = (math.atan2(w[2] - cz, w[0] - cx) - ac + math.pi) % (2 * math.pi) - math.pi
        out.append((da * r, w[1] - ctr[1]))
    return ac, float(ctr[1]), np.array(out)


def ring_wall(outer: list, inner: list, center_xy: tuple[float, float], n: int = 96):
    """穴のある板（2つの輪郭のあいだを、中心からの角度でそろえた四角でつなぐ）。輪郭は (横, 高さ) の並び。
    戻り値は (横, 高さ) の頂点と面（輪郭の平面の上）"""
    def resample(poly):
        poly = np.asarray(poly, dtype=np.float64)
        ang = np.arctan2(poly[:, 1] - center_xy[1], poly[:, 0] - center_xy[0])
        order = np.argsort(ang)
        a, p = ang[order], poly[order]
        a = np.concatenate([a - 2 * np.pi, a, a + 2 * np.pi])
        p = np.concatenate([p, p, p])
        return np.array([(np.interp(t, a, p[:, 0]), np.interp(t, a, p[:, 1])) for t in np.linspace(-np.pi, np.pi, n, endpoint=False)])

    o = resample(outer)
    i = resample(inner)
    verts = np.vstack([i, o])
    faces = [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    return verts, faces


def dense_outline(poly, step: float = 0.15):
    """輪郭を細かく（角度でそろえるときに角が丸まらないように）"""
    out = []
    for a, b in zip(poly, poly[1:] + poly[:1]):
        a, b = np.asarray(a), np.asarray(b)
        k = max(1, int(np.linalg.norm(b - a) / step))
        for j in range(k):
            out.append(tuple(a + (b - a) * j / k))
    return out


def cut_region(objs, origin, axis_a, axis_l, a_max: float, l_max: float, l_min: float = -12.0) -> None:
    """平面 a = a_max と l = l_max で面を正確に切り、a < a_max かつ l_min < l < l_max の面を落とす（a, l は origin からの
    axis_a・axis_l の向きの距離）。乗り場の東の水門の湾（隣の部屋との境目の手前）を空けるのに使う"""
    from mathutils import Vector
    o3 = np.asarray(origin, dtype=np.float64)
    planes = [(o3 + np.asarray(axis_a) * a_max, np.asarray(axis_a)), (o3 + np.asarray(axis_l) * l_max, np.asarray(axis_l))]
    for ob in objs:
        if ob.type != 'MESH':
            continue
        me = ob.data
        inv = ob.matrix_world.inverted()
        m3t = ob.matrix_world.to_3x3().transposed()
        bm = bmesh.new()
        bm.from_mesh(me)
        for pco, pno in planes:
            pl = inv @ Vector(to_blender(pco).tolist())
            nl = (m3t @ Vector(to_blender(pno).tolist())).normalized()
            bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=pl, plane_no=nl, dist=1e-4)
        mw = np.array(ob.matrix_world)
        dead = []
        for f in bm.faces:
            c = to_three(mw[:3, :3] @ np.array(f.calc_center_median()) + mw[:3, 3])
            a = float(np.dot(c - o3, axis_a))
            lat = float(np.dot(c - o3, axis_l))
            if a < a_max - 1e-3 and l_min < lat < l_max - 1e-3:
                dead.append(f)
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        loose = [v for v in bm.verts if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
        bm.to_mesh(me)
        bm.free()
        me.update()

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
    more_bakes: list | None = None,
    hide_while_baking: dict | None = None,
) -> dict:
    """部屋の仕上げ。objs は書き出す物すべて（インスタンスの元の形と extras の入れ物を含む）。

    view_points_three: 見えない面の削除に使う視点の折れ線（three.js の座標）。区間の前後の余裕を含めて渡す。
    clear_points_three: 物との最短距離を守る区間のレールの点（None なら検査しない。待ち列）。
    bake_targets: 光を焼き込む物（不透明・インスタンスでない物）。焼き込みは物の分割の後。
    extra_bakes: [(名前の接尾辞, 準備の関数)] 別の光の状態のライトマップ（例: 朝）。焼いた物には
                 lightmap_<接尾辞> と lightmap_<接尾辞>_scale を残す（UV は同じ）。
    more_bakes: [(名前, 物の一覧, 大きさ[, 準備の関数[, {接尾辞: 準備の関数}]])] 別のアトラスに焼く物（例: 遠くから見る
                 外側は小さなアトラスに）。名前は <部屋>.<名前>.png。光の状態（extra_bakes）は同じ名前で焼く。準備の関数が
                 あれば、その組だけ基本や別の光の状態をそれで焼く（例: 乗り場の外側は、温室の昼と夜明けの岸の朝日で見られる）。
    hide_while_baking: {組の名前: [物の名前]} その組を焼くあいだ光線から隠す物（例: 乗り場の内側を焼くときの外の殻。
                 内と外は別の時刻・別の光で見られるので、外の屋根で内のドームの帯の光を遮らない）。
    """
    groups = [('lightmap', bake_targets, size)] + [(e[0], e[1], e[2]) for e in (more_bakes or [])]
    base_prepare = {e[0]: e[3] for e in (more_bakes or []) if len(e) > 3 and e[3]}
    state_prepare = {e[0]: e[4] for e in (more_bakes or []) if len(e) > 4}
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
                for _n, lst, _sz in groups:
                    if ob in lst:
                        lst.remove(ob)
                bpy.data.objects.remove(ob)
        bpy.context.view_layer.update()
    # 箱の検査と分割（焼き込みの前。ライトマップは物ごとに付くので）
    if clear_points_three is not None:
        new_objs = []
        for ob in list(objs):
            if ob.type != 'MESH' or is_exempt(ob) or ob.get('role') == 'proto' or ob.get('no_split'):
                new_objs.append(ob)
                continue
            owner = next((lst for _n, lst, _sz in groups if ob in lst), None)
            parts = partition_for_clearance(ob, clear_points_three)
            if len(parts) > 1:
                print(f'partition: {parts[0].name.rsplit(".", 1)[0]} → {len(parts)} 個')
                if owner is not None:
                    owner.remove(ob)
                    owner.extend(parts)
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
    tb = time.time()
    all_targets = []
    for gname, lst, gsize in groups:
        lst[:] = [o for o in lst if o.name in bpy.data.objects and len(o.data.polygons) > 0]
        if not lst:
            continue
        all_targets.extend(lst)
        hidden = [bpy.data.objects[n] for n in (hide_while_baking or {}).get(gname, []) if n in bpy.data.objects]
        hide_from_rays(hidden, True)
        for suffix, prepare in extra_bakes or []:
            restore = state_prepare.get(gname, {}).get(suffix, prepare)()
            res = bake_lightmaps(lst, OUT_DIR, size=gsize, samples=samples, name=f'{room}.{gname}_{suffix}', percentile=percentile)
            for o in lst:
                o[f'lightmap_{suffix}'] = o['lightmap']
                o[f'lightmap_{suffix}_scale'] = o['lightmap_scale']
            if restore:
                restore()
            report[f'bake_{gname}_{suffix}'] = res[0]['scale'] if res else None
        restore = base_prepare[gname]() if gname in base_prepare else None
        res = bake_lightmaps(lst, OUT_DIR, size=gsize, samples=samples, name=f'{room}.{gname}', percentile=percentile, repack=not extra_bakes)
        if restore:
            restore()
        hide_from_rays(hidden, False)
        report[f'bake_{gname}_scale'] = res[0]['scale'] if res else None
    report['bake_seconds'] = round(time.time() - tb, 1)
    if webp:
        keys = ['lightmap'] + [f'lightmap_{suffix}' for suffix, _ in (extra_bakes or [])]
        report['webp'] = lightmaps_to_webp(all_targets, keys, webp)
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


def hide_from_rays(objs, hidden: bool) -> None:
    """物を焼き込み・撮影の光線から隠す（描かれず、影も落とさず、光も出さない）"""
    for ob in objs:
        ob.hide_render = hidden
        for k in ('visible_camera', 'visible_diffuse', 'visible_glossy', 'visible_transmission', 'visible_volume_scatter', 'visible_shadow'):
            setattr(ob, k, not hidden)


def render_env(name: str, pos_three, size: tuple[int, int] = (512, 256), samples: int = 48, exposure: float = 0.0, hide=()) -> str:
    """部屋の中の1点から、反射用の環境画像（正距円筒、8bit の sRGB PNG）を Cycles で撮る（設計書「焼き込み」）。

    three.js の正距円筒の反射（EquirectangularReflectionMapping）と向きを合わせる: 画像の中央が +X（three.js）、
    右へ行くと +Z（three.js）、上が上。カメラは Blender の +X を向け、上を +Z にする。
    戻り値は out_dir からの名前（例 platform.env.png）。読む側は flipY = true（画像の上が上）。
    hide: 撮るあいだ隠す物（焼き込みだけの補助の光源など。環境画像に写ると、水面やガラスに実在しない光が映る）。
    """
    scene = bpy.context.scene
    hide_from_rays(hide, True)
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
        hide_from_rays(hide, False)
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
    cx, cz, r_in, r_out = h['cx'], h['cz'], h['r_in'], h['r_out']
    objs: list = []
    bake: list = []
    bake_ext: list = []

    s_plat1 = rail.sections['platform'][1]
    s_dep0 = rail.sections['departure'][0]
    north = h['north']
    start = h['start']
    a_south = hall_angle(h, np.array([start[0], 0, start[2] + 10]))  # 桟橋の向き
    # 降車のレールは南の壁沿いを通る（水平の距離で床や柱を避ける）
    dep_path = rail.samples(*rail.span('departure', before=2.0), 0.25)
    bay = water_gate_bay(rail, h)

    # ── 材質（色は sRGB。base color は TS でもそのまま使う） ──
    m_plaster = material('platform.plaster', '#8792a2', 0.85)
    m_plaster_dark = material('platform.plaster_dark', '#636e7f', 0.85)
    m_stone = material('platform.stone', '#a9aeb5', 0.7)
    m_brass = material('platform.brass', '#b8925a', 0.35, metallic=1.0)
    m_water = material('platform.water', '#0d1824', 0.08)
    m_glass = material('platform.glass', '#dfe8f2', 0.05, alpha=0.15)
    m_ext = material('platform.exterior', '#a3a7ad', 0.8)
    m_roof = material('platform.roof', '#5f6c7a', 0.6)

    # 材質ごとにまとめる（物の数 = 描く回数を減らす。レールに近い物は後で塊に分ける）
    plaster = Builder()
    plaster_dark = Builder()
    stone = Builder()
    brass = Builder()
    ext = Builder()  # 外壁・外の蛇腹・水門の館（夜明けの岸と温室から見える外側）
    roof = Builder()  # ドームの屋根と頂の塔
    ext_brass = Builder()
    canal = Builder()  # 水路（内も外も）

    # ── 壁: 内側の面（丸い高窓の穴を正確に縫う）、腰と蛇腹 ──
    seg = 200
    rows = 26
    keep_canal = lambda quad: opening_keep(quad, h, rail, gate_door=False)  # noqa: E731

    def holes_at(rr: float) -> list:
        """半径 rr の壁の穴: 高窓（円）、北の門（門の筒が壁と交わる輪郭）、南の入口（アーチの通路が壁と交わる輪郭）"""
        out = [(a, WINDOW_Y, WINDOW_R) for a in window_angles(h, rail, bay)]
        g_fwd = rail.forward(s_plat1)
        g_right = np.array([-g_fwd[2], 0.0, g_fwd[0]])
        ring = [h['north'] + (math.cos(t) * g_right + np.array([0.0, math.sin(t), 0.0])) * GATE_OPEN_R for t in np.linspace(0, 2 * math.pi, 96, endpoint=False)]
        out.append(wall_hole_outline(cx, cz, rr, h['north'], g_fwd, ring))
        dc, dout = south_door(h, rail)
        dside = np.array([-dout[2], 0.0, dout[0]])
        arch = dense_outline(arch_outline(SOUTH_DOOR_HALF, SOUTH_DOOR_TOP, DECK_Y - 0.05, 32), 0.2)
        ring = [dc + dside * x + np.array([0.0, y, 0.0]) for x, y in arch]
        mid = dc + np.array([0.0, (DECK_Y + SOUTH_DOOR_TOP) / 2, 0.0])
        out.append(wall_hole_outline(cx, cz, rr, mid, dout, ring))
        return out

    v, f = cylinder_wall(cx, cz, r_in, DECK_Y - 0.5, WALL_H, seg, rows, True, holes_at(r_in), keep_canal)
    plaster.add(v, f)
    v, f = lathe([(r_in - 0.02, DECK_Y - 0.4), (r_in - 0.12, DECK_Y - 0.2), (r_in - 0.12, DECK_Y + 1.0), (r_in - 0.03, DECK_Y + 1.15)], seg, (cx, 0, cz))
    f = [tuple(reversed(x)) for x in f]
    keep = [opening_keep(v[list(x)], h, rail) for x in f]
    plaster_dark.add(v, [x for x, k in zip(f, keep) if k])
    # 蛇腹の根元は壁に少し埋める（壁とのあいだに隙間があると、焼き込みで空の光が点線のように漏れる）
    v, f = lathe([(r_in + 0.03, WALL_H - 0.9), (r_in - 0.35, WALL_H - 0.75), (r_in - 0.45, WALL_H - 0.45), (r_in - 0.8, WALL_H - 0.1), (r_in - 0.8, WALL_H + 0.05)], seg, (cx, 0, cz))
    plaster.add(v, [tuple(reversed(x)) for x in f])

    # ── 外壁（外向きの面）と外の蛇腹。夜明けの岸から遠くに見え、温室の頭から振り返ると見える ──
    v, f = cylinder_wall(cx, cz, r_out, WATER_Y - 0.4, WALL_H + 0.3, 160, 18, False, holes_at(r_out), keep_canal)
    ext.add(v, f)
    for prof in ([(r_out - 0.02, WALL_H + 0.25), (r_out + 0.35, WALL_H + 0.35), (r_out + 0.5, WALL_H + 0.6), (r_out + 0.5, WALL_H + 0.78), (r_out + 0.2, WALL_H + 0.9)],
                 [(r_out + 0.06, WATER_Y - 0.4), (r_out + 0.28, WATER_Y - 0.2), (r_out + 0.28, DECK_Y + 0.9), (r_out + 0.02, DECK_Y + 1.05)]):
        v, f = lathe(prof, 160, (cx, 0, cz))
        if prof[0][1] > WALL_H:
            # 蛇腹は北の門の上で出を浅くする（温室の側の部屋の境目 s1 +1m を越えない。ADR-0013）
            a_gate = hall_angle(h, north)
            ang = np.arctan2(v[:, 2] - cz, v[:, 0] - cx)
            da = (ang - a_gate + np.pi) % (2 * np.pi) - np.pi
            k = 1.0 - 0.65 * np.exp(-(da / 0.22) ** 2)
            rad = np.hypot(v[:, 0] - cx, v[:, 2] - cz)
            new_rad = r_out + (rad - r_out) * k
            v = v.copy()
            v[:, 0] = cx + (v[:, 0] - cx) * new_rad / rad
            v[:, 2] = cz + (v[:, 2] - cz) * new_rad / rad
        # 外の腰と蛇腹も、開口（南の入口・水路）の中は切る
        ext.add(v, [x for x in f if opening_keep(v[list(x)], h, rail)])
    # 高窓の見込み（壁の厚みの筒。窓の軸の方を向く）と、内と外の乳白のガラス
    win_in = Builder()
    win_out = Builder()
    for a in window_angles(h, rail, bay):
        n_out = np.array([math.cos(a), 0, math.sin(a)])
        t_dir = np.array([-math.sin(a), 0, math.cos(a)])
        ci = hall_point(h, a, r_in, WINDOW_Y)
        co = hall_point(h, a, r_out, WINDOW_Y)
        disc_a = np.linspace(0, 2 * np.pi, 40, endpoint=False)
        ring_d = np.cos(disc_a)[:, None] * t_dir[None, :] + np.sin(disc_a)[:, None] * np.array([0, 1.0, 0])[None, :]
        rv = np.vstack([ci[None, :] + ring_d * WINDOW_R, co[None, :] + ring_d * WINDOW_R])
        rf = []
        for i in range(40):
            i2 = (i + 1) % 40
            q = (i, i2, 40 + i2, 40 + i)
            nrm = np.cross(rv[q[1]] - rv[q[0]], rv[q[2]] - rv[q[0]])
            mid = rv[list(q)].mean(0)
            axis_pt = ci + n_out * float(np.dot(mid - ci, n_out))
            rf.append(q if np.dot(nrm, axis_pt - mid) > 0 else tuple(reversed(q)))
        plaster_dark.add(rv, rf)
        for c, want, b in ((ci + n_out * 0.08, -n_out, win_in), (co - n_out * 0.08, n_out, win_out)):
            ring = c[None, :] + ring_d * WINDOW_R
            vv = np.vstack([c, ring])
            ff = []
            for i in range(40):
                q = (0, 1 + i, 1 + (i + 1) % 40)
                nrm = np.cross(vv[q[1]] - vv[q[0]], vv[q[2]] - vv[q[0]])
                ff.append(q if np.dot(nrm, want) > 0 else tuple(reversed(q)))
            b.add(vv, ff)
        # 内の真鍮の縁と十字の桟、外の真鍮の縁
        brass.add(*tube(ci[None, :] + ring_d * WINDOW_R - n_out * 0.04, 0.06, 8, caps=False, closed=True))
        brass.add(*tube(np.array([ci - t_dir * WINDOW_R, ci + t_dir * WINDOW_R]) + n_out * 0.06, 0.025, 5))
        brass.add(*tube(np.array([ci - np.array([0, WINDOW_R, 0]), ci + np.array([0, WINDOW_R, 0])]) + n_out * 0.06, 0.025, 5))
        ext_brass.add(*tube(co[None, :] + ring_d * (WINDOW_R + 0.06) + n_out * 0.04, 0.07, 8, caps=False, closed=True))
    # 高窓は乳白（夜明け前は藍がにじみ、朝は明るく光る。窓越しに隣の温室が見えて門の驚きが漏れないように）
    win_props = {'glass': 'milky', 'glass_color': '#7f8fa8', 'glass_opacity': 0.6, 'glass_emissive': '#5f7cae', 'glass_emissive_intensity': 0.32,
                 'role': 'window', 'clearance_exempt': True}
    objs.append(win_in.build('platform.windows', m_glass, coll, smooth=False, props=win_props))
    objs.append(win_out.build('platform.windows_out', m_glass, coll, smooth=False, props={**win_props, 'exterior': True}))

    # ── ドーム: 壁の上から頂へ。中ほどの帯はガラス、頂に乳白の丸窓（オクルス） ──
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
        path = [(cx + rr * math.cos(a), dome_y_at(rr) - 0.06, cz + rr * math.sin(a)) for rr in np.linspace(dome_r - 0.05, top_r + 0.05, 24)]
        brass.add(*tube(np.array(path), 0.07, 6, caps=False))
    a = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    for rr, at_top in ((top_r + 0.05, True), (dome_r * DOME_GLASS[1], False), (dome_r * DOME_GLASS[0], False), (dome_r * (DOME_GLASS[0] + DOME_GLASS[1]) / 2, False)):
        yy = (top_y - 0.08) if at_top else dome_y_at(rr) - 0.08
        path = np.stack([cx + rr * np.cos(a), np.full_like(a, yy), cz + rr * np.sin(a)], axis=1)
        brass.add(*tube(path, 0.09 if at_top else 0.06, 8, caps=False, closed=True))

    # ── ドームの屋根（外）: 鉛色の屋根、乳白のガラスの帯、真鍮の外のリブ、頂の塔（小さなドームと真鍮の頂飾り） ──
    ext_r = r_out + 0.2
    ext_y = lambda rr: WALL_H + 0.85 + (DOME_TOP + 0.65 - WALL_H - 0.85) * math.sqrt(max(0.0, 1 - (rr / ext_r) ** 2))  # noqa: E731
    lantern_r = 3.7
    roof_rr = lantern_r + (ext_r - lantern_r) * np.sin(np.linspace(math.pi / 2, 0, 44))
    prof = [(rr, ext_y(rr)) for rr in roof_rr]
    v, f = lathe(prof, 120, (cx, 0, cz))
    radial = np.array([math.hypot(*(v[list(x)].mean(0) - [cx, 0, cz])[[0, 2]]) for x in f])
    band = (radial > DOME_GLASS[0] * ext_r) & (radial < DOME_GLASS[1] * ext_r)
    roof.add(v, [x for x, b in zip(f, band) if not b])
    ob = mesh_object('platform.dome_band_out', v, [x for x, b in zip(f, band) if b], m_glass, coll,
                     props={'glass': 'milky', 'glass_color': '#7d8ca6', 'glass_opacity': 0.55, 'glass_emissive': '#6f8cbd', 'glass_emissive_intensity': 0.35,
                            'role': 'dome_band', 'exterior': True, 'clearance_exempt': True})
    objs.append(ob)
    ring_a = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    for rr in (DOME_GLASS[0] * ext_r, DOME_GLASS[1] * ext_r):
        path = np.stack([cx + rr * np.cos(ring_a), np.full_like(ring_a, ext_y(rr) + 0.06), cz + rr * np.sin(ring_a)], axis=1)
        ext_brass.add(*tube(path, 0.08, 8, caps=False, closed=True))
    lt0 = ext_y(lantern_r)
    v, f = lathe([(lantern_r, lt0 - 0.2), (lantern_r, lt0 + 1.3), (lantern_r + 0.25, lt0 + 1.45), (lantern_r + 0.25, lt0 + 1.65), (lantern_r * 0.9, lt0 + 1.75)], 64, (cx, 0, cz))
    ext.add(v, f)
    v, f = lathe([(lantern_r * 0.9, lt0 + 1.75)] + [(lantern_r * 0.9 * math.cos(t), lt0 + 1.75 + 2.2 * math.sin(t)) for t in np.linspace(0.08, math.pi / 2 - 0.02, 12)], 64, (cx, 0, cz))
    ob = mesh_object('platform.lantern_glass', v, f, m_glass, coll,
                     props={'glass': 'milky', 'glass_color': '#8a99b2', 'glass_opacity': 0.6, 'glass_emissive': '#8ea6cc', 'glass_emissive_intensity': 0.35,
                            'role': 'dome_band', 'exterior': True, 'clearance_exempt': True})
    objs.append(ob)
    ext_brass.add(*uv_sphere(np.array([cx, lt0 + 4.2, cz]), 0.32, 16, 10))
    ext_brass.add(*tube(np.array([[cx, lt0 + 3.8, cz], [cx, lt0 + 5.6, cz]]), 0.06, 8))

    # ── 柱: 壁沿いの細い真鍮の柱。開口の前と、降車のレールのそば、水門の湾には立てない ──
    for k in range(24):
        a = 2 * math.pi * (k + 0.5) / 24
        p = hall_point(h, a, r_in - 0.35, 0)
        if near_opening(h, rail, p, 2.2) or horizontal_distance(dep_path, p) < 3.4 or bay.inside(p, 1.2):
            continue
        brass.add(*tube(np.array([[p[0], DECK_Y, p[2]], [p[0], WALL_H - 0.85, p[2]]]), 0.11, 10))
        for yy, rr in ((DECK_Y + 0.12, 0.17), (WALL_H - 1.0, 0.16)):
            ca = np.linspace(0, 2 * np.pi, 20, endpoint=False)
            ring = np.stack([p[0] + rr * np.cos(ca), np.full(20, yy), p[2] + rr * np.sin(ca)], axis=1)
            brass.add(*tube(ring, 0.035, 6, caps=False, closed=True))

    # ── 床: 水面（ホールいっぱい）、回廊（壁沿い）、桟橋（南の入口から始点の手前まで） ──
    water = Builder()
    v, f = lathe([(0.0, WATER_Y), (r_in + 0.1, WATER_Y)], 160, (cx, 0, cz))
    water.add(v, [tuple(reversed(x)) for x in f])
    water.add(*canal_water(bay.front, bay.d, bay.l, CANAL_LEN))
    water_ob = water.build('platform.water', m_water, coll, smooth=False, props={'role': 'water', 'clearance_exempt': True})
    objs.append(water_ob)
    walk_w = 2.2
    for prof, b in (([(r_in - walk_w + 0.15, DECK_Y), (r_in + 0.05, DECK_Y)], stone),
                    ([(r_in - walk_w, DECK_Y - 0.3), (r_in - walk_w, DECK_Y - 0.02), (r_in - walk_w + 0.02, DECK_Y), (r_in - walk_w + 0.15, DECK_Y)], plaster_dark)):
        v, f = lathe(prof, seg, (cx, 0, cz))
        f = [tuple(reversed(x)) for x in f]
        # 降車のレールのそば（水平 2.7m 以内）は回廊を切る（ゴンドラは南の壁沿いの水面を進む）
        cen = np.array([v[list(x)].mean(0) for x in f])
        keep = np.array([horizontal_distance(dep_path, c) >= 2.7 for c in cen])
        b.add(v, [x for x, k in zip(f, keep) if k])
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

    # ── 北の門: 真鍮の丸い門（膜は TS が張る）。開口のまわりに3重の輪と放射の飾り。内と外の縁 ──
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
    ca = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    ring_dir = np.cos(ca)[:, None] * gright[None, :] + np.sin(ca)[:, None] * gup[None, :]
    for face_off, want, b in ((-(WALL_T + 0.9) * 0.5, -gfwd, plaster_dark), ((WALL_T + 0.9) * 0.5, gfwd, ext)):
        face_c = north + gfwd * face_off
        inner = face_c[None, :] + ring_dir * GATE_OPEN_R
        outer = face_c[None, :] + ring_dir * (GATE_OPEN_R + 1.15)
        cv = np.vstack([inner, outer])
        cf = []
        for i in range(96):
            i2 = (i + 1) % 96
            q = (i, i2, 96 + i2, 96 + i)
            nrm = np.cross(cv[q[1]] - cv[q[0]], cv[q[2]] - cv[q[0]])
            cf.append(q if np.dot(nrm, want) > 0 else tuple(reversed(q)))
        b.add(cv, cf)
        (brass if b is plaster_dark else ext_brass).add(*tube(outer + want * 0.02, 0.05, 8, caps=False, closed=True))

    # ── 南の入口（待ち列のアーチへ）: 壁の厚みのアーチの通路、ホール側の縁、乳白のガラスの扉2枚 ──
    # 待ち列はレールの始点の真後ろに一直線に置く（lobby.py と TS の lobbyViews が同じ距離を使う）
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
    fl = [door_c - door_out * 0.6 - door_side * SOUTH_DOOR_HALF, door_c - door_out * 0.6 + door_side * SOUTH_DOOR_HALF,
          door_c + door_out * depth + door_side * SOUTH_DOOR_HALF, door_c + door_out * depth - door_side * SOUTH_DOOR_HALF]
    fl = np.array([p + [0, DECK_Y, 0] for p in fl])
    nrm = np.cross(fl[1] - fl[0], fl[2] - fl[0])
    stone.add(fl, [(0, 1, 2, 3) if nrm[1] > 0 else (3, 2, 1, 0)])
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
    m_door = material('platform.door_glass', '#f3e6d2', 0.3, alpha=0.4)
    for side, label in ((-1, 1), (1, 2)):
        hinge = door_c + door_side * side * (SOUTH_DOOR_HALF - 0.04) + door_out * (depth - 0.25)
        spring = SOUTH_DOOR_TOP - SOUTH_DOOR_HALF
        half_outline = [(0.0, DECK_Y), (side * SOUTH_DOOR_HALF, DECK_Y), (side * SOUTH_DOOR_HALF, spring)]
        for i in range(1, 24):
            t = math.pi / 2 * i / 24
            half_outline.append((side * SOUTH_DOOR_HALF * math.cos(t), spring + SOUTH_DOOR_HALF * math.sin(t)))
        half_outline.append((0.0, SOUTH_DOOR_TOP))
        poly = np.array([door_c + door_side * x + np.array([0, max(y, DECK_Y), 0]) + door_out * (depth - 0.25) for x, y in half_outline])
        dv = np.vstack([poly.mean(0), poly])
        df = []
        for i in range(len(poly)):
            q = (0, 1 + i, 1 + (i + 1) % len(poly))
            nrm = np.cross(dv[q[1]] - dv[q[0]], dv[q[2]] - dv[q[0]])
            df.append(q if np.dot(nrm, -door_out) > 0 else tuple(reversed(q)))
        # 扉の乳白のガラスは琥珀（向こうの待ち列の暖かい光。白く飛ばさない）
        ob = mesh_object(f'platform.door.{label:03d}', dv, df, m_door, coll, smooth=False, origin=hinge,
                         props={'glass': 'milky', 'glass_color': '#8f7a62', 'glass_opacity': 0.5, 'glass_emissive': '#ffb877', 'glass_emissive_intensity': 0.18,
                                'role': 'door_leaf', 'hinge_side': side, 'door_axis': [round(float(x), 4) for x in door_out], 'no_split': True})
        objs.append(ob)
        frame = np.vstack([poly, poly[:1]])
        fr = mesh_object(f'platform.door_frame.{label:03d}', *tube(frame, 0.035, 6), m_brass, coll, origin=hinge, props={'brass': True, 'frame_of': ob.name, 'no_split': True})
        objs.append(fr)

    # ── 東の水門: 水門の館の正面（降車の区間の始まり +BAY_FRONT_AT m）から、ホールの中へ短い水路 ──
    canal_len = CANAL_LEN
    canal.add(*canal_shell(bay.front, bay.d, bay.l, canal_len))
    brass.add(*tube(canal_arch_path(bay.front + bay.d * canal_len, bay.l, CANAL_HALF - 0.05, CANAL_TOP - 0.05), 0.07, 8))
    gatehouse(bay, h, ext, plaster, dome_y_at, ext_y)

    # ── 天井の乳白の灯り（ドームの中ほどに12。水門の湾の上には吊らない） ──
    lamp_v = Builder()
    lamp_r = 0.62
    lamp_centers = []
    for k in range(12):
        a = 2 * math.pi * (k + 0.5) / 12
        rr = dome_r * 0.6
        c = hall_point(h, a, rr, dome_y_at(rr) - 2.6)
        if bay.inside(c, 1.5):
            continue
        lamp_centers.append(c)
        lamp_v.add(*uv_sphere(c, lamp_r, 24, 14, scale=(1, 0.9, 1)))
        brass.add(*tube(np.array([c + [0, lamp_r * 0.85, 0], [c[0], dome_y_at(rr) - 0.1, c[2]]]), 0.02, 5))
        brass.add(*lathe([(lamp_r * 0.25, lamp_r * 0.95), (lamp_r * 0.78, lamp_r * 0.72), (lamp_r * 0.82, lamp_r * 0.6)], 24, c))
    ob = lamp_v.build('platform.lamps', emitter('platform.lamp_light', '#ffe2bc', 16.0), coll,
                      props={'glass': 'milky', 'glass_color': '#fbf1e2', 'glass_opacity': 0.8, 'glass_emissive': '#ffdcae', 'glass_emissive_intensity': 1.3, 'role': 'ceiling_lamp',
                             'lamp_centers': [round(float(x), 3) for c in lamp_centers for x in c], 'lamp_radius': lamp_r, 'clearance_exempt': True})
    objs.append(ob)

    # ── 壁の燭台（窓のあいだの低い位置の乳白の玉） ──
    sconce_v = Builder()
    sconce_centers = []
    sconce_r = 0.26
    for k in range(20):
        a = 2 * math.pi * (k + 0.75) / 20
        base = hall_point(h, a, r_in, 4.3)
        if near_opening(h, rail, base, 2.6) or horizontal_distance(dep_path, base) < 3.0 or bay.inside(base, 1.5):
            continue
        n_in = np.array([-math.cos(a), 0, -math.sin(a)])
        c = base + n_in * 0.55
        sconce_centers.append(c)
        sconce_v.add(*uv_sphere(c, sconce_r, 20, 12))
        brass.add(*tube(np.array([base + n_in * 0.02 - np.array([0, 0.25, 0]), base + n_in * 0.3 - np.array([0, 0.32, 0]), c - np.array([0, sconce_r * 0.9, 0])]), 0.018, 6))
        brass.add(*tube(np.array([c - np.array([0, sconce_r * 1.05, 0]), c - np.array([0, sconce_r * 0.75, 0])]), 0.07, 10))
    ob = sconce_v.build('platform.sconces', emitter('platform.sconce_light', '#ffcf94', 22.0), coll,
                        props={'glass': 'milky', 'glass_color': '#fff1dc', 'glass_opacity': 0.82, 'glass_emissive': '#ffd09a', 'glass_emissive_intensity': 1.6, 'role': 'sconce',
                               'lamp_centers': [round(float(x), 3) for c in sconce_centers for x in c], 'lamp_radius': sconce_r})
    objs.append(ob)

    # 物にする。漆喰の壁とドーム・外の殻は、レールを囲む連続した形なので箱では測らず、面までの本当の距離で確かめる（ADR-0013）
    exempt = {'clearance_exempt': True, 'check_true_clearance': True}
    for name, b, m, group, props in (
        ('platform.plaster', plaster, m_plaster, bake, exempt),
        ('platform.plaster_dark', plaster_dark, m_plaster_dark, bake, None),
        ('platform.stone', stone, m_stone, bake, None),
        ('platform.brass', brass, m_brass, None, {'brass': True}),
        ('platform.exterior', ext, m_ext, bake_ext, {**exempt, 'exterior': True}),
        ('platform.roof', roof, m_roof, bake_ext, {**exempt, 'exterior': True}),
        ('platform.exterior_brass', ext_brass, m_brass, None, {'brass': True, 'exterior': True, 'clearance_exempt': True, 'check_true_clearance': True}),
        ('platform.canal', canal, m_plaster_dark, bake, {**exempt, 'exterior': True}),
    ):
        if b.empty():
            continue
        ob = b.build(name, m, coll, smooth=True, props=props)
        objs.append(ob)
        if group is not None:
            group.append(ob)

    # ── 水門の湾を空ける: 水門の館の正面より手前（岸の側）に、ホールの形を残さない（ADR-0013 の部屋の境目） ──
    interior = [o for o in objs if o.type == 'MESH' and not o.get('exterior') and o.get('role') not in ('proto', 'door_leaf', 'water')
                and o.name not in ('platform.lamps', 'platform.sconces')]
    cut_region(interior, bay.front, bay.d, bay.l, WALL_T, BAY_N + WALL_T)
    exterior = [o for o in objs if o.type == 'MESH' and o.get('exterior') and o.name != 'platform.canal'] + [water_ob]
    cut_region(exterior, bay.front, bay.d, bay.l, 0.0, BAY_N)
    # 水門の館の飾り（正面より岸の側に出る蛇腹・腰・額縁）は切った後に足す
    trim, trim_dark, trim_brass = Builder(), Builder(), Builder()
    gatehouse_dressing(bay, h, trim, trim_dark, trim_brass)
    append_geometry(bpy.data.objects['platform.exterior'], *trim.data(), smooth=False)
    append_geometry(bpy.data.objects['platform.exterior_brass'], *trim_brass.data())
    ob = trim_dark.build('platform.exterior_dark', m_plaster_dark, coll, smooth=False, props={**exempt, 'exterior': True})
    objs.append(ob)
    bake_ext.append(ob)

    # ── 吊られた泡 ──
    protos, holder = build_bubbles(rail, h, coll, rng, objs, dome_y_at, bay)
    objs.extend(protos)
    objs.append(holder)

    # ── 焼き込みだけの光: 北の門の膜の淡い光、南の入口からの光（待ち列のアーチ） ──
    helpers = []
    disc_a = np.linspace(0, 2 * np.pi, 48, endpoint=False)
    ring = north[None, :] + (np.cos(disc_a)[:, None] * gright[None, :] + np.sin(disc_a)[:, None] * gup[None, :]) * GATE_RING_R
    vv = np.vstack([north, ring])
    ff = [(0, 1 + i, 1 + (i + 1) % 48) for i in range(48)]
    helpers.append(mesh_object('platform.bake_gate_light', vv, ff + [tuple(reversed(x)) for x in ff], emitter('platform.gate_light', '#d9e6ff', 2.2), coll, smooth=False))
    # 焼き込みだけの光の蓋: 壁の上（蛇腹とドームの付け根のあいだ）を閉じる。内側を焼くときは外の殻を隠すので、
    # ここが開いていると空の光が壁の上から漏れる（見えない面なので書き出さない）
    v, f = lathe([(r_in - 0.79, WALL_H + 0.05), (r_out + 0.3, WALL_H + 0.05)], 160, (cx, 0, cz))
    blockers = [mesh_object('platform.bake_wall_cap', v, f + [tuple(reversed(x)) for x in f], material('platform.bake_cap', '#3a4250', 0.9), coll, smooth=False)]
    cut_region(blockers, bay.front, bay.d, bay.l, WALL_T, BAY_N + WALL_T)
    sp = door_c + door_out * (depth + 0.4)
    vv = np.array([sp - door_side * SOUTH_DOOR_HALF + [0, DECK_Y, 0], sp + door_side * SOUTH_DOOR_HALF + [0, DECK_Y, 0],
                   sp + door_side * SOUTH_DOOR_HALF + [0, SOUTH_DOOR_TOP, 0], sp - door_side * SOUTH_DOOR_HALF + [0, SOUTH_DOOR_TOP, 0]])
    helpers.append(mesh_object('platform.bake_door_light', vv, [(0, 1, 2, 3), (3, 2, 1, 0)], emitter('platform.door_light', '#ffd9a8', 3.0), coll, smooth=False))

    # ── 光の状態: 夜明け前（書き出す lightmap）と朝（lightmap_morning） ──
    set_world('#27406b', 1.1)
    lamp_mat = bpy.data.materials['platform.lamp_light']

    def morning():
        # 降車の朝（設計書「ホールは朝の光に変わっている」）: 東の高窓とドームのガラスの帯から朝日が差し、西の壁と水面に
        # 金色の斑。暖かい空の光が帯から満ちる。灯りは消えかけの暖かい色で、影の側を少し持ち上げる
        set_world('#f6d6a6', MORNING_SKY)
        # 太陽の角の大きさを広げて、ガラスの帯の影の縁をやわらげる（帯の輪が壁にくっきり写ると目玉のように見える）
        sun_ob = sun('platform.sun', INTERIOR_MORNING_SUN_DIR, '#ffbd78', MORNING_SUN, 7.0)
        lamp_mat.node_tree.nodes['Emission'].inputs['Strength'].default_value = MORNING_LAMPS
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

    # 反射用の環境画像（ホールの中ほど、レールの高さ）。夜明け前と朝。焼き込みだけの補助の光源と外の殻は写さない
    # （補助の光源は水面に実在しない白い円盤として映る。外の殻は内の焼き込みと同じく、ドームの帯の光を遮らない）
    env_at = np.array([cx, 4.5, cz])
    env_hide = helpers + [o for o in objs if o.type == 'MESH' and o.get('exterior') and o not in bake]
    holder['env'] = render_env('platform.env', env_at, samples=24 if fast else 96, hide=env_hide)
    restore = morning()
    holder['env_morning'] = render_env('platform.env_morning', env_at, samples=24 if fast else 96, hide=env_hide)
    restore()

    # 見えない面の削除の視点: 乗り場と降車（前後の余裕も）、夜明けの岸の区間（遠くに乗り場が見える）、
    # 温室の頭の 12 秒（膜から振り返る）
    vp = np.vstack([
        rail.samples(*rail.span('platform', after=25.0), 0.5),
        rail.samples(*rail.span('departure', before=30.0), 0.5),
        rail.samples(*rail.sections['dawn'], 1.0),
        rail.samples(rail.sections['greenhouse'][0], rail.s_at(rail.time_of(rail.sections['greenhouse'][0]) + 12.0), 0.5),
    ])
    cp = np.vstack([rail.samples(*rail.sections['platform'], 0.25), rail.samples(*rail.sections['departure'], 0.25)])
    def greenhouse_day():
        """外側の基本の光（夜明け前の時刻に外側が見えるのは、温室の頭で振り返ったときだけなので、温室の昼の光で焼く）"""
        set_world('#d4e3d6', 0.55)
        sun_ob = sun('platform.greenhouse_sun', GREENHOUSE_SUN_DIR, '#ffe2b4', 10.0, 0.9)
        lamp_mat.node_tree.nodes['Emission'].inputs['Strength'].default_value = 1.5

        def restore():
            set_world('#27406b', 1.1)
            bpy.data.objects.remove(sun_ob)
            lamp_mat.node_tree.nodes['Emission'].inputs['Strength'].default_value = 16.0
        return restore

    def shore_morning():
        """外側の朝（夜明けの岸から見る）。岸の空の色（src/rooms/dawn/sky.ts の朝日の頃の地平と天頂のあいだ）の空と、
        ホールの向こう（西北西）の低い朝日。岸に向いた正面は空の光だけの逆光になり、ドームの頂に朝日が乗る"""
        set_world('#8f86a8', 1.6)
        sun_ob = sun('platform.shore_sun', MORNING_SUN_DIR, '#ffbe8a', 7.0, 1.5)
        lamp_mat.node_tree.nodes['Emission'].inputs['Strength'].default_value = 1.5

        def restore():
            set_world('#27406b', 1.1)
            bpy.data.objects.remove(sun_ob)
            lamp_mat.node_tree.nodes['Emission'].inputs['Strength'].default_value = 16.0
        return restore

    samples = 48 if fast else 320
    finish_room('platform', rail, objs, vp, cp, bake, size=2048, samples=samples, extra_bakes=[('morning', morning)], webp=90,
                more_bakes=[('lightmap_exterior', bake_ext, 1024, greenhouse_day, {'morning': shore_morning})],
                hide_while_baking={'lightmap': [o.name for o in objs if o.get('exterior') and o not in bake]})
    for ob in helpers + blockers:
        bpy.data.objects.remove(ob)
    save_blend('platform')


#: 温室の日の光の進む向き（blender/scripts/rooms/greenhouse.py の SUN_DIR の写し）
GREENHOUSE_SUN_DIR = (-0.32, -0.40, 0.86)
#: 降車のホールの中の朝日の進む向き（three.js の座標）。設計書「東の高窓から朝日が差す」: 東から西へ、高さ約 27°
INTERIOR_MORNING_SUN_DIR = (-0.80, -0.45, 0.40)
#: 降車の朝の焼き込みの空・朝日・灯りの強さ
MORNING_SKY = 9.0
MORNING_SUN = 16.0
MORNING_LAMPS = 6.0
#: 朝の光の進む向き（three.js の座標）。夜明けの岸と同じ朝日（src/rooms/dawn/sky.ts の方位 30°、高さ約 15°）から来る光
MORNING_SUN_DIR = (0.837, -0.259, 0.483)
#: 水門の湾の北の幅（レールから、m）
BAY_N = 6.4
#: 水門の館の正面は、降車の区間の始まりからこの距離だけホールの側。正面から岸の側へ出る飾り（蛇腹 0.5m・腰・額縁）も
#: 含めて、乗り場の形は s0 +1m より岸の側に置かない（ADR-0013: 入る側の部屋は s0 +1m 以降）
BAY_FRONT_AT = 1.5


class Bay:
    """東の水門の湾: 降車の区間の始まり +BAY_FRONT_AT m の面（front）の岸の側で、レールの北 BAY_N m まで。
    d はホールの中への向き（レールの進む向き）、l は横（北が正）"""

    def __init__(self, front, d, l):
        self.front = front
        self.d = d
        self.l = l

    def local(self, p) -> tuple[float, float]:
        q = np.asarray(p, dtype=np.float64) - self.front
        q[1] = 0.0
        return float(np.dot(q, self.d)), float(np.dot(q, self.l))

    def inside(self, p, margin: float = 0.0) -> bool:
        a, lat = self.local(p)
        return a < WALL_T + margin and -12.0 < lat < BAY_N + WALL_T + margin


def water_gate_bay(rail: Rail, h: dict) -> Bay:
    s0 = rail.sections['departure'][0]
    front = rail.point(s0 + BAY_FRONT_AT)
    front[1] = 0.0
    d = rail.forward(s0)
    lat = np.array([-d[2], 0.0, d[0]])
    if lat[2] > 0:  # 北（-Z）を正に
        lat = -lat
    return Bay(front, d, lat)


def gatehouse(bay: Bay, h: dict, ext: Builder, plaster: Builder, dome_y_at, ext_y) -> None:
    """水門の館: 湾を囲む2枚の厚い壁（正面と、北の返し）。外の面は外の殻、内の面はホールの漆喰。
    上の縁はドームの高さ（内はドームの内、外は屋根）に合わせ、内と外のあいだに天端を張る。正面には水路のアーチの穴"""
    cx, cz, r_in, r_out = h['cx'], h['cz'], h['r_in'], h['r_out']
    d, lat = bay.d, bay.l

    def to_world(a: float, l: float, y: float) -> np.ndarray:
        return bay.front + d * a + lat * l + np.array([0.0, y, 0.0])

    def radius(a: float, l: float) -> float:
        p = to_world(a, l, 0.0)
        return math.hypot(p[0] - cx, p[2] - cz)

    def top_in(a: float, l: float) -> float:
        rr = radius(a, l)
        return dome_y_at(rr) - 0.02 if rr < r_in - 0.8 else WALL_H + 0.05

    def top_out(a: float, l: float) -> float:
        rr = radius(a, l)
        return ext_y(rr) + 0.02 if rr < r_out + 0.2 else WALL_H + 0.9

    def slab(points_out, points_in, want_out):
        """外と内の面（下 y=水面の下 から上の縁まで）と天端。points_* は (a, l) の並び"""
        for pts, top, want, b in ((points_out, top_out, want_out, ext), (points_in, top_in, -want_out, plaster)):
            verts, faces = [], []
            for k, (a, l) in enumerate(pts):
                verts.append(to_world(a, l, WATER_Y - 0.4))
                verts.append(to_world(a, l, top(a, l)))
                if k:
                    q = (2 * k - 2, 2 * k, 2 * k + 1, 2 * k - 1)
                    faces.append(q)
            verts = np.array(verts)
            faces = orient(verts, faces, want)
            b.add(verts, faces)
        cv, cf = [], []
        for k, ((ao, lo), (ai, li)) in enumerate(zip(points_out, points_in)):
            cv.append(to_world(ao, lo, top_out(ao, lo)))
            cv.append(to_world(ai, li, top_in(ai, li)))
            if k:
                cf.append((2 * k - 2, 2 * k, 2 * k + 1, 2 * k - 1))
        cv = np.array(cv)
        ext.add(cv, orient(cv, cf, np.array([0.0, 1.0, 0.0])))

    # 正面（a = 0 の外の面、a = WALL_T の内の面）。横は南の水路の外の皮から北の返しまで。水路のアーチの穴を抜いた
    # 1枚の面（列ごとに頂点を共有して、穴の縁や継ぎ目に隙間を作らない）
    south = -(CANAL_HALF + CANAL_SKIN)
    n = 40
    split = canal_y_custom(CANAL_HALF, CANAL_HALF, CANAL_TOP)

    def facade(a0: float, l_lo: float, l_hi: float, top, want, b: Builder) -> None:
        ls = sorted(set(np.round(np.linspace(l_lo, l_hi, 72), 6).tolist()) | {-CANAL_HALF, CANAL_HALF})
        verts, cols = [], []
        for l in ls:
            if abs(l) < CANAL_HALF - 1e-9:
                ys = [canal_y_custom(l, CANAL_HALF, CANAL_TOP), top(a0, l)]
            else:
                ys = [WATER_Y - 0.4, split, top(a0, l)]
            cols.append(list(range(len(verts), len(verts) + len(ys))))
            verts += [to_world(a0, l, y) for y in ys]
        faces = []
        for c0, c1 in zip(cols, cols[1:]):
            if len(c0) == 3 and len(c1) == 3:
                faces += [(c0[0], c1[0], c1[1], c0[1]), (c0[1], c1[1], c1[2], c0[2])]
            elif len(c0) == 3:
                faces.append((c0[1], c1[0], c1[1], c0[2]))
            elif len(c1) == 3:
                faces.append((c0[0], c1[1], c1[2], c0[1]))
            else:
                faces.append((c0[0], c1[0], c1[1], c0[1]))
        verts = np.array(verts)
        b.add(verts, orient(verts, faces, want))

    facade(0.0, south, BAY_N, top_out, -d, ext)
    facade(WALL_T, south, BAY_N + WALL_T, top_in, d, plaster)
    cv, cf = [], []
    for k, (lo, li) in enumerate(zip(np.linspace(south, BAY_N, n), np.linspace(south, BAY_N + WALL_T, n))):
        cv.append(to_world(0.0, lo, top_out(0.0, lo)))
        cv.append(to_world(WALL_T, li, top_in(WALL_T, li)))
        if k:
            cf.append((2 * k - 2, 2 * k, 2 * k + 1, 2 * k - 1))
    cv = np.array(cv)
    ext.add(cv, orient(cv, cf, np.array([0.0, 1.0, 0.0])))
    # 北の返し（l = BAY_N の外の面、l = BAY_N + WALL_T の内の面）。岸の側へ外壁・内壁の円まで
    def reach(l: float, rr: float) -> float:
        # 中心より岸の側では、a が増えるほど中心に近づく
        lo, hi = -40.0, 16.0
        for _ in range(40):
            mid = (lo + hi) / 2
            if radius(mid, l) < rr:
                hi = mid
            else:
                lo = mid
        return hi
    a_out = reach(BAY_N, r_out)
    a_in = reach(BAY_N + WALL_T, r_in)
    pts_out = [(a, BAY_N) for a in np.linspace(0.0, a_out, n)]
    pts_in = [(a, BAY_N + WALL_T) for a in np.linspace(WALL_T, a_in, n)]
    slab(pts_out, pts_in, -lat)
    # 南の返し（水路の外の皮の南）: 正面の南の端から、ホールの外壁まで。正面とホールのあいだの隙間を岸から見せない
    a_s = reach(south, r_out) + 0.3
    pts_out = [(a, south) for a in np.linspace(0.0, a_s, 12)]
    pts_in = [(a, south + 0.5) for a in np.linspace(WALL_T, a_s, 12)]
    slab(pts_out, pts_in, -lat)


#: 外の蛇腹と腰の断面（壁の面から外への出, 高さ）。ホールの外壁の lathe と同じ形
EXT_CORNICE = [(-0.02, WALL_H + 0.25), (0.35, WALL_H + 0.35), (0.5, WALL_H + 0.6), (0.5, WALL_H + 0.78), (0.2, WALL_H + 0.9)]
EXT_PLINTH = [(0.06, WATER_Y - 0.4), (0.28, WATER_Y - 0.2), (0.28, DECK_Y + 0.9), (0.02, DECK_Y + 1.05)]


def extrude_profile(p0, p1, out_n, profile, caps: bool = True):
    """壁の面の上の直線 p0 → p1（水平）に沿って、断面 profile（外への出, 高さ）を押し出す（蛇腹・腰）。面は外を向く"""
    verts = []
    for p in (p0, p1):
        for off, y in profile:
            verts.append(np.array([p[0], y, p[2]]) + out_n * off)
    verts = np.array(verts)
    m = len(profile)
    faces = []
    for k in range(m - 1):
        q = (k, k + 1, m + k + 1, m + k)
        c = verts[list(q)].mean(0)
        want = out_n * 1.0 + np.array([0.0, (c[1] - (profile[0][1] + profile[-1][1]) / 2) * 0.01, 0.0])
        faces.append(orient(verts, [q], want)[0])
    if caps:
        along = np.asarray(p1) - np.asarray(p0)
        along[1] = 0.0
        along /= np.linalg.norm(along)
        for base, want in ((0, -along), (m, along)):
            cap = list(range(base, base + m))
            faces.append(orient(verts, [tuple(cap)], want)[0])
    return verts, faces


def gatehouse_dressing(bay: Bay, h: dict, ext: Builder, ext_dark: Builder, ext_brass: Builder) -> None:
    """水門の館を、ホールの外壁と同じ言葉で飾る: 正面と北の返しに外の蛇腹と腰を回し、水路の口のまわりに暗い石の額縁と
    真鍮の輪を重ねる（夜明けの岸から、ドームの建物の水門に見えるように）"""
    d, lat = bay.d, bay.l
    south = -(CANAL_HALF + CANAL_SKIN)

    def w(a: float, l: float) -> np.ndarray:
        return bay.front + d * a + lat * l

    cx, cz, r_out = h['cx'], h['cz'], h['r_out']

    def reach(l: float, rr: float) -> float:
        lo, hi = -40.0, 16.0
        for _ in range(40):
            mid = (lo + hi) / 2
            p = w(mid, l)
            if math.hypot(p[0] - cx, p[2] - cz) < rr:
                hi = mid
            else:
                lo = mid
        return hi

    a_n = reach(BAY_N, r_out)
    a_s = reach(south, r_out)
    # 蛇腹: 正面（南の端から北の角の少し先まで）、北の返し（角から外壁まで）、南の返し
    ext.add(*extrude_profile(w(0.0, south - 0.5), w(0.0, BAY_N + 0.5), -d, EXT_CORNICE))
    ext.add(*extrude_profile(w(-0.5, BAY_N), w(a_n + 0.3, BAY_N), -lat, EXT_CORNICE))
    ext.add(*extrude_profile(w(-0.5, south), w(a_s + 0.3, south), -lat, EXT_CORNICE))
    # 腰: 水路の口を避けて
    edge = CANAL_HALF + 1.0
    ext.add(*extrude_profile(w(0.0, south - 0.3), w(0.0, -edge), -d, EXT_PLINTH))
    ext.add(*extrude_profile(w(0.0, edge), w(0.0, BAY_N + 0.3), -d, EXT_PLINTH))
    ext.add(*extrude_profile(w(-0.3, BAY_N), w(a_n + 0.3, BAY_N), -lat, EXT_PLINTH))
    ext.add(*extrude_profile(w(-0.3, south), w(a_s + 0.3, south), -lat, EXT_PLINTH))
    # 水路の口の額縁（壁から 0.14m 出た暗い石のアーチ）と、その外の縁の真鍮の輪
    frame_w = 0.95
    inner = canal_arch_path(w(-0.14, 0.0), lat, CANAL_HALF, CANAL_TOP)
    outer = canal_arch_path(w(-0.14, 0.0), lat, CANAL_HALF + frame_w, CANAL_TOP + frame_w)
    inner_back = inner + d * 0.14
    outer_back = outer + d * 0.14
    n = len(inner)
    verts = np.vstack([inner, outer, inner_back, outer_back])
    faces = []
    for i in range(n - 1):
        faces += orient(verts, [(i, i + 1, n + i + 1, n + i)], -d)
        # 外の縁（外を向く）と内の縁（水路の軸を向く）
        c_o = (outer[i] + outer[i + 1]) / 2
        out_dir = c_o - (w(0.0, 0.0) + np.array([0, CANAL_TOP * 0.4, 0]))
        out_dir -= d * np.dot(out_dir, d)
        faces += orient(verts, [(n + i, n + i + 1, 3 * n + i + 1, 3 * n + i)], out_dir)
        faces += orient(verts, [(i, i + 1, 2 * n + i + 1, 2 * n + i)], -out_dir)
    ext_dark.add(verts, faces)
    ext_brass.add(*tube(canal_arch_path(w(-0.17, 0.0), lat, CANAL_HALF + frame_w - 0.05, CANAL_TOP + frame_w - 0.05), 0.06, 8))
    ext_brass.add(*tube(canal_arch_path(w(-0.17, 0.0), lat, CANAL_HALF + 0.06, CANAL_TOP + 0.06), 0.05, 8))
    # 額縁の要石（アーチの頂の真鍮の飾り）
    key = w(-0.2, 0.0) + np.array([0, CANAL_TOP + frame_w * 0.5, 0])
    ext_brass.add(*uv_sphere(key, 0.28, 16, 10))


def append_geometry(ob, verts_three, faces, smooth: bool = True) -> None:
    """できている物に面を足す（three.js の世界の座標で）"""
    from mathutils import Vector
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    inv = ob.matrix_world.inverted()
    vs = [bm.verts.new(inv @ Vector(to_blender(np.asarray(v)).tolist())) for v in verts_three]
    bm.verts.ensure_lookup_table()
    for f in faces:
        try:
            face = bm.faces.new([vs[i] for i in f])
        except ValueError:
            continue
        face.smooth = smooth
        face.material_index = 0
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def orient(verts: np.ndarray, faces, want) -> list:
    out = []
    for f in faces:
        q = list(f)
        nrm = np.cross(verts[q[1]] - verts[q[0]], verts[q[2]] - verts[q[0]])
        if np.linalg.norm(nrm) < 1e-12 and len(q) > 3:
            nrm = np.cross(verts[q[2]] - verts[q[0]], verts[q[3]] - verts[q[0]])
        out.append(tuple(q) if np.dot(nrm, want) > 0 else tuple(reversed(q)))
    return out


WINDOW_R = 1.25
#: ドームのガラスの帯（ドームの半径に対する、内と外の半径の割合）
DOME_GLASS = (0.4, 0.66)
WINDOW_Y = WALL_H - 3.1


def window_angles(h: dict, rail: Rail, bay) -> list[float]:
    """高窓の角度（16 の候補のうち、開口の近くと水門の湾にかかる物を除く）"""
    out = []
    for k in range(16):
        a = 2 * math.pi * (k + 0.25) / 16
        c = hall_point(h, a, h['r_in'] + 0.05, WINDOW_Y)
        if near_opening(h, rail, c, 3.0) or bay.inside(c, WINDOW_R + 1.0):
            continue
        out.append(a)
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


def opening_keep(quad, h: dict, rail: Rail, gate_door: bool = True) -> bool:
    """壁の升目を残すか（開口の中の升目は落とす）。quad は升目の頂点（three.js の座標）。
    北の門: 中心がレールから GATE_OPEN_R 以内。南の入口: 中心が幅と高さの中（上は半円）。
    東の水路: 頂点のどれかが水路の内の断面の中（穴は断面より少し大きくなるが、水路の厚い皮の中に隠れる）"""
    quad = np.asarray(quad, dtype=np.float64)
    c = quad.mean(0)
    key = 'gate_pts'
    if key not in h:
        s_plat1 = rail.sections['platform'][1]
        h[key] = rail.samples(s_plat1 - 3.0, s_plat1 + 3.0, 0.1)
        h['door'] = south_door(h, rail)
        h['bay'] = water_gate_bay(rail, h)
    if gate_door and np.min(np.linalg.norm(h[key] - c, axis=1)) < GATE_OPEN_R:
        return False
    door_c, door_out = h['door']
    door_side = np.array([-door_out[2], 0, door_out[0]])
    dx = abs(float(np.dot(c - door_c, door_side)))
    if gate_door and dx < SOUTH_DOOR_HALF and float(np.dot(c - door_c, door_out)) > -3:
        if c[1] < SOUTH_DOOR_TOP - SOUTH_DOOR_HALF + math.sqrt(max(0.0, SOUTH_DOOR_HALF ** 2 - dx * dx)):
            return False
    bay = h['bay']
    for q in quad:
        a, lat = bay.local(q)
        if -0.5 < a < CANAL_LEN + 0.5 and abs(lat) < CANAL_HALF and q[1] < canal_y_custom(lat, CANAL_HALF, CANAL_TOP):
            return False
    return True


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


#: 水路の長さ（水門の館の正面からホールの中へ、m）と、皮の厚み（壁の丸くない穴を隠せる厚さ）
CANAL_LEN = 6.2
CANAL_SKIN = 0.9


def canal_shell(c0, fwd, right, length: float):
    """水路の面: 内側（両側の壁と円い天井、軸の方を向く）と、外の皮（厚み CANAL_SKIN、外を向く）と、ホールの側の口の縁。
    c0 は水門の館の正面（岸の側の端）、fwd へ length 進むとホールの口。外の皮のうち見えない面は見えない面の削除で消える"""
    nu, nv = 24, 33
    verts = []
    faces = []
    skins = ((CANAL_HALF, CANAL_TOP, 1.0), (CANAL_HALF + CANAL_SKIN, CANAL_TOP + CANAL_SKIN, -1.0))
    for half, top, sign in skins:
        base_i = len(verts)
        for j in range(nu):
            t = length * j / (nu - 1)
            base = c0 + fwd * t
            # 断面: 縦の側壁（水の下から迫り元まで）と円い天井。側壁を垂直にして、正面の穴の縁と揃える
            for i in range(nv):
                if i in (0, nv - 1):
                    d, y = (-half if i == 0 else half), WATER_Y - 0.3
                else:
                    d = -half + 2 * half * (i - 1) / (nv - 3)
                    y = canal_y_custom(d, half, top)
                verts.append(base + right * d + np.array([0, y, 0]))
        for j in range(nu - 1):
            for i in range(nv - 1):
                q = (base_i + j * nv + i, base_i + (j + 1) * nv + i, base_i + (j + 1) * nv + i + 1, base_i + j * nv + i + 1)
                faces.append((q, sign))
    verts = np.array(verts)
    n_skin = nu * nv
    # 口の縁（内と外の皮をつなぐ、ホールの方を向く）
    jm = nu - 1
    for i in range(nv - 1):
        a0 = jm * nv + i
        faces.append(((a0, a0 + 1, n_skin + a0 + 1, n_skin + a0), 0.0))
    out = []
    axis_y = CANAL_TOP * 0.45
    for q, sign in faces:
        c = verts[list(q)].mean(0)
        nrm = np.cross(verts[q[1]] - verts[q[0]], verts[q[2]] - verts[q[0]])
        if np.linalg.norm(nrm) < 1e-12:
            nrm = np.cross(verts[q[2]] - verts[q[0]], verts[q[3]] - verts[q[0]])
        if sign == 0.0:
            want = fwd
        else:
            rel = c - c0
            lat = float(np.dot(rel, right))
            to_axis = -right * lat + np.array([0.0, axis_y - c[1], 0.0])
            want = to_axis * sign
        out.append(tuple(q) if np.dot(nrm, want) > 0 else tuple(reversed(q)))
    return verts, out


def canal_water(c0, fwd, right, length: float):
    """水路の床の水面（皮の外まで。ホールの水面と重なる所も同じ高さ・同じ材質なので見分けがつかない）"""
    half = CANAL_HALF + CANAL_SKIN * 0.5
    nu, nv = 13, 9
    verts = []
    for j in range(nu):
        for i in range(nv):
            verts.append(c0 + fwd * (length * j / (nu - 1)) + right * (-half + 2 * half * i / (nv - 1)) + np.array([0, WATER_Y, 0]))
    verts = np.array(verts)
    faces = [(j * nv + i, (j + 1) * nv + i, (j + 1) * nv + i + 1, j * nv + i + 1) for j in range(nu - 1) for i in range(nv - 1)]
    return verts, orient(verts, faces, np.array([0.0, 1.0, 0.0]))


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

def build_bubbles(rail: Rail, h: dict, coll, rng: random.Random, objs: list, dome_y_at, bay):
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
            # 揺れの余裕（触れると 0.25m 振れる。TS の SWING_REACH）も足す
            if box_distance(lo, hi_t, clear_pts).min() >= NEED + 0.3 and not bay.inside(c, 1.0):
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
        if box_distance(lo, hi_t, clear_pts).min() < NEED + 0.15 or bay.inside(c, scale + 0.5):
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
