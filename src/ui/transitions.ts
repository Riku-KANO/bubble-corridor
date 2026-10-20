// 画面の切り替えの長さ。設計書「遷移の一覧」の秒数（config の TRANSITION_SEC）を使う。
// 3D の演出（扉が開く、切符が光の粒になる、泡が開く）は app・fx の担当。ここは画面の要素の出入りだけを受け持つ。
import { TRANSITION_SEC } from '../config';
import type { ScreenId } from '../contracts/ui';

export interface Timing {
  /** 出ていく画面が消えるまでの秒 */
  readonly leave: number;
  /** 入ってくる画面が現れ始めるまでの秒 */
  readonly delay: number;
  /** 入ってくる画面が現れるまでの秒 */
  readonly enter: number;
}

/** 入口・写真の棚・設定などの行き来の長さ。設計書に値がないので仮（config に足す候補） */
export const MENU_FADE_SEC = 0.35;

const SUB: readonly ScreenId[] = ['shelf', 'settings', 'howto', 'credits'];

/** 遷移全体の長さ（秒）。VR で乗るときは「白い霧」の長さ */
export function transitionSec(from: ScreenId | null, to: ScreenId, vr: boolean): number {
  if (from === null) return TRANSITION_SEC.queueToHome * 0.5;
  if (SUB.includes(from) || SUB.includes(to)) return MENU_FADE_SEC;
  if (vr && (to === 'guide' || to === 'riding') && (from === 'home' || from === 'guide')) return TRANSITION_SEC.screenToVR;
  if (from === 'queue' && to === 'home') return TRANSITION_SEC.queueToHome;
  if (from === 'home' && to === 'guide') return TRANSITION_SEC.homeToGuide;
  if ((from === 'home' || from === 'guide') && to === 'riding') return TRANSITION_SEC.boarding;
  if (from === 'riding' && to === 'pause') return TRANSITION_SEC.pause;
  if (from === 'pause' && to === 'riding') return TRANSITION_SEC.resume;
  if (from === 'riding' && to === 'photo') return TRANSITION_SEC.alightToPhoto;
  if (from === 'photo' && to === 'riding') return TRANSITION_SEC.photoToRideAgain;
  if (from === 'photo' && to === 'home') return TRANSITION_SEC.photoToHome;
  // ポーズの「降りる」で入口へ。設計書に一覧がないので、写真から入口へ戻る長さに揃える
  if (from === 'pause' && to === 'home') return TRANSITION_SEC.photoToHome;
  return MENU_FADE_SEC;
}

/** 出ていく画面と入ってくる画面の時間の配分 */
export function timing(from: ScreenId | null, to: ScreenId, vr: boolean): Timing {
  const total = transitionSec(from, to, vr);
  if (from === null) return { leave: 0, delay: 0, enter: total };
  // 乗る・ポーズから戻る: 出ていく画面が全体をかけて晴れ、入ってくるものはない
  if (to === 'riding') return { leave: total, delay: 0, enter: total };
  // ポーズ: 曇りがすぐ広がり、項目が書かれる
  if (to === 'pause') return { leave: total * 0.5, delay: 0, enter: total };
  // 降車: 泡が開いてから写真が降りてくる
  if (from === 'riding') return { leave: total * 0.4, delay: total * 0.4, enter: total * 0.6 };
  return { leave: total * 0.5, delay: total * 0.5, enter: total * 0.5 };
}
