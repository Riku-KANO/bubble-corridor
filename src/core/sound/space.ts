// 立体音響と空間ごとの残響。案1と共有する（音の仕組み）。
// ヘッドホンでは方向が分かる立体音響（HRTF）を使う。残響は部屋の広さに合わせて変える。

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

export function createSpatialPanner(
  ctx: BaseAudioContext,
  position?: readonly [number, number, number],
): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  if (position) {
    if (p.positionX) {
      p.positionX.value = position[0];
      p.positionY.value = position[1];
      p.positionZ.value = position[2];
    } else {
      // AudioParam を持たない古い実装（旧 Safari）
      (p as unknown as { setPosition?: (x: number, y: number, z: number) => void }).setPosition?.(
        position[0],
        position[1],
        position[2],
      );
    }
  }
  return p;
}

/**
 * 聞き手の位置と向きを置く。when を渡すとその時刻（AudioContext の秒）に、なければ今すぐ反映する。
 * yaw は -Z を 0 として左回りが正（three.js の Euler.y と同じ）、pitch は上向きが正（Euler.x と同じ）。
 */
export function setListenerPose(listener: AudioListener, pose: SpacePose, when?: number): void {
  const cy = Math.cos(pose.yaw);
  const sy = Math.sin(pose.yaw);
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  // 前: (0,0,-1) を pitch(X) → yaw(Y) の順に回した向き。上: (0,1,0) を同じに回した向き
  const fx = -cp * sy;
  const fy = sp;
  const fz = -cp * cy;
  const ux = sy * sp;
  const uy = cp;
  const uz = cy * sp;
  if (listener.positionX) {
    // 毎フレーム呼ばれる。関数や配列を作らず、AudioParam に直接書く
    if (when === undefined) {
      listener.positionX.value = pose.x;
      listener.positionY.value = pose.y;
      listener.positionZ.value = pose.z;
      listener.forwardX.value = fx;
      listener.forwardY.value = fy;
      listener.forwardZ.value = fz;
      listener.upX.value = ux;
      listener.upY.value = uy;
      listener.upZ.value = uz;
    } else {
      listener.positionX.setValueAtTime(pose.x, when);
      listener.positionY.setValueAtTime(pose.y, when);
      listener.positionZ.setValueAtTime(pose.z, when);
      listener.forwardX.setValueAtTime(fx, when);
      listener.forwardY.setValueAtTime(fy, when);
      listener.forwardZ.setValueAtTime(fz, when);
      listener.upX.setValueAtTime(ux, when);
      listener.upY.setValueAtTime(uy, when);
      listener.upZ.setValueAtTime(uz, when);
    }
  } else {
    // AudioParam を持たない古い実装（旧 Safari）
    const legacy = listener as unknown as {
      setPosition?: (x: number, y: number, z: number) => void;
      setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
    };
    legacy.setPosition?.(pose.x, pose.y, pose.z);
    legacy.setOrientation?.(fx, fy, fz, ux, uy, uz);
  }
}

/** 決定的な乱数（mulberry32）。同じ種からは同じ並びになる */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZE_INDEX: Readonly<Record<ReverbSize, number>> = { dry: 1, small: 2, medium: 3, large: 4, huge: 5 };

/**
 * 残響の応答（インパルス応答）をその場で作る。録音のファイルは持たない。
 * 指数に減衰するノイズ（RT60 = REVERB_SECONDS）に、時間とともに高域を落とす簡単な空気の吸収と、
 * 最初の数十ミリ秒の初期反射を足す。左右は別の乱数で作るので広がりが出る。
 */
export function createReverbImpulse(ctx: BaseAudioContext, size: ReverbSize, seed = 1): AudioBuffer {
  const rt60 = REVERB_SECONDS[size];
  const sr = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sr * rt60));
  const buffer = ctx.createBuffer(2, length, sr);
  // 部屋が広いほど、初期反射が遅くまばらになる
  const spread = 0.012 + SIZE_INDEX[size] * 0.012;
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const rnd = rng(seed * 7919 + SIZE_INDEX[size] * 104729 + ch * 1299709);
    let lp = 0;
    // 60dB 下がるのが rt60 秒後: 1サンプルごとに掛ける定数（Math.pow を毎サンプル呼ばない）
    const decay = 10 ** (-3 / (rt60 * sr));
    let env = 1;
    const brightEnd = Math.max(1, Math.floor(sr * rt60 * 0.7));
    const fadeIn = Math.max(1, Math.floor(sr * 0.004));
    for (let i = 0; i < length; i++) {
      // 高域は早く消える: 一極のローパスの係数を 0.9 → 0.12 へ動かす
      const a = 0.9 - 0.78 * Math.min(1, i / brightEnd);
      lp += a * ((rnd() * 2 - 1) * env - lp);
      env *= decay;
      data[i] = i < fadeIn ? lp * (i / fadeIn) : lp;
    }
    // 初期反射: 数本の鋭い反射を足して、部屋の壁の位置を感じさせる
    for (let k = 0; k < 6; k++) {
      const at = Math.floor(sr * (0.006 + rnd() * spread * (1 + k)));
      if (at < length)
        data[at] = (data[at] ?? 0) + (rnd() < 0.5 ? -1 : 1) * (0.9 - k * 0.1) * (0.5 + 0.5 * rnd());
    }
  }
  return buffer;
}

export function createReverb(ctx: BaseAudioContext, size: ReverbSize): ConvolverNode {
  const c = ctx.createConvolver();
  c.buffer = createReverbImpulse(ctx, size);
  return c;
}
