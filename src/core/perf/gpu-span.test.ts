import { describe, expect, it } from 'vitest';
import { chooseGpuTimeSource, GpuSpanTimer, spanMs } from './gpu-span';

/**
 * Minimal stand-in for a GPUDevice: records what reaches the queue, in order, and lets the test decide
 * what the two timestamps read back as and when the readback finishes.
 */
class FakeDevice {
  readonly features = new Set(['timestamp-query']);
  /** One entry per submitted command buffer, in queue order. */
  readonly submitted: string[][] = [];
  /** Values the readback buffer will hold (nanoseconds). */
  timestamps: [bigint, bigint] = [1_000_000n, 3_500_000n];
  failMap = false;
  createdQuerySets = 0;
  createdBuffers = 0;
  destroyed = 0;
  private settle: (() => void) | null = null;
  private fail: ((e: Error) => void) | null = null;

  /** Finishes the outstanding readback (mapAsync). */
  async finishReadback(): Promise<void> {
    if (this.failMap) this.fail?.(new Error('device lost'));
    else this.settle?.();
    this.settle = null;
    this.fail = null;
    await Promise.resolve();
    await Promise.resolve();
  }

  readonly queue = {
    submit: (buffers: Array<{ commands: string[] }>) => {
      for (const b of buffers) this.submitted.push([...b.commands]);
    },
  };

  createQuerySet(desc: { type: string; count: number }) {
    expect(desc.type).toBe('timestamp');
    this.createdQuerySets++;
    return { destroy: () => this.destroyed++ };
  }

  createBuffer(desc: { size: number; usage: number }) {
    this.createdBuffers++;
    const device = this;
    const buffer = {
      size: desc.size,
      mapState: 'unmapped' as 'unmapped' | 'pending' | 'mapped',
      mapAsync() {
        buffer.mapState = 'pending';
        return new Promise<void>((resolve, reject) => {
          device.settle = () => {
            buffer.mapState = 'mapped';
            resolve();
          };
          device.fail = (e) => {
            buffer.mapState = 'unmapped';
            reject(e);
          };
        });
      },
      getMappedRange() {
        const out = new BigUint64Array(2);
        out[0] = device.timestamps[0];
        out[1] = device.timestamps[1];
        return out.buffer;
      },
      unmap() {
        buffer.mapState = 'unmapped';
      },
      destroy: () => this.destroyed++,
    };
    return buffer;
  }

  createShaderModule() {
    return {};
  }

  createComputePipeline() {
    return {};
  }

  /** Marker passes that dispatched nothing (Metal writes no timestamps for those). */
  emptyMarkerPasses = 0;

  createCommandEncoder() {
    const commands: string[] = [];
    const device = this;
    return {
      beginComputePass(desc: {
        timestampWrites?: { beginningOfPassWriteIndex?: number; endOfPassWriteIndex?: number };
      }) {
        const w = desc.timestampWrites;
        if (w?.beginningOfPassWriteIndex !== undefined) commands.push(`begin@${w.beginningOfPassWriteIndex}`);
        if (w?.endOfPassWriteIndex !== undefined) commands.push(`end@${w.endOfPassWriteIndex}`);
        let dispatched = false;
        return {
          setPipeline() {},
          dispatchWorkgroups() {
            dispatched = true;
          },
          end() {
            if (!dispatched) device.emptyMarkerPasses++;
          },
        };
      },
      resolveQuerySet() {
        commands.push('resolve');
      },
      copyBufferToBuffer() {
        commands.push('copy');
      },
      finish: () => ({ commands }),
    };
  }

  /** Stands in for three's own render passes between our two markers. */
  threeRender(): void {
    this.submitted.push(['three']);
  }
}

const makeTimer = (device = new FakeDevice()) => ({
  device,
  timer: new GpuSpanTimer(device as unknown as GPUDevice),
});

describe('spanMs', () => {
  it('converts the distance between the two timestamps to milliseconds', () => {
    expect(spanMs(1_000_000n, 3_500_000n)).toBeCloseTo(2.5);
  });

  it('rejects readings that cannot be a frame (unwritten, reversed, or longer than a second)', () => {
    expect(spanMs(0n, 0n)).toBeNull();
    expect(spanMs(0n, 2_000_000n)).toBeNull();
    expect(spanMs(5_000_000n, 5_000_000n)).toBeNull();
    expect(spanMs(5_000_000n, 4_000_000n)).toBeNull();
    expect(spanMs(1n, 2_000_000_000n)).toBeNull();
  });
});

