import { describe, expect, it } from 'vitest';
import { VOLUME_CHANNELS, volumeToGain } from './mix';

describe('volume channels', () => {
  it('has master, music, sfx and ambience', () => {
    expect([...VOLUME_CHANNELS].sort()).toEqual(['ambience', 'master', 'music', 'sfx']);
  });
});

describe('volume slider to gain', () => {
  it('is silent at 0 and unity at 1', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBeCloseTo(1, 9);
  });

  it('rises monotonically and tapers so the lower half is usable', () => {
    let prev = -1;
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const g = volumeToGain(v);
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
    // Half the slider should be clearly quieter than half the amplitude (perceptual taper).
    expect(volumeToGain(0.5)).toBeLessThan(0.4);
    expect(volumeToGain(0.5)).toBeGreaterThan(0.1);
  });

  it('clamps out-of-range and invalid values', () => {
    expect(volumeToGain(-1)).toBe(0);
    expect(volumeToGain(2)).toBeCloseTo(1, 9);
    expect(volumeToGain(Number.NaN)).toBe(0);
  });
});
