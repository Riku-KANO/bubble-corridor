// 画面（DOM）とアプリ本体の境界。UI は状態を読んで表示し、UiCommands を呼ぶだけ。
import type { RideRecord } from './events';
import type { ComfortMode, DoorChoice, Lang, SectionId, ViewMode, XRPosture } from './ids';
import type { PhotoFormat, PhotoRecord } from './photo';

/** 画面の一覧（設計書「画面ごとの設計」） */
export type ScreenId =
  | 'queue' // 待ち列（読み込み）
  | 'home' // 入口
  | 'guide' // 乗車前の案内
  | 'riding' // 乗車中（表示なし）
  | 'pause'
  | 'photo' // ライドフォトと乗車の記録
  | 'shelf' // 写真の棚
  | 'settings'
  | 'howto' // 乗り方（画面 / VR）
  | 'credits';

export type QualitySetting = 'auto' | 'low' | 'medium' | 'high';

/** 設定。変更は即時反映し、localStorage に残す */
export interface Settings {
  readonly lang: Lang;
  readonly quality: QualitySetting;
  /** 見回しの方式。ドラッグで回す / マウスの位置に追従 */
  readonly lookMode: 'drag' | 'follow';
  /** スマートフォンの傾きで見回す（許可制。断られたら false） */
  readonly gyro: boolean;
  /** 視野角（度、60〜90） */
  readonly fov: number;
  /** 見どころの直前に正面へ戻す（PC とスマートフォンだけ。VR では常にしない） */
  readonly autoRecenter: boolean;
  readonly comfort: ComfortMode;
  /** VR の移動中に外周を暗くする強さ（0〜1） */
  readonly vignette: number;
  readonly volumes: { readonly master: number; readonly music: number; readonly sfx: number; readonly ambient: number };
  /** 光の点滅や強い閃光を抑える */
  readonly reducedFlash: boolean;
  /** 文字の大きさ（3段階） */
  readonly textScale: 1 | 1.25 | 1.5;
  /** 見つめて触れるまでの秒 */
  readonly gazeDwellSec: 0.8 | 1.2 | 2.0;
  readonly xrPosture: XRPosture;
}

/** 乗車をまたいで残す記録（localStorage） */
export interface Progress {
  /** これまでに乗った回数。次の便は rideCount + 1 */
  readonly rideCount: number;
  /** 乗車前の案内を見たか（2回目以降は出さない） */
  readonly seenGuide: boolean;
  /** 見つけた小さな泡（乗車をまたいで残る） */
  readonly hiddenFound: readonly SectionId[];
  /** 前回選んだ扉（2周目は違う扉が少し強く光る） */
  readonly lastDoor: DoorChoice | null;
}

export interface UiState {
  readonly screen: ScreenId;
  /** 待ち列の読み込み（0〜1） */
  readonly loadProgress: number;
  readonly settings: Settings;
  readonly progress: Progress;
  /** VR で乗れる端末か */
  readonly xrSupported: boolean;
  /** 端末の傾きの許可を求められる端末か（iOS） */
  readonly gyroNeedsPermission: boolean;
  readonly isMobile: boolean;
  /** 降車後の記録（photo 画面で見せる） */
  readonly record: RideRecord | null;
  /** 直近の乗車の写真（photo 画面）と写真の棚 */
  readonly latestPhoto: PhotoRecord | null;
  readonly shelf: readonly PhotoRecord[];
}

export interface UiCommands {
  /** 待ち列の「乗り場へ」。ここで音を有効にする（ユーザー操作の中で呼ぶ） */
  enterHome(): void;
  /** 入口の「乗る」。mode が vr ならユーザー操作の中で VR のセッションを始める */
  ride(mode: ViewMode): void;
  /** 乗車前の案内を飛ばす */
  skipGuide(): void;
  pause(): void;
  resume(): void;
  /** ポーズの「降りる」。入口へ戻る */
  alight(): void;
  rideAgain(): void;
  toHome(): void;
  open(screen: 'shelf' | 'settings' | 'howto' | 'credits'): void;
  back(): void;
  setSettings(patch: Partial<Settings>): void;
  /** 端末の傾きの許可を求める（iOS ではユーザー操作の中で呼ぶ） */
  requestGyro(): Promise<boolean>;
  savePhoto(record: PhotoRecord, format: PhotoFormat): Promise<void>;
  sharePhoto(record: PhotoRecord, format: PhotoFormat): Promise<void>;
  choosePhoto(record: PhotoRecord, shot: PhotoRecord['chosen']): void;
  deletePhoto(id: string): Promise<void>;
}
