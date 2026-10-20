// S-10 動きの上限と穏やかモード（親が作成。実装担当は変更しない）
import { describe, expect, it } from 'vitest';
import type { Vec3Tuple } from '../contracts/events';
import type { ComfortMode } from '../contracts/ids';
import type { RideData, RidePose } from '../contracts/ride';
import { MOTION, RIDE_DURATION } from '../config';
import { wrapAngle } from '../core/easing';
import { analyzeComfort, createRide, generateRideData } from './index';

const data = generateRideData();
const ride = createRide(data);
const DEG = Math.PI / 180;

/** 公開の poseAt から測る（analyzeComfort の実装に頼らない二重の確認） */
function measure(mode: ComfortMode, dt = 0.1) {
  const p = (): RidePose => ({ x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 });
  let prev = ride.poseAt(0, mode, p());
  let maxV = 0;
  let maxYaw = 0;
  let maxSpeed = 0;
  const speeds: number[] = [prev.speed];
  for (let t = dt; t <= RIDE_DURATION + 1e-9; t += dt) {
    const cur = ride.poseAt(t, mode, p());
    maxV = Math.max(maxV, Math.abs(cur.y - prev.y) / dt);
    maxYaw = Math.max(maxYaw, Math.abs(wrapAngle(cur.yaw - prev.yaw)) / dt);
    maxSpeed = Math.max(maxSpeed, cur.speed);
    speeds.push(cur.speed);
    prev = cur;
  }
  // 加速度は 0.5 秒の窓で測る（数値の揺れを拾わない）
  const w = Math.round(0.5 / dt);
  let maxAccel = 0;
  for (let i = w; i < speeds.length; i++) maxAccel = Math.max(maxAccel, Math.abs(speeds[i] - speeds[i - w]) / (w * dt));
  return { maxV, maxYawDeg: maxYaw / DEG, maxSpeed, maxAccel };
}

describe('RIDE-2 動きの上限（標準）', () => {
  it('analyzeComfort の違反が 0 件', () => {
    expect(analyzeComfort(data, 'standard')).toEqual([]);
  });

  it('poseAt から測っても上限内（2% の誤差を許す）', () => {
    const m = measure('standard');
    expect(m.maxSpeed).toBeLessThanOrEqual(MOTION.speedMax * 1.02);
    expect(m.maxAccel).toBeLessThanOrEqual(MOTION.accelMax * 1.02);
    expect(m.maxV).toBeLessThanOrEqual(MOTION.verticalMax * 1.02);
    expect(m.maxYawDeg).toBeLessThanOrEqual(MOTION.yawRateMaxDeg * 1.02);
  });

  it('ゴンドラは常に水平（姿勢に傾きを持たない）', () => {
    const p = ride.poseAt(300, 'standard', { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 });
    expect(Object.keys(p).sort()).toEqual(['s', 'section', 'sectionProgress', 'speed', 'x', 'y', 'yaw', 'z']);
  });
});

