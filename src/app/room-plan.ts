// 画面ごとの部屋の計画（どの部屋を描き、どの部屋を読み込んだままにするか）。
// 乗車中は ride の streamingPlan（時刻から決まる）。乗車の外は、凍結した定数の計画を返す。
// 乗車の外でも毎フレーム RoomManager.sync に渡すので、同じ計画は必ず同じ参照にする（sync は参照で同じ計画かを比べる）。
//
// なぜ乗車の外でも計画を渡すのか: 降車して入口へ戻ったとき、最後の乗車の計画が残ると、
// 入口の背景が前の部屋の空気のままになり（lobby が解放されていて空気が取れない）、
// 乗り場と待ち列の部屋も解放されたままなので、もう一度乗ると頭で部屋が空になる。
import { RIDE_DURATION } from '../config';
import type { RoomId } from '../contracts/ids';
import type { Ride } from '../contracts/ride';
import type { ScreenId } from '../contracts/ui';
import { streamingPlan, type StreamingPlan } from '../ride';

/** 部屋の計画。RoomManager.sync が受け取る形（ride の streamingPlan と同じ） */
export type RoomPlan = StreamingPlan;

/**
 * 待ち列・入口・案内などの計画。待ち列・入口（lobby）と乗り場（platform）を見せ、最初の部屋（greenhouse）も読み込んでおく
 * （乗った直後に温室が空にならない）。起動時に読み込む部屋の一覧もこれから取る。
 */
export const HOME_PLAN: RoomPlan = Object.freeze({
  visible: Object.freeze<RoomId[]>(['lobby', 'platform']),
  keep: Object.freeze<RoomId[]>(['lobby', 'platform', 'greenhouse']),
});

/**
 * 画面と乗車の時刻から、部屋の計画を決める（純粋。戻り値は凍結した共有の物で、書き換えない）。
 *   乗車中・ポーズ: その時刻の streamingPlan
 *   ライドフォト:   降車の景色のまま（降車の乗り場が見える。時刻に依らず同じ参照）
 *   ほか:           HOME_PLAN
 */
export function planFor(screen: ScreenId, t: number, ride: Ride): RoomPlan {
  switch (screen) {
    case 'riding':
    case 'pause':
      return streamingPlan(t, ride);
    case 'photo':
      // 降車の時刻の計画（最後の区間 = 乗り場、その前の夜明けの岸が遠くに見える）。streamingPlan は同じ入力に同じ参照を返す
      return streamingPlan(RIDE_DURATION, ride);
    default:
      return HOME_PLAN;
  }
}

/** 入口で止まる確認用（?screen=home&t=）の計画。乗る時刻の部屋も読み込んだままにする（乗った直後に空の景色を見せない） */
const aheadCache = new WeakMap<RoomPlan, RoomPlan>();

/**
 * 入口にいる間の計画。startSec が null（ふつうの起動）なら HOME_PLAN。
 * 時刻つきで入口に止まるときは、見える部屋は入口のままで、乗る時刻の部屋も読み込んだままにする。
 */
export function homePlanFor(startSec: number | null, ride: Ride): RoomPlan {
  if (startSec === null) return HOME_PLAN;
  const ahead = streamingPlan(startSec, ride);
  let plan = aheadCache.get(ahead);
  if (!plan) {
    const keep = [...HOME_PLAN.keep];
    for (const id of ahead.keep) if (!keep.includes(id)) keep.push(id);
    plan = Object.freeze({ visible: HOME_PLAN.visible, keep: Object.freeze(keep) });
    aheadCache.set(ahead, plan);
  }
  return plan;
}
