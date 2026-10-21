import { describe, expect, it } from 'vitest';
import { designGlassVoice, GLASS_STRENGTHS, type GlassStrength, type GlassTuning } from './glass';
import { mulberry32 } from './rng';

// Core holds the mechanism only; every value that shapes the sound comes in as a tuning.
const TUNING: GlassTuning = {
  strengths: {
    touch: { level: 0.2, brightness: 0.1, attack: 0.01, strike: 0, strikeDuration: 0, ring: 0.5 },
    tap: { level: 0.4, brightness: 0.3, attack: 0.002, strike: 0.05, strikeDuration: 0.005, ring: 1 },
    hit: { level: 0.7, brightness: 0.6, attack: 0.0005, strike: 0.1, strikeDuration: 0.004, ring: 1 },
  },
  ring: { refSize: 0.1, t60: 1.5, exponent: 0.4, min: 0.4, max: 5 },
  modeDamping: 0.7,
  strike: { centerRatio: 3.5, q: 1.2, minHz: 1500 },
  jitter: {
    detune: 0.004,
    modeRatio: 0.005,
    modeGain: 0.2,
    t60: 0.1,
    levelDb: 1,
    splitMin: 0.0005,
    splitMax: 0.002,
    splitGain: 0.3,
    strikeHz: 0.15,
  },
};
const NO_JITTER: GlassTuning = {
  ...TUNING,
  jitter: { ...TUNING.jitter, detune: 0, modeRatio: 0, modeGain: 0, t60: 0, levelDb: 0, strikeHz: 0 },
};

const base = { hz: 880, size: 0.1 };
function voice(
  strength: GlassStrength,
  seed = 1,
  tuning = TUNING,
  extra: Partial<{ hz: number; size: number }> = {},
) {
  return designGlassVoice({ ...base, ...extra, strength }, mulberry32(seed), tuning);
}

describe('glass voice (modal synthesis mechanism)', () => {
  it('rings at the requested pitch, detuned only within the tuning’s jitter, differently each strike', () => {
    const detunes = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const v = voice('tap', seed);
      expect(Math.abs(v.hz / base.hz - 1)).toBeLessThanOrEqual(TUNING.jitter.detune);
      detunes.add(Math.round(v.hz * 1000));
    }
    expect(detunes.size).toBeGreaterThan(30);
    expect(voice('tap', 1, NO_JITTER).hz).toBe(base.hz);
  });

  it('is deterministic for the same seed', () => {
    expect(voice('hit', 9)).toEqual(voice('hit', 9));
  });

  it('has glass-like, non-integer overtones (thin-shell mode ratios)', () => {
    for (const s of GLASS_STRENGTHS) {
      const v = voice(s, 3);
      const overtones = v.partials.filter((p) => p.hz > v.hz * 1.5);
      expect(overtones.length).toBeGreaterThanOrEqual(2);
      for (const p of overtones) {
        const ratio = p.hz / v.hz;
        expect(Math.abs(ratio - Math.round(ratio)), `ratio ${ratio}`).toBeGreaterThan(0.1);
      }
    }
  });

  it('follows the tuning: level, brightness, attack and ring time come from the profile', () => {
    const a = voice('tap', 1, NO_JITTER);
    const louder: GlassTuning = {
      ...NO_JITTER,
      strengths: { ...NO_JITTER.strengths, tap: { ...NO_JITTER.strengths.tap, level: 0.8, attack: 0.02 } },
      ring: { ...NO_JITTER.ring, t60: 3 },
    };
    const b = voice('tap', 1, louder);
    expect(a.level).toBeCloseTo(0.4, 9);
    expect(b.level).toBeCloseTo(0.8, 9);
    expect(b.attack).toBe(0.02);
    expect(b.partials[0]?.t60).toBeCloseTo((a.partials[0]?.t60 as number) * 2, 9);
    // Partial gains are normalised so that, all in phase, they reach exactly the profile level.
    expect(a.partials.reduce((s, p) => s + p.gain, 0)).toBeCloseTo(0.4, 9);
  });

  it('lets higher modes die away faster than the fundamental', () => {
    const v = voice('hit', 2);
    const fundamental = v.partials[0] as { t60: number };
    for (const p of v.partials.filter((q) => q.hz > v.hz * 1.5)) expect(p.t60).toBeLessThan(fundamental.t60);
  });

  it('rings longer for bigger glass, within the tuning’s clamp', () => {
    const small = voice('tap', 4, NO_JITTER, { size: 0.04, hz: 1760 });
    const big = voice('tap', 4, NO_JITTER, { size: 0.8, hz: 220 });
    expect(big.duration).toBeGreaterThan(small.duration * 1.5);
    expect(voice('tap', 4, NO_JITTER, { size: 1000 }).partials[0]?.t60).toBe(TUNING.ring.max);
  });

  it('never schedules overtones above the Nyquist-safe limit', () => {
    const v = designGlassVoice(
      { hz: 4000, size: 0.02, strength: 'hit', sampleRate: 22050 },
      mulberry32(1),
      TUNING,
    );
    for (const p of v.partials) expect(p.hz).toBeLessThan(22050 * 0.45);
  });
});
