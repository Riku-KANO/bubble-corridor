/**
 * Faster-than-real-time rendering with OfflineAudioContext, through the same synth and reverb code
 * the live engine uses. For sensors (render → measure pitch / level / decay) and, later, for baking
 * sounds into buffers. Needs no user gesture.
 */

export interface OfflineOptions {
  /** Seconds to render. */
  duration: number;
  sampleRate?: number;
  channels?: number;
}

/**
 * Graphs kept reachable while they render. Chrome may tear down nodes that JS no longer references
 * once their sources have finished (seen with a ConvolverNode fed by a one-sample impulse: after a GC
 * the reverb tail was cut). Holding the graph until rendering ends keeps every tail intact.
 */
const rendering = new Set<unknown>();

/**
 * Render whatever `build` connects to `destination`. `build` may be async (e.g. to create an
 * AudioEngine on the offline context). Return from it anything that must live until the end
 * (e.g. a RoomReverb or the engine); it stays referenced while rendering.
 */
export async function renderOffline(
  opts: OfflineOptions,
  build: (ctx: OfflineAudioContext, destination: AudioNode) => unknown,
): Promise<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? 44100;
  const ctx = new OfflineAudioContext(opts.channels ?? 1, Math.ceil(opts.duration * sampleRate), sampleRate);
  const graph = { ctx, nodes: await build(ctx, ctx.destination) };
  rendering.add(graph);
  try {
    return await ctx.startRendering();
  } finally {
    rendering.delete(graph);
  }
}

/** Average all channels into one. */
export function mixdown(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++)
      out[i] = (out[i] as number) + (d[i] as number) / buffer.numberOfChannels;
  }
  return out;
}
