// core 確認ページ（S-12）。ガラス6種を球・板・泡の形で並べ、曇りと指の文字を見せる。
// 夜明け前の青と朝の色の背景の上で、ゆっくり回して縁の反射と虹色の流れを確かめる。
// ?webgl で WebGL2、?tier=low|medium|high で品質、?solo=<種類>、?still&t=12（撮影用に止める）、?fog=0。
import '@fontsource/zen-old-mincho/400.css';
import '@fontsource/noto-sans-jp/400.css';
import '../../styles/base.css';
import './dev.css';
import * as THREE from 'three/webgpu';
import { float, length, mix, screenSize, screenUV, smoothstep, vec2, vec3 } from 'three/tsl';
import { createCondensation, type Condensation } from '../../core/fog/condensation';
import {
  createBrass,
  createGlass,
  resetGlassLighting,
  setDefaultGlassTier,
  setGlassFlashScale,
  setGlassLighting,
  type GlassHandle,
  type GlassKind,
  type GlassParams,
} from '../../core/materials/glass';
import { DynamicResolution, detectTier, presetFor, type DeviceHints, type QualityTier } from '../../core/quality';

const KINDS: readonly GlassKind[] = ['clear', 'frosted', 'tinted', 'iridescent', 'milky', 'mirror'];
const KIND_LABEL: Record<GlassKind, string> = {
  clear: '透明 clear',
  frosted: '曇り frosted',
  tinted: '色 tinted',
  iridescent: '虹色 iridescent',
  milky: '乳白 milky',
  mirror: '鏡 mirror',
};

const params = new URLSearchParams(location.search);
const still = params.has('still');
let fixedT = Number(params.get('t') ?? 12);
const soloParam = params.get('solo');
const solo = KINDS.includes(soloParam as GlassKind) ? (soloParam as GlassKind) : null;

// ── 小さな DOM 道具（生の HTML は挿入しない） ──
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const c of children) el.append(c);
  return el;
}

// ── 描画 ──
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const canvas = renderer.domElement;
canvas.className = 'stage';
document.querySelector('#app')!.append(canvas);

// 端末の手がかりから品質を決める（?tier= で上書き）
function gpuName(): string | undefined {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : undefined;
  } catch {
    return undefined;
  }
}
const hints: DeviceHints = {
  isMobile: matchMedia('(pointer: coarse)').matches,
  isXR: false,
  gpu: gpuName(),
  hardwareConcurrency: navigator.hardwareConcurrency,
  screenPixels: screen.width * screen.height * devicePixelRatio * devicePixelRatio,
};
const tierParam = params.get('tier');
let tier: QualityTier = tierParam === 'low' || tierParam === 'medium' || tierParam === 'high' ? tierParam : detectTier(hints);
let preset = presetFor(tier, hints);
let dynRes = new DynamicResolution(preset);
setDefaultGlassTier(tier);

// ── 背景: 夜明け前の青 → 朝の色。ぼんやりした灯りを置く ──
const scene = new THREE.Scene();
{
  const up = float(1).sub(screenUV.y); // screenUV は上が 0。ここでは 0 = 下、1 = 上
  const aspect = screenSize.x.div(screenSize.y);
  const night = vec3(0.004, 0.012, 0.06);
  const blue = vec3(0.03, 0.09, 0.26);
  const dawn = vec3(0.55, 0.3, 0.3);
  const morning = vec3(1.0, 0.62, 0.36);
  let col = mix(morning, dawn, smoothstep(0.0, 0.3, up));
  col = mix(col, blue, smoothstep(0.22, 0.62, up));
  col = mix(col, night, smoothstep(0.55, 1.0, up));
  // 低い朝日の滲み（右下）
  const suv = vec2(screenUV.x, up);
  const sun = float(1).sub(smoothstep(0.0, 0.7, length(suv.sub(vec2(0.78, 0.1)).mul(vec2(aspect, 1)))));
  col = col.add(vec3(1.0, 0.55, 0.25).mul(sun.pow(2.2)).mul(0.7));
  // ぼんやりした灯り（ガラスを透かして見える）
  const lamps: [number, number, number, number, number, number][] = [
    [0.12, 0.62, 0.05, 1.0, 0.75, 0.45],
    [0.3, 0.8, 0.035, 0.6, 0.75, 1.0],
    [0.52, 0.7, 0.045, 1.0, 0.85, 0.6],
    [0.66, 0.86, 0.03, 0.7, 0.8, 1.0],
    [0.88, 0.66, 0.055, 1.0, 0.7, 0.5],
    [0.2, 0.34, 0.04, 1.0, 0.8, 0.55],
    [0.46, 0.4, 0.03, 0.8, 0.9, 1.0],
    [0.93, 0.4, 0.04, 1.0, 0.75, 0.5],
  ];
  for (const [x, y, r, cr, cg, cb] of lamps) {
    const d = length(suv.sub(vec2(x, y)).mul(vec2(aspect, 1)));
    col = col.add(vec3(cr, cg, cb).mul(float(1).sub(smoothstep(r * 0.55, r, d))).mul(0.65));
  }
  scene.backgroundNode = col;
}

