// 演奏の予定。楽曲の構成データ（score）から、ある時間の窓に鳴らす音を決める。
//
// 純粋で決定的: 同じ窓と扉には、いつ何度呼んでも同じ音が同じ順で返る。ばらつき（きらめきの位置や高さ）は
// 乱数ではなく、小節と位置から決めた値で作る。窓は [t0, t1) の半開区間なので、窓を分けて呼んでも
// まとめて呼んだのと同じになる（境目で取りこぼしも二重もない）。
// 先読みの予約は、25ms ごとにこの関数を「前回の続きから約0.2秒先まで」の窓で呼んで鳴らす（engine）。
import type { DoorChoice, SectionId } from '../contracts/ids';
import { BEATS_PER_BAR, SECTIONS, SEC_PER_BAR, SEC_PER_BEAT } from '../config';
import { chordIntervals, nearestPitch, touchCandidates } from '../core/sound/scale';
import type { Chord } from '../core/sound/scale';
import type { Layer, LayerKind, LayerTimbre, SectionScore } from './score';
import { chordAtBar, curveAt, LOBBY_BARS, LOBBY_SCORE, sectionScore } from './score';

export interface PlannedNote {
  /** 鳴らし始める時刻（乗車の秒） */
  readonly t: number;
  readonly layer: LayerKind;
  readonly timbre: LayerTimbre;
  /** MIDI ノート番号 */
  readonly midi: number;
  /** 0〜1（層の基準の強さ × 強さの変化 × 拍の強弱）。全体の大きさの比べ合いにも使う */
  readonly velocity: number;
  /** 持続する音色の長さ（秒） */
  readonly duration: number;
  readonly section: SectionId;
}

/** 同じ時刻の音を並べる順（低い音の層が先） */
const LAYER_RANK: Readonly<Record<LayerKind, number>> = { bass: 0, drone: 1, arpeggio: 2, melody: 3, rhythm: 4, sparkle: 5 };

/** これより小さい強さの音は鳴らさない */
const MIN_VELOCITY = 0.015;
/** 和音が切り替わるとき、持続音を少し重ねて途切れさせない（秒） */
const PAD_OVERLAP = 0.6;
const EPS = 1e-9;

