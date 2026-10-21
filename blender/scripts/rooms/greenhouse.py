"""第1室「朝露の温室」（1:00〜3:30）。このスクリプトが原本（blender/scenes/greenhouse.blend と glb・ライトマップはその書き出し）。

    pnpm blender blender/scripts/rooms/greenhouse.py            # 造形 → 見えない面の削除 → 焼き込み → glb
    pnpm blender blender/scripts/rooms/greenhouse.py -- --fast  # 焼き込みのサンプルを減らした下書き

絵コンテ（入口で視界が開ける一枚絵）:
  膜を抜けると、高さ 8m の北の妻壁の口から、白い鉄骨とガラスの巨大な温室を見下ろす。
  正面へ長い身廊が遠くまで続き、白い鉄のアーチが規則正しく奥へ重なる。正面の低い朝日が逆光で差し込み、
  鉄骨の影が床に長い格子を描いて手前へ伸びる。ガラスの椰子と木生羊歯が両側に立ち並び、葉先の露が光る。
  床の小道はレールの真下を S 字に縫い、いちばん奥、池のほとりに、人の背丈の何倍もあるガラスの蕾が待っている。
  見どころ（2:40）: ゴンドラが池へ近づくと、蕾が光を集めながら頭上で開き、直後に露が一斉に落ちて床で鳴る。

形（three.js の座標）:
  - 平面は超楕円（角のない長い形）。北の端は乗り場の外壁のすぐ外、南の端は雨の回廊への膜のすぐ外。
    幅 72m、長さ約 150m、壁 12m、天井の頂 26m。屋根は横断面が楕円の弧で、両端へ向かって低くなる（泡のような丸い形）。
  - 光: 南の空の低い朝日（逆光）と、明るい空。ガラスの殻は光を通す。植物の影は色付きで半分通す。
  - 植物はインスタンス（11 種の元の形と、置く変換を extras に書く）。葉先の露の位置も元の形ごとに書く。
"""
from __future__ import annotations

import math
import os
import random
import sys
import zlib

sys.dont_write_bytecode = True  # __pycache__ を作らない（リポジトリを汚さない）
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402

from rooms import platform as kit  # noqa: E402
from rooms.platform import Builder, NEED, box_distance, instance_box, lathe, material, matrix_three, mesh_object, tube, uv_sphere  # noqa: E402

ROOM = 'greenhouse'
#: 平面の半幅、超楕円の指数、壁の高さ、屋根の高さ（中央での立ち上がり）
HALF_W = 36.0
SUPER_N = 2.6
WALL_H = 12.0
ROOF_RISE = 14.0
#: 入口と出口の開口の半径
GATE_R = 3.3
#: 出口の妻壁（平らなガラスの面）を置く距離（区間の終わりから、m）。これより先は切り落とす
END_AT = 0.9
#: 朝日の進む向き（three.js）。南（-Z）の低い空から、北と少し西へ（入口から見て逆光）
SUN_DIR = np.array([-0.32, -0.40, 0.86])
SUN_DIR = SUN_DIR / np.linalg.norm(SUN_DIR)


class Shell:
    """温室の平面と形。u は北の端 → 南の端の軸、v は横"""

    def __init__(self, rail: kit.Rail):
        s0, s1 = rail.sections['greenhouse']
        # 部屋の境目（ADR-0013）: 入る側は区間の始まり +1m 以降、出る側は区間の終わり +1m まで。
        # 南の端は出口の向きに斜めに交わるので、少し先まで作ってから出口の面（END_AT）で平らに切る
        n_tip = rail.point(s0 + 1.05)
        s_tip = rail.point(s1 + 3.0)
        self.n_tip, self.s_tip = n_tip, s_tip
        a = np.array([n_tip[0], 0, n_tip[2]])
        b = np.array([s_tip[0], 0, s_tip[2]])
        self.c = (a + b) / 2
        d = b - a
        self.b = float(np.linalg.norm(d)) / 2
        self.u = d / np.linalg.norm(d)
        self.v = np.array([-self.u[2], 0.0, self.u[0]])
        self.a = HALF_W

    def local(self, p) -> tuple[float, float]:
        q = np.asarray(p, dtype=np.float64) - self.c
        return float(np.dot(q, self.u)), float(np.dot(q, self.v))

    def world(self, u: float, v: float, y: float = 0.0) -> np.ndarray:
        return self.c + self.u * u + self.v * v + np.array([0.0, y, 0.0])

    def half_width(self, u: float) -> float:
        t = min(1.0, abs(u) / self.b)
        return self.a * max(0.0, 1.0 - t ** SUPER_N) ** (1.0 / SUPER_N)

    def inside(self, p, margin: float = 0.0) -> bool:
        u, v = self.local(p)
        if abs(u) > self.b - margin:
            return False
        return abs(v) < self.half_width(u) - margin

    def roof_y(self, u: float, v: float) -> float:
        w = self.half_width(u)
        if w <= 1e-6:
            return WALL_H
        return WALL_H + ROOF_RISE * (w / self.a) * math.sqrt(max(0.0, 1.0 - (v / w) ** 2))

    def profile(self, u: float, n_roof: int = 36) -> list[tuple[float, float]]:
        """横断面 (v, y): 左の床 → 左の壁 → 屋根の弧 → 右の壁 → 右の床"""
        w = self.half_width(u)
        hr = ROOF_RISE * (w / self.a)
        pts = [(-w, -0.2), (-w, WALL_H * 0.34), (-w, WALL_H * 0.67), (-w, WALL_H)]
        for k in range(1, n_roof):
            bta = math.pi * k / n_roof
            pts.append((-w * math.cos(bta), WALL_H + hr * math.sin(bta)))
        pts += [(w, WALL_H), (w, WALL_H * 0.67), (w, WALL_H * 0.34), (w, -0.2)]
        return pts