describe('chooseGpuTimeSource', () => {
  it('prefers the frame span wherever it can be measured, and trusts it on Apple too', () => {
    expect(chooseGpuTimeSource({ span: true, passes: true, apple: true })).toEqual({
      source: 'span',
      trusted: true,
    });
    expect(chooseGpuTimeSource({ span: true, passes: true, apple: false })).toEqual({
      source: 'span',
      trusted: true,
    });
  });

  it('falls back to the per-pass sum, which is not trusted on Apple (overlapping passes, S-05)', () => {
    expect(chooseGpuTimeSource({ span: false, passes: true, apple: true })).toEqual({
      source: 'passes',
      trusted: false,
    });
    expect(chooseGpuTimeSource({ span: false, passes: true, apple: false })).toEqual({
      source: 'passes',
      trusted: true,
    });
  });

  it('reports no GPU time when nothing can be read', () => {
    expect(chooseGpuTimeSource({ span: false, passes: false, apple: false })).toEqual({
      source: 'none',
      trusted: false,
    });
  });
});

describe('GpuSpanTimer', () => {
  it('can only time a device that has timestamp queries', () => {
    expect(GpuSpanTimer.supported(new FakeDevice() as unknown as GPUDevice)).toBe(true);
    const plain = new FakeDevice();
    plain.features.clear();
    expect(GpuSpanTimer.supported(plain as unknown as GPUDevice)).toBe(false);
    expect(GpuSpanTimer.supported(undefined)).toBe(false);
  });

  it('brackets the frame: a begin marker before the frame, the end marker and readback after it', async () => {
    const { device, timer } = makeTimer();
    expect(timer.begin()).toBe(true);
    device.threeRender();
    const result = timer.end();
    expect(device.submitted).toEqual([['begin@0'], ['three'], ['end@1', 'resolve', 'copy']]);
    // Apple/Metal leaves the timestamps of an empty pass at 0, so each marker pass does a token of work.
    expect(device.emptyMarkerPasses).toBe(0);
    await device.finishReadback();
    expect(await result).toBeCloseTo(2.5);
  });

  it('keeps at most one readback in flight', async () => {
    const { device, timer } = makeTimer();
    timer.begin();
    const first = timer.end();
    expect(timer.idle).toBe(false);
    expect(timer.begin()).toBe(false);
    expect(timer.end()).toBeNull();
    expect(device.submitted).toHaveLength(2);
    await device.finishReadback();
    await first;
    expect(timer.idle).toBe(true);
    expect(timer.begin()).toBe(true);
  });

  it('reuses its query set and buffers for every sample', async () => {
    const { device, timer } = makeTimer();
    for (let i = 0; i < 5; i++) {
      timer.begin();
      const r = timer.end();
      await device.finishReadback();
      await r;
    }
    expect(device.createdQuerySets).toBe(1);
    expect(device.createdBuffers).toBe(2);
  });

  it('replaces a frame that was begun but never ended (its render threw)', async () => {
    const { device, timer } = makeTimer();
    timer.begin();
    expect(timer.begin()).toBe(true);
    const r = timer.end();
    await device.finishReadback();
    expect(await r).toBeCloseTo(2.5);
  });

  it('does nothing for an end without a begin', () => {
    const { device, timer } = makeTimer();
    expect(timer.end()).toBeNull();
    expect(device.submitted).toEqual([]);
  });

  it('reports an implausible pair of timestamps as no reading', async () => {
    const { device, timer } = makeTimer();
    device.timestamps = [4_000_000n, 4_000_000n];
    timer.begin();
    const r = timer.end();
    await device.finishReadback();
    expect(await r).toBeNull();
    expect(timer.idle).toBe(true);
  });

  it('drops a reading whose timestamp was not rewritten (it still holds the previous sample)', async () => {
    const { device, timer } = makeTimer();
    const sample = async () => {
      timer.begin();
      const r = timer.end();
      await device.finishReadback();
      return r;
    };
    expect(await sample()).toBeCloseTo(2.5);
    device.timestamps = [1_000_000n, 9_000_000n]; // begin not rewritten
    expect(await sample()).toBeNull();
    device.timestamps = [20_000_000n, 9_000_000n]; // end not rewritten
    expect(await sample()).toBeNull();
    device.timestamps = [30_000_000n, 31_500_000n];
    expect(await sample()).toBeCloseTo(1.5);
  });

  it('recovers from a failed readback (device lost)', async () => {
    const { device, timer } = makeTimer();
    device.failMap = true;
    timer.begin();
    const r = timer.end();
    await device.finishReadback();
    expect(await r).toBeNull();
    expect(timer.idle).toBe(true);
  });

  it('after dispose: frees its GPU objects, drops a late reading and samples no more', async () => {
    const { device, timer } = makeTimer();
    timer.begin();
    const r = timer.end();
    timer.dispose();
    await device.finishReadback();
    expect(await r).toBeNull();
    expect(device.destroyed).toBe(3);
    expect(timer.begin()).toBe(false);
  });
});
