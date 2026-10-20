// 画面 → VR の白い霧（設計書「トランジション設計」: 白い霧に包まれ、霧が晴れるとヘッドセットの中で乗り場に立っている）。
// 外周の暗さと同じ方式で、カメラの子の白い板（深度テストなし）を重ね、不透明度は時刻の関数 whiteoutOpacity で決める。
// カメラは動かさない（VR では移動を白い霧の切り替えに置き換える）。
import * as THREE from 'three/webgpu';
import { XR_TUNING } from './tuning';

export interface Whiteout {
  readonly mesh: THREE.Mesh;
  /** 不透明度（0〜1）。0 なら描かない */
  set(opacity: number): void;
  /** 不透明度 0 のまま見えるようにする（開始前の compileAsync 用。set(0) で隠れる） */
  prewarm(): void;
  dispose(): void;
}

export function createWhiteout(): Whiteout {
  const material = new THREE.MeshBasicNodeMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const size = XR_TUNING.whiteoutSize;
  const geometry = new THREE.PlaneGeometry(size, size);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'xr-whiteout';
  mesh.position.z = -XR_TUNING.vignetteDistance;
  // 外周の暗さ（10_000）より後に重ねる
  mesh.renderOrder = 10_001;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return {
    mesh,
    set(opacity) {
      const o = opacity <= 0 ? 0 : opacity >= 1 ? 1 : opacity;
      if (o < 0.005) {
        mesh.visible = false;
        return;
      }
      mesh.visible = true;
      material.opacity = o;
    },
    prewarm() {
      material.opacity = 0;
      mesh.visible = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
