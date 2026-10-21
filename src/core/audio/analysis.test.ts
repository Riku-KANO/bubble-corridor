import { describe, expect, it } from 'vitest';
import { correlation, decayT60, estimatePitch, peak, rms, spectralCentroid } from './analysis';
import { mulberry32 } from './rng';

const SR = 44100;

function tone(partials: { hz: number; amp: number; t60?: number }[], seconds: number, sr = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  for (const p of partials) {
    const k = p.t60 ? Math.log(1000) / p.t60 : 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      out[i] = (out[i] as number) + p.amp * Math.exp(-k * t) * Math.sin(2 * Math.PI * p.hz * t);
    }
  }
  return out;
}

describe('level', () => {
  it('measures RMS and peak', () => {
    const x = tone([{ hz: 440, amp: 0.5 }], 1);
    expect(rms(x)).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(peak(x)).toBeCloseTo(0.5, 3);
    expect(rms(new Float32Array(1000))).toBe(0);
  });
});

describe('pitch estimate', () => {
  it('finds a pure tone within 0.2 %', () => {
    for (const hz of [73.4, 293.7, 880, 2349]) {
      const est = estimatePitch(tone([{ hz, amp: 0.3 }], 0.5), SR);
      expect(est).not.toBeNull();
      expect(Math.abs((est as number) / hz - 1)).toBeLessThan(0.002);
    }
  });

  it('finds the fundamental of an inharmonic glass-like tone, even when an overtone is louder', () => {
    const x = tone(
      [
        { hz: 659.3, amp: 0.4, t60: 1.5 },
        { hz: 659.3 * 2.83, amp: 0.6, t60: 0.6 },
        { hz: 659.3 * 5.42, amp: 0.3, t60: 0.3 },
      ],
      0.6,
    );
    const est = estimatePitch(x, SR) as number;
    expect(Math.abs(est / 659.3 - 1)).toBeLessThan(0.005);
  });

  it('analyses only the requested window', () => {
    const a = tone([{ hz: 440, amp: 0.3 }], 0.2);
    const b = tone([{ hz: 587.3, amp: 0.3 }], 0.2);
    const x = new Float32Array(a.length + b.length);
    x.set(a, 0);
    x.set(b, a.length);
    const est = estimatePitch(x, SR, { start: 0.21, duration: 0.15 }) as number;
    expect(Math.abs(est / 587.3 - 1)).toBeLessThan(0.005);
  });

  it('returns null for silence', () => {
    expect(estimatePitch(new Float32Array(8192), SR)).toBeNull();
  });
});

describe('decay time', () => {
  it('recovers the T60 of an exponentially decaying noise', () => {
    const rng = mulberry32(7);
    for (const t60 of [0.4, 1.5, 4]) {
      const n = Math.round((t60 * 1.3 + 0.1) * SR);
      const x = new Float32Array(n);
      const k = Math.log(1000) / t60;
      for (let i = 0; i < n; i++) x[i] = (rng() * 2 - 1) * Math.exp((-k * i) / SR);
      const est = decayT60(x, SR) as number;
      expect(Math.abs(est / t60 - 1), `t60 ${t60}`).toBeLessThan(0.1);
    }
  });

  it('measures a decaying tone too', () => {
    const est = decayT60(tone([{ hz: 880, amp: 0.5, t60: 1.2 }], 1.6), SR) as number;
    expect(Math.abs(est / 1.2 - 1)).toBeLessThan(0.1);
  });
});

describe('spectral shape and stereo', () => {
  it('ranks brighter sounds higher', () => {
    const dark = tone([{ hz: 300, amp: 0.5 }], 0.3);
    const bright = tone(
      [
        { hz: 300, amp: 0.5 },
        { hz: 3000, amp: 0.5 },
      ],
      0.3,
    );
    expect(spectralCentroid(bright, SR, 0, 0.2)).toBeGreaterThan(spectralCentroid(dark, SR, 0, 0.2) * 2);
  });

  it('measures correlation of two signals', () => {
    const rng = mulberry32(1);
    const a = Float32Array.from({ length: 20000 }, () => rng() * 2 - 1);
    const b = Float32Array.from({ length: 20000 }, () => rng() * 2 - 1);
    expect(correlation(a, a)).toBeCloseTo(1, 6);
    expect(Math.abs(correlation(a, b))).toBeLessThan(0.05);
  });
});
