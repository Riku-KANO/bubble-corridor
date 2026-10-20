// 指でなぞった文字。CSS のマスクで左から現れる（class "write" の要素に is-writing を付けて始める）。
// 曇りの canvas とは別に DOM に必ず文字を出す。読み上げと検索に届き、曇りが何も描かない環境でも読める。
import { replay } from './dom';

/** 書く速さ。文字数に応じて長くなり、上限（max 秒）で頭打ちにする */
export interface WriteSpeed {
  readonly base: number;
  readonly perChar: number;
  readonly max: number;
}
/** ゆっくり（乗車前の案内・乗車中の案内。長い英文でも 2 秒でなぞり終える） */
export const SLOW: WriteSpeed = { base: 0.5, perChar: 0.09, max: 2 };
/** 乗車前の案内の3行。6秒で自動的に進むので、長い英文でも 5 秒前までに書き終える */
export const GUIDE: WriteSpeed = { base: 0.4, perChar: 0.07, max: 1.5 };
/** 手早く（ポーズの項目。押したいときにすぐ読めるように） */
export const QUICK: WriteSpeed = { base: 0.3, perChar: 0.05, max: 0.7 };

/** 文字数から、書き終えるまでの秒 */
export function writeSeconds(text: string, speed: WriteSpeed = SLOW): number {
  return Math.min(speed.max, speed.base + speed.perChar * Array.from(text).length);
}

/** 一つの文字を delay 秒後から書き始める。書き終える時刻（秒）を返す */
export function armWrite(el: HTMLElement, delaySec: number, speed: WriteSpeed = SLOW): number {
  const sec = writeSeconds(el.textContent ?? '', speed);
  el.style.setProperty('--dur', `${sec}s`);
  el.style.setProperty('--delay', `${delaySec}s`);
  replay(el, 'is-writing');
  return delaySec + sec;
}

/** 順に書く。最後の文字を書き終える時刻（秒）を返す */
export function armWrites(els: readonly HTMLElement[], startSec = 0.3, gapSec = 0.2, speed: WriteSpeed = SLOW): number {
  let t = startSec;
  for (const el of els) t = armWrite(el, t, speed) + gapSec;
  return t - gapSec;
}

/** 書く演出をやめて、全部見える状態に戻す */
export function disarmWrites(els: readonly HTMLElement[]): void {
  for (const el of els) el.classList.remove('is-writing');
}
