// 画面効果の確認ページ（dev/fx.html）。色のあるガラスの物を並べた場面に、状態のスライダーと「膜を通る」ボタンで効果をかける。
//   ?webgl                  WebGL2 で描く
//   ?bubble=1 ?membrane=1   状態を URL で固定する（bubble, membrane, kaleidoscope, angle, bloom, whiteFog, brightness）
//   ?reducedFlash           光の点滅を抑えるモード
//   ?still                  場面の動きを止める（撮影用。時刻 0 の絵になる）
//   ?panel=0                操作パネルを隠す
//   ?bench                  1フレームごとに GPU の完了を待って連続で描く（WebGPU のみ。負荷の比較用。fps が GPU 時間の逆数になる）
//   ?gondola=0              ゴンドラに似た近景（カメラの子の真鍮の輪と手すり、薄い泡の殻）を出さない
//   ?nofx                   後処理を通さず renderer.render で描く（負荷の比較用）
//   ?pulse                  読み込み後に「膜を通る」を1回流す
import * as THREE from 'three/webgpu';
import { TRANSITION_SEC } from '../../config';
import { num } from '../../core/storage';
import { createScreenFx } from '../../fx';

const q = new URLSearchParams(location.search);
const param = (key: string, min: number, max: number, fallback: number): number => {
  const raw = q.get(key);
  return raw === null || raw.trim() === '' ? fallback : num(Number(raw), fallback, min, max);
};

interface Control {
  readonly key: 'bubble' | 'membrane' | 'kaleidoscope' | 'angle' | 'bloom' | 'whiteFog' | 'brightness';
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly initial: number;
}
const CONTROLS: readonly Control[] = [
  { key: 'bubble', label: 'bubble（泡の縁）', min: 0, max: 1, step: 0.01, initial: 0 },
  { key: 'membrane', label: 'membrane（膜）', min: 0, max: 1, step: 0.01, initial: 0 },
  { key: 'kaleidoscope', label: 'kaleidoscope', min: 0, max: 1, step: 0.01, initial: 0 },
  { key: 'angle', label: 'angle（回転）', min: 0, max: 6.2832, step: 0.01, initial: 0 },
  { key: 'bloom', label: 'bloom', min: 0, max: 1, step: 0.01, initial: 0 },
  { key: 'whiteFog', label: 'whiteFog（白い霧）', min: 0, max: 1, step: 0.01, initial: 0 },
  { key: 'brightness', label: 'brightness（暗転）', min: 0, max: 1, step: 0.01, initial: 1 },
];
const values: Record<Control['key'], number> = Object.fromEntries(CONTROLS.map((c) => [c.key, param(c.key, c.min, c.max, c.initial)])) as Record<Control['key'], number>;
let reducedFlash = q.has('reducedFlash');
const still = q.has('still');

// ── 描画 ──
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: q.has('webgl') });
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const stage = document.getElementById('stage');
if (!stage) throw new Error('#stage がありません');
stage.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x56688f);
scene.fog = new THREE.Fog(0x56688f, 10, 38);
const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 200);
camera.position.set(0, 1.5, 6.5);
camera.lookAt(0, 1.4, 0);

// ── 色のあるガラスの物（透過は使わず、半透明と発光で見せる）──
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x242a38, 1.3));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
sun.position.set(-3, 6, 4);
scene.add(sun);

const glass = (color: number, opacity = 0.62, emissive = 0.18): THREE.MeshStandardNodeMaterial =>
  new THREE.MeshStandardNodeMaterial({ color, roughness: 0.12, metalness: 0.1, transparent: true, opacity, emissive: new THREE.Color(color), emissiveIntensity: emissive });
const glow = (color: number, intensity: number): THREE.MeshStandardNodeMaterial =>
  new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 0.4, emissive: new THREE.Color(color), emissiveIntensity: intensity });
const brass = new THREE.MeshStandardNodeMaterial({ color: 0xc8a050, roughness: 0.32, metalness: 0.9 });

const animated: { obj: THREE.Object3D; spin: number; bob: number; phase: number; baseY: number }[] = [];
const add = (obj: THREE.Object3D, x: number, y: number, z: number, spin = 0, bob = 0, phase = 0): void => {
  obj.position.set(x, y, z);
  scene.add(obj);
  animated.push({ obj, spin, bob, phase, baseY: y });
};

