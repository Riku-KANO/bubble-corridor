// rooms-a 確認ページ（S-20）。待ち列・乗り場・温室とゴンドラを、本物のレールの上で時刻を止めて見る。
// アプリ本体（src/app）を通さずに部屋だけを並べるので、部屋の見た目・光・数（描く回数、三角形、fps）をここで確かめる。
import * as THREE from 'three/webgpu';
import type { Cue } from '../../contracts/events';
import { ROOM_OF_SECTION, type RoomId } from '../../contracts/ids';
import type { RideData, RidePose } from '../../contracts/ride';
import type { RoomContext, RoomFrame, RoomModule } from '../../contracts/room';
import { TRANSITION_SEC } from '../../config';
import { createBus } from '../../core/events';
import { smoothstep } from '../../core/easing';
import { resetGlassLighting, setDefaultGlassTier, setGlassLighting } from '../../core/materials/glass';
import { createAssetLoader } from '../../app/assets';
import { createGondola } from '../../gondola';
import { buildCueSheet, createRide, generateRideData } from '../../ride';
import { createGreenhouseRoom } from '../../rooms/greenhouse';
import * as lobbyModule from '../../rooms/lobby';
import { createDawnRoom } from '../../rooms/dawn';
import { createPlatformRoom } from '../../rooms/platform';

const q = new URLSearchParams(location.search);
const numParam = (k: string, d: number) => {
  const v = Number(q.get(k));
  return q.has(k) && Number.isFinite(v) ? v : d;
};
const tier = (['low', 'medium', 'high'] as const).find((x) => x === q.get('tier')) ?? 'high';
setDefaultGlassTier(tier);

const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: q.has('webgl') });
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
document.body.prepend(renderer.domElement);

const res = await fetch('/assets/rail.json');
const data = res.ok ? ((await res.json()) as RideData) : generateRideData();
const ride = createRide(data);
const cues = buildCueSheet();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(numParam('fov', 75), innerWidth / innerHeight, 0.05, 2000);
const gondola = createGondola();
scene.add(gondola.root);
gondola.seat.add(camera);

const particles = { low: 0.4, medium: 0.7, high: 1 }[tier];
const ctx: RoomContext = {
  ride,
  assets: createAssetLoader('/assets/'),
  events: createBus(),
  quality: { tier, maxPixelRatio: 2, renderScale: 1, minRenderScale: 0.6, targetFps: 60, postFx: false, particleScale: particles, envMapSize: 256, antialias: true },
  comfort: () => 'standard',
  reducedFlash: () => q.has('reducedFlash'),
  suggestedDoor: null,
  hiddenAlreadyFound: false,
};

const rooms = new Map<RoomId, RoomModule>([
  ['lobby', lobbyModule.createLobbyRoom()],
  ['platform', createPlatformRoom()],
  ['greenhouse', createGreenhouseRoom()],
]);
// ?with=dawn（隣の部屋も並べる。夜明けの岸から乗り場の外側を見る）
if ((q.get('with') ?? '').split(',').includes('dawn')) rooms.set('dawn', createDawnRoom());
const only = q.get('room');
const t0 = performance.now();
await Promise.all([...rooms.entries()].filter(([id]) => !only || only === id || only === 'all' || id === 'dawn').map(([, r]) => r.load(ctx).then(() => scene.add(r.root))));
const loadMs = performance.now() - t0;
// ?hide=platform.stone,platform.water（名前の頭で隠す。どの物か確かめる）
const hide = (q.get('hide') ?? '').split(',').filter(Boolean);
if (hide.length) scene.traverse((o) => {
  const n = String(o.userData.name ?? o.name);
  if (hide.some((h) => n.startsWith(h))) o.visible = false;
});

// 待ち列の確かめ（読み込みの灯り、改札）
const lobby = rooms.get('lobby')!;
const lobbyApi = lobby as unknown as {
  setLoadProgress?: (p: number) => void;
  setTicketNumber?: (n: number) => void;
  punchTicket?: () => void;
  openDoors?: () => void;
};
lobbyApi.setLoadProgress?.(numParam('load', 1));
lobbyApi.setTicketNumber?.(numParam('ticket', 3));
if (q.has('punch')) setTimeout(() => lobbyApi.punchTicket?.(), 400);
if (q.has('doors')) setTimeout(() => lobbyApi.openDoors?.(), 400);

