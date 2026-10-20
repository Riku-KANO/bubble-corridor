"""光と影の焼き込み（BLD-5）。

Cycles（Metal があれば GPU）で DIFFUSE の DIRECT+INDIRECT（色は含めない、光だけ）を、
2つ目の UV（名前 Lightmap）へ焼いて PNG に書く。ゲーム側は動く光源を持たず、この画像を
ライトマップとして掛ける（three.js では lightMap・channel 1）。

- 画像は glb の外に置く。物のカスタムプロパティ `lightmap` に、out_dir からの相対の場所を入れる
  （glb の extras になる）。
- 画像は sRGB で保存する（8bit で暗部を細かく残すため。読む側も sRGB として読む）。
- 材質がない物には材質を作る。焼くための一時の画像ノードは、終わったら材質から外す。
- メッシュを共有する物（リンク複製）は、物ごとに光が違うので単独のコピーに直す。
- 重ならない UV は smart project と pack で作る（repack=False で手で作った Lightmap を使う）。
"""
from __future__ import annotations

import math
import os
import sys
from typing import Iterable

import bpy

UV_NAME = 'Lightmap'
PROP = 'lightmap'
_NODE = 'lightmap.bake'


def _select(objs: list, active) -> None:
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def _ensure_materials(objs: list, tag: str) -> list:
    """材質のない物（と空のスロット）に材質を作る。使う材質の一覧を返す"""
    default = None
    mats: list = []
    for o in objs:
        if len(o.material_slots) == 0:
            if default is None:
                default = bpy.data.materials.new(f'{tag}.default')
            o.data.materials.append(default)
        for slot in o.material_slots:
            if slot.material is None:
                if default is None:
                    default = bpy.data.materials.new(f'{tag}.default')
                slot.material = default
        for slot in o.material_slots:
            m = slot.material
            if m.node_tree is None:
                m.use_nodes = True
            if m not in mats:
                mats.append(m)
    return mats


def _prepare_uv(objs: list, repack: bool, island_margin: float) -> dict:
    """各物に UV Lightmap を用意し（最初の UV が空なら作り）、重ならないよう展開・配置する。元の render UV を覚えて返す"""
    saved = {}
    for o in objs:
        me = o.data
        if len(me.uv_layers) == 0:
            me.uv_layers.new(name='UVMap')  # glb の TEXCOORD_0。Lightmap を必ず 2 つ目にする
        saved[o.name] = next((u.name for u in me.uv_layers if u.active_render), me.uv_layers[0].name)
        if repack:
            if UV_NAME in me.uv_layers:
                me.uv_layers.remove(me.uv_layers[UV_NAME])
            me.uv_layers.new(name=UV_NAME)
        elif UV_NAME not in me.uv_layers:
            raise ValueError(f'{o.name}: repack=False には UV {UV_NAME} が必要です')
    for o in objs:
        lm = o.data.uv_layers[UV_NAME]
        o.data.uv_layers.active = lm
        lm.active_render = True
    if repack:
        _select(objs, objs[0])
        bpy.ops.object.mode_set(mode='EDIT')
        try:
            bpy.context.tool_settings.use_uv_select_sync = True
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=island_margin)
            bpy.ops.uv.pack_islands(margin=island_margin)
        finally:
            bpy.ops.object.mode_set(mode='OBJECT')
    return saved


def _use_gpu(scene) -> str:
    """Cycles の計算機を選ぶ。Metal などの GPU があれば GPU、なければ CPU。使った名前を返す"""
    want = os.environ.get('UTAKATA_BAKE_DEVICE', 'AUTO').upper()
    scene.cycles.device = 'CPU'
    if want == 'CPU':
        return 'CPU'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        kind = 'METAL' if sys.platform == 'darwin' else 'OPTIX'
        for k in (kind, 'CUDA', 'HIP', 'ONEAPI'):
            try:
                prefs.compute_device_type = k
            except TypeError:
                continue
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type != 'CPU']
            if gpus:
                for d in prefs.devices:
                    d.use = d.type != 'CPU'
                scene.cycles.device = 'GPU'
                return k
    except Exception as e:  # noqa: BLE001 - GPU が使えなくても CPU で焼ければよい
        print(f'WARNING: GPU を使えません（CPU で焼きます）: {e}')
    scene.cycles.device = 'CPU'
    return 'CPU'


