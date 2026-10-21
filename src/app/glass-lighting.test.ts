// S-25 部屋ごとのガラスの擬似照明（親が作成。実装担当は変更しない）
// ガラス（src/core/materials/glass.ts）は動く光源を持たず、setGlassLighting の共有の値で縁の反射とハイライトを作る。
// 既定は夜明けの光なので、部屋の空気（Atmosphere）から部屋ごとの値を作る。部屋が atmosphere.glassLighting で指定すれば、それを優先する。
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Atmosphere } from '../contracts/room';
import { glassLightingFor } from './glass-lighting';

const hsl = (c: THREE.ColorRepresentation) => new THREE.Color(c).getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
const atm = (background: THREE.ColorRepresentation, extra: Partial<Atmosphere> = {}): Atmosphere => ({ background, exposure: 1, ...extra });

describe('部屋ごとのガラスの擬似照明', () => {
  it('すべての項目を返す（部屋が指定しない項目は空気から作る）', () => {
    const l = glassLightingFor(atm('#cfe6c8'));
    expect(Object.keys(l).sort()).toEqual(['envReflection', 'ground', 'keyColor', 'keyDir', 'keyIntensity', 'sky']);
    expect(Number.isFinite(l.keyIntensity)).toBe(true);
  });

  it('空は地面より明るく、空気の色の系統を引き継ぐ', () => {
    for (const bg of ['#cfe6c8', '#5d6f86', '#0b1030', '#f2c9a0']) {
      const l = glassLightingFor(atm(bg));
      expect(hsl(l.sky).l, bg).toBeGreaterThan(hsl(l.ground).l);
    }
    const green = glassLightingFor(atm('#9fd39a'));
    expect(Math.abs(hsl(green.sky).h - hsl('#9fd39a').h) * 360).toBeLessThan(40);
  });

  it('地面は空気の色と琥珀の間で作り、緑を通らない（雨の灰青の地面が緑がかった灰にならない。レビュー1巡目 P2-1）', () => {
    for (const bg of ['#5d6b78', '#5d6f86', '#6a7480', '#3c4a5a', '#2a3340']) {
      const g = hsl(glassLightingFor(atm(bg)).ground);
      const hue = g.h * 360;
      expect(hue < 70 || hue > 180 || g.s < 0.08, `${bg} の地面の色相 ${hue.toFixed(0)}°`).toBe(true);
    }
  });

  it('地面は空より暗い（線形の輝度で。暗い部屋でも）', () => {
    const lum = (c: THREE.ColorRepresentation) => {
      const x = new THREE.Color(c);
      return 0.2126 * x.r + 0.7152 * x.g + 0.0722 * x.b;
    };
    for (const bg of ['#cfe6c8', '#5d6b78', '#0b1030', '#070a1c', '#1a1030', '#f2c9a0']) {
      const l = glassLightingFor(atm(bg));
      expect(lum(l.ground), bg).toBeLessThan(lum(l.sky));
    }
  });

  it('夜（暗い空気）ではハイライトを弱く、明るい部屋では強く', () => {
    const night = glassLightingFor(atm('#070a1c'));
    const day = glassLightingFor(atm('#dfeee0'));
    expect(night.keyIntensity).toBeLessThan(day.keyIntensity);
    expect(night.keyIntensity).toBeLessThanOrEqual(0.4);
    expect(day.keyIntensity).toBeGreaterThan(0.5);
  });

  it('部屋の指定（atmosphere.glassLighting）は、空気から作った値より優先する', () => {
    const keyDir = { x: -1, y: 0.2, z: 0 };
    const l = glassLightingFor(atm('#dfeee0', { glassLighting: { keyColor: '#ffd9a0', keyDir, keyIntensity: 1.4 } }));
    expect(new THREE.Color(l.keyColor).getHexString()).toBe('ffd9a0');
    expect(l.keyIntensity).toBe(1.4);
    expect(l.keyDir.x).toBeCloseTo(-1, 6);
  });

  it('環境画像がある部屋は擬似反射を弱める', () => {
    expect(glassLightingFor(atm('#dfeee0')).envReflection).toBe(1);
    expect(glassLightingFor(atm('#dfeee0', { environment: new THREE.Texture() })).envReflection).toBeLessThan(1);
  });

  it('同じ空気（同じ参照）なら同じ値のオブジェクトを返す（部屋の空気が変わったときだけ作る）', () => {
    const a = atm('#5d6f86');
    expect(glassLightingFor(a)).toBe(glassLightingFor(a));
  });
});
