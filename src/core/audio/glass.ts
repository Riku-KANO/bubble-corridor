/**
 * Synthesized glass sounds (modal synthesis): a struck glass shell rings as a few sine "modes"
 * whose frequencies are NOT integer multiples of the fundamental — that inharmonicity is what makes
 * it sound like glass rather than a string or a flute.
 * Design doc: サウンドデザイン > ガラスの音 — three strengths (touch / tap / hit) × size.
 * Core holds the mechanism (thin-shell mode ratios, envelopes, scheduling); every value that shapes
 * the sound (levels, ring times, jitter) comes in as a GlassTuning from the game.
 *
 * designGlassVoice() is pure (testable); scheduleGlassVoice() turns a voice into Web Audio nodes
 * on any BaseAudioContext (live or OfflineAudioContext), so tests render exactly what players hear.
 */
import { jitter, type Rng } from './rng';
import type { ScheduledVoice } from './voices';

export type GlassStrength = 'touch' | 'tap' | 'hit';
export const GLASS_STRENGTHS: readonly GlassStrength[] = ['touch', 'tap', 'hit'];

/** Rayleigh's thin-shell bending modes (bells, wine glasses): f_n ∝ n(n²−1)/√(n²+1). */
function shellMode(n: number): number {
  return (n * (n * n - 1)) / Math.sqrt(n * n + 1);
}

/** Mode frequency ratios for n = 2…5, relative to the fundamental: 1 : 2.83 : 5.42 : 8.77. */
export const GLASS_MODE_RATIOS: readonly number[] = [2, 3, 4, 5].map((n) => shellMode(n) / shellMode(2));

/** How one strength of strike sounds. */
export interface GlassStrengthProfile {
  /** Peak level of the whole voice (all partials in phase). */
  level: number;
  /** Relative gain of mode k is brightness^k: harder strikes excite higher modes. */
  brightness: number;
  /** Attack time in seconds: a finger swells in, a hard object clicks. */
  attack: number;
  /** Level of the noisy strike transient (0 = none). */
  strike: number;
  strikeDuration: number;
  /** Ring-time multiplier (e.g. a touching finger damps the glass). */
  ring: number;
}

/**
 * Everything that shapes a glass sound, supplied by the game (core holds only the mechanism).
 * Through the Vidro: src/audio/glass-tuning.ts.
 */
export interface GlassTuning {
  strengths: Readonly<Record<GlassStrength, GlassStrengthProfile>>;
  /** Fundamental T60 = t60 × (size / refSize)^exponent, clamped to [min, max] seconds. */
  ring: { refSize: number; t60: number; exponent: number; min: number; max: number };
  /** Higher modes ring shorter: T60_k = T60 / ratio_k^modeDamping. */
  modeDamping: number;
  /** Strike transient: band-pass noise centred at fundamental × centerRatio (at least minHz). */
  strike: { centerRatio: number; q: number; minHz: number };
  /** Per-strike randomness ("揺らぎ"), so repeated strikes never sound mechanical. */
  jitter: {
    /** Relative fundamental detune (± fraction). */
    detune: number;
    /** Relative spread of overtone ratios (glass imperfections). */
    modeRatio: number;
    modeGain: number;
    t60: number;
    levelDb: number;
    /** Real glass modes come in near-degenerate pairs: the fundamental's partner sits this much higher… */
    splitMin: number;
    splitMax: number;
    /** …at this relative gain, making a slow shimmer (beats). */
    splitGain: number;
    /** Relative spread of the strike noise centre. */
    strikeHz: number;
  };
}

export interface GlassVoiceParams {
  /** Fundamental in Hz (the game keeps it on its scale). */
  hz: number;
  /** Characteristic size in metres; bigger glass rings longer. */
  size: number;
  strength: GlassStrength;
  /** Partials above 0.45 × sampleRate are dropped. Default 48000. */
  sampleRate?: number;
}

export interface GlassPartial {
  hz: number;
  /** Absolute peak gain of this partial. */
  gain: number;
  /** Seconds to decay by 60 dB. */
  t60: number;
}

export interface GlassVoice {
  /** Actual (jittered) fundamental. */
  hz: number;
  strength: GlassStrength;
  level: number;
  attack: number;
  /** partials[0] is the fundamental. */
  partials: GlassPartial[];
  /** Noisy strike transient; `offset` picks where to read the shared noise buffer. */
  strike: { gain: number; hz: number; q: number; duration: number; offset: number } | null;
  /** Seconds from start until the voice is silent (-60 dB). */
  duration: number;
}

