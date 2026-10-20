"""見えない面の削除（BLD-4）。

レール上の多数の地点（と、VR で頭を動かせる半径 head_radius の範囲）から、進行方向を中心に
左右 ±yaw_deg・上下 ±pitch_deg の範囲へ光線を飛ばし、一度も最初に当たらなかった面を消す。

2段で調べる:
  1. 方向の格子（step_deg 刻み）で光線を飛ばし、当たった面に印をつける。大きな面はこれでほぼ見つかる。
  2. 印のない面ごとに、面の中心と頂点の近くを狙って光線を飛ばす（見回せる範囲にその点が入る地点だけ）。
     格子の隙間に落ちる小さな面・細い面を削りすぎないための追い込み。

渡す物の注意:
  - 世界座標の三角形で調べ、メッシュのデータ（obj.data）の面を消す。モディファイアは適用済みであること。
  - 同じメッシュを共有する物（リンク複製）は、どれかから見えれば残す。
  - 全部消えた物も物としては残し、report['emptied'] に名前を入れる（消すかどうかは呼ぶ側が決める）。
  - 光線を通す物（ガラス）は、その物の面は見えたとして残し、奥にある物も調べる。通さないと、ガラスの向こうに
    見える物を削ってしまう。通す物かは see_through の関数で決める。既定は default_see_through:
    カスタムプロパティ see_through があればその値、なければ glass（ガラスの種類）を持つ物。
"""
from __future__ import annotations

import math
import time
from typing import Callable, Iterable, Sequence

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .coords import UP, horizontal_frames

#: see_through の物を通り抜けて光線を続ける回数の上限
_MAX_PASS = 8
#: 印のない面 1つにつき狙う点の数の上限（中心 3 + 頂点の近く 3）
_MAX_TARGETS = 6


def resample_rail(points: Sequence[Sequence[float]], spacing: float) -> np.ndarray:
    """点列を spacing 以下の間隔になるよう折れ線の上で細かくする（元の点は残す）"""
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    if len(pts) < 2:
        return pts
    out = [pts[0]]
    for a, b in zip(pts[:-1], pts[1:]):
        n = max(1, int(math.ceil(np.linalg.norm(b - a) / spacing - 1e-9)))
        for k in range(1, n + 1):
            out.append(a + (b - a) * (k / n))
    return np.asarray(out)


def default_see_through(obj) -> bool:
    """光線を通す物か: カスタムプロパティ see_through があればその値（明示が優先）、なければ glass を持つ物"""
    explicit = obj.get('see_through')
    return bool(obj.get('glass')) if explicit is None else bool(explicit)


class _Scene:
    """対象の物の世界座標の三角形と、面（メッシュのデータ単位）への対応"""

    def __init__(self, objects: list, see_through: Callable = default_see_through):
        self.objects = objects
        self.mesh_ids: dict[int, int] = {}  # メッシュのデータのポインタ → 通し番号
        self.meshes: list = []
        self.poly_base: list[int] = []
        npoly = 0
        verts: list[np.ndarray] = []
        tris: list[np.ndarray] = []
        tri_poly: list[np.ndarray] = []
        tri_obj: list[np.ndarray] = []
        voff = 0
        for oi, obj in enumerate(objects):
            me = obj.data
            key = me.as_pointer()
            if key not in self.mesh_ids:
                self.mesh_ids[key] = len(self.meshes)
                self.meshes.append(me)
                self.poly_base.append(npoly)
                npoly += len(me.polygons)
            mi = self.mesh_ids[key]
            me.calc_loop_triangles()
            nv = len(me.vertices)
            nt = len(me.loop_triangles)
            if nv == 0 or nt == 0:
                continue
            co = np.empty(nv * 3, dtype=np.float32)
            me.vertices.foreach_get('co', co)
            m = np.array(obj.matrix_world, dtype=np.float64)
            world = co.reshape(-1, 3).astype(np.float64) @ m[:3, :3].T + m[:3, 3]
            tv = np.empty(nt * 3, dtype=np.int32)
            me.loop_triangles.foreach_get('vertices', tv)
            tp = np.empty(nt, dtype=np.int32)
            me.loop_triangles.foreach_get('polygon_index', tp)
            verts.append(world)
            tris.append(tv.reshape(-1, 3) + voff)
            tri_poly.append(tp + self.poly_base[mi])
            tri_obj.append(np.full(nt, oi, dtype=np.int32))
            voff += nv
        self.n_polys = npoly
        self.verts = np.concatenate(verts) if verts else np.zeros((0, 3))
        self.tris = np.concatenate(tris) if tris else np.zeros((0, 3), dtype=np.int32)
        self.tri_poly = np.concatenate(tri_poly) if tri_poly else np.zeros(0, dtype=np.int32)
        self.tri_obj = np.concatenate(tri_obj) if tri_obj else np.zeros(0, dtype=np.int32)
        self.see_through = [bool(see_through(o)) for o in objects]

    def bvh(self) -> BVHTree:
        return BVHTree.FromPolygons([tuple(v) for v in self.verts.tolist()], [tuple(t) for t in self.tris.tolist()], all_triangles=True)


