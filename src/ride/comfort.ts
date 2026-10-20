// 動きの上限の検査（RIDE-2、RIDE-4）。poseAt と同じ式で時刻を細かく進めて測る。
// 標準は config の MOTION のとおり。穏やかは上下と向きの回転の上限を MOTION.gentleFactor 倍にして測る。
// レールは1本（ADR-0008）なので、穏やかの検査は「標準の動きが穏やかの上限以内に収まっている」ことの確認になる。
import { MOTION } from '../config';
import type { ComfortMode } from '../contracts/ids';
import type { ComfortViolation, RideData, RidePose } from '../contracts/ride';
import { wrapAngle } from '../core/easing';
import { createRide } from './rail';

/** 測る間隔（秒） */
const DT = 0.1;
/** 加速度を測る窓（秒）。数値の揺れを拾わない */
const ACCEL_WINDOW = 0.5;
/** 速度の変化とみなす傾き（m/s²）の下限と、検査する変化の大きさ（m/s） */
const RAMP_SLOPE_MIN = 0.02;
const RAMP_DELTA_MIN = 0.25;

interface Samples {
  readonly n: number;
  readonly speed: Float64Array;
  readonly y: Float64Array;
  /** 向きの変化（ラジアン）。i は i-1 → i */
  readonly dyaw: Float64Array;
}

function sample(data: RideData, mode: ComfortMode): Samples {
  const ride = createRide(data);
  const n = Math.floor(data.duration / DT + 1e-9) + 1;
  const speed = new Float64Array(n);
  const y = new Float64Array(n);
  const dyaw = new Float64Array(n);
  const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
  let prevYaw = 0;
  for (let i = 0; i < n; i++) {
    ride.poseAt(i * DT, mode, pose);
    speed[i] = pose.speed;
    y[i] = pose.y;
    if (i > 0) dyaw[i] = wrapAngle(pose.yaw - prevYaw);
    prevYaw = pose.yaw;
  }
  return { n, speed, y, dyaw };
}

/** 測った値の列（values[i] は区間 [t0(i), t1(i)] の値）から、上限を超えた連続区間をまとめる */
function overLimit(
  kind: ComfortViolation['kind'],
  n: number,
  value: (i: number) => number,
  span: (i: number) => readonly [number, number],
  from: number,
  limit: number,
): ComfortViolation[] {
  const out: ComfortViolation[] = [];
  let start = -1;
  let peak = 0;
  let t0 = 0;
  let t1 = 0;
  const flush = () => {
    if (start >= 0) out.push({ kind, t0, t1, peak, limit });
    start = -1;
  };
  for (let i = from; i < n; i++) {
    const v = value(i);
    if (v > limit + 1e-9) {
      const [a, b] = span(i);
      if (start < 0) {
        start = i;
        peak = v;
        t0 = a;
      } else peak = Math.max(peak, v);
      t1 = b;
    } else flush();
  }
  flush();
  return out;
}

/**
 * 速度の変化（上り・下りの一続き）が speedChangeMinSec 未満で起きた区間。小さな変化は数えない。
 * 下限の検査なので、peak は変化にかかった秒数（limit を下回る）。
 */
function shortSpeedChanges(speed: Float64Array, n: number): ComfortViolation[] {
  const out: ComfortViolation[] = [];
  let dir = 0;
  let i0 = 0;
  let acc = 0;
  const close = (i1: number) => {
    const dur = (i1 - i0) * DT;
    if (dir !== 0 && Math.abs(acc) >= RAMP_DELTA_MIN && dur < MOTION.speedChangeMinSec - 1e-9) {
      out.push({ kind: 'speedChange', t0: i0 * DT, t1: i1 * DT, peak: dur, limit: MOTION.speedChangeMinSec });
    }
  };
  for (let i = 1; i < n; i++) {
    const dv = speed[i] - speed[i - 1];
    const d = Math.abs(dv) < RAMP_SLOPE_MIN * DT ? 0 : Math.sign(dv);
    if (d !== dir) {
      close(i - 1);
      dir = d;
      i0 = i - 1;
      acc = 0;
    }
    if (d !== 0) acc += dv;
  }
  close(n - 1);
  return out;
}

/** 動きの上限（config の MOTION）を超える区間の一覧。穏やかでは上下と回転の上限を半分にして測る */
export function analyzeComfort(data: RideData, mode: ComfortMode): ComfortViolation[] {
  const { n, speed, y, dyaw } = sample(data, mode);
  const k = mode === 'gentle' ? MOTION.gentleFactor : 1;
  const w = Math.max(1, Math.round(ACCEL_WINDOW / DT));
  const deg = 180 / Math.PI;
  return [
    ...overLimit('speed', n, (i) => speed[i], (i) => [i * DT, i * DT], 0, MOTION.speedMax),
    ...overLimit('accel', n, (i) => Math.abs(speed[i] - speed[i - w]) / (w * DT), (i) => [(i - w) * DT, i * DT], w, MOTION.accelMax),
    ...shortSpeedChanges(speed, n),
    ...overLimit('vertical', n, (i) => Math.abs(y[i] - y[i - 1]) / DT, (i) => [(i - 1) * DT, i * DT], 1, MOTION.verticalMax * k),
    ...overLimit('yawRate', n, (i) => (Math.abs(dyaw[i]) * deg) / DT, (i) => [(i - 1) * DT, i * DT], 1, MOTION.yawRateMaxDeg * k),
  ];
}

/** 測った最大値（確認ページと scripts/comfort.ts の表示用） */
export interface ComfortPeaks {
  readonly speed: number;
  readonly accel: number;
  readonly vertical: number;
  /** 度/秒 */
  readonly yawRate: number;
}

export function comfortPeaks(data: RideData, mode: ComfortMode): ComfortPeaks {
  const { n, speed, y, dyaw } = sample(data, mode);
  const w = Math.max(1, Math.round(ACCEL_WINDOW / DT));
  let sp = 0;
  let ac = 0;
  let ve = 0;
  let ya = 0;
  for (let i = 0; i < n; i++) {
    sp = Math.max(sp, speed[i]);
    if (i >= w) ac = Math.max(ac, Math.abs(speed[i] - speed[i - w]) / (w * DT));
    if (i >= 1) {
      ve = Math.max(ve, Math.abs(y[i] - y[i - 1]) / DT);
      ya = Math.max(ya, (Math.abs(dyaw[i]) * 180) / Math.PI / DT);
    }
  }
  return { speed: sp, accel: ac, vertical: ve, yawRate: ya };
}
