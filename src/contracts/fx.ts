// 画面効果（後処理）。膜を通る瞬間と見どころにだけ強める（見せ方のルール）。
// VR では後処理を使わない（速さを優先）。VR での膜の通過は部屋の形と材質で見せる。
import type { Camera, Scene } from 'three';

export interface ScreenFxState {
  /** 泡越しの視界の縁（0: 泡の外、1: 泡が閉じ切った）。画面の中央は澄んだまま */
  bubble: number;
  /** 膜の通過（0〜1。0.6秒で 0→1。干渉の縞と歪み） */
  membrane: number;
  /** 万華鏡の折り返し（0: なし、1: 最大） */
  kaleidoscope: number;
  /** 万華鏡の模様の回転（ラジアン）。穏やかモードでは止める */
  kaleidoscopeAngle: number;
  /** ブルームの強さ（0〜1） */
  bloom: number;
  /** 白い霧（VR への切り替え、0〜1） */
  whiteFog: number;
  /** 全体の明るさ（天球の暗転で 0。黒い画面はここでしか使わない） */
  brightness: number;
}

export interface ScreenFx {
  readonly state: ScreenFxState;
  /** 描画の大きさが変わったとき */
  setSize(width: number, height: number, pixelRatio: number): void;
  /** 毎フレーム renderer.render の代わりに呼ぶ */
  render(scene: Scene, camera: Camera): void;
  /** 後処理を通さずに描く（VR、低品質） */
  setEnabled(on: boolean): void;
  dispose(): void;
}
