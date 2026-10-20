"""部屋の glb の書き出し（BLD-6 / BLD-7）。

- カスタムプロパティ（role・touch_kind・touch_id・glass など）は glTF の extras（three.js の userData）へ入る。
- Y が上（three.js の向き）に変換して書く。
- 画像は埋め込まない（ライトマップは別の PNG。node のテストでも glb を読める）。
- 2つ目の UV（Lightmap）も TEXCOORD_1 として書く。
- カメラ・ライト・アニメーションは書かない（動きは TS が重ねる）。
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterable

import bpy

from .naming import check_names

#: 部屋の glb の上限（config.ts の PERF.roomLoadMB。10進の MB）
MAX_BYTES = 15 * 1000 * 1000


@contextmanager
def _only_selected(objects: list):
    """objects だけを選択して、終わったら選択・表示の状態を戻す"""
    view_layer = bpy.context.view_layer
    in_layer = set(view_layer.objects)
    missing = [o.name for o in objects if o not in in_layer]
    if missing:
        raise ValueError(f'ビューレイヤーにない物は書き出せません: {missing}')
    was_selected = [o for o in view_layer.objects if o.select_get()]
    was_active = view_layer.objects.active
    was_hidden = [o for o in objects if o.hide_get()]
    try:
        for o in view_layer.objects:
            o.select_set(False)
        for o in was_hidden:
            o.hide_set(False)
        for o in objects:
            o.select_set(True)
        view_layer.objects.active = objects[0]
        yield
    finally:
        for o in view_layer.objects:
            o.select_set(False)
        for o in was_hidden:
            o.hide_set(True)
        for o in was_selected:
            if o.name in view_layer.objects:
                o.select_set(True)
        view_layer.objects.active = was_active


def export_glb(objects: Iterable, path: str, *, max_bytes: int | None = MAX_BYTES, rooms: Iterable[str] | None = None, options: dict | None = None) -> int:
    """objects だけを glb として path に書き、バイト数を返す。

    max_bytes を超えたら ValueError（None で検査しない）。名前の規則に合わない物があれば警告を出す（書き出しは続ける）。
    options は io_scene_gltf2 の引数の上書き（例: {'export_apply': False}）。
    """
    objs = list(objects)
    if not objs:
        raise ValueError('書き出す物がありません')
    bad = check_names(objs, rooms)
    if bad:
        print(f'WARNING: 名前の規則（<部屋>.<部品>[.<番号>]）に合わない物: {bad}')
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kwargs = dict(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_extras=True,  # カスタムプロパティ → extras
        export_yup=True,  # Z 上 → Y 上
        export_apply=True,  # モディファイアを適用
        export_image_format='NONE',  # 画像を埋め込まない
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
    )
    kwargs.update(options or {})
    with _only_selected(objs):
        result = bpy.ops.export_scene.gltf(**kwargs)
    if 'FINISHED' not in result:
        raise RuntimeError(f'glTF の書き出しに失敗: {result}')
    size = os.path.getsize(path)
    if max_bytes is not None and size > max_bytes:
        raise ValueError(f'{path} が {size} バイトで上限（{max_bytes}）を超えています')
    return size