// ── 反射用の環境画像: 夜明けの空と、窓のような明るい面（動く光源は持たず、画像で反射させる） ──
function makeEnvironment(): THREE.CanvasTexture {
  const w = 1024;
  const h2 = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h2;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, h2);
  sky.addColorStop(0, '#0a1a44');
  sky.addColorStop(0.35, '#3a5f9a');
  sky.addColorStop(0.5, '#ffc89a');
  sky.addColorStop(0.58, '#ffe2bd');
  sky.addColorStop(0.62, '#7a6a78');
  sky.addColorStop(1, '#21263d');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h2);
  // 窓の面（柔らかい白）
  const panel = (x: number, y: number, pw: number, ph: number, a: number) => {
    g.fillStyle = `rgba(255,248,235,${a})`;
    g.beginPath();
    g.roundRect(x, y, pw, ph, 14);
    g.fill();
  };
  panel(130, 120, 110, 190, 0.95);
  panel(330, 150, 70, 150, 0.8);
  panel(620, 100, 150, 210, 0.9);
  panel(860, 140, 60, 170, 0.7);
  panel(0, 40, 1024, 24, 0.35);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.environment = makeEnvironment();
scene.environmentIntensity = 1.25;

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

// ── 擬似反射の照明: 部屋の空気に合わせて変える（天球は藍と星の白金、温室は若葉と朝日） ──
const lightParam = params.get('light') ?? 'dawn';
function applyLighting(name: string): void {
  if (name === 'celestial') {
    setGlassLighting({ sky: 0x1b2a66, ground: 0x0a0d24, keyDir: { x: 0.1, y: 1, z: 0.2 }, keyColor: 0xffe9b0, keyIntensity: 0.9 });
  } else if (name === 'greenhouse') {
    setGlassLighting({ sky: 0xcfe9b8, ground: 0x7a8a4a, keyDir: { x: 0.55, y: 0.75, z: 0.35 }, keyColor: 0xfff2c8, keyIntensity: 1 });
  } else {
    resetGlassLighting();
  }
}
applyLighting(lightParam);

// ── 霧: ?mist=近,遠（例 ?mist=5,26）。ガラスが霧に溶けるかを確かめる ──
const mistParam = params.get('mist');
if (mistParam) {
  const [near, far] = mistParam.split(',').map(Number);
  const color = new THREE.Color(0xdfe9d8); // 温室の霧の色
  scene.backgroundNode = null;
  scene.background = color;
  scene.fog = new THREE.Fog(color, near || 5, far || 26);
}

// ── ガラスの並び: 球（上段）・板（中段）・泡（下段）。真鍮の枠付き ──
function roundedPlate(w: number, hgt: number, depth: number, r: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -hgt / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + hgt - r);
  s.absarc(x + w - r, y + hgt - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + hgt);
  s.absarc(x + r, y + hgt - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 8, curveSegments: 24 });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

interface Piece {
  readonly kind: GlassKind;
  readonly mesh: THREE.Mesh;
  readonly double: boolean;
  readonly params: GlassParams;
  handle: GlassHandle;
}
const pieces: Piece[] = [];
const spinners: { obj: THREE.Object3D; speed: number; phase: number; tilt: number }[] = [];
const brass = createBrass();
const world = new THREE.Group();
scene.add(world);

const kinds = solo ? [solo] : KINDS;
const colSpacing = solo ? 3.4 : 2.1;
const rowY = solo ? [1.75, 0, -1.75] : [1.65, 0, -1.65];
const scaleAll = solo ? 1.5 : 1;

