import { percentile } from '../bench';
import { QUALITY_PRESETS, type QualityLevel } from '../quality';

/**
 * Automatic quality selection (技術設計 > 品質プリセット):
 * measure the first seconds at one preset, then recommend the highest preset that fits 60 fps with headroom.
 * Pure: the app feeds samples, this only decides.
 */
export interface QualityDecision {
  level: QualityLevel;
  basis: 'gpu' | 'frame';
  measuredAt: QualityLevel;
  p90FrameMs: number;
  p90GpuMs: number | null;
  /** Estimated GPU ms per preset (gpu basis only). */
  estimatedMs: Record<QualityLevel, number> | null;
  reason: string;
}

export const LEVELS: readonly QualityLevel[] = ['low', 'mid', 'high'];
export const TARGET_MS = 1000 / 60;
/** Leave 20% of the frame for spikes and for the game systems added after M0. */
export const HEADROOM = 0.8;
export const HEADROOM_MS = TARGET_MS * HEADROOM;

/**
 * Relative GPU cost of each preset, mid = 1. Presets differ in more than resolution (far-glass transmission,
 * dispersion, shadow size), so a pixel-count model underestimates "high".
 * Measured on the stress scene at 1080p with vsync off (S-05, Apple M5 Pro, frame time):
 *   WebGPU  low/mid 0.80, high/mid 1.42 · WebGL2 low/mid 0.95, high/mid 1.24.
 * "high" is kept deliberately conservative (1.7): the factor is only used to decide an upgrade, and
 * weaker GPUs pay more for full-resolution transmission. Re-calibrate on the recommended hardware (S-07).
 */
export const COST_FACTOR: Readonly<Record<QualityLevel, number>> = { low: 0.85, mid: 1, high: 1.7 };

export function estimateGpuMs(measuredMs: number, from: QualityLevel, to: QualityLevel): number {
  return (measuredMs * COST_FACTOR[to]) / COST_FACTOR[from];
}

export function stepLevel(level: QualityLevel, delta: -1 | 1): QualityLevel {
  const i = Math.min(LEVELS.length - 1, Math.max(0, LEVELS.indexOf(level) + delta));
  return LEVELS[i] ?? level;
}

const sorted = (values: readonly number[]) =>
  values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);

/** Whether GPU time sampled after a switch fits the headroom; null when there is nothing to judge. */
export function fitsHeadroom(gpuMs: readonly number[]): boolean | null {
  const s = sorted(gpuMs);
  return s.length === 0 ? null : percentile(s, 0.9) <= HEADROOM_MS;
}

/**
 * Frame-time check used when GPU time is unavailable or untrustworthy: frames that miss vsync with jitter fail;
 * 60 Hz and a steady frame-rate cap pass. null when there is nothing to judge.
 */
export function fitsFrameBudget(frameMs: readonly number[]): boolean | null {
  const s = sorted(frameMs);
  if (s.length === 0) return null;
  const p90 = percentile(s, 0.9);
  if (p90 - percentile(s, 0.1) < 1) return true;
  return p90 <= TARGET_MS * 1.25;
}

export function recommendQuality(
  frameMs: readonly number[],
  gpuMs: readonly number[],
  measuredAt: QualityLevel,
): QualityDecision {
  const frames = sorted(frameMs);
  const gpus = sorted(gpuMs);
  const base = { measuredAt, estimatedMs: null, p90GpuMs: null };

  if (frames.length === 0) {
    return { ...base, level: measuredAt, basis: 'frame', p90FrameMs: 0, reason: 'no samples' };
  }
  const frameP90 = percentile(frames, 0.9);

  if (gpus.length >= 10) {
    const gpuP90 = percentile(gpus, 0.9);
    const estimatedMs = Object.fromEntries(
      LEVELS.map((l) => [l, estimateGpuMs(gpuP90, measuredAt, l)]),
    ) as Record<QualityLevel, number>;
    const gpu = { ...base, basis: 'gpu' as const, p90FrameMs: frameP90, p90GpuMs: gpuP90, estimatedMs };

    if (frameP90 > TARGET_MS * 1.1 && gpuP90 < TARGET_MS * 0.6) {
      return { ...gpu, level: measuredAt, reason: 'cpu-bound: frames are slow but the GPU is idle' };
    }
    const fits = [...LEVELS].reverse().find((l) => estimatedMs[l] <= HEADROOM_MS);
    return fits
      ? { ...gpu, level: fits, reason: `highest preset within ${HEADROOM_MS.toFixed(1)} ms` }
      : { ...gpu, level: 'low', reason: 'no preset fits; using low' };
  }

  const frame = { ...base, basis: 'frame' as const, p90FrameMs: frameP90 };
  const frameP10 = percentile(frames, 0.1);
  const frameP50 = percentile(frames, 0.5);
  // A steady plateau above 60 Hz (30 fps power saving, 50 Hz panels) is a frame-rate cap, not overload:
  // real overload under vsync alternates between refresh intervals and shows jitter.
  if (frameP90 > TARGET_MS * 1.1 && frameP90 - frameP10 < 1) {
    return { ...frame, level: measuredAt, reason: 'frame rate appears capped; keeping the measured preset' };
  }
  if (frameP90 > TARGET_MS * 2) return { ...frame, level: 'low', reason: 'far over budget' };
  if (frameP90 > TARGET_MS * 1.25) {
    return { ...frame, level: stepLevel(measuredAt, -1), reason: 'frames run long' };
  }
  if (frameP90 <= TARGET_MS * 1.05 && frameP50 <= TARGET_MS * 0.6) {
    return { ...frame, level: stepLevel(measuredAt, 1), reason: 'holds a high refresh rate' };
  }
  return { ...frame, level: measuredAt, reason: 'holds 60 Hz; vsync hides any headroom' };
}

/** Preset render scale, re-exported for callers that only need the number. */
export const presetScale = (level: QualityLevel): number => QUALITY_PRESETS[level].renderScale;
