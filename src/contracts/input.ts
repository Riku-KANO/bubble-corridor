// 見回すと触れる（PC とスマートフォン）。VR の入力は src/xr が受け持つ。
import type { Camera } from 'three';
import type { EventBus, Vec3Tuple } from './events';
import type { Touchable } from './room';

/** 見回しの向き。ゴンドラの正面からの相対（ラジアン）。範囲は左右±120度、上下±60度 */
export interface LookState {
  yaw: number;
  pitch: number;
}

export interface LookOptions {
  readonly mode: 'drag' | 'follow';
  readonly gyro: boolean;
  /** 設定の視野角（度）。ドラッグの感度を景色に合わせるのに使う。省略時は CAMERA.fovDeg */
  readonly fovDeg?: number;
}

/** 見回しの入力。カメラはゴンドラの座席に固定し、向きだけを変える */
export interface LookControl {
  readonly look: Readonly<LookState>;
  setOptions(o: LookOptions): void;
  /** 見どころの直前に、正面（または見どころの方向）へやさしく戻す。VR では呼ばない */
  recenter(toward?: { readonly yaw: number; readonly pitch: number }, durationSec?: number): void;
  /** 毎フレーム。dt 秒 */
  update(dt: number): void;
  setEnabled(on: boolean): void;
  dispose(): void;
}

/** 触れる入力（クリック・タップ・見つめる）。触れられる物との交差判定と、反応の間引きを受け持つ */
export interface TouchInput {
  /** いま触れられる物（部屋の切り替えで統合担当が差し替える） */
  setTouchables(list: readonly Touchable[]): void;
  /** 見つめて触れるまでの秒 */
  setGazeDwell(sec: number): void;
  /**
   * 毎フレーム。t は乗車の秒。ゴンドラの位置からの距離で縁を光らせ、
   * 見つめ続けた物に触れ、近づいた物が自分で鳴る合図（onIdleChime）を出す。
   */
  update(t: number, dt: number, camera: Camera, gondola: Vec3Tuple): void;
  /** 触れられないまま近づいた物（一度だけ） */
  onIdleChime(fn: (t: Touchable) => void): void;
  setEnabled(on: boolean): void;
  dispose(): void;
}

export interface InputDeps {
  /** 入力を受ける要素（描画の canvas） */
  readonly element: HTMLElement;
  readonly events: EventBus;
  /** 乗車の秒（触れた時刻の記録に使う） */
  now(): number;
}
