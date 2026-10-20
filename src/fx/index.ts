// 画面効果（泡越しの視界の縁、膜の通過、万華鏡の折り返し、ブルーム、白い霧、暗転）。
// STUB: 署名は確定。中身は fx 担当が three/webgpu の RenderPipeline（TSL）で本実装に置き換える。今は素通し。
import type * as THREE from 'three/webgpu';
import type { ScreenFx, ScreenFxState } from '../contracts/fx';

export function createScreenFx(renderer: THREE.WebGPURenderer): ScreenFx {
  const state: ScreenFxState = {
    bubble: 0,
    membrane: 0,
    kaleidoscope: 0,
    kaleidoscopeAngle: 0,
    bloom: 0,
    whiteFog: 0,
    brightness: 1,
  };
  return {
    state,
    setSize() {},
    render(scene, camera) {
      renderer.render(scene, camera);
    },
    setEnabled() {},
    dispose() {},
  };
}
