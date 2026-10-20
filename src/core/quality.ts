/**
 * Quality presets from the design doc (技術設計 > 品質プリセット).
 * Pure data: scenes and systems read these values, nothing here touches the GPU.
 */
export type QualityLevel = 'low' | 'mid' | 'high';

export interface QualityPreset {
  /** Render resolution scale relative to the canvas size × devicePixelRatio. */
  renderScale: number;
  /**
   * Resolution of the transmission background buffer relative to the render size (design value).
   * Has no effect on three r186 (S-10): the backdrop is always copied at the size of the render target, so only
   * renderScale and dynamic resolution change it. Kept for the design table and a future three option.
   */
  transmissionScale: number;
  /** Resolution of the back-layer target while peeking. */
  peekScale: number;
  /** Where chromatic dispersion is allowed. */
  dispersion: 'none' | 'orb' | 'showcase';
  /** Shadow map size for moving objects. 0 = baked only. */
  dynamicShadowSize: 0 | 1024 | 2048;
  /** Far glass uses the cheap env-reflection + haze path unless this is true. */
  farGlassTransmission: boolean;
  antialias: 'fxaa' | 'smaa';
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, Readonly<QualityPreset>>> = {
  low: {
    renderScale: 0.67,
    transmissionScale: 0.25,
    peekScale: 0.5,
    dispersion: 'none',
    dynamicShadowSize: 0,
    farGlassTransmission: false,
    antialias: 'fxaa',
  },
  mid: {
    renderScale: 0.85,
    transmissionScale: 0.5,
    peekScale: 0.6,
    dispersion: 'orb',
    dynamicShadowSize: 1024,
    farGlassTransmission: false,
    antialias: 'smaa',
  },
  high: {
    renderScale: 1.0,
    transmissionScale: 1.0,
    peekScale: 0.75,
    dispersion: 'showcase',
    dynamicShadowSize: 2048,
    farGlassTransmission: true,
    antialias: 'smaa',
  },
};

export function isQualityLevel(value: unknown): value is QualityLevel {
  return value === 'low' || value === 'mid' || value === 'high';
}
