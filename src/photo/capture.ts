// 撮影: 画面とは別の RenderTarget に同じ場面をもう一度描き、画素を読み出して WebP（なければ JPEG）にする。
//
// 画面の演出を止めないための決まり:
//  - 描画は 1 回だけ（同期で GPU に積む）。待つのは読み出しと符号化だけで、どちらも非同期。
//  - 画面効果（後処理）は通さない。renderer.render(scene, camera) を直接呼ぶ。
//  - 使い終わった RenderTarget はすぐ捨てる（HalfFloat の多重標本で数百 MB になりうるので、持ち続けない）。
//  - 画素の並べ直し（上下・行の詰め・アルファ）は、1 回 3 ms ほどに区切って主スレッドを返しながら進める。
//  - 最初の 1 回は出力の変換のパイプラインを作るぶん重いので、warmUpCapture で先に通しておける。
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

/** 内部の保存の画質。撮影したままの画像は棚に最大 30 枚（10 回 × 3 枚）残るので、PNG ではなく WebP にする */
const WEBP_QUALITY = 0.9;
/** WebP を書き出せない環境（Safari など）の代わり */
const JPEG_QUALITY = 0.92;
/** 並べ直しを 1 回に続けてよい時間（ms）。1 フレーム（16.7ms）の中で十分に小さく */
const SLICE_BUDGET_MS = 3;
/** 下ごしらえの撮影の大きさ。変換のパイプラインを通すだけなので、小さくてよい */
const WARMUP_SIZE: CaptureSize = { width: 64, height: 36 };

/**
 * 画面とは別に高い解像度で描き出す。画面の演出は止めない（裏で別の画像として描く）。
 * size は config の PHOTO.captureDesktop / captureMobile。返す画像は WebP（書き出せない環境では JPEG）。
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

  // 出力パス（トーンマッピング・色空間の変換）が要るかは、renderer の設定から決める。
  // （three の needsFrameBufferTarget は描画先の状態に左右されるので、ここでは使わない）
  // 要るときは、シーン本体は three が持つ内部の HalfFloat の領域に描き、ここの RenderTarget には
  // 変換後の画素だけが書かれる。なら深度も多重標本もいらない。要らないときは直接ここへ描く。
  const viaOutputPass = renderer.toneMapping !== THREE.NoToneMapping || renderer.outputColorSpace !== THREE.ColorManagement.workingColorSpace;
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
    return await encode(data as Uint8Array, width, height, layoutOf(renderer, data, width, height));
  } finally {
    target.dispose();
  }
}

/**
 * 最初の撮影の前に 1 回だけ呼ぶ下ごしらえ。小さな大きさで capturePhoto と同じ経路
 * （出力の変換つきの描画、読み出し、書き出し）を 1 回通して、結果は捨てる。
 * 初回だけ重い出力パスのパイプライン作りと書き出しの準備を済ませて、本番の撮影で画面が詰まらないようにする。
 * 失敗しても体験は止めない（本番の撮影が自分で作り直す）。
 */
export async function warmUpCapture(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: CaptureSize = WARMUP_SIZE,
): Promise<void> {
  try {
    await capturePhoto(renderer, scene, camera, size);
  } catch {
    // 下ごしらえなので、失敗は見せない
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

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type Surface = OffscreenCanvas | HTMLCanvasElement;

/** 画素の書き込み先。読み出しは符号化だけなので CPU 側の描画面で足りる（GPU への往復を避ける） */
function createSurface(width: number, height: number): { surface: Surface; ctx: Ctx } {
  const options: CanvasRenderingContext2DSettings = { alpha: false, willReadFrequently: true };
  if (typeof OffscreenCanvas !== 'undefined') {
    const surface = new OffscreenCanvas(width, height);
    const ctx = surface.getContext('2d', options);
    if (ctx) return { surface, ctx };
  }
  const surface = document.createElement('canvas');
  surface.width = width;
  surface.height = height;
  const ctx = surface.getContext('2d', options);
  if (!ctx) throw new Error('2D キャンバスを作れません');
  return { surface, ctx };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/** RGBA の A を 255 にするビット（Uint32 で読んだとき） */
const OPAQUE = LITTLE_ENDIAN ? 0xff000000 : 0x000000ff;

/** 主スレッドを一度返す。次のフレームの描画や入力を先に通すため */
function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 行の詰めと上下を直し、アルファを不透明にして描画面へ書く。
 * 全体を一気にやると 15MB 近くを数十 ms 動かすので、SLICE_BUDGET_MS ごとに主スレッドを返す。
 */
async function paintRows(ctx: Ctx, src: Uint8Array, width: number, height: number, layout: Layout): Promise<void> {
  const out = new Uint8ClampedArray(width * height * 4);
  const out32 = new Uint32Array(out.buffer);
  const src32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
  const rowPixels = layout.strideBytes >> 2;
  const image = new ImageData(out, width, height);

  let y = 0;
  while (y < height) {
    const sliceStart = y;
    const t0 = performance.now();
    do {
      const from = (layout.bottomUp ? height - 1 - y : y) * rowPixels;
      const to = y * width;
      for (let x = 0; x < width; x++) out32[to + x] = (src32[from + x] | OPAQUE) >>> 0;
      y++;
    } while (y < height && performance.now() - t0 < SLICE_BUDGET_MS);
    ctx.putImageData(image, 0, 0, 0, sliceStart, width, y - sliceStart);
    if (y < height) await yieldToMain();
  }
}

/** WebP を書き出せるか。最初の 1 回で分かったら覚えて、以後は余計な書き出しをしない */
let webpSupported: boolean | null = null;

function toBlob(surface: Surface, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in surface) return surface.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    surface.toBlob((b) => (b ? resolve(b) : reject(new Error('画像に変換できません'))), type, quality);
  });
}

/**
 * 読み出した画素を WebP にする。書き出せない環境では、指定した形式の代わりに PNG が返るので、
 * 返った blob.type を見て、WebP でなければ JPEG で書き直す（アルファは常に不透明なので JPEG でよい）。
 */
async function encode(src: Uint8Array, width: number, height: number, layout: Layout): Promise<Blob> {
  const { surface, ctx } = createSurface(width, height);
  await paintRows(ctx, src, width, height, layout);
  if (webpSupported !== false) {
    const blob = await toBlob(surface, 'image/webp', WEBP_QUALITY);
    if (blob.type === 'image/webp') {
      webpSupported = true;
      return blob;
    }
    webpSupported = false;
  }
  return toBlob(surface, 'image/jpeg', JPEG_QUALITY);
}
