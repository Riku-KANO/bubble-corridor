/**
 * Mixer layout. Design doc: サウンドデザイン > 制作方法 — volume is adjustable separately for
 * 全体 / 音楽 / 効果音 / 環境音 (master / music / sfx / ambience).
 * Starting volumes are the game's (Through the Vidro: src/audio/levels.ts).
 */

export const BUSES = ['music', 'sfx', 'ambience'] as const;
export type BusName = (typeof BUSES)[number];

export const VOLUME_CHANNELS = ['master', ...BUSES] as const;
export type VolumeChannel = (typeof VOLUME_CHANNELS)[number];

/**
 * Slider position (0..1) → linear gain. Square-law taper: half the slider ≈ -12 dB, which feels like
 * "half as loud" far better than a linear fader. 0 is true silence.
 */
export function volumeToGain(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  const c = Math.min(1, v);
  return c * c;
}
