// S-26 真鍮の縁は暗い部屋でも見える（親が作成。実装担当は変更しない）
// 真鍮（createBrass）は動く光源を持たず、共有の擬似照明（空・地面の色）を映して光る。暗い部屋（入口・乗り場・万華鏡・天球）では
// 空と地面が暗く、ゴンドラの縁がほぼ消える。縁は「視界の下側に常に見える動かない基準」（設計書 147 行、ADR-0012 の VR の暗転）なので、
// 部屋の照明とは別の明るさの下限を持たせる。brassGlow は、座席から見下ろす縁の上の面（主に空を映す）の発光の色（線形）を、
// シェーダと同じ式で CPU で求めるもの（確認と調整のため。シェーダの値と一致させること）。
import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { brassGlow, resetGlassLighting, setGlassLighting } from './glass';

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

afterEach(() => resetGlassLighting());

describe('CORE-3 / CAM-3 真鍮の縁の明るさの下限', () => {
  it('既定（夜明け）の照明で、真鍮の暖かい色に光る', () => {
    resetGlassLighting();
    const c = brassGlow();
    expect(lum(c)).toBeGreaterThan(0);
    expect(c.r).toBeGreaterThan(c.g);
    expect(c.g).toBeGreaterThan(c.b);
  });

  it('暗い部屋（夜の天球・万華鏡・夜明け前の入口）でも、既定の6割以上の明るさで光る', () => {
    resetGlassLighting();
    const base = lum(brassGlow());
    for (const [sky, ground] of [
      ['#5c6fd1', '#7d5430'], // 天球（S-25 の空気から作った値）
      ['#1a2040', '#100c08'], // さらに暗い夜
      ['#000000', '#000000'], // 真っ暗（暗転の前後）
    ] as const) {
      setGlassLighting({ sky, ground });
      expect(lum(brassGlow()), `${sky} / ${ground}`).toBeGreaterThanOrEqual(base * 0.6);
    }
  });

  it('明るい部屋では照明を映して明るくなるが、白く飛ばない（既定の 1.6 倍まで）', () => {
    resetGlassLighting();
    const base = lum(brassGlow());
    setGlassLighting({ sky: '#ffffff', ground: '#fff2dc' });
    const bright = lum(brassGlow());
    expect(bright).toBeGreaterThan(base);
    expect(bright).toBeLessThanOrEqual(base * 1.6);
  });

  it('引数で照明を渡しても求められる（共有の値は変えない）', () => {
    resetGlassLighting();
    const before = brassGlow();
    const dark = brassGlow({ sky: '#000000', ground: '#000000' });
    expect(lum(dark)).toBeGreaterThan(0);
    expect(brassGlow().equals(before)).toBe(true);
  });
});
