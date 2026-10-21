// 同時発音の予算。楽曲の音源（オシレーターなど）の数が予算を超える楽句（4小節）だけ、音を間引く。
//
// 間引きを「その瞬間の混み具合」で1音ずつ決めると、リズムのように規則的に並ぶ音が1つずつ散らばって抜ける。
// そこで4小節の楽句ごとに間引きの level（performer.ts の keepNote）を、楽曲の予定だけから先に決めておく:
// 頭の楽句から順に、level を試し、その楽句の中で同時に鳴る音源の数が予算に収まる最小の level を選ぶ。
// 数えるときは、先読みで予約しただけの音を「鳴り始める時刻」から数える（Voice.liveSources(at)）。
// 試算は、音を出さない偽の AudioContext に実際の音色（playGlass / playPad）を作らせて行うので、
// 本番の音源の数・始まりと止まりの時刻と一致する。結果は扉・予算ごとに、実行時の状態に左右されず時刻だけで決まる。
import type { DoorChoice } from '../contracts/ids';
import { RIDE_BARS, SEC_PER_BAR } from '../config';
import { planNotes } from './conductor';
import { performNotes, VoiceSet } from './performer';
import type { ShedPolicy } from './performer';

/** 間引きの level の最大（performer.ts の keepNote） */
export const MAX_SHED_LEVEL = 3;
/** 1 小節の中で同時発音数を測る点の数（音の始まりは 16 分音符の格子の上にある） */
const SAMPLES_PER_BAR = 16;

/** 音を出さない偽のノード（音源の数と、始まり・止まりの時刻だけを数えるために使う） */
function fakeParam(): AudioParam {
  const p = {
    value: 0,
    setValueAtTime() {
      return p;
    },
    linearRampToValueAtTime() {
      return p;
    },
    exponentialRampToValueAtTime() {
      return p;
    },
    setTargetAtTime() {
      return p;
    },
    cancelScheduledValues() {
      return p;
    },
    cancelAndHoldAtTime() {
      return p;
    },
  };
  return p as unknown as AudioParam;
}

function fakeNode(extra: object = {}): unknown {
  const n = {
    connect(dest: unknown) {
      return dest;
    },
    disconnect() {},
    ...extra,
  };
  return n;
}

/** 音を出さずに音源の数だけ数える偽の AudioContext（currentTime は呼び出し側が進める）。確認用にも使う */
export function createCountingContext(sampleRate = 48000): { currentTime: number } & BaseAudioContext {
  const ctx = {
    currentTime: 0,
    sampleRate,
    createGain: () => fakeNode({ gain: fakeParam() }),
    createOscillator: () => fakeNode({ type: 'sine', frequency: fakeParam(), detune: fakeParam(), start() {}, stop() {} }),
    createBiquadFilter: () => fakeNode({ type: 'lowpass', frequency: fakeParam(), Q: fakeParam() }),
    createBufferSource: () => fakeNode({ buffer: null, loop: false, start() {}, stop() {} }),
    createBuffer: (_channels: number, length: number) => {
      const data = new Float32Array(length);
      return { length, numberOfChannels: 1, sampleRate, duration: length / sampleRate, getChannelData: () => data };
    },
    destination: fakeNode(),
  };
  return ctx as unknown as { currentTime: number } & BaseAudioContext;
}

/** 間引きの level を決める単位（小節）。4小節の楽句ごとに同じ level にして、小節ごとに濃くなったり薄くなったりしないようにする */
export const SHED_BLOCK_BARS = 4;

/** 小節ごとの間引きの level の表を、頭の楽句から順に作っていく（途中まででも使える） */
export interface ShedBuilder extends ShedPolicy {
  /** 小節ごとの level。まだ決めていない小節は 0 */
  readonly levels: Uint8Array;
  /** 何小節目まで決めたか */
  readonly decided: number;
  readonly done: boolean;
  /** 少なくとも bars 小節ぶん先へ進める（楽句の単位。4小節あたり数ミリ秒。重い準備の合間に少しずつ呼べる） */
  advance(bars: number): void;
  /** 小節ごとの、間引いた後の同時発音数の最大（確認用） */
  readonly peaks: Float32Array;
}

