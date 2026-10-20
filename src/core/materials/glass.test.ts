// S-12 CORE-3 ガラスの材質ライブラリ（親が作成。実装担当は変更しない）
// 見た目（3経路で同じ印象か）は dev/core.html と snap で人と reviewer が確かめる。ここは契約と設計の決まりだけ。
import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { createBrass, createGlass, type GlassKind } from './glass';

const KINDS: GlassKind[] = ['clear', 'frosted', 'tinted', 'iridescent', 'milky', 'mirror'];
type Mat = THREE.Material & { isNodeMaterial?: boolean; roughness?: number; metalness?: number; transmission?: number; opacity: number };

describe('CORE-3 ガラスの材質', () => {
  it('6種すべてが NodeMaterial（WebGPU・WebGL2・VR で同じ部品）', () => {
    for (const k of KINDS) {
      const g = createGlass(k);
      expect((g.material as Mat).isNodeMaterial, k).toBe(true);
    }
  });

  it('透過（transmission）を使わない（重く、重なると破綻する）', () => {
    for (const k of KINDS) for (const tier of ['low', 'medium', 'high'] as const) {
      const m = createGlass(k, {}, { tier }).material as Mat;
      expect(m.transmission ?? 0, `${k}/${tier}`).toBe(0);
    }
  });

  it('鏡以外は半透明で、奥のガラスを隠さないよう深度を書かない', () => {
    for (const k of KINDS.filter((x) => x !== 'mirror')) {
      const m = createGlass(k).material;
      expect(m.transparent, k).toBe(true);
      expect(m.depthWrite, k).toBe(false);
    }
  });

  it('種類の性格: 曇りは透明より粗い、乳白は透明より不透明、鏡は金属', () => {
    const clear = createGlass('clear').material as Mat;
    const frosted = createGlass('frosted').material as Mat;
    const milky = createGlass('milky').material as Mat;
    const mirror = createGlass('mirror').material as Mat;
    expect(frosted.roughness!).toBeGreaterThan(clear.roughness!);
    expect(milky.opacity).toBeGreaterThan(clear.opacity);
    expect(mirror.metalness!).toBeGreaterThanOrEqual(0.9);
  });

  it('引数の色・不透明度・両面が反映される', () => {
    const m = createGlass('tinted', { color: 0x00ff00, opacity: 0.6, doubleSided: true }).material as Mat & { color: THREE.Color };
    expect(m.opacity).toBeCloseTo(0.6, 6);
    expect(m.side).toBe(THREE.DoubleSide);
    expect(m.color.getHex()).toBe(0x00ff00);
  });

  it('縁の光・波紋・時刻のつまみは例外を出さず、範囲外の値も受ける', () => {
    for (const k of KINDS) {
      const g = createGlass(k);
      expect(() => {
        g.setHighlight(0);
        g.setHighlight(1);
        g.setHighlight(2);
        g.setHighlight(-1);
        g.pulse(10);
        g.setTime(12.5);
      }, k).not.toThrow();
    }
  });

  it('dispose で材質を解放する', () => {
    const g = createGlass('iridescent');
    const spy = vi.spyOn(g.material, 'dispose');
    g.dispose();
    expect(spy).toHaveBeenCalled();
  });

  it('真鍮は金属', () => {
    const b = createBrass() as Mat;
    expect(b.isNodeMaterial).toBe(true);
    expect(b.metalness).toBe(1);
  });
});
