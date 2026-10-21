// 扉が変わったときの金と青の混ぜ（rooms-b の実装担当のテスト。レビュー2巡目 P1 (b)）
// 膜の 15 秒前から見えている万華鏡の色を一瞬で入れ替えず、扉が変わった時刻から約 0.8 秒かけて混ぜる。
// 混ぜは時刻から決まる（フレームの刻み方に依らない。途中から始めると、もう混ぜ終わった色）。
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { backgroundHsl, loadRoom } from '../testing';
import { createKaleidoscopeRoom } from './index';

/** 鏡の板の色（焼き込んだ材質）と、膜の向こうから見える部屋の空気の色相 */
async function colorsAt(steps: number, change: number, at: number) {
  const h = await loadRoom(createKaleidoscopeRoom);
  h.room.setDoor?.('lapis');
  const dt = (at - (change - 2)) / steps;
  let t = change - 2;
  for (; t < change - 1e-9; t += dt) h.frame(t, dt);
  h.frame(change, dt);
  h.room.setDoor?.('amber');
  for (t = change; t < at - 1e-9; ) {
    t = Math.min(at, t + dt);
    h.frame(t, dt);
  }
  let panel: THREE.Color | null = null;
  h.room.root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!panel && o.userData.look === 'mirror' && m?.color) panel = m.color.clone();
  });
  return { panel: panel as THREE.Color | null, hue: backgroundHsl(h.room).h };
}

describe('扉が変わったときの万華鏡の色', () => {
  it('一瞬で入れ替えず、約 0.8 秒かけて混ぜる', async () => {
    const start = await colorsAt(20, 352, 352);
    const mid = await colorsAt(20, 352, 352.4);
    const end = await colorsAt(20, 352, 353);
    expect(start.panel && mid.panel && end.panel).toBeTruthy();
    const d = (a: THREE.Color, b: THREE.Color) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    expect(d(mid.panel!, start.panel!)).toBeGreaterThan(0.01);
    expect(d(mid.panel!, end.panel!)).toBeGreaterThan(0.01);
    expect(end.hue).toBeGreaterThanOrEqual(20);
    expect(end.hue).toBeLessThanOrEqual(60);
  });

  it('混ぜは時刻から決まる（刻み方を変えても同じ色）', async () => {
    const fine = await colorsAt(80, 352, 352.4);
    const coarse = await colorsAt(4, 352, 352.4);
    expect(fine.panel!.getHex()).toBe(coarse.panel!.getHex());
    expect(fine.hue).toBeCloseTo(coarse.hue, 6);
  });

  it('途中から始めた（フレームの前に扉が来た）ときは、すぐに今の扉の色', async () => {
    const h = await loadRoom(createKaleidoscopeRoom);
    h.room.setDoor?.('amber');
    h.frame(400, 1 / 60);
    const hue = backgroundHsl(h.room).h;
    expect(hue).toBeGreaterThanOrEqual(20);
    expect(hue).toBeLessThanOrEqual(60);
  });
});
