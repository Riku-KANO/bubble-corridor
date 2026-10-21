// VR（WebXR）の契約。カメラを演出で動かさない。頭の動きだけを反映する。
import type { Camera, Object3D, Scene } from 'three';
import type { EventBus } from './events';
import type { XRPosture } from './ids';
import type { RidePose } from './ride';
import type { Touchable } from './room';

export interface XRSystem {
  /** immersive-vr が使える端末か */
  isSupported(): Promise<boolean>;
  readonly active: boolean;
  /**
   * 入口の「VRで乗る」の操作の中で呼ぶ（ブラウザの規則で一度の操作が必要）。
   * 座って乗るか立って乗るかで床の高さの扱いを変える。
   */
  enter(posture: XRPosture): Promise<void>;
  exit(): Promise<void>;
  /** ゴンドラに乗せる台（カメラと手の親）。統合担当が毎フレーム pose に合わせて動かす */
  readonly rig: Object3D;
  /** 毎フレーム。ゴンドラの姿勢に台を合わせ、指先と触れられる物の距離を判定する */
  update(t: number, dt: number, pose: RidePose): void;
  setTouchables(list: readonly Touchable[]): void;
  /** 正面を合わせ直す */
  recenter(): void;
  /** 移動中に外周を暗くする強さ（0〜1） */
  setVignette(strength: number): void;
  /** 見つめて触れるまでの秒（設定の 0.8 / 1.2 / 2.0）。既定は INTERACTION.gazeDwellSec */
  setGazeDwell(sec: number): void;
  /** VR のメニュー（曇りガラスの板）を手を伸ばした先に出す */
  showMenu(items: readonly { readonly id: string; readonly label: string }[], onSelect: (id: string) => void): void;
  hideMenu(): void;
  onSessionEnd(fn: () => void): void;
}

export interface XRDeps {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly events: EventBus;
  now(): number;
}
