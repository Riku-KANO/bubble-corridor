/**
 * Voice bookkeeping for the engine, kept pure so it can be unit-tested without Web Audio:
 *  - admission: may a sound start now? (running, offline, or just after the unlocking gesture)
 *  - capacity: total and per-emitter caps; at a cap the quietest voice is stolen rather than the
 *    new sound being dropped (design doc: UI/UX設計 > UIの原則 3 — every input answers within 0.1 s).
 * Times: `now`/`start`/`end` are audio-context seconds; `wallNow`/`resumeRequestedAt` are wall-clock
 * seconds (the context clock stands still while suspended).
 */

/** A sound that has been scheduled and can be cut short. */
export interface ScheduledVoice {
  /** Context time when it falls silent on its own. */
  readonly end: number;
  /** Fade to silence over ~10 ms starting at `when`, then release its nodes. */
  fadeOut(when: number): void;
}

export interface GateState {
  /** False for OfflineAudioContext: scheduling ahead of rendering is always fine. */
  realtime: boolean;
  running: boolean;
  /** Wall-clock seconds of the last unlock() that was allowed to call resume(); null if none. */
  resumeRequestedAt: number | null;
  wallNow: number;
}

/**
 * Should a gesture handler ask the browser to resume? Only for a realtime context that is not running
 * and not closed, and only while the page has user activation: without it Chrome leaves resume()
 * pending forever. `activationActive` is null where navigator.userActivation does not exist (then the
 * gesture handler itself is the activation, so try).
 */
export function mayRequestResume(s: {
  realtime: boolean;
  state: string;
  activationActive: boolean | null;
}): boolean {
  if (!s.realtime || s.state === 'running' || s.state === 'closed') return false;
  return s.activationActive !== false;
}

export interface VoiceAllocatorOptions {
  maxVoices: number;
  maxPerGroup: number;
  /**
   * Seconds after an unlocking gesture during which sounds are accepted although the context has not
   * started yet (resume() is asynchronous). Past it, a resume that never completed must not keep
   * queueing sounds that would all burst out later.
   */
  resumeGrace: number;
}

interface Slot<T> {
  start: number;
  end: number;
  level: number;
  /** Usually the emitter; null = no per-group cap. */
  group: unknown;
  data: T;
}

export class VoiceAllocator<T> {
  private readonly opts: VoiceAllocatorOptions;
  private readonly slots: Slot<T>[] = [];
  private readonly stolen: T[] = [];

  constructor(opts: VoiceAllocatorOptions) {
    // At least one voice, or makeRoom() could never make room.
    this.opts = {
      ...opts,
      maxVoices: Math.max(1, opts.maxVoices),
      maxPerGroup: Math.max(1, opts.maxPerGroup),
    };
  }

  accepts(s: GateState): boolean {
    if (!s.realtime || s.running) return true;
    if (s.resumeRequestedAt === null) return false;
    const since = s.wallNow - s.resumeRequestedAt;
    return since >= 0 && since <= this.opts.resumeGrace;
  }

  /** Number of voices still sounding at `now`. */
  active(now: number): number {
    this.prune(now);
    return this.slots.length;
  }

  /**
   * Free room for one more voice in `group`. Returns the voices to silence (already forgotten here).
   * The returned array is reused by the next call; consume it immediately.
   */
  makeRoom(now: number, group: unknown): readonly T[] {
    this.prune(now);
    this.stolen.length = 0;
    if (group !== null && this.countGroup(group) >= this.opts.maxPerGroup) this.steal(now, group);
    while (this.slots.length >= this.opts.maxVoices) this.steal(now, null);
    return this.stolen;
  }

  add(slot: Slot<T>): void {
    this.slots.push(slot);
  }

  /** Forget every voice of `group` (its emitter is gone; it must not count or be stolen later). */
  releaseGroup(group: unknown): void {
    let w = 0;
    for (let r = 0; r < this.slots.length; r++) {
      const s = this.slots[r] as Slot<T>;
      if (s.group !== group) this.slots[w++] = s;
    }
    this.slots.length = w;
  }

  /** Drop finished voices in place (no allocation). */
  private prune(now: number): void {
    let w = 0;
    for (let r = 0; r < this.slots.length; r++) {
      const s = this.slots[r] as Slot<T>;
      if (s.end > now) this.slots[w++] = s;
    }
    this.slots.length = w;
  }

  private countGroup(group: unknown): number {
    let n = 0;
    for (const s of this.slots) if (s.group === group) n++;
    return n;
  }

  /** Remove the quietest voice (of `group`, or of all when null). */
  private steal(now: number, group: unknown): void {
    let best = -1;
    let bestLevel = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i] as Slot<T>;
      if (group !== null && s.group !== group) continue;
      const level = loudness(s, now);
      if (level < bestLevel) {
        bestLevel = level;
        best = i;
      }
    }
    if (best < 0) return;
    const victim = this.slots[best] as Slot<T>;
    for (let i = best + 1; i < this.slots.length; i++) this.slots[i - 1] = this.slots[i] as Slot<T>;
    this.slots.length--;
    this.stolen.push(victim.data);
  }
}

/** Estimated current amplitude: the voice decays by 60 dB between start and end. */
function loudness(s: Slot<unknown>, now: number): number {
  if (now <= s.start) return s.level;
  const k = Math.min(1, (now - s.start) / Math.max(1e-6, s.end - s.start));
  return s.level * 10 ** (-3 * k);
}
