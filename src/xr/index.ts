// VR（WebXR）。
// STUB: 署名は確定。中身は xr 担当が本実装に置き換える。
import * as THREE from 'three/webgpu';
import type { XRDeps, XRSystem } from '../contracts/xr';

export function createXRSystem(_renderer: THREE.WebGPURenderer, _deps: XRDeps): XRSystem {
  const rig = new THREE.Group();
  rig.name = 'xr-rig';
  return {
    async isSupported() {
      return false;
    },
    active: false,
    async enter() {
      throw new Error('VR はまだ使えません（STUB）');
    },
    async exit() {},
    rig,
    update() {},
    setTouchables() {},
    recenter() {},
    setVignette() {},
    showMenu() {},
    hideMenu() {},
    onSessionEnd() {},
  };
}
