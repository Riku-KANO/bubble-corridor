// 花の模様の動き（rooms-b の実装担当のテスト。RIDE-8 を見どころの間も守る、時刻だけで決まる）
import { describe, expect, it } from 'vitest';
import { MOMENT_BARS, SEC_PER_BAR } from '../../config';
import { clearanceViolations, loadRoom } from '../testing';
import { MIN_RADIUS, flowerSlot, gatherAt, lerpCyl } from './flower';
import { createKaleidoscopeRoom } from './index';

const FLOWER = MOMENT_BARS.kaleidoscopeFlower * SEC_PER_BAR;
const TIMING = { flowerT: FLOWER, gatherSec: 8, releaseT: FLOWER + 21, releaseSec: 12 };

describe('万華鏡の花', () => {
  it('集まり具合は 0（家）→ 1（花）→ 0（家）で、時刻だけで決まる', () => {
    expect(gatherAt(FLOWER - 9, TIMING, 3)).toBe(0);
    expect(gatherAt(FLOWER + 0.01, TIMING, 3)).toBe(1);
    expect(gatherAt(FLOWER + 40, TIMING, 3)).toBe(0);
    expect(gatherAt(FLOWER - 3, TIMING, 7)).toBe(gatherAt(FLOWER - 3, TIMING, 7));
  });

  it('花の位置は軸から MIN_RADIUS 以上、補間の途中も下回らない', () => {
    const out = { s: 0, ang: 0, rad: 0 };
    for (let i = 0; i < 240; i++) {
      const slot = flowerSlot(i, 240);
      expect(slot.rad).toBeGreaterThanOrEqual(MIN_RADIUS);
      for (let g = 0; g <= 1; g += 0.1) {
        lerpCyl({ s: 0, ang: 3, rad: 2.5 }, { s: 5, ang: slot.ang, rad: slot.rad }, g, out);
        expect(out.rad).toBeGreaterThanOrEqual(MIN_RADIUS);
      }
    }
  });

  it('RIDE-8 花が集まる・咲く・ほどける間も、物はゴンドラの表面から 0.5m 以上', async () => {
    for (const t of [FLOWER - 5, FLOWER, FLOWER + 12, FLOWER + 18, FLOWER + 26]) {
      const h = await loadRoom(createKaleidoscopeRoom);
      h.frame(t, 1 / 60);
      expect(clearanceViolations(h.room, ['kaleidoscope'], 2).slice(0, 3), `t=${t}`).toEqual([]);
    }
  });
});
