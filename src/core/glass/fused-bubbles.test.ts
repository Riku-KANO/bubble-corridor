import { describe, expect, it } from 'vitest';
import {
  buildFusedBubbleSurface,
  fusedBubbleField,
  fusedBubbleSilhouette,
  scatterInnerBubbles,
} from './fused-bubbles';

function vertex(positions: Float32Array, i: number): [number, number, number] {
  return [positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0];
}

describe('fused bubble surface (泡が溶け合った形)', () => {
  it('wraps a single bubble as a sphere with outward normals', () => {
    const surface = buildFusedBubbleSurface([{ x: 1, y: 2, z: 3, r: 1.5 }], {
      blend: 0.3,
      columns: 24,
      rows: 16,
    });
    const count = surface.positions.length / 3;
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = vertex(surface.positions, i);
      const [nx, ny, nz] = vertex(surface.normals, i);
      const d = Math.hypot(x - 1, y - 2, z - 3);
      expect(d).toBeCloseTo(1.5, 2);
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 3);
      expect(nx * (x - 1) + ny * (y - 2) + nz * (z - 3)).toBeGreaterThan(0);
    }
  });

  it('puts every vertex on the blended surface of several bubbles', () => {
    const bubbles = [
      { x: 0, y: 1, z: 0, r: 1.6 },
      { x: 1.6, y: 0.6, z: 0.3, r: 1.0 },
      { x: -1.2, y: 2.2, z: -0.4, r: 0.9 },
    ];
    const field = fusedBubbleField(bubbles, 0.5);
    const surface = buildFusedBubbleSurface(bubbles, { blend: 0.5, columns: 48, rows: 32 });
    for (let i = 0; i < surface.positions.length / 3; i++) {
      expect(Math.abs(field(...vertex(surface.positions, i)))).toBeLessThan(2e-3);
    }
  });

  it('fills the seam between two bubbles with a smooth neck instead of a sharp crease', () => {
    const a = { x: -0.8, y: 0, z: 0, r: 1 };
    const b = { x: 0.8, y: 0, z: 0, r: 1 };
    // Hard union: the seam circle at x=0 has radius sqrt(1 - 0.8²) = 0.6.
    const seamRadius = Math.sqrt(1 - 0.8 ** 2);
    const blended = fusedBubbleField([a, b], 0.4);
    expect(blended(0, seamRadius, 0)).toBeLessThan(0);
    expect(fusedBubbleField([a, b], 0)(0, seamRadius, 0)).toBeCloseTo(0, 6);
  });

  it('gives bounding spheres that cover the blended surface, seams included', () => {
    const bubbles = [
      { x: 0, y: 1, z: 0, r: 1.6 },
      { x: 1.9, y: 0.6, z: 0.3, r: 1.0 },
      { x: -1.4, y: 2.4, z: -0.4, r: 0.9 },
    ];
    const blend = 0.9;
    const surface = buildFusedBubbleSurface(bubbles, { blend, columns: 64, rows: 48 });
    const cover = fusedBubbleSilhouette(bubbles, surface);
    for (let i = 0; i < surface.positions.length / 3; i++) {
      const [x, y, z] = vertex(surface.positions, i);
      const inside = cover.some((s) => Math.hypot(x - s.x, y - s.y, z - s.z) <= s.r + 1e-5);
      expect(inside).toBe(true);
    }
    // ...and stay tight: no bubble grows by more than the blend.
    cover.forEach((s, i) => {
      expect(s.r - (bubbles[i]?.r ?? 0)).toBeLessThanOrEqual(blend);
    });
  });

  it('is deterministic', () => {
    const bubbles = [
      { x: 0, y: 0, z: 0, r: 1 },
      { x: 1, y: 0.5, z: 0, r: 0.7 },
    ];
    const a = buildFusedBubbleSurface(bubbles, { blend: 0.3, columns: 16, rows: 12 });
    const b = buildFusedBubbleSurface(bubbles, { blend: 0.3, columns: 16, rows: 12 });
    expect(a.positions).toEqual(b.positions);
  });
});

describe('inner bubbles (気泡入りガラス)', () => {
  it('scatters the requested number of bubbles fully inside the glass', () => {
    const bubbles = scatterInnerBubbles({
      seed: 7,
      count: 40,
      containerRadius: 0.3,
      sizeRange: [0.004, 0.018],
    });
    expect(bubbles).toHaveLength(40);
    for (const b of bubbles) {
      expect(b.r).toBeGreaterThanOrEqual(0.004);
      expect(b.r).toBeLessThanOrEqual(0.018);
      expect(Math.hypot(b.x, b.y, b.z) + b.r).toBeLessThanOrEqual(0.3);
    }
  });

  it('gives the same bubbles for the same seed and different ones for another', () => {
    const opts = { count: 10, containerRadius: 0.3, sizeRange: [0.005, 0.01] as const };
    expect(scatterInnerBubbles({ seed: 1, ...opts })).toEqual(scatterInnerBubbles({ seed: 1, ...opts }));
    expect(scatterInnerBubbles({ seed: 1, ...opts })).not.toEqual(scatterInnerBubbles({ seed: 2, ...opts }));
  });
});
