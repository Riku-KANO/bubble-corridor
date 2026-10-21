// 夜明けの時間割（純粋な計算）の確かめ。部屋の振る舞いは room.test.ts（親が作成）が見る。
import { describe, expect, it } from 'vitest';
import { MOMENT_BARS, SEC_PER_BAR } from '../../config';
import { SUN_RADIUS_DEG, createDawnState, dawnAt, sunElevationDeg } from './sky';

const SUNRISE = MOMENT_BARS.dawnSunrise * SEC_PER_BAR;

describe('夜明けの時間割', () => {
  it('朝日は見どころ（11:50）の直前まで水平線の下にあり、11:50 に縁が出て、その後は昇り続ける', () => {
    expect(sunElevationDeg(SUNRISE - 2, SUNRISE) + SUN_RADIUS_DEG).toBeLessThan(0);
    expect(sunElevationDeg(SUNRISE, SUNRISE) + SUN_RADIUS_DEG).toBeGreaterThan(0);
    let prev = -Infinity;
    for (let t = SUNRISE - 50; t <= SUNRISE + 40; t += 0.5) {
      const e = sunElevationDeg(t, SUNRISE);
      expect(e).toBeGreaterThan(prev);
      prev = e;
    }
  });

  it('砂のきらめきは朝日の瞬間に一斉に強まり、光の点滅を抑えるモードでは控えめでゆっくり', () => {
    const s = createDawnState();
    expect(dawnAt(SUNRISE - 3, SUNRISE, false, s).sparkle).toBe(0);
    expect(dawnAt(SUNRISE + 0.6, SUNRISE, false, s).sparkle).toBeGreaterThan(0.9);
    const reduced = dawnAt(SUNRISE + 0.6, SUNRISE, true, s).sparkle;
    expect(reduced).toBeLessThan(0.3);
    expect(dawnAt(SUNRISE + 6, SUNRISE, true, s).sparkle).toBeLessThanOrEqual(0.45);
  });

  it('朝日の直前は少し暗く、昇ると明るく（明るさの差で驚きを作る）。標柱の灯は朝になると消える', () => {
    const s = createDawnState();
    const before = dawnAt(SUNRISE - 30, SUNRISE, false, s).exposure;
    const dip = dawnAt(SUNRISE - 2, SUNRISE, false, s).exposure;
    const after = dawnAt(SUNRISE + 10, SUNRISE, false, s).exposure;
    expect(dip).toBeLessThan(before);
    expect(after).toBeGreaterThan(before);
    expect(dawnAt(SUNRISE - 20, SUNRISE, false, s).lamps).toBe(1);
    expect(dawnAt(SUNRISE + 20, SUNRISE, false, s).lamps).toBe(0);
  });

  it('同じ時刻なら同じ光（時刻から決める）', () => {
    const a = dawnAt(SUNRISE + 3.3, SUNRISE, false, createDawnState());
    const b = dawnAt(SUNRISE + 3.3, SUNRISE, false, createDawnState());
    expect(a.background.getHex()).toBe(b.background.getHex());
    expect(a.sunElevationDeg).toBe(b.sunElevationDeg);
  });
});
