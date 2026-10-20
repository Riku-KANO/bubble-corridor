// 実時間で進む時計。音が使えないとき（確認ページ、テスト、音を有効にする前）に使う。
// 本番の乗車では音の担当の AudioContext の時計（src/audio）を使う。
import type { RideClock } from '../contracts/clock';
import { RIDE_DURATION } from '../config';

export interface WallClockOptions {
  /** 時刻の出どころ（秒）。テストで差し替える */
  readonly now?: () => number;
  readonly duration?: number;
  /** 再生の速さ（確認用の早送り） */
  readonly rate?: number;
}

export function createWallClock(opts: WallClockOptions = {}): RideClock & { rate: number } {
  const now = opts.now ?? (() => performance.now() / 1000);
  const duration = opts.duration ?? RIDE_DURATION;
  let base = 0; // running でないときの位置、running のときは anchor 時点の位置
  let anchor = 0; // running になった実時刻
  let running = false;
  let rate = opts.rate ?? 1;
  const clamp = (t: number) => Math.min(duration, Math.max(0, t));
  const current = () => (running ? clamp(base + (now() - anchor) * rate) : base);
  return {
    get time() {
      return current();
    },
    get running() {
      return running;
    },
    get rate() {
      return rate;
    },
    set rate(r: number) {
      base = current();
      anchor = now();
      rate = r;
    },
    start(t = 0) {
      base = clamp(t);
      anchor = now();
      running = true;
    },
    pause() {
      if (!running) return;
      base = current();
      running = false;
    },
    resume() {
      if (running) return;
      anchor = now();
      running = true;
    },
    seek(t) {
      base = clamp(t);
      anchor = now();
    },
  };
}
