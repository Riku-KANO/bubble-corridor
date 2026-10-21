// 部屋B の確認ページ（dev/rooms-b.html）。雨の回廊と万華鏡の間を、本番と同じレール・ゴンドラ・画面効果で単独に動かす。
// クリックと見つめる（中央で 1.2 秒）で触れられる（src/input の触れる入力をそのまま使う）。
//   ?t=310          乗車の秒（既定は雨の回廊の頭）
//   ?rate=1         時刻の速さ（0 で止める。撮影は 0）
//   ?door=amber     扉（金の万華鏡）。lapis で青
//   ?gentle         穏やかモード（万華鏡の模様の回転を止める）
//   ?yaw=30&pitch=10  見回し（度。左が正）
//   ?nofx           画面効果を通さない
//   ?webgl          WebGL2 で描く
//   ?q=low          品質（粒の数）
//   ?panel=0        操作パネルを隠す
//   ?pick=amber@352 その時刻に扉に触れる（扉が開く見た目の確認。shard-03@400 のようにガラス片にも触れられる）。
//                   amber@351,lapis@351.3,amber@351.6 のように並べると順に触れる（交互に選ぶ確認）
//   ?look=shard-08  その触れられる物の方を向き続ける（触れた反応を真ん中で見る）。?fov=30 で視野角を狭める
import * as THREE from 'three/webgpu';
import { CAMERA, SECTIONS, SEC_PER_BAR } from '../../config';
import type { RideEvents } from '../../contracts/events';
import type { ComfortMode, DoorChoice, SectionId } from '../../contracts/ids';
import type { RidePose } from '../../contracts/ride';
import type { RoomContext, RoomFrame, RoomModule } from '../../contracts/room';
import { createAssetLoader } from '../../app/assets';
import { loadRideData } from '../../app/ride-data';
import { createBus } from '../../core/events';
import { smoothstep } from '../../core/easing';
import { num } from '../../core/storage';
import { createScreenFx } from '../../fx';
import { createGondola } from '../../gondola';
import { createTouchInput } from '../../input';
import { buildCueSheet, createRide, generateRideData } from '../../ride';
import { createKaleidoscopeRoom } from '../../rooms/kaleidoscope';
import { createRainRoom } from '../../rooms/rain';

const q = new URLSearchParams(location.search);
const sectionStart = (id: SectionId) => (SECTIONS.find((s) => s.id === id)?.startBar ?? 0) * SEC_PER_BAR;
const T_MIN = sectionStart('rain') - 8;
const T_MAX = sectionStart('celestial') + 4;
let t = num(Number(q.get('t') ?? NaN), sectionStart('rain') + 2, T_MIN, T_MAX);
let rate = num(Number(q.get('rate') ?? NaN), 1, 0, 30);
let door: DoorChoice = q.get('door') === 'amber' ? 'amber' : 'lapis';
let comfort: ComfortMode = q.has('gentle') ? 'gentle' : 'standard';
let fxOn = !q.has('nofx');
const tier = (['low', 'medium', 'high'] as const).find((x) => x === q.get('q')) ?? 'high';
const lookYaw = THREE.MathUtils.degToRad(num(Number(q.get('yaw') ?? 0), 0, -120, 120));
const lookPitch = THREE.MathUtils.degToRad(num(Number(q.get('pitch') ?? 0), 0, -60, 60));

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
const camera = new THREE.PerspectiveCamera(num(Number(q.get('fov') ?? NaN), CAMERA.fovDeg, 10, 120), 1, 0.05, 2000);
const gondola = createGondola();
scene.add(gondola.root);
gondola.seat.add(camera);
gondola.setShell(1);
const fx = createScreenFx(renderer);
fx.setEnabled(fxOn);

