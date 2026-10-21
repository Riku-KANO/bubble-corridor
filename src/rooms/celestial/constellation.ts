// 9:50 の星座「ガラスの街」。中心にたどり着くと、周りの星が線でつながり、案1 の街ハリノの姿を描く。
// ハリノ（through-the-vidro の設計書）: 中央の灯塔の頂に大きなガラス玉、泡の集まりの建物（角のある形は一つもない）、
// 放射状の3つの区画（泡の工房街の煙突、水路の雫塔、温室のドーム）。
// 中心（9:50 のゴンドラの目）から見た向きで描く: u は正面からの左右の角度（右が正、度）、v は仰角（度）。
// レールは中心の先で正面のやや下（v ≈ -6°）を通り抜けるので、街の地面の線はそれより上に置く。
import * as THREE from 'three/webgpu';

export interface CityPoint {
  readonly u: number;
  readonly v: number;
}

export interface CityStroke {
  readonly pts: readonly CityPoint[];
  /** 描き始める時刻（見どころの時刻からの秒。負は前） */
  readonly start: number;
  /** 描き終わるまでの秒 */
  readonly duration: number;
}

/** 地面の線（中心が高い、なだらかな丘） */
export function groundV(u: number): number {
  return -1.6 - 2.8 * (u / 46) ** 2;
}

function arc(cu: number, cv: number, ru: number, rv: number, a0: number, a1: number, n: number): CityPoint[] {
  const out: CityPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push({ u: cu + ru * Math.cos(a), v: cv + rv * Math.sin(a) });
  }
  return out;
}

const circle = (cu: number, cv: number, r: number, n: number, from = -90) => arc(cu, cv, r, r, from, from + 360, n);
/** 地面に立つ半円のドーム（左の付け根から右の付け根へ） */
const dome = (cu: number, r: number, n: number) => arc(cu, groundV(cu), r, r, 180, 0, n);
const lenOf = (pts: readonly CityPoint[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.u - pts[i].u, p.v - pts[i].v), 0);

/** 外側の建物から内へ、最後に灯塔と玉。描き終わりは見どころの 0.3 秒前（撮影の瞬間には街が描き上がっている） */
function building(cu: number, pts: CityPoint[]): CityStroke {
  const start = -3.3 + ((46 - Math.abs(cu)) / 46) * 1.5;
  return { pts, start, duration: Math.min(0.95, Math.max(0.4, lenOf(pts) / 28)) };
}

/** 灯塔の胴の半幅（地面からの高さ h、度） */
function towerHalfWidth(h: number): number {
  const keys: [number, number][] = [
    [0, 3.0],
    [2.5, 1.6],
    [5.5, 1.25],
    [8.5, 2.4],
    [11.5, 1.25],
    [16.5, 0.95],
    [18.5, 1.7],
  ];
  for (let i = 1; i < keys.length; i++) {
    if (h <= keys[i][0]) {
      const [h0, w0] = keys[i - 1];
      const [h1, w1] = keys[i];
      const k = (h - h0) / (h1 - h0);
      const s = k * k * (3 - 2 * k);
      return w0 + (w1 - w0) * s;
    }
  }
  return keys[keys.length - 1][1];
}

