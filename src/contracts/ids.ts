// 担当をまたいで使う名前の集まり。変えるときは統合担当と調整する（AGENTS.md「契約」）。

/** 乗車の7区間（設計書「体験の流れ」） */
export type SectionId = 'platform' | 'greenhouse' | 'rain' | 'kaleidoscope' | 'celestial' | 'dawn' | 'departure';

export const SECTION_IDS: readonly SectionId[] = [
  'platform',
  'greenhouse',
  'rain',
  'kaleidoscope',
  'celestial',
  'dawn',
  'departure',
];

/**
 * 3D の部屋（セット）。区間とほぼ1対1だが、乗り場と降車は同じホールを光だけ変えて使い、
 * 待ち列と入口（ホーム画面の背景）は lobby として持つ。
 */
export type RoomId = 'lobby' | 'platform' | 'greenhouse' | 'rain' | 'kaleidoscope' | 'celestial' | 'dawn';

/** 区間 → その区間で使う部屋 */
export const ROOM_OF_SECTION: Readonly<Record<SectionId, RoomId>> = {
  platform: 'platform',
  greenhouse: 'greenhouse',
  rain: 'rain',
  kaleidoscope: 'kaleidoscope',
  celestial: 'celestial',
  dawn: 'dawn',
  departure: 'platform',
};

/** 雨の回廊の終わりの扉。琥珀 → 金の万華鏡、瑠璃 → 青の万華鏡。何もしなければ瑠璃 */
export type DoorChoice = 'amber' | 'lapis';
export const DEFAULT_DOOR: DoorChoice = 'lapis';

/** 自動撮影の3か所 */
export type ShotId = 'bloom' | 'freeze' | 'constellation';

/** 快適モード。穏やかでは上下の動きと向きの回転を半分にし、万華鏡の模様の回転を止める */
export type ComfortMode = 'standard' | 'gentle';

export type Lang = 'ja' | 'en';

/** 画面で乗るか、VR で乗るか */
export type ViewMode = 'screen' | 'vr';

/** VR の乗り方 */
export type XRPosture = 'seated' | 'standing';

/**
 * 触れられる物の種類。音色と反応の選び方に使う。
 * 部屋の担当が増やすときは、音の担当（src/audio）にも伝える。
 */
export type TouchKind =
  | 'hanging-bubble' // 乗り場の吊られた泡
  | 'leaf' // 温室の葉（露が落ちて鳴る）
  | 'bud' // 温室の蕾（少し早く咲く）
  | 'raindrop' // 止まった雨粒（弾けて虹色の輪）
  | 'door' // 琥珀と瑠璃の扉
  | 'shard' // 万華鏡のガラス片
  | 'star' // 天球の星
  | 'water' // 夜明けの水面
  | 'hidden-bubble'; // 隠れた小さな泡（特別な和音）

/** 入力の出どころ */
export type TouchSource = 'pointer' | 'gaze' | 'xr';
