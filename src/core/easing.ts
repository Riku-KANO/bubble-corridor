// 動きの曲線。案1と共有する（遷移の仕組み）。
// 「ゆっくり始まって粘りながら止まる」曲線を両作品で揃える（設計書「遷移のルール」5）。

const clamp01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/**
 * ガラスの曲線。立ち上がりはゆっくり（3次）、終わりは指数的に粘って止まる。
 * f(0)=0、f(1)=1、単調増加。中点は 0.5 より少し先（0.55 前後）に来る。
 */
export function easeGlass(t: number): number {
  const x = clamp01(t);
  // ゆっくり始まる部分（easeInCubic）と、粘って止まる部分（easeOutExpo）を滑らかに混ぜる
  const inPart = x * x * x;
  const outPart = x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
  const w = x * x * (3 - 2 * x);
  return inPart * (1 - w) + outPart * w;
}

export function easeInOutSine(t: number): number {
  const x = clamp01(t);
  return -(Math.cos(Math.PI * x) - 1) / 2;
}

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
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
  return target + (current - target) * Math.pow(2, -dt / halfLife);
}
