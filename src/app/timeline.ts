// 画面効果と殻を、乗車の時刻から決める（純粋）。
// 柱「時刻から決める」: ?t= で途中から始めても、巻き戻しても、同じ時刻なら同じ絵になる。フレームの積み上げで状態を作らない。
// 時刻は config とキューシートから読む（膜・見どころ・降車の時刻をここに書き写さない）。
import { CELESTIAL_BLACKOUT_SEC, FX_TIMELINE, TRANSITION_SEC } from '../config';
import type { Cue } from '../contracts/events';
import type { ComfortMode } from '../contracts/ids';
import { smoothstep } from '../core/easing';

/** 殻が閉じ始める乗車の秒（ゴンドラが浮かび上がった後）。閉じる音もこの時刻に鳴らす */
export const BOARD_START_SEC = FX_TIMELINE.boardStartSec;
/** 暗転の入りにかける秒（唯一の黒でも、入りは急な明るさの変化にしない。膜を通る瞬間とそろえる短さ） */
export const BLACKOUT_ENTER_SEC = FX_TIMELINE.blackoutEnterSec;
/** 暗転のあとの点灯にかける秒。光の点滅を抑えるモードではもっとゆっくり（急な明るさの変化を避ける） */
export const BLACKOUT_RAMP_SEC = FX_TIMELINE.blackoutRampSec;
export const BLACKOUT_RAMP_REDUCED_SEC = FX_TIMELINE.blackoutRampReducedSec;
/** 万華鏡の折り返しが満ちるまでの秒と、天球の頭に向けて引くまでの秒 */
export const KALEIDOSCOPE_FADE_IN_SEC = FX_TIMELINE.kaleidoscopeFadeInSec;
export const KALEIDOSCOPE_FADE_OUT_SEC = FX_TIMELINE.kaleidoscopeFadeOutSec;
/** 万華鏡の模様の回転の速さ（ラジアン/秒）。穏やかモードでは止める */
export const KALEIDOSCOPE_SPIN_RAD_PER_SEC = FX_TIMELINE.kaleidoscopeSpinRadPerSec;
/** 見どころの前後でブルームが強まる幅（秒、頂点から片側）と頂点の強さ（0〜1）。設計書に値がないので仮 */
export const BLOOM_HALF_SEC = FX_TIMELINE.bloomHalfSec;
export const BLOOM_PEAK = FX_TIMELINE.bloomPeak;

/** ブルームが頂点になる見どころ（花・模様・星座・朝日） */
const BLOOM_CUES: readonly Cue['name'][] = ['greenhouse.bloom', 'kaleidoscope.flower', 'celestial.constellation', 'dawn.sunrise'];

export interface FxTimelineOptions {
  readonly comfort: ComfortMode;
  /** 光の点滅や強い閃光を抑えるモード */
  readonly reducedFlash: boolean;
  /** 乗車中（ポーズを含む）か。乗車の外では何もしない */
  readonly riding: boolean;
}

/** 乗車の時刻から決まる画面効果と殻の値 */
export interface FxTimeline {
  /** 泡の殻の閉じ具合（0: 開、1: 閉）。ゴンドラの殻と画面の泡の縁に共通で使う */
  bubble: number;
  membrane: number;
  brightness: number;
  kaleidoscope: number;
  kaleidoscopeAngle: number;
  bloom: number;
}

/** キューシートから一度だけ取り出す時刻（毎フレーム配列を作らない） */
interface Times {
  readonly membranes: readonly number[];
  readonly blooms: readonly number[];
  /** 万華鏡の頭（万華鏡の区間への膜）。なければ Infinity */
  readonly kaleidoscopeStart: number;
  /** 暗転の頭（天球の頭） */
  readonly blackout: number;
  /** 殻が開き始める（降車） */
  readonly open: number;
}

const cache = new WeakMap<readonly Cue[], Times>();

function timesOf(cues: readonly Cue[]): Times {
  let times = cache.get(cues);
  if (times) return times;
  const first = (name: Cue['name'], pick: (c: Cue) => boolean = () => true): number => cues.find((c) => c.name === name && pick(c))?.t ?? Infinity;
  times = {
    membranes: cues.filter((c) => c.name === 'membrane').map((c) => c.t),
    blooms: cues.filter((c) => BLOOM_CUES.includes(c.name)).map((c) => c.t),
    kaleidoscopeStart: first('membrane', (c) => c.data?.to === 'kaleidoscope'),
    blackout: first('celestial.blackout'),
    open: first('departure.open'),
  };
  cache.set(cues, times);
  return times;
}

