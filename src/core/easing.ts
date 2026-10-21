// 動きの曲線。案1と共有する（遷移の仕組み）。
// 「ゆっくり始まって粘りながら止まる」曲線は両作品で1つ。実体は案1の transition/curve.ts の glassEase（0.5.0 で統一）。
import { glassEase } from './transition/curve';

const clamp01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/**
 * ガラスの曲線。transition/curve.ts の glassEase（cubic-bezier(0.55, 0, 0.2, 1)）と同じ値を返す。
 * f(0)=0、f(1)=1、単調増加で行き過ぎない。立ち上がりはゆっくり、終わりは粘って止まる（中点は 0.5 を大きく超え、約 0.73）。
 * 0.5.0 より前の easeGlass（3次と指数の混ぜもの）とは値が違う。呼び出し側を変えずに曲線だけを1つにするための薄い別名。
 * 範囲外は 0〜1 に畳む（glassEase 自体が畳む）。
 */
export function easeGlass(t: number): number {
  return glassEase(t);
}

export function easeInOutSine(t: number): number {
  const x = clamp01(t);
  return -(Math.cos(Math.PI * x) - 1) / 2;
}

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 角度の差を -π〜π に畳む */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let x = (a + Math.PI) % twoPi;
  if (x < 0) x += twoPi;
  return x - Math.PI;
}

/**
 * 値を時間で目標へ寄せる（フレームレートに依らない指数の追従）。
 * halfLife 秒で差が半分になる。
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  return target + (current - target) * 2 ** (-dt / halfLife);
}
