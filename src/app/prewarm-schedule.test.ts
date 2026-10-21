// S-29 先読みを始めてよい時刻（実装担当が追加）
import { describe, expect, it } from 'vitest';
import { createRide, generateRideData } from '../ride';
import { SECTION_IDS } from '../contracts/ids';
import { QUIET_AFTER_MEMBRANE_SEC, QUIET_BEFORE_MEMBRANE_SEC, inMembraneQuiet } from './prewarm-schedule';

describe('先読みの静かな間', () => {
  const boundaries = [0, 60, 360, 480];

  it('膜の前後（前 QUIET_BEFORE・後 QUIET_AFTER 秒）は静かにする', () => {
    expect(inMembraneQuiet(60, boundaries)).toBe(true);
    expect(inMembraneQuiet(60 - QUIET_BEFORE_MEMBRANE_SEC, boundaries)).toBe(true);
    expect(inMembraneQuiet(60 + QUIET_AFTER_MEMBRANE_SEC, boundaries)).toBe(true);
    expect(inMembraneQuiet(0, boundaries)).toBe(true);
  });

  it('それ以外は先読みを進めてよい', () => {
    expect(inMembraneQuiet(60 - QUIET_BEFORE_MEMBRANE_SEC - 0.01, boundaries)).toBe(false);
    expect(inMembraneQuiet(60 + QUIET_AFTER_MEMBRANE_SEC + 0.01, boundaries)).toBe(false);
    expect(inMembraneQuiet(200, boundaries)).toBe(false);
  });

  it('次の部屋を描き始める膜の 15 秒前は静かでなく、先読みが終わる時間が残る（部屋の長さに対して静かな間は短い）', () => {
    const ride = createRide(generateRideData());
    const starts = SECTION_IDS.map((id) => ride.sectionTime(id).t0);
    for (const b of starts.slice(1)) expect(inMembraneQuiet(b - 15, starts), `膜 ${b}`).toBe(false);
    // 区間の長さのうち、静かな間は 1 割以下
    for (let i = 0; i < starts.length - 1; i++) {
      const len = starts[i + 1] - starts[i];
      expect((QUIET_BEFORE_MEMBRANE_SEC + QUIET_AFTER_MEMBRANE_SEC) / len, `区間 ${i}`).toBeLessThan(0.25);
    }
  });
});
