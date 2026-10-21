/**
 * Sensor for 技術設計 > ガラスの描画 > 最大の制約: standard transmission only refracts the opaque scene,
 * so transmissive glass behind other transmissive glass vanishes. Level design avoids that on the main
 * sightlines (対策1). This finds such stacks for a view, from bounding spheres. Pure, no GPU.
 */
export interface GlassSphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** One transmissive object, covered by one or more spheres (e.g. the bubbles of a fused building). */
export interface GlassSilhouette {
  id: string;
  spheres: readonly GlassSphere[];
}

export interface ViewSpec {
  /** World → view matrix, column-major (three's camera.matrixWorldInverse.elements). */
  viewMatrix: ArrayLike<number>;
  tanHalfFovY: number;
  aspect: number;
  near: number;
}

export interface TransmissionOverlap {
  front: string;
  back: string;
  /** How far the silhouettes overlap, radians of view angle. */
  amount: number;
}

interface Cone {
  /** Unit direction from the eye to the sphere's centre, view space. */
  dx: number;
  dy: number;
  dz: number;
  /** Angular radius of the silhouette, radians (π when the eye is inside the sphere). */
  alpha: number;
  distance: number;
}

/** The sphere's silhouette as a cone from the eye, or null when it is entirely outside the view. */
function project(s: GlassSphere, view: ViewSpec): Cone | null {
  const m = view.viewMatrix;
  const vx = (m[0] ?? 0) * s.x + (m[4] ?? 0) * s.y + (m[8] ?? 0) * s.z + (m[12] ?? 0);
  const vy = (m[1] ?? 0) * s.x + (m[5] ?? 0) * s.y + (m[9] ?? 0) * s.z + (m[13] ?? 0);
  const vz = (m[2] ?? 0) * s.x + (m[6] ?? 0) * s.y + (m[10] ?? 0) * s.z + (m[14] ?? 0);
  const distance = Math.hypot(vx, vy, vz);
  if (distance <= s.r) return { dx: 0, dy: 0, dz: -1, alpha: Math.PI, distance }; // the eye is inside it

  // Frustum test in view space (symmetric frustum through the eye).
  const depth = -vz;
  if (depth + s.r < view.near) return null;
  const hy = Math.atan(view.tanHalfFovY);
  const hx = Math.atan(view.tanHalfFovY * view.aspect);
  const outside = (lateral: number, half: number) =>
    Math.abs(lateral) * Math.cos(half) - depth * Math.sin(half) > s.r;
  if (outside(vx, hx) || outside(vy, hy)) return null;

  return {
    dx: vx / distance,
    dy: vy / distance,
    dz: vz / distance,
    alpha: Math.asin(s.r / distance),
    distance,
  };
}

/**
 * Pairs of transmissive objects whose silhouettes overlap on screen. Each bounding sphere is seen as a
 * cone from the eye; two cones overlap when the angle between them is less than the sum of their radii.
 * `margin` asks for an extra gap between silhouettes (radians) so small camera moves stay safe.
 */
export function findTransmissionOverlaps(
  objects: readonly GlassSilhouette[],
  view: ViewSpec,
  options: { margin?: number } = {},
): TransmissionOverlap[] {
  const margin = options.margin ?? 0;
  const projected = objects.map((o) =>
    o.spheres.map((s) => project(s, view)).filter((p): p is Cone => p !== null),
  );
  const out: TransmissionOverlap[] = [];
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      let best: { amount: number; iFront: boolean } | null = null;
      for (const a of projected[i] ?? []) {
        for (const b of projected[j] ?? []) {
          const cos = Math.min(1, Math.max(-1, a.dx * b.dx + a.dy * b.dy + a.dz * b.dz));
          const amount = a.alpha + b.alpha + margin - Math.acos(cos);
          if (amount > 0 && (best === null || amount > best.amount)) {
            best = { amount, iFront: a.distance <= b.distance };
          }
        }
      }
      if (best) {
        const oi = objects[i]?.id ?? '';
        const oj = objects[j]?.id ?? '';
        out.push({ front: best.iFront ? oi : oj, back: best.iFront ? oj : oi, amount: best.amount });
      }
    }
  }
  return out;
}
