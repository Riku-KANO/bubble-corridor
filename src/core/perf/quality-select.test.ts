import { describe, expect, it } from 'vitest';
import { fitsFrameBudget, fitsHeadroom, recommendQuality } from './quality-select';

const constant = (ms: number, n = 300) => Array.from({ length: n }, () => ms);
/** Overload under vsync is jittery; alternate ±3 ms around the mean. */
const jittery = (ms: number, n = 300) => Array.from({ length: n }, (_, i) => ms + (i % 2 === 0 ? 3 : -3));

describe('recommendQuality (GPU timing available)', () => {
  it('picks high when even the calibrated high estimate leaves room', () => {
    const d = recommendQuality(constant(16.7), constant(5), 'mid');
    expect(d.basis).toBe('gpu');
    expect(d.level).toBe('high');
  });

  it('does not pick high from a 10 ms mid measurement (high costs ~1.7× mid, not just more pixels)', () => {
    expect(recommendQuality(constant(16.7), constant(10), 'mid').level).toBe('mid');
  });

  it('keeps mid when high would not fit with headroom but mid does', () => {
    expect(recommendQuality(constant(16.7), constant(11), 'mid').level).toBe('mid');
  });

  it('drops to low when even mid is over budget', () => {
    expect(recommendQuality(constant(25), constant(17), 'mid').level).toBe('low');
  });

  it('estimates cheaper levels as cheaper', () => {
    const d = recommendQuality(constant(16.7), constant(10), 'mid');
    expect(d.estimatedMs?.low).toBeLessThan(d.estimatedMs?.mid ?? 0);
    expect(d.estimatedMs?.mid).toBeLessThan(d.estimatedMs?.high ?? 0);
  });

  it('keeps the measured preset when the frame is CPU-bound, even if the GPU estimate would allow high', () => {
    const d = recommendQuality(constant(30), constant(6), 'mid');
    expect(d.level).toBe('mid');
    expect(d.reason).toMatch(/cpu/i);
  });
});

describe('recommendQuality (frame time only)', () => {
  it('keeps the measured level while holding 60 Hz (vsync hides the headroom)', () => {
    const d = recommendQuality(constant(16.7), [], 'mid');
    expect(d.basis).toBe('frame');
    expect(d.level).toBe('mid');
  });

  it('steps up on a high-refresh display that holds its refresh rate', () => {
    expect(recommendQuality(constant(8.3), [], 'mid').level).toBe('high');
  });

  it('steps down one level when frames run long', () => {
    expect(recommendQuality(jittery(22), [], 'mid').level).toBe('low');
    expect(recommendQuality(jittery(22), [], 'high').level).toBe('mid');
  });

  it('goes straight to low when far over budget', () => {
    expect(recommendQuality(jittery(40), [], 'high').level).toBe('low');
  });

  it('does not read a steady 30 fps cap (power saving) as overload', () => {
    const d = recommendQuality(constant(33.3), [], 'mid');
    expect(d.level).toBe('mid');
    expect(d.reason).toMatch(/capped/);
  });

  it('falls back to the measured level with no samples', () => {
    const d = recommendQuality([], [], 'mid');
    expect(d.level).toBe('mid');
    expect(d.reason).toMatch(/no samples/i);
  });
});

describe('fitsHeadroom', () => {
  it('accepts GPU time within 80% of the 60 fps frame and rejects more', () => {
    expect(fitsHeadroom(constant(12))).toBe(true);
    expect(fitsHeadroom(constant(15))).toBe(false);
  });

  it('is unknown, not a pass, without samples', () => {
    expect(fitsHeadroom([])).toBeNull();
  });
});

describe('fitsFrameBudget', () => {
  it('fails when frames miss vsync with jitter', () => {
    expect(fitsFrameBudget(Array.from({ length: 120 }, (_, i) => (i % 2 ? 33.3 : 16.7)))).toBe(false);
  });

  it('passes at 60 Hz and on a steady frame-rate cap', () => {
    expect(fitsFrameBudget(constant(16.7))).toBe(true);
    expect(fitsFrameBudget(constant(33.3))).toBe(true);
  });

  it('is unknown without samples', () => {
    expect(fitsFrameBudget([])).toBeNull();
  });
});
