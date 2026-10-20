// 部屋の先読みの計画（RIDE-7）。今の部屋にいる間に次の部屋を読み込み、2つ前の部屋は解放する。
// 膜の越しに次の部屋が見え（膜の15秒前から）、通り抜けた後に振り返っても前の部屋が空にならない（膜の10秒後まで）。
// 夜明けの岸では朝日の誘導（見どころの3秒前）から、降車の乗り場を遠くに描く（遠くに最初の乗り場が見える）。
import { LURE_LEAD_SEC, MOMENT_BARS, RIDE_DURATION, SEC_PER_BAR } from '../config';
import { ROOM_OF_SECTION, SECTION_IDS } from '../contracts/ids';
import type { RoomId } from '../contracts/ids';
import type { Ride } from '../contracts/ride';
import { sectionIndexAt } from './rail';

/** 次の部屋を描き始めるのは膜のこの秒数前 */
const NEXT_VISIBLE_BEFORE_SEC = 15;
/** 前の部屋を描き続けるのは膜のこの秒数後まで */
const PREV_VISIBLE_AFTER_SEC = 10;
/** 朝日の誘導の時刻。夜明けの岸の遠くに乗り場が見え始める */
const SUNRISE_LURE_T = MOMENT_BARS.dawnSunrise * SEC_PER_BAR - LURE_LEAD_SEC;

export interface StreamingPlan {
  /** いま描く部屋（膜の近くでは前後の2つ） */
  readonly visible: readonly RoomId[];
  /** 読み込んだまま置く部屋（今の部屋と次の部屋。膜を通った直後は前の部屋も） */
  readonly keep: readonly RoomId[];
}

const unique = (rooms: readonly (RoomId | undefined)[]): RoomId[] => rooms.filter((r, i): r is RoomId => r !== undefined && rooms.indexOf(r) === i);

/**
 * 計画は「区間 × 窓の組」だけなので、作った物を使い回す（毎フレーム確保しない）。配列は凍結してあり、書き換えられない。
 * 窓の組: 前の部屋を描く（1）、次の部屋を描く（2）、遠くの乗り場を描く（4）。
 */
const cache = new WeakMap<Ride, { plans: Map<number, StreamingPlan>; membrane: number[] }>();

function build(i: number, flags: number): StreamingPlan {
  const room = (k: number): RoomId | undefined => (k >= 0 && k < SECTION_IDS.length ? ROOM_OF_SECTION[SECTION_IDS[k]] : undefined);
  const prev = flags & 1 ? room(i - 1) : undefined;
  const next = flags & 2 ? room(i + 1) : undefined;
  const far = flags & 4 ? ROOM_OF_SECTION.departure : undefined;
  const visible = unique([prev, room(i), next, far]);
  const keep = unique([prev, room(i), room(i + 1)]);
  return Object.freeze({ visible: Object.freeze(visible), keep: Object.freeze(keep) });
}

/**
 * 部屋の先読みの計画。keep は今の部屋と次の部屋（2つ前と2つ先は持たない）。visible は keep に含まれる。
 * 夜明けの岸では次の部屋が降車の乗り場なので、乗り場を先に読み込む。
 * 戻り値は凍結した共有の物（書き換えない）。
 */
export function streamingPlan(t: number, ride: Ride): StreamingPlan {
  let c = cache.get(ride);
  if (!c) {
    c = { plans: new Map(), membrane: SECTION_IDS.map((id) => ride.sectionTime(id).t0) };
    cache.set(ride, c);
  }
  const x = Math.min(RIDE_DURATION, Math.max(0, t));
  const i = sectionIndexAt(x);
  let flags = 0;
  if (i > 0 && x - c.membrane[i] <= PREV_VISIBLE_AFTER_SEC + 1e-9) flags |= 1;
  if (i < SECTION_IDS.length - 1 && c.membrane[i + 1] - x <= NEXT_VISIBLE_BEFORE_SEC + 1e-9) flags |= 2;
  if (SECTION_IDS[i] === 'dawn' && x >= SUNRISE_LURE_T - 1e-9) flags |= 4;
  const key = i * 8 + flags;
  let plan = c.plans.get(key);
  if (!plan) {
    plan = build(i, flags);
    c.plans.set(key, plan);
  }
  return plan;
}