def bake_lightmaps(
    objects: Iterable,
    out_dir: str,
    size: int = 1024,
    samples: int = 64,
    *,
    name: str = 'lightmap',
    atlas: bool = True,
    repack: bool = True,
    margin: int | None = None,
) -> list[dict]:
    """objects の光と影を Lightmap UV に焼き、PNG を out_dir に書く。

    atlas=True なら全部の物で 1 枚（`<name>.png`）、False なら物ごとに 1 枚（`<物の名前>.png`）。
    戻り値: [{'object': 物の名前, 'image': PNG の絶対パス}, ...]
    """
    objs = [o for o in objects if o.type == 'MESH']
    if not objs:
        return []
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    margin = max(2, size // 128) if margin is None else margin
    island_margin = min(0.05, 2.0 * margin / size)

    groups = [(name, objs)] if atlas else [(o.name, [o]) for o in objs]
    scene = bpy.context.scene
    keep = {
        'engine': scene.render.engine,
        'samples': scene.cycles.samples if hasattr(scene, 'cycles') else None,
        'device': scene.cycles.device if hasattr(scene, 'cycles') else None,
        'sync': bpy.context.tool_settings.use_uv_select_sync,
        'select': [o for o in bpy.context.view_layer.objects if o.select_get()],
        'active': bpy.context.view_layer.objects.active,
    }
    results: list[dict] = []
    try:
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = samples
        scene.cycles.use_denoising = False
        scene.cycles.use_adaptive_sampling = False
        device = _use_gpu(scene)
        for gname, group in groups:
            # メッシュを共有する物は、物ごとに光が違うので単独のコピーにする
            for o in group:
                if o.data.users > 1:
                    o.data = o.data.copy()
            mats = _ensure_materials(group, gname)
            saved_uv = _prepare_uv(group, repack, island_margin)
            img = bpy.data.images.new(f'{gname}.bake', size, size, alpha=False, float_buffer=True)
            img.colorspace_settings.name = 'sRGB'
            nodes = []
            for m in mats:
                node = m.node_tree.nodes.new('ShaderNodeTexImage')
                node.name = _NODE
                node.image = img
                m.node_tree.nodes.active = node
                nodes.append((m, node))
            _select(group, group[0])
            try:
                _bake(margin)
            except RuntimeError as e:
                if device == 'CPU':
                    raise
                print(f'WARNING: {device} で焼けませんでした（CPU でやり直します）: {e}')
                scene.cycles.device = 'CPU'
                device = 'CPU'
                _bake(margin)
            path = os.path.join(out_dir, f'{gname}.png')
            img.filepath_raw = path
            img.file_format = 'PNG'
            img.save()
            for m, node in nodes:
                m.node_tree.nodes.remove(node)
            bpy.data.images.remove(img)
            for o in group:
                o.data.uv_layers.active = o.data.uv_layers[saved_uv[o.name]]
                for u in o.data.uv_layers:
                    u.active_render = u.name == saved_uv[o.name]
                o[PROP] = os.path.relpath(path, out_dir)
                results.append({'object': o.name, 'image': path})
            print(f'bake: {gname} {size}px {samples}spp {device} -> {path}')
    finally:
        scene.render.engine = keep['engine']
        if keep['samples'] is not None:
            scene.cycles.samples = keep['samples']
            scene.cycles.device = keep['device']
        bpy.context.tool_settings.use_uv_select_sync = keep['sync']
        _select([o for o in keep['select'] if o.name in bpy.data.objects], keep['active'] if keep['active'] and keep['active'].name in bpy.data.objects else None)
    return results


def _bake(margin: int) -> None:
    bpy.ops.object.bake(
        type='DIFFUSE',
        pass_filter={'DIRECT', 'INDIRECT'},
        margin=margin,
        margin_type='EXTEND',
        use_clear=True,
        use_selected_to_active=False,
    )