def _directions(yaw_deg: float, pitch_deg: float, step_deg: float):
    """進行方向を基準にした (方位, 仰角)（ラジアン）の格子。端を必ず含む"""
    def axis(limit: float) -> list[float]:
        if limit <= 0:
            return [0.0]
        n = max(1, int(math.ceil(limit / step_deg)))
        return [math.radians(-limit + 2 * limit * i / (2 * n)) for i in range(2 * n + 1)]

    return [(a, e) for e in axis(pitch_deg) for a in axis(yaw_deg)]


def cull_hidden(
    objects: Iterable,
    rail_points: Sequence[Sequence[float]],
    yaw_deg: float = 120.0,
    pitch_deg: float = 60.0,
    head_radius: float = 0.5,
    *,
    spacing: float = 0.5,
    step_deg: float = 15.0,
    targeted_rays: int = 12,
    see_through: Callable = default_see_through,
) -> dict:
    """レールから一度も見えない面を objects から消し、前後の三角形の数などを返す。

    rail_points は Blender の座標（Z が上）。spacing より粗ければ細かくする（既定 0.5m ごと）。
    戻り値: before_tris, after_tris, removed_faces, kept_faces, rays, samples, seconds,
            emptied（全部消えた物の名前）, objects（物ごとの before_tris・after_tris）。
    """
    t0 = time.time()
    objs = [o for o in objects if o.type == 'MESH']
    scene = _Scene(objs, see_through)
    before = {o.name: _tri_count(o) for o in objs}
    before_total = sum(before.values())
    visible = np.zeros(scene.n_polys, dtype=bool)
    rays = 0

    samples = resample_rail(rail_points, spacing)
    if len(samples) == 0 or len(scene.tris) == 0:
        return _finish(scene, objs, before, before_total, visible, 0, len(samples), t0)
    fwd, right = horizontal_frames(samples)

    # 目の位置: 中心と、頭の動く範囲の上下前後左右（VR）
    heads = [samples]
    if head_radius > 0:
        for vec in (right, -right, fwd, -fwd, np.broadcast_to(UP, samples.shape), -np.broadcast_to(UP, samples.shape)):
            heads.append(samples + vec * head_radius)
    bvh = scene.bvh()
    tri_poly = scene.tri_poly.tolist()
    tri_obj = scene.tri_obj.tolist()
    see_through = scene.see_through
    any_through = any(see_through)

    def trace(origin: Vector, direction: Vector) -> None:
        """光線を飛ばして最初に当たった面に印をつける。ガラスなら通り抜けて続ける"""
        nonlocal rays
        for _ in range(_MAX_PASS if any_through else 1):
            rays += 1
            loc, _n, idx, _d = bvh.ray_cast(origin, direction)
            if loc is None:
                return
            visible[tri_poly[idx]] = True
            if not see_through[tri_obj[idx]]:
                return
            origin = loc + direction * 1e-4

    # 1. 方向の格子（方位 a・仰角 e を進行方向の枠に置き直す）
    grid = np.asarray(_directions(yaw_deg, pitch_deg, step_deg))
    ca, sa, ce, se = np.cos(grid[:, 0]), np.sin(grid[:, 0]), np.cos(grid[:, 1]), np.sin(grid[:, 1])
    for i in range(len(samples)):
        d_all = ((ce * ca)[:, None] * fwd[i] + (ce * sa)[:, None] * right[i] + se[:, None] * UP).tolist()
        for pos in heads:
            p = Vector(pos[i].tolist())
            for d in d_all:
                trace(p, Vector(d))

    # 2. 印のない面を、中心と頂点の近くを狙って調べる（狙う点の順に何巡かする）
    if targeted_rays > 0:
        yaw_lim = math.radians(yaw_deg) + 1e-9
        pitch_lim = math.radians(pitch_deg) + 1e-9
        pending = np.flatnonzero(~visible)
        targets = _target_points(scene, pending) if len(pending) else {}
        eyes = np.concatenate(heads)  # 頭の動く範囲の点も含める
        eye_fwd = np.tile(fwd, (len(heads), 1))
        eye_right = np.tile(right, (len(heads), 1))
        for rnd in range(_MAX_TARGETS):
            todo = [int(p) for p in pending if not visible[p] and len(targets.get(int(p), ())) > rnd]
            for c0 in range(0, len(todo), 64):
                chunk = todo[c0:c0 + 64]
                tp = np.asarray([targets[p][rnd][0] for p in chunk])  # (m, 3) 狙う点
                nm = np.asarray([targets[p][rnd][1] for p in chunk])  # (m, 3) 面の法線
                v = tp[:, None, :] - eyes[None, :, :]  # (m, 目の位置, 3)
                dist = np.linalg.norm(v, axis=2)
                safe = np.where(dist > 1e-6, dist, 1.0)
                az = np.arctan2(np.einsum('mij,ij->mi', v, eye_right), np.einsum('mij,ij->mi', v, eye_fwd))
                el = np.arcsin(np.clip(v[:, :, 2] / safe, -1.0, 1.0))
                inside = (dist > 1e-6) & (np.abs(az) <= yaw_lim) & (np.abs(el) <= pitch_lim)
                front = np.einsum('mij,mj->mi', -v, nm) > 0  # 目が面の表側にあるか
                for k, pid in enumerate(chunk):
                    if visible[pid]:
                        continue
                    cand = _pick(np.flatnonzero(inside[k] & front[k]), np.flatnonzero(inside[k] & ~front[k]), targeted_rays)
                    if len(cand) == 0:
                        continue
                    for i in cand:
                        trace(Vector(eyes[i].tolist()), Vector((v[k, i] / dist[k, i]).tolist()))
                        if visible[pid]:
                            break
    return _finish(scene, objs, before, before_total, visible, rays, len(samples), t0)