const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardNodeMaterial({ color: 0x33405c, roughness: 0.45, metalness: 0.1 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const sphereGeo = new THREE.SphereGeometry(0.55, 40, 24);
const spheres: [number, number, number, number][] = [
  [0xffb347, -2.6, 0.7, 0.5], // 琥珀
  [0x2f56e8, -1.2, 1.0, 1.2], // 瑠璃
  [0x4fd18b, 0.2, 0.8, -0.2], // 若葉
  [0xff6f9a, 1.7, 1.1, 0.8], // 桃
  [0x6fe7ff, 3.0, 0.75, 0.0], // 水
];
for (const [color, x, y, z] of spheres) add(new THREE.Mesh(sphereGeo, glass(color)), x, y, z, 0, 0.08, x);

// 発光の結び目（ブルームの見どころ。HDR で 1 を超える）
add(new THREE.Mesh(new THREE.TorusKnotGeometry(0.55, 0.16, 160, 20), glow(0xffd7a0, 3.2)), 0, 2.4, -2.5, 0.35);
add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), glow(0x9fc4ff, 2.6)), -3.4, 2.5, -1.5, 0.5);
add(new THREE.Mesh(new THREE.OctahedronGeometry(0.4, 0), glow(0xff9ad0, 2.8)), 3.6, 2.6, -1.2, -0.45);

// 色ガラスの角柱（万華鏡の折り返しで増える模様の材料）
const prismColors = [0xff7a3d, 0x3d7bff, 0x34d399, 0xf472b6, 0xfacc15, 0x8b5cf6];
prismColors.forEach((c, i) => {
  const side = i % 2 === 0 ? -1 : 1;
  const z = -1 - Math.floor(i / 2) * 2.6;
  add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 3.2 + (i % 3) * 0.6, 6), glass(c, 0.7, 0.3)), side * (4.4 + (i % 3) * 0.4), 1.7, z, 0.12);
});

// 真鍮の細い枠（奥のアーチ）
const arch = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.045, 12, 96, Math.PI), brass);
arch.position.set(0, 0.0, -5);
scene.add(arch);
const archInner = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.035, 12, 96, Math.PI), brass);
archInner.position.set(0, 0.0, -5);
scene.add(archInner);

// ゴンドラに似た近景。カメラの子にして、視点から 1.1〜1.2m に真鍮の縁・手すり・薄い泡の殻を置く。
// 万華鏡の折り返しでも消えず、回らないこと（設計書「万華鏡の間」）を確かめる。
if (param('gondola', 0, 1, 1) !== 0) {
  const proxy = new THREE.Group();
  const gold = new THREE.MeshStandardNodeMaterial({ color: 0xd8b062, roughness: 0.45, metalness: 0.3, emissive: new THREE.Color(0x3a2a10), emissiveIntensity: 0.6 });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.03, 8, 72), gold);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = -0.5;
  proxy.add(rim);
  const rail = new THREE.Mesh(new THREE.TorusGeometry(1.06, 0.018, 8, 72), gold);
  rail.rotation.x = Math.PI / 2;
  rail.position.y = -0.27;
  proxy.add(rail);
  for (const deg of [-60, -30, 0, 30, 60]) {
    const a = (deg * Math.PI) / 180;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.23, 8), gold);
    post.position.set(Math.sin(a) * 1.08, -0.385, -Math.cos(a) * 1.08);
    proxy.add(post);
  }
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 32, 16),
    new THREE.MeshStandardNodeMaterial({ color: 0xcfe6ff, roughness: 0.1, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
  );
  shell.renderOrder = 10;
  proxy.add(shell);
  camera.add(proxy);
  scene.add(camera);
}

// 星のような小さな発光玉
const starGeo = new THREE.SphereGeometry(0.032, 12, 8);
for (let i = 0; i < 60; i++) {
  const a = i * 2.399963;
  const r = 1 + (i % 9) * 0.55;
  const colors = [0xffffff, 0xffe2a8, 0xa8d0ff, 0xffb8e0];
  const star = new THREE.Mesh(starGeo, glow(colors[i % colors.length] ?? 0xffffff, 4));
  star.position.set(Math.cos(a) * r * 1.3, 0.6 + ((i * 37) % 30) * 0.12, -2 - Math.sin(a) * r);
  scene.add(star);
}

// ── 画面効果 ──
const fx = createScreenFx(renderer, { reducedFlash: () => reducedFlash });
fx.setEnabled(!q.has('nofx'));