const sphereGeo = new THREE.SphereGeometry(0.82, 72, 48);
const bubbleGeo = new THREE.SphereGeometry(0.8, 72, 48);
const innerGeo = new THREE.SphereGeometry(0.3, 48, 32);
const plateGeo = roundedPlate(1.2, 1.55, 0.12, 0.3);
const ringGeo = new THREE.TorusGeometry(0.9, 0.014, 16, 128);
const barV = new THREE.CapsuleGeometry(0.016, 1.62, 6, 12);
const barH = new THREE.CapsuleGeometry(0.016, 1.27, 6, 12);

kinds.forEach((kind, i) => {
  const x = (i - (kinds.length - 1) / 2) * colSpacing;
  const add = (geo: THREE.BufferGeometry, y: number, double: boolean, parent: THREE.Object3D = world, pos?: THREE.Vector3, extra: GlassParams = {}): Piece => {
    const params: GlassParams = { ...extra, ...(double ? { doubleSided: true } : {}) };
    const handle = createGlass(kind, params, { tier });
    const mesh = new THREE.Mesh(geo, handle.material);
    mesh.renderOrder = 1;
    if (pos) mesh.position.copy(pos);
    else mesh.position.set(x, y, 0);
    parent.add(mesh);
    const piece: Piece = { kind, mesh, double, params, handle };
    pieces.push(piece);
    return piece;
  };

  // 上段: 球 ＋ 真鍮の輪
  const sphere = add(sphereGeo, rowY[0], false);
  const ring = new THREE.Mesh(ringGeo, brass);
  ring.position.set(x, rowY[0], 0);
  ring.rotation.x = Math.PI / 2 + 0.35;
  world.add(ring);
  spinners.push({ obj: sphere.mesh, speed: 0.22, phase: i, tilt: 0 }, { obj: ring, speed: -0.1, phase: i, tilt: 0 });

  // 中段: 板 ＋ 真鍮の枠
  const plateGroup = new THREE.Group();
  plateGroup.position.set(x, rowY[1], 0);
  world.add(plateGroup);
  // 虹色の板は部屋の境目の「膜」: 面全体に色を出す（face を上げる）。球や泡は既定の、縁だけで見せる
  const plate = add(plateGeo, 0, false, plateGroup, new THREE.Vector3(), kind === 'iridescent' ? { face: 0.6 } : {});
  for (const [bx, by, geo, rot] of [
    [-0.64, 0, barV, 0],
    [0.64, 0, barV, 0],
    [0, 0.81, barH, Math.PI / 2],
    [0, -0.81, barH, Math.PI / 2],
  ] as const) {
    const bar = new THREE.Mesh(geo, brass);
    bar.position.set(bx, by, 0);
    bar.rotation.z = rot;
    plateGroup.add(bar);
  }
  spinners.push({ obj: plateGroup, speed: 0.3, phase: i * 0.9, tilt: 0.16 });
  void plate;

  // 下段: 泡（両面の殻）の中に小さな玉。ガラスの中のガラス
  const bubbleGroup = new THREE.Group();
  bubbleGroup.position.set(x, rowY[2], 0);
  world.add(bubbleGroup);
  add(bubbleGeo, 0, true, bubbleGroup, new THREE.Vector3());
  add(innerGeo, 0, false, bubbleGroup, new THREE.Vector3(0.18, -0.12, 0.1));
  spinners.push({ obj: bubbleGroup, speed: 0.18, phase: i * 0.5, tilt: 0.1 });
});
world.scale.setScalar(scaleAll);

// ── 操作の画面 ──
const labels = kinds.map((k) => {
  const el = h('div', { class: 'kind' }, KIND_LABEL[k]);
  document.body.append(el);
  return el;
});

const panel = h('div', { class: 'panel' });
const stat = h('div', { class: 'stat' });
const highlightInput = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '0' });
const highlightValue = h('span', { class: 'stat' }, '0.00');
const spinBox = h('input', { type: 'checkbox', checked: !still });
const tierSelect = h('select');
for (const t of ['low', 'medium', 'high'] as const) tierSelect.append(h('option', { value: t, selected: t === tier }, t));
panel.append(
  h('h1', {}, 'core 確認ページ'),
  stat,
  h('label', {}, '縁の光', highlightInput, highlightValue),
  h('div', { class: 'row' }, h('button', { type: 'button', textContent: '波紋', onclick: () => pulseAll() }), h('label', {}, spinBox, '回す'), h('label', {}, '品質', tierSelect)),
);
const lightSelect = h('select');
for (const [v, label] of [
  ['dawn', '夜明け（既定）'],
  ['celestial', '天球'],
  ['greenhouse', '温室'],
] as const)
  lightSelect.append(h('option', { value: v, selected: v === lightParam }, label));
