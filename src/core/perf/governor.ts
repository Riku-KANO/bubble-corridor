import type { QualityLevel } from '../quality';
import { DynamicResolution } from './dynamic-resolution';
import {
  fitsFrameBudget,
  fitsHeadroom,
  presetScale,
  type QualityDecision,
  recommendQuality,
  stepLevel,
} from './quality-select';

/**
 * Runtime performance governor: automatic quality selection, its verification, and dynamic resolution.
 * Pure state machine — the app feeds frame times and GPU samples and applies the returned actions.
 *
 *   warmup → measuring → (switching → verifying → [switching once, if it failed]) → steady
 *
 * - Auto quality (技術設計 > 品質プリセット): measure the first `autoWindowSec` at the start preset, switch the whole
 *   preset (the app recreates the scene), then re-measure; if the choice does not fit, step down once.
 * - Verification uses GPU time when it is trustworthy, otherwise frame time (missed vsync with jitter fails).
 * - Dynamic resolution runs only in `steady` and only on trustworthy GPU time, so it never disturbs a
 *   measurement and never acts on frame time, which under vsync cannot tell a cap from overload.
 * - Every action bumps `epoch`; GPU samples requested before it are dropped, and a few frames are skipped after it,
 *   so a stale reading from the old resolution never drives the next decision.
 * - GPU time is the frame span where WebGPU can time it (first pass start → last pass end, perf/gpu-span.ts, S-08),
 *   otherwise three's per-pass sum; which one, and whether it is trusted, is chooseGpuTimeSource's call.
 * - GPU time is only trusted while it is physically plausible. Timestamp sums over many render passes overlap on
 *   some GPUs (Apple/Metal measured ~10× too high in S-05); GPU time above the real (mean) frame time means the
 *   readings are unusable, so the governor stops using them for the rest of the session.
 * - Dynamic resolution stops for the rest of the session, back at the preset scale, when the GPU time it acted on
 *   turned implausible, or when lowering the resolution did not lower it (S-08: under vsync at light load the span did
 *   not follow the pixel count; the GPU clocking down and work outside the GPU are both possible causes).
 *   `dynresStopReason` says which.
 */
export type GovernorAction =
  | { kind: 'scale'; scale: number }
  | { kind: 'quality'; level: QualityLevel; reason: string };

export type GovernorPhase = 'warmup' | 'measuring' | 'switching' | 'verifying' | 'steady';

export interface PerfGovernorOptions {
  level: QualityLevel;
  auto: boolean;
  autoWindowSec: number;
  dynres: boolean;
  /** GPU time will be fed and may drive decisions (see chooseGpuTimeSource in gpu-span.ts). */
  gpuTiming: boolean;
  dynresTargetMs?: number;
  /**
   * Stop dynamic resolution when steps down do not lower the GPU time (default true). ?dynresResponse=0 turns it off
   * for tests that check the wiring by driving the controller to its floor.
   */
  dynresRequireResponse?: boolean;
  /** Test hook (?autoForce): replace the recommendation to exercise the switch and verification path. */
  forceLevel?: QualityLevel;
}

/** Skip shader compiles and first uploads right after a scene appears. */
const WARMUP_SEC = 0.5;
const VERIFY_SEC = 3;
/** Longer frames are tab switches or loading hitches; they are never sampled. */
const GAP_MS = 250;
const MAX_DT_SEC = 0.1;
const SETTLE_FRAMES = 4;
/**
 * GPU readings are implausible when their median exceeds the mean frame time by this factor (+0.5 ms).
 * The mean, not the median: under vsync a GPU-bound frame alternates 16.7 / 33.3 ms and only the mean tracks it.
 */
const IMPLAUSIBLE_FACTOR = 1.1;
const IMPLAUSIBLE_CHECKS = 3;

