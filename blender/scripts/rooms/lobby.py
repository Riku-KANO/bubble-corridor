"""待ち列と入口（ホーム画面の背景）。このスクリプトが原本（blender/scenes/lobby.blend と glb・ライトマップはその書き出し）。乗り場のホールの南の入口から、レールの始点の真後ろへ一直線に伸びる。

    pnpm blender blender/scripts/rooms/lobby.py            # 造形 → 見えない面の削除 → 焼き込み → glb
    pnpm blender blender/scripts/rooms/lobby.py -- --fast  # 焼き込みのサンプルを減らした下書き

絵コンテ（入口で視界が開ける一枚絵）:
  待ち列: 薄暗い円天井の通路。両側の真鍮の支柱の上に、乳白のガラスの灯りが並び、読み込みにつれて手前から一つずつ灯る。
  突き当たりに丸い頭の乳白のガラスの扉。扉の向こうがかすかに明るい。
  入口: 扉が開くと、天井の高い前室に、乳白のガラスのアーチがやわらかく光って立つ。その下に、ガラスの切符が浮かぶ。
  アーチの向こうには乗り場のホールの入口が見え、さらに奥に、泡の吊られた暗い水面がのぞく（次の場面が来る予感）。

配置（three.js の座標。S はレールの始点、B は始点から真後ろの向き。lobby/index.ts の LOBBY と同じ距離）:
  B × 7.6  前室の始まり（乗り場の入口の通路の端）   B × 9.2  アーチ
  B × 19.6 扉（前室と通路の境）                       B × 47   通路の突き当たり
"""
from __future__ import annotations

import math
import os
import sys

sys.dont_write_bytecode = True  # __pycache__ を作らない（リポジトリを汚さない）
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import bpy  # noqa: E402
import numpy as np  # noqa: E402

from rooms import platform as kit  # noqa: E402
from rooms.platform import Builder, dense_outline, emitter, lathe, material, mesh_object, ring_wall, tube, uv_sphere  # noqa: E402

# ── 待ち列の距離（レールの始点から真後ろへ、m）。src/rooms/lobby/index.ts の LOBBY と同じ値 ──
ORIGIN = kit.LOBBY_ORIGIN  # 7.6
ARCH_AT = 9.2
DOORS_AT = 19.6
CORRIDOR_END = 47.0
FLOOR_Y = kit.DECK_Y
#: 前室（vestibule）の半幅、壁の高さ、天井の高さ
VEST_HALF = 4.2
VEST_WALL = 4.6
VEST_TOP = 7.4
#: 通路（corridor）の半幅、壁の高さ（その上は半円の天井）
COR_HALF = 1.8
COR_WALL = 2.9
#: 扉の開口
DOOR_HALF = 1.35
DOOR_TOP = 3.5
#: アーチ（外と内の半幅・頂の高さ、厚み）
ARCH_OUT_HALF = 3.35
ARCH_OUT_TOP = 7.05
ARCH_IN_HALF = 2.75
ARCH_IN_TOP = 6.45
ARCH_DEPTH = 0.42
#: 支柱の灯り（両側に 8 つずつ）
LAMP_Z0 = 21.6
LAMP_STEP = 3.35
LAMP_X = 1.2
LAMP_R = 0.12


class Frame:
    """待ち列の座標: L(x, y, z) = 始点 + 横 × x + 後ろ × z（y は世界の高さ）"""

    def __init__(self, rail: kit.Rail):
        s = rail.point(0.0)
        self.s = np.array([s[0], 0.0, s[2]])
        self.back = -rail.forward(0.0)
        self.side = np.array([-self.back[2], 0.0, self.back[0]])

    def p(self, x: float, y: float, z: float) -> np.ndarray:
        return self.s + self.side * x + self.back * z + np.array([0.0, y, 0.0])

    def pts(self, arr) -> np.ndarray:
        a = np.asarray(arr, dtype=np.float64).reshape(-1, 3)
        return self.s[None, :] + a[:, :1] * self.side[None, :] + a[:, 2:3] * self.back[None, :] + np.stack([np.zeros(len(a)), a[:, 1], np.zeros(len(a))], axis=1)