const flashInput = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1' });
panel.append(h('div', { class: 'row' }, h('label', {}, '擬似照明', lightSelect), h('label', {}, '閃光', flashInput)));
const fogButtons = h('div', { class: 'row' });
panel.append(fogButtons);
document.body.append(panel);

// ── 曇りと指の文字 ──
const fogW = Math.min(520, innerWidth - 40);
const fogH = 150;
const fogOn = params.get('fog') !== '0';
const fog: Condensation = createCondensation({ width: fogW, height: fogH, dpr: Math.min(devicePixelRatio, 2) });
fog.canvas.classList.add('fog');
if (fogOn) document.body.append(fog.canvas);
// 3D の立て札: 同じ効果を CanvasTexture にして板に貼る（autoTick: false で、毎フレーム tick を呼ぶ）
let fog3d: Condensation | null = null;
if (fogOn && !solo) {
  let fogTexture: THREE.CanvasTexture | null = null;
  fog3d = createCondensation({
    width: 640,
    height: 200,
    dpr: 1.5,
    autoTick: false,
    onDraw: () => {
      if (fogTexture) fogTexture.needsUpdate = true;
    },
  });
  fogTexture = new THREE.CanvasTexture(fog3d.canvas);
  fogTexture.colorSpace = THREE.SRGBColorSpace;
  const signMat = new THREE.MeshBasicNodeMaterial({ map: fogTexture, transparent: true, depthWrite: false });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 0.94), signMat);
  sign.position.set(-0.9, -3.45, 0.4);
  sign.renderOrder = 2;
  scene.add(sign);
  // 曇りの向こう（外の景色の代わりの濃い青）。澄んだ線が読めるかを確かめる
  const backing = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 0.94), new THREE.MeshBasicNodeMaterial({ color: 0x244a88 }));
  backing.position.set(-0.9, -3.45, 0.35);
  scene.add(backing);
}
const FOG_TEXT = ['触れると、', '鳴ります'];
const wait = (sec: number) => new Promise<void>((r) => setTimeout(r, sec * 1000));
const WRITE_FONT = '400 40px var(--font-serif)';
const both = (fn: (f: Condensation) => Promise<void>) => Promise.all([fn(fog), fog3d ? fn(fog3d) : Promise.resolve()]).then(() => undefined);
let demoOn = !params.has('fogdemo') || params.get('fogdemo') === 'auto';
async function demoLoop(): Promise<void> {
  for (;;) {
    if (!demoOn) {
      await wait(0.3);
      continue;
    }
    await both((f) => f.fogIn(1.4));
    await wait(0.3);
    await both((f) => f.write(FOG_TEXT, { durationSec: 2.6, font: WRITE_FONT }));
    await wait(2.4);
    await both((f) => f.erase(1.4));
    await wait(0.5);
    await both((f) => f.clear(1.4));
    await wait(1.0);
  }
}
for (const [label, run] of [
  ['曇らせる', () => both((f) => f.fogIn(1.4))],
  ['書く', () => both((f) => f.write(FOG_TEXT, { durationSec: 2.6, font: WRITE_FONT }))],
  ['消す', () => both((f) => f.erase(1.4))],
  ['晴らす', () => both((f) => f.clear(1.4))],
] as const) {
  fogButtons.append(
    h('button', {
      type: 'button',
      textContent: label,
      onclick: () => {
        demoOn = false;
        void run();
      },
    }),
  );
}
fogButtons.append(h('button', { type: 'button', textContent: '自動', onclick: () => (demoOn = true) }));
if (fogOn && !(params.get('fogdemo') === 'manual')) void demoLoop();

// ── 操作 ──
const slider = () => Number(highlightInput.value);
let hovered: Piece | null = null;
const clockNow = () => (still ? fixedT : performance.now() / 1000);

function pulseAll(): void {
  const t = clockNow();
  for (const p of pieces) p.handle.pulse(t);
}

