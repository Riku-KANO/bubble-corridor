// 撮影: 画面とは別の RenderTarget に同じ場面をもう一度描き、画素を読み出して WebP（なければ JPEG）にする。
//
// 画面の演出（VR ではフレームの提出）を止めないための決まり:
//  - 描画は 1 回だけ。いまのフレームの処理が済んだ次のタスクで GPU に積む（フレームの中で積むと、フレームの提出がその後ろになる）。
//    待つのは読み出しと符号化だけで、どちらも非同期。
//  - 画面効果（後処理）は通さない。renderer.render(scene, camera) を直接呼ぶ。
//  - 撮影の描画には撮影専用の照明の管理（Lighting）を使う。three は描く物の状態を「物・材質・描画先・照明」で引くので、
//    画面の描画と状態が重ならず、VR（画面が両眼のカメラ配列、撮影が単眼）で互いの状態を壊し合わない。
//  - 描画先の使い終わりはすぐ捨てる（HalfFloat の多重標本で数百 MB になりうるので、持ち続けない）。
//  - 画素の並べ直し（上下・行の詰め・アルファ）は、1 回 2 ms ほどに区切って、1 フレームずつ空けながら進める。
//  - 最初の 1 回は出力の変換のパイプラインを作るぶん重いので、warmUpCapture で先に通しておける。
//  - 撮影の描画は画面の描画とシェーダーを共有できない（描画先の条件が違う）。見えている物すべてのシェーダーを作ると
//    約 50ms（WebGL2 の最初の描画ではさらにプログラムごとに数 ms）止まるので、撮影の少し前に prepareCapture で先に作る。
//  - GPU 側の作業（下ごしらえ・描き出し・読み出し）は 1 つずつ順に行う（three の描画の文脈が重なると壊れる）。
//  - 下ごしらえは物ごとに列へ入れる。撮影が来たら残りを打ち切り、撮影の待ちは物 1 つぶんで済ませる（撮影の時刻を下ごしらえで遅らせない）。
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
const SLICE_BUDGET_MS = 2;
/** 並べ直しの区切りの間に空ける時間（ms）。1 フレームぶん（60fps）。区切りが 1 フレームに固まらないように */
const SLICE_GAP_MS = 16;
/** 1 回に書く帯の高さ（行）。2560 幅で約 0.5MB */
const STRIP_ROWS = 48;
/** 下ごしらえの撮影の大きさ。変換のパイプラインを通すだけなので、小さくてよい */
const WARMUP_SIZE: CaptureSize = { width: 64, height: 36 };
/** 下ごしらえ（prepareCapture）の描画先の幅。縦は撮影の縦横比から決める */
const PREPARE_WIDTH = 64;
/** 下ごしらえを主スレッドで続けてよい時間（ms）。これを超えたら次のタスクへ回す */
const PREPARE_SLICE_MS = 3;

/**
 * 撮影の GPU 側の作業（下ごしらえの compile、描き出しと読み出し）を 1 つずつ順に行うための列。
 * three の描画の文脈（RenderContext）は同じ形式の描画先で共有されるので、重なって走ると、片方が捨てた描画先の深度を
 * もう片方が参照して、パイプラインを作れなくなる（Async render pipeline creation failed）。符号化など CPU だけの作業は列に入れない。
 */
let gpuQueue: Promise<unknown> = Promise.resolve();

function exclusively<T>(work: () => Promise<T>): Promise<T> {
  const run = gpuQueue.then(work, work);
  gpuQueue = run.catch(() => undefined);
  return run;
}

/** 動いている下ごしらえ（warmUpCapture と prepareCapture）。撮影が来たら cancelled を立て、残りは行わない */
const prepareJobs = new Set<{ cancelled: boolean }>();

/** いまのフレームの処理（描画と提出）が済んだ後の、次のタスクまで待つ */
function afterFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 撮影用の描画先。出力パス（トーンマッピング・色空間の変換）が要るかは、renderer の設定から決める。
 * （three の needsFrameBufferTarget は描画先の状態に左右されるので、ここでは使わない）
 * 要るときは、シーン本体は three が持つ内部の HalfFloat の領域に描き、ここの RenderTarget には
 * 変換後の画素だけが書かれる。なら深度も多重標本もいらない。要らないときは直接ここへ描く。
 */
function createTarget(renderer: THREE.WebGPURenderer, width: number, height: number): THREE.RenderTarget {
  const viaOutputPass = renderer.toneMapping !== THREE.NoToneMapping || renderer.outputColorSpace !== THREE.ColorManagement.workingColorSpace;
  return new THREE.RenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace, // 変換は出力パスが済ませる。ここで二重に変換しない
    depthBuffer: !viaOutputPass,
    samples: viaOutputPass ? 0 : renderer.samples,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
}

