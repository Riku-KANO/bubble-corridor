import { describe, expect, it } from 'vitest';
import {
  hzToMidi,
  isInScale,
  MAJOR_PENTATONIC,
  makeScale,
  midiToHz,
  noteName,
  pitchForSize,
  type SizePitchRule,
  scaleNotes,
  scaleStep,
  snapToScale,
} from './scale';

// Core is game-agnostic: every function takes the scale / rule as an argument.
const C_PENTA = makeScale('C major pentatonic', 0, MAJOR_PENTATONIC);
const G_PENTA = makeScale('G major pentatonic', 7, MAJOR_PENTATONIC);

describe('scales', () => {
  it('builds a scale from a root and intervals', () => {
    const names = scaleNotes(G_PENTA, 60, 71).map((m) => noteName(m).replace(/\d+$/, ''));
    expect(names).toEqual(['D', 'E', 'G', 'A', 'B']);
  });

  it('rejects malformed scales instead of looping forever', () => {
    expect(() => makeScale('empty', 0, [])).toThrow(RangeError);
    expect(() => makeScale('bad root', 12, [0, 2])).toThrow(RangeError);
    expect(() => makeScale('bad interval', 0, [0, 12])).toThrow(RangeError);
    expect(() => makeScale('fraction', 0, [0, 2.5])).toThrow(RangeError);
    const hollow = { name: 'hollow', rootPitchClass: 0, intervals: [] as number[] };
    expect(() => snapToScale(60, hollow)).toThrow(RangeError);
    expect(() => scaleStep(60, 1, hollow)).toThrow(RangeError);
  });

  it('checks membership', () => {
    for (const m of [60, 62, 64, 67, 69]) expect(isInScale(m, C_PENTA)).toBe(true);
    for (const m of [61, 65, 71, 60.5]) expect(isInScale(m, C_PENTA)).toBe(false);
  });

  it('uses equal temperament with A4 = 440 Hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(62)).toBeCloseTo(293.665, 2);
    expect(hzToMidi(midiToHz(66.25))).toBeCloseTo(66.25, 9);
  });

  it('snaps any finite pitch to the nearest scale note', () => {
    for (let m = 30; m <= 100; m += 0.37) {
      const snapped = snapToScale(m, C_PENTA);
      expect(isInScale(snapped, C_PENTA)).toBe(true);
      const best = Math.min(...scaleNotes(C_PENTA, 20, 110).map((n) => Math.abs(n - m)));
      expect(Math.abs(snapped - m)).toBeCloseTo(best, 9);
    }
  });

  it('steps by scale degrees', () => {
    expect(scaleStep(60, 1, C_PENTA)).toBe(62);
    expect(scaleStep(60, 5, C_PENTA)).toBe(72);
    expect(scaleStep(67, -1, C_PENTA)).toBe(64);
    expect(scaleStep(60, 0, C_PENTA)).toBe(60);
  });

  it('rejects non-finite input explicitly (never hangs the main thread)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => snapToScale(bad, C_PENTA)).toThrow(RangeError);
      expect(() => scaleStep(bad, 1, C_PENTA)).toThrow(RangeError);
      expect(() => scaleStep(60, bad, C_PENTA)).toThrow(RangeError);
    }
    expect(() => scaleStep(60, 1.5, C_PENTA)).toThrow(RangeError);
  });
});

describe('pitch from size', () => {
  const rule: SizePitchRule = {
    refSize: 0.1,
    refMidi: 79, // G5, in C pentatonic
    semitonesPerDoubling: 12,
    minMidi: 36,
    maxMidi: 96,
    scale: C_PENTA,
  };
  const sizes = Array.from({ length: 200 }, (_, i) => 0.005 * 1.05 ** i);

  it('lands on a scale note inside the range, never rising as size grows', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const s of sizes) {
      const p = pitchForSize(s, rule);
      expect(isInScale(p.midi, C_PENTA)).toBe(true);
      expect(p.midi).toBeGreaterThanOrEqual(rule.minMidi);
      expect(p.midi).toBeLessThanOrEqual(rule.maxMidi);
      expect(p.midi).toBeLessThanOrEqual(prev);
      prev = p.midi;
    }
  });

  it('drops one octave per doubling and maps the reference size to the reference note', () => {
    expect(pitchForSize(0.15, rule).midi - pitchForSize(0.3, rule).midi).toBe(12);
    expect(pitchForSize(rule.refSize, rule).midi).toBe(rule.refMidi);
  });

  it('rejects sizes that are not positive finite numbers', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
      expect(() => pitchForSize(bad, rule)).toThrow(RangeError);
    }
  });
});
