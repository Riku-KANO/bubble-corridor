// 乗り物と時間（レール、時刻 → 位置の対応、動きの上限の検査、キューシート、部屋の先読み）。
// STUB: 署名は確定。中身は ride 担当が本実装に置き換える。今は -Z 方向へまっすぐ一定の速さで進む。
import type { Cue, EventBus } from '../contracts/events';
import type { ComfortMode, RoomId, SectionId } from '../contracts/ids';
import { ROOM_OF_SECTION } from '../contracts/ids';
import type { ComfortViolation, Ride, RideData, RidePose } from '../contracts/ride';
import { RIDE_DURATION, SEC_PER_BAR, SECTIONS } from '../config';

export { createWallClock } from './clock';

const STUB_SPEED = 1.3;

/** レールと時刻表を作る（Blender の書き出しの代わり。scripts/build-ride-data.ts が rail.json に書く） */
export function generateRideData(): RideData {
  const spacing = 1;
  const length = Math.ceil(RIDE_DURATION * STUB_SPEED);
  const points: [number, number, number][] = [];
  for (let i = 0; i <= length; i++) points.push([0, 0, -i * spacing]);
  const timeline = [
    { t: 0, s: 0 },
    { t: RIDE_DURATION, s: RIDE_DURATION * STUB_SPEED },
  ];
  const sections = SECTIONS.map((sec) => ({
    id: sec.id,
    s0: sec.startBar * SEC_PER_BAR * STUB_SPEED,
    s1: (sec.startBar + sec.bars) * SEC_PER_BAR * STUB_SPEED,
  }));
  return { version: 1, duration: RIDE_DURATION, rail: { spacing, points }, timeline, sections };
}

export function createRide(data: RideData): Ride {
  const sectionTime = (id: SectionId) => {
    const sec = SECTIONS.find((s) => s.id === id)!;
    return { t0: sec.startBar * SEC_PER_BAR, t1: (sec.startBar + sec.bars) * SEC_PER_BAR };
  };
  const sectionAt = (t: number): SectionId => {
    for (let i = SECTIONS.length - 1; i >= 0; i--) if (t >= SECTIONS[i].startBar * SEC_PER_BAR) return SECTIONS[i].id;
    return 'platform';
  };
  return {
    data,
    poseAt(t: number, _mode: ComfortMode, out: RidePose): RidePose {
      const tt = Math.min(RIDE_DURATION, Math.max(0, t));
      const s = tt * STUB_SPEED;
      out.x = 0;
      out.y = 0;
      out.z = -s;
      out.yaw = 0;
      out.speed = STUB_SPEED;
      out.s = s;
      out.section = sectionAt(tt);
      const st = sectionTime(out.section);
      out.sectionProgress = (tt - st.t0) / (st.t1 - st.t0);
      return out;
    },
    pointAt(s: number) {
      return { x: 0, y: 0, z: -s, yaw: 0 };
    },
    sectionAt,
    sectionTime,
    sectionSpan(id: SectionId) {
      const sec = data.sections.find((x) => x.id === id)!;
      return { s0: sec.s0, s1: sec.s1 };
    },
  };
}

/** キューシートを作る（時刻は config の小節から計算する）。時刻の昇順 */
export function buildCueSheet(): Cue[] {
  return []; // STUB
}

export interface CueDispatcher {
  /** 前回から t までに来た出来事を時刻順に一度だけ流す */
  update(t: number): void;
  /** 位置を変えた（確認用の早送り・巻き戻し）。t より前の出来事は流さない */
  reset(t: number): void;
}

export function createCueDispatcher(cues: readonly Cue[], bus: EventBus): CueDispatcher {
  // STUB
  let i = 0;
  return {
    update(t) {
      while (i < cues.length && cues[i].t <= t) bus.emit('cue', cues[i++]);
    },
    reset(t) {
      i = cues.findIndex((c) => c.t >= t);
      if (i < 0) i = cues.length;
    },
  };
}

/** 動きの上限（config の MOTION）を超える区間の一覧。穏やかでは上下と回転の上限を半分にして測る */
export function analyzeComfort(_data: RideData, _mode: ComfortMode): ComfortViolation[] {
  return []; // STUB
}

/**
 * 部屋の先読みの計画。今の部屋にいる間に次の部屋を読み込み、2つ前の部屋は解放する。
 * visible: いま描く部屋（膜の近くでは前後の2つ）、keep: 読み込んだまま置く部屋。
 */
export function streamingPlan(t: number, ride: Ride): { visible: RoomId[]; keep: RoomId[] } {
  const room = ROOM_OF_SECTION[ride.sectionAt(t)];
  return { visible: [room], keep: [room] }; // STUB
}
