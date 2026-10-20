// 楽曲の構成データ（score.json）を型つきで読む。
//
// 楽曲は作曲した音源ではなく、構成を「データ」として書き、その場でガラスの音を鳴らして演奏する
// （設計書「楽曲の組み立て方」）。JSON には区間ごとの調・和音の進行・層とその強さの変化を書き、
// 区間の長さ（小節）は config の SECTIONS から取る。時刻はすべて小節から計算する。
//
// JSON の書き方:
//   key        "Am"（短調）、"C"（長調）。音名 + 省略可の "m"
//   chords     [区間の頭からの小節, "Cmaj7"] の並び。小節 0 から始め、昇順
//   theme      区間が主題を持つなら {"octave": n}。主題の旋律そのものはトップレベルの theme（調の音階の度数）
//   layers     層。from / to は区間の頭からの小節（to は含まない、小数可）、level は [小節, 強さ0〜1] の折れ線
//   ambient    環境音の床。level は小節ごとの折れ線（区間をまたぐ受け渡しは区間の端で 0 に落とす）
import type { DoorChoice, SectionId } from '../contracts/ids';
import { SECTION_IDS } from '../contracts/ids';
import { BEATS_PER_BAR, BPM, SEC_PER_BAR, SECTIONS } from '../config';
import type { Chord, ChordQuality, Key } from '../core/sound/scale';
import type { ReverbSize } from '../core/sound/space';
import type { GlassTimbre, PadTimbre } from '../core/sound/voices';
import raw from './score.json' with { type: 'json' };

export type LayerKind = 'drone' | 'bass' | 'arpeggio' | 'melody' | 'rhythm' | 'sparkle';
export type LayerTimbre = GlassTimbre | PadTimbre;
export type AmbientBed = 'water' | 'air' | 'rain' | 'prism' | 'space' | 'waves';

/** [区間の頭からの小節, 値] の折れ線 */
export type Curve = readonly (readonly [number, number])[];

interface LayerBase {
  readonly kind: LayerKind;
  readonly timbre: LayerTimbre;
  /** 区間の頭からの小節。from 以上 to 未満に音を置く */
  readonly from: number;
  readonly to: number;
  /** 層の強さの変化。from〜to の外では鳴らさない */
  readonly level: Curve;
  /** 基準の強さ（0〜1）。実際の強さは vel × level */
  readonly vel: number;
}

/** 持続音: 和音ごとに、根音からの並び（pick は和音の構成音の何番目か）を base 以上の最も近い音から積む */
export interface DroneLayer extends LayerBase {
  readonly kind: 'drone';
  readonly base: number;
  readonly pick: readonly number[];
  /** 長い和音をこの小節数ごとに切り直す（強さの変化を追わせたいとき） */
  readonly chunk?: number;
}

/** 低音: 和音の頭（trigger: chord）か、毎小節の頭（bar）に根音などを鳴らす */
export interface BassLayer extends LayerBase {
  readonly kind: 'bass';
  readonly base: number;
  readonly pick: readonly number[];
  readonly trigger: 'chord' | 'bar';
}

/** 分散和音: rate 拍ごとに、steps（和音の構成音の何番目か、-1 は休み）を繰り返す */
export interface ArpeggioLayer extends LayerBase {
  readonly kind: 'arpeggio';
  readonly base: number;
  readonly rate: number;
  readonly steps: readonly number[];
  /** 音の長さ（拍） */
  readonly dur: number;
  /** 各音を残す確率（0〜1）。ばらつきは小節と位置から決める（毎回同じ） */
  readonly keep: number;
}

/** 旋律: 区間の主題を、at の小節から鳴らす */
export interface MelodyLayer extends LayerBase {
  readonly kind: 'melody';
  readonly at: readonly number[];
  readonly octave: number;
  /** 2 ならゆっくり（倍の長さ） */
  readonly stretch: number;
  /** 主題の最初の何音までを鳴らすか */
  readonly take: number;
}

/** リズム: 16分音符の格子に、パートごとの強弱（'9' が最大、'.' は休み）を置く。配列なら小節ごとに順に使う */
export interface RhythmPart {
  readonly timbre: GlassTimbre;
  readonly midi: number;
  readonly steps: readonly string[];
}
export interface RhythmLayer extends LayerBase {
  readonly kind: 'rhythm';
  readonly parts: readonly RhythmPart[];
}

/** きらめき: 1小節に perBar 個ほど、高い音を8分音符の位置に散らす（位置と高さは小節から決める） */
export interface SparkleLayer extends LayerBase {
  readonly kind: 'sparkle';
  readonly low: number;
  readonly high: number;
  readonly perBar: number;
  readonly seed: number;
}