/**
 * 楽曲の同時発音（音源の数）を budget に収める間引きの表を作る。
 * 4小節の楽句ごとに、予算に収まる最小の level を選ぶ。ただし level は1つ前の楽句より1つまでしか下げない
 * （薄くなった後、すぐ全部が戻って、また薄くなる、を繰り返さない）。
 * 持続音・低音・主旋律だけでも予算を超える所は level 3 のまま許す。
 */
export function createShedBuilder(door: DoorChoice, budget: number): ShedBuilder {
  const levels = new Uint8Array(RIDE_BARS);
  const peaks = new Float32Array(RIDE_BARS);
  const trialLevels = new Uint8Array(RIDE_BARS);
  const ctx = createCountingContext();
  const dest = ctx.destination;
  let carry = new VoiceSet(); // 前の楽句までに予約した音
  let decided = 0;
  let prevLevel = 0;
  const notesScratch: ReturnType<typeof planNotes> = [];
  const policy: ShedPolicy = { levelAt: (t) => trialLevels[Math.min(RIDE_BARS - 1, Math.floor(t / SEC_PER_BAR + 1e-9))] };

  /** 楽句（bar0 から n 小節）に level を当てて試し、小節ごとの同時発音数の最大と、予約後の音の並びを返す */
  function trial(bar0: number, n: number, level: number, out: Float32Array): VoiceSet {
    const voices = carry.clone();
    for (let b = bar0; b < bar0 + n; b++) {
      const t0 = b * SEC_PER_BAR;
      trialLevels[b] = level;
      ctx.currentTime = t0;
      // 窓の終わりは (b + 1) * SEC_PER_BAR（t0 + SEC_PER_BAR だと浮動小数点の誤差で、次の小節の頭の音を二重に数える）
      performNotes(ctx, planNotes(t0, (b + 1) * SEC_PER_BAR, door, notesScratch), () => dest, (t) => t, voices, policy, t0);
      let peak = 0;
      for (let k = 0; k < SAMPLES_PER_BAR; k++) {
        // 始まりの時刻ちょうどの音を数えるため、ほんの少し後で数える
        const at = t0 + (k / SAMPLES_PER_BAR) * SEC_PER_BAR + 1e-6;
        const live = voices.liveAt(at);
        if (live > peak) peak = live;
      }
      out[b - bar0] = peak;
    }
    return voices;
  }

  const blockPeaks = new Float32Array(SHED_BLOCK_BARS);
  const builder: ShedBuilder = {
    levels,
    peaks,
    get decided() {
      return decided;
    },
    get done() {
      return decided >= RIDE_BARS;
    },
    advance(bars) {
      const end = Math.min(RIDE_BARS, decided + bars);
      while (decided < end) {
        const bar0 = decided;
        const n = Math.min(SHED_BLOCK_BARS, RIDE_BARS - bar0);
        let level = Math.max(0, prevLevel - 1);
        let voices = trial(bar0, n, level, blockPeaks);
        while (level < MAX_SHED_LEVEL && Math.max(...blockPeaks.subarray(0, n)) > budget) voices = trial(bar0, n, ++level, blockPeaks);
        for (let i = 0; i < n; i++) {
          levels[bar0 + i] = level;
          peaks[bar0 + i] = blockPeaks[i];
        }
        carry = voices;
        carry.prune((bar0 + n) * SEC_PER_BAR);
        prevLevel = level;
        decided += n;
      }
    },
    levelAt(t) {
      const bar = Math.min(RIDE_BARS - 1, Math.max(0, Math.floor(t / SEC_PER_BAR + 1e-9)));
      // まだ決めていない小節に先読みが届いたら、そこまで今決める（頭の楽句から順にしか決められない）
      if (bar >= decided) builder.advance(bar + 1 - decided);
      return levels[bar];
    },
  };
  return builder;
}
