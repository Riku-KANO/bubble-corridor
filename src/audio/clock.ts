// 楽曲の再生位置の時計。AudioContext の時刻（currentTime）から進める。
// 映像・ゴンドラ・演出はすべてここから時刻を読むので、描画が重くても音と映像はずれない。
import type { RideClock } from '../contracts/clock';
import { RIDE_DURATION } from '../config';

/** 時刻の出どころ。AudioContext をそのまま渡せる（テストでは currentTime だけの物でよい） */
export interface TimeSource {
  readonly currentTime: number;
}

export interface AudioClock extends RideClock {
  /** 乗車の秒 t を、音を予約する AudioContext の秒に直す（鳴らす時刻の予約に使う） */
  toContextTime(t: number): number;
  /**
   * start / seek で増える番号。位置が飛んだこと（先読みをやり直す必要）を、
   * 先読みの側が検出するのに使う。pause / resume では変わらない。
   */
  readonly jumps: number;
}

export interface AudioClockOptions {
  /** toContextTime の基準にする AudioContext の秒。省略すると source の時刻（AudioContext そのもの） */
  readonly contextNow?: () => number;
  readonly duration?: number;
}

export function createAudioClock(source: TimeSource, opts: AudioClockOptions = {}): AudioClock {
  const duration = opts.duration ?? RIDE_DURATION;
  const contextNow = opts.contextNow ?? (() => source.currentTime);
  let base = 0; // running でないときの位置、running のときは anchor 時点の位置
  let anchor = 0; // 位置 base だった source の時刻
  let running = false;
  let jumps = 0;
  const clamp = (t: number) => Math.min(duration, Math.max(0, t));
  /** 区間の終わりを超えても止まる（780 秒を超えて進まない） */
  const current = () => (running ? clamp(base + (source.currentTime - anchor)) : base);
  return {
    get time() {
      return current();
    },
    get running() {
      return running;
    },
    get jumps() {
      return jumps;
    },
    start(t = 0) {
      base = clamp(t);
      anchor = source.currentTime;
      running = true;
      jumps++;
    },
    pause() {
      if (!running) return;
      base = current();
      running = false;
    },
    resume() {
      if (running) return;
      anchor = source.currentTime;
      running = true;
    },
    seek(t) {
      base = clamp(t);
      anchor = source.currentTime;
      jumps++;
    },
    toContextTime(t) {
      return contextNow() + (t - current());
    },
  };
}
