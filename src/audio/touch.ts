// 触れた音。誰がどう触れても演奏になるよう、次の8分音符の格子に、その瞬間の和音と調の5音の共通部分から鳴らす。
// うるさくならないよう、同時に鳴る数と同じ物の再発音に上限を設ける（gate）。
import type { DoorChoice, SectionId, TouchKind } from '../contracts/ids';
import { INTERACTION, SEC_PER_BEAT, TOUCH_GRID_BEATS, BPM } from '../config';
import { nextGridTime } from '../core/sound/grid';
import { nearestPitch, touchCandidates } from '../core/sound/scale';
import type { GlassTimbre } from '../core/sound/voices';
import { hash01 } from './conductor';
import { touchDuckAt } from './cues';
import { harmonyAt } from './score';
import type { Harmony } from './score';

export interface TouchNote {
  /** 鳴らす時刻（乗車の秒）。8分音符の格子の上 */
  readonly at: number;
  readonly midi: number;
  readonly velocity: number;
  readonly timbre: GlassTimbre;
  /** 鳴っている長さの目安（秒）。同時発音の数え方に使う */
  readonly duration: number;
}

/** 格子点まで最低これだけ残す（秒）。音の予約が間に合うように */
export const TOUCH_MIN_LEAD = 0.03;
/** MIDI の範囲（設計書の触れた音の音域） */
export const TOUCH_LOW = 48;
export const TOUCH_HIGH = 100;

interface Profile {
  readonly timbre: GlassTimbre;
  /** 音の高さの中心と、そこから上下に散らす幅（半音） */
  readonly center: number;
  readonly spread: number;
  readonly velocity: number;
  readonly duration: number;
}

/** 触れた物の種類ごとの音（設計書「楽曲の構成」の「触れた音」の列） */
const PROFILE: Readonly<Record<TouchKind, Profile>> = {
  'hanging-bubble': { timbre: 'bowl', center: 55, spread: 5, velocity: 0.75, duration: 3 }, // 吊られた泡の低い音
  leaf: { timbre: 'drop', center: 86, spread: 7, velocity: 0.7, duration: 0.7 }, // 露の高い音
  bud: { timbre: 'chime', center: 79, spread: 6, velocity: 0.65, duration: 1.4 },
  raindrop: { timbre: 'bell', center: 82, spread: 7, velocity: 0.6, duration: 2.2 }, // 雨粒の澄んだ音
  door: { timbre: 'bell', center: 67, spread: 4, velocity: 0.8, duration: 2.5 },
  shard: { timbre: 'bottle', center: 74, spread: 8, velocity: 0.7, duration: 1 }, // ガラス片の音
  star: { timbre: 'harp', center: 88, spread: 7, velocity: 0.6, duration: 2.4 }, // 星の音
  water: { timbre: 'drop', center: 67, spread: 5, velocity: 0.6, duration: 1.2 }, // 水面の柔らかい音
  'hidden-bubble': { timbre: 'bell', center: 76, spread: 3, velocity: 0.8, duration: 3.5 },
};

const GRID_SEC = SEC_PER_BEAT * TOUCH_GRID_BEATS;

/**
 * 触れた物の音を決める。now は乗車の秒（触れた瞬間）。
 * 時刻は now 以降で最も近い8分音符（余裕 TOUCH_MIN_LEAD）、高さはその時刻の和音と調の5音の共通部分。
 * 区間は音色の選び方に使い、和音と調は鳴らす時刻のものを使う（小節の境目をまたいでも合う）。
 */
export function planTouch(
  e: { readonly kind: TouchKind; readonly section: SectionId },
  now: number,
  door: DoorChoice,
  harmony: (t: number) => Harmony = (t) => harmonyAt(t, door),
): TouchNote {
  const profile = PROFILE[e.kind];
  const at = nextGridTime(now, 0, BPM, TOUCH_GRID_BEATS, TOUCH_MIN_LEAD);
  const h = harmony(at);
  const cands = touchCandidates(h.key, h.chord);
  // 同じ格子では同じ音になる。違う格子では中心の上下に散らして、旋律のように聞こえるようにする
  const slot = Math.round(at / GRID_SEC);
  const around = profile.center + (hash01(slot, kindCode(e.kind), 3) * 2 - 1) * profile.spread;
  const midi = nearestPitch(cands, around, TOUCH_LOW, TOUCH_HIGH);
  // 見どころの数秒間は控えめにして重ねる（設計書「応え方のルール」4）
  const velocity = Math.min(1, profile.velocity * (0.9 + 0.1 * hash01(slot, kindCode(e.kind), 5)) * touchDuckAt(at));
  return { at, midi, velocity, timbre: profile.timbre, duration: profile.duration };
}

