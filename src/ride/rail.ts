// レール上の位置を時刻から決める（物理エンジンは使わない）。
//
// - 時刻 t → レール上の距離 s: 時刻表（rail.json の timeline）の点を、単調な3次エルミートで滑らかにつなぐ。
//   点（0.25秒ごと）の上では表の値そのもの。間は線形ではなく滑らかにして、speed（= s の傾き）が階段にならないようにする。
// - 距離 s → 位置と向き: 点列（1m 間隔）を Catmull-Rom で補間し、向きは曲線の接線。
// - 穏やかモード: 同じ s(t)・x・z。高さは gentleY（上下を半分にした高さ）、向きは標準の向きに 7.5°/s 未満でゆっくり追従する。
//   追従は履歴に依存するので、createRide のときに時刻の表（0.05秒ごと）にしておく（poseAt は t だけで決まる）。
import { MOTION, SEC_PER_BAR, SECTIONS } from '../config';
import type { ComfortMode, SectionId } from '../contracts/ids';
import type { Ride, RideData, RidePose } from '../contracts/ride';

/** 穏やかモードの向きの追従の時定数（秒）。小さいほど標準の向きに速く追いつく */
const GENTLE_YAW_TAU = 1.5;
/** 穏やかモードの向きの表の細かさ（秒） */
const GENTLE_YAW_DT = 0.05;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 区間の開始の小節。時刻は小節から計算する（浮動小数点の端で区間が食い違わないよう小節で比べる） */
const SECTION_STARTS: readonly { id: SectionId; bar: number; t0: number; t1: number }[] = SECTIONS.map((s) => ({
  id: s.id,
  bar: s.startBar,
  t0: s.startBar * SEC_PER_BAR,
  t1: (s.startBar + s.bars) * SEC_PER_BAR,
}));

export function sectionIndexAt(t: number): number {
  const bar = t / SEC_PER_BAR;
  for (let i = SECTION_STARTS.length - 1; i > 0; i--) if (bar >= SECTION_STARTS[i].bar - 1e-9) return i;
  return 0;
}

/** 単調な3次エルミートの節の傾き（Fritsch–Carlson）。s が一定の区間では傾き 0 */
function nodeSlopes(t: Float64Array, s: Float64Array): Float64Array {
  const n = t.length;
  const m = new Float64Array(n);
  if (n < 2) return m;
  const h = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = t[i + 1] - t[i];
    d[i] = (s[i + 1] - s[i]) / h[i];
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * h[i] + d[i] * h[i - 1]) / (h[i - 1] + h[i]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    if (m[i] / d[i] < 0) m[i] = 0;
    if (m[i + 1] / d[i] < 0) m[i + 1] = 0;
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const r = a * a + b * b;
    if (r > 9) {
      const k = 3 / Math.sqrt(r);
      m[i] = k * a * d[i];
      m[i + 1] = k * b * d[i];
    }
  }
  return m;
}