/** Fixed-size rolling window with an allocation-free median. */
class Rolling {
  private readonly values: Float64Array;
  private readonly scratch: Float64Array;
  private len = 0;
  private idx = 0;
  constructor(size: number) {
    this.values = new Float64Array(size);
    this.scratch = new Float64Array(size);
  }
  get full(): boolean {
    return this.len === this.values.length;
  }
  mean(): number {
    let sum = 0;
    for (let i = 0; i < this.len; i++) sum += this.values[i] ?? 0;
    return this.len ? sum / this.len : 0;
  }
  push(v: number): void {
    this.values[this.idx] = v;
    this.idx = (this.idx + 1) % this.values.length;
    this.len = Math.min(this.len + 1, this.values.length);
  }
  median(): number {
    const n = this.len;
    for (let i = 0; i < n; i++) this.scratch[i] = this.values[i] ?? 0;
    for (let i = 1; i < n; i++) {
      const v = this.scratch[i] ?? 0;
      let j = i - 1;
      while (j >= 0 && (this.scratch[j] ?? 0) > v) {
        this.scratch[j + 1] = this.scratch[j] ?? 0;
        j--;
      }
      this.scratch[j + 1] = v;
    }
    return this.scratch[n >> 1] ?? 0;
  }
}
/**
 * Floor of dynamic resolution. Not in the design doc: chosen so glass edges and text stay readable at 1080p.
 * Revisit with the M1 UI.
 */
export const DYNRES_MIN_FRACTION = 0.6;
export const DYNRES_MIN_SCALE = 0.5;

export class PerfGovernor {
  level: QualityLevel;
  scale: number;
  phase: GovernorPhase;
  decision: QualityDecision | null = null;
  /** null until a switched preset has been verified (or when there is nothing to verify). */
  verified: boolean | null = null;
  epoch = 0;
  /** False when the backend cannot time the GPU, or its readings turned out implausible. */
  gpuReliable: boolean;
  /** Why dynamic resolution stopped during the session (null while it runs, or when it never ran). */
  dynresStopReason: string | null = null;
  private readonly recentFrames = new Rolling(30);
  private readonly recentGpu = new Rolling(8);
  private implausible = 0;
  private phaseTime = 0;
  private frameSamples: number[] = [];
  private gpuSamples: number[] = [];
  private pendingGpu: number | null = null;
  private gpuDt = 0;
  private settle = 0;
  private steppedDown = false;
  private previousLevel: QualityLevel;
  private dynres: DynamicResolution | null;
  /** Dynamic resolution was stopped: go back to the preset scale on the next frame. */
  private restoreScale = false;

  constructor(private readonly opts: PerfGovernorOptions) {
    this.level = opts.level;
    this.previousLevel = opts.level;
    this.scale = presetScale(opts.level);
    this.phase = opts.auto ? 'warmup' : 'steady';
    this.gpuReliable = opts.gpuTiming;
    this.dynres = opts.dynres ? this.makeDynres() : null;
  }

  /** A resolved GPU time, tagged with the epoch that was current when it was requested. */
  gpu(ms: number, epoch: number): void {
    if (!this.gpuReliable || !Number.isFinite(ms) || ms <= 0) return;
    if (epoch !== this.epoch || this.settle > 0) return;
    if (!this.checkPlausible(ms)) return;
    if (this.phase === 'measuring' || (this.phase === 'verifying' && this.phaseTime >= WARMUP_SEC)) {
      this.gpuSamples.push(ms);
    }
    this.pendingGpu = ms;
  }

  /** The app finished recreating the scene for a 'quality' action. */
  sceneReady(): void {
    if (this.phase !== 'switching') return;
    this.phase = this.steppedDown ? 'steady' : 'verifying';
    this.phaseTime = 0;
    this.gpuSamples = [];
    this.frameSamples = [];
    this.settle = SETTLE_FRAMES;
  }

  /** Recreating the scene for a 'quality' action failed: go back to the previous preset and stop adjusting. */
  sceneFailed(): void {
    if (this.phase !== 'switching') return;
    this.level = this.previousLevel;
    this.scale = presetScale(this.level);
    if (this.dynres) this.dynres = this.makeDynres();
    this.verified = false;
    this.enter('steady');
    this.bump();
  }

