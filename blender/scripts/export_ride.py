"""プレビズから rail.json と cues.json を書き出す（BLD-2）。

    blender -b previz.blend --python-exit-code 1 -P export_ride.py -- --out-dir public/assets
    pnpm previz:export

書き出しは、いまの Blender の中身から計算する（人がカーブやアニメーションを直したら反映される）:

  - rail.json の rail: 'Rail' のカーブを 1m（spacing）間隔の点列にする。点がすでに間隔どおり
    （累積の長さが 10cm 以内）なら点をそのまま使い、そうでなければ折れ線の上で打ち直す。
    座標は three.js の向き（Y が上）に直す（common/coords.py）。
  - timeline: 'Gondola' の世界の位置を 0.25〜0.5 秒ごと（Rail の timeline_dt）に評価し、
    レール上の最も近い点を距離 s（点の番号 × 間隔）にする。s は単調非減少。
  - duration と時刻の基準: Rail の duration（previz.py が保存）と frame 0。シーンの範囲を変えても無視する（警告）。
    乗車時間を変えるなら Rail の duration を直す。
  - gentleY: レールは 1 本で gentleY は持たない（ADR-0008）。元の rail.json にあってカーブが元のままなら保存した値を
    そのまま書く（往復のため）。カーブを直したら落とす（警告）。
  - sections: 'Sections' の各区間の [開始の秒, 終わりの秒] を、時刻表で距離に直す。
  - cues.json: タイムラインマーカー（名前の決まりは previz.encode_marker）。時刻の昇順（同時刻は並びのまま）、
    bar = t / (10/3)。出来事の名前・data・in=・時刻を検査し、違反はすべて一覧にして止める（何も書かない）。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bpy
import numpy as np

sys.dont_write_bytecode = True  # __pycache__ を作らない（リポジトリを汚さない）
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from common.cli import script_args  # noqa: E402
from common.coords import blender_to_three  # noqa: E402
from previz import (  # noqa: E402
    DATA_KEYS,
    FPS,
    GONDOLA,
    P_DURATION,
    P_GENTLE_Y,
    P_SIGNATURE,
    P_SPACING,
    P_TIMELINE_DT,
    RAIL,
    SEC_PER_BAR,
    SECTIONS,
    decode_marker,
    evaluated_polyline,
    polyline_signature,
)

# マーカーの検査に使う名前の一覧。contracts（src/contracts/events.ts の CUE_NAMES、ids.ts の SECTION_IDS・SHOT_IDS）の写し。
# Python からは TS を読めないので写している。scripts/blender-constants.test.ts が契約と同じかを検査する。
CUE_NAMES = (
    'ride.start',
    'hint.touch',
    'membrane',
    'lure',
    'greenhouse.bloom',
    'greenhouse.dewfall',
    'rain.freeze',
    'rain.doors',
    'branch.decide',
    'kaleidoscope.flower',
    'celestial.blackout',
    'celestial.stars',
    'celestial.constellation',
    'dawn.sunrise',
    'departure.open',
    'photo.capture',
    'ride.end',
)
SECTION_IDS = ('platform', 'greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn', 'departure')
SHOT_IDS = ('bloom', 'freeze', 'constellation')

#: 折れ線の点をそのまま使ってよい累積の長さの誤差（m）
KEEP_TOLERANCE = 0.1
#: 打ち直しで、直線距離の累積が 番号 × 間隔 からずれてよい上限（m）。超えたら警告
CHORD_DRIFT_WARN = 0.1
#: 時刻表の探索で、前の位置から先へ調べる区間の数（これで見つからなければ全体から探す）
SEARCH_WINDOW = 64
#: ゴンドラがレールからこれ以上離れていたら、窓の外も探す（m）
SEARCH_RADIUS = 0.5
#: マーカーの id の `@小節` が時刻の小節とこれ以上ずれていたら、時刻から作り直す（小節。0.5 フレーム）
BAR_TOLERANCE = 0.005


def warn(message: str) -> None:
    print(f'WARNING: {message}')


def num(x: float, digits: int = 6):
    """JSON に書く数。整数で表せるものは整数に"""
    r = round(float(x), digits)
    return int(r) if r == int(r) and abs(r) < 1e15 else r


def chord_drift(pts: np.ndarray, spacing: float) -> float:
    """点列の直線距離の累積と 番号 × 間隔 の差の最大（m）"""
    cum = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    return float(np.abs(cum - np.arange(len(pts)) * spacing).max())


def uniform_points(poly: np.ndarray, spacing: float) -> np.ndarray:
    """折れ線 poly を spacing 間隔の点列にする。すでに間隔どおり（累積の長さが番号 × 間隔から KEEP_TOLERANCE 以内）なら点をそのまま返す"""
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    if np.abs(cum - np.arange(len(poly)) * spacing).max() <= KEEP_TOLERANCE:
        return poly
    n = int(math.floor(cum[-1] / spacing + 1e-9)) + 1
    at = np.arange(n) * spacing
    return np.stack([np.interp(at, cum, poly[:, k]) for k in range(3)], axis=1)


def project_to_rail(pts: np.ndarray, positions: np.ndarray, spacing: float) -> np.ndarray:
    """各位置をレール（折れ線）の最も近い点へ射影し、距離 s（番号 × 間隔）にする。前の位置から先を優先して探す"""
    a = pts[:-1]
    ab = pts[1:] - a
    l2 = np.maximum((ab ** 2).sum(axis=1), 1e-18)

    def nearest(p: np.ndarray, lo: int, hi: int):
        f = np.clip(((p - a[lo:hi]) * ab[lo:hi]).sum(axis=1) / l2[lo:hi], 0.0, 1.0)
        d = np.linalg.norm(a[lo:hi] + ab[lo:hi] * f[:, None] - p, axis=1)
        k = int(np.argmin(d))
        return lo + k, float(f[k]), float(d[k])

    out = np.empty(len(positions))
    seg = 0
    for i, p in enumerate(positions):
        j, f, d = nearest(p, max(0, seg - 2), min(len(a), seg + SEARCH_WINDOW))
        if d > SEARCH_RADIUS:
            j, f, d = nearest(p, 0, len(a))
        seg = j
        out[i] = (j + f) * spacing
    return out


def read_cues(markers, duration: float, section_at) -> list[tuple[int, dict]]:
    """タイムラインマーカー → (frame, Cue)。名前・data・in=・時刻を検査し、違反はすべて一覧にして ValueError で止める"""
    errors: list[str] = []
    cues: list[tuple[int, dict]] = []
    seen: dict[str, str] = {}
    for m in markers:
        label = f'マーカー {m.name!r}（frame {m.frame}）'
        try:
            info = decode_marker(m.name)
        except ValueError as e:
            errors.append(f'{label}: {e}')
            continue
        bad = len(errors)
        t = m.frame / FPS
        bar = t / SEC_PER_BAR
        if info['name'] not in CUE_NAMES:
            errors.append(f"{label}: 出来事の名前 {info['name']!r} がありません（CUE_NAMES にある名前にしてください）")
        for k, v in info['data'].items():
            if k not in DATA_KEYS:
                errors.append(f'{label}: data のキー {k!r} は使えません（{", ".join(DATA_KEYS)}）')
            elif k == 'to' and v not in SECTION_IDS:
                errors.append(f'{label}: to={v} は区間ではありません（{", ".join(SECTION_IDS)}）')
            elif k == 'target' and v not in CUE_NAMES:
                errors.append(f'{label}: target={v} は出来事の名前ではありません')
            elif k == 'shot' and v not in SHOT_IDS:
                errors.append(f'{label}: shot={v} は撮影の名前ではありません（{", ".join(SHOT_IDS)}）')
        if info['section'] is not None and info['section'] not in SECTION_IDS:
            errors.append(f"{label}: in={info['section']} は区間ではありません（{', '.join(SECTION_IDS)}）")
        if not 0.0 <= t <= duration + 1e-9:
            errors.append(f'{label}: 時刻 {t:.3f} 秒が乗車の外です（0〜{duration:g} 秒）')
        if len(errors) > bad:
            continue
        derived = section_at(t)
        section = info['section'] or derived
        if info['section'] is not None and info['section'] != derived:
            warn(f"{label}: in={info['section']} ですが、時刻 {t:.2f} 秒は Sections では {derived} です（in= を使います）")
        if info['id'] is not None:
            try:
                id_bar = float(info['id'].split('@', 1)[1])
            except ValueError:
                errors.append(f"{label}: id の小節 {info['id'].split('@', 1)[1]!r} が数ではありません")
                continue
            if abs(id_bar - bar) > BAR_TOLERANCE:
                warn(f"{label}: id の小節 {id_bar:g} が時刻の小節 {bar:.3f} と食い違います（時刻から作り直します）")
                cid = f"{info['name']}@{num(bar, 3)}"
            else:
                cid = info['id']
        else:
            cid = f"{info['name']}@{num(bar, 3)}"
        if cid in seen:
            errors.append(f'{label}: キューの id {cid} が {seen[cid]} と重なっています')
            continue
        seen[cid] = label
        cue = {'id': cid, 'name': info['name'], 't': num(t, 9), 'bar': num(bar, 9), 'section': section}
        if info['data']:
            cue['data'] = info['data']
        cues.append((m.frame, cue))
    if errors:
        raise ValueError(f'タイムラインマーカーに {len(errors)} 件の問題があります。直してからもう一度書き出してください:\n  ' + '\n  '.join(errors))
    cues.sort(key=lambda x: x[0])  # 安定ソート: 同じ時刻は作った順のまま
    return cues


def export(out_dir: str) -> dict:
    sc = bpy.context.scene
    for name in (RAIL, GONDOLA, SECTIONS):
        if name not in bpy.data.objects:
            raise ValueError(f"'{name}' がありません（previz.py で組んだ previz.blend を開いてください）")
    rail = bpy.data.objects[RAIL]
    gondola = bpy.data.objects[GONDOLA]
    fps = sc.render.fps / sc.render.fps_base
    if abs(fps - FPS) > 1e-6:
        raise ValueError(f'フレームレートが {FPS}fps ではありません（{fps:g}）。マーカーの時刻が変わってしまうので止めます')

    # 乗車時間と時刻の基準は、保存した duration と frame 0（シーンの範囲を変えても動かさない）
    if rail.get(P_DURATION) is not None:
        duration = float(rail[P_DURATION])
    else:
        duration = sc.frame_end / fps
        warn(f"Rail に {P_DURATION} がありません。シーンの終わり（frame {sc.frame_end}）から {duration:g} 秒とします")
    end_frame = int(round(duration * FPS))
    if sc.frame_start != 0 or sc.frame_end != end_frame:
        warn(f'シーンの範囲 {sc.frame_start}〜{sc.frame_end} は無視し、frame 0〜{end_frame}（{duration:g} 秒）で書き出します。乗車時間を変えるなら Rail の {P_DURATION} を直してください')

    # レール
    spacing = float(rail.get(P_SPACING, 1.0))
    poly = evaluated_polyline(rail)
    unchanged = rail.get(P_SIGNATURE) == polyline_signature(poly)
    pts_b = uniform_points(poly, spacing)
    resampled = pts_b is not poly
    if resampled:
        drift = chord_drift(pts_b, spacing)
        if drift > CHORD_DRIFT_WARN:
            warn(f'打ち直した点の直線距離が、番号 × 間隔 より最大 {drift:.2f}m 短くなっています（曲がりが急）。時刻表の s と実際の道のりがずれるので、曲がりをゆるめてください')
    pts_three = np.array([blender_to_three(p) for p in pts_b])
    gentle = None
    stored = rail.get(P_GENTLE_Y)
    if stored is not None:
        if unchanged and len(stored) == len(pts_three):
            gentle = [float(y) for y in stored]  # 往復のため、元のままなら保存した値をそのまま
        else:
            warn('レールを直したので、元の gentleY は書きません（レールは 1 本。ADR-0008）')

    # 時刻表: ゴンドラの世界の位置 → レール上の距離
    dt = min(0.5, max(0.25, float(rail.get(P_TIMELINE_DT, 0.5))))
    times = list(np.arange(0.0, duration, dt))
    times.append(duration)
    positions = np.empty((len(times), 3))
    for i, t in enumerate(times):
        frame = t * FPS
        whole = int(math.floor(frame + 1e-9))
        sc.frame_set(whole, subframe=max(0.0, frame - whole))
        positions[i] = gondola.matrix_world.translation
    raw_s = project_to_rail(pts_b, positions, spacing)
    s = np.maximum.accumulate(raw_s)  # 時刻表の s は単調非減少（後ろへは戻れない）
    back = np.flatnonzero(s - raw_s > 0.01)
    if len(back):
        warn(f'ゴンドラが後ろへ動いています（{len(back)} か所。最初は t={times[back[0]]:.2f}秒、{float((s - raw_s)[back].max()):.2f}m）。時刻表はその間止まります')
    t_arr = np.asarray(times)

    def s_at(t: float) -> float:
        return float(np.interp(t, t_arr, s))

    # 区間
    sec_obj = bpy.data.objects[SECTIONS]
    spans = []
    for key in sec_obj.keys():
        v = sec_obj[key]
        if isinstance(v, str) or not hasattr(v, '__len__') or len(v) != 2:
            continue  # [開始, 終わり] の対だけが区間
        spans.append((key, float(v[0]), float(v[1])))
    if not spans:
        raise ValueError(f"'{SECTIONS}' に区間（id → [開始の秒, 終わりの秒]）がありません")
    sections = [{'id': k, 's0': num(s_at(t0), 4), 's1': num(s_at(min(t1, duration)), 4)} for k, t0, t1 in spans]

    def section_at(t: float) -> str:
        cur = spans[0][0]
        for k, t0, _t1 in sorted(spans, key=lambda x: x[1]):
            if t0 <= t + 1e-9:
                cur = k
        return cur

    # キューシート: マーカー → Cue（違反があればここで止まる。何も書かない）
    cues = read_cues(sc.timeline_markers, duration, section_at)

    ride = {
        'version': 1,
        'duration': num(duration, 9),
        'rail': {'spacing': num(spacing), 'points': [[num(c, 5) for c in p] for p in pts_three]},
        'timeline': [{'t': num(t, 6), 's': num(v, 4)} for t, v in zip(times, s)],
    }
    if gentle is not None:
        ride['gentleY'] = [num(y, 5) for y in gentle]
    ride['sections'] = sections

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'rail.json'), 'w', encoding='utf-8') as f:
        json.dump(ride, f, separators=(',', ':'), ensure_ascii=False)
        f.write('\n')
    with open(os.path.join(out_dir, 'cues.json'), 'w', encoding='utf-8') as f:
        json.dump([c for _f, c in cues], f, indent=1, ensure_ascii=False)
        f.write('\n')
    return {
        'points': len(pts_three),
        'length': float(len(pts_three) - 1) * spacing,
        'timeline': len(times),
        'sections': len(sections),
        'cues': len(cues),
        'duration': duration,
        'curve_unchanged': unchanged,
        'resampled': resampled,
    }


def main() -> None:
    ap = argparse.ArgumentParser(prog='export_ride.py')
    ap.add_argument('--out-dir', required=True, help='rail.json と cues.json を書く場所')
    args = ap.parse_args(script_args())
    info = export(os.path.abspath(args.out_dir))
    print(
        f"export_ride: 点 {info['points']}（{info['length']:.0f}m、{'打ち直し' if info['resampled'] else '元の点のまま'}）、"
        f"時刻表 {info['timeline']}、区間 {info['sections']}、キュー {info['cues']}、{info['duration']:.1f}秒"
    )


if __name__ == '__main__':
    main()
