// 星（光を宿したガラス玉）の置き方と、灯る時刻。純粋な計算（three の Vector3 だけ使う）。
// 球の内側（殻のあいだ）にも外側（星の海）にも置く（ADR-0009）。レールの周り、ほかの部屋のレールの周り、
// 夜明けの岸の上、9:50 の街の星座の前は空けておく。
import * as THREE from 'three/webgpu';
import { seededRandom } from './kit';

/** 星の種類: a 小さな玉（数が多い）、b 明るい玉、c 星座の街の星 */
export type StarKind = 0 | 1 | 2;

export interface StarField {
  readonly count: number;
  readonly kind: Uint8Array;
  /** 位置（世界座標、xyz × count） */
  readonly position: Float32Array;
  /** ガラス玉の半径（m） */
  readonly radius: Float32Array;
  /** 光の色（線形、rgb × count。明るさを含む） */
  readonly color: Float32Array;
  /** 灯る時刻（秒）と、またたきの位相 */
  readonly light: Float32Array;
}

export interface StarFieldInput {
  readonly center: THREE.Vector3;
  readonly shellRadii: readonly number[];
  /** 天球の区間のレールの点（前後に余裕を足したもの） */
  readonly path: readonly THREE.Vector3[];
  /** ほかの区間のレールの点（星を置かない） */
  readonly otherPath: readonly THREE.Vector3[];
  /** 9:50 の目の位置と正面（街の星座の前を空ける） */
  readonly cityEye: THREE.Vector3;
  readonly cityForward: THREE.Vector3;
  /** 暗転が明けたときの目と正面（灯る順に使う） */
  readonly revealEye: THREE.Vector3;
  readonly revealForward: THREE.Vector3;
  /** 暗転が明ける時刻（最初の星が灯る） */
  readonly revealT: number;
  /** 数の倍率（品質の particleScale） */
  readonly scale: number;
  readonly seed?: number;
}

/** high の数。low は particleScale を掛けて減らす */
export const STAR_COUNTS = { innerA: 1050, innerB: 240, outerA: 1350, outerB: 260 } as const;
/** レールの中心から星の中心まで（m）。玉の箱（半径 × √3）を引いても 1.75m 以上残る */
const RAIL_CLEAR = 3.0;
const OTHER_RAIL_CLEAR = 24;
const SHELL_CLEAR = 0.7;

/** 星の色（白金が主。冷たい白、淡い金、まれに淡い桃） */
const PALETTE: readonly [number, number, number, number][] = [
  [1.0, 0.95, 0.86, 0.55],
  [0.8, 0.88, 1.0, 0.3],
  [1.0, 0.82, 0.58, 0.1],
  [1.0, 0.76, 0.84, 0.05],
];

function minDistSq(p: THREE.Vector3, pts: readonly THREE.Vector3[]): number {
  let m = Infinity;
  for (const q of pts) {
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    const dz = p.z - q.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < m) m = d;
  }
  return m;
}

