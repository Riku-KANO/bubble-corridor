/**
 * Musical scale math. Pure functions, no Web Audio, no game defaults: every function takes the
 * scale (or size→pitch rule) as an argument, so both games can use their own tuning.
 * Each game keeps its own scale and rule (Through the Vidro: src/audio/tuning.ts).
 */

export interface Scale {
  readonly name: string;
  /** Pitch class of the root, 0 = C … 11 = B. */
  readonly rootPitchClass: number;
  /** Semitone offsets from the root, ascending, unique, each in 0..11. */
  readonly intervals: readonly number[];
}

/** Interval set of a major pentatonic (degrees 1 2 3 5 6). */
export const MAJOR_PENTATONIC: readonly number[] = [0, 2, 4, 7, 9];

const A4_MIDI = 69;
const A4_HZ = 440;
const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

function isPitchClass(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 11;
}

/** Throws RangeError for a scale the search functions could not terminate on. */
function assertScale(scale: Scale): void {
  if (
    !isPitchClass(scale.rootPitchClass) ||
    scale.intervals.length === 0 ||
    !scale.intervals.every(isPitchClass)
  ) {
    throw new RangeError(
      `Invalid scale "${scale.name}": root 0..11 and at least one interval in 0..11 required`,
    );
  }
}

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be a finite number, got ${value}`);
}

/** Validated scale. */
export function makeScale(name: string, rootPitchClass: number, intervals: readonly number[]): Scale {
  const scale: Scale = { name, rootPitchClass, intervals: [...new Set(intervals)].sort((a, b) => a - b) };
  assertScale(scale);
  return scale;
}

/** Equal temperament, A4 = 440 Hz. MIDI may be fractional. */
export function midiToHz(midi: number): number {
  return A4_HZ * 2 ** ((midi - A4_MIDI) / 12);
}

export function hzToMidi(hz: number): number {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

/** Scientific pitch name, e.g. 62 → "D4", 66 → "F#4". */
export function noteName(midi: number): string {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  return `${PITCH_CLASS_NAMES[pc]}${Math.floor(m / 12) - 1}`;
}

export function isInScale(midi: number, scale: Scale): boolean {
  if (!Number.isInteger(midi)) return false;
  const rel = (((midi - scale.rootPitchClass) % 12) + 12) % 12;
  return scale.intervals.includes(rel);
}

/** All scale notes in [lowMidi, highMidi], ascending. */
export function scaleNotes(scale: Scale, lowMidi: number, highMidi: number): number[] {
  assertScale(scale);
  assertFinite(lowMidi, 'lowMidi');
  assertFinite(highMidi, 'highMidi');
  const out: number[] = [];
  for (let m = Math.ceil(lowMidi); m <= Math.floor(highMidi); m++) if (isInScale(m, scale)) out.push(m);
  return out;
}

/** Nearest scale note at or below / above `from`, searching at most one octave. */
function seek(from: number, dir: 1 | -1, scale: Scale): number {
  let m = from;
  for (let i = 0; i < 12; i++, m += dir) if (isInScale(m, scale)) return m;
  // Unreachable for a valid scale (every octave contains the root); kept as a hard stop.
  throw new RangeError(`No note of "${scale.name}" within an octave of ${from}`);
}

/** Nearest scale note to a (fractional) MIDI pitch. Ties resolve downward so the mapping stays monotonic. */
export function snapToScale(midi: number, scale: Scale): number {
  assertScale(scale);
  assertFinite(midi, 'midi');
  const below = Math.floor(midi);
  const lo = seek(below, -1, scale);
  const hi = seek(below + 1, 1, scale);
  return midi - lo <= hi - midi ? lo : hi;
}

/** Move `steps` (an integer) scale degrees from the scale note nearest to `midi` (negative = down). */
export function scaleStep(midi: number, steps: number, scale: Scale): number {
  if (!Number.isInteger(steps)) throw new RangeError(`steps must be an integer, got ${steps}`);
  let m = snapToScale(midi, scale);
  const dir = steps < 0 ? -1 : 1;
  for (let i = 0; i < Math.abs(steps); i++) m = seek(m + dir, dir, scale);
  return m;
}

/**
 * Rule for choosing a pitch from an object's size.
 * A vibrating shell scaled up uniformly drops in frequency as f ∝ 1/size, i.e. one octave (12 semitones)
 * per doubling — the physically natural mapping. The result is clamped to a range and snapped to the scale.
 */
export interface SizePitchRule {
  /** Characteristic size in metres (diameter / longest dimension) that rings at refMidi. */
  readonly refSize: number;
  readonly refMidi: number;
  readonly semitonesPerDoubling: number;
  readonly minMidi: number;
  readonly maxMidi: number;
  readonly scale: Scale;
}

export interface Pitch {
  midi: number;
  hz: number;
  name: string;
}

/** Scale note for an object of `size` metres (positive, finite). Never rises when size grows. */
export function pitchForSize(size: number, rule: SizePitchRule): Pitch {
  if (!Number.isFinite(size) || size <= 0)
    throw new RangeError(`size must be a positive finite number, got ${size}`);
  const raw = rule.refMidi - rule.semitonesPerDoubling * Math.log2(size / rule.refSize);
  const clamped = Math.min(rule.maxMidi, Math.max(rule.minMidi, raw));
  let midi = snapToScale(clamped, rule.scale);
  if (midi > rule.maxMidi) midi = scaleStep(midi, -1, rule.scale);
  if (midi < rule.minMidi) midi = scaleStep(midi, 1, rule.scale);
  return { midi, hz: midiToHz(midi), name: noteName(midi) };
}
