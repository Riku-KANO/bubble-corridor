import { describe, expect, it } from 'vitest';
import { type GovernorAction, PerfGovernor, type PerfGovernorOptions } from './governor';

const FRAME = 1000 / 60;

/**
 * Drives the governor like the app does: one frame() per frame, a GPU sample every 4th frame
 * (tagged with the epoch at request time), sceneReady() a few frames after a quality switch.
 */
function simulate(
  g: PerfGovernor,
  seconds: number,
  gpuMs: ((level: string, scale: number) => number) | null,
  frameMs: number | ((i: number, level: string) => number) = FRAME,
): GovernorAction[] {
  const actions: GovernorAction[] = [];
  let switchingFrames = -1;
  let elapsed = 0;
  for (let i = 0; elapsed < seconds * 1000; i++) {
    const ms = typeof frameMs === 'number' ? frameMs : frameMs(i, g.level);
    elapsed += ms;
    if (gpuMs && i % 4 === 0) g.gpu(gpuMs(g.level, g.scale), g.epoch);
    const a = g.frame(ms);
    if (a) {
      actions.push(a);
      if (a.kind === 'quality') switchingFrames = 5;
    }
    if (switchingFrames > 0 && --switchingFrames === 0) g.sceneReady();
  }
  return actions;
}

const opts = (o: Partial<PerfGovernorOptions> = {}): PerfGovernorOptions => ({
  level: 'mid',
  auto: false,
  autoWindowSec: 10,
  dynres: false,
  gpuTiming: true,
  ...o,
});

