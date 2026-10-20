// 撮影: 画面とは別の RenderTarget に同じ場面をもう一度描き、画素を読み出して PNG にする。
//
// 画面の演出を止めないための決まり:
//  - 描画は 1 回だけ（同期で GPU に積む）。待つのは読み出しと PNG の符号化だけで、どちらも非同期。
//  - 画面効果（後処理）は通さない。renderer.render(scene, camera) を直接呼ぶ。
//  - 使い終わった RenderTarget はすぐ捨てる（HalfFloat の多重標本で数百 MB になりうるので、持ち続けない）。
import * as THREE from 'three/webgpu';

export interface CaptureSize {
  readonly width: number;
  readonly height: number;
}

/** 読み出した画素の行の並びと詰め方 */
interface Layout {
  /** 1 行の間隔（バイト）。WebGPU は 256 バイトの倍数に詰めて返す */
  readonly strideBytes: number;
  /** 下の行から並んでいるか（WebGL2 の readPixels は左下が原点） */
  readonly bottomUp: boolean;
}

/**
 * 画面とは別に高い解像度で描き出す。画面の演出は止めない（裏で別の画像として描く）。
 * size は config の PHOTO.captureDesktop / captureMobile。
 *
 * トーンマッピングと色空間は画面と同じ（renderer の設定どおり）になる。RenderTarget へ普通に描くと
 * 線形・トーンマップなしで出てしまうので、setOutputRenderTarget で「画面の代わり」として描かせ、
 * three の出力パスに変換までやらせる（PostProcessing と同じ経路）。
 */
export async function capturePhoto(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: CaptureSize,
): Promise<Blob> {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));

  // 出力パス（トーンマッピング・色空間の変換）が要るときは、シーン本体は three が持つ内部の
  // HalfFloat の領域に描き、ここの RenderTarget には変換後の画素だけが書かれる。なら深度もいらない。
  // 要らないとき（変換なし）は直接ここへ描くので、深度と多重標本を持たせる。
  const viaOutputPass = renderer.needsFrameBufferTarget;
  const target = new THREE.RenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace, // 変換は出力パスが済ませる。ここで二重に変換しない
    depthBuffer: !viaOutputPass,
    samples: viaOutputPass ? 0 : renderer.samples,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });

  try {
    renderOnce(renderer, scene, camera, target, width / height);
    const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
    const layout = layoutOf(renderer, data, width, height);
    return await encodePng(toOpaqueRgba(data as Uint8Array, width, height, layout), width, height);
  } finally {
    target.dispose();
  }
}

/** 場面を target へ 1 回だけ描く。renderer とカメラの状態は必ず元に戻す */
function renderOnce(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.RenderTarget,
  aspect: number,
): void {
  const prevTarget = renderer.getRenderTarget();
  const prevOutput = renderer.getOutputRenderTarget();
  // 乗車が VR のときは、描画が VR 用のカメラ配列に切り替わってしまうので、この 1 回だけ切る
  const xr = renderer.xr as { isPresenting: boolean; enabled: boolean };
  const prevPresenting = xr.isPresenting;
  const prevXrEnabled = xr.enabled;
  const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? (camera as THREE.PerspectiveCamera) : null;
  const prevAspect = persp?.aspect ?? 1;

  try {
    if (persp) {
      persp.aspect = aspect;
      persp.updateProjectionMatrix();
    }
    xr.isPresenting = false;
    xr.enabled = false;
    renderer.setRenderTarget(null);
    renderer.setOutputRenderTarget(target);
    renderer.render(scene, camera);
  } finally {
    xr.isPresenting = prevPresenting;
    xr.enabled = prevXrEnabled;
    renderer.setOutputRenderTarget(prevOutput);
    renderer.setRenderTarget(prevTarget);
    if (persp) {
      persp.aspect = prevAspect;
      persp.updateProjectionMatrix();
    }
  }
}

function layoutOf(renderer: THREE.WebGPURenderer, data: ArrayLike<number>, width: number, height: number): Layout {
  const rowBytes = width * 4;
  const padded = Math.ceil(rowBytes / 256) * 256;
  // WebGPU は 1 行を 256 バイトの倍数に詰めた並びで返す（最後の行は詰めない）。WebGL2 は詰めない
  const strideBytes = data.length === rowBytes * height ? rowBytes : padded;
  const bottomUp = (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true;
  return { strideBytes, bottomUp };
}

/** 行の詰めと上下を直し、アルファを不透明にした RGBA にする（写真に透けた所を作らない） */
function toOpaqueRgba(src: Uint8Array, width: number, height: number, layout: Layout): Uint8ClampedArray<ArrayBuffer> {
  const rowBytes = width * 4;
  const out = new Uint8ClampedArray(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const from = (layout.bottomUp ? height - 1 - y : y) * layout.strideBytes;
    out.set(src.subarray(from, from + rowBytes), y * rowBytes);
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}

/** RGBA の画素を PNG にする。OffscreenCanvas があればそれで（主スレッドを塞ぎにくい） */
async function encodePng(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<Blob> {
  const image = new ImageData(rgba, width, height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.putImageData(image, 0, 0);
      return canvas.convertToBlob({ type: 'image/png' });
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D キャンバスを作れません');
  ctx.putImageData(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG に変換できません'))), 'image/png');
  });
}
