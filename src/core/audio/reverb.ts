/**
 * Room reverb with synthesized (not recorded) impulse responses.
 * Design doc: サウンドデザイン > 環境音 — reverb follows the size of the space: short in a small
 * workshop, long under a glass dome. Technique: exponentially decaying stereo noise whose high
 * frequencies die first (a time-varying low-pass), plus a few early reflections after a pre-delay.
 *
 * Rooms are data supplied by the game (Through the Vidro: src/audio/rooms.ts); core has no presets.
 * synthesizeImpulseResponse() is pure; RoomReverb keeps one ConvolverNode per room and crossfades
 * between them so switching never clicks.
 */
import { mulberry32, type Rng } from './rng';

export interface RoomPreset {
  readonly id: string;
  /** Seconds to decay by 60 dB. */
  readonly t60: number;
  /** Seconds before the first reflection (bigger rooms = longer). */
  readonly preDelay: number;
  /** Wet (reverb) level sent back to the mix. */
  readonly wet: number;
  /** 0..1, how quickly high frequencies are absorbed relative to the decay. */
  readonly damping: number;
  /** Early reflections: how many, over how many seconds, and how loud relative to the diffuse tail. */
  readonly early: { readonly count: number; readonly spread: number; readonly gain: number };
}

/**
 * Identity of a room for caching and switching: every parameter, not just the id, so two presets that
 * share an id but differ in any value are treated as different rooms.
 */
export function roomKey(preset: RoomPreset): string {
  const e = preset.early;
  return [preset.id, preset.t60, preset.preDelay, preset.wet, preset.damping, e.count, e.spread, e.gain].join(
    '|',
  );
}

/**
 * Stereo impulse response for a room. Energy is normalised to 1 across channels so every room
 * sits at the same loudness and `wet` alone sets the mix.
 */
export function synthesizeImpulseResponse(
  preset: RoomPreset,
  sampleRate: number,
  rng: Rng,
  channels = 2,
): Float32Array[] {
  const length = Math.ceil((preset.preDelay + preset.t60 * 1.25) * sampleRate);
  const pre = Math.floor(preset.preDelay * sampleRate);
  const decay = Math.log(1000) / preset.t60; // amplitude decay rate (1/s), -60 dB at t60
  const fcStart = Math.min(16000, sampleRate * 0.45);
  const out: Float32Array[] = [];
  let energy = 0;
  for (let c = 0; c < channels; c++) {
    const data = new Float32Array(length);
    let y = 0;
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / sampleRate;
      // High frequencies are absorbed first: the low-pass cutoff falls as the tail decays.
      const fc = Math.max(200, fcStart * Math.exp((-preset.damping * 6 * t) / preset.t60));
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
      y += a * (rng() * 2 - 1 - y);
      // A one-pole low-pass scales white-noise variance by a/(2-a); undo it so the energy envelope
      // follows the T60 exactly and only the colour changes.
      data[i] = y * Math.sqrt((2 - a) / a) * Math.exp(-decay * t);
    }
    for (let j = 0; j < preset.early.count; j++) {
      const t = rng() * preset.early.spread;
      const idx = pre + Math.floor(t * sampleRate);
      if (idx < length) {
        const amp =
          (preset.early.gain / Math.sqrt(3)) * (1 - j / (preset.early.count + 1)) * Math.exp(-decay * t);
        data[idx] = (data[idx] as number) + (rng() < 0.5 ? -amp : amp);
      }
    }
    for (const v of data) energy += v * v;
    out.push(data);
  }
  const norm = energy > 0 ? 1 / Math.sqrt(energy) : 0;
  for (const data of out) for (let i = 0; i < data.length; i++) data[i] = (data[i] as number) * norm;
  return out;
}

const irCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

/** Impulse response as an AudioBuffer, cached per context and room. */
export function impulseResponseBuffer(ctx: BaseAudioContext, preset: RoomPreset, seed = 1): AudioBuffer {
  let byRoom = irCache.get(ctx);
  if (!byRoom) {
    byRoom = new Map();
    irCache.set(ctx, byRoom);
  }
  const key = `${roomKey(preset)}|${seed}`;
  let buf = byRoom.get(key);
  if (!buf) {
    const chans = synthesizeImpulseResponse(preset, ctx.sampleRate, mulberry32(seed));
    buf = ctx.createBuffer(chans.length, (chans[0] as Float32Array).length, ctx.sampleRate);
    for (const [i, d] of chans.entries()) buf.copyToChannel(d as Float32Array<ArrayBuffer>, i);
    byRoom.set(key, buf);
  }
  return buf;
}

interface RoomSlot {
  conv: ConvolverNode;
  gain: GainNode;
  /** Whether input currently feeds this convolver (idle rooms are unplugged to save CPU). */
  fed: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * input → one ConvolverNode per room (its buffer set once) → per-room gain → output.
 * Switching rooms only crossfades gains: replacing a playing convolver's buffer clicks, even when
 * switching back mid-fade. A room that has faded out is unplugged from the input after the fade so
 * idle convolvers do not cost CPU; it is plugged in again (same buffer) when the room comes back.
 */
export class RoomReverb {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly rooms = new Map<string, RoomSlot>();
  private current: RoomPreset;

  constructor(ctx: BaseAudioContext, preset: RoomPreset) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const slot = this.slot(preset);
    this.feed(slot);
    slot.gain.gain.value = preset.wet;
    this.current = preset;
  }

  get room(): RoomPreset {
    return this.current;
  }

  private slot(preset: RoomPreset): RoomSlot {
    const key = roomKey(preset);
    let slot = this.rooms.get(key);
    if (!slot) {
      const conv = this.ctx.createConvolver();
      conv.normalize = false;
      conv.buffer = impulseResponseBuffer(this.ctx, preset);
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      conv.connect(gain).connect(this.output);
      slot = { conv, gain, fed: false, idleTimer: null };
      this.rooms.set(key, slot);
    }
    return slot;
  }

  private feed(slot: RoomSlot): void {
    if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    if (!slot.fed) this.input.connect(slot.conv);
    slot.fed = true;
  }

  /** Crossfade to another room over `fade` seconds. */
  setRoom(preset: RoomPreset, fade = 0.5): void {
    if (roomKey(preset) === roomKey(this.current)) return;
    const now = this.ctx.currentTime;
    const tau = Math.max(0.001, fade / 4);
    const target = this.slot(preset);
    this.feed(target);
    target.gain.gain.cancelScheduledValues(now);
    target.gain.gain.setTargetAtTime(preset.wet, now, tau);
    for (const slot of this.rooms.values()) {
      if (slot === target) continue;
      slot.gain.gain.cancelScheduledValues(now);
      slot.gain.gain.setTargetAtTime(0, now, tau);
      if (slot.fed && slot.idleTimer === null) {
        // Unplug once the fade (and the tail it lets through) is over.
        slot.idleTimer = setTimeout(() => {
          slot.idleTimer = null;
          if (slot.fed) this.input.disconnect(slot.conv);
          slot.fed = false;
        }, fade * 3000);
      }
    }
    this.current = preset;
  }

  dispose(): void {
    this.input.disconnect();
    for (const slot of this.rooms.values()) {
      if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
      slot.conv.disconnect();
      slot.gain.disconnect();
    }
    this.rooms.clear();
    this.output.disconnect();
  }
}
