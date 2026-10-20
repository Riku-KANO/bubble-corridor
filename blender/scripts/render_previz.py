"""プレビズを Eevee で描く（BLD-3）。静止画と動画。人が「退屈な区間がないか」を見るための下書き。

    blender -b previz.blend --python-exit-code 1 -P render_previz.py -- --out .snaps/previz [--stills 10,400] [--range 100:130 --fps 10] [--size 960x540]
    pnpm previz:render -- --stills 30,160 --size 640x360

  --stills  静止画の時刻（秒、カンマ区切り）。--range も --stills もなければ、各区間の真ん中の静止画。
  --range   動画の範囲 t0:t1（秒）。--fps で動画のコマ数（既定 10。30 の約数なら間引いて描く）。
  --size    幅x高さ（既定 960x540）。--samples  Eevee のサンプル数（既定 16、動画は 8）。

出力のファイル名に時刻（秒）を入れる:
  still_t0010.000.png、range_t0100.000-0130.000_10fps.mp4
動画に音（previz.py の --audio）を入れるのは --fps 30 のときだけ（間引くと音の長さが合わないため）。
"""
from __future__ import annotations

import argparse
import glob
import os
import sys

import bpy

sys.dont_write_bytecode = True  # __pycache__ を作らない（リポジトリを汚さない）
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from common.cli import script_args  # noqa: E402
from previz import FPS, SECTIONS  # noqa: E402


def parse_size(text: str) -> tuple[int, int]:
    w, _, h = text.lower().partition('x')
    return int(w), int(h)


def parse_times(text: str) -> list[float]:
    return [float(x) for x in text.split(',') if x.strip()]


def section_middles() -> list[float]:
    """各区間の真ん中の時刻（Sections の [開始, 終わり] から）"""
    sec = bpy.data.objects.get(SECTIONS)
    out = []
    if sec is not None:
        for k in sec.keys():
            v = sec[k]
            if not isinstance(v, str) and hasattr(v, '__len__') and len(v) == 2:
                out.append((float(v[0]) + float(v[1])) / 2.0)
    return out


def setup(size: tuple[int, int], samples: int) -> None:
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.render.resolution_percentage = 100
    sc.eevee.taa_render_samples = samples
    sc.view_settings.view_transform = 'Standard'


def render_stills(out: str, times: list[float]) -> list[str]:
    sc = bpy.context.scene
    if hasattr(sc.render.image_settings, 'media_type'):
        sc.render.image_settings.media_type = 'IMAGE'
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'
    sc.render.use_file_extension = True
    paths = []
    for t in times:
        frame = int(round(t * FPS))
        if not sc.frame_start <= frame <= sc.frame_end:
            raise ValueError(f'時刻 {t} 秒は乗車の外です（0〜{sc.frame_end / FPS} 秒）')
        sc.frame_set(frame)
        base = os.path.join(out, f'still_t{t:08.3f}')
        sc.render.filepath = base
        bpy.ops.render.render(write_still=True)
        paths.append(base + '.png')
    return paths


def render_range(out: str, t0: float, t1: float, fps: int) -> str:
    sc = bpy.context.scene
    if fps <= 0 or FPS % fps != 0:
        raise ValueError(f'--fps は 30 の約数（1, 2, 3, 5, 6, 10, 15, 30）: {fps}')
    f0, f1 = int(round(t0 * FPS)), int(round(t1 * FPS))
    if not (sc.frame_start <= f0 < f1 <= sc.frame_end):
        raise ValueError(f'範囲 {t0}:{t1} 秒は乗車の外か、空です（0〜{sc.frame_end / FPS} 秒）')
    name = f'range_t{t0:08.3f}-{t1:08.3f}_{fps}fps'
    sc.frame_start, sc.frame_end = f0, f1
    sc.frame_step = FPS // fps
    sc.render.fps = fps  # 間引いて描いた各コマが、そのまま動画の 1 コマになる
    sc.render.fps_base = 1.0
    im = sc.render.image_settings
    if hasattr(im, 'media_type'):  # Blender 5 は先に出力の種類を動画にする
        im.media_type = 'VIDEO'
    im.file_format = 'FFMPEG'
    ff = sc.render.ffmpeg
    ff.format = 'MPEG4'
    ff.codec = 'H264'
    ff.constant_rate_factor = 'MEDIUM'
    ff.ffmpeg_preset = 'GOOD'
    if fps == FPS:
        ff.audio_codec = 'AAC'
    sc.render.filepath = os.path.join(out, name + '_')
    bpy.ops.render.render(animation=True)
    # Blender が付ける「開始-終了」の名前を、時刻の名前に直す
    made = sorted(glob.glob(os.path.join(out, name + '_*.mp4')))
    if not made:
        raise RuntimeError('動画ができませんでした')
    final = os.path.join(out, name + '.mp4')
    os.replace(made[-1], final)
    return final


def main() -> None:
    ap = argparse.ArgumentParser(prog='render_previz.py')
    ap.add_argument('--out', required=True, help='出力の場所')
    ap.add_argument('--stills', help='静止画の時刻（秒、カンマ区切り）')
    ap.add_argument('--range', dest='span', help='動画の範囲 t0:t1（秒）')
    ap.add_argument('--fps', type=int, default=10, help='動画のコマ数（30 の約数、既定 10）')
    ap.add_argument('--size', default='960x540', help='幅x高さ')
    ap.add_argument('--samples', type=int, help='Eevee のサンプル数')
    args = ap.parse_args(script_args())

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    size = parse_size(args.size)
    done: list[str] = []
    if args.stills or not args.span:
        times = parse_times(args.stills) if args.stills else section_middles()
        setup(size, args.samples or 16)
        done += render_stills(out, times)
    if args.span:
        a, _, b = args.span.partition(':')
        setup(size, args.samples or 8)
        done.append(render_range(out, float(a), float(b), args.fps))
    for p in done:
        print(f'render_previz: {p}')


if __name__ == '__main__':
    main()
