// 雨の回廊の雨粒の配置と止まる時刻（純粋な計算。種を固定し、毎回同じ配置）。
// 雨は「中庭（屋根のない楕円）」と「回廊の外（ガラスの壁の向こう）」に降る。中庭ではレールの上に細いガラスの庇があり、
// 庇の下（レールから水平に DRY_HALF 以内）には降らない。ゴンドラは止まった雨粒の間をすり抜ける（RIDE-8 の 1.7m を保つ）。
// 止まる時刻は見どころ（5:10）を中心に、見どころの点から外へ波のように広がる（一粒ずつガラス玉に変わる）。
import type { Ride } from '../../contracts/ride';
import { seeded } from './blender-room';

/** 中庭の楕円（three の座標。Blender の rain.pool の extras「court」） */
export interface Court {
  readonly cx: number;
  readonly cz: number;
  /** 長軸の向き（水平の単位ベクトル） */
  readonly fx: number;
  readonly fz: number;
  readonly a: number;
  readonly b: number;
}

export function courtFromExtras(v: unknown): Court | null {
  if (!Array.isArray(v) || v.length < 6 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const [cx, cz, fx, fz, a, b] = v as number[];
  const n = Math.hypot(fx, fz) || 1;
  return { cx, cz, fx: fx / n, fz: fz / n, a, b };
}

/** 楕円の中か（scale で縮めた楕円） */
export function inCourt(c: Court, x: number, z: number, scale = 1): boolean {
  const dx = x - c.cx;
  const dz = z - c.cz;
  const u = dx * c.fx + dz * c.fz;
  const v = -dx * c.fz + dz * c.fx;
  return (u / (c.a * scale)) ** 2 + (v / (c.b * scale)) ** 2 < 1;
}

export interface RainPlanSpec {
  readonly court: Court;
  /** レールの区間（m） */
  readonly s0: number;
  readonly s1: number;
  /** 穹窿の終わりと始まり（中庭の口）。この間だけ屋根がない */
  readonly vaultIn: number;
  readonly vaultOut: number;
  /** 柱の位置（水平。中庭の柱を避ける） */
  readonly columns: readonly { x: number; z: number }[];
  /** 見どころの時刻と点（止まる波の中心） */
  readonly freezeT: number;
  readonly focus: { x: number; y: number; z: number };
  /** 粒の数の倍率（品質） */
  readonly scale: number;
  readonly seed: number;
}

/** 庇の下の乾いた筒の半幅（庇 1.95m ＋ 雨粒の大きさと余裕）。ゴンドラの表面から 0.5m（1.7m）より広い */
export const DRY_HALF = 2.15;
/** 回廊の外の雨の内側の端（ガラスの壁 3.4m の外） */
const OUTSIDE_U = 3.75;
/** 中庭の雨の数・外の雨の数（品質 high のとき）。中庭の半分強はレールの近く（手の届くあたり）に集める */
export const COURT_DROPS = 2600;
export const OUTSIDE_DROPS = 1500;
/** 庇の上の雨粒（庇に落ちて消える。止まると庇の上に浮かぶ） */
export const CANOPY_DROPS = 420;
/** 庇の上の面の高さ（雨はここで消える） */
export const CANOPY_TOP = 3.97;
/** 触れられる雨粒の数（品質によらない。触れて遊ぶ物なので減らさない） */
export const TOUCH_DROPS = 28;

export interface RainPlan {
  /** 雨粒（インスタンス）: 止まる位置 xyz と種、止まる時刻、半径、落ちる下の端の高さ */
  readonly rest: Float32Array;
  readonly freeze: Float32Array;
  readonly radius: Float32Array;
  readonly floor: Float32Array;
  readonly count: number;
  /** 触れられる雨粒（個別の物） */
  readonly touch: readonly { x: number; y: number; z: number; tf: number; r: number }[];
}

interface RailSample {
  readonly s: number;
  readonly x: number;
  readonly z: number;
  /** 進行方向の右（水平） */
  readonly rx: number;
  readonly rz: number;
}

function sampleRail(ride: Ride, s0: number, s1: number, step = 0.5): RailSample[] {
  const out: RailSample[] = [];
  for (let s = s0; s <= s1; s += step) {
    const p = ride.pointAt(s);
    // 前 (-sin yaw, -cos yaw)、右 (cos yaw, -sin yaw)
    out.push({ s, x: p.x, z: p.z, rx: Math.cos(p.yaw), rz: -Math.sin(p.yaw) });
  }
  return out;
}

/** 水平の最寄りのレールの点の s と、横の距離（右が正）、水平の距離 */
function nearestRail(samples: readonly RailSample[], x: number, z: number): { s: number; u: number; d: number } {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const dx = x - samples[i].x;
    const dz = z - samples[i].z;
    const d = dx * dx + dz * dz;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const r = samples[best];
  return { s: r.s, u: (x - r.x) * r.rx + (z - r.z) * r.rz, d: Math.sqrt(bd) };
}

/** 止まる時刻: 見どころの点から 10m/s の波（触れられる雨粒は 14m/s で先に止まる） */
function freezeTime(spec: RainPlanSpec, x: number, y: number, z: number, speed: number, jitter: number): number {
  const d = Math.hypot(x - spec.focus.x, y - spec.focus.y, z - spec.focus.z);
  return Math.min(spec.freezeT + 3.5, spec.freezeT - 1.0 + d / speed + jitter);
}

export function planRain(ride: Ride, spec: RainPlanSpec): RainPlan {
  const rnd = seeded(spec.seed);
  const rail = sampleRail(ride, spec.s0 - 6, spec.s1 + 3);
  const c = spec.court;
  const nearColumn = (x: number, z: number, r: number) => spec.columns.some((p) => Math.hypot(p.x - x, p.z - z) < r);
  const rest: number[] = [];
  const freeze: number[] = [];
  const radius: number[] = [];
  const floorY: number[] = [];
  const push = (x: number, y: number, z: number, tf: number, r: number, f = 0) => {
    rest.push(x, y, z, rnd());
    freeze.push(tf);
    radius.push(r);
    floorY.push(f);
  };

  // 中庭: 楕円の中（縁の壁から少し内側）、庇の下と柱のまわりを除く。55% はレールの左右 2.15〜4.2m に集める。
  // 品質を下げるときは外の雨から先に減らし、見どころの中庭の雨を残す
  const nCourt = Math.round(COURT_DROPS * courtScale(spec.scale));
  for (let tries = 0, n = 0; n < nCourt && tries < nCourt * 20; tries++) {
    let x: number;
    let z: number;
    let y: number;
    if (n < nCourt * 0.55) {
      const s = spec.vaultIn + rnd() * (spec.vaultOut - spec.vaultIn);
      const p = ride.pointAt(s);
      const u = (rnd() < 0.5 ? -1 : 1) * (DRY_HALF + 2.05 * rnd() ** 1.3);
      x = p.x + Math.cos(p.yaw) * u;
      z = p.z - Math.sin(p.yaw) * u;
      y = 0.35 + rnd() * 4.0;
      if (!inCourt(c, x, z, 0.95)) continue;
    } else {
      const th = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * 0.95;
      const u = c.a * rr * Math.cos(th);
      const v = c.b * rr * Math.sin(th);
      x = c.cx + u * c.fx - v * c.fz;
      z = c.cz + u * c.fz + v * c.fx;
      y = 0.25 + rnd() * 6.2;
    }
    const near = nearestRail(rail, x, z);
    if (near.d < DRY_HALF) continue;
    // 穹窿の下（中庭の口の近く）には降らない
    if (Math.abs(near.u) < 3.6 && (near.s < spec.vaultIn + 0.4 || near.s > spec.vaultOut - 0.4)) continue;
    if (nearColumn(x, z, 0.42)) continue;
    push(x, y, z, freezeTime(spec, x, y, z, 10, (rnd() - 0.5) * 0.5), 0.017 + rnd() * 0.017);
    n++;
  }
  // 庇の上: 庇（レールの真上）に落ちて消える雨。止まると、ゴンドラの頭上のガラス越しに浮かぶ
  const nCanopy = Math.round(CANOPY_DROPS * courtScale(spec.scale));
  for (let tries = 0, n = 0; n < nCanopy && tries < nCanopy * 20; tries++) {
    const s = spec.vaultIn + 0.6 + rnd() * (spec.vaultOut - spec.vaultIn - 1.2);
    const p = ride.pointAt(s);
    const u = (rnd() * 2 - 1) * (DRY_HALF - 0.25);
    const x = p.x + Math.cos(p.yaw) * u;
    const z = p.z - Math.sin(p.yaw) * u;
    const y = CANOPY_TOP + 0.25 + rnd() * 3.2;
    push(x, y, z, freezeTime(spec, x, y, z, 10, (rnd() - 0.5) * 0.5), 0.016 + rnd() * 0.014, CANOPY_TOP);
    n++;
  }
  // 回廊の外: 壁の向こう（壁ぎわを濃く）。中庭の楕円の中は中庭の雨が受け持つ
  const nOut = Math.round(OUTSIDE_DROPS * outsideScale(spec.scale));
  for (let tries = 0, n = 0; n < nOut && tries < nOut * 20; tries++) {
    const s = spec.s0 + 1 + rnd() * (spec.s1 - spec.s0 - 0.5);
    const p = ride.pointAt(s);
    const side = rnd() < 0.58 ? -1 : 1; // 曲がりの外側（左）に街が広い
    const u = side * (OUTSIDE_U + 18 * rnd() ** 2);
    const x = p.x + Math.cos(p.yaw) * u;
    const z = p.z - Math.sin(p.yaw) * u;
    if (inCourt(c, x, z, 1.04)) continue;
    const near = nearestRail(rail, x, z);
    if (near.d < OUTSIDE_U) continue;
    const y = rnd() * 12.5;
    push(x, y, z, freezeTime(spec, x, y, z, 10, (rnd() - 0.5) * 0.5), 0.02 + rnd() * 0.018);
    n++;
  }
  // 触れられる雨粒: 中庭のレールの左右、手の届く高さ（レールから水平に 2.25〜2.85m）
  const touch: { x: number; y: number; z: number; tf: number; r: number }[] = [];
  const sA = Math.max(spec.vaultIn + 1.2, spec.s0);
  const sB = Math.min(spec.vaultOut - 1.2, spec.s1);
  // 中庭の区間に散らす（柱のまわりと、ほかの触れられる雨粒の近くは避ける）
  for (let tries = 0; touch.length < TOUCH_DROPS && tries < 20000; tries++) {
    const s = sA + rnd() * (sB - sA);
    const p = ride.pointAt(s);
    const side = rnd() < 0.5 ? -1 : 1;
    const u = side * (2.25 + rnd() * 0.65);
    const x = p.x + Math.cos(p.yaw) * u;
    const z = p.z - Math.sin(p.yaw) * u;
    const y = p.y - 0.55 + rnd() * 1.55;
    if (nearColumn(x, z, 0.45)) continue;
    if (nearestRail(rail, x, z).d < 2.2) continue;
    if (touch.some((q) => Math.hypot(q.x - x, q.y - y, q.z - z) < 0.75)) continue;
    const tf = freezeTime(spec, x, y, z, 14, (rnd() - 0.5) * 0.15);
    // 落ちてくる筋はインスタンスの雨に入れる（止まる時刻に個別の雨粒へ替わる）
    touch.push({ x, y, z, tf, r: 0.042 + rnd() * 0.01 });
  }
  return { rest: Float32Array.from(rest), freeze: Float32Array.from(freeze), radius: Float32Array.from(radius), floor: Float32Array.from(floorY), count: freeze.length, touch };
}

/** 品質の粒の倍率（0〜1）→ 中庭の雨の倍率。見どころなので減らし方を緩く（low の 0.4 で 7 割） */
export function courtScale(particleScale: number): number {
  const k = Math.min(1, Math.max(0, particleScale));
  return 0.5 + 0.5 * k;
}

/** 品質の粒の倍率 → 回廊の外の雨の倍率。先に減らす（low の 0.4 で 1.6 割） */
export function outsideScale(particleScale: number): number {
  const k = Math.min(1, Math.max(0, particleScale));
  return k * k;
}

/** 流れの時刻: 雨が止まると、ゆっくり（d 秒で）止まる。ガラスを伝う水と波紋はこの時刻で動く */
export function flowTime(t: number, freezeT: number, d = 0.5): number {
  if (t <= freezeT) return t;
  return freezeT + d * (1 - Math.exp(-(t - freezeT) / d));
}