// ── 部屋 ──
const ride = createRide((await loadRideData()) ?? generateRideData());
const cues = buildCueSheet();
const bus = createBus<RideEvents>();
const log: string[] = [];
const say = (s: string) => {
  log.unshift(s);
  log.length = Math.min(log.length, 4);
};
bus.on('doorChosen', (e) => {
  say(`doorChosen ${e.door}（${e.by}）`);
  door = e.door;
  for (const r of rooms) r.setDoor?.(door);
});
bus.on('hiddenFound', (e) => say(`hiddenFound ${e.section}`));
const ctx: RoomContext = {
  ride,
  assets: createAssetLoader(),
  events: bus,
  quality: {
    tier,
    maxPixelRatio: 2,
    renderScale: 1,
    minRenderScale: 0.6,
    targetFps: 60,
    postFx: true,
    particleScale: tier === 'high' ? 1 : tier === 'medium' ? 0.7 : 0.4,
    envMapSize: 512,
    antialias: true,
  },
  comfort: () => comfort,
  reducedFlash: () => false,
  suggestedDoor: null,
  hiddenAlreadyFound: false,
};
const rain = createRainRoom();
const kaleidoscope = createKaleidoscopeRoom();
const rooms: RoomModule[] = [rain, kaleidoscope];
await Promise.all(rooms.map((r) => r.load(ctx)));
for (const r of rooms) {
  r.setDoor?.(door);
  scene.add(r.root);
}

// ── 触れる ──
const touch = createTouchInput({ element: renderer.domElement, events: bus, now: () => t });
touch.setTouchables(rooms.flatMap((r) => r.touchables));
touch.setEnabled(true);
bus.on('touch', (e) => say(`touch ${e.touchableId}`));

// 確認用の自動の「触れる」
const picks: { id: string; at: number }[] = (q.get('pick') ?? '')
  .split(',')
  .map((x) => /^([a-z0-9-]+)@([0-9.]+)$/.exec(x.trim()))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => ({ id: m[1], at: Number(m[2]) }))
  .sort((a, b) => a.at - b.at);
function autoPick() {
  while (picks.length > 0 && t >= picks[0].at) pickOne(picks.shift()!);
}
function pickOne({ id, at }: { id: string; at: number }) {
  const target = rooms.flatMap((r) => r.touchables).find((x) => x.id.endsWith(`/${id}`) || x.id.endsWith(`/door-${id}`));
  if (!target) return;
  const p = target.object.getWorldPosition(new THREE.Vector3());
  // 触れた時刻は指定の時刻（止めた時計でも、その後の見た目になる）
  target.onTouch({ t: at, source: 'pointer', point: [p.x, p.y, p.z] });
  say(`(auto) ${target.id}`);
}

// 確認用: 触れられる物の方を向き続ける
const lookId = q.get('look');
const aimTmp = new THREE.Vector3();
function aimAt() {
  if (!lookId) return;
  const target = rooms.flatMap((r) => r.touchables).find((x) => x.id.endsWith(`/${lookId}`));
  if (!target) return;
  gondola.root.updateMatrixWorld(true);
  target.object.getWorldPosition(aimTmp);
  gondola.seat.worldToLocal(aimTmp);
  camera.rotation.set(Math.atan2(aimTmp.y, Math.hypot(aimTmp.x, aimTmp.z)), Math.atan2(-aimTmp.x, -aimTmp.z), 0, 'YXZ');
}

// ── 操作パネル ──
const panel = document.getElementById('panel') as HTMLElement;
if (q.get('panel') === '0') panel.classList.add('hidden');
const h1 = document.createElement('h1');
h1.textContent = '部屋B（雨の回廊・万華鏡の間）';
panel.append(h1);
const row = document.createElement('div');
row.className = 'row';
const label = document.createElement('span');
label.textContent = '時刻';
const slider = document.createElement('input');
slider.type = 'range';
slider.min = String(T_MIN);
slider.max = String(T_MAX);
slider.step = '0.1';
const out = document.createElement('output');
row.append(label, slider, out);
panel.append(row);
slider.addEventListener('input', () => {
  t = Number(slider.value);
});
const buttons = document.createElement('div');
buttons.className = 'buttons';
panel.append(buttons);
const button = (text: string, on: () => void, pressed?: () => boolean) => {
  const b = document.createElement('button');
  b.textContent = text;
  b.addEventListener('click', () => {
    on();
    refresh();
  });
  buttons.append(b);
  return { b, pressed };
};
const marks: [string, number][] = [
  ['入口', sectionStart('rain') + 1],
  ['中庭', 290],
  ['5:10 止まる', 310],
  ['5:50 扉', 350],
  ['万華鏡', 366],
  ['7:20 花', 440],
];
const all = [
  ...marks.map(([name, at]) => button(name, () => (t = at))),
  button('▶ / ❚❚', () => (rate = rate === 0 ? 1 : 0), () => rate !== 0),
  button('琥珀', () => setDoor('amber'), () => door === 'amber'),
  button('瑠璃', () => setDoor('lapis'), () => door === 'lapis'),
  button('穏やか', () => (comfort = comfort === 'gentle' ? 'standard' : 'gentle'), () => comfort === 'gentle'),
  button('画面効果', () => fx.setEnabled((fxOn = !fxOn)), () => fxOn),
];
const info = document.createElement('div');
info.className = 'info';
panel.append(info);
function setDoor(d: DoorChoice) {
  door = d;
  for (const r of rooms) r.setDoor?.(d);
}
function refresh() {
  for (const x of all) if (x.pressed) x.b.setAttribute('aria-pressed', String(x.pressed()));
}
refresh();

