import { describe, expect, it } from 'vitest';
import { GLASS_IOR, GLASS_SPECS } from './kinds';
import { beerLambert, fresnelF0, schlickFresnel, viewPathFactor } from './optics';

const luminance = ([r, g, b]: readonly [number, number, number]): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('fresnel', () => {
  it('reflects about 4% head-on at IOR 1.5', () => {
    expect(fresnelF0(GLASS_IOR)).toBeCloseTo(0.04, 3);
    expect(schlickFresnel(1, GLASS_IOR)).toBeCloseTo(0.04, 3);
  });

  it('reflects more the more oblique the view', () => {
    let previous = schlickFresnel(1, GLASS_IOR);
    for (const cos of [0.8, 0.6, 0.4, 0.2, 0.05]) {
      const f = schlickFresnel(cos, GLASS_IOR);
      expect(f).toBeGreaterThan(previous);
      previous = f;
    }
    expect(schlickFresnel(0, GLASS_IOR)).toBeCloseTo(1, 6);
  });
});

describe('absorption (Beer–Lambert)', () => {
  it('is clear at zero thickness and equals the attenuation colour at the attenuation distance', () => {
    const color: [number, number, number] = [0.9, 0.5, 0.2];
    expect(beerLambert(color, 0.3, 0)).toEqual([1, 1, 1]);
    const atDistance = beerLambert(color, 0.3, 0.3);
    expect(atDistance[0]).toBeCloseTo(0.9, 6);
    expect(atDistance[1]).toBeCloseTo(0.5, 6);
    expect(atDistance[2]).toBeCloseTo(0.2, 6);
  });

  it('makes coloured glass darker and more saturated where it is thicker', () => {
    for (const kind of ['amber', 'lapis', 'jade'] as const) {
      const { absorption } = GLASS_SPECS[kind];
      const thin = beerLambert(absorption.color, absorption.distance, 0.05);
      const thick = beerLambert(absorption.color, absorption.distance, 0.4);
      expect(luminance(thick), kind).toBeLessThan(luminance(thin));
    }
  });

  it('keeps clear glass nearly colourless head-on but green along the edge', () => {
    const { absorption, thickness, body } = GLASS_SPECS.clear;
    const faceOn = beerLambert(absorption.color, absorption.distance, thickness * viewPathFactor(body, 1));
    for (const c of faceOn) expect(c).toBeGreaterThan(0.9);
    // Near the silhouette the view crosses the wall almost edge-on (断面の縁).
    const edge = beerLambert(absorption.color, absorption.distance, thickness * viewPathFactor(body, 0.1));
    expect(edge[1]).toBeGreaterThan(edge[0]);
    expect(edge[1]).toBeGreaterThan(edge[2]);
    expect(edge[1] - edge[0]).toBeGreaterThan(0.08);
  });
});

describe('light path through the glass by view angle', () => {
  it('grows towards grazing angles through a shell wall', () => {
    expect(viewPathFactor('shell', 1)).toBeCloseTo(1, 6);
    expect(viewPathFactor('shell', 0.5)).toBeGreaterThan(viewPathFactor('shell', 1));
    expect(viewPathFactor('shell', 0.2)).toBeGreaterThan(viewPathFactor('shell', 0.5));
    expect(Number.isFinite(viewPathFactor('shell', 0))).toBe(true);
  });

  it('shrinks towards the rim of a solid body', () => {
    expect(viewPathFactor('solid', 1)).toBeCloseTo(1, 6);
    expect(viewPathFactor('solid', 0.3)).toBeLessThan(viewPathFactor('solid', 1));
    expect(viewPathFactor('solid', 0)).toBeGreaterThan(0);
  });
});
