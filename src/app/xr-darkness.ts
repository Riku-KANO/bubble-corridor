// VR の暗転（TRN-2。唯一の黒、天球の頭の2秒）。VR は後処理を使わない（画面効果の暗さが届かない）ので、
// 頭（カメラ）に付けた黒い球を 1 − 明るさ の濃さで重ねて出す。明るさは乗車の時刻から決まる値（timeline の brightness）をそのまま渡す。
//
// 球の置き方（設計書「動かない基準として残す」: ゴンドラの縁は暗闇でも見えたまま）:
//  - 半径はゴンドラの外側（目から最も遠いゴンドラの点 1.35m より外）。内側から見る面（BackSide）。
//  - 深さを見る（depthTest）。手前にある不透明のゴンドラの縁（深さを書く）は球より手前なので、暗くならない。
//  - 深さは書かない。透明の物の後に描くので、暗くならないのは球より手前で深さを書く不透明な物（縁・手すり・手先の目印）だけ。
//    透明で深さを書かないもの（ゴンドラの殻のガラス、部屋の飾りのガラス、星）は、球の内側にあっても暗くなる（意図どおり）。
// 外周の暗さ（10_000）と白い霧（10_001）はこの上に重なる。
import * as THREE from 'three/webgpu';
import { CAMERA, GONDOLA_DIAMETER, XR } from '../config';

export interface XRDarkness {
  /** カメラの子として付ける */
  readonly object: THREE.Object3D;
  /** 全体の明るさ（0: 真っ暗、1: 描かない） */
  set(brightness: number): void;
  dispose(): void;
}

/** 濃さがこれ未満なら描かない（描画の呼び出しを増やさない） */
const MIN_OPACITY = 0.005;
/** 外周の暗さ（10_000）より前、透明の物の後。VR のメニューの板（9_000）より前に描いて、メニューは暗くしない */
const RENDER_ORDER = 8_500;

export function createXRDarkness(): XRDarkness {
  const material = new THREE.MeshBasicNodeMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0,
    side: THREE.BackSide,
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const radius = GONDOLA_DIAMETER / 2 + CAMERA.seatEyeHeight + XR.darknessMargin;
  const geometry = new THREE.SphereGeometry(radius, 24, 16);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'xr-darkness';
  mesh.renderOrder = RENDER_ORDER;
  // 頭を中心にした球なので、いつも視界に入る
  mesh.frustumCulled = false;
  mesh.visible = false;
  return {
    object: mesh,
    set(brightness) {
      // 値が壊れていたら暗くしない（黒い画面は唯一の例外にだけ許されている）
      const b = Number.isFinite(brightness) ? Math.min(1, Math.max(0, brightness)) : 1;
      const dark = 1 - b;
      if (dark < MIN_OPACITY) {
        mesh.visible = false;
        return;
      }
      mesh.visible = true;
      material.opacity = dark;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
