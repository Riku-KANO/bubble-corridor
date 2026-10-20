// ガラスの音源。案1と共有する。
// 設計書ではガラスの実録音（ワイングラス、ガラス瓶、風鈴、ガラスの器）を音程ごとに揃えるが、
// 録音が揃うまでは Web Audio の合成で作る（ADR-0003）。音色の名前と引数は録音に差し替えても変えない。
// STUB: 署名は確定。中身は audio 担当が本実装に置き換える。

export type GlassTimbre =
  | 'harp' // グラスハープ（ワイングラスを擦った音。持続する）
  | 'bell' // ガラスの鐘
  | 'chime' // 風鈴
  | 'bottle' // ガラス瓶のマリンバ風の音
  | 'drop' // 露・雨粒の落ちる音
  | 'bowl' // ガラスの器（低く長い）
  | 'tap'; // ガラスを叩いた打楽器

export type PadTimbre = 'strings' | 'choir' | 'warm' | 'air';

export interface NoteParams {
  /** MIDI ノート番号 */
  readonly midi: number;
  /** 鳴らし始める時刻（AudioContext の秒） */
  readonly when: number;
  /** 0〜1 */
  readonly velocity: number;
  /** 持続する音色の長さ（秒）。減衰する音色では無視してよい */
  readonly duration?: number;
}

export interface Voice {
  /** 鳴り終わる時刻（AudioContext の秒） */
  readonly endsAt: number;
  /** 早めに止める（滑らかに消す） */
  release(when: number): void;
}

export function playGlass(_ctx: BaseAudioContext, _dest: AudioNode, _timbre: GlassTimbre, p: NoteParams): Voice {
  // STUB
  return { endsAt: p.when, release() {} };
}

export function playPad(
  _ctx: BaseAudioContext,
  _dest: AudioNode,
  _timbre: PadTimbre,
  p: { readonly midis: readonly number[]; readonly when: number; readonly duration: number; readonly velocity: number; readonly attack?: number; readonly release?: number },
): Voice {
  // STUB
  return { endsAt: p.when + p.duration, release() {} };
}

/** 雨・波・風などの環境音の元になる雑音（決定的な乱数で作る） */
export function noiseBuffer(ctx: BaseAudioContext, seconds: number, _seed = 1): AudioBuffer {
  return ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate); // STUB
}