  frame(dtMs: number): GovernorAction | null {
    if (!Number.isFinite(dtMs) || dtMs <= 0 || dtMs > GAP_MS) return null;
    const dt = Math.min(dtMs / 1000, MAX_DT_SEC);
    this.phaseTime += dt;
    this.recentFrames.push(dtMs);
    if (this.restoreScale) {
      this.restoreScale = false;
      const preset = presetScale(this.level);
      if (this.scale !== preset) {
        this.scale = preset;
        this.bump();
        return { kind: 'scale', scale: preset };
      }
    }
    if (this.settle > 0) {
      this.settle--;
      return null;
    }

    switch (this.phase) {
      case 'warmup':
        if (this.phaseTime >= WARMUP_SEC) this.enter('measuring');
        return null;
      case 'measuring': {
        this.frameSamples.push(dtMs);
        if (this.phaseTime < this.opts.autoWindowSec) return null;
        const gpu = this.gpuReliable ? this.gpuSamples : [];
        const recommended = recommendQuality(this.frameSamples, gpu, this.level);
        const decision = this.opts.forceLevel
          ? { ...recommended, level: this.opts.forceLevel, reason: `forced (${recommended.reason})` }
          : recommended;
        this.decision = decision;
        this.frameSamples = [];
        this.gpuSamples = [];
        if (decision.level !== this.level) return this.switchTo(decision.level, decision.reason);
        this.enter('steady');
        return null;
      }
      case 'switching':
        return null;
      case 'verifying': {
        if (this.phaseTime >= WARMUP_SEC) this.frameSamples.push(dtMs);
        if (this.phaseTime < WARMUP_SEC + VERIFY_SEC) return null;
        const byGpu = this.gpuReliable ? fitsHeadroom(this.gpuSamples) : null;
        const ok = byGpu ?? fitsFrameBudget(this.frameSamples);
        this.verified = ok;
        this.gpuSamples = [];
        this.frameSamples = [];
        if (!ok && this.level !== 'low') {
          this.steppedDown = true;
          return this.switchTo(stepLevel(this.level, -1), 'chosen preset did not fit the headroom');
        }
        this.enter('steady');
        return null;
      }
      case 'steady':
        return this.steady(dt);
    }
  }

  private steady(dt: number): GovernorAction | null {
    if (!this.dynres || !this.gpuReliable) return null;
    this.gpuDt += dt;
    if (this.pendingGpu === null) return null;
    const next = this.dynres.update(this.pendingGpu, this.gpuDt);
    this.pendingGpu = null;
    this.gpuDt = 0;
    if (this.dynres.unresponsive) {
      this.stopDynres(
        'GPU time did not follow the resolution (three steps down lowered it by less than 10%)',
      );
      return null;
    }
    if (next === null) return null;
    this.scale = next;
    this.bump();
    return { kind: 'scale', scale: next };
  }

  /** Records a GPU reading and returns false once readings have proven implausible. */
  private checkPlausible(ms: number): boolean {
    this.recentGpu.push(ms);
    if (!this.recentGpu.full || !this.recentFrames.full) return true;
    if (this.recentGpu.median() > this.recentFrames.mean() * IMPLAUSIBLE_FACTOR + 0.5) {
      if (++this.implausible >= IMPLAUSIBLE_CHECKS) {
        this.gpuReliable = false;
        this.gpuSamples = [];
        this.pendingGpu = null;
        if (this.dynres) this.stopDynres('GPU time turned implausible (above the mean frame time)');
        return false;
      }
    } else {
      this.implausible = 0;
    }
    return true;
  }

  /** Stops dynamic resolution for the session; the next frame() returns to the preset scale if it differs. */
  private stopDynres(reason: string): void {
    this.dynres = null;
    this.dynresStopReason = reason;
    this.restoreScale = true;
  }

  private switchTo(level: QualityLevel, reason: string): GovernorAction {
    this.previousLevel = this.level;
    this.level = level;
    this.scale = presetScale(level);
    if (this.dynres) this.dynres = this.makeDynres();
    this.enter('switching');
    this.bump();
    return { kind: 'quality', level, reason };
  }

  private enter(phase: GovernorPhase): void {
    this.phase = phase;
    this.phaseTime = 0;
  }

  private bump(): void {
    this.epoch++;
    this.settle = SETTLE_FRAMES;
    this.pendingGpu = null;
    this.gpuDt = 0;
  }

  private makeDynres(): DynamicResolution {
    const max = presetScale(this.level);
    const min = Math.max(DYNRES_MIN_SCALE, Math.round(max * DYNRES_MIN_FRACTION * 100) / 100);
    return new DynamicResolution({
      min,
      max,
      targetMs: this.opts.dynresTargetMs,
      requireResponse: this.opts.dynresRequireResponse ?? true,
    });
  }
}
