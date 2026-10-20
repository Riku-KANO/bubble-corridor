// S-10 乗り物と時間: レールの形、時刻 → 位置、速度の決め方、部屋の先読み（親が作成。実装担当は変更しない）
import { describe, expect, it } from 'vitest';
import type { RoomId, SectionId } from '../contracts/ids';
import { ROOM_OF_SECTION, SECTION_IDS } from '../contracts/ids';
import type { RidePose } from '../contracts/ride';
import { MOMENT_BARS, MOTION, RIDE_DURATION, SEC_PER_BAR, SECTIONS } from '../config';
import { createRide, generateRideData, streamingPlan } from './index';

const data = generateRideData();
const ride = createRide(data);
const pose = (): RidePose => ({ x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 });
const at = (t: number, mode: 'standard' | 'gentle' = 'standard') => ride.poseAt(t, mode, pose());
const secTime = (id: SectionId) => {
  const s = SECTIONS.find((x) => x.id === id)!;
  return { t0: s.startBar * SEC_PER_BAR, t1: (s.startBar + s.bars) * SEC_PER_BAR };
};
const HIGHLIGHT_T = [MOMENT_BARS.greenhouseBloom, MOMENT_BARS.rainFreeze, MOMENT_BARS.kaleidoscopeFlower, MOMENT_BARS.celestialConstellation, MOMENT_BARS.dawnSunrise].map(
  (b) => b * SEC_PER_BAR,
);
const MEMBRANE_T = SECTIONS.slice(1).map((s) => s.startBar * SEC_PER_BAR);

describe('RIDE-1 区間と時刻', () => {
  it('乗車は 780 秒', () => {
    expect(data.duration).toBeCloseTo(RIDE_DURATION, 6);
    expect(RIDE_DURATION).toBeCloseTo(780, 6);
  });

  it('区間の時刻は設計書どおり（0:00 / 1:00 / 3:30 / 6:00 / 8:00 / 11:00 / 12:30 / 13:00）', () => {
    const expected: [SectionId, number, number][] = [
      ['platform', 0, 60],
      ['greenhouse', 60, 210],
      ['rain', 210, 360],
      ['kaleidoscope', 360, 480],
      ['celestial', 480, 660],
      ['dawn', 660, 750],
      ['departure', 750, 780],
    ];
    for (const [id, t0, t1] of expected) {
      const r = ride.sectionTime(id);
      expect(r.t0, id).toBeCloseTo(t0, 6);
      expect(r.t1, id).toBeCloseTo(t1, 6);
    }
  });

  it('sectionAt は境目の時刻から次の区間になり、範囲外は端に丸める', () => {
    expect(ride.sectionAt(-5)).toBe('platform');
    expect(ride.sectionAt(59.99)).toBe('platform');
    expect(ride.sectionAt(60)).toBe('greenhouse');
    expect(ride.sectionAt(479.99)).toBe('kaleidoscope');
    expect(ride.sectionAt(480)).toBe('celestial');
    expect(ride.sectionAt(780)).toBe('departure');
    expect(ride.sectionAt(9999)).toBe('departure');
  });

  it('poseAt の区間と区間の中の進み具合', () => {
    for (const id of SECTION_IDS) {
      const { t0, t1 } = secTime(id);
      const mid = at((t0 + t1) / 2);
      expect(mid.section).toBe(id);
      expect(mid.sectionProgress).toBeCloseTo(0.5, 3);
    }
    expect(at(0).sectionProgress).toBeCloseTo(0, 6);
  });
});

