/**
 * GPU frame span: the time from the start of the first pass of a frame to the end of its last pass, read from
 * our own two timestamps on the WebGPU queue (技術設計 > 品質プリセット: dynamic resolution needs a real GPU time).
 *
 * three's `resolveTimestampsAsync('render')` sums the duration of every render pass. On Apple/Metal the passes
 * overlap (tile-based GPU, timestamps at stage boundaries), so ~20 post-processing passes summed to 9–23 ms for a
 * frame whose real cost was 1.15 ms (S-05). The span does not add up overlapping passes: it is one interval between
 * two timestamps (what that interval covers is discussed below).
 *
 *   begin(): a tiny compute pass that writes timestamp 0 at its start, submitted before the frame's first pass
 *   end():   a tiny compute pass that writes timestamp 1 at its end, then resolve → copy → map, after the last pass
 *
 * Each marker pass dispatches one workgroup of an empty shader: Metal writes no timestamps for a pass without
 * work (they read back as 0, measured in S-08).
 *
 * What the two timestamps bracket is not guaranteed. The queue is submitted in order, but a GPU may run work
 * without a dependency on earlier work concurrently with it, so our markers carry no dependency on three's passes,
 * and when a timestamp is written within its pass is up to the implementation (Metal samples at stage boundaries).
 * The begin marker may fire while the previous frame still runs and the end marker before the last pass is done.
 * On top of the frame's own work the span also includes gaps where the GPU waited for the next submit and any other
 * GPU work interleaved in between (the compositor, other apps), and it stretches while the GPU clocks down.
 * So the span is an empirical measure, validated where it is used (S-08, Apple M5 Pro, vsync off, quiet machine):
 * - stress scene: within 7% of the real frame time at every preset and at 1× and 2× pixel density;
 * - a near-empty scene at thousands of fps: 2–5× the frame interval. Hypothesis: consecutive frames overlap on the
 *   GPU, so the span reads one frame's latency, which is longer than the interval between frames.
 * Under vsync the governor's plausibility check (GPU time above the mean frame time) stops trusting readings that
 * exceed the frame, and dynamic resolution stops when lowering the resolution does not lower the span.
 *
 * One readback at a time, and every GPU object is created once: sampling costs two tiny command buffers.
 * WebGL2 has no equivalent: timer queries cannot nest, and three already holds one around every pass.
 */
export type GpuTimeSource = 'span' | 'passes' | 'none';

export interface GpuTimingCaps {
  /** The frame span can be measured (WebGPU device with timestamp-query). */
  span: boolean;
  /** three's per-pass timestamp sum is available (WebGPU, or WebGL2 with EXT_disjoint_timer_query_webgl2). */
  passes: boolean;
  /** Apple/Metal GPU: per-pass sums overlap there and read ~10× too high (S-05). */
  apple: boolean;
}

export interface GpuTimeChoice {
  source: GpuTimeSource;
  /** Whether readings may drive decisions (quality selection, dynamic resolution). */
  trusted: boolean;
}

/**
 * Which GPU time drives the governor: the span wherever it exists, Apple included (checked against the uncapped
 * frame time on Apple hardware in S-08), and on other GPUs too so that every WebGPU path measures the same way
 * (to be checked on the recommended non-Apple hardware in S-07); otherwise the per-pass sum, except on Apple.
 */
export function chooseGpuTimeSource(caps: GpuTimingCaps): GpuTimeChoice {
  if (caps.span) return { source: 'span', trusted: true };
  if (caps.passes) return { source: 'passes', trusted: !caps.apple };
  return { source: 'none', trusted: false };
}

/** Longer than this is not a frame (a wrapped or reset counter). */
const MAX_SPAN_NS = 1_000_000_000n;

/** Span in ms between two raw timestamps (ns), or null when the pair cannot describe a frame. */
export function spanMs(begin: bigint, end: bigint): number | null {
  if (begin === 0n || end <= begin) return null;
  const ns = end - begin;
  if (ns > MAX_SPAN_NS) return null;
  return Number(ns) / 1e6;
}