export type Layer = DroneLayer | BassLayer | ArpeggioLayer | MelodyLayer | RhythmLayer | SparkleLayer;

export interface ThemeNote {
  /** 区間の主題の頭からの小節 */
  readonly bar: number;
  /** その小節の中の拍（0〜4） */
  readonly beat: number;
  readonly midi: number;
  /** 長さ（拍） */
  readonly beats: number;
}

export interface AmbientPart {
  readonly bed: AmbientBed;
  readonly level: Curve;
}

export interface SectionScore {
  readonly section: SectionId;
  /** 万華鏡だけ: 金（amber）か青（lapis） */
  readonly variant?: DoorChoice;
  /** 乗車の頭からの通しの小節 */
  readonly startBar: number;
  readonly bars: number;
  readonly key: Key;
  readonly chords: readonly { readonly bar: number; readonly chord: Chord }[];
  readonly theme: readonly ThemeNote[];
  readonly layers: readonly Layer[];
  readonly reverb: ReverbSize;
  readonly ambient: readonly AmbientPart[];
}

export interface Harmony {
  readonly section: SectionId;
  readonly key: Key;
  readonly chord: Chord;
}

// ── JSON の読み込みと検査 ───────────────────────────────────────────────

const NOTE_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const QUALITY_SUFFIX: Readonly<Record<string, ChordQuality>> = {
  '': 'maj',
  m: 'min',
  maj7: 'maj7',
  m7: 'min7',
  '7': 'dom7',
  sus2: 'sus2',
  sus4: 'sus4',
  add9: 'add9',
  m9: 'min9',
  dim: 'dim',
};

function fail(where: string, msg: string): never {
  throw new Error(`score.json ${where}: ${msg}`);
}