export interface CaptureOptions {
  /** GPU に積む直前に呼ぶ。撮影が「いつの場面」を描いたかの確認用（e2e が ?debug で読む）。重い処理は置かない */
  readonly onRender?: () => void;
}

/**
 * 画面とは別に高い解像度で描き出す。画面の演出は止めない（裏で別の画像として描く）。
 * size は config の PHOTO.captureDesktop / captureMobile。返す画像は WebP（書き出せない環境では JPEG）。
 *
 * トーンマッピングと色空間は画面と同じ（renderer の設定どおり）になる。RenderTarget へ普通に描くと
 * 線形・トーンマップなしで出てしまうので、setOutputRenderTarget で「画面の代わり」として描かせ、
 * three の出力パスに変換までやらせる（PostProcessing と同じ経路）。
 *
 * 呼ぶと、動いている下ごしらえの残りは打ち切られる（撮影の時刻を下ごしらえの長さで決めない。待つのは作業中の物 1 つぶん）。
 */
export async function capturePhoto(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: CaptureSize,
  options: CaptureOptions = {},
): Promise<Blob> {
  for (const job of prepareJobs) job.cancelled = true;
  const blob = await capture(renderer, scene, camera, size, options, null);
  if (!blob) throw new Error('撮影できませんでした');
  return blob;
}

/** skipWhen が立っていたら（撮影が来て、下ごしらえの残りが打ち切られた）、描かずに null */
async function capture(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: CaptureSize,
  options: CaptureOptions,
  skipWhen: { cancelled: boolean } | null,
): Promise<Blob | null> {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));

  // 読み出した画素は CPU 側の写しなので、並べ直しと書き出し（数フレームにまたがる）の前に
  // 撮影用の描画先（と three が作る多重標本の領域）をすぐ捨てる
  const data = await exclusively(async () => {
    // 描くのは、いまのフレームの描画が済んでから（次のタスク）。フレームの中で GPU に積むと、フレームの提出が撮影の描画の後ろになり、
    // その分だけそのフレームが遅れる（VR ではフレームの提出が遅れると、そのまま視界の止まり）。場面はフレームの間は変わらないので絵は同じ
    await afterFrame();
    if (skipWhen?.cancelled) return null;
    const target = createTarget(renderer, width, height);
    try {
      options.onRender?.();
      inCaptureState(renderer, camera, target, width / height, () => renderer.render(scene, camera));
      return (await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height)) as Uint8Array;
    } finally {
      target.dispose();
    }
  });
  return data ? encode(data, width, height, layoutOf(renderer, data, width, height)) : null;
}

/**
 * 最初の撮影の前に 1 回だけ呼ぶ下ごしらえ。小さな大きさで capturePhoto と同じ経路
 * （出力の変換つきの描画、読み出し、書き出し）を通して、結果は捨てる。
 * 初回だけ重い出力パスのパイプライン作りと書き出しの準備を済ませて、本番の撮影で画面が詰まらないようにする。
 * 失敗しても体験は止めない（本番の撮影が自分で作り直す）。
 *
 * 2 回通す理由: three は出力パスのシェーダーを撮影のたびに作り直し、1 回目と 2 回目以降で生成するコードの並びが違う
 * （uniform の宣言順。three r186 で確認）。コードが違うと別のプログラムになり、WebGL2 では本番の撮影の最中に
 * プログラムのリンクを待って止まる。2 回目以降と同じコードを先に作っておけば、本番の撮影は作られ済みのものを使う。
 */
export async function warmUpCapture(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: CaptureSize = WARMUP_SIZE,
): Promise<void> {
  // 下ごしらえの一種。本物の撮影が来たら、まだ始めていない残りは打ち切る（撮影の時刻を下ごしらえで遅らせない）
  const job = { cancelled: false };
  prepareJobs.add(job);
  try {
    for (let i = 0; i < 2 && !job.cancelled; i++) await capture(renderer, scene, camera, size, {}, job);
  } catch {
    // 下ごしらえなので、失敗は見せない
  } finally {
    prepareJobs.delete(job);
  }
}

export interface PrepareOptions {
  /**
   * 撮影の部屋の root など。この下は、いま見えていない物（あとから現れる物）も準備する。
   * 部屋は、見どころで現れる物（露の波紋、空のドームなど）を先に作って隠しておくので、見えている物だけでは撮影の最中に作ることになる
   */
  readonly rooms?: readonly THREE.Object3D[];
}

