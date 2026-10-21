/**
 * Shapes for glass architecture and bubble glass. Pure geometry data (no three.js), so it can be
 * tested and shared with the sister project.
 *
 * アートディレクション > 形のルール: 建物は泡の集合として作る。大小の泡が溶け合ったような形.
 * Blender does this with volume remeshing (Blenderアセットパイプライン > 造形); for M0 we wrap a smooth
 * union of spheres by marching rays out from the cluster's centre. That works for clusters that are
 * star-shaped around their centre, which bubble houses are.
 */
export interface Bubble {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** Signed distance (approx.) to the smooth union of the bubbles. `blend` is the fillet size in metres. */
export function fusedBubbleField(
  bubbles: readonly Bubble[],
  blend: number,
): (x: number, y: number, z: number) => number {
  return (x, y, z) => {
    let d = Number.POSITIVE_INFINITY;
    for (const b of bubbles) {
      const di = Math.hypot(x - b.x, y - b.y, z - b.z) - b.r;
      if (d === Number.POSITIVE_INFINITY) d = di;
      else if (blend > 0) {
        // Polynomial smooth minimum (Quílez): pulls the surface outwards where bubbles meet.
        const h = Math.max(blend - Math.abs(d - di), 0) / blend;
        d = Math.min(d, di) - h * h * blend * 0.25;
      } else d = Math.min(d, di);
    }
    return d;
  };
}

/**
 * Bounding spheres for a built fused surface (e.g. for the transmission overlap sensor): each bubble grows
 * just enough to cover the surface points nearest to it, so the blended seams are covered too.
 */
export function fusedBubbleSilhouette(bubbles: readonly Bubble[], surface: FusedBubbleSurface): Bubble[] {
  const out = bubbles.map((b) => ({ ...b }));
  const p = surface.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] ?? 0;
    const y = p[i + 1] ?? 0;
    const z = p[i + 2] ?? 0;
    let owner: Bubble | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const b of out) {
      const gap = Math.hypot(x - b.x, y - b.y, z - b.z) - b.r;
      if (gap < best) {
        best = gap;
        owner = b;
      }
    }
    if (owner && best > 0) owner.r += best;
  }
  return out;
}

export interface FusedBubbleSurface {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Grid size: (columns + 1) × (rows + 1) vertices, row 0 at the top. Lets callers trace lines on it. */
  columns: number;
  rows: number;
  center: [number, number, number];
}

export interface FusedBubbleOptions {
  blend: number;
  columns: number;
  rows: number;
  /** Point the rays start from. Default: the volume-weighted centroid of the bubbles. */
  center?: [number, number, number];
}

export function buildFusedBubbleSurface(
  bubbles: readonly Bubble[],
  opts: FusedBubbleOptions,
): FusedBubbleSurface {
  if (bubbles.length === 0) throw new Error('buildFusedBubbleSurface: no bubbles');
  const field = fusedBubbleField(bubbles, opts.blend);
  const center = opts.center ?? centroid(bubbles);
  const [cx, cy, cz] = center;

  let reach = 0;
  let minR = Number.POSITIVE_INFINITY;
  for (const b of bubbles) {
    reach = Math.max(reach, Math.hypot(b.x - cx, b.y - cy, b.z - cz) + b.r);
    minR = Math.min(minR, b.r);
  }
  reach += opts.blend + 0.01;
  const minStep = Math.max(1e-4, minR * 0.002);
  const eps = Math.max(1e-4, minR * 1e-3);

  const { columns, rows } = opts;
  const count = (columns + 1) * (rows + 1);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  let k = 0;
  for (let i = 0; i <= rows; i++) {
    const theta = (i / rows) * Math.PI;
    for (let j = 0; j <= columns; j++) {
      const phi = (j / columns) * Math.PI * 2;
      const dx = Math.sin(theta) * Math.cos(phi);
      const dy = Math.cos(theta);
      const dz = Math.sin(theta) * Math.sin(phi);
      const s = outermostHit(field, cx, cy, cz, dx, dy, dz, reach, minStep);
      const px = cx + dx * s;
      const py = cy + dy * s;
      const pz = cz + dz * s;
      positions[k * 3] = px;
      positions[k * 3 + 1] = py;
      positions[k * 3 + 2] = pz;
      let nx = field(px + eps, py, pz) - field(px - eps, py, pz);
      let ny = field(px, py + eps, pz) - field(px, py - eps, pz);
      let nz = field(px, py, pz + eps) - field(px, py, pz - eps);
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      normals[k * 3] = nx;
      normals[k * 3 + 1] = ny;
      normals[k * 3 + 2] = nz;
      uvs[k * 2] = j / columns;
      uvs[k * 2 + 1] = 1 - i / rows;
      k++;
    }
  }

  const tris: number[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < columns; j++) {
      const a = i * (columns + 1) + j;
      const b = a + columns + 1;
      // Counter-clockwise seen from outside (rows go downward, columns go towards +z from +x).
      if (i !== 0) tris.push(a, a + 1, b);
      if (i !== rows - 1) tris.push(a + 1, b + 1, b);
    }
  }

  return { positions, normals, uvs, indices: Uint32Array.from(tris), columns, rows, center };
}

function centroid(bubbles: readonly Bubble[]): [number, number, number] {
  let w = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const b of bubbles) {
    const v = b.r ** 3;
    w += v;
    x += b.x * v;
    y += b.y * v;
    z += b.z * v;
  }
  return [x / w, y / w, z / w];
}

/** Marches inward from `reach` and returns the distance of the outermost surface crossing. */
function outermostHit(
  field: (x: number, y: number, z: number) => number,
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dy: number,
  dz: number,
  reach: number,
  minStep: number,
): number {
  let outside = reach;
  let s = reach;
  while (s > 0) {
    const d = field(cx + dx * s, cy + dy * s, cz + dz * s);
    if (d < 0) break;
    outside = s;
    s -= Math.max(d * 0.8, minStep);
  }
  let inside = Math.max(s, 0);
  for (let it = 0; it < 40; it++) {
    const mid = (inside + outside) * 0.5;
    if (field(cx + dx * mid, cy + dy * mid, cz + dz * mid) < 0) inside = mid;
    else outside = mid;
  }
  return (inside + outside) * 0.5;
}

export interface InnerBubbleOptions {
  seed: number;
  count: number;
  /** Radius of the glass body the bubbles must stay inside, metres. */
  containerRadius: number;
  sizeRange: readonly [number, number];
}

/**
 * Bubbles for 気泡入りガラス: 泡は内部の別の小さな形状として入れる. Deterministic for a seed, mostly
 * small with a few larger ones, all fully inside the body.
 */
export function scatterInnerBubbles(opts: InnerBubbleOptions): Bubble[] {
  const rand = mulberry32(opts.seed);
  const [minR, maxR] = opts.sizeRange;
  const out: Bubble[] = [];
  while (out.length < opts.count) {
    const r = minR + (maxR - minR) * rand() ** 2;
    const room = opts.containerRadius - r;
    if (room <= 0) continue;
    let x: number;
    let y: number;
    let z: number;
    do {
      x = rand() * 2 - 1;
      y = rand() * 2 - 1;
      z = rand() * 2 - 1;
    } while (x * x + y * y + z * z > 1);
    // Keep a hair of glass between the bubble and the surface.
    const scale = room * 0.97;
    out.push({ x: x * scale, y: y * scale, z: z * scale, r });
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
