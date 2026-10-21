"""第4室「星の天球」の造形（BLD-4〜7、ADR-0009）。

    pnpm blender blender/scripts/rooms/celestial.py [-- --samples 1024 --size 1024 --no-bake]

一枚絵（絵コンテの代わり）:
  8:02、2秒の暗転が明けると、ゴンドラの左前方、星の海の向こうに巨大なガラスの球（外殻 61.5m）の縁が
  大きな弧を描いて現れる。縁は薄膜の虹色にかすかに光り、内側には同心の殻が4枚、入れ子の泡のように重なって見える。
  真鍮の細い子午線と黄道の輪が球を抱き、球の下には藍の釉の台座（受け皿と柱）が星明かりを受けて沈んでいる。
  星は一つずつ灯り、やがて球の内にも外にも満ちる。レールは球の周りを回りこみながら近づき、8:39 に外殻を抜け、
  殻を一枚ずつ抜けながら上昇して 9:50 に中心（真鍮の輪が2本交わる「天の芯」）に着く。正面には星座の街が描かれる。
  出口は外殻に開いた膜（真鍮の輪で縁取った虹色の窓）。その向こうが夜明けの岸。

ここで作る物（名前は `celestial.<部品>[.<番号>]`、カスタムプロパティは glb の extras → three の userData）:
  - celestial.shell.0〜4   同心の透明な球殻（role=shell、glass、clearance_exempt）。内側から 13・22・33・46・61.5m
  - celestial.membrane      外殻の出口の膜（role=membrane、glass、clearance_exempt）
  - celestial.meridian.N    外殻を抱く真鍮の輪（子午線と黄道）。10° の弧を並べる（instance_group。TS で InstancedMesh にまとめる）
  - celestial.heart.N       中心の真鍮の輪2本（instance_group）
  - celestial.membrane_ring.N  膜の縁の真鍮の輪（instance_group）
  - celestial.pedestal      藍の釉の台座。光を焼き込む（lightmap・lightmap_scale）
  - celestial.star_a/b/c    星のガラス玉の型（role=star_template。TS が数千のインスタンスにする。焼かない）
  - celestial.star_touch.N  触れられる星（touch_kind=star、touch_id、glass）
  - celestial.hidden_bubble 隠れた小さな泡（touch_kind=hidden-bubble）

ゴンドラ（半径 1.2m）の表面から 0.5m 以上（RIDE-8）: 殻と膜のほかは、レールの点（0.5m ごと）から
物の軸に沿った箱（テストと同じ測り方）まで 1.75m 以上あることを確かめ、足りなければ止める。
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
from common.coords import UP, horizontal_frames, three_to_blender  # noqa: E402
from common.export import export_glb, room_load_report  # noqa: E402
from common.naming import check_names  # noqa: E402
from common.visibility import cull_hidden  # noqa: E402

ROOT = os.path.abspath(os.path.join(SCRIPTS, '..', '..'))
RAIL_JSON = os.path.join(ROOT, 'public', 'assets', 'rail.json')
OUT_DIR = os.path.join(ROOT, 'public', 'assets', 'rooms')
GLB = os.path.join(OUT_DIR, 'celestial.glb')
BLEND = os.path.join(ROOT, 'blender', 'scenes', 'celestial.blend')

ROOM = 'celestial'
#: 9:50（MOMENT_BARS.celestialConstellation × SEC_PER_BAR）。この時刻のゴンドラの位置が球の中心
CONSTELLATION_T = 177 * 10.0 / 3.0
#: 殻の半径（内から外）。外殻は中心から 62m 以内（ADR-0009）。出口のレールの端は中心から約 62.1m
SHELL_RADII = (13.0, 22.0, 33.0, 46.0, 61.5)
#: ゴンドラの半径 + 物との最短距離（GONDOLA_DIAMETER / 2 + MOTION.clearanceMin）に少し余裕
CLEARANCE = 1.2 + 0.5 + 0.05
#: 乱数の種（形を毎回同じにする）
SEED = 20261021


# ── レール ───────────────────────────────────────────────────────────────
class Rail:
    """rail.json のレール（Blender の座標）。s は点の番号 × spacing、t → s は時刻表の線形補間"""

    def __init__(self, path: str):
        with open(path, encoding='utf-8') as f:
            ride = json.load(f)
        self.spacing = float(ride['rail']['spacing'])
        self.points = np.array([three_to_blender(p) for p in ride['rail']['points']], dtype=np.float64)
        self.T = np.array([e['t'] for e in ride['timeline']], dtype=np.float64)
        self.S = np.array([e['s'] for e in ride['timeline']], dtype=np.float64)
        self.sections = {e['id']: (float(e['s0']), float(e['s1'])) for e in ride['sections']}
        self.fwd, self.right = horizontal_frames(self.points)

    def s_at(self, t: float) -> float:
        return float(np.interp(t, self.T, self.S))

    def point(self, s: float) -> np.ndarray:
        x = min(max(s / self.spacing, 0.0), len(self.points) - 1.000001)
        i = int(math.floor(x))
        f = x - i
        return self.points[i] * (1 - f) + self.points[i + 1] * f

    def frame(self, s: float) -> tuple[np.ndarray, np.ndarray]:
        i = int(round(min(max(s / self.spacing, 0), len(self.points) - 1)))
        return self.fwd[i], self.right[i]

    def samples(self, s0: float, s1: float, step: float = 0.5) -> np.ndarray:
        n = max(2, int(math.ceil((s1 - s0) / step)) + 1)
        return np.array([self.point(s0 + (s1 - s0) * k / (n - 1)) for k in range(n)])


def box_distance(lo: np.ndarray, hi: np.ndarray, pts: np.ndarray) -> float:
    """点の集まりから軸に沿った箱までの最短距離（three の Box3.distanceToPoint と同じ）"""
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


def material(name: str, color=(0.8, 0.8, 0.8), *, metallic=0.0, roughness=0.5, emission=None, strength=0.0, alpha=1.0):
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
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
        bsdf.inputs['Emission Strength'].default_value = strength
    m.diffuse_color = (*color, alpha)
    return m


def mesh_object(name: str, bm, coll, mat=None, props: dict | None = None, smooth=True, mesh_name: str | None = None):
    me = bpy.data.meshes.new(mesh_name or name)
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


def linked_object(name: str, me, coll, matrix: Matrix, props: dict | None = None):
    ob = bpy.data.objects.new(name, me)
    ob.matrix_world = matrix
    for k, v in (props or {}).items():
        ob[k] = v
    coll.objects.link(ob)
    return ob


def uv_sphere(radius: float, u: int, v: int):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=radius)
    return bm


def ico_sphere(radius: float, subdiv: int):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=radius)
    return bm


def arc_bmesh(major: float, minor: float, span: float, n_major: int, n_minor: int = 8):
    """局所の XY 平面にある輪の弧（+X を中心に ±span/2）。隣の弧と端の輪が一致するので、並べると継ぎ目のない輪になる"""
    bm = bmesh.new()
    rows = []
    for i in range(n_major + 1):
        phi = -span / 2 + span * i / n_major
        radial = Vector((math.cos(phi), math.sin(phi), 0.0))
        c = radial * major
        row = []
        for j in range(n_minor):
            psi = math.tau * j / n_minor
            row.append(bm.verts.new(c + (radial * math.cos(psi) + Vector((0, 0, 1)) * math.sin(psi)) * minor))
        rows.append(row)
    for i in range(n_major):
        for j in range(n_minor):
            a, b = rows[i][j], rows[i][(j + 1) % n_minor]
            c, d = rows[i + 1][(j + 1) % n_minor], rows[i + 1][j]
            bm.faces.new((a, b, c, d))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def basis_from_normal(n: np.ndarray, hint: np.ndarray | None = None) -> Matrix:
    """局所の Z を n に向ける回転（X は hint を n に直交させた向き）"""
    n = n / np.linalg.norm(n)
    h = np.array([0.0, 0.0, 1.0]) if hint is None else hint
    if abs(float(np.dot(h, n))) > 0.95:
        h = np.array([1.0, 0.0, 0.0])
    x = h - n * np.dot(h, n)
    x /= np.linalg.norm(x)
    y = np.cross(n, x)
    return Matrix(((x[0], y[0], n[0]), (x[1], y[1], n[1]), (x[2], y[2], n[2]))).to_4x4()


def ring_matrices(center: np.ndarray, normal: np.ndarray, count: int, hint: np.ndarray | None = None) -> list[Matrix]:
    rot = basis_from_normal(normal, hint)
    loc = Matrix.Translation(Vector(center.tolist()))
    return [loc @ rot @ Matrix.Rotation(math.tau * k / count, 4, 'Z') for k in range(count)]


def lathe_bmesh(profile: list[tuple[float, float]], center_xy: tuple[float, float], segments: int):
    """(半径, 高さ) の折れ線を縦の軸の周りに回した面。両端が軸の上（半径 0）なら1点に閉じる"""
    bm = bmesh.new()
    cx, cy = center_xy
    rings = []
    for rho, z in profile:
        if rho < 1e-6:
            rings.append([bm.verts.new((cx, cy, z))])
        else:
            rings.append([bm.verts.new((cx + rho * math.cos(math.tau * k / segments), cy + rho * math.sin(math.tau * k / segments), z)) for k in range(segments)])
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


# ── 部屋 ─────────────────────────────────────────────────────────────────
def build(rail: Rail, rng: random.Random) -> dict:
    coll = collection(ROOM)
    bake_coll = collection(f'{ROOM}_bake')  # 焼き込みのためだけの光（書き出さない）

    s0, s1 = rail.sections[ROOM]
    s_center = rail.s_at(CONSTELLATION_T)
    C = rail.point(s_center)
    f_c, r_c = rail.frame(s_center)
    print(f'{ROOM}: 中心 {C.round(3).tolist()}（s={s_center:.2f}）、区間 s={s0:.2f}〜{s1:.2f}')

    # 外殻を抜ける点（入口と出口）
    def crossing(r: float, lo: float, hi: float) -> tuple[float, np.ndarray]:
        ss = np.linspace(lo, hi, 4000)
        d = np.array([np.linalg.norm(rail.point(s) - C) for s in ss])
        k = int(np.argmin(np.abs(d - r)))
        return float(ss[k]), rail.point(float(ss[k]))

    s_in, p_in = crossing(SHELL_RADII[-1], s0, s_center)
    s_out, p_out = crossing(SHELL_RADII[-1], s_center, s1 + 5)
    print(f'{ROOM}: 外殻の入口 s={s_in:.2f}、出口 s={s_out:.2f}（区間の終わりまで {s1 - s_out:.2f}m）')
    path = rail.samples(s0 - 2, s1 + 2, 0.5)  # 区間のレール（物との距離を測る）

    glass_mat = material(f'{ROOM}.glass', (0.85, 0.9, 1.0), roughness=0.05, alpha=0.08)
    brass_mat = material(f'{ROOM}.brass', (0.78, 0.60, 0.34), metallic=1.0, roughness=0.32)
    enamel_mat = material(f'{ROOM}.enamel', (0.62, 0.64, 0.72), roughness=0.45)
    star_mat = material(f'{ROOM}.star', (1.0, 0.97, 0.9), roughness=0.05, emission=(1.0, 0.95, 0.85), strength=1.0)  # 1 を超えると glTF の拡張（KHR_materials_emissive_strength）が要る

    objs: dict[str, list] = {'shell': [], 'membrane': [], 'brass': [], 'baked': [], 'template': [], 'touch': [], 'hidden': []}

    # 1. 同心の殻。外ほど細かく（縁の輪郭が角ばらないよう）
    for i, r in enumerate(SHELL_RADII):
        u = 128 if r > 40 else 96 if r > 20 else 72
        ob = mesh_object(f'{ROOM}.shell.{i}', uv_sphere(r, u, u // 2), coll, glass_mat, {
            'role': 'shell', 'glass': 'iridescent', 'clearance_exempt': True, 'radius': r, 'layer': i,
        })
        ob.location = Vector(C.tolist())
        objs['shell'].append(ob)

    # 2. 出口の膜: 外殻の上の丸い窓（球面の一部）。外殻より 5cm 外に浮かせる
    out_dir = (p_out - C) / np.linalg.norm(p_out - C)
    e1 = np.cross(out_dir, np.array([0.0, 0.0, 1.0]))
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(out_dir, e1)
    r_mem = SHELL_RADII[-1] + 0.05
    a_max = 3.0 / r_mem
    bm = bmesh.new()
    centre = bm.verts.new((C + out_dir * r_mem).tolist())
    rings = []
    for j in range(1, 11):
        a = a_max * j / 10
        rings.append([bm.verts.new((C + (out_dir * math.cos(a) + (e1 * math.cos(b) + e2 * math.sin(b)) * math.sin(a)) * r_mem).tolist())
                      for b in np.linspace(0, math.tau, 48, endpoint=False)])
    for k in range(48):
        bm.faces.new((centre, rings[0][k], rings[0][(k + 1) % 48]))
    for ra, rb in zip(rings[:-1], rings[1:]):
        for k in range(48):
            bm.faces.new((ra[k], rb[k], rb[(k + 1) % 48], ra[(k + 1) % 48]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    objs['membrane'].append(mesh_object(f'{ROOM}.membrane', bm, coll, glass_mat, {
        'role': 'membrane', 'glass': 'membrane', 'clearance_exempt': True, 'to': 'dawn',
    }))

    # 3. 真鍮の輪（弧を並べる。弧ごとの箱でレールとの距離を確かめる）
    def brass_ring(group: str, center: np.ndarray, normal: np.ndarray, major: float, minor: float, count: int, n_major: int, hint=None):
        me_name = f'{ROOM}.arc_{group}_{int(round(major * 100))}'  # 大きさの違う輪は別の形
        me = bpy.data.meshes.get(me_name)
        if me is None:
            ob0 = mesh_object(me_name, arc_bmesh(major, minor, math.tau / count, n_major), coll, brass_mat)
            me = ob0.data
            bpy.data.objects.remove(ob0, do_unlink=True)
        made = []
        for k, m in enumerate(ring_matrices(center, normal, count, hint)):
            ob = linked_object(f'{ROOM}.{group}.{len([o for o in objs["brass"] if o["instance_group"] == group]) + k:03d}', me, coll, m, {
                'role': 'brass', 'instance_group': group,
            })
            made.append(ob)
        bpy.context.view_layer.update()
        worst = min(box_distance(*world_box(o), path) for o in made)
        objs['brass'].extend(made)
        return worst

    def best_normal(cands: list[np.ndarray], center: np.ndarray, radius: float, keep_from: list[np.ndarray]) -> np.ndarray:
        """輪の面が keep_from の点から最も離れる向き（球の上の点と輪の距離 ≈ 半径 × 面からの角度）"""
        best, score = cands[0], -1.0
        for n in cands:
            n = n / np.linalg.norm(n)
            sc = min(abs(float(np.dot((p - center) / np.linalg.norm(p - center), n))) for p in keep_from)
            if sc > score:
                best, score = n, sc
        return best

    # 子午線（縦）と黄道（23.4° 傾けた横）。外殻の入口と出口から離れる向きを選ぶ
    r_mer = SHELL_RADII[-1] + 0.3
    cands = [np.array([math.cos(a), math.sin(a), 0.0]) for a in np.radians(np.arange(0, 180, 2.0))]
    n_mer = best_normal(cands, C, r_mer, [p_in, p_out])
    tilt = math.radians(23.4)
    cands = [np.array([math.sin(tilt) * math.cos(a), math.sin(tilt) * math.sin(a), math.cos(tilt)]) for a in np.radians(np.arange(0, 360, 3.0))]
    n_ecl = best_normal(cands, C, r_mer, [p_in, p_out])
    w1 = brass_ring('meridian', C, n_mer, r_mer, 0.11, 36, 6)
    w2 = brass_ring('meridian', C, n_ecl, r_mer, 0.11, 36, 6)

    # 中心の「天の芯」: レールに直交する輪と、傾けた輪
    n_heart_a = np.array(f_c, dtype=np.float64)
    tilt_axis = np.array(r_c, dtype=np.float64)
    n_heart_b = (Matrix.Rotation(math.radians(36), 3, Vector(UP.tolist())) @ Matrix.Rotation(math.radians(24), 3, Vector(tilt_axis.tolist())) @ Vector(n_heart_a.tolist()))
    w3 = brass_ring('heart', C, n_heart_a, 4.8, 0.05, 24, 4)
    w4 = brass_ring('heart', C, np.array(n_heart_b), 5.6, 0.04, 24, 4)

    # 膜の縁の輪（外殻の上の、膜を囲む小さな円）
    a_ring = 3.2 / r_mem
    ring_center = C + out_dir * r_mem * math.cos(a_ring)
    w5 = brass_ring('membrane_ring', ring_center, out_dir, r_mem * math.sin(a_ring), 0.06, 12, 4, hint=np.array([0.0, 0.0, 1.0]))
    print(f'{ROOM}: 真鍮の輪とレールの最短（箱）: 子午線 {w1:.2f}m・黄道 {w2:.2f}m・芯 {w3:.2f}m／{w4:.2f}m・膜の縁 {w5:.2f}m')
    for w, nm in ((w1, '子午線'), (w2, '黄道'), (w3, '芯A'), (w4, '芯B'), (w5, '膜の縁')):
        if w < CLEARANCE:
            raise SystemExit(f'{nm}の輪がレールに近すぎます（{w:.2f}m < {CLEARANCE}m）')

    # 4. 台座: 受け皿（球の南極を抱く浅い皿）、吹きガラスの節のある柱、広い足。藍の釉（光を焼き込む）
    R = SHELL_RADII[-1]
    prof: list[tuple[float, float]] = []
    zc = float(C[2])
    inner = R + 0.9
    lip_a = math.radians(17.0)
    for deg in np.linspace(0.0, 17.0, 18):  # 受け皿の内側（球に沿って）
        a = math.radians(deg)
        prof.append((inner * math.sin(a), zc - inner * math.cos(a)))
    # 縁を丸く（角を作らない）: 内側の面から外側の面へ、皿の厚み 1.4m の半円で回る
    radial = np.array([math.sin(lip_a), -math.cos(lip_a)])
    tangent = np.array([math.cos(lip_a), math.sin(lip_a)])
    lip_c = radial * (inner + 0.7) + np.array([0.0, zc])
    for k in range(1, 12):
        b = math.pi * k / 12
        q = lip_c + 0.7 * (-radial * math.cos(b) + tangent * math.sin(b))
        prof.append((float(q[0]), float(q[1])))
    outer = inner + 1.4
    rho_lip = outer * math.sin(lip_a)
    rho_col = 2.2
    for rho in np.linspace(rho_lip, rho_col, 22):  # 受け皿の下面。柱へ向かって厚くなる
        prof.append((float(rho), zc - math.sqrt(outer * outer - rho * rho) - 4.0 * (1 - rho / rho_lip) ** 3))
    z_top = prof[-1][1]
    z_foot = zc - R - 70.0
    for k in range(1, 61):  # 柱: 吹きガラスの節（ふくらみ）を3つ
        z = z_top - (z_top - (z_foot + 3.0)) * k / 60
        bump = sum(a * math.exp(-((z - zb) / 2.6) ** 2) for zb, a in ((z_top - 9, 1.6), (z_top - 28, 1.2), (z_top - 48, 1.0)))
        prof.append((rho_col + bump - 0.4 * (1 - math.exp(-((z - z_top) / 6.0) ** 2)), z))
    for k in range(1, 13):  # 足: 広がって丸い縁
        u = k / 12
        prof.append((prof[-1][0] if k == 0 else 1.8 + 13.2 * math.sin(u * math.pi / 2) ** 1.5, z_foot + 3.0 - 1.6 * u))
    for k in range(1, 9):
        b = math.pi / 2 - math.pi * k / 8
        prof.append((15.0 + 1.0 * math.cos(b), z_foot + 0.4 + 1.0 * math.sin(b)))
    prof.append((10.0, z_foot - 0.6))
    prof.append((0.0, z_foot - 0.7))
    ped = mesh_object(f'{ROOM}.pedestal', lathe_bmesh(prof, (float(C[0]), float(C[1])), 72), coll, enamel_mat, {'role': 'pedestal'})
    bm = bmesh.new()
    bm.from_mesh(ped.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ped.data)
    bm.free()
    objs['baked'].append(ped)
    bpy.context.view_layer.update()
    print(f'{ROOM}: 台座とレールの最短（箱）{box_distance(*world_box(ped), path):.2f}m')

    # 5. 星のガラス玉の型（半径 1。TS がインスタンスの大きさを決める）。レールから遠い所に置く（TS が外す）
    far = C + np.array([0.0, 0.0, -300.0])
    for name, bm in (('star_a', ico_sphere(1.0, 1)), ('star_b', ico_sphere(1.0, 2)), ('star_c', uv_sphere(1.0, 20, 10))):
        ob = mesh_object(f'{ROOM}.{name}', bm, coll, star_mat, {'role': 'star_template', 'glass': 'clear', 'star_kind': name[-1]})
        ob.location = Vector(far.tolist())
        objs['template'].append(ob)

    # 6. 触れられる星: 入口側の道に 6 つ、出口側に 2 つの小さな群れ（4 つずつ）。進む先の左右・上に、近い星どうしが線で結べる間隔で
    touch_me = bpy.data.meshes.new(f'{ROOM}.star_touch')
    bm = uv_sphere(0.42, 32, 16)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(touch_me)
    bm.free()
    touch_me.materials.append(star_mat)
    clusters = [(526, 1, 1.6), (536, -1, 2.4), (546, 1, 0.6), (556, -1, 1.8), (566, 1, 2.6), (577, -1, 1.2), (641, 1, 2.2), (651, -1, 0.9)]
    n_touch = 0
    touch_pos: list[np.ndarray] = []

    def ok_star(p: np.ndarray, rail_min: float) -> bool:
        if float(np.sqrt(((path - p) ** 2).sum(axis=1)).min()) < rail_min:
            return False
        d = float(np.linalg.norm(p - C))
        if min(abs(d - r) for r in SHELL_RADII) < 0.9:
            return False
        return all(np.linalg.norm(p - q) >= 1.6 for q in touch_pos)

    for ci, (t_c, side, h) in enumerate(clusters):
        sc = rail.s_at(t_c)
        base = rail.point(sc)
        fw, rt = rail.frame(sc)
        center = base + fw * 6.5 + rt * side * 4.4 + UP * h
        placed = 0
        for _ in range(400):
            if placed == 4:
                break
            off = np.array([rng.uniform(-1, 1) for _ in range(3)])
            off = off / max(1e-6, np.linalg.norm(off)) * rng.uniform(0.9, 2.3)
            p = center + off
            if not ok_star(p, 2.9):
                continue
            if placed and min(np.linalg.norm(p - q) for q in touch_pos[-placed:]) > 4.2:
                continue
            m = Matrix.Translation(Vector(p.tolist()))
            ob = linked_object(f'{ROOM}.star_touch.{n_touch:03d}', touch_me, coll, m, {
                'role': 'touch_star', 'glass': 'clear', 'touch_kind': 'star', 'touch_id': f'{ROOM}/star-{n_touch:03d}', 'cluster': ci,
            })
            objs['touch'].append(ob)
            touch_pos.append(p)
            n_touch += 1
            placed += 1
        if placed < 4:
            raise SystemExit(f'触れられる星の群れ（{t_c}s）を置けません')
    print(f'{ROOM}: 触れられる星 {n_touch} 個')

    # 7. 隠れた小さな泡: 一番内側の殻に入る少し手前、左下の暗がりに
    sh = rail.s_at(569.5)
    base = rail.point(sh)
    fw, rt = rail.frame(sh)
    p = base + fw * 3.0 - rt * 2.3 - UP * 0.9
    for _ in range(200):
        if ok_star(p, 2.3):
            break
        p = p - rt * 0.1
    ob = mesh_object(f'{ROOM}.hidden_bubble', uv_sphere(0.16, 24, 12), coll, glass_mat, {
        'role': 'hidden', 'glass': 'iridescent', 'touch_kind': 'hidden-bubble', 'touch_id': f'{ROOM}/hidden',
    })
    ob.location = Vector(p.tolist())
    objs['hidden'].append(ob)

    # 8. 焼き込みのための光: 球の内側の星の光（大きな発光の球）と、外の星（小さな発光の玉）、夜の藍の空
    glow = mesh_object(f'{ROOM}.bake_glow', uv_sphere(55.0, 48, 24), bake_coll, material(f'{ROOM}.bake_glow', (0, 0, 0), emission=(0.72, 0.80, 1.0), strength=0.8))
    glow.location = Vector(C.tolist())
    pts = []
    for _ in range(420):
        v = np.array([rng.gauss(0, 1) for _ in range(3)])
        v /= np.linalg.norm(v)
        pts.append(C + v * rng.uniform(66.0, 170.0))
    bm = bmesh.new()
    for q in pts:
        g = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=rng.uniform(0.4, 0.9))
        bmesh.ops.translate(bm, verts=g['verts'], vec=Vector(q.tolist()))
    mesh_object(f'{ROOM}.bake_stars', bm, bake_coll, material(f'{ROOM}.bake_star', (0, 0, 0), emission=(1.0, 0.95, 0.88), strength=60.0))
    world = bpy.context.scene.world or bpy.data.worlds.new('World')
    bpy.context.scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (0.010, 0.013, 0.035, 1.0)
    bg.inputs['Strength'].default_value = 1.0

    return {'C': C, 'objs': objs, 'bake_coll': bake_coll, 's_in': s_in, 's_out': s_out}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--samples', type=int, default=1024)
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--no-bake', action='store_true')
    args = ap.parse_args(script_args())
    t_start = time.time()
    clear_scene()
    rail = Rail(RAIL_JSON)
    rng = random.Random(SEED)
    info = build(rail, rng)
    objs = info['objs']
    bpy.context.view_layer.update()  # 作った物をビューレイヤーに反映する（書き出しと削除はビューレイヤーの物を使う）

    # 見えない面の削除: 不透明な物（台座と真鍮の輪）だけ。ガラス（殻・星・膜）は光線を通すので渡さない。
    # 区間の前後に 30m の余裕（前の部屋の終わりと、夜明けの岸の頭から見える）
    s0, s1 = rail.sections[ROOM]
    span = rail.samples(max(0.0, s0 - 30), s1 + 30, rail.spacing)
    opaque = objs['baked'] + objs['brass']
    rep = cull_hidden(opaque, span, yaw_deg=120, pitch_deg=60, head_radius=0.5)
    print(f"cull: {rep['before_tris']} → {rep['after_tris']} 三角形（{rep['removed_faces']} 面を削除、{rep['rays']} 本、{rep['seconds']}s）")
    for name, o in rep['objects'].items():
        if o['before_tris'] != o['after_tris'] and not name.split('.')[1] in ('meridian', 'heart', 'membrane_ring'):
            print(f"  {name}: {o['before_tris']} → {o['after_tris']}")
    if rep['emptied']:
        print(f"  全部消えた物: {rep['emptied']}")

    export = objs['shell'] + objs['membrane'] + objs['brass'] + objs['baked'] + objs['template'] + objs['touch'] + objs['hidden']
    bad = check_names(export, rooms=[ROOM])
    if bad:
        raise SystemExit(f'名前の規則に合わない物: {bad}')

    if not args.no_bake:
        # 焼くのは台座だけ（真鍮は金属で拡散がない。ガラスとインスタンスは焼かない）。ガラスは焼くあいだ描かない（光を遮らない）
        hide = objs['shell'] + objs['membrane'] + objs['template'] + objs['touch'] + objs['hidden']
        for o in hide:
            o.hide_render = True
        t0 = time.time()
        res = bake_lightmaps(objs['baked'], OUT_DIR, size=args.size, samples=args.samples, name=f'{ROOM}.lightmap')
        print(f'bake: {time.time() - t0:.1f}s', [(r['object'], r['scale'], round(r['max_over_scale'], 2), round(r['clipped_frac'] * 100, 3)) for r in res])
        for o in hide:
            o.hide_render = False
    elif not all(o.get('lightmap') for o in objs['baked']):
        # 焼かないときは前の結果を残す（名前と倍率は既に書き出した glb から写せないので、焼き直しが要る）
        for o in objs['baked']:
            o['lightmap'] = f'{ROOM}.lightmap.png'
            o['lightmap_scale'] = 1.0
        print('WARNING: --no-bake: lightmap_scale は 1.0 の仮です（焼き直してください）')

    size = export_glb(export, GLB, rooms=[ROOM])
    print(f'glb: {GLB} {size}B、物 {len(export)}')
    if all(os.path.exists(os.path.join(OUT_DIR, o['lightmap'])) for o in objs['baked']):
        room_load_report(objs['baked'], GLB, OUT_DIR)
    os.makedirs(os.path.dirname(BLEND), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND, compress=True)
    print(f'blend: {BLEND}、全体 {time.time() - t_start:.1f}s')


if __name__ == '__main__':
    main()
