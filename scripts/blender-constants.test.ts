// S-17 Blender のスクリプトに写した設計書の数値と名前が、src/config.ts と契約に揃っているか（親が作成。実装担当は変更しない）。
// Python からは TS を読めないので写している。写しがずれると、bar の計算・カメラ・部屋の割り当て・容量の上限・マーカーの検査が
// 黙って食い違う（S-17 のレビュー）。Blender を起動しないので、速い検査（check.sh --quick）で毎回回る。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CUE_NAMES } from '../src/contracts/events';
import { ROOM_OF_SECTION, SECTION_IDS, SHOT_IDS } from '../src/contracts/ids';
import { CAMERA, GONDOLA_DIAMETER, PERF, SEC_PER_BAR } from '../src/config';
import { buildCueSheet } from '../src/ride';

const py = (path: string) => readFileSync(new URL(`../blender/scripts/${path}`, import.meta.url), 'utf8');

/** `NAME = 式` の右辺（数と * / + - と括弧だけ）を計算する。eval は使わない */
function pyNumber(text: string, name: string): number {
  const m = new RegExp(`^${name}\\s*(?::[^=]+)?=\\s*([^#\\n]+)`, 'm').exec(text);
  if (!m) throw new Error(`${name} がない`);
  const tokens = m[1].replace(/_/g, '').match(/\d+(?:\.\d+)?|[()*/+-]/g) ?? [];
  let i = 0;
  const expr = (): number => {
    let v = term();
    while (tokens[i] === '+' || tokens[i] === '-') v = tokens[i++] === '+' ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (tokens[i] === '*' || tokens[i] === '/') v = tokens[i++] === '*' ? v * factor() : v / factor();
    return v;
  };
  const factor = (): number => {
    const t = tokens[i++];
    if (t === '(') {
      const v = expr();
      i++;
      return v;
    }
    if (t === '-') return -factor();
    return Number(t);
  };
  return expr();
}

/** `NAME = (...)` や `[...]`、`{...}` の中の引用符の文字列 */
function pyStrings(text: string, name: string): string[] {
  const m = new RegExp(`^${name}\\s*(?::[^=]+)?=\\s*[(\\[{]([\\s\\S]*?)[)\\]}]`, 'm').exec(text);
  if (!m) throw new Error(`${name} がない`);
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

describe('BLD-1 写した数値（previz.py）', () => {
  const src = py('previz.py');
  it('1小節の秒、座席の目の高さ、縦の視野角、ゴンドラの直径', () => {
    expect(pyNumber(src, 'SEC_PER_BAR')).toBeCloseTo(SEC_PER_BAR, 9);
    expect(pyNumber(src, 'SEAT_EYE_HEIGHT')).toBeCloseTo(CAMERA.seatEyeHeight, 9);
    expect(pyNumber(src, 'FOV_DEG')).toBeCloseTo(CAMERA.fovDeg, 9);
    expect(pyNumber(src, 'GONDOLA_DIAMETER')).toBeCloseTo(GONDOLA_DIAMETER, 9);
  });

  it('区間 → 部屋', () => {
    const pairs = pyStrings(src, 'ROOM_OF_SECTION');
    const map: Record<string, string> = {};
    for (let i = 0; i + 1 < pairs.length; i += 2) map[pairs[i]] = pairs[i + 1];
    expect(map).toEqual(ROOM_OF_SECTION);
  });

  it('30fps のタイムラインに、キューの時刻がすべて乗る（1/30 秒の整数倍）', () => {
    const fps = pyNumber(src, 'FPS');
    expect(fps).toBe(30);
    for (const c of buildCueSheet()) expect(Math.abs(c.t * fps - Math.round(c.t * fps)), c.id).toBeLessThan(1e-6);
  });
});

describe('BLD-2 マーカーの検査に使う名前の一覧（export_ride.py）', () => {
  const src = py('export_ride.py');
  it('出来事・区間・撮影の名前が契約と同じ', () => {
    expect(pyStrings(src, 'CUE_NAMES').sort()).toEqual([...CUE_NAMES].sort());
    expect(pyStrings(src, 'SECTION_IDS').sort()).toEqual([...SECTION_IDS].sort());
    expect(pyStrings(src, 'SHOT_IDS').sort()).toEqual([...SHOT_IDS].sort());
  });
});

describe('BLD-4 / BLD-7 見回せる範囲と容量の上限（common）', () => {
  it('面の削除の既定の範囲は、見回せる範囲（左右 ±120°・上下 ±60°）', () => {
    const src = py('common/visibility.py');
    const yaw = /yaw_deg:\s*float\s*=\s*([\d.]+)/.exec(src);
    const pitch = /pitch_deg:\s*float\s*=\s*([\d.]+)/.exec(src);
    expect(Number(yaw?.[1])).toBe(CAMERA.yawRangeDeg);
    expect(Number(pitch?.[1])).toBe(CAMERA.pitchRangeDeg);
  });

  it('glb の上限は「各部屋 15MB 以下」（10進の MB）', () => {
    expect(pyNumber(py('common/export.py'), 'MAX_BYTES')).toBe(PERF.roomLoadMB * 1000 * 1000);
  });
});
