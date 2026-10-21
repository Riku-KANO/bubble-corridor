/**
 * The one motion curve shared by every transition (トランジション設計 > 遷移のルール 5:
 * ガラスらしい、ゆっくり始まって粘りながら止まる曲線を全画面で共通にする).
 *
 * A cubic Bézier so the same curve drives JS/TSL animation (`glassEase`) and DOM animation
 * (`GLASS_EASE_CSS`). The first 10% of the time covers ~1% of the way, the last 10% ~0.6%;
 * no overshoot. Control points are an M0 tuning value (see process/slices/S-04.md).
 */
export const GLASS_EASE_POINTS = [0.55, 0, 0.2, 1] as const;

export const GLASS_EASE_CSS = `cubic-bezier(${GLASS_EASE_POINTS.join(', ')})`;

/** Builds an easing function for a CSS-style cubic Bézier (x1, y1, x2, y2), with x1, x2 in [0, 1]. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number): number => {
    // Newton first (fast), bisection as the fallback where the slope is flat.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) return t;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (x: number): number => {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    return Math.min(1, Math.max(0, sampleY(solveT(x))));
  };
}

export const glassEase: (x: number) => number = cubicBezier(...GLASS_EASE_POINTS);

/** The time (0..1) at which `glassEase` reaches `y`. Lets a pose on the curve be turned into a moment. */
export function glassEaseInverse(y: number): number {
  if (!(y > 0)) return 0;
  if (y >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (glassEase(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
