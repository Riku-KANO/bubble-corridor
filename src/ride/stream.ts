// 部屋の先読みの計画（RIDE-7）。今の部屋にいる間に次の部屋を読み込み、2つ前の部屋は解放する。
// 膜の前後 MEMBRANE_WINDOW 秒は、通り抜けの前後で両方の部屋を描く（通過の 0.6 秒に前の部屋が消えない）。
import { ROOM_OF_SECTION, SECTION_IDS } from '../contracts/ids';
import type { RoomId } from '../contracts/ids';
import type { Ride } from '../contracts/ride';
import { RIDE_DURATION } from '../config';
import { sectionIndexAt } from './rail';

/** 膜の前後の秒数 */
const MEMBRANE_WINDOW = 3;

interface Plan {
  visible: RoomId[];
  keep: RoomId[];
}

const unique = (rooms: (RoomId | undefined)[]): RoomId[] => rooms.filter((r, i): r is RoomId => r !== undefined && rooms.indexOf(r) === i);

/**
 * 計画は区間 × 膜の窓の組だけなので、先に作っておいて同じ物を返す（毎フレーム確保しない）。
 * 戻り値は共有されるので、受け取った側は書き換えない。
 */
const plans = new WeakMap<Ride, { mid: Plan[]; start: Plan[]; end: Plan[]; membrane: number[] }>();

function plansFor(ride: Ride) {
  let p = plans.get(ride);
  if (p) return p;
  const room = (i: number): RoomId | undefined => (i >= 0 && i < SECTION_IDS.length ? ROOM_OF_SECTION[SECTION_IDS[i]] : undefined);
  const mid: Plan[] = [];
  const start: Plan[] = [];
  const end: Plan[] = [];
  for (let i = 0; i < SECTION_IDS.length; i++) {
    const keep = unique([room(i), room(i + 1)]);
    mid.push({ visible: unique([room(i)]), keep });
    // 膜を通った直後: 前の部屋もまだ描く（keep に含める）
    start.push({ visible: unique([room(i - 1), room(i)]), keep: unique([room(i - 1), room(i), room(i + 1)]) });
    // 膜の直前: 次の部屋を先に描いておく
    end.push({ visible: unique([room(i), room(i + 1)]), keep });
  }
  p = { mid, start, end, membrane: SECTION_IDS.map((id) => ride.sectionTime(id).t0) };
  plans.set(ride, p);
  return p;
}

/**
 * 部屋の先読みの計画。
 * visible: いま描く部屋（膜の近くでは前後の2つ）、keep: 読み込んだまま置く部屋（今の部屋と次の部屋）。
 * 夜明けの岸では次の部屋が降車の乗り場なので、乗り場を先に読み込む。
 */
export function streamingPlan(t: number, ride: Ride): { visible: RoomId[]; keep: RoomId[] } {
  const p = plansFor(ride);
  const x = Math.min(RIDE_DURATION, Math.max(0, t));
  const i = sectionIndexAt(x);
  if (i > 0 && x - p.membrane[i] <= MEMBRANE_WINDOW + 1e-9) return p.start[i];
  if (i < SECTION_IDS.length - 1 && p.membrane[i + 1] - x <= MEMBRANE_WINDOW + 1e-9) return p.end[i];
  return p.mid[i];
}