export function createRide(data: RideData): Ride {
  // ── 点列 ──
  const pts = data.rail.points;
  const n = pts.length;
  const spacing = data.rail.spacing;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  const gy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = pts[i][0];
    py[i] = pts[i][1];
    pz[i] = pts[i][2];
    gy[i] = data.gentleY && data.gentleY.length === n ? data.gentleY[i] : pts[i][1];
  }
  const maxS = (n - 1) * spacing;

  // ── 時刻表 ──
  const tl = data.timeline;
  const m = tl.length;
  const tt = new Float64Array(m);
  const ss = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    tt[i] = tl[i].t;
    ss[i] = tl[i].s;
  }
  const slopes = nodeSlopes(tt, ss);
  const duration = data.duration;

  // 今の時刻の距離と速さ（evalTime が書く。確保しないための作業用）
  let curS = 0;
  let curV = 0;
  let seg = 0;
  function evalTime(t: number): void {
    const x = clamp(t, 0, duration);
    if (m < 2) {
      curS = m === 1 ? ss[0] : 0;
      curV = 0;
      return;
    }
    // 直前の節を覚えておき、近くなら探し直さない（時刻は普通は少しずつ進む）
    if (!(x >= tt[seg] && x <= tt[seg + 1])) {
      let lo = 0;
      let hi = m - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tt[mid] <= x) lo = mid;
        else hi = mid - 1;
      }
      seg = lo;
    }
    const h = tt[seg + 1] - tt[seg];
    const u = clamp((x - tt[seg]) / h, 0, 1);
    const u2 = u * u;
    const u3 = u2 * u;
    const s0 = ss[seg];
    const s1 = ss[seg + 1];
    const m0 = slopes[seg];
    const m1 = slopes[seg + 1];
    curS = (2 * u3 - 3 * u2 + 1) * s0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * s1 + (u3 - u2) * h * m1;
    curV = ((6 * u2 - 6 * u) * (s0 - s1)) / h + (3 * u2 - 4 * u + 1) * m0 + (3 * u2 - 2 * u) * m1;
  }

  // ── レール上の位置（Catmull-Rom） ──
  let rx = 0;
  let ry = 0;
  let rz = 0;
  let ryaw = 0;
  /** 端の外側の点は折り返して作る（端の接線が曲がらない） */
  const at = (arr: Float64Array, k: number): number => {
    if (k < 0) return 2 * arr[0] - arr[1];
    if (k >= n) return 2 * arr[n - 1] - arr[n - 2];
    return arr[k];
  };
  function evalRail(s: number, gentle: boolean): void {
    if (n < 2) {
      rx = n === 1 ? px[0] : 0;
      ry = n === 1 ? py[0] : 0;
      rz = n === 1 ? pz[0] : 0;
      ryaw = 0;
      return;
    }
    const u = clamp(s, 0, maxS) / spacing;
    const i = Math.min(n - 2, Math.floor(u));
    const f = u - i;
    const f2 = f * f;
    const f3 = f2 * f;
    // Catmull-Rom の係数（値と傾き）
    const w0 = 0.5 * (-f3 + 2 * f2 - f);
    const w1 = 0.5 * (3 * f3 - 5 * f2 + 2);
    const w2 = 0.5 * (-3 * f3 + 4 * f2 + f);
    const w3 = 0.5 * (f3 - f2);
    const d0 = 0.5 * (-3 * f2 + 4 * f - 1);
    const d1 = 0.5 * (9 * f2 - 10 * f);
    const d2 = 0.5 * (-9 * f2 + 8 * f + 1);
    const d3 = 0.5 * (3 * f2 - 2 * f);
    const yArr = gentle ? gy : py;
    rx = w0 * at(px, i - 1) + w1 * px[i] + w2 * px[i + 1] + w3 * at(px, i + 2);
    rz = w0 * at(pz, i - 1) + w1 * pz[i] + w2 * pz[i + 1] + w3 * at(pz, i + 2);
    ry = w0 * at(yArr, i - 1) + w1 * yArr[i] + w2 * yArr[i + 1] + w3 * at(yArr, i + 2);
    const dx = d0 * at(px, i - 1) + d1 * px[i] + d2 * px[i + 1] + d3 * at(px, i + 2);
    const dz = d0 * at(pz, i - 1) + d1 * pz[i] + d2 * pz[i + 1] + d3 * at(pz, i + 2);
    // three.js の rotation.y: 前方 (0,0,-1) を yaw 回すと (-sin yaw, 0, -cos yaw)
    ryaw = dx * dx + dz * dz > 1e-18 ? Math.atan2(-dx, -dz) : ryaw;
  }

  // ── 穏やかモードの向き（標準の向きとの差を時刻の表にする） ──
  const gn = Math.floor(duration / GENTLE_YAW_DT + 1e-9) + 1;
  const gentleYawDiff = new Float64Array(gn);
  {
    const maxRate = MOTION.yawRateMaxDeg * MOTION.gentleFactor * 0.97 * (Math.PI / 180);
    let prevStd = 0;
    let std = 0;
    let follower = 0;
    for (let k = 0; k < gn; k++) {
      evalTime(k * GENTLE_YAW_DT);
      evalRail(curS, false);
      // 標準の向きを 2π をまたいでつなげる
      if (k === 0) std = ryaw;
      else std += ((ryaw - prevStd + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      prevStd = ryaw;
      if (k === 0) follower = std;
      else follower += clamp((std - follower) / GENTLE_YAW_TAU, -maxRate, maxRate) * GENTLE_YAW_DT;
      gentleYawDiff[k] = follower - std;
    }
    seg = 0;
  }
  function gentleDiffAt(t: number): number {
    const x = clamp(t, 0, duration) / GENTLE_YAW_DT;
    const i = Math.min(gn - 2, Math.floor(x));
    if (gn < 2) return 0;
    const f = x - i;
    return gentleYawDiff[i] * (1 - f) + gentleYawDiff[i + 1] * f;
  }

  /** 距離 s に最初に着く時刻（穏やかモードの向きを s から引くため）。止まっている間は最初の時刻 */
  function timeOfS(s: number): number {
    if (m < 2) return 0;
    let lo = 0;
    let hi = m - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ss[mid] >= s) hi = mid;
      else lo = mid + 1;
    }
    if (lo === 0) return tt[0];
    const a = ss[lo - 1];
    const b = ss[lo];
    return b > a ? tt[lo - 1] + ((s - a) / (b - a)) * (tt[lo] - tt[lo - 1]) : tt[lo];
  }

  // ── 区間 ──
  const sectionTime: Ride['sectionTime'] = (id) => {
    const sec = SECTION_STARTS.find((x) => x.id === id)!;
    return { t0: sec.t0, t1: sec.t1 };
  };
  const sectionAt = (t: number): SectionId => SECTION_STARTS[sectionIndexAt(t)].id;
  const sectionSpan: Ride['sectionSpan'] = (id) => {
    const sec = data.sections.find((x) => x.id === id);
    if (!sec) return { s0: 0, s1: 0 };
    return { s0: sec.s0, s1: sec.s1 };
  };

  return {
    data,
    poseAt(t: number, mode: ComfortMode, out: RidePose): RidePose {
      const x = clamp(t, 0, duration);
      evalTime(x);
      const gentle = mode === 'gentle';
      evalRail(curS, gentle);
      out.x = rx;
      out.y = ry;
      out.z = rz;
      out.yaw = gentle ? ryaw + gentleDiffAt(x) : ryaw;
      out.speed = curV;
      out.s = curS;
      const si = sectionIndexAt(x);
      const sec = SECTION_STARTS[si];
      out.section = sec.id;
      out.sectionProgress = clamp((x - sec.t0) / (sec.t1 - sec.t0), 0, 1);
      return out;
    },
    pointAt(s: number, mode: ComfortMode = 'standard') {
      const gentle = mode === 'gentle';
      evalRail(s, gentle);
      return { x: rx, y: ry, z: rz, yaw: gentle ? ryaw + gentleDiffAt(timeOfS(s)) : ryaw };
    },
    sectionAt,
    sectionTime,
    sectionSpan,
  };
}
