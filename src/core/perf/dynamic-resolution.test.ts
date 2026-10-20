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
