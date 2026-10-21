import { describe, expect, it } from 'vitest';
import { designPops, type PopPattern, type PopTuning } from './pop';
import { mulberry32 } from './rng';
import { midiToHz } from './scale';

// Core holds the mechanism only; articulation and jitter come in as a tuning.
const TUNING: PopTuning = {
  po: { gain: 0.6, bright: 0.2, t60: 0.1, glide: 0.05 },
  pen: { gain: 1, bright: 0.5, t60: 0.3, glide: 0.03 },
  plain: { gain: 1, bright: 0.3, t60: 0.08, glide: 0.03 },
  jitter: { time: 0.004, pitch: 0.002, levelDb: 1, t60: 0.1 },
};
const NO_JITTER: PopTuning = { ...TUNING, jitter: { time: 0, pitch: 0, levelDb: 0, t60: 0 } };

const pair: PopPattern = { notes: [72, 76], spacing: 0.1, gain: 0.5, fade: 1, pair: true };
const run: PopPattern = { notes: [72, 74, 72, 74, 72], spacing: 0.06, gain: 0.3, fade: 0.8, pair: false };

describe('thin-glass pops (mechanism)', () => {
  it('plays the given notes in order, on pitch, at the given spacing', () => {
    const score = designPops(pair, mulberry32(1), TUNING);
    expect(score.pops.map((p) => p.midi)).toEqual([72, 76]);
    for (const p of score.pops) expect(Math.abs(p.hz / midiToHz(p.midi) - 1)).toBeLessThanOrEqual(0.002);
    expect(Math.abs((score.pops[1]?.time as number) - 0.1)).toBeLessThanOrEqual(0.004);
  });

  it('applies the po / pen articulation of the tuning to a pair', () => {
    const [po, pen] = designPops(pair, mulberry32(3), NO_JITTER).pops;
    expect(po).toMatchObject({ gain: 0.5 * 0.6, bright: 0.2, t60: 0.1, glide: 0.05 });
    expect(pen).toMatchObject({ gain: 0.5, bright: 0.5, t60: 0.3, glide: 0.03 });
  });

  it('fades a run of pops by the pattern’s fade', () => {
    const score = designPops(run, mulberry32(1), NO_JITTER);
    expect(score.pops).toHaveLength(5);
    expect(score.pops[4]?.gain).toBeCloseTo(0.3 * 0.8 ** 4, 9);
  });

  it('varies slightly per play but is deterministic per seed', () => {
    expect(designPops(pair, mulberry32(1), TUNING)).toEqual(designPops(pair, mulberry32(1), TUNING));
    expect(designPops(pair, mulberry32(1), TUNING)).not.toEqual(designPops(pair, mulberry32(2), TUNING));
  });
});
