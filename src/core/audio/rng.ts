/** A random source in [0, 1). Synth code takes one so tests and offline renders are reproducible. */
export type Rng = () => number;

/** Small, fast seeded PRNG (mulberry32). Good enough for audio jitter and noise, not for security. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform value in [-amount, +amount]. */
export function jitter(rng: Rng, amount: number): number {
  return (rng() * 2 - 1) * amount;
}

/** Fresh seed for live playback (each strike sounds a little different). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}
