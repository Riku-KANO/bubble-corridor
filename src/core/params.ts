import { isQualityLevel, type QualityLevel } from './quality';

/**
 * URL switches shared by every scene.
 *   ?scene=<name>       which sandbox scene to load (none = scene list)
 *   ?bench=<seconds>    measure frame times after warm-up, then expose results on window.__vidro
 *   ?warmup=<seconds>   warm-up before measuring (default 1)
 *   ?quality=low|mid|high|auto
 *                       auto = start at mid, measure the first autoWindow seconds, then apply the recommendation.
 *                       With bench, the scene may switch preset during the measurement: bench a fixed preset instead.
 *   ?autoWindow=<s>     length of the auto-quality measurement (default 10, 技術設計 > 品質プリセット)
 *   ?autoFrom=low|mid|high  preset auto quality starts measuring at (default mid)
 *   ?autoForce=low|mid|high test hook: replace the recommendation (the switch and verification still run)
 *   ?dynres=0|1         dynamic resolution (default on, off while benchmarking a fixed preset)
 *   ?dynresTarget=<ms>  override the frame-cost target (test hook)
 *   ?dynresResponse=0   do not stop dynamic resolution when lowering the resolution does not lower the GPU time
 *                       (default: stop, S-08). For tests that check the wiring and drive the controller to its floor
 *   ?gpuTrust=1         let GPU timestamps drive decisions even where they are not trusted (tests, calibration)
 *   ?gpuSpan=0          do not time the GPU frame span (A/B of its cost; GPU time falls back to three's per-pass sum)
 *   ?gpuPasses=0        never enable three's per-pass timestamps (A/B of their cost; the bench then has no pass sum)
 *   ?webgl=1            force the WebGL2 backend (to test the fallback path)
 *   ?stats=1            show the perf overlay
 */
export interface AppParams {
  scene: string | null;
  benchSeconds: number | null;
  warmupSeconds: number;
  /** Preset the scene is created with. 'auto' starts at mid. */
  quality: QualityLevel;
  autoQuality: boolean;
  autoWindowSeconds: number;
  autoForce: QualityLevel | null;
  dynres: boolean;
  dynresTargetMs: number | null;
  /** Stop dynamic resolution when steps down do not lower the GPU time. */
  dynresResponse: boolean;
  gpuTrust: boolean;
  /** Time the GPU frame span where WebGPU can (default true). */
  gpuSpan: boolean;
  /** Allow three's per-pass timestamps (default true; they run only where something reads them). */
  gpuPasses: boolean;
  forceWebGL: boolean;
  stats: boolean;
  raw: URLSearchParams;
}

const SCENE_NAME = /^[a-z0-9-]+$/;

function positive(raw: URLSearchParams, key: string, max: number): number | null {
  if (!raw.has(key)) return null;
  const v = Number(raw.get(key));
  return Number.isFinite(v) && v > 0 ? Math.min(v, max) : null;
}

export function parseParams(search: string): AppParams {
  const raw = new URLSearchParams(search);
  const scene = raw.get('scene');
  const warmup = Number(raw.get('warmup'));
  const quality = raw.get('quality');
  const benchSeconds = positive(raw, 'bench', 120);
  const dynresFlag = raw.get('dynres');
  const autoFrom = raw.get('autoFrom');
  const autoForce = raw.get('autoForce');
  return {
    scene: scene && SCENE_NAME.test(scene) ? scene : null,
    benchSeconds,
    warmupSeconds: Number.isFinite(warmup) && warmup >= 0 && raw.has('warmup') ? Math.min(warmup, 30) : 1,
    quality: isQualityLevel(quality)
      ? quality
      : isQualityLevel(autoFrom) && quality === 'auto'
        ? autoFrom
        : 'mid',
    autoQuality: quality === 'auto',
    autoWindowSeconds: positive(raw, 'autoWindow', 60) ?? 10,
    autoForce: isQualityLevel(autoForce) ? autoForce : null,
    dynres: dynresFlag === null ? benchSeconds === null : dynresFlag === '1',
    dynresTargetMs: positive(raw, 'dynresTarget', 100),
    dynresResponse: raw.get('dynresResponse') !== '0',
    gpuTrust: raw.get('gpuTrust') === '1',
    gpuSpan: raw.get('gpuSpan') !== '0',
    gpuPasses: raw.get('gpuPasses') !== '0',
    forceWebGL: raw.get('webgl') === '1',
    stats: raw.get('stats') === '1',
    raw,
  };
}
