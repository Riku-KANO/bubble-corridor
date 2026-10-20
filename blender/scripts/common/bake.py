"""光と影の焼き込み（BLD-5）。

Cycles（Metal があれば GPU）で DIFFUSE の DIRECT+INDIRECT（色は含めない、光だけ）を、
2つ目の UV（名前 Lightmap）へ焼いて PNG に書く。ゲーム側は動く光源を持たず、この画像を
ライトマップとして掛ける（three.js では lightMap・channel 1）。

- 焼いた値は線形（float32）。高い方の百分位（既定 99.99%。`percentile=` で変える）で割って 0〜1 に正規化し、
  sRGB にして **8bit の PNG（RGB）**で書く。割った倍率を物のカスタムプロパティ `lightmap_scale` に残す
  （線形の値 = 画像を線形に直した値 × lightmap_scale）。こうすると光が強い場面でも白く飽和せず、
  暗い場面でも 8bit を使い切る。百分位より明るい点は 1.0 で切れるので、アトラスの 0.01% より小さい
  極めて小さな明るい所（と、周りより 4 倍以上明るい 1 テクセルだけの突起 = モンテカルロのノイズ）が切れる。
  切れた画素の割合と max/scale を戻り値とログに出し、max/scale > 1.5 かつ切れた割合 > 0.05% なら WARNING。
- 保存後に PNG のビット深度を確かめる（8bit でなければエラー）。画像の向きは glTF の UV（v を反転）と
  合うよう上下を直して書く。読む側は flipY = false にする（README 参照）。
- 画像は glb の外に置く。物のカスタムプロパティ `lightmap`（out_dir からの相対の場所）と
  `lightmap_scale` が glb の extras になる。
- 材質がない物には材質を作る。焼くための一時の画像ノードは、終わったら材質から外す。
- メッシュを共有する物（インスタンス描画の物など）は、物ごとに光が違うので焼けない。
  既定では止める（split_shared=True で単独のコピーに直して焼く）。インスタンスとガラスは焼き込みの対象から外す。
- 重ならない UV は smart project と pack で作る（repack=False で手で作った Lightmap を使う）。
"""
from __future__ import annotations

import math
import os
import struct
import sys
import zlib
from typing import Iterable

import bpy
import numpy as np

UV_NAME = 'Lightmap'
PROP = 'lightmap'
PROP_SCALE = 'lightmap_scale'
_NODE = 'lightmap.bake'
#: 計算機の環境変数（CPU / GPU / AUTO）。GPU（Metal など）が使えれば AUTO は GPU
DEVICE_ENV = 'BLENDER_BAKE_DEVICE'
#: 正規化に使う百分位（高い方）。小さな日だまりや星の光を切らないよう、高めにしてある
PERCENTILE = 99.99
#: 周りの 8 テクセルの最大のこの倍率を超える 1 テクセルだけの突起は、百分位に数えない（ノイズ）
SPIKE_RATIO = 4.0
#: 切れた画素がこの割合を超え、かつ max/scale がこの倍率を超えたら WARNING
CLIP_WARN_FRAC = 0.0005
CLIP_WARN_RATIO = 1.5


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
    want = os.environ.get(DEVICE_ENV, 'AUTO').upper()
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


# ── 8bit の PNG ───────────────────────────────────────────────────────────
def _srgb_encode(lin: np.ndarray) -> np.ndarray:
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1.0 / 2.4) - 0.055)


def _png_chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF)


def write_png_rgb8(path: str, rgb: np.ndarray) -> None:
    """RGB 8bit（高さ, 幅, 3 の uint8、先頭の行が上）を PNG に書く。行ごとに上の行との差（Up）にして小さくする"""
    h, w, _ = rgb.shape
    raw = np.empty((h, 1 + w * 3), dtype=np.uint8)
    raw[:, 0] = 2
    raw[0, 0] = 0
    flat = np.ascontiguousarray(rgb).reshape(h, w * 3)
    raw[0, 1:] = flat[0]
    raw[1:, 1:] = flat[1:] - flat[:-1]  # uint8 のまま（256 で回り込む。PNG の Up フィルタと同じ）
    png = (
        b'\x89PNG\r\n\x1a\n'
        + _png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
        + _png_chunk(b'sRGB', b'\x00')
        + _png_chunk(b'IDAT', zlib.compress(raw.tobytes(), 9))
        + _png_chunk(b'IEND', b'')
    )
    with open(path, 'wb') as f:
        f.write(png)


def png_info(path: str) -> dict:
    """PNG の幅・高さ・ビット深度・色の種類（書いた後に確かめる）"""
    with open(path, 'rb') as f:
        head = f.read(33)
    if head[:8] != b'\x89PNG\r\n\x1a\n' or head[12:16] != b'IHDR':
        raise ValueError(f'PNG ではありません: {path}')
    w, h, depth, ctype = struct.unpack('>IIBB', head[16:26])
    return {'width': w, 'height': h, 'depth': depth, 'color_type': ctype}


def _despike(peak: np.ndarray) -> np.ndarray:
    """周りの 8 テクセルの最大の SPIKE_RATIO 倍を超える 1 テクセルだけの突起（ノイズ）を、周りの最大に置き換えた写し"""
    h, w = peak.shape
    padded = np.pad(peak, 1, mode='edge')
    around = np.zeros_like(peak)
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            if (dy, dx) != (1, 1):
                np.maximum(around, padded[dy:dy + h, dx:dx + w], out=around)
    spike = peak > SPIKE_RATIO * around + 1e-6
    return np.where(spike, around, peak)


