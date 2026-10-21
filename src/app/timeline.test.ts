// S-24 画面効果と殻を乗車の時刻から決める（親が作成。実装担当は変更しない）
// 柱「時刻から決める」: ?t= で途中から始めても、巻き戻しても、同じ時刻なら同じ絵になる。フレームの積み上げで状態を作らない。
import { describe, expect, it } from 'vitest';
import { CELESTIAL_BLACKOUT_SEC, MOMENT_BARS, SEC_PER_BAR, SECTIONS, TRANSITION_SEC } from '../config';
import { buildCueSheet } from '../ride';
import { fxAt, type FxTimelineOptions } from './timeline';

const cues = buildCueSheet();
const start = (id: string) => SECTIONS.find((s) => s.id === id)!.startBar * SEC_PER_BAR;
const at = (t: number, o: Partial<FxTimelineOptions> = {}) => fxAt(t, cues, { comfort: 'standard', reducedFlash: false, riding: true, ...o });
const MEMBRANES = cues.filter((c) => c.name === 'membrane').map((c) => c.t);
const HIGHLIGHTS = [MOMENT_BARS.greenhouseBloom, MOMENT_BARS.kaleidoscopeFlower, MOMENT_BARS.celestialConstellation, MOMENT_BARS.dawnSunrise].map((b) => b * SEC_PER_BAR);

describe('TRN-3 / TRN-1 / TRN-2 画面効果は乗車の時刻から決まる', () => {
  it('乗車の外では何もしない（殻は開き、明るさは1）', () => {
    expect(at(100, { riding: false })).toMatchObject({ bubble: 0, membrane: 0, brightness: 1, kaleidoscope: 0, bloom: 0 });
  });

  it('同じ時刻なら同じ値（呼ぶ順や回数に依らない）', () => {
    const a = at(437.3);
    at(10);
    at(700);
    expect(at(437.3)).toEqual(a);
  });

  it('泡の殻: 乗車の頭で下から閉じ（2秒）、降車で開く（2秒）', () => {
    expect(at(0.2).bubble).toBe(0);
    expect(at(0.5 + TRANSITION_SEC.boarding + 0.1).bubble).toBeCloseTo(1, 6);
    expect(at(300).bubble).toBeCloseTo(1, 6);
    const open = cues.find((c) => c.name === 'departure.open')!.t;
    expect(at(open - 0.1).bubble).toBeCloseTo(1, 6);
    expect(at(open + TRANSITION_SEC.boarding + 0.1).bubble).toBe(0);
  });

  it('膜: 通る瞬間に 1、前後 0.3 秒（膜の0.6秒）で 0', () => {
    for (const tm of MEMBRANES) {
      expect(at(tm).membrane, `膜 ${tm}`).toBeCloseTo(1, 6);
      expect(at(tm - TRANSITION_SEC.membrane / 2 - 0.01).membrane).toBe(0);
      expect(at(tm + TRANSITION_SEC.membrane / 2 + 0.01).membrane).toBe(0);
      const mid = at(tm + 0.15).membrane;
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
    }
    expect(at(100).membrane).toBe(0);
  });

  it('暗転は天球の頭の2秒だけ（唯一の黒）。点灯は 2.5 秒、光の点滅を抑えるモードではもっとゆっくり', () => {
    const t0 = start('celestial');
    expect(at(t0 - 1).brightness).toBe(1);
    expect(at(t0 + 0.5).brightness).toBe(0);
    expect(at(t0 + CELESTIAL_BLACKOUT_SEC - 0.05).brightness).toBe(0);
    expect(at(t0 + CELESTIAL_BLACKOUT_SEC + 2.6).brightness).toBeCloseTo(1, 6);
    expect(at(t0 + CELESTIAL_BLACKOUT_SEC + 2.6, { reducedFlash: true }).brightness).toBeLessThan(0.9);
    for (let t = 0; t <= 780; t += 0.5) {
      if (t >= t0 && t <= t0 + CELESTIAL_BLACKOUT_SEC + 8) continue;
      expect(at(t).brightness, `t=${t}`).toBe(1);
    }
  });

  it('万華鏡の折り返しは万華鏡の区間だけ。回転は時刻から決まり、穏やかモードでは止まる', () => {
    expect(at(start('kaleidoscope') - 1).kaleidoscope).toBe(0);
    expect(at(start('kaleidoscope') + 20).kaleidoscope).toBeGreaterThan(0.9);
    expect(at(start('celestial') + 1).kaleidoscope).toBe(0);
    const a = at(400).kaleidoscopeAngle;
    const b = at(410).kaleidoscopeAngle;
    expect(b).not.toBe(a);
    expect(at(400, { comfort: 'gentle' }).kaleidoscopeAngle).toBe(at(410, { comfort: 'gentle' }).kaleidoscopeAngle);
  });

  it('ブルームは見どころの前後でだけ強まる（頂点は見どころの時刻、6秒離れれば 0）', () => {
    for (const th of HIGHLIGHTS) {
      expect(at(th).bloom, `見どころ ${th}`).toBeGreaterThan(0.3);
      expect(at(th).bloom).toBeGreaterThanOrEqual(at(th - 2).bloom);
      expect(at(th + 8).bloom).toBe(0);
    }
    expect(at(100).bloom).toBe(0);
    expect(at(HIGHLIGHTS[0], { reducedFlash: true }).bloom).toBeLessThanOrEqual(at(HIGHLIGHTS[0]).bloom);
  });
});
