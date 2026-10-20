// S-16 画面効果（親が作成。実装担当は変更しない）
// 描画（RenderPipeline と TSL）は dev/fx.html と snap で確かめる。ここは状態 → 効果の強さの決まりだけ。
import { describe, expect, it } from 'vitest';
import type { ScreenFxState } from '../contracts/fx';
import { resolveFx } from './index';

const base: ScreenFxState = { bubble: 0, membrane: 0, kaleidoscope: 0, kaleidoscopeAngle: 0, bloom: 0, whiteFog: 0, brightness: 1 };
const fx = (s: Partial<ScreenFxState>, reducedFlash = false) => resolveFx({ ...base, ...s }, { reducedFlash });

describe('TRN-1 / TRN-2 画面効果の強さ', () => {
  it('何もない状態では素通し（すべて 0）', () => {
    const p = fx({});
    for (const [k, v] of Object.entries(p)) expect(v, k).toBe(0);
  });

  it('泡越しの縁はかすかに（0 より大きく 0.5 以下）', () => {
    const p = fx({ bubble: 1 });
    expect(p.edge).toBeGreaterThan(0);
    expect(p.edge).toBeLessThanOrEqual(0.5);
    expect(fx({ bubble: 0.5 }).edge).toBeLessThan(p.edge);
  });

  it('膜の通過: 縞と歪みは通過の強さとともに増える', () => {
    const half = fx({ membrane: 0.5 });
    const full = fx({ membrane: 1 });
    expect(full.stripes).toBeGreaterThanOrEqual(0.6);
    expect(full.distortion).toBeGreaterThan(0);
    expect(half.stripes).toBeGreaterThan(0);
    expect(half.stripes).toBeLessThan(full.stripes);
    expect(half.distortion).toBeLessThan(full.distortion);
  });

  it('色収差は膜を通る瞬間にだけ強める', () => {
    expect(fx({ membrane: 1 }).aberration).toBeGreaterThan(0);
    expect(fx({ bubble: 1, kaleidoscope: 1, bloom: 1 }).aberration).toBe(0);
  });

  it('光の点滅を抑えるモードでは、縞とブルームを半分以下にする', () => {
    const n = fx({ membrane: 1, bloom: 1 });
    const r = fx({ membrane: 1, bloom: 1 }, true);
    expect(r.stripes).toBeLessThanOrEqual(n.stripes * 0.5);
    expect(r.bloom).toBeLessThanOrEqual(n.bloom * 0.5);
    expect(n.bloom).toBeGreaterThan(0);
  });

  it('黒い画面は明るさ（天球の暗転）でしか作らない', () => {
    expect(fx({ brightness: 0 }).darkness).toBe(1);
    expect(fx({ brightness: 0.25 }).darkness).toBeCloseTo(0.75, 6);
    for (const s of [{ membrane: 1 }, { bubble: 1 }, { kaleidoscope: 1 }, { bloom: 1 }, { whiteFog: 1 }] as Partial<ScreenFxState>[]) {
      expect(fx(s).darkness).toBe(0);
    }
  });

  it('白い霧（VR への切り替え）はそのまま', () => {
    expect(fx({ whiteFog: 0.7 }).white).toBeCloseTo(0.7, 6);
  });

  it('万華鏡の折り返しと回転はそのまま渡す', () => {
    const p = fx({ kaleidoscope: 0.8, kaleidoscopeAngle: 1.3 });
    expect(p.fold).toBeCloseTo(0.8, 6);
    expect(p.foldAngle).toBeCloseTo(1.3, 6);
  });

  it('値は 0〜1 に収める（範囲外の入力でも）', () => {
    const p = fx({ bubble: 3, membrane: -1, bloom: 9, whiteFog: 2, brightness: -2, kaleidoscope: 5 });
    for (const [k, v] of Object.entries(p)) {
      if (k === 'foldAngle') continue;
      expect(v, k).toBeGreaterThanOrEqual(0);
      expect(v, k).toBeLessThanOrEqual(1);
    }
  });
});