lightSelect.addEventListener('change', () => applyLighting(lightSelect.value));
flashInput.addEventListener('input', () => setGlassFlashScale(Number(flashInput.value)));
highlightInput.addEventListener('input', () => (highlightValue.textContent = slider().toFixed(2)));
tierSelect.addEventListener('change', () => {
  tier = tierSelect.value as QualityTier;
  // 品質を替えたら、プリセットと動的な解像度も作り直す（目標の fps・倍率の範囲が変わる）
  preset = presetFor(tier, hints);
  dynRes = new DynamicResolution(preset);
  appliedScale = dynRes.scale;
  setDefaultGlassTier(tier);
  for (const p of pieces) {
    p.handle.dispose();
    p.handle = createGlass(p.kind, p.params, { tier });
    p.mesh.material = p.handle.material;
  }
  resize();
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function pick(ev: PointerEvent): THREE.Intersection | null {
  pointer.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(
    pieces.map((p) => p.mesh),
    false,
  )[0];
  return hit ?? null;
}
canvas.addEventListener('pointermove', (ev) => {
  const hit = pick(ev);
  hovered = hit ? (pieces.find((p) => p.mesh === hit.object) ?? null) : null;
});
canvas.addEventListener('pointerdown', (ev) => {
  const hit = pick(ev);
  const p = hit ? pieces.find((q) => q.mesh === hit.object) : null;
  if (p && hit) p.handle.pulse(clockNow(), hit.point);
});

// ── 大きさと位置合わせ ──
function resize(): void {
  const w = innerWidth;
  const hh = innerHeight;
  const ratio = Math.min(devicePixelRatio, preset.maxPixelRatio) * dynRes.scale;
  renderer.setPixelRatio(ratio);
  renderer.setSize(w, hh, false);
  camera.aspect = w / hh;
  // 全体が収まる距離。下に操作の画面と曇りの帯を置くので、その分の余白を取る
  const reserve = 2.3;
  const top = (rowY[0] + 1.3) * scaleAll;
  const bottom = (rowY[2] - 1.3 - reserve) * scaleAll;
  const spanX = kinds.length * colSpacing * scaleAll + 0.8;
  const halfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const fitH = (top - bottom) / 2 / halfFov;
  const fitW = spanX / 2 / (halfFov * camera.aspect);
  const dist = Math.max(fitH, fitW);
  const yc = (top + bottom) / 2;
  camera.position.set(0, yc, dist);
  camera.lookAt(0, yc, 0);
  camera.updateProjectionMatrix();
  const v = new THREE.Vector3();
  labels.forEach((el, i) => {
    const x = (i - (kinds.length - 1) / 2) * colSpacing * scaleAll;
    v.set(x, (rowY[0] + 1.1) * scaleAll, 0).project(camera);
    el.style.left = `${((v.x + 1) / 2) * w}px`;
    el.style.top = `${((1 - v.y) / 2) * hh - 14}px`;
  });
}
addEventListener('resize', resize);
resize();

// ── 毎フレーム ──
let last = performance.now();
let fps = 0;
let appliedScale = dynRes.scale;
let statTimer = 0;
function frame(): void {
  const nowMs = performance.now();
  const dt = nowMs - last;
  last = nowMs;
  fps = fps === 0 ? 1000 / dt : fps * 0.95 + (1000 / dt) * 0.05;

  const t = clockNow();
  const spin = spinBox.checked && !still;
  for (const s of spinners) {
    if (still) {
      s.obj.rotation.y = s.phase * 0.5 + 0.6;
      s.obj.rotation.x = s.tilt * 0.6;
    } else if (spin) {
      s.obj.rotation.y = t * s.speed + s.phase;
      s.obj.rotation.x = Math.sin(t * 0.35 + s.phase) * s.tilt;
    }
  }
  const lvl = slider();
  for (const p of pieces) {
    p.handle.setTime(t);
    p.handle.setHighlight(Math.max(lvl, p === hovered ? 1 : 0));
  }
  if (!still) {
    // 動的な解像度: 目標の fps を保てなければ描画の細かさを下げる
    const s = dynRes.sample(dt);
    if (s !== appliedScale) {
      appliedScale = s;
      resize();
    }
  }
  fog3d?.tick(performance.now() / 1000);
  renderer.render(scene, camera);
  if (nowMs - statTimer > 400) {
    statTimer = nowMs;
    stat.textContent = `${backend} · tier ${tier} · ${fps.toFixed(0)}fps · 解像度 ${(appliedScale * 100).toFixed(0)}% · 目標 ${preset.targetFps}fps`;
  }
}
renderer.setAnimationLoop(frame);

// 確認用の手がかり（撮影の脚本から使う）
Object.assign(globalThis, {
  __core: {
    backend,
    get tier() {
      return tier;
    },
    pulseAll,
    pieces,
    fog,
    fog3d,
    setDemo: (on: boolean) => (demoOn = on),
    /** ?still のとき、ガラスの時刻を進める（波紋や虹色の流れを決まった時刻で撮る） */
    setTime: (t: number) => (fixedT = t),
    ready: true,
  },
});