function resize(): void {
  const w = stage?.clientWidth ?? innerWidth;
  const h = stage?.clientHeight ?? innerHeight;
  renderer.setPixelRatio(param('dpr', 0.5, 3, Math.min(devicePixelRatio, 2)));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fx.setSize(w, h, renderer.getPixelRatio());
}
addEventListener('resize', resize);
resize();

// ── 操作パネル ──
const panel = document.getElementById('panel');
const inputs = new Map<Control['key'], { input: HTMLInputElement; out: HTMLOutputElement }>();
const info = document.createElement('div');
info.className = 'info';
if (panel) {
  if (param('panel', 0, 1, 1) === 0) panel.classList.add('hidden');
  const title = document.createElement('h1');
  title.textContent = `画面効果の確認（${backend}）`;
  panel.append(title);
  for (const c of CONTROLS) {
    const row = document.createElement('label');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = c.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(c.min);
    input.max = String(c.max);
    input.step = String(c.step);
    input.value = String(values[c.key]);
    const out = document.createElement('output');
    out.textContent = values[c.key].toFixed(2);
    input.addEventListener('input', () => {
      values[c.key] = Number(input.value);
      out.textContent = values[c.key].toFixed(2);
    });
    row.append(name, input, out);
    panel.append(row);
    inputs.set(c.key, { input, out });
  }
  const flashLabel = document.createElement('label');
  flashLabel.className = 'check';
  const flash = document.createElement('input');
  flash.type = 'checkbox';
  flash.checked = reducedFlash;
  flash.addEventListener('change', () => {
    reducedFlash = flash.checked;
  });
  const flashText = document.createElement('span');
  flashText.textContent = 'reducedFlash（点滅を抑える）';
  flashLabel.append(flash, flashText);
  panel.append(flashLabel);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `膜を通る（${TRANSITION_SEC.membrane} 秒で 0→1→0）`;
  button.addEventListener('click', () => pulseMembrane());
  panel.append(button, info);
}

/** アプリの membraneAt と同じ三角の山（0 → 1 → 0） */
let pulseStart = -1;
function pulseMembrane(): void {
  pulseStart = performance.now() / 1000;
}
if (q.has('pulse')) pulseMembrane();

// ── ループ ──
let frames = 0;
let total = 0;
let fpsAt = performance.now();
let fps = 0;
const frame = (): void => {
  const now = performance.now();
  const sec = now / 1000;

  if (pulseStart >= 0) {
    const half = TRANSITION_SEC.membrane / 2;
    const d = Math.abs(sec - pulseStart - half);
    values.membrane = d < half ? 1 - d / half : 0;
    if (sec - pulseStart > TRANSITION_SEC.membrane) {
      values.membrane = 0;
      pulseStart = -1;
    }
    const m = inputs.get('membrane');
    if (m) {
      m.input.value = String(values.membrane);
      m.out.textContent = values.membrane.toFixed(2);
    }
  }

  for (const a of animated) {
    const t = still ? 0 : sec;
    a.obj.rotation.y = still ? a.spin : a.spin * t;
    a.obj.position.y = a.baseY + (still ? 0 : Math.sin(t * 0.9 + a.phase) * a.bob);
  }

  fx.state.bubble = values.bubble;
  fx.state.membrane = values.membrane;
  fx.state.kaleidoscope = values.kaleidoscope;
  fx.state.kaleidoscopeAngle = values.angle;
  fx.state.bloom = values.bloom;
  fx.state.whiteFog = values.whiteFog;
  fx.state.brightness = values.brightness;
  fx.render(scene, camera);

  frames++;
  total++;
  if (now - fpsAt >= 500) {
    fps = (frames * 1000) / (now - fpsAt);
    frames = 0;
    fpsAt = now;
    info.textContent = `${backend}  ${fps.toFixed(0)} fps  calls ${renderer.info.render.calls}`;
  }
  (globalThis as unknown as { __fxdev?: unknown }).__fxdev = { backend, fps, frames: total, renderer, values, setEnabled: (on: boolean) => fx.setEnabled(on) };
};

if (q.has('bench')) {
  // 計測用: 1フレームごとに GPU の完了を待つ（待たないと描画の指示だけが先に積み上がり、fps が GPU の速さを表さない）
  const device = (renderer.backend as { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device;
  const run = async (): Promise<void> => {
    for (;;) {
      frame();
      await device?.queue.onSubmittedWorkDone();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  void run();
} else {
  renderer.setAnimationLoop(frame);
}
