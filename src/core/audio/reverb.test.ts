import { describe, expect, it } from 'vitest';
import { correlation, decayT60, spectralCentroid } from './analysis';
import { type RoomPreset, roomKey, synthesizeImpulseResponse } from './reverb';
import { mulberry32 } from './rng';

const SR = 44100;

// Core holds the mechanism only; rooms are data the game passes in.
const small: RoomPreset = {
  id: 'small',
  t60: 0.5,
  preDelay: 0.005,
  wet: 0.3,
  damping: 0.5,
  early: { count: 6, spread: 0.02, gain: 4 },
};
const dome: RoomPreset = {
  id: 'dome',
  t60: 3.5,
  preDelay: 0.03,
  wet: 0.4,
  damping: 0.65,
  early: { count: 10, spread: 0.1, gain: 3 },
};

describe('synthesized room impulse responses', () => {
  it('decays at the preset T60 (within 15 %)', () => {
    for (const preset of [small, dome]) {
      const [left, right] = synthesizeImpulseResponse(preset, SR, mulberry32(3));
      for (const ch of [left, right]) {
        const t60 = decayT60(ch as Float32Array, SR) as number;
        expect(Math.abs(t60 / preset.t60 - 1), `${preset.id} measured ${t60}`).toBeLessThan(0.15);
      }
    }
  });

  it('contains the whole tail and starts after the pre-delay', () => {
    for (const preset of [small, dome]) {
      const chans = synthesizeImpulseResponse(preset, SR, mulberry32(1));
      expect(chans).toHaveLength(2);
      const ch = chans[0] as Float32Array;
      expect(ch.length / SR).toBeGreaterThanOrEqual(preset.t60);
      const pre = Math.floor(preset.preDelay * SR);
      for (const c of chans) for (let i = 0; i < pre; i++) expect(c[i]).toBe(0);
    }
  });

  it('is stereo (left and right are decorrelated)', () => {
    const [l, r] = synthesizeImpulseResponse(dome, SR, mulberry32(5));
    expect(Math.abs(correlation(l as Float32Array, r as Float32Array))).toBeLessThan(0.2);
  });

  it('gets darker as it decays (high frequencies are absorbed first)', () => {
    const [l] = synthesizeImpulseResponse(dome, SR, mulberry32(2));
    const head = spectralCentroid(l as Float32Array, SR, dome.preDelay + 0.05, 0.2);
    const tail = spectralCentroid(l as Float32Array, SR, dome.preDelay + dome.t60 * 0.6, 0.2);
    expect(tail).toBeLessThan(head * 0.8);
  });

  it('is normalised so rooms can be swapped without a jump in loudness', () => {
    for (const preset of [small, dome]) {
      const chans = synthesizeImpulseResponse(preset, SR, mulberry32(4));
      let energy = 0;
      for (const c of chans) for (const v of c) energy += v * v;
      expect(energy).toBeCloseTo(1, 2);
    }
  });

  it('is deterministic for a seed', () => {
    const a = synthesizeImpulseResponse(small, SR, mulberry32(8));
    const b = synthesizeImpulseResponse(small, SR, mulberry32(8));
    expect(a[0]).toEqual(b[0]);
  });
});

describe('room identity', () => {
  it('tells rooms apart by every parameter, not only by id', () => {
    const variants: RoomPreset[] = [
      { ...small, t60: 0.6 },
      { ...small, preDelay: 0.006 },
      { ...small, wet: 0.31 },
      { ...small, damping: 0.4 },
      { ...small, early: { ...small.early, count: 7 } },
      { ...small, early: { ...small.early, spread: 0.03 } },
      { ...small, early: { ...small.early, gain: 5 } },
    ];
    for (const v of variants) expect(roomKey(v)).not.toBe(roomKey(small));
    expect(roomKey({ ...small, early: { ...small.early } })).toBe(roomKey(small));
  });
});
