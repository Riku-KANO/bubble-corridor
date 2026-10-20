"""three.js（Y が上、-Z が前）と Blender（Z が上、+Y が前）の座標の変換。

rail.json と glb は three.js の向き、Blender の中は Blender の向き。
取り込む側は `three_to_blender`、書き出す側は `blender_to_three` を必ず対にして使う。

    three (x, y, z)  ->  Blender (x, -z, y)
    Blender (X, Y, Z) -> three  (X, Z, -Y)
"""
from __future__ import annotations

from typing import Sequence

import numpy as np


def three_to_blender(p: Sequence[float]) -> tuple[float, float, float]:
    return (float(p[0]), -float(p[2]), float(p[1]))


def blender_to_three(p: Sequence[float]) -> tuple[float, float, float]:
    return (float(p[0]), float(p[2]), -float(p[1]))


#: Blender の上（Z）
UP = np.array([0.0, 0.0, 1.0])


def horizontal_frames(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """レールの各地点での、進行方向（水平に直した単位ベクトル）fwd と、その右 right。

    ゴンドラは常に水平で、向きは左右（yaw）だけ持つので、上下の傾きは捨てる。
    止まっている地点・真上や真下へ進む地点は直前の向きを引き継ぐ。points は Blender の座標（n, 3）。
    """
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    n = len(pts)
    tan = np.zeros_like(pts)
    if n >= 2:
        tan[1:-1] = pts[2:] - pts[:-2]
        tan[0] = pts[1] - pts[0]
        tan[-1] = pts[-1] - pts[-2]
    tan[:, 2] = 0.0
    norm = np.linalg.norm(tan, axis=1)
    last = np.array([0.0, 1.0, 0.0])
    for i in range(n):
        if norm[i] < 1e-9:
            tan[i] = last
        else:
            tan[i] = tan[i] / norm[i]
            last = tan[i]
    return tan, np.cross(tan, UP)
