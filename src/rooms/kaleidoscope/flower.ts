// 万華鏡の間の見どころ（7:20）: 散らばったガラス片が集まって、前方に巨大な花の模様を描く。
// 位置は時刻だけから決める（集まる・咲いている・ほどけて壁ぎわへ戻る）。ガラス片は筒の軸のまわりの円筒座標で動かし、
// 軸からの距離は常に MIN_RADIUS 以上（ゴンドラの表面から 0.5m を保ち、画面効果の折り返しの境より遠い）。

/** 軸からの最小の距離（m）。ゴンドラの半径 1.2 + 0.5 = 1.7 に、ガラス片の大きさと余裕を足す */
export const MIN_RADIUS = 2.45;
/** 花びらの数 */
export const PETALS = 12;
/** 花の内と外の半径 */
export const FLOWER_R0 = 2.7;
export const FLOWER_R1 = 4.3;

/** 円筒座標（s: レール上の距離、ang: 右から上へのラジアン、rad: 軸からの距離） */
export interface Cyl {
  s: number;
  ang: number;
  rad: number;
}

export interface FlowerTiming {
  /** 花が咲きそろう時刻（見どころ） */
  readonly flowerT: number;
  /** 集まり始めてから咲きそろうまで（秒） */
  readonly gatherSec: number;
  /** ほどけ始める時刻（ゴンドラが花を抜けた後） */
  readonly releaseT: number;
  readonly releaseSec: number;
}

const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** i 番目のガラス片の花の中の位置（花の面の上の角度と半径）と、花びらの縁に沿う向き（面の上の角度） */
export function flowerSlot(i: number, n: number): { ang: number; rad: number; tilt: number } {
  // 花びらごとに、中心線と左右の縁に沿って並べる
  const perPetal = Math.max(3, Math.floor(n / PETALS));
  const p = i % PETALS;
  const k = Math.floor(i / PETALS) % perPetal;
  const lane = k % 3; // 0: 中心線、1: 左の縁、2: 右の縁
  const u = (Math.floor(k / 3) + 0.5) / Math.ceil(perPetal / 3);
  const rad = FLOWER_R0 + (FLOWER_R1 - FLOWER_R0) * u;
  const half = 0.2 * Math.sin(Math.PI * u) ** 0.8; // 花びらの半分の開き（ラジアン）
  const side = lane === 0 ? 0 : lane === 1 ? -1 : 1;
  const ang = (2 * Math.PI * p) / PETALS + side * half;
  // 縁の向き: 中心線は放射、縁は花びらの輪郭に沿って少し傾く
  const tilt = side * 0.5 * Math.cos(Math.PI * u);
  return { ang, rad, tilt };
}

/**
 * 時刻 t の集まり具合（0: 家（壁ぎわ）、1: 花）。i ごとに少しずらして集まる（一斉ではなく、次々に）。
 */
export function gatherAt(t: number, timing: FlowerTiming, i: number): number {
  const stagger = ((i * 0.618034) % 1) * 2.2;
  const start = timing.flowerT - timing.gatherSec;
  const g = ease((t - start - stagger) / (timing.gatherSec - 2.2));
  const r = ease((t - timing.releaseT - ((i * 0.381966) % 1) * 2) / timing.releaseSec);
  return g * (1 - r);
}

/** 家と花の間の円筒座標の補間（角度は近い向きへ。半径は弧を描いて少しふくらみ、MIN_RADIUS を下回らない） */
export function lerpCyl(a: Cyl, b: Cyl, g: number, out: Cyl): Cyl {
  let d = b.ang - a.ang;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  out.s = a.s + (b.s - a.s) * g;
  out.ang = a.ang + d * g;
  out.rad = Math.max(MIN_RADIUS, a.rad + (b.rad - a.rad) * g + Math.sin(Math.PI * g) * 0.35);
  return out;
}
