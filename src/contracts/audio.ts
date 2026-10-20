// 音の契約。楽曲は構成データ（JSON）から、その場でガラスの音とシンセサイザーで演奏する。
import type { RideClock } from './clock';
import type { Vec3Tuple } from './events';
import type { DoorChoice, SectionId, TouchKind } from './ids';

/** 一回きりの効果音（UI・遷移・見どころ）。部屋ごとの見どころの音は音の担当が cue から鳴らす */
export type SfxId =
  | 'ui.hover'
  | 'ui.select'
  | 'ui.back'
  | 'lamp' // 待ち列の灯りが一つ灯る
  | 'door.open' // 待ち列の突き当たりの扉
  | 'ticket.punch' // 改札
  | 'gondola.rise' // 水面からゴンドラが浮かぶ
  | 'gondola.close' // 泡の殻が閉じる
  | 'gondola.open' // 泡の殻が開く
  | 'pause'
  | 'resume'
  | 'photo.receive' // 写真の泡が手元に降りてくる
  | 'vr.fog'; // VR へ切り替える霧

export interface Volumes {
  /** 0〜1 */
  readonly master: number;
  readonly music: number;
  readonly sfx: number;
  readonly ambient: number;
}

export interface ListenerPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 頭の向き（ワールド、ラジアン） */
  readonly yaw: number;
  readonly pitch: number;
}

export interface AudioEngine {
  /** 楽曲の再生位置の時計。映像・ゴンドラ・演出はすべてここから時刻を読む */
  readonly clock: RideClock;
  readonly unlocked: boolean;
  /** ユーザー操作の中で呼ぶ（自動再生の規則）。待ち列の「乗り場へ」で呼ぶ */
  unlock(): Promise<void>;
  /** 万華鏡の曲（金と青）を決める。branch.decide より前ならいつ変えてもよい */
  setDoor(door: DoorChoice): void;
  /**
   * 触れた音。その瞬間の和音に含まれる音を、部屋の調の5音から選んで次の8分音符に鳴らす。
   * 同時に鳴る数の上限と、同じ物の0.3秒以内の再発音は間引く。
   * @returns 鳴らす予定の時刻（乗車の秒）。間引いたら null
   */
  touch(e: { readonly id: string; readonly kind: TouchKind; readonly section: SectionId; readonly position: Vec3Tuple }): number | null;
  /** 触れられないままの物が、近づいたときに自分で小さく鳴る */
  chime(e: { readonly id: string; readonly kind: TouchKind; readonly section: SectionId; readonly position: Vec3Tuple }): void;
  /** 見どころの3秒前の誘導音。見るべき方向（ワールド座標）から鳴らす */
  lure(position: Vec3Tuple): void;
  sfx(id: SfxId, position?: Vec3Tuple): void;
  setListener(pose: ListenerPose): void;
  setVolumes(v: Volumes): void;
  /** 入口（乗車外）の音楽。乗車が始まると止める */
  playLobby(): void;
  stopLobby(): void;
  dispose(): void;
}
