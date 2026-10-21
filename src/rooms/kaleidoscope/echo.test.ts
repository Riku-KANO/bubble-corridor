// 色のこだまの光の回数（rooms-b の実装担当のテスト。レビュー1巡目 P1-2: 光の明滅は 1 秒に 3 回未満、拍の頭にそろえる）
import { describe, expect, it } from 'vitest';
import { SEC_PER_BEAT } from '../../config';
import { echoArrival, echoAt, echoFlash, echoGrid, type Echo, type EchoState } from './echo';

/** 区間 [t0, t1] で、ロゼットの光が新しく灯った回数 */
function flashes(echoes: readonly Echo[], rosetteS: number, t0: number, t1: number, grid: number): number {
  const st: EchoState = { arrival: -Infinity, color: -1 };
  let last = -Infinity;
  let n = 0;
  for (let t = t0; t <= t1; t += 1 / 120) {
    echoAt(echoes, rosetteS, t, grid, st);
    if (st.arrival > last) {
      n++;
      last = st.arrival;
    }
  }
  return n;
}

describe('色のこだま', () => {
  it('届く時刻は拍の頭', () => {
    const grid = echoGrid(SEC_PER_BEAT, false);
    for (const t of [400.01, 400.4, 401.7]) {
      const at = echoArrival(t, 5, grid);
      expect(at).toBeGreaterThan(t);
      expect(Math.abs(at / grid - Math.round(at / grid))).toBeLessThan(1e-9);
    }
  });

  it('続けて触れても、1 つのロゼットの光は 1 拍に 1 回まで（72BPM で 1 秒に 1.2 回）。抑えるモードは半分', () => {
    // 0.3 秒ごと（触れ直しの最短）に、いろいろな位置のガラス片に触れ続ける
    const echoes: Echo[] = [];
    for (let i = 0; i < 40; i++) echoes.push({ t: 400 + i * 0.3, s: 360 + ((i * 7) % 50), color: i });
    const std = flashes(echoes, 380, 401, 411, echoGrid(SEC_PER_BEAT, false));
    const red = flashes(echoes, 380, 401, 411, echoGrid(SEC_PER_BEAT, true));
    expect(std / 10).toBeLessThanOrEqual(1 / SEC_PER_BEAT + 0.11);
    expect(std / 10).toBeLessThan(3);
    expect(red).toBeLessThanOrEqual(Math.ceil(std / 2) + 1);
  });

  it('同じ拍に届いたこだまは、最後に触れた色の 1 回の光', () => {
    const grid = echoGrid(SEC_PER_BEAT, false);
    const echoes: Echo[] = [
      { t: 400.05, s: 380, color: 1 },
      { t: 400.3, s: 380, color: 2 },
    ];
    const st: EchoState = { arrival: -Infinity, color: -1 };
    echoAt(echoes, 380, 403, grid, st);
    expect(st.color).toBe(2);
    expect(flashes(echoes, 380, 400, 403, grid)).toBe(1);
  });

  it('光は時刻だけで決まり、届く前は 0', () => {
    expect(echoFlash(10, 11)).toBe(0);
    expect(echoFlash(11, 11)).toBe(1);
    expect(echoFlash(11.5, 11)).toBeLessThan(0.3);
    expect(echoFlash(5, -Infinity)).toBe(0);
  });
});
