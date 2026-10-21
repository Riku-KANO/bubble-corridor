/**
 * Frame-time statistics used by the bench sensor (?bench=N) and later by
 * automatic quality selection. Pure functions only.
 */
export interface FrameStats {
  frames: number;
  avgMs: number;
  avgFps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const index = Math.min(sorted.length - 1, Math.ceil(clamped * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export function summarizeFrameTimes(frameTimesMs: readonly number[]): FrameStats {
  const valid = frameTimesMs.filter((ms) => Number.isFinite(ms) && ms > 0);
  if (valid.length === 0) {
    return { frames: 0, avgMs: 0, avgFps: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const total = sorted.reduce((sum, ms) => sum + ms, 0);
  const avgMs = total / sorted.length;
  return {
    frames: sorted.length,
    avgMs,
    avgFps: 1000 / avgMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/** Per-frame renderer counters captured alongside frame times. */
export interface RenderCounters {
  drawCalls: number;
  triangles: number;
}

/** Budgets from 技術設計 > 性能の目標と予算. */
export const RENDER_BUDGET = {
  drawCalls: 300,
  triangles: 1_500_000,
  targetFps: 60,
} as const;

export interface BudgetViolation {
  metric: 'drawCalls' | 'triangles';
  value: number;
  limit: number;
}

export function checkBudget(counters: RenderCounters): BudgetViolation[] {
  const out: BudgetViolation[] = [];
  if (counters.drawCalls > RENDER_BUDGET.drawCalls) {
    out.push({ metric: 'drawCalls', value: counters.drawCalls, limit: RENDER_BUDGET.drawCalls });
  }
  if (counters.triangles > RENDER_BUDGET.triangles) {
    out.push({ metric: 'triangles', value: counters.triangles, limit: RENDER_BUDGET.triangles });
  }
  return out;
}

/** GPU time statistics (timestamp queries). One sample per resolved reading, not per frame. */
export interface GpuStats {
  samples: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function summarizeGpuTimes(gpuMs: readonly number[]): GpuStats | null {
  const s = summarizeFrameTimes(gpuMs);
  if (s.frames === 0) return null;
  return {
    samples: s.frames,
    avgMs: s.avgMs,
    p50Ms: s.p50Ms,
    p95Ms: s.p95Ms,
    p99Ms: s.p99Ms,
    maxMs: s.maxMs,
  };
}
