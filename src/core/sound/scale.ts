// 音階への揃え。案1と共有する（音の仕組み）。
// 触れた音は、その部屋の調の5音（ペンタトニック）のうち、その瞬間の和音に合う音に揃える。
// STUB: 署名は確定。中身は audio 担当が本実装に置き換える。

/** 音名（0 = C、1 = C#、… 11 = B） */
export type PitchClass = number;

export type Mode = 'major' | 'minor';

export interface Key {
  readonly tonic: PitchClass;
  readonly mode: Mode;
}

export type ChordQuality = 'maj' | 'min' | 'sus2' | 'sus4' | 'maj7' | 'min7' | 'dom7' | 'add9' | 'min9' | 'dim';

export interface Chord {
  readonly root: PitchClass;
  readonly quality: ChordQuality;
}

/** 調の5音（長調: 1 2 3 5 6、短調: 1 ♭3 4 5 ♭7）。音名を昇順で返す */
export function pentatonic(_key: Key): PitchClass[] {
  return []; // STUB
}

/** 和音の構成音の音名（昇順） */
export function chordTones(_chord: Chord): PitchClass[] {
  return []; // STUB
}

/**
 * 触れた音の候補: 調の5音と和音の構成音の共通部分。
 * 共通部分が2音未満なら、調の5音をそのまま返す（どう触れても演奏になるように）。
 */
export function touchCandidates(_key: Key, _chord: Chord): PitchClass[] {
  return []; // STUB
}

/**
 * 候補の音名のうち、around（MIDI ノート番号）に最も近い MIDI ノートを返す。
 * [low, high] の範囲に収める。同じ距離なら高い方。
 */
export function nearestPitch(_candidates: readonly PitchClass[], around: number, _low = 0, _high = 127): number {
  return around; // STUB
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
