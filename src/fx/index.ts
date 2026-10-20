// 画面効果（泡越しの視界の縁、膜の通過、万華鏡の折り返し、ブルーム、白い霧、暗転）。
// 場面の描画に1回の合成を重ねる（three/webgpu の RenderPipeline と TSL）。状態の読み替えは resolveFx（純粋）。
// 効果がどれも働いていないとき、setEnabled(false) のとき（VR、低品質）は後処理を通さず renderer.render をそのまま呼ぶ。
import * as THREE from 'three/webgpu';
import type { ScreenFx, ScreenFxState } from '../contracts/fx';
import { createComposite, type Composite } from './composite';
import { isNeutral, resolveFx, type FxParams } from './resolve';

export { resolveFx, isNeutral, EDGE_MAX, MEMBRANE_BLOOM, REDUCED_FLASH_SCALE } from './resolve';
export type { FxOptions, FxParams } from './resolve';

export interface ScreenFxOptions {
  /** 光の点滅を抑えるモードか（設定が変わるたびに読む）。省略は false */
  reducedFlash?: () => boolean;
}

/** ブルームを計算し始める強さ（これ未満は0として扱い、5段のぼかしを省く） */
const BLOOM_MIN = 0.002;

export function createScreenFx(renderer: THREE.WebGPURenderer, options: ScreenFxOptions = {}): ScreenFx {
  const state: ScreenFxState = {
    bubble: 0,
    membrane: 0,
    kaleidoscope: 0,
    kaleidoscopeAngle: 0,
    bloom: 0,
    whiteFog: 0,
    brightness: 1,
  };
  let enabled = true;
  let composite: Composite | null = null;
  let warmed = false;
  const drawSize = new THREE.Vector2();

  function apply(c: Composite, p: FxParams): void {
    renderer.getDrawingBufferSize(drawSize);
    c.u.aspect.value = drawSize.y > 0 ? drawSize.x / drawSize.y : 1;
    c.u.edge.value = p.edge;
    c.u.stripes.value = p.stripes;
    c.u.distortion.value = p.distortion;
    c.u.aberration.value = p.aberration;
    c.u.fold.value = p.fold;
    c.u.foldAngle.value = p.foldAngle;
    c.u.bloom.value = p.bloom;
    c.u.white.value = p.white;
    c.u.dark.value = p.darkness;
    // 初回は、ぼかしのシェーダーも先に作っておく（最初のブルームで引っかからないように）
    c.bloom.active = p.bloom >= BLOOM_MIN || !warmed;
  }

  return {
    state,
    // 合成の大きさは描画先（renderer のバッファ）から毎フレーム読むので、ここでは持たない
    setSize() {},
    render(scene, camera) {
      const p = resolveFx(state, { reducedFlash: options.reducedFlash?.() ?? false });
      // 効果が要らない間は素通し（MSAA つきで直接描く）。初めの1回だけ合成を通して、シェーダーを先に作っておく
      if (!enabled || (isNeutral(p) && warmed)) {
        renderer.render(scene, camera);
        return;
      }
      composite ??= createComposite(renderer, scene, camera);
      composite.scenePass.scene = scene;
      composite.scenePass.camera = camera;
      apply(composite, p);
      composite.pipeline.render();
      warmed = true;
    },
    setEnabled(on) {
      enabled = on;
    },
    dispose() {
      composite?.dispose();
      composite = null;
    },
  };
}