/** 描画の対象になる物（three の _projectObject が列に入れる種類） */
interface Renderable {
  readonly isMesh?: boolean;
  readonly isLine?: boolean;
  readonly isPoints?: boolean;
  readonly isSprite?: boolean;
}

function isRenderable(o: THREE.Object3D): boolean {
  const r = o as unknown as Renderable;
  return r.isMesh === true || r.isLine === true || r.isPoints === true || r.isSprite === true;
}

/**
 * 下ごしらえの対象を、物ごとに集める。順番は、撮影に効く順:
 * 撮影の部屋（rooms）の下の、いま見えている物 → 同じ下の、隠れている物（見どころで現れる物）→ 場面のほかの見えている物。
 * 撮影が来て打ち切られても、先に作った分が効く。場面に属さなくなった物は、実行のときに外す（部屋が解放された）。
 */
function collectRenderables(scene: THREE.Scene, rooms: readonly THREE.Object3D[]): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const seen = new Set<THREE.Object3D>();
  const add = (o: THREE.Object3D): void => {
    if (!isRenderable(o) || seen.has(o)) return;
    seen.add(o);
    out.push(o);
  };
  for (const root of rooms) root.traverseVisible(add);
  for (const root of rooms) root.traverse(add);
  scene.traverseVisible(add);
  return out;
}

function isInScene(scene: THREE.Scene, o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === scene) return true;
  return false;
}

/**
 * 物 1 つのシェーダーとパイプラインを作る（compileAsync の同期の部分だけ、撮影の状態で）。
 * 隠れた物も作るので visible を立て、見えている範囲に関わらず作るので視錐台の判定を外し、終わったら必ず戻す。
 * compileAsync が描く物の一覧を作る同期の部分は、戻ってきた時点で終わっているので、戻してよい（続きは一覧に沿って進む）。
 */
function compileOne(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.RenderTarget,
  aspect: number,
  obj: THREE.Object3D,
): Promise<void> {
  const visible = obj.visible;
  const culled = obj.frustumCulled;
  obj.visible = true;
  obj.frustumCulled = false;
  try {
    return inCaptureState(renderer, camera, target, aspect, () => renderer.compileAsync(obj, camera, scene));
  } finally {
    obj.visible = visible;
    obj.frustumCulled = culled;
  }
}

/**
 * 撮影の少し前に呼ぶ、見どころのシェーダーの下ごしらえ。撮影の描画は、画面の描画とは別の描画先（出力パスの内側の HalfFloat の領域）に
 * 描くので、three は画面で作ったシェーダーを使い回せず、見えている物すべての分を撮影の最中に作り直す（約 50ms、
 * 雨の部屋で測定）。ここで先に、同じ描画先の条件でシェーダーとパイプラインを作っておく。
 *
 * 物ごとに compileAsync を呼び、1 つずつ GPU 作業の列に入れる（three の compileAsync は物の中でも主スレッドを返しながら進める）。
 * 撮影が来たら残りを打ち切るので、撮影の待ちは作業中の物 1 つぶんで済む（足りない分は撮影が自分で作る）。
 * 小さな描画先で足りる（シェーダーは描画先の大きさに依らず、形式・多重標本・深度の有無で決まる）。
 * 失敗しても体験は止めない（撮影が自分で作り直す）。
 */
export async function prepareCapture(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: CaptureSize,
  options: PrepareOptions = {},
): Promise<void> {
  const width = PREPARE_WIDTH;
  const height = Math.max(1, Math.round((PREPARE_WIDTH * size.height) / size.width));
  const aspect = size.width / size.height;
  const job = { cancelled: false };
  prepareJobs.add(job);
  let target: THREE.RenderTarget | null = null;
  try {
    await afterFrame(); // 物の一覧を作るのも、フレームの外で
    if (job.cancelled) return;
    const objects = collectRenderables(scene, options.rooms ?? []);
    const t = createTarget(renderer, width, height);
    target = t;
    let sliceStart = performance.now();
    for (const obj of objects) {
      if (job.cancelled) break;
      // 作り済みの物は await で主スレッドを返さないまま終わるので、続けて動かしすぎないよう時間で区切る
      if (performance.now() - sliceStart >= PREPARE_SLICE_MS) {
        await afterFrame();
        sliceStart = performance.now();
      }
      await exclusively(async () => {
        if (job.cancelled || !isInScene(scene, obj)) return;
        try {
          await compileOne(renderer, scene, camera, t, aspect, obj);
        } catch {
          // 物1つの失敗で残りの下ごしらえを止めない（撮影のときにその物だけ作られる）
        }
      });
    }
  } catch {
    // 下ごしらえなので、失敗は見せない
  } finally {
    prepareJobs.delete(job);
    // 描画先は列の中で捨てる（compile の続きや撮影の描き出しと重ならないように）
    const done = target as THREE.RenderTarget | null;
    if (done) await exclusively(async () => done.dispose());
  }
}