const view = q.get('view');
const views = (lobbyModule as unknown as { lobbyViews?: (r: typeof ride) => Record<string, { position: readonly number[]; target: readonly number[] }> }).lobbyViews?.(ride);

const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
let t = numParam('t', 30);
const run = q.has('run');
const rate = numParam('rate', 1);
let last = performance.now();
let lastT = t;
let currentAtmo: unknown = null;
let fpsAcc = 0;
let fpsN = 0;
let fps = 0;
const hud = document.getElementById('hud')!;
const yaw = (numParam('yaw', 0) * Math.PI) / 180;
const pitch = (numParam('pitch', 0) * Math.PI) / 180;
const orbit = q.has('orbit');

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

function dispatch(from: number, to: number) {
  for (const c of cues as readonly Cue[]) if (c.t > from && c.t <= to) for (const r of rooms.values()) r.onCue(c);
}

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dtReal = (now - last) / 1000;
  last = now;
  if (run) t += dtReal * rate;
  const dt = Math.max(0, t - lastT);
  dispatch(lastT, t);
  lastT = t;
  ride.poseAt(t, 'standard', pose);
  gondola.root.position.set(pose.x, pose.y, pose.z);
  gondola.root.rotation.set(0, pose.yaw, 0);
  const departT0 = ride.sectionTime('departure').t0;
  const shell = q.has('shell') ? numParam('shell', 1) : smoothstep(0.5, 0.5 + TRANSITION_SEC.boarding, t) * (1 - smoothstep(departT0, departT0 + TRANSITION_SEC.boarding, t));
  gondola.setShell(view ? 0 : shell);
  gondola.update(now / 1000, dtReal);

  if (view && views?.[view]) {
    // 待ち列・入口・乗り場の視点（ゴンドラの座席から外す）
    if (camera.parent !== scene) scene.add(camera);
    const v = views[view];
    camera.position.set(v.position[0], v.position[1], v.position[2]);
    camera.lookAt(v.target[0], v.target[1], v.target[2]);
    camera.rotateY(yaw);
    camera.rotateX(pitch);
  } else if (q.has('cam')) {
    // ?cam=x,y,z&look=x,y,z（自由な視点）
    if (camera.parent !== scene) scene.add(camera);
    const c = (q.get('cam') ?? '').split(/[,;]/).map(Number);
    const l = (q.get('look') ?? '0,0,0').split(/[,;]/).map(Number);
    camera.position.set(c[0] || 0, c[1] || 0, c[2] || 0);
    camera.lookAt(l[0] || 0, l[1] || 0, l[2] || 0);
  } else if (orbit) {
    if (camera.parent !== scene) scene.add(camera);
    camera.position.set(pose.x + 30, pose.y + 40, pose.z + 30);
    camera.lookAt(pose.x, pose.y, pose.z);
  } else {
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  const frame: RoomFrame = { t, dt, pose, camera, comfort: 'standard', reducedFlash: q.has('reducedFlash') };
  for (const r of rooms.values()) r.update(view ? { ...frame, dt: dtReal } : frame);

  const roomId: RoomId = view ? 'lobby' : ROOM_OF_SECTION[pose.section];
  const a = rooms.get(roomId)?.atmosphere;
  if (a && a !== currentAtmo) {
    currentAtmo = a;
    scene.background = new THREE.Color(a.background);
    scene.fog = a.fog ? new THREE.Fog(a.fog.color, a.fog.near, a.fog.far) : null;
    renderer.toneMappingExposure = a.exposure;
    scene.environment = a.environment ?? null;
    // 擬似反射の照明（統合では Atmosphere.glassLighting をアプリが空気の変わり目に当てる。ここではそのまねをする）
    resetGlassLighting();
    if (a.glassLighting) setGlassLighting(a.glassLighting);
  }
  renderer.render(scene, camera);

  fpsAcc += dtReal;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }
  const info = renderer.info.render;
  (globalThis as unknown as { __roomsA: unknown }).__roomsA = { ready: true, fps, calls: info.drawCalls, triangles: info.triangles, t, section: pose.section, backend, loadMs };
  if (!q.has('clean')) {
    hud.textContent = `${backend} ${tier}  ${fps.toFixed(0)}fps  calls ${info.drawCalls}  tris ${Math.round(info.triangles / 1000)}k\nt=${t.toFixed(1)} ${pose.section}  s=${pose.s.toFixed(1)}  load ${loadMs.toFixed(0)}ms`;
  }
});
