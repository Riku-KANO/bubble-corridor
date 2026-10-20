// 品質プリセットと自動判定。案1と共有する。
// STUB: 署名は確定。中身は M0（core-visual 担当）で本実装に置き換える。

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityPreset {
  readonly tier: QualityTier;
  /** devicePixelRatio の上限 */
  readonly maxPixelRatio: number;
  /** 描画解像度の倍率の初期値（動的な解像度調整はこの範囲で動かす） */
  readonly renderScale: number;
  readonly minRenderScale: number;
  /** 1秒あたりの描画回数の目標 */
  readonly targetFps: number;
  /** 後処理（膜の縞、ブルーム、泡の縁）を使うか */
  readonly postFx: boolean;
  /** 粒子・インスタンスの数にかける倍率（0〜1） */
  readonly particleScale: number;
  /** 反射用の環境画像の一辺（px） */
  readonly envMapSize: number;
  readonly antialias: boolean;
}

/** 起動時に分かる端末の手がかり */
export interface DeviceHints {
  readonly isMobile: boolean;
  /** VR で描くか（速さを最優先にする） */
  readonly isXR: boolean;
  /** WebGL の UNMASKED_RENDERER など（分からなければ undefined） */
  readonly gpu?: string;
  readonly hardwareConcurrency?: number;
  readonly deviceMemoryGB?: number;
  /** 画面の画素数（width × height × dpr²） */
  readonly screenPixels?: number;
}

export function detectTier(hints: DeviceHints): QualityTier {
  // STUB
  return hints.isMobile || hints.isXR ? 'low' : 'medium';
}

export function presetFor(tier: QualityTier, hints: DeviceHints): QualityPreset {
  // STUB
  return {
    tier,
    maxPixelRatio: hints.isMobile ? 1.5 : 2,
    renderScale: 1,
    minRenderScale: 0.6,
    targetFps: hints.isXR ? 72 : hints.isMobile ? 30 : 60,
    postFx: tier !== 'low' && !hints.isXR,
    particleScale: tier === 'high' ? 1 : tier === 'medium' ? 0.7 : 0.4,
    envMapSize: tier === 'high' ? 512 : 256,
    antialias: tier !== 'low',
  };
}

/**
 * 動的な解像度調整。フレームの時間を受け取り、目標の fps を保てるよう描画解像度の倍率を上下させる。
 * STUB: 倍率を変えない。
 */
export class DynamicResolution {
  private current: number;
  constructor(private readonly preset: QualityPreset) {
    this.current = preset.renderScale;
  }
  get scale(): number {
    return this.current;
  }
  /** 1フレームの時間（ms）を渡す。新しい倍率を返す */
  sample(_frameMs: number): number {
    return this.current;
  }
  reset(): void {
    this.current = this.preset.renderScale;
  }
}
