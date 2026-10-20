// 演奏する人。予定の音（PlannedNote）を、ガラスの音源とシンセサイザーで実際に鳴らす。
import { playGlass, playPad } from '../core/sound/voices';
import type { GlassTimbre, PadTimbre, Voice } from '../core/sound/voices';
import { createSpatialPanner } from '../core/sound/space';
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

/** 鳴っている音を覚えておき、ポーズ・シークのときにまとめて止める */
export class VoiceSet {
  private list: Voice[] = [];

  get size(): number {
    return this.list.length;
  }

  add(v: Voice): void {
    this.list.push(v);
  }

  /** 鳴り終わった音を忘れる。残っている数を返す */
  prune(now: number): number {
    let j = 0;
    for (const v of this.list) if (v.endsAt > now) this.list[j++] = v;
    this.list.length = j;
    return j;
  }

  releaseAll(when: number): void {
    for (const v of this.list) v.release(when);
    this.list.length = 0;
  }
}

/** 予約がこれ以内の遅れなら、そのまま鳴らす（秒） */
const LATE_OK = 0.08;

/** 同じ時刻・同じ層・同じ音色・同じ長さの持続音は、1つの和音としてまとめて鳴らす */
interface Group {
  readonly note: PlannedNote;
  readonly midis: number[];
}

/**
 * 予定の音を鳴らす。destOf は音の区間に合った出力先（区間ごとの残響の経路）、whenOf は乗車の秒 → AudioContext の秒。
 * budget は同時に鳴らしてよい音の数の目安。超えたら、きらめきと分散和音のうち小さい音から見送る。
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
  const groups = new Map<string, Group>();
  const now = ctx.currentTime;
  const live = voices.prune(now);
  let over = live - budget;
  for (const n of notes) {
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
    const v = n.velocity * LAYER_TRIM[n.layer];
    if (isPad(n.timbre)) {
      const key = `${n.t}|${n.layer}|${n.timbre}|${n.duration}`;
      const g = groups.get(key);
      if (g) g.midis.push(n.midi);
      else groups.set(key, { note: n, midis: [n.midi] });
      continue;
    }
    if (over > 0 && (n.layer === 'sparkle' || n.layer === 'arpeggio') && v < 0.35) {
      over--;
      continue;
    }
    voices.add(playGlass(ctx, destOf(n), n.timbre as GlassTimbre, { midi: n.midi, when, velocity: v, duration: n.duration }));
  }
  for (const g of groups.values()) {
    const n = g.note;
    const when = Math.max(whenOf(n.t), minWhen);
    voices.add(playPad(ctx, destOf(n), n.timbre as PadTimbre, { midis: g.midis, when, duration: n.duration, velocity: n.velocity * LAYER_TRIM[n.layer] }));
  }
}

/** 同時に使う立体音響のパンナーの上限（HRTF は重いので） */
const MAX_PANNERS = 10;

/** 空間に置いた音の出口（HRTF）を作り、鳴り終わったら外す */
export class SpatialPool {
  private live: { node: PannerNode; until: number }[] = [];

  /** position から鳴る出口を作る。上限を超えていたら、方向のない出口（そのままの音）にする */
  create(ctx: BaseAudioContext, position: readonly [number, number, number] | undefined, dry: AudioNode, wet: AudioNode | null, wetLevel: number, until: number): AudioNode {
    this.sweep(ctx.currentTime);
    if (!position || this.live.length >= MAX_PANNERS) {
      const g = ctx.createGain();
      g.connect(dry);
      if (wet) g.connect(wetSend(ctx, wet, wetLevel));
      return g;
    }
    const p = createSpatialPanner(ctx, position);
    p.connect(dry);
    if (wet) p.connect(wetSend(ctx, wet, wetLevel));
    this.live.push({ node: p, until });
    return p;
  }

  /** 鳴り終えたパンナーを外す */
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

function wetSend(ctx: BaseAudioContext, wet: AudioNode, level: number): AudioNode {
  const g = ctx.createGain();
  g.gain.value = level;
  g.connect(wet);
  return g;
}