def oriented(verts: np.ndarray, faces, toward: np.ndarray, center: np.ndarray | None = None):
    """面の向きを、toward（向き、または center が与えられたら中心から見た向き）に揃える"""
    out = []
    for f in faces:
        q = list(f)
        n = np.cross(verts[q[1]] - verts[q[0]], verts[q[2]] - verts[q[0]])
        want = toward if center is None else (center - verts[q].mean(0))
        out.append(tuple(q) if np.dot(n, want) > 0 else tuple(reversed(q)))
    return out


def vault_profile(half: float, wall: float, rise: float, n: int = 24):
    """横断面（左の床 → 左の壁 → 天井の弧 → 右の壁 → 右の床）。(x, y)"""
    pts = [(-half, FLOOR_Y - 0.1), (-half, FLOOR_Y + wall)]
    for k in range(1, n):
        a = math.pi - math.pi * k / n
        pts.append((half * math.cos(a), FLOOR_Y + wall + rise * math.sin(a)))
    pts += [(half, FLOOR_Y + wall), (half, FLOOR_Y - 0.1)]
    return pts


def build_lobby(rail: kit.Rail, fast: bool) -> None:
    kit.reset_scene()
    coll = kit.collection('lobby')
    F = Frame(rail)
    objs: list = []
    bake: list = []

    m_plaster = material('lobby.plaster', '#6f7f97', 0.85)
    m_plaster_dark = material('lobby.plaster_dark', '#4d5b70', 0.85)
    m_floor = material('lobby.floor', '#3c434d', 0.6)
    m_floor_light = material('lobby.floor_light', '#8d8f93', 0.6)
    m_brass = material('lobby.brass', '#b8925a', 0.35, metallic=1.0)
    m_glass = material('lobby.glass', '#e8eef6', 0.05, alpha=0.2)

    plaster = Builder()
    plaster_dark = Builder()
    floor = Builder()
    floor_light = Builder()
    brass = Builder()

    # ── 通路: 円天井の筒（内側の面）。床と、真鍮のリブ ──
    prof = vault_profile(COR_HALF, COR_WALL, COR_HALF, 28)
    zs = np.linspace(DOORS_AT, CORRIDOR_END, 64)
    verts = F.pts([(x, y, z) for z in zs for (x, y) in prof])
    m = len(prof)
    faces = [(j * m + i, j * m + i + 1, (j + 1) * m + i + 1, (j + 1) * m + i) for j in range(len(zs) - 1) for i in range(m - 1)]
    faces = oriented_to_axis(verts, faces, F, FLOOR_Y + COR_WALL * 0.6)
    plaster.add(verts, faces)
    fv = F.pts([(-COR_HALF, FLOOR_Y, DOORS_AT), (COR_HALF, FLOOR_Y, DOORS_AT), (COR_HALF, FLOOR_Y, CORRIDOR_END), (-COR_HALF, FLOOR_Y, CORRIDOR_END)])
    floor.add(fv, oriented(fv, [(0, 1, 2, 3)], np.array([0, 1.0, 0])))
    # 床の真鍮の象嵌（2本の細い線）
    for x in (-0.55, 0.55):
        brass.add(*tube(F.pts([(x, FLOOR_Y + 0.004, DOORS_AT + 0.4), (x, FLOOR_Y + 0.004, CORRIDOR_END - 0.4)]), 0.012, 4, caps=False))
    for z in np.arange(DOORS_AT + 1.4, CORRIDOR_END, 2.75):
        rib = F.pts([(x * 0.985, y if y > FLOOR_Y else FLOOR_Y, z) for (x, y) in prof[1:-1]])
        brass.add(*tube(rib, 0.035, 6, caps=False))
    # 突き当たりの壁と、藍の丸窓
    outer = dense_outline([p for p in vault_profile(COR_HALF, COR_WALL, COR_HALF, 28)][1:-1] + [(COR_HALF, FLOOR_Y), (-COR_HALF, FLOOR_Y)])
    win = [(0.7 * math.cos(a), FLOOR_Y + 2.6 + 0.7 * math.sin(a)) for a in np.linspace(0, 2 * np.pi, 40, endpoint=False)]
    wv, wf = ring_wall(outer, win, (0.0, FLOOR_Y + 2.6))
    wv3 = F.pts([(x, y, CORRIDOR_END) for x, y in wv])
    plaster_dark.add(wv3, oriented(wv3, wf, -F.back))
    gv = F.pts([(x, y, CORRIDOR_END + 0.05) for x, y in [(0.0, FLOOR_Y + 2.6)] + win])
    gf = oriented(gv, [(0, 1 + k, 1 + (k + 1) % 40) for k in range(40)], -F.back)
    ob = mesh_object('lobby.end_window', gv, gf, m_glass, coll, smooth=False,
                     props={'glass': 'clear', 'glass_color': '#7d95c4', 'glass_opacity': 0.5, 'glass_emissive': '#2c4677', 'glass_emissive_intensity': 0.6})
    objs.append(ob)
    brass.add(*tube(F.pts([(x, y, CORRIDOR_END - 0.03) for x, y in win + win[:1]]), 0.04, 6, caps=False))

    # ── 支柱の灯り（待ち列の灯り。両側に 8 つずつ）と、支柱をつなぐ真鍮の綱 ──
    lamps = []
    for side in (-1, 1):
        prev = None
        for k in range(8):
            z = LAMP_Z0 + LAMP_STEP * k
            base = F.p(side * LAMP_X, FLOOR_Y, z)
            top = base + np.array([0, 1.0, 0])
            brass.add(*tube(np.array([base, top]), 0.026, 8))
            brass.add(*lathe([(0.11, 0.0), (0.12, 0.025), (0.05, 0.06)], 16, base))
            brass.add(*lathe([(0.03, 0.0), (0.075, 0.05), (0.08, 0.065)], 16, top))
            c = top + np.array([0, LAMP_R + 0.03, 0])
            v, f = uv_sphere(c, LAMP_R, 24, 14)
            ob = mesh_object(f'lobby.lamp.{len(lamps) + 1:03d}', v, f, emitter('lobby.lamp_light', '#ffd7a0', 60.0), coll, origin=c,
                             props={'role': 'lamp', 'glass': 'milky', 'glass_color': '#fff4e4', 'glass_opacity': 0.8, 'glass_emissive': '#ffd7a0', 'glass_emissive_intensity': 1.6})
            lamps.append(ob)
            objs.append(ob)
            rope = base + np.array([0, 0.86, 0])
            if prev is not None:
                pts = [prev + (rope - prev) * t + np.array([0, -0.09 * math.sin(math.pi * t), 0]) for t in np.linspace(0, 1, 12)]
                brass.add(*tube(np.array(pts), 0.013, 5, caps=False))
            prev = rope

    # ── 前室と通路の境の壁と、乳白のガラスの扉2枚（TS が開ける。蝶番が原点） ──
    vest_prof = vault_profile(VEST_HALF, VEST_WALL, VEST_TOP - VEST_WALL, 32)
    outer = dense_outline(vest_prof[1:-1] + [(VEST_HALF, FLOOR_Y), (-VEST_HALF, FLOOR_Y)])
    door_hole = dense_outline(kit.arch_outline(DOOR_HALF, FLOOR_Y + DOOR_TOP, FLOOR_Y, 24))
    wv, wf = ring_wall(outer, door_hole, (0.0, FLOOR_Y + 1.6), 128)
    wv3 = F.pts([(x, y, DOORS_AT) for x, y in wv])
    plaster.add(wv3, oriented(wv3, wf, -F.back))
    # 通路の側から見える面（同じ壁の裏）
    cor_outer = dense_outline(prof[1:-1] + [(COR_HALF, FLOOR_Y), (-COR_HALF, FLOOR_Y)])
    wv, wf = ring_wall(cor_outer, door_hole, (0.0, FLOOR_Y + 1.6), 128)
    wv3 = F.pts([(x, y, DOORS_AT + 0.25) for x, y in wv])
    plaster.add(wv3, oriented(wv3, wf, F.back))
    # 扉の開口の厚み（筒）と真鍮の縁
    hole = kit.arch_outline(DOOR_HALF, FLOOR_Y + DOOR_TOP, FLOOR_Y, 24)
    rv = []
    for x, y in hole:
        rv.append(F.p(x, y, DOORS_AT))
        rv.append(F.p(x, y, DOORS_AT + 0.25))
    rv = np.array(rv)
    rf = [(2 * k, 2 * k + 2, 2 * k + 3, 2 * k + 1) for k in range(len(hole) - 1)]
    plaster_dark.add(rv, oriented(rv, rf, None, F.p(0, FLOOR_Y + 1.5, DOORS_AT + 0.12)))
    brass.add(*tube(F.pts([(x, y, DOORS_AT - 0.03) for x, y in hole]), 0.045, 8))
    brass.add(*tube(F.pts([(x, y, DOORS_AT + 0.28) for x, y in hole]), 0.045, 8))
    m_door = material('lobby.door_glass', '#efe6d8', 0.3, alpha=0.4)
    for side, label in ((-1, 1), (1, 2)):
        hinge = F.p(side * (DOOR_HALF - 0.03), 0, DOORS_AT + 0.12)
        spring = FLOOR_Y + DOOR_TOP - DOOR_HALF
        half = [(0.0, FLOOR_Y + 0.02), (side * (DOOR_HALF - 0.04), FLOOR_Y + 0.02), (side * (DOOR_HALF - 0.04), spring)]
        for i in range(1, 20):
            a = math.pi / 2 * i / 20
            half.append((side * (DOOR_HALF - 0.04) * math.cos(a), spring + (DOOR_HALF - 0.04) * math.sin(a)))
        half.append((0.0, FLOOR_Y + DOOR_TOP - 0.04))
        poly = F.pts([(x, y, DOORS_AT + 0.12) for x, y in half])
        cen = poly.mean(0)
        dv = np.vstack([cen, poly])
        df = oriented(dv, [(0, 1 + i, 1 + (i + 1) % len(poly)) for i in range(len(poly))], -F.back)
        ob = mesh_object(f'lobby.door.{label:03d}', dv, df, m_door, coll, smooth=False, origin=hinge,
                         props={'glass': 'milky', 'glass_color': '#f4ece0', 'glass_opacity': 0.5, 'glass_emissive': '#ffd6a2', 'glass_emissive_intensity': 0.25,
                                'role': 'door_leaf', 'hinge_side': side})
        objs.append(ob)
        frame = np.vstack([poly, poly[:1]])
        fb = Builder()
        fb.add(*tube(frame, 0.03, 6))
        # 桟（横に2本）
        for yy in (FLOOR_Y + 1.0, FLOOR_Y + 2.0):
            fb.add(*tube(F.pts([(side * 0.05, yy, DOORS_AT + 0.12), (side * (DOOR_HALF - 0.06), yy, DOORS_AT + 0.12)]), 0.016, 5))
        fr = fb.build(f'lobby.door_frame.{label:03d}', m_brass, coll)
        # 枠も蝶番を原点に（TS が扉と一緒に回す）
        set_origin(fr, hinge)
        fr['brass'] = True
        fr['frame_of'] = ob.name
        objs.append(fr)

    # ── 前室: 円天井の高い部屋。床、両側の壁と天井、乗り場の側の壁（乗り場の入口の穴） ──
    zs = np.linspace(ORIGIN, DOORS_AT, 40)
    m2 = len(vest_prof)
    verts = F.pts([(x, y, z) for z in zs for (x, y) in vest_prof])
    faces = [(j * m2 + i, j * m2 + i + 1, (j + 1) * m2 + i + 1, (j + 1) * m2 + i) for j in range(len(zs) - 1) for i in range(m2 - 1)]
    faces = oriented_to_axis(verts, faces, F, FLOOR_Y + VEST_WALL * 0.6)
    # 天井の真ん中の楕円の天窓（ガラス）の所は抜く
    sky_c = (0.0, (ORIGIN + DOORS_AT) / 2)
    keep = []
    for f in faces:
        c = verts[list(f)].mean(0)
        lx = float(np.dot(c - F.s, F.side))
        lz = float(np.dot(c - F.s, F.back))
        keep.append(not (((lx - sky_c[0]) / 1.9) ** 2 + ((lz - sky_c[1]) / 3.6) ** 2 < 1.0 and c[1] > FLOOR_Y + VEST_WALL))
    plaster.add(verts, [f for f, k in zip(faces, keep) if k])
    sv = []
    for a in np.linspace(0, 2 * np.pi, 48, endpoint=False):
        lx, lz = 2.05 * math.cos(a), sky_c[1] + 3.75 * math.sin(a)
        yy = FLOOR_Y + VEST_WALL + (VEST_TOP - VEST_WALL) * math.sqrt(max(0.0, 1 - (lx / VEST_HALF) ** 2)) - 0.05
        sv.append(F.p(lx, yy, lz))
    sv = np.array(sv)
    gv = np.vstack([sv.mean(0) + np.array([0, 0.25, 0]), sv])
    gf = oriented(gv, [(0, 1 + k, 1 + (k + 1) % 48) for k in range(48)], np.array([0, -1.0, 0]))
    ob = mesh_object('lobby.skylight', gv, gf, m_glass, coll, smooth=True,
                     props={'glass': 'milky', 'glass_color': '#55698c', 'glass_opacity': 0.45, 'glass_emissive': '#3d5a8c', 'glass_emissive_intensity': 0.35})
    objs.append(ob)
    brass.add(*tube(np.vstack([sv, sv[:1]]), 0.05, 8, caps=False))
    # 前室の床（明るい石）と、中央の円い真鍮の象嵌
    fv = F.pts([(-VEST_HALF, FLOOR_Y, ORIGIN), (VEST_HALF, FLOOR_Y, ORIGIN), (VEST_HALF, FLOOR_Y, DOORS_AT), (-VEST_HALF, FLOOR_Y, DOORS_AT)])
    floor_light.add(fv, oriented(fv, [(0, 1, 2, 3)], np.array([0, 1.0, 0])))
    for rr in (1.2, 1.55):
        a = np.linspace(0, 2 * np.pi, 64, endpoint=False)
        brass.add(*tube(F.pts([(rr * math.cos(x), FLOOR_Y + 0.004, 14.6 + rr * math.sin(x)) for x in a]), 0.014, 4, caps=False, closed=True))
    # 乗り場の側の壁（乗り場の入口の穴）
    plat_hole = dense_outline(kit.arch_outline(kit.SOUTH_DOOR_HALF, kit.SOUTH_DOOR_TOP, FLOOR_Y - 0.05, 32))
    wv, wf = ring_wall(outer, plat_hole, (0.0, FLOOR_Y + 2.4), 128)
    wv3 = F.pts([(x, y, ORIGIN) for x, y in wv])
    plaster.add(wv3, oriented(wv3, wf, F.back))
    # 前室の腰の帯（濃い色）
    for side in (-1, 1):
        bv = F.pts([(side * (VEST_HALF - 0.02), FLOOR_Y, ORIGIN), (side * (VEST_HALF - 0.02), FLOOR_Y + 1.1, ORIGIN),
                    (side * (VEST_HALF - 0.02), FLOOR_Y + 1.1, DOORS_AT), (side * (VEST_HALF - 0.02), FLOOR_Y, DOORS_AT)])
        plaster_dark.add(bv, oriented(bv, [(0, 1, 2, 3)], -F.side * side))
        brass.add(*tube(F.pts([(side * (VEST_HALF - 0.04), FLOOR_Y + 1.1, ORIGIN), (side * (VEST_HALF - 0.04), FLOOR_Y + 1.1, DOORS_AT)]), 0.025, 6, caps=False))
    # 前室の壁の真鍮の付け柱（各側に3本）
    for side in (-1, 1):
        for z in (10.6, 14.6, 18.6):
            brass.add(*tube(F.pts([(side * (VEST_HALF - 0.12), FLOOR_Y, z), (side * (VEST_HALF - 0.12), FLOOR_Y + VEST_WALL, z)]), 0.07, 10))

    # ── 入口のアーチ: 乳白のガラスの厚い帯。表と裏の縁に真鍮 ──
    out_o = kit.arch_outline(ARCH_OUT_HALF, FLOOR_Y + ARCH_OUT_TOP, FLOOR_Y, 40)
    in_o = kit.arch_outline(ARCH_IN_HALF, FLOOR_Y + ARCH_IN_TOP, FLOOR_Y, 40)
    av, af = arch_band(F, out_o, in_o, ARCH_AT, ARCH_DEPTH)
    ob = mesh_object('lobby.arch', av, af, emitter('lobby.arch_light', '#ffe0b8', 1.6), coll, smooth=True,
                     props={'role': 'arch', 'glass': 'tinted', 'glass_color': '#d9b98e', 'glass_opacity': 0.34, 'glass_emissive': '#ffcf94', 'glass_emissive_intensity': 0.22, 'glass_iridescence': 0.25})
    objs.append(ob)
    for z in (ARCH_AT - ARCH_DEPTH / 2 - 0.02, ARCH_AT + ARCH_DEPTH / 2 + 0.02):
        brass.add(*tube(F.pts([(x, y, z) for x, y in out_o]), 0.04, 8))
        brass.add(*tube(F.pts([(x, y, z) for x, y in in_o]), 0.035, 8))
    # アーチの脚の真鍮の台座
    for side in (-1, 1):
        cx = side * (ARCH_OUT_HALF + ARCH_IN_HALF) / 2
        brass.add(*lathe([(0.0, 0.0), (0.42, 0.0), (0.42, 0.12), (0.36, 0.2), (0.32, 0.2)], 24, F.p(cx, FLOOR_Y, ARCH_AT)))

    # ── 立て札: 前室の右の、曇りガラスの板と真鍮の脚（乗車前の案内） ──
    sx, sz = 2.6, 12.4
    sv = F.pts([(sx - 0.55, FLOOR_Y + 0.95, sz), (sx + 0.55, FLOOR_Y + 0.95, sz), (sx + 0.55, FLOOR_Y + 2.05, sz), (sx - 0.55, FLOOR_Y + 2.05, sz)])
    ob = mesh_object('lobby.sign', sv, oriented(sv, [(0, 1, 2, 3)], F.back), m_glass, coll, smooth=False,
                     props={'role': 'sign', 'glass': 'frosted', 'glass_color': '#7a8594', 'glass_opacity': 0.35})
    objs.append(ob)
    brass.add(*tube(np.vstack([sv, sv[:1]]), 0.025, 6, caps=False))
    for dx in (-0.45, 0.45):
        brass.add(*tube(F.pts([(sx + dx, FLOOR_Y, sz), (sx + dx, FLOOR_Y + 0.95, sz)]), 0.02, 6))

    for name, b, mm in (('lobby.plaster', plaster, m_plaster), ('lobby.plaster_dark', plaster_dark, m_plaster_dark), ('lobby.floor', floor, m_floor),
                        ('lobby.floor_light', floor_light, m_floor_light)):
        ob = b.build(name, mm, coll, smooth=name.startswith('lobby.plaster'))
        objs.append(ob)
        bake.append(ob)
    ob = brass.build('lobby.brass', m_brass, coll, props={'brass': True})
    objs.append(ob)

    # ── 焼き込みだけの光: 乗り場の入口から差すホールの光 ──
    helpers = []
    hv = F.pts([(-kit.SOUTH_DOOR_HALF, FLOOR_Y, ORIGIN - 0.6), (kit.SOUTH_DOOR_HALF, FLOOR_Y, ORIGIN - 0.6), (kit.SOUTH_DOOR_HALF, FLOOR_Y + kit.SOUTH_DOOR_TOP, ORIGIN - 0.6),
                (-kit.SOUTH_DOOR_HALF, FLOOR_Y + kit.SOUTH_DOOR_TOP, ORIGIN - 0.6)])
    helpers.append(mesh_object('lobby.bake_hall_light', hv, oriented(hv, [(0, 1, 2, 3)], F.back), emitter('lobby.hall_light', '#a9b8d8', 2.4), coll, smooth=False))
    kit.set_world('#18233a', 0.25)
    # 反射用の環境画像（前室の中ほど）と、extras の入れ物
    holder = bpy.data.objects.new('lobby.instances', None)
    coll.objects.link(holder)
    holder['env'] = kit.render_env('lobby.env', F.p(0.0, FLOOR_Y + 2.2, 13.5), samples=24 if fast else 96)
    objs.append(holder)

    # 見えない面: 待ち列の視点から入口・乗り場へ進む道筋と、乗り場の始点から振り返る視線
    path = F.pts([(0.0, FLOOR_Y + 1.55, z) for z in np.linspace(CORRIDOR_END - 2.0, 3.0, 90)])
    vp = np.vstack([path, rail.samples(0.0, 25.0, 0.5)])
    samples = 48 if fast else 512
    kit.finish_room('lobby', rail, objs, vp, None, bake, size=1024, samples=samples, webp=90)
    for ob in helpers:
        bpy.data.objects.remove(ob)
    kit.save_blend('lobby')


