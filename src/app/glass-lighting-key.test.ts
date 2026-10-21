// S-25 ハイライトの色（実装担当が追加。レビュー P3-8）: 背景の色相からは作らず、暖色の白。緑の温室の朝日が緑にならない
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { glassLightingFor } from './glass-lighting';

const hsl = (c: THREE.ColorRepresentation) => new THREE.Color(c).getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);

describe('ハイライトの色', () => {
  it('どの部屋でも暖色の白（色相が 25〜60°）。緑・青の背景でも変わらない', () => {
    for (const bg of ['#dfe9d8', '#cfe6c8', '#5d6b78', '#0b1030', '#070a1c', '#f3c9a0']) {
      const k = hsl(glassLightingFor({ background: bg, exposure: 1 }).keyColor);
      expect(k.h * 360, bg).toBeGreaterThan(25);
      expect(k.h * 360, bg).toBeLessThan(60);
      expect(k.l, bg).toBeGreaterThan(0.85);
    }
  });

  it('明るい部屋ほど朝日の金色に寄る（暗い部屋は淡い暖色）', () => {
    const day = hsl(glassLightingFor({ background: '#dfe9d8', exposure: 1 }).keyColor);
    const night = hsl(glassLightingFor({ background: '#070a1c', exposure: 1 }).keyColor);
    expect(day.s).toBeGreaterThan(night.s);
  });
});