/** smoothstep。始点が決まっていない（キューシートにその出来事がない）ときは 0（NaN を作らない） */
const ramp = (from: number, to: number, t: number): number => (Number.isFinite(from) ? smoothstep(from, to, t) : 0);

/** 乗車の外（またはキューシートに何もないとき）の値 */
function rest(out: FxTimeline): FxTimeline {
  out.bubble = 0;
  out.membrane = 0;
  out.brightness = 1;
  out.kaleidoscope = 0;
  out.kaleidoscopeAngle = 0;
  out.bloom = 0;
  return out;
}

/**
 * 乗車の秒 t の、画面効果と殻の値。同じ入力なら同じ出力（状態を持たない）。
 * out を渡すと、そのオブジェクトに書いて返す（毎フレーム呼ぶときの確保を避ける）。
 */
export function fxAt(
  t: number,
  cues: readonly Cue[],
  options: FxTimelineOptions,
  out: FxTimeline = { bubble: 0, membrane: 0, brightness: 1, kaleidoscope: 0, kaleidoscopeAngle: 0, bloom: 0 },
): FxTimeline {
  rest(out);
  if (!options.riding) return out;
  const times = timesOf(cues);

  // 泡の殻: 乗車の頭で下から上へ閉じ（2秒）、降車で上から下へ開く（2秒）
  const boarding = TRANSITION_SEC.boarding;
  out.bubble = smoothstep(BOARD_START_SEC, BOARD_START_SEC + boarding, t) * (1 - ramp(times.open, times.open + boarding, t));

  // 膜: 通る瞬間に 1、前後に半分ずつ（0.6秒）で 0
  const half = TRANSITION_SEC.membrane / 2;
  let membrane = 0;
  for (let i = 0; i < times.membranes.length; i++) {
    const d = Math.abs(t - times.membranes[i]);
    if (d < half) membrane = Math.max(membrane, 1 - d / half);
  }
  out.membrane = membrane;

  // 唯一の暗闇（天球の頭の2秒）。入りは短くなめらかに、点灯はゆっくり（点滅を抑えるモードではもっと）。点灯が済んだ後は 1 のまま
  const rampSec = options.reducedFlash ? BLACKOUT_RAMP_REDUCED_SEC : BLACKOUT_RAMP_SEC;
  const lit = times.blackout + CELESTIAL_BLACKOUT_SEC;
  out.brightness =
    t < times.blackout || t > lit + rampSec ? 1 : 1 - smoothstep(times.blackout, times.blackout + BLACKOUT_ENTER_SEC, t) * (1 - smoothstep(lit, lit + rampSec, t));

  // 万華鏡の折り返しは万華鏡の区間だけ（天球の頭に向けて引く）。回転は時刻から決める（穏やかモードでは止める）
  const k0 = times.kaleidoscopeStart;
  out.kaleidoscope = ramp(k0, k0 + KALEIDOSCOPE_FADE_IN_SEC, t) * (1 - ramp(times.blackout - KALEIDOSCOPE_FADE_OUT_SEC, times.blackout, t));
  out.kaleidoscopeAngle =
    options.comfort === 'standard' && Number.isFinite(k0) ? Math.max(0, Math.min(t, times.blackout) - k0) * KALEIDOSCOPE_SPIN_RAD_PER_SEC : 0;

  // ブルームは見どころの前後だけ（頂点は見どころの時刻）。ゆっくり満ちてゆっくり引く ── 点滅の抑えるモードの縮小は fx の側で行う
  let bloom = 0;
  for (let i = 0; i < times.blooms.length; i++) {
    const d = Math.abs(t - times.blooms[i]);
    if (d < BLOOM_HALF_SEC) bloom = Math.max(bloom, BLOOM_PEAK * (1 - smoothstep(0, BLOOM_HALF_SEC, d)));
  }
  out.bloom = bloom;
  return out;
}
