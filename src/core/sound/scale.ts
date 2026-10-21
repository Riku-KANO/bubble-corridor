// 音階への揃え。案1と共有する（音の仕組み）。
// 触れた音は、その部屋の調の5音（ペンタトニック）のうち、その瞬間の和音に合う音に揃える。

const mod12 = (n: number): number => ((n % 12) + 12) % 12;

const MAJOR_PENTATONIC = [0, 2, 4, 7, 9];
const MINOR_PENTATONIC = [0, 3, 5, 7, 10];

/** 和音の種類ごとの、根音からの音程（半音） */
const CHORD_INTERVALS: Readonly<Record<ChordQuality, readonly number[]>> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  add9: [0, 2, 4, 7],
  min9: [0, 2, 3, 7, 10],
  dim: [0, 3, 6],
};

/** 音名（0 = C、1 = C#、… 11 = B） */
export type PitchClass = number;

export type Mode = 'major' | 'minor';

export interface Key {
  readonly tonic: PitchClass;
  readonly mode: Mode;
}

export type ChordQuality =
  | 'maj'
  | 'min'
  | 'sus2'
  | 'sus4'
  | 'maj7'
  | 'min7'
  | 'dom7'
  | 'add9'
  | 'min9'
  | 'dim';

export interface Chord {
  readonly root: PitchClass;
  readonly quality: ChordQuality;
}

/** 調の5音（長調: 1 2 3 5 6、短調: 1 ♭3 4 5 ♭7）。音名を昇順で返す */
export function pentatonic(key: Key): PitchClass[] {
  const steps = key.mode === 'major' ? MAJOR_PENTATONIC : MINOR_PENTATONIC;
  return steps.map((s) => mod12(key.tonic + s)).sort((a, b) => a - b);
}

/** 和音の構成音の音名（昇順） */
export function chordTones(chord: Chord): PitchClass[] {
  return CHORD_INTERVALS[chord.quality].map((i) => mod12(chord.root + i)).sort((a, b) => a - b);
}

/** 根音からの音程（半音、昇順）。根音を最低音にした並べ方（転回しない形）を作るのに使う */
export function chordIntervals(chord: Chord): readonly number[] {
  return CHORD_INTERVALS[chord.quality];
}

/**
 * 触れた音の候補: 調の5音と和音の構成音の共通部分。
 * 共通部分が2音未満なら、調の5音をそのまま返す（どう触れても演奏になるように）。
 */
export function touchCandidates(key: Key, chord: Chord): PitchClass[] {
  const penta = pentatonic(key);
  const tones = chordTones(chord);
  const common = penta.filter((p) => tones.includes(p));
  return common.length >= 2 ? common : penta;
}

/**
 * 候補の音名のうち、around（MIDI ノート番号）に最も近い MIDI ノートを返す。
 * [low, high] の範囲に収める。同じ距離なら高い方。
 */
export function nearestPitch(candidates: readonly PitchClass[], around: number, low = 0, high = 127): number {
  let best = Math.min(high, Math.max(low, Math.round(around)));
  let bestDist = Infinity;
  for (let m = low; m <= high; m++) {
    if (!candidates.includes(mod12(m))) continue;
    const d = Math.abs(m - around);
    // 同じ距離なら高い方（昇順に走査しているので <= で上書きする）
    if (d <= bestDist) {
      best = m;
      bestDist = d;
    }
  }
  return best;
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}