// ── 毎フレーム ──
const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'rain', sectionProgress: 0 };
let lastNow = performance.now();
let fps = 0;
let frames = 0;
let fpsAt = lastNow;
let currentAtm: RoomModule['atmosphere'] | null = null;
let cueIndex = cues.findIndex((c) => c.t >= t);
function resize() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  fx.setSize(innerWidth, innerHeight, renderer.getPixelRatio());
}
addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  const prevT = t;
  t = Math.min(T_MAX, t + dt * rate);
  if (t < prevT) cueIndex = cues.findIndex((c) => c.t >= t);
  while (cueIndex >= 0 && cueIndex < cues.length && cues[cueIndex].t <= t) {
    for (const r of rooms) r.onCue(cues[cueIndex]);
    cueIndex++;
  }
  ride.poseAt(t, comfort, pose);
  gondola.root.position.set(pose.x, pose.y, pose.z);
  gondola.root.rotation.set(0, pose.yaw, 0);
  gondola.update(now / 1000, dt);
  camera.rotation.set(lookPitch, lookYaw, 0, 'YXZ');
  aimAt();
  autoPick();
  const frame: RoomFrame = { t, dt: dt * rate, pose, camera, comfort, reducedFlash: false };
  for (const r of rooms) r.update(frame);
  touch.update(t, dt * rate, camera, [pose.x, pose.y, pose.z]);
  const atm = (pose.section === 'kaleidoscope' || pose.section === 'celestial' ? kaleidoscope : rain).atmosphere;
  if (atm !== currentAtm) {
    currentAtm = atm;
    scene.background = new THREE.Color(atm.background);
    scene.fog = atm.fog ? new THREE.Fog(atm.fog.color, atm.fog.near, atm.fog.far) : null;
    renderer.toneMappingExposure = atm.exposure;
  }
  // 画面効果（アプリと同じ式: 万華鏡の折り返しは区間の頭から6秒で入り、終わりの8秒で抜ける）
  const k0 = sectionStart('kaleidoscope');
  const k1 = sectionStart('celestial');
  fx.state.bubble = 1;
  fx.state.kaleidoscope = smoothstep(k0, k0 + 6, t) * (1 - smoothstep(k1 - 8, k1, t));
  fx.state.kaleidoscopeAngle = comfort === 'standard' ? Math.max(0, t - k0) * 0.15 : 0;
  fx.state.membrane = Math.max(0, 1 - Math.abs(t - k0) / 0.3) + Math.max(0, 1 - Math.abs(t - sectionStart('rain')) / 0.3);
  fx.render(scene, camera);

  frames++;
  if (now - fpsAt > 500) {
    fps = (frames * 1000) / (now - fpsAt);
    frames = 0;
    fpsAt = now;
  }
  slider.value = String(t);
  out.value = `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  info.textContent = `${backend} ${fps.toFixed(0)}fps calls=${renderer.info.render.calls} tris=${Math.round(renderer.info.render.triangles / 1000)}k\n${pose.section} s=${pose.s.toFixed(1)} 扉=${door} ${comfort}\n${log.join('\n')}`;
  (globalThis as unknown as { __roomsB?: unknown }).__roomsB = { t, fps, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, backend, ready: true };
});