function parseRoot(name: string, where: string): { pc: number; rest: string } {
  const m = /^([A-G])([#b]?)(.*)$/.exec(name);
  if (!m) fail(where, `音名が読めない（${name}）`);
  return { pc: (NOTE_PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12, rest: m[3] };
}

export function parseChord(name: string, where = 'chord'): Chord {
  const { pc, rest } = parseRoot(name, where);
  const quality = QUALITY_SUFFIX[rest];
  if (!quality) fail(where, `和音の種類が読めない（${name}）`);
  return { root: pc, quality };
}

function parseKey(name: string, where: string): Key {
  const { pc, rest } = parseRoot(name, where);
  if (rest !== '' && rest !== 'm') fail(where, `調が読めない（${name}）`);
  return { tonic: pc, mode: rest === 'm' ? 'minor' : 'major' };
}

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

/** 調の音階の度数（0 = 主音、7 = 1オクターブ上、-1 = 1つ下）を MIDI にする。主音は 57〜68 の間に置く */
export function degreeToMidi(key: Key, degree: number): number {
  const steps = key.mode === 'major' ? MAJOR_STEPS : MINOR_STEPS;
  const base = 57 + ((((key.tonic - 57) % 12) + 12) % 12);
  const oct = Math.floor(degree / 7);
  const idx = ((degree % 7) + 7) % 7;
  return base + steps[idx] + 12 * oct;
}

type RawCurve = number[][];
interface RawLayer {
  kind: LayerKind;
  timbre: LayerTimbre;
  from: number;
  to: number;
  level: RawCurve;
  vel: number;
  [k: string]: unknown;
}
interface RawSection {
  key: string;
  reverb: ReverbSize;
  chords: [number, string][];
  theme?: { octave: number } | null;
  layers: RawLayer[];
  ambient: { bed: AmbientBed; level: RawCurve }[];
}

const rawScore = raw as unknown as {
  bpm: number;
  beatsPerBar: number;
  theme: [number, number, number, number][];
  lobby: RawSection;
  sections: Record<string, RawSection | Record<DoorChoice, RawSection>>;
};

const toCurve = (c: RawCurve, where: string): Curve => {
  if (c.length === 0) fail(where, 'level が空');
  for (let i = 0; i < c.length; i++) {
    if (c[i].length !== 2) fail(where, 'level は [小節, 強さ] の並び');
    if (i > 0 && c[i][0] < c[i - 1][0]) fail(where, 'level の小節が昇順でない');
  }
  return c.map((p) => [p[0], p[1]] as const);
};

function buildLayer(r: RawLayer, bars: number, where: string): Layer {
  const base = {
    kind: r.kind,
    timbre: r.timbre,
    from: r.from,
    to: r.to,
    level: toCurve(r.level, where),
    vel: r.vel,
  };
  if (!(r.from >= 0 && r.to <= bars && r.from < r.to)) fail(where, `from/to が区間（${bars} 小節）に収まらない`);
  const num = (k: string, d?: number): number => {
    const v = r[k];
    if (typeof v === 'number') return v;
    if (d !== undefined) return d;
    return fail(where, `${k} が必要`);
  };
  const arr = (k: string): number[] => {
    const v = r[k];
    if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return v as number[];
    return fail(where, `${k} は数の並び`);
  };
  switch (r.kind) {
    case 'drone':
      return { ...base, kind: 'drone', base: num('base'), pick: arr('pick'), chunk: typeof r.chunk === 'number' ? r.chunk : undefined };
    case 'bass': {
      const trigger = r.trigger === 'bar' ? 'bar' : 'chord';
      return { ...base, kind: 'bass', base: num('base'), pick: arr('pick'), trigger };
    }
    case 'arpeggio':
      return { ...base, kind: 'arpeggio', base: num('base'), rate: num('rate'), steps: arr('steps'), dur: num('dur', num('rate') * 1.5), keep: num('keep', 1) };
    case 'melody':
      return { ...base, kind: 'melody', at: arr('at'), octave: num('octave', 0), stretch: num('stretch', 1), take: num('take', 99) };
    case 'rhythm': {
      const parts = r.parts as RhythmPart[] | undefined;
      if (!parts || parts.length === 0) fail(where, 'parts が必要');
      for (const p of parts) for (const s of p.steps) if (s.length !== 16) fail(where, `steps は16文字（${s}）`);
      return { ...base, kind: 'rhythm', parts };
    }
    case 'sparkle':
      return { ...base, kind: 'sparkle', low: num('low'), high: num('high'), perBar: num('perBar'), seed: num('seed', 1) };
    default:
      return fail(where, `層の種類が読めない（${String(r.kind)}）`);
  }
}

function buildSection(id: SectionId, variant: DoorChoice | undefined, r: RawSection, specOverride?: { startBar: number; bars: number }): SectionScore {
  const where = variant ? `${id}.${variant}` : specOverride ? 'lobby' : id;
  const spec = specOverride ?? SECTIONS.find((s) => s.id === id);
  if (!spec) fail(where, '区間が config にない');
  const key = parseKey(r.key, `${where}.key`);
  const chords = r.chords.map(([bar, name]) => ({ bar, chord: parseChord(name, `${where}.chords`) }));
  if (chords.length === 0 || chords[0].bar !== 0) fail(where, '和音は小節 0 から始める');
  for (let i = 0; i < chords.length; i++) {
    if (chords[i].bar >= spec.bars) fail(where, `和音の小節が区間の外（${chords[i].bar}）`);
    if (i > 0 && chords[i].bar <= chords[i - 1].bar) fail(where, '和音の小節が昇順でない');
  }
  const theme: ThemeNote[] = r.theme
    ? rawScore.theme.map(([bar, beat, degree, beats]) => ({ bar, beat, midi: degreeToMidi(key, degree) + 12 * r.theme!.octave, beats }))
    : [];
  return {
    section: id,
    variant,
    startBar: spec.startBar,
    bars: spec.bars,
    key,
    chords,
    theme,
    layers: r.layers.map((l, i) => buildLayer(l, spec.bars, `${where}.layers[${i}]`)),
    reverb: r.reverb,
    ambient: r.ambient.map((a, i) => ({ bed: a.bed, level: toCurve(a.level, `${where}.ambient[${i}]`) })),
  };
}

export const SCORE = {
  bpm: rawScore.bpm,
  beatsPerBar: rawScore.beatsPerBar,
} as const;

if (SCORE.bpm !== BPM || SCORE.beatsPerBar !== BEATS_PER_BAR) {
  throw new Error('score.json のテンポと拍子が config と違う');
}

const built = new Map<string, SectionScore>();
for (const id of SECTION_IDS) {
  const entry = rawScore.sections[id];
  if (!entry) throw new Error(`score.json に区間 ${id} がない`);
  if ('key' in entry) {
    built.set(id, buildSection(id, undefined, entry));
  } else {
    for (const door of ['amber', 'lapis'] as const) built.set(`${id}:${door}`, buildSection(id, door, entry[door]));
  }
}

/** 入口（乗車の外）で繰り返す音楽の長さ（小節） */
export const LOBBY_BARS = 8;

/** 入口の音楽。乗り場と同じ調（A 短調）で、降車の終わりの和音（Am9）から自然につながる。区間と同じ形式の8小節のループ */
export const LOBBY_SCORE: SectionScore = buildSection('platform', undefined, rawScore.lobby, { startBar: 0, bars: LOBBY_BARS });

/** 区間の構成。万華鏡だけ扉（金 = amber、青 = lapis）で変わる */
export function sectionScore(id: SectionId, door: DoorChoice): SectionScore {
  const s = id === 'kaleidoscope' ? built.get(`${id}:${door}`) : built.get(id);
  if (!s) throw new Error(`区間の構成がない: ${id}`);
  return s;
}

// ── 時刻から調と和音を引く ─────────────────────────────────────────────

/** t が小節の頭ちょうどのとき、浮動小数点の誤差で前の小節に落ちないよう少し足す */
const BAR_EPS = 1e-9;

/** 乗車の秒 → 通しの小節（小数） */
export function barAt(t: number): number {
  return t / SEC_PER_BAR + BAR_EPS;
}

export function sectionIdAt(t: number): SectionId {
  const bar = barAt(Math.max(0, t));
  for (let i = SECTIONS.length - 1; i >= 0; i--) if (bar >= SECTIONS[i].startBar) return SECTIONS[i].id;
  return SECTIONS[0].id;
}

export function chordAtBar(s: SectionScore, relBar: number): Chord {
  let c = s.chords[0].chord;
  for (const x of s.chords) {
    if (x.bar <= relBar + BAR_EPS) c = x.chord;
    else break;
  }
  return c;
}

/** その時刻の区間・調・和音。扉は万華鏡のときだけ効く */
export function harmonyAt(t: number, door: DoorChoice): Harmony {
  const id = sectionIdAt(t);
  const s = sectionScore(id, door);
  const rel = Math.min(s.bars - 1e-6, Math.max(0, barAt(Math.max(0, t)) - s.startBar));
  return { section: id, key: s.key, chord: chordAtBar(s, rel) };
}

/** 入口の音楽の、音楽を始めてからの秒 t のときの調と和音（8小節のループ） */
export function lobbyHarmonyAt(t: number): Harmony {
  const loop = LOBBY_BARS * SEC_PER_BAR;
  const rel = ((((t % loop) + loop) % loop) / SEC_PER_BAR);
  return { section: 'platform', key: LOBBY_SCORE.key, chord: chordAtBar(LOBBY_SCORE, rel) };
}

// ── 膜の通過音 ─────────────────────────────────────────────────────────

/**
 * 部屋の境目の膜（0〜5 番目）を通る音の高さ（MIDI）。膜ごとに違う音で、次の区間の調の主音・3度・5度に当たる:
 * 温室の C、雨の回廊の E、万華鏡の（D 長調の3度でも B 短調の5度でもある）F#、天球の E 長調の3度 G#、
 * 夜明けの C の5度、降車の A 短調の主音。
 */
const MEMBRANE_PITCHES = [72, 76, 78, 80, 79, 81] as const;
export function membranePitch(i: number): number {
  return MEMBRANE_PITCHES[Math.min(MEMBRANE_PITCHES.length - 1, Math.max(0, Math.floor(i)))];
}

// ── 折れ線の強さ ───────────────────────────────────────────────────────

/** 折れ線を relBar で読む。最初の点より前は最初の値、最後の点より後は最後の値 */
export function curveAt(curve: Curve, relBar: number): number {
  if (relBar <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [b1, v1] = curve[i];
    if (relBar <= b1) {
      const [b0, v0] = curve[i - 1];
      return b1 === b0 ? v1 : v0 + ((v1 - v0) * (relBar - b0)) / (b1 - b0);
    }
  }
  return curve[curve.length - 1][1];
}

// ── 環境音の床（乗車の秒の折れ線） ─────────────────────────────────────────

export interface AmbientKey {
  readonly t: number;
  readonly v: number;
}

const ambientCache = new Map<string, Record<AmbientBed, readonly AmbientKey[]>>();

/** 環境音の床ごとの強さの折れ線（乗車の秒）。区間の折れ線をつないだもの。扉で万華鏡の分だけ変わる */
export function ambientKeys(door: DoorChoice): Record<AmbientBed, readonly AmbientKey[]> {
  const cached = ambientCache.get(door);
  if (cached) return cached;
  const out: Record<AmbientBed, AmbientKey[]> = { water: [], air: [], rain: [], prism: [], space: [], waves: [] };
  for (const id of SECTION_IDS) {
    const s = sectionScore(id, door);
    for (const a of s.ambient) {
      for (const [bar, v] of a.level) out[a.bed].push({ t: (s.startBar + bar) * SEC_PER_BAR, v });
    }
  }
  for (const k of Object.keys(out) as AmbientBed[]) out[k].sort((a, b) => a.t - b.t);
  ambientCache.set(door, out);
  return out;
}

/** 環境音の床の強さ（乗車の秒 t のとき）。点のない側は 0 */
export function ambientLevelAt(keys: readonly AmbientKey[], t: number): number {
  if (keys.length === 0 || t < keys[0].t || t > keys[keys.length - 1].t) return 0;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
    }
  }
  return keys[keys.length - 1].v;
}
