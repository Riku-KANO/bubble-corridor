/**
 * Live playback helpers: design a voice with the game's tuning (and a fresh random seed, so every
 * strike differs a little) and start it through the engine (admission, voice stealing) on an
 * emitter (3D) or a bus.
 */
import type { AudioEngine, Emitter } from './engine';
import {
  designGlassVoice,
  type GlassStrength,
  type GlassTuning,
  type GlassVoice,
  scheduleGlassVoice,
} from './glass';
import type { BusName } from './mix';
import { designPops, type PopPattern, type PopScore, type PopTuning, schedulePops } from './pop';
import { mulberry32, randomSeed } from './rng';

export interface PlayOptions {
  /** Positioned source; otherwise the sound goes straight to `bus`. */
  emitter?: Emitter;
  bus?: BusName;
  /** Fix the randomness (tests); default is a new seed per call. */
  seed?: number;
}

export interface GlassStrike {
  /** Fundamental in Hz (the game picks it, e.g. from its size→pitch rule). */
  hz: number;
  /** Characteristic size in metres (decides the ring time). */
  size: number;
  strength: GlassStrength;
}

/** Strike a glass now. Returns the voice, or null if the engine refused it (audio not running). */
export function playGlass(
  engine: AudioEngine,
  strike: GlassStrike,
  opts: PlayOptions & { tuning: GlassTuning },
): GlassVoice | null {
  const voice = designGlassVoice(
    { hz: strike.hz, size: strike.size, strength: strike.strength, sampleRate: engine.ctx.sampleRate },
    mulberry32(opts.seed ?? randomSeed()),
    opts.tuning,
  );
  const started = engine.startVoice(
    { level: voice.level, emitter: opts.emitter, bus: opts.bus },
    (ctx, destination, when) => scheduleGlassVoice(ctx, destination, voice, when),
  );
  return started ? voice : null;
}

/** Play a pattern of thin-glass pops now. Returns the score, or null if the engine refused it. */
export function playPops(
  engine: AudioEngine,
  pattern: PopPattern,
  opts: PlayOptions & { tuning: PopTuning },
): PopScore | null {
  const score = designPops(pattern, mulberry32(opts.seed ?? randomSeed()), opts.tuning);
  const level = Math.max(0, ...score.pops.map((p) => p.gain));
  const started = engine.startVoice(
    { level, emitter: opts.emitter, bus: opts.bus },
    (ctx, destination, when) => schedulePops(ctx, destination, score, when),
  );
  return started ? score : null;
}
