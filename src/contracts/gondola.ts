// ゴンドラ（泡）の契約。最も長く画面に映るので最高品質で作る（rooms-a 担当）。
import type { Object3D } from 'three';

export interface Gondola {
  /** ゴンドラ全体。統合担当が毎フレーム姿勢に合わせて動かす（常に水平、向きは左右だけ） */
  readonly root: Object3D;
  /** 座席の目の位置。画面のカメラはここに固定する（VR では台をここに置く） */
  readonly seat: Object3D;
  /**
   * 泡の殻の閉じ具合（0: 開いている、1: 閉じた）。乗車で下から上へ閉じ、降車で上から下へ開く。
   * 閉じた後は、視界の縁にだけ泡の内側の反射と虹色をかすかに残す（画面の中央は澄んだまま）。
   */
  setShell(closed: number): void;
  /** 毎フレーム。t は秒（表面の虹色の流れ） */
  update(t: number, dt: number): void;
  dispose(): void;
}