/** 整数から [0, 1) の値を決める（murmur3 の仕上げ）。乱数の代わりに、同じ入力には同じ値を返す */
export function hash01(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

/** 和音を根音から積んだ並びの idx 番目の音。base 以上で最も低い根音から始め、使い切ったら1オクターブ上へ */
export function chordLadder(chord: Chord, base: number, idx: number): number {
  const ivs = chordIntervals(chord);
  const root = base + ((((chord.root - base) % 12) + 12) % 12);
  const n = ivs.length;
  return root + ivs[((idx % n) + n) % n] + 12 * Math.floor(idx / n);
}

function levelAt(layer: Layer, relBar: number): number {
  if (relBar < layer.from - EPS || relBar >= layer.to - EPS) return 0;
  return curveAt(layer.level, relBar);
}

function generate(s: SectionScore): PlannedNote[] {
  const out: PlannedNote[] = [];
  const tOf = (relBar: number) => (s.startBar + relBar) * SEC_PER_BAR;
  const push = (relBar: number, layer: Layer, timbre: LayerTimbre, midi: number, velocity: number, duration: number) => {
    if (velocity < MIN_VELOCITY) return;
    out.push({ t: tOf(relBar), layer: layer.kind, timbre, midi, velocity: Math.min(1, velocity), duration, section: s.section });
  };
  /** 和音の区切り: [開始, 終了) の小節 */
  const spans = s.chords.map((c, i) => ({ start: c.bar, end: i + 1 < s.chords.length ? s.chords[i + 1].bar : s.bars }));

  s.layers.forEach((layer, li) => {
    switch (layer.kind) {
      case 'drone': {
        for (const sp of spans) {
          const segStart = Math.max(sp.start, layer.from);
          const segEnd = Math.min(sp.end, layer.to);
          const chunk = layer.chunk ?? Infinity;
          for (let a = segStart; a < segEnd - EPS; a += chunk) {
            const b = Math.min(a + chunk, segEnd);
            // 持続音は鳴っている間に強さが動くので、始まりと終わりの平均で決める
            const lv = (curveAt(layer.level, a) + curveAt(layer.level, Math.min(b, layer.to))) / 2;
            const chord = chordAtBar(s, a);
            const joins = b < layer.to - EPS;
            const duration = (b - a) * SEC_PER_BAR + (joins ? PAD_OVERLAP : 0);
            for (const idx of layer.pick) push(a, layer, layer.timbre, chordLadder(chord, layer.base, idx), layer.vel * lv, duration);
          }
        }
        break;
      }
      case 'bass': {
        const starts =
          layer.trigger === 'chord'
            ? spans.filter((sp) => sp.start >= layer.from - EPS && sp.start < layer.to - EPS).map((sp) => ({ at: sp.start, len: Math.min(4, sp.end - sp.start) }))
            : Array.from({ length: Math.max(0, Math.ceil(layer.to) - Math.ceil(layer.from)) }, (_, i) => ({ at: Math.ceil(layer.from) + i, len: 1 }));
        for (const st of starts) {
          const lv = levelAt(layer, st.at);
          const chord = chordAtBar(s, st.at);
          for (const idx of layer.pick) push(st.at, layer, layer.timbre, chordLadder(chord, layer.base, idx), layer.vel * lv, st.len * SEC_PER_BAR);
        }
        break;
      }
      case 'arpeggio': {
        const perBar = BEATS_PER_BAR / layer.rate;
        for (let r = Math.floor(layer.from); r < layer.to; r++) {
          for (let st = 0; st < perBar; st++) {
            const pos = r + (st * layer.rate) / BEATS_PER_BAR;
            if (pos < layer.from - EPS || pos >= layer.to - EPS) continue;
            const idx = layer.steps[(r * perBar + st) % layer.steps.length];
            if (idx < 0) continue;
            if (layer.keep < 1 && hash01(li, r, st, 7) >= layer.keep) continue;
            const beat = st * layer.rate;
            const accent = beat === 0 ? 1 : beat === 2 ? 0.9 : Number.isInteger(beat) ? 0.8 : 0.7;
            const chord = chordAtBar(s, pos);
            push(pos, layer, layer.timbre, chordLadder(chord, layer.base, idx), layer.vel * levelAt(layer, pos) * accent, layer.dur * SEC_PER_BEAT);
          }
        }
        break;
      }
      case 'melody': {
        const n = Math.min(layer.take, s.theme.length);
        for (const a of layer.at) {
          if (a < layer.from - EPS || a >= layer.to - EPS) continue;
          for (let i = 0; i < n; i++) {
            const note = s.theme[i];
            const pos = a + layer.stretch * (note.bar + note.beat / BEATS_PER_BAR);
            if (pos >= layer.to - EPS) continue;
            const accent = note.beat === 0 ? 1 : 0.88;
            push(pos, layer, layer.timbre, note.midi + 12 * layer.octave, layer.vel * levelAt(layer, pos) * accent, note.beats * layer.stretch * SEC_PER_BEAT + 0.12);
          }
        }
        break;
      }
      case 'rhythm': {
        for (let r = Math.floor(layer.from); r < layer.to; r++) {
          for (let st = 0; st < 16; st++) {
            const pos = r + st / 16;
            if (pos < layer.from - EPS || pos >= layer.to - EPS) continue;
            for (const part of layer.parts) {
              const ch = part.steps[r % part.steps.length][st];
              if (ch === '.' || ch === undefined) continue;
              push(pos, layer, part.timbre, part.midi, layer.vel * levelAt(layer, pos) * (Number(ch) / 9), 0.3);
            }
          }
        }
        break;
      }
      case 'sparkle': {
        for (let r = Math.floor(layer.from); r < layer.to; r++) {
          const whole = Math.floor(layer.perBar);
          const count = Math.min(8, whole + (hash01(layer.seed, r, 900) < layer.perBar - whole ? 1 : 0));
          const used = new Set<number>();
          for (let k = 0; k < count; k++) {
            // 8分音符の8か所のうち、まだ使っていない所を小節と通し番号から決める
            let slot = Math.floor(hash01(layer.seed, r, k) * 8);
            while (used.has(slot)) slot = (slot + 1) % 8;
            used.add(slot);
            const pos = r + slot / 8;
            if (pos < layer.from - EPS || pos >= layer.to - EPS) continue;
            const cands = touchCandidates(s.key, chordAtBar(s, pos));
            const around = layer.low + hash01(layer.seed, r, k + 100) * (layer.high - layer.low);
            const midi = nearestPitch(cands, around, layer.low, layer.high);
            const soft = 0.55 + 0.45 * hash01(layer.seed, r, k + 200);
            push(pos, layer, layer.timbre, midi, layer.vel * levelAt(layer, pos) * soft, 1.2);
          }
        }
        break;
      }
    }
  });

  out.sort((a, b) => a.t - b.t || LAYER_RANK[a.layer] - LAYER_RANK[b.layer] || a.midi - b.midi || a.velocity - b.velocity);
  return out;
}

const cache = new Map<string, readonly PlannedNote[]>();
function sectionNotes(s: SectionScore): readonly PlannedNote[] {
  const key = s === LOBBY_SCORE ? 'lobby' : `${s.section}:${s.variant ?? ''}`;
  let notes = cache.get(key);
  if (!notes) {
    notes = generate(s);
    cache.set(key, notes);
  }
  return notes;
}

/** notes（t の昇順）の中で、t が from 以上になる最初の位置 */
function lowerBound(notes: readonly PlannedNote[], from: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].t < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 乗車の秒 [t0, t1) に鳴らす音を時刻順に返す。扉は万華鏡（6:00〜8:00）だけを変える。
 * 返す音の物は使い回しの読み取り専用（変更しない）。
 */
export function planNotes(t0: number, t1: number, door: DoorChoice): PlannedNote[] {
  const out: PlannedNote[] = [];
  if (!(t1 > t0)) return out;
  for (const spec of SECTIONS) {
    const s0 = spec.startBar * SEC_PER_BAR;
    const s1 = (spec.startBar + spec.bars) * SEC_PER_BAR;
    if (s1 <= t0 || s0 >= t1) continue;
    const notes = sectionNotes(sectionScore(spec.id, door));
    for (let i = lowerBound(notes, t0); i < notes.length && notes[i].t < t1; i++) out.push(notes[i]);
  }
  return out;
}

/** 入口の音楽の長さ（秒）。この長さで繰り返す */
export const LOBBY_SECONDS = LOBBY_BARS * SEC_PER_BAR;

/**
 * 入口の音楽の予定。t は音楽を始めてからの秒（0 が1回目の頭）で、LOBBY_SECONDS ごとに同じ8小節を繰り返す。
 * 窓の扱いは planNotes と同じ。
 */
export function planLobby(t0: number, t1: number): PlannedNote[] {
  const out: PlannedNote[] = [];
  if (!(t1 > t0)) return out;
  const notes = sectionNotes(LOBBY_SCORE);
  const first = Math.max(0, Math.floor(t0 / LOBBY_SECONDS));
  const last = Math.floor((t1 - EPS) / LOBBY_SECONDS);
  for (let k = first; k <= last; k++) {
    const shift = k * LOBBY_SECONDS;
    for (let i = lowerBound(notes, t0 - shift); i < notes.length && notes[i].t + shift < t1; i++) {
      const n = notes[i];
      out.push(shift === 0 ? n : { ...n, t: n.t + shift });
    }
  }
  return out;
}
