// 9:50 の星座の街の線と、星の置き方（純粋な計算）の確かめ。部屋の振る舞いは room.test.ts（親が作成）が見る。
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { LURE_LEAD_SEC } from '../../config';
import { CITY_FOCUS, cityPosition, cityStrokes, layoutCity, type CityFrame } from './constellation';
import { STAR_COUNTS, generateStarField } from './stars';

const frame: CityFrame = { eye: new THREE.Vector3(0, 8, 0), forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0) };

describe('星座の街', () => {
  it('撮影の瞬間（見どころの時刻）には描き上がっていて、描き始めは誘導の少し前から', () => {
    const focusT = 590;
    const { segments } = layoutCity(frame, focusT);
    const end = Math.max(...segments.map((s) => s.t0 + s.duration));
    const start = Math.min(...segments.map((s) => s.t0));
    expect(end).toBeLessThan(focusT);
    expect(start).toBeGreaterThanOrEqual(focusT - LURE_LEAD_SEC - 1.5);
  });

  it('線の端にはすべて星があり、星は線が届く時刻を持つ', () => {
    const { segments, stars, joinAt } = layoutCity(frame, 590);
    expect(stars.length).toBe(joinAt.length);
    for (const s of segments) {
      expect(stars.some((p) => p.distanceTo(s.a) < 0.3)).toBe(true);
      expect(stars.some((p) => p.distanceTo(s.b) < 0.3)).toBe(true);
    }
  });

  it('街の中心は正面の少し上（見どころの向き）、殻のあいだ（22〜33m）', () => {
    const f = cityPosition(frame, CITY_FOCUS);
    const d = f.distanceTo(frame.eye);
    expect(d).toBeGreaterThan(22);
    expect(d).toBeLessThan(33);
    expect(f.z).toBeLessThan(frame.eye.z);
    for (const s of cityStrokes()) for (const p of s.pts) expect(Math.abs(p.u)).toBeLessThanOrEqual(48);
  });
});

describe('星の海', () => {
  const input = {
    center: new THREE.Vector3(0, 0, 0),
    shellRadii: [13, 22, 33, 46, 61.5],
    path: [new THREE.Vector3(-80, 0, 0), new THREE.Vector3(-40, 0, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(40, 0, 0)],
    otherPath: [new THREE.Vector3(0, 0, 300)],
    cityEye: new THREE.Vector3(0, 0, 0),
    cityForward: new THREE.Vector3(1, 0, 0),
    revealEye: new THREE.Vector3(-80, 0, 0),
    revealForward: new THREE.Vector3(1, 0, 0),
    revealT: 482,
  };

  it('low は high の部分集合（同じ星を減らす）で、灯る時刻は暗転が明けた後', () => {
    const high = generateStarField({ ...input, scale: 1 });
    const low = generateStarField({ ...input, scale: 0.4 });
    expect(high.count).toBeGreaterThan(low.count);
    expect(high.count).toBeLessThanOrEqual(STAR_COUNTS.innerA + STAR_COUNTS.innerB + STAR_COUNTS.outerA + STAR_COUNTS.outerB);
    const key = (f: typeof high, i: number) => `${f.position[i * 3].toFixed(3)},${f.position[i * 3 + 1].toFixed(3)}`;
    const all = new Set(Array.from({ length: high.count }, (_, i) => key(high, i)));
    for (let i = 0; i < low.count; i++) expect(all.has(key(low, i))).toBe(true);
    for (let i = 0; i < high.count; i++) expect(high.light[i * 2]).toBeGreaterThan(input.revealT);
  });

  it('レールの点から 3m 以内、殻の面から 0.7m 以内には星を置かない', () => {
    const f = generateStarField({ ...input, scale: 1 });
    const p = new THREE.Vector3();
    for (let i = 0; i < f.count; i++) {
      p.fromArray(f.position, i * 3);
      for (const q of input.path) expect(p.distanceTo(q)).toBeGreaterThanOrEqual(3);
      const d = p.length();
      if (d < 61.5) for (const r of input.shellRadii) expect(Math.abs(d - r)).toBeGreaterThanOrEqual(0.7);
    }
  });
});