# ═══════════════════════════════════════════════════════════════════════
# 植物の元の形（原点は地面の根元、Y が上、three.js の座標）
# ═══════════════════════════════════════════════════════════════════════
def blade(length: float, width: float, nl: int, nw: int, shape, droop: float = 0.3, fold: float = 0.15, thick: float = 0.012, twist: float = 0.0, comb: float = 0.0):
    """葉の身（根元が原点、+X へ伸びる、表は +Y）。shape(t) は 0〜1 の幅の形。厚みのある表と裏。
    droop は先の垂れ（長さに対する割合）、fold は中の筋の折れ、comb は羽状の葉の切れ込み（幅を波打たせる）"""
    verts = []
    for side in (1, -1):
        for i in range(nl + 1):
            t = i / nl
            hw = width / 2 * shape(t)
            if comb > 0:
                hw *= 1.0 - comb * (0.5 + 0.5 * math.cos(t * math.pi * 22))
            x = length * t
            y = -droop * length * t * t
            for j in range(nw + 1):
                s = -1 + 2 * j / nw
                z = s * hw
                yy = y + fold * abs(s) * hw + side * thick * 0.5 * (1 - t * 0.6)
                # ねじれ（先へ行くほど身が回る）
                ang = twist * t
                zz = z * math.cos(ang)
                yy += z * math.sin(ang)
                verts.append((x, yy, zz))
    faces = []
    row = nw + 1
    half = (nl + 1) * row
    for side in (0, 1):
        base = side * half
        for i in range(nl):
            for j in range(nw):
                a = base + i * row + j
                q = (a, a + row, a + row + 1, a + 1)
                faces.append(q if side == 0 else tuple(reversed(q)))
    # 縁（表と裏をつなぐ）
    for i in range(nl):
        for j in (0, nw):
            a = i * row + j
            b = half + i * row + j
            q = (a, a + row, b + row, b)
            faces.append(q if j == nw else tuple(reversed(q)))
    tip = verts[nl * row + nw // 2]
    return np.array(verts), faces, np.array(tip)


def place(verts, origin, yaw: float, pitch: float, roll: float = 0.0):
    """局所の形を回して origin へ（yaw: Y まわり、pitch: 身を持ち上げる角度、roll: 身の軸まわり）"""
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cr, sr = math.cos(roll), math.sin(roll)
    rr = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
    rp = np.array([[cp, -sp, 0], [sp, cp, 0], [0, 0, 1]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    m = ry @ rp @ rr
    return np.asarray(verts) @ m.T + np.asarray(origin)


def lance(t: float) -> float:
    return math.sin(math.pi * min(1.0, t)) ** 0.8


def paddle(t: float) -> float:
    return min(1.0, (t * 6) ** 0.5) * (1 - t ** 6) ** 0.5


def heart(t: float) -> float:
    return math.sin(math.pi * (0.12 + 0.88 * t) ** 0.8) * (1.05 - t * 0.2)


def frond_shape(t: float) -> float:
    return math.sin(math.pi * t) ** 0.6


class Proto:
    """元の形: 材質ごとの頂点と面、葉先の点（露）"""

    def __init__(self, name: str):
        self.name = name
        self.parts: dict[str, Builder] = {}
        self.tips: list[np.ndarray] = []

    def add(self, mat: str, v, f):
        self.parts.setdefault(mat, Builder()).add(v, f)

    def leaf(self, mat: str, origin, yaw, pitch, roll, length, width, nl, nw, shape, tip=True, **kw):
        v, f, t = blade(length, width, nl, nw, shape, **kw)
        self.add(mat, place(v, origin, yaw, pitch, roll), f)
        if tip:
            self.tips.append(place(t[None, :], origin, yaw, pitch, roll)[0] + np.array([0, -0.025, 0]))


def stem_path(p0, p1, bend, n: int = 10):
    p0, p1, bend = np.asarray(p0, float), np.asarray(p1, float), np.asarray(bend, float)
    return np.array([p0 + (p1 - p0) * t + bend * math.sin(math.pi * t) for t in np.linspace(0, 1, n)])


def make_palm(rng: random.Random) -> Proto:
    p = Proto('palm')
    h = 9.0
    path = stem_path((0, 0, 0), (0.6, h, 0.2), (0.5, 0, -0.2), 18)
    r = np.linspace(0.32, 0.17, len(path)) * (1 + 0.08 * np.sin(np.arange(len(path)) * 2.4))
    p.add('trunk', *kit.tube(path, r, 12))
    top = path[-1]
    for k in range(13):
        yaw = 2 * math.pi * k / 13 + rng.uniform(-0.15, 0.15)
        pitch = rng.uniform(0.25, 0.75)
        p.leaf('palm_leaf', top, yaw, pitch, rng.uniform(-0.2, 0.2), rng.uniform(3.8, 4.8), 1.15, 12, 6, frond_shape, droop=0.45, fold=0.25, comb=0.55, thick=0.01)
    return p


def make_treefern(rng: random.Random) -> Proto:
    p = Proto('treefern')
    h = 3.6
    path = stem_path((0, 0, 0), (0.2, h, -0.1), (0.15, 0, 0.1), 12)
    p.add('trunk', *kit.tube(path, np.linspace(0.24, 0.19, len(path)), 10))
    top = path[-1]
    for k in range(11):
        yaw = 2 * math.pi * k / 11 + rng.uniform(-0.2, 0.2)
        p.leaf('fern_leaf', top, yaw, rng.uniform(0.35, 0.95), 0.0, rng.uniform(2.2, 2.9), 0.75, 12, 4, frond_shape, droop=0.5, fold=0.2, comb=0.45, thick=0.008)
    # 中心の巻いた若い芽
    p.add('fern_leaf', *uv_sphere(top + np.array([0, 0.18, 0]), 0.12, 10, 6))
    return p


def make_banana(rng: random.Random) -> Proto:
    p = Proto('banana')
    h = 2.2
    p.add('trunk', *kit.tube(np.array([[0, 0, 0], [0, h, 0]]), 0.17, 10))
    for k in range(8):
        yaw = 2 * math.pi * k / 8 * 0.95 + rng.uniform(-0.2, 0.2)
        base = np.array([0, h * rng.uniform(0.75, 1.0), 0])
        p.leaf('banana_leaf', base, yaw, rng.uniform(0.5, 1.1), rng.uniform(-0.3, 0.3), rng.uniform(2.1, 2.7), rng.uniform(0.62, 0.78), 12, 6, paddle, droop=0.35, fold=0.2, thick=0.01, twist=0.3)
    return p


def make_monstera(rng: random.Random) -> Proto:
    p = Proto('monstera')
    for k in range(7):
        yaw = 2 * math.pi * k / 7 + rng.uniform(-0.3, 0.3)
        hgt = rng.uniform(0.7, 1.5)
        out = rng.uniform(0.3, 0.8)
        tip = np.array([math.cos(yaw) * out, hgt, -math.sin(yaw) * out])
        p.add('stem', *kit.tube(stem_path((0, 0, 0), tip, (0, 0.1, 0), 6), 0.025, 5, caps=False))
        p.leaf('monstera_leaf', tip, yaw, rng.uniform(-0.1, 0.35), rng.uniform(-0.3, 0.3), rng.uniform(0.75, 1.0), rng.uniform(0.7, 0.85), 9, 6, heart, droop=0.25, fold=0.08, thick=0.012)
    return p


def make_fern(rng: random.Random) -> Proto:
    p = Proto('fern')
    for k in range(8):
        yaw = 2 * math.pi * k / 8 + rng.uniform(-0.25, 0.25)
        p.leaf('fern_leaf', (0, 0.05, 0), yaw, rng.uniform(0.7, 1.2), 0.0, rng.uniform(0.9, 1.25), 0.36, 10, 2, frond_shape, droop=0.6, fold=0.15, comb=0.5, thick=0.006)
    return p


def make_calla(rng: random.Random) -> Proto:
    p = Proto('calla')
    for k in range(4):
        yaw = 2 * math.pi * k / 4 + rng.uniform(-0.3, 0.3)
        p.leaf('leaf_light', (0, 0.02, 0), yaw, rng.uniform(0.9, 1.25), 0.0, rng.uniform(0.6, 0.75), 0.24, 8, 4, lance, droop=0.25, thick=0.008)
    for k in range(3):
        a = 2 * math.pi * k / 3 + 0.4
        top = np.array([math.cos(a) * 0.12, rng.uniform(0.75, 1.0), -math.sin(a) * 0.12])
        p.add('stem', *kit.tube(stem_path((0, 0, 0), top, (0.03, 0, 0), 6), 0.012, 5, caps=False))
        # 仏炎苞: 巻いた白い花弁（漏斗）
        prof = [(0.01, 0.0), (0.035, 0.05), (0.06, 0.12), (0.085, 0.2), (0.1, 0.26)]
        v, f = lathe(prof, 14, (0, 0, 0), a0=0.0, a1=1.8 * math.pi)
        v = place(v, top, a, -0.35)
        p.add('petal_white', v, f + [tuple(reversed(x)) for x in f])
        p.tips.append(top + np.array([0, 0.22, 0]))
    return p


def make_tulip(rng: random.Random) -> Proto:
    p = Proto('tulip')
    for k in range(2):
        yaw = math.pi * k + rng.uniform(-0.4, 0.4)
        p.leaf('leaf_light', (0, 0.02, 0), yaw, rng.uniform(1.0, 1.3), 0.0, 0.45, 0.12, 6, 2, lance, droop=0.2, thick=0.006, tip=False)
    for k in range(3):
        a = 2 * math.pi * k / 3
        top = np.array([math.cos(a) * 0.1, rng.uniform(0.45, 0.65), -math.sin(a) * 0.1])
        p.add('stem', *kit.tube(stem_path((0, 0, 0), top, (0.02, 0, 0.01), 5), 0.01, 5, caps=False))
        for j in range(6):
            pa = 2 * math.pi * j / 6
            v, f, _ = blade(0.11, 0.07, 4, 2, lance, droop=-0.35, fold=0.4, thick=0.004)
            p.add('petal_pink', place(v, top, pa, 1.15), f)
        p.tips.append(top + np.array([0, 0.1, 0]))
    return p


def make_grass(rng: random.Random) -> Proto:
    p = Proto('grass')
    for k in range(14):
        yaw = rng.uniform(0, 2 * math.pi)
        p.leaf('leaf_light', (rng.uniform(-0.08, 0.08), 0, rng.uniform(-0.08, 0.08)), yaw, rng.uniform(1.0, 1.45), 0.0, rng.uniform(0.6, 1.1), 0.04, 6, 1, lance,
               droop=0.4, thick=0.004, tip=k % 5 == 0)
    return p


def make_succulent(rng: random.Random) -> Proto:
    p = Proto('succulent')
    for ring, (n, pitch, ln) in enumerate(((7, 0.25, 0.32), (6, 0.6, 0.26), (4, 1.0, 0.18))):
        for k in range(n):
            yaw = 2 * math.pi * k / n + ring * 0.4
            p.leaf('succulent_leaf', (0, 0.03, 0), yaw, pitch, 0.0, ln, 0.12, 5, 2, lance, droop=-0.1, fold=0.5, thick=0.04, tip=ring == 2)
    return p


def make_vine(rng: random.Random) -> Proto:
    """天井から垂れるつる（原点は吊る点、下へ 7.5m）"""
    p = Proto('vine')
    n = 22
    path = np.array([[0.25 * math.sin(i * 0.5), -7.5 * i / (n - 1), 0.2 * math.cos(i * 0.4)] for i in range(n)])
    p.add('stem', *kit.tube(path, 0.015, 4, caps=False))
    for i in range(2, n, 1):
        yaw = i * 2.1
        p.leaf('fern_leaf', path[i], yaw, -0.6, 0.0, 0.26, 0.17, 4, 2, heart, droop=0.2, thick=0.006, tip=i % 4 == 0)
    return p


def make_lilypad(rng: random.Random) -> Proto:
    p = Proto('lilypad')
    for k in range(3):
        c = np.array([rng.uniform(-0.6, 0.6), 0.0, rng.uniform(-0.6, 0.6)])
        r = rng.uniform(0.35, 0.6)
        ang = np.linspace(0.25, 2 * math.pi - 0.25, 20)
        v = [c + np.array([0, 0.01, 0])] + [c + np.array([math.cos(a) * r, 0.0, math.sin(a) * r]) for a in ang]
        f = [(0, i + 2, i + 1) for i in range(len(ang) - 1)]
        p.add('lily_leaf', np.array(v), f)
    # 小さな蓮の花
    for j in range(8):
        pa = 2 * math.pi * j / 8
        v, f, _ = blade(0.16, 0.08, 4, 2, lance, droop=-0.6, fold=0.4, thick=0.004)
        p.add('petal_pink', place(v, (0.0, 0.03, 0.0), pa, 0.7), f)
    return p


PLANTS = {
    # 名前: (作る関数, 数, 植える所の種類, 大きさの幅)
    'palm': (make_palm, 22, 'tall', (1.0, 1.45)),
    'treefern': (make_treefern, 30, 'mid', (1.1, 1.55)),
    'banana': (make_banana, 30, 'mid', (1.1, 1.6)),
    'monstera': (make_monstera, 60, 'low', (1.2, 1.9)),
    'fern': (make_fern, 90, 'low', (1.0, 1.6)),
    'calla': (make_calla, 70, 'edge', (1.0, 1.4)),
    'tulip': (make_tulip, 80, 'edge', (1.0, 1.4)),
    'grass': (make_grass, 80, 'edge', (1.0, 1.5)),
    'succulent': (make_succulent, 40, 'edge', (1.0, 1.6)),
    'vine': (make_vine, 34, 'hang', (0.8, 1.1)),
    'lilypad': (make_lilypad, 22, 'pond', (0.9, 1.4)),
}

#: 材質（ガラスの種類と色）。glb の材質の extras になり、TS が core のガラスに差し替える
GLASS_MATS = {
    'trunk': ('tinted', '#4f7f6c', 0.7),
    'palm_leaf': ('tinted', '#2f9e5c', 0.68),
    'fern_leaf': ('tinted', '#21894f', 0.7),
    'banana_leaf': ('tinted', '#5fb84a', 0.66),
    'monstera_leaf': ('tinted', '#1c7a4b', 0.72),
    'leaf_light': ('tinted', '#7cc25a', 0.66),
    'succulent_leaf': ('tinted', '#58a88e', 0.7),
    'lily_leaf': ('tinted', '#2f9065', 0.72),
    'stem': ('tinted', '#5aa676', 0.66),
    'petal_white': ('milky', '#f4efe6', 0.5),
    'petal_pink': ('tinted', '#f0a7b8', 0.5),
}


def glass_material(name: str):
    kind, color, opacity = GLASS_MATS[name]
    m = material(f'greenhouse.{name}', color, 0.1, shadow_tint=True)
    m['glass'] = kind
    m['glass_color'] = color
    m['glass_opacity'] = opacity
    return m


def build_proto(p: Proto, coll) -> object:
    mats = [glass_material(k) for k in p.parts]
    b = Builder()
    for i, (k, part) in enumerate(p.parts.items()):
        verts = np.concatenate(part.v)
        b.add(verts, part.f, mat_index=i)
    ob = b.build(f'greenhouse.proto_{p.name}', None, coll, smooth=True, mats=mats, props={'role': 'proto', 'clearance_exempt': True})
    ob['tips'] = [round(float(x), 4) for t in p.tips for x in t]
    return ob


# ═══════════════════════════════════════════════════════════════════════
def build_greenhouse(rail: kit.Rail, fast: bool) -> None:
    kit.reset_scene()
    rng = random.Random(1021)
    coll = kit.collection(ROOM)
    sh = Shell(rail)
    s0, s1 = rail.sections['greenhouse']
    objs: list = []
    bake: list = []
    clear_pts = rail.samples(s0, s1, 0.25)
    print(f'shell: 中心 ({sh.c[0]:.1f}, {sh.c[2]:.1f}) 長さ {2 * sh.b:.1f}m 幅 {2 * sh.a:.1f}m')

    m_floor = material('greenhouse.floor', '#c4bcab', 0.7)
    m_path = material('greenhouse.path', '#ddd3bd', 0.7)
    m_curb = material('greenhouse.curb', '#e9e6df', 0.6)
    m_soil = material('greenhouse.soil', '#9fbfae', 0.8)
    m_iron = material('greenhouse.iron', '#f1f0ea', 0.5)
    m_glass = material('greenhouse.glass', '#eef6ee', 0.05, alpha=0.08)
    m_water = material('greenhouse.water', '#6f8f86', 0.1)

    floor = Builder()
    path_b = Builder()
    curb = Builder()
    soil = Builder()
    iron = Builder()
    bars = iron  # 細い桟も同じ白い鉄（描く物の数を減らす）

    # ── ガラスの殻（内側の面）。入口と出口の開口を抜く ──
    gate_pts = np.vstack([rail.samples(s0 - 2.0, s0 + 3.5, 0.1), rail.samples(s1 - 3.5, s1 + 2.0, 0.1)])
    alphas = np.linspace(-math.pi / 2, math.pi / 2, 96)
    prof0 = sh.profile(0.0)
    npf = len(prof0)
    verts = []
    for al in alphas:
        u = sh.b * math.sin(al) * 0.9995
        for (vv, y) in sh.profile(u):
            verts.append(sh.world(u, vv, y))
    verts = np.array(verts)
    faces = []
    for i in range(len(alphas) - 1):
        for j in range(npf - 1):
            q = (i * npf + j, i * npf + j + 1, (i + 1) * npf + j + 1, (i + 1) * npf + j)
            faces.append(q)
    axis_c = lambda c: sh.world(sh.local(c)[0] * 0.98, 0.0, WALL_H * 0.5)  # noqa: E731
    faces = orient_in(verts, faces, axis_c)
    keep = [np.min(np.linalg.norm(gate_pts - verts[list(f)].mean(0), axis=1)) > GATE_R for f in faces]
    ob = mesh_object('greenhouse.shell', verts, [f for f, k in zip(faces, keep) if k], m_glass, coll, smooth=True,
                     props={'glass': 'clear', 'glass_color': '#f2f8f0', 'glass_opacity': 0.035, 'glass_rim': 0.55,
                            # ガラスの殻は空と同じ外の囲い（物の箱は建物全体を含む）。面までの本当の距離を確かめて記録する
                            'clearance_exempt': True, 'check_true_clearance': True})
    objs.append(ob)
    shell_obj = ob

    # ── 白い鉄骨: 横断のアーチ、縦の母屋、細い桟 ──
    rib_us = np.arange(-sh.b + 4.0, sh.b - 3.0, 6.9)
    for u in rib_us:
        pr = sh.profile(u, 40)[1:-1]
        pts = np.array([sh.world(u, vv * 0.995, y) for vv, y in pr])
        iron.add(*tube(pts, 0.1, 8))
        # アーチの付け根の台座
        for side in (-1, 1):
            w = sh.half_width(u)
            iron.add(*lathe([(0.0, 0.0), (0.26, 0.0), (0.26, 0.45), (0.16, 0.6), (0.12, 0.6)], 12, sh.world(u, side * (w - 0.18), 0)))
    us = np.array([sh.b * math.sin(a) * 0.98 for a in np.linspace(-math.pi / 2, math.pi / 2, 120)])
    for frac in (-1.0, -0.82, -0.55, -0.22, 0.22, 0.55, 0.82, 1.0):
        pts = []
        for u in us:
            w = sh.half_width(u)
            if frac in (-1.0, 1.0):
                pts.append(sh.world(u, frac * w * 0.995, WALL_H))
            else:
                bta = math.acos(frac)
                pts.append(sh.world(u, -w * math.cos(bta) * 0.995, WALL_H + ROOF_RISE * (w / sh.a) * math.sin(bta) - 0.04))
        iron.add(*tube(np.array(pts), 0.07, 6, caps=False))
    ridge = np.array([sh.world(u, 0.0, sh.roof_y(u, 0.0) - 0.05) for u in us])
    iron.add(*tube(ridge, 0.09, 6, caps=False))
    for y in (4.0, 8.0):
        for side in (-1, 1):
            pts = np.array([sh.world(u, side * sh.half_width(u) * 0.997, y) for u in us])
            iron.add(*tube(pts, 0.05, 6, caps=False))
    # 細い桟（ガラスの割り付け）: 横は 2.3m ごと、縦は屋根の弧に沿って
    for u in np.arange(-sh.b + 4.0 + 2.3, sh.b - 3.0, 2.3):
        if np.min(np.abs(rib_us - u)) < 0.5:
            continue
        pr = sh.profile(u, 30)[1:-1]
        bars.add(*tube(np.array([sh.world(u, vv * 0.993, y) for vv, y in pr]), 0.03, 4, caps=False))
    for frac in np.linspace(-0.92, 0.92, 15):
        if min(abs(frac - f) for f in (-0.82, -0.55, -0.22, 0.22, 0.55, 0.82)) < 0.05:
            continue
        bta = math.acos(frac)
        pts = [sh.world(u, -sh.half_width(u) * math.cos(bta) * 0.993, WALL_H + ROOF_RISE * (sh.half_width(u) / sh.a) * math.sin(bta) - 0.03) for u in us]
        bars.add(*tube(np.array(pts), 0.03, 4, caps=False))
    # 入口と出口の白い鉄の輪
    for s_gate, r in ((s0 + 1.1, GATE_R - 0.05), (s1 + END_AT - 0.06, GATE_R - 0.05)):
        p = rail.point(s_gate)
        f = rail.forward(s_gate)
        rgt = np.array([-f[2], 0.0, f[0]])
        # 床より上の弧だけ（床の下を回らない）。y = p.y + r sin(a) ≥ 0.05 の範囲
        lim = math.asin(max(-1.0, min(1.0, (0.05 - p[1]) / r)))
        a = np.linspace(lim, math.pi - lim, 80)
        ring = p[None, :] + (np.cos(a)[:, None] * rgt[None, :] + np.sin(a)[:, None] * np.array([0, 1.0, 0])[None, :]) * r
        iron.add(*tube(ring, 0.09, 8, caps=True))

    # ── 床（超楕円の石の床）と小道（レールの真下） ──
    ang = np.linspace(0, 2 * math.pi, 256, endpoint=False)
    rim = []
    for t in ang:
        u = sh.b * math.sin(t)
        v = sh.half_width(u) * math.cos(t)
        rim.append(sh.world(u * 0.999, v * 0.999, 0.0))
    rim = np.array(rim)
    fv = np.vstack([sh.world(0, 0, 0), rim])
    floor.add(fv, orient_up(fv, [(0, 1 + i, 1 + (i + 1) % len(rim)) for i in range(len(rim))]))
    walk_s = np.arange(s0 + 44.0, s1 - 0.5, 0.5)
    left, right = [], []
    for s in walk_s:
        p = rail.point(s)
        rgt = rail.right(s)
        left.append(np.array([p[0], 0.012, p[2]]) - rgt * 1.6)
        right.append(np.array([p[0], 0.012, p[2]]) + rgt * 1.6)
    pv = np.array(left + right)
    n = len(left)
    path_b.add(pv, orient_up(pv, [(i, i + 1, n + i + 1, n + i) for i in range(n - 1)]))

    # ── 池（大きな花の根元）と、植え込み ──
    bloom_s = rail.s_at(160.0)
    flower = flower_layout(rail, bloom_s)
    pond_c, pond_r = flower['pond'], 5.4
    a = np.linspace(0, 2 * math.pi, 96, endpoint=False)
    curb_prof = [(pond_r + 0.32, -0.05), (pond_r + 0.32, 0.24), (pond_r + 0.2, 0.3), (pond_r, 0.3), (pond_r, 0.12)]
    v, f = lathe(curb_prof, 96, (pond_c[0], 0, pond_c[2]))
    curb.add(v, f)
    wv = np.vstack([np.array([pond_c[0], 0.16, pond_c[2]]), np.stack([pond_c[0] + np.cos(a) * pond_r, np.full_like(a, 0.16), pond_c[2] + np.sin(a) * pond_r], 1)])
    ob = mesh_object('greenhouse.water', wv, orient_up(wv, [(0, 1 + i, 1 + (i + 1) % 96) for i in range(96)]), m_water, coll, smooth=False,
                     props={'role': 'water', 'clearance_exempt': True})
    objs.append(ob)

    beds = make_beds(rail, sh, rng, pond_c, pond_r)
    for bd in beds:
        v, f = bed_mesh(bd)
        curb.add(*v)
        soil.add(*f)

    # ── 植物の元の形とインスタンス ──
    holder = bpy.data.objects.new('greenhouse.instances', None)
    coll.objects.link(holder)
    protos = {}
    proto_objs = []
    for name, (fn, _count, _where, _sc) in PLANTS.items():
        # 種は名前の CRC32（組み込みの hash は実行ごとに変わる。書き出しを毎回同じにする）
        p = fn(random.Random(zlib.crc32(name.encode())))
        ob = build_proto(p, coll)
        protos[name] = ob
        proto_objs.append(ob)
        objs.append(ob)
    placements = scatter_plants(rail, sh, rng, beds, pond_c, pond_r, protos, clear_pts)
    bake_casters = []
    for name, mats in placements.items():
        order = list(range(len(mats)))
        rng.shuffle(order)
        kit.write_instances(holder, name, [mats[i] for i in order])
        # 焼き込みのあいだだけ、本物の形を置いて影を落とす（書き出さない）
        for m4 in mats:
            o = bpy.data.objects.new(f'bake_{name}', protos[name].data)
            o.matrix_world = blender_matrix(m4)
            coll.objects.link(o)
            bake_casters.append(o)
    objs.append(holder)
    tri = {k: len(protos[k].data.polygons) for k in placements}
    for k in placements:
        protos[k].data.calc_loop_triangles()
        tri[k] = len(protos[k].data.loop_triangles)
    print('plants: ' + ', '.join(f'{k}={len(v)}×{tri[k]}' for k, v in placements.items()) + f'  合計 {sum(len(v) * tri[k] for k, v in placements.items())} 三角形')

    # ── 触れられる葉（16）と蕾（3）と隠れた小さな泡（1）と大きな花 ──
    greens = Builder()
    touch_objs = make_touchables(rail, sh, coll, rng, clear_pts, flower, greens)
    objs.extend(touch_objs)
    objs.extend(make_flower(flower, coll, greens))
    ob = greens.build('greenhouse.greens', glass_material('stem'), coll, smooth=True,
                      props={'glass': 'tinted', 'glass_color': '#7cbf92', 'glass_opacity': 0.5, 'glass_iridescence': 0.0})
    objs.append(ob)

    # ── 出口の妻壁: 出口の向きに直交する平らなガラスの面（雨の回廊との境目。斜めの殻をここで平らに切る） ──
    end_p = rail.point(s1 + END_AT)
    end_n = rail.forward(s1)
    end_glass = end_wall(sh, end_p - end_n * 0.03, end_n, iron, curb, coll, m_glass)
    objs.append(end_glass)

    for name, b, m, bk in (('greenhouse.floor', floor, m_floor, True), ('greenhouse.path', path_b, m_path, True), ('greenhouse.curb', curb, m_curb, True),
                           ('greenhouse.soil', soil, m_soil, True), ('greenhouse.iron', iron, m_iron, False)):
        if b.empty():
            continue
        props = {'paint': 'iron'} if not bk else None
        ob = b.build(name, m, coll, smooth=name in ('greenhouse.iron', 'greenhouse.curb'), props=props)
        objs.append(ob)
        if bk:
            bake.append(ob)

    # ── 部屋の境目で切る: 出口の妻壁より先と、入口（区間の始まり +1m）より手前の形を落とす ──
    statics = [o for o in objs if o.type == 'MESH' and o.get('role') != 'proto' and not o.get('touch_kind')]
    clip_plane(statics, end_p, end_n)
    clip_plane(statics, rail.point(s0 + 1.0), -rail.forward(s0))

    # ── 光: 南の低い朝日（逆光）と、明るい朝の空。ガラスの殻は光を遮らない ──
    kit.set_world('#d4e3d6', 0.55)
    kit.sun('greenhouse.sun', SUN_DIR.tolist(), '#ffe2b4', 10.0, 0.9)
    for o in [shell_obj, end_glass]:
        o.visible_shadow = False
        o.visible_diffuse = False
        o.visible_glossy = False
        o.visible_transmission = False
        o.visible_camera = False
    # 反射用の環境画像（身廊の中ほど、ゴンドラの高さ）
    holder['env'] = kit.render_env('greenhouse.env', sh.world(0.0, 0.0, 4.5), samples=24 if fast else 96)

    vp = rail.samples(max(0.0, s0 - 25.0), min(rail.max_s, s1 + 15.0), 0.5)
    samples = 48 if fast else 384
    # 花芯は蕾のあいだ萼と葉に隠れて、見えない面の削除で消えてしまう（TS が 2:40 に花弁を開いて見せる）ので残す
    kit.finish_room(ROOM, rail, objs, vp, clear_pts, bake, size=2048, samples=samples, webp=90, keep_unculled=('greenhouse.flower_core',))
    for o in bake_casters:
        bpy.data.objects.remove(o)
    kit.save_blend(ROOM)


def clip_plane(objs, p_three, n_three) -> None:
    """three.js の点 p と向き n の平面より先（n の側）の形を、面を正確に切って落とす"""
    from mathutils import Vector
    # 原点を動かした物（花芯など）の matrix_world を最新にしてから切る（古いままだと平面が局所の座標でずれ、丸ごと消える）
    bpy.context.view_layer.update()
    pb = Vector(kit.to_blender(np.asarray(p_three, dtype=np.float64)).tolist())
    nb = Vector(kit.to_blender(np.asarray(n_three, dtype=np.float64)).tolist()).normalized()
    for ob in objs:
        me = ob.data
        inv = ob.matrix_world.inverted()
        pl = inv @ pb
        nl = (ob.matrix_world.to_3x3().transposed() @ nb).normalized()
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=pl, plane_no=nl, clear_outer=True, dist=1e-4)
        bm.to_mesh(me)
        bm.free()
        me.update()


def end_wall(sh: 'Shell', p, n, iron: Builder, curb: Builder, coll, m_glass):
    """出口の妻壁: 平面（点 p、向き n）と殻の内側の重なる所に、縦の桟で割ったガラスの面を張る。レールの口は丸く抜く。
    上の縁は殻の高さ（roof_y）にそろえる。白い鉄の桟・上の縁と、床の縁石も作る"""
    w = np.array([-n[2], 0.0, n[0]])
    rail_c = p + n * 0.03  # 口の中心（レールの点）
    ts = np.arange(-60.0, 60.0 + 1e-6, 0.6)
    cols = []
    for t in ts:
        q = p + w * t
        q[1] = 0.0
        if not sh.inside(q, 0.03):
            continue
        u, v = sh.local(q)
        cols.append((t, q, sh.roof_y(u, v) - 0.06))
    verts, faces = [], []
    K = 10
    for (t0, q0, h0), (t1, q1, h1) in zip(cols[:-1], cols[1:]):
        if t1 - t0 > 0.61:
            continue
        b = len(verts)
        for k in range(K + 1):
            verts.append(q0 + np.array([0, h0 * k / K, 0]))
            verts.append(q1 + np.array([0, h1 * k / K, 0]))
        for k in range(K):
            faces.append((b + 2 * k, b + 2 * k + 1, b + 2 * k + 3, b + 2 * k + 2))
    verts = np.array(verts)
    keep = []
    for f in faces:
        c = verts[list(f)].mean(0)
        keep.append(np.linalg.norm(c - rail_c) > GATE_R - 0.05)
    faces = [f for f, k in zip(faces, keep) if k]
    # 面の向きは温室の中（-n）へ
    out = []
    for f in faces:
        q = list(f)
        nrm = np.cross(verts[q[1]] - verts[q[0]], verts[q[2]] - verts[q[0]])
        out.append(tuple(q) if np.dot(nrm, -n) > 0 else tuple(reversed(q)))
    ob = mesh_object('greenhouse.end_glass', verts, out, m_glass, coll, smooth=False,
                     props={'glass': 'clear', 'glass_color': '#f2f8f0', 'glass_opacity': 0.035, 'glass_rim': 0.55,
                            'clearance_exempt': True, 'check_true_clearance': True})
    # 桟（2.3m ごと。口の上だけを残す）と上の縁、床の縁石
    for t, q, h in cols:
        if abs((t / 2.3) - round(t / 2.3)) > 0.13:
            continue
        y0 = 0.0
        if abs(t) < GATE_R:
            y0 = rail_c[1] + math.sqrt(max(0.0, GATE_R ** 2 - t * t)) + 0.05
        if h - y0 > 0.3:
            iron.add(*tube(np.array([q + np.array([0, y0, 0]), q + np.array([0, h, 0])]) - n * 0.02, 0.05, 6))
    top = np.array([q + np.array([0, h, 0]) for _t, q, h in cols]) - n * 0.02
    iron.add(*tube(top, 0.08, 8))
    for (t0, q0, _h0), (t1, q1, _h1) in zip(cols[:-1], cols[1:]):
        if abs(t0) < GATE_R or abs(t1) < GATE_R:
            continue
        a, b = q0 - n * 0.15, q1 - n * 0.15
        cv = np.array([a, b, b + np.array([0, 0.32, 0]), a + np.array([0, 0.32, 0])])
        nrm = np.cross(cv[1] - cv[0], cv[2] - cv[0])
        curb.add(cv, [(0, 1, 2, 3) if np.dot(nrm, -n) > 0 else (3, 2, 1, 0)])
    return ob


def blender_matrix(m4_three: np.ndarray):
    """three.js の 4×4 → Blender の物の変換（C⁻¹ M C）"""
    from mathutils import Matrix
    C = np.eye(4)
    C[:3, :3] = kit._C
    Ci = np.linalg.inv(C)
    return Matrix((Ci @ m4_three @ C).tolist())


def orient_in(verts, faces, axis_fn):
    out = []
    for f in faces:
        q = list(f)
        c = verts[q].mean(0)
        n = np.cross(verts[q[1]] - verts[q[0]], verts[q[2]] - verts[q[0]])
        if np.linalg.norm(n) < 1e-12:
            n = np.cross(verts[q[2]] - verts[q[0]], verts[q[3]] - verts[q[0]]) if len(q) > 3 else n
        out.append(tuple(q) if np.dot(n, axis_fn(c) - c) > 0 else tuple(reversed(q)))
    return out


def orient_up(verts, faces):
    out = []
    for f in faces:
        q = list(f)
        n = np.cross(verts[q[1]] - verts[q[0]], verts[q[2]] - verts[q[0]])
        out.append(tuple(q) if n[1] >= 0 else tuple(reversed(q)))
    return out


def flower_layout(rail: kit.Rail, bloom_s: float) -> dict:
    """大きな花の置き場所: 見どころの時刻の向きから 2° だけ左、25m 先、目より約 5m 上（見上げは浅く、写真の真ん中に。
    開いた花は左右に約 ±12°。縦持ちの画面の横の視野 約 ±19° に収まるよう、ほぼ正面に置く）。
    花はレールの上の空間に開き、ゴンドラはその下をくぐる。茎は左の池から弧を描いて伸びる"""
    p = rail.point(bloom_s)
    f = rail.forward(bloom_s)
    yaw = math.radians(2.0)
    d = np.array([f[0] * math.cos(yaw) + f[2] * math.sin(yaw), 0.0, -f[0] * math.sin(yaw) + f[2] * math.cos(yaw)])
    head = np.array([p[0], 0.0, p[2]]) + d * 25.0 + np.array([0, 7.6, 0])
    left = np.array([f[2], 0.0, -f[0]])
    base = np.array([head[0], 0.15, head[2]]) + left * 7.0 + d * 1.5
    return {'head': head, 'base': base, 'pond': np.array([base[0], 0.0, base[2]]), 'forward': d}


class Bed:
    """植え込み（楕円）。ra は長い向きの半径、rb は横の半径、rot は長い向きの角度（xz の平面で X から）"""

    def __init__(self, c, ra: float, rb: float, rot: float, lining: bool):
        self.c = np.array([c[0], 0.0, c[2]])
        self.ra, self.rb, self.rot, self.lining = ra, rb, rot, lining

    def outline(self, scale: float = 1.0, n: int = 48) -> np.ndarray:
        a = np.linspace(0, 2 * math.pi, n, endpoint=False)
        x = np.cos(a) * self.ra * scale
        z = np.sin(a) * self.rb * scale
        cr, sr = math.cos(self.rot), math.sin(self.rot)
        return np.stack([self.c[0] + x * cr - z * sr, np.zeros(n), self.c[2] + x * sr + z * cr], axis=1)

    def local(self, p) -> tuple[float, float]:
        dx, dz = p[0] - self.c[0], p[2] - self.c[2]
        cr, sr = math.cos(-self.rot), math.sin(-self.rot)
        return (dx * cr - dz * sr) / self.ra, (dx * sr + dz * cr) / self.rb

    def contains(self, p, margin: float = 0.0) -> bool:
        x, z = self.local(p)
        k = max(0.05, 1.0 - margin / min(self.ra, self.rb))
        return x * x + z * z < k * k

    def point(self, rng: random.Random, inner: float, outer: float) -> np.ndarray:
        """楕円の中の点（中心からの割合 inner〜outer の輪の中）"""
        a = rng.uniform(0, 2 * math.pi)
        r = math.sqrt(rng.uniform(inner * inner, outer * outer))
        x, z = math.cos(a) * r * self.ra, math.sin(a) * r * self.rb
        cr, sr = math.cos(self.rot), math.sin(self.rot)
        return np.array([self.c[0] + x * cr - z * sr, 0.3, self.c[2] + x * sr + z * cr])


def make_beds(rail: kit.Rail, sh: Shell, rng: random.Random, pond_c, pond_r) -> list:
    """植え込み: 道に沿って両側を縁取る楕円（道を縫うように進む眺め）と、外側の大きな島。
    レールが低い所（4.5m より下）では、植え込みの縁をレールの真下から水平に 1.6m 以上離す（道を空ける）"""
    s0, s1 = rail.sections['greenhouse']
    rp = rail.samples(s0, s1, 0.5)
    low = rp[rp[:, 1] < 4.5]
    beds: list[Bed] = []

    def fits(b: Bed, gap: float) -> bool:
        ol = b.outline()
        for q in ol:
            if not sh.inside(q, 1.0):
                return False
        if len(low) and float(np.min(np.hypot(low[:, 0][None, :] - ol[:, 0][:, None], low[:, 2][None, :] - ol[:, 2][:, None]))) < 1.6:
            return False
        if math.hypot(b.c[0] - pond_c[0], b.c[2] - pond_c[2]) < max(b.ra, b.rb) + pond_r + 0.5:
            return False
        for o in beds:
            # 輪郭どうしの近さ（粗く）
            if math.hypot(b.c[0] - o.c[0], b.c[2] - o.c[2]) < max(b.ra, b.rb) + max(o.ra, o.rb) + gap - 1.2:
                if np.min(np.linalg.norm(b.outline(1.0, 24)[:, None, :] - o.outline(1.0, 24)[None, :, :], axis=2)) < gap:
                    return False
        return True

    # 1. 道を縁取る植え込み
    for side in (-1, 1):
        s = s0 + 5.0
        while s < s1 - 4.0:
            p = rail.point(s)
            f = rail.forward(s)
            rgt = rail.right(s)
            ra = rng.uniform(3.6, 5.2)
            rb = rng.uniform(2.2, 3.6)
            off = (1.7 if p[1] < 4.5 else -0.4) + rb
            placed = False
            for extra in (0.0, 0.6, 1.3, 2.2):
                c = np.array([p[0], 0.0, p[2]]) + rgt * side * (off + extra)
                b = Bed(c, ra, rb, math.atan2(f[2], f[0]), True)
                if fits(b, 0.9):
                    beds.append(b)
                    placed = True
                    break
            s += ra * 2 + (rng.uniform(0.9, 1.6) if placed else 1.0)
    # 2. 外側の大きな島
    tries = 0
    while tries < 5000 and len(beds) < 90:
        tries += 1
        u = rng.uniform(-sh.b + 5, sh.b - 5)
        w = sh.half_width(u)
        v = rng.uniform(-w + 2.5, w - 2.5)
        c = sh.world(u, v, 0)
        b = Bed(c, rng.uniform(3.5, 8.0), rng.uniform(3.0, 6.0), rng.uniform(0, math.pi), False)
        if fits(b, 1.1):
            beds.append(b)
    print(f'beds: {len(beds)}（道沿い {sum(b.lining for b in beds)}）')
    return beds


def bed_mesh(b: Bed):
    """植え込み: 白い縁石（輪）と、淡い海ガラスの小石の面"""
    n = 56
    rings = [(1.0 + 0.18 / min(b.ra, b.rb), -0.05), (1.0 + 0.18 / min(b.ra, b.rb), 0.3), (1.0 + 0.08 / min(b.ra, b.rb), 0.36), (1.0 - 0.04 / min(b.ra, b.rb), 0.36),
             (1.0 - 0.06 / min(b.ra, b.rb), 0.28)]
    cv = np.vstack([b.outline(k, n) + np.array([0, y, 0]) for k, y in rings])
    cf = []
    for k in range(len(rings) - 1):
        for i in range(n):
            i2 = (i + 1) % n
            cf.append((k * n + i, k * n + i2, (k + 1) * n + i2, (k + 1) * n + i))
    out = []
    for q in cf:
        nrm = np.cross(cv[q[1]] - cv[q[0]], cv[q[2]] - cv[q[0]])
        mid = cv[list(q)].mean(0)
        want = np.array([mid[0] - b.c[0], 1.2, mid[2] - b.c[2]])
        out.append(q if np.dot(nrm, want) > 0 else tuple(reversed(q)))
    top = b.outline(1.0 - 0.06 / min(b.ra, b.rb), n) + np.array([0, 0.28, 0])
    sv = np.vstack([b.c + np.array([0, 0.3, 0]), top])
    sf = orient_up(sv, [(0, 1 + i, 1 + (i + 1) % n) for i in range(n)])
    return (cv, out), (sv, sf)


def scatter_plants(rail, sh: Shell, rng: random.Random, beds: list, pond_c, pond_r, protos: dict, clear_pts):
    """植物を植える。物の箱（元の形の箱 × 変換）がレールから NEED 以上離れる所だけ。
    背の高い物は奥（道から遠い所）、低い物と花は手前（道の側の縁）"""
    boxes = {k: kit.proto_box(ob) for k, ob in protos.items()}
    out: dict[str, list] = {k: [] for k in PLANTS}
    placed: list[tuple[float, float, float]] = []
    s0, s1 = rail.sections['greenhouse']
    rp = rail.samples(s0, s1, 0.5)

    def path_dist(p) -> float:
        return float(np.min(np.hypot(rp[:, 0] - p[0], rp[:, 2] - p[2])))

    end_p = rail.point(s1 + END_AT)
    end_n = rail.forward(s1)

    def try_place(name, p, sc, yaw, gap, tilt=(0.0, 0.0)) -> bool:
        # 出口の妻壁より先（と、その手前 1m）には植えない
        if float(np.dot(np.asarray(p) - end_p, end_n)) > -1.0 - gap:
            return False
        m4 = matrix_three(p, yaw, tilt=tilt, scale=(sc, sc, sc))
        lo, hi = instance_box(*boxes[name], m4)
        if box_distance(lo, hi, clear_pts).min() < NEED + 0.1:
            return False
        if any(math.hypot(p[0] - q[0], p[2] - q[1]) < gap + q[2] for q in placed):
            return False
        placed.append((float(p[0]), float(p[2]), gap))
        out[name].append(m4)
        return True

    for name in ['palm', 'treefern', 'banana', 'monstera', 'fern', 'calla', 'tulip', 'grass', 'succulent', 'vine', 'lilypad']:
        fn, count, where, (lo_s, hi_s) = PLANTS[name]
        tries = 0
        while len(out[name]) < count and tries < count * 400:
            tries += 1
            sc = rng.uniform(lo_s, hi_s)
            yaw = rng.uniform(0, 2 * math.pi)
            tilt = (rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06))
            if where == 'pond':
                a = rng.uniform(0, 2 * math.pi)
                rr = math.sqrt(rng.uniform(0.08, 1.0)) * (pond_r - 1.0)
                p = np.array([pond_c[0] + math.cos(a) * rr, 0.165, pond_c[2] + math.sin(a) * rr])
                try_place(name, p, sc, yaw, 0.7)
                continue
            if where == 'hang':
                u = rng.uniform(-sh.b + 10, sh.b - 10)
                w = sh.half_width(u)
                v = rng.uniform(-w + 4, w - 4)
                p = sh.world(u, v, 0)
                p[1] = sh.roof_y(u, v) - rng.uniform(0.3, 2.5)
                if p[1] - 7.5 * sc < 3.0:
                    continue
                try_place(name, p, sc, yaw, 1.0, (0.0, 0.0))
                continue
            b = beds[rng.randrange(len(beds))]
            if where == 'tall':
                if b.lining and rng.random() < 0.7:
                    continue
                p = b.point(rng, 0.0, 0.6)
                if path_dist(p) < 6.0:
                    continue
                gap = 2.6 * sc
            elif where == 'mid':
                p = b.point(rng, 0.0, 0.75)
                gap = 1.5 * sc
            elif where == 'low':
                p = b.point(rng, 0.2, 0.88)
                gap = 0.75 * sc
            else:  # edge
                p = b.point(rng, 0.7, 0.93)
                gap = 0.28 * sc
            if not b.contains(p, 0.25):
                continue
            try_place(name, p, sc, yaw, gap, tilt)
    return out


def make_touchables(rail: kit.Rail, sh: Shell, coll, rng: random.Random, clear_pts, flower, stems: Builder) -> list:
    """触れられる葉（16）、蕾（3）、隠れた小さな泡（1）。葉は茎の先の大きなガラスの葉で、身の中心がレールから 2.4〜3.6m"""
    s0, s1 = rail.sections['greenhouse']
    objs = []
    m_leaf = glass_material('monstera_leaf')
    m_leaf2 = glass_material('banana_leaf')
    m_petal = glass_material('petal_pink')
    leaf_s = np.linspace(s0 + 16.0, s1 - 7.0, 16)
    for i, s in enumerate(leaf_s):
        side = 1 if i % 2 == 0 else -1
        p = rail.point(s)
        f = rail.forward(s)
        rgt = rail.right(s)
        best = None
        for lateral in np.arange(2.2, 4.2, 0.1):
            c = p + rgt * side * lateral + np.array([0, rng.uniform(-0.55, 0.35), 0]) + f * rng.uniform(-0.5, 0.5)
            # 葉の身: レールの方へ身を向けて、少し上を向く
            toward = -side * rgt  # 葉の身の先はレールの方へ
            yaw = math.atan2(-toward[2], toward[0])
            length = rng.uniform(0.95, 1.25)
            width = length * rng.uniform(0.7, 0.85)
            v, fc, tip = blade(length, width, 10, 6, heart, droop=0.22, fold=0.1, thick=0.014)
            base = c - toward * length * 0.45
            vv = place(v, base, yaw, rng.uniform(0.0, 0.3), rng.uniform(-0.25, 0.25))
            lo, hi = vv.min(0), vv.max(0)
            if box_distance(lo, hi, clear_pts).min() >= NEED + 0.12:
                best = (vv, fc, base, yaw, place(tip[None, :], base, yaw, 0.15, 0.0)[0])
                break
        if best is None:
            raise RuntimeError(f'触れられる葉 {i} を置けない（s={s:.1f}）')
        vv, fc, base, yaw, tip = best
        center = vv.mean(0)
        ob = mesh_object(f'greenhouse.touch_leaf.{i + 1:03d}', vv, fc, m_leaf if i % 3 else m_leaf2, coll, smooth=True, origin=center,
                         props={'touch_kind': 'leaf', 'touch_id': f'greenhouse/leaf-{i + 1}', 'glass': 'tinted', 'glass_color': '#5cc488' if i % 3 else '#93d67a',
                                'glass_opacity': 0.46, 'glass_iridescence': 0.0, 'role': 'leaf', 'pivot': [round(float(x), 4) for x in base],
                                'tip': [round(float(x), 4) for x in tip], 'no_split': True})
        objs.append(ob)
        # 茎: 葉の付け根から、レールの外側の床へ弧を描いて下りる
        ground = np.array([base[0], 0.32, base[2]]) + side * rgt * rng.uniform(1.2, 2.4)
        path = stem_path(ground, base, side * rgt * 0.6 + np.array([0, 0.4, 0]), 14)
        stems.add(*tube(path, np.linspace(0.06, 0.03, len(path)), 6))
    # 蕾（3）: 道の脇、目の高さに、閉じたガラスの花
    for k, s in enumerate((s0 + 42.0, s0 + 78.0, s0 + 124.0)):
        side = -1 if k % 2 == 0 else 1
        p = rail.point(s)
        rgt = rail.right(s)
        found = False
        for lateral in np.arange(2.6, 4.6, 0.1):
            c = p + rgt * side * lateral + np.array([0, -0.2, 0])
            v, f = bud_shape(0.0)
            vv = v + c
            lo, hi = vv.min(0) - 0.4, vv.max(0) + 0.4  # 咲いた後の広がりも含めて離す
            if box_distance(lo, hi, clear_pts).min() >= NEED + 0.1:
                found = True
                break
        if not found:
            raise RuntimeError(f'蕾 {k} を置けない（s={s:.1f}）')
        ob = mesh_object(f'greenhouse.bud.{k + 1:03d}', vv, f, m_petal, coll, smooth=True, origin=c,
                         props={'touch_kind': 'bud', 'touch_id': f'greenhouse/bud-{k + 1}', 'glass': 'tinted', 'glass_color': '#f4b9c6', 'glass_opacity': 0.42,
                                'glass_iridescence': 0.35, 'role': 'bud', 'no_split': True})
        objs.append(ob)
        ground = np.array([c[0], 0.32, c[2]]) + side * rgt * 1.0
        stems.add(*tube(stem_path(ground, c - np.array([0, 0.18, 0]), np.array([0, 0.3, 0]) + side * rgt * 0.3, 12), 0.03, 6))
        for j in range(2):
            stems.add(*blade_at(ground + np.array([0, 0.05, 0]), math.pi * j + 0.4, 1.0, 0.8, 0.22))
    # 隠れた小さな泡: 小道の右、大きな羊歯の葉陰（レールから約 2.6m、腰の低さ）
    s = s0 + 61.0
    p = rail.point(s)
    c = p + rail.right(s) * 2.75 + np.array([0, -0.85, 0])
    v, f = uv_sphere((0, 0, 0), 0.12, 24, 14)
    ob = mesh_object('greenhouse.hidden_bubble', v + c, f, glass_material('petal_white'), coll, smooth=True, origin=c,
                     props={'touch_kind': 'hidden-bubble', 'touch_id': 'greenhouse/hidden', 'glass': 'iridescent', 'glass_color': '#e8f6d8', 'glass_opacity': 0.06,
                            'glass_emissive': '#dff3b0', 'glass_emissive_intensity': 0.25, 'role': 'hidden', 'no_split': True})
    objs.append(ob)
    return objs


def blade_at(origin, yaw, pitch, length, width):
    v, f, _ = blade(length, width, 6, 2, lance, droop=0.3, thick=0.008)
    return place(v, origin, yaw, pitch), f


def bud_shape(open_amount: float):
    """閉じた蕾（5 枚の花弁が重なった涙形）。中心が原点"""
    b = Builder()
    for j in range(5):
        a = 2 * math.pi * j / 5
        v, f, _ = blade(0.42, 0.26, 6, 3, lance, droop=-0.9, fold=0.55, thick=0.006)
        b.add(place(v, (0, -0.18, 0), a, 1.35 - open_amount), f)
    return np.concatenate(b.v), b.f


def make_flower(fl: dict, coll, greens: Builder) -> list:
    """大きな花: 池の中心から頭上へ傾いて伸びる茎、萼、花芯（光る）、花弁の元の形（TS が 12 枚を開く）"""
    objs = []
    head, base = fl['head'], fl['base']
    d = fl['forward']
    # 池から立ち上がり、高い所で道の上へ弧を描く（茎の中ほどもレールから十分高い）
    path = stem_path(base, head - np.array([0, 0.6, 0]), np.array([0, 2.6, 0]) + (base - head) * np.array([0.3, 0, 0.3]), 32)
    greens.add(*tube(path, np.linspace(0.48, 0.3, len(path)), 16))
    # 茎の葉（2枚の大きな葉、池の上）
    for k, (t, yaw) in enumerate(((0.25, 0.4), (0.42, 3.2))):
        p = path[int(t * (len(path) - 1))]
        v, f, _ = blade(3.2, 1.7, 12, 6, heart, droop=0.3, fold=0.12, thick=0.02)
        greens.add(place(v, p, yaw, 0.15), f)
    # 萼（花の下の6枚の緑の葉）
    for j in range(6):
        a = 2 * math.pi * j / 6
        v, f, _ = blade(1.4, 0.7, 6, 3, lance, droop=0.4, fold=0.3, thick=0.015)
        greens.add(place(v, head - np.array([0, 0.5, 0]), a, -0.2), f)
    # 花芯（光る玉の房）
    cb = Builder()
    cb.add(*uv_sphere(head + np.array([0, 0.15, 0]), 0.75, 28, 16))
    for j in range(14):
        a = 2 * math.pi * j / 14
        cb.add(*uv_sphere(head + np.array([math.cos(a) * 0.85, 0.6 + 0.12 * math.sin(j), math.sin(a) * 0.85]), 0.17, 12, 8))
    ob = mesh_object('greenhouse.flower_core', np.concatenate(cb.v), cb.f, glass_material('petal_white'), coll, smooth=True, origin=head,
                     props={'glass': 'milky', 'glass_color': '#fff1cf', 'glass_opacity': 0.7, 'glass_emissive': '#ffd88c', 'glass_emissive_intensity': 0.6, 'role': 'flower_core'})
    objs.append(ob)
    # 花弁の元の形（1 枚。TS が花の頭のまわりに 12 枚並べて開く）。根元が原点、+Y へ伸びて外へ反る
    v, f, _ = blade(6.6, 3.0, 18, 8, petal_shape, droop=-0.16, fold=0.3, thick=0.035)
    # 身の軸（+X）を上（+Y）へ、表（+Y）を内（-X）へ: (x, y, z) → (-y, x, z)。花弁は閉じた状態（蕾）で上を向き、TS が外へ倒して開く
    v = v @ np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]]).T
    ob = mesh_object('greenhouse.proto_petal', v, f, glass_material('petal_pink'), coll, smooth=True,
                     props={'role': 'proto', 'clearance_exempt': True, 'glass': 'tinted', 'glass_color': '#ffd6de', 'glass_opacity': 0.32, 'glass_iridescence': 0.55,
                            'flower_head': [round(float(x), 4) for x in head], 'petals': 12})
    objs.append(ob)
    return objs


def petal_shape(t: float) -> float:
    return math.sin(math.pi * (0.08 + 0.92 * t) ** 0.75) ** 0.9


def main() -> None:
    rail = kit.Rail()
    build_greenhouse(rail, kit.fast_mode())


if __name__ == '__main__':
    main()