def _save_normalized(img, path: str, percentile: float = PERCENTILE) -> dict:
    """焼いた float 画像を、高い百分位で割って 8bit の sRGB PNG にする。

    戻り値: scale（割った倍率 = lightmap_scale）、max（焼いた最大）、clipped_frac（焼かれた画素のうち 1.0 で切れた割合）。
    メモリを抑えるため float32 のまま、符号化は行の塊ごとにする。
    """
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    lin = px.reshape(h, w, 4)[:, :, :3]
    peak = lin.max(axis=2)
    lit_mask = peak > 1e-6  # 焼かれていない余白（真っ黒）は百分位に入れない
    n_lit = int(lit_mask.sum())
    if n_lit:
        scale = float(np.percentile(_despike(peak)[lit_mask], percentile))
        peak_max = float(peak.max())
        clipped = float((peak[lit_mask] > scale * (1.0 + 1e-6)).sum()) / n_lit
    else:
        scale, peak_max, clipped = 1.0, 0.0, 0.0
    scale = max(scale, 1e-4)
    rgb = np.empty((h, w, 3), dtype=np.uint8)
    inv = np.float32(1.0 / scale)
    for y0 in range(0, h, 256):
        rgb[y0:y0 + 256] = np.rint(_srgb_encode(lin[y0:y0 + 256] * inv) * 255.0).astype(np.uint8)
    del px, lin, peak
    write_png_rgb8(path, rgb[::-1])  # Blender の画像は下の行から。PNG は上の行から
    info = png_info(path)
    if info['depth'] != 8 or info['color_type'] != 2 or (info['width'], info['height']) != (w, h):
        raise RuntimeError(f'ライトマップが 8bit の RGB ではありません: {path} {info}')
    ratio = peak_max / scale
    if ratio > CLIP_WARN_RATIO and clipped > CLIP_WARN_FRAC:
        print(
            f'WARNING: {os.path.basename(path)}: 明るい所が切れています（max/scale = {ratio:.2f}、切れた画素 {clipped * 100:.3f}%）。'
            f'percentile（既定 {PERCENTILE}）を上げるか、サンプル数を増やしてください'
        )
    return {'scale': float(f'{scale:.6g}'), 'max': peak_max, 'clipped_frac': clipped}


def _shared_names(objs: list) -> list[str]:
    return [f'{o.name}（メッシュ {o.data.name}、{o.data.users} 人が共有）' for o in objs if o.data.users > 1]


def _default_name(objs: list) -> str:
    """物の名前の `<部屋>` が全部同じなら `<部屋>.lightmap`、違えば `lightmap`"""
    rooms = {o.name.split('.', 1)[0] for o in objs}
    return f'{rooms.pop()}.lightmap' if len(rooms) == 1 else 'lightmap'


def bake_lightmaps(
    objects: Iterable,
    out_dir: str,
    size: int = 1024,
    samples: int = 64,
    *,
    name: str | None = None,
    atlas: bool = True,
    repack: bool = True,
    margin: int | None = None,
    split_shared: bool = False,
    percentile: float = PERCENTILE,
) -> list[dict]:
    """objects の光と影を Lightmap UV に焼き、8bit の PNG を out_dir に書く。

    atlas=True なら全部の物で 1 枚（`<name>.png`。name の既定は `<部屋>.lightmap`）、False なら物ごとに 1 枚（`<物の名前>.png`）。
    メッシュを共有する物があると止まる（split_shared=True で単独のコピーにして焼く）。
    percentile は正規化に使う明るさの百分位（既定 99.99）。それより明るい画素は切れる。
    戻り値: [{'object': 物の名前, 'image': PNG の絶対パス, 'scale': lightmap_scale,
              'max_over_scale': 焼いた最大 ÷ scale, 'clipped_frac': 切れた画素の割合}, ...]
    """
    objs = [o for o in objects if o.type == 'MESH']
    if not objs:
        return []
    shared = _shared_names(objs)
    if shared and not split_shared:
        raise ValueError(
            'メッシュを共有する物は、物ごとに光が違うので焼けません。インスタンスやガラスは焼き込みの対象から外すか、'
            'split_shared=True で単独のコピーにしてください:\n  ' + '\n  '.join(shared)
        )
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    margin = max(2, size // 128) if margin is None else margin
    island_margin = min(0.05, 2.0 * margin / size)

    groups = [(name or _default_name(objs), objs)] if atlas else [(o.name, [o]) for o in objs]
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
            for o in group:
                if o.data.users > 1:  # split_shared=True のとき
                    o.data = o.data.copy()
            mats = _ensure_materials(group, gname)
            saved_uv = _prepare_uv(group, repack, island_margin)
            img = bpy.data.images.new(f'{gname}.bake', size, size, alpha=False, float_buffer=True)
            img.colorspace_settings.name = 'Non-Color'  # 焼いた線形の値をそのまま float に残す（色空間の変換を入れない）
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
            stat = _save_normalized(img, path, percentile)
            scale = stat['scale']
            for m, node in nodes:
                m.node_tree.nodes.remove(node)
            bpy.data.images.remove(img)
            for o in group:
                o.data.uv_layers.active = o.data.uv_layers[saved_uv[o.name]]
                for u in o.data.uv_layers:
                    u.active_render = u.name == saved_uv[o.name]
                o[PROP] = os.path.relpath(path, out_dir)
                o[PROP_SCALE] = scale
                results.append({'object': o.name, 'image': path, 'scale': scale, 'max_over_scale': stat['max'] / scale, 'clipped_frac': stat['clipped_frac']})
            print(
                f'bake: {gname} {size}px {samples}spp {device} 8bit {os.path.getsize(path)}B scale={scale} '
                f"max/scale={stat['max'] / scale:.2f} clipped={stat['clipped_frac'] * 100:.3f}% -> {path}"
            )
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
