// 移動中の外周の暗さ。後処理は使わず、カメラの前に置いた輪の板（中心が抜けた板）を黒く重ねる。
// 中心の穴は描かないので、止まっているあいだ（板を隠す）も動いているあいだも、視界の中心の描画は増えない。
import * as THREE from 'three/webgpu';
import { XR_TUNING } from './tuning';

export interface Vignette {
  readonly mesh: THREE.Mesh;
  /** 強さ（0〜1）。0 なら描かない */
  set(strength: number): void;
  /** 不透明度 0 のまま見えるようにする。白い霧のあいだに一度描いて XR 用のシェーダを作るため（次の set(0) で隠れる） */
  prewarm(): void;
  dispose(): void;
}

const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);

export function createVignette(): Vignette {
  const D = XR_TUNING.vignetteDistance;
  const inner = D * tan(XR_TUNING.vignetteInnerDeg);
  const outer = D * tan(XR_TUNING.vignetteOuterDeg);
  const dark = D * tan(XR_TUNING.vignetteDarkDeg);

  // 輪の外側へ向かって透明 → 黒になる放射状の勾配。板の端が画像の端に当たる
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const c = size / 2;
    const g = ctx.createRadialGradient(c, c, (inner / outer) * c, c, c, (dark / outer) * c);
    // 角を作らないよう、なだらかに立ち上げる
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.3, 'rgba(0,0,0,0.08)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.4)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;

  const material = new THREE.MeshBasicNodeMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const geometry = new THREE.RingGeometry(inner, outer, 64, 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'xr-vignette';
  mesh.position.z = -D;
  // 何より最後に重ねる。カメラの子なので視錐台の判定は要らない
  mesh.renderOrder = 10_000;
  mesh.frustumCulled = false;
  mesh.visible = false;

  return {
    mesh,
    set(strength) {
      const s = strength <= 0 ? 0 : strength >= 1 ? 1 : strength;
      if (s < 0.005) {
        mesh.visible = false;
        return;
      }
      mesh.visible = true;
      material.opacity = s;
      // 強いほど輪の内側が狭まり、視界の端から暗くなる
      mesh.scale.setScalar(1 - XR_TUNING.vignetteShrink * s);
    },
    prewarm() {
      material.opacity = 0;
      mesh.scale.setScalar(1);
      mesh.visible = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
