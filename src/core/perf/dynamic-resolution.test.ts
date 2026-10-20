import { describe, expect, it } from 'vitest';
import { DynamicResolution } from './dynamic-resolution';

const TARGET = 1000 / 60;
const DT = 1 / 60;

/** Feeds `seconds` of GPU samples; cost may depend on the current scale. Returns the number of scale changes. */
function run(dr: DynamicResolution, cost: number | ((scale: number) => number), seconds: number): number {
  let changes = 0;
  for (let t = 0; t < seconds; t += DT) {
    const c = typeof cost === 'number' ? cost : cost(dr.scale);
    if (dr.update(c, DT) !== null) changes++;
  }
  return changes;
}

/** GPU-bound cost that scales with pixel count. */
const pixelBound =
  (msAtMax: number, max = 0.85) =>
  (scale: number) =>
    msAtMax * (scale / max) ** 2;

describe('DynamicResolution', () => {
  it('starts at the preset maximum', () => {
    expect(new DynamicResolution({ min: 0.5, max: 0.85 }).scale).toBe(0.85);
  });

  it('waits one cooldown before the first change (startup hitches, shader compiles)', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    expect(run(dr, TARGET * 3, 0.5)).toBe(0);
  });

  it('lowers the scale under sustained overload, never below min', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, TARGET * 1.5, 2.5);
    expect(dr.scale).toBeLessThan(0.85);
    run(dr, TARGET * 3, 30);
    expect(dr.scale).toBe(0.5);
  });

  it('raises the scale again when the GPU has room, never above max', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, TARGET * 3, 30);
    run(dr, TARGET * 0.4, 40);
    expect(dr.scale).toBe(0.85);
  });

  it('settles where the cost fits instead of hunting', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, pixelBound(TARGET * 1.2), 20);
    const settled = dr.scale;
    expect(settled).toBeLessThan(0.85);
    expect(run(dr, pixelBound(TARGET * 1.2), 30)).toBe(0);
    expect(dr.scale).toBe(settled);
  });

  it('ignores one or two spikes', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, TARGET * 0.5, 2);
    dr.update(200, DT);
    dr.update(200, DT);
    expect(run(dr, TARGET * 0.5, 0.5)).toBe(0);
    expect(dr.scale).toBe(0.85);
  });

  it('waits a cooldown between changes so render targets are not reallocated every frame', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 1, cooldownSec: 1 });
    expect(run(dr, TARGET * 3, 1.9)).toBeLessThanOrEqual(1);
  });

  it('backs off instead of oscillating at a boundary', () => {
    // Over the threshold above 0.8, comfortable at or below it.
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    const boundary = (s: number) => (s > 0.8 ? TARGET * 0.85 : TARGET * 0.5);
    const first = run(dr, boundary, 30);
    const second = run(dr, boundary, 30);
    expect(first + second).toBeLessThanOrEqual(10);
    expect(second).toBeLessThanOrEqual(3);
  });

  it('forgets the backoff after a long calm period (one heavy room does not slow it forever)', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, (s) => (s > 0.8 ? TARGET * 0.85 : TARGET * 0.5), 60);
    run(dr, TARGET * 0.65, 40); // calm, inside the band
    expect(run(dr, TARGET * 2, 2.5)).toBeGreaterThan(0);
    run(dr, TARGET * 0.65, 1.5); // let the smoothed cost settle inside the band
    // After the calm period a raise happens after the base delay again, not after a multiplied one.
    const before = dr.scale;
    run(dr, TARGET * 0.4, 3.5);
    expect(dr.scale).toBeGreaterThan(before);
  });
});

describe('DynamicResolution with requireResponse (S-08)', () => {
  it('keeps stepping down while the GPU time follows the resolution', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85, requireResponse: true });
    run(dr, pixelBound(TARGET * 1.5), 20);
    expect(dr.unresponsive).toBe(false);
    expect(dr.scale).toBeLessThan(0.7);
  });

  it('gives up after three steps down that do not lower the smoothed GPU time by a tenth', () => {
    // E.g. the GPU clocks down as the load drops, or the frame is bound by work that does not scale with pixels.
    const dr = new DynamicResolution({ min: 0.5, max: 0.85, requireResponse: true });
    run(dr, TARGET * 1.5, 20);
    expect(dr.unresponsive).toBe(true);
    expect(dr.scale).toBe(0.7);
    expect(run(dr, TARGET * 3, 10)).toBe(0);
  });

  it('judges each run of steps on its own: a calm period in between starts a new run', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85, requireResponse: true });
    run(dr, TARGET * 1.5, 2.5); // two steps down
    run(dr, TARGET * 0.7, 10); // inside the band: no change
    run(dr, TARGET * 1.5, 2.5); // three more steps: a separate run, so no fourth one to judge yet
    expect(dr.unresponsive).toBe(false);
    expect(dr.scale).toBe(0.6);
  });

  // The smoothed cost lags behind a load that rises mid-session (median of 5, then EMA): it is still climbing after
  // the first step down, so it must not be the yardstick for the response (S-08 review round 2, P1).
  it.each([
    [0.5, 1.5],
    [0.7, 1.3],
    [0.7, 2],
    [0.75, 1.2],
  ])(
    'keeps stepping down when an overload that follows the pixels starts mid-session (%s T → %s T)',
    (from, to) => {
      const dr = new DynamicResolution({ min: 0.5, max: 0.85, requireResponse: true });
      run(dr, pixelBound(TARGET * from), 5);
      run(dr, pixelBound(TARGET * to), 20);
      expect(dr.unresponsive).toBe(false);
      expect(dr.scale).toBeLessThan(0.75);
    },
  );

  it('keeps stepping down under an extreme overload that follows the pixels (above the spike clamp)', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85, requireResponse: true });
    run(dr, pixelBound(TARGET * 6), 20);
    expect(dr.unresponsive).toBe(false);
    expect(dr.scale).toBe(0.5);
  });

  it('keeps stepping down when part of the cost is fixed (8 ms fixed + 12 ms that follows the pixels)', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85, requireResponse: true });
    run(dr, TARGET * 0.5, 5);
    run(dr, (s) => 8 + 12 * (s / 0.85) ** 2, 20);
    expect(dr.unresponsive).toBe(false);
    expect(dr.scale).toBeLessThan(0.7);
  });

  it('still gives up on a constant cost that starts mid-session, or a noisy constant cost', () => {
    const late = new DynamicResolution({ min: 0.5, max: 0.85, requireResponse: true });
    run(late, TARGET * 0.5, 5);
    run(late, 25, 20);
    expect(late.unresponsive).toBe(true);
    const noisy = new DynamicResolution({ min: 0.5, max: 0.85, requireResponse: true });
    let i = 0;
    run(noisy, () => 20 + ((i++ * 7919) % 11) - 5, 20); // 15–25 ms, deterministic
    expect(noisy.unresponsive).toBe(true);
  });
});