def _pick(front: np.ndarray, back: np.ndarray, budget: int) -> np.ndarray:
    """候補から budget 本まで、表側と裏側を半々に（片方が足りなければ他方で埋め）、並びの上で等間隔に選ぶ。

    一部の地点からしか見えない面（端の面など）を、数の多い見えない地点に埋もれさせないため。
    """
    half = budget // 2
    nf = min(len(front), max(half, budget - len(back)))
    nb = min(len(back), budget - nf)
    out = []
    for arr, n in ((front, nf), (back, nb)):
        if n >= len(arr):
            out.append(arr)
        elif n > 0:
            out.append(arr[np.linspace(0, len(arr) - 1, n).astype(int)])
    return np.concatenate(out) if out else np.zeros(0, dtype=int)


def _target_points(scene: _Scene, pending: np.ndarray) -> dict[int, list[tuple[np.ndarray, np.ndarray]]]:
    """印のない面ごとに狙う（点, 法線）（最大 _MAX_TARGETS 個）: 三角形の中心を先に、次に頂点の近く（中心へ1割寄せた点）。

    メッシュのデータを共有する物は、どの物の三角形からも狙う（どれかから見えれば残す）。
    """
    sel = np.flatnonzero(np.isin(scene.tri_poly, pending))
    tri_v = scene.verts[scene.tris[sel]]  # (n, 3, 3)
    cen = tri_v.mean(axis=1)
    nrm = np.cross(tri_v[:, 1] - tri_v[:, 0], tri_v[:, 2] - tri_v[:, 0])
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = nrm / np.where(ln > 1e-12, ln, 1.0)
    near = tri_v + (cen[:, None, :] - tri_v) * 0.1
    centers: dict[int, list] = {}
    nears: dict[int, list] = {}
    for j, ti in enumerate(sel):
        pid = int(scene.tri_poly[ti])
        centers.setdefault(pid, []).append((cen[j], nrm[j]))
        nears.setdefault(pid, []).extend((p, nrm[j]) for p in near[j])
    return {pid: (centers[pid][:3] + nears[pid][:3])[:_MAX_TARGETS] for pid in centers}


def _tri_count(obj) -> int:
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def _finish(scene: _Scene, objs: list, before: dict, before_total: int, visible: np.ndarray, rays: int, n_samples: int, t0: float) -> dict:
    removed = 0
    for mi, me in enumerate(scene.meshes):
        base = scene.poly_base[mi]
        n = len(me.polygons)
        if n == 0:
            continue
        keep = visible[base:base + n]
        if keep.all():
            continue
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        dead = [bm.faces[i] for i in range(n) if not keep[i]]
        removed += len(dead)
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        bm.to_mesh(me)
        bm.free()
        me.update()
    after = {o.name: _tri_count(o) for o in objs}
    return {
        'before_tris': before_total,
        'after_tris': sum(after.values()),
        'removed_faces': removed,
        'kept_faces': int(visible.sum()),
        'rays': rays,
        'samples': n_samples,
        'seconds': round(time.time() - t0, 2),
        'emptied': [o.name for o in objs if len(o.data.polygons) == 0],
        'objects': {o.name: {'before_tris': before[o.name], 'after_tris': after[o.name]} for o in objs},
    }
