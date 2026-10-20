// 音の配線。ミキサー（全体 / 音楽 / 効果音 / 環境音）、出力の保護（リミッター）、空間ごとの残響の経路をつくる。
//
//   音楽の音 ─→ 残響の経路（区間の広さ）─→ 音楽の門 ─→ mixer.music ┐
//   乗車中の効果音 ─→ 効果音の門 ─────────────────────→ mixer.sfx   ├→ mixer.master → リミッター → 出力
//   UI・遷移の効果音 ───────────────────────────────→ mixer.sfx   │
//   環境音 ─→ 環境音の門 ─────────────────────────→ mixer.ambient ┘
//
// 「門」はポーズで乗車中の音を一斉に止める・再開するための音量の入り口。UI の効果音だけは通さない
// （ポーズの項目を触る音は、乗車が止まっていても鳴る）。
import { createMixer } from '../core/sound/mixer';
import type { Mixer } from '../core/sound/mixer';
import { createReverb } from '../core/sound/space';
import type { ReverbSize } from '../core/sound/space';

export interface ReverbBus {
  /** 乾いた音と残響の両方に入れる */
  readonly input: GainNode;
  /** 残響にだけ入れる（効果音の響きづけ） */
  readonly send: GainNode;
}

export interface Graph {
  readonly mixer: Mixer;
  /** 乗車中の音楽・環境音・効果音をまとめて止める門 */
  readonly musicGate: GainNode;
  readonly ambientGate: GainNode;
  readonly sfxGate: GainNode;
  /** UI・遷移の効果音の入り口（門を通さない） */
  readonly ui: GainNode;
  /** 区間の広さごとの残響の経路 */
  readonly reverbs: Readonly<Record<ReverbSize, ReverbBus>>;
  /** 3つの門を開ける・閉める（when は AudioContext の秒、timeConstant は滑らかさ） */
  setGates(open: boolean, when: number, timeConstant?: number): void;
}

/** 残響の広さごとの、乾いた音と響きの割合 */
const MIX: Readonly<Record<ReverbSize, { dry: number; wet: number }>> = {
  dry: { dry: 1, wet: 0.22 },
  small: { dry: 1, wet: 0.34 },
  medium: { dry: 0.92, wet: 0.44 },
  large: { dry: 0.82, wet: 0.56 },
  huge: { dry: 0.72, wet: 0.7 },
};

const SIZES: readonly ReverbSize[] = ['dry', 'small', 'medium', 'large', 'huge'];

export function createGraph(ctx: BaseAudioContext): Graph {
  // 出力の保護: 音が重なる頂点でも割れないよう、ゆるいリミッターを最後に置く
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 8;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);
  const mixer = createMixer(ctx, limiter);
  mixer.setVolumes({ master: 0.85, music: 0.85, sfx: 0.9, ambient: 0.8 }, 0.001);

  const musicGate = ctx.createGain();
  musicGate.connect(mixer.music);
  const ambientGate = ctx.createGain();
  ambientGate.connect(mixer.ambient);
  const sfxGate = ctx.createGain();
  sfxGate.connect(mixer.sfx);
  const ui = ctx.createGain();
  ui.connect(mixer.sfx);

  const reverbs = {} as Record<ReverbSize, ReverbBus>;
  for (const size of SIZES) {
    const input = ctx.createGain();
    const send = ctx.createGain();
    const dry = ctx.createGain();
    dry.gain.value = MIX[size].dry;
    const wet = ctx.createGain();
    wet.gain.value = MIX[size].wet;
    const conv = createReverb(ctx, size);
    input.connect(dry).connect(musicGate);
    input.connect(conv);
    send.connect(conv);
    conv.connect(wet).connect(musicGate);
    reverbs[size] = { input, send };
  }

  return {
    mixer,
    musicGate,
    ambientGate,
    sfxGate,
    ui,
    reverbs,
    setGates(open, when, timeConstant = 0.03) {
      for (const g of [musicGate, ambientGate, sfxGate]) {
        g.gain.cancelScheduledValues(when);
        g.gain.setTargetAtTime(open ? 1 : 0, when, timeConstant);
      }
    },
  };
}