describe('RIDE-8 レールの形', () => {
  const pts = data.rail.points;

  it('点は一定の間隔で並ぶ（spacing ±10%）', () => {
    expect(pts.length).toBeGreaterThan(100);
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      expect(Math.abs(d - data.rail.spacing), `点 ${i}`).toBeLessThanOrEqual(data.rail.spacing * 0.1);
    }
  });

  it('時刻表は t が単調増加、s が単調非減少で、0 から終点まで', () => {
    const tl = data.timeline;
    expect(tl[0]).toEqual({ t: 0, s: 0 });
    for (let i = 1; i < tl.length; i++) {
      expect(tl[i].t).toBeGreaterThan(tl[i - 1].t);
      expect(tl[i].s).toBeGreaterThanOrEqual(tl[i - 1].s);
    }
    const last = tl[tl.length - 1];
    expect(last.t).toBeCloseTo(RIDE_DURATION, 6);
    const railLength = (pts.length - 1) * data.rail.spacing;
    expect(Math.abs(last.s - railLength)).toBeLessThanOrEqual(data.rail.spacing * 1.5);
  });

  it('区間のレール上の範囲は順に隙間なく並び、時刻表と一致する', () => {
    expect(data.sections.map((s) => s.id)).toEqual(SECTION_IDS);
    expect(data.sections[0].s0).toBe(0);
    for (let i = 0; i < data.sections.length; i++) {
      const sec = data.sections[i];
      expect(sec.s1).toBeGreaterThan(sec.s0);
      if (i > 0) expect(sec.s0).toBeCloseTo(data.sections[i - 1].s1, 6);
      // 区間の始まりの時刻に、ゴンドラはその区間の始まりの位置にいる（±1m）
      expect(Math.abs(at(secTime(sec.id).t0).s - sec.s0), sec.id).toBeLessThanOrEqual(1);
      expect(ride.sectionSpan(sec.id)).toEqual({ s0: sec.s0, s1: sec.s1 });
    }
  });

  it('直線ではない: 部屋を巡る輪になり、降車で最初の乗り場に戻る', () => {
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[2]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(60);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(60);
    // 降車の終点は乗り場の始点の近く（同じホール。15m 以内）
    const start = ride.pointAt(0);
    const end = ride.pointAt(pts.length * data.rail.spacing);
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeLessThan(15);
  });

  it('温室は高い位置から下降し（4m 以上）、天球は上昇する（6m 以上）。夜明けの岸は水面すれすれで平ら（上下 1m 以内）', () => {
    const ys = (id: SectionId) => {
      const { s0, s1 } = ride.sectionSpan(id);
      const out: number[] = [];
      for (let s = s0; s <= s1; s += 1) out.push(ride.pointAt(s).y);
      return out;
    };
    const g = ys('greenhouse');
    expect(g[0] - Math.min(...g)).toBeGreaterThanOrEqual(4);
    const c = ys('celestial');
    expect(c[c.length - 1] - c[0]).toBeGreaterThanOrEqual(6);
    const d = ys('dawn');
    expect(Math.max(...d) - Math.min(...d)).toBeLessThanOrEqual(1);
  });

  it('隣り合わない部屋どうしはレールが 30m 以上離れている（部屋の形が重ならない）', () => {
    const ring: RoomId[] = ['platform', 'greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn'];
    const pointsOf = (room: RoomId) => {
      const out: [number, number][] = [];
      for (const sec of data.sections) {
        if (ROOM_OF_SECTION[sec.id] !== room) continue;
        for (let s = sec.s0; s <= sec.s1; s += 4) {
          const p = ride.pointAt(s);
          out.push([p.x, p.z]);
        }
      }
      return out;
    };
    for (let i = 0; i < ring.length; i++) {
      for (let j = i + 2; j < ring.length; j++) {
        if (i === 0 && j === ring.length - 1) continue; // 輪なので乗り場と岸は隣
        const a = pointsOf(ring[i]);
        const b = pointsOf(ring[j]);
        let min = Infinity;
        for (const p of a) for (const q of b) min = Math.min(min, Math.hypot(p[0] - q[0], p[1] - q[1]));
        expect(min, `${ring[i]} と ${ring[j]}`).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it('pointAt はレールの点を通り、yaw は進行方向（-Z が 0、左回りが正）', () => {
    for (const i of [10, Math.floor(pts.length / 2), pts.length - 10]) {
      const p = ride.pointAt(i * data.rail.spacing);
      expect(Math.hypot(p.x - pts[i][0], p.y - pts[i][1], p.z - pts[i][2])).toBeLessThan(data.rail.spacing * 0.2);
      const a = pts[i - 1];
      const b = pts[i + 1];
      const dirX = b[0] - a[0];
      const dirZ = b[2] - a[2];
      // three.js の rotation.y = yaw のとき、前方 (0,0,-1) は (-sin yaw, 0, -cos yaw) を向く
      const fx = -Math.sin(p.yaw);
      const fz = -Math.cos(p.yaw);
      const cos = (fx * dirX + fz * dirZ) / Math.hypot(dirX, dirZ);
      expect(cos).toBeGreaterThan(0.98);
    }
  });
});

describe('RIDE-3 速度の決め方', () => {
  it('乗車の頭（殻が閉じる 2.5 秒）と降車の終わりはほとんど止まっている（0.3 m/s 以下）', () => {
    for (let t = 0; t <= 2.5; t += 0.25) expect(at(t).speed, `t=${t}`).toBeLessThanOrEqual(0.3);
    for (let t = 776; t <= 780; t += 0.5) expect(at(t).speed, `t=${t}`).toBeLessThanOrEqual(0.3);
  });

  it('前進は最大 3.0 m/s を超えない', () => {
    for (let t = 0; t <= RIDE_DURATION; t += 0.5) expect(at(t).speed).toBeLessThanOrEqual(MOTION.speedMax + 1e-6);
  });

  it('各部屋の平均速度は 0.8〜2.0 m/s（景色を眺められる速さ）', () => {
    for (const id of ['greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn'] as const) {
      const { s0, s1 } = ride.sectionSpan(id);
      const { t0, t1 } = secTime(id);
      const avg = (s1 - s0) / (t1 - t0);
      expect(avg, id).toBeGreaterThanOrEqual(0.8);
      expect(avg, id).toBeLessThanOrEqual(MOTION.cruiseMax);
    }
  });

  it('見どころの前後 2 秒は 0.7 m/s 以下（ほとんど止まっているように感じる）', () => {
    for (const th of HIGHLIGHT_T) for (let t = th - 2; t <= th + 2; t += 0.5) expect(at(t).speed, `見どころ ${th}s, t=${t}`).toBeLessThanOrEqual(0.7);
  });

  it('部屋の入口（膜の3秒後）は減速している（1.2 m/s 以下）', () => {
    for (const tm of MEMBRANE_T) expect(at(tm + 3).speed, `膜 ${tm}s`).toBeLessThanOrEqual(1.2);
  });

  it('speed は時刻表の傾きと一致する（位置と速度が食い違わない）', () => {
    for (let t = 5; t < RIDE_DURATION - 5; t += 7.3) {
      const ds = at(t + 0.05).s - at(t - 0.05).s;
      expect(Math.abs(ds / 0.1 - at(t).speed), `t=${t}`).toBeLessThan(0.05);
    }
  });
});

describe('RIDE-7 部屋の先読み', () => {
  const mid = (id: SectionId) => (secTime(id).t0 + secTime(id).t1) / 2;

  it('部屋の中ほどでは、今の部屋を描き、次の部屋を読み込んでおく', () => {
    const p = streamingPlan(mid('greenhouse'), ride);
    expect(p.visible).toContain('greenhouse');
    expect(p.keep).toEqual(expect.arrayContaining(['greenhouse', 'rain']));
    expect(p.visible).not.toContain('celestial');
  });

  it('2つ前の部屋と2つ先の部屋は持たない', () => {
    const p = streamingPlan(mid('rain'), ride);
    expect(p.keep).not.toContain('platform');
    expect(p.keep).not.toContain('celestial');
    const q = streamingPlan(mid('celestial'), ride);
    expect(q.keep).not.toContain('rain');
    expect(q.keep).toContain('dawn');
  });

  it('膜の前後3秒は両側の部屋を描く', () => {
    for (const tm of MEMBRANE_T) {
      const before = ride.sectionAt(tm - 0.01);
      const after = ride.sectionAt(tm);
      for (const t of [tm - 3, tm - 0.5, tm + 0.5, tm + 3]) {
        const p = streamingPlan(t, ride);
        expect(p.visible, `t=${t}`).toEqual(expect.arrayContaining([ROOM_OF_SECTION[before], ROOM_OF_SECTION[after]].filter((v, i, a) => a.indexOf(v) === i)));
      }
    }
  });

  it('夜明けの岸では、降車に使う乗り場を先に読み込む', () => {
    expect(streamingPlan(mid('dawn'), ride).keep).toContain('platform');
    expect(streamingPlan(mid('departure'), ride).visible).toContain('platform');
  });

  it('visible は keep に含まれる', () => {
    for (let t = 0; t <= RIDE_DURATION; t += 5) {
      const p = streamingPlan(t, ride);
      for (const v of p.visible) expect(p.keep, `t=${t}`).toContain(v);
    }
  });
});