export function designGlassVoice(params: GlassVoiceParams, rng: Rng, tuning: GlassTuning): GlassVoice {
  const profile = tuning.strengths[params.strength];
  const j = tuning.jitter;
  const { ring } = tuning;
  const nyquistSafe = (params.sampleRate ?? 48000) * 0.45;
  const hz = params.hz * (1 + jitter(rng, j.detune));
  const level = profile.level * 10 ** (jitter(rng, j.levelDb) / 20);
  const base = Math.min(
    ring.max,
    Math.max(ring.min, ring.t60 * (Math.max(params.size, 1e-6) / ring.refSize) ** ring.exponent),
  );
  const t60 = base * profile.ring * (1 + jitter(rng, j.t60));

  const raw: GlassPartial[] = [];
  GLASS_MODE_RATIOS.forEach((ratio, k) => {
    const modeHz = k === 0 ? hz : hz * ratio * (1 + jitter(rng, j.modeRatio));
    const rel = k === 0 ? 1 : profile.brightness ** k * (1 + jitter(rng, j.modeGain));
    const modeT60 = k === 0 ? t60 : (t60 / ratio ** tuning.modeDamping) * (1 + jitter(rng, j.t60));
    raw.push({ hz: modeHz, gain: rel, t60: modeT60 });
    if (k === 0) {
      const split = j.splitMin + rng() * (j.splitMax - j.splitMin);
      raw.push({ hz: hz * (1 + split), gain: j.splitGain, t60: t60 * (1 + jitter(rng, j.t60)) });
    }
  });
  const audible = raw.filter((p) => p.hz < nyquistSafe);
  const sum = audible.reduce((s, p) => s + p.gain, 0);
  const partials = audible.map((p) => ({ ...p, gain: (p.gain / sum) * level }));

  const centre = hz * tuning.strike.centerRatio * (1 + jitter(rng, j.strikeHz));
  const strike =
    profile.strike > 0
      ? {
          gain: profile.strike,
          hz: Math.min(nyquistSafe * 0.9, Math.max(tuning.strike.minHz, centre)),
          q: tuning.strike.q,
          duration: profile.strikeDuration,
          offset: rng() * 0.15,
        }
      : null;
  const longest = Math.max(...partials.map((p) => p.t60));
  return {
    hz,
    strength: params.strength,
    level,
    attack: profile.attack,
    partials,
    strike,
    duration: profile.attack + longest,
  };
}

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Shared 0.25 s white-noise buffer per context (strike transients, clicks). */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.25), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 0x9e3779b9;
    for (let i = 0; i < d.length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
    }
    noiseCache.set(ctx, buf);
  }
  return buf;
}

/** Natural log of 1000: an exponential decays by 60 dB after t60 = tau × LN1000. */
export const LN1000 = Math.log(1000);

/** A source node and the time it is planned to stop. */
export interface PlannedSource {
  node: AudioScheduledSourceNode;
  stop: number;
}

/** Time constant of the fade used to cut a voice short (≈ -60 dB after 20 ms). */
export const CUT_TAU = 0.003;

/**
 * Cut a voice short without a click: glide from whatever the gain is at `at` towards zero
 * (setTargetAtTime is continuous, so there is no step), then stop the sources still planned to play.
 * Pass a time slightly in the future (AudioEngine.now()), never a time the renderer may have passed.
 */
export function fadeAndStop(out: GainNode, sources: readonly PlannedSource[], at: number): void {
  out.gain.cancelScheduledValues(at);
  out.gain.setTargetAtTime(0, at, CUT_TAU);
  const stop = at + CUT_TAU * 10;
  for (const s of sources) if (s.stop > stop) s.node.stop(stop);
}

/** Build the voice as Web Audio nodes into `destination`, starting at `when`. */
export function scheduleGlassVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  voice: GlassVoice,
  when: number,
): ScheduledVoice {
  const out = ctx.createGain();
  out.connect(destination);
  const sources: PlannedSource[] = [];
  let last: OscillatorNode | null = null;
  let lastEnd = 0;
  for (const p of voice.partials) {
    const osc = ctx.createOscillator();
    osc.frequency.value = p.hz;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(p.gain, when + voice.attack);
    env.gain.setTargetAtTime(0, when + voice.attack, p.t60 / LN1000);
    osc.connect(env).connect(out);
    const stop = when + voice.attack + p.t60;
    osc.start(when);
    osc.stop(stop);
    sources.push({ node: osc, stop });
    if (stop > lastEnd) {
      lastEnd = stop;
      last = osc;
    }
  }
  if (voice.strike) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = voice.strike.hz;
    band.Q.value = voice.strike.q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(voice.strike.gain, when);
    env.gain.setTargetAtTime(0, when, voice.strike.duration / 3);
    src.connect(band).connect(env).connect(out);
    const stop = when + voice.strike.duration * 4;
    src.start(when, voice.strike.offset);
    src.stop(stop);
    sources.push({ node: src, stop });
  }
  // Free the voice once the longest-ringing partial has stopped.
  if (last) last.onended = () => out.disconnect();
  return { end: when + voice.duration, fadeOut: (at: number) => fadeAndStop(out, sources, at) };
}