def set_origin(ob, origin_three) -> None:
    """物の原点を three.js の座標の点へ（見た目は動かさない）"""
    o = kit.to_blender(np.asarray(origin_three, dtype=np.float64))
    me = ob.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3) - o
    me.vertices.foreach_set('co', co.reshape(-1))
    me.update()
    ob.location = tuple(o.tolist())


def oriented_to_axis(verts: np.ndarray, faces, F: Frame, axis_y: float):
    """筒の内側の面（通路・前室の壁と天井）を、通路の中心の軸の方へ向ける"""
    out = []
    for f in faces:
        q = list(f)
        n = np.cross(verts[q[1]] - verts[q[0]], verts[q[2]] - verts[q[0]])
        c = verts[q].mean(0)
        lz = float(np.dot(c - F.s, F.back))
        want = F.p(0, axis_y, lz) - c
        out.append(tuple(q) if np.dot(n, want) > 0 else tuple(reversed(q)))
    return out


def arch_band(F: Frame, outer: list, inner: list, z: float, depth: float):
    """アーチの帯（表・裏・外の縁・内の縁）。outer と inner は同じ点の数の輪郭（左下 → 右下）"""
    n = len(outer)
    assert n == len(inner)
    zf, zb = z - depth / 2, z + depth / 2
    verts = []
    for zz in (zf, zb):
        verts += [F.p(x, y, zz) for x, y in outer]
        verts += [F.p(x, y, zz) for x, y in inner]
    verts = np.array(verts)
    o_f, i_f, o_b, i_b = 0, n, 2 * n, 3 * n
    faces = []
    center = F.p(0, FLOOR_Y + 2.5, z)
    for k in range(n - 1):
        faces.append(((o_f + k, o_f + k + 1, i_f + k + 1, i_f + k), -F.back))  # 乗り場の側
        faces.append(((o_b + k, o_b + k + 1, i_b + k + 1, i_b + k), F.back))  # 入口の視点の側
        faces.append(((o_f + k, o_f + k + 1, o_b + k + 1, o_b + k), None))  # 外の縁（外向き）
        faces.append(((i_f + k, i_f + k + 1, i_b + k + 1, i_b + k), 'in'))  # 内の縁（開口の方）
    out = []
    for q, want in faces:
        nrm = np.cross(verts[q[1]] - verts[q[0]], verts[q[2]] - verts[q[0]])
        c = verts[list(q)].mean(0)
        if want is None:
            w = c - center  # 外の縁は外向き
        elif isinstance(want, str):
            w = center - c  # 内の縁は開口の方
        else:
            w = want  # 表（back、入口の視点の側）と裏（乗り場の側）
        out.append(q if np.dot(nrm, w) > 0 else tuple(reversed(q)))
    return verts, out


def main() -> None:
    rail = kit.Rail()
    build_lobby(rail, kit.fast_mode())


if __name__ == '__main__':
    main()
