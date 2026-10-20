// 演奏する人。予定の音（PlannedNote）を、ガラスの音源とシンセサイザーで実際に鳴らす。
import { createSpatialPanner } from '../core/sound/space';
import { playGlass, playPad } from '../core/sound/voices';
import type { GlassTimbre, PadTimbre, Voice } from '../core/sound/voices';
import type { PlannedNote } from './conductor';
import type { LayerKind } from './score';

const PADS: ReadonlySet<string> = new Set<PadTimbre>(['strings', 'choir', 'warm', 'air']);

export function isPad(timbre: string): timbre is PadTimbre {
  return PADS.has(timbre);
}

/** 層ごとの音量の調整（音色の大きさの違いをならす）。確認ページで測って決めた */
export const LAYER_TRIM: Readonly<Record<LayerKind, number>> = {
  drone: 1,
  bass: 1,
  arpeggio: 1,
  melody: 1,
  rhythm: 1,
  sparkle: 1,
};

/** 鳴っている音を覚えておき、ポーズ・シークのときにまとめて止める。同時発音の数え方は budget.ts */
export class VoiceSet {
  private list: Voice[] = [];

  get size(): number {
    return this.list.length;
  }

  add(v: Voice): void {
    this.list.push(v);
  }

  /** 鳴り終わった音を忘れる。残っている音の数を返す */
  prune(now: number): number {
    let j = 0;
    for (let i = 0; i < this.list.length; i++) if (this.list[i].endsAt > now) this.list[j++] = this.list[i];
    this.list.length = j;
    return j;
  }

  /** at（AudioContext の秒）に鳴っている音源の数（まだ始まっていない音源は数えない） */
  liveAt(at: number): number {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) n += this.list[i].liveSources(at);
    return n;
  }

  /** いまの音の並びの写し（予算の試算で、予約を試して捨てるために使う） */
  clone(): VoiceSet {
    const c = new VoiceSet();
    c.list = this.list.slice();
    return c;
  }

  releaseAll(when: number): void {
    for (const v of this.list) v.release(when);
    this.list.length = 0;
  }
}

/** 予約がこれ以内の遅れなら、そのまま鳴らす（秒） */
const LATE_OK = 0.08;

/**
 * 同時発音の予算を超える楽句で、どの音を残すか（budget.ts が4小節の楽句ごとに level を決める）。
 * 間引きは小節の中の位置と層で決まるので、1音ずつ散らばらず、規則的に薄くなる:
 *   1 きらめきを止める
 *   2 さらに、分散和音は1つおき、リズムは強拍（4分音符の位置）だけ
 *   3 さらに、分散和音は4つに1つ、リズムは2拍に1つ、旋律の重ね（鐘・合唱・弦）と持続するグラスハープを止める
 * 低音・持続音（弦・合唱・温かい音・息）・主旋律は、どの level でも残す。
 */
export function keepNote(level: number, n: PlannedNote): boolean {
  if (level <= 0) return true;
  switch (n.layer) {
    case 'sparkle':
      return false;
    case 'arpeggio':
      return level === 1 || n.step % (level === 2 ? 2 : 4) === 0;
    case 'rhythm':
      return level === 1 || n.step % (level === 2 ? 4 : 8) === 0;
    case 'melody':
      return level < 3 || !(n.timbre === 'bell' || isPad(n.timbre));
    case 'drone':
      return level < 3 || n.timbre !== 'harp';
    default:
      return true;
  }
}

/** 楽句ごとの間引きの level（budget.ts が作る）。時刻から決まる */
export interface ShedPolicy {
  levelAt(t: number): number;
}

// 同じ時刻・同じ層・同じ音色・同じ長さの持続音は、1つの和音としてまとめて鳴らす。
// 毎回の先読みで配列や Map を作らないよう、作業用の入れ物を使い回す
const groupNotes: PlannedNote[] = [];
const groupMidis: number[][] = [];
let groupCount = 0;

function addToGroup(n: PlannedNote): void {
  for (let i = 0; i < groupCount; i++) {
    const g = groupNotes[i];
    if (g.t === n.t && g.layer === n.layer && g.timbre === n.timbre && g.duration === n.duration) {
      groupMidis[i].push(n.midi);
      return;
    }
  }
  groupNotes[groupCount] = n;
  if (!groupMidis[groupCount]) groupMidis[groupCount] = [];
  const m = groupMidis[groupCount];
  m.length = 0;
  m.push(n.midi);
  groupCount++;
}

/**
 * 予定の音を鳴らす。destOf は音の区間に合った出力先（区間ごとの残響の経路）、whenOf は乗車の秒 → AudioContext の秒。
 * shed があれば、その時刻の楽句の level で音を間引く（同時発音の予算を超える楽句。null なら間引かない）。
 */
