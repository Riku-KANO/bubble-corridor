// 画面ごとの部屋の計画（どの部屋を描き、どの部屋を読み込んだままにするか）。
// 乗車中は ride の streamingPlan（時刻から決まる）。乗車の外は、凍結した定数の計画を返す。
// 乗車の外でも毎フレーム RoomManager.sync に渡すので、同じ計画は必ず同じ参照にする（sync は参照で同じ計画かを比べる）。
//
// なぜ乗車の外でも計画を渡すのか: 降車して入口へ戻ったとき、最後の乗車の計画が残ると、
// 入口の背景が前の部屋の空気のままになり（lobby が解放されていて空気が取れない）、
// 乗り場と待ち列の部屋も解放されたままなので、もう一度乗ると頭で部屋が空になる。
import { RIDE_DURATION } from '../config';
import { ROOM_OF_SECTION, type RoomId, type SectionId } from '../contracts/ids';
import type { Ride } from '../contracts/ride';
import type { ScreenId } from '../contracts/ui';
import { streamingPlan, type StreamingPlan } from '../ride';

/** 部屋の計画。RoomManager.sync が受け取る形（ride の streamingPlan と同じ） */
export type RoomPlan = StreamingPlan;

/**
 * 待ち列・入口・案内などの計画。待ち列・入口（lobby）と乗り場（platform）を見せ、読み込むのもこの2つだけ。
 * 起動時に読み込む部屋の一覧と、待ち列の灯りの進みもこれから取る。
 * 温室（約5MB）は待ち列の間に読まない: 初回の読み込みを 10MB 以下に収める（関門4）。乗車の頭（streamingPlan の最初）から読み始めても、
 * 温室の膜の15秒前に描き始めるまで45秒ある。
 */
export const HOME_PLAN: RoomPlan = Object.freeze({
  visible: Object.freeze<RoomId[]>(['lobby', 'platform']),
  keep: Object.freeze<RoomId[]>(['lobby', 'platform']),
});

/**
 * 画面と乗車の時刻から、部屋の計画を決める（純粋。戻り値は凍結した共有の物で、書き換えない）。
 *   乗車中・ポーズ: その時刻の streamingPlan
 *   ライドフォト:   降車の景色のまま（降車の乗り場が見える。時刻に依らず同じ参照）。入口の部屋も読み込んだままにする
 *   ほか:           HOME_PLAN
 */
export function planFor(screen: ScreenId, t: number, ride: Ride): RoomPlan {
  switch (screen) {
    case 'riding':
    case 'pause':
      return streamingPlan(t, ride);
    case 'photo':
      return photoPlanOf(ride);
    default:
      return HOME_PLAN;
  }
}

/**
 * ゴンドラ・部屋・画面効果の「場面の時刻」。乗車の外でも位置を決める（乗車の時計が止まっても場面が動かない）。
 *   乗車中・ポーズ: 乗車の時刻
 *   ライドフォト:   降車の時刻のまま（ここを 0 にすると、降車の瞬間にゴンドラが乗り場の向きへ回る。VR では世界が回る）
 *   ほか:           乗車の頭（待ち列・入口・案内などは乗り場から見る）
 */
export function sceneTimeFor(screen: ScreenId, rideT: number): number {
  switch (screen) {
    case 'riding':
    case 'pause':
      return rideT;
    case 'photo':
      return RIDE_DURATION;
    default:
      return 0;
  }
}

/** 小画面（開いた元の画面の景色の上に重なる画面） */
const SUB_SCREENS: readonly ScreenId[] = ['shelf', 'settings', 'howto', 'credits'];

/**
 * 場面（ゴンドラの位置・部屋の計画・空気の部屋）を決める画面。小画面（棚・設定・乗り方・クレジット）は開いた元（returnTo）の画面の景色のまま、
 * ほかはその画面そのもの。小画面で景色を入口に切り替えると、ライドフォト（降車の乗り場）から設定を開いたときに背景が入口の部屋へ跳ぶ。
 */
export function sceneScreenFor(screen: ScreenId, returnTo: ScreenId | null): ScreenId {
  return SUB_SCREENS.includes(screen) && returnTo !== null ? returnTo : screen;
}

/**
 * 背景と擬似照明の元にする部屋の空気（どの部屋の atmosphere か）。ゴンドラのいる部屋。
 * 乗車中・ポーズ・ライドフォトは今の区間の部屋（ライドフォトは降車の乗り場）、ほかは入口の部屋。
 */
export function atmosphereRoomFor(screen: ScreenId, section: SectionId): RoomId {
  return screen === 'riding' || screen === 'pause' || screen === 'photo' ? ROOM_OF_SECTION[section] : 'lobby';
}

/**
 * ライドフォトの計画: 降車の景色（降車の時刻の計画）を見せ、入口の部屋も読み込んだままにする。
 * 「入口へ」「もう一度乗る」で、入口の部屋や最初の部屋が空にならない。降車の計画ごとに一度だけ作る（同じ参照を返す）
 */
const photoCache = new WeakMap<RoomPlan, RoomPlan>();

function photoPlanOf(ride: Ride): RoomPlan {
  const end = streamingPlan(RIDE_DURATION, ride);
  let plan = photoCache.get(end);
  if (!plan) {
    const keep = [...end.keep];
    for (const id of HOME_PLAN.keep) if (!keep.includes(id)) keep.push(id);
    plan = Object.freeze({ visible: end.visible, keep: Object.freeze(keep) });
    photoCache.set(end, plan);
  }
  return plan;
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
