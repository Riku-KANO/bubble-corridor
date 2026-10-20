// 画面効果（泡越しの視界の縁、膜の通過、万華鏡の折り返し、ブルーム、白い霧、暗転）。
// 場面の描画に1回の合成を重ねる（three/webgpu の RenderPipeline と TSL）。状態の読み替えは resolveFx（純粋）。
//
// 描画先は1組だけにする。有効な間は、効果がない間も合成を通す（読み出しを省いたほぼ素通しの1パス）。
// setEnabled(false)（低品質、スマートフォン）と VR の間は合成の描画先を解放し、renderer.render で直接描く。
// その場合も、暗さ（天球の2秒の暗転）と白い霧（画面 → VR）は、描画の後に全画面の板を1枚だけ重ねて出す
// （黒い画面は天球の暗転にだけ許されているので、暗転が出ないと体験が変わってしまう）。
import * as THREE from 'three/webgpu';
import type { ScreenFx, ScreenFxState } from '../contracts/fx';
import { createComposite, FX_EPS, WHITE_FOG_RGB, type Composite } from './composite';
import { blank, hasScreenTint, resolveFx } from './resolve';

export { resolveFx, EDGE_MAX, MEMBRANE_BLOOM, REDUCED_FLASH_SCALE } from './resolve';
export type { FxOptions, FxParams } from './resolve';

export interface ScreenFxOptions {
  /** 光の点滅を抑えるモードか（設定が変わるたびに読む）。省略は false */
  reducedFlash?: () => boolean;
  /** ブルームの解像度（画面に対する倍率）。既定は 0.5。スマートフォンでは 0.25 にする */
  bloomResolution?: number;
}

/** ブルームを計算し始める強さ（これ未満は0として扱い、5段のぼかしを省く）。合成の読む境と同じ値 */
const BLOOM_MIN = FX_EPS;