/**
 * 撮影専用の照明の管理。three は描く物の状態（RenderObject）を「物・材質・描画先・照明」で引くので、照明の管理を別にすると、
 * 撮影の描画と画面の描画の状態が互いに触れない。同じものを使うと、VR では画面の描画が両眼のカメラ配列、撮影が単眼で、
 * シェーダーの鍵が違うため、描くたびに相手の状態を壊して作り直し合う（撮影のたびに数百 ms、次の VR のフレームでも作り直し）。
 * 中身（光源の一覧）は同じ場面から作られるので、見た目は変わらない。
 */
const captureLightings = new WeakMap<THREE.WebGPURenderer, THREE.Lighting>();

function captureLightingOf(renderer: THREE.WebGPURenderer): THREE.Lighting {
  let lighting = captureLightings.get(renderer);
  if (!lighting) {
    lighting = new THREE.Lighting();
    captureLightings.set(renderer, lighting);
  }
  return lighting;
}

/**
 * 撮影の状態（出力先 = target、撮影の縦横比、VR を切る）にして draw を呼び、renderer とカメラの状態を必ず元に戻す。
 * draw の同期の部分だけがこの状態で走る（draw が返した Promise の続きは、もう元の状態）。
 */
function inCaptureState<T>(
  renderer: THREE.WebGPURenderer,
  camera: THREE.Camera,
  target: THREE.RenderTarget,
  aspect: number,
  draw: () => T,
): T {
  const prevTarget = renderer.getRenderTarget();
  const prevOutput = renderer.getOutputRenderTarget();
  const prevLighting = renderer.lighting;
  // 乗車が VR のときは、描画が VR 用のカメラ配列に切り替わってしまうので、この間だけ切る
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
    const lighting = captureLightingOf(renderer);
    lighting.enabled = prevLighting.enabled; // 画面と同じに（three の材質の組み立てが読む）
    renderer.lighting = lighting;
    return draw();
  } finally {
    renderer.lighting = prevLighting;
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

/**
 * 次の区切りまで待つ。次のフレームの描画や入力を先に通すため。
 * scheduler.yield() は続きがすぐ（フレームの間に）走るので、区切りが 1 フレームに固まってしまう。
 * VR では window の requestAnimationFrame が止まるので、タイマーで 1 フレームぶん空ける。
 */
function pauseBetweenSlices(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SLICE_GAP_MS));
}

/**
 * 行の詰めと上下を直し、アルファを不透明にして描画面へ書く。
 * 全体を一気にやると 15MB 近くを数十 ms 動かすので、細い帯（STRIP_ROWS 行）ずつ書き、
 * SLICE_BUDGET_MS を超えたら 1 フレームぶん空ける。帯の ImageData は使い回す（15MB の確保を避ける）。
 */
async function paintRows(ctx: Ctx, src: Uint8Array, width: number, height: number, layout: Layout): Promise<void> {
  const strip = new ImageData(width, Math.min(STRIP_ROWS, height));
  const out32 = new Uint32Array(strip.data.buffer);
  const src32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
  const rowPixels = layout.strideBytes >> 2;

  let y = 0;
  let sliceStart = performance.now();
  while (y < height) {
    const rows = Math.min(STRIP_ROWS, height - y);
    for (let r = 0; r < rows; r++) {
      const from = (layout.bottomUp ? height - 1 - (y + r) : y + r) * rowPixels;
      const to = r * width;
      for (let x = 0; x < width; x++) out32[to + x] = (src32[from + x] | OPAQUE) >>> 0;
    }
    ctx.putImageData(strip, 0, y, 0, 0, width, rows);
    y += rows;
    if (y < height && performance.now() - sliceStart >= SLICE_BUDGET_MS) {
      await pauseBetweenSlices();
      sliceStart = performance.now();
    }
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
    try {
      const blob = await toBlob(surface, 'image/webp', WEBP_QUALITY);
      if (blob.type === 'image/webp') {
        webpSupported = true;
        return blob;
      }
    } catch {
      // WebP の書き出しそのものが失敗する環境でも、JPEG に切り替えて撮影は続ける
    }
    webpSupported = false;
  }
  return toBlob(surface, 'image/jpeg', JPEG_QUALITY);
}