describe('PerfGovernor', () => {
  it('does nothing with a fixed preset and dynamic resolution off', () => {
    const g = new PerfGovernor(opts());
    expect(simulate(g, 20, () => 30)).toEqual([]);
    expect(g.scale).toBe(0.85);
  });

  it('auto: measures, switches to the recommended preset, verifies it, then stays', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    const cost = { low: 4, mid: 5, high: 8.5 } as Record<string, number>;
    const actions = simulate(g, 20, (level) => cost[level] ?? 5);
    expect(actions).toEqual([{ kind: 'quality', level: 'high', reason: expect.any(String) }]);
    expect(g.level).toBe('high');
    expect(g.scale).toBe(1);
    expect(g.verified).toBe(true);
    expect(g.phase).toBe('steady');
  });

  it('auto: steps down once when the chosen preset fails verification', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    // mid measures cheap, but high is far heavier than the model predicts.
    const cost = { low: 4, mid: 5, high: 15 } as Record<string, number>;
    const actions = simulate(g, 30, (level) => cost[level] ?? 5);
    expect(actions.map((a) => (a.kind === 'quality' ? a.level : a.kind))).toEqual(['high', 'mid']);
    expect(g.level).toBe('mid');
    expect(g.verified).toBe(false);
  });

  it('auto without GPU timing keeps mid on a 60 Hz display and does not switch', () => {
    const g = new PerfGovernor(opts({ auto: true, gpuTiming: false }));
    expect(simulate(g, 15, null)).toEqual([]);
    expect(g.decision?.level).toBe('mid');
    expect(g.phase).toBe('steady');
  });

  it('does not adjust resolution while auto quality is measuring', () => {
    const g = new PerfGovernor(opts({ auto: true, dynres: true, autoWindowSec: 5 }));
    expect(simulate(g, 4, () => 40)).toEqual([]);
  });

  it('dynamic resolution lowers the scale under GPU overload', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    const actions = simulate(g, 5, () => 30, 33.3);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.kind === 'scale')).toBe(true);
    expect(g.scale).toBeLessThan(0.85);
  });

  it('drops GPU samples requested before a scale change', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulate(g, 1.2, () => 30, 33.3); // first step down after the cooldown
    const scaleAfter = g.scale;
    const staleEpoch = g.epoch - 1;
    for (let i = 0; i < 30; i++) g.gpu(1000, staleEpoch);
    simulate(g, 0.2, null);
    expect(g.scale).toBe(scaleAfter);
  });

  it('ignores a long gap such as returning to a background tab', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulate(g, 2, () => 5);
    expect(g.frame(5000)).toBeNull();
    expect(simulate(g, 0.5, () => 5)).toEqual([]);
  });

  it('keeps dynamic resolution between its floor and the preset scale', () => {
    const g = new PerfGovernor(opts({ dynres: true, level: 'low' }));
    simulate(g, 60, () => 90, 100);
    expect(g.scale).toBeGreaterThanOrEqual(0.5);
    expect(g.scale).toBeLessThanOrEqual(0.67);
  });

  it('stops trusting GPU timestamps that exceed the real frame time (per-pass sums overlap on some GPUs)', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    // Holding 60 fps while the timestamp sum claims 20 ms: physically impossible, so ignore GPU time.
    simulate(g, 12, () => 20);
    expect(g.gpuReliable).toBe(false);
    expect(g.decision?.basis).toBe('frame');
    expect(g.decision?.level).toBe('mid');
  });

  it('keeps trusting GPU time that fits inside the frame', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    simulate(g, 12, () => 6);
    expect(g.gpuReliable).toBe(true);
    expect(g.decision?.basis).toBe('gpu');
  });

  it('turns dynamic resolution off when GPU time is implausible (frame time alone cannot tell a cap from overload)', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    expect(simulate(g, 10, () => 30)).toEqual([]);
    expect(g.gpuReliable).toBe(false);
  });

  it('keeps trusting real GPU overload under vsync, where frames alternate 16.7 / 33.3 ms', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    // GPU 22 ms: two refresh intervals for most frames, one for some; the mean matches the GPU time.
    const quantized = (i: number) => (i % 3 === 0 ? FRAME : FRAME * 2);
    simulate(g, 10, () => 22, quantized);
    expect(g.gpuReliable).toBe(true);
    expect(g.scale).toBeLessThan(0.85);
  });

  it('distrusts GPU readings well above a steady 60 Hz frame', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulate(g, 5, () => 24);
    expect(g.gpuReliable).toBe(false);
  });

  it('auto: verifies an upgrade with frame time when GPU readings become implausible', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    // mid measures cheap; on high the GPU readings jump (implausible) and frames start missing vsync.
    const gpu = (level: string) => (level === 'high' ? 40 : 5);
    const frames = (i: number, level: string) => (level === 'high' && i % 2 === 0 ? FRAME * 2 : FRAME);
    const actions = simulate(g, 30, gpu, frames);
    expect(actions.map((a) => (a.kind === 'quality' ? a.level : a.kind))).toEqual(['high', 'mid']);
    expect(g.verified).toBe(false);
  });

  it('auto without GPU timing: verifies an upgrade with frame time and steps down when frames miss', () => {
    const g = new PerfGovernor(opts({ auto: true, gpuTiming: false }));
    // 120 Hz display at mid suggests an upgrade; at high, frames start missing.
    const frames = (i: number, level: string) => (level === 'high' ? (i % 2 === 0 ? 25 : 12) : 8.3);
    const actions = simulate(g, 30, null, frames);
    expect(actions.map((a) => (a.kind === 'quality' ? a.level : a.kind))).toEqual(['high', 'mid']);
    expect(g.verified).toBe(false);
  });

  it('restores the previous preset when recreating the scene fails', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    let action: GovernorAction | null = null;
    for (let i = 0; i < 60 * 12 && !action; i++) {
      if (i % 4 === 0) g.gpu(5, g.epoch);
      action = g.frame(FRAME);
    }
    expect(action).toMatchObject({ kind: 'quality', level: 'high' });
    g.sceneFailed();
    expect(g.level).toBe('mid');
    expect(g.scale).toBe(0.85);
    expect(g.phase).toBe('steady');
    expect(g.verified).toBe(false);
  });

  it('a forced level replaces the recommendation but is still verified', () => {
    const g = new PerfGovernor(opts({ auto: true, gpuTiming: false, forceLevel: 'high' }));
    const actions = simulate(g, 20, null);
    expect(actions).toEqual([{ kind: 'quality', level: 'high', reason: expect.stringMatching(/^forced/) }]);
    expect(g.verified).toBe(true);
  });
});
