import { describe, expect, it } from 'vitest';
import { checkBudget, percentile, summarizeFrameTimes, summarizeGpuTimes } from './bench';

describe('summarizeFrameTimes', () => {
  it('returns zeros for no frames', () => {
    expect(summarizeFrameTimes([]).frames).toBe(0);
    expect(summarizeFrameTimes([]).avgFps).toBe(0);
  });

  it('computes fps from the mean frame time', () => {
    const s = summarizeFrameTimes(Array(60).fill(1000 / 60));
    expect(s.frames).toBe(60);
    expect(s.avgFps).toBeCloseTo(60, 5);
    expect(s.p95Ms).toBeCloseTo(16.667, 2);
  });

  it('exposes spikes in p99 and max without hiding them in the average', () => {
    const times = [...Array(99).fill(16), 100];
    const s = summarizeFrameTimes(times);
    expect(s.p50Ms).toBe(16);
    expect(s.p99Ms).toBe(16);
    expect(s.maxMs).toBe(100);
    expect(s.avgMs).toBeCloseTo(16.84, 2);
  });

  it('ignores non-finite and non-positive samples', () => {
    expect(summarizeFrameTimes([16, Number.NaN, 0, -1, Number.POSITIVE_INFINITY]).frames).toBe(1);
  });
});

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('checkBudget', () => {
  it('flags draw calls and triangles over the design-doc budget', () => {
    expect(checkBudget({ drawCalls: 300, triangles: 1_500_000 })).toEqual([]);
    expect(checkBudget({ drawCalls: 301, triangles: 2_000_000 }).map((v) => v.metric)).toEqual([
      'drawCalls',
      'triangles',
    ]);
  });
});

describe('summarizeGpuTimes', () => {
  it('counts samples rather than frames and has no fps', () => {
    const g = summarizeGpuTimes([2, 4, 6]);
    expect(g?.samples).toBe(3);
    expect(g?.avgMs).toBe(4);
    expect(g && 'avgFps' in g).toBe(false);
    expect(summarizeGpuTimes([])).toBeNull();
  });
});