// WebGPU usage flags (the global GPUBufferUsage / GPUMapMode objects are not in TypeScript's DOM types).
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_QUERY_RESOLVE = 0x0200;
const MAP_READ = 0x0001;
const BYTES = 16;
const NOOP_SHADER = '@compute @workgroup_size(1) fn main() {}';

type SpanState = 'idle' | 'open' | 'pending' | 'disposed';

export class GpuSpanTimer {
  /** Whether a frame span can be timed on this device. */
  static supported(device: GPUDevice | null | undefined): device is GPUDevice {
    return !!device && device.features.has('timestamp-query');
  }

  private state: SpanState = 'idle';
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly readBuffer: GPUBuffer;
  private readonly beginPass: GPUComputePassDescriptor;
  private readonly endPass: GPUComputePassDescriptor;
  private readonly pipeline: GPUComputePipeline;
  private readonly commands: GPUCommandBuffer[] = [];
  /** Previous raw readings: a query the GPU skipped still holds them. */
  private lastBegin = 0n;
  private lastEnd = 0n;

  constructor(private readonly device: GPUDevice) {
    this.querySet = device.createQuerySet({ label: 'vidro_frame_span', type: 'timestamp', count: 2 });
    this.resolveBuffer = device.createBuffer({
      label: 'vidro_frame_span_resolve',
      size: BYTES,
      usage: BUFFER_QUERY_RESOLVE | BUFFER_COPY_SRC,
    });
    this.readBuffer = device.createBuffer({
      label: 'vidro_frame_span_read',
      size: BYTES,
      usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
    });
    this.beginPass = {
      label: 'vidro_frame_span_begin',
      timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0 },
    };
    this.endPass = {
      label: 'vidro_frame_span_end',
      timestampWrites: { querySet: this.querySet, endOfPassWriteIndex: 1 },
    };
    this.pipeline = device.createComputePipeline({
      label: 'vidro_frame_span_marker',
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: NOOP_SHADER }), entryPoint: 'main' },
    });
  }

  /** True when no readback is outstanding. */
  get idle(): boolean {
    return this.state === 'idle' || this.state === 'open';
  }

  /**
   * Call right before the frame's first GPU submit. Returns false (and does nothing) while a reading is pending.
   * A frame that was begun but never ended (its render threw) is simply replaced.
   */
  begin(): boolean {
    if (this.state !== 'idle' && this.state !== 'open') return false;
    const encoder = this.device.createCommandEncoder();
    this.marker(encoder, this.beginPass);
    this.submit(encoder.finish());
    this.state = 'open';
    return true;
  }

  /**
   * Call right after the frame's last GPU submit. Resolves to the span in ms, or null when the reading failed,
   * is implausible, or repeats a timestamp of the previous sample. Returns null immediately when no frame was begun.
   */
  end(): Promise<number | null> | null {
    if (this.state !== 'open') return null;
    const encoder = this.device.createCommandEncoder();
    this.marker(encoder, this.endPass);
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, BYTES);
    this.submit(encoder.finish());
    this.state = 'pending';
    return this.read();
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    // Destroying a buffer with a pending map aborts the map; read() then reports null.
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readBuffer.destroy();
  }

  private async read(): Promise<number | null> {
    try {
      await this.readBuffer.mapAsync(MAP_READ, 0, BYTES);
    } catch {
      if (this.state === 'pending') this.state = 'idle';
      return null;
    }
    if (this.state !== 'pending') return null;
    const times = new BigUint64Array(this.readBuffer.getMappedRange(0, BYTES));
    const begin = times[0] ?? 0n;
    const end = times[1] ?? 0n;
    this.readBuffer.unmap();
    const fresh = begin !== this.lastBegin && end !== this.lastEnd;
    this.lastBegin = begin;
    this.lastEnd = end;
    const ms = fresh ? spanMs(begin, end) : null;
    this.state = 'idle';
    return ms;
  }

  private marker(encoder: GPUCommandEncoder, descriptor: GPUComputePassDescriptor): void {
    const pass = encoder.beginComputePass(descriptor);
    pass.setPipeline(this.pipeline);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  private submit(buffer: GPUCommandBuffer): void {
    this.commands[0] = buffer;
    this.device.queue.submit(this.commands);
    this.commands.length = 0;
  }
}
