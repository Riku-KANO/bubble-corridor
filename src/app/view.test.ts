// S-29 縦持ちでは視野角を広げる（設計書「縦持ちでは視野角を広げ」。親が作成。実装担当は変更しない）
// 75° のままでは、縦持ちの左右が狭く（水平の半角 約17°）、5:51 の扉や 2:40 の花が画面の端で切れる（S-21・S-20 の報告）。
import { describe, expect, it } from 'vitest';
import { verticalFovFor } from './view';

const hHalf = (vfov: number, aspect: number) => (Math.atan(Math.tan((vfov * Math.PI) / 360) * aspect) * 180) / Math.PI;

describe('縦持ちの視野角', () => {
  it('横長（16:9 など）では設定の視野角のまま', () => {
    expect(verticalFovFor(16 / 9, 75)).toBe(75);
    expect(verticalFovFor(4 / 3, 75)).toBe(75);
    expect(verticalFovFor(16 / 9, 90)).toBe(90);
  });

  it('縦持ち（390×844 など）では広げ、左右の半角が 24° 以上になる', () => {
    const a = 390 / 844;
    const v = verticalFovFor(a, 75);
    expect(v).toBeGreaterThan(75);
    expect(hHalf(v, a)).toBeGreaterThanOrEqual(24);
  });

  it('広げすぎない（縦の視野角は 110° 以下。魚眼のような歪みと酔いを避ける）', () => {
    for (const a of [0.3, 0.4, 0.46, 0.56, 0.75, 1]) expect(verticalFovFor(a, 75), `aspect=${a}`).toBeLessThanOrEqual(110);
  });

  it('縦横の比が変わっても、視野角は連続して変わる（回転の途中で跳ばない）', () => {
    let prev = verticalFovFor(0.3, 75);
    for (let a = 0.31; a <= 2; a += 0.01) {
      const v = verticalFovFor(a, 75);
      expect(Math.abs(v - prev), `aspect=${a.toFixed(2)}`).toBeLessThan(2);
      prev = v;
    }
  });
});
