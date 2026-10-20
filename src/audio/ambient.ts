// 環境音（雨、水、波、空気、虹の揺らぎ、天球の低い響き）。
// 録音は持たず、雑音を濾して揺らして作る。床は乗車の秒の強さの折れ線（score の ambient）に従って
// 大きくなったり小さくなったりし、強さのない間は止めて CPU を使わない。
import { noiseBuffer } from '../core/sound/voices';
import type { AmbientBed } from './score';

export interface BedNode {
  /** 強さの出口。ここへ折れ線の強さを予約する */
  readonly gain: GainNode;
  stop(): void;
}

/** 床ごとの音量の調整（強さ 1 のときの大きさ）。確認ページで測って決めた */
const BED_TRIM: Readonly<Record<AmbientBed, number>> = {
  water: 0.5,
  air: 0.34,
  rain: 0.5,
  prism: 0.22,
  space: 0.5,
  waves: 0.52,
};

const noises = new WeakMap<BaseAudioContext, AudioBuffer>();
/** 8秒の雑音を1つだけ作って使い回す（繰り返しの周期が耳につかない長さ） */
export function sharedNoise(ctx: BaseAudioContext): AudioBuffer {
  let b = noises.get(ctx);
  if (!b) {
    b = noiseBuffer(ctx, 8, 77);
    noises.set(ctx, b);
  }
  return b;
}

/** 繰り返し再生する雑音の音源。床ごとに開始位置を変えて、同じ波形が重ならないようにする */
function loopNoise(ctx: BaseAudioContext, offset: number): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = sharedNoise(ctx);
  s.loop = true;
  s.start(0, offset);
  return s;
}

/** ゆっくりした揺れ: freq Hz で gain.gain を ±depth だけ動かす（gain の基準値は呼び出し側で決める） */
function wobble(ctx: BaseAudioContext, target: AudioParam, freq: number, depth: number, sources: AudioScheduledSourceNode[]): void {
  const lfo = ctx.createOscillator();
  lfo.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.value = depth;
  lfo.connect(g).connect(target);
  lfo.start();
  sources.push(lfo);
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

export function createBed(ctx: BaseAudioContext, bed: AmbientBed, dest: AudioNode): BedNode {
  const sources: AudioScheduledSourceNode[] = [];
  const out = ctx.createGain();
  out.gain.value = 0;
  const trim = ctx.createGain();
  trim.gain.value = BED_TRIM[bed];
  out.connect(trim).connect(dest);

  const layer = (offset: number, chain: AudioNode[], base: number, wob?: [number, number][]): GainNode => {
    const src = loopNoise(ctx, offset);
    sources.push(src);
    let node: AudioNode = src;
    for (const f of chain) node = node.connect(f);
    const g = ctx.createGain();
    g.gain.value = base;
    node.connect(g).connect(out);
    for (const [freq, depth] of wob ?? []) wobble(ctx, g.gain, freq, depth, sources);
    return g;
  };

  switch (bed) {
    case 'water':
      // 水面のゆるやかな揺れ: 低い雑音を、周期の違う2つの揺れで膨らませる
      layer(0.3, [filter(ctx, 'lowpass', 520)], 0.45, [[0.23, 0.2], [0.37, 0.12]]);
      layer(2.1, [filter(ctx, 'bandpass', 1300, 1.2)], 0.08, [[0.31, 0.06]]);
      break;
    case 'air':
      // ガラスの温室を渡る風: 中域の息のような雑音がゆっくり強弱する
      layer(1.1, [filter(ctx, 'bandpass', 1700, 0.5), filter(ctx, 'lowpass', 4200)], 0.22, [[0.09, 0.12], [0.16, 0.06]]);
      layer(3.4, [filter(ctx, 'highpass', 3500)], 0.03, [[0.21, 0.02]]);
      break;
    case 'rain':
      // 雨: 広い帯域の雑音に、屋根を叩く細かい粒の揺れ
      layer(0.7, [filter(ctx, 'highpass', 700), filter(ctx, 'lowpass', 7000)], 0.3, [[7.3, 0.05], [11.9, 0.04], [17.1, 0.03]]);
      layer(4.2, [filter(ctx, 'bandpass', 300, 0.8)], 0.22, [[0.4, 0.06]]);
      layer(2.6, [filter(ctx, 'bandpass', 2600, 1.5)], 0.1, [[5.3, 0.05]]);
      break;
    case 'prism':
      // プリズムの揺らぎ: 高い帯域の細い共鳴が、ゆっくりきらめく
      layer(1.7, [filter(ctx, 'bandpass', 4600, 9)], 0.35, [[0.43, 0.25]]);
      layer(5.2, [filter(ctx, 'bandpass', 7200, 10)], 0.25, [[0.29, 0.18]]);
      break;
    case 'space': {
      // 天球の低い響き: 深い2つの正弦波と、ごく低い雑音
      for (const [freq, amp] of [
        [55, 0.5],
        [82.5, 0.3],
      ] as const) {
        const o = ctx.createOscillator();
        o.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.value = amp;
        o.connect(g).connect(out);
        o.start();
        sources.push(o);
        wobble(ctx, g.gain, 0.07 + freq / 2000, amp * 0.3, sources);
      }
      layer(3.9, [filter(ctx, 'lowpass', 220)], 0.35, [[0.05, 0.15]]);
      break;
    }
    case 'waves':
      // 波: 低い雑音が約10秒の周期で寄せては返し、泡が少し遅れて立つ
      layer(0.5, [filter(ctx, 'lowpass', 900)], 0.4, [[0.1, 0.35]]);
      layer(2.9, [filter(ctx, 'bandpass', 2400, 0.7)], 0.1, [[0.1, 0.09]]);
      break;
  }
  return {
    gain: out,
    stop() {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          // すでに止まっている
        }
      }
      out.disconnect();
    },
  };
}