describe('RIDE-4 穏やかモード', () => {
  it('analyzeComfort の違反が 0 件（上下と回転の上限を半分にして測る）', () => {
    expect(analyzeComfort(data, 'gentle')).toEqual([]);
  });

  it('同じ時刻表: 乗車時間もレール上の距離も標準と同じ（楽曲との同期を崩さない）', () => {
    const p = () => ({ x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform' as const, sectionProgress: 0 });
    for (let t = 0; t <= RIDE_DURATION; t += 13.7) {
      const a = ride.poseAt(t, 'standard', p());
      const b = ride.poseAt(t, 'gentle', p());
      expect(b.s).toBeCloseTo(a.s, 6);
      expect(b.section).toBe(a.section);
    }
  });

  it('poseAt から測って、上下 0.3 m/s・回転 7.5°/s 以内', () => {
    const m = measure('gentle');
    expect(m.maxV).toBeLessThanOrEqual(MOTION.verticalMax * MOTION.gentleFactor * 1.02);
    expect(m.maxYawDeg).toBeLessThanOrEqual(MOTION.yawRateMaxDeg * MOTION.gentleFactor * 1.02);
  });

  it('向きは進行方向から 40° 以上ずれず、高さは標準から 5m 以上離れない', () => {
    const p = () => ({ x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform' as const, sectionProgress: 0 });
    for (let t = 0; t <= RIDE_DURATION; t += 0.5) {
      const a = ride.poseAt(t, 'standard', p());
      const b = ride.poseAt(t, 'gentle', p());
      expect(Math.abs(wrapAngle(b.yaw - a.yaw)) / DEG, `t=${t}`).toBeLessThanOrEqual(40);
      expect(Math.abs(b.y - a.y), `t=${t}`).toBeLessThanOrEqual(5);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.z).toBeCloseTo(a.z, 6);
    }
  });
});

describe('RIDE-2 analyzeComfort は違反を見つける', () => {
  /** 一直線（-Z）のレールに、指定の高さの関数と時刻表を与えた RideData */
  function straight(length: number, y: (s: number) => number, timeline: { t: number; s: number }[], turn?: { at: number; radius: number }): RideData {
    const points: Vec3Tuple[] = [];
    let x = 0;
    let z = 0;
    let heading = 0; // -Z が 0
    for (let s = 0; s <= length; s += 1) {
      points.push([x, y(s), z]);
      if (turn && s >= turn.at && s < turn.at + (Math.PI / 2) * turn.radius) heading += 1 / turn.radius;
      x += -Math.sin(heading);
      z += -Math.cos(heading);
    }
    const duration = timeline[timeline.length - 1].t;
    return { version: 1, duration, rail: { spacing: 1, points }, timeline, sections: [{ id: 'platform', s0: 0, s1: length }] };
  }
  const kinds = (d: RideData, mode: ComfortMode = 'standard') => [...new Set(analyzeComfort(d, mode).map((v) => v.kind))].sort();

  it('速すぎる（10 m/s）', () => {
    const d = straight(200, () => 0, [{ t: 0, s: 0 }, { t: 20, s: 200 }]);
    const v = analyzeComfort(d, 'standard').filter((x) => x.kind === 'speed');
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].peak).toBeCloseTo(10, 0);
    expect(v[0].limit).toBe(MOTION.speedMax);
  });

  it('急な加速（1秒で 0 → 2 m/s）', () => {
    const d = straight(100, () => 0, [{ t: 0, s: 0 }, { t: 10, s: 0 }, { t: 11, s: 1 }, { t: 60, s: 99 }]);
    expect(kinds(d)).toEqual(expect.arrayContaining(['accel']));
  });

  it('急な上昇（1m 進むごとに 1m 上がる、2 m/s）', () => {
    const d = straight(100, (s) => s, [{ t: 0, s: 0 }, { t: 50, s: 100 }]);
    expect(kinds(d)).toEqual(expect.arrayContaining(['vertical']));
  });

  it('急な曲がり（半径 2m を 2 m/s）', () => {
    const d = straight(100, () => 0, [{ t: 0, s: 0 }, { t: 50, s: 100 }], { at: 40, radius: 2 });
    expect(kinds(d)).toEqual(expect.arrayContaining(['yawRate']));
  });

  it('標準では許される上昇（0.45 m/s）も、穏やかでは違反（gentleY がないとき）', () => {
    const d = straight(200, (s) => s * 0.3, [{ t: 0, s: 0 }, { t: 133.3, s: 200 }]);
    expect(kinds(d, 'standard')).not.toContain('vertical');
    expect(kinds(d, 'gentle')).toContain('vertical');
  });

  it('違反は区間の時刻（t0 ≤ t1）と、上限を超えた最大値を持つ', () => {
    const d = straight(200, () => 0, [{ t: 0, s: 0 }, { t: 20, s: 200 }]);
    for (const v of analyzeComfort(d, 'standard')) {
      expect(v.t1).toBeGreaterThanOrEqual(v.t0);
      expect(v.peak).toBeGreaterThan(v.limit);
    }
  });
});
