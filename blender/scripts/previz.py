"""プレビズ（動く下書き）を組む（BLD-1）。

    blender -b --factory-startup -P previz.py -- --rail rail.json --cues cues.json --out previz.blend [--audio bgm.wav]
    pnpm previz:build

rail.json（RideData）・cues.json（Cue[]）から、13 分の動く下書き previz.blend を作る:

  - 30fps、frame 0〜duration*30（13 分 = 23400）。
  - 'Rail': レールのカーブ（rail.json の点列をそのまま POLY の 1 本のスプラインに）。
  - 'Gondola': 空の物体。Follow Path（位置は時刻表どおり offset_factor のキー、補間は LINEAR）で
    カーブに沿い、Limit Rotation で向きは進行方向の左右（yaw）だけ（常に水平）。
  - 'SeatCamera': Gondola の子。座席の目の高さ、縦の視野角 75°、進行方向を向く。
  - 部屋ごとのコレクション（platform・greenhouse・rain・kaleidoscope・celestial・dawn）に、
    区間の範囲のレールの周りの仮の形と色（設計書「アートディレクション」の広さ）。降車の区間は platform。
  - キューシートのタイムラインマーカー（名前の決まりは encode_marker）。
  - --audio があればサウンドのストリップ。

座標: rail.json は three.js（Y が上、-Z が前）、Blender は Z が上。three (x, y, z) -> Blender (x, -z, y)
（common/coords.py）。export_ride.py が逆に変換して書き出す。

人が Blender で 'Rail' のカーブや 'Gondola' のアニメーションを直したら、export_ride.py が
カーブとアニメーションから rail.json を作り直す。元の rail.json の情報（gentleY・区間・時刻表の細かさ）は
Rail と Sections のカスタムプロパティに持つ（README を参照）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sys
import warnings

import bmesh
import bpy
import numpy as np

sys.dont_write_bytecode = True  # __pycache__ を作らない（リポジトリを汚さない）
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from common.cli import script_args  # noqa: E402
from common.coords import UP, horizontal_frames, three_to_blender  # noqa: E402

# ── 設計書の数値（src/config.ts と揃える。Python からは読めないので写している） ──
FPS = 30
#: 72BPM・4/4 の 1 小節（config.ts の SEC_PER_BAR）
SEC_PER_BAR = 10.0 / 3.0
#: 座席の目の高さ（CAMERA.seatEyeHeight）と縦の視野角（CAMERA.fovDeg）
SEAT_EYE_HEIGHT = 0.15
FOV_DEG = 75.0
GONDOLA_DIAMETER = 2.4

#: 区間ごとの空の色（下書き。一日が過ぎるように: 夜明け前、朝、雨の昼、金の万華鏡、夜の藍、金と桃色の夜明け、朝）
WORLD_COLOR = {
    'platform': (0.36, 0.42, 0.52),
    'greenhouse': (0.62, 0.78, 0.58),
    'rain': (0.45, 0.50, 0.58),
    'kaleidoscope': (0.80, 0.60, 0.30),
    'celestial': (0.02, 0.03, 0.12),
    'dawn': (0.95, 0.66, 0.50),
    'departure': (0.70, 0.74, 0.80),
}

ROOMS = ('platform', 'greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn')
#: 区間 → 部屋（contracts/ids.ts の ROOM_OF_SECTION。降車は乗り場と同じホール）
ROOM_OF_SECTION = {
    'platform': 'platform',
    'greenhouse': 'greenhouse',
    'rain': 'rain',
    'kaleidoscope': 'kaleidoscope',
    'celestial': 'celestial',
    'dawn': 'dawn',
    'departure': 'platform',
}

# ── 名前と、往復のためのカスタムプロパティ ─────────────────────────────
RAIL = 'Rail'
GONDOLA = 'Gondola'
CAMERA = 'SeatCamera'
SECTIONS = 'Sections'
FOLLOW = 'Follow Path'
#: Rail のカスタムプロパティ: 点の間隔、元の gentleY、元の点列の署名、時刻表の細かさ（秒）
P_SPACING = 'spacing'
P_GENTLE_Y = 'gentle_y'
P_SIGNATURE = 'rail_signature'
P_TIMELINE_DT = 'timeline_dt'
#: 乗車時間（秒）。書き出しの duration の基準（シーンの frame 範囲ではなくこれ）
P_DURATION = 'duration'
#: Sections（空の物体）のカスタムプロパティ: 区間の id → [開始の秒, 終わりの秒]

#: TimelineMarker.name は 64 バイト（終端を含む）
MARKER_MAX_BYTES = 63
DATA_KEYS = ('to', 'target', 'shot')


# ── マーカーの名前 ─────────────────────────────────────────────────────
def encode_marker(cue: dict) -> str:
    """キューをマーカーの名前にする: `<id> in=<区間> [<キー>=<値> ...]`

    例: `greenhouse.bloom@48 in=greenhouse`、`lure@47.1 in=greenhouse target=greenhouse.bloom`。
    id は `<出来事の名前>@<通しの小節>`。人が Blender で足すときは出来事の名前だけ（`greenhouse.bloom`）でもよい
    （id・区間・小節は書き出しが時刻から決める）。
    """
    parts = [cue['id'], f"in={cue['section']}"]
    for k, v in (cue.get('data') or {}).items():
        parts.append(f'{k}={v}')
    for p in parts:
        if any(ch.isspace() for ch in p.split('=', 1)[-1]):
            raise ValueError(f'マーカーの名前に空白は使えません: {p!r}')
    name = ' '.join(parts)
    if len(name.encode('utf-8')) > MARKER_MAX_BYTES:
        raise ValueError(f'マーカーの名前が長すぎます（{len(name.encode("utf-8"))} > {MARKER_MAX_BYTES} バイト）: {name}')
    return name


def decode_marker(name: str) -> dict:
    """マーカーの名前 → {'id': str|None, 'name': 出来事の名前, 'section': str|None, 'data': {...}}"""
    tokens = name.split()
    if not tokens:
        raise ValueError('空のマーカーの名前')
    head = tokens[0]
    cue_name = head.split('@', 1)[0]
    section = None
    data: dict[str, str] = {}
    for tok in tokens[1:]:
        if '=' not in tok:
            raise ValueError(f'マーカーの名前を読めません: {name!r}（`キー=値` の形）')
        k, v = tok.split('=', 1)
        if k == 'in':
            section = v
        else:
            data[k] = v
    return {'id': head if '@' in head else None, 'name': cue_name, 'section': section, 'data': data}


# ── レールの読み書き（export_ride.py と共有） ───────────────────────────
def evaluated_polyline(obj) -> np.ndarray:
    """カーブの物を評価して、世界座標（Blender）の折れ線にする（POLY なら制御点そのまま、ベジェ・NURBS は細かく刻んだ点）。

    スプラインは 1 本だけ（レールは 1 本の道）。
    """
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        n = len(me.vertices)
        co = np.empty(n * 3, dtype=np.float64)
        me.vertices.foreach_get('co', co)
        ed = np.empty(len(me.edges) * 2, dtype=np.int32)
        me.edges.foreach_get('vertices', ed)
    finally:
        ev.to_mesh_clear()
    verts = co.reshape(-1, 3)
    edges = ed.reshape(-1, 2)
    if n == 0:
        raise ValueError(f'{obj.name} に点がありません')
    if len(edges) == n - 1 and np.array_equal(edges[:, 0], np.arange(n - 1)) and np.array_equal(edges[:, 1], np.arange(1, n)):
        order = np.arange(n)
    else:
        order = _chain(n, edges, obj.name)
    m = np.array(obj.matrix_world, dtype=np.float64)
    return verts[order] @ m[:3, :3].T + m[:3, 3]


def _chain(n: int, edges: np.ndarray, name: str) -> np.ndarray:
    adj: dict[int, list[int]] = {i: [] for i in range(n)}
    for a, b in edges.tolist():
        adj[a].append(b)
        adj[b].append(a)
    ends = [i for i in range(n) if len(adj[i]) == 1]
    start = min(ends) if ends else 0
    order = [start]
    seen = {start}
    cur = start
    while True:
        nxt = [j for j in adj[cur] if j not in seen]
        if not nxt:
            break
        cur = nxt[0]
        seen.add(cur)
        order.append(cur)
    if len(order) != n:
        raise ValueError(f'{name} は 1 本につながった道ではありません（スプラインは 1 本にしてください）')
    return np.asarray(order)


def polyline_signature(points: np.ndarray) -> str:
    """点列の署名（0.1mm に丸めて SHA-1）。レールが元のままかを調べるのに使う"""
    q = np.round(np.asarray(points, dtype=np.float64) * 1e4).astype(np.int64)
    return hashlib.sha1(q.tobytes()).hexdigest()[:16]


def action_fcurves(action):
    """アクションの F カーブ（Blender 5 の層つきアクションも、従来のアクションも）"""
    if hasattr(action, 'fcurves'):
        yield from action.fcurves
        return
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield from bag.fcurves


# ── 部屋の仮の形 ───────────────────────────────────────────────────────
_MATS: dict[str, bpy.types.Material] = {}


def material(name: str, color, emission: float = 0.3, alpha: float = 1.0, shade: bool = False, cull: bool = False):
    """単色の仮の材質（光の焼き込み前の下書きなので、自分で光って見える）。

    shade=True は法線の上下で明るさを変える（床・天井は明るく、壁は暗く）。形が読みやすくなる。
    cull=True は裏面を描かない（下から見たときに地面を透かす）。
    """
    if name in _MATS:
        return _MATS[name]
    m = bpy.data.materials.new(name)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        if m.node_tree is None:
            m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')

    def put(label: str, value) -> None:
        if label in bsdf.inputs:
            bsdf.inputs[label].default_value = value

    put('Roughness', 0.9)
    put('Emission Strength', emission)
    put('Alpha', alpha)
    if shade:
        nt = m.node_tree
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        ab = nt.nodes.new('ShaderNodeMath')
        ab.operation = 'ABSOLUTE'
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        colors = [s for s in mix.inputs if s.type == 'RGBA']  # A, B
        colors[0].default_value = (*(c * 0.62 for c in color), 1.0)
        colors[1].default_value = (*(min(1.0, c * 1.12) for c in color), 1.0)
        nt.links.new(geo.outputs['Normal'], sep.inputs[0])
        nt.links.new(sep.outputs['Z'], ab.inputs[0])
        nt.links.new(ab.outputs[0], mix.inputs['Factor'])
        out = next(s for s in mix.outputs if s.type == 'RGBA')
        nt.links.new(out, bsdf.inputs['Base Color'])
        nt.links.new(out, bsdf.inputs['Emission Color'])
    else:
        put('Base Color', (*color, 1.0))
        put('Emission Color', (*color, 1.0))
    m.diffuse_color = (*color, alpha)
    m.use_backface_culling = cull
    if alpha < 1.0:
        if hasattr(m, 'surface_render_method'):
            m.surface_render_method = 'BLENDED'
        else:
            m.blend_method = 'BLEND'
    _MATS[name] = m
    return m


def _mesh_object(name: str, verts, faces, mat, coll):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    return ob


def _rings(centers: np.ndarray, fwd: np.ndarray, right: np.ndarray, rx: float, rz: float, dz: float, nseg: int, phase: float = 0.0, shift: float = 0.0) -> np.ndarray:
    """各地点で進行方向に垂直な楕円（横 rx・縦 rz、中心を dz 上げる）の輪。(n, nseg, 3)"""
    a = 2.0 * math.pi * (np.arange(nseg) + phase) / nseg
    ring = (
        centers[:, None, :]
        + fwd[:, None, :] * shift
        + (rx * np.cos(a))[None, :, None] * right[:, None, :]
        + (dz + rz * np.sin(a))[None, :, None] * UP[None, None, :]
    )
    return ring


def _tube(name: str, centers, fwd, right, style, mat, coll):
    n = len(centers)
    nseg = style['n']
    ring = _rings(centers, fwd, right, style['rx'], style['rz'], style['dz'], nseg, style.get('phase', 0.0))
    faces = [(i * nseg + k, i * nseg + (k + 1) % nseg, (i + 1) * nseg + (k + 1) % nseg, (i + 1) * nseg + k) for i in range(n - 1) for k in range(nseg)]
    return _mesh_object(name, ring.reshape(-1, 3).tolist(), faces, mat, coll)


def _ribs(name: str, centers, fwd, right, style, mat, coll, every: float, step: float):
    """間隔 every(m) ごとの細い輪。進む速さが見て分かる目印になる（部屋の中が何もないと動きが見えない）"""
    k = max(1, int(round(every / step)))
    idx = np.arange(0, len(centers), k)
    nseg = style['n']
    verts, faces = [], []
    for i in idx:
        r0 = _rings(centers[i:i + 1], fwd[i:i + 1], right[i:i + 1], style['rx'] * 0.985, style['rz'] * 0.985, style['dz'], nseg, style.get('phase', 0.0), shift=-0.3)[0]
        r1 = _rings(centers[i:i + 1], fwd[i:i + 1], right[i:i + 1], style['rx'] * 0.985, style['rz'] * 0.985, style['dz'], nseg, style.get('phase', 0.0), shift=0.3)[0]
        base = len(verts)
        verts.extend(r0.tolist())
        verts.extend(r1.tolist())
        faces.extend((base + j, base + (j + 1) % nseg, base + nseg + (j + 1) % nseg, base + nseg + j) for j in range(nseg))
    return _mesh_object(name, verts, faces, mat, coll)


def _shared_mesh(name: str, kind: str):
    """小物の元の形（リンク複製で使い回す）"""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    if kind == 'ico':
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
    elif kind == 'uv':
        bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=1.0)
    else:  # cylinder
        bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=1.0, radius2=1.0, depth=1.0)
    bm.to_mesh(me)
    bm.free()
    return me


def _prop(name: str, me, mat, loc, scale, coll):
    if not me.materials:
        me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    ob.scale = scale
    coll.objects.link(ob)
    return ob


#: 部屋ごとの仮の形（設計書「アートディレクション」の広さ: 温室=大、回廊=小、万華鏡=中、天球=最大、岸=開放、乗り場=中）
STYLE = {
    'platform': dict(n=24, rx=7.0, rz=4.5, dz=2.0, step=2.0, color=(0.30, 0.38, 0.50), rib=(0.85, 0.70, 0.35), rib_every=6.0),
    'greenhouse': dict(n=32, rx=16.0, rz=10.0, dz=6.5, step=3.0, color=(0.42, 0.70, 0.36), rib=(0.96, 0.98, 0.92), rib_every=9.0),
    'rain': dict(n=16, rx=3.4, rz=3.0, dz=0.4, step=1.5, color=(0.38, 0.46, 0.55), rib=(0.90, 0.60, 0.20), rib_every=4.0),
    'kaleidoscope': dict(n=6, rx=7.5, rz=7.5, dz=0.0, step=2.0, color=(0.95, 0.68, 0.22), rib=(1.0, 0.92, 0.55), rib_every=5.0),
}


def _span_points(rail_b: np.ndarray, spacing: float, s0: float, s1: float, stride_m: float):
    """区間 [s0, s1] の範囲のレールの点を stride_m 刻みで取る（Blender の座標）"""
    i0 = max(0, int(math.floor(s0 / spacing)))
    i1 = min(len(rail_b) - 1, int(math.ceil(s1 / spacing)))
    k = max(1, int(round(stride_m / spacing)))
    idx = list(range(i0, i1 + 1, k))
    if idx[-1] != i1:
        idx.append(i1)
    return rail_b[idx]


def build_room_span(room: str, num: int, pts: np.ndarray, coll, rng: random.Random) -> None:
    """1 つの区間の範囲のレール pts の周りに、部屋の仮の形を作る"""
    fwd, right = horizontal_frames(pts)
    tag = f'{num:03d}'
    if room in STYLE:
        st = STYLE[room]
        _tube(f'{room}.shell.{tag}', pts, fwd, right, st, material(f'{room}.shell', st['color'], shade=True), coll)
        _ribs(f'{room}.rib.{tag}', pts, fwd, right, st, material(f'{room}.rib', st['rib'], emission=1.0), coll, st['rib_every'], st['step'])
    length = float(np.sum(np.linalg.norm(np.diff(pts, axis=0), axis=1))) if len(pts) > 1 else 0.0

    if room == 'platform':
        me = _shared_mesh('platform.bubble', 'uv')
        mat = material('platform.bubble', (0.92, 0.95, 1.0), emission=1.2)
        for j, i in enumerate(range(0, len(pts), max(1, int(round(12.0 / STYLE['platform']['step']))))):
            side = 1.0 if j % 2 == 0 else -1.0
            loc = pts[i] + right[i] * 2.6 * side + UP * 2.8
            _prop(f'platform.bubble.{num * 100 + j + 1:03d}', me, mat, loc, (0.45, 0.45, 0.45), coll)
    elif room == 'greenhouse':
        me = _shared_mesh('greenhouse.leaf', 'ico')
        mat = material('greenhouse.leaf', (0.30, 0.62, 0.28), emission=0.8)
        for j in range(int(length / 2.0)):
            i = rng.randrange(len(pts))
            lateral = rng.choice((-1, 1)) * rng.uniform(4.0, 13.0)
            loc = pts[i] + right[i] * lateral + UP * (STYLE['greenhouse']['dz'] - STYLE['greenhouse']['rz'] + rng.uniform(0.3, 3.0))
            s = rng.uniform(0.6, 1.6)
            ob = _prop(f'greenhouse.leaf.{num * 1000 + j + 1:03d}', me, mat, loc, (s * 1.3, s * 0.6, s * 0.2), coll)
            ob.rotation_euler = (0.0, rng.uniform(-0.5, 0.5), rng.uniform(0, math.tau))
    elif room == 'rain':
        lamp = _shared_mesh('rain.lamp', 'uv')
        lmat = material('rain.lamp', (1.0, 0.62, 0.18), emission=4.0)
        pillar = _shared_mesh('rain.pillar', 'cyl')
        pmat = material('rain.pillar', (0.55, 0.62, 0.70), emission=0.6)
        for j, i in enumerate(range(0, len(pts), max(1, int(round(6.0 / STYLE['rain']['step']))))):
            for side in (-1.0, 1.0):
                _prop(f'rain.lamp.{num * 1000 + j * 2 + (side > 0) + 1:03d}', lamp, lmat, pts[i] + right[i] * 2.9 * side + UP * 1.6, (0.25, 0.25, 0.25), coll)
        for j, i in enumerate(range(0, len(pts), max(1, int(round(9.0 / STYLE['rain']['step']))))):
            side = 1.0 if j % 2 == 0 else -1.0
            _prop(f'rain.pillar.{num * 100 + j + 1:03d}', pillar, pmat, pts[i] + right[i] * 2.7 * side + UP * 0.4, (0.18, 0.18, 2.6), coll)
    elif room == 'kaleidoscope':
        me = _shared_mesh('kaleidoscope.shard', 'ico')
        mats = [material(f'kaleidoscope.shard{k}', c, emission=2.0) for k, c in enumerate(((1.0, 0.75, 0.25), (1.0, 0.55, 0.15), (1.0, 0.95, 0.80)))]
        for j in range(int(length / 3.0)):
            i = rng.randrange(len(pts))
            ang = rng.uniform(0, math.tau)
            rad = rng.uniform(2.6, 6.0)
            loc = pts[i] + right[i] * math.cos(ang) * rad + UP * math.sin(ang) * rad
            s = rng.uniform(0.4, 1.4)
            ob = _prop(f'kaleidoscope.shard.{num * 1000 + j + 1:03d}', me, mats[j % 3], loc, (s, s * 0.6, s * 1.4), coll)
            ob.rotation_euler = (rng.uniform(0, 3), rng.uniform(0, 3), rng.uniform(0, 3))
    elif room == 'celestial':
        mid = pts[len(pts) // 2]
        radius = max(110.0, length / 2.0 + 40.0)
        for j, f in enumerate((0.45, 0.7, 1.0)):
            bm = bmesh.new()
            bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=radius * f)
            me = bpy.data.meshes.new(f'celestial.shell.{num * 10 + j + 1:03d}')
            bm.to_mesh(me)
            bm.free()
            me.materials.append(material(f'celestial.shell{j}', (0.10 + 0.04 * j, 0.12 + 0.03 * j, 0.40 + 0.08 * j), emission=0.5, alpha=0.22))
            ob = bpy.data.objects.new(me.name, me)
            ob.location = mid
            coll.objects.link(ob)
        me = _shared_mesh('celestial.star', 'ico')
        smat = material('celestial.star', (1.0, 0.96, 0.85), emission=6.0)
        for j in range(90):
            v = np.array([rng.gauss(0, 1) for _ in range(3)])
            v /= max(1e-9, np.linalg.norm(v))
            r = radius * rng.uniform(0.3, 0.95)
            s = rng.uniform(0.5, 1.4)
            _prop(f'celestial.star.{num * 1000 + j + 1:03d}', me, smat, mid + v * r, (s, s, s), coll)
    elif room == 'dawn':
        lo = pts.min(axis=0) - 45.0
        hi = pts.max(axis=0) + 45.0
        z0 = float(pts[:, 2].min()) - 2.2
        sand = [(lo[0], lo[1], z0), (hi[0], lo[1], z0), (hi[0], hi[1], z0), (lo[0], hi[1], z0)]
        _mesh_object(f'dawn.ground.{tag}', sand, [(0, 1, 2, 3)], material('dawn.ground', (0.92, 0.80, 0.58), emission=0.3, cull=True), coll)
        # 水面は進行方向の左側へ広がる
        mid = len(pts) // 2
        left = -right[mid]
        a = pts[0] - fwd[mid] * 45.0 + left * 22.0
        b = pts[-1] + fwd[mid] * 45.0 + left * 22.0
        c = b + left * 200.0
        d = a + left * 200.0
        water = [(p[0], p[1], z0 - 0.4) for p in (a, b, c, d)]
        face = (0, 1, 2, 3)
        n = np.cross(np.subtract(water[1], water[0]), np.subtract(water[2], water[1]))
        if n[2] < 0:  # 上から見て反時計回りにそろえる（裏面を描かないので向きが大事）
            face = (3, 2, 1, 0)
        _mesh_object(f'dawn.water.{tag}', water, [face], material('dawn.water', (0.45, 0.72, 0.88), emission=0.4, cull=True), coll)
        sun = _shared_mesh('dawn.sun', 'uv')
        _prop(f'dawn.sun.{tag}', sun, material('dawn.sun', (1.0, 0.78, 0.50), emission=10.0), pts[-1] + fwd[-1] * 320.0 + UP * 12.0, (22.0, 22.0, 22.0), coll)


# ── 組み立て ───────────────────────────────────────────────────────────
def _link_collection(name: str, parent=None):
    c = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(c)
    return c


def build(rail_path: str, cues_path: str, out_path: str, audio: str | None = None) -> dict:
    with open(rail_path, encoding='utf-8') as f:
        ride = json.load(f)
    with open(cues_path, encoding='utf-8') as f:
        cues = json.load(f)
    if ride.get('version') != 1:
        raise ValueError(f'rail.json の version が 1 ではありません: {ride.get("version")}')

    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.name = 'previz'
    sc.render.fps = FPS
    sc.render.fps_base = 1.0
    duration = float(ride['duration'])
    sc.frame_start = 0
    sc.frame_end = int(round(duration * FPS))
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1920, 1080, 100
    sc.view_settings.view_transform = 'Standard'
    if sc.world is None:
        sc.world = bpy.data.worlds.new('World')
    sc.world.color = (0.50, 0.56, 0.66)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        sc.world.use_nodes = True
    bg = sc.world.node_tree.nodes.get('Background')
    if bg is not None:
        bg.inputs['Color'].default_value = (0.50, 0.56, 0.66, 1.0)
        bg.inputs['Strength'].default_value = 0.7
    sc.eevee.taa_render_samples = 16

    spacing = float(ride['rail'].get('spacing', 1.0))
    rail_b = np.array([three_to_blender(p) for p in ride['rail']['points']], dtype=np.float64)
    if len(rail_b) < 2:
        raise ValueError('レールの点が 2 つ未満です')
    cum = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(rail_b, axis=0), axis=1))])
    total_len = float(cum[-1])
    timeline = [(float(e['t']), float(e['s'])) for e in ride['timeline']]
    for a, b in zip(timeline[:-1], timeline[1:]):
        if not b[0] > a[0] or b[1] < a[1] - 1e-9:
            raise ValueError(f'時刻表が単調ではありません: {a} -> {b}')

    previz = _link_collection('previz')
    room_colls = {r: _link_collection(r) for r in ROOMS}

    # レール: 点列をそのまま 1 本の POLY スプラインに
    cu = bpy.data.curves.new(RAIL, 'CURVE')
    cu.dimensions = '3D'
    sp = cu.splines.new('POLY')
    sp.points.add(len(rail_b) - 1)
    co4 = np.concatenate([rail_b, np.ones((len(rail_b), 1))], axis=1).astype(np.float32).ravel()
    sp.points.foreach_set('co', co4)
    rail = bpy.data.objects.new(RAIL, cu)
    previz.objects.link(rail)
    bpy.context.view_layer.update()
    rail[P_SPACING] = spacing
    rail[P_DURATION] = duration
    rail[P_SIGNATURE] = polyline_signature(evaluated_polyline(rail))
    if ride.get('gentleY') is not None:
        rail[P_GENTLE_Y] = [float(y) for y in ride['gentleY']]
    gaps = [b[0] - a[0] for a, b in zip(timeline[:-1], timeline[1:]) if b[0] - a[0] > 1e-9]
    rail[P_TIMELINE_DT] = float(min(0.5, max(0.25, min(gaps)))) if gaps else 0.5

    # ゴンドラ: カーブに沿い（位置）、向きは yaw だけ（水平）
    g = bpy.data.objects.new(GONDOLA, None)
    g.empty_display_type = 'ARROWS'
    g.empty_display_size = 1.5
    previz.objects.link(g)
    follow = g.constraints.new('FOLLOW_PATH')
    follow.name = FOLLOW
    follow.target = rail
    follow.use_fixed_location = True
    follow.use_curve_follow = True
    follow.forward_axis = 'FORWARD_Y'
    follow.up_axis = 'UP_Z'
    lim = g.constraints.new('LIMIT_ROTATION')
    lim.name = 'Level'
    lim.use_limit_x = lim.use_limit_y = True
    lim.min_x = lim.max_x = lim.min_y = lim.max_y = 0.0
    lim.owner_space = 'WORLD'

    def arc_factor(s: float) -> float:
        """rail.json の距離 s（点の番号 × 間隔）→ Follow Path の位置（0〜1、折れ線の長さに対する割合）"""
        x = min(max(s / spacing, 0.0), len(rail_b) - 1.0)
        j = min(int(math.floor(x)), len(rail_b) - 2)
        return float((cum[j] + (x - j) * (cum[j + 1] - cum[j])) / total_len)

    for t, s in timeline:
        follow.offset_factor = arc_factor(s)
        follow.keyframe_insert('offset_factor', frame=t * FPS)
    follow.offset_factor = arc_factor(timeline[0][1])
    for fc in action_fcurves(g.animation_data.action):
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'  # 時刻表は折れ線（間は線形に補う。RideData の決まり）

    # 座席のカメラ（視野角は縦で 75°）
    cd = bpy.data.cameras.new(CAMERA)
    cd.sensor_fit = 'VERTICAL'
    cd.lens_unit = 'FOV'
    cd.angle_y = math.radians(FOV_DEG)
    cd.clip_start = 0.05
    cd.clip_end = 3000.0
    cam = bpy.data.objects.new(CAMERA, cd)
    previz.objects.link(cam)
    cam.parent = g
    cam.location = (0.0, 0.0, SEAT_EYE_HEIGHT)
    cam.rotation_euler = (math.pi / 2, 0.0, 0.0)  # Blender のカメラは -Z を向く。ゴンドラの前（+Y）へ
    sc.camera = cam

    # ゴンドラの泡（画面には出さない目印。直径 2.4m）
    bubble = bpy.data.objects.new('previz.gondola', _shared_mesh('previz.gondola', 'uv'))
    bubble.scale = (GONDOLA_DIAMETER / 2,) * 3
    bubble.parent = g
    bubble.display_type = 'WIRE'
    bubble.hide_render = True
    previz.objects.link(bubble)

    # 区間: 時刻で持つ（時刻表やレールを直しても、楽曲の構成に区間がついてくる）
    sec_empty = bpy.data.objects.new(SECTIONS, None)
    sec_empty.empty_display_type = 'PLAIN_AXES'
    sec_empty.hide_render = True
    previz.objects.link(sec_empty)

    def t_at_s(sb: float) -> float:
        if sb <= timeline[0][1] + 1e-9:
            return timeline[0][0]
        for (t0, s0), (t1, s1) in zip(timeline[:-1], timeline[1:]):
            if s1 >= sb - 1e-9:
                return t0 if s1 == s0 else t0 + (t1 - t0) * min(1.0, max(0.0, (sb - s0) / (s1 - s0)))
        return timeline[-1][0]

    span_count = {r: 0 for r in ROOMS}
    for sec in ride['sections']:
        sec_empty[sec['id']] = [round(t_at_s(float(sec['s0'])), 6), round(t_at_s(float(sec['s1'])), 6)]
        room = ROOM_OF_SECTION[sec['id']]
        span_count[room] += 1
        step = STYLE[room]['step'] if room in STYLE else 4.0
        pts = _span_points(rail_b, spacing, float(sec['s0']), float(sec['s1']), step)
        rng = random.Random(f'{room}-{span_count[room]}')
        build_room_span(room, span_count[room], pts, room_colls[room], rng)

    key_world_color(sc, {sid: tuple(sec_empty[sid]) for sid in WORLD_COLOR if sid in sec_empty})

    # キューシート → タイムラインマーカー（時刻は 1/30 秒の整数倍）
    for cue in cues:
        frame = round(float(cue['t']) * FPS)
        if abs(frame / FPS - float(cue['t'])) > 1e-6:
            raise ValueError(f'キューの時刻が 1/30 秒の整数倍ではありません: {cue["id"]} t={cue["t"]}')
        sc.timeline_markers.new(encode_marker(cue), frame=frame)

    if audio:
        add_audio(sc, audio)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(out_path), compress=True)
    return {'points': len(rail_b), 'length': total_len, 'keys': len(timeline), 'markers': len(cues), 'frames': sc.frame_end}


def key_world_color(sc, spans: dict) -> None:
    """空の色を区間ごとに変える（各区間の中は一定、区間の境目をまたいで線形に混ざる）"""
    bg = sc.world.node_tree.nodes.get('Background') if sc.world and sc.world.node_tree else None
    if bg is None or not spans:
        return
    for sid, (t0, t1) in spans.items():
        hold = min(2.0, (t1 - t0) / 4.0)
        for t in (t0 + hold, t1 - hold):
            bg.inputs['Color'].default_value = (*WORLD_COLOR[sid], 1.0)
            bg.inputs['Color'].keyframe_insert('default_value', frame=t * FPS)
    for fc in action_fcurves(sc.world.node_tree.animation_data.action):
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'


def add_audio(sc, path: str) -> None:
    """仮の楽曲をサウンドのストリップとして frame 0 に置く"""
    seq = sc.sequence_editor_create()
    strips = seq.strips if hasattr(seq, 'strips') else seq.sequences
    strips.new_sound('bgm', os.path.abspath(path), channel=1, frame_start=0)
    sc.sync_mode = 'AUDIO_SYNC'  # 再生が遅れたらコマを飛ばして音に合わせる（映像と音を見ながら時刻を決める）


def main() -> None:
    ap = argparse.ArgumentParser(prog='previz.py')
    ap.add_argument('--rail', required=True, help='rail.json（RideData）')
    ap.add_argument('--cues', required=True, help='cues.json（Cue[]）')
    ap.add_argument('--out', required=True, help='書き出す previz.blend')
    ap.add_argument('--audio', help='仮の楽曲（wav など）。あればサウンドのストリップに置く')
    ap.add_argument('--force', action='store_true', help='既にある --out（人が直した previz.blend）を上書きする')
    args = ap.parse_args(script_args())
    if os.path.exists(args.out) and not args.force:
        print(f'ERROR: {args.out} が既にあります（人が直した previz.blend を消さないよう上書きしません）。上書きするなら --force、別の場所なら --out を変えてください')
        sys.exit(1)
    info = build(args.rail, args.cues, args.out, args.audio)
    print(f'previz: {args.out} 点 {info["points"]}（{info["length"]:.1f}m）、キー {info["keys"]}、マーカー {info["markers"]}、frame 0〜{info["frames"]}')


if __name__ == '__main__':
    main()
