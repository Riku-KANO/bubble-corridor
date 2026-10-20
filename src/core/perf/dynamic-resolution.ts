/**
 * Dynamic resolution (技術設計 > 品質プリセット: プレイ中も負荷に応じて描画解像度を動的に調整).
 * Pure controller driven by GPU time: feed one sample at a time, apply the returned scale when it changes.
 *
 * - A median of the last 5 samples, then an EMA: one or two hitches never move the resolution.
 * - Down above 80% of the frame (the headroom quality selection uses), up below 60%: the band is wider than
 *   the cost of one step (≤ ×1.21), so a fitting scale is not left again.
 * - A cooldown between changes (also the start-up warm-up), because every change reallocates render targets.
 * - Raising right before having to lower again doubles the wait before the next raise; a calm period resets it.
 *
 * Frame time is deliberately not supported: under vsync it cannot tell a frame-rate cap from overload and hides
 * moderate overload completely (S-05 review). Without trustworthy GPU time the governor keeps the preset scale.
 */
export interface DynamicResolutionOptions {
  min: number;
  max: number;
  step?: number;
  targetMs?: number;
  cooldownSec?: number;
  emaAlpha?: number;
}

const DOWN = 0.8;
const UP = 0.6;
const UP_DELAY_SEC = 2;
const SPIKE_CLAMP = 4;
const MEDIAN_WINDOW = 5;
/** A down this soon after an up means the up was premature. */
const PREMATURE_UP_SEC = 3;
const MAX_UP_BACKOFF = 32;
/** This long without a change resets the backoff, so one heavy room does not slow later reactions. */
const CALM_RESET_SEC = 30;

const round2 = (v: number) => Math.round(v * 100) / 100;

export class DynamicResolution {
  scale: number;
  private readonly min: number;
  private readonly max: number;
  private readonly step: number;
  private readonly targetMs: number;
  private readonly cooldownSec: number;
  private readonly alpha: number;
  private readonly window = new Float64Array(MEDIAN_WINDOW);
  private readonly scratch = new Float64Array(MEDIAN_WINDOW);
  private windowLen = 0;
  private windowIdx = 0;
  private ema: number | null = null;
  private time = 0;
  private sinceChange = 0;
  private comfortableFor = 0;
  private upBackoff = 1;
  private lastUpAt = Number.NEGATIVE_INFINITY;

  constructor(opts: DynamicResolutionOptions) {
    this.min = opts.min;
    this.max = opts.max;
    this.step = opts.step ?? 0.05;
    this.targetMs = opts.targetMs ?? 1000 / 60;
    this.cooldownSec = opts.cooldownSec ?? 1;
    this.alpha = opts.emaAlpha ?? 0.08;
    this.scale = opts.max;
  }

  /** Smoothed GPU time in ms, for display. */
  get smoothedMs(): number {
    return this.ema ?? 0;
  }

  /**
   * @param gpuMs GPU time of the latest sample.
   * @param dt seconds since the previous call.
   * @returns the new scale when it changed, otherwise null.
   */
  update(gpuMs: number, dt: number): number | null {
    if (!Number.isFinite(gpuMs) || gpuMs <= 0) return null;
    this.time += dt;
    this.sinceChange += dt;
    if (this.sinceChange >= CALM_RESET_SEC) this.upBackoff = 1;

    this.push(Math.min(gpuMs, this.targetMs * SPIKE_CLAMP));
    const median = this.median();
    this.ema = this.ema === null ? median : this.ema + this.alpha * (median - this.ema);

    if (this.ema > this.targetMs * DOWN) {
      this.comfortableFor = 0;
      if (this.sinceChange < this.cooldownSec || this.scale <= this.min) return null;
      if (this.time - this.lastUpAt < PREMATURE_UP_SEC) {
        this.upBackoff = Math.min(this.upBackoff * 2, MAX_UP_BACKOFF);
      }
      return this.set(Math.max(this.min, round2(this.scale - this.step)));
    }
    if (this.ema < this.targetMs * UP) {
      this.comfortableFor += dt;
      if (
        this.comfortableFor >= UP_DELAY_SEC * this.upBackoff &&
        this.sinceChange >= this.cooldownSec &&
        this.scale < this.max
      ) {
        this.comfortableFor = 0;
        this.lastUpAt = this.time;
        return this.set(Math.min(this.max, round2(this.scale + this.step)));
      }
      return null;
    }
    this.comfortableFor = 0;
    return null;
  }

  private set(scale: number): number {
    this.scale = scale;
    this.sinceChange = 0;
    return scale;
  }

  private push(v: number): void {
    this.window[this.windowIdx] = v;
    this.windowIdx = (this.windowIdx + 1) % MEDIAN_WINDOW;
    this.windowLen = Math.min(this.windowLen + 1, MEDIAN_WINDOW);
  }

  private median(): number {
    const n = this.windowLen;
    for (let i = 0; i < n; i++) this.scratch[i] = this.window[i] ?? 0;
    // Insertion sort on ≤ 5 values: no allocation in the frame loop.
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
