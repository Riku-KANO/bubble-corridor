// 部屋（セット）の契約。各部屋の担当は src/rooms/<部屋>/ で RoomModule を実装する。
import type { Camera, ColorRepresentation, Object3D, Texture } from 'three';
import type { QualityPreset } from '../core/quality';
import type { Cue, EventBus, Vec3Tuple } from './events';
import type { ComfortMode, DoorChoice, RoomId, SectionId, TouchKind, TouchSource } from './ids';
import type { Ride, RidePose } from './ride';

/** 触れられる物。光線（画面・コントローラー）または指先との距離（VR）で触れる */
export interface Touchable {
  /** 乗車の中で一意（例: "greenhouse/leaf-12"） */
  readonly id: string;
  readonly kind: TouchKind;
  readonly section: SectionId;
  /** 光線の交差判定に使う物体。見た目の物と同じでよい（子も判定する） */
  readonly object: Object3D;
  /** VR の指先との距離判定に使う、物の中心からの半径（m） */
  readonly radius: number;
  /** false のあいだは光らず、触れても反応しない（例: まだ現れていない扉） */
  enabled: boolean;
  /** 近づいたときの縁の光の強さ（0〜1）。部屋が見た目に反映する */
  setHighlight(level: number): void;
  /**
   * 触れられた。0.1秒以内に光と動きで応える（応え方のルール1）。
   * 見どころの演出中でも演出を止めず、控えめな反応を重ねる（ルール4）。
   */
  onTouch(e: TouchContext): void;
  /** 触れられないまま近づいたら自分で小さく鳴る物か（ルール5） */
  readonly idleChime?: boolean;
}

export interface TouchContext {
  /** 乗車の頭からの秒 */
  readonly t: number;
  readonly source: TouchSource;
  /** 触れた点（ワールド座標）。光線なら交点、VR なら指先 */
  readonly point: Vec3Tuple;
}

/** 部屋の空気（背景の色、霧、露出、反射用の環境画像）。膜を通るときに統合担当が切り替える */
export interface Atmosphere {
  readonly background: ColorRepresentation;
  readonly fog?: { readonly color: ColorRepresentation; readonly near: number; readonly far: number };
  /** トーンマッピングの露出 */
  readonly exposure: number;
  readonly environment?: Texture | null;
}

export interface RoomContext {
  readonly ride: Ride;
  readonly events: EventBus;
  readonly quality: QualityPreset;
  /** 現在の快適モード（穏やかでは万華鏡の模様の回転を止める） */
  comfort(): ComfortMode;
  /** 光の点滅や強い閃光を抑えるモード */
  reducedFlash(): boolean;
  /** 2周目の誘い: 前回と違う扉（初回は null） */
  readonly suggestedDoor: DoorChoice | null;
  /** 隠れた小さな泡を、前の乗車までに見つけているか（見た目は変えないが、和音を変えてもよい） */
  readonly hiddenAlreadyFound: boolean;
}

/** 毎フレーム部屋に渡すもの */
export interface RoomFrame {
  /** 乗車の頭からの秒 */
  readonly t: number;
  /** 前のフレームからの秒（ポーズ中は 0） */
  readonly dt: number;
  readonly pose: RidePose;
  readonly camera: Camera;
  readonly comfort: ComfortMode;
  readonly reducedFlash: boolean;
}

export interface RoomModule {
  readonly id: RoomId;
  /** この部屋のすべての物。統合担当がシーンに足し、外す */
  readonly root: Object3D;
  readonly touchables: readonly Touchable[];
  readonly atmosphere: Atmosphere;
  /**
   * 形と材質を作る。重い処理はここで行う（前の部屋の途中で呼ばれ、膜に着くまでに終える）。
   * 形はコードで作る（Blender の glb に置き換えるまでの仮。ADR-0002）。
   */
  load(ctx: RoomContext): Promise<void>;
  /** 毎フレーム。この部屋が見えているあいだ（前後の膜の近くを含む）呼ばれる */
  update(frame: RoomFrame): void;
  /** キューシートの出来事（この部屋の区間のもの、と membrane・photo.capture を含むすべて） */
  onCue(cue: Cue): void;
  /**
   * 見どころの位置（ワールド座標）。誘導の音と光の粒、正面へ戻すカメラの向きに使う。
   * この部屋の見どころでなければ null。
   */
  focusPoint(name: Cue['name']): Vec3Tuple | null;
  /** 扉の選択（万華鏡の金と青、雨の回廊の扉の見た目） */
  setDoor?(door: DoorChoice): void;
  /** GPU の資源を解放する（2つ前の部屋は解放する） */
  dispose(): void;
}

/** 部屋を作る関数。src/rooms/index.ts の一覧に登録する */
export type RoomFactory = () => RoomModule;
