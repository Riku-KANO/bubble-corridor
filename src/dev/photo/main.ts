// ライドフォトの確認ページ（dev/photo.html）。本番ビルドには含まれない。
// 簡単な場面（ガラスの泡と光の粒）を描き、「撮る」で capturePhoto → 額縁 4 種 × 横長・正方形に composePhoto して並べる。
// 上下・左右の向きが確かめられるよう、場面は左右も上下も非対称にしてある（上は夜の青、下は夜明けの金）。
import '@fontsource/zen-old-mincho/400.css';
import * as THREE from 'three/webgpu';
import { float, hue, mix, normalize, normalView, positionLocal, positionViewDirection, pow, smoothstep, vec3 } from 'three/tsl';
import { PHOTO } from '../../config';
import type { DoorChoice, Lang } from '../../contracts/ids';
import type { FrameTier, PhotoFormat, PhotoMeta } from '../../contracts/photo';
import { capturePhoto, composePhoto, createPhotoStore, downloadPhoto, photoFileName } from '../../photo';

const params = new URLSearchParams(location.search);
const forceWebGL = params.has('webgl');
const frozen = params.has('freeze');

const el = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} がありません`);
  return e as T;
};
const statusEl = el<HTMLPreElement>('status');
const shootBtn = el<HTMLButtonElement>('shoot');
const sizeSel = el<HTMLSelectElement>('size');
const doorSel = el<HTMLSelectElement>('door');
const langSel = el<HTMLSelectElement>('lang');
const resultsEl = el<HTMLDivElement>('results');
const liveEl = el<HTMLDivElement>('live');
if (params.get('door') === 'amber') doorSel.value = 'amber';
if (params.get('lang') === 'en') langSel.value = 'en';
if (params.get('size') === 'mobile') sizeSel.value = 'mobile';

// ── 描画の準備（アプリ本体と同じ設定: ACES とsRGB） ──
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL });
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.className = 'stage';
liveEl.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
camera.position.set(0, 0, 6.5);

// ── 場面 ──
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(40, 32, 16),
  (() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    const y = normalize(positionLocal).y;
    // 上は夜の青、下は夜明けの金。上下が逆になればすぐ分かる
    m.colorNode = mix(vec3(0.95, 0.55, 0.22), vec3(0.02, 0.05, 0.17), smoothstep(-0.3, 0.5, y));
    return m;
  })(),
);
sky.renderOrder = -1;
scene.add(sky);

function bubbleMaterial(tintShift: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const fresnel = pow(float(1).sub(normalView.dot(positionViewDirection).max(0)), 2.5);
  // 縁ほど明るく、縁の色が薄膜のように移り変わる
  m.colorNode = hue(vec3(1.0, 0.5, 0.85), fresnel.mul(7).add(tintShift)).mul(fresnel.mul(1.8).add(0.06));
  return m;
}

function bubble(x: number, y: number, z: number, r: number, shift: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 32), bubbleMaterial(shift));
  mesh.position.set(x, y, z);
  scene.add(mesh);
  return mesh;
}

function orb(x: number, y: number, z: number, r: number, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshBasicNodeMaterial({ color }));
  mesh.position.set(x, y, z);
  scene.add(mesh);
  return mesh;
}

const bubbles = [bubble(0.2, -0.1, 0, 1.35, 0), bubble(1.7, 1.2, -1, 0.7, 2), bubble(-1.6, -1.4, -0.5, 0.5, 4)];
const bubbleBaseY = bubbles.map((b) => b.position.y);
orb(-2.1, 1.0, 0.5, 0.35, 0xf3a73c); // 琥珀（左上）
orb(2.0, -1.1, 0.5, 0.45, 0x3f73d9); // 瑠璃（右下）
// 左上に赤・緑・青の小さな玉を左から順に並べる（左右の向きの目印）
orb(-2.3, 1.75, 0.3, 0.07, 0xff3030);
orb(-2.1, 1.75, 0.3, 0.07, 0x30ff30);
orb(-1.9, 1.75, 0.3, 0.07, 0x3060ff);

// 光の粒（一定の乱数で毎回同じ配置）
const dust = (() => {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const count = 700;
  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.03, 6, 4),
    new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    count,
  );
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    m.makeTranslation((rand() - 0.5) * 11, (rand() - 0.5) * 6.2, (rand() - 0.5) * 5 - 1);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.setHSL(rand(), 0.7, 0.7));
  }
  scene.add(mesh);
  return mesh;
})();

// 向きの目印の札（文字は左上に読める向きで写るはず）
(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 56px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('▲ UP 上 / LEFT', 24, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.45), new THREE.MeshBasicNodeMaterial({ map: texture, transparent: true }));
  mesh.position.set(-1.45, 2.05, 0.2);
  scene.add(mesh);
})();

// ── 画面の更新（撮影中も止まらないことを、フレームの間隔で確かめる） ──
const frameGaps: number[] = [];
let lastFrameAt = 0;

function resize() {
  const w = liveEl.clientWidth;
  const h = liveEl.clientHeight;
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();
addEventListener('resize', resize);

function update(t: number) {
  bubbles.forEach((b, i) => {
    b.position.y = bubbleBaseY[i] + Math.sin(t * 0.7 + i * 2) * 0.08; // 時刻から決める（積み上げない）
    b.rotation.y = t * 0.2;
  });
  dust.rotation.y = Math.sin(t * 0.1) * 0.15;
}

renderer.setAnimationLoop((now) => {
  if (lastFrameAt > 0) frameGaps.push(now - lastFrameAt);
  lastFrameAt = now;
  if (frameGaps.length > 100_000) frameGaps.splice(0, 50_000);
  update(frozen ? 3 : now / 1000);
  renderer.render(scene, camera);
});

// ── 撮影と合成 ──
const TIERS: readonly { tier: FrameTier; hiddenTotal: number; label: string }[] = [
  { tier: 'plain', hiddenTotal: 0, label: '通常（0〜1）' },
  { tier: 'silver', hiddenTotal: 2, label: '銀（2〜3）' },
  { tier: 'gold', hiddenTotal: 4, label: '金（4）' },
  { tier: 'rainbow', hiddenTotal: 5, label: '虹色（5）' },
];
const FORMATS: readonly PhotoFormat[] = ['wide', 'square'];

interface ShootResult {
  backend: string;
  captureSize: { width: number; height: number };
  /** capturePhoto を呼んでから Promise が返るまでの同期の時間（主スレッドを止める分） */
  syncMs: number;
  /** 撮影（描画と読み出しと PNG）の全体 */
  captureMs: number;
  composeMs: number;
  rawBytes: number;
  cameraAspect: { before: number; afterSync: number; afterAll: number };
  /** 撮影の前後のフレーム間隔の最大（ms） */
  medianGapBefore: number;
  maxGapBefore: number;
  /** 撮影（描画・読み出し・PNG）の間の最大。乗車中に起きるのはここだけ */
  maxGapCapture: number;
  /** 合成 8 枚の間の最大。乗車後の保存のときにだけ起きる */
  maxGapCompose: number;
  stored: number;
}

interface PhotoDevApi {
  backend: string;
  ready: boolean;
  last: ShootResult | null;
  history: ShootResult[];
  /** 直近の撮影そのまま */
  raw: Blob | null;
  /** 直近の合成（キーは "plain-wide" など） */
  composed: Map<string, Blob>;
  shoot(): Promise<ShootResult>;
  dataUrl(key: string): Promise<string>;
  /** 撮影と画面を同じ場面で比べる（?freeze 推奨）。平均の差（撮影 − 画面、0〜255）を返す */
  compareWithLive(): Promise<{ meanAbs: number[]; meanSigned: number[] }>;
}

const store = createPhotoStore('utakata-photos-dev');
const objectUrls: string[] = [];
let rideNo = 2;

const api: PhotoDevApi = {
  backend,
  ready: true,
  last: null,
  history: [],
  raw: null,
  composed: new Map(),
  shoot,
  async dataUrl(key) {
    const blob = key === 'raw' ? api.raw : api.composed.get(key);
    if (!blob) throw new Error(`画像がありません: ${key}`);
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  },
  compareWithLive,
};
(globalThis as unknown as { __photoDev: PhotoDevApi }).__photoDev = api;

function currentMeta(hiddenTotal: number): PhotoMeta {
  return {
    rideNo: 3,
    date: '2026-10-20',
    door: doorSel.value as DoorChoice,
    hiddenTotal,
    constellations: 4,
    lang: langSel.value as Lang,
  };
}

function maxOf(a: readonly number[]): number {
  return a.reduce((m, v) => Math.max(m, v), 0);
}

function median(a: readonly number[]): number {
  if (a.length === 0) return 0;
  const sorted = [...a].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

function show(parent: HTMLElement, blob: Blob, caption: string, fileName: string) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  const fig = document.createElement('figure');
  const img = document.createElement('img');
  img.src = url;
  img.alt = caption;
  img.title = 'クリックで保存';
  img.addEventListener('click', () => downloadPhoto(blob, fileName));
  const cap = document.createElement('figcaption');
  cap.textContent = `${caption}（${(blob.size / 1024).toFixed(0)} KB）`;
  fig.append(img, cap);
  parent.append(fig);
}

async function shoot(): Promise<ShootResult> {
  shootBtn.disabled = true;
  const size = sizeSel.value === 'mobile' ? PHOTO.captureMobile : PHOTO.captureDesktop;
  statusEl.textContent = `${backend}: 撮影中… ${size.width}×${size.height}`;
  const gapsBefore = frameGaps.length;
  const aspectBefore = camera.aspect;

  const t0 = performance.now();
  const pending = capturePhoto(renderer, scene, camera, size);
  const syncMs = performance.now() - t0;
  const aspectAfterSync = camera.aspect;
  const raw = await pending;
  const captureMs = performance.now() - t0;
  const gapsAtCaptureEnd = frameGaps.length;

  const t1 = performance.now();
  const entries = TIERS.flatMap((tier) => FORMATS.map((format) => ({ tier, format })));
  const images = await Promise.all(
    entries.map(async ({ tier, format }) => ({ tier, format, blob: await composePhoto(raw, currentMeta(tier.hiddenTotal), format) })),
  );
  const composeMs = performance.now() - t1;
  const gapsCapture = frameGaps.slice(gapsBefore, gapsAtCaptureEnd);
  const gapsCompose = frameGaps.slice(gapsAtCaptureEnd);

  for (const u of objectUrls.splice(0)) URL.revokeObjectURL(u);
  resultsEl.replaceChildren();
  api.raw = raw;
  api.composed.clear();
  show(resultsEl, raw, `撮影そのまま ${size.width}×${size.height}`, 'utakata-raw.png');
  for (const { tier, format, blob } of images) {
    api.composed.set(`${tier.tier}-${format}`, blob);
    const meta = currentMeta(tier.hiddenTotal);
    show(resultsEl, blob, `${tier.label} ${format === 'wide' ? '横長 1920×1080' : '正方形 1080×1080'}`, photoFileName(meta, 'constellation', format));
  }

  rideNo += 1;
  await store.put({
    id: `dev-${rideNo}-${Date.now()}`,
    createdAt: Date.now(),
    meta: currentMeta(0),
    shots: [{ shot: 'constellation', image: raw }],
    chosen: 'constellation',
  });
  const stored = (await store.list()).length;

  const result: ShootResult = {
    backend,
    captureSize: { width: size.width, height: size.height },
    syncMs,
    captureMs,
    composeMs,
    rawBytes: raw.size,
    cameraAspect: { before: aspectBefore, afterSync: aspectAfterSync, afterAll: camera.aspect },
    medianGapBefore: median(frameGaps.slice(Math.max(0, gapsBefore - 120), gapsBefore)),
    maxGapBefore: maxOf(frameGaps.slice(Math.max(0, gapsBefore - 120), gapsBefore)),
    maxGapCapture: maxOf(gapsCapture),
    maxGapCompose: maxOf(gapsCompose),
    stored,
  };
  api.last = result;
  api.history.push(result);
  statusEl.textContent = [
    `${backend}  撮影 ${size.width}×${size.height}  PNG ${(raw.size / 1048576).toFixed(2)} MB`,
    `同期の時間 ${syncMs.toFixed(1)} ms / 撮影の全体 ${captureMs.toFixed(0)} ms / 合成 8 枚 ${composeMs.toFixed(0)} ms`,
    `フレーム間隔: 撮影前 中央値 ${result.medianGapBefore.toFixed(1)} ms・最大 ${result.maxGapBefore.toFixed(1)} ms → 撮影の間の最大 ${result.maxGapCapture.toFixed(1)} ms / 合成の間の最大 ${result.maxGapCompose.toFixed(1)} ms`,
    `カメラの縦横比: 撮影前 ${aspectBefore.toFixed(4)} / 撮影の呼び出し直後 ${aspectAfterSync.toFixed(4)} / 完了後 ${camera.aspect.toFixed(4)}`,
    `棚（IndexedDB）: ${stored} 件`,
  ].join('\n');
  shootBtn.disabled = false;
  return result;
}

async function compareWithLive(): Promise<{ meanAbs: number[]; meanSigned: number[] }> {
  if (!api.raw) throw new Error('先に撮影してください');
  const W = 320;
  const H = 180;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D キャンバスを作れません');
  // 画面の絵は描いた直後の同じタスクの中で読む（WebGPU のキャンバスは次のフレームで入れ替わる）
  update(frozen ? 3 : performance.now() / 1000);
  renderer.render(scene, camera);
  ctx.drawImage(renderer.domElement, 0, 0, W, H);
  const live = ctx.getImageData(0, 0, W, H).data;
  const bmp = await createImageBitmap(api.raw);
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  const shot = ctx.getImageData(0, 0, W, H).data;
  const abs = [0, 0, 0];
  const signed = [0, 0, 0];
  for (let i = 0; i < live.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = shot[i + c] - live[i + c];
      abs[c] += Math.abs(d);
      signed[c] += d;
    }
  }
  const n = W * H;
  return { meanAbs: abs.map((v) => v / n), meanSigned: signed.map((v) => v / n) };
}

shootBtn.disabled = false;
shootBtn.addEventListener('click', () => {
  shoot().catch((err: unknown) => {
    console.error(err);
    statusEl.textContent = `失敗: ${String(err)}`;
    shootBtn.disabled = false;
  });
});
statusEl.textContent = `${backend}: 準備できました。「撮る」を押してください`;
