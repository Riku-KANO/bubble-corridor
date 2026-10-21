import { glassEase } from './curve';

/** A named transition and its length in seconds (values from トランジション設計 > 遷移の一覧). */
export interface TransitionSpec {
  id: string;
  seconds: number;
}

export interface TransitionOptions {
  /**
   * 遷移のルール 2: if the next scene is not ready, stop at this progress (0..1) in mid-pose
   * and continue once `isReady()` turns true.
   */
  holdAt?: number;
  isReady?: () => boolean;
  /** Start at the end and play backwards (returning along the way we came). */
  startAtEnd?: boolean;
}

/** 遷移のルール 4: during transitions longer than this, Esc is always accepted. */
export const ESC_ALWAYS_ACCEPTED_ABOVE_SECONDS = 0.5;

export function acceptsEscape(spec: TransitionSpec): boolean {
  return spec.seconds > ESC_ALWAYS_ACCEPTED_ABOVE_SECONDS;
}

/** Maps progress inside [from, to] onto 0..1 (clamped). Used to stage parts of one transition. */
export function segment(p: number, from: number, to: number): number {
  if (to <= from) return p >= to ? 1 : 0;
  return Math.min(1, Math.max(0, (p - from) / (to - from)));
}

/**
 * Drives one transition in time. `progress` is linear time (0..1), `value` is the eased position
 * on the common curve. Reversing replays the same motion backwards (UI/UX設計 > 細部の振る舞い: 戻る操作).
 */
export class Transition {
  readonly spec: TransitionSpec;
  private elapsedSeconds: number;
  private dir: 1 | -1;
  private readonly holdAt: number | null;
  private readonly isReady: () => boolean;
  private isHolding = false;

  constructor(spec: TransitionSpec, opts: TransitionOptions = {}) {
    this.spec = spec;
    this.elapsedSeconds = opts.startAtEnd ? spec.seconds : 0;
    this.dir = opts.startAtEnd ? -1 : 1;
    this.holdAt = opts.holdAt ?? null;
    this.isReady = opts.isReady ?? (() => true);
  }

  get elapsed(): number {
    return this.elapsedSeconds;
  }

  get progress(): number {
    return this.spec.seconds > 0 ? Math.min(1, this.elapsedSeconds / this.spec.seconds) : 1;
  }

  get value(): number {
    return glassEase(this.progress);
  }

  get direction(): 1 | -1 {
    return this.dir;
  }

  get holding(): boolean {
    return this.isHolding;
  }

  /** 'forward' when it reached the end, 'reversed' when it played back to the start, else null. */
  get finished(): 'forward' | 'reversed' | null {
    if (this.dir === 1 && this.elapsedSeconds >= this.spec.seconds) return 'forward';
    if (this.dir === -1 && this.elapsedSeconds <= 0) return 'reversed';
    return null;
  }

  reverse(): void {
    this.dir = this.dir === 1 ? -1 : 1;
    this.isHolding = false;
  }

  update(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    let next = this.elapsedSeconds + dt * this.dir;
    this.isHolding = false;
    if (this.dir === 1 && this.holdAt !== null && !this.isReady()) {
      const holdSeconds = this.holdAt * this.spec.seconds;
      if (next >= holdSeconds) {
        next = Math.max(this.elapsedSeconds, holdSeconds);
        this.isHolding = true;
      }
    }
    this.elapsedSeconds = Math.min(this.spec.seconds, Math.max(0, next));
  }
}
