// キューシートの出来事と、担当をまたぐイベント。
import type { DoorChoice, SectionId, ShotId, TouchKind, TouchSource } from './ids';

/** [x, y, z]（ワールド座標、m） */
export type Vec3Tuple = readonly [number, number, number];

/**
 * キューシートの出来事の名前。時刻は構成データの小節から計算する（src/ride の cues）。
 * Blender のタイムラインマーカーから書き出す場合も、マーカーの名前をこの名前にする。
 */
export type CueName =
  | 'ride.start' // 0:00 乗車の開始（泡の殻が閉じ終わった時点）
  | 'hint.touch' // 0:20 「触れると、鳴ります」
  | 'membrane' // 部屋の境目の膜を通る瞬間（data.to に次の区間）
  | 'lure' // 見どころの3秒前の誘導（data.target に見どころの名前）
  | 'greenhouse.bloom' // 2:40 ガラスの花が開く
  | 'greenhouse.dewfall' // 花の直後に露が一斉に落ちる
  | 'rain.freeze' // 5:10 雨粒が止まる
  | 'rain.doors' // 5:50 扉が現れる
  | 'branch.decide' // 万華鏡の膜の手前で扉を確定する
  | 'kaleidoscope.flower' // 7:20 巨大な花の模様
  | 'celestial.blackout' // 8:00 2秒間の暗闇
  | 'celestial.stars' // 暗闇の後、星が一つずつ灯り始める
  | 'celestial.constellation' // 9:50 星がつながりガラスの街を描く
  | 'dawn.sunrise' // 11:50 朝日が昇る
  | 'departure.open' // 12:30 泡の殻が開き始める
  | 'photo.capture' // 撮影（data.shot）
  | 'ride.end'; // 13:00 乗車の終わり → ライドフォトへ

/** CueName の一覧（実行時に検査するため。Blender の書き出しもこの一覧と揃える） */
export const CUE_NAMES: readonly CueName[] = [
  'ride.start',
  'hint.touch',
  'membrane',
  'lure',
  'greenhouse.bloom',
  'greenhouse.dewfall',
  'rain.freeze',
  'rain.doors',
  'branch.decide',
  'kaleidoscope.flower',
  'celestial.blackout',
  'celestial.stars',
  'celestial.constellation',
  'dawn.sunrise',
  'departure.open',
  'photo.capture',
  'ride.end',
];

export interface Cue {
  /** 一覧の中で一意（例: "greenhouse.bloom@48"） */
  readonly id: string;
  readonly name: CueName;
  /** 乗車の頭からの秒 */
  readonly t: number;
  /** 乗車の頭からの通しの小節（小数を許す。誘導は小節の頭に乗らない） */
  readonly bar: number;
  /** この出来事が属する区間 */
  readonly section: SectionId;
  readonly data?: {
    readonly to?: SectionId;
    readonly target?: CueName;
    readonly shot?: ShotId;
  };
}

/** 乗車の記録（降車後に見せる。点数や順位はつけない） */
export interface RideRecord {
  /** 何便目か（入口の切符に刻む） */
  readonly rideNo: number;
  /** 乗車した日（YYYY-MM-DD、端末の時刻） */
  readonly date: string;
  readonly touches: number;
  readonly door: DoorChoice;
  readonly constellations: number;
  /** 見つけた小さな泡の区間（この乗車で見つけた分） */
  readonly hiddenFound: readonly SectionId[];
}

/** 担当をまたぐイベントの型の一覧（EventBus のキー → 中身） */
export interface RideEvents {
  cue: Cue;
  touch: {
    readonly touchableId: string;
    readonly kind: TouchKind;
    readonly section: SectionId;
    readonly position: Vec3Tuple;
    readonly source: TouchSource;
    /** 乗車の頭からの秒 */
    readonly t: number;
  };
  doorChosen: { readonly door: DoorChoice; readonly by: 'touch' | 'gaze' | 'default' };
  hiddenFound: { readonly section: SectionId };
  constellationLinked: { readonly fromId: string; readonly toId: string };
  photoCaptured: { readonly shot: ShotId };
  pause: Record<string, never>;
  resume: Record<string, never>;
  rideEnd: RideRecord;
}

export type Unsubscribe = () => void;

export interface EventBus<E = RideEvents> {
  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): Unsubscribe;
  emit<K extends keyof E>(type: K, payload: E[K]): void;
}