export function generateStarField(input: StarFieldInput): StarField {
  const rand = seededRandom(input.seed ?? 0x5a17);
  const C = input.center;
  const outer = Math.max(...input.shellRadii);
  const cityFwd = input.cityForward.clone().normalize();
  const candidates: { p: THREE.Vector3; kind: StarKind; r: number; c: [number, number, number] }[] = [];
  const tmp = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const pickColor = (bright: number): [number, number, number] => {
    let x = rand();
    for (const [r, g, b, w] of PALETTE) {
      if ((x -= w) <= 0) return [r * bright, g * bright, b * bright];
    }
    return [bright, bright, bright];
  };

  const accept = (p: THREE.Vector3, inner: boolean): boolean => {
    const d = p.distanceTo(C);
    if (inner) {
      for (const r of input.shellRadii) if (Math.abs(d - r) < SHELL_CLEAR) return false;
      // 街の星座の前（中心から 15〜42m、正面 ±50°、仰角 -10〜36°）は薄くする
      tmp.subVectors(p, input.cityEye);
      const dist = tmp.length();
      if (dist > 15 && dist < 42) {
        const h = Math.hypot(tmp.x, tmp.z);
        const el = (Math.atan2(tmp.y, h) * 180) / Math.PI;
        const az = (Math.acos(Math.min(1, Math.max(-1, (tmp.x * cityFwd.x + tmp.z * cityFwd.z) / Math.max(1e-6, h)))) * 180) / Math.PI;
        if (az < 52 && el > -10 && el < 36 && rand() > 0.12) return false;
      }
    } else {
      // 夜明けの岸の上（x < 108、|z| < 64、y < 30）と、台座の柱の周りは空ける
      if (p.x < 108 && Math.abs(p.z) < 64 && p.y < 30) return false;
      if (p.y < C.y - outer + 4 && Math.hypot(p.x - C.x, p.z - C.z) < 24) return false;
      if (minDistSq(p, input.otherPath) < OTHER_RAIL_CLEAR * OTHER_RAIL_CLEAR) return false;
    }
    return minDistSq(p, input.path) >= RAIL_CLEAR * RAIL_CLEAR;
  };

  const place = (n: number, kind: StarKind, inner: boolean) => {
    let made = 0;
    for (let guard = 0; made < n && guard < n * 40; guard++) {
      dir.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      const l = dir.length();
      if (l < 1e-3 || l > 1) continue;
      dir.divideScalar(l);
      // 内側は体積に均一、外側は遠いほど疎（半径の対数に均一）
      const r = inner ? (outer - 1.5) * Math.cbrt(0.02 + 0.98 * rand()) : 64 * Math.pow(178 / 64, rand());
      const p = C.clone().addScaledVector(dir, r);
      if (!accept(p, inner)) continue;
      const far = p.distanceTo(C);
      // 遠い星は少し大きく（画面の上で 1 画素より小さくならないように）
      const base = kind === 0 ? 0.15 + rand() * 0.1 : 0.3 + rand() * 0.16;
      const radius = base * (1 + far / (kind === 0 ? 110 : 150));
      const bright = kind === 0 ? 0.9 + rand() * 0.8 : 2.0 + rand() * 1.4;
      candidates.push({ p, kind, r: radius, c: pickColor(bright) });
      made++;
    }
  };

  // 品質で減らすときも同じ星の部分集合になるよう、種類ごとに全数を作ってから先頭を取る
  const s = Math.min(1, Math.max(0.05, input.scale));
  const take = (n: number) => Math.max(1, Math.round(n * s));
  const groups: [number, StarKind, boolean][] = [
    [STAR_COUNTS.innerA, 0, true],
    [STAR_COUNTS.innerB, 1, true],
    [STAR_COUNTS.outerA, 0, false],
    [STAR_COUNTS.outerB, 1, false],
  ];
  const chosen: typeof candidates = [];
  for (const [n, kind, inner] of groups) {
    const start = candidates.length;
    place(n, kind, inner);
    chosen.push(...candidates.slice(start, start + take(n)));
  }

  // 灯る順: 暗転が明けたときの正面に近い明るい星を一つずつ（先触れ）、その後は正面から外へ広がる
  const fwd = input.revealForward.clone().normalize();
  const angle = (p: THREE.Vector3) => {
    tmp.subVectors(p, input.revealEye).normalize();
    return Math.acos(Math.min(1, Math.max(-1, tmp.dot(fwd))));
  };
  const order = chosen.map((c, i) => ({ i, a: angle(c.p) + rand() * 0.35, bright: c.kind === 1 }));
  const heralds = order
    .filter((o) => o.bright && o.a < 0.5 && chosen[o.i].p.distanceTo(input.revealEye) < 140)
    .sort((x, y) => x.a - y.a)
    .slice(0, 14);
  const heraldSet = new Set(heralds.map((h) => h.i));
  const rest = order.filter((o) => !heraldSet.has(o.i)).sort((x, y) => x.a - y.a);

  const count = chosen.length;
  const field: StarField = {
    count,
    kind: new Uint8Array(count),
    position: new Float32Array(count * 3),
    radius: new Float32Array(count),
    color: new Float32Array(count * 3),
    light: new Float32Array(count * 2),
  };
  const t0 = input.revealT;
  heralds.forEach((h, k) => (field.light[h.i * 2] = t0 + 0.7 + 0.55 * k));
  rest.forEach((o, k) => (field.light[o.i * 2] = t0 + 5.5 + 12.5 * Math.pow(k / Math.max(1, rest.length - 1), 0.85) + rand() * 0.6));
  chosen.forEach((c, i) => {
    field.kind[i] = c.kind;
    field.position.set([c.p.x, c.p.y, c.p.z], i * 3);
    field.radius[i] = c.r;
    field.color.set(c.c, i * 3);
    field.light[i * 2 + 1] = rand();
  });
  return field;
}
