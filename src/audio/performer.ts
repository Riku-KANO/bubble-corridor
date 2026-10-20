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

/** 鳴っている音を覚えておき、ポーズ・シークのときにまとめて止める。同時発音の予算は音源（オシレーター）の数で数える */
export class VoiceSet {
  private list: Voice[] = [];

  get size(): number {
    return this.list.length;
  }

  add(v: Voice): void {
    this.list.push(v);
  }

  /** 鳴り終わった音を忘れる。残っている音源の数を返す */
  prune(now: number): number {
    let j = 0;
    let sources = 0;
    for (const v of this.list) {
      if (v.endsAt > now) {
        this.list[j++] = v;
        sources += v.liveSources(now);
      }
    }
    this.list.length = j;
    return sources;
  }

  releaseAll(when: number): void {
    for (const v of this.list) v.release(when);
    this.list.length = 0;
  }
}

/** 予約がこれ以内の遅れなら、そのまま鳴らす（秒） */
const LATE_OK = 0.08;

/**
 * 同時発音の予算を超えたとき、どの音から見送るか。0 は見送らない（低音、持続音、主旋律）。
 * 数が大きいほど先に見送る: 3 きらめき・小さな分散和音・小さなリズム、2 それ以外の分散和音とリズム・旋律の重ね（鐘・合唱・弦）、
 * 1 持続するグラスハープの和音。
 */
function shedTier(n: PlannedNote, v: number): 0 | 1 | 2 | 3 {
  switch (n.layer) {
    case 'sparkle':
      return 3;
    case 'arpeggio':
    case 'rhythm':
      return v < 0.35 ? 3 : 2;
    case 'melody':
      return n.timbre === 'bell' || isPad(n.timbre) ? 2 : 0;
    case 'drone':
      return n.timbre === 'harp' ? 1 : 0;
    default:
      return 0;
  }
}

/** shedTier ごとに、予算の何倍に達したら見送るか（0 は見送らない） */
const SHED_AT: readonly number[] = [Infinity, 1.4, 1.2, 1];

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
 * budget は同時に鳴らしてよい音源（オシレーターなど）の数の目安。超えたら、きらめきから、さらに超えたら小さな分散和音・
 * リズムも見送る（持続音・旋律・低音は見送らない）。
 */
export function performNotes(
  ctx: BaseAudioContext,
  notes: readonly PlannedNote[],
  destOf: (n: PlannedNote) => AudioNode,
  whenOf: (t: number) => number,
  voices: VoiceSet,
  budget: number,
  minWhen: number,
): void {
  const now = ctx.currentTime;
  let live = voices.prune(now);
  groupCount = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
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
    const v = n.velocity * LAYER_TRIM[n.layer];
    if (live >= budget * SHED_AT[shedTier(n, v)]) continue;
    const voice = playGlass(ctx, destOf(n), n.timbre as GlassTimbre, { midi: n.midi, when, velocity: v, duration: n.duration });
    voices.add(voice);
    live += voice.liveSources(now);
  }
  for (let i = 0; i < groupCount; i++) {
    const n = groupNotes[i];
    const when = Math.max(whenOf(n.t), minWhen);
    const voice = playPad(ctx, destOf(n), n.timbre as PadTimbre, { midis: groupMidis[i], when, duration: n.duration, velocity: n.velocity * LAYER_TRIM[n.layer] });
    voices.add(voice);
  }
}

/** 同時に使う立体音響のパンナーの上限（HRTF は重いので） */
const MAX_PANNERS = 10;

/** 空間に置いた音の出口（HRTF）を作り、鳴り終わったら外す */
export class SpatialPool {
  private live: { node: AudioNode; until: number }[] = [];

  /**
   * position から鳴る出口を作る。上限を超えていたら、方向のない出口（そのままの音）にする。
   * until は出口を外す時刻（AudioContext の秒）。鳴らした音の鳴り終わりが分かったら extend で延ばす。
   */
  create(ctx: BaseAudioContext, position: readonly [number, number, number] | undefined, dry: AudioNode, wet: AudioNode | null, wetLevel: number, until: number): AudioNode {
    this.sweep(ctx.currentTime);
    let node: AudioNode;
    if (!position || this.live.length >= MAX_PANNERS) {
      node = ctx.createGain();
    } else {
      const p = createSpatialPanner(ctx, position);
      // ゴンドラの周り数 m〜十数 m の音を聞かせたいので、距離による減衰は緩やかにする（案2の値。core の既定は変えない）
      p.refDistance = 2;
      p.rolloffFactor = 0.6;
      p.maxDistance = 60;
      node = p;
    }
    node.connect(dry);
    if (wet) {
      const g = ctx.createGain();
      g.gain.value = wetLevel;
      node.connect(g).connect(wet);
    }
    this.live.push({ node, until });
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
      if (e.until < now) e.node.disconnect();
      else this.live[j++] = e;
    }
    this.live.length = j;
  }

  dispose(): void {
    for (const e of this.live) e.node.disconnect();
    this.live.length = 0;
  }
}