export function cityStrokes(): CityStroke[] {
  const strokes: CityStroke[] = [];
  // 地面: 中心から左右へ
  const groundL: CityPoint[] = [];
  const groundR: CityPoint[] = [];
  for (let u = 0; u <= 46; u += 4) {
    groundL.push({ u: -u, v: groundV(-u) });
    groundR.push({ u, v: groundV(u) });
  }
  strokes.push({ pts: groundL, start: -4.0, duration: 1.0 }, { pts: groundR, start: -4.0, duration: 1.0 });

  // 泡の工房街（左）: 大小のドーム、頂の泡、煙突と煙の泡
  strokes.push(building(-39.5, dome(-39.5, 4.2, 6)));
  strokes.push(building(-31, dome(-31, 6.2, 9)));
  strokes.push(building(-31, circle(-31, groundV(-31) + 6.2 + 1.5, 1.5, 6)));
  strokes.push(building(-22, dome(-22, 3.8, 6)));
  const cg = groundV(-15.6);
  strokes.push(building(-15.6, [
    { u: -16.6, v: cg },
    { u: -16.6, v: cg + 9.5 },
    { u: -14.6, v: cg + 9.5 },
    { u: -14.6, v: cg },
  ]));
  strokes.push(building(-14, circle(-14.0, cg + 12.4, 1.1, 6)));
  strokes.push(building(-13, circle(-12.3, cg + 15.5, 1.4, 6)));
  strokes.push(building(-9, dome(-8.6, 3.2, 5)));

  // 水路の雫塔（右）: 雫の形の塔
  const dg = groundV(12.5);
  strokes.push(building(12.5, [
    { u: 10.6, v: dg },
    { u: 9.8, v: dg + 3 },
    { u: 10.1, v: dg + 6.5 },
    { u: 11.2, v: dg + 10 },
    { u: 12.5, v: dg + 13.5 },
    { u: 13.8, v: dg + 10 },
    { u: 14.9, v: dg + 6.5 },
    { u: 15.2, v: dg + 3 },
    { u: 14.4, v: dg },
  ]));
  // 温室のドーム（右）: 大きな半円と2本の肋、頂の小さな灯り
  strokes.push(building(29, dome(29, 9, 12)));
  strokes.push(building(27, arc(29, groundV(29), 4.5, 9, 180, 90, 5)));
  strokes.push(building(31, arc(29, groundV(29), 4.5, 9, 0, 90, 5)));
  strokes.push(building(29, circle(29, groundV(29) + 10.4, 1.3, 6)));
  // 泡の家（右の端）
  strokes.push(building(39.5, circle(39.5, groundV(39.5) + 2.4, 2.4, 8)));
  strokes.push(building(43.6, circle(43.6, groundV(43.6) + 1.7, 1.7, 6)));

  // 灯塔: 胴の左右を下から上へ、頂の台
  const g0 = groundV(0);
  const left: CityPoint[] = [];
  const right: CityPoint[] = [];
  for (let h = 0; h <= 18.5; h += 1.5) {
    const w = towerHalfWidth(h);
    left.push({ u: -w, v: g0 + h });
    right.push({ u: w, v: g0 + h });
  }
  strokes.push({ pts: left, start: -1.8, duration: 0.85 }, { pts: right, start: -1.8, duration: 0.85 });
  strokes.push({ pts: [{ u: -1.7, v: g0 + 18.5 }, { u: 1.7, v: g0 + 18.5 }], start: -0.98, duration: 0.2 });
  // 大玉と、その中の灯り、放たれる光
  const orbR = 5.4;
  const orbV = g0 + 18.5 + orbR + 0.2;
  strokes.push({ pts: circle(0, orbV, orbR, 16), start: -0.95, duration: 0.6 });
  strokes.push({ pts: circle(0, orbV, 1.6, 6), start: -0.5, duration: 0.3 });
  for (const a of [12, 50, 90, 130, 168]) {
    const r = (a * Math.PI) / 180;
    strokes.push({
      pts: [
        { u: Math.cos(r) * (orbR + 1.0), v: orbV + Math.sin(r) * (orbR + 1.0) },
        { u: Math.cos(r) * (orbR + 3.4), v: orbV + Math.sin(r) * (orbR + 3.4) },
      ],
      start: -0.4,
      duration: 0.25,
    });
  }
  return strokes;
}

/** 街の中心（見どころの向き。誘導と正面へ戻すカメラが向く所）。灯塔の胴の真ん中あたり */
export const CITY_FOCUS: CityPoint = { u: 0, v: 9 };

/** 中心から街までの距離（m）。殻（22m と 33m）のあいだ */
export function cityDistance(p: CityPoint): number {
  return 28 + 1.1 * Math.sin(p.u * 0.11 + p.v * 0.05);
}

export interface CityFrame {
  readonly eye: THREE.Vector3;
  readonly forward: THREE.Vector3;
  readonly right: THREE.Vector3;
}

export function cityPosition(f: CityFrame, p: CityPoint, out = new THREE.Vector3()): THREE.Vector3 {
  const u = (p.u * Math.PI) / 180;
  const v = (p.v * Math.PI) / 180;
  const r = cityDistance(p);
  return out
    .copy(f.forward)
    .multiplyScalar(Math.cos(v) * Math.cos(u) * r)
    .addScaledVector(f.right, Math.cos(v) * Math.sin(u) * r)
    .addScaledVector(THREE.Object3D.DEFAULT_UP, Math.sin(v) * r)
    .add(f.eye);
}

export interface CitySegment {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  /** 描き始める時刻と長さ（乗車の頭からの秒） */
  readonly t0: number;
  readonly duration: number;
}

export interface CityLayout {
  readonly segments: readonly CitySegment[];
  /** 星（線の端）。重なる点は1つにまとめる */
  readonly stars: readonly THREE.Vector3[];
  /** 線がその星に届く時刻 */
  readonly joinAt: readonly number[];
}

/** 街の線と星を世界座標に置く。focusT は見どころの時刻 */
export function layoutCity(f: CityFrame, focusT: number): CityLayout {
  const segments: CitySegment[] = [];
  const keys: CityPoint[] = [];
  const stars: THREE.Vector3[] = [];
  const joinAt: number[] = [];
  const addStar = (p: CityPoint, t: number) => {
    const i = keys.findIndex((k) => Math.hypot(k.u - p.u, k.v - p.v) < 0.35);
    if (i >= 0) {
      joinAt[i] = Math.min(joinAt[i], t);
      return;
    }
    keys.push(p);
    stars.push(cityPosition(f, p));
    joinAt.push(t);
  };
  for (const s of cityStrokes()) {
    const total = lenOf(s.pts);
    let acc = 0;
    addStar(s.pts[0], focusT + s.start);
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1];
      const b = s.pts[i];
      const len = Math.hypot(b.u - a.u, b.v - a.v);
      const t0 = focusT + s.start + (s.duration * acc) / total;
      const dur = (s.duration * len) / total;
      acc += len;
      segments.push({ a: cityPosition(f, a), b: cityPosition(f, b), t0, duration: Math.max(0.02, dur) });
      addStar(b, t0 + dur);
    }
  }
  return { segments, stars, joinAt };
}