/** 暗さと白い霧だけを、描いた絵の上に重ねる全画面の板（後処理を使わないとき用） */
function createTint() {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const quad = new THREE.QuadMesh(material);
  return {
    /** 白い霧 white と暗さ dark を1枚の板で重ねる（結果 = 絵 × (1-white)(1-dark) + 白 × white(1-dark)） */
    draw(renderer: THREE.WebGPURenderer, white: number, dark: number): void {
      const alpha = 1 - (1 - white) * (1 - dark);
      if (alpha <= 0.0005) return;
      const gray = (white * (1 - dark)) / alpha; // 板の色（0 = 黒、1 = 白）。表示の色で混ぜる
      // 色空間の変換をかけずに書くので、値がそのまま表示の色になる。白は合成と同じ色（WHITE_FOG_RGB）
      material.color.setRGB(WHITE_FOG_RGB[0] * gray, WHITE_FOG_RGB[1] * gray, WHITE_FOG_RGB[2] * gray);
      material.opacity = alpha;
      const autoClear = renderer.autoClear;
      const toneMapping = renderer.toneMapping;
      const outputColorSpace = renderer.outputColorSpace;
      try {
        renderer.autoClear = false; // 直前に描いた絵を消さない
        // トーンマップも色空間の変換も外す。renderer は、どちらかが有効だと HDR の中間の描画先に描いてから変換するので、
        // 板がその中で線形の色として混ざり、さらにトーンマップを受けてしまう。外すと、変換済みの絵の上へ表示の色のまま直接混ざる
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
        quad.render(renderer);
      } finally {
        renderer.outputColorSpace = outputColorSpace;
        renderer.toneMapping = toneMapping;
        renderer.autoClear = autoClear;
      }
    },
    dispose(): void {
      material.dispose();
    },
  };
}

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
  let tint: ReturnType<typeof createTint> | null = null;
  let warmed = false;
  let directUsed = false; // 素通しで描いて、renderer の HDR の中間の描画先を作ったか
  // 毎フレームの確保を避けるために使い回す
  const params = blank();
  const flash = { reducedFlash: false };
  const drawSize = new THREE.Vector2();

  /** 合成の描画先（場面の HDR、ブルームの縮小版）を解放する。必要になったら作り直す */
  function release(): void {
    composite?.dispose();
    composite = null;
    warmed = false;
  }

  /**
   * renderer が素通しの描画（renderer.render）のために持つ HDR の中間の描画先を解放する。
   * 合成を使う間は素通しで描かないので、残しておくと全画面の HDR の描画先が2組になってしまう。
   * three の内部（_frameBufferTargets。r186 で確認）を見るので、なければ何もしない。解放した描画先は、次に素通しで描くときに作り直される。
   * 通るのは setEnabled の切り替えのときだけ（毎フレームではない）。three を上げたら名前が残っているか確かめる。
   */
  function releaseDirectTargets(): void {
    const targets = (renderer as unknown as { _frameBufferTargets?: Map<unknown, THREE.RenderTarget> })._frameBufferTargets;
    if (!directUsed || !targets) return;
    for (const target of targets.values()) target.dispose();
    directUsed = false;
  }
  // VR の開始で、後処理の描画先を手放す（VR は renderer.render で直接描く）
  const onSessionStart = (): void => release();
  renderer.xr.addEventListener('sessionstart', onSessionStart);

  function apply(c: Composite, camera: THREE.Camera): void {
    renderer.getDrawingBufferSize(drawSize);
    c.u.aspect.value = drawSize.y > 0 ? drawSize.x / drawSize.y : 1;
    c.u.texel.value = drawSize.y > 0 ? 1 / drawSize.y : 1 / 720;
    c.u.edge.value = params.edge;
    c.u.stripes.value = params.stripes;
    c.u.distortion.value = params.distortion;
    c.u.aberration.value = params.aberration;
    c.u.fold.value = params.fold;
    c.u.foldAngle.value = params.foldAngle;
    c.u.bloom.value = params.bloom;
    c.u.white.value = params.white;
    c.u.dark.value = params.darkness;
    // 深さから視点までの距離を出すためのカメラの値
    c.u.near.value = (camera as THREE.PerspectiveCamera).near;
    c.u.far.value = (camera as THREE.PerspectiveCamera).far;
    const focal = camera.projectionMatrix.elements[5] ?? 0;
    c.u.tanHalfFov.value = focal > 0 ? 1 / focal : 0.6;
    // 初回は、ぼかしのシェーダーも先に作っておく（最初のブルームで引っかからないように）
    c.bloom.active = params.bloom >= BLOOM_MIN || !warmed;
  }

  return {
    state,
    // 合成の大きさは描画先（renderer のバッファ）から毎フレーム読むので、ここでは持たない
    setSize() {},
    render(scene, camera) {
      flash.reducedFlash = options.reducedFlash?.() ?? false;
      resolveFx(state, flash, params);

      // VR（WebXR の描画中）は後処理を使わない。カメラを演出で動かさず、速さを優先する
      if (renderer.xr.isPresenting) {
        release();
        renderer.render(scene, camera);
        return;
      }
      if (!enabled) {
        release();
        renderer.render(scene, camera);
        directUsed = true;
        if (hasScreenTint(params)) {
          tint ??= createTint();
          tint.draw(renderer, params.white, params.darkness);
        }
        return;
      }
      releaseDirectTargets();
      composite ??= createComposite(renderer, scene as THREE.Scene, camera, { bloomResolution: options.bloomResolution });
      composite.scenePass.scene = scene;
      composite.scenePass.camera = camera;
      apply(composite, camera);
      composite.pipeline.render();
      warmed = true;
    },
    setEnabled(on) {
      enabled = on;
      if (!on) release();
    },
    dispose() {
      renderer.xr.removeEventListener('sessionstart', onSessionStart);
      release();
      releaseDirectTargets();
      tint?.dispose();
      tint = null;
    },
  };
}
