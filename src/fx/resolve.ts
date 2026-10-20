// 画面効果の強さを決める（純粋）。状態 → 効果ごとの強さ。描画（TSL）はこの値を uniform に渡すだけ。
// 「色収差やブルームなどの画面効果は、膜を通る瞬間と見どころにだけ強める」（設計書 › 見せ方のルール）。
import type { ScreenFxState } from '../contracts/fx';

/** 効果ごとの強さ。foldAngle（ラジアン）以外はすべて 0〜1 */
export interface FxParams {
  /** 泡越しの視界の縁（0〜0.5。かすかに。中央は澄んだまま） */
  readonly edge: number;
  /** 膜の薄膜干渉の縞 */
  readonly stripes: number;
  /** 膜の放射状の歪み */
  readonly distortion: number;
  /** 色収差（膜を通る瞬間だけ） */
  readonly aberration: number;
  /** 万華鏡の折り返しの混ぜ具合 */
  readonly fold: number;
  /** 万華鏡の模様の回転（ラジアン） */
  readonly foldAngle: number;
  /** ブルーム */
  readonly bloom: number;
  /** 白い霧 */
  readonly white: number;
  /** 暗さ（黒い画面。明るさ brightness からだけ作る） */
  readonly darkness: number;
}

export interface FxOptions {
  /** 光の点滅や強い閃光を抑えるモード */
  readonly reducedFlash: boolean;
}

/** 泡越しの縁の上限。乗車中ずっと出ているので、気づくか気づかないかの強さに留める */
export const EDGE_MAX = 0.5;
/** 膜を通る瞬間にブルームへ足す分（見どころ以外でもブルームは膜でだけ強まる） */
export const MEMBRANE_BLOOM = 0.35;
/** 光の点滅を抑えるモードでの縞とブルームの倍率（設計書: 半分以下） */
export const REDUCED_FLASH_SCALE = 0.4;

const clamp01 = (v: number, fallback = 0): number => (Number.isFinite(v) ? (v <= 0 ? 0 : v >= 1 ? 1 : v) : fallback);

export function resolveFx(state: ScreenFxState, options: FxOptions): FxParams {
  const flash = options.reducedFlash ? REDUCED_FLASH_SCALE : 1;
  const membrane = clamp01(state.membrane);
  return {
    edge: EDGE_MAX * clamp01(state.bubble),
    stripes: membrane * flash,
    distortion: membrane,
    // 色収差は膜の瞬間だけ。通過の山で急に立ち上がるよう2乗にする
    aberration: membrane * membrane,
    fold: clamp01(state.kaleidoscope),
    foldAngle: Number.isFinite(state.kaleidoscopeAngle) ? state.kaleidoscopeAngle : 0,
    bloom: clamp01(clamp01(state.bloom) + MEMBRANE_BLOOM * membrane) * flash,
    white: clamp01(state.whiteFog),
    darkness: 1 - clamp01(state.brightness, 1),
  };
}

/** どの効果も働いていない（後処理を通さず素通しで描いてよい） */
export function isNeutral(p: FxParams): boolean {
  return p.edge === 0 && p.stripes === 0 && p.distortion === 0 && p.aberration === 0 && p.fold === 0 && p.bloom === 0 && p.white === 0 && p.darkness === 0;
}
