// 立体音響と空間ごとの残響。案1と共有する（音の仕組み）。
// ヘッドホンでは方向が分かる立体音響（HRTF）を使う。残響は部屋の広さに合わせて変える。
// STUB: 署名は確定。中身は audio 担当が本実装に置き換える。

export interface SpacePose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 頭の向き（ラジアン、-Z が 0、左回りが正） */
  readonly yaw: number;
  readonly pitch: number;
}

/** 残響の大きさ。回廊は短く乾いた響き、天球は長く深い響き */
export type ReverbSize = 'dry' | 'small' | 'medium' | 'large' | 'huge';

/** 残響の長さ（秒、RT60 の目安） */
export const REVERB_SECONDS: Readonly<Record<ReverbSize, number>> = {
  dry: 0.4,
  small: 1.0,
  medium: 2.0,
  large: 3.5,
  huge: 6.0,
};

export function createSpatialPanner(ctx: BaseAudioContext, position?: readonly [number, number, number]): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  if (position) {
    p.positionX.value = position[0];
    p.positionY.value = position[1];
    p.positionZ.value = position[2];
  }
  return p;
}

export function setListenerPose(_listener: AudioListener, _pose: SpacePose, _when?: number): void {
  // STUB
}

/** 残響の応答（インパルス応答）をその場で作る。録音のファイルは持たない */
export function createReverbImpulse(ctx: BaseAudioContext, _size: ReverbSize, _seed = 1): AudioBuffer {
  return ctx.createBuffer(2, Math.max(1, Math.floor(ctx.sampleRate * 0.01)), ctx.sampleRate); // STUB
}

export function createReverb(ctx: BaseAudioContext, size: ReverbSize): ConvolverNode {
  const c = ctx.createConvolver();
  c.buffer = createReverbImpulse(ctx, size);
  return c;
}