export function performNotes(
  ctx: BaseAudioContext,
  notes: readonly PlannedNote[],
  destOf: (n: PlannedNote) => AudioNode,
  whenOf: (t: number) => number,
  voices: VoiceSet,
  shed: ShedPolicy | null,
  minWhen: number,
): void {
  voices.prune(ctx.currentTime);
  groupCount = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (shed !== null && !keepNote(shed.levelAt(n.t), n)) continue;
    let when = whenOf(n.t);
    if (when < minWhen) {
      if (minWhen - when <= LATE_OK) {
        // 始めた直後の頭の音など、わずかな遅れはそのまま鳴らす（見送ると頭が欠ける）
        when = minWhen;
      } else if ((isPad(n.timbre) || n.timbre === 'harp') && when + n.duration >= minWhen + 0.5) {
        // 大きく遅れた。持続音は今から鳴らし、短い音は見送る
        when = minWhen;
      } else {
        continue;
      }
    }
    if (isPad(n.timbre)) {
      addToGroup(n);
      continue;
    }
    voices.add(playGlass(ctx, destOf(n), n.timbre as GlassTimbre, { midi: n.midi, when, velocity: n.velocity * LAYER_TRIM[n.layer], duration: n.duration }));
  }
  for (let i = 0; i < groupCount; i++) {
    const n = groupNotes[i];
    const when = Math.max(whenOf(n.t), minWhen);
    voices.add(playPad(ctx, destOf(n), n.timbre as PadTimbre, { midis: groupMidis[i], when, duration: n.duration, velocity: n.velocity * LAYER_TRIM[n.layer] }));
  }
}

/** 同時に使う頭部伝達関数（HRTF）のパンナーの上限（HRTF は重いので） */
const MAX_PANNERS = 10;
/** 触れた音や効果音は、このぶんの HRTF の枠を誘導音のために空けておく（枠が溢れたら、軽い equalpower の左右の定位にする） */
const LURE_RESERVE = 2;

/** 空間に置いた音の出口を作り、鳴り終わったら外す */
export class SpatialPool {
  private live: { node: AudioNode; until: number; hrtf: boolean }[] = [];
  private hrtfCount = 0;

  /**
   * position から鳴る出口を作る。通常は HRTF（頭部伝達関数）で方向と前後上下が分かるが、枠（MAX_PANNERS）が溢れたら
   * equalpower（左右の定位だけ。軽い）にする。誘導音（lure）は、そのための枠を最後まで使える。
   * until は出口を外す時刻（AudioContext の秒）。鳴らした音の鳴り終わりが分かったら extend で延ばす。
   */
  create(ctx: BaseAudioContext, position: readonly [number, number, number] | undefined, dry: AudioNode, wet: AudioNode | null, wetLevel: number, until: number, lure = false): AudioNode {
    this.sweep(ctx.currentTime);
    let node: AudioNode;
    let hrtf = false;
    if (!position) {
      node = ctx.createGain();
    } else {
      const p = createSpatialPanner(ctx, position);
      // ゴンドラの周り数 m〜十数 m の音を聞かせたいので、距離による減衰は緩やかにする（案2の値。core の既定は変えない）
      p.refDistance = 2;
      p.rolloffFactor = 0.6;
      p.maxDistance = 60;
      hrtf = this.hrtfCount < MAX_PANNERS - (lure ? 0 : LURE_RESERVE);
      if (!hrtf) p.panningModel = 'equalpower';
      node = p;
    }
    node.connect(dry);
    if (wet) {
      const g = ctx.createGain();
      g.gain.value = wetLevel;
      node.connect(g).connect(wet);
    }
    if (hrtf) this.hrtfCount++;
    this.live.push({ node, until, hrtf });
    return node;
  }

  /** node を until まで外さない（鳴らした音の本当の鳴り終わりまで）。短くはしない */
  extend(node: AudioNode, until: number): void {
    for (const e of this.live) {
      if (e.node === node) {
        if (until > e.until) e.until = until;
        return;
      }
    }
  }

  /** 鳴り終えた出口を外す */
  sweep(now: number): void {
    let j = 0;
    for (const e of this.live) {
      if (e.until < now) {
        e.node.disconnect();
        if (e.hrtf) this.hrtfCount--;
      } else {
        this.live[j++] = e;
      }
    }
    this.live.length = j;
  }

  dispose(): void {
    for (const e of this.live) e.node.disconnect();
    this.live.length = 0;
    this.hrtfCount = 0;
  }
}
