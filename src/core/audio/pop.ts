/**
 * Thin-glass pops: the snap of a glass membrane so thin it flexes, like the bottom of a vidro /
 * poppen (Nagasaki's blown-glass toy) flipping in and out. Generic synthesis only — which notes a
 * game plays for which action lives in the game (Through the Vidro: src/audio/popen.ts).
 *
 * Each pop = a sine whose pitch starts a few percent sharp and drops onto the note within ~10 ms
 * (the membrane springs back), a faint thin-shell overtone, and a ~1 ms click.
 * A "pair" pattern voices two pops with the tuning's "po" and "pen" articulations (e.g. soft and short,
 * then brighter and ringing). The articulation and jitter values come from the game as a PopTuning.
 * designPops() is pure; schedulePops() renders it on any BaseAudioContext.
 */
import { fadeAndStop, GLASS_MODE_RATIOS, LN1000, noiseBuffer, type PlannedSource } from './glass';
import { jitter, type Rng } from './rng';
import { midiToHz } from './scale';
import type { ScheduledVoice } from './voices';

export interface PopPattern {
  /** MIDI notes, one per pop (the caller keeps them on its scale). */
  readonly notes: readonly number[];
  /** Seconds between pops. */
  readonly spacing: number;
  /** Peak gain of the loudest pop. */
  readonly gain: number;
  /** Gain multiplier per following pop (1 = even, <1 fades out). */
  readonly fade: number;
  /** Articulate the first two pops as a soft "po" and a bright, ringing "pen". */
  readonly pair: boolean;
}

export interface Pop {
  /** Seconds from the start of the sound. */
  time: number;
  midi: number;
  /** Target (jittered) frequency the pop settles on. */
  hz: number;
  gain: number;
  /** 0..1, level of the thin-shell overtone and the click. */
  bright: number;
  t60: number;
  /** Relative pitch overshoot at the snap. */
  glide: number;
}

export interface PopScore {
  pops: Pop[];
  duration: number;
}

const ATTACK = 0.001;

/** How one pop is voiced. */
export interface PopArticulation {
  /** Gain multiplier on the pattern gain. */
  gain: number;
  /** 0..1, level of the thin-shell overtone and the click. */
  bright: number;
  t60: number;
  /** Relative pitch overshoot at the snap. */
  glide: number;
}

/** Everything that shapes the pops, supplied by the game (Through the Vidro: src/audio/popen.ts). */
export interface PopTuning {
  /** First pop of a pair. */
  po: PopArticulation;
  /** Second pop of a pair. */
  pen: PopArticulation;
  /** Every pop of a non-pair pattern (and pops after the second). */
  plain: PopArticulation;
  /** Per-play randomness: time (± s), pitch (± fraction), level (± dB), t60 (± fraction). */
  jitter: { time: number; pitch: number; levelDb: number; t60: number };
}

export function designPops(pattern: PopPattern, rng: Rng, tuning: PopTuning): PopScore {
  const j = tuning.jitter;
  const pops: Pop[] = pattern.notes.map((midi, i) => {
    const a = pattern.pair && i === 0 ? tuning.po : pattern.pair && i === 1 ? tuning.pen : tuning.plain;
    return {
      time: i === 0 ? 0 : i * pattern.spacing + jitter(rng, j.time),
      midi,
      hz: midiToHz(midi) * (1 + jitter(rng, j.pitch)),
      gain: pattern.gain * a.gain * pattern.fade ** i * 10 ** (jitter(rng, j.levelDb) / 20),
      bright: a.bright,
      t60: a.t60 * (1 + jitter(rng, j.t60)),
      glide: a.glide,
    };
  });
  const duration = pops.length ? Math.max(...pops.map((p) => p.time + ATTACK + p.t60)) : 0;
  return { pops, duration };
}

/** Render the score into `destination` starting at `when`. */
export function schedulePops(
  ctx: BaseAudioContext,
  destination: AudioNode,
  score: PopScore,
  when: number,
): ScheduledVoice {
  const out = ctx.createGain();
  out.connect(destination);
  const sources: PlannedSource[] = [];
  let last: OscillatorNode | null = null;
  let lastEnd = 0;
  const overtone = GLASS_MODE_RATIOS[1] as number;
  for (const pop of score.pops) {
    const t = when + pop.time;
    // Body and thin-shell overtone, both snapping down onto pitch within ~10 ms.
    for (const [ratio, gain, t60] of [
      [1, pop.gain, pop.t60],
      [overtone, pop.gain * pop.bright * 0.5, pop.t60 * 0.5],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(pop.hz * ratio * (1 + pop.glide), t);
      osc.frequency.setTargetAtTime(pop.hz * ratio, t, 0.003);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain, t + ATTACK);
      env.gain.setTargetAtTime(0, t + ATTACK, t60 / LN1000);
      osc.connect(env).connect(out);
      const stop = t + ATTACK + t60;
      osc.start(t);
      osc.stop(stop);
      sources.push({ node: osc, stop });
      if (stop > lastEnd) {
        lastEnd = stop;
        last = osc;
      }
    }
    // The click of the glass bottom flipping.
    const click = ctx.createBufferSource();
    click.buffer = noiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const env = ctx.createGain();
    env.gain.setValueAtTime(pop.gain * 0.25 * (0.5 + pop.bright), t);
    env.gain.setTargetAtTime(0, t, 0.001);
    click.connect(hp).connect(env).connect(out);
    click.start(t, (pop.hz % 97) / 1000);
    click.stop(t + 0.01);
    sources.push({ node: click, stop: t + 0.01 });
  }
  // Free the voice once the longest-ringing partial has stopped.
  if (last) last.onended = () => out.disconnect();
  return {
    end: when + score.duration,
    fadeOut: (at: number) => fadeAndStop(out, sources, at),
  };
}