/** 隠れた小さな泡: 同じ時刻に3音以上、すべてその瞬間の和音と調の5音の共通部分から選んだ特別な和音 */
/** 区間ごとの違いは調と和音そのものが作るので、section は音の選び方には使わない */
export function planHiddenChord(_section: SectionId, now: number, door: DoorChoice, harmony: (t: number) => Harmony = (t) => harmonyAt(t, door)): TouchNote[] {
  const profile = PROFILE['hidden-bubble'];
  const at = nextGridTime(now, 0, BPM, TOUCH_GRID_BEATS, TOUCH_MIN_LEAD);
  const h = harmony(at);
  const cands = touchCandidates(h.key, h.chord);
  const pool: number[] = [];
  for (let m = 60; m <= 96; m++) if (cands.includes(((m % 12) + 12) % 12)) pool.push(m);
  // 広がりのある和音にするため、候補が多ければ1つおきに4音を取る
  const stride = pool.length >= 8 ? 2 : 1;
  const start = Math.floor(hash01(Math.round(at / GRID_SEC), 17) * Math.max(1, pool.length - 4 * stride));
  const notes: TouchNote[] = [];
  for (let i = 0; i < 4; i++) {
    const midi = pool[Math.min(pool.length - 1, start + i * stride)];
    if (notes.some((n) => n.midi === midi)) continue;
    // 下の2音は持続するグラスハープ、上の2音は鐘。ふつうの触れた音より少し大きく長く
    notes.push({ at, midi, velocity: profile.velocity * Math.sqrt(touchDuckAt(at)), timbre: i < 2 ? 'harp' : 'bell', duration: profile.duration });
  }
  return notes;
}

function kindCode(kind: TouchKind): number {
  return Object.keys(PROFILE).indexOf(kind) + 1;
}

export interface TouchGate {
  /**
   * 音を鳴らしてよければ true を返して数え始める。
   * at は鳴らす時刻、duration はその音が「鳴っている」と数える長さ（実際の音の減衰の長さではない）。
   * 同時に鳴る数の上限と、同じ物の再発音の間隔を守る。limit を渡すと、その場だけ上限をそれ以下に絞る
   * （見どころの数秒間に、触れた音を重ねすぎない）。
   */
  tryAcquire(id: string, at: number, duration: number, limit?: number): boolean;
  /** at の時点で鳴っていると数えている音の数（ほかの種類の音が枠を譲る判断に使う） */
  busy(at: number): number;
}

export function createTouchGate(opts: { readonly maxVoices?: number; readonly retriggerSec?: number } = {}): TouchGate {
  const maxVoices = opts.maxVoices ?? INTERACTION.maxTouchVoices;
  const retrigger = opts.retriggerSec ?? INTERACTION.retriggerSec;
  /** 鳴っている音の終わる時刻 */
  const live: number[] = [];
  const last = new Map<string, number>();
  const sweep = (at: number) => {
    for (let i = live.length - 1; i >= 0; i--) if (live[i] <= at) live.splice(i, 1);
  };
  return {
    tryAcquire(id, at, duration, limit = maxVoices) {
      sweep(at);
      if (live.length >= Math.min(maxVoices, limit)) return false;
      const prev = last.get(id);
      if (prev !== undefined && Math.abs(at - prev) < retrigger) return false;
      if (last.size > 256) for (const [k, v] of last) if (at - v > retrigger * 4) last.delete(k);
      live.push(at + duration);
      last.set(id, at);
      return true;
    },
    busy(at) {
      sweep(at);
      return live.length;
    },
  };
}
